/*
 * test/gearProfile.test.js - C4: the maximum gear profile is legal.
 *
 * The old profile assumed 30 points in each of 8 Long Blade slot lines and 18 Critical Strike slot
 * lines (240 + 540 = 780). That is not a budget the game has: a line is a thing a piece carries.
 *
 * The law is the vendored game's (vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js):
 *   AFFIX_RANGES       skill bands Magic [5,10], Rare [10,20], Legendary [20,30] (:486)
 *   AFFIX_COUNTS       Magic 1-2 lines, Rare 3-4 (:507)
 *   kindLines          one line per kind's param per piece (:679-682)
 *   skillKin           which skills a ROLLED line may name (:703-716, :784-788)
 *   legendariesFor     the records a slot may be minted from (:1310-1314)
 *   exaltLegendary     one extra line of a kind the record lacks; the skill PARAM is drawn over every
 *                      skill, not kin-filtered (:1770-1790)
 *   honeableLines      only a rolled line (Magic/Rare/Exalted) may be honed (:2243-2250)
 *
 * Run against the pre-fix tree, the tests marked "pre-fix" below fail: the old profile was unreachable
 * and the old constants called a slot count a point budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AFFIX_COUNTS, AFFIX_RANGES, allLegendaries, exaltLegendary, legendariesFor,
} from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { legendaryGate, rareGate } from '../vendor/upstream/a3eb1605/src/systems/loot/lootLevelGate.js';

import {
  AFFIX_DAMAGE_TOP, EXALTED_SKILL_FLOOR, SKILL_BAND_TOP,
  canExaltSkill, canExaltSkillHere, canRollSkill, legalPointTotals, legalTotals, maxPointTotal,
  maxSingleSkill, recordsFor, rolledSkills, slotOptions, slotsFor, validatePlan, weaponSkillOf,
} from '../src/gearProfile.js';
import { buildMax, legalFrontier, legalGear, maxCharacter } from '../src/maxprofile.js';
import { SKILLS } from '../src/data.js';
import { analyze, gateTarget, referenceFoe } from '../src/model.js';
import { generator } from './harness/prng.mjs';

const GATE = () => gateTarget(45);
const TOUGH = () => referenceFoe(45, 'tough');

test('the model reads the game\'s bands, counts and Exalted floor (upstream law)', () => {
  assert.deepEqual(SKILL_BAND_TOP, {
    magic: AFFIX_RANGES.skill.magic[1],
    rare: AFFIX_RANGES.skill.rare[1],
    legendary: AFFIX_RANGES.skill.legendary[1],
  });
  assert.deepEqual([SKILL_BAND_TOP.magic, SKILL_BAND_TOP.rare, SKILL_BAND_TOP.legendary], [10, 20, 30]);
  assert.deepEqual(AFFIX_DAMAGE_TOP, {
    magic: AFFIX_RANGES.damage.magic[1],
    rare: AFFIX_RANGES.damage.rare[1],
    legendary: AFFIX_RANGES.damage.legendary[1],
  });
  assert.equal(AFFIX_DAMAGE_TOP.rare, 25);
  assert.equal(EXALTED_SKILL_FLOOR, Math.ceil((20 + 30) / 2));
  assert.deepEqual(AFFIX_COUNTS.magic, [1, 2]);
  assert.deepEqual(AFFIX_COUNTS.rare, [3, 4]);
});

test('a rolled line follows skillKin; the Exalted skill line does not (pre-fix: the old model kin-filtered it)', () => {
  // ROLLED lines: armour's BODY_KIN has both; jewellery's JEWEL_KIN has Critical Strike, not Long Blade.
  assert.ok(canRollSkill(102, 'Armor', SKILLS.LongBlade));
  assert.ok(canRollSkill(102, 'Armor', SKILLS.CriticalStrike));
  assert.ok(canRollSkill(135, 'Jewellery', SKILLS.CriticalStrike));
  assert.ok(!canRollSkill(135, 'Jewellery', SKILLS.LongBlade));
  assert.ok(!rolledSkills(135, 'Jewellery').includes(SKILLS.LongBlade));

  // The Exalted extra is drawn with pick(kindParams), which is not kin-filtered: a jewellery record
  // with no skill line can gain +30 Long Blade.
  assert.ok(canExaltSkillHere(135, 'Jewellery'));
  assert.deepEqual(slotOptions(135, 'Jewellery', SKILLS.LongBlade).map((o) => [o.lb, o.cs]), [[30, 0], [0, 30]]);

  // The oracle: force the game's own exaltLegendary over many draws and watch a jewellery piece gain
  // Long Blade (param 29), which no rolled jewellery line could name.
  const rolls = generator(20261114);
  const base = {
    rarity: 'legendary', group: 'Jewellery', templateIndex: 135,
    affixes: [{ id: 'stat', param: 'luck', value: 15 }, { id: 'stat', param: 'speed', value: 10 }, { id: 'resist', param: 'poison', value: 35 }],
    value: 1,
  };
  let longBlade = false;
  for (let i = 0; i < 3000 && !longBlade; i++) {
    const item = JSON.parse(JSON.stringify(base));
    exaltLegendary(item, rolls);
    const extra = item.affixes[item.affixes.length - 1];
    if (extra.id === 'skill' && extra.param === SKILLS.LongBlade) {
      longBlade = true;
      assert.ok(extra.value >= EXALTED_SKILL_FLOOR && extra.value <= SKILL_BAND_TOP.legendary);
    }
  }
  assert.ok(longBlade, 'exaltLegendary names any skill, including Long Blade on jewellery');
});

test('a piece can carry both skills at 20, never both at 30 (one Exalted line, one kind)', () => {
  for (const [template, group, skill] of [
    [123, 'Weapons', SKILLS.LongBlade],
    [102, 'Armor', SKILLS.LongBlade],
    [135, 'Jewellery', SKILLS.LongBlade],
    [563, 'Weapons', SKILLS.HandToHand],
  ]) {
    for (const o of slotOptions(template, group, skill)) {
      assert.ok(!(o.lb === SKILL_BAND_TOP.legendary && o.cs === SKILL_BAND_TOP.legendary), `${template}: both 30s`);
    }
  }
  // A weapon record always carries a skill line, so no weapon can Exalt a skill; the best it can reach
  // is its record's 25 or a Rare's 20.
  assert.ok(!canExaltSkillHere(123, 'Weapons'));
  const weaponMax = Math.max(...slotOptions(123, 'Weapons', SKILLS.LongBlade).map((o) => Math.max(o.lb, o.cs)));
  assert.equal(weaponMax, 25);
  assert.ok(slotOptions(123, 'Weapons', SKILLS.LongBlade).some((o) => o.lb === 20 && o.cs === 20));
  // The champion slot can Exalt a skill, because the-warden and titanheart fit every body piece and
  // carry no skill.
  assert.ok(canExaltSkillHere(102, 'Armor'));
  assert.equal(Math.max(...slotOptions(102, 'Armor', SKILLS.LongBlade).map((o) => Math.max(o.lb, o.cs))), 30);
});

test('every record\'s Exalted skill capacity matches the game\'s "kind not carried" law', () => {
  // The registry legitimately grows by mod records (thunderlock.js registers The Last Lock and the
  // wardrobe's); every one must obey the same "kind not carried" law.
  assert.ok(allLegendaries().length >= 39);
  for (const r of allLegendaries()) {
    const carriesSkill = (r.affixes ?? []).some((a) => a.id === 'skill');
    assert.equal(canExaltSkill(r, r.group), !carriesSkill, `${r.id} (${r.group})`);
  }
  // And the records that fit a slot are the game's own list.
  for (const [template, group] of [[123, 'Weapons'], [102, 'Armor'], [135, 'Jewellery']]) {
    const ours = recordsFor(template, group).map((r) => r.id).sort();
    const theirs = legendariesFor({ group, templateIndex: template }).map((r) => r.id).sort();
    assert.deepEqual(ours, theirs);
  }
});

test('the old 240 / 540 / 780 profile is not reachable (pre-fix: the max profile assumed it)', () => {
  for (const template of [113, 117, 121, 123, 126, 127, 129]) {
    const skill = weaponSkillOf(template);
    const totals = legalTotals({ weaponTemplate: template, skill });
    assert.ok(!totals.some((p) => p.lb >= 240 && p.cs >= 540), `${template}: the old 240/540 exists`);
    assert.ok(!totals.some((p) => p.lb + p.cs > maxPointTotal({ weaponTemplate: template, skill })), `${template}: above the legal total`);
  }
  // Long blade: 25 from a weapon record + 17 Exalted slots x 30 = 535 per skill; the two together top
  // at 620 (the ten jewellery slots can only reach the weapon skill through an Exalted line).
  assert.equal(maxSingleSkill({ weaponTemplate: 123 }), 535);
  assert.equal(maxSingleSkill({ weaponTemplate: 123, skill: SKILLS.CriticalStrike }), 535);
  assert.equal(maxPointTotal({ weaponTemplate: 123 }), 620);
  assert.ok(legalPointTotals({ weaponTemplate: 123 }).every((p) => p.lb + p.cs <= 620));
  // 780 is not even the sum of independent maxima (620), let alone a reachable plan.
  assert.ok(780 > maxPointTotal({ weaponTemplate: 123 }));
});

test('the per-skill and point budgets are level-independent; only the loot gate is level-dependent', () => {
  // There is no character-level currency for gear lines: the same 18 slots, bands and one-Exalted-line
  // rule apply at every level. The only level law is the LOOT-GATE, which scales the CHANCE of Rare and
  // Legendary drops (never Magic) until it reaches x1 at levels 12 and 15.
  assert.equal(rareGate(7), 0.15);
  assert.equal(rareGate(12), 1);
  assert.equal(legendaryGate(9), 0.05);
  assert.equal(legendaryGate(15), 1);
  for (const level of [1, 9, 12, 15, 45, 60]) {
    assert.ok(rareGate(level) > 0 && rareGate(level) <= 1);
    assert.ok(legendaryGate(level) > 0 && legendaryGate(level) <= 1);
  }
  // The budget itself has no level argument, and the same 620 points stand at every level.
  assert.equal(maxPointTotal({ weaponTemplate: 123 }), 620);
  assert.equal(maxSingleSkill({ weaponTemplate: 123 }), 535);
  // Progression does not unlock extra lines either: the slots are the worn pieces (and a shield).
  assert.equal(slotsFor({ weaponTemplate: 123 }).length, 18);
  assert.equal(slotsFor({ weaponTemplate: 117, shield: 111 }).length, 19);
});

test('validatePlan rejects illegal allocations clearly', () => {
  const bad = (plan) => validatePlan(plan).join('\n');
  // A Rare may not exceed its band.
  assert.match(bad([{ template: 102, group: 'Armor', rarity: 'rare', lines: [{ id: 'skill', param: SKILLS.LongBlade, value: 21 }] }]), /above the rare band/);
  // A Magic holds at most two lines.
  assert.match(bad([{ template: 102, group: 'Armor', rarity: 'magic', lines: [
    { id: 'skill', param: SKILLS.LongBlade, value: 10 }, { id: 'skill', param: SKILLS.CriticalStrike, value: 10 }, { id: 'stat', param: 'strength', value: 5 },
  ] }]), /too many lines/);
  // One line per skill param.
  assert.match(bad([{ template: 102, group: 'Armor', rarity: 'rare', lines: [
    { id: 'skill', param: SKILLS.LongBlade, value: 20 }, { id: 'skill', param: SKILLS.LongBlade, value: 20 },
  ] }]), /one line per skill/);
  // Jewellery cannot ROLL Long Blade.
  assert.match(bad([{ template: 135, group: 'Jewellery', rarity: 'rare', lines: [{ id: 'skill', param: SKILLS.LongBlade, value: 20 }] }]), /may roll/);
  // A record's own line is fixed.
  assert.match(bad([{ template: 123, group: 'Weapons', rarity: 'legendary', record: 'anseis-edge', lines: [
    { id: 'damage', value: 30 }, { id: 'stat', param: 'agility', value: 12 }, { id: 'skill', param: SKILLS.LongBlade, value: 30 },
  ] }]), /fixed at 25/);
  // A record that already carries a skill cannot Exalt another skill line; an Exalted line starts at 25.
  assert.match(bad([{ template: 123, group: 'Weapons', rarity: 'legendary', record: 'anseis-edge', exalted: true,
    lines: [{ id: 'skill', param: 34, value: 30 }] }]), /Exalted line repeats a carried kind/);
  assert.match(bad([{ template: 102, group: 'Armor', rarity: 'legendary', record: 'the-warden', exalted: true,
    lines: [{ id: 'armor', value: 15 }, { id: 'stat', param: 'endurance', value: 12 }, { id: 'resist', param: 'magic', value: 40 }, { id: 'skill', param: SKILLS.LongBlade, value: 24 }] }]), /starts at 25/);
  // A legal pair is accepted.
  assert.deepEqual(validatePlan([
    { template: 102, group: 'Armor', rarity: 'rare', lines: [{ id: 'skill', param: SKILLS.LongBlade, value: 20 }, { id: 'skill', param: SKILLS.CriticalStrike, value: 20 }] },
    { template: 102, group: 'Armor', rarity: 'legendary', record: 'the-warden', exalted: true, lines: [
      { id: 'armor', value: 15 }, { id: 'stat', param: 'endurance', value: 12 }, { id: 'resist', param: 'magic', value: 40 }, { id: 'skill', param: SKILLS.LongBlade, value: 30 },
    ] },
  ]), []);
});

test('a generated max profile is legal, complete and the best uncapped point (pre-fix: it used 240/540/40)', () => {
  for (const template of [113, 117, 121, 123, 126, 127, 129, 563]) {
    const g = legalGear(template);
    const lbCap = maxSingleSkill({ weaponTemplate: template });
    const csCap = maxSingleSkill({ weaponTemplate: template, skill: SKILLS.CriticalStrike });
    assert.ok(g.lb <= lbCap, `${template}: LB ${g.lb} is above the legal ${lbCap}`);
    assert.ok(g.cs <= csCap, `${template}: CS ${g.cs} is above the legal ${csCap}`);
    assert.ok(g.dmg <= 38, `${template}: damage ${g.dmg}% is above every Legendary record (38%)`);
    assert.deepEqual(g.violations, [], `${template} violations`);
    assert.equal(g.plan.length, 18, `${template} slots`);
    assert.equal(g.plan.reduce((n, p) => n + p.lb, 0), g.lb, `${template} LB sum`);
    assert.equal(g.plan.reduce((n, p) => n + p.cs, 0), g.cs, `${template} CS sum`);
    assert.equal(Math.max(...g.plan.map((p) => p.dmg)), g.dmg, `${template} damage`);
    const frontier = legalFrontier(template);
    assert.ok(frontier.some((p) => p.lb === g.lb && p.cs === g.cs && p.dmg === g.dmg), `${template} on the frontier`);
    assert.ok(frontier.every((p) => p.dps <= g.dps + 1e-9), `${template} not the best`);
    // Every piece is one of the slots, and a shield was not silently added.
    assert.deepEqual(g.plan.map((p) => p.template), slotsFor({ weaponTemplate: template }).map((s) => s.template));
  }
  // The two-hand long blade's legal best is 250 / 370 / 25%, not 240 / 540 / 40%.
  const g = legalGear(123);
  assert.deepEqual([g.lb, g.cs, g.dmg], [250, 370, 25]);
  const old = analyze(buildMax(123, { gearSkill: 240, gearCrit: 540, damagePct: 40 }), { target: TOUGH(), core: 'overhaul', rri: true, stacks: 5 });
  const now = analyze(maxCharacter(123), { target: TOUGH(), core: 'overhaul', rri: true, stacks: 5 });
  assert.ok(now.dps < old.dps, `legal ${now.dps} should be below the illegal ${old.dps}`);
  assert.ok(Math.abs(now.dps / old.dps - 1) > 0.15, 'the audit\'s double-digit gap must reproduce');
});

test('scenario maxima remain legal; the allowance split is distinct', () => {
  const uncapped = legalGear(123, { metric: 'uncapped' });
  const capped = legalGear(123, { metric: 'capped' });
  const allowance = legalGear(123, { metric: 'allowance' });
  for (const g of [uncapped, capped, allowance]) assert.deepEqual(g.violations, []);
  assert.ok(capped.cappedDps >= uncapped.cappedDps - 1e-9);
  assert.ok(uncapped.dps >= capped.dps);
  // Today the allowance optimum is a different legal split from the uncapped one (250 Long Blade / 370 Critical
  // Strike against 535 / 0): the relay allowance prefers it. The assertion pins that distinction.
  assert.ok(allowance.lb !== uncapped.lb || allowance.cs !== uncapped.cs, 'the allowance split must be preserved');
});

test('a shield is a distinct legal scenario: one more armour slot', () => {
  const noShield = legalGear(117);
  const shield = legalGear(117, { shield: 111 });
  assert.equal(noShield.plan.length, 18);
  assert.equal(shield.plan.length, 19);
  assert.deepEqual(shield.violations, []);
  assert.ok(maxPointTotal({ weaponTemplate: 117, shield: 111 }) > maxPointTotal({ weaponTemplate: 117 }));
  assert.ok(slotsFor({ weaponTemplate: 117, shield: 111 }).some((s) => s.kind === 'shield' && s.template === 111));
});

test('single-weapon, dual-wield and fist builds keep the legal budget (C3/C1 unchanged)', () => {
  // Two-handed and one-handed singles.
  for (const template of [123, 121]) {
    const ch = maxCharacter(template);
    const g = legalGear(template);
    assert.equal(ch._mods.skills[weaponSkillOf(template)], g.lb);
    assert.equal(ch._mods.skills[SKILLS.CriticalStrike], g.cs);
    assert.equal(ch.weapon.affixes.find((a) => a.id === 'damage').value, g.dmg);
  }
  // Dual wield: the off hand is the same weapon, and the gear budget stays the single-weapon one (the
  // simulator does not fold a second weapon's affixes; that limitation is documented, not hidden).
  const single = maxCharacter(121);
  const dual = maxCharacter(121);
  dual.offWeapon = { ...dual.weapon, equipSlot: 21 };
  dual._dual = true;
  assert.deepEqual(dual._mods.skills, single._mods.skills);
  const r = analyze(dual, { target: TOUGH(), core: 'overhaul', rri: true, stacks: 5, dual: true });
  assert.ok(r.dps > 0 && r.dps > analyze(single, { target: TOUGH(), core: 'overhaul', rri: true, stacks: 5 }).dps);
  // Fists: Hand Wraps are a weapon slot, and the six other non-weapon slots can Exalt Hand-to-Hand.
  const fists = legalGear(563);
  assert.equal(fists.plan.length, 18);
  assert.deepEqual(fists.violations, []);
  assert.equal(maxSingleSkill({ weaponTemplate: 563 }), 530);
  assert.equal(maxPointTotal({ weaponTemplate: 563 }), 720);
});

test('the damage mechanics are untouched: only the budget changed', () => {
  const g = legalGear(123);
  const built = buildMax(123, { gearSkill: g.lb, gearCrit: g.cs, damagePct: g.dmg });
  const max = maxCharacter(123);
  // Same stats, same raw skills, same sockets, same weapon; the one difference is the budget.
  assert.deepEqual(max.stats, built.stats);
  assert.deepEqual(max.skills, built.skills);
  assert.deepEqual(max._mods.skills, built._mods.skills);
  assert.deepEqual(max.weapon, built.weapon);
  assert.deepEqual(max.sockets ?? [], built.sockets ?? []);
  const a = analyze(built, { target: TOUGH(), core: 'overhaul', rri: true, stacks: 5 });
  const b = analyze(max, { target: TOUGH(), core: 'overhaul', rri: true, stacks: 5 });
  assert.deepEqual(a, b);
  // And the old formula still reads the same numbers; the legal budget is the only reason DPS moved.
  const noGear = analyze(buildMax(123, { gearSkill: 0, gearCrit: 0, damagePct: 0 }), { target: TOUGH(), core: 'overhaul', rri: true, stacks: 5 });
  const zero = analyze(buildMax(123, { gearSkill: 0, gearCrit: 0, damagePct: 0 }), { target: TOUGH(), core: 'overhaul', rri: true, stacks: 5 });
  assert.deepEqual(noGear, zero);
  assert.ok(b.dps > noGear.dps);
});

test('the gate still sits on the relay allowance, not the uncapped profile (C1)', () => {
  const ch = maxCharacter(123);
  const r = analyze(ch, { target: GATE(), health: GATE().maxHealth, core: 'overhaul', rri: true, stacks: 5 });
  const a = r.allowance;
  assert.ok(a);
  assert.equal(a.sustainedDps, 3 * 50);
  assert.ok(a.averageDps <= 3 * 50 * 1.15);
  // The per-hit ceiling is far above the allowance, and the legal profile does not change that relation.
  assert.ok(r.cappedDps > a.averageDps * 3);
  assert.ok(Math.abs(r.ttk - GATE().maxHealth / a.averageDps) < 0.15 * (GATE().maxHealth / a.averageDps));
});
