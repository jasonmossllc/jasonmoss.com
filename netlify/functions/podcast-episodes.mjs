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
// YouTube's feed endpoint has recurring outages where every feed returns 404 for hours.
// Each good read is saved, and when the feed is down the last good list is served
// instead (marked stale, cached for a shorter time). Only when there is no saved list
// yet does this return 502, and the page then keeps its built-in episode list.

import { getStore } from "@netlify/blobs";

const PLAYLIST_ID = "PLXo1Z9T72vaKc7fuaBdhcYkdyczEKhCEd";
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?playlist_id=${PLAYLIST_ID}`;
const MAX_EPISODES = 12;
const STORE_KEY = "last-good";
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

// Returns { episodes, stale } or null when there is nothing to serve.
// The store is best-effort in both directions: a storage problem never breaks a good feed read.
export async function loadEpisodes({ fetchImpl = fetch, store } = {}) {
  try {
    const episodes = await readFeed(fetchImpl);
    try { await store?.setJSON(STORE_KEY, { episodes, savedAt: new Date().toISOString() }); }
    catch (e) { console.error("podcast-episodes: save failed", e?.message); }
    return { episodes, stale: false };
  } catch (feedErr) {
    console.error("podcast-episodes: feed failed", feedErr?.message);
    try {
      const saved = await store?.get(STORE_KEY, { type: "json" });
      if (saved?.episodes?.length) return { episodes: saved.episodes, stale: true };
    } catch (e) { console.error("podcast-episodes: read saved failed", e?.message); }
    return null;
  }
}

const json = (status, body, cache) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cache } });

export default async () => {
  let store;
  try { store = getStore({ name: "podcast-episodes" }); } catch (e) { console.error("podcast-episodes: no store", e?.message); }
  const r = await loadEpisodes({ store });
  if (!r) return json(502, { error: "feed unavailable" }, { "Cache-Control": "no-store" });
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
