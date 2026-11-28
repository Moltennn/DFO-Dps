/*
 * R5d Firmament vectors: the generated sky (nodes, adjacency, stat rows, channel words, builds) and the planner
 * (buildById, planBuild at every purse edge, planFromTree, planKey, planSummary, and effectiveValue/blowPct/castCostPct
 * over the real trees).
 *
 * The Firmament modules are pure and fast enough to sweep every build id at several purses, plus every reachable tree
 * shape for planFromTree/planSummary. Cases are compared as whole ordered values by the codec.
 */
import * as F from '../src/firmament.js';
import * as RB from '../src/realBuild.js';
import {
  PRICES, STAT_DEFS, blowPct, castCostPct, isPrice, isStart, statDef, statWords, treeStats,
} from '../vendor/firmament/firmamentLaw.js';
import { smallStats } from '../vendor/firmament/firmamentTree.js';
import { FIRM_ADJ, FIRM_NODES, SIGNS, SERPENT, START_KEYS } from '../vendor/firmament/firmamentTree.js';
import { encodeValue as V } from './rust-codec.mjs';
import { sweep } from './rust-sweep.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `offStat` and `nodeHasOff` are module-private in src/firmament.js. Cut their exact source (the R1 method) so the
 * vectors test the real guards, not a restatement.
 */
function cutPlannerGuards() {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, '..', 'src', 'firmament.js'), 'utf8');
  const grab = (head, close) => {
    const at = text.indexOf(head);
    if (at < 0 || text.indexOf(head, at + 1) >= 0) throw new Error(`rust-firmament-vectors: \`${head.trim()}\` must be unique`);
    const end = text.indexOf(close, at);
    if (end < 0) throw new Error(`rust-firmament-vectors: no \`${close}\` closes \`${head.trim()}\``);
    return text.slice(at, end + close.length);
  };
  const fn = (head) => {
    const at = text.indexOf(head);
    if (at < 0 || text.indexOf(head, at + 1) >= 0) throw new Error(`rust-firmament-vectors: \`${head.trim()}\` must be unique`);
    const end = text.indexOf('\n}\n', at);
    if (end < 0) throw new Error(`rust-firmament-vectors: no close for \`${head.trim()}\``);
    return text.slice(at, end + 3);
  };
  const src = [
    grab('const DAMAGE_CHANNELS = new Set([', ']);'),
    grab('const WEAPON_SKILLS = new Set([', ']);'),
    grab('const FAMILY_CHANNEL = Object.freeze({', '});'),
    fn('function offStat(build, key) {'),
    fn('function nodeHasOff(node, build, { connector = false } = {}) {'),
    'return { offStat, nodeHasOff };',
  ].join('\n');
  return new Function(src)();
}

/** `skillNames` is module-private in src/firmament.js; restated here over a totals object (skill.* then skillPct.*). */
/**
 * The prices `treeStats` paid, read off the PRICES symbol (module-private in firmamentLaw.js: `pricesOf`). The vendored
 * file exports PRICES, so the vector reads the same map the group readers read.
 */
function pricesOf(totals) {
  return { ...(totals?.[PRICES] ?? {}) };
}

/**
 * `statsFromParts` is module-private in src/firmament.js. Cut its source so the `paid` guard is the real one, and give
 * it the vendored `statDef`/`PRICES` it closes over.
 */
function cutStatsFromParts() {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, '..', 'src', 'firmament.js'), 'utf8');
  const head = 'function statsFromParts(gains, prices) {';
  const at = text.indexOf(head);
  if (at < 0 || text.indexOf(head, at + 1) >= 0) throw new Error('rust-firmament-vectors: statsFromParts must be unique');
  const end = text.indexOf('\n}\n', at);
  if (end < 0) throw new Error('rust-firmament-vectors: no close for statsFromParts');
  return new Function('statDef', 'PRICES', `${text.slice(at, end + 3)}\nreturn statsFromParts;`)(
    statDef,
    PRICES,
  );
}

/**
 * `castCostPct` with an explicit price map: kept for the sky invariant probe; the generated vectors only carry trees
 * (the sky never prices a castCost channel, so the price terms of `castCostPct` are unreachable on real input).
 */
function castCostWithPrices(totals, prices, schools) {
  return castCostPct(cutStatsFromParts()(totals, prices), schools);
}

function skillNamesOf(totals) {  const out = [];
  for (const key of Object.keys(totals)) {
    const name = key.startsWith('skill.') ? key.slice(6) : key.startsWith('skillPct.') ? key.slice(9) : null;
    if (name !== null && !out.includes(name)) out.push(name);
  }
  return out;
}

export function genFirmamentFamilies(Out, makeLcg) {
  const law = new Out('firmament', 'R5d Firmament sky, law readers and the tree planner', true);
  const counts = {};
  const put = (k, args, result) => {
    law.add(k, ...args.map(V), '=>', V(result));
    counts[k] = (counts[k] ?? 0) + 1;
  };
  const r = makeLcg(0x5d2026).unit;
  const pick = (a) => a[Math.floor(r() * a.length)];

  // ---- the generated tables, once each: the sky is the vector's own oracle -------------------------------
  put('nodes', [], [...FIRM_NODES.values()].map((n) => ({ ...n, stats: { ...n.stats } })));
  put('adj', [], [...FIRM_ADJ.entries()].map(([k, vs]) => [k, [...vs]]));
  put('signs', [], { SIGNS: SIGNS.map((s) => ({ id: s.id, name: s.name })), SERPENT: { id: SERPENT.id, name: SERPENT.name }, START_KEYS: [...START_KEYS] });
  put('builds', [], F.BUILDS);
  put('constants', [], [F.FIRMAMENT_STARS, F.FIRMAMENT_NODES]);
  // Every channel key a star carries, through statDef (a miss included) and every integer in its min..max through
  // statWords. This is the whole alphabet planSummary can print.
  const nodeKeys = new Set();
  for (const n of FIRM_NODES.values()) for (const k of Object.keys(n.stats)) nodeKeys.add(k);
  const statKeys = [...new Set([...Object.keys(STAT_DEFS), ...nodeKeys])];
  // The table's own key order is the generated one: STAT_DEFS first, then the family additions; the sorted list is
  // the completeness check (every channel a star carries resolves).
  const FAMILY_KEYS = {
    skill: ['ShortBlade', 'LongBlade', 'Axe', 'BluntWeapon', 'HandToHand', 'Archery', 'CriticalStrike', 'Backstabbing', 'Dodging', 'Stealth', 'Running', 'Jumping', 'Destruction', 'Restoration', 'Illusion', 'Alteration', 'Thaumaturgy', 'Mysticism', 'Mercantile', 'Etiquette', 'Streetwise', 'Swimming', 'Climbing', 'Medical', 'Lockpicking', 'Pickpocket'],
    resist: ['fire', 'frost', 'poison', 'shock', 'magic'],
    castCost: ['Destruction', 'Restoration', 'Illusion', 'Alteration', 'Thaumaturgy', 'Mysticism'],
    yield: ['mining', 'logging', 'herbalism', 'hunting', 'fishing'],
    xp: ['mining', 'logging', 'herbalism', 'hunting', 'fishing', 'smithing', 'building', 'outfitting', 'provisioning', 'enchanting'],
    act: ['herbalism', 'fishing'],
    pct: ['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck'],
    skillPct: ['ShortBlade', 'LongBlade', 'Axe', 'BluntWeapon', 'HandToHand', 'Archery', 'CriticalStrike', 'Backstabbing', 'Dodging', 'Stealth', 'Running', 'Jumping', 'Destruction', 'Restoration', 'Illusion', 'Alteration', 'Thaumaturgy', 'Mysticism', 'Mercantile', 'Etiquette', 'Streetwise', 'Swimming', 'Climbing', 'Medical', 'Lockpicking', 'Pickpocket'],
  };
  const tableKeys = [...Object.keys(STAT_DEFS)];
  for (const [fam, args] of Object.entries(FAMILY_KEYS)) {
    for (const arg of args) if (statDef(`${fam}.${arg}`) && !tableKeys.includes(`${fam}.${arg}`)) tableKeys.push(`${fam}.${arg}`);
  }
  put('statdefs', [], tableKeys.map((k) => [k, statDef(k)]));
  put('statKeys', [], tableKeys);
  for (const key of statKeys) {
    put('statdef', [key], statDef(key));
    const d = statDef(key);
    if (!d) continue;
    for (let v = Math.floor(d.min); v <= Math.ceil(d.max); v++) put('words', [key, v], statWords(key, v));
    // -0 matches the 0 row (treeStats' own sums are integers, and -0 == 0 in the words table).
    put('words', [key, -0], statWords(key, -0));
    // A key no channel is takes the JS tail form over any value (the generated rows only hold capped integers).
    put('words', ['nope', 0.5], statWords('nope', 0.5));
  }
  // isStart over every key and near misses
  for (const k of [...START_KEYS, ...nodeKeys, 'mg.start.', 'MG.start', '', 'sp']) put('isstart', [k], isStart(k));
  // ---- buildById over ids and near misses ------------------------------------------------------------------
  const ids = F.buildIds();
  for (const id of [...ids, ...ids.map((x) => x.toUpperCase()), ...ids.map((x) => ` ${x}`), 'nope', '', null, undefined, 0, -0, NaN, 5, true, ['longblade'], { id: 'longblade' }]) {
    put('buildbyid', [id], F.buildById(id));
  }
  // ---- planBuild: every build id at every purse edge, plus forced starts -------------------------------
  const widgets = [0, 1, 2, 3, 10, 49, 97, 98, 99, -1, 0.5, 1.9, 2.5, 98.9, 1e9, Infinity, -Infinity, NaN, '98', 'x', null, undefined];
  for (const build of F.BUILDS) {
    for (const stars of widgets) put('plan', [build, { stars }], F.planBuild(build, { stars }));
    for (const start of START_KEYS) put('plan', [build, { start }], F.planBuild(build, { start }));
    for (const start of ['sp.start', 'nope.start', 'mg.start']) for (const stars of [0, 3, 20, 98]) {
      put('plan', [build, { start, stars }], F.planBuild(build, { start, stars }));
    }
  }
  // random budgets and starts over every preset (the domain is 8 builds x 23 purses x 7 starts; the sweep fills it)
  sweep(() => {
  for (let i = 0; i < 200; i++) {
    const build = pick(F.BUILDS);
    const stars = pick(widgets);
    const start = i % 3 === 0 ? pick(START_KEYS) : null;
    put('plan', [build, { stars, start }], F.planBuild(build, { stars, start }));
  }
  });
  // ---- planFromTree / planKey / planSummary on the plans' own trees, and on synthetic ones ---------------
  const plans = F.BUILDS.map((b) => F.planBuild(b, {}));
  for (const [i, plan] of plans.entries()) {
    put('summary', [plan], F.planSummary(plan));
    const opts = { start: plan.tree.start, keys: plan.tree.keys, stars: plan.stars };
    put('fromtree', [F.BUILDS[i], opts], F.planFromTree(F.BUILDS[i], opts));
    put('fromtree', [F.BUILDS[i], { start: plan.tree.start, keys: plan.tree.keys, stars: plan.stars, starBudget: 60 }], F.planFromTree(F.BUILDS[i], { start: plan.tree.start, keys: plan.tree.keys, stars: plan.stars, starBudget: 60 }));
    put('fromtree', [F.BUILDS[i], { start: plan.tree.start, keys: [...plan.tree.keys, plan.tree.keys[0], 'nope'], stars: NaN }], F.planFromTree(F.BUILDS[i], { start: plan.tree.start, keys: [...plan.tree.keys, plan.tree.keys[0], 'nope'], stars: NaN }));
    put('key', [plan.build.id, plan.stars, plan.start], F.planKey(plan.build.id, plan.stars, plan.start));
  }
  for (const build of F.BUILDS) {
    for (const stars of [0, 1, 7, 30, 98]) {
      const plan = F.planBuild(build, { stars });
      put('summary', [plan], F.planSummary(plan));
      put('fromtree', [build, { start: plan.tree.start, keys: plan.tree.keys, stars: plan.stars }], F.planFromTree(build, { start: plan.tree.start, keys: plan.tree.keys, stars: plan.stars }));
    }
  }
  for (const [stars, start] of [[0, null], [98, null], [-1, 'nope'], [Infinity, 'mg.start'], [NaN, 'sp.start'], [42.7, ''], ['98', undefined]]) {
    put('key', ['longblade', stars, start], F.planKey('longblade', stars, start));
  }
  // synthetic trees: every node alone as a start over an empty key list, the summary's hostile inputs
  for (const key of [...FIRM_NODES.keys()].slice(0, 40)) put('summary', [{ build: F.BUILDS[0], tree: { start: key, keys: [] }, totals: treeStats({ start: key, keys: [] }), score: 0, stars: 0, starBudget: 98 }], F.planSummary({ build: F.BUILDS[0], tree: { start: key, keys: [] }, totals: treeStats({ start: key, keys: [] }), score: 0, stars: 0, starBudget: 98 }));
  for (const [start, keys] of [[null, []], ['sp.start', ['nope']], ['mg.start', ['mg.c1.0', 'mg.c1.0', 'mg.start']], ['nope', ['mg.c1.0']], [undefined, ['th.c1.0']]]) {
    const totals = treeStats({ start, keys });
    put('summary', [{ build: F.BUILDS[5], tree: { start, keys }, totals, score: 0, stars: keys.length }], F.planSummary({ build: F.BUILDS[5], tree: { start, keys }, totals, score: 0, stars: keys.length }));
  }
  // ---- the law readers over every real plan's totals ---------------------------------------------------
  for (const plan of [...plans, ...F.BUILDS.flatMap((b) => [1, 20, 60, 98].map((stars) => F.planBuild(b, { stars })))]) {
    // shaking the plan's totals so the group readers see paid prices and past-cap sums too
    const totals = plan.totals;
    put('blow', [totals, { skill: plan.build.skill, group: 'daedra', unaware: true, wounded: true }], blowPct(totals, { skill: plan.build.skill, group: 'daedra', unaware: true, wounded: true }));
    put('blow', [totals, { skill: plan.build.skill }], blowPct(totals, { skill: plan.build.skill }));
    put('blow', [totals, { skill: null, group: 'undead' }], blowPct(totals, { skill: null, group: 'undead' }));
    put('blow', [totals, { skill: 'Archery', group: 'animal', unaware: true }], blowPct(totals, { skill: 'Archery', group: 'animal', unaware: true }));
    put('blow', [totals, { skill: 'nope', group: 'nope' }], blowPct(totals, { skill: 'nope', group: 'nope' }));
    put('castcost', [totals, plan.build.school ? [plan.build.school] : []], castCostPct(totals, plan.build.school ? [plan.build.school] : []));
    put('castcost', [totals, ['Destruction', 'Illusion']], castCostPct(totals, ['Destruction', 'Illusion']));
    put('castcost', [totals, ['Destruction']], castCostPct(totals, ['Destruction']));
    put('castcost', [totals, []], castCostPct(totals, []));
    put('effective', [totals, plan.build.channels.map((c) => c.key)], plan.build.channels.map((c) => F.effectiveValue(totals, c.key)));
  }
  // effectiveValue over every attribute/skill channel of a hand-built totals object at cap edges
  const synthetic = {
    strength: 20, 'pct.strength': 7, 'skill.LongBlade': 12, 'skillPct.LongBlade': 3,
    hp: 60, hpPct: 15, weaponDmg: 34, castCost: -24,
  };
  for (const key of ['strength', 'pct.strength', 'skill.LongBlade', 'skillPct.LongBlade', 'hp', 'hpPct', 'weaponDmg', 'castCost', 'nope']) {
    put('effective', [synthetic, [key]], [synthetic[key] === undefined ? F.effectiveValue(synthetic, key) : F.effectiveValue(synthetic, key)]);
  }
  // ---- synthetic builds: the planner's own branches a real preset never reaches -------------------------
  // A build whose only channel is a life stat reaches the life ring (a real preset is scored on combat channels).
  const LIFE_BUILD = { id: 'life', name: 'Life', kind: 'weapon', skill: 'LongBlade', sectors: [], channels: [{ key: 'carry', weight: 1 }] };
  const HARVEST_BUILD = { id: 'harvest', name: 'Harvest', kind: 'spell', school: null, sectors: [], channels: [{ key: 'yield.mining', weight: 1 }] };
  // A build naming both a channel and its percent: the summary's attribute and skill rows and their dedupe.
  const DUAL_BUILD = { id: 'dual', name: 'Dual', kind: 'weapon', skill: 'LongBlade', sectors: [], channels: [
    { key: 'skill.LongBlade', weight: 0.9 }, { key: 'skillPct.LongBlade', weight: 0.6 },
    { key: 'skill.CriticalStrike', weight: 0.6 }, { key: 'skillPct.CriticalStrike', weight: 0.4 },
    { key: 'strength', weight: 0.3 }, { key: 'pct.strength', weight: 0.2 },
    { key: 'pct.agility', weight: 0.18 }, { key: 'hp', weight: 0.8 }, { key: 'hpPct', weight: 0.5 },
  ] };
  for (const build of [LIFE_BUILD, HARVEST_BUILD, DUAL_BUILD]) {
    for (const stars of [0, 3, 20, 60, 98]) {
      const plan = F.planBuild(build, { stars });
      put('plan', [build, { stars }], plan);
      put('summary', [plan], F.planSummary(plan));
      put('summary', [{ build, tree: plan.tree, totals: plan.totals, score: plan.score, stars: plan.stars, starBudget: plan.starBudget }],
        F.planSummary({ build, tree: plan.tree, totals: plan.totals, score: plan.score, stars: plan.stars, starBudget: plan.starBudget }));
      put('fromtree', [build, { start: plan.tree.start, keys: plan.tree.keys, stars: plan.stars }], F.planFromTree(build, { start: plan.tree.start, keys: plan.tree.keys, stars: plan.stars }));
      put('blowtree', [plan.tree, { skill: build.skill }], blowPct(treeStats(plan.tree), { skill: build.skill }));
    }
    for (const start of START_KEYS) put('plan', [build, { start, stars: 40 }], F.planBuild(build, { start, stars: 40 }));
  }
  // P1/R2: the FULL sky's priced trees through planSummary and applyFirmament, and the shapes where a plan's
  // serialized `totals` disagrees with its `tree`. The JS attaches the price table to `plan.totals` as a hidden symbol
  // and reads the ENTRIES from that object: a lost price table printed 30 where the JS prints 21, and (R2) an empty
  // `totals` must stay empty even when the tree names a start, while a hand-edited plan whose totals disagree reads the
  // totals for every channel and the tree only for the prices.
  const FULL_SKY = [...FIRM_NODES.keys()].filter((k) => !START_KEYS.includes(k));
  const planCh = { name: 'T', level: 45, raceId: 1, stats: {}, skills: {}, career: {}, _mods: { stats: {}, statMax: {}, skills: {} }, _enchantMods: { skillMods: {} } };
  for (const build of F.BUILDS) {
    const plan = F.planFromTree(build, { start: 'sp.start', keys: FULL_SKY });
    put('summary', [plan], F.planSummary(plan));
    // applyFirmament (realBuild.js:36-63) writes `firmamentDamagePct` from blowPct(plan.totals).
    put('apply', [build, plan], RB.applyFirmament(structuredClone(planCh), plan));
    // R2a: an EMPTY totals object, with a live tree: the JS adds nothing.
    const empty = { build, tree: plan.tree, totals: {}, score: 0, stars: plan.stars, starBudget: plan.starBudget };
    put('summary', [empty], F.planSummary(empty));
    put('apply', [build, empty], RB.applyFirmament(structuredClone(planCh), empty));
    // R2b: totals that DISAGREE with the tree: the JS reads the totals (for both channels and the blow) and takes the
    // prices off the tree's treeStats.
    for (const totals of [{ weaponDmg: 7, strength: 3 }, { weaponDmg: 34, longDmg: 12 }, { strength: 9, 'pct.strength': 8, hp: 20 }]) {
      const hand = { build, tree: plan.tree, totals, score: 0, stars: 0, starBudget: 98 };
      put('summary', [hand], F.planSummary(hand));
      put('apply', [build, hand], RB.applyFirmament(structuredClone(planCh), hand));
    }
  }
  // R2c: a bogus start and a build no sign allows store `totals: {}`; the summary and the apply add nothing.
  for (const start of ['bogus', 'nope.start']) {
    const plan = F.planBuild(F.BUILDS[0], { start });
    put('summary', [plan], F.planSummary(plan));
    put('apply', [F.BUILDS[0], plan], RB.applyFirmament(structuredClone(planCh), plan));
  }
  // The same over a SMALL priced tree (`rt.k`'s weaponDmg -4 and `sh.k`'s -5): a hand arithmetic check with the cap.
  for (const [start, keys] of [['sp.start', ['sh.k']], ['sp.start', ['rt.k']], ['sp.start', ['sh.k', 'rt.k']]]) {
    for (const build of F.BUILDS) {
      put('summary', [F.planFromTree(build, { start, keys })], F.planSummary(F.planFromTree(build, { start, keys })));
    }
  }
  // planSummary(planBuild(b, { stars: n })) for n 0..98: every purse's summary (the price table on the planner's own plan).
  for (const build of F.BUILDS) {
    for (let n = 0; n <= 98; n += 1) {
      put('summary', [F.planBuild(build, { stars: n })], F.planSummary(F.planBuild(build, { stars: n })));
    }
  }
  // planFromTree with a start the sky has not, and with no keys at all
  for (const start of ['nope', '', 'sp.start', 'mg.start']) {
    put('fromtree', [F.BUILDS[0], { start }], F.planFromTree(F.BUILDS[0], { start }));
    put('fromtree', [F.BUILDS[0], { start, keys: [] }], F.planFromTree(F.BUILDS[0], { start, keys: [] }));
  }
  // ---- treeStats and blowPct on trees carrying a keystone's price (the `paid` channels) ---------------
  for (const [start, keys] of [
    ['sh.start', ['sh.c4.0', 'sh.c4.1', 'sh.k']],
    ['wr.start', ['wr.c1.0', 'wr.c5.0', 'wr.k']],
    ['rt.start', ['rt.c1.0', 'rt.k']],
    ['mg.start', ['mg.c1.0', 'mg.k']],
    ['st.start', ['st.c1.0', 'st.k']],
    ['th.start', ['th.c1.0', 'th.k']],
  ]) {
    const tree = { start, keys };
    put('treestats', [tree], treeStats(tree));
    // The prices treeStats paid ride on the totals under PRICES (a symbol); a reader pays them after its own cap.
    put('treeprices', [tree], pricesOf(treeStats(tree)));
    put('blowtree', [tree, { skill: 'LongBlade', group: 'daedra' }], blowPct(treeStats(tree), { skill: 'LongBlade', group: 'daedra' }));
    put('blowtree', [tree, { skill: null }], blowPct(treeStats(tree), { skill: null }));
    put('blowtree', [tree, { skill: 'LongBlade' }], blowPct(treeStats(tree), { skill: 'LongBlade' }));
    put('castcosttree', [tree, ['Destruction']], castCostPct(treeStats(tree), ['Destruction']));
    put('castcosttree', [tree, []], castCostPct(treeStats(tree), []));
  }
  // Full 98-star trees carry gains past a channel's cap, so a price can push a capped total to v - g == 0 (the
  // `paid` entry treeStats then omits); the small key lists above cover v - g != 0.
  for (const build of F.BUILDS) {
    const plan = F.planBuild(build, { stars: 98 });
    put('treeprices', [plan.tree], pricesOf(treeStats(plan.tree)));
    put('treestats', [plan.tree], treeStats(plan.tree));
    put('blowtree', [plan.tree, { skill: build.skill, group: 'daedra', unaware: true, wounded: true }],
      blowPct(treeStats(plan.tree), { skill: build.skill, group: 'daedra', unaware: true, wounded: true }));
    put('castcosttree', [plan.tree, build.school ? [build.school] : []], castCostPct(treeStats(plan.tree), build.school ? [build.school] : []));
  }
  // isPrice on zeros of each sign (no authored star holds one): the `v < 0` vs `v < 1` edge.
  for (const key of ['weaponDmg', 'blowTaken', 'castCost', 'hp']) {
    for (const v of [0, -0, 1, -1]) put('isprice', [key, v], isPrice(key, v));
  }
  // No star prices a castCost channel: the castCost reader's price path is unreachable from the sky.
  for (const n of FIRM_NODES.values()) {
    for (const [k, v] of Object.entries(n.stats)) {
      if ((k === 'castCost' || k.startsWith('castCost.')) && v < 0) throw new Error(`rust-firmament-vectors: ${n.key} prices ${k}`);
    }
  }
  // The authored hp/mp small stats are all >= 4, so `max(1, round(v/2))` never binds below 2.
  let minHpMp = Infinity;
  for (const n of FIRM_NODES.values()) for (const [k, v] of Object.entries(n.stats)) if (k === 'hp' || k === 'mp') minHpMp = Math.min(minHpMp, v);
  if (!(minHpMp >= 4)) throw new Error(`rust-firmament-vectors: an hp/mp star carries ${minHpMp}`);
  console.log(`PROBE minHpMp ${minHpMp}`);
  // ---- smallStats over the authored small-star rows and hostile input --------------------------------
  const smallRows = [];
  for (const n of FIRM_NODES.values()) if (n.kind === 'small' || n.kind === 'road') smallRows.push(n.stats);
  for (const stats of [...smallRows, { hp: 3 }, { hp: 5 }, { hp: 0 }, { mp: 7 }, { armor: 2 },
    { mp: 1 }, { mp: 2 }, { mp: 3 }, { hp: 1 }, { hp: 2 }, { mp: -4 }, { hp: -4 },
    { strength: 2, hp: 4, mp: 6, armor: 1 }, {}]) {
    put('smallstats', [stats], smallStats(stats));
  }
  // skillNames: every totals object's skill lines, with a duplicate across skill./skillPct.
  put('skillnames', [treeStats({ start: 'wr.start', keys: ['wr.c1.0', 'wr.c1.1', 'wr.c1.2'] })], skillNamesOf(treeStats({ start: 'wr.start', keys: ['wr.c1.0', 'wr.c1.1', 'wr.c1.2'] })));
  for (const totals of [{ 'skill.LongBlade': 5, 'skillPct.LongBlade': 4, 'skill.Axe': 2, hp: 3 }, { 'skillPct.Axe': 3 }, {}, { 'skill.LongBlade': 0 }]) {
    put('skillnames', [totals], skillNamesOf(totals));
  }
  // ---- blow/castcost synthetic totals: the floor, the total cap, a price-free object -----------------
  for (const [totals, blow] of [
    [{ weaponDmg: -30 }, { skill: null }],
    [{ weaponDmg: -20 }, { skill: null }],
    [{ weaponDmg: -19 }, { skill: null }],
    [{ weaponDmg: 30, unawareDmg: 25, rageDmg: 25 }, { skill: null, unaware: true, wounded: true }],
    [{ weaponDmg: 30, unawareDmg: 25, rageDmg: 25 }, { skill: 'LongBlade', unaware: true }],
    [{ weaponDmg: 20, meleeDmg: 20, longDmg: 20 }, { skill: 'LongBlade' }],
    [{ weaponDmg: 20, meleeDmg: 20, longDmg: 20 }, { skill: 'Archery' }],
    [{ weaponDmg: 20, daedraDmg: 20 }, { skill: null, group: 'daedra' }],
    [{ weaponDmg: 20, beastDmg: 20 }, { skill: null, group: 'animal' }],
    [{ weaponDmg: 20, undeadDmg: 20 }, { skill: null, group: 'undead' }],
    [{ castCost: 30 }, { schools: ['Destruction'] }],
    [{ castCost: 30, 'castCost.Destruction': 30 }, { schools: ['Destruction'] }],
    [{ castCost: 30, 'castCost.Destruction': 30 }, { schools: ['Destruction', 'Illusion'] }],
    [{ castCost: -30 }, { schools: [] }],
    [{}, { skill: null }],
  ]) {
    if (blow.schools) put('castcost', [totals, blow.schools], castCostPct(totals, blow.schools));
    else put('blow', [totals, blow], blowPct(totals, blow));
  }
  // words: the tail form (a key no channel is) at 0, and -0 on the defined rows
  put('words', ['nope', 0], statWords('nope', 0));
  put('words', ['nope', -0], statWords('nope', -0));
  put('words', ['nope', 2], statWords('nope', 2));
  // isPrice over every authored star stat (plus the zero edge the generated data never holds)
  for (const n of FIRM_NODES.values()) for (const [k, v] of Object.entries(n.stats)) put('isprice', [k, v], isPrice(k, v));
  for (const v of [0, -0, 1, -1]) put('isprice', ['blowTaken', v], isPrice('blowTaken', v));

  // A build whose channel has no statDef, and one whose sector no start allows: the planner's two "no answer" arms.
  const NODEF_BUILD = { id: 'nodef', name: 'No Def', kind: 'weapon', skill: 'LongBlade', sectors: [], channels: [{ key: 'no.such.channel', weight: 1 }] };
  const NOSECTOR_BUILD = { id: 'nosector', name: 'No Sector', kind: 'weapon', skill: 'LongBlade', sectors: ['zz'], channels: [{ key: 'strength', weight: 1 }] };
  for (const build of [NODEF_BUILD, NOSECTOR_BUILD]) {
    for (const stars of [0, 5, 98]) {
      const plan = F.planBuild(build, { stars });
      put('plan', [build, { stars }], plan);
      put('summary', [plan], F.planSummary(plan));
    }
  }
  // effectiveValue's percent fold: `Math.floor((100 * pct) / 100)` vs a mutant `(101 * pct) / 100`. Every `pct.*` and
  // `skillPct.*` total the sky produces is an integer below 100 in magnitude, so the fold is exactly `pct` and the
  // mutant would add a whole point. Assert the invariant and pin the extreme totals.
  let extreme = 0;
  for (const build of F.BUILDS) {
    for (const plan of [F.planBuild(build, { stars: 98 })]) {
      for (const [k, v] of Object.entries(plan.totals)) {
        if (k.startsWith('pct.') || k.startsWith('skillPct.')) {
          if (!Number.isInteger(v)) throw new Error(`rust-firmament-vectors: ${k} total ${v} is not an integer`);
          extreme = Math.max(extreme, Math.abs(v));
        }
      }
    }
  }
  if (extreme >= 100) throw new Error(`rust-firmament-vectors: a percent total reaches ${extreme}; the effectiveValue floor probes must change`);
  console.log(`PROBE maxPercentTotal ${extreme}`);
  for (const [totals, key] of [
    [{ 'skill.LongBlade': -90, 'skillPct.LongBlade': 99 }, 'skill.LongBlade'],
    [{ strength: -90, 'pct.strength': 99 }, 'strength'],
    // The percent fold's floor at a fractional percent: `floor((100*99.5)/100)` is 99, a mutant `(101*99.5)/100` is
    // 100.495 -> 100. The sky's own percents are integers (max 20, asserted above), so only a hand-made totals
    // reaches this; the port must still follow the JS on it.
    [{ strength: -90, 'pct.strength': 99.5 }, 'strength'],
    [{ 'skill.LongBlade': -390, 'skillPct.LongBlade': 199.5 }, 'skill.LongBlade'],
    [{ strength: 3, 'pct.strength': 7 }, 'strength'],
    [{ 'skill.LongBlade': 3, 'skillPct.LongBlade': 7 }, 'skill.LongBlade'],
  ]) put('effective', [totals, [key]], [F.effectiveValue(totals, key)]);
  // A forced start at a keystone and at a life keystone: the BFS root guard (`pathsFrom`), unreachable from the presets.
  for (const build of [F.BUILDS[0], LIFE_BUILD]) {
    for (const start of ['mg.k', 'mg.lk', 'wr.k', 'sp.start']) put('plan', [build, { start, stars: 12 }], F.planBuild(build, { start, stars: 12 }));
  }
  // A weapon build whose sectors allow the Thief: the thief's `bowDmg: 1` road is off-build for a long blade, and the
  // value is exactly 1 (the `> 0` guard's edge).
  const TH_BUILD = { id: 'thblade', name: 'Thief Blade', kind: 'weapon', skill: 'LongBlade', sectors: ['th', 'sh'], channels: [{ key: 'skill.LongBlade', weight: 0.9 }, { key: 'strength', weight: 0.3 }] };
  for (const stars of [3, 12, 40, 98]) put('plan', [TH_BUILD, { stars }], F.planBuild(TH_BUILD, { stars }));
  // The planner's two guards, cut from the real source (they are module-private): every build x every channel a star
  // or a build names, so a flipped comparison or a >= swap fails.
  const { offStat, nodeHasOff } = cutPlannerGuards();
  const channelKeys = new Set();
  for (const b of F.BUILDS) for (const c of b.channels) channelKeys.add(c.key);
  for (const n of FIRM_NODES.values()) for (const k of Object.keys(n.stats)) channelKeys.add(k);
  for (const build of [...F.BUILDS, LIFE_BUILD, DUAL_BUILD, NODEF_BUILD]) {
    for (const key of [...channelKeys].sort()) put('offstat', [build, key], offStat(build, key));
  }
  for (const key of [...FIRM_NODES.keys()]) {
    for (const build of [F.BUILDS[0], F.BUILDS[6], LIFE_BUILD]) {
      put('nodehasoff', [key, build, false], nodeHasOff(FIRM_NODES.get(key), build));
      put('nodehasoff', [key, build, true], nodeHasOff(FIRM_NODES.get(key), build, { connector: true }));
    }
  }
  put('nodehasoff', [null, F.BUILDS[0], false], nodeHasOff(null, F.BUILDS[0]));
  // statsFromParts over hand pairs: the `paid` guard's edges (a price that lands exactly on the cap, a price that
  // leaves v - g == 0, a price of 0), which a real star list rarely forms.
  for (const [gains, prices] of [
    [{ weaponDmg: 40 }, { weaponDmg: -10 }],    [{ weaponDmg: 40 }, { weaponDmg: -9 }],
    [{ weaponDmg: 40 }, { weaponDmg: -1 }],
    [{ weaponDmg: 30 }, { weaponDmg: -5 }],
    [{ weaponDmg: 20 }, { weaponDmg: -1 }],
    [{ weaponDmg: 0 }, { weaponDmg: -1 }],
    [{ weaponDmg: 1 }, { weaponDmg: -1 }],
    [{ hp: 75 }, { hp: -1 }],
    [{ hp: 75 }, { hp: -74 }],
    [{}, { weaponDmg: -1 }],
    [{ weaponDmg: -30 }, {}],
    [{ weaponDmg: -20 }, { weaponDmg: 1 }],
    [{ castCost: 10 }, { castCost: -1 }],
    [{ spellPower: 40 }, { spellPower: -1 }],
    // A price of -0 and a gain of 0: `v - g == 0` there, so the `paid` entry is skipped; the `&&` flip would add one,
    // and the `-`->`+` flip would add a zero-value row too.
    [{ weaponDmg: 0 }, { weaponDmg: -0 }],
    [{ hp: 0 }, { hp: 0 }],
    [{ weaponDmg: -20 }, { weaponDmg: -0 }],
    [{ weaponDmg: 5 }, { weaponDmg: -5 }],
    // A nonzero price whose capped total lands back on the gain (g at the channel's floor): v - g == 0, so the
    // correct guard skips the PAID entry while the `&&`->`||` flip adds a zero row and `-`->`+` sees a nonzero sum.
    [{ weaponDmg: -20 }, { weaponDmg: -5 }],
    [{ weaponDmg: -20 }, { weaponDmg: -1 }],
  ]) {
    const stats = cutStatsFromParts()({ ...gains }, { ...prices });
    put('statsparts', [gains, prices], [{ ...stats }, pricesOf(stats)]);
  }  // No star prices a castCost channel: the castCostPct price terms are 0 on every reachable tree.
  let pricedCastCost = 0;
  for (const n of FIRM_NODES.values()) for (const [k, v] of Object.entries(n.stats)) {
    if ((k === 'castCost' || k.startsWith('castCost.')) && v < 0) pricedCastCost++;
  }
  if (pricedCastCost) throw new Error(`rust-firmament-vectors: ${pricedCastCost} stars price a castCost channel`);
  console.log('rust-firmament-vectors:', counts);
  return { firmament: law.write() };
}
