// Tests purchase attribution: the Spiffy thank-you page posts the ad source the
// sales page saved, and submit-purchase-source writes it to Kit's
// original_source / original_ad only when blank, only for a subscriber who
// already exists, and only from our origins. Kit is faked.
// Run: node tests/submit-purchase-source.test.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.KIT_API_KEY = 'test-key';
const purchase = require('../netlify/functions/submit-purchase-source.js');

let failures = 0;
function check(name, cond, extra) {
  if (!cond) { failures++; console.error('FAIL:', name, extra ?? ''); }
  else console.log('ok:', name);
}

let subscriber = null;
let writes = [];
let lookups = 0;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.includes('/v4/subscribers?') && method === 'GET') {
    lookups++;
    return json(200, { subscribers: subscriber ? [subscriber] : [] });
  }
  if (/\/v4\/subscribers(\/\d+)?$/.test(u) && (method === 'POST' || method === 'PUT')) {
    writes.push({ method, url: u, body: JSON.parse(opts.body || '{}') });
    return json(200, { subscriber: { id: 42, state: 'active' } });
  }
  return json(200, {});
};
const quiet = async (fn) => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
const ORIGIN = { origin: 'https://jasonmoss.com', referer: 'https://jasonmoss.com/sales-bible-thank-you/' };
const post = (body, headers = ORIGIN) => quiet(() => purchase.handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) }));
const BUYER = { email: 'buyer.test@example.org', order: '123456', latest_source: 'Facebook_Ads', latest_ad: 'Reel A' };

// 1) Blank fields: both get written, and nothing else.
{
  subscriber = { id: 42, email_address: BUYER.email, fields: { original_source: '', original_ad: null } };
  writes = [];
  const res = await post(BUYER);
  check('blank fields saved', res.statusCode === 200 && JSON.parse(res.body).saved === true, res.body);
  check('one Kit write to that subscriber', writes.length === 1 && writes[0].url.endsWith('/v4/subscribers/42'), JSON.stringify(writes));
  check('writes only the two source fields', JSON.stringify(writes[0]?.body.fields) === JSON.stringify({ original_ad: 'Reel A', original_source: 'Facebook_Ads' }), JSON.stringify(writes[0]?.body));
}

// 2) First touch wins: an existing source is never overwritten.
{
  subscriber = { id: 42, email_address: BUYER.email, fields: { original_source: 'YouTube_Organic', original_ad: '' } };
  writes = [];
  const res = await post(BUYER);
  check('partial save returns saved', JSON.parse(res.body).saved === true, res.body);
  check('only the blank ad field is written', JSON.stringify(writes[0]?.body.fields) === JSON.stringify({ original_ad: 'Reel A' }), JSON.stringify(writes));
}
{
  subscriber = { id: 42, email_address: BUYER.email, fields: { original_source: 'YouTube_Organic', original_ad: 'Old ad' } };
  writes = [];
  const res = await post(BUYER);
  check('both set: nothing written', res.statusCode === 200 && JSON.parse(res.body).saved === false && writes.length === 0, res.body);
}

// 3) Not in Kit yet: ask the page to retry, never create the subscriber.
{
  subscriber = null;
  writes = [];
  const res = await post(BUYER);
  check('unknown buyer gets 404 retry', res.statusCode === 404 && JSON.parse(res.body).retry === true, res.body);
  check('unknown buyer is not created', writes.length === 0, JSON.stringify(writes));
}

// 4) No params: no default value is invented, Kit is not even called.
{
  subscriber = { id: 42, email_address: BUYER.email, fields: {} };
  writes = []; lookups = 0;
  const res = await post({ email: BUYER.email, latest_source: '  ', latest_ad: '' });
  check('no params: saved false', res.statusCode === 200 && JSON.parse(res.body).saved === false, res.body);
  check('no params: no Kit calls', lookups === 0 && writes.length === 0);
}

// 5) Guards: other origins, bad email, wrong method.
{
  writes = [];
  const res = await post(BUYER, { origin: 'https://evil.example.com' });
  check('foreign origin rejected', res.statusCode === 403 && writes.length === 0, res.body);
  const noOrigin = await post(BUYER, {});
  check('missing origin rejected', noOrigin.statusCode === 403, noOrigin.body);
  const bad = await post({ ...BUYER, email: 'not-an-email' });
  check('bad email rejected', bad.statusCode === 400, bad.body);
  const get = await quiet(() => purchase.handler({ httpMethod: 'GET', headers: ORIGIN }));
  check('GET rejected', get.statusCode === 405, get.body);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall purchase-source tests passed');
