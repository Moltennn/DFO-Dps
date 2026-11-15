/*
 * test/manyEndings.test.js - Stage 2.11b, Part B: Many Endings rides the blow's own claim.
 *
 * Upstream (full checkout + vendored modules):
 *   systems/loot/lootPowers.js:374-376   lootStrike, told every blow that LANDED: `if (_rand()*100 < p.chance) again(target, damage)`
 *                                        - `damage` is the formula's number (before a shaft's pull and before any boss trait)
 *   systems/loot/lootPowers.js:444-454   again(): n = max(1, round(damage)); a foe with a room RECORD takes it as its own
 *                                        hit (door.hurtFoe: its own health, no trait, no cap); a body the relay runs has
 *                                        no record here - it is OWED (oweFoe) and its host's claim carries it
 *   scenes/dungeonContext.js:4528-4531   landOnBoss(): `damage += bossStrikeAt(takeOwed(entity), 'melee', weapon)` -
 *                                        the OWED number is resisted as a melee swing on its own and added to the
 *                                        resisted blow, and the two go out as ONE claim (one relay cap on the sum)
 *
 * So on a relay body the echo is not an independent capped hit: it is inside the same blow's claim, after the
 * defence and (as a melee swing) the boss's trait, before the per-hit cap - and it is clipped by that cap together
 * with the blow. On an ordinary foe it is a second hit on the foe's health, outside the trait and the cap.
 *
 * The oracle reproduces the host: it draws upstream's own calculateAttackDamage with the item WORN, then takes
 * `takeOwed` from the foe and composes the claim exactly as landOnBoss does (both terms through the boss's own
 * `bossStrike`, summed, then the cap). Nothing local is handed to it.
 *
 * Scenario condition: the echo's roll is dice. For a deterministic comparison the oracle's loot dice are fixed to
 * always trigger and the local power is given chance 100; the natural 10% is compared as a sampled mean with the
 * oracle's dice seeded from the harness PRNG. That is the only assumption this file supplies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, blowDistribution, weaponOf, gateTarget, referenceFoe } from '../src/model.js';
import { standInTarget } from '../src/target.js';
import { maxCharacter, maxRun } from '../src/maxprofile.js';
import { powerDps } from '../src/imprints.js';
import { upstream, pcaaoModules } from './harness/upstream.mjs';
import { upstreamBody } from './harness/upstreamBodies.mjs';
import { character, simCharacter, upstreamEntity, weapon, upstreamWeapon } from './harness/fixtures.mjs';
import { compareDistributions, worst } from './harness/outcomes.mjs';
import { generator } from './harness/prng.mjs';
import { takeOwed } from '../vendor/upstream/a3eb1605/src/systems/playerDoor.js';
import { _resetLootPowersForTests, _setLootPowersRandForTests } from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';

const DRAWS = 250000;
const Z_MAX = 4.5;
const WARP = { kind: 'echo', chance: 10 };

/**
 * The host's claim, sampled through upstream's own code:
 *   pcaaoAttackDamage   the blow (the overhaul core the formula installs), which hands back the struck part
 *   lootStrike          the strike listener the formula runs at the blow's end: the power's roll, `again()`, oweFoe
 *   takeOwed            what the host takes: resisted as its own melee swing, added to the resisted blow, one claim
 * `dice` fixes the loot roll; null restores the module's default.
 */
function sampleClaim(u, modules, { desc, item, fields, body, seed, draws, dice = () => 0, traits = [], cap = 0, offHand = false, kind = 'melee', pull = 0 }) {
  _resetLootPowersForTests();
  if (dice) _setLootPowersRandForTests(dice);
  const rng = generator(seed);
  const attacker = upstreamEntity(desc);
  const slot = u.equip.equipTableOf(attacker); // the WORN piece: lootStrike reads the powers of what the entity wears
  const struck = (d, k) => (traits.length && d > 0 ? u.bossTraits.bossStrike({ bossTraits: traits }, d, { kind: k, weapon: upstreamWeapon(item) }).damage : d);
  const byPart = Array.from({ length: 7 }, () => new Map());
  const counts = new Array(7).fill(0);
  let sum = 0; let sq = 0;
  for (let i = 0; i < draws; i++) {
    const w = { ...upstreamWeapon(item), ...fields };
    slot[u.equip.EQUIP_SLOTS.RightHand] = w;
    const notes = {};
    let part = -1;
    const d = u.pcaao.pcaaoAttackDamage(attacker, body, {
      weapon: w, rolls: rng, modules, backstabChance: 0, notes, onStruck: (p) => { part = p; },
      ...(offHand ? { toHitMod: u.handsLaw.offHandToHit(attacker.stats.agility), blowShare: u.handsLaw.offHandDamage } : {}),
    });
    if (d > 0) u.lootPowers.lootStrike(attacker, body, d, w, { blow: true }); // the formula's listener, at the blow's end
    const owed = takeOwed(body);
    // the host: a shaft's pull first (arrowFlight.js:501-510), then landOnBoss - the pulled blow resisted as its kind,
    // the owed number resisted as a MELEE swing, summed into one claim
    const shotD = pull ? u.bowBloom.bowFastDamage({ pull, fast: 0 }, d) : d;
    const claim = struck(shotD, kind) + (owed > 0 ? struck(owed, 'melee') : 0);
    const value = cap > 0 ? Math.min(claim, cap) : claim;
    sum += value; sq += value * value;
    if (d > 0 && !notes.critical && !notes.backstab && part >= 0) {
      counts[part] += 1;
      byPart[part].set(value, (byPart[part].get(value) ?? 0) + 1);
    }
  }
  slot[u.equip.EQUIP_SLOTS.RightHand] = null;
  _setLootPowersRandForTests(null);
  _resetLootPowersForTests();
  const mean = sum / draws;
  return { byPart, counts, mean, se: Math.sqrt(Math.max(0, sq / draws - mean * mean) / draws) };
}
const worn = (id) => ({ rarity: 'rare', imprint: id });

const CASES = [
  { id: 'echo, gate, no cap, no trait', tpl: 121, skill: 29, traits: [], cap: 0 },
  { id: 'echo, binding cap 30', tpl: 121, skill: 29, traits: [], cap: 30 },
  { id: 'echo, partially capping cap 620', tpl: 121, skill: 29, traits: [], cap: 620 },
  { id: 'echo + stoneskin (blunt, both terms halved)', tpl: 126, skill: 32, traits: ['stoneskin'], cap: 0 },
  { id: 'echo + stoneskin, cap 40', tpl: 126, skill: 32, traits: ['stoneskin'], cap: 40 },
  { id: 'echo, off-hand blow (whole 80%), bladeturning', tpl: 121, skill: 29, traits: ['bladeturning'], cap: 18, offHand: true },
  { id: 'echo on a shaft: arrow halved, echo a melee swing', tpl: 130, skill: 33, traits: ['bladeturning'], cap: 0, kind: 'arrow', bow: true },
];

test('1. the echo rides the blow\'s claim on a relay body, value by value (chance 100)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  for (const [i, c] of CASES.entries()) {
    const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { [c.skill]: 150, 34: 30 } });
    const item = weapon(c.tpl, { material: 9 });
    const sample = sampleClaim(u, modules, { desc, item, fields: worn('warp-edge'), body, seed: 0x6100 + i * 71, draws: DRAWS, traits: c.traits, cap: c.cap, offHand: !!c.offHand, kind: c.bow ? 'arrow' : 'melee', pull: c.bow ? 1.5 : 0 });
    const target = { ...standInTarget(31), bossTraits: c.traits, hitCap: c.cap };
    // the raw card's rolls: an off-hand analysis' `damage` is the DISPLAY card (already share-scaled), so the rolls come
    // from the same blow read as a main hand's, and the off hand's share is applied once, inside blowDistribution
    const r = analyze(simCharacter(desc, item), { target, core: 'overhaul', weapon: weaponOf(item), offHand: false, swing: 'StrikeLeft' });
    const local = r.with({ offHand: !!c.offHand, imprint: { kind: 'echo', chance: 100 } });
    const dist = Array.from({ length: 7 }, (_, part) => blowDistribution(r.damage.plainRolls, part, { target, weapon: r.weapon, offHand: !!c.offHand, traits: c.traits, cap: c.cap, echoes: [100] }));
    const bad = worst(compareDistributions(sample, dist));
    assert.ok(Math.abs(bad.z) < Z_MAX, `${c.id}: part ${bad.part} value ${bad.value}: upstream ${bad.c} of ${sample.counts[bad.part]}, local p ${bad.p.toFixed(5)}, z ${bad.z.toFixed(1)}`);
    assert.ok(Math.abs(local.cappedPerSwing - sample.mean) / sample.se < 3.5, `${c.id}: capped ${local.cappedPerSwing.toFixed(3)} vs ${sample.mean.toFixed(3)}`);
  }
});

test('2. the same with the natural 10% (the oracle\'s dice seeded), and the old independent hit rejected where the cap binds', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  for (const [i, tpl] of [121, 123, 126, 117].entries()) {
    const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 28: 150, 29: 150, 30: 150, 32: 150, 34: 30 } });
    const item = weapon(tpl, { material: 9 });
    for (const cap of [600, 30]) {
      // a cap far above the blow (the echo is effectively its own hit) and one that binds (the claim clips)
      const sample = sampleClaim(u, modules, { desc, item, fields: worn('warp-edge'), body, seed: 0x6300 + i * 53 + cap, draws: DRAWS, dice: generator(0x6200 + i * 97 + cap), traits: [], cap });
      const target = { ...standInTarget(31), hitCap: cap };
      const base = analyze(simCharacter(desc, item), { target, core: 'overhaul', weapon: weaponOf(item), swing: 'StrikeLeft' });
      const priced = base.with({ imprint: WARP });
      assert.ok(Math.abs(priced.cappedPerSwing - sample.mean) / sample.se < 4, `${tpl} cap ${cap}: priced ${priced.cappedPerSwing.toFixed(2)} vs upstream ${sample.mean.toFixed(2)} +/- ${(1.96 * sample.se).toFixed(2)}`);
      if (cap === 30) {
        // the pre-2.11b approximation - a second, independently capped 10% hit - is far outside once the claim clips
        const old = base.cappedPerSwing * 1.1;
        assert.ok(Math.abs(old - sample.mean) / sample.se > 5, `${tpl} cap ${cap}: the independent-capped-hit pricing is rejected (${old.toFixed(2)} vs ${sample.mean.toFixed(2)})`);
      }
    }
  }
});

test('3. the cap clips the blow and its echo together; a build without the power is untouched', async () => {
  const gate = gateTarget(45);
  const base = maxRun(maxCharacter(121), { target: gate });
  const echo = base.with({ imprint: { kind: 'echo', chance: 100 } });
  // with chance 100 every blow repeats: the claim can never exceed the cap
  assert.ok(echo.cappedPerSwing <= base.cap + 1e-9);
  assert.ok(echo.cappedPerSwing > base.cappedPerSwing);
  // and the mean is NOT the blow plus a whole second capped hit
  const old = base.cappedPerSwing + base.cap;
  assert.ok(echo.cappedPerSwing < old - 1);
  // no power: unchanged, byte for byte
  assert.equal(base.with({}).cappedPerSwing, base.cappedPerSwing);
  // the echo is not laid on an ordinary foe's card through the claim either: it is a second hit there
  const plain = referenceFoe(45, 'tough');
  const raw = maxRun(maxCharacter(121), { target: plain });
  const on = raw.with({ imprint: WARP });
  assert.ok(Math.abs(on.dps / raw.dps - 1.1) < 0.002, `ordinary foe: the echo is its own hit (${(on.dps / raw.dps).toFixed(4)})`);
});
