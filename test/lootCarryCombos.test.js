/*
 * test/lootCarryCombos.test.js - W-LOOT-CARRY, the four combinations of the opt-in `carry: true` fight stream that
 * test/lootCarry.test.js does not cover: dual wield, a x3 backstab, a weapon that breaks mid-fight, and a Cast When
 * Strikes row beside the carried percentage lines.
 *
 * The carry state is `channel -> (held item -> remainder)` (src/model.js createCarryState, carriedAmount), created once
 * per fight (src/simulateFight.js carryState). Its order is upstream's: mastery, loot (slayer, then the flat), martial,
 * theory roll, Firmament (src/model.js weaponBlow); then in damageModel and carryResolve the backstab x3, then the
 * critical, material and condition stages (src/model.js damageModel `backstabPlain = values.map(finish(d * 3))`,
 * src/blowOutcomes.js carryResolve). The percentage channels come BEFORE the x3 in both paths.
 *
 * Labels. Each case says whether a check is ORACLE (the vendored game, `vendor/upstream/a3eb1605`, run through
 * `test/harness/*`) or LOCAL (a relation between two of our own paths, or an invariant of our own state). A LOCAL check
 * is never presented as an oracle check. Items the fight output cannot observe are TODO comments, not assertions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCarryState, referenceFoe, weaponBlow, weaponOf } from '../src/model.js';
import { simulateFight } from '../src/simulateFight.js';
import { blowFightTier } from '../src/blowOutcomes.js';
import { character, simCharacter, upstreamEntity, weapon } from './harness/fixtures.mjs';
import { upstream } from './harness/upstream.mjs';
import { oracleItem } from './harness/fightOracle.mjs';
import { upstreamBody } from './harness/upstreamBodies.mjs';
import { generator } from './harness/prng.mjs';

const PLAIN = () => character({ level: 30, raceId: 1, skills: 40 });
const upItem = (item) => oracleItem(item);

/** A seeded stream of pre-percentage blows, with misses (0) interleaved: a miss never reaches shareOf. */
const blowStream = (seed, n) => {
  const g = generator(seed);
  return Array.from({ length: n }, (_, i) => (i % 37 === 0 ? 0 : 60 + Math.floor(g() * 61)));
};

// Durability/CWS fixtures, copied from test/durability.test.js (same shapes, same spell record).
const item = (cond = 1000, extra = {}) => ({ ...weapon(121, { material: 9 }), maxCondition: 1000, currentCondition: cond, ...extra });
const cws = (cond, params, extra = {}) => item(cond, { enchantments: params.map((param) => ({ type: 2, param })), ...extra });
const eff = (type, subType, magnitude = 10, durationBase = 0) => ({
  type, subType,
  magnitudeBaseLow: magnitude, magnitudeBaseHigh: magnitude,
  magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
  durationBase, durationMod: 0, durationPerLevel: 1,
  chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
});
const spellOf = (index = 1, effect = eff(4, 0, 10)) => ({ name: `Spell ${index}`, index, element: 4, rangeType: 1, effects: [effect] });
const DESC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
/** A dual build: the main item plus an off-hand item in slot 21 (durability.test.js `dual`). */
const dualOf = (main, off) => {
  const ch = simCharacter(DESC(), main);
  ch.offWeapon = { ...off, equipSlot: 21 };
  ch._dual = true;
  return ch;
};

// The fight-level target: a referenceFoe whose group the local slayer lines name ('humanoid').
const FIGHT_TGT = () => ({ ...referenceFoe(30, 'tough'), group: 'humanoid' });

// ---------------------------------------------------------------------------------------------------------------------
// 1. DUAL WIELD
// ---------------------------------------------------------------------------------------------------------------------

test('1. dual wield: each hand keeps its OWN remainder (per item), checked blow for blow against the vendored lootBlow', async () => {
  // ORACLE: the per-hand streams. `lootBlow` (systems/loot/lootPowers.js:286-347) keeps its remainder in a WeakMap keyed
  // by the held item (lootPowers.js:171), so the vendored game gives each reused held item its own stream. Both hands are
  // interleaved blow for blow on one local state and on the two reused held items.
  // LOCAL: the carry identity (sum of floors vs the exact share, with the remainder read from our own state), the
  // independence control (a shared key is a different stream), and the fight-level dual run.
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const group = u.lootPowers.foeGroup(body);
  const tgt = { ...body, group };
  const mainItem = { ...weapon(121, { material: 9 }), affixes: [{ id: 'slayer', param: group, value: 25 }] };
  const offItem = { ...weapon(121, { material: 9 }), affixes: [{ id: 'slayer', param: group, value: 10 }] };
  const ch = simCharacter(PLAIN(), mainItem);
  const wMain = weaponOf(mainItem);
  const wOff = weaponOf(offItem);
  const heldMain = upItem(mainItem);
  const heldOff = upItem(offItem);
  const attacker = { ...upstreamEntity(PLAIN()), isPlayer: true };
  const gMain = blowStream(0x9101, 300);
  const gOff = blowStream(0x9102, 300);

  const state = createCarryState();
  const mine = { main: [], off: [] };
  const theirs = { main: [], off: [] };
  for (let i = 0; i < gMain.length; i += 1) {
    mine.main.push(weaponBlow(ch, wMain, gMain[i], tgt, { carryState: state }));
    mine.off.push(weaponBlow(ch, wOff, gOff[i], tgt, { carryState: state }));
    theirs.main.push(u.lootPowers.lootBlow(heldMain, gMain[i], attacker, body, {}));
    theirs.off.push(u.lootPowers.lootBlow(heldOff, gOff[i], attacker, body, {}));
  }
  // ORACLE: each hand, blow for blow.
  assert.deepEqual(mine.main, theirs.main, 'main hand: the local carried stream is the vendored held-item stream');
  assert.deepEqual(mine.off, theirs.off, 'off hand: the local carried stream is the vendored held-item stream');

  // LOCAL carry identity per hand: sum(floor) = sum(exact share) + c0 - cN with c0 = 0, so |sum - exact| = cN < 1.
  const identity = (vals, base, pct, key) => {
    const got = vals.reduce((s, v, i) => s + (v - base[i]), 0);
    const exact = base.reduce((s, b) => s + (b * pct) / 100, 0);
    const cN = state.get('loot').get(key);
    assert.ok(cN >= 0 && cN < 1, `the remainder kept on the item is in [0, 1) (${cN})`);
    assert.ok(Math.abs(got - exact) < 1, `sum of floors ${got} vs exact share ${exact.toFixed(4)}`);
    assert.ok(Math.abs(got - exact + cN) < 1e-6, `identity: sum floors - exact = -cN (${got - exact} vs ${-cN})`);
    return { got, exact, cN };
  };
  const mainNum = identity(mine.main, gMain, 25, mainItem);
  const offNum = identity(mine.off, gOff, 10, offItem);
  assert.ok(mainNum.cN !== offNum.cN || mainNum.got !== offNum.got, 'the two hands have their own remainders, not one shared one');

  // LOCAL negative control: both hands keyed on the MAIN item (one remainder for the pair) is a different off-hand stream.
  const shared = createCarryState();
  const sharedOff = [];
  for (let i = 0; i < gMain.length; i += 1) {
    weaponBlow(ch, wMain, gMain[i], tgt, { carryState: shared });
    sharedOff.push(weaponBlow(ch, { ...wOff, item: mainItem }, gOff[i], tgt, { carryState: shared }));
  }
  assert.notDeepEqual(sharedOff, mine.off, 'a shared remainder between the hands is a different off-hand stream');

  // LOCAL fight-level dual run: the same seed, carry on twice (deterministic) and off (the stream does change).
  const fightMain = { ...weapon(121, { material: 9 }), affixes: [{ id: 'slayer', param: 'humanoid', value: 25 }] };
  const fightOff = { ...weapon(121, { material: 9 }), affixes: [{ id: 'slayer', param: 'humanoid', value: 10 }] };
  const dualCh = dualOf(fightMain, fightOff);
  const args = { target: FIGHT_TGT(), health: 1e7, weapon: weaponOf(fightMain), dual: true, seed: 0x7001, trace: true, maxBlows: 60 };
  const on = simulateFight(dualCh, { ...args, carry: true });
  const again = simulateFight(dualCh, { ...args, carry: true });
  const off = simulateFight(dualCh, args);
  assert.ok(on.trace.some((r) => r.hand === 'off') && on.trace.some((r) => r.hand === 'main'), 'the fight swings both hands');
  assert.deepEqual(on.trace.map((r) => r.blowDamage), again.trace.map((r) => r.blowDamage), 'the carried dual fight is deterministic');
  assert.notDeepEqual(on.trace.map((r) => r.blowDamage), off.trace.map((r) => r.blowDamage), 'carry changes the dual fight stream');
  // TODO(fight-level identity): the fight does not expose its carry state, and its trace `blowDamage` mixes defence,
  // payload and cap after the percentage channels. The per-hand identity above is therefore on weaponBlow with the same
  // keying the fight uses (carryState keyed by w.item, src/simulateFight.js:395), not on the fight's own output.
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. BACKSTAB
// ---------------------------------------------------------------------------------------------------------------------

test('2. backstab: the x3 is taken after the percentage channels and advances the remainder once; carry on = carry off with no percentage line', () => {
  // LOCAL. The order is the one src/model.js damageModel (`values` = weaponBlow, then `finish(d * 3)`) and
  // src/blowOutcomes.js carryResolve (weaponBlow, `card *= 3`, finishBlow, resolveOne) both use.
  // LOCAL check A: a backstab draw and a plain draw each advance the loot remainder EXACTLY as weaponBlow on the base
  // alone does. The x3 does not feed the percentage channel. (Compared to our own weaponBlow, not to the game.)
  const item25 = { ...weapon(121, { material: 9 }), affixes: [{ id: 'slayer', param: 'humanoid', value: 25 }] };
  const ch = simCharacter(PLAIN(), item25);
  const w = weaponOf(item25);
  const tgt = FIGHT_TGT();
  const tierBack = blowFightTier(ch, {
    target: tgt, health: 1e7, healthShare: 1, carry: true, swing: 'StrikeLeft', backstabChance: 100, backstabUptime: 1,
  });
  const tierPlain = blowFightTier(ch, {
    target: tgt, health: 1e7, healthShare: 1, carry: true, swing: 'StrikeLeft', backstabUptime: 0,
  });
  const back = tierBack.outcomes.find((o) => o.hit && o.backstab && o.blowBase > 0 && !o.crit);
  const plain = tierPlain.outcomes.find((o) => o.hit && !o.backstab && o.blowBase > 0 && !o.crit);
  assert.ok(back, 'a landed backstab draw exists in the carried backstab tier');
  assert.ok(plain, 'a landed plain draw exists in the carried plain tier');
  assert.equal(back.backstab, true);
  assert.equal(plain.backstab, false);

  for (const [draw, tier, name] of [[back, tierBack, 'backstab'], [plain, tierPlain, 'plain']]) {
    const s1 = createCarryState();
    const out = tier.carryResolve(draw, s1);
    const s2 = createCarryState();
    weaponBlow(ch, w, draw.blowBase, tgt, { carryState: s2 });
    // the loot state is keyed by the held weapon object the call used (`lines?.item ?? w ?? ...`, src/model.js:733): the two
    // calls hold different objects, so compare the one remainder each state holds, not a key
    const left1 = [...s1.get('loot').values()];
    const left2 = [...s2.get('loot').values()];
    assert.equal(left1.length, 1, `${name}: carryResolve advanced exactly one loot remainder`);
    assert.equal(left2.length, 1, `${name}: weaponBlow(base) advanced exactly one loot remainder`);
    assert.ok(left2[0] > 0 && left2[0] < 1, `${name}: the remainder is a real fraction (${left2[0]}), so equality is not vacuous`);
    assert.equal(left1[0], left2[0],
      `${name}: the loot remainder after the draw is the one weaponBlow(base) leaves (the x3 is not inside the channel)`);
    assert.equal(out.hit, true, `${name}: a landed draw stays landed`);
    assert.ok(Number.isFinite(out.blow) && out.blow > 0, `${name}: the carried integer blow is positive (${out.blow})`);
  }
  // TODO(card-level equality): the carried integer for a base should equal damageModel's backstabPlainRolls / plainRolls
  // for that base with the live remainder. `resolveOne` (the defence and payload stage after the card) is not exported,
  // so the pre-defence card cannot be read from carryResolve's output. Not asserted here.

  // LOCAL differential: with NO percentage line the carried stream is the floor stream draw for draw, backstab included.
  // Weapon bare, so weaponBlow is the identity; any reordering of the x3 against crit/material/condition would show here
  // only through rounding, so this checks that the carry path leaves the x3 and finish stages alone.
  const bare = weapon(121, { material: 9 });
  const chBare = simCharacter(PLAIN(), bare);
  const args = {
    target: FIGHT_TGT(), health: 1e7, weapon: weaponOf(bare), seed: 3, trace: true, maxBlows: 60,
    backstabChance: 100, backstabUptime: 1,
  };
  // NOT a draw-for-draw equality: the carried tier is a different cumulative table (atoms keyed by base roll and sorted
  // by it, mergeToCarryTier), so the same seeded draw lands on a different atom. What does hold with no percentage line
  // is the DISTRIBUTION: each carried atom, resolved on a fresh state, gives the floor tier's integer for that base, so
  // the probability-weighted mean and the backstab share of the two tiers are equal.
  const tierArgs = (carry) => ({
    target: FIGHT_TGT(), health: 1e7, healthShare: 1, swing: 'StrikeLeft', backstabChance: 100, backstabUptime: 1,
    ...(carry ? { carry: true } : {}),
  });
  const floorTier = blowFightTier(chBare, tierArgs(false));
  const carryTier = blowFightTier(chBare, tierArgs(true));
  const stats = (tier, resolve) => {
    let mean = 0;
    let back = 0;
    let total = 0;
    for (const o of tier.outcomes) {
      const d = resolve ? resolve(o).damage : o.damage;
      mean += o.p * d;
      total += o.p;
      if (o.backstab) back += o.p;
    }
    return { mean, back, total };
  };
  const f = stats(floorTier, null);
  const c = stats(carryTier, (o) => carryTier.carryResolve(o, createCarryState()));
  assert.ok(f.back > 0 && f.back < f.total, `the backstab draw is live in this tier (share ${f.back}), so the comparison is not vacuous`);
  assert.ok(Math.abs(c.total - f.total) < 1e-9, 'both tiers are whole distributions');
  assert.ok(Math.abs(c.back - f.back) < 1e-9, `the backstab share is the same: ${c.back} vs ${f.back}`);
  assert.ok(Math.abs(c.mean - f.mean) <= 1e-9 * Math.max(1, f.mean),
    `no percentage line: the carried tier's mean damage ${c.mean} equals the floor tier's ${f.mean}`);
  // and the fight still runs with the backstab draw live under carry (the stream itself is not compared)
  const carriedRun = simulateFight(chBare, { ...args, carry: true });
  assert.equal(carriedRun.trace.length, 60);
  assert.ok(carriedRun.trace.some((r) => r.blowDamage > 0));
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. DURABILITY BREAK
// ---------------------------------------------------------------------------------------------------------------------

test('3. durability break: the broken hand is unequipped, the survivor leads with its own remainder, no throw (LOCAL only)', () => {
  // LOCAL. The break is found on the trace (`broke`, `equippedAfter`, the survivor's rows), as durability.test.js does.
  // The per-item identity cannot be read from the output: the carry state is internal to the fight, and the trace's
  // `blowDamage` mixes defence, payload and cap after the percentage channels. TODO below.
  const standard = new Map([[1, spellOf(1, eff(4, 0, 10))]]);
  const main = cws(10, [1]); // breaks on its first CWS bill (durability.test.js:258-260)
  const off = { ...item(1000), affixes: [{ id: 'slayer', param: 'humanoid', value: 25 }] };
  const ch = dualOf(main, off);
  const tgt = FIGHT_TGT();
  const run = (seed, carry) => simulateFight(ch, {
    target: tgt, health: 1e7, weapon: weaponOf(main), dual: true, durability: true, trace: true,
    maxBlows: 40, seed, standard, cwsRolls: () => 0.5, ...(carry ? { carry: true } : {}),
  });
  let found = null;
  for (let s = 0; s < 40 && !found; s += 1) {
    const r = run(s, true);
    if (r.breaks.some((b) => b.hand === 'main') && r.trace.filter((e) => e.broke).length > 0) found = { r, seed: s };
  }
  assert.ok(found, 'a seed in 0..39 breaks the main hand and keeps the fight going');
  const { r, seed } = found;
  const idx = r.trace.findIndex((e) => e.broke);
  assert.ok(idx >= 0, 'the trace records the break');
  assert.equal(r.trace[idx].hand, 'main', 'the broken hand is the main hand');
  const after = r.trace.slice(idx + 1);
  assert.ok(after.length >= 3, `the fight continues after the break (${after.length} blows)`);
  assert.ok(after.every((e) => e.hand === 'main'), 'the survivor is the lead hand after the break');
  assert.deepEqual(r.trace[idx].equippedAfter, { main: false, off: true }, 'the broken main is unequipped, the off kept');
  assert.equal(r.endedByBreak, false, 'no throw and no early stop: the survivor fought on');

  // LOCAL non-vacuity: the carry changes the survivor's stream after the break (the same seed, carry off).
  const floor = run(seed, false);
  const floorAfter = floor.trace.slice(floor.trace.findIndex((e) => e.broke) + 1);
  assert.notDeepEqual(after.map((e) => e.blowDamage), floorAfter.map((e) => e.blowDamage),
    'carry changes the survivor stream after the break');
  // TODO(per-item identity after a break): the survivor's remainder is either fresh or the one it kept while it was the
  // off hand (keyed by its own item, src/simulateFight.js:395, weaponBlow w.item). The broken item is never read again
  // because it is unequipped and its tier is rebuilt for the survivor (src/simulateFight.js:717-728). Neither is visible
  // from the fight output, so neither is asserted here.
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. CWS + PERCENTAGE LINES
// ---------------------------------------------------------------------------------------------------------------------

test('4. CWS beside carried percentage lines: casts do not touch the carry; the melee stream is the same with and without the row (LOCAL)', () => {
  // LOCAL differential. Casts resolve through `resolveCwsCast` and draw on `cwsRolls`, not on the blow stream, and they
  // never reach `carryResolve` (src/simulateFight.js:498 is the only call site; the CWS block is after it). So the melee
  // `blowDamage` sequence of a fight with a CWS row must equal that of the same seed without one, if the cast neither
  // reads nor advances the carry. Both fights have the percentage line; the 1e7 pool keeps the health segment fixed, so
  // no tier differs. NOT an oracle check: the vendored row walk (doItemEnchantmentPayloads) is not compared here.
  const standard = new Map([[1, spellOf(1, eff(4, 0, 10))]]);
  const base = { ...item(1000), affixes: [{ id: 'slayer', param: 'humanoid', value: 25 }] };
  const withRow = { ...base, enchantments: [{ type: 2, param: 1 }] };
  const common = {
    target: FIGHT_TGT(), health: 1e7, seed: 5, trace: true, maxBlows: 60, standard, cwsRolls: () => 0.5, carry: true,
  };
  const chRow = simCharacter(PLAIN(), withRow);
  const chNone = simCharacter(PLAIN(), base);
  const rowRun = simulateFight(chRow, { ...common, weapon: weaponOf(withRow) });
  const noRow = simulateFight(chNone, { ...common, weapon: weaponOf(base) });
  const noRowFloor = simulateFight(chNone, { ...common, weapon: weaponOf(base), carry: false });

  const casts = rowRun.trace.reduce((s, r) => s + (r.cwsCasts ?? 0), 0);
  assert.ok(casts > 0, `the CWS row casts in this fight (non-vacuous): ${casts} casts`);
  assert.equal(noRow.trace.reduce((s, r) => s + (r.cwsCasts ?? 0), 0), 0, 'the control fight has no CWS cast');
  assert.equal(rowRun.blows, noRow.blows, 'both fights make the same number of blows');
  assert.deepEqual(rowRun.trace.map((r) => r.blowDamage), noRow.trace.map((r) => r.blowDamage),
    'the melee blows are the same with and without a CWS row: a cast neither reads nor advances the carry');
  assert.deepEqual(rowRun.trace.map((r) => r.hit), noRow.trace.map((r) => r.hit), 'and they land the same');
  assert.notDeepEqual(noRow.trace.map((r) => r.blowDamage), noRowFloor.trace.map((r) => r.blowDamage),
    'the carried stream differs from the floor stream here (non-vacuous: the carry is live in this fight)');
  // TODO(the remainder after N blows, read directly): the fight does not expose its carry state, so "unchanged remainder"
  // is shown through the melee stream it drives, not by reading the number.
});
