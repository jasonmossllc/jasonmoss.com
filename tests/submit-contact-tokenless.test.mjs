// Unit tests for the Turnstile rule shared by every public form endpoint.
// Run: node tests/submit-contact-tokenless.test.mjs
//
// Regression guard for the Oct 2026 lockout: a missing Turnstile token was a
// hard 403 and the page gate waited for a token forever, so visitors whose
// browser can't run Turnstile could never opt in. Missing tokens now go
// through a capped lane; forged tokens must still be blocked.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.TURNSTILE_SECRET_KEY = 'test-secret';
const { __test } = require('../netlify/functions/submit-contact.js');
const { admitTokenless, checkTurnstile, TOKENLESS_DAILY_CAP, TOKENLESS_PER_IP_PER_HOUR } = __test;

let failures = 0;
function check(name, cond, extra) {
  if (!cond) { failures++; console.error('FAIL:', name, extra ?? ''); }
  else console.log('ok:', name);
}

function memStore() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async setJSON(k, v) { m.set(k, v); },
  };
}
const brokenStore = { async get() { throw new Error('blobs down'); }, async setJSON() { throw new Error('blobs down'); } };
const quiet = (fn) => async (...a) => { const l = console.log; console.log = () => {}; try { return await fn(...a); } finally { console.log = l; } };
const check_ = quiet(checkTurnstile);
const admit_ = quiet(admitTokenless);

// Missing token is admitted (the lockout fix), for '' / null / undefined.
for (const tok of ['', null, undefined]) {
  const r = await check_(tok, '1.1.1.1', memStore());
  check(`missing token (${JSON.stringify(tok)}) admitted`, r.block === false, r);
}

// Per-IP cap per hour.
{
  const st = memStore(); const now = new Date('2026-10-02T15:10:00Z');
  let admitted = 0;
  for (let i = 0; i < TOKENLESS_PER_IP_PER_HOUR + 2; i++) if ((await admit_('2.2.2.2', st, now)).admit) admitted++;
  check('per-IP cap holds', admitted === TOKENLESS_PER_IP_PER_HOUR, admitted);
  const nextHour = await admit_('2.2.2.2', st, new Date('2026-10-02T16:01:00Z'));
  check('per-IP cap resets next hour', nextHour.admit === true, nextHour);
}

// Site-wide daily cap: a flood from many IPs fills it, then the lane closes.
{
  const st = memStore(); const now = new Date('2026-10-02T15:10:00Z');
  let admitted = 0;
  for (let i = 0; i < TOKENLESS_DAILY_CAP + 10; i++) if ((await admit_(`10.0.${i >> 8}.${i & 255}`, st, now)).admit) admitted++;
  check('daily cap holds across IPs', admitted === TOKENLESS_DAILY_CAP, admitted);
  // checkTurnstile uses the real clock, so fill today's counter directly.
  st.m.set(`day/${new Date().toISOString().slice(0, 10)}`, TOKENLESS_DAILY_CAP);
  const r2 = await check_('', '9.9.9.8', st);
  check('full lane blocks with verification_required', r2.block === true && r2.error === 'verification_required', r2);
  const tomorrow = await admit_('9.9.9.7', st, new Date(Date.now() + 86400000));
  check('daily cap resets next day', tomorrow.admit === true, tomorrow);
}

// Store outage fails CLOSED (old strict behavior), never open.
{
  const errLog = console.error; console.error = () => {};
  const r = await check_('', '3.3.3.3', brokenStore);
  console.error = errLog;
  check('store error closes the lane', r.block === true && r.error === 'verification_required', r);
}

// A submitted token still has to verify: forged tokens stay blocked and never
// touch the tokenless lane.
{
  const realFetch = global.fetch;
  global.fetch = async () => ({ json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) });
  const st = memStore();
  const r = await check_('forged-token', '4.4.4.4', st);
  check('forged token blocked', r.block === true && r.error === 'Verification failed', r);
  check('forged token does not use the lane', st.m.size === 0, [...st.m.keys()]);
  const obj = await check_({ evil: 1 }, '4.4.4.4', st);
  check('non-string token goes to verify, not the lane', obj.block === true && st.m.size === 0, obj);
  global.fetch = async () => ({ json: async () => ({ success: true }) });
  const ok = await check_('good-token', '4.4.4.4', st);
  check('valid token passes', ok.block === false, ok);
  global.fetch = realFetch;
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll tests passed.');
process.exit(failures ? 1 : 0);
