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
    '20 minutes, just you and me.',
    "We'll look at where your business really is right now... how clients find you, what's working, and where it's getting stuck.",
    "You'll walk away with:\n- A clear read on what's really going on, and why\n- The one thing that, if you shifted it, would be your fastest path to bring more clients in the door\n- A direction you can start moving towards right away, whether we work together on a deeper level or not",
    'To get the most out of it:\n- Join from somewhere quiet, with your camera on\n- Be there a minute or two early. Twenty minutes goes quickly.\n- Know your rough monthly revenue, and where your clients come from',
    d.reschedule_url ? `If something comes up, reschedule rather than skip: ${d.reschedule_url}` : '',
    'Talk soon,\nJason',
  ].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Jason Moss//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return reply(405, { error: 'Method not allowed' });

  const q = event.queryStringParameters || {};
  const e = String(q.e || '');
  const i = String(q.i || '');
  if (!ID_RE.test(e) || !ID_RE.test(i)) return reply(400, { error: 'Invalid booking reference' });
  if (!process.env.CALENDLY_PAT) return reply(503, { error: 'Unavailable' });

  let scheduled;
  let invitee;
  try {
    [scheduled, invitee] = await Promise.all([
      calendly(`/scheduled_events/${e}`),
      calendly(`/scheduled_events/${e}/invitees/${i}`),
    ]);
  } catch (error) {
    console.error('booking-details lookup failed', { error: error.message });
    return reply(502, { error: 'Lookup failed' });
  }

  if (!scheduled || !invitee) return reply(404, { status: 'not_found' });
  if (!String(scheduled.name || '').toLowerCase().includes(EVENT_NAME_MATCH)) {
    return reply(404, { status: 'not_found' });
  }
  if (scheduled.status === 'canceled' || invitee.status === 'canceled') {
    return reply(200, { status: 'canceled' });
  }
  if (Date.parse(scheduled.end_time) + GRACE_AFTER_END_MS < Date.now()) {
    return reply(200, { status: 'past' });
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
      body: buildIcs(details, i),
    };
  }

  return reply(200, details);
};

module.exports.__internal = { buildIcs, firstName, fold };
