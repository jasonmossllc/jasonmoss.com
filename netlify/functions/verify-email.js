// ZeroBounce Email Verification
// Netlify Serverless Function
//
// Environment variables required (set in Netlify dashboard):
//   ZB_API_KEY  - your ZeroBounce API key
//
// Called on form submit to validate email in real-time.
// Returns { valid: true/false, reason: string, did_you_mean: string|null }
//
// Block policy (minimal, low false-positive):
//   BLOCK:  status "invalid" — mailbox does not exist
//   BLOCK:  sub_status "disposable" or "toxic" — throwaway/harmful addresses
//   ACCEPT: everything else (valid, catch-all, unknown, spamtrap, abuse,
//           role_based, mailbox_not_found, etc.)
//
// Rationale: on opt-in pages, the priority is not losing real leads.
// Spamtrap/abuse are vanishingly rare on voluntary opt-ins and ZB's
// classification isn't perfect — better to let AC handle edge cases
// through normal list hygiene than to false-positive a real person.

const HARD_BLOCK_SUB_STATUSES = new Set(['disposable', 'toxic']);

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const data = JSON.parse(event.body);

    if (!data.email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ valid: false, reason: 'Email is required', did_you_mean: null }),
      };
    }

    // Quick format check before burning an API call
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          valid: false,
          reason: 'Please enter a valid email address.',
          did_you_mean: null,
        }),
      };
    }

    // Call ZeroBounce API
    const apiKey = process.env.ZB_API_KEY;
    if (!apiKey) {
      console.error('ZB_API_KEY environment variable not set');
      // Fail open — don't block form submissions if ZeroBounce isn't configured
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ valid: true, reason: '', did_you_mean: null }),
      };
    }

    const zbUrl = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(data.email)}&ip_address=`;

    const zbResponse = await fetch(zbUrl);

    if (!zbResponse.ok) {
      console.error('ZeroBounce API error:', zbResponse.status, await zbResponse.text());
      // Fail open — don't block users if ZeroBounce is down
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ valid: true, reason: '', did_you_mean: null }),
      };
    }

    const result = await zbResponse.json();

    // Decision logic
    const isInvalid = result.status === 'invalid';
    const isHardBlockSub = HARD_BLOCK_SUB_STATUSES.has(result.sub_status);
    const isBlocked = isInvalid || isHardBlockSub;

    let reason = '';
    if (isBlocked) {
      if (isInvalid) {
        reason = 'This email address doesn\u2019t appear to exist. Please check for typos and try again.';
      } else {
        // disposable or toxic
        reason = 'Please enter a real, non-temporary email address.';
      }
    }

    // Pass through did_you_mean for typo correction (e.g. gmial.com → gmail.com)
    const didYouMean = result.did_you_mean || null;

    // Log for debugging (visible in Netlify function logs)
    console.log(
      `Email verification: ${data.email} → ${result.status}/${result.sub_status || 'none'} → ${isBlocked ? 'BLOCK' : 'ACCEPT'}${didYouMean ? ` (suggest: ${didYouMean})` : ''}`
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        valid: !isBlocked,
        reason,
        did_you_mean: didYouMean,
      }),
    };
  } catch (error) {
    console.error('Function error:', error);
    // Fail open
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ valid: true, reason: '', did_you_mean: null }),
    };
  }
};
