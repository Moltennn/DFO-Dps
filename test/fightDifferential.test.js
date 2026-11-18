/*
 * test/fightDifferential.test.js - Stage 3.2: seeded blow-only fights against upstream.
 *
 * The oracle (`test/harness/fightOracle.mjs`) receives an event list from the schedule under test and runs every hit
 * through upstream `calculateAttackDamage`; it never receives a local damage, outcome or distribution. The oracle is
 * handed the schedule's event times, so it proves damage and blow counts, NOT timing: the local test derives the
 * schedule's hit/end ticks by stepping the upstream machine. Individual blow outcomes are the Stage 3.1
 * joint-distribution test (`test/blowDifferential.test.js`); this file consumes that same fight tier and compares the
 * fight-level consequences, so the two layers share no outcome table.
 *
 * Distribution comparison is on integer blow counts (a two-sample Pearson chi-square over fixed 10-blow bins, plus a
 * bin-free two-sample Kolmogorov-Smirnov distance), and on TTK/damage means and quantiles. Thresholds are fixed here:
 * blow-count chi z <= 3.5, KS <= 1.95*sqrt(2/n) (alpha 0.001), mean z <= 4, and median/p10/p90 inside 5% of the
 * upstream sample. They were chosen before the runs and are not adjusted to a result. The local runs pass `carry: false`
 * explicitly: the oracle is upstream's fresh-item damage, which carries no held percentage remainder.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, referenceFoe, weaponOf } from '../src/model.js';
import { createAttackSchedule, simulateFights, summarize } from '../src/simulateFight.js';
import { blowFightTier, tierMeans } from '../src/blowOutcomes.js';
import { upstream, referenceFoe as upstreamReferenceFoe } from './harness/upstream.mjs';
import { oracleEntity } from './harness/upstreamBodies.mjs';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { oracleItem, upstreamFight } from './harness/fightOracle.mjs';
import { sampleJointBlow } from './harness/blowOracle.mjs';

const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const ECHO = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});

const single = () => { const item = weapon(121, { material: 9 }); return { ch: simCharacter(BASIC(), item), item }; };
const dual = () => {
  const item = weapon(121, { material: 9 });
  const ch = simCharacter(BASIC(), item);
  ch.offWeapon = { ...item, equipSlot: 21 };
  ch._dual = true;
  return { ch, item, offItem: { ...item, equipSlot: 21 } };
};

/** Enough events for any test pool; the fight loop stops at the kill. */
function eventsOf(ch, args, n = 20000) {
  const s = createAttackSchedule(ch, args);
  assert.ok(s, 'a schedule');
  return Array.from({ length: n }, () => s.next());
}

function upstreamBodyAt(u, pool) {
  const body = upstreamReferenceFoe(u, 30, 'tough');
  body.health = pool;
  body.maxHealth = pool;
  return body;
}

const meanZ = (a, b) => {
  const se = Math.hypot(a.se, b.se);
  return se > 0 ? (a.mean - b.mean) / se : (a.mean === b.mean ? 0 : Infinity);
};
const quantileClose = (local, oracle, key, relative = 0.05, floor = 0.05) => {
  const allowed = Math.max(floor, Math.abs(oracle[key]) * relative);
  assert.ok(Math.abs(local[key] - oracle[key]) <= allowed, `${key}: ${local[key]} vs ${oracle[key]} (allowed ${allowed})`);
};
/**
 * Two-sample Pearson chi-square for integer blow counts.
 *
 * The local and oracle samples are independent (different generators, and different draw sequences even when the
 * seed matches). Under H0 the expected count in a cell is the pooled mean, (local + oracle) / 2 - not the local
 * count. Using one sample's OBSERVED count as the other sample's expectation adds that sample's variance to every
 * term and roughly doubles the statistic: the first version of this test did that and reported z ~ 4.6 on samples
 * whose means and quantiles agree to a fraction of a percent. Fixed 10-blow bins keep cells comparable; cells with
 * fewer than 10 pooled observations are gathered into one tail cell. df = bins - 1, pooled included.
 */
const chiBlows = (local, oracle) => {
  const bins = new Map();
  for (const r of local.rows) {
    const k = Math.floor(r.blows / 10);
    const b = bins.get(k) ?? [0, 0];
    b[0] += 1;
    bins.set(k, b);
  }
  for (const r of oracle) {
    const k = Math.floor(r.blows / 10);
    const b = bins.get(k) ?? [0, 0];
    b[1] += 1;
    bins.set(k, b);
  }
  let chi = 0;
  let df = 0;
  let pooledLocal = 0;
  let pooledOracle = 0;
  for (const [e, o] of bins.values()) {
    const total = e + o;
    if (total < 10) { pooledLocal += e; pooledOracle += o; continue; }
    chi += ((e - o) ** 2) / total;
    df += 1;
  }
  if (pooledLocal + pooledOracle >= 10) {
    chi += ((pooledLocal - pooledOracle) ** 2) / (pooledLocal + pooledOracle);
    df += 1;
  }
  df = Math.max(1, df - 1);
  return (Math.cbrt(chi / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
};

/** Two-sample Kolmogorov-Smirnov distance, bin-free and insensitive to bin width. */
const ksBlows = (local, oracle) => {
  const a = local.rows.map((r) => r.blows).sort((x, y) => x - y);
  const b = oracle.map((r) => r.blows).sort((x, y) => x - y);
  let d = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const v = Math.min(a[i], b[j]);
    while (i < a.length && a[i] === v) i += 1;
    while (j < b.length && b[j] === v) j += 1;
    d = Math.max(d, Math.abs(i / a.length - j / b.length));
  }
  return d;
};

async function compareScenario({ id, desc, ch, item, offItem = null, pool, trials = 400, seed = 0x3200 }) {
  const u = await upstream();
  const target = referenceFoe(30, 'tough');
  const args = {
    target, health: pool, weapon: weaponOf(item), seed, trials,
    ...(offItem ? { dual: true } : {}),
  };
  const local = simulateFights(ch, { ...args, carry: false });
  const events = eventsOf(ch, args);
  const upstreamRows = [];
  const upItem = oracleItem(item);
  const upOff = offItem ? oracleItem(offItem) : null;
  for (const s of local.seeds) {
    const body = oracleEntity(upstreamBodyAt(u, pool));
    upstreamRows.push(upstreamFight(u, {
      desc, item: upItem, offItem: upOff, body, events,
      seed: s, uptime: args.backstabUptime ?? 0, traits: [],
    }));
  }
  const upTtk = summarize(upstreamRows.filter((r) => r.ttk != null).map((r) => r.ttk));
  const upDamage = summarize(upstreamRows.map((r) => r.damageDealt));
  assert.ok(local.ttk && upTtk, `${id}: both kill`);
  assert.ok(Math.abs(meanZ(local.ttk, upTtk)) <= 4, `${id}: ttk mean z ${meanZ(local.ttk, upTtk).toFixed(2)} (${local.ttk.mean.toFixed(3)} vs ${upTtk.mean.toFixed(3)})`);
  quantileClose(local.ttk, upTtk, 'median');
  quantileClose(local.ttk, upTtk, 'p10');
  quantileClose(local.ttk, upTtk, 'p90');
  assert.ok(Math.abs(meanZ(local.damageDealt, upDamage)) <= 4, `${id}: damage mean z ${meanZ(local.damageDealt, upDamage).toFixed(2)}`);
  const zBlows = chiBlows(local, upstreamRows);
  assert.ok(zBlows <= 3.5, `${id}: blow-count chi z ${zBlows.toFixed(2)}`);
  const ks = ksBlows(local, upstreamRows);
  const ksCrit = 1.95 * Math.sqrt(2 / local.rows.length);
  assert.ok(ks <= ksCrit, `${id}: blow-count KS ${ks.toFixed(4)} > ${ksCrit.toFixed(4)}`);
  return { local, upstreamRows, upTtk };
}

test('1. single-melee fight distribution matches upstream', async () => {
  const { ch, item } = single();
  await compareScenario({ id: 'single', desc: BASIC(), ch, item, pool: 12000, trials: 1000, seed: 0x3201 });
});

test('2. dual-wield fight distribution and hand schedule match upstream', async () => {
  const { ch, item, offItem } = dual();
  const s = createAttackSchedule(ch, { target: referenceFoe(30, 'tough'), health: 12000, weapon: weaponOf(item), dual: true });
  const events = Array.from({ length: 6 }, () => s.next());
  const m = analyze(ch, { target: referenceFoe(30, 'tough'), health: 12000, weapon: weaponOf(item), dual: true }).cadence.tick;
  const o = analyze(ch, { target: referenceFoe(30, 'tough'), health: 12000, weapon: weaponOf(item), dual: true }).offHand.cadence.tick;
  // upstream constants: a fresh lead's hit frame 2, flurry hit one tick in (2 - FLURRY_FROM_FRAME)
  assert.ok(Math.abs(events[0].t - 2 * m) < 1e-12);
  assert.equal(events[1].hand, 'off');
  assert.ok(Math.abs(events[1].t - (5 * m + 1 * o)) < 1e-12);
  assert.equal(events[2].hand, 'main');
  await compareScenario({ id: 'dual', desc: BASIC(), ch, item, offItem, pool: 12000, trials: 700, seed: 0x3202 });
});

test('3. a venom half-health fight rebuilds at half and matches upstream', async () => {
  const item = { ...weapon(121, { material: 9 }), rarity: 'rare', imprint: 'tsaesci-fang' };
  const ch = simCharacter(BASIC(), item);
  await compareScenario({ id: 'venom half-health', desc: BASIC(), ch, item, pool: 2000, trials: 800, seed: 0x3203 });
  const local = simulateFights(ch, { target: referenceFoe(30, 'tough'), health: 2000, weapon: weaponOf(item), trials: 50, seed: 0x3203, carry: false });
  const crossed = local.rows.filter((r) => r.segments.length > 1);
  assert.ok(crossed.length > 0, 'the local fights cross the half-health segment');
  const seg = crossed[0].segments;
  const above = seg.find((x) => x.share > 0.5);
  const below = seg.find((x) => x.share < 0.5);
  assert.ok(above && below, `both segments present: ${JSON.stringify(seg)}`);
  assert.ok(below.damage / below.blows > above.damage / above.blows, 'venom raises the below-half blow');
});

test('4. an ordinary-foe echo fight matches upstream', async () => {
  const item = { ...weapon(121, { material: 9 }), rarity: 'rare', imprint: 'warp-edge' };
  const ch = simCharacter(ECHO(), item);
  await compareScenario({ id: 'echo', desc: ECHO(), ch, item, pool: 12000, trials: 700, seed: 0x3204 });
});


/**
 * The exact threshold boundary. The fight oracle's health is updated per blow, but an aggregate TTK over a pool can
 * hide a one-blow boundary error. These cases step the target's own share to 0.51 / 0.50 / 0.49 (venom) and
 * 0.26 / 0.25 / 0.24 (an execute power) and compare the per-blow mean with upstream's blows at that same share.
 */
test('5. health thresholds: the venom 0.5 and execute 0.25 boundaries match upstream at the exact share', async () => {
  const u = await upstream();
  const target = referenceFoe(30, 'tough');
  const pool = 2000;
  const draws = 40000;
  const atShare = (desc, item, ch, share, seed) => {
    const body = upstreamBodyAt(u, pool);
    body.health = share * pool;
    body.maxHealth = pool;
    const sample = sampleJointBlow(u, { desc, item: oracleItem(item), body, hand: 'main', seed, draws });
    const mean = sample.agg.sum / sample.draws;
    const se = Math.sqrt(Math.max(0, sample.agg.sumSq / sample.draws - mean * mean) / sample.draws);
    const tier = blowFightTier(ch, { target, health: pool, weapon: weaponOf(item), healthShare: share, hand: 'main' });
    const expected = tierMeans(tier).perSwing;
    const z = se > 0 ? (mean - expected) / se : 0;
    return { expected, mean, se, z };
  };

  // venom's flat doubles below 0.5 (systems/loot/lootPowers.js:320) - a boundary every build can carry
  const venomItem = { ...weapon(121, { material: 9 }), rarity: 'rare', imprint: 'tsaesci-fang' };
  const venomCh = simCharacter(BASIC(), venomItem);
  for (const [i, share] of [0.51, 0.5, 0.49].entries()) {
    const r = atShare(BASIC(), venomItem, venomCh, share, 0x3210 + i * 37);
    assert.ok(Math.abs(r.z) <= 3.5, `venom at share ${share}: local ${r.expected.toFixed(4)} vs upstream ${r.mean.toFixed(4)} (z ${r.z.toFixed(2)})`);
  }
  const venomAbove = tierMeans(blowFightTier(venomCh, { target, health: pool, weapon: weaponOf(venomItem), healthShare: 0.51, hand: 'main' })).perSwing;
  const venomBelow = tierMeans(blowFightTier(venomCh, { target, health: pool, weapon: weaponOf(venomItem), healthShare: 0.49, hand: 'main' })).perSwing;
  assert.ok(venomBelow > venomAbove, `venom must raise the below-half blow (${venomBelow} vs ${venomAbove})`);

  const execItem = { ...weapon(121, { material: 9 }), rarity: 'legendary', legendary: 'night-mothers-embrace' };
  const execCh = simCharacter(BASIC(), execItem);
  for (const [i, share] of [0.26, 0.25, 0.24].entries()) {
    const r = atShare(BASIC(), execItem, execCh, share, 0x3220 + i * 41);
    assert.ok(Math.abs(r.z) <= 3.5, `execute at share ${share}: local ${r.expected.toFixed(4)} vs upstream ${r.mean.toFixed(4)} (z ${r.z.toFixed(2)})`);
  }
  const execAbove = tierMeans(blowFightTier(execCh, { target, health: pool, weapon: weaponOf(execItem), healthShare: 0.26, hand: 'main' })).perSwing;
  const execBelow = tierMeans(blowFightTier(execCh, { target, health: pool, weapon: weaponOf(execItem), healthShare: 0.24, hand: 'main' })).perSwing;
  assert.ok(execBelow > execAbove, `the execute power must raise the below-threshold blow (${execBelow} vs ${execAbove})`);
});
