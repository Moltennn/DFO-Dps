import * as S from '../src/spells.js';
import * as E from '../src/enchants.js';
import * as D from '../src/enchantData.js';
import * as B from '../src/bossTraits.js';
import { theoryCharacter } from '../src/theory.js';
import { SKILLS } from '../src/data.js';
import { RACE_KEYS } from '../vendor/upstream/a3eb1605/src/systems/races.js';
import { eliteRng } from '../vendor/upstream/a3eb1605/src/systems/eliteFoes.js';
import { fightingClimb } from '../vendor/upstream/a3eb1605/src/systems/spell/spellPower.js';
import { encodeValue as V } from './rust-codec.mjs';
import { readSpellBook } from './rust-synth-book.mjs';
import { sweep } from './rust-sweep.mjs';

export function genSpellFamilies(Out, makeLcg) {
  const { path, bytes, records: stock } = readSpellBook('rust-spell-vectors');
  if (!stock.some(({ cost }) => cost > 255 && cost % 256 !== (cost >> 8))) {
    throw new Error(`rust-spell-vectors: ${path} has no readable nontrivial little-endian cost`);
  }
  console.log(`rust-spell-vectors: ${path} (${bytes.length} bytes, ${stock.length} parsed records)`);

  const out = new Out('spells', 'R5a: raw record bytes, explicit spellbooks, cost, saving throws, spell cards and rotations');
  const counts = {};
  const put = (kind, args, result) => { out.add(kind, ...args.map(V), '=>', V(result)); counts[kind] = (counts[kind] ?? 0) + 1; };
  put('target_cost_table', [], Object.entries(S.TARGET_COST_MULT).map(([k, v]) => [Number(k), v]));
  const book = (kind, records, arg) => put(kind, [arg], [records, [...S.spellsByIndexMap(records)]]);
  book('stock', stock, bytes.toString('hex'));
  for (let o = 0; o < bytes.length; o += S.SPELL_RECORD_SIZE) {
    put('record', [bytes.subarray(o, o + S.SPELL_RECORD_SIZE).toString('hex'), 0], S.readSpellRecord(bytes, o));
  }
  const r = makeLcg(0xb00c).unit;
  const int = n => Math.floor(r() * n);
  const pick = a => a[int(a.length)];
  const edges = [-Infinity, -200, -100, -50, -1, -0, 0, Number.MIN_VALUE, 0.000000001, 0.5, 1, 2, 4.999999999999999, 5, 5.000000000000001, 9.9999, 10, 20, 25, 30, 49.99999999999999, 50, 50.00000000000001, 94.99999999999999, 95, 95.00000000000001, 99, 100, 100.00000000000001, 101, 110, 111, 200, 300, Infinity, NaN];
  const keys = [...Object.keys(S.EFFECT_COST_TABLE).map(k => k.split(',').map(Number)), [126, 0], [0, 254], [4, 255], [-1, -1]];
  const effect = ([type, subType], roll = int) => ({ type, subType: subType === 255 ? -1 : subType,
    durationBase: roll(20), durationMod: roll(10), durationPerLevel: roll(7), chanceBase: roll(255), chanceMod: roll(255), chancePerLevel: roll(6),
    magnitudeBaseLow: roll(50), magnitudeBaseHigh: roll(255), magnitudeLevelBase: roll(50), magnitudeLevelHigh: roll(255), magnitudePerLevel: roll(12),
  });
  const custom = [
    { index: 240, name: 'Synthetic mixed', effects: [effect([4, 0]), effect([1, 0]), effect([11, 8])], element: 0, rangeType: 1 },
    { index: 241, name: 'Synthetic DoT', effects: [effect([1, 0]), effect([1, 0])], element: 3, rangeType: 4 },
    { index: 242, name: 'Synthetic ordinary', effects: [effect([4, 0])], element: 4, rangeType: 0 },
    { index: 243, name: 'Floor edge', effects: [{ ...effect([4, 0]), magnitudeBaseLow: 1, magnitudeBaseHigh: 1, magnitudeLevelBase: 0, magnitudeLevelHigh: 0 }], element: 2, rangeType: 0 },
  ];
  const combined = [...stock, ...custom, { ...custom[0], name: 'Must not override' }];
  book('custom_book', combined, combined);
  const standard = S.spellsByIndexMap(combined);
  const patchRecords = Buffer.alloc(S.SPELL_RECORD_SIZE * 4 + 88, 255);
  for (const [i, [index, type, subtype]] of [[10, 3, 2], [10, 4, 2], [11, 3, 2], [10, 3, 0]].entries()) {
    const o = i * S.SPELL_RECORD_SIZE;
    patchRecords[o] = type;
    patchRecords[o + 1] = subtype;
    patchRecords[o + 73] = index;
  }
  book('parse_book', S.readSpellsStd(patchRecords), patchRecords.toString('hex'));
  const schools = [...new Set(Object.values(S.EFFECT_COST_TABLE).map(e => e.skill))];
  const targets = [null, {}, { isPlayer: true }];
  for (let id = 1; id <= 8; id++) {
    targets.push({ isPlayer: true, raceId: id, race: 'miss' }, { isPlayer: true, raceId: `${id}`, race: RACE_KEYS[id - 1] });
  }
  for (const trait of B.ELEMENT_TRAITS) targets.push({ bossTraits: [trait], stats: { willpower: 85 }, group: 'animal' });
  targets.push({ isPlayer: true, raceTemplate: { immunityFlags: 1, lowToleranceFlags: 8, criticalWeaknessFlags: 32, resistanceFlags: 4 },
    career: { resistanceFlags: 3, immunityFlags: 16, lowToleranceFlags: 32, criticalWeaknessFlags: 64 },
    biographyResistMagicMod: '7.25', biographyResistPoisonMod: 9, biographyResistDiseaseMod: -11,
    _mods: { resist: { fire: 0.25, frost: 4.5, shock: -2.5, poison: 2.25, magic: 1.5 } },
    stats: { willpower: 97.5 }, activeEffects: [{ kind: 'fortifyAttribute', stat: 'willpower', magnitude: 12 }] });
  const chars = Array.from({ length: 60 }, (_, i) => {
    const base = theoryCharacter({ race: i % 8 + 1, level: [1, 2, 3, 4, 5, 9, 20, 45][i % 8] });
    for (const [j, id] of schools.entries()) base.skills[id] = [0, 10, 50, 90, 99, 100, 100.00000000000001, 101, 110, 200][(i + j) % 10];
    base.masteredSkills.push(...schools.slice(0, i % 7));
    base.online = !!(i % 2);
    base.stats = { ...base.stats, speed: edges[i % edges.length], intelligence: (i % 51) + 20.25 };
    base.maxMagicka = [undefined, 0, 4, 5, 6, 20, 170, 1024][i % 8];
    return { stats: base.stats, skills: base.skills, level: base.level, masteredSkills: base.masteredSkills,
      masterSkills: base.masterSkills, maxMagicka: base.maxMagicka, online: base.online, _mods: base._mods };
  });
  const card = (sp, ch, t, opts, mode = 'avg') => put('card', [sp, ch, t, opts, mode], [S.spellCost(sp, ch, opts), S.spellDamage(sp, ch, t, { ...opts, mode }), S.castRate(ch, opts), S.analyzeSpell(sp, ch, t, opts), S.spellRotation(sp, ch, t, opts)]);
  const mk = (type, mag, rounds = 0) => ({ ...effect([type, 0]), magnitudeBaseLow: mag, magnitudeBaseHigh: mag, magnitudeLevelBase: 0, magnitudeLevelHigh: 0,
    durationBase: rounds, durationMod: 0, durationPerLevel: 1 });
  // A save or custom record may carry `element`/`rangeType` as strings: the JS coerces them as property keys (the
  // element's flag, the range's cost) and not in its strict compares (the proof trait, the race flags).
  const strings = ['0', '2', '3', '4', '5', '02', ' 2', null].map((element) => ({ element, rangeType: 0 }))
    .concat(['0', '2', '3', '4', '02', null].map((rangeType) => ({ element: 0, rangeType })));
  for (const t of targets.filter((x) => x?.bossTraits || x?.raceTemplate || x?.raceId === 4)) {
    for (const spec of strings) card({ effects: [mk(4, 400)], ...spec }, {}, t, {});
  }
  const pureDot = { effects: [mk(1, 8, 1)] };
  const ch = { maxMagicka: 1000, skills: { [SKILLS.Destruction]: 104 } };
  const thresholdSave = S.spellDamage({ effects: [mk(4, 1)] }, {}, {}).saving;
  const mixed = { effects: [mk(4, 1 / thresholdSave), mk(1, 8, 0.25)] };
  for (const sp of [pureDot, mixed, { effects: [mk(1, 8, 0.25)] }, { effects: [mk(4, 8)] }, { effects: [{type: 4, subType: 0}] }]) {
    for (const seconds of [0, 0.5, 1.3, 1.75, 2.5, 5, 5.000000000000001]) {
      const opts = { seconds, manaSolved: false };
      const health = S.spellRotation(sp, ch, {}, opts).totalDamage;
      card(sp, ch, {}, { ...opts, health });
      card(sp, {}, {}, { seconds, health });
    }
  }
  card({ effects: [{ ...mk(4, 10), magnitudeLevelBase: 1, magnitudeLevelHigh: 2, magnitudePerLevel: 1 }] }, {}, {}, {});
  // A save's custom record may carry its effect fields as strings (or omit them): the JS `+`/`-`/`Math.floor` coerce
  // them, and a missing one is `undefined` (NaN in arithmetic). Both sides must price the same.
  for (const fields of [
    { magnitudeBaseLow: '10', magnitudeBaseHigh: '20', magnitudeLevelBase: '1', magnitudeLevelHigh: '2', magnitudePerLevel: '3',
      durationBase: '2', durationMod: '1', durationPerLevel: '1', chanceBase: '5', chanceMod: '0', chancePerLevel: '1' },
    { magnitudeBaseLow: 10, magnitudeBaseHigh: 20 },
    { magnitudeBaseLow: '10', magnitudeBaseHigh: 20, magnitudePerLevel: '2' },
    { magnitudeBaseLow: true, magnitudeBaseHigh: null, magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1 },
  ]) {
    const sp = { effects: [{ type: 4, subType: 0, ...fields }] };
    card(sp, {}, {}, {});
    card(sp, ch, {}, { seconds: 5 });
  }
  put('saving', [{ isPlayer: true, raceId: 1 }, {}, 0, 0, 20], [S.savingChanceOutcome({ isPlayer: true, raceId: 1 }), 80, S.spellHasFlags(undefined, 0, 0), S.savingLands(20)]);
  for (const raw of [100, 101, '100', '101', '102', '200']) {
    for (const mentor of [null, { skillFactor: 0.75, skillCeiling: 200 }]) {
      for (const isPlayer of [false, true]) {
        const entity = { isPlayer, skills: { [SKILLS.Destruction]: raw }, _mentor: mentor };
        put('climb', [entity, SKILLS.Destruction], fightingClimb(entity, SKILLS.Destruction));
      }
    }
  }
  let costProbe = false;
  for (let i = 0; i < 1000 && !costProbe; i++) {
    const e = mk(4, 2 ** 50 + i);
    const cost = S.effectCost(e, () => 100);
    if (cost.sp !== Math.trunc((cost.gold * 10 * 100) / (100 * 400))) {
      put('effect', [e, 100, true, 1, 'avg'], [S.effectSchool(e), cost, S.magnitudeAt(e), S.spellRounds(e)]);
      costProbe = true;
    }
  }
  if (!costProbe) throw new Error('no equal-skill cost rounding discriminator');

  // Every priced effect × target range × seven-bit flag mask. Group 16 masks per line
  // so the spell, character and target only need to be serialized once per group.
  for (const key of keys) for (const rangeType of [0, 1, 2, 3, 4, 5]) {
    for (let firstMask = 0; firstMask < 128; firstMask += 16) {
      const e = effect(key, n => (rangeType + firstMask) % n);
      const sp = { effects: [e], rangeType, element: (rangeType + firstMask) % 5 };
      const ch = chars[(counts.effect_grid ?? 0) % chars.length];
      const target = targets.at(-1);
      const masks = Array.from({ length: 16 }, (_, i) => firstMask + i);
      put('effect_grid', [sp, ch, target, masks], [S.spellCost(sp, ch), masks.map(effectFlags => {
        const { damage, saving } = S.spellDamage({ ...sp, effectFlags }, ch, target);
        return [damage, saving];
      })]);
    }
  }

  const enchant = (item, ch, t, opts) => {
    const enOpts = { ...opts, standard };
    const bill = E.cwsBillCapacity(item);
    put('enchant', [item, ch, t, opts], [E.enchantmentRows(item), E.payloadRows(item), E.rebuildEnchantMods([item, item]),
      E.castWhenStrikes(item, standard).map(s => s.index), E.strikeEnchantments(item, ch, t, enOpts), E.enchantDps(item, ch, t, enOpts), bill, E.procsBeforeBreak(item), E.billCapacityNote(bill ?? 0)]);
  };
  for (const [typeName, type] of Object.entries(E.ENCHANTMENT_TYPES)) {
    for (const param of [-1, ...new Set([...D.enchantmentParamValues(typeName), ...(type >= 0 && type <= 2 ? standard.keys() : [])])]) {
      const item = { group: 'Weapons', templateIndex: 120, currentCondition: 10, maxCondition: 100,
        enchantments: [{ type, param }, { type: 2, param: 240 }, { type: 2, param: 241 }] };
      enchant(item, chars[0], { group: ['undead', 'daedra', 'humanoid', 'animal'][param] }, {});
    }
  }
  sweep(() => {
  for (let i = 0; i < 2688; i++) {
    const raw = Buffer.from(Array.from({ length: S.SPELL_RECORD_SIZE + i % 5 }, () => int(256)));
    const off = i % 5;
    raw[off] = i % 13 === 0 ? 255 : keys[i % keys.length][0] & 255;
    raw[off + 1] = keys[i % keys.length][1] & 255;
    raw[off + 6] = i % 7;
    raw[off + 7] = Math.floor(i / 7) % 7;
    if (i % 13 === 0) raw[off + 2] = raw[off + 4] = 255;
    if (i % 9 === 0) raw[off + 47] = 0;
    const b = i % 29 === 0 ? raw.subarray(0, raw.length - 1) : raw;
    put('record', [b.toString('hex'), off], S.readSpellRecord(b, off));
    const ch = pick(chars);
    const t = pick(targets);
    const e = effect(keys[i % keys.length]);
    const skill = pick(edges);
    const online = i % 2 === 0;
    const level = pick(edges);
    const mode = ['avg', 'min', 'max'][i % 3];
    put('effect', [e, skill, online, level, mode], [S.effectSchool(e), S.effectCost(e, () => skill, { online }), S.magnitudeAt(e, level, mode), S.spellRounds(e, level)]);
    const school = schools[i % schools.length];
    const climb = { isPlayer: i % 3 !== 0, _online: online, masterSkills: i % 4 === 0, masteredSkills: i % 5 ? [school] : [],
      skills: { [school]: i % 3 ? skill : pick([undefined, 29, 30, 31, 99, 100, 124, 125, 149, 150, 174, 175, '200']) },
      _mentor: i % 5 === 0 ? null : { skillFactor: pick([undefined, 0, 0.25, 1, 2]), skillCeiling: pick([29, 30, 31, 99, 100, 125, 175, 200]) } };
    put('climb', [climb, school], fightingClimb(climb, school));
    const element = Math.floor(i / 128) % 7;
    const effectFlags = [undefined, NaN, i % 128, 127, 0, '4', -1][Math.floor(i / 384) % 7];
    const so = { element, effectFlags, modifier: i % 3 ? pick(edges) : (i % 111 - 55), pierce: pick(edges) };
    const check = int(128), flags = i % 128;
    const lands = i % 3 ? (i % 123) + pick([0, 0.00001, 0.5, -0.00001]) : pick(edges);
    put('saving', [t, so, check, flags, lands], [S.savingChanceOutcome(t, so), S.savingChance(t, so), S.spellHasFlags(element, check, flags), S.savingLands(lands)]);
    const sp = i < stock.length ? stock[i] : i % 29 === 0 ? null : i % 13 === 0 ? {} : i % 4 ? pick(custom) : {
      effects: [e, effect([1, 0]), effect([4, 0])], element, rangeType: i % 7, effectFlags, minimumCastingCost: !(i % 11),
    };
    const opts = { level: i % 7 ? undefined : level, potencyPct: pick(edges), pierce: pick(edges),
      online: i % 3 ? undefined : online, health: pick([undefined, -1, 0, Number.MIN_VALUE, 1, 17, 200, 10000]),
      castSpeedPct: pick(edges), magicka: i % 7 ? undefined : pick(edges),
      manaSolved: pick([undefined, true, false]), seconds: pick([undefined, -1, -0, 0, Number.MIN_VALUE, 1e-9, 0.7, 1, 4.999999999999999, 5, 5.000000000000001, 30, 125]),
    };
    card(sp, ch, t, opts, mode);
    const list = [sp, -1, i % 256, '7', 240, null, false, {}, { effects: [] }, 241];
    put('resolve', [list], S.resolveSpells(list, standard));

    const [typeName, type] = Object.entries(E.ENCHANTMENT_TYPES)[i % Object.keys(E.ENCHANTMENT_TYPES).length];
    const param = i % 3 ? Math.floor(i / 28) % 95 : pick([undefined, null, -1, '0', '7', '241', 240, 241, 242, NaN]);
    const group = ['undead', 'daedra', 'humanoid', 'animal', null][i % 5];
    const enTgt = { ...t, group };
    const item = { group: 'Weapons', templateIndex: 120, currentCondition: pick(edges), maxCondition: pick(edges), enchantments: [
      null, { type: -1 }, { type: 2, param: i % 7 ? 240 : '242' },
      { type: i % 2 ? 4 : 20, param: i % 5 }, { type, param },
      { type: 2, param: 241 }, { type: i % 7 ? 10 : '10', param: pick([0, 1, 34, 35, 34.99, '33', -1]) },
      { type: 2, param: i % 256 }, { type: 2, param: 255 },
    ] };
    const enOpts = { level: opts.level, potencyPct: opts.potencyPct, pierce: opts.pierce, hit: pick([undefined, 0, 0.5, 1]), aps: pick([undefined, 0, 1, 2.75]), cap: i % 11 ? pick(edges) : undefined };
    enchant(item, ch, enTgt, enOpts);
    const numericParam = typeof param === 'number' ? param : undefined;
    const tmpl = pick([`${i % 288}`, i % 310, null, undefined, NaN]);
    put('catalogue', [type, numericParam, tmpl], [D.enchantmentParamValues(typeName), D.defaultParam(typeName) ?? null, D.enchantmentCost(typeName, numericParam), D.itemEnchantmentPoints(tmpl)]);

    const boss = { bossTraits: pick([undefined, null, [], ['bladeturning', 'stoneskin', 'thorned', ...B.ELEMENT_TRAITS], ['thorned'], ['bladeturning'], ['stoneskin'], B.ELEMENT_TRAITS]) };
    const [name, mobile] = [`🜁α${i}`, `${i % 300}`];
    const id = pick(['breach', 'SkyKetch', 'ABYSS', 'missing', null]);
    const damage = pick(edges);
    const weapon = pick([null, {}, { templateIndex: 120 }, { templateIndex: 125 }, { templateIndex: '125' }, { templateIndex: 559 }]);
    const bossOpts = { weapon, kind: pick(['spell', 'melee', 'arrow', 'other']), element: i % 9 - 2, whole: i % 3 === 0 };
    const seed = Math.floor(r() * 2 ** 32);
    put('boss', [boss, name, mobile, id, damage, bossOpts, seed], [eliteRng(seed)(), B.bossTraitsOf(boss), B.relayBossTraits(name, mobile), B.relayTraitsFor(id), B.elementTraitOf(bossOpts.element),
      B.bossStrike(boss, damage, bossOpts), B.resistBlow(boss.bossTraits, damage, bossOpts), B.resistSpell(boss.bossTraits, damage, bossOpts.element)]);
  }
  });
  console.log(`spells: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  return { spells: out.write() };
}
