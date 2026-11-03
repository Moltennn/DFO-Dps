/*
 * dfo-dps - read a DFO Online save as a character the combat model can use.
 *
 * SaveData.txt is DFO's own JSON envelope. It stores BASE stats and skills;
 * item affixes, enchantments and active effects are separate records, and the
 * game rebuilds its derived channels (`_mods`, `_enchantMods`, the equip table)
 * when it loads. This file does the same rebuild for the fields the DPS model
 * reads, following systems/save/save.js and systems/entityMods.js.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RACE_NAMES, SKILL_NAMES, SKILLS } from './data.js';

export function userDataDir(home = os.homedir()) {
  if (process.env.DAGGER_USER_DATA) return path.resolve(process.env.DAGGER_USER_DATA);
  const env = process.platform === 'win32'
    ? process.env.APPDATA
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  const base = env || path.join(home, '.config');
  return path.join(base, 'Daggerfall JavaScript');
}

export function savesDir(home = os.homedir()) {
  return path.join(userDataDir(home), 'Saves');
}

/** All SAVE* folders that have a SaveData.txt, newest first. */
export function listSaves(home = os.homedir()) {
  const dir = savesDir(home);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    const folder = path.join(dir, name);
    const data = path.join(folder, 'SaveData.txt');
    if (!fs.existsSync(data)) continue;
    let info = null;
    try { info = JSON.parse(fs.readFileSync(path.join(folder, 'SaveInfo.txt'), 'utf8')); } catch { /* optional */ }
    const stat = fs.statSync(data);
    out.push({
      slot: name,
      folder,
      file: data,
      mtime: stat.mtimeMs,
      name: info?.saveName || name,
      character: info?.characterName || '',
      date: info?.dateAndTime?.realTime ?? null,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Resolve a save argument: a path, a SAVE folder name, or a slot number. */
export function resolveSave(ref, home = os.homedir()) {
  const saves = listSaves(home);
  if (!ref) {
    if (!saves.length) throw new Error(`no saves found under ${savesDir(home)}`);
    return saves[0];
  }
  const asPath = path.resolve(String(ref));
  if (fs.existsSync(asPath)) {
    if (fs.statSync(asPath).isDirectory()) {
      const file = path.join(asPath, 'SaveData.txt');
      if (!fs.existsSync(file)) throw new Error(`${file} not found`);
      return { slot: path.basename(asPath), folder: asPath, file, mtime: 0, name: '', character: '', date: null };
    }
    return { slot: path.basename(path.dirname(asPath)), folder: path.dirname(asPath), file: asPath, mtime: 0, name: '', character: '', date: null };
  }
  const wanted = /^\d+$/.test(String(ref)) ? `SAVE${ref}` : String(ref).toUpperCase();
  const hit = saves.find((s) => s.slot.toUpperCase() === wanted);
  if (!hit) {
    throw new Error(`save "${ref}" not found. Available: ${saves.map((s) => s.slot).join(', ') || '(none)'}`);
  }
  return hit;
}

export function loadSave(ref, home = os.homedir()) {
  const entry = resolveSave(ref, home);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(entry.file, 'utf8')); } catch (e) {
    throw new Error(`could not read ${entry.file}: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object') throw new Error(`${entry.file} is not a save object`);
  return { entry, save: raw };
}

const ARRAY = (v) => (Array.isArray(v) ? v : []);
const NUM = (v, d = 0) => (Number.isFinite(v) ? v : d);

/** The seven paperdoll armour slots, by DFU's EQUIP_SLOTS (RightHand 19 by design). */
export const SLOT = Object.freeze({
  Head: 12, RightArm: 13, LeftArm: 15, ChestArmor: 18, RightHand: 19,
  Gloves: 20, LeftHand: 21, LegsArmor: 23, Feet: 26,
});

/** The skill a template swings with, from characters/weapons.js. */
export const WEAPON_SKILL = Object.freeze({
  113: SKILLS.ShortBlade, 114: SKILLS.ShortBlade, 115: SKILLS.BluntWeapon, 116: SKILLS.ShortBlade,
  117: SKILLS.ShortBlade, 118: SKILLS.LongBlade, 119: SKILLS.LongBlade, 120: SKILLS.LongBlade,
  121: SKILLS.LongBlade, 122: SKILLS.LongBlade, 123: SKILLS.LongBlade, 124: SKILLS.BluntWeapon,
  125: SKILLS.BluntWeapon, 126: SKILLS.BluntWeapon, 127: SKILLS.Axe, 128: SKILLS.Axe,
  129: SKILLS.Archery, 130: SKILLS.Archery,
});

/** Proficiency flag per weapon skill (systems/equip.js). */
export const PROFICIENCY_FLAG = Object.freeze({
  [SKILLS.ShortBlade]: 1, [SKILLS.LongBlade]: 2, [SKILLS.HandToHand]: 4,
  [SKILLS.Axe]: 8, [SKILLS.BluntWeapon]: 16, [SKILLS.Archery]: 32,
});

/** SOFTCAP1: a point past 100 is worth a quarter, plus the milestones. */
export function effectiveSkill(v) {
  const raw = Math.max(0, Math.min(200, Number.isFinite(v) ? v : 0));
  if (raw <= 100) return raw;
  const milestones = raw >= 200 ? 15 : raw >= 175 ? 9 : raw >= 150 ? 5 : raw >= 125 ? 2 : 0;
  return Math.floor(100 + (raw - 100) * 0.25 + milestones);
}

/** SOFTCAP3: online is always in force; offline the saved switch decides. */
export function masterSkillsActive(ch) {
  return ch.online === true || ch.masterSkills === true;
}

/** Only a mastered skill may read past 100 (SOFTCAP4). */
export function masterCappedSkill(ch, id, raw) {
  if (!masterSkillsActive(ch)) return Math.min(raw, 100);
  if (id == null) return raw;
  return ARRAY(ch.masteredSkills).includes(id) ? raw : Math.min(raw, 100);
}

/** Skill mods on top of the softcap: gear, the enchantment channel, racial effects. */
export function skillModOf(ch, id) {
  let mod = (ch._enchantMods?.skillMods?.[id] ?? 0) + (ch._mods?.skills?.[id] ?? 0);
  for (const a of ch.activeEffects ?? []) {
    if (a?.kind === 'racialOverride' && !a.ended) mod += a.skillMods?.[id] ?? 0;
  }
  return mod;
}

/** What a formula reads (skills.js skillValue). */
export function skillValue(ch, id) {
  const raw = ch.skills?.[id] ?? 0;
  return effectiveSkill(masterCappedSkill(ch, id, raw)) + skillModOf(ch, id);
}

/** Attribute stat mods from effects and gear (systems/statMods.js liveStat). */
export function liveStat(ch, name) {
  const base = NUM(ch.stats?.[name]);
  let mod = 0;
  for (const a of ch.activeEffects ?? []) {
    if (!a || a.ended) continue;
    if (a.kind === 'disease' || a.kind === 'poison') { mod += a.statMods?.[name] ?? 0; continue; }
    if (a.kind === 'racialOverride') { const v = a.statMods?.[name] ?? 0; if (v > 0) mod += v; continue; }
    if (a.kind === 'artifact') { mod += a.statMods?.[name] ?? 0; continue; }
    if (a.kind === 'fortifyAttribute' && a.stat === name) mod += a.magnitude ?? 0;
    else if ((a.kind === 'drainAttribute' || a.kind === 'transferAttribute') && a.stat === name) mod -= a.magnitude ?? 0;
  }
  mod += ch._mods?.stats?.[name] ?? 0;
  return Math.max(0, Math.min(100, base + mod));
}

function addMap(obj, key, value) {
  if (!key || !Number.isFinite(value)) return;
  obj[key] = (obj[key] ?? 0) + value;
}

/** Rebuild the modifier channels from worn gear (entityMods + lootRarity). */
export function rebuildMods(items) {
  const stats = {};
  const skills = {};
  let weaponDamagePct = 0;
  const slayer = {};
  const armoredParts = new Array(7).fill(0);
  for (const it of items) {
    if (!it || it.equipSlot == null) continue;
    for (const a of ARRAY(it.affixes)) {
      if (!a || !Number.isFinite(a.value)) continue;
      switch (a.id) {
        case 'stat': addMap(stats, a.param, a.value); break;
        case 'skill': addMap(skills, a.param, a.value); break;
        case 'damage': if (it.group === 'Weapons') weaponDamagePct += a.value; break;
        case 'slayer': addMap(slayer, a.param, a.value); break;
        case 'armor': for (let i = 0; i < 7; i++) armoredParts[i] += a.value; break;
        default: break;
      }
    }
  }
  return { stats, skills, weaponDamagePct, slayer, armoredParts };
}

/**
 * Build the character the model consumes.
 *
 * opts.online       DFO Online rules (master skills, weapon mastery). Default true.
 * opts.martialPath  override the saved path (null in most saves).
 * opts.passiveOn    false switches the path's passive off for the simulation.
 */
export function characterFromSave(save, { online = true, martialPath, ...opts } = {}) {
  const stats = {};
  for (const k of ['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck']) {
    stats[k] = NUM(save.stats?.[k], 0);
  }
  const skills = ARRAY(save.skills).map((v) => NUM(v, 0));
  const items = ARRAY(save.items).map((it) => ({ ...it }));
  // A live snapshot carries the game's real equip table (`equip.slots`). The save's
  // `items[].equipSlot` can be stale or include packed pieces, so prefer the table:
  // its item affixes are what the live Combat Stats card reads.
  const liveWorn = save.equipSlots && typeof save.equipSlots === 'object'
    ? Object.entries(save.equipSlots)
      .filter(([, it]) => it && typeof it === 'object')
      .map(([slot, it]) => ({ ...it, equipSlot: Number(slot) }))
    : null;
  const worn = liveWorn ?? items.filter((it) => Number.isInteger(it?.equipSlot) && it.equipSlot >= 0);
  const mods = liveWorn
    ? rebuildMods(liveWorn)
    : (save._mods ? { stats: save._mods.stats ?? {}, skills: save._mods.skills ?? {} } : rebuildMods(items));
  const legendaries = worn.filter((it) => it?.legendary).map((it) => ({ id: it.legendary, name: it.name }));
  const right = worn.find((it) => it.group === 'Weapons' && it.equipSlot === SLOT.RightHand)
    ?? worn.find((it) => it.group === 'Weapons' && it.equipSlot === SLOT.LeftHand)
    ?? null;
  const ch = {
    name: save.name || 'Adventurer',
    level: NUM(save.level, 1),
    raceId: NUM(save.raceId, 0),
    race: save.race || '',
    gender: save.gender || '',
    career: save.career ?? null,
    reflexes: NUM(save.reflexes, 2),
    health: NUM(save.health, 1),
    maxHealth: NUM(save.maxHealth, Math.max(1, NUM(save.health, 1))),
    stats,
    skills,
    activeEffects: ARRAY(save.activeEffects).map((a) => ({ ...a })),
    masterSkills: save.masterSkills === true,
    masteredSkills: ARRAY(save.masteredSkills),
    martialPath: martialPath !== undefined ? martialPath : (save.martialPath ?? null),
    online: online !== false,
    weapon: right,
    items,
    worn,
    _mods: liveWorn ? { stats: mods.stats, skills: mods.skills } : (save._mods ? { ...save._mods, stats: { ...(save._mods.stats ?? {}) }, skills: { ...(save._mods.skills ?? {}) } } : { stats: mods.stats, skills: mods.skills }),
    _enchantMods: save._enchantMods ? { ...save._enchantMods, skillMods: { ...(save._enchantMods.skillMods ?? {}) } } : { skillMods: {}, chanceToHitMod: 0 },
    weaponDamagePct: mods.weaponDamagePct,
    slayer: mods.slayer,
    legendaries,
    saveSlot: opts.slot ?? null,
    saveFile: opts.file ?? null,
  };
  return ch;
}

/** A one-line label for the character. */
export function characterLabel(ch) {
  const race = RACE_NAMES[ch.raceId] ?? ch.race ?? '';
  const career = ch.career?.name ? ` ${ch.career.name}` : '';
  return `${ch.name} - ${race}${career}, level ${ch.level}`;
}

export function skillName(id) {
  return SKILL_NAMES[id] ?? String(id);
}
