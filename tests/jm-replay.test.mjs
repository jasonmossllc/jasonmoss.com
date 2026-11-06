// Site Tracker outage replay: drain logic against an in-memory store and a fake tracker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { drain } from "../netlify/functions/jm-replay.mjs";

function memStore(entries = {}, { failGet = new Set() } = {}) {
  const m = new Map(Object.entries(entries));
  return {
    m,
    async list({ prefix }) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    async get(key) { if (failGet.has(key)) throw new Error("blobs read failed"); return m.has(key) ? m.get(key) : null; },
    async set(key, v) { m.set(key, v); },
    async delete(key) { m.delete(key); },
  };
}
const NOW = Date.now();
const key = (ageMs, n) => `q/${String(NOW - ageMs).padStart(15, "0")}-k${n}`;
const env = (n) => JSON.stringify({ rt: NOW, vc: `vid${n}xxxxxxxxxxxxxxxx`, p: { v: `vid${n}xxxxxxxxxxxxxxxx`, e: [{ t: "h", eid: `eid${n}aaaaaa` }] } });
const ok = async () => new Response("{}", { status: 200 });

test("delivers everything oldest-first and empties the buffer", async () => {
  const store = memStore({ [key(3000, 1)]: env(1), [key(2000, 2)]: env(2), [key(1000, 3)]: env(3) });
  const sent = [];
  const r = await drain({ store, url: "https://t.example", secret: "s", now: NOW, fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body).batch); return ok(); } });
  assert.equal(r.sent, 3);
  assert.equal(store.m.size, 0);
  assert.deepEqual(sent.flat().map((e) => e.vc.slice(0, 4)), ["vid1", "vid2", "vid3"]);
  assert.ok(sent.flat().every((e) => e.rp === 1), "marked as replayed");
});

test("one envelope that keeps failing while the tracker is healthy is set aside on its second failing run; the rest go through", async () => {
  const store = memStore({ [key(3000, 1)]: env(1), [key(2000, 2)]: env(2), [key(1000, 3)]: env(3) });
  const fetchImpl = async (u, o) => {
    if (u.endsWith("/healthz")) return ok();
    const batch = JSON.parse(o.body).batch;
    return batch.some((e) => e.vc.startsWith("vid2")) ? new Response("err", { status: 500 }) : ok();
  };
  let r = await drain({ store, url: "https://t.example", secret: "s", now: NOW, fetchImpl });
  assert.equal(r.sent, 2);
  assert.equal(r.dead, 0, "one failing run could be a blip: kept");
  store.m.set(key(500, 4), env(4)); // newer traffic gets buffered next to it
  r = await drain({ store, url: "https://t.example", secret: "s", now: NOW + 300000, fetchImpl });
  assert.equal(r.dead, 1, "failed again on the next run: set aside");
});

test("tracker down: nothing deleted, run reports failure", async () => {
  const store = memStore({ [key(1000, 1)]: env(1) });
  const r = await drain({ store, url: "https://t.example", secret: "s", now: NOW, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(r.failed, true);
  assert.equal(store.m.size, 1);
});

test("a refused batch is retried one by one; only the bad envelope is set aside", async () => {
  const store = memStore({ [key(3000, 1)]: env(1), [key(2000, 2)]: env(2), [key(1000, 3)]: env(3) });
  const r = await drain({
    store, url: "https://t.example", secret: "s", now: NOW,
    fetchImpl: async (u, o) => {
      const batch = JSON.parse(o.body).batch;
      if (batch.length > 1) return new Response("too big", { status: 413 });
      return batch[0].vc.startsWith("vid2") ? new Response("bad", { status: 400 }) : ok();
    },
  });
  assert.equal(r.sent, 2);
  assert.equal(r.dead, 1);
  assert.deepEqual([...store.m.keys()].map((k) => k.split("/")[0]), ["dead"]);
});

test("an entry that can't be read right now is left alone (never deleted)", async () => {
  const k1 = key(2000, 1);
  const store = memStore({ [k1]: env(1), [key(1000, 2)]: env(2) }, { failGet: new Set([k1]) });
  const r = await drain({ store, url: "https://t.example", secret: "s", now: NOW, fetchImpl: ok });
  assert.equal(r.skipped, 1);
  assert.ok(store.m.has(k1));
  assert.equal(r.sent, 1);
});

test("corrupt entries and two-week-old entries are parked, not retried forever", async () => {
  const store = memStore({ [key(15 * 864e5, 1)]: env(1), [key(1000, 2)]: "{not json" });
  const r = await drain({ store, url: "https://t.example", secret: "s", now: NOW, fetchImpl: ok });
  assert.equal(r.dead, 2);
  assert.equal([...store.m.keys()].filter((k) => k.startsWith("q/")).length, 0);
});

test("missing settings count as a failure (so the alert fires)", async () => {
  const store = memStore({ [key(1000, 1)]: env(1) });
  const r = await drain({ store, url: "", secret: "", now: NOW, fetchImpl: ok });
  assert.equal(r.failed, true);
  assert.equal(r.misconfigured, true);
  assert.equal(store.m.size, 1);
});

test("tracker healthy but failing every batch (full disk, bad deploy): nothing set aside, run fails", async () => {
  const entries = {};
  for (let n = 1; n <= 50; n++) entries[key(5000 - n, n)] = env(n);
  const store = memStore(entries);
  const r = await drain({
    store, url: "https://t.example", secret: "s", now: NOW,
    fetchImpl: async (u) => (u.endsWith("/healthz") ? ok() : new Response("SQLITE_FULL", { status: 500 })),
  });
  assert.equal(r.failed, true);
  assert.equal(r.systemic, true);
  assert.equal(r.dead, 0);
  assert.equal([...store.m.keys()].filter((k) => k.startsWith("q/")).length, 50);
});

test("rejected secret: run stops at once, flagged for an immediate alert, nothing set aside", async () => {
  const store = memStore({ [key(2000, 1)]: env(1), [key(1000, 2)]: env(2) });
  const r = await drain({
    store, url: "https://t.example", secret: "s", now: NOW,
    fetchImpl: async (u) => (u.endsWith("/healthz") ? ok() : new Response("unauthorized", { status: 401 })),
  });
  assert.equal(r.auth, true);
  assert.equal(r.dead, 0);
  assert.equal(store.m.size, 2);
});

test("set-aside batches go back under their original key, once (no key growth, no endless loop)", async () => {
  const { requeueDead } = await import("../netlify/functions/jm-replay.mjs");
  const store = memStore({ "dead/000000000000009-000000000000001-a": env(1), "dead/000000000000009-000000000000002-b": env(2) });
  assert.equal(await requeueDead(store), 2);
  const q = [...store.m.keys()].filter((k) => k.startsWith("q/")).sort();
  assert.equal(q.length, 2);
  assert.ok(q.every((k) => /^q\/\d{15}-r_[ab]$/.test(k) && Date.now() - Number(k.slice(2, 17)) < 60000), q.join(",") + " (fresh queue time)");
  // Refused again: set aside under a fixed-length key, and never requeued a second time.
  await drain({ store, url: "https://t.example", secret: "s", now: NOW, fetchImpl: async (u, o) => (JSON.parse(o.body).batch.length > 1 ? new Response("x", { status: 413 }) : new Response("bad", { status: 400 })) });
  const dead = [...store.m.keys()].filter((k) => k.startsWith("dead/"));
  assert.ok(dead.every((k) => k.length === "dead/".length + 15 + 1 + 15 + 1 + 3), dead.join(","));
  assert.equal(await requeueDead(store), 0);
});

test("tracker refusing EVERY envelope (e.g. a deploy answering 404) sets nothing aside", async () => {
  const store = memStore({ [key(2000, 1)]: env(1), [key(1000, 2)]: env(2) });
  const r = await drain({ store, url: "https://t.example", secret: "s", now: NOW, fetchImpl: async (u) => (u.endsWith("/healthz") ? ok() : new Response("nope", { status: 404 })) });
  assert.equal(r.dead, 0);
  assert.equal(r.failed, true);
  assert.equal([...store.m.keys()].filter((k) => k.startsWith("q/")).length, 2);
});

test("set-aside envelopes are keyed by when they were set aside", async () => {
  const store = memStore({ [key(20 * 864e5, 1)]: env(1) }); // buffered 20 days ago, parked now
  await drain({ store, url: "https://t.example", secret: "s", now: NOW, fetchImpl: async () => ok() });
  const dead = [...store.m.keys()].filter((k) => k.startsWith("dead/"));
  assert.equal(dead.length, 1);
  assert.ok(Number(dead[0].slice(5, 20)) === NOW, dead[0]);
});
