/*
 * test/condition.test.js - Stage 2.5: the weapon-condition damage band.
 *
 * Pinned upstream:
 *   systems/item/itemTemplates.js:277-279  conditionPercentage = trunc(100 * current / max), or 100
 *   combat/pcaao.js:607-637                pcaaoAlterDamageBasedOnWepCondition
 *   combat/pcaao.js:1800-1804              the band's place: after crit/material, before the target
 *
 * The differential suite compares every band and the assembled blow to the game; this file pins
 * the integer percentage, every boundary, the blunt/blade split, sharpEdge, hands, ranged and
 * the pipeline order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, conditionMultiplier, damageModel, gateTarget, referenceFoe, unityRound, weaponOf,
} from '../src/model.js';
import { enemyTarget } from '../src/target.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';

const BLADE = 121; // Katana: Long Blade
const BLUNT = 126; // Warhammer: Blunt Weapon

/** A weapon item at an exact current/max condition (max 1000, so pct*10 is exact). */
function at(template, pct, material = 9) {
  const item = weapon(template, { material });
  item.maxCondition = 1000;
  item.currentCondition = Math.round(pct * 10);
  return item;
}

/** The band as the formula applies it: the multiplier, or the integer-rounded blow. */
function band(template, pct, sharpEdge = false, damage = 100, material = 9) {
  const w = weaponOf(at(template, pct, material));
  const mult = conditionMultiplier(w, sharpEdge);
  return mult === 1 ? damage : unityRound(Math.fround(damage * Math.fround(mult)));
}

const CH = (extra = {}) => character({
  level: 30, raceId: 1,
  stats: { strength: 70, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
  skills: 0, skillOverride: { 29: 100, 34: 40, 19: 0 },
  ...extra,
});

// ── percentage and boundaries ───────────────────────────────────
test('condition: the percentage is truncated, not floated', () => {
  assert.equal(weaponOf(at(BLADE, 5)).conditionPercent, 5, '50 / 1000');
  assert.equal(weaponOf(at(BLADE, 5.9)).conditionPercent, 5, '59 / 1000 truncates to 5');
  assert.equal(weaponOf(at(BLADE, 6)).conditionPercent, 6);
  assert.equal(weaponOf(at(BLADE, 75.9)).conditionPercent, 75);
  assert.equal(weaponOf(at(BLADE, 76)).conditionPercent, 76);
  assert.equal(weaponOf(at(BLADE, 91.9)).conditionPercent, 91);
  assert.equal(weaponOf(at(BLADE, 92)).conditionPercent, 92);
  const fractional = weapon(121, { material: 9 });
  fractional.maxCondition = 1000;
  fractional.currentCondition = 59.5;
  assert.equal(weaponOf(fractional).conditionPercent, 5, 'a fractional current still truncates');
  const noMax = { group: 'Weapons', templateIndex: BLADE, material: 9, maxCondition: 0, currentCondition: 0 };
  assert.equal(weaponOf(noMax).conditionPercent, 100, 'no maximum reads as full');
});

test('condition: every blade band', () => {
  assert.equal(band(BLADE, 0), 25);
  assert.equal(band(BLADE, 5), 25, '5% is the bottom band');
  assert.equal(band(BLADE, 5.9), 25, '5.9 truncates into the bottom band, not full damage');
  assert.equal(band(BLADE, 6), 45, '6% opens the 0.45 band');
  assert.equal(band(BLADE, 15), 45);
  assert.equal(band(BLADE, 16), 70);
  assert.equal(band(BLADE, 40), 70);
  assert.equal(band(BLADE, 41), 85);
  assert.equal(band(BLADE, 60), 85);
  assert.equal(band(BLADE, 61), 100);
  assert.equal(band(BLADE, 75), 100);
  assert.equal(band(BLADE, 76), 100, 'sharpEdge off: no bonus at 76%+');
  assert.equal(band(BLADE, 92), 100);
  assert.equal(band(BLADE, 100), 100);
});

test('condition: every blunt band', () => {
  assert.equal(band(BLUNT, 0), 50);
  assert.equal(band(BLUNT, 5), 50);
  assert.equal(band(BLUNT, 5.9), 50, '5.9 truncates into the 0.5 band');
  assert.equal(band(BLUNT, 6), 65);
  assert.equal(band(BLUNT, 15), 65);
  assert.equal(band(BLUNT, 16), 80);
  assert.equal(band(BLUNT, 40), 80);
  assert.equal(band(BLUNT, 41), 90);
  assert.equal(band(BLUNT, 60), 90);
  assert.equal(band(BLUNT, 61), 100);
  assert.equal(band(BLUNT, 75), 100);
  assert.equal(band(BLUNT, 76), 100);
  assert.equal(band(BLUNT, 92), 100);
  assert.equal(band(BLUNT, 100), 100);
});

test('condition: sharpEdge restores the >75% bands', () => {
  assert.equal(band(BLADE, 75, true), 100);
  assert.equal(band(BLADE, 76, true), 110, 'blade x1.1');
  assert.equal(band(BLADE, 91, true), 110);
  assert.equal(band(BLADE, 92, true), 130, 'blade x1.3');
  assert.equal(band(BLUNT, 76, true), 100, 'a blunt weapon has no 76% edge');
  assert.equal(band(BLUNT, 92, true), 110, 'a blunt weapon x1.1 at 92%');
  // The lower bands are unchanged by the module.
  assert.equal(band(BLADE, 5.9, true), 25);
  assert.equal(band(BLUNT, 5.9, true), 50);
});

test('condition: the blow is rounded half to even inside the band', () => {
  // 10 x 0.45 = 4.5 -> 4; 10 x 0.25 = 2.5 -> 2; 10 x 0.65 = 6.5 -> 6.
  assert.equal(band(BLADE, 10, false, 10), 4);
  assert.equal(band(BLADE, 0, false, 10), 2);
  assert.equal(band(BLUNT, 10, false, 10), 6);
  assert.equal(band(BLADE, 50, false, 7), 6, '7 x 0.85 = 5.95 -> 6');
});

test('condition: the material does not change the band, only the maximum', () => {
  for (const material of [0, 1, 5, 9]) {
    assert.equal(band(BLADE, 50, false, 100, material), 85, `material ${material}`);
    assert.equal(band(BLADE, 5.9, false, 100, material), 25);
  }
});

test('condition: each hand wears its own value', () => {
  const main = at(BLADE, 100);
  const off = { ...at(BLADE, 5.9), equipSlot: 21 };
  const ch = simCharacter(CH(), main);
  const pair = { ...ch, offWeapon: off };
  const t = enemyTarget(31, { level: 30 });
  const dual = analyze(pair, { target: t, core: 'overhaul', dual: true });
  assert.equal(dual.weapon.conditionPercent, 100);
  assert.equal(dual.offHand.weapon.conditionPercent, 5);
  const fresh = { ...ch, offWeapon: { ...at(BLADE, 100), equipSlot: 21 } };
  const healthy = analyze(fresh, { target: t, core: 'overhaul', dual: true });
  assert.ok(dual.offHand.perSwing < healthy.offHand.perSwing, 'the off hand is the worn one');
  assert.equal(dual.damage.avg, healthy.damage.avg, 'the main hand is untouched');
});

test('condition: a bow wears its own condition', () => {
  const worn = weapon(129, { material: 9 });
  worn.maxCondition = 1000;
  worn.currentCondition = 59;
  const ch = simCharacter(character({
    level: 30, raceId: 1,
    stats: { strength: 70, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 33: 100, 34: 0, 19: 0 },
  }), worn);
  const r = analyze(ch, { target: referenceFoe(30, 'tough'), core: 'overhaul' });
  assert.equal(r.weapon.ranged, true);
  assert.equal(r.weapon.conditionPercent, 5);
  const healthy = analyze(simCharacter(character({
    level: 30, raceId: 1,
    stats: { strength: 70, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 33: 100, 34: 0, 19: 0 },
  }), weapon(129, { material: 9 })), { target: referenceFoe(30, 'tough'), core: 'overhaul' });
  assert.ok(r.perSwing < healthy.perSwing);
});

test('condition: fists do not take a weapon-condition band', () => {
  const ch = simCharacter(character({
    level: 30, raceId: 1,
    stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
    skills: 0, skillOverride: { 34: 0 },
  }));
  const wrapsWorn = { group: 'Weapons', templateIndex: 563, material: 0, maxCondition: 1000, currentCondition: 59 };
  const wrapsFresh = { ...wrapsWorn, currentCondition: 1000 };
  const a = analyze({ ...ch, wraps: wrapsWorn }, { target: referenceFoe(30, 'tough'), core: 'overhaul' });
  const b = analyze({ ...ch, wraps: wrapsFresh }, { target: referenceFoe(30, 'tough'), core: 'overhaul' });
  assert.equal(a.perSwing, b.perSwing, 'the wraps’ condition is not a weapon band');
  assert.equal(a.weapon, null);
});

// ── position in the pipeline ────────────────────────────────────
test('condition: after the critical and the material requirement', () => {
  const item = at(BLADE, 5); // 0.25
  const w = weaponOf(item);
  const ch = simCharacter(character({
    level: 30, raceId: 1,
    stats: { strength: 50, agility: 50, speed: 50, luck: 50 },
    skillOverride: { 29: 0, 34: 100 }, // critical multiplier 2
  }));
  const dmg = damageModel(ch, w, referenceFoe(30, 'tough'), 'StrikeLeft', 'overhaul', { matReqMulti: 0.5 });
  const plain = dmg.plainRolls[0];
  const crit = dmg.critRolls[0];
  // The raw roll is d; the band is the last of the three stages.
  const d = dmg.preFinishRolls[0];
  assert.equal(plain, unityRound(Math.fround(unityRound(Math.fround(d * Math.fround(0.5))) * Math.fround(0.25))));
  assert.equal(crit, unityRound(Math.fround(unityRound(Math.fround(unityRound(Math.fround(d * 2)) * Math.fround(0.5))) * Math.fround(0.25))));
});

test('condition: the ×3 backstab is taken before the band', () => {
  const item = at(BLADE, 5); // 0.25
  const w = weaponOf(item);
  const ch = simCharacter(character({
    level: 30, raceId: 1,
    stats: { strength: 50, agility: 50, speed: 50, luck: 50 },
    skillOverride: { 29: 0, 34: 0 },
  }));
  const dmg = damageModel(ch, w, referenceFoe(30, 'tough'), 'StrikeLeft', 'overhaul', {});
  const d = dmg.preFinishRolls[0];
  assert.equal(dmg.backstabPlainRolls[0], unityRound(Math.fround(d * 3 * 0.25)));
});

test('condition: the Breach allowance claims the worn blow', () => {
  const gate = gateTarget(45);
  const worn = analyze(simCharacter(CH(), at(BLADE, 5.9)), { target: gate, health: gate.maxHealth, core: 'overhaul' });
  const fresh = analyze(simCharacter(CH(), at(BLADE, 100)), { target: gate, health: gate.maxHealth, core: 'overhaul' });
  assert.ok(worn.allowance, 'the relay allowance is still produced');
  assert.ok(worn.cappedPerSwing < fresh.cappedPerSwing, 'the 5% band lowers the claim');
});

test('condition: wear over time is not simulated', () => {
  const item = at(BLADE, 50);
  const ch = simCharacter(CH(), item);
  const before = item.currentCondition;
  analyze(ch, { target: referenceFoe(30, 'tough'), core: 'overhaul' });
  analyze(ch, { target: referenceFoe(30, 'tough'), core: 'overhaul' });
  assert.equal(item.currentCondition, before, 'the static card does not wear the weapon');
});
