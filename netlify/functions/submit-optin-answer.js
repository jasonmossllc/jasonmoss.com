// Opt-in follow-up answer (step 2 of a two-step opt-in)
// Netlify Serverless Function
//
// A two-step opt-in page first submits name + email to submit-contact.js,
// which runs every bot gate, saves the subscriber in Kit and returns an
// answer_pass (see ANSWER PASS there). The page then asks one follow-up
// question and posts the answer here. This endpoint only ever sets the
// "optin_revenue" Kit field on an existing subscriber: it cannot create
// subscribers, tag them, or touch any other field.
//
// Request:  { email, optin_revenue: 'under-1k' | '1k-10k' | '10k-plus', answer_pass }
// Response: 200 { saved: true } | 200 { saved: false } when the subscriber
//           isn't in Kit yet (queued opt-in) | 400 bad input | 403 bad origin/pass
const { __internal } = require('./submit-contact.js');
const {
  corsHeaders,
  originAllowed,
  verifyAnswerPass,
  findSubscriberByEmail,
  updateSubscriber,
  EMAIL_RE,
  OPTIN_REVENUE,
  KIT_OPTIN_REVENUE_FIELD,
} = __internal;

const FIND_RETRY_DELAYS_MS = [0, 1500];

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
  const label = OPTIN_REVENUE[String((data && data.optin_revenue) || '')];
  if (!EMAIL_RE.test(email) || !label) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid answer' }) };
  }
  if (!verifyAnswerPass(data.answer_pass, email)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    let subscriber = null;
    for (const delay of FIND_RETRY_DELAYS_MS) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      subscriber = await findSubscriberByEmail(email);
      if (subscriber && subscriber.id) break;
    }
    if (!subscriber || !subscriber.id) {
      console.log('Opt-in answer: subscriber not in Kit yet (queued opt-in?)', { value: data.optin_revenue });
      return { statusCode: 200, headers, body: JSON.stringify({ saved: false }) };
    }
    await updateSubscriber(subscriber.id, { email, fields: { [KIT_OPTIN_REVENUE_FIELD]: label } });
    return { statusCode: 200, headers, body: JSON.stringify({ saved: true }) };
  } catch (error) {
    console.error('Opt-in answer error:', error && error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
