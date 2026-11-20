/*
 * R5e Forge vectors: manual Firmament editing (rust/dfo-core/src/forge.rs) against the real vendored law.
 *
 * Families, all compared as whole ordered values through the codec (f64 as bits):
 *   allocate  a sweep over EVERY star of several trees, plus hand-made shapes: the path, its cost, the purses left, the
 *             resulting tree; and one case per fault (`treefault`, then the forge's own words)
 *   refund    the same sweep, plus refunding a birthsign (the respec) and stars that disconnect others
 *   apply     the resulting tree put on a theory character (src/realBuild.js applyFirmament), src/model.js analyze
 *             before and after, whole cards (the attributes and DPS live in them)
 *   stars / craft / silver   starsFor, craftPointsFor, refundSilver at their edges
 *   totals / diff / clean / cost   the law's readers the GUI shows beside the previews
 *   decode    a saved allocation: absent / explicitly empty / a tree (row string and { start, keys } object)
 *
 * The JS is the oracle. The fault words below mirror forge.rs's enum arms, decided only by the JS's own predicates
 * (treeFault, FIRM_NODES, isStart, pathTo, fits) in the order the Rust applies them.
 */
import {
  EMPTY_TREE, allocatable, cleanKeys, craftPointsFor, firmCostOf, fits, isStart, packTree, pathTo, pointsLeft,
  refundSilver, refundTakes, starsFor, totals as treeTotals, treeDiff, treeFault, unpackTree,
} from '../vendor/firmament/firmamentLaw.js';
import { FIRM_NODES } from '../vendor/firmament/firmamentTree.js';
import { BUILDS, buildById, planBuild, planFromTree } from '../src/firmament.js';
import { applyFirmament } from '../src/realBuild.js';
import * as M from '../src/model.js';
import { theoryCharacter } from '../src/theory.js';
import { encodeValue as V } from './rust-codec.mjs';

/** The forge's fault words, exactly as rust/dfo-core/src/forge.rs names them. */
function allocateFault(tree, key, stars, craft) {
  const fault = treeFault(tree, stars, craft);
  if (fault) return `tree-${fault}`;
  if (!tree?.start) return 'no-start';
  if (!FIRM_NODES.has(key)) return 'unknown-node';
  if (isStart(key)) return 'start-key';
  if (key === tree.start || tree.keys.includes(key)) return 'already-allocated';
  if (pathTo(tree, key).length === 0) return 'not-reachable';
  if (!fits(cleanKeys([...tree.keys, ...pathTo(tree, key)]), stars, craft)) return 'over-budget';
  return null;
}

function allocateAnswer(tree, key, stars, craft) {
  const fault = allocateFault(tree, key, stars, craft);
  if (fault === 'over-budget') {
    const keys = cleanKeys([...tree.keys, ...pathTo(tree, key)]);
    const cost = firmCostOf(keys);
    return { fault, combat: cost.combat, stars, total: cost.combat + cost.life, purse: stars + craft };
  }
  if (fault) return fault;
  const path = pathTo(tree, key);
  const keys = cleanKeys([...tree.keys, ...path]);
  const left = pointsLeft(keys, stars, craft);
  return { path, cost: path.length, pointsLeft: { stars: left.stars, craft: left.craft }, tree: { start: tree.start, keys } };
}

function refundFault(tree, key) {
  if (!tree?.start) return 'no-start';
  if (!FIRM_NODES.has(key)) return 'unknown-node';
  if (key === tree.start) return 'start-sign';
  if (!(tree.keys ?? []).includes(key)) return 'not-allocated';
  return null;
}

function refundAnswer(tree, key, renown) {
  const fault = refundFault(tree, key);
  if (fault) return fault;
  const removed = refundTakes(tree, key);
  return {
    removed,
    tree: { start: tree.start, keys: tree.keys.filter((k) => !removed.includes(k)) },
    silver: refundSilver(removed.length, renown),
  };
}

/** The respec's record (firmamentLaw.js:479-482): the whole sky back for a flat gold fee, no silver. */
function respecAnswer(tree) {
  return { removed: cleanKeys(tree.keys), tree: { start: null, keys: [] }, gold: 10000, silver: 0 };
}

function treeFaultWord(tree, stars, craft) {
  return treeFault(tree, stars, craft) ?? '-';
}

function decodeSaved(save) {
  if (!save || typeof save !== 'object' || !('firmament' in save)) return 'absent';
  const v = save.firmament;
  if (v == null) return 'empty';
  if (typeof v === 'string') return unpackTree(v).start ? ['tree', unpackTree(v)] : 'empty';
  if (typeof v === 'object') {
    const tree = unpackTree(packTree(v));
    return tree.start ? ['tree', tree] : 'empty';
  }
  return 'empty';
}

export function genForgeFamilies(Out) {
  const out = new Out('forge', 'R5e Forge: allocation/refund previews, a tree on a character, saved allocations', true);
  const counts = {};
  const put = (kind, result, ...args) => {
    out.add(kind, ...args, '=>', V(result));
    counts[kind] = (counts[kind] ?? 0) + 1;
  };
  let defs = 0;
  const def = (v) => {
    out.add('def', String(defs), V(v));
    return `@${defs++}`;
  };

  // ---- trees -------------------------------------------------------------------------------------------
  // Three planned trees (real picks) and hand-made shapes: a chain whose middle star is a bridge, a keystone at the
  // end of a chain (refunding it takes the chain), a two-sign tree (the other sign closed), broken shapes, and the
  // empty sky.
  const planIds = ['longblade', 'destruction', 'tank'];
  const plans = planIds.map((id) => planBuild(buildById(id), { stars: id === 'destruction' ? 40 : 98 }));
  const planBuilds = planIds.map((id) => buildById(id));
  const trees = [
    ...plans.map((p) => p.tree),
    { start: 'sp.start', keys: ['sp.bt', 'mg.bt', 'mg.s1', 'mg.s2', 'mg.g', 'mg.c1.0', 'mg.x', 'mg.w', 'mg.k1', 'mg.k'] },
    { start: 'mg.start', keys: ['mg.bt', 'mg.s1', 'mg.s2', 'mg.g', 'mg.c1.0', 'mg.x', 'mg.w', 'mg.k1', 'mg.k'] },
    { start: 'wr.start', keys: ['wr.bt', 'wr.s1', 'wr.s2', 'wr.g', 'wr.r1', 'wr.c1.0', 'wr.k1', 'wr.k'] },
    { start: 'sh.start', keys: ['sh.bt', 'sh.s1', 'sh.s2', 'sh.g', 'sh.x', 'th.g', 'th.s1', 'th.s2'] },
    { start: 'sp.start', keys: ['sp.bt', 'mg.bt', 'mg.s1', 'nope', 'mg.bt'] },
    { start: 'sp.start', keys: ['sp.bt', 'mg.start', 'mg.s1'] },
    // A foreign sign inside the keys, with a star behind it: the law's own shortest-path guard (a sign is reached,
    // never walked through) only shows when a refund's remainder holds one.
    { start: 'mg.start', keys: ['mg.bt', 'sp.start', 'st.bt', 'mg.s1'] },
    // One star alone: the refund's own "does the tree hold it" guard decides on a single-key list.
    { start: 'sp.start', keys: ['sp.bt'] },
    // The same corner from two signs: `treeDiff` must swap the keys whatever they share only when the sign moves.
    { start: 'sh.start', keys: ['sh.bt', 'sh.s1', 'mg.bt'] },
    EMPTY_TREE,
  ];
  const treeRefs = trees.map(def);
  const hostileKeys = ['nope', '', 'sp.start', 'mg.start'];
  const ref = (v) => V(v);

  // ---- (1) allocate: EVERY star of every tree, at two purses, plus budget edges -------------------------
  for (const [i, tree] of trees.entries()) {
    for (const key of [...FIRM_NODES.keys(), ...hostileKeys]) {
      for (const [stars, craft] of [[98, 0], [12, 20]]) {
        put('allocate', allocateAnswer(tree, key, stars, craft), treeRefs[i], ref(key), V(stars), V(craft));
      }
    }
  }
  for (const [stars, craft] of [[0, 0], [1, 0], [0, 1], [97, 0], [98, 0], [5, 5], [60, 12], [-1, 3]]) {
    for (const key of ['mg.bt', 'mg.s1', 'mg.g', 'mg.k', 'mg.lk', 'mg.lgx', 'sh.bt']) {
      put('allocate', allocateAnswer(trees[0], key, stars, craft), treeRefs[0], ref(key), V(stars), V(craft));
    }
  }

  // ---- the law's own readers the previews are built on: pathTo / allocatable ---------------------------
  for (const [i, tree] of trees.entries()) {
    for (const key of [...FIRM_NODES.keys(), 'nope', '', 'sp.start', 'mg.start']) {
      put('path', pathTo(tree, key), treeRefs[i], ref(key));
      put('alloc', allocatable(tree, key), treeRefs[i], ref(key));
      // `refundTakes` directly: its own "the tree does not hold the key" guard is unreachable from the preview (the
      // preview answers a fault first), so it is swept here.
      put('takes', refundTakes(tree, key), treeRefs[i], ref(key));
    }
  }

  // ---- (2) refund: EVERY star of every tree, plus renown edges -----------------------------------------
  for (const [i, tree] of trees.entries()) {
    for (const key of [...FIRM_NODES.keys(), ...hostileKeys]) {
      put('refund', refundAnswer(tree, key, 50), treeRefs[i], ref(key), V(50));
    }
  }
  for (const renown of [0, 1, 9, 10, 11, 50, -3, NaN, 50, null, undefined]) {
    for (const key of ['mg.bt', 'mg.s1', 'mg.k', 'sp.start']) {
      put('refund', refundAnswer(trees[4], key, renown), treeRefs[4], ref(key), V(renown ?? null));
    }
  }
  for (const [i, tree] of trees.entries()) put('respec', respecAnswer(tree), treeRefs[i]);

  // ---- (a) a legal tree on a theory character: the whole analyze before and after -----------------------
  const charOpts = [
    { blade: 117 },
    { blade: 113, rawBlade: 120 },
    { blade: 124, level: 20, race: 3, starStats: { strength: 6, agility: 6 } },
    { blade: 129, vampire: true },
  ];
  const book = new Map();
  let changed = 0;
  for (const opts of charOpts) {
    const charRef = def(opts);
    for (const [j, plan] of plans.entries()) {
      const ch = theoryCharacter(opts);
      const before = M.analyze(JSON.parse(JSON.stringify(ch)), { standard: book });
      const applied = applyFirmament(
        JSON.parse(JSON.stringify(ch)),
        planFromTree(planBuilds[j], { start: plan.tree.start, keys: plan.tree.keys, stars: plan.stars }),
      );
      const after = M.analyze(applied, { standard: book });
      if (before.dps !== after.dps || before.totalDps !== after.totalDps) changed++;
      put('apply', [before, after], charRef, ref(planIds[j]), treeRefs[j]);
    }
  }
  // The empty sky leaves the character as it was (the apply still answers a full card).
  {
    const charRef = def(charOpts[0]);
    const ch = theoryCharacter(charOpts[0]);
    const before = M.analyze(JSON.parse(JSON.stringify(ch)), { standard: book });
    const after = M.analyze(
      applyFirmament(JSON.parse(JSON.stringify(ch)), planFromTree(BUILDS[0], { ...EMPTY_TREE, stars: 0 })),
      { standard: book },
    );
    put('apply', [before, after], charRef, ref('longblade'), treeRefs[treeRefs.length - 1]);
  }
  if (changed < 8) throw new Error(`forge: only ${changed} applied trees moved a DPS figure; the apply family proves nothing`);

  // ---- the fault of a tree itself, and every allocate fault kind ---------------------------------------
  const faultTrees = [
    trees[8],
    { start: 'nope', keys: ['mg.bt'] },
    { start: 'sp.start', keys: ['mg.c1.0'] },
    { start: 'sp.start', keys: ['mg.bt', 'mg.bt'] },
    { start: 'sp.start', keys: ['sp.start', 'mg.bt'] },
    { start: 'sp.start', keys: ['mg.s2'] },
    { start: null, keys: ['mg.bt'] },
    { start: 'sp.start', keys: ['mg.bt', 'mg.s1', 'mg.s2', 'mg.g', 'mg.c1.0', 'mg.x', 'mg.w', 'mg.k1', 'mg.k'] },
  ];
  for (const t of faultTrees) {
    const r = def(t);
    for (const [stars, craft] of [[98, 0], [3, 0], [98, 60]]) put('treefault', treeFaultWord(t, stars, craft), r, V(stars), V(craft));
    for (const key of ['mg.bt', 'mg.s2', 'mg.k', 'nope', 'sp.start']) put('allocate', allocateAnswer(t, key, 98, 0), r, ref(key), V(98), V(0));
  }

  // ---- budget helpers ---------------------------------------------------------------------------------
  for (const renown of [0, 1, 2, 9, 10, 49, 50, 51, -1, 3.9, NaN, Infinity, null, undefined]) {
    put('stars', starsFor(renown), V(renown ?? null));
  }
  for (const ranks of [[], [0], [8], [7], [8, 8], [100, 100, 100, 100, 100, 100, 100, 100, 100, 100], [50, 50, 50], [-4, 8, 12.9, 300, NaN], null, undefined, [99.9], [100.5], [101], [-1],
    // The clamp's own edges: a NaN rank (0, not 1), a negative one (0), and eight ranks past the cap (the cap's 100 vs
    // 101 shows only when the summed truncation lands on a new eighth).
    [NaN, 7.9], [7, -1], [101.5, 101.5, 101.5, 101.5, 101.5, 101.5, 101.5, 101.5], [50, -3],
    [-1, -1, -1, -1, -1, -1, -1, -1]]) {
    put('craft', craftPointsFor(ranks), V(ranks ?? null));
  }
  for (const removed of [0, 1, 5, -1, 1.9, NaN, Infinity]) {
    for (const renown of [9, 10, 50, null]) put('silver', refundSilver(removed, renown), V(removed), V(renown));
  }
  // The two purse builders a GUI holds as a Budget: renown alone, ranks alone, both.
  for (const renown of [0, 1, 2, 10, 50, 51, NaN, null]) {
    for (const ranks of [null, [], [8], [100, 100, 100, 100, 100, 100, 100, 100, 100, 100]]) {
      put('budget', [
        { stars: starsFor(renown), craft: 0 },
        { stars: 0, craft: craftPointsFor(ranks ?? []) },
        { stars: starsFor(renown), craft: craftPointsFor(ranks ?? []) },
      ], V(renown ?? null), V(ranks));
    }
  }

  // A tree a GUI got from the previews, not from the planner: refund a star of a planned tree and apply the tree that
  // leaves (a valid shape by construction), so an edit's own answer feeds the character.
  {
    const ch = theoryCharacter(charOpts[0]);
    const startRef = def(charOpts[0]);
    const edits = [];
    for (const [j, plan] of plans.entries()) {
      for (const key of plan.tree.keys.slice(0, 3)) edits.push([plan.tree, key]);
    }
    for (const [tree, key] of edits) {
      const preview = refundAnswer(tree, key, 50);
      if (typeof preview === 'string' || preview.tree == null) throw new Error(`forge: the apply refund case ${key} faults`);
      if (!preview.removed.length) throw new Error(`forge: refunding ${key} removed nothing`);
      const before = M.analyze(JSON.parse(JSON.stringify(ch)), { standard: book });
      const applied = applyFirmament(
        JSON.parse(JSON.stringify(ch)),
        planFromTree(planBuilds[0], { start: preview.tree.start, keys: preview.tree.keys, stars: preview.tree.keys.length }),
      );
      const after = M.analyze(applied, { standard: book });
      put('apply', [before, after], startRef, ref('longblade'), def(preview.tree));
    }
  }

  // ---- the fault of a raw record (the two arms a typed tree cannot hold) --------------------------------
  for (const raw of [
    { start: 'sp.start' },
    { start: 'sp.start', keys: 'mg.bt' },
    { start: 5, keys: ['mg.bt'] },
    { start: 'nope', keys: [] },
    { start: null, keys: [] },
    { start: null, keys: ['mg.bt'] },
    { start: undefined, keys: ['mg.bt'] },
    { start: 'sp.start', keys: [] },
  ]) {
    put('faultvalue', treeFault(raw, 98, 0) ?? '-', def(raw), V(98), V(0));
  }

  // ---- the readers beside the previews -----------------------------------------------------------------
  for (const [i, tree] of trees.entries()) put('totals', treeTotals(tree), treeRefs[i]);
  for (const [a, b] of [[0, 1], [0, 4], [4, 5], [6, 5], [5, 6], [3, 2], [8, 10], [10, 8], [10, 0], [11, 12], [12, 11], [10, 12]]) put('diff', treeDiff(trees[a], trees[b]), treeRefs[a], treeRefs[b]);
  for (const keys of [['mg.bt', 'nope', 'mg.bt', 'sp.start'], [], ['sp.start'], ['mg.c1.3', 'mg.c1.0']]) {
    put('clean', cleanKeys(keys), V(keys));
  }
  for (const keys of [['mg.bt', 'mg.s1'], ['mg.lg0', 'mg.l1.0'], ['sp.start'], []]) {
    const r = def(keys);
    for (const [stars, craft] of [[0, 0], [1, 0], [2, 1], [98, 0]]) {
      const left = pointsLeft(keys, stars, craft);
      put('cost', { cost: firmCostOf(keys), fits: fits(keys, stars, craft), left: { stars: left.stars, craft: left.craft } }, r, V(stars), V(craft));
    }
  }

  // ---- (4) a saved allocation ---------------------------------------------------------------------------
  const saves = [
    {},
    { firmament: null },
    { firmament: '' },
    { firmament: { start: null, keys: [] } },
    { firmament: { start: '', keys: [] } },
    { firmament: 'sp.start|' },
    { firmament: 'nope|mg.bt' },
    { firmament: { start: 'sp.start', keys: [] } },
    { firmament: { start: 'sp.start', keys: ['mg.bt', 'mg.s1', 'nope', 'mg.bt'] } },
    { firmament: 'sp.start|mg.bt,mg.s1,nope,mg.bt' },
    { firmament: 'sp.start|mg.c1.0' },
    { firmament: 'sp.start|mg.bt,mg.c1.0' },
    { firmament: 5 },
  ];
  for (const save of saves) put('decode', decodeSaved(save), def(save));

  // The refund family must carry the disconnecting shapes (a generator that lost them fails instead of passing).
  let disconnecting = 0;
  for (const tree of trees) {
    for (const key of tree.keys ?? []) if (refundTakes(tree, key).length > 1) disconnecting++;
  }
  if (disconnecting < 10) throw new Error(`forge: only ${disconnecting} refunds disconnect other stars`);
  if (!trees.some((t) => t.start)) throw new Error('forge: no tree carries a sign');

  const total = out.write();
  console.log('rust-forge-vectors:', counts);
  return { forge: total };
}
