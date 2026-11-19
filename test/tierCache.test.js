/*
 * test/tierCache.test.js - the batch-level blow-tier cache (`simulateFights`).
 *
 * A fight tier is a pure function of the build, scenario, health segment, hand and condition band; the seed only
 * enters the draw. `simulateFights` may therefore build each table once for the whole seed list. These tests pin that
 * the cached path is the SAME path: every row of a batch is compared bit for bit with the standalone `simulateFight`
 * calls (which keep their own per-fight cache), for a single weapon, a dual build and durability-enabled fights
 * (including a break). The cache must also be scoped: reusable across seeds inside one call, never across calls, and
 * never inherited by a row's `.with()` edit, which changes the inputs a tier reads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { referenceFoe, weaponOf } from '../src/model.js';
import { createTierCache, pairedFightSeeds, simulateFight, simulateFights } from '../src/simulateFight.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';

const DESC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const target = () => referenceFoe(30, 'tough');
const item = () => weapon(121, { material: 9 });
const single = () => {
  const it = item();
  return { ch: simCharacter(DESC(), it), it };
};
const dual = () => {
  const it = item();
  const off = { ...it, equipSlot: 21 };
  const ch = simCharacter(DESC(), it);
  ch.offWeapon = off;
  ch._dual = true;
  return { ch, it, off };
};

// Durability fixtures: an item with condition to wear and Cast When Strikes rows to bill.
const condItem = (cond, extra = {}) => ({
  ...weapon(121, { material: 9 }), maxCondition: 1000, currentCondition: cond, ...extra,
});
const eff = (type, subType, magnitude = 10) => ({
  type, subType,
  magnitudeBaseLow: magnitude, magnitudeBaseHigh: magnitude,
  magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
  durationBase: 0, durationMod: 0, durationPerLevel: 1,
  chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
});
const spellOf = (index = 1) => ({
  name: `Spell ${index}`, index, element: 4, rangeType: 1, effects: [eff(4, 0, 10)],
});
const cws = (cond, params) => condItem(cond, {
  enchantments: params.map((param) => ({ type: 2, param })),
});
const durabilityDual = (main, off) => {
  const ch = simCharacter(DESC(), main);
  ch.offWeapon = { ...off, equipSlot: 21 };
  ch._dual = true;
  return ch;
};

/** A row without its `with` closure (a fresh function identity every call). */
const rowOf = (row) => {
  const { with: _with, ...rest } = row;
  return rest;
};
const assertSameRows = (batch, ch, args, seeds) => {
  const standalone = seeds.map((seed) => simulateFight(ch, { ...args, seed }));
  assert.equal(batch.rows.length, standalone.length);
  batch.rows.forEach((row, i) => {
    assert.deepEqual(rowOf(row), rowOf(standalone[i]), `seed ${seeds[i]}`);
  });
};

test('T1-1: a single-weapon batch is bit-identical to standalone fights', () => {
  const { ch, it } = single();
  const seeds = pairedFightSeeds(8, 20261117);
  const args = { target: target(), health: 40000, weapon: weaponOf(it), trace: true };
  const batch = simulateFights(ch, { ...args, seeds });
  assert.equal(batch.health, 40000);
  assertSameRows(batch, ch, args, seeds);
  // The digest covers the fields the report is built from, not just the damage total.
  assert.equal(batch.damageDealt.n, seeds.length);
  assert.equal(batch.blows.n, seeds.length);
});

test('T1-2: a dual-weapon batch is bit-identical to standalone fights', () => {
  const { ch, it, off } = dual();
  const seeds = pairedFightSeeds(8, 424242);
  const args = {
    target: target(), health: 40000, weapon: weaponOf(it), dual: true, trace: true,
  };
  // The off hand is the character's own item; `dual` asks for the exchange.
  assert.equal(off.equipSlot, 21);
  const batch = simulateFights(ch, { ...args, seeds });
  assertSameRows(batch, ch, args, seeds);
});

test('T1-3: a durability batch with breaks is bit-identical (wear and CWS bills)', () => {
  const main = cws(30, [1, 2]);
  const ch = simCharacter(DESC(), main);
  const before = JSON.stringify(main);
  const seeds = pairedFightSeeds(12, 777);
  const standard = new Map([[1, spellOf(1)], [2, spellOf(2)]]);
  const args = {
    target: target(), health: 40000, weapon: weaponOf(main), durability: true,
    standard, maxBlows: 60, trace: true,
  };
  const batch = simulateFights(ch, { ...args, seeds });
  assertSameRows(batch, ch, args, seeds);
  assert.ok(batch.rows.some((r) => r.breaks.length > 0), 'the fixture must exercise a break');
  assert.equal(JSON.stringify(main), before, 'the caller-owned item is untouched');
  assert.equal(ch.weapon.currentCondition, 30, 'the caller character is untouched');
});

test('T1-4: a durability dual batch with a break is bit-identical', () => {
  const main = cws(30, [1]);
  const off = condItem(30);
  const ch = durabilityDual(main, off);
  const seeds = pairedFightSeeds(10, 31415);
  const standard = new Map([[1, spellOf(1)]]);
  const args = {
    target: target(), health: 40000, weapon: weaponOf(main), durability: true,
    dual: true, standard, maxBlows: 60, trace: true,
  };
  const batch = simulateFights(ch, { ...args, seeds });
  assertSameRows(batch, ch, args, seeds);
  assert.ok(batch.rows.some((r) => r.breaks.length > 0), 'the fixture must exercise a break');
});

test('T1-5: a batch cache is reused across seeds, and `.with()` never inherits it', () => {
  const { ch, it } = single();
  const cache = createTierCache();
  const args = { target: target(), health: 40000, weapon: weaponOf(it), maxBlows: 1 };
  const first = simulateFight(ch, { ...args, seed: 1, _tierCache: cache });
  const built = cache.tiers.size;
  assert.equal(built, 1, 'one health segment, one hand: one table');
  const second = simulateFight(ch, { ...args, seed: 2, _tierCache: cache });
  assert.equal(cache.tiers.size, built, 'the second seed reused the batch table');
  assert.deepEqual(rowOf(second), rowOf(simulateFight(ch, { ...args, seed: 2 })));

  // A row's `.with()` is a fresh standalone call: its edit can change the target and health a tier reads.
  const batch = simulateFights(ch, { ...args, seeds: [1] });
  const alt = referenceFoe(10, 'weak');
  const viaWith = batch.rows[0].with({ target: alt, health: 5000 });
  const direct = simulateFight(ch, { ...args, seed: 1, target: alt, health: 5000 });
  assert.deepEqual(rowOf(viaWith), rowOf(direct));
});

test('T1-6: a second batch rebuilds tiers for the changed target and matches standalone fights', () => {
  const { ch, it } = single();
  const seeds = pairedFightSeeds(4, 9);
  const args = { target: target(), health: 40000, weapon: weaponOf(it) };
  const first = simulateFights(ch, { ...args, seeds });
  // A second call with a different target/health on the same build and seeds: its tiers must be rebuilt.
  const alt = referenceFoe(10, 'weak');
  const altArgs = { ...args, target: alt, health: 5000 };
  const second = simulateFights(ch, { ...altArgs, seeds });
  assertSameRows(second, ch, altArgs, seeds);
  assert.notDeepEqual(first.rows.map((r) => r.damageDealt), second.rows.map((r) => r.damageDealt));
});

test('T1-7: a batch releases its cached tiers before returning', () => {
  const { ch, it } = single();
  const args = { target: target(), health: 40000, weapon: weaponOf(it), maxBlows: 1, seeds: [1, 2] };
  const caches = new Set();
  const set = Map.prototype.set;
  // Capture the private cache when it stores a tier, without exposing it on the returned rows.
  Map.prototype.set = function (key, entry) {
    if (entry?.tier && entry?.sampler) caches.add(this);
    return set.call(this, key, entry);
  };
  try {
    simulateFights(ch, args);
  } finally {
    Map.prototype.set = set;
  }
  assert.equal(caches.size, 1, 'the batch populated one shared tier cache');
  const [cache] = caches;
  assert.equal(cache.size, 0, 'the batch released its cached tiers');
});
