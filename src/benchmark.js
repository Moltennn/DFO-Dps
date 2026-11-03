/*
 * dfo-dps - the community reference fixture.
 *
 * Mirrors the 2026-10-28 "Full Weapon DPS Comparison" fixture:
 *   - level 45 Redguard Haarvenu vampire
 *   - STR/AGI/END/SPD/LUC 100, INT 99, WIL/PER 40
 *   - Daedric weapon, full condition, RRI weapon balance and swing law
 *   - no career Expertise, no martial path, no backstab, no procs
 *   - tough monster of the same level, armour 0
 *   - raw trained skill 100 or 200, plus 0 / 150 / 300 gear to the family
 *     and to Critical Strike; +30 vampire Hand-to-Hand and Critical Strike
 */
import { RRI_WEAPON_DAMAGE, SKILLS, WEAPONS } from './data.js';
import { analyze, referenceFoe } from './model.js';

export const REFERENCE = Object.freeze({
  level: 45,
  raceId: 2, // Redguard
  stats: Object.freeze({
    strength: 100, intelligence: 99, willpower: 40, agility: 100,
    endurance: 100, personality: 40, speed: 100, luck: 100,
  }),
  family: Object.freeze({
    HandToHand: SKILLS.HandToHand,
  }),
});

export const BENCHMARK_EXPECTED = Object.freeze({
  'Hand-to-Hand': [98, 157, 440, 829],
  Dagger: [59, 98, 273, 522],
  Tanto: [60, 100, 281, 537],
  Shortsword: [61, 105, 297, 565],
  Wakizashi: [63, 108, 304, 580],
  Broadsword: [72, 133, 336, 604],
  Saber: [74, 135, 342, 615],
  Longsword: [75, 137, 346, 623],
  Katana: [78, 143, 363, 653],
  Claymore: [83, 152, 385, 692],
  'Dai-katana': [87, 160, 406, 728],
  'Battle Axe': [77, 102, 288, 548],
  'War Axe': [88, 116, 330, 625],
  Staff: [85, 201, 473, 814],
  Mace: [74, 174, 409, 706],
  Flail: [81, 191, 450, 775],
  Warhammer: [82, 195, 458, 790],
});

const FAMILY_OF = Object.freeze({
  113: SKILLS.ShortBlade, 114: SKILLS.ShortBlade, 116: SKILLS.ShortBlade, 117: SKILLS.ShortBlade,
  118: SKILLS.LongBlade, 119: SKILLS.LongBlade, 120: SKILLS.LongBlade, 121: SKILLS.LongBlade,
  122: SKILLS.LongBlade, 123: SKILLS.LongBlade,
  127: SKILLS.Axe, 128: SKILLS.Axe,
  115: SKILLS.BluntWeapon, 124: SKILLS.BluntWeapon, 125: SKILLS.BluntWeapon, 126: SKILLS.BluntWeapon,
});

/** The reference character for one weapon row. `weapon` null = fists. */
export function benchmarkCharacter({ templateIndex = null, raw = 200, gear = 0 } = {}) {
  const family = templateIndex == null ? SKILLS.HandToHand : (FAMILY_OF[templateIndex] ?? SKILLS.HandToHand);
  const skills = Array.from({ length: 35 }, () => 100);
  skills[family] = raw;
  skills[SKILLS.CriticalStrike] = raw;
  const item = templateIndex == null ? null : {
    name: WEAPONS[templateIndex]?.name ?? 'Weapon',
    group: 'Weapons', templateIndex, material: 9,
    maxCondition: 12800, currentCondition: 12800, equipSlot: 19,
  };
  const mastered = [family, SKILLS.CriticalStrike];
  const ch = {
    name: 'Benchmark', level: 45, raceId: 2, race: 'Redguard', gender: 'male',
    career: { weaponArmorShieldsBitfield: 0, abilityFlagsAndSpellPointsBitfield: 0, attackModifierFlags: 0 },
    reflexes: 2, health: 700, maxHealth: 700,
    stats: { ...REFERENCE.stats }, skills,
    activeEffects: [{ kind: 'racialOverride', racial: 'vampirism', skillMods: { [SKILLS.HandToHand]: 30, [SKILLS.CriticalStrike]: 30 } }],
    items: item ? [item] : [],
    equipSlots: item ? { 19: item } : {},
    weapon: item,
    martialPath: null,
    masterSkills: true, masteredSkills: mastered, online: true,
    _mods: { stats: {}, skills: gear ? { [family]: gear, [SKILLS.CriticalStrike]: gear } : {} },
    _enchantMods: { skillMods: {}, chanceToHitMod: 0 },
    legendaries: [],
    saveSlot: null, saveFile: null,
  };
  return ch;
}

export function benchmarkRow(templateIndex, raw = 200, gear = 0, { rri = true, healthShare = 1, mode = 'doc' } = {}) {
  const ch = benchmarkCharacter({ templateIndex, raw, gear });
  return analyze(ch, {
    target: referenceFoe(45, 'tough'), core: 'overhaul',
    rri, critDamage: true, passiveOn: false, backstabUptime: 0, firstBlow: false, healthShare,
    ...(mode === 'doc' ? { classicStrength: true, twoHandedStrMod: 15 } : {}),
  });
}

export function benchmarkTable({ rawValues = [100, 200, 200, 200], gears = [0, 0, 150, 300], mode = 'doc' } = {}) {
  const rows = [];
  const add = (label, templateIndex) => {
    const values = rawValues.map((raw, i) => benchmarkRow(templateIndex, raw, gears[i], { mode }).dps);
    rows.push({ label, values, expected: BENCHMARK_EXPECTED[label] ?? null });
  };
  add('Hand-to-Hand', null);
  for (const idx of [113, 114, 116, 117, 118, 119, 120, 121, 122, 123, 127, 128, 115, 124, 125, 126]) {
    add(WEAPONS[idx].name, idx);
  }
  return rows;
}

/** Full HP-to-zero fight for the families whose damage changes at 50% HP.
 * Equal HP in each half, no overkill: the harmonic mean of the two rates. */
export function benchmarkFull(mode = 'doc') {
  const ids = [null, 123, 128, 115, 126, 117];
  const names = { null: 'Hand-to-Hand', 123: 'Dai-katana', 128: 'War Axe', 115: 'Staff', 126: 'Warhammer', 117: 'Wakizashi' };
  return ids.map((id) => {
    const healthy = benchmarkRow(id, 200, 300, { healthShare: 1, mode }).dps;
    const below = benchmarkRow(id, 200, 300, { healthShare: 0.49, mode }).dps;
    const full = healthy > 0 && below > 0 ? (2 * healthy * below) / (healthy + below) : 0;
    return { label: names[id], healthy, below, full };
  });
}
