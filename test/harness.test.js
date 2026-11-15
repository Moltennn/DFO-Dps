/*
 * test/harness.test.js - the harness must itself be trustworthy: reproducible
 * randomness, exact/tolerant comparison, readable discrepancy reports, stale
 * waivers caught, and an injected error actually detected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mulberry32, xoshiro128ss, summarize } from './harness/prng.mjs';
import { compareCase, firstDifference, runStage, formatReport, compareSample } from './harness/differential.mjs';
import { WAIVERS } from './harness/waivers.mjs';

const sequence = (rng, n) => Array.from({ length: n }, () => rng());

test('prng: same seed, same stream; different seeds differ', () => {
  for (const gen of [mulberry32, xoshiro128ss]) {
    assert.deepEqual(sequence(gen(1234), 8), sequence(gen(1234), 8), `${gen.name} reproducible`);
    assert.notDeepEqual(sequence(gen(1), 8), sequence(gen(2), 8), `${gen.name} seeds independent`);
  }
});

test('prng: uniform enough - mean, deciles and low-bit balance', () => {
  for (const gen of [mulberry32, xoshiro128ss]) {
    const xs = sequence(gen(0xabcdef), 200000);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    assert.ok(Math.abs(mean - 0.5) < 0.005, `${gen.name} mean ${mean.toFixed(4)}`);
    const bins = new Array(10).fill(0);
    for (const x of xs) bins[Math.min(9, Math.floor(x * 10))]++;
    for (const b of bins) assert.ok(Math.abs(b / xs.length - 0.1) < 0.01, `${gen.name} decile ${b}`);
    const lowBit = xs.filter((x) => (Math.floor(x * 2 ** 32) & 1) === 1).length / xs.length;
    assert.ok(Math.abs(lowBit - 0.5) < 0.01, `${gen.name} low bit ${lowBit.toFixed(4)} (an LCG fails here)`);
    // lag-1 autocorrelation of the stream must be ~0
    const m = mean;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      den += (xs[i] - m) ** 2;
      if (i) num += (xs[i] - m) * (xs[i - 1] - m);
    }
    assert.ok(Math.abs(num / den) < 0.02, `${gen.name} lag-1 autocorrelation ${(num / den).toFixed(4)}`);
  }
});

test('summary: mean and a 95% interval that narrows with n', () => {
  const r = mulberry32(7);
  const sample = Array.from({ length: 4000 }, () => r());
  const s = summarize(sample);
  assert.ok(Math.abs(s.mean - 0.5) < 0.02);
  assert.ok(s.ci95 > 0 && s.ci95 < 0.02);
  const bigger = summarize(Array.from({ length: 16000 }, () => mulberry32(8)()));
  assert.ok(bigger.ci95 < s.ci95);
});

test('compare: exact equality is bit-for-bit; tolerance is explicit and scaled', () => {
  assert.ok(compareCase({ expected: { a: 1, b: [1, 2] }, actual: { a: 1, b: [1, 2] } }).ok);
  const exact = compareCase({ expected: 0.1 + 0.2, actual: 0.3 });
  assert.equal(exact.ok, false);
  assert.equal(exact.diff.at, '(value)');
  assert.ok(compareCase({ expected: 1000.0001, actual: 1000, tolerance: 1e-6, scale: 1000 }).ok, 'relative tolerance');
  assert.equal(compareCase({ expected: 1000.1, actual: 1000, tolerance: 1e-6, scale: 1000 }).ok, false);
});

test('compare: the first divergence is reported with a path', () => {
  const d = firstDifference({ a: [1, 2, 3], b: { c: 4 } }, { a: [1, 9, 3], b: { c: 4 } });
  assert.equal(d.at, 'a[1]');
  assert.equal(d.expected, 9);
  assert.equal(d.actual, 2);
  assert.equal(d.delta, -7);
});

test('runStage: discrepancy report names the input, both answers and the divergence point', async () => {
  const cases = [
    { id: 'odd', input: { n: 3 } },
    { id: 'even', input: { n: 4 } },
  ];
  const report = await runStage({
    name: 'demo stage',
    cases,
    waivers: WAIVERS,
    upstream: ({ n }) => n * 2,
    simulator: ({ n }) => n * 2 + (n === 3 ? 1 : 0),
  });
  assert.equal(report.failures.length, 1);
  const text = formatReport(report);
  assert.match(text, /demo stage: odd/);
  assert.match(text, /input:\s+\{"n":3\}/);
  assert.match(text, /upstream:\s+6/);
  assert.match(text, /simulator:\s+7/);
  assert.match(text, /diverged at:/);
});

test('runStage: a stale waiver fails instead of passing silently', async () => {
  const report = await runStage({
    name: 'stale',
    cases: [{ id: 'x', input: {}, waived: 'W-WARD' }],
    waivers: WAIVERS,
    upstream: () => 1,
    simulator: () => 1,
  });
  assert.equal(report.failures.length, 0);
  assert.equal(report.staleWaivers.length, 1);
  assert.match(formatReport(report), /stale waiver W-WARD/);
});

test('an intentionally introduced discrepancy is detected end to end', async () => {
  // The "simulator" here is the vendored oracle with one term nudged by 2% -
  // exactly the kind of silent drift a formula edit can introduce.
  const { upstream, pcaaoModules } = await import('./harness/upstream.mjs');
  const u = await upstream();
  const modules = pcaaoModules(u);
  const p = {
    isPlayer: true, level: 30, raceId: 4,
    stats: { strength: 80, intelligence: 50, willpower: 50, agility: 70, endurance: 50, personality: 50, speed: 70, luck: 50 },
    skills: Array.from({ length: 35 }, () => 70),
    career: { weaponArmorShieldsBitfield: 2 << 16, abilityFlagsAndSpellPointsBitfield: 0 },
    health: 100, maxHealth: 100, activeEffects: [], _mods: { stats: {}, skills: {} }, _enchantMods: { skillMods: {} },
  };
  const item = { group: 'Weapons', templateIndex: 121, material: 9, maxCondition: 1000, currentCondition: 1000 };
  const prise = (u.combatStats.computeCombatStats(p, { core: 'overhaul', weapon: item, modules }).head.byFoe[1]);
  const mutated = { ...prise, dmg: { ...prise.dmg, avg: prise.dmg.avg * 1.02 } };

  const report = await runStage({
    name: 'mutant',
    cases: [{ id: 'mutant-damage', input: { templateIndex: 121 } }],
    waivers: WAIVERS,
    mode: 'close',
    tolerance: 1e-12,
    upstream: () => prise.dmg.avg,
    simulator: () => mutated.dmg.avg,
  });
  assert.equal(report.failures.length, 1, 'a 2% drift is caught');
  assert.ok(report.failures[0].delta > 0.5, `delta reported: ${report.failures[0].delta}`);
  // A tolerance is an explicit, reviewed choice: the same 2% drift passes only
  // where a 5% band is written down, never by accident.
  const loose = await runStage({
    name: 'mutant-loose',
    cases: [{ id: 'mutant-damage', input: {} }],
    waivers: WAIVERS,
    mode: 'close',
    tolerance: 0.05,
    upstream: () => prise.dmg.avg,
    simulator: () => mutated.dmg.avg,
  });
  assert.equal(loose.failures.length, 0, 'inside a declared 5% band');
});

test('sampled comparison: an expectation inside the confidence interval passes, outside fails', () => {
  const rng = mulberry32(99);
  const sample = Array.from({ length: 4000 }, () => 10 + rng());
  const s = summarize(sample);
  assert.ok(compareSample({ expected: sample, actual: s.mean }).ok);
  assert.ok(compareSample({ expected: sample, actual: s.mean + 3 * s.ci95 }).ok === false);
  assert.ok(compareSample({ expected: sample, actual: s.mean + 0.5 * s.ci95 }).ok);
});
