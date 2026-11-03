/*
 * dfo-dps - spells.
 *
 * The spell record reader is the port's own (formats/spellsStd.js, MIT,
 * Daggerfall Workshop). The effect cost table is FormulaHelper's
 * CalculateEffectCosts (spellcost.js, MIT). The damage roll is
 * EntityEffect.GetMagnitude (spellcast.js): Range(baseLow..baseHigh) +
 * Range(levelBase..levelHigh) * floor(level / perLevel), then the saving
 * throw and the school's past-100 potency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS } from './data.js';
import { effectiveSkill, skillValue, arena2Dir } from './save.js';

export const SPELL_RECORD_SIZE = 0x59;
/** One magic round is one classic minute: 5 real seconds (worldTick.js). */
export const MAGIC_ROUND_SECONDS = 5;

/** One 89-byte SPELLS.STD record. */
export function readSpellRecord(bytes, offset = 0) {
  if (offset + SPELL_RECORD_SIZE > bytes.byteLength) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const effects = [];
  let o = offset;
  for (let i = 0; i < 3; i++) {
    effects.push({ type: v.getInt8(o++), subType: v.getInt8(o++) });
  }
  const element = v.getUint8(o++);
  const rangeType = v.getUint8(o++);
  const cost = v.getUint16(o, true); o += 2;
  o += 4;
  for (const e of effects) { e.durationBase = v.getUint8(o++); e.durationMod = v.getUint8(o++); e.durationPerLevel = v.getUint8(o++); }
  for (const e of effects) { e.chanceBase = v.getUint8(o++); e.chanceMod = v.getUint8(o++); e.chancePerLevel = v.getUint8(o++); }
  for (const e of effects) {
    e.magnitudeBaseLow = v.getUint8(o++); e.magnitudeBaseHigh = v.getUint8(o++);
    e.magnitudeLevelBase = v.getUint8(o++); e.magnitudeLevelHigh = v.getUint8(o++);
    e.magnitudePerLevel = v.getUint8(o++);
  }
  let name = '';
  for (let i = 0; i < 25; i++) name += String.fromCharCode(v.getUint8(o++));
  name = name.split('\0')[0];
  const icon = v.getUint8(o++);
  const index = v.getUint8(o++);
  if (!(effects[0].type > -1 || effects[1].type > -1 || effects[2].type > -1)) return null;
  return { effects, element, rangeType, cost, name, icon, index };
}

export function readSpellsStd(bytes) {
  const out = [];
  for (let o = 0; o + SPELL_RECORD_SIZE <= bytes.byteLength; o += SPELL_RECORD_SIZE) {
    const rec = readSpellRecord(bytes, o);
    if (!rec) continue;
    if (rec.index === 10 && rec.effects[0].type === 3 && rec.effects[0].subType === 2) {
      rec.effects[0].type = 26;
      rec.effects[0].subType = -1;
    }
    out.push(rec);
  }
  return out;
}

export function spellsByIndexMap(records) {
  const map = new Map();
  for (const sp of records) if (!map.has(sp.index)) map.set(sp.index, sp);
  return map;
}

let _standard = null;
/** Every standard spell from the user's ARENA2/SPELLS.STD (cached). */
export function standardSpells(dir = arena2Dir()) {
  if (_standard) return _standard;
  if (!dir) return new Map();
  try {
    const bytes = fs.readFileSync(path.join(dir, 'SPELLS.STD'));
    _standard = spellsByIndexMap(readSpellsStd(new Uint8Array(bytes)));
  } catch {
    _standard = new Map();
  }
  return _standard;
}

/** A save's `spells` array: numbers are stock indices, objects are custom
 *  records. Returns the resolved records (custom records kept whole). */
export function resolveSpells(spells, standard = standardSpells()) {
  const out = [];
  for (const sp of spells ?? []) {
    if (typeof sp === 'number') {
      const rec = standard.get(sp);
      if (rec) out.push(rec);
    } else if (sp && Array.isArray(sp.effects)) out.push(sp);
  }
  return out;
}

// ── the effect cost table (FormulaHelper.CalculateEffectCosts) ──────
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const trunc = Math.trunc;

const costs = (A, B, offset = 0) => ({ A, B, offset });
// One row per effect class: { skill, duration?, chance?, magnitude? }.
const row = (skill, parts) => Object.freeze({ skill, ...parts });
// The per-stat families (DFCareer.Stats order 0 Strength .. 7 Luck)
// are eight sibling classes sharing one set of factors, so they are
// expanded from one row rather than typed out eight times.
const family = (type, subTypes, r) => Object.fromEntries(subTypes.map((s) => [`${type},${s}`, r]));
const STATS = [0, 1, 2, 3, 4, 5, 6, 7];

// classic 'type,subType' -> { skill, duration?, magnitude?, chance? }
export const EFFECT_COST_TABLE = Object.freeze({
  // ---- Alteration ----
  '0,255': row(SKILLS.Alteration, { duration: costs(28, 100), chance: costs(28, 100) }), // Paralyze - S19
  ...family(8, [0, 1, 2, 3, 4], row(SKILLS.Alteration, { duration: costs(100, 100), chance: costs(8, 100) })), // ElementalResistance Fire/Frost/DiseaseOrPoison/Shock/Magic
  '25,255': row(SKILLS.Alteration, { duration: costs(20, 100) }), // Slowfall
  '27,255': row(SKILLS.Alteration, { duration: costs(20, 8) }), // Jumping
  '28,255': row(SKILLS.Alteration, { duration: costs(20, 20) }), // Climbing
  '30,255': row(SKILLS.Alteration, { duration: costs(20, 8) }), // WaterBreathing - P12
  '35,255': row(SKILLS.Alteration, { duration: costs(28, 8), magnitude: costs(80, 60) }), // Shield

  // ---- Destruction ----
  '1,0': row(SKILLS.Destruction, { duration: costs(28, 8), magnitude: costs(40, 28) }), // ContinuousDamageHealth
  '1,1': row(SKILLS.Destruction, { duration: costs(20, 8), magnitude: costs(40, 28) }), // ContinuousDamageFatigue
  '1,2': row(SKILLS.Destruction, { duration: costs(40, 8), magnitude: costs(40, 28) }), // ContinuousDamageSpellPoints
  '4,0': row(SKILLS.Destruction, { magnitude: costs(20, 28) }), // DamageHealth
  '4,1': row(SKILLS.Destruction, { magnitude: costs(20, 28) }), // DamageFatigue
  '4,2': row(SKILLS.Destruction, { magnitude: costs(20, 28) }), // DamageSpellPoints
  '5,255': row(SKILLS.Destruction, { chance: costs(80, 140) }), // Disintegrate
  ...family(7, STATS, row(SKILLS.Destruction, { magnitude: costs(8, 100, 116) })), // Drain{Attribute}
  ...family(11, [...STATS, 8, 9], row(SKILLS.Destruction, { magnitude: costs(60, 100, 40) })), // Transfer{Attribute} + TransferHealth (11,8) / TransferFatigue (11,9)

  // ---- Illusion ----
  '13,0': row(SKILLS.Illusion, { duration: costs(40, 120) }), // InvisibilityNormal - S21
  '13,1': row(SKILLS.Illusion, { duration: costs(60, 140) }), // InvisibilityTrue - S21
  '15,255': row(SKILLS.Illusion, { duration: costs(8, 40) }), // LightNormal
  '23,0': row(SKILLS.Illusion, { duration: costs(20, 80) }), // ChameleonNormal
  '23,1': row(SKILLS.Illusion, { duration: costs(40, 120) }), // ChameleonTrue - S21
  '24,0': row(SKILLS.Illusion, { duration: costs(20, 80) }), // ShadowNormal - S21
  '24,1': row(SKILLS.Illusion, { duration: costs(40, 120) }), // ShadowTrue - S21
  '29,255': row(SKILLS.Illusion, {}), // MorphSelf - NO components (the fudge, at Illusion)
  '45,255': row(SKILLS.Restoration, {}), // RESURRECT1: Resurrect - the port's own; no components (the fudge, at Restoration)

  // ---- Mysticism ----
  '2,255': row(SKILLS.Mysticism, { duration: costs(60, 120) }), // CreateItem
  '6,0': row(SKILLS.Mysticism, { chance: costs(120, 180) }), // DispelMagic
  '6,1': row(SKILLS.Mysticism, { chance: costs(80, 140) }), // DispelUndead
  '6,2': row(SKILLS.Mysticism, { chance: costs(120, 180) }), // DispelDaedra
  '12,255': row(SKILLS.Mysticism, { duration: costs(60, 68), chance: costs(40, 68) }), // SoulTrap
  '16,255': row(SKILLS.Mysticism, { chance: costs(28, 120, 120) }), // Lock
  '17,255': row(SKILLS.Mysticism, { chance: costs(20, 100) }), // Open
  '19,255': row(SKILLS.Mysticism, { duration: costs(20, 100), chance: costs(20, 100) }), // Silence
  '43,255': row(SKILLS.Mysticism, {}), // Teleport - NO components (the fudge, at Mysticism)
  '46,255': row(SKILLS.Mysticism, { duration: costs(8, 8) }), // PARTY-MAP: Shared Cartography - the port's own; Light's cheap per-round price, cheap enough to keep up
  '44,255': row(SKILLS.Mysticism, { duration: costs(60, 68), chance: costs(40, 68) }), // ComprehendLanguages

  // ---- Restoration ----
  '3,0': row(SKILLS.Restoration, { chance: costs(8, 100) }), // CureDisease - S19c
  '3,1': row(SKILLS.Restoration, { chance: costs(8, 100) }), // CurePoison - S19c
  '3,2': row(SKILLS.Restoration, { chance: costs(20, 140) }), // CureParalyzation - S19c
  ...family(9, STATS, row(SKILLS.Restoration, { duration: costs(28, 100), magnitude: costs(40, 120) })), // Fortify{Attribute}
  ...family(10, STATS, row(SKILLS.Restoration, { magnitude: costs(40, 28) })), // Heal{Attribute}
  '10,8': row(SKILLS.Restoration, { magnitude: costs(20, 28) }), // HealHealth
  '10,9': row(SKILLS.Restoration, { magnitude: costs(8, 28) }), // HealFatigue
  '18,255': row(SKILLS.Restoration, { duration: costs(100, 20), magnitude: costs(8, 8) }), // Regenerate
  '20,255': row(SKILLS.Restoration, { duration: costs(28, 140), chance: costs(28, 140) }), // SpellAbsorption
  '26,255': row(SKILLS.Restoration, { duration: costs(20, 8) }), // FreeAction - S22

  // ---- Thaumaturgy ----
  '14,255': row(SKILLS.Thaumaturgy, { duration: costs(60, 100) }), // Levitate - P11
  '21,255': row(SKILLS.Thaumaturgy, { duration: costs(28, 140), chance: costs(28, 140) }), // SpellReflection
  '22,255': row(SKILLS.Thaumaturgy, { duration: costs(20, 100), chance: costs(20, 100) }), // SpellResistance
  '31,255': row(SKILLS.Thaumaturgy, { duration: costs(20, 8) }), // WaterWalking
  '33,0': row(SKILLS.Thaumaturgy, { chance: costs(60, 100, 160) }), // Pacify-Animals
  '33,1': row(SKILLS.Thaumaturgy, { chance: costs(80, 140, 60) }), // Pacify-Undead
  '33,2': row(SKILLS.Thaumaturgy, { chance: costs(80, 140, 60) }), // Pacify-Humanoid
  '33,3': row(SKILLS.Thaumaturgy, { chance: costs(60, 120, 36) }), // Pacify-Daedra
  '34,255': row(SKILLS.Thaumaturgy, { chance: costs(40, 60) }), // Charm - AUDIT 23 (magic-6): CharmEffect.cs:36/:42 comment DURATION out; chance alone is priced
  '39,0': row(SKILLS.Thaumaturgy, { duration: costs(20, 8, 200) }), // DetectMagic
  '39,1': row(SKILLS.Thaumaturgy, { duration: costs(20, 8, 200) }), // DetectEnemy
  '39,2': row(SKILLS.Thaumaturgy, { duration: costs(20, 8, 160) }), // DetectTreasure
  '40,255': row(SKILLS.Thaumaturgy, { chance: costs(40, 100, 28) }), // Identify
});


export const TARGET_COST_MULT = Object.freeze({ 0: 1.0, 1: 1.0, 2: 1.5, 3: 2.0, 4: 2.5 });
export const CAST_COST_FLOOR = 5;

function component(c, starting, increase, per) {
  return trunc(c.offset + c.A * starting + c.B * trunc(increase / Math.max(1, per)));
}

/** The effect's magic school, from the same table the cost reads. */
export function effectSchool(e) {
  return EFFECT_COST_TABLE[`${e.type},${e.subType & 0xff}`]?.skill ?? SKILLS.Destruction;
}

export function effectCost(e, skillOf, { online = true } = {}) {
  const entry = EFFECT_COST_TABLE[`${e.type},${e.subType & 0xff}`];
  if (!entry) return { gold: 0, sp: 0 };
  const skill = skillOf(entry.skill);
  let gold = 0;
  let active = false;
  if (entry.duration) { active = true; gold += component(entry.duration, e.durationBase, e.durationMod, e.durationPerLevel); }
  if (entry.chance) { active = true; gold += component(entry.chance, e.chanceBase, e.chanceMod, e.chancePerLevel); }
  if (entry.magnitude) {
    active = true;
    const base = trunc((e.magnitudeBaseLow + e.magnitudeBaseHigh) / 2);
    const plus = trunc((e.magnitudeLevelBase + e.magnitudeLevelHigh) / 2);
    gold += component(entry.magnitude, base, plus, e.magnitudePerLevel);
  }
  if (!active) gold += component({ A: 60, B: 100, offset: 160 }, 1, 1, 1);
  const R = 100;
  const sp = online && skill > R
    ? trunc((gold * (110 - R) * R) / (skill * 400))
    : trunc((gold * (110 - skill)) / 400);
  return { gold, sp };
}

/** The live spell-point cost of one record for one caster. */
export function spellCost(spell, ch, { online = ch?.online !== false } = {}) {
  const skillOf = (id) => skillValue(ch, id);
  let sp = 0;
  for (const e of spell?.effects ?? []) {
    if (e.type <= -1) continue;
    sp += effectCost(e, skillOf, { online }).sp;
  }
  sp = trunc(sp * (TARGET_COST_MULT[spell?.rangeType] ?? 1));
  if (spell?.minimumCastingCost) sp = CAST_COST_FLOOR;
  return Math.max(CAST_COST_FLOOR, sp);
}

/** One effect's magnitude: average, or the low/high end of the roll. */
export function magnitudeAt(e, level = 1, mode = 'avg') {
  const base = mode === 'min' ? e.magnitudeBaseLow : mode === 'max' ? e.magnitudeBaseHigh
    : (e.magnitudeBaseLow + e.magnitudeBaseHigh) / 2;
  const plus = mode === 'min' ? e.magnitudeLevelBase : mode === 'max' ? e.magnitudeLevelHigh
    : (e.magnitudeLevelBase + e.magnitudeLevelHigh) / 2;
  return base + plus * Math.floor(level / Math.max(1, e.magnitudePerLevel));
}
export const averageMagnitude = (e, level = 1) => magnitudeAt(e, level, 'avg');

/** A spell's duration in rounds, straight arithmetic (effects.js rollDuration). */
export function spellRounds(e, level = 1) {
  const per = Math.max(1, e.durationPerLevel);
  return e.durationBase + e.durationMod * Math.max(1, Math.floor(level / per));
}

/** The target's saving chance in per cent (spellcast.js savingChance,
 *  without the biography/race terms a reference foe does not carry). */
const ELEMENT_RESIST = Object.freeze({ 0: 'fire', 1: 'frost', 2: 'poison', 3: 'shock', 4: 'magic' });
export function savingChance(target, { pierce = 0, element = 4 } = {}) {
  let saving = 50 + trunc((target?.stats?.willpower ?? 50) / 10);
  const resist = target?._mods?.resist ?? {};
  saving += resist[ELEMENT_RESIST[element]] ?? 0;
  saving -= Math.max(0, pierce);
  return clamp(saving, 5, 95);
}

/** What a saving chance of `saving` lets land on average, per cent. */
export function savingLands(saving) {
  let sum = 0;
  for (let roll = 1; roll <= 100; roll++) {
    sum += roll > saving ? 100 : saving - 20 <= roll ? 100 - 5 * (saving - roll) : 0;
  }
  return sum / 100;
}

const ELEMENT_TRAIT = Object.freeze({ 0: 'flameproof', 1: 'frostproof', 2: 'venomproof', 3: 'stormproof', 4: 'spellproof' });
const DAMAGE_HEALTH = new Set(['4,0', '1,0', '11,8']);

/** The average health damage of one spell at one target. */
export function spellDamage(spell, ch, target, {
  level = ch?.level ?? 1,
  online = ch?.online !== false,
  potencyPct = 0,
  pierce = 0,
  mode = 'avg',
} = {}) {
  if (!spell) return { damage: 0, effects: [], school: SKILLS.Destruction, saving: 0 };
  const traits = target?.bossTraits ?? [];
  const element = spell.element ?? 4;
  const trait = ELEMENT_TRAIT[element];
  const resistMult = trait && traits.includes(trait) ? 0.25 : 1;
  const school = effectSchool(spell.effects?.[0] ?? { type: 4, subType: 0 });
  const climb = effectiveSkill(ch?.skills?.[school] ?? 0);
  const schoolMult = online && climb > 100 ? 1 + (climb - 100) * 0.01 : 1;
  const powerMult = schoolMult * Math.max(0.5, 1 + Math.min(50, potencyPct) / 100) * resistMult;
  const saving = savingLands(savingChance(target, { pierce, element }));
  let instant = 0;
  let dotPerTick = 0;
  let dotRounds = 0;
  const effects = [];
  for (const e of spell.effects ?? []) {
    if (e.type <= -1) continue;
    const key = `${e.type},${e.subType}`;
    if (!DAMAGE_HEALTH.has(key)) {
      effects.push({ key, damage: 0, note: 'not health damage' });
      continue;
    }
    const mag = magnitudeAt(e, level, mode);
    const rounds = e.type === 1 ? spellRounds(e, level) : 1;
    const tick = mag * (saving / 100) * powerMult;
    if (e.type === 1) {
      dotPerTick += tick;
      dotRounds = Math.max(dotRounds, rounds);
      effects.push({ key, magnitude: mag, rounds, seconds: rounds * MAGIC_ROUND_SECONDS, perTick: tick, damage: tick * rounds, dot: true });
    } else {
      instant += tick;
      effects.push({ key, magnitude: mag, rounds: 1, seconds: 0, perTick: tick, damage: tick, dot: false });
    }
  }
  const dotTotal = dotPerTick * dotRounds;
  return {
    damage: instant + dotTotal,
    instant,
    dotPerTick,
    dotRounds,
    dotSeconds: dotRounds * MAGIC_ROUND_SECONDS,
    dotTotal,
    effects,
    school,
    saving: saving / 100,
    powerMult,
    resistMult,
  };
}

/** The cast rate: Speed's share plus castSpeed% (castSpeed.js). */
export function castRate(ch, { castSpeedPct = 0 } = {}) {
  const speed = clamp(ch?.stats?.speed ?? 50, 0, 100);
  return clamp(1 + (speed - 50) / 200 + castSpeedPct / 100, 0.5, 2);
}

/** The full spell card. `spellsPerPool` assumes no regeneration. */
export function analyzeSpell(spell, ch, target, {
  level = ch?.level ?? 1,
  online = ch?.online !== false,
  potencyPct = 0,
  pierce = 0,
  castSpeedPct = 0,
  magicka = ch?.maxMagicka ?? Math.floor((ch?.stats?.intelligence ?? 50) * 3),
  health = 0,
  traits = [],
} = {}) {
  const dmg = spellDamage(spell, ch, target, { level, online, potencyPct, pierce });
  const dmgMin = spellDamage(spell, ch, target, { level, online, potencyPct, pierce, mode: 'min' });
  const dmgMax = spellDamage(spell, ch, target, { level, online, potencyPct, pierce, mode: 'max' });
  const cost = spellCost(spell, ch, { online });
  const rate = castRate(ch, { castSpeedPct });
  const castSeconds = 0.7 / rate;
  const castsPerPool = cost > 0 ? Math.floor(magicka / cost) : 0;
  const burstDps = dmg.instant / castSeconds;
  const dotDps = dmg.dotPerTick / MAGIC_ROUND_SECONDS;
  const dps = burstDps + dotDps;
  const burstDpsMin = dmgMin.instant / castSeconds;
  const burstDpsMax = dmgMax.instant / castSeconds;
  const dotDpsMin = dmgMin.dotPerTick / MAGIC_ROUND_SECONDS;
  const dotDpsMax = dmgMax.dotPerTick / MAGIC_ROUND_SECONDS;
  const dpsMin = burstDpsMin + dotDpsMin;
  const dpsMax = burstDpsMax + dotDpsMax;
  const poolDamage = dmg.damage * castsPerPool;
  return {
    name: spell?.name ?? 'spell',
    index: spell?.index ?? null,
    cost,
    damage: dmg.damage,
    damageMin: dmgMin.damage,
    damageMax: dmgMax.damage,
    instant: dmg.instant,
    instantMin: dmgMin.instant,
    instantMax: dmgMax.instant,
    dotPerTick: dmg.dotPerTick,
    dotPerTickMin: dmgMin.dotPerTick,
    dotPerTickMax: dmgMax.dotPerTick,
    dotRounds: dmg.dotRounds,
    dotSeconds: dmg.dotSeconds,
    dotTotal: dmg.dotTotal,
    burstDps,
    dotDps,
    dps,
    burstDpsMin,
    burstDpsMax,
    dotDpsMin,
    dotDpsMax,
    dpsMin,
    dpsMax,
    castSeconds,
    castsPerPool,
    poolDamage,
    poolSeconds: castsPerPool * castSeconds,
    magicka,
    saving: dmg.saving,
    school: dmg.school,
    powerMult: dmg.powerMult,
    elements: dmg.effects,
    rangeType: spell?.rangeType ?? 0,
    element: spell?.element ?? 4,
    ttk: health > 0 && dps > 0 ? health / dps : null,
  };
}


/** A fight of `seconds`, spending the pool on this one spell. A DoT is
 *  renewed, never stacked, so its ticks cover only the fight it is up. */
export function spellRotation(spell, ch, target, { seconds = 30, manaSolved = true, ...opts } = {}) {
  const card = analyzeSpell(spell, ch, target, opts);
  const maxCasts = manaSolved ? Infinity : (card.cost > 0 ? Math.floor(card.magicka / card.cost) : Infinity);
  const dotOnly = card.instant === 0 && card.dotRounds > 0;
  const wanted = dotOnly
    ? Math.max(1, Math.ceil(seconds / Math.max(1, card.dotSeconds)))
    : (card.castSeconds > 0 ? Math.ceil(seconds / card.castSeconds) : 0);
  const casts = Math.max(0, Math.min(maxCasts, wanted));
  const fight = manaSolved ? seconds : Math.min(seconds, casts * card.castSeconds);
  const active = Math.min(fight, card.dotSeconds);
  const instantDamage = card.instant * casts;
  const instantDamageMin = card.instantMin * casts;
  const instantDamageMax = card.instantMax * casts;
  const dotDamage = card.dotPerTick * (active / MAGIC_ROUND_SECONDS);
  const dotDamageMin = card.dotPerTickMin * (active / MAGIC_ROUND_SECONDS);
  const dotDamageMax = card.dotPerTickMax * (active / MAGIC_ROUND_SECONDS);
  const total = instantDamage + dotDamage;
  const totalMin = instantDamageMin + dotDamageMin;
  const totalMax = instantDamageMax + dotDamageMax;
  const timeToEmpty = casts * card.castSeconds;
  const dotDps = dotDamage / Math.max(1e-9, active);
  const dotDpsMin = dotDamageMin / Math.max(1e-9, active);
  const dotDpsMax = dotDamageMax / Math.max(1e-9, active);
  const manaDps = dotOnly ? dotDps : (timeToEmpty > 0 ? total / timeToEmpty : 0);
  const manaDpsMin = dotOnly ? dotDpsMin : (timeToEmpty > 0 ? totalMin / timeToEmpty : 0);
  const manaDpsMax = dotOnly ? dotDpsMax : (timeToEmpty > 0 ? totalMax / timeToEmpty : 0);
  const windowDps = seconds > 0 ? total / seconds : 0;
  const windowDpsMin = seconds > 0 ? totalMin / seconds : 0;
  const windowDpsMax = seconds > 0 ? totalMax / seconds : 0;
  return {
    ...card,
    seconds,
    casts,
    fightSeconds: fight,
    timeToEmpty,
    instantDamage,
    dotDamage,
    totalDamage: total,
    totalDamageMin: totalMin,
    totalDamageMax: totalMax,
    manaDps,
    manaDpsMin,
    manaDpsMax,
    windowDps,
    windowDpsMin,
    windowDpsMax,
    dotDps,
    dotDpsMin,
    dotDpsMax,
    manaSolved,
    sustainedDps: windowDps,
    sustainedDpsMin: windowDpsMin,
    sustainedDpsMax: windowDpsMax,
    manaLeft: manaSolved ? null : card.magicka - casts * card.cost,
    poolKill: manaSolved ? (opts.health > 0 ? total >= opts.health : null) : (opts.health > 0 ? total >= opts.health : null),
    ttk: opts.health > 0 && (dotOnly ? dotDps : manaDps) > 0 && (manaSolved || total >= opts.health)
      ? opts.health / (dotOnly ? dotDps : manaDps) : null,
  };
}
