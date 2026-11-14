// Podcast episode feed: parsing, and serving the last good list when YouTube's feed is down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, loadEpisodes, parsePlaylistPage, dateFromAge } from "../netlify/functions/podcast-episodes.mjs";

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
const lockup = (id, title, age) => ({ lockupViewModel: { contentId: id, contentType: "LOCKUP_CONTENT_TYPE_VIDEO", metadata: { lockupMetadataViewModel: { title: { content: title },
  metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: "Jason Moss" } }] }, { metadataParts: [{ text: { content: "462" } }, { text: { content: age } }] }] } } } } } });
const legacy = (id, title, age) => ({ playlistVideoRenderer: { videoId: id, title: { runs: [{ text: title }] }, videoInfo: { runs: [{ text: "300 views" }, { text: " • " }, { text: age }] } } });
const NOW = Date.parse("2026-12-01T12:00:00Z");

test("playlist page: both item shapes are read, in order, without duplicates, with their age", () => {
  const items = parsePlaylistPage(page([lockup("n1", "Newest", "3h ago"), legacy("o1", "Older", "2 weeks ago"), lockup("n1", "Newest", "3h ago")]));
  assert.deepEqual(items, [{ id: "n1", title: "Newest", age: "3h ago" }, { id: "o1", title: "Older", age: "2 weeks ago" }]);
  assert.deepEqual(parsePlaylistPage("<html>consent wall</html>"), []);
});

test("an age becomes a date that far back", () => {
  assert.equal(dateFromAge("3h ago", NOW), "2026-12-01T09:00:00.000Z");
  assert.equal(dateFromAge("11d ago", NOW), "2026-11-20T12:00:00.000Z");
  assert.equal(dateFromAge("45 minutes ago", NOW), "2026-12-01T11:15:00.000Z");
  assert.equal(dateFromAge("5m ago", NOW), "2026-12-01T11:55:00.000Z");
  assert.equal(dateFromAge("1mo ago", NOW).slice(0, 10), "2026-11-01");
  assert.equal(dateFromAge("Streamed 2 weeks ago", NOW).slice(0, 10), "2026-11-17");
  assert.equal(dateFromAge("462", NOW), null);
});

test("feed down: episodes come from the playlist page; a new one is dated once and remembered", async () => {
  const store = memStore();
  let age = "3h ago";
  const fetchImpl = async (url) => {
    if (url.includes("/feeds/")) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => page([lockup("new1", "Brand new", age), lockup("qD-iUoxKDlM", "I Built a $500K Business.", "1mo ago")]) };
  };
  const r = await loadEpisodes({ fetchImpl, store, apiKey: "", now: NOW });
  assert.equal(r.source, "playlist page");
  assert.deepEqual(r.episodes.map((e) => e.id), ["new1", "qD-iUoxKDlM"]);
  assert.equal(r.episodes[0].published, "2026-12-01T09:00:00.000Z");
  assert.equal(r.episodes[1].published, "2026-11-02T18:12:37Z"); // exact, not worked out from "1mo ago"
  // Weeks later the page only says "3w ago": the remembered date is kept, not re-derived.
  age = "3w ago";
  const later = await loadEpisodes({ fetchImpl, store, apiKey: "", now: NOW + 21 * 864e5 });
  assert.equal(later.episodes[0].published, "2026-12-01T09:00:00.000Z");
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
