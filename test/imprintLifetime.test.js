/*
 * test/imprintLifetime.test.js - Stage 3.5.3e: what-if edits belong to the main-hand item.
 *
 * `analyze(...).with({ imprint })` (and the `imprints` / `loot` / `potentVs` scenario keys) price a change on the MAIN-hand
 * item: `src/model.js:1010-1022`, `:1055`; the off-hand blow carries none of it (`src/blowOutcomes.js:96-99`). An item that
 * carries the same power is read by the same code. Upstream binds a power to the worn item, not to the hand or the player:
 * `wornPowers` reads the equip table on every call (`vendor:systems/loot/lootPowers.js:244-258`), `blowPowers` keeps a weapon's
 * power only for the weapon that struck (`:262-268`), and `lowerCondition` removes a broken item from the table
 * (`vendor:systems/equip.js:570-608`). So a carrier's break takes its edits with it; an off-hand break leaves the main carrier's.
 *
 * These tests run the production `simulateFight` path. Same seeds mean the same sampler draws, not an event-level replay of the
 * game's RNG; no such equivalence is claimed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { upstream, playerEntity, referenceFoe as upstreamFoe } from './harness/upstream.mjs';
import { character, simCharacter, weapon, upstreamWeapon } from './harness/fixtures.mjs';
import { referenceFoe, weaponOf } from '../src/model.js';
import { simulateFight } from '../src/simulateFight.js';
import { powerOf } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';

const DESC = character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const g = (cond, extra = {}) => ({ ...weapon(121, { material: 9 }), maxCondition: 1000, currentCondition: cond, ...extra });
const FOE = (over = {}) => ({ ...referenceFoe(30, 'tough'), ...over });
const FANG = powerOf('tsaesci-fang'); // venom: +8 poison, x2 under half

/** A pair in the production fight: the right hand is `mainExtra`, the left `offExtra`. */
function run({ mainCond = 1000, offCond = 1000, mainExtra = {}, offExtra = {}, scenario = {}, seed = 0, blows = 6, target = FOE() } = {}) {
  const main = g(mainCond, mainExtra);
  const ch = simCharacter(DESC, main);
  ch.offWeapon = { ...g(offCond, offExtra), equipSlot: 21 };
  ch._dual = true;
  return simulateFight(ch, {
    target, health: 1e8, weapon: weaponOf(main), seed, durability: true, trace: true, maxBlows: blows,
    conditionRolls: () => 0.1, dual: true, ...scenario,
  });
}

/** The first `count` seeds whose fight satisfies `make(seed)`; each entry is `{ seed, ...make(seed) }`. */
function seedsWhere(make, count, max = 500) {
  const out = [];
  for (let seed = 0; seed < max && out.length < count; seed += 1) {
    const got = make(seed);
    if (got) out.push({ seed, ...got });
  }
  assert.equal(out.length, count, `${count} qualifying seeds in ${max}`);
  return out;
}

/** Post-break blows equal between two fights, blow for blow. */
const sameAfterBreak = (a, b, from = 1) => {
  for (let i = from; i < Math.min(a.trace.length, b.trace.length); i += 1) {
    assert.equal(a.trace[i].blowDamage, b.trace[i].blowDamage, `blow ${i}: ${a.trace[i].blowDamage} vs ${b.trace[i].blowDamage}`);
  }
};

/** A +8 venom delta on every landed post-break blow, and no delta on a miss. */
function carriedAfterBreak(priced, control, from = 1) {
  let gained = 0;
  for (let i = from; i < Math.min(priced.trace.length, control.trace.length); i += 1) {
    const d = priced.trace[i].blowDamage - control.trace[i].blowDamage;
    assert.ok(d === 0 || d === 8, `blow ${i}: delta ${d} is only a miss (0) or the +8 venom`);
    if (d === 8) gained += 1;
  }
  assert.ok(gained > 0, 'the survivor still carries the edit');
}

test('G4: upstream - an imprint is read from the worn item and leaves with it', async () => {
  const u = await upstream();
  const item = (extra = {}) => ({ ...upstreamWeapon(weapon(121, { material: 9 })), maxCondition: 1000, currentCondition: 1000, ...extra });
  const foe = () => ({ ...upstreamFoe(u, 30, 'tough'), health: 1000, maxHealth: 1000, activeEffects: [], career: {} });
  const ids = (e) => u.lootPowers.wornPowers(e).map((p) => p.id);
  const delta = (e, held) => u.lootPowers.lootBlow(held, 20, e, foe(), { unaware: false, estimate: true }) - 20;
  const rolls = () => 0.05;
  const blow = (e, held) => u.formulas.calculateAttackDamage(e, foe(), { weapon: held, rolls, backstabChance: 0 });
  const table = (e) => u.equip.equipTableOf(e);

  const e = playerEntity({ level: 30 });
  const A = item({ rarity: 'rare', imprint: 'tsaesci-fang' });
  const B = item();
  table(e)[19] = A;
  table(e)[21] = B;
  assert.deepEqual(ids(e), ['tsaesci-fang']);
  assert.equal(delta(e, A), 8, 'the main hand carries the imprint');
  assert.equal(delta(e, B), 0, 'the off hand does not');
  assert.ok(blow(e, A) > blow((() => { const c = playerEntity({ level: 30 }); table(c)[19] = item(); table(c)[21] = B; return c; })(), item()), 'the full blow carries it before the break');

  u.equip.lowerCondition(A, 1e6, e);
  assert.equal(table(e)[19], null);
  assert.deepEqual(ids(e), []);
  assert.equal(delta(e, A), 0, 'the broken weapon carries nothing');

  // the full blow after the break equals a control that never wore the imprinted weapon
  const next = blow(e, B);
  const control = playerEntity({ level: 30 });
  table(control)[21] = item();
  assert.equal(next, blow(control, table(control)[21]));

  // an off-hand break leaves the main carrier's imprint in place
  const e2 = playerEntity({ level: 30 });
  const A2 = item({ rarity: 'rare', imprint: 'tsaesci-fang' });
  const B2 = item();
  table(e2)[19] = A2;
  table(e2)[21] = B2;
  u.equip.lowerCondition(B2, 1e6, e2);
  assert.deepEqual(ids(e2), ['tsaesci-fang']);
  assert.equal(delta(e2, A2), 8);
});

test('G4: a priced imprint rides the breaking blow and dies with the main-hand carrier', () => {
  const cases = seedsWhere((seed) => {
    const priced = run({ mainCond: 1, scenario: { imprints: [FANG] }, seed });
    const equipped = run({ mainCond: 1, mainExtra: { rarity: 'rare', imprint: 'tsaesci-fang' }, seed });
    const control = run({ mainCond: 1, seed });
    if (!priced.trace[0]?.broke || !equipped.trace[0]?.broke || !control.trace[0]?.broke) return null;
    if (!(priced.trace[0].strikesDamage > 0 && control.trace[0].strikesDamage > 0)) return null;
    return { priced, equipped, control };
  }, 3);
  for (const { seed, priced, equipped, control } of cases) {
    assert.equal(priced.trace[0].blowDamage, equipped.trace[0].blowDamage, `seed ${seed}: breaking blow priced == equipped`);
    assert.ok(priced.trace[0].blowDamage > control.trace[0].blowDamage, `seed ${seed}: the breaking blow keeps the imprint`);
    sameAfterBreak(priced, control);
    sameAfterBreak(equipped, control);
  }
});

test('G4: a priced potentVs rides the breaking blow and dies with the main-hand carrier', () => {
  const target = FOE({ mobileType: 25 }); // daedra, param 1
  const cases = seedsWhere((seed) => {
    const priced = run({ mainCond: 1, scenario: { potentVs: 5 }, seed, target });
    const equipped = run({ mainCond: 1, mainExtra: { enchantments: [{ type: 4, param: 1 }] }, seed, target });
    const control = run({ mainCond: 1, seed, target });
    if (!priced.trace[0]?.broke || !equipped.trace[0]?.broke || !control.trace[0]?.broke) return null;
    if (!(priced.trace[0].strikesDamage > 0 && control.trace[0].strikesDamage > 0)) return null;
    return { priced, equipped, control };
  }, 3);
  for (const { seed, priced, equipped, control } of cases) {
    assert.equal(priced.trace[0].blowDamage, equipped.trace[0].blowDamage, `seed ${seed}: breaking blow priced == equipped`);
    assert.ok(priced.trace[0].blowDamage > control.trace[0].blowDamage, `seed ${seed}: the breaking blow keeps Potent Vs`);
    sameAfterBreak(priced, control);
    sameAfterBreak(equipped, control);
  }
});

test('G4: a priced loot flat rides the breaking blow and dies with the main-hand carrier', () => {
  const cases = seedsWhere((seed) => {
    const priced = run({ mainCond: 1, scenario: { loot: { pct: 0, flat: 6 } }, seed });
    const equipped = run({ mainCond: 1, mainExtra: { affixes: [{ id: 'elemental', param: 'fire', value: 6 }] }, seed });
    const control = run({ mainCond: 1, seed });
    if (!priced.trace[0]?.broke || !equipped.trace[0]?.broke || !control.trace[0]?.broke) return null;
    if (!(priced.trace[0].strikesDamage > 0 && control.trace[0].strikesDamage > 0)) return null;
    return { priced, equipped, control };
  }, 3);
  for (const { seed, priced, equipped, control } of cases) {
    assert.equal(priced.trace[0].blowDamage, equipped.trace[0].blowDamage, `seed ${seed}: breaking blow priced == equipped`);
    assert.ok(priced.trace[0].blowDamage > control.trace[0].blowDamage, `seed ${seed}: the breaking blow keeps the loot flat`);
    sameAfterBreak(priced, control);
    sameAfterBreak(equipped, control);
  }
});

test('G4: an off-hand break leaves the priced edits on the surviving main hand', () => {
  const cases = seedsWhere((seed) => {
    const priced = run({ offCond: 1, scenario: { imprints: [FANG] }, seed });
    const equipped = run({ offCond: 1, mainExtra: { rarity: 'rare', imprint: 'tsaesci-fang' }, seed });
    const control = run({ offCond: 1, seed });
    if (!priced.trace[1]?.broke || !control.trace[1]?.broke) return null;
    if (!(priced.trace[0].strikesDamage > 0 && control.trace[0].strikesDamage > 0)) return null;
    return { priced, equipped, control };
  }, 3);
  for (const { seed, priced, equipped, control } of cases) {
    // pre-break: the main carries the edit, the off hand never did
    assert.equal(priced.trace[0].blowDamage - control.trace[0].blowDamage, 8, `seed ${seed}: the main blow carries the edit`);
    assert.equal(priced.trace[1].blowDamage, control.trace[1].blowDamage, `seed ${seed}: the off blow never carried it`);
    // post-break: the main is the survivor and keeps the edit
    carriedAfterBreak(priced, control, 2);
    carriedAfterBreak(equipped, control, 2);
  }
});

test('G4: a priced execute imprint is in the thresholds before the carrier breaks and gone after', () => {
  const EX = powerOf('night-mothers-embrace');
  const active = run({ scenario: { imprints: [EX] }, seed: 0, blows: 2 });
  assert.ok(active.bounds.includes(0.25), 'the what-if threshold is live while the main hand is worn');
  const equippedActive = run({ mainExtra: { rarity: 'rare', imprint: 'night-mothers-embrace' }, seed: 0, blows: 2 });
  assert.ok(equippedActive.bounds.includes(0.25), 'and an equipped Rare imprint is the same');
  const [{ seed, priced, equipped }] = seedsWhere((s) => {
    const pr = run({ mainCond: 1, scenario: { imprints: [EX] }, seed: s });
    const eq = run({ mainCond: 1, mainExtra: { rarity: 'rare', imprint: 'night-mothers-embrace' }, seed: s });
    if (!pr.trace[0]?.broke || !eq.trace[0]?.broke || !(pr.trace[0].strikesDamage > 0)) return null;
    return { priced: pr, equipped: eq };
  }, 1);
  assert.equal(priced.bounds.includes(0.25), false, `seed ${seed}: the carrier's threshold is gone after the break`);
  assert.equal(equipped.bounds.includes(0.25), false, `seed ${seed}: and the equipped carrier's too`);
});

test('G4: an equipped imprint on the surviving hand is its own item and stays', () => {
  const cases = seedsWhere((seed) => {
    const equipped = run({ mainCond: 1, offExtra: { rarity: 'rare', imprint: 'tsaesci-fang' }, seed });
    const control = run({ mainCond: 1, seed });
    if (!equipped.trace[0]?.broke || !control.trace[0]?.broke) return null;
    if (!(equipped.trace[0].strikesDamage > 0 && control.trace[0].strikesDamage > 0)) return null;
    return { equipped, control };
  }, 3);
  for (const { equipped, control } of cases) {
    // the main was plain: the breaking blow is the control's
    assert.equal(equipped.trace[0].blowDamage, control.trace[0].blowDamage);
    // the off hand's own imprint survives on the promoted survivor (the item instance, not a scenario edit)
    carriedAfterBreak(equipped, control, 1);
  }
});

test('G4: character-level scenario inputs survive the carrier break (potency/pierce are not carrier-bound)', () => {
  const standard = new Map([[1, {
    name: 'S1', index: 1, element: 4, rangeType: 1,
    effects: [{ type: 4, subType: 0, magnitudeBaseLow: 10, magnitudeBaseHigh: 10, magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1, durationBase: 0, durationMod: 0, durationPerLevel: 1, chanceBase: 0, chanceMod: 0, chancePerLevel: 1 }],
  }]]);
  const [{ seed, priced }] = seedsWhere((s) => {
    const r = run({ mainCond: 1, offExtra: { enchantments: [{ type: 2, param: 1 }] }, scenario: { potencyPct: 30, pierce: 7, standard }, seed: s, blows: 6 });
    return r.trace[0]?.broke && r.cwsTrace.some((c) => c.swing >= 2) ? { priced: r } : null;
  }, 1);
  const post = priced.cwsTrace.filter((c) => c.swing >= 2);
  assert.ok(post.length > 0, `seed ${seed}: the survivor cast`);
  for (const row of post) {
    assert.equal(row.potencyPct, 30, 'the scenario potency is character-level and survives');
    assert.equal(row.pierce, 7, 'the scenario pierce is character-level and survives');
  }
});

test('G4: character-level flowStacks survives the carrier break (guards against stripping adjacent fields)', () => {
  // The survivor is a Flow weapon; the stack count is the character's, not the broken carrier's.
  const [{ seed, one, four }] = seedsWhere((s) => {
    const oneRun = run({ mainCond: 1, offExtra: { rarity: 'legendary', legendary: 'anseis-edge' }, scenario: { flowStacks: 1 }, seed: s });
    const fourRun = run({ mainCond: 1, offExtra: { rarity: 'legendary', legendary: 'anseis-edge' }, scenario: { flowStacks: 4 }, seed: s });
    if (!oneRun.trace[0]?.broke || !fourRun.trace[0]?.broke) return null;
    const sum = (r) => r.trace.slice(1).reduce((a, e) => a + e.blowDamage, 0);
    return sum(fourRun) > sum(oneRun) ? { one: oneRun, four: fourRun } : null;
  }, 1);
  assert.ok(one && four, `seed ${seed}: four stacks out-damage one after the break`);
});

test('G4 limitation: priced CWS spell-power edits remain unsupported (separate from the carrier fix)', () => {
  const standard = new Map([[1, {
    name: 'S1', index: 1, element: 4, rangeType: 1,
    effects: [{ type: 4, subType: 0, magnitudeBaseLow: 10, magnitudeBaseHigh: 10, magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1, durationBase: 0, durationMod: 0, durationPerLevel: 1, chanceBase: 0, chanceMod: 0, chancePerLevel: 1 }],
  }]]);
  const cws = { enchantments: [{ type: 2, param: 1 }] };
  const equipped = run({ mainExtra: { ...cws, rarity: 'rare', imprint: 'eye-of-magnus' }, scenario: { standard }, seed: 0, blows: 2 });
  const priced = run({ mainExtra: cws, scenario: { imprints: [powerOf('eye-of-magnus')], standard }, seed: 0, blows: 2 });
  // the priced spell-power channel reads worn items, not what-if imprints: this gap predates G4 and is not widened by the fix
  assert.equal(equipped.cwsTrace[0].pierce, 15, 'an equipped Rare imprint reaches the cast');
  assert.equal(priced.cwsTrace[0].pierce, 0, 'a priced imprint still does not (the known limitation)');
  // with the carrier broken on the blow, the equipped imprint is gone before the payload and the priced one was never there
  const eqBreak = run({ mainCond: 1, mainExtra: { ...cws, rarity: 'rare', imprint: 'eye-of-magnus' }, scenario: { standard }, seed: 0, blows: 4 });
  const prBreak = run({ mainCond: 1, mainExtra: cws, scenario: { imprints: [powerOf('eye-of-magnus')], standard }, seed: 0, blows: 4 });
  assert.ok(eqBreak.trace[0].broke && prBreak.trace[0].broke);
  assert.ok(eqBreak.cwsTrace.every((c) => c.pierce === 0));
  assert.ok(prBreak.cwsTrace.every((c) => c.pierce === 0));
});
