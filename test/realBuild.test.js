import test from 'node:test';
import assert from 'node:assert/strict';
import { realCategoryLoadouts, realFamilyLoadouts, realLoadouts } from '../src/realBuild.js';

const rows = realLoadouts();

test('real loadouts cover every family in both modes', () => {
  assert.equal(rows.length, 12);
  for (const mode of ['uncapped', 'cap']) assert.equal(rows.filter((r) => r.mode === mode).length, 6);
});

test('the tree is real, and the chain is ordered', () => {
  for (const r of rows) {
    assert.ok(r.treeStars > 0 && r.treeStars <= 98, r.family);
    assert.equal(r.freeStars, 98 - r.treeStars);
    assert.ok(r.treeDps > 0, r.family);
    assert.ok(r.enchDps >= r.treeDps, r.family);
    assert.ok(r.totalDps >= r.enchDps - 1e-9, r.family);
  }
});

test('the capped loadouts do not beat the uncapped ones', () => {
  for (const family of new Set(rows.map((r) => r.family))) {
    const u = rows.find((r) => r.family === family && r.mode === 'uncapped');
    const c = rows.find((r) => r.family === family && r.mode === 'cap');
    assert.ok(c.totalDps <= u.totalDps + 1e-9, family);
  }
});


test('the loadout page keeps one best 1H, 2H and DW per mode', () => {
  const cats = realCategoryLoadouts();
  assert.equal(cats.length, 6);
  for (const mode of ['uncapped', 'cap']) assert.deepEqual(cats.filter((r) => r.mode === mode).map((r) => r.category).sort(), ['1H', '2H', 'DW']);
  const cap2h = cats.find((r) => r.mode === 'cap' && r.category === '2H');
  assert.equal(cap2h.imprintPower, 'Many Endings');
});


test('every family gets its own best hand options', () => {
  const rows = realFamilyLoadouts({ modes: ['cap'] });
  for (const family of ['Long Blade', 'Short Blade', 'Axe', 'Blunt Weapon', 'Archery', 'Hand-to-Hand']) {
    assert.ok(rows.some((r) => r.family === family), family);
  }
  const long = rows.filter((r) => r.family === 'Long Blade').map((r) => r.category).sort();
  assert.deepEqual(long, ['1H', '2H', 'DW']);
  const cap2h = rows.find((r) => r.family === 'Long Blade' && r.category === '2H');
  assert.equal(cap2h.imprintPower, 'Many Endings');
});
