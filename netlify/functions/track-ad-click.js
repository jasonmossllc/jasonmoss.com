// Ad click log (ad source for Spiffy buyers, part 1 of 2)
// Netlify Serverless Function
//
// Spiffy keeps Facebook's click id (fbclid) on every order but drops source /
// ad / utm_* params. So when someone lands on a sales page from an ad, the page
// posts the fbclid with its source/ad here, and we keep them in Netlify Blobs
// keyed by a hash of the fbclid. When the order comes in,
// spiffy-order-source.js looks the order's fbclid up here and writes the
// source/ad to Kit. Nothing about the buyer (no email) is stored.
//
// Same params as the opt-in pages: source || utm_source, ad || utm_content.
// First write per click wins; a click with neither param stores nothing.
//
// Request:  { fbclid, latest_source?, latest_ad? }  (sent as text/plain)
// Response: 200 { saved: true|false } | 400 bad input | 403 bad origin | 500
const crypto = require('crypto');
const { __internal } = require('./submit-contact.js');
const { corsHeaders, originAllowed, cleanMappedFieldValues, connectBlobs, blobStore } = __internal;

const AD_CLICK_STORE = 'ad-clicks';
const FBCLID_RE = /^[A-Za-z0-9_-]{10,600}$/;

function clickKey(fbclid) {
  return crypto.createHash('sha256').update(fbclid).digest('hex');
}

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
  const fbclid = String((data && data.fbclid) || '').trim();
  if (!FBCLID_RE.test(fbclid)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid click id' }) };
  }
  const mapped = cleanMappedFieldValues(data || {});
  if (!Object.keys(mapped).length) {
    return { statusCode: 200, headers, body: JSON.stringify({ saved: false }) };
  }

  try {
    connectBlobs(event);
    const store = await blobStore(AD_CLICK_STORE);
    const key = clickKey(fbclid);
    if (await store.get(key, { type: 'json' })) {
      return { statusCode: 200, headers, body: JSON.stringify({ saved: false }) };
    }
    await store.setJSON(key, { fields: mapped, at: new Date().toISOString() });
    return { statusCode: 200, headers, body: JSON.stringify({ saved: true }) };
  } catch (error) {
    console.error('Ad click log error:', error && error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};

module.exports.__internal = { AD_CLICK_STORE, clickKey };
