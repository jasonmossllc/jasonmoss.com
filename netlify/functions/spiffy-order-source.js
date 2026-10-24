// Spiffy order → Kit ad source (ad source for Spiffy buyers, part 2 of 2)
// Netlify Serverless Function
//
// Spiffy calls this on every order:success (webhook endpoint created through
// the Spiffy API, URL carries ?token=SPIFFY_ORDER_WEBHOOK_TOKEN). The event is
// only a signal: we re-fetch the order from the Spiffy API by id, which is
// authoritative (customer email + preserved fbclid) and proves the order is
// real. The fbclid is looked up in the click log written by track-ad-click.js,
// and the stored source/ad go to Kit's original_source / original_ad.
//
// Rules (shared with submit-purchase-source.js, the thank-you backup):
//  - only original_source / original_ad, written together, and only when
//    original_source is still blank (first touch wins; never mix two touches)
//  - read the subscriber's authoritative record before writing
//  - never a default value, never create or tag a Kit subscriber
// Retries: a buyer not in Kit yet gets 503 so Spiffy retries, but only while
// the order is under RETRY_WINDOW_MS old; after that every outcome is a 200
// (logged) so failures can never pile up and get the webhook disabled. Orders
// with no fbclid or no logged click are acknowledged and skipped.
//
// Response: 200 { saved | skipped } | 401 bad token | 503 retry later | 500 (fresh only)
const crypto = require('crypto');
const { __internal } = require('./submit-contact.js');
const { buildFieldsToSet, findSubscriberByEmail, updateSubscriber, kitRequest, connectBlobs, blobStore, EMAIL_RE } = __internal;
const { __internal: clicks } = require('./track-ad-click.js');

const SPIFFY_API_BASE = (process.env.SPIFFY_BASE_URL || 'https://api.spiffy.co').replace(/\/+$/, '');
const SPIFFY_TIMEOUT_MS = 3000;
// How long after an order a failure may still ask Spiffy to retry.
const RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;
// Spiffy's own Kit sync usually lands within seconds; one short wait first.
const KIT_WAIT_MS = 2500;
// A click older than this isn't the visit that led to the order.
const CLICK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function tokenValid(event) {
  const expected = Buffer.from(process.env.SPIFFY_ORDER_WEBHOOK_TOKEN || '');
  const given = Buffer.from(String((event.queryStringParameters || {}).token || ''));
  if (!expected.length || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

async function spiffyGet(path) {
  const res = await fetch(`${SPIFFY_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${process.env.SPIFFY_API_KEY}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(SPIFFY_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Spiffy lookup failed: ${res.status}`);
  const body = await res.json();
  return body && body.data ? body.data : body;
}

// The order only embeds its customer when asked (?include=customer); fall
// back to the customer record so a missing embed can never drop the email.
async function fetchOrder(orderId) {
  const order = await spiffyGet(`/v2/orders/${encodeURIComponent(orderId)}?include=customer`);
  if (order && !(order.customer && order.customer.email) && order.customer_id) {
    order.customer = await spiffyGet(`/v2/customers/${encodeURIComponent(order.customer_id)}`);
  }
  return order;
}

function orderEmail(order) {
  const email = String((order && order.customer && order.customer.email) || '').trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : '';
}

// Age in ms of the first parseable timestamp (ISO string or epoch seconds/ms).
// Unparseable or missing dates count as fresh (age 0) and small clock skew
// (Spiffy ahead of us) is clamped to 0, so a real buyer is never skipped over
// a date format; the retry window still bounds it.
function ageMs(...timestamps) {
  for (const t of timestamps) {
    const ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t || '');
    if (Number.isFinite(ms)) return Math.max(0, Date.now() - ms);
  }
  return 0;
}

// The list lookup is eventually consistent; the record by id is not. Read the
// authoritative fields before deciding whether anything is blank.
async function authoritativeSubscriber(email) {
  const found = await findSubscriberByEmail(email);
  if (!found || !found.id) return null;
  const res = await kitRequest(`/v4/subscribers/${found.id}`);
  const sub = (res && res.subscriber) || found;
  if (String(sub.email_address || '').toLowerCase() !== email) return null;
  return sub;
}

// Write source + ad as one pair, only if original_source is still blank.
async function writeSourcePair(subscriber, email, mapped) {
  const existing = (subscriber && subscriber.fields) || {};
  const sourceBlank = existing.original_source == null || String(existing.original_source).trim() === '';
  if (!sourceBlank) return false;
  const fields = buildFieldsToSet(mapped, existing);
  if (!fields.original_source) return false;
  await updateSubscriber(subscriber.id, { email, fields });
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!tokenValid(event)) return json(401, { error: 'Unauthorized' });

  let envelope;
  try {
    envelope = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Invalid request body' });
  }
  if (!envelope || envelope.type !== 'order:success') return json(200, { skipped: 'event type' });
  const obj = (envelope.data && envelope.data.object) || {};
  const orderId = obj.id;
  if (!orderId) return json(200, { skipped: 'no order id' });
  // If Spiffy sent the order's params and there's no fbclid, skip without
  // calling the Spiffy API at all.
  if (obj.preserved_params && typeof obj.preserved_params === 'object' && !obj.preserved_params.fbclid) {
    return json(200, { skipped: 'no fbclid' });
  }

  let order = null;
  try {
    order = await fetchOrder(orderId);
    if (!order) return json(200, { skipped: 'order not found' });
    const fbclid = String((order.preserved_params || {}).fbclid || '').trim();
    if (!fbclid) return json(200, { skipped: 'no fbclid' });

    connectBlobs(event);
    const store = await blobStore(clicks.AD_CLICK_STORE);
    const click = await store.get(clicks.clickKey(fbclid), { type: 'json' });
    if (!click || !click.fields || !click.fields.original_source || ageMs(click.at) > CLICK_MAX_AGE_MS) {
      return json(200, { skipped: 'no logged click' });
    }

    const email = orderEmail(order);
    if (!email) return json(200, { skipped: 'no customer email' });

    let subscriber = await authoritativeSubscriber(email);
    if (!subscriber) {
      await sleep(KIT_WAIT_MS);
      subscriber = await authoritativeSubscriber(email);
    }
    if (!subscriber) {
      if (ageMs(order.created_at, envelope.created) < RETRY_WINDOW_MS) return json(503, { retry: 'subscriber not in Kit yet' });
      console.error('Order source: buyer never reached Kit', { order: String(orderId) });
      return json(200, { skipped: 'not in Kit' });
    }

    const saved = await writeSourcePair(subscriber, email, click.fields);
    if (saved) console.log('Order source saved', { order: String(orderId) });
    return json(200, { saved });
  } catch (error) {
    console.error('Order source error:', error && error.message, { order: String(orderId) });
    if (ageMs(order && order.created_at, envelope.created) < RETRY_WINDOW_MS) return json(500, { error: 'Internal server error' });
    return json(200, { skipped: 'error after retry window' });
  }
};

module.exports.__internal = { fetchOrder, orderEmail, ageMs, authoritativeSubscriber, writeSourcePair, RETRY_WINDOW_MS };
