// Unit tests for the Growth Bottleneck scoring/routing (final-instrument.md).
// Run: node netlify/functions/submit-bottleneck.test.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.KIT_API_KEY = process.env.KIT_API_KEY || 'test';
const { __test } = require('./submit-bottleneck.js');
const { scoreAssessment } = __test;

let failures = 0;
function check(name, cond, extra) {
  if (!cond) { failures++; console.error('FAIL:', name, extra ?? ''); }
  else console.log('ok:', name);
}

// P1 struggling creator: reach fine, enroll dead → Enroll.
let r = scoreAssessment({ revenue: '5-10k', q1: 'b', q2: 'd', q3: 'd', q4: 'a', q5: 'c' });
check('P1 enroll bottleneck', r.ok && r.primary === 'enroll', r);
check('P1 scores', JSON.stringify(r.scores) === JSON.stringify({ reach: 2, nurture: 2, enroll: 0, deliver: 2, deepen: 1 }), r.scores);
check('P1 close second deepen', r.second === 'deepen', r.second);

// P2 tie reach/nurture at 1 → earliest (reach) wins.
r = scoreAssessment({ revenue: '10-25k', q1: 'c', q2: 'c', q3: 'c', q4: 'c', q5: 'a' });
check('P2 tie -> reach', r.ok && r.primary === 'reach', r);
check('P2 close second nurture', r.second === 'nurture', r.second);

// P3 $0-5k guardrail: deliver 0 strictly below min(front)=1 → deliver wins.
r = scoreAssessment({ revenue: '0-5k', q1: 'c', q2: 'c', q3: 'a', q4: 'b', q5: 'a' });
check('P3 guardrail back override', r.ok && r.primary === 'deliver', r);

// P4 $0-5k guardrail holds: back stage equal (not strictly lower) → front pool.
r = scoreAssessment({ revenue: '0-5k', q1: 'c', q2: 'c', q3: 'c', q4: 'd', q5: 'c' });
check('P4 guardrail front pool', r.ok && r.primary === 'reach', r);

// P5 not-yet exclusion: deliver/deepen "not yet" never route; nurture 1 lowest eligible.
r = scoreAssessment({ revenue: '5-10k', q1: 'b', q2: 'c', q3: 'c', q4: 'e', q5: 'e' });
check('P5 excluded stages', JSON.stringify(r.excluded) === JSON.stringify(['deliver', 'deepen']), r.excluded);
check('P5 nurture bottleneck', r.primary === 'nurture', r);

// P6 healthy across the board → lowest still named (deepen 1 via c).
r = scoreAssessment({ revenue: '50k-plus', q1: 'a', q2: 'b', q3: 'b', q4: 'c', q5: 'c' });
check('P6 strong chain -> deepen', r.ok && r.primary === 'deepen', r);

// P7 nurture not-yet at $0-5k: front pool drops nurture; reach 0 wins.
r = scoreAssessment({ revenue: '0-5k', q1: 'd', q2: 'e', q3: 'c', q4: 'e', q5: 'e' });
check('P7 reach bottleneck, 3 excluded', r.primary === 'reach' && r.excluded.length === 3, r);

// Forged payloads rejected.
check('bad letter rejected', scoreAssessment({ revenue: '5-10k', q1: 'z', q2: 'a', q3: 'a', q4: 'a', q5: 'a' }).ok === false);
check('bad revenue rejected', scoreAssessment({ revenue: 'lots', q1: 'a', q2: 'a', q3: 'a', q4: 'a', q5: 'a' }).ok === false);
check('missing q rejected', scoreAssessment({ revenue: '5-10k', q1: 'a', q2: 'a', q3: 'a', q4: 'a' }).ok === false);
check('e on 4-option q rejected', scoreAssessment({ revenue: '5-10k', q1: 'e', q2: 'a', q3: 'a', q4: 'a', q5: 'a' }).ok === false);

// Results URL carries the full schema.
const u = __test.buildResultsUrl({
  scores: { reach: 2, nurture: 2, enroll: 0, deliver: 2, deepen: 1 },
  primary: 'enroll', second: 'deepen', excluded: [], revenueKey: '5-10k',
  firstName: 'Ana', email: 'a@b.co',
});
check('url schema', u.includes('s=2%2C2%2C0%2C2%2C1') && u.includes('b=enroll') && u.includes('c=deepen') && u.includes('rev=5-10k'), u);

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('ALL PASS');
