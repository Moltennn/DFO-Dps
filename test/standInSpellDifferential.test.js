/*
 * test/standInSpellDifferential.test.js - the relay's spell claims against the game's own claim bridge.
 *
 * ORACLE: vendor:scenes/gate/standInSpell.js (vendored since the wider re-pin) - the REAL `createStandInSpell`, driven
 * through its public door (`spellOnBoss` for a Cast When Strikes cast, `standInRound` for a frame of the shared round
 * clock) with a fake host and clock. Every claim the host's `landOnBoss` receives is recorded: that number is what the
 * game sends to the relay (`gateCourt.hit` then rounds it, vendor:scenes/gate/gateCourt.js:1164, and drops anything
 * under one point, :1165).
 * LOCAL: `simulateRelayFight`'s own `claimLog` for the same spell, the same body and the same dice (`cwsRolls`).
 *
 * What the source says, and what is compared (each case states whether it is an oracle check or a local invariant):
 *   - COURT_ROUND_MS is one game minute online, 5000 ms (net/wire.js ONLINE_MINUTES_PER_MS = 12 / 60 / 1000; gateCourt.js
 *     :159): the project's 5 s round is the source's, not an assumption (ORACLE: the vendored constants).
 *   - A cast is ONE claim: every hurt of the cast summed (its direct damage and its first round), then the boss's
 *     element-proof trait applied ONCE to the sum (standInSpell.js:204-205 `bossStrike(entity, counted, {kind:'spell',
 *     element})`), a sum under one point sending nothing (:206). A carried round resists EACH hurt as it ticks
 *     (:51-58 `counting(got, resist)`) and the round's sum is the claim (:150 `land(got.n)` when `got.n >= 1`).
 *   - The round clock is the WORLD's: `Math.floor(now() / COURT_ROUND_MS)` (:115, :122), so the phase of the rounds
 *     against a fight's own start is arbitrary; the local model anchors them at the fight's t = 0 (ASSUMPTION M35).
 *     Only AMOUNTS are compared here, never times, so the phase does not enter.
 * The turned-round case checks the vendor host only; relayDotFight.test.js checks engine refusal separately.
 * Not compared: the stun window, a missed frame's catch-up (:129-143), and mid-DoT potency changes (M34).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gateTarget, weaponOf } from '../src/model.js';
import { simulateRelayFight } from '../src/relayFight.js';
import { MAGIC_ROUND_SECONDS } from '../src/spells.js';
import { ELEMENT_TRAITS } from '../src/bossTraits.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { createStandInSpell } from '../vendor/upstream/a3eb1605/src/scenes/gate/standInSpell.js';
import { COURT_ROUND_MS, createGateCourt } from '../vendor/upstream/a3eb1605/src/scenes/gate/gateCourt.js';
import { ATTACKS, COURTS, COURT_CENTRE, HIT_KINDS, newFight } from '../vendor/upstream/a3eb1605/src/net/gate/gateBrain.js';
import { ONLINE_MINUTES_PER_MS } from '../vendor/upstream/a3eb1605/src/net/wire.js';

const BASIC = () => character({
  level: 45, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});

/** A weapon carrying one Cast When Strikes row (enchantment type 2, spell 1). */
const sword = () => {
  const it = weapon(121, { material: 9 });
  it.enchantments = [{ type: 2, param: 1 }];
  return it;
};

/** One spell: a Continuous Damage Health (1,0) and an instant (4,0) hit, of `element`. */
const spellOf = ({ element = 4, mag = 200, rounds = 5, direct = 150 } = {}) => ({
  name: 'Claim bridge', index: 1, element, rangeType: 1,
  effects: [
    {
      type: 1, subType: 0,
      magnitudeBaseLow: mag, magnitudeBaseHigh: mag, magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
      durationBase: rounds, durationMod: 0, durationPerLevel: 1, chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
    },
    {
      type: 4, subType: 0,
      magnitudeBaseLow: direct, magnitudeBaseHigh: direct, magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
      durationBase: 0, durationMod: 0, durationPerLevel: 1, chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
    },
  ],
});

/** A seeded draw script (no Math.random): the listed values, then 0.5. */
const scripted = (values) => { let i = 0; return () => (i < values.length ? values[i++] : 0.5); };
const VALUES = [0.1, 0.9, 0.4, 0.2, 0.8, 0.6, 0.3, 0.7, 0.55, 0.45, 0.65, 0.35];

/** The game's own claims: a cast at clock 0, then `frames` frames of the shared round clock, every claim recorded. */
function oracleClaims({ ch, target, spell, values = VALUES, frames = 6, turnedRound = 0 }) {
  let clock = 0;
  const claims = [];
  const entity = { ...target, activeEffects: [] };
  const body = { entity, warded: false };
  const player = Object.assign(Object.create(ch), { health: 100 });
  const host = {
    player, say() {}, rolls: scripted(values), now: () => clock,
    boss: () => body,
    crystals: () => [], host: () => [], rival: () => null,
    landOnBoss: (body, d, kind, round) => { claims.push({ d, round: round === true }); return true; },
    landOnCrystal: () => false, landOnHost: () => false, landOnRival: () => false,
    nextArenaQ() {}, trapNow: () => null, onTrap: () => false,
  };
  const door = createStandInSpell(host);
  const went = door.spellOnBoss(spell);
  for (let k = 1; k <= frames; k += 1) {
    clock = k * COURT_ROUND_MS;
    body.warded = k === turnedRound;
    door.standInRound();
  }
  return { went, claims };
}

/** The local relay fight's cast and round claims, in order, for the same spell body and dice. */
function localClaims({ ch, item, target, spell, values = VALUES }) {
  const r = simulateRelayFight(ch, {
    target, health: 100000, weapon: weaponOf(item), seed: 7, trace: true, maxBlows: 1, maxSeconds: 60,
    cwsRolls: scripted(values), standard: new Map([[1, spell]]),
  });
  return r.claimLog.filter((c) => c.kind === 'proc' || c.kind === 'dot').map((c) => ({ kind: c.kind, claim: c.claim }));
}

const FLAME = ELEMENT_TRAITS.indexOf('flameproof');
const FROST = ELEMENT_TRAITS.indexOf('frostproof');

test('ORACLE: the round is COURT_ROUND_MS = 5000 ms, one game minute online - the project\'s 5 s, from the source', () => {
  assert.equal(ONLINE_MINUTES_PER_MS, 12 / 60 / 1000, 'net/wire.js:240');
  assert.equal(COURT_ROUND_MS, Math.round(1 / ONLINE_MINUTES_PER_MS), 'gateCourt.js:159');
  assert.equal(COURT_ROUND_MS, 5000);
  assert.equal(COURT_ROUND_MS, MAGIC_ROUND_SECONDS * 1000, 'the local round is the source\'s round');
});

test('ORACLE: the court rounds before dropping a sub-point hit, and sends at the shield end', () => {
  // Real hit door (gateCourt.js:1159-1168@a3eb1605); the transport just records what gets sent.
  const state = newFight(1, 0, 1e6, 'ruhn');
  state.shieldUntil = 1000;
  // A leap in court two makes bossPlace use the real leapAt instead of the stubbed idle bossAt.
  const [x, z] = COURTS[1];
  state.atk = { a: ATTACKS.leap.id, at: 1000, x, z, tg: [[x + 1, z]] };
  let clock = 999;
  const sent = [];
  const court = createGateCourt({
    link: { state: () => state }, now: () => clock, rng: () => 0.5,
    feet: () => [COURT_CENTRE[0] + x, COURT_CENTRE[1], COURT_CENTRE[2] + z],
    send: (hit) => { sent.push(hit); return true; },
  });
  const hit = (d) => court.hit({ d, r: HIT_KINDS.Spell });
  assert.equal(hit(2.5), false, 'one millisecond before shield end');
  assert.deepEqual(sent, [], 'the shielded hit never reaches transport');
  clock = state.shieldUntil;
  assert.equal(hit(0.49), false, 'rounds to zero');
  assert.deepEqual(sent, [], 'zero never reaches transport');
  assert.equal(hit(0.5), true, 'rounds to one at the exact shield end');
  assert.equal(hit(2.5), true, 'a nonzero half point rounds up too');
  assert.deepEqual(sent.map(({ d, r }) => [d, r]), [[1, HIT_KINDS.Spell], [3, HIT_KINDS.Spell]]);
});

for (const [name, traits, element, why] of [
  ['no trait', [], 4, 'nothing resists: the cast sum and each round sum are the claims'],
  ['a trait of ANOTHER element', ['frostproof'], FLAME, 'a fire spell on a frostproof boss is not resisted'],
  ['the MATCHING element-proof trait', ['flameproof'], FLAME, 'the cast sum is resisted once, each round tick on its own'],
]) {
  test(`ORACLE: the cast claim and the round claims equal the game's - ${name} (${why})`, () => {
    const item = sword();
    const ch = simCharacter(BASIC(), item);
    const target = gateTarget(45, { health: 100000, traits });
    const spell = spellOf({ element });
    const oracle = oracleClaims({ ch, target, spell });
    assert.equal(oracle.went, true, 'the vendored door took the cast');
    assert.ok(oracle.claims.length >= 3, `the oracle sent a cast claim and rounds (${oracle.claims.length})`);
    assert.equal(oracle.claims[0].round, false, 'the first claim is the cast\'s');
    assert.ok(oracle.claims.slice(1).every((c) => c.round), 'the rest are round claims');
    const expected = oracle.claims.map((c) => Math.round(c.d)).filter((d) => d >= 1);
    const local = localClaims({ ch, item, target, spell });
    assert.deepEqual(local.map((c) => c.claim), expected,
      `the local relay fight sends the same claims, in the same order, as standInSpell.js (traits ${JSON.stringify(traits)})`);
    assert.equal(local[0].kind, 'proc', 'the cast is the first claim');
    assert.ok(local.slice(1).every((c) => c.kind === 'dot'));
  });
}

test('ORACLE (control): a matching element-proof trait really changes the claims, so the cases above are not vacuous', () => {
  const item = sword();
  const ch = simCharacter(BASIC(), item);
  const spell = spellOf({ element: FROST });
  const plainOracle = oracleClaims({ ch, target: gateTarget(45, { health: 100000, traits: [] }), spell });
  const proofOracle = oracleClaims({ ch, target: gateTarget(45, { health: 100000, traits: ['frostproof'] }), spell });
  const sum = (o) => o.claims.reduce((a, c) => a + c.d, 0);
  assert.ok(sum(proofOracle) < sum(plainOracle) * 0.6, `the game cuts a matching spell (${sum(proofOracle)} vs ${sum(plainOracle)})`);
});

test('ORACLE: a turned DoT round ticks but the host sends no claim', () => {
  // standInSpell.js:131-151 consumes the tick; :219-236 suppresses the host callback, before any engine refusal.
  const args = {
    ch: simCharacter(BASIC(), sword()), target: gateTarget(45, { health: 100000, traits: [] }), spell: spellOf(),
  };
  const plain = oracleClaims(args);
  const turned = oracleClaims({ ...args, turnedRound: 1 });
  assert.equal(turned.went, true, 'the cast lands before the ward');
  assert.equal(plain.claims[1]?.round, true, 'the unwarded first round sends a claim');
  assert.ok(plain.claims.length > 2, 'the control has later round claims');
  assert.deepEqual(turned.claims, plain.claims.filter((_, i) => i !== 1), 'only the turned round is lost, not delayed');
});
