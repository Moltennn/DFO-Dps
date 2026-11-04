import test from 'node:test';
import assert from 'node:assert/strict';
import { realWeaponLoadouts } from '../src/realBuild.js';

const rows = realWeaponLoadouts();

test('real loadouts cover every family in both modes', () => {
  for (const mode of ['uncapped', 'cap']) {
    const families = new Set(rows.filter((r) => r.mode === mode).map((r) => r.family));
    assert.equal(families.size, 6);
  }
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
    const best = (mode) => Math.max(...rows.filter((r) => r.family === family && r.mode === mode).map((r) => r.totalDps));
    assert.ok(best('cap') <= best('uncapped') + 1e-9, family);
  }
});

test('all weapon loadouts list every template and exclude monster-type damage imprints', () => {
  assert.ok(rows.length >= 30);
  const forbidden = new Set(['Dragonsbane', 'Sanctified', "Hunter's Moon"]);
  assert.ok(rows.every((r) => !forbidden.has(r.imprintPower)));
  // Any Weapon Legendary's power fits any weapon, so every row carries one.
  assert.ok(rows.every((r) => r.imprintPower), 'every loadout should carry an imprint');
  const long = rows.filter((r) => r.mode === 'cap' && r.family === 'Long Blade');
  assert.ok(long.some((r) => r.category === '1H') && long.some((r) => r.category === '2H') && long.some((r) => r.category === 'DW'));
  assert.ok(long.some((r) => r.imprintPower === 'Many Endings'));
});

test('the capped loadout carries the purse metrics per content', () => {
  const breach = realWeaponLoadouts({ modes: ['cap'], encounter: 'breach' });
  assert.ok(breach.every((r) => r.calibrated));
  assert.ok(breach.every((r) => r.ttk > 0 && r.burst5 > 0 && r.sustainedDps > 0));
  const ketch = realWeaponLoadouts({ modes: ['cap'], encounter: 'skyketch' });
  assert.ok(ketch.every((r) => r.calibrated));
  assert.ok(ketch[0].ttk > breach[0].ttk, `${ketch[0].ttk} vs ${breach[0].ttk}`);
  const abyss = realWeaponLoadouts({ modes: ['cap'], encounter: 'abyss' });
  assert.ok(abyss.every((r) => !r.calibrated));
});
