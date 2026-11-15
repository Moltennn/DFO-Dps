/*
 * test/flowState.test.js - Stage 3.4, the local Flow clock and its tier wiring.
 *
 * The upstream differential (test/flowDifferential.test.js) proves the stack clock against lootStrike. Here the strict
 * expiry, the whole/eligible gates and the existing `flowStacks` option are pinned locally.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, referenceFoe, weaponOf } from '../src/model.js';
import { blowFightTier, tierMeans } from '../src/blowOutcomes.js';
import { createFlowState } from '../src/flowState.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';

const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const item = () => ({ ...weapon(121, { material: 9 }), rarity: 'legendary', legendary: 'anseis-edge' });

test('Flow clock: strict expiry, cap, whole and eligibility gates', () => {
  const f = createFlowState({ max: 5, seconds: 6 });
  assert.equal(f.stacksAt(0), 0);
  assert.equal(f.hit(0, { whole: true }).after, 1);
  assert.equal(f.stacksAt(5.999), 1);
  assert.equal(f.stacksAt(6), 0, 'at exactly flowUntil the stack is gone');
  for (let t = 6; t < 11; t++) f.hit(t, { whole: true });
  assert.equal(f.stacksAt(10), 5);
  assert.equal(f.hit(10, { whole: false }).built, false, 'a non-whole blow does not charge');
  assert.equal(f.stacksAt(10), 5);
  assert.equal(f.hit(10, { whole: true, eligible: false }).built, false, 'a warded/zero blow does not charge');
  assert.equal(f.hit(10, { whole: true }).after, 5, 'the cap');
  assert.ok(f.until > 10, 'a charged blow refreshes the duration');
});

test('Flow stacks are applied through the existing blowFightTier option', () => {
  const it = item();
  const ch = simCharacter(BASIC(), it);
  const target = referenceFoe(30, 'tough');
  const args = { target, health: 12000, weapon: weaponOf(it) };
  const means = [];
  for (let s = 0; s <= 5; s++) {
    const tier = blowFightTier(ch, { ...args, flowStacks: s });
    const mean = tierMeans(tier).perSwing;
    const card = analyze(ch, { ...args, flowStacks: s }).perSwing;
    assert.ok(Math.abs(mean - card) <= 1e-12 * Math.max(1, Math.abs(card)), `stacks ${s}: tier ${mean} vs analyze ${card}`);
    means.push(mean);
  }
  for (let s = 1; s < means.length; s++) assert.ok(means[s] > means[s - 1], `stack ${s} raises the blow`);
});
