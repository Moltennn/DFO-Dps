/*
 * test/relayRealSampler.test.js - Stage 3.4.2: a real-sampler whole-compositor check.
 *
 * Unlike the event-seam differential, this runs the production sampler/tier with dynamic Flow stacks. The local trace
 * must show the stack count and hand actually passed to `blowFightTier`; the Flow before/after each claim is replayed
 * independently through upstream `lootStrike` at the same attack time and item; the claim engine is replayed through
 * `relayStream`. No local trace value is an expected value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCarryState, gateTarget, weaponOf } from '../src/model.js';
import { simulateRelayFight, simulateRelayFights } from '../src/relayFight.js';
import { relayStream } from './harness/relay.mjs';
import { character, simCharacter, upstreamEntity, weapon } from './harness/fixtures.mjs';
import { oracleItem } from './harness/fightOracle.mjs';
import { upstream } from './harness/upstream.mjs';
import {
  _resetLootPowersForTests, _setLootPowersClockForTests, flowStacks, lootStrike,
} from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';

const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const flow = () => ({ ...weapon(121, { material: 9 }), rarity: 'legendary', legendary: 'anseis-edge' });
const echo = () => ({ ...weapon(121, { material: 9 }), rarity: 'rare', imprint: 'warp-edge' });
const near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
const strip = ({ with: _with, ...rest }) => rest;
const assertSameRows = (batch, ch, args) => {
  assert.equal(batch.rows.length, args.seeds.length);
  batch.rows.forEach((row, i) => {
    assert.deepEqual(strip(row), strip(simulateRelayFight(ch, { ...args, seed: args.seeds[i] })), `seed ${args.seeds[i]}`);
  });
};

/** Replay the local trace's Flow state through upstream lootStrike; `handItem` is the item that carries Flow. */
async function flowFromTrace(trace, desc, items) {
  const u = await upstream();
  const attacker = upstreamEntity(desc);
  const slots = u.equip.equipTableOf(attacker);
  let now = 0;
  _resetLootPowersForTests();
  _setLootPowersClockForTests(() => now);
  try {
    for (const row of trace) {
      now = row.t;
      const upItem = items[row.hand];
      if (!upItem) {
        // no Flow power on this hand: the tier reports no Flow input, whatever the global state is
        assert.equal(row.tierStacks, null);
        assert.equal(row.tierHand, row.hand);
        assert.equal(row.stacksAfter, flowStacks(now));
        continue;
      }
      slots[row.hand === 'off' ? u.equip.EQUIP_SLOTS.LeftHand : u.equip.EQUIP_SLOTS.RightHand] = upItem;
      const before = flowStacks(now);
      assert.equal(row.stacksBefore, before, `Flow before at ${now}s (${row.hand})`);
      assert.equal(row.tierStacks, before, `tier stack input at ${now}s (${row.hand})`);
      assert.equal(row.tierHand, row.hand);
      lootStrike(attacker, { isPlayer: false }, row.claim, upItem, { blow: row.whole });
      assert.equal(row.stacksAfter, flowStacks(now), `Flow after at ${now}s (${row.hand})`);
    }
  } finally {
    _resetLootPowersForTests();
    _setLootPowersClockForTests(null);
    slots[u.equip.EQUIP_SLOTS.RightHand] = null;
    slots[u.equip.EQUIP_SLOTS.LeftHand] = null;
  }
}

test('real sampler: dynamic Flow stack inputs and upstream Flow state (single hand)', async () => {
  const item = flow();
  const ch = simCharacter(BASIC(), item);
  const target = gateTarget(45, { health: 2000 });
  const r = simulateRelayFight(ch, { target, health: 2000, weapon: weaponOf(item), seed: 1, trace: true });
  assert.ok(r.trace.length > 5);
  assert.ok(r.trace.every((x) => x.tierStacks === x.stacksBefore));
  assert.ok(r.trace.every((x) => x.tierHand === 'main'));
  assert.ok(r.trace.some((x) => x.tierStacks > 0), 'the tier saw a charged stack');
  await flowFromTrace(r.trace, BASIC(), { main: oracleItem(item) });

  const up = await relayStream({ level: 45, share: 2000, claims: r.trace.map((x) => ({ t: x.t, d: x.claim })) });
  assert.equal(up.rows.length, r.trace.length);
  for (let i = 0; i < r.trace.length; i++) {
    assert.ok(near(r.trace[i].got, up.rows[i].got), `claim ${i}: got`);
    assert.ok(near(r.trace[i].bucket, up.rows[i].bucketAfter), `claim ${i}: bucket`);
    assert.ok(near(r.trace[i].tokens, up.rows[i].tokensAfter), `claim ${i}: tokens`);
    assert.ok(near(r.trace[i].hp, up.rows[i].hpAfter), `claim ${i}: hp`);
  }
});

test('real sampler: Flow on one hand and Many Endings on the other', async () => {
  const main = echo();
  const off = { ...flow(), equipSlot: 21 };
  const ch = simCharacter(BASIC(), main);
  ch.offWeapon = off;
  ch._dual = true;
  const target = gateTarget(45, { health: 2000 });
  const r = simulateRelayFight(ch, { target, health: 2000, weapon: weaponOf(main), dual: true, seed: 1, trace: true });
  assert.ok(r.trace.some((x) => x.hand === 'off' && x.flowBuilt));
  assert.ok(r.trace.some((x) => x.hand === 'main' && x.echoHits > 0));
  // independent echo expectation: one power, 10% of the positive main-hand claims
  const mainClaims = r.trace.filter((x) => x.hand === 'main').length;
  const echoes = r.trace.filter((x) => x.hand === 'main' && x.echoHits > 0).length;
  const p = 0.1;
  assert.ok(Math.abs(echoes - mainClaims * p) <= 4 * Math.sqrt(mainClaims * p * (1 - p)), `echoes ${echoes}/${mainClaims}`);
  assert.ok(r.trace.filter((x) => x.hand === 'off').every((x) => x.tierStacks === x.stacksBefore));
  assert.ok(r.trace.filter((x) => x.hand === 'main').every((x) => x.tierStacks === null));
  assert.ok(r.trace.every((x) => x.tierHand === x.hand));
  // the main hand carries no Flow power: its claims must not move the global Flow state
  await flowFromTrace(r.trace, BASIC(), { off: oracleItem(off) });
});

test('relay tier cache: carried and stateless single-weapon batches match standalone rows', () => {
  const ch = simCharacter(BASIC(), flow());
  for (const carry of [true, false]) {
    const args = {
      target: gateTarget(45, { health: 2000 }), seeds: [1, 2, 7, 11], carry,
      trace: true, traceAll: true, shieldUntil: 2, fresh: false,
    };
    const batch = simulateRelayFights(ch, args);
    assertSameRows(batch, ch, args);
    const trace = batch.rows[0].traceAll;
    assert.ok(trace.some((r) => r.warded));
    assert.ok(trace.some((r) => r.segment !== trace[0].segment));
    assert.ok(trace.some((r) => r.tierStacks > 0));
  }
});

const plainTarget = gateTarget(45, { health: 2000, traits: [] });
for (const [name, edit] of [
  ['bladeturning', { target: { ...plainTarget, bossTraits: ['bladeturning'] } }],
  ['explicit ward', { target: { ...plainTarget, warded: true } }],
  ['Potent Vs', { potentVs: 17 }],
  ['backstab', { backstabUptime: 1, backstabChance: 100 }],
]) {
  test(`relay tier cache: ${name} batch matches standalone rows`, () => {
    const ch = simCharacter(BASIC(), echo());
    const base = { target: plainTarget, seeds: [1, 2, 7, 11], maxBlows: 20, traceAll: true };
    const args = { ...base, ...edit };
    const batch = simulateRelayFights(ch, args);
    assertSameRows(batch, ch, args);
    const raw = ({ traceAll }) => traceAll.map((row) => row.raw);
    assert.notDeepEqual(
      batch.rows.map(raw), base.seeds.map((seed) => raw(simulateRelayFight(ch, { ...base, seed }))),
      `${name} must affect the sampled blows`,
    );
  });
}

test('relay tier cache: dual-wield Flow and Many Endings match standalone rows', () => {
  const ch = simCharacter(BASIC(), echo());
  ch.offWeapon = { ...flow(), equipSlot: 21 };
  ch._dual = true;
  const args = { target: gateTarget(45, { health: 2000 }), dual: true, seeds: [1, 2, 7, 11], trace: true };
  const batch = simulateRelayFights(ch, args);
  assertSameRows(batch, ch, args);
  const trace = batch.rows.flatMap((r) => r.trace);
  assert.ok(trace.some((r) => r.hand === 'off' && r.tierStacks > 0));
  assert.ok(trace.some((r) => r.hand === 'main' && r.echoHits > 0));
});

test('relay tier cache: batches reuse and release tiers; both .with() forms start fresh', () => {
  const ch = simCharacter(BASIC(), flow());
  const args = { target: gateTarget(45, { health: 2000 }), seeds: [1, 2], maxBlows: 1, traceAll: true };
  const edit = { target: { ...args.target, warded: true }, health: 3000, carry: false };
  const writes = [];
  const set = Map.prototype.set;
  Map.prototype.set = function (key, entry) {
    if (entry?.tier && entry?.sampler) writes.push(this);
    return set.call(this, key, entry);
  };
  let second;
  let editedRow;
  let editedBatch;
  try {
    const first = simulateRelayFights(ch, args);
    assert.equal(writes.length, 1, 'both seeds used the same table');
    assert.equal(writes[0].size, 0, 'the batch cleared its tiers before returning');
    second = simulateRelayFights(ch, { ...args, ...edit });
    editedRow = first.rows[0].with(edit);
    editedBatch = first.with(edit);
    assert.equal(writes.length, 4, 'each new call populated its own cache');
    assert.equal(new Set(writes).size, 4);
    assert.equal(writes[1].size, 0);
    assert.equal(writes[3].size, 0);
    assert.throws(() => simulateRelayFights(ch, { ...args, seeds: [1, 1.5] }), /seed must be a safe integer/);
    assert.equal(writes.length, 5);
    assert.equal(writes[4].size, 0, 'the failed batch also cleared its tiers');
  } finally {
    Map.prototype.set = set;
  }
  assertSameRows(second, ch, { ...args, ...edit });
  assert.deepEqual(strip(editedRow), strip(simulateRelayFight(ch, { ...args, ...edit, seed: 1 })));
  assertSameRows(editedBatch, ch, { ...args, ...edit });
});

test('relay tier cache: caller-owned carry state advances as in sequential standalone fights', () => {
  const ch = simCharacter(BASIC(), flow());
  const state = () => {
    const carryState = createCarryState();
    carryState.set('loot', new Map([[ch.weapon, 0.93]]));
    return carryState;
  };
  const args = {
    target: gateTarget(45, { health: 2000 }), seeds: [1, 2, 7, 11], maxBlows: 4, traceAll: true,
    // Stateless draws still use the caller's live remainders when building each tier.
    carry: false, loot: { pct: 13 }, carryState: state(),
  };
  const batch = simulateRelayFights(ch, { ...args, carryState: state() });
  assertSameRows(batch, ch, args);
});

test('relay tier cache: caller-owned spell hooks keep tiers fight-local', () => {
  const ch = simCharacter(BASIC(), flow());
  const args = { target: gateTarget(45, { health: 2000 }), seeds: [1, 2], maxBlows: 1 };
  const set = Map.prototype.set;
  const caches = new Set();
  Map.prototype.set = function (key, entry) {
    if (entry?.tier && entry?.sampler) caches.add(this);
    return set.call(this, key, entry);
  };
  try {
    for (const edit of [{ cwsRolls: () => 0.5 }, { standard: { get() {} } }]) {
      caches.clear();
      simulateRelayFights(ch, { ...args, ...edit });
      assert.equal(caches.size, 2);
      assert.ok([...caches].every((cache) => cache.size === 0));
    }
  } finally {
    Map.prototype.set = set;
  }
});
