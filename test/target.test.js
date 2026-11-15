/*
 * test/target.test.js - Stage 2.1: the target as the hit path sees it.
 *
 * The target model separates player data from the foe's identity and intrinsic defences:
 * career/mobile identity (characters/enemy/enemyBasics.js), the career group
 * (combat/enemyGroups.js), the monster hide and natural resistance (combat/pcaao.js:1447-1471,
 * :1594-1605), career elemental tolerance (lootPowers.js:164-167, the full-checkout
 * spellcast.js:61-68), and minMetalToHit (pcaao.js:1640-1700).
 *
 * Worn armour/shield, silver, enemy-type bonuses, backstab, conditions, racial/classic,
 * Legendary powers, procs/DoTs, wards, spells and techniques are deliberately outside Stage 2.1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, bossTarget, damageModel, gateTarget, referenceFoe, unityRound, weaponOf,
} from '../src/model.js';
import { encounterTarget } from '../src/encounters.js';
import {
  careerTolerance, elementShare, enemyTarget, intrinsicDamage,
  materialRequirementMultiplier, naturalDamageResistance,
} from '../src/target.js';
import { savingChance, savingChanceOutcome, spellDamage } from '../src/spells.js';
import { resistBlow } from '../src/bossTraits.js';
import { SKILLS } from '../src/data.js';
import { character, simCharacter, weapon, fresh, upstreamEntity, upstreamWeapon } from './harness/fixtures.mjs';
import { upstream, pcaaoModules, referenceFoe as upstreamReferenceFoe } from './harness/upstream.mjs';
import { compareBody, upstreamBodies, upstreamBody } from './harness/upstreamBodies.mjs';
import { compareSample } from './harness/differential.mjs';
import { generator } from './harness/prng.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const PLAIN = () => simCharacter(character({
  level: 45, raceId: 1,
  stats: { strength: 50, agility: 50, speed: 50, luck: 50, endurance: 50, willpower: 50 },
  skills: 0, skillOverride: { 29: 0, 34: 0 },
  career: { weaponArmorShieldsBitfield: 0, abilityFlagsAndSpellPointsBitfield: 0, attackModifierFlags: 0 },
}));

test('reference foe keeps its previous shape and adds the target fields', () => {
  const t = referenceFoe(45, 'tough');
  assert.equal(t.isPlayer, false);
  assert.equal(t.isClass, false);
  assert.equal(t.mobileType, null);
  assert.equal(t.careerIndex, -1);
  assert.equal(t.career, null);
  assert.equal(t.minMetalToHit, -1);
  assert.equal(t.spareGear, true);
  assert.equal(t.armorValues.length, 7);
  assert.equal(intrinsicDamage(t, 100, { weapon: { skillId: SKILLS.LongBlade } }), 100, 'no hide, no natural resistance');
  assert.equal(naturalDamageResistance(t), 0);
});

test('reference-foe resolution still matches the game for a plain target', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const desc = character({
    level: 45, raceId: 1,
    stats: { strength: 80, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 50, skillOverride: { 29: 70, 34: 40 },
  });
  const item = weapon(121, { material: 9 });
  const target = upstreamReferenceFoe(u, 45, 'tough');
  const rng = generator(0x51a7);
  const sample = [];
  for (let i = 0; i < 6000; i++) {
    sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
      weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0,
    }));
  }
  const local = analyze(simCharacter(desc, item), { target: referenceFoe(45, 'tough'), core: 'overhaul', rri: false, swing: 'StrikeLeft' });
  const cmp = compareSample({ expected: sample, actual: local.perSwing });
  assert.ok(cmp.ok, `reference per swing ${local.perSwing.toFixed(4)} vs ${mean(sample).toFixed(4)} (${cmp.detail ? JSON.stringify(cmp.detail) : 'inside CI'})`);
});

test('the gate stand-in is the upstream bossStandIn identity: career index, no career object, Normal tolerance', async () => {
  const u = await upstream();
  const { body: upstreamGate } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const gate = gateTarget(45);
  assert.equal(gate.careerIndex, upstreamGate.careerIndex, 'career index 31');
  assert.equal(gate.mobileType, upstreamGate.mobileType, 'mobile 31');
  assert.equal(gate.career, upstreamGate.career, 'bossStandIn passes null: index and career data are separate');
  assert.equal(gate.career, null);
  assert.equal(gate.affinity, upstreamGate.affinity, 'Daedra');
  assert.equal(gate.affinity, 'Daedra');
  assert.equal(gate.minMetalToHit, upstreamGate.minMetalToHit, 'bossStandIn overrides the row to 0');
  assert.equal(gate.minMetalToHit, 0);
  assert.equal(gate.armorValues[0], upstreamGate.armorValues[0], 'BOSS_ARMOR 60');
  assert.equal(gate.spareGear, true);
  assert.equal(gate.stats.strength, upstreamGate.stats.strength, 'career null leaves the 50s stats');
  assert.equal(gate.stats.strength, 50);
  // No career object means Normal tolerance: the gate looks up no ENEMY031.CFG tolerance bytes.
  assert.equal(u.spellcast.careerTolerance(upstreamGate.career ?? {}, u.spellcast.EFFECT_FLAGS.Fire), 'Normal');
  assert.equal(careerTolerance(gate.career ?? {}, 8), 'Normal');
  assert.equal(elementShare(gate, 'fire'), 1);
  assert.deepEqual(u.spellcast.savingChance(0, 8, upstreamGate), savingChanceOutcome(gate, { element: 0, effectFlags: 8 }));
  assert.deepEqual(savingChanceOutcome(gate, { element: 0, effectFlags: 8 }), { chance: 55, immune: false });
});

test('enemy rows resolve identity: mobile, career, affinity, group, metal and armour, as upstream mints them', async () => {
  // Stage 2.8: the body is compared with the one upstream mints for itself (its own realm, booted as the
  // client boots: test/harness/upstreamBodies.mjs) - never with this project's reading of a table row.
  const CLASS_CAREER = { strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50, hitPointsPerLevel: 8 };
  const { bodies: [lordUp, atronachUp, undeadUp, animalUp, klassUp] } = await upstreamBodies([
    { kind: 'mint', mobile: 31 },
    { kind: 'mint', mobile: 36 },
    { kind: 'mint', mobile: 15 },
    { kind: 'mint', mobile: 34 },
    { kind: 'mint', mobile: 128, career: CLASS_CAREER, playerLevel: 10 },
  ]);
  const lord = enemyTarget(31);
  assert.deepEqual(compareBody(lord, lordUp), [], 'the Daedra Lord is the body upstream mints');
  assert.equal(lord.mobileType, 31);
  assert.equal(lord.careerIndex, 31);
  assert.equal(lord.isClass, false);
  assert.equal(lord.affinity, 'Daedra');
  assert.equal(lord.group, 'daedra');
  assert.equal(lord.spareGear, true);
  assert.equal(lord.levelSource, 'mint');

  const atronach = enemyTarget(36);
  assert.deepEqual(compareBody(atronach, atronachUp), [], 'the Iron Atronach is the body upstream mints');
  assert.equal(atronach.careerIndex, 36);
  assert.equal(atronach.affinity, 'Golem');
  assert.equal(atronach.group, null, 'the Iron Atronach is EnemyGroups.None');

  const undead = enemyTarget(15);
  assert.deepEqual(compareBody(undead, undeadUp), []);
  assert.equal(undead.group, 'undead');
  const animal = enemyTarget(34);
  assert.deepEqual(compareBody(animal, animalUp), []);
  assert.equal(animal.group, 'animal');

  const klass = enemyTarget(128, { level: 10, career: CLASS_CAREER });
  assert.deepEqual(compareBody(klass, klassUp), [], 'a class foe is minted at the level it is handed');
  assert.equal(klass.isClass, true);
  assert.equal(klass.careerIndex, 0);
  assert.equal(klass.affinity, 'Human');
  assert.equal(klass.group, 'humanoid');
  assert.equal(klass.levelSource, 'player');
  assert.equal(klass.skills[20], 80, 'skillsLevel(10) = 80');
});

test('gate, encounter and boss targets carry the same fields without touching player data', async () => {
  const gate = gateTarget(45);
  assert.equal(gate.mobileType, 31);
  assert.equal(gate.careerIndex, 31);
  assert.equal(gate.affinity, 'Daedra');
  assert.equal(gate.group, 'daedra');
  assert.equal(gate.minMetalToHit, 0, 'gateBoss.js overrides the row to 0');
  assert.equal(gate.spareGear, true);
  const breach = encounterTarget('breach', 45);
  assert.equal(breach.careerIndex, 31);
  assert.equal(breach.minMetalToHit, 0);
  const ketch = encounterTarget('skyketch', 45);
  assert.equal(ketch.mobileType, 36);
  assert.equal(ketch.careerIndex, 36);
  // A boss named by its mobile is the game's relay stand-in for that mobile (world/gate/gateBoss.js
  // bossStandIn): its metal is the stand-in's 0, not the row's 5, and its body cannot be re-stated.
  const { body: standIn31 } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const custom = bossTarget({ mobileType: 31, level: 30, health: 1000, traits: ['stoneskin'] });
  assert.equal(custom.group, 'daedra');
  assert.deepEqual(compareBody(custom, standIn31, { combatLevel: true }), [], 'the stand-in body, whatever the content level');
  assert.equal(custom.minMetalToHit, 0);
  assert.equal(custom.level, 30, 'the content level stays the boss\'s own field');
  for (const field of ['armorValue', 'minMetalToHit', 'careerIndex', 'affinity', 'isClass', 'career']) {
    assert.throws(() => bossTarget({ mobileType: 31, [field]: field === 'career' ? {} : 1 }), /stand-in/, `${field} cannot be set beside a mobile`);
  }
  const plain = bossTarget({ level: 30, health: 1000, traits: ['curbing'] });
  assert.equal(plain.careerIndex, -1, 'a generic boss without a mobile keeps the old target body');
  assert.equal(plain.minMetalToHit, -1);
  // The player object passed in is not copied into or mutated by the target.
  const player = PLAIN();
  const before = JSON.stringify(player);
  gateTarget(45);
  assert.equal(JSON.stringify(player), before);
});

test('monster hide and natural resistance use the career and stats, not armour', () => {
  const blade = { skillId: SKILLS.LongBlade };
  const blunt = { skillId: SKILLS.BluntWeapon };
  assert.equal(intrinsicDamage(enemyTarget(31), 100, { weapon: blade }), 95, 'Daedra Lord x0.95');
  assert.equal(intrinsicDamage(enemyTarget(36), 100, { weapon: blade }), 90, 'Iron Atronach edged x0.9');
  assert.equal(intrinsicDamage(enemyTarget(36), 100, { weapon: blunt }), 60, 'Iron Atronach blunt x0.6');
  assert.equal(intrinsicDamage(enemyTarget(38), 100, { weapon: blunt }), 140, 'Ice Atronach blunt x1.4');
  assert.equal(intrinsicDamage(enemyTarget(15), 100, { weapon: blade }), 80, 'Skeletal Warrior x0.8');
  assert.equal(intrinsicDamage(enemyTarget(22), 100, { weapon: blade }), 71, 'Gargoyle edged x0.71');
  assert.equal(intrinsicDamage(enemyTarget(22), 100, { weapon: blunt }), 121, 'Gargoyle blunt x1.21');
  assert.equal(intrinsicDamage(enemyTarget(2), 100, { weapon: blade }), 126, 'Spriggan edged x1.26');
  assert.equal(intrinsicDamage(enemyTarget(34), 100, { weapon: blade }), 100, 'animal x1');
  // A career stat block adds natural resistance, and the hide function subtracts it once.
  const strong = enemyTarget(31, { career: { strength: 80, endurance: 70, willpower: 90 } });
  assert.ok(near(naturalDamageResistance(strong), 0.11, 1e-6));
  assert.equal(intrinsicDamage(strong, 100, { weapon: blade }), 84, 'the Daedra Lord x0.95 less the 11% natural resistance, rounded once');
});

test('career tolerances: precedence, elemental share and the saving throw', () => {
  assert.equal(careerTolerance({ resistanceFlags: 8, immunityFlags: 8 }, 8), 'Resistant', 'Resistant outranks Immune');
  assert.equal(careerTolerance({ immunityFlags: 8 }, 8), 'Immune');
  assert.equal(careerTolerance({ lowToleranceFlags: 8 }, 8), 'LowTolerance');
  assert.equal(careerTolerance({ criticalWeaknessFlags: 8 }, 8), 'CriticalWeakness');
  assert.equal(careerTolerance({}, 8), 'Normal');
  assert.equal(elementShare({ career: { resistanceFlags: 8 } }, 'fire'), 0.5);
  assert.equal(elementShare({ career: { immunityFlags: 8 } }, 'fire'), 0);
  assert.equal(elementShare({ career: {} }, 'fire'), 1);
  assert.equal(elementShare({ career: { resistanceFlags: 8 } }, 'frost'), 1, 'an element it does not name');

  const normal = enemyTarget(31); // willpower 50 -> 55
  assert.equal(savingChance(normal, { element: 0 }), 55);
  const resistant = enemyTarget(31, { career: { resistanceFlags: 8 } });
  assert.equal(savingChance(resistant, { element: 0 }), 80);
  const immune = enemyTarget(31, { career: { immunityFlags: 8 } });
  const outcome = savingChanceOutcome(immune, { element: 0 });
  assert.deepEqual(outcome, { chance: 100, immune: true });
  const weak = enemyTarget(31, { career: { criticalWeaknessFlags: 8 } });
  assert.equal(savingChance(weak, { element: 0 }), 5, '50 - 50 + 5, clamped to 5');

  const spell = {
    name: 'fire bolt', element: 0, rangeType: 0, cost: 10,
    effects: [{ type: 4, subType: 0, magnitudeBaseLow: 50, magnitudeBaseHigh: 50, magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1, durationBase: 0, durationMod: 0, durationPerLevel: 1, chanceBase: 0, chanceMod: 0, chancePerLevel: 1 }],
  };
  const ch = PLAIN();
  assert.equal(spellDamage(spell, ch, normal).instant > 0, true);
  assert.equal(spellDamage(spell, ch, immune).instant, 0, 'an immune career lands no fire damage');
});

test('material requirement is a damage multiplier, not a to-hit term', () => {
  assert.ok(near(materialRequirementMultiplier({ minMetalToHit: 5 }, { material: 2 }), 0.4, 1e-6));
  assert.ok(near(materialRequirementMultiplier({ minMetalToHit: 4 }, { material: 2 }), 0.6, 1e-6));
  assert.ok(near(materialRequirementMultiplier({ minMetalToHit: 5 }, { material: 4 }), 0.8, 1e-6));
  assert.ok(near(materialRequirementMultiplier({ minMetalToHit: 9 }, { material: 0 }), 0.1, 1e-6), 'the 0.9 penalty cap');
  assert.ok(near(materialRequirementMultiplier({ minMetalToHit: 6 }, { material: 1 }), 0.1, 1e-6));
  assert.equal(materialRequirementMultiplier({ minMetalToHit: 5 }, { material: 5 }), 1, 'exactly at the requirement');
  assert.equal(materialRequirementMultiplier({ minMetalToHit: 5 }, { material: 9 }), 1, 'above the requirement');
  assert.equal(materialRequirementMultiplier({ minMetalToHit: -1 }, { material: 0 }), 1);
  assert.equal(materialRequirementMultiplier({ minMetalToHit: 5 }, { material: 2 }, { soft: false }), 0, 'hard mode refuses the blow');
  // The blow itself: a material-2 katana against a minMetal 5 target is 40% of its damage.
  const ch = PLAIN();
  const target = { ...referenceFoe(45, 'tough'), minMetalToHit: 5, spareGear: true };
  const r = analyze(ch, { target, weapon: weaponOf(weapon(121, { material: 2 })), core: 'overhaul' });
  const hard = analyze(ch, { target, weapon: weaponOf(weapon(121, { material: 2 })), core: 'overhaul', softMaterialRequirements: false });
  assert.ok(near(r.damage.parts.matReq, 0.4, 1e-6));
  assert.ok(r.perSwing > 0);
  assert.equal(hard.perSwing, 0, 'hard mode: no blow gets through');
});

test('material hard refusal matches the game', async () => {
  const u = await upstream();
  const modules = { ...pcaaoModules(u), softMaterialRequirements: false };
  const desc = character({
    level: 45, raceId: 1,
    stats: { strength: 80, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 29: 0, 34: 0 },
  });
  const item = weapon(121, { material: 2 });
  const target = upstreamReferenceFoe(u, 45, 'tough');
  target.minMetalToHit = 5;
  const rng = generator(0x2a20);
  for (let i = 0; i < 200; i++) {
    assert.equal(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
      weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0,
    }), 0, 'hard mode refuses every blow below the requirement');
  }
  const localTarget = { ...referenceFoe(45, 'tough'), minMetalToHit: 5, spareGear: true };
  const local = analyze(simCharacter(desc, item), { target: localTarget, core: 'overhaul', softMaterialRequirements: false });
  assert.equal(local.perSwing, 0);
});

test('material rounding: half-to-even after the multiplier, before condition', () => {
  const ch = PLAIN();
  // A fixed 6-point roll, a material-0 weapon: the -1 material modifier leaves 5, and a 0.1
  // requirement multiplier gives exactly 0.5, which unityRound takes to 0 (half-to-even).
  const w = {
    skillId: SKILLS.LongBlade, min: 6, max: 6, material: 0, twoHanded: false,
    damagePct: 0, bonusDamage: 0, conditionPct: 1,
  };
  const matReq = materialRequirementMultiplier({ minMetalToHit: 9 }, { material: 0 });
  assert.ok(near(matReq, 0.1, 1e-6));
  const d = damageModel(ch, w, referenceFoe(45, 'tough'), 'StrikeLeft', 'overhaul', { matReqMulti: 0.5 });
  assert.equal(d.parts.matReq, 0.5);
  assert.equal(d.plainRolls[0], unityRound(Math.fround(5 * Math.fround(0.5))));
  assert.equal(d.plainRolls[0], 2, '2.5 -> 2 (half-to-even)');
  const low = damageModel(ch, w, referenceFoe(45, 'tough'), 'StrikeLeft', 'overhaul', { matReqMulti: matReq });
  assert.equal(low.plainRolls[0], 1, 'the 5-point roll after the 0.1 multiplier rounds to 1 in float32');
});

test('material and hide end-to-end against the game', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const desc = character({
    level: 45, raceId: 1,
    stats: { strength: 80, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 29: 0, 34: 0 },
  });
  const item = weapon(121, { material: 2 });
  const target = upstreamReferenceFoe(u, 45, 'tough');
  target.minMetalToHit = 5;
  const rng = generator(0x2a17);
  const sample = [];
  for (let i = 0; i < 6000; i++) {
    sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
      weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0,
    }));
  }
  const localTarget = { ...referenceFoe(45, 'tough'), minMetalToHit: 5, spareGear: true };
  const local = analyze(simCharacter(desc, item), { target: localTarget, core: 'overhaul', rri: false });
  const cmp = compareSample({ expected: sample, actual: local.perSwing });
  assert.ok(cmp.ok, `material per swing ${local.perSwing.toFixed(4)} vs ${mean(sample).toFixed(4)} (${cmp.detail ? JSON.stringify(cmp.detail) : 'inside CI'})`);
});

test('target defense is applied exactly once, before the boss traits and the cap', async () => {
  const u = await upstream();
  const target = gateTarget(45);
  const ch = PLAIN();
  const hidden = u.pcaao.pcaaoPercentageReductionCalculationForMonsters(
    null, target, 100, true, u.pcaao.pcaaoNaturalDamageResistance(target),
  );
  assert.equal(hidden, 95);
  assert.equal(intrinsicDamage(target, 100, { weapon: { skillId: SKILLS.BluntWeapon } }), 95);
  assert.equal(resistBlow(['stoneskin'], hidden, { kind: 'melee', weapon: weapon(126) }), 48, 'x0.95 then x0.5, rounded once');
  const r = analyze(ch, { target, health: 12000, weapon: weaponOf(weapon(126)), core: 'overhaul' });
  assert.equal(r.targetDefense.hideAt100, 95);
  assert.deepEqual(r.targetDefense.material, 1);
  assert.ok(r.perSwing > 0);
  assert.ok(r.cappedPerSwing <= r.perSwing + 1e-12);
  assert.ok(near(r.cappedDps, r.cappedPerSwing * r.cadence.aps, 1e-9));
});

test('the per-hit cap and the relay allowance sit after target mitigation', () => {
  const target = gateTarget(45);
  const ch = PLAIN();
  const r = analyze(ch, { target, health: target.maxHealth, core: 'overhaul' });
  assert.ok(r.allowance);
  assert.ok(near(r.allowance.ceilingDps, r.cappedDps, 1e-9), 'the relay ceiling is the post-target capped claim rate');
  assert.ok(r.allowance.sustainedDps <= 150 + 1e-12);
  assert.ok(r.ttk >= (target.maxHealth - 750) / 150 - 1e-9, 'never under the relay floor');
});

test('single and dual builds apply the same target defense to each hand', () => {
  const target = gateTarget(45);
  const ch = PLAIN();
  const single = analyze(ch, { target, health: 12000, weapon: weaponOf(weapon(121, { material: 9 })), core: 'overhaul' });
  assert.equal(single.targetDefense.hideAt100, 95);
  const dualCh = { ...ch, offWeapon: { ...weapon(121, { material: 9 }), equipSlot: 21 } };
  const dual = analyze(dualCh, { target, health: 12000, dual: true, weapon: weaponOf(weapon(121, { material: 9 })), core: 'overhaul' });
  assert.equal(dual.offHand.targetDefense.hideAt100, 95);
  assert.ok(dual.perSwing > 0);
  assert.ok(dual.ttk >= (12000 - 750) / 150 - 1e-9);
});
