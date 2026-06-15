// ActiveCampaign Contact Submission
// Netlify Serverless Function
//
// Environment variables required (set in Netlify dashboard):
//   AC_API_URL            - e.g. https://jasonmoss.api-us1.com
//   AC_API_KEY            - your ActiveCampaign API key
//   TURNSTILE_SECRET_KEY  - Cloudflare Turnstile SECRET key (optional).
//                           When set, every submission MUST carry a valid
//                           Turnstile token or it is rejected. Leave it unset
//                           and Turnstile is dormant (the other guards still run).
//
// ── BOT PROTECTION ─────────────────────────────────────────────────────────
// This endpoint is public, so it is the real gate against opt-in spam. Layered:
//   1. Honeypot field ("website")     — silently drop if a bot fills it.
//   2. Origin/Referer allowlist       — must come from a jasonmoss.com page.
//   3. Email + first-name validation  — reject malformed / gibberish junk.
//   4. Cloudflare Turnstile           — verify the token server-side (primary).
// Client-side checks alone are bypassable (bots POST straight to this URL),
// so all of these run here, server-side, regardless of the page.
//
// Custom field IDs (from ActiveCampaign):
const CUSTOM_FIELDS = {
  latest_ad: '18',     // Latest Ad (Field ID 18)
  latest_source: '15', // Latest Source (Field ID 15)
  signed_clients: '102', // Signed Clients (Field ID 102)
  referred_by: '103', // Referred By (Field ID 103)
  // Add more custom fields as needed
};

// Hosts allowed to submit. Covers the live domain, subdomains (go./www.),
// and Netlify deploy previews (*.netlify.app).
function originAllowed(event) {
  const h = event.headers || {};
  const candidates = [h.origin, h.referer, h.referrer].filter(Boolean);
  if (candidates.length === 0) return false; // no Origin/Referer = direct (bot) call
  const hostOf = (u) => {
    try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; }
  };
  return candidates.some((u) => {
    const host = hostOf(u);
    return (
      host === 'jasonmoss.com' ||
      host.endsWith('.jasonmoss.com') ||
      host.endsWith('.netlify.app')
    );
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function maxConsonantRun(s) {
  const isVowel = (c) => 'aeiou'.includes(c.toLowerCase());
  let run = 0, best = 0;
  for (const c of s) {
    if (/[a-z]/i.test(c) && !isVowel(c)) { run += 1; best = Math.max(best, run); }
    else run = 0;
  }
  return best;
}

// Conservative gibberish detector — tuned to flag bot-generated names like
// "JmFxjgpwvybohvkahuDSd" while never touching real names (incl. "Jean-Luc",
// "O'Brien", "JohnPaulJones", non-Latin scripts, hyphenated/spaced names).
function looksLikeBotName(raw) {
  const n = (raw || '').trim();
  if (!n) return false;
  if (n.length > 40) return true;                              // absurd length
  if (/https?:\/\/|www\.|\.(com|net|org|ru|info)\b|[<>{}\[\]]/i.test(n)) return true; // urls/markup
  if ((n.match(/\d/g) || []).length >= 4) return true;        // digit-heavy
  if (/\s/.test(n)) return false;                              // has space -> treat as real
  // Only ASCII single tokens can be the random-string pattern; leave others alone.
  if (!/^[A-Za-z'’.\-]+$/.test(n)) return false;
  const letters = n.replace(/[^A-Za-z]/g, '');
  if (letters.length < 12) return false;
  const caps = (letters.match(/[A-Z]/g) || []).length;
  const internalCaps = (letters.slice(1).match(/[A-Z]/g) || []).length;
  const hasLower = /[a-z]/.test(letters);
  if (!hasLower || caps < 3 || internalCaps < 2) return false; // needs scattered mixed case
  const vowels = (letters.match(/[aeiou]/gi) || []).length;
  const vowelRatio = vowels / letters.length;
  return maxConsonantRun(letters) >= 4 || vowelRatio < 0.30;   // unpronounceable
}

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { enforced: false, ok: true };           // dormant
  if (!token) return { enforced: true, ok: false };
  try {
    const form = new URLSearchParams();
    form.append('secret', secret);
    form.append('response', token);
    if (ip) form.append('remoteip', ip);
    const r = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', body: form }
    );
    const out = await r.json();
    return { enforced: true, ok: !!out.success, data: out };
  } catch (e) {
    console.error('Turnstile verify error:', e);
    return { enforced: true, ok: false };                      // fail closed when enforcing
  }
}

exports.handler = async (event) => {
  // Only allow POST
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

  // CORS headers — locked to the live domain (calls are same-origin anyway).
  const headers = {
    'Access-Control-Allow-Origin': 'https://jasonmoss.com',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  try {
    const data = JSON.parse(event.body || '{}');
    const ip =
      event.headers['x-nf-client-connection-ip'] ||
      event.headers['client-ip'] ||
      (event.headers['x-forwarded-for'] || '').split(',')[0].trim();

    // 1) Honeypot — a real user never fills the hidden "website" field.
    //    Return a fake success so bots don't learn they were blocked.
    if (data.website) {
      console.log('Blocked: honeypot filled', { ip });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // 2) Origin/Referer must be a jasonmoss.com page.
    if (!originAllowed(event)) {
      console.log('Blocked: origin not allowed', {
        ip, origin: event.headers.origin, referer: event.headers.referer,
      });
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    // 3) Email required + well-formed.
    if (!data.email || !EMAIL_RE.test(String(data.email).trim())) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid email is required' }) };
    }

    // 4) Reject gibberish first names (bot-generated random strings).
    if (looksLikeBotName(data.first_name)) {
      console.log('Blocked: bot-like first name', { ip, first_name: data.first_name });
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid name' }) };
    }

    // 5) Cloudflare Turnstile — the primary gate (when configured).
    const ts = await verifyTurnstile(data.turnstile_token, ip);
    if (ts.enforced && !ts.ok) {
      console.log('Blocked: Turnstile failed', { ip });
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Verification failed' }) };
    }

    // ── Passed all checks — create/update the contact in ActiveCampaign ──────
    const contact = {
      email: String(data.email).trim(),
    };

    if (data.first_name) contact.firstName = String(data.first_name).trim();
    if (data.last_name) contact.lastName = String(data.last_name).trim();
    if (data.phone) contact.phone = data.phone;

    // Build custom field values
    const fieldValues = [];
    const signedClients = data.signed_clients || data.signed_paying_clients;
    const referredBy = data.referred_by || data.referredBy;

    if (data.latest_ad && CUSTOM_FIELDS.latest_ad !== 'FIELD_ID_HERE') {
      fieldValues.push({ field: CUSTOM_FIELDS.latest_ad, value: data.latest_ad });
    }

    if (data.latest_source && CUSTOM_FIELDS.latest_source !== 'FIELD_ID_HERE') {
      fieldValues.push({ field: CUSTOM_FIELDS.latest_source, value: data.latest_source });
    }

    if (signedClients && CUSTOM_FIELDS.signed_clients !== 'FIELD_ID_HERE') {
      fieldValues.push({ field: CUSTOM_FIELDS.signed_clients, value: signedClients });
    }

    if (referredBy && CUSTOM_FIELDS.referred_by !== 'FIELD_ID_HERE') {
      fieldValues.push({ field: CUSTOM_FIELDS.referred_by, value: referredBy });
    }

    if (fieldValues.length > 0) {
      contact.fieldValues = fieldValues;
    }

    // Step 1: Create or update the contact
    const contactResponse = await fetch(`${process.env.AC_API_URL}/api/3/contact/sync`, {
      method: 'POST',
      headers: {
        'Api-Token': process.env.AC_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contact }),
    });

    if (!contactResponse.ok) {
      const errorText = await contactResponse.text();
      console.error('ActiveCampaign contact sync failed:', errorText);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to create contact' }),
      };
    }

    const contactResult = await contactResponse.json();
    const contactId = contactResult.contact.id;

    // Step 2: Subscribe contact to Main List (List ID 1)
    const listResponse = await fetch(`${process.env.AC_API_URL}/api/3/contactLists`, {
      method: 'POST',
      headers: {
        'Api-Token': process.env.AC_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contactList: { list: 1, contact: contactId, status: 1 },
      }),
    });

    if (!listResponse.ok) {
      const errorText = await listResponse.text();
      console.error('ActiveCampaign list subscription failed:', errorText);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to subscribe contact to list' }),
      };
    }

    // Step 3: Apply tag if provided (capped + sanitized)
    const tag = typeof data.tag === 'string' ? data.tag.trim().slice(0, 80) : '';
    if (tag) {
      // First, find or create the tag
      const tagSearchResponse = await fetch(
        `${process.env.AC_API_URL}/api/3/tags?search=${encodeURIComponent(tag)}`,
        {
          headers: { 'Api-Token': process.env.AC_API_KEY },
        }
      );

      let tagId;
      const tagSearchResult = await tagSearchResponse.json();

      if (tagSearchResult.tags && tagSearchResult.tags.length > 0) {
        // Tag exists — find exact match
        const exactMatch = tagSearchResult.tags.find(
          (t) => t.tag.toLowerCase() === tag.toLowerCase()
        );
        tagId = exactMatch ? exactMatch.id : tagSearchResult.tags[0].id;
      } else {
        // Tag doesn't exist — create it
        const createTagResponse = await fetch(`${process.env.AC_API_URL}/api/3/tags`, {
          method: 'POST',
          headers: {
            'Api-Token': process.env.AC_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tag: { tag: tag, tagType: 'contact', description: '' },
          }),
        });
        const createTagResult = await createTagResponse.json();
        tagId = createTagResult.tag.id;
      }

      // Apply the tag to the contact
      await fetch(`${process.env.AC_API_URL}/api/3/contactTags`, {
        method: 'POST',
        headers: {
          'Api-Token': process.env.AC_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contactTag: { contact: contactId, tag: tagId },
        }),
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, contactId }),
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
module.exports.__test = { looksLikeBotName, maxConsonantRun, originAllowed, EMAIL_RE };
