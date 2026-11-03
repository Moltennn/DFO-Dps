import test from 'node:test';
import assert from 'node:assert/strict';
import { characterFromSave, effectiveSkill } from '../src/save.js';
import {
  analyze, bossTarget, cadence, damageModifier, expectedCapped, gateTarget, pcaaoDamageModifier,
  referenceFoe, swingFrameSeconds, syntheticWeapon, weaponOf,
} from '../src/model.js';
import { gateHealth, gateHitCap } from '../src/data.js';

const STATS = {
  strength: 80, intelligence: 50, willpower: 50, agility: 50,
  endurance: 50, personality: 50, speed: 50, luck: 50,
};

function testSave(over = {}) {
  return {
    name: 'Tester', level: 5, raceId: 1,
    stats: { ...STATS, ...(over.stats ?? {}) },
    skills: Array.from({ length: 35 }, (_, i) => over.skills?.[i] ?? 40),
    health: 50, maxHealth: 60, reflexes: 2,
    career: {
      weaponArmorShieldsBitfield: 0,
      abilityFlagsAndSpellPointsBitfield: 0,
      attackModifierFlags: 0,
    },
    items: [{
      name: 'Steel Longsword', group: 'Weapons', templateIndex: 120, material: 1,
      maxCondition: 1000, currentCondition: 1000, equipSlot: 19,
    }],
    activeEffects: [],
    masterSkills: false,
    masteredSkills: [],
    martialPath: null,
    ...over,
  };
}

test('strength terms: classic /5, overhaul /10', () => {
  assert.equal(damageModifier(80), 6);
  assert.equal(damageModifier(50), 0);
  assert.equal(damageModifier(40), -2);
  assert.equal(pcaaoDamageModifier(80), 3);
  assert.equal(pcaaoDamageModifier(75), 2);
});

test('classic longsword, STR 80: 8-22 before the foe', () => {
  const ch = characterFromSave(testSave(), { online: false });
  const r = analyze(ch, { target: referenceFoe(5, 'soft'), core: 'classic', critDamage: false });
  assert.equal(r.damage.min, 8);   // 2 + floor((80-50)/5)
  assert.equal(r.damage.max, 22);  // 16 + 6
  assert.equal(r.damage.parts.matMod, 0); // steel
  assert.equal(r.damage.parts.strMod, 6);
});

test('overhaul longsword: strength is /10; two-handed doubles it', () => {
  const ch = characterFromSave(testSave(), { online: false });
  const one = analyze(ch, { target: referenceFoe(5, 'soft'), core: 'overhaul' });
  assert.equal(one.damage.parts.strMod, 3);
  const claymore = syntheticWeapon(122, 1);
  const two = analyze(ch, { weapon: claymore, target: referenceFoe(5, 'soft'), core: 'overhaul' });
  assert.equal(two.damage.parts.strMod, 6);
});

test('the source stats-card fixture: STR 66 steel longsword in the overhaul', () => {
  const skills = Array.from({ length: 35 }, () => 40);
  skills[29] = 55; skills[34] = 36; skills[20] = 12;
  const ch = characterFromSave(testSave({
    stats: { strength: 66, agility: 58, speed: 54, luck: 47 },
    skills,
  }), { online: false });
  const r = analyze(ch, { target: referenceFoe(5, 'tough'), core: 'overhaul' });
  assert.equal(r.damage.parts.strMod, 1); // floor((66-50)/10)
  assert.equal(r.damage.min, 3);          // longsword 2 + 1
  assert.equal(r.damage.max, 17);         // longsword 16 + 1
  assert.ok(r.hit.hit > 0.03 && r.hit.hit < 0.97);
  assert.equal(r.hit.crit.skill, 36);
});

test('swing cadence: Speed 50 is one second, Speed 100 ~0.6s', () => {
  const at50 = swingFrameSeconds(50);
  const at100 = swingFrameSeconds(100);
  const at20 = swingFrameSeconds(20);
  assert.ok(Math.abs(at50 - 0.1989795918367347) < 1e-12);
  assert.ok(Math.abs(5 * at50 - 0.9948979591836735) < 1e-12);
  assert.ok(Math.abs(5 * at100 - 0.5969387755102041) < 1e-12);
  assert.ok(at20 > at50);
  assert.ok(Math.abs(swingFrameSeconds(0) - 0.2785714285714286) < 1e-12); // 1.4 x base
});

test('cadence reads weapon weight and handling', () => {
  const ch = characterFromSave(testSave(), { online: false });
  const katana = weaponOf({ group: 'Weapons', templateIndex: 121, material: 9, maxCondition: 1, currentCondition: 1 });
  const claymore = weaponOf({ group: 'Weapons', templateIndex: 122, material: 9, maxCondition: 1, currentCondition: 1 });
  const a = cadence(ch, katana);
  const b = cadence(ch, claymore);
  assert.ok(b.seconds > a.seconds, 'the claymore is heavier and two-handed');
  assert.equal(a.handling, 1);
  assert.equal(b.handling, 1.06);
});

test('reference foes: armour is 5x, class foes flat 60', () => {
  assert.equal(referenceFoe(10, 'soft').armorValues[0], 30);
  assert.equal(referenceFoe(10, 'armoured').armorValues[0], -50);
  assert.equal(referenceFoe(10, 'human').armorValues[0], 60);
  assert.equal(referenceFoe(10, 'human').isClass, true);
  assert.equal(referenceFoe(10, 'soft').skills[20], 80); // 5L+30, capped 100
  assert.equal(referenceFoe(30, 'soft').skills[20], 100);
});

test('curbing is the uniform mean of min/max clipped at the cap', () => {
  assert.equal(expectedCapped(10, 20, 100), 15);
  assert.equal(expectedCapped(10, 20, 5), 5);
  assert.equal(expectedCapped(10, 20, 15), (10 + 11 + 12 + 13 + 14 + 15 * 6) / 11);
});

test('effectiveSkill: 100 -> 100, 125 -> 107, 200 -> 140', () => {
  assert.equal(effectiveSkill(100), 100);
  assert.equal(effectiveSkill(125), 108); // floor(100 + 6.25 + 2)
  assert.equal(effectiveSkill(200), 140);
});

test('online mastery: a mastered Long Blade at 107 plus 20 gear skill', () => {
  const skills = Array.from({ length: 35 }, () => 40);
  skills[29] = 107;
  const save = testSave({ skills, masteredSkills: [29], masterSkills: true, online: true });
  const ch = characterFromSave(save, { online: true });
  ch._mods.skills[29] = 20;
  const r = analyze(ch, { target: referenceFoe(5, 'tough'), core: 'overhaul' });
  // effectiveSkill(107)=101 -> 1% climb; 20 gear points x 0.44 = 8.8%
  assert.ok(Math.abs(r.damage.parts.mastery - 9.8) < 0.001, `mastery ${r.damage.parts.mastery}`);
  const off = characterFromSave(save, { online: false });
  off._mods.skills[29] = 20;
  const ro = analyze(off, { target: referenceFoe(5, 'tough'), core: 'overhaul' });
  assert.equal(ro.damage.parts.mastery, 0);
});

test('the curbing cap only binds below 20x the per-hit', () => {
  const ch = characterFromSave(testSave(), { online: false });
  const small = analyze(ch, { target: bossTarget({ level: 5, health: 200, traits: ['curbing'] }), traits: ['curbing'], health: 200 });
  const large = analyze(ch, { target: bossTarget({ level: 5, health: 2500, traits: ['curbing'] }), traits: ['curbing'], health: 2500 });
  assert.equal(small.cap, 10);
  assert.ok(small.cappedDps < small.dps);
  assert.ok(small.capLoss > 0);
  assert.equal(large.cap, 125);
  assert.ok(Math.abs(large.cappedDps - large.dps) < 1e-9);
  assert.equal(large.capLoss, 0);
});

test('a live equip table is the authority over the saved items and the _mods cache', () => {
  const save = testSave({
    equipSlots: {
      19: { name: 'Katana of the Cat', group: 'Weapons', templateIndex: 121, material: 9, minDamage: 1, maxDamage: 16, maxCondition: 100, currentCondition: 100 },
      6: { name: 'Bracelet of Practice', group: 'Jewellery', affixes: [{ id: 'skill', param: 29, value: 10 }] },
    },
    _mods: { stats: {}, skills: { 29: 999 } },
    _enchantMods: { skillMods: {} },
  });
  const ch = characterFromSave(save, { online: true });
  assert.equal(ch._mods.skills[29], 10, 'equipSlots, not the stale _mods');
  assert.equal(ch.weapon.minDamage, 1);
  assert.equal(ch.weapon.maxDamage, 16);
});

test('the real gate boss: 8,400 HP, plate 60, 420 hit cap, two 3s shields at level 30', () => {
  assert.equal(gateHealth(30), 8400);
  assert.equal(gateHitCap(30), 420);
  const t = gateTarget(30);
  assert.equal(t.maxHealth, 8400);
  assert.equal(t.armorValues[0], 60);
  assert.equal(t.hitCap, 420);
  assert.equal(t.phaseShields, 2);
  assert.equal(t.shieldSeconds, 3);
  const ch = characterFromSave(testSave(), { online: false });
  const r = analyze(ch, { target: t, health: t.maxHealth, traits: [] });
  assert.equal(r.cap, 420);
  assert.equal(r.capSource, 'hit cap');
  assert.ok(r.ttk > t.maxHealth / r.cappedDps, 'the shield seconds are in the TTK');
});

test('backstab: 99% x3, and the gate group health', () => {
  const skills = Array.from({ length: 35 }, () => 40);
  skills[19] = 99;
  const ch = characterFromSave(testSave({ skills }), { online: false });
  const base = analyze(ch, { target: referenceFoe(5, 'soft'), core: 'overhaul' });
  const behind = analyze(ch, { target: referenceFoe(5, 'soft'), core: 'overhaul', backstabUptime: 1 });
  assert.ok(behind.backstab.chance > 0.98);
  assert.equal(behind.backstab.multiplier, 3);
  assert.ok(Math.abs(behind.backstab.critMin - base.damage.critMin * 3) <= 1);
  assert.ok(behind.dps > base.dps * 2.8);
  assert.equal(gateTarget(30, { players: 4 }).maxHealth, 33600);
});
