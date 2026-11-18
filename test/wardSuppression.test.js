/*
 * test/wardSuppression.test.js - Stage 3.6c: a WARD turns every per-blow power, and only those.
 *
 * Upstream gates each per-blow channel on the target's `warded` flag (the host copies the Warden's/court's word onto the
 * body; the relay's own clock is `shieldUntil`, a different field the claim engine reads):
 *   1. lootBlow       vendor:systems/loot/lootPowers.js:287   - slayer, elemental, bane, unaware, sanctified, flow,
 *                                                                venom, moon, rage, execute, ... all inside one early return
 *   2. lootStrike     vendor:systems/loot/lootPowers.js:354   - early return: no leech, chain, quake, echo, fists
 *   3. CastWhenStrikes vendor:systems/enchantments.js:597     - no cast, no bill (already local: cwsEligible)
 *   4. weaponMasteryBlow vendor:systems/weaponMastery.js:141  - returns the damage
 *   5. firmamentBlow  vendor:systems/firmamentPowers.js:173   - checked with a live tree in firmamentBlow.test.js
 *   6. martialPowers  vendor:systems/martialPowers.js:136     - foeOf: !target.warded (the blow at :229 and the strike
 *                                                                at :241 both read it)
 *   7. Vampiric WhenStrikes vendor:systems/artifactEffects.js:247 and vendor:systems/enchantments.js:674
 * NOT gated, and must stay: Potent Vs / Low Damage Vs (vendor:systems/enchantments.js:623-631) - the Strikes payload is
 * not a blow power; a warded blow still carries its +5.
 *
 * The local side is the CARD's own pipeline: `weaponBlow` for the blow powers (one gate), `afterShare` for the strike
 * listener's echo. `upBody`/`localBody` are copied from test/dotDifferential.test.js's pattern (they are five lines and
 * this file also needs the group/affinity pair the two sides read differently).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { upstream, referenceFoe, weaponItem, playerEntity } from './harness/upstream.mjs';
import { character, simCharacter, weapon, upstreamEntity } from './harness/fixtures.mjs';
import { analyze, blowDistribution, martialBlowPct, masteryPct, strikesNet, weaponBlow, weaponOf } from '../src/model.js';
import { makeTarget } from '../src/target.js';
import { cwsEligible } from '../src/cws.js';
import { setPlayerDoor } from '../vendor/upstream/a3eb1605/src/systems/playerDoor.js';
import { _resetLootPowersForTests, _setLootPowersRandForTests } from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';

const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 }, skills: 40,
});

/** The oracle body: the CWS differential's fixture, plus the affinity the slayer/martial group reads. */
const upBody = (u, { warded = false } = {}) => ({
  ...referenceFoe(u, 30, 'tough'),
  health: 1000, maxHealth: 1000, activeEffects: [], career: {}, skills: {},
  _mods: { stats: {}, skills: {}, statMax: {} }, magicka: 0, maxMagicka: 1000,
  affinity: 'Human', warded,
});

/** The same body locally. `group` is what the local slayer line reads; `affinity` is what the vendored foeGroup reads. */
const localBody = ({ warded = false } = {}) => makeTarget({
  isClass: false, level: 30, careerIndex: -1, career: null,
  stats: { strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50 },
  skills: {}, activeEffects: [], _mods: { stats: {}, skills: {}, statMax: {} },
  health: 1000, maxHealth: 1000, magicka: 0, maxMagicka: 1000,
  affinity: 'Human', group: 'humanoid', warded,
});

const SLASH = [{ id: 'slayer', param: 'humanoid', value: 20 }, { id: 'elemental', param: 'fire', value: 10 }];
/** A weapon item both sides read: the upstream shape, with the two loot lines. */
const linedItem = () => ({ ...weaponItem(121, { material: 9 }), affixes: SLASH.map((a) => ({ ...a })) });

test('A ward: lootBlow adds no slayer percent and no elemental flat to a warded foe', async () => {
  const u = await upstream();
  const item = linedItem();
  const attacker = playerEntity({ level: 30 });
  // `estimate: true` = no fraction carried between blows (W-LOOT-CARRY); the card is the estimate.
  const upPlain = u.lootPowers.lootBlow(item, 100, attacker, upBody(u), { estimate: true });
  const upWarded = u.lootPowers.lootBlow(item, 100, attacker, upBody(u, { warded: true }), { estimate: true });
  assert.equal(upPlain, 130, 'the control: +20% of 100, then +10 elemental');
  assert.equal(upWarded, 100, 'a warded foe takes the weapon damage alone');

  const ch = simCharacter(BASIC(), item);
  const w = weaponOf(item);
  assert.equal(weaponBlow(ch, w, 100, localBody(), {}), upPlain);
  assert.equal(weaponBlow(ch, w, 100, localBody({ warded: true }), {}), upWarded);
});

test('B ward: weaponMasteryBlow adds nothing to a warded foe', async () => {
  const u = await upstream();
  const item = weaponItem(121, { material: 9 });
  const desc = character({
    level: 30, raceId: 1, skills: 40, skillOverride: { 29: 150 }, online: true, mastered: [29], masterSkills: true,
  });
  const attacker = { ...upstreamEntity(desc), _online: true, masteredSkills: [29] };
  // `weaponMasteryBlow` asks `isOnlinePage()` (it passes no `online` option), so the page lane has to be on for the
  // control to pay - the same switch the CWS differential uses for the school climb.
  globalThis.location = { search: '?online' };
  let upPlain;
  let upWarded;
  try {
    upPlain = u.weaponMastery.weaponMasteryBlow(item, 100, attacker, upBody(u), { estimate: true });
    upWarded = u.weaponMastery.weaponMasteryBlow(item, 100, attacker, upBody(u, { warded: true }), { estimate: true });
  } finally {
    delete globalThis.location;
  }
  assert.ok(upPlain > 100, 'the control: the skill past 100 pays');
  assert.equal(upWarded, 100, 'a warded foe takes the damage alone');

  const ch = simCharacter(desc, item);
  const w = weaponOf(item);
  // The one gate lives in `weaponBlow` (every blow passes it), so the channel's own helper still reports its percent;
  // what must hold is that the BLOW adds nothing on a warded foe - `upPlain - 100` is the oracle's own addition.
  assert.equal(masteryPct(ch, w, localBody(), {}), upPlain - 100, 'the local mastery percentage is the oracle addition');
  assert.equal(masteryPct(ch, w, localBody({ warded: true }), {}), upPlain - 100,
    'the channel itself still reports its percent: weaponBlow\'s single ward gate is what suppresses the blow');
  assert.equal(weaponBlow(ch, w, 100, localBody(), {}), upPlain);
  assert.equal(weaponBlow(ch, w, 100, localBody({ warded: true }), {}), upWarded);
});

test('C ward: the martial blow channel adds nothing to a warded foe', async () => {
  const u = await upstream();
  const item = weaponItem(121, { material: 9 });
  const path = u.martialPaths.MARTIAL_BY_ID.cutthroat;
  const desc = character({
    level: 30, raceId: 1, skills: 40, online: true, martialPath: 'cutthroat', mastered: [...path.skills],
  });
  const attacker = { ...upstreamEntity(desc), _online: true, martialPath: 'cutthroat', masteredSkills: [...path.skills] };
  const info = { unaware: true, estimate: true };
  const upPlain = u.martialPowers.martialBlow(item, 100, attacker, upBody(u), info);
  const upWarded = u.martialPowers.martialBlow(item, 100, attacker, upBody(u, { warded: true }), info);
  assert.ok(upPlain > 100, 'the control: Cheap Shot pays on an unaware foe');
  assert.equal(upWarded, 100, 'a warded foe takes the damage alone');

  const ch = simCharacter(desc, item);
  const w = weaponOf(item);
  assert.equal(martialBlowPct(ch, localBody(), { unaware: true }), upPlain - 100, 'the local path percentage is the oracle addition');
  assert.equal(martialBlowPct(ch, localBody({ warded: true }), { unaware: true }), upPlain - 100,
    'the path itself still reports its percent: weaponBlow\'s single ward gate is what suppresses the blow');
  assert.equal(weaponBlow(ch, w, 100, localBody(), { unaware: true }), upPlain);
  assert.equal(weaponBlow(ch, w, 100, localBody({ warded: true }), { unaware: true }), upWarded);
});

test('D ward: lootStrike answers a warded foe with nothing - no echo, no leech, no chain', async () => {
  const u = await upstream();
  const item = { ...weaponItem(121, { material: 9 }), rarity: 'rare', imprint: 'warp-edge' };
  const attacker = playerEntity({ level: 30 });
  attacker.equip.slots[19] = item;
  /** The echo the strike listener lands on the foe (the door's hurtFoe), through the vendored lootStrike itself. */
  const strike = (warded) => {
    const body = upBody(u, { warded });
    let applied = 0;
    setPlayerDoor({
      foes: () => [{ entity: body, dead: false }],
      feet: () => [0, 0, 0],
      hurtFoe: (f, n) => { applied += n; },
      castOnPlayer: () => {},
    });
    _resetLootPowersForTests();
    _setLootPowersRandForTests(() => 0);
    try {
      u.lootPowers.lootStrike(attacker, body, 20, item, { blow: true });
    } finally {
      _resetLootPowersForTests();
      setPlayerDoor(null);
    }
    return applied;
  };
  assert.ok(strike(false) > 0, 'the control: an unwarded foe is answered with the echo');
  assert.equal(strike(true), 0, 'a warded foe is answered with nothing');

  // The local card's echo (Many Endings' `x`) must vanish the same way: the warded delta between the item with its echo
  // imprint and the same item without it is zero.
  const echoDelta = (warded) => {
    const t = localBody({ warded });
    const echoCh = simCharacter(BASIC(), { ...weapon(121, { material: 9 }), rarity: 'rare', imprint: 'warp-edge' });
    const plainCh = simCharacter(BASIC(), weapon(121, { material: 9 }));
    return analyze(echoCh, { target: t, health: 1000 }).perSwing - analyze(plainCh, { target: t, health: 1000 }).perSwing;
  };
  assert.ok(echoDelta(false) > 0, 'the control: the local card carries the echo');
  assert.equal(echoDelta(true), 0, 'a warded target: the card carries no echo');
});

test('GREEN GUARD: Potent Vs survives a ward - the Strikes payload is not a blow power', async () => {
  const u = await upstream();
  const item = { ...weaponItem(121, { material: 9 }), equipSlot: 19, enchantments: [{ type: 4, param: 1 }] };
  const attacker = playerEntity({ level: 30 });
  const upRaw = u.formulas.calculateAttackDamage(attacker, { ...upBody(u, { warded: true }), mobileType: 25 }, {
    weapon: item, rolls: () => 0.5, toHitMod: -1000,
  });
  assert.equal(upRaw, 5, 'a warded MISS still carries the +5 payload (enchantments.js:623-631 is not gated)');
  const local = { ...localBody({ warded: true }), mobileType: 25 };
  assert.equal(strikesNet(item, local), 5);
  assert.equal(strikesNet(item, local), upRaw);
});

test('GREEN GUARD: Cast When Strikes is refused by a ward - no cast, no bill', async () => {
  const u = await upstream();
  const spell = {
    name: 'Ward Probe', index: 1, element: 4, rangeType: 1,
    effects: [{
      type: 4, subType: 0, magnitudeBaseLow: 10, magnitudeBaseHigh: 10,
      magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
      durationBase: 0, durationMod: 0, durationPerLevel: 1, chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
    }],
  };
  /** One blow with a CWS row: how many casts it made and how much condition it lost (wear + the row's bill). */
  const blow = (warded) => {
    const item = { ...weaponItem(121, { material: 9 }), equipSlot: 19, enchantments: [{ type: 2, param: 1 }] };
    const body = upBody(u, { warded });
    let casts = 0;
    const before = item.currentCondition;
    u.formulas.calculateAttackDamage(playerEntity({ level: 30 }), body, {
      weapon: item, rolls: () => 0.5, toHitMod: 1000,
      enchantCtx: { spellsByIndex: () => new Map([[1, spell]]), applySpellToTarget: () => { casts += 1; } },
    });
    return { casts, drop: before - item.currentCondition, item };
  };
  const plain = blow(false);
  const warded = blow(true);
  assert.equal(plain.casts, 1, 'the control casts');
  assert.equal(warded.casts, 0, 'a warded foe is not cast at');
  assert.equal(warded.drop, plain.drop - 10, 'and the row bills nothing: the warded blow pays only its ordinary wear');

  const item = warded.item;
  const standard = new Map([[1, spell]]);
  assert.equal(cwsEligible({ target: localBody({ warded: true }), strikesPositive: true, whole: true, item, standard }), false);
  assert.equal(cwsEligible({ target: localBody(), strikesPositive: true, whole: true, item, standard }), true);
});

test('the boss `warded` TRAIT is a health pool the owner takes first, not `target.warded`: pool and drain match bossTake', async () => {
  // vendor:systems/bossTraits.js:8 "a ward of WARD_SHARE of its health takes every blow first"; :20-23 the ward is the
  // OWNER's half (`bossTake`, where its health is), after the blow has landed - so the striker's per-blow powers fire
  // as usual; :390-391 the relay bosses carry no ward at all. `target.warded` is the REFEREE's flag (vendor:systems/
  // enchantments.js:594 "a stand-in `warded` - the Warden's ward, the Remnant shut, the Spire's turned blows"), and no
  // vendored code sets it from the trait. Whether the cut host (`dungeonContext.js`) ever copies the trait ward onto
  // `target.warded` is NOT established (docs: U8); this test pins what the source says.
  const u = await upstream();
  const item = linedItem();
  const ch = simCharacter(BASIC(), item);
  const w = weaponOf(item);
  const plain = localBody();
  // 1. the powers still pay under the trait; only a caller-set target.warded suppresses them
  assert.equal(weaponBlow(ch, w, 100, plain, {}), 130, 'the trait does not suppress the slayer/elemental lines');
  assert.equal(weaponBlow(ch, w, 100, localBody({ warded: true }), {}), 100, 'only target.warded does');
  // 2. the pool: local ward === the vendored ward's maximum (WARD_SHARE of max health, rounded, at least 1)
  for (const health of [1, 3, 17, 500, 1000, 12345, 250000]) {
    const e = { maxHealth: health, bossTraits: ['warded'] };
    assert.equal(u.bossTraits.standBossWard(e, 0), true);
    const up = u.bossTraits.bossWardNow(e, 0);
    const card = analyze(ch, { target: plain, health, traits: ['warded'] });
    assert.equal(card.ward, up.max, `the ward pool at ${health} health`);
    // the card's own time to kill uses that same pool: (health + ward) / capped dps, no shields on this body
    assert.ok(card.cappedDps > 0);
    assert.ok(Math.abs(card.ttkCapOnly * card.cappedDps - (health + card.ward)) <= 1e-9 * (health + card.ward),
      `the card's TTK spends health + ward at ${health} health`);
    // 3. the drain: blows of 37 against bossTake (no regrowth inside one fight) need ceil((health + ward) / 37) of them,
    //    which is the card's (health + ward) / dps with a steady rate
    const d = 37;
    let blows = 0;
    let toHealth = 0;
    let guard = 0;
    while (toHealth < health && guard++ < 100000) {
      toHealth += u.bossTraits.bossTake(e, d, { nowS: 0, mine: false }).damage;
      blows += 1;
    }
    assert.equal(blows, Math.ceil((health + up.max) / d), `blows to kill through the ward at ${health} health`);
  }
});

test('blowDistribution: a warded target draws no echo', () => {
  const w = weaponOf(weapon(121, { material: 9 }));
  const mean = (m) => [...m].reduce((a, [v, p]) => a + v * p, 0);
  // The same rolls with and without a 100% echo: a ward must leave the two identical.
  const plainWith = mean(blowDistribution([100], 4, { target: localBody(), weapon: w, echoes: [100] }));
  const plainWithout = mean(blowDistribution([100], 4, { target: localBody(), weapon: w }));
  assert.ok(plainWith > plainWithout, 'the control: an unwarded blow is answered with the echo');
  const wardedWith = mean(blowDistribution([100], 4, { target: localBody({ warded: true }), weapon: w, echoes: [100] }));
  const wardedWithout = mean(blowDistribution([100], 4, { target: localBody({ warded: true }), weapon: w }));
  assert.equal(wardedWith, wardedWithout, 'a ward: `blowDistribution` carries no echo');
});

test('Q6: the ordinary fight keys the ward on target.warded, not the relay shield clock', () => {
  const item = weapon(121, { material: 9 });
  item.enchantments = [{ type: 2, param: 1 }];
  const standard = new Map([[1, {
    name: 'Probe', index: 1, element: 4, rangeType: 1,
    effects: [{
      type: 4, subType: 0, magnitudeBaseLow: 10, magnitudeBaseHigh: 10,
      magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
      durationBase: 0, durationMod: 0, durationPerLevel: 1, chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
    }],
  }]]);
  const base = { strikesPositive: true, whole: true, item, standard };
  assert.equal(cwsEligible({ ...base, target: localBody({ warded: true }) }), false);
  // The relay's own clock means nothing to the ordinary path: a body with a shield clock but no ward casts.
  assert.equal(cwsEligible({ ...base, target: { ...localBody(), shieldUntil: 999 } }), true);
  assert.equal(cwsEligible({ ...base, target: localBody() }), true);
});
