/*
 * test/relayFightDifferential.test.js - Stage 3.4.1: the whole relay compositor against upstream.
 *
 * Each scenario fixes an attack list (`{t, hand}`). The oracle runs upstream `calculateAttackDamage` (and therefore
 * `lootBlow`/`lootStrike` with the seeded Flow clock), takes the owed Many Endings amount, applies the target's
 * `bossStrikeAt`, rounds the host claim, and calls `gateBrain.applyHit`. The same upstream outcome objects are fed to
 * `simulateRelayFight`'s event seam. Every event's Flow state, claim, Got/relay state, echo and ward flag is compared.
 * No local result is an expected value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { gateTarget, weaponOf } from '../src/model.js';
import { simulateRelayFight } from '../src/relayFight.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { upstream } from './harness/upstream.mjs';
import { oracleEntity, upstreamBody } from './harness/upstreamBodies.mjs';
import { oracleItem } from './harness/fightOracle.mjs';
import { upstreamRelayEvents } from './harness/relayFightOracle.mjs';
import { relayEventArgs } from './harness/relayEventSeam.mjs';

const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const STRONG = () => character({
  level: 30, raceId: 1, stats: { strength: 100, agility: 70, speed: 70, luck: 50 },
  skills: 0, skillOverride: { 29: 150, 34: 80, 19: 50 },
});
const sword = () => weapon(121, { material: 9 });
const flowItem = () => ({ ...sword(), rarity: 'legendary', legendary: 'anseis-edge' });
const echoItem = () => ({ ...sword(), rarity: 'rare', imprint: 'warp-edge' });
const pvItem = () => ({ ...sword(), enchantments: [{ type: 4, param: 1 }] });
const near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

async function compare({ desc, item, offItem = null, events, pool = 1e9, level = 45, seed = 1, fresh = true, shieldUntil = 0, traits = [] }) {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const up = await upstreamRelayEvents(u, {
    desc, item: oracleItem(item), offItem: offItem ? oracleItem(offItem) : null, body: oracleEntity(body),
    level, pool, events, seed, fresh, shieldUntil, traits,
  });
  const target = { ...gateTarget(level, { health: pool }), bossTraits: traits };
  const ch = simCharacter(desc, item);
  if (offItem) { ch.offWeapon = { ...offItem, equipSlot: 21 }; ch._dual = true; }
  const local = simulateRelayFight(ch, {
    target, health: pool, weapon: weaponOf(item), ...(offItem ? { dual: true } : {}),
    ...relayEventArgs(events.map((e, i) => ({ t: e.t, hand: e.hand, outcome: up.rows[i].outcome }))),
    traceAll: true, seed, fresh, shieldUntil, maxSeconds: 1e9,
  });
  assert.equal(local.traceAll.length, up.rows.length, 'one local event per upstream event');
  for (let i = 0; i < up.rows.length; i++) {
    const a = local.traceAll[i];
    const b = up.rows[i];
    const at = `event ${i} (t ${b.t}, ${b.hand})`;
    assert.equal(a.warded, b.warded, `${at}: ward`);
    // independently recompute the host's rounded claim from the upstream pre-round number (not oracle.sent)
    const expectedClaim = b.hostBlow > 0 && Math.round(b.hostBlow) >= 1 ? Math.round(b.hostBlow) : 0;
    assert.equal(a.claim ?? 0, expectedClaim, `${at}: claim ${a.claim} vs ${expectedClaim}`);
    assert.equal(a.stacksBefore, b.flowBefore, `${at}: Flow before ${a.stacksBefore} vs ${b.flowBefore}`);
    assert.equal(a.stacksAfter, b.flowAfter, `${at}: Flow after ${a.stacksAfter} vs ${b.flowAfter}`);
    assert.ok(near(a.got, b.got), `${at}: got ${a.got} vs ${b.got}`);
    assert.ok(near(a.bucket, b.bucket), `${at}: bucket ${a.bucket} vs ${b.bucket}`);
    assert.ok(near(a.tokens, b.tokens), `${at}: tokens ${a.tokens} vs ${b.tokens}`);
    assert.ok(near(a.hp, b.hp), `${at}: hp ${a.hp} vs ${b.hp}`);
    assert.equal(a.accepted, b.accepted, `${at}: accepted`);
    // echoHits is an upstream outcome input in this seam; its distribution is independently checked in
    // test/relayEchoDifferential.test.js, so it is not asserted against itself here.
  }
  return { local, up };
}

test('1. Flow expiry, refresh and cap across both hands', async () => {
  const events = [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 19, 26, 26, 26]
    .map((t, i) => ({ t, hand: i % 2 ? 'off' : 'main' }));
  const { up } = await compare({ desc: BASIC(), item: flowItem(), offItem: flowItem(), events, seed: 1 });
  assert.ok(up.rows.some((r) => r.hand === 'off' && r.whole === false), 'a non-whole off-hand blow is covered');
  assert.ok(up.rows.some((r) => r.flowAfter === 5), 'the cap is reached');
  assert.ok(up.rows.some((r) => r.flowBefore === 0 && r.flowAfter === 1 && r.t >= 12), 'an expired Flow restarts at 1');
});

test('2. Many Endings and Flow on different hands, with separate resistance', async () => {
  const events = [0, 1, 2, 3, 4, 12, 13].map((t, i) => ({ t, hand: i % 2 ? 'off' : 'main' }));
  const { up } = await compare({
    desc: BASIC(), item: echoItem(), offItem: flowItem(), events, seed: 2, traits: ['bladeturning'],
  });
  assert.ok(up.rows.some((r) => r.echoHits > 0), 'a main-hand echo claim is covered');
  assert.ok(up.rows.some((r) => r.hand === 'off' && r.flowAfter > r.flowBefore), 'the off hand charges Flow');
});

test('3. warded attacks and the exact shield boundary', async () => {
  const events = [0.999, 1, 1.001, 5].map((t) => ({ t, hand: 'main' }));
  const { local, up } = await compare({ desc: BASIC(), item: flowItem(), events, seed: 3, shieldUntil: 1 });
  assert.equal(up.rows[0].warded, true);
  assert.equal(up.rows[1].warded, false);
  assert.equal(local.wardedAttacks, 1);
  assert.equal(up.rows[0].flowAfter, up.rows[0].flowBefore, 'a warded blow builds no Flow');
  assert.ok(up.rows[1].sent >= 1, 'the exact boundary sends a claim');
});

test('4. positive-damage Potent Vs misses', async () => {
  const events = Array.from({ length: 50 }, (_, i) => ({ t: i * 0.7, hand: 'main' }));
  const { local, up } = await compare({ desc: BASIC(), item: pvItem(), events, seed: 4 });
  const misses = up.rows.filter((r) => r.hit === false && r.sent > 0);
  assert.ok(misses.length > 0, 'a Potent Vs miss sent a positive claim');
  assert.ok(misses.every((m) => m.sent === 5), 'the miss claim is five');
  assert.ok(local.traceAll.some((r) => r.hit === false && r.claim === 5));
});

test('5. Flow progresses when the relay later refuses a claim', async () => {
  const item = { ...weapon(123, { material: 9 }), rarity: 'legendary', legendary: 'anseis-edge' };
  const events = [0, 0, 0, 0, 0.1, 0.2, 0.3, 1].map((t) => ({ t, hand: 'main' }));
  const { local, up } = await compare({ desc: STRONG(), item, events, level: 1, seed: 5 });
  assert.ok(up.rows.some((r) => r.sent > 0 && r.got === 0), 'the relay refused a positive claim');
  assert.ok(up.rows.some((r) => r.got === 0 && r.flowAfter > r.flowBefore), 'Flow still charged on the refused event');
  assert.ok(local.traceAll.some((r) => r.claim > 0 && r.accepted === false && r.stacksAfter > r.stacksBefore));
});
