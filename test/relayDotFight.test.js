/*
 * test/relayDotFight.test.js - Stage 3.7d/3.7e: Cast When Strikes and Continuous Damage inside a relay fight.
 *
 * The oracle is the game's own relay law (`test/harness/relay.mjs` `relayStream`, the vendored
 * `gateBrain.applyHit`/`spendBlow`): every claim the local fight makes - a CWS proc, the blow, a DoT round - is replayed
 * through it in the same order, at the same times, and the local per-claim `got`/`bucket`/`tokens`/`hp`/`clipped` must
 * match. Rules read from upstream:
 *   - a CWS proc is its own claim (`vendor:scenes/gate/standInSpell.js:198-217`), and on a relay body a CWS cast is
 *     resolved inside the blow's formula, before the host's blow claim (`vendor:combat/formulas.js:826-836`);
 *   - a DoT round's ticks are ONE claim per round (`standInSpell.js:131-151`), one round = 5 s
 *     (`src/spells.js:21`), and the continuousDamage entry keeps ONE per body (renewal, `effects.js:1091-1103`);
 *   - the model submits shielded DoT rounds; the engine refuses the claim before any token
 *     (`vendor:net/gate/gateBrain.js:1308`; `src/relayClaim.js:149`). The real host instead sends no claim for a turned
 *     body (`vendor:scenes/gate/standInSpell.js:219-236`), checked in standInSpellDifferential.test.js;
 *   - the host rounds the claim boundary and sends nothing under 1 (`vendor:scenes/gate/gateCourt.js:1164-1165`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gateTarget, weaponOf } from '../src/model.js';
import { simulateRelayFight, simulateRelayFights } from '../src/relayFight.js';
import { isContinuousDamage, resolveCwsCast } from '../src/cws.js';
import { upstream } from './harness/upstream.mjs';
import { relayStream } from './harness/relay.mjs';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';

const BASIC = () => character({
  level: 45, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});

/** A weapon with optional Cast When Strikes rows (enchantment type 2). */
const sword = (params = []) => {
  const it = weapon(121, { material: 9 });
  if (params.length) it.enchantments = params.map((param) => ({ type: 2, param }));
  return it;
};

/** One spell: a Continuous Damage Health (1,0) round, and/or an instant (4,0) hit. */
const spell = ({ index = 1, mag = 10, rounds = 5, direct = 0 } = {}) => ({
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

const near = (a, b, eps = 1e-7) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const strip = ({ with: _with, ...rest }) => rest;

/** The local claim log replayed through the vendored relay, claim for claim. */
async function replay(fight, { shieldUntil = 0 } = {}) {
  assert.ok(Array.isArray(fight.claimLog), 'the fight keeps its whole claim log');
  assert.equal(fight.claimLog.length, fight.claims, 'one log row per claim');
  const level = fight.target?.allowance?.level ?? fight.law.level;
  const up = await relayStream({
    level,
    share: fight.health,
    fresh: true,
    shieldUntil,
    claims: fight.claimLog.map((c) => ({ t: c.t, d: c.claim })),
  });
  assert.equal(up.rows.length, fight.claimLog.length);
  let clipped = 0;
  for (let i = 0; i < fight.claimLog.length; i++) {
    const a = fight.claimLog[i];
    const b = up.rows[i];
    clipped += a.clipped;
    const label = `claim ${i} (${a.kind} at ${a.t}, ${a.claim})`;
    assert.ok(near(a.got, b.got), `${label}: got ${a.got} vs ${b.got}`);
    assert.ok(near(a.bucket, b.bucketAfter), `${label}: bucket ${a.bucket} vs ${b.bucketAfter}`);
    assert.ok(near(a.tokens, b.tokensAfter), `${label}: tokens ${a.tokens} vs ${b.tokensAfter}`);
    assert.ok(near(a.hp, b.hpAfter), `${label}: hp ${a.hp} vs ${b.hpAfter}`);
    assert.ok(near(clipped, b.clippedAfter), `${label}: clipped ${clipped} vs ${b.clippedAfter}`);
  }
  return { up, clipped };
}

test('3.7d: a CWS cast is its own claim, submitted before the blow claim at the same time', async () => {
  const item = sword([1]);
  const ch = simCharacter(BASIC(), item);
  const target = gateTarget(45, { health: 4000 });
  const r = simulateRelayFight(ch, {
    target, health: 4000, weapon: weaponOf(item), seed: 7, trace: true,
    standard: new Map([[1, spell({ direct: 300 })]]),
  });
  assert.ok(r, 'the fight ran');
  assert.ok(r.claimsByKind.proc > 0, 'the CWS casts are claims');
  assert.ok(r.claimsByKind.blow > 0);
  const at = r.claimLog.findIndex((c) => c.kind === 'proc');
  assert.ok(at >= 0);
  const sameT = r.claimLog.filter((c) => c.t === r.claimLog[at].t).map((c) => c.kind);
  assert.deepEqual(sameT, ['proc', 'blow'], 'the cast lands before the blow at one timestamp');
  await replay(r);
});

test('3.7d: a cast inside a shield is refused - the ward is the relay clock, not target.warded', async () => {
  const item = sword([1]);
  const ch = simCharacter(BASIC(), item);
  const target = gateTarget(45, { health: 4000 });
  const r = simulateRelayFight(ch, {
    target, health: 4000, weapon: weaponOf(item), seed: 7, trace: true, shieldUntil: 2,
    standard: new Map([[1, spell({ direct: 300 })]]),
  });
  assert.ok(r.wardedAttacks > 0, 'the opening blows are warded');
  const procs = r.claimLog.filter((c) => c.kind === 'proc');
  assert.ok(procs.length > 0, 'the fight casts once the shield drops');
  assert.ok(procs.every((c) => c.t >= 2), 'no cast lands inside the shield');
  await replay(r, { shieldUntil: 2 });
});

test('3.7d: a shielded DoT round is refused by the engine while the entry keeps ticking', async () => {
  const item = sword();
  const ch = simCharacter(BASIC(), item);
  const target = gateTarget(45, { health: 4000 });
  // One live entry, primed through the real cast path (the fight clones the target's effects).
  const scratch = { ...target, activeEffects: [] };
  const mag = spell({ mag: 100 });
  resolveCwsCast({ spell: mag, caster: { entity: ch }, casterLevel: 45, target: scratch, rolls: () => 0.5, hurt: () => {} });
  assert.equal(scratch.activeEffects.length, 1, 'the cast leaves one continuousDamage entry');
  const primed = { ...target, activeEffects: scratch.activeEffects.map((a) => ({ ...a })) };
  const rounds = primed.activeEffects[0].roundsRemaining;
  assert.ok(rounds > 0);
  const r = simulateRelayFight(ch, {
    target: primed, health: 4000, weapon: weaponOf(item), seed: 7, trace: true, shieldUntil: 6, maxBlows: 1, maxSeconds: 40,
  });
  const dots = r.claimLog.filter((c) => c.kind === 'dot');
  assert.ok(dots.length >= 2, `the entry keeps ticking through the shield (${dots.length} rounds)`);
  assert.equal(dots[0].t, 5);
  assert.equal(dots[0].got, 0, 'the shielded round lands nothing');
  assert.equal(dots[0].reason, 'shielded');
  assert.ok(dots[1].got > 0, 'the next round, after the shield, is paid');
  // The round count is consumed by the ticks, shield or not: `roundsRemaining` rounds all fire.
  assert.ok(dots.length <= rounds);
  await replay(r, { shieldUntil: 6 });
});

test('3.7d: a cast kill suppresses the blow claim and names the cast', async () => {
  const item = sword([1]);
  const ch = simCharacter(BASIC(), item);
  const target = gateTarget(45, { health: 100 });
  const r = simulateRelayFight(ch, {
    target, health: 100, weapon: weaponOf(item), seed: 7, trace: true,
    standard: new Map([[1, spell({ mag: 10, rounds: 1, direct: 5000 })]]),
  });
  assert.equal(r.kill, true);
  assert.equal(r.killSource, 'cws');
  assert.equal(r.termination, 'kill');
  const at = r.claimLog.findIndex((c) => c.kind === 'proc');
  assert.ok(at >= 0);
  const atT = r.claimLog.filter((c) => c.t === r.claimLog[at].t).map((c) => c.kind);
  assert.deepEqual(atT, ['proc'], 'no blow claim after a killing cast');
  assert.equal(r.claimsByKind.blow, 0);
  await replay(r);
});

test('3.7d: a renewal re-cast bills nothing (one entry, one first round)', async () => {
  const item = sword([1]);
  const ch = simCharacter(BASIC(), item);
  const target = gateTarget(45, { health: 1e6 });
  const r = simulateRelayFight(ch, {
    target, health: 1e6, weapon: weaponOf(item), seed: 7, trace: true, maxSeconds: 20,
    standard: new Map([[1, spell({ mag: 100, rounds: 9 })]]),
  });
  assert.ok(r.attacks > 3, 'the fight cast several times');
  assert.equal(r.claimsByKind.proc, 1, 'only the first cast bills its round: a renewal of a live incumbent bills nothing');
  assert.ok(r.claimsByKind.dot > 0, 'later rounds still claim');
  await replay(r);
});

test('3.7d: a DoT round can kill, and the kill names the DoT', async () => {
  const item = sword([1]);
  const ch = simCharacter(BASIC(), item);
  const target = gateTarget(45, { health: 1000, traits: [] }); // Isolate DoT kill attribution from resistance.
  const r = simulateRelayFight(ch, {
    target, health: 1000, weapon: weaponOf(item), seed: 7, trace: true, maxBlows: 1, maxSeconds: 40,
    standard: new Map([[1, spell({ mag: 1000, rounds: 5 })]]),
  });
  assert.equal(r.kill, true);
  assert.equal(r.killSource, 'dot');
  assert.equal(r.termination, 'kill');
  const last = r.claimLog[r.claimLog.length - 1];
  assert.equal(last.kind, 'dot');
  assert.equal(r.ttk, last.t, 'the kill time is the round\'s');
  await replay(r);
});

test('3.7d: a (1,0) with durationBase 0 stands for nothing - no entry, no dot claim', async () => {
  const item = sword([1]);
  const ch = simCharacter(BASIC(), item);
  const target = gateTarget(45, { health: 4000 });
  const r = simulateRelayFight(ch, {
    target, health: 4000, weapon: weaponOf(item), seed: 7, trace: true, maxSeconds: 20,
    standard: new Map([[1, spell({ rounds: 0 })]]),
  });
  assert.equal(r.claimsByKind.dot, 0);
  assert.equal(r.claimsByKind.proc, 0, 'a zero-round DoT bills nothing at the cast either');
  await replay(r);
});

test('3.7e: the per-kind accounting adds up, and a kill names its source', async () => {
  const item = sword([1]);
  const ch = simCharacter(BASIC(), item);
  const target = gateTarget(45, { health: 4000 });
  const r = simulateRelayFight(ch, {
    target, health: 4000, weapon: weaponOf(item), seed: 3, trace: true, maxSeconds: 30,
    standard: new Map([[1, spell({ mag: 200, rounds: 7, direct: 150 })]]),
  });
  const kinds = ['blow', 'proc', 'dot'];
  assert.deepEqual(Object.keys(r.claimsByKind).sort(), ['blow', 'dot', 'proc']);
  assert.equal(r.claims, kinds.reduce((a, k) => a + r.claimsByKind[k], 0), 'claims === the kinds');
  assert.ok(near(r.damageDealt, kinds.reduce((a, k) => a + r.dealtByKind[k], 0)), 'dealt === the kinds');
  assert.ok(near(r.clipped, kinds.reduce((a, k) => a + r.clippedByKind[k], 0)), 'clipped === the kinds');
  assert.ok(r.dealtByKind.dot > 0, 'the DoT paid something');
  if (r.kill) {
    const last = r.claimLog[r.claimLog.length - 1];
    assert.equal(r.killSource, last.kind === 'proc' ? 'cws' : last.kind, 'the kill names the claim that made it');
  } else {
    assert.equal(r.killSource, null);
  }
});

test('3.7d: the cast\'s claim equals the vendored applySpell for the same scripted rolls', async () => {
  const u = await upstream();
  const item = sword([1]);
  const ch = simCharacter(BASIC(), item);
  const target = gateTarget(45, { health: 4000, traits: [] }); // Raw applySpell doesn't include the boss-trait layer.
  const theSpell = spell({ mag: 200, rounds: 5, direct: 150 });
  // Six draws for one cast of (dot + direct): magnitude x2 and one throw per effect.
  const values = [0.1, 0.9, 0.4, 0.2, 0.8, 0.6];
  const scripted = (vals) => { let i = 0; return () => (i < vals.length ? vals[i++] : 0.5); };
  // The oracle reads the same body as plain data (stats/career/level/activeEffects); the gate body IS the game's own
  // stand-in, so this is the body upstream mints.
  const upBody = { ...target, activeEffects: [] };
  let upTotal = 0;
  u.effects.applySpell(theSpell, 45, upBody, { hurt: (n) => { upTotal += n; } }, scripted([...values]), { entity: ch });
  assert.ok(upTotal > 0, 'the oracle cast bills');
  const localTarget = { ...target, activeEffects: [] };
  let localTotal = 0;
  resolveCwsCast({
    spell: theSpell, caster: { entity: ch }, casterLevel: 45, target: localTarget, rolls: scripted([...values]),
    hurt: (n) => { localTotal += n; },
  });
  assert.equal(localTotal, upTotal, 'the cast\'s direct + first round equals the vendored applySpell');
  const fight = simulateRelayFight(ch, {
    target, health: 4000, weapon: weaponOf(item), seed: 7, trace: true, cwsRolls: scripted([...values]),
    standard: new Map([[1, theSpell]]),
  });
  const first = fight.claimLog.find((c) => c.kind === 'proc');
  assert.ok(first, 'the fight cast');
  assert.equal(first.claim, Math.round(upTotal), 'the fight\'s proc claim is the oracle total, rounded at the boundary');
});

test('pin: a body cannot hold two (1,0) entries, and cws.js has no second continuous kind', () => {
  const ch = simCharacter(BASIC(), sword());
  const target = { ...gateTarget(45, { health: 4000 }), activeEffects: [] };
  const cast = (sp) => resolveCwsCast({ spell: sp, caster: { entity: ch }, casterLevel: 45, target, rolls: () => 0.5, hurt: () => {} });
  cast(spell({ index: 1, mag: 100 }));
  cast(spell({ index: 2, mag: 300 }));
  assert.equal(target.activeEffects.length, 1, 'a like-kind re-cast renews the one entry (effects.js:1091-1103)');
  assert.equal(target.activeEffects[0].effect.magnitudeBaseLow, 100, 'the incumbent keeps its own magnitude');
  // cws.js implements only Continuous Damage Health (1,0): a (1,1) or (1,2) is deferred and stands no entry, so a round
  // can only ever sum one entry here.
  assert.equal(isContinuousDamage({ type: 1, subType: 0 }), true);
  assert.equal(isContinuousDamage({ type: 1, subType: 1 }), false);
  assert.equal(isContinuousDamage({ type: 1, subType: 2 }), false);
  const oneOne = spell({ index: 3 });
  cast({ ...oneOne, effects: [{ ...oneOne.effects[0], subType: 1 }] });
  assert.equal(target.activeEffects.length, 1, 'a (1,1) gives no second continuous entry');
});

test('3.7d: the cast uses the STRIKING hand\'s item - a CWS row on the OFF hand only', () => {
  const main = sword();
  const off = { ...sword([1]), equipSlot: 21 };
  const ch = simCharacter(BASIC(), main);
  ch.offWeapon = off;
  ch._dual = true;
  const target = gateTarget(45, { health: 4000 });
  const r = simulateRelayFight(ch, {
    target, health: 4000, weapon: weaponOf(main), dual: true, seed: 7, trace: true, maxSeconds: 20,
    standard: new Map([[1, spell({ mag: 100, rounds: 3 })]]),
  });
  const procs = r.claimLog.filter((c) => c.kind === 'proc');
  assert.ok(procs.length > 0, 'the off hand casts');
  assert.ok(procs.every((c) => c.hand === 'off'), 'only the off hand\'s blows cast (the striking hand\'s item)');
  assert.ok(r.claimLog.some((c) => c.kind === 'blow' && c.hand === 'main'), 'the main hand still claims its blows');
  assert.ok(r.claimsByKind.dot > 0, 'the entry ticks');
});

test('3.7 fix: outputDps uses the last BILLED claim, not the last blow', () => {
  const item = sword([1]);
  const ch = simCharacter(BASIC(), item);
  const target = gateTarget(45, { health: 1e6 });
  const r = simulateRelayFight(ch, {
    target, health: 1e6, weapon: weaponOf(item), seed: 7, trace: true, maxBlows: 1, maxSeconds: 40,
    standard: new Map([[1, spell({ mag: 100, rounds: 8 })]]),
  });
  assert.equal(r.kill, false);
  const last = r.claimLog[r.claimLog.length - 1];
  assert.equal(last.kind, 'dot');
  assert.ok(last.t > r.lastAttackAt, 'the drain bills rounds after the last blow');
  assert.equal(r.time, last.t, 'the fight lasts to the last claim it billed');
  assert.ok(near(r.outputDps, r.damageDealt / last.t), `outputDps ${r.outputDps} = dealt / last claim ${last.t}`);
});

test('3.7e: the batch summary carries the per-kind totals and the kill tally', () => {
  const item = sword([1]);
  const ch = simCharacter(BASIC(), item);
  const target = gateTarget(45, { health: 4000 });
  const r = simulateRelayFights(ch, {
    target, health: 4000, weapon: weaponOf(item), seed: 3, trials: 3, maxSeconds: 30, trace: true,
    standard: new Map([[1, spell({ mag: 200, rounds: 7, direct: 150 })]]),
  });
  assert.deepEqual(Object.keys(r.claimsByKind).sort(), ['blow', 'dot', 'proc']);
  assert.deepEqual(Object.keys(r.dealtByKind).sort(), ['blow', 'dot', 'proc']);
  const sum = (k) => r.rows.reduce((a, x) => a + x.claimsByKind[k], 0);
  for (const k of ['blow', 'proc', 'dot']) assert.equal(r.claimsByKind[k], sum(k), `${k} claims add up over the trials`);
  assert.equal(r.claimsByKind.blow + r.claimsByKind.proc + r.claimsByKind.dot,
    r.rows.reduce((a, x) => a + x.claims, 0), 'every claim is one of the kinds');
  assert.deepEqual(Object.keys(r.killSource).sort(), ['blow', 'cws', 'dot']);
  assert.equal(r.killSource.blow + r.killSource.cws + r.killSource.dot, r.kills, 'the kill tally covers every kill');
});

test('3.7d: a build with no CWS rows is bit-identical to the same fight before the payload existed', () => {
  const item = sword();
  const ch = simCharacter(BASIC(), item);
  const target = gateTarget(45, { health: 2000 });
  const args = { target, health: 2000, weapon: weaponOf(item), seed: 11, trace: true, maxSeconds: 30 };
  const plain = simulateRelayFight(ch, args);
  const withStandard = simulateRelayFight(ch, { ...args, standard: new Map([[1, spell({ direct: 500 })]]) });
  const again = simulateRelayFight(ch, args);
  // The item carries no CWS row, so the standard cannot reach the fight: same fight, field for field.
  assert.deepEqual(strip(withStandard), strip(plain));
  assert.deepEqual(strip(again), strip(plain));
  assert.equal(plain.claimsByKind.proc, 0);
  assert.equal(plain.claimsByKind.dot, 0);
  assert.equal(plain.claimLog.length, plain.claims);
  // The seeded no-CWS fight's figures, pinned as literals. Verified at 19f7529 (the commit before this payload): this
  // same fixture, run there with the new-field assertions above removed, gives these exact figures.
  assert.equal(plain.ttk, null, 'the fight is censored at the horizon');
  assert.equal(plain.damageDealt, 524);
  assert.equal(plain.claims, 32);
  assert.equal(plain.time, 30);
  assert.equal(plain.trace.length, 32);
});

test('3.7d/M38(4) GREEN GUARD: caller-set target.warded blocks relay casts and blow powers, not DoT rounds', () => {
  // M38(4) is a caller-set flag on a relay body, not the relay's own shield clock. The gateway here is the ordinary
  // `weaponBlow` ward gate: casts (`cwsEligible`), the four blow power channels and the echo are suppressed; rounds
  // keep ticking. A green guard because the code already behaves this way; it fails only if a future edit makes the
  // relay's `target.warded` inert on blows or starts gating rounds.
  const item = sword([1]);
  item.affixes = [{ id: 'slayer', param: 'daedra', value: 20 }];
  const ch = simCharacter(BASIC(), item);
  const base = gateTarget(45, { health: 20000 });
  const scratch = { ...base, activeEffects: [] };
  resolveCwsCast({
    spell: spell({ mag: 100, rounds: 10 }), caster: { entity: ch }, casterLevel: 45, target: scratch,
    rolls: () => 0.5, hurt: () => {},
  });
  const primed = (warded) => ({ ...base, warded, activeEffects: scratch.activeEffects.map((a) => ({ ...a })) });
  const args = {
    health: 20000, weapon: weaponOf(item), seed: 7, trace: true, maxSeconds: 10,
    standard: new Map([[1, spell({ mag: 100, rounds: 10, direct: 50 })]]),
  };
  const plain = simulateRelayFight(ch, { ...args, target: primed(false) });
  const warded = simulateRelayFight(ch, { ...args, target: primed(true) });
  assert.ok(plain.claimsByKind.proc > 0, 'the control casts');
  assert.equal(warded.claimsByKind.proc, 0, 'target.warded suppresses the cast');
  assert.ok(plain.claimsByKind.dot > 0, 'the primed entry ticks on the control');
  assert.ok(warded.claimsByKind.dot > 0, 'DoT rounds are not ward-gated');
  assert.ok(warded.claimLog.some((c) => c.kind === 'dot'), 'a primed round is still a dot claim');
  const meanBlow = (r) => {
    const rows = r.claimLog.filter((c) => c.kind === 'blow');
    return rows.reduce((a, c) => a + c.claim, 0) / rows.length;
  };
  const p = meanBlow(plain);
  const w = meanBlow(warded);
  assert.ok(p > w * 1.05, `the warded blow carries no slayer line: ${p.toFixed(2)} vs ${w.toFixed(2)}`);
  // This is the caller-set `target.warded` flag only; the card's `warded` trait is a health pool (bossTake), not this flag.
});
