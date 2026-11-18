import test from 'node:test';
import assert from 'node:assert/strict';
import { gearPieces, planEnchants, planMatrix, SOUL_GEM_POINTS } from '../src/enchantPlan.js';
import { gateTarget, referenceFoe } from '../src/model.js';
import { THEORY_LEVEL } from '../src/theory.js';
import { maxCharacter, maxRun } from '../src/maxprofile.js';
import { ITEM_ENCHANTMENT_MAX } from '../src/enchantData.js';

test('a two-handed weapon has no shield, a one-handed one does', () => {
  const two = gearPieces({ weapon: 123, shield: 'auto' });
  const one = gearPieces({ weapon: 121, shield: 'auto' });
  assert.ok(!two.some((p) => /Shield|Buckler/.test(p.slot)));
  assert.ok(one.some((p) => /Shield|Buckler/.test(p.slot)));
});

test('base budgets are the template points, and the soul gem adds 5,000 to each', () => {
  const base = planEnchants({ weapon: 123, soulGem: false });
  const soul = planEnchants({ weapon: 123, soulGem: true });
  for (let i = 0; i < base.rows.length; i++) {
    assert.equal(soul.rows[i].budget, base.rows[i].budget + SOUL_GEM_POINTS);
    assert.equal(soul.rows[i].soul, SOUL_GEM_POINTS);
  }
});

test('no piece spends past its budget, its item cap, or repeats one setting', () => {
  const plan = planEnchants({ weapon: 123, soulGem: true });
  for (const row of plan.rows) {
    assert.equal(row.spent, row.effects.reduce((a, e) => a + e.cost, 0), row.slot);
    assert.ok(row.spent <= row.budget, row.slot);
    assert.ok(row.effects.length <= ITEM_ENCHANTMENT_MAX, row.slot);
    const keys = row.effects.map((e) => `${e.type}:${e.param}`);
    assert.equal(new Set(keys).size, keys.length, row.slot);
  }
});

test('the one-piece effects are placed on one piece, and skills stack across pieces', () => {
  const plan = planEnchants({ weapon: 123, soulGem: true });
  for (const type of ['StrengthensArmor', 'AbsorbsSpells', 'IncreasedWeightAllowance']) {
    const pieces = plan.rows.filter((r) => r.effects.some((e) => e.type === type));
    assert.equal(pieces.length, 1, type);
  }
  const repairs = plan.rows.filter((r) => r.effects.some((e) => e.type === 'RepairsObjects'));
  assert.equal(repairs.length, 1, 'one Repairs Objects by default');
  const moreRepairs = planEnchants({ weapon: 123, soulGem: true, repairs: 3 }).rows.filter((r) => r.effects.some((e) => e.type === 'RepairsObjects'));
  assert.equal(moreRepairs.length, 3);
  const regen = planEnchants({ weapon: 123, soulGem: true, regen: 1 }).rows.filter((r) => r.effects.some((e) => e.type === 'RegensHealth'));
  assert.equal(regen.length, 1);
  const skillPieces = planEnchants({ weapon: 117, soulGem: true }).rows.filter((r) => r.effects.some((e) => e.type === 'EnhancesSkill'));
  assert.ok(skillPieces.length > 1);
  assert.ok(!plan.rows.some((r) => r.effects.some((e) => e.type === 'EnhancesSkill' && e.paramName === 'Backstabbing')));
  const forced = planEnchants({ weapon: 123, soulGem: true, forceSkills: true });
  assert.ok(forced.rows.filter((r) => r.effects.some((e) => e.type === 'EnhancesSkill')).length >= 18);
  const aware = planEnchants({ weapon: 123, soulGem: true, forceSkills: false });
  const awareSkills = aware.rows.flatMap((r) => r.effects.filter((e) => e.type === 'EnhancesSkill'));
  // Without forceSkills the planner may add a skill only where +15 still pays at the gate; the legal
  // gear profile and the boss's intrinsic hide leave a small positive marginal, whose rounded label
  // can read "0 DPS". The raw choice is positive; the label is not a threshold.
  assert.ok(awareSkills.every((e) => Number.parseFloat(e.benefit) >= 0), 'only non-negative skills');
  assert.ok(!awareSkills.some((e) => e.paramName === 'Backstabbing'));
  assert.ok(awareSkills.length < forced.rows.filter((r) => r.effects.some((e) => e.type === 'EnhancesSkill')).length);
});

test('strike procs respect the weapon condition over the gate fight', () => {
  const plan = planEnchants({ weapon: 123, soulGem: true });
  const procs = plan.rows[0].effects.filter((e) => e.type === 'CastWhenStrikes').length;
  assert.ok(plan.maxProcs >= 1);
  assert.ok(procs <= plan.maxProcs);
});

test('strike enchantments only sit on the weapon', () => {
  const plan = planEnchants({ weapon: 123, soulGem: true });
  for (const row of plan.rows) {
    if (row.slot !== 'Weapon') assert.ok(!row.effects.some((e) => e.type === 'CastWhenStrikes'), row.slot);
  }
  assert.ok(plan.rows[0].effects.some((e) => e.type === 'CastWhenStrikes'));
});


test('the plan names the carried baseline beside the card plan figures', () => {
  // The CLI's JSON reads these fields; a carried baseline must not sit unlabelled beside a card plan total, or a
  // reader adds a metric jump to the plan's worth. The names are the contract: carried on the weapon baseline,
  // card on the plan totals (`applyPlanDps` re-runs the card).
  const gate = gateTarget(THEORY_LEVEL);
  const plan = planEnchants({ weapon: 123, soulGem: true });
  const ch = maxCharacter(123, {});
  ch._template = 123;
  const base = maxRun(ch, { target: gate });
  assert.equal(plan.carriedBaseDps, base.carriedCappedDps);
  assert.ok(plan.carriedBaseDps !== base.cappedDps, 'the card baseline differs on this fixture');
  assert.ok(Object.hasOwn(plan, 'carriedUncappedDps'), 'carried uncapped baseline is named');
  assert.ok(Object.hasOwn(plan, 'cardPlanDps') && Object.hasOwn(plan, 'cardUncappedPlanDps'), 'card plan totals are named');
  assert.ok(plan.cardPlanDps > 0 && plan.cardUncappedPlanDps > 0);
});

test('the weapon-type matrix prices every family on its best weapon', () => {
  const gate = planMatrix({ soulGem: true });
  assert.equal(gate.length, 6);
  assert.ok(gate.every((x) => x.plan && x.plan.cardPlanDps > 0));
  const uncapped = planMatrix({ soulGem: true, target: referenceFoe(45, 'tough') });
  for (const id of ['LongBlade', 'ShortBlade', 'Axe', 'BluntWeapon', 'HandToHand']) {
    const row = uncapped.find((x) => x.key === id);
    assert.ok(row.skillPieces >= 15, `${id} weapon skill pieces ${row.skillPieces}`);
    assert.ok(row.csPieces >= 15, `${id} CS pieces ${row.csPieces}`);
  }
});
