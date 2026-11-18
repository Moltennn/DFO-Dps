/*
 * test/stochasticObjectives.test.js - Stage 3.8: sampled rows, paired seeds and the censoring guard.
 *
 * The sampled machinery is already proven elsewhere (`test/simulateFight.test.js`, `test/relayFight.test.js`,
 * `test/relayProcTtk.test.js`); this file proves the OBJECTIVE layer: every sampled row names its objective, metric,
 * damage mode, n, horizon and 95% interval; the same inputs reproduce bit for bit; adjacent rows carry a paired
 * difference; censoring cannot be rewarded; and fewer than the declared minimum trials is refused. The ordering
 * reversal lives in `test/stochasticOrdering.test.js` (a relay fixture; the ordinary fight's short-pool reversal is a
 * lead artefact and is not used as evidence). The old four objectives are untouched and are covered by
 * `test/objectives.test.js` and `test/swingDirection.test.js`.
 *
 * Minimum trials is 1,000 (a first pass); a reported mean wants 10,000 and a
 * close ranking 100,000, so 1,000 is a floor, not a resolution claim. Budget: under 10 s (measured ~6 s); this file is
 * in `tools/test-fast.mjs` HEAVY. The oracle-backed paired check is skipped: `relayProcTtk.test.js` already holds the
 * relay sampler's mean TTK within 1% of the vendored compositor, and this layer adds no sampling mechanic of its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_STOCHASTIC_TRIALS, OBJECTIVE_IDS, pairedDifference, rankBuilds, evaluateObjective,
} from '../src/objectives.js';
import { referenceFoe } from '../src/model.js';
import { maxCharacter } from '../src/maxprofile.js';

const OPTS = { core: 'overhaul', rri: true, passiveOn: true, stacks: 5 };
const foe = () => referenceFoe(45, 'tough');
const max = (id) => ({ id, ch: maxCharacter(id) });
const strip = ({ id, rank, ttkSeparated, censoringDiffers, paired, pairedKill, ...row }) => row;

// One shared 1,000-seed fight ranking at a 0.63 s horizon: 126 nearly always kills, 127 kills about a third of the
// seeds. 126's conditional TTK is longer than 127's, so the old kill-rate score would put 127 first; the censoring
// rule must not. `same` and `tiny` are two more evaluateObjective calls: identical inputs, and a sub-resolution
// slowdown that keeps it behind its twin.
const FIGHT_ARGS = { ...OPTS, objective: 'stochastic-ttk', target: foe(), health: 500, trials: MIN_STOCHASTIC_TRIALS, maxSeconds: 0.63 };
const FIGHT = rankBuilds([
  max(126),
  { id: 'same', ch: maxCharacter(126) },
  { id: 'tiny', ch: maxCharacter(126), scenario: { loot: { flat: -0.001 } } },
  max(127),
], FIGHT_ARGS);
const BY_ID = new Map(FIGHT.rows.map((r) => [r.id, r]));

test('3.8: sampled rows name metric and damage mode; censoring cannot be rewarded', () => {
  assert.deepEqual(OBJECTIVE_IDS, ['snapshot', 'fight', 'relay', 'relay-ceiling'], 'the old four are unchanged');
  const rows = FIGHT.rows;
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.equal(r.objective, 'stochastic-ttk');
    assert.equal(r.metric, 'kill-rate');
    assert.equal(r.unit, 'dps');
    assert.equal(r.direction, 'max');
    assert.equal(r.n, MIN_STOCHASTIC_TRIALS);
    assert.equal(r.horizonSeconds, 0.63);
    assert.equal(r.damageMode, 'uncapped', 'the sampled row names the damage mode it sampled');
    assert.equal(r.detail.damageMode, 'uncapped');
    assert.equal(r.ci.metric, 'mean-ttk');
    assert.equal(r.ci.n, r.detail.kills, 'the interval is over the killing trials');
    assert.ok(Number.isFinite(r.ci.lo) && Number.isFinite(r.ci.hi));
    assert.equal(r.detail.samples.length, MIN_STOCHASTIC_TRIALS, 'the per-seed rows are kept for pairing');
    assert.ok(Math.abs(r.value - 500 / r.ci.mean) < 1e-9, 'the kill rate is pool / conditional mean TTK');
  }
  // censoring: 127 kills far fewer seeds; the kill-rate score alone would put it FIRST, the ranking must not
  const high = BY_ID.get(126);
  const low = BY_ID.get(127);
  assert.ok(low.killProbability.hi < high.killProbability.lo, 'the Wilson intervals do not overlap');
  assert.ok(500 / low.ci.mean > 500 / high.ci.mean, 'the conditional kill-rate score alone favours the censor');
  assert.equal(high.censoringDiffers, true);
  assert.equal(low.censoringDiffers, true);
  assert.ok(high.rank < low.rank, 'the higher kill probability ranks first');
  assert.equal(rows[rows.length - 1].id, 127);
  // an identical adjacent pair is never separated, and its interval is exactly [0, 0]
  const same = BY_ID.get('same');
  assert.equal(same.ttkSeparated, false);
  assert.equal(same.paired.metric, 'ttk');
  assert.equal(same.paired.n, same.detail.kills, 'only the seeds both rows kill are paired');
  assert.equal(same.paired.dropped, same.n - same.detail.kills);
  assert.equal(same.paired.mean, 0);
  assert.equal(same.paired.se, 0);
  assert.equal(same.paired.lo, 0);
  assert.equal(same.paired.hi, 0);
  assert.equal(same.paired.containsZero, true);
  // two identical evaluateObjective calls produced identical rows (bookkeeping fields aside)
  assert.deepEqual(strip(same), strip(BY_ID.get(126)));
  // the sub-resolution slowdown stays inside the paired CI: point estimate and rank flag both say not separated
  const tinyDiff = pairedDifference(BY_ID.get('tiny'), BY_ID.get(126));
  assert.equal(tinyDiff.containsZero, true);
  assert.equal(BY_ID.get('tiny').ttkSeparated, false);
  // different trial tables are refused BEFORE any sampler runs: the offending row's own error would be the
  // 1,000-trial minimum, so a post-simulation check would not throw this message
  assert.throws(() => rankBuilds([
    max(126),
    { id: 'b', ch: maxCharacter(126), scenario: { trials: MIN_STOCHASTIC_TRIALS - 1 } },
  ], FIGHT_ARGS), (err) => /different trials, seeds or horizons/.test(err.message) && !/at least 1000 trials/.test(err.message));
  // fewer than the declared minimum is refused
  assert.throws(() => evaluateObjective(maxCharacter(126), { ...FIGHT_ARGS, trials: MIN_STOCHASTIC_TRIALS - 1 }), /at least 1000 trials/);
});

test('3.8: pairedDifference refuses to separate fewer than 8 pairs and uses Student t', () => {
  const row = (seeds, ttks) => ({
    metric: 'kill-rate',
    detail: { samples: seeds.map((seed, i) => ({ seed, kill: true, ttk: ttks[i] })) },
  });
  const small = pairedDifference(
    row([1, 2, 3, 4, 5], [1.0, 2.0, 3.0, 4.0, 5.0]),
    row([1, 2, 3, 4, 5], [1.1, 1.9, 2.9, 3.1, 4.9]),
  );
  assert.equal(small.n, 5);
  assert.equal(small.separated, null, 'five pairs are not enough to claim separation');
  assert.ok(small.lo < 0 && small.hi > 0, 'the interval is still reported');
  const diffs = [1, 2, 1, 2, 1, 2, 1, 2];
  const eight = pairedDifference(
    row([1, 2, 3, 4, 5, 6, 7, 8], diffs.map(() => 10)),
    row([1, 2, 3, 4, 5, 6, 7, 8], diffs.map((d) => 10 - d)),
  );
  assert.equal(eight.n, 8);
  assert.equal(eight.metric, 'ttk');
  assert.equal(eight.separated, true);
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const se = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (diffs.length - 1)) / Math.sqrt(diffs.length);
  assert.ok(Math.abs(eight.ci95 - 2.365 * se) < 1e-12, 'df = 7 uses the t quantile 2.365, not 1.96');
});

test('3.8: kill-probability names its metric, damage mode and Wilson interval', () => {
  const kp = evaluateObjective(maxCharacter(126), {
    ...OPTS, objective: 'kill-probability', target: foe(), health: 500, trials: MIN_STOCHASTIC_TRIALS, maxSeconds: 0.4,
  });
  assert.equal(kp.objective, 'kill-probability');
  assert.equal(kp.metric, 'kill-probability');
  assert.equal(kp.unit, 'probability');
  assert.equal(kp.n, MIN_STOCHASTIC_TRIALS);
  assert.equal(kp.horizonSeconds, 0.4);
  assert.equal(kp.damageMode, 'uncapped');
  assert.equal(kp.detail.damageMode, 'uncapped');
  assert.equal(kp.ci.metric, 'kill-probability');
  assert.equal(kp.ci.method, 'wilson');
  assert.equal(kp.ci.n, kp.n);
  assert.equal(kp.value, kp.detail.kills / kp.n, 'the score is the share that killed');
  assert.ok(kp.ci.lo <= kp.value && kp.value <= kp.ci.hi);
  assert.equal(kp.detail.censored, kp.n - kp.detail.kills);
});
