// ZeroBounce Email Verification
// Netlify Serverless Function
//
// Environment variables required (set in Netlify dashboard):
//   ZB_API_KEY  - your ZeroBounce API key
//
// Called on form submit to validate email in real-time.
// Returns { valid: true/false, reason: string }
//
// ZeroBounce statuses:
//   valid      → accept
//   catch-all  → accept (real mailbox, just can't confirm individual)
//   unknown    → accept (temporary DNS issue, don't block real users)
//   invalid    → reject
//   spamtrap   → reject
//   abuse      → reject
//   do_not_mail → reject (includes role-based, disposable, etc.)

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
        body: JSON.stringify({ valid: false, reason: 'Email is required' }),
      };
    }

    // Quick client-side format check (belt & suspenders)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          valid: false,
          reason: 'Please enter a valid email address.',
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
        body: JSON.stringify({ valid: true, reason: 'Verification unavailable' }),
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
        body: JSON.stringify({ valid: true, reason: 'Verification temporarily unavailable' }),
      };
    }

    const result = await zbResponse.json();

    // Determine accept/reject based on status
    const acceptStatuses = ['valid', 'catch-all', 'unknown'];
    const isValid = acceptStatuses.includes(result.status);

    // Build user-friendly rejection reason
    let reason = '';
    if (!isValid) {
      switch (result.status) {
        case 'invalid':
          reason = 'This email address does not exist. Please check for typos and try again.';
          break;
        case 'spamtrap':
        case 'abuse':
          reason = 'This email address cannot be used. Please enter a different email.';
          break;
        case 'do_not_mail':
          if (result.sub_status === 'disposable') {
            reason = 'Disposable email addresses are not allowed. Please use your real email.';
          } else if (result.sub_status === 'role_based') {
            reason = 'Role-based emails (info@, support@, etc.) are not allowed. Please use a personal email.';
          } else {
            reason = 'This email address cannot receive mail. Please enter a different email.';
          }
          break;
        default:
          reason = 'We could not verify this email. Please check and try again.';
      }
    }

    // Log for debugging (visible in Netlify function logs)
    console.log(`Email verification: ${data.email} → ${result.status} (${result.sub_status || 'none'}) → ${isValid ? 'ACCEPT' : 'REJECT'}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        valid: isValid,
        reason,
        // Include status for debugging (not shown to end user)
        _debug: {
          status: result.status,
          sub_status: result.sub_status || null,
          did_you_mean: result.did_you_mean || null,
        },
      }),
    };
  } catch (error) {
    console.error('Function error:', error);
    // Fail open
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ valid: true, reason: 'Verification error' }),
    };
  }
};
