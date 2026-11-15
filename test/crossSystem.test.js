/*
 * test/crossSystem.test.js - Stage 2.9, Phase 6: the five fixes together.
 *
 * Each scenario composes several of this stage's changes in ONE blow, so an ordering interaction the isolated
 * tests cannot see would show here. The reference is upstream's whole blow (formulas.js calculateAttackDamage,
 * the tail's payloads included) on a body upstream built, then the host's steps in the order the host takes
 * them (a shaft's pull -> the boss trait -> the relay cap). Nothing local is handed to the oracle.
 *
 *   A  shield x long bow x boss trait x per-hit cap         (F1, long bow)
 *   B  injured Berserker x loot line x Potent Vs x trait x cap  (Berserker, F2)
 *   C  Shadowdancer near the stat ceiling x off hand x shield x trait x cap  (stat cap, F1)
 *   D  Pistolet pair, each hand: loot % + flat + Potent Vs, off hand at 0.8   (F2, pair)
 *   E  dual wield: the imprint on the main hand only, enchantment pricing under a backstab (F2, dual, backstab)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, weaponOf } from '../src/model.js';
import { enemyTarget, equipArmour, standInTarget } from '../src/target.js';
import { WEAPONS } from '../src/data.js';
import { upstream } from './harness/upstream.mjs';
import { oracleEntity, upstreamBody, upstreamWear } from './harness/upstreamBodies.mjs';
import { character, simCharacter, upstreamEntity, weapon, upstreamWeapon } from './harness/fixtures.mjs';
import { pathHolder, sampleCalc } from './harness/outcomes.mjs';

const CAREER = Object.freeze({ strength: 60, intelligence: 50, willpower: 60, agility: 90, endurance: 70, personality: 50, speed: 90, luck: 80 });
const SHIELD = [{ templateIndex: 112, material: 0, condition: 1 }];
const DRAWS = 250000;
const Z = 3.5;

const hostSteps = (u, { item, kind = 'melee', pull = null, traits = [], cap = 0 }) => (d) => {
  const pulled = pull ? u.bowBloom.bowFastDamage(pull, d) : d;
  const t = traits.length ? u.bossTraits.bossStrike({ bossTraits: traits }, pulled, { kind, weapon: upstreamWeapon(item) }).damage : pulled;
  return cap > 0 ? Math.min(t, cap) : t;
};
const check = (id, local, up) => {
  const z = (local - up.mean) / up.se;
  assert.ok(Math.abs(z) < Z, `${id}: local ${local.toFixed(4)} vs upstream ${up.mean.toFixed(4)} +/- ${(1.96 * up.se).toFixed(4)} (z ${z.toFixed(2)})`);
};

test('A: shield x long bow x bladeturning arrows x a binding cap', async () => {
  const u = await upstream();
  const { body: lord } = await upstreamBody({ kind: 'mint', mobile: 31, career: CAREER });
  const body = upstreamWear(u, oracleEntity(lord), SHIELD);
  const local = enemyTarget(31, { career: CAREER });
  equipArmour(local, SHIELD, { armorValues: true });
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 33: 150, 34: 30 } });
  const item = weapon(130, { material: 9 });
  for (const [i, cap] of [0, 14, 600].entries()) {
    const traits = ['bladeturning'];
    const up = sampleCalc(u, { attacker: pathHolder(u, { desc }), body, item, seed: 0x3100 + i * 71, draws: DRAWS, after: hostSteps(u, { item, kind: 'arrow', pull: { pull: 1.5, fast: 0 }, traits, cap }) });
    const r = analyze(simCharacter(desc, item), { target: { ...local, bossTraits: traits, hitCap: cap }, core: 'overhaul', weapon: weaponOf(item) });
    check(`A cap ${cap}`, cap > 0 ? r.cappedPerSwing : r.perSwing, up);
  }
});

test('B: injured Berserker (attacker 40%, foe 100%) x loot line x Potent Vs x stoneskin x cap', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 32: 150, 34: 30 }, martialPath: 'berserker', masterSkills: true });
  const item = weapon(126, { material: 9 });
  const affixes = [{ id: 'slayer', param: 'daedra', value: 30 }, { id: 'elemental', param: 'fire', value: 8 }];
  const enchantments = [{ type: 4, param: 1 }];
  const target = standInTarget(31);
  let k = 0;
  for (const [self, foe] of [[0.4, 1], [1, 0.2], [0.4, 0.2]]) {
    for (const cap of [0, 25]) {
      const traits = ['stoneskin'];
      const attacker = pathHolder(u, { path: 'berserker', desc, health: self * 1000, maxHealth: 1000 });
      const hurtBody = { ...body, health: foe * 1000, maxHealth: 1000 };
      const up = sampleCalc(u, { attacker, body: hurtBody, item, extra: { affixes, enchantments, isIdentified: true }, seed: 0x3200 + (k++) * 53, draws: DRAWS, after: hostSteps(u, { item, traits, cap }) });
      const base = analyze(simCharacter(desc, item), { target: { ...target, bossTraits: traits, hitCap: cap }, core: 'overhaul', weapon: weaponOf(item), attackerHealthShare: self, healthShare: foe });
      const priced = base.with({ loot: { pct: 30, flat: 8 }, potentVs: 5 });
      check(`B self ${self} foe ${foe} cap ${cap}`, cap > 0 ? priced.cappedPerSwing : priced.perSwing, up);
    }
  }
});

test('C: Shadowdancer at Agility 95 (+10 clamps to 100) x off hand x shield x bladeturning x cap', async () => {
  const u = await upstream();
  const { body: lord } = await upstreamBody({ kind: 'mint', mobile: 31, career: CAREER });
  const body = upstreamWear(u, oracleEntity(lord), SHIELD);
  const local = enemyTarget(31, { career: CAREER });
  equipArmour(local, SHIELD, { armorValues: true });
  // a weak attacker so the Agility term is not hidden by the 97% ceiling
  const desc = character({ level: 12, raceId: 1, stats: { strength: 70, agility: 95, speed: 60, luck: 40 }, skills: 0, skillOverride: { 29: 45, 34: 20 }, martialPath: 'shadowdancer', masterSkills: true });
  const item = weapon(121, { material: 6 });
  for (const [i, offHand] of [false, true].entries()) {
    const traits = ['bladeturning'];
    const cap = 9;
    const attacker = pathHolder(u, { path: 'shadowdancer', desc });
    assert.equal(u.statMods.liveStat(attacker, 'agility'), 100, 'upstream clamps 95 + 10 at 100');
    const up = sampleCalc(u, { attacker, body, item, offHand, seed: 0x3300 + i * 97, draws: DRAWS, after: hostSteps(u, { item, traits, cap }) });
    const r = analyze(simCharacter(desc, item), { target: { ...local, bossTraits: traits, hitCap: cap }, core: 'overhaul', weapon: weaponOf(item), offHand });
    assert.ok(r.hit.hit < 0.9, `the hit chance is below the ceiling (${r.hit.hit.toFixed(3)})`);
    check(`C ${offHand ? 'off' : 'main'} hand`, r.cappedPerSwing, up);
  }
});

test('D: the Pistolet pair, each hand: loot % + flat + Potent Vs (off hand whole 80%); the pair is their mean', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const t = 562;
  const desc = character({ level: 30, raceId: 1, stats: { strength: 70, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { [WEAPONS[t].skillId ?? 33]: 150, 33: 150, 34: 30 } });
  const item = weapon(t, { material: 9 });
  const affixes = [{ id: 'slayer', param: 'daedra', value: 30 }, { id: 'elemental', param: 'fire', value: 8 }];
  const enchantments = [{ type: 4, param: 1 }];
  const traits = ['stoneskin', 'spellproof'];
  const cap = 30;
  const target = { ...standInTarget(31), bossTraits: traits, hitCap: cap };
  const hands = {};
  for (const [i, offHand] of [false, true].entries()) {
    const up = sampleCalc(u, { attacker: upstreamEntity(desc), body, item, extra: { affixes, enchantments, isIdentified: true }, offHand, seed: 0x3400 + i * 131, draws: DRAWS, after: hostSteps(u, { item, traits, cap, kind: 'arrow' }) });
    const base = analyze(simCharacter(desc, item), { target, core: 'overhaul', weapon: weaponOf(item), offHand });
    const priced = base.with({ loot: { pct: 30, flat: 8 }, potentVs: 5 });
    check(`D ${offHand ? 'off' : 'main'} hand`, priced.cappedPerSwing, up);
    hands[offHand ? 'off' : 'main'] = priced.cappedPerSwing;
  }
  // and the pair composes them (both guns carry the item): its swing is their mean
  const pair = analyze(simCharacter(desc, item), { target, core: 'overhaul', weapon: weaponOf(item), pair: true }).with({ loot: { pct: 30, flat: 8 }, potentVs: 5 });
  assert.ok(pair.pair);
  assert.ok(Math.abs(pair.cappedPerSwing - (hands.main + hands.off) / 2) < 1e-9);
});

test('E: dual wield - the imprint rides the main hand; Potent Vs priced under a backstab', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 150, 34: 30, 19: 50 } });
  const item = weapon(121, { material: 9 });
  const affixes = [{ id: 'slayer', param: 'daedra', value: 30 }];
  const traits = ['bladeturning'];
  const cap = 30;
  const target = { ...standInTarget(31), bossTraits: traits, hitCap: cap };
  const ch = simCharacter(desc, item);
  ch.offWeapon = { ...item, equipSlot: 21 };
  const dual = analyze(ch, { target, core: 'overhaul', dual: true, weapon: weaponOf(item) });
  const priced = dual.with({ loot: { pct: 30, flat: 0 } });
  assert.equal(priced.offHand.cappedPerSwing, dual.offHand.cappedPerSwing, 'the off-hand item carries nothing');
  const after = hostSteps(u, { item, traits, cap });
  const attacker = upstreamEntity(desc);
  const main = sampleCalc(u, { attacker, body, item, extra: { affixes }, seed: 0x3500, draws: DRAWS, after });
  const off = sampleCalc(u, { attacker, body, item, offHand: true, seed: 0x3501, draws: DRAWS, after });
  const main0 = sampleCalc(u, { attacker, body, item, seed: 0x3502, draws: DRAWS, after });
  // each hand against its own upstream blow; the dual swing is their mean (the exchange's cadence is not a blow)
  check('E main hand with the imprint', analyze(simCharacter(desc, item), { target, core: 'overhaul', weapon: weaponOf(item) }).with({ loot: { pct: 30, flat: 0 } }).cappedPerSwing, main);
  check('E off hand, no imprint', priced.offHand.cappedPerSwing, off);
  const mean2 = { mean: (main.mean + off.mean) / 2, se: Math.hypot(main.se, off.se) / 2 };
  check('E the dual swing = (imprinted main + plain off) / 2', priced.cappedPerSwing, mean2);
  const baseMean = { mean: (main0.mean + off.mean) / 2, se: Math.hypot(main0.se, off.se) / 2 };
  check('E the dual swing without the imprint', dual.cappedPerSwing, baseMean);
  // enchantment pricing under a backstab (chance 50, uptime 1): the marginal of Potent Vs is upstream's
  const enchanted = [{ type: 4, param: 1 }];
  const backstabLocal = analyze(simCharacter(desc, item), { target, core: 'overhaul', weapon: weaponOf(item), backstabUptime: 1 });
  const withPv = sampleCalc(u, { attacker, body, item, extra: { enchantments: enchanted, isIdentified: true }, backstabChance: 50, seed: 0x3510, draws: DRAWS, after });
  const withoutPv = sampleCalc(u, { attacker, body, item, backstabChance: 50, seed: 0x3511, draws: DRAWS, after });
  const gainLocal = backstabLocal.with({ potentVs: 5 }).cappedPerSwing - backstabLocal.cappedPerSwing;
  const gainUp = withPv.mean - withoutPv.mean;
  assert.ok(Math.abs(gainLocal - gainUp) < 4 * Math.hypot(withPv.se, withoutPv.se), `backstab Potent Vs gain ${gainLocal.toFixed(4)} vs upstream ${gainUp.toFixed(4)}`);
});
