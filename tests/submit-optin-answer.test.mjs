// Tests the two-step opt-in answer flow: submit-contact issues an answer_pass,
// and submit-optin-answer only accepts a valid, unexpired pass for the same
// email, a known answer code, and one of our origins. Kit is faked.
// Run: node tests/submit-optin-answer.test.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
delete process.env.TURNSTILE_SECRET_KEY;
process.env.KIT_API_KEY = 'test-key';
process.env.ROEZAN_PASS_SECRET = 'test-pass-secret';
const contact = require('../netlify/functions/submit-contact.js');
const answer = require('../netlify/functions/submit-optin-answer.js');
const { issueAnswerPass, issueRoezanPass } = contact.__internal;

let failures = 0;
function check(name, cond, extra) {
  if (!cond) { failures++; console.error('FAIL:', name, extra ?? ''); }
  else console.log('ok:', name);
}

let writes = [];
let subscriberExists = true;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.includes('/v4/subscribers?') && method === 'GET') {
    return json(200, { subscribers: subscriberExists ? [{ id: 42, email_address: 'sarah.test@example.org', state: 'active', fields: {} }] : [] });
  }
  if (/\/v4\/subscribers(\/\d+)?$/.test(u) && (method === 'POST' || method === 'PUT')) {
    writes.push({ method, url: u, body: JSON.parse(opts.body || '{}') });
    return json(201, { subscriber: { id: 42, state: 'active' } });
  }
  if (u.includes('/tags/') && method === 'POST') return json(201, { subscriber: { id: 42, state: 'active' } });
  return json(200, {});
};
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const ORIGIN = { origin: 'https://jasonmoss.com', referer: 'https://jasonmoss.com/resonance-masterclass-optin/' };

// 1) submit-contact returns an answer_pass for a successful opt-in.
{
  const res = await quiet(() => contact.handler({ httpMethod: 'POST', headers: ORIGIN,
    body: JSON.stringify({ email: 'sarah.test@example.org', first_name: 'Sarah', tag_id: 20410092, website: '' }) }));
  const body = JSON.parse(res.body);
  check('opt-in succeeds', res.statusCode === 200 && body.success === true, res.body);
  check('opt-in returns answer_pass', typeof body.answer_pass === 'string' && /^\d+\.[a-f0-9]{64}$/.test(body.answer_pass), res.body);
}

const post = (body, headers = ORIGIN) => quiet(() => answer.handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) }));
const goodPass = issueAnswerPass('sarah.test@example.org');

// 2) Valid answers save the label to optin_revenue, and only that field.
for (const [code, label] of Object.entries({ 'under-1k': 'Under $1K/mo', '1k-10k': '$1K-$10K/mo', '10k-plus': '$10K+/mo' })) {
  writes = [];
  const res = await post({ email: 'sarah.test@example.org', optin_revenue: code, answer_pass: goodPass });
  check(`${code}: 200 saved`, res.statusCode === 200 && JSON.parse(res.body).saved === true, res.body);
  const w = writes[0];
  check(`${code}: PUT on existing subscriber only`, writes.length === 1 && w.method === 'PUT' && /\/v4\/subscribers\/42$/.test(w.url), JSON.stringify(writes));
  check(`${code}: writes only optin_revenue = "${label}"`, w && JSON.stringify(w.body.fields) === JSON.stringify({ optin_revenue: label }), JSON.stringify(w && w.body));
}

// 3) Rejections.
writes = [];
const r1 = await post({ email: 'other@example.org', optin_revenue: '1k-10k', answer_pass: goodPass });
check('pass for a different email -> 403', r1.statusCode === 403, r1.body);
const r2 = await post({ email: 'sarah.test@example.org', optin_revenue: '1k-10k', answer_pass: '123.' + 'a'.repeat(64) });
check('forged pass -> 403', r2.statusCode === 403, r2.body);
const old = `${Date.now() - 2 * 60 * 60 * 1000}.${goodPass.split('.')[1]}`;
const r3 = await post({ email: 'sarah.test@example.org', optin_revenue: '1k-10k', answer_pass: old });
check('expired / tampered timestamp -> 403', r3.statusCode === 403, r3.body);
const r4 = await post({ email: 'sarah.test@example.org', optin_revenue: 'a-million', answer_pass: goodPass });
check('unknown answer code -> 400', r4.statusCode === 400, r4.body);
const r5 = await post({ email: 'sarah.test@example.org', optin_revenue: '1k-10k', answer_pass: goodPass }, { origin: 'https://evil.example', referer: 'https://evil.example/' });
check('foreign origin -> 403', r5.statusCode === 403, r5.body);
const roezan = issueRoezanPass('sarah.test@example.org', '');
const r6 = await post({ email: 'sarah.test@example.org', optin_revenue: '1k-10k', answer_pass: roezan });
check('a roezan_pass is not accepted as an answer_pass', r6.statusCode === 403, r6.body);
check('no Kit writes from any rejected request', writes.length === 0, JSON.stringify(writes));

// 4) Subscriber not in Kit yet (queued opt-in): no write, soft 200.
subscriberExists = false; writes = [];
const r7 = await post({ email: 'sarah.test@example.org', optin_revenue: '1k-10k', answer_pass: goodPass });
check('missing subscriber -> 200 saved:false, no create', r7.statusCode === 200 && JSON.parse(r7.body).saved === false && writes.length === 0, r7.body);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall submit-optin-answer checks passed');
