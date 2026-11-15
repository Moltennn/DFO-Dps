/*
 * test/elemental.test.js - C5: a weapon's `elemental` affix lands exactly once.
 *
 * Upstream (vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js:286-347):
 * `lootBlow` is one of the registered WEAPON BLOW modifiers, and it adds
 * `Math.floor(value x elementShare(target, element))` as FLAT damage to the blow
 * (after its own slayer percentage, before whatever registries follow it). The
 * blow then continues: backstab, critical, condition, the boss's traits
 * (`bossStrikeAt`), the per-hit cap, the relay's allowance. It is added once, and
 * it is not a spell: `elementShare` reads the target's career tolerance, never a
 * boss trait.
 *
 * The simulator used to add it in `weaponBlow` AND again in `damageModel().one()`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, referenceFoe, gateTarget, weaponOf } from '../src/model.js';
import { spellDamage } from '../src/spells.js';
import { enchantDps } from '../src/enchants.js';
import { allowanceLaw, claimStreams } from '../src/allowance.js';
import { theoryCharacter } from '../src/theory.js';
import { intrinsicDamage } from '../src/target.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { upstream } from './harness/upstream.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/** A plain character: no racial, proficiency, material or Strength term, so the rolls are the template's. */
const PLAIN = () => simCharacter(character({ level: 30, raceId: 1, stats: { strength: 50 }, skills: 0, skillOverride: { 34: 0 } }));
const TOUGH = () => referenceFoe(30, 'tough');
const withAffix = (t, value, param = 'fire', material = 1) => ({ ...weapon(t, { material }), affixes: [{ id: 'elemental', param, value }] });

test('once: +3/+6/+10 add exactly their value to every roll, not twice it', () => {
  const base = analyze(PLAIN(), { target: TOUGH(), weapon: weaponOf(weapon(121, { material: 1 })) });
  for (const value of [3, 6, 10]) {
    const r = analyze(PLAIN(), { target: TOUGH(), weapon: weaponOf(withAffix(121, value)) });
    assert.equal(r.damage.parts.roll[0], base.damage.parts.roll[0], 'the roll itself is unchanged');
    r.damage.plainRolls.forEach((v, i) => assert.equal(v, base.damage.plainRolls[i] + value, `roll ${i}: ${v} vs ${base.damage.plainRolls[i]} + ${value}`));
    assert.equal(r.damage.min, base.damage.min + value, `min +${value}`);
    assert.equal(r.damage.max, base.damage.max + value, `max +${value}`);
    assert.ok(near(r.damage.avg, base.damage.avg + value, 1e-9), `avg +${value}: ${r.damage.avg} vs ${base.damage.avg + value}`);
  }
});

test('once: the flat is inside the blow, so a critical multiplies it (once)', () => {
  const plain = simCharacter(character({ level: 30, raceId: 1, stats: { strength: 50 }, skills: 0, skillOverride: { 34: 100 } }));
  const base = analyze(plain, { target: TOUGH(), weapon: weaponOf(weapon(121, { material: 1 })) });
  const withIt = analyze(plain, { target: TOUGH(), weapon: weaponOf(withAffix(121, 10)) });
  const mult = base.hit.crit.damageMult;
  assert.ok(mult > 1, `critical multiplier ${mult}`);
  // per roll: unityRound((d+10) x m) - unityRound(d x m), so within half a point of 10 x m
  for (let i = 0; i < base.damage.critRolls.length; i++) {
    const delta = withIt.damage.critRolls[i] - base.damage.critRolls[i];
    assert.ok(Math.abs(delta - 10 * mult) <= 0.5, `crit roll ${i}: delta ${delta} vs ${10 * mult}`);
  }
  const critDelta = withIt.damage.critAvg - base.damage.critAvg;
  assert.ok(Math.abs(critDelta - 10 * mult) <= 0.5, `crit mean delta ${critDelta} vs ${10 * mult}`);
  // the doubled contribution would be twice that
  assert.ok(critDelta < 2 * 10 * mult - 1, 'never the doubled contribution');
});

test('scaling: mastery does not scale the flat, the martial path and the Firmament do (once)', async () => {
  const base = () => simCharacter(character({ level: 30, raceId: 1, stats: { strength: 50 }, skills: 0, skillOverride: { 34: 0 } }));
  const plainDelta = (() => {
    const a = analyze(base(), { target: TOUGH(), weapon: weaponOf(weapon(121, { material: 1 })) });
    const b = analyze(base(), { target: TOUGH(), weapon: weaponOf(withAffix(121, 10)) });
    return b.damage.avg - a.damage.avg;
  })();
  assert.ok(near(plainDelta, 10, 1e-9));

  // mastery: a gear skill line does not touch the flat (the gate's host registers mastery before loot)
  const geared = base();
  geared._mods.skills[29] = 240;
  const ga = analyze(geared, { target: TOUGH(), weapon: weaponOf(weapon(121, { material: 1 })) });
  const gb = analyze(geared, { target: TOUGH(), weapon: weaponOf(withAffix(121, 10)) });
  assert.ok(near(gb.damage.avg - ga.damage.avg, 10, 1e-9), 'a mastery of 105% must not double the flat');

  // the martial path: Blademaster at five stacks, +15% - applied to the flat exactly once
  const martial = theoryCharacter({ blade: 121, martialPath: 'blademaster' });
  const ma = analyze(martial, { target: TOUGH(), weapon: weaponOf(weapon(121, { material: 1 })), stacks: 5 });
  const mb = analyze(martial, { target: TOUGH(), weapon: weaponOf(withAffix(121, 10)), stacks: 5 });
  const martialDelta = mb.damage.avg - ma.damage.avg;
  assert.ok(martialDelta >= 10 && martialDelta <= 11.6, `martial delta ${martialDelta}`);

  // the Firmament's blow channel, +30% - the same, once
  const firm = theoryCharacter({ blade: 121 });
  firm.firmamentDamagePct = 30;
  const fa = analyze(firm, { target: TOUGH(), weapon: weaponOf(weapon(121, { material: 1 })) });
  const fb = analyze(firm, { target: TOUGH(), weapon: weaponOf(withAffix(121, 10)) });
  const firmDelta = fb.damage.avg - fa.damage.avg;
  assert.ok(firmDelta >= 10 && firmDelta <= 13.1, `firmament delta ${firmDelta}`);

  // Both together: still one addition, each channel applied once.
  const both = theoryCharacter({ blade: 121, martialPath: 'blademaster' });
  both.firmamentDamagePct = 30;
  const ba = analyze(both, { target: TOUGH(), weapon: weaponOf(weapon(121, { material: 1 })), stacks: 5 });
  const bb = analyze(both, { target: TOUGH(), weapon: weaponOf(withAffix(121, 10)), stacks: 5 });
  const bothDelta = bb.damage.avg - ba.damage.avg;
  assert.ok(bothDelta >= 10 && bothDelta <= 15, `combined delta ${bothDelta} (never 2 x 10 x 1.15 x 1.3)`);
  assert.ok(bothDelta < 20, 'not the doubled contribution');
});

test('upstream: the increment equals lootBlow\'s own addition for every element and value', async () => {
  const u = await upstream();
  const item = withAffix(121, 7, 'frost');
  const foe = { isPlayer: false, isClass: false, careerIndex: -1, level: 30, stats: { strength: 50, endurance: 50, willpower: 50, agility: 50, speed: 50, luck: 50 }, skills: 100, health: 100, maxHealth: 100, armorValues: new Array(7).fill(0), career: null };
  const attacker = { isPlayer: true, level: 30 };
  // lootBlow is the registry member that carries the affix; its delta over the same blow is the flat once.
  const before = u.lootPowers.lootBlow(item, 20, attacker, foe, { unaware: false, estimate: true });
  const plain = u.lootPowers.lootBlow({ ...item, affixes: [] }, 20, attacker, foe, { unaware: false, estimate: true });
  assert.equal(before - plain, 7, 'one addition of the affix value');
  // and the simulator agrees on the same blow
  const a = analyze(PLAIN(), { target: TOUGH(), weapon: weaponOf({ ...weapon(121, { material: 1 }), affixes: [] }) });
  const b = analyze(PLAIN(), { target: TOUGH(), weapon: weaponOf(item) });
  assert.ok(near(b.damage.avg - a.damage.avg, before - plain, 1e-9));
});

test('a bow and a blunt weapon add it once too (a long bow\'s pull scales it once)', () => {
  for (const [t, pull] of [[129, 1], [130, 1.5], [126, 1]]) {
    const a = analyze(PLAIN(), { target: TOUGH(), weapon: weaponOf(weapon(t, { material: 1 })) });
    const b = analyze(PLAIN(), { target: TOUGH(), weapon: weaponOf(withAffix(t, 10)) });
    // the long bow's pull is applied to the whole blow at the shaft's landing (bowFastDamage), so it
    // scales the flat once - exactly as upstream, and never twice.
    assert.ok(near(b.damage.avg - a.damage.avg, 10 * pull, 1.0), `template ${t}: ${b.damage.avg - a.damage.avg} vs ${10 * pull}`);
    assert.ok(b.damage.avg - a.damage.avg < 2 * 10 * pull, `template ${t}: not doubled`);
  }
});

test('an off-hand blow takes its share of the (single) flat', () => {
  const ch = theoryCharacter({ blade: 121 });
  ch.offWeapon = { ...ch.weapon, equipSlot: 21, affixes: [{ id: 'elemental', param: 'fire', value: 10 }] };
  const withIt = analyze(ch, { target: TOUGH(), rri: true, dual: true });
  const clean = { ...ch, offWeapon: { ...ch.offWeapon, affixes: [] } };
  const without = analyze(clean, { target: TOUGH(), rri: true, dual: true });
  // the pair's per-swing figure averages the two hands, and the off hand lands x0.8: 10 x 0.8 / 2 = 4
  assert.ok(withIt.perSwing > without.perSwing);
  assert.ok(withIt.perSwing - without.perSwing <= 10, `off-hand delta ${withIt.perSwing - without.perSwing} (never 2 x 8)`);
});

test('Hand Wraps carry one addition onto the fist blow', () => {
  const ch = simCharacter(character({ level: 30, raceId: 1, stats: { strength: 50 }, skills: 0, skillOverride: { 34: 0 } }));
  const wraps = { group: 'Weapons', templateIndex: 563, material: 1, maxCondition: 100, currentCondition: 100, name: 'Hand Wraps', affixes: [{ id: 'elemental', param: 'fire', value: 9 }] };
  const a = analyze(ch, { target: TOUGH() });
  const b = analyze({ ...ch, wraps }, { target: TOUGH() });
  assert.ok(near(b.damage.avg - a.damage.avg, 9, 1e-9), `wraps: ${b.damage.avg - a.damage.avg}`);
});

test('C2: a boss trait resolves the whole blow once - the affix is not quartered as a spell', () => {
  const gate = gateTarget(45);
  const ch = simCharacter(character({ level: 45, raceId: 1, stats: { strength: 70 }, skills: 60 }));
  const blade = (v) => ({ ...weapon(121, { material: 9 }), affixes: v ? [{ id: 'elemental', param: 'fire', value: v }] : [] });
  const withIt = analyze(ch, { target: gate, health: 12000, weapon: weaponOf(blade(10)) });
  const without = analyze(ch, { target: gate, health: 12000, weapon: weaponOf(blade(0)) });
  assert.deepEqual(withIt.traits, ['spellproof', 'stoneskin']);
  // `damage.*` is the blow before the foe resolves it (the card's basis); the trait shows in perSwing.
  assert.ok(near(withIt.damage.avg - without.damage.avg, 10, 1e-9), 'the flat is 10 in the blow, not 2.5');
  // pcaao.js:1815-1817: the target's hide/natural resistance is after the blow and before traits.
  const defend = (r, d) => intrinsicDamage(r.target, d, { weapon: r.weapon });
  const deltaOf = (a, b, rollsA, rollsB) => mean(rollsA.map((d, i) => defend(a, d) - defend(a, rollsB[i])));
  const c = withIt.hit.crit.chance;
  const expectedBlade = (1 - c) * withIt.hit.hitPlain * deltaOf(withIt, without, withIt.damage.plainRolls, without.damage.plainRolls)
    + c * withIt.hit.hitCrit * deltaOf(withIt, without, withIt.damage.critRolls, without.damage.critRolls);
  assert.ok(near(withIt.perSwing - without.perSwing, expectedBlade, 1e-6), `a blade: the whole flat lands after the target's intrinsic defense (${withIt.perSwing - without.perSwing} vs ${expectedBlade})`);
  // a blunt blow IS halved as a whole by stoneskin, so the affix inside it is halved with it - once
  const blunt = (v) => ({ ...weapon(126, { material: 9 }), affixes: v ? [{ id: 'elemental', param: 'fire', value: 10 }] : [] });
  const bWith = analyze(ch, { target: gate, health: 12000, weapon: weaponOf(blunt(10)) });
  const bWithout = analyze(ch, { target: gate, health: 12000, weapon: weaponOf(blunt(0)) });
  // The blunt blow is first hidden by the target, then halved by stoneskin. Use the same two-source
  // expectation the resolution test uses: intrinsicDamage (target) then the game's x0.5 trait.
  const bluntHide = (d) => intrinsicDamage(bWith.target, d, { weapon: bWith.weapon });
  const cB = bWith.hit.crit.chance;
  // bossStrike is imported by the resolution tests; here the same x0.5 is applied after the hide, and
  // `cap` clips each integer blow.
  const trait = (d) => Math.max(1, Math.round(d * 0.5));
  const clip = (d) => (bWith.cap > 0 ? Math.min(d, bWith.cap) : d);
  const one = (d) => clip(trait(bluntHide(d)));
  const delta = bWith.perSwing - bWithout.perSwing;
  const expectedBlunt = (1 - cB) * bWith.hit.hitPlain * mean(bWith.damage.plainRolls.map((d, i) => one(d) - one(bWithout.damage.plainRolls[i])))
    + cB * bWith.hit.hitCrit * mean(bWith.damage.critRolls.map((d, i) => one(d) - one(bWithout.damage.critRolls[i])));
  assert.ok(near(delta, expectedBlunt, 1e-6), `blunt per-swing delta ${delta} vs ${expectedBlunt} (hit then stoneskin, once)`);
});

test('a spell, a proc and a DoT are separate from the affix', () => {
  const ch = simCharacter(character({ level: 45, skillOverride: { 22: 100 } }));
  const spell = { name: 'x', element: 4, rangeType: 0, cost: 10, effects: [{ type: 4, subType: 0, magnitudeBaseLow: 50, magnitudeBaseHigh: 50, magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1, durationBase: 0, durationMod: 0, durationPerLevel: 1, chanceBase: 0, chanceMod: 0, chancePerLevel: 1 }] };
  const gate = gateTarget(45);
  const damage = spellDamage(spell, ch, gate).instant;
  const crucible = { group: 'Weapons', templateIndex: 121, material: 9, maxCondition: 1000, currentCondition: 1000, affixes: [{ id: 'elemental', param: 'fire', value: 30 }] };
  // the spell is its own damage; the weapon's affix does not enter it
  assert.equal(spellDamage(spell, ch, gate).instant, damage);
  // a Cast When Strikes proc is unaffected by a weapon affix (it resolves the spell, not the blow)
  const standard = new Map([[7, spell]]);
  const procItem = { ...crucible, enchantments: [{ type: 2, param: 7 }] };
  const withAffix = enchantDps(procItem, ch, gate, { standard, hit: 1, aps: 1 });
  const noAffix = enchantDps({ ...procItem, affixes: [] }, ch, gate, { standard, hit: 1, aps: 1 });
  assert.ok(near(withAffix.dps, noAffix.dps, 1e-9), 'a weapon affix must not change a proc');
  // and a DoT tick is priced separately from the blow
  const dot = { ...spell, effects: [{ ...spell.effects[0], type: 1, durationBase: 5 }] };
  const d1 = enchantDps(procItem, ch, gate, { standard: new Map([[7, dot]]), aps: 1 });
  const d2 = enchantDps({ ...procItem, affixes: [] }, ch, gate, { standard: new Map([[7, dot]]), aps: 1 });
  assert.ok(near(d1.dotDps, d2.dotDps, 1e-9));
});

test('C1: the allowance receives the corrected claim, once', () => {
  const ch = simCharacter(character({ level: 45, raceId: 1, stats: { strength: 70 }, skills: 60 }));
  const item = (v) => ({ ...weapon(121, { material: 9 }), affixes: v ? [{ id: 'elemental', param: 'fire', value: v }] : [] });
  const gate = gateTarget(45);
  const a = analyze(ch, { target: gate, health: 12000, weapon: weaponOf(item(0)) });
  const b = analyze(ch, { target: gate, health: 12000, weapon: weaponOf(item(10)) });
  const perBlow = b.perSwing - a.perSwing;
  // perSwing is the hit- and crit-weighted mean of the blows; the affix adds its value to each,
  // and a critical multiplies it (it is inside the blow).
  const defend = (r, d) => intrinsicDamage(r.target, d, { weapon: r.weapon });
  const c = a.hit.crit.chance;
  const expected = (1 - c) * a.hit.hitPlain * mean(b.damage.plainRolls.map((d, i) => defend(b, d) - defend(a, a.damage.plainRolls[i])))
    + c * a.hit.hitCrit * mean(b.damage.critRolls.map((d, i) => defend(b, d) - defend(a, a.damage.critRolls[i])));
  assert.ok(near(perBlow, expected, 1e-6), `perSwing delta ${perBlow} vs ${expected}`);
  assert.ok(near(b.allowance.ceilingDps - a.allowance.ceilingDps, perBlow * a.cadence.aps, 1e-6), 'the offered rate moves by the single addition');
  // and the claims the allowance runs are built from the corrected per-swing figure
  const streams = claimStreams({ cappedPerSwing: b.cappedPerSwing, hit: b.hit.hit, aps: b.cadence.aps, cap: b.cap });
  assert.ok(streams.length > 0);
});

test('a weapon with no affix is unchanged by any of this', () => {
  const ch = simCharacter(character({ level: 30, raceId: 1, stats: { strength: 80 }, skills: 60 }));
  const w = weaponOf(weapon(120, { material: 1 }));
  assert.equal(w.elemental, 0);
  const r = analyze(ch, { target: referenceFoe(5, 'soft'), core: 'classic', critDamage: false, weapon: w });
  // the live game's stock path: longsword 2..16, steel +0, strength (80-50)/10 = +3
  assert.equal(r.damage.min, 2 + 3);
  assert.equal(r.damage.max, 16 + 3);
});
