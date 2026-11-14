// Podcast episode feed: parsing, and serving the last good list when YouTube's feed is down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, loadEpisodes, parsePlaylistPage, parsePublishDate } from "../netlify/functions/podcast-episodes.mjs";

const entry = (id, title, published) =>
  `<entry><yt:videoId>${id}</yt:videoId><title>${title}</title><published>${published}</published></entry>`;
const FEED = `<feed>${entry("aaa", "Older &amp; wiser", "2026-09-01T00:00:00+00:00")}${entry("bbb", "Newest", "2026-11-02T00:00:00+00:00")}</feed>`;

function memStore(initial) {
  const m = new Map(initial ? [["last-good", initial]] : []);
  return { saved: () => m.get("last-good") ?? null, m, async setJSON(k, x) { m.set(k, x); }, async get(k) { return m.get(k) ?? null; } };
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
  const r = await loadEpisodes({ fetchImpl: ok(FEED), store, apiKey: "" });
  assert.equal(r.stale, false);
  assert.equal(r.episodes.length, 2);
  assert.equal(store.saved().episodes[0].id, "bbb");
});

test("feed down: the last good list is served, marked stale", async () => {
  const store = memStore({ episodes: [{ id: "bbb", title: "Newest", published: "2026-11-02T00:00:00+00:00" }] });
  const r = await loadEpisodes({ fetchImpl: down, store, apiKey: "" });
  assert.equal(r.stale, true);
  assert.equal(r.episodes[0].id, "bbb");
});

test("feed down and nothing saved: nothing to serve", async () => {
  const r = await loadEpisodes({ fetchImpl: down, store: memStore(), apiKey: "" });
  assert.equal(r.episodes, null);
  assert.equal(r.why.length, 2);
});

test("the second user agent is tried when the first is refused", async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? { ok: false, status: 404, text: async () => "" } : { ok: true, status: 200, text: async () => FEED });
  const r = await loadEpisodes({ fetchImpl: flaky, store: memStore(), apiKey: "" });
  assert.equal(n, 2);
  assert.equal(r.stale, false);
});

test("a storage failure never breaks a good feed read", async () => {
  const broken = { async setJSON() { throw new Error("blobs down"); }, async get() { throw new Error("blobs down"); } };
  const r = await loadEpisodes({ fetchImpl: ok(FEED), store: broken, apiKey: "" });
  assert.equal(r.episodes.length, 2);
});

// The playlist page as YouTube serves it: data embedded as JSON, in two item shapes seen over time.
const page = (items) => `<html><script>var ytInitialData = ${JSON.stringify({ contents: { deep: [{ list: items }] } })};</script></html>`;
const lockup = (id, title) => ({ lockupViewModel: { contentId: id, contentType: "LOCKUP_CONTENT_TYPE_VIDEO", metadata: { lockupMetadataViewModel: { title: { content: title } } } } });
const legacy = (id, title) => ({ playlistVideoRenderer: { videoId: id, title: { runs: [{ text: title }] } } });
const watch = (date) => `<meta itemprop="datePublished" content="${date}">`;

test("playlist page: both item shapes are read, in order, without duplicates", () => {
  const items = parsePlaylistPage(page([lockup("n1", "Newest"), legacy("o1", "Older"), lockup("n1", "Newest")]));
  assert.deepEqual(items, [{ id: "n1", title: "Newest" }, { id: "o1", title: "Older" }]);
  assert.deepEqual(parsePlaylistPage("<html>consent wall</html>"), []);
});

test("publish date is read from a video page", () => {
  assert.equal(parsePublishDate(watch("2026-11-02T10:12:37-08:00")), "2026-11-02T10:12:37-08:00");
  assert.equal(parsePublishDate("<html></html>"), null);
});

test("feed down: episodes come from the playlist page, and dates are only looked up once", async () => {
  const store = memStore();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/feeds/")) return { ok: false, status: 404, text: async () => "" };
    if (url.includes("/playlist?")) return { ok: true, status: 200, text: async () => page([lockup("n1", "Newest"), lockup("o1", "Older")]) };
    return { ok: true, status: 200, text: async () => watch(url.includes("n1") ? "2026-11-02T10:00:00-08:00" : "2026-09-29T10:00:00-07:00") };
  };
  const r = await loadEpisodes({ fetchImpl, store, apiKey: "" });
  assert.equal(r.source, "playlist page");
  assert.deepEqual(r.episodes.map((e) => e.id), ["n1", "o1"]);
  assert.equal(r.episodes[0].published, "2026-11-02T10:00:00-08:00");
  const watchCalls = () => calls.filter((u) => u.includes("/watch?")).length;
  assert.equal(watchCalls(), 2);
  await loadEpisodes({ fetchImpl, store, apiKey: "" });
  assert.equal(watchCalls(), 2);
});

test("an API key, when set, is used first", async () => {
  const fetchImpl = async (url) => {
    assert.ok(url.includes("googleapis.com"));
    return { ok: true, status: 200, json: async () => ({ items: [{ contentDetails: { videoId: "k1", videoPublishedAt: "2026-11-02T18:12:37Z" }, snippet: { title: "From the API" } }] }) };
  };
  const r = await loadEpisodes({ fetchImpl, store: memStore(), apiKey: "test-key" });
  assert.equal(r.source, "api");
  assert.equal(r.episodes[0].id, "k1");
});
