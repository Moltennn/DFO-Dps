/*
 * test/dotDifferential.test.js - Stage 3.6 independent DoT (Continuous Damage Health, 1/0) lifecycle differential.
 *
 * The oracle is the pinned game's own `applySpell` and `tickActiveEffects`, given a seeded `rolls` and a hurt sink. The
 * local side is `src/cws.js`'s `resolveCwsCast` (the cast) and `src/cws.js`'s `tickActiveEffects` (one magic round).
 * Nothing here copies a local number into the oracle: every upstream call is handed only test inputs (spell record,
 * target, rolls).
 *
 * What is compared:
 *   - the first tick inside the cast, and the entry it leaves (`roundsRemaining`);
 *   - the draws one tick consumes;
 *   - the tick count over the duration, and the removal pass that acts on nothing;
 *   - the per-tick magnitude and saving-throw re-roll;
 *   - a like-kind re-cast renewing (never stacking, never adding a tick) a live or a lapsed incumbent;
 *   - two different DoT spells merging into one entry, the incumbent keeping its own settings.
 *
 * The local API this file pins: `resolveCwsCast({ ..., target, rolls, hurt })` pushes the `continuousDamage` entry onto
 * `target.activeEffects`, runs the cast's first round through `hurt(n, { round: true })`, and consumes that round;
 * `src/cws.js`'s `tickActiveEffects(target, { hurt }, rolls)` is one magic round: an entry at 0 rounds is removed
 * without acting, a live one acts, decrements, and stays through the pass that reaches 0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { upstream, referenceFoe } from './harness/upstream.mjs';
import { dotSpell } from './harness/fixtures.mjs';
import { makeTarget } from '../src/target.js';
import * as cws from '../src/cws.js';

/** Same shape as test/cwsDifferential.test.js's out-of-combat caster: a player with no gear and no school climb. */
const CASTER = {
  isPlayer: true, level: 30, career: {}, skills: {}, activeEffects: [],
  stats: { strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50 },
  _mods: { stats: {}, skills: {}, statMax: {} },
};

/**
 * A seeded draw script (no `Math.random`): the listed values, then `fallback`. `used()` counts EVERY draw, fallbacks
 * included - unlike test/cwsDifferential.test.js's helper, which counts only the listed ones and compares the two sides
 * relatively. The absolute count is the point of the draw-parity test.
 */
const scripted = (values, fallback = 0.5) => {
  let i = 0;
  const fn = () => {
    const v = i < values.length ? values[i] : fallback;
    i += 1;
    return v;
  };
  fn.used = () => i;
  return fn;
};

/** The oracle body: the same fixture the CWS differential mints. */
const upBody = (u, over = {}) => {
  const b = { ...referenceFoe(u, 30, 'tough') };
  Object.assign(b, {
    health: 1000, maxHealth: 1000, activeEffects: [], career: {}, skills: {},
    _mods: { stats: {}, skills: {}, statMax: {} }, magicka: 0, maxMagicka: 1000,
  }, over);
  return b;
};

/** The same body on the local side. */
const localBody = (over = {}) => makeTarget({
  isClass: false, level: 30, careerIndex: -1, career: {},
  stats: { strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50 },
  skills: {}, activeEffects: [], _mods: { stats: {}, skills: {}, statMax: {} },
  health: 1000, maxHealth: 1000, magicka: 0, maxMagicka: 1000,
  ...over,
});

/** The hurt sink's record: `round: true` is what a magic round bills (effects.js:727). */
const tick = (n, info) => ({ n, round: info?.round === true });

/** One upstream cast: the landing sink records each round it bills. */
function upCast(u, target, spell, rolls, level = 30) {
  const draws = scripted(rolls);
  const ticks = [];
  const out = u.effects.applySpell(
    spell, level, target, { hurt: (n, info) => { ticks.push(tick(n, info)); } }, draws, { entity: CASTER },
  );
  return { ticks, used: draws.used(), out, target };
}

/** The local cast on the same target and draw script. */
function localCast(target, spell, rolls, level = 30) {
  const draws = scripted(rolls);
  const ticks = [];
  const out = cws.resolveCwsCast({
    spell, caster: { entity: CASTER }, casterLevel: level, target, rolls: draws,
    hurt: (n, info) => { ticks.push(tick(n, info)); },
  });
  return { ticks, used: draws.used(), out, target };
}

/** One upstream magic round for the target (`vendor:systems/effects.js:1986-2026`). */
function upTick(u, target, rolls) {
  const draws = scripted(rolls);
  const ticks = [];
  u.effects.tickActiveEffects(target, { hurt: (n, info) => { ticks.push(tick(n, info)); } }, draws);
  return { ticks, used: draws.used(), target };
}

/** One local magic round for the target - the same pass, on this project's side. */
function localTick(target, rolls) {
  const draws = scripted(rolls);
  const ticks = [];
  cws.tickActiveEffects(target, { hurt: (n, info) => { ticks.push(tick(n, info)); } }, draws);
  return { ticks, used: draws.used(), target };
}

test('DoT: the first tick lands inside the cast and the entry is left at rounds - 1', async () => {
  const u = await upstream();
  const spell = dotSpell({ magnitude: 10, rounds: 5 });

  // applySpell's continuousDamage arm pushes the entry (effects.js:1091-1103); pushActive runs round 1 and decrements
  // (:767-772). durationBase 5 is five rounds, so four are left.
  const up = upCast(u, upBody(u), spell, [0.5]);
  assert.deepEqual(up.ticks, [{ n: 8, round: true }], 'the cast bills one round: 10 rolled, 80% of it kept');
  assert.equal(up.target.activeEffects.length, 1);
  assert.equal(up.target.activeEffects[0].kind, 'continuousDamage');
  assert.equal(up.target.activeEffects[0].roundsRemaining, 4);

  const local = localCast(localBody(), spell, [0.5]);
  assert.deepEqual(local.ticks, up.ticks, 'the local cast bills the same first round');
  assert.equal(local.target.activeEffects.length, 1, 'the local cast leaves one continuousDamage entry');
  assert.equal(local.target.activeEffects[0]?.kind, 'continuousDamage');
  assert.equal(local.target.activeEffects[0]?.roundsRemaining, 4);
});

test('DoT: the draws one tick consumes match the oracle', async () => {
  const u = await upstream();
  const spell = dotSpell({ magnitude: 10, rounds: 5 });
  // rollMagnitude draws twice - the base range, then the level range (spellcast.js:229-235); savingThrow draws once
  // (:218, the Dice100 roll). The elemental-resistance roll (:212) and the absorption/reflection/resistance gates
  // draw nothing while their chances are 0.
  const TICK_DRAWS = 3;
  const up = upCast(u, upBody(u), spell, [0.5]);
  assert.deepEqual(up.ticks, [{ n: 8, round: true }]);
  assert.equal(up.used, TICK_DRAWS, 'the oracle cast tick is 3 draws');
  const upPass = upTick(u, up.target, []);
  assert.deepEqual(upPass.ticks, [{ n: 8, round: true }]);
  assert.equal(upPass.used, TICK_DRAWS, 'a tick pass draws the same 3');

  const local = localCast(localBody(), spell, [0.5]);
  assert.deepEqual(local.ticks, up.ticks);
  assert.equal(local.used, up.used, 'the local cast consumes the same 3 draws');
  const localPass = localTick(local.target, []);
  assert.deepEqual(localPass.ticks, upPass.ticks);
  assert.equal(localPass.used, upPass.used);
});

test('DoT: durationBase 3 bills three rounds over the cast and two passes, and the pass after removes silently', async () => {
  const u = await upstream();
  const spell = dotSpell({ magnitude: 10, rounds: 3 });
  const up = upCast(u, upBody(u), spell, [0.5]);
  assert.deepEqual(up.ticks, [{ n: 8, round: true }], 'round 1, at the cast');
  assert.equal(up.target.activeEffects[0].roundsRemaining, 2);
  const upP1 = upTick(u, up.target, []);
  assert.deepEqual(upP1.ticks, [{ n: 8, round: true }], 'round 2');
  assert.equal(up.target.activeEffects[0].roundsRemaining, 1);
  const upP2 = upTick(u, up.target, []);
  assert.deepEqual(upP2.ticks, [{ n: 8, round: true }], 'round 3');
  assert.equal(up.target.activeEffects[0].roundsRemaining, 0);
  const upP3 = upTick(u, up.target, []);
  assert.deepEqual(upP3.ticks, [], 'an entry at 0 rounds is removed WITHOUT acting (effects.js:2012)');
  assert.equal(up.target.activeEffects.length, 0);
  const upAll = [up.ticks, upP1.ticks, upP2.ticks, upP3.ticks].flat();
  assert.equal(upAll.length, 3, 'three rounds in all');

  const local = localCast(localBody(), spell, [0.5]);
  const localP1 = localTick(local.target, []);
  const localP2 = localTick(local.target, []);
  const localP3 = localTick(local.target, []);
  assert.deepEqual(local.ticks, up.ticks);
  assert.deepEqual(localP1.ticks, upP1.ticks);
  assert.deepEqual(localP2.ticks, upP2.ticks);
  assert.deepEqual(localP3.ticks, upP3.ticks);
  assert.deepEqual([local.ticks, localP1.ticks, localP2.ticks, localP3.ticks].flat(), upAll);
  assert.equal(local.target.activeEffects.length, 0);
});

test('DoT: every tick re-rolls its own magnitude and save', async () => {
  const u = await upstream();
  // A 10..20 magnitude: the base range draw is the 11 values 10 + floor(r * 11).
  const spell = dotSpell({ magnitude: 10, magnitudeHigh: 20, rounds: 5 });
  const up = upCast(u, upBody(u), spell, [0, 0.5, 0.5]);
  assert.deepEqual(up.ticks, [{ n: 8, round: true }], 'cast round: base draw 0 -> 10');
  const upP1 = upTick(u, up.target, [0.99, 0.5, 0.5]);
  assert.deepEqual(upP1.ticks, [{ n: 16, round: true }], 'next round: base draw 0.99 -> 20, not a constant 10');
  const upP2 = upTick(u, up.target, [0.5, 0.5, 0.5]);
  assert.deepEqual(upP2.ticks, [{ n: 12, round: true }], 'third round: base draw 0.5 -> 15, 80% kept');

  const local = localCast(localBody(), spell, [0, 0.5, 0.5]);
  const localP1 = localTick(local.target, [0.99, 0.5, 0.5]);
  const localP2 = localTick(local.target, [0.5, 0.5, 0.5]);
  assert.deepEqual(local.ticks, up.ticks);
  assert.deepEqual(localP1.ticks, upP1.ticks, 'the local round re-rolls, it does not multiply the first tick');
  assert.deepEqual(localP2.ticks, upP2.ticks);
});

test('DoT: a re-cast of a live incumbent renews its rounds and adds no tick (never a stack)', async () => {
  const u = await upstream();
  const spell = dotSpell({ magnitude: 10, rounds: 5 });
  const up = upCast(u, upBody(u), spell, [0.5]);
  assert.deepEqual(up.ticks, [{ n: 8, round: true }]);
  assert.equal(up.target.activeEffects[0].roundsRemaining, 4);
  const upP1 = upTick(u, up.target, []);
  const upP2 = upTick(u, up.target, []);
  assert.deepEqual(upP1.ticks, [{ n: 8, round: true }]);
  assert.deepEqual(upP2.ticks, [{ n: 8, round: true }]);
  assert.equal(up.target.activeEffects.length, 1);
  assert.equal(up.target.activeEffects[0].roundsRemaining, 2);

  // renewActing (effects.js:762-765): a live incumbent runs no round; renewRounds (:628-630) tops it up to the fresh
  // cast's rounds LESS the round pushActive would have spent - 5 - 1 = 4 here, above the incumbent's 2.
  const upRe = upCast(u, up.target, spell, []);
  assert.deepEqual(upRe.ticks, [], 'a renewal of a live incumbent bills nothing');
  assert.equal(upRe.used, 0, 'and draws nothing');
  assert.equal(up.target.activeEffects.length, 1, 'a like-kind re-cast never stacks a second entry');
  assert.equal(up.target.activeEffects[0].roundsRemaining, 4);
  const upAll = [up.ticks, upP1.ticks, upP2.ticks, upRe.ticks].flat();
  assert.equal(upAll.length, 3, 'three rounds across the whole sequence');

  const local = localCast(localBody(), spell, [0.5]);
  const localP1 = localTick(local.target, []);
  const localP2 = localTick(local.target, []);
  const localRe = localCast(local.target, spell, []);
  assert.deepEqual(local.ticks, up.ticks);
  assert.deepEqual(localP1.ticks, upP1.ticks);
  assert.deepEqual(localP2.ticks, upP2.ticks);
  assert.deepEqual(localRe.ticks, upRe.ticks);
  assert.equal(localRe.used, upRe.used);
  assert.equal(local.target.activeEffects.length, 1);
  assert.equal(local.target.activeEffects[0]?.roundsRemaining, 4);
  assert.deepEqual([local.ticks, localP1.ticks, localP2.ticks, localRe.ticks].flat(), upAll);
});

test('DoT: a re-cast over a lapsed incumbent runs the round the cast would have run', async () => {
  const u = await upstream();
  const spell = dotSpell({ magnitude: 10, rounds: 3 });
  const up = upCast(u, upBody(u), spell, [0.5]);
  assert.deepEqual(up.ticks, [{ n: 8, round: true }]);
  const upP1 = upTick(u, up.target, []);
  const upP2 = upTick(u, up.target, []);
  assert.deepEqual(upP1.ticks, [{ n: 8, round: true }]);
  assert.deepEqual(upP2.ticks, [{ n: 8, round: true }], 'the last listed round acts');
  assert.equal(up.target.activeEffects[0].roundsRemaining, 0, 'and the entry is still listed, not yet swept');

  // renewActing's `roundsRemaining <= 0` arm (effects.js:763): the incumbent runs its round on the re-cast, then
  // renewRounds tops it up to 3 - 1 = 2.
  const upRe = upCast(u, up.target, spell, [0.5]);
  assert.deepEqual(upRe.ticks, [{ n: 8, round: true }], 'the renewal bills the round a fresh cast would have');
  assert.equal(upRe.used, 3);
  assert.equal(up.target.activeEffects.length, 1);
  assert.equal(up.target.activeEffects[0].roundsRemaining, 2);
  const upP3 = upTick(u, up.target, []);
  assert.deepEqual(upP3.ticks, [{ n: 8, round: true }]);
  const upAll = [up.ticks, upP1.ticks, upP2.ticks, upRe.ticks, upP3.ticks].flat();
  assert.equal(upAll.length, 5, '3 rounds, then the renewal round and one more');

  const local = localCast(localBody(), spell, [0.5]);
  const localP1 = localTick(local.target, []);
  const localP2 = localTick(local.target, []);
  const localRe = localCast(local.target, spell, [0.5]);
  assert.deepEqual(local.ticks, up.ticks);
  assert.deepEqual(localP1.ticks, upP1.ticks);
  assert.deepEqual(localP2.ticks, upP2.ticks);
  assert.deepEqual(localRe.ticks, upRe.ticks);
  assert.equal(localRe.used, upRe.used);
  assert.equal(local.target.activeEffects.length, 1);
  assert.equal(local.target.activeEffects[0]?.roundsRemaining, 2, 'read before the next pass tick');
  const localP3 = localTick(local.target, []);
  assert.deepEqual(localP3.ticks, upP3.ticks);
  assert.deepEqual([local.ticks, localP1.ticks, localP2.ticks, localRe.ticks, localP3.ticks].flat(), upAll);
});

test('DoT: two different DoT spells merge into the incumbent, which keeps its own settings', async () => {
  const u = await upstream();
  const first = dotSpell({ magnitude: 10, rounds: 5 });
  const second = dotSpell({ magnitude: 30, rounds: 3, index: 2, name: 'Other DoT' });
  const up = upCast(u, upBody(u), first, [0.5]);
  assert.deepEqual(up.ticks, [{ n: 8, round: true }]);

  // IsLikeKind is settings-blind for ContinuousDamageHealth (effects.js:1092-1094): the second cast claims the first
  // entry, keeps its magnitude and settings, and renewRounds does not shorten 4.
  const upSecond = upCast(u, up.target, second, []);
  assert.deepEqual(upSecond.ticks, [], 'the second spell bills no round of its own');
  assert.equal(upSecond.used, 0);
  assert.equal(up.target.activeEffects.length, 1, 'one entry, not two');
  assert.equal(up.target.activeEffects[0].roundsRemaining, 4, 'a shorter re-cast never shortens the incumbent');
  assert.equal(up.target.activeEffects[0].effect.magnitudeBaseLow, 10, 'the incumbent keeps its own magnitude');
  assert.equal(up.target.activeEffects[0].effect.durationBase, 5, 'and its own settings');
  const upP1 = upTick(u, up.target, []);
  assert.deepEqual(upP1.ticks, [{ n: 8, round: true }], 'the next round bills the incumbent 10, not the arrival 30');

  const local = localCast(localBody(), first, [0.5]);
  const localSecond = localCast(local.target, second, []);
  assert.deepEqual(local.ticks, up.ticks);
  assert.deepEqual(localSecond.ticks, upSecond.ticks);
  assert.equal(localSecond.used, upSecond.used);
  assert.equal(local.target.activeEffects.length, 1);
  assert.equal(local.target.activeEffects[0]?.roundsRemaining, 4, 'read before the next pass tick');
  const localP1 = localTick(local.target, []);
  assert.deepEqual(localP1.ticks, upP1.ticks);
});

test('DoT: the expiry pass bills nothing', async () => {
  const u = await upstream();
  const spell = dotSpell({ magnitude: 10, rounds: 1 });
  const up = upCast(u, upBody(u), spell, [0.5]);
  assert.deepEqual(up.ticks, [{ n: 8, round: true }], 'a one-round spell bills once, at the cast');
  assert.equal(up.target.activeEffects[0].roundsRemaining, 0);
  const upP1 = upTick(u, up.target, []);
  assert.deepEqual(upP1.ticks, [], 'the entry is removed without acting');
  assert.equal(upP1.used, 0);
  assert.equal(up.target.activeEffects.length, 0);

  const local = localCast(localBody(), spell, [0.5]);
  const localP1 = localTick(local.target, []);
  assert.deepEqual(local.ticks, up.ticks);
  assert.deepEqual(localP1.ticks, upP1.ticks);
  assert.equal(localP1.used, upP1.used);
  assert.equal(local.target.activeEffects.length, 0);
});
