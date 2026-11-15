/*
 * test/relayClaimFight.test.js - Stage 3.3, seeded blow-only relay fights.
 *
 * The claim engine is verified claim for claim against upstream in test/relayClaimDifferential.test.js. Here the
 * integration is pinned: Stage 3.2's schedule/tier supplies the claims, a miss is not a claim, the relay's own cap is
 * the first cap on the sampled blow, health-dependent segments follow the relay's remaining share, and every traced
 * claim equals the vendored relay fed the same `{t, damage}` stream.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { gateTarget, weaponOf } from '../src/model.js';
import { simulateRelayFight, simulateRelayFights } from '../src/relayFight.js';
import { relayStream } from './harness/relay.mjs';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';

const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const sword = () => weapon(121, { material: 9 });
const build = (desc = BASIC(), item = sword()) => simCharacter(desc, item);
const near = (a, b, eps = 1e-7) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const strip = ({ with: _with, ...rest }) => rest;

test('1. a seeded relay fight: every traced claim matches the vendored relay', async () => {
  const item = sword();
  const ch = build(BASIC(), item);
  const target = gateTarget(45, { health: 2000 });
  const r = simulateRelayFight(ch, { target, health: 2000, weapon: weaponOf(item), seed: 7, trace: true });
  assert.ok(r && r.kill);
  assert.equal(r.trace.length, r.claims);
  assert.ok(r.attacks >= r.claims);
  assert.ok(near(r.damageDealt, 2000));
  assert.equal(r.overkill, r.healthClip);
  assert.ok(near(r.clipped, r.capClip + r.bucketClip + r.healthClip));
  assert.ok(near(r.damageDealt + r.clipped + r.refusedDamage, r.offered));
  // the oracle gets the same claim stream, not a local damage or result
  const up = await relayStream({
    level: 45,
    share: 2000,
    claims: r.trace.map((x) => ({ t: x.t, d: x.claim })),
  });
  assert.equal(up.rows.length, r.trace.length);
  for (let i = 0; i < r.trace.length; i++) {
    const a = r.trace[i];
    const b = up.rows[i];
    assert.ok(near(a.got, b.got), `claim ${i}: got ${a.got} vs ${b.got}`);
    assert.ok(near(a.bucket, b.bucketAfter), `claim ${i}: bucket ${a.bucket} vs ${b.bucketAfter}`);
    assert.ok(near(a.tokens, b.tokensAfter), `claim ${i}: tokens ${a.tokens} vs ${b.tokensAfter}`);
    assert.ok(near(a.hp, b.hpAfter), `claim ${i}: hp ${a.hp} vs ${b.hpAfter}`);
  }
  assert.ok(near(r.ttk, r.trace[r.trace.length - 1].t));
  assert.equal(r.time, r.ttk);
  assert.equal(r.remainingHealth, 0);
});

test('2. saturation: a build over the refill is limited by the bucket, and the excess is clipped', () => {
  const desc = character({
    level: 30, raceId: 1, stats: { strength: 100, agility: 70, speed: 70, luck: 50 },
    skills: 0, skillOverride: { 29: 150, 34: 80, 19: 50 },
  });
  const item = weapon(123, { material: 9 });
  const ch = simCharacter(desc, item);
  const target = gateTarget(1, { health: 500 }); // ref 6: depth 90, rate 18, cap 72
  const r = simulateRelayFight(ch, { target, health: 500, weapon: weaponOf(item), seed: 7 });
  assert.ok(r.kill);
  assert.equal(r.saturated, true);
  assert.ok(r.dryAt > 0);
  assert.ok(r.bucketClip > 0);
  assert.ok(r.clipped > r.overkill);
  assert.ok(near(r.damageDealt, 500)); // the relay never deals past the pool; the killing claim's excess is healthClip
  assert.ok(r.bucket >= 0 && r.bucket <= r.law.depth);
  assert.ok(r.tokens >= 0 && r.tokens <= r.law.hitHz);
  assert.ok(r.clipped >= r.overkill);
});

test('3. deterministic replay, fixed seeds and the trial distribution', () => {
  const item = sword();
  const ch = build();
  const target = gateTarget(45, { health: 2000 });
  const args = { target, health: 2000, weapon: weaponOf(item), seed: 11 };
  assert.deepEqual(strip(simulateRelayFight(ch, args)), strip(simulateRelayFight(ch, args)));
  assert.throws(() => simulateRelayFight(ch, { ...args, seed: 1.5 }), /safe integer/);
  const seeds = [1, 2, 3, 4, 5];
  const many = simulateRelayFights(ch, { ...args, seeds });
  assert.equal(many.trials, 5);
  assert.deepEqual(many.seeds, seeds);
  assert.equal(many.kills, 5);
  assert.equal(many.killProbability.p, 1);
  assert.equal(many.ttkConditional, many.ttk);
  assert.ok(many.ttk.n === 5 && Number.isFinite(many.ttk.mean));
  assert.ok(many.damageDealt.mean > 0 && many.accepted.mean > 0);
  assert.equal(many.rows.length, 5);
  assert.deepEqual(many.rows.map((x) => x.seed), seeds);
});

test('4. guards: fists and a Many Endings build are refused, not approximated', () => {
  const target = gateTarget(45, { health: 2000 });
  const fists = simCharacter(BASIC(), null);
  assert.throws(() => simulateRelayFight(fists, { target, health: 2000 }), /fist scheduling/);
  const echoItem = { ...sword(), rarity: 'rare', imprint: 'warp-edge' };
  const echoCh = simCharacter(BASIC(), echoItem);
  assert.throws(() => simulateRelayFight(echoCh, { target, health: 2000, weapon: weaponOf(echoItem) }), /Many Endings/);
  // a non-relay target is not a relay fight
  assert.equal(simulateRelayFight(build(), { target: { level: 1, maxHealth: 100 }, health: 100, weapon: weaponOf(sword()) }), null);
});

test('5. a fixed shield and a wounded-boss join change the claim state, not the law', () => {
  const item = sword();
  const ch = build();
  const target = gateTarget(45, { health: 2000 });
  const before = simulateRelayFight(ch, { target, health: 2000, weapon: weaponOf(item), seed: 3 });
  const shielded = simulateRelayFight(ch, { target, health: 2000, weapon: weaponOf(item), seed: 3, shieldUntil: 0.5 });
  const wounded = simulateRelayFight(ch, { target, health: 2000, weapon: weaponOf(item), seed: 3, fresh: false });
  assert.ok(before.attacks > 0 && before.kill);
  assert.ok(shielded.shielded > 0, 'the first claims are refused by the shield');
  assert.ok(shielded.bucketClip >= 0);
  assert.ok(wounded.noToken >= 0);
  assert.ok(wounded.bucket <= before.bucket + 1e-9 || wounded.kill);
});

test('6. a group fight uses one player\'s share as the relay pool', () => {
  const item = sword();
  const ch = build();
  const target = gateTarget(45, { health: 4000, players: 2 });
  const r = simulateRelayFight(ch, { target, health: 8000, weapon: weaponOf(item), seed: 9 });
  assert.ok(r && r.kill);
  assert.equal(r.health, 4000, 'health / players');
  assert.ok(near(r.damageDealt, 4000));
  assert.equal(r.law.share, 4000);
  assert.ok(r.claims > 0);
});

test('7. a dual-wield relay fight claims both hands through the same engine', () => {
  const item = sword();
  const ch = build();
  ch.offWeapon = { ...item, equipSlot: 21 };
  ch._dual = true;
  const target = gateTarget(45, { health: 2000 });
  const r = simulateRelayFight(ch, { target, health: 2000, weapon: weaponOf(item), dual: true, seed: 13, trace: true });
  assert.ok(r && r.kill);
  assert.ok(r.claims > 0);
  assert.ok(r.trace.some((x) => x.hand === 'off'), 'the off hand made claims');
  assert.ok(r.trace.some((x) => x.hand === 'main'), 'the lead hand made claims');
  assert.ok(near(r.damageDealt, 2000));
});

test('8. elapsed time: a kill, the horizon and the blow budget are different clocks', () => {
  const item = sword();
  const ch = build();
  const target = gateTarget(45, { health: 2000 });
  const base = { target, health: 2000, weapon: weaponOf(item) };

  // no positive claim: the first attack is a miss and the blow budget stops the fight at that attack
  let none = null;
  for (let seed = 1; seed <= 500 && !none; seed++) {
    const r = simulateRelayFight(ch, { ...base, seed, maxSeconds: 2, maxBlows: 1 });
    if (r.claims === 0) none = { seed, r };
  }
  assert.ok(none, 'found a first-attack miss');
  assert.equal(none.r.kill, false);
  assert.equal(none.r.claims, 0);
  assert.equal(none.r.attacks, 1);
  assert.equal(none.r.claimTime, 0, 'the claim engine saw no claim');
  assert.equal(none.r.termination, 'maxBlows');
  assert.equal(none.r.time, none.r.lastAttackAt);
  assert.ok(none.r.time > 0 && none.r.time < 2, `time ${none.r.time} is the attack, not the horizon`);
  assert.equal(none.r.outputDps, 0);
  assert.equal(none.r.ttk, null);
  assert.equal(none.r.killDps, null);
  assert.equal(none.r.censored, true);
  assert.equal(none.r.censoredAt, none.r.time);

  // a trailing miss inside the horizon: elapsed is the horizon, not the last claim
  let trail = null;
  for (let seed = 1; seed <= 500 && !trail; seed++) {
    const r = simulateRelayFight(ch, { ...base, seed, maxSeconds: 2, maxBlows: 100 });
    if (!r.kill && r.claims > 0 && r.claimTime < r.lastAttackAt) trail = { seed, r };
  }
  assert.ok(trail, 'found a fight with a trailing miss');
  assert.equal(trail.r.termination, 'horizon');
  assert.equal(trail.r.time, 2);
  assert.ok(trail.r.claimTime < trail.r.lastAttackAt && trail.r.lastAttackAt < trail.r.time);
  assert.ok(trail.r.attacks > trail.r.claims, 'the last attack is a miss');
  assert.ok(near(trail.r.outputDps, trail.r.damageDealt / 2), 'DPS uses the horizon, not the last claim');
  assert.ok(trail.r.outputDps < trail.r.damageDealt / trail.r.claimTime);

  // the same seed with a two-attack budget stops at the second attack, not at 3600 s
  const early = simulateRelayFight(ch, { ...base, seed: trail.seed, maxSeconds: 3600, maxBlows: 2 });
  assert.equal(early.kill, false);
  assert.equal(early.termination, 'maxBlows');
  assert.equal(early.time, early.lastAttackAt);
  assert.ok(early.time < 3600);
  assert.ok(near(early.outputDps, early.damageDealt / early.time));
  assert.ok(early.outputDps > trail.r.outputDps, 'the same damage over the shorter observed fight');

  // a kill: elapsed is the killing claim, and the relay never deals past the pool
  let kill = null;
  for (let seed = 1; seed <= 100 && !kill; seed++) {
    const r = simulateRelayFight(ch, { ...base, health: 500, seed, maxSeconds: 3600 });
    if (r.kill) kill = r;
  }
  assert.ok(kill);
  assert.equal(kill.termination, 'kill');
  assert.equal(kill.time, kill.ttk);
  assert.equal(kill.claimTime, kill.ttk);
  assert.equal(kill.lastAttackAt, kill.ttk);
  assert.equal(kill.censored, false);
  assert.equal(kill.censoredAt, null);
  assert.ok(near(kill.damageDealt, 500));
  assert.ok(near(kill.outputDps, kill.killDps));
});

test('9. trial aggregation: output DPS over every trial, conditional TTK over kills', () => {
  const item = sword();
  const ch = build();
  const target = gateTarget(45, { health: 2000 });
  const seeds = Array.from({ length: 20 }, (_, i) => i + 1);
  const censored = simulateRelayFights(ch, {
    target, health: 2000, weapon: weaponOf(item), seeds, maxSeconds: 2, maxBlows: 100,
  });
  assert.equal(censored.kills, 0);
  assert.equal(censored.censored, 20);
  assert.equal(censored.killProbability.p, 0);
  assert.equal(censored.ttk, null);
  assert.equal(censored.ttkConditional, null);
  assert.equal(censored.killDps, null);
  assert.equal(censored.time.mean, 2);
  assert.equal(censored.terminations.horizon, 20);
  assert.equal(censored.outputDps.n, 20, 'censored trials still have an output rate');
  assert.ok(censored.outputDps.mean > 0);

  const killed = simulateRelayFights(ch, {
    target, health: 2000, weapon: weaponOf(item), seeds, maxSeconds: 3600,
  });
  assert.equal(killed.kills, 20);
  assert.equal(killed.killProbability.p, 1);
  assert.equal(killed.terminations.kill, 20);
  assert.equal(killed.ttk.n, 20);
  assert.equal(killed.outputDps.n, 20);
  assert.ok(killed.ttk.mean > 0);
  for (const row of killed.rows) assert.ok(near(row.outputDps, row.killDps));
});
