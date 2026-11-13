// Unit tests for the qualifier's Kit prefill lookup.
// Run: node tests/qualify-prefill.test.mjs
import { createRequire } from 'module';
import crypto from 'crypto';
const require = createRequire(import.meta.url);
process.env.KIT_API_KEY = 'test-key';
const contact = require('../netlify/functions/submit-contact.js');
const fn = require('../netlify/functions/qualify-prefill.js');
const { admit, cleanFirstName, setFetch, resetMem, LOOKUPS_PER_IP_PER_HOUR, LOOKUPS_DAILY_CAP } = fn.__test;

let failures = 0;
function check(name, cond, extra) {
  if (!cond) { failures++; console.error('FAIL:', name, extra ?? ''); }
  else console.log('ok:', name);
}
function memStore() {
  const m = new Map();
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async setJSON(k, v) { m.set(k, v); } };
}
let store = memStore();
contact.__test.setBlobStoreOverride(() => store);
const quiet = (f) => async (...a) => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await f(...a); } finally { console.log = l; console.error = e; } };

const SUB = { id: 123456789, first_name: 'Casey', email_address: 'Casey.Jones@Example.com', state: 'active', fields: { phone: '+13035550123' } };
let kitCalls = 0;
function kitReturns(status, body) {
  setFetch(async (url) => { kitCalls++; return { ok: status >= 200 && status < 300, status, json: async () => body, url }; });
}
const call = quiet(async (body, headers = { origin: 'https://jasonmoss.com', 'x-nf-client-connection-ip': '1.2.3.4' }, method = 'POST') => {
  const r = await fn.handler({ httpMethod: method, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body || '{}') : {}, headers: r.headers };
});

// Found: first name + lowercased email, and nothing else (no phone, no fields).
kitReturns(200, { subscriber: SUB });
let r = await call({ kid: '123456789' });
check('found -> 200 with first_name + email', r.status === 200 && r.body.first_name === 'Casey' && r.body.email === 'casey.jones@example.com', r);
check('returns only first_name + email', JSON.stringify(Object.keys(r.body).sort()) === '["email","first_name"]', r.body);
check('no-store', r.headers['Cache-Control'] === 'no-store');

// Hashed email on the link must match (either casing).
resetMem(); store = memStore();
const shLower = crypto.createHash('sha256').update('casey.jones@example.com').digest('hex');
const shRaw = crypto.createHash('sha256').update('Casey.Jones@Example.com').digest('hex');
r = await call({ kid: '123456789', sh: shLower });
check('matching sh (lowercase) -> found', r.body.email === 'casey.jones@example.com', r);
r = await call({ kid: '123456789', sh: shRaw });
check('matching sh (as stored) -> found', r.body.email === 'casey.jones@example.com', r);
r = await call({ kid: '123456789', sh: 'a'.repeat(64) });
check('mismatched sh -> {}', r.status === 200 && !r.body.email, r);

// Not a subscriber of this account / Kit down / timeout -> {} (never an error the page sees).
resetMem(); store = memStore();
kitReturns(404, { errors: ['Not Found'] });
r = await call({ kid: '999999999' });
check('Kit 404 -> 200 {}', r.status === 200 && Object.keys(r.body).length === 0, r);
setFetch(async () => { throw new Error('timeout'); });
r = await call({ kid: '123456789' });
check('Kit throws -> 200 {}', r.status === 200 && Object.keys(r.body).length === 0, r);
kitReturns(200, { subscriber: { ...SUB, email_address: 'not-an-email' } });
r = await call({ kid: '123456789' });
check('bad email in Kit -> {}', !r.body.email, r);

// Input + origin guards.
resetMem(); store = memStore();
kitReturns(200, { subscriber: SUB });
kitCalls = 0;
for (const bad of [{}, { kid: '' }, { kid: '0123' }, { kid: '12a' }, { kid: 123 }, { kid: '1'.repeat(17) }, { kid: '123', sh: 'xyz' }]) {
  r = await call(bad);
  check(`bad input ${JSON.stringify(bad)} -> 400`, r.status === 400, r);
}
r = await call('not json');
check('malformed JSON -> 400', r.status === 400, r);
r = await call({ kid: '123456789' }, { origin: 'https://evil.example' });
check('foreign origin -> 403', r.status === 403, r);
r = await call({ kid: '123456789' }, {});
check('no origin/referer -> 403', r.status === 403, r);
r = await call({ kid: '123456789' }, { referer: 'https://deploy-preview-9--jasonmoss.netlify.app/apply/' });
check('deploy preview referer allowed', r.status === 200 && r.body.email, r);
r = await call({ kid: '123456789' }, { origin: 'https://jasonmoss.com' }, 'GET');
check('GET -> 405', r.status === 405, r);
r = await call({}, { origin: 'https://jasonmoss.com' }, 'OPTIONS');
check('OPTIONS -> 200', r.status === 200);

// Per-visitor cap: after LOOKUPS_PER_IP_PER_HOUR, the same IP gets {} and Kit is not called.
resetMem(); store = memStore();
kitCalls = 0;
for (let i = 0; i < LOOKUPS_PER_IP_PER_HOUR; i++) await call({ kid: '123456789' });
const before = kitCalls;
r = await call({ kid: '123456789' });
check('per-IP cap -> {} without calling Kit', !r.body.email && kitCalls === before, { kitCalls, before });
r = await call({ kid: '123456789' }, { origin: 'https://jasonmoss.com', 'x-nf-client-connection-ip': '5.6.7.8' });
check('another IP still served', r.body.email === 'casey.jones@example.com', r);

// Daily cap (Blobs counter), checked straight on admit().
resetMem();
const s2 = memStore();
const day = new Date().toISOString().slice(0, 10);
s2.m.set(`day/${day}`, LOOKUPS_DAILY_CAP);
let a = await admit('9.9.9.9', s2);
check('daily cap closes', a.admit === false && a.reason === 'daily_cap', a);
a = await quiet(admit)('9.9.9.10', { async get() { throw new Error('blobs down'); }, async setJSON() {} });
check('store error fails closed', a.admit === false && a.reason === 'store_error', a);
// The cap check also runs through the handler.
resetMem(); store = memStore(); store.m.set(`day/${day}`, LOOKUPS_DAILY_CAP); kitCalls = 0;
r = await call({ kid: '123456789' });
check('handler honours daily cap', !r.body.email && kitCalls === 0, r);

// Name cleaning.
check('name kept', cleanFirstName('  Mary  Ann ') === 'Mary Ann');
check('markup stripped', cleanFirstName('<b>Jo') === 'bJo');
check('empty -> ""', cleanFirstName(null) === '' && cleanFirstName('   ') === '');
check('too long -> ""', cleanFirstName('x'.repeat(61)) === '');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall qualify-prefill tests passed');
