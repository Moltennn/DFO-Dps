/*
 * test/allowance.test.js - C1: the Breach boss accepts damage only through a
 * per-player allowance, and the headline metrics must say so.
 *
 * Independent evidence, in three tiers:
 *   1. the simulator's allowance law against the game's own relay
 *      (vendored net/gate/gateBrain.js joinFight/applyHit) on deterministic
 *      claim schedules;
 *   2. the same law against seeded RANDOM swing streams through the real
 *      applyHit, with a confidence interval;
 *   3. analyze(): the corrected headline metrics, which the old implementation
 *      (health / per-hit-capped DPS, 20.6 s for the geared long blade) fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ALLOWANCE, allowanceLaw, claimStreams, simulateAllowance, runAllowance, steadyState, BREACH_PHASES, allowanceSpec, refOf } from '../src/allowance.js';
import { analyze, gateTarget, referenceFoe } from '../src/model.js';
import { encounterTarget } from '../src/encounters.js';
import { simulatePurse } from '../src/purse.js';
import { theoryCharacter } from '../src/theory.js';
import { perfectSockets } from '../src/sockets.js';

import { upstream } from './harness/upstream.mjs';
import { relayRun, expandStreams } from './harness/relay.mjs';
import { generator, seeds, summarize } from './harness/prng.mjs';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const stream = (perClaim, interval, start = interval, kind = 'blow') => ({ kind, perClaim, interval, start });
const one = (perClaim, at) => ({ kind: 'blow', perClaim, interval: 1e9, start: at });

/** Run the simulator and the game's relay on the same claims over a fixed window (no kill). */
async function bothOverWindow({ level, streams, horizonS, fresh = true }) {
  const law = allowanceLaw(level);
  const sim = simulateAllowance({ share: 1e9, law, streams, fresh, maxSeconds: horizonS });
  const claims = expandStreams(streams, horizonS);
  const game = await relayRun({ level, claims, fresh });
  return { sim, game, claims };
}

// ── the law's constants are the relay's ───────────────────────────────────────
test('law: the constants are the relay\'s own (read from the vendored gateBrain)', async () => {
  const u = await upstream();
  const G = u.gateBrain;
  assert.equal(ALLOWANCE.depthX, G.BUCKET_DEPTH_X);
  assert.equal(ALLOWANCE.rateX, G.BUCKET_RATE_X);
  assert.equal(ALLOWANCE.hitCapX, G.HIT_CAP_X);
  assert.equal(ALLOWANCE.hitHz, G.GATE_HIT_HZ_MAX);
  assert.equal(ALLOWANCE.shareS, G.BOSS_TTK_S);
  assert.deepEqual(BREACH_PHASES.map((p) => p.at), [...G.PHASE_AT]);
  assert.equal(BREACH_PHASES[0].shieldS * 1000, G.SHIELD_MS, 'the source minimum ward');
  for (const level of [1, 7, 30, 45, 60, 75]) assert.equal(refOf(level), G.dpsRef(level), `dpsRef(${level})`);
  const law = allowanceLaw(45);
  assert.deepEqual([law.depth, law.rate, law.cap, law.hitHz, law.share], [750, 150, 600, 4, 12000]);
});

test('law: a joining player starts with a full bucket and four tokens (joinFight)', async () => {
  const u = await upstream();
  const f = u.gateBrain.newFight(1, 0, 1e12, 'ruhn');
  u.gateBrain.joinFight(f, 'me', 'Me', 45, 0, true);
  const p = f.players.me;
  assert.equal(p.bucket, 15 * 50);
  assert.equal(p.rate, 4);
  assert.equal(p.share, 240 * 50);
  // a newcomer to a wounded boss arrives with an EMPTY bucket
  const g = u.gateBrain.newFight(1, 0, 1e12, 'ruhn');
  u.gateBrain.joinFight(g, 'a', 'A', 45, 0, true);
  g.hp = g.max * 0.5;
  u.gateBrain.joinFight(g, 'b', 'B', 45, 1000, true);
  assert.equal(g.players.b.bucket, 0);
});

// ── tier 1: deterministic schedules against the game's relay ─────────────────
test('relay: a build below the refill is never clipped and is killed at its own pace', async () => {
  // 100 a second at level 45 against a 150/s refill: the bucket never drains.
  const level = 45;
  const streams = [stream(100, 1)];
  const { sim, game } = await bothOverWindow({ level, streams, horizonS: 60 });
  assert.ok(near(sim.landed, 6000, 1e-6), `offered = landed (${sim.landed})`);
  assert.equal(sim.dryAt, null, 'the opening allowance is never spent');
  assert.ok(near(sim.landed, game.landed, 1e-6), `sim ${sim.landed} vs relay ${game.landed}`);
  // and the kill: 12,000 HP at 100/s is the 120th claim
  const kill = simulateAllowance({ share: 12000, law: allowanceLaw(level), streams });
  const g = await relayRun({ level, claims: expandStreams(streams, 200) });
  assert.ok(near(kill.fightSeconds, 120), `sim kill ${kill.fightSeconds}`);
  assert.ok(near(g.killedAt, kill.fightSeconds, 1e-9), `relay kill ${g.killedAt}`);
});

test('relay: a build far above the refill is limited to opening bucket + refill', async () => {
  const level = 45;
  const streams = [stream(600, 0.7)]; // 857/s offered, every blow at the per-hit cap
  const { sim, game } = await bothOverWindow({ level, streams, horizonS: 30 });
  // total accepted by T can never exceed depth + refill x T
  assert.ok(sim.landed <= 750 + 150 * 30 + 1e-6, `bounded (${sim.landed})`);
  assert.ok(near(sim.landed, game.landed, 1e-4), `sim ${sim.landed} vs relay ${game.landed}`);
  assert.ok(sim.dryAt !== null && sim.dryAt < 3, `the bucket is gone in ${sim.dryAt} s`);
  // and the kill
  const kill = simulateAllowance({ share: 12000, law: allowanceLaw(level), streams });
  const g = await relayRun({ level, claims: expandStreams(streams, 200) });
  assert.ok(near(kill.fightSeconds, g.killedAt, 1e-6), `sim ${kill.fightSeconds} vs relay ${g.killedAt}`);
  assert.ok(kill.fightSeconds >= (12000 - 750) / 150 - 1e-9, 'never faster than (share - depth) / refill');
});

test('relay: a blow over the per-hit cap is clipped to it, the excess discarded not deferred', async () => {
  const level = 45;
  // Two claims of 900: the cap (600) bounds each; a long pause then refills only the refill, not the clipped 300.
  const streams = [one(900, 1), one(900, 1.7), one(900, 60)];
  const { sim, game } = await bothOverWindow({ level, streams, horizonS: 61 });
  assert.ok(near(sim.landed, game.landed, 1e-6), `sim ${sim.landed} vs relay ${game.landed}`);
  assert.ok(sim.clipped >= 3 * 300 - 1e-6, 'the clipped excess is counted as lost');
  // 600 (bucket 750 -> 150); 0.7 s later 150 + 105 = 255 (the claim is limited by the bucket, not the cap);
  // at t=60 the bucket is back at its 750 depth and the claim is held to the cap: 600
  assert.ok(near(sim.landed, 600 + 255 + 600, 1e-6), `landed ${sim.landed}`);
});

test('relay: opening burst, then the refill rate - the late fight accepts exactly the refill', async () => {
  const level = 45;
  const streams = [stream(400, 1)];
  const at30 = simulateAllowance({ share: 1e9, law: allowanceLaw(level), streams, maxSeconds: 30 });
  const at60 = simulateAllowance({ share: 1e9, law: allowanceLaw(level), streams, maxSeconds: 60 });
  const late = (at60.landed - at30.landed) / 30;
  assert.ok(near(late, 150, 1e-6), `sustained rate ${late}`);
  const opening = simulateAllowance({ share: 1e9, law: allowanceLaw(level), streams, maxSeconds: 5 });
  assert.ok(opening.landed / 5 > late * 1.5, `burst ${opening.landed / 5}/s over sustained ${late}/s`);
  const g30 = await relayRun({ level, claims: expandStreams(streams, 30) });
  const g60 = await relayRun({ level, claims: expandStreams(streams, 60) });
  assert.ok(near(late, (g60.landed - g30.landed) / 30, 1e-6), 'the game agrees on the late rate');
  assert.ok(near(opening.landed, (await relayRun({ level, claims: expandStreams(streams, 5) })).landed, 1e-6), 'and on the opening');
  assert.equal(steadyState(streams, allowanceLaw(level)).sustainedDps, 150);
});

test('relay: the same offered damage lands differently at different intervals', async () => {
  const level = 45;
  const law = allowanceLaw(level);
  // 300 offered a second two ways: big claims twice a second apart, or 4x as many small ones.
  const big = [stream(600, 2)]; // 300/s, below the claim-rate limit
  const small = [stream(30, 0.1)]; // 300/s, but 10 claims a second > 4 tokens a second
  const a = simulateAllowance({ share: 1e9, law, streams: big, maxSeconds: 40 });
  const b = simulateAllowance({ share: 1e9, law, streams: small, maxSeconds: 40 });
  const ga = await relayRun({ level, claims: expandStreams(big, 40) });
  const gb = await relayRun({ level, claims: expandStreams(small, 40) });
  assert.ok(near(a.landed, ga.landed, 1e-4), `big: sim ${a.landed} vs relay ${ga.landed}`);
  assert.ok(near(b.landed, gb.landed, 1.0), `small: sim ${b.landed} vs relay ${gb.landed}`);
  assert.ok(b.landed < a.landed * 0.9, `the claim-rate limit costs the small-hit build (${b.landed} < ${a.landed})`);
  assert.ok(b.claimsRefused > 0 && a.claimsRefused === 0, 'tokens, not the bucket, refuse the small hits');
});

test('relay: several claims inside a short interval - four tokens, then refusals', async () => {
  const level = 45;
  // six claims 10 ms apart: the player holds 4 tokens (GATE_HIT_HZ_MAX) and gains 0.04 each gap
  const streams = [1.0, 1.01, 1.02, 1.03, 1.04, 1.05].map((t) => one(50, t));
  const { sim, game } = await bothOverWindow({ level, streams, horizonS: 2 });
  assert.equal(sim.claimsAccepted, 4, 'four land');
  assert.equal(sim.claimsRefused, 2, 'two are refused whole - a refused blow is lost, not queued');
  assert.ok(near(sim.landed, game.landed, 1e-9), `sim ${sim.landed} vs relay ${game.landed}`);
  assert.equal(game.landed, 200);
});

test('relay: depletion, idle refill and the next claim', async () => {
  const level = 45;
  // drain the bucket (750 -> 0) in the opening seconds, idle 3 s, then claim: 3 s x 150 = 450 has refilled
  const streams = [one(600, 1.0), one(600, 1.1), one(600, 1.2), one(600, 4.2)];
  const { sim, game } = await bothOverWindow({ level, streams, horizonS: 5 });
  assert.ok(near(sim.landed, game.landed, 1e-6), `sim ${sim.landed} vs relay ${game.landed}`);
  // 600, then 150 + 15 (bucket 150 + 0.1 s refill), then 15, then 3 s idle -> 450
  assert.ok(near(sim.landed, 600 + 165 + 15 + 450, 1e-6), `landed ${sim.landed}`);
});

test('relay: a refill never banks past the depth (a long idle is not a bigger bucket)', async () => {
  const level = 30;
  const law = allowanceLaw(level);
  const streams = [one(400, 1), one(400, 300)];
  const { sim, game } = await bothOverWindow({ level, streams, horizonS: 301 });
  assert.ok(near(sim.landed, game.landed, 1e-6));
  assert.ok(sim.landed <= law.cap * 2, 'two claims, each held to the per-hit cap');
});

test('relay: a boss shield refuses the blow before a token is spent, and the bucket keeps refilling', async () => {
  const level = 45;
  const law = allowanceLaw(level);
  const phases = [{ at: 0.66, shieldS: 3 }, { at: 0.33, shieldS: 3 }];
  const streams = [stream(250, 0.7)];
  const claims = expandStreams(streams, 200);
  const g = await relayRun({ level, claims, phases });
  const s = simulateAllowance({ share: 12000, law, streams, phases });
  assert.ok(near(s.fightSeconds, g.killedAt, 1e-6), `kill ${s.fightSeconds} vs ${g.killedAt}`);
  assert.ok(s.shieldedSeconds > 0, 'both wards were raised');
  const noShield = simulateAllowance({ share: 12000, law, streams, phases: [] });
  // The bucket refills through the ward, so a bucket-limited build loses almost nothing to it.
  assert.ok(s.fightSeconds - noShield.fightSeconds < 3, `shield cost ${s.fightSeconds - noShield.fightSeconds} s, not the 6 s on the clock`);
});

test('relay: joining a wounded boss starts with an empty bucket', async () => {
  const level = 45;
  const streams = [stream(400, 0.5)];
  const { sim, game } = await bothOverWindow({ level, streams, horizonS: 10, fresh: false });
  assert.ok(near(sim.landed, game.landed, 1e-4), `sim ${sim.landed} vs relay ${game.landed}`);
  assert.ok(sim.landed < 150 * 10 + 1e-6, 'no opening bucket to draw on');
});

test('relay: procs and DoT rounds are claims of their own - each spends a token and a bucket', async () => {
  const level = 45;
  const law = allowanceLaw(level);
  // one swing a second carrying two Cast When Strikes procs and a damage-over-time round every 5 s
  const procs = [{ name: 'a', damage: 120 }, { name: 'b', damage: 80, dotTick: 30 }, { name: 'c', damage: 0, dotTick: 20 }];
  const streams = claimStreams({ cappedPerSwing: 200, hit: 1, aps: 1, procs, cap: law.cap });
  assert.deepEqual(streams.map((s) => s.kind), ['blow', 'proc', 'proc', 'dot']);
  assert.equal(streams.find((s) => s.kind === 'dot').perClaim, 50, 'the DoT ticks of every proc are one summed claim');
  assert.equal(streams.find((s) => s.kind === 'dot').interval, 5);
  const horizon = 40;
  const { sim, game } = await bothOverWindow({ level, streams, horizonS: horizon });
  assert.ok(near(sim.landed, game.landed, 1e-6), `sim ${sim.landed} vs relay ${game.landed}`);
  // 3 claims a second (plus 0.2 DoT) cost 3.2 of the 4 tokens: nothing is refused here, but offered damage is the sum
  assert.ok(near(steadyState(streams, law).offeredDps, 200 + 120 + 80 + 10, 1e-9));
  // many procs on a fast weapon would exceed the token bucket: 1.6 swings x 3 claims = 4.8 claims/s > 4
  const crowded = claimStreams({ cappedPerSwing: 100, hit: 1, aps: 1.6, procs: [{ damage: 40 }, { damage: 40 }], cap: law.cap });
  const c = simulateAllowance({ share: 1e9, law, streams: crowded, maxSeconds: 30 });
  const cg = await relayRun({ level, claims: expandStreams(crowded, 30) });
  assert.ok(c.claimsRefused > 0, 'a proc-heavy weapon outruns the 4 blows/s hand');
  assert.ok(near(c.landed, cg.landed, 1.0), `crowded: sim ${c.landed} vs relay ${cg.landed}`);
});

test('relay: the per-claim cap applies to a proc and a DoT round on their own', () => {
  const law = allowanceLaw(30); // cap 420
  const s = claimStreams({ cappedPerSwing: 500, hit: 1, aps: 1, procs: [{ damage: 900 }, { damage: 0, dotTick: 700 }], cap: law.cap });
  assert.deepEqual(s.map((x) => x.perClaim), [420, 420, 420]);
});

test('relay: levels 1, 30, 45 and 60 all agree with the game', async () => {
  for (const level of [1, 30, 45, 60]) {
    const law = allowanceLaw(level);
    const streams = [stream(law.cap * 0.8, 0.37), stream(law.cap * 0.3, 0.37, 0.37, 'proc')];
    const { sim, game } = await bothOverWindow({ level, streams, horizonS: 45 });
    assert.ok(near(sim.landed, game.landed, 1e-3), `L${level}: sim ${sim.landed} vs relay ${game.landed}`);
  }
});

// ── tier 2: seeded random swing streams through the real applyHit ────────────
test('relay: seeded random swings (misses, random damage) agree with the expected-value schedule', async () => {
  const level = 45;
  const law = allowanceLaw(level);
  const u = await upstream();
  const G = u.gateBrain;
  const aps = 1.4;
  const hit = 0.9;
  const lo = 300;
  const hi = 1500; // many roll above the 600 cap, as the geared long blade's crits do
  const expectedCapped = (() => {
    let t = 0;
    for (let d = lo; d <= hi; d++) t += Math.min(d, law.cap);
    return t / (hi - lo + 1);
  })();

  const kills = [];
  for (const seed of seeds(0xc1a11, 120)) {
    const r = generator(seed);
    const f = G.newFight(1, 0, 1e12, 'ruhn');
    G.joinFight(f, 'me', 'Me', level, 0, true);
    const pose = { x: f.pos[0] + 3, z: f.pos[1] };
    const order = BREACH_PHASES;
    let phaseAt = 0;
    let t = 0;
    while (!f.fell && t < 400) {
      t += 1 / aps;
      if (r() >= hit) continue; // a miss sends nothing
      const d = lo + Math.floor(r() * (hi - lo + 1));
      G.applyHit(f, 'me', d, G.HIT_KINDS.Melee, pose, t * 1000);
      while (phaseAt < order.length && f.hp <= f.max * order[phaseAt].at) {
        f.shieldUntil = Math.max(f.shieldUntil, t * 1000 + order[phaseAt].shieldS * 1000);
        phaseAt += 1;
      }
    }
    kills.push(t);
  }
  const s = summarize(kills);
  const expected = simulateAllowance({
    share: law.share,
    law,
    phases: BREACH_PHASES,
    streams: claimStreams({ cappedPerSwing: expectedCapped * hit, hit, aps, cap: law.cap }),
  });
  assert.ok(expected.killed);
  // The expected-value schedule must sit inside the random fights' mean (95% CI), within 1%.
  const slack = s.ci95 + 0.01 * s.mean;
  assert.ok(Math.abs(expected.fightSeconds - s.mean) <= slack, `expected ${expected.fightSeconds.toFixed(2)} s vs random mean ${s.mean.toFixed(2)} +/- ${s.ci95.toFixed(2)} (n=${s.n})`);
  assert.ok(s.mean >= (law.share - law.depth) / law.rate, 'and no random fight beats the floor on average');
});

// ── tier 3: the headline metrics ─────────────────────────────────────────────
// A deliberately high-DPS probe for the ALLOWANCE law, not the legal max profile (that is
// maxCharacter(123), tested in test/gearProfile.test.js). The relay does not care whether a build is
// attainable; keeping the old 240/540/40 probe preserves the C1 baseline it was pinned against.
const GEARED = () => theoryCharacter({ level: 45, gearLB: 240, gearCS: 540, damagePct: 40, sockets: perfectSockets(123), martialPath: 'blademaster' });
const breach = (ch, extra = {}) => {
  const gate = gateTarget(45);
  return analyze(ch, { target: gate, health: gate.maxHealth, rri: true, stacks: 5, ...extra });
};

test('headline: the geared long blade no longer reports a 20 s Breach kill', () => {
  const r = breach(GEARED());
  // The old figure: health / per-hit-capped DPS + 6 s of shields.
  assert.ok(near(r.ttkCapOnly, 12000 / r.cappedDps + 6, 1e-9), 'the ceiling figure is kept, under its own name');
  assert.ok(r.ttkCapOnly < 25, `old ${r.ttkCapOnly.toFixed(1)} s`);
  assert.ok(r.ttk > 70 && r.ttk < 82, `corrected ${r.ttk.toFixed(1)} s`);
  assert.ok(r.ttk >= (12000 - 750) / 150 - 1e-9, 'never under (share - depth) / refill');
});

test('headline: the metrics are named for what they are', () => {
  const r = breach(GEARED());
  const a = r.allowance;
  assert.ok(a.ceilingDps > 800, `ceiling ${a.ceilingDps.toFixed(0)} is the per-hit-capped figure`);
  assert.ok(near(a.ceilingDps, r.cappedDps, 1e-6), 'cappedDps IS that ceiling and is no longer the boss DPS');
  assert.equal(a.sustainedDps, 150, 'allowance-sustained DPS is the refill rate');
  assert.ok(a.saturated);
  assert.ok(a.burst5Dps > a.sustainedDps * 1.5 && a.burst5Dps < 300, `opening burst ${a.burst5Dps.toFixed(0)}/s over sustained 150/s`);
  assert.ok(near(a.averageDps, 12000 / r.ttk, 1e-9), 'kill-average = share / TTK');
  assert.ok(a.averageDps > a.sustainedDps && a.averageDps < a.sustainedDps * 1.1, `kill-average ${a.averageDps.toFixed(1)}`);
  assert.ok(a.landedShare < 0.25, `most of what this build offers is discarded (${(a.landedShare * 100).toFixed(0)}% lands)`);
});

test('headline: a build below the refill rate is NOT reduced to it', () => {
  // A weak level-45 blade (raw 100, no gear) offers ~60/s against a 150/s allowance.
  const weak = theoryCharacter({ level: 45, rawBlade: 100, rawCrit: 50, rawBackstab: 100, blade: 121 });
  weak.masteredSkills = [];
  const r = breach(weak);
  const a = r.allowance;
  assert.ok(!a.saturated, 'below the allowance');
  assert.ok(near(a.sustainedDps, a.ceilingDps, 1e-9), 'sustained = what it offers');
  assert.equal(a.dryAt, null, 'the opening allowance is never spent');
  assert.ok(a.landedShare > 0.995, `everything lands bar the killing blow's overkill (${a.landedShare})`);
  // TTK is pool / offered (+ at most the ward): the allowance changes nothing
  assert.ok(Math.abs(r.ttk - r.ttkCapOnly) < 6.5, `allowance ttk ${r.ttk.toFixed(1)} vs ceiling ttk ${r.ttkCapOnly.toFixed(1)}`);
});

test('headline: Cast When Strikes procs raise the offered claims, not past the allowance', () => {
  const ch = GEARED();
  const w = ch.weapon;
  w.enchantments = [{ type: 2, param: 0x14 }]; // a Cast When Strikes row; resolved through the player's SPELLS.STD when present
  const plain = breach(GEARED());
  const withProcs = breach(ch);
  assert.ok(withProcs.allowance.claimsPerSecond >= plain.allowance.claimsPerSecond);
  assert.ok(withProcs.totalTtk <= plain.totalTtk + 1e-9, 'procs can only help or tie');
  assert.ok(withProcs.totalTtk >= (12000 - 750) / 150 - 1e-9, 'and never beat the floor');
});

test('headline: the allowance is per player - a group scales the pool, not the allowance', () => {
  const solo = breach(GEARED());
  const g4 = gateTarget(45, { players: 4 });
  const four = analyze(GEARED(), { target: g4, health: g4.maxHealth, rri: true, stacks: 5 });
  assert.equal(g4.allowance.players, 4);
  assert.ok(near(four.ttk, solo.ttk, 1e-9), 'four equal players kill in the time one does (each deals their own share)');
  assert.ok(near(four.allowance.share, 12000, 1e-9));
});

test('headline: non-relay targets are untouched', () => {
  const ch = GEARED();
  const r = analyze(ch, { target: referenceFoe(45, 'tough'), health: 0 });
  assert.equal(r.allowance, null);
  const curb = analyze(ch, { target: { ...referenceFoe(45, 'tough'), isBoss: true, hitCap: 0 }, traits: ['curbing'], health: 5000 });
  assert.equal(curb.allowance, null);
  assert.ok(near(curb.ttk, curb.ttkCapOnly, 1e-12), 'a curbing boss keeps the per-hit TTK');
});

test('headline: the encounter targets carry the allowance and the purse agrees with analyze()', () => {
  const ch = GEARED();
  const t = encounterTarget('breach', 45);
  assert.equal(t.allowance.level, 45);
  assert.equal(t.allowance.phases.length, 2);
  const r = analyze(ch, { target: t, health: t.maxHealth, rri: true, stacks: 5 });
  const purse = simulatePurse(r, 'breach', { level: 45 });
  // one implementation: the purse wrapper and analyze() cannot disagree on the same build
  assert.ok(near(purse.ttk, r.totalTtk, 1e-9), `purse ${purse.ttk} vs analyze ${r.totalTtk}`);
  assert.ok(near(purse.burst5, r.allowance.burst5, 1e-9));
  assert.equal(purse.sustainedDps, r.allowance.sustainedDps);
});

test('headline: the spec is the law, not a hard-coded answer', () => {
  // Changing the level changes the whole result by the law: ref 5+level scales depth, refill, cap and pool together.
  for (const level of [10, 30, 45, 60]) {
    const ch = theoryCharacter({ level, gearLB: 240, gearCS: 540, damagePct: 40, sockets: perfectSockets(123) });
    const g = gateTarget(level);
    const r = analyze(ch, { target: g, health: g.maxHealth, rri: true, stacks: 5 });
    const law = allowanceLaw(level);
    assert.equal(r.allowance.sustainedDps, law.rate);
    assert.ok(r.ttk >= (law.share - law.depth) / law.rate - 1e-9, `L${level} floor`);
    assert.ok(r.ttk < (law.share - law.depth) / law.rate + 12, `L${level} ttk ${r.ttk.toFixed(1)}`);
  }
  // a spec with different phases changes only the ward time
  const base = allowanceSpec(45, {});
  assert.equal(base.phases.length, 2);
  const none = runAllowance({ level: 45, share: 12000, spec: allowanceSpec(45, { phases: [] }), streams: [stream(400, 1)] });
  const some = runAllowance({ level: 45, share: 12000, spec: base, streams: [stream(400, 1)] });
  assert.ok(some.ttk >= none.ttk - 1e-9);
});
