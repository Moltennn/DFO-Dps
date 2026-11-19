import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as T from '../src/theory.js';
import * as G from '../src/gearProfile.js';
import * as M from '../src/maxprofile.js';
import * as I from '../src/imprints.js';
import { MARTIAL_PATHS, MATERIALS, WEAPONS } from '../src/data.js';
import { gateTarget, referenceFoe } from '../src/model.js';
import { arena2Dir, configPath } from '../src/save.js';
import { readSpellsStd } from '../src/spells.js';
import { perfectSockets } from '../src/sockets.js';
import { AFFIX_KINDS, AFFIX_RANGES } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { encodeValue as V } from './rust-codec.mjs';

const templates = Object.keys(WEAPONS).map(Number);
const races = [...Object.keys(T.THEORY_RACES), ...Object.values(T.THEORY_RACES), 'DARKELF', 'unknown', 0, -0, 9, NaN, null];
const levels = [undefined, -1, -0, 1, 9, 10, 15, 21, 30, 44, 45, 46, 60, Infinity, NaN, '45', null];
const edges = [-Infinity, -21, -20, -19, -16, -15, -14, -1, -0, 0, 1, 14, 15, 16, 19, 20, 21, 24, 25, 26, 29, 30, 31, 38, 39, 40, 41, 99, 100, 101, 199, 200, 201, 534, 535, 536, 727, 728, 729, NaN, Infinity];

export function genPlanningFamilies(Out, makeLcg) {
  const theory = new Out('theory', 'R5c ordered theory characters and blade replacements', true);
  const gear = new Out('gear_profile', 'R5c legal gear plans, slot options, and exact diagnostics', true);
  const profiles = new Out('maxprofile', 'R5c full max runs and ordered evaluated legal frontiers', true);
  const imprints = new Out('imprints', 'R5c full ordered imprint rankings and carried reprices', true);
  const counts = {};
  const put = (out, k, args, result) => {
    out.add(k, ...args.map(V), '=>', V(result));
    counts[`${out.module}_${k}`] = (counts[`${out.module}_${k}`] ?? 0) + 1;
  };
  const r = makeLcg(0x5c2026).unit;
  const pick = a => a[Math.floor(r() * a.length)];
  const n = () => pick(edges);
  const paths = [undefined, null, ...Object.keys(MARTIAL_PATHS), 'unknown', false];
  const mats = [...new Set([...Object.keys(MATERIALS).map(Number).filter(Number.isFinite), ...Array.from({ length: 10 }, (_, i) => i)]), undefined, null, '9', -1];
  const dir = arena2Dir();
  if (!dir) throw new Error(`rust-planning-vectors: no ARENA2 in ${configPath()}; SPELLS.STD is required`);
  const book = readSpellsStd(readFileSync(resolve(dir, 'SPELLS.STD')));
  if (!book.length) throw new Error('rust-planning-vectors: empty SPELLS.STD');
  for (const out of [profiles, imprints]) out.add('book', V(book));
  put(theory, 'constants', [], [T.LONG_BLADES, T.GEAR_LINE_MAX, T.DAMAGE_AFFIX_MAX, T.GEAR_MASTERY_CAP,
    T.GEAR_MASTERY_POINTS, T.GEAR_LB_LINES, T.GEAR_CS_LINES, T.GEAR_SKILL_LINES, T.GEAR_H2H_LINES]);
  put(gear, 'constants', [], [G.SKILL_IDS, Object.values(G.SKILL_BAND_TOP), Object.values(G.AFFIX_DAMAGE_TOP), G.EXALTED_SKILL_FLOOR]);
  put(gear, 'all', [], G.allRecords());
  for (let i = 0; i < 8 * levels.length * templates.length; i++) {
    const blade = templates[i % templates.length];
    const raceIndex = Math.floor(i / templates.length) % 8;
    const levelIndex = Math.floor(i / (8 * templates.length));
    const material = mats[(i + raceIndex + levelIndex) % mats.length];
    const starStats = Object.fromEntries(Object.keys(T.THEORY_STATS).map((k, p) => [k, edges[(p + i) % edges.length]]));
    const starSkills = { 34: n(), 29: n(), 30: n(), 19: n(), 0: n(), 35: n(), '-1': 15, '1.5': 12, '033': 16, nonsense: 14 };
    if (i % 17 === 0) starStats.x = '15';
    const o = { blade: i & 8 ? String(blade) : blade, material, race: races[raceIndex + (i & 1 ? 8 : 0)],
      level: levels[levelIndex], rawBlade: n(), rawCrit: n(), rawBackstab: n(),
      gearLB: i % 13 ? n() : '5', gearCS: n(), damagePct: n(), vampire: !!(i & 1), starStats, starSkills,
      starDamage: edges[i % edges.length], sockets: pick([null, [], perfectSockets(blade), ['perfect-ruby', null, 'ruby']]),
      martialPath: pick(paths), online: !!(i & 2) };
    const ch = T.theoryCharacter(o);
    put(theory, 'character', [o], ch);
    const f = { ...o, rawH2H: n(), gearH2H: n(), gearCrit: n(), wraps: pick([undefined, false, true, { name: 'Custom', affixes: [], tag: NaN }, []]) };
    put(theory, 'fists', [f], T.theoryFists(f));
    const b = pick(templates);
    put(theory, 'blade', [o, b, material], T.theoryBlade(ch, b, material));
    const g = { gearSkill: o.gearLB, gearCrit: o.gearCS, damagePct: o.damagePct, firmament: !!(i & 2), vampire: o.vampire, race: o.race };
    const safe = { ...g, gearSkill: (i * 13) % 731, gearCrit: (i * 17) % 731, damagePct: i % 42 };
    const max = M.buildMax(blade, safe);
    put(profiles, 'build', [blade, g], M.buildMax(blade, g));
    const run = i % 3 === 0 ? { gate: true } : i % 3 === 1 ? { target: referenceFoe(1 + i % 60, 'tough') } : {};
    const edits = i % 7 ? {} : { _pair: i % 14 === 0, _dual: true, online: false };
    put(profiles, 'run', [blade, safe, edits, run], M.maxRun({ ...max, ...edits }, run));
  }
  for (const blade of [null, 'unknown', 0, 112, 564, 123.5, NaN]) {
    try { T.theoryCharacter({ blade }); throw new Error('expected refusal'); }
    catch (e) { if (e.message === 'expected refusal') throw e; put(theory, 'refusal', [{ blade }], e.message); }
  }
  put(theory, 'character', [{}], T.theoryCharacter());
  for (const race of races.slice(16)) put(theory, 'character', [{ race }], T.theoryCharacter({ race }));
  put(theory, 'fists', [{}], T.theoryFists());
  const defaultBuild = M.buildMax(123);
  put(profiles, 'build', [123, {}], defaultBuild);
  const noHealth = { ...referenceFoe(45, 'tough'), bossTraits: ['curbing'] };
  delete noHealth.maxHealth;
  put(profiles, 'run', [123, {}, {}, { target: noHealth }], M.maxRun(defaultBuild, { target: noHealth }));

  const slots = [...[...templates, 513, 514, 515].map(t => [t, 'Weapons']), ...[...G.ARMOUR_SLOTS, 109, 110, 111, 112].map(t => [t, 'Armor']),
    ...[...new Set([...G.JEWEL_SLOTS, 139])].map(t => [t, 'Jewellery']), ...['MensClothing', 'WomensClothing'].flatMap(g => Array.from({ length: 21 }, (_, i) => [141 + i, g])),
    [123, 'Other'], ['123', 'Weapons']];
  for (const [t, g] of slots) for (const skill of G.SKILL_IDS) {
    put(gear, 'slot', [t, g, skill], [G.rolledSkills(t, g), G.canRollSkill(t, g, skill), G.canExaltSkillHere(t, g), G.recordsFor(t, g), G.slotOptions(t, g, skill)]);
  }
  for (const g of ['Weapons', 'Armor', 'Jewellery', 'MensClothing', 'WomensClothing', 'Other']) {
    const ids = Object.keys(AFFIX_KINDS).filter(id => AFFIX_KINDS[id].groups.includes(g));
    for (const missing of [undefined, ...ids]) {
      const record = { affixes: ids.filter(id => id !== missing).map(id => ({ id, param: AFFIX_KINDS[id].params?.[0] })) };
      put(gear, 'exalt', [record, g], G.exaltedKinds(record, g));
    }
  }
  const maxTemplate = templates.filter(t => !WEAPONS[t].ammo);
  const shields = [null, 109, 110, 111, 112];
  for (const t of templates) {
    put(imprints, 'fit', [t], I.imprintsFor(t));
    for (const shield of shields) {
      const o = { weaponTemplate: t, shield };
      const total = G.legalTotals(o);
      const point = G.legalPointTotals(o);
      put(gear, 'totals', [o], [G.slotsFor(o), total, point, G.maxPointTotal(o), G.maxSingleSkill(o)]);
      put(profiles, 'frontier', [t, { shield }], M.legalFrontier(t, { shield }));
      for (const metric of ['uncapped', 'capped', 'allowance']) {
        const opts = { shield, metric };
        put(profiles, 'legal', [t, opts], M.legalGear(t, opts));
      }
    }
    for (const firmament of [false, true]) for (const vampire of [false, true]) {
      const o = { firmament, vampire, race: pick(races.slice(0, 16)) };
      put(profiles, 'max', [t, o], M.maxCharacter(t, o));
    }
  }
  const cachedShield = { shield: '112', metric: 'capped' };
  put(profiles, 'legal', ['123', cachedShield], M.legalGear('123', cachedShield));
  // The caller may optimize any of the 35 skills, not just the host's skill.
  // The cross-product compares all ordered channel triples; the default-skill
  // sweep above additionally compares every per-slot plan and its key order.
  const channels = fs => fs.map(({ lb, cs, dmg }) => [lb, cs, dmg]);
  put(gear, 'totals', [{}], [G.slotsFor(), G.legalTotals(), G.legalPointTotals(), G.maxPointTotal(), G.maxSingleSkill()]);
  for (const weaponTemplate of templates) for (const shield of shields) for (const skill of G.SKILL_IDS) {
    const o = { weaponTemplate, shield, skill };
    put(gear, 'budget', [o], [channels(G.legalTotals(o)), channels(G.legalPointTotals(o))]);
  }
  const o = { shield: 112, metric: 'allowance' };
  put(profiles, 'plan', [123, o], M.legalGearPlan(123, o));
  for (const [t, o] of [[999, {}], [123, { metric: 'unknown' }]]) {
    try { M.legalGear(t, o); throw new Error('expected refusal'); }
    catch (e) { if (e.message === 'expected refusal') throw e; put(profiles, 'refusal', [t, o], e.message); }
  }
  for (const [id, kind] of Object.entries(AFFIX_KINDS)) {
    for (const rarity of ['magic', 'rare', 'legendary', 'other']) {
      const band = AFFIX_RANGES[id]?.[rarity];
      const floor = band && Math.ceil((band[0] + band[1]) / 2);
      const top = band?.[1];
      for (const value of [...(band ? [floor - 1, floor, floor + 1, top - 1, top, top + 1] : []), -1, NaN, Infinity, '999']) {
        for (const param of [undefined, kind.params?.[0], 'invalid', 34]) {
          const line = { id, param, value };
          const p = { template: 123, group: 'Weapons', rarity, record: 'warp-edge', exalted: true, lines: [line] };
          put(gear, 'validate', [[p]], G.validatePlan([p]));
        }
      }
    }
  }
  for (const r of G.allRecords()) for (const template of (r.templates ?? [123, 102, 135])) {
    for (const exalted of [false, true]) for (const size of [0, 1, 2, 3, 4, 5]) {
      const lines = [...r.affixes.map(a => ({ ...a, value: a.value + 1 })).slice(0, size)];
      while (lines.length < size) lines.push({ id: 'skill', param: 29, value: 25 });
      const p = { template, group: r.group, rarity: 'legendary', record: r.id, exalted, lines };
      put(gear, 'validate', [[p]], G.validatePlan([p]));
    }
  }
  for (const rarity of ['magic', 'rare', 'other', 'legendary']) for (const size of [0, 1, 2, 3, 4, 5]) {
    const p = { template: 135, group: 'Jewellery', rarity, lines: Array.from({ length: size }, () => ({ id: 'skill', param: 29, value: 30 })) };
    put(gear, 'validate', [[p]], G.validatePlan([p]));
  }
  for (const lines of [[{ id: 'unrecognized', param: 34, value: 100 }], [{ id: 'damage', value: 38 }, { id: 'skill', param: 34, value: 30 }]]) {
    for (const rarity of ['legendary', 'rare']) for (const exalted of [false, true]) {
      const p = { template: 123, group: 'Weapons', rarity, record: 'warp-edge', exalted, lines };
      put(gear, 'validate', [[p]], G.validatePlan([p]));
    }
  }
  for (const id of [...I.IMPRINT_FAMILIES.map(f => f.key.toUpperCase()), 'other']) {
    put(imprints, 'lookup', [id], I.imprintFamilyById(id));
  }
  for (const firmament of [false, true]) for (const vampire of [false, true]) for (const sort of ['base', 'conditional', 'uncapped']) {
    const o = { firmament, vampire, sort };
    put(imprints, 'rank_all', [o], I.rankAll(o));
    for (const f of I.IMPRINT_FAMILIES) put(imprints, 'rank', [f, o], I.rankFamily(f, o));
  }
  for (const t of maxTemplate) {
    const f = { key: 'custom', name: 'Custom', templates: [t, 999, ...pick(I.IMPRINT_FAMILIES).templates, t] };
    put(imprints, 'rank', [f, {}], I.rankFamily(f));
  }
  const empty = { key: 'empty', template: -1, templates: [999] };
  put(imprints, 'rank', [empty, {}], I.rankFamily(empty));
  for (const templates of [[123, '123'], ['123', 123]]) {
    const tied = { key: 'tie', templates };
    put(imprints, 'rank', [tied, {}], I.rankFamily(tied));
  }
  const raw = referenceFoe(45, 'tough');
  const breach = gateTarget(45);
  for (let i = 0; i < 2048; i++) {
    const t = pick(maxTemplate);
    const o = { gearSkill: i % 729, gearCrit: i % 536, damagePct: i % 41, firmament: !!(i & 4) };
    const p = I.WEAPON_IMPRINTS[i % I.WEAPON_IMPRINTS.length].power;
    const conditional = !!(i & 1), capped = !!(i & 2);
    const target = i & 8 ? breach : raw;
    const base = M.maxRun(M.buildMax(t, o), { target });
    put(imprints, 'power', [p, t, o, target, conditional, capped], I.powerDps(p, base, conditional, { capped }));
  }
  console.log('rust-planning-vectors:', counts);
  return Object.fromEntries([theory, gear, profiles, imprints].map(out => [out.module, out.write()]));
}
