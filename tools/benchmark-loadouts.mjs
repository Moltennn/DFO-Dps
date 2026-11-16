/*
 * dfo-dps - reproducible loadout benchmark (docs/LOADOUT-BENCHMARK.md).
 *
 * This is a REPORTING harness, not a combat model. Every number comes from the production paths:
 *
 *   realWeaponLoadouts / realBuildStages   the `loadout` command's optimizer chain (max legal gear -> Firmament tree ->
 *                                          enchant plan -> best eligible imprint)
 *   simulateFights                         the Stage 3.2 seeded blow-by-blow fight (src/simulateFight.js)
 *   pairedFightSeeds                       the project's deterministic seed list
 *
 * Nothing here re-prices a blow, invents a stat or reads a second damage formula. The script only chooses the
 * scenarios (target body, health pools, seeds, item condition), runs them, and writes the tables and charts.
 *
 * Declared benchmark inputs (all recorded in results.json):
 *   target          referenceFoe(45, 'tough') - the same ordinary foe `maxRun` uses for uncapped theory
 *   health pools    8,000 / 40,000 / 400,000 (short / medium / long; see POOLS)
 *   seeds           200 shared seeds per cell (`pairedFightSeeds(200, SEED_BASE)`)
 *   fight limits    maxSeconds 900, maxBlows 6000, so a supported kill is observable
 *   character       level-45 max profile with the real Firmament tree and enchant plan (`realBuildStages`)
 *   condition       'minted' (the game's own pool: 1600 x material/4) unless a cell names explicit points
 *
 * Exclusions, because the engine refuses or does not model them (see the report):
 *   bows, guns, Pistolet pairs and fists (simulateFight refuses), relay fights (relay CWS is not modelled), and
 *   equipmentDamageEnhanced (the enhanced wear regime is not modelled). What-if spell-power imprints are not used as
 *   a ranking tool: the optimizer's selected imprint here is a flow power, not a spell-power one.
 *
 * Usage:  npm run benchmark                          # write docs/benchmark/* and docs/charts/*.svg
 *         node tools/benchmark-loadouts.mjs --check   # also assert determinism, immutability and artifact agreement
 *         node tools/benchmark-loadouts.mjs --charts-only   # redraw charts/tables from the committed results.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { MATERIALS, WEAPONS } from '../src/data.js';
import { IMPRINT_FAMILIES } from '../src/imprints.js';
import { realBuildStages, realWeaponLoadouts } from '../src/realBuild.js';
import { referenceFoe } from '../src/model.js';
import { pairedFightSeeds, simulateFights } from '../src/simulateFight.js';
import { barChart, lineChart } from '../src/graph.js';
import { mintCondition } from '../vendor/upstream/a3eb1605/src/systems/item/itemTemplates.js';
import { THEORY_LEVEL } from '../src/theory.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CHART_DIR = path.join(ROOT, 'docs', 'charts');
const DATA_DIR = path.join(ROOT, 'docs', 'benchmark');

export const BENCHMARK = Object.freeze({
  schema: 'dfo-dps-benchmark/1',
  level: THEORY_LEVEL,
  targetPreset: 'tough',
  seeds: 200,
  seedBase: 20261117,
  core: 'overhaul',
  stacks: 5,
  maxSeconds: 900,
  maxBlows: 6000,
});

export const POOLS = Object.freeze([
  { id: 'short', health: 8000, label: '8k', why: 'two to four swings: opening burst and the first exchange' },
  { id: 'medium', health: 40000, label: '40k', why: 'ten to thirty swings: the shape of a normal encounter' },
  { id: 'long', health: 400000, label: '400k', why: 'over a hundred swings: sustained, where the minted condition pool binds' },
]);

/** The condition sweep's declared points (the game's minted pool is the fourth, `minted`). */
export const CONDITION_POINTS = Object.freeze([4000, 1600, 800]);

/** Every simulateFights option this harness may pass. An unknown key is a bug, not a silent default (audit D4). */
const SCENARIO_KEYS = Object.freeze(new Set([
  'target', 'health', 'durability', 'imprints', 'seeds', 'core', 'rri', 'stacks', 'passiveOn', 'maxSeconds', 'maxBlows',
]));

/** Reject an unknown option or a non-boolean durability instead of letting the engine ignore it. */
export function assertScenario(opts) {
  for (const key of Object.keys(opts)) {
    if (!SCENARIO_KEYS.has(key)) throw new Error(`benchmark: unknown scenario option '${key}'`);
  }
  if ('durability' in opts && typeof opts.durability !== 'boolean') {
    throw new Error('benchmark: durability must be a boolean');
  }
  if (!(opts.health > 0)) throw new Error('benchmark: health must be positive');
  return opts;
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const round = (v, n = 4) => (Number.isFinite(v) ? Number(v.toFixed(n)) : null);
const target = () => referenceFoe(BENCHMARK.level, BENCHMARK.targetPreset);

/** The seed list every cell shares (the paired form: same seeds for every build). */
export const SEEDS = Object.freeze(pairedFightSeeds(BENCHMARK.seeds, BENCHMARK.seedBase));

const FAMILY = Object.freeze(Object.fromEntries(IMPRINT_FAMILIES.map((f) => [f.key, f])));

/**
 * The benchmark's loadout universe: every melee row the `loadout` command produces. Bow, gun, Pistolet and fist rows
 * are recorded as exclusions because `simulateFight` refuses them (the schedule has no analytical cadence for them).
 */
export function loadoutUniverse() {
  const all = realWeaponLoadouts({ modes: ['uncapped'] });
  const excluded = all
    .filter((r) => r.family === 'Archery' || r.category === 'Fists')
    .map((r) => ({ family: r.family, weapon: r.weapon, category: r.category, why: 'simulateFight refuses bow/gun/fist scheduling' }));
  const rows = all
    .filter((r) => r.family !== 'Archery' && r.category !== 'Fists')
    .map((r) => ({
      id: `${r.key}-${r.template}-${r.category.toLowerCase()}`,
      key: r.key, family: r.family, category: r.category, template: r.template, weapon: r.weapon,
      dual: r.category === 'DW', cardDps: round(r.totalDps), cardTreeDps: round(r.treeDps), cardEnchDps: round(r.enchDps),
      imprintName: r.imprintPower,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { rows, excluded };
}

/**
 * Put the declared condition on every copy of the weapon (the hand item and the equip-table clone).
 *
 * `minted` leaves the piece without a condition, so the game's own `mintCondition` sets its pool (1600 x material
 * multiplier / 4) on the first wear: a FRESH weapon. A number is a weapon WORN DOWN to that many points OF THE GAME'S
 * POOL (`mintCondition` supplies the maximum, then `currentCondition` is the declared points), not a small maximum -
 * a 800-point maximum would read as 100% and defeat the point.
 */
export function applyCondition(ch, templateIndex, condition) {
  const items = [ch.weapon, ch.offWeapon, ...(ch.worn ?? [])]
    .filter((it) => it && Number(it.templateIndex) === Number(templateIndex));
  if (!items.length) throw new Error(`benchmark: no item carries template ${templateIndex}`);
  const points = condition === 'minted' ? null : Number(condition);
  if (points != null && !(points > 0)) throw new Error(`benchmark: bad condition ${condition}`);
  for (const it of items) {
    delete it.maxCondition;
    delete it.currentCondition;
    if (points != null) {
      mintCondition(it); // the game's pool for this template and material
      it.currentCondition = Math.min(points, it.maxCondition);
    }
  }
  return { items: items.length, maxCondition: items[0].maxCondition ?? null, currentCondition: items[0].currentCondition ?? null };
}

/** The production loadout chain for one row, with the benchmark's declared condition. */
export function loadoutCharacter(row, condition = 'minted') {
  const stages = realBuildStages(row.template, FAMILY[row.key], { dual: row.dual });
  const ch = clone(stages.enchCh);
  applyCondition(ch, row.template, condition);
  return { ...stages, ch };
}

/** The scenario one cell runs. */
function scenarioFor(health, durability, imprint) {
  return assertScenario({
    target: target(),
    health,
    durability,
    imprints: imprint ? [imprint] : [],
    seeds: SEEDS,
    core: BENCHMARK.core,
    rri: true,
    stacks: BENCHMARK.stacks,
    passiveOn: true,
    maxSeconds: BENCHMARK.maxSeconds,
    maxBlows: BENCHMARK.maxBlows,
  });
}

/** The reported metrics of one cell. `meanDps` covers every trial (censored ones at their own run time). */
export function cellMetrics(res) {
  if (!res) return null;
  const out = res.outputDps;
  return {
    trials: res.trials,
    kills: res.kills,
    killProbability: round(res.killProbability?.p),
    killProbabilityCi95: res.killProbability ? [round(res.killProbability.lo), round(res.killProbability.hi)] : null,
    outcomes: res.outcomes,
    meanDps: round(out?.mean),
    medianDps: round(out?.median),
    sdDps: round(out?.sd),
    ci95Dps: round(out?.ci95),
    p10Dps: round(out?.p10),
    p90Dps: round(out?.p90),
    meanDamage: round(res.damageDealt?.mean),
    medianDamage: round(res.damageDealt?.median),
    meanTtk: round(res.ttk?.mean),
    medianTtk: round(res.ttk?.median),
    meanKillDps: round(res.killDps?.mean),
    medianKillDps: round(res.killDps?.median),
    meanBlows: round(res.blows?.mean),
    meanOverkill: round(res.overkill?.mean),
    durabilityStats: res.durability ? {
      breakProbability: round(res.durability.breakProbability.p),
      breakProbabilityCi95: [round(res.durability.breakProbability.lo), round(res.durability.breakProbability.hi)],
      fightsWithBreak: res.durability.fightsWithBreak,
      timeToFirstBreakMedian: round(res.durability.timeToFirstBreak?.median),
      timeToFirstBreakMean: round(res.durability.timeToFirstBreak?.mean),
      timeAtRiskMedian: round(res.durability.timeAtRiskWithoutBreak?.median),
      weaponsBrokenMean: round(res.durability.weaponsBroken.mean),
      breakEvents: res.durability.breakEvents,
      noWeaponLeft: res.durability.noWeaponLeft,
      endConditionMainPctMedian: round(res.durability.endCondition.main.pct?.median),
      endConditionMainRawMedian: round(res.durability.endCondition.main.raw?.median),
    } : null,
  };
}

/** Mean DPS of a seed slice, read from the cell's own rows (no extra simulation). */
function sliceMean(rows, from, to) {
  const xs = rows.slice(from, to);
  return xs.reduce((s, r) => s + (Number.isFinite(r.outputDps) ? r.outputDps : 0), 0) / Math.max(1, xs.length);
}

/** Run one loadout/pool/durability cell, asserting the character is not mutated. */
function runCell(row, health, durability, condition = 'minted') {
  const st = loadoutCharacter(row, condition);
  const before = JSON.stringify(st.ch);
  const res = simulateFights(st.ch, scenarioFor(health, durability, st.imprint?.power ?? null));
  if (JSON.stringify(st.ch) !== before) throw new Error(`benchmark: ${row.id} mutated its own character`);
  if (!res) throw new Error(`benchmark: ${row.id} produced no schedule`);
  return { res, st };
}

/** The best row per family and hold configuration, by the optimizer's card DPS. */
function bestByArchetype(rows) {
  const out = {};
  for (const row of rows) {
    const slot = out[row.family] ?? (out[row.family] = {});
    if (!slot[row.category] || row.cardDps > slot[row.category].cardDps) slot[row.category] = row;
  }
  return out;
}

/** Spearman rank correlation of two id->value maps (ties averaged). */
export function spearman(a, b) {
  const ids = Object.keys(a).filter((id) => a[id] != null && b[id] != null);
  const rank = (map) => {
    const sorted = ids.slice().sort((x, y) => map[x] - map[y]);
    const r = {};
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && map[sorted[j + 1]] === map[sorted[i]]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[sorted[k]] = avg;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a), rb = rank(b);
  const n = ids.length;
  const mean = (n + 1) / 2;
  let num = 0, da = 0, db = 0;
  for (const id of ids) {
    const x = ra[id] - mean, y = rb[id] - mean;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? round(num / Math.sqrt(da * db)) : null;
}

/** Whole benchmark. Pure: reads the production modules, writes nothing. */
export function computeBenchmark() {
  const { rows, excluded } = loadoutUniverse();
  const definitions = [];
  const cells = [];
  const series = new Map();

  for (const row of rows) {
    const st = loadoutCharacter(row);
    const w = st.ch.weapon;
    definitions.push({
      id: row.id, family: row.family, familyKey: row.key, category: row.category, dual: row.dual,
      template: row.template, weapon: row.weapon,
      derivation: `realBuildStages(template=${row.template}, family='${row.key}', mode='uncapped', dual=${row.dual})`,
      weaponItem: { name: w.name, templateIndex: w.templateIndex, material: w.material, materialName: MATERIALS[w.material],
        equipSlot: w.equipSlot, affixes: w.affixes, sockets: w.sockets, enchantments: w.enchantments },
      offHandItem: st.ch.offWeapon ? { name: st.ch.offWeapon.name, templateIndex: st.ch.offWeapon.templateIndex,
        material: st.ch.offWeapon.material, materialName: MATERIALS[st.ch.offWeapon.material],
        enchantments: st.ch.offWeapon.enchantments } : null,
      firmament: { build: st.tree.build?.name ?? null, stars: st.tree.stars, freeStars: st.tree.freeStars,
        blowPct: round(st.ch.firmamentDamagePct) },
      enchantPlanRows: st.enchPlan.rows.map((r) => ({ slot: r.slot, item: r.item,
        effects: r.effects.map((e) => ({ type: e.type, param: e.param ?? null, name: e.name, paramName: e.paramName ?? null })) })),
      imprint: st.imprint ? { name: st.imprint.name, power: st.imprint.power.name, kind: st.imprint.power.kind,
        how: 'what-if addition through analyze/simulateFight `imprints` (the pricing path realTemplate uses)' } : null,
      character: { level: st.ch.level, raceId: st.ch.raceId, stats: st.ch.stats, career: st.ch.career,
        martialPath: st.ch.martialPath ?? null, masteredSkills: st.ch.masteredSkills ?? [],
        modSkills: st.ch._mods?.skills ?? {} },
      cardDps: row.cardDps,
    });
    for (const pool of POOLS) {
      for (const durability of [false, true]) {
        const { res } = runCell(row, pool.health, durability);
        const id = `${row.id}|${pool.id}|${durability ? 'on' : 'off'}`;
        series.set(id, res);
        cells.push({ loadout: row.id, pool: pool.id, health: pool.health, durability, condition: durability ? 'minted' : null,
          ...cellMetrics(res) });
      }
    }
  }

  const byKey = new Map(cells.map((c) => [`${c.loadout}|${c.pool}|${c.durability ? 'on' : 'off'}`, c]));
  const mediumOff = rows.map((r) => byKey.get(`${r.id}|medium|off`));
  const ranked = rows.slice().sort((a, b) => byKey.get(`${b.id}|medium|off`).meanDps - byKey.get(`${a.id}|medium|off`).meanDps);
  const rankOf = {};
  ranked.forEach((r, i) => { rankOf[r.id] = i + 1; });

  // 1-3. leaderboard, ranks per pool, health curves
  const leaderboard = ranked.map((r, i) => ({
    rank: i + 1, id: r.id, family: r.family, category: r.category, weapon: r.weapon,
    imprint: r.imprintName, ...pick(byKey.get(`${r.id}|medium|off`),
      ['trials', 'kills', 'killProbability', 'meanDps', 'medianDps', 'ci95Dps', 'sdDps', 'meanTtk', 'medianTtk',
        'meanKillDps', 'meanDamage', 'meanBlows', 'p10Dps', 'p90Dps']),
  }));
  const ranksByPool = {};
  for (const pool of POOLS) {
    const order = rows.slice().sort((a, b) => byKey.get(`${b.id}|${pool.id}|off`).meanDps - byKey.get(`${a.id}|${pool.id}|off`).meanDps);
    order.forEach((r, i) => { (ranksByPool[r.id] ??= {})[pool.id] = i + 1; });
  }
  const top = ranked.slice(0, 8);
  const healthCurve = top.map((r) => ({
    id: r.id, family: r.family, category: r.category, weapon: r.weapon,
    points: POOLS.map((p) => {
      const c = byKey.get(`${r.id}|${p.id}|off`);
      return { pool: p.id, health: p.health, meanDps: c.meanDps, medianTtk: c.medianTtk, meanTtk: c.meanTtk,
        killProbability: c.killProbability };
    }),
    ranks: ranksByPool[r.id],
  }));
  const rankCorrelation = {
    shortVsLong: spearman(
      Object.fromEntries(rows.map((r) => [r.id, byKey.get(`${r.id}|short|off`).meanDps])),
      Object.fromEntries(rows.map((r) => [r.id, byKey.get(`${r.id}|long|off`).meanDps])),
    ),
    mediumVsLong: spearman(
      Object.fromEntries(rows.map((r) => [r.id, byKey.get(`${r.id}|medium|off`).meanDps])),
      Object.fromEntries(rows.map((r) => [r.id, byKey.get(`${r.id}|long|off`).meanDps])),
    ),
  };

  // 4. archetypes: best card row per family and hold, measured at the medium pool
  const archetypes = {};
  for (const [family, holds] of Object.entries(bestByArchetype(rows))) {
    archetypes[family] = {};
    for (const [hold, row] of Object.entries(holds)) {
      const c = byKey.get(`${row.id}|medium|off`);
      archetypes[family][hold] = { id: row.id, weapon: row.weapon, meanDps: c.meanDps, medianTtk: c.medianTtk, meanTtk: c.meanTtk };
    }
  }

  // 5. the optimizer chain: gear -> tree -> enchants -> imprint, each family's best one-handed row
  const stages = [];
  for (const [family, holds] of Object.entries(bestByArchetype(rows))) {
    const row = holds['1H'];
    if (!row) continue;
    const st = loadoutCharacter(row);
    const base = scenarioFor(POOLS[1].health, false, null);
    const step = (id, ch, imprint = null) => {
      const before = JSON.stringify(ch);
      const res = simulateFights(ch, { ...base, imprints: imprint ? [imprint] : [] });
      if (JSON.stringify(ch) !== before) throw new Error(`benchmark: stage ${id} mutated its character`);
      return { id, meanDps: round(res.outputDps.mean), medianTtk: round(res.ttk?.median), meanDamage: round(res.damageDealt.mean) };
    };
    stages.push({
      family, base: row.id, weapon: row.weapon, imprint: st.imprint?.power?.name ?? null,
      stages: [
        step(`${row.id}/gear`, st.gearCh),
        step(`${row.id}/tree`, st.treeCh),
        step(`${row.id}/enchants`, st.enchCh),
        step(`${row.id}/imprint`, st.enchCh, st.imprint?.power ?? null),
      ],
    });
  }

  // 6. material variants: the same enchanted build, only the weapon's material changes
  const materials = [];
  for (const template of [121, 123]) {
    const row = rows.find((r) => r.template === template);
    if (!row) continue;
    for (let m = 0; m < MATERIALS.length; m++) {
      const st = loadoutCharacter(row);
      const ch = st.ch;
      for (const it of [ch.weapon, ch.offWeapon, ...(ch.worn ?? [])].filter(Boolean)) {
        if (Number(it.templateIndex) === template) it.material = m;
      }
      const before = JSON.stringify(ch);
      const res = simulateFights(ch, scenarioFor(POOLS[1].health, false, st.imprint?.power ?? null));
      if (JSON.stringify(ch) !== before) throw new Error('benchmark: material sweep mutated its character');
      materials.push({ template, weapon: WEAPONS[template].name, material: m, materialName: MATERIALS[m],
        dual: false, meanDps: round(res.outputDps.mean), medianTtk: round(res.ttk?.median),
        meanDamage: round(res.damageDealt.mean) });
    }
  }

  // 7. durability: the long pool, plus a declared condition sweep on the three best medium-pool builds
  const durability = {
    pool: POOLS[2].id,
    byLoadout: ranked.map((r) => {
      const off = byKey.get(`${r.id}|long|off`);
      const on = byKey.get(`${r.id}|long|on`);
      return { id: r.id, family: r.family, category: r.category, weapon: r.weapon,
        dpsOff: off.meanDps, dpsOn: on.meanDps, killOff: off.killProbability, killOn: on.killProbability,
        ttkOffMedian: off.medianTtk, ttkOnMedian: on.medianTtk,
        breakProbability: on.durabilityStats?.breakProbability,
        timeToFirstBreakMedian: on.durabilityStats?.timeToFirstBreakMedian,
        endConditionMainPctMedian: on.durabilityStats?.endConditionMainPctMedian,
        weaponsBrokenMean: on.durabilityStats?.weaponsBrokenMean, outcomesOn: on.outcomes };
    }),
    conditions: [],
  };
  for (const r of ranked.slice(0, 3)) {
    for (const condition of ['minted', ...CONDITION_POINTS]) {
      const { res } = runCell(r, POOLS[2].health, true, condition);
      const c = cellMetrics(res);
      durability.conditions.push({ id: r.id, family: r.family, category: r.category, weapon: r.weapon,
        condition, conditionPoints: condition === 'minted' ? null : condition,
        ...pick(c, ['killProbability', 'meanDps', 'medianTtk', 'meanDamage', 'meanBlows']),
        breakProbability: c.durabilityStats?.breakProbability,
        timeToFirstBreakMedian: c.durabilityStats?.timeToFirstBreakMedian,
        endConditionMainPctMedian: c.durabilityStats?.endConditionMainPctMedian,
        outcomes: c.outcomes });
    }
  }

  // 8. seed stability: four disjoint blocks of the shared seed list, ranked inside each block
  const blocks = 4;
  const per = Math.floor(BENCHMARK.seeds / blocks);
  const stability = {
    blocks: Array.from({ length: blocks }, (_, b) => ({
      index: b, seedsFrom: b * per, seedsTo: (b + 1) * per,
      label: `${b * per + 1}-${(b + 1) * per}`,
    })),
    builds: top.map((r) => {
      const res = byKey.get(`${r.id}|medium|off`);
      const rowsOf = series.get(`${r.id}|medium|off`).rows;
      const points = Array.from({ length: blocks }, (_, b) => ({ block: b, meanDps: round(sliceMean(rowsOf, b * per, (b + 1) * per)) }));
      return { id: r.id, family: r.family, category: r.category, weapon: r.weapon, points };
    }),
  };
  for (const b of stability.blocks) {
    const order = stability.builds.slice().sort((x, y) => y.points[b.index].meanDps - x.points[b.index].meanDps);
    order.forEach((x, i) => { x.points[b.index].rank = i + 1; });
  }

  const method = {
    head: null,
    upstream: 'a3eb1605ea1dc391b691fe314377458a7e63e483',
    level: BENCHMARK.level,
    target: { preset: BENCHMARK.targetPreset, level: BENCHMARK.level, note: 'referenceFoe(45, tough); the health pool is the scenario `health`' },
    seeds: { count: BENCHMARK.seeds, base: BENCHMARK.seedBase, policy: 'pairedFightSeeds: one shared list for every build and cell' },
    pools: POOLS,
    options: { core: BENCHMARK.core, rri: true, stacks: BENCHMARK.stacks, passiveOn: true,
      maxSeconds: BENCHMARK.maxSeconds, maxBlows: BENCHMARK.maxBlows },
    durability: { default: 'off', onCondition: 'minted (1600 x material multiplier / 4)', sweep: CONDITION_POINTS },
    metrics: {
      meanDps: 'mean of outputDps over ALL trials (a censored trial at the time it actually ran)',
      medianDps: 'median of the same field',
      meanTtk: 'mean time to kill over KILLS ONLY (null when nothing killed)',
      killProbability: 'share of trials that killed inside maxSeconds, Wilson 95% interval',
      meanDamage: 'mean damage dealt per trial (includes overkill)',
    },
    exclusions: excluded,
    notes: [
      'Fight DPS is a local seeded sample of the Stage 3.1 fight tier: not an event-level reproduction of the game RNG.',
      'Cast When Strikes direct damage is simulated per blow; the card metric still prices CWS as expected damage.',
      'Flow is a constant stack scenario (stacks: 5), not a charge clock, in ordinary fights.',
      'Dual blades use the exchange\'s averaged held burden before a break (documented drift of a fraction of a tick).',
      'Target shield/armour wear, fists after a break and relay durability are not modelled.',
    ],
  };

  const payload = {
    schema: BENCHMARK.schema, method, loadouts: definitions,
    cells: cells.slice().sort((a, b) => a.loadout.localeCompare(b.loadout) || a.pool.localeCompare(b.pool) || Number(a.durability) - Number(b.durability)),
    leaderboard, ranksByPool, healthCurve, rankCorrelation, archetypes, stages, materials, durability, stability,
  };
  return { ...payload, digest: digestOf(payload) };
}

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] ?? null]));

function digestOf(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ---------------------------------------------------------------------------------------------------------------
// Output: charts, tables, machine-readable data
// ---------------------------------------------------------------------------------------------------------------

const short = (x) => `${x.category} ${x.weapon}`;

export function charts(b) {
  const out = new Map();
  const top15 = b.leaderboard.slice(0, 15);
  out.set('01-dps-leaderboard.svg', barChart({
    title: `Mean fight DPS at ${POOLS[1].health.toLocaleString('en-US')} HP (${BENCHMARK.seeds} seeds, durability off)`,
    labels: top15.map(short),
    series: [{ name: 'Mean DPS', values: top15.map((r) => r.meanDps) }],
    width: 920,
  }));

  const families = Object.keys(b.archetypes).sort();
  out.set('02-archetypes.svg', barChart({
    title: `Best loadout per family and hold (mean DPS, ${POOLS[1].label} HP; no bar = hold unavailable)`,
    labels: families,
    series: ['1H', '2H', 'DW'].map((hold) => ({
      name: hold,
      values: families.map((f) => b.archetypes[f][hold]?.meanDps ?? 0),
    })),
    width: 920,
  }));

  const pools = POOLS;
  out.set('03-dps-vs-health.svg', lineChart({
    title: 'Mean fight DPS against the target health pool',
    xLabel: 'target health (durability off)',
    yLabel: 'mean DPS',
    xTicks: pools.map((p) => ({ x: p.health, label: p.label })),
    series: b.healthCurve.map((h) => ({
      name: short(h),
      points: h.points.map((p) => ({ x: p.health, y: p.meanDps })),
    })),
  }));
  out.set('03b-ttk-vs-health.svg', lineChart({
    title: 'Median time to kill against the target health pool',
    xLabel: 'target health (durability off)',
    yLabel: 'median TTK (s)',
    xTicks: pools.map((p) => ({ x: p.health, label: p.label })),
    series: b.healthCurve.filter((h) => h.points.every((p) => p.medianTtk != null)).map((h) => ({
      name: short(h),
      points: h.points.map((p) => ({ x: p.health, y: p.medianTtk })),
    })),
  }));

  out.set('04-enchant-contribution.svg', barChart({
    title: `The optimizer chain: gear -> tree -> enchants -> imprint (mean DPS, ${POOLS[1].label} HP)`,
    labels: b.stages.map((s) => s.family),
    series: ['gear', 'tree', 'enchants', 'imprint'].map((stage, i) => ({
      name: ['Gear only', '+ Firmament tree', '+ Enchants', '+ Imprint'][i],
      values: b.stages.map((s) => s.stages[i].meanDps),
    })),
    width: 920,
  }));

  out.set('02b-material.svg', lineChart({
    title: 'Weapon material sensitivity (same build, only the material changes)',
    xLabel: 'material',
    yLabel: `mean DPS at ${POOLS[1].label} HP`,
    xTicks: MATERIALS.map((name, m) => ({ x: m, label: name })),
    series: [121, 123].map((t) => ({
      name: WEAPONS[t].name,
      points: b.materials.filter((m) => m.template === t).map((m) => ({ x: m.material, y: m.meanDps })),
    })),
  }));

  const durTop = b.durability.byLoadout.slice(0, 12);
  out.set('05-durability-dps.svg', barChart({
    title: `Durability on/off at ${POOLS[2].health.toLocaleString('en-US')} HP (minted condition)`,
    labels: durTop.map((d) => short(d)),
    series: [
      { name: 'Durability off', values: durTop.map((d) => d.dpsOff) },
      { name: 'Durability on', values: durTop.map((d) => d.dpsOn) },
    ],
    width: 920,
  }));

  const conds = ['minted', ...CONDITION_POINTS];
  out.set('05b-break-probability.svg', barChart({
    title: `Break probability by starting condition (${POOLS[2].label} HP, durability on)`,
    labels: [...new Set(b.durability.conditions.map((c) => short(c)))],
    series: conds.map((c) => ({
      name: c === 'minted' ? 'minted' : `${c} pts`,
      values: [...new Set(b.durability.conditions.map((x) => x.id))].map((id) => {
        const row = b.durability.conditions.find((x) => x.id === id && x.condition === c);
        return (row?.breakProbability ?? 0) * 100;
      }),
    })),
    unit: '%',
    width: 920,
  }));

  const lifetime = [...new Set(b.durability.conditions.map((c) => c.id))].map((id) => ({
    id,
    name: short(b.durability.conditions.find((c) => c.id === id)),
    points: b.durability.conditions.filter((c) => c.id === id && c.timeToFirstBreakMedian != null)
      .map((c) => ({ x: c.condition === 'minted' ? 12800 : c.conditionPoints, y: c.timeToFirstBreakMedian })),
  }));
  out.set('05c-weapon-lifetime.svg', lineChart({
    title: `Median time to first break against starting condition (${POOLS[2].label} HP, durability on)`,
    xLabel: 'starting condition (points of the minted pool)',
    yLabel: 'median first break (s)',
    xTicks: [{ x: 12800, label: 'minted' }, ...CONDITION_POINTS.map((v) => ({ x: v, label: String(v) }))],
    series: lifetime,
  }));

  out.set('06-seed-stability.svg', lineChart({
    title: `Mean DPS by disjoint seed block (${POOLS[1].label} HP, durability off)`,
    xLabel: 'seed block (50 seeds each)',
    yLabel: 'mean DPS',
    xTicks: b.stability.blocks.map((b2) => ({ x: b2.index, label: b2.label })),
    series: b.stability.builds.map((s) => ({
      name: short(s),
      points: s.points.map((p) => ({ x: p.block, y: p.meanDps })),
    })),
  }));

  const maxRank = Math.max(...b.healthCurve.flatMap((h) => pools.map((p) => h.ranks[p.id])));
  out.set('06b-rank-vs-health.svg', lineChart({
    title: `Rank against target health (top 8 at ${POOLS[1].label}; 1 = best)`,
    xLabel: 'target health',
    yLabel: 'rank',
    invertY: true,
    xTicks: pools.map((p) => ({ x: p.health, label: p.label })),
    yTicks: [...new Set([1, ...[...Array(Math.ceil(maxRank / 5)).keys()].map((i) => 1 + (i + 1) * 5).filter((v) => v <= maxRank), maxRank])].sort((a, b) => a - b).map((v) => ({ y: v, label: String(v) })),
    series: b.healthCurve.map((h) => ({
      name: short(h),
      points: pools.map((p) => ({ x: p.health, y: h.ranks[p.id] })),
    })),
  }));
  return out;
}

const cell2 = (v) => (v == null ? '' : v);

function tables(b) {
  const L = [];
  L.push('# Benchmark results (generated)');
  L.push('');
  L.push('Generated by `npm run benchmark` (`tools/benchmark-loadouts.mjs`). Do not edit by hand: the');
  L.push('method and interpretation are in `docs/LOADOUT-BENCHMARK.md`.');
  L.push('');
  L.push(`Digest: \`${b.digest}\``);
  L.push('');
  L.push(`## Leaderboard - ${POOLS[1].health.toLocaleString('en-US')} HP, durability off`);
  L.push('');
  L.push('| # | Loadout | Imprint | Mean DPS | 95% CI | Median DPS | Median TTK (s) | Kill % | Mean damage | Blows |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of b.leaderboard) {
    L.push(`| ${r.rank} | ${r.family} · ${r.category} · ${r.weapon} | ${r.imprint ?? '-'} | ${r.meanDps} | ±${r.ci95Dps ?? '-'} | ${r.medianDps} | ${r.medianTtk ?? '-'} | ${(r.killProbability * 100).toFixed(1)} | ${r.meanDamage} | ${r.meanBlows} |`);
  }
  L.push('');
  L.push('## Ranks by target health (durability off)');
  L.push('');
  L.push(`| # | Loadout | ${POOLS.map((p) => p.label).join(' | ')} |`);
  L.push('|---|---|---|---|---|');
  const order = b.leaderboard.map((r) => r.id);
  order.forEach((id, i) => {
    const r = b.leaderboard[i];
    L.push(`| ${i + 1} | ${r.family} · ${r.category} · ${r.weapon} | ${b.ranksByPool[id].short} | ${b.ranksByPool[id].medium} | ${b.ranksByPool[id].long} |`);
  });
  L.push('');
  L.push(`Spearman rank correlation: short vs long **${b.rankCorrelation.shortVsLong}**, medium vs long **${b.rankCorrelation.mediumVsLong}**.`);
  L.push('');
  L.push(`## Optimizer chain (best one-handed row per family, ${POOLS[1].label} HP)`);
  L.push('');
  L.push('| Family | Loadout | Gear only | + Tree | + Enchants | + Imprint | Imprint |');
  L.push('|---|---|---|---|---|---|---|');
  for (const s of b.stages) {
    L.push(`| ${s.family} | ${s.weapon} | ${s.stages[0].meanDps} | ${s.stages[1].meanDps} | ${s.stages[2].meanDps} | ${s.stages[3].meanDps} | ${s.imprint ?? '-'} |`);
  }
  L.push('');
  L.push(`## Material variants (same build, ${POOLS[1].label} HP)`);
  L.push('');
  L.push('| Weapon | Material | Mean DPS | Median TTK (s) | Mean damage |');
  L.push('|---|---|---|---|---|');
  for (const m of b.materials) L.push(`| ${m.weapon} | ${m.materialName} | ${m.meanDps} | ${m.medianTtk ?? '-'} | ${m.meanDamage} |`);
  L.push('');
  L.push(`## Durability at ${POOLS[2].health.toLocaleString('en-US')} HP (minted condition)`);
  L.push('');
  L.push('| Loadout | DPS off | DPS on | Kill % off | Kill % on | Break % | Median first break (s) | Median end condition % |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const d of b.durability.byLoadout) {
    L.push(`| ${d.family} · ${d.category} · ${d.weapon} | ${d.dpsOff} | ${d.dpsOn} | ${(d.killOff * 100).toFixed(1)} | ${(d.killOn * 100).toFixed(1)} | ${(d.breakProbability * 100).toFixed(1)} | ${d.timeToFirstBreakMedian ?? '-'} | ${d.endConditionMainPctMedian ?? '-'} |`);
  }
  L.push('');
  L.push(`## Condition sweep (top 3 at ${POOLS[1].label}, ${POOLS[2].label} HP, durability on)`);
  L.push('');
  L.push('| Loadout | Start condition | Kill % | Mean DPS | Break % | Median first break (s) | Median end condition % |');
  L.push('|---|---|---|---|---|---|---|');
  for (const c of b.durability.conditions) {
    L.push(`| ${c.family} · ${c.category} · ${c.weapon} | ${c.condition} | ${(c.killProbability * 100).toFixed(1)} | ${c.meanDps} | ${(c.breakProbability * 100).toFixed(1)} | ${c.timeToFirstBreakMedian ?? '-'} | ${c.endConditionMainPctMedian ?? '-'} |`);
  }
  L.push('');
  L.push(`## Seed-block stability (${POOLS[1].label} HP, durability off)`);
  L.push('');
  L.push(`| Loadout | ${b.stability.blocks.map((x) => x.label).join(' | ')} | Rank range |`);
  L.push(`|---|${b.stability.blocks.map(() => '---').join('|')}|---|`);
  for (const s of b.stability.builds) {
    const ranks = s.points.map((p) => p.rank);
    L.push(`| ${short(s)} | ${s.points.map((p) => p.meanDps).join(' | ')} | ${Math.min(...ranks)}-${Math.max(...ranks)} |`);
  }
  L.push('');
  return L.join('\n');
}

function csv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(typeof c === 'function' ? c(r) : r[c])).join(','))].join('\n') + '\n';
}

/** Write every artifact. Returns the list of paths. */
export function writeBenchmark(b, { root = ROOT } = {}) {
  const chartDir = path.join(root, 'docs', 'charts');
  const dataDir = path.join(root, 'docs', 'benchmark');
  fs.mkdirSync(chartDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const written = [];
  for (const [name, svg] of charts(b)) {
    const p = path.join(chartDir, name);
    fs.writeFileSync(p, `${svg}\n`, 'utf8');
    written.push(path.relative(root, p));
  }
  fs.writeFileSync(path.join(dataDir, 'results.json'), `${JSON.stringify(b, null, 2)}\n`, 'utf8');
  written.push('docs/benchmark/results.json');

  fs.writeFileSync(path.join(dataDir, 'loadouts.csv'), csv(
    b.cells.map((c) => ({
      ...c, outcomes: JSON.stringify(c.outcomes), durabilityStats: c.durabilityStats ? JSON.stringify(c.durabilityStats) : '',
      durability: c.durability ? 'on' : 'off',
    })),
    ['loadout', 'pool', 'health', 'durability', 'condition', 'trials', 'kills', 'killProbability', 'meanDps', 'medianDps',
      'ci95Dps', 'sdDps', 'p10Dps', 'p90Dps', 'meanDamage', 'medianDamage', 'meanTtk', 'medianTtk', 'meanKillDps',
      'medianKillDps', 'meanBlows', 'meanOverkill', 'outcomes', 'durabilityStats'],
  ), 'utf8');
  written.push('docs/benchmark/loadouts.csv');

  fs.writeFileSync(path.join(dataDir, 'materials.csv'), csv(b.materials,
    ['template', 'weapon', 'material', 'materialName', 'dual', 'meanDps', 'medianTtk', 'meanDamage']), 'utf8');
  written.push('docs/benchmark/materials.csv');

  fs.writeFileSync(path.join(dataDir, 'stages.csv'), csv(
    b.stages.flatMap((s) => s.stages.map((x, i) => ({ family: s.family, loadout: s.base, weapon: s.weapon, stage: x.id.split('/').pop(),
      order: i, meanDps: x.meanDps, medianTtk: x.medianTtk, meanDamage: x.meanDamage }))),
    ['family', 'loadout', 'weapon', 'stage', 'order', 'meanDps', 'medianTtk', 'meanDamage'],
  ), 'utf8');
  written.push('docs/benchmark/stages.csv');

  fs.writeFileSync(path.join(dataDir, 'durability.csv'), csv(
    [...b.durability.byLoadout.map((d) => ({ kind: 'loadout', ...d, outcomesOn: JSON.stringify(d.outcomesOn) })),
      ...b.durability.conditions.map((c) => ({ kind: 'condition-sweep', ...c, outcomes: JSON.stringify(c.outcomes) }))],
    ['kind', 'id', 'family', 'category', 'weapon', 'dpsOff', 'dpsOn', 'killOff', 'killOn', 'ttkOffMedian', 'ttkOnMedian',
      'breakProbability', 'timeToFirstBreakMedian', 'endConditionMainPctMedian', 'weaponsBrokenMean', 'outcomesOn',
      'condition', 'conditionPoints', 'killProbability', 'meanDps', 'medianTtk', 'meanDamage', 'meanBlows', 'outcomes'],
  ), 'utf8');
  written.push('docs/benchmark/durability.csv');

  fs.writeFileSync(path.join(dataDir, 'RESULTS.md'), `${tables(b)}\n`, 'utf8');
  written.push('docs/benchmark/RESULTS.md');
  return written;
}

/**
 * Read the written artifacts back: the JSON digest must match its own payload, the leaderboard chart must carry the
 * leaderboard's rounded values, the CSV must have one row per cell, and RESULTS.md must carry the top value.
 */
export function artifactCheck(b, { root = ROOT } = {}) {
  const json = JSON.parse(fs.readFileSync(path.join(root, 'docs/benchmark/results.json'), 'utf8'));
  const { digest, ...payload } = json;
  const svg = fs.readFileSync(path.join(root, 'docs/charts/01-dps-leaderboard.svg'), 'utf8');
  const lines = fs.readFileSync(path.join(root, 'docs/benchmark/loadouts.csv'), 'utf8').trim().split('\n');
  const md = fs.readFileSync(path.join(root, 'docs/benchmark/RESULTS.md'), 'utf8');
  return {
    digestOk: digestOf(payload) === digest && digest === b.digest,
    chartMatchesLeaderboard: b.leaderboard.slice(0, 15).every((r) => svg.includes(`>${r.meanDps.toFixed(0)}<`)),
    csvRowsMatchCells: lines.length - 1 === b.cells.length,
    markdownMatchesLeaderboard: md.includes(String(b.leaderboard[0].meanDps)),
  };
}

/** Determinism/immutability checks for `--check`. */
export function selfCheck(b) {
  const rows = loadoutUniverse().rows;
  const row = rows.find((r) => r.id === b.leaderboard[0].id);
  const st = loadoutCharacter(row);
  const before = JSON.stringify(st.ch);
  const a = simulateFights(st.ch, { ...scenarioFor(POOLS[1].health, false, st.imprint?.power ?? null), seeds: SEEDS.slice(0, 40) });
  const mid = JSON.stringify(st.ch);
  const b2 = simulateFights(st.ch, { ...scenarioFor(POOLS[1].health, false, st.imprint?.power ?? null), seeds: SEEDS.slice(0, 40) });
  const after = JSON.stringify(st.ch);
  const same = (x, y) => JSON.stringify(cellMetrics(x)) === JSON.stringify(cellMetrics(y));
  return {
    repeatedRunIdentical: same(a, b2),
    characterUnchanged: before === mid && mid === after,
    firstCellDigest: createHash('sha256').update(JSON.stringify(cellMetrics(a))).digest('hex'),
  };
}

function main() {
  const check = process.argv.includes('--check');
  const chartsOnly = process.argv.includes('--charts-only');
  const started = process.hrtime.bigint();
  // `--charts-only` redraws from the committed results.json: the same data, no re-simulation (label/layout edits).
  const b = chartsOnly ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'results.json'), 'utf8')) : computeBenchmark();
  const written = writeBenchmark(b);
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  if (check) {
    const checks = selfCheck(b);
    const artifacts = artifactCheck(b);
    console.log(`self-check: repeated run identical=${checks.repeatedRunIdentical} character unchanged=${checks.characterUnchanged}`);
    console.log(`artifacts: digest=${artifacts.digestOk} chart=leaderboard ${artifacts.chartMatchesLeaderboard} csv rows ${artifacts.csvRowsMatchCells} md ${artifacts.markdownMatchesLeaderboard}`);
    if (!checks.repeatedRunIdentical || !checks.characterUnchanged || Object.values(artifacts).some((v) => v !== true)) process.exitCode = 1;
  }
  console.log(`benchmark: ${b.loadouts.length} loadouts, ${b.cells.length} cells, ${BENCHMARK.seeds} seeds/cell in ${seconds.toFixed(1)} s`);
  console.log(`digest: ${b.digest}`);
  console.log(`wrote:\n  ${written.join('\n  ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
