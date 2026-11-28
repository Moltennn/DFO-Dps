import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { savingChanceOutcome, spellsByIndexMap } from '../src/spells.js';
import { readSpellBook } from './rust-synth-book.mjs';
import * as F from '../src/fight.js';
import * as C from '../src/cws.js';
import * as D from '../src/durability.js';
import { analyze, gateTarget, referenceFoe, syntheticWeapon, SKILLS } from '../src/model.js';
import { theoryCharacter } from '../src/theory.js';
import { EFFECT_FLAGS, ELEMENT_FLAG_BY_INDEX } from '../src/target.js';
import { effectCastingCost } from '../vendor/upstream/a3eb1605/src/systems/absorption.js';
import { encodeValue as V } from './rust-codec.mjs';
import { genSimulateFight } from './rust-simulate-vectors.mjs';
import { genRelayFight } from './rust-relay-vectors.mjs';
import { sweep } from './rust-sweep.mjs';

const bits = new DataView(new ArrayBuffer(8));
function adjacent(x, delta) {
  if (x === 0) return delta > 0n ? Number.MIN_VALUE : -Number.MIN_VALUE;
  bits.setFloat64(0, x);
  bits.setBigUint64(0, bits.getBigUint64(0) + delta);
  return bits.getFloat64(0);
}

// Some decimal bucket edges multiply back to exactly the bucket on their predecessor.
function edges(k, width) {
  if (!(k > 0 && k < width)) return [0, adjacent(1, -1n)];
  let x = k / width;
  while (Math.floor(x * width) < k) x = adjacent(x, 1n);
  while (Math.floor(adjacent(x, -1n) * width) >= k) x = adjacent(x, -1n);
  return [adjacent(x, -1n), x, adjacent(x, 1n)];
}

export function genFightFamilies(Out, makeLcg) {
  const { records: stock } = readSpellBook('rust-fight-vectors');
  const effect = (type, base, rounds = 0, plus = 0) => ({ type, subType: 0,
    magnitudeBaseLow: base, magnitudeBaseHigh: base + 4, magnitudeLevelBase: plus, magnitudeLevelHigh: plus + 2,
    magnitudePerLevel: 4, durationBase: rounds, durationMod: 0, durationPerLevel: 2 });
  const probes = [
    [effect(4, 8), effect(1, 11, 1), effect(4, 15), effect(1, 15, 4)],
    [effect(1, 6, 3), effect(4, 10), effect(1, 4, 2), effect(4, -1)],
    [effect(4, 8), effect(4, 25, 0, 2), effect(4, -7), effect(4, 0)],
    [effect(-1, 0), effect(1, 6), { ...effect(4, 8), subType: 1 }, effect(1, 6, 2), effect(4, 20)],
    [effect(4, 8), effect(1, 50, 1), effect(1, 20, 1), effect(1, 40, 3)],
  ].map((effects, n) => ({ index: 240 + n, name: `R6a ${n}`, effects, rangeType: n - 1, element: n }));
  const records = [...stock, ...probes];
  const standard = spellsByIndexMap(records);
  const out = new Out('fight', 'R6a full whole-fight, relay and explicit Cast When Strikes state traces', true);
  out.add('book', V(records));
  const put = (kind, args, expected) => out.add(kind, ...args.map(V), '=>', V(expected));
  let nextDef = 0;
  let nextAnswer = 0;
  const define = value => {
    const id = nextDef++;
    out.add('def', id, V(value));
    return `@${id}`;
  };
  const repeated = args => {
    const inputs = args.map(define);
    const answers = new Map();
    return (log, answer) => {
      const token = V(answer);
      if (!answers.has(token)) {
        answers.set(token, nextAnswer++);
        out.add('answer', answers.get(token), token);
      }
      out.add('cast', ...inputs, V(log), '=>', `@${answers.get(token)}`);
    };
  };
  const r = makeLcg(0x61c0526).unit;
  const pick = a => a[Math.floor(r() * a.length)];
  const err = f => { try { return f(); } catch (e) { return e.message; } };
  const trace = script => {
    const log = [];
    return { log, rolls: () => {
      const index = log.length;
      if (index >= script.length) throw new Error('R6a script exhausted');
      const value = script[index];
      log.push([index, value]);
      return value;
    } };
  };
  const script = () => Array.from({length: 128}, r);
  const templates = [113, 117, 121, 123, 124, 125, 126, 129, 560, 562];
  const weapon = (i, k = templates[i % templates.length]) => ({ ...syntheticWeapon(k, i % 10).item,
    currentCondition: [0, 1, 9, 10, 11, 20, 21, 99][i % 8], maxCondition: 100 });
  const row = param => ({type: 2, param});
  const surge = {...weapon(4), rarity: 'legendary', legendary: 'shalidors-brand'};
  const gaze = {...weapon(5), rarity: 'legendary', legendary: 'eye-of-magnus'};
  const potency = (value, equipSlot) => ({ group: 'Clothing', name: `potency ${value}`, rarity: 'rare', equipSlot,
    affixes: [{id: 'potency', value}] });
  const mkChar = i => {
    const ch = theoryCharacter({ level: 1 + i % 60, blade: 117, race: 1 + i % 8, online: !!(i & 4), rawBlade: 79 + i % 110 });
    ch.online = !!(i & 4);
    ch.skills[SKILLS.Destruction] = [0, 100, 101, 150, 200, '175', 111, 95][i % 8];
    if (i & 16) ch.masteredSkills.push(SKILLS.Destruction);
    if (i & 32) ch._mentor = { skillFactor: 0.75, skillCeiling: 132 };
    return ch;
  };
  const targetFor = i => ({ ...referenceFoe(1 + i % 60, i % 3 ? 'tough' : 'human'),
    warded: !!(i & 64), spareGear: !!(i & 128), maxMagicka: [0, 5, 10, 1000][i % 4], magicka: i % 7,
    ...(i & 256 ? {skills: 80} : {}),
    career: { spellAbsorptionFlags: (i >> 3) % 6, immunityFlags: i & 32 ? EFFECT_FLAGS.Fire : 0 },
    _enchantMods: {absorbsSpells: !!(i & 4)},
    activeEffects: [
      {kind: 'spellAbsorption', chance: i % 7 ? 23 : 0},
      {kind: 'spellAbsorption', chanceBase: i % 37, chanceMod: 3, chancePerLevel: 2, ended: !!(i & 8)},
      {kind: 'spellReflection', chance: i % 47, ended: !!(i & 8)},
      {kind: 'spellReflection', chance: i % 23},
      {kind: 'spellResistance', chance: i % 21},
      {kind: 'spellResistance', chance: 100, ended: true},
      {kind: 'elementalResistance', element: i % 5, chance: i % 49},
      {kind: 'elementalResistance', element: i % 5, chance: i % 11},
      {kind: 'elementalResistance', element: (i + 1) % 5, chance: 90},
      {kind: 'elementalResistance', element: i % 5, chance: 90, ended: true},
    ] });

  function castCase(sp, ch, t, opts, values, emit = (log, answer) => put('cast', [sp, ch, t, opts, log], answer)) {
    const target = structuredClone(t);
    const {rolls, log} = trace(values);
    const landed = [];
    let hp = opts.hp;
    const hurt = hp == null ? null : (n, meta) => {
      landed.push([n, meta ?? null]); hp = Math.max(0, hp - n); return hp > 0;
    };
    const caster = opts.self ? {entity: target} : ch && {entity: ch};
    const results = [];
    for (let j = 0; j < opts.casts; j++) results.push(C.resolveCwsCast({ ...opts, spell: sp, caster, target, rolls, hurt }));
    const states = [];
    for (let j = 0; j < opts.ticks; j++) {
      C.tickActiveEffects(target, {hurt}, rolls);
      // State snapshots include round settings but not the caster object identity (a self-cast makes a cycle).
      states.push(target?.activeEffects?.map(({caster, ...a}) => a));
    }
    emit(log, [results, hp, landed, states, target?.activeEffects?.map(({caster, ...a}) => a)]);
    return log;
  }

  sweep(() => {
  for (let i = 0; i < 2048; i++) {
    const ch = mkChar(i);
    ch.weapon = {...weapon(i), enchantments: [row(pick(records).index)]};
    ch.offWeapon = weapon(i + 3, 117);
    const health = pick([undefined, 0, null, NaN, '180', 5, 40, 230, 1100]);
    const bounds = [pick([0, 25, 37.5, 50, 75, 100, 100.5, -3, NaN, '40', Number.MIN_VALUE]), pick([1, 12, 50, 90, 99.5])];
    const imprints = bounds.map(below => ({kind: 'execute', below, pct: i % 51}));
    const imprint = i % 2 ? {kind: 'execute', below: 80, pct: 20} : null;
    put('thresholds', [[null, {}, ...imprints, ...imprints, imprint]], F.healthThresholds([null, {}, ...imprints, ...imprints, imprint]));
    const opts = { health, imprints, imprint, attackerHealthShare: i % 4 / 3, core: i & 1 ? 'classic' : 'overhaul',
      dual: !!(i & 2), pair: !!(i & 4), rri: !!(i & 8), swing: i % 7 ? 'StrikeDown' : 'random',
      ...(i % 9 === 0 ? {weapon: null} : {}), ...(i % 31 === 0 ? {damagePct: -100} : {}) };
    const ordinary = {...opts, target: {...referenceFoe(1 + i % 60, i & 1 ? 'human' : 'armoured'), maxHealth: 250}};
    const gate = gateTarget(1 + i % 60, {health: 50 + i % 700, players: [1, 2, 3][i % 3]});
    const relay = {...opts, target: i % 11 ? gate : ordinary.target};
    const edit = {health: 90, imprint: {kind: 'execute', below: 63, pct: 35}, attackerHealthShare: 0.35};
    for (const [kind, args, f] of [['fight', ordinary, i & 1 ? F.fight : F.fightDps], ['relay', relay, F.fightRelay]]) {
      const result = f(ch, {...args, standard});
      put(kind, [ch, args], result);
      if (i % 128 === 0 && result) put(`${kind}_with`, [ch, args, edit], result.with(edit));
    }

    const t = targetFor(i);
    const sp = i % 3 ? probes[i % probes.length] : pick(stock);
    const optsCast = { casterLevel: pick([0, 1, 3, 4, 8, 30, 65]), potencyPct: pick([-2, 0, 3, 19, 50, 76]),
      pierce: pick([0, 1, 2, 4, 11, 60]), hp: pick([null, 0, 1, 5, 15, 80, 900]),
      casts: 1 + i % 3, ticks: i % 6, self: i % 37 === 0 };
    const castSpell = i % 97 ? sp : {...sp, effects: [null, ...sp.effects]};
    castCase(i % 101 ? castSpell : null, i % 5 ? ch : null, i % 113 ? t : null, optsCast, script());

    const spEffect = pick([effect(4, -4, 0, 1), effect(1, 14, 2, 0), ...(sp.effects ?? []).filter(Boolean), {}]);
    const level = optsCast.casterLevel;
    const values = [pick(edges(1 + i % 4, 5)), pick(edges(1 + i % 2, 3))];
    const mag = trace(values);
    put('magnitude', [spEffect, level, mag.log], [C.rollMagnitude(spEffect, level, mag.rolls), C.isDamageHealth(spEffect), C.isContinuousDamage(spEffect)]);
    const element = i % 5;
    const flags = ELEMENT_FLAG_BY_INDEX[element];
    const {chance} = savingChanceOutcome(t, {element, effectFlags: flags, pierce: optsCast.pierce});
    const absolute = i % 49 + i % 11;
    const throwRoll = trace([pick([...edges(absolute, 100), ...edges(absolute + 1, 100), 0.99]),
      pick([0, 0.99, ...[Math.ceil(chance - 20) - 1, Math.floor(chance), Math.floor(chance) - 1, Math.floor(chance) + 1].flatMap(k => edges(k, 100))])]);
    put('save', [element, flags, t, optsCast.pierce, throwRoll.log], C.savingThrow(element, flags, t, throwRoll.rolls, optsCast.pierce));

    const left = {...weapon(i + 2), equipSlot: pick([undefined, 19, 21, 23, -1])};
    const right = {...weapon(i + 1), equipSlot: pick([undefined, 19, 21, 23, '-1'])};
    const worn = [null, left, right, {...surge, equipSlot: 20}, {...surge, equipSlot: 18, name: 'copy'},
      {...gaze, equipSlot: -1}, potency(8, 4), potency(10, 4), potency(12, 6), potency(10, 7)];
    if (i % 7 === 0) worn.push({...right});
    if (i & 32) worn[3].enchantments = [{type: 3, param: 1}];
    const equip = { worn: i % 11 ? worn : undefined, items: i % 17 ? undefined : [],
      magicka: pick([0, 75, ...[70, 80, 90, 96].flatMap(n => [adjacent(n, -1n), n, adjacent(n, 1n)]), NaN, 300]),
      maxMagicka: 100, maxMagickaBase: pick([undefined, 75, 100, NaN]),
      _enchantMods: {maxMagicka: pick([undefined, 0, 20])} };
    const hasAccessor = i % 13 === 0;
    const live = hasAccessor ? i % 501 : undefined;
    const jsEquip = {...equip, weapon: i & 16 ? {...right, name: 'other'} : right, offWeapon: i & 32 ? null : left};
    if (hasAccessor) Object.defineProperty(jsEquip, 'maxMagicka', {get: () => live});
    const ws = [pick([null, weapon(i), {...right}, {...left, equipSlot: 26}]), pick([null, weapon(i + 1), {...left}])];
    const ids = [i & 16 ? jsEquip.weapon : 2, i & 32 ? null : 1];
    put('equip', [equip, ws, ids], [err(() => C.equipTableForFight(jsEquip, ws)), err(() => C.equippedForFight(jsEquip, ws))]);
    const optsPower = {pierce: pick([undefined, -1, 0, 5, '7', Infinity]), potencyPct: pick([undefined, -1, 0, 5, '7', 100]),
      worn: pick([undefined, null, [], 'invalid', [potency(10, 4), potency(12, 5)], worn])};
    put('power', [equip, optsPower, live, ch, SKILLS.Destruction], [C.liveMaxMagicka(jsEquip),
      err(() => C.spellPowerInputs(jsEquip, optsPower)), C.schoolPotencyFor(ch, SKILLS.Destruction)]);

    const item = { ...weapon(i), equipSlot: 19, enchantments: pick([[], [row(sp.index), row(999)],
      [row('240'), {type: 99}, row(241)], [{type: 99}, row(240)], [{type: 4}, row(null), row(244), row(undefined)]]) };
    const positive = !!(i & 1), whole = !!(i & 2);
    put('rows', [item, t, positive, whole], [C.cwsRows(item, standard), C.cwsEligible({target: t, strikesPositive: positive, whole, item, standard})]);
    // This is the Strikes row walk: resolve first; always bill, even misses and post-kill rows.
    const blade = D.cloneItem(item);
    const owner = D.makeOwner(blade);
    const thrown = trace(script());
    const result = [];
    const target = structuredClone(t);
    let hp = i % 2 ? 1 : 270;
    const hurt = n => { hp = Math.max(0, hp - n); return hp > 0; };
    if (C.cwsEligible({target, strikesPositive: true, whole: true, item: blade, standard})) {
      for (const {spell} of C.cwsRows(blade, standard)) {
        const landing = spell && hp > 0 ? C.resolveCwsCast({spell, caster: {entity: ch}, target, rolls: thrown.rolls, hurt}) : null;
        const bill = D.cwsBill(target);
        const broke = D.wearItem(owner, blade, bill);
        result.push([landing, bill, broke, blade.currentCondition, hp, Boolean(owner.weapon)]);
      }
    }
    put('bills', [item, t, ch, i % 2 ? 1 : 270, thrown.log], [result, blade]);
  }
  });

  // R1: the cast's magnitude with a STRING or BOOLEAN effect field. `rollMagnitude` and `magnitudeRoll` follow the JS
  // chain: `?? 0` on the raw field, every `+` is ECMAScript `+` (so `'10' + 20` is `'1020'`). The numeric fields are
  // the cases that regressed (a string per-level gave NaN); the string-result cases are covered by the local test.
  const fieldTypes = [
    ['num', 10, 20, 1],
    ['per-string', 10, 20, '5'],
    ['high-string', 10, '20', 1],
    ['low-string', '10', 20, 1],
    ['per-bool', 10, 20, true],
    ['per-null', 10, 20, null],
    ['low-bool', true, 20, 1],
    ['level-string', 10, 20, 1, '3', 4],
    ['missing-level', 10, 20, undefined],
    ['missing-base', undefined, undefined, 1],
  ];
  const fieldEffect = ([, low, high, per, ll, lh]) => {
    const e = { type: 4, subType: 0, magnitudeBaseLow: low, magnitudeBaseHigh: high, magnitudePerLevel: per,
      magnitudeLevelBase: ll ?? 0, magnitudeLevelHigh: lh ?? 0 };
    if (per === undefined) delete e.magnitudePerLevel;
    if (low === undefined) { delete e.magnitudeBaseLow; delete e.magnitudeBaseHigh; }
    return e;
  };
  for (const fields of fieldTypes) {
    const e = fieldEffect(fields);
    for (const [rangeType, element] of [[0, 4], [1, 0], [2, 2]]) {
      const sp = { index: 245, name: `Fields ${fields[0]}`, element, rangeType, effects: [e] };
      for (const casterLevel of [1, 10]) {
        const mag = trace(script());
        const expected = C.rollMagnitude(e, casterLevel, mag.rolls);
        put('magnitude', [e, casterLevel, mag.log], [expected, C.isDamageHealth(e), C.isContinuousDamage(e)]);
        // The CWS path itself, only where the JS magnitude is a NUMBER: the port's landing coerces a string magnitude
        // through its own arithmetic (rust/README.md, the all-string residual), so a string case is pinned there.
        if (typeof expected === 'number') {
          castCase(sp, null, targetFor(20), { casterLevel, hp: 90, casts: 1, ticks: 0, pierce: 0, potencyPct: 0 }, script());
        }
      }
    }
  }

  const ch = mkChar(28);
  ch.weapon = weapon(137, 117);
  const ordinary = referenceFoe(20, 'human');
  const fixed = { target: ordinary, swing: 'StrikeDown', critDamage: false };
  const first = analyze(ch, {...fixed, healthShare: 0.75, standard}).perSwing;
  if (!(first > 0)) throw new Error('R6a: invalid per-swing boundary baseline');
  for (const health of [0, 0.25, Number.MIN_VALUE, 0.5e-9, 1e-9, adjacent(1e-9, 1n), ...[first, first * 2, first * 4].flatMap(n => [adjacent(n, -1n), n, adjacent(n, 1n)])]) {
    const args = {...fixed, health, target: {...ordinary, maxHealth: 200}};
    put('fight', [ch, args], F.fight(ch, {...args, standard}));
    for (const players of [undefined, 0, 1, 2.5, '2', NaN]) {
      const base = gateTarget(12, {health: 500});
      const target = {...base, hitCap: 15, allowance: {...base.allowance, players, openingS: 4, immunityShare: 0.4}};
      const scenario = {...args, target};
      put('relay', [ch, scenario], F.fightRelay(ch, {...scenario, standard}));
    }
  }
  const gate = gateTarget(25, {health: 220});
  for (const target of [undefined, ordinary, {...ordinary, minMetalToHit: 100},
    {...gate, hitCap: 0, bossTraits: []}, {...gate, hitCap: 0.5, bossTraits: []}, {...gate, hitCap: 15, bossTraits: []},
    {...gate, hitCap: 15, bossTraits: [], armorValues: Array(7).fill(NaN)}]) {
    for (const weapon of [undefined, ...[Infinity, NaN, 4].map(bowWithin => ({...syntheticWeapon(129, 6), bowWithin}))]) {
      const args = {...fixed, target, weapon, softMaterialRequirements: false};
      put('fight', [ch, args], F.fight(ch, {...args, standard}));
      put('relay', [ch, args], F.fightRelay(ch, {...args, standard}));
    }
  }
  const w = {...syntheticWeapon(117, 8), min: 1000, max: 1000};
  const target = {...gate, hitCap: 15, bossTraits: [], allowance: {...gate.allowance, players: 1}};
  const fixture = {...fixed, core: 'classic', weapon: w, target, imprints: [{kind: 'execute', below: 5e-8, pct: 1000}]};
  const card = analyze(ch, {...fixture, health: 30, healthShare: 1, standard});
  const perClaim = Math.min(card.cappedPerSwing / card.hit.hit, 15);
  for (const [claims, remaining] of [[2, 1.2e-9], [3, 2e-9], [4, 4e-9]]) {
    const args = {...fixture, health: perClaim * claims + remaining};
    put('relay', [ch, args], F.fightRelay(ch, {...args, standard}));
  }
  for (const strength of [0, 30, 50, 60]) for (const armor of [-30, -1000]) {
    const weak = {...ch, stats: {...ch.stats, strength}, skills: {}};
    const args = {...fixed, core: 'classic', health: 2, weapon: {...syntheticWeapon(113, 0), min: 1, max: 1},
      target: {...ordinary, armorValues: Array(7).fill(armor)}};
    put('fight', [weak, args], F.fight(weak, {...args, standard}));
  }

  // Exercise the cost/room boundary separately from the percentile arms.
  for (const sp of probes.slice(0, 3)) {
    for (const skill of [0, 100, 111, { [SKILLS.Destruction]: 84 }]) for (const fixed of [undefined, 103]) {
      const t = {...targetFor(17), skills: skill, magicka: 0, career: {spellAbsorptionFlags: 4}, activeEffects: [],
        skillOverrides: {[SKILLS.Destruction]: fixed}, _enchantMods: {skillMods: {[SKILLS.Destruction]: 3}},
        _mods: { skills: {[SKILLS.Destruction]: 2} } };
      const cost = effectCastingCost(sp.effects[0], sp.rangeType, t);
      for (const maxMagicka of [adjacent(cost, -1n), cost, adjacent(cost, 1n)]) {
        castCase(sp, ch, {...t, maxMagicka}, { casterLevel: 1, hp: 200, casts: 1, ticks: 0, pierce: 0, potencyPct: 0 }, script());
      }
      const opts = {casterLevel: 8, hp: 200, casts: 1, ticks: 0, pierce: 0, potencyPct: 0};
      castCase(sp, ch, {...t, maxMagicka: cost, magicka: undefined}, opts, script());
      castCase(sp, ch, {...t, maxMagicka: undefined, magicka: 0.5 - cost}, opts, script());
      const stat = {[SKILLS.Destruction]: 40};
      const modified = {...t, activeEffects: [{kind: 'racialOverride', skillMods: stat},
        {kind: 'racialOverride', skillMods: stat, ended: true}, {kind: 'spellResistance', skillMods: stat}]};
      const price = effectCastingCost(sp.effects[0], sp.rangeType, modified);
      castCase(sp, ch, {...modified, maxMagicka: adjacent(price, -1n)}, opts, script());
    }
  }

  const direct = {...probes[2], rangeType: 1, effects: [{ ...effect(4, 2.25, 0, 1), magnitudePerLevel: undefined }]};
  const unscaled = {...direct, rangeType: 0};
  const opts = {casterLevel: 2, hp: 500, casts: 1, ticks: 0, potencyPct: 0, pierce: 0};
  const basic = {...targetFor(20), level: undefined, maxMagicka: 10000, magicka: 0, career: {}, _enchantMods: {}};
  const priced = {...direct, effects: [effect(4, 8)]};
  for (const a of [{chance: 0.5}, {}, {chanceBase: 2}, {chanceBase: 0, chanceMod: 3},
    {chanceBase: 0, chanceMod: 3, chancePerLevel: 0}]) {
    for (const level of [undefined, 5]) for (const first of [0, 0.01, 0.02, 0.03, 0.06, 0.09, 0.14, 0.15, 0.99]) {
      castCase(priced, null, {...basic, level, activeEffects: [{kind: 'spellAbsorption', ...a},
        {kind: 'spellResistance'}, {kind: 'spellReflection'}, {kind: 'elementalResistance', element: 2}]},
      opts, [first, ...Array(127).fill(0.99)]);
    }
  }
  for (const skill of [100, 104, 110]) {
    const caster = {...ch, online: true, skills: {[SKILLS.Destruction]: skill}, masteredSkills: [SKILLS.Destruction]};
    castCase(unscaled, caster, {...basic, activeEffects: []}, opts, Array(128).fill(0.99));
  }
  const incumbent = {kind: 'continuousDamage', effect: effect(1, 20, 1), casterLevel: 1, saveScaled: true,
    element: 2, flag: EFFECT_FLAGS.Poison, roundsRemaining: -0};
  const renewal = {...direct, effects: [effect(1, 20, 1)]};
  const {chance: saveChance} = savingChanceOutcome(basic, {element: 2, effectFlags: EFFECT_FLAGS.Poison});
  for (const save of [...[1, 6, 19, Math.floor(saveChance), Math.floor(saveChance) - 2].flatMap(k => edges(k, 100)), 0.99]) {
    castCase(renewal, ch, {...basic, activeEffects: [incumbent]}, opts, [0.99, 0.99, save, ...Array(125).fill(0.99)]);
  }
  const copy = {group: 'Weapons', name: 'slotless', templateIndex: 117, material: 0};
  const slotless = {worn: [{...copy, material: undefined}]};
  put('equip', [slotless, [copy, null], [null, null]], [C.equipTableForFight(slotless, [copy]), C.equippedForFight(slotless, [copy])]);
  for (const maxMagicka of [undefined, 0, 0.5, 100]) {
    const loadout = {worn: [surge, gaze], magicka: 90, maxMagicka};
    put('power', [loadout, {}, undefined, ch, SKILLS.Destruction], [C.liveMaxMagicka(loadout),
      C.spellPowerInputs(loadout), C.schoolPotencyFor(ch, SKILLS.Destruction)]);
  }

  // Caller-supplied incumbents can be lapsed, end-marked, or part of a duel, unlike newly inserted entries.
  for (const roundsRemaining of [undefined, -1, -0, 0, 1, 2, 5]) for (const kind of ['continuousDamage', 'spellResistance']) {
    const sp = {...probes[1], rangeType: 1.2, element: undefined};
    const entry = { kind, effect: effect(1, 15, 1), casterLevel: 4, element: 2, flag: EFFECT_FLAGS.Poison,
      saveScaled: true, roundsRemaining, bundleDuel: true, ended: true };
    const t = {...targetFor(20), maxMagicka: 0, activeEffects: [entry, {kind: 'racialOverride', ended: true}]};
    for (const rangeType of [undefined, '1', -1, 1, 0.5]) {
      castCase({...sp, rangeType}, null, t, {casterLevel: 4, hp: 20, casts: 2, ticks: 6, pierce: 10, potencyPct: 5}, script());
    }
  }
  // B: a DoT entry whose element or flag is nullish. JS reads no element at all (no `spellHasFlags` arm matches, so
  // no elemental resistance and no race tolerance), never Fire; and a nullish flag falls back to the element's own flag
  // (`Number.isFinite(null)` is false). Rust's `to_number`/`num_or` used to map both to 0 (Fire / no flags). The target
  // carries a 100% Fire resistance effect so a Fire reading is visible as a zeroed round.
  for (const [element, flag] of [[0, null], [null, null], [4, null], [0, 4], [null, 4], [2, undefined], [undefined, undefined], [null, 1]]) {
    const dot = { kind: 'continuousDamage', effect: effect(4, 10, 0), casterLevel: 1, element, flag,
      saveScaled: true, roundsRemaining: 3, spellPower: 1 };
    const t = {...targetFor(20), activeEffects: [dot, {kind: 'elementalResistance', element: 0, chance: 100}]};
    castCase({...probes[1], effects: [], rangeType: 0}, null, t, {casterLevel: 1, hp: 60, casts: 1, ticks: 3, pierce: 0, potencyPct: 0}, script());
  }

  // Overwrite one decision at a time, keeping the earlier draws and their gates intact.
  for (const [i, sp] of probes.entries()) {
    for (const k of [0, 2, 3, 4, 6, 8]) {
      const t = targetFor(i + 40 + k);
      t.maxMagicka = 10000; t.magicka = 0; t.career.spellAbsorptionFlags = 0;
      t._enchantMods.absorbsSpells = true;
      const ch = mkChar(156 + k);
      const opts = { casterLevel: 12, hp: k ? 1000 : 1, potencyPct: 33, pierce: 0, casts: 2, ticks: 4 };
      const base = Array(128).fill(0.99);
      const emit = repeated([sp, ch, t, opts]);
      const log = castCase(sp, ch, t, opts, base, emit);
      const element = sp.element;
      const {chance} = savingChanceOutcome(t, {element, effectFlags: ELEMENT_FLAG_BY_INDEX[element]});
      const bounds = new Set([23, 50, Math.min(50, Math.max(23, t.activeEffects[1].chanceBase + 3 * Math.floor(t.level / 2))),
        t.activeEffects[2].chance, t.activeEffects[3].chance, t.activeEffects[4].chance,
        t.activeEffects[6].element === element ? t.activeEffects[6].chance + t.activeEffects[7].chance : 0,
        Math.floor(chance), Math.ceil(chance - 20) - 1]);
      for (const [index] of log) for (const value of new Set([...bounds].flatMap(b => [b - 1, b, b + 1].flatMap(j => edges(j, 100))))) {
        const values = base.slice(); values[index] = value;
        sweep(() => castCase(sp, ch, t, opts, values, emit));
      }
    }
  }
  return { fight: out.write(), simulate_fight: genSimulateFight(Out, records, standard), relay_fight: genRelayFight(Out, records, standard) };
}
