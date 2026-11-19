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
import { dirname, join } from 'node:path';
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

const V = 'vendor/upstream/a3eb1605/src';
const here = dirname(fileURLToPath(import.meta.url));
const genDir = join(here, '..', 'rust', 'dfo-core', 'src', 'generated');

/** One generated module per entry. `names: null` takes every export (sorted); otherwise the listed exports, in order. */
const SOURCES = [
  { file: 'data', from: 'src/data.js', mod: data, names: null },
  { file: 'enchant_data', from: 'src/enchantData.js', mod: enchantData, names: null },
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
  { file: 'enemy_groups', from: `${V}/combat/enemyGroups.js`, mod: enemyGroups, names: ['ENEMY_GROUPS'] },
  {
    file: 'enemy_equipment',
    from: `${V}/combat/enemyEquipment.js`,
    mod: enemyEquipment,
    names: ['ARMOR_ENUM', 'ARMOR_MATERIAL', 'MATERIALS_BY_MODIFIER', 'WEAPONS_ENUM'],
  },
  { file: 'armor_materials', from: `${V}/systems/armorMaterials.js`, mod: armorMaterials, names: ['SHIELD_PARTS'] },
  { file: 'boss_traits', from: `${V}/systems/bossTraits.js`, mod: bossTraits, names: ['ELEMENT_TRAITS', 'RESIST_SHARE', 'WEAPON_RESIST_SHARE'] },
  { file: 'enchantments', from: `${V}/systems/enchantments.js`, mod: enchantments, names: ['ENCHANTMENT_TYPES', 'LOW_DAMAGE_VS', 'POTENT_VS_DAMAGE'] },
  { file: 'paperdoll', from: `${V}/characters/paperdoll/paperdoll.js`, mod: paperdoll, names: ['EQUIP_SLOTS'] },
  { file: 'level_cap', from: `${V}/systems/levelCap.js`, mod: levelCap, names: ['LEVEL_CAP'] },
  { file: 'loot_rarity', from: `${V}/systems/loot/lootRarity.js`, mod: lootRarity, names: ['AFFIX_COUNTS', 'AFFIX_IDS', 'AFFIX_KINDS', 'AFFIX_RANGES'] },
  { file: 'loot_powers', from: `${V}/systems/loot/lootPowers.js`, mod: lootPowers, names: ['POTENCY_CAP', 'SPELL_POWER_MOST'] },
  { file: 'gate_boss', from: `${V}/world/gate/gateBoss.js`, mod: gateBoss, names: ['BOSS_ARMOR'] },
  { file: 'bow_bloom', from: `${V}/combat/bowBloom.js`, mod: bowBloom, names: ['BOW_FAST'] },
  { file: 'hands_law', from: `${V}/combat/twoHands/handsLaw.js`, mod: handsLaw, names: ['DUAL', 'OFF_HAND_BLOW'] },
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
function normalize(v, path) {
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
function describe(vals, path, nullish = false) {
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
  '#![allow(clippy::approx_constant, clippy::excessive_precision)]',
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
    const d = describe([v], [name]);
    collectRecs(d, recs, seen);
    const scalar = d.t === 'f64' || d.t === 'bool' || d.t === 'str';
    items.push(`#[rustfmt::skip]\n${scalar ? 'pub const' : 'pub static'} ${toConst(name)}: ${ty(d).replaceAll("&'static ", '&')} = ${lit(d, v, [name])};`);
  }
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

if (process.argv.includes('--check')) {
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
} else {
  mkdirSync(genDir, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(genDir, name), text);
  console.log(`rust-data: wrote ${files.size} files to rust/dfo-core/src/generated/`);
  for (const line of dropped) console.log(`rust-data: functions not in the tables: ${line}`);
  for (const line of PLACEHOLDERS) console.log(`rust-data: untyped slot given a placeholder: ${line}`);
}
