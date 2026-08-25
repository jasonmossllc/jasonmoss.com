// Call Qualifier widget — /qualify/
// Netlify Serverless Function
//
// Receives the 5-screen qualifier (revenue band, full-time, current clients,
// goal, then name + email), validates every answer server-side, decides
// book-vs-decline, and syncs the lead to Kit BEFORE the booking screen is
// shown so drop-offs are still captured.
//
// Routing (see the analysis at ~/tmp/qualify-2026): all seven historical
// buyers were $1k-$10k/mo, full-time, with current paying clients. Under
// $1k/mo produced $0 across 32 calls, and not-full-time produced $0 across 23.
// $10k+/mo also produced $0 historically but is deliberately allowed through —
// declining someone at $25k/mo with "you're not quite ready" is the wrong
// message, and they are ~11% of volume.
//
// Bot guards, Turnstile and Kit plumbing are shared from submit-contact.js so
// every public endpoint on this site behaves identically.
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

// Kit tags
const TAG_SUBMITTED = 22754513; // "Qualifier Submitted"  — everyone
const TAG_QUALIFIED = 22754514; // "Qualifier Qualified"
const TAG_DECLINED = 22754515; // "Qualifier Declined"
const TAG_HIGH_REV = 22754516; // "Qualifier High Revenue" — $10k+/mo
const TAG_LAUNCHPAD_DOWNSELL = 20410106; // existing downsell tag

// ── Test mode ───────────────────────────────────────────────────────────────
// ?test=1 on the widget: everything is validated exactly as in production
// (origin, honeypot, answers, Turnstile) but NOTHING is written to Kit. Safe
// for anyone to hit — it grants no bypass, so it can't be used to flood us.
//
// ?test=<QUALIFY_TEST_KEY>: additionally skips the Turnstile requirement, so
// automated/repeat testing works. The key lives in a Netlify env var and is
// the only thing that can bypass a bot guard.
const TEST_KEY = process.env.QUALIFY_TEST_KEY || '';

// ── Allowed answers. Anything outside these maps is a forged payload. ────────
// Values double as the human-readable string written to Kit.
const REVENUE = {
  none: "Haven't started earning yet",
  'under-1k': 'Under $1,000/mo',
  '1k-5k': '$1,000-$5,000/mo',
  '5k-10k': '$5,000-$10,000/mo',
  '10k-plus': '$10,000+/mo',
  // Retired bands from earlier versions of the option list. Still accepted so
  // a part-finished session doesn't get rejected as a forged payload.
  '1k-3k': '$1,000-$3,000/mo',
  '3k-10k': '$3,000-$10,000/mo',
  '3k-5k': '$3,000-$5,000/mo',
  '10k-25k': '$10,000-$25,000/mo',
  '25k-plus': '$25,000+/mo',
};
const FULLTIME = {
  yes: 'Full-time on this',
  job: 'Has a job or other main income',
  supported: 'Retired or supported, building this',
};
const CLIENTS = {
  none: 'None right now',
  '1-2': '1-2 clients',
  '3-5': '3-5 clients',
  '6-plus': '6+ clients',
};

// Revenue bands that clear the $1k floor.
const REVENUE_OK = new Set([
  '1k-5k', '5k-10k', '10k-plus',
  '1k-3k', '3k-10k', '3k-5k', '10k-25k', '25k-plus',   // retired
]);
const HIGH_REVENUE = new Set(['10k-plus', '10k-25k', '25k-plus']);

// How long a decline stands. Someone told "not yet" cannot re-answer their way
// into a booking, but a business does genuinely change, so it expires.
const DECLINE_LOCK_DAYS = 90;

/**
 * Book or decline, and which decline copy to show.
 * Precedence matters: the reason shown is the earliest-stage one that applies,
 * so someone pre-revenue AND part-time hears the pre-revenue message.
 */
function decide(revenue, fulltime, clients) {
  if (!REVENUE_OK.has(revenue)) return { decision: 'decline', reason: 'early' };
  if (fulltime !== 'yes') return { decision: 'decline', reason: 'part_time' };
  if (clients === 'none') return { decision: 'decline', reason: 'no_clients' };
  return { decision: 'book', reason: null };
}

/** Flip qualify_booked to Yes when the booking screen reports a completed booking. */
async function markBooked(email) {
  const subscriber = await findSubscriberByEmail(email);
  if (!subscriber?.id) return false;
  await updateSubscriber(subscriber.id, { email, fields: { qualify_booked: 'Yes' } });
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

    // ── Booking ping from the booking screen (post-Calendly) ────────────────
    // Deliberately opaque: never reveal whether the email exists in Kit.
    if (data.action === 'booked') {
      if (cleanString(data.test, 200)) {
        console.log('Qualifier TEST booked ping (no Kit write)', { email });
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, test: true }) };
      }
      try {
        const updated = await markBooked(email);
        if (!updated) console.log('Booked ping for unknown subscriber', { email });
      } catch (error) {
        console.error('Failed to mark qualifier booked', { email, error: kitErrorSummary(error) });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── Full qualifier submission ───────────────────────────────────────────
    if (looksLikeBotName(data.first_name)) {
      console.log('Blocked: bot-like first name', { ip, first_name: data.first_name });
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid name' }) };
    }

    const testParam = cleanString(data.test, 200);
    const isTest = !!testParam;
    const trustedTest = !!TEST_KEY && testParam === TEST_KEY;

    if (!trustedTest) {
      const ts = await verifyTurnstile(data.turnstile_token, ip);
      if (ts.block) {
        console.log('Blocked: forged/invalid Turnstile token', { ip });
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Verification failed' }) };
      }
    }

    if (!REVENUE[data.revenue] || !FULLTIME[data.fulltime] || !CLIENTS[data.clients]) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid answers' }) };
    }

    let { decision, reason } = decide(data.revenue, data.fulltime, data.clients);

    // A previous decline stands for DECLINE_LOCK_DAYS regardless of what they
    // answer this time. The client hides the questions after a decline, but
    // that is cosmetic — a new tab clears it, so the real gate is here.
    let lockedByPriorDecline = false;
    if (decision === 'book' && !isTest) {
      try {
        const prior = await findSubscriberByEmail(email);
        const priorDecision = prior?.fields?.qualify_decision || '';
        const priorDate = prior?.fields?.qualify_date || '';
        if (/^Decline/i.test(priorDecision) && priorDate) {
          const ageDays = (Date.now() - Date.parse(priorDate + 'T00:00:00Z')) / 86400000;
          if (Number.isFinite(ageDays) && ageDays >= 0 && ageDays < DECLINE_LOCK_DAYS) {
            const m = /\(([a-z_]+)\)/.exec(priorDecision);
            decision = 'decline';
            reason = (m && m[1]) || 'early';
            lockedByPriorDecline = true;
            console.log('Held to prior decline', { email, ageDays: Math.round(ageDays), reason });
          }
        }
      } catch (error) {
        // A lookup failure must not block a genuine lead — fail open.
        console.error('Prior-decline lookup failed', { error: kitErrorSummary(error) });
      }
    }

    const qualified = decision === 'book';
    const highRevenue = HIGH_REVENUE.has(data.revenue);

    const firstName = cleanString(data.first_name, 100);
    const source = cleanString(data.source, 120) || 'direct';
    const goal = cleanString(data.goal, 1000);

    // Test submissions never touch Kit — decide, report, and stop.
    if (isTest) {
      console.log('Qualifier TEST submission (no Kit write)', {
        email, source: cleanString(data.source, 120), decision, reason, trustedTest,
      });
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, test: true, kit: 'skipped', decision, reason }),
      };
    }

    const tagIds = [TAG_SUBMITTED, qualified ? TAG_QUALIFIED : TAG_DECLINED];
    if (highRevenue) tagIds.push(TAG_HIGH_REV);
    if (!qualified) tagIds.push(TAG_LAUNCHPAD_DOWNSELL);

    const submission = {
      email,
      firstName,
      tagIds,
      // Preserved (set only when blank): original attribution, plus booked so a
      // retake never resets an already-booked lead back to "No".
      mappedFields: {
        ...cleanMappedFieldValues(data),
        qualify_booked: 'No',
      },
      // Always take the latest submission's answers.
      overwriteFields: {
        qualify_revenue: REVENUE[data.revenue],
        qualify_fulltime: FULLTIME[data.fulltime],
        qualify_clients: CLIENTS[data.clients],
        qualify_source: source,
        qualify_decision: qualified ? 'Book' : `Decline (${reason})`,
        ...(lockedByPriorDecline ? { qualify_relocked: new Date().toISOString().slice(0, 10) } : {}),
        qualify_date: new Date().toISOString().slice(0, 10),
        ...(goal ? { qualify_goal: goal } : {}),
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
      console.error('Queued qualifier opt-in after transient Kit failure', {
        queueKey,
        email,
        error: kitErrorSummary(error),
      });
      // The lead still moves forward — the queue retries the Kit write.
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, queued: true, decision, reason }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        subscriberId: result.subscriberId,
        tagged: result.tagged,
        decision,
        reason,
      }),
    };
  } catch (error) {
    console.error('Function error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};

// Exposed for unit tests only; Netlify invokes .handler exclusively.
module.exports.__test = { decide, REVENUE, FULLTIME, CLIENTS, REVENUE_OK, HIGH_REVENUE };
