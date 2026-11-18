/*
 * test/benchmark.test.js - the loadout benchmark harness's own contracts (docs/LOADOUT-BENCHMARK.md).
 *
 * These are not mechanics tests. They pin the things that would make a benchmark untrustworthy: a second loadout
 * construction that could drift from `realTemplate`, a silently accepted option, a condition that does not mean what
 * the report says, and a simulation that mutates the build it measures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { IMPRINT_FAMILIES } from '../src/imprints.js';
import { realBuildStages, realTemplate } from '../src/realBuild.js';
import { referenceFoe } from '../src/model.js';
import { simulateFights } from '../src/simulateFight.js';
import {
  BENCHMARK, POOLS, SEEDS, applyCondition, assertScenario, cellMetrics, loadoutCharacter, loadoutUniverse, spearman,
} from '../tools/benchmark-loadouts.mjs';

const FAMILY = Object.fromEntries(IMPRINT_FAMILIES.map((f) => [f.key, f]));
// One universe for the whole file: `realWeaponLoadouts` runs the real planner chain, so it is not free.
const UNIVERSE = loadoutUniverse();

test('the benchmark uses the optimizer chain, with a carried imprint step and a separate card ceiling', () => {
  for (const pick of ['1H', '2H', 'DW']) {
    const row = UNIVERSE.rows.find((r) => r.category === pick);
    const family = FAMILY[row.key];
    const template = realTemplate(row.template, family, { dual: pick === 'DW' });
    const stages = realBuildStages(row.template, family, { dual: pick === 'DW' });
    assert.ok(Math.abs(template.treeDps - (stages.treeRun.carriedCappedDps + stages.treeRun.enchantDps)) < 1e-9, `${pick} tree`);
    assert.ok(Math.abs(template.enchDps - (stages.enchRun.carriedCappedDps + stages.enchRun.enchantDps)) < 1e-9, `${pick} enchants`);
    const expected = stages.enchRun.enchantDps + (stages.imprint?.dps ?? stages.enchRun.carriedCappedDps);
    assert.ok(Math.abs(template.totalDps - expected) < 1e-9, `${pick} total`);
    assert.equal(template.imprintPower, stages.imprint?.power?.name ?? null, `${pick} imprint`);

    if (pick !== '1H') continue;
    // Mixing the carried imprint figure with the card baseline would misattribute their difference to the imprint.
    assert.ok(stages.imprint, 'the 1H fixture carries an imprint');
    assert.equal(template.metric, 'carried');
    const step = template.totalDps - template.enchDps;
    const carried = stages.imprint.dps - stages.enchRun.carriedCappedDps;
    assert.ok(Math.abs(step - carried) < 1e-9, `imprint step ${step} vs carried minus carried ${carried}`);
    assert.ok(Math.abs(stages.enchRun.carriedCappedDps - stages.enchRun.cappedDps) > 1e-9, 'carried and card baselines differ');
    assert.ok(Math.abs(template.cardEnchDps - stages.enchRun.ceilingTotalDps) < 1e-9, 'the card ceiling baseline is kept and named');
    assert.equal(row.cardDps, Number(template.cardTotalDps.toFixed(4)), 'the benchmark uses the card ceiling, not the carried rate');
  }
});

test('capped loadout baselines stay on the pre-allowance card ceiling', () => {
  // Local contract: this fixture must actually separate the card ceiling from the new default.
  const row = UNIVERSE.rows.find((r) => r.category === '1H');
  const family = FAMILY[row.key];
  const opts = { mode: 'cap' };
  const template = realTemplate(row.template, family, opts);
  const stages = realBuildStages(row.template, family, opts);
  assert.ok(stages.enchRun.totalDps < stages.enchRun.ceilingTotalDps);
  assert.equal(template.cardTreeDps, stages.treeRun.ceilingTotalDps);
  assert.equal(template.cardEnchDps, stages.enchRun.ceilingTotalDps);
});

test('every melee optimizer row is benchmarked, and the refused archetypes are named', () => {
  const { rows, excluded } = UNIVERSE;
  assert.equal(rows.length, 26);
  assert.equal(excluded.length, 5);
  assert.ok(rows.every((r) => r.family !== 'Archery' && r.category !== 'Fists'));
  assert.ok(excluded.every((r) => r.family === 'Archery' || r.category === 'Fists'));
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'ids are unique');
  assert.ok(rows.some((r) => r.category === '1H') && rows.some((r) => r.category === '2H') && rows.some((r) => r.category === 'DW'));
  assert.equal(SEEDS.length, BENCHMARK.seeds);
  assert.equal(new Set(SEEDS).size, SEEDS.length, 'the seed list is unique');
});

test('an unknown option or a non-boolean durability is refused, not ignored (audit D4)', () => {
  assert.throws(() => assertScenario({ health: 10, dur4bility: true }), /unknown scenario option 'dur4bility'/);
  assert.throws(() => assertScenario({ health: 10, durability: 1 }), /durability must be a boolean/);
  assert.throws(() => assertScenario({ health: 10, durability: 'true' }), /durability must be a boolean/);
  assert.doesNotThrow(() => assertScenario({ health: 10, durability: false }));
});

test('a declared condition is points OF the game\'s minted pool, not a small maximum', () => {
  const row = UNIVERSE.rows.find((r) => r.category === '1H');
  const st = loadoutCharacter(row);
  const applied = applyCondition(st.ch, row.template, 800);
  assert.equal(applied.maxCondition, 12800, 'Daedric weapon pool: 1600 x 32 / 4');
  assert.equal(applied.currentCondition, 800);
  assert.equal(st.ch.weapon.currentCondition, 800);
  // A fresh piece keeps no condition fields: the game mints the pool on the first wear.
  const fresh = loadoutCharacter(row);
  assert.equal(fresh.ch.weapon.maxCondition, undefined);
  assert.equal(fresh.ch.weapon.currentCondition, undefined);
});

test('the same seeds reproduce the same cell and never mutate the build', () => {
  const row = UNIVERSE.rows[0];
  const st = loadoutCharacter(row);
  const before = JSON.stringify(st.ch);
  const args = {
    target: referenceFoe(BENCHMARK.level, BENCHMARK.targetPreset),
    health: POOLS[1].health,
    durability: false,
    imprints: st.imprint ? [st.imprint.power] : [],
    seeds: SEEDS.slice(0, 40),
    core: BENCHMARK.core,
    rri: true,
    stacks: BENCHMARK.stacks,
    passiveOn: true,
    maxSeconds: BENCHMARK.maxSeconds,
    maxBlows: BENCHMARK.maxBlows,
  };
  assertScenario(args);
  const a = simulateFights(st.ch, args);
  const mid = JSON.stringify(st.ch);
  const b = simulateFights(st.ch, args);
  assert.equal(before, mid, 'the first run did not move the build');
  assert.equal(mid, JSON.stringify(st.ch), 'the second run did not move the build');
  assert.deepEqual(cellMetrics(a), cellMetrics(b));
  assert.equal(a.trials, 40);
});

test('spearman is +1 on a shared order and -1 on its reverse', () => {
  const a = { x: 1, y: 2, z: 3 };
  assert.equal(spearman(a, { x: 10, y: 20, z: 30 }), 1);
  assert.equal(spearman(a, { x: 30, y: 20, z: 10 }), -1);
  assert.equal(spearman(a, { x: 5, y: 5, z: 5 }), null);
});
