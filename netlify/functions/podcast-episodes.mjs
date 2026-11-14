// The Transmission — latest episodes for /transmission
// Netlify Serverless Function
//
// Reads the public YouTube RSS feed for the Transmission playlist (no API key)
// and returns the newest episodes as JSON, so the podcast page updates itself
// whenever a new episode is added to the playlist.
//
// Returns { episodes: [{ id, title, published }] }, newest first.
// Cached at Netlify's CDN for an hour (served stale while it refreshes), so the
// feed is fetched at most about once an hour no matter how much traffic the page gets.
//
// Sources, tried in order until one works:
//   1. YouTube Data API, only if a YOUTUBE_API_KEY env var is set (the dependable option).
//   2. The public RSS feed. It has long outages where every feed returns 404.
//   3. The public playlist page itself (no key). It lists the episodes with only a relative
//      age ("3h ago", "11d ago"), and YouTube blocks server requests to the video pages that
//      hold exact dates. So a new episode's date is worked out from its age the first time it
//      is seen (within hours of publishing, so it lands on the right day) and then remembered.
//      Episodes that were already out when this was written have their exact dates below.
//   4. The last good list saved from an earlier run (marked stale, cached for a shorter time).
// Only when all four fail does this return 502, and the page then keeps its built-in list.

import { getStore } from "@netlify/blobs";

const PLAYLIST_ID = "PLXo1Z9T72vaKc7fuaBdhcYkdyczEKhCEd";
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?playlist_id=${PLAYLIST_ID}`;
const MAX_EPISODES = 12;
const STORE_KEY = "last-good";
const DATES_KEY = "published-dates";
const PLAYLIST_URL = `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`;
const API_URL = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${PLAYLIST_ID}`;
// Exact publish dates (from the YouTube API, Nov 13 2026) for the episodes that already existed.
// Midday UTC where the time is unknown, so the date reads the same in every US timezone.
// Not a list to maintain: newer episodes are dated automatically and remembered in the store.
const KNOWN_DATES = {
  "qD-iUoxKDlM": "2026-11-02T18:12:37Z", "C-8Vru3lNCk": "2026-09-29T18:00:00Z", "uMLTeoOKDug": "2026-09-21T18:00:00Z", "dEmiep-4bpU": "2026-09-17T18:00:00Z",
  "A0LNCk77czo": "2026-09-15T18:00:00Z", "Ljm_3bA8lzA": "2026-09-14T18:00:00Z", "DXHvGhXG6Yw": "2026-09-11T18:00:00Z", "hpI_7DvjwN4": "2026-09-10T18:00:00Z",
  "0lP1252IuOA": "2026-09-07T18:00:00Z", "lBy3O8FK94I": "2026-09-04T18:00:00Z", "jYCu8sfQAA0": "2026-09-03T18:00:00Z", "43f7o0OfShI": "2026-08-31T18:00:00Z",
  "OihGjROP6KU": "2026-08-28T18:00:00Z", "kqclfulaPo4": "2026-08-27T18:00:00Z",
};
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  // Skips YouTube's cookie-consent interstitial, which is served to some regions instead of the page.
  Cookie: "SOCS=CAI; CONSENT=YES+1",
};
// Tried in order: the outage is sometimes limited to non-browser clients.
const USER_AGENTS = [
  "jasonmoss.com podcast page",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
];

export function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

export function parseFeed(xml) {
  const entries = xml.split("<entry>").slice(1);
  const episodes = [];
  for (const entry of entries) {
    const id = (entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const title = (entry.match(/<title>([^<]*)<\/title>/) || [])[1];
    const published = (entry.match(/<published>([^<]+)<\/published>/) || [])[1];
    if (id && title && published) episodes.push({ id, title: decodeXml(title).trim(), published });
  }
  episodes.sort((a, b) => new Date(b.published) - new Date(a.published));
  return episodes.slice(0, MAX_EPISODES);
}

async function readFeed(fetchImpl) {
  let lastErr;
  for (const ua of USER_AGENTS) {
    try {
      const res = await fetchImpl(FEED_URL, { headers: { "User-Agent": ua } });
      if (!res.ok) throw new Error(`feed ${res.status}`);
      const episodes = parseFeed(await res.text());
      if (!episodes.length) throw new Error("feed had no episodes");
      return episodes;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const newestFirst = (eps) => eps.sort((a, b) => new Date(b.published) - new Date(a.published)).slice(0, MAX_EPISODES);

async function readApi(fetchImpl, key) {
  const res = await fetchImpl(`${API_URL}&key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`api ${res.status}`);
  const data = await res.json();
  const episodes = (data.items || [])
    .map((i) => ({ id: i.contentDetails?.videoId, title: (i.snippet?.title || "").trim(), published: i.contentDetails?.videoPublishedAt }))
    .filter((e) => e.id && e.title && e.published);
  if (!episodes.length) throw new Error("api had no episodes");
  return newestFirst(episodes);
}

// The playlist page embeds its data as JSON. Its shape changes from time to time, so this
// looks for every known item shape anywhere in the tree instead of following a fixed path.
export function parsePlaylistPage(html) {
  const m = html.match(/var ytInitialData = (\{[\s\S]*?\});\s*<\/script>/);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }
  const items = [], seen = new Set();
  const add = (id, title, age) => { if (id && title && !seen.has(id)) { seen.add(id); items.push({ id, title: String(title).trim(), age: age || null }); } };
  // Any text inside the item that reads like an age: "11d ago", "1mo ago", "3 hours ago".
  const ageIn = (o) => { const m = JSON.stringify(o).match(/"(?:content|simpleText|text)":"((?:Streamed )?\d+\s*[a-z]+ ago)"/i); return m ? m[1] : null; };
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== "object") return;
    const lv = o.lockupViewModel;
    if (lv && (lv.contentType === undefined || /VIDEO/.test(lv.contentType))) add(lv.contentId, lv.metadata?.lockupMetadataViewModel?.title?.content, ageIn(lv.metadata));
    const pv = o.playlistVideoRenderer;
    if (pv) add(pv.videoId, pv.title?.runs?.[0]?.text ?? pv.title?.simpleText, ageIn(pv.videoInfo));
    Object.values(o).forEach(walk);
  })(data);
  return items;
}

const UNIT_MS = { s: 1e3, min: 6e4, h: 36e5, d: 864e5, w: 6048e5, mo: 2592e6, y: 31536e6 };
// "3h ago" -> an ISO date that far before `now`. Null when the text isn't an age.
export function dateFromAge(age, now = Date.now()) {
  const m = String(age || "").match(/(\d+)\s*(mo|month|min|minute|m|s|sec|second|h|hr|hour|d|day|w|wk|week|y|yr|year)s?\s+ago/i);
  if (!m) return null;
  const u = m[2].toLowerCase();
  const key = u.startsWith("mo") ? "mo" : u === "m" || u.startsWith("min") ? "min" : u[0];
  return new Date(now - Number(m[1]) * UNIT_MS[key]).toISOString();
}

async function readPlaylistPage(fetchImpl, store, now) {
  const res = await fetchImpl(PLAYLIST_URL, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`playlist page ${res.status}`);
  // The playlist lists newest first; a little headroom in case one video's date can't be read.
  const html = await res.text();
  const items = parsePlaylistPage(html).slice(0, MAX_EPISODES + 3);
  if (!items.length) throw new Error(`playlist page had no episodes (${res.url || ""}, ${html.length} bytes, consent=${/consent\.youtube|before you continue/i.test(html)}, initialData=${html.includes("ytInitialData")})`);
  let saved = {};
  try { saved = (await store?.get(DATES_KEY, { type: "json" })) || {}; } catch (e) { console.error("podcast-episodes: read dates failed", e?.message); }
  const dates = { ...saved, ...KNOWN_DATES };
  let learned = false;
  for (const i of items) {
    if (dates[i.id]) continue;
    const d = dateFromAge(i.age, now);
    if (d) { dates[i.id] = d; saved[i.id] = d; learned = true; }
  }
  if (learned) { try { await store?.setJSON(DATES_KEY, saved); } catch (e) { console.error("podcast-episodes: save dates failed", e?.message); } }
  const episodes = items.filter((i) => dates[i.id]).map((i) => ({ id: i.id, title: i.title, published: dates[i.id] }));
  if (!episodes.length) throw new Error("playlist page: no dates could be read");
  return newestFirst(episodes);
}

// Returns { episodes, stale } or null when there is nothing to serve.
// The store is best-effort in both directions: a storage problem never breaks a good feed read.
export async function loadEpisodes({ fetchImpl = fetch, store, apiKey = process.env.YOUTUBE_API_KEY, now = Date.now() } = {}) {
  const sources = [
    ...(apiKey ? [["api", () => readApi(fetchImpl, apiKey)]] : []),
    ["feed", () => readFeed(fetchImpl)],
    ["playlist page", () => readPlaylistPage(fetchImpl, store, now)],
  ];
  const why = [];
  for (const [name, read] of sources) {
    try {
      const episodes = await read();
      try { await store?.setJSON(STORE_KEY, { episodes, source: name, savedAt: new Date().toISOString() }); }
      catch (e) { console.error("podcast-episodes: save failed", e?.message); }
      return { episodes, stale: false, source: name };
    } catch (e) { why.push(`${name}: ${e?.message}`); console.error(`podcast-episodes: ${name} failed`, e?.message); }
  }
  try {
    const saved = await store?.get(STORE_KEY, { type: "json" });
    if (saved?.episodes?.length) return { episodes: saved.episodes, stale: true, source: "saved" };
  } catch (e) { console.error("podcast-episodes: read saved failed", e?.message); }
  return { episodes: null, why };
}

const json = (status, body, cache) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cache } });

export default async () => {
  let store;
  try { store = getStore({ name: "podcast-episodes" }); } catch (e) { console.error("podcast-episodes: no store", e?.message); }
  const r = await loadEpisodes({ store });
  if (!r.episodes) return json(502, { error: "feed unavailable", why: r.why }, { "Cache-Control": "no-store" });
  if (r.stale) {
    // Saved list while YouTube's feed is down: check again sooner than usual.
    return json(200, { episodes: r.episodes, stale: true }, {
      "Cache-Control": "public, max-age=300",
      "Netlify-CDN-Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600",
    });
  }
  return json(200, { episodes: r.episodes }, {
    "Cache-Control": "public, max-age=900",
    "Netlify-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
  });
};
