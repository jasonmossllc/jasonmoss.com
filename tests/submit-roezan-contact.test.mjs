// Unit tests for the Roezan opt-in sync.
// Run: node tests/submit-roezan-contact.test.mjs
//
// Regression guard for the July-Aug 2026 silent-audience bug: contacts were
// created with `lists: []`, so every new SMS opt-in landed on NO list. Roezan
// broadcasts target LISTS (the API has no segment targeting), so those contacts
// were invisible to every send regardless of the tags they carried — 156 of 262
// Magnetic Message registrants were unreachable before this was caught.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.ROEZAN_API_KEY = process.env.ROEZAN_API_KEY || 'test';
const { __test } = require('../netlify/functions/submit-roezan-contact.js');
const { syncContactToRoezan, normalizeRoezanTagId } = __test;

let failures = 0;
function check(name, cond, extra) {
  if (!cond) { failures++; console.error('FAIL:', name, extra ?? ''); }
  else console.log('ok:', name);
}

const MAIN_LIST = 1446;

// Capture outbound Roezan calls instead of hitting the network.
function withStubbedFetch(fn, { contactByEmail = null } = {}) {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const path = String(url).replace('https://app.roezan.com/api', '');
    calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (path.startsWith('/integrations/contacts?')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ contact: contactByEmail }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  return fn(calls).finally(() => { global.fetch = realFetch; });
}

const base = { email: 'a@b.com', firstName: 'Test', lastName: 'User', tagId: 1690 };

await withStubbedFetch(async (calls) => {
  const res = await syncContactToRoezan({ ...base, phone: '+15551234567' }, Date.now() + 8500);
  check('reports synced', res.synced === true, res);

  const upsert = calls.find(c => c.path === '/integrations/contacts' && c.method === 'POST');
  const tag = calls.find(c => c.path === '/integrations/contacts/tags');
  const sub = calls.find(c => c.path === '/integrations/lists/subscribe');

  // The bug: this assertion fails if `lists` is ever emptied again.
  check('upsert puts the contact on Main List',
    JSON.stringify(upsert?.body?.lists) === JSON.stringify([MAIN_LIST]), upsert?.body);
  check('upsert carries the tag',
    JSON.stringify(upsert?.body?.tags) === JSON.stringify([1690]), upsert?.body);
  check('explicit list subscribe is sent', sub?.body?.list === MAIN_LIST, sub?.body);
  check('explicit tag apply is still sent',
    JSON.stringify(tag?.body?.tagIds) === JSON.stringify([1690]), tag?.body);
  check('subscribe and tag both target the same phone',
    sub?.body?.phone === '+15551234567' && tag?.body?.phone === '+15551234567');
});

// Email-only opt-in reuses the number already on file, and still lists it.
await withStubbedFetch(async (calls) => {
  const res = await syncContactToRoezan({ ...base, phone: '' }, Date.now() + 8500);
  check('email-only opt-in syncs via number on file', res.synced === true, res);
  const upsert = calls.find(c => c.path === '/integrations/contacts' && c.method === 'POST');
  check('recovered-phone contact still lands on Main List',
    JSON.stringify(upsert?.body?.lists) === JSON.stringify([MAIN_LIST]), upsert?.body);
}, { contactByEmail: { phone_number: '+15559998888' } });

// No phone anywhere => nothing to subscribe; must not invent a write.
await withStubbedFetch(async (calls) => {
  const res = await syncContactToRoezan({ ...base, phone: '' }, Date.now() + 8500);
  check('no phone => not synced', res.synced === false && res.reason === 'no_phone', res);
  check('no phone => no list/tag writes',
    !calls.some(c => c.path === '/integrations/lists/subscribe' || c.path === '/integrations/contacts/tags'), calls);
}, { contactByEmail: null });

check('tag id normalizer rejects non-numeric', normalizeRoezanTagId('abc') === null);
check('tag id normalizer accepts numeric', normalizeRoezanTagId(' 1690 ') === 1690);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll tests passed.');
process.exit(failures ? 1 : 0);
