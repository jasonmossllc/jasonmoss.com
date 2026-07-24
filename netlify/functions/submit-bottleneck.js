// "What's Actually Stopping Your Business From Growing?" — Growth Bottleneck
// Assessment Funnel — /growth-bottleneck-quiz/
// Netlify Serverless Function
//
// Receives the completed 60-second assessment (5 scored questions — one per
// stage of the chain Reach → Nurture → Enroll → Deliver → Deepen — plus a
// revenue band), validates every answer server-side against the final
// instrument spec (scratchpad gba/final-instrument.md), computes the stage
// scores and the primary bottleneck, and syncs the lead to Kit: tag
// "Growth Bottleneck Assessment" + bottleneck_* custom fields + (qualified
// only) the 5-email follow-up sequence. Also handles `action: "booked"`
// pings from the results page to flip bottleneck_booked after a Calendly
// booking completes.
//
// The server result is canonical: the quiz page may compute locally for a
// latency-free fallback, but the redirect uses the resultsUrl returned here,
// and that same URL is stored in Kit (bottleneck_results_url).
//
// Environment variables: same as submit-contact.js (KIT_API_KEY,
// TURNSTILE_SECRET_KEY, ...). All bot guards + Kit plumbing are shared from
// submit-contact.js so every public endpoint stays identical in behavior.
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
  corsHeaders,
} = __internal;

const BOTTLENECK_TAG_ID = 21441351; // Kit tag: "Growth Bottleneck Assessment"
// Kit sequence "Growth Bottleneck Assessment" — 5-email clarity-session
// follow-up (days 0/1/3/5/7). QUALIFIED completers only; unqualified leads
// get the tag + results but no call pitch (same convention as Runs You).
const BOTTLENECK_SEQUENCE_ID = 2837723;

// The chain, in order. Order matters three times: question→stage mapping
// (q1..q5 = chain order), tie-breaking (earliest wins — upstream gates
// downstream), and the order scores travel in the results URL (s= csv).
const STAGES = ['reach', 'nurture', 'enroll', 'deliver', 'deepen'];
const STAGE_LABELS = {
  reach: 'Reach',
  nurture: 'Nurture',
  enroll: 'Enroll',
  deliver: 'Deliver',
  deepen: 'Deepen',
};
const FRONT_STAGES = ['reach', 'nurture', 'enroll'];
const BACK_STAGES = ['deliver', 'deepen'];

// Revenue bands — same keys/values as the Runs You funnel so reporting stays
// comparable across both assessments. Keys travel in the results URL (rev=);
// display values are what Kit stores (bottleneck_revenue).
const REVENUE = {
  '0-5k': '$0-5k',
  '5-10k': '$5-10k',
  '10-25k': '$10-25k',
  '25-50k': '$25-50k',
  '50k-plus': '$50k+',
};

// Option → points. One question per stage; stage score 0-3.
// Options run bad -> good on every question (a=0 ... d=3); the not-yet
// option (e, where present) sits last as the escape hatch.
const QUESTION_POINTS = {
  q1: { a: 0, b: 1, c: 2, d: 3 },
  q2: { a: 0, b: 1, c: 2, d: 3, e: 1 },
  q3: { a: 0, b: 1, c: 2, d: 3 },
  q4: { a: 0, b: 1, c: 2, d: 3, e: 2 },
  q5: { a: 0, b: 1, c: 2, d: 3, e: 2 },
};

// Not-yet options: the taker says this stage genuinely isn't in play yet
// ("no list yet" / "no paying clients yet" / "no client has finished yet").
// The stage still gets a score for the chain visual, but it is EXCLUDED from
// bottleneck routing and rendered "not in play yet" on the results page.
const NOT_YET_OPTIONS = { q2: 'e', q4: 'e', q5: 'e' };

function stageOfQuestion(n) {
  return STAGES[n - 1];
}

// Bottleneck routing (final-instrument.md):
//   - not-yet stages are excluded from routing entirely.
//   - $0-5k guardrail: the bottleneck resolves among the (non-excluded)
//     front stages UNLESS a non-excluded back stage scores strictly lower
//     than every front stage — then that back stage wins (lower of the two;
//     Deliver on tie).
//   - otherwise: lowest-scoring eligible stage; exact ties break to the
//     earliest stage in chain order.
// Returns { primary }.
function routeBottleneck(scores, excluded, revenueKey) {
  let pool;
  if (revenueKey === '0-5k') {
    const front = FRONT_STAGES.filter((st) => !excluded.includes(st));
    const frontMin = front.length ? Math.min(...front.map((st) => scores[st])) : Infinity;
    const backWinners = BACK_STAGES.filter(
      (st) => !excluded.includes(st) && scores[st] < frontMin
    );
    if (backWinners.length) {
      backWinners.sort((x, y) => scores[x] - scores[y] || STAGES.indexOf(x) - STAGES.indexOf(y));
      pool = [backWinners[0]];
    } else {
      pool = front.length ? front : STAGES.filter((st) => !excluded.includes(st));
    }
  } else {
    pool = STAGES.filter((st) => !excluded.includes(st));
  }
  if (!pool.length) pool = STAGES.slice(); // absurd edge: everything excluded

  let primary = pool[0];
  for (const stage of pool) {
    if (scores[stage] < scores[primary]) primary = stage;
  }
  return { primary };
}

// Validate + score a full submission. Pure — no I/O. Returns { ok: false }
// on any unrecognized option letter or revenue key (a forged payload).
function scoreAssessment(data) {
  const revenueKey = data.revenue;
  if (!Object.prototype.hasOwnProperty.call(REVENUE, revenueKey)) {
    return { ok: false };
  }
  const scores = { reach: 0, nurture: 0, enroll: 0, deliver: 0, deepen: 0 };
  const excluded = [];
  for (let n = 1; n <= 5; n++) {
    const q = 'q' + n;
    const key = data[q];
    if (
      typeof key !== 'string' ||
      !Object.prototype.hasOwnProperty.call(QUESTION_POINTS[q], key)
    ) {
      return { ok: false };
    }
    scores[stageOfQuestion(n)] = QUESTION_POINTS[q][key];
    if (NOT_YET_OPTIONS[q] === key) excluded.push(stageOfQuestion(n));
  }
  const { primary } = routeBottleneck(scores, excluded, revenueKey);
  return { ok: true, scores, excluded, primary, revenueKey };
}

// Canonical personalized results URL — must match the results page's param
// schema exactly: s= scores csv (chain order), b= primary, c= close,
// ny= excluded stages csv, rev= band key, name, email.
function buildResultsUrl({ scores, primary, excluded, revenueKey, firstName, email }) {
  const params = new URLSearchParams({
    s: STAGES.map((st) => scores[st]).join(','),
    b: primary,
    rev: revenueKey,
  });
  if (excluded.length) params.set('ny', excluded.join(','));
  if (firstName) params.set('name', firstName);
  if (email) params.set('email', email);
  return `https://jasonmoss.com/growth-bottleneck-quiz/results/?${params.toString()}`;
}

// Best-effort: flip bottleneck_booked to Yes after a Calendly booking.
// Never blocks the visitor — the booking already happened.
async function markBooked(email) {
  const subscriber = await findSubscriberByEmail(email);
  if (!subscriber?.id) return false;
  await updateSubscriber(subscriber.id, { email, fields: { bottleneck_booked: 'Yes' } });
  return true;
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

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
      // Deliberately opaque: the response must not reveal whether the email
      // exists as a Kit subscriber (an "updated" flag here was an email-
      // enumeration oracle). Outcome is logged server-side only.
      try {
        const updated = await markBooked(email);
        if (!updated) console.log('Booked ping for unknown subscriber', { email });
      } catch (error) {
        console.error('Failed to mark bottleneck booked', { email, error: kitErrorSummary(error) });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
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

    const scored = scoreAssessment(data);
    if (!scored.ok) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid answers' }) };
    }
    const { scores, excluded, primary, revenueKey } = scored;
    const qualified = revenueKey !== '0-5k';

    const firstName = cleanString(data.first_name, 100);
    const resultsUrl = buildResultsUrl({ scores, primary, excluded, revenueKey, firstName, email });
    const submission = {
      email,
      firstName,
      tagIds: [BOTTLENECK_TAG_ID],
      ...(qualified && BOTTLENECK_SEQUENCE_ID ? { sequenceId: BOTTLENECK_SEQUENCE_ID } : {}),
      // Preserved (only set when blank): original attribution + booked, so a
      // retake never resets a booked lead back to "No".
      mappedFields: {
        ...cleanMappedFieldValues(data),
        bottleneck_booked: 'No',
      },
      // Always take the latest assessment's answers.
      overwriteFields: {
        bottleneck_primary: STAGE_LABELS[primary],
        bottleneck_reach: String(scores.reach),
        bottleneck_nurture: String(scores.nurture),
        bottleneck_enroll: String(scores.enroll),
        bottleneck_deliver: String(scores.deliver),
        bottleneck_deepen: String(scores.deepen),
        bottleneck_revenue: REVENUE[revenueKey],
        bottleneck_qualified: qualified ? 'Yes' : 'No',
        bottleneck_date: new Date().toISOString().slice(0, 10),
        bottleneck_results_url: resultsUrl,
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
      console.error('Queued bottleneck opt-in after transient Kit failure', {
        queueKey,
        email,
        error: kitErrorSummary(error),
      });
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, queued: true, bottleneck: STAGE_LABELS[primary], scores, resultsUrl }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        subscriberId: result.subscriberId,
        tagged: result.tagged,
        bottleneck: STAGE_LABELS[primary],
        scores,
        resultsUrl,
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
module.exports.__test = {
  scoreAssessment,
  routeBottleneck,
  buildResultsUrl,
  QUESTION_POINTS,
  NOT_YET_OPTIONS,
  STAGES,
  REVENUE,
};
