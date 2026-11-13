// Booking details for the post-booking page — /assessment-booked/
// Netlify Serverless Function
//
// The qualifier widget sends people to /assessment-booked/?e=<event>&i=<invitee>
// the moment Calendly reports a booking. Those are the two opaque ids from
// Calendly's own URIs, so no name or email ever sits in the page URL (where
// GTM, the Meta pixel and analytics would pick it up). This function swaps the
// ids for the handful of fields the page shows, server-side, with the same
// CALENDLY_PAT the qualifier's booked ping already uses.
//
// GET  ?e=&i=             → JSON { status, first_name, start, end, timezone,
//                                  join_url, reschedule_url, challenge }
// GET  ?e=&i=&format=ics  → the call as an .ics file (Apple Calendar, Outlook).
//                           Served from here rather than built in the browser
//                           because iOS only opens the add-to-calendar sheet
//                           for a real text/calendar response.
//
// Only Business Assessment bookings are returned, and only until the call is
// over, so an old link stops showing anything.

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const EVENT_NAME_MATCH = 'business assessment';
const GRACE_AFTER_END_MS = 60 * 60 * 1000;
const TITLE = 'Business Assessment Call with Jason Moss';
const MAX_RESCHEDULE_HOPS = 5;
const INVITEE_URI_RE = /^https:\/\/api\.calendly\.com\/scheduled_events\/([A-Za-z0-9-]{8,64})\/invitees\/([A-Za-z0-9-]{8,64})$/;

// Only Calendly's own invitee URIs are followed, so a crafted payload can't
// point this function anywhere else.
function parseInviteeUri(uri) {
  const m = INVITEE_URI_RE.exec(String(uri || ''));
  return m ? { e: m[1], i: m[2] } : null;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex',
};

function reply(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

async function calendly(path) {
  const r = await fetch(`https://api.calendly.com${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.CALENDLY_PAT}`,
      Accept: 'application/json',
      // Calendly sits behind Cloudflare, which rejects some default agents.
      'User-Agent': 'jasonmoss.com booking-details',
    },
    signal: AbortSignal.timeout(5000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Calendly ${path.split('/')[1]} lookup ${r.status}`);
  return (await r.json()).resource || null;
}

// Calendly's event uses the combined name format, so first_name is null and
// the first word of the full name is the best we have. Anything that does not
// look like a name (an email, a single letter) is dropped rather than shown.
function firstName(invitee) {
  const raw = String(invitee.first_name || invitee.name || '').trim().split(/\s+/)[0] || '';
  if (raw.length < 2 || raw.length > 30 || /[@\d<>]/.test(raw)) return '';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function icsEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// RFC 5545 lines must be folded at 75 octets.
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

function icsStamp(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function buildIcs(d, uid) {
  // Keep in step with details() on /assessment-booked/, which builds the same
  // description for the Google and Outlook web links: the Zoom link first,
  // then why the call is worth showing up for.
  const description = [
    d.join_url ? `Join on Zoom: ${d.join_url}` : 'Your Zoom link is in your confirmation email.',
    "20 minutes, just you and me. We'll look at where your business is right now: how clients find you, what's working, and where it's getting stuck.",
    "You'll walk away with a clear read on what's going on, and the one shift that would bring more clients in the door.",
    "Join from somewhere quiet.",
    "PS - this isn't a sales call. If I think I can help you on a deeper level, I'll let you know at the end. No pitch, no pressure.",
    d.reschedule_url ? `If something comes up, reschedule rather than skip: ${d.reschedule_url}` : '',
  ].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Jason Moss//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    // Name + refresh for the webcal:// subscription the page offers inside Instagram and
    // other in-app browsers (where a one-off calendar file can't reach Calendar).
    'X-WR-CALNAME:Call with Jason Moss',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
    'BEGIN:VEVENT',
    `UID:${uid}@jasonmoss.com`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(d.start)}`,
    `DTEND:${icsStamp(d.end)}`,
    `SUMMARY:${icsEscape(TITLE)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `LOCATION:${icsEscape(d.join_url || 'Zoom')}`,
    d.join_url ? `URL:${d.join_url}` : '',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(TITLE)}`,
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(fold).join('\r\n') + '\r\n';
}

function emptyIcs(){
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jason Moss//Booking//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Call with Jason Moss', 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

function icsReply(body){
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="call-with-jason-moss.ics"',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
    body,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return reply(405, { error: 'Method not allowed' });

  const q = event.queryStringParameters || {};
  const e = String(q.e || '');
  const i = String(q.i || '');
  // Preview sample for the page's ?preview=1 (no real booking behind it).
  if (q.format === 'ics' && q.preview === '1'){
    const start = new Date(Date.now() + 4 * 86400000); start.setUTCHours(16, 0, 0, 0);
    return icsReply(buildIcs({ start: start.toISOString(), end: new Date(start.getTime() + 20 * 60000).toISOString(),
      join_url: 'https://us02web.zoom.us/j/0000000000', reschedule_url: null }, 'preview'));
  }
  if (!ID_RE.test(e) || !ID_RE.test(i)) return reply(400, { error: 'Invalid booking reference' });
  if (!process.env.CALENDLY_PAT) return reply(503, { error: 'Unavailable' });

  let scheduled;
  let invitee;
  let currentInviteeId = i;
  try {
    [scheduled, invitee] = await Promise.all([
      calendly(`/scheduled_events/${e}`),
      calendly(`/scheduled_events/${e}/invitees/${i}`),
    ]);
    // A reschedule cancels the old booking and makes a new one, with the old
    // invitee pointing at it (new_invitee). Follow that chain so a link saved
    // before the reschedule (the "You're in" email, a bookmark) always shows
    // the current time instead of "canceled".
    for (let hop = 0; hop < MAX_RESCHEDULE_HOPS && invitee && invitee.rescheduled; hop++) {
      const next = parseInviteeUri(invitee.new_invitee);
      if (!next) break;
      const [nextScheduled, nextInvitee] = await Promise.all([
        calendly(`/scheduled_events/${next.e}`),
        calendly(`/scheduled_events/${next.e}/invitees/${next.i}`),
      ]);
      if (!nextScheduled || !nextInvitee) break;
      scheduled = nextScheduled;
      invitee = nextInvitee;
      currentInviteeId = next.i;
    }
  } catch (error) {
    console.error('booking-details lookup failed', { error: error.message });
    return reply(502, { error: 'Lookup failed' });
  }

  if (!scheduled || !invitee) return reply(404, { status: 'not_found' });
  if (!String(scheduled.name || '').toLowerCase().includes(EVENT_NAME_MATCH)) {
    return reply(404, { status: 'not_found' });
  }
  if (scheduled.status === 'canceled' || invitee.status === 'canceled') {
    // A subscribed calendar empties itself instead of keeping a cancelled call.
    return q.format === 'ics' ? icsReply(emptyIcs()) : reply(200, { status: 'canceled' });
  }
  if (Date.parse(scheduled.end_time) + GRACE_AFTER_END_MS < Date.now()) {
    return q.format === 'ics' ? icsReply(emptyIcs()) : reply(200, { status: 'past' });
  }

  const qa = Array.isArray(invitee.questions_and_answers) ? invitee.questions_and_answers : [];
  const location = scheduled.location || {};
  const details = {
    status: 'active',
    first_name: firstName(invitee),
    start: scheduled.start_time,
    end: scheduled.end_time,
    timezone: invitee.timezone || null,
    join_url: /^https:\/\/[\w.-]*zoom\.us\//.test(location.join_url || '') ? location.join_url : null,
    reschedule_url: /^https:\/\/calendly\.com\//.test(invitee.reschedule_url || '') ? invitee.reschedule_url : null,
    challenge: String((qa[0] || {}).answer || '').trim().slice(0, 600),
    // Only whether they gave a text number (never the number): the page says
    // "I'll text you" or "I'll email you" to match what will really happen.
    has_phone: Boolean(String(invitee.text_reminder_number || '').trim()),
    // When they booked (the current booking, after any reschedule): the page only promises
    // "I'll text you personally" in the first hours, not to someone returning days later.
    booked_at: invitee.created_at || null,
  };

  if (q.format === 'ics') {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="call-with-jason-moss.ics"',
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex',
      },
      body: buildIcs(details, currentInviteeId),
    };
  }

  return reply(200, details);
};

module.exports.__internal = { buildIcs, firstName, fold, parseInviteeUri };
