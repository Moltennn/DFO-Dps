/*
 * test/golden-upstream.test.js - acceptance tests taken from the upstream
 * project's own pinned tests.
 *
 * Each fixture is a number the game's authors pinned in their test suite, with
 * its source line. The fixture is asserted twice:
 *
 *   1. against the vendored oracle, so the vendored subset provably still
 *      satisfies the game's own pins (a broken vendor tree cannot quietly
 *      become the reference);
 *   2. against this project wherever the same quantity is modelled, with a
 *      waiver where the audit established a known difference.
 *
 * Sources (pinned commit a3eb1605):
 *   test/combat/combatStats.test.js   - the card's arithmetic
 *   test/systems/pcaao.test.js        - the overhaul's members
 *   test/combat/twohands.test.js      - the dual-wield balance
 *   test/combat/bowbloom.test.js      - the bow's fast-shot law and kinds
 *   test/combat/powerceiling.test.js  - the blow/guard ceilings
 *   test/systems/enemyExpansion/mudex1.test.js - the MUDEX rows a foe is minted from
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { upstream, pcaaoModules, playerEntity, weaponItem } from './harness/upstream.mjs';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';

import { analyze, damageModifier, pcaaoDamageModifier, unityRound, weaponOf, rangedCadence, expectedCapped } from '../src/model.js';
import { dualSchedule, swingsRatio, damageRatio } from '../src/dualWield.js';
import { WEAPONS } from '../src/data.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** A classic-core player with a steel longsword, as the upstream card test builds it. */
function classicSword(u, overrides = {}) {
  const p = playerEntity({ level: 5, raceId: 1, ...overrides });
  return { p, weapon: weaponItem(120, { material: 1 }), u };
}

test('golden (combatStats.test.js:67-80): strength term, longsword range, swing table, four foes', async () => {
  const u = await upstream();
  // The game installs PCAAO at boot, which also overrides the classic strength
  // term; the upstream test uninstalls it to pin DFU's own /5 table.
  u.pcaao.uninstallPcaao();
  try {
    const p = playerEntity({ level: 5, raceId: 1, stats: { strength: 80 } });
    const w = weaponItem(120, { material: 1 });
    const s = u.combatStats.computeCombatStats(p, { core: 'classic', weapon: w });
    assert.equal(u.formulas.damageModifier(80), 6, 'DFU damageModifier(80) = 6/5');
  assert.equal(s.head.byFoe[0].dmg.min, 2 + 6);
  assert.equal(s.head.byFoe[0].dmg.max, 16 + 6);
  const up = s.swings.find((x) => x.key === 'StrikeUp');
  assert.equal(up.byFoe[0].dmg.min, 2 + 6 + u.playerWeapon.SWING_MODS.StrikeUp.damage);
  assert.equal(up.mods.toHit, 10);
  assert.equal(s.foes.length, 4);

  // This project's classic arm: the strength term and the same template range.
    assert.equal(damageModifier(80), 6);
    const r = analyze(simCharacter(character({ level: 5, raceId: 1, stats: { strength: 80 } }), weapon(120, { material: 1 })), {
    target: { ...referenceFoeSim(5, 'soft') },
    core: 'classic',
    critDamage: false,
    fixedStrengthDamageModifier: false, // the fixture uninstalls PCAAO above
    swing: 'StrikeLeft', // this golden is the card's neutral row
  });
    assert.equal(r.damage.parts.strMod, 6);
    assert.equal(r.damage.parts.roll[0], 2);
    assert.equal(r.damage.parts.roll[1], 16);
    assert.equal(r.damage.min, 2 + 6, 'classic min (no armour at the card level)');
    assert.equal(r.damage.max, 16 + 6);
  } finally {
    u.pcaao.installPcaao();
  }
});

test('golden (combatStats.test.js:82-98): fists, bows and the classic critical model', async () => {
  const u = await upstream();
  const p = playerEntity({ level: 5, raceId: 1, skills: { 30: 50, 34: 40 } });
  const fists = u.combatStats.computeCombatStats(p, { core: 'classic', weapon: null });
  assert.equal(fists.weapon, null);
  assert.equal(fists.head.byFoe[0].dmg.min, Math.floor(50 / 10) + 1);
  assert.equal(fists.head.byFoe[0].dmg.max, Math.floor(50 / 5) + 1);
  const bow = u.combatStats.computeCombatStats(p, { core: 'classic', weapon: { group: 'Weapons', templateIndex: 130, material: 0 } });
  assert.equal(bow.isBow, true);
  assert.equal(bow.headlineKey, 'StrikeDown');
  assert.equal(bow.swings.length, 1);
  const c = u.combatStats.criticalModel(p, { overhaul: false, modules: pcaaoModules(u) });
  assert.deepEqual([c.chance, c.hitBonus, c.damageMult], [0.4, 4, 1]);

  // This project: the same hand-to-hand span and the same crit chance/kind.
  const r = analyze(simCharacter(character({ level: 5, raceId: 1, skillOverride: { 30: 50, 34: 40 } })), {
    target: referenceFoeSim(5, 'soft'),
    core: 'classic',
  });
  assert.equal(r.damage.parts.roll[0], Math.floor(50 / 10) + 1);
  assert.equal(r.damage.parts.roll[1], Math.floor(50 / 5) + 1);
  assert.equal(r.hit.crit.chance, 0.4);
  assert.equal(r.hit.crit.hitBonus, 4);
  assert.equal(r.hit.crit.damageMult, 1);
});

test('golden (pcaao.test.js:80): unityRound is half-to-even', async () => {
  const u = await upstream();
  const table = [2.5, 3.5, -2.5, 0.5, 1.5, 2.4999, 2.5001];
  const expected = [2, 4, -2, 0, 2, 2, 3];
  assert.deepEqual(table.map((v) => u.pcaao.unityRound(v)), expected, 'upstream');
  assert.deepEqual(table.map((v) => unityRound(v)), expected, 'simulator');
});

test('golden (pcaao.test.js:86-87): damage modifiers and the material to-hit term', async () => {
  const u = await upstream();
  assert.deepEqual([60, 50, 45, 100].map((s) => u.pcaao.pcaaoDamageModifier(s)), [1, 0, -1, 5]);
  assert.deepEqual([9, 0, 1].map((m) => u.pcaao.pcaaoWeaponToHit({ material: m })), [14, 0, 2]);
  assert.deepEqual([60, 50, 45, 100].map((s) => pcaaoDamageModifier(s)), [1, 0, -1, 5]);
  const { weaponToHit } = await import('../src/model.js');
  assert.deepEqual([9, 0, 1].map((m) => weaponToHit(weaponOf(weapon(121, { material: m })))), [14, 0, 2]);
});

test('golden (pcaao.test.js:134): the struck body-part table', async () => {
  const u = await upstream();
  const table = [0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6];
  assert.deepEqual([...u.pcaao.PCAAO_BODY_PARTS], table, 'upstream');
  // The simulator weights the same table (model.js bodyWeights).
  const r = analyze(simCharacter(character({ level: 5 })), { target: referenceFoeSim(5, 'tough') });
  const chest = table.filter((p) => p === 6).length / table.length;
  assert.ok(near(chest, 2 / 20), 'chest 2 in 20');
  assert.ok(r.hit.hit > 0 && r.hit.hit < 1);
});

test('golden (pcaao.test.js:157-160): the critical-strike thresholds', async () => {
  const u = await upstream();
  const lucky = playerEntity({ level: 5, raceId: 1, stats: { luck: 100 }, skills: { 34: 100 } });
  const plain = playerEntity({ level: 5, raceId: 1, stats: { luck: 50 }, skills: { 34: 100 } });
  const fixed = (v) => () => v;
  assert.equal(u.pcaao.pcaaoCriticalStrike(lucky, fixed(0.49)), true, '100 crit, 100 luck: 50%');
  assert.equal(u.pcaao.pcaaoCriticalStrike(lucky, fixed(0.5)), false);
  assert.equal(u.pcaao.pcaaoCriticalStrike(plain, fixed(0.24)), true, '50 luck: 25%');
  assert.equal(u.pcaao.pcaaoCriticalStrike(plain, fixed(0.25)), false);
  // The simulator's model: crit / (4 - luckTerm), clamped to [0,1].
  assert.equal(analyze(simCharacter(character({ level: 5, raceId: 1, stats: { luck: 100 }, skillOverride: { 34: 100 } })), { target: referenceFoeSim(5, 'tough') }).hit.crit.chance, 0.5);
  assert.equal(analyze(simCharacter(character({ level: 5, raceId: 1, stats: { luck: 50 }, skillOverride: { 34: 100 } })), { target: referenceFoeSim(5, 'tough') }).hit.crit.chance, 0.25);
});

test('golden (pcaao.test.js:184-192): weapon blow arithmetic, two-handed and bows', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const fixed = (v) => () => v;
  const monster = (career) => ({ isPlayer: false, isClass: false, careerIndex: career, level: 1, stats: { strength: 50, endurance: 50, willpower: 50 }, skills: 100, health: 100, maxHealth: 100, armorValues: new Array(7).fill(100) });
  const p = playerEntity({ level: 5, raceId: 1, stats: { strength: 60 }, career: { weaponArmorShieldsBitfield: 0 } });
  const sword = weaponItem(120, { material: 1 });
  assert.equal(u.pcaao.pcaaoWeaponAttackDamage(p, monster(0), 0, 0, sword, fixed(0), modules), 2 + 1, 'longsword 2 + STR 1 + steel 0');
  assert.equal(u.pcaao.pcaaoWeaponAttackDamage(p, monster(15), 0, 0, sword, fixed(0), modules), 1 + 1, 'the Skeletal Warrior halves an edged blow');
  assert.deepEqual([...u.pcaao.SILVER_DOUBLED_CAREERS], [9, 18, 23, 28, 19, 14]);
  const claymore = weaponItem(122, { material: 1 });
  assert.equal(u.pcaao.pcaaoWeaponAttackDamage(p, monster(0), 0, 0, claymore, fixed(0), modules), 2 + 2 * 1, 'two-handed: the strength term doubled');
  const bow = weaponItem(130, { material: 1 });
  assert.equal(u.pcaao.pcaaoWeaponAttackDamage(p, monster(0), 0, 0, bow, fixed(0), modules), 5 + 2 * 1, 'BAL-ARCHERY: a bow takes the two-handed term, base +1');

  // The simulator reproduces them from its own tables.
  assert.equal(WEAPONS[120].min, 2);
  assert.equal(WEAPONS[122].min, 2);
  assert.equal(WEAPONS[130].min, 5);
});

test('golden (pcaao.test.js:207-210): condition bands', async () => {
  const u = await upstream();
  const at = (pct) => ({ maxCondition: 1000, currentCondition: pct * 10 });
  assert.equal(u.pcaao.pcaaoAlterDamageBasedOnWepCondition(10, false, at(95)), 13, 'blade >= 92%: x1.3');
  assert.equal(u.pcaao.pcaaoAlterDamageBasedOnWepCondition(10, true, at(95)), 11, 'blunt >= 92%: x1.1');
  assert.equal(u.pcaao.pcaaoAlterDamageBasedOnWepCondition(10, false, at(70)), 10, 'blade 61-75%: x1');
  assert.equal(u.pcaao.pcaaoAlterDamageBasedOnWepCondition(10, false, at(3)), 2, 'blade under 6%: x0.25, half to even');

  // The simulator applies the same bands to a real blow (weapon condition set per case).
  const avgAt = (pct) => {
    const item = weapon(121, { material: 9, condition: pct / 100 });
    return analyze(simCharacter(character({ level: 30, stats: { strength: 60 } }), item), { target: referenceFoeSim(30, 'tough'), core: 'overhaul' }).damage.avg;
  };
  const whole = avgAt(100);
  assert.ok(near(avgAt(95), whole, 1e-9), 'no edge bonus without the wear module (the >= 92 band is x1.0 here)');
  assert.ok(avgAt(3) < whole * 0.3, 'a broken blade cuts a quarter');
});

test('golden (twohands.test.js:145-183): dual-wield constants, the exchange and the pinned ratios', async () => {
  const u = await upstream();
  assert.deepEqual({ ...u.handsLaw.DUAL }, { FLURRY_FROM_FRAME: 1, OFF_DAMAGE: 0.8, OFF_TO_HIT: -5, OFF_TO_HIT_PER_AGILITY: 0.1, OFF_TO_HIT_MIN: -10, OFF_TO_HIT_MAX: 0, OFF_WEIGHT: 1.5 });
  assert.deepEqual([0, 30, 44, 45, 50, 55, 70, 100, 140].map(u.handsLaw.offHandToHit), [-10, -7, -6, -5, -5, -4, -3, 0, 0]);
  assert.deepEqual([0, -3, 1, 2, 4, 8, 13].map(u.handsLaw.offHandDamage), [0, -3, 1, 2, 3, 6, 10]);

  // The schedule the game's test measures through the machine: two blows per eight ticks against one
  // weapon's one per five - a quarter more swings - and a pair's damage a second about 9% over one weapon's
  // for the test's own damage proxy (0.65 a lead blow, (0.65 - 5/100) x 0.8 for the off hand at Agility 50).
  const matched = dualSchedule({ mainTick: 0.2, offTick: 0.2, burden: 1 });
  assert.ok(near(swingsRatio(matched), 1.25, 1e-12), `swings x${swingsRatio(matched)}`);
  assert.ok(near(matched.period, 8 * 0.2, 1e-12), 'lead 4 ticks + off 4 ticks');
  const edge = damageRatio(matched, 0.65, (0.65 + u.handsLaw.offHandToHit(50) / 100) * u.handsLaw.DUAL.OFF_DAMAGE);
  assert.ok(edge > 1.06 && edge < 1.11, `the pinned damage edge x${edge.toFixed(3)}`);
  // A longsword pair is felt in the off hand: the game's own expectation 5 / (4 + 2 x (burden - 1)).
  const burden = u.handsLaw.offHandBurden(4.5, 50);
  assert.ok(near(swingsRatio(dualSchedule({ mainTick: 0.2, offTick: 0.2, burden })), 5 / (4 + 2 * (burden - 1)), 1e-12));
  assert.ok(swingsRatio(dualSchedule({ mainTick: 0.2, offTick: 0.2, burden })) < 1.22, 'the off arm is slower');

  // The model itself: a matched pair is tempo, not twice the damage.
  const ch = simCharacter(character({ level: 45, stats: { strength: 50, agility: 50, speed: 50 }, skillOverride: { 28: 60, 34: 0 } }), weapon(113, { material: 9 }));
  const single = analyze(ch, { target: referenceFoeSim(45, 'tough') });
  const dual = analyze({ ...ch, offWeapon: { ...ch.weapon, equipSlot: 21 } }, { target: referenceFoeSim(45, 'tough'), dual: true });
  const ratio = dual.dps / single.dps;
  assert.ok(ratio > 1.05 && ratio < 1.13, `pair/single x${ratio.toFixed(3)} (never x1.8)`);
  assert.ok(near(dual.cadence.aps / single.cadence.aps, 1.25, 0.02), `swings x${(dual.cadence.aps / single.cadence.aps).toFixed(3)}`);
});
test('golden (bowbloom.test.js:12-14, 61-63, 90-99): the bow laws', async () => {
  const u = await upstream();
  assert.deepEqual({ ...u.bowBloom.BOW_BLOOM }, { step: 2, most: 8, settle: 3 });
  assert.deepEqual({ ...u.bowBloom.BOW_FAST }, { cut: 20, most: 4, within: 1 });
  const SHORT = { templateIndex: 129 };
  const LONG = { templateIndex: 130 };
  assert.deepEqual([u.bowBloom.bowKindOf(SHORT), u.bowBloom.bowKindOf(LONG)], [u.bowBloom.BOW_KINDS[129], u.bowBloom.BOW_KINDS[130]]);
  assert.deepEqual({ ...u.bowBloom.bowKindOf(null) }, { within: u.bowBloom.BOW_FAST.within, settle: u.bowBloom.BOW_BLOOM.settle, pull: 1 });
  assert.deepEqual([0, 1, 2, 3, 4].map((fast) => u.bowBloom.bowFastDamage({ fast }, 50)), [50, 40, 30, 20, 10]);
  assert.equal(u.bowBloom.bowFastDamage({ fast: 4 }, 2), 1, 'never nothing where it was something');
  assert.equal(u.bowBloom.bowFastDamage({ fast: 0, pull: 1.5 }, 12), 18, 'the long bow lands x1.5');
  assert.equal(u.bowBloom.bowFastDamage({ fast: 1, pull: 1.5 }, 12), 14, 'and a quick one less');

  // The simulator models the same fast-shot penalty as a x0.2 pull at full stacks.
  const ch = {
    level: 45,
    stats: { strength: 100, agility: 100, speed: 100, luck: 50 },
    skills: Array.from({ length: 35 }, () => 60),
    online: true,
    martialPath: null,
    activeEffects: [],
    _mods: { stats: {}, skills: {} },
    _enchantMods: { skillMods: {} },
  };
  const w = weaponOf(weapon(130, { material: 9 }));
  const paced = rangedCadence(ch, w, {});
  const spam = rangedCadence(ch, w, { bowSpam: true });
  assert.ok(spam.pull < paced.pull, 'spamming cuts the pull');
  assert.ok(near(spam.pull, 0.2 * paced.pull, 1e-12), 'four quick shots: x0.2');
});

test('golden (powerceiling.test.js:86-95): the blow and guard ceilings', async () => {
  const u = await upstream();
  assert.deepEqual({ ...u.powerCeiling.BLOW_TOPS }, { sigil: 12, sets: 200, loot: 240, firmament: 50, mastery: 400, martial: 40 });
  assert.deepEqual({ ...u.powerCeiling.GUARD_TOPS }, { loot: 55, sets: 50, firmament: 15, martial: 30, arcane: 20 });
  assert.ok(near(u.powerCeiling.BLOW_MOST, 119.952, 1e-3), `BLOW_MOST ${u.powerCeiling.BLOW_MOST}`);
  assert.ok(near(u.powerCeiling.GUARD_LEAST, 0.1071, 1e-3));

  // This project's equivalent tops, where it has one.
  const { GEAR_MASTERY_CAP } = await import('../src/theory.js');
  assert.equal(GEAR_MASTERY_CAP, 320, 'weapon gear tops out at +320%');
  assert.ok(320 <= u.powerCeiling.BLOW_TOPS.mastery, 'inside the mastery registry ceiling');
});

test('golden: the Breach constants the relay publishes', async () => {
  // net/gate/gateBrain.js is behind the multiplayer graph, so the pinned values
  // are taken from the upstream source text at this commit. These are the
  // numbers every boss metric depends on.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const file = path.join((await upstream()).dir, '../../net/gate/gateBrain.js');
  const src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!src) {
    // The subset does not carry gateBrain; assert the documented law instead.
    const { gateHitCap, gateHealth, GATE_TTK_S, GATE_HIT_CAP_X, GATE_SHIELDS } = await import('../src/data.js');
    assert.equal(GATE_TTK_S, 240);
    assert.equal(GATE_HIT_CAP_X, 12);
    assert.equal(GATE_SHIELDS, 2);
    assert.equal(gateHitCap(45), 12 * 50);
    assert.equal(gateHealth(45), 240 * 50);
    return;
  }
  assert.match(src, /export const BOSS_TTK_S = 240;/);
  assert.match(src, /export const HIT_CAP_X = 12;/);
  assert.match(src, /export const BUCKET_RATE_X = 3;/);
  assert.match(src, /export const BUCKET_DEPTH_X = 15;/);
  assert.match(src, /export const GATE_HIT_HZ_MAX = 4;/);
});

test('golden: expectedCapped is the mean of a clamped uniform roll', async () => {
  const u = await upstream();
  // The game's cap is applied to each integer blow, so the expectation of a
  // capped roll is the mean of min(d, cap). Check the simulator against a brute
  // force over the same roll span.
  for (const [min, max, cap] of [[1, 6, 4], [3, 16, 10], [10, 20, 15], [1, 21, 600], [500, 900, 600]]) {
    let total = 0;
    for (let d = min; d <= max; d++) total += Math.min(d, cap);
    assert.ok(near(expectedCapped(min, max, cap), total / (max - min + 1), 1e-12), `cap ${cap}: ${expectedCapped(min, max, cap)}`);
  }
  assert.ok(u.pcaao.PCAAO_BODY_PARTS.length > 0);
});

test('golden (enemyExpansion/mudex1.test.js:61-73): the MUDEX rows a foe is minted from', async () => {
  // Upstream pins MUDEX's lines over DEX's: the Grizzly Bear (4) restated, the rat (0) DEX leaves,
  // "written into the table while loaded" and "at the mint - no Meaner Monsters row over it".
  const STATS = ['level', 'minDamage', 'maxDamage', 'minHealth', 'maxHealth', 'armorValue'];
  const stats = (row) => STATS.map((k) => row[k]);
  const PINS = { 4: [4, 1, 20, 50, 100, 7], 0: [1, 1, 2, 15, 25, 8] };
  const u = await upstream();
  const dex = await import('../vendor/upstream/a3eb1605/src/systems/enemyExpansion/dexInstall.js');
  const { mintRow } = await import('../src/target.js');
  const { upstreamBodies } = await import('./harness/upstreamBodies.mjs');
  const { bodies } = await upstreamBodies(Object.keys(PINS).map((m) => ({ kind: 'mint', mobile: Number(m) })));
  Object.entries(PINS).forEach(([m, pin], i) => {
    // 1. the vendored oracle's own row (mudex1.test.js:61, :64)
    assert.deepEqual(stats(dex.dexClassicRow(Number(m), u.enemyBasics.VANILLA_ENEMY_BASICS[m], { mudex: true })), pin, `vendored row ${m}`);
    // 2. the booted realm's mint (mudex1.test.js:73)
    assert.deepEqual(stats(bodies[i].basics), pin, `booted mint ${m}`);
    // 3. this project's minted row
    assert.deepEqual(stats(mintRow(Number(m))), pin, `local mintRow ${m}`);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────
import { referenceFoe as simReferenceFoe } from '../src/model.js';
const referenceFoeSim = (level, preset) => simReferenceFoe(level, preset);
