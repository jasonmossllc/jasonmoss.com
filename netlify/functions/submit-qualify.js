// Call Qualifier widget — /qualify/
// Netlify Serverless Function
//
// Receives the qualifier's three gating answers (revenue band, full-time,
// current clients), validates them server-side and decides book-vs-decline.
//
// The two paths reach Kit differently. Declined people give us their details
// in the widget, which is how they enter the Launchpad downsell. Qualified
// people go straight to the Calendly embed without typing anything twice, so
// their record is written from Calendly's own invitee data once they book.
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
  corsHeaders,
} = __internal;

// Kit tags. The flow only produces two kinds of record — someone who booked,
// and someone who was declined — so those are the only tags it sets.
const TAG_BOOKED = 22754514;   // "Qualifier Booked"
const TAG_DECLINED = 22754515; // "Qualifier Declined"
const TAG_LAUNCHPAD_DOWNSELL = 20410106; // existing downsell tag

// Kit sequence "Launchpad Downsell (Qualifier)" — 5 emails over 7 days for
// everyone we decline. Its emails stay unpublished until Jason approves them,
// so enrolling someone here sends nothing before then.
const DOWNSELL_SEQUENCE_ID = 2872972;

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

/**
 * Look up who booked, straight from Calendly. The booking path never asks for
 * an email in the widget, so this is where the identity comes from.
 */
async function fetchCalendlyInvitee(uri) {
  const pat = process.env.CALENDLY_PAT;
  if (!pat || !/^https:\/\/api\.calendly\.com\/scheduled_events\/[\w-]+\/invitees\/[\w-]+$/.test(uri)) {
    return null;
  }
  const r = await fetch(uri, {
    headers: { Authorization: `Bearer ${pat}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`Calendly invitee lookup ${r.status}`);
  const res = (await r.json()).resource || {};
  // The event has one invitee question, so take its answer rather than
  // matching on wording — the label can be reworded without breaking this.
  const qa = Array.isArray(res.questions_and_answers) ? res.questions_and_answers : [];
  const goal = (qa[0] || {}).answer || '';
  return { email: res.email, name: res.name, goal: String(goal).slice(0, 1000) };
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

    // ── Booking confirmed in the embedded Calendly ─────────────────────────
    // Qualified people never gave us an email here, so Calendly's invitee URI
    // is how we find out who booked.
    if (data.action === 'booked') {
      if (cleanString(data.test, 200)) {
        console.log('Qualifier TEST booked ping (no Kit write)', { uri: data.invitee_uri });
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, test: true }) };
      }
      // Declared outside the try so the catch can hand it to the retry queue.
      let bookedSubmission = null;
      try {
        const invitee = await fetchCalendlyInvitee(cleanString(data.invitee_uri, 300));
        // Identity comes from Calendly only. Accepting a caller-supplied
        // address here would let anyone tag an arbitrary subscriber as booked.
        const bookedEmail = (invitee?.email || '').trim().toLowerCase();
        if (!bookedEmail || !EMAIL_RE.test(bookedEmail)) {
          console.error('Booked ping without a usable email', { uri: data.invitee_uri });
          return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
        }
        const answers = {};
        if (REVENUE[data.revenue]) answers.qualify_revenue = REVENUE[data.revenue];
        if (FULLTIME[data.fulltime]) answers.qualify_fulltime = FULLTIME[data.fulltime];
        if (CLIENTS[data.clients]) answers.qualify_clients = CLIENTS[data.clients];
        bookedSubmission = {
          email: bookedEmail,
          firstName: cleanString((invitee?.name || '').split(' ')[0], 100),
          tagIds: [TAG_BOOKED],
          mappedFields: {},
          overwriteFields: {
            ...answers,
            qualify_source: cleanString(data.source, 120) || 'direct',
            qualify_decision: 'Book',
            qualify_date: new Date().toISOString().slice(0, 10),
            qualify_booked: 'Yes',
            ...(invitee?.goal ? { qualify_goal: invitee.goal } : {}),
          },
          referrer: cleanString(headerValue(event.headers, 'referer'), 1000),
        };
        await syncContactToKit(bookedSubmission);
      } catch (error) {
        if (isQueueableKitError(error) && bookedSubmission) {
          try {
            const queueKey = await enqueueOptin(bookedSubmission, error);
            console.error('Queued Calendly booking after transient Kit failure', {
              queueKey, error: kitErrorSummary(error),
            });
          } catch (queueError) {
            console.error('Failed to queue Calendly booking', { error: kitErrorSummary(queueError) });
          }
        } else {
          console.error('Failed to record Calendly booking', { error: kitErrorSummary(error) });
        }
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    if (!data.email || !EMAIL_RE.test(String(data.email).trim())) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid email is required' }) };
    }
    const email = String(data.email).trim().toLowerCase();

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
    // answer this time.
    //
    // Scope, honestly: this only fires for a submission that reaches the server
    // with a qualifying answer set, and the widget never POSTs on the book path
    // (it renders Calendly straight from the client-side decision). So today
    // this is defence in depth against a changed client, not the live gate the
    // flow relies on. It could not be airtight regardless - the Calendly event
    // URL is publicly bookable on its own.
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

    const firstName = cleanString(data.first_name, 100);
    const source = cleanString(data.source, 120) || 'direct';

    // Test submissions never touch Kit — decide, report, and stop.
    //
    // Exception: `kit:"1"` alongside a VALID QUALIFY_TEST_KEY runs the real Kit
    // write, so the sync and sequence enrollment can actually be exercised
    // before launch. It needs the same secret that bypasses Turnstile, so it is
    // no weaker than that; ?test=1 alone can never reach Kit.
    const testWritesToKit = trustedTest && String(data.kit || '') === '1';
    if (isTest && !testWritesToKit) {
      console.log('Qualifier TEST submission (no Kit write)', {
        email, source: cleanString(data.source, 120), decision, reason, trustedTest,
      });
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, test: true, kit: 'skipped', decision, reason }),
      };
    }

    const tagIds = qualified ? [TAG_BOOKED] : [TAG_DECLINED, TAG_LAUNCHPAD_DOWNSELL];

    const submission = {
      email,
      firstName,
      tagIds,
      ...(qualified ? {} : { sequenceId: DOWNSELL_SEQUENCE_ID }),
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
        ...(isTest ? { qualify_decision: `TEST — ${qualified ? 'Book' : `Decline (${reason})`}` } : {}),
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
module.exports.__test = { decide, REVENUE, FULLTIME, CLIENTS, REVENUE_OK };
