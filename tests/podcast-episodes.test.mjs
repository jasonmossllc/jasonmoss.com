// Podcast episode feed: parsing, and serving the last good list when YouTube's feed is down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, loadEpisodes } from "../netlify/functions/podcast-episodes.mjs";

const entry = (id, title, published) =>
  `<entry><yt:videoId>${id}</yt:videoId><title>${title}</title><published>${published}</published></entry>`;
const FEED = `<feed>${entry("aaa", "Older &amp; wiser", "2026-09-01T00:00:00+00:00")}${entry("bbb", "Newest", "2026-11-02T00:00:00+00:00")}</feed>`;

function memStore(initial) {
  let v = initial ?? null;
  return { saved: () => v, async setJSON(_k, x) { v = x; }, async get() { return v; } };
}
const ok = (body) => async () => ({ ok: true, status: 200, text: async () => body });
const down = async () => ({ ok: false, status: 404, text: async () => "" });

test("parses entries newest first and decodes titles", () => {
  const eps = parseFeed(FEED);
  assert.deepEqual(eps.map((e) => e.id), ["bbb", "aaa"]);
  assert.equal(eps[1].title, "Older & wiser");
});

test("a good read is returned fresh and saved", async () => {
  const store = memStore();
  const r = await loadEpisodes({ fetchImpl: ok(FEED), store });
  assert.equal(r.stale, false);
  assert.equal(r.episodes.length, 2);
  assert.equal(store.saved().episodes[0].id, "bbb");
});

test("feed down: the last good list is served, marked stale", async () => {
  const store = memStore({ episodes: [{ id: "bbb", title: "Newest", published: "2026-11-02T00:00:00+00:00" }] });
  const r = await loadEpisodes({ fetchImpl: down, store });
  assert.equal(r.stale, true);
  assert.equal(r.episodes[0].id, "bbb");
});

test("feed down and nothing saved: nothing to serve", async () => {
  assert.equal(await loadEpisodes({ fetchImpl: down, store: memStore() }), null);
});

test("the second user agent is tried when the first is refused", async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? { ok: false, status: 404, text: async () => "" } : { ok: true, status: 200, text: async () => FEED });
  const r = await loadEpisodes({ fetchImpl: flaky, store: memStore() });
  assert.equal(n, 2);
  assert.equal(r.stale, false);
});

test("a storage failure never breaks a good feed read", async () => {
  const broken = { async setJSON() { throw new Error("blobs down"); }, async get() { throw new Error("blobs down"); } };
  const r = await loadEpisodes({ fetchImpl: ok(FEED), store: broken });
  assert.equal(r.episodes.length, 2);
});
