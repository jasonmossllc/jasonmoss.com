// "Does Your Business Run You?" Assessment Funnel — /runs-you-assessment/
// Netlify Serverless Function
//
// Receives the completed 6-question assessment (after the email-capture
// screen), validates the answers server-side, computes qualified/severity,
// and syncs the lead to Kit: tag "Runs You Assessment" + assessment_* custom
// fields. Also handles `action: "booked"` pings from the results page to flip
// the assessment_booked field when a Calendly booking completes.
//
// Environment variables: same as submit-contact.js (KIT_API_KEY,
// TURNSTILE_SECRET_KEY, ...). All bot guards + Kit plumbing are shared from
// submit-contact.js so both public endpoints stay identical in behavior.
const { __internal } = require('./submit-contact.js');
const {
  enqueueOptin,
  isQueueableKitError,
  kitErrorSummary,
  syncContactToKit,
  verifyTurnstile,
  originAllowed,
  looksLikeBotName,
  cleanString,
  cleanMappedFieldValues,
  headerValue,
  EMAIL_RE,
  findSubscriberByEmail,
  updateSubscriber,
} = __internal;

const ASSESSMENT_TAG_ID = 20922469; // Kit tag: "Runs You Assessment"

// Allowed answer keys -> human-readable Kit field values. Anything outside
// these maps is rejected (bots POST arbitrary payloads straight at functions).
const REVENUE = {
  '0-5k': '$0-5k',
  '5-10k': '$5-10k',
  '10-25k': '$10-25k',
  '25-50k': '$25-50k',
  '50k-plus': '$50k+',
};
const HOURS = {
  'under-40': 'Under 40',
  '40-50': '40-50',
  '50-60': '50-60',
  '60-plus': '60+',
};
const VACATION = {
  '3-months': 'In the last 3 months',
  '6-months': 'In the last 6 months',
  'over-year': 'Over a year ago',
  'cant-remember': "Can't remember",
};
const COST = {
  health: 'My health',
  relationships: 'My relationships',
  family: 'My presence with family',
  purpose: 'My sense of purpose',
  all: 'All of it',
};
// Severity scoring per spec: Q3 value + hours band + vacation band.
const HOURS_POINTS = { 'under-40': 1, '40-50': 2, '50-60': 3, '60-plus': 4 };
const VACATION_POINTS = { '3-months': 1, '6-months': 2, 'over-year': 3, 'cant-remember': 4 };

function severityTier(score) {
  if (score >= 10) return 'High';
  if (score >= 6) return 'Moderate';
  return 'Low';
}

// Best-effort: flip assessment_booked to Yes after a Calendly booking.
// Never blocks the visitor — the booking already happened.
async function markBooked(email) {
  const subscriber = await findSubscriberByEmail(email);
  if (!subscriber?.id) return false;
  await updateSubscriber(subscriber.id, { email, fields: { assessment_booked: 'Yes' } });
  return true;
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

    // Honeypot — fake success so bots don't learn they were blocked.
    if (data.website) {
      console.log('Blocked: honeypot filled', { ip });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    if (!originAllowed(event)) {
      console.log('Blocked: origin not allowed', {
        ip,
        origin: headerValue(event.headers, 'origin'),
        referer: headerValue(event.headers, 'referer'),
      });
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    if (!data.email || !EMAIL_RE.test(String(data.email).trim())) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid email is required' }) };
    }
    const email = String(data.email).trim().toLowerCase();

    // ── Booking ping from the results page (post-Calendly) ──────────────────
    if (data.action === 'booked') {
      try {
        const updated = await markBooked(email);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, updated }) };
      } catch (error) {
        console.error('Failed to mark assessment booked', { email, error: kitErrorSummary(error) });
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, updated: false }) };
      }
    }

    // ── Full assessment submission ───────────────────────────────────────────
    if (looksLikeBotName(data.first_name)) {
      console.log('Blocked: bot-like first name', { ip, first_name: data.first_name });
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid name' }) };
    }

    const ts = await verifyTurnstile(data.turnstile_token, ip);
    if (ts.block) {
      console.log('Blocked: forged/invalid Turnstile token', { ip });
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Verification failed' }) };
    }

    // Validate answers. Q1 must be "yes" — a "no" routes to the off-ramp and
    // never reaches email capture, so any other value here is a forged payload.
    const q3 = Number.parseInt(data.q3, 10);
    if (
      data.q1 !== 'yes' ||
      !REVENUE[data.q2] ||
      !Number.isInteger(q3) || q3 < 1 || q3 > 5 ||
      !HOURS[data.q4] ||
      !VACATION[data.q5] ||
      !COST[data.q6]
    ) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid answers' }) };
    }

    const score = q3 + HOURS_POINTS[data.q4] + VACATION_POINTS[data.q5];
    const severity = severityTier(score);
    const qualified = data.q2 !== '0-5k';

    const firstName = cleanString(data.first_name, 100);
    const submission = {
      email,
      firstName,
      tagIds: [ASSESSMENT_TAG_ID],
      // Preserved (only set when blank): original attribution + booked, so a
      // retake never resets a booked lead back to "No".
      mappedFields: {
        ...cleanMappedFieldValues(data),
        assessment_booked: 'No',
      },
      // Always take the latest assessment's answers.
      overwriteFields: {
        assessment_revenue: REVENUE[data.q2],
        assessment_runs_you_score: String(q3),
        assessment_hours: HOURS[data.q4],
        assessment_vacation: VACATION[data.q5],
        assessment_cost: COST[data.q6],
        assessment_qualified: qualified ? 'Yes' : 'No',
        assessment_severity: severity,
        assessment_date: new Date().toISOString().slice(0, 10),
      },
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
      console.error('Queued assessment opt-in after transient Kit failure', {
        queueKey,
        email,
        error: kitErrorSummary(error),
      });
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, queued: true, qualified, severity, score }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        subscriberId: result.subscriberId,
        tagged: result.tagged,
        qualified,
        severity,
        score,
      }),
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
module.exports.__test = { severityTier, HOURS_POINTS, VACATION_POINTS, REVENUE, HOURS, VACATION, COST };
