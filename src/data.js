/*
 * dfo-dps - the data tables the combat model needs.
 *
 * Values are taken from the open-source DFO Online client
 * (Lattymoy/daggerfall-js-source, MIT) at the 2026-11-02 snapshot, and from
 * Daggerfall Unity's FormulaHelper (MIT, Daggerfall Workshop). See NOTICE.
 */

export const SOURCE = Object.freeze({
  repo: 'Lattymoy/daggerfall-js-source',
  commit: 'a3eb1605ea1dc391b691fe314377458a7e63e483',
  date: '2026-11-02',
  game: 'DFO Online',
  verified: '0.1.14516',
});

export const SKILLS = Object.freeze({
  Medical: 0,
  Etiquette: 1,
  Streetwise: 2,
  Jumping: 3,
  Orcish: 4,
  Harpy: 5,
  Giantish: 6,
  Dragonish: 7,
  Nymph: 8,
  Daedric: 9,
  Spriggan: 10,
  Centaurian: 11,
  Impish: 12,
  Lockpicking: 13,
  Mercantile: 14,
  Pickpocket: 15,
  Stealth: 16,
  Swimming: 17,
  Climbing: 18,
  Backstabbing: 19,
  Dodging: 20,
  Running: 21,
  Destruction: 22,
  Restoration: 23,
  Illusion: 24,
  Alteration: 25,
  Thaumaturgy: 26,
  Mysticism: 27,
  ShortBlade: 28,
  LongBlade: 29,
  HandToHand: 30,
  Axe: 31,
  BluntWeapon: 32,
  Archery: 33,
  CriticalStrike: 34,
});

export const SKILL_NAMES = Object.freeze([
  'Medical', 'Etiquette', 'Streetwise', 'Jumping', 'Orcish', 'Harpy', 'Giantish', 'Dragonish',
  'Nymph', 'Daedric', 'Spriggan', 'Centaurian', 'Impish', 'Lockpicking', 'Mercantile',
  'Pickpocket', 'Stealth', 'Swimming', 'Climbing', 'Backstabbing', 'Dodging', 'Running',
  'Destruction', 'Restoration', 'Illusion', 'Alteration', 'Thaumaturgy', 'Mysticism',
  'Short Blade', 'Long Blade', 'Hand-to-Hand', 'Axe', 'Blunt Weapon', 'Archery',
  'Critical Strike',
]);

export const RACES = Object.freeze({
  Breton: 1,
  Redguard: 2,
  Nord: 3,
  DarkElf: 4,
  HighElf: 5,
  WoodElf: 6,
  Khajiit: 7,
  Argonian: 8,
});

export const RACE_NAMES = Object.freeze({
  1: 'Breton', 2: 'Redguard', 3: 'Nord', 4: 'Dark Elf',
  5: 'High Elf', 6: 'Wood Elf', 7: 'Khajiit', 8: 'Argonian',
});

export const MATERIALS = Object.freeze([
  'Iron', 'Steel', 'Silver', 'Elven', 'Dwarven',
  'Mithril', 'Adamantium', 'Ebony', 'Orcish', 'Daedric',
]);

/** DaggerfallUnityItem.GetWeaponMaterialModifier, index = material 0..9. */
export const WEAPON_MATERIAL_MODIFIER = Object.freeze([-1, 0, 0, 1, 2, 3, 3, 4, 5, 6]);

/** DFU WeaponTypes, combat/fpsWeapon.js. */
export const WEAPON_TYPES = Object.freeze({
  LongBlade: 0,
  Staff: 2,
  Dagger: 4,
  Mace: 6,
  Flail: 8,
  Warhammer: 10,
  Battleaxe: 12,
  Bow: 14,
  Melee: 15,
  Werecreature: 16,
});

/**
 * The eighteen melee weapon templates (the arrow and bows are out of v1).
 * `min`/`max` are FormulaHelper.CalculateWeaponMin/MaxDamage, including the
 * port's BAL-ARCHERY bow rows (not used here). `weight` is the template's
 * baseWeight in kg. `type` is DFU's WeaponTypes row for the swing handling.
 */
export const WEAPONS = Object.freeze({
  113: { name: 'Dagger', min: 1, max: 6, skill: 'ShortBlade', type: 4, weight: 0.5, shortBlade: true, twoHanded: false },
  114: { name: 'Tanto', min: 1, max: 8, skill: 'ShortBlade', type: 0, weight: 0.75, shortBlade: true, twoHanded: false },
  115: { name: 'Staff', min: 1, max: 8, skill: 'BluntWeapon', type: 2, weight: 2, shortBlade: false, twoHanded: true },
  116: { name: 'Shortsword', min: 1, max: 8, skill: 'ShortBlade', type: 0, weight: 2.5, shortBlade: true, twoHanded: false },
  117: { name: 'Wakizashi', min: 1, max: 10, skill: 'ShortBlade', type: 0, weight: 2, shortBlade: true, twoHanded: false },
  118: { name: 'Broadsword', min: 1, max: 12, skill: 'LongBlade', type: 0, weight: 5, shortBlade: false, twoHanded: false },
  119: { name: 'Saber', min: 3, max: 12, skill: 'LongBlade', type: 0, weight: 3.75, shortBlade: false, twoHanded: false },
  120: { name: 'Longsword', min: 2, max: 16, skill: 'LongBlade', type: 0, weight: 4.5, shortBlade: false, twoHanded: false },
  121: { name: 'Katana', min: 3, max: 16, skill: 'LongBlade', type: 0, weight: 2.5, shortBlade: false, twoHanded: false },
  122: { name: 'Claymore', min: 2, max: 18, skill: 'LongBlade', type: 0, weight: 7.5, shortBlade: false, twoHanded: true },
  123: { name: 'Dai-katana', min: 3, max: 21, skill: 'LongBlade', type: 0, weight: 3.5, shortBlade: false, twoHanded: true },
  124: { name: 'Mace', min: 1, max: 12, skill: 'BluntWeapon', type: 6, weight: 4.5, shortBlade: false, twoHanded: false },
  125: { name: 'Flail', min: 2, max: 14, skill: 'BluntWeapon', type: 8, weight: 7, shortBlade: false, twoHanded: true },
  126: { name: 'Warhammer', min: 3, max: 18, skill: 'BluntWeapon', type: 10, weight: 7, shortBlade: false, twoHanded: true },
  127: { name: 'Battle Axe', min: 2, max: 12, skill: 'Axe', type: 12, weight: 6, shortBlade: false, twoHanded: false },
  128: { name: 'War Axe', min: 2, max: 16, skill: 'Axe', type: 12, weight: 7.5, shortBlade: false, twoHanded: true },
});

export const WEAPON_SKILL_IDS = Object.freeze(
  Object.fromEntries(Object.entries(WEAPONS).map(([i, w]) => [i, SKILLS[w.skill]])),
);

/** FormulaHelper.CalculateSwingModifiers, verbatim. */
export const SWING_MODS = Object.freeze({
  StrikeLeft: { damage: 0, toHit: 0 },
  StrikeUp: { damage: -4, toHit: 10 },
  StrikeDownRight: { damage: -2, toHit: 5 },
  StrikeDownLeft: { damage: 2, toHit: -5 },
  StrikeDown: { damage: 4, toHit: -10 },
});

export const SWINGS = Object.freeze([
  { key: 'StrikeLeft', label: 'Sideways' },
  { key: 'StrikeUp', label: 'Thrust up' },
  { key: 'StrikeDownRight', label: 'Down-right' },
  { key: 'StrikeDownLeft', label: 'Down-left' },
  { key: 'StrikeDown', label: 'Overhead' },
]);

/** FormulaHelper.CalculateStruckBodyPart (classic) and the overhaul's table. */
export const STRUCK_BODY_PARTS = Object.freeze([0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 6]);
export const PCAAO_BODY_PARTS = Object.freeze([0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6]);

export const BODY_PARTS = Object.freeze(['Feet', 'Legs', 'Hands', 'Left Arm', 'Right Arm', 'Head', 'Chest']);

/** characters/weaponStates.js SWING_HANDLING and friends. */
export const SWING_BASE_FRAME = (3 * (115 - 50)) / 980;
export const SWING_TEMPO_AT_0 = 1.4;
export const SWING_TEMPO_AT_100 = 0.6;
export const SWING_HEFT_FREE_KG = 2.5;
export const SWING_HEFT_PER_KG = 0.045;
export const SWING_HEFT_MAX = 0.35;
export const SWING_TWO_HANDED = 1.06;
export const SWING_FRAME_MIN = 0.09;
export const SWING_FRAME_MAX = 0.4;
export const SWING_HANDLING = Object.freeze({
  0: 1, 1: 1, 2: 0.97, 3: 0.97, 4: 0.9, 5: 0.9, 6: 1.03, 7: 1.03,
  8: 1.05, 9: 1.05, 10: 1.06, 11: 1.06, 12: 1.05, 13: 1.05,
  15: 0.9, 16: 0.9,
});
export const SWING_SHORT_BLADE = SWING_HANDLING[4];

/** systems/bossTraits.js constants. */
export const WARD_SHARE = 0.3;
export const WARD_REGROW_S = 10;
export const WARD_REFILL_S = 4;
export const WEAPON_RESIST_SHARE = 0.5;
export const RESIST_SHARE = 0.25;
export const CURB_SHARE = 0.05;
export const WRATH_AFTER_S = 75;
export const WRATH_X = 1.6;
export const THORN_SHARE = 0.2;
export const BOSS_TRAITS = Object.freeze([
  'warded', 'flameproof', 'frostproof', 'venomproof', 'stormproof', 'spellproof',
  'bladeturning', 'stoneskin', 'curbing', 'wrathful', 'thorned',
]);
export const BOSS_TRAIT_TEXT = Object.freeze({
  warded: 'A ward of 30% of its health takes every blow first; it grows back after 10s without a hit.',
  flameproof: 'Fire spells do a quarter of their damage.',
  frostproof: 'Frost spells do a quarter of their damage.',
  venomproof: 'Poison spells do a quarter of their damage.',
  stormproof: 'Shock spells do a quarter of their damage.',
  spellproof: 'Magic spells do a quarter of their damage.',
  bladeturning: 'Blades and arrows do half damage. Blunt weapons and fists do full.',
  stoneskin: 'Blunt weapons and fists do half damage. Blades do full.',
  curbing: 'No single blow takes more than 5% of its health (minimum 1).',
  wrathful: 'It hits 1.6x harder 75 seconds after the first player blow.',
  thorned: 'Some of every weapon blow comes back at the striker.',
});

/** systems/martialPaths.js passives, with the numbers from martialPowers.js. */
export const MARTIAL_PATHS = Object.freeze({
  blademaster: { name: 'Blademaster', passive: 'Flowing Steel', text: '+3% damage per landed blow, up to 5 stacks (4s).' },
  warblade: { name: 'Warblade', passive: 'War Rhythm', text: '+15% swing pace for 10s after a kill.' },
  vanguard: { name: 'Vanguard', passive: 'Iron Discipline', text: 'Enemy blows deal 10% less damage.' },
  ranger: { name: 'Ranger', passive: "Hunter's Instinct", text: '+20% damage to beasts.' },
  bladedancer: { name: 'Skirmisher', passive: "Dancer's Step", text: 'One enemy blow in 10 misses.' },
  bloodletter: { name: 'Bloodletter', passive: 'Bloodlust', text: 'Each kill restores 5% health.' },
  cutthroat: { name: 'Cutthroat', passive: 'Cheap Shot', text: '+25% damage to enemies that have not noticed you.' },
  assassin: { name: 'Assassin', passive: 'Opening Strike', text: '+30% on the first blow at each enemy.' },
  shadowdancer: { name: 'Shadowdancer', passive: 'Light Step', text: '+10 Agility and +15 Dodging.' },
  juggernaut: { name: 'Juggernaut', passive: 'Stand Firm', text: 'Heal at low health, once every 3 minutes.' },
  woodsman: { name: 'Woodsman', passive: 'Tireless', text: '+15 fatigue on each kill.' },
  berserker: { name: 'Berserker', passive: 'Frenzy', text: '+20% damage and +10% pace below 50% health.' },
  crusader: { name: 'Crusader', passive: 'Purge', text: '+20% damage to undead and daedra.' },
  brawler: { name: 'Brawler', passive: 'Grit', text: 'Regenerate a little health and fatigue each round.' },
  windrunner: { name: 'Windrunner', passive: 'Windborne', text: '+10 Speed, +15 Running, +15 Jumping.' },
});

export const TARGET_PRESETS = Object.freeze([
  { id: 'soft', label: 'Soft monster', isClass: false, armorValue: 6, note: 'rats, imps and the early bestiary' },
  { id: 'tough', label: 'Tough monster', isClass: false, armorValue: 0, note: 'the middle of the bestiary' },
  { id: 'armoured', label: 'Armored monster', isClass: false, armorValue: -10, note: 'daedra and ancient undead' },
  { id: 'human', label: 'Human foe', isClass: true, armorValue: null, note: 'a warrior in mail, flat 60' },
]);
