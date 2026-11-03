import test from 'node:test';
import assert from 'node:assert/strict';
import { realLoadouts } from '../src/realBuild.js';

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
