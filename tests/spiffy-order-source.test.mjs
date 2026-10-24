// Tests the decoupled ad-source path: the sales page logs fbclid -> source/ad
// (track-ad-click), and Spiffy's order:success webhook (spiffy-order-source)
// re-fetches the order, joins on its preserved fbclid and writes Kit's
// original_source / original_ad as one pair, only when original_source is
// blank, from the authoritative Kit record, never creating subscribers, and
// never failing old orders (so the webhook can't get disabled).
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
const { ageMs } = order.__internal;

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
const NOW = () => new Date().toISOString();
let orders = {};
let listSub = null;   // what the (eventually consistent) list lookup returns
let idSub = null;     // what the authoritative GET /subscribers/{id} returns
let kitWrites = [];
let spiffyAuth = null;
let spiffyFail = false;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  const m = u.match(/\/v2\/orders\/(\w+)\?include=customer$/);
  if (m) {
    spiffyAuth = (opts.headers || {}).Authorization;
    if (spiffyFail) return json(500, {});
    if (!orders[m[1]]) return json(404, {});
    const { customer, embed, ...bare } = orders[m[1]];
    return json(200, { data: embed === false ? bare : orders[m[1]] });
  }
  const c = u.match(/\/v2\/customers\/(\w+)$/);
  if (c) return json(200, { data: { id: c[1], email: 'fallback.buyer@example.org' } });
  if (u.includes('/v4/subscribers?') && method === 'GET') return json(200, { subscribers: listSub ? [listSub] : [] });
  if (/\/v4\/subscribers\/\d+$/.test(u) && method === 'GET') return json(200, { subscriber: idSub || listSub });
  if (/\/v4\/subscribers\/\d+$/.test(u) && method === 'PUT') { kitWrites.push(JSON.parse(opts.body)); return json(200, { subscriber: { id: 42 } }); }
  return json(200, {});
};
const quiet = async (fn) => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
const ORIGIN = { origin: 'https://jasonmoss.com', referer: 'https://jasonmoss.com/sales-bible/' };
const logClick = (body, headers = ORIGIN) => quiet(() => click.handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) }));
const webhook = (body, token = 'tok_test_1234567890') => quiet(() => order.handler({ httpMethod: 'POST', queryStringParameters: { token }, headers: {}, body: JSON.stringify(body) }));
const event = (id, extra = {}) => ({ id: 'evt_1', object: 'event', type: 'order:success', created: Math.floor(Date.now() / 1000), data: { object: { id, ...extra } } });
const sub = (email, fields) => ({ id: 42, email_address: email, fields });
const body = (r) => JSON.parse(r.body);

// 1) Click log: stores source/ad for a valid fbclid, first write wins, guards.
{
  const r = await logClick({ fbclid: FBCLID, latest_source: 'Facebook_Ads', latest_ad: 'SalesBibleUS' });
  check('click logged', r.statusCode === 200 && body(r).saved === true, r.body);
  const again = await logClick({ fbclid: FBCLID, latest_source: 'Other', latest_ad: 'Other' });
  check('first click wins', body(again).saved === false && [...blobs.values()][0].fields.original_source === 'Facebook_Ads');
  check('no params: nothing stored', body(await logClick({ fbclid: 'IwZXh0bgNhZW0BMABwZG9m_other' })).saved === false && blobs.size === 1);
  check('bad fbclid rejected', (await logClick({ fbclid: 'bad id!', latest_source: 'x' })).statusCode === 400);
  check('foreign origin rejected', (await logClick({ fbclid: FBCLID, latest_source: 'x' }, { origin: 'https://evil.example.com' })).statusCode === 403);
  check('raw fbclid not stored as key', !blobs.has(FBCLID));
}

// 2) Token: wrong, missing, and multi-byte (must not crash).
{
  check('bad token rejected', (await webhook(event('900'), 'wrong-token-000000')).statusCode === 401);
  check('missing token rejected', (await webhook(event('900'), '')).statusCode === 401);
  check('multi-byte token: 401, no crash', (await webhook(event('900'), 'é'.repeat(19))).statusCode === 401);
}

// 3) Happy path: re-fetches with the Spiffy key, writes the pair.
{
  orders['900'] = { id: 900, created_at: NOW(), preserved_params: { fbclid: FBCLID }, customer: { email: 'Buyer.Test@Example.org' } };
  listSub = sub('buyer.test@example.org', { original_source: '', original_ad: null }); idSub = null;
  kitWrites = [];
  const r = await webhook(event('900'));
  check('order attributed', r.statusCode === 200 && body(r).saved === true, r.body);
  check('Spiffy fetched with API key', spiffyAuth === 'Bearer spiffy-test-key');
  check('writes only the two fields', JSON.stringify(kitWrites[0]?.fields) === JSON.stringify({ original_ad: 'SalesBibleUS', original_source: 'Facebook_Ads' }), JSON.stringify(kitWrites));
}

// 4) Customer not embedded: falls back to the customer record.
{
  orders['905'] = { id: 905, created_at: NOW(), embed: false, customer_id: 77, preserved_params: { fbclid: FBCLID } };
  listSub = sub('fallback.buyer@example.org', {}); idSub = null; kitWrites = [];
  const r = await webhook(event('905'));
  check('customer fallback finds the email', r.statusCode === 200 && body(r).saved === true, r.body);
}

// 5) First touch + pair rule, from the authoritative record.
{
  listSub = sub('buyer.test@example.org', { original_source: 'YouTube_Organic', original_ad: '' }); idSub = null; kitWrites = [];
  check('source set: nothing written (no mixed pair)', body(await webhook(event('900'))).saved === false && kitWrites.length === 0);
  // List says blank, authoritative record says already set (stale list read).
  listSub = sub('buyer.test@example.org', { original_source: '', original_ad: '' });
  idSub = sub('buyer.test@example.org', { original_source: 'Facebook_Ads', original_ad: 'Earlier' }); kitWrites = [];
  check('stale list read: authoritative record wins', body(await webhook(event('900'))).saved === false && kitWrites.length === 0);
  // Authoritative record belongs to a different email: never write.
  idSub = sub('someone.else@example.org', {}); kitWrites = [];
  const r = await webhook(event('900'));
  check('email mismatch on record: no write', kitWrites.length === 0, r.body);
  idSub = null;
}

// 6) Skips that must never fail or retry.
{
  orders['901'] = { id: 901, created_at: NOW(), preserved_params: {}, customer: { email: 'x@example.org' } };
  check('no fbclid: skipped', body(await webhook(event('901'))).skipped === 'no fbclid');
  check('no fbclid in payload: skipped before Spiffy call', body(await webhook(event('999', { preserved_params: { gclid: 'g' } }))).skipped === 'no fbclid');
  orders['902'] = { id: 902, created_at: NOW(), preserved_params: { fbclid: 'IwZXh0bgNhZW0B_unlogged_click' }, customer: { email: 'x@example.org' } };
  const r = await webhook(event('902'));
  check('unlogged click (other funnels): 200 skip, no retry', r.statusCode === 200 && body(r).skipped === 'no logged click', r.body);
  check('other event types ignored', body(await webhook({ type: 'order:complete', data: { object: { id: 900 } } })).skipped === 'event type');
  check('unknown order: skipped', body(await webhook(event('999'))).skipped === 'order not found');
}

// 7) Buyer not in Kit: 503 while fresh, 200 once old; nothing created.
{
  listSub = null; idSub = null; kitWrites = [];
  const fresh = await webhook(event('900'));
  check('not in Kit yet (fresh): 503 retry', fresh.statusCode === 503, fresh.body);
  orders['903'] = { id: 903, created_at: new Date(Date.now() - 7 * 3600e3).toISOString(), preserved_params: { fbclid: FBCLID }, customer: { email: 'late@example.org' } };
  const old = await webhook({ ...event('903'), created: Math.floor(Date.now() / 1000) - 7 * 3600 });
  check('not in Kit (old order): 200, no retry storm', old.statusCode === 200, old.body);
  check('subscriber never created', kitWrites.length === 0);
}

// 8) Errors: 500 while fresh (retry), 200 once past the window.
{
  spiffyFail = true;
  check('Spiffy error, fresh event: 500 retry', (await webhook(event('900'))).statusCode === 500);
  const old = await webhook({ ...event('900'), created: Math.floor(Date.now() / 1000) - 7 * 3600 });
  check('Spiffy error, old event: 200 (no retry storm)', old.statusCode === 200, old.body);
  spiffyFail = false;
}

// 9) Old clicks are ignored; date parsing is safe.
{
  blobs.clear();
  await logClick({ fbclid: FBCLID, latest_source: 'Facebook_Ads', latest_ad: 'Old' });
  const [k, v] = [...blobs.entries()][0]; blobs.set(k, { ...v, at: new Date(Date.now() - 40 * 864e5).toISOString() });
  listSub = sub('buyer.test@example.org', {}); kitWrites = [];
  check('click older than 30 days: skipped', body(await webhook(event('900'))).skipped === 'no logged click' && kitWrites.length === 0);
  check('ageMs: unparseable counts as fresh', ageMs('not a date') === 0 && ageMs(undefined) === 0);
  check('ageMs: future (clock skew) clamps to 0', ageMs(new Date(Date.now() + 30000).toISOString()) === 0);
  check('ageMs: epoch seconds understood', Math.abs(ageMs(Math.floor(Date.now() / 1000) - 3600) - 3600e3) < 5000);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall order-source tests passed');
