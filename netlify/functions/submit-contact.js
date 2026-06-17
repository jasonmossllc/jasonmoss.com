// Kit Contact Submission
// Netlify Serverless Function
//
// Environment variables required (set in Netlify dashboard):
//   KIT_API_KEY           - your Kit API v4 key
//   TURNSTILE_SECRET_KEY  - Cloudflare Turnstile SECRET key (optional).
//                           When set, every submission MUST carry a valid
//                           Turnstile token or it is rejected. Leave it unset
//                           and Turnstile is dormant (the other guards still run).
//
// ── BOT PROTECTION ─────────────────────────────────────────────────────────
// This endpoint is public, so it is the real gate against opt-in spam. Layered:
//   1. Honeypot field ("website")     — silently drop if a bot fills it.
//   2. Origin/Referer allowlist       — must come from a jasonmoss.com page.
//   3. Email + first-name validation  — reject malformed / gibberish junk.
//   4. Cloudflare Turnstile           — verify the token server-side (primary).
// Client-side checks alone are bypassable (bots POST straight to this URL),
// so all of these run here, server-side, regardless of the page.
//
const KIT_API_BASE = (process.env.KIT_API_URL || 'https://api.kit.com').replace(/\/+$/, '');
const ORIGINAL_AD_FIELD = 'original_ad';
const ORIGINAL_SOURCE_FIELD = 'original_source';

class KitApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'KitApiError';
    this.status = status;
    this.body = body;
  }
}

async function kitRequest(path, options = {}) {
  const apiKey = process.env.KIT_API_KEY || process.env.CONVERTKIT_V4_API_KEY;
  if (!apiKey) {
    throw new KitApiError('KIT_API_KEY is not configured', 500);
  }

  const res = await fetch(`${KIT_API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Kit-Api-Key': apiKey,
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let body = {};
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
  }

  if (!res.ok) {
    throw new KitApiError(`Kit API ${res.status}`, res.status, body);
  }
  return body;
}

function cleanString(value, maxLength = 500) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function isBlank(value) {
  return value == null || String(value).trim() === '';
}

function fieldValue(fields, key) {
  if (!fields) return null;
  if (Array.isArray(fields)) {
    const match = fields.find((f) => f && (f.key === key || f.name === key || f.label === key));
    return match ? match.value : null;
  }
  if (typeof fields === 'object') return fields[key];
  return null;
}

function extractSubscriber(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.subscriber) return result.subscriber;
  if (Array.isArray(result.subscribers)) return result.subscribers[0] || null;
  return null;
}

async function findSubscriberByEmail(email) {
  const qs = new URLSearchParams({ email_address: email, per_page: '1' });
  return extractSubscriber(await kitRequest(`/v4/subscribers?${qs.toString()}`));
}

async function saveSubscriber({ email, firstName, fields }) {
  const body = {
    email_address: email,
    ...(firstName ? { first_name: firstName } : {}),
    ...(fields && Object.keys(fields).length ? { fields } : {}),
  };

  return extractSubscriber(await kitRequest('/v4/subscribers', {
    method: 'POST',
    body: JSON.stringify(body),
  }));
}

async function updateSubscriber(subscriberId, { email, firstName, fields }) {
  const body = {
    email_address: email,
    ...(firstName ? { first_name: firstName } : {}),
    ...(fields && Object.keys(fields).length ? { fields } : {}),
  };

  return extractSubscriber(await kitRequest(`/v4/subscribers/${subscriberId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }));
}

async function tagSubscriberByEmail(tagId, email) {
  return kitRequest(`/v4/tags/${tagId}/subscribers`, {
    method: 'POST',
    body: JSON.stringify({ email_address: email }),
  });
}

// Hosts allowed to submit. Covers the live domain, subdomains (go./www.),
// and Netlify deploy previews (*.netlify.app).
function originAllowed(event) {
  const h = event.headers || {};
  const candidates = [h.origin, h.referer, h.referrer].filter(Boolean);
  if (candidates.length === 0) return false; // no Origin/Referer = direct (bot) call
  const okHost = (host) =>
    host === 'jasonmoss.com' ||
    host.endsWith('.jasonmoss.com') ||
    host === 'jasonmoss.netlify.app' ||
    host.endsWith('--jasonmoss.netlify.app'); // this site's Netlify deploy previews/branches only
  return candidates.some((u) => {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' && okHost(url.hostname.toLowerCase());
    } catch (e) { return false; }
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function maxConsonantRun(s) {
  const isVowel = (c) => 'aeiou'.includes(c.toLowerCase());
  let run = 0, best = 0;
  for (const c of s) {
    if (/[a-z]/i.test(c) && !isVowel(c)) { run += 1; best = Math.max(best, run); }
    else run = 0;
  }
  return best;
}

// Conservative gibberish detector — tuned to flag bot-generated names like
// "JmFxjgpwvybohvkahuDSd" while never touching real names (incl. "Jean-Luc",
// "O'Brien", "JohnPaulJones", non-Latin scripts, hyphenated/spaced names).
function looksLikeBotName(raw) {
  const n = (raw || '').trim();
  if (!n) return false;
  if (n.length > 40) return true;                              // absurd length
  if (/https?:\/\/|www\.|\.(com|net|org|ru|info)\b|[<>{}\[\]]/i.test(n)) return true; // urls/markup
  if ((n.match(/\d/g) || []).length >= 4) return true;        // digit-heavy
  if (/\s/.test(n)) return false;                              // has space -> treat as real
  // Only ASCII single tokens can be the random-string pattern; leave others alone.
  if (!/^[A-Za-z'’.\-]+$/.test(n)) return false;
  const letters = n.replace(/[^A-Za-z]/g, '');
  if (letters.length < 12) return false;
  const caps = (letters.match(/[A-Z]/g) || []).length;
  const internalCaps = (letters.slice(1).match(/[A-Z]/g) || []).length;
  const hasLower = /[a-z]/.test(letters);
  if (!hasLower || caps < 3 || internalCaps < 2) return false; // needs scattered mixed case
  const vowels = (letters.match(/[aeiou]/gi) || []).length;
  const vowelRatio = vowels / letters.length;
  return maxConsonantRun(letters) >= 4 || vowelRatio < 0.30;   // unpronounceable
}

// Verify a Cloudflare Turnstile token. STRICT but with a safety valve:
//  - missing token (verification not completed)        -> BLOCK
//  - forged / reused / invalid token (failed verify)   -> BLOCK
//  - valid token                                       -> allow
//  - OUR config error (wrong/rotated secret) or a Cloudflare outage -> FAIL OPEN
// Blocking missing/failed tokens enforces "no verification, no submit". Failing
// open ONLY on our-side config/infra errors keeps a mis-keyed secret or a CF
// outage from silently taking the whole funnel down (which a mis-keyed secret
// did once) — those are never the visitor's fault.
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { block: false, verified: false };   // not configured -> dormant (don't block)
  if (!token) return { block: true, verified: false };     // no verification -> BLOCK
  try {
    const form = new URLSearchParams();
    form.append('secret', secret);
    form.append('response', token);
    if (ip) form.append('remoteip', ip);
    const r = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', body: form }
    );
    const out = await r.json();
    if (out.success) return { block: false, verified: true };
    const codes = out['error-codes'] || [];
    // Forged or replayed token = a real bot signal -> block.
    if (codes.includes('invalid-input-response') || codes.includes('timeout-or-duplicate')) {
      return { block: true, verified: false };
    }
    // invalid-input-secret / bad-request / missing-input-secret = OUR config
    // problem, not the visitor's fault -> do NOT block; log it loudly.
    console.error('Turnstile non-blocking failure (check TURNSTILE_SECRET_KEY):', codes);
    return { block: false, verified: false };
  } catch (e) {
    console.error('Turnstile verify error (failing open):', e);
    return { block: false, verified: false };
  }
}

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': 'https://jasonmoss.com',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // CORS headers — locked to the live domain (calls are same-origin anyway).
  const headers = {
    'Access-Control-Allow-Origin': 'https://jasonmoss.com',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  try {
    let data;
    try {
      data = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
    }
    const ip =
      event.headers['x-nf-client-connection-ip'] ||
      event.headers['client-ip'] ||
      (event.headers['x-forwarded-for'] || '').split(',')[0].trim();

    // 1) Honeypot — a real user never fills the hidden "website" field.
    //    Return a fake success so bots don't learn they were blocked.
    if (data.website) {
      console.log('Blocked: honeypot filled', { ip });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // 2) Origin/Referer must be a jasonmoss.com page.
    if (!originAllowed(event)) {
      console.log('Blocked: origin not allowed', {
        ip, origin: event.headers.origin, referer: event.headers.referer,
      });
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    // 3) Email required + well-formed.
    if (!data.email || !EMAIL_RE.test(String(data.email).trim())) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid email is required' }) };
    }

    // 4) Reject gibberish first names (bot-generated random strings).
    if (looksLikeBotName(data.first_name)) {
      console.log('Blocked: bot-like first name', { ip, first_name: data.first_name });
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid name' }) };
    }

    // 5) Cloudflare Turnstile — blocks missing, forged, or replayed tokens
    //    (bots). It only fails open on our own config/outage (see verifyTurnstile).
    const ts = await verifyTurnstile(data.turnstile_token, ip);
    if (ts.block) {
      console.log('Blocked: forged/invalid Turnstile token', { ip });
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Verification failed' }) };
    }

    // ── Passed all checks — create/update the subscriber in Kit ──────────────
    const email = String(data.email).trim().toLowerCase();
    const firstName = cleanString(data.first_name, 100);

    // Tag IDs are hardcoded by site pages. Visitors never provide tag names.
    const tagId = Number.parseInt(data.tag_id, 10);
    if (!Number.isSafeInteger(tagId) || tagId <= 0) {
      console.error('Missing or invalid Kit tag_id', { tag_id: data.tag_id });
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Signup tag is not configured' }) };
    }

    const latestAd = cleanString(data.latest_ad, 500);
    const latestSource = cleanString(data.latest_source, 500);
    const needsAttributionCheck = !!(latestAd || latestSource);
    const existingSubscriber = needsAttributionCheck ? await findSubscriberByEmail(email) : null;

    const fields = {};
    if (latestAd && isBlank(fieldValue(existingSubscriber?.fields, ORIGINAL_AD_FIELD))) {
      fields[ORIGINAL_AD_FIELD] = latestAd;
    }
    if (latestSource && isBlank(fieldValue(existingSubscriber?.fields, ORIGINAL_SOURCE_FIELD))) {
      fields[ORIGINAL_SOURCE_FIELD] = latestSource;
    }

    const subscriber = existingSubscriber?.id
      ? await updateSubscriber(existingSubscriber.id, { email, firstName, fields })
      : await saveSubscriber({ email, firstName, fields });

    await tagSubscriberByEmail(tagId, email);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, subscriberId: subscriber?.id || null }),
    };
  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

// Exposed for unit tests only; Netlify invokes .handler exclusively.
module.exports.__test = { looksLikeBotName, maxConsonantRun, originAllowed, EMAIL_RE };
