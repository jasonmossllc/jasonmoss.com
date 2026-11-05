// Site Tracker edge function (runs in front of every request to jasonmoss.com).
//
// Three jobs, all first-party on jasonmoss.com:
//  1. Every HTML page: add the tracking script (<script src="/js/jm.js">) and set the visitor cookie (jm_vid).
//     The cookie is set HERE, by the server, on the site's own host and IP: Safari keeps server-set cookies up to
//     400 days, while cookies written by JavaScript are capped at 7 days (1 day after an ad click). Every page
//     view restarts the 400-day clock.
//  2. /_jm/e: receives the script's event batches. The browser gets an instant answer; the batch is forwarded to
//     the tracker app (Railway) in the background with a shared secret, Netlify's coarse geo (country/region/city)
//     and a keyed hash of the network (for rate limits; the IP itself is never sent or stored). If Railway is slow
//     or down, the batch goes into Netlify Blobs and netlify/functions/jm-replay.mjs replays it later.
//  3. /_jm/c: consent for EU/UK visitors (they get a notice; nothing is tracked until they accept), and the
//     visitor id for checkout.jasonmoss.com pages (where the script loads through GTM, not through this function).
//
// Never breaks the site: `onError: "bypass"` serves the page untouched if this function throws, and every step
// below fails open.
import { getStore } from "@netlify/blobs";

export const config = {
  path: "/*",
  excludedPath: [
    "/.netlify/*", "/js/*", "/css/*", "/assets/*", "/email-assets/*", "/images/*", "/fonts/*",
    "/*.css", "/*.js", "/*.mjs", "/*.map", "/*.json", "/*.xml", "/*.txt", "/*.ico", "/*.png", "/*.jpg", "/*.jpeg", "/*.gif",
    "/*.svg", "/*.webp", "/*.avif", "/*.woff", "/*.woff2", "/*.ttf", "/*.mp4", "/*.webm", "/*.mp3", "/*.m3u8", "/*.vtt", "/*.pdf",
    "/*.zip", "/*.ics",
  ],
  onError: "bypass",
};

const COOKIE = "jm_vid";
const CONSENT = "jm_consent";
const MAX_AGE = 400 * 86400; // Chrome's ceiling for cookie lifetime
const VID_RE = /^[A-Za-z0-9_-]{16,48}$/;
const SCRIPT_VERSION = "2";
const FORWARD_TIMEOUT_MS = 2500;
const MAX_BODY = 256 * 1024;
// EU + EEA + UK + Switzerland: these visitors get the consent notice.
const CONSENT_COUNTRIES = new Set(("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE " +
  "IS LI NO GB CH").split(" "));
// "bot" as a word, but not phone models like "CUBOT X30".
const BOT_RE = /(?<!cu)bot\b|crawl|spider|slurp|facebookexternalhit|headlesschrome|lighthouse|pagespeed|python-|curl\/|wget\/|go-http-client|okhttp|scrapy|proofpoint|mimecast|barracuda|safelinks|urldefense|outlook-ios-linkscanner|ms-office/i;
const SITE_ORIGINS = /^https:\/\/(jasonmoss\.com|www\.jasonmoss\.com|checkout\.jasonmoss\.com)$/;
// This site's own Netlify hosts (deploy previews / branch deploys): <name>.netlify.app and <prefix>--<name>.netlify.app
const PREVIEW_ORIGIN = /^https:\/\/([a-z0-9-]+--)?jasonmoss\.netlify\.app$/;

function env(name) {
  try { return Netlify.env.get(name) || ""; } catch { return ""; }
}

function readCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function newId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Host-only cookies (no Domain attribute): only jasonmoss.com itself receives them, so other *.jasonmoss.com hosts
// (e.g. the Spiffy-run checkout) can neither read nor overwrite them. Checkout pages get the id from /_jm/c.
function setCookie(headers, url, name, value, maxAge = MAX_AGE) {
  const secure = url.protocol === "https:" ? "; Secure" : ""; // plain http only happens in local development
  headers.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/${secure}; SameSite=Lax`);
}

function consentState(req, context) {
  const country = context?.geo?.country?.code || "";
  const choice = readCookie(req, CONSENT);
  if (choice === "1") return "g";
  if (choice === "0") return "n";
  return CONSENT_COUNTRIES.has(country) ? "r" : "g";
}

function originAllowed(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin navigations and old browsers send none
  return origin === new URL(req.url).origin || SITE_ORIGINS.test(origin) || PREVIEW_ORIGIN.test(origin);
}

function cors(req, headers) {
  const origin = req.headers.get("origin");
  if (origin && (SITE_ORIGINS.test(origin) || PREVIEW_ORIGIN.test(origin))) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
    headers.append("Vary", "Origin");
  }
  return headers;
}

// Keyed hash of the client network (for per-network rate limits at the tracker). Never reversible to the IP.
async function networkKey(context, secret) {
  try {
    const ip = String(context?.ip || "");
    if (!ip || !secret) return null;
    const net = ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip; // IPv6: the /64
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`net:${net}`)));
    return Array.from(sig.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- /_jm/e
function bufferStore() {
  try { return getStore({ name: "jm-buffer", consistency: "strong" }); } catch { return getStore("jm-buffer"); }
}
async function bufferEnvelope(envelope) {
  const store = bufferStore();
  const key = `q/${String(Date.now()).padStart(15, "0")}-${newId().slice(0, 10)}`;
  await store.set(key, JSON.stringify(envelope));
}

async function deliver(envelope) {
  const url = env("TRACKER_URL");
  const secret = env("TRACKER_INGEST_SECRET");
  let delivered = false;
  if (url && secret) {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-jm-secret": secret },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      // 2xx = stored. Other 4xx (not auth / rate) = the batch itself is bad; retrying can't help, so drop it.
      delivered = res.ok || (res.status >= 400 && res.status < 500 && ![401, 403, 408, 429].includes(res.status));
    } catch { delivered = false; }
  } else {
    console.error("jm: TRACKER_URL / TRACKER_INGEST_SECRET not set; buffering");
  }
  if (!delivered) {
    envelope.buffered = 1;
    try { await bufferEnvelope(envelope); } catch (e) { console.error("jm buffer write failed", e?.message || e); }
  }
}

async function handleEvents(req, context) {
  const headers = cors(req, new Headers({ "Cache-Control": "no-store" }));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response(null, { status: 405, headers });
  if (!originAllowed(req)) return new Response(null, { status: 403, headers });
  const ua = req.headers.get("user-agent") || "";
  if (BOT_RE.test(ua)) return new Response(null, { status: 204, headers });
  if (consentState(req, context) !== "g") return new Response(null, { status: 204, headers }); // no consent = nothing stored

  let text;
  try { text = await req.text(); } catch { return new Response(null, { status: 400, headers }); }
  if (!text || text.length > MAX_BODY) return new Response(null, { status: 413, headers });
  let p;
  try { p = JSON.parse(text); } catch { return new Response(null, { status: 400, headers }); }
  if (!p || typeof p !== "object" || !Array.isArray(p.e)) return new Response(null, { status: 400, headers });

  const cookieVid = readCookie(req, COOKIE);
  const geo = context?.geo || {};
  const envelope = {
    rt: Date.now(),
    vc: cookieVid && VID_RE.test(cookieVid) ? cookieVid : null,
    ua: ua.slice(0, 400),
    geo: { c: geo.country?.code || null, r: geo.subdivision?.code || null, ci: geo.city || null },
    ib: await networkKey(context, env("TRACKER_INGEST_SECRET")),
    p,
  };
  // Answer now; deliver (or buffer) in the background.
  const work = deliver(envelope).catch((e) => console.error("jm deliver:", e?.message || e));
  if (context && typeof context.waitUntil === "function") context.waitUntil(work);
  else await work;
  return new Response(null, { status: 204, headers });
}

// ---------------------------------------------------------------- /_jm/c
async function handleConsent(req, context) {
  const headers = cors(req, new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json" }));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const reqUrl = new URL(req.url);
  let vid = readCookie(req, COOKIE);
  if (!(vid && VID_RE.test(vid))) vid = null;

  if (req.method === "POST") {
    // Only our own pages may record a consent choice (no cross-site forms).
    if (!req.headers.get("origin") || !originAllowed(req)) return new Response(JSON.stringify({ error: "origin" }), { status: 403, headers });
    const yes = reqUrl.searchParams.get("v") === "1";
    setCookie(headers, reqUrl, CONSENT, yes ? "1" : "0");
    if (yes) {
      if (!vid) { vid = newId(); setCookie(headers, reqUrl, COOKIE, vid); }
      return new Response(JSON.stringify({ v: vid }), { status: 200, headers });
    }
    return new Response(JSON.stringify({ v: null }), { status: 200, headers });
  }
  const c = consentState(req, context);
  // Set the id only when there isn't one: a cookie set while on checkout (a different server IP) would be capped at
  // 7 days by Safari, and must never replace the 400-day one. The next jasonmoss.com page refreshes it anyway.
  if (c === "g" && !vid) {
    vid = newId();
    setCookie(headers, reqUrl, COOKIE, vid);
  }
  return new Response(JSON.stringify({ c, v: c === "g" ? vid : null }), { status: 200, headers });
}

// ---------------------------------------------------------------- every page
export default async function handler(req, context) {
  const url = new URL(req.url);
  if (url.pathname === "/_jm/e") {
    // The browser never sees an error from here (an error answer would make it keep the batch and retry forever).
    try { return await handleEvents(req, context); } catch (e) { console.error("jm events:", e?.message || e); return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }); }
  }
  if (url.pathname === "/_jm/c") return handleConsent(req, context);
  if (req.method !== "GET") return; // forms, HEAD etc.: untouched

  const res = await context.next();
  const type = res.headers.get("content-type") || "";
  if (!type.includes("text/html") || res.status !== 200) return res;

  let html;
  try { html = await res.text(); } catch { return; }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  try {
    const mode = consentState(req, context);
    if (!html.includes("/js/jm.js")) {
      const tag = `<script src="/js/jm.js?v=${SCRIPT_VERSION}" data-c="${mode}" defer></script>`;
      const head = html.search(/<\/head\s*>/i);
      const body = head >= 0 ? -1 : html.search(/<\/body\s*>/i);
      if (head >= 0) html = `${html.slice(0, head)}${tag}${html.slice(head)}`;
      else if (body >= 0) html = `${html.slice(0, body)}${tag}${html.slice(body)}`;
    }
    if (!BOT_RE.test(req.headers.get("user-agent") || "")) {
      let personal = false;
      if (mode === "g") {
        const existing = readCookie(req, COOKIE);
        // Re-set on every page so the 400-day clock restarts with each visit.
        setCookie(headers, url, COOKIE, existing && VID_RE.test(existing) ? existing : newId());
        personal = true;
      }
      const choice = readCookie(req, CONSENT);
      if (choice === "1" || choice === "0") { setCookie(headers, url, CONSENT, choice); personal = true; }
      if (personal) {
        // This response now carries a per-visitor cookie: no shared cache may store it.
        headers.delete("etag");
        headers.set("Cache-Control", "private, no-cache");
      }
    }
  } catch (e) {
    console.error("jm inject failed", e?.message);
  }
  return new Response(html, { status: res.status, statusText: res.statusText, headers });
}
