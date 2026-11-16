/*
 * test/durability.test.js - Stage 3.5.2: ordinary weapon wear, the CWS condition bill and the break state machine.
 *
 * The oracle is the pinned vendored law itself: combat/formulas.js damageEquipment (the stock wear) and
 * systems/enchantments.js doItemEnchantmentPayloads (the CWS row, its bill and the break), plus systems/equip.js
 * lowerCondition. Each local case is driven on the same inputs and, where a sequence matters, on the local fight's own
 * recorded damage sequence. Durability is opt-in (`durability: true`); the default path is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { referenceFoe, weaponOf } from '../src/model.js';
import { createAttackSchedule, simulateFight } from '../src/simulateFight.js';
import {
  blowWear, cwsBill, makeOwner, wearAmount, wearItem, CWS_CONDITION_COST,
} from '../src/durability.js';
import { damageEquipment } from '../vendor/upstream/a3eb1605/src/combat/formulas.js';
import { doItemEnchantmentPayloads, PAYLOAD, DURABILITY_LOSS_ON_STRIKE } from '../vendor/upstream/a3eb1605/src/systems/enchantments.js';
import { lowerCondition } from '../vendor/upstream/a3eb1605/src/systems/equip.js';

const DESC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const item = (cond = 1000, extra = {}) => ({
  ...weapon(121, { material: 9 }), maxCondition: 1000, currentCondition: cond, ...extra,
});
const eff = (type, subType, magnitude = 10) => ({
  type, subType,
  magnitudeBaseLow: magnitude, magnitudeBaseHigh: magnitude,
  magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
  durationBase: 0, durationMod: 0, durationPerLevel: 1,
  chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
});
const spellOf = (index = 1, effect = eff(4, 0, 10)) => ({
  name: `Spell ${index}`, index, element: 4, rangeType: 1, effects: [effect],
});
const cws = (cond, params, extra = {}) => item(cond, {
  enchantments: params.map((param) => ({ type: 2, param })), ...extra,
});
const dual = (main, off) => {
  const ch = simCharacter(DESC(), main);
  ch.offWeapon = { ...off, equipSlot: 21 };
  ch._dual = true;
  return ch;
};
const fight = (ch, it, opts = {}) => simulateFight(ch, {
  target: referenceFoe(30, 'tough'),
  health: opts.health ?? 3000,
  weapon: weaponOf(it),
  seed: opts.seed ?? 0,
  durability: true,
  trace: true,
  maxBlows: opts.maxBlows ?? 40,
  ...(opts.standard ? { standard: opts.standard } : {}),
  ...(opts.dual ? { dual: true } : {}),
  ...(opts.conditionRolls ? { conditionRolls: opts.conditionRolls } : {}),
  ...(opts.extra ?? {}),
});
/** The first seed whose run satisfies `pred`, so a hit/whole precondition is a test input, not a lucky default. */
const findRun = (make, pred, seeds = 300) => {
  for (let s = 0; s < seeds; s += 1) {
    const run = make(s);
    if (pred(run)) return { run, seed: s };
  }
  return null;
};

// A synthetic owner for the vendored wear leaf: DFU's two hand slots, the active weapon, an empty pack.
const upOwner = (it) => {
  const owner = { equip: { slots: [] }, weapon: it, items: [it] };
  owner.equip.slots[19] = it;
  return owner;
};
const upWear = (damage, roll = 0.1) => {
  const it = item(1000);
  const owner = upOwner(it);
  let draws = 0;
  damageEquipment(owner, { spareGear: false, equip: { slots: [] } }, damage, it, 0, {
    rolls: () => { draws += 1; return roll; },
  });
  return { it, owner, wear: 1000 - it.currentCondition, draws };
};
const upCws = (cond, params, { spells = true, damage = 10, target = { spareGear: false } } = {}) => {
  const it = cws(cond, params);
  const owner = upOwner(it);
  const calls = [];
  const map = spells ? new Map(params.map((p) => [p, { index: p }])) : new Map();
  doItemEnchantmentPayloads(PAYLOAD.Strikes, it, {
    entity: owner, target, damage,
    ctx: { spellsByIndex: () => map, applySpellToTarget: (record) => calls.push(record.index) },
  });
  return { it, owner, calls, cond: it.currentCondition, equipped: !!owner.equip.slots[19] };
};
const localCws = (cond, params, target = { spareGear: false }) => {
  const it = cws(cond, params);
  const owner = makeOwner(it);
  const bill = cwsBill(target);
  for (let i = 0; i < params.length; i += 1) if (bill > 0) wearItem(owner, it, bill);
  return { it, owner, cond: it.currentCondition, equipped: !!owner.equip.slots[19] };
};

test('wear: the exact DFU amount, the 20% floor roll and its draw count match damageEquipment', () => {
  assert.equal(CWS_CONDITION_COST, 10);
  assert.equal(DURABILITY_LOSS_ON_STRIKE, 10);
  for (const damage of [0, 1, 4, 5, 49, 50, 100, 1000]) {
    let draws = 0;
    const local = blowWear(damage, () => { draws += 1; return 0.1; });
    const up = upWear(damage, 0.1);
    assert.equal(local, up.wear, `damage ${damage}: local wear ${local} vs ${up.wear}`);
    assert.equal(draws, up.draws, `damage ${damage}: roll count`);
    assert.equal(wearAmount(damage), Math.trunc((10 * damage + 50) / 100));
  }
  // The floor is a 20% chance, only when the integer amount is 0 (damage 1..4).
  assert.equal(blowWear(1, () => 0.199), 1);
  assert.equal(blowWear(1, () => 0.2), 0);
  assert.equal(upWear(1, 0.199).wear, 1);
  assert.equal(upWear(1, 0.2).wear, 0);
  let draws = 0;
  assert.equal(blowWear(5, () => { draws += 1; return 0; }), 1);
  assert.equal(draws, 0, 'an amount of 1 draws no wear roll at scale 1');
  assert.equal(blowWear(0, () => { draws += 1; return 0; }), 0);
  assert.equal(draws, 0, 'no damage draws no roll');
  // spareGear skips the wear entirely (formulas.js:574).
  const it = item(1000);
  const owner = upOwner(it);
  damageEquipment(owner, { spareGear: true, equip: { slots: [] } }, 100, it, 0, { rolls: () => 0.1 });
  assert.equal(it.currentCondition, 1000);
  assert.equal(cwsBill({ spareGear: true }), 0);
  assert.equal(cwsBill({ spareGear: false }), 10);
});

test('break: lowerCondition clamps, unequips by identity and clears owner.weapon; no condition cannot break', () => {
  const it = item(15);
  const owner = makeOwner(it);
  assert.equal(wearItem(owner, it, 10), false);
  assert.equal(it.currentCondition, 5);
  assert.equal(owner.equip.slots[19], it);
  assert.equal(wearItem(owner, it, 10), true);
  assert.equal(it.currentCondition, 0);
  assert.equal(owner.equip.slots[19], null);
  assert.equal(owner.weapon, null);
  // A second bill on the same broken item clamps at 0 and reports the break again (upstream's shape).
  assert.equal(wearItem(owner, it, 10), true);
  assert.equal(it.currentCondition, 0);
  // maxCondition 0: the frozen stand-in cannot break (equip.js:575).
  const frozen = item(0, { maxCondition: 0 });
  const owner2 = makeOwner(frozen);
  assert.equal(wearItem(owner2, frozen, 10), false);
  assert.equal(frozen.currentCondition, 0);
  assert.equal(owner2.equip.slots[19], frozen);
  // The vendored leaf is the one used; the synthetic owner matches its own contract.
  const vend = item(15);
  const vowner = upOwner(vend);
  lowerCondition(vend, 10, vowner);
  assert.equal(vend.currentCondition, 5);
  assert.equal(vowner.equip.slots[19], vend);
  lowerCondition(vend, 10, vowner);
  assert.equal(vend.currentCondition, 0);
  assert.equal(vowner.equip.slots[19], null);
  assert.equal(vowner.weapon, null);
});

test('CWS bill: 10 per row after the cast, paid for a missing record, zeroed by spareGear, and a break between rows', () => {
  const cases = [[25, [1, 2]], [15, [1, 2]], [5, [1]]];
  for (const [cond, rows] of cases) {
    const up = upCws(cond, rows);
    const local = localCws(cond, rows);
    assert.equal(local.cond, up.cond, `condition ${cond}`);
    assert.equal(local.equipped, up.equipped, `equipped ${cond}`);
    assert.ok(up.calls.length === rows.length, 'every row casts');
  }
  const missing = upCws(25, [1, 2], { spells: false });
  assert.deepEqual(missing.calls, []);
  assert.equal(missing.cond, 5, 'a missing record still pays 10 a row');
  const spare = upCws(25, [1, 2], { target: { spareGear: true } });
  assert.equal(spare.cond, 25, 'spareGear zeroes the bill');
  assert.equal(spare.calls.length, 2, 'the cast still happens');
  // Zero damage and a ward: the row guard stops both the cast and the bill.
  assert.equal(upCws(25, [1], { damage: 0 }).cond, 25);
  assert.equal(upCws(25, [1], { target: { spareGear: false, warded: true } }).cond, 25);
  // A row break between rows: the second row still casts and pays.
  const broke = upCws(15, [1, 2]);
  assert.deepEqual(broke.calls, [1, 2]);
  assert.equal(broke.cond, 0);
  assert.equal(broke.equipped, false);
});

test('the fight wears the striking weapon, breaks it at the same point, and the current blow still lands', () => {
  const it = cws(10, [1]);
  const ch = simCharacter(DESC(), it);
  const before = JSON.stringify(it);
  const standard = new Map([[1, spellOf(1)]]);
  const found = findRun((seed) => fight(ch, it, { seed, maxBlows: 30, standard }), (r) => r.breaks.length > 0);
  assert.ok(found, 'a run with a break');
  const { run } = found;
  assert.equal(run.durability, true);
  assert.equal(run.breaks[0].hand, 'main');
  assert.equal(run.breaks[0].reason, 'cws');
  assert.equal(run.breaks[0].amount, 10);
  assert.equal(run.endedByBreak, true, 'no weapon left: the local fist schedule does not exist');
  assert.equal(run.condition.main, 0);
  assert.equal(run.cwsCasts, 1);
  assert.deepEqual(run.trace.at(-1).equippedAfter, { main: false, off: false }, 'the broken hand is unequipped');
  assert.ok(run.trace[0].meleeApplied || run.trace[0].cwsDamage > 0, 'the break blow was not rolled back');
  assert.equal(JSON.stringify(it), before, 'the caller-owned item is unchanged');
  assert.equal(ch.weapon.currentCondition, 10, 'the caller character is unchanged');
});

test('an ordinary-wear break unequips the hand and is not the CWS bill\'s doing', () => {
  const plain = item(4); // no enchantment: only ordinary wear can break it
  const ch = simCharacter(DESC(), plain);
  const found = findRun((seed) => fight(ch, plain, { seed, maxBlows: 4 }), (r) => r.breaks.length > 0);
  assert.ok(found, 'a plain weapon worn to 0');
  assert.equal(found.run.breaks[0].reason, 'wear');
  assert.ok(found.run.breaks[0].amount >= 1, 'a plain blow wears');
  assert.deepEqual(found.run.trace.at(-1).equippedAfter, { main: false, off: false });
  assert.equal(found.run.endedByBreak, true);
  assert.equal(found.run.condition.main, 0);
});

test('the survivor\'s own powers and health thresholds replace the broken weapon\'s', () => {
  // The main carries an execute power (a 25% threshold); the off is plain. After the main breaks, the survivor must
  // supply the fight's powers and bounds, not the broken main's.
  const main = cws(10, [1], { rarity: 'legendary', legendary: 'night-mothers-embrace' });
  const off = item(1000);
  const ch = dual(main, off);
  const standard = new Map([[1, spellOf(1)]]);
  const found = findRun(
    (seed) => fight(ch, main, { seed, maxBlows: 40, standard, dual: true }),
    (r) => r.breaks.some((b) => b.hand === 'main') && r.trace.some((e) => e.t > r.breaks[0].t),
  );
  assert.ok(found, 'the execute main breaks');
  assert.equal(found.run.bounds.includes(0.25), false, 'the broken weapon\'s execute threshold is gone');
});

test('a main-hand break promotes the surviving off hand; an off-hand break leaves the main hand', () => {
  const standard = new Map([[1, spellOf(1)]]);
  // Main breaks (CWS), off survives.
  const main = cws(10, [1]);
  const off = item(1000);
  const ch = dual(main, off);
  const mainBefore = JSON.stringify(main);
  const offBefore = JSON.stringify(off);
  const foundMain = findRun(
    (seed) => fight(ch, main, { seed, maxBlows: 60, standard, dual: true }),
    (r) => r.breaks.some((b) => b.hand === 'main')
      && r.trace.filter((e) => e.t > r.breaks[0].t).length >= 3,
  );
  assert.ok(foundMain, 'a main break with a surviving hand');
  const rMain = foundMain.run;
  const mainBreak = rMain.trace.findIndex((e) => e.broke);
  assert.ok(mainBreak >= 0);
  assert.deepEqual(rMain.trace[mainBreak].equippedAfter, { main: false, off: true }, 'the broken main is unequipped, the off kept');
  const after = rMain.trace.slice(mainBreak + 1);
  assert.ok(after.length > 0, 'the fight continues');
  assert.ok(after.every((e) => e.hand === 'main'), 'the survivor is the lead hand');
  assert.deepEqual(after[0].equippedAfter, { main: true, off: false });
  assert.ok(after[0].t > rMain.trace[mainBreak].t, 'the new schedule starts after the break');
  assert.equal(rMain.endedByBreak, false);
  assert.equal(rMain.condition.main, 0);
  assert.ok(rMain.condition.off < 1000, 'the survivor wears');
  // The survivor's single cadence, not the old dual exchange: the post-break intervals are its own schedule's.
  const singleCh = simCharacter(DESC(), off);
  const single = createAttackSchedule(singleCh, {
    target: referenceFoe(30, 'tough'), health: 3000, weapon: weaponOf(off),
  });
  const interval = single.assumptions.interval;
  assert.ok(Math.abs((after[2].t - after[1].t) - interval) < 1e-9, 'the survivor re-scheduled at its single cadence');
  assert.equal(JSON.stringify(main), mainBefore);
  assert.equal(JSON.stringify(off), offBefore);

  // Off breaks (CWS), main survives.
  const main2 = item(1000);
  const off2 = cws(10, [1]);
  const ch2 = dual(main2, off2);
  const foundOff = findRun(
    (seed) => fight(ch2, main2, { seed, maxBlows: 60, standard, dual: true }),
    (r) => r.breaks.some((b) => b.hand === 'off') && r.trace.some((e) => e.hand === 'main' && e.t > r.breaks[0].t),
  );
  assert.ok(foundOff, 'an off break with a surviving main');
  const rOff = foundOff.run;
  assert.equal(rOff.breaks[0].hand, 'off');
  assert.deepEqual(rOff.trace[rOff.trace.findIndex((e) => e.broke)].equippedAfter, { main: true, off: false });
  assert.equal(rOff.endedByBreak, false);
  assert.equal(rOff.condition.off, 0);
  assert.ok(rOff.condition.main < 1000, 'the main wears and continues');
});

test('a break on the first of three rows still walks and bills the later rows', () => {
  const it = cws(10, [1, 2, 3]);
  const ch = simCharacter(DESC(), it);
  const standard = new Map([[1, spellOf(1)], [2, spellOf(2)], [3, spellOf(3)]]);
  const found = findRun(
    (seed) => fight(ch, it, { seed, maxBlows: 1, standard }),
    (r) => r.cwsTrace.filter((e) => e.swing === 1).length === 3,
  );
  assert.ok(found, 'a first blow that walks three rows');
  const rows = found.run.cwsTrace.filter((e) => e.swing === 1);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.bill), [10, 10, 10]);
  assert.equal(found.run.cwsCasts, 3);
  assert.equal(found.run.endedByBreak, true);
  assert.equal(found.run.condition.main, 0);
});

test('the broken item leaves the spell-power table; the survivor\'s potency is the only one counted', () => {
  const main = cws(10, [1], { affixes: [{ id: 'potency', value: 15 }] });
  const off = cws(1000, [1], { affixes: [{ id: 'potency', value: 5 }] });
  const ch = dual(main, off);
  const standard = new Map([[1, spellOf(1)]]);
  const found = findRun(
    (seed) => fight(ch, main, { seed, maxBlows: 40, standard, dual: true }),
    (r) => r.breaks.some((b) => b.hand === 'main')
      && r.cwsTrace.some((c) => c.swing > r.trace.find((e) => e.broke).swing),
  );
  assert.ok(found, 'the main breaks and the off casts later');
  const breakSwing = found.run.trace.find((e) => e.broke).swing;
  const post = found.run.cwsTrace.find((c) => c.swing > breakSwing);
  assert.ok(post);
  assert.equal(post.effects[0].spellPower, 1.05, '5% potency, not the broken main\'s 15% added');
});

test('multiple CWS rows: a break between rows does not skip the later row; both cast and both pay', () => {
  const it = cws(15, [1, 2]);
  const ch = simCharacter(DESC(), it);
  const standard = new Map([[1, spellOf(1)], [2, spellOf(2)]]);
  const found = findRun(
    (seed) => fight(ch, it, { seed, maxBlows: 1, standard }),
    (r) => r.cwsTrace.filter((e) => e.swing === 1).length === 2,
  );
  assert.ok(found, 'a first blow that walks both rows');
  const rows = found.run.cwsTrace.filter((e) => e.swing === 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bill, 10);
  assert.equal(rows[1].bill, 10);
  assert.equal(rows[0].broke, false);
  assert.equal(rows[1].broke, true);
  assert.equal(found.run.cwsCasts, 2, 'the later row still casts after the break');
  assert.equal(found.run.endedByBreak, true, 'a single weapon leaves no fist schedule');
  assert.equal(found.run.condition.main, 0);
});

test('a resisted, absorbed or deferred cast still pays its 10', () => {
  // Spell resistance 100: the cast lands nothing, the row still pays.
  const resistedTarget = { ...referenceFoe(30, 'tough'), activeEffects: [{ kind: 'spellResistance', chance: 100 }] };
  const it = cws(30, [1]);
  const ch = simCharacter(DESC(), it);
  const standard = new Map([[1, spellOf(1)]]);
  const found = findRun(
    (seed) => simulateFight(ch, {
      target: resistedTarget, health: 3000, weapon: weaponOf(it), seed, durability: true, trace: true, maxBlows: 5,
      standard,
    }),
    (r) => r.cwsTrace.length > 0 && r.cwsTrace[0].resisted > 0,
  );
  assert.ok(found, 'a resisted CWS');
  assert.equal(found.run.cwsTrace[0].damage, 0);
  assert.equal(found.run.cwsTrace[0].bill, 10);
  assert.ok(found.run.trace[0].condition < 30, 'ordinary wear and the bill both lower the item');

  // A non-damage effect (1,0) is deferred, and still billed.
  const deferred = cws(30, [1]);
  const ch2 = simCharacter(DESC(), deferred);
  const std2 = new Map([[1, spellOf(1, eff(1, 0, 10))]]);
  const found2 = findRun(
    (seed) => fight(ch2, deferred, { seed, maxBlows: 5, standard: std2 }),
    (r) => r.cwsTrace.length > 0 && r.cwsTrace[0].deferred > 0,
  );
  assert.ok(found2, 'a deferred CWS');
  assert.equal(found2.run.cwsTrace[0].damage, 0);
  assert.equal(found2.run.cwsTrace[0].bill, 10);
});

test('absorbed and zero-magnitude casts still pay; a zero-damage blow pays and wears nothing', () => {
  const standard = new Map([[1, spellOf(1)]]);
  const absorbedTarget = {
    ...referenceFoe(30, 'tough'), career: { spellAbsorptionFlags: 4 }, magicka: 0, maxMagicka: 1000,
  };
  const it = cws(30, [1]);
  const ch = simCharacter(DESC(), it);
  const found = findRun(
    (seed) => simulateFight(ch, {
      target: absorbedTarget, health: 3000, weapon: weaponOf(it), seed, durability: true, trace: true, maxBlows: 5, standard,
    }),
    (r) => r.cwsTrace.length > 0 && r.cwsTrace[0].absorbed > 0,
  );
  assert.ok(found, 'an absorbed CWS');
  assert.equal(found.run.cwsTrace[0].damage, 0);
  assert.equal(found.run.cwsTrace[0].bill, 10);

  // A (4,0) effect of magnitude 0 casts, lands 0 and pays.
  const zero = cws(30, [1]);
  const ch0 = simCharacter(DESC(), zero);
  const std0 = new Map([[1, spellOf(1, eff(4, 0, 0))]]);
  const found0 = findRun(
    (seed) => fight(ch0, zero, { seed, maxBlows: 5, standard: std0 }),
    (r) => r.cwsTrace.length > 0 && r.cwsTrace[0].damage === 0,
  );
  assert.ok(found0, 'a zero-magnitude CWS');
  assert.equal(found0.run.cwsTrace[0].bill, 10);

  // A miss: no wear and no bill (the row's damage === 0 gate).
  const missIt = cws(30, [1]);
  const chM = simCharacter(DESC(), missIt);
  const foundM = findRun(
    (seed) => fight(chM, missIt, { seed, maxBlows: 1, standard }),
    (r) => r.trace.length > 0 && r.trace[0].strikesPositive === false,
  );
  assert.ok(foundM, 'a miss');
  assert.equal(foundM.run.cwsTrace.length, 0);
  assert.equal(foundM.run.condition.main, 30, 'no wear on a zero-damage blow');
});

test('the fight draws the 20% floor roll from the injectable condition stream', () => {
  const weak = character({
    level: 30, raceId: 1, stats: { strength: 0, agility: 50, speed: 50, luck: 50 }, skills: 0,
  });
  const plain = item(30);
  const ch = simCharacter(weak, plain);
  const base = {
    target: referenceFoe(30, 'tough'), health: 3000, weapon: weaponOf(plain), durability: true, trace: true, maxBlows: 60,
  };
  const found = findRun((seed) => simulateFight(ch, { ...base, seed, conditionRolls: () => 0.1 }), (r) => r.trace.some((e) => e.strikesDamage > 0 && e.strikesDamage < 5));
  assert.ok(found, 'a weak build lands a 1..4-damage blow');
  const seed = found.seed;
  const floor = found.run.trace.filter((e) => e.strikesDamage > 0 && e.strikesDamage < 5);
  assert.equal(floor.length > 0, true);
  assert.ok(floor.every((e) => e.wear === 1), 'roll 0.1 is inside the 20% floor');

  const high = simulateFight(ch, { ...base, seed, conditionRolls: () => 0.9 });
  const floorHigh = high.trace.filter((e) => e.strikesDamage > 0 && e.strikesDamage < 5);
  assert.ok(floorHigh.every((e) => e.wear === 0), 'roll 0.9 is outside it - the injected stream is the one drawn');
  assert.equal(floorHigh.length, floor.length);
});

test('a condition band crossing rebuilds the next blow\'s tier; a frozen piece cannot wear or break', () => {
  // sharpEdge is off in this build, so the blade's live bands are >=61: 1, 41-60: 0.85, 16-40: 0.7, 6-15: 0.45, <=5: 0.25.
  const banded = item(61, { maxCondition: 100 });
  const ch = simCharacter(DESC(), banded);
  const found = findRun(
    (seed) => fight(ch, banded, { seed, maxBlows: 2 }),
    (r) => r.trace.length > 1 && r.trace[0].wear > 0 && r.trace[0].condition <= 60,
  );
  assert.ok(found, 'a blow that crosses 61% down to 60%');
  const [first, second] = found.run.trace;
  assert.equal(first.tierBand, 1, '61% is the >=61% blade band');
  assert.equal(second.tierBand, 0.85, '60% is the 41-60% blade band');
  assert.ok(second.t >= first.t && second.condition <= 60);

  const frozen = item(0, { maxCondition: 0 });
  const chFrozen = simCharacter(DESC(), frozen);
  const r = fight(chFrozen, frozen, { seed: 0, maxBlows: 5 });
  assert.equal(r.breaks.length, 0);
  assert.equal(r.endedByBreak, false);
  assert.equal(r.wear, 0);
  assert.equal(r.condition.main, 0);
});

test('a content-identical hand item is not removed by the other hand\'s break', () => {
  // Both hands carry the same piece: same content, same condition. The main breaks first; the off is a different item,
  // and a break by identity must leave it equipped for the next blow.
  const main = cws(10, [1], { affixes: [{ id: 'potency', value: 10 }] });
  const off = cws(10, [1], { affixes: [{ id: 'potency', value: 10 }] });
  const ch = dual(main, off);
  const standard = new Map([[1, spellOf(1)]]);
  const found = findRun(
    (seed) => fight(ch, main, { seed, maxBlows: 20, standard, dual: true }),
    (r) => r.breaks.length > 0 && r.breaks[0].hand === 'main'
      && r.trace.some((e) => e.t > r.breaks[0].t && e.cwsCasts > 0),
  );
  assert.ok(found, 'the main breaks and the content-identical off hand still casts');
  const r = found.run;
  assert.equal(r.breaks[0].hand, 'main');
  const after = r.trace.filter((e) => e.t > r.breaks[0].t);
  assert.ok(after.length > 0, 'the off hand is a different item and survived the main break');
  assert.ok(after.some((e) => e.cwsCasts > 0), 'the off item still casts');
  // The survivor's potency is still read after the broken item leaves the equip table (identity, not content).
  const offCast = r.cwsTrace.find((c) => c.swing > r.trace.find((e) => e.broke).swing);
  assert.ok(offCast && offCast.effects?.[0]?.spellPower === 1.1, 'the off item potency survived the main break');
});

test('ordinary wear uses the PRE-payload damage (Potent Vs adds to the blow, not to the wear)', () => {
  const pv = { ...weapon(121, { material: 9 }), maxCondition: 1000, currentCondition: 1000,
    enchantments: [{ type: 4, param: 1 }] };
  const ch = simCharacter(DESC(), pv);
  const target = { ...referenceFoe(30, 'tough'), mobileType: 25, career: {} };
  const found = findRun(
    (seed) => simulateFight(ch, {
      target, health: 3000, weapon: weaponOf(pv), seed, durability: true, trace: true, maxBlows: 3,
      conditionRolls: () => 0.1,
    }),
    (r) => r.trace.length > 0 && r.trace[0].strikesDamage >= 20,
  );
  assert.ok(found, 'a landed Potent Vs blow');
  const ev = found.run.trace[0];
  assert.equal(ev.blow, ev.strikesDamage + 5, 'the post-payload blow is +5');
  assert.equal(ev.wear, wearAmount(ev.strikesDamage), 'damageEquipment met the pre-payload value');
});

test('durability changes only the fight\'s clones, and the same seed replays exactly', () => {
  const main = cws(10, [1]);
  const off = item(1000);
  const ch = dual(main, off);
  const snapshot = JSON.stringify({ worn: ch.worn, weapon: ch.weapon, off: ch.offWeapon });
  const whatIf = cws(5, [1]);
  const whatIfBefore = JSON.stringify(whatIf);
  const standard = new Map([[1, spellOf(1)]]);
  const args = {
    target: referenceFoe(30, 'tough'), health: 3000, weapon: weaponOf(whatIf), dual: true, seed: 7,
    durability: true, trace: true, maxBlows: 40, standard,
  };
  const r1 = simulateFight(ch, args);
  const r2 = simulateFight(ch, { ...args });
  assert.equal(JSON.stringify({ worn: ch.worn, weapon: ch.weapon, off: ch.offWeapon }), snapshot);
  assert.equal(JSON.stringify(whatIf), whatIfBefore);
  assert.deepEqual(r1.breaks, r2.breaks);
  assert.deepEqual(r1.condition, r2.condition);
  assert.equal(r1.remainingHealth, r2.remainingHealth);
  assert.equal(r1.blows, r2.blows);
  assert.equal(r1.damageDealt, r2.damageDealt);
});

test('the fight\'s wear/bill/break state matches upstream replayed on its own damage sequence', () => {
  const initial = 40;
  const it = cws(initial, [1]);
  const ch = simCharacter(DESC(), it);
  const standard = new Map([[1, spellOf(1)]]);
  const run = fight(ch, it, { seed: 7, maxBlows: 60, standard, conditionRolls: () => 0.1 });
  assert.ok(run.durability);
  assert.ok(run.trace.length > 0);
  // The twin starts where the local item did, and met the same damage sequence, wear roll and row bills.
  const twin = cws(initial, [1]);
  const owner = upOwner(twin);
  for (const ev of run.trace) {
    const before = twin.currentCondition;
    if (ev.strikesDamage > 0) {
      damageEquipment(owner, { spareGear: false, equip: { slots: [] } }, ev.strikesDamage, twin, 0, { rolls: () => 0.1 });
    }
    assert.equal(ev.wear, before - twin.currentCondition, `swing ${ev.swing}: wear`);
    const bills = run.cwsTrace.filter((c) => c.swing === ev.swing).length;
    for (let i = 0; i < bills; i += 1) lowerCondition(twin, 10, owner);
    assert.equal(ev.condition, twin.currentCondition, `swing ${ev.swing}: condition after the bill`);
    assert.equal(ev.broke, !owner.equip.slots[19] && twin.currentCondition === 0, `swing ${ev.swing}: break`);
  }
  assert.equal(run.condition.main, twin.currentCondition);
  assert.equal(run.endedByBreak, !owner.equip.slots[19] && twin.currentCondition === 0);
});

test('a broken weapon loses its Many Endings echo but the current blow\'s damage (and Flow) survives', () => {
  // Many Endings: an echo rolled on the breaking blow is suppressed.
  const echoItem = cws(10, [1], { rarity: 'rare', imprint: 'warp-edge' });
  const ch = simCharacter(DESC(), echoItem);
  const standard = new Map([[1, spellOf(1)]]);
  const found = findRun(
    (seed) => fight(ch, echoItem, { seed, maxBlows: 20, standard }),
    (r) => r.trace.some((e) => e.broke && e.echoHits > 0),
  );
  assert.ok(found, 'a break blow where the echo rolled');
  const breaking = found.run.trace.find((e) => e.broke && e.echoHits > 0);
  assert.equal(breaking.echoSuppressed, true);
  assert.equal(breaking.echoApplied, 0);
  assert.ok(breaking.echoHits > 0, 'the roll happened; the power was no longer worn');

  // Flow: the same blow's sampled damage is identical with the wear/break and without it. The blow stream is
  // independent of the condition stream, so the same seed samples the same outcome.
  const flowItem = cws(10, [1], { rarity: 'legendary', legendary: 'anseis-edge' });
  const chFlow = simCharacter(DESC(), flowItem);
  const withDur = findRun(
    (seed) => fight(chFlow, flowItem, { seed, maxBlows: 1, standard }),
    (r) => r.trace.length > 0 && r.trace[0].strikesDamage > 0,
  );
  assert.ok(withDur, 'a landed first blow');
  const noDur = simulateFight(chFlow, {
    target: referenceFoe(30, 'tough'), health: 3000, weapon: weaponOf(flowItem), seed: withDur.seed,
    trace: true, maxBlows: 1, standard,
  });
  assert.equal(withDur.run.trace[0].blowDamage, noDur.trace[0].blowDamage, 'the broken weapon does not lose the current blow');
  assert.equal(withDur.run.trace[0].blow, noDur.trace[0].blow);
  assert.ok(withDur.run.breaks.length > 0, 'the Flow weapon broke on that blow');
  assert.equal(withDur.run.trace[0].meleeApplied, true);
});
