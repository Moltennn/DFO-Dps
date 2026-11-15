/*
 * test/relayClaimFight.test.js - Stage 3.3/3.4, seeded blow-only relay fights.
 *
 * The claim engine is verified claim for claim against upstream in test/relayClaimDifferential.test.js. Here the
 * integration is pinned: Stage 3.2's schedule/tier supplies the claims; a positive formula blow is a claim (a Potent Vs
 * miss included) and zero damage is not; the relay's own cap is the first cap on the sampled blow; health-dependent
 * segments follow the relay's remaining share; Flow and one Many Endings power feed the same claim; and every traced
 * claim equals the vendored relay fed the same `{t, damage}` stream.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { gateTarget, weaponOf } from '../src/model.js';
import { createAttackSchedule } from '../src/simulateFight.js';
import { simulateRelayFight, simulateRelayFights } from '../src/relayFight.js';
import { createFlowState } from '../src/flowState.js';
import { createRelayClaimEngine } from '../src/relayClaim.js';
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
  assert.ok(r.zeroDamage > 0, 'misses are not claims');
  assert.ok(r.trace.every((x) => x.claim >= 1), 'every submitted claim is a positive whole number');
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

test('4. guards: fists are refused, one Many Endings is supported, a synthetic two-echo is not', () => {
  const target = gateTarget(45, { health: 2000 });
  const fists = simCharacter(BASIC(), null);
  assert.throws(() => simulateRelayFight(fists, { target, health: 2000 }), /fist scheduling/);
  const echoItem = { ...sword(), rarity: 'rare', imprint: 'warp-edge' };
  const echoCh = simCharacter(BASIC(), echoItem);
  const echo = simulateRelayFight(echoCh, { target, health: 2000, weapon: weaponOf(echoItem), seed: 1 });
  assert.ok(echo && echo.claims > 0, 'a real Many Endings build is supported');
  assert.throws(
    () => simulateRelayFight(echoCh, { target, health: 2000, weapon: weaponOf(echoItem), imprints: [{ kind: 'echo', chance: 10 }] }),
    /more than one Many Endings/,
  );
  // Many Endings requires a relay body before the first RNG draw
  for (const relayBody of [undefined, false, 'no']) {
    const noRelay = { ...gateTarget(45, { health: 2000 }), relayBody };
    assert.throws(
      () => simulateRelayFight(echoCh, { target: noRelay, health: 2000, weapon: weaponOf(echoItem) }),
      /relay body is required for Many Endings/,
    );
  }
  // bow and gun timing is not modelled yet: refuse, never approximate
  for (const tpl of [130, 560, 562]) {
    const ranged = weapon(tpl, { material: 9 });
    const rch = simCharacter(BASIC(), ranged);
    assert.throws(
      () => simulateRelayFight(rch, { target, health: 2000, weapon: weaponOf(ranged) }),
      /bow and gun builds are not supported/,
    );
  }
  // a mixed melee + ranged/gun off hand cannot fall through to a melee exchange
  for (const tpl of [130, 560, 562]) {
    const mixed = simCharacter(BASIC(), sword());
    mixed.offWeapon = { ...weapon(tpl, { material: 9 }), equipSlot: 21 };
    mixed._dual = true;
    assert.throws(
      () => simulateRelayFight(mixed, { target, health: 2000, weapon: weaponOf(sword()), dual: true }),
      /bow and gun builds are not supported/,
    );
  }
  // the pre-sampled event list is a branded test seam, not a production option
  assert.throws(
    () => simulateRelayFight(echoCh, { target, health: 2000, weapon: weaponOf(echoItem), events: [] }),
    /test-only option/,
  );
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
  assert.ok(shielded.wardedAttacks > 0, 'the first attacks are turned by the ward');
  if (shielded.trace) assert.ok(shielded.trace[0].t >= 0.5, 'no claim is sent while warded');
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

test('10. Flow: read before the blow, charge on whole blows, cap and refresh', () => {
  const item = { ...sword(), rarity: 'legendary', legendary: 'anseis-edge' };
  const ch = build(BASIC(), item);
  const target = gateTarget(45, { health: 2000 });
  const r = simulateRelayFight(ch, { target, health: 2000, weapon: weaponOf(item), seed: 1, trace: true });
  assert.ok(r.kill);
  assert.equal(r.flow.max, 5);
  assert.equal(r.flow.seconds, 6);
  assert.equal(r.flow.stacks, 5);
  assert.ok(r.flowBuilds > 0);
  assert.equal(r.trace[0].stacksBefore, 0);
  assert.equal(r.trace[0].stacksAfter, 1);
  assert.equal(r.trace[0].flowBuilt, true);
  for (let i = 1; i < r.trace.length; i++) {
    assert.equal(r.trace[i].stacksBefore, r.trace[i - 1].stacksAfter, `read follows the previous charge at claim ${i}`);
    assert.ok(r.trace[i].stacksAfter <= 5);
  }
  const capped = r.trace.find((x) => x.stacksAfter === 5);
  assert.ok(capped && capped.flowUntil > capped.t);
  assert.equal(r.trace.filter((x) => x.flowBuilt).length, r.claims);
  const again = simulateRelayFight(ch, { target, health: 2000, weapon: weaponOf(item), seed: 1, trace: true });
  assert.deepEqual(strip(r), strip(again), 'the Flow fight replays deterministically');
});

test('11. a Potent Vs miss is a positive-damage claim, not skipped', () => {
  const item = { ...sword(), enchantments: [{ type: 4, param: 1 }] }; // Potent Vs vs Daedra
  const ch = build(BASIC(), item);
  const target = gateTarget(45, { health: 2000 });
  const r = simulateRelayFight(ch, { target, health: 2000, weapon: weaponOf(item), seed: 1, trace: true, maxBlows: 20 });
  assert.equal(r.attacks, 20);
  assert.equal(r.claims, 20);
  const miss = r.trace.find((x) => x.hit === false && x.claim > 0);
  assert.ok(miss, 'the Potent Vs miss sent a claim');
  assert.equal(miss.claim, 5);
  assert.ok(miss.got > 0);
  assert.equal(r.zeroDamage, 0);
});

test('12. Many Endings and Flow coexist across the two hands', async () => {
  const main = { ...sword(), rarity: 'rare', imprint: 'warp-edge' };
  const off = { ...sword(), rarity: 'legendary', legendary: 'anseis-edge', equipSlot: 21 };
  const ch = build(BASIC(), main);
  ch.offWeapon = off;
  ch._dual = true;
  const target = gateTarget(45, { health: 2000 });
  const r = simulateRelayFight(ch, { target, health: 2000, weapon: weaponOf(main), dual: true, seed: 1, trace: true });
  assert.ok(r.kill);
  assert.ok(r.trace.some((x) => x.hand === 'main' && x.echoHits > 0), 'the echo rides a main-hand claim');
  assert.ok(r.trace.some((x) => x.hand === 'off' && x.flowBuilt), 'the off hand charges Flow');
  assert.ok(r.flow.stacks > 0);
  assert.ok(r.flowBuilds > 0);
  assert.equal(r.claims, r.trace.length);
  assert.ok(r.trace.every((x) => x.echoHits <= 1), 'one echo power, one extra blow');
  // every submitted Flow/echo claim still has the game's claim-engine state
  const up = await relayStream({ level: 45, share: 2000, claims: r.trace.map((x) => ({ t: x.t, d: x.claim })) });
  assert.equal(up.rows.length, r.trace.length);
  for (let i = 0; i < r.trace.length; i++) {
    const a = r.trace[i];
    const b = up.rows[i];
    assert.ok(near(a.got, b.got), `claim ${i}: got ${a.got} vs ${b.got}`);
    assert.ok(near(a.bucket, b.bucketAfter), `claim ${i}: bucket ${a.bucket} vs ${b.bucketAfter}`);
    assert.ok(near(a.tokens, b.tokensAfter), `claim ${i}: tokens ${a.tokens} vs ${b.tokensAfter}`);
    assert.ok(near(a.hp, b.hpAfter), `claim ${i}: hp ${a.hp} vs ${b.hpAfter}`);
  }
});

test('13. the ward suppresses Flow and the claim; the exact shield boundary does not', () => {
  const item = { ...sword(), rarity: 'legendary', legendary: 'anseis-edge' };
  const ch = build(BASIC(), item);
  const target = gateTarget(45, { health: 2000 });
  const first = createAttackSchedule(ch, { target, health: 2000, weapon: weaponOf(item) }).next().t;
  const before = simulateRelayFight(ch, {
    target, health: 2000, weapon: weaponOf(item), seed: 1, shieldUntil: first + 1e-9, trace: true,
  });
  assert.ok(before.wardedAttacks > 0);
  assert.ok(before.trace[0].t > first, 'no claim is sent by a warded attack');
  assert.equal(before.trace[0].stacksBefore, 0, 'a warded attack builds no Flow');
  const at = simulateRelayFight(ch, {
    target, health: 2000, weapon: weaponOf(item), seed: 1, shieldUntil: first, trace: true,
  });
  assert.equal(at.wardedAttacks, 0);
  assert.equal(at.trace[0].t, first);
  assert.equal(at.trace[0].stacksBefore, 0);
  assert.equal(at.trace[0].flowBuilt, true);
});

test('14. the Flow charge is independent of the relay claim verdict', () => {
  const flow = createFlowState({ max: 5, seconds: 6 });
  const engine = createRelayClaimEngine({ level: 45, share: 12000 });
  for (let i = 0; i < 4; i++) assert.equal(engine.claim({ t: 0, damage: 1 }).accepted, true);
  const charge = flow.hit(0, { whole: true });
  assert.equal(charge.built, true);
  const refused = engine.claim({ t: 0, damage: 100 });
  assert.equal(refused.reason, 'noToken');
  assert.equal(flow.stacksAt(0), 1);
  assert.equal(engine.bucket, 746, 'the no-token claim does not move the purse');
});

test('15. a build with neither mechanic remains bit-identical to Stage 3.3', () => {
  const item = sword();
  const ch = build(BASIC(), item);
  const r = simulateRelayFight(ch, {
    target: gateTarget(45, { health: 2000 }), health: 2000, weapon: weaponOf(item), seed: 7,
  });
  // recorded from the Stage 3.3 implementation (9f23c47) before this stage
  assert.deepEqual({
    claims: r.claims, attacks: r.attacks, damageDealt: r.damageDealt, time: r.time, ttk: r.ttk,
    bucket: r.bucket, tokens: r.tokens, accepted: r.accepted, refused: r.refused,
    outputDps: r.outputDps, killDps: r.killDps,
  }, {
    claims: 110, attacks: 114, damageDealt: 2000, time: 103.79571428571428, ttk: 103.79571428571428,
    bucket: 734, tokens: 3, accepted: 110, refused: 0,
    outputDps: 19.268618302434728, killDps: 19.268618302434728,
  });
});
