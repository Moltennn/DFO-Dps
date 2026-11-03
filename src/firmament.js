/*
 * dfo-dps - Firmament tree planner.
 *
 * The tree and its caps are the game's own (vendor/firmament). A build is a
 * set of channels that matter to it; the planner walks the real 518-star table
 * one connected path at a time, taking the path with the best channel gain per
 * star until the 98-star purse is spent. This is a channel-coverage plan, not
 * a claim that no other 98-star path scores higher: it is deterministic, uses
 * the live caps, and never walks through a keystone.
 */
import {
  FIRM_ADJ, FIRM_BOUNDS, FIRM_EDGES, FIRM_NODES, SERPENT, SIGNS, START_KEYS,
} from '../vendor/firmament/firmamentTree.js';
import {
  PRICES, blowPct, castCostPct, isPrice, isStart, statDef, statWords, treeStats,
} from '../vendor/firmament/firmamentLaw.js';

export const FIRMAMENT_STARS = 98;
export const FIRMAMENT_NODES = FIRM_NODES.size;

const tol = 1e-9;
const PLAN_CACHE = new Map();
const signName = (id) => (id === SERPENT.id ? SERPENT.name : (SIGNS.find((s) => s.id === id)?.name ?? id));

const WEAPON_ATTRS = [
  { key: 'strength', weight: 0.30 },
  { key: 'pct.strength', weight: 0.20 },
  { key: 'agility', weight: 0.25 },
  { key: 'pct.agility', weight: 0.18 },
  { key: 'speed', weight: 0.30 },
  { key: 'pct.speed', weight: 0.20 },
  { key: 'luck', weight: 0.15 },
  { key: 'pct.luck', weight: 0.12 },
];

const weaponBuild = (id, name, skill, extra = [], attrs = WEAPON_ATTRS) => ({
  id, name, skill, kind: 'weapon',
  channels: [
    { key: `skill.${skill}`, weight: 0.90 },
    { key: `skillPct.${skill}`, weight: 0.60 },
    { key: 'skill.CriticalStrike', weight: 0.60 },
    { key: 'skillPct.CriticalStrike', weight: 0.40 },
    ...attrs,
    ...extra,
  ],
});

/** The build presets. `skill` is the weapon skill whose blow group the tree is read against. */
export const BUILDS = Object.freeze([
  weaponBuild('longblade', 'Long Blade', 'LongBlade'),
  weaponBuild('shortblade', 'Short Blade', 'ShortBlade'),
  weaponBuild('axe', 'Axe', 'Axe', [{ key: 'endurance', weight: 0.10 }, { key: 'pct.endurance', weight: 0.08 }]),
  weaponBuild('blunt', 'Blunt Weapon', 'BluntWeapon', [{ key: 'endurance', weight: 0.12 }, { key: 'pct.endurance', weight: 0.08 }]),
  weaponBuild('bow', 'Bow', 'Archery', [], [
    { key: 'strength', weight: 0.12 },
    { key: 'pct.strength', weight: 0.08 },
    { key: 'agility', weight: 0.35 },
    { key: 'pct.agility', weight: 0.25 },
    { key: 'speed', weight: 0.35 },
    { key: 'pct.speed', weight: 0.25 },
    { key: 'luck', weight: 0.20 },
    { key: 'pct.luck', weight: 0.15 },
  ]),
  weaponBuild('fists', 'Hand-to-Hand', 'HandToHand', [{ key: 'endurance', weight: 0.12 }, { key: 'pct.endurance', weight: 0.08 }], [
    { key: 'strength', weight: 0.40 },
    { key: 'pct.strength', weight: 0.28 },
    { key: 'agility', weight: 0.30 },
    { key: 'pct.agility', weight: 0.22 },
    { key: 'speed', weight: 0.32 },
    { key: 'pct.speed', weight: 0.22 },
    { key: 'luck', weight: 0.18 },
    { key: 'pct.luck', weight: 0.14 },
  ]),
  {
    id: 'destruction', name: 'Destruction', kind: 'spell', school: 'Destruction',
    channels: [
      { key: 'spellPower', weight: 1.00 },
      { key: 'castSpeed', weight: 0.70 },
      { key: 'skill.Destruction', weight: 0.80 },
      { key: 'skillPct.Destruction', weight: 0.50 },
      { key: 'intelligence', weight: 0.40 },
      { key: 'pct.intelligence', weight: 0.30 },
      { key: 'mp', weight: 0.30 },
      { key: 'mpPct', weight: 0.22 },
      { key: 'mpRegen', weight: 0.28 },
      { key: 'castCost.Destruction', weight: 0.35 },
    ],
  },
  {
    id: 'tank', name: 'Tank', kind: 'tank',
    channels: [
      { key: 'hp', weight: 0.80 },
      { key: 'hpPct', weight: 0.50 },
      { key: 'hpRegen', weight: 0.30 },
      { key: 'armor', weight: 0.55 },
      { key: 'evade', weight: 0.55 },
      { key: 'absorb', weight: 0.35 },
      { key: 'blowTaken', weight: 0.85, invert: true },
      { key: 'spellTaken', weight: 0.65, invert: true },
      { key: 'resist.fire', weight: 0.25 },
      { key: 'resist.frost', weight: 0.25 },
      { key: 'resist.poison', weight: 0.25 },
      { key: 'resist.shock', weight: 0.25 },
      { key: 'resist.magic', weight: 0.30 },
      { key: 'endurance', weight: 0.40 },
      { key: 'pct.endurance', weight: 0.28 },
      { key: 'willpower', weight: 0.30 },
      { key: 'pct.willpower', weight: 0.22 },
    ],
  },
]);

const BUILD_BY_ID = new Map(BUILDS.map((b) => [b.id, b]));
export const buildById = (id) => BUILD_BY_ID.get(String(id).toLowerCase()) ?? null;
export const buildIds = () => BUILDS.map((b) => b.id);

/** A channel's contribution to a build's score: its share of the live cap. */
function channelScore(totals, spec) {
  const def = statDef(spec.key);
  if (!def) return 0;
  const value = totals[spec.key] ?? 0;
  if (spec.invert) return (Math.max(0, -value) / Math.max(1, Math.abs(def.min))) * spec.weight;
  return (Math.max(0, Math.min(def.max, value)) / def.max) * spec.weight;
}

function scoreTree(totals, build) {
  let score = 0;
  if (build.skill) score += Math.max(0, Math.min(30, blowPct(totals, { skill: build.skill }))) / 30;
  if (build.school) score += Math.max(0, Math.min(25, castCostPct(totals, [build.school]))) / 25 * 0.7;
  for (const spec of build.channels) score += channelScore(totals, spec);
  return score;
}

function combatKeys(start) {
  return [...FIRM_NODES.keys()].filter((k) => k !== start && FIRM_NODES.get(k)?.ring === 'combat');
}

/**
 * One breadth-first walk from the allocated stars to every reachable star.
 * A keystone can be reached but not walked through; another sign's start is
 * closed. This replaces a BFS per target, which made a full page take ~28s.
 */
function pathsFrom(tree) {
  const have = new Set([tree.start, ...tree.keys]);
  const from = new Map();
  const queue = [];
  for (const key of have) {
    const node = FIRM_NODES.get(key);
    if (!node) continue;
    if (node.kind === 'keystone' || (node.kind === 'start' && key !== tree.start)) continue;
    from.set(key, null);
    queue.push(key);
  }
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i];
    for (const next of FIRM_ADJ.get(key) ?? []) {
      if (from.has(next) || isStart(next)) continue;
      from.set(next, key);
      if (FIRM_NODES.get(next)?.kind !== 'keystone') queue.push(next);
    }
  }
  return { from, have };
}

function pathFor(paths, target) {
  if (paths.have.has(target) || !paths.from.has(target)) return [];
  const out = [];
  for (let at = target; at && !paths.have.has(at); at = paths.from.get(at) ?? null) out.push(at);
  return out.reverse();
}

/** Sum a node's stats into the gains/prices pair the way treeStats reads them. */
function addParts(gains, prices, node) {
  for (const [key, value] of Object.entries(node?.stats ?? {})) {
    if (isPrice(key, value)) prices[key] = (prices[key] ?? 0) + value;
    else gains[key] = (gains[key] ?? 0) + value;
  }
}

/** treeStats without rebuilding a tree: the same gains capped, then the price paid. */
function statsFromParts(gains, prices) {
  const out = {};
  const paid = {};
  for (const key of new Set([...Object.keys(gains), ...Object.keys(prices)])) {
    const def = statDef(key);
    if (!def) continue;
    const gain = Math.max(def.min, Math.min(def.max, gains[key] ?? 0));
    const value = Math.max(def.min, Math.min(def.max, gain + (prices[key] ?? 0)));
    if (value !== 0) out[key] = value;
    if (prices[key] && value - gain) paid[key] = value - gain;
  }
  Object.defineProperty(out, PRICES, { value: Object.freeze(paid) });
  return Object.freeze(out);
}

function greedy(start, build, budget) {
  const chosen = [];
  const taken = new Set();
  const candidates = combatKeys(start);
  let tree = { start, keys: [] };
  const gains = {};
  const prices = {};
  addParts(gains, prices, FIRM_NODES.get(start));
  let totals = statsFromParts(gains, prices);
  let score = scoreTree(totals, build);

  while (chosen.length < budget) {
    const room = budget - chosen.length;
    const paths = pathsFrom(tree);
    let best = null;
    for (const key of candidates) {
      if (taken.has(key)) continue;
      const path = pathFor(paths, key);
      if (!path.length || path.length > room) continue;
      const nextGains = { ...gains };
      const nextPrices = { ...prices };
      for (const k of path) addParts(nextGains, nextPrices, FIRM_NODES.get(k));
      const nextTotals = statsFromParts(nextGains, nextPrices);
      const nextScore = scoreTree(nextTotals, build);
      const gain = nextScore - score;
      if (gain <= tol) continue;
      const ratio = gain / path.length;
      if (!best || ratio > best.ratio + tol || (Math.abs(ratio - best.ratio) <= tol && gain > best.gain)) {
        best = { path, gain, ratio, score: nextScore, totals: nextTotals, gains: nextGains, prices: nextPrices };
      }
    }
    if (!best) break;
    for (const k of best.path) {
      chosen.push(k);
      taken.add(k);
    }
    tree = sortTree({ start, keys: chosen.slice().sort() });
    score = best.score;
    totals = best.totals;
    if (best.gains) {
      for (const k of Object.keys(gains)) delete gains[k];
      for (const k of Object.keys(prices)) delete prices[k];
      Object.assign(gains, best.gains);
      Object.assign(prices, best.prices);
    }
  }
  return { tree: { start, keys: chosen.slice().sort() }, totals: statsFromParts(gains, prices), score, stars: chosen.length };
}

// A stable tree object (keys sorted) so pathTo/treeStats see the same shape.
function sortTree(tree) {
  tree.keys.sort();
  return tree;
}

/** Rebuild a plan from its persisted tree without running the search. */
export function planFromTree(build, { start, keys, stars, starBudget = FIRMAMENT_STARS }) {
  const startKey = FIRM_NODES.has(start) ? start : START_KEYS[0];
  const clean = Array.isArray(keys) ? [...new Set(keys.filter((k) => FIRM_NODES.has(k) && k !== startKey))].sort() : [];
  const tree = { start: startKey, keys: clean };
  return {
    build, tree, totals: treeStats(tree), score: 0,
    stars: Number.isFinite(stars) ? Number(stars) : clean.length,
    freeStars: Math.max(0, (Number.isFinite(starBudget) ? Number(starBudget) : FIRMAMENT_STARS) - (Number.isFinite(stars) ? Number(stars) : clean.length)),
    start: startKey,
    startName: signName(FIRM_NODES.get(startKey)?.sector ?? 'sp'),
    starBudget: Number.isFinite(starBudget) ? Number(starBudget) : FIRMAMENT_STARS,
  };
}

/** The stable key for a plan: the build, the purse, and the forced start (if any). */
export const planKey = (buildId, stars, start = null) => `${buildId}|${Number(stars)}|${start ?? ''}`;

/** Plan one build. Every start sign is tried; the best channel score wins. */
export function planBuild(build, { stars = FIRMAMENT_STARS, start = null } = {}) {
  const budget = Math.max(0, Math.min(FIRMAMENT_STARS, Math.trunc(Number(stars) || 0)));
  const key = planKey(build?.id ?? '?', budget, start);
  const hit = PLAN_CACHE.get(key);
  if (hit) return hit;
  const starts = start ? [start] : START_KEYS;
  let best = null;
  for (const st of starts) {
    if (!FIRM_NODES.has(st)) continue;
    const plan = greedy(st, build, budget);
    if (!best || plan.score > best.score + tol || (Math.abs(plan.score - best.score) <= tol && plan.stars > best.stars)) best = plan;
  }
  const startKey = best?.tree.start ?? START_KEYS[0];
  const plan = {
    build,
    ...(best ?? { tree: { start: startKey, keys: [] }, totals: {}, score: 0, stars: 0 }),
    start: startKey,
    startName: signName(FIRM_NODES.get(startKey)?.sector ?? 'sp'),
    starBudget: budget,
    freeStars: Math.max(0, budget - (best?.stars ?? 0)),
  };
  PLAN_CACHE.set(key, plan);
  return plan;
}

/** The readable summary of a plan: tree words, group reads, and the stars taken. */
export function planSummary(plan) {
  const { totals, build } = plan;
  const rows = [];
  const relevant = new Set((build?.channels ?? []).map((c) => c.key));
  if (build?.skill) {
    const blow = Math.max(0, Math.min(30, blowPct(totals, { skill: build.skill })));
    rows.push({ key: 'blow', label: 'Weapon blow (group)', value: blow, text: `${blow}% damage with ${build.name.toLowerCase()} (group cap 30)` });
  }
  if (build?.school) {
    const cost = Math.max(0, Math.min(25, castCostPct(totals, [build.school])));
    rows.push({ key: 'castCost', label: 'Spell cost (group)', value: cost, text: `${cost}% cheaper ${build.school} spells (group cap 25)` });
  }
  for (const [key, value] of Object.entries(totals)) {
    if (!value || !relevant.has(key)) continue;
    rows.push({ key, label: key, value, text: statWords(key, value) });
  }
  rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.key.localeCompare(b.key));
  const nodes = plan.tree.keys.map((k) => FIRM_NODES.get(k)).filter(Boolean);
  const picked = nodes.filter((n) => n.kind === 'notable' || n.kind === 'keystone');
  return {
    rows,
    nodes,
    picked,
    notables: picked.filter((n) => n.kind === 'notable'),
    keystones: picked.filter((n) => n.kind === 'keystone'),
    freeStars: Math.max(0, (plan.starBudget ?? FIRMAMENT_STARS) - plan.stars),
    counts: {
      small: nodes.filter((n) => n.kind === 'small').length,
      road: nodes.filter((n) => n.kind === 'road').length,
      notable: picked.filter((n) => n.kind === 'notable').length,
      keystone: picked.filter((n) => n.kind === 'keystone').length,
    },
  };
}

const KIND_COLOR = { start: '#e0b76a', keystone: '#c25b4e', notable: '#c08a3e', small: '#7fae6a', road: '#6fa8dc' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The sky, with the plan lit and the rest of the 518 stars kept as context. */
export function firmamentSvg(plan, { height = 720 } = {}) {
  const b = FIRM_BOUNDS;
  const lit = new Set([plan.tree.start, ...plan.tree.keys]);
  // Crop to the lit path, not the whole 2,600-unit sky, so the plan fills the panel.
  const litNodes = [...lit].map((k) => FIRM_NODES.get(k)).filter(Boolean);
  const pad = 170;
  const x0 = Math.max(b.x0 - 40, Math.min(...litNodes.map((n) => n.x)) - pad);
  const x1 = Math.min(b.x1 + 40, Math.max(...litNodes.map((n) => n.x)) + pad);
  const y0 = Math.max(b.y0 - 40, Math.min(...litNodes.map((n) => n.y)) - pad);
  const y1 = Math.min(b.y1 + 40, Math.max(...litNodes.map((n) => n.y)) + pad);
  const viewBox = `${x0} ${y0} ${x1 - x0} ${y1 - y0}`;
  const edges = FIRM_EDGES.map((e) => {
    const on = lit.has(e.a) && lit.has(e.b);
    return `<line x1="${e.a ? FIRM_NODES.get(e.a).x : 0}" y1="${e.a ? FIRM_NODES.get(e.a).y : 0}" x2="${FIRM_NODES.get(e.b)?.x ?? 0}" y2="${FIRM_NODES.get(e.b)?.y ?? 0}" stroke="${on ? '#c08a3e' : '#2b241c'}" stroke-width="${on ? 2.2 : 1}" opacity="${on ? 0.95 : 0.7}"/>`;
  }).join('');
  const nodes = [...FIRM_NODES.values()].map((n) => {
    const on = lit.has(n.key);
    const color = on ? (KIND_COLOR[n.kind] ?? '#e9e4d9') : '#2b241c';
    const r = on ? (n.kind === 'start' ? 22 : n.kind === 'keystone' ? 14 : n.kind === 'notable' ? 11 : n.kind === 'road' ? 8 : 7) : 3;
    return `<circle cx="${n.x}" cy="${n.y}" r="${r}" fill="${color}" stroke="${on ? '#12100e' : 'none'}" stroke-width="2"><title>${esc(n.name)} - ${n.kind}${n.stats ? ` - ${Object.entries(n.stats).map(([k, v]) => esc(statWords(k, v))).join(', ')}` : ''}</title></circle>`;
  }).join('');
  const labels = [...FIRM_NODES.values()]
    .filter((n) => lit.has(n.key) && (n.kind === 'start' || n.kind === 'keystone'))
    .map((n) => `<text x="${n.x + 28}" y="${n.y + 10}" fill="#e9e4d9" font-size="30" paint-order="stroke" stroke="#12100e" stroke-width="6">${esc(n.name)}</text>`)
    .join('');
  return `<svg viewBox="${viewBox}" width="100%" height="${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Firmament tree for ${esc(plan.build?.name ?? 'a build')}" style="display:block;max-width:100%">
    <rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#12100e"/>
    ${edges}${nodes}${labels}
  </svg>`;
}

/** HTML block for one plan: the tree, the channel totals and the stars taken. */
export function firmamentSection(plan) {
  const sum = planSummary(plan);
  const channelRows = sum.rows.slice(0, 30).map((r) => `<tr><td class="k">${esc(r.text)}</td><td>${r.value}</td></tr>`).join('');
  const notableRows = sum.picked.map((n) => `<tr><td class="k">${esc(n.name)}</td><td>${esc(n.kind)}</td><td>${esc(signName(n.sector))}</td><td style="white-space:normal;min-width:280px">${Object.entries(n.stats).map(([k, v]) => esc(statWords(k, v))).join(', ')}</td></tr>`).join('');
  const table = `<div class="table"><h3>What the tree gives</h3><table><thead><tr><th>Channel</th><th>Value</th></tr></thead><tbody>${channelRows}</tbody></table></div>
    <div class="table"><h3>Notables and keystones</h3><table><thead><tr><th>Star</th><th>Kind</th><th>Sign</th><th>Stats</th></tr></thead><tbody>${notableRows || '<tr><td colspan="4">none</td></tr>'}</tbody></table></div>`;
  return {
    title: `${plan.build.name} - ${plan.startName}, ${plan.stars}/${plan.starBudget} stars${sum.freeStars ? ` (${sum.freeStars} free)` : ''}`,
    note: `Channel plan: ${sum.counts.small} small, ${sum.counts.road} road, ${sum.counts.notable} notable, ${sum.counts.keystone} keystone. The plan stops when no remaining star adds to this build, so the free points
are yours. The weapons page +Firmament column is the flat channel ceiling (+15 STR/AGI/SPEED/LUCK, +15 weapon/Critical Strike/Backstabbing, +30% blow); this is a real 98-star path, so it may leave some of those short. It never walks through a keystone.`,
    chart: `<div style="font-size:12px;color:#a8a092;margin:0 0 8px"><span style="color:#e0b76a">&#9679; start</span> &nbsp; <span style="color:#7fae6a">&#9679; small</span> &nbsp; <span style="color:#6fa8dc">&#9679; road</span> &nbsp; <span style="color:#c08a3e">&#9679; notable</span> &nbsp; <span style="color:#c25b4e">&#9679; keystone</span></div>${firmamentSvg(plan)}`,
    table,
  };
}
