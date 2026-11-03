import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILDS, buildById, planBuild, planFromTree, planKey, planSummary } from '../src/firmament.js';
import { START_KEYS } from '../vendor/firmament/firmamentTree.js';
import { blowPct, castCostPct, treeFault } from '../vendor/firmament/firmamentLaw.js';

test('a firmament plan is a whole 98-star path from one sign', () => {
  const plan = planBuild(buildById('longblade'));
  assert.equal(plan.stars, 98);
  assert.ok(START_KEYS.includes(plan.tree.start));
  assert.equal(new Set(plan.tree.keys).size, plan.tree.keys.length);
  assert.equal(treeFault(plan.tree, 98, 0), null);
});

test('the long-blade plan fills the weapon blow group cap', () => {
  const plan = planBuild(buildById('longblade'));
  assert.equal(blowPct(plan.totals, { skill: 'LongBlade' }), 30);
  const s = planSummary(plan);
  assert.ok((plan.totals['skill.LongBlade'] ?? 0) > 0);
  assert.ok(s.counts.notable > 0);
});

test('the destruction plan fills the spell-cost group cap', () => {
  const plan = planBuild(buildById('destruction'));
  assert.equal(plan.stars, 98);
  assert.equal(castCostPct(plan.totals, ['Destruction']), 25);
  assert.ok((plan.totals.spellPower ?? 0) > 0);
});

test('a star budget is respected and every build returns a plan', () => {
  for (const build of BUILDS) {
    const plan = planBuild(build, { stars: 12 });
    assert.ok(plan.stars <= 12, `${build.id} spent ${plan.stars}`);
    assert.equal(treeFault(plan.tree, 98, 0), null);
  }
});

test('the same build and budget give the same tree', () => {
  const a = planBuild(buildById('bow'), { stars: 24 });
  const b = planBuild(buildById('bow'), { stars: 24 });
  assert.deepEqual(a.tree, b.tree);
});


test('a persisted plan rehydrates to the same tree and totals', () => {
  const build = buildById('longblade');
  const p = planBuild(build, { stars: 24 });
  const r = planFromTree(build, { start: p.start, keys: p.tree.keys, stars: p.stars, starBudget: p.starBudget });
  assert.deepEqual(r.tree, p.tree);
  assert.equal(r.stars, p.stars);
  assert.equal(r.totals['skill.LongBlade'], p.totals['skill.LongBlade']);
  assert.notEqual(planKey('longblade', 24), planKey('shortblade', 24));
});
