/*
 * test/harness/upstream.mjs - the pinned game implementation, as the oracle.
 *
 * Everything here reads vendor/upstream/<commit>/src (see tools/vendor-upstream.mjs
 * and docs/SOURCES.md). The vendored tree is the import closure of the combat
 * modules the simulator reimplements; a few edges that leave the combat graph
 * are inert stubs, and `assertVendoredParity` (tools/vendor-parity.mjs) proves
 * the pruned tree answers exactly as the full upstream checkout does.
 *
 * Two rules for everything in this file:
 *   1. Never hard-code a number that upstream exports - read it.
 *   2. Nothing here may fall back to this project's own implementation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT = path.resolve(HERE, '..', '..');
export const COMMIT = 'a3eb1605ea1dc391b691fe314377458a7e63e483';
export const VENDOR_DIR = path.join(PROJECT, 'vendor', 'upstream', 'a3eb1605');
export const SRC = path.join(VENDOR_DIR, 'src');

/** The modules the harness measures against, by short name. */
const MODULES = Object.freeze({
  combatStats: 'combat/combatStats.js',
  pcaao: 'combat/pcaao.js',
  formulas: 'combat/formulas.js',
  weaponStates: 'characters/weaponStates.js',
  anims: 'characters/anims.js',
  swingLaw: 'combat/swingLaw.js',
  handsLaw: 'combat/twoHands/handsLaw.js',
  bowBloom: 'combat/bowBloom.js',
  powerCeiling: 'systems/powerCeiling.js',
  entityMods: 'systems/entityMods.js',
  bossTraits: 'systems/bossTraits.js',
  // The blow-modifier registries register in module-evaluation order, and that order decides whether a
  // later percentage scales an earlier flat addition (systems/entityMods.js weaponBlowMods). This is the
  // order the gate's own host loads them in (scenes/dungeon.js: weaponMastery -> lootPowers ->
  // martialPowers -> firmamentPowers), so the oracle resolves an elemental affix where the fight does.
  weaponMastery: 'systems/weaponMastery.js',
  lootPowers: 'systems/loot/lootPowers.js',
  lootRarity: 'systems/loot/lootRarity.js',
  martialPowers: 'systems/martialPowers.js',
  martialPaths: 'systems/martialPaths.js',
  firmamentPowers: 'systems/firmamentPowers.js',
  statMods: 'systems/statMods.js',
  skills: 'systems/skills.js',
  skillSoftcap: 'systems/skillSoftcap.js',
  masterSkills: 'systems/masterSkills.js',
  equip: 'systems/equip.js',
  equipTable: 'characters/equipTable.js',
  weapons: 'characters/weapons.js',
  handWraps: 'characters/handWrapsIds.js',
  enemyEntity: 'characters/enemy/enemyEntity.js',
  enemyBasics: 'characters/enemy/enemyBasics.js',
  enemyGroups: 'combat/enemyGroups.js',
  enemyEquipment: 'combat/enemyEquipment.js',
  armorMaterials: 'systems/armorMaterials.js',
  itemTemplates: 'systems/item/itemTemplates.js',
  healthShare: 'combat/healthShare.js',
  playerWeapon: 'combat/playerWeapon.js',
  gateBrain: 'net/gate/gateBrain.js',
  fpsWeapon: 'combat/fpsWeapon.js',
  techniqueRoster: 'combat/technique/techniqueRoster.js',
  spellcast: 'systems/spellcast.js',
  effects: 'systems/effects.js',
  enchantments: 'systems/enchantments.js',
});

let _upstream = null;

/**
 * The oracle: upstream modules, with the overhaul installed exactly as the
 * game's boot does it (systems/worldTick.js calls installPcaao()). The game's
 * default mod settings (PCAAO on, every module ticked) are in force from the
 * vendored settings module.
 */
export async function upstream() {
  if (_upstream) return _upstream;
  const out = {};
  for (const [name, rel] of Object.entries(MODULES)) out[name] = await import(path.join(SRC, rel));
  out.pcaao.installPcaao();
  const modules = out.pcaao.pcaaoModules();
  _upstream = Object.freeze({ ...out, modules, commit: COMMIT, dir: SRC });
  return _upstream;
}

/** The same PCAAO module switches the harness passes explicitly (defaults, ticked). */
export function pcaaoModules(u) {
  return u.pcaao.pcaaoModules((key) => ({ Enabled: true, armorHitFormulaRedone: true, criticalStrikesIncreaseDamage: true, conditionBasedEffectiveness: true, softMaterialRequirements: true, equipmentDamageEnhanced: false, fixedStrengthDamageModifier: true, fadingEnchantedItems: false })[key], () => undefined);
}

/*
 * THE BOSS STAND-IN and every other foe body: test/harness/upstreamBodies.mjs.
 *
 * world/gate/gateBoss.js is vendored since Stage 2.8, so the stand-in is the
 * game's own `bossStandIn`, minted in a realm booted as the client boots
 * (Enemy Expansion and MUDEX loaded) - never a mirror kept here, and never in
 * this realm, where the boot would leak into the simulator's own modules.
 */

/** A reference foe from the game's own card table ('soft' | 'tough' | 'armoured' | 'human'). */
export function referenceFoe(u, level, preset) {
  const def = u.combatStats.REFERENCE_FOES.find((f) => f.id === preset);
  if (!def) throw new Error(`no reference foe "${preset}"`);
  return u.combatStats.referenceFoe(level, def);
}

/** A player entity in the shape upstream's formulas read. */
export function playerEntity({
  level = 30,
  raceId = 4,
  stats = {},
  skills = {},
  career = {},
  items = [],
  activeEffects = [],
  enchantMods = {},
} = {}) {
  const base = { strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50 };
  const skillArr = Array.from({ length: 35 }, (_, i) => (skills[i] ?? 40));
  return {
    isPlayer: true,
    level,
    raceId,
    stats: { ...base, ...stats },
    skills: skillArr,
    career: { weaponArmorShieldsBitfield: 0, abilityFlagsAndSpellPointsBitfield: 0, attackModifierFlags: 0, ...career },
    health: 100,
    maxHealth: 100,
    items,
    activeEffects,
    armorValues: new Array(7).fill(100),
    reflexes: 2,
    biographyAvoidHitMod: 0,
    _mods: { stats: {}, skills: {}, statMax: {} },
    _enchantMods: { skillMods: {}, chanceToHitMod: 0, ...enchantMods },
    equip: { slots: [] },
  };
}

/** A weapon item in the shape upstream reads (the roll comes from the template). */
export function weaponItem(templateIndex, { material = 0, condition = 1 } = {}) {
  const max = 1000;
  return {
    group: 'Weapons',
    templateIndex,
    material,
    name: `template ${templateIndex}`,
    flags: 0,
    maxCondition: max,
    currentCondition: Math.round(max * condition),
  };
}

/** The manifest of the vendored subset. */
export function manifest() {
  return JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'MANIFEST.json'), 'utf8'));
}

/**
 * Guard: a stub that leaks into a measured value shows up as NaN (or as this
 * marked string). Every measured number in the harness passes through here, so
 * a cut edge can never be mistaken for a real result.
 */
export function assertFinite(label, value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' && value.includes('[vendored stub]')) {
    throw new Error(`${label}: a vendored-stub value reached a measured result (${value})`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertFinite(`${label}[${i}]`, v));
    return value;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertFinite(`${label}.${k}`, v);
    return value;
  }
  if (typeof value === 'number' && Number.isNaN(value)) {
    throw new Error(`${label}: NaN reached a measured result`);
  }
  return value;
}
