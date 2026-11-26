/*
 * R5d planner vectors: the enchant plan, the real-build chain and the shortlist.
 *
 * Every family compares whole ordered values through the codec (f64 as bits), generated from the REAL JS.
 *
 * SIZING. The JS is slow here: `planEnchants` 37-122 ms and `realWeaponLoadouts` ~2.3 s per call, so the expensive
 * families are sized by wall clock, not by case count. Every cheap family is swept over its whole input domain.
 * Domains below 2,000 and why:
 *   gear     23 weapon templates x 10 shield forms = 230 (the whole domain of gearPieces)
 *   plan     ~150 whole plans (~10 s): the domain is 23 templates x 2 soulGem x 2 forceSkills x 5 groups x 3 repairs x
 *           2 regen x 6 shields = 33,120, each costing ~60 ms, so 2,000 plans would be ~2 minutes and ~40 MB
 *   best     6 families x 2 targets = 12 (the whole domain)
 *   matrix   5 whole matrices (~1.7 s)
 *   stage    2 modes x 3 encounters x 2 vampire x 2 dual x ~7 templates = ~168 stage objects (~15 s)
 *   template ~40 whole rows (~4 s)
 *   loadouts 2 modes x 2 vampire = 4 whole universes (~10 s)
 *   shortlist 2 modes x 4 k values x fixed seed = 8 (~30 s)
 *   line     every effect of every plan (~1,900 lines)
 *   sampled  every loadout row of both universes (~200)
 */
import * as E from '../src/enchantPlan.js';
import * as FB from '../src/realBuild.js';
import * as S from '../src/loadoutShortlist.js';
import { IMPRINT_FAMILIES } from '../src/imprints.js';
import { WEAPONS } from '../src/data.js';
import { enchantmentCost, itemTemplate } from '../src/enchantData.js';
import { DEFAULT_GAME_BUILD, gateTarget, referenceFoe } from '../src/model.js';
import { ENCHANTMENT_TYPES } from '../src/enchants.js';
import { maxCharacter, maxRun } from '../src/maxprofile.js';
import { THEORY_LEVEL } from '../src/theory.js';
import { arena2Dir } from '../src/save.js';
import { readSpellsStd } from '../src/spells.js';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeValue as V } from './rust-codec.mjs';

const templates = Object.keys(WEAPONS).map(Number).filter((k) => WEAPONS[k]);
const shields = [undefined, 'auto', 'none', 109, 110, 111, 112, '0', 120, 'x'];
const groups = [undefined, null, 'none', 'humanoid', 'daedra', 'undead', 'animal', 'Elf', 5];
const gate = () => gateTarget(THEORY_LEVEL);
const tough = () => referenceFoe(THEORY_LEVEL, 'tough');

function add(out, counts, kind, args, result) {
  out.add(kind, ...args.map(V), '=>', V(result));
  counts[`${out.module}_${kind}`] = (counts[`${out.module}_${kind}`] ?? 0) + 1;
}

/**
 * `selectWeaponCandidates` is module-private in src/enchantPlan.js: cut its exact source (the R1 method) so the
 * vectors test the real selector over a synthetic candidate list.
 */
function selectCandidates(cands, budget, maxProcs) {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, '..', 'src', 'enchantPlan.js'), 'utf8');
  const head = 'function selectWeaponCandidates(cands, budget, maxProcs) {';
  const at = text.indexOf(head);
  if (at < 0 || text.indexOf(head, at + 1) >= 0) throw new Error('rust-planner-vectors: selectWeaponCandidates must be unique');
  const end = text.indexOf('\n}\n', at);
  if (end < 0) throw new Error('rust-planner-vectors: no close for selectWeaponCandidates');
  const ITEM = 10;
  return new Function('ITEM_ENCHANTMENT_MAX', `${text.slice(at, end + 3)}\nreturn selectWeaponCandidates;`)(ITEM)(cands, budget, maxProcs);
}

/** The descending `dps` comparator (the imprint pool's `best_by('carriedDps')` shape). */
function sortByDps(values) {
  const list = values.map((v) => ({ ...v }));
  list.sort((a, b) => b.dps - a.dps);
  return list;
}

/** The value/cost comparator, `(a, b) => b.value / b.cost - a.value / a.cost`. */
function sortByRate(values) {
  const list = values.map((v) => ({ ...v }));
  list.sort((a, b) => b.value / b.cost - a.value / a.cost);
  return list;
}

/**
 * The skill-map write of `skillGain` (enchantPlan.js:104), which the JS inlines rather than naming: one line of the
 * real source, transcribed so the vectors pin the `?? 0` / `?? {}` defaults. `points` is what `extra` carries.
 */
function addSkillPoints(ch, id, points) {
  const copy = JSON.parse(JSON.stringify(ch));
  const sid = String(id);
  copy._mods = { ...(copy._mods ?? {}) };
  copy._mods.skills = { ...(copy._mods.skills ?? {}), [sid]: (copy._mods.skills?.[sid] ?? 0) + points };
  return copy;
}

/** `cost_of`'s JS: `enchantmentCost(kind, param)` with the module's default-param rule. */
function costOf(kind, param) {
  const c = enchantmentCost(kind, param);
  return c === null || c === undefined ? 0 : c;
}

/**
 * The four stage characters carry whole built characters, which are large; the vectors compare the parts the fold can
 * change (`_mods.stats`, `_mods.statMax`, `_mods.skills`, `firmamentDamagePct`) plus the item's enchant rows and
 * condition, which is the whole surface `applyFirmament`/`applyEnchants` write.
 */
function stripCharacter(ch) {
  const copy = JSON.parse(JSON.stringify(ch));
  return {
    mods: copy._mods,
    firmamentDamagePct: copy.firmamentDamagePct ?? null,
    enchantments: copy.weapon?.enchantments ?? copy.wraps?.enchantments ?? null,
    condition: copy.weapon?.currentCondition ?? copy.wraps?.currentCondition ?? null,
    offEnchantments: copy.offWeapon?.enchantments ?? null,
    offCondition: copy.offWeapon?.currentCondition ?? null,
    offEquipSlot: copy.offWeapon?.equipSlot ?? null,
    dual: copy._dual ?? false,
  };
}

/**
 * `applyTree` for a probe: the JS function is exported, but the vector wants a character with a known skill map first.
 * Start from a built character so `_mods.stats`/`_mods.skills` exist, then fold the family's tree in.
 */
function applyTreeProbe(template, familyKey) {
  return FB.applyTree(maxCharacter(template, {}), familyKey);
}

/** `Number(x).toLocaleString('en-US')`, the formatter the vectors pin. */
function groupedText(x) {
  return Number(x).toLocaleString('en-US');
}

/** `hitPointsOf` from src/enchantPlan.js (module-private): the `?? 400` default is its own line. */
function hitPointsOf(t) {
  return Number(itemTemplate(t)?.hitPoints ?? 400);
}

/**
 * `applyPlanDps` is private in src/enchantPlan.js, and its `Math.max(1, Number(item.maxCondition) || 800)` line is a
 * real JS default the catalogue never reaches (every weapon carries a positive condition). Cut the exact source with
 * its module dependencies passed in, so the vectors can hit the fallback with a hand-edited character.
 */
function applyPlanDps(ch, plan, target) {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, '..', 'src', 'enchantPlan.js'), 'utf8');
  const head = 'function applyPlanDps(ch, plan, target, gameBuild = DEFAULT_GAME_BUILD) {';
  const at = text.indexOf(head);
  if (at < 0 || text.indexOf(head, at + 1) >= 0) throw new Error('rust-planner-vectors: applyPlanDps must be unique');
  const end = text.indexOf('\n}\n', at);
  if (end < 0) throw new Error('rust-planner-vectors: no close for applyPlanDps');
  const itemEnchantId = { CastWhenStrikes: ENCHANTMENT_TYPES.CastWhenStrikes, PotentVs: ENCHANTMENT_TYPES.PotentVs };
  // The vectors replay the Rust's `apply_plan_dps`, which is the deliberate CUT landmark (`CUT_GAME_BUILD`). So the JS
  // copy is handed the cut, not the live `DEFAULT_GAME_BUILD`: the vectors must not follow the default flip.
  const fn = new Function('ITEM_ENCHANT_ID', 'maxRun', 'DEFAULT_GAME_BUILD', `${text.slice(at, end + 3)}\nreturn applyPlanDps;`);
  return fn(itemEnchantId, maxRun, '14512')(ch, plan, target);
}

/**
 * The strike spell ids are a literal inside `weaponCandidates` (enchantPlan.js:117): cut them from the source so the
 * Rust's `strike_params` is compared to the real list, not a copy.
 */
function strikeParams() {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, '..', 'src', 'enchantPlan.js'), 'utf8');
  const m = text.match(/for \(const param of (\[[0-9., ]+\])\)/);
  if (!m) throw new Error('rust-planner-vectors: the weaponCandidates strike list moved');
  return JSON.parse(m[1]);
}

export function genPlannerFamilies(Out) {
  // The stock spellbook is a vector input (`readSpellsStd`); the file is required and fails loudly.
  const dir = arena2Dir();
  if (!dir) throw new Error('rust-planner-vectors: no ARENA2 in the launcher config; SPELLS.STD is required');
  const book = readSpellsStd(readFileSync(resolve(dir, 'SPELLS.STD')));
  if (!book.length) throw new Error('rust-planner-vectors: empty SPELLS.STD');
  const plan = new Out('enchant_plan', 'R5d enchant plan: equip set, priority fill, value/cost sorts and the matrix', true);
  const real = new Out('real_build', 'R5d real-build chain, loadout universe and the sampled shortlist', true);
  const counts = {};
  const put = (kind, args, result) => add(plan, counts, kind, args, result);
  const putReal = (kind, args, result) => add(real, counts, kind, args, result);
  // Both files need the stock spellbook (the plans price spells; the real chain runs `simulatePurse`).
  plan.add('book', V(book));
  real.add('book', V(book));

  // ---- gearPieces: every template x every shield form ------------------------------------------------
  for (const weapon of templates) {
    for (const shield of shields) {
      let result;
      let refused = false;
      try {
        result = E.gearPieces({ weapon, shield });
      } catch (e) {
        refused = true;
        result = null;
      }
      put('gear', [{ weapon, shield }, ...(refused ? [true] : [])], result);
    }
  }
  // The refusal and the missing-argument arms.
  for (const weapon of [999, '123', -1, 0, 123.5, 'x', undefined]) {
    let result;
    let refused = false;
    try {
      result = E.gearPieces({ weapon });
    } catch (e) {
      refused = true;
      result = null;
    }
    put('gear', [{ weapon }, ...(refused ? [true] : [])], result);
  }
  put('gear', [{}], E.gearPieces());
  put('gear', [[]], E.gearPieces());

  // ---- bestWeaponForFamily: every family x both targets ----------------------------------------------
  // The Rust `best_weapon_for_family` is a deliberate CUT landmark (`CUT_GAME_BUILD`), so the JS copy of the row is
  // priced at the cut too: the vector replay must not follow the default flip.
  for (const family of IMPRINT_FAMILIES) {
    for (const target of [gate(), tough()]) put('best', [family, target], E.bestWeaponForFamily(family, target, '14512'));
  }

  // ---- planMatrix: the option grid (4 whole matrices) -------------------------------------------------
  const matrixRows = [];
  for (const soulGem of [false, true]) {
    for (const forceSkills of [false, true]) {
      const opts = { soulGem, forceSkills, group: forceSkills ? 'undead' : 'daedra', target: gate() };
      matrixRows.push([opts, E.planMatrix(opts)]);
    }
  }
  matrixRows.push([{}, E.planMatrix()]);

  // ---- planEnchants: the whole plan over the option grid ---------------------------------------------
  const plans = [];
  const planOpts = [];
  const addPlan = (opts) => {
    const result = E.planEnchants(opts);
    plans.push(result);
    planOpts.push(opts);
    put('plan', [opts], result);
  };
  // every template at the shipped options (the headline grid)
  for (const weapon of templates) addPlan({ weapon, target: gate() });
  // the option grid on a spread of templates: soul gem, force skills, both targets, repairs/regen and group
  const spread = [113, 123, 124, 127, 129, 130, 560, 562, 563, 115, 122, 126, 118];
  for (const weapon of spread) {
    addPlan({ weapon, soulGem: true, target: gate() });
    addPlan({ weapon, forceSkills: true, target: gate() });
    addPlan({ weapon, forceSkills: true, target: tough() });
    addPlan({ weapon, target: tough() });
  }
  for (const group of groups) addPlan({ weapon: 124, group, target: gate() });
  for (const repairs of [undefined, 0, 1, 3, 99, -1, 1.9, NaN, '2', 'x', null]) {
    addPlan({ weapon: 125, repairs, target: gate() });
  }
  for (const regen of [undefined, 0, 1, 2, 9, -1, 2.9, NaN, '3', null]) {
    addPlan({ weapon: 125, regen, target: gate() });
  }
  for (const skill of [undefined, null, 29, 34, 30, 0, 99, '34', NaN]) {
    addPlan({ weapon: 118, skill, target: gate() });
  }
  // `forceSkills` together with `skill`: the future-cap filter's "this skill, or Critical Strike" arms need both at once
  // (the grid above never pairs them), and the `some(...)`/`==` mutants only show there.
  for (const skill of [29, 34, 30, 0, 99]) {
    addPlan({ weapon: 118, forceSkills: true, skill, target: gate() });
    addPlan({ weapon: 123, forceSkills: true, skill, soulGem: true, target: gate() });
  }
  for (const shield of [undefined, 'none', 'auto', 109, 111, 112, 0, 120]) {
    addPlan({ weapon: 123, shield, soulGem: true, target: gate() });
  }
  // a repeated plan: the JS cache is not ported, but the same inputs must produce the same plan
  put('plan', [{ weapon: 123, target: gate() }], E.planEnchants({ weapon: 123, target: gate() }));
  // the matrix's own plan call, per family (the same options, so a matrix difference points at the wrapper)
  for (const family of IMPRINT_FAMILIES) {
    const best = E.bestWeaponForFamily(family, gate());
    if (!best) continue;
    addPlan({ weapon: best.template, soulGem: false, repairs: 1, regen: 0, group: 'daedra', forceSkills: false, target: gate() });
  }
  // Each matrix is compared by its own `matrix` case; no combined row (the file stays small).
  for (const [opts, result] of matrixRows) put('matrix', [opts], result);

  // ---- effectLine: every effect of every plan (the readable line and its grouping) -------------------
  for (const result of plans) {
    for (const row of result.rows) {
      for (const e of row.effects) put('line', [e], E.effectLine(e));
    }
  }
  // The QoL counts: a soul-gem budget lets more hosts fit, so the decrement's size shows.
  for (const repairs of [3, 4, 6, 8, 12]) addPlan({ weapon: 123, soulGem: true, repairs, target: gate() });
  for (const regen of [3, 4, 6, 8, 12]) addPlan({ weapon: 123, soulGem: true, regen, target: gate() });
  // toLocaleString rounds to three fraction digits; the catalogue's costs are integers, so only .5 values are pinned
  // beyond integers (a documented limit: a sub-milli cost would print "0" in en-US).
  for (const cost of [0.5, -0.5]) {
    put('line', [{ name: 'X', paramName: 'y', cost, benefit: '' }], E.effectLine({ name: 'X', paramName: 'y', cost, benefit: '' }));
  }
  // the grouping edges: 0, 999, 1000, 1830, 5000 and a negative and a fractional cost
  for (const cost of [0, 1, 9, 10, 99, 100, 999, 1000, 1500, 5000, 12345, -500, 1234.5, 1e21]) {
    put('line', [{ name: 'X', paramName: 'y', cost, benefit: '' }], E.effectLine({ name: 'X', paramName: 'y', cost, benefit: '' }));
    put('line', [{ name: 'X', paramName: '', cost, benefit: 'b' }], E.effectLine({ name: 'X', paramName: '', cost, benefit: 'b' }));
  }
  put('line', [{ name: 'X', paramName: 'undefined', cost: 5 }], E.effectLine({ name: 'X', paramName: 'undefined', cost: 5 }));
  put('line', [{ name: 'X', paramName: undefined, cost: 5 }], E.effectLine({ name: 'X', paramName: undefined, cost: 5 }));

  // ---- the planner's pure pieces, exposed for the sweep: the cap, proc cap, count coercion, strike list, the
  // priority-fill selector and the grouping. Each is a whole domain or a boundary list.
  put('strike', [null], strikeParams());
  put('consts', [null], [10, 400, 800]);
  for (const hp of [0, 1, 100, 399, 400, 401, 750, 800, 900, 1000, 1001, 1500, 4000]) {
    for (const swings of [0.5, 1, 2, 10, 40, 100, 168, 200, 400]) {
      put('maxprocs', [hp, swings], Math.max(1, Math.min(3, Math.floor(hp / (10 * swings)))));
    }
  }
  for (const v of [undefined, null, 0, -0, 1, 1.9, -1, -1.9, NaN, Infinity, -Infinity, '2', 'x', '']) {
    // The JS default parameter: `undefined` takes the default, an explicit value does not.
    const jsCount = (x, d) => Math.max(0, Math.trunc(Number(x === undefined ? d : x) || 0));
    put('count', [v, 1], jsCount(v, 1));
    put('count', [v, 0], jsCount(v, 0));
  }
  // The priority-fill selector over a synthetic candidate list: the budget, the ten-row cap, the proc cap and a tie.
  const cand = (type, param, cost, value) => ({ type, param, cost, value });
  const grids = [
    [cand('CastWhenStrikes', 50, 100, 3), cand('CastWhenStrikes', 53, 100, 5), cand('EnhancesSkill', 29, 100, 4)],
    [cand('CastWhenStrikes', 50, 100, 3), cand('CastWhenStrikes', 53, 100, 3)],
    [cand('PotentVs', 1, 0, 2), cand('PotentVs', 2, 5, 2)],
    [cand('EnhancesSkill', 29, 5, 1), cand('EnhancesSkill', 34, 5, 1), cand('EnhancesSkill', 28, 5, 1)],
    Array.from({ length: 12 }, (_, i) => cand('EnhancesSkill', i, 1, 1)),
  ];
  for (const cands of grids) {
    for (const budget of [0, 1, 4, 10, 100, 150, 200, 1000, Infinity]) {
      for (const maxProcs of [0, 1, 2, 3, 5]) {
        put('select', [cands, budget, maxProcs], selectCandidates(cands, budget, maxProcs));
      }
    }
  }
  // The priority-fill selector's own arms: a 12-candidate list over budget 0 and Infinity shows that the ten-row cap
  // and the exact-arith keys matter (a `+`/`-` or key field swap picks a different set).
  for (const n of [1, 9, 10, 11]) {
    const cands = Array.from({ length: n }, (_, i) => ({ type: 'EnhancesSkill', param: i, cost: 1, value: 1 }));
    for (const budget of [0, 1, 9, 10, 11, 12, Infinity]) {
      put('select', [cands, budget, 3], selectCandidates(cands, budget, 3));
    }
  }
  // A 0-cost candidate and a NaN-valued one reach the `cost.is_finite()`/`value > 0` guards.
  for (const cands of [
    [{ type: 'PotentVs', param: 1, cost: 0, value: 5 }],
    [{ type: 'PotentVs', param: 1, cost: Infinity, value: 5 }],
    [{ type: 'PotentVs', param: 1, cost: 5, value: NaN }],
    [{ type: 'PotentVs', param: 1, cost: NaN, value: 5 }],
    [{ type: 'PotentVs', param: 1, cost: -5, value: 5 }],
  ]) {
    put('select', [cands, 100, 3], selectCandidates(cands, 100, 3));
  }
  // The priority-fill selector's ordering arms: equal rates (the comparator tie), two CWS candidates (the proc-count
  // key field), mixed costs (the spent/count key fields) and a tie the strict `>` first-wins rule decides.
  const tie = (t, p, cost, value) => ({ type: t, param: p, cost, value });
  for (const cands of [
    [tie('PotentVs', 1, 5, 5), tie('PotentVs', 2, 10, 10)],
    [tie('PotentVs', 2, 10, 10), tie('PotentVs', 1, 5, 5)],
    [tie('CastWhenStrikes', 50, 5, 3), tie('CastWhenStrikes', 53, 5, 4), tie('EnhancesSkill', 29, 5, 3)],
    [tie('CastWhenStrikes', 50, 5, 3), tie('CastWhenStrikes', 53, 5, 3), tie('CastWhenStrikes', 52, 5, 3)],
    [tie('CastWhenStrikes', 50, 2, 1), tie('EnhancesSkill', 29, 3, 2), tie('PotentVs', 1, 1, 1),
      tie('CastWhenStrikes', 53, 2, 1)],
    [tie('EnhancesSkill', 29, 3, 2), tie('EnhancesSkill', 34, 3, 2)],
    [tie('EnhancesSkill', 29, 0, 2), tie('EnhancesSkill', 34, 1, 2)],
    // The DP key's `spent + cost` (a `-` mutant collides two different sums): 5+4 and 4+3 must not be one key.
    [tie('CastWhenStrikes', 1, 5, 5), tie('CastWhenStrikes', 2, 4, 7), tie('EnhancesSkill', 3, 4, 7),
      tie('CastWhenStrikes', 1, 3, 7)],
  ]) {
    for (const budget of [0, 1, 5, 10, 20, 100, Infinity]) {
      for (const maxProcs of [0, 1, 2, 3, 4]) {
        put('select', [cands, budget, maxProcs], selectCandidates(cands, budget, maxProcs));
      }
    }
  }
  // The two sort comparators over permuted lists of every sign: a 2-element sort pairs only (b, a), whose difference is
  // negative, so a `> 0` vs `> 1` mutant survives there; a list with a positive adjacent pair pins the branch.
  for (const values of [
    [{ dps: 1, name: 'a' }, { dps: 2, name: 'b' }],
    [{ dps: 2, name: 'a' }, { dps: 1, name: 'b' }],
    [{ dps: 1, name: 'a' }, { dps: 2, name: 'b' }, { dps: 3, name: 'c' }],
    [{ dps: 3, name: 'a' }, { dps: 1, name: 'b' }, { dps: 2, name: 'c' }],
    [{ dps: 1, name: 'a' }, { dps: 1, name: 'b' }, { dps: 2, name: 'c' }],
    [{ dps: 1, name: 'a' }, { dps: 1, name: 'b' }],
    // mixed: a later element larger than the one before it (the only shape a `d > 1` mutant can mis-order)
    [{ dps: 2, name: 'a' }, { dps: 3, name: 'b' }, { dps: 1, name: 'c' }],
    [{ dps: 1, name: 'a' }, { dps: 3, name: 'b' }, { dps: 2, name: 'c' }],
    [{ dps: 5, name: 'a' }, { dps: 4, name: 'b' }, { dps: 9, name: 'c' }, { dps: 7, name: 'd' }],
    [{ dps: 0, name: 'a' }, { dps: -1, name: 'b' }],
  ]) put('sortdps', [values], sortByDps(values));
  for (const values of [
    [{ value: 1, cost: 1, name: 'a' }, { value: 2, cost: 1, name: 'b' }],
    [{ value: 2, cost: 1, name: 'a' }, { value: 1, cost: 1, name: 'b' }],
    [{ value: 1, cost: 2, name: 'a' }, { value: 1, cost: 1, name: 'b' }],
    [{ value: 3, cost: 2, name: 'a' }, { value: 1, cost: 1, name: 'b' }, { value: 2, cost: 2, name: 'c' }],
    [{ value: 1, cost: 1, name: 'a' }, { value: 2, cost: 2, name: 'b' }],
    [{ value: 0, cost: 1, name: 'a' }, { value: 1, cost: 1, name: 'b' }],
    [{ value: 1, cost: 0, name: 'a' }, { value: 1, cost: 1, name: 'b' }],
    [{ value: 1, cost: 1, name: 'a' }, { value: 1, cost: 0, name: 'b' }],
    [{ value: 2, cost: 3, name: 'a' }, { value: 5, cost: 4, name: 'b' }, { value: 1, cost: 9, name: 'c' }],
    [{ value: 5, cost: 9, name: 'a' }, { value: 2, cost: 3, name: 'b' }, { value: 1, cost: 1, name: 'c' }],
  ]) put('sortrate', [values], sortByRate(values));
  // The cost formatter: whole numbers, the exact three-fraction-digit rounding and the exponent expansion.
  for (const x of [0, 1, 9, 10, 99, 100, 999, 1000, 1830, 5000, 12345, -500, 0.5, -0.5, 1.0005, 2.00049, 0.00049,
    0.0005, 0.9999, 1.9995, 1234.5678, 1e21, 1.5e21, -1e21, 1e-7, 0.125,
    // the exponent-expansion arms: a value whose digits end before the point (needs zero padding) and one whose
    // point falls inside the digits (no padding)
    0.000123, 0.000000001, 1.5e-8, 1.234e-5, 1.234567e2, 1.234567e5, 1e-21]) {
    put('grouped', [x], groupedText(x));
  }
  console.log('rust-planner-vectors:', counts);
  // Every `cost_of` argument the planner's utility catalogue uses, plus the neighbours that must differ, so a wrong
  // param in a utility row is not silently the same price.
  for (const [kind, param] of [
    ['RepairsObjects', undefined], ['RepairsObjects', -1], ['RegensHealth', 0], ['RegensHealth', 1],
    ['ExtraSpellPts', 0], ['ExtraSpellPts', 1], ['VampiricEffect', 0], ['VampiricEffect', 1],
    ['ImprovesTalents', 0], ['ImprovesTalents', 1], ['ImprovesTalents', 2],
    ['FeatherWeight', undefined], ['FeatherWeight', -1],
    ['StrengthensArmor', -1], ['AbsorbsSpells', -1], ['IncreasedWeightAllowance', 1],
  ]) {
    put('cost', [kind, param === undefined ? null : param], costOf(kind, param));
  }
  // The `rate: cost > 0 ? value / cost : 0` guard: a zero and a negative cost take the else arm, a positive one divides.
  for (const value of [0, 1, 12.5, -3, 1000]) {
    for (const cost of [-900, -1, 0, 0.5, 1, 900, 5000]) {
      put('rate', [value, cost], cost > 0 ? value / cost : 0);
    }
  }
  // `hitPointsOf`/`cost_of`'s defaults are real JS lines the catalogue never reaches. Two families call the helpers
  // directly with the values that do reach them, so those defaults are pinned, not just argued away.
  for (const template of [560, 561, 562, 563, 43, 999, 131, 123, 113]) {
    put('hitpoints', [template], hitPointsOf(template));
  }
  const baseCh = maxCharacter(123, {});
  for (const maxCondition of [undefined, null, 0, -0, NaN, '', 'x', 1, 800, 1500, '1200']) {
    const ch = JSON.parse(JSON.stringify(baseCh));
    if (ch.weapon) {
      if (maxCondition === undefined) delete ch.weapon.maxCondition;
      else ch.weapon.maxCondition = maxCondition;
    }
    put('apply', [{ maxCondition: maxCondition === undefined ? 'absent' : String(maxCondition) }, ch, { rows: [] }, gate()],
      applyPlanDps(ch, { rows: [] }, gate()));
  }
  // The same call with skill rows: `skills[e.param] ?? 0` is reached for a skill the character has no key for, and for
  // one it does (the plan's own characters carry both ids, so only a hand-built plan reaches the default).
  for (const rows of [
    [{ effects: [{ type: 'EnhancesSkill', param: 28 }] }],
    [{ effects: [{ type: 'EnhancesSkill', param: 29 }] }],
    [{ effects: [{ type: 'EnhancesSkill', param: 34 }, { type: 'CastWhenStrikes', param: 50 }] }],
    [{ effects: [{ type: 'PotentVs', param: 1 }, { type: 'EnhancesSkill', param: 29 }] }],
  ]) {
    put('apply', ['rows', JSON.parse(JSON.stringify(baseCh)), { rows }, gate()],
      applyPlanDps(JSON.parse(JSON.stringify(baseCh)), { rows }, gate()));
  }
  // `addSkillPoints`' `_mods.skills?.[sid] ?? 0` (enchantPlan.js:104): a character whose skill map lacks the key.
  // No string-valued skill here: JS would concatenate there (`'150' + 15`), Rust converts (see the `shortcut:` at the
  // site); every builder writes numbers, so that shape is not a real input.
  for (const base of [
    { _mods: { skills: {} } },
    { _mods: { skills: { 29: 200 } } },
    { _mods: { skills: { 29: null } } },
    { _mods: {} },
  ]) {
    for (const [id, points] of [[29, 15], [34, 15], [0, 0], [29, -15]]) {
      put('skillpts', [base, id, points], addSkillPoints(base, id, points));
    }
  }
  // Invariants the equivalence notes rely on: no piece reaches the ten-row cap, every gear template answers hitPoints,
  // and no plan total is NaN.
  let maxRows = 0;
  for (const p of plans) {
    for (const r of p.rows) maxRows = Math.max(maxRows, r.effects.length);
    for (const v of [p.cardPlanDps, p.cardUncappedPlanDps, p.procDps]) {
      if (Number.isNaN(v)) throw new Error('rust-planner-vectors: a plan total is NaN');
    }
  }
  if (maxRows > 6) throw new Error(`rust-planner-vectors: a piece holds ${maxRows} rows; the row-cap note must change`);
  // The DP key's three components are (spent+cost, count, procs). `spent` is a sum of the candidates' costs, all whole
  // numbers from the price table, so `spent + cost` is exact and equal exactly when the sums are equal; the note on the
  // key relies on that. (The synthetic `select` grids deliberately include NaN/Infinity costs, so the check covers the
  // real plans' candidates, which are what the key is built from.)
  for (const p of plans) {
    for (const r of p.ratings.weapon) {
      if (!Number.isInteger(r.cost)) {
        throw new Error(`rust-planner-vectors: a plan candidate cost is not whole: ${r.cost}`);
      }
    }
  }
  // How many CWS rows a plan can carry (the proc-cap note).
  const cwsRows = new Map();
  for (const p of plans) {
    const n = p.ratings.weapon.filter((r) => r.type === 'CastWhenStrikes').length;
    cwsRows.set(n, (cwsRows.get(n) ?? 0) + 1);
  }
  if (cwsRows.size !== 1 || !cwsRows.has(6)) {
    throw new Error(`rust-planner-vectors: the CWS row count is not the constant 6: ${JSON.stringify([...cwsRows])}`);
  }
  console.log(`PROBE maxRows ${maxRows}`);
  console.log('rust-planner-vectors:', counts);
  // Invariants the stage-3 notes rely on: the monster-kind imprint filter never changes a pick (no monster-kind
  // imprint is ever the best eligible one), so the filter is a guard, not a ranking step.
  {
    const MONSTER = new Set(['bane', 'sanctified', 'moon']);
    let kindsWin = 0;
    for (const mode of ['uncapped', 'cap']) {
      for (const family of IMPRINT_FAMILIES) {
        for (const template of family.templates) {
          const st = FB.realBuildStages(template, family, { mode, encounter: 'breach' });
          if (st.imprint && MONSTER.has(st.imprint.power.kind)) kindsWin++;
        }
      }
    }
    if (kindsWin !== 0) throw new Error(`rust-planner-vectors: a monster-kind imprint wins ${kindsWin} times`);
  }

  // ---- stage 3: the real-build chain -----------------------------------------------------------------
  // `realBuildStages` costs ~0.1-0.4 s per call (it runs planEnchants and three analyze passes), so the stage family
  // is one template per family at each (mode, encounter, vampire, dual) combination rather than the whole grid:
  //   2 modes x 3 encounters x 2 vampire x 2 dual x 1 template = 24 stages (~5 s)
  // The universe families then cover every template in every hold, which is the whole domain of realWeaponLoadouts:
  //   2 modes x 2 vampire x 1 encounter = 4 universes, 31 rows each (~12 s)
  // `applyFirmament`/`applyTree` are cheap (a plan and a fold), so they get every family and both characters:
  //   apply   6 families x 2 characters = 12 (~1 s)
  const onePerFamily = [123, 118, 127, 124, 130, 563];
  for (const [mode, encounter] of [['uncapped', 'breach'], ['cap', 'breach'], ['cap', 'skyketch'], ['cap', 'abyss']]) {
    for (const vampire of [false, true]) {
      for (const dual of [false, true]) {
        for (const template of onePerFamily) {
          const family = IMPRINT_FAMILIES.find((f) => f.templates.includes(template));
          if (!family) continue;
          // The JS chain throws on a dual bow/fist row (there is no off-hand item to copy), and `realWeaponLoadouts`
          // never makes one: the dual stage is only asked for where that function would ask for it.
          const w = WEAPONS[template];
          if (dual && (w.twoHanded || w.skill === 'Archery' || w.skill === 'HandToHand')) continue;
          const st = FB.realBuildStages(template, family, { mode, vampire, dual, encounter });
          // The stage carries whole characters and runs; compare the derived figures the caller reads, plus the two
          // characters' mods and the imprint record, so a wrong fold shows.
          putReal('stage', [{ template, family: family.key, mode, vampire, dual, encounter }], {
            capped: st.capped,
            target: st.target,
            treeStars: st.tree.stars,
            treeFreeStars: st.tree.freeStars,
            treeBlow: st.treeCh.firmamentDamagePct,
            treeDps: st.treeRun.carriedCappedDps + st.treeRun.enchantDps,
            enchDps: st.enchRun.carriedCappedDps + st.enchRun.enchantDps,
            treeCh: stripCharacter(st.treeCh),
            enchCh: stripCharacter(st.enchCh),
            gearCh: stripCharacter(st.gearCh),
            imprint: st.imprint,
          });
        }
      }
    }
  }
  // The whole universe per (mode, vampire): every template's row, which is the domain of realWeaponLoadouts.
  for (const mode of ['uncapped', 'cap']) {
    for (const vampire of [false, true]) {
      const rows = FB.realWeaponLoadouts({ modes: [mode], vampire, encounter: 'breach' });
      putReal('loadouts', [{ mode, vampire, encounter: 'breach' }], rows);
      for (const row of rows) putReal('sampled', [row], FB.isSampledLoadout(row));
    }
  }
  // `applyFirmament` and `applyTree` over every family: the fold's stats/statMax/skills and the blow percent.
  for (const family of IMPRINT_FAMILIES) {
    for (const template of [family.templates[0], family.templates[family.templates.length - 1]]) {
      const ch = applyTreeProbe(template, family.key);
      putReal('apply', [{ template, family: family.key }], stripCharacter(ch));
    }
  }

  // ---- stage 4: the sampled shortlist -----------------------------------------------------------------
  // One shortlist costs 2-8 s at `trials: 1000, maxSeconds: 20` (it re-runs the chain for k rows and samples 1,000
  // fights per row), so the family is sized by wall clock: 5 runs, ~21 s, 13 rows.
  //   uncapped k = 1, 3, 5   the top of the universe at the widest k the vectors need
  //   cap      k = 1, 3      the relay objective (a different ranking path and a different target)
  // The universe itself is compared by the `loadouts` family, so the shortlist cases only need the rerank.
  for (const [mode, k] of [['uncapped', 1], ['uncapped', 3], ['uncapped', 5], ['cap', 1], ['cap', 3]]) {
    const opts = { k, mode, trials: 1000, seed: 7, maxSeconds: 20, maxBlows: 6000 };
    putReal('shortlist', [opts], S.shortlistLoadouts(opts));
  }
  // The validation arms (no simulation: they throw before any universe is built), with the JS message pinned.
  for (const opts of [
    { k: 0 },
    { k: 1.5 },
    { k: -1 },
    { k: 1, trials: 999 },
    { k: 1, trials: 1000.5 },
    { k: 1, mode: 'cap', health: 5000 },
    { k: 1, mode: 'cap', objective: 'stochastic-ttk' },
    { k: 1, objective: 'stochastic-relay' },
    { k: 1, mode: 'weird' },
    { k: 999 },
    // The `k` default and the safe-integer boundary: `Number.isSafeInteger` accepts 2^53-1 and rejects 2^53, and an
    // absent `k` is not an integer at all.
    {},
    { mode: 'cap' },
    { k: 9007199254740991 },
    { k: 9007199254740992 },
    { k: -9007199254740992 },
    { k: NaN },
    { k: Infinity },
  ]) {
    let message;
    try {
      S.shortlistLoadouts(opts);
      message = null;
    } catch (e) {
      message = e.message;
    }
    putReal('shortlist-err', [opts], message);
  }
  // The `seed` and `maxSeconds` defaults: absent keys take 0 and 900. `maxBlows: 20` keeps the 900-second horizon cheap
  // (each trial ends on the blow cap), so both defaults are actually exercised.
  for (const opts of [
    { k: 2, maxSeconds: 20, maxBlows: 6000 },
    { k: 2, seed: 7, maxBlows: 20 },
  ]) {
    putReal('shortlist', [opts], S.shortlistLoadouts(opts));
  }
  return { enchant_plan: plan.write(), real_build: real.write() };
}
