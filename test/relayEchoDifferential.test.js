/*
 * test/relayEchoDifferential.test.js - Stage 3.4: Many Endings on a relay body.
 *
 * The oracle (`sampleJointBlow`) calls upstream `calculateAttackDamage`, the strike listeners and `takeOwed` on a body
 * the realm mints, with an echo power worn on the item. It records the echo mask and the final blow (the owed echo is
 * already in that number). The local fight tier is compared cell by cell, then the echo marginal and the separate
 * resistance path. No local output is handed to the oracle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { weaponOf } from '../src/model.js';
import { standInTarget } from '../src/target.js';
import { blowFightTier } from '../src/blowOutcomes.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { upstream } from './harness/upstream.mjs';
import { oracleEntity, upstreamBody } from './harness/upstreamBodies.mjs';
import { sampleJointBlow, compareCounts, jointKey } from './harness/blowOracle.mjs';

const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const item = () => ({ ...weapon(121, { material: 9 }), rarity: 'rare', imprint: 'warp-edge' });
const tierOf = (target) => {
  const it = item();
  const ch = simCharacter(BASIC(), it);
  return { tier: blowFightTier(ch, { target, health: 100, weapon: weaponOf(it) }), ch, it };
};
const echoMass = (tier) => tier.outcomes.filter((o) => o.echoMask > 0).reduce((s, o) => s + o.p, 0);

test('1. one Many Endings power on a relay body matches the sampled joint blow', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const it = item();
  const sample = sampleJointBlow(u, {
    desc: BASIC(), item: it, body: oracleEntity(body), hand: 'main', seed: 0x3401, draws: 200000,
    echoPower: 'warp-edge',
  });
  const { tier } = tierOf(standInTarget(31));
  const expected = new Map(tier.outcomes.map((o) => [jointKey(o), o.p]));
  const r = compareCounts(sample.counts, sample.draws, expected);
  assert.ok(r.ok, `joint echo: ${r.chiZ.toFixed(2)} chi z, max cell ${r.maxZ.toFixed(2)}`);
  const localEcho = echoMass(tier);
  const upEcho = sample.agg.echo / sample.draws;
  const z = (upEcho - localEcho) / Math.sqrt(localEcho * (1 - localEcho) / sample.draws);
  assert.ok(Math.abs(z) <= 4.5, `echo marginal z ${z.toFixed(2)} (${upEcho} vs ${localEcho})`);
  // the echo roll is 10% on a blow whose final damage is positive (here: a landed hit)
  const hitMass = tier.outcomes.filter((o) => o.hit).reduce((s, o) => s + o.p, 0);
  assert.ok(Math.abs(localEcho / hitMass - 0.1) < 1e-9, `echo among positive blows ${localEcho / hitMass}`);
});

test('2. the echo is resisted separately from the original blow (bladeturning)', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const it = item();
  const target = { ...standInTarget(31), bossTraits: ['bladeturning'] };
  const sample = sampleJointBlow(u, {
    desc: BASIC(), item: it, body: oracleEntity(body), hand: 'main', seed: 0x3402, draws: 200000,
    echoPower: 'warp-edge', traits: ['bladeturning'],
  });
  const { tier } = tierOf(target);
  const expected = new Map(tier.outcomes.map((o) => [jointKey(o), o.p]));
  const r = compareCounts(sample.counts, sample.draws, expected);
  assert.ok(r.ok, `resisted echo: ${r.chiZ.toFixed(2)} chi z, max cell ${r.maxZ.toFixed(2)}`);
  // a bladed blow and its bladed echo are each halved (max 1), not the sum halved and rounded
  const values = new Set(tier.outcomes.filter((o) => o.echoHits > 0).map((o) => o.blow));
  assert.ok(values.size >= 2, `distinct resisted echo values: ${[...values].slice(0, 5)}`);
});

test('3. a Potent Vs miss is a positive-damage blow in the sampled distribution', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const pv = { type: 4, param: 1 };
  const it = { ...weapon(121, { material: 9 }), enchantments: [pv] };
  const sample = sampleJointBlow(u, {
    desc: BASIC(), item: it, body: oracleEntity(body), hand: 'main', seed: 0x3403, draws: 200000,
  });
  const ch = simCharacter(BASIC(), it);
  const tier = blowFightTier(ch, { target: standInTarget(31), health: 100, weapon: weaponOf(it) });
  const r = compareCounts(sample.counts, sample.draws, new Map(tier.outcomes.map((o) => [jointKey(o), o.p])));
  assert.ok(r.ok, `Potent Vs miss: ${r.chiZ.toFixed(2)} chi z, max cell ${r.maxZ.toFixed(2)}`);
  const miss5 = tier.outcomes.filter((o) => o.hit === false && o.blow === 5).reduce((s, o) => s + o.p, 0);
  assert.ok(miss5 > 0, 'the local tier has the miss-with-five branch');
  assert.ok([...sample.counts.keys()].some((k) => k.split('|')[4] === '0' && k.split('|')[7] === '5'), 'upstream sampled it');
});
