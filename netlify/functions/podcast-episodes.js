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

const PLAYLIST_ID = 'PLXo1Z9T72vaKc7fuaBdhcYkdyczEKhCEd';
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?playlist_id=${PLAYLIST_ID}`;
const MAX_EPISODES = 12;

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function parseFeed(xml) {
  const entries = xml.split('<entry>').slice(1);
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

exports.handler = async () => {
  try {
    const res = await fetch(FEED_URL, { headers: { 'User-Agent': 'jasonmoss.com podcast page' } });
    if (!res.ok) throw new Error(`feed ${res.status}`);
    const episodes = parseFeed(await res.text());
    if (!episodes.length) throw new Error('feed had no episodes');
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=900',
        'Netlify-CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
      body: JSON.stringify({ episodes }),
    };
  } catch (err) {
    // The page keeps its built-in episode list when this fails.
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'feed unavailable' }),
    };
  }
};

module.exports.__test = { parseFeed, decodeXml };
