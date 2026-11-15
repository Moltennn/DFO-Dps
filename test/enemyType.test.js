/*
 * test/enemyType.test.js - Stage 2.3: enemy-type bonuses/phobias, silver and the
 * Skeletal Warrior rule.
 *
 * Pinned upstream:
 *   combat/pcaao.js:491-522  pcaaoBonusOrPenaltyByEnemyType (the overhaul's arm)
 *   combat/pcaao.js:544-600  the weapon and fist arms, and where the bonus lands
 *   combat/pcaao.js:549-590  SILVER_DOUBLED_CAREERS + the Skeletal Warrior
 *   combat/formulas.js:176-197  GROUP_BITS / careerAttackModifier
 *   combat/formulas.js:462-470  silverDoubles (the RVN2 veto registry)
 *   combat/enemyGroups.js       enemyEntityGroup (career -> group, verbatim)
 *   systems/loot/lootPowers.js:142-157  foeGroup (affinity Human first)
 *   systems/martialPowers.js:194-225    the path percentages (Ranger's animal test)
 *
 * The differential suite is the oracle for every function here; this file pins
 * the classification distinctions, the exact pipeline positions and the
 * integration with armour, traits, caps and the allowance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, damageModel, gateTarget, martialBlowPct, referenceFoe, weaponOf,
} from '../src/model.js';
import {
  enemyTarget, enemyTypeBonusRange, enemyTypeBonusValue, enemyTypeBonusValues, enemyTypeGroup,
  isSkeletalTarget, silverApplies, skeletalSilverDamage, targetGroupOf,
} from '../src/target.js';
import { foeGroup } from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const UNDEAD_BONUS = 0x01;
const UNDEAD_PHOBIA = 0x10;
const DAEDRA_BONUS = 0x02;
const ANIMALS_BONUS = 0x08;

/** A player-side attacker with one career byte. */
const attacker = (flags, willpower = 100) => ({ stats: { willpower }, career: { attackModifierFlags: flags } });

/** A foe target with an explicit combat level. */
const foe = (careerIndex, level = 20) => ({ isPlayer: false, careerIndex, level, combatLevel: level });

// ── classification: career group, not affinity ────────────────────
test('enemy-type: the bonus reads the career group, not the affinity', () => {
  assert.equal(enemyTypeGroup(foe(0)), 3, 'career 0 is Animals');
  assert.equal(enemyTypeGroup(foe(18)), 0, 'career 18 is Undead');
  assert.equal(enemyTypeGroup(foe(31)), 1, 'career 31 is Daedra');
  assert.equal(enemyTypeGroup(foe(22)), 2, 'career 22 is Humanoid');
  assert.equal(enemyTypeGroup(foe(-1)), -1, 'the reference foe is None');

  // The two discriminants disagree for a class foe: PFAAO's bonus uses the career
  // (128 -> career 0 -> Animals; 146 -> career 18 -> Undead), while the martial/slayer
  // `foeGroup` sees the Human affinity first.
  const knight = enemyTarget(128, { level: 30 });
  assert.equal(knight.careerIndex, 0);
  assert.equal(enemyTypeGroup(knight), 3, 'the overhaul scores class 128 as Animals');
  assert.equal(foeGroup(knight), 'humanoid', 'a class foe is a man to the martial/slayer test');
  assert.equal(targetGroupOf(knight), 'humanoid');

  const classUndead = enemyTarget(146, { level: 30, exactLevel: true });
  assert.equal(classUndead.careerIndex, 18);
  assert.equal(enemyTypeGroup(classUndead), 0, 'class 146 carries the Undead career');
  assert.equal(foeGroup(classUndead), 'humanoid');
});

test('enemy-type: a bonus or phobia only decodes for its own group', () => {
  const undead = foe(18);
  assert.equal(enemyTypeBonusRange(attacker(UNDEAD_BONUS), undead).decoded, 1);
  assert.equal(enemyTypeBonusRange(attacker(UNDEAD_PHOBIA), undead).decoded, -1);
  assert.equal(enemyTypeBonusRange(attacker(DAEDRA_BONUS), undead).decoded, 0);
  assert.equal(enemyTypeBonusRange(attacker(0), undead).decoded, 0);
  assert.equal(enemyTypeBonusRange(attacker(UNDEAD_BONUS), foe(31)).decoded, 0, 'Daedra is a different group');
});

// ── the bonus range and the phobia penalty ────────────────────────
test('enemy-type: the Undead bonus is a per-blow range at 100 Willpower', () => {
  const undead = foe(18, 20);
  const range = enemyTypeBonusRange(attacker(UNDEAD_BONUS), undead);
  assert.equal(range.will, 10, '(100 - 50) / 5');
  assert.equal(range.bonus, 10, '10 + will - targetLevel/2');
  assert.equal(range.penalty, 0);
  const values = enemyTypeBonusValues(attacker(UNDEAD_BONUS), undead);
  assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(mean(values), 4.5, 'the audit’s +4.5 per blow at level 20');
  assert.equal(enemyTypeBonusValue(attacker(UNDEAD_BONUS), undead, 0), 0);
  assert.equal(enemyTypeBonusValue(attacker(UNDEAD_BONUS), undead, 0.999), 9);
});

test('enemy-type: Willpower and the target level set the range', () => {
  // The formula is 10 + will - trunc(targetLevel / 2), floored at 0.
  assert.equal(enemyTypeBonusRange(attacker(UNDEAD_BONUS, 50), foe(18, 1)).bonus, 10);
  assert.equal(enemyTypeBonusRange(attacker(UNDEAD_BONUS, 100), foe(18, 45)).bonus, 0);
  assert.equal(enemyTypeBonusRange(attacker(UNDEAD_BONUS, 150), foe(18, 21)).bonus, 10, 'live Willpower caps at 100');
  assert.deepEqual(enemyTypeBonusValues(attacker(UNDEAD_BONUS, 100), foe(18, 45)), [0], 'a 45-level target erases it');
});

test('enemy-type: a phobia is the fixed target-level penalty, never a roll', () => {
  const range = enemyTypeBonusRange(attacker(UNDEAD_PHOBIA, 50), foe(18, 45));
  assert.equal(range.penalty, 22, 'trunc(45 / 2) - 0');
  assert.equal(range.bonus, 0, '10 + 0 - 22, floored');
  assert.equal(enemyTypeBonusValue(attacker(UNDEAD_PHOBIA, 50), foe(18, 45), 0), -22);
  assert.equal(enemyTypeBonusValue(attacker(UNDEAD_PHOBIA, 50), foe(18, 45), 0.99), -22);
  assert.deepEqual(enemyTypeBonusValues(attacker(UNDEAD_PHOBIA, 50), foe(18, 45)), [-22]);
  assert.equal(enemyTypeBonusRange(attacker(UNDEAD_PHOBIA, 100), foe(18, 21)).penalty, 0);
});

// ── silver and the Skeletal Warrior ───────────────────────────────
test('silver: the six doubled careers and material 2 only', () => {
  for (const careerIndex of [9, 18, 19, 23, 28, 14]) {
    assert.equal(silverApplies(foe(careerIndex), { material: 2 }), true, `career ${careerIndex}`);
    assert.equal(silverApplies(foe(careerIndex), { material: 0 }), false);
    assert.equal(silverApplies(foe(careerIndex), { material: 1 }), false);
    assert.equal(silverApplies(foe(careerIndex), { material: 3 }), false);
    assert.equal(silverApplies(foe(careerIndex), { material: 9 }), false);
    assert.equal(skeletalSilverDamage(10, foe(careerIndex), { material: 2 }), 20);
    assert.equal(skeletalSilverDamage(10, foe(careerIndex), { material: 9 }), 10);
  }
  for (const careerIndex of [0, 15, 22, 31, -1]) {
    assert.equal(silverApplies(foe(careerIndex), { material: 2 }), careerIndex === 15, `career ${careerIndex}`);
  }
});

test('silver: the Skeletal Warrior halves every weapon, then doubles silver', () => {
  const skeleton = foe(15);
  assert.equal(isSkeletalTarget(skeleton), true);
  assert.equal(skeletalSilverDamage(10, skeleton, { material: 9 }), 5, 'trunc(10 / 2)');
  assert.equal(skeletalSilverDamage(11, skeleton, { material: 9 }), 5, 'trunc(11 / 2)');
  assert.equal(skeletalSilverDamage(10, skeleton, { material: 2 }), 10, 'halve, then double');
  assert.equal(skeletalSilverDamage(11, skeleton, { material: 2 }), 10, 'trunc(11/2) x2');
  assert.equal(skeletalSilverDamage(10, skeleton, { material: 2, flags: 0x10 }), 20, 'the 0x10 bit skips the halving');
  assert.equal(skeletalSilverDamage(10, skeleton, { material: 9, flags: 0x10 }), 10);
  // Unarmed and a player target take neither rule.
  assert.equal(skeletalSilverDamage(10, skeleton, null), 10);
  assert.equal(skeletalSilverDamage(10, { ...skeleton, isPlayer: true }, { material: 2 }), 10);
  assert.equal(skeletalSilverDamage(10, foe(18), { material: 2 }), 20);
});

test('silver: it doubles the roll and the damage modifiers, not Strength/material', () => {
  const ch = simCharacter(character({
    level: 1, raceId: 1,
    stats: { strength: 50, agility: 50, speed: 50, luck: 50 },
    skillOverride: { 29: 0, 34: 0 },
  }));
  const fixed = (material) => weaponOf({
    templateIndex: 121, material, minDamage: 10, maxDamage: 10,
    maxCondition: 100, currentCondition: 100,
  });
  const ghost = foe(18);
  const silver = damageModel(ch, fixed(2), ghost, 'StrikeLeft', 'overhaul', {});
  const steel = damageModel(ch, fixed(9), ghost, 'StrikeLeft', 'overhaul', {});
  const base = silver.parts.roll[0] + silver.parts.dmgMods;
  assert.equal(base, 10, 'the chosen roll, no modifiers');
  assert.equal(silver.plainRolls[0], base * 2 + silver.parts.strMod + silver.parts.matMod);
  assert.equal(steel.plainRolls[0], base + steel.parts.strMod + steel.parts.matMod);
  const silverCore = silver.plainRolls[0] - silver.parts.strMod - silver.parts.matMod;
  const steelCore = steel.plainRolls[0] - steel.parts.strMod - steel.parts.matMod;
  assert.equal(silverCore - steelCore, base, 'the doubled part is the roll, not Strength/material');
  assert.equal(silver.parts.matMod, 0, 'silver adds no damage modifier of its own');
  assert.equal(steel.parts.matMod, 6, 'daedric is +6');
});

test('silver: an elemental affix is added after the double, once', () => {
  const ch = simCharacter(character({
    level: 1, raceId: 1,
    stats: { strength: 50, agility: 50, speed: 50, luck: 50 },
    skillOverride: { 29: 0, 34: 0 },
  }));
  const fixed = (elemental) => weaponOf({
    templateIndex: 121, material: 2, minDamage: 10, maxDamage: 10,
    maxCondition: 100, currentCondition: 100,
    affixes: elemental ? [{ id: 'elemental', param: 'fire', value: 10 }] : [],
  });
  const ghost = foe(18);
  const plain = damageModel(ch, fixed(false), ghost, 'StrikeLeft', 'overhaul', {});
  const withElement = damageModel(ch, fixed(true), ghost, 'StrikeLeft', 'overhaul', {});
  assert.equal(withElement.plainRolls[0] - plain.plainRolls[0], 10, 'the flat is not doubled');
  assert.equal(plain.plainRolls[0], 20, 'the silver double of the 10 roll');
});

test('silver: critical, material requirement and the target defence follow it', () => {
  const ch = simCharacter(character({
    level: 20, raceId: 1,
    stats: { strength: 60, agility: 50, speed: 50, luck: 50 },
    skillOverride: { 29: 100, 34: 100 },
  }));
  const w = weaponOf(weapon(121, { material: 2 }));
  const ghost = { ...foe(18), minMetalToHit: 5 };
  const matReq = 1 - Math.min(0.2 * (5 - 2), 0.9);
  const dmg = damageModel(ch, w, ghost, 'StrikeLeft', 'overhaul', { matReqMulti: matReq });
  assert.equal(dmg.parts.matReq, matReq);
  assert.equal(dmg.parts.silver.doubled, true);
  // The material multiplier lands after the crit on the already-doubled, already-bonused blow.
  const pre = dmg.plainRolls[0];
  const crit = dmg.critRolls[0];
  assert.ok(crit > pre, 'the crit multiplier is later still');
});

test('silver: ranged and off-hand weapons use the same stage', () => {
  const ch = simCharacter(character({
    level: 20, raceId: 1,
    stats: { strength: 60, agility: 60, speed: 60, luck: 50 },
    skillOverride: { 33: 100, 34: 20 },
  }), weapon(129, { material: 2 })); // short bow
  const ghost = enemyTarget(18, { level: 20 });
  const bow = analyze(ch, { target: ghost, core: 'overhaul' });
  assert.equal(bow.weapon.ranged, true);
  assert.equal(bow.damage.parts.silver.doubled, true);

  const pair = simCharacter(character({
    level: 20, raceId: 1,
    stats: { strength: 60, agility: 60, speed: 60, luck: 50 },
    skillOverride: { 29: 100, 34: 20 },
  }), weapon(121, { material: 9 }));
  const offSilver = { ...weapon(121, { material: 2 }), equipSlot: 21 };
  const dual = analyze({ ...pair, offWeapon: offSilver }, { target: ghost, core: 'overhaul', dual: true });
  assert.equal(dual.offHand.damage.parts.silver.doubled, true);
  assert.equal(dual.offHand.damage.parts.silver.careerIndex, 18);
});

// ── the Ranger animal test ────────────────────────────────────────
test('Ranger: Hunter’s Instinct reads foeGroup, not the career group', () => {
  const ranger = { martialPath: 'ranger' };
  assert.equal(martialBlowPct(ranger, enemyTarget(0)), 20, 'a rat is an animal');
  assert.equal(martialBlowPct(ranger, enemyTarget(34)), 20, 'a dragonling is Animals despite the Daylight affinity');
  assert.equal(martialBlowPct(ranger, enemyTarget(7)), 0, 'an orc is Humanoid');
  assert.equal(martialBlowPct(ranger, enemyTarget(128, { level: 30 })), 0, 'a class foe is a man');
  assert.equal(martialBlowPct(ranger, enemyTarget(18)), 0, 'undead is not an animal');
  assert.equal(martialBlowPct(ranger, enemyTarget(31)), 0, 'daedra is not an animal');
  const crusader = { martialPath: 'crusader' };
  assert.equal(martialBlowPct(crusader, enemyTarget(18)), 20);
  assert.equal(martialBlowPct(crusader, enemyTarget(31)), 20);
  assert.equal(martialBlowPct(crusader, enemyTarget(0)), 0);
});

test('Ranger: the 20% lands on the blow, after the enemy-type bonus', () => {
  const ch = simCharacter(character({
    level: 20, raceId: 1,
    stats: { strength: 60, agility: 50, speed: 50, luck: 50, willpower: 100 },
    skillOverride: { 29: 100, 34: 0 },
  }));
  const rat = enemyTarget(0, { level: 20 });
  const human = enemyTarget(128, { level: 20 });
  const ranger = { ...ch, martialPath: 'ranger' };
  const onAnimal = analyze(ranger, { target: rat, core: 'overhaul', weapon: weaponOf(weapon(121, { material: 9 })) });
  const onHuman = analyze(ranger, { target: human, core: 'overhaul', weapon: weaponOf(weapon(121, { material: 9 })) });
  assert.equal(onAnimal.damage.parts.martial, 20);
  assert.equal(onHuman.damage.parts.martial, 0);
  assert.ok(onAnimal.perSwing > onHuman.perSwing, 'the animal takes the 20%');
});

// ── integration ──────────────────────────────────────────────────
test('integration: the bonus and silver are in the blow before armour, traits and the cap', () => {
  const ch = simCharacter(character({
    level: 20, raceId: 1,
    stats: { strength: 70, agility: 60, speed: 60, luck: 50, willpower: 100 },
    skillOverride: { 29: 100, 34: 20 },
    career: { attackModifierFlags: UNDEAD_BONUS },
  }), weapon(121, { material: 1 }));
  const ghost = enemyTarget(18, { level: 20 });
  const r = analyze(ch, { target: ghost, core: 'overhaul' });
  assert.equal(r.damage.parts.enemyType.decoded, 1);
  assert.equal(r.damage.parts.enemyType.bonus, 10);
  assert.equal(r.damage.parts.silver.doubled, false, 'steel is not silver');
  const silver = analyze(ch, { target: ghost, core: 'overhaul', weapon: weaponOf(weapon(121, { material: 2 })) });
  assert.equal(silver.damage.parts.silver.doubled, true);
  assert.ok(silver.perSwing > r.perSwing, 'silver doubles the roll');
  // The bonus survives the cap and the trait layer; the cap only clips the total.
  const capped = analyze(ch, {
    target: { ...ghost, bossTraits: ['stoneskin'], hitCap: 5 },
    core: 'overhaul', weapon: weaponOf(weapon(121, { material: 2 })),
  });
  assert.ok(capped.cappedPerSwing <= capped.perSwing);
  assert.ok(capped.cappedPerSwing > 0);
});

test('integration: the gate’s body level is used for a Daedra bonus', () => {
  const gate = gateTarget(45);
  assert.equal(gate.combatLevel, 21);
  assert.equal(gate.level, 45, 'the content level stays the allowance level');
  const daedra = enemyTypeBonusRange(attacker(DAEDRA_BONUS, 100), gate);
  assert.equal(daedra.group, 1, 'Daedra');
  assert.equal(daedra.decoded, 1);
  assert.equal(daedra.bonus, 10, '10 + 10 - trunc(21 / 2)');
  const phobia = enemyTypeBonusRange(attacker(0x20, 100), gate);
  assert.equal(phobia.penalty, 0, '10 - 10');
});

test('integration: a flagless reference foe is unchanged and exposes a zero bonus', () => {
  const ch = simCharacter(character({ level: 30, stats: { strength: 60 } }));
  const tough = referenceFoe(30, 'tough');
  const r = analyze(ch, { target: tough, core: 'overhaul' });
  assert.equal(r.damage.parts.enemyType.decoded, 0);
  assert.deepEqual(r.damage.parts.enemyType.group, -1);
  assert.equal(r.damage.parts.silver.doubled, false);
  assert.deepEqual(r.damage.parts.enemyType, enemyTypeBonusRange(ch, tough));
});
