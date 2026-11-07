// Engagement Tracker edge function: what reaches the tracker and what the outage buffer keeps.
import { test } from "node:test";
import assert from "node:assert/strict";

const sent = [];
globalThis.Netlify = { env: { get: (k) => ({ TRACKER_URL: "https://tracker.example", TRACKER_INGEST_SECRET: "s".repeat(40) })[k] || "" } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith("https://tracker.example")) { sent.push(JSON.parse(opts.body)); return new Response("{}", { status: 200 }); }
  return realFetch(url, opts);
};
const { default: handler, scrubEnvelope } = await import("../netlify/edge-functions/jm.js");

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const post = (p) => handler(new Request("https://jasonmoss.com/_jm/e", { method: "POST", headers: { "user-agent": UA, "content-type": "text/plain" }, body: JSON.stringify(p) }),
  { geo: { country: { code: "US" } }, ip: "203.0.113.9" });

test("a payload whose visitor id isn't well-formed never reaches the tracker", async () => {
  sent.length = 0;
  assert.equal((await post({ v: "x".repeat(200000), e: [] })).status, 204);
  assert.equal((await post({ v: { a: 1 }, e: [] })).status, 204);
  assert.equal(sent.length, 0);
  await post({ v: "s" + "A".repeat(21), e: [{ t: "h", eid: "abcdefabcdef" }] });
  assert.equal(sent.length, 1, "a normal batch is forwarded");
});

test("buffered envelopes keep no identity parameters in URLs; Kit's hashed email moves to its own field", () => {
  const hash = "ab".repeat(32);
  const env = { p: { e: [
    { t: "pv", u: `https://jasonmoss.com/replay/?utm_source=kit&ck_subscriber_id=12&sh_kit=${hash}`, r: `https://jasonmoss.com/x/?sh_kit=${hash}` },
    { t: "ck", u: `https://jasonmoss.com/apply/?sh_kit=${hash}&email=a%40b.com` },
  ] } };
  scrubEnvelope(env);
  const [pv, ck] = env.p.e;
  assert.equal(pv.u, "https://jasonmoss.com/replay/?utm_source=kit");
  assert.equal(pv.shk, hash);
  assert.ok(!pv.r.includes("sh_kit") && !ck.u.includes("sh_kit") && !ck.u.includes("email"));
  assert.equal(ck.shk, undefined, "only the page view carries it (that's where the tracker reads it)");
});
