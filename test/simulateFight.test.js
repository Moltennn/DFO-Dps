/*
 * test/simulateFight.test.js - Stage 3.2, local contract tests for the blow-only stochastic fight.
 *
 * These are not upstream parity tests (that is test/fightDifferential.test.js). They pin:
 *   scheduling   the first melee hit is the upstream hit frame; a dual exchange is fresh lead, off, flurry lead, ...
 *   seeded fights  one seed is one deterministic fight; different seeds differ; every trial is in the seed list
 *   health state  a build whose damage changes at half health rebuilds its distribution after the crossing
 *   fight facts  kill time, damage actually dealt, overkill, remaining health and censoring are separate
 *   summary      mean/median/p10/p90/CI and paired seeds are reported
 *   exclusions   a Pistolet pair is refused rather than approximated
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, referenceFoe, weaponOf } from '../src/model.js';
import { simulateFight, createAttackSchedule, simulateFights, pairedFightSeeds, simulatePairedFights, summarize, healthSegment } from '../src/simulateFight.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';

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

test('1. single-hand scheduling: first melee hit at the upstream hit frame, then the cadence', () => {
  const { ch, item: it } = single();
  const s = createAttackSchedule(ch, { target: target(), health: 12000, weapon: weaponOf(it) });
  assert.equal(s.kind, 'single');
  const cad = analyze(ch, { target: target(), health: 12000, weapon: weaponOf(it) }).cadence;
  const first = s.next();
  const second = s.next();
  const third = s.next();
  assert.ok(near(first.t, 2 * cad.tick, 1e-12), `first hit ${first.t} vs ${2 * cad.tick}`);
  assert.ok(near(second.t - first.t, cad.seconds, 1e-12));
  assert.ok(near(third.t - second.t, cad.seconds, 1e-12));
  assert.deepEqual([first.hand, second.hand, third.hand], ['main', 'main', 'main']);
  assert.equal(s.assumptions.hitFrame, 2);
});

test('2. dual scheduling: fresh lead, off hand, then flurry lead/off in the upstream order', () => {
  const { ch, item: it } = dual();
  const s = createAttackSchedule(ch, { target: target(), health: 12000, weapon: weaponOf(it), dual: true });
  assert.equal(s.kind, 'dual');
  const probe = analyze(ch, { target: target(), health: 12000, weapon: weaponOf(it), dual: true });
  const m = probe.cadence.tick;
  const o = probe.offHand.cadence.tick;
  const offSeconds = probe.cadence.offSeconds;
  const a = s.next();
  const b = s.next();
  const c = s.next();
  const d = s.next();
  assert.ok(near(a.t, 2 * m, 1e-12), `fresh lead hit ${a.t}`);
  assert.ok(near(b.t, 5 * m + 1 * o, 1e-12), `off hit ${b.t}`);
  assert.ok(near(c.t, 5 * m + offSeconds + 1 * m, 1e-12), `flurry lead hit ${c.t}`);
  assert.ok(near(d.t, 5 * m + offSeconds + 4 * m + 1 * o, 1e-12), `second off hit ${d.t}`);
  assert.deepEqual([a.hand, b.hand, c.hand, d.hand], ['main', 'off', 'main', 'off']);
  assert.equal(a.fresh, true);
  assert.equal(b.fresh, false);
  assert.ok(near(offSeconds, s.assumptions.offSeconds, 1e-12));
  assert.ok(offSeconds >= 4 * o, 'the off hand pays its held burden');
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
  const p = simCharacter(BASIC(), { ...weapon(562, { material: 4 }), equipSlot: 19 });
  p._pair = true;
  assert.throws(() => simulateFight(p, { target: target(), health: 12000 }), /Pistolet pair/);
  const r = simulateFight(ch, { target: target(), health: 12000, weapon: weaponOf(it), seed: 1 });
  assert.equal(r.schedule.schedule, 'single');
  assert.equal(r.damageMode, 'uncapped');
  assert.equal(r.health, 12000);
  assert.equal(r.expectedPerSwing, r.damageDealt / r.blows);
  assert.ok(r.outputDps >= r.killDps);
});
