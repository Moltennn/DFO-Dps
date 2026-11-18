/*
 * dfo-dps - the target as the hit path sees it.
 *
 * The player/build is one object; a target is another. The fields here are the ones the
 * pinned game reads before a blow reaches the relay's cap and allowance:
 *
 *   combat/pcaao.js:1594-1605  pcaaoNaturalDamageResistance  (END/STR/WIL, float32)
 *   combat/pcaao.js:1447-1471  pcaaoPercentageReductionCalculationForMonsters  (the hide)
 *   combat/pcaao.js:1349-1392  the same natural resistance for a gearless class target
 *   combat/pcaao.js:1140-1250  the armour and shield reduction rows
 *   combat/pcaao.js:1261-1335  the blocking shield's own row and the under-armour comparison
 *   combat/pcaao.js:1474-1570  shield block chance (strong/weak spot)
 *   combat/pcaao.js:1640-1700  minMetalToHit and the soft-material multiplier
 *   characters/enemy/enemyBasics.js  ENEMY_BASICS, enemyCareerIndex, enemyEntityType
 *   combat/enemyGroups.js      enemyEntityGroup (the career's group)
 *   combat/enemyEquipment.js   armorOfMaterial (the game's item minter), enemyArmorValues
 *   systems/equip.js           slotForBodyPart, armorBodyParts (a piece's body part)
 *   systems/armorMaterials.js  SHIELD_PARTS, isShieldTemplate, itemArmorValue
 *   systems/loot/lootPowers.js:164-167  elementShare (a career's fire/frost/shock/poison/magic tolerance)
 *   systems/spellcast.js:61-68  careerTolerance: Resistant > Immune > LowTolerance > CriticalWeakness
 *
 * A target's WORN gear is kept apart from its fixed hit-chance `armorValues`:
 * the gate stand-in's `armorValues` of 60 is a fixed value, while `equip.slots`
 * is the item table the per-body-part reduction reads. Silver, enemy-type
 * bonuses, backstab and condition changes remain outside this module.
 */
import { SKILLS, PCAAO_BODY_PARTS, STRUCK_BODY_PARTS } from './data.js';
import { liveStat } from './save.js';
import {
  ENEMY_BASICS, VANILLA_ENEMY_BASICS, enemyCareerIndex, enemyEntityType,
} from '../vendor/upstream/a3eb1605/src/characters/enemy/enemyBasics.js';
import { skillsLevel, KNIGHT_CITYWATCH_ID } from '../vendor/upstream/a3eb1605/src/characters/enemy/enemyEntity.js';
import { applyMeanerMonsters, MEANER_MONSTERS_VENDOR } from '../vendor/upstream/a3eb1605/src/characters/meanerMonsters.js';
import { meanerMonstersRow as pcaaoMeanerMonstersRow } from '../vendor/upstream/a3eb1605/src/combat/pcaaoMeanerMonsters.js';
import { dexClassicRow, DEX_VENDOR, dexRead } from '../vendor/upstream/a3eb1605/src/systems/enemyExpansion/dexInstall.js';
import { createDexEquipmentAssigner } from '../vendor/upstream/a3eb1605/src/systems/enemyExpansion/dexEquipment.js';
import { MOD_SETTINGS } from '../vendor/upstream/a3eb1605/src/systems/modSettings.js';
import { BOSS_ARMOR } from '../vendor/upstream/a3eb1605/src/world/gate/gateBoss.js';
import {
  ENEMY_GROUPS, enemyEntityGroup,
} from '../vendor/upstream/a3eb1605/src/combat/enemyGroups.js';
import { careerAttackModifier, silverDoubles } from '../vendor/upstream/a3eb1605/src/combat/formulas.js';
import {
  SHIELD_PARTS, isShieldTemplate, itemArmorValue,
} from '../vendor/upstream/a3eb1605/src/systems/armorMaterials.js';
import { EQUIP_SLOTS, slotForBodyPart, armorBodyParts } from '../vendor/upstream/a3eb1605/src/systems/equip.js';
import {
  armorOfMaterial, enemyArmorValues, equipmentVariantFor, assignEnemyEquipment,
} from '../vendor/upstream/a3eb1605/src/combat/enemyEquipment.js';
import { conditionPercentage } from '../vendor/upstream/a3eb1605/src/systems/item/itemTemplates.js';
import { PCAAO_REDUCTION_ROWS, SILVER_DOUBLED_CAREERS } from '../vendor/upstream/a3eb1605/src/combat/pcaao.js';

const floor = Math.floor;
const trunc = Math.trunc;
const fround = Math.fround;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const STAT_KEYS = Object.freeze([
  'strength', 'intelligence', 'willpower', 'agility',
  'endurance', 'personality', 'speed', 'luck',
]);
const SKILL_IDS = Object.freeze(Array.from({ length: 35 }, (_, i) => i));

/** Unity's Mathf.Round: half to even (the model's own function, repeated here to avoid a cycle). */
function unityRound(x) {
  const f = floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** The career flag bytes (systems/spellcast.js:37-45; the vendored file is a stub). */
export const EFFECT_FLAGS = Object.freeze({
  Paralysis: 1, Magic: 2, Poison: 4, Fire: 8, Frost: 16, Shock: 32, Disease: 64,
});
/** Classic spell element index -> its flag (systems/spellcast.js:46-57). */
export const ELEMENT_FLAG_BY_INDEX = Object.freeze([
  EFFECT_FLAGS.Fire, EFFECT_FLAGS.Frost, EFFECT_FLAGS.Poison, EFFECT_FLAGS.Shock, EFFECT_FLAGS.Magic,
]);
/** A weapon elemental affix's element name -> its flag (systems/loot/lootPowers.js:156-163). */
export const ELEMENT_FLAG_BY_NAME = Object.freeze({
  fire: EFFECT_FLAGS.Fire,
  frost: EFFECT_FLAGS.Frost,
  shock: EFFECT_FLAGS.Shock,
  poison: EFFECT_FLAGS.Poison,
  magic: EFFECT_FLAGS.Magic,
});

/**
 * DFCareer.GetTolerance over the four CFG flag bytes, verbatim precedence:
 * Resistant > Immune > LowTolerance > CriticalWeakness (systems/spellcast.js:61-68,
 * full checkout at a3eb1605; the vendored `spellcast.js` is a generated stub).
 */
export function careerTolerance(career, flag) {
  if (!flag) return 'Normal';
  const has = (byte) => ((byte ?? 0) & flag) === flag;
  if (has(career?.resistanceFlags)) return 'Resistant';
  if (has(career?.immunityFlags)) return 'Immune';
  if (has(career?.lowToleranceFlags)) return 'LowTolerance';
  if (has(career?.criticalWeaknessFlags)) return 'CriticalWeakness';
  return 'Normal';
}

/** What a weapon's elemental line deals after a career's tolerance: none immune, half resistant, else whole.
 *  (systems/loot/lootPowers.js:164-167.) */
export function elementShare(target, element) {
  const flag = ELEMENT_FLAG_BY_NAME[String(element ?? '').toLowerCase()];
  if (!flag) return 1;
  const t = careerTolerance(target?.career ?? {}, flag);
  return t === 'Immune' ? 0 : t === 'Resistant' ? 0.5 : 1;
}

/** pcaao.js pcaaoNaturalDamageResistance: END x0.002, STR x0.001, WIL x0.001 above 50, float32. */
export function naturalDamageResistance(target) {
  if (!target) return 0;
  let n = fround((liveStat(target, 'endurance') - 50) * fround(0.002));
  n = fround(n + fround((liveStat(target, 'strength') - 50) * fround(0.001)));
  n = fround(n + fround((liveStat(target, 'willpower') - 50) * fround(0.001)));
  return n;
}

// ── enemy-type bonus/phobia and silver (Stage 2.3) ───────────────
const SKELETAL_WARRIOR_INDEX = 15; // pcaao.js:552

/** pcaao.js:491-522 pcaaoBonusOrPenaltyByEnemyType's TARGET group: the career group, NOT the
 *  affinity and not the class flag. A class foe whose career index is 0 is Animals here, and a
 *  class foe at 18 is Undead - the DFU career-collision quirk the overhaul reads verbatim. */
export function enemyTypeGroup(target) {
  if (target?.isPlayer) return ENEMY_GROUPS.Humanoid;
  return enemyEntityGroup(target?.careerIndex ?? -1);
}

/** The career byte the bonus/phobia decodes: `attackModifierFlags ?? career.attackModifierFlags`. */
export const attackModifierFlagsOf = (attacker) =>
  attacker?.attackModifierFlags ?? attacker?.career?.attackModifierFlags ?? null;

/**
 * pcaao.js:491-522 pcaaoBonusOrPenaltyByEnemyType, the player arm: a Willpower-driven random
 * bonus (Range(0, n), n-exclusive) and a target-level-driven penalty, decoded by the career's
 * Bonus/Phobia bits for the target's career group. The local attacker is always the player (the
 * simulator measures a build against a foe); a non-player attacker's arm is not used.
 */
export function enemyTypeBonusRange(attacker, target) {
  const flags = attackModifierFlagsOf(attacker);
  const group = enemyTypeGroup(target);
  const decoded = flags == null || group === ENEMY_GROUPS.None ? 0 : careerAttackModifier(flags, group);
  const will = trunc((liveStat(attacker ?? { stats: { willpower: 50 } }, 'willpower') - 50) / 5);
  const targetLevel = Number(target?.combatLevel ?? target?.level ?? 1) || 1;
  const bonus = Math.max(10 + will - trunc(targetLevel / 2), 0);
  const penalty = Math.max(trunc(targetLevel / 2) - will, 0);
  return { group, decoded, bonus, penalty, will, targetLevel };
}

/** The bonus for one `roll01`: `floor(roll01 * bonus)` for a bonus, the fixed `-penalty` for a
 *  phobia, 0 otherwise (pcaao.js:511 `rangeExclusive`). */
export function enemyTypeBonusValue(attacker, target, roll01 = 0) {
  const { decoded, bonus, penalty } = enemyTypeBonusRange(attacker, target);
  if (decoded === 1) return bonus > 0 ? floor(roll01 * bonus) : 0;
  if (decoded === -1) return 0 - penalty;
  return 0;
}

/** Every value the bonus roll can take, each equally likely (the blow's expected value). */
export function enemyTypeBonusValues(attacker, target) {
  const { decoded, bonus, penalty } = enemyTypeBonusRange(attacker, target);
  if (decoded === 1) return bonus > 0 ? Array.from({ length: bonus }, (_, i) => i) : [0];
  if (decoded === -1) return [0 - penalty];
  return [0];
}

/**
 * pcaao.js:555-590: the Skeletal Warrior's halving and the six silver-doubled careers, applied
 * to the weapon roll plus the swing/proficiency/racial damage modifiers, BEFORE Strength and the
 * material modifier. A silver weapon doubles (career 2) against Werewolf 9, Ghost 18, Wraith 23,
 * Vampire 28, Mummy 19 and Wereboar 14; the Skeletal Warrior 15 halves every weapon whose flags
 * lack 0x10 (no port weapon sets it) and then doubles a silver one. Unarmed blows take neither.
 */
export const isSkeletalTarget = (target) => target?.careerIndex === SKELETAL_WARRIOR_INDEX;
export function silverApplies(target, weapon) {
  if (!weapon || !target || target.isPlayer || weapon.material !== 2 || !silverDoubles(target)) return false;
  return isSkeletalTarget(target) || SILVER_DOUBLED_CAREERS.includes(target.careerIndex);
}
export function skeletalSilverDamage(damage, target, weapon) {
  if (!weapon || !target || target.isPlayer) return damage;
  if (isSkeletalTarget(target)) {
    const flags = weapon.flags ?? weapon.item?.flags ?? 0;
    let d = (flags & 0x10) === 0 ? trunc(damage / 2) : damage;
    if (silverApplies(target, weapon)) d *= 2;
    return d;
  }
  if (silverApplies(target, weapon)) return damage * 2;
  return damage;
}

/**
 * pcaao.js pcaaoPercentageReductionCalculationForMonsters: the innate hide of a monster that wears
 * nothing on the struck part, by its career group. The result already includes natural resistance;
 * do not subtract it again. `damage` is the blow after critical/condition, before the host's traits.
 */
export function monsterHideDamage(target, damage, bluntWep, naturalDamResist = naturalDamageResistance(target), exact = false) {
  // `exact`: the carried metric's mean is not rounded again - upstream's unityRound runs on each integer blow,
  // whose mean this is (src/model.js carriedPct).
  const r = (m) => (exact
    ? fround(damage * fround(fround(m) - naturalDamResist))
    : unityRound(fround(damage * fround(fround(m) - naturalDamResist))));
  const c = target?.careerIndex;
  switch (enemyEntityGroup(c)) {
    case ENEMY_GROUPS.Animals:
      return r(1);
    case ENEMY_GROUPS.Undead:
      return c === 15 ? r(0.8) : r(1);
    case ENEMY_GROUPS.Humanoid:
      if (c === 22) return bluntWep ? r(1.21) : r(0.71);
      if (c === 2) return bluntWep ? r(0.66) : r(1.26);
      return r(1);
    case ENEMY_GROUPS.Daedra:
      if (c === 27) return r(0.95);
      if (c === 26) return r(1);
      if (c === 25) return bluntWep ? r(1.04) : r(0.84);
      if (c === 31) return r(0.95);
      return r(1);
    case ENEMY_GROUPS.None:
      if (c === 38) return bluntWep ? r(1.4) : r(1);
      if (c === 36) return bluntWep ? r(0.6) : r(0.9);
      return r(1);
    default:
      return r(1);
  }
}

/**
 * pcaao.js pcaaoArmorDamageReductionWithWeapon/Unarmed's no-armour arm and the monster-hide arm:
 * a gearless monster takes its career's hide; any other gearless target takes natural resistance
 * alone. This is the seven-part table with no worn piece on any part; `targetExpectedDamage`
 * below resolves a geared target part by part. (`spareGear` is upstream's "a blow wears no
 * weapon" flag, not an armour flag, so it does not enter this decision.)
 */
export function intrinsicDamage(target, damage, { weapon = null, exact = false } = {}) {
  if (!(damage > 0) || !target) return damage;
  const natural = naturalDamageResistance(target);
  const blunt = weapon ? weapon.skillId === SKILLS.BluntWeapon : false;
  if (target.isClass === false && target.careerIndex != null) {
    return monsterHideDamage(target, damage, blunt, natural, exact);
  }
  // `exact` is the carried metric's mean (see monsterHideDamage): the defensive round is applied per integer
  // blow upstream, so rounding the mean would quantise the carry away.
  return exact
    ? fround(damage * fround(1 - natural))
    : unityRound(fround(damage * fround(1 - natural)));
}

// ── worn armour and the shield (Stage 2.2) ────────────────────────
const REDUCTION = PCAAO_REDUCTION_ROWS;
const PART_WEIGHTS = (() => {
  const counts = new Array(7).fill(0);
  for (const part of PCAAO_BODY_PARTS) counts[part]++;
  return counts.map((n) => n / PCAAO_BODY_PARTS.length);
})();

/** pcaao.js:1139-1146: one row's reduction, Mathf.Round half to even, every term float32. */
const reduce = (damage, base, cap, cond, nat) =>
  unityRound(fround(damage * fround(fround(Math.min(fround(base * cond), fround(cap))) - nat)));

/** pcaao.js:1147-1150: the row for a material, or `1/1` outside the ladder. */
function table(rows, material, damage, cond, nat) {
  const row = rows[material];
  return row ? reduce(damage, row[0], row[1], cond, nat) : reduce(damage, 1, 1, cond, nat);
}

/** pcaao.js:657-688 pcaaoArmorMaterialIdentifier: a non-shield piece's material value / 2; a
 *  shield by its native material (leather 1 .. daedric 10); nothing is 1. */
export function armourMaterialId(item) {
  if (!item) return 1;
  if (!isShieldTemplate(item.templateIndex)) return trunc(itemArmorValue(item) / 2);
  switch (item.material ?? 0) {
    case 0: return 1;
    case 256:
    case 259: return 2;
    case 512: return 3;
    case 513:
    case 514: return 4;
    case 515: return 5;
    case 516: return 6;
    case 517:
    case 518: return 7;
    case 519: return 8;
    case 520: return 9;
    case 521: return 10;
    default: return 1;
  }
}

/** pcaao.js:627-648 pcaaoAlterArmorReducBasedOnItemCondition: worn armour reduces less.
 *  `sharpEdge` (the mod's wear module) keeps the >75% edge; the port's default is off, so a
 *  piece at 76% or better is `1` and only worn pieces move. */
export function armourConditionMultiplier(item, { sharpEdge = false } = {}) {
  if (!item) return 1;
  const pct = conditionPercentage(item);
  if (pct >= 76 && !sharpEdge) return 1;
  if (pct >= 92) return fround(0.85);
  if (pct >= 76) return fround(0.95);
  if (pct >= 61) return 1;
  if (pct >= 41) return fround(1.1);
  if (pct >= 16) return fround(1.2);
  if (pct >= 6) return fround(1.35);
  if (pct <= 5) return fround(1.5);
  return 1;
}

const condOf = (item, sharpEdge) => armourConditionMultiplier(item, { sharpEdge });

/** pcaao.js:1268-1299: a strike against a worn piece (fist, blunt or edged rows). */
export function armourReduction(item, damage, { natural = 0, blunt = false, unarmed = false, sharpEdge = false } = {}) {
  const rows = unarmed ? REDUCTION.UNARMED_ROWS : blunt ? REDUCTION.BLUNT_ROWS : REDUCTION.EDGED_ROWS;
  return table(rows, armourMaterialId(item), damage, condOf(item, sharpEdge), natural);
}

/** pcaao.js:1259-1275: the blocking shield's row, by the attack's kind. */
export function shieldReduction(shield, damage, { natural = 0, blunt = false, unarmed = false, sharpEdge = false } = {}) {
  const rows = unarmed ? REDUCTION.SHIELD_UNARMED_ROWS
    : blunt ? REDUCTION.SHIELD_BLUNT_ROWS : REDUCTION.SHIELD_EDGED_ROWS;
  return table(rows, armourMaterialId(shield), damage, condOf(shield, sharpEdge), natural);
}

/** pcaao.js:192-196 struckSlotItem: the piece the equip table wears on a body part, if any. */
export function struckSlotItem(target, part) {
  const slots = target?.equip?.slots;
  if (!slots) return null;
  const slot = slotForBodyPart(part);
  return slot !== EQUIP_SLOTS.None ? (slots[slot] ?? null) : null;
}

/** pcaao.js:201-205 leftHandShield: the LEFT HAND's shield, else null (a weapon there never
 *  blocks - the port's sixth departure, `isShield`). */
export function leftHandShield(target) {
  const item = target?.equip?.slots?.[EQUIP_SLOTS.LeftHand] ?? null;
  return item && item.group === 'Armor' && isShieldTemplate(item.templateIndex) ? item : null;
}

/** Whether any equip slot holds a piece (the worn-armour branch is live). */
export function hasWornEquipment(target) {
  const slots = target?.equip?.slots;
  if (!slots) return false;
  for (const key of Object.keys(slots)) if (slots[key]) return true;
  return false;
}

/** pcaao.js:1519-1570 pcaaoShieldBlockChanceCalculation: the integer block percentage, before
 *  the dice. A strong spot (a part the shield covers) uses the shield's base bent by agility,
 *  speed, strength, endurance, willpower and luck; a weak spot its smaller base. The C#'s
 *  Mathf.Clamp(7,95)/(0,50) are computed and discarded upstream, so they are not applied. */
export function shieldBlockChance(target, strongSpot, shield) {
  let strong = 0;
  let weak = 0;
  switch (shield?.templateIndex) {
    case 109: strong = 30; weak = 20; break;
    case 110: strong = 35; weak = 10; break;
    case 111: strong = 45; weak = 5; break;
    case 112: strong = 55; weak = -5; break;
    default: strong = 40; weak = 0; break;
  }
  const d = (k) => liveStat(target, k) - 50;
  const agi = d('agility');
  const spd = d('speed');
  const str = d('strength');
  const end = d('endurance');
  const wil = d('willpower');
  const luk = d('luck');
  let n;
  if (strongSpot) {
    n = fround(strong);
    n = fround(n + fround(agi * fround(0.3)));
    n = fround(n + fround(spd * fround(0.3)));
    n = fround(n + fround(str * fround(0.3)));
    n = fround(n + fround(end * fround(0.2)));
    n = fround(n + fround(wil * fround(0.1)));
    n = fround(n + fround(luk * fround(0.1)));
  } else {
    n = fround(weak);
    n = fround(n + fround(agi * fround(0.3)));
    n = fround(n + fround(spd * fround(0.2)));
    n = fround(n + fround(str * fround(0.2)));
    n = fround(n + fround(end * fround(0.1)));
    n = fround(n + fround(wil * fround(0.1)));
    n = fround(n + fround(luk * fround(0.1)));
  }
  return unityRound(n);
}

/** pcaao.js:1573-1590 pcaaoCompareShieldToUnderArmor: the shield reduces only when its
 *  average reduction over a nominal 100 is at least as good as the piece under it (bare skin
 *  reduces by the natural resistance alone). Lower damage left is better. */
export function shieldBeatsUnderArmour(target, part, naturalDamResist = naturalDamageResistance(target), { sharpEdge = false } = {}) {
  const shield = leftHandShield(target);
  if (!shield) return false;
  const shieldLeft = table(REDUCTION.AVERAGE_SHIELD_ROWS, armourMaterialId(shield), 100, condOf(shield, sharpEdge), naturalDamResist);
  const under = struckSlotItem(target, part);
  const underLeft = under
    ? table(REDUCTION.AVERAGE_ARMOR_ROWS, armourMaterialId(under), 100, condOf(under, sharpEdge), naturalDamResist)
    : unityRound(fround(100 * fround(1 - naturalDamResist)));
  return shieldLeft <= underLeft;
}

/**
 * One struck body part's damage after the target's defence, as the OUTCOMES upstream can produce, each with
 * its probability: `[{ p, damage }]`, the damages whole numbers (integer-rounded as pcaao.js:1349-1590 does).
 *
 * pcaaoAttackDamage resolves ONE blow at a time (pcaao.js:1784-1796, :1815-1850): the shield's `dice100`
 * block roll is made first; a block gives the shield row's reduction, a miss of the roll the struck part's
 * worn piece, else the monster's career hide, else natural resistance. Everything after it - the off hand's
 * share (:1850), `bossStrike`'s `max(1, round)`, the relay cap - is nonlinear and acts on THAT whole
 * number, so a caller must run it on each outcome and weight afterwards, never on their mean.
 *
 * `dice100(chance)` succeeds for `floor(roll*100) < chance`, so a block has probability `chance/100`.
 */
export function targetPartOutcomes(target, damage, part, { weapon = null, sharpEdge = false } = {}) {
  if (!(damage > 0) || !target) return [{ p: 1, damage }];
  const natural = naturalDamageResistance(target);
  const blunt = !!weapon && weapon.skillId === SKILLS.BluntWeapon;
  const unarmed = !weapon;
  const armour = struckSlotItem(target, part);
  const under = armour
    ? armourReduction(armour, damage, { natural, blunt, unarmed, sharpEdge })
    : (target.isClass === false && !target.isPlayer)
      ? monsterHideDamage(target, damage, blunt, natural)
      : unityRound(fround(damage * fround(1 - natural)));
  const shield = leftHandShield(target);
  if (!shield) return [{ p: 1, damage: under }];
  const strong = (SHIELD_PARTS.get(shield.templateIndex) ?? []).includes(part);
  const chance = shieldBlockChance(target, strong, shield);
  const p = clamp(chance, 0, 100) / 100;
  if (p <= 0 || !shieldBeatsUnderArmour(target, part, natural, { sharpEdge })) return [{ p: 1, damage: under }];
  const blocked = shieldReduction(shield, damage, { natural, blunt, unarmed, sharpEdge });
  if (p >= 1) return [{ p: 1, damage: blocked }];
  return [{ p, damage: blocked }, { p: 1 - p, damage: under }];
}

/**
 * The EXPECTATION of `targetPartOutcomes` - a real number, only valid where nothing nonlinear follows
 * (a display, a card). The hit path (src/model.js `analyze`) uses the outcomes.
 */
export function targetPartDamage(target, damage, part, opts = {}) {
  const o = targetPartOutcomes(target, damage, part, opts);
  return o.length === 1 ? o[0].damage : o[0].p * o[0].damage + o[1].p * o[1].damage;
}

/** The expectation over the overhaul's 20-entry body-part table. `map` runs on each part's
 *  post-defence damage (the off hand's share, for example). */
export function targetExpectedDamage(target, damage, { weapon = null, weights = PART_WEIGHTS, map = null } = {}) {
  if (!(damage > 0) || !target) return damage;
  let sum = 0;
  let first = null;
  let uniform = true;
  for (let part = 0; part < 7; part++) {
    const w = weights[part] ?? 0;
    if (!w) continue;
    const v = targetPartDamage(target, damage, part, { weapon });
    if (first == null) first = v;
    else if (v !== first) uniform = false;
    sum += w * v;
  }
  // With no worn piece on any part every part answers the same integer; return it exactly, so a
  // weighted sum's float error cannot move a later half-to-even round.
  if (uniform) return map && first != null ? map(first) : first;
  if (map) {
    let mapped = 0;
    for (let part = 0; part < 7; part++) {
      const w = weights[part] ?? 0;
      if (!w) continue;
      mapped += w * map(targetPartDamage(target, damage, part, { weapon }));
    }
    return mapped;
  }
  return sum;
}

/** The body-part weights for a core (the same table the hit model uses). */
export function bodyPartWeights(core = 'overhaul') {
  if (core !== 'overhaul') {
    const w = new Array(7).fill(0);
    for (const part of STRUCK_BODY_PARTS) w[part]++;
    return w.map((n) => n / STRUCK_BODY_PARTS.length);
  }
  return PART_WEIGHTS;
}

/** Mint one worn piece through the game's own ItemBuilder (`armorOfMaterial`). `condition` is
 *  the share of the piece's maximum left, 0..1. */
export function armourPiece(templateIndex, { material = 0, condition = 1, variant = null } = {}) {
  const item = armorOfMaterial(Number(templateIndex), Number(material), variant);
  const max = item.maxCondition ?? 0;
  item.currentCondition = Math.max(0, Math.min(max, Math.round(max * clamp(Number(condition), 0, 1))));
  return item;
}

/**
 * Wear pieces on a target. Each goes to the equip slot its template names (a shield to the left
 * hand), the same placement scenes/hostCombat.js equipEnemy performs after the game's
 * AssignEnemyStartingEquipment. `armorValues: true` recomputes the struck-part ArmorValues in the
 * same pass (enemyEquipment.js enemyArmorValues), which is the hit-chance half; without it the
 * target keeps whatever fixed armour it declared.
 */
export function equipArmour(target, pieces = [], { armorValues = false } = {}) {
  const slots = { ...(target.equip?.slots ?? {}) };
  const armorPieces = [];
  for (const piece of pieces) {
    const item = piece?.group === 'Armor' ? piece : armourPiece(piece.templateIndex, piece ?? {});
    const shield = isShieldTemplate(item.templateIndex);
    const part = shield ? null : (armorBodyParts(item)[0] ?? null);
    const slot = shield ? EQUIP_SLOTS.LeftHand : (part == null ? EQUIP_SLOTS.None : slotForBodyPart(part));
    if (slot === EQUIP_SLOTS.None || slots[slot]) continue;
    slots[slot] = item;
    armorPieces.push({ piece: item.templateIndex, material: item.material, ...(shield ? { shield: true } : {}) });
  }
  target.equip = { slots };
  if (armorValues) {
    target.armorValues = enemyArmorValues(
      { isClass: !!target.isClass, armor: target.armorValues?.[0] ?? 0 },
      armorPieces,
    );
  }
  return target;
}

/**
 * The equipment delegate the client's boot installs: Enemy Expansion's copy of Roleplay & Realism's class
 * arm (systems/enemyExpansion/dexInstall.js:246-247 `setEnemyEquipmentAssigner(createDexEquipmentAssigner)`;
 * combat/enemyEquipment.js:346 consults it first). Read, never installed: installEnemyExpansion rewrites
 * ENEMY_BASICS in place (dexInstall.js:211-220) while this module's rows are already `dexClassicRow` over
 * the pristine table, so a global install would make every later mint order-dependent. `dexRead` only reads
 * the mod's tables (dexInstall.js:89-99); the props are `dexProperties`' mod-loaded answer (dexInstall.js:121-126).
 * ASSUMPTION M40: the posture is the boot's - UPSTREAM_BOOT (Enemy Expansion and Meaner Monsters at their
 * shipped defaults, so MUDEX's tables are read too: dexInstall.js:190) and Roleplay & Realism: Items'
 * realisticEnemyEquipment at its shipped default (true), the arm's own live gate
 * (combat/rriEnemyEquipment.js:246). The target carries no boot field; a posture other than the shipped
 * defaults is not modelled.
 */
function bootedEquipmentAssigner() {
  const mudex = UPSTREAM_BOOT.enemyExpansion === true && UPSTREAM_BOOT.meanerMonsters === true;
  const read = dexRead({ mudex, log: () => {} }); // the oracle's own read (upstreamBodyWorker.mjs:34 logs nothing)
  const propsOf = (id) => read.classic.get(Number(id))?.props ?? read.enemies.get(Number(id))?.props ?? null;
  return createDexEquipmentAssigner(propsOf);
}

/**
 * Roll the game's own enemy loadout and wear its armour/shield (`equipmentVariantFor` +
 * `assignEnemyStartingEquipment`), the pair `scenes/hostCombat.js` `equipEnemy` performs at a
 * spawn. The delegate is the one the client's boot installs (Enemy Expansion's copy of Roleplay &
 * Realism's class arm, `bootedEquipmentAssigner` above), taken per call: the registry the game sets
 * stays untouched, so no other mint changes. A monster outside the game's orc/centaur table, or a
 * class the variant roll declines, stays bare - it gets no invented gear. The ArmorValues pass is
 * the game's (`enemyArmorValues`), so the hit-chance half comes with it. The right-hand weapon a
 * class rolls is not placed: the target model's attacker is the player, and only worn defence reads it.
 */
export function gearEnemy(target, { playerLevel = target?.level ?? 1, rolls = Math.random } = {}) {
  if (!target) return target;
  const variant = equipmentVariantFor(target.careerIndex, !!target.isClass, rolls);
  if (variant == null) return target;
  const entity = { ...target, armor: target.armorValues?.[0] ?? 0 };
  // assignEnemyStartingEquipment's own order (enemyEquipment.js:346-347): the registered delegate's
  // answer, else ItemHelper's arm.
  const delegate = UPSTREAM_BOOT.enemyExpansion === true ? bootedEquipmentAssigner() : null;
  const eq = delegate?.(entity, variant, playerLevel, { rolls }) ?? assignEnemyEquipment(entity, variant, playerLevel, rolls);
  equipArmour(target, eq.armorPieces.map((a) => ({ templateIndex: a.piece, material: a.material })));
  target.armorValues = eq.armorValues;
  return target;
}

/**
 * pcaao.js pcaaoAttackDamage:1640-1700: a weapon below the target's required metal takes
 * `min(0.2 x (need - material), 0.9)` off; `softMaterialRequirements` false refuses the blow whole.
 * This is a damage multiplier, not a to-hit term, despite the field's name.
 */
export function materialRequirementMultiplier(target, weapon, { soft = true } = {}) {
  if (!weapon) return 1;
  const need = Number(target?.minMetalToHit);
  const material = Number(weapon.material);
  if (!Number.isFinite(need) || !Number.isFinite(material) || need < 0 || need <= material) return 1;
  if (!soft) return 0;
  const penalty = Math.min(fround((need - material) * fround(0.2)), fround(0.9));
  return fround(1 - penalty);
}

const targetStats = (career) => Object.fromEntries(
  STAT_KEYS.map((k) => [k, Number.isFinite(Number(career?.[k])) ? Number(career[k]) : 50]),
);

/** Every skill at one value, as the game's `skillsLevel` scalar is read for each (enemyEntity.js:111-114, :233). */
const skillsAtLevel = (level) => {
  const s = skillsLevel(level);
  return Object.fromEntries(SKILL_IDS.map((id) => [id, s]));
};

/** The target group a career/affinity names, for the existing slayer/path checks (not an enemy-type damage bonus). */
export function targetGroupOf({ careerIndex = -1, affinity = null, isClass = false } = {}) {
  if (isClass || affinity === 'Human') return 'humanoid';
  const g = enemyEntityGroup(careerIndex);
  return g === ENEMY_GROUPS.Undead ? 'undead'
    : g === ENEMY_GROUPS.Daedra ? 'daedra'
      : g === ENEMY_GROUPS.Humanoid ? 'humanoid'
        : g === ENEMY_GROUPS.Animals ? 'animal'
          : null;
}

/** The SHIPPED table row for a mobile type (characters/enemy/enemyBasics.js ENEMY_BASICS, before any boot edit).
 *  Not the row a foe is minted from - that is `mintRow` below. */
export const enemyRowOf = (mobileType) => ENEMY_BASICS[String(Number(mobileType))] ?? null;

// ── the body the game mints (Stage 2.8) ──────────────────────────
//
// characters/enemy/enemyEntity.js:160-233 makeEnemyEntity mints a foe from
//   editAtMint(pcaaoMeanerMonstersRow(applyMeanerMonsters(row)))          :178
// and those three edits depend on which mods the client booted. The client boots Daggerfall
// Enemy Expansion at every load (full checkout scenes/shared.js:1518 installEnemyExpansion,
// systems/enemyExpansion/dexInstall.js:183-224). With it loaded, Meaner Monsters' row and the
// overhaul's edit of it stand aside (systems/enemyExpansion/dexSwitches.js:28 meanerMonstersAlone;
// characters/meanerMonsters.js:194; combat/pcaaoMeanerMonsters.js:130-142), the classic rows are
// rewritten in place and at the mint by the mod's lines, and MUDEX's lines follow DEX's when
// Meaner Monsters is on as well (dexInstall.js:190). `dexClassicRow` is that row; vendor parity
// checks it equals the booted mint for every classic id.

/** A mod's `Enabled` as the game ships it (systems/modSettings.js MOD_SETTINGS). Online the room forces
 *  all three on whatever the player set (full checkout systems/online/onlineLane.js:367, :457-461
 *  ONLINE_ROOM_MOD_KEYS) and reads every other key at its shipped default (:574-577 ONLINE_WHOLE_MODS),
 *  so the offline client at its defaults and every online client boot the same rows. */
const shippedOn = (vendor) => MOD_SETTINGS[vendor]?.keys?.Enabled?.default === true;

/** The boot the minted rows assume (the assumptions register A15): the three mods as the game ships them. */
export const UPSTREAM_BOOT = Object.freeze({
  pcaao: shippedOn('pcaao'),
  meanerMonsters: shippedOn(MEANER_MONSTERS_VENDOR),
  enemyExpansion: shippedOn(DEX_VENDOR),
});

/**
 * The row a foe of `mobileType` is minted from under `boot`, over the pristine table
 * (enemyBasics.js VANILLA_ENEMY_BASICS - the boot edits ENEMY_BASICS in place, dexInstall.js:211-220).
 * Null where the table has no row.
 */
export function mintRow(mobileType, { boot = UPSTREAM_BOOT } = {}) {
  const id = Number(mobileType);
  const raw = Number.isInteger(id) ? (VANILLA_ENEMY_BASICS[String(id)] ?? null) : null;
  if (!raw) return null;
  const meaner = boot?.meanerMonsters === true;
  if (boot?.enemyExpansion === true) return dexClassicRow(id, raw, { mudex: meaner });
  return pcaaoMeanerMonstersRow(id, applyMeanerMonsters(id, raw, meaner), boot?.pcaao === true && meaner);
}

/** A level the game could hand a foe: a whole number from 1. Missing (undefined / null) is `null`;
 *  anything else - NaN, Infinity, a fraction, zero or below, text - is refused, never coerced. */
function wholeLevel(value, what) {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  if (!Number.isInteger(n) || n < 1) {
    const shown = typeof value === 'number' ? String(value) : JSON.stringify(value);
    throw new RangeError(`${what}: level ${shown} is not a whole level from 1 (no foe the game mints has level 0)`);
  }
  return n;
}

/**
 * makeEnemyEntity's body (enemyEntity.js:160-233) for one mobile, as plain target fields:
 *   level    a monster's is its minted row's (:212), whatever the player's; a class foe's is the player's
 *            (:202), and the Knight of the City Watch rolls Range(3, 7) more unless `exactLevel` (:207)
 *   armour   a monster's row armorValue x 5 on all seven parts; a class foe starts at 100 (:210, :215, :232)
 *   skills   skillsLevel(level), every skill (:233); minMetalToHit and affinity from the minted row (:257, :277)
 * A row with no level (mobile 39 is an empty slot) mints no usable body, and is refused.
 */
function mintedBody(mobileType, { playerLevel = null, career = null, rolls = null, exactLevel = false, boot = UPSTREAM_BOOT } = {}) {
  const id = Number(mobileType);
  const isClass = enemyEntityType(id) === 'class';
  if (!Number.isInteger(id) || (!isClass && enemyEntityType(id) !== 'monster')) {
    throw new RangeError(`enemy body: ${JSON.stringify(mobileType)} is not an enemy mobile type`);
  }
  const row = mintRow(id, { boot });
  if (!row) throw new RangeError(`enemy body: mobile ${id} has no enemy row`);
  let level;
  if (isClass) {
    level = wholeLevel(playerLevel, `class foe ${id}`);
    if (level == null) throw new RangeError(`class foe ${id}: a class foe is minted at the player's level; pass one (enemyEntity.js:202)`);
    if (id === KNIGHT_CITYWATCH_ID && !exactLevel) {
      if (typeof rolls !== 'function') throw new RangeError(`class foe ${id}: the watchman rolls Range(3, 7) levels; pass \`rolls\` or \`exactLevel\` (enemyEntity.js:207)`);
      level += 3 + floor(rolls() * 4);
    }
  } else {
    level = row.level;
    if (!Number.isInteger(level) || level < 1) {
      throw new RangeError(`enemy body: mobile ${id}'s row carries no level (${JSON.stringify(level)}); the game mints no usable body from it`);
    }
  }
  const armor = isClass ? 0 : (row.armorValue ?? 0) * 5;
  const affinity = row.affinity ?? null;
  const careerIndex = enemyCareerIndex(id);
  return {
    mobileType: id,
    isClass,
    careerIndex,
    career,
    affinity,
    group: targetGroupOf({ careerIndex, affinity, isClass }),
    level,
    stats: targetStats(career),
    skills: skillsAtLevel(level),
    armorValues: new Array(7).fill(isClass ? 100 : armor),
    minMetalToHit: row.minMetalToHit,
    basics: row,
  };
}
export const careerIndexOf = (mobileType) => enemyCareerIndex(Number(mobileType));
export const isClassEnemyOf = (mobileType) => enemyEntityType(Number(mobileType)) === 'class';

/** The default target fields, so a reference foe, a boss and an enemy row share one shape. */
export function makeTarget(fields = {}) {
  const t = {
    isPlayer: false,
    isClass: false,
    level: 1,
    // The level the game's enemy-type term reads (`target.level` upstream). It is normally the
    // same as `level`; the Breach stand-in is the exception (a content level 45, a body level 21).
    combatLevel: null,
    mobileType: null,
    careerIndex: -1,
    career: null,
    affinity: null,
    group: null,
    stats: Object.fromEntries(STAT_KEYS.map((k) => [k, 50])),
    skills: {},
    armorValues: new Array(7).fill(0),
    equip: { slots: {} },
    minMetalToHit: -1,
    // spareGear is upstream's RELAY stand-in flag (world/gate/gateBoss.js:161), not the ordinary-foe default.
    spareGear: false,
    health: 100,
    maxHealth: 100,
    // Target-side spell state (Stage 3.5.1): the CWS resolver reads the same `activeEffects` shapes upstream's
    // applySpell does (spellResistance / spellReflection / elementalResistance / spellAbsorption).
    activeEffects: [],
    ...fields,
  };
  if (t.combatLevel == null) t.combatLevel = t.level ?? 1;
  return t;
}

/**
 * A target built as the game mints the foe (`mintedBody` above). `career` is optional: the
 * ENEMY*.CFG/CLASS*.CFG career is what holds the stats and tolerance bytes. The vendored snapshot has
 * no MONSTER.BSA loader, so a caller that has a career supplies it; `null` is the honest "career not
 * loaded" value (as `bossStandIn` passes null for the gate boss).
 *
 * `level` (or its upstream name `playerLevel`):
 *   - a class foe: the player's level it is minted at - required, a whole number from 1;
 *   - a monster: omitted or null, the minted row's level (the game ignores the player's level for a
 *     monster, enemyEntity.js:212). A different whole level is a scenario OVERRIDE of a body the game
 *     never mints; the target says so (`levelSource: 'override'`), and no differential may use one.
 * Anything that is not a whole level from 1 is refused rather than coerced (F6: `Number(null)` was 0).
 * `rolls` / `exactLevel` answer the City Watch knight's level roll (mobile 146).
 */
export function enemyTarget(mobileType, {
  level = undefined,
  playerLevel = undefined,
  career = null,
  armorValues = null,
  health = 100,
  maxHealth = null,
  rolls = null,
  exactLevel = false,
  boot = UPSTREAM_BOOT,
  ...over
} = {}) {
  const asked = wholeLevel(level, `enemyTarget(${mobileType})`);
  const handed = wholeLevel(playerLevel, `enemyTarget(${mobileType})`);
  if (asked != null && handed != null && asked !== handed) {
    throw new RangeError(`enemyTarget(${mobileType}): level ${asked} and playerLevel ${handed} disagree`);
  }
  const given = asked ?? handed;
  const id = Number(mobileType);
  const isClass = enemyEntityType(id) === 'class';
  const body = mintedBody(id, { playerLevel: isClass ? given : 1, career, rolls, exactLevel, boot });
  const override = !isClass && given != null && given !== body.level;
  const lvl = override ? given : body.level;
  return makeTarget({
    ...over,
    ...body,
    level: lvl,
    levelSource: isClass ? 'player' : override ? 'override' : 'mint',
    skills: override ? skillsAtLevel(lvl) : body.skills,
    armorValues: armorValues ?? body.armorValues,
    spareGear: false, // an ordinary enemy wears its gear; only a relay stand-in sets the flag
    health,
    maxHealth: maxHealth ?? health,
  });
}

/**
 * The relay's boss body (full checkout world/gate/gateBoss.js:151-170 bossStandIn, vendored): the foe
 * minted for `mobileType` at player level 1 with no career, then the stand-in's own law - every metal
 * bites (`minMetalToHit` 0, :153), BOSS_ARMOR on all seven parts (:106, :154-155), no wear (:161).
 * The one body for every relay boss: the Breach's Valkynaz Ruhn (31), the Sky-ketch Tonal Warden
 * (full checkout scenes/ketch/ketchFight.js:57, :348) and the Abyss Brass Remnant
 * (scenes/superDungeon/sdRemnant.js:97, :529), both 36. Its level is the minted row's, so the combat
 * level is the body's, never the content's.
 */
export function standInTarget(mobileType, { boot = UPSTREAM_BOOT } = {}) {
  const body = mintedBody(mobileType, { playerLevel: 1, career: null, rolls: () => 0.5, boot });
  return makeTarget({
    ...body,
    levelSource: 'mint',
    relayBody: true, // a body the relay runs: a follow-up blow (Many Endings) is OWED into the next claim, not a hit of its own
    minMetalToHit: 0,
    armorValues: new Array(7).fill(BOSS_ARMOR),
    spareGear: true,
  });
}
