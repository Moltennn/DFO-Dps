/*
 * test/racial.test.js - Stage 2.6: the racial damage and hit terms.
 *
 * Pinned upstream:
 *   combat/pcaao.js:281-361  pcaaoRacialModifiers (the overhaul's arms)
 *   combat/formulas.js:292-306  racialModifiers (the stock/classic else-if ladder)
 *   systems/races.js:34-43     the DFU-numbered race ids
 *
 * The differential suite compares every race x weapon x unarmed against both functions;
 * this file pins the terms, the previously missing builds, the hand/ranged paths, the
 * negative races and the integration with the downstream layers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, damageModel, gateTarget, racialModifiers, referenceFoe, weaponOf,
} from '../src/model.js';
import { enemyTarget, equipArmour } from '../src/target.js';
import { RACES, SKILLS } from '../src/data.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';

const STATS = Object.freeze({ strength: 80, agility: 70, speed: 90, luck: 60, endurance: 75, willpower: 50 });

const SKILL_OF = Object.freeze({ 113: 28, 121: 29, 126: 32, 127: 31, 129: 33 });

function chOf(raceId, t, extra = {}) {
  const skillId = t ? SKILL_OF[t] : SKILLS.HandToHand;
  return simCharacter(character({
    level: 30, raceId, stats: STATS, skills: 50,
    skillOverride: { [skillId]: 80, 34: 40, 19: 0 },
    martialPath: null,
    ...extra,
  }), t ? weapon(t, { material: 9 }) : null);
}

const terms = (raceId, t) => racialModifiers(chOf(raceId, t), t ? weaponOf(weapon(t, { material: 9 })) : null, 'overhaul');

// ── every arm, at the sample stats ──────────────────────────────
test('racial: every weapon arm', () => {
  assert.deepEqual(terms(RACES.Argonian, 113), { damage: 4, toHit: 7 });
  assert.deepEqual(terms(RACES.DarkElf, 121), { damage: 5, toHit: 5 });
  assert.deepEqual(terms(RACES.DarkElf, 113), { damage: 2, toHit: 5 });
  assert.deepEqual(terms(RACES.WoodElf, 113), { damage: 3, toHit: 6 });
  assert.deepEqual(terms(RACES.WoodElf, 129), { damage: 5, toHit: 12 });
  assert.deepEqual(terms(RACES.Khajiit, 113), { damage: 3, toHit: 6 });
  assert.deepEqual(terms(RACES.Nord, 127), { damage: 7, toHit: 5 });
  assert.deepEqual(terms(RACES.Nord, 126), { damage: 6, toHit: 6 });
  assert.deepEqual(terms(RACES.Redguard, 121), { damage: 3, toHit: 12 });
  assert.deepEqual(terms(RACES.Redguard, 126), { damage: 4, toHit: 7 });
  assert.deepEqual(terms(RACES.Redguard, 127), { damage: 7, toHit: 5 });
  assert.deepEqual(terms(RACES.Redguard, 129), { damage: 2, toHit: 5 });
});

test('racial: the Wood Elf archery luck term is /25, not /20', () => {
  assert.deepEqual(terms(RACES.WoodElf, 129), { damage: 5, toHit: 12 });
  assert.equal(terms(RACES.WoodElf, 129).toHit - terms(RACES.WoodElf, 113).toHit, 6);
});

test('racial: the two unarmed arms', () => {
  assert.deepEqual(terms(RACES.Nord, null), { damage: 3, toHit: 0 });
  assert.deepEqual(terms(RACES.Khajiit, null), { damage: 6, toHit: 6 });
  for (const raceId of [RACES.Breton, RACES.Redguard, RACES.DarkElf, RACES.HighElf, RACES.WoodElf, RACES.Argonian]) {
    assert.deepEqual(terms(raceId, null), { damage: 0, toHit: 0 }, `race ${raceId} fists`);
  }
});

test('racial: races without an arm stay at zero', () => {
  for (const raceId of [RACES.Breton, RACES.HighElf]) {
    for (const t of [113, 121, 126, 127, 129, null]) {
      assert.deepEqual(terms(raceId, t), { damage: 0, toHit: 0 }, `race ${raceId}, template ${t}`);
    }
  }
  // A race's arm is for its own skill: a Wood Elf long blade, a Khajiit axe, an Argonian bow.
  assert.deepEqual(terms(RACES.WoodElf, 121), { damage: 0, toHit: 0 });
  assert.deepEqual(terms(RACES.Khajiit, 127), { damage: 0, toHit: 0 });
  assert.deepEqual(terms(RACES.Argonian, 129), { damage: 0, toHit: 0 });
});

// ── the classic stock ladder ────────────────────────────────────
test('racial (classic): the else-if ladder, including the Redguard archer quirk', () => {
  const classic = (raceId, t) => {
    const ch = chOf(raceId, t);
    return racialModifiers(ch, t ? weaponOf(weapon(t, { material: 9 })) : null, 'classic');
  };
  assert.deepEqual(classic(RACES.DarkElf, 129), { damage: 7, toHit: 7 }, 'the Dark Elf arm wins over archery');
  assert.deepEqual(classic(RACES.WoodElf, 129), { damage: 10, toHit: 10 }, 'level / 3');
  assert.deepEqual(classic(RACES.Redguard, 129), { damage: 0, toHit: 0 }, 'a Redguard archer gets nothing');
  assert.deepEqual(classic(RACES.Redguard, 121), { damage: 10, toHit: 10 }, 'a Redguard non-archer gets level / 3');
  assert.deepEqual(classic(RACES.Breton, 113), { damage: 0, toHit: 0 });
  assert.deepEqual(classic(RACES.WoodElf, 113), { damage: 0, toHit: 0 }, 'the Wood Elf short blade is overhaul-only');
  assert.deepEqual(classic(RACES.Nord, null), { damage: 0, toHit: 0 }, 'no unarmed stock arm');
});

// ── application: damage, hit and hands ──────────────────────────
test('racial: the damage is in the weapon blow and the hit in the to-hit base', () => {
  const ch = chOf(RACES.WoodElf, 113);
  const w = weaponOf(weapon(113, { material: 9 }));
  const target = referenceFoe(30, 'tough');
  const dmg = damageModel(ch, w, target, 'StrikeLeft', 'overhaul', {});
  assert.equal(dmg.parts.racial, 3);
  assert.equal(dmg.parts.dmgMods, dmg.parts.prof + 3);
  const r = analyze(ch, { target, core: 'overhaul' });
  assert.equal(r.hit.racial.toHit, 6);
  const breton = analyze(chOf(RACES.Breton, 113), { target, core: 'overhaul' });
  assert.equal(breton.damage.parts.racial, 0);
  assert.equal(breton.hit.racial.toHit, 0);
  assert.ok(r.perSwing > breton.perSwing, 'the Wood Elf blade wins on both terms');
});

test('racial: the off hand carries the same racial arms', () => {
  const ch = chOf(RACES.WoodElf, 113);
  const pair = { ...ch, offWeapon: { ...ch.weapon, equipSlot: 21 } };
  const t = enemyTarget(31, { level: 30 });
  const dual = analyze(pair, { target: t, core: 'overhaul', dual: true });
  assert.equal(dual.damage.parts.racial, 3);
  assert.equal(dual.hit.racial.toHit, 6);
  assert.equal(dual.offHand.damage.parts.racial, 3);
  assert.equal(dual.offHand.hit.racial.toHit, 6);
});

test('racial: a bow uses the Wood Elf/Redguard archery arm', () => {
  const ch = chOf(RACES.WoodElf, 129);
  const r = analyze(ch, { target: referenceFoe(30, 'tough'), core: 'overhaul' });
  assert.equal(r.weapon.ranged, true);
  assert.equal(r.damage.parts.racial, 5);
  assert.equal(r.hit.racial.toHit, 12);
  const breton = analyze(chOf(RACES.Breton, 129), { target: referenceFoe(30, 'tough'), core: 'overhaul' });
  assert.equal(breton.damage.parts.racial, 0);
});

test('racial: Nord and Khajiit fists', () => {
  for (const [raceId, expected] of [[RACES.Nord, { damage: 3, toHit: 0 }], [RACES.Khajiit, { damage: 6, toHit: 6 }]]) {
    const ch = chOf(raceId, null);
    const r = analyze(ch, { target: referenceFoe(30, 'tough'), core: 'overhaul' });
    assert.equal(r.weapon, null);
    assert.equal(r.damage.parts.racial, expected.damage);
    assert.equal(r.hit.racial.toHit, expected.toHit);
    const breton = analyze(chOf(RACES.Breton, null), { target: referenceFoe(30, 'tough'), core: 'overhaul' });
    assert.ok(r.perSwing > breton.perSwing, `race ${raceId} fists beat a Breton's`);
  }
});

// ── integration ─────────────────────────────────────────────────
test('racial: backstab, condition, armour, traits and the cap compose', () => {
  const item = weapon(113, { material: 9, condition: 0.5 });
  const chWorn = simCharacter(character({
    level: 30, raceId: RACES.WoodElf, stats: STATS, skills: 50,
    skillOverride: { 28: 80, 34: 40, 19: 50 }, martialPath: null,
  }), item);
  const t = enemyTarget(31, { level: 30 });
  equipArmour(t, [
    { templateIndex: 102, material: 519, condition: 0.8 },
    { templateIndex: 107, material: 512, condition: 1 },
    { templateIndex: 112, material: 0, condition: 1 },
  ], { armorValues: true });
  const target = { ...t, bossTraits: ['stoneskin'], hitCap: 60 };
  const no = analyze(chWorn, { target, core: 'overhaul' });
  const yes = analyze(chWorn, { target, core: 'overhaul', backstabUptime: 1 });
  assert.equal(no.damage.parts.racial, 3);
  assert.equal(no.targetDefense.wornArmour, true);
  assert.ok(yes.perSwing > no.perSwing, 'the backstab mixture is on top');
  assert.ok(yes.cappedPerSwing <= 60 * yes.hit.hit + 1e-9);
  assert.ok(yes.hit.racial.toHit > 0);
});

test('racial: the Breach allowance is still a claimed stream', () => {
  const gate = gateTarget(45);
  const wood = analyze(chOf(RACES.WoodElf, 113), { target: gate, health: gate.maxHealth, core: 'overhaul' });
  const breton = analyze(chOf(RACES.Breton, 113), { target: gate, health: gate.maxHealth, core: 'overhaul' });
  assert.ok(wood.allowance);
  assert.ok(wood.cappedPerSwing > breton.cappedPerSwing);
  assert.ok(wood.ttk > 0);
});
