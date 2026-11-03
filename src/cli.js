/*
 * dfo-dps - command line.
 *
 *   dfo-dps build   [--save SAVE4] [--target boss] [--traits curbing] [--health 5000]
 *   dfo-dps rank weapons [--save SAVE4] [--top 20]
 *   dfo-dps report  [--save SAVE4] [--out report.html]
 *   dfo-dps compare [--save SAVE4] --stat strength=110
 *   dfo-dps saves
 *   dfo-dps doctor
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  BOSS_TRAIT_TEXT, GATE_SHIELDS, GATE_SHIELD_S, MARTIAL_PATHS, MATERIALS, RACE_NAMES, SKILLS, SOURCE, WEAPONS,
  gateHealth, gateHitCap,
} from './data.js';
import { buildReport } from './report.js';
import { barChart, graphPage, lineChart, multiGraphPage } from './graph.js';
import { analyzeSpell, resolveSpells, spellCost, spellRotation, standardSpells } from './spells.js';
import { ENCHANTMENT_TYPES, castWhenStrikes, enchantDps, procsBeforeBreak, strikeEnchantments } from './enchants.js';
import { perfectSockets } from './sockets.js';
import {
  DAMAGE_AFFIX_MAX, DEFAULT_BLADE, GEAR_CS_LINES, GEAR_H2H_LINES, GEAR_LB_LINES, GEAR_LINE_MAX, GEAR_MASTERY_POINTS,
  GEAR_SKILL_LINES, LONG_BLADES,
  THEORY_CAPS, THEORY_LEVEL, THEORY_RACES, theoryBlade, theoryCharacter, theoryFists,
} from './theory.js';
import {
  analyze, bossTarget, currentWeaponRow, gateTarget, marginals, rankAffixes, rankWeapons, referenceFoe,
  syntheticWeapon, weaponOf,
} from './model.js';
import {
  characterFromSave, characterLabel, effectiveSkill, listSaves, liveStat, loadSave, resolveSave,
  skillName, skillValue,
} from './save.js';

const HELP = `dfo-dps - DFO Online combat DPS and build lab

Usage:
  dfo-dps build  [options]            one build against one target (default)
  dfo-dps rank weapons [options]      rank every melee template/material
  dfo-dps report [options]            write a single-file HTML report
  dfo-dps compare [options]           baseline vs one change
  dfo-dps scale [options]             stat/skill scaling curve to the caps
  dfo-dps tradeoff [options]          speed vs damage against real boss pools
  dfo-dps theory [options]            level-45 long-blade ceiling and minmax curves
  dfo-dps spell [options]             one spell: damage, cost, casts and sustain
  dfo-dps spells [options]            HTML page: every standard damage spell
  dfo-dps enchant [options]           the equipped weapon's enchantment procs
  dfo-dps weapons [options]           HTML page: all weapons, max DPS and skill scaling
  dfo-dps skills [options]            same page (alias)
  dfo-dps graph [options]             SVG line chart of two or more stats/skills
  dfo-dps saves                       list saves under the DFO user data folder
  dfo-dps doctor                      show save/build/ruleset information

Common options:
  --save <SAVE4|path>                 save slot or SaveData.txt (default: newest)
  --target <soft|tough|armoured|human|boss|gate>  reference foe or the real gate boss (default: armoured)
  --level <n>                         target level (default: character level)
  --armor <n>                         boss armor value (default: 0)
  --health <n>                        boss maximum health (default: 5000)
  --traits <a,b>                      boss traits (curbing, warded, bladeturning, ...)
  --core <overhaul|classic>           combat core (default: overhaul)
  --offline                           offline rules (past-100 skills read as 100)
  --weapon <template:material>        override the equipped weapon (e.g. 121:9)
  --swing <StrikeLeft|StrikeUp|...>   swing direction (default: StrikeLeft)
  --passive <path|none>               martial path override
  --stacks <0-5>                      Flowing Steel stacks (default: 5)
  --rhythm                            War Rhythm is up (Warblade)
  --unaware                           target has not noticed you (Cutthroat)
  --first-blow                        first blow at this foe (Assassin / Opening Strike)
  --behind                            every swing is from behind (backstab x3)
  --backstab <0..1>                   share of swings from behind (expected backstab)
  --players <n>                       gate boss group size (health per player; default 1)
  --blow-x <n>                        gate relayBlowX (Elite/Vestiges cap multiplier; default 1)
  --pair                              paired Pistolets (2 shots per cycle, off hand x0.8)
  --dual                              dual wield the left-hand weapon (off hand x0.8, -5 hit)
  --spam                              bow spam (BOW_FAST stacks to x0.2; default paced)
  --health-share <0..1>               foe's health share for Axe/Blunt mastery (default: 1)
  --no-crit-damage                    overhaul crit adds hit only
  --no-passive                        switch the path passive off
  --bare                              strip gear affixes/enchants/legendaries (theorycraft baseline)
  --base-stats <n>                    set all eight base attributes to n (theorycraft baseline)
  --no-effects                        drop active effects too (with --bare, a truly naked baseline)
  --stat <name>                       scale one attribute (with scale)
  --skill <id>                        scale one raw skill id (with scale)
  --gear-skill <id>                   scale one gear skill affix (with scale)
  --from <n> --to <n> --step <n>      scale range (default: current to cap)
  --all                               scale/compare every relevant channel
  --theory                            use the level-45 theory character (caster for spell/spells)
  --race <name>                       theory race (darkelf, redguard, nord, ...)
  --blade <template>                  theory long blade (default 123, Dai-katana)
  --gear-lines <n>                    theory gear skill lines (default 26: 8 LB + 18 crit)
  --line-points <n>                   points per skill line (default 30, legendary max)
  --gear-lb <n> --gear-cs <n>         theory gear points on Long Blade / Critical Strike
  --vampire                           add the vampire +30 Critical Strike
  --firmament                         apply the +15 channel ceiling to STR/AGI/SPEED/LUCK and LB/CS/Backstab
  --star-stat <name=n,...>            Firmament attribute points (max +15 each)
  --star-skill <id=n,...>             Firmament skill points (max +15 each)
  --star-damage <pct>                 Firmament weapon-blow percent (cap +30)
  --spell <index|name>                spell to price (with spell)
  --list                              list the resolved spellbook (with spell)
  --all-spells                        price every damaging spell (with spell)
  --standard                          include every standard spell, not just the spellbook
  --potency <pct>                     spell power percent (potency / Firmament)
  --pierce <n>                        points off the target's saving throw
  --cast-speed <pct>                  cast speed percent
  --magicka <n>                       override the magicka pool
  --seconds <n>                       fight length for spell sustain (default 30)
  --mana-limit                        price the magicka pool (default: mana is solved)
  --data <dir>                        ARENA2 directory holding SPELLS.STD
  --series <a,b>                      graph series: stat:strength,skill:29,gear:29,star:strength
  --uncapped                          graph raw DPS instead of gate-capped DPS
  --no-rri                            use the vanilla swing law instead of RRI weapon balance
  --damage-pct <n>                    add N% weapon damage (theorycraft)
  --json                              machine-readable output
  --top <n>                           rows in a ranking (default: 20)
  --out <file>                        report output (default: dfo-dps-report.html)
  -h, --help
`;

const optsSpec = {
  save: { type: 'string' },
  target: { type: 'string', default: 'armoured' },
  level: { type: 'string' },
  armor: { type: 'string' },
  health: { type: 'string' },
  traits: { type: 'string' },
  core: { type: 'string', default: 'overhaul' },
  offline: { type: 'boolean', default: false },
  weapon: { type: 'string' },
  swing: { type: 'string', default: 'StrikeLeft' },
  passive: { type: 'string' },
  stacks: { type: 'string', default: '5' },
  rhythm: { type: 'boolean', default: false },
  unaware: { type: 'boolean', default: false },
  'first-blow': { type: 'boolean', default: false },
  'health-share': { type: 'string' },
  bare: { type: 'boolean', default: false },
  'base-stats': { type: 'string' },
  'no-effects': { type: 'boolean', default: false },
  behind: { type: 'boolean', default: false },
  backstab: { type: 'string' },
  players: { type: 'string', default: '1' },
  'blow-x': { type: 'string', default: '1' },
  pair: { type: 'boolean', default: false },
  dual: { type: 'boolean', default: false },
  spam: { type: 'boolean', default: false },
  series: { type: 'string' },
  uncapped: { type: 'boolean', default: false },
  theory: { type: 'boolean', default: false },
  race: { type: 'string' },
  blade: { type: 'string' },
  'gear-lines': { type: 'string' },
  'line-points': { type: 'string' },
  'gear-lb': { type: 'string' },
  'gear-cs': { type: 'string' },
  vampire: { type: 'boolean', default: false },
  firmament: { type: 'boolean', default: false },
  'star-stat': { type: 'string', multiple: true },
  'star-skill': { type: 'string', multiple: true },
  'star-damage': { type: 'string' },
  spell: { type: 'string' },
  list: { type: 'boolean', default: false },
  'all-spells': { type: 'boolean', default: false },
  standard: { type: 'boolean', default: false },
  potency: { type: 'string', default: '0' },
  pierce: { type: 'string', default: '0' },
  'cast-speed': { type: 'string', default: '0' },
  magicka: { type: 'string' },
  seconds: { type: 'string' },
  'mana-limit': { type: 'boolean', default: false },
  data: { type: 'string' },
  'no-rri': { type: 'boolean', default: false },
  all: { type: 'boolean', default: false },
  from: { type: 'string' },
  to: { type: 'string' },
  step: { type: 'string', default: '10' },
  skill: { type: 'string' },
  'gear-skill': { type: 'string' },
  'damage-pct': { type: 'string' },
  'no-crit-damage': { type: 'boolean', default: false },
  'no-passive': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  top: { type: 'string', default: '20' },
  out: { type: 'string', default: 'dfo-dps-report.html' },
  stat: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h', default: false },
};

const weaponLabel = (w) => (w ? (String(w.name).startsWith(String(w.materialName)) ? w.name : `${w.materialName} ${w.name}`) : 'bare hands');
const n = (v, d = 0) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
const fmt = (v) => (Number.isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : '-');
const fmt2 = (v) => (Number.isFinite(v) ? (Math.round(v * 100) / 100).toFixed(2) : '-');
const pc = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '-');

function table(rows, headers, aligns = []) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells, pad = ' ') => cells.map((c, i) => {
    const s = String(c ?? '');
    return aligns[i] === 'right' ? s.padStart(widths[i], pad) : s.padEnd(widths[i], pad);
  }).join('  ').replace(/\s+$/, '');
  const out = [line(headers), line(headers.map((h) => '-'.repeat(h.length)))];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

function loadCharacter(values) {
  if (values.theory) {
    let blade = n(values.blade, DEFAULT_BLADE);
    let material = 9;
    if (values.weapon) {
      const [tpl, mat] = String(values.weapon).split(':').map(Number);
      if (WEAPONS[tpl]) blade = tpl;
      if (Number.isFinite(mat)) material = mat;
    }
    const { starStats, starSkills } = starOptions(values);
    let ch = theoryCharacter({
      level: n(values.level, THEORY_LEVEL),
      race: values.race ?? 'darkelf',
      blade,
      material,
      gearLB: n(values['gear-lb'], GEAR_LB_LINES * GEAR_LINE_MAX),
      gearCS: n(values['gear-cs'], GEAR_CS_LINES * GEAR_LINE_MAX),
      damagePct: n(values['damage-pct'], DAMAGE_AFFIX_MAX),
      vampire: values.vampire,
      starStats,
      starSkills,
      starDamage: values['star-damage'] != null ? n(values['star-damage'], 0) : (values.firmament ? 30 : 0),
    });
    if (values['no-effects']) ch.activeEffects = [];
    if (values['base-stats'] != null) {
      const v = n(values['base-stats'], 50);
      for (const k of ['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck']) ch.stats[k] = v;
    }
    return { ch, entry: null, save: null };
  }
  const { entry, save } = loadSave(values.save);
  let ch = characterFromSave(save, {
    online: !values.offline,
    slot: entry.slot,
    file: entry.file,
    martialPath: values.passive !== undefined
      ? (values.passive === 'none' ? null : values.passive)
      : undefined,
  });
  if (values.bare) ch = bareCharacter(ch);
  if (values['no-effects']) ch.activeEffects = [];
  if (values['base-stats'] != null) {
    const v = n(values['base-stats'], 50);
    for (const k of ['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck']) ch.stats[k] = v;
  }
  return { ch, entry, save };
}

function bareCharacter(ch) {
  const c = JSON.parse(JSON.stringify(ch));
  c._mods = { stats: {}, skills: {} };
  c._enchantMods = { skillMods: {}, chanceToHitMod: 0 };
  c.legendaries = [];
  if (c.weapon) c.weapon = { ...c.weapon, affixes: [] };
  return c;
}

function traitsOf(values) {
  return String(values.traits ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const STAT_KEYS = ['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck'];
const FIRM_CHANNEL_MAX = 15;
const FIRM_PRESET_STATS = Object.freeze({ strength: 15, agility: 15, speed: 15, luck: 15 });
const FIRM_PRESET_SKILLS = Object.freeze({ 29: 15, 34: 15, 19: 15 });

function starOptions(values) {
  const starStats = { ...(values.firmament ? FIRM_PRESET_STATS : {}) };
  const starSkills = { ...(values.firmament ? FIRM_PRESET_SKILLS : {}) };
  const pairs = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  for (const part of pairs(values['star-stat'])) {
    const m = /^([a-z]+)=(-?\d+)$/i.exec(part);
    if (!m) throw new Error(`--star-stat expects name=value, got ${part}`);
    const key = m[1].toLowerCase();
    if (!STAT_KEYS.includes(key)) throw new Error(`unknown attribute ${key}`);
    const v = Number(m[2]);
    if (!(v >= -FIRM_CHANNEL_MAX && v <= FIRM_CHANNEL_MAX)) throw new Error(`Firmament attribute channel is capped at +-${FIRM_CHANNEL_MAX}`);
    starStats[key] = v;
  }
  for (const part of pairs(values['star-skill'])) {
    const m = /^(\d+)=(-?\d+)$/.exec(part);
    if (!m) throw new Error(`--star-skill expects id=value, got ${part}`);
    const id = Number(m[1]);
    if (!(id >= 0 && id < 35)) throw new Error(`bad skill id ${id}`);
    const v = Number(m[2]);
    if (!(v >= -FIRM_CHANNEL_MAX && v <= FIRM_CHANNEL_MAX)) throw new Error(`Firmament skill channel is capped at +-${FIRM_CHANNEL_MAX}`);
    starSkills[id] = v;
  }
  return { starStats, starSkills };
}

function targetOf(ch, values, traits) {
  const level = n(values.level, ch.level);
  const target = String(values.target ?? 'armoured').toLowerCase() === 'armoured' && values.theory
    ? 'gate'
    : String(values.target ?? 'armoured').toLowerCase();
  if (target === 'gate' || target === 'ruhn') {
    return gateTarget(level, { health: n(values.health, gateHealth(level)), traits, players: n(values.players, 1), blowX: n(values['blow-x'], 1) });
  }
  if (target === 'boss') {
    return bossTarget({
      level,
      armorValue: n(values.armor, 0),
      health: n(values.health, 5000),
      traits,
    });
  }
  return referenceFoe(level, target);
}

function weaponOverride(values) {
  if (!values.weapon) return undefined;
  const [tpl, mat] = String(values.weapon).split(':').map(Number);
  if (!WEAPONS[tpl]) throw new Error(`unknown weapon template ${tpl}. Melee templates: ${Object.keys(WEAPONS).join(', ')}`);
  return syntheticWeapon(tpl, Number.isFinite(mat) ? mat : 9);
}

function scenarioOf(ch, values, traits, target) {
  return {
    target,
    core: values.core === 'classic' ? 'classic' : 'overhaul',
    rri: !values['no-rri'],
    traits,
    health: target.isBoss ? target.maxHealth : n(values.health, 0),
    swing: values.swing,
    critDamage: !values['no-crit-damage'],
    passiveOn: !values['no-passive'],
    stacks: n(values.stacks, 5),
    rhythm: values.rhythm,
    unaware: values.unaware,
    firstBlow: values['first-blow'],
    healthShare: n(values['health-share'], 1),
    backstabUptime: values.behind ? 1 : n(values.backstab, 0),
    firmamentDamagePct: ch.firmamentDamagePct ?? 0,
    pair: values.pair,
    dual: values.dual,
    bowSpam: values.spam,
    potencyPct: n(values.potency, 0),
    pierce: n(values.pierce, 0),
    weapon: values.theory ? undefined : weaponOverride(values),
  };
}

function summary(ch, r, extra = {}) {
  return {
    character: {
      name: ch.name, level: ch.level, race: RACE_NAMES[ch.raceId] ?? ch.race, career: ch.career?.name ?? null,
      path: ch.martialPath, online: ch.online,
      stats: Object.fromEntries(['strength', 'agility', 'speed', 'luck', 'endurance', 'willpower']
        .map((k) => [k, liveStat(ch, k)])),
      skills: {
        weapon: skillValue(ch, r.weapon?.skillId ?? 30),
        critical: skillValue(ch, 34),
        dodging: skillValue(ch, 20),
      },
    },
    weapon: r.weapon ? {
      name: r.weapon.name, templateIndex: r.weapon.templateIndex, material: r.weapon.materialName,
      skill: r.weapon.skill, twoHanded: r.weapon.twoHanded, condition: r.weapon.conditionPct,
      min: r.weapon.min, max: r.weapon.max,
    } : null,
    ruleset: { core: r.core, online: ch.online, mentor: false },
    target: {
      preset: extra.preset ?? null, isClass: r.target.isClass, level: r.target.level,
      group: r.target.group, armor: r.target.armorValues?.[0] ?? 0,
      health: r.health, traits: r.traits,
    },
    result: {
      hit: r.hit.hit, critChance: r.hit.crit.chance, critMult: r.hit.crit.damageMult,
      backstab: r.backstab, dual: !!r.dual, pair: !!r.pair,
      damage: { min: r.damage.min, max: r.damage.max, avg: r.damage.avg, critMin: r.damage.critMin, critMax: r.damage.critMax, critAvg: r.damage.critAvg },
      perSwing: r.perSwing, aps: r.cadence.aps, swingSeconds: r.cadence.seconds,
      dps: r.dps, dpsMin: r.dpsMin, dpsMax: r.dpsMax, cappedDps: r.cappedDps, cappedDpsMin: r.cappedDpsMin, cappedDpsMax: r.cappedDpsMax, cap: r.cap, capLoss: r.capLoss,
      enchantDps: r.enchantDps, enchantDpsMin: r.enchantDpsMin, enchantDpsMax: r.enchantDpsMax, totalDps: r.totalDps, totalDpsMin: r.totalDpsMin, totalDpsMax: r.totalDpsMax, enchantPerSwing: r.enchantPerSwing, enchantProcs: r.enchantProcs, procsBeforeBreak: r.procsBeforeBreak,
      ward: r.ward, ttk: r.ttk, totalTtk: r.totalTtk, wrath: r.wrath,
      terms: r.damage.parts,
    },
    ...extra,
  };
}

function scaleRange(values, current, cap) {
  const from = n(values.from, current);
  const to = n(values.to, cap);
  const step = Math.max(1, n(values.step, 10));
  const out = [];
  if (!(to >= from)) return out;
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  if (out[out.length - 1] !== to) out.push(to);
  return out;
}

function printScale(rows, values) {
  console.log(table(rows.map((r) => [r.label, r.value, fmt(r.dps), fmt(r.cappedDps), fmt(r.perSwing), r.ttk ? `${fmt(r.ttk)} s` : '-']), ['Channel', 'Value', 'DPS', 'Capped', 'Per swing', 'TTK'], ['left', 'right', 'right', 'right', 'right', 'right']));
}

function printBuild(ch, r, targetPreset, values) {
  const w = r.weapon;
  const traits = r.traits;
  console.log(`${characterLabel(ch)}`);
  console.log(`${weaponLabel(w)}${r.dual ? ' / dual' : ''}${r.pair ? ' / pair' : ''}  |  ${r.core}${ch.online ? ' / online' : ' / offline'}${ch.martialPath ? ` / ${MARTIAL_PATHS[ch.martialPath]?.name ?? ch.martialPath}` : ''}`);
  console.log(`target: ${targetPreset}${r.target.isClass ? ' (class)' : ''}, level ${r.target.level}${r.health ? `, ${r.health.toLocaleString()} HP` : ''}${traits.length ? `, traits: ${traits.join(', ')}` : ''}`);
  console.log('');
  console.log(table([
    ['Hit chance', pc(r.hit.hit), `${pc(r.hit.crit.chance)} critical, x${fmt2(r.hit.crit.damageMult)}`],
    ...(r.backstab?.chance > 0 ? [['Backstab', `${pc(r.backstab.chance)} x3`, r.backstab.uptime > 0 ? `uptime ${pc(r.backstab.uptime)}; expected x${fmt2(r.backstab.expectedMult)}` : 'available; use --behind']] : []),
    ['Damage / hit', `${r.damage.min}-${r.damage.max}`, `avg ${fmt(r.damage.avg)}; crit ${r.damage.critMin}-${r.damage.critMax}`],
    ...(r.backstab?.chance > 0 ? [['Backstab hit', `${r.backstab.min}-${r.backstab.max}`, `crit ${r.backstab.critMin}-${r.backstab.critMax}`]] : []),
    ['Expected / swing', fmt(r.perSwing), 'hit chance and criticals included'],
    ['Swing time', `${fmt2(r.cadence.seconds)} s`, `${fmt2(r.cadence.aps)} swings/s`],
    ['DPS', fmt(r.dps), r.cap ? `capped ${fmt(r.cappedDps)} (${pc(r.capLoss)} lost)` : 'no per-hit cap'],
    ...(r.enchantDps > 0 ? [['Enchant procs', fmt(r.enchantDps), `${fmt(r.enchantPerSwing)} per landed hit${r.procsBeforeBreak ? `; ${r.procsBeforeBreak} procs before break` : ''}`], ['Total DPS', fmt(r.totalDps), 'weapon + enchant procs']] : []),
    ['Time to kill', (r.totalTtk ?? r.ttk) ? `${fmt(r.totalTtk ?? r.ttk)} s` : '-', r.health ? `${r.health.toLocaleString()} HP${r.ward ? ` + ${r.ward} ward` : ''}${r.shields ? ` + ${r.shields}s shields` : ''}${r.enchantDps > 0 ? ' (weapon + procs)' : ''}` : 'no boss health'],
  ], ['Metric', 'Value', 'Notes']));
  if (r.cap) console.log(`\n${r.capSource === 'hit cap' ? 'Per-hit hit cap' : 'Curbing cap'}: ${r.cap} per hit${r.capSource === 'curbing' ? ` (5% of ${r.health.toLocaleString()} HP)` : ''}.`);
  if (r.target?.phaseShields) console.log(`Phase shields: ${r.target.phaseShields} x ${r.target.shieldSeconds}s (${r.shields}s added to TTK).`);
  if (r.wrath) console.log(`Wrathful: enrages at ${r.wrathAt}s.`);
  console.log('\nWhere the damage comes from');
  const p = r.damage.parts;
  console.log(table([
    ['weapon roll', `${p.roll[0]}-${p.roll[1]}`],
    ['material', `${p.matMod >= 0 ? '+' : ''}${p.matMod} (${w?.materialName ?? '-'})`],
    ['strength', `${p.strMod >= 0 ? '+' : ''}${p.strMod}${p.twoHanded ? ' (two-handed x2)' : ''}`],
    ['proficiency', `${p.prof >= 0 ? '+' : ''}${p.prof}`],
    ['race', `${p.racial >= 0 ? '+' : ''}${p.racial}`],
    ['mastery / gear', `${fmt(p.mastery)}%`],
    ['martial', `${fmt(p.martial)}%`],
    ['slayer', `${fmt(p.slayer)}%`],
    ['hit terms', `base ${r.hit.terms.base}, armor ${r.hit.terms.armour}, other ${r.hit.terms.other}`],
    ['speed', `tick ${fmt2(r.cadence.tick)}s, heft ${fmt2(r.cadence.heft)}, handling ${fmt2(r.cadence.handling)}, pace ${fmt(r.cadence.pace)}%`],
  ], ['Term', 'Value']));
  const marginalCh = values.weapon
    ? (() => { const c = JSON.parse(JSON.stringify(ch)); const w = weaponOverride(values); if (w) c.weapon = w.item; return c; })()
    : ch;
  const ms = marginals(marginalCh, r, {
    target: r.target, core: r.core, traits, health: r.health ?? 0, swing: values.swing,
    passiveOn: !values['no-passive'], stacks: n(values.stacks, 5), rhythm: values.rhythm,
    unaware: values.unaware, firstBlow: values['first-blow'], healthShare: n(values['health-share'], 1),
    backstabUptime: values.behind ? 1 : n(values.backstab, 0), critDamage: !values['no-crit-damage'], weapon: undefined,
    rri: !values['no-rri'],
  });
  console.log(`\nWhat matters (${r.cap ? 'capped DPS' : 'DPS'})`);
  console.log(table(ms.map((m) => [m.label, `${m.delta >= 0 ? '+' : ''}${fmt(m.delta)}`, `${m.delta >= 0 ? '+' : ''}${fmt(m.pct)}%`]), ['Change', r.cap ? 'Capped DPS' : 'DPS', '%'], ['left', 'right', 'right']));
  const affixes = rankAffixes(marginalCh, r, {
    target: r.target, core: r.core, traits, health: r.health ?? 0, swing: values.swing,
    passiveOn: !values['no-passive'], stacks: n(values.stacks, 5), rhythm: values.rhythm,
    unaware: values.unaware, firstBlow: values['first-blow'], healthShare: n(values['health-share'], 1),
    backstabUptime: values.behind ? 1 : n(values.backstab, 0), critDamage: !values['no-crit-damage'],
    rri: !values['no-rri'],
  });
  console.log(`\nAffixes / enchants (${r.cap ? 'capped DPS' : 'DPS'})`);
  console.log(table(affixes.map((m) => [m.label, `${m.delta >= 0 ? '+' : ''}${fmt(m.delta)}`, `${m.delta >= 0 ? '+' : ''}${fmt(m.pct)}%`]), ['Change', r.cap ? 'Capped DPS' : 'DPS', '%'], ['left', 'right', 'right']));
  const ranking = rankWeapons(ch, {
    target: r.target, core: r.core, traits, health: r.health ?? 0, swing: values.swing,
    passiveOn: !values['no-passive'], stacks: n(values.stacks, 5), rhythm: values.rhythm,
    unaware: values.unaware, firstBlow: values['first-blow'], healthShare: n(values['health-share'], 1),
    backstabUptime: values.behind ? 1 : n(values.backstab, 0), critDamage: !values['no-crit-damage'],
    rri: !values['no-rri'],
  }, { top: 8 });
  console.log('\nTop melee weapons');
  console.log(table(ranking.map((x) => [`${x.materialName} ${x.name}`, x.twoHanded ? '2H' : '1H', fmt(x.dps), fmt(x.cappedDps), fmt(x.perSwing), fmt2(x.aps)]), ['Weapon', 'Hands', 'DPS', 'Capped', 'Per swing', 'APS'], ['left', 'left', 'right', 'right', 'right', 'right']));
}

function printRank(ch, rows, values, current) {
  const all = current ? [{ ...current, current: true }, ...rows.map((r) => ({ ...r, current: false }))] : rows;
  console.log(`${characterLabel(ch)}  |  ${values.core}${ch.online ? ' / online' : ' / offline'}  |  target ${values.target}`);
  console.log('');
  console.log(table(all.map((r) => [
    r.current ? `${r.name} (equipped)` : `${r.materialName} ${r.name}`,
    r.skill, r.twoHanded ? '2H' : '1H', fmt(r.dps), fmt(r.cappedDps),
    fmt(r.perSwing), fmt2(r.aps), pc(r.hit), pc(r.crit),
  ]), ['Weapon', 'Skill', 'Hands', 'DPS', 'Capped', 'Per swing', 'APS', 'Hit', 'Crit'], ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right']));
}

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    values = parseArgs({ args: argv, options: optsSpec, allowPositionals: true, strict: true }).values;
  } catch (e) {
    console.error(e.message);
    console.error(`\n${HELP}`);
    process.exit(2);
  }
  const parsed = parseArgs({ args: argv, options: optsSpec, allowPositionals: true, strict: true });
  values = parsed.values;
  if (values.help) { console.log(HELP); return; }
  const cmd = parsed.positionals[0] ?? 'build';
  if (cmd === 'theory' || cmd === 'weapons' || cmd === 'skills') values.theory = true;

  if (cmd === 'saves') {
    const saves = listSaves();
    if (!saves.length) { console.log('No saves found.'); return; }
    console.log(table(saves.map((s) => [s.slot, s.name, s.character, new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ')]), ['Slot', 'Save', 'Character', 'Modified']));
    return;
  }

  if (cmd === 'doctor') {
    console.log(`dfo-dps  |  model ${SOURCE.repo} @ ${SOURCE.commit.slice(0, 7)} (${SOURCE.date})  |  live-checked ${SOURCE.verified}`);
    const saves = listSaves();
    console.log(`saves: ${saves.length ? saves.map((s) => s.slot).join(', ') : '(none)'}`);
    try {
      const { entry, save } = loadSave(values.save);
      const ch = characterFromSave(save, { online: !values.offline, slot: entry.slot, file: entry.file });
      console.log(`save: ${entry.file}`);
      console.log(`character: ${characterLabel(ch)}  |  ${ch.online ? 'online' : 'offline'} rules  |  path ${ch.martialPath ?? 'none'}`);
      console.log(`level ${ch.level}, reflexes ${ch.reflexes}, masterSkills ${ch.masterSkills}, mastered [${(ch.masteredSkills ?? []).map(skillName).join(', ')}]`);
      console.log(`weapon: ${ch.weapon ? `${ch.weapon.name} (${ch.weapon.templateIndex}, material ${ch.weapon.material})` : 'bare hands'}`);
      console.log(`live stats: ${['strength', 'agility', 'speed', 'luck', 'endurance', 'willpower'].map((k) => `${k} ${liveStat(ch, k)}`).join(', ')}`);
      console.log(`weapon skill: ${skillValue(ch, ch.weapon ? (weaponOf(ch.weapon)?.skillId ?? 30) : 30)} (raw ${ch.skills?.[ch.weapon ? (weaponOf(ch.weapon)?.skillId ?? 30) : 30] ?? 0})`);
      console.log(`crit skill: ${skillValue(ch, 34)} (raw ${ch.skills?.[34] ?? 0})`);
    } catch (e) {
      console.log(`save: ${e.message}`);
    }
    return;
  }

  const { ch } = loadCharacter(values);
  const traits = traitsOf(values);
  const target = targetOf(ch, values, traits);
  const scenario = scenarioOf(ch, values, traits, target);
  const r = analyze(ch, scenario);

  if (cmd === 'enchant') {
    const item = ch.weapon;
    if (!item) {
      console.log('No weapon equipped. Pass --weapon or load a save with a weapon.');
      return;
    }
    const target = values.target === 'armoured' ? gateTarget(n(values.level, ch.level), { traits }) : target;
    const opts = { level: n(values.level, ch.level), potencyPct: n(values.potency, 0), pierce: n(values.pierce, 0) };
    const rows = (item.enchantments ?? []).filter((e) => e && e.type >= 0);
    const names = Object.fromEntries(Object.entries(ENCHANTMENT_TYPES).map(([k, v]) => [v, k]));
    const strike = strikeEnchantments(item, ch, target, opts);
    const r = analyze(ch, { ...scenario, target, health: target.isBoss ? target.maxHealth : 0, potencyPct: opts.potencyPct, pierce: opts.pierce });
    console.log(`${characterLabel(ch)}  |  ${item.name ?? 'weapon'}`);
    console.log(table(rows.map((e) => [names[e.type] ?? e.type, e.param ?? '-', e.type === 2 ? (strike.procs.find((p) => p.index === Number(e.param))?.name ?? 'spell') : '-']), ['Enchantment', 'Param', 'Spell'], ['left', 'right', 'left']));
    console.log(table([
      ['Weapon DPS', fmt(r.dps)],
      ['Enchant per landed hit', fmt(strike.procDamage + strike.flat)],
      ['Enchant DPS', fmt(r.enchantDps)],
      ['Total DPS', fmt(r.totalDps)],
      ['Procs before break', r.procsBeforeBreak ?? '-'],
      ['Procs', strike.procs.map((p) => `${p.name} ${fmt(p.damage)}`).join(', ') || '-'],
    ], ['Metric', 'Value']));
    if (values.json) console.log(JSON.stringify({ enchantments: rows, strike, result: { weaponDps: r.dps, enchantDps: r.enchantDps, totalDps: r.totalDps, procsBeforeBreak: r.procsBeforeBreak } }, null, 2));
    return;
  }

  if (cmd === 'spells') {
    if (values.theory) { ch.skills[22] = 200; ch.masteredSkills = [...new Set([...(ch.masteredSkills ?? []), 22])]; ch.maxMagicka = ch.maxMagicka || Math.floor((ch.stats.intelligence ?? 100) * 3); ch.name = 'Level 45 theory caster'; }
    const level = n(values.level, ch.level);
    const standard = standardSpells(values.data ?? undefined);
    const known = resolveSpells(ch.spells, standard);
    const pool = [...standard.values(), ...known.filter((sp) => !standard.has(sp.index))];
    const spellTarget = values.target === 'armoured' ? gateTarget(level, { traits }) : target;
    const opts = {
      level, online: ch.online !== false, potencyPct: n(values.potency, 0), pierce: n(values.pierce, 0),
      castSpeedPct: n(values['cast-speed'], 0), manaSolved: !values['mana-limit'], magicka: values.magicka != null ? n(values.magicka, 0) : undefined,
      health: spellTarget.isBoss ? spellTarget.maxHealth : 0, traits: spellTarget.bossTraits ?? [],
    };
    const list = pool.map((sp) => ({ sp, r: spellRotation(sp, ch, spellTarget, { ...opts, seconds: n(values.seconds, 30) }) }))
      .filter((x) => x.r.damage > 0 && !/^(Lvl |!)/i.test(String(x.sp.name)))
      .sort((a, b) => b.r.windowDps - a.r.windowDps);
    if (!list.length) { console.log('No standard damage spells found. Check --data / ARENA2.'); return; }
    const top = list.slice(0, 20);
    const dpsChart = barChart({ title: 'Sustained spell DPS (30s window)', labels: top.map((x) => x.sp.name), series: [{ name: 'DPS', values: top.map((x) => x.r.windowDps) }] });
    const effChart = barChart({ title: 'Damage per spell point', labels: top.map((x) => x.sp.name), series: [{ name: 'dmg/SP', values: top.map((x) => x.r.damage / Math.max(1, x.r.cost)) }] });
    const tableHtml = `<table><thead><tr><th>Spell</th><th>School</th><th>Cost</th><th>Damage</th><th>Window DPS</th><th>Cast DPS</th><th>DoT DPS</th><th>dmg/SP</th><th>DoT</th></tr></thead><tbody>${top.map(({ sp, r }) => `<tr><td class="k">${sp.name}</td><td>${skillName(r.school)}</td><td>${r.cost}</td><td>${fmt(r.damage)}</td><td>${fmt(r.windowDps)}</td><td>${fmt(r.manaDps)}</td><td>${fmt(r.dotDps ?? 0)}</td><td>${fmt(r.damage / Math.max(1, r.cost))}</td><td>${r.dotRounds ? `${r.dotRounds} r` : '-'}</td></tr>`).join('')}</tbody></table>`;
    const subtitle = `${characterLabel(ch)} | ${list.length} standard damage spells | ${spellTarget.isBoss ? `gate ${spellTarget.maxHealth.toLocaleString()} HP` : `level ${spellTarget.level}`} | ${n(values.seconds, 30)}s window | potency ${n(values.potency, 0)}% | pierce ${n(values.pierce, 0)}`;
    const html = multiGraphPage({
      title: 'DFO spell ceiling',
      subtitle,
      sections: [
        { title: 'Sustained DPS', note: 'Mana is treated as solved by default; --mana-limit prices the pool. A DoT is one instance per target and renews, never stacks. DPS cells are averages; the bar is the average.', chart: dpsChart, table: tableHtml },
        { title: 'Damage per spell point', note: 'The metric that binds a long fight. A 30s window may not spend the whole pool.', chart: effChart },
      ],
    });
    const out = path.resolve(values.out === 'dfo-dps-report.html' ? 'spells.html' : values.out);
    fs.writeFileSync(out, html, 'utf8');
    if (!values.json) console.log(`spells page written: ${out}`);
    if (values.json) console.log(JSON.stringify(list.map(({ sp, r }) => ({ index: sp.index, name: sp.name, ...r })), null, 2));
    return;
  }

  if (cmd === 'spell') {
    if (values.theory) { ch.skills[22] = 200; ch.masteredSkills = [...new Set([...(ch.masteredSkills ?? []), 22])]; ch.maxMagicka = ch.maxMagicka || Math.floor((ch.stats.intelligence ?? 100) * 3); ch.name = 'Level 45 theory caster'; }
    const level = n(values.level, ch.level);
    const dataDir = values.data ?? undefined;
    const standard = standardSpells(dataDir);
    const known = resolveSpells(ch.spells, standard);
    const standardList = [...standard.values()];
    const pool = values.standard ? standardList : (known.length ? known : standardList);
    const searchPool = values.spell != null
      ? [...pool, ...standardList.filter((sp) => !pool.some((p) => p.index === sp.index))]
      : pool;
    const spellTarget = values.target === 'armoured' ? gateTarget(level, { traits }) : target;
    const opts = {
      level,
      online: ch.online !== false,
      potencyPct: n(values.potency, 0),
      pierce: n(values.pierce, 0),
      castSpeedPct: n(values['cast-speed'], 0),
      manaSolved: !values['mana-limit'],
      magicka: values.magicka != null ? n(values.magicka, 0) : undefined,
      health: spellTarget.isBoss ? spellTarget.maxHealth : 0,
      traits: spellTarget.bossTraits ?? [],
    };
    const debugName = (sp) => /^(Lvl |!)/i.test(String(sp?.name ?? ''));
    const priced = pool.map((sp) => ({ sp, r: analyzeSpell(sp, ch, spellTarget, opts) }))
      .filter((x) => x.r.damage > 0 && !debugName(x.sp))
      .sort((a, b) => b.r.dps - a.r.dps);
    const searchPriced = searchPool.map((sp) => ({ sp, r: analyzeSpell(sp, ch, spellTarget, opts) }))
      .filter((x) => x.r.damage > 0)
      .sort((a, b) => b.r.dps - a.r.dps);
    if (!priced.length && values.spell == null && !values.standard) {
      console.log('No damaging spells in the spellbook. Pass --spell <index|name> or --standard.');
      return;
    }
    if (values.list) {
      console.log(`${characterLabel(ch)}  |  ${pool.length} spell(s)`);
      console.log(table(pool.map((sp) => [sp.index ?? '-', sp.name, spellCost(sp, ch), fmt(analyzeSpell(sp, ch, spellTarget, opts).damage)]), ['Index', 'Spell', 'Cost', 'Damage'], ['right', 'left', 'right', 'right']));
      return;
    }
    if (values['all-spells']) {
      console.log(table(priced.map(({ sp, r }) => [sp.name, skillName(r.school), r.cost, fmt(r.damage), fmt(r.dps), `${fmt2(r.castSeconds)}s`, r.castsPerPool, fmt(r.poolDamage)]), ['Spell', 'School', 'Cost', 'Damage', 'DPS', 'Cast', 'Casts', 'Pool dmg'], ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right']));
      if (values.json) console.log(JSON.stringify(priced.map(({ sp, r }) => ({ index: sp.index, name: sp.name, ...r })), null, 2));
      return;
    }
    let chosen = priced[0];
    if (values.spell != null) {
      const q = String(values.spell).trim();
      const found = searchPriced.find(({ sp }) => String(sp.index) === q || String(sp.name).toLowerCase() === q.toLowerCase())
        ?? searchPriced.find(({ sp }) => String(sp.name).toLowerCase().includes(q.toLowerCase()));
      if (!found) throw new Error(`spell "${values.spell}" not found in the resolved spellbook`);
      chosen = found;
    }
    const { sp } = chosen;
    const r = spellRotation(sp, ch, spellTarget, { ...opts, seconds: n(values.seconds, 30) });
    console.log(`${characterLabel(ch)}  |  ${sp.name} (${skillName(r.school)})`);
    console.log(table([
      ['Spell cost', `${r.cost} SP`],
      ['Instant damage', fmt(r.instant)],
      ...(r.dotRounds ? [['DoT per tick', fmt(r.dotPerTick)], ['DoT duration', `${r.dotRounds} rounds (${fmt(r.dotSeconds)} s)`], ['DoT total', fmt(r.dotTotal)]] : []),
      ['Damage / cast', fmt(r.damage)],
      ['Cast time', `${fmt2(r.castSeconds)} s`],
      ['Burst DPS', fmt(r.burstDps)],
      ['DPS', fmt(r.dps)],
      ['Magicka pool', r.magicka],
      ['Fight window', `${fmt(r.seconds)} s`],
      ['Casts used', r.casts],
      ['Total damage', fmt(r.totalDamage)],
      ['Cast DPS', fmt(r.manaDps)],
      ['Window DPS', fmt(r.windowDps)],
      ...(r.dotRounds ? [['DoT DPS', fmt(r.dotDps)]] : []),
      ['Mana solved', r.manaSolved ? 'yes' : 'no'],
      ...(r.manaSolved ? [] : [['Time to empty', `${fmt(r.timeToEmpty)} s`], ['Pool kill', r.poolKill == null ? '-' : (r.poolKill ? 'yes' : 'no')], ['Mana left', fmt(r.manaLeft)]]),
      ['Saving throw', `${pc(r.saving)} lands`],
      ['Power multiplier', `x${fmt2(r.powerMult)}`],
      ['Target', `${spellTarget.isBoss ? 'gate' : values.target}, level ${spellTarget.level}${spellTarget.isBoss ? `, ${spellTarget.maxHealth.toLocaleString()} HP` : ''}`],
      ['Time to kill', r.ttk ? `${fmt(r.ttk)} s` : '-'],
    ], ['Metric', 'Value']));
    if (r.elements?.length) {
      console.log('\nEffects');
      console.log(table(r.elements.map((e) => [e.key, e.magnitude != null ? fmt(e.magnitude) : '-', e.rounds ?? 1, fmt(e.damage), e.note ?? '']), ['Effect', 'Magnitude', 'Rounds', 'Damage', 'Note'], ['left', 'right', 'right', 'right', 'left']));
    }
    if (values.json) console.log(JSON.stringify({ index: sp.index, name: sp.name, ...r }, null, 2));
    return;
  }

  if (cmd === 'weapons' || cmd === 'skills') {
    const level = n(values.level, THEORY_LEVEL);
    const firmCharts = !!values.firmament;
    const fixedRace = values.race ? String(values.race).toLowerCase() : null;
    const vampire = !!values.vampire;
    const maxWeaponGear = GEAR_LB_LINES * GEAR_LINE_MAX; // 240
    const maxCritGear = GEAR_CS_LINES * GEAR_LINE_MAX; // 540
    const maxH2HGear = GEAR_H2H_LINES * GEAR_LINE_MAX; // 510
    const PROF_OF = Object.freeze({ ShortBlade: 1, LongBlade: 2, HandToHand: 4, Axe: 8, BluntWeapon: 16, Archery: 32 });
    const RACE_KEYS = ['darkelf', 'redguard', 'nord', 'breton', 'highelf', 'woodelf', 'khajiit', 'argonian'];
    const MELEE = Object.keys(WEAPONS).map(Number).filter((t) => WEAPONS[t]?.skill && !WEAPONS[t].ammo);
    const familyOf = (t) => WEAPONS[t]?.skill ?? 'HandToHand';
    const gearMaxOf = (t) => (familyOf(t) === 'HandToHand' ? maxH2HGear : maxWeaponGear);
    const maxTarget = referenceFoe(level, 'tough');
    const gate = gateTarget(level);
    const maxRun = (ch, share = 1) => analyze(ch, { target: maxTarget, core: 'overhaul', rri: true, healthShare: share, passiveOn: true, stacks: 5, pair: !!ch?._pair, dual: !!ch?._dual });
    const gateRun = (ch) => analyze(ch, { target: gate, core: 'overhaul', rri: true, health: gate.maxHealth, healthShare: 1, passiveOn: true, stacks: 5, pair: !!ch?._pair, dual: !!ch?._dual });
    const martialFor = (t) => (familyOf(t) === 'Axe' || familyOf(t) === 'HandToHand' ? 'berserker' : 'blademaster');
    const shareFor = (t) => (familyOf(t) === 'Axe' || familyOf(t) === 'HandToHand' ? 0.49 : 1);

    const makeMax = (t, {
      race = 'darkelf', firmament = false, raw = 200, gear = null, critGear = maxCritGear, martial = martialFor(t),
    } = {}) => {
      if (familyOf(t) === 'HandToHand') {
        const starStats = firmament ? { strength: 15, agility: 15, speed: 15, luck: 15 } : {};
        const starSkills = firmament ? { [SKILLS.HandToHand]: 15, [SKILLS.CriticalStrike]: 15, [SKILLS.Backstabbing]: 15 } : {};
        const ch = theoryFists({
          race, rawH2H: raw, gearH2H: gear ?? maxH2HGear, gearCrit: critGear,
          starStats, starSkills, starDamage: firmament ? 30 : 0, vampire, wraps: true,
        });
        ch.martialPath = martial;
        ch.name = 'Level 45 Hand-to-Hand';
        return ch;
      }
      const tpl = WEAPONS[t];
      const skillId = SKILLS[tpl.skill];
      const starStats = firmament ? { strength: 15, agility: 15, speed: 15, luck: 15 } : {};
      const starSkills = firmament ? { [skillId]: 15, [SKILLS.CriticalStrike]: 15, [SKILLS.Backstabbing]: 15 } : {};
      const ch = theoryCharacter({
        blade: t, race, gearLB: 0, gearCS: 0, damagePct: DAMAGE_AFFIX_MAX,
        vampire, starStats, starSkills, starDamage: firmament ? 30 : 0, sockets: perfectSockets(t),
      });
      ch.career = { ...(ch.career ?? {}), weaponArmorShieldsBitfield: (PROF_OF[tpl.skill] ?? 0) << 16 };
      ch.skills[skillId] = raw;
      ch.masteredSkills = [skillId, SKILLS.CriticalStrike, SKILLS.Backstabbing];
      ch._mods.skills = {
        ...(ch._mods.skills ?? {}),
        [skillId]: (gear ?? maxWeaponGear) + (firmament ? 15 : 0),
        [SKILLS.CriticalStrike]: critGear + (firmament ? 15 : 0),
      };
      ch.martialPath = martial;
      ch._pair = t === 562;
      ch.name = `Level 45 ${tpl.name}`;
      return ch;
    };

    const makeDual = (t, opts = {}) => {
      const ch = makeMax(t, { ...opts, martial: martialFor(t) });
      ch.offWeapon = { ...ch.weapon, equipSlot: 21 };
      ch._dual = true;
      return ch;
    };

    const bestRace = (t, { firmament = false, dual = false } = {}) => fixedRace ?? 'darkelf';

    const nameOf = (t) => (familyOf(t) === 'HandToHand' ? 'H2H (wraps)' : WEAPONS[t].name);
    const rows = MELEE.map((t) => {
      const race = bestRace(t, { firmament: false });
      const raceF = bestRace(t, { firmament: true });
      const ch = makeMax(t, { race, firmament: false });
      const chF = makeMax(t, { race: raceF, firmament: true });
      const r = maxRun(ch, shareFor(t));
      const rF = maxRun(chF, shareFor(t));
      const healthy = maxRun(ch, 1).dps;
      const low = (familyOf(t) === 'Axe' || familyOf(t) === 'HandToHand') ? maxRun(ch, 0.49).dps : healthy;
      const full = healthy > 0 && low > 0 ? (2 * healthy * low) / (healthy + low) : 0;
      const g = gateRun(ch);
      const gF = gateRun(chF);
      return {
        template: t, name: nameOf(t), skill: familyOf(t), twoHanded: familyOf(t) === 'HandToHand' ? false : WEAPONS[t].twoHanded,
        path: martialFor(t), race, raceF, maxDps: r.dps, maxDpsF: rF.dps, full, gateDps: g.cappedDps, gateDpsF: gF.cappedDps,
        gateTtk: g.ttk, gateTtkF: gF.ttk, perSwing: r.perSwing, aps: r.cadence.aps,
      };
    }).sort((a, b) => b.maxDpsF - a.maxDpsF || b.maxDps - a.maxDps);

    // Dual pairs: the one-handed templates, both hands of the same weapon.
    for (const t of [113, 114, 116, 117, 118, 119, 120, 121, 124, 127]) {
      const race = bestRace(t, { firmament: false, dual: true });
      const raceF = bestRace(t, { firmament: true, dual: true });
      const ch = makeDual(t, { race, firmament: false });
      const chF = makeDual(t, { race: raceF, firmament: true });
      const r = maxRun(ch, shareFor(t));
      const rF = maxRun(chF, shareFor(t));
      const g = gateRun(ch);
      const gF = gateRun(chF);
      rows.push({
        template: t, name: `Dual ${nameOf(t)}`, skill: familyOf(t), twoHanded: false, dual: true,
        path: martialFor(t), race, raceF, maxDps: r.dps, maxDpsMin: r.dpsMin, maxDpsMax: r.dpsMax, maxDpsF: rF.dps, maxDpsFMin: rF.dpsMin, maxDpsFMax: rF.dpsMax, full: r.dps,
        gateDps: g.cappedDps, gateDpsMin: g.cappedDpsMin, gateDpsMax: g.cappedDpsMax, gateDpsF: gF.cappedDps, gateDpsFMin: gF.cappedDpsMin, gateDpsFMax: gF.cappedDpsMax, gateTtk: g.ttk, gateTtkF: gF.ttk,
        perSwing: r.perSwing, aps: r.cadence.aps,
      });
    }
    rows.sort((a, b) => b.maxDpsF - a.maxDpsF || b.maxDps - a.maxDps);

    const cell = (v) => (Number.isFinite(v) ? fmt(v) : '-');
    const pctCell = (v) => (Number.isFinite(v) ? pc(v) : '-');
    const maxTable = `<table><thead><tr><th>Weapon</th><th>Skill</th><th>Hands</th><th>Path</th><th>Max gear</th><th>Full gear</th><th>+ Firmament</th><th>Gate</th><th>Gate + Firm</th><th>Gate TTK</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="k">${r.name}</td><td>${r.skill}</td><td>${r.dual ? 'Dual' : r.skill === 'HandToHand' ? 'Fists' : r.twoHanded ? '2H' : '1H'}</td><td>${r.path}</td><td>${cell(r.maxDps)}</td><td>${cell(r.full)}</td><td>${cell(r.maxDpsF)}</td><td>${cell(r.gateDps)}</td><td>${cell(r.gateDpsF)}</td><td>${r.gateTtk ? `${cell(r.gateTtk)} s` : '-'}</td></tr>`).join('')}</tbody></table>`;
    const top = rows[0];
    const topGear = rows.slice().sort((a, b) => b.maxDps - a.maxDps)[0];
    const gateTop = rows.slice().sort((a, b) => b.gateDpsF - a.gateDpsF)[0];
    const absolute = `<b>${top.name}</b> is the absolute uncapped ceiling: <b>${cell(top.maxDpsF)} DPS</b> (${top.path} below half, Dunmer) and <b>${cell(top.gateDpsF)} DPS</b> at the level-45 gate. Its healthy/below-half full-fight rate is <b>${cell(top.full)} DPS</b> on gear alone. On gear alone the top is <b>${topGear.name}</b> at <b>${cell(topGear.maxDps)} DPS</b>. At the gate the cap flips it: <b>${gateTop.name}</b> leads with <b>${cell(gateTop.gateDpsF)} capped DPS</b> and <b>${gateTop.gateTtk ? `${cell(gateTop.gateTtk)} s` : '-'} TTK</b>.<br><br>Max is the weapon's best health share (Axe/H2H below half, Blunt at or above half). Full gear is the healthy/below-half harmonic on gear alone. +Firmament is the star-tree channel ceiling at the same best share. All rows are Dunmer. DPS cells are averages; the bar is the average.`;

    const chartFirm = `<svg viewBox="0 0 920 10" width="100%" height="0" aria-hidden="true"></svg>`;
    const bar = barChart({
      title: 'Maximum uncapped DPS by weapon',
      labels: rows.map((r) => r.name),
      series: [
        { name: 'Max gear', values: rows.map((r) => r.maxDps) },
        { name: '+ Firmament', values: rows.map((r) => r.maxDpsF) },
      ],
    });

    const families = [
      { key: 'LongBlade', title: 'Long blades', templates: [118, 119, 120, 121, 122, 123] },
      { key: 'ShortBlade', title: 'Short blades', templates: [113, 114, 116, 117] },
      { key: 'BluntWeapon', title: 'Blunt weapons', templates: [115, 124, 125, 126] },
      { key: 'Axe', title: 'Axes', templates: [127, 128] },
      { key: 'HandToHand', title: 'Hand-to-Hand', templates: [null] },
      { key: 'Archery', title: 'Bows and firearms', templates: [129, 130, 560, 562] },
    ];
    const rawVals = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200];
    const familySections = families.map((f) => {
      const gearMax = f.key === 'HandToHand' ? maxH2HGear : maxWeaponGear;
      const rangedNote = f.key === 'Archery' ? ' Bows use the paced BOW_FAST window; the Pistolet is a pair.' : '';
      const gearVals = f.key === 'HandToHand' ? [0, 60, 120, 180, 240, 300, 360, 420, 480, 510] : [0, 30, 60, 90, 120, 150, 180, 210, 240];
      const skillSeries = f.templates.map((t) => {
        const race = bestRace(t, { firmament: firmCharts });
        const points = [];
        for (const v of rawVals) {
          points.push({ x: effectiveSkill(v), y: maxRun(makeMax(t, { race, firmament: firmCharts, raw: v, gear: 0 }), shareFor(t)).dps });
        }
        for (const v of gearVals) {
          if (v === 0) continue; // the raw-200 point already stands at effective 140
          points.push({ x: 140 + v, y: maxRun(makeMax(t, { race, firmament: firmCharts, raw: 200, gear: v }), shareFor(t)).dps });
        }
        return { name: nameOf(t), points };
      });
      const note = `One line per weapon: raw training 100 -> 200 is effective 100 -> 140; gear lines continue from effective 140 to ${140 + gearMax}. Max gear, Dunmer, career expertise, best path, 40% damage affix, sockets, no per-hit cap.${f.key === 'Axe' ? ' Axe uses Berserker and is measured below half health for its 2x climb.' : f.key === 'BluntWeapon' ? ' Blunt uses Blademaster and is measured at or above half health for its 2x climb.' : f.key === 'HandToHand' ? ' H2H uses Berserker and is measured below half health; the row is Hand Wraps, which carry damage, sockets and procs onto the fist blow. Bare fists without wrap lines sit around the reported ~450 band.' : ''}${firmCharts ? ' Firmament channels on.' : ''}${rangedNote}`;
      return {
        title: f.title,
        note,
        chart: lineChart({ title: `${f.title}: effective skill`, xLabel: 'Effective weapon skill', yLabel: 'DPS', series: skillSeries }),
      };
    });

    const topPerFamily = families.map((f) => rows.find((r) => familyOf(r.template) === f.key && !r.dual)).filter(Boolean);
    const csVals = [0, 60, 120, 180, 240, 300, 360, 420, 480, 540];
    const csSeries = topPerFamily.map((row) => ({
      name: row.name,
      points: csVals.map((v) => ({ x: v, y: maxRun(makeMax(row.template, { race: row.raceF, firmament: firmCharts, critGear: v }), shareFor(row.template)).dps })),
    }));
    const csSection = {
      title: 'Critical Strike scales every weapon',
      note: 'The best weapon of each family, raw 200 and max weapon gear, with Critical Strike gear from 0 to 540. Critical Strike is the shared multiplier: chance caps at 100%, then every point adds 0.01 to the multiplier.',
      chart: lineChart({ title: 'Critical Strike gear 0 -> 540', xLabel: 'Critical Strike gear points', yLabel: 'DPS', series: csSeries }),
    };

    const subtitle = `Level ${level} | attributes 100 base / 115 Firmament | Dunmer | career expertise | best martial path per family (Blademaster / Berserker) | 40% damage affix | target: level-${level} tough, no per-hit cap | gate column: ${gate.maxHealth.toLocaleString()} HP, ${gate.hitCap} per-hit cap${vampire ? ' | vampire +30 CS' : ''}`;
    const html = multiGraphPage({
      title: 'DFO weapon ceiling and skill scaling',
      subtitle,
      sections: [
        { title: 'Absolute maximum', note: absolute, chart: bar, table: maxTable },
        ...familySections,
        csSection,
      ],
    });
    const defaultOut = cmd === 'weapons' ? 'weapons.html' : 'skills.html';
    const out = path.resolve(values.out === 'dfo-dps-report.html' ? defaultOut : values.out);
    fs.writeFileSync(out, html, 'utf8');
    if (!values.json) console.log(`weapons page written: ${out}`);
    if (values.json) console.log(JSON.stringify({ level, firmCharts, rows, cs: csSeries }, null, 2));
    return;
  }

  if (cmd === 'theory') {
    const level = n(values.level, THEORY_LEVEL);
    const blade = ch.weapon?.templateIndex ?? DEFAULT_BLADE;
    const material = ch.weapon?.material ?? 9;
    const lines = Math.min(GEAR_SKILL_LINES, Math.max(0, n(values['gear-lines'], GEAR_SKILL_LINES)));
    const linePts = Math.max(1, n(values['line-points'], GEAR_LINE_MAX));
    const damage = values['damage-pct'] != null ? n(values['damage-pct'], 0) : DAMAGE_AFFIX_MAX;
    const { starStats: baseStarStats, starSkills: baseStarSkills } = starOptions(values);
    const starDamage = values['star-damage'] != null ? n(values['star-damage'], 0) : (values.firmament ? 30 : 0);
    const baseOpts = { level, race: values.race ?? 'darkelf', blade, material, vampire: values.vampire, starDamage, sockets: perfectSockets(blade), martialPath: 'blademaster' };
    const make = (over = {}) => theoryCharacter({
      ...baseOpts,
      ...over,
      starStats: { ...baseStarStats, ...(over.starStats ?? {}) },
      starSkills: { ...baseStarSkills, ...(over.starSkills ?? {}) },
    });
    const sc = (c, extra = {}) => ({ ...scenarioOf(c, values, traits, target), ...extra });
    const run = (c, extra = {}) => analyze(c, sc(c, extra));
    const behind = (c) => run(c, { backstabUptime: 1 });

    // The best split of a fixed line budget between Long Blade and Critical Strike.
    const budgetRows = [];
    for (let total = 0; total <= lines; total++) {
      let row = null;
      for (let lb = Math.max(0, total - GEAR_CS_LINES); lb <= Math.min(total, GEAR_LB_LINES); lb++) {
        const cs = total - lb;
        const c = make({ rawBlade: 200, rawCrit: 200, gearLB: lb * linePts, gearCS: cs * linePts, damagePct: damage });
        const r = run(c);
        const candidate = { lines: total, lb, cs, lbPts: lb * linePts, csPts: cs * linePts, dps: r.dps, cappedDps: r.cappedDps, perSwing: r.perSwing, ttk: r.ttk, ch: c, r };
        if (!row || candidate.cappedDps > row.cappedDps || (candidate.cappedDps === row.cappedDps && candidate.dps > row.dps)) row = candidate;
      }
      budgetRows.push(row);
    }
    const best = budgetRows[budgetRows.length - 1];
    const explicitGear = values['gear-lb'] != null || values['gear-cs'] != null;
    const maxLb = explicitGear ? n(values['gear-lb'], 0) : best.lbPts;
    const maxCs = explicitGear ? n(values['gear-cs'], 0) : best.csPts;
    const maxCh = make({ rawBlade: 200, rawCrit: 200, gearLB: maxLb, gearCS: maxCs, damagePct: damage });
    const maxR = run(maxCh);
    const maxBehind = behind(maxCh);

    const stages = [
      { label: 'Naked skills', raw: 100, gearLB: 0, gearCS: 0, damage: 0, vampire: false, sockets: [] },
      { label: 'Mastered skills', raw: 200, gearLB: 0, gearCS: 0, damage: 0, vampire: false, sockets: [] },
      { label: 'Perfect skill lines', raw: 200, gearLB: maxLb, gearCS: maxCs, damage: 0, vampire: false },
      { label: 'Perfect weapon line', raw: 200, gearLB: maxLb, gearCS: maxCs, damage, vampire: false },
      { label: 'Vampire', raw: 200, gearLB: maxLb, gearCS: maxCs, damage, vampire: true },
    ].map((s) => {
      const c = make({ rawBlade: s.raw, rawCrit: s.raw, rawBackstab: s.raw, gearLB: s.gearLB, gearCS: s.gearCS, damagePct: s.damage, vampire: s.vampire, ...(s.sockets !== undefined ? { sockets: s.sockets } : {}) });
      const r = run(c);
      const b = behind(c);
      return { ...s, dps: r.dps, dpsMin: r.dpsMin, dpsMax: r.dpsMax, cappedDps: r.cappedDps, cappedDpsMin: r.cappedDpsMin, cappedDpsMax: r.cappedDpsMax, behind: b.cappedDps, behindMin: b.cappedDpsMin, behindMax: b.cappedDpsMax, perSwing: r.perSwing, aps: r.cadence.aps, ttk: r.ttk, ch: c, r };
    });

    // One attribute at a time, everything else at the ceiling.
    const statScaled = [];
    for (const k of ['strength', 'agility', 'speed', 'luck', 'endurance', 'intelligence', 'willpower', 'personality']) {
      const at = (v) => {
        const c = JSON.parse(JSON.stringify(maxCh));
        c.stats[k] = v;
        // Isolate the base attribute: drop this channel's star so 50..100 means the sheet, not 65..115.
        if (c._mods?.stats) c._mods.stats[k] = 0;
        if (c._mods?.statMax) c._mods.statMax[k] = 0;
        const rr = run(c);
        return { dps: rr.dps, capped: rr.cappedDps };
      };
      const a50 = at(50), a75 = at(75), a90 = at(90), a100 = at(100);
      statScaled.push({ stat: k, d50: a50.dps, d75: a75.dps, d100: a100.dps, capped100: a100.capped, delta: a100.dps - a50.dps, last10: a100.dps - a90.dps });
    }
    statScaled.sort((a, b) => b.delta - a.delta);

    const skillRows = [];
    const addSkill = (label, kind, id, values_, extra = {}) => {
      for (const v of values_) {
        const c = JSON.parse(JSON.stringify(maxCh));
        if (kind === 'raw') {
          c.skills[id] = v;
          // Keep the gear line but drop the star, so the raw curve is raw.
          c._mods = c._mods ?? { stats: {}, skills: {} };
          c._mods.skills = c._mods.skills ?? {};
          c._mods.skills[id] = Math.max(0, (c._mods.skills[id] ?? 0) - (baseStarSkills[id] ?? 0));
        } else {
          c._mods = c._mods ?? { stats: {}, skills: {} };
          c._mods.skills = c._mods.skills ?? {};
          c._mods.skills[id] = v;
        }
        const r = run(c, extra);
        const b = behind(c);
        skillRows.push({ label, value: v, dps: r.dps, cappedDps: r.cappedDps, behind: b.cappedDps, perSwing: r.perSwing, ttk: r.ttk });
      }
    };
    addSkill('Raw Long Blade', 'raw', 29, [100, 125, 150, 175, 200]);
    addSkill('Raw Critical Strike', 'raw', 34, [100, 125, 150, 175, 200]);
    addSkill('Raw Backstabbing (behind)', 'raw', 19, [100, 125, 150, 175, 200], { backstabUptime: 1 });
    addSkill('Gear Long Blade (CS fixed)', 'gear', 29, [0, 200, 400, 600, GEAR_MASTERY_POINTS, 800]);
    addSkill('Gear Critical Strike (LB fixed)', 'gear', 34, [0, 200, 400, 600, 800]);

    const bladeRows = LONG_BLADES.map((idx) => {
      const c = theoryBlade(maxCh, idx, material);
      const r = run(c);
      const w = r.weapon;
      return { templateIndex: idx, name: WEAPONS[idx].name, twoHanded: w.twoHanded, dps: r.dps, dpsMin: r.dpsMin, dpsMax: r.dpsMax, cappedDps: r.cappedDps, cappedDpsMin: r.cappedDpsMin, cappedDpsMax: r.cappedDpsMax, perSwing: r.perSwing, aps: r.cadence.aps, damage: r.damage.avg, capLoss: r.capLoss, ttk: r.ttk };
    }).sort((a, b) => b.cappedDps - a.cappedDps);

    const r = maxR;
    const p = r.damage.parts;
    if (!values.json) {
    console.log(`Level ${level} theory long blade  |  ${RACE_NAMES[maxCh.raceId] ?? maxCh.race}  |  Daedric ${WEAPONS[blade].name}`);
    const targetName = values.theory && values.target === 'armoured' ? 'gate' : values.target;
    console.log(`overhaul / online${values['no-rri'] ? '' : ' / RRI'}  |  target ${targetName} level ${r.target.level}, ${r.health.toLocaleString()} HP, ${r.cap || 'no'} per-hit cap`);
    console.log('');
    console.log(table([
      ['Attributes', STAT_KEYS.map((k) => `${k} ${liveStat(maxCh, k)}`).filter((x, i) => ['strength', 'agility', 'speed', 'luck'].includes(STAT_KEYS[i])).join(', '), 'live values; Firmament lifts the 100 ceiling, gear stat affixes do not'],
      ['Raw skills', `Long Blade raw ${maxCh.skills[29]}, mod +${maxCh._mods?.skills?.[29] ?? 0}, sheet ${maxCh.skills[29] + (maxCh._mods?.skills?.[29] ?? 0)}, formula ${skillValue(maxCh, 29)}; Critical Strike raw ${maxCh.skills[34]}, mod +${maxCh._mods?.skills?.[34] ?? 0}, sheet ${maxCh.skills[34] + (maxCh._mods?.skills?.[34] ?? 0)}, formula ${skillValue(maxCh, 34)}`, 'the sheet prints raw + mods; the formula reads effectiveSkill(raw) + mods'],
      ['Gear skill lines', `${lines} x ${linePts} points`, explicitGear ? `explicit ${maxLb} Long Blade / ${maxCs} Critical Strike` : `${best.lb} Long Blade / ${best.cs} Critical Strike is the best split`],
      ['Weapon', `Daedric ${WEAPONS[blade].name}`, `RRI ${r.weapon.min}-${r.weapon.max}, weight ${r.weapon.twoHanded ? '2H' : '1H'}`],
      ['Damage affix', `${damage}%`, `legendary maximum ${DAMAGE_AFFIX_MAX}%`],
      ['Sockets', `${perfectSockets(blade).length} x perfect diamond`, `+${12 * perfectSockets(blade).length}% damage; a two-hander has 3, a one-hander 2, a short blade 1`],
      ['Firmament blow', `${starDamage}%`, 'general weapon-blow channel, cap +30% (+50% with conditions)'],
      ['Mastery / gear', `${fmt(p.mastery)}%`, `raw climb + gear channel`],
      ['Hit / crit', `${pc(r.hit.hit)} / ${pc(r.hit.crit.chance)} x${fmt2(r.hit.crit.damageMult)}`, `critical damage multiplier`],
    ], ['Term', 'Value', 'Notes']));

    console.log('\nPush stages');
    console.log(table(stages.map((s) => [s.label, s.raw, `${s.gearLB}+${s.gearCS}`, `${s.damage}%`, fmt(s.dps), fmt(s.cappedDps), fmt(s.behind), fmt(s.perSwing), fmt2(s.aps), s.ttk ? `${fmt(s.ttk)} s` : '-']), ['Stage', 'Raw skill', 'Gear', 'Damage', 'DPS', 'Capped', 'Behind', 'Per swing', 'APS', 'TTK'], ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']));
    console.log('\nCaps (push in this order)');
    console.log(table(THEORY_CAPS.map((c) => [c.channel, c.cap, c.formula, c.note]), ['Channel', 'Cap', 'Formula', 'What it means']));

    console.log('\nAttribute scaling (everything else at the ceiling)');
    console.log(table(statScaled.map((x) => [x.stat, fmt(x.d50), fmt(x.d75), fmt(x.d100), fmt(x.capped100), `${x.delta >= 0 ? '+' : ''}${fmt(x.delta)}`, `${x.last10 >= 0 ? '+' : ''}${fmt(x.last10)}`]), ['Attribute', 'DPS 50', 'DPS 75', 'DPS 100', 'Capped 100', '50 -> 100', '90 -> 100'], ['left', 'right', 'right', 'right', 'right', 'right', 'right']));
    console.log('The DPS columns are uncapped averages and isolate the varied attribute (its star is dropped so 50..100 means the sheet); Capped 100 is the full build at the gate. Luck is flat here only because Critical Strike already holds chance at 100%.');

    console.log('\nSkill and gear scaling');
    console.log(table(skillRows.map((x) => [x.label, x.value, fmt(x.dps), fmt(x.cappedDps), fmt(x.behind), fmt(x.perSwing), x.ttk ? `${fmt(x.ttk)} s` : '-']), ['Channel', 'Value', 'DPS', 'Capped', 'Behind', 'Per swing', 'TTK'], ['left', 'right', 'right', 'right', 'right', 'right', 'right']));

    // Firmament: the star tree's channels, 0..+15. The tree's stat gain also lifts the live
    // ceiling; its skill gain sits on top of effectiveSkill(raw).
    const firmValues = [0, 5, 10, 15];
    const firmBase = { gearLB: maxLb, gearCS: maxCs, damagePct: damage };
    const statFirmRows = ['strength', 'speed', 'agility', 'luck'].map((k) => {
      const cells = firmValues.map((v) => run(make({ ...firmBase, starStats: { ...baseStarStats, [k]: v } })));
      const atMax = make({ ...firmBase, starStats: { ...baseStarStats, [k]: 15 } });
      return { channel: k, cells, live: liveStat(atMax, k) };
    });
    const skillFirmRows = [[29, 'Long Blade'], [34, 'Critical Strike'], [19, 'Backstabbing']].map(([id, name]) => {
      const cells = firmValues.map((v) => {
        const c = make({ ...firmBase, starSkills: { ...baseStarSkills, [id]: v } });
        const r = run(c, id === 19 ? { backstabUptime: 1 } : {});
        const sheet = (c.skills[id] ?? 0) + (c._mods?.skills?.[id] ?? 0);
        return { r, sheet, formula: skillValue(c, id) };
      });
      return { id, name, cells };
    });

    console.log('\nFirmament attributes (the tree caps a channel at +15; the gain also lifts the 100 ceiling)');
    console.log('--firmament is the per-channel ceiling, not a legal 98-star allocation: the tree budget is 98 stars. Use --star-stat/--star-skill for the channels you actually own.');
    console.log(table(statFirmRows.map((x) => [x.channel, ...x.cells.map((r) => fmt(r.dps)), ...x.cells.map((r) => fmt(r.cappedDps)), x.live]), ['Attribute', '+0 DPS', '+5 DPS', '+10 DPS', '+15 DPS', '+0 cap', '+5 cap', '+10 cap', '+15 cap', 'Live +15'], ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']));
    console.log('Speed is clamped to 98/100 by the swing law, so Speed past 100 does nothing for cadence. Luck\'s critical divisor steps at 125, so +15 Luck from 100 is dead for critical chance. Strength is the one that keeps paying: it adds damage and RRI swing speed.');
    console.log('\nFirmament skills (the +15 sits on top of effectiveSkill(raw); the sheet prints raw + mods)');
    console.log(table(skillFirmRows.map((x) => [x.name, ...x.cells.map((c) => fmt(c.r.dps)), ...x.cells.map((c) => fmt(c.r.cappedDps)), x.cells[x.cells.length - 1].sheet, x.cells[x.cells.length - 1].formula]), ['Skill', '+0 DPS', '+5 DPS', '+10 DPS', '+15 DPS', '+0 cap', '+5 cap', '+10 cap', '+15 cap', 'Sheet +15', 'Formula +15'], ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']));
    console.log('The sheet showing 215 is raw 200 + 15; the formula reads 155 (effectiveSkill(200)=140 + 15). Gear skill adds on top of both, and for Long Blade it converts at 0.44% per point, capped at +320%.');

    const firmDmgValues = [0, 10, 20, 30];
    const firmDmgCells = firmDmgValues.map((v) => run(make({ ...firmBase, starDamage: v })));
    console.log('\nFirmament weapon blow (general channel cap +30%; conditions can take the total to +50%)');
    console.log(table([
      ['DPS', ...firmDmgCells.map((r) => fmt(r.dps))],
      ['Capped', ...firmDmgCells.map((r) => fmt(r.cappedDps))],
    ], ['', ...firmDmgValues.map((v) => `+${v}% DPS`), ...firmDmgValues.map((v) => `+${v}% cap`)], ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']));

    console.log(`\nGear line budget (${linePts} points per line; best feasible split)`);
    console.log(table(budgetRows.map((x) => [x.lines, `${x.lb} / ${x.cs}`, x.lbPts, x.csPts, fmt(x.dps), fmt(x.cappedDps), fmt(x.perSwing), x.ttk ? `${fmt(x.ttk)} s` : '-']), ['Lines', 'LB / CS', 'LB points', 'CS points', 'DPS', 'Capped', 'Per swing', 'TTK'], ['right', 'left', 'right', 'right', 'right', 'right', 'right', 'right']));

    console.log('\nLong blades at the ceiling');
    console.log(table(bladeRows.map((x) => [x.name, x.twoHanded ? '2H' : '1H', fmt(x.dps), fmt(x.cappedDps), fmt(x.perSwing), fmt2(x.aps), fmt(x.damage), pc(x.capLoss), x.ttk ? `${fmt(x.ttk)} s` : '-']), ['Blade', 'Hands', 'DPS', 'Capped', 'Per swing', 'APS', 'Avg hit', 'Cap loss', 'TTK'], ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right']));
    console.log('The table holds the two-handed 8/18 line budget. A one-handed blade plus a shield adds one armour-group Long Blade line and one Critical Strike line, so the 1H rows are a lower bound.');
    console.log(`Best at this target: ${bladeRows[0].name} (${fmt(bladeRows[0].cappedDps)} capped DPS, ${fmt(bladeRows[0].dps)} uncapped).`);

    console.log(`\n${targetName[0].toUpperCase()}${targetName.slice(1)} result`);
    console.log(table([
      ['Uncapped DPS', fmt(r.dps)],
      ['Capped DPS', fmt(r.cappedDps)],
      ['Per-hit range', `${r.damage.min}-${r.damage.max} (crit ${r.damage.critMin}-${r.damage.critMax})`],
      ['Cap loss', pc(r.capLoss)],
      ['Time to kill', `${fmt(r.ttk)} s`],
      ['Behind / backstab', `${fmt(maxBehind.cappedDps)} capped (${pc(maxBehind.backstab.chance)} x3)`],
      ['Phase shields', `${r.target.phaseShields} x ${r.target.shieldSeconds}s (${r.shields}s)`],
    ], ['Metric', 'Value']));
    if (r.cap && r.hit.crit.chance >= 1 && r.damage.critMin >= r.cap) {
      console.log('At 100% critical chance every blow is a critical, and the critical minimum is already over the per-hit cap: the 40% damage affix adds 0 capped DPS. Speed is the only attribute that still buys capped DPS here; Strength helps only through the RRI swing law.\nAgainst an uncapped boss the same build is ' + fmt(r.dps) + ' DPS.');
    }
    }

    if (values.json) {
      console.log(JSON.stringify({
        character: { level, race: RACE_NAMES[maxCh.raceId] ?? maxCh.race, blade: WEAPONS[blade].name, material, lines, linePts, maxLb, maxCs, damage },
        result: { dps: r.dps, dpsMin: r.dpsMin, dpsMax: r.dpsMax, cappedDps: r.cappedDps, cappedDpsMin: r.cappedDpsMin, cappedDpsMax: r.cappedDpsMax, perSwing: r.perSwing, aps: r.cadence.aps, ttk: r.ttk, cap: r.cap, capLoss: r.capLoss, hit: r.hit.hit, critChance: r.hit.crit.chance, critMult: r.hit.crit.damageMult, damage: { min: r.damage.min, max: r.damage.max, critMin: r.damage.critMin, critMax: r.damage.critMax }, terms: p },
        stages: stages.map(({ ch: _c, r: _r, ...rest }) => rest),
        caps: THEORY_CAPS,
        stats: statScaled,
        skills: skillRows,
        splits: budgetRows.map(({ ch: _c, r: _r, ...rest }) => rest),
        blades: bladeRows,
      }, null, 2));
    }
    return;
  }

  if (cmd === 'graph') {
    const { ch } = loadCharacter(values);
    const traits = traitsOf(values);
    const target = targetOf(ch, values, traits);
    const scenario = scenarioOf(ch, values, traits, target);
    const specs = String(values.series ?? 'stat:strength,stat:agility').split(',').map((s) => s.trim()).filter(Boolean);
    const series = [];
    for (const spec of specs) {
      const [kindRaw, idRaw] = spec.split(':');
      const kind = (kindRaw || '').toLowerCase();
      let id = idRaw;
      let current;
      let from;
      let to;
      let label;
      if (kind === 'stat') {
        id = String(id).toLowerCase();
        current = liveStat(ch, id);
        from = n(values.from, 50); to = n(values.to, 100);
        label = `stat ${id}`;
      } else if (kind === 'skill' || kind === 'gear') {
        id = Number(id);
        if (!(id >= 0 && id < 35)) throw new Error(`bad skill id ${idRaw}`);
        current = kind === 'skill' ? (ch.skills?.[id] ?? 0) : (ch._mods?.skills?.[id] ?? 0);
        from = n(values.from, kind === 'skill' ? 100 : current);
        to = n(values.to, kind === 'skill' ? 200 : current + 100);
        label = kind === 'skill' ? `skill ${id}` : `gear ${id}`;
      } else if (kind === 'star') {
        id = String(id).toLowerCase();
        if (!STAT_KEYS.includes(id)) throw new Error(`bad star attribute ${idRaw}`);
        current = ch._mods?.stats?.[id] ?? 0;
        from = n(values.from, 0);
        to = n(values.to, FIRM_CHANNEL_MAX);
        label = `star ${id}`;
      } else {
        throw new Error(`graph series must be stat:name, skill:id, gear:id or star:name (${spec})`);
      }
      const points = [];
      for (const value of scaleRange(values, from, to)) {
        const c = JSON.parse(JSON.stringify(ch));
        if (kind === 'stat') c.stats[id] = value;
        else if (kind === 'skill') c.skills[id] = value;
        else if (kind === 'star') {
          c._mods = c._mods ?? { stats: {}, skills: {} };
          c._mods.stats = c._mods.stats ?? {};
          c._mods.statMax = c._mods.statMax ?? {};
          c._mods.stats[id] = value;
          c._mods.statMax[id] = Math.max(0, value);
        } else {
          c._mods = c._mods ?? { stats: {}, skills: {} };
          c._mods.skills = c._mods.skills ?? {};
          c._mods.skills[id] = value;
        }
        const rr = analyze(c, { ...scenario, weapon: scenario.weapon });
        points.push({ x: value, y: values.uncapped ? rr.dps : (rr.cappedDps ?? rr.dps) });
      }
      series.push({ name: label, points });
    }
    const title = 'DFO DPS - stat curves';
    const flags = [values.bare ? 'bare' : '', values['no-effects'] ? 'no effects' : '', values['base-stats'] != null ? `base ${values['base-stats']}` : '', values.uncapped ? 'uncapped' : 'capped'].filter(Boolean).join(', ');
    const subtitle = `${characterLabel(ch)} | ${values.core}${ch.online ? ' / online' : ' / offline'} | ${values.target}${target.health ? ` ${target.maxHealth.toLocaleString()} HP` : ''}${flags ? ` | ${flags}` : ''}`;
    const html = graphPage({ title, subtitle, chart: lineChart({ title, xLabel: 'Value', yLabel: values.uncapped ? 'DPS' : 'Capped DPS', series }) });
    const out = path.resolve(values.out);
    fs.writeFileSync(out, html, 'utf8');
    console.log(`graph written: ${out}`);
    if (values.json) console.log(JSON.stringify(series, null, 2));
    return;
  }

  if (cmd === 'scale') {
    const { ch } = loadCharacter(values);
    const traits = traitsOf(values);
    const target = targetOf(ch, values, traits);
    const scenario = scenarioOf(ch, values, traits, target);
    const one = (label, kind, id, current, cap) => {
      const rows = [];
      for (const value of scaleRange(values, current, cap)) {
        const c = JSON.parse(JSON.stringify(ch));
        if (kind === 'stat') c.stats[id] = value;
        else if (kind === 'skill') c.skills[id] = value;
        else if (kind === 'star') {
          c._mods = c._mods ?? { stats: {}, skills: {} };
          c._mods.stats = c._mods.stats ?? {};
          c._mods.statMax = c._mods.statMax ?? {};
          c._mods.stats[id] = value;
          c._mods.statMax[id] = Math.max(0, value);
        } else {
          c._mods = c._mods ?? { stats: {}, skills: {} };
          c._mods.skills = c._mods.skills ?? {};
          c._mods.skills[id] = value;
        }
        const rr = analyze(c, { ...scenario, weapon: scenario.weapon });
        rows.push({ label, value, dps: rr.dps, dpsMin: rr.dpsMin, dpsMax: rr.dpsMax, cappedDps: rr.cappedDps, cappedDpsMin: rr.cappedDpsMin, cappedDpsMax: rr.cappedDpsMax, perSwing: rr.perSwing, ttk: rr.ttk });
      }
      return rows;
    };
    const rows = [];
    const weaponId = r?.weapon?.skillId ?? weaponOf(ch.weapon)?.skillId ?? 30;
    if (values.all) {
      const summary = [];
      const addSummary = (label, current, cap, make) => {
        const c0 = JSON.parse(JSON.stringify(ch));
        const c1 = JSON.parse(JSON.stringify(ch));
        make(c0, current); make(c1, cap);
        const r0 = analyze(c0, scenario); const r1 = analyze(c1, scenario);
        summary.push({ label, value: `${current} → ${cap}`, dps: r0.dps, cappedDps: r0.cappedDps, perSwing: r1.perSwing, ttk: r1.ttk, delta: r1.cappedDps - r0.cappedDps });
      };
      for (const k of ['strength', 'agility', 'speed', 'luck', 'endurance', 'willpower']) {
        const cur = liveStat(ch, k);
        addSummary(`stat ${k}`, cur, 100, (c, v) => { c.stats[k] = v; });
      }
      for (const [label, id] of [['skill weapon', weaponId], ['skill critical', 34]]) {
        const cur = ch.skills?.[id] ?? 0;
        addSummary(label, cur, 200, (c, v) => { c.skills[id] = v; });
      }
      const gearCur = ch._mods?.skills?.[weaponId] ?? 0;
      addSummary('gear skill', gearCur, gearCur + 100, (c, v) => { c._mods.skills[weaponId] = v; });
      console.log(`${characterLabel(ch)}  |  ${values.core}${ch.online ? ' / online' : ' / offline'}  |  ${values.target}`);
      console.log(table(summary.map((x) => [x.label, x.value, fmt(x.cappedDps), `${x.delta >= 0 ? '+' : ''}${fmt(x.delta)}`, fmt(x.perSwing), x.ttk ? `${fmt(x.ttk)} s` : '-']), ['Channel', 'Current → cap', 'Capped DPS now', 'Δ at cap', 'Per swing at cap', 'TTK at cap'], ['left', 'right', 'right', 'right', 'right', 'right']));
      return;
    }
    if (values.stat) {
      const k = String(values.stat).toLowerCase();
      if (!['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck'].includes(k)) throw new Error(`unknown stat ${k}`);
      rows.push(...one(`stat ${k}`, 'stat', k, liveStat(ch, k), 100));
    } else if (values.skill) {
      const id = n(values.skill, -1);
      if (!(id >= 0 && id < 35)) throw new Error('--skill expects a skill id 0..34');
      rows.push(...one(`skill ${id}`, 'skill', id, ch.skills?.[id] ?? 0, 200));
    } else if (values['gear-skill']) {
      const id = n(values['gear-skill'], -1);
      if (!(id >= 0 && id < 35)) throw new Error('--gear-skill expects a skill id 0..34');
      const cur = ch._mods?.skills?.[id] ?? 0;
      rows.push(...one(`gear skill ${id}`, 'gear', id, cur, cur + 100));
    } else {
      throw new Error('scale needs --stat <name>, --skill <id>, --gear-skill <id>, or --all');
    }
    console.log(`${characterLabel(ch)}  |  target ${values.target}  |  ${values.core}${ch.online ? ' / online' : ' / offline'}`);
    printScale(rows, values);
    if (values.json) console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (cmd === 'tradeoff') {
    const { ch } = loadCharacter(values);
    const traits = traitsOf(values);
    const gate = gateTarget(ch.level, { players: n(values.players, 1), blowX: n(values['blow-x'], 1) });
    const targets = [
      { label: 'Gate - Ruhn', t: gate },
      { label: 'Curbing 1,000 HP', t: bossTarget({ level: ch.level, health: 1000, traits: ['curbing'] }) },
      { label: 'Curbing 2,000 HP', t: bossTarget({ level: ch.level, health: 2000, traits: ['curbing'] }) },
      { label: 'Curbing 5,000 HP', t: bossTarget({ level: ch.level, health: 5000, traits: ['curbing'] }) },
      { label: 'Curbing 10,000 HP', t: bossTarget({ level: ch.level, health: 10000, traits: ['curbing'] }) },
      { label: 'Curbing 25,000 HP', t: bossTarget({ level: ch.level, health: 25000, traits: ['curbing'] }) },
    ];
    const out = [];
    for (const { label, t } of targets) {
      const baseScenario = { ...scenarioOf(ch, values, traits, t), target: t, health: t.maxHealth, traits: t.bossTraits ?? [] };
      const base = analyze(ch, baseScenario);
      const speed = analyze(ch, { ...baseScenario, attackSpeedPct: 5 });
      const dmg = analyze(ch, { ...baseScenario, damagePct: 5 });
      const perHit = base.perSwing / Math.max(1e-9, base.hit.hit);
      const cap = base.cap;
      const headroom = cap > 0 ? cap / perHit : null;
      let verdict;
      if (!cap) verdict = 'equal (no cap)';
      else if (perHit >= cap) verdict = 'speed wins now';
      else verdict = `damage until +${fmt((headroom - 1) * 100)}%`;
      out.push({ label, hp: t.maxHealth, cap, perHit, headroom, speed: speed.cappedDps, speedMin: speed.cappedDpsMin, speedMax: speed.cappedDpsMax, dmg: dmg.cappedDps, dmgMin: dmg.cappedDpsMin, dmgMax: dmg.cappedDpsMax, verdict });
    }
    console.log(`${characterLabel(ch)}  |  ${values.core}${ch.online ? ' / online' : ' / offline'}  |  real pools`);
    console.log(table(out.map((x) => [x.label, x.hp.toLocaleString(), x.cap || '-', fmt(x.perHit), x.headroom ? `${fmt(x.headroom)}x` : '-', fmt(x.speed), fmt(x.dmg), x.verdict]), ['Boss', 'HP', 'Cap', 'Per hit', 'Headroom', '+5% speed', '+5% dmg', 'Verdict'], ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'left']));
    console.log('\n+5% speed and +5% damage are separate one-change DPS runs against each pool.');
    console.log('Headroom = cap / expected landed hit. Above 1x, damage can grow that many times before the cap makes speed strictly better; at or below 1x, speed is already better.');
    for (const [label, t] of [['Gate - Ruhn', gate], ['Curbing 1,000 HP', targets[1].t]]) {
      const rows = rankWeapons(ch, { ...scenarioOf(ch, values, traits, t), target: t, health: t.maxHealth, traits: t.bossTraits ?? [] }, { top: 5 });
      console.log(`\nTop weapons - ${label}`);
      console.log(table(rows.map((x) => [`${x.materialName} ${x.name}`, x.twoHanded ? '2H' : '1H', fmt(x.cappedDps), fmt(x.perSwing), fmt2(x.aps)]), ['Weapon', 'Hands', 'Capped DPS', 'Per swing', 'APS'], ['left', 'left', 'right', 'right', 'right']));
    }
    const crossover = [];
    for (const hp of [500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8400, 12000]) {
      const t = bossTarget({ level: ch.level, health: hp, traits: ['curbing'] });
      const sc = { ...scenarioOf(ch, values, traits, t), target: t, health: hp, traits: ['curbing'] };
      const best = rankWeapons(ch, sc, { top: 1 })[0];
      const a = analyze(ch, sc);
      crossover.push({ hp, cap: a.cap, best: best ? `${best.materialName} ${best.name}` : '-', dps: best?.cappedDps ?? 0, perHit: best?.perHit ?? 0 });
    }
    console.log('\nBest weapon by Curbing boss health (the speed/damage crossover)');
    console.log(table(crossover.map((x) => [x.hp.toLocaleString(), x.cap, x.best, fmt(x.dps), fmt(x.perHit)]), ['Boss HP', 'Cap', 'Best weapon', 'Capped DPS', 'Best landed hit'], ['right', 'right', 'left', 'right', 'right']));
    if (values.json) console.log(JSON.stringify({ pools: out, crossover }, null, 2));
    return;
  }

  if (cmd === 'rank') {
    const rows = rankWeapons(ch, scenario, { top: n(values.top, 20) });
    const cur = currentWeaponRow(ch, scenario);
    if (values.json) {
      console.log(JSON.stringify({ character: characterLabel(ch), weapons: rows, current: cur }, null, 2));
    } else printRank(ch, rows, values, cur);
    return;
  }

  if (cmd === 'report') {
    const html = buildReport(ch, {
      target, core: scenario.core, traits, health: scenario.health, swing: scenario.swing,
      passiveOn: scenario.passiveOn, stacks: scenario.stacks, rhythm: scenario.rhythm,
      unaware: scenario.unaware, firstBlow: scenario.firstBlow, healthShare: scenario.healthShare,
      backstabUptime: scenario.backstabUptime, players: n(values.players, 1), blowX: n(values['blow-x'], 1),
      rri: !values['no-rri'], pair: values.pair, bowSpam: values.spam, potencyPct: n(values.potency, 0), pierce: n(values.pierce, 0), weapon: scenario.weapon,
    });
    const out = path.resolve(values.out);
    fs.writeFileSync(out, html, 'utf8');
    console.log(`report written: ${out}`);
    return;
  }

  if (cmd === 'compare') {
    const statList = Array.isArray(values.stat) ? values.stat : values.stat ? [values.stat] : [];
    const changes = statList.map((s) => {
      const m = /^([a-z]+|\d+)=(-?\d+)$/i.exec(s);
      if (!m) throw new Error(`--stat expects name=value, got ${s}`);
      return { name: m[1].toLowerCase(), value: Number(m[2]) };
    });
    if (!changes.length && !values.weapon) throw new Error('compare needs --stat name=value and/or --weapon template:material');
    const c2 = JSON.parse(JSON.stringify(ch));
    for (const c of changes) {
      if (c.name in c2.stats) c2.stats[c.name] = c.value;
      else if (/^\d+$/.test(c.name)) c2.skills[Number(c.name)] = c.value;
      else throw new Error(`unknown stat "${c.name}" (use strength, agility, speed, luck, endurance, willpower, intelligence, personality, or a skill id)`);
    }
    const w2 = weaponOverride(values);
    const r = analyze(ch, { ...scenario, weapon: undefined });
    const r2 = analyze(c2, { ...scenario, weapon: w2 });
    console.log(`${characterLabel(ch)}`);
    console.log(table([
      ['DPS', fmt(r.dps), fmt(r2.dps), `${r2.dps - r.dps >= 0 ? '+' : ''}${fmt(r2.dps - r.dps)}`],
      ['Per swing', fmt(r.perSwing), fmt(r2.perSwing), `${r2.perSwing - r.perSwing >= 0 ? '+' : ''}${fmt(r2.perSwing - r.perSwing)}`],
      ['Hit', pc(r.hit.hit), pc(r2.hit.hit), `${r2.hit.hit - r.hit.hit >= 0 ? '+' : ''}${fmt((r2.hit.hit - r.hit.hit) * 100)} pt`],
      ['Crit', pc(r.hit.crit.chance), pc(r2.hit.crit.chance), `${r2.hit.crit.chance - r.hit.crit.chance >= 0 ? '+' : ''}${fmt((r2.hit.crit.chance - r.hit.crit.chance) * 100)} pt`],
      ['Swing time', `${fmt2(r.cadence.seconds)}s`, `${fmt2(r2.cadence.seconds)}s`, `${r2.cadence.seconds - r.cadence.seconds >= 0 ? '+' : ''}${fmt2(r2.cadence.seconds - r.cadence.seconds)}s`],
      ['Capped DPS', fmt(r.cappedDps), fmt(r2.cappedDps), `${r2.cappedDps - r.cappedDps >= 0 ? '+' : ''}${fmt(r2.cappedDps - r.cappedDps)}`],
    ], ['Metric', 'Before', 'After', 'Change']));
    return;
  }

  if (cmd !== 'build') {
    console.error(`unknown command "${cmd}"\n\n${HELP}`);
    process.exit(2);
  }
  if (values.json) {
    console.log(JSON.stringify(summary(ch, r, {
      preset: values.target,
      marginals: marginals(ch, r, scenario),
      topWeapons: rankWeapons(ch, scenario, { top: n(values.top, 10) }),
    }), null, 2));
    return;
  }
  printBuild(ch, r, values.theory && values.target === 'armoured' ? 'gate' : values.target, values);
}
