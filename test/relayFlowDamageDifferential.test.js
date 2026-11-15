/*
 * test/relayFlowDamageDifferential.test.js - Stage 3.4.2: Flow's damage at stacks 1..4.
 *
 * For each stack count, reset upstream loot state, seed exactly that many landed Flow charges at t=1, and draw real
 * upstream blows at t=1. The local fight tier is compared by the actual damage distribution (counts), not by a mean
 * against `analyze`. No local distribution is handed to the oracle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { weaponOf } from '../src/model.js';
import { standInTarget } from '../src/target.js';
import { blowFightTier } from '../src/blowOutcomes.js';
import { character, simCharacter, upstreamEntity, weapon } from './harness/fixtures.mjs';
import { upstream } from './harness/upstream.mjs';
import { oracleEntity, upstreamBody } from './harness/upstreamBodies.mjs';
import { oracleItem } from './harness/fightOracle.mjs';
import { generator } from './harness/prng.mjs';
import { compareCounts } from './harness/blowOracle.mjs';
import {
  _resetLootPowersForTests, _setLootPowersClockForTests, flowStacks, lootStrike,
} from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';

const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const item = () => ({ ...weapon(121, { material: 9 }), rarity: 'legendary', legendary: 'anseis-edge' });

test('Flow damage at stacks 1..4 matches upstream draw for draw', async () => {
  const u = await upstream();
  const it = item();
  const upItem = oracleItem(it);
  const attacker = upstreamEntity(BASIC());
  const slots = u.equip.equipTableOf(attacker);
  slots[u.equip.EQUIP_SLOTS.RightHand] = upItem;
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const upBody = oracleEntity(body);
  const ch = simCharacter(BASIC(), it);
  const mods = u.playerWeapon.SWING_MODS.StrikeLeft;
  const target = standInTarget(31);

  try {
    for (const stacks of [1, 2, 3, 4]) {
      const draws = 20000;
      const rng = generator(0x3420 + stacks * 37);
      const counts = new Map();
      for (let i = 0; i < draws; i++) {
        _resetLootPowersForTests();
        _setLootPowersClockForTests(() => 1);
        for (let k = 0; k < stacks; k++) lootStrike(attacker, { isPlayer: false }, 100, upItem, { blow: true });
        assert.equal(flowStacks(1), stacks, `seeded ${stacks} stacks`);
        const raw = u.formulas.calculateAttackDamage(attacker, upBody, {
          weapon: upItem, damageMod: mods.damage, toHitMod: mods.toHit, rolls: rng, backstabChance: 0,
        });
        counts.set(raw, (counts.get(raw) ?? 0) + 1);
      }
      _resetLootPowersForTests();
      _setLootPowersClockForTests(null);
      const tier = blowFightTier(ch, {
        target, health: 100, weapon: weaponOf(it), swing: 'StrikeLeft', flowStacks: stacks,
      });
      const expected = new Map();
      for (const o of tier.outcomes) expected.set(o.blow, (expected.get(o.blow) ?? 0) + o.p);
      const r = compareCounts(counts, draws, expected);
      assert.ok(r.ok, `stacks ${stacks}: chi z ${r.chiZ.toFixed(2)}, max cell ${r.maxZ.toFixed(2)} at ${r.worst?.key}`);
    }
  } finally {
    _resetLootPowersForTests();
    _setLootPowersClockForTests(null);
    slots[u.equip.EQUIP_SLOTS.RightHand] = null;
  }
});
