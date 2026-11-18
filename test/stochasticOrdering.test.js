/*
 * test/stochasticOrdering.test.js - Stage 3.8: a sampled order that reverses the expected-value walk, on a long fight.
 *
 * WHY THIS FIXTURE IS NOT THE FRESH-LEAD ARTEFACT. The ordinary fight's `fight()` walk prices a steady rate while
 * `simulateFights` starts with a fresh lead blow at t=0 (simulateFight.js:118-149, A13), so the two disagree most on a
 * one-blow fight. Measured on build 121, foe 45: pool 500 -> `fight()` blows = 1 and walk/sampler = 0.481; pool 5,000
 * -> 8 blows and 0.913; pool 50,000 -> 74 blows and 0.999 (build 123: 0.425, 0.885, 0.997). No ordinary-fight pool
 * large enough to wash that out reverses the order on the current max profiles (checked at 20,000 and 50,000 for all
 * four foe presets).
 *
 * The reversal below is a RELAY fight: `fightRelay` and `simulateRelayFights` both start from the same fresh-join
 * purse and token bucket (M30), and at pool 2,000 the walk/sampler ratios are 0.93-1.01. The status is still a real
 * expected-vs-sampled difference: `relay` ranks 127 (217.36) over 126 (200.86), while `stochastic-relay` ranks 126
 * (216.87) over 127 (215.96), with a paired TTK difference of -0.0365 s and a 95% CI of +/-0.0121 s over 996
 * both-kill seeds, and killProbability 0.996 vs 0.999. Budget: measured ~10 s (two 1,000-trial relay sims dominate);
 * this file and `stochasticObjectives.test.js` are in `tools/test-fast.mjs` HEAVY.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { pairedDifference, rankBuilds } from '../src/objectives.js';
import { gateTarget } from '../src/model.js';
import { maxCharacter } from '../src/maxprofile.js';

const OPTS = { core: 'overhaul', rri: true, passiveOn: true, stacks: 5 };
const gate = () => gateTarget(45);
const max = (id) => ({ id, ch: maxCharacter(id) });

// gate 45, pool 2,000: 1,000 seeds, a 10 s horizon (both builds kill almost every seed).
const RELAY = rankBuilds([max(126), max(127)], {
  ...OPTS, objective: 'stochastic-relay', target: gate(), health: 2000, trials: 1000, maxSeconds: 10,
});
const BY_ID = new Map(RELAY.rows.map((r) => [r.id, r]));

test('3.8 ordering guard: the relay walk ranks 127 over 126, the sampled relay reverses them', () => {
  const walk = rankBuilds([max(126), max(127)], { ...OPTS, objective: 'relay', target: gate(), health: 2000 });
  assert.deepEqual(walk.rows.map((r) => r.id), [127, 126]);
  assert.deepEqual(RELAY.rows.map((r) => r.id), [126, 127]);
  assert.ok(walk.rows[0].value > walk.rows[1].value);
  assert.ok(RELAY.rows[0].value > RELAY.rows[1].value);
  for (const r of RELAY.rows) {
    assert.equal(r.objective, 'stochastic-relay');
    assert.equal(r.metric, 'kill-rate');
    assert.equal(r.n, 1000);
    assert.equal(r.horizonSeconds, 10);
    assert.equal(r.damageMode, null, 'the relay summary has no damageMode');
    assert.equal(r.killProbability.p > 0.99, true, `kill probability ${r.killProbability.p}`);
    assert.equal(r.censoringDiffers, false, 'the relay rows kill almost every seed');
  }
  // the reversal is paired and separated: 126's TTK is shorter on the seeds both builds kill
  const diff = pairedDifference(BY_ID.get(126), BY_ID.get(127));
  assert.equal(diff.metric, 'ttk');
  assert.equal(diff.n > 900, true);
  assert.equal(diff.containsZero, false);
  assert.ok(diff.hi < 0, `paired TTK difference ${JSON.stringify(diff)}`);
  assert.equal(BY_ID.get(127).separated, true);
  // and the paired kill indicators agree: both kill almost every seed
  assert.ok(BY_ID.get(127).pairedKill, 'the TTK pair reports the kill-indicator difference too');
  assert.equal(BY_ID.get(127).pairedKill.metric, 'kill');
  assert.ok(Math.abs(BY_ID.get(127).pairedKill.mean) < 0.01);
});
