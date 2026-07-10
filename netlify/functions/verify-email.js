// ZeroBounce Email Verification
// Netlify Serverless Function
//
// Environment variables required (set in Netlify dashboard):
//   ZB_API_KEY  - your ZeroBounce API key
//
// Called on form submit to validate email in real-time.
// Returns { valid: true/false, reason: string, did_you_mean: string|null }
//
// Block policy (minimal, low false-positive):
//   BLOCK:  status "invalid" — mailbox does not exist
//   BLOCK:  sub_status "disposable" or "toxic" — throwaway/harmful addresses
//   ACCEPT: everything else (valid, catch-all, unknown, spamtrap, abuse,
//           role_based, mailbox_not_found, etc.)
//
// Rationale: on opt-in pages, the priority is not losing real leads.
// Spamtrap/abuse are vanishingly rare on voluntary opt-ins and ZB's
// classification isn't perfect — better to let Kit handle edge cases
// through normal list hygiene than to false-positive a real person.

const { __internal } = require('./submit-contact.js');
// Shared with the form endpoints so the allowlist and CORS behavior can't
// drift between functions. Origin/Referer are spoofable, so originAllowed is
// paired with the per-IP rate limit and the daily credit cap below — all
// three gate the paid lookup.
const { originAllowed, corsHeaders } = __internal;

const HARD_BLOCK_SUB_STATUSES = new Set(['disposable', 'toxic']);

// Global daily cap on paid ZeroBounce lookups (Netlify Blobs counter). The
// per-IP limiter below is per-warm-instance and resets on cold start, so a
// distributed spender could otherwise drain credits. Coarse and slightly racy
// by design; fail-open (a Blobs error never blocks a real visitor).
const ZB_DAILY_CAP = Number.parseInt(process.env.ZB_DAILY_CAP || '500', 10);
async function underDailyCap() {
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore({ name: 'zb-usage' });
    const key = new Date().toISOString().slice(0, 10);
    const used = (await store.get(key, { type: 'json' })) || 0;
    if (used >= ZB_DAILY_CAP) {
      console.error('ZeroBounce daily cap reached', { used, cap: ZB_DAILY_CAP });
      return false;
    }
    await store.setJSON(key, used + 1);
    return true;
  } catch (e) {
    return true;
  }
}

// Lightweight per-IP rate limit (per warm function instance, fail-open).
// Caps how fast any single source can spend ZeroBounce credits.
const RL_WINDOW_MS = 60000;
const RL_MAX = 8;
const rlHits = new Map();
function rateLimited(ip) {
  try {
    if (!ip) return false;
    const now = Date.now();
    const arr = (rlHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
    arr.push(now);
    rlHits.set(ip, arr);
    if (rlHits.size > 5000) rlHits.clear(); // crude memory bound
    return arr.length > RL_MAX;
  } catch (e) { return false; }
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  // Reject direct/cross-origin abuse before spending a ZeroBounce lookup.
  if (!originAllowed(event)) {
    return { statusCode: 403, headers, body: JSON.stringify({ valid: false, reason: 'Forbidden', did_you_mean: null }) };
  }
  // Per-IP rate limit — cap credit-burn from any single source. Fail open
  // (valid:true) so a real user who somehow trips it can still submit.
  const ip = event.headers['x-nf-client-connection-ip'] ||
    event.headers['client-ip'] ||
    (event.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (rateLimited(ip)) {
    return { statusCode: 429, headers, body: JSON.stringify({ valid: true, reason: '', did_you_mean: null }) };
  }

  try {
    let data;
    try {
      data = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ valid: false, reason: 'Invalid request body', did_you_mean: null }) };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { statusCode: 400, headers, body: JSON.stringify({ valid: false, reason: 'Invalid request body', did_you_mean: null }) };
    }

    if (!data.email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ valid: false, reason: 'Email is required', did_you_mean: null }),
      };
    }

    // Quick format check before burning an API call
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          valid: false,
          reason: 'Please enter a valid email address.',
          did_you_mean: null,
        }),
      };
    }

    // Call ZeroBounce API
    const apiKey = process.env.ZB_API_KEY;
    if (!apiKey) {
      console.error('ZB_API_KEY environment variable not set');
      // Fail open — don't block form submissions if ZeroBounce isn't configured
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ valid: true, reason: '', did_you_mean: null }),
      };
    }

    // Global daily spend cap — fail open (accept the email) once reached so
    // an attack can cost at most the cap, never a blocked real lead.
    if (!(await underDailyCap())) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ valid: true, reason: '', did_you_mean: null }),
      };
    }

    const zbUrl = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(data.email)}&ip_address=`;

    // Timeout so a ZeroBounce stall fails open (outer catch) instead of
    // riding out Netlify's function limit and 502ing the visitor mid-submit.
    const zbResponse = await fetch(zbUrl, { signal: AbortSignal.timeout(4000) });

    if (!zbResponse.ok) {
      console.error('ZeroBounce API error:', zbResponse.status, await zbResponse.text());
      // Fail open — don't block users if ZeroBounce is down
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ valid: true, reason: '', did_you_mean: null }),
      };
    }

    const result = await zbResponse.json();

    // Decision logic
    const isInvalid = result.status === 'invalid';
    const isHardBlockSub = HARD_BLOCK_SUB_STATUSES.has(result.sub_status);
    const isBlocked = isInvalid || isHardBlockSub;

    let reason = '';
    if (isBlocked) {
      if (isInvalid) {
        reason = 'This email address doesn\u2019t appear to exist. Please check for typos and try again.';
      } else {
        // disposable or toxic
        reason = 'Please enter a real, non-temporary email address.';
      }
    }

    // Pass through did_you_mean for typo correction (e.g. gmial.com → gmail.com)
    const didYouMean = result.did_you_mean || null;

    // Log for debugging (visible in Netlify function logs)
    console.log(
      `Email verification: ${data.email} → ${result.status}/${result.sub_status || 'none'} → ${isBlocked ? 'BLOCK' : 'ACCEPT'}${didYouMean ? ` (suggest: ${didYouMean})` : ''}`
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        valid: !isBlocked,
        reason,
        did_you_mean: didYouMean,
      }),
    };
  } catch (error) {
    console.error('Function error:', error);
    // Fail open
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ valid: true, reason: '', did_you_mean: null }),
    };
  }
};
