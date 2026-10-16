// Tests the opt-in revenue question end to end through the real handler, with
// Kit faked: each code must land in the Kit "optin_revenue" field as its label,
// and a missing or unknown value must never block the opt-in.
// Run: node tests/submit-contact-optin-revenue.test.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
delete process.env.TURNSTILE_SECRET_KEY; // Turnstile dormant for these tests
process.env.KIT_API_KEY = 'test-key';
const fn = require('../netlify/functions/submit-contact.js');
const { OPTIN_REVENUE, KIT_OPTIN_REVENUE_FIELD } = fn.__test;

let failures = 0;
function check(name, cond, extra) {
  if (!cond) { failures++; console.error('FAIL:', name, extra ?? ''); }
  else console.log('ok:', name);
}

// Fake Kit: records every subscriber create/update body.
let writes = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.includes('/v4/subscribers') && method === 'GET') return json(200, { subscribers: [] });
  if (/\/v4\/subscribers(\/\d+)?$/.test(u) && (method === 'POST' || method === 'PUT')) {
    writes.push(JSON.parse(opts.body || '{}'));
    return json(201, { subscriber: { id: 42, state: 'active', email_address: 'x@example.org' } });
  }
  if (u.includes('/tags/') && method === 'POST') return json(201, { subscriber: { id: 42, state: 'active' } });
  return json(200, {});
};

async function submit(extra) {
  writes = [];
  const event = {
    httpMethod: 'POST',
    headers: { origin: 'https://jasonmoss.com', referer: 'https://jasonmoss.com/resonance-masterclass-optin/' },
    body: JSON.stringify({ email: 'sarah.test@example.org', first_name: 'Sarah', tag_id: 20410092, website: '', ...extra }),
  };
  const log = console.log; console.log = () => {};
  try { return await fn.handler(event); } finally { console.log = log; }
}
const fieldsWritten = () => Object.assign({}, ...writes.map((w) => w.fields || {}));

for (const [code, label] of Object.entries(OPTIN_REVENUE)) {
  const res = await submit({ optin_revenue: code, latest_ad: '201' });
  check(`${code}: opt-in succeeds`, res.statusCode === 200, res.body);
  check(`${code}: Kit ${KIT_OPTIN_REVENUE_FIELD} = "${label}"`, fieldsWritten()[KIT_OPTIN_REVENUE_FIELD] === label, JSON.stringify(writes));
  check(`${code}: attribution still written`, fieldsWritten().original_ad === '201', JSON.stringify(writes));
}

{
  const res = await submit({ optin_revenue: 'a-million' });
  check('unknown code: opt-in still succeeds', res.statusCode === 200, res.body);
  check('unknown code: nothing written to the field', !(KIT_OPTIN_REVENUE_FIELD in fieldsWritten()), JSON.stringify(writes));
}
{
  const res = await submit({});
  check('no answer (other pages): opt-in succeeds', res.statusCode === 200, res.body);
  check('no answer: field untouched', !(KIT_OPTIN_REVENUE_FIELD in fieldsWritten()), JSON.stringify(writes));
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall optin_revenue checks passed');
