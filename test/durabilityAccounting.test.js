/*
 * test/durabilityAccounting.test.js - Stage 3.5.3b: CWS bills after a killing cast (G3), the aggregate durability
 * statistics of `simulateFights` (G2) and what `procsBeforeBreak` means (G6).
 *
 * G3's oracle is the vendored row walk itself (`doItemEnchantmentPayloads`, systems/enchantments.js:1040-1085) with a
 * host-shaped `applySpellToTarget` (scenes/hostEnchant.js:198-209: a dead foe is not found, so no cast) and the vendored
 * `lowerCondition` leaf. G2's aggregates are checked arithmetically on hand-built rows (denominators and censoring are
 * stated, not read back from the implementation) and then through the production `simulateFights` path. G6's claims are
 * checked against the vendored row walk (no wear) and against whole production fights (wear and bills).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { analyze, referenceFoe, weaponOf } from '../src/model.js';
import {
  durabilityStats, simulateFight, simulateFights, simulatePairedFights, wilsonInterval,
} from '../src/simulateFight.js';
import { cwsBill } from '../src/durability.js';
import {
  billCapacityNote, cwsBillCapacity, procsBeforeBreak, PROCS_BEFORE_BREAK_BASIS,
} from '../src/enchants.js';
import { doItemEnchantmentPayloads, PAYLOAD } from '../vendor/upstream/a3eb1605/src/systems/enchantments.js';
import { lowerCondition } from '../vendor/upstream/a3eb1605/src/systems/equip.js';

const DESC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const item = (cond = 1000, extra = {}) => ({
  ...weapon(121, { material: 9 }), maxCondition: 1000, currentCondition: cond, ...extra,
});
const eff = (magnitude) => ({
  type: 4, subType: 0, magnitudeBaseLow: magnitude, magnitudeBaseHigh: magnitude,
  magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
  durationBase: 0, durationMod: 0, durationPerLevel: 1, chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
});
const spellOf = (index, magnitude) => ({ name: `Spell ${index}`, index, element: 4, rangeType: 1, effects: [eff(magnitude)] });
const cwsItem = (cond, params, extra = {}) => item(cond, { enchantments: params.map((param) => ({ type: 2, param })), ...extra });

const fight = (ch, it, opts = {}) => simulateFight(ch, {
  target: referenceFoe(30, 'soft'), health: opts.health ?? 5, weapon: weaponOf(it), seed: opts.seed ?? 0, durability: true,
  trace: true, maxBlows: 1, cwsRolls: () => 0.5, conditionRolls: () => 0.1, ...opts.extra, standard: opts.standard,
});
const findRun = (make, pred, seeds = 200) => {
  for (let s = 0; s < seeds; s += 1) {
    const run = make(s);
    if (pred(run)) return { run, seed: s };
  }
  return null;
};

// ---------------------------------------------------------------------------------------------------------------------
// G3: the row walk after a killing cast
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Upstream's walk: `doItemEnchantmentPayloads(Strikes)` over `rows`, the foe dying at the cast of row `killAt` (1-based, or
 * never), the host's `applySpellToTarget` casting only for a live foe. The condition first loses `wear` (damageEquipment
 * runs at the core's tail, before the payloads), through the vendored `lowerCondition`.
 */
function upstreamWalk({ cond, rows, killAt = null, wear = 0, target = {} }) {
  const it = cwsItem(cond, rows);
  const owner = { equip: { slots: [] }, weapon: it, items: [it] };
  owner.equip.slots[19] = it;
  if (wear > 0) lowerCondition(it, wear, owner);
  const foe = { spareGear: false, dead: false, ...target };
  const casts = [];
  const map = new Map(rows.map((p) => [p, { index: p }]));
  doItemEnchantmentPayloads(PAYLOAD.Strikes, it, {
    entity: owner, target: foe, damage: 10,
    ctx: {
      spellsByIndex: () => map,
      applySpellToTarget: (record) => {
        if (foe.dead) return; // hostEnchant.js:205 `foes().find((x) => !x.dead && ...)`: no live foe, no cast
        casts.push(record.index);
        if (record.index === rows[killAt - 1]) foe.dead = true;
      },
    },
  });
  return { cond: it.currentCondition, equipped: !!owner.equip.slots[19], casts };
}

/** A production fight whose first blow walks `rows` and whose foe dies at row `killAt`. */
function killFight({ cond, killAt, extra = {} }) {
  const rows = [1, 2, 3];
  // damage per row: the killing row hits for 60, the others for 3; the pool is 20 (or unreachable for no kill)
  const mags = rows.map((_, i) => (killAt === i + 1 ? 60 : 3));
  const standard = new Map(rows.map((p, i) => [p, spellOf(p, mags[i])]));
  const it = cwsItem(cond, rows);
  const ch = simCharacter(DESC(), it);
  const found = findRun(
    (seed) => fight(ch, it, { seed, health: killAt ? 20 : 1e6, standard, extra }),
    (r) => r.cwsTrace.filter((e) => e.swing === 1).length === 3
      && r.cwsTrace.findIndex((e) => e.kill) === (killAt ? killAt - 1 : -1),
  );
  assert.ok(found, `cond ${cond} killAt ${killAt}: a first blow that walks three rows`);
  return found.run;
}

test('G3: every row of a blow is billed after a killing cast; the cast itself is not repeated', () => {
  // Production fight against the vendored walk: same rows, the foe dying at row 1, 2, 3 or never, four conditions.
  for (const cond of [45, 25, 15, 5]) {
    for (const killAt of [1, 2, 3, null]) {
      const r = killFight({ cond, killAt });
      const wear = r.trace[0].wear;
      const up = upstreamWalk({ cond, rows: [1, 2, 3], killAt, wear });
      const label = `cond ${cond} kill@${killAt}`;
      assert.equal(r.condition.main, up.cond, `${label}: final condition`);
      assert.equal(r.trace[0].equippedAfter.main, up.equipped, `${label}: still equipped`);
      assert.equal(r.cwsCasts, up.casts.length, `${label}: casts executed`);
      const rows = r.cwsTrace.filter((e) => e.swing === 1);
      assert.deepEqual(rows.map((e) => e.bill), [10, 10, 10], `${label}: every row billed`);
      // rows after the kill are processed and billed but not cast: no damage, no effects, flagged
      rows.forEach((e, i) => {
        const after = killAt !== null && i + 1 > killAt;
        assert.equal(e.afterKill === true, after, `${label}: row ${i + 1} afterKill`);
        if (after) {
          assert.equal(e.damage, 0);
          assert.equal(e.cast, false);
          assert.equal(e.effects, undefined, 'no cast, no effect record');
        } else assert.ok(e.damage > 0, `${label}: row ${i + 1} cast`);
      });
      assert.equal(r.kill, killAt !== null, `${label}: kill`);
      assert.equal(r.cwsKills, killAt !== null ? 1 : 0);
    }
  }
});

test('G3: bills after the kill can break the weapon; the kill still wins and nothing else lands', () => {
  // cond 15: wear 1 -> 14; row 1 kills and bills -> 4; row 2 (after the kill) bills -> break; row 3 re-reports it
  const echo = { kind: 'echo', chance: 100, name: 'warp' };
  const r = killFight({ cond: 15, killAt: 1, extra: { imprints: [echo] } });
  const b = r.breaks;
  assert.deepEqual(b.map((x) => x.reason), ['cws', 'cws']);
  assert.deepEqual(b.map((x) => x.afterKill === true), [true, true], 'the break comes from a bill after the kill');
  assert.deepEqual(b.map((x) => x.again === true), [false, true], 'the third bill is the same weapon reported again');
  assert.equal(r.kill, true);
  assert.equal(r.killSource, 'cws');
  assert.equal(r.endedByBreak, false, 'a kill is not a no-weapon stop');
  assert.equal(r.endReason, 'kill');
  assert.equal(r.weaponsBroken, 1);
  assert.equal(r.condition.main, 0);
  const e = r.trace[0];
  assert.equal(e.broke, true, 'the blow reports the break');
  assert.equal(e.meleeApplied, false, 'no melee after a CWS kill');
  assert.equal(e.echoApplied, 0, 'no echo after a CWS kill');
  assert.equal(e.echoSuppressed, false, 'the echo was lost to the kill, not to the break');
  assert.equal(r.blows, 1);
  assert.equal(r.ttk, e.t);
  // the break on the KILLING row itself (cond 5: 4 left after wear, the row-1 bill breaks it) is not an after-kill break
  const early = killFight({ cond: 5, killAt: 1 });
  assert.deepEqual(early.breaks.map((x) => [x.afterKill === true, x.again === true]), [[false, false], [true, true], [true, true]]);
});

test('G3: a kill with no later row is the control; a kill on the last row bills exactly what it did before', () => {
  const r = killFight({ cond: 45, killAt: 3 });
  assert.equal(r.cwsTrace.filter((e) => e.afterKill).length, 0);
  assert.equal(r.cwsCasts, 3);
  assert.equal(r.condition.main, 45 - r.trace[0].wear - 30);
  // a single-row item that kills: one row, one bill
  const standard = new Map([[1, spellOf(1, 60)]]);
  const it = cwsItem(45, [1]);
  const ch = simCharacter(DESC(), it);
  const found = findRun((seed) => fight(ch, it, { seed, health: 20, standard }), (x) => x.cwsKills === 1);
  assert.ok(found);
  assert.equal(found.run.cwsTrace.length, 1);
  assert.equal(found.run.condition.main, 45 - found.run.trace[0].wear - 10);
});

test('G3: bills are paid only for the rows the Strikes gate walks (not for a miss, a zero blow or an off-hand non-whole blow)', () => {
  // Over a long pair fight, every point of condition lost is either ordinary wear or a 10-point bill of a row that was walked,
  // and a row is walked only on a blow with positive pre-payload damage that counts whole (formulas.js:826-833).
  const big = (extra) => ({ ...weapon(121, { material: 9 }), maxCondition: 100000, currentCondition: 100000, ...extra });
  const main = big({ enchantments: [{ type: 2, param: 1 }, { type: 2, param: 2 }] });
  const ch = simCharacter(DESC(), main);
  ch.offWeapon = { ...big({ enchantments: [{ type: 2, param: 1 }] }), equipSlot: 21 };
  ch._dual = true;
  const standard = new Map([[1, spellOf(1, 5)], [2, spellOf(2, 5)]]);
  const r = simulateFight(ch, {
    target: referenceFoe(30, 'tough'), health: 1e9, weapon: weaponOf(main), dual: true, seed: 8, durability: true, trace: true,
    maxBlows: 120, standard, cwsRolls: () => 0.5, conditionRolls: () => 0.1,
  });
  assert.equal(r.breaks.length, 0);
  const walked = new Set(r.cwsTrace.map((c) => c.swing));
  let eligible = 0;
  for (const e of r.trace) {
    const gate = e.strikesPositive && e.whole;
    assert.equal(walked.has(e.swing), gate, `blow ${e.swing} (${e.hand}): rows walked iff the gate passes`);
    if (gate) eligible += 1;
  }
  assert.ok(eligible > 20 && eligible < r.trace.length, 'some blows pass the gate and some do not');
  assert.ok(r.trace.some((e) => e.hand === 'off' && !e.whole), 'the off hand has non-whole blows');
  const bills = r.cwsTrace.reduce((a, c) => a + c.bill, 0);
  assert.equal(bills, 10 * r.cwsTrace.length);
  const lost = (100000 - r.condition.main) + (100000 - r.condition.off);
  assert.equal(lost, r.wear + bills, 'condition lost = ordinary wear + 10 per walked row, nothing else');
});

test('G3: durability off keeps the original walk - the later rows after a kill leave no trace and no bill', () => {
  const standard = new Map([1, 2, 3].map((p) => [p, spellOf(p, p === 1 ? 60 : 3)]));
  const it = cwsItem(45, [1, 2, 3]);
  const ch = simCharacter(DESC(), it);
  const found = findRun(
    (seed) => simulateFight(ch, {
      target: referenceFoe(30, 'soft'), health: 20, weapon: weaponOf(it), seed, trace: true, maxBlows: 1, standard, cwsRolls: () => 0.5,
    }),
    (r) => r.cwsKills === 1,
  );
  assert.ok(found);
  assert.equal(found.run.cwsTrace.length, 1, 'the walk stops at the kill where there is nothing to bill');
  assert.equal(found.run.durability, false);
  assert.equal(found.run.endReason, 'kill');
});

test('G3: spareGear zeroes every bill, killing row or not; the ordinary-foe fight refuses such a target', () => {
  assert.equal(cwsBill({ spareGear: true }), 0);
  assert.equal(cwsBill({ spareGear: false }), 10);
  // the vendored walk: no bill on a spareGear target even though every row still runs (and the cast path is the relay's)
  const spare = upstreamWalk({ cond: 25, rows: [1, 2, 3], killAt: 1, target: { spareGear: true } });
  assert.equal(spare.cond, 25);
  assert.equal(spare.equipped, true);
  const standard = new Map([[1, spellOf(1, 60)]]);
  const it = cwsItem(25, [1]);
  const ch = simCharacter(DESC(), it);
  assert.throws(
    () => simulateFight(ch, {
      target: { ...referenceFoe(30, 'soft'), spareGear: true }, health: 20, weapon: weaponOf(it), durability: true, standard,
    }),
    /spareGear/,
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// G2: the aggregate statistics
// ---------------------------------------------------------------------------------------------------------------------

const row = (over) => ({
  endReason: 'kill', time: 10, weaponsBroken: 0, breaks: [], condition: { main: 500, off: null }, conditionPct: { main: 50, off: null }, ...over,
});

test('G2: the aggregates have the stated denominators, censoring and counting (hand-built rows)', () => {
  const rows = [
    row({ condition: { main: 400, off: 900 }, conditionPct: { main: 40, off: 90 } }), // A: kill, nothing broke
    row({ // B: kill after the main wore out; the off hand survived
      time: 8, weaponsBroken: 1, breaks: [{ t: 5, reason: 'wear' }], condition: { main: 0, off: 800 }, conditionPct: { main: 0, off: 80 },
    }),
    row({ // C: both weapons lost: a cws break at 3, a wear break at 6, the fight stops
      endReason: 'noWeaponLeft', time: 6, weaponsBroken: 2, breaks: [{ t: 3, reason: 'cws' }, { t: 6, reason: 'wear' }],
      condition: { main: 0, off: 0 }, conditionPct: { main: 0, off: 0 },
    }),
    row({ // D: a kill whose after-kill bill broke the weapon, and a third bill re-reported it
      time: 12, weaponsBroken: 1,
      breaks: [{ t: 12, reason: 'cws', afterKill: true }, { t: 12, reason: 'cws', afterKill: true, again: true }],
      condition: { main: 0, off: null }, conditionPct: { main: 0, off: null },
    }),
    row({ endReason: 'horizon', time: 20, condition: { main: 300, off: null }, conditionPct: { main: 30, off: null } }), // E
  ];
  const d = durabilityStats(rows);
  assert.equal(d.trials, 5);
  // denominator: ALL trials. A kill, a horizon stop and a no-break fight are all trials without a break.
  assert.equal(d.fightsWithBreak, 3);
  assert.deepEqual({ p: d.breakProbability.p, n: d.breakProbability.n }, { p: 0.6, n: 5 });
  assert.deepEqual(d.breakProbability, wilsonInterval(3, 5));
  // time to first break: the FIRST break of each breaking fight (5, 3, 12), conditional on a break
  assert.equal(d.timeToFirstBreak.n, 3);
  assert.ok(Math.abs(d.timeToFirstBreak.mean - 20 / 3) < 1e-12);
  assert.equal(d.timeToFirstBreak.min, 3);
  assert.equal(d.timeToFirstBreak.max, 12);
  // the unbroken fights are censored at their own time (A 10 s, E 20 s)
  assert.equal(d.timeAtRiskWithoutBreak.n, 2);
  assert.equal(d.timeAtRiskWithoutBreak.mean, 15);
  assert.deepEqual(d.weaponsBroken.counts, [2, 2, 1]);
  assert.ok(Math.abs(d.weaponsBroken.mean - 0.8) < 1e-12);
  // break REPORTS: 5 events, 4 distinct weapons lost, one of them an after-kill bill, one repeat
  assert.deepEqual(d.breakEvents, { distinct: 4, byReason: { wear: 2, cws: 2 }, afterKill: 1, repeats: 1 });
  assert.equal(d.noWeaponLeft.count, 1);
  assert.equal(d.noWeaponLeft.probability.p, 0.2);
  // end condition: per build hand, over the trials with an item there
  assert.equal(d.endCondition.main.n, 5);
  assert.equal(d.endCondition.main.broken, 3);
  assert.equal(d.endCondition.main.raw.mean, (400 + 0 + 0 + 0 + 300) / 5);
  assert.equal(d.endCondition.off.n, 3);
  assert.equal(d.endCondition.off.broken, 1);
  assert.ok(Math.abs(d.endCondition.off.raw.mean - (900 + 800 + 0) / 3) < 1e-9);
  assert.equal(d.endCondition.off.pct.n, 3);
});

/** The mixed set: killed, no weapon left and horizon-censored fights in one result (cond = max = 10, a short horizon). */
const mixed = () => {
  const it = { ...weapon(121, { material: 9 }), maxCondition: 10, currentCondition: 10 };
  const ch = simCharacter(DESC(), it);
  return simulateFights(ch, {
    target: referenceFoe(30, 'tough'), health: 100, weapon: weaponOf(it), seed: 11, trials: 60, durability: true, maxSeconds: 8,
  });
};

test('G2: killed, no-weapon-left and horizon-censored fights are separate counts that partition the trials', () => {
  const r = mixed();
  const byReason = (k) => r.rows.filter((x) => x.endReason === k).length;
  assert.deepEqual(r.outcomes, {
    killed: byReason('kill'), noWeaponLeft: byReason('noWeaponLeft'), horizonCensored: byReason('horizon'), blowBudgetCensored: byReason('blowBudget'),
  });
  assert.equal(r.outcomes.killed + r.outcomes.noWeaponLeft + r.outcomes.horizonCensored + r.outcomes.blowBudgetCensored, 60);
  assert.ok(r.outcomes.killed >= 5 && r.outcomes.noWeaponLeft >= 5 && r.outcomes.horizonCensored >= 5, JSON.stringify(r.outcomes));
  // `censored` keeps its meaning (no kill observed) and is exactly the other three together
  assert.equal(r.censored, r.outcomes.noWeaponLeft + r.outcomes.horizonCensored + r.outcomes.blowBudgetCensored);
  assert.equal(r.kills, r.outcomes.killed);
  // each class is what it says, judged from the fight itself
  for (const x of r.rows) {
    if (x.endReason === 'kill') { assert.equal(x.kill, true); assert.ok(x.ttk > 0); }
    if (x.endReason === 'noWeaponLeft') {
      assert.equal(x.kill, false); assert.equal(x.endedByBreak, true); assert.ok(x.weaponsBroken >= 1); assert.ok(x.time < 8);
    }
    if (x.endReason === 'horizon') {
      assert.equal(x.kill, false); assert.equal(x.endedByBreak, false); assert.equal(x.breaks.length, 0); assert.ok(x.time <= 8 + 1e-9);
    }
  }
  // the killProbability the Stage 3.2 summary reports is untouched: kills over ALL trials
  assert.equal(r.killProbability.p, r.kills / 60);
});

test('G2: break probability, time to first break and end condition through simulateFights', () => {
  const r = mixed();
  const d = r.durability;
  assert.deepEqual(d, durabilityStats(r.rows));
  const broke = r.rows.filter((x) => x.breaks.length > 0);
  assert.equal(d.fightsWithBreak, broke.length);
  assert.equal(d.breakProbability.n, 60, 'the denominator is every trial, not the unkilled or the broken');
  assert.equal(d.breakProbability.p, broke.length / 60);
  assert.equal(d.timeToFirstBreak.n, broke.length);
  const firsts = broke.map((x) => x.breaks[0].t).sort((a, b) => a - b);
  assert.equal(d.timeToFirstBreak.min, firsts[0]);
  assert.equal(d.timeToFirstBreak.max, firsts.at(-1));
  assert.ok(Math.abs(d.timeToFirstBreak.mean - firsts.reduce((a, b) => a + b, 0) / firsts.length) < 1e-12);
  assert.ok(broke.every((x) => x.breaks.every((b) => b.t >= x.breaks[0].t)), 'breaks are in time order');
  // a single weapon: every broken fight lost exactly that weapon, and every such fight is a no-weapon stop or a kill
  assert.equal(d.weaponsBroken.counts[1], broke.length);
  assert.equal(d.weaponsBroken.counts[2], 0);
  assert.equal(d.noWeaponLeft.count, r.outcomes.noWeaponLeft);
  assert.equal(d.endCondition.main.n, 60);
  assert.equal(d.endCondition.off.n, 0);
  assert.equal(d.endCondition.main.broken, broke.length);
  assert.equal(d.endCondition.main.raw.n, 60);
  // unbroken fights are the right-censored ones
  assert.equal(d.timeAtRiskWithoutBreak.n, 60 - broke.length);
});

test('G2: durability off reports no durability block and an all-zero no-weapon count; `outcomes` still partitions', () => {
  const it = item(1000);
  const ch = simCharacter(DESC(), it);
  const r = simulateFights(ch, { target: referenceFoe(30, 'tough'), health: 12000, weapon: weaponOf(it), trials: 20, maxSeconds: 2, seed: 3 });
  assert.equal(r.durability, null);
  assert.equal(r.censored, 20);
  assert.deepEqual(r.outcomes, { killed: 0, noWeaponLeft: 0, horizonCensored: 20, blowBudgetCensored: 0 });
  const budget = simulateFights(ch, { target: referenceFoe(30, 'tough'), health: 12000, weapon: weaponOf(it), trials: 5, maxBlows: 3, seed: 3 });
  assert.deepEqual(budget.outcomes, { killed: 0, noWeaponLeft: 0, horizonCensored: 0, blowBudgetCensored: 5 });
});

test('G2: paired seeds and dual wield aggregate per build, hand by hand', () => {
  const small = (cond) => ({ ...weapon(121, { material: 9 }), maxCondition: cond, currentCondition: cond });
  const mainItem = small(6);
  const dualCh = simCharacter(DESC(), mainItem);
  dualCh.offWeapon = { ...small(6), equipSlot: 21 };
  dualCh._dual = true;
  const soloItem = small(6);
  const soloCh = simCharacter(DESC(), soloItem);
  const seeds = Array.from({ length: 24 }, (_, i) => 100 + i);
  const common = { target: referenceFoe(30, 'tough'), health: 1e7, durability: true, maxSeconds: 60 };
  const paired = simulatePairedFights([
    { id: 'dual', ch: dualCh },
    { id: 'solo', ch: soloCh },
  ], { ...common, seeds, weapon: weaponOf(mainItem), dual: true });
  assert.deepEqual(paired.rows[0].result.seeds, paired.rows[1].result.seeds, 'the same seeds on both builds');
  const dual = paired.rows[0].result;
  // `dual: true` is in the shared args; the solo build is a single weapon either way
  const solo = paired.rows[1].result;
  assert.equal(dual.durability.endCondition.off.n, 24, 'a pair has an off item to report on every trial');
  assert.equal(solo.durability.endCondition.off.n, 0, 'a single weapon never has one');
  assert.ok(dual.durability.weaponsBroken.counts[2] > 0, 'both hands wear out in some fights');
  assert.equal(
    dual.outcomes.noWeaponLeft,
    dual.rows.filter((x) => x.weaponsBroken === 2 && x.endReason !== 'kill').length,
    'a pair stops only when BOTH weapons are gone',
  );
  assert.ok(dual.rows.every((x) => x.weaponsBroken < 2 || x.endReason === 'noWeaponLeft'));
  // each result aggregates only its own rows (no cross-build pooling)
  assert.deepEqual(dual.durability, durabilityStats(dual.rows));
  assert.deepEqual(solo.durability, durabilityStats(solo.rows));
  // a pair loses its first weapon no later than its second
  for (const x of dual.rows.filter((y) => y.weaponsBroken === 2)) assert.ok(x.breaks[0].t <= x.breaks.at(-1).t);
});

test('G2: each fight has exactly one end reason, in the loop\'s own priority', () => {
  const it = cwsItem(1, [1]);
  const ch = simCharacter(DESC(), it);
  const standard = new Map([[1, spellOf(1, 10)]]);
  const r = (extra) => simulateFight(ch, {
    target: referenceFoe(30, 'soft'), health: 1e6, weapon: weaponOf(it), seed: 4, durability: true, standard, ...extra,
  });
  assert.equal(r({}).endReason, 'noWeaponLeft', 'a one-point weapon breaks on its first landed blow');
  const sturdy = item(1000);
  const sch = simCharacter(DESC(), sturdy);
  const base = { target: referenceFoe(30, 'soft'), health: 1e6, weapon: weaponOf(sturdy), seed: 4, durability: true };
  assert.equal(simulateFight(sch, { ...base, maxBlows: 2 }).endReason, 'blowBudget');
  assert.equal(simulateFight(sch, { ...base, maxSeconds: 0.5 }).endReason, 'horizon');
  assert.equal(simulateFight(sch, { ...base, health: 5 }).endReason, 'kill');
});

// ---------------------------------------------------------------------------------------------------------------------
// G6: what `procsBeforeBreak` is
// ---------------------------------------------------------------------------------------------------------------------

test('G6: procsBeforeBreak is the bill-only capacity, same value, labelled as such', () => {
  const it = cwsItem(1000, [1]);
  assert.equal(procsBeforeBreak(it), 100);
  assert.equal(cwsBillCapacity(it), procsBeforeBreak(it));
  assert.equal(PROCS_BEFORE_BREAK_BASIS, 'cws-bill-only');
  assert.equal(cwsBillCapacity({ currentCondition: 0, maxCondition: 1000 }), null);
  assert.equal(cwsBillCapacity({ currentCondition: 25, maxCondition: 0 }), null);
  assert.equal(cwsBillCapacity({ currentCondition: 25, maxCondition: 1000 }), 2);
  const ch = simCharacter(DESC(), it);
  const a = analyze(ch, { target: referenceFoe(30, 'soft'), health: 1000, standard: new Map([[1, spellOf(1, 10)]]) });
  assert.equal(a.procsBeforeBreak, 100, 'the field and its value are unchanged');
  assert.equal(a.procsBeforeBreakBasis, 'cws-bill-only', 'and it says what it counts');
  assert.match(billCapacityNote(12), /bill-only/);
  assert.match(billCapacityNote(12), /wear/);
  // no surface calls it procs "before break" any more
  const cli = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.equal(/procs before break/i.test(cli), false, 'the CLI no longer says "procs before break"');
  assert.ok(cli.includes('billCapacityNote('));
  assert.ok(cli.includes('procsBeforeBreakBasis'));
});

test('G6: the bound is not a cast count (upstream, no wear): the exhausting cast is real and not in floor(cond / 10)', () => {
  // condition 25, one row: bills 25 -> 15 -> 5 -> 0 (the third bill breaks it). Three casts happen; the bound says 2.
  const it = cwsItem(25, [1]);
  const owner = { equip: { slots: [] }, weapon: it, items: [it] };
  owner.equip.slots[19] = it;
  let casts = 0;
  const map = new Map([[1, { index: 1 }]]);
  for (let blow = 0; blow < 10 && owner.equip.slots[19]; blow += 1) {
    doItemEnchantmentPayloads(PAYLOAD.Strikes, it, {
      entity: owner, target: { spareGear: false }, damage: 10,
      ctx: { spellsByIndex: () => map, applySpellToTarget: () => { casts += 1; } },
    });
  }
  assert.equal(casts, 3);
  assert.equal(cwsBillCapacity(cwsItem(25, [1])), 2);
  assert.notEqual(casts, cwsBillCapacity(cwsItem(25, [1])));
});

test('G6: ordinary wear makes the bound overstate the casts a real weapon gets before it breaks', () => {
  const D = character({
    level: 40, raceId: 1, stats: { strength: 100, agility: 80, speed: 60, luck: 50 }, skills: 0,
    skillOverride: { 29: 100, 30: 100, 31: 100, 32: 100, 33: 100, 34: 80, 19: 90 },
  });
  const it = { ...weapon(126, { material: 9 }), maxCondition: 400, currentCondition: 400, enchantments: [{ type: 2, param: 1 }] };
  const ch = simCharacter(D, it);
  const bound = cwsBillCapacity(it);
  assert.equal(bound, 40);
  const r = simulateFights(ch, {
    target: referenceFoe(1, 'soft'), health: 1e9, weapon: weaponOf(it), seed: 5, trials: 24, durability: true, maxBlows: 2000,
    standard: new Map([[1, spellOf(1, 10)]]),
  });
  assert.equal(r.outcomes.noWeaponLeft, 24, 'every weapon wore out');
  const casts = r.rows.map((x) => x.cwsCasts);
  const mean = casts.reduce((a, b) => a + b, 0) / casts.length;
  assert.ok(Math.max(...casts) < bound, `no trial reached the bound: ${Math.max(...casts)} < ${bound}`);
  assert.ok(mean < 0.9 * bound, `mean ${mean} casts against a bound of ${bound}`);
  assert.ok(r.rows.every((x) => x.wear > 0), 'ordinary wear took condition the bound never counted');
});
