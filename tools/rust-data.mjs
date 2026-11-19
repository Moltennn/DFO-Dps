#!/usr/bin/env node
/*
 * Data-table generator for the Rust port (rust/dfo-core, milestone R2).
 *
 *   node tools/rust-data.mjs           writes rust/dfo-core/src/generated/*.rs (one file per JS source, plus mod.rs)
 *   node tools/rust-data.mjs --check   regenerates in memory and compares; exits 1 (naming the files) when a committed
 *                                      file is missing or differs, or an unknown .rs file sits in that directory
 *
 * It imports the REAL JS modules: the data modules of src/ (src/data.js, src/enchantData.js) and the vendored upstream
 * tables that src/*.js import (vendor/upstream/a3eb1605). Every listed export that is not a function becomes a Rust
 * `pub const` (a scalar) or `pub static` (anything else). The list of vendored exports is the one `grep -n
 * vendor/upstream src/*.js` gives, read import by import. Output is deterministic: no clock, no environment, exports in
 * sorted order (for the whole-module lists), object fields in JS key order.
 *
 * TYPE MAPPING (inferred from the values; a slot that holds two kinds of value is refused, with its path)
 *   number                      f64. Every JS number is an IEEE double and the port keeps it so.
 *   boolean                     bool
 *   string                      &'static str (a lone UTF-16 surrogate is refused)
 *   null, undefined             Option<T>; T comes from the other values in the same slot (a slot of only nulls is refused)
 *   array of equal-length arrays &'static [(T0, T1, ...)]  (a tuple per element, e.g. CastWhenUsed's [id, cost, label])
 *   other array                 &'static [T]
 *   object, all keys integers   &'static [(i64, V)] in JS key order (integer keys come first, ascending, as in JS)
 *   object, identifier keys     a struct, one field per key (snake_case; a Rust keyword gets a trailing `_`)
 *   object, other string keys   &'static [(&'static str, V)] in JS key order
 *   Map                         its [key, value] entries in insertion order (as an array of pairs)
 *   function                    dropped: a field, or a whole export. The generator prints the dropped names.
 * Numbers print as float literals that parse back to the same bits (JS shortest round-trip form; NaN, Infinity and -0
 * are spelled out). Each table carries `#[rustfmt::skip]`, so `cargo fmt --check` accepts the files as written.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as data from '../src/data.js';
import * as enchantData from '../src/enchantData.js';

import * as anims from '../vendor/upstream/a3eb1605/src/characters/anims.js';
import * as weaponStates from '../vendor/upstream/a3eb1605/src/characters/weaponStates.js';
import * as enemyBasics from '../vendor/upstream/a3eb1605/src/characters/enemy/enemyBasics.js';
import * as enemyEntity from '../vendor/upstream/a3eb1605/src/characters/enemy/enemyEntity.js';
import * as paperdoll from '../vendor/upstream/a3eb1605/src/characters/paperdoll/paperdoll.js';
import * as meanerMonsters from '../vendor/upstream/a3eb1605/src/characters/meanerMonsters.js';
import * as pcaao from '../vendor/upstream/a3eb1605/src/combat/pcaao.js';
import * as enemyGroups from '../vendor/upstream/a3eb1605/src/combat/enemyGroups.js';
import * as enemyEquipment from '../vendor/upstream/a3eb1605/src/combat/enemyEquipment.js';
import * as formulas from '../vendor/upstream/a3eb1605/src/combat/formulas.js';
import * as equipRules from '../vendor/upstream/a3eb1605/src/characters/equipRules.js';
import * as bowBloom from '../vendor/upstream/a3eb1605/src/combat/bowBloom.js';
import * as handsLaw from '../vendor/upstream/a3eb1605/src/combat/twoHands/handsLaw.js';
import * as armorMaterials from '../vendor/upstream/a3eb1605/src/systems/armorMaterials.js';
import * as bossTraits from '../vendor/upstream/a3eb1605/src/systems/bossTraits.js';
import * as enchantments from '../vendor/upstream/a3eb1605/src/systems/enchantments.js';
import * as equip from '../vendor/upstream/a3eb1605/src/systems/equip.js';
import * as levelCap from '../vendor/upstream/a3eb1605/src/systems/levelCap.js';
import * as lootRarity from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import * as lootPowers from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';
import * as modSettings from '../vendor/upstream/a3eb1605/src/systems/modSettings.js';
import * as races from '../vendor/upstream/a3eb1605/src/systems/races.js';
import * as dexInstall from '../vendor/upstream/a3eb1605/src/systems/enemyExpansion/dexInstall.js';
import * as gateBoss from '../vendor/upstream/a3eb1605/src/world/gate/gateBoss.js';
import * as itemTemplates from '../vendor/upstream/a3eb1605/src/systems/item/itemTemplates.js';
import * as weapons from '../vendor/upstream/a3eb1605/src/characters/weapons.js';
import * as rriItems from '../vendor/upstream/a3eb1605/src/systems/roleplayRealismItems/rriItems.js';
import * as mobileTypes from '../vendor/upstream/a3eb1605/src/characters/mobile/mobileTypes.js';
import * as poisons from '../vendor/upstream/a3eb1605/src/systems/poisons.js';
import * as createItemRows from '../vendor/upstream/a3eb1605/src/systems/createItemRows.js';
import * as gemGrades from '../vendor/upstream/a3eb1605/src/systems/loot/gemGrades.js';
import * as thunderlockIds from '../vendor/upstream/a3eb1605/src/characters/thunderlockIds.js';
import { HAND_WRAPS_TEMPLATE } from '../vendor/upstream/a3eb1605/src/characters/handWrapsIds.js';
import { REGISTERED_ENCHANTMENT_TYPES, POTENT_VS_FLAT, PROCS_BEFORE_BREAK_BASIS, ENCHANTMENT_TYPES } from '../src/enchants.js';
import * as spells from '../src/spells.js';
import { RELAY_BOSSES } from '../src/bossTraits.js';
import { MENTOR_SKILL_BASELINE } from '../vendor/upstream/a3eb1605/src/systems/mentorMode.js';
import * as save from '../src/save.js';
import { encodeValue } from './rust-codec.mjs';
import { mintRow } from '../src/target.js';

const V = 'vendor/upstream/a3eb1605/src';
const here = dirname(fileURLToPath(import.meta.url));
const genDir = join(here, '..', 'rust', 'dfo-core', 'src', 'generated');

/** One generated module per entry. `names: null` takes every export (sorted); otherwise the listed exports, in order. */
/**
 * A module-private `const NAME = <literal>` cut out of a vendored source file and evaluated (the method
 * tools/rust-vectors.mjs uses for functions it cannot import). `close` is the bracket that ends the literal, `})` or
 * `]`. The literal must be self-contained (numbers and nested literals). Fails loudly if the text moves.
 */
function cutLiteral(relPath, name, close) {
  const text = readFileSync(join(here, '..', relPath), 'utf8');
  const head = `const ${name} = `;
  const start = text.indexOf(head);
  if (start < 0 || text.indexOf(head, start + 1) >= 0) {
    throw new Error(`rust-data: ${relPath} must hold exactly one \`${head.trim()}\``);
  }
  const end = text.indexOf(`${close};`, start);
  if (end < 0) throw new Error(`rust-data: ${relPath}: no \`${close};\` ends \`${name}\``);
  return new Function(`return (${text.slice(start + head.length, end + close.length)});`)();
}

/** EQUIP_SLOT_NAMES: the paperdoll's slot names (the `EQUIP_SLOTS` keys) with their ids, for the names SLOT_RULES holds. */
function equipSlotNames() {
  const rows = Object.entries(paperdoll.EQUIP_SLOTS).map(([k, v]) => {
    if (typeof v !== 'number') throw new Error(`rust-data: EQUIP_SLOTS.${k} is not a number`);
    return `(${rustStr(k)}, ${fLit(v)})`;
  });
  return `#[rustfmt::skip]\npub static EQUIP_SLOT_NAMES: &[(&str, f64)] = &[${rows.join(', ')}];`;
}

// ---------------------------------------------------------------------------------------------------------------
// R3b tables. Each one is the real JS evaluated over a finite, vendored input domain (the mint rows over every
// boot switch combination and every classic mobile id; the DEX classic props per mudex flag), so the Rust side
// looks them up instead of re-running the mod's CSV reader. `force` (see forceOpt) makes every record field an
// Option, so the Rust that reads a row is written against one known shape.
// ---------------------------------------------------------------------------------------------------------------
/** Every (vendored) mobile id a classic row exists for: 0..=42 and 128..=146, ascending. */
const MINT_IDS = Object.keys(enemyBasics.VANILLA_ENEMY_BASICS).map(Number).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
/** Boot code: bit 0 pcaao, bit 1 Meaner Monsters, bit 2 Daggerfall Enemy Expansion (the boot arguments of target.js). */
export const bootOfCode = (code) => ({ pcaao: (code & 1) !== 0, meanerMonsters: (code & 2) !== 0, enemyExpansion: (code & 4) !== 0 });

function buildMintRows() {
  const rows = {};
  for (let code = 0; code < 8; code++) {
    for (const id of MINT_IDS) {
      const row = mintRow(id, { boot: bootOfCode(code) });
      if (row === null) continue;
      if (typeof row.minMetalToHit !== 'number') throw new Error(`rust-data: mint row ${id} under boot ${code} has no minMetalToHit`);
      rows[`${code}/${id}`] = row;
    }
  }
  return rows;
}

/** The DEX classic `equipmentTable` each id names (dexEquipment.js dexClassTable reads it through propsOf), per mudex. */
function buildDexEquipment() {
  const out = {};
  for (const mudex of [false, true]) {
    const read = dexInstall.dexRead({ mudex, log: () => {} });
    for (const id of MINT_IDS) {
      const props = read.classic.get(id)?.props ?? read.enemies.get(id)?.props ?? null;
      const table = props?.equipmentTable;
      if (!table) continue;
      if (typeof table !== 'string') throw new Error(`rust-data: equipmentTable of ${id} is not a string`);
      out[`${mudex ? 1 : 0}/${id}`] = table;
    }
  }
  return out;
}

/** The DFU item template fields the minters read (mintCondition: hitPoints; clothing: variants), by index. */
function buildTemplateFacts() {
  for (let i = 513; i <= 526; i++) {
    // The RRI rows are not registered by the port (no mod ItemTemplates.json is read): the minters answer null, so the
    // mint gives maxCondition 0. A registration would change that, so it is checked, not assumed.
    if (itemTemplates.templateByIndex(i) !== null) throw new Error(`rust-data: template ${i} is registered; the port's RRI model assumes it is not`);
  }
  const facts = {};
  for (const t of itemTemplates.ITEM_TEMPLATES) {
    if (!t) continue;
    facts[String(t.index)] = { hitPoints: t.hitPoints, variants: t.variants };
  }
  return facts;
}

/** RRI_CLASSES' light set folds Chain (0x0100) to Leather with `message` 1 when it is minted (rriItems.js lightVariant). */
function probeChainFolds() {
  const out = {};
  for (const [k, cls] of Object.entries(rriItems.RRI_CLASSES)) {
    const probe = typeof cls.onVariantSet === 'function'
      ? cls.onVariantSet({ group: 'Armor', templateIndex: Number(k), material: 0x0100, name: '' })
      : null;
    out[k] = probe?.material === 0 && probe?.message === 1;
  }
  return out;
}

/** The four RRI switches the minters and the enemy arm read, at the mod's shipped defaults (modSettings.js). */
function rriEnabledDefaults() {
  const keys = modSettings.MOD_SETTINGS['roleplay-realism-items'].keys;
  const def = (k) => {
    const on = keys[k]?.default;
    if (typeof on !== 'boolean') throw new Error(`rust-data: roleplay-realism-items ${k}.default is not a boolean`);
    return on;
  };
  return { Enabled: def('Enabled'), newWeapons: def('newWeapons'), newArmor: def('newArmor'), realisticEnemyEquipment: def('realisticEnemyEquipment') };
}

/**
 * R4a: the lootRarity tables the affix and socket readers read, as flat rows (the generator's struct names follow the
 * key paths, so the Rust names fixed fields only). Every list is non-empty (the generator cannot type an empty one).
 */
function lootRarityTables() {
  const K = lootRarity.AFFIX_KINDS;
  const R = lootRarity.AFFIX_RANGES;
  const strParams = [];
  const numParams = [];
  const noParams = [];
  for (const [id, k] of Object.entries(K)) {
    if (!Array.isArray(k.params)) {
      noParams.push(id);
    } else if (k.params.every((p) => typeof p === 'string')) {
      strParams.push([id, [...k.params]]);
    } else if (k.params.every((p) => typeof p === 'number')) {
      numParams.push([id, [...k.params]]);
    } else {
      throw new Error(`rust-data: affix kind ${id} has a params list of two kinds`);
    }
  }
  const gemRows = [];
  for (const [kind, sides] of Object.entries(lootRarity.GEM_GRADE_LINES)) {
    for (const side of ['weapon', 'other']) {
      const row = sides[side];
      gemRows.push([kind, side, row.id, row.param ?? null, [...row.values]]);
    }
  }
  return {
    AFFIX_KIND_NAMES: Object.keys(K),
    AFFIX_PARAM_STR: strParams,
    AFFIX_PARAM_NUM: numParams,
    AFFIX_NO_PARAM: noParams,
    AFFIX_RARE_TOP: Object.entries(R).map(([id, r]) => [id, r.rare[1]]),
    AFFIX_LEGENDARY_TOP: Object.entries(R).map(([id, r]) => [id, r.legendary[1]]),
    GEM_LINE_ROWS: gemRows,
    SOCKET_GROUPS: [...lootRarity.SOCKET_GROUPS],
    SOCKET_EMPTY: lootRarity.SOCKET_EMPTY,
    WEAPON_SOCKETS: { ...lootRarity.WEAPON_SOCKETS },
  };
}

/**
 * R4a: `powerOf(id)` (lootRarity.js:1268) is `LEGENDARY_POWERS[id] ?? legendaryById(id)?.power ?? _gilded?.powerOf(id) ?? null`.
 * Two tables are generated as codec tokens (the records are heterogeneous, so a typed struct would fix field names the
 * generator cannot know): `LEGENDARY_POWER_TOKENS` (the table) and `LEGENDARY_OWN_POWER_TOKENS` (each legendary's own
 * `power`, the first record of an id, as `legendaryById` finds it; a null power is skipped, as `??` skips it).
 * `_gilded` is module-private and unset on this import path. The generator asserts powerOf answers null for an id no
 * registry holds, which catches a registry that answers every id; a registry that answers only some ids is not caught.
 */
function legendaryPowerTokens() {
  if (lootRarity.powerOf('no-such-gilded-id-for-the-rust-port') !== null) {
    throw new Error('rust-data: powerOf answers a made-up id: a gilded registry is set on this import path; the port has none');
  }
  return Object.entries(lootRarity.LEGENDARY_POWERS).map(([id, p]) => [id, encodeValue(p)]);
}

function legendaryOwnPowerTokens() {
  const first = new Map();
  for (const l of lootRarity.allLegendaries()) if (!first.has(l.id)) first.set(l.id, l);
  const rows = [];
  for (const [id, l] of first) {
    if (l.power === undefined || l.power === null) continue;
    rows.push([id, encodeValue(l.power)]);
  }
  const both = rows.map(([id]) => id).filter((id) => Object.hasOwn(lootRarity.LEGENDARY_POWERS, id));
  console.log(`rust-data: ${rows.length} legendaries carry their own power; ${both.length} of them also in LEGENDARY_POWERS${both.length ? `: ${both.join(', ')}` : ''}`);
  return rows;
}

/**
 * R4a: the own property names of the prototypes a plain JS object, array, string, number or boolean inherits. A read of
 * one of these that the receiver does not own yields a function or an object in JS, which a Value cannot hold: the port
 * refuses it (rust/README.md, R4a). Generated from the runtime, so the lists are the engine's own.
 */
function prototypeKeys() {
  return {
    OBJECT_PROTOTYPE_KEYS: Object.getOwnPropertyNames(Object.prototype),
    ARRAY_PROTOTYPE_KEYS: Object.getOwnPropertyNames(Array.prototype),
    STRING_PROTOTYPE_KEYS: Object.getOwnPropertyNames(String.prototype),
    NUMBER_PROTOTYPE_KEYS: Object.getOwnPropertyNames(Number.prototype),
    BOOLEAN_PROTOTYPE_KEYS: Object.getOwnPropertyNames(Boolean.prototype),
  };
}

/**
 * R4a: the weapon skill and the ammunition set of `characters/weapons.js` and `systems/item/itemTemplates.js`, probed over
 * every template index 0..700 except the RRI custom classes 513..526 (not registered in the port; see rust/README.md).
 * The probe answers what the JS answers with the registries as the import path leaves them.
 */
function buildItemFacts() {
  const skillUsed = {};
  const ammo = [];
  for (let t = 0; t <= 700; t++) {
    if (t >= 513 && t <= 526) continue;
    const s = weapons.weaponSkillUsed(t);
    if (s !== null && s !== undefined) skillUsed[t] = s;
    if (itemTemplates.isAmmunition({ templateIndex: t })) ammo.push(t);
  }
  return {
    WEAPON_SKILL_USED: skillUsed,
    AMMUNITION_TEMPLATES: ammo,
    THUNDERLOCK_TEMPLATE: thunderlockIds.THUNDERLOCK_TEMPLATE,
  };
}

const SOURCES = [
  { file: 'data', from: 'src/data.js', mod: data, names: null },
  { file: 'enchant_data', from: 'src/enchantData.js', mod: {
    ...enchantData,
    ENCHANTMENT_PRICE_ROWS: Object.entries(ENCHANTMENT_TYPES).flatMap(([type, id]) =>
      enchantData.enchantmentParamValues(type).map(param => [id, param, enchantData.enchantmentCost(type, param)])),
    ITEM_ENCHANTMENT_POINTS: Object.fromEntries(JSON.parse(readFileSync(join(here, '..', 'vendor/enchanting/itemTemplates.json'), 'utf8'))
      .map(t => [t.index, enchantData.itemEnchantmentPoints(t.index)])),
  }, names: null },
  { file: 'spell_tables', from: 'src/spells.js and systems/mentorMode.js', mod: { ...spells, MENTOR_SKILL_BASELINE },
    names: ['SPELL_RECORD_SIZE', 'MAGIC_ROUND_SECONDS', 'EFFECT_COST_TABLE', 'TARGET_COST_MULT', 'CAST_COST_FLOOR', 'MENTOR_SKILL_BASELINE'] },
  { file: 'anims', from: `${V}/characters/anims.js`, mod: anims, names: ['DIRECTION_TO_STRIKE'] },
  {
    file: 'weapon_states',
    from: `${V}/characters/weaponStates.js`,
    mod: weaponStates,
    names: ['SWING_FRAME_MAX', 'HIT_FRAME_MELEE', 'HIT_FRAME_BOW', 'BOW_DRAWN_HOLD_FRAME', 'CLICK_ATTACK_DIRECTIONS', 'MELEE_NUM_FRAMES'],
  },
  { file: 'enemy_basics', from: `${V}/characters/enemy/enemyBasics.js`, mod: enemyBasics, names: ['ENEMY_BASICS', 'VANILLA_ENEMY_BASICS'] },
  { file: 'enemy_entity', from: `${V}/characters/enemy/enemyEntity.js`, mod: enemyEntity, names: ['KNIGHT_CITYWATCH_ID'] },
  { file: 'races', from: `${V}/systems/races.js`, mod: races, names: ['FACES_PER_RACE', 'RACES', 'RACE_KEYS', 'RACE_TEMPLATES'] },
  { file: 'pcaao', from: `${V}/combat/pcaao.js`, mod: pcaao, names: ['PCAAO_REDUCTION_ROWS', 'SILVER_DOUBLED_CAREERS'] },
  {
    file: 'enemy_groups',
    from: `${V}/combat/enemyGroups.js`,
    // module-private literal (R3a): cut from the source text, see cutLiteral
    mod: { ...enemyGroups, ENEMY_GROUP_BY_CAREER: cutLiteral(`${V}/combat/enemyGroups.js`, 'ENEMY_GROUP_BY_CAREER', '})') },
    names: ['ENEMY_GROUPS', 'ENEMY_GROUP_BY_CAREER'],
  },
  {
    file: 'enemy_equipment',
    from: `${V}/combat/enemyEquipment.js`,
    mod: {
      ...enemyEquipment,
      PIECE_BODY_PART: cutLiteral(`${V}/combat/enemyEquipment.js`, 'PIECE_BODY_PART', '})'),
      SHIELD_VALUE: cutLiteral(`${V}/combat/enemyEquipment.js`, 'SHIELD_VALUE', '})'),
      SHIELD_PARTS: cutLiteral(`${V}/combat/enemyEquipment.js`, 'SHIELD_PARTS', '})'),
    },
    names: ['ARMOR_ENUM', 'ARMOR_MATERIAL', 'MATERIALS_BY_MODIFIER', 'WEAPONS_ENUM', 'PIECE_BODY_PART', 'SHIELD_VALUE', 'SHIELD_PARTS'],
  },
  {
    file: 'armor_materials',
    from: `${V}/systems/armorMaterials.js`,
    mod: { ...armorMaterials, PLATE_ARMOR_VALUES: cutLiteral(`${V}/systems/armorMaterials.js`, 'PLATE_ARMOR_VALUES', ']') },
    names: ['SHIELD_PARTS', 'SHIELD_VALUES', 'BODY_PARTS', 'NUMBER_BODY_PARTS', 'ARMOR_MATERIAL', 'PLATE_ARMOR_VALUES'],
  },
  { file: 'formulas', from: `${V}/combat/formulas.js`, mod: formulas, names: ['GROUP_BITS'] },
  { file: 'equip_rules', from: `${V}/characters/equipRules.js`, mod: equipRules, names: ['SLOT_RULES', 'ITEM_GROUPS', 'WEAPON_HANDS', 'SHIELD_INDICES'] },
  {
    file: 'equip',
    from: `${V}/systems/equip.js`,
    // equip.js's slotForBodyPart is a Map inverted from SLOT_BODY_PART (module-private): probed over its keys 0..6.
    mod: { SLOT_FOR_BODY_PART: Object.fromEntries(Array.from({ length: 7 }, (_, p) => [String(p), equip.slotForBodyPart(p)])) },
    names: ['SLOT_FOR_BODY_PART'],
    extra: () => [equipSlotNames()],
  },
  { file: 'boss_traits', from: `${V}/systems/bossTraits.js and src/bossTraits.js`, mod: { ...bossTraits, RELAY_BOSSES: Object.entries(RELAY_BOSSES),
    RELAY_BOSS_BLOW_TRAITS: cutLiteral(`${V}/systems/bossTraits.js`, 'RELAY_BOSS_BLOW_TRAITS', '])'),
  }, names: ['ELEMENT_TRAITS', 'RESIST_SHARE', 'WEAPON_RESIST_SHARE', 'THORN_SHARE', 'RELAY_BOSSES', 'RELAY_BOSS_BLOW_TRAITS'] },
  { file: 'enchantments', from: `${V}/systems/enchantments.js`, mod: { ...enchantments,
    AFFINITY_PARAM: cutLiteral(`${V}/systems/enchantments.js`, 'AFFINITY_PARAM', '})'),
    REGISTERED_ENCHANTMENT_TYPES: [...REGISTERED_ENCHANTMENT_TYPES], POTENT_VS_FLAT, PROCS_BEFORE_BREAK_BASIS,
    STRIKE_AFFINITY: cutLiteral('src/enchants.js', 'AFFINITY', '})'),
  }, names: ['ENCHANTMENT_TYPES', 'LOW_DAMAGE_VS', 'POTENT_VS_DAMAGE', 'AFFINITY_PARAM', 'REGISTERED_ENCHANTMENT_TYPES', 'POTENT_VS_FLAT', 'PROCS_BEFORE_BREAK_BASIS', 'STRIKE_AFFINITY'] },
  { file: 'paperdoll', from: `${V}/characters/paperdoll/paperdoll.js`, mod: paperdoll, names: ['EQUIP_SLOTS'] },
  { file: 'level_cap', from: `${V}/systems/levelCap.js`, mod: levelCap, names: ['LEVEL_CAP'] },
  {
    file: 'loot_rarity',
    from: `${V}/systems/loot/lootRarity.js`,
    mod: { ...lootRarity, ...lootRarityTables() },
    names: [
      'AFFIX_COUNTS', 'AFFIX_IDS', 'AFFIX_KINDS', 'AFFIX_RANGES',
      'AFFIX_KIND_NAMES', 'AFFIX_PARAM_STR', 'AFFIX_PARAM_NUM', 'AFFIX_NO_PARAM', 'AFFIX_RARE_TOP', 'AFFIX_LEGENDARY_TOP',
      'GEM_LINE_ROWS', 'SOCKET_GROUPS', 'SOCKET_EMPTY', 'WEAPON_SOCKETS',
    ],
  },
  {
    file: 'loot_powers',
    from: `${V}/systems/loot/lootPowers.js (LEGENDARY_POWERS and the legendaries' own power, lootRarity.js, as codec tokens)`,
    mod: { ...lootPowers, LEGENDARY_POWER_TOKENS: legendaryPowerTokens(), LEGENDARY_OWN_POWER_TOKENS: legendaryOwnPowerTokens() },
    names: ['POTENCY_CAP', 'SPELL_POWER_MOST', 'LEGENDARY_POWER_TOKENS', 'LEGENDARY_OWN_POWER_TOKENS'],
  },
  { file: 'js_prototypes', from: 'the JS engine: own names of Object, Array, String, Number and Boolean .prototype', mod: prototypeKeys(), names: ['OBJECT_PROTOTYPE_KEYS', 'ARRAY_PROTOTYPE_KEYS', 'STRING_PROTOTYPE_KEYS', 'NUMBER_PROTOTYPE_KEYS', 'BOOLEAN_PROTOTYPE_KEYS'] },
  { file: 'gate_boss', from: `${V}/world/gate/gateBoss.js`, mod: gateBoss, names: ['BOSS_ARMOR'] },
  { file: 'bow_bloom', from: `${V}/combat/bowBloom.js`, mod: bowBloom, names: ['BOW_FAST'] },
  { file: 'hands_law', from: `${V}/combat/twoHands/handsLaw.js`, mod: handsLaw, names: ['DUAL', 'OFF_HAND_BLOW', 'FLURRY_WINDOW'] },
  // R3b
  { file: 'mint_rows', from: `${V}/characters/meanerMonsters.js (target.js mintRow over boot codes 0..7 x classic ids)`, mod: { MINT_ROWS: buildMintRows() }, names: ['MINT_ROWS'], force: true },
  { file: 'dex_equipment', from: `${V}/systems/enemyExpansion/dexInstall.js (classic props.equipmentTable, per mudex)`, mod: { DEX_EQUIPMENT_TABLE: buildDexEquipment() }, names: ['DEX_EQUIPMENT_TABLE'], hints: { DEX_EQUIPMENT_TABLE: { t: 'skeyed', of: { t: 'str' } } } },
  { file: 'item_templates', from: `${V}/systems/item/itemTemplates.js ITEM_TEMPLATES (hitPoints, variants)`, mod: { ITEM_TEMPLATE_FACTS: buildTemplateFacts() }, names: ['ITEM_TEMPLATE_FACTS'], force: true },
  { file: 'weapons', from: `${V}/characters/weapons.js`, mod: weapons, names: ['WEAPON_MATERIALS', 'conditionMultipliersByMaterial', 'WEAPON_CONDITION_POOL'] },
  {
    file: 'rri_items',
    from: `${V}/systems/roleplayRealismItems/rriItems.js (RRI_CLASSES, the chain fold probe, the module switches' defaults)`,
    mod: { RRI_CLASSES: rriItems.RRI_CLASSES, RRI_CHAIN_FOLD: probeChainFolds(), RRI_ENABLED_DEFAULTS: rriEnabledDefaults() },
    names: ['RRI_CLASSES', 'RRI_CHAIN_FOLD', 'RRI_ENABLED_DEFAULTS'],
    force: true,
  },
  { file: 'mobile_types', from: `${V}/characters/mobile/mobileTypes.js`, mod: mobileTypes, names: ['MOBILE_TYPES'] },
  { file: 'poisons', from: `${V}/systems/poisons.js`, mod: poisons, names: ['POISON_START_VALUE'] },
  { file: 'create_item_rows', from: `${V}/systems/createItemRows.js`, mod: createItemRows, names: ['MENS_PLAIN_ROBES', 'WOMENS_PLAIN_ROBES'] },
  // R4a
  { file: 'save_tables', from: 'src/save.js (SLOT, WEAPON_SKILL, PROFICIENCY_FLAG, ENHANCE_SKILL_MOD)', mod: save, names: ['SLOT', 'WEAPON_SKILL', 'PROFICIENCY_FLAG', 'ENHANCE_SKILL_MOD'] },
  { file: 'gem_grades', from: `${V}/systems/loot/gemGrades.js`, mod: gemGrades, names: ['GEM_IDS', 'GEM_GRADES', 'GEM_ROW_GRADES', 'ALL_GEM_IDS', 'GEM_GRADE_TEMPLATE_BASE'] },
  {
    file: 'item_facts',
    from: `${V}/characters/weapons.js weaponSkillUsed, ${V}/systems/item/itemTemplates.js isAmmunition (probed), ${V}/characters/thunderlockIds.js`,
    mod: { ...buildItemFacts(), HAND_WRAPS_TEMPLATE, PISTOLET_TEMPLATE: thunderlockIds.PISTOLET_TEMPLATE,
      CONDITION_HIT_POINTS: Object.fromEntries(Array.from({ length: 701 }, (_, i) => [i, itemTemplates.templateByIndex(i)])
        .filter(([, t]) => t != null).map(([i, t]) => [i, t.hitPoints ?? 0])),
    },
    names: ['WEAPON_SKILL_USED', 'AMMUNITION_TEMPLATES', 'THUNDERLOCK_TEMPLATE', 'HAND_WRAPS_TEMPLATE', 'PISTOLET_TEMPLATE', 'CONDITION_HIT_POINTS'],
  },
];

const RUST_KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'become', 'box', 'break', 'const', 'continue', 'crate', 'do', 'dyn', 'else', 'enum',
  'extern', 'false', 'final', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'macro', 'match', 'mod', 'move', 'mut',
  'override', 'priv', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true', 'try', 'type',
  'typeof', 'unsafe', 'unsized', 'use', 'virtual', 'where', 'while', 'yield',
]);

const SKIP = Symbol('skip');
/** Slots whose data carries no type (always null / always empty); reported at the end of a run. */
const PLACEHOLDERS = [];
/** Every emitted table's type tree, by `file:NAME` (the golden-vector writer reads the canonical form through it). */
export const DESCS = new Map();
const where = (path) => path.join('.') || '<root>';
const isIntKey = (k) => String(Number(k)) === k && Number.isSafeInteger(Number(k));
const isIdentKey = (k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
const pascal = (s) => s
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map((w) => (w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w[0].toUpperCase() + w.slice(1)))
  .join('');
const recName = (path) => path.map(pascal).join('');
const toConst = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const fieldName = (k) => {
  if (!isIdentKey(k)) throw new Error(`rust-data: field name is not an identifier: ${k}`);
  const s = k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
  return RUST_KEYWORDS.has(s) ? `${s}_` : s;
};

/** A string must be well-formed UTF-16 (Rust strings are UTF-8). */
function checkText(s, path) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { i++; continue; }
    }
    if (c >= 0xd800 && c <= 0xdfff) throw new Error(`rust-data: lone surrogate in a string at ${where(path)}`);
  }
}

/** Plain data only: Map becomes pairs, function-valued fields and undefined fields are dropped. */
export function normalize(v, path) {
  if (typeof v === 'function') return SKIP;
  if (v === null || v === undefined) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    checkText(v, path);
    return v;
  }
  if (v instanceof Map) return normalize([...v.entries()], path);
  if (Array.isArray(v)) {
    return v.map((x, i) => {
      const n = normalize(x, [...path, String(i)]);
      if (n === SKIP) throw new Error(`rust-data: a function inside an array at ${where(path)}`);
      return n;
    });
  }
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error(`rust-data: not a plain object at ${where(path)}`);
    const out = {};
    for (const k of Object.keys(v)) {
      const n = normalize(v[k], [...path, k]);
      if (n === SKIP || n === undefined) continue;
      out[k] = n;
    }
    return out;
  }
  throw new Error(`rust-data: unsupported value (${typeof v}) at ${where(path)}`);
}

const kindOf = (v) => (Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);

/** The type of one slot, from every value that fills it. `nullish` means some owner lacks the slot. */
export function describe(vals, path, nullish = false) {
  const present = vals.filter((v) => v !== null && v !== undefined);
  if (present.length === 0) {
    // Every owner has null here, so the data carries no type. An inert Option<f64> that is always None, and the path
    // is reported so a reader can see the choice.
    PLACEHOLDERS.push(`${where(path)} (always null)`);
    return { t: 'opt', of: { t: 'f64' } };
  }
  const kinds = [...new Set(present.map(kindOf))];
  if (kinds.length !== 1) throw new Error(`rust-data: mixed kinds (${kinds.join(', ')}) at ${where(path)}`);
  const kind = kinds[0];
  let d;
  if (kind === 'number') d = { t: 'f64' };
  else if (kind === 'boolean') d = { t: 'bool' };
  else if (kind === 'string') d = { t: 'str' };
  else if (kind === 'array') d = describeArray(present, path);
  else d = describeObject(present, path);
  return nullish || present.length !== vals.length ? { t: 'opt', of: d } : d;
}

function describeArray(arrs, path) {
  const elems = arrs.flatMap((a) => a);
  if (elems.length === 0) {
    PLACEHOLDERS.push(`${where(path)} (always an empty array)`);
    return { t: 'list', of: { t: 'f64' } };
  }
  if (elems.every((e) => Array.isArray(e))) {
    const lens = [...new Set(elems.map((e) => e.length))];
    if (lens.length === 1 && lens[0] > 0) {
      const of = [];
      for (let k = 0; k < lens[0]; k++) of.push(describe(elems.map((e) => e[k]), [...path, `T${k}`]));
      return { t: 'list', of: { t: 'tuple', of } };
    }
    return { t: 'list', of: { t: 'list', of: describe(elems.flat(), [...path, 'Item']) } };
  }
  return { t: 'list', of: describe(elems, [...path, 'Item']) };
}

function describeObject(objs, path) {
  const keys = [...new Set(objs.flatMap((o) => Object.keys(o)))];
  if (keys.length === 0) return { t: 'rec', name: recName(path), fields: [] };
  if (keys.every(isIntKey)) {
    return { t: 'keyed', of: describe(objs.flatMap((o) => Object.values(o)), [...path, 'Value']) };
  }
  if (keys.some(isIntKey)) throw new Error(`rust-data: integer keys mixed with other keys at ${where(path)}`);
  if (keys.every(isIdentKey)) {
    const fields = keys.map((k) => {
      const vals = objs.filter((o) => k in o).map((o) => o[k]);
      return { key: k, d: describe(vals, [...path, k], vals.length !== objs.length) };
    });
    return { t: 'rec', name: recName(path), fields };
  }
  return { t: 'skeyed', of: describe(objs.flatMap((o) => Object.values(o)), [...path, 'Value']) };
}

function ty(d) {
  switch (d.t) {
    case 'f64': return 'f64';
    case 'bool': return 'bool';
    case 'str': return "&'static str";
    case 'opt': return `Option<${ty(d.of)}>`;
    case 'list': return `&'static [${ty(d.of)}]`;
    case 'tuple': return `(${d.of.map(ty).join(', ')}${d.of.length === 1 ? ',' : ''})`;
    case 'keyed': return `&'static [(i64, ${ty(d.of)})]`;
    case 'skeyed': return `&'static [(&'static str, ${ty(d.of)})]`;
    case 'rec': return d.name;
    default: throw new Error(`rust-data: unknown type ${d.t}`);
  }
}

/** A float that parses back to the same bits. JS String() is the shortest round-trip form. */
function fLit(x) {
  if (Number.isNaN(x)) return 'f64::NAN';
  if (x === Infinity) return 'f64::INFINITY';
  if (x === -Infinity) return 'f64::NEG_INFINITY';
  if (Object.is(x, -0)) return '-0.0';
  const s = String(x).replace('e+', 'e');
  return /[.e]/.test(s) ? s : `${s}.0`;
}

function rustStr(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (cp < 0x20 || cp === 0x7f) out += `\\u{${cp.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

function lit(d, v, path) {
  switch (d.t) {
    case 'f64':
      if (typeof v !== 'number') throw new Error(`rust-data: expected a number at ${where(path)}`);
      return fLit(v);
    case 'bool':
      if (typeof v !== 'boolean') throw new Error(`rust-data: expected a boolean at ${where(path)}`);
      return String(v);
    case 'str':
      if (typeof v !== 'string') throw new Error(`rust-data: expected a string at ${where(path)}`);
      return rustStr(v);
    case 'opt':
      return v === null || v === undefined ? 'None' : `Some(${lit(d.of, v, path)})`;
    case 'list':
      if (!Array.isArray(v)) throw new Error(`rust-data: expected an array at ${where(path)}`);
      return `&[${v.map((x) => lit(d.of, x, [...path, 'Item'])).join(', ')}]`;
    case 'tuple': {
      if (!Array.isArray(v) || v.length !== d.of.length) throw new Error(`rust-data: bad tuple at ${where(path)}`);
      const parts = d.of.map((e, k) => lit(e, v[k], [...path, `T${k}`]));
      return `(${parts.join(', ')}${parts.length === 1 ? ',' : ''})`;
    }
    case 'keyed':
      return `&[${Object.keys(v).map((k) => `(${k}, ${lit(d.of, v[k], [...path, k])})`).join(', ')}]`;
    case 'skeyed':
      return `&[${Object.keys(v).map((k) => `(${rustStr(k)}, ${lit(d.of, v[k], [...path, k])})`).join(', ')}]`;
    case 'rec': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`rust-data: expected an object at ${where(path)}`);
      if (d.fields.length === 0) return `${d.name} {}`;
      const inits = d.fields.map((f) => `${fieldName(f.key)}: ${lit(f.d, v[f.key], [...path, f.key])}`);
      return `${d.name} { ${inits.join(', ')} }`;
    }
    default:
      throw new Error(`rust-data: unknown type ${d.t}`);
  }
}

/** `force`: every record field becomes an Option (a field present in every row is still `Option`), so the Rust reading a
 *  table is written against one shape whatever the data holds. Applied recursively; lists and tuples keep their elements. */
const wrapOpt = (d) => (d.t === 'opt' ? d : { t: 'opt', of: d });
export function forceOpt(d) {
  switch (d.t) {
    case 'rec': return { ...d, fields: d.fields.map((f) => ({ key: f.key, d: wrapOpt(forceOpt(f.d)) })) };
    case 'opt': return { t: 'opt', of: forceOpt(d.of) };
    case 'list': return { t: 'list', of: forceOpt(d.of) };
    case 'keyed': case 'skeyed': return { ...d, of: forceOpt(d.of) };
    case 'tuple': return { t: 'tuple', of: d.of.map(forceOpt) };
    default: return d;
  }
}

// ---- the canonical token form (one token per value; a row is its tokens joined with ';', see rust/README.md) ----
const canonDv = new DataView(new ArrayBuffer(8));
const tokF = (x) => {
  if (typeof x !== 'number') throw new Error(`rust-data: canon: not a number: ${String(x)}`);
  if (Number.isNaN(x)) return '7ff8000000000000';
  canonDv.setFloat64(0, x);
  return canonDv.getBigUint64(0).toString(16).padStart(16, '0');
};
/** Pushes the tokens of value `v` of type `d` onto `out`. An absent optional is `-`; a record is its fields in order. */
export function canonOf(d, v, out = []) {
  switch (d.t) {
    case 'opt':
      if (v === null || v === undefined) out.push('-');
      else canonOf(d.of, v, out);
      return out;
    case 'f64': out.push(tokF(v)); return out;
    case 'bool':
      if (typeof v !== 'boolean') throw new Error('rust-data: canon: not a boolean');
      out.push(v ? '1' : '0');
      return out;
    case 'str':
      if (typeof v !== 'string') throw new Error('rust-data: canon: not a string');
      out.push(`n:${Array.from({ length: v.length }, (_, i) => v.charCodeAt(i).toString(16).padStart(4, '0')).join('')}`);
      return out;
    case 'list':
      if (!Array.isArray(v) || d.of.t !== 'f64') throw new Error('rust-data: canon: a list of numbers only');
      out.push(String(v.length));
      for (const x of v) out.push(tokF(x));
      return out;
    case 'rec':
      for (const f of d.fields) canonOf(f.d, v?.[f.key], out);
      return out;
    default: throw new Error(`rust-data: canon: no form for ${d.t}`);
  }
}

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
function canonStmt(d, e) {
  switch (d.t) {
    case 'opt': return `match ${e} { None => out.push("-".to_string()), Some(v) => { ${canonStmt(d.of, 'v')} } }`;
    case 'f64': return `out.push(vc::f(${e}));`;
    case 'bool': return `out.push(vc::b(${e}));`;
    case 'str': return `out.push(vc::s(${e}));`;
    case 'list':
      if (d.of.t !== 'f64') throw new Error('rust-data: canon: a list that is not numbers');
      return `vc::list(${e}, out);`;
    case 'rec': return `${snake(d.name)}_into(&${e}, out);`;
    default: throw new Error(`rust-data: canon: no Rust form for ${d.t}`);
  }
}
function recInto(r) {
  const body = r.fields.length === 0 ? '    let _ = (r, out);' : r.fields.map((f) => `    ${canonStmt(f.d, `r.${fieldName(f.key)}`)}`).join('\n');
  return `#[rustfmt::skip]\nfn ${snake(r.name)}_into(r: &${r.name}, out: &mut Vec<String>) {\n${body}\n}`;
}
/** canon_rows.rs: the token form of the two row records the target carries (the mint rows and the shipped table). */
function emitCanon() {
  const specs = [
    { rec: DESCS.get('mint_rows:MINT_ROWS').of, fn: 'canon_mint_row', mod: 'mint_rows' },
    { rec: DESCS.get('enemy_basics:ENEMY_BASICS').of, fn: 'canon_enemy_basics_row', mod: 'enemy_basics' },
  ];
  const uses = [];
  const items = [];
  for (const sp of specs) {
    const recs = [];
    collectRecs(sp.rec, recs, new Set());
    for (const r of recs) uses.push(`${sp.mod}::${r.name}`);
    items.push(`#[rustfmt::skip]\npub fn ${sp.fn}(r: &${sp.rec.name}) -> String {\n    let mut out = Vec::new();\n    ${snake(sp.rec.name)}_into(r, &mut out);\n    out.join(";")\n}`);
    for (const r of recs) items.push(recInto(r));
  }
  const imports = uses.map((u) => `#[rustfmt::skip]\nuse crate::generated::${u};`);
  return `${[
    header('the canonical token form of the mint rows and the shipped enemy rows (the golden vectors write these tokens)'),
    ...imports,
    '#[rustfmt::skip]\nuse crate::vectors_canon as vc;',
    ...items,
  ].join('\n\n')}\n`;
}

/** Every struct a type uses, once each, in creation order. */
function collectRecs(d, out, seen) {
  if (d.t === 'rec') {
    if (seen.has(d.name)) throw new Error(`rust-data: two types are named ${d.name}`);
    seen.add(d.name);
    out.push(d);
    for (const f of d.fields) collectRecs(f.d, out, seen);
  } else if (d.t === 'tuple') {
    for (const e of d.of) collectRecs(e, out, seen);
  } else if (d.of) {
    collectRecs(d.of, out, seen);
  }
}

function structText(d) {
  if (d.fields.length === 0) return `#[derive(Debug, Clone, Copy, PartialEq)]\npub struct ${d.name} {}`;
  const names = new Set();
  const lines = [`#[derive(Debug, Clone, Copy, PartialEq)]`, `pub struct ${d.name} {`];
  for (const f of d.fields) {
    const n = fieldName(f.key);
    if (names.has(n)) throw new Error(`rust-data: two fields of ${d.name} are named ${n}`);
    names.add(n);
    lines.push(`    pub ${n}: ${ty(f.d)},`);
  }
  lines.push('}');
  return lines.join('\n');
}

const header = (from) => [
  '// generated by tools/rust-data.mjs - do not edit',
  `// source: ${from}`,
  // Already wrapped as rustfmt wraps it (the one-line form is over 100 columns), so `cargo fmt` is a no-op on
  // generated files and `--check` agrees with what is committed.
  '#![allow(',
  '    clippy::approx_constant,',
  '    clippy::excessive_precision,',
  '    clippy::type_complexity',
  ')]',
].join('\n');

function emitModule(src) {
  const names = src.names ?? Object.keys(src.mod).sort();
  const recs = [];
  const seen = new Set();
  const items = [];
  const dropped = [];
  for (const name of names) {
    const raw = src.mod[name];
    if (raw === undefined) throw new Error(`rust-data: ${src.from} has no export \`${name}\``);
    if (typeof raw === 'function') {
      dropped.push(name);
      continue;
    }
    const v = normalize(raw, [name]);
    // `hints` fixes the type of a table whose data cannot show it (an object that is empty today but is a keyed list).
    const d = src.hints?.[name] ?? (src.force ? forceOpt(describe([v], [name])) : describe([v], [name]));
    DESCS.set(`${src.file}:${name}`, d);
    collectRecs(d, recs, seen);
    const scalar = d.t === 'f64' || d.t === 'bool' || d.t === 'str';
    items.push(`#[rustfmt::skip]\n${scalar ? 'pub const' : 'pub static'} ${toConst(name)}: ${ty(d).replaceAll("&'static ", '&')} = ${lit(d, v, [name])};`);
  }
  if (src.extra) items.push(...src.extra());
  const blocks = [header(src.from), ...recs.map(structText), ...items];
  return { text: `${blocks.join('\n\n')}\n`, dropped };
}

function emitModSettings() {
  // target.js `shippedOn`: the three mods whose shipped `Enabled` default the model reads.
  const vendors = ['pcaao', meanerMonsters.MEANER_MONSTERS_VENDOR, dexInstall.DEX_VENDOR];
  const rows = vendors.map((vendor) => {
    const on = modSettings.MOD_SETTINGS[vendor]?.keys?.Enabled?.default;
    if (typeof on !== 'boolean') throw new Error(`rust-data: MOD_SETTINGS[${vendor}].keys.Enabled.default is not a boolean`);
    return `(${rustStr(vendor)}, ${on})`;
  });
  return `${[
    header(`${V}/systems/modSettings.js (only the Enabled defaults that src/target.js reads)`),
    `#[rustfmt::skip]\npub static MOD_ENABLED_DEFAULTS: &[(&str, bool)] = &[${rows.join(', ')}];`,
  ].join('\n\n')}\n`;
}

function buildFiles() {
  if (equip.EQUIP_SLOTS !== paperdoll.EQUIP_SLOTS) {
    throw new Error('rust-data: systems/equip.js EQUIP_SLOTS is not characters/paperdoll/paperdoll.js EQUIP_SLOTS');
  }
  const files = new Map();
  const dropped = [];
  for (const src of SOURCES) {
    const { text, dropped: d } = emitModule(src);
    files.set(`${src.file}.rs`, text);
    if (d.length) dropped.push(`${src.file}: ${d.join(', ')}`);
  }
  files.set('mod_settings.rs', emitModSettings());
  files.set('canon_rows.rs', emitCanon());
  const modules = [...files.keys()].map((f) => f.slice(0, -3)).sort();
  files.set('mod.rs', [
    '// generated by tools/rust-data.mjs - do not edit',
    '//! Generated data tables of the Rust port (milestone R2): one module per JS source. See `rust/README.md`.',
    '',
    ...modules.map((m) => `pub mod ${m};`),
  ].join('\n') + '\n');
  return { files, dropped };
}

const { files, dropped } = buildFiles();

// Importing this module (tools/rust-vectors.mjs does) evaluates the tables above but writes nothing: only a direct run does.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain && process.argv.includes('--check')) {
  const stale = [...files].filter(([name, text]) => {
    const p = join(genDir, name);
    return !existsSync(p) || readFileSync(p, 'utf8') !== text;
  }).map(([name]) => name);
  const unknown = existsSync(genDir)
    ? readdirSync(genDir).filter((n) => n.endsWith('.rs') && !files.has(n)).sort()
    : [];
  if (stale.length || unknown.length) {
    if (stale.length) console.error(`rust-data: generated files are missing or stale: ${stale.join(', ')}`);
    if (unknown.length) console.error(`rust-data: unknown .rs files in rust/dfo-core/src/generated: ${unknown.join(', ')}`);
    console.error('rust-data: run `node tools/rust-data.mjs` from the repository root and commit the result.');
    process.exit(1);
  }
  console.log(`rust-data: ${files.size} generated files are up to date`);
} else if (isMain) {
  mkdirSync(genDir, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(genDir, name), text);
  console.log(`rust-data: wrote ${files.size} files to rust/dfo-core/src/generated/`);
  for (const line of dropped) console.log(`rust-data: functions not in the tables: ${line}`);
  for (const line of PLACEHOLDERS) console.log(`rust-data: untyped slot given a placeholder: ${line}`);
}
