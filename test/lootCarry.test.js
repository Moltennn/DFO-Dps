/*
 * test/lootCarry.test.js - W-LOOT-CARRY, the FIGHT-STREAM half (Stage 3.7i).
 *
 * Upstream carries the fraction of each percentage channel on the held item, per channel
 * (systems/loot/lootPowers.js:176-181 shareOf; weaponMastery.js:148-150; martialPowers.js:232-235;
 * firmamentPowers.js:111-115 with whole = floor for a price / ceil for a loss, remainder unclamped and the blow never
 * below 1 at :181). A held item's long-run mean of a percentage line is therefore its EXACT share, which PRICING
 * already reads (`carriedPerSwing`, ASSUMPTION M41). The plain card still floors every blow; the default seeded
 * streams keep the remainder per (channel, held item)
 * for the length of one fight (ASSUMPTION M43: a fight starts at zero; upstream persists it across fights, so the
 * stationary mean is the same but a fight's first blows differ).
 *
 * The oracle is the vendored game, either the channel functions themselves on ONE reused item (the sequence tests) or
 * `calculateAttackDamage` through the ordinary/relay fight oracles on a held item (the mean tests). Explicit
 * `carry: false` remains bit-identical to the recorded floor fight literal below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, createCarryState, gateTarget, masteryPct, referenceFoe, weaponBlow, weaponOf,
} from '../src/model.js';
import { createAttackSchedule, simulateFight, simulateFights, summarize } from '../src/simulateFight.js';
import { blowFightTier } from '../src/blowOutcomes.js';
import { simulateRelayFights } from '../src/relayFight.js';
import { character, simCharacter, upstreamEntity, weapon } from './harness/fixtures.mjs';
import { upstream, referenceFoe as upstreamReferenceFoe } from './harness/upstream.mjs';
import { oracleEntity, upstreamBody } from './harness/upstreamBodies.mjs';
import { generator } from './harness/prng.mjs';
import { oracleItem, upstreamFight } from './harness/fightOracle.mjs';
import { upstreamRelayEvents } from './harness/relayFightOracle.mjs';
import { expectKnownDiscrepancy } from './harness/waivers.mjs';

const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const PLAIN = () => character({ level: 30, raceId: 1, skills: 40 });

/** The vendored item shape (`test/harness/fightOracle.mjs` oracleItem, without importing a test-only helper twice). */
const upItem = (item) => oracleItem(item);

/** A seeded stream of pre-percentage blows, with misses (0) interleaved: a miss never reaches shareOf. */
const blowStream = (seed, n) => {
  const g = generator(seed);
  return Array.from({ length: n }, (_, i) => (i % 37 === 0 ? 0 : 60 + Math.floor(g() * 61)));
};

const meanZ = (a, b) => (a.mean - b.mean) / Math.sqrt(a.se ** 2 + b.se ** 2);

test('1. a held item carries the loot share: 25% slayer, one remainder, misses do not advance it', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const group = u.lootPowers.foeGroup(body);
  const item = { ...weapon(121, { material: 9 }), affixes: [{ id: 'slayer', param: group, value: 25 }] };
  const ch = simCharacter(PLAIN(), item);
  const w = weaponOf(item);
  const tgt = { ...body, group };
  const attacker = { ...upstreamEntity(PLAIN()), isPlayer: true };
  const held = upItem(item);
  const bases = blowStream(0x9001, 400);
  const state = createCarryState();
  const mine = bases.map((b) => weaponBlow(ch, w, b, tgt, { carryState: state }));
  const theirs = bases.map((b) => u.lootPowers.lootBlow(held, b, attacker, body, {}));
  assert.deepEqual(mine, theirs, 'the local carried stream is the vendored held-item stream, blow for blow');
  // Non-vacuous: a fresh-item stream (no state) floors, and differs.
  const floor = bases.map((b) => weaponBlow(ch, w, b, tgt, {}));
  assert.notDeepEqual(floor, mine, 'the carried stream differs from the per-blow floor');
});

test('2. slayer + bane are ONE carried share; mastery then loot are TWO independent remainders', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  // career 16 is a humanoid and one of Dragonsbane's foes (lootRarity.js:1197), so 25% slayer + 50% bane = 75% in ONE
  // `pct` (lootPowers.js:293, :305-308, :345): the vendored `lootBlow` sums both before its one shareOf.
  const baneBody = { ...body, careerIndex: 16, affinity: 'Daedra' };
  const baneGroup = u.lootPowers.foeGroup(baneBody);
  const item = {
    ...weapon(121, { material: 9 }), rarity: 'legendary', legendary: 'wyrmbane',
    affixes: [{ id: 'slayer', param: baneGroup, value: 25 }],
  };
  const ch = simCharacter(PLAIN(), item);
  const w = weaponOf(item);
  const tgt = { ...baneBody, group: baneGroup };
  const held = upItem(item);
  const attacker = { ...upstreamEntity(PLAIN()), isPlayer: true };
  attacker.equip.slots[19] = held; // wornPowers reads the striking item (lootPowers.js:244-258)
  const bases = blowStream(0x9002, 400);
  const state = createCarryState();
  const mine = bases.map((b) => weaponBlow(ch, w, b, tgt, { carryState: state }));
  const theirs = bases.map((b) => u.lootPowers.lootBlow(held, b, attacker, baneBody, {}));
  assert.deepEqual(mine, theirs, '25% slayer + 50% bane is one 75% remainder, as lootBlow sums it');
  // Negative control: 25% and 50% as TWO independent remainders are a different stream.
  const s1 = createCarryState();
  const s2 = createCarryState();
  const slayerOnly = { ...weapon(121, { material: 9 }), affixes: [{ id: 'slayer', param: baneGroup, value: 25 }] };
  const plainW = weaponOf(weapon(121, { material: 9 }));
  const two = bases.map((b) => weaponBlow(ch, plainW, weaponBlow(ch, weaponOf(slayerOnly), b, tgt, { carryState: s1 }), tgt, { loot: { pct: 50, flat: 0 }, carryState: s2 }));
  assert.notDeepEqual(two, mine, 'two independent remainders do not reproduce the one summed share');

  // Mastery then loot: two channels, two WeakMaps upstream (weaponMastery.js:132, lootPowers.js:171).
  const masteryDesc = character({ level: 30, raceId: 1, skills: 40, skillOverride: { 29: 150 }, online: true, mastered: [29], masterSkills: true });
  const mItem = { ...weapon(121, { material: 9 }), affixes: [{ id: 'slayer', param: baneGroup, value: 25 }] };
  const mCh = simCharacter(masteryDesc, mItem);
  const mW = weaponOf(mItem);
  const mHeld = upItem(mItem);
  const mAttacker = { ...upstreamEntity(masteryDesc), _online: true, masteredSkills: [29] };
  mAttacker.equip.slots[19] = mHeld;
  globalThis.location = { search: '?online' };
  let masteryMine;
  let masteryTheirs;
  try {
    const mState = createCarryState();
    masteryMine = bases.map((b) => weaponBlow(mCh, mW, b, tgt, { carryState: mState }));
    masteryTheirs = bases.map((b) => u.lootPowers.lootBlow(mHeld, u.weaponMastery.weaponMasteryBlow(mHeld, b, mAttacker, tgt, {}), mAttacker, tgt, {}));
  } finally { delete globalThis.location; }
  assert.deepEqual(masteryMine, masteryTheirs, 'mastery then loot, each with its own remainder');
  // Negative control: the same two percentages merged into ONE share are a different stream.
  const mergedPct = 25 + masteryPct(mCh, mW, tgt, {});
  const mergedState = createCarryState();
  const mergedItem = { ...weapon(121, { material: 9 }), affixes: [{ id: 'slayer', param: baneGroup, value: mergedPct }] };
  const merged = bases.map((b) => weaponBlow(simCharacter(PLAIN(), mergedItem), weaponOf(mergedItem), b, tgt, { carryState: mergedState }));
  assert.notDeepEqual(merged, masteryMine, 'two remainders are not one merged remainder');
});

test('3. the martial path carries its own remainder', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const group = u.lootPowers.foeGroup(body);
  const path = u.martialPaths.MARTIAL_BY_ID.cutthroat;
  const desc = character({ level: 30, raceId: 1, skills: 40, online: true, martialPath: 'cutthroat', mastered: [...path.skills] });
  const item = weapon(121, { material: 9 });
  const ch = simCharacter(desc, item);
  const w = weaponOf(item);
  const tgt = { ...body, group };
  const attacker = { ...upstreamEntity(desc), _online: true, martialPath: 'cutthroat', masteredSkills: [...path.skills] };
  const held = upItem(item);
  const bases = blowStream(0x9003, 400);
  const state = createCarryState();
  const mine = bases.map((b) => weaponBlow(ch, w, b, tgt, { carryState: state, unaware: true }));
  const theirs = bases.map((b) => u.martialPowers.martialBlow(held, b, attacker, body, { unaware: true }));
  assert.deepEqual(mine, theirs, 'the martial stream carries its own remainder');
});

test('3b. LOCAL: the long-run carried Firmament mean converges to the exact share', () => {
  const tgt = referenceFoe(30, 'tough');
  // The fractional remainder is bounded by one point (firmamentPowers.js:111-115@a3eb1605).
  const firmItem = weapon(121, { material: 9 });
  const firmCh = simCharacter(PLAIN(), firmItem);
  const fw = weaponOf(firmItem);
  const fBases = blowStream(0x9004, 20000).filter((b) => b > 0);
  const fState = createCarryState();
  let carriedSum = 0;
  let floorSum = 0;
  let exactSum = 0;
  for (const b of fBases) {
    carriedSum += weaponBlow(firmCh, fw, b, tgt, { firmamentDamagePct: 30, carryState: fState });
    floorSum += weaponBlow(firmCh, fw, b, tgt, { firmamentDamagePct: 30 });
    exactSum += b + (b * 30) / 100;
  }
  const n = fBases.length;
  assert.ok(Math.abs(carriedSum / n - exactSum / n) < 1 / n, `Firmament carried mean is the exact share (${(carriedSum / n).toFixed(6)} vs ${(exactSum / n).toFixed(6)})`);
  assert.ok(carriedSum > floorSum + 0.3 * n, `the floor stream is lower (${(carriedSum / n).toFixed(4)} vs ${(floorSum / n).toFixed(4)})`);
});

test('4. the estimate path is untouched: `carried` never consumes a fight remainder', () => {
  const item = { ...weapon(121, { material: 9 }), affixes: [{ id: 'slayer', param: 'humanoid', value: 25 }] };
  const ch = simCharacter(PLAIN(), item);
  const w = weaponOf(item);
  const tgt = { ...referenceFoe(30, 'tough'), group: 'humanoid' };
  const state = createCarryState();
  const estimate = weaponBlow(ch, w, 100, tgt, { carried: true });
  assert.equal(estimate, 100 + (100 * 25) / 100, 'the pricing pass takes the exact share');
  assert.equal(weaponBlow(ch, w, 100, tgt, { carried: true, carryState: state }), estimate, 'a supplied carry state is ignored by the estimate pass');
  assert.equal(state.size, 0, 'and nothing was written');
  // The card still floors this line (upstream's own info.estimate path), the waiver's card half.
  const card = analyze(ch, { target: tgt, core: 'overhaul', weapon: w, swing: 'StrikeLeft' });
  assert.ok(card.perSwing < card.carriedPerSwing, `the card floors (${card.perSwing} < ${card.carriedPerSwing})`);
});

const eventsOf = (ch, args, n = 2000) => {
  const s = createAttackSchedule(ch, args);
  assert.ok(s, 'a schedule');
  return Array.from({ length: n }, () => s.next());
};

/** One fight differential: the default sampled stream vs the held-item oracle. */
async function fightDifferential({ desc, ch, item, group = null, attacker = null, unaware = false, trials = 240 }) {
  const u = await upstream();
  const pool = 5000;
  const target = { ...referenceFoe(30, 'tough'), ...(group ? { group } : {}) };
  const args = { target, health: pool, weapon: weaponOf(item), trials, seed: 0x6500, ...(unaware ? { unaware: true } : {}) };
  const events = eventsOf(ch, args);
  const upHeld = upItem(item);
  const bodyBase = upstreamReferenceFoe(u, 30, 'tough');
  if (group === 'humanoid') bodyBase.affinity = 'Human';
  bodyBase.health = pool;
  bodyBase.maxHealth = pool;
  const oracleRows = (local) => local.seeds.map((s) => upstreamFight(u, {
    desc, item: upHeld, body: oracleEntity(bodyBase), events, seed: s, uptime: 0, reuseItem: true, unaware,
    ...(attacker ? { attacker } : {}),
  }));
  const carried = simulateFights(ch, args);
  const rows = oracleRows(carried);
  const upTtk = summarize(rows.filter((r) => r.ttk != null).map((r) => r.ttk));
  const upPer = summarize(rows.map((r) => r.damageDealt / r.blows));
  assert.ok(carried.ttk && upTtk && upTtk.n === trials, 'every oracle fight kills');
  const ttkRel = carried.ttk.mean / upTtk.mean - 1;
  const zPer = meanZ(carried.expectedPerSwing, upPer);
  assert.ok(Math.abs(ttkRel) < 0.01, `carried TTK within 1% of the held oracle (${carried.ttk.mean.toFixed(3)} vs ${upTtk.mean.toFixed(3)}, ${(100 * ttkRel).toFixed(2)}%)`);
  assert.ok(Math.abs(zPer) < 3.5, `carried damage/blow z ${zPer.toFixed(2)} (${carried.expectedPerSwing.mean.toFixed(4)} vs ${upPer.mean.toFixed(4)})`);
  // The floor stream is the waiver's remaining fight half: pin that it still fails the same held-item comparison.
  const floor = simulateFights(ch, { ...args, carry: false });
  const gap = upPer.mean / floor.expectedPerSwing.mean - 1;
  const zGap = (upPer.mean - floor.expectedPerSwing.mean) / Math.sqrt(upPer.se ** 2 + floor.expectedPerSwing.se ** 2);
  expectKnownDiscrepancy(assert, 'W-LOOT-CARRY', gap > 0.01 && zGap > 3, {
    held: upPer.mean, floor: floor.expectedPerSwing.mean, gap, z: zGap,
  });
  return { carried, floor, upTtk, upPer };
}

test('5. default seeded fights match the held-item oracle; carry:false still floors', async (t) => {
  const basicItem = { ...weapon(121, { material: 9 }), affixes: [{ id: 'slayer', param: 'humanoid', value: 25 }] };
  const slayer = await fightDifferential({ desc: BASIC(), ch: simCharacter(BASIC(), basicItem), item: basicItem, group: 'humanoid' });
  t.diagnostic(`slayer mean TTK: default ${slayer.carried.ttk.mean.toFixed(3)} s, held ${slayer.upTtk.mean.toFixed(3)} s, floor ${slayer.floor.ttk.mean.toFixed(3)} s; damage/blow: default ${slayer.carried.expectedPerSwing.mean.toFixed(4)}, held ${slayer.upPer.mean.toFixed(4)}, floor ${slayer.floor.expectedPerSwing.mean.toFixed(4)}`);
  assert.ok(slayer.carried.ttk.mean < slayer.floor.ttk.mean, 'the carried stream kills sooner than the floor stream');

  const masteryDesc = character({ level: 30, raceId: 1, skills: 40, skillOverride: { 29: 150 }, online: true, mastered: [29], masterSkills: true });
  const masteryItem = weapon(121, { material: 9 });
  const masteryAttacker = { ...upstreamEntity(masteryDesc), _online: true, masteredSkills: [29] };
  globalThis.location = { search: '?online' };
  try {
    await fightDifferential({
      desc: masteryDesc, ch: simCharacter(masteryDesc, masteryItem), item: masteryItem, attacker: masteryAttacker,
    });
  } finally { delete globalThis.location; }

  const path = (await upstream()).martialPaths.MARTIAL_BY_ID.cutthroat;
  const martialDesc = character({ level: 30, raceId: 1, skills: 40, online: true, martialPath: 'cutthroat', mastered: [...path.skills] });
  const martialItem = weapon(121, { material: 9 });
  await fightDifferential({
    desc: martialDesc, ch: simCharacter(martialDesc, martialItem), item: martialItem, unaware: true,
    attacker: { ...upstreamEntity(martialDesc), _online: true, martialPath: 'cutthroat', masteredSkills: [...path.skills] },
  });
});

test('6. explicit carry:false preserves the original seeded floor stream', () => {
  // Captured from the same call BEFORE this change (seed 0x77, one 25% slayer line, trace: true).
  const LITERAL = {
    seed: 119, ttk: 269.4661224489796, kills: true, blows: 295, damageDealt: 5017, meleeDamage: 5017, echoDamage: 0,
    blow: [18, 23, 32, 25, 10, 32, 0, 0, 25, 0, 25, 26, 0, 0, 22, 13, 28, 0, 15, 11, 0, 30, 39, 0, 0, 0, 22, 15, 26, 18, 0, 23, 0, 17, 18, 18, 13, 16, 0, 16, 13, 0, 20, 27, 23, 13, 16, 25, 0, 21, 8, 0, 13, 39, 0, 28, 10, 21, 16, 0, 8, 0, 0, 25, 0, 15, 23, 30, 8, 43, 0, 0, 0, 23, 25, 21, 30, 30, 16, 17, 26, 25, 17, 13, 13, 27, 26, 22, 21, 0, 17, 0, 22, 22, 23, 20, 38, 13, 0, 25, 27, 0, 0, 22, 0, 0, 8, 25, 13, 35, 25, 13, 28, 0, 0, 15, 31, 26, 22, 16, 27, 23, 0, 20, 27, 17, 0, 31, 28, 0, 22, 11, 26, 16, 10, 0, 27, 0, 14, 0, 0, 13, 27, 27, 31, 0, 16, 12, 0, 20, 31, 22, 46, 0, 13, 26, 0, 0, 22, 33, 0, 35, 26, 27, 26, 0, 25, 17, 17, 0, 0, 27, 28, 20, 18, 17, 27, 27, 22, 0, 18, 0, 39, 26, 25, 16, 0, 35, 30, 30, 20, 0, 0, 16, 13, 0, 22, 22, 18, 16, 31, 21, 13, 27, 0, 0, 25, 15, 15, 20, 13, 38, 0, 0, 0, 26, 28, 25, 17, 16, 23, 20, 21, 17, 20, 26, 32, 28, 25, 26, 20, 23, 23, 21, 0, 20, 17, 0, 10, 31, 12, 0, 27, 25, 0, 26, 20, 30, 42, 33, 30, 15, 13, 39, 0, 0, 27, 13, 16, 15, 18, 23, 21, 42, 0, 13, 26, 22, 13, 26, 21, 0, 36, 25, 20, 36, 0, 15, 17, 20, 26, 32, 18, 30, 25, 23, 0, 27, 27, 17, 15, 8, 0, 22, 35],
  };
  const item = { ...weapon(121, { material: 9 }), affixes: [{ id: 'slayer', param: 'humanoid', value: 25 }] };
  const ch = simCharacter(BASIC(), item);
  const target = { ...referenceFoe(30, 'tough'), group: 'humanoid' };
  const args = { target, health: 5000, weapon: weaponOf(item), seed: 0x77, trace: true };
  const compact = (r) => ({
    seed: r.seed, ttk: r.ttk, kills: r.kill, blows: r.blows,
    damageDealt: r.damageDealt, meleeDamage: r.meleeDamage, echoDamage: r.echoDamage,
    blow: r.trace.map((x) => x.blow),
  });
  assert.deepEqual(compact(simulateFight(ch, { ...args, carry: false })), LITERAL);
  const carried = compact(simulateFight(ch, args));
  assert.deepEqual(carried, compact(simulateFight(ch, { ...args, carry: true })));
  assert.notDeepEqual(carried, LITERAL);
});

test('7. default sampled relay matches the vendored held-item damage per scheduled attack', async (t) => {
  // ORACLE: calculateAttackDamage keeps the same item throughout each upstreamRelayEvents run
  // (lootPowers.js:171,176-181@a3eb1605), then gateBrain.applyHit admits each host claim.
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  assert.equal(u.lootPowers.foeGroup(body), 'daedra', 'the vendored body activates the slayer line');
  const item = { ...weapon(121, { material: 9 }), affixes: [{ id: 'slayer', param: 'daedra', value: 25 }] };
  const desc = BASIC();
  const ch = simCharacter(desc, item);
  const level = 45;
  const pool = 200000;
  const target = gateTarget(level, { health: pool, traits: [] });
  const maxBlows = 400;
  const args = { target, health: pool, weapon: weaponOf(item), swing: 'StrikeLeft', trials: 64, seed: 0x6600, maxBlows, maxSeconds: 600 };
  const events = eventsOf(ch, args, maxBlows);
  const off = simulateRelayFights(ch, { ...args, carry: false });
  const on = simulateRelayFights(ch, args);
  assert.ok(off && on, 'both runs return a summary');
  assert.equal(on.terminations.maxBlows, args.trials);
  assert.equal(off.terminations.maxBlows, args.trials);
  assert.equal(on.offered.mean, on.damageDealt.mean, 'nonbinding relay caps and allowance');
  const landed = [];
  for (const seed of on.seeds) {
    const up = await upstreamRelayEvents(u, { desc, item: upItem(item), body: oracleEntity(body), level, pool, events, seed });
    assert.ok(up.hp > 0 && up.claims.every((c) => c.claim === c.got), 'no oracle kill, clipping, or refusal');
    landed.push(up.landed);
  }
  const held = summarize(landed);
  const z = meanZ(on.damageDealt, held);
  const floorZ = meanZ(held, off.damageDealt);
  // Same fixed attack count: per-fight damage and damage per scheduled attack have the same z statistic.
  // Different seeded samplers; use the existing carry differential's 3.5 pooled-SE bound.
  const means = `damage per attack: default ${(on.damageDealt.mean / maxBlows).toFixed(5)}, held ${(held.mean / maxBlows).toFixed(5)}, floor ${(off.damageDealt.mean / maxBlows).toFixed(5)}`;
  assert.ok(Math.abs(z) < 3.5, `${means}; default vs held z=${z.toFixed(2)}`);
  expectKnownDiscrepancy(assert, 'W-LOOT-CARRY', floorZ > 3.5, { means, floorZ: Number(floorZ.toFixed(2)) });
  t.diagnostic(`${means}; default vs held z=${z.toFixed(2)}, held vs floor z=${floorZ.toFixed(2)}`);
});

test('8. a base of 0 stays 0 under carry:true: the elemental flat is not added on a damage <= 0 blow', async () => {
  // damageModel calls weaponBlow only when d > 0 (src/model.js), and upstream's lootBlow returns at `!(damage > 0)`
  // (lootPowers.js:287): a landed blow whose pre-percentage base is 0 never gains the elemental/venom flat. The carried
  // re-resolution must take the same guard, otherwise a 0 card becomes a positive elemental blow.
  const u = await upstream();
  const item = { ...weapon(121, { material: 0 }), affixes: [{ id: 'elemental', param: 'fire', value: 10 }] };
  const desc = character({
    level: 30, raceId: 1, stats: { strength: 0, agility: 50, speed: 50, luck: 50 }, skills: 0, skillOverride: { 34: 0 },
  });
  const ch = simCharacter(desc, item);
  const w = weaponOf(item);
  const target = referenceFoe(30, 'tough');
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  assert.equal(u.lootPowers.lootBlow(upItem(item), 0, { ...upstreamEntity(desc), isPlayer: true }, body, {}), 0,
    'upstream: a 0 blow takes no elemental flat');
  const tier = blowFightTier(ch, {
    target, health: 5000, healthShare: 0.75, weapon: w, carry: true, swing: 'StrikeLeft',
  });
  const zeros = tier.outcomes.filter((o) => o.hit && o.blowBase === 0);
  assert.ok(zeros.length > 0, 'the fixture produces a landed atom with a pre-percentage base of 0');
  for (const atom of zeros) {
    assert.equal(atom.blow, 0, 'the floor/enumerated outcome of a base-0 blow is 0');
    assert.equal(tier.carryResolve(atom, createCarryState()).blow, 0, 'the carried outcome of a base-0 blow stays 0');
  }
});
