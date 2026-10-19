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
// In-memory stand-in for Netlify Blobs so queued opt-ins really run here.
const queued = new Map();
contact.__test.setBlobStoreOverride(() => ({
  async setJSON(key, value) { queued.set(key, value); return { modified: true }; },
  async get(key) { return queued.has(key) ? queued.get(key) : null; },
  async list() { return { blobs: [...queued.keys()].map((key) => ({ key })) }; },
  async delete(key) { queued.delete(key); },
}));

let failures = 0;
function check(name, cond, extra) {
  if (!cond) { failures++; console.error('FAIL:', name, extra ?? ''); }
  else console.log('ok:', name);
}

let writes = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.includes('/v4/subscribers?') && method === 'GET') {
    return json(200, { subscribers: [{ id: 42, email_address: 'sarah.test@example.org', state: 'active', fields: {} }] });
  }
  if (/\/v4\/subscribers(\/\d+)?$/.test(u) && (method === 'POST' || method === 'PUT')) {
    writes.push({ method, url: u, body: JSON.parse(opts.body || '{}') });
    return json(201, { subscriber: { id: 42, state: 'active' } });
  }
  if (u.includes('/tags/') && method === 'POST') return json(201, { subscriber: { id: 42, state: 'active' } });
  return json(200, {});
};
const quiet = async (fn) => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
const ORIGIN = { origin: 'https://jasonmoss.com', referer: 'https://jasonmoss.com/resonance-masterclass-optin/' };

// 1) submit-contact returns an answer_pass for a successful opt-in.
{
  const res = await quiet(() => contact.handler({ httpMethod: 'POST', headers: ORIGIN,
    body: JSON.stringify({ email: 'sarah.test@example.org', first_name: 'Sarah', tag_id: 20410092, website: '' }) }));
  const body = JSON.parse(res.body);
  check('opt-in succeeds', res.statusCode === 200 && body.success === true, res.body);
  check('opt-in returns answer_pass bound to the Kit id', typeof body.answer_pass === 'string' && /^\d+\.42\.[a-f0-9]{64}$/.test(body.answer_pass), res.body);
}

const post = (body, headers = ORIGIN) => quiet(() => answer.handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) }));
const goodPass = issueAnswerPass('sarah.test@example.org', 42);

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
const parts = goodPass.split('.');
const old = `${Date.now() - 25 * 60 * 60 * 1000}.${parts[1]}.${parts[2]}`;
const r3 = await post({ email: 'sarah.test@example.org', optin_revenue: '1k-10k', answer_pass: old });
check('expired (25 h) / tampered timestamp -> 403', r3.statusCode === 403, r3.body);
{
  const saved = writes; writes = [];
  const realNow = Date.now;
  Date.now = () => realNow() - 2 * 60 * 60 * 1000; // issue the pass 2h ago
  const twoHoursOld = issueAnswerPass('sarah.test@example.org', 42);
  Date.now = realNow;
  const r3c = await post({ email: 'sarah.test@example.org', optin_revenue: '1k-10k', answer_pass: twoHoursOld });
  check('a 2-hour-old pass still saves (24h TTL; visitor may sit on the question)', r3c.statusCode === 200, r3c.body);
  writes = saved; // this one was a valid write; keep the rejected-requests check clean
}
const swapped = `${parts[0]}.99.${parts[2]}`;
const r3b = await post({ email: 'sarah.test@example.org', optin_revenue: '1k-10k', answer_pass: swapped });
check('pass with a different subscriber id -> 403', r3b.statusCode === 403, r3b.body);
for (const bad of ['__proto__', 'constructor', 'toString']) {
  const rb = await post({ email: 'sarah.test@example.org', optin_revenue: bad, answer_pass: goodPass });
  check(`inherited key "${bad}" -> 400`, rb.statusCode === 400, rb.body);
}
const r4 = await post({ email: 'sarah.test@example.org', optin_revenue: 'a-million', answer_pass: goodPass });
check('unknown answer code -> 400', r4.statusCode === 400, r4.body);
const r5 = await post({ email: 'sarah.test@example.org', optin_revenue: '1k-10k', answer_pass: goodPass }, { origin: 'https://evil.example', referer: 'https://evil.example/' });
check('foreign origin -> 403', r5.statusCode === 403, r5.body);
const roezan = issueRoezanPass('sarah.test@example.org', '');
const r6 = await post({ email: 'sarah.test@example.org', optin_revenue: '1k-10k', answer_pass: roezan });
check('a roezan_pass is not accepted as an answer_pass', r6.statusCode === 403, r6.body);
check('no Kit writes from any rejected request', writes.length === 0, JSON.stringify(writes));

// 4) No pass unless Kit really has and tagged the subscriber.
{
  const prev = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes('/v4/subscribers') && (opts.method || 'GET').toUpperCase() !== 'GET') return json(503, { errors: ['Kit down'] });
    return json(200, { subscribers: [] });
  };
  const res = await quiet(() => contact.handler({ httpMethod: 'POST', headers: ORIGIN,
    body: JSON.stringify({ email: 'queued.test@example.org', first_name: 'Queue', tag_id: 20410092, website: '' }) }));
  const body = JSON.parse(res.body || '{}');
  check('Kit outage, brand-new email: queued, and no answer_pass (Kit has no id yet)', body.success === true && body.queued === true && !body.answer_pass, res.body);
  global.fetch = prev;
}
{
  const res = await quiet(() => contact.handler({ httpMethod: 'POST', headers: ORIGIN,
    body: JSON.stringify({ email: 'bot@example.org', first_name: 'Bot', tag_id: 20410092, website: 'http://spam' }) }));
  const body = JSON.parse(res.body);
  check('honeypot fake success carries no answer_pass and no tagged flag', body.success === true && !body.answer_pass && body.tagged === undefined, res.body);
}
{
  writes = [];
  const r8 = await post({ email: 'sarah.test@example.org', optin_revenue: '10k-plus', answer_pass: goodPass });
  check('valid answer is one direct PUT (no lookup)', r8.statusCode === 200 && writes.length === 1 && /\/v4\/subscribers\/42$/.test(writes[0].url), JSON.stringify(writes));
}

// 5) Returning contacts still get a pass, so their answer saves (bug 2026-10-19:
//    no pass made the page skip the question and jump to the replay).
async function optinWithState(state, email) {
  const prev = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes('/v4/subscribers') && method === 'GET') return json(200, { subscribers: [{ id: 77, email_address: email, state, fields: {} }] });
    if (/\/v4\/subscribers(\/\d+)?$/.test(u)) return json(200, { subscriber: { id: 77, email_address: email, state } });
    return json(200, {});
  };
  try {
    const res = await quiet(() => contact.handler({ httpMethod: 'POST', headers: ORIGIN,
      body: JSON.stringify({ email, first_name: 'Re', tag_id: 20410092, website: '', latest_ad: 'qa' }) }));
    return JSON.parse(res.body || '{}');
  } finally { global.fetch = prev; }
}
{
  const body = await optinWithState('bounced', 'bounced.test@example.org');
  check('un-retaggable contact (bounced): pass issued for its Kit id', body.success === true && /^\d+\.77\.[a-f0-9]{64}$/.test(body.answer_pass || ''), JSON.stringify(body));
}
{
  const body = await optinWithState('cancelled', 'cancelled.test@example.org');
  check('unsubscribed contact still awaiting resubscribe: queued AND pass issued', body.success === true && body.queued === true && /^\d+\.77\.[a-f0-9]{64}$/.test(body.answer_pass || ''), JSON.stringify(body));
}

// 6) A hung Kit (AbortSignal.timeout -> TimeoutError) queues the opt-in
//    instead of a 500 that loses it; and the reply comes inside the page's 8s.
{
  const prev = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('challenges.cloudflare.com')) return { ok: true, status: 200, json: async () => ({ success: true }) };
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  const t0 = Date.now();
  const res = await quiet(() => contact.handler({ httpMethod: 'POST', headers: ORIGIN,
    body: JSON.stringify({ email: 'hung.test@example.org', first_name: 'Hung', tag_id: 20410092, website: '', latest_ad: 'qa' }) }));
  const ms = Date.now() - t0;
  const body = JSON.parse(res.body || '{}');
  check('Kit timeout -> queued (not 500)', res.statusCode === 200 && body.queued === true, res.statusCode + ' ' + res.body);
  check(`Kit timeout answers inside the page's 8s window (${ms}ms)`, ms < 7500, ms);
  global.fetch = prev;
}
{
  // Every Kit call is slow (1.8s) but succeeds: the handler must still answer
  // before ~7s (saved or queued), never run toward Netlify's 10s kill.
  const prev = global.fetch;
  global.fetch = async (url, opts = {}) => {
    await new Promise((r) => setTimeout(r, 1800));
    return prev(url, opts);
  };
  const t0 = Date.now();
  const res = await quiet(() => contact.handler({ httpMethod: 'POST', headers: ORIGIN,
    body: JSON.stringify({ email: 'sarah.test@example.org', first_name: 'Slow', tag_id: 20410092, website: '', latest_ad: 'qa' }) }));
  const ms = Date.now() - t0;
  const body = JSON.parse(res.body || '{}');
  check(`slow Kit: answers by ~7s (${ms}ms) as saved or queued`, ms < 7500 && body.success === true && (body.tagged === true || body.queued === true), ms + ' ' + res.body);
  check('slow Kit queued after the save: still carries an answer_pass', body.tagged === true || !!body.answer_pass, res.body);
  global.fetch = prev;
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall submit-optin-answer checks passed');
