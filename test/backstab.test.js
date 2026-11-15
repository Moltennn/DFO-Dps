/*
 * test/backstab.test.js - Stage 2.4: the upstream backstab path.
 *
 * Pinned upstream:
 *   combat/pcaao.js:469-479  pcaaoBackstabDamage: the >1 gate and the dice100 ×3 roll
 *   combat/pcaao.js:1706     chanceToHitMod += backstabChance
 *   combat/pcaao.js:1724,1768 the ×3 on a landed weapon/fist blow
 *   combat/pcaao.js:1777      damage = Math.max(0, damage), then crit/material/condition
 *   combat/formulas.js:507    the stock twin (same gate and roll)
 *   scenes/hostCombat.js:327  backstabChanceOf: back-facing and no Watchful revenant -> live skill
 *
 * The differential suite compares the roll, the mixture and the assembled blow to the game;
 * this file pins the chance, the flat to-hit term, the ×3-before-crit order, the cap and the
 * main/off-hand integration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, backstabDamage, damageModel, gateTarget, hitModel, referenceFoe, unityRound, weaponOf,
} from '../src/model.js';
import { enemyTarget, equipArmour } from '../src/target.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const PLAYER = (skill, over = {}) => character({
  level: 30, raceId: 1,
  stats: { strength: 70, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
  skills: 0, skillOverride: { 29: 100, 34: 40, 19: skill },
  ...over,
});

const TOUGH = () => referenceFoe(30, 'tough');

// ── chance and eligibility ───────────────────────────────────────
test('backstab: the chance is the live Backstabbing skill', () => {
  const item = weapon(121, { material: 9 });
  for (const skill of [0, 1, 2, 50, 100, 150]) {
    const live = Math.min(100, skill); // a formula reads 100 above the soft cap
    const r = analyze(simCharacter(PLAYER(skill), item), { target: TOUGH(), core: 'overhaul', backstabUptime: 1 });
    assert.equal(r.backstab.skill, live);
    assert.equal(r.backstab.chance, live > 1 ? Math.min(1, live / 100) : 0, `skill ${skill}`);
    assert.equal(r.backstab.toHit, live, 'the flat to-hit term is the live skill');
    assert.equal(r.backstab.uptime, 1);
  }
  // A caller can hand the raw chance (the upstream function takes it directly).
  const raw = analyze(simCharacter(PLAYER(0), item), { target: TOUGH(), core: 'overhaul', backstabUptime: 1, backstabChance: 150 });
  assert.equal(raw.backstab.skill, 150);
  assert.equal(raw.backstab.chance, 1);
});

test('backstab: no back-facing, no chance and no hit term', () => {
  const item = weapon(121, { material: 9 });
  const ch = simCharacter(PLAYER(50), item);
  const ordinary = analyze(ch, { target: TOUGH(), core: 'overhaul' });
  const explicit = analyze(ch, { target: TOUGH(), core: 'overhaul', backstabUptime: 0 });
  assert.equal(ordinary.backstab.uptime, 0);
  assert.equal(ordinary.backstab.chance, 0.5, 'the per-landed-blow chance is exposed; the facing share is 0');
  assert.equal(ordinary.backstab.toHit, 50);
  assert.equal(ordinary.hit.terms.backstab, 0);
  assert.deepEqual(
    [ordinary.perSwing, ordinary.cappedPerSwing, ordinary.hit.hit],
    [explicit.perSwing, explicit.cappedPerSwing, explicit.hit.hit],
    'the default is the ordinary path bit for bit',
  );
});

test('backstab: a Watchful revenant never gives one', () => {
  const item = weapon(121, { material: 9 });
  const ch = simCharacter(PLAYER(100), item);
  const watchful = { ...TOUGH(), revenant: { edge: { watchful: true } } };
  const r = analyze(ch, { target: watchful, core: 'overhaul', backstabUptime: 1 });
  assert.equal(r.backstab.watchful, true);
  assert.equal(r.backstab.skill, 0);
  assert.equal(r.backstab.chance, 0);
  assert.equal(r.hit.terms.backstab, 0);
  const plain = analyze(ch, { target: TOUGH(), core: 'overhaul' });
  assert.equal(r.perSwing, plain.perSwing, 'the Watchful body is the ordinary body');
});

// ── the flat to-hit term ─────────────────────────────────────────
test('backstab: the chance is added flat to the hit roll, not as a percentage', () => {
  const ch = simCharacter(PLAYER(20, { skillOverride: { 29: 50, 34: 0, 19: 20 } }), weapon(121, { material: 9 }));
  const ordinary = hitModel(ch, weaponOf(weapon(121, { material: 9 })), TOUGH(), 'StrikeLeft', 'overhaul');
  const behind = hitModel(ch, weaponOf(weapon(121, { material: 9 })), TOUGH(), 'StrikeLeft', 'overhaul', { backstabBonus: 20 });
  for (let part = 0; part < 7; part++) {
    assert.ok(behind.byPart.plain[part] >= ordinary.byPart.plain[part]);
    if (ordinary.byPart.plain[part] < 0.77) {
      assert.ok(near(behind.byPart.plain[part] - ordinary.byPart.plain[part], 0.2), `part ${part}: +20 points`);
    }
  }
  assert.equal(behind.terms.backstab, 20);
  assert.equal(ordinary.terms.backstab, 0);
  const uptime = analyze(ch, { target: TOUGH(), core: 'overhaul', backstabUptime: 1 });
  const no = analyze(ch, { target: TOUGH(), core: 'overhaul' });
  assert.ok(uptime.hit.hit > no.hit.hit, 'the behind hit chance is higher');
  assert.equal(uptime.hit.terms.backstab, 20);
});

// ── the ×3 roll and its position ─────────────────────────────────
test('backstab: the ×3 gate and the dice threshold', () => {
  assert.equal(backstabDamage(10, 0, 0), 10);
  assert.equal(backstabDamage(10, 1, 0), 10, 'level > 1 is the gate');
  assert.equal(backstabDamage(10, 2, 0), 30);
  assert.equal(backstabDamage(10, 50, 0), 30);
  assert.equal(backstabDamage(10, 50, 0.49), 30);
  assert.equal(backstabDamage(10, 50, 0.5), 10, 'floor(0.5 x 100) is not < 50');
  assert.equal(backstabDamage(10, 100, 0.999), 30);
  assert.equal(backstabDamage(10, 150, 0.999), 30, 'above 100 always lands');
});

test('backstab: the ×3 is before the critical, the material requirement and the condition', () => {
  const ch = simCharacter(PLAYER(50, { skillOverride: { 29: 100, 34: 55, 19: 50 } }), weapon(121, { material: 9 }));
  const w = weaponOf(weapon(121, { material: 9 }));
  const dmg = damageModel(ch, w, TOUGH(), 'StrikeLeft', 'overhaul', {});
  assert.deepEqual(dmg.backstabPlainRolls, dmg.plainRolls.map((d) => d * 3), 'no crit/condition: exactly ×3');
  const critMult = dmg.crit.damageMult;
  assert.ok(critMult > 1 && !Number.isInteger(critMult), 'a fractional crit multiplier exercises the rounding order');
  // The triple is taken first, then the crit multiplier; 3 x round(d x m) is not the same order.
  for (let i = 0; i < dmg.plainRolls.length; i++) {
    assert.equal(dmg.backstabCritRolls[i], unityRound(Math.fround(dmg.plainRolls[i] * 3 * critMult)));
  }
});

test('backstab: the material requirement and condition follow the ×3', () => {
  const ch = simCharacter(PLAYER(50, { skillOverride: { 29: 100, 34: 100, 19: 50 } }), weapon(121, { material: 9 }));
  const w = weaponOf(weapon(121, { material: 9 }));
  const target = { ...TOUGH(), minMetalToHit: 9 };
  const dmg = damageModel(ch, w, target, 'StrikeLeft', 'overhaul', { matReqMulti: 0.4 });
  // The hard multiplier is applied after the triple: the backstab card is round(3 x pre x 0.4),
  // not 3 x round(pre x 0.4).
  assert.equal(
    dmg.backstabPlainRolls[0],
    unityRound(Math.fround(dmg.preFinishRolls[0] * 3 * Math.fround(0.4))),
  );
  assert.equal(dmg.parts.matReq, 0.4);
});

// ── the outcome mixture ─────────────────────────────────────────
test('backstab: the outcome is a ×1/×3 mixture, not a scaled average', () => {
  const item = weapon(121, { material: 9 });
  const ch = simCharacter(PLAYER(50), item);
  const ordinary = analyze(ch, { target: TOUGH(), core: 'overhaul' });
  const behind = analyze(ch, { target: TOUGH(), core: 'overhaul', backstabUptime: 1 });
  const always = analyze(ch, { target: TOUGH(), core: 'overhaul', backstabUptime: 1, backstabChance: 100 });
  assert.equal(behind.backstab.expectedMult, 2, '1 + 2 x 0.5 at full uptime');
  assert.ok(behind.perSwing > ordinary.perSwing);
  assert.ok(behind.perSwing < always.perSwing, 'a 50% chance is not the always-×3 outcome');
  assert.ok(always.perSwing > ordinary.perSwing * 2.5, 'the always-×3 blow is about three times the roll');
  const half = analyze(ch, { target: TOUGH(), core: 'overhaul', backstabUptime: 0.5 });
  assert.ok(half.perSwing > ordinary.perSwing && half.perSwing < behind.perSwing);
  assert.equal(half.backstab.expectedMult, 1.5);
});

test('backstab: a skill of 1 gains the hit term but never the ×3', () => {
  const item = weapon(121, { material: 9 });
  const ch = simCharacter(PLAYER(1, { skillOverride: { 29: 50, 34: 0, 19: 1 } }), item);
  const ordinary = analyze(ch, { target: TOUGH(), core: 'overhaul' });
  const behind = analyze(ch, { target: TOUGH(), core: 'overhaul', backstabUptime: 1 });
  assert.equal(behind.backstab.chance, 0);
  assert.equal(behind.hit.terms.backstab, 1);
  assert.ok(behind.perSwing > ordinary.perSwing, 'the +1 hit term still helps');
});

// ── caps, hands and ranged ───────────────────────────────────────
test('backstab: the per-hit cap sees the bigger ×3 claims', () => {
  const item = weapon(121, { material: 9 });
  const ch = simCharacter(PLAYER(50), item);
  const capped = (uptime) => analyze(ch, {
    target: { ...TOUGH(), hitCap: 40 }, core: 'overhaul', backstabUptime: uptime,
  });
  const no = capped(0);
  const yes = capped(1);
  assert.ok(yes.cappedPerSwing > no.cappedPerSwing, 'the larger claims lift the capped mean');
  assert.ok(yes.cappedPerSwing <= 40 * yes.hit.hit + 1e-9);
  assert.ok(yes.cappedPerSwing < yes.perSwing, 'the cap binds some ×3 blows');
});

test('backstab: the off hand carries its own chance, hit term and share', () => {
  const ch = simCharacter(PLAYER(50), weapon(121, { material: 9 }));
  const pair = { ...ch, offWeapon: { ...ch.weapon, equipSlot: 21 } };
  const t = enemyTarget(31, { level: 30 });
  const dual = analyze(pair, { target: t, core: 'overhaul', dual: true, backstabUptime: 1 });
  assert.equal(dual.offHand.backstab.chance, 0.5);
  assert.equal(dual.offHand.backstab.toHit, 50);
  assert.equal(dual.offHand.hit.terms.backstab, 50);
  assert.ok(dual.offHand.backstab.min > 0);
  const no = analyze(pair, { target: t, core: 'overhaul', dual: true });
  assert.ok(dual.offHand.perSwing > no.offHand.perSwing);
  assert.ok(dual.offHand.perSwing < dual.perSwing, 'the off hand is still the lesser blow');
});

test('backstab: a bow can backstab', () => {
  const bowCh = simCharacter(character({
    level: 30, raceId: 1,
    stats: { strength: 70, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 33: 100, 34: 40, 19: 50 },
  }), weapon(129, { material: 9 }));
  const no = analyze(bowCh, { target: TOUGH(), core: 'overhaul' });
  const behind = analyze(bowCh, { target: TOUGH(), core: 'overhaul', backstabUptime: 1 });
  assert.equal(behind.weapon.ranged, true);
  assert.equal(behind.backstab.chance, 0.5);
  assert.equal(behind.backstab.toHit, 50);
  assert.ok(behind.perSwing > no.perSwing);
});

// ── integration: armour, traits, cap and the allowance ───────────
test('backstab: armour, traits and the cap compose with the ×3 outcome', () => {
  const ch = simCharacter(PLAYER(50), weapon(121, { material: 9 }));
  const t = enemyTarget(31, { level: 30 });
  equipArmour(t, [
    { templateIndex: 102, material: 519, condition: 0.8 },
    { templateIndex: 107, material: 512, condition: 1 },
    { templateIndex: 109, material: 0, condition: 1 },
  ], { armorValues: true });
  const target = { ...t, bossTraits: ['stoneskin'], hitCap: 60 };
  const no = analyze(ch, { target, core: 'overhaul' });
  const yes = analyze(ch, { target, core: 'overhaul', backstabUptime: 1 });
  assert.equal(yes.targetDefense.wornArmour, true);
  assert.equal(yes.backstab.chance, 0.5);
  assert.ok(yes.perSwing > no.perSwing);
  assert.ok(yes.cappedPerSwing > no.cappedPerSwing);
  assert.ok(yes.cappedPerSwing <= 60 * yes.hit.hit + 1e-9);
});

test('backstab: the Breach allowance still claims the mixed blows', () => {
  const ch = simCharacter(PLAYER(50), weapon(121, { material: 9 }));
  const gate = gateTarget(45);
  const no = analyze(ch, { target: gate, health: gate.maxHealth, core: 'overhaul' });
  const yes = analyze(ch, { target: gate, health: gate.maxHealth, core: 'overhaul', backstabUptime: 1 });
  assert.ok(yes.allowance);
  assert.ok(yes.cappedPerSwing > no.cappedPerSwing);
  assert.ok(yes.allowance.weaponOnly.sustainedDps > 0);
  assert.ok(yes.ttk > 0);
});
