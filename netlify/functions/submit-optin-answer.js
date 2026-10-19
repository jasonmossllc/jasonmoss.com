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
// Response: 200 { saved: true } | 400 bad input | 403 bad origin/pass | 500
// The pass carries the Kit subscriber id (signed together with the email), so
// the answer is written straight to that record with one Kit call.
const { __internal } = require('./submit-contact.js');
const {
  corsHeaders,
  originAllowed,
  verifyAnswerPass,
  updateSubscriber,
  EMAIL_RE,
  optinRevenueLabel,
  KIT_OPTIN_REVENUE_FIELD,
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
  const label = optinRevenueLabel(data && data.optin_revenue);
  if (!EMAIL_RE.test(email) || !label) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid answer' }) };
  }
  const subscriberId = verifyAnswerPass(data.answer_pass, email);
  if (!subscriberId) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    await updateSubscriber(subscriberId, { email, fields: { [KIT_OPTIN_REVENUE_FIELD]: label } });
    return { statusCode: 200, headers, body: JSON.stringify({ saved: true }) };
  } catch (error) {
    console.error('Opt-in answer error:', error && error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
