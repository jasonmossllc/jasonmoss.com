// Purchase attribution (ad source for Spiffy buyers)
// Netlify Serverless Function
//
// Spiffy only keeps ad click ids (fbclid, gclid...) on an order and drops
// source / ad / utm_* params, so a buyer's ad source never reaches Kit on its
// own. The sales page saves the landing params in localStorage (same keys the
// opt-in pages send: source || utm_source, ad || utm_content), and the Spiffy
// thank-you page posts them here with the buyer's email from Spiffy's
// thank-you params.
//
// Same rules as the opt-in pages: only original_source / original_ad, only
// when that field is still blank (first touch wins), never a default value.
// This endpoint cannot create, tag or unsubscribe anyone: the subscriber must
// already exist (Spiffy's own Kit integration creates them on purchase).
//
// Request:  { email, latest_source?, latest_ad?, order? }
// Response: 200 { saved: true|false } | 404 { retry: true } (not in Kit yet)
//           | 400 bad input | 403 bad origin | 500
const { __internal } = require('./submit-contact.js');
const {
  corsHeaders,
  originAllowed,
  cleanMappedFieldValues,
  buildFieldsToSet,
  findSubscriberByEmail,
  updateSubscriber,
  cleanString,
  EMAIL_RE,
} = __internal;

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
  const email = String((data && data.email) || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email' }) };
  }
  const mapped = cleanMappedFieldValues(data || {});
  if (!Object.keys(mapped).length) {
    return { statusCode: 200, headers, body: JSON.stringify({ saved: false }) };
  }

  try {
    const subscriber = await findSubscriberByEmail(email);
    if (!subscriber || !subscriber.id) {
      // Spiffy's Kit sync can land a few seconds after the thank-you page.
      return { statusCode: 404, headers, body: JSON.stringify({ retry: true }) };
    }
    const fields = buildFieldsToSet(mapped, subscriber.fields);
    if (!Object.keys(fields).length) {
      return { statusCode: 200, headers, body: JSON.stringify({ saved: false }) };
    }
    await updateSubscriber(subscriber.id, { email, fields });
    console.log('Purchase source saved', { order: cleanString(data.order, 40), fields: Object.keys(fields) });
    return { statusCode: 200, headers, body: JSON.stringify({ saved: true }) };
  } catch (error) {
    console.error('Purchase source error:', error && error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
