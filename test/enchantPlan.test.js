import test from 'node:test';
import assert from 'node:assert/strict';
import { gearPieces, planEnchants, SOUL_GEM_POINTS } from '../src/enchantPlan.js';
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
  for (const type of ['StrengthensArmor', 'AbsorbsSpells', 'IncreasedWeightAllowance', 'RepairsObjects']) {
    const pieces = plan.rows.filter((r) => r.effects.some((e) => e.type === type));
    assert.equal(pieces.length, 1, type);
  }
  const skillPieces = plan.rows.filter((r) => r.effects.some((e) => e.type === 'EnhancesSkill'));
  assert.ok(skillPieces.length > 1);
});

test('strike enchantments only sit on the weapon', () => {
  const plan = planEnchants({ weapon: 123, soulGem: true });
  for (const row of plan.rows) {
    if (row.slot !== 'Weapon') assert.ok(!row.effects.some((e) => e.type === 'CastWhenStrikes'), row.slot);
  }
  assert.ok(plan.rows[0].effects.some((e) => e.type === 'CastWhenStrikes'));
});
