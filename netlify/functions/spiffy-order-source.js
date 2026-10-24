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
// Same rules as the opt-in pages: only those two fields, only when blank (first
// touch wins), never a default. This never creates or tags a Kit subscriber:
// if Spiffy's own Kit sync hasn't created them yet, we answer 503 so Spiffy
// retries the event later. Orders without an fbclid or a logged click are
// acknowledged and skipped (the thank-you page path still covers those).
//
// Response: 200 { saved | skipped } | 401 bad token | 503 retry later | 500
const crypto = require('crypto');
const { __internal } = require('./submit-contact.js');
const { buildFieldsToSet, findSubscriberByEmail, updateSubscriber, connectBlobs, blobStore, EMAIL_RE } = __internal;
const { __internal: clicks } = require('./track-ad-click.js');

const SPIFFY_API_BASE = (process.env.SPIFFY_BASE_URL || 'https://api.spiffy.co').replace(/\/+$/, '');
// Spiffy's Kit sync usually lands within seconds of the order; wait briefly
// before handing the retry back to Spiffy.
const KIT_WAIT_MS = [0, 2500, 3500];

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function tokenValid(event) {
  const expected = process.env.SPIFFY_ORDER_WEBHOOK_TOKEN || '';
  const given = String((event.queryStringParameters || {}).token || '');
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

async function fetchOrder(orderId) {
  const res = await fetch(`${SPIFFY_API_BASE}/v2/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${process.env.SPIFFY_API_KEY}`, Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Spiffy order lookup failed: ${res.status}`);
  const body = await res.json();
  return body && body.data ? body.data : body;
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
  const orderId = envelope.data && envelope.data.object && envelope.data.object.id;
  if (!orderId) return json(200, { skipped: 'no order id' });

  try {
    const order = await fetchOrder(orderId);
    if (!order) return json(200, { skipped: 'order not found' });
    const fbclid = String((order.preserved_params || {}).fbclid || '').trim();
    if (!fbclid) return json(200, { skipped: 'no fbclid' });

    connectBlobs(event);
    const store = await blobStore(clicks.AD_CLICK_STORE);
    const click = await store.get(clicks.clickKey(fbclid), { type: 'json' });
    if (!click || !click.fields || !Object.keys(click.fields).length) return json(200, { skipped: 'no logged click' });

    const email = String((order.customer && order.customer.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return json(200, { skipped: 'no customer email' });

    let subscriber = null;
    for (const wait of KIT_WAIT_MS) {
      if (wait) await sleep(wait);
      subscriber = await findSubscriberByEmail(email);
      if (subscriber && subscriber.id) break;
    }
    if (!subscriber || !subscriber.id) return json(503, { retry: 'subscriber not in Kit yet' });

    const fields = buildFieldsToSet(click.fields, subscriber.fields);
    if (!Object.keys(fields).length) return json(200, { saved: false });
    await updateSubscriber(subscriber.id, { email, fields });
    console.log('Order source saved', { order: String(orderId), fields: Object.keys(fields) });
    return json(200, { saved: true });
  } catch (error) {
    console.error('Order source error:', error && error.message);
    return json(500, { error: 'Internal server error' });
  }
};
