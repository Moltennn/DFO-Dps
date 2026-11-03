/*
 * dfo-dps - the combat model.
 *
 * The per-swing maths follows DFO Online's own combat core:
 *   combat/formulas.js        (classic FormulaHelper, DFU-verbatim)
 *   combat/pcaao.js           (Physical Combat And Armor Overhaul 1.44)
 *   combat/combatStats.js     (the in-game Combat Stats card)
 *   characters/weaponStates.js, combat/swingLaw.js (attack cadence)
 *   systems/bossTraits.js     (Curbing, Warded, ...)
 *   systems/martialPowers.js  (martial passives)
 *   systems/weaponMastery.js  (online skill past 100)
 *   systems/loot/lootRarity.js (affixes)
 * See NOTICE for the source and its MIT / Daggerfall Unity attribution.
 */
import {
  BOSS_TRAITS, CURB_SHARE, MARTIAL_PATHS, MATERIALS, PCAAO_BODY_PARTS,
  RACES, SKILLS, STRUCK_BODY_PARTS, SWINGS, SWING_HANDLING,
  SWING_BASE_FRAME, SWING_FRAME_MAX, SWING_FRAME_MIN, SWING_HEFT_FREE_KG,
  SWING_HEFT_MAX, SWING_HEFT_PER_KG, SWING_MODS, SWING_SHORT_BLADE,
  SWING_TEMPO_AT_0, SWING_TEMPO_AT_100, SWING_TWO_HANDED,
  WARD_SHARE, WEAPON_MATERIAL_MODIFIER, WEAPON_TYPES, WEAPONS, WRATH_AFTER_S,
  GATE_SHIELDS, GATE_SHIELD_S, gateHealth, gateHitCap, RRI_WEAPON_DAMAGE, RRI_SPEED_REDUCTION_FACTOR,
  BOW_DRAW_LOOSE_S, GUN_FPS, GUN_RELOAD_S, PISTOLET_FPS, PISTOLET_RELOAD_S, THUNDERLOCK_FRAMES, PISTOLET_FRAMES, thunderlockReloadSeconds,
} from './data.js';
import { enchantDps, procsBeforeBreak } from './enchants.js';
import { socketAffixes } from './sockets.js';
import {
  effectiveSkill, liveStat, masterCappedSkill, PROFICIENCY_FLAG, skillModOf,
  skillValue, WEAPON_SKILL,
} from './save.js';

const trunc = Math.trunc;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const floor = Math.floor;
const fround = Math.fround;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const sum = (a) => a.reduce((s, x) => s + x, 0);

/** Unity's Mathf.Round: half to even (pcaao.js unityRound). */
export function unityRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** The template and the live item as one weapon descriptor. */
export function weaponOf(item, { rri = false } = {}) {
  if (!item) return null;
  const t = WEAPONS[item.templateIndex];
  if (!t) return null;
  const affixes = [...(item.affixes ?? []), ...socketAffixes(item)];
  return {
    item,
    templateIndex: item.templateIndex,
    name: item.name || t.name,
    baseName: t.name,
    min: rri ? (RRI_WEAPON_DAMAGE[item.templateIndex]?.min ?? t.min) : (Number.isFinite(item.minDamage) && item.minDamage > 0 ? item.minDamage : t.min),
    max: rri ? (RRI_WEAPON_DAMAGE[item.templateIndex]?.max ?? t.max) : (Number.isFinite(item.maxDamage) && item.maxDamage > 0 ? item.maxDamage : t.max),
    skillId: WEAPON_SKILL[item.templateIndex] ?? SKILLS.HandToHand,
    skill: t.skill,
    type: t.type,
    weight: t.weight,
    shortBlade: t.shortBlade,
    twoHanded: t.twoHanded,
    ranged: !!(t.ranged || item.ranged),
    gun: !!(t.gun || item.gun),
    ammo: !!(t.ammo || item.ammo),
    wraps: !!(t.wraps || item.wraps),
    bowPull: t.bowPull ?? 1,
    bowWithin: t.bowWithin ?? 1,
    material: num(item.material, 0),
    materialName: MATERIALS[num(item.material, 0)] ?? 'Iron',
    damagePct: affixes.filter((a) => a?.id === 'damage').reduce((s, a) => s + num(a.value), 0),
    slayer: affixes.filter((a) => a?.id === 'slayer').reduce((s, a) => s + num(a.value), 0),
    slayerByGroup: Object.fromEntries(affixes.filter((a) => a?.id === 'slayer').map((a) => [String(a.param), num(a.value)])),
    elemental: affixes.filter((a) => a?.id === 'elemental').reduce((s, a) => s + num(a.value), 0),
    conditionPct: item.maxCondition > 0 ? clamp(num(item.currentCondition, item.maxCondition) / item.maxCondition, 0, 1) : 1,
    bonusDamage: num(item.__bonusDamage, 0),
  };
}

export function syntheticWeapon(templateIndex, material = 9, { rri = false } = {}) {
  const t = WEAPONS[templateIndex];
  if (!t) return null;
  return weaponOf({
    group: 'Weapons', templateIndex, material,
    name: `${MATERIALS[material] ?? ''} ${t.name}`.trim(),
    maxCondition: 100, currentCondition: 100,
  }, { rri });
}

export function isBlade(w) {
  return !!w && w.skillId !== SKILLS.BluntWeapon;
}
export function isBlunt(w) {
  return !w || w.skillId === SKILLS.BluntWeapon;
}

/** pcaao.js pcaaoWeaponToHit. */
export const weaponToHit = (w) => (WEAPON_MATERIAL_MODIFIER[w.material] ?? 0) * 2 + 2;

export function damageModifier(str) {
  return floor((str - 50) / 5);
}
export function pcaaoDamageModifier(str) {
  return floor((str - 50) / 10);
}

const hasAbility = (career, flag) => ((career?.abilityFlagsAndSpellPointsBitfield ?? 0) & flag) === flag;
const inRush = (e, divisor) => hasAbility(e?.career, 4) && num(e?.health) < trunc(num(e?.maxHealth) / divisor);

/** classic FormulaHelper.CalculateAdrenalineRushToHit / pcaao's. */
function adrenalineRushToHit(attacker, target, core) {
  let mod = 0;
  const div = core === 'overhaul' ? 6 : 8;
  const value = core === 'overhaul' ? 8 : 5; // improved variants (12/8) are not in v1
  if (inRush(attacker, div)) mod += value;
  if (inRush(target, div)) mod -= value;
  return mod;
}

/** classic FormulaHelper.CalculateProficiencyModifiers. */
function classicProficiency(ch, w, opts = {}) {
  const expert = ((ch.career?.weaponArmorShieldsBitfield ?? 0) >>> 16) & 0x3f;
  if (w) {
    if ((expert & (PROFICIENCY_FLAG[w.skillId] ?? -1)) === 0) return { damage: 0, toHit: 0 };
  } else if ((expert & 4) === 0) return { damage: 0, toHit: 0 };
  return { damage: trunc(ch.level / 3) + 1, toHit: ch.level };
}

/** pcaao.js pcaaoProficiencyModifiers. */
function overhaulProficiency(ch, w, opts = {}) {
  const expert = ((ch.career?.weaponArmorShieldsBitfield ?? 0) >>> 16) & 0x3f;
  const S = (k) => stat(ch, k, opts);
  const out = { damage: 0, toHit: 0 };
  if (!w) {
    if ((expert & 4) === 0) return out;
    out.damage = trunc(S('strength') / 50) + trunc(S('endurance') / 50) + trunc(S('agility') / 50) + trunc(S('speed') / 50) + 1;
    out.toHit = trunc(S('agility') / 22) + trunc(S('speed') / 22) + trunc(S('strength') / 22) + trunc(S('endurance') / 22) + trunc(S('luck') / 22);
    return out;
  }
  if ((expert & (PROFICIENCY_FLAG[w.skillId] ?? -1)) === 0) return out;
  switch (w.skillId) {
    case SKILLS.Archery:
      out.damage = trunc(S('strength') / 25) + trunc(S('agility') / 25) + 1;
      out.toHit = trunc(S('agility') / 8) + trunc(S('speed') / 20) + trunc(S('luck') / 20);
      break;
    case SKILLS.Axe:
      out.damage = trunc(S('strength') / 20) + trunc(S('agility') / 33) + 1;
      out.toHit = trunc(S('strength') / 11) + trunc(S('agility') / 11) + trunc(S('luck') / 22);
      break;
    case SKILLS.BluntWeapon:
      out.damage = trunc(S('strength') / 20) + trunc(S('endurance') / 33) + 1;
      out.toHit = trunc(S('strength') / 10) + trunc(S('agility') / 16) + trunc(S('luck') / 16);
      break;
    case SKILLS.LongBlade:
      out.damage = trunc(S('agility') / 20) + trunc(S('strength') / 33) + 1;
      out.toHit = trunc(S('agility') / 8) + trunc(S('speed') / 20) + trunc(S('luck') / 20);
      break;
    case SKILLS.ShortBlade:
      out.damage = trunc(S('agility') / 25) + trunc(S('speed') / 25) + 1;
      out.toHit = trunc(S('agility') / 10) + trunc(S('speed') / 14) + trunc(S('luck') / 18);
      break;
    default:
      break;
  }
  return out;
}

/** classic FormulaHelper.CalculateRacialModifiers. */
function classicRacial(ch, w, opts = {}) {
  if (!w) return { damage: 0, toHit: 0 };
  if (ch.raceId === RACES.DarkElf) return { damage: trunc(ch.level / 4), toHit: trunc(ch.level / 4) };
  if (ch.raceId === RACES.WoodElf && w.skillId === SKILLS.Archery) return { damage: trunc(ch.level / 3), toHit: trunc(ch.level / 3) };
  if (ch.raceId === RACES.Redguard) return { damage: trunc(ch.level / 3), toHit: trunc(ch.level / 3) };
  return { damage: 0, toHit: 0 };
}

/** pcaao.js pcaaoRacialModifiers, the weapon arms that matter for melee. */
function overhaulRacial(ch, w, opts = {}) {
  const out = { damage: 0, toHit: 0 };
  if (!w) return out;
  const S = (k) => stat(ch, k, opts);
  const ws = w.skillId;
  switch (ch.raceId) {
    case RACES.Argonian:
      if (ws === SKILLS.ShortBlade) {
        out.damage = trunc(S('agility') / 33) + trunc(S('speed') / 33);
        out.toHit = trunc(S('agility') / 16) + trunc(S('speed') / 33) + trunc(S('luck') / 33);
      }
      break;
    case RACES.DarkElf:
      if (ws === SKILLS.LongBlade) {
        out.damage = trunc(S('agility') / 25) + trunc(S('strength') / 25);
        out.toHit = trunc(S('agility') / 25) + trunc(S('speed') / 33) + trunc(S('luck') / 33);
      } else if (ws === SKILLS.ShortBlade) {
        out.damage = trunc(S('agility') / 50) + trunc(S('speed') / 50);
        out.toHit = trunc(S('agility') / 33) + trunc(S('speed') / 33) + trunc(S('luck') / 33);
      }
      break;
    case RACES.WoodElf:
      if (ws === SKILLS.Archery) {
        out.damage = trunc(S('strength') / 25) + trunc(S('agility') / 25);
        out.toHit = trunc(S('agility') / 10) + trunc(S('speed') / 25) + trunc(S('luck') / 20);
      }
      break;
    case RACES.Khajiit:
      if (ws === SKILLS.ShortBlade) {
        out.damage = trunc(S('agility') / 33) + trunc(S('speed') / 50);
        out.toHit = trunc(S('agility') / 20) + trunc(S('speed') / 33) + trunc(S('luck') / 50);
      }
      break;
    case RACES.Nord:
      if (ws === SKILLS.Axe) {
        out.damage = trunc(S('strength') / 16) + trunc(S('agility') / 33);
        out.toHit = trunc(S('strength') / 33) + trunc(S('agility') / 33) + trunc(S('luck') / 33);
      } else if (ws === SKILLS.BluntWeapon) {
        out.damage = trunc(S('strength') / 25) + trunc(S('endurance') / 25);
        out.toHit = trunc(S('strength') / 25) + trunc(S('agility') / 33) + trunc(S('luck') / 33);
      }
      break;
    case RACES.Redguard:
      if (ws === SKILLS.LongBlade) {
        out.damage = trunc(S('agility') / 33) + trunc(S('strength') / 50);
        out.toHit = trunc(S('agility') / 10) + trunc(S('speed') / 25) + trunc(S('luck') / 25);
      } else if (ws === SKILLS.Archery) {
        out.damage = trunc(S('strength') / 50) + trunc(S('agility') / 50);
        out.toHit = trunc(S('agility') / 25) + trunc(S('speed') / 33) + trunc(S('luck') / 33);
      } else if (ws === SKILLS.BluntWeapon) {
        out.damage = trunc(S('strength') / 33) + trunc(S('endurance') / 33);
        out.toHit = trunc(S('strength') / 20) + trunc(S('agility') / 25) + trunc(S('luck') / 33);
      } else if (ws === SKILLS.Axe) {
        out.damage = trunc(S('strength') / 16) + trunc(S('agility') / 33);
        out.toHit = trunc(S('strength') / 33) + trunc(S('agility') / 33) + trunc(S('luck') / 33);
      }
      break;
    default:
      break;
  }
  return out;
}

function proficiency(ch, w, core, opts = {}) {
  return core === 'classic' ? classicProficiency(ch, w, opts) : overhaulProficiency(ch, w, opts);
}
function racial(ch, w, core, opts = {}) {
  return core === 'classic' ? classicRacial(ch, w, opts) : overhaulRacial(ch, w, opts);
}

/** systems/martialPowers.js martialFold: stats the path adds to its owner. */
function passiveStat(ch, name, opts) {
  const path = ch.martialPath;
  if (!path || opts.passiveOn === false) return 0;
  if (path === 'shadowdancer' && name === 'agility') return 10;
  if (path === 'windrunner' && name === 'speed') return 10;
  return 0;
}
function stat(ch, name, opts = {}) {
  // The live value already holds the 100 ceiling plus whatever lifts it (the
  // Firmament's statMax, the Mace of Molag Bal). Do not clamp it back to 100.
  return Math.max(0, liveStat(ch, name) + passiveStat(ch, name, opts));
}
function skill(ch, id, opts = {}) {
  return skillValue(ch, id) + (opts.passiveOn !== false && ch.martialPath === 'shadowdancer' && id === SKILLS.Dodging ? 15 : 0);
}

/** systems/weaponStates.js: one anim frame. */
export function swingFrameSeconds(speed, { heft = 1, handling = 1 } = {}) {
  const s = clamp(num(speed, 50), 0, 100);
  const tempo = 1 + ((50 - s) / 100) * (SWING_TEMPO_AT_0 - SWING_TEMPO_AT_100);
  return clamp(SWING_BASE_FRAME * tempo * heft * handling, SWING_FRAME_MIN, SWING_FRAME_MAX);
}

/** characters/weaponStates.js swingHeft. */
export function swingHeft(weightKg, strength) {
  const w = Math.max(0, num(weightKg));
  const str = clamp(num(strength, 50), 0, 100);
  const load = (w * (150 - str)) / 100;
  return 1 + Math.min(SWING_HEFT_MAX, Math.max(0, (load - SWING_HEFT_FREE_KG) * SWING_HEFT_PER_KG));
}

export function swingHandling(w) {
  if (!w) return SWING_SHORT_BLADE * 0 + SWING_HANDLING[WEAPON_TYPES.Melee];
  const kind = w.shortBlade ? SWING_SHORT_BLADE : (SWING_HANDLING[w.type] ?? 1);
  return kind * (w.twoHanded ? SWING_TWO_HANDED : 1);
}

/** systems/martialPowers.js martialPace. */
export function martialPace(ch, opts = {}) {
  const path = ch.martialPath;
  if (!path || opts.passiveOn === false) return 0;
  if (path === 'warblade' && opts.rhythm) return 15;
  if (path === 'bladedancer' && opts.cyclone) return 20;
  if (path === 'berserker' && num(opts.healthShare, 1) < 0.5) return 10;
  return 0;
}

/** systems/weaponMastery.js weaponMasteryPace: short blade climb past 100. */
export function masteryPace(ch, w, opts = {}) {
  if (!ch.online || !w || w.skillId !== SKILLS.ShortBlade) return 0;
  const raw = ch.skills?.[SKILLS.ShortBlade] ?? 0;
  const climb = Math.max(0, effectiveSkill(masterCappedSkill(ch, SKILLS.ShortBlade, raw)) - 100);
  return climb * 1;
}

/** The swing cadence, in seconds per swing (a fresh main-hand strike). */
export function cadence(ch, w, opts = {}) {
  const speed = stat(ch, 'speed', opts);
  const weight = w ? w.weight * (opts.offHand ? 1.5 : 1) : 0;
  if (!w) {
    const tick = swingFrameSeconds(speed, { heft: 1, handling: swingHandling(null) });
    return { seconds: 5 * tick, tick, aps: 1 / (5 * tick), speed, heft: 1, handling: swingHandling(null), pace: 0 };
  }
  const strength = stat(ch, 'strength', opts);
  const handling = swingHandling(w);
  let heft = 1;
  let tick;
  let usedSpeed = speed;
  if (opts.rri) {
    // Roleplay & Realism: Items GetMeleeWeaponAnimTime, restated over the port's swing law.
    const capped = Math.min(speed, 98);
    const adjustedWeight = ((150 - strength) * weight) / 100;
    const reduction = adjustedWeight * RRI_SPEED_REDUCTION_FACTOR;
    usedSpeed = Math.trunc(capped - (capped * reduction) / 90);
    tick = swingFrameSeconds(usedSpeed, { handling });
  } else {
    heft = swingHeft(weight, strength);
    tick = swingFrameSeconds(speed, { heft, handling });
  }
  const pace = clamp(martialPace(ch, opts) + masteryPace(ch, w, opts) + num(opts.attackSpeedPct, 0), 0, 50);
  if (pace > 0) tick = Math.max(SWING_FRAME_MIN, tick / (1 + pace / 100));
  const seconds = 5 * tick; // a fresh strike stands on frame 0: strikeTicks 5, hold 0
  return { seconds, tick, aps: 1 / seconds, speed: usedSpeed, heft, handling, pace, rri: !!opts.rri };
}

/** Bows and the port's guns. A bow's full cycle is the five-frame swing law
 *  (the draw/loose is 0.5625s of it, the rest is the reload); a gun's is its
 *  frame strip plus its reload. A Pistolet pair alternates two machines. */
export function rangedCadence(ch, w, opts = {}) {
  if (!w) return null;
  if (w.gun) {
    const speed = stat(ch, 'speed', opts);
    const pistol = w.templateIndex === 562;
    const fps = pistol ? PISTOLET_FPS : GUN_FPS;
    const frames = pistol ? PISTOLET_FRAMES : THUNDERLOCK_FRAMES;
    const reload = pistol ? PISTOLET_RELOAD_S : thunderlockReloadSeconds(speed);
    const pair = !!opts.pair && pistol;
    const cycle = frames / fps + reload;
    const seconds = pair ? cycle / 2 : cycle;
    return { seconds, tick: 1 / fps, aps: 1 / seconds, speed, heft: 1, handling: swingHandling(w), pace: 0, gun: true, reload, pair, cycle };
  }
  // A bow is its own law: the frame is the swing law's, but RRI never
  // touches a bow and the cycle is the drawn-idle release plus the
  // reload the port gives it (BOW-LAW). Pacing at `within` keeps the
  // BOW_FAST penalty at zero; spamming stacks it to x0.2.
  const speed = stat(ch, 'speed', opts);
  const strength = stat(ch, 'strength', opts);
  const handling = swingHandling(w);
  let frame = swingFrameSeconds(speed, { heft: swingHeft(w.weight, strength), handling });
  const pace = clamp(martialPace(ch, opts) + masteryPace(ch, w, opts) + num(opts.attackSpeedPct, 0), 0, 50);
  if (pace > 0) frame = Math.max(0.09, frame / (1 + pace / 100));
  const reload = Math.max(0, 5 * frame - BOW_DRAW_LOOSE_S);
  const cycle = (opts.bowDrawback ? 7 : 4) * 0.0625 + reload;
  const within = w.bowWithin ?? 1;
  const spam = !!opts.bowSpam;
  const seconds = spam ? cycle : Math.max(cycle, within);
  const pull = (w.bowPull ?? 1) * (spam ? 0.2 : 1);
  return { seconds, cycle, tick: frame, aps: 1 / seconds, speed, heft: 1, handling, pace, bow: true, reload, within, pull, spam };
}

/** systems/bossTraits.js: the blow's resistance. */
export function weaponResistFactor(w, traits = []) {
  let f = 1;
  if (traits.includes('bladeturning') && isBlade(w)) f *= 0.5;
  if (traits.includes('stoneskin') && isBlunt(w)) f *= 0.5;
  return f;
}

/** E[min(D, cap)] for a uniform integer D in [min,max]. */
export function expectedCapped(min, max, cap) {
  if (!(cap > 0) || max <= cap) return (min + max) / 2;
  if (min >= cap) return cap;
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi < lo) return Math.min(cap, (min + max) / 2);
  let total = 0;
  for (let d = lo; d <= hi; d++) total += Math.min(d, cap);
  return total / (hi - lo + 1);
}

function critModel(ch, core, opts = {}) {
  const crit = skill(ch, SKILLS.CriticalStrike, opts);
  const luck = stat(ch, 'luck', opts);
  const pct = (n) => clamp(n, 0, 100) / 100;
  if (core !== 'overhaul') {
    return { chance: pct(crit), hitBonus: trunc(crit / 10), damageMult: 1, kind: 'hit', skill: crit };
  }
  if (opts.critDamage === false) {
    return { chance: pct(trunc(crit / 3)), hitBonus: trunc(crit / 3), damageMult: 1, kind: 'hit', skill: crit };
  }
  const luckTerm = floor(fround((luck - 50) / 25));
  return {
    chance: pct(trunc(crit / (4 - luckTerm))),
    hitBonus: trunc(crit / 4),
    damageMult: fround(fround(trunc(crit / 5) * fround(0.05)) + 1),
    kind: 'damage',
    skill: crit,
  };
}

function bodyWeights(core) {
  const table = core === 'overhaul' ? PCAAO_BODY_PARTS : STRUCK_BODY_PARTS;
  const w = new Array(7).fill(0);
  for (const p of table) w[p]++;
  return w.map((n) => n / table.length);
}

/** The hit half: combat/combatStats.js hitModel. */
export function hitModel(ch, w, target, swingKey, core, opts = {}) {
  const swing = SWING_MODS[swingKey] ?? { damage: 0, toHit: 0 };
  const prof = proficiency(ch, w, core, opts);
  const race = racial(ch, w, core, opts);
  const crit = critModel(ch, core, opts);
  const targetDodge = skill(target, SKILLS.Dodging, opts);
  const enchant = ch._enchantMods?.chanceToHitMod ?? 0;
  let base;
  let other;
  if (core === 'overhaul') {
    base = Math.ceil(fround(skill(ch, w?.skillId ?? SKILLS.HandToHand, opts) * 1.5))
      + swing.toHit + prof.toHit + race.toHit + (w ? weaponToHit(w) : 0);
    other = adrenalineRushToHit(ch, target, core) + enchant
      + trunc((stat(ch, 'luck', opts) - stat(target, 'luck')) / 10)
      + trunc((stat(ch, 'agility', opts) - stat(target, 'agility')) / 4)
      + trunc((stat(ch, 'speed', opts) - stat(target, 'speed')) / 8)
      - unityRound(fround((stat(target, 'luck') - 50) / 10))
      - trunc(targetDodge / 2)
      + (target.isClass ? -50 : 0)
      + (opts.offHand ? -5 : 0);
  } else {
    base = skill(ch, w?.skillId ?? SKILLS.HandToHand, opts) + swing.toHit + prof.toHit + race.toHit;
    if (w) base += (WEAPON_MATERIAL_MODIFIER[w.material] ?? 0) * 10;
    other = adrenalineRushToHit(ch, target, core) + enchant
      + trunc((stat(ch, 'luck', opts) - stat(target, 'luck')) / 10)
      + trunc((stat(ch, 'agility', opts) - stat(target, 'agility')) / 10)
      - floor(targetDodge / 4)
      + (target.isPlayer ? 0 : (target.isClass ? -50 : -10));
  }
  const weights = bodyWeights(core);
  let plain = 0;
  let critHit = 0;
  let armourAvg = 0;
  weights.forEach((weight, part) => {
    const armour = core === 'overhaul'
      ? (target.isClass ? 60 : (target.armorValues?.[part] ?? 0))
      : (target.armorValues?.[part] ?? 0);
    armourAvg += weight * armour;
    plain += (weight * clamp(base + armour + other, 3, 97)) / 100;
    critHit += (weight * clamp(base + armour + other + crit.hitBonus, 3, 97)) / 100;
  });
  return {
    hit: (1 - crit.chance) * plain + crit.chance * critHit,
    hitPlain: plain,
    hitCrit: critHit,
    crit,
    terms: { base, armour: armourAvg, other, dodge: core === 'overhaul' ? trunc(targetDodge / 2) : floor(targetDodge / 4) },
    prof,
    racial: race,
  };
}

/** systems/martialPowers.js martialBlowPct. */
export function martialBlowPct(ch, target, opts = {}) {
  const path = ch.martialPath;
  if (!path || opts.passiveOn === false) return 0;
  const share = num(opts.healthShare, 1);
  switch (path) {
    case 'blademaster': return 3 * clamp(num(opts.stacks, 5), 0, 5);
    case 'warblade': return opts.rally ? 15 : 0;
    case 'ranger': return (target.group === 'animals' || target.affinity === 'animal') ? 20 : 0;
    case 'cutthroat': return opts.unaware ? 25 : 0;
    case 'assassin': return opts.firstBlow ? 30 : 0;
    case 'berserker': return share < 0.5 ? 20 : 0;
    case 'crusader': return (target.group === 'undead' || target.group === 'daedra') ? 20 : 0;
    default: return 0;
  }
}

/** systems/weaponMastery.js weaponPastPct (online only). */
export function masteryPct(ch, w, target, opts = {}) {
  if (!ch.online || !w) return 0;
  const id = w.skillId;
  const raw = ch.skills?.[id] ?? 0;
  const climb = Math.max(0, effectiveSkill(masterCappedSkill(ch, id, raw)) - 100);
  let pct = 0;
  if (climb > 0) {
    if (id === SKILLS.LongBlade || id === SKILLS.Archery) pct += climb * 1;
    else if (id === SKILLS.Axe) pct += num(opts.healthShare, 1) < 0.5 ? climb * 2 : 0;
    else if (id === SKILLS.BluntWeapon) pct += num(opts.healthShare, 1) >= 0.5 ? climb * 2 : 0;
  }
  if (id !== SKILLS.HandToHand && !ch._mentor) {
    const gear = skillModOf(ch, id);
    if (gear > 0) pct += Math.min(320, gear * 0.44);
  }
  return pct;
}

function applyPct(damage, pct) {
  return pct > 0 ? damage + floor(damage * (pct / 100) + 1e-9) : damage;
}


/** pcaao.js pcaaoAlterDamageBasedOnWepCondition, at 100% condition a no-op. */
function conditionMultiplier(w, powerful = false) {
  if (!w) return 1;
  const pct = w.conditionPct * 100;
  const blunt = w.skillId === SKILLS.BluntWeapon;
  if (pct >= 76 && !powerful) return 1; // no edge bonus without the wear module
  if (blunt) {
    if (pct >= 92) return 1.1;
    if (pct >= 76 || pct >= 61) return 1;
    if (pct >= 41) return 0.9;
    if (pct >= 16) return 0.8;
    if (pct >= 6) return 0.65;
    if (pct > 5) return 1;
    return 0.5;
  }
  if (pct >= 92) return 1.3;
  if (pct >= 76) return 1.1;
  if (pct >= 61) return 1;
  if (pct >= 41) return 0.85;
  if (pct >= 16) return 0.7;
  if (pct >= 6) return 0.45;
  if (pct > 5) return 1;
  return 0.25;
}

/** The blow's damage after the registered blow modifiers (martial, mastery, slayer, gear). */
export function weaponBlow(ch, w, damage, target, opts = {}) {
  let d = damage;
  const lines = w ?? opts.wraps ?? null;
  const mastery = masteryPct(ch, w, target, opts);
  if (mastery > 0) d = applyPct(d, mastery);
  const martial = martialBlowPct(ch, target, opts);
  if (martial > 0) d = applyPct(d, martial);
  const slayer = lines?.slayerByGroup?.[String(target?.group ?? '')] ?? 0;
  if (slayer > 0) d = applyPct(d, slayer);
  if (lines?.elemental) d += lines.elemental;
  const theory = num(opts.damagePct, 0);
  if (theory) d = applyPct(d, theory);
  const firm = num(opts.firmamentDamagePct, 0);
  if (firm) d = applyPct(d, firm);
  const bow = num(opts.bowPull, 1);
  if (bow !== 1) d = Math.max(1, Math.round(d * bow));
  return d;
}

/** The damage half: combat/combatStats.js damageModel. */
export function damageModel(ch, w, target, swingKey, core, opts = {}) {
  const swing = SWING_MODS[swingKey] ?? { damage: 0, toHit: 0 };
  const prof = proficiency(ch, w, core, opts);
  const race = racial(ch, w, core, opts);
  const crit = critModel(ch, core, opts);
  const str = stat(ch, 'strength', opts);
  const dmgMods = swing.damage + prof.damage + race.damage;
  let rolls;
  let strMod;
  let matMod = 0;
  if (!w) {
    const h2h = skill(ch, SKILLS.HandToHand, opts);
    const lo = floor(h2h / 10) + 1;
    const hi = floor(h2h / 5) + 1;
    rolls = [];
    const wrapsPct = opts.wraps?.damagePct ?? 0;
    for (let r = lo; r <= hi; r++) rolls.push(wrapsPct ? trunc(r * (1 + wrapsPct / 100)) : r);
    strMod = core === 'overhaul' ? pcaaoDamageModifier(str) : damageModifier(str);
  } else {
    const lo = w.min;
    const hi = w.max;
    rolls = [];
    for (let r = lo; r <= hi; r++) {
      const rolled = w.damagePct ? trunc(r * (1 + w.damagePct / 100)) : r;
      rolls.push(rolled + w.bonusDamage);
    }
    matMod = WEAPON_MATERIAL_MODIFIER[w.material] ?? 0;
    strMod = core === 'overhaul' ? pcaaoDamageModifier(str) * (w.twoHanded ? 2 : 1) : damageModifier(str);
  }
  const one = (roll) => {
    let d = roll + dmgMods + strMod + matMod;
    if (d < 1) d = 0;
    if (d > 0) d = weaponBlow(ch, w, d, target, opts);
    if (d > 0 && w?.elemental) d += w.elemental;
    if (d > 0 && opts.offHand) d = Math.max(1, Math.round(d * 0.8));
    return d;
  };
  const finish = (d, critical) => {
    if (core !== 'overhaul') return d;
    d = Math.max(0, d);
    if (critical && crit.damageMult !== 1) d = unityRound(fround(d * crit.damageMult));
    if (d >= 1 && w) {
      const mult = conditionMultiplier(w, false);
      if (mult !== 1) d = unityRound(fround(d * mult));
    }
    return d;
  };
  const plain = rolls.map((r) => finish(one(r), false));
  const crits = rolls.map((r) => finish(one(r), true));
  return {
    min: Math.min(...plain), max: Math.max(...plain), avg: mean(plain),
    critMin: Math.min(...crits), critMax: Math.max(...crits), critAvg: mean(crits),
    parts: {
      roll: [Math.min(...rolls), Math.max(...rolls)],
      matMod, strMod, prof: prof.damage, racial: race.damage, twoHanded: !!w?.twoHanded,
      mastery: masteryPct(ch, w, target, opts), martial: martialBlowPct(ch, target, opts), slayer: w?.slayer ?? 0,
    },
    crit,
  };
}

/** The full card for one weapon and one target. */
export function analyze(ch, {
  weapon, target, core = 'overhaul', swing = 'StrikeLeft', critDamage = true,
  traits = [], health = null, passiveOn = true, ...opts
} = {}) {
  let w = weapon === undefined ? weaponOf(ch.weapon, { rri: !!opts.rri }) : weapon;
  if (w && opts.rri) {
    const rr = RRI_WEAPON_DAMAGE[w.templateIndex];
    if (rr) w = { ...w, min: rr.min, max: rr.max };
  }
  const t = target ?? { ...referenceFoe(ch.level, 'tough') };
  const tgt = { ...t, group: t.group ?? null, affinity: t.affinity ?? null };
  const wraps = !w && ch.wraps ? weaponOf(ch.wraps, { rri: !!opts.rri }) : null;
  if (opts.dual && ch.offWeapon && !w?.twoHanded && !w?.gun && !WEAPONS[ch.offWeapon.templateIndex]?.twoHanded) {
    const offWeapon = weaponOf(ch.offWeapon, { rri: !!opts.rri });
    const base = { ...opts, dual: false, target: t, traits, health, core, swing, critDamage };
    const main = analyze(ch, { ...base, weapon: w, offHand: false });
    const off = analyze({ ...ch, weapon: ch.offWeapon }, { ...base, weapon: offWeapon, offHand: true });
    const perSwing = (main.perSwing + off.perSwing) / 2;
    const perSwingMin = (main.perSwingMin + off.perSwingMin) / 2;
    const perSwingMax = (main.perSwingMax + off.perSwingMax) / 2;
    const cappedPerSwing = (main.cappedPerSwing + off.cappedPerSwing) / 2;
    const cappedPerSwingMin = (main.cappedPerSwingMin + off.cappedPerSwingMin) / 2;
    const cappedPerSwingMax = (main.cappedPerSwingMax + off.cappedPerSwingMax) / 2;
    const aps = main.cadence.aps * 2;
    const dps = perSwing * aps;
    const dpsMin = perSwingMin * aps;
    const dpsMax = perSwingMax * aps;
    const cappedDps = cappedPerSwing * aps;
    const cappedDpsMin = cappedPerSwingMin * aps;
    const cappedDpsMax = cappedPerSwingMax * aps;
    const enchantPerSwing = (main.enchantPerSwing + off.enchantPerSwing) / 2;
    const enchantDpsValue = enchantPerSwing * aps;
    const enchantDpsMin = (main.enchantDpsMin + off.enchantDpsMin) / 2 * 2;
    const enchantDpsMax = (main.enchantDpsMax + off.enchantDpsMax) / 2 * 2;
    const totalDps = cappedDps + enchantDpsValue;
    const totalDpsMin = cappedDpsMin + enchantDpsMin;
    const totalDpsMax = cappedDpsMax + enchantDpsMax;
    const bossHealth = main.health ?? 0;
    const ttk = bossHealth > 0 && cappedDps > 0 ? (bossHealth + main.ward) / cappedDps + main.shields : null;
    const totalTtk = bossHealth > 0 && (cappedDps + enchantDpsValue) > 0 ? (bossHealth + main.ward) / (cappedDps + enchantDpsValue) + main.shields : null;
    return {
      ...main, dual: true, perSwing, perSwingMin, perSwingMax, cappedPerSwing, cappedPerSwingMin, cappedPerSwingMax, dps, dpsMin, dpsMax, cappedDps, cappedDpsMin, cappedDpsMax, enchantPerSwing, enchantDps: enchantDpsValue, enchantDpsMin, enchantDpsMax,
      totalDps, totalDpsMin, totalDpsMax, ttk, totalTtk, capLoss: dps > 0 ? 1 - cappedDps / dps : 0,
      cadence: { ...main.cadence, seconds: main.cadence.seconds / 2, aps, dual: true },
    };
  }
  if (opts.pair && w?.templateIndex === 562) {
    const base = { ...opts, core, target: t, traits, health, swing, critDamage, weapon: w };
    const main = analyze(ch, { ...base, pair: false, offHand: false });
    const off = analyze(ch, { ...base, pair: false, offHand: true });
    const perSwing = (main.perSwing + off.perSwing) / 2;
    const perSwingMin = (main.perSwingMin + off.perSwingMin) / 2;
    const perSwingMax = (main.perSwingMax + off.perSwingMax) / 2;
    const cappedPerSwing = (main.cappedPerSwing + off.cappedPerSwing) / 2;
    const cappedPerSwingMin = (main.cappedPerSwingMin + off.cappedPerSwingMin) / 2;
    const cappedPerSwingMax = (main.cappedPerSwingMax + off.cappedPerSwingMax) / 2;
    const aps = main.cadence.aps * 2;
    const dps = perSwing * aps;
    const dpsMin = perSwingMin * aps;
    const dpsMax = perSwingMax * aps;
    const cappedDps = cappedPerSwing * aps;
    const cappedDpsMin = cappedPerSwingMin * aps;
    const cappedDpsMax = cappedPerSwingMax * aps;
    const enchantPerSwing = (main.enchantPerSwing + off.enchantPerSwing) / 2;
    const enchantDpsValue = enchantPerSwing * aps;
    const enchantDpsMin = (main.enchantDpsMin + off.enchantDpsMin) / 2 * 2;
    const enchantDpsMax = (main.enchantDpsMax + off.enchantDpsMax) / 2 * 2;
    const totalDps = cappedDps + enchantDpsValue;
    const totalDpsMin = cappedDpsMin + enchantDpsMin;
    const totalDpsMax = cappedDpsMax + enchantDpsMax;
    const bossHealth = main.health ?? 0;
    const ttk = bossHealth > 0 && cappedDps > 0 ? (bossHealth + main.ward) / cappedDps + main.shields : null;
    const totalTtk = bossHealth > 0 && (cappedDps + enchantDpsValue) > 0 ? (bossHealth + main.ward) / (cappedDps + enchantDpsValue) + main.shields : null;
    return {
      ...main,
      pair: true,
      perSwing, perSwingMin, perSwingMax,
      cappedPerSwing, cappedPerSwingMin, cappedPerSwingMax,
      dps, dpsMin, dpsMax,
      cappedDps, cappedDpsMin, cappedDpsMax,
      enchantPerSwing,
      enchantDps: enchantDpsValue,
      enchantDpsMin, enchantDpsMax,
      totalDps, totalDpsMin, totalDpsMax,
      totalTtk,
      cadence: { ...main.cadence, seconds: main.cadence.seconds / 2, aps, pair: true },
      ttk,
      capLoss: dps > 0 ? 1 - cappedDps / dps : 0,
    };
  }
  const bowPull = w?.ranged && !w?.gun ? (opts.bowSpam ? 0.2 * (w?.bowPull ?? 1) : (w?.bowPull ?? 1)) : 1;
  const simOpts = { ...opts, passiveOn, critDamage, healthShare: opts.healthShare ?? t.healthShare ?? 1, firmamentDamagePct: opts.firmamentDamagePct ?? ch.firmamentDamagePct ?? 0, bowPull, wraps };
  const hit = hitModel(ch, w, tgt, swing, core, simOpts);
  const dmg = damageModel(ch, w, tgt, swing, core, simOpts);
  const c = hit.crit.chance;
  const backSkill = skill(ch, 19, simOpts);
  const backChance = clamp(backSkill, 0, 100) / 100;
  const backUptime = clamp(num(opts.backstabUptime, 0), 0, 1);
  const backMult = 1 + 2 * backUptime * backChance;
  const perSwing = ((1 - c) * hit.hitPlain * dmg.avg + c * hit.hitCrit * dmg.critAvg) * backMult;
  const perSwingMin = ((1 - c) * hit.hitPlain * dmg.min + c * hit.hitCrit * dmg.critMin) * backMult;
  const perSwingMax = ((1 - c) * hit.hitPlain * dmg.max + c * hit.hitCrit * dmg.critMax) * backMult;
  const cad = w?.ranged ? rangedCadence(ch, w, simOpts) : cadence(ch, w, simOpts);

  const resist = weaponResistFactor(w, traits);
  const dmin = Math.max(0, Math.round(dmg.min * resist * backMult));
  const dmax = Math.max(0, Math.round(dmg.max * resist * backMult));
  const cmin = Math.max(0, Math.round(dmg.critMin * resist * backMult));
  const cmax = Math.max(0, Math.round(dmg.critMax * resist * backMult));
  const bossHealth = num(health, 0);
  const curbCap = traits.includes('curbing') && bossHealth > 0
    ? Math.max(1, Math.round(bossHealth * CURB_SHARE)) : 0;
  const hardCap = num(t.hitCap, 0);
  const caps = [curbCap, hardCap].filter((n) => n > 0);
  const cap = caps.length ? Math.min(...caps) : 0;
  const capSource = cap === 0 ? null : (hardCap > 0 && (!curbCap || hardCap <= curbCap) ? 'hit cap' : 'curbing');
  const ePlain = cap > 0
    ? (dmax <= cap ? dmg.avg * resist * backMult : expectedCapped(dmin, dmax, cap))
    : dmg.avg * resist * backMult;
  const eCrit = cap > 0
    ? (cmax <= cap ? dmg.critAvg * resist * backMult : expectedCapped(cmin, cmax, cap))
    : dmg.critAvg * resist * backMult;
  const cappedPerSwing = (1 - c) * hit.hitPlain * ePlain + c * hit.hitCrit * eCrit;
  const ePlainMin = cap > 0 ? Math.min(dmg.min * resist * backMult, cap) : dmg.min * resist * backMult;
  const ePlainMax = cap > 0 ? Math.min(dmg.max * resist * backMult, cap) : dmg.max * resist * backMult;
  const eCritMin = cap > 0 ? Math.min(dmg.critMin * resist * backMult, cap) : dmg.critMin * resist * backMult;
  const eCritMax = cap > 0 ? Math.min(dmg.critMax * resist * backMult, cap) : dmg.critMax * resist * backMult;
  const cappedPerSwingMin = (1 - c) * hit.hitPlain * ePlainMin + c * hit.hitCrit * eCritMin;
  const cappedPerSwingMax = (1 - c) * hit.hitPlain * ePlainMax + c * hit.hitCrit * eCritMax;

  const dps = perSwing * cad.aps;
  const dpsMin = perSwingMin * cad.aps;
  const dpsMax = perSwingMax * cad.aps;
  const cappedDps = cappedPerSwing * cad.aps;
  const cappedDpsMin = cappedPerSwingMin * cad.aps;
  const cappedDpsMax = cappedPerSwingMax * cad.aps;
  const ench = opts.enchants === false ? null : enchantDps(w?.item ?? ch.wraps ?? ch.weapon, ch, tgt, { hit: hit.hit, aps: cad.aps, level: ch.level, potencyPct: opts.potencyPct, pierce: opts.pierce, cap });
  const enchantPerSwing = ench?.perSwing ?? 0;
  const enchantDpsValue = ench?.dps ?? 0;
  const enchantDpsMin = ench?.dpsMin ?? 0;
  const enchantDpsMax = ench?.dpsMax ?? 0;
  const totalDps = cappedDps + enchantDpsValue;
  const totalDpsMin = cappedDpsMin + enchantDpsMin;
  const totalDpsMax = cappedDpsMax + enchantDpsMax;
  const ward = traits.includes('warded') && bossHealth > 0 ? Math.max(1, Math.round(bossHealth * WARD_SHARE)) : 0;
  const shields = Math.max(0, num(t.phaseShields, 0)) * Math.max(0, num(t.shieldSeconds, 0));
  const ttk = bossHealth > 0 && cappedDps > 0 ? (bossHealth + ward) / cappedDps + shields : null;
  const totalTtk = bossHealth > 0 && (cappedDps + enchantDpsValue) > 0 ? (bossHealth + ward) / (cappedDps + enchantDpsValue) + shields : null;
  const wrath = traits.includes('wrathful');
  return {
    core, weapon: w, target: tgt, swing, hit, damage: dmg, cadence: cad,
    perSwing, perSwingMin, perSwingMax, dps, dpsMin, dpsMax,
    cappedPerSwing, cappedPerSwingMin, cappedPerSwingMax, cappedDps, cappedDpsMin, cappedDpsMax, cap, capSource, capLoss: dps > 0 ? 1 - cappedDps / dps : 0,
    enchantPerSwing, enchantDps: enchantDpsValue, enchantDpsMin, enchantDpsMax, totalDps, totalDpsMin, totalDpsMax, totalTtk, enchantProcs: ench?.procs ?? [], procsBeforeBreak: procsBeforeBreak(w?.item ?? ch.wraps ?? ch.weapon),
    resist, health: bossHealth || null, ward, shields, ttk, wrath, wrathAt: WRATH_AFTER_S,
    backstab: { skill: backSkill, chance: backChance, multiplier: 3, uptime: backUptime, expectedMult: backMult, min: Math.round(dmg.min * resist * 3), max: Math.round(dmg.max * resist * 3), critMin: Math.round(dmg.critMin * resist * 3), critMax: Math.round(dmg.critMax * resist * 3) },
    traits, healthShare: simOpts.healthShare,
    notes: {
      preArmor: true,
      condition: w ? w.conditionPct : 1,
      softMaterial: false,
    },
  };
}

/** The game's reference foe (combat/combatStats.js referenceFoe). */
export function referenceFoe(level, preset = 'tough') {
  const def = typeof preset === 'string'
    ? { soft: { isClass: false, armorValue: 6 }, tough: { isClass: false, armorValue: 0 }, armoured: { isClass: false, armorValue: -10 }, human: { isClass: true, armorValue: null } }[preset]
    : preset;
  const isClass = !!def?.isClass;
  const armor = isClass ? 60 : (num(def?.armorValue, 0) * 5);
  return {
    isPlayer: false, isClass, level: num(level, 1), careerIndex: -1,
    stats: { strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50 },
    skills: Object.fromEntries(Array.from({ length: 35 }, (_, i) => [i, Math.min(100, num(level, 1) * 5 + 30)])),
    health: 100, maxHealth: 100,
    armorValues: new Array(7).fill(armor),
    career: null,
    group: def?.group ?? null,
    affinity: def?.affinity ?? null,
    healthShare: num(def?.healthShare, 1),
  };
}

/** A boss target: level, armour class, health, traits. */
export function bossTarget({ level = 30, armorValue = 0, isClass = false, health = 5000, traits = [], group = null, hitCap = 0, phaseShields = 0, shieldSeconds = 0 } = {}) {
  const t = referenceFoe(level, { isClass, armorValue });
  t.health = health;
  t.maxHealth = health;
  t.isBoss = true;
  t.bossTraits = [...traits];
  t.group = group;
  t.healthShare = 1;
  t.hitCap = hitCap;
  t.phaseShields = phaseShields;
  t.shieldSeconds = shieldSeconds;
  return t;
}

/** The real gate boss (Valkynaz Ruhn): a plate-armour monster, the solo pool for this level, the server hit cap and the two phase shields. */
export function gateTarget(level, { health = gateHealth(level), traits = [], hitCap = null, players = 1, blowX = 1 } = {}) {
  return bossTarget({
    level, armorValue: 12, health: health * Math.max(1, Math.floor(players)), traits, // 12 x5 = 60, the gate's flat plate armour
    group: 'daedra', // Valkynaz Ruhn is a Daedra Lord (gateBoss.js WBX7), not a humanoid
    hitCap: hitCap ?? Math.round(gateHitCap(level) * Math.max(1, num(blowX, 1))), phaseShields: GATE_SHIELDS, shieldSeconds: GATE_SHIELD_S,
  });
}

/** The marginal DPS of a +N change, against the same target. */
export function marginals(ch, baseline, scenario = {}) {
  const base = baseline.cappedDps ?? baseline.dps;
  const rows = [];
  const clone = () => JSON.parse(JSON.stringify(ch));
  const run = (label, fn) => {
    const c = clone();
    const s = { ...scenario };
    fn(c, s);
    const r = analyze(c, s);
    const dps = r.cappedDps ?? r.dps;
    rows.push({ label, dps, delta: dps - base, pct: base > 0 ? (dps / base - 1) * 100 : 0 });
  };
  const w = baseline.weapon;
  const skillId = w?.skillId ?? SKILLS.HandToHand;
  run('+10 Strength', (c) => { c.stats.strength += 10; });
  run('+10 Agility', (c) => { c.stats.agility += 10; });
  run('+10 Speed', (c) => { c.stats.speed += 10; });
  run('+10 Luck', (c) => { c.stats.luck += 10; });
  run('+10 weapon skill', (c) => { c.skills[skillId] = (c.skills[skillId] ?? 0) + 10; });
  run('+5 Critical Strike', (c) => { c.skills[SKILLS.CriticalStrike] = (c.skills[SKILLS.CriticalStrike] ?? 0) + 5; });
  run('+1 weapon damage', (c, s) => {
    const item = { ...(c.weapon ?? {}), __bonusDamage: 1 };
    c.weapon = item;
    s.weapon = undefined; // analyze reads ch.weapon
  });
  run('+5% attack speed', (c, s) => { s.attackSpeedPct = 5; });
  run('+10% damage affix', (c) => {
    if (c.weapon) c.weapon.affixes = [...(c.weapon.affixes ?? []), { id: 'damage', value: 10 }];
  });
  return rows;
}

/** Rank every melee template/material for this character and target. */
export function rankWeapons(ch, scenario = {}, { top = 20, materials = 10 } = {}) {
  const rows = [];
  for (const key of Object.keys(WEAPONS)) {
    const t = WEAPONS[key];
    if (t.ammo || t.ranged) continue; // melee ranking; ranged has its own card
    for (let m = 0; m < materials; m++) {
      const w = syntheticWeapon(Number(key), m, { rri: !!scenario.rri });
      if (!w) continue;
      const r = analyze(ch, { ...scenario, weapon: w });
      rows.push({
        templateIndex: Number(key), name: t.name, material: m, materialName: MATERIALS[m],
        skill: t.skill, twoHanded: t.twoHanded,
        dps: r.dps, dpsMin: r.dpsMin, dpsMax: r.dpsMax, cappedDps: r.cappedDps, cappedDpsMin: r.cappedDpsMin, cappedDpsMax: r.cappedDpsMax, perSwing: r.perSwing, perHit: r.perSwing / Math.max(1e-9, r.hit.hit), aps: r.cadence.aps,
        hit: r.hit.hit, crit: r.hit.crit.chance, damage: r.damage.avg, capLoss: r.capLoss,
      });
    }
  }
  rows.sort((a, b) => b.cappedDps - a.cappedDps || b.dps - a.dps);
  return rows.slice(0, top);
}


/** Affix / enchant what-ifs on the equipped weapon (or the selected one). */
export function rankAffixes(ch, baseline, scenario = {}) {
  const w = weaponOf(ch.weapon);
  if (!w) return [];
  const base = baseline.cappedDps ?? baseline.dps;
  const skillId = w.skillId;
  const rows = [];
  const run = (label, fn) => {
    const c = JSON.parse(JSON.stringify(ch));
    const s = { ...scenario };
    fn(c, s);
    const r = analyze(c, { ...s, weapon: undefined });
    const dps = r.cappedDps ?? r.dps;
    rows.push({ label, dps, delta: dps - base, pct: base > 0 ? (dps / base - 1) * 100 : 0 });
  };
  for (const v of [5, 10, 15]) {
    run(`+${v}% damage affix`, (c) => {
      c.weapon = { ...(c.weapon ?? {}), affixes: [...(c.weapon?.affixes ?? []), { id: 'damage', value: v }] };
    });
  }
  for (const v of [5, 10, 20]) {
    run(`+${v} weapon skill affix`, (c) => {
      c._mods = c._mods ?? { stats: {}, skills: {} };
      c._mods.skills = c._mods.skills ?? {};
      c._mods.skills[skillId] = (c._mods.skills[skillId] ?? 0) + v;
    });
  }
  for (const v of [5, 10]) {
    run(`+${v} Critical Strike affix`, (c) => {
      c._mods = c._mods ?? { stats: {}, skills: {} };
      c._mods.skills = c._mods.skills ?? {};
      c._mods.skills[SKILLS.CriticalStrike] = (c._mods.skills[SKILLS.CriticalStrike] ?? 0) + v;
    });
  }
  for (const v of [5, 10]) {
    run(`+${v} Strength affix`, (c) => {
      c._mods = c._mods ?? { stats: {}, skills: {} };
      c._mods.stats = c._mods.stats ?? {};
      c._mods.stats.strength = (c._mods.stats.strength ?? 0) + v;
    });
  }
  for (const v of [3, 6, 10]) {
    run(`+${v} elemental damage`, (c) => {
      c.weapon = { ...(c.weapon ?? {}), affixes: [...(c.weapon?.affixes ?? []), { id: 'elemental', param: 'fire', value: v }] };
    });
  }
  for (const v of [10, 20, 30]) {
    run(`+${v}% slayer`, (c, s) => {
      c.weapon = { ...(c.weapon ?? {}), affixes: [...(c.weapon?.affixes ?? []), { id: 'slayer', param: s.target?.group ?? 'undead', value: v }] };
    });
  }
  for (const v of [5, 10, 15]) {
    run(`+${v}% spell potency`, (c, s) => { s.potencyPct = (s.potencyPct ?? 0) + v; });
  }
  return rows;
}

/** The current weapon with its affixes, for the ranking's comparison row. */
export function currentWeaponRow(ch, scenario = {}) {
  const w = weaponOf(ch.weapon);
  if (!w) return null;
  const r = analyze(ch, { ...scenario, weapon: w });
  return {
    name: w.name, materialName: w.materialName, skill: w.skill, twoHanded: w.twoHanded,
    dps: r.dps, cappedDps: r.cappedDps, perSwing: r.perSwing, aps: r.cadence.aps,
    hit: r.hit.hit, crit: r.hit.crit.chance, damage: r.damage.avg, capLoss: r.capLoss,
    affixes: ch.weapon?.affixes ?? [],
  };
}

export { BOSS_TRAITS, MARTIAL_PATHS, SKILLS, SWINGS, WEAPONS, MATERIALS };
