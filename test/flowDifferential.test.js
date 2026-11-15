/*
 * test/flowDifferential.test.js - Stage 3.4: the Flow stack clock against upstream lootStrike.
 *
 * The oracle calls the vendored `lootStrike` (systems/loot/lootPowers.js:351-387) with a known damage, a whole/non-whole
 * info flag and a seeded clock, and reads `flowStacks` (:274). The local `createFlowState` must equal it after every
 * strike, including strict expiry, refresh and the cap. No local fight result is used as an expected value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFlowState } from '../src/flowState.js';
import { upstreamEntity, upstreamWeapon, weapon } from './harness/fixtures.mjs';
import { upstream } from './harness/upstream.mjs';
import {
  _resetLootPowersForTests, _setLootPowersClockForTests, flowStacks, lootStrike,
} from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';

const LEVEL = 30;
const ITEM = () => ({ ...weapon(121, { material: 9 }), rarity: 'legendary', legendary: 'anseis-edge' });
const UP_ITEM = (item) => ({ ...upstreamWeapon(item), rarity: item.rarity, legendary: item.legendary });

test('Flow: stacks, strict expiry, refresh and cap agree with lootStrike', async () => {
  const u = await upstream();
  const desc = {
    level: LEVEL, raceId: 1,
    stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
    skills: Array.from({ length: 35 }, () => 50),
  };
  const attacker = upstreamEntity(desc);
  const item = ITEM();
  const upItem = UP_ITEM(item);
  const slots = u.equip.equipTableOf(attacker);
  slots[u.equip.EQUIP_SLOTS.RightHand] = upItem;

  let now = 0;
  _resetLootPowersForTests();
  _setLootPowersClockForTests(() => now);
  const local = createFlowState({ max: 5, seconds: 6 });
  try {
    const steps = [
      { t: 0, whole: true, d: 100, warded: false },
      { t: 1, whole: true, d: 100, warded: false },
      { t: 2, whole: true, d: 100, warded: false },
      { t: 3, whole: true, d: 100, warded: false },
      { t: 4, whole: true, d: 100, warded: false },
      { t: 5, whole: false, d: 100, warded: false }, // no charge, stack 5 remains
      { t: 6, whole: true, d: 100, warded: false }, // read 5, refresh to 5
      { t: 7, whole: false, d: 100, warded: false }, // still 5
      { t: 12, whole: true, d: 100, warded: false }, // expired at 12 exactly: read 0, build 1
      { t: 13, whole: true, d: 100, warded: false }, // 2
      { t: 14, whole: false, d: 100, warded: false },
      { t: 19, whole: true, d: 100, warded: false }, // expired at 18, build 1
      { t: 26, whole: true, d: 100, warded: false }, // expired at 25, build 1
      { t: 26, whole: true, d: 100, warded: false }, // same time, build 2
      { t: 26, whole: false, d: 100, warded: false },
      { t: 27, whole: true, d: 0, warded: false }, // no damage: no charge
      { t: 28, whole: true, d: 100, warded: true }, // warded: no charge
    ];
    for (const step of steps) {
      now = step.t;
      const eligible = step.d > 0 && !step.warded;
      const before = local.stacksAt(step.t);
      const l = local.hit(step.t, { whole: step.whole, eligible });
      assert.equal(l.before, before);
      const target = { isPlayer: false, warded: step.warded };
      lootStrike(attacker, target, step.d, upItem, { blow: step.whole });
      const up = flowStacks(step.t);
      assert.equal(local.stacksAt(step.t), up, `t ${step.t} whole ${step.whole} warded ${step.warded}: local ${local.stacksAt(step.t)} vs ${up}`);
      assert.equal(l.after, up);
    }
    // the cap and the refresh duration
    assert.equal(local.max, 5);
    assert.equal(local.seconds, 6);
    assert.equal(local.stacksAt(999), 0);
  } finally {
    _resetLootPowersForTests();
    _setLootPowersClockForTests(null);
    slots[u.equip.EQUIP_SLOTS.RightHand] = null;
  }
});
