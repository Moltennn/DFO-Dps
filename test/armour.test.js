/*
 * test/armour.test.js - Stage 2.2: worn armour and shield mitigation.
 *
 * The rules are pinned to vendor/upstream/a3eb1605:
 *   combat/pcaao.js:1139-1335  the armour/shield reduction rows, condition and material id
 *   combat/pcaao.js:1474-1570  the shield's strong/weak block chance
 *   combat/pcaao.js:1573-1590  shield vs the piece under it
 *   combat/pcaao.js:1709-1843  the struck part, the shield roll and the reduction's place in the blow
 *   combat/enemyEquipment.js   armorOfMaterial (the game's item minter), enemyArmorValues
 *
 * The differential suite compares each row and the whole blow with the game's own
 * functions. This file pins the target-model behaviour: placement, body parts,
 * the expected block, and the layer order through traits, the cap and the allowance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, gateTarget, referenceFoe, weaponOf } from '../src/model.js';
import {
  armourConditionMultiplier, armourMaterialId, armourPiece, armourReduction, bodyPartWeights,
  enemyTarget, equipArmour, gearEnemy, hasWornEquipment, intrinsicDamage, leftHandShield,
  naturalDamageResistance, shieldBeatsUnderArmour, shieldBlockChance, shieldReduction,
  struckSlotItem, targetPartDamage,
} from '../src/target.js';
import { SKILLS } from '../src/data.js';
import { resistBlow } from '../src/bossTraits.js';
import { EQUIP_SLOTS } from '../vendor/upstream/a3eb1605/src/systems/equip.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { generator } from './harness/prng.mjs';
import { upstreamBody } from './harness/upstreamBodies.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/** A worn piece with an exact condition band (max 1000, so the percentage is the input). */
function piece(templateIndex, material, condition = 1) {
  const item = armourPiece(templateIndex, { material });
  item.maxCondition = 1000;
  item.currentCondition = Math.round(condition * 1000);
  return item;
}

const EDGED = Object.freeze({ skillId: SKILLS.LongBlade });
const BLUNT = Object.freeze({ skillId: SKILLS.BluntWeapon });

/** A class career of 50s: the booted loadout reads its hit-point step and its forbidden-armour bits. */
const CLASS_CAREER = Object.freeze({
  strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50,
  personality: 50, speed: 50, luck: 50, hitPointsPerLevel: 8,
});

/** Every body part wears the same daedric piece. */
const ALL_PARTS = Object.freeze([
  { templateIndex: 107, material: 521 }, // Head
  { templateIndex: 106, material: 521 }, // RightArm
  { templateIndex: 105, material: 521 }, // LeftArm
  { templateIndex: 102, material: 521 }, // Chest
  { templateIndex: 103, material: 521 }, // Hands
  { templateIndex: 104, material: 521 }, // Legs
  { templateIndex: 108, material: 521 }, // Feet
].map((p) => ({ ...p, condition: 1 })));

// ── placement and the target shape ────────────────────────────────
test('armour: a piece lands on its own body part, a shield in the left hand', () => {
  const t = enemyTarget(31);
  equipArmour(t, [
    { templateIndex: 102, material: 519 }, // cuirass -> Chest
    { templateIndex: 107, material: 512 }, // helm -> Head
    { templateIndex: 104, material: 512 }, // greaves -> Legs
    { templateIndex: 108, material: 512 }, // boots -> Feet
    { templateIndex: 109, material: 0 },   // buckler -> LeftHand
  ]);
  assert.equal(struckSlotItem(t, 0).templateIndex, 107, 'Head');
  assert.equal(struckSlotItem(t, 3).templateIndex, 102, 'Chest');
  assert.equal(struckSlotItem(t, 5).templateIndex, 104, 'Legs');
  assert.equal(struckSlotItem(t, 6).templateIndex, 108, 'Feet');
  assert.equal(struckSlotItem(t, 1), null, 'RightArm is bare');
  assert.equal(struckSlotItem(t, 2), null, 'LeftArm is bare');
  assert.equal(struckSlotItem(t, 4), null, 'Hands are bare');
  assert.equal(leftHandShield(t).templateIndex, 109);
  assert.ok(hasWornEquipment(t));
  assert.equal(hasWornEquipment(enemyTarget(31)), false);
});

test('armour: a weapon in the left hand is not a shield', () => {
  const t = enemyTarget(31);
  t.equip.slots[EQUIP_SLOTS.LeftHand] = { group: 'Weapons', templateIndex: 121, material: 9 };
  assert.equal(leftHandShield(t), null);
  assert.equal(targetPartDamage(t, 100, 3, { weapon: EDGED }), 95, 'the Daedra Lord hide still applies');
});

test('armour: armorValues stays a separate, fixed hit-chance field', () => {
  const t = enemyTarget(128, { level: 30 }); // a class enemy, minted at the player's level
  assert.equal(t.armorValues[0], 100, 'the class body starts at 100 before the equipment pass');
  equipArmour(t, [{ templateIndex: 102, material: 521 }], { armorValues: true });
  assert.equal(t.armorValues[0], 60, 'the class clamp');
  const u = enemyTarget(128, { level: 30 });
  const before = [...u.armorValues];
  equipArmour(u, [{ templateIndex: 102, material: 521 }]);
  assert.deepEqual(u.armorValues, before, 'placement alone does not rewrite the hit-chance field');
});

// ── material and condition ────────────────────────────────────────
test('armour: a class foe wears the game\'s own rolled loadout', async () => {
  const seed = 0xabc + 128;
  // Upstream's own booted roll for the same dice: the kit the client's delegate gives (expected, not loosened).
  const { body } = await upstreamBody({ kind: 'loadout', mobile: 128, seed, playerLevel: 45, career: CLASS_CAREER });
  assert.ok(body.pieces.length > 0, 'this seed rolls a kit: a bare one would make the comparison vacuous');
  const t = enemyTarget(128, { level: 45, career: CLASS_CAREER });
  const before = [...t.armorValues];
  gearEnemy(t, { playerLevel: 45, rolls: generator(seed) });
  assert.deepEqual(t.armorValues, body.armorValues, 'the booted kit\'s own ArmorValues pass');
  // Every worn piece, template and material (the differential's "worn" comparison): a class foe's ArmorValues
  // clamp at 60, so different kits can read the same seven numbers.
  const worn = (slots) => Object.values(slots ?? {}).filter(Boolean)
    .map((it) => [it.templateIndex, it.material]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.deepEqual(worn(t.equip?.slots), body.pieces.map((a) => [a.piece, a.material]).sort((a, b) => a[0] - b[0] || a[1] - b[1]), 'every worn piece');
  assert.equal(
    leftHandShield(t)?.templateIndex ?? null,
    body.pieces.find((a) => a.shield)?.piece ?? null,
    'the shield the booted kit rolls',
  );
  assert.notDeepEqual(t.armorValues, before, 'the class ArmorValues pass ran');
  // A monster outside the game's orc/centaur equipment table gets no invented gear.
  const gargoyle = enemyTarget(22, { level: 45 });
  gearEnemy(gargoyle, { playerLevel: 45, rolls: generator(0xabc + 22) });
  assert.equal(hasWornEquipment(gargoyle), false);
});
test('armour: the reduction row is the piece\'s material value / 2', () => {
  assert.equal(armourMaterialId(piece(102, 0)), 1, 'leather (3/2)');
  assert.equal(armourMaterialId(piece(102, 512)), 3, 'iron (7/2)');
  assert.equal(armourMaterialId(piece(102, 521)), 10, 'daedric (21/2)');
  assert.equal(armourMaterialId(piece(109, 0)), 1, 'a leather shield is 1');
  assert.equal(armourMaterialId(piece(109, 521)), 10, 'a daedric shield is 10');
  const leather = armourReduction(piece(102, 0), 100, {});
  const daedric = armourReduction(piece(102, 521), 100, {});
  assert.equal(leather, 88, 'edged row 1: x0.88');
  assert.equal(daedric, 34, 'edged row 10: x0.34');
  assert.ok(daedric < leather);
});

test('armour: condition moves the band (the port has no sharp-edge bonus)', () => {
  const at = (pct, sharpEdge = false) => armourConditionMultiplier(piece(102, 521, pct), { sharpEdge });
  assert.equal(at(1), 1);
  assert.equal(at(0.92), 1, '76%+ is 1 without the wear module');
  assert.equal(at(0.75), 1);
  assert.equal(at(0.5), Math.fround(1.1));
  assert.equal(at(0.2), Math.fround(1.2));
  assert.equal(at(0.05), Math.fround(1.5));
  assert.equal(at(0), Math.fround(1.5));
  assert.equal(at(0.92, true), Math.fround(0.85), 'with the wear module a sharp piece reduces better');
  assert.equal(at(0.8, true), Math.fround(0.95));
  const whole = armourReduction(piece(102, 521, 1), 100, {});
  const worn = armourReduction(piece(102, 521, 0.5), 100, {});
  assert.ok(worn > whole, 'a worn piece protects less');
});

// ── body parts, hide and natural resistance ───────────────────────
test('armour: only the struck part\'s piece replaces the hide', () => {
  const t = enemyTarget(31); // Daedra Lord: hide x0.95, 50s stats, natural 0
  assert.equal(targetPartDamage(t, 100, 3, { weapon: EDGED }), 95);
  equipArmour(t, [{ templateIndex: 102, material: 521, condition: 1 }]);
  assert.equal(targetPartDamage(t, 100, 3, { weapon: EDGED }), 34, 'chest: the cuirass, not the hide');
  assert.equal(targetPartDamage(t, 100, 0, { weapon: EDGED }), 95, 'head: still the hide');
  assert.equal(targetPartDamage(t, 100, 5, { weapon: EDGED }), 95, 'legs: still the hide');
});

test('armour: a class target has no hide; bare parts take natural resistance', () => {
  const t = referenceFoe(30, 'human');
  assert.equal(t.isClass, true);
  assert.equal(targetPartDamage(t, 100, 3, { weapon: EDGED }), 100);
  assert.equal(targetPartDamage(t, 100, 3, { weapon: EDGED }), intrinsicDamage(t, 100, { weapon: EDGED }));

  const tough = enemyTarget(31, { career: { endurance: 60, strength: 55, willpower: 50 } });
  const natural = naturalDamageResistance(tough);
  assert.ok(natural > 0);
  equipArmour(tough, [{ templateIndex: 102, material: 521, condition: 1 }]);
  assert.equal(
    targetPartDamage(tough, 100, 3, { weapon: EDGED }),
    armourReduction(struckSlotItem(tough, 3), 100, { natural }),
    'the piece subtracts the target\'s natural resistance exactly once',
  );
});

test('armour: unarmed, blunt and edged blows read different rows', () => {
  const t = enemyTarget(31);
  equipArmour(t, [{ templateIndex: 102, material: 521, condition: 1 }]);
  assert.equal(targetPartDamage(t, 100, 3, {}), 30, 'unarmed row 10: x0.30');
  assert.equal(targetPartDamage(t, 100, 3, { weapon: BLUNT }), 40, 'blunt row 10: x0.40');
  assert.equal(targetPartDamage(t, 100, 3, { weapon: EDGED }), 34, 'edged row 10: x0.34');
});

test('armour: the reduction rounds half to even and never goes below zero', () => {
  // a 5-point blow on a daedric edged row: 5 x 0.34 = 1.7 -> 2
  assert.equal(armourReduction(piece(102, 521), 5, {}), 2);
  // a 1-point blow: 0.34 -> 0
  assert.equal(armourReduction(piece(102, 521), 1, {}), 0);
  // 2.5 -> 2
  assert.equal(armourReduction(piece(102, 521), 5, { natural: -0.16 }), 2);
  assert.equal(targetPartDamage(enemyTarget(31), 1, 3, { weapon: EDGED }), 1, 'the hide of a 1-point blow is 1');
});

// ── the shield ────────────────────────────────────────────────────
test('shield: strong and weak spots block at their own chance', () => {
  const t = enemyTarget(31);
  equipArmour(t, [{ templateIndex: 109, material: 0, condition: 1 }]); // Buckler: LeftArm+Hands
  const shield = leftHandShield(t);
  assert.equal(shieldBlockChance(t, true, shield), 30, 'strong spot');
  assert.equal(shieldBlockChance(t, false, shield), 20, 'weak spot');
  // 100-point edged blow, all 50s => no natural resistance, no under-armour: hide 95, shield 70.
  assert.equal(targetPartDamage(t, 100, 2, { weapon: EDGED }), 87.5, '0.3 x 70 + 0.7 x 95');
  assert.equal(targetPartDamage(t, 100, 3, { weapon: EDGED }), 90, '0.2 x 70 + 0.8 x 95');
});

test('shield: the incoming kind and the shield\'s own material and condition', () => {
  const at = (pieceMat, condition, weaponLike) => {
    const t = enemyTarget(31);
    equipArmour(t, [{ templateIndex: 109, material: pieceMat, condition }]);
    return targetPartDamage(t, 100, 2, { weapon: weaponLike });
  };
  assert.equal(at(0, 1, EDGED), 87.5);
  assert.equal(at(0, 1, BLUNT), 88.7, 'shield blunt row 1: x0.74');
  assert.equal(at(0, 1, null), 84.2, 'shield unarmed row 1: x0.59');
  assert.equal(at(521, 1, EDGED), 75.5, 'daedric shield: x0.30');
  assert.equal(at(521, 0.05, EDGED), 77.3, 'a worn shield protects less: x0.36');
});

test('shield: it blocks only when its average reduction beats the piece under it', () => {
  const t = enemyTarget(31);
  equipArmour(t, [
    { templateIndex: 102, material: 521, condition: 1 }, // daedric cuirass, Chest
    { templateIndex: 109, material: 0, condition: 1 },   // leather buckler
  ]);
  assert.equal(shieldBeatsUnderArmour(t, 3), false, 'the cuirass beats the buckler');
  assert.equal(shieldBeatsUnderArmour(t, 0), true, 'bare skin does not');
  assert.equal(targetPartDamage(t, 100, 3, { weapon: EDGED }), 34, 'chest keeps the cuirass');
  assert.equal(targetPartDamage(t, 100, 0, { weapon: EDGED }), 90, 'head is blocked at the weak-spot chance');
});

test('shield: it can never or always block at the ends of the chance', () => {
  const low = enemyTarget(31, { career: { agility: 0, speed: 0, strength: 0, endurance: 0, willpower: 0, luck: 0 } });
  equipArmour(low, [{ templateIndex: 112, material: 0, condition: 1 }]);
  assert.ok(shieldBlockChance(low, true, leftHandShield(low)) <= 0, 'the strong spot chance can go below zero');
  assert.equal(
    targetPartDamage(low, 100, 0, { weapon: EDGED }),
    intrinsicDamage(low, 100, { weapon: EDGED }),
    'no block: the hide (which includes the target\'s negative natural resistance)',
  );
  const high = enemyTarget(31, { career: { agility: 100, speed: 100, strength: 100, endurance: 100, willpower: 100, luck: 100 } });
  equipArmour(high, [{ templateIndex: 112, material: 0, condition: 1 }]);
  assert.ok(shieldBlockChance(high, true, leftHandShield(high)) >= 100, 'the strong spot chance can pass 100');
  assert.equal(
    targetPartDamage(high, 100, 0, { weapon: EDGED }),
    shieldReduction(leftHandShield(high), 100, { natural: naturalDamageResistance(high) }),
    'always blocked: the shield row',
  );
});

test('shield: a shield also lowers the hit-chance ArmorValues on its covered parts', () => {
  const t = enemyTarget(31);
  t.armorValues = new Array(7).fill(100); // no row armour: the shield's contribution is visible
  equipArmour(t, [{ templateIndex: 112, material: 0 }], { armorValues: true }); // Tower: Head, LeftArm, Hands, Legs
  assert.equal(t.armorValues[0], 80, 'Head is covered: 100 - shieldValue 4 x 5');
  assert.equal(t.armorValues[2], 80, 'LeftArm is covered');
  assert.equal(t.armorValues[4], 80, 'Hands are covered');
  assert.equal(t.armorValues[5], 80, 'Legs are covered');
  assert.equal(t.armorValues[1], 100, 'RightArm is not covered');
  assert.equal(t.armorValues[3], 100, 'Chest is not covered');
  assert.equal(t.armorValues[6], 100, 'Feet are not covered');
});

test('armour: an arrow uses the same target defence path as a melee blow', () => {
  const ch = simCharacter(character({
    level: 45, raceId: 1,
    stats: { strength: 60, agility: 60, speed: 60, luck: 50 },
    skillOverride: { 33: 120, 34: 20 },
  }), weapon(129, { material: 9 })); // short bow
  const bare = enemyTarget(7, { level: 45 });
  const geared = enemyTarget(7, { level: 45 });
  equipArmour(geared, ALL_PARTS);
  const a = analyze(ch, { target: bare, core: 'overhaul' });
  const b = analyze(ch, { target: geared, core: 'overhaul' });
  assert.equal(a.weapon.ranged, true);
  assert.ok(b.perSwing < a.perSwing, 'the arrow is reduced by the worn armour');
});

test('shield: a pair of stats moves the chance, and the block stays an expected value', () => {
  const stats = { agility: 90, speed: 80, strength: 70, endurance: 60, willpower: 80, luck: 100 };
  const t = enemyTarget(31, { career: stats });
  equipArmour(t, [{ templateIndex: 112, material: 0, condition: 1 }]); // Tower
  const shield = leftHandShield(t);
  const strong = shieldBlockChance(t, true, shield);
  const weak = shieldBlockChance(t, false, shield);
  assert.ok(strong > 55, `a strong spot gains from the stats (${strong})`);
  assert.ok(weak > -5, `a weak spot too (${weak})`);
  const blocked = shieldReduction(shield, 100, { natural: naturalDamageResistance(t) });
  const under = targetPartDamage({ ...t, equip: { slots: {} } }, 100, 3, { weapon: EDGED });
  const p = Math.max(0, Math.min(100, weak)) / 100;
  assert.ok(near(targetPartDamage(t, 100, 3, { weapon: EDGED }), p * blocked + (1 - p) * under), 'the weak-spot expectation');
});

// ── fixed boss armour vs worn equipment ───────────────────────────
test('boss armour: the gate keeps its fixed 60 and a gearless hide', () => {
  const gate = gateTarget(45);
  assert.equal(gate.armorValues[0], 60, 'the fixed hit-chance armour');
  assert.equal(hasWornEquipment(gate), false);
  assert.equal(leftHandShield(gate), null);
  assert.equal(targetPartDamage(gate, 100, 3, { weapon: EDGED }), 95, 'Daedra Lord hide');
});

test('boss armour: worn gear is separate from the fixed field', () => {
  const gate = gateTarget(45);
  equipArmour(gate, [{ templateIndex: 102, material: 521, condition: 1 }]);
  assert.equal(gate.armorValues[0], 60, 'the fixed armour is untouched');
  assert.equal(targetPartDamage(gate, 100, 3, { weapon: EDGED }), 34, 'the chest piece replaces the hide');
  assert.equal(targetPartDamage(gate, 100, 0, { weapon: EDGED }), 95, 'other parts keep it');
});

// ── integration: the layer order ──────────────────────────────────
function fixedWeapon() {
  return weaponOf({
    templateIndex: 121, material: 9, minDamage: 100, maxDamage: 100,
    maxCondition: 100, currentCondition: 100,
  });
}

function integrationCharacter() {
  return simCharacter(character({
    level: 45, raceId: 1,
    stats: { strength: 60, agility: 50, speed: 50, luck: 50, endurance: 50, willpower: 50 },
    skillOverride: { 29: 100, 34: 0 },
  }));
}

test('integration: armour resolves before the boss traits and the per-hit cap', () => {
  const t = enemyTarget(31, { level: 45 });
  equipArmour(t, ALL_PARTS);
  const target = { ...t, bossTraits: ['stoneskin'], hitCap: 20 };
  const w = fixedWeapon();
  const ch = integrationCharacter();
  const r = analyze(ch, { target, core: 'overhaul', weapon: w, swing: 'StrikeLeft' });
  const c = r.hit.crit.chance;
  const defend = (d) => targetPartDamage(t, d, 3, { weapon: w });
  const strike = (d) => (d > 0 ? resistBlow(['stoneskin'], d, { kind: 'melee', weapon: w }) : d);
  const plain = r.damage.plainRolls.map((d) => strike(defend(d)));
  const crit = r.damage.critRolls.map((d) => strike(defend(d)));
  const uncapped = (1 - c) * r.hit.hitPlain * mean(plain) + c * r.hit.hitCrit * mean(crit);
  const capped = (1 - c) * r.hit.hitPlain * mean(plain.map((v) => Math.min(v, r.cap)))
    + c * r.hit.hitCrit * mean(crit.map((v) => Math.min(v, r.cap)));
  assert.ok(near(r.perSwing, uncapped), `per swing ${r.perSwing} vs armour-then-trait ${uncapped}`);
  assert.ok(near(r.cappedPerSwing, capped), `capped ${r.cappedPerSwing} vs armour-then-trait-then-cap ${capped}`);
  assert.ok(r.cappedPerSwing < r.perSwing);
  assert.equal(r.capSource, 'hit cap');
});

test('integration: armour plus the Breach allowance', () => {
  const ch = integrationCharacter();
  const w = fixedWeapon();
  const bare = analyze(ch, { target: gateTarget(45), health: gateTarget(45).maxHealth, weapon: w });
  const geared = (() => {
    const gate = gateTarget(45);
    equipArmour(gate, ALL_PARTS);
    return analyze(ch, { target: gate, health: gate.maxHealth, weapon: w });
  })();
  assert.ok(geared.allowance, 'the relay allowance is still produced');
  assert.ok(geared.cappedPerSwing < bare.cappedPerSwing, 'armour lowers the capped blow');
  assert.ok(geared.ttk > bare.ttk, 'armour lengthens the allowance-bound kill');
});

test('integration: single and dual wield both resolve the target armour once', () => {
  const ch = simCharacter(character({
    level: 45, raceId: 1,
    stats: { strength: 60, agility: 60, speed: 60, luck: 50 },
    skillOverride: { 29: 120, 34: 40 },
  }), weapon(121, { material: 9 }));
  const t = enemyTarget(31);
  equipArmour(t, ALL_PARTS);
  const single = analyze(ch, { target: t, core: 'overhaul' });
  const dual = analyze({ ...ch, offWeapon: { ...ch.weapon, equipSlot: 21 } }, { target: t, core: 'overhaul', dual: true });
  assert.equal(single.targetDefense.wornArmour, true);
  assert.equal(dual.offHand.targetDefense.wornArmour, true);
  assert.ok(dual.dps > single.dps, 'the pair wins on tempo');
  assert.ok(dual.dps < single.dps * 2, 'the off hand is a share, not a second full blow');
});

test('integration: a gearless reference foe and the gate are untouched', () => {
  const ch = integrationCharacter();
  const tough = referenceFoe(45, 'tough');
  const r = analyze(ch, { target: tough, core: 'overhaul', weapon: fixedWeapon() });
  assert.equal(r.targetDefense.wornArmour, false);
  const gate = analyze(ch, { target: gateTarget(45), core: 'overhaul', weapon: fixedWeapon() });
  assert.equal(gate.targetDefense.wornArmour, false);
  assert.equal(gate.targetDefense.hideAt100, 95);
  // With no worn piece every part takes the same outcome, so the model's per-part branch is not
  // reached and the gearless output is the plain intrinsic arm.
  const d = r.damage.plainRolls[0];
  assert.equal(targetPartDamage(tough, d, 3, { weapon: r.weapon }), intrinsicDamage(tough, d, { weapon: r.weapon }));
});

// ── the expectation over the body-part table ──────────────────────
test('armour: hit chance and worn armour share the same body-part roll', () => {
  // A monster whose row armour is 35: a daedric cuirass makes the chest 15 and leaves the other
  // parts at 35. The struck part is rolled once, so P(hit) and the armour's damage are
  // correlated through it; the expectation must not multiply two separate averages.
  const t = enemyTarget(7, { level: 45 });
  equipArmour(t, [{ templateIndex: 102, material: 521, condition: 1 }], { armorValues: true });
  assert.notEqual(t.armorValues[3], t.armorValues[0], 'the chest is better armoured than the rest');
  const w = weaponOf({
    templateIndex: 121, material: 9, minDamage: 100, maxDamage: 100,
    maxCondition: 100, currentCondition: 100,
  });
  const ch = simCharacter(character({
    level: 1, raceId: 1,
    stats: { strength: 50, agility: 50, speed: 50, luck: 50 },
    skillOverride: { 29: 10, 34: 0 },
  }));
  const r = analyze(ch, { target: t, core: 'overhaul', weapon: w, swing: 'StrikeLeft' });
  const c = r.hit.crit.chance;
  const weights = bodyPartWeights('overhaul');
  const joint = weights.reduce((sum, weight, part) => {
    const plain = mean(r.damage.plainRolls.map((d) => targetPartDamage(t, d, part, { weapon: w })));
    const crit = mean(r.damage.critRolls.map((d) => targetPartDamage(t, d, part, { weapon: w })));
    return sum + weight * ((1 - c) * r.hit.byPart.plain[part] * plain + c * r.hit.byPart.crit[part] * crit);
  }, 0);
  assert.ok(near(r.perSwing, joint), `per swing ${r.perSwing} vs joint expectation ${joint}`);
  const allPlain = weights.reduce((sum, weight, part) => sum + weight * mean(r.damage.plainRolls.map((d) => targetPartDamage(t, d, part, { weapon: w }))), 0);
  const allCrit = weights.reduce((sum, weight, part) => sum + weight * mean(r.damage.critRolls.map((d) => targetPartDamage(t, d, part, { weapon: w }))), 0);
  const product = (1 - c) * r.hit.hitPlain * allPlain + c * r.hit.hitCrit * allCrit;
  assert.ok(Math.abs(r.perSwing - product) > 1e-3, 'the two separate averages would be a different number');
});

test('armour: the body-part expectation keeps the table, not an average piece', () => {
  const t = enemyTarget(31);
  equipArmour(t, [{ templateIndex: 102, material: 521, condition: 1 }]); // chest only
  const weights = bodyPartWeights('overhaul');
  assert.equal(weights.length, 7);
  assert.ok(near(weights.reduce((s, v) => s + v, 0), 1));
  assert.equal(weights[3], 4 / 20, 'Chest is four of the twenty entries');
  assert.equal(weights[0], 1 / 20, 'Head is one');
  assert.equal(targetPartDamage(t, 100, 3, { weapon: EDGED }), 34);
  assert.equal(targetPartDamage(t, 100, 0, { weapon: EDGED }), 95);
});
