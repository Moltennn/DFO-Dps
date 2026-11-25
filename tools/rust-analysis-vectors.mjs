import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as M from '../src/model.js';
import { arena2Dir, configPath } from '../src/save.js';
import { readSpellsStd, spellsByIndexMap } from '../src/spells.js';
import { theoryCharacter } from '../src/theory.js';
import { armourPiece, equipArmour, standInTarget } from '../src/target.js';
import { allowanceSpec } from '../src/allowance.js';
import { CURB_SHARE, WARD_SHARE } from '../src/data.js';
import { ENCHANTMENT_TYPES as E } from '../vendor/upstream/a3eb1605/src/systems/enchantments.js';
import { encodeValue as V } from './rust-codec.mjs';

const bits = new DataView(new ArrayBuffer(8));
function around(x) {
  if (x === 0) return [-Number.MIN_VALUE, -0, 0, Number.MIN_VALUE];
  bits.setFloat64(0, x);
  const i = bits.getBigUint64(0);
  return [i - 1n, i, i + 1n].map(n => { bits.setBigUint64(0, n); return bits.getFloat64(0); });
}

export function genAnalysisFamilies(Out, makeLcg) {
  const dir = arena2Dir();
  if (!dir) throw new Error(`rust-analysis-vectors: no ARENA2 in ${configPath()}; SPELLS.STD is required`);
  const stock = readSpellsStd(readFileSync(resolve(dir, 'SPELLS.STD')));
  if (!stock.length) throw new Error('rust-analysis-vectors: empty SPELLS.STD');
  const effect = (type, mag) => ({ type, subType: 0, magnitudeBaseLow: mag, magnitudeBaseHigh: mag + 4,
    magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1, durationBase: 3, durationMod: 0, durationPerLevel: 1 });
  const records = [...stock, ...[[effect(1, 6)], [effect(4, 12)], [effect(1, 3), effect(4, 30)]].map((effects, k) => ({
    index: 240 + k, name: `Analysis probe ${k}`, element: k, rangeType: 0, effects,
  })), ...[[4, 0], [1, 0], [1, -1]].map(([type, low], k) => ({
    index: 243 + k, name: `Small claim probe ${k}`, element: 0, rangeType: 0,
    effects: [{ ...effect(type, low), magnitudeBaseHigh: 1 }],
  }))];
  const standard = spellsByIndexMap(records);
  const out = new Out('analysis', 'R5b full ordered analysis cards, target constructors and what-if ranks', true);
  const counts = {};
  const put = (kind, args, expected) => {
    out.add(kind, ...args.map(V), '=>', V(expected));
    counts[kind] = (counts[kind] ?? 0) + 1;
  };
  out.add('book', V(records));
  put('body_level', [], M.GATE_BODY_LEVEL);
  const r = makeLcg(0xa5b2026).unit;
  const pick = a => a[Math.floor(r() * a.length)];
  const templates = Object.keys(M.WEAPONS).map(Number).filter(k => !M.WEAPONS[k].ammo);
  const paths = [null, ...Object.keys(M.MARTIAL_PATHS)];
  const edges = [undefined, -5, ...[0, 1, 5, 16, 41, 50, 61, 76, 92, 100, 101, 110].flatMap(around)];
  const representativeWeapons = [null, null, 113, 117, 123, 124, 129, 130, 560, 562];
  const upgrades = ['perfect-ruby', 'perfect-sapphire', 'ruby'];
  const item = (k, i) => ({ ...M.syntheticWeapon(k, i % 10)?.item,
    currentCondition: [0, 1, 9, 10, 39, 40, 61, 76, 92, 100, undefined][i % 11], maxCondition: 100,
    rarity: 'rare', affixes: [{ id: 'damage', value: 5 + i % 13 }, { id: 'slayer', param: 'daedra', value: 12 }],
    sockets: i % 3 ? [] : [upgrades[i % upgrades.length], 'perfect-ruby'],
    enchantments: [{ type: E.CastWhenStrikes, param: pick([240, 241, 242, ...stock.map(sp => sp.index)]) }, { type: pick([E.PotentVs, E.LowDamageVs, E.CastWhenStrikes]), param: pick([0, 1, 2, 242]) }],
  });
  const build = (i, k) => {
    const ch = theoryCharacter({ race: i % 8 + 1, level: pick([1, 2, 9, 10, 21, 30, 45, 60]), blade: k || 117,
      martialPath: paths[i % paths.length], rawBlade: pick(edges), rawCrit: pick(edges), gearLB: i % 39, online: !!(i & 4),
      starStats: { strength: i % 15, agility: i % 12, speed: i % 21 } });
    ch.online = !!(i & 4);
    ch.weapon = k ? item(k, i) : null;
    ch.offWeapon = item(pick([113, 117, 124, 125]), i + 23);
    if (i % 7 === 0) ch.wraps = item(561, i + 24);
    for (const k of ['strength', 'agility', 'speed', 'luck', 'willpower', 'endurance']) ch.stats[k] = pick([25, 35, 50, 70, 95, 105, ...edges]);
    for (const skill of [M.SKILLS.Axe, M.SKILLS.HandToHand, M.SKILLS.Archery, M.SKILLS.BluntWeapon, M.SKILLS.ShortBlade, 19]) ch.skills[skill] = pick(edges);
    return ch;
  };
  const argsOf = (i) => ({
    core: i & 2 ? 'overhaul' : 'classic', rri: !!(i & 4), passiveOn: !!(i & 8), critDamage: !(i & 16),
    swing: pick(['random', 'random', 'random', ...M.SWING_DIRECTIONS, 'unknown']),
    dual: !!(i & 32), pair: !!(i & 64), offHand: !!(i & 128), enchants: i % 17 !== 0,
    backstabChance: pick([undefined, -4, ...[0, 1, 100].flatMap(around), 23, NaN]), backstabUptime: pick([...around(0), 0.25, 0.5, ...around(1)]),
    healthShare: pick([undefined, ...around(0.5), 0, 1]), attackerHealthShare: pick([undefined, ...around(0.5), 1]),
    stacks: pick([0, 1, ...around(5), 10]), flowStacks: pick([0, 5, 10]), rhythm: !!(i & 1), unaware: !!(i & 4), firstBlow: !!(i & 8),
    bowSpam: !!(i & 16), bowDrawback: !!(i & 32), equipmentDamageEnhanced: !!(i & 8), softMaterialRequirements: !!(i & 16),
    potencyPct: pick([-5, 0, 5, 17.5, 35, 100]), pierce: pick([0, 0.2, 1, 2, 30]), potentVs: pick([...around(0), -10, -5, 5, 15]),
    imprints: i % 5 ? [{ kind: 'echo', chance: pick([1, 20, 33, 100]) }] : [],
    firmamentDamagePct: i % 8 + 0.1,
  });
  const ref = (level, opts) => M.referenceFoe(level, opts);
  const boss = (_, opts) => M.bossTarget(opts);
  const gate = (level, opts) => M.gateTarget(level, opts);
  const grid = () => { for (const [kind, make] of [['ref', ref], ['boss', boss], ['gate', gate], ['relay', (_, supplied) => supplied]]) {
    for (let i = 0; i < 2048; i++) {
      const level = pick([undefined, -1, ...around(1), 2, 9, 10, 21, 30, 45, ...around(60), 70, NaN, '31']);
      const health = pick([0, -1, 500, 10000, ...around(0.5 / CURB_SHARE), ...around(1.5 / CURB_SHARE), ...around(0.5 / WARD_SHARE), ...around(1.5 / WARD_SHARE)]);
      const traits = pick([[], ['curbing'], ['warded', 'wrathful'], ['bladeturning', 'curbing'], ['spellproof', 'stoneskin'], ['arrowproof'], ['fireproof', 'warded', 'curbing']]);
      const cap = pick([...around(0), ...around(Math.max(1, Math.round(health * CURB_SHARE))), 60]);
      const group = pick([undefined, null, 'animal', 'undead', 'daedra', 'humanoid']);
      const players = pick([undefined, -1, ...around(1), ...around(2), 4, '3']);
      const makeOpts = kind === 'ref'
        ? pick([undefined, 'tough', 'soft', 'armoured', 'human', 'unknown', { isClass: !!(i & 1), armorValue: i % 15 - 10, group, healthShare: pick([0, 0.49, 0.5, 1]) }])
        : kind === 'boss' ? { level, health, traits, group, hitCap: cap, phaseShields: pick([-1, 0, 2]), shieldSeconds: pick([-1, 0, 3]),
          ...(i % 3 ? { isClass: !!(i & 1), armorValue: i % 15 - 8, careerIndex: i % 43, career: { endurance: 90, strength: i % 104, willpower: 75 }, minMetalToHit: i % 10 } : { mobileType: pick([0, 7, 14, 31, 36, 128, 146]) }) }
        : kind === 'gate' ? { health: i % 3 ? undefined : health, traits: i % 3 ? undefined : traits, hitCap: i % 3 ? undefined : cap, players, blowX: pick([...around(1), 1.125, 2, NaN]) }
        : { ...standInTarget(i % 2 ? 31 : 36), bossTraits: traits, level, relayBody: true, warded: !!(i & 1), hitCap: cap, allowance: allowanceSpec(level, { players, openingS: i % 7, immunityShare: i % 4 / 8 }) };
      const target = make(level, makeOpts);
      const worn = i % 6 === 0;
      const k = i % 4 === 0 ? pick(templates) : pick(representativeWeapons);
      const ch = build(i, k);
      const extra = { ...argsOf(i), health: i % 3 ? target.health : health };
      if (i % 11 === 0) extra.weapon = pick([null, M.syntheticWeapon(pick(templates), i % 10), undefined]);
      if (i % 13 === 0) extra.traits = traits;
      if (i % 17 === 0) extra.stuff = undefined;
      const overlays = { ...(i % 23 === 0 ? { watchful: true } : {}), ...(i % 19 === 0 ? { revenant: { edge: { watchful: true } } } : {}) };
      const patched = { ...target, ...overlays };
      const pieces = worn ? [armourPiece(102, 512, { condition: i % 2 ? 0.6 : 1 }), armourPiece(109 + i % 4, 512)] : [];
      const defended = worn ? equipArmour(patched, pieces) : patched;
      // R3 separately tests armour minting. Feed the worn target to analyze; otherwise compose
      // the Rust target builder with analysis and apply only the scenario overlays.
      const actualTarget = kind === 'ref' && i % 71 === 0 ? undefined : defended;
      const result = M.analyze(ch, { ...extra, target: actualTarget, standard });
      put(kind, [level, makeOpts, ch, extra, actualTarget && !worn ? null : actualTarget, overlays], [target, result]);
    }
  } };

  const probe = (ch, opts) => put('probe', [ch, opts], M.analyze(ch, { ...opts, standard }));
  const sword = { ...M.syntheticWeapon(117, 5).item, enchantments: [{type: E.CastWhenStrikes, param: 241}] };
  const axe = { ...M.syntheticWeapon(124, 6).item, enchantments: [{type: E.CastWhenStrikes, param: 242}] };
  const ch = theoryCharacter({ blade: 117, level: 31, rawBlade: 107, rawCrit: 91, martialPath: 'assassin' });
  ch.weapon = sword;
  ch.offWeapon = axe;
  const focal = { swing: 'StrikeDown', health: 400, dual: false, firstBlow: true };
  const target = M.bossTarget({ level: 31, health: 400, traits: [], armorValue: -3, phaseShields: 2, shieldSeconds: 3 });
  const { backstab, damage, enchantProcs } = M.analyze(ch, { ...focal, target, standard });
  if (enchantProcs.length !== 1 || !(enchantProcs[0].damage > 0)) throw new Error('missing instant strikes probe');
  if (!(M.analyze({ ...ch, weapon: axe }, { ...focal, target, standard }).enchantDotDps > 0)) throw new Error('missing DoT strikes probe');
  for (const cap of [0, 1, damage.min, damage.max, backstab.min, backstab.critMax].flatMap(around)) {
    probe(ch, { ...focal, target: { ...target, hitCap: cap } });
  }
  for (const health of [0, 0.5 / CURB_SHARE, 1.5 / CURB_SHARE, 0.5 / WARD_SHARE, 1.5 / WARD_SHARE].flatMap(around)) {
    const curbing = Math.max(1, Math.round(health * CURB_SHARE));
    for (const hitCap of around(curbing)) probe(ch, { ...focal, health, target: { ...target, hitCap, bossTraits: ['curbing', 'warded'] } });
  }
  for (const chance of [0, 1, 100].flatMap(around)) {
    for (const uptime of [0, 1].flatMap(around)) {
      for (const watchful of [false, true]) probe(ch, { ...focal, target: { ...target, watchful }, backstabChance: chance, backstabUptime: uptime });
    }
  }
  for (const a of [null, 240, 241, 242, 243, 244, 245]) for (const b of [null, 240, 241, 242, 243, 244, 245]) {
    const payload = param => param == null ? [] : [{ type: E.CastWhenStrikes, param }];
    for (const level of [1, 60]) {
      const gate = M.gateTarget(level, {health: 1000, players: 2});
      const gear = { ...ch, weapon: { ...sword, enchantments: payload(a) }, offWeapon: { ...axe, enchantments: payload(b) } };
      probe(gear, { ...focal, target: gate, dual: true, health: gate.health, passiveOn: false });
      probe({ ...gear, weapon: { ...M.syntheticWeapon(562, 2).item, enchantments: payload(a) } },
        { ...focal, target: gate, pair: true, health: gate.health, passiveOn: false });
      if (b === null) probe(gear, { ...focal, target: gate, health: gate.health });
    }
  }
  for (const condition of [0, 10, 16, 41, 61, 76, 92, 100].flatMap(around)) {
    probe({ ...ch, weapon: { ...sword, currentCondition: condition, maxCondition: 100 } }, { ...focal, target });
  }
  for (const armor of [0, 1, 2, 3, 4, 5].flatMap(around)) for (const soft of [false, true]) {
    probe(ch, { ...focal, target: { ...target, minMetalToHit: sword.material + armor }, softMaterialRequirements: soft });
  }
  for (const t of [undefined, {}, { level: null }, { phaseShields: 2 }, { shieldSeconds: 3 }, { allowance: { players: 1, level: 30 } }]) {
    for (const health of [undefined, 0, ...around(1), 400]) probe(ch, { target: t, health, swing: 'StrikeLeft' });
  }
  probe(ch, { ...focal, target: { ...target, allowance: { players: 1, level: 30 } }, health: 0.25, potentVs: 0 });
  probe(ch, { ...focal, target: { ...target, allowance: { players: 1, level: 30 } }, health: 0.25, potentVs: 0, weapon: null });
  probe(ch, { ...focal, target, backstabChance: 0, backstabUptime: 1, backstabBonus: -70 });
  probe({ ...ch, firmamentDamagePct: undefined }, { ...focal, target, carried: true });
  probe(ch, { ...focal, swing: 'random', target: { ...target, armorValues: [NaN] } });
  probe({ ...ch, skills: {}, stats: {} }, { ...focal, target: { ...target, armorValues: Array(7).fill(-1000) }, core: 'classic', critDamage: false, weapon: { ...M.syntheticWeapon(113, 0), min: 1, max: 1 } });
  for (const c of [0, 2, 5]) {
    probe({ ...ch, weapon: null, offWeapon: null, wraps: null }, { ...focal, target: { ...target, hitCap: c, minMetalToHit: 100 }, softMaterialRequirements: false, potentVs: 0 });
  }
  for (let i = 0; i < 28; i++) {
    const ch = build(i, [null, 113, 117, 123, 124, 129, 560, 562][i % 8]);
    if (i % 5 === 0) {
      Object.assign(ch.stats, { strength: NaN, agility: -0, speed: undefined, luck: Infinity });
      ch._mods = i % 2 ? undefined : { skills: { [M.SKILLS.CriticalStrike]: NaN }, stats: { strength: -0 } };
      if (ch.weapon) ch.weapon.affixes.push(undefined, { id: 'damage', value: NaN });
    }
    const scenario = { core: i % 2 ? 'classic' : 'overhaul', swing: i % 4 === 0 ? 'random' : 'StrikeDown', rri: !!(i & 4), health: 400, potentVs: -5,
      target: i % 2 ? M.gateTarget(17, {health: 400}) : M.referenceFoe(19, {group: 'animal'}), ...(i % 3 === 0 ? {weapon: M.syntheticWeapon(123, 3)} : {}) };
    if (i === 1) {
      ch._mods = { skills: {}, stats: {} };
      ch.stats.strength = 39; // +10 vs +11 crosses the classic strength damage step at 50.
    }
    if (i === 2) ch.skills = [];
    if (i === 3) ch.skills = Array(M.SKILLS.LongBlade).fill(50);
    if (i === 27) Object.assign(scenario, { core: 'overhaul', weapon: M.syntheticWeapon(117, 0), target: M.bossTarget({ minMetalToHit: 100 }), softMaterialRequirements: false, potentVs: 0 });
    const opts = i === 0 ? { top: 1000 } : { top: pick([undefined, -3, 0, 4, 1000]), materials: pick([0, 1, 2, 4, 10.1]) };
    const edit = { imprint: i % 2 ? { kind: 'echo', chance: 75 } : null, attackSpeedPct: 5, potentVs: 5 };
    const full = { ...scenario, standard };
    const base = M.analyze(ch, full);
    if (i === 27 && base.cappedDps !== 0) throw new Error('missing zero-DPS rank baseline');
    put('ranks', [ch, scenario, opts, edit], [M.marginals(ch, base, full), M.rankAffixes(ch, base, full), M.rankWeapons(ch, full, opts), M.currentWeaponRow(ch, full), base.with(edit)]);
  }
  for (const opts of [{}, { isClass: true }, { armorValue: -5 }, { mobileType: 31 }]) {
    const target = M.bossTarget(opts);
    put('boss_defaults', [opts], target);
  }
  for (const opts of [{mobileType: 31, armorValue: 0}, {mobileType: 36, isClass: false, career: {}}, {mobileType: 39}, {mobileType: -1}]) {
    let err;
    try { M.bossTarget(opts); } catch (e) { err = e; }
    if (!err) throw new Error('expected bossTarget to reject invalid input');
    put('refusal', [opts], err.name === 'RangeError' ? null : err.message);
  }
  grid();
  // The shipped-build selector (`--game-build`, CHANGELOG-MECHANICS.md GEAR-14631 / BRAND-14631): full analysis cards
  // under both builds, one gear-heavy theory character over a curbing boss and a plain reference foe, plus brand
  // powers. Appended last, so every case above keeps its bytes. `14512` must equal the default exactly.
  for (const gameBuild of ['14512', '14631']) {
    for (const gearLB of [0, 250, 700]) {
      const ch = theoryCharacter({ race: 4, level: 45, blade: 123, rawBlade: 200, rawCrit: 200, gearLB, gearCS: 370, damagePct: 15 });
      for (const target of [
        M.bossTarget({ level: 45, health: 4000, traits: ['curbing'] }),
        M.referenceFoe(45, 'tough'),
      ]) {
        const extra = { target, health: target.health || 4000, gameBuild, swing: 'StrikeLeft', core: 'overhaul', rri: true };
        put('probe', [ch, extra], M.analyze(ch, { ...extra, standard }));
      }
    }
    // A brand power rides `opts.imprints`, so the flat accumulator is visible on the card's blow.
    const ch = theoryCharacter({ blade: 121, level: 45, rawBlade: 200, rawCrit: 200, gearLB: 400 });
    const brand = { kind: 'brand', element: 'fire', flat: 8 };
    for (const target of [M.referenceFoe(45, 'tough'), { ...M.referenceFoe(45, 'tough'), career: { resistanceFlags: 8 } }]) {
      const extra = { target, health: 4000, gameBuild, swing: 'StrikeLeft', imprints: [brand] };
      put('probe', [ch, extra], M.analyze(ch, { ...extra, standard }));
    }
  }
  const total = out.write();
  console.log('rust-analysis-vectors:', counts);
  return { analysis: total };
}
