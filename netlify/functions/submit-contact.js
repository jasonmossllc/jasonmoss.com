// Kit Contact Submission
// Netlify Serverless Function
//
// Environment variables required (set in Netlify dashboard):
//   KIT_API_KEY           - your Kit API v4 key
//   KIT_RESUBSCRIBE_FORM_ID - Kit form ID used to reactivate unsubscribed contacts
//                             before applying signup tags. Defaults to 9576424.
//   KIT_QUEUE_BATCH_SIZE  - optional max queued opt-ins to retry per minute.
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
const KIT_RESUBSCRIBE_FORM_ID = process.env.KIT_RESUBSCRIBE_FORM_ID || '9576424';
const RESUBSCRIBE_ACTIVE_CHECK_DELAYS_MS = [0, 250, 750, 1500];
const KIT_RETRY_DELAYS_MS = [250, 750, 1500];
const KIT_OPTIN_QUEUE_STORE = 'kit-optin-queue';
const ORIGINAL_AD_FIELD = 'original_ad';
const ORIGINAL_SOURCE_FIELD = 'original_source';
// Add future page payload -> Kit custom field mappings here. Public pages should
// not be allowed to submit arbitrary Kit field names.
const PRESERVED_FIELD_MAPPINGS = [
  { payloadKey: 'latest_ad', kitField: ORIGINAL_AD_FIELD, maxLength: 500 },
  { payloadKey: 'latest_source', kitField: ORIGINAL_SOURCE_FIELD, maxLength: 500 },
];
const MAX_TAG_IDS = 10;

class KitApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'KitApiError';
    this.status = status;
    this.body = body;
  }
}

class DeferredKitSyncError extends Error {
  constructor(message, submissionPatch = {}) {
    super(message);
    this.name = 'DeferredKitSyncError';
    this.retryable = true;
    this.submissionPatch = submissionPatch;
  }
}

async function kitRequest(path, options = {}) {
  const apiKey = process.env.KIT_API_KEY || process.env.CONVERTKIT_V4_API_KEY;
  if (!apiKey) {
    throw new KitApiError('KIT_API_KEY is not configured', 500);
  }

  const { returnResponseMeta, ...fetchOptions } = options;

  for (let attempt = 0; attempt <= KIT_RETRY_DELAYS_MS.length; attempt += 1) {
    let res;
    try {
      res = await fetch(`${KIT_API_BASE}${path}`, {
        ...fetchOptions,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Kit-Api-Key': apiKey,
          ...(fetchOptions.headers || {}),
        },
      });
    } catch (error) {
      if (attempt >= KIT_RETRY_DELAYS_MS.length) throw error;
      await sleep(KIT_RETRY_DELAYS_MS[attempt]);
      continue;
    }

    const text = await res.text();
    let body = {};
    if (text) {
      try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
    }

    if (!res.ok) {
      const retryAfterSeconds = Number.parseFloat(res.headers.get('retry-after') || '');
      const shouldRetry =
        attempt < KIT_RETRY_DELAYS_MS.length &&
        (res.status === 429 || res.status >= 500);

      if (shouldRetry) {
        const delay = Number.isFinite(retryAfterSeconds)
          ? Math.min(Math.max(retryAfterSeconds * 1000, 250), 5000)
          : KIT_RETRY_DELAYS_MS[attempt];
        await sleep(delay);
        continue;
      }

      throw new KitApiError(`Kit API ${res.status}`, res.status, body);
    }

    return returnResponseMeta ? { status: res.status, body } : body;
  }

  throw new KitApiError('Kit API request failed after retries', 500);
}

function cleanString(value, maxLength = 500) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function isBlank(value) {
  return value == null || String(value).trim() === '';
}

function safeSubscriberId(subscriber) {
  return subscriber?.id || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeTagIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const tagIds = [];
  for (const value of values) {
    const normalized = String(value).trim();
    if (!/^\d+$/.test(normalized)) return null;
    tagIds.push(Number.parseInt(normalized, 10));
  }
  if (
    tagIds.length === 0 ||
    tagIds.length > MAX_TAG_IDS ||
    tagIds.some((tagId) => !Number.isSafeInteger(tagId) || tagId <= 0)
  ) {
    return null;
  }
  return [...new Set(tagIds)];
}

function cleanMappedFieldValues(data) {
  return PRESERVED_FIELD_MAPPINGS.reduce((fields, mapping) => {
    const value = cleanString(data[mapping.payloadKey], mapping.maxLength);
    if (value) fields[mapping.kitField] = value;
    return fields;
  }, {});
}

function buildFieldsToSet(mappedFields, existingFields) {
  return Object.entries(mappedFields).reduce((fields, [key, value]) => {
    if (value && isBlank(fieldValue(existingFields, key))) fields[key] = value;
    return fields;
  }, {});
}

function headerValue(headers, name) {
  const target = name.toLowerCase();
  const match = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === target);
  return match ? match[1] : undefined;
}

function extractSubscriber(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.subscriber) return result.subscriber;
  if (Array.isArray(result.subscribers)) return result.subscribers[0] || null;
  return null;
}

async function findSubscriberByEmail(email) {
  const qs = new URLSearchParams({ email_address: email, status: 'all', per_page: '1' });
  return extractSubscriber(await kitRequest(`/v4/subscribers?${qs.toString()}`));
}

async function saveSubscriber({ email, firstName, fields }) {
  return (await saveSubscriberWithMeta({ email, firstName, fields })).subscriber;
}

async function saveSubscriberWithMeta({ email, firstName, fields }) {
  const body = {
    email_address: email,
    ...(firstName ? { first_name: firstName } : {}),
    ...(fields && Object.keys(fields).length ? { fields } : {}),
  };

  const result = await kitRequest('/v4/subscribers', {
    method: 'POST',
    body: JSON.stringify(body),
    returnResponseMeta: true,
  });

  return {
    status: result.status,
    subscriber: extractSubscriber(result.body),
  };
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

async function tagSubscriberWithAll(tagIds, email) {
  for (const tagId of tagIds) {
    await tagSubscriberByEmail(tagId, email);
  }
}

async function addSubscriberToSequence(sequenceId, email) {
  return kitRequest(`/v4/sequences/${sequenceId}/subscribers`, {
    method: 'POST',
    body: JSON.stringify({ email_address: email }),
  });
}

function isSubscribed(subscriber) {
  return subscriber?.state === 'active';
}

function canUseResubscribeForm(subscriber) {
  return subscriber?.state === 'cancelled' || subscriber?.state === 'inactive';
}

async function addSubscriberToResubscribeForm(email, referrer) {
  return kitRequest(`/v4/forms/${KIT_RESUBSCRIBE_FORM_ID}/subscribers`, {
    method: 'POST',
    body: JSON.stringify({
      email_address: email,
      ...(referrer ? { referrer } : {}),
    }),
  });
}

async function waitForActiveSubscriber(email) {
  let subscriber = null;
  for (const delay of RESUBSCRIBE_ACTIVE_CHECK_DELAYS_MS) {
    if (delay) await sleep(delay);
    subscriber = await findSubscriberByEmail(email);
    if (isSubscribed(subscriber)) return subscriber;
  }
  return subscriber;
}

function isQueueableKitError(error) {
  if (error?.retryable) return true;
  if (error instanceof KitApiError) {
    return error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}

function kitErrorSummary(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    status: error?.status || null,
  };
}

function getOptinQueueStore() {
  const { getStore } = require('@netlify/blobs');
  return getStore({ name: KIT_OPTIN_QUEUE_STORE });
}

function optinQueueKey(email) {
  const safeEmail = String(email || 'unknown').replace(/[^a-z0-9@._-]+/gi, '').slice(0, 80);
  const random = Math.random().toString(36).slice(2, 10);
  return `pending/${Date.now()}-${safeEmail}-${random}.json`;
}

async function enqueueOptin(submission, error) {
  const store = getOptinQueueStore();
  const queuedSubmission = {
    ...submission,
    ...(error?.submissionPatch || {}),
  };
  const key = optinQueueKey(submission.email);
  await store.setJSON(key, {
    submission: queuedSubmission,
    attempts: 0,
    queuedAt: new Date().toISOString(),
    lastError: kitErrorSummary(error),
  }, { onlyIfNew: true });
  return key;
}

async function syncContactToKit(submission) {
  const {
    email,
    firstName,
    tagIds,
    mappedFields = {},
    overwriteFields = {},
    referrer = '',
  } = submission;

  if (submission.resubscribeAttempted) {
    const resubscribedSubscriber = await waitForActiveSubscriber(email);
    if (!isSubscribed(resubscribedSubscriber)) {
      throw new DeferredKitSyncError(
        'Kit subscriber is still waiting for resubscribe activation',
        { resubscribeAttempted: true }
      );
    }

    if (Object.keys(overwriteFields).length) {
      await updateSubscriber(resubscribedSubscriber.id, { email, fields: overwriteFields });
    }
    await tagSubscriberWithAll(tagIds, email);
    if (submission.sequenceId) await addSubscriberToSequence(submission.sequenceId, email);
    return { subscriberId: safeSubscriberId(resubscribedSubscriber), tagged: true };
  }

  const needsAttributionCheck = Object.keys(mappedFields).length > 0;
  const existingSubscriber = needsAttributionCheck ? await findSubscriberByEmail(email) : null;
  // mappedFields are preserved (set only when blank, e.g. original attribution);
  // overwriteFields always take the latest submission's value (e.g. assessment answers).
  const fields = {
    ...buildFieldsToSet(mappedFields, existingSubscriber?.fields),
    ...overwriteFields,
  };

  let subscriber;
  let subscriberExisted = false;
  if (needsAttributionCheck) {
    subscriberExisted = !!existingSubscriber?.id;
    subscriber = subscriberExisted
      ? await updateSubscriber(existingSubscriber.id, { email, firstName, fields })
      : await saveSubscriber({ email, firstName, fields });
  } else {
    const saved = await saveSubscriberWithMeta({ email, firstName, fields });
    subscriber = saved.subscriber;
    subscriberExisted = saved.status === 200;
  }

  if (subscriberExisted && !isSubscribed(subscriber)) {
    if (!canUseResubscribeForm(subscriber)) {
      console.error('Kit subscriber is not eligible for automatic form resubscribe', {
        subscriberId: safeSubscriberId(subscriber),
        state: subscriber?.state || null,
      });
      return { subscriberId: safeSubscriberId(subscriber), tagged: false };
    }

    await addSubscriberToResubscribeForm(email, referrer);
    let resubscribedSubscriber;
    try {
      resubscribedSubscriber = await waitForActiveSubscriber(email);
    } catch (error) {
      if (isQueueableKitError(error)) {
        error.submissionPatch = { ...(error.submissionPatch || {}), resubscribeAttempted: true };
      }
      throw error;
    }

    if (!isSubscribed(resubscribedSubscriber)) {
      throw new DeferredKitSyncError(
        'Kit subscriber is still waiting for resubscribe activation',
        { resubscribeAttempted: true }
      );
    }
  }

  await tagSubscriberWithAll(tagIds, email);
  if (submission.sequenceId) await addSubscriberToSequence(submission.sequenceId, email);
  return { subscriberId: safeSubscriberId(subscriber), tagged: true };
}

// Hosts allowed to submit. Covers the live domain, subdomains (go./www.),
// and Netlify deploy previews (*.netlify.app).
function originAllowed(event) {
  const h = event.headers || {};
  const candidates = [
    headerValue(h, 'origin'),
    headerValue(h, 'referer'),
    headerValue(h, 'referrer'),
  ].filter(Boolean);
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
      headerValue(event.headers, 'x-nf-client-connection-ip') ||
      headerValue(event.headers, 'client-ip') ||
      (headerValue(event.headers, 'x-forwarded-for') || '').split(',')[0].trim();

    // 1) Honeypot — a real user never fills the hidden "website" field.
    //    Return a fake success so bots don't learn they were blocked.
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
    const tagIds = normalizeTagIds(data.tag_ids || data.tag_id);
    if (!tagIds) {
      console.error('Missing or invalid Kit tag_id', { tag_id: data.tag_id, tag_ids: data.tag_ids });
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Signup tag is not configured' }) };
    }

    const submission = {
      email,
      firstName,
      tagIds,
      mappedFields: cleanMappedFieldValues(data),
      referrer: cleanString(
        headerValue(event.headers, 'referer') ||
        headerValue(event.headers, 'referrer') ||
        headerValue(event.headers, 'origin'),
        1000
      ),
    };

    let result;
    try {
      result = await syncContactToKit(submission);
    } catch (error) {
      if (!isQueueableKitError(error)) throw error;
      const queueKey = await enqueueOptin(submission, error);
      console.error('Queued Kit opt-in after transient Kit failure', {
        queueKey,
        email,
        error: kitErrorSummary(error),
      });
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, queued: true }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, subscriberId: result.subscriberId, tagged: result.tagged }),
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
module.exports.__internal = {
  enqueueOptin,
  getOptinQueueStore,
  isQueueableKitError,
  kitErrorSummary,
  syncContactToKit,
  // Shared with sibling form functions (submit-assessment.js) so every public
  // endpoint runs the exact same bot guards and Kit plumbing.
  verifyTurnstile,
  originAllowed,
  looksLikeBotName,
  cleanString,
  cleanMappedFieldValues,
  headerValue,
  EMAIL_RE,
  findSubscriberByEmail,
  updateSubscriber,
};
