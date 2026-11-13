// Prefill lookup for the qualifier widget — Netlify Serverless Function
//
// Someone who clicks a link in a Kit email lands on a page carrying Kit's
// subscriber id (?ck_subscriber_id=). The qualifier embed (qualify/embed.js)
// sends that id here and gets back the subscriber's first name and email, so
// the Launchpad contact screen and the Calendly booking form arrive already
// filled in.
//
// POST { kid, sh? }  ->  200 { first_name, email }  (found)
//                        200 {}                      (not found / capped / any failure)
//
// What it returns is deliberately the least it can: first name + email only.
// No phone, no tags, no fields. Nothing here ever blocks or slows the widget:
// every failure answers 200 {} and the form is simply left empty.
//
// Guarding against someone walking subscriber ids to harvest the list:
//  - Kit ids are account-scoped, so only a real subscriber of this account
//    answers, and they are sparse (a random id is almost never one of ours).
//  - Origin/Referer must be one of our own https hosts (stops other sites'
//    browsers; a script can forge it, which is what the caps are for).
//  - At most LOOKUPS_PER_IP_PER_HOUR per visitor and LOOKUPS_DAILY_CAP site-wide
//    per UTC day (Netlify Blobs, plus an in-memory limit per warm instance).
//    Real traffic is a few dozen Kit-link landings a day on pages with the
//    widget, so the caps are far above normal use and far below a harvest.
//    If the counter store fails the lookup is refused (fails closed).
//  - When the link also carries Kit's hashed email (sh_kit = SHA-256 of the
//    address), it must match the subscriber found, or nothing is returned.

const crypto = require('crypto');
const { __internal } = require('./submit-contact.js');
const { connectBlobs, blobStore, originAllowed, corsHeaders, headerValue, EMAIL_RE } = __internal;

const KIT_API_BASE = (process.env.KIT_API_URL || 'https://api.kit.com').replace(/\/+$/, '');
const KID_RE = /^[1-9]\d{0,15}$/;
const SH_RE = /^[0-9a-f]{64}$/;
const STORE = 'qualify-prefill';
const LOOKUPS_PER_IP_PER_HOUR = Number.parseInt(process.env.PREFILL_PER_IP_PER_HOUR || '12', 10);
const LOOKUPS_DAILY_CAP = Number.parseInt(process.env.PREFILL_DAILY_CAP || '600', 10);
const KIT_TIMEOUT_MS = 3000;

const memHits = new Map();
function memLimited(bucket) {
  const used = memHits.get(bucket) || 0;
  if (used >= LOOKUPS_PER_IP_PER_HOUR) return true;
  if (memHits.size > 5000) memHits.clear(); // crude memory bound
  memHits.set(bucket, used + 1);
  return false;
}

// Counts the lookup against both caps, or refuses it. Blobs reads are
// eventually consistent, so a fast burst can briefly run a little past a cap
// before it closes; the in-memory limit catches one source hammering one
// instance at once. Any store error refuses the lookup.
async function admit(ip, store, now = new Date()) {
  try {
    const iso = now.toISOString();
    const ipHash = crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex').slice(0, 16);
    const dayKey = `day/${iso.slice(0, 10)}`;
    const ipKey = `ip/${iso.slice(0, 13)}/${ipHash}`;
    if (memLimited(ipKey)) return { admit: false, reason: 'ip_cap' };
    const st = store || await blobStore(STORE);
    const [dayRaw, ipRaw] = await Promise.all([
      st.get(dayKey, { type: 'json' }),
      st.get(ipKey, { type: 'json' }),
    ]);
    const dayUsed = Number(dayRaw) || 0;
    const ipUsed = Number(ipRaw) || 0;
    if (dayUsed >= LOOKUPS_DAILY_CAP) return { admit: false, reason: 'daily_cap', used: dayUsed };
    if (ipUsed >= LOOKUPS_PER_IP_PER_HOUR) return { admit: false, reason: 'ip_cap', used: ipUsed };
    await Promise.all([st.setJSON(dayKey, dayUsed + 1), st.setJSON(ipKey, ipUsed + 1)]);
    return { admit: true };
  } catch (e) {
    console.error('Prefill counter store error (lookup refused):', e?.message || e);
    return { admit: false, reason: 'store_error' };
  }
}

// One quick attempt, no retries: this only saves typing, so a slow Kit should
// never hold the widget up.
let fetchImpl = (...a) => fetch(...a); // tests swap this
async function kitSubscriber(kid) {
  const apiKey = process.env.KIT_API_KEY || process.env.CONVERTKIT_V4_API_KEY;
  if (!apiKey) return null;
  const res = await fetchImpl(`${KIT_API_BASE}/v4/subscribers/${kid}`, {
    headers: { Accept: 'application/json', 'X-Kit-Api-Key': apiKey },
    signal: AbortSignal.timeout(KIT_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return (body && body.subscriber) || null;
}

// A first name as Kit stores it, made safe to show in a form field: no control
// characters or markup, one line, a sane length. Anything odd is dropped.
function cleanFirstName(v) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return s.length >= 1 && s.length <= 60 ? s : '';
}

const NOTHING = (headers) => ({ statusCode: 200, headers, body: '{}' });

exports.handler = async (event) => {
  connectBlobs(event);
  const headers = { ...corsHeaders(event), 'Cache-Control': 'no-store' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!originAllowed(event)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };

  let data;
  try { data = JSON.parse(event.body || '{}'); } catch (e) { data = null; }
  if (!data || typeof data !== 'object') return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad request' }) };
  const kid = typeof data.kid === 'string' ? data.kid.trim() : '';
  const sh = typeof data.sh === 'string' ? data.sh.trim().toLowerCase() : '';
  if (!KID_RE.test(kid)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad request' }) };
  if (sh && !SH_RE.test(sh)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad request' }) };

  const ip =
    headerValue(event.headers, 'x-nf-client-connection-ip') ||
    headerValue(event.headers, 'client-ip') ||
    (headerValue(event.headers, 'x-forwarded-for') || '').split(',')[0].trim();
  const gate = await admit(ip);
  if (!gate.admit) {
    console.log('Prefill lookup refused', { reason: gate.reason });
    return NOTHING(headers);
  }

  try {
    const sub = await kitSubscriber(kid);
    const raw = sub && typeof sub.email_address === 'string' ? sub.email_address.trim() : '';
    const email = raw.toLowerCase();
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) return NOTHING(headers);
    const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
    // Either casing counts: the hash is only a consistency check, and a casing
    // difference must not cost a real subscriber their prefill.
    if (sh && sha(email) !== sh && sha(raw) !== sh) {
      console.log('Prefill lookup: hashed email on the link does not match the subscriber');
      return NOTHING(headers);
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ first_name: cleanFirstName(sub.first_name), email }),
    };
  } catch (e) {
    console.error('Prefill lookup failed:', e?.message || e);
    return NOTHING(headers);
  }
};

module.exports.__test = {
  admit,
  cleanFirstName,
  setFetch: (fn) => { fetchImpl = fn; },
  resetMem: () => memHits.clear(),
  LOOKUPS_PER_IP_PER_HOUR,
  LOOKUPS_DAILY_CAP,
};
