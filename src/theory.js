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
 *
 * `starStats` / `starSkills` are the FIRMAMENT's channels. The tree caps an
 * attribute or combat skill channel at +15; an attribute gain also lifts the
 * live ceiling by that much (statMods.js FIRM-MAX), so Strength 100 + 15
 * reads 115. A skill's +15 sits ON TOP of effectiveSkill(200)=140, so the
 * formula reads 155 while the skill screen prints raw 200 + 15 = 215.
 */
import { SKILLS, WEAPONS } from './data.js';
import { characterFromSave } from './save.js';
import { perfectSockets } from './sockets.js';

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
/** Hand-to-Hand rolls on armour (BODY_KIN) and jewellery (JEWEL_KIN), never on a weapon. */
export const GEAR_H2H_LINES = 17;

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
  starStats = {},
  starSkills = {},
  starDamage = 0,
  sockets = [],
} = {}) {
  const raceId = typeof race === 'number' ? race : (THEORY_RACES[String(race).toLowerCase()] ?? THEORY_RACES.darkelf);
  const templateIndex = Number(blade);
  if (!WEAPONS[templateIndex]) {
    throw new Error(`theory expects a melee weapon template, got ${blade}`);
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
    sockets: Array.isArray(sockets) ? [...sockets] : [],
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
  const firmStats = {};
  for (const [k, v] of Object.entries(starStats ?? {})) {
    if (Number.isFinite(v) && v !== 0) firmStats[k] = Math.max(-15, Math.min(15, v));
  }
  const firmSkills = {};
  for (const [k, v] of Object.entries(starSkills ?? {})) {
    const id = Number(k);
    if (Number.isInteger(id) && id >= 0 && id < 35 && Number.isFinite(v) && v !== 0) {
      firmSkills[id] = Math.max(-15, Math.min(15, v));
    }
  }
  const skillMods = { ...firmSkills };
  skillMods[SKILLS.LongBlade] = (skillMods[SKILLS.LongBlade] ?? 0) + gearLB;
  skillMods[SKILLS.CriticalStrike] = (skillMods[SKILLS.CriticalStrike] ?? 0) + gearCS;
  // FIRM-MAX: only a positive gain lifts the ceiling; a price reduces the stat alone.
  const firmMax = Object.fromEntries(Object.entries(firmStats).filter(([, v]) => v > 0));
  save._mods = { stats: firmStats, statMax: firmMax, skills: skillMods };
  const ch = characterFromSave(save, { online: true });
  ch.firmamentDamagePct = Math.max(-20, Math.min(30, Number.isFinite(starDamage) ? starDamage : 0));
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
    sockets: perfectSockets(templateIndex),
  };
  c.weapon = weapon;
  c.items = [weapon];
  c.worn = [weapon];
  return c;
}

/** The same ceiling with bare fists: no weapon, Hand-to-Hand skill, its own gear channel. */
export function theoryFists({
  level = THEORY_LEVEL,
  race = 'darkelf',
  rawH2H = 200,
  rawCrit = 200,
  rawBackstab = 200,
  gearH2H = 0,
  gearCrit = 0,
  starStats = {},
  starSkills = {},
  starDamage = 0,
  vampire = false,
  wraps = false,
} = {}) {
  const raceId = typeof race === 'number' ? race : (THEORY_RACES[String(race).toLowerCase()] ?? THEORY_RACES.darkelf);
  const skills = Array.from({ length: 35 }, () => 100);
  skills[SKILLS.HandToHand] = rawH2H;
  skills[SKILLS.CriticalStrike] = rawCrit;
  skills[SKILLS.Backstabbing] = rawBackstab;
  const firmStats = {};
  for (const [k, v] of Object.entries(starStats ?? {})) {
    if (Number.isFinite(v) && v !== 0) firmStats[k] = Math.max(-15, Math.min(15, v));
  }
  const firmSkills = {};
  for (const [k, v] of Object.entries(starSkills ?? {})) {
    const id = Number(k);
    if (Number.isInteger(id) && id >= 0 && id < 35 && Number.isFinite(v) && v !== 0) {
      firmSkills[id] = Math.max(-15, Math.min(15, v));
    }
  }
  const skillMods = { ...firmSkills };
  skillMods[SKILLS.HandToHand] = (skillMods[SKILLS.HandToHand] ?? 0) + gearH2H;
  skillMods[SKILLS.CriticalStrike] = (skillMods[SKILLS.CriticalStrike] ?? 0) + gearCrit;
  const firmMax = Object.fromEntries(Object.entries(firmStats).filter(([, v]) => v > 0));
  const activeEffects = vampire
    ? [{ kind: 'racialOverride', racial: 'vampirism', skillMods: { [SKILLS.HandToHand]: 30, [SKILLS.CriticalStrike]: 30 } }]
    : [];
  const save = {
    name: 'Level 45 theory fists',
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
      name: 'Hand-to-Hand',
      weaponArmorShieldsBitfield: 4 << 16, // HandToHand proficiency flag
      abilityFlagsAndSpellPointsBitfield: 0,
      attackModifierFlags: 0,
    },
    items: [],
    activeEffects,
    masterSkills: true,
    masteredSkills: [SKILLS.HandToHand, SKILLS.CriticalStrike, SKILLS.Backstabbing],
    martialPath: null,
    _mods: { stats: firmStats, statMax: firmMax, skills: skillMods },
    _enchantMods: { skillMods: {}, chanceToHitMod: 0 },
  };
  const ch = characterFromSave(save, { online: true });
  ch.firmamentDamagePct = Math.max(-20, Math.min(30, Number.isFinite(starDamage) ? starDamage : 0));
  if (wraps) {
    ch.wraps = typeof wraps === 'object' ? wraps : {
      name: 'Hand Wraps', group: 'Weapons', templateIndex: 563, material: 0,
      maxCondition: 400, currentCondition: 400, equipSlot: 19,
      affixes: [{ id: 'damage', value: 40 }, { id: 'elemental', param: 'fire', value: 10 }],
      sockets: perfectSockets(563),
      enchantments: [{ type: 2, param: 25 }],
    };
  }
  ch.name = wraps ? 'Level 45 theory fists (wraps)' : 'Level 45 theory fists';
  return ch;
}

/** The cap sheet, in the order it pays to push. */
export const THEORY_CAPS = Object.freeze([
  {
    channel: 'Attributes',
    cap: '100 base, 115 with the Firmament',
    formula: 'liveStat clamps to 100 + statMax',
    note: 'A hard 100 base cap. The Firmament channel is +15 and its gain also lifts the live ceiling (statMax), so 100 + 15 = 115. A gear stat affix is a mod, not a statMax: it fills headroom the stars created, but cannot create it.',
  },
  {
    channel: 'Raw Long Blade',
    cap: '200 hard (sheet can print 200+mods)',
    formula: 'effectiveSkill(200) = 140',
    note: 'Raw 200 is the hard skill ceiling. The softcap turns 100..200 into 40 effective points, plus the mastery milestones. The Firmament +15 and gear skill sit ON TOP of the formula value, so the sheet can print 215 or 455 while the formula reads 155 or 395.',
  },
  {
    channel: 'Raw Critical Strike',
    cap: '200 hard (sheet can print 200+mods)',
    formula: 'effectiveSkill(200) = 140',
    note: 'Without the mastered flag the raw value stops at 100. Critical Strike is a primary skill for this build. The same post-cap mod channel applies.',
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
    channel: 'Firmament blow',
    cap: '+30% general, +50% with conditions',
    formula: 'firmamentLaw.js blowPct / BLOW_CAP',
    note: 'The sky\'s weapon-blow channels (weaponDmg, meleeDmg, longDmg and the foe-kind line) cap at +30% together; the unaware/rage conditions can take the total to +50%. It is a separate multiplier from gear skill and the weapon affix.',
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
