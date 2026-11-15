/*
 * test/relayFight.test.js - Stage 2.12b, Part B: the relay-aware whole fight.
 *
 * The law (vendored net/gate/gateBrain.js: joinFight :1213, applyHit :1298, spendBlow :3411): a player joins with a bucket
 * of BUCKET_DEPTH_X x ref and GATE_HIT_HZ_MAX tokens; applyHit refuses while shielded (no token), spends a token, then
 * grants got = min(claim, HIT_CAP_X x ref, bucket, hp); the bucket refills BUCKET_RATE_X x ref a second.
 *
 * `simulateAllowance` implements that law; this stage let the CLAIM depend on the health that stands when it is made
 * (`perClaimAt`), and `fightRelay` (src/fight.js) composes it with the health-dependent blow. The oracle here is the
 * vendored relay itself, driven with claims computed from ITS health (never from a local intermediate).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { allowanceLaw, simulateAllowance } from '../src/allowance.js';
import { fightRelay } from '../src/fight.js';
import { analyze, gateTarget, weaponOf } from '../src/model.js';
import { maxCharacter } from '../src/maxprofile.js';
import { upstream, pcaaoModules } from './harness/upstream.mjs';
import { upstreamBody } from './harness/upstreamBodies.mjs';
import { character, simCharacter, upstreamEntity, weapon } from './harness/fixtures.mjs';
import { generator } from './harness/prng.mjs';

/** The vendored relay on one player, claims from `claim(share)` at a fixed interval (no phase shields: the phase law is
 *  tested in test/allowance.test.js; here the health-dependent claim is the subject). */
async function relayOnHealth(level, { share, intervalS, claim, maxSeconds = 2000 }) {
  const u = await upstream();
  const G = u.gateBrain;
  const f = G.newFight(1, 0, 1e12, 'ruhn');
  G.joinFight(f, 'me', 'Me', level, 0, true);
  const pose = { x: f.pos[0] + 3, z: f.pos[1] };
  let t = 0;
  let landed = 0;
  let accepted = 0;
  while (f.hp > 0 && t < maxSeconds) {
    t += intervalS;
    const d = claim(f.hp / f.max);
    const got = G.applyHit(f, 'me', d, G.HIT_KINDS.Melee, pose, t * 1000);
    if (got > 0) { landed += got; accepted += 1; }
  }
  return { seconds: t, landed, accepted, killed: f.hp <= 0, hp: f.hp, max: f.max, share };
}

test('1. the law with a health-dependent claim is the relay\'s own', async () => {
  const level = 45;
  const law = allowanceLaw(level);
  const share = 12000;
  const intervalS = 0.4; // 2.5 claims a second: under the 4-token hand
  // the claim doubles below half - a venom-shaped rule, nothing of the local damage model in it
  const claim = (h) => (h / share < 0.5 ? 600 : 300);
  const game = await relayOnHealth(level, { share, intervalS, claim });
  const sim = simulateAllowance({
    share, law, streams: [{ kind: 'blow', perClaim: 0, interval: intervalS, start: intervalS }],
    perClaimAt: (_s, hp) => claim(hp),
  });
  assert.ok(sim.killed && game.killed, 'both kill');
  assert.equal(sim.dryAt !== null, true, 'the bucket runs dry (600 > 150 + refill of a 0.4 s step)');
  assert.ok(Math.abs(sim.fightSeconds - game.seconds) <= intervalS + 1e-9, `the law's kill agrees to a claim: ${sim.fightSeconds} vs ${game.seconds}`);
  assert.ok(Math.abs(sim.landed - game.landed) <= claim(share) + 1e-6, `the landed total agrees to a claim: ${sim.landed} vs ${game.landed}`);
});

test('2. saturation across damage levels: below the refill the build sets the pace, above it the relay does', async () => {
  const level = 45;
  const law = allowanceLaw(level);
  // a constant claim, at 0.5 s a claim (2/s): the offered rate is 2 x claim
  const at = (c) => simulateAllowance({ share: 12000, law, streams: [{ kind: 'blow', perClaim: c, interval: 0.5, start: 0.5 }] });
  const below = at(60); // 120/s offered, under the 150/s refill
  const atRate = at(75); // 150/s: exactly the refill
  const above = at(200); // 400/s: the bucket drains at once
  assert.equal(below.dryAt, null, 'below the refill the bucket is never touched');
  assert.equal(below.killed, true);
  assert.ok(below.fightSeconds >= 12000 / 120 - 1e-9, 'the build kills at its own offered rate');
  assert.equal(atRate.killed, true);
  assert.ok(atRate.fightSeconds <= below.fightSeconds * 0.85, 'at the refill it is faster');
  assert.ok(Math.abs(above.fightSeconds - (12000 - 750) / 150) < 1.5, `above it the relay sets the pace: ${above.fightSeconds}`);
  // and the health-dependent fight metric reports the same division: a max profile above, a mid build below
  const gate = gateTarget(45);
  const strong = fightRelay(maxCharacter(121), { target: gate, health: gate.maxHealth });
  const weaken = character({ level: 20, raceId: 1, stats: { strength: 70, agility: 55, speed: 70, luck: 50 }, skills: 0, skillOverride: { 29: 60, 34: 30 } });
  const weakItem = weapon(121, { material: 6 });
  const weak = fightRelay(simCharacter(weaken, weakItem), { target: gate, health: gate.maxHealth, core: 'overhaul', weapon: weaponOf(weakItem) });
  assert.equal(strong.saturated, true);
  assert.ok(strong.marginDps > 500, `margin ${strong.marginDps.toFixed(0)}`);
  assert.equal(weak.saturated, false, 'the mid build is under the refill');
  assert.ok(weak.marginDps < 0, `margin ${weak.marginDps.toFixed(0)}`);
  assert.ok(weak.ttk > strong.ttk * 2, `and it is far slower (${weak.ttk.toFixed(0)} s vs ${strong.ttk.toFixed(0)} s)`);
  // the same build either side of the allowance: the refill scales with the content level, the build does not
  const venomItem = { ...weakItem, rarity: 'rare', imprint: 'tsaesci-fang' };
  const relayAtLevel = (lvl) => fightRelay(simCharacter(weaken, venomItem), { target: gateTarget(lvl), health: gateTarget(lvl).maxHealth, core: 'overhaul', weapon: weaponOf(venomItem) });
  const overRefill = relayAtLevel(1);
  const underRefill = relayAtLevel(10);
  assert.equal(overRefill.saturated, true, `level 1: refill ${overRefill.refillDps}, ceiling ${overRefill.ceilingDps.toFixed(0)}`);
  assert.ok(overRefill.marginDps > 0);
  assert.equal(underRefill.saturated, false, `level 10: refill ${underRefill.refillDps}, ceiling ${underRefill.ceilingDps.toFixed(0)}`);
  assert.ok(underRefill.marginDps < 0);
});

/** A deliberately weak build: a level-8 character with a shortsword against the level-45 gate. */
function maxProfileWeak() {
  return { level: 8, online: false, stats: { strength: 40, agility: 40, speed: 40, luck: 40, intelligence: 40, willpower: 40, endurance: 40, personality: 40 }, skills: Array.from({ length: 35 }, () => 20), career: {}, items: [{ ...weapon(116, { material: 0 }), equipSlot: 19 }], weapon: { ...weapon(116, { material: 0 }), equipSlot: 19 }, activeEffects: [], _mods: { stats: {}, skills: {} }, _enchantMods: { skillMods: {} }, health: 100, maxHealth: 100, reflexes: 2 };
}

test('3. two builds with identical capped damage and different uncapped damage collapse at the relay', () => {
  const gate = gateTarget(45);
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 150, 34: 30 } });
  const ch = (bonus) => {
    const item = { ...weapon(121, { material: 9 }), __bonusDamage: bonus };
    return { ch: { ...simCharacter(desc, item), weapon: item }, item };
  };
  const a = ch(800); // every landed blow is past the 600 cap
  const b = ch(1600);
  const ra = fightRelay(a.ch, { target: gate, health: gate.maxHealth, core: 'overhaul', weapon: weaponOf(a.item) });
  const rb = fightRelay(b.ch, { target: gate, health: gate.maxHealth, core: 'overhaul', weapon: weaponOf(b.item) });
  // the per-hit cap makes the two indistinguishable at the relay ...
  assert.equal(ra.cap, rb.cap);
  assert.ok(ra.snapshot.cappedPerSwing > 0);
  assert.ok(Math.abs(ra.snapshot.cappedPerSwing - rb.snapshot.cappedPerSwing) < 1e-9, `capped ${ra.snapshot.cappedPerSwing} vs ${rb.snapshot.cappedPerSwing}`);
  assert.ok(Math.abs(ra.ttk - rb.ttk) < 1e-9, 'the relay cannot tell them apart');
  assert.ok(Math.abs(ra.acceptedDps - rb.acceptedDps) < 1e-9);
  // ... and the uncapped figure is the only thing that differs: the metric says so rather than inventing a difference
  assert.ok(rb.uncappedDps > ra.uncappedDps * 1.2, `uncapped ${ra.uncappedDps.toFixed(0)} vs ${rb.uncappedDps.toFixed(0)}`);
  assert.equal(ra.saturated && rb.saturated, true);
  // every landed blow is past the cap: the capped per-swing figure is the cap times the hit chance, and the uncapped
  // cards are what differ
  assert.ok(Math.abs(ra.snapshot.cappedPerSwing - ra.cap * ra.snapshot.hit.hit) < 1e-9, `capped per swing ${ra.snapshot.cappedPerSwing}`);
  assert.ok(rb.snapshot.perSwing > ra.snapshot.perSwing * 1.2, 'the uncapped cards differ');
});

test('4. the relay fight: exact against the relay on the expected claims, and within the walk\'s bias of seeded fights', async () => {
  const u = await upstream();
  const { body: template } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const gate = gateTarget(5); // refill 30/s: the fixture build stands above it (the level-45 refill would not bind)
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 150, 34: 30 } });
  const item = { ...weapon(121, { material: 9 }), rarity: 'rare', imprint: 'tsaesci-fang' }; // venom: the claim changes at half
  const ch = simCharacter(desc, item);
  const w = weaponOf(item);
  const f = fightRelay(ch, { target: gate, health: gate.maxHealth, core: 'overhaul', weapon: w });
  assert.ok(f && f.saturated);
  assert.equal(f.segments.length, 2, 'one segment above half, one below');
  const hit = f.snapshot.hit.hit;
  const aps = f.snapshot.cadence.aps;
  const G = u.gateBrain;

  // (a) the law's wiring: the relay, driven with the SAME expected claim at the same health, agrees to the second
  {
    const fight = G.newFight(1, 0, 1e12, 'ruhn');
    G.joinFight(fight, 'me', 'Me', gate.level, 0, true);
    const pose = { x: fight.pos[0] + 3, z: fight.pos[1] };
    const interval = 1 / (aps * hit);
    let t = 0;
    let claims = 0;
    while (fight.hp > 0 && t < 600) {
      t += interval;
      const r = analyze(ch, { target: gate, health: gate.maxHealth, healthShare: fight.hp / fight.max, core: 'overhaul', weapon: w });
      G.applyHit(fight, 'me', r.cappedPerSwing / hit, G.HIT_KINDS.Melee, pose, t * 1000);
      claims += 1;
    }
    assert.ok(Math.abs(f.ttk - t) < 1e-6, `the model's relay run is the relay's own: ${f.ttk} vs ${t}`);
    assert.equal(claims, f.claimsOffered, 'and the same claims');
  }

  // (b) seeded fights with real blows (misses claim nothing): the walk uses E[damage], so the mean differs by the
  // expected-damage bias measured in Part A (<= 0.3% on these pools; the relay's clipping is the nonlinearity).
  const reps = 120;
  const times = [];
  const modules = pcaaoModules(u);
  for (let k = 0; k < reps; k++) {
    const fight = G.newFight(1, 0, 1e12, 'ruhn');
    G.joinFight(fight, 'me', 'Me', gate.level, 0, true);
    const body = { ...template, relayShare: () => Math.max(0, Math.min(1, fight.hp / fight.max)) }; // the relay's word, as the game reads it
    const attacker = upstreamEntity(desc);
    const slot = u.equip.equipTableOf(attacker);
    const rng = generator(0x9900 + k * 61);
    const pose = { x: fight.pos[0] + 3, z: fight.pos[1] };
    let t = 0;
    while (fight.hp > 0 && t < 600) {
      t += 1 / aps;
      const sw = { ...item };
      slot[u.equip.EQUIP_SLOTS.RightHand] = sw;
      const d = u.pcaao.pcaaoAttackDamage(attacker, body, { weapon: sw, rolls: rng, modules, backstabChance: 0 });
      if (d > 0) G.applyHit(fight, 'me', d, G.HIT_KINDS.Melee, pose, t * 1000);
    }
    times.push(t);
  }
  const mean = times.reduce((x, y) => x + y, 0) / reps;
  const sd = Math.sqrt(times.reduce((x, y) => x + (y - mean) ** 2, 0) / (reps - 1));
  const se = sd / Math.sqrt(reps);
  const rel = f.ttk / mean - 1;
  assert.ok(Math.abs(rel) < 0.01, `relay fight: model ${f.ttk.toFixed(3)} s vs seeded mean ${mean.toFixed(3)} +/- ${(1.96 * se).toFixed(3)} (bias ${(rel * 100).toFixed(2)}%)`);
  // the bias is the expected-damage walk, not a law error: it is far smaller than the fight itself
  assert.ok(Math.abs(f.ttk - mean) < 0.01 * mean);
});
