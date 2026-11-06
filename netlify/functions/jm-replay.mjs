// Site Tracker outage replay (scheduled, every 5 minutes).
//
// When the tracker app (Railway) is slow or down, the edge function (netlify/edge-functions/jm.js) stores event
// batches in Netlify Blobs ("jm-buffer", keys q/<ms>-<rand>). This drains them oldest-first into the tracker as
// soon as it answers again. Replays are harmless: every event carries an id the tracker has already seen or not.
//
//  - A blob that can't be read right now is left alone (never deleted on a read error).
//  - Batches are sized by bytes. If the tracker refuses a batch (too big / bad), its envelopes are retried one at a
//    time. An envelope is set aside (dead/) only when the problem is clearly that envelope: the tracker refuses its
//    content (4xx), or it fails while others in the same batch go through. If everything fails (tracker down, full
//    disk, bad deploy, wrong secret), nothing is set aside: the run stops and the batches wait.
//  - A wrong secret (401/403) stops the run and alerts at once (no 6-hour wait): it never fixes itself.
//  - Each run stops after ~18 seconds so it always finishes (and can alert) inside the function time limit.
//
// Alerts: one email (at most once a day) when the oldest buffered batch is older than 6 hours, the secret is
// rejected, the settings are missing, or more than a few batches were set aside in one run.
//
// Recovery: set the Netlify environment variable JM_REQUEUE_DEAD=1 and the next run moves everything in dead/ back
// into the queue (remove the variable afterwards).
import { getStore } from "@netlify/blobs";

export const config = { schedule: "*/5 * * * *" };

const MAX_BATCH_BYTES = 900 * 1024; // the tracker accepts 8 MB; stay far below
const MAX_BATCH_COUNT = 200;
const RUN_BUDGET_MS = 18000;
const PARALLEL = 20;
const FETCH_TIMEOUT_MS = 9000;
const DEAD_AFTER_MS = 14 * 864e5;
const DEAD_KEEP_MS = 7 * 864e5;
const ALERT_AFTER_MS = 6 * 3600e3;

const keyTime = (key) => Number((/^(?:q|dead)\/(\d+)-/.exec(key) || [])[1]) || 0;

async function sendAlert(subject, text) {
  const token = process.env.POSTMARK_TOKEN;
  if (!token) { console.error("jm-replay: POSTMARK_TOKEN not set; alert not sent:", subject); return; }
  await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": token },
    body: JSON.stringify({ From: "jason@jasonmoss.com", To: process.env.TRACKER_ALERT_EMAIL || "jason@jasonmoss.com", Subject: subject, TextBody: text, MessageStream: "outbound" }),
    signal: AbortSignal.timeout(10000),
  });
}

// POST envelopes; returns "ok" | "down" (network/5xx/timeouts) | "auth" (secret rejected) | "refused" (4xx: the content).
async function send(url, secret, batch, fetchImpl) {
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-jm-secret": secret },
      body: JSON.stringify({ batch }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "auth";
    if ([408, 429].includes(res.status) || res.status >= 500) return "down";
    return "refused";
  } catch {
    return "down";
  }
}

async function healthy(url, fetchImpl) {
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/healthz`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Runs fn over items, `PARALLEL` at a time.
async function inChunks(items, fn) {
  for (let i = 0; i < items.length; i += PARALLEL) await Promise.all(items.slice(i, i + PARALLEL).map(fn));
}

export async function drain({ store, url, secret, now = Date.now(), fetchImpl = fetch, budgetMs = RUN_BUDGET_MS }) {
  const started = Date.now();
  const outOfTime = () => Date.now() - started > budgetMs;
  const { blobs } = await store.list({ prefix: "q/" });
  const keys = blobs.map((b) => b.key).sort();
  const result = { pending: keys.length, sent: 0, dead: 0, skipped: 0, failed: false, auth: false, misconfigured: false, oldestMs: keys.length ? now - keyTime(keys[0]) : 0 };
  if (!keys.length) return result;
  if (!url || !secret) { result.failed = true; result.misconfigured = true; return result; }

  // dead/<time set aside>-<original key>: kept 7 days from when it was set aside (not from when it was buffered).
  const park = async (key, raw) => {
    if (raw != null) await store.set(`dead/${String(now).padStart(15, "0")}-${key.slice(2)}`, raw);
    await store.delete(key);
    result.dead++;
  };

  let i = 0;
  const cache = new Map(); // key -> raw (read ahead, PARALLEL at a time)
  const readAhead = async () => {
    const want = keys.slice(i, i + PARALLEL).filter((k) => !cache.has(k));
    await Promise.all(want.map(async (k) => { let raw; try { raw = await store.get(k); } catch { raw = undefined; } cache.set(k, raw); }));
  };
  while (i < keys.length && !outOfTime()) {
    // Build one batch by bytes.
    const batch = [];
    const batchKeys = [];
    const raws = [];
    let bytes = 0;
    while (i < keys.length && batch.length < MAX_BATCH_COUNT && !outOfTime()) {
      const key = keys[i];
      if (!cache.has(key)) await readAhead();
      const raw = cache.get(key);
      if (raw === undefined || raw === null) { cache.delete(key); i++; result.skipped++; continue; } // can't read now: leave it for later
      if (now - keyTime(key) > DEAD_AFTER_MS) { cache.delete(key); await park(key, raw); i++; continue; } // undeliverable for two weeks
      let env;
      try { env = JSON.parse(raw); } catch { env = null; }
      if (!env || typeof env !== "object") { cache.delete(key); await park(key, raw); i++; continue; } // corrupt
      if (batch.length && bytes + raw.length > MAX_BATCH_BYTES) break;
      cache.delete(key);
      batch.push({ ...env, rp: 1 });
      batchKeys.push(key);
      raws.push(raw);
      bytes += raw.length;
      i++;
    }
    if (!batch.length) continue;

    const r = await send(url, secret, batch, fetchImpl);
    if (r === "ok") {
      await inChunks(batchKeys, (k) => store.delete(k));
      result.sent += batchKeys.length;
      continue;
    }
    if (r === "auth") { result.failed = true; result.auth = true; break; }
    if (r === "down" && !(await healthy(url, fetchImpl))) { result.failed = true; break; } // tracker unreachable: oldest-first next run
    // Refused, or failing while the tracker answers its health check: try each envelope alone.
    const failedAlone = [];
    let anyOk = false;
    for (let j = 0; j < batch.length && !outOfTime(); j++) {
      const single = await send(url, secret, [batch[j]], fetchImpl);
      if (single === "ok") { await store.delete(batchKeys[j]); result.sent++; anyOk = true; }
      else if (single === "auth") { result.failed = true; result.auth = true; break; }
      else failedAlone.push(j); // refused or failing: decided below

    }
    if (result.auth) break;
    // Failing or refused ones are set aside only if others got through (so it's those envelopes, not the tracker,
    // e.g. a deploy that answers 404 to everything). If nothing got through, keep everything and stop.
    if (failedAlone.length && anyOk) { for (const j of failedAlone) await park(batchKeys[j], raws[j]); }
    else if (failedAlone.length) { result.failed = true; result.systemic = true; break; }
  }
  return result;
}

export async function requeueDead(store) {
  const { blobs } = await store.list({ prefix: "dead/" });
  let n = 0;
  await inChunks(blobs, async (b) => {
    const raw = await store.get(b.key).catch(() => null);
    if (raw == null) return;
    await store.set(b.key.replace(/^dead\//, "q/"), raw);
    await store.delete(b.key);
    n++;
  });
  return n;
}

async function cleanDead(store, now = Date.now()) {
  try {
    const { blobs } = await store.list({ prefix: "dead/" });
    await inChunks(blobs.filter((b) => now - keyTime(b.key) > DEAD_KEEP_MS), (b) => store.delete(b.key));
  } catch (e) { console.error("jm-replay: dead cleanup", e?.message); }
}

export default async () => {
  const store = getStore({ name: "jm-buffer", consistency: "strong" });
  const url = process.env.TRACKER_URL;
  const secret = process.env.TRACKER_INGEST_SECRET;
  if (process.env.JM_REQUEUE_DEAD === "1") {
    const n = await requeueDead(store).catch((e) => { console.error("jm-replay: requeue", e?.message); return 0; });
    if (n) console.log(`jm-replay: moved ${n} set-aside batches back into the queue`);
  }
  const r = await drain({ store, url, secret });
  if (r.pending) console.log("jm-replay", JSON.stringify(r));
  await cleanDead(store);

  let problem = null;
  if (r.misconfigured) problem = "The Netlify settings TRACKER_URL / TRACKER_INGEST_SECRET are missing, so site events can't be delivered.";
  else if (r.auth) problem = "The tracker app on Railway is rejecting the shared secret (TRACKER_INGEST_SECRET on Netlify must match INGEST_SECRET on Railway).";
  else if (r.failed && r.oldestMs > ALERT_AFTER_MS) problem = `The Site Tracker app on Railway hasn't accepted events for ${Math.round(r.oldestMs / 3600e3)} hours${r.systemic ? " (it answers its health check but fails every event batch: check its logs and disk space)" : ""}.`;
  else if (r.dead > 5) problem = `${r.dead} event batches were refused by the tracker and set aside in Netlify Blobs (jm-buffer, dead/). They're kept 7 days; to retry them, set JM_REQUEUE_DEAD=1 on Netlify for one run.`;
  if (problem) {
    // Each kind of problem has its own once-a-day limit (a rejected secret is never hidden behind another alert).
    const metaKey = `meta/last-alert-${r.misconfigured ? "config" : r.auth ? "auth" : r.failed ? "down" : "dead"}`;
    const meta = await store.get(metaKey).catch(() => null);
    if (!meta || Date.now() - Number(meta) > 864e5) {
      await store.set(metaKey, String(Date.now()));
      await sendAlert("Site Tracker can't deliver site events",
        `${problem}\n\n` +
        (r.dead > 5 && !r.failed ? "" : `Nothing is lost yet: ${r.pending} batches are waiting in Netlify and will be replayed automatically once it's fixed (they're kept 14 days).\n\n`) +
        `Check the "site-tracker" service on Railway (deploy logs, volume, health check at ${url || "TRACKER_URL"}/healthz).\n` +
        `This email repeats at most once a day while the problem lasts.`).catch((e) => console.error("alert failed", e.message));
    }
  }
  return new Response(null, { status: 204 });
};
