// Tests the Kit opt-in retry queue: items back off between attempts and are
// only parked in failed/ after QUEUE_MAX_AGE (48h), not after a few minutes.
// Run: node tests/process-kit-optin-queue.test.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.KIT_API_KEY = 'test-key';
const contact = require('../netlify/functions/submit-contact.js');
const queue = require('../netlify/functions/process-kit-optin-queue.js');
const { processQueuedOptins, retryGapMs } = queue.__test;

let failures = 0;
function check(name, cond, extra) {
  if (!cond) { failures++; console.error('FAIL:', name, extra ?? ''); }
  else console.log('ok:', name);
}

const blobs = new Map();
contact.__test.setBlobStoreOverride(() => ({
  async setJSON(key, value) { blobs.set(key, JSON.parse(JSON.stringify(value))); return { modified: true }; },
  async get(key) { return blobs.has(key) ? JSON.parse(JSON.stringify(blobs.get(key))) : null; },
  async *list({ prefix }) { yield { blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })) }; },
  async delete(key) { blobs.delete(key); },
}));
// Kit is down (503) for this whole test.
global.fetch = async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => '{"errors":["down"]}' });
const quiet = async (fn) => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const sub = { email: 'q@example.org', firstName: 'Q', tagIds: [20410092] };

check('back-off gaps grow 1, 2, 4 min and cap at 60', retryGapMs(1) === 60e3 && retryGapMs(2) === 120e3 && retryGapMs(3) === 240e3 && retryGapMs(20) === 3600e3);

blobs.set('pending/a', { submission: sub, queuedAt: iso(30 * 60e3), attempts: 13, lastAttemptAt: iso(2 * 3600e3) });   // 30 min old, 13 tries: keep going
blobs.set('pending/b', { submission: sub, queuedAt: iso(49 * 3600e3), attempts: 40, lastAttemptAt: iso(2 * 3600e3) }); // 49h old: give up
blobs.set('pending/c', { submission: sub, queuedAt: iso(10 * 60e3), attempts: 3, lastAttemptAt: iso(60e3) });          // tried 1 min ago, gap 4 min: skip
blobs.set('pending/d', { submission: sub, attempts: 2, lastAttemptAt: iso(3600e3) });                                // legacy item without queuedAt: keep

const r = await quiet(() => processQueuedOptins());
check('a 30-minute-old item with 13 failed tries is still retained (old cap was 12)', blobs.has('pending/a') && blobs.get('pending/a').attempts === 14, JSON.stringify(blobs.get('pending/a')));
check('a 49-hour-old item is parked in failed/', !blobs.has('pending/b') && blobs.has('failed/b'));
check('an item inside its back-off gap is skipped untouched', blobs.get('pending/c').attempts === 3);
check('a legacy item with no queuedAt is retried, not parked', blobs.has('pending/d') && blobs.get('pending/d').attempts === 3);
check('run summary counts', r.retained === 2 && r.failed === 1, JSON.stringify(r));

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall process-kit-optin-queue checks passed');
