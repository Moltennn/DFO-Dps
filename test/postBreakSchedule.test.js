/*
 * test/postBreakSchedule.test.js - Stage 3.5.3a: the swing schedule after a weapon breaks.
 *
 * The oracle is the pinned game's own swing machine (test/harness/swingMachine.mjs: upstream `PlayerWeapon`,
 * `machineStep`, `followHeldHand`, `strikeHandOf`, the off hand's held burden, and `lowerCondition` breaking a hand's
 * weapon the moment its hit is reported). The local fight is run through the production `simulateFight` path with
 * `durability: true`, and every blow time after the break is compared with the machine's reported hit times.
 *
 * What the machine does (read off the traces recorded in the stage record, "Post-break schedule"):
 *   - the swing in flight is not cut. Its machine keeps stepping to its last frame (and, for an off-hand blow, through
 *     its held burden), so the next swing cannot begin before that;
 *   - every step after the break reads the tick of the hand now in use - the survivor's weapon - so the swing's
 *     remaining ticks run at the SURVIVOR's tick, not the broken weapon's;
 *   - with one weapon left the hands mode is Single: the next swing is a fresh five-tick swing, hit on frame 2.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { swingMachine } from './harness/swingMachine.mjs';
import { upstream } from './harness/upstream.mjs';
import { referenceFoe, weaponOf } from '../src/model.js';
import { createAttackSchedule, simulateFight } from '../src/simulateFight.js';

const STATS = { strength: 70, agility: 60, speed: 60, luck: 50 };
const DESC = (over = {}) => character({
  level: 30, raceId: 1, stats: { ...STATS, ...over }, skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const gear = (template, cond = 1000) => ({ ...weapon(template, { material: 9 }), maxCondition: 1000, currentCondition: cond });
const FOE = () => referenceFoe(30, 'tough');

/** A build: `main` (right hand) and an optional `off` (left hand), as `{ template, cond }`. `dual` marks a pair. */
function build({ main, off = null, dual = true, strength = STATS.strength }) {
  const mainItem = gear(main.template, main.cond ?? 1000);
  const ch = simCharacter(DESC({ strength }), mainItem);
  if (off) {
    ch.offWeapon = { ...gear(off.template, off.cond ?? 1000), equipSlot: 21 };
    ch._dual = dual;
  }
  return { ch, mainItem };
}

const fight = (ch, mainItem, opts = {}) => simulateFight(ch, {
  target: FOE(), health: 1e7, weapon: weaponOf(mainItem), durability: true, trace: true, maxBlows: 8,
  conditionRolls: () => 0.1, ...opts,
});

/** The first seed whose blow `index` (0-based) both lands and breaks its weapon. */
function breakingRun(make, index, hand, conds = [undefined], extra = {}) {
  for (const cond of conds) {
    for (let seed = 0; seed < 300; seed++) {
      const { ch, mainItem } = make(cond);
      const dual = ch._dual ? { dual: true } : {};
      // search cheaply (the blows up to the break), then rerun the winning seed long enough to compare
      const probe = fight(ch, mainItem, { seed, maxBlows: index + 1, ...dual, ...extra });
      const e = probe.trace[index];
      if (!(e?.broke && e.hand === hand) || probe.trace.slice(0, index).some((x) => x.broke)) continue;
      const again = make(cond);
      return { r: fight(again.ch, again.mainItem, { seed, ...dual, ...extra, maxBlows: Math.max(index + 5, 8) }), seed, cond };
    }
  }
  return null;
}

/** Each hit time the machine reports from the break onward, and every one before it. */
const times = (hits) => hits.map((h) => h.t);

/**
 * Compare a local trace with the machine's hits: the same count of blows, the same hand order, and each blow time within
 * `tol` seconds. Equal ticks and a frame equal to the tick make the machine exact, so `tol` is then float noise; with two
 * different ticks the machine quantises each tick to a whole frame, so `tol` is `frame x ticks elapsed` (the most that
 * quantisation can move a hit).
 */
function compare(r, oracle, { breakIdx, tol, label, relative = false }) {
  const hits = oracle.hits;
  const n = Math.min(r.trace.length, hits.length);
  assert.ok(n >= breakIdx + 4, `${label}: ${n} comparable blows`);
  const rows = [];
  // `relative` compares each blow's distance from the break hit: the pre-break pair schedule keeps its averaged held
  // burden (an existing approximation this stage does not touch), so only the transition itself is under test.
  const from = relative ? breakIdx : 0;
  const l0 = relative ? r.trace[breakIdx].t : 0;
  const m0 = relative ? hits[breakIdx].t : 0;
  for (let i = from; i < n; i++) {
    const local = r.trace[i].t - l0;
    const machine = hits[i].t - m0;
    rows.push({ i, local, machine, d: local - machine, hand: r.trace[i].hand });
  }
  return { rows, ok: rows.every((x) => Math.abs(x.d) <= tol), worst: Math.max(...rows.map((x) => Math.abs(x.d))) };
}

const EXACT = 1e-9;

test('1. the machine: with both weapons up the hands are a Dual pair, so a surviving off hand is always a pair\'s', async () => {
  const u = await upstream();
  const { PlayerWeapon } = u.playerWeapon;
  const mk = (t) => ({ group: 'Weapons', templateIndex: t, material: 9, maxCondition: 1000, currentCondition: 1000 });
  const pw = new PlayerWeapon({ liveSpeed: 60 });
  pw.updateHands(mk(121), mk(121));
  pw.applyWeapon();
  assert.equal(pw.handsMode, 'dual', 'two one-handed weapons are the pair (handsLaw.js handsModeOf)');
  const solo = new PlayerWeapon({ liveSpeed: 60 });
  solo.updateHands(mk(121), null);
  solo.applyWeapon();
  assert.equal(solo.handsMode, 'single');
  // so a local `single` schedule with an unused off weapon is a modelling shortcut (the build is analysed as one weapon),
  // not a state the game can be in; its post-break transition is the pair's lead-swing-in-flight case (test 4).
});

test('2. the machine, recorded: the in-flight swing finishes, at the survivor\'s tick, then a fresh swing', async () => {
  // Same two weapons, dt = one tick: every number below is the machine's, in ticks.
  const probe = createAttackSchedule(build({ main: { template: 121 }, off: { template: 121 } }).ch, { target: FOE(), health: 1e7, dual: true });
  const tick = probe.probe.cadence.tick;
  const main = await swingMachine({ right: 121, left: 121, stats: STATS, speed: 60, breakHand: 'R', breakHit: 1, dt: tick, hits: 4 });
  assert.deepEqual(main.hits.map((h) => Math.round(h.t / tick)), [2, 7, 12, 17], 'hit 2 breaks; swing ends at 5; fresh swing hits at 5 + 2');
  assert.deepEqual(main.hits.map((h) => h.hand), ['R', 'L', 'L', 'L']);
  assert.equal(main.hits[1].mode, 'single');
  const off = await swingMachine({ right: 121, left: 121, stats: STATS, speed: 60, breakHand: 'L', breakHit: 2, dt: tick, hits: 4 });
  // lead hit 2, ends 5; flurry off blow starts at 5 on frame 1, hits at 6, breaks; its remaining 3 ticks end at 9;
  // then the lone right hand swings fresh and hits at 9 + 2
  assert.deepEqual(off.hits.map((h) => Math.round(h.t / tick)), [2, 6, 11, 16]);
  assert.deepEqual(off.hits.map((h) => h.hand), ['R', 'L', 'R', 'R']);
  assert.equal(off.hits[2].flurry, false, 'a lone hand never flurries');
});

test('3. dual main-hand break, equal weapons: the next hit is the in-flight swing\'s end + 2 ticks, exactly', async () => {
  const make = () => build({ main: { template: 121, cond: 1 }, off: { template: 121 } });
  const found = breakingRun(make, 0, 'main');
  assert.ok(found, 'the main hand breaks on its first blow');
  const tick = found.r.schedule.mainTick;
  const oracle = await swingMachine({ right: 121, left: 121, stats: STATS, speed: 60, breakHand: 'R', breakHit: 1, dt: tick, hits: 6 });
  const c = compare(found.r, oracle, { breakIdx: 0, tol: EXACT, label: 'main break' });
  assert.ok(c.ok, JSON.stringify(c.rows.slice(0, 6)));
  assert.ok(Math.abs(found.r.trace[1].t - found.r.trace[0].t - 5 * tick) < EXACT, 'five ticks from the break hit to the next: 3 to finish + 2 to hit');
  assert.equal(found.r.trace[1].hand, 'main');
  assert.deepEqual(found.r.trace[1].equippedAfter, { main: true, off: false });
  // the breaking blow is complete: it landed its melee exactly as the unbroken blow would have
  const b = found.r.trace[0];
  assert.equal(b.broke, true);
  assert.equal(b.meleeApplied, b.blowDamage > 0, 'the current blow lands after the break');
  assert.ok(b.blowDamage > 0 && b.damage === b.blowDamage);
});

test('4. dual off-hand break, equal weapons: the next hit is the in-flight flurry blow\'s end + 2 ticks, exactly', async () => {
  const make = () => build({ main: { template: 121 }, off: { template: 121, cond: 1 } });
  const found = breakingRun(make, 1, 'off');
  assert.ok(found, 'the off hand breaks on its first blow');
  const tick = found.r.schedule.mainTick;
  const oracle = await swingMachine({ right: 121, left: 121, stats: STATS, speed: 60, breakHand: 'L', breakHit: 2, dt: tick, hits: 6 });
  const c = compare(found.r, oracle, { breakIdx: 1, tol: EXACT, label: 'off break' });
  assert.ok(c.ok, JSON.stringify(c.rows.slice(0, 6)));
  assert.ok(Math.abs(found.r.trace[2].t - found.r.trace[1].t - 5 * tick) < EXACT, 'a flurry blow has 3 ticks left after its hit, then 2 to the lone hand\'s hit');
  assert.equal(found.r.trace[2].hand, 'main');
  const b = found.r.trace[1];
  assert.equal(b.broke, true);
  assert.ok(b.blowDamage > 0 && b.damage === b.blowDamage, 'the off hand\'s breaking blow still lands');
});

test('5. a build that carries an off weapon but is scheduled as one weapon: the lead swing in flight, then the survivor', async () => {
  // `ch._dual` unset and no `dual`: the schedule is single (the off weapon never swings), the main breaks on blow 1.
  // The game cannot be in this pre-state (test 1), but the swing in flight is the same fresh lead swing the pair's main
  // hand throws first, so its machine trace is the pair's main-break trace.
  const make = () => build({ main: { template: 121, cond: 1 }, off: { template: 121 }, dual: false });
  const found = breakingRun(make, 0, 'main');
  assert.ok(found, 'the main hand breaks on its first blow');
  const tick = found.r.schedule.tick;
  const oracle = await swingMachine({ right: 121, left: 121, stats: STATS, speed: 60, breakHand: 'R', breakHit: 1, dt: tick, hits: 6 });
  // the survivor's blows after the break: hit 2 of the machine is the survivor's first, then one swing apart
  const afterLocal = found.r.trace.slice(1, 5).map((e) => e.t);
  const afterMachine = oracle.hits.slice(1, 5).map((h) => h.t);
  afterLocal.forEach((t, i) => assert.ok(Math.abs(t - afterMachine[i]) < EXACT, `blow ${i + 1} after the break: ${t} vs ${afterMachine[i]}`));
  assert.equal(found.r.trace[0].hand, 'main');
});

const MIXED = [
  ['121 main / 113 off', 121, 113],
  ['113 main / 121 off', 113, 121],
  ['124 main / 113 off', 124, 113],
];

for (const [name, mt, ot] of MIXED) {
  test(`6. different ticks (${name}): the remaining ticks of the in-flight swing run at the survivor's tick`, async () => {
    const FRAME = 1 / 50000;
    // main breaks: the survivor is the off weapon
    const mainMake = () => build({ main: { template: mt, cond: 1 }, off: { template: ot } });
    const m = breakingRun(mainMake, 0, 'main');
    assert.ok(m, 'main breaks');
    const mo = await swingMachine({ right: mt, left: ot, stats: STATS, speed: 60, breakHand: 'R', breakHit: 1, dt: FRAME, hits: 6 });
    const mc = compare(m.r, mo, { breakIdx: 0, tol: 60 * FRAME, label: `${name} main` });
    assert.ok(mc.ok, `${name} main-break: worst ${mc.worst}\n${JSON.stringify(mc.rows.slice(0, 6))}`);
    // off breaks: the survivor is the main weapon
    const offMake = () => build({ main: { template: mt }, off: { template: ot, cond: 1 } });
    const o = breakingRun(offMake, 1, 'off');
    assert.ok(o, 'off breaks');
    const oo = await swingMachine({ right: mt, left: ot, stats: STATS, speed: 60, breakHand: 'L', breakHit: 2, dt: FRAME, hits: 6 });
    const oc = compare(o.r, oo, { breakIdx: 1, tol: 60 * FRAME, label: `${name} off` });
    assert.ok(oc.ok, `${name} off-break: worst ${oc.worst}\n${JSON.stringify(oc.rows.slice(0, 6))}`);
  });
}

test('7. the off hand\'s held burden is part of the swing in flight', async () => {
  // A weak wielder owes a fraction of a tick per off blow and pays it in whole ticks (the carry), so the third off blow
  // holds one tick at its end. The machine's integer hold for the swing in flight - not the schedule's average - is what
  // a break must wait out. The off hand breaks on that third blow (the pair's sixth hit).
  const FRAME = 1 / 50000;
  const strength = 10;
  const soft = { target: referenceFoe(30, 'soft') };
  const make = (cond = 1000) => build({ main: { template: 121 }, off: { template: 120, cond }, strength });
  const sched = createAttackSchedule(make().ch, { ...soft, health: 1e7, dual: true });
  assert.ok(sched.probe.schedule.hold > 0.4 && sched.probe.schedule.hold < 0.5, `a fractional burden (${sched.probe.schedule.hold} ticks)`);
  const found = breakingRun(make, 5, 'off', [3, 4, 5, 6, 7, 8], soft);
  assert.ok(found, 'the off hand breaks on its third blow');
  const oracle = await swingMachine({ right: 121, left: 120, stats: { ...STATS, strength }, speed: 60, breakHand: 'L', breakHit: 6, dt: FRAME, hits: 10, recordHold: true });
  assert.deepEqual(oracle.holds, [0, 0, 1], 'the machine holds a whole tick only on the third off swing (0.484 x 3 = 1.45)');
  const c = compare(found.r, oracle, { breakIdx: 5, tol: 60 * FRAME, label: 'held burden', relative: true });
  assert.ok(c.ok, `worst ${c.worst}\n${JSON.stringify(c.rows.slice(0, 6))}`);
  // the held tick is paid at the survivor's tick: five ticks of the swing's tail (3 + 1 held) and the fresh swing's two
  const gap = oracle.hits[6].t - oracle.hits[5].t;
  assert.ok(gap > 6 * 0.15, `the break swing's tail plus its held tick plus the lone hand's hit frame: ${gap}`);
});

test('8. controls: with no break, durability on and off keep the same blow times, and equal the machine', async () => {
  const mk = () => build({ main: { template: 121 }, off: { template: 121 } });
  const on = fight(mk().ch, mk().mainItem, { seed: 3, dual: true, maxBlows: 4 });
  const { ch, mainItem } = mk();
  const off = simulateFight(ch, { target: FOE(), health: 1e7, weapon: weaponOf(mainItem), seed: 3, dual: true, trace: true, maxBlows: 4 });
  assert.equal(on.breaks.length, 0);
  assert.deepEqual(on.trace.map((e) => e.t), off.trace.map((e) => e.t), 'durability on = durability off');
  const tick = on.schedule.mainTick;
  const oracle = await swingMachine({ right: 121, left: 121, stats: STATS, speed: 60, dt: tick, hits: 2 });
  assert.ok(Math.abs(off.trace[0].t - oracle.hits[0].t) < EXACT);
  assert.ok(Math.abs(off.trace[1].t - oracle.hits[1].t) < EXACT);
  assert.equal(times(oracle.hits).length, 2);
});

test('9. the survivor\'s own cadence, hit frame, powers and thresholds govern every later blow', async () => {
  // The broken main is plain; the surviving off hand carries an execute power (a 25% health threshold). After the break
  // the fight's thresholds are the survivor's, and its swings follow the machine at the survivor's own tick.
  const main = { template: 124, cond: 1 };
  const make = () => {
    const b = build({ main, off: { template: 113 } });
    b.ch.offWeapon = { ...b.ch.offWeapon, rarity: 'legendary', legendary: 'night-mothers-embrace' };
    return b;
  };
  const found = breakingRun(make, 0, 'main');
  assert.ok(found, 'the plain main breaks');
  assert.ok(found.r.bounds.includes(0.25), 'the survivor\'s execute threshold is the fight\'s');
  const FRAME = 1 / 50000;
  const oracle = await swingMachine({ right: 124, left: 113, stats: STATS, speed: 60, breakHand: 'R', breakHit: 1, dt: FRAME, hits: 8 });
  const c = compare(found.r, oracle, { breakIdx: 0, tol: 60 * FRAME, label: 'survivor powers' });
  assert.ok(c.ok, `worst ${c.worst}`);
  // the survivor's own interval: five of ITS ticks, not the broken 124's
  const gap = found.r.trace[2].t - found.r.trace[1].t;
  const brokenTick = found.r.schedule.mainTick;
  const survivorTick = gap / 5;
  assert.ok(Math.abs(survivorTick - brokenTick) > 0.005, 'the survivor\'s tick is not the broken weapon\'s');
  assert.ok(Math.abs(gap - (oracle.hits[2].t - oracle.hits[1].t)) < 8 * FRAME);
});
