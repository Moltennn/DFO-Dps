/*
 * test/simulateFight.test.js - Stage 3.2, local contract tests for the blow-only stochastic fight.
 *
 * These are not upstream parity tests (that is test/fightDifferential.test.js). They pin:
 *   scheduling   the hit and end ticks are derived by STEPPING the upstream machine (melee, bow, gun and a flurry),
 *                so the expected events do not come from `analyze`; a dual exchange is fresh lead, off, lead, off
 *   seeded fights  one seed is one deterministic fight; different seeds differ; every trial is in the seed list
 *   health state  a build whose damage changes at half health rebuilds its distribution after the crossing
 *   fight facts  kill time, damage actually dealt, overkill, remaining health and censoring are separate
 *   censoring    TTK is conditional on a kill; kill probability is reported separately with a Wilson interval
 *   summary      mean/median/p10/p90/CI and paired seeds are reported
 *   exclusions   a Pistolet pair is refused rather than approximated
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, referenceFoe, weaponOf } from '../src/model.js';
import { simulateFight, createAttackSchedule, simulateFights, pairedFightSeeds, simulatePairedFights, summarize, healthSegment } from '../src/simulateFight.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { DUAL } from '../src/dualWield.js';
import { HANDS_MODE, strikeHandOf } from '../vendor/upstream/a3eb1605/src/combat/twoHands/handsLaw.js';
import {
  createWeaponMachine, machineAttack, machineStep, swingFrameSeconds, SWING_FRAME_MIN, HIT_FRAME_MELEE, HIT_FRAME_BOW,
  BOW_DRAWN_HOLD_FRAME, CLASSIC_UPDATE_INTERVAL,
} from '../vendor/upstream/a3eb1605/src/characters/weaponStates.js';

const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const target = () => referenceFoe(30, 'tough');
const item = () => weapon(121, { material: 9 });
const single = () => {
  const it = item();
  return { ch: simCharacter(BASIC(), it), item: it };
};
const dual = () => {
  const it = item();
  const ch = simCharacter(BASIC(), it);
  ch.offWeapon = { ...it, equipSlot: 21 };
  ch._dual = true;
  return { ch, item: it };
};
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
/** A card's tick from the upstream swing law, using the card's own live speed/heft/handling/pace. */
const upstreamTick = (c) => {
  const frame = swingFrameSeconds(c.speed, { heft: c.heft, handling: c.handling });
  return c.pace > 0 ? Math.max(SWING_FRAME_MIN, frame / (1 + c.pace / 100)) : frame;
};

/**
 * The upstream machine's own clock: start a strike, step it one frame at a time, and return the hit ticks and the end.
 * The schedule test compares against these offsets, so it does not derive the expected events from `analyze`.
 */
function machineClock({ bow = false, gun = false, drawn = false, tick, hold = 0, flurry = false, frames = null, hitFrame = null }) {
  const m = createWeaponMachine(bow);
  if (gun) { m.ranged = true; m.frames = { Idle: 1, StrikeDown: frames ?? 7 }; m.hitFrame = hitFrame ?? 1; }
  m.tick = tick;
  machineAttack(m, 'StrikeDown');
  if (drawn) m.frame = BOW_DRAWN_HOLD_FRAME;
  if (flurry) m.frame = DUAL.FLURRY_FROM_FRAME;
  if (hold > 0) m.hold = hold;
  const hits = [];
  let ticks = 0;
  while (m.state !== 'Idle' && ticks < 100) {
    const events = machineStep(m, tick, 50);
    ticks += 1;
    if (events.includes('hit')) hits.push(ticks);
  }
  return { hits, end: ticks, state: m.state };
}

test('1. single-hand scheduling: the upstream machine clock, then the cadence', () => {
  const { ch, item: it } = single();
  const args = { target: target(), health: 12000, weapon: weaponOf(it) };
  const s = createAttackSchedule(ch, args);
  assert.equal(s.kind, 'single');
  const cad = analyze(ch, args).cadence;
  const clock = machineClock({ tick: cad.tick });
  assert.deepEqual(clock.hits, [HIT_FRAME_MELEE], 'the machine lands on the melee hit frame');
  assert.equal(clock.end, 5, 'a melee strike is five frames');
  assert.ok(near(cad.tick, upstreamTick(cad), 1e-12), 'the tick is the upstream swing law');
  assert.ok(near(cad.seconds, clock.end * cad.tick, 1e-12), 'the model interval is the machine five-tick swing');
  const first = s.next();
  const second = s.next();
  const third = s.next();
  assert.ok(near(first.t, clock.hits[0] * cad.tick, 1e-12), `first hit ${first.t}`);
  assert.ok(near(second.t - first.t, cad.seconds, 1e-12));
  assert.ok(near(third.t - second.t, cad.seconds, 1e-12));
  assert.deepEqual([first.hand, second.hand, third.hand], ['main', 'main', 'main']);
  assert.equal(s.assumptions.hitFrame, clock.hits[0]);
});

test('2. dual scheduling: machine-derived fresh lead, off blow and flurry order', () => {
  const { ch, item: it } = dual();
  const args = { target: target(), health: 12000, weapon: weaponOf(it), dual: true };
  const s = createAttackSchedule(ch, args);
  assert.equal(s.kind, 'dual');
  const probe = analyze(ch, args);
  const m = probe.cadence.tick;
  const o = probe.offHand.cadence.tick;
  assert.ok(near(m, upstreamTick(probe.cadence), 1e-12));
  assert.ok(near(o, upstreamTick(probe.offHand.cadence), 1e-12));
  const lead = machineClock({ tick: m });
  const flurry = machineClock({ tick: m, flurry: true });
  const off = machineClock({ tick: o, flurry: true });
  // the base four ticks come from the machine; the held burden is analyze's own averaged hold (A13)
  const hold = probe.schedule.hold;
  assert.deepEqual(lead.hits, [HIT_FRAME_MELEE]);
  assert.equal(lead.end, 5);
  assert.deepEqual(off.hits, [1], 'a flurry starts on frame 1 and lands one tick in');
  assert.deepEqual(flurry.hits, [1]);
  assert.equal(flurry.end, 4);
  assert.equal(off.end, 4, 'a flurry blows four ticks');
  const leadEnd = lead.end * m;
  const offEnd = (off.end + hold) * o;
  const a = s.next();
  const b = s.next();
  const c = s.next();
  const d = s.next();
  assert.ok(near(a.t, lead.hits[0] * m, 1e-12), `fresh lead hit ${a.t}`);
  assert.ok(near(b.t, leadEnd + off.hits[0] * o, 1e-12), `off hit ${b.t}`);
  assert.ok(near(c.t, leadEnd + offEnd + flurry.hits[0] * m, 1e-12), `flurry lead hit ${c.t}`);
  assert.ok(near(d.t, leadEnd + offEnd + flurry.end * m + off.hits[0] * o, 1e-12), `second off hit ${d.t}`);
  assert.deepEqual([a.hand, b.hand, c.hand, d.hand], ['main', 'off', 'main', 'off']);
  // the same order from the game's own hand law: a held button starts the next strike at the last one's end
  const order = [];
  let last = null;
  for (let i = 0; i < 4; i++) {
    const strike = strikeHandOf({ mode: HANDS_MODE.Dual, lead: 'R', last, sinceLast: last ? 0 : Infinity });
    order.push(strike.off ? 'off' : 'main');
    last = strike.hand;
  }
  assert.deepEqual(order, ['main', 'off', 'main', 'off']);
  assert.equal(a.fresh, true);
  assert.equal(b.fresh, false);
  assert.ok(near(probe.cadence.offSeconds, offEnd, 1e-12));
  assert.ok(near(s.assumptions.offHandHoldTicks, hold, 1e-12));
  assert.ok(probe.cadence.offSeconds >= 4 * o, 'the off hand pays its held burden');
});

test('2b. ranged first hit: the bow loose and the gun frame 1, from the machine clock', () => {
  const bowItem = weapon(130, { material: 9 });
  const bowCh = simCharacter(BASIC(), bowItem);
  const bowArgs = { target: target(), health: 12000, weapon: weaponOf(bowItem) };
  const bow = createAttackSchedule(bowCh, bowArgs);
  const drawn = machineClock({ bow: true, drawn: true, tick: CLASSIC_UPDATE_INTERVAL });
  assert.equal(bow.assumptions.bow, true);
  assert.deepEqual(drawn.hits, [HIT_FRAME_BOW - BOW_DRAWN_HOLD_FRAME]);
  assert.equal(bow.assumptions.hitFrame, drawn.hits[0]);
  assert.ok(near(bow.assumptions.firstHit, drawn.hits[0] * CLASSIC_UPDATE_INTERVAL, 1e-12));
  assert.ok(near(bow.next().t, bow.assumptions.firstHit, 1e-12));

  const full = createAttackSchedule(bowCh, { ...bowArgs, bowDrawback: true });
  const fullClock = machineClock({ bow: true, tick: CLASSIC_UPDATE_INTERVAL });
  assert.deepEqual(fullClock.hits, [HIT_FRAME_BOW]);
  assert.equal(full.assumptions.hitFrame, fullClock.hits[0]);
  assert.ok(near(full.assumptions.firstHit, HIT_FRAME_BOW * CLASSIC_UPDATE_INTERVAL, 1e-12));

  const gunItem = weapon(560, { material: 9 });
  const gun = createAttackSchedule(simCharacter(BASIC(), gunItem), { target: target(), health: 12000, weapon: weaponOf(gunItem) });
  const gunClock = machineClock({ gun: true, tick: 1 / 14, frames: 7, hitFrame: 1 });
  assert.equal(gun.assumptions.gun, true);
  assert.deepEqual(gunClock.hits, [1]);
  assert.equal(gun.assumptions.hitFrame, 1);
  assert.ok(near(gun.assumptions.firstHit, 1 / 14, 1e-12));
});

test('3. a seed reproduces one fight exactly; a different seed differs; trials use the given list', () => {
  const { ch, item: it } = single();
  const args = { target: target(), health: 12000, weapon: weaponOf(it) };
  const a = simulateFight(ch, { ...args, seed: 4242 });
  const b = simulateFight(ch, { ...args, seed: 4242 });
  const c = simulateFight(ch, { ...args, seed: 4243 });
  const strip = ({ with: _with, ...rest }) => rest;
  assert.deepEqual(strip(a), strip(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
  assert.equal(a.seed, 4242);
  assert.equal(a.trace, null);
  const trial = simulateFight(ch, { ...args, seed: 4242, trace: true });
  assert.ok(Array.isArray(trial.trace) && trial.trace.length > 0);
  assert.equal(trial.ttk, a.ttk, 'tracing does not change the draw sequence');
  assert.equal(trial.damageDealt, a.damageDealt);
  const seeds = [1, 2, 3, 4, 5];
  const many = simulateFights(ch, { ...args, seeds, trace: false });
  assert.equal(many.trials, 5);
  assert.deepEqual(many.seeds, seeds);
  assert.equal(many.rows.length, 5);
  assert.deepEqual(many.rows.map((r) => r.seed), seeds);
});

test('4. health-dependent distributions rebuild after a threshold, and the fight reports state separately', () => {
  // an axe has the half-health mastery, so the distribution changes at share 0.5
  const axe = weapon(127, { material: 9 });
  const ch = simCharacter(character({
    level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 }, skills: 0,
    skillOverride: { 31: 90, 34: 40 },
  }), axe);
  const r = simulateFight(ch, { target: target(), health: 2000, weapon: weaponOf(axe), seed: 77, trace: true, maxSeconds: 200 });
  assert.ok(r);
  assert.equal(r.segments.length, 2, `segments ${JSON.stringify(r.segments)}`);
  assert.equal(r.bounds.includes(0.5), true);
  const shares = r.trace.map((e) => e.share);
  assert.ok(shares.some((s) => s > 0.5) && shares.some((s) => s <= 0.5), 'the fight crosses half');
  assert.ok(r.damageDealt >= r.health || !r.kill, 'a kill has dealt at least the pool');
  if (r.kill) {
    assert.ok(r.overkill >= 0);
    assert.equal(r.ttk, r.trace[r.trace.length - 1].t);
    assert.equal(r.remainingHealth, 0);
  } else {
    assert.equal(r.ttk, null);
    assert.ok(r.remainingHealth > 0);
    assert.equal(r.overkill, 0);
  }
  // a short horizon leaves a censored fight: no kill, positive remaining health
  const censored = simulateFight(ch, { target: target(), health: 2000, weapon: weaponOf(axe), seed: 77, maxSeconds: 0.1 });
  assert.equal(censored.kill, false);
  assert.equal(censored.ttk, null);
  assert.ok(censored.remainingHealth > 0);
  assert.ok(censored.time <= 0.1 + 1e-12);
});

test('5. aggregate metrics and paired seeds: sample count, quantiles, uncertainty and common seeds', () => {
  const { ch, item: it } = single();
  const args = { target: target(), health: 12000, weapon: weaponOf(it), trials: 300 };
  const r = simulateFights(ch, { ...args, seed: 9001 });
  assert.equal(r.trials, 300);
  assert.equal(r.seeds.length, 300);
  assert.equal(r.rows.length, 300);
  assert.equal(r.kills + r.censored, 300);
  assert.ok(r.ttk.n > 0 && r.ttk.n <= 300);
  for (const key of ['mean', 'sd', 'se', 'ci95', 'median', 'p10', 'p90', 'min', 'max']) assert.ok(Number.isFinite(r.ttk[key]), key);
  assert.ok(r.ttk.p10 <= r.ttk.median && r.ttk.median <= r.ttk.p90);
  assert.ok(r.damageDealt.n === 300 && r.overkill.n === 300 && r.blows.n === 300);
  assert.ok(Number.isFinite(r.damageDealt.mean) && Number.isFinite(r.outputDps.mean));
  // TTK is conditional on a kill; kill probability is reported separately, with a Wilson interval
  assert.equal(r.ttkConditional, r.ttk);
  assert.equal(r.killProbability.n, 300);
  assert.equal(r.killProbability.p, r.kills / 300);
  assert.ok(r.killProbability.lo >= 0 && r.killProbability.lo <= r.killProbability.p);
  assert.ok(r.killProbability.p <= r.killProbability.hi && r.killProbability.hi <= 1);
  assert.equal(r.horizonSeconds, 3600);
  assert.equal(r.damageMode, 'uncapped');
  // paired seeds are deterministic and shared between builds
  const seeds = pairedFightSeeds(50, 123);
  assert.deepEqual(seeds, pairedFightSeeds(50, 123));
  assert.equal(new Set(seeds).size, seeds.length);
  const paired = simulatePairedFights([{ id: 'a', ch }, { id: 'b', ch }], { ...args, seeds });
  assert.deepEqual(paired.seeds, seeds);
  assert.equal(paired.rows.length, 2);
  assert.deepEqual(paired.rows[0].result.seeds, paired.rows[1].result.seeds);
  assert.deepEqual(paired.rows[0].result.rows.map((x) => x.seed), paired.rows[1].result.rows.map((x) => x.seed));
  // the summary function is the one used by both paths
  assert.equal(summarize([1, 2, 3]).median, 2);
  assert.equal(summarize([]), null);
});

test('5b. censoring is reported as kill probability, not folded into the conditional TTK', () => {
  const { ch, item: it } = single();
  const args = { target: target(), health: 12000, weapon: weaponOf(it), trials: 20, maxSeconds: 2 };
  const r = simulateFights(ch, { ...args, seed: 3 });
  assert.equal(r.kills, 0);
  assert.equal(r.censored, 20);
  assert.equal(r.ttk, null);
  assert.equal(r.ttkConditional, null);
  assert.equal(r.killProbability.p, 0);
  assert.equal(r.killProbability.lo, 0);
  assert.ok(r.killProbability.hi > 0 && r.killProbability.hi < 1);
  assert.equal(r.horizonSeconds, 2);
  assert.ok(r.outputDps.mean > 0, 'a censored fight still has a damage rate over its observed time');
  assert.ok(r.remainingHealth.mean > 0);
});

test('6. health segments: a share exactly on a threshold takes the not-below side', () => {
  const bounds = [1, 0.5, 0];
  assert.equal(healthSegment(bounds, 1), 0);
  assert.equal(healthSegment(bounds, 0.75), 0);
  // at exactly 0.5 upstream reads axe OFF, blunt ON, venom/execute OFF: the not-below side
  assert.equal(healthSegment(bounds, 0.5), 0);
  assert.equal(healthSegment(bounds, 0.4999), 1);
  assert.equal(healthSegment(bounds, 0), 1);
});

test('7. capped mode samples the capped blow and the two metrics stay separate', () => {
  const { ch, item } = single();
  const target = { ...referenceFoe(30, 'tough'), hitCap: 5 };
  const base = { target, health: 100, weapon: weaponOf(item), seed: 11, trace: true, maxSeconds: 600 };
  const capped = simulateFight(ch, { ...base, damageMode: 'capped' });
  assert.equal(capped.damageMode, 'capped');
  assert.ok(capped.trace.length > 10);
  assert.ok(capped.trace.every((e) => e.damage <= 5 && e.cappedDamage <= 5));
  const uncapped = simulateFight(ch, base);
  assert.equal(uncapped.damageMode, 'uncapped');
  assert.ok(uncapped.trace.some((e) => e.damage > 5), 'an uncapped blow can exceed the cap');
  assert.ok(uncapped.damageDealt > capped.damageDealt);
});

test('8. exclusions and explicit assumptions: a Pistolet pair is refused, and the schedule is named', () => {
  const { ch, item: it } = single();
  assert.throws(() => simulateFight(ch, { pair: true, target: target(), health: 12000, weapon: weaponOf(it) }), /Pistolet pair/);
  assert.throws(() => simulateFight(ch, { target: target(), health: 12000, weapon: weaponOf(it), seed: 1.5 }), /safe integer/);
  const fists = simCharacter(BASIC(), null);
  assert.throws(() => simulateFight(fists, { target: target(), health: 12000 }), /fist scheduling/);
  const p = simCharacter(BASIC(), { ...weapon(562, { material: 4 }), equipSlot: 19 });
  p._pair = true;
  assert.throws(() => simulateFight(p, { target: target(), health: 12000 }), /Pistolet pair/);
  // an off hand analyze cannot exchange (a two-handed weapon) is a single-weapon fight, not an alternating one
  const bad = dual();
  bad.ch.offWeapon = { ...weapon(123, { material: 9 }), equipSlot: 21 };
  const singleCard = createAttackSchedule(bad.ch, { target: target(), health: 12000, weapon: weaponOf(bad.item), dual: true });
  assert.equal(singleCard.kind, 'single');
  assert.equal(singleCard.next().hand, 'main');
  const r = simulateFight(ch, { target: target(), health: 12000, weapon: weaponOf(it), seed: 1 });
  assert.equal(r.schedule.schedule, 'single');
  assert.equal(r.damageMode, 'uncapped');
  assert.equal(r.health, 12000);
  assert.equal(r.expectedPerSwing, r.damageDealt / r.blows);
  assert.ok(r.outputDps >= r.killDps);
  assert.equal(r.overkill, r.damageDealt - r.health);
  assert.equal(r.killDps, r.health / r.ttk);
  assert.equal(r.outputDps, r.damageDealt / r.ttk);
});
