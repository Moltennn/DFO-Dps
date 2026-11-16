/*
 * test/echoDuplicate.test.js - Stage 3.5.3f: a breaking weapon's Many Endings echo and the surviving same-ID weapon.
 *
 * Upstream `blowPowers` keeps a worn item's power when its ID is also carried by the striking weapon
 * (vendor:systems/loot/lootPowers.js:262-268). The strike listener runs after `damageEquipment` (`combat/formulas.js:769`,
 * `:869-877`), so on a breaking blow a surviving weapon carrying the SAME echo power ID still rolls the echo; a different
 * power, no survivor, or a what-if-only imprint on the striker does not. The local tier carries each echo's item ID (or
 * what-if source) aligned with `echoMask`; this file checks the production `simulateFight` and the vendored full blow.
 *
 * Same seeds mean the same local sampler draws; no event-level RNG equivalence with the game is claimed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { character, simCharacter, weapon, upstreamWeapon } from './harness/fixtures.mjs';
import { referenceFoe, weaponOf } from '../src/model.js';
import { simulateFight } from '../src/simulateFight.js';
import { upstream, playerEntity, referenceFoe as upstreamFoe } from './harness/upstream.mjs';
import { setPlayerDoor } from '../vendor/upstream/a3eb1605/src/systems/playerDoor.js';
import { _resetLootPowersForTests, _setLootPowersRandForTests } from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';
import { EQUIP_SLOTS, equipTableOf } from '../vendor/upstream/a3eb1605/src/systems/equip.js';
import { powerOf } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';

const D = character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const g = (cond, extra = {}) => ({ ...weapon(121, { material: 9 }), maxCondition: 1000, currentCondition: cond, ...extra });
const WARP = { rarity: 'rare', imprint: 'warp-edge' }; // Many Endings, echo 10%
const EYE = { rarity: 'rare', imprint: 'eye-of-magnus' }; // pierce, not an echo

/** A pair in the production fight. `mainExtra`/`offExtra` are item fields; `scenario` is the fight scenario. */
function run({ mainCond = 1, offCond = 1000, mainExtra = WARP, offExtra = WARP, scenario = {}, seed = 0, blows = 1 } = {}) {
  const main = g(mainCond, mainExtra);
  const ch = simCharacter(D, main);
  ch.offWeapon = { ...g(offCond, offExtra), equipSlot: 21 };
  ch._dual = true;
  return simulateFight(ch, {
    target: referenceFoe(30, 'tough'), health: 1e6, weapon: weaponOf(main), seed, durability: true, trace: true,
    maxBlows: blows, conditionRolls: () => 0.1, dual: true, ...scenario,
  });
}
const find = (make, pred, max = 1000) => {
  for (let seed = 0; seed < max; seed += 1) {
    const r = make(seed);
    if (r && pred(r)) return { r, seed };
  }
  return null;
};
const at = (r, hand) => r.trace[hand === 'main' ? 0 : 1];
/** The echo repeats the blow's final damage as `max(1, round(damage))`; with no target traits or pull that is the blow. */
const perEcho = (e) => Math.max(1, Math.round(e.blowDamage));
const assertEchoAmount = (e) => assert.equal(e.echoDamage, e.echoHits * perEcho(e), 'only the eligible sampled hits are counted');

test('G5: main striker breaks; the off hand with the same echo ID keeps the echo', () => {
  const found = find((seed) => run({ mainCond: 1, offCond: 1000, seed, blows: 1 }), (r) => at(r, 'main')?.broke && at(r, 'main').echoApplied > 0);
  assert.ok(found, 'a breaking main blow whose duplicate echo applies');
  const e = at(found.r, 'main');
  assert.equal(e.echoSuppressed, false, 'the surviving off hand carries warp-edge');
  assert.ok(e.echoHits > 0);
  assert.ok(e.echoDamage > 0);
  assertEchoAmount(e);
  assert.ok(found.r.echoDamage > 0);
});

test('G5: off-hand striker breaks; the main hand with the same echo ID keeps the echo', () => {
  const found = find((seed) => run({ mainCond: 1000, offCond: 1, seed, blows: 2 }), (r) => at(r, 'off')?.broke && at(r, 'off').echoApplied > 0);
  assert.ok(found, 'a breaking off blow whose duplicate echo applies');
  const e = at(found.r, 'off');
  assert.equal(e.echoSuppressed, false);
  assert.ok(e.echoHits > 0);
  assert.ok(e.echoDamage > 0);
  assertEchoAmount(e);
});

test('G5: a broken striker with no echo on the survivor suppresses the echo; trace shows no event', () => {
  for (const offExtra of [{}, EYE]) {
    const found = find((seed) => run({ mainCond: 1, offCond: 1000, offExtra, seed, blows: 1 }), (r) => at(r, 'main')?.broke);
    assert.ok(found);
    const e = at(found.r, 'main');
    assert.equal(e.echoSuppressed, true);
    assert.equal(e.echoHits, 0, 'the local sample is not an upstream roll');
    assert.equal(e.echoDamage, 0);
    assert.equal(e.echoApplied, 0);
  }
});

test('G5: a what-if-only echo on the striker is not resurrected by an item on the survivor', () => {
  const found = find(
    (seed) => run({ mainCond: 1, mainExtra: {}, offExtra: WARP, scenario: { imprints: [powerOf('warp-edge')] }, seed, blows: 1 }),
    (r) => at(r, 'main')?.broke,
  );
  assert.ok(found);
  const e = at(found.r, 'main');
  assert.equal(e.echoSuppressed, true, 'the striker item carries no warp-edge: the survivor cannot resurrect the what-if');
  assert.equal(e.echoHits, 0);
  assert.equal(e.echoApplied, 0);
});

test('G5: no-break duplicate-ID control keeps the echo', () => {
  const found = find((seed) => run({ mainCond: 1000, offCond: 1000, seed, blows: 5 }), (r) => r.trace.some((e) => e.echoHits > 0 && e.echoApplied > 0));
  assert.ok(found);
  const e = found.r.trace.find((x) => x.echoHits > 0);
  assert.equal(e.echoSuppressed, false);
  assert.ok(e.echoDamage > 0);
  assertEchoAmount(e);
});

test('G5: a no-break blow keeps the striking weapon\'s echo even when the other hand has none', () => {
  const found = find(
    (seed) => run({ mainCond: 1000, offCond: 1000, offExtra: {}, seed, blows: 5 }),
    (r) => r.trace.some((e) => e.echoHits > 0 && e.echoApplied > 0),
  );
  assert.ok(found);
  const e = found.r.trace.find((x) => x.echoHits > 0);
  assert.equal(e.echoSuppressed, false, 'no break: the striking main still carries the echo');
  assert.ok(e.echoDamage > 0);
  assertEchoAmount(e);
});

test('G5: with two echo powers, only the surviving same-ID echo remains eligible', () => {
  const OTHER = { name: 'Other Echo', kind: 'echo', chance: 100 };
  const withOther = (seed) => run({ mainCond: 1, offCond: 1000, scenario: { imprints: [OTHER] }, seed, blows: 1 });
  // The item's warp-edge misses; the 100% what-if would hit, but it is not on the survivor's item.
  const miss = find((seed) => withOther(seed), (r) => at(r, 'main')?.broke && at(r, 'main').echoHits === 0);
  assert.ok(miss);
  assert.equal(at(miss.r, 'main').echoSuppressed, false, 'warp-edge is still eligible from the survivor; its roll missed');
  assert.equal(at(miss.r, 'main').echoDamage, 0);
  assert.equal(at(miss.r, 'main').echoApplied, 0);
  // warp-edge hits too; the aggregate must be ONE hit, not two (the what-if is dropped).
  const hit = find((seed) => withOther(seed), (r) => at(r, 'main')?.broke && at(r, 'main').echoHits === 1);
  assert.ok(hit);
  assert.equal(at(hit.r, 'main').echoSuppressed, false);
  assert.ok(at(hit.r, 'main').echoDamage > 0);
  assertEchoAmount(at(hit.r, 'main'));
  assert.ok(hit.r.trace.every((x) => x.echoHits <= 1));
});

test('G5: upstream and local agree on which breaking blows still echo (event presence only)', async () => {
  const u = await upstream();
  const item = (cond, extra) => ({ ...upstreamWeapon(weapon(121, { material: 9 })), maxCondition: 1000, currentCondition: cond, ...extra });
  const foe = () => ({ ...upstreamFoe(u, 30, 'tough'), health: 100000, maxHealth: 100000, activeEffects: [], career: {} });
  const upstreamEcho = ({ main, off, hand }) => {
    const e = playerEntity({ level: 30 });
    const slots = equipTableOf(e);
    slots[EQUIP_SLOTS.RightHand] = main;
    slots[EQUIP_SLOTS.LeftHand] = off;
    const body = foe();
    let echoes = 0;
    setPlayerDoor({ foes: () => [{ entity: body, dead: false }], feet: () => [0, 0, 0], hurtFoe: (f) => { if (!f.dead) echoes += 1; }, castOnPlayer: () => {} });
    _resetLootPowersForTests();
    _setLootPowersRandForTests(() => 0);
    try {
      u.formulas.calculateAttackDamage(e, body, { weapon: hand === 'main' ? main : off, rolls: () => 0.05, backstabChance: 0 });
      return echoes;
    } finally {
      _resetLootPowersForTests();
      setPlayerDoor(null);
    }
  };
  const cases = [
    { id: 'main X breaks, off X', main: item(1, WARP), off: item(1000, WARP), hand: 'main', up: 1, breaks: true },
    { id: 'main X breaks, off plain', main: item(1, WARP), off: item(1000), hand: 'main', up: 0, breaks: true },
    { id: 'main X breaks, off EYE', main: item(1, WARP), off: item(1000, EYE), hand: 'main', up: 0, breaks: true },
    { id: 'main plain breaks, off X', main: item(1), off: item(1000, WARP), hand: 'main', up: 0, breaks: true },
    { id: 'no break, main X / off X', main: item(1000, WARP), off: item(1000, WARP), hand: 'main', up: 1, breaks: false },
    { id: 'no break, main X / off plain', main: item(1000, WARP), off: item(1000), hand: 'main', up: 1, breaks: false },
    { id: 'off X breaks, main X', main: item(1000, WARP), off: item(1, WARP), hand: 'off', up: 1, breaks: true },
    { id: 'off X breaks, main plain', main: item(1000), off: item(1, WARP), hand: 'off', up: 0, breaks: true },
  ];
  for (const c of cases) {
    const up = upstreamEcho(c);
    assert.equal(up, c.up, `${c.id}: upstream`);
    const itemExtra = (it) => (it.imprint === 'warp-edge' ? WARP : (it.imprint === 'eye-of-magnus' ? EYE : {}));
    const mainExtra = itemExtra(c.main);
    const offExtra = itemExtra(c.off);
    const mainCond = c.main.currentCondition;
    const offCond = c.off.currentCondition;
    const label = c.id;
    if (c.up === 1) {
      const found = find(
        (seed) => run({ mainCond, offCond, mainExtra, offExtra, seed, blows: c.breaks ? (c.hand === 'off' ? 2 : 1) : 5 }),
        (r) => (c.breaks ? at(r, c.hand)?.broke : true) && at(r, c.hand).echoApplied > 0,
      );
      assert.ok(found, `${label}: local echo applies`);
      assert.equal(at(found.r, c.hand).echoSuppressed, false, label);
      assert.ok(at(found.r, c.hand).echoHits > 0, label);
    } else {
      const found = find((seed) => run({ mainCond, offCond, mainExtra, offExtra, seed, blows: c.hand === 'off' ? 2 : 1 }), (r) => at(r, c.hand)?.broke);
      assert.ok(found, `${label}: local break`);
      assert.equal(at(found.r, c.hand).echoApplied, 0, label);
      assert.equal(at(found.r, c.hand).echoHits, 0, label);
      assert.equal(at(found.r, c.hand).echoSuppressed, true, label);
    }
  }
});
