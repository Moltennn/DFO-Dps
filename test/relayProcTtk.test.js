/*
 * test/relayProcTtk.test.js - Stage 3.7g: the proc build's TTK distribution against the upstream compositor, and the
 * proc-vs-no-proc ordering.
 *
 * The oracle is the vendored compositor (`test/harness/relayFightOracle.mjs`): calculateAttackDamage with the CWS
 * `enchantCtx` (vendored `effects.applySpell`), the seeded Flow/echo path, the vendored `tickActiveEffects` for the
 * rounds, and `gateBrain.applyHit` for every claim. The local side is `simulateRelayFight` sampling its own seeded
 * draws over the SAME attack schedule; the two use different streams, so the per-fight numbers differ and the MEAN is
 * the metric (the precedent: `test/relayFight.test.js`'s 120 seeded upstream fights within 1%).
 *
 * The build is a Cast When Strikes row carrying a Continuous Damage spell: its procs and rounds are claims of their own
 * (`full:scenes/gate/standInSpell.js:198-217`, `:131-151`), which is what 3.7d added to the relay fight.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { gateTarget, weaponOf } from '../src/model.js';
import { createAttackSchedule } from '../src/simulateFight.js';
import { simulateRelayFight } from '../src/relayFight.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { upstream } from './harness/upstream.mjs';
import { oracleEntity, upstreamBody } from './harness/upstreamBodies.mjs';
import { oracleItem } from './harness/fightOracle.mjs';
import { upstreamRelayEvents } from './harness/relayFightOracle.mjs';

const BASIC = () => character({
  level: 45, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const sword = (params = []) => {
  const it = weapon(121, { material: 9 });
  if (params.length) it.enchantments = params.map((param) => ({ type: 2, param }));
  return it;
};
const spell = ({ index = 1, mag = 40, rounds = 6, direct = 30 } = {}) => ({
  name: `Relay ${index}`, index, element: 4, rangeType: 1,
  effects: [
    {
      type: 1, subType: 0,
      magnitudeBaseLow: mag, magnitudeBaseHigh: mag,
      magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
      durationBase: rounds, durationMod: 0, durationPerLevel: 1,
      chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
    },
    ...(direct > 0 ? [{
      type: 4, subType: 0,
      magnitudeBaseLow: direct, magnitudeBaseHigh: direct,
      magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
      durationBase: 0, durationMod: 0, durationPerLevel: 1,
      chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
    }] : []),
  ],
});
const scripted = (values, fallback = 0.5) => {
  let i = 0;
  const fn = () => { const v = i < values.length ? values[i] : fallback; i += 1; return v; };
  fn.used = () => i;
  return fn;
};
const roundDraws = (n, seed = 0) => Array.from({ length: n * 3 }, (_, i) => ((seed + i * 37) % 97) / 97);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** The attack schedule's events up to `horizon`, the same list both sides fight. */
function eventsOf(ch, item, { target, health, horizon = 600 }) {
  const schedule = createAttackSchedule(ch, { target, health, weapon: weaponOf(item) });
  const events = [];
  for (let i = 0; i < 5000; i += 1) {
    const ev = schedule.next();
    if (!ev || ev.t > horizon) break;
    events.push({ t: ev.t, hand: ev.hand ?? 'main' });
  }
  return events;
}

/** The oracle's kill time: the first claim that brings its pool to 0. */
const killTimeOf = (up) => {
  const i = up.claims.findIndex((c) => c.hp <= 0);
  return i < 0 ? null : up.claims[i].t;
};

test('3.7g: the proc build\'s mean TTK is within 1% of the upstream compositor\'s seeded fights', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const item = sword([1]);
  const standard = new Map([[1, spell()]]);
  const ch = simCharacter(BASIC(), item);
  const level = 45;
  const pool = 12000;
  const seeds = Array.from({ length: 24 }, (_, i) => 0x3700 + i * 7);
  const localTimes = [];
  const upTimes = [];
  for (const seed of seeds) {
    const target = gateTarget(level, { health: pool });
    const upBody = oracleEntity(body);
    upBody.activeEffects = [];
    const local = simulateRelayFight(ch, {
      target, health: pool, weapon: weaponOf(item), seed, standard, maxSeconds: 600,
    });
    const events = eventsOf(ch, item, { target, health: pool });
    const up = await upstreamRelayEvents(u, {
      desc: BASIC(), item: oracleItem(item), body: upBody, level, pool, events, seed, standard,
      cwsRolls: scripted(roundDraws(400)), maxSeconds: 600,
    });
    assert.equal(local.kill, true, `seed ${seed}: the local proc fight kills`);
    const upKill = killTimeOf(up);
    assert.ok(upKill !== null, `seed ${seed}: the oracle proc fight kills`);
    localTimes.push(local.ttk);
    upTimes.push(upKill);
  }
  const lMean = mean(localTimes);
  const uMean = mean(upTimes);
  const rel = lMean / uMean - 1;
  assert.equal(localTimes.length, seeds.length);
  // A mean TTK is the metric (rule 7): the two samplers use different streams, so only their means are comparable.
  // Measured on this fixed seed list: local mean 297.95 s (95% CI +/-3.20 s) against the oracle's 298.94 s (+/-1.37 s),
  // bias -0.33%. The 1% bound is about 2.2x the oracle CI and about 0.6x the LOCAL CI, and the seeds are fixed, so the
  // test is deterministic and catches only a gross composition error of roughly 1.5% or more.
  assert.ok(Math.abs(rel) < 0.01, `proc TTK mean ${lMean.toFixed(3)} s vs upstream ${uMean.toFixed(3)} s (bias ${(rel * 100).toFixed(2)}%)`);
});

test('3.7g: a proc build kills faster than the same build without its procs, on a body that does not cap it', () => {
  const item = sword([1]);
  const plain = sword();
  const standard = new Map([[1, spell()]]);
  const ch = simCharacter(BASIC(), item);
  const chPlain = simCharacter(BASIC(), plain);
  const level = 45;
  const pool = 8000;
  const seeds = Array.from({ length: 24 }, (_, i) => 0x3800 + i * 13);
  const withProcs = [];
  const without = [];
  for (const seed of seeds) {
    const a = simulateRelayFight(ch, { target: gateTarget(level, { health: pool }), health: pool, weapon: weaponOf(item), seed, standard, maxSeconds: 600 });
    const b = simulateRelayFight(chPlain, { target: gateTarget(level, { health: pool }), health: pool, weapon: weaponOf(plain), seed, maxSeconds: 600 });
    assert.equal(a.kill, true);
    assert.equal(b.kill, true);
    withProcs.push(a.ttk);
    without.push(b.ttk);
  }
  const a = mean(withProcs);
  const b = mean(without);
  assert.ok(a < b, `the proc build kills faster: ${a.toFixed(2)} s vs ${b.toFixed(2)} s`);
  // The gap is the proc share, and the body's cap (600 a claim) is above every claim here: no clipping confuses it.
  assert.ok(b / a - 1 > 0.05, `a real share: ${((b / a - 1) * 100).toFixed(1)}%`);
});
