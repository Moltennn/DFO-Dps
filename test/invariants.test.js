/*
 * test/invariants.test.js - properties that must hold whatever the numbers are,
 * plus an executable record of the audit's critical discrepancies.
 *
 * Two kinds of assertion live here:
 *
 *   invariants  - bounds and monotonicity the engine must satisfy (a hit is
 *                never certain, a capped blow never beats an uncapped one, a
 *                skill boundary reads what the game reads).
 *   known gaps  - a discrepancy the audit established, asserted to STILL be
 *                present. Fixing one fails the test on purpose, so the waiver
 *                table and this file cannot outlive the bug.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, damageModifier, expectedCapped, gateTarget, pcaaoDamageModifier, referenceFoe } from '../src/model.js';
import { effectiveSkill, liveStat } from '../src/save.js';
import { gateHealth, gateHitCap } from '../src/data.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { maxCharacter } from '../src/maxprofile.js';
import { upstream, pcaaoModules } from './harness/upstream.mjs';
import { generator } from './harness/prng.mjs';

/** The fully geared level-45 long blade: the legal max profile, not the old 240/540/40 assumption. */
const GEARED = () => maxCharacter(123);

test('invariant: a hit is never certain and never hopeless (3..97)', async () => {
  const r = generator(4242);
  for (let i = 0; i < 500; i++) {
    const ch = simCharacter(character({ level: 1 + Math.floor(r() * 60), stats: { strength: Math.floor(r() * 120), agility: Math.floor(r() * 120), speed: Math.floor(r() * 120), luck: Math.floor(r() * 120) } }));
    for (const preset of ['soft', 'tough', 'armoured', 'human']) {
      const hit = analyze(ch, { target: referenceFoe(ch.level, preset) }).hit;
      assert.ok(hit.hitPlain >= 0.03 - 1e-12 && hit.hitPlain <= 0.97 + 1e-12, `plain hit ${hit.hitPlain} (${preset})`);
      assert.ok(hit.hit >= 0.03 - 1e-12 && hit.hit <= 0.97 + 1e-12, `crit-weighted hit ${hit.hit} (${preset})`);
    }
  }
});

test('invariant: damage ranges are ordered and non-negative', async () => {
  const r = generator(90210);
  for (let i = 0; i < 200; i++) {
    const ch = simCharacter(character({ level: 1 + Math.floor(r() * 60), stats: { strength: Math.floor(r() * 120) } }), weapon([113, 120, 123, 126, 129][Math.floor(r() * 5)], { material: Math.floor(r() * 10) }));
    const d = analyze(ch, { target: referenceFoe(ch.level, 'tough') }).damage;
    assert.ok(d.min >= 0 && d.min <= d.avg && d.avg <= d.max, `plain ${d.min}/${d.avg}/${d.max}`);
    assert.ok(d.critMin >= 0 && d.critMin <= d.critAvg && d.critAvg <= d.critMax, `crit ${d.critMin}/${d.critAvg}/${d.critMax}`);
    assert.ok(d.critMax >= d.max, 'a critical hit is never smaller than a plain one');
  }
});

test('invariant: the per-hit cap never increases DPS and binds only above it', () => {
  assert.equal(expectedCapped(10, 20, 100), 15);
  assert.equal(expectedCapped(10, 20, 5), 5);
  for (const cap of [1, 5, 10, 15, 20, 50]) {
    let prev = -Infinity;
    for (const d of [1, 3, 7, 12, 18, 25]) {
      const v = expectedCapped(d, d + 4, cap);
      assert.ok(v <= cap + 1e-12, `cap ${cap} bounds ${v}`);
      assert.ok(v >= prev - 1e-12, 'monotone in the roll span');
      prev = v;
    }
  }
});

test('invariant: skill boundaries 100 / 125 / 200 read as the game reads them', async () => {
  const u = await upstream();
  for (const v of [100, 101, 125, 150, 175, 200]) {
    assert.equal(effectiveSkill(v), u.skillSoftcap.effectiveSkill(v), `effectiveSkill(${v})`);
  }
  assert.equal(effectiveSkill(100), 100);
  assert.equal(effectiveSkill(125), 108);
  assert.equal(effectiveSkill(200), 140);
});

test('invariant: an attribute stops at 100 unless a stat-max channel lifts it (115)', () => {
  const ch = simCharacter(character({ stats: { strength: 100 } }));
  assert.equal(liveStat(ch, 'strength'), 100);
  ch._mods.stats.strength = 15; // a gear affix fills headroom
  assert.equal(liveStat(ch, 'strength'), 100, 'a mod cannot pass the ceiling');
  ch._mods.statMax.strength = 15; // the Firmament lifts the ceiling
  assert.equal(liveStat(ch, 'strength'), 115);
  const r = analyze(ch, { target: referenceFoe(45, 'tough') });
  assert.equal(r.damage.parts.strMod, Math.floor((115 - 50) / 10), 'the formula reads the lifted value');
});

test('invariant: the Breach pool, cap and phase shields are the relay\'s numbers', () => {
  for (const level of [1, 30, 45, 60]) {
    const ref = 5 + level;
    assert.equal(gateHitCap(level), 12 * ref, `cap ${level}`);
    assert.equal(gateHealth(level), 240 * ref, `pool ${level}`);
    const t = gateTarget(level);
    assert.equal(t.hitCap, 12 * ref);
    assert.equal(t.maxHealth, 240 * ref);
    assert.equal(t.phaseShields, 2);
  }
});

test('invariant: no build beats the Breach refill rate for long (C1)', () => {
  // The relay refills 3 x dpsRef a second per player (gateBrain.js BUCKET_RATE_X), so the
  // headline metrics must sit inside it. cappedDps stays what it is - a per-hit ceiling.
  const level = 45;
  const ref = 5 + level;
  const ch = GEARED();
  const gate = gateTarget(level);
  const r = analyze(ch, { target: gate, health: gate.maxHealth, rri: true, stacks: 5 });
  const a = r.allowance;
  assert.ok(a, 'the Breach target runs the relay allowance');
  assert.ok(r.cappedDps > 3 * ref * 2, 'the per-hit-capped figure is a ceiling, far above the allowance');
  assert.equal(a.sustainedDps, 3 * ref, 'sustained DPS is the refill rate');
  assert.ok(a.averageDps <= 3 * ref * 1.15, `kill-average ${a.averageDps.toFixed(1)} within the allowance (+15% for the opening bucket)`);
  // The fastest possible kill spends the opening bucket once, then lives on refill:
  // (share - depth) / rate = (12,000 - 750) / 150 = 75 s. (BOSS_TTK_S / BUCKET_RATE_X = 80 s
  // is the same bound without the opening bucket.)
  const floor = (gate.maxHealth - 15 * ref) / (3 * ref);
  assert.ok(r.ttk >= floor - 1e-6, `no solo kill under ${floor} s (${r.ttk.toFixed(1)} s)`);
});

test('invariant: a blow over the cap is clipped, and the clip is reported', () => {
  const ch = GEARED();
  const gate = gateTarget(45);
  const r = analyze(ch, { target: gate, health: gate.maxHealth, rri: true, stacks: 5 });
  assert.ok(r.cap > 0);
  assert.ok(r.cappedDps < r.dps, 'the cap binds this build');
  assert.ok(r.capLoss > 0 && r.capLoss < 1);
  const uncapped = analyze(ch, { target: { ...gate, hitCap: 0 }, health: 0, rri: true, stacks: 5 });
  assert.ok(uncapped.cappedDps === uncapped.dps, 'no cap, no loss');
});

test('invariant: condition thresholds (the bands that change the blow)', () => {
  const at = (pct) => {
    const item = { ...weapon(121, { material: 9 }), maxCondition: 1000, currentCondition: Math.round(pct * 10) };
    return analyze(simCharacter(character({ level: 30, stats: { strength: 60 } }), item), { target: referenceFoe(30, 'tough') }).damage.avg;
  };
  const whole = at(100);
  assert.ok(at(95) <= whole + 1e-9, 'no edge bonus without the wear module');
  assert.ok(at(50) < whole, 'a worn blade cuts less at 50% (x0.85)');
  assert.ok(at(30) < at(50), 'and less again at 30% (x0.7)');
  assert.ok(at(3) < at(30), 'and least when nearly broken (x0.25)');
});

test('invariant: PvE spells never crit and the cast recovery is the throughput floor', async () => {
  const { analyzeSpell } = await import('../src/spells.js');
  const spell = {
    name: 'fixture',
    element: 4,
    rangeType: 0,
    cost: 10,
    effects: [{ type: 4, subType: 0, magnitudeBaseLow: 10, magnitudeBaseHigh: 20, magnitudeLevelBase: 1, magnitudeLevelHigh: 1, magnitudePerLevel: 1, durationBase: 0, durationMod: 0, durationPerLevel: 1, chanceBase: 0, chanceMod: 0, chancePerLevel: 1 }],
  };
  const card = analyzeSpell(spell, simCharacter(character({ level: 30, stats: { speed: 50 } })), referenceFoe(30, 'tough'));
  assert.equal(card.castSeconds, 0.7, 'Speed 50: the 0.7 s recovery');
  assert.ok(!('crit' in card) || card.crit === undefined, 'no spell critical');
});

test('invariant: every damage path reports finite numbers (no stub or NaN leak)', async () => {
  // The vendored oracle poisons any value that comes from a cut edge; this
  // sweeps the simulator for NaN in the same way.
  const r = generator(31337);
  for (let i = 0; i < 120; i++) {
    const ch = simCharacter(
      character({ level: 1 + Math.floor(r() * 60), stats: { strength: Math.floor(r() * 120), agility: Math.floor(r() * 120), speed: Math.floor(r() * 120), luck: Math.floor(r() * 120) } }),
      weapon([113, 121, 126, 129][Math.floor(r() * 4)], { material: Math.floor(r() * 10), condition: r() }),
    );
    const result = analyze(ch, { target: referenceFoe(ch.level, 'tough'), rri: r() < 0.5 });
    for (const k of ['perSwing', 'dps', 'cappedDps', 'perSwingMin', 'perSwingMax', 'dpsMin', 'dpsMax', 'cappedDpsMin', 'cappedDpsMax']) {
      assert.ok(Number.isFinite(result[k]), `${k} is finite (${result[k]})`);
    }
    assert.ok(Number.isFinite(result.cadence.aps) && result.cadence.aps > 0);
  }
});

test('invariant: the Strength term is /10 (overhaul) everywhere it is used', () => {
  for (const s of [0, 25, 50, 66, 80, 100, 115]) assert.equal(pcaaoDamageModifier(s), Math.floor((s - 50) / 10));
  assert.equal(damageModifier(50), 0);
});

test('invariant: the simulator never claims a value the vendored oracle contradicts on the per-hit core', async () => {
  // A light smoke test of the differential suite inside the invariant file: an
  // ordinary character must match the card on hit chance and damage.
  const u = await upstream();
  const desc = character({ level: 30, raceId: 1, stats: { strength: 70, agility: 70, speed: 70, luck: 50 }, skillOverride: { 29: 70, 34: 40 } });
  const item = weapon(121, { material: 9 });
  const card = u.combatStats.computeCombatStats(
    {
      isPlayer: true, level: desc.level, raceId: desc.raceId, stats: desc.stats,
      skills: desc.skills, career: desc.career, health: 100, maxHealth: 100, activeEffects: [],
      _mods: { stats: {}, skills: {} }, _enchantMods: { skillMods: {} },
    },
    { core: 'overhaul', weapon: item, modules: pcaaoModules(u) },
  );
  const r = analyze(simCharacter(desc, item), { target: referenceFoe(desc.level, 'tough'), core: 'overhaul' });
  assert.ok(Math.abs(r.hit.hit - card.head.byFoe[1].hit) < 1e-12, `hit ${r.hit.hit} vs ${card.head.byFoe[1].hit}`);
  assert.ok(Math.abs(r.damage.avg - card.head.byFoe[1].dmg.avg) < 1e-12, `damage ${r.damage.avg} vs ${card.head.byFoe[1].dmg.avg}`);
});
