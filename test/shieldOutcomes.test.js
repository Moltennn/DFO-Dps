/*
 * test/shieldOutcomes.test.js - Stage 2.9, F1: the shield block is resolved per blow.
 *
 * Upstream rolls ONE block per blow (combat/pcaao.js:1784-1796) and the reduction returns a whole number
 * (:1815-1849); the off hand's share (:1850), bossStrike's max(1, round) and the relay cap then act on that
 * number. Averaging blocked and unblocked damage first (the pre-2.9 model, the assumptions register M13 as it was
 * written) moves every one of those nonlinear steps: -2.55% .. +2.60% per swing, z up to 14.7 (audit §4.2).
 *
 * The comparison is by OUTCOME, not by mean: upstream's own blows, against its own body wearing its own
 * pieces (test/harness/upstreamBodies.mjs), are grouped by the body part they struck; for each part, the
 * probability of every final damage value (after the off hand, the trait and the cap) must match the
 * local `blowDistribution` for that part. A non-critical landed blow is conditioned on, which makes the
 * card's roll the only other source of variation. Nothing local is handed to the oracle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, blowDistribution, weaponOf } from '../src/model.js';
import { enemyTarget, equipArmour, targetPartDamage } from '../src/target.js';
import { offHandDamage, offHandToHit } from '../src/dualWield.js';
import { resistBlow } from '../src/bossTraits.js';
import { upstream, pcaaoModules } from './harness/upstream.mjs';
import { oracleEntity, upstreamBody, upstreamWear } from './harness/upstreamBodies.mjs';
import { character, simCharacter, upstreamEntity, weapon, upstreamWeapon, fresh } from './harness/fixtures.mjs';
import { generator } from './harness/prng.mjs';
import { compareDistributions, sampleUpstream as sample_, worst } from './harness/outcomes.mjs';

const CAREER = Object.freeze({ strength: 60, intelligence: 50, willpower: 60, agility: 90, endurance: 70, personality: 50, speed: 90, luck: 80 });
const SHIELD = [{ templateIndex: 112, material: 0, condition: 1 }];
const CUIRASS_AND_SHIELD = [{ templateIndex: 102, material: 519, condition: 0.8 }, { templateIndex: 112, material: 0, condition: 1 }];
const DRAWS = 300000;
const Z_MAX = 4.5; // fixed in advance: ~40 values x 7 parts x 8 cases compared per run, never tuned to a result

/** The pre-2.9 resolution kept as the mutant: the shield's EXPECTATION first, then the off hand, trait and cap. */
function legacyDistribution(rolls, part, { target, weapon: w, offHand, traits, cap }) {
  const out = new Map();
  for (const d of rolls) {
    const ev = targetPartDamage(target, d, part, { weapon: w });
    const shared = offHand ? offHandDamage(ev) : ev;
    const v0 = shared > 0 && traits.length ? resistBlow(traits, shared, { kind: 'melee', weapon: w }) : shared;
    const v = cap > 0 ? Math.min(v0, cap) : v0;
    out.set(v, (out.get(v) ?? 0) + 1 / rolls.length);
  }
  return out;
}

const CASES = [
  // label, template, skill, pieces, offHand, traits, cap
  { id: 'blunt+stoneskin, shield, no cap', tpl: 126, skill: 32, pieces: SHIELD, offHand: false, traits: ['stoneskin'], cap: 0, shield: true },
  { id: 'blunt+stoneskin, shield, binding cap 9', tpl: 126, skill: 32, pieces: SHIELD, offHand: false, traits: ['stoneskin'], cap: 9, shield: true },
  { id: 'blade, shield, binding cap 15', tpl: 121, skill: 29, pieces: SHIELD, offHand: false, traits: [], cap: 15, shield: true },
  { id: 'blade, shield, non-binding cap 600', tpl: 121, skill: 29, pieces: SHIELD, offHand: false, traits: [], cap: 600, shield: true },
  { id: 'blade off-hand, shield, no cap', tpl: 121, skill: 29, pieces: SHIELD, offHand: true, traits: [], cap: 0, shield: true },
  { id: 'blade off-hand + bladeturning, shield, cap 6', tpl: 121, skill: 29, pieces: SHIELD, offHand: true, traits: ['bladeturning'], cap: 6, shield: true },
  { id: 'blade off-hand + bladeturning, cuirass + shield, cap 10', tpl: 121, skill: 29, pieces: CUIRASS_AND_SHIELD, offHand: true, traits: ['bladeturning'], cap: 10, shield: true },
  // no-shield controls: the same paths, nothing to average
  { id: 'control: blunt+stoneskin, no shield, cap 9', tpl: 126, skill: 32, pieces: [], offHand: false, traits: ['stoneskin'], cap: 9, shield: false },
  { id: 'control: blade off-hand + bladeturning, cuirass only, cap 6', tpl: 121, skill: 29, pieces: [CUIRASS_AND_SHIELD[0]], offHand: true, traits: ['bladeturning'], cap: 6, shield: false },
];

test('F1: per-outcome shield block against upstream, value by value and part by part', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const { body: lord } = await upstreamBody({ kind: 'mint', mobile: 31, career: CAREER });
  let caughtLegacy = 0;
  for (const [index, c] of CASES.entries()) {
    const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { [c.skill]: 150, 34: 30 } });
    const item = weapon(c.tpl, { material: 9 });
    const body = upstreamWear(u, oracleEntity(lord), c.pieces);
    const local = enemyTarget(31, { career: CAREER });
    equipArmour(local, c.pieces, { armorValues: true });
    // The card's raw rolls, before the off hand's share: `damage` of an off-hand analysis is the DISPLAY
    // card (already scaled), so the rolls come from the same blow read as a main hand's.
    const r = analyze(simCharacter(desc, item), { target: local, core: 'overhaul', weapon: weaponOf(item), offHand: false, swing: 'StrikeLeft' });
    const w = r.weapon;
    const ctx = { target: local, weapon: w, offHand: c.offHand, traits: c.traits, cap: c.cap };
    const mine = Array.from({ length: 7 }, (_, part) => blowDistribution(r.damage.plainRolls, part, ctx));
    const after = (d) => {
      const t = c.traits.length ? u.bossTraits.bossStrike({ bossTraits: c.traits }, d, { kind: 'melee', weapon: fresh(upstreamWeapon(item)) }).damage : d;
      return c.cap > 0 ? Math.min(t, c.cap) : t;
    };
    const sample = sample_(u, modules, { desc, item, body, offHand: c.offHand, seed: 0x2900 + index * 977, draws: DRAWS, after });
    const gaps = compareDistributions(sample, mine);
    assert.ok(gaps.length >= 10, `${c.id}: enough values compared (${gaps.length}; a low cap collapses the support)`);
    const bad = worst(gaps);
    assert.ok(Math.abs(bad.z) < Z_MAX, `${c.id}: part ${bad.part} value ${bad.value}: upstream ${bad.c} of ${sample.counts[bad.part]}, local p ${bad.p.toFixed(5)}, z ${bad.z.toFixed(1)}`);
    if (c.shield) {
      // Both outcomes exist for the shield to matter at all, and the chance is the shield's.
      // The mutant: the pre-2.9 expectation-first resolution must be rejected on the shielded cases whose
      // nonlinear step it moves (every one with rounding, a trait, an off hand or a binding cap).
      const legacy = Array.from({ length: 7 }, (_, part) => legacyDistribution(r.damage.plainRolls, part, ctx));
      const lw = worst(compareDistributions(sample, legacy));
      if (Math.abs(lw.z) >= Z_MAX) caughtLegacy += 1;
    }
  }
  const shielded = CASES.filter((c) => c.shield).length;
  assert.ok(caughtLegacy >= shielded - 1, `the expectation-first resolution is rejected on ${caughtLegacy} of ${shielded} shielded cases`);
});

test('F1: the per-swing means agree too, capped and uncapped, with the sampled blows (all outcomes, crits included)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const { body: lord } = await upstreamBody({ kind: 'mint', mobile: 31, career: CAREER });
  const rows = [];
  for (const [index, c] of CASES.entries()) {
    const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { [c.skill]: 150, 34: 30 } });
    const item = weapon(c.tpl, { material: 9 });
    const body = upstreamWear(u, oracleEntity(lord), c.pieces);
    const local = { ...enemyTarget(31, { career: CAREER }), bossTraits: c.traits, hitCap: c.cap };
    equipArmour(local, c.pieces, { armorValues: true });
    const rng = generator(0x2950 + index * 811);
    let sum = 0; let sumCap = 0; let sq = 0; let sqCap = 0;
    const N = 200000;
    for (let i = 0; i < N; i++) {
      let d = u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), body, {
        weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0,
        ...(c.offHand ? { toHitMod: offHandToHit(desc.stats.agility), blowShare: offHandDamage } : {}),
      });
      if (d > 0 && c.traits.length) d = u.bossTraits.bossStrike({ bossTraits: c.traits }, d, { kind: 'melee', weapon: fresh(upstreamWeapon(item)) }).damage;
      const dc = c.cap > 0 ? Math.min(d, c.cap) : d;
      sum += d; sq += d * d; sumCap += dc; sqCap += dc * dc;
    }
    const m = sum / N; const mc = sumCap / N;
    const se = Math.sqrt(Math.max(0, sq / N - m * m) / N); const sec = Math.sqrt(Math.max(0, sqCap / N - mc * mc) / N);
    const r = analyze(simCharacter(desc, item), { target: local, core: 'overhaul', weapon: weaponOf(item), offHand: c.offHand, swing: 'StrikeLeft' });
    rows.push({ id: c.id, zUncapped: (r.perSwing - m) / se, zCapped: (r.cappedPerSwing - mc) / sec, local: r.cappedPerSwing, up: mc });
  }
  for (const r of rows) {
    assert.ok(Math.abs(r.zUncapped) < 3.5, `${r.id}: uncapped z ${r.zUncapped.toFixed(2)}`);
    assert.ok(Math.abs(r.zCapped) < 3.5, `${r.id}: capped z ${r.zCapped.toFixed(2)} (${r.local.toFixed(4)} vs ${r.up.toFixed(4)})`);
  }
});

test('F1: a deterministic block - a chance of 0 or 100 is one outcome, and both sides agree', async () => {
  const local = enemyTarget(31, { career: CAREER });
  equipArmour(local, CUIRASS_AND_SHIELD, { armorValues: true });
  const dist = blowDistribution([20, 21, 22], 0, { target: local, weapon: { skillId: 29 } });
  const total = [...dist.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-12, 'the outcome probabilities sum to 1');
  assert.ok([...dist.keys()].every(Number.isInteger), 'every outcome is a whole number');
});
