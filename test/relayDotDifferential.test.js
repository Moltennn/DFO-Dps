/*
 * test/relayDotDifferential.test.js - Stage 3.7f: CWS, Many Endings and Continuous Damage in a relay fight, against the
 * upstream compositor.
 *
 * The oracle (`test/harness/relayFightOracle.mjs` `upstreamRelayEvents`) drives the vendored path for a fixed attack
 * list: `calculateAttackDamage` (whose `enchantCtx.applySpellToTarget` runs the vendored `effects.applySpell`, so the
 * cast is resolved INSIDE the blow's formula by `systems/enchantments.js`), the seeded Flow/echo path, the vendored
 * `effects.tickActiveEffects` for the round clock, and `gateBrain.applyHit` for every claim. The local fight is fed the
 * same upstream outcomes through the event seam and makes its own claims; the two CLAIM LOGS must agree claim for claim.
 *
 * Ordering (ASSUMPTION, the same rule as M35 and M38 - upstream has no tie to read): a cast's claim lands before the
 * blow's claim at one timestamp; a round at a blow's own timestamp lands after the blow; rounds fall at k * 5 s from
 * t=0 (`src/spells.js:21`); a shield (`t < shieldUntil`) refuses a cast outright and is left to the engine for a round.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { gateTarget, weaponOf } from '../src/model.js';
import { simulateRelayFight } from '../src/relayFight.js';
import { resolveCwsCast } from '../src/cws.js';
import { MAGIC_ROUND_SECONDS } from '../src/spells.js';
import { character, simCharacter, upstreamEntity, weapon } from './harness/fixtures.mjs';
import { upstream } from './harness/upstream.mjs';
import { oracleEntity, upstreamBody } from './harness/upstreamBodies.mjs';
import { oracleItem } from './harness/fightOracle.mjs';
import { upstreamRelayEvents } from './harness/relayFightOracle.mjs';
import { relayEventArgs } from './harness/relayEventSeam.mjs';

const BASIC = () => character({
  level: 45, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const sword = (params = []) => {
  const it = weapon(121, { material: 9 });
  if (params.length) it.enchantments = params.map((param) => ({ type: 2, param }));
  return it;
};
/** The echo item: the same blade with Many Endings on it. */
const echoSword = () => ({ ...sword([1]), rarity: 'rare', imprint: 'warp-edge' });

/** One spell: a Continuous Damage Health (1,0) round, and/or an instant (4,0) hit. */
const spell = ({ index = 1, mag = 20, rounds = 5, direct = 0 } = {}) => ({
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

/** A seeded draw script: the listed values, then `fallback`. `used()` counts every draw. */
const scripted = (values, fallback = 0.5) => {
  let i = 0;
  const fn = () => { const v = i < values.length ? values[i] : fallback; i += 1; return v; };
  fn.used = () => i;
  return fn;
};
/** Three draws a round takes: the base range, the level range, the throw. */
const roundDraws = (n, seed = 0) => Array.from({ length: n * 3 }, (_, i) => ((seed + i * 37) % 97) / 97);
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * One fight on both sides: the oracle drives the vendored compositor over `events`; the local fight is fed the same
 * upstream outcomes through the event seam. A `prime` spell is cast on both bodies first (an entry that exists before
 * the first attack), its draws taken from the same script.
 */
async function compare({
  desc = BASIC(), item, events, level = 45, pool = 1000, seed = 1, shieldUntil = 0, standard = null, draws = null,
  prime = null, maxSeconds = 40, localDraws = null,
} = {}) {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const attacker = upstreamEntity(desc);
  const upBody = oracleEntity(body);
  upBody.activeEffects = [];
  const script = draws ?? [];
  let localEntry = null;
  let used = 0;
  if (prime) {
    // The oracle casts on its own body; the local resolves the same cast on a scratch target to get ITS entry. Each side
    // takes its draws from the same script, and the fight's own cast stream starts after them.
    u.effects.applySpell(prime, level, upBody, { hurt: () => {} }, scripted([...script]), { entity: attacker });
    const primed = upBody.activeEffects.length;
    const scratch = { ...gateTarget(level, { health: pool }), activeEffects: [] };
    const localRolls = scripted([...script]);
    resolveCwsCast({
      spell: prime, caster: { entity: { isPlayer: true, level, online: false } }, casterLevel: level,
      target: scratch, rolls: localRolls, hurt: () => {},
    });
    localEntry = scratch.activeEffects[0] ?? null;
    used = localRolls.used();
    assert.equal(primed, 1, 'the priming cast leaves one entry on the oracle body');
    assert.ok(localEntry, 'and one on the local body');
  }
  const up = await upstreamRelayEvents(u, {
    desc, item: oracleItem(item), body: upBody, level, pool, events, seed, shieldUntil, standard,
    cwsRolls: scripted(script.slice(used)), maxSeconds,
  });
  const target = { ...gateTarget(level, { health: pool }), activeEffects: localEntry ? [{ ...localEntry }] : [] };
  const ch = simCharacter(desc, item);
  const local = simulateRelayFight(ch, {
    target, health: pool, weapon: weaponOf(item),
    ...relayEventArgs(events.map((e, i) => ({ t: e.t, hand: e.hand, outcome: up.rows[i].outcome }))),
    trace: true, seed, shieldUntil, standard, maxSeconds,
    cwsRolls: scripted((localDraws ?? script).slice(used)),
  });
  return { up, local };
}

/** The local claim log against the oracle's: no divergence, field by field. */
function assertSameClaims(up, local) {
  assert.equal(local.claimLog.length, up.claims.length,
    `claim count: local ${local.claimLog.length} vs oracle ${up.claims.length} (${local.claimLog.map((c) => c.kind).join(',')} | ${up.claims.map((c) => c.kind).join(',')})`);
  let clipped = 0;
  for (let i = 0; i < up.claims.length; i += 1) {
    const a = local.claimLog[i];
    const b = up.claims[i];
    clipped += a.clipped;
    const at = `claim ${i} (${b.kind} at ${b.t})`;
    assert.equal(a.kind, b.kind, `${at}: kind`);
    assert.ok(near(a.t, b.t), `${at}: t ${a.t} vs ${b.t}`);
    assert.equal(a.claim, b.claim, `${at}: claim ${a.claim} vs ${b.claim}`);
    assert.ok(near(a.got, b.got), `${at}: got ${a.got} vs ${b.got}`);
    assert.ok(near(a.bucket, b.bucket), `${at}: bucket ${a.bucket} vs ${b.bucket}`);
    assert.ok(near(a.tokens, b.tokens), `${at}: tokens ${a.tokens} vs ${b.tokens}`);
    assert.ok(near(a.hp, b.hp), `${at}: hp ${a.hp} vs ${b.hp}`);
    assert.ok(near(clipped, b.clipped), `${at}: clipped ${clipped} vs ${b.clipped}`);
  }
}

test('7. a late first cast: the round clock does not bill rounds retroactively', async () => {
  // The first attack lands after the 5 s and 10 s anchors with no live entry: the oracle's round clock must advance with
  // the fight's clock, not burst the missed anchors when the first cast finally creates the entry.
  const standard = new Map([[1, spell({ mag: 40, rounds: 6, direct: 30 })]]);
  const events = [{ t: 13, hand: 'main' }, { t: 14, hand: 'main' }];
  const { up, local } = await compare({ item: sword([1]), events, standard, draws: roundDraws(40), maxSeconds: 40 });
  const early = up.claims.filter((c) => c.kind === 'dot' && c.t < 13);
  assert.deepEqual(early, [], 'no round is billed before the first cast exists');
  assert.ok(up.claims.some((c) => c.kind === 'dot' && c.t > 13), 'the rounds after the cast are billed');
  assertSameClaims(up, local);
});

test('0. NEGATIVE CONTROL: a one-draw shift in the cast script makes the claims diverge', async () => {
  // Proves the comparison bites without perturbing the repository: the same fixture, the local cast stream shifted one
  // draw. The aligned run agrees claim for claim AND carries both kinds (so empty-vs-empty cannot pass); the shifted one
  // must not.
  const standard = new Map([[1, spell({ mag: 40, rounds: 5, direct: 30 })]]);
  const events = [0.5, 1.4, 2.3].map((t) => ({ t, hand: 'main' }));
  const draws = roundDraws(30);
  const ok = await compare({ item: sword([1]), events, standard, draws, maxSeconds: 20 });
  assert.ok(ok.up.claims.some((c) => c.kind === 'proc'), 'the aligned run has a cast claim');
  assert.ok(ok.up.claims.some((c) => c.kind === 'dot'), 'and a round claim');
  assertSameClaims(ok.up, ok.local);
  const shifted = [...draws.slice(1), draws[0]];
  const bad = await compare({ item: sword([1]), events, standard, draws, localDraws: shifted, maxSeconds: 20 });
  const diverged = bad.local.claimLog.length !== bad.up.claims.length
    || bad.local.claimLog.some((c, i) => !bad.up.claims[i] || c.claim !== bad.up.claims[i].claim);
  assert.ok(diverged, 'a one-draw perturbation of the cast changes at least one claim');
});

test('0b. NEGATIVE CONTROL: the comparison detects an ordering swap and a split merged claim', async () => {
  // The one-draw control moves amounts. An ORDERING mutation (cast after blow) and a MERGE mutation (the cast's direct
  // damage and first round split in two) keep the amounts, so the comparator must catch them on order/length alone. The
  // expectations are perturbed here, never the repository.
  const standard = new Map([[1, spell({ mag: 40, rounds: 5, direct: 30 })]]);
  const events = [0.5, 1.4, 2.3].map((t) => ({ t, hand: 'main' }));
  const { up, local } = await compare({ item: sword([1]), events, standard, draws: roundDraws(30), maxSeconds: 20 });
  assertSameClaims(up, local);
  // (a) the cast claim moved after the blow claim it preceded
  const swap = up.claims.findIndex((c, i) => c.kind === 'proc' && up.claims[i + 1]?.kind === 'blow');
  assert.ok(swap >= 0, 'the fixture has an adjacent cast/blow pair');
  const swapped = [...up.claims];
  [swapped[swap], swapped[swap + 1]] = [swapped[swap + 1], swapped[swap]];
  assert.throws(() => assertSameClaims({ ...up, claims: swapped }, local), /kind|claim/i, 'the order swap is caught');
  // (b) the merged cast claim split into two
  const split = up.claims.flatMap((c) => (c.kind === 'proc'
    ? [{ ...c, claim: Math.ceil(c.claim / 2) }, { ...c, claim: Math.floor(c.claim / 2) }]
    : [c]));
  assert.throws(() => assertSameClaims({ ...up, claims: split }, local), /count/i, 'the split is caught');
});

test('1. CWS direct damage only: one cast claim, before the blow claim at the same time', async () => {
  const standard = new Map([[1, spell({ direct: 60, rounds: 0 })]]);
  const events = [0.5, 1.2, 1.9, 2.6].map((t) => ({ t, hand: 'main' }));
  const { up, local } = await compare({ item: sword([1]), events, standard, draws: roundDraws(12) });
  assert.ok(up.claims.some((c) => c.kind === 'proc'), 'the oracle cast');
  assertSameClaims(up, local);
  const at = up.claims.findIndex((c) => c.kind === 'proc');
  assert.equal(up.claims[at + 1]?.kind, 'blow');
  assert.ok(near(up.claims[at + 1].t, up.claims[at].t));
});

test('2. CWS + DoT: the cast\'s first round rides the cast claim, later rounds one claim per 5 s', async () => {
  const standard = new Map([[1, spell({ mag: 40, rounds: 5, direct: 30 })]]);
  const events = [0.5, 1.4, 2.3, 3.2, 4.1].map((t) => ({ t, hand: 'main' }));
  const { up, local } = await compare({ item: sword([1]), events, standard, draws: roundDraws(30), maxSeconds: 30 });
  const dots = up.claims.filter((c) => c.kind === 'dot');
  assert.ok(dots.length >= 3, 'the rounds claim once each');
  assert.ok(dots.every((c) => c.t % MAGIC_ROUND_SECONDS === 0), 'each round lands on a 5 s anchor');
  assert.ok(dots.every((c, i) => i === 0 || c.t > dots[i - 1].t), 'and they are in clock order');
  assertSameClaims(up, local);
});

test('3. CWS + Many Endings: the echo stays in the blow claim, the cast claim is its own', async () => {
  const standard = new Map([[1, spell({ mag: 40, rounds: 3, direct: 30 })]]);
  const events = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5].map((t) => ({ t, hand: 'main' }));
  // The echo is a chance: find a seed that rolls one, and check every seed's claims agree.
  let sawEcho = false;
  for (let seed = 1; seed <= 8 && !sawEcho; seed += 1) {
    const { up, local } = await compare({ item: echoSword(), events, standard, draws: roundDraws(30), maxSeconds: 20, seed });
    assert.ok(up.claims.some((c) => c.kind === 'proc'), `seed ${seed}: the fight cast`);
    assertSameClaims(up, local);
    const echoRow = up.rows.find((r) => r.echoHits > 0);
    if (!echoRow) continue;
    // The echo is INSIDE the blow claim, not a claim of its own: the blow claim at that timestamp is the pre-echo blow
    // plus the owed echo (hostBlow = preEchoBlow + echoDamage), so it is strictly above the pre-echo blow's rounded size.
    const blowClaim = up.claims.find((c) => c.kind === 'blow' && near(c.t, echoRow.t));
    assert.ok(blowClaim, `seed ${seed}: the echo event had a blow claim`);
    assert.equal(blowClaim.claim, Math.round(echoRow.preEchoBlow + echoRow.echoDamage), 'the claim is the whole blow, echo included');
    assert.ok(blowClaim.claim > Math.round(echoRow.preEchoBlow), 'the echo is not a separate claim');
    sawEcho = true;
  }
  assert.ok(sawEcho, 'an echo claim is covered');
});

test('4. a cast inside a shield: the oracle refuses it at the CastWhenStrikes gate, the local refuses it too', async () => {
  const standard = new Map([[1, spell({ direct: 60, rounds: 0 })]]);
  const events = [0.5, 1.5, 3].map((t) => ({ t, hand: 'main' }));
  const { up, local } = await compare({ item: sword([1]), events, standard, draws: roundDraws(12), shieldUntil: 2 });
  assert.equal(up.rows[0].warded, true);
  assert.ok(up.claims.filter((c) => c.kind === 'proc').every((c) => c.t >= 2), 'no cast lands inside the shield');
  assert.ok(up.claims.some((c) => c.kind === 'proc'), 'and the fight casts once it drops');
  assertSameClaims(up, local);
});

test('5. a DoT round inside a shield: the entry ticks, the engine refuses the claim', async () => {
  const prime = spell({ mag: 40, rounds: 6 });
  const { up, local } = await compare({
    item: sword(), events: [{ t: 0.5, hand: 'main' }], prime, draws: roundDraws(40), shieldUntil: 7, maxSeconds: 40,
  });
  const dots = up.claims.filter((c) => c.kind === 'dot');
  assert.ok(dots.length >= 2, 'the primed entry keeps ticking');
  assert.equal(dots[0].t, MAGIC_ROUND_SECONDS);
  assert.equal(dots[0].got, 0, 'the shielded round is refused by the engine');
  assert.ok(dots[1].got > 0, 'the next round is paid');
  assertSameClaims(up, local);
});

test('6. a CWS kill: the cast claim kills and no blow claim follows', async () => {
  const standard = new Map([[1, spell({ direct: 900, rounds: 0 })]]);
  const { up, local } = await compare({ item: sword([1]), events: [{ t: 0.5, hand: 'main' }, { t: 1.5, hand: 'main' }], standard, pool: 100, draws: roundDraws(12) });
  assert.equal(up.claims.length, 1, 'one claim: the cast');
  assert.equal(up.claims[0].kind, 'proc');
  assert.ok(up.claims[0].got > 0);
  assert.equal(local.kill, true);
  assert.equal(local.killSource, 'cws');
  assertSameClaims(up, local);
});
