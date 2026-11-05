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
