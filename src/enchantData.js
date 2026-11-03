/*
 * dfo-dps - the item maker's enchantment costs and picker rules.
 *
 * Copied from the game's systems/enchantmentCatalogue.js: the cost table
 * is DFU's own (a POWER prices positive, a SIDE EFFECT negative), and the
 * picker flags and exclusions are the item maker's. The item templates'
 * enchantmentPoints come from vendor/enchanting/itemTemplates.json.
 */
import fs from 'node:fs';
import { SKILL_NAMES } from './data.js';

const SKILL_COUNT = SKILL_NAMES.length;
export const PARAM_NONE = -1;

/** DFU's EnchantmentTypes cost tables, verbatim. */
export const ENCHANTMENT_COSTS = Object.freeze({

  // --- indexed BY ClassicParam (0..n-1) ---
  BadReactionsFrom: { costs: [-120, -80, -120], labels: ['Humanoids', 'Animals', 'Daedra'] },
  BadRepWith: {
    costs: [-1000, -1000, -1000, -1000, -1000, -5000],
    labels: ['Commoners', 'Merchants', 'Scholars', 'Nobility', 'Underworld', 'All'],
  },
  ExtraSpellPts: {
    costs: [500, 500, 500, 500, 200, 200, 200, 700, 800, 900, 1000],
    labels: [
      'During Winter',
      'During Spring',
      'During Summer',
      'During Fall',
      'During Full Moon',
      'During Half Moon',
      'During New Moon',
      'Near Undead',
      'Near Daedra',
      'Near Humanoids',
      'Near Animals',
    ],
  },
  GoodRepWith: {
    costs: [1000, 1000, 1000, 1000, 1000, 5000],
    labels: ['Commoners', 'Merchants', 'Scholars', 'Nobility', 'Underworld', 'All'],
  },
  HealthLeech: { costs: [-4000, -500, -200], labels: ['Whenever used', 'Unless used daily', 'Unless used weekly'] },
  ImprovesTalents: { costs: [500, 600, 600], labels: ['Hearing', 'Athleticism', 'Adrenaline Rush'] },
  IncreasedWeightAllowance: { costs: [400, 600], labels: ['25% additional', '50% additional'] },
  ItemDeteriorates: { costs: [-3000, -1500, -500], labels: ['all the time', 'in sunlight', 'in holy places'] },
  LowDamageVs: { costs: [-800, -900, -1000, -1200], labels: ['Undead', 'Daedra', 'Humanoid', 'Animals'] },
  PotentVs: { costs: [800, 900, 1000, 1200], labels: ['Undead', 'Daedra', 'Humanoid', 'Animals'] },
  RegensHealth: { costs: [4000, 3000, 3000], labels: ['all the time', 'in sunlight', 'in darkness'] },
  // DRAGON-SOUL (FIELD BUGS 2026-10-11, the owner: "Fuck matching DFU."): the Dragonling every encounter spawns (34)
  // binds as the quest's (40) does, -5000 - DFU priced it at nothing, a soul the trap took and the picker named
  // "Dragonling" beside the one worth five thousand. A departure (Port-Ledger A, DRAGON-SOUL); its SoulPts, the gold a
  // soul adds to a shop's price, stay DFU's
  SoulBound: {
    costs: [
      0, -10, -20, 0, 0, 0, 0, -10, -30, -90, -100, 0, -10, -30, -140, 0, -30, 0, -300, -100, 0, -30, -30, -300, -10,
      -500, -500, -100, -700, -1500, -1000, -8000, -1000, -2500, -5000, -300, -300, -300, -300, 0, -5000, -100, -100,
    ],
  },
  UserTakesDamage: { costs: [-6000, -1000], labels: ['in sunlight', 'in holy places'] },
  VampiricEffect: { costs: [2000, 1000], labels: ['at range', 'when strikes'] },

  // --- ONE cost, minted at ClassicParam -1 ---
  AbsorbsSpells: { cost: 1500 },
  ExtraWeight: { cost: -100 },
  FeatherWeight: { cost: 100 },
  RepairsObjects: { cost: 900 },
  StrengthensArmor: { cost: 700 },
  WeakensArmor: { cost: -700 },

  // --- one FLAT cost over a param DOMAIN ---
  EnhancesSkill: { cost: 900, domain: SKILL_COUNT },

  // --- keyed by classic SPELL id ---
  CastWhenUsed: {
    spells: [
      [4, 330, 'Levitate'],
      [5, 250, 'Light'],
      [6, 540, 'Invisibility'],
      [7, 480, "Wizard's Fire"],
      [8, 380, 'Shock'],
      [9, 480, 'Strength Leech'],
      [10, 1650, 'Free Action'],
      [18, 900, 'Open'],
      [11, 1560, 'Resist Cold'],
      [12, 1560, 'Resist Fire'],
      [13, 1560, 'Resist Shock'],
      [19, 1740, 'Wizard Lock'],
      [14, 470, 'Fireball'],
      [15, 1020, 'Cure Poison'],
      [16, 990, 'Ice Bolt'],
      [17, 1040, 'Shield'],
      [22, 1980, 'Spell Shield'],
      [23, 1530, 'Silence'],
      [24, 920, "Troll's Blood"],
      [20, 1420, 'Ice Storm'],
      [25, 840, 'Fire Storm'],
      [26, 1650, 'Resist Poison'],
      [33, 1020, 'Wildfire'],
      [27, 1300, 'Spell Drain'],
      [28, 2290, 'Far Silence'],
      [29, 1020, 'Toxic Cloud'],
      [34, 1610, 'Wizard Rend'],
      [30, 1930, "Shalidor's Mirror"],
      [31, 760, 'Lightning'],
      [35, 2140, "Medusa's Gaze"],
      [36, 3030, 'Force Bolt'],
      [32, 1750, "Gods' Fire"],
      [40, 130, 'Stamina'],
      [64, 360, 'Heal'],
      [60, 930, "Balyna's Antidote"],
      [94, 480, 'Recall'],
    ],
  },
  CastWhenHeld: {
    spells: [
      [37, 240, 'Slowfalling'],
      [39, 1230, 'Spell Resistance'],
      [41, 170, 'Water Walking'],
      [10, 1650, 'Free Action'],
      [42, 170, 'Water Breathing'],
      [11, 1560, 'Resist Cold'],
      [12, 1560, 'Resist Fire'],
      [26, 1560, 'Resist Poison'],
      [13, 1560, 'Resist Shock'],
      [6, 540, 'Invisibility'],
      [44, 210, 'Chameleon'],
      [45, 150, 'Shadow Form'],
      [46, 1720, 'Spell Reflection'],
      [24, 920, "Troll's Blood"],
      [47, 1720, 'Spell Absorption'],
      [4, 330, 'Levitate'],
      [49, 1590, 'Tongues'],
      [82, 1020, 'Orc Strength'],
      [83, 1200, 'Wisdom'],
      [84, 1200, 'Iron Will'],
      [85, 1200, 'Nimbleness'],
      [86, 1200, 'Feet of Notorgo'],
      [87, 1200, 'Fortitude'],
      [88, 1200, 'Charisma'],
      [89, 1200, 'Jack of Trades'],
    ],
  },
  CastWhenStrikes: {
    spells: [
      [50, 1620, 'Paralysis'],
      [53, 780, 'Hand of Sleep'],
      [52, 1380, 'Vampiric Touch'],
      [54, 930, 'Magicka Leech'],
      [56, 1830, 'Hand of Decay'],
      [33, 1020, 'Wildfire'],
      [20, 840, 'Ice Storm'],
      [25, 840, 'Fire Storm'],
      [16, 990, 'Ice Bolt'],
      [7, 480, "Wizard's Fire"],
      [55, 4230, 'Sphere of Negation'],
      [67, 1260, 'Energy Leech'],
    ],
  },});

export const ITEM_MAKER_FLAGS = Object.freeze({
  None: 0,
  AllowMultiplePrimaryInstances: 1,
  AllowMultipleSecondaryInstances: 2,
  AlphaSortSecondaryList: 4,
  WeaponOnly: 8,
});

export const ITEM_MAKER_EFFECT_FLAGS = Object.freeze({
  AbsorbsSpells: 1,
  BadReactionsFrom: 1,
  BadRepWith: 1,
  CastWhenHeld: 1 | 4,
  CastWhenStrikes: 1 | 4 | 8,
  CastWhenUsed: 1 | 4,
  EnhancesSkill: 1 | 4,
  ExtraSpellPts: 1,
  ExtraWeight: 0,
  FeatherWeight: 0,
  GoodRepWith: 1,
  HealthLeech: 1,
  ImprovesTalents: 1,
  IncreasedWeightAllowance: 0,
  ItemDeteriorates: 1,
  LowDamageVs: 1 | 8,
  PotentVs: 1 | 8,
  RegensHealth: 1,
  RepairsObjects: 1,
  SoulBound: 4,
  StrengthensArmor: 0,
  UserTakesDamage: 1,
  VampiricEffect: 1,
  WeakensArmor: 0,
});
export const hasItemMakerFlag = (type, flag) => ((ITEM_MAKER_EFFECT_FLAGS[type] ?? 0) & flag) !== 0;

export const ENCHANTMENT_EXCLUSIONS = Object.freeze({
  FeatherWeight: { pairs: ['ExtraWeight'] },
  ExtraWeight: { pairs: ['FeatherWeight'] },
  StrengthensArmor: { pairs: ['WeakensArmor'] },
  WeakensArmor: { pairs: ['StrengthensArmor'] },
  PotentVs: { sameParam: ['LowDamageVs'] },
  LowDamageVs: { sameParam: ['PotentVs'] },
  GoodRepWith: { sameParam: ['BadRepWith'], allParam: 5 },
  BadRepWith: { sameParam: ['GoodRepWith'], allParam: 5 },
});

export function isExclusiveTo(type, list = [], param) {
  const rule = ENCHANTMENT_EXCLUSIONS[type];
  if (!rule) return false;
  for (const e of list) {
    if (rule.allParam !== undefined && e.type === type) {
      if (e.param === rule.allParam) return true;
      if (param !== undefined && e.param !== rule.allParam && param === rule.allParam) return true;
    }
    if (rule.pairs?.includes(e.type)) return true;
    if (param !== undefined && rule.sameParam?.includes(e.type) && e.param === param) return true;
  }
  return false;
}

const PARAM_LABELS = Object.freeze({
  BadReactionsFrom: ['Humanoids', 'Animals', 'Daedra'],
  BadRepWith: ['Commoners', 'Merchants', 'Scholars', 'Nobility', 'Underworld', 'All'],
  GoodRepWith: ['Commoners', 'Merchants', 'Scholars', 'Nobility', 'Underworld', 'All'],
  ExtraSpellPts: ['During Winter', 'During Spring', 'During Summer', 'During Fall', 'During Full Moon', 'During Half Moon', 'During New Moon', 'Near Undead', 'Near Daedra', 'Near Humanoids', 'Near Animals'],
  HealthLeech: ['Whenever used', 'Unless used daily', 'Unless used weekly'],
  ImprovesTalents: ['Hearing', 'Athleticism', 'Adrenaline Rush'],
  IncreasedWeightAllowance: ['25% additional', '50% additional'],
  ItemDeteriorates: ['all the time', 'in sunlight', 'in holy places'],
  LowDamageVs: ['Undead', 'Daedra', 'Humanoid', 'Animals'],
  PotentVs: ['Undead', 'Daedra', 'Humanoid', 'Animals'],
  RegensHealth: ['all the time', 'in sunlight', 'in darkness'],
  UserTakesDamage: ['in sunlight', 'in holy places'],
  VampiricEffect: ['at range', 'when strikes'],
});

export const enchantmentName = (type) => String(type).replace(/([a-z])([A-Z])/g, '$1 $2');

export function enchantmentParamValues(type) {
  const row = ENCHANTMENT_COSTS[type];
  if (!row) return [];
  if (row.costs) return row.costs.map((_, i) => i);
  if (row.spells) return row.spells.map(([id]) => id);
  if (row.domain !== undefined) return Array.from({ length: row.domain }, (_, i) => i);
  return [PARAM_NONE];
}

export const defaultParam = (type) => enchantmentParamValues(type)[0];

export function enchantmentParamName(type, param) {
  if (param === PARAM_NONE) return '';
  const row = ENCHANTMENT_COSTS[type];
  if (!row) return String(param);
  if (type === 'EnhancesSkill') return SKILL_NAMES[param] ?? `Skill ${param}`;
  if (type === 'SoulBound') return `Soul ${param}`;
  if (row.spells) {
    const hit = row.spells.find(([id]) => id === param);
    return hit ? hit[2] : String(param);
  }
  return PARAM_LABELS[type]?.[param] ?? String(param);
}

export function enchantmentCost(type, param) {
  const row = ENCHANTMENT_COSTS[type];
  if (!row) return null;
  const p = param === undefined ? defaultParam(type) : param;
  if (row.costs) {
    const cost = row.costs[p];
    return Number.isInteger(p) && p >= 0 && cost !== undefined ? cost : null;
  }
  if (row.spells) {
    const hit = row.spells.find(([id]) => id === p);
    return hit ? hit[1] : null;
  }
  if (row.domain !== undefined) {
    return Number.isInteger(p) && p >= 0 && p < row.domain ? row.cost : null;
  }
  return p === PARAM_NONE ? row.cost : null;
}

export const isSideEffect = (type) => {
  const row = ENCHANTMENT_COSTS[type];
  const costs = row?.costs ?? row?.spells?.map(([, c]) => c) ?? (row ? [row.cost] : []);
  return costs.length > 0 && costs.every((c) => c <= 0) && costs.some((c) => c < 0);
};
export const isPower = (type) => {
  const row = ENCHANTMENT_COSTS[type];
  const costs = row?.costs ?? row?.spells?.map(([, c]) => c) ?? (row ? [row.cost] : []);
  return costs.length > 0 && costs.every((c) => c >= 0) && costs.some((c) => c > 0);
};

const TEMPLATES = JSON.parse(fs.readFileSync(new URL('../vendor/enchanting/itemTemplates.json', import.meta.url), 'utf8'));
const BY_INDEX = new Map(TEMPLATES.map((t) => [Number(t.index), t]));
export const itemTemplate = (index) => BY_INDEX.get(Number(index)) ?? null;
export const itemEnchantmentPoints = (index) => Number(itemTemplate(index)?.enchantmentPoints ?? 0);

/** The maker's cap on one item's list (SetEnchantments truncates past ten). */
export const ITEM_ENCHANTMENT_MAX = 10;
