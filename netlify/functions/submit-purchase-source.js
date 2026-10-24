// Purchase attribution backup (ad source for Spiffy buyers)
// Netlify Serverless Function
//
// The primary path is spiffy-order-source.js (Spiffy order webhook + the
// fbclid click log). This is the backup for buyers without an fbclid: the
// sales page saves the landing params in localStorage (same keys the opt-in
// pages send: source || utm_source, ad || utm_content), and the Spiffy
// thank-you page posts them with Spiffy's thank-you params (order + email).
//
// Nothing is written unless the order is verified with the Spiffy API: it
// must exist, belong to that email, and be recent. That stops anyone from
// writing values to arbitrary subscribers or probing who is on the list.
// Same rules as the webhook (shared helpers): source + ad as one pair, only
// when original_source is blank, read from the authoritative Kit record,
// never a default, never create or tag a subscriber.
//
// Request:  { order, email, latest_source?, latest_ad? }
// Response: 200 { saved: true|false } | 404 { retry: true } (verified, not in
//           Kit yet) | 400 bad input | 403 bad origin or unverified order | 500
const { __internal } = require('./submit-contact.js');
const { corsHeaders, originAllowed, cleanMappedFieldValues, cleanString, EMAIL_RE } = __internal;
const { __internal: orders } = require('./spiffy-order-source.js');

// The thank-you page posts within about a minute of checkout; allow a margin.
const ORDER_MAX_AGE_MS = 2 * 60 * 60 * 1000;

exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!originAllowed(event)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }
  // A '+' in an unencoded thank-you URL arrives as a space: put it back.
  const email = String((data && data.email) || '').trim().replace(/ /g, '+').toLowerCase();
  const orderId = cleanString(data && data.order, 40);
  if (!EMAIL_RE.test(email) || !/^\d{1,20}$/.test(orderId || '')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
  }
  const mapped = cleanMappedFieldValues(data || {});
  if (!mapped.original_source) {
    return { statusCode: 200, headers, body: JSON.stringify({ saved: false }) };
  }

  try {
    const order = await orders.fetchOrder(orderId);
    const verified = order && orders.orderEmail(order) === email && orders.ageMs(order.created_at) < ORDER_MAX_AGE_MS;
    if (!verified) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
    }
    const subscriber = await orders.authoritativeSubscriber(email);
    if (!subscriber) {
      // Spiffy's Kit sync can land a few seconds after the thank-you page.
      return { statusCode: 404, headers, body: JSON.stringify({ retry: true }) };
    }
    const saved = await orders.writeSourcePair(subscriber, email, mapped);
    if (saved) console.log('Purchase source saved', { order: orderId });
    return { statusCode: 200, headers, body: JSON.stringify({ saved }) };
  } catch (error) {
    console.error('Purchase source error:', error && error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
