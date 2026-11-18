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
  BOSS_TRAITS, CURB_SHARE, MARTIAL_PATHS, MATERIALS,
  RACES, SKILLS, SWINGS, SWING_HANDLING,
  SWING_BASE_FRAME, SWING_FRAME_MAX, SWING_FRAME_MIN, SWING_HEFT_FREE_KG,
  SWING_HEFT_MAX, SWING_HEFT_PER_KG, SWING_MODS, SWING_SHORT_BLADE,
  SWING_TEMPO_AT_0, SWING_TEMPO_AT_100, SWING_TWO_HANDED,
  WARD_SHARE, WEAPON_MATERIAL_MODIFIER, WEAPON_TYPES, WEAPONS, WRATH_AFTER_S,
  GATE_SHIELDS, GATE_SHIELD_S, gateHealth, gateHitCap, RRI_WEAPON_DAMAGE, RRI_SPEED_REDUCTION_FACTOR,
  BOW_DRAW_LOOSE_S, GUN_FPS, PISTOLET_FPS, PISTOLET_RELOAD_S, THUNDERLOCK_FRAMES, PISTOLET_FRAMES, thunderlockReloadSeconds,
} from './data.js';
import { allowanceSpec, claimStreams, runAllowance } from './allowance.js';
import { relayTraitsFor, resistBlow } from './bossTraits.js';
import { BOW_FAST, bowFastDamage } from '../vendor/upstream/a3eb1605/src/combat/bowBloom.js';
import { powerIdsOf, powerOf } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { mobileAffinityMatches, ENCHANTMENT_TYPES as UPSTREAM_ENCHANTMENTS, POTENT_VS_DAMAGE, LOW_DAMAGE_VS } from '../vendor/upstream/a3eb1605/src/systems/enchantments.js';
import { payloadRows } from './enchants.js';
import { foeGroup } from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';
import { conditionPercentage } from '../vendor/upstream/a3eb1605/src/systems/item/itemTemplates.js';
import { CLICK_ATTACK_DIRECTIONS } from '../vendor/upstream/a3eb1605/src/characters/weaponStates.js';
import { DIRECTION_TO_STRIKE } from '../vendor/upstream/a3eb1605/src/characters/anims.js';
import { OFF_HAND_BLOW, dualSchedule, offHandBurden, offHandDamage, offHandToHit } from './dualWield.js';
import { enchantDps, procsBeforeBreak, PROCS_BEFORE_BREAK_BASIS } from './enchants.js';
import { bladeLines, weaponDamagePct as itemWeaponDamagePct } from './gearLines.js';
import {
  bodyPartWeights, elementShare, enemyTypeBonusRange, enemyTypeBonusValues,
  hasWornEquipment, intrinsicDamage, isSkeletalTarget, leftHandShield, makeTarget,
  materialRequirementMultiplier, naturalDamageResistance, silverApplies, skeletalSilverDamage,
  standInTarget, targetExpectedDamage, targetGroupOf, targetPartOutcomes,
} from './target.js';
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

/** Unity's Mathf.Round: half to even (pcaao.js unityRound). */
export function unityRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * SWING DIRECTION (Stage 2.13). The game draws one direction per attack before the blow's own rolls:
 *
 *   WeaponManager.cs:343           Random.Range((int)UpRight, (int)DownRight + 1)
 *   characters/weaponStates.js:278 CLICK_ATTACK_DIRECTIONS - UpRight, Left, Right, DownLeft, Down, DownRight
 *   characters/anims.js:33         FPSWeapon.OnAttackDirection - UpRight -> StrikeUp, Left -> StrikeLeft, ...
 *   combat/playerWeapon.js:1032    _rollClickStrike: Math.floor(rolls() * 6), one draw an attack (clickAttack :1108,
 *                                  and the swing-mode gesture arm :992); the bow bypasses it (:1113, forced StrikeDown)
 *
 * Six equally likely strikes. `SWING_DIRECTIONS` is the upstream tables' own product, not a copy: the order is
 * MouseDirections' click window and the probability is 1/6 per entry.
 */
export const RANDOM_SWING = 'random';
export const SWING_DIRECTIONS = Object.freeze(CLICK_ATTACK_DIRECTIONS.map((d) => DIRECTION_TO_STRIKE[d]));

/** Mix the per-direction cards into one expectation over the draw: each weighted equally, the ranges are the
 *  mixture's support, and the parts report the distribution's mean swing modifier. */
function mixCards(cards) {
  if (cards.length === 1) return cards[0];
  const n = cards.length;
  const avgArr = (key) => (cards[0][key] ? cards[0][key].map((_, i) => cards.reduce((s, c) => s + c[key][i], 0) / n) : undefined);
  const parts = cards[0].parts
    ? { ...cards[0].parts, dmgMods: cards.reduce((s, c) => s + c.parts.dmgMods, 0) / n, swingDamage: cards.reduce((s, c) => s + c.parts.swingDamage, 0) / n }
    : cards[0].parts;
  return {
    ...cards[0],
    min: Math.min(...cards.map((c) => c.min)),
    max: Math.max(...cards.map((c) => c.max)),
    avg: cards.reduce((s, c) => s + c.avg, 0) / n,
    critMin: Math.min(...cards.map((c) => c.critMin)),
    critMax: Math.max(...cards.map((c) => c.critMax)),
    critAvg: cards.reduce((s, c) => s + c.critAvg, 0) / n,
    plainRolls: avgArr('plainRolls'),
    critRolls: avgArr('critRolls'),
    preFinishRolls: avgArr('preFinishRolls'),
    backstabPlainRolls: avgArr('backstabPlainRolls'),
    backstabCritRolls: avgArr('backstabCritRolls'),
    parts,
  };
}

/** The template and the live item as one weapon descriptor. */
export function weaponOf(item, { rri = false } = {}) {
  if (!item) return null;
  const t = WEAPONS[item.templateIndex];
  if (!t) return null;
  // The lines as the game reads them (src/gearLines.js: readLines' gem cap, validAffix, lootBlow's per-line reading).
  const blade = bladeLines(item);
  // The powers the piece carries (systems/loot/lootRarity.js:1271 powerIdsOf: a Legendary's own, a Rare's
  // imprint, a Gilded's), as the game's own records (powerOf) - one entry an id.
  const powers = [...new Set(powerIdsOf(item))].map((id) => (typeof id === 'string' ? powerOf(id) : null)).filter(Boolean);
  return {
    item,
    powers,
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
    flags: num(item.flags, 0),
    damagePct: itemWeaponDamagePct(item),
    slayer: blade.slayer,
    slayerByGroup: blade.slayerByGroup,
    elemental: blade.elemental,
    elementalLines: blade.elementalLines,
    // systems/item/itemTemplates.js:277-279: the integer the condition band reads.
    conditionPercent: conditionPercentage(item),
    conditionPct: conditionPercentage(item) / 100,
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
/** The stock/classic core's Strength term with the LIVE game's install: PCAAO registers
 *  `formulaOverride('damageModifier')` for `fixedStrengthDamageModifier` (default true), so the stock
 *  weapon/fist path reads `pcaaoDamageModifier`'s /10 too. `fixedStrengthDamageModifier:false` is the
 *  uninstalled DFU /5, kept for the golden stock fixture. The overhaul always uses /10 (and doubles it
 *  for a two-handed weapon or bow); this helper is only for the classic arm. */
function classicStrength(str, opts = {}) {
  return opts.fixedStrengthDamageModifier === false ? damageModifier(str) : pcaaoDamageModifier(str);
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

/** classic FormulaHelper.CalculateRacialModifiers (combat/formulas.js:292-306), including the
 *  else-if ladder: a Redguard ARCHER takes the archery arm, fails the Wood Elf test and gets
 *  NOTHING (the stock's own quirk); a Dark Elf takes the Dark Elf arm whatever the weapon. */
function classicRacial(ch, w, opts = {}) {
  if (!w) return { damage: 0, toHit: 0 };
  const level = ch.level;
  if (ch.raceId === RACES.DarkElf) return { damage: trunc(level / 4), toHit: trunc(level / 4) };
  if (w.skillId === SKILLS.Archery) {
    return ch.raceId === RACES.WoodElf
      ? { damage: trunc(level / 3), toHit: trunc(level / 3) }
      : { damage: 0, toHit: 0 };
  }
  if (ch.raceId === RACES.Redguard) return { damage: trunc(level / 3), toHit: trunc(level / 3) };
  return { damage: 0, toHit: 0 };
}

/** pcaao.js:281-361 pcaaoRacialModifiers, every arm of the switch and the two unarmed arms.
 *  A weapon reads its own skill; the fists read Khajiit/Nord only. `S` is the live stat the
 *  overhaul reads (the local stat helper also carries the path passives, as elsewhere). */
function overhaulRacial(ch, w, opts = {}) {
  const out = { damage: 0, toHit: 0 };
  const S = (k) => stat(ch, k, opts);
  if (!w) {
    if (ch.raceId === RACES.Khajiit) {
      out.damage = trunc(S('strength') / 33) + trunc(S('endurance') / 33) + trunc(S('agility') / 50) + trunc(S('speed') / 50);
      out.toHit = trunc(S('agility') / 25) + trunc(S('speed') / 50) + trunc(S('strength') / 50)
        + trunc(S('endurance') / 50) + trunc(S('luck') / 50);
    } else if (ch.raceId === RACES.Nord) {
      out.damage = trunc(S('strength') / 33) + trunc(S('endurance') / 50);
    }
    return out;
  }
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
      if (ws === SKILLS.ShortBlade) {
        out.damage = trunc(S('agility') / 33) + trunc(S('speed') / 50);
        out.toHit = trunc(S('agility') / 20) + trunc(S('speed') / 33) + trunc(S('luck') / 50);
      } else if (ws === SKILLS.Archery) {
        out.damage = trunc(S('strength') / 25) + trunc(S('agility') / 25);
        out.toHit = trunc(S('agility') / 10) + trunc(S('speed') / 25) + trunc(S('luck') / 25);
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
      } else if (ws === SKILLS.BluntWeapon) {
        out.damage = trunc(S('strength') / 33) + trunc(S('endurance') / 33);
        out.toHit = trunc(S('strength') / 20) + trunc(S('agility') / 25) + trunc(S('luck') / 33);
      } else if (ws === SKILLS.Axe) {
        out.damage = trunc(S('strength') / 16) + trunc(S('agility') / 33);
        out.toHit = trunc(S('strength') / 33) + trunc(S('agility') / 33) + trunc(S('luck') / 33);
      } else if (ws === SKILLS.Archery) {
        out.damage = trunc(S('strength') / 50) + trunc(S('agility') / 50);
        out.toHit = trunc(S('agility') / 25) + trunc(S('speed') / 33) + trunc(S('luck') / 33);
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

/** The racial damage/hit terms as a stage (the differential oracle compares these directly). */
export function racialModifiers(ch, w, core = 'overhaul', opts = {}) {
  return racial(ch, w, core, opts);
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
  //
  // The path's bonus is one more entry in `_mods.stats`, and upstream clamps AFTER summing every entry:
  // martialFold (systems/martialPowers.js:364-375) puts it in `_mods.stats`, and liveStat
  // (systems/statMods.js:121-141) returns min(max(base + mod, 0), 100 + statMax). So a base of 95 with
  // Light Step reads 100, not 105 - adding it to the already-clamped value (the pre-2.9 order) read 105.
  const bonus = passiveStat(ch, name, opts);
  if (!bonus) return Math.max(0, liveStat(ch, name));
  const mods = ch._mods ?? {};
  return Math.max(0, liveStat({ ...ch, _mods: { ...mods, stats: { ...mods.stats, [name]: (mods.stats?.[name] ?? 0) + bonus } } }, name));
}
/** The combat read of a stat (the path's passive included), for the differential tests. */
export const combatStat = (ch, name, opts = {}) => stat(ch, name, opts);
export function skill(ch, id, opts = {}) {
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
  if (path === 'berserker' && selfShare(opts) < N_FRENZY.below) return N_FRENZY.pace;
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
  const weight = w ? w.weight : 0;
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
      + (opts.offHand ? offHandToHit(stat(ch, 'agility', opts)) : 0);
  } else {
    base = skill(ch, w?.skillId ?? SKILLS.HandToHand, opts) + swing.toHit + prof.toHit + race.toHit;
    if (w) base += (WEAPON_MATERIAL_MODIFIER[w.material] ?? 0) * 10;
    other = adrenalineRushToHit(ch, target, core) + enchant
      + trunc((stat(ch, 'luck', opts) - stat(target, 'luck')) / 10)
      + trunc((stat(ch, 'agility', opts) - stat(target, 'agility')) / 10)
      - floor(targetDodge / 4)
      + (target.isPlayer ? 0 : (target.isClass ? -50 : -10));
  }
  const weights = bodyPartWeights(core);
  let plain = 0;
  let critHit = 0;
  let armourAvg = 0;
  const backstabBonus = num(opts.backstabBonus, 0);
  const partPlain = new Array(7).fill(0);
  const partCrit = new Array(7).fill(0);
  weights.forEach((weight, part) => {
    const armour = core === 'overhaul'
      ? (target.isClass ? 60 : (target.armorValues?.[part] ?? 0))
      : (target.armorValues?.[part] ?? 0);
    const hitPlainPart = clamp(base + armour + other + backstabBonus, 3, 97);
    const hitCritPart = clamp(base + armour + other + crit.hitBonus + backstabBonus, 3, 97);
    partPlain[part] = hitPlainPart / 100;
    partCrit[part] = hitCritPart / 100;
    armourAvg += weight * armour;
    plain += (weight * hitPlainPart) / 100;
    critHit += (weight * hitCritPart) / 100;
  });
  return {
    hit: (1 - crit.chance) * plain + crit.chance * critHit,
    hitPlain: plain,
    hitCrit: critHit,
    // The same chance per body part, for a target whose damage also resolves per part: the
    // struck part is rolled once, so hit chance and worn armour are correlated through it.
    byPart: { plain: partPlain, crit: partCrit },
    crit,
    terms: { base, armour: armourAvg, other, backstab: backstabBonus, dodge: core === 'overhaul' ? trunc(targetDodge / 2) : floor(targetDodge / 4) },
    prof,
    racial: race,
  };
}

const N_FRENZY = Object.freeze({ below: 0.5, pct: 20, pace: 10 }); // systems/martialPaths.js:71 N.frenzy
/**
 * The ATTACKER's share of its own health, 0..1 (`opts.attackerHealthShare`, default 1: the full health
 * the assumptions register M5 assumes). Berserker's Frenzy reads this, never the foe's: martialPowers.js:217
 * (`share(attacker) < N.frenzy.below`) and :276 (`share(e)`, the entity whose pace it is), where
 * combat/healthShare.js:36-48 `healthShare` is that body's `health / maxHealth`. `opts.healthShare` stays
 * the FOE's share (Axe, Blunt Weapon masteries read the struck foe: weaponMastery.js:16-18).
 */
const selfShare = (opts) => num(opts.attackerHealthShare, 1);

/** systems/martialPowers.js martialBlowPct. */
export function martialBlowPct(ch, target, opts = {}) {
  const path = ch.martialPath;
  if (!path || opts.passiveOn === false) return 0;
  switch (path) {
    case 'blademaster': return 3 * clamp(num(opts.stacks, 5), 0, 5);
    case 'warblade': return opts.rally ? 15 : 0;
    case 'ranger': return foeGroup(target) === 'animal' ? 20 : 0;
    case 'cutthroat': return opts.unaware ? 25 : 0;
    case 'assassin': return opts.firstBlow ? 30 : 0;
    case 'berserker': return selfShare(opts) < N_FRENZY.below ? N_FRENZY.pct : 0;
    case 'crusader': return (foeGroup(target) === 'undead' || foeGroup(target) === 'daedra') ? 20 : 0;
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

/**
 * The carried stream's long-run mean of a per-cent channel. `shareOf` floors each blow and keeps the remainder on
 * the item (systems/loot/lootPowers.js:176-181; the same shape in weaponMastery.js:148-150, martialPowers.js:232-235),
 * so floor(x_i + c) = x_i + c - c_next and sum f_i = sum x_i + c_0 - c_n: the mean is the EXACT share. The card's
 * own estimate path reads the carry but never writes it (info.estimate), so it keeps flooring via `applyPct`.
 */
const carriedPct = (damage, pct) => damage + (damage * pct) / 100;

/** The Firmament's own variant: whole = pct >= 0 ? floor : ceil and the remainder kept unclamped
 *  (systems/firmamentPowers.js:111-115), the blow never below 1 (:181). Its stream's mean is the exact share. */
const carriedFirmament = (damage, pct) => Math.max(1, damage + (damage * pct) / 100);

/** pcaao.js:607-637 pcaaoAlterDamageBasedOnWepCondition, on the INTEGER percentage
 *  (`conditionPercentage`, :277-279) - a float 5.9% belongs to the 5% band, not the >5%
 *  full-damage arm. `sharpEdge` is the mod's `equipmentDamageEnhanced`; the port defaults off. */
export function conditionMultiplier(w, sharpEdge = false) {
  if (!w) return 1;
  const pct = w.conditionPercent ?? Math.trunc(w.conditionPct * 100);
  const blunt = w.skillId === SKILLS.BluntWeapon;
  if (pct >= 76 && !sharpEdge) return 1; // no edge bonus without the wear module
  if (blunt) {
    if (pct >= 92) return 1.1;
    if (pct >= 76) return 1;
    if (pct >= 61) return 1;
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

/**
 * The blow's damage after the registered blow modifiers.
 *
 * Order follows the registries: mastery, then the loot step (its slayer percentage and then the
 * elemental flat, systems/loot/lootPowers.js:286-347), then the martial path and the Firmament's
 * blow channel. The elemental flat is added ONCE, at the loot step, exactly as `lootBlow` does;
 * upstream's registry order depends on which scene loaded first (the gate's dungeon host registers
 * mastery before loot), so mastery does not scale the flat and martial/Firmament do
 * (the assumptions register A11).
 */
export function weaponBlow(ch, w, damage, target, opts = {}) {
  let d = damage;
  const carried = opts.carried === true; // the carried metric's exact-share pass; the card (`applyPct`) is untouched
  const lines = w ?? opts.wraps ?? null;
  // STAGE 3.6c: A WARD turns every per-blow power, and only those. One gate here - the one place every card, fight-tier
  // and what-if blow passes - for the four channels upstream refuses on a `warded` foe: the loot's slayer/elemental/power
  // walk (`vendor:systems/loot/lootPowers.js:287`), weapon mastery (`vendor:systems/weaponMastery.js:141`), the martial
  // path's blow (`vendor:systems/martialPowers.js:136` `foeOf`) and the Firmament's (`vendor:systems/firmamentPowers.js:173`).
  // The Strikes payload (Potent Vs) is NOT one of them and is added later, by `afterShare` (`enchantments.js:623-631`).
  if (target?.warded === true) {
    // The card's own rolled damage line is not a blow power: it is inside the roll (`theory.js` turns it into a damage
    // affix), so it keeps its percentage.
    const own = num(opts.damagePct, 0);
    return own ? applyPct(damage, own) : damage;
  }
  const mastery = masteryPct(ch, w, target, opts);
  if (mastery > 0) d = carried ? carriedPct(d, mastery) : applyPct(d, mastery);
  // lootBlow (systems/loot/lootPowers.js:286-347) sums EVERY percentage - the weapon's slayer lines, and any
  // power (bane, unaware, flow, moon, ...) - into one `pct` and takes it of the blow ONCE (`shareOf`), then
  // adds the flat (elemental lines, venom). `opts.loot` is a power the weapon does not carry yet - a what-if
  // from the pricing code - entering exactly there, so it composes with the slayer line, the crit, the
  // condition, the armour and the cap as a real line would (Stage 2.9, F2).
  const what = opts.loot ?? null;
  const power = lootPowerTerms([...(lines?.powers ?? []), ...(opts.imprintsExtra ?? [])], target, opts);
  const slayer = (lines?.slayerByGroup?.[String(target?.group ?? '')] ?? 0) + num(what?.pct, 0) + power.pct;
  if (slayer > 0) d = carried ? carriedPct(d, slayer) : applyPct(d, slayer);
  const elementalLines = lines?.elementalLines ?? null;
  let elemental = 0;
  if (elementalLines && elementalLines.length) {
    // systems/loot/lootPowers.js:293: EACH valid line is floored after its own career tolerance, repeats included.
    for (const l of elementalLines) elemental += Math.floor(num(l.value) * elementShare(target, l.param));
  } else {
    elemental = Math.floor(num(lines?.elemental, 0)); // a hand-built weapon descriptor with only the total
  }
  elemental += num(what?.flat, 0) + power.flat; // venom's flat rides the same `flat` (lootPowers.js:346 `out + flat`)
  if (elemental > 0) d += elemental;
  const martial = martialBlowPct(ch, target, opts);
  if (martial > 0) d = carried ? carriedPct(d, martial) : applyPct(d, martial);
  const theory = num(opts.damagePct, 0);
  if (theory) d = applyPct(d, theory); // the card's OWN roll (lootRarity.js:2474-2478 trunc): never carried
  const firm = num(opts.firmamentDamagePct, 0);
  if (firm) d = carried ? carriedFirmament(d, firm) : applyPct(d, firm);
  // The long bow's pull is NOT part of the blow: bowFastDamage acts on the finished
  // calculateAttackDamage (combat/arrowFlight.js:501-510), after the crit, the material, the condition,
  // the armour and the off hand's share, and before the boss trait and the cap. See `bowBlow`.
  return d;
}

/**
 * What the weapon's powers add to lootBlow's `pct` and `flat` for THIS blow (systems/loot/lootPowers.js:286-347).
 * Each condition is read where the game reads it - the foe's career and affinity, the foe's or the wielder's
 * health share, the foe's group - from the target and the scenario; nothing is asked of the caller but the
 * scenario itself. `opts.assumeTriggers` is a PRICING assumption (what the power is worth once its trigger
 * holds), never a game state. Kinds that do not add to the blow (chain, quake, conduit, siphon, surge, echo - the
 * last is a separate stage) contribute nothing here.
 *   bane       :310-312  target.affinity !== 'Human' && foes.includes(target.careerIndex)
 *   unaware    :313-315  the foe had not noticed the wielder (scenario `unaware`)
 *   sanctified :316-318  foeGroup(target) === power.group
 *   flow       :319-321  pct x flow stacks (scenario `flowStacks`, default the power's `max`: the steady state)
 *   venom      :322-324  floor(flat x (foe under half its health ? 2 : 1) x elementShare(target, 'poison'))
 *   moon       :325-327  night (scenario `night`; the oracle's sky clock is a stub) - pct, + beast on an animal
 *   rage       :328-330  the WIELDER's health share below `below`%
 *   execute    :331-333  the FOE's health share below `below`%
 *   firstblood :334-336  the first blow on this foe (scenario `firstBlow`)
 */
export function lootPowerTerms(powers, target, opts = {}) {
  let pct = 0;
  let flat = 0;
  const all = opts.assumeTriggers === true;
  const foeShare = num(opts.healthShare, 1);
  const selfShare = num(opts.attackerHealthShare, 1);
  for (const p of powers ?? []) {
    switch (p?.kind) {
      case 'bane':
        if (all || (target?.affinity !== 'Human' && Array.isArray(p.foes) && p.foes.includes(target?.careerIndex))) pct += num(p.pct, 0);
        break;
      case 'unaware': if (all || opts.unaware) pct += num(p.pct, 0); break;
      case 'sanctified': if (all || (p.group != null && foeGroup(target) === p.group)) pct += num(p.pct, 0); break;
      case 'flow': pct += num(p.pct, 0) * num(opts.flowStacks, num(p.max, 1)); break;
      case 'venom': flat += floor(num(p.flat, 0) * (all || foeShare < 0.5 ? 2 : 1) * elementShare(target, 'poison')); break;
      case 'moon': if (all || opts.night) pct += num(p.pct, 0) + (all || foeGroup(target) === 'animal' ? num(p.beast, 0) : 0); break;
      case 'rage': if (all || selfShare < num(p.below, 0) / 100) pct += num(p.pct, 0); break;
      case 'execute': if (all || foeShare < num(p.below, 0) / 100) pct += num(p.pct, 0); break;
      case 'firstblood': if (all || opts.firstBlow) pct += num(p.pct, 0); break;
      default: break;
    }
  }
  return { pct, flat };
}

/**
 * The net of the weapon's Strikes damage rows against this foe (systems/enchantments.js:622-631 Potent Vs +5,
 * :886-892 Low Damage Vs -5; matched by the foe's AFFINITY, `mobileAffinityMatches`, never by a group): what
 * `doItemEnchantmentPayloads` adds to the blow (`damageOut += ...`, :1068).
 */
export function strikesNet(item, target) {
  if (target?.mobileType == null) return 0;
  let net = 0;
  for (const e of payloadRows(item)) {
    if (e.type === UPSTREAM_ENCHANTMENTS.PotentVs && mobileAffinityMatches(target.mobileType, e.param)) net += POTENT_VS_DAMAGE;
    else if (e.type === UPSTREAM_ENCHANTMENTS.LowDamageVs && mobileAffinityMatches(target.mobileType, e.param)) net += LOW_DAMAGE_VS;
  }
  return net;
}

/** The shaft's own multiplier as bowFastDamage reads it (combat/bowBloom.js:73-79): the bow kind's `pull`
 *  and the fast-shot stacks `fast` (0..BOW_FAST.most; `spam` holds the stacks at their most, x0.2). */
export function bowOf(w, opts = {}) {
  return w?.ranged && !w?.gun ? { pull: w.bowPull ?? 1, fast: opts.bowSpam ? BOW_FAST.most : 0 } : null;
}
/** bowFastDamage over a landed blow `d` (the vendored function itself). */
export const bowBlow = (d, bow) => (bow ? bowFastDamage(bow, d) : d);

/** pcaao.js:469-479 pcaaoBackstabDamage: a landed blow rolls once; above Backstabbing 1 a
 *  `dice100(chance)` succeeds for `floor(roll*100) < chance`, and the result is ×3. */
export function backstabDamage(damage, chance, roll01 = 0) {
  return chance > 1 && floor(roll01 * 100) < chance ? damage * 3 : damage;
}

/**
 * One card roll `d` landing on body part `part`, as the whole-number outcomes the game can produce
 * (`[{ p, v }]`), in pcaaoAttackDamage's order after the card: the shield's block roll and the worn piece
 * or hide (pcaao.js:1784-1849) -> the off hand's share (:1850) -> the boss trait (`bossStrike`, before the
 * cap) . The relay cap is the caller's. Nothing here averages across outcomes.
 */
export function resolveBlow(d, part, ctx = {}) {
  const { target, weapon = null, offHand = false } = ctx;
  return targetPartOutcomes(target, d, part, { weapon }).flatMap(({ p, damage }) => (
    afterShare(offHand ? offHandDamage(damage) : damage, p, ctx)
  ));
}

/**
 * What the host does to a defended, shared blow, as outcomes: Potent Vs' flat (formulas.js:830-840 `(attacker.isPlayer
 * || damage > 0) && whole`, payload enchantments.js:1068 `damageOut += 5`), a shaft's pull (arrowFlight.js:501-510),
 * the boss trait. The payload runs for a PLAYER whatever the blow did, so a swing that MISSED (`shared` 0) returns the
 * five too - upstream's own calculateAttackDamage answers 5 for every miss with the enchantment on (sampled in
 * test/pricing.test.js), and the hosts (combat/playerWeapon.js:1260-1277) take its answer as the blow. An off-hand blow
 * is `whole` only OFF_HAND_BLOW.blowWeight (0.8) of the time, so it is two outcomes. The relay cap is the caller's.
 *
 * Each outcome also carries `strikesDamage`/`strikesPositive`: the PRE-payload damage (`shared`), which is what the
 * Cast When Strikes guard reads. `formulaPositive` is the POST-Payload value Flow and Many Endings read.
 */
export function afterShare(shared, p, { weapon = null, offHand = false, traits = [], strikeKind = 'melee', bow = null, potentVs = 0, echoes = [], relay = false, warded = false } = {}) {
  const heard = potentVs ? (offHand ? OFF_HAND_BLOW.blowWeight : 1) : 0;
  const branches = heard > 0 && heard < 1
    ? [{ p: p * heard, damage: Math.max(0, shared + potentVs) }, { p: p * (1 - heard), damage: shared }]
    : [{ p, damage: heard >= 1 ? Math.max(0, shared + potentVs) : shared }]; // doItemEnchantmentPayloads clamps the sum at 0 (:1030-1033)
  const out = [];
  for (const { p: q, damage } of branches) {
    const shot = bowBlow(damage, bow); // the pull comes after the payloads, before the trait
    const v = shot > 0 && traits.length ? resistBlow(traits, shot, { kind: strikeKind, weapon }) : shot;
    // STAGE 3.6c: the strike listener refuses a warded foe (`vendor:systems/loot/lootPowers.js:354`), so the echo - the
    // only strike-listener answer the card carries (leech, chain and quake add no damage) - answers nothing. Potent Vs is
    // the Strikes payload, not a blow power, and survives (`enchantments.js:623-631`).
    if (!(damage > 0) || !echoes.length || warded) { out.push({ p: q, v, x: 0, echoMask: 0, echoHits: 0, echoEligible: false, formulaPositive: damage > 0, strikesDamage: shared, strikesPositive: shared > 0 }); continue; }
    // Many Endings (lootPowers.js:374-376, :444-454): the strike listener is told the blow's FINAL damage - the
    // formula's, so before the pull and the trait - and each power rolls `chance` per cent. A hit repeats it as
    // n = max(1, round(damage)): on a body the relay runs it is OWED (oweFoe) and taken into THIS blow's claim by the
    // host (dungeonContext.js:4528-4531 landOnBoss: `damage += bossStrikeAt(takeOwed(...), 'melee', weapon)`), resisted
    // on its own as a melee swing and added to the resisted blow - ONE claim, one cap on the sum; on an ordinary
    // foe it is its own hit on the foe's health (`door.hurtFoe`): no trait, no cap.
    const n = Math.max(1, Math.round(damage));
    for (let mask = 0; mask < (1 << echoes.length); mask++) {
      let pr = q;
      let k = 0;
      echoes.forEach((c, i) => { const hit = (mask >> i) & 1; pr *= hit ? c / 100 : 1 - c / 100; k += hit; });
      if (!(pr > 0)) continue;
      if (!k) { out.push({ p: pr, v, x: 0, echoMask: mask, echoHits: 0, echoEligible: true, formulaPositive: true, strikesDamage: shared, strikesPositive: shared > 0 }); continue; }
      const owed = k * n;
      if (relay) out.push({ p: pr, v: v + (traits.length ? resistBlow(traits, owed, { kind: 'melee', weapon }) : owed), x: 0, echoMask: mask, echoHits: k, echoEligible: true, formulaPositive: true, strikesDamage: shared, strikesPositive: shared > 0 });
      else out.push({ p: pr, v, x: owed, echoMask: mask, echoHits: k, echoEligible: true, formulaPositive: true, strikesDamage: shared, strikesPositive: shared > 0 });
    }
  }
  return out;
}

/**
 * The what-if powers `opts.imprints` adds to a piece that already carries `held`: one a power is not added twice
 * (upstream wornPowers counts a power once, lootPowers.js:247-253), so pricing the power a build has is no change.
 */
export const additionsTo = (held, imprints) =>
  (imprints ?? []).filter((p) => !held.some((q) => q === p || JSON.stringify(q) === JSON.stringify(p)));

/** Every power a blow carries: the wielded piece's own and the scenario's what-ifs (the same list the blow reads). */
export const weaponPowers = (w, opts = {}) => {
  const held = w?.powers ?? [];
  return [...held, ...additionsTo(held, opts.imprints)];
};

/** The Many Endings chances (per cent) among a weapon's powers - one roll each, unconditional (lootPowers.js:374). */
export const echoChances = (powers) => (powers ?? []).filter((p) => p?.kind === 'echo').map((p) => num(p.chance, 0)).filter((c) => c > 0);

/**
 * The distribution of the damage a landed, non-critical blow of the card's rolls does to one body part:
 * `Map(value -> probability)`, after the shield, the off hand's share, the boss traits and the per-hit cap.
 * The differential tests compare it value by value with upstream's sampled blows.
 */
export function blowDistribution(rolls, part, { target, weapon = null, offHand = false, traits = [], cap = 0, bowSpam = false, potentVs = 0, echoes = [] } = {}) {
  const strikeKind = weapon?.ranged ? 'arrow' : 'melee';
  const bow = bowOf(weapon, { bowSpam });
  const out = new Map();
  for (const d of rolls) {
    for (const { p, v, x } of resolveBlow(d, part, {
      target, weapon, offHand, traits, strikeKind, bow, potentVs, echoes, relay: !!target?.relayBody,
      warded: target?.warded === true, // STAGE 3.6c: the same ward flag `afterShare` gates the echo on
    })) {
      const value = (cap > 0 ? Math.min(v, cap) : v) + (x ?? 0);
      out.set(value, (out.get(value) ?? 0) + p / rolls.length);
    }
  }
  return out;
}

/** The damage half: combat/combatStats.js damageModel. */
export function damageModel(ch, w, target, swingKey, core, opts = {}) {
  const swing = SWING_MODS[swingKey] ?? { damage: 0, toHit: 0 };
  const prof = proficiency(ch, w, core, opts);
  const race = racial(ch, w, core, opts);
  const crit = critModel(ch, core, opts);
  const str = stat(ch, 'strength', opts);
  const matReq = num(opts.matReqMulti, 1);
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
    strMod = core === 'overhaul' ? pcaaoDamageModifier(str) : classicStrength(str, opts);
  } else {
    const lo = w.min;
    const hi = w.max;
    rolls = [];
    for (let r = lo; r <= hi; r++) {
      const rolled = w.damagePct ? trunc(r * (1 + w.damagePct / 100)) : r;
      rolls.push(rolled + w.bonusDamage);
    }
    matMod = WEAPON_MATERIAL_MODIFIER[w.material] ?? 0;
    strMod = core === 'overhaul' ? pcaaoDamageModifier(str) * (w.twoHanded ? 2 : 1) : classicStrength(str, opts);
  }
  const one = (roll) => {
    // pcaao.js:555-590: silver/skeletal act on the weapon roll plus the swing/proficiency/racial
    // modifiers, BEFORE Strength and the material modifier. The enemy-type bonus (:511-522) is a
    // flat integer added after Strength/material and the floor, and BEFORE the blow modifiers.
    let base = roll + dmgMods;
    if (core === 'overhaul') base = skeletalSilverDamage(base, target, w);
    base += strMod + matMod;
    // The stock WEAPON arm clamps below 1; the stock FIST arm does not (a STR-0 punch can be
    // negative on the card). The overhaul clamps both at the same point.
    if (base < 1 && (core === 'overhaul' || !!w)) base = 0;
    const bonuses = core === 'overhaul' ? enemyTypeBonusValues(ch, target) : [0];
    return bonuses.map((bonus) => {
      let d = base >= 1 ? base + bonus : base;
      if (d > 0) d = weaponBlow(ch, w, d, target, opts); // the elemental flat is added there, once
      return d;
    });
  };
  const finish = (d, critical) => {
    if (core !== 'overhaul') return d;
    d = Math.max(0, d);
    // The carried metric passes the stream's MEAN: unityRound on each integer blow is unbiased over the stream, so
    // its mean is the plain product - rounding the mean again would quantise the carry away.
    const round = opts.carried === true ? (v) => v : unityRound;
    if (critical && crit.damageMult !== 1) d = round(fround(d * crit.damageMult));
    // pcaao.js:1745-1755: the soft/hard material requirement is applied after the critical
    // multiplier and before the weapon-condition band.
    if (matReq !== 1) d = round(fround(d * fround(matReq)));
    if (d >= 1 && w) {
      const mult = conditionMultiplier(w, opts.equipmentDamageEnhanced === true);
      if (mult !== 1) d = round(fround(d * mult));
    }
    return d;
  };
  const values = [];
  for (const r of rolls) for (const d of one(r)) values.push(d);
  const plain = values.map((d) => finish(d, false));
  const crits = values.map((d) => finish(d, true));
  // pcaao.js:471-479, 1724/1768: a landed blow rolls once for the ×3 and the triple is taken
  // BEFORE the critical multiplier, the material requirement and the condition band.
  const backstabPlain = values.map((d) => finish(d * 3, false));
  const backstabCrits = values.map((d) => finish(d * 3, true));
  return {
    min: Math.min(...plain), max: Math.max(...plain), avg: mean(plain),
    critMin: Math.min(...crits), critMax: Math.max(...crits), critAvg: mean(crits),
    // The integer blows themselves, so a later stage (a boss's resistance, a per-hit cap) can be
    // applied to each one instead of to the mean.
    plainRolls: plain, critRolls: crits,
    // The blow before the critical/material/condition band, for an exact stage comparison.
    preFinishRolls: values,
    backstabPlainRolls: backstabPlain, backstabCritRolls: backstabCrits,
    parts: {
      roll: [Math.min(...rolls), Math.max(...rolls)],
      matMod, strMod, prof: prof.damage, racial: race.damage, twoHanded: !!w?.twoHanded,
      dmgMods, swingDamage: swing.damage,
      enemyType: core === 'overhaul'
        ? enemyTypeBonusRange(ch, target)
        : { group: null, decoded: 0, bonus: 0, penalty: 0, will: 0, targetLevel: target?.combatLevel ?? target?.level ?? 1 },
      silver: {
        material: w?.material ?? null,
        careerIndex: target?.careerIndex ?? null,
        skeletal: isSkeletalTarget(target),
        doubled: core === 'overhaul' && silverApplies(target, w),
      },
      matReq,
      mastery: masteryPct(ch, w, target, opts), martial: martialBlowPct(ch, target, opts), slayer: w?.slayer ?? 0,
    },
    crit,
  };
}

/**
 * The encounter's verdict on a build, for a target that declares a relay
 * allowance (gateTarget / encounterTarget): the claims it offers run through
 * the relay's law over time (allowance.js). Returns null for any other target,
 * so ordinary foes and curbing bosses are untouched.
 *
 *   ttk       the weapon's blows alone; totalTtk adds Cast When Strikes procs and
 *             their damage-over-time rounds, each its own claim.
 *   ttkCapOnly / totalTtkCapOnly (set by the caller) keep the old ceiling figure -
 *             health / per-hit-capped DPS, which ignores the allowance.
 */
function allowancePatch(tgt, health, { cappedPerSwing, hit, aps, procs, cap, streamsOf = null }) {
  const spec = tgt?.allowance;
  if (!spec || !(health > 0)) return null;
  const share = health / spec.players;
  // One lane's claims and the run they feed. `streams` is kept on the result so a reader (a test, a report) can see
  // exactly what the allowance was offered - the list is pure for pure inputs.
  const lane = (withProcs) => {
    const streams = streamsOf ? streamsOf(withProcs) : claimStreams({ cappedPerSwing, hit, aps, procs, cap, withProcs });
    return { streams, run: runAllowance({ level: spec.level, share, spec, streams }) };
  };
  const weaponLane = lane(false);
  if (!weaponLane.run) return null;
  const hasProcs = streamsOf ? true : procs?.some((p) => (p?.damage ?? 0) > 0 || (p?.dotTick ?? 0) > 0);
  const totalLane = hasProcs ? lane(true) : weaponLane;
  return {
    allowance: {
      ...totalLane.run,
      streams: totalLane.streams,
      weaponOnly: {
        ttk: weaponLane.run.ttk, sustainedDps: weaponLane.run.sustainedDps, ceilingDps: weaponLane.run.ceilingDps,
        burst5Dps: weaponLane.run.burst5Dps, averageDps: weaponLane.run.averageDps,
      },
    },
    ttk: weaponLane.run.ttk,
    totalTtk: totalLane.run.ttk,
  };
}

/**
 * The full card for one weapon and one target.
 *
 * Every result carries `with(edit)`: the SAME card re-run on the same inputs with one hypothetical change,
 * which is how pricing (src/imprints.js, src/enchantPlan.js) evaluates an imprint or an enchant. There is no
 * second damage calculation: the change enters the one blow at its upstream position.
 *   edit.loot     { pct, flat }  a loot power the weapon does not carry (lootBlow: the slayer-style
 *                                percentage and the flat, before the martial path, the crit, the defence)
 *   edit.imprint  power record   a Legendary/Rare power the main-hand item does not carry (the same record
 *                                `powerOf` gives an equipped item): its conditions read from the target and the
 *                                scenario, `assumeTriggers: true` pricing it as if they held
 *   edit.potentVs n              Potent Vs' flat on a blow (formulas.js tail, after the defence and
 *                                the off hand's share, before the pull, the trait and the cap)
 * An item that CARRIES the power or the enchantment (`rarity`+`imprint`/`legendary`, `enchantments`) is read by the
 * same code: equipped evaluation and `with(edit)` are one path (Stage 2.11a).
 * or any other analyze option. In a dual build the edit rides the main-hand item; a pair is one item.
 *
 * The card's perSwing/dps/cappedDps floor each percentage line, which is upstream's own estimate path
 * (info.estimate reads the carry and never writes it). A HELD item carries the fraction between blows, and the
 * stream's long-run mean is the exact share, so the same pipeline is run once more with `carried: true`
 * (src/model.js `carriedPct`) and exposed as `carriedPerSwing` / `carriedCappedPerSwing` / `carriedDps` /
 * `carriedCappedDps` - the metric pricing deltas use. The fight streams still floor (W-LOOT-CARRY).
 */
export function analyze(ch, args = {}) {
  const r = analyzeCard(ch, args);
  const carried = analyzeCard(ch, { ...args, carried: true });
  r.carriedPerSwing = carried.perSwing;
  r.carriedCappedPerSwing = carried.cappedPerSwing;
  r.carriedDps = carried.dps;
  r.carriedCappedDps = carried.cappedDps;
  Object.defineProperty(r, 'with', {
    value: (edit = {}) => {
      const { imprint, ...rest } = edit;
      // `imprint` is a power record (systems/loot/lootRarity.js powerOf) the main-hand item does not carry yet
      return analyze(ch, { ...args, ...rest, ...(imprint ? { imprints: [...(args.imprints ?? []), imprint] } : {}) });
    },
    enumerable: false,
  });
  return r;
}

function analyzeCard(ch, {
  weapon, target, core = 'overhaul', swing = RANDOM_SWING, critDamage = true,
  traits = null, health = null, passiveOn = true, ...opts
} = {}) {
  let w = weapon === undefined ? weaponOf(ch.weapon, { rri: !!opts.rri }) : weapon;
  if (w && opts.rri) {
    const rr = RRI_WEAPON_DAMAGE[w.templateIndex];
    if (rr) w = { ...w, min: rr.min, max: rr.max };
  }
  const t = target ?? { ...referenceFoe(ch.level, 'tough') };
  const tgt = { ...t, group: t.group ?? null, affinity: t.affinity ?? null };
  // A relay boss carries its traits on the entity (systems/bossTraits.js bossStrike reads
  // `entity.bossTraits`); an explicit `traits` argument is an override for trait experiments.
  const traitList = traits ?? t.bossTraits ?? [];
  const wraps = !w && ch.wraps ? weaponOf(ch.wraps, { rri: !!opts.rri }) : null;
  // The draw is a melee attack's. A bow's release is forced to StrikeDown (playerWeapon.js:1113); a gun's shot has
  // no swing state at all (its machine's state is Idle, so playerAttackOptions reads no modifier), which is the
  // neutral entry. An explicit `swing` key is untouched, so a caller can still pin one direction.
  const swingKeys = swing === RANDOM_SWING
    ? (w?.ranged ? (w.gun ? ['StrikeLeft'] : ['StrikeDown']) : SWING_DIRECTIONS)
    : [swing];
  const swingChance = 1 / swingKeys.length;
  if (opts.dual && ch.offWeapon && !w?.twoHanded && !w?.gun && !WEAPONS[ch.offWeapon.templateIndex]?.twoHanded) {
    const offWeapon = weaponOf(ch.offWeapon, { rri: !!opts.rri });
    const base = { ...opts, dual: false, target: t, traits: traitList, health, core, swing, critDamage };
    const main = analyzeCard(ch, { ...base, weapon: w, offHand: false });
    // the what-if (a loot power, Potent Vs) is an item the MAIN hand carries; the off-hand weapon is its own item
    const off = analyzeCard({ ...ch, weapon: ch.offWeapon }, { ...base, weapon: offWeapon, offHand: true, loot: null, imprints: null, potentVs: 0 });

    // THE EXCHANGE (dualWield.js, handsLaw.js): lead, off, lead, off - four ticks a blow once the flurry is
    // running, plus the off hand's burden held in whole ticks at its blows' end. One weapon alone is five
    // ticks a blow, so a pair makes 2 blows per (8 + burden) ticks, not two blows per five.
    const strength = stat(ch, 'strength', opts);
    const burden = offHandBurden(offWeapon.weight, strength);
    const schedule = dualSchedule({ mainTick: main.cadence.tick, offTick: off.cadence.tick, burden });
    const aps = schedule.swingsPerSecond;
    const perSwing = (main.perSwing + off.perSwing) / 2;
    const perSwingMin = (main.perSwingMin + off.perSwingMin) / 2;
    const perSwingMax = (main.perSwingMax + off.perSwingMax) / 2;
    const cappedPerSwing = (main.cappedPerSwing + off.cappedPerSwing) / 2;
    const cappedPerSwingMin = (main.cappedPerSwingMin + off.cappedPerSwingMin) / 2;
    const cappedPerSwingMax = (main.cappedPerSwingMax + off.cappedPerSwingMax) / 2;
    const dps = perSwing * aps;
    const dpsMin = perSwingMin * aps;
    const dpsMax = perSwingMax * aps;
    const cappedDps = cappedPerSwing * aps;
    const cappedDpsMin = cappedPerSwingMin * aps;
    const cappedDpsMax = cappedPerSwingMax * aps;

    // A blow's own procs fire from that hand's weapon. The off hand's payloads ride a blow of
    // OFF_HAND_BLOW.blowWeight (0.8) of a blow (playerWeapon.js:1257, formulas.js:830), so its expected
    // proc damage is 0.8 of a landed blow's; a DoT round is priced the same way.
    const offWeight = OFF_HAND_BLOW.blowWeight;
    const enchOf = (r) => ({ perBlow: r.enchantPerSwing, dot: r.enchantDps - r.enchantPerSwing * r.cadence.aps });
    const em = enchOf(main), eo = enchOf(off);
    // STAGE 3.7: a body carries ONE like-kind Continuous Damage entry - any ContinuousDamageHealth is the incumbent, a
    // re-cast renews it and keeps its own magnitude (vendor:systems/effects.js:1091-1103) - so the pair claims ONE DoT
    // round, from the hand that holds it: the main's when it has one (the main opens the exchange), else the off's. A
    // round is not an off-hand blow, so the off hand's 0.8 share does not scale it.
    const dotHost = em.dot > 0 ? main : (eo.dot > 0 ? off : null);
    const mergedDot = dotHost === null ? 0 : (dotHost === main ? em.dot : eo.dot);
    const enchantPerSwing = (em.perBlow + eo.perBlow * offWeight) / 2;
    const enchantDpsValue = (em.perBlow + eo.perBlow * offWeight) * (aps / 2) + mergedDot;
    // The min/max band prices the SAME merged entry's round (one home with the central value), so the band brackets it;
    // the per-blow terms keep their per-hand halving and off-hand share.
    const mergedDotMin = dotHost === null ? 0 : (dotHost === main ? main.enchantDotDpsMin : off.enchantDotDpsMin);
    const mergedDotMax = dotHost === null ? 0 : (dotHost === main ? main.enchantDotDpsMax : off.enchantDotDpsMax);
    const enchantDpsMin = (((main.enchantDpsMin - main.enchantDotDpsMin) / main.cadence.aps)
      + ((off.enchantDpsMin - off.enchantDotDpsMin) / off.cadence.aps) * offWeight) * (aps / 2) + mergedDotMin;
    const enchantDpsMax = (((main.enchantDpsMax - main.enchantDotDpsMax) / main.cadence.aps)
      + ((off.enchantDpsMax - off.enchantDotDpsMax) / off.cadence.aps) * offWeight) * (aps / 2) + mergedDotMax;
    const totalDps = cappedDps + enchantDpsValue;
    const totalDpsMin = cappedDpsMin + enchantDpsMin;
    const totalDpsMax = cappedDpsMax + enchantDpsMax;
    const bossHealth = main.health ?? 0;
    const ttk = bossHealth > 0 && cappedDps > 0 ? (bossHealth + main.ward) / cappedDps + main.shields : null;
    const totalTtk = bossHealth > 0 && (cappedDps + enchantDpsValue) > 0 ? (bossHealth + main.ward) / (cappedDps + enchantDpsValue) + main.shields : null;

    // C1: two claims a period, one from each hand, each with its own capped blow and its own hit chance.
    const streamsOf = (withProcs) => {
      const out = [];
      // The main hand opens the exchange (its first claim at its own swing), the off hand answers one lead
      // blow later; claimStreams() already waits one hit-adjusted interval before the first blow.
      for (const [hand, start, weight] of [[main, 0, 1], [off, schedule.mainSeconds, offWeight]]) {
        const procs = withProcs
          ? (hand.enchantProcs ?? []).map((p) => ({
            ...p,
            damage: (p.damage ?? 0) * weight,
            dotTick: hand === dotHost ? (p.dotTick ?? 0) : 0, // one merged DoT entry for the pair
          }))
          : [];
        for (const st of claimStreams({ cappedPerSwing: hand.cappedPerSwing, hit: hand.hit.hit, aps: aps / 2, procs, cap: hand.cap })) {
          out.push({ ...st, start: (st.start ?? 0) + start });
        }
      }
      return out;
    };
    const gate = allowancePatch(main.target, bossHealth, { cappedPerSwing, hit: main.hit.hit, aps, procs: main.enchantProcs, cap: main.cap, streamsOf });
    return {
      ...main, dual: true, offHand: off, schedule,
      perSwing, perSwingMin, perSwingMax, cappedPerSwing, cappedPerSwingMin, cappedPerSwingMax, dps, dpsMin, dpsMax, cappedDps, cappedDpsMin, cappedDpsMax,
      enchantPerSwing, enchantDps: enchantDpsValue, enchantDpsMin, enchantDpsMax,
      totalDps, totalDpsMin, totalDpsMax, ttk: gate?.ttk ?? ttk, totalTtk: gate?.totalTtk ?? totalTtk, ttkCapOnly: ttk, totalTtkCapOnly: totalTtk, allowance: gate?.allowance ?? null, capLoss: dps > 0 ? 1 - cappedDps / dps : 0,
      cadence: { ...main.cadence, seconds: schedule.period / 2, aps, dual: true, period: schedule.period, mainSeconds: schedule.mainSeconds, offSeconds: schedule.offSeconds },
    };
  }
  if (opts.pair && w?.templateIndex === 562) {
    const base = { ...opts, core, target: t, traits: traitList, health, swing, critDamage, weapon: w };
    const main = analyzeCard(ch, { ...base, pair: false, offHand: false });
    const off = analyzeCard(ch, { ...base, pair: false, offHand: true });
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
    // STAGE 3.7: the pair claims ONE merged DoT round, like the melee pair (M37) - the central figure used to drop the
    // dot entirely while the band added BOTH single-hand rounds. One host, one home, both figures.
    const dotHost = main.enchantDotDps > 0 ? main : (off.enchantDotDps > 0 ? off : null);
    const mergedDot = dotHost === null ? 0 : (dotHost === main ? main.enchantDotDps : off.enchantDotDps);
    const mergedDotMin = dotHost === null ? 0 : (dotHost === main ? main.enchantDotDpsMin : off.enchantDotDpsMin);
    const mergedDotMax = dotHost === null ? 0 : (dotHost === main ? main.enchantDotDpsMax : off.enchantDotDpsMax);
    const enchantDpsValue = enchantPerSwing * aps + mergedDot;
    const enchantDpsMin = ((main.enchantDpsMin - main.enchantDotDpsMin + off.enchantDpsMin - off.enchantDotDpsMin) / 2) * 2 + mergedDotMin;
    const enchantDpsMax = ((main.enchantDpsMax - main.enchantDotDpsMax + off.enchantDpsMax - off.enchantDotDpsMax) / 2) * 2 + mergedDotMax;
    const totalDps = cappedDps + enchantDpsValue;
    const totalDpsMin = cappedDpsMin + enchantDpsMin;
    const totalDpsMax = cappedDpsMax + enchantDpsMax;
    const bossHealth = main.health ?? 0;
    const ttk = bossHealth > 0 && cappedDps > 0 ? (bossHealth + main.ward) / cappedDps + main.shields : null;
    const totalTtk = bossHealth > 0 && (cappedDps + enchantDpsValue) > 0 ? (bossHealth + main.ward) / (cappedDps + enchantDpsValue) + main.shields : null;
    const gate = allowancePatch(main.target, bossHealth, { cappedPerSwing, hit: main.hit.hit, aps, procs: main.enchantProcs, cap: main.cap });
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
      totalTtk: gate?.totalTtk ?? totalTtk,
      cadence: { ...main.cadence, seconds: main.cadence.seconds / 2, aps, pair: true },
      ttk: gate?.ttk ?? ttk,
      ttkCapOnly: ttk, totalTtkCapOnly: totalTtk, allowance: gate?.allowance ?? null,
      capLoss: dps > 0 ? 1 - cappedDps / dps : 0,
    };
  }
  // pcaao.js:1640-1700: the material requirement is a damage multiplier inside the weapon blow,
  // after the critical and before the condition band. `softMaterialRequirements` is upstream's
  // default true; false is its whole-blow refusal.
  const matReqMulti = materialRequirementMultiplier(tgt, w, { soft: opts.softMaterialRequirements !== false });
  // A power the wielded item already carries is not added a second time: upstream's wornPowers counts a power once
  // (lootPowers.js:247-253, by its id), so pricing the power a build already has is no change. The additions ride the
  // loot step (`imprintsExtra`), the same list the Echo's chances are read from.
  const heldPowers = (w ?? wraps)?.powers ?? [];
  const powerAdditions = additionsTo(heldPowers, opts.imprints);
  const simOpts = { ...opts, passiveOn, critDamage, healthShare: opts.healthShare ?? t.healthShare ?? 1, firmamentDamagePct: opts.firmamentDamagePct ?? ch.firmamentDamagePct ?? 0, wraps, matReqMulti, imprintsExtra: powerAdditions };
  // One hit and one damage model per direction of the draw; every later stage (share, defence, traits, cap,
  // echoes) resolves each direction through the same pipeline and the expectation is the equal mixture. No new
  // random draw is introduced: the direction is enumerated, never sampled.
  const shaft = bowOf(w, opts);
  const hits = swingKeys.map((key) => hitModel(ch, w, tgt, key, core, simOpts));
  const dmgs = swingKeys.map((key) => damageModel(ch, w, tgt, key, core, simOpts));
  const dmgMix = mixCards(dmgs);
  const cardOf = (dmg) => {
    // The off hand's share is applied after the target's intrinsic defenses in the hit path; keep the
    // returned `damage` card in the hand's post-share terms for display/API compatibility.
    const cardDmg = opts.offHand
      ? (() => {
          const plain = dmg.plainRolls.map((d) => offHandDamage(d));
          const crits = dmg.critRolls.map((d) => offHandDamage(d));
          return {
            ...dmg,
            min: Math.min(...plain), max: Math.max(...plain), avg: mean(plain),
            critMin: Math.min(...crits), critMax: Math.max(...crits), critAvg: mean(crits),
            plainRolls: plain, critRolls: crits,
          };
        })()
      : dmg;
    // A shaft's displayed card is the pulled blow (bowFastDamage); the rolls stay the card's own, since the hit
    // path applies the pull after the defence.
    return shaft
      ? (() => {
          const plain = cardDmg.plainRolls.map((d) => bowBlow(d, shaft));
          const crits = cardDmg.critRolls.map((d) => bowBlow(d, shaft));
          return {
            ...cardDmg,
            min: Math.min(...plain), max: Math.max(...plain), avg: mean(plain),
            critMin: Math.min(...crits), critMax: Math.max(...crits), critAvg: mean(crits),
            bow: shaft,
          };
        })()
      : cardDmg;
  };
  const displayDmg = mixCards(dmgs.map(cardOf));
  // pcaao.js:1706-1724 / 1764-1768: the host's backstab chance is the live Backstabbing skill when
  // the foe's back was to the player (and the foe is no Watchful revenant); it is added FLAT to the
  // to-hit roll, and a landed blow rolls once for the ×3 (only above skill 1). `backstabUptime` is
  // the share of swings the foe's back is to the player; a caller can hand the raw chance directly.
  const backOverride = opts.backstabChance;
  const watchful = tgt?.watchful === true || tgt?.revenant?.edge?.watchful === true;
  const backSkill = watchful ? 0 : (backOverride != null ? num(backOverride, 0) : skill(ch, 19, simOpts));
  const backUptime = clamp(num(opts.backstabUptime, 0), 0, 1);
  const backProb = backSkill > 1 ? clamp(backSkill, 0, 100) / 100 : 0;
  const behind = backUptime > 0 && backSkill !== 0;
  const hitsBehind = swingKeys.map((key, i) => (behind
    ? hitModel(ch, w, tgt, key, core, { ...simOpts, backstabBonus: backSkill })
    : hits[i]));
  const cad = w?.ranged ? rangedCadence(ch, w, simOpts) : cadence(ch, w, simOpts);

  const resist = weaponResistFactor(w, traitList);
  const bossHealth = num(health, 0);
  const curbCap = traitList.includes('curbing') && bossHealth > 0
    ? Math.max(1, Math.round(bossHealth * CURB_SHARE)) : 0;
  const hardCap = num(t.hitCap, 0);
  const caps = [curbCap, hardCap].filter((n) => n > 0);
  const cap = caps.length ? Math.min(...caps) : 0;
  const capSource = cap === 0 ? null : (hardCap > 0 && (!curbCap || hardCap <= curbCap) ? 'hit cap' : 'curbing');

  // pcaao.js:1815-1843: the target's defence resolves AFTER the weapon's condition and BEFORE
  // the host's boss traits, per-hit cap and relay allowance. A struck body part is rolled per
  // blow, so with worn gear each part's outcome is its own; the 20-entry distribution is kept
  // through the target's layer, the boss's traits and the cap.
  const geared = core === 'overhaul' && hasWornEquipment(tgt);
  const weights = bodyPartWeights(core);
  const defended = (d) => (geared
    ? targetExpectedDamage(tgt, d, { weapon: w })
    : intrinsicDamage(tgt, d, { weapon: w, exact: opts.carried === true }));
  const targetDefense = {
    careerIndex: tgt.careerIndex ?? -1,
    mobileType: tgt.mobileType ?? null,
    natural: naturalDamageResistance(tgt),
    material: matReqMulti,
    hideAt100: !tgt.isClass ? intrinsicDamage(tgt, 100, { weapon: w }) : 100,
    wornArmour: geared,
    shield: leftHandShield(tgt)?.templateIndex ?? null,
    combatLevel: tgt.combatLevel ?? tgt.level ?? 1,
  };

  // A boss's traits resolve the blow BEFORE the per-hit cap and the relay's allowance
  // (dungeonContext.js:4544 bossStrikeAt -> landOnBoss -> gateBrain.js applyHit), one blow at a time:
  // `Math.max(1, Math.round(d))` for a resisted blow, unchanged otherwise.
  const strikeKind = w?.ranged ? 'arrow' : 'melee';
  const struck = (d) => (d > 0 && traitList.length ? resistBlow(traitList, d, { kind: strikeKind, weapon: w }) : d);
  const capped = (v) => (cap > 0 ? Math.min(v, cap) : v);
  const hand = (d) => (opts.offHand ? offHandDamage(d) : d);
  const bow = bowOf(w, opts);
  // The Strikes damage rows the wielded item carries (equipped Potent Vs / Low Damage Vs) and any what-if
  // (`opts.potentVs`) are ONE channel of the blow, applied where the game applies them.
  const strikes = num(opts.potentVs, 0) + strikesNet((w ?? wraps)?.item ?? null, tgt);
  // Many Endings (and any other echo power the wielded item carries or a what-if puts on it): a chance per power
  const echoes = echoChances([...heldPowers, ...powerAdditions]);
  // What one outcome adds to the swing: `landed` uncapped, `claimed` with the relay's per-hit cap on the CLAIM
  // (v: the blow and, on a relay body, its owed echo together); `x` is an ordinary foe's independent echo hit.
  const landed = (o) => o.v + (o.x ?? 0);
  const claimed = (o) => capped(o.v) + (o.x ?? 0);
  const computeBranch = (h, plainRolls, critRolls) => {
    if (geared) {
      // Per part, every card roll resolves into the whole-number outcomes the game can produce
      // (the shield's block or its miss), each already through the off hand's share and the boss
      // trait; the cap and the means are taken over those outcomes (Stage 2.9, F1).
      const parts = [];
      const ctx = { target: tgt, weapon: w, offHand: !!opts.offHand, traits: traitList, strikeKind, bow: bowOf(w, opts), potentVs: strikes, echoes, relay: !!tgt.relayBody, warded: tgt.warded === true };
      for (let part = 0; part < 7; part++) {
        const weight = weights[part] ?? 0;
        if (!weight) continue;
        parts.push({
          part,
          weight,
          plain: plainRolls.map((d) => resolveBlow(d, part, ctx)),
          crit: critRolls.map((d) => resolveBlow(d, part, ctx)),
        });
      }
      // `fn` reduces one roll's outcome list to a number; `across` combines the rolls.
      const meanOf = (outs, f) => outs.reduce((sum, o) => sum + o.p * f(o), 0);
      const agg = (across, one) => parts.reduce(
        (sum, p) => sum + p.weight * ((1 - h.crit.chance) * h.byPart.plain[p.part] * across(p.plain.map((o) => one(o)))
          + h.crit.chance * h.byPart.crit[p.part] * across(p.crit.map((o) => one(o)))),
        0,
      );
      // A swing that missed returns 0 - or Potent Vs' five (afterShare) - so with that enchantment a miss is an
      // outcome too, weighted by the part's chance to miss.
      const missOuts = ctx.potentVs ? afterShare(0, 1, ctx) : null;
      const missOf = (f, reduce) => (missOuts ? parts.reduce(
        (sum, p) => sum + p.weight * (1 - ((1 - h.crit.chance) * h.byPart.plain[p.part] + h.crit.chance * h.byPart.crit[p.part])) * reduce(missOuts, f),
        0,
      ) : 0);
      const sumOver = (outs, f) => outs.reduce((x, o) => x + o.p * f(o), 0);
      const lowOver = (outs, f) => Math.min(...outs.map((o) => f(o)));
      const highOver = (outs, f) => Math.max(...outs.map((o) => f(o)));
      const expect = (f) => agg(mean, (outs) => meanOf(outs, f)) + missOf(f, sumOver);
      const lowest = (f) => agg((a) => Math.min(...a), (outs) => Math.min(...outs.map((o) => f(o)))) + missOf(f, lowOver);
      const highest = (f) => agg((a) => Math.max(...a), (outs) => Math.max(...outs.map((o) => f(o)))) + missOf(f, highOver);
      return {
        perSwing: expect(landed),
        perSwingMin: lowest(landed),
        perSwingMax: highest(landed),
        cappedPerSwing: expect(claimed),
        cappedPerSwingMin: lowest(claimed),
        cappedPerSwingMax: highest(claimed),
      };
    }
    // A bare target (no worn piece): one defended number per roll, then the same host steps as outcomes.
    const ctx = { weapon: w, offHand: !!opts.offHand, traits: traitList, strikeKind, bow, potentVs: strikes, echoes, relay: !!tgt.relayBody, warded: tgt.warded === true };
    const each = (rolls) => rolls.map((d) => afterShare(hand(defended(d)), 1, ctx));
    const plain = each(plainRolls);
    const crits = each(critRolls);
    const over = (rows, f, across) => across(rows.map((outs) => f(outs)));
    const e = (g) => (outs) => outs.reduce((sum, o) => sum + o.p * g(o), 0);
    const lo = (g) => (outs) => Math.min(...outs.map((o) => g(o)));
    const hi = (g) => (outs) => Math.max(...outs.map((o) => g(o)));
    // With Potent Vs a swing that missed is the five (afterShare), weighted by the chance to miss.
    const missOuts = ctx.potentVs ? afterShare(0, 1, ctx) : null;
    const missP = 1 - ((1 - h.crit.chance) * h.hitPlain + h.crit.chance * h.hitCrit);
    const miss = (fOne) => (missOuts ? missP * fOne(missOuts) : 0);
    const mix = (fOne, across) => (1 - h.crit.chance) * h.hitPlain * over(plain, fOne, across) + h.crit.chance * h.hitCrit * over(crits, fOne, across) + miss(fOne);
    return {
      perSwing: mix(e(landed), mean),
      perSwingMin: mix(lo(landed), (a) => Math.min(...a)),
      perSwingMax: mix(hi(landed), (a) => Math.max(...a)),
      cappedPerSwing: mix(e(claimed), mean),
      cappedPerSwingMin: mix(lo(claimed), (a) => Math.min(...a)),
      cappedPerSwingMax: mix(hi(claimed), (a) => Math.max(...a)),
    };
  };
  // Three outcomes: an ordinary swing (the foe not back-facing), and a back-facing swing that is
  // either ordinary or a ×3 backstab. Each is its own mixture so the cap and the body-part
  // distribution see the ×3 blow as a separate claim, never as a scaled average.
  const branchLists = { ordinary: [], behindOrdinary: [], behindBackstab: [] };
  swingKeys.forEach((key, i) => {
    const dmg = dmgs[i];
    branchLists.ordinary.push(computeBranch(hits[i], dmg.plainRolls, dmg.critRolls));
    if (behind) {
      branchLists.behindOrdinary.push(computeBranch(hitsBehind[i], dmg.plainRolls, dmg.critRolls));
      branchLists.behindBackstab.push(computeBranch(hitsBehind[i], dmg.backstabPlainRolls, dmg.backstabCritRolls));
    }
  });
  const mixBranch = (list) => {
    if (list.length === 1) return list[0];
    const out = {};
    for (const key of ['perSwing', 'perSwingMin', 'perSwingMax', 'cappedPerSwing', 'cappedPerSwingMin', 'cappedPerSwingMax'])
      out[key] = list.reduce((sum, b) => sum + b[key] * swingChance, 0);
    return out;
  };
  const ordinary = mixBranch(branchLists.ordinary);
  const behindOrdinary = behind ? mixBranch(branchLists.behindOrdinary) : ordinary;
  const behindBackstab = behind ? mixBranch(branchLists.behindBackstab) : ordinary;
  // Per-direction figures, on the same backstab mixture, for a caller that wants to see the draw.
  const swingMix = swingKeys.map((key, i) => {
    const o = branchLists.ordinary[i];
    const bo = behind ? branchLists.behindOrdinary[i] : o;
    const bb = behind ? branchLists.behindBackstab[i] : o;
    const bl = (k) => (1 - backUptime) * o[k] + backUptime * ((1 - backProb) * bo[k] + backProb * bb[k]);
    return {
      key, chance: swingChance,
      damage: (SWING_MODS[key] ?? { damage: 0 }).damage,
      toHit: (SWING_MODS[key] ?? { toHit: 0 }).toHit,
      hit: hits[i].hit,
      perSwing: bl('perSwing'),
      cappedPerSwing: bl('cappedPerSwing'),
    };
  });
  const blend = (key) => (1 - backUptime) * ordinary[key]
    + backUptime * ((1 - backProb) * behindOrdinary[key] + backProb * behindBackstab[key]);
  const perSwing = blend('perSwing');
  const perSwingMin = blend('perSwingMin');
  const perSwingMax = blend('perSwingMax');
  const cappedPerSwing = blend('cappedPerSwing');
  const cappedPerSwingMin = blend('cappedPerSwingMin');
  const cappedPerSwingMax = blend('cappedPerSwingMax');
  // The hit card and the allowance read the same mixture's hit chance: the draw's expectation, then the
  // back-facing share.
  const mixHits = (list) => {
    if (list.length === 1) return list[0];
    const acc = (key) => list.reduce((sum, h) => sum + h[key] * swingChance, 0);
    const terms = { ...list[0].terms };
    for (const key of ['base', 'armour', 'other', 'backstab'])
      terms[key] = list.reduce((sum, h) => sum + num(h.terms?.[key], 0) * swingChance, 0);
    return {
      ...list[0],
      hit: acc('hit'),
      hitPlain: acc('hitPlain'),
      hitCrit: acc('hitCrit'),
      byPart: {
        plain: list[0].byPart.plain.map((_, i) => list.reduce((sum, h) => sum + h.byPart.plain[i] * swingChance, 0)),
        crit: list[0].byPart.crit.map((_, i) => list.reduce((sum, h) => sum + h.byPart.crit[i] * swingChance, 0)),
      },
      terms,
    };
  };
  const hitMix = mixHits(hits);
  const hitBehindMix = behind ? mixHits(hitsBehind) : hitMix;
  const hitOut = {
    ...hitMix,
    hit: (1 - backUptime) * hitMix.hit + backUptime * hitBehindMix.hit,
    hitPlain: (1 - backUptime) * hitMix.hitPlain + backUptime * hitBehindMix.hitPlain,
    hitCrit: (1 - backUptime) * hitMix.hitCrit + backUptime * hitBehindMix.hitCrit,
    byPart: {
      plain: hitMix.byPart.plain.map((v, i) => (1 - backUptime) * v + backUptime * hitBehindMix.byPart.plain[i]),
      crit: hitMix.byPart.crit.map((v, i) => (1 - backUptime) * v + backUptime * hitBehindMix.byPart.crit[i]),
    },
    terms: { ...hitMix.terms, backstab: backUptime * backSkill },
  };

  const dps = perSwing * cad.aps;
  const dpsMin = perSwingMin * cad.aps;
  const dpsMax = perSwingMax * cad.aps;
  const cappedDps = cappedPerSwing * cad.aps;
  const cappedDpsMin = cappedPerSwingMin * cad.aps;
  const cappedDpsMax = cappedPerSwingMax * cad.aps;
  const ench = opts.enchants === false ? null : enchantDps(w?.item ?? ch.wraps ?? ch.weapon, ch, tgt, { hit: hitOut.hit, aps: cad.aps, level: ch.level, potencyPct: opts.potencyPct, pierce: opts.pierce, cap, standard: opts.standard });
  const enchantPerSwing = ench?.perSwing ?? 0;
  const enchantDpsValue = ench?.dps ?? 0;
  const enchantDpsMin = ench?.dpsMin ?? 0;
  const enchantDpsMax = ench?.dpsMax ?? 0;
  const totalDps = cappedDps + enchantDpsValue;
  const totalDpsMin = cappedDpsMin + enchantDpsMin;
  const totalDpsMax = cappedDpsMax + enchantDpsMax;
  const ward = traitList.includes('warded') && bossHealth > 0 ? Math.max(1, Math.round(bossHealth * WARD_SHARE)) : 0;
  const shields = Math.max(0, num(t.phaseShields, 0)) * Math.max(0, num(t.shieldSeconds, 0));
  const ttk = bossHealth > 0 && cappedDps > 0 ? (bossHealth + ward) / cappedDps + shields : null;
  const totalTtk = bossHealth > 0 && (cappedDps + enchantDpsValue) > 0 ? (bossHealth + ward) / (cappedDps + enchantDpsValue) + shields : null;
  const wrath = traitList.includes('wrathful');
  const gate = allowancePatch(tgt, bossHealth, { cappedPerSwing, hit: hitOut.hit, aps: cad.aps, procs: ench?.procs, cap });
  return {
    core, weapon: w, target: tgt, swing, swingDirections: swingKeys, swingMix, hit: hitOut, damage: displayDmg, cadence: cad,
    perSwing, perSwingMin, perSwingMax, dps, dpsMin, dpsMax,
    cappedPerSwing, cappedPerSwingMin, cappedPerSwingMax, cappedDps, cappedDpsMin, cappedDpsMax, cap, capSource, capLoss: dps > 0 ? 1 - cappedDps / dps : 0,
    enchantPerSwing, enchantDps: enchantDpsValue, enchantDpsMin, enchantDpsMax, totalDps, totalDpsMin, totalDpsMax, totalTtk: gate?.totalTtk ?? totalTtk, enchantProcs: ench?.procs ?? [], enchantDotDps: ench?.dotDps ?? 0, enchantDotDpsMin: ench?.dotDpsMin ?? 0, enchantDotDpsMax: ench?.dotDpsMax ?? 0, procsBeforeBreak: procsBeforeBreak(w?.item ?? ch.wraps ?? ch.weapon), procsBeforeBreakBasis: PROCS_BEFORE_BREAK_BASIS,
    resist, health: bossHealth || null, ward, shields, ttk: gate?.ttk ?? ttk, ttkCapOnly: ttk, totalTtkCapOnly: totalTtk, allowance: gate?.allowance ?? null, wrath, wrathAt: WRATH_AFTER_S,
    targetDefense,
    backstab: {
      skill: backSkill,
      chance: backProb,
      probability: backProb,
      toHit: backSkill,
      multiplier: 3,
      uptime: backUptime,
      expectedMult: 1 + 2 * backUptime * backProb,
      watchful,
      min: struck(bowBlow(defended(Math.min(...dmgMix.backstabPlainRolls)), bow)),
      max: struck(bowBlow(defended(Math.max(...dmgMix.backstabPlainRolls)), bow)),
      critMin: struck(bowBlow(defended(Math.min(...dmgMix.backstabCritRolls)), bow)),
      critMax: struck(bowBlow(defended(Math.max(...dmgMix.backstabCritRolls)), bow)),
    },
    traits: traitList, healthShare: simOpts.healthShare,
    notes: {
      preWornArmor: !geared,
      targetIntrinsic: true,
      condition: w ? w.conditionPct : 1,
      softMaterial: matReqMulti < 1,
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
  return makeTarget({
    isClass,
    level: num(level, 1),
    careerIndex: -1,
    stats: { strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50 },
    skills: Object.fromEntries(Array.from({ length: 35 }, (_, i) => [i, Math.min(100, num(level, 1) * 5 + 30)])),
    health: 100,
    maxHealth: 100,
    armorValues: new Array(7).fill(armor),
    career: null,
    group: def?.group ?? null,
    affinity: def?.affinity ?? null,
    healthShare: num(def?.healthShare, 1),
  });
}

/** The encounter's half of a boss: its health, traits, cap and shields, over a body. `level` is the
 *  content level (the allowance and the hit cap read it); the body's own level stays `combatLevel`. */
function bossFields(t, { level, health, traits, group, hitCap, phaseShields, shieldSeconds, spareGear }) {
  t.level = num(level, 1);
  t.health = health;
  t.maxHealth = health;
  t.isBoss = true;
  t.bossTraits = [...traits];
  if (group != null) t.group = group;
  t.healthShare = 1;
  t.hitCap = hitCap;
  t.phaseShields = phaseShields;
  t.shieldSeconds = shieldSeconds;
  t.spareGear = spareGear;
  return t;
}

/**
 * A boss target: the encounter's health, traits, cap and shields over a body.
 *
 * With a `mobileType` the body is the game's relay stand-in for that mobile (`standInTarget`,
 * world/gate/gateBoss.js bossStandIn): its level, skills, armour, metal, career index and affinity are
 * the game's, so none of them may be set beside it. Without one it is a generic card body
 * (`referenceFoe` at `level`, with the armour class and identity fields given), for what-if bosses.
 */
export function bossTarget({
  level = 30, armorValue = null, isClass = null, health = 5000, traits = [], group = null,
  hitCap = 0, phaseShields = 0, shieldSeconds = 0,
  mobileType = null, careerIndex = null, career = null, affinity = null,
  minMetalToHit = null, spareGear = true,
} = {}) {
  const content = { level, health, traits, group, hitCap, phaseShields, shieldSeconds, spareGear };
  if (mobileType != null) {
    const set = Object.entries({ armorValue, isClass, careerIndex, career, affinity, minMetalToHit })
      .filter(([, v]) => v != null).map(([k]) => k);
    if (set.length) {
      throw new Error(`bossTarget: mobile ${mobileType}'s body is the game's stand-in (standInTarget); ${set.join(', ')} cannot be set beside it`);
    }
    return bossFields(standInTarget(mobileType), content);
  }
  const cls = !!isClass;
  const t = referenceFoe(level, { isClass: cls, armorValue: armorValue ?? 0 });
  const ci = careerIndex ?? -1;
  const aff = affinity ?? (cls ? 'Human' : null);
  if (career) {
    for (const k of ['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck']) {
      if (Number.isFinite(Number(career[k]))) t.stats[k] = Number(career[k]);
    }
  }
  t.mobileType = null;
  t.careerIndex = ci;
  t.career = career;
  t.affinity = aff;
  t.minMetalToHit = minMetalToHit ?? -1;
  t.group = targetGroupOf({ careerIndex: ci, affinity: aff, isClass: cls });
  return bossFields(t, content);
}

/** The Breach stand-in's body level, as the game mints it: world/gate/gateBoss.js:152 makes
 *  `makeEnemyEntity(31, ENEMY_BASICS[31], null, 1)`, and under the shipped boot the Daedra Lord's
 *  MUDEX row stands at 21 (`standInTarget`, the assumptions register A15). The enemy-type bonus reads
 *  `target.level` upstream; the content `level` stays the allowance/hit-cap level. */
export const GATE_BODY_LEVEL = standInTarget(31).level;

/** The real gate boss (Valkynaz Ruhn): a plate-armour monster, the solo pool for this level, the server hit cap and the two phase shields. */
export function gateTarget(level, { health = gateHealth(level), traits = null, hitCap = null, players = 1, blowX = 1 } = {}) {
  const t = bossTarget({
    level, health: health * Math.max(1, Math.floor(players)),
    // The Warden's traits come from the game's own selector (relayBossTraits on the name and mobile),
    // not from a list here: relayTraitsFor('breach') = ['spellproof', 'stoneskin'] at a3eb1605.
    traits: traits ?? relayTraitsFor('breach') ?? [],
    // The body is the game's stand-in for mobile 31 (standInTarget: world/gate/gateBoss.js:151-161) -
    // its career index, affinity, level, skills, BOSS_ARMOR and minMetalToHit 0 are the game's.
    mobileType: 31, spareGear: true,
    group: 'daedra', // Valkynaz Ruhn is a Daedra Lord (gateBoss.js WBX7), not a humanoid
    hitCap: hitCap ?? Math.round(gateHitCap(level) * Math.max(1, num(blowX, 1))), phaseShields: GATE_SHIELDS, shieldSeconds: GATE_SHIELD_S,
  });
  // The relay's per-player allowance (allowance.js): the Breach takes a claim only as far as the player's bucket allows.
  t.allowance = allowanceSpec(level, { players });
  return t;
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
