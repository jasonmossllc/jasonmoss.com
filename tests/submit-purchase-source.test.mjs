// Tests the thank-you backup: submit-purchase-source only writes after the
// order is verified with Spiffy (exists, same email, recent), then writes
// original_source / original_ad as one pair when original_source is blank,
// from the authoritative Kit record, never creating subscribers.
// Spiffy and Kit are faked.
// Run: node tests/submit-purchase-source.test.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.KIT_API_KEY = 'test-key';
process.env.SPIFFY_API_KEY = 'spiffy-test-key';
const purchase = require('../netlify/functions/submit-purchase-source.js');

let failures = 0;
function check(name, cond, extra) {
  if (!cond) { failures++; console.error('FAIL:', name, extra ?? ''); }
  else console.log('ok:', name);
}

const NOW = () => new Date().toISOString();
let orders = {};
let subscriber = null;
let writes = [];
let lookups = 0;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  const m = u.match(/\/v2\/orders\/(\w+)\?include=customer$/);
  if (m) return orders[m[1]] ? json(200, { data: orders[m[1]] }) : json(404, {});
  if (u.includes('/v4/subscribers?') && method === 'GET') { lookups++; return json(200, { subscribers: subscriber ? [subscriber] : [] }); }
  if (/\/v4\/subscribers\/\d+$/.test(u) && method === 'GET') return json(200, { subscriber });
  if (/\/v4\/subscribers\/\d+$/.test(u) && method === 'PUT') { writes.push(JSON.parse(opts.body || '{}')); return json(200, { subscriber: { id: 42 } }); }
  return json(200, {});
};
const quiet = async (fn) => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
const ORIGIN = { origin: 'https://jasonmoss.com', referer: 'https://jasonmoss.com/sales-bible-thank-you/' };
const post = (body, headers = ORIGIN) => quiet(() => purchase.handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) }));
const BUYER = { email: 'buyer.test@example.org', order: '123456', latest_source: 'Facebook_Ads', latest_ad: 'Reel A' };
orders['123456'] = { id: 123456, created_at: NOW(), customer: { email: 'Buyer.Test@example.org' } };

// 1) Verified order, blank fields: the pair is written, and nothing else.
{
  subscriber = { id: 42, email_address: BUYER.email, fields: { original_source: '', original_ad: null } };
  writes = [];
  const res = await post(BUYER);
  check('verified order: saved', res.statusCode === 200 && JSON.parse(res.body).saved === true, res.body);
  check('writes only the two source fields', JSON.stringify(writes[0]?.fields) === JSON.stringify({ original_ad: 'Reel A', original_source: 'Facebook_Ads' }), JSON.stringify(writes));
}

// 2) Order verification blocks forged writes and list probing.
{
  writes = []; lookups = 0;
  check('unknown order: 403', (await post({ ...BUYER, order: '999999' })).statusCode === 403);
  check('order belongs to someone else: 403', (await post({ ...BUYER, email: 'victim@example.org' })).statusCode === 403);
  orders['555'] = { id: 555, created_at: new Date(Date.now() - 3 * 3600e3).toISOString(), customer: { email: BUYER.email } };
  check('old order: 403', (await post({ ...BUYER, order: '555' })).statusCode === 403);
  check('missing order: 400', (await post({ ...BUYER, order: '' })).statusCode === 400);
  check('no Kit lookup or write without a verified order', lookups === 0 && writes.length === 0, `lookups=${lookups}`);
}

// 3) Pair rule: an existing source blocks the whole pair.
{
  subscriber = { id: 42, email_address: BUYER.email, fields: { original_source: 'YouTube_Organic', original_ad: '' } };
  writes = [];
  const res = await post(BUYER);
  check('source already set: nothing written', JSON.parse(res.body).saved === false && writes.length === 0, res.body);
}

// 4) Verified but not in Kit yet: 404 retry, never created.
{
  subscriber = null; writes = [];
  const res = await post(BUYER);
  check('verified, not in Kit yet: 404 retry', res.statusCode === 404 && JSON.parse(res.body).retry === true, res.body);
  check('subscriber never created', writes.length === 0);
}

// 5) Plus-addressed email that arrived with a space instead of '+'.
{
  orders['777'] = { id: 777, created_at: NOW(), customer: { email: 'jane+book@example.org' } };
  subscriber = { id: 42, email_address: 'jane+book@example.org', fields: {} };
  writes = [];
  const res = await post({ ...BUYER, order: '777', email: 'jane book@example.org' });
  check('plus address restored and saved', res.statusCode === 200 && JSON.parse(res.body).saved === true, res.body);
}

// 6) No source param: no Spiffy or Kit calls, nothing invented.
{
  writes = []; lookups = 0;
  const res = await post({ ...BUYER, latest_source: '  ', latest_ad: 'Only ad' });
  check('no source: saved false, no calls', res.statusCode === 200 && JSON.parse(res.body).saved === false && lookups === 0 && writes.length === 0);
}

// 7) Guards: other origins, bad email, wrong method.
{
  check('foreign origin rejected', (await post(BUYER, { origin: 'https://evil.example.com' })).statusCode === 403);
  check('missing origin rejected', (await post(BUYER, {})).statusCode === 403);
  check('bad email rejected', (await post({ ...BUYER, email: 'not-an-email' })).statusCode === 400);
  const get = await quiet(() => purchase.handler({ httpMethod: 'GET', headers: ORIGIN }));
  check('GET rejected', get.statusCode === 405);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall purchase-source tests passed');
