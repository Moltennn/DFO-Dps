/*
 * test/equippedBuild.test.js - Stage 2.11a: an equipped modifier and the same change priced are one calculation.
 *
 * A build that CARRIES a Legendary power, a Rare's imprint, or a Potent Vs / Low Damage Vs enchantment must evaluate
 * exactly as the build without it evaluated through `with(edit)`. Before this stage the carried power never reached
 * the hit path (src/model.js read slayer/elemental lines only) and a carried Potent Vs went through the enchant
 * layer (`hit x 5` added outside the blow), so equipping and pricing disagreed (audit G3, G5).
 *
 * Upstream application points (full citations in docs/SOURCES.md):
 *   a power   systems/loot/lootPowers.js:286-347 lootBlow - the conditions read from the foe and the scenario, the
 *             percentage joined with the slayer lines in ONE shareOf of the blow, the flat added after;
 *   a row     systems/enchantments.js:622-631 / :886-892 (+5 / -5 on a foe of the matching AFFINITY),
 *             :1031-1075 doItemEnchantmentPayloads (damageOut accumulates, the sum clamps at 0) inside
 *             combat/formulas.js:826-840 (a player's payloads run whatever the blow did: a miss returns the five).
 *
 * Sections 1-2 are local invariants (one path). Sections 3-5 are DIFFERENTIAL: upstream's own calculateAttackDamage
 * with the item worn in the oracle's equip table, on a body upstream built. Section 6 shows the old behaviour fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { analyze, weaponOf, lootPowerTerms } from '../src/model.js';
import { enemyTarget, standInTarget } from '../src/target.js';
import { maxCharacter, maxRun } from '../src/maxprofile.js';
import { gateTarget } from '../src/model.js';
import { enchantDps } from '../src/enchants.js';
import { powerDps, WEAPON_IMPRINTS } from '../src/imprints.js';
import { simulatePurse } from '../src/purse.js';
import { upstream } from './harness/upstream.mjs';
import { oracleEntity, upstreamBody } from './harness/upstreamBodies.mjs';
import { character, simCharacter, upstreamEntity, weapon, upstreamWeapon } from './harness/fixtures.mjs';
import { sampleWorn } from './harness/outcomes.mjs';
import { powerOf } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { _resetLootPowersForTests, _setLootPowersClockForTests } from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';

const PV = (param) => ({ type: 4, param }); // PotentVs (ENCHANTMENT_TYPES, formats/magicDef.js)
const LV = (param) => ({ type: 20, param }); // LowDamageVs
const DAEDRA = 1; // AFFINITY_PARAM.Daedra (enchantments.js:414)
// The vendored cut's own figures throughout this file, so the scenario names it.
const OPTS = { core: 'overhaul', rri: true, healthShare: 1, passiveOn: true, stacks: 5, gameBuild: '14512' };
const KEYS = ['perSwing', 'cappedPerSwing', 'dps', 'cappedDps', 'cappedDpsMin', 'cappedDpsMax', 'perSwingMin', 'perSwingMax'];
const same = (a, b, label) => { for (const k of KEYS) assert.equal(a[k], b[k], `${label}: ${k}`); };
const carry = (item, fields) => ({ ...item, ...fields });
const imprinted = (id, rarity = 'rare') => (rarity === 'rare' ? { rarity: 'rare', imprint: id } : { rarity, legendary: id });

test('1. the local power table is the game\'s: every imprint record agrees with powerOf(id) on the fields it states', () => {
  for (const rec of WEAPON_IMPRINTS) {
    const up = powerOf(rec.id);
    assert.ok(up, `${rec.id}: upstream has a record`);
    assert.equal(up.kind, rec.power.kind, `${rec.id}: kind`);
    for (const k of ['pct', 'flat', 'beast', 'max', 'seconds', 'chance', 'below', 'share', 'metres', 'mana', 'less', 'above']) {
      if (rec.power[k] !== undefined) assert.equal(rec.power[k], up[k], `${rec.id}: ${k}`);
    }
  }
});

test('2. equipped == with(edit): every power kind, every configuration, exactly', () => {
  const gate = gateTarget(45);
  const desc = character({ level: 30, raceId: 1, stats: { strength: 70, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 120, 32: 120, 33: 120, 34: 30, 19: 50 } });
  const run = (item, extra = {}, target = gate) => analyze(simCharacter(desc, item), { target, core: 'overhaul', weapon: weaponOf(item), ...extra });
  const katana = weapon(121, { material: 9 });
  // [power id, scenario that makes its condition TRUE as the game reads it, the foe]
  const cases = [
    ['anseis-edge', {}, gate], // flow: steady five stacks
    ['tsaesci-fang', {}, gate], // venom, foe whole
    ['tsaesci-fang', { healthShare: 0.4 }, gate], // venom doubled under half the foe's health
    ['nightwhisper', { unaware: true }, gate],
    ['gortwogs-cleaver', { attackerHealthShare: 0.2 }, gate], // rage: the WIELDER's health
    ['graveward', {}, enemyTarget(18)], // sanctified: an undead foe
    ['wyrmbane', {}, enemyTarget(34)], // bane: a dragonling's career is in the record's list
    ['glenmoril-bow', { night: true }, enemyTarget(0)], // moon at night on an animal
    ['warp-edge', {}, gate], // Many Endings: the echo rides the claim (Stage 2.11b)
  ];
  for (const [id, scenario, target] of cases) {
    const power = powerOf(id);
    assert.ok(power, id);
    for (const rarity of ['rare', 'legendary']) {
      const equipped = run(carry(katana, imprinted(id, rarity)), scenario, target);
      const plain = run(katana, scenario, target);
      const priced = plain.with({ imprint: power });
      same(equipped, priced, `${id} as a ${rarity}`);
    }
  }
  // a power whose condition is FALSE adds nothing, whichever way it is reached
  for (const [id, target] of [['wyrmbane', gate], ['graveward', gate], ['nightwhisper', gate], ['gortwogs-cleaver', gate], ['glenmoril-bow', gate]]) {
    same(run(carry(katana, imprinted(id)), {}, target), run(katana, {}, target), `${id}: condition false`);
  }
  // the pricing assumption (conditional=true) is the scenario that makes the condition true
  assert.equal(powerDps(powerOf('nightwhisper'), run(katana), true, { capped: true }), run(carry(katana, imprinted('nightwhisper')), { unaware: true }).carriedCappedDps);
  assert.equal(powerDps(powerOf('gortwogs-cleaver'), run(katana), true, { capped: true }), run(carry(katana, imprinted('gortwogs-cleaver')), { attackerHealthShare: 0.1 }).carriedCappedDps);
});

test('2b. equipped == with(edit) across the supported hold configurations', () => {
  const gate = gateTarget(45);
  const power = powerOf('anseis-edge');
  const venom = powerOf('tsaesci-fang');
  const build = (t) => { const ch = maxCharacter(t, { gameBuild: '14512' }); return ch; };
  const withItem = (ch, fields) => ({ ...ch, weapon: { ...ch.weapon, ...fields } });
  const go = (ch, extra = {}) => analyze(ch, { ...OPTS, target: gate, health: gate.maxHealth, pair: !!ch._pair, dual: !!ch._dual, ...extra });
  const configs = [
    ['one-handed', build(121), {}],
    ['two-handed', build(123), {}],
    ['pair (one item, both guns)', build(562), {}],
    ['long bow', build(130), {}],
    ['backstab', build(121), { backstabUptime: 1 }],
    ['backstab 0.5', build(121), { backstabUptime: 0.5 }],
  ];
  for (const [label, ch, extra] of configs) {
    for (const [name, pw, fields] of [['flow', power, imprinted('anseis-edge')], ['venom', venom, imprinted('tsaesci-fang')]]) {
      same(go(withItem(ch, fields), extra), go(ch, extra).with({ imprint: pw }), `${label} / ${name}`);
    }
  }
  // dual: the imprint lives on the MAIN-HAND item; the off-hand item is its own
  const dual = maxCharacter(121, { gameBuild: '14512' });
  dual._dual = true;
  dual.offWeapon = { ...dual.weapon, equipSlot: 21 };
  const main = go({ ...dual, weapon: { ...dual.weapon, ...imprinted('anseis-edge') } });
  same(main, go(dual).with({ imprint: power }), 'dual: main-hand imprint');
  assert.equal(main.offHand.cappedPerSwing, go(dual).offHand.cappedPerSwing, 'the off hand carries nothing');
  const both = go({ ...dual, weapon: { ...dual.weapon, ...imprinted('anseis-edge') }, offWeapon: { ...dual.offWeapon, ...imprinted('tsaesci-fang') } });
  assert.ok(both.offHand.cappedPerSwing > main.offHand.cappedPerSwing, 'an off-hand item carries its own power');
  assert.equal(both.offHand.perSwing, analyze({ ...dual, weapon: { ...dual.offWeapon, ...imprinted('tsaesci-fang') } }, { ...OPTS, target: gate, health: gate.maxHealth, offHand: true, weapon: weaponOf({ ...dual.offWeapon, ...imprinted('tsaesci-fang') }) }).perSwing);
});

test('2c. Potent Vs / Low Damage Vs: equipped rows == with({ potentVs }), matched by the foe\'s AFFINITY', () => {
  const gate = gateTarget(45); // a Daedra Lord (mobile 31)
  const desc = character({ level: 20, raceId: 1, stats: { strength: 70, agility: 55, speed: 70, luck: 50 }, skills: 0, skillOverride: { 29: 60, 32: 60, 34: 30 } });
  for (const tpl of [121, 126]) {
    const item = weapon(tpl, { material: 6 });
    const run = (it, extra = {}) => analyze(simCharacter(desc, it), { target: gate, core: 'overhaul', weapon: weaponOf(it), ...extra });
    const base = run(item);
    same(run(carry(item, { enchantments: [PV(DAEDRA)] })), base.with({ potentVs: 5 }), `${tpl} Potent Vs (Daedra)`);
    same(run(carry(item, { enchantments: [LV(DAEDRA)] })), base.with({ potentVs: -5 }), `${tpl} Low Damage Vs (Daedra)`);
    same(run(carry(item, { enchantments: [PV(DAEDRA), LV(DAEDRA)] })), base, `${tpl} +5 and -5 cancel`);
    same(run(carry(item, { enchantments: [PV(DAEDRA), PV(DAEDRA)] })), base.with({ potentVs: 10 }), `${tpl} two rows add`);
    same(run(carry(item, { enchantments: [PV(2)] })), base, `${tpl} Humanoid row on a Daedra: nothing`);
    // a hit-rate-limited build: the five rides the swing that missed too
    if (tpl === 121) {
      // a blade against the gate's stoneskin/spellproof is untouched by the trait: the five is exactly +5 a swing,
      // the landed share AND the share that missed
      assert.ok(Math.abs(run(carry(item, { enchantments: [PV(DAEDRA)] })).perSwing - base.perSwing - 5) < 1e-9);
    }
  }
  // matched by affinity, not by this project's group: a class foe is Human, a dragonling an Animal
  const item = weapon(121, { material: 6 });
  const human = enemyTarget(128, { level: 20 });
  const ench = carry(item, { enchantments: [PV(2)] });
  const on = analyze(simCharacter(desc, ench), { target: human, core: 'overhaul', weapon: weaponOf(ench) });
  const off = analyze(simCharacter(desc, item), { target: human, core: 'overhaul', weapon: weaponOf(item) });
  assert.ok(on.perSwing > off.perSwing, 'Humanoid row works on a class foe');
  // the enchant layer no longer prices the five a second time
  const e = enchantDps(carry(item, { enchantments: [PV(DAEDRA)] }), simCharacter(desc, item), gate, { hit: 0.9, aps: 1.5 });
  assert.equal(e.perSwing, 0);
  assert.equal(e.dps, 0);
});

test('2d. modifiers compose: an imprint + Potent Vs + a slayer line + a loot what-if on one item equal the chained edits', () => {
  const gate = gateTarget(45);
  const desc = character({ level: 30, raceId: 1, stats: { strength: 70, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 120, 34: 30 } });
  const item = weapon(121, { material: 9 });
  const all = carry(item, { ...imprinted('anseis-edge'), enchantments: [PV(DAEDRA)], affixes: [{ id: 'slayer', param: 'daedra', value: 20 }, { id: 'elemental', param: 'fire', value: 6 }] });
  const run = (it, extra = {}) => analyze(simCharacter(desc, it), { target: gate, core: 'overhaul', weapon: weaponOf(it), ...extra });
  const line = carry(item, { affixes: [{ id: 'slayer', param: 'daedra', value: 20 }, { id: 'elemental', param: 'fire', value: 6 }] });
  const chained = run(line).with({ imprint: powerOf('anseis-edge') }).with({ potentVs: 5 });
  same(run(all), chained, 'imprint + PV + lines');
  // order of the edits does not matter (they enter at their own points)
  same(run(line).with({ potentVs: 5 }).with({ imprint: powerOf('anseis-edge') }), chained, 'edit order');
  // two powers on one blow share ONE pct (shareOf of the sum), not two compounded shares
  const flowPlusRage = run(line, { attackerHealthShare: 0.1 }).with({ imprint: powerOf('anseis-edge') }).with({ imprint: powerOf('gortwogs-cleaver') });
  const terms = lootPowerTerms([powerOf('anseis-edge'), powerOf('gortwogs-cleaver')], gate, { attackerHealthShare: 0.1 });
  assert.equal(terms.pct, 30 + 30);
  assert.ok(flowPlusRage.perSwing > run(line).with({ imprint: powerOf('anseis-edge') }).perSwing);
});

// ── differential ────────────────────────────────────────────────────────────

const DRAWS = 250000;
const Z = 3.5;
const desc = (extra = {}) => character({ level: 30, raceId: 1, stats: { strength: 60, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 150, 32: 150, 33: 150, 34: 30, ...extra } });
const trait = (u, traits, item, kind = 'melee') => (d) => (traits.length ? u.bossTraits.bossStrike({ bossTraits: traits }, d, { kind, weapon: upstreamWeapon(item) }).damage : d);
const clip = (cap) => (d) => (cap > 0 ? Math.min(d, cap) : d);
const check = (id, local, up) => {
  const z = (local - up.mean) / up.se;
  assert.ok(Math.abs(z) < Z, `${id}: local ${local.toFixed(4)} vs upstream ${up.mean.toFixed(4)} +/- ${(1.96 * up.se).toFixed(4)} (z ${z.toFixed(2)})`);
};

test('3. equipped Legendary powers and imprints match upstream\'s worn-item blow', async () => {
  const u = await upstream();
  _resetLootPowersForTests();
  _setLootPowersClockForTests(() => 1000); // Flow's seconds never run out: five stacks after five landed blows
  try {
    const { body: gateBody } = await upstreamBody({ kind: 'standIn', mobile: 31 });
    const { body: undead } = await upstreamBody({ kind: 'mint', mobile: 18 });
    const { body: dragon } = await upstreamBody({ kind: 'mint', mobile: 34 });
    const item = weapon(121, { material: 9 });
    const cases = [
      { id: 'flow (Legendary) at the gate, cap 600', power: 'anseis-edge', rarity: 'legendary', body: gateBody, target: standInTarget(31), cap: 600, warm: 12 },
      { id: 'flow (imprint), binding cap 30, stoneskin gate', power: 'anseis-edge', rarity: 'rare', body: gateBody, target: standInTarget(31), traits: ['stoneskin'], cap: 30, warm: 12 },
      { id: 'venom, foe whole', power: 'tsaesci-fang', rarity: 'rare', body: gateBody, target: standInTarget(31), cap: 0 },
      { id: 'venom doubled, foe at 40%', power: 'tsaesci-fang', rarity: 'rare', body: { ...gateBody, relayShare: () => 0.4 }, target: standInTarget(31), scenario: { healthShare: 0.4 }, cap: 0 },
      { id: 'venom, crit 100 (the flat is inside the blow: the crit multiplies it)', power: 'tsaesci-fang', rarity: 'rare', body: gateBody, target: standInTarget(31), crit: 100, cap: 0 },
      { id: 'Silent Death (unaware foe)', power: 'nightwhisper', rarity: 'rare', body: gateBody, target: standInTarget(31), scenario: { unaware: true }, calc: { unaware: true }, cap: 0 },
      { id: 'Orc Rage, wielder at 20% health', power: 'gortwogs-cleaver', rarity: 'legendary', body: gateBody, target: standInTarget(31), scenario: { attackerHealthShare: 0.2 }, health: 20, cap: 0 },
      { id: 'Orc Rage, wielder whole (nothing)', power: 'gortwogs-cleaver', rarity: 'legendary', body: gateBody, target: standInTarget(31), cap: 0 },
      { id: 'Sanctified vs an undead foe', power: 'graveward', rarity: 'rare', body: undead, target: enemyTarget(18), cap: 0 },
      { id: 'Dragonsbane vs a dragonling', power: 'wyrmbane', rarity: 'rare', body: dragon, target: enemyTarget(34), cap: 0 },
      { id: 'Dragonsbane vs the Daedra Lord (nothing)', power: 'wyrmbane', rarity: 'rare', body: gateBody, target: standInTarget(31), cap: 0 },
    ];
    for (const [i, c] of cases.entries()) {
      const traits = c.traits ?? [];
      const d = desc(c.crit ? { 34: c.crit } : {});
      const attacker = upstreamEntity(d);
      attacker.health = c.health ?? 100;
      attacker.maxHealth = 100;
      const fields = imprinted(c.power, c.rarity);
      const after = (x) => clip(c.cap)(trait(u, traits, item)(x));
      const up = sampleWorn(u, { attacker, body: c.body, item, fields, seed: 0x4100 + i * 61, draws: DRAWS, warm: c.warm ?? 0, calc: c.calc ?? {}, after });
      const target = { ...c.target, bossTraits: traits, hitCap: c.cap };
      const mine = analyze(simCharacter(d, carry(item, fields)), { target, core: 'overhaul', weapon: weaponOf(carry(item, fields)), ...(c.scenario ?? {}), swing: 'StrikeLeft' });
      check(c.id, c.cap > 0 ? mine.cappedPerSwing : mine.perSwing, up);
    }
  } finally {
    _resetLootPowersForTests();
  }
});

test('4. equipped Potent Vs / Low Damage Vs match upstream, a miss included, with trait and cap', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const cases = [
    { id: 'katana, Potent Vs (Daedra)', tpl: 121, rows: [PV(DAEDRA)], traits: [], cap: 0 },
    { id: 'katana, Low Damage Vs (Daedra): never below 0', tpl: 121, rows: [LV(DAEDRA)], traits: [], cap: 0 },
    { id: 'katana, +5 and -5 on one item', tpl: 121, rows: [PV(DAEDRA), LV(DAEDRA)], traits: [], cap: 0 },
    { id: 'katana, two Potent Vs rows', tpl: 121, rows: [PV(DAEDRA), PV(DAEDRA)], traits: [], cap: 0 },
    { id: 'warhammer, Potent Vs vs stoneskin, cap 9', tpl: 126, rows: [PV(DAEDRA)], traits: ['stoneskin'], cap: 9 },
    { id: 'katana, off hand (whole 80%), bladeturning, cap 7', tpl: 121, rows: [PV(DAEDRA)], traits: ['bladeturning'], cap: 7, offHand: true },
    { id: 'katana, a row for another affinity (nothing)', tpl: 121, rows: [PV(2)], traits: [], cap: 0 },
  ];
  for (const [i, c] of cases.entries()) {
    const skill = c.tpl === 126 ? 32 : 29;
    const d = character({ level: 8, raceId: 1, stats: { strength: 60, agility: 60, speed: 70, luck: 40 }, skills: 0, skillOverride: { [skill]: 35, 34: 0 } }); // hit below the ceiling: misses exist
    const item = weapon(c.tpl, { material: 9 });
    const fields = { enchantments: c.rows, isIdentified: true };
    const after = (x) => clip(c.cap)(trait(u, c.traits, item)(x));
    const up = sampleWorn(u, { attacker: upstreamEntity(d), body, item, fields, seed: 0x4200 + i * 83, draws: DRAWS, offHand: !!c.offHand, after });
    const target = { ...standInTarget(31), bossTraits: c.traits, hitCap: c.cap };
    const it = carry(item, fields);
    const mine = analyze(simCharacter(d, it), { target, core: 'overhaul', weapon: weaponOf(it), offHand: !!c.offHand, swing: 'StrikeLeft' });
    assert.ok(mine.hit.hit < 0.95, `${c.id}: below the hit ceiling (${mine.hit.hit.toFixed(3)})`);
    check(c.id, c.cap > 0 ? mine.cappedPerSwing : mine.perSwing, up);
  }
});

test('5. several modifiers on one worn item: flow + Potent Vs + a slayer and an elemental line, with a trait and a cap', async () => {
  const u = await upstream();
  _resetLootPowersForTests();
  _setLootPowersClockForTests(() => 1000);
  try {
    const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
    const item = weapon(126, { material: 9 });
    const fields = { ...imprinted('tsaesci-fang'), enchantments: [PV(DAEDRA)], isIdentified: true, affixes: [{ id: 'slayer', param: 'daedra', value: 20 }, { id: 'elemental', param: 'fire', value: 6 }] };
    for (const [i, cap] of [0, 25].entries()) {
      const traits = ['stoneskin'];
      const d = desc({ 34: 60 });
      const up = sampleWorn(u, { attacker: upstreamEntity(d), body, item, fields, seed: 0x4300 + i * 17, draws: DRAWS, after: (x) => clip(cap)(trait(u, traits, item)(x)) });
      const it = carry(item, fields);
      const mine = analyze(simCharacter(d, it), { target: { ...standInTarget(31), bossTraits: traits, hitCap: cap }, core: 'overhaul', weapon: weaponOf(it), swing: 'StrikeLeft' });
      check(`venom + Potent Vs + slayer 20% + fire 6, stoneskin, cap ${cap}`, cap > 0 ? mine.cappedPerSwing : mine.perSwing, up);
    }
  } finally {
    _resetLootPowersForTests();
  }
});

// ── the old behaviour fails these tests ─────────────────────────────────────

test('6. the pre-2.11a behaviour is rejected: an equipped power was ignored, a Potent Vs was priced outside the blow', async () => {
  const u = await upstream();
  _resetLootPowersForTests();
  _setLootPowersClockForTests(() => 1000);
  try {
    const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
    // (a) the old hit path read no power: an equipped Serpent's Kiss evaluated as the plain item
    const item = weapon(121, { material: 9 });
    const d = desc();
    const fields = imprinted('tsaesci-fang');
    const up = sampleWorn(u, { attacker: upstreamEntity(d), body, item, fields, seed: 0x4400, draws: DRAWS });
    const plain = analyze(simCharacter(d, item), { target: standInTarget(31), core: 'overhaul', weapon: weaponOf(item), swing: 'StrikeLeft' });
    const equipped = analyze(simCharacter(d, carry(item, fields)), { target: standInTarget(31), core: 'overhaul', weapon: weaponOf(carry(item, fields)), swing: 'StrikeLeft' });
    assert.ok(Math.abs(plain.perSwing - up.mean) / up.se > 100, `the old ignore-the-power reading is far outside upstream (${plain.perSwing.toFixed(3)} vs ${up.mean.toFixed(3)})`);
    check('equipped venom', equipped.perSwing, up);

    // (b) the old enchant layer: Potent Vs added as `hit x 5` outside the blow, so a swing that missed got nothing
    const w = character({ level: 8, raceId: 1, stats: { strength: 60, agility: 60, speed: 70, luck: 40 }, skills: 0, skillOverride: { 29: 35, 34: 0 } });
    const pvItem = carry(weapon(121, { material: 9 }), { enchantments: [PV(DAEDRA)], isIdentified: true });
    const upPv = sampleWorn(u, { attacker: upstreamEntity(w), body, item: weapon(121, { material: 9 }), fields: { enchantments: [PV(DAEDRA)], isIdentified: true }, seed: 0x4401, draws: DRAWS });
    const base = analyze(simCharacter(w, weapon(121, { material: 9 })), { target: standInTarget(31), core: 'overhaul', swing: 'StrikeLeft' });
    const old = base.perSwing + base.hit.hit * 5; // what the enchant layer added
    const now = analyze(simCharacter(w, pvItem), { target: standInTarget(31), core: 'overhaul', weapon: weaponOf(pvItem), swing: 'StrikeLeft' });
    assert.ok(Math.abs(old - upPv.mean) / upPv.se > 5, `hit x 5 is outside upstream (${old.toFixed(3)} vs ${upPv.mean.toFixed(3)} +/- ${(1.96 * upPv.se).toFixed(3)})`);
    check('equipped Potent Vs', now.perSwing, upPv);
    assert.ok(now.perSwing - base.perSwing > 5 * (1 - base.hit.hit) * 0.99, 'the five is on every swing');
  } finally {
    _resetLootPowersForTests();
  }
});

// ── one path: no scaling of a capped mean, no second formula ────────────────

test('7. there is no second damage formula for an imprint: the allowance reads the imprinted card', () => {
  for (const f of ['src/allowance.js', 'src/purse.js', 'src/realBuild.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/imprintEffect|\bmult\s*[:=,]|\bmult\b.*\bflat\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), `${f} carries no mult/flat scaling`);
  }
  assert.ok(!fs.readFileSync(new URL('../src/maxprofile.js', import.meta.url), 'utf8').includes('cappedDpsWith'));
  // a purse is run on whatever card it is handed; extra scaling options are not read
  const gate = gateTarget(45);
  const base = maxRun(maxCharacter(121, { gameBuild: '14512' }), { target: gate, gameBuild: '14512' });
  const a = simulatePurse(base, 'breach', { level: 45 });
  const b = simulatePurse(base, 'breach', { level: 45, mult: 3, flat: 500 });
  assert.deepEqual(b, a);
  // and the imprinted card's purse differs from the plain card's by the imprint, through the blow
  const flow = base.with({ imprint: powerOf('anseis-edge') });
  assert.ok(flow.cappedPerSwing > base.cappedPerSwing);
  const c = simulatePurse(flow, 'breach', { level: 45 });
  assert.ok(c.ceilingDps > a.ceilingDps);
});
