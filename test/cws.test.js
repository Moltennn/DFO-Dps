/*
 * test/cws.test.js - Stage 3.5.1 local contract tests for ordinary-enemy CWS events.
 *
 * These tests do not use the oracle. They pin the local rules: the row order and missing-record behaviour, the exact
 * Strikes gate, the direct-damage family (4,0 only), the per-effect absorption/reflection/resistance gates, and the
 * fight loop's event order (CWS before the melee blow, no melee blow after a CWS kill).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { referenceFoe, weaponOf } from '../src/model.js';
import { resolveCwsCast, cwsRows, cwsEligible, isDamageHealth } from '../src/cws.js';
import { simulateFight } from '../src/simulateFight.js';

const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});

const effect = (type, subType, magnitude = 10) => ({
  type, subType,
  magnitudeBaseLow: magnitude, magnitudeBaseHigh: magnitude,
  magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
  durationBase: 0, durationMod: 0, durationPerLevel: 1,
  chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
});

const spellOf = (effects, { index = 1, name = 'Test Bolt', element = 4, rangeType = 1 } = {}) => ({
  name, index, element, rangeType, effects,
});

const scripted = (values, fallback = 0.5) => {
  let i = 0;
  const fn = () => (i < values.length ? values[i++] : fallback);
  fn.used = () => i;
  return fn;
};

const itemWith = (params, templateIndex = 121) => {
  const it = weapon(templateIndex, { material: 9 });
  it.enchantments = params.map((param) => ({ type: 2, param }));
  return it;
};

const target = (over = {}) => {
  const t = referenceFoe(30, 'tough');
  return Object.assign(t, { health: 1000, maxHealth: 1000, activeEffects: [] }, over);
};

test('CWS rows keep the item order and resolve a missing record to null', () => {
  const item = itemWith([7, 9, 7]);
  const standard = new Map([[7, spellOf([effect(4, 0)])]]);
  const rows = cwsRows(item, standard);
  assert.deepEqual(rows.map((r) => r.param), [7, 9, 7]);
  assert.equal(rows[0].spell.name, 'Test Bolt');
  assert.equal(rows[1].spell, null);
  assert.equal(rows[2].spell.name, 'Test Bolt');
});

test('the Strikes gate: target, damage, ward, whole, item, CWS row', () => {
  const item = itemWith([1]);
  const standard = new Map([[1, spellOf([effect(4, 0)])]]);
  const t = target();
  const base = { target: t, damagePositive: true, whole: true, item, standard };
  assert.equal(cwsEligible(base), true);
  assert.equal(cwsEligible({ ...base, target: null }), false);
  assert.equal(cwsEligible({ ...base, damagePositive: false }), false, 'a miss / fully stopped blow');
  assert.equal(cwsEligible({ ...base, whole: false }), false, 'the off-hand whole draw failed');
  assert.equal(cwsEligible({ ...base, target: { ...t, warded: true } }), false, 'a warded target');
  assert.equal(cwsEligible({ ...base, item: weapon(121, { material: 9 }) }), false, 'no CWS row');
  assert.equal(cwsEligible({ ...base, item: null }), false);
  // A missing spell record is still a CWS row: the row is walked, it simply casts nothing.
  assert.equal(cwsEligible({ ...base, standard: new Map() }), true);
});

test('direct damage is the actual isDamageHealth family (4,0), not the broad local set', () => {
  assert.equal(isDamageHealth(effect(4, 0)), true);
  assert.equal(isDamageHealth(effect(1, 0)), false);
  assert.equal(isDamageHealth(effect(11, 8)), false);

  const caster = { entity: { level: 30 } };
  const plain = resolveCwsCast({
    spell: spellOf([effect(4, 0, 10)]), caster, casterLevel: 30, target: target(),
    rolls: scripted([0.5, 0.5, 0.5]),
  });
  assert.equal(plain.damage, 8);
  assert.equal(plain.deferred, 0);
  assert.equal(plain.effects[0].savePercent, 80);

  const dot = resolveCwsCast({
    spell: spellOf([effect(1, 0, 10)]), caster, casterLevel: 30, target: target(),
    rolls: scripted([0.5, 0.5, 0.5]),
  });
  assert.equal(dot.damage, 0);
  assert.equal(dot.deferred, 1);

  const transfer = resolveCwsCast({
    spell: spellOf([effect(11, 8, 10)]), caster, casterLevel: 30, target: target(),
    rolls: scripted([0.5, 0.5, 0.5]),
  });
  assert.equal(transfer.damage, 0);
  assert.equal(transfer.deferred, 1);
});

test('resistance and immunity gates', () => {
  const caster = { entity: { level: 30 } };
  const spell = spellOf([effect(4, 0, 10)]);
  const rolls = () => 0.5;

  const resist = resolveCwsCast({
    spell, caster, casterLevel: 30, target: target({ activeEffects: [{ kind: 'spellResistance', chance: 100 }] }), rolls,
  });
  assert.equal(resist.damage, 0);
  assert.equal(resist.resisted, 1);

  const elemental = resolveCwsCast({
    spell, caster, casterLevel: 30,
    target: target({ activeEffects: [{ kind: 'elementalResistance', element: 4, chance: 100 }] }), rolls,
  });
  assert.equal(elemental.damage, 0);
  assert.equal(elemental.resisted, 0, 'elemental resistance is inside savingThrow, not the assign-time gate');

  const immune = resolveCwsCast({
    spell, caster, casterLevel: 30, target: target({ career: { immunityFlags: 2 } }), rolls,
  });
  assert.equal(immune.damage, 0);
});

test('reflection: only the first effect reflects, later effects still land', () => {
  const caster = { entity: { level: 30 } };
  const t = target({ activeEffects: [{ kind: 'spellReflection', chance: 100 }] });
  const one = resolveCwsCast({
    spell: spellOf([effect(4, 0, 10)]), caster, casterLevel: 30, target: t, rolls: () => 0.5,
  });
  assert.equal(one.damage, 0);
  assert.equal(one.reflected, 1);

  const two = resolveCwsCast({
    spell: spellOf([effect(4, 0, 10), effect(4, 0, 20)]), caster, casterLevel: 30, target: t, rolls: () => 0.5,
  });
  assert.equal(two.damage, 16, 'the second effect lands: 20 x 80%');
  assert.equal(two.reflected, 1);
});

test('absorption: career Always and the AbsorbsSpells enchantment', () => {
  const caster = { entity: { level: 30 } };
  const spell = spellOf([effect(4, 0, 10)]);
  const career = resolveCwsCast({
    spell, caster, casterLevel: 30,
    target: target({ career: { spellAbsorptionFlags: 4 }, magicka: 0, maxMagicka: 1000 }), rolls: () => 0.5,
  });
  assert.equal(career.damage, 0);
  assert.equal(career.absorbed, 1);

  const ench = resolveCwsCast({
    spell, caster, casterLevel: 30,
    target: target({ _enchantMods: { absorbsSpells: true }, magicka: 0, maxMagicka: 1000 }),
    rolls: scripted([0.4, 0.4, 0.4, 0.4], 0.4),
  });
  assert.equal(ench.damage, 0);
  assert.equal(ench.absorbed, 1);

  const noAbsorb = resolveCwsCast({
    spell, caster, casterLevel: 30,
    target: target({ _enchantMods: { absorbsSpells: true }, magicka: 0, maxMagicka: 1000 }),
    rolls: scripted([0.6, 0.5, 0.5, 0.5], 0.5),
  });
  assert.ok(noAbsorb.damage > 0);
  assert.equal(noAbsorb.absorbed, 0);
});

test('the fight applies CWS before the melee blow and a CWS kill drops the blow', () => {
  const item = itemWith([1]);
  const standard = new Map([[1, spellOf([effect(4, 0, 100)])]]);
  const ch = simCharacter(BASIC(), item);
  const t = target();

  const r = simulateFight(ch, {
    target: t, health: 500, weapon: weaponOf(item), seed: 0, trace: true, standard,
    cwsRolls: () => 0.5, maxBlows: 1,
  });
  assert.equal(r.trace.length, 1);
  assert.equal(r.cwsTrace.length, 1);
  assert.equal(r.cwsTrace[0].swing, 1);
  assert.equal(r.cwsTrace[0].t, r.trace[0].t);
  assert.equal(r.trace[0].cwsDamage, 80);
  assert.equal(r.trace[0].meleeApplied, true);
  assert.equal(r.damageDealt, r.cwsDamage + r.trace[0].damage);
  assert.equal(r.cwsTrace[0].t, r.trace[0].t, 'the CWS event is at the same attack time, before the blow');

  const kill = simulateFight(ch, {
    target: t, health: 5, weapon: weaponOf(item), seed: 0, trace: true, standard,
    cwsRolls: () => 0.5, maxBlows: 2,
  });
  assert.equal(kill.kill, true);
  assert.equal(kill.cwsKills, 1);
  assert.equal(kill.blows, 1);
  assert.equal(kill.trace[0].cwsKill, true);
  assert.equal(kill.trace[0].meleeApplied, false);
  assert.equal(kill.trace[0].blowDamage > 0, true, 'the melee blow was rolled, then dropped');
  assert.equal(kill.damageDealt, kill.cwsDamage);
  assert.equal(kill.ttk, kill.cwsTrace[0].t);
});

test('the fight gate: a miss, a ward and an off-hand non-whole blow cast nothing', () => {
  const item = itemWith([1]);
  const standard = new Map([[1, spellOf([effect(4, 0, 10)])]]);
  const ch = simCharacter(BASIC(), item);
  const t = target();

  const miss = simulateFight(ch, {
    target: t, health: 500, weapon: weaponOf(item), seed: 4, trace: true, standard,
    cwsRolls: () => 0.5, maxBlows: 1,
  });
  assert.equal(miss.trace[0].formulaPositive, false);
  assert.equal(miss.cwsTrace.length, 0, 'a miss passes damage 0 to the Strikes payload');

  const warded = simulateFight(ch, {
    target: { ...t, warded: true }, health: 500, weapon: weaponOf(item), seed: 0, trace: true, standard,
    cwsRolls: () => 0.5, maxBlows: 3,
  });
  assert.equal(warded.cwsCasts, 0);
  assert.equal(warded.cwsTrace.length, 0);

  const main = weapon(121, { material: 9 });
  const off = weapon(121, { material: 9 });
  off.equipSlot = 21;
  off.enchantments = [{ type: 2, param: 1 }];
  const dualCh = simCharacter(BASIC(), main);
  dualCh.offWeapon = off;
  dualCh._dual = true;
  const dual = simulateFight(dualCh, {
    target: t, health: 500, weapon: weaponOf(main), dual: true, seed: 1, trace: true, standard,
    cwsRolls: () => 0.5, maxBlows: 20,
  });
  const nonWhole = dual.trace.find((e) => e.hand === 'off' && e.whole === false && e.formulaPositive);
  assert.ok(nonWhole, 'the test seed produced an off-hand non-whole positive blow');
  assert.equal(dual.cwsTrace.some((e) => e.swing === nonWhole.swing), false);
  const wholeOff = dual.trace.find((e) => e.hand === 'off' && e.whole === true && e.formulaPositive);
  assert.ok(wholeOff, 'the test seed produced an off-hand whole positive blow');
  assert.ok(dual.cwsTrace.some((e) => e.swing === wholeOff.swing));
});

test('missing records, zero-damage spells and multiple rows keep their order', () => {
  const ch = simCharacter(BASIC(), itemWith([1]));
  const t = target();

  const missingItem = itemWith([99]);
  const missing = simulateFight(simCharacter(BASIC(), missingItem), {
    target: t, health: 500, weapon: weaponOf(missingItem), seed: 0, trace: true, standard: new Map(),
    cwsRolls: () => 0.5, maxBlows: 1,
  });
  assert.equal(missing.cwsTrace.length, 1);
  assert.equal(missing.cwsTrace[0].missing, true);
  assert.equal(missing.cwsTrace[0].damage, 0);
  assert.equal(missing.trace[0].meleeApplied, true);

  const zeroSpell = spellOf([effect(1, 0, 10)]);
  const zeroItem = itemWith([1]);
  const zero = simulateFight(simCharacter(BASIC(), zeroItem), {
    target: t, health: 500, weapon: weaponOf(zeroItem), seed: 0, trace: true, standard: new Map([[1, zeroSpell]]),
    cwsRolls: () => 0.5, maxBlows: 1,
  });
  assert.equal(zero.cwsTrace.length, 1);
  assert.equal(zero.cwsTrace[0].damage, 0);
  assert.equal(zero.cwsTrace[0].deferred, 1);
  assert.equal(zero.trace[0].meleeApplied, true);

  const twoItem = itemWith([1, 2]);
  const twoStandard = new Map([
    [1, spellOf([effect(4, 0, 10)], { index: 1, name: 'First' })],
    [2, spellOf([effect(4, 0, 20)], { index: 2, name: 'Second' })],
  ]);
  const two = simulateFight(simCharacter(BASIC(), twoItem), {
    target: t, health: 500, weapon: weaponOf(twoItem), seed: 0, trace: true, standard: twoStandard,
    cwsRolls: () => 0.5, maxBlows: 1,
  });
  assert.deepEqual(two.cwsTrace.map((e) => e.index), [1, 2]);
  assert.deepEqual(two.cwsTrace.map((e) => e.damage), [8, 16]);
  assert.equal(two.cwsDamage, 24);
});

test('CWS RNG is isolated and deterministic, with or without an injected stream', () => {
  const item = itemWith([1]);
  const standard = new Map([[1, spellOf([effect(4, 0, 100)])]]);
  const ch = simCharacter(BASIC(), item);
  const t = target();
  const args = { target: t, health: 500, weapon: weaponOf(item), seed: 7, trace: true, standard, maxBlows: 5 };

  const a = simulateFight(ch, { ...args, cwsRolls: scripted([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]) });
  const b = simulateFight(ch, { ...args, cwsRolls: scripted([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]) });
  assert.equal(a.cwsDamage, b.cwsDamage);
  assert.deepEqual(a.cwsTrace, b.cwsTrace);

  const c = simulateFight(ch, args);
  const d = simulateFight(ch, args);
  assert.equal(c.cwsDamage, d.cwsDamage);
  assert.deepEqual(c.cwsTrace, d.cwsTrace);
  assert.throws(() => simulateFight(ch, { ...args, cwsRolls: 0.5 }), /cwsRolls must be a function/);
});
