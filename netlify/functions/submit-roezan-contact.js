// Roezan (SMS) Contact Submission
// Netlify Serverless Function
//
// Roezan ONLY — this endpoint never touches Kit. Pages that need both email
// and SMS opt-in call submit-contact.js AND this function separately.
//
// Takes a public opt-in page submission (first name, last name, email, phone,
// Roezan tag ID) and syncs it straight to the Roezan API end-to-end:
//   1. Roezan contacts are keyed by phone. If the submission has no phone,
//      look up an existing Roezan contact by email and reuse its number;
//      if none can be found, the submission is rejected.
//   2. Create/update the contact (name + email) with the tag.
//   3. Apply the tag explicitly as well (belt and suspenders — matches the
//      automation hub's proven sync behavior for existing contacts).
// It only creates/updates the contact and tags it; it never sends an SMS.
//
// Verification accepts EITHER a fresh Turnstile token (standalone use) OR a
// roezan_pass from submit-contact.js's response (dual Kit+SMS opt-in pages:
// one widget run, Kit first, then this call — see ROEZAN PASS over there).
//
// Environment variables required (set in Netlify dashboard):
//   ROEZAN_API_KEY       - Roezan Integrations API key (X-API-Key header).
//   ROEZAN_API_URL       - optional base URL override.
//                          Defaults to https://app.roezan.com/api.
//   ROEZAN_PASS_SECRET   - HMAC secret shared with submit-contact.js.
//   TURNSTILE_SECRET_KEY - shared with submit-contact.js (see there).
//
// Bot guards (honeypot, origin allowlist, gibberish-name check, Turnstile)
// are shared from submit-contact.js so every public endpoint behaves the same.
const { __internal } = require('./submit-contact.js');
const {
  verifyTurnstile,
  verifyRoezanPass,
  originAllowed,
  looksLikeBotName,
  cleanString,
  normalizePhone,
  headerValue,
  EMAIL_RE,
} = __internal;

const ROEZAN_API_BASE = (process.env.ROEZAN_API_URL || 'https://app.roezan.com/api').replace(/\/+$/, '');
// Netlify gives synchronous functions ~10s total, and a submission can make up
// to 3 sequential Roezan calls — keep per-call timeouts and retries tight.
const ROEZAN_TIMEOUT_MS = 6000;
const ROEZAN_RETRY_DELAYS_MS = [300, 900];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A single numeric Roezan tag ID, hardcoded by site pages (never a tag name).
function normalizeRoezanTagId(value) {
  const normalized = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  const tagId = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(tagId) && tagId > 0 ? tagId : null;
}

async function roezanRequest(path, { method = 'GET', body, allowNotFound = false } = {}) {
  const apiKey = process.env.ROEZAN_API_KEY;
  if (!apiKey) {
    throw new Error('ROEZAN_API_KEY is not configured');
  }
  const url = path.startsWith('http') ? path : `${ROEZAN_API_BASE}${path}`;

  for (let attempt = 0; attempt <= ROEZAN_RETRY_DELAYS_MS.length; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(ROEZAN_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt >= ROEZAN_RETRY_DELAYS_MS.length) throw error;
      await sleep(ROEZAN_RETRY_DELAYS_MS[attempt]);
      continue;
    }

    if (res.status === 404 && allowNotFound) return null;

    if ((res.status === 429 || res.status >= 500) && attempt < ROEZAN_RETRY_DELAYS_MS.length) {
      await sleep(ROEZAN_RETRY_DELAYS_MS[attempt]);
      continue;
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Roezan ${method} ${path} failed: ${res.status} ${text.slice(0, 400)}`);
    }
    if (!text) return {};
    try { return JSON.parse(text); } catch (e) { return { raw: text }; }
  }

  throw new Error(`Roezan ${method} ${path} failed after retries`);
}

async function getRoezanContactByEmail(email) {
  const qs = new URLSearchParams({ email });
  const result = await roezanRequest(`/integrations/contacts?${qs.toString()}`, { allowNotFound: true });
  return result?.contact || null;
}

async function syncContactToRoezan({ email, firstName, lastName, phone, tagId }) {
  // Roezan writes are keyed by phone; fall back to an existing contact's
  // number when the page didn't collect one.
  let resolvedPhone = phone;
  if (!resolvedPhone) {
    const existing = await getRoezanContactByEmail(email);
    resolvedPhone = normalizePhone(existing?.phone_number) || '';
  }
  if (!resolvedPhone) return { synced: false, reason: 'no_phone' };

  await roezanRequest('/integrations/contacts', {
    method: 'POST',
    body: {
      phone: resolvedPhone,
      lists: [],
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(email ? { email } : {}),
      tags: [tagId],
    },
  });

  await roezanRequest('/integrations/contacts/tags', {
    method: 'POST',
    body: { phone: resolvedPhone, tagIds: [tagId] },
  });

  return { synced: true };
}

exports.handler = async (event) => {
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
      headerValue(event.headers, 'x-nf-client-connection-ip') ||
      headerValue(event.headers, 'client-ip') ||
      (headerValue(event.headers, 'x-forwarded-for') || '').split(',')[0].trim();

    // 1) Honeypot — a real user never fills the hidden "website" field.
    if (data.website) {
      console.log('Blocked: honeypot filled', { ip });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // 2) Origin/Referer must be a jasonmoss.com page.
    if (!originAllowed(event)) {
      console.log('Blocked: origin not allowed', {
        ip,
        origin: headerValue(event.headers, 'origin'),
        referer: headerValue(event.headers, 'referer'),
      });
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    // 3) Email required + well-formed.
    if (!data.email || !EMAIL_RE.test(String(data.email).trim())) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid email is required' }) };
    }

    // 4) Reject gibberish names (bot-generated random strings).
    if (looksLikeBotName(data.first_name) || looksLikeBotName(data.last_name)) {
      console.log('Blocked: bot-like name', { ip, first_name: data.first_name, last_name: data.last_name });
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid name' }) };
    }

    // 5) Verification — either a roezan_pass minted by submit-contact.js on
    //    this same submission (Turnstile tokens are single-use, so a page
    //    that already verified once hands trust off server-side instead of
    //    re-challenging the visitor), or a fresh Turnstile token when this
    //    endpoint is called standalone.
    const email = String(data.email).trim().toLowerCase();
    if (!verifyRoezanPass(data.roezan_pass, email)) {
      const ts = await verifyTurnstile(data.turnstile_token, ip);
      if (ts.block) {
        console.log('Blocked: no valid roezan_pass or Turnstile token', { ip });
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Verification failed' }) };
      }
    }

    // ── Passed all checks — normalize and sync to Roezan ────────────────────
    const firstName = cleanString(data.first_name, 100);
    const lastName = cleanString(data.last_name, 100);

    const phone = normalizePhone(data.phone);
    if (phone === null) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid phone number is required' }) };
    }

    const tagId = normalizeRoezanTagId(data.tag_id);
    if (!tagId) {
      console.error('Missing or invalid Roezan tag_id', { tag_id: data.tag_id });
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'SMS tag is not configured' }) };
    }

    const result = await syncContactToRoezan({ email, firstName, lastName, phone, tagId });

    // synced:false = no phone submitted and none on file in Roezan. That's an
    // expected outcome for email-only opt-ins (nothing to tag), not an error —
    // pages fire-and-forget this call, so don't make it look like a failure.
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, synced: result.synced }),
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
module.exports.__test = { normalizeRoezanTagId, normalizePhone, syncContactToRoezan };
