/*
 * dfo-dps - the level-45 long-blade theory character and its live caps.
 *
 * Everything here is the game's own arithmetic:
 *   pcaao.js          /10 Strength, two-handed x2
 *   weaponMastery.js  past-100 climb, gear skill 0.44%/point capped at 320%
 *   combatStats.js    the hit and critical model
 *   swingLaw.js       cadence
 *   lootRarity.js     the affix bands and the skill-line maximum
 *
 * The character is deliberately at the live ceiling, not at a community
 * benchmark: attributes 100, a mastered Long Blade and Critical Strike at
 * raw 200, a Daedric Dai-katana, and a chosen number of gear skill lines.
 */
import { SKILLS, WEAPONS } from './data.js';
import { characterFromSave } from './save.js';

export const THEORY_LEVEL = 45;
export const THEORY_STATS = Object.freeze({
  strength: 100, intelligence: 100, willpower: 100, agility: 100,
  endurance: 100, personality: 100, speed: 100, luck: 100,
});

export const THEORY_RACES = Object.freeze({
  breton: 1, redguard: 2, nord: 3, darkelf: 4,
  highelf: 5, woodelf: 6, khajiit: 7, argonian: 8,
});

/** The six long blades: Broadsword, Saber, Longsword, Katana, Claymore, Dai-katana. */
export const LONG_BLADES = Object.freeze([118, 119, 120, 121, 122, 123]);
export const DEFAULT_BLADE = 123;

/** A legendary skill line's maximum (lootRarity.js AFFIX_RANGES.skill.legendary). */
export const GEAR_LINE_MAX = 30;
/** A legendary damage affix's maximum on a weapon. */
export const DAMAGE_AFFIX_MAX = 40;
/** weaponMastery.js: gear skill stops adding at 320%, which is 727.27 points. */
export const GEAR_MASTERY_CAP = 320;
export const GEAR_MASTERY_POINTS = Math.ceil(GEAR_MASTERY_CAP / 0.44);

/**
 * The practical line caps, from lootRarity.js:
 *   - Long Blade can only be rolled by the weapon (its own skill) and the
 *     seven armour pieces (BODY_KIN). Jewellery's JEWEL_KIN has Critical
 *     Strike but not Long Blade, and clothing rolls the street skills.
 *   - Critical Strike can be rolled by the weapon (STRIKE_KIN), all seven
 *     armour pieces and all ten jewellery slots (JEWEL_KIN).
 * A rare item has at most four lines and a kind's params may not repeat, so
 * one Long Blade line and one Critical Strike line per item is the ceiling.
 */
export const GEAR_LB_LINES = 8;
export const GEAR_CS_LINES = 18;
export const GEAR_SKILL_LINES = GEAR_LB_LINES + GEAR_CS_LINES;

/** The character. `gearLB` / `gearCS` are gear skill points on Long Blade and Critical Strike. */
export function theoryCharacter({
  level = THEORY_LEVEL,
  race = 'darkelf',
  blade = DEFAULT_BLADE,
  material = 9,
  gearLB = 0,
  gearCS = 0,
  rawBlade = 200,
  rawCrit = 200,
  rawBackstab = 200,
  damagePct = 0,
  vampire = false,
} = {}) {
  const raceId = typeof race === 'number' ? race : (THEORY_RACES[String(race).toLowerCase()] ?? THEORY_RACES.darkelf);
  const templateIndex = Number(blade);
  if (!WEAPONS[templateIndex] || WEAPONS[templateIndex].skill !== 'LongBlade') {
    throw new Error(`theory expects a long-blade template, got ${blade}`);
  }
  const skills = Array.from({ length: 35 }, () => 100);
  skills[SKILLS.LongBlade] = rawBlade;
  skills[SKILLS.CriticalStrike] = rawCrit;
  skills[SKILLS.Backstabbing] = rawBackstab;
  const weapon = {
    name: WEAPONS[templateIndex].name,
    group: 'Weapons',
    templateIndex,
    material,
    maxCondition: 100,
    currentCondition: 100,
    equipSlot: 19,
    affixes: damagePct > 0 ? [{ id: 'damage', value: damagePct }] : [],
  };
  const activeEffects = vampire
    ? [{ kind: 'racialOverride', racial: 'vampirism', skillMods: { [SKILLS.HandToHand]: 30, [SKILLS.CriticalStrike]: 30 } }]
    : [];
  const save = {
    name: 'Theory',
    level,
    raceId,
    race: Object.keys(THEORY_RACES).find((k) => THEORY_RACES[k] === raceId) ?? 'Dark Elf',
    gender: 'male',
    stats: { ...THEORY_STATS },
    skills,
    health: 700,
    maxHealth: 700,
    reflexes: 2,
    career: {
      name: 'Longblade',
      // Bit 1 (LongBlade) in the expertise nibble: pcaao proficiency damage and to-hit.
      weaponArmorShieldsBitfield: 2 << 16,
      abilityFlagsAndSpellPointsBitfield: 0,
      attackModifierFlags: 0,
    },
    items: [weapon],
    activeEffects,
    masterSkills: true,
    masteredSkills: [SKILLS.LongBlade, SKILLS.CriticalStrike, SKILLS.Backstabbing],
    martialPath: null,
    _mods: { stats: {}, skills: { [SKILLS.LongBlade]: gearLB, [SKILLS.CriticalStrike]: gearCS } },
    _enchantMods: { skillMods: {}, chanceToHitMod: 0 },
  };
  const ch = characterFromSave(save, { online: true });
  ch.name = 'Level 45 theory long blade';
  return ch;
}

/** The character rebuilt around one long-blade template, for the weapon table. */
export function theoryBlade(character, templateIndex, material = 9) {
  const c = JSON.parse(JSON.stringify(character));
  const weapon = {
    ...(c.weapon ?? {}),
    name: WEAPONS[templateIndex].name,
    templateIndex,
    material,
    affixes: (c.weapon?.affixes ?? []).filter((a) => a?.id === 'damage'),
  };
  c.weapon = weapon;
  c.items = [weapon];
  c.worn = [weapon];
  return c;
}

/** The cap sheet, in the order it pays to push. */
export const THEORY_CAPS = Object.freeze([
  {
    channel: 'Attributes',
    cap: '100',
    formula: 'liveStat clamps 0..100',
    note: 'A hard live cap. Anything past 100 on the character sheet is wasted; gear stat affixes are dead once the bar reads 100.',
  },
  {
    channel: 'Raw Long Blade',
    cap: '200 (mastered)',
    formula: 'effectiveSkill(200) = 140',
    note: 'Raw 200 is the hard skill ceiling. The softcap turns 100..200 into 40 effective points, plus the mastery milestones.',
  },
  {
    channel: 'Raw Critical Strike',
    cap: '200 (mastered)',
    formula: 'effectiveSkill(200) = 140',
    note: 'Without the mastered flag the raw value stops at 100. Critical Strike is a primary skill for this build.',
  },
  {
    channel: 'Raw Backstabbing',
    cap: '200 (mastered)',
    formula: 'effectiveSkill(200) = 140',
    note: 'Backstab chance is the effective skill in percent, clamped at 100, so raw 200 already guarantees the x3 from behind.',
  },
  {
    channel: 'Gear Long Blade',
    cap: `${GEAR_LB_LINES} lines = 240 points (+105.6%)`,
    formula: 'min(320, gearSkill x 0.44); formula cap at 728 points',
    note: `The formula tops out at +320%, but only the weapon and seven armour pieces can roll Long Blade, so 8 legendary lines (240 points, +105.6%) is the practical ceiling. Critical Strike is the only channel that can use a larger budget.`,
  },
  {
    channel: 'Gear Critical Strike',
    cap: `${GEAR_CS_LINES} lines = 540 points`,
    formula: 'chance = trunc(skill / 2); mult = trunc(skill / 5) x 0.05 + 1',
    note: 'The weapon, seven armour pieces and ten jewellery slots can roll it. Chance reaches 100% at 199 skill; every point past that adds 0.01 to the multiplier, so all 18 lines keep paying.',
  },
  {
    channel: 'Gear skill lines',
    cap: `${GEAR_SKILL_LINES} lines = 780 points`,
    formula: '8 Long Blade + 18 Critical Strike',
    note: '18 combat pieces x up to four affixes = 72 lines of room; the per-skill parameter rule is what binds, not the affix count. This is the whole damage-affix budget for these two skills.',
  },
  {
    channel: 'Weapon damage affix',
    cap: `${DAMAGE_AFFIX_MAX}%`,
    formula: 'AFFIX_RANGES.damage.legendary = 20..40',
    note: 'Only a weapon can roll it, so 40% is the whole affix channel. It multiplies the weapon roll before mastery and criticals.',
  },
  {
    channel: 'Hit chance',
    cap: '97%',
    formula: 'clamp(..., 3, 97)',
    note: 'At 140 Long Blade plus gear the base already clears the cap; extra skill cannot buy more hit chance.',
  },
  {
    channel: 'Critical chance',
    cap: '100%',
    formula: 'chance = trunc(skill / (4 - luckTerm))',
    note: 'Luck 100 gives luckTerm 2, so 199 Critical Strike reaches 100%. Further critical points buy multiplier, not chance.',
  },
]);
