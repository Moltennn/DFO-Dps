/*
 * test/classicStrength.test.js - Stage 2.7: the classic/stock Strength term.
 *
 * Pinned upstream:
 *   combat/formulas.js:88-92  damageModifier: the stock /5, but with PCAAO installed its
 *                              registered override returns pcaaoDamageModifier (/10)
 *   combat/pcaao.js:224-227   pcaaoDamageModifier = floor((STR-50)/10)
 *   combat/pcaao.js:1873-1875 the override is live only while fixedStrengthDamageModifier is on (default)
 *   combat/formulas.js:470-495 weaponAttackDamage: roll + damageMod + Strength + material, clamp below 1
 *   combat/formulas.js:420-440 handToHandAttackDamage: the same Strength, no clamp before the return
 *
 * The differential suite compares the live /10 and the uninstalled /5, and the whole classic
 * damage range against `combatStats`; this file pins the terms and the local integration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, damageModifier, damageModel, gateTarget, pcaaoDamageModifier, referenceFoe, weaponOf,
} from '../src/model.js';
import { enemyTarget } from '../src/target.js';
import { RACES } from '../src/data.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';

const STATS = Object.freeze({ strength: 80, agility: 70, speed: 90, luck: 60, endurance: 75, willpower: 50 });

const CH = (strength, extra = {}) => character({
  level: 30, raceId: RACES.Breton, stats: { ...STATS, strength }, skills: 50,
  skillOverride: { 29: 80, 34: 40, 19: 0 }, martialPath: null, ...extra,
});

const w = (template = 120) => weaponOf(weapon(template, { material: 1 }));

// ── the two Strength terms ──────────────────────────────────────
test('classic: the live /10 and the uninstalled stock /5', () => {
  assert.equal(pcaaoDamageModifier(80), 3);
  assert.equal(damageModifier(80), 6);
  const ch = simCharacter(CH(80), weapon(120, { material: 1 }));
  const live = analyze(ch, { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false });
  const stock = analyze(ch, { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false, fixedStrengthDamageModifier: false });
  assert.equal(live.damage.parts.strMod, 3);
  assert.equal(stock.damage.parts.strMod, 6);
  assert.equal(live.damage.min, 2 + 3);
  assert.equal(live.damage.max, 16 + 3);
  assert.equal(stock.damage.min, 2 + 6);
  assert.equal(stock.damage.max, 16 + 6);
});

test('classic: the overhaul Strength path is unchanged', () => {
  const ch = simCharacter(CH(80), weapon(120, { material: 1 }));
  const live = analyze(ch, { target: referenceFoe(30, 'tough'), core: 'overhaul' });
  const stock = analyze(ch, { target: referenceFoe(30, 'tough'), core: 'overhaul', fixedStrengthDamageModifier: false });
  assert.equal(live.damage.parts.strMod, 3);
  assert.equal(stock.damage.parts.strMod, 3, 'the classic option never touches the overhaul');
  const claymore = weaponOf(weapon(122, { material: 1 }));
  const two = analyze(ch, { target: referenceFoe(30, 'tough'), core: 'overhaul', weapon: claymore });
  assert.equal(two.damage.parts.strMod, 6, 'the overhaul doubles a two-handed weapon');
});

test('classic: Strength across the range, clamped by the live stat', () => {
  for (const strength of [0, 25, 50, 66, 80, 100, 115]) {
    const liveStat = Math.min(100, strength);
    const ch = simCharacter(CH(strength), weapon(120, { material: 1 }));
    const live = analyze(ch, { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false });
    const stock = analyze(ch, { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false, fixedStrengthDamageModifier: false });
    assert.equal(live.damage.parts.strMod, Math.floor((liveStat - 50) / 10), `live STR ${strength}`);
    assert.equal(stock.damage.parts.strMod, Math.floor((liveStat - 50) / 5), `stock STR ${strength}`);
  }
});

test('classic: a two-handed weapon and a bow do NOT double Strength', () => {
  const ch = simCharacter(CH(80), weapon(122, { material: 1 })); // claymore
  const two = analyze(ch, { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false });
  assert.equal(two.damage.parts.strMod, 3, 'the stock weapon arm adds one Strength term');
  const bowCh = simCharacter(character({
    level: 30, raceId: RACES.Breton, stats: { ...STATS, strength: 80 }, skills: 50,
    skillOverride: { 33: 80, 34: 40 }, martialPath: null,
  }), weapon(129, { material: 1 }));
  const bow = analyze(bowCh, { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false, swing: 'StrikeDown' });
  assert.equal(bow.weapon.ranged, true);
  assert.equal(bow.damage.parts.strMod, 3);
});

test('classic: a low-Strength fist can be negative; a weapon clamps below 1', () => {
  const fists = simCharacter(character({
    level: 30, raceId: RACES.Breton,
    stats: { ...STATS, strength: 0 }, skills: 50, skillOverride: { 4: 50, 34: 0 }, martialPath: null,
  }));
  // The uninstalled stock /5 arm is the one that can go negative; the live /10 reaches only -5.
  const r = analyze(fists, { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false, fixedStrengthDamageModifier: false });
  assert.equal(r.damage.parts.strMod, -10);
  assert.ok(r.damage.min < 0, `the stock fist arm does not clamp (${r.damage.min})`);
  const live = analyze(fists, { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false });
  assert.equal(live.damage.parts.strMod, -5);
  assert.ok(live.damage.min >= 1);
  const blade = simCharacter(CH(0), weapon(120, { material: 1 }));
  const b = analyze(blade, { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false, fixedStrengthDamageModifier: false });
  assert.equal(b.damage.min, 0, 'the stock weapon arm clamps below 1');
  assert.equal(b.damage.max, 6);
});

// ── racial interaction ─────────────────────────────────────────
test('classic: the level-based racial adds to the same blow', () => {
  const dark = simCharacter(character({
    level: 30, raceId: RACES.DarkElf, stats: { ...STATS, strength: 80 }, skills: 50,
    skillOverride: { 29: 80, 34: 40 }, martialPath: null,
  }), weapon(120, { material: 1 }));
  const darkR = analyze(dark, { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false });
  assert.equal(darkR.damage.parts.racial, 7, 'level / 4');
  assert.equal(darkR.damage.parts.strMod, 3);
  assert.equal(darkR.damage.min, 2 + 7 + 3);
  const breton = analyze(simCharacter(CH(80), weapon(120, { material: 1 })), {
    target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false,
  });
  assert.equal(breton.damage.parts.racial, 0);
  assert.equal(darkR.damage.min - breton.damage.min, 7);

  const archer = (raceId) => simCharacter(character({
    level: 30, raceId, stats: { ...STATS, strength: 80 }, skills: 50,
    skillOverride: { 33: 80, 34: 40 }, martialPath: null,
  }), weapon(129, { material: 1 }));
  const wood = analyze(archer(RACES.WoodElf), { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false, swing: 'StrikeDown' });
  const red = analyze(archer(RACES.Redguard), { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false, swing: 'StrikeDown' });
  assert.equal(wood.damage.parts.racial, 10, 'Wood Elf archer level / 3');
  assert.equal(red.damage.parts.racial, 0, 'a Redguard archer gets nothing in the stock ladder');
});

// ── downstream and the remaining classic limits ────────────────
test('classic: the cap, traits and allowance still apply around the Strength term', () => {
  const ch = simCharacter(CH(80), weapon(120, { material: 1 }));
  const target = { ...enemyTarget(31, { level: 30 }), bossTraits: ['stoneskin'], hitCap: 20 };
  const r = analyze(ch, { target, core: 'classic', critDamage: false });
  assert.ok(r.cappedPerSwing <= 20 * r.hit.hit + 1e-9);
  assert.ok(r.perSwing >= r.cappedPerSwing - 1e-9);
  const gate = gateTarget(45);
  const g = analyze(ch, { target: gate, health: gate.maxHealth, core: 'classic', critDamage: false });
  assert.ok(g.allowance);
  assert.ok(Number.isFinite(g.cappedPerSwing));
});

test('classic: backstab still triples the classic blow and adds its hit term', () => {
  const ch = simCharacter(character({
    level: 30, raceId: RACES.Breton, stats: { ...STATS, strength: 80 }, skills: 50,
    skillOverride: { 29: 80, 34: 40, 19: 50 }, martialPath: null,
  }), weapon(120, { material: 1 }));
  const no = analyze(ch, { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false });
  const yes = analyze(ch, { target: referenceFoe(30, 'tough'), core: 'classic', critDamage: false, backstabUptime: 1 });
  assert.equal(yes.backstab.chance, 0.5);
  assert.equal(yes.hit.terms.backstab, 50);
  assert.ok(yes.perSwing > no.perSwing);
});

test('classic: the stock card has no overhaul condition band or material requirement', () => {
  const worn = weapon(120, { material: 1 });
  worn.maxCondition = 1000;
  worn.currentCondition = 59; // 5% band in the overhaul
  const ch = simCharacter(CH(80), worn);
  const target = referenceFoe(30, 'tough');
  const classic = analyze(ch, { target, core: 'classic', critDamage: false });
  const fresh = analyze(simCharacter(CH(80), weapon(120, { material: 1 })), { target, core: 'classic', critDamage: false });
  assert.equal(classic.damage.avg, fresh.damage.avg, 'the stock classic card has no weapon-condition band');
  const overhaul = analyze(ch, { target, core: 'overhaul' });
  const overhaulFresh = analyze(simCharacter(CH(80), weapon(120, { material: 1 })), { target, core: 'overhaul' });
  assert.ok(overhaul.damage.avg < overhaulFresh.damage.avg, 'the overhaul still applies it');
  // The stock classic has no minMetalToHit damage refusal.
  const metal = analyze(simCharacter(CH(80), weapon(120, { material: 1 })), {
    target: { ...target, minMetalToHit: 9 }, core: 'classic', critDamage: false,
  });
  assert.equal(metal.damage.avg, fresh.damage.avg);
});
