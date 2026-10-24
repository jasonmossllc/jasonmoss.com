// Tests the decoupled ad-source path: the sales page logs fbclid -> source/ad
// (track-ad-click), and Spiffy's order:success webhook (spiffy-order-source)
// re-fetches the order, joins on its preserved fbclid and writes Kit's
// original_source / original_ad, blank-only, never creating subscribers.
// Spiffy, Kit and Blobs are faked.
// Run: node tests/spiffy-order-source.test.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.KIT_API_KEY = 'test-key';
process.env.SPIFFY_API_KEY = 'spiffy-test-key';
process.env.SPIFFY_ORDER_WEBHOOK_TOKEN = 'tok_test_1234567890';
const contact = require('../netlify/functions/submit-contact.js');
const click = require('../netlify/functions/track-ad-click.js');
const order = require('../netlify/functions/spiffy-order-source.js');

let failures = 0;
function check(name, cond, extra) {
  if (!cond) { failures++; console.error('FAIL:', name, extra ?? ''); }
  else console.log('ok:', name);
}

const blobs = new Map();
contact.__test.setBlobStoreOverride(() => ({
  async get(key) { return blobs.has(key) ? blobs.get(key) : null; },
  async setJSON(key, value) { blobs.set(key, value); },
}));

const FBCLID = 'IwZXh0bgNhZW0BMABwZG9mBWZkaWQWUQ50XDEJ_test-click';
let orders = {};
let subscriber = null;
let kitWrites = [];
let spiffyAuth = null;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  const m = u.match(/\/v2\/orders\/(\w+)$/);
  if (m) { spiffyAuth = (opts.headers || {}).Authorization; return orders[m[1]] ? json(200, { data: orders[m[1]] }) : json(404, {}); }
  if (u.includes('/v4/subscribers?') && method === 'GET') return json(200, { subscribers: subscriber ? [subscriber] : [] });
  if (/\/v4\/subscribers\/\d+$/.test(u) && method === 'PUT') { kitWrites.push(JSON.parse(opts.body)); return json(200, { subscriber: { id: 42 } }); }
  return json(200, {});
};
const quiet = async (fn) => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
const ORIGIN = { origin: 'https://jasonmoss.com', referer: 'https://jasonmoss.com/sales-bible/' };
const logClick = (body, headers = ORIGIN) => quiet(() => click.handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) }));
const webhook = (body, token = 'tok_test_1234567890') => quiet(() => order.handler({ httpMethod: 'POST', queryStringParameters: { token }, headers: {}, body: JSON.stringify(body) }));
const event = (id) => ({ id: 'evt_1', object: 'event', type: 'order:success', data: { object: { id } } });

// 1) Click log: stores source/ad for a valid fbclid, first write wins, guards.
{
  const r = await logClick({ fbclid: FBCLID, latest_source: 'Facebook_Ads', latest_ad: 'SalesBibleUS' });
  check('click logged', r.statusCode === 200 && JSON.parse(r.body).saved === true, r.body);
  const again = await logClick({ fbclid: FBCLID, latest_source: 'Other', latest_ad: 'Other' });
  check('first click wins', JSON.parse(again.body).saved === false && [...blobs.values()][0].fields.original_source === 'Facebook_Ads');
  check('no params: nothing stored', JSON.parse((await logClick({ fbclid: 'IwZXh0bgNhZW0BMABwZG9m_other' })).body).saved === false && blobs.size === 1);
  check('bad fbclid rejected', (await logClick({ fbclid: 'bad id!', latest_source: 'x' })).statusCode === 400);
  check('foreign origin rejected', (await logClick({ fbclid: FBCLID, latest_source: 'x' }, { origin: 'https://evil.example.com' })).statusCode === 403);
  check('raw fbclid not stored as key', !blobs.has(FBCLID));
}

// 2) Webhook: token required; re-fetches the order with the Spiffy key.
{
  check('bad token rejected', (await webhook(event('900'), 'wrong-token-000000')).statusCode === 401);
  orders['900'] = { id: 900, preserved_params: { fbclid: FBCLID }, customer: { email: 'Buyer.Test@Example.org' } };
  subscriber = { id: 42, email_address: 'buyer.test@example.org', fields: { original_source: '', original_ad: null } };
  kitWrites = [];
  const r = await webhook(event('900'));
  check('order attributed', r.statusCode === 200 && JSON.parse(r.body).saved === true, r.body);
  check('Spiffy fetched with API key', spiffyAuth === 'Bearer spiffy-test-key');
  check('writes only the two fields', JSON.stringify(kitWrites[0]?.fields) === JSON.stringify({ original_ad: 'SalesBibleUS', original_source: 'Facebook_Ads' }), JSON.stringify(kitWrites));
}

// 3) First touch wins in Kit; unknown/absent data is skipped, never defaulted.
{
  subscriber = { id: 42, email_address: 'buyer.test@example.org', fields: { original_source: 'YouTube_Organic', original_ad: 'Old' } };
  kitWrites = [];
  const r = await webhook(event('900'));
  check('existing source kept', JSON.parse(r.body).saved === false && kitWrites.length === 0, r.body);
  orders['901'] = { id: 901, preserved_params: {}, customer: { email: 'x@example.org' } };
  check('no fbclid: skipped', JSON.parse((await webhook(event('901'))).body).skipped === 'no fbclid');
  orders['902'] = { id: 902, preserved_params: { fbclid: 'IwZXh0bgNhZW0B_unlogged_click' }, customer: { email: 'x@example.org' } };
  check('unlogged click: skipped', JSON.parse((await webhook(event('902'))).body).skipped === 'no logged click');
  check('other event types ignored', JSON.parse((await webhook({ type: 'order:complete', data: { object: { id: 900 } } })).body).skipped === 'event type');
  check('unknown order: skipped', JSON.parse((await webhook(event('999'))).body).skipped === 'order not found');
}

// 4) Buyer not in Kit yet: 503 so Spiffy retries; nothing is created.
{
  subscriber = null; kitWrites = [];
  const r = await webhook(event('900'));
  check('not in Kit yet: 503 retry', r.statusCode === 503, r.body);
  check('subscriber never created', kitWrites.length === 0);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall order-source tests passed');
