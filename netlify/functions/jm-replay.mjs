// Site Tracker outage replay (scheduled, every 5 minutes).
//
// When the tracker app (Railway) is slow or down, the edge function (netlify/edge-functions/jm.js) stores event
// batches in Netlify Blobs ("jm-buffer", keys q/<ms>-<rand>). This drains them oldest-first into the tracker as
// soon as it answers again. Replays are harmless: every event carries an id the tracker has already seen or not.
//
//  - A blob that can't be read right now is left alone (never deleted on a read error).
//  - Batches are sized by bytes. If the tracker refuses a batch (too big / bad), its envelopes are retried one at a
//    time and only an envelope the tracker refuses on its own is set aside (dead/), so one bad batch can never
//    block the queue. If the tracker is down (network error, 5xx), the run stops and tries again in 5 minutes.
//  - Each run stops after ~20 seconds so it always finishes (and can alert) inside the function time limit.
//
// Alerts: one email (at most once a day) when the oldest buffered batch is older than 6 hours, or the tracker
// settings are missing. Nothing is sent for blips that fix themselves.
import { getStore } from "@netlify/blobs";

export const config = { schedule: "*/5 * * * *" };

const MAX_BATCH_BYTES = 900 * 1024; // the tracker accepts 8 MB; stay far below
const MAX_BATCH_COUNT = 200;
const RUN_BUDGET_MS = 20000;
const FETCH_TIMEOUT_MS = 9000;
const DEAD_AFTER_MS = 14 * 864e5;
const DEAD_KEEP_MS = 30 * 864e5;
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

// POST envelopes; returns "ok" | "down" (network/5xx/auth: stop) | "refused" (4xx: the content is the problem).
async function send(url, secret, batch, fetchImpl) {
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-jm-secret": secret },
      body: JSON.stringify({ batch }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) return "ok";
    if ([401, 403, 408, 429].includes(res.status) || res.status >= 500) return "down";
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

export async function drain({ store, url, secret, now = Date.now(), fetchImpl = fetch, budgetMs = RUN_BUDGET_MS }) {
  const started = Date.now();
  const outOfTime = () => Date.now() - started > budgetMs;
  const { blobs } = await store.list({ prefix: "q/" });
  const keys = blobs.map((b) => b.key).sort();
  const result = { pending: keys.length, sent: 0, dead: 0, skipped: 0, failed: false, misconfigured: false, oldestMs: keys.length ? now - keyTime(keys[0]) : 0 };
  if (!keys.length) return result;
  if (!url || !secret) { result.failed = true; result.misconfigured = true; return result; }

  const park = async (key, raw) => {
    if (raw != null) await store.set(key.replace(/^q\//, "dead/"), raw);
    await store.delete(key);
    result.dead++;
  };

  let i = 0;
  while (i < keys.length && !outOfTime()) {
    // Build one batch by bytes.
    const batch = [];
    const batchKeys = [];
    const raws = [];
    let bytes = 0;
    while (i < keys.length && batch.length < MAX_BATCH_COUNT) {
      const key = keys[i];
      let raw;
      try { raw = await store.get(key); } catch { raw = undefined; }
      if (raw === undefined || raw === null) { i++; result.skipped++; continue; } // can't read now: leave it for later
      if (now - keyTime(key) > DEAD_AFTER_MS) { await park(key, raw); i++; continue; } // undeliverable for two weeks
      let env;
      try { env = JSON.parse(raw); } catch { env = null; }
      if (!env || typeof env !== "object") { await park(key, raw); i++; continue; } // corrupt
      if (batch.length && bytes + raw.length > MAX_BATCH_BYTES) break;
      batch.push({ ...env, rp: 1 });
      batchKeys.push(key);
      raws.push(raw);
      bytes += raw.length;
      i++;
    }
    if (!batch.length) continue;

    const r = await send(url, secret, batch, fetchImpl);
    if (r === "ok") {
      for (const k of batchKeys) await store.delete(k);
      result.sent += batchKeys.length;
      continue;
    }
    if (r === "down" && !(await healthy(url, fetchImpl))) { result.failed = true; break; } // tracker unreachable: oldest-first next run
    // Refused (or failing while the tracker is otherwise healthy): try each envelope alone; set aside only the ones
    // that fail on their own, so one bad envelope can never block the queue (they're kept 30 days in dead/).
    for (let j = 0; j < batch.length && !outOfTime(); j++) {
      const single = await send(url, secret, [batch[j]], fetchImpl);
      if (single === "ok") { await store.delete(batchKeys[j]); result.sent++; }
      else if (single === "refused" || (await healthy(url, fetchImpl))) await park(batchKeys[j], raws[j]);
      else { result.failed = true; break; }
    }
    if (result.failed) break;
  }
  return result;
}

async function cleanDead(store, now = Date.now()) {
  try {
    const { blobs } = await store.list({ prefix: "dead/" });
    for (const b of blobs) if (now - keyTime(b.key) > DEAD_KEEP_MS) await store.delete(b.key);
  } catch (e) { console.error("jm-replay: dead cleanup", e?.message); }
}

export default async () => {
  const store = getStore({ name: "jm-buffer", consistency: "strong" });
  const url = process.env.TRACKER_URL;
  const secret = process.env.TRACKER_INGEST_SECRET;
  const r = await drain({ store, url, secret });
  if (r.pending) console.log("jm-replay", JSON.stringify(r));
  await cleanDead(store);

  const stuck = r.misconfigured || (r.failed && r.oldestMs > ALERT_AFTER_MS);
  if (stuck) {
    const meta = await store.get("meta/last-alert").catch(() => null);
    if (!meta || Date.now() - Number(meta) > 864e5) {
      await store.set("meta/last-alert", String(Date.now()));
      await sendAlert("Site Tracker can't reach its server",
        (r.misconfigured
          ? "The Netlify settings TRACKER_URL / TRACKER_INGEST_SECRET are missing, so site events can't be delivered.\n\n"
          : `The Site Tracker app on Railway hasn't accepted events for ${Math.round(r.oldestMs / 3600e3)} hours.\n\n`) +
        `Nothing is lost: ${r.pending} batches are waiting in Netlify and will be replayed automatically when it's back.\n\n` +
        `Check the "site-tracker" service on Railway (deploy logs, volume, health check at ${url || "TRACKER_URL"}/healthz).\n` +
        `This email repeats at most once a day while the problem lasts.`).catch((e) => console.error("alert failed", e.message));
    }
  }
  return new Response(null, { status: 204 });
};
