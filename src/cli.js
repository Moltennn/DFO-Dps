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
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  BOSS_TRAITS, MATERIALS, MARTIAL_PATHS, RACE_NAMES, SKILLS, SOURCE, SWING_MODS, WEAPONS,
  gateHealth,
} from './data.js';
import { buildReport } from './report.js';
import { barChart, graphPage, lineChart, multiGraphPage } from './graph.js';
import { FIRMAMENT_NODES, buildById, buildIds, firmamentSection, planBuild, planFromTree, planKey, planSummary } from './firmament.js';
import { imprintFamilyById, rankAll } from './imprints.js';
import { effectLine, planEnchants, planMatrix, SOUL_GEM_POINTS } from './enchantPlan.js';
import { applyTree, realWeaponLoadouts } from './realBuild.js';
import { shortlistLoadouts } from './loadoutShortlist.js';
import { ENCOUNTERS, ENCOUNTER_IDS, encounterById, encounterTarget } from './encounters.js';
import { evaluateObjective, MIN_STOCHASTIC_TRIALS, OBJECTIVE_IDS, STOCHASTIC_OBJECTIVE_IDS } from './objectives.js';
import { enchantmentName as enchantmentNameOf, itemTemplate } from './enchantData.js';
import { analyzeSpell, resolveSpells, spellCost, spellRotation, standardSpells } from './spells.js';
import { chartTotals, probeConstants, summarizeProbe } from './probe.js';
import { ENCHANTMENT_TYPES, billCapacityNote, enchantDps, procsBeforeBreak, strikeEnchantments } from './enchants.js';
import { perfectSockets } from './sockets.js';
import {
  DEFAULT_BLADE, GEAR_MASTERY_POINTS, gearMasteryPoints, LONG_BLADES,
  THEORY_LEVEL, THEORY_RACES, theoryBlade, theoryCaps, theoryCharacter, theoryFists,
} from './theory.js';
import { LEVEL_CAP } from '../vendor/upstream/a3eb1605/src/systems/levelCap.js';
import { legalFrontier, legalGear } from './maxprofile.js';
import { AFFIX_DAMAGE_TOP, maxPointTotal, maxSingleSkill } from './gearProfile.js';
import {
  analyze, bossTarget, currentWeaponRow, gateTarget, GAME_BUILDS, marginals, rankAffixes, rankWeapons, referenceFoe,
  syntheticWeapon, weaponOf,
} from './model.js';
import {
  characterFromSave, characterLabel, effectiveSkill, listSaves, liveStat, loadSave,
  skillName, skillValue,
} from './save.js';
import { isUsageFailure, UsageError } from './usageError.js';

const CLI_OBJECTIVE_IDS = [...OBJECTIVE_IDS, ...STOCHASTIC_OBJECTIVE_IDS];

const HELP = `dfo-dps - DFO Online combat DPS and build lab

Usage:
  dfo-dps build  [options]            one build against one target (default)
  dfo-dps objective [options]         score one build on a named objective
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
  dfo-dps firmament [options]         HTML page: star-tree plans for each build (cached)
  dfo-dps imprints [options]          HTML page: weapon imprints ranked by family
  dfo-dps probe [capture.json]        read the latest Combat Probe capture (or a named one)
  dfo-dps enchant-plan [options]      per-piece enchant budget and priority plan
  dfo-dps loadout [options]           real DPS: tree + enchants + imprint per weapon type
  dfo-dps skills [options]            same page (alias)
  dfo-dps graph [options]             SVG line chart of two or more stats/skills
  dfo-dps saves                       list saves under the DFO user data folder
  dfo-dps doctor                      show save/build/ruleset information

Common options:
  --save <SAVE4|path>                 save slot or SaveData.txt (default: newest)
  --target <soft|tough|armoured|human|boss|breach|gate|ruhn|skyketch|abyss>  reference foe, the gate boss or a real relay boss (default: armoured)
                                      ruhn: gate boss; skyketch: 600 s share, Discord window; abyss: clock puzzle, uncalibrated
  --level <n>                         target level (default: character level)
  --armor <n>                         boss armor value (default: 0)
  --health <n>                        boss maximum health (default: 5000)
  --traits <a,b>                      boss traits (curbing, warded, bladeturning, ...)
  --core <overhaul|classic>           combat core (default: overhaul)
  --offline                           offline rules (past-100 skills read as 100)
  --weapon <template:material>        override the equipped weapon (e.g. 121:9)
  --swing <random|StrikeLeft|StrikeUp|...> swing direction (default: random, the game's six-way click draw)
  --passive <path|none>               martial path override
  --stacks <0-5>                      Flowing Steel stacks (default: 5)
  --rhythm                            War Rhythm is up (Warblade)
  --unaware                           target has not noticed you (Cutthroat)
  --first-blow                        first blow at this foe (Assassin / Opening Strike)
  --behind                            every swing is from behind (backstab x3)
  --backstab <0..1>                   share of swings from behind (expected backstab)
  --players <n>                       gate boss group size (health per player; default 1)
  --blow-x <n>                        gate relayBlowX (Elite/Vestiges cap multiplier; default 1)
  --categories                        condense the weapons page to the best of each type, sorted by DPS
  --build <id,...>                    firmament build(s): longblade, shortblade, axe, blunt, bow, fists, destruction, tank
  --game-build <14512|14631>          shipped build a card is priced under (default: 14512)
  --stars <n>                         firmament stars to spend (default 98)
  --refresh                           recompute firmament plans instead of using the cache
  --all                               enchant-plan: both matrices (--uncapped or --cap-aware picks one instead)
  --uncapped                          imprints: rank by uncapped DPS; enchant-plan: uncapped theory setup
  --family <key>                      imprints family: LongBlade, ShortBlade, Axe, BluntWeapon, Archery, HandToHand
  --sort <boss|uncapped|conditional>  imprints order (default boss)
  --shield <template|none|auto>       enchant-plan shield (default auto)
  --soul-gem                          add 5,000 enchantment points to every piece
  --group <undead|daedra|humanoid|animal>  enchant-plan target for Potent Vs (default daedra)
  --repairs <n>                       Repairs Objects copies on the set (default 1; 0 = none)
  --regen <n>                         Regens Health copies (default 0; heal spells are stronger)
  --cap-aware                         enchant-plan/loadout: cap-aware setup; imprints: rank by boss DPS
  --encounter <id>                    loadout: breach, skyketch or abyss (default breach)
  --all-encounters                    loadout: one cap-aware section per content
  --shortlist <K>                     loadout: sample the top K melee rows per target (0 = off)
  --old                               probe: read the newest capture in captures/old
  --pair                              paired Pistolets (2 shots per cycle, off hand x0.8)
  --dual                              dual wield the left-hand weapon (off hand x0.8, -5 hit)
  --spam                              bow spam (BOW_FAST stacks to x0.2; default paced)
  --health-share <0..1>               foe's health share for Axe/Blunt mastery (default: 1)
  --self-health-share <0..1>          YOUR health share, for Berserker's Frenzy (default: 1; it fires below 0.5)
  --no-crit-damage                    overhaul crit adds hit only
  --no-passive                        switch the path passive off
  --bare                              strip gear affixes/enchants/legendaries (theorycraft baseline)
  --base-stats <n>                    set all eight base attributes to n (theorycraft baseline)
  --no-effects                        drop active effects too (with --bare, a truly naked baseline)
  --stat <name>                       scale one attribute (with scale)
  --skill <id>                        scale one raw skill id (with scale)
  --gear-skill <id>                   scale one gear skill affix (with scale)
  --from <n> --to <n> --step <n>      scale range (default: current to cap)
  --all                               scale: every relevant channel at once
  --theory                            use the level-45 theory character (caster for spell/spells)
  --race <name>                       theory race (darkelf, redguard, nord, ...)
  --blade <template>                  theory long blade (default 123, Dai-katana)
  --gear-lines <n>                    OBSOLETE: a line is not a budget; use --gear-lb/--gear-cs in points
  --line-points <n>                   OBSOLETE: points per line; use --gear-lb/--gear-cs
  --gear-lb <n> --gear-cs <n>         theory gear points on weapon skill / Critical Strike (default: the legal max)
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
  --data <dir>                        ARENA2 directory holding SPELLS.STD (spell, spells); probe: a capture file
  --series <a,b>                      graph series: stat:strength,skill:29,gear:29,star:strength
  --uncapped                          graph raw DPS instead of gate-capped DPS
  --no-rri                            use the vanilla swing law instead of RRI weapon balance
  --damage-pct <n>                    add N% weapon damage (theorycraft)
  --json                              machine-readable output
  --top <n>                           rows in a ranking (default: 20)
  --out <file>                        report output (default: dfo-dps-report.html)
  -h, --help

Objective options:
  --objective <id>                    ${CLI_OBJECTIVE_IDS.join(', ')} (objective command default: snapshot)
                                      shortlist: stochastic-ttk (default) or kill-probability with --uncapped;
                                      stochastic-relay with --cap-aware (default for capped rankings)
  --health <n>                        total target pool, not multiplied by --players
  --trials <n>                        sampled trials (default and minimum: ${MIN_STOCHASTIC_TRIALS})
  --seed <int>                        sampled seed (default: 0)
  --max-seconds <n>                   sampled horizon in seconds (default: 900)
  --max-blows <n>                     sampled blow limit per trial (default: 6000)
  --no-carry                          use the stateless floor sampler (carry is on by default)
  --samples                          include per-seed rows with --json (off by default)
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
  swing: { type: 'string', default: 'random' },
  passive: { type: 'string' },
  stacks: { type: 'string', default: '5' },
  rhythm: { type: 'boolean', default: false },
  unaware: { type: 'boolean', default: false },
  'first-blow': { type: 'boolean', default: false },
  'health-share': { type: 'string' },
  'self-health-share': { type: 'string' },
  bare: { type: 'boolean', default: false },
  'base-stats': { type: 'string' },
  'no-effects': { type: 'boolean', default: false },
  behind: { type: 'boolean', default: false },
  backstab: { type: 'string' },
  players: { type: 'string', default: '1' },
  'blow-x': { type: 'string', default: '1' },
  categories: { type: 'boolean', default: false },
  build: { type: 'string' },
  'game-build': { type: 'string' },
  stars: { type: 'string' },
  refresh: { type: 'boolean', default: false },
  family: { type: 'string' },
  sort: { type: 'string' },
  shield: { type: 'string' },
  'soul-gem': { type: 'boolean', default: false },
  group: { type: 'string', default: 'daedra' },
  repairs: { type: 'string', default: '1' },
  regen: { type: 'string', default: '0' },
  'cap-aware': { type: 'boolean', default: false },
  encounter: { type: 'string', default: 'breach' },
  'all-encounters': { type: 'boolean', default: false },
  shortlist: { type: 'string', default: '0' },
  objective: { type: 'string' },
  trials: { type: 'string', default: String(MIN_STOCHASTIC_TRIALS) },
  seed: { type: 'string', default: '0' },
  'max-seconds': { type: 'string', default: '900' },
  'max-blows': { type: 'string', default: '6000' },
  'no-carry': { type: 'boolean' },
  samples: { type: 'boolean' },
  old: { type: 'boolean', default: false },
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
/** Print a text card unless `--json` is set, so a JSON run writes JSON and nothing else to stdout. */
const textOut = (values, ...parts) => { if (!values.json) console.log(...parts); };

function rangeText(what, min, max, exclusiveMin) {
  const one = what === 'integer' ? 'an' : 'a';
  if (min === -Infinity && max === Infinity) return `${one} finite ${what}`;
  if (max === Infinity) {
    if (exclusiveMin) return min === 0 ? `${one} positive ${what}` : `${one} ${what} greater than ${min}`;
    return min === 0 ? `${one} non-negative ${what}` : `${one} ${what} at least ${min}`;
  }
  if (min === -Infinity) return `${one} ${what} at most ${max}`;
  return exclusiveMin ? `${one} ${what} greater than ${min} and at most ${max}` : `${one} ${what} from ${min} to ${max}`;
}

/** Strict flag parsing: absent keeps the default; present must be a real number in range. */
function numFlag(values, name, def, { min = -Infinity, max = Infinity, int = false, exclusiveMin = false } = {}) {
  const raw = values[name];
  if (raw == null) return def;
  const text = String(raw).trim();
  const value = text === '' ? NaN : Number(text);
  const what = int ? 'integer' : 'number';
  if (!Number.isFinite(value) || (int && !Number.isInteger(value))
    || (exclusiveMin ? !(value > min) : value < min) || value > max) {
    throw new UsageError(`--${name} must be ${rangeText(what, min, max, exclusiveMin)}, got "${raw}"`);
  }
  return value;
}

const WEAPON_MATERIAL_MAX = MATERIALS.length - 1;

function weaponFlag(value) {
  const parts = String(value).split(':');
  if (parts.length > 2) throw new UsageError(`--weapon expects template or template:material (e.g. 121:9), got "${value}"`);
  const tpl = Number(parts[0]);
  if (!Number.isSafeInteger(tpl) || !WEAPONS[tpl]) {
    throw new UsageError(`--weapon: unknown weapon template ${parts[0]}. Melee templates: ${Object.keys(WEAPONS).join(', ')}`);
  }
  if (WEAPONS[tpl].ammo) throw new UsageError(`--weapon template ${tpl} is ammunition, not a weapon`);
  let material = 9;
  if (parts.length === 2) {
    const raw = parts[1].trim();
    material = Number(raw);
    if (raw === '' || !Number.isInteger(material) || material < 0 || material > WEAPON_MATERIAL_MAX) {
      throw new UsageError(`--weapon material must be an integer from 0 to ${WEAPON_MATERIAL_MAX}, got "${parts[1]}"`);
    }
  }
  return { tpl, material };
}

function validateFlags(values) {
  numFlag(values, 'level', THEORY_LEVEL, { min: 1, max: LEVEL_CAP, int: true });
  numFlag(values, 'stacks', 5, { min: 0, max: 5, int: true });
  numFlag(values, 'players', 1, { min: 1, int: true });
  numFlag(values, 'health', 5000, { min: 0, exclusiveMin: true });
  numFlag(values, 'armor', 0, { min: 0 });
  numFlag(values, 'backstab', 0, { min: 0, max: 1 });
  numFlag(values, 'blow-x', 1, { min: 0, exclusiveMin: true });
  numFlag(values, 'trials', MIN_STOCHASTIC_TRIALS, { min: 1, int: true });
  numFlag(values, 'top', 20, { min: 1, int: true });
  numFlag(values, 'potency', 0);
  numFlag(values, 'pierce', 0);
  numFlag(values, 'repairs', 1, { min: 0, int: true });
  numFlag(values, 'regen', 0, { min: 0, int: true });
  numFlag(values, 'seconds', 30, { min: 0, exclusiveMin: true });
  numFlag(values, 'health-share', 1, { min: 0, max: 1 });
  numFlag(values, 'self-health-share', 1, { min: 0, max: 1 });
  numFlag(values, 'base-stats', 50);
  numFlag(values, 'star-damage', 0);
  numFlag(values, 'from', 0);
  numFlag(values, 'to', 0);
  numFlag(values, 'step', 10, { min: 0, exclusiveMin: true });
  numFlag(values, 'gear-lb', 0, { min: 0 });
  numFlag(values, 'gear-cs', 0, { min: 0 });
  numFlag(values, 'damage-pct', 0);
  numFlag(values, 'cast-speed', 0);
  numFlag(values, 'magicka', 0);
  numFlag(values, 'stars', 98, { min: 0, max: 98, int: true });
  numFlag(values, 'blade', DEFAULT_BLADE, { min: 1, int: true });
  numFlag(values, 'skill', -1, { min: 0, max: 34, int: true });
  numFlag(values, 'gear-skill', -1, { min: 0, max: 34, int: true });

  if (values.blade != null && !WEAPONS[Number(values.blade)]) {
    throw new UsageError(`--blade: unknown weapon template ${values.blade}. Melee templates: ${Object.keys(WEAPONS).join(', ')}`);
  }
  if (values.swing != null && String(values.swing) !== 'random' && !(String(values.swing) in SWING_MODS)) {
    throw new UsageError(`--swing must be random or one of ${Object.keys(SWING_MODS).join(', ')}, got "${values.swing}"`);
  }
  if (values.traits != null) {
    for (const trait of traitsOf(values)) {
      if (!BOSS_TRAITS.includes(trait)) throw new UsageError(`--traits has no "${trait}"; choose ${BOSS_TRAITS.join(', ')}`);
    }
  }
  if (values.passive != null) {
    const passive = String(values.passive).toLowerCase();
    if (passive !== 'none' && !MARTIAL_PATHS[passive]) {
      throw new UsageError(`--passive must be none or one of ${Object.keys(MARTIAL_PATHS).join(', ')}, got "${values.passive}"`);
    }
  }
  if (values.race != null && !THEORY_RACES[String(values.race).toLowerCase()]) {
    throw new UsageError(`--race must be one of ${Object.keys(THEORY_RACES).join(', ')}, got "${values.race}"`);
  }
  if (values.sort != null && !['boss', 'uncapped', 'conditional'].includes(String(values.sort))) {
    throw new UsageError(`--sort must be boss, uncapped or conditional, got "${values.sort}"`);
  }
  if (values.shield != null) {
    const shield = String(values.shield).toLowerCase();
    if (shield !== 'none' && shield !== 'auto' && (shield === '' || !itemTemplate(shield))) {
      throw new UsageError(`--shield must be a template number, none or auto, got "${values.shield}"`);
    }
  }
  if (values['game-build'] != null && !GAME_BUILDS.includes(String(values['game-build']))) {
    throw new UsageError(`--game-build must be one of ${GAME_BUILDS.join(', ')}, got "${values['game-build']}"`);
  }
  if (values.weapon != null) weaponFlag(values.weapon);
  if (values.encounter != null && !ENCOUNTER_IDS.includes(String(values.encounter).toLowerCase())) {
    throw new UsageError(`--encounter must be one of ${ENCOUNTER_IDS.join(', ')}, got "${values.encounter}"`);
  }
}
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
    const legal = legalGear(blade);
    let ch = theoryCharacter({
      level: n(values.level, THEORY_LEVEL),
      race: values.race ?? 'darkelf',
      blade,
      material,
      gearLB: n(values['gear-lb'], legal.lb),
      gearCS: n(values['gear-cs'], legal.cs),
      damagePct: n(values['damage-pct'], legal.dmg),
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
  const passive = values.passive?.toLowerCase();
  let ch = characterFromSave(save, {
    online: !values.offline,
    slot: entry.slot,
    file: entry.file,
    martialPath: passive !== undefined
      ? (passive === 'none' ? null : passive)
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
    if (!m) throw new UsageError(`--star-stat expects name=value, got ${part}`);
    const key = m[1].toLowerCase();
    if (!STAT_KEYS.includes(key)) throw new UsageError(`unknown attribute ${key}`);
    const v = Number(m[2]);
    if (!(v >= -FIRM_CHANNEL_MAX && v <= FIRM_CHANNEL_MAX)) throw new UsageError(`Firmament attribute channel is capped at +-${FIRM_CHANNEL_MAX}`);
    starStats[key] = v;
  }
  for (const part of pairs(values['star-skill'])) {
    const m = /^(\d+)=(-?\d+)$/.exec(part);
    if (!m) throw new UsageError(`--star-skill expects id=value, got ${part}`);
    const id = Number(m[1]);
    if (!(id >= 0 && id < 35)) throw new UsageError(`bad skill id ${id}`);
    const v = Number(m[2]);
    if (!(v >= -FIRM_CHANNEL_MAX && v <= FIRM_CHANNEL_MAX)) throw new UsageError(`Firmament skill channel is capped at +-${FIRM_CHANNEL_MAX}`);
    starSkills[id] = v;
  }
  return { starStats, starSkills };
}

const REFERENCE_TARGETS = ['soft', 'tough', 'armoured', 'human'];
const SPECIAL_TARGETS = ['boss', 'gate', 'breach', 'ruhn'];
const VALID_TARGETS = [...new Set([...REFERENCE_TARGETS, ...SPECIAL_TARGETS, ...ENCOUNTER_IDS])];
const VALID_TARGET_LIST = VALID_TARGETS.join(', ');

function targetOf(ch, values, traits) {
  const requested = String(values.target ?? 'armoured').toLowerCase();
  if (!VALID_TARGETS.includes(requested)) {
    throw new UsageError(`unknown target "${values.target}" (choose ${VALID_TARGET_LIST})`);
  }
  const level = n(values.level, ch.level);
  const target = requested === 'armoured' && values.theory ? 'gate' : requested;
  if (target === 'gate' || target === 'breach' || target === 'ruhn') {
    return gateTarget(level, { health: n(values.health, gateHealth(level)), traits: traits.length ? traits : undefined, players: n(values.players, 1), blowX: n(values['blow-x'], 1) });
  }
  if (target === 'boss') {
    return bossTarget({
      level,
      armorValue: n(values.armor, 0),
      health: n(values.health, 5000),
      traits: traits.length ? traits : [],
    });
  }
  // The other content ids (skyketch, abyss) are real relay bodies, not reference-foe presets.
  if (ENCOUNTER_IDS.includes(target)) {
    return encounterTarget(target, level, { players: n(values.players, 1), traits: traits.length ? traits : null });
  }
  return referenceFoe(level, target);
}

function weaponOverride(values) {
  if (!values.weapon) return undefined;
  const [tpl, mat] = String(values.weapon).split(':').map(Number);
  if (!WEAPONS[tpl]) throw new UsageError(`unknown weapon template ${tpl}. Melee templates: ${Object.keys(WEAPONS).join(', ')}`);
  return syntheticWeapon(tpl, Number.isFinite(mat) ? mat : 9);
}

function scenarioOf(ch, values, traits, target) {
  const core = String(values.core ?? 'overhaul').toLowerCase();
  if (core !== 'overhaul' && core !== 'classic') {
    throw new UsageError(`unknown core "${values.core}" (choose overhaul, classic)`);
  }
  return {
    target,
    core,
    // The shipped build a card is priced under (CHANGELOG-MECHANICS.md GEAR-14631 / BRAND-14631). '14512' is the
    // vendored cut and the default; '14631' opts into the drift finding and changes no default output.
    gameBuild: String(values['game-build'] ?? '14512'),
    rri: !values['no-rri'],
    // `--traits` overrides; with none the target's own traits (a relay boss's) apply.
    traits: traits.length ? traits : null,
    health: target.isBoss ? target.maxHealth : n(values.health, 0),
    swing: values.swing,
    critDamage: !values['no-crit-damage'],
    passiveOn: !values['no-passive'],
    stacks: n(values.stacks, 5),
    rhythm: values.rhythm,
    unaware: values.unaware,
    firstBlow: values['first-blow'],
    healthShare: n(values['health-share'], 1),
    attackerHealthShare: n(values['self-health-share'], 1),
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

const MAX_STOCHASTIC_TRIALS = 1_000_000;

function sampledOptions(values) {
  const trials = Number(values.trials);
  if (!Number.isSafeInteger(trials) || !values.trials.trim()) throw new UsageError('--trials must be an integer');
  if (trials < MIN_STOCHASTIC_TRIALS) throw new UsageError(`--trials: at least ${MIN_STOCHASTIC_TRIALS} trials are required`);
  if (trials > MAX_STOCHASTIC_TRIALS) throw new UsageError(`--trials: at most ${MAX_STOCHASTIC_TRIALS.toLocaleString('en-US')} trials are allowed`);
  const seed = Number(values.seed);
  if (!Number.isSafeInteger(seed) || !values.seed.trim()) throw new UsageError('--seed must be a safe integer');
  const maxSeconds = Number(values['max-seconds']);
  const maxBlows = Number(values['max-blows']);
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw new UsageError('--max-seconds must be positive');
  if (!Number.isSafeInteger(maxBlows) || maxBlows <= 0) throw new UsageError('--max-blows must be a positive integer');
  return { trials, seed, maxSeconds, maxBlows };
}

function printObjective(values) {
  const { objective = 'snapshot' } = values;
  if (!CLI_OBJECTIVE_IDS.includes(objective)) {
    throw new UsageError(`unknown objective: ${objective} (choose ${CLI_OBJECTIVE_IDS.join(', ')})`);
  }
  const sampling = sampledOptions(values);
  const { seed } = sampling;
  const pool = values.health === undefined ? null : Number(values.health);
  if (pool !== null && (!Number.isFinite(pool) || pool <= 0)) throw new UsageError('a positive target pool is required (set --health)');

  const { ch } = loadCharacter(values);
  const traits = traitsOf(values);
  // Legacy gate setup treats --health as per-player; this command scores the declared total.
  const target = targetOf(ch, { ...values, health: undefined }, traits);
  if (pool !== null && target.isBoss) target.health = target.maxHealth = pool;
  if (traits.length) target.bossTraits = traits;
  // simulateFight supports a plain ordinary foe only: a boss/gate body or boss traits are refused up front
  // rather than deep in the sampler.
  if (STOCHASTIC_OBJECTIVE_IDS.includes(objective) && objective !== 'stochastic-relay'
    && (target.isBoss || (target.bossTraits?.length ?? 0) > 0 || target.phaseShields)) {
    throw new UsageError(`${objective} needs a plain ordinary foe; supported targets: soft, tough, armoured, human (use stochastic-relay for gate or breach)`);
  }
  const health = pool ?? target.maxHealth;
  if (!(health > 0)) throw new UsageError('a positive target pool is required (set --health)');
  const carry = !values['no-carry'];
  // A stochastic-relay body simulates one player's share of the pool (relayFight.js: health / players).
  const relayPlayers = objective === 'stochastic-relay' ? Math.max(1, Number(target.allowance?.players) || 1) : null;
  const r = evaluateObjective(ch, {
    ...scenarioOf(ch, values, traits, target), objective, health, ...sampling, carry,
  });
  const { unit, value, n: trialCount = null, horizonSeconds = null, killProbability = null, ci = null, assumptions, detail } = r;
  const metric = r.metric ?? ({ snapshot: 'snapshot-dps', 'relay-ceiling': 'ceiling-dps' }[objective] ?? 'kill-rate');
  const damageMode = r.damageMode ?? (target.allowance && objective !== 'snapshot' && objective !== 'fight' ? 'relay' : 'uncapped');
  if (values.json) {
    if (!values.samples) {
      delete detail.samples;
      delete detail.seeds;
    }
    console.log(JSON.stringify({ objective, metric, unit, value, n: trialCount, horizonSeconds, damageMode, carry, seed, killProbability, ci, assumptions, detail }, null, 2));
    return;
  }
  const { p, lo, hi } = killProbability ?? {};
  const pct = (v) => `${fmt2(v * 100)}%`;
  const { ttk } = detail;
  console.log(`Objective: ${objective} | Metric: ${metric} | Value: ${fmt2(value)} ${unit}`);
  console.log(`n: ${trialCount ?? 'n/a'} | Kills: ${detail.kills ?? 'n/a'} | Censored: ${detail.censored ?? 'n/a'}`);
  console.log(`Kill probability (Wilson 95%): ${killProbability ? `${pct(p)} [${pct(lo)}, ${pct(hi)}]` : 'n/a'}`);
  console.log(`Mean TTK (95% CI, kills only): ${ttk?.mean == null ? 'n/a' : `${fmt2(ttk.mean)} s [${fmt2(ttk.mean - ttk.ci95)}, ${fmt2(ttk.mean + ttk.ci95)}] from ${detail.kills ?? 'n/a'} kills`}`);
  const deterministic = !STOCHASTIC_OBJECTIVE_IDS.includes(objective);
  console.log(`Horizon: ${horizonSeconds === null ? 'n/a' : `${horizonSeconds} s`} | Damage mode: ${damageMode} | Carry: ${deterministic ? 'n/a' : carry ? 'on' : 'off'} | Seed: ${seed}`);
  const poolLabel = relayPlayers === null
    ? `Total pool: ${health}`
    : `Pool per player (simulated share): ${fmt2(health / relayPlayers)} (total ${health} / ${relayPlayers} players)`;
  console.log(`Target assumptions: ${JSON.stringify(assumptions.target)} | ${poolLabel}`);
  console.log(`Basis: ${assumptions.basis}`);
}

function printLoadoutShortlist(values, modes, encounters, k) {
  if (values.objective !== undefined && modes.length > 1) {
    throw new UsageError('--objective requires one shortlist mode: --uncapped for stochastic-ttk or kill-probability; --cap-aware for stochastic-relay');
  }
  const health = values.health === undefined ? null : Number(values.health);
  if (health !== null && !(health > 0)) throw new RangeError('--health must be a positive number');
  const opts = { ...sampledOptions(values), k, objective: values.objective, vampire: !!values.vampire, health };
  const rankings = modes.flatMap((mode) => (mode === 'cap' ? encounters : [undefined])
    .map((encounter) => shortlistLoadouts({ ...opts, mode, encounter })));
  if (values.json) {
    if (!values.samples) for (const ranking of rankings) for (const row of ranking.rows) delete row.detail;
    console.log(JSON.stringify(rankings, null, 2));
    return;
  }
  for (const r of rankings) {
    const { rows } = r;
    const top = rows[0];
    const probability = r.objective === 'kill-probability';
    const pct = (v) => `${fmt2(v * 100)}%`;
    // A relay shortlist runs one player (no --players), so its pool is that player's share.
    const poolText = r.mode === 'cap' ? `per-player pool ${r.health}` : `pool ${r.health}`;
    console.log(`\nLoadout shortlist | ${r.encounter ? ENCOUNTERS[r.encounter].name : 'level-45 tough reference foe'} | ${r.objective} | ${poolText}`);
    console.log(`n: ${opts.trials} | Horizon: ${opts.maxSeconds} s / ${r.maxBlows} blows | Damage mode: ${top.damageMode} | Seed: ${r.seed}`);
    console.log(top.damageNote);
    console.log(table(rows.map((row) => [
      row.rank ?? '-', row.deterministicRank, `${row.category} · ${row.weapon}`, row.imprint ?? '-',
      fmt2(row.deterministicTotalDps), fmt2(row.deterministicProcDps), row.error ?? (probability ? pct(row.value) : fmt2(row.value)),
      row.killProbability ? pct(row.killProbability.p) : '-',
      row.ci ? `[${probability ? pct(row.ci.lo) : fmt2(row.ci.lo)}, ${probability ? pct(row.ci.hi) : fmt2(row.ci.hi)}]` : '-',
      row.ttkSeparated ?? '-', row.censoringDiffers ?? '-',
    ]), ['Rank', 'Det. rank (melee)', 'Weapon', 'Imprint', 'Det. DPS', 'Proc DPS', probability ? 'Value (%)' : 'Kill rate (DPS)',
      'Kill %', probability ? 'Wilson 95% CI' : 'Mean TTK 95% CI (s)', 'Separated', 'Censoring differs']));
  }
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
      // the held item's long-run mean (exact carried percentages); pricing reads these, the card above floors
      carriedPerSwing: r.carriedPerSwing, carriedDps: r.carriedDps, carriedCappedDps: r.carriedCappedDps,
      enchantDps: r.enchantDps, enchantDpsMin: r.enchantDpsMin, enchantDpsMax: r.enchantDpsMax, totalDps: r.totalDps, totalDpsMin: r.totalDpsMin, totalDpsMax: r.totalDpsMax, enchantPerSwing: r.enchantPerSwing, enchantProcs: r.enchantProcs, procsBeforeBreak: r.procsBeforeBreak, procsBeforeBreakBasis: r.procsBeforeBreakBasis,
      ward: r.ward, ttk: r.ttk, totalTtk: r.totalTtk, totalTtkCapOnly: r.totalTtkCapOnly, wrath: r.wrath,
      ceilingTotalDps: r.ceilingTotalDps, ceilingTotalDpsMin: r.ceilingTotalDpsMin, ceilingTotalDpsMax: r.ceilingTotalDpsMax,
      ceilingTotalTtk: r.ceilingTotalTtk, claimTotalTtk: r.claimTotalTtk, claimSustainedDps: r.claimSustainedDps,
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

/** The relay's verdict, one named row per metric (allowance.js). */
function allowanceRows(a) {
  const ref = a.law;
  return [
    ['Allowance-sustained DPS', fmt(a.sustainedDps), `the allowance's refill ${fmt(ref.rate)}/s${a.saturated ? ' - this build exceeds it, so it is the limit' : ' - this build is below it'}`],
    ['Opening burst', fmt(a.burst5Dps), `first 5 s: the ${fmt(ref.depth)} bucket plus refill${a.dryAt != null ? `; spent after ${fmt(a.dryAt)} s` : '; never spent'}`],
    ['Kill-average DPS', a.averageDps ? fmt(a.averageDps) : '-', `${fmt(a.share)} HP share over the whole fight, shields included`],
    ['Allowance kept', pc(a.landedShare), 'of the claims that won a blow token, the part the relay accepted'],
  ];
}

function printBuild(ch, r, targetPreset, values) {
  const w = r.weapon;
  const traits = r.traits;
  console.log(`${characterLabel(ch)}`);
  console.log(`${weaponLabel(w)}${r.dual ? ' / dual' : ''}${r.pair ? ' / pair' : ''}  |  ${r.core}${ch.online ? ' / online' : ' / offline'}${ch.martialPath ? ` / ${MARTIAL_PATHS[ch.martialPath]?.name ?? ch.martialPath}` : ''}`);
  console.log(`target: ${targetPreset}${r.target.isClass ? ' (class)' : ''}, level ${r.target.level}${r.health ? `, ${r.health.toLocaleString()} HP` : ''}${traits.length ? `, traits: ${traits.join(', ')}` : ''}`);
  console.log('');
  const hasAllowance = !!r.target.allowance;
  const ttkLine = r.totalTtk != null ? `${fmt(r.totalTtk)} s` : r.allowance ? 'no kill' : hasAllowance ? 'no allowance run' : '-';
  const ttkLabel = hasAllowance ? 'Time to kill (allowance-sustained)' : 'Time to kill (per-hit-capped ceiling)';
  const ttkNote = r.health
    ? `${r.health.toLocaleString()} HP${r.ward ? ` + ${r.ward} ward` : ''}${hasAllowance ? `; ceiling: ${r.ceilingTotalTtk != null ? `${fmt(r.ceilingTotalTtk)} s` : '-'}` : r.enchantDps > 0 ? ' (weapon + procs)' : ''}`
    : 'no boss health';
  console.log(table([
    ['Hit chance', pc(r.hit.hit), `${pc(r.hit.crit.chance)} critical, x${fmt2(r.hit.crit.damageMult)}`],
    ...(r.backstab?.chance > 0 ? [['Backstab', `${pc(r.backstab.chance)} x3`, r.backstab.uptime > 0 ? `uptime ${pc(r.backstab.uptime)}; expected x${fmt2(r.backstab.expectedMult)}` : 'available; use --behind']] : []),
    ['Damage / hit', `${r.damage.min}-${r.damage.max}`, `avg ${fmt(r.damage.avg)}; crit ${r.damage.critMin}-${r.damage.critMax}`],
    ...(r.backstab?.chance > 0 ? [['Backstab hit', `${r.backstab.min}-${r.backstab.max}`, `crit ${r.backstab.critMin}-${r.backstab.critMax}`]] : []),
    ['Expected / swing', fmt(r.perSwing), 'hit chance and criticals included'],
    ['Swing time', `${fmt2(r.cadence.seconds)} s`, `${fmt2(r.cadence.aps)} swings/s`],
    ['Uncapped weapon DPS', fmt(r.dps), r.cap ? `per-hit-capped ${fmt(r.cappedDps)} (${pc(r.capLoss)} lost) - a ceiling${hasAllowance ? ', not what the boss accepts' : ''}` : 'no per-hit cap'],
    ...(r.enchantDps > 0 ? [['Enchant procs (ceiling component)', fmt(r.enchantDps), `${fmt(r.enchantPerSwing)} per landed hit${r.procsBeforeBreak ? `; ${billCapacityNote(r.procsBeforeBreak)}` : ''}`], ['Total (per-hit-capped ceiling)', fmt(r.ceilingTotalDps), 'capped weapon + proc estimate before allowance']] : []),
    ...(r.allowance ? allowanceRows(r.allowance) : []),
    [ttkLabel, ttkLine, ttkNote],
  ], ['Metric', 'Value', 'Notes']));
  const ttkGap = r.allowance && r.claimTotalTtk && r.ceilingTotalTtk
    ? Math.abs(r.claimTotalTtk - r.ceilingTotalTtk) / r.claimTotalTtk : null;
  if (r.allowance && r.ceilingTotalTtk && (r.claimTotalTtk === null || ttkGap > 0.01)) {
    const figures = r.claimTotalTtk === null
      ? `ceiling ${fmt(r.ceilingTotalTtk)} s; the allowance-sustained run never kills - the ceiling can promise a kill the allowance refuses`
      : r.claimTotalTtk > r.ceilingTotalTtk
        ? `ceiling ${fmt(r.ceilingTotalTtk)} s; allowance-sustained ${fmt(r.claimTotalTtk)} s - the ceiling can promise a kill the allowance refuses`
        : `ceiling ${fmt(r.ceilingTotalTtk)} s; allowance-sustained ${fmt(r.claimTotalTtk)} s - ceiling and allowance-sustained differ by ${pc(ttkGap)}`;
    console.log(`\nCeiling vs allowance: ${figures}.`);
  }
  if (r.cap) console.log(`\n${r.capSource === 'hit cap' ? 'Per-hit hit cap' : 'Curbing cap'}: ${r.cap} per hit${r.capSource === 'curbing' ? ` (5% of ${r.health.toLocaleString()} HP)` : ''}.`);
  if (r.target?.phaseShields) console.log(`Phase shields: ${r.target.phaseShields} x ${r.target.shieldSeconds}s (${r.shields}s added to ceiling TTK).`);
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
    ...(p.gearAdd ? [['gear add (flat)', `${fmt(p.gearAdd.mean)}`, `integer uniform ${p.gearAdd.lo}..${p.gearAdd.hi} on the roll, enumerated per blow; the mean is the reported figure (0.1.14631 only)`]] : []),
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

const FIRMAMENT_CACHE_VERSION = 1;
const FIRMAMENT_CACHE = new URL('../.cache/firmament-plans.json', import.meta.url);
const FIRMAMENT_FILES = [
  new URL('./firmament.js', import.meta.url),
  new URL('../vendor/firmament/firmamentTree.js', import.meta.url),
  new URL('../vendor/firmament/firmamentLaw.js', import.meta.url),
];

/** A source fingerprint: an edited planner or tree invalidates every saved plan. */
function firmamentFingerprint() {
  const h = createHash('sha1');
  for (const file of FIRMAMENT_FILES) h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function loadFirmamentCache() {
  const fingerprint = firmamentFingerprint();
  try {
    const data = JSON.parse(fs.readFileSync(FIRMAMENT_CACHE, 'utf8'));
    if (data?.version === FIRMAMENT_CACHE_VERSION && data?.fingerprint === fingerprint && data?.plans) return data;
  } catch { /* no cache or unreadable */ }
  return { version: FIRMAMENT_CACHE_VERSION, fingerprint, plans: {} };
}

function saveFirmamentCache(cache) {
  try {
    fs.mkdirSync(new URL('../.cache/', import.meta.url), { recursive: true });
    const tmp = new URL('../.cache/firmament-plans.json.tmp', import.meta.url);
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, FIRMAMENT_CACHE);
  } catch { /* a cache is an optimization, never a failure */ }
}

/** Every page write goes through here, so a bad --out is a usage error, not a stack. */
function writePage(out, page) {
  try {
    fs.writeFileSync(out, page, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot write ${out}: ${e.message}`);
  }
}

const COMMANDS = [
  'build', 'objective', 'rank', 'weapons', 'report', 'compare', 'scale', 'tradeoff', 'theory',
  'spell', 'spells', 'enchant', 'firmament', 'imprints', 'probe', 'enchant-plan', 'gear-plan',
  'loadout', 'real-dps', 'skills', 'graph', 'saves', 'doctor',
];
// Which commands read --out and --json, from each branch below.
const FILE_COMMANDS = ['report', 'spells', 'weapons', 'skills', 'firmament', 'imprints', 'probe', 'enchant-plan', 'gear-plan', 'loadout', 'real-dps', 'graph'];
const JSON_COMMANDS = ['build', 'objective', 'rank', 'scale', 'tradeoff', 'theory', 'spell', 'spells', 'enchant', 'weapons', 'skills', 'firmament', 'imprints', 'probe', 'enchant-plan', 'gear-plan', 'loadout', 'real-dps', 'graph'];
/** The commands whose card goes through `scenarioOf` (the one place `--game-build` enters a formula). */
const GAME_BUILD_COMMANDS = ['build', 'objective', 'rank', 'report', 'compare', 'scale', 'tradeoff', 'theory', 'graph', 'enchant'];

/** Reject flags the command would ignore instead of accepting them silently. */
function checkOutputFlags(cmd, argv, values) {
  const given = (name) => argv.includes(`--${name}`) || argv.some((a) => a.startsWith(`--${name}=`));
  if (given('out') && !FILE_COMMANDS.includes(cmd)) {
    throw new UsageError(`--out is only for commands that write a file (${FILE_COMMANDS.join(', ')}), not "${cmd}"`);
  }
  if (given('game-build') && !GAME_BUILD_COMMANDS.includes(cmd)) {
    throw new UsageError(`--game-build is not read by ${cmd} (it prices a weapon card: ${GAME_BUILD_COMMANDS.join(', ')})`);
  }
  if (!values.json) return;
  const unsupported = cmd === 'spell' && values.list ? 'spell --list'
    : cmd === 'scale' && values.all ? 'scale --all'
      : JSON_COMMANDS.includes(cmd) ? null : cmd;
  if (unsupported) {
    throw new UsageError(`--json is not supported by "${unsupported}"; commands with JSON output: ${JSON_COMMANDS.join(', ')}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: optsSpec, allowPositionals: true, strict: true });
  } catch (e) {
    console.error(e.message);
    console.error(`\n${HELP}`);
    process.exit(2);
  }
  const values = parsed.values;
  if (values.help) { console.log(HELP); return; }
  validateFlags(values);
  const cmd = parsed.positionals[0] ?? 'build';
  if (!COMMANDS.includes(cmd)) {
    console.error(`unknown command "${cmd}"\n\n${HELP}`);
    process.exit(2);
  }
  checkOutputFlags(cmd, argv, values);
  if (cmd === 'compare' && values.all) {
    throw new UsageError('compare does not take --all; use scale --all for every channel');
  }
  if (cmd === 'theory' || cmd === 'weapons' || cmd === 'skills') values.theory = true;

  if (cmd === 'objective') {
    try {
      printObjective(values);
    } catch (e) {
      if (!isUsageFailure(e)) throw e;
      console.error(e.message);
      process.exit(2);
    }
    return;
  }

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

  if (cmd === 'loadout' || cmd === 'real-dps') {
    const modes = values.uncapped ? ['uncapped'] : values['cap-aware'] ? ['cap'] : ['uncapped', 'cap'];
    const requested = values['all-encounters'] ? [...ENCOUNTER_IDS] : [String(values.encounter ?? 'breach').toLowerCase()];
    const unknown = requested.filter((id) => !encounterById(id));
    if (unknown.length) {
      console.error(`unknown encounter: ${unknown.join(', ')} (choose ${ENCOUNTER_IDS.join(', ')})`);
      process.exit(2);
    }
    const k = Number(values.shortlist);
    if (k !== 0 || !values.shortlist.trim()) {
      try {
        if (!Number.isSafeInteger(k) || k < 1) throw new UsageError('--shortlist must be a positive integer (0 disables it)');
        if (values['no-carry']) throw new UsageError('--no-carry does not apply to --shortlist: shortlist sampling always uses carry');
        printLoadoutShortlist(values, modes, requested, k);
      } catch (e) {
        if (!isUsageFailure(e)) throw e;
        console.error(e.message);
        process.exitCode = 2;
      }
      return;
    }
    const wantsUncapped = modes.includes('uncapped');
    const wantsCap = modes.includes('cap');
    const uncappedRows = wantsUncapped ? realWeaponLoadouts({ modes: ['uncapped'], vampire: !!values.vampire }) : [];
    const capRows = new Map();
    if (wantsCap) for (const id of requested) capRows.set(id, realWeaponLoadouts({ modes: ['cap'], vampire: !!values.vampire, encounter: id }));
    const rows = [...uncappedRows, ...[...capRows.values()].flat()];
    const byDps = (list) => list.slice().sort((a, b) => b.totalDps - a.totalDps);
    if (!values.json) {
      if (wantsUncapped) {
        const list = byDps(uncappedRows);
        console.log(`\nReal loadouts  |  uncapped theory  |  soul gem +${SOUL_GEM_POINTS}`);
        console.log(table(list.map((r) => [`${r.category} · ${r.family}`, r.weapon, r.imprint ?? '-', fmt(r.totalDps)]), ['Family', 'Weapon', 'Imprint', 'Total DPS (carried)'], ['left', 'left', 'left', 'right']));
      }
      if (wantsCap) for (const id of requested) {
        const e = ENCOUNTERS[id];
        const list = byDps(capRows.get(id));
        console.log(`\nReal loadouts  |  ${e.name}  |  soul gem +${SOUL_GEM_POINTS}${e.calibrated ? '' : '  |  uncalibrated mechanics'}`);
        console.log(table(list.map((r) => [`${r.category} · ${r.family}`, r.weapon, r.imprint ?? '-', fmt(r.totalDps), fmt(r.burst5), fmt(r.sustainedDps), fmt(r.averageDps), fmt(r.ttk), pc(r.landedShare)]), ['Family', 'Weapon', 'Imprint', 'Per-hit-capped DPS (carried)', 'Burst 5s', 'Sustained DPS', 'Kill-avg DPS', 'TTK', 'Kept'], ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right']));
      }
    }
    const shared = uncappedRows.find((r) => r.category === '1H')?.enchPlan
      ?? [...capRows.values()].flat().find((r) => r.category === '1H')?.enchPlan
      ?? rows[0]?.enchPlan;
    const imprintRows = rankAll({ sort: 'uncapped' }).flatMap((f) => f.rows.slice(0, 3).map((r) => ({ family: f.name, power: r.power.name, weapon: r.weapon, carriedBoss: r.baseDps, carriedUncapped: r.uncappedDps })));
    const builds = buildIds().map((id) => {
      const build = buildById(id);
      const p = planBuild(build);
      const s = planSummary(p);
      return { build: build.name, start: p.startName, stars: p.stars, free: p.freeStars, group: p.build.skill ? `${s.rows.find((r) => r.key === 'blow')?.value ?? 0}%` : p.build.school ? `${s.rows.find((r) => r.key === 'castCost')?.value ?? 0}%` : `${p.totals.hp ?? 0} HP` };
    });
    const out = path.resolve(values.out === 'dfo-dps-report.html' ? 'loadouts.html' : values.out);
    const sections = [];
    if (wantsUncapped) {
      const list = byDps(uncappedRows);
      const chart = barChart({
        title: 'Uncapped loadouts by carried DPS',
        labels: list.map((r) => `${r.category} ${r.weapon}`),
        series: [{ name: 'Carried total DPS', values: list.map((r) => r.totalDps) }],
      });
      const body = list.map((r) => `<tr><td class="k">${r.category} · ${r.family}</td><td>${r.weapon}</td><td>${r.imprint ?? '-'}</td><td>${fmt(r.totalDps)}</td></tr>`).join('');
      sections.push({
        title: 'Uncapped theory - all weapons and hold configurations',
        note: 'Every weapon template in every hand configuration. Total is the CARRIED figure: tree + enchants + the best eligible positive imprint; null means no positive imprint was used.',
        chart,
        table: `<div class="table"><table><thead><tr><th>Family</th><th>Weapon</th><th>Imprint</th><th>Total DPS (carried)</th></tr></thead><tbody>${body}</tbody></table></div>`,
      });
    }
    if (wantsCap) for (const id of requested) {
      const e = ENCOUNTERS[id];
      const list = byDps(capRows.get(id));
      const chart = barChart({
        title: `${e.name} loadouts by carried per-hit-cap DPS`,
        labels: list.map((r) => `${r.category} ${r.weapon}`),
        series: [{ name: 'Carried total DPS', values: list.map((r) => r.totalDps) }],
      });
      const ttkList = list.slice().sort((a, b) => (a.ttk ?? Infinity) - (b.ttk ?? Infinity));
      const ttkChart = barChart({
        title: `${e.name} time to kill - lower is better`,
        labels: ttkList.map((r) => `${r.category} ${r.weapon}`),
        series: [{ name: 'TTK', values: ttkList.map((r) => r.ttk ?? 0) }],
      });
      const body = list.map((r) => `<tr><td class="k">${r.category} · ${r.family}</td><td>${r.weapon}</td><td>${r.imprint ?? '-'}</td><td>${fmt(r.totalDps)}</td><td>${fmt(r.burst5)}</td><td>${fmt(r.sustainedDps)}</td><td>${fmt(r.averageDps)}</td><td>${fmt(r.ttk)}</td><td>${pc(r.landedShare)}</td></tr>`).join('');
      sections.push({
        title: `${e.name} - all weapons and hold configurations${e.calibrated ? '' : ' (uncalibrated mechanics)'}`,
        note: `${e.note} The carried per-hit-capped DPS is a ceiling, not what the boss takes; Burst 5s (damage in the first five seconds), Sustained DPS (the refill rate once the opening allowance is spent), Kill-avg DPS (health over TTK) and TTK apply the relay's per-player allowance (750 depth, 150/s, 600 per blow, four blows/s at level 45). Purse kept is the share of that ceiling which lands after the purse. The imprint is chosen on the per-hit ceiling; under the purse Many Endings is not credited, because its extra blow is capped and spends the same four-blow budget.${e.calibrated ? '' : ' The purse is known; the encounter immunity/split timing is not yet measured, so TTK is a purse-only baseline.'}`,
        chart,
        table: `<div class="table"><table><thead><tr><th>Family</th><th>Weapon</th><th>Imprint</th><th>Per-hit-capped DPS (carried)</th><th>Burst 5s</th><th>Sustained DPS</th><th>Kill-avg DPS</th><th>TTK</th><th>Allowance kept</th></tr></thead><tbody>${body}</tbody></table></div>`,
      });
      sections.push({
        title: `${e.name} - time to kill`,
        note: 'Sorted by TTK, not DPS. Every build above the refill rate converges; the remaining differences are burst and phase time.',
        chart: ttkChart,
        table: '',
      });
    }
    if (shared) {
      const body = shared.rows.map((r) => `<tr><td class="k">${r.slot}</td><td>${r.item}</td><td style="white-space:normal;min-width:360px">${r.effects.map((e) => effectLine(e)).join('<br>') || '-'}</td></tr>`).join('');
      sections.push({ title: 'Shared enchant plan', note: 'The same armour/jewellery enchant template is used by every loadout; only the weapon-skill name changes.', chart: '', table: `<div class="table"><table><thead><tr><th>Slot</th><th>Item</th><th>Enchantments</th></tr></thead><tbody>${body}</tbody></table></div>` });
    }
    sections.push({
      title: 'Imprint ratings',
      note: 'Top three eligible imprints per family. Boss is the breach purse; Uncapped has no cap. Monster-type damage imprints are shown for reference but are not used in the loadouts.',
      chart: '',
      table: `<div class="table"><table><thead><tr><th>Family</th><th>Imprint</th><th>Weapon</th><th>Per-hit-capped DPS (carried)</th><th>Uncapped DPS (carried)</th></tr></thead><tbody>${imprintRows.map((r) => `<tr><td class="k">${r.family}</td><td>${r.power}</td><td>${r.weapon}</td><td>${fmt(r.carriedBoss)}</td><td>${fmt(r.carriedUncapped)}</td></tr>`).join('')}</tbody></table></div>`,
    });
    sections.push({
      title: 'Firmament plans used',
      note: 'The real tree plans behind the loadouts. Free stars are not needed for damage.',
      chart: '',
      table: `<div class="table"><table><thead><tr><th>Build</th><th>Start</th><th>Stars</th><th>Free</th><th>Group</th></tr></thead><tbody>${builds.map((r) => `<tr><td class="k">${r.build}</td><td>${r.start}</td><td>${r.stars}/98</td><td>${r.free}</td><td>${r.group}</td></tr>`).join('')}</tbody></table></div>`,
    });
    const html = multiGraphPage({
      title: 'DFO real loadouts',
      subtitle: `Tree + enchants + best eligible positive imprint. Every weapon template, 1H / 2H / DW / Fists, in ${wantsUncapped ? 'uncapped' : ''}${wantsUncapped && wantsCap ? ' and ' : ''}${wantsCap ? requested.map((id) => ENCOUNTERS[id].name).join(' / ') : ''} modes. Monster-type damage imprints are excluded.`,
      sections,
    });
    writePage(out, html);
    if (!values.json) console.log(`loadout page written: ${out}`);
    if (values.json) console.log(JSON.stringify(rows.map(({ enchPlan, ...r }) => r), null, 2));
    return;
  }

  if (cmd === 'enchant-plan' || cmd === 'gear-plan') {
    const weapon = values.weapon != null ? weaponFlag(values.weapon).tpl : 123;
    const shield = String(values.shield ?? 'auto').toLowerCase();
    const group = String(values.group ?? 'daedra').toLowerCase();
    if (!['undead', 'daedra', 'humanoid', 'animal'].includes(group)) {
      console.error(`unknown Potent Vs group: ${group}`);
      process.exit(2);
    }
    const repairs = Math.max(0, Math.trunc(n(values.repairs, 1)));
    const regen = Math.max(0, Math.trunc(n(values.regen, 0)));
    const gate = gateTarget(THEORY_LEVEL);
    const uncappedTarget = referenceFoe(THEORY_LEVEL, 'tough');
    const allModes = [
      { key: 'uncapped', label: 'Uncapped theory', forceSkills: true, target: uncappedTarget },
      { key: 'cap', label: 'Cap-aware', forceSkills: false, target: gate },
    ];
    const selectedModes = values.uncapped ? [allModes[0]] : values['cap-aware'] ? [allModes[1]] : values.all ? allModes : [allModes[1]];

    const summarize = (matrix) => matrix.map((x) => {
      const rows = x.plan?.rows ?? [];
      return {
        family: x.family, weapon: x.weapon ?? '-', skillPieces: x.skillPieces ?? 0, csPieces: x.csPieces ?? 0,
        procs: rows[0]?.effects.filter((e) => e.type === 'CastWhenStrikes').length ?? 0,
        repairs: rows.flatMap((r) => r.effects).filter((e) => e.type === 'RepairsObjects').length,
        carriedBase: x.plan?.carriedBaseDps ?? 0, cardDps: x.plan?.cardPlanDps ?? 0, cardFutureDps: x.plan?.cardUncappedPlanDps ?? 0,
        spent: rows.reduce((a, r) => a + r.spent, 0), budget: rows.reduce((a, r) => a + r.budget, 0),
        left: rows.reduce((a, r) => a + (r.budget - r.spent), 0),
      };
    });
    const summaryHtml = (summary, modeKey) => {
      const cap = modeKey === 'cap';
      const head = `<tr><th>Family</th><th>Best weapon</th><th>Weapon skill pieces</th><th>CS pieces</th><th>Procs</th><th>Repairs</th><th>Weapon DPS (carried)</th>${cap ? '<th>Gate plan (card ceiling)</th><th>No-cap plan (card)</th>' : '<th>Uncapped plan DPS (card)</th>'}<th>Spent</th><th>Left</th></tr>`;
      return `<div class="table"><table><thead>${head}</thead><tbody>${summary.map((x) => `<tr><td class="k">${x.family}</td><td>${x.weapon}</td><td>${x.skillPieces}</td><td>${x.csPieces}</td><td>${x.procs}</td><td>${x.repairs}</td><td>${fmt(x.carriedBase)}</td>${cap ? `<td>${fmt(x.cardDps)}</td><td>${fmt(x.cardFutureDps)}</td>` : `<td>${fmt(x.cardDps)}</td>`}<td>${x.spent}</td><td>${x.left}</td></tr>`).join('')}</tbody></table></div>`;
    };
    const canonical = (matrix, modeKey) => {
      const melee = matrix.filter((x) => ['LongBlade', 'ShortBlade', 'Axe', 'BluntWeapon', 'HandToHand'].includes(x.key));
      return modeKey === 'cap' ? melee.sort((a, b) => (b.skillPieces ?? 0) - (a.skillPieces ?? 0))[0] : melee[0];
    };
    const canonicalHtml = (melee) => melee?.plan ? `<div class="table"><h3>Canonical melee layout (${melee.family} - ${melee.weapon})</h3><table><thead><tr><th>Slot</th><th>Item</th><th>Enchantments</th></tr></thead><tbody>${melee.plan.rows.map((r) => `<tr><td class="k">${r.slot}</td><td>${r.item}</td><td style="white-space:normal;min-width:320px">${r.effects.map((e) => effectLine(e)).join('<br>') || '-'}</td></tr>`).join('')}</tbody></table></div>` : '';

    if (values.all) {
      const results = selectedModes.map((mode) => {
        const matrix = planMatrix({ soulGem: !!values['soul-gem'], repairs, regen, group, forceSkills: mode.forceSkills, target: mode.target });
        return { ...mode, matrix, summary: summarize(matrix), melee: canonical(matrix, mode.key) };
      });
      if (!values.json) {
        for (const r of results) {
          console.log(`
Enchant plans by weapon type  |  ${r.label}  |  ${values['soul-gem'] ? `soul gem +${SOUL_GEM_POINTS}` : 'template points only'}`);
          const cap = r.key === 'cap';
          console.log(table(r.summary.map((x) => [x.family, x.weapon, x.skillPieces, x.csPieces, x.procs, x.repairs, fmt(x.carriedBase), ...(cap ? [fmt(x.cardDps), fmt(x.cardFutureDps)] : [fmt(x.cardDps)]), x.spent, x.left]), ['Family', 'Best', 'Weapon skill', 'CS', 'Procs', 'Repairs', 'Weapon DPS (carried)', ...(cap ? ['Gate plan (card ceiling)', 'No-cap plan (card)'] : ['Uncapped plan DPS (card)']), 'Spent', 'Left'], ['left', 'left', 'right', 'right', 'right', 'right', 'right', ...(cap ? ['right', 'right'] : ['right']), 'right', 'right']));
          if (r.melee?.plan) {
            console.log(`\nCanonical melee layout (${r.melee.family} - ${r.melee.weapon})`);
            console.log(table(r.melee.plan.rows.map((row) => [row.slot, row.item, row.effects.map((e) => effectLine(e)).join('; ') || '-']), ['Slot', 'Item', 'Enchantments'], ['left', 'left', 'left']));
          }
        }
      }
      const out = path.resolve(values.out === 'dfo-dps-report.html' ? 'enchant-plans.html' : values.out);
      const sections = results.map((r) => ({
        title: `${r.label} per weapon type`,
        note: r.key === 'uncapped'
          ? 'Theoretical maximum: no per-hit cap, the legal gear frontier for the weapon (weapon skill / Critical Strike / damage across the 18 slots). Every melee family uses the same shape; only the weapon-skill name changes.'
          : 'Current Breach: 600 per-hit cap. Skill lines are bought only where their capped marginal DPS is positive.',
        chart: '',
        table: summaryHtml(r.summary, r.key) + canonicalHtml(r.melee),
      }));
      const html = multiGraphPage({
        title: 'DFO enchant plans by weapon type',
        subtitle: `${values['soul-gem'] ? `Soul gem +${SOUL_GEM_POINTS} on every piece` : 'Template points only'} | uncapped theory and cap-aware setups side by side.`,
        sections,
      });
      writePage(out, html);
      if (!values.json) console.log(`enchant plans page written: ${out}`);
      if (values.json) console.log(JSON.stringify({ modes: results.map((r) => ({ mode: r.key, label: r.label, summary: r.summary, plans: r.matrix.map((x) => ({ family: x.family, weapon: x.weapon, rows: x.plan?.rows })) })) }, null, 2));
      return;
    }
    const mode = selectedModes[0];
    const plan = planEnchants({ weapon, shield, soulGem: !!values['soul-gem'], group, repairs, regen, forceSkills: mode.forceSkills, target: mode.target });
    if (!values.json) {
      console.log(`Enchant plan  |  ${plan.weaponName}${plan.shield ? ` + ${plan.shield}` : ''}  |  ${plan.soulGem ? `soul gem +${SOUL_GEM_POINTS}` : 'template points only'}  |  Potent Vs: ${group}  |  ${plan.maxProcs} strike proc${plan.maxProcs === 1 ? '' : 's'} (condition)`);
      if (plan.imprint?.base) {
        const b = plan.imprint.base;
        const u = plan.imprint.uncapped;
        console.log(`Weapon imprint (separate, carried mean): boss ${b.power.name} ${fmt(b.carriedDps)} (+${fmt(b.carriedDps - plan.carriedBaseDps)}); uncapped ${u.power.name} ${fmt(u.carriedUncappedDps)} (+${fmt(u.carriedUncappedDps - plan.carriedUncappedDps)})`);
      }
      console.log('');
      console.log(table(plan.rows.map((r) => [
        r.slot, r.item, r.base, r.soul || '-', r.budget, r.spent, r.left,
        r.effects.map((e) => effectLine(e)).join('; ') || '-',
      ]), ['Slot', 'Item', 'Base', 'Soul', 'Budget', 'Spent', 'Left', 'Enchantments'], ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'left']));
      console.log('');
      console.log('Only one piece needs it');
      console.log(table(plan.onePiece.map((u) => {
        const placed = plan.rows.flatMap((r) => r.effects.filter((e) => e.type === u.type).map(() => r.slot));
        return [enchantmentNameOf(u.type), placed.join(', ') || '-', u.why];
      }), ['Effect', 'Placed on', 'Why'], ['left', 'left', 'left']));
      console.log('');
      console.log('Stacks per piece');
      console.log(table(plan.stacks.map((u) => {
        const n = plan.rows.reduce((a, r) => a + r.effects.filter((e) => e.type === u.type).length, 0);
        return [enchantmentNameOf(u.type), n, u.why];
      }).filter(([, n]) => n > 0), ['Effect', 'Copies', 'Why'], ['left', 'right', 'left']));
      console.log('');
      console.log('How the effects rate');
      console.log(table(plan.ratings.weapon.map((r) => [r.label, fmt(r.value), r.cost, fmt(r.value * 1000 / r.cost), r.chosen]), ['Weapon proc', 'DPS', 'Cost', 'DPS / 1k', 'Chosen'], ['left', 'right', 'right', 'right', 'right']));
      console.log(table(plan.ratings.skills.map((r) => [r.label, fmt(r.futureValue), fmt(r.value), r.cost, r.chosen]), ['Skill +15', 'No-cap DPS', 'Gate DPS', 'Cost', 'Chosen'], ['left', 'right', 'right', 'right', 'right']));
      console.log(table(plan.ratings.utility.map((r) => [r.label, r.benefit, r.cost, r.chosen]), ['Utility', 'Benefit', 'Cost', 'Chosen'], ['left', 'left', 'right', 'right']));
    }
    const out = path.resolve(values.out === 'dfo-dps-report.html' ? 'enchant-plan.html' : values.out);
    const pieceTable = `<div class="table"><table><thead><tr><th>Slot</th><th>Item</th><th>Base</th><th>Soul</th><th>Budget</th><th>Spent</th><th>Left</th><th>Enchantments</th></tr></thead><tbody>${plan.rows.map((r) => `<tr><td class="k">${r.slot}</td><td>${r.item}</td><td>${r.base}</td><td>${r.soul || '-'}</td><td>${r.budget}</td><td>${r.spent}</td><td>${r.left}</td><td style="white-space:normal;min-width:320px">${r.effects.map((e) => effectLine(e)).join('<br>') || '-'}</td></tr>`).join('')}</tbody></table></div>`;
    const oneTable = `<div class="table"><h3>Only one piece needs it</h3><table><thead><tr><th>Effect</th><th>Placed on</th><th>Why</th></tr></thead><tbody>${plan.onePiece.map((u) => {
      const placed = plan.rows.flatMap((r) => r.effects.filter((e) => e.type === u.type).map(() => r.slot));
      return `<tr><td class="k">${enchantmentNameOf(u.type)}</td><td>${placed.join(', ') || '-'}</td><td style="white-space:normal">${u.why}</td></tr>`;
    }).join('')}</tbody></table></div>`;
    const stackTable = `<div class="table"><h3>Stacks per piece</h3><table><thead><tr><th>Effect</th><th>Copies</th><th>Why</th></tr></thead><tbody>${plan.stacks.map((u) => {
      const n = plan.rows.reduce((a, r) => a + r.effects.filter((e) => e.type === u.type).length, 0);
      return { u, n };
    }).filter(({ n }) => n > 0).map(({ u, n }) => `<tr><td class="k">${enchantmentNameOf(u.type)}</td><td>${n}</td><td style="white-space:normal">${u.why}</td></tr>`).join('')}</tbody></table></div>`;
    const weaponTable = `<div class="table"><h3>Weapon only</h3><table><thead><tr><th>Effect</th><th>Why</th></tr></thead><tbody>${plan.weaponOnly.map((u) => `<tr><td class="k">${enchantmentNameOf(u.type)}</td><td style="white-space:normal">${u.why}</td></tr>`).join('')}</tbody></table></div>`;
    const ratingTable = `<div class="table"><h3>How the effects rate</h3><table><thead><tr><th>Category</th><th>Effect</th><th>Benefit</th><th>Cost</th><th>Chosen</th></tr></thead><tbody>${[
      ...plan.ratings.weapon.map((r) => ['Weapon proc', r.label, `${fmt(r.value)} DPS (${fmt(r.value * 1000 / r.cost)} / 1k)`, r.cost, r.chosen]),
      ...plan.ratings.skills.map((r) => ['Skill +15', r.label, `${fmt(r.futureValue)} DPS no-cap, ${fmt(r.value)} at the cap`, r.cost, r.chosen]),
      ...plan.ratings.utility.map((r) => ['Utility', r.label, r.benefit, r.cost, r.chosen]),
    ].map((r) => `<tr><td class="k">${r[0]}</td><td>${r[1]}</td><td style="white-space:normal">${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td></tr>`).join('')}</tbody></table></div>`;
    const html = multiGraphPage({
      title: 'DFO enchant plan',
      subtitle: `${plan.weaponName}${plan.rows.find((r) => /Shield|Buckler/.test(r.slot)) ? ` + ${plan.rows.find((r) => /Shield|Buckler/.test(r.slot)).item}` : ''}; ${plan.soulGem ? `soul gem +${SOUL_GEM_POINTS} on every piece` : 'template enchantment points only'}. Budgets are the game's ItemTemplates enchantmentPoints plus the stated soul gem; a POWER is positive, a side effect negative.`,
      sections: [{ title: 'Per piece', note: `Boss-first fill against the level-45 Breach (${group}, 600 per-hit cap). Backstabbing is not planned: its ×3 is capped after the roll, so +15 Backstabbing adds no capped DPS on the capped weapons. Uncapped theory puts weapon skill and Critical Strike on every piece; cap-aware buys only what the current cap pays. One-piece effects go out once; Repairs Objects is a player-chosen count (default 1); Regens Health is optional and off by default (heal spells are stronger). Empty pieces have no remaining effect that added capped DPS. Strike procs are capped per hit too; the weapon holds ${plan.maxProcs} proc row${plan.maxProcs === 1 ? '' : 's'} over its ${plan.swings}-swing Breach fight (10 condition a proc). ${plan.soulGem ? 'The soul gem is applied to every piece.' : 'No soul gem: base template points only.'}${plan.imprint?.base ? ` The weapon's imprint is separate from this budget: best boss ${plan.imprint.base.power.name} (${fmt(plan.imprint.base.carriedDps)} carried DPS), best uncapped ${plan.imprint.uncapped.power.name} (${fmt(plan.imprint.uncapped.carriedUncappedDps)} carried DPS).` : ''}`, chart: '', table: pieceTable + oneTable + stackTable + weaponTable + ratingTable }],
    });
    writePage(out, html);
    if (!values.json) console.log(`enchant plan written: ${out}`);
    if (values.json) console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (cmd === 'imprints') {
    const family = values.family ? imprintFamilyById(values.family) : null;
    if (values.family && !family) {
      console.error(`unknown imprint family: ${values.family}`);
      process.exit(2);
    }
    const sort = values.uncapped ? 'uncapped' : values['cap-aware'] ? 'boss' : values.sort === 'uncapped' ? 'uncapped' : values.sort === 'conditional' ? 'conditional' : 'boss';
    const rows = family
      ? rankAll({ firmament: !!values.firmament, vampire: !!values.vampire, sort }).filter((f) => f.key === family.key)
      : rankAll({ firmament: !!values.firmament, vampire: !!values.vampire, sort });
    if (!values.json) {
      console.log('Weapon imprints');
      for (const f of rows) {
        console.log(`\n${f.name} - ${f.weapon} (${fmt(f.base.carriedCappedDps)} carried per-hit-capped DPS; the Breach allowance is not applied to imprint rankings)`);
        console.log(table(f.rows.map((r) => [r.power.name, r.name, r.weapon, r.hit, fmt(r.baseDps), fmt(r.delta), fmt(r.uncappedDps), fmt(r.uncappedDelta), fmt(r.conditionalDps), fmt(r.triggerDelta), r.trigger, r.power.brief]), ['Imprint', 'Of', 'On', 'Hit', 'Boss carried DPS', 'Boss carried gain', 'Uncapped carried DPS', 'Uncapped carried gain', 'Trigger carried DPS', 'Trigger carried gain', 'Trigger', 'Effect'], ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'left', 'left']));
      }
    }
    const out = path.resolve(values.out === 'dfo-dps-report.html' ? 'imprints.html' : values.out);
    const sections = rows.map((f) => {
      const chart = barChart({
        title: `${f.name} imprints - ${f.weapon}`,
        labels: f.rows.map((r) => r.power.name),
        series: [
          { name: 'Boss', values: f.rows.map((r) => r.baseDps) },
          { name: 'Trigger', values: f.rows.map((r) => r.conditionalDps) },
          { name: 'Uncapped', values: f.rows.map((r) => r.uncappedDps) },
        ],
      });
      const body = f.rows.map((r) => `<tr><td class="k" style="white-space:normal;min-width:300px">${r.power.name}<br><span style="color:#a8a092;font-size:11px">of ${r.name} - ${r.power.brief}</span></td><td>${r.weapon}</td><td>${r.hit}</td><td>${fmt(r.baseDps)}</td><td>${fmt(r.delta)}</td><td>${fmt(r.uncappedDps)}</td><td>${fmt(r.uncappedDelta)}</td><td style="white-space:normal;min-width:180px">${r.trigger}</td></tr>`).join('');
      return {
        title: `${f.name} - ${f.weapon}`,
        note: `Every Weapon Legendary's power may sit on any weapon of its group; only Chain Lightning (a shot) and Earthshaker (a melee blow) narrow it. Each row reads the power on this family's best weapon. The DPS figures are the CARRIED mean (a held item carries a percentage line's fraction, so its long-run mean is the exact share), not the card's per-blow floor. Boss is the level-${THEORY_LEVEL} Breach (Daedra, 600 per-hit cap); Uncapped is the same weapon with no cap. Trigger applies the condition only where it can occur at the Breach; otherwise it is marked. The imprint is the Legendary power only; the Rare's own affixes are separate.`,
        chart,
        table: `<div class="table"><table><thead><tr><th>Imprint</th><th>On</th><th>Hit</th><th>Carried per-hit-capped DPS</th><th>Carried per-hit-capped gain</th><th>Carried uncapped DPS</th><th>Carried uncapped gain</th><th>Trigger</th></tr></thead><tbody>${body}</tbody></table></div>`,
      };
    });
    const html = multiGraphPage({
      title: 'DFO weapon imprints',
      subtitle: `The Reforge's Rare imprints on each family's best max-profile weapon${values.firmament ? ', +Firmament' : ''}. Boss is the level-45 Breach with its 600 cap; Uncapped is the same weapon without it. DPS is the carried mean (the held item's long-run share, not the card's per-blow floor). Ranked by ${sort === 'uncapped' ? 'uncapped' : sort === 'conditional' ? 'trigger' : 'boss'} carried DPS.`,
      sections,
    });
    writePage(out, html);
    if (!values.json) console.log(`imprints page written: ${out}`);
    if (values.json) console.log(JSON.stringify(rows.map((f) => ({ family: f.key, weapon: f.weapon, template: f.template, baseDps: f.base.carriedCappedDps, cardBaseDps: f.base.cappedDps, metric: 'carried', rows: f.rows.map((r) => ({ id: r.id, record: r.name, power: r.power.name, weapon: r.weapon, baseDps: r.baseDps, conditionalDps: r.conditionalDps, uncappedDps: r.uncappedDps, delta: r.delta, uncappedDelta: r.uncappedDelta, triggerDelta: r.triggerDelta, trigger: r.trigger, hit: r.hit, effect: r.power.brief })) })), null, 2));
    return;
  }

  if (cmd === 'probe') {
    let file = parsed.positionals[1] ?? values.data;
    if (!file) {
      const live = path.join(os.homedir(), '.local/share/dfo-tools/probe-mod/captures');
      const dir = values.old ? path.join(live, 'old') : live;
      try {
        const latest = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
          .map((f) => {
            const full = path.join(dir, f);
            let at = fs.statSync(full).mtimeMs;
            try { at = Date.parse(JSON.parse(fs.readFileSync(full, 'utf8')).capturedAt) || at; } catch { /* use mtime */ }
            return { f, at };
          })
          .sort((a, b) => b.at - a.at)[0];
        if (latest) file = path.join(dir, latest.f);
      } catch { /* no probe folder yet */ }
      if (!file) {
        const where = values.old ? path.join(live, 'old') : live;
        console.error(`probe: no capture in ${where}${values.old ? '' : ' (try --old for captures/old)'}`);
        process.exit(2);
      }
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    } catch (e) {
      console.error(`probe: cannot read ${file}: ${e.message}`);
      process.exit(2);
    }
    const levelOverride = argv.includes('--level') || argv.some((a) => a.startsWith('--level=')) ? values.level : undefined;
    const playersOverride = argv.includes('--players') || argv.some((a) => a.startsWith('--players=')) ? values.players : undefined;
    const summary = summarizeProbe(data, { level: levelOverride, players: playersOverride });
    if (!values.json) {
      console.log(`Combat Probe  |  ${summary.fights.length} fight${summary.fights.length === 1 ? '' : 's'}  |  level ${summary.level}, ${summary.players} player${summary.players === 1 ? '' : 's'}  |  build ${summary.build || '-'}`);
      if (!summary.fights.length) console.log('No boss health samples found. Arm the probe before the pull and stop it after.');
      for (const [i, f] of summary.fights.entries()) {
        console.log(`\nFight ${i + 1}  |  ${f.content}  |  ${f.name || 'boss'}  |  ${fmt(f.seconds)} s`);
        console.log(table([
          ['Boss health', f.maxHp != null ? `${f.maxHpEstimated ? '~' : ''}${fmt(f.maxHp)}` : '-'],
          ['Landing damage', f.damage != null ? `${f.maxHpEstimated ? '~' : ''}${fmt(f.damage)}` : `${fmt(f.hpLost)}%`],
          ['Landed DPS', f.dps != null ? `${f.maxHpEstimated ? '~' : ''}${fmt(f.midFight ? f.dpsSinceJoin : f.dps)}${f.midFight ? ' (since join)' : ''}` : '-'],
          ['Damage since join', f.midFight ? fmt(f.damageSinceJoin) : '-'],
          ['Boss heals', f.bossHeal > 0 ? fmt(f.bossHeal) : '-'],
          ['Joined at', f.midFight ? `${fmt(f.joinedAtPct)}%` : '-'],
          ['Burst 5s', f.burst5 != null ? `${f.maxHpEstimated ? '~' : ''}${fmt(f.burst5)}` : '-'],
          ['Levels', `${f.levels.length} known / ${f.players} players${f.maxHpEstimated ? `, fill ${f.levelFill}` : ''}`],
          ['Outcome', f.outcome],
          ['Weapon', f.weapon ?? '-'],
          ['Off hand', f.offWeapon ?? '-'],
          ['Imprint', f.imprint ?? '-'],
          ['Largest 0.1s step', f.maxStep != null ? fmt(f.maxStep) : `${fmt(f.maxStepPct)}%`],
          ['No-damage time', `${fmt(f.immunityS)} s (${pc(f.immunityShare)})`],
          ['Warded time', f.wardedS > 0 ? `${fmt(f.wardedS)} s` : '-'],
          ['Sub-phases', f.subs.length ? f.subs.slice(0, 3).map((x) => `${x.name} ${fmt(x.seconds)}s`).join('; ') : '-'],
          ['Split samples', f.halves.length ? `${f.halves.length} samples with halves` : '-'],
          ...(f.chartTop?.some((r) => r.best > 0 || r.blows > 0) ? [
            ['Top-10 best blow', fmt(Math.max(...f.chartTop.map((r) => r.best || 0)))],
            ['Top-10 blows', String(f.chartTop.reduce((a, r) => a + (r.blows || 0), 0))],
            ['Top-10 falls / healed', `${f.chartTop.reduce((a, r) => a + (r.falls || 0), 0)} / ${fmt(f.chartTop.reduce((a, r) => a + (r.healed || 0), 0))}`],
          ] : []),
        ], ['Metric', 'Value'], ['left', 'right']));
      }
    }
    const out = path.resolve(values.out === 'dfo-dps-report.html' ? 'probe.html' : values.out);
    const sections = summary.fights.flatMap((f, i) => {
      const hpCurve = lineChart({
        title: `${f.content} fight ${i + 1} - boss health`,
        xLabel: 'Seconds',
        yLabel: 'Boss HP %',
        series: [{ name: 'HP', points: f.curve.map((p) => ({ x: p.t, y: p.hp })) }],
      });
      const dpsCurve = lineChart({
        title: `${f.content} fight ${i + 1} - landed DPS`,
        xLabel: 'Seconds',
        yLabel: 'DPS',
        series: [{ name: 'Landed DPS', points: f.dpsCurve }],
      });
      const chart = chartTotals(f.chart);
      return [{
        title: `${f.content} - ${f.name || 'boss'} (${fmt(f.seconds)} s)`,
        note: `HP-derived figures, not the fight-end chart. Largest 0.1 s step is the best cap probe; no-damage time is the known immunity (tuning forks, phase shields). A tilde means the chart listed only the top 10 and the remaining players are filled at the median known level. The top-10 best blow and blows are the chart's rows, not the whole group.${chart?.names?.length ? ` Chart names: ${chart.names.join(', ')}.` : ''}`,
        chart: hpCurve,
        table: `<div class="table"><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>${[
          ['Boss health', f.maxHp != null ? `${f.maxHpEstimated ? '~' : ''}${fmt(f.maxHp)}` : '-'],
          ['Landing damage', f.damage != null ? `${f.maxHpEstimated ? '~' : ''}${fmt(f.damage)}` : `${fmt(f.hpLost)}%`],
          ['Landed DPS', f.dps != null ? `${f.maxHpEstimated ? '~' : ''}${fmt(f.midFight ? f.dpsSinceJoin : f.dps)}${f.midFight ? ' (since join)' : ''}` : '-'],
          ['Damage since join', f.midFight ? fmt(f.damageSinceJoin) : '-'],
          ['Boss heals', f.bossHeal > 0 ? fmt(f.bossHeal) : '-'],
          ['Joined at', f.midFight ? `${fmt(f.joinedAtPct)}%` : '-'],
          ['Burst 5s', f.burst5 != null ? `${f.maxHpEstimated ? '~' : ''}${fmt(f.burst5)}` : '-'],
          ['Levels', `${f.levels.length} known / ${f.players} players${f.maxHpEstimated ? `, fill ${f.levelFill}` : ''}`],
          ['Outcome', f.outcome],
          ['Weapon', f.weapon ?? '-'],
          ['Off hand', f.offWeapon ?? '-'],
          ['Imprint', f.imprint ?? '-'],
          ['Largest 0.1 s step', f.maxStep != null ? fmt(f.maxStep) : `${fmt(f.maxStepPct)}%`],
          ['No-damage time', `${fmt(f.immunityS)} s (${pc(f.immunityShare)})`],
          ['Warded time', f.wardedS > 0 ? `${fmt(f.wardedS)} s` : '-'],
          ['Sub-phases', f.subs.length ? f.subs.slice(0, 3).map((x) => `${x.name} ${fmt(x.seconds)}s`).join('; ') : '-'],
          ['Split samples', f.halves.length ? `${f.halves.length}` : '-'],
          ...(f.chartTop?.some((r) => r.best > 0 || r.blows > 0) ? [
            ['Top-10 best blow', fmt(Math.max(...f.chartTop.map((r) => r.best || 0)))],
            ['Top-10 blows', String(f.chartTop.reduce((a, r) => a + (r.blows || 0), 0))],
            ['Top-10 falls / healed', `${f.chartTop.reduce((a, r) => a + (r.falls || 0), 0)} / ${fmt(f.chartTop.reduce((a, r) => a + (r.healed || 0), 0))}`],
          ] : []),
        ].map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('')}</tbody></table></div>`,
      }, {
        title: `${f.content} - landed DPS over time`,
        note: 'Per-sample health delta at 10 Hz; a gap is an immune window or a phase shield.',
        chart: dpsCurve,
        table: '',
      }];
    });
    const html = multiGraphPage({
      title: 'DFO Combat Probe',
      subtitle: `Read-only boss-bar capture. Level ${summary.level}, ${summary.players} player${summary.players === 1 ? '' : 's'}. HP-derived figures; the fight-end chart is shown only as a cross-check.`,
      sections: sections.length ? sections : [{ title: 'No fights', note: 'No boss health samples found.', chart: '', table: '' }],
    });
    writePage(out, html);
    if (!values.json) console.log(`probe page written: ${out}`);
    if (values.json) console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (cmd === 'firmament') {
    const ids = values.build ? String(values.build).split(',').map((x) => x.trim()).filter(Boolean) : buildIds();
    const unknown = ids.filter((id) => !buildById(id));
    if (unknown.length) {
      console.error(`unknown firmament build: ${unknown.join(', ')} (choose ${buildIds().join(', ')})`);
      process.exit(2);
    }
    const stars = values.stars != null ? Math.max(0, Math.min(98, Math.trunc(n(values.stars, 98)))) : 98;
    const cache = values.refresh
      ? { version: FIRMAMENT_CACHE_VERSION, fingerprint: firmamentFingerprint(), plans: {} }
      : loadFirmamentCache();
    let cached = 0;
    let computed = 0;
    const plans = ids.map((id) => {
      const build = buildById(id);
      const key = planKey(id, stars);
      const hit = cache.plans[key];
      if (hit) {
        cached++;
        return planFromTree(build, hit);
      }
      const plan = planBuild(build, { stars });
      cache.plans[key] = { start: plan.start, keys: plan.tree.keys, stars: plan.stars, starBudget: plan.starBudget };
      computed++;
      return plan;
    });
    if (computed) saveFirmamentCache(cache);
    if (!values.json) {
      console.log(`Firmament plans${cached || computed ? ` (${cached} cached, ${computed} computed)` : ''}`);
      console.log(table(plans.map((p) => {
        const s = planSummary(p);
        return [
          p.build.name,
          p.startName,
          `${p.stars}/${p.starBudget}${p.freeStars ? ` (+${p.freeStars} free)` : ''}`,
          p.build.skill ? `${s.rows.find((r) => r.key === 'blow')?.value ?? 0}%` : p.build.school ? `${s.rows.find((r) => r.key === 'castCost')?.value ?? 0}%` : `${p.totals.hp ?? 0} HP`,
          s.counts.notable,
          s.counts.keystone,
        ];
      }), ['Build', 'Start', 'Stars', 'Group', 'Notables', 'Keystones'], ['left', 'left', 'right', 'right', 'right', 'right']));
    }
    const out = path.resolve(values.out === 'dfo-dps-report.html' ? 'firmament.html' : values.out);
    const html = multiGraphPage({
      title: 'DFO Firmament trees',
      subtitle: `The game's own ${FIRMAMENT_NODES} stars, ${stars} Stars per build, no Craft points assumed. One deterministic channel-coverage plan per build; keystones are never walked through. The weapons page +Firmament column is the flat channel ceiling, not this allocation.`,
      sections: plans.map(firmamentSection),
    });
    writePage(out, html);
    if (!values.json) console.log(`firmament page written: ${out}`);
    if (values.json) console.log(JSON.stringify(plans.map((p) => ({ build: p.build.id, name: p.build.name, start: p.tree.start, startName: p.startName, stars: p.stars, budget: p.starBudget, freeStars: p.freeStars, keys: p.tree.keys, totals: p.totals })), null, 2));
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
    const enchantTarget = values.target === 'armoured' ? gateTarget(n(values.level, ch.level), { traits }) : target;
    const opts = { level: n(values.level, ch.level), potencyPct: n(values.potency, 0), pierce: n(values.pierce, 0) };
    const rows = (item.enchantments ?? []).filter((e) => e && e.type >= 0);
    const names = Object.fromEntries(Object.entries(ENCHANTMENT_TYPES).map(([k, v]) => [v, k]));
    const strike = strikeEnchantments(item, ch, enchantTarget, opts);
    const r = analyze(ch, { ...scenario, target: enchantTarget, health: enchantTarget.isBoss ? enchantTarget.maxHealth : 0, potencyPct: opts.potencyPct, pierce: opts.pierce });
    textOut(values, `${characterLabel(ch)}  |  ${item.name ?? 'weapon'}`);
    textOut(values, table(rows.map((e) => [names[e.type] ?? e.type, e.param ?? '-', e.type === 2 ? (strike.procs.find((p) => p.index === Number(e.param))?.name ?? 'spell') : '-']), ['Enchantment', 'Param', 'Spell'], ['left', 'right', 'left']));
    textOut(values, table([
      ['Uncapped weapon DPS', fmt(r.dps)],
      ['Enchant per landed hit', `${fmt(strike.procDamage + strike.flat)}${strike.procDot ? ` + ${fmt(strike.procDot / 5)} DoT DPS` : ''}`],
      ['Enchant DPS (ceiling component)', fmt(r.enchantDps)],
      ['Total (per-hit-capped ceiling)', fmt(r.ceilingTotalDps)],
      ...(r.target.allowance ? [
        ['Allowance-sustained DPS', fmt(r.claimSustainedDps)],
        ['Time to kill (allowance-sustained)', r.totalTtk != null ? `${fmt(r.totalTtk)} s` : r.allowance ? 'no kill' : 'no allowance run'],
        ['Time to kill (per-hit-capped ceiling)', r.ceilingTotalTtk ? `${fmt(r.ceilingTotalTtk)} s` : '-'],
      ] : []),
      ['CWS bills covered (bill-only)', r.procsBeforeBreak ?? '-'],
      ['Procs', strike.procs.map((p) => `${p.name} ${p.dotTick ? `DoT ${fmt(p.dotTick)}/round` : fmt(p.damage)}`).join(', ') || '-'],
    ], ['Metric', 'Value']));
    if (values.json) console.log(JSON.stringify({ enchantments: rows, strike, result: { weaponDps: r.dps, enchantDps: r.enchantDps, totalDps: r.totalDps, totalTtk: r.totalTtk, ceilingTotalDps: r.ceilingTotalDps, ceilingTotalTtk: r.ceilingTotalTtk, claimTotalTtk: r.claimTotalTtk, claimSustainedDps: r.claimSustainedDps, procsBeforeBreak: r.procsBeforeBreak, procsBeforeBreakBasis: r.procsBeforeBreakBasis } }, null, 2));
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
    const subtitle = `${characterLabel(ch)} | ${list.length} standard damage spells | ${spellTarget.isBoss ? `Breach ${spellTarget.maxHealth.toLocaleString()} HP` : `level ${spellTarget.level}`} | ${n(values.seconds, 30)}s window | potency ${n(values.potency, 0)}% | pierce ${n(values.pierce, 0)}`;
    const html = multiGraphPage({
      title: 'DFO spell ceiling',
      subtitle,
      sections: [
        { title: 'Sustained DPS', note: 'Mana is treated as solved by default; --mana-limit prices the pool. A DoT is one instance per target and renews, never stacks. DPS cells are averages; the bar is the average.', chart: dpsChart, table: tableHtml },
        { title: 'Damage per spell point', note: 'The metric that binds a long fight. A 30s window may not spend the whole pool.', chart: effChart },
      ],
    });
    const out = path.resolve(values.out === 'dfo-dps-report.html' ? 'spells.html' : values.out);
    writePage(out, html);
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
      if (!found) throw new UsageError(`spell "${values.spell}" not found in the resolved spellbook`);
      chosen = found;
    }
    const { sp } = chosen;
    const r = spellRotation(sp, ch, spellTarget, { ...opts, seconds: n(values.seconds, 30) });
    textOut(values, `${characterLabel(ch)}  |  ${sp.name} (${skillName(r.school)})`);
    textOut(values, table([
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
      ['Target', `${spellTarget.isBoss ? 'Breach' : values.target}, level ${spellTarget.level}${spellTarget.isBoss ? `, ${spellTarget.maxHealth.toLocaleString()} HP` : ''}`],
      ['Time to kill', r.ttk ? `${fmt(r.ttk)} s` : '-'],
    ], ['Metric', 'Value']));
    if (r.elements?.length) {
      textOut(values, '\nEffects');
      textOut(values, table(r.elements.map((e) => [e.key, e.magnitude != null ? fmt(e.magnitude) : '-', e.rounds ?? 1, fmt(e.damage), e.note ?? '']), ['Effect', 'Magnitude', 'Rounds', 'Damage', 'Note'], ['left', 'right', 'right', 'right', 'left']));
    }
    if (values.json) console.log(JSON.stringify({ index: sp.index, name: sp.name, ...r }, null, 2));
    return;
  }

  if (cmd === 'weapons' || cmd === 'skills') {
    const level = n(values.level, THEORY_LEVEL);
    const firmCharts = !!values.firmament;
    const fixedRace = values.race ? String(values.race).toLowerCase() : null;
    const vampire = !!values.vampire;
    const PROF_OF = Object.freeze({ ShortBlade: 1, LongBlade: 2, HandToHand: 4, Axe: 8, BluntWeapon: 16, Archery: 32 });
    const MELEE = Object.keys(WEAPONS).map(Number).filter((t) => WEAPONS[t]?.skill && !WEAPONS[t].ammo);
    const familyOf = (t) => WEAPONS[t]?.skill ?? 'HandToHand';
    const maxTarget = referenceFoe(level, 'tough');
    const gate = gateTarget(level);
    const maxRun = (ch, share = 1) => analyze(ch, { target: maxTarget, core: 'overhaul', rri: true, healthShare: share, passiveOn: true, stacks: 5, pair: !!ch?._pair, dual: !!ch?._dual });
    const gateRun = (ch) => analyze(ch, { target: gate, core: 'overhaul', rri: true, health: gate.maxHealth, healthShare: 1, passiveOn: true, stacks: 5, pair: !!ch?._pair, dual: !!ch?._dual });
    const martialFor = () => 'blademaster';
    const shareFor = () => 1;

    const makeMax = (t, {
      race = 'darkelf', firmament = false, raw = 200, gear = null, critGear = null, damagePct = null, martial = martialFor(t),
    } = {}) => {
      const legal = legalGear(familyOf(t) === 'HandToHand' && t == null ? 563 : t);
      if (familyOf(t) === 'HandToHand') {
        const starStats = firmament ? { strength: 15, agility: 15, speed: 15, luck: 15 } : {};
        const starSkills = firmament ? { [SKILLS.HandToHand]: 15, [SKILLS.CriticalStrike]: 15, [SKILLS.Backstabbing]: 15 } : {};
        const ch = theoryFists({
          race, rawH2H: raw, gearH2H: gear ?? legal.lb, gearCrit: critGear ?? legal.cs,
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
        blade: t, race, gearLB: 0, gearCS: 0, damagePct: damagePct ?? legal.dmg,
        vampire, starStats, starSkills, starDamage: firmament ? 30 : 0, sockets: perfectSockets(t),
      });
      ch.career = { ...(ch.career ?? {}), weaponArmorShieldsBitfield: (PROF_OF[tpl.skill] ?? 0) << 16 };
      ch.skills[skillId] = raw;
      ch.masteredSkills = [skillId, SKILLS.CriticalStrike, SKILLS.Backstabbing];
      ch._mods.skills = {
        ...(ch._mods.skills ?? {}),
        [skillId]: (gear ?? legal.lb) + (firmament ? 15 : 0),
        [SKILLS.CriticalStrike]: (critGear ?? legal.cs) + (firmament ? 15 : 0),
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
      const ch = makeMax(t, { race, firmament: false });
      const treeCh = applyTree(ch, familyOf(t));
      const r = maxRun(treeCh, shareFor(t));
      const g = gateRun(treeCh);
      return {
        template: t, name: nameOf(t), skill: familyOf(t), twoHanded: familyOf(t) === 'HandToHand' ? false : WEAPONS[t].twoHanded,
        path: martialFor(t), race, maxDps: r.dps, gateDps: g.allowance?.averageDps ?? g.cappedDps, gateCeiling: g.cappedDps,
        gateTtk: g.ttk, gateBurst: g.allowance?.burst5Dps ?? null, perSwing: r.perSwing, aps: r.cadence.aps,
      };
    }).sort((a, b) => b.maxDps - a.maxDps);

    // Dual pairs: the one-handed templates, both hands of the same weapon.
    for (const t of [113, 114, 116, 117, 118, 119, 120, 121, 124, 127]) {
      const race = bestRace(t, { firmament: false, dual: true });
      const ch = makeDual(t, { race, firmament: false });
      const treeCh = applyTree(ch, familyOf(t));
      const r = maxRun(treeCh, shareFor(t));
      const g = gateRun(treeCh);
      rows.push({
        template: t, name: `Dual ${nameOf(t)}`, skill: familyOf(t), twoHanded: false, dual: true,
        path: martialFor(t), race, maxDps: r.dps, gateDps: g.allowance?.averageDps ?? g.cappedDps, gateCeiling: g.cappedDps, gateTtk: g.ttk, gateBurst: g.allowance?.burst5Dps ?? null,
        perSwing: r.perSwing, aps: r.cadence.aps,
      });
    }
    rows.sort((a, b) => b.maxDps - a.maxDps);

    const categoryOf = (r) => (r.dual ? 'DW' : r.skill === 'HandToHand' ? 'Fists' : r.twoHanded ? '2H' : '1H');
    const categoryMetric = 'maxDps';
    // One winner per weapon type in each hand slot, so a single blade family
    // cannot take the whole page. Hand-to-Hand is its own shape, not 1H/2H/DW.
    const categorySlots = ['1H', '2H', 'DW', 'Fists'];
    const topRows = categorySlots.flatMap((cat) => rows
      .filter((r) => categoryOf(r) === cat)
      .sort((a, b) => b[categoryMetric] - a[categoryMetric])
      .filter((r, i, list) => list.findIndex((x) => x.skill === r.skill) === i))
      .sort((a, b) => b[categoryMetric] - a[categoryMetric]);
    const displayRows = values.categories ? topRows : rows;
    const SKILL_LABELS = { ShortBlade: 'Short Blade', LongBlade: 'Long Blade', Axe: 'Axe', BluntWeapon: 'Blunt Weapon', Archery: 'Archery', HandToHand: 'Hand-to-Hand' };

    const cell = (v) => (Number.isFinite(v) ? fmt(v) : '-');
    const maxTable = `<table><thead><tr><th>Weapon</th><th>Type</th><th>Hands</th><th>Path</th><th>Uncapped DPS</th><th>Per-hit-capped</th><th>Boss kill-avg DPS</th><th>Boss burst 5s</th><th>Boss TTK</th></tr></thead><tbody>${displayRows.map((r) => `<tr><td class="k">${r.name}</td><td>${SKILL_LABELS[r.skill] ?? r.skill}</td><td>${r.dual ? 'Dual' : r.skill === 'HandToHand' ? 'Fists' : r.twoHanded ? '2H' : '1H'}</td><td>${r.path}</td><td>${cell(r.maxDps)}</td><td>${cell(r.gateCeiling)}</td><td>${cell(r.gateDps)}</td><td>${cell(r.gateBurst)}</td><td>${r.gateTtk ? `${cell(r.gateTtk)} s` : '-'}</td></tr>`).join('')}</tbody></table>`;
    const top = displayRows.slice().sort((a, b) => b.maxDps - a.maxDps)[0];
    const gateTop = rows.slice().sort((a, b) => b.gateDps - a.gateDps)[0];
    const scope = values.categories ? 'best of every type' : 'absolute uncapped ceiling';

    const bossRows = displayRows.slice().sort((a, b) => b.gateDps - a.gateDps);
    const uncappedRows = displayRows.slice().sort((a, b) => b.maxDps - a.maxDps);
    const bossBar = barChart({
      title: 'Breach kill-average DPS by weapon - level-45, through the relay allowance',
      labels: bossRows.map((r) => r.name),
      series: [{ name: 'Kill-average', values: bossRows.map((r) => r.gateDps) }],
    });
    const uncappedBar = barChart({
      title: 'Uncapped DPS by weapon - no per-hit cap',
      labels: uncappedRows.map((r) => r.name),
      series: [{ name: 'Firmament', values: uncappedRows.map((r) => r.maxDps) }],
    });
    const bossTop = bossRows[0];
    const bossNote = `<b>${bossTop.name}</b> leads this list at <b>${cell(bossTop.gateDps)} kill-average DPS</b> through the relay's per-player allowance${bossTop.gateTtk ? ` (${cell(bossTop.gateTtk)} s TTK)` : ''}. The full pool's Breach winner is <b>${gateTop.name}</b> at <b>${cell(gateTop.gateDps)}</b>. This is the real Firmament tree at the level-45 Breach: ${gate.maxHealth.toLocaleString()} HP, a ${gate.hitCap} per-hit cap and a ${3 * (5 + level)} a second allowance refill; the per-hit-capped column is the ceiling before that allowance.`;
    const uncappedNote = `<b>${top.name}</b> is the ${scope} at <b>${cell(top.maxDps)} DPS</b> (${top.path}, Dunmer), using the real Firmament tree and no per-hit cap. Enchants and imprints are on the loadout page, not this table. Full health and Blademaster only: Berserker's below-half upkeep is not assumed. All rows are Dunmer; DPS cells are averages.${values.categories ? ' One row per weapon type per slot, including the Hand Wraps fist row; the table is sorted by uncapped DPS.' : ''}`;

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
      const chartTemplate = f.key === 'HandToHand' ? 563 : (f.templates.find((t) => t != null) ?? 123);
      const gearMax = maxSingleSkill({ weaponTemplate: chartTemplate });
      const culprit = legalGear(chartTemplate);
      const rangedNote = f.key === 'Archery' ? ' Bows use the paced BOW_FAST window; the Pistolet is a pair.' : '';
      const gearVals = [];
      for (let v = 30; v < gearMax; v += 30) gearVals.push(v);
      gearVals.push(gearMax);
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
      const note = `One line per weapon: raw training 100 -> 200 is effective 100 -> 140; gear lines continue from effective 140 to ${140 + gearMax} (the legal single-skill maximum: every other slot carries the build's legal share). Max legal gear, Dunmer, career expertise, best path, ${culprit.dmg}% damage line, sockets, no per-hit cap. The table uses the real Firmament tree; these curves are the flat skill-scaling view.${f.key === 'Axe' || f.key === 'HandToHand' ? ' Blademaster, full health; no Berserker below-half assumption.' : ''}${firmCharts ? ' Firmament channels on.' : ''}${rangedNote}`;
      return {
        title: f.title,
        note,
        chart: lineChart({ title: `${f.title}: effective skill`, xLabel: 'Effective weapon skill', yLabel: 'DPS', series: skillSeries }),
      };
    });

    const topPerFamily = families.map((f) => rows.find((r) => familyOf(r.template) === f.key && !r.dual)).filter(Boolean);
    const csMaxFor = (t) => maxSingleSkill({ weaponTemplate: t, skill: SKILLS.CriticalStrike });
    const csSeries = topPerFamily.map((row) => {
      const top = csMaxFor(row.template);
      const csVals = [];
      for (let v = 0; v < top; v += 60) csVals.push(v);
      csVals.push(top);
      return {
        name: row.name,
        points: csVals.map((v) => ({ x: v, y: maxRun(makeMax(row.template, { race: row.race, firmament: firmCharts, critGear: v }), shareFor(row.template)).dps })),
      };
    });
    const csCap = Math.max(...topPerFamily.map((row) => csMaxFor(row.template)));
    const csSection = {
      title: 'Critical Strike scales every weapon',
      note: `The best weapon of each family, raw 200 and its legal weapon-skill share, with Critical Strike gear from 0 to ${csCap} (the legal single-skill maximum). Critical Strike is the shared multiplier: chance caps at 100%, then every point adds 0.01 to the multiplier.`,
      chart: lineChart({ title: `Critical Strike gear 0 -> ${csCap}`, xLabel: 'Critical Strike gear points', yLabel: 'DPS', series: csSeries }),
    };

    const subtitle = `Level ${level} | real Firmament tree | Dunmer | career expertise | Blademaster, no Berserker | legal gear profile (weapon skill / Critical Strike / damage per weapon) | target: level-${level} tough, no per-hit cap | boss: ${gate.maxHealth.toLocaleString()} HP, ${gate.hitCap} per-hit cap${vampire ? ' | vampire +30 CS' : ''}`;
    const html = multiGraphPage({
      title: 'DFO weapon ceiling and skill scaling',
      subtitle,
      sections: values.categories
        ? [
            { title: 'Breach DPS through the relay allowance - level-45', note: bossNote, chart: bossBar },
            { title: 'Uncapped DPS', note: uncappedNote, chart: uncappedBar, table: maxTable },
          ]
        : [
            { title: 'Breach DPS through the relay allowance - level-45', note: bossNote, chart: bossBar },
            { title: 'Uncapped DPS', note: uncappedNote, chart: uncappedBar, table: maxTable },
            ...familySections,
            csSection,
          ],
    });
    const defaultOut = cmd === 'weapons' ? 'weapons.html' : 'skills.html';
    const out = path.resolve(values.out === 'dfo-dps-report.html' ? defaultOut : values.out);
    writePage(out, html);
    if (!values.json) console.log(`weapons page written: ${out}`);
    if (values.json) console.log(JSON.stringify({ level, firmCharts, rows: values.categories ? displayRows : rows, cs: csSeries }, null, 2));
    return;
  }

  if (cmd === 'theory') {
    const level = n(values.level, THEORY_LEVEL);
    const blade = ch.weapon?.templateIndex ?? DEFAULT_BLADE;
    const material = ch.weapon?.material ?? 9;
    const legal = legalGear(blade);
    const lbCap = maxSingleSkill({ weaponTemplate: blade });
    const csCap = maxSingleSkill({ weaponTemplate: blade, skill: SKILLS.CriticalStrike });
    const damage = values['damage-pct'] != null ? n(values['damage-pct'], 0) : legal.dmg;
    if (values['gear-lines'] != null || values['line-points'] != null) {
      console.error('note: --gear-lines / --line-points are obsolete; a line is not a budget. Use --gear-lb / --gear-cs in points (the legal maximum is shown below).');
    }
    if (damage > 38) {
      console.error(`WARNING: ${damage}% damage is above every Legendary record's fixed line (the best record carries 38%); this is a hypothetical build.`);
    }
    const explicitGear = values['gear-lb'] != null || values['gear-cs'] != null;
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

    // The legal frontier: every attainable (weapon skill, Critical Strike, damage) split of the 18 slots,
    // re-run at THIS target (the frontier's own DPS numbers are the reference target's).
    const frontierRows = legalFrontier(blade).map((p) => {
      const c = make({ rawBlade: 200, rawCrit: 200, gearLB: p.lb, gearCS: p.cs, damagePct: p.dmg });
      const r = run(c);
      return { lb: p.lb, cs: p.cs, dmg: p.dmg, total: p.lb + p.cs, dps: r.dps, cappedDps: r.cappedDps, perSwing: r.perSwing, ttk: r.ttk, ch: c, r };
    }).sort((a, b) => a.lb - b.lb);
    const maxLb = numFlag(values, 'gear-lb', legal.lb, { min: 0 });
    const maxCs = numFlag(values, 'gear-cs', legal.cs, { min: 0 });
    const keyOf = (x) => `${x.lb}/${x.cs}/${x.dmg}`;
    const onFrontier = frontierRows.find((x) => x.lb === maxLb && x.cs === maxCs);
    const maxCh = make({ rawBlade: 200, rawCrit: 200, gearLB: maxLb, gearCS: maxCs, damagePct: damage });
    const maxR = run(maxCh);
    const maxBehind = behind(maxCh);

    const stages = [
      { label: 'Naked skills', raw: 100, gearLB: 0, gearCS: 0, damage: 0, vampire: false, sockets: [] },
      { label: 'Mastered skills', raw: 200, gearLB: 0, gearCS: 0, damage: 0, vampire: false, sockets: [] },
      { label: 'Legal gear (no damage line)', raw: 200, gearLB: maxLb, gearCS: maxCs, damage: 0, vampire: false },
      { label: 'Legal gear + damage line', raw: 200, gearLB: maxLb, gearCS: maxCs, damage, vampire: false },
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
    addSkill('Gear Long Blade (legal to 535)', 'gear', 29, [0, 200, 400, 535]);
    // `14512`'s formula cap is the 320% row's hypothetical; `14631` has no such cap, so the row is skipped.
    const formulaCap = gearMasteryPoints(values['game-build']);
    if (formulaCap != null) addSkill('Gear Long Blade (formula cap, hypothetical)', 'gear', 29, [formulaCap]);
    addSkill('Gear Critical Strike (legal to 535)', 'gear', 34, [0, 200, 400, 535]);

    const bladeRows = LONG_BLADES.map((idx) => {
      const c = theoryBlade(maxCh, idx, material);
      const r = run(c);
      const w = r.weapon;
      return { templateIndex: idx, name: WEAPONS[idx].name, twoHanded: w.twoHanded, dps: r.dps, dpsMin: r.dpsMin, dpsMax: r.dpsMax, cappedDps: r.cappedDps, cappedDpsMin: r.cappedDpsMin, cappedDpsMax: r.cappedDpsMax, perSwing: r.perSwing, aps: r.cadence.aps, damage: r.damage.avg, capLoss: r.capLoss, ttk: r.ttk };
    }).sort((a, b) => b.cappedDps - a.cappedDps);

    const r = maxR;
    const p = r.damage.parts;
    const frontierMaxTotal = maxPointTotal({ weaponTemplate: blade });
    if (!values.json) {
    console.log(`Level ${level} theory long blade  |  ${RACE_NAMES[maxCh.raceId] ?? maxCh.race}  |  Daedric ${WEAPONS[blade].name}`);
    const targetName = values.theory && values.target === 'armoured' ? 'gate' : values.target;
    console.log(`overhaul / online${values['no-rri'] ? '' : ' / RRI'}  |  target ${targetName} level ${r.target.level}, ${r.health.toLocaleString()} HP, ${r.cap || 'no'} per-hit cap`);
    console.log('');
    console.log(table([
      ['Attributes', STAT_KEYS.map((k) => `${k} ${liveStat(maxCh, k)}`).filter((x, i) => ['strength', 'agility', 'speed', 'luck'].includes(STAT_KEYS[i])).join(', '), 'live values; Firmament lifts the 100 ceiling, gear stat affixes do not'],
      ['Raw skills', `Long Blade raw ${maxCh.skills[29]}, mod +${maxCh._mods?.skills?.[29] ?? 0}, sheet ${maxCh.skills[29] + (maxCh._mods?.skills?.[29] ?? 0)}, formula ${skillValue(maxCh, 29)}; Critical Strike raw ${maxCh.skills[34]}, mod +${maxCh._mods?.skills?.[34] ?? 0}, sheet ${maxCh.skills[34] + (maxCh._mods?.skills?.[34] ?? 0)}, formula ${skillValue(maxCh, 34)}`, 'the sheet prints raw + mods; the formula reads effectiveSkill(raw) + mods'],
      ['Gear', `weapon skill ${maxLb} / Critical Strike ${maxCs} / damage ${damage}%`,
        explicitGear
          ? (maxLb > lbCap || maxCs > csCap
            ? `ILLEGAL: ${maxLb > lbCap ? `weapon skill ${maxLb} is above ${lbCap}` : `Critical Strike ${maxCs} is above ${csCap}`}; shown as a hypothetical build`
            : onFrontier
              ? (damage > onFrontier.dmg
                ? `ILLEGAL: damage ${damage}% is above the ${onFrontier.dmg}% attainable at ${onFrontier.lb} / ${onFrontier.cs}; shown as a hypothetical build`
                : damage === onFrontier.dmg
                  ? `explicit legal frontier point (${onFrontier.lb} / ${onFrontier.cs} / damage ${onFrontier.dmg}%)`
                  : `UNVERIFIED: ${damage}% is below the ${onFrontier.dmg}% the frontier plan carries at ${onFrontier.lb} / ${onFrontier.cs}; a lower damage line is not checked here`)
              : 'HYPOTHETICAL: attainable but not a DPS frontier point (a lower split is dominated)')
          : `legal maximum for ${WEAPONS[blade].name}: ${legal.lb} / ${legal.cs} / damage ${legal.dmg}% (the best uncapped split)`],
      ['Weapon', `Daedric ${WEAPONS[blade].name}`, `RRI ${r.weapon.min}-${r.weapon.max}, weight ${r.weapon.twoHanded ? '2H' : '1H'}`],
      ['Damage affix', `${damage}%`, `a weapon's damage line: a Rare tops at ${AFFIX_DAMAGE_TOP.rare}%, a Legendary record's is fixed (the best in the game is 38%)`],
      ['Sockets', `${perfectSockets(blade).length} x perfect diamond`, `+${12 * perfectSockets(blade).length}% damage; a two-hander has 3, a one-hander 2, a short blade 1`],
      ['Firmament blow', `${starDamage}%`, 'general weapon-blow channel, cap +30% (+50% with conditions)'],
      ['Mastery / gear', `${fmt(p.mastery)}%`, `raw climb + gear channel`],
      ['Hit / crit', `${pc(r.hit.hit)} / ${pc(r.hit.crit.chance)} x${fmt2(r.hit.crit.damageMult)}`, `critical damage multiplier`],
    ], ['Term', 'Value', 'Notes']));

    console.log('\nPush stages');
    console.log(table(stages.map((s) => [s.label, s.raw, `${s.gearLB}+${s.gearCS}`, `${s.damage}%`, fmt(s.dps), fmt(s.cappedDps), fmt(s.behind), fmt(s.perSwing), fmt2(s.aps), s.ttk ? `${fmt(s.ttk)} s` : '-']), ['Stage', 'Raw skill', 'Gear', 'Damage', 'DPS', 'Capped', 'Behind', 'Per swing', 'APS', 'TTK'], ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']));
    console.log('\nCaps (push in this order)');
    console.log(table(theoryCaps(values['game-build']).map((c) => [c.channel, c.cap, c.formula, c.note]), ['Channel', 'Cap', 'Formula', 'What it means']));

    console.log('\nAttribute scaling (everything else at the ceiling)');
    console.log(table(statScaled.map((x) => [x.stat, fmt(x.d50), fmt(x.d75), fmt(x.d100), fmt(x.capped100), `${x.delta >= 0 ? '+' : ''}${fmt(x.delta)}`, `${x.last10 >= 0 ? '+' : ''}${fmt(x.last10)}`]), ['Attribute', 'DPS 50', 'DPS 75', 'DPS 100', 'Capped 100', '50 -> 100', '90 -> 100'], ['left', 'right', 'right', 'right', 'right', 'right', 'right']));
    console.log('The DPS columns are uncapped averages and isolate the varied attribute (its star is dropped so 50..100 means the sheet); Capped 100 is the full build at the Breach. Luck is flat here only because Critical Strike already holds chance at 100%.');

    console.log('\nSkill and gear scaling');
    console.log(table(skillRows.map((x) => [x.label, x.value, fmt(x.dps), fmt(x.cappedDps), fmt(x.behind), fmt(x.perSwing), x.ttk ? `${fmt(x.ttk)} s` : '-']), ['Channel', 'Value', 'DPS', 'Capped', 'Behind', 'Per swing', 'TTK'], ['left', 'right', 'right', 'right', 'right', 'right', 'right']));
    console.log(`The "formula cap" row is hypothetical: the legal single-skill maximum is 535 points (the weapon record + 17 Exalted slots); ${values['game-build'] === '14631' ? '0.1.14631 drops the 320% cap (the gear is flat, no percent)' : `the 320% mastery cap would need ${GEAR_MASTERY_POINTS} points`}.`);

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
    console.log(`The sheet showing 215 is raw 200 + 15; the formula reads 155 (effectiveSkill(200)=140 + 15). Gear skill adds on top of both, and for Long Blade it converts at 0.44% per point${values['game-build'] === '14631' ? ', and on 0.1.14631 that percent is gone: the gear is a flat add on the roll, no cap' : ', capped at +320%'}.`);

    const firmDmgValues = [0, 10, 20, 30];
    const firmDmgCells = firmDmgValues.map((v) => run(make({ ...firmBase, starDamage: v })));
    console.log('\nFirmament weapon blow (general channel cap +30%; conditions can take the total to +50%)');
    console.log(table([
      ['DPS', ...firmDmgCells.map((r) => fmt(r.dps))],
      ['Capped', ...firmDmgCells.map((r) => fmt(r.cappedDps))],
    ], ['', ...firmDmgValues.map((v) => `+${v}% DPS`), ...firmDmgValues.map((v) => `+${v}% cap`)], ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']));

    const totalRow = frontierRows.find((x) => x.total === frontierMaxTotal);
    const keep = new Set([keyOf(legal), keyOf(frontierRows[0]), keyOf(frontierRows[frontierRows.length - 1])]);
    if (totalRow) keep.add(keyOf(totalRow));
    const step = Math.max(1, Math.ceil(frontierRows.length / 16));
    const shown = frontierRows.filter((x, i) => i % step === 0 || keep.has(keyOf(x)));

    console.log(`\nLegal gear frontier (${frontierRows.length} attainable splits of the 18 worn slots)`);
    console.log(`Single-skill maximum: weapon skill ${lbCap}, Critical Strike ${csCap}; highest combined total ${frontierMaxTotal}.`);
    if (explicitGear && (maxLb > lbCap || maxCs > csCap)) {
      console.log(`WARNING: ILLEGAL allocation. ${maxLb > lbCap ? `Weapon skill ${maxLb} is above the legal single-skill maximum ${lbCap}` : ''}${maxLb > lbCap && maxCs > csCap ? '; ' : ''}${maxCs > csCap ? `Critical Strike ${maxCs} is above ${csCap}` : ''}. The build is shown for comparison only; the rows below are what the slots can reach.`);
    } else if (explicitGear && onFrontier && damage > onFrontier.dmg) {
      console.log(`WARNING: ILLEGAL damage line. At ${onFrontier.lb} weapon skill / ${onFrontier.cs} Critical Strike the best attainable damage line is ${onFrontier.dmg}%, not ${damage}%. The build is shown for comparison only.`);
    } else if (explicitGear && onFrontier && damage !== onFrontier.dmg) {
      console.log(`NOTE: the frontier plan at ${onFrontier.lb} / ${onFrontier.cs} carries a ${onFrontier.dmg}% damage line; ${damage}% is lower, and this tool does not verify a different damage roll at the same split.`);
    } else if (explicitGear && !onFrontier) {
      console.log(`WARNING: ${maxLb} weapon skill / ${maxCs} Critical Strike is attainable but not on the DPS frontier (a lower split dominates it). The rows below are the trade-offs.`);
    } else if (explicitGear) {
      console.log(`Explicit frontier point: ${onFrontier.lb} weapon skill / ${onFrontier.cs} Critical Strike / damage ${onFrontier.dmg}%.`);
    } else {
      console.log(`Default max: ${legal.lb} weapon skill / ${legal.cs} Critical Strike / damage ${legal.dmg}% (${legal.metric}; ties: ${legal.alternatives.length}).`);
    }
    console.log(table(shown.map((x) => [x.lb, x.cs, x.total, `${x.dmg}%`, fmt(x.dps), fmt(x.cappedDps), fmt(x.perSwing), x.ttk ? `${fmt(x.ttk)} s` : '-']), ['Weapon skill', 'Critical Strike', 'Points', 'Damage', 'DPS', 'Capped', 'Per swing', 'TTK'], ['right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']));

    console.log('\nLong blades at the ceiling');
    console.log(table(bladeRows.map((x) => [x.name, x.twoHanded ? '2H' : '1H', fmt(x.dps), fmt(x.cappedDps), fmt(x.perSwing), fmt2(x.aps), fmt(x.damage), pc(x.capLoss), x.ttk ? `${fmt(x.ttk)} s` : '-']), ['Blade', 'Hands', 'DPS', 'Capped', 'Per swing', 'APS', 'Avg hit', 'Cap loss', 'TTK'], ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right']));
    console.log('The table holds the legal 18-slot budget (weapon + seven body pieces + ten jewellery pieces). A one-handed blade plus a shield has one more armour-group slot, so a shield build reaches one Exalted skill line further; the 1H rows are a lower bound.');
    console.log(`Best at this target: ${bladeRows[0].name} (${fmt(bladeRows[0].cappedDps)} capped DPS, ${fmt(bladeRows[0].dps)} uncapped).`);

    console.log(`\n${targetName[0].toUpperCase()}${targetName.slice(1)} result`);
    console.log(table([
      ['Uncapped DPS', fmt(r.dps)],
      ['Per-hit-capped DPS (ceiling)', fmt(r.cappedDps)],
      ...(r.allowance ? allowanceRows(r.allowance).slice(0, 3) : []),
      ['Per-hit range', `${r.damage.min}-${r.damage.max} (crit ${r.damage.critMin}-${r.damage.critMax})`],
      ['Cap loss', pc(r.capLoss)],
      ['Time to kill', `${fmt(r.ttk)} s`],
      ['Behind / backstab', `${fmt(maxBehind.cappedDps)} capped (${pc(maxBehind.backstab.chance)} x3)`],
      ['Phase shields', `${r.target.phaseShields} x ${r.target.shieldSeconds}s (${r.shields}s)`],
    ], ['Metric', 'Value']));
    if (r.cap && r.hit.crit.chance >= 1 && r.damage.critMin >= r.cap) {
      console.log(`At 100% critical chance every blow is a critical, and the critical minimum is already over the per-hit cap: the ${damage}% damage line adds 0 capped DPS. Speed is the only attribute that still buys capped DPS here; Strength helps only through the RRI swing law.\nAgainst an uncapped boss the same build is ${fmt(r.dps)} DPS.`);
    }
    }

    if (values.json) {
      console.log(JSON.stringify({
        character: {
          level, race: RACE_NAMES[maxCh.raceId] ?? maxCh.race, blade: WEAPONS[blade].name, material,
          slots: 18, maxLb, maxCs, damage,
          legal: { lb: legal.lb, cs: legal.cs, dmg: legal.dmg, metric: legal.metric, ties: legal.alternatives.length, violations: legal.violations },
          singleSkill: { weapon: lbCap, critical: csCap },
          frontierPoints: frontierRows.length, frontierMaxTotal,
        },
        result: { dps: r.dps, dpsMin: r.dpsMin, dpsMax: r.dpsMax, cappedDps: r.cappedDps, cappedDpsMin: r.cappedDpsMin, cappedDpsMax: r.cappedDpsMax, perSwing: r.perSwing, aps: r.cadence.aps, ttk: r.ttk, cap: r.cap, capLoss: r.capLoss, hit: r.hit.hit, critChance: r.hit.crit.chance, critMult: r.hit.crit.damageMult, damage: { min: r.damage.min, max: r.damage.max, critMin: r.damage.critMin, critMax: r.damage.critMax }, terms: p },
        stages: stages.map(({ ch: _c, r: _r, ...rest }) => rest),
        caps: theoryCaps(values['game-build']),
        stats: statScaled,
        skills: skillRows,
        splits: frontierRows.map(({ ch: _c, r: _r, ...rest }) => rest),
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
        if (!idRaw) throw new UsageError(`graph series ${spec} needs an attribute name (stat:strength)`);
        id = String(id).toLowerCase();
        current = liveStat(ch, id);
        from = n(values.from, 50); to = n(values.to, 100);
        label = `stat ${id}`;
      } else if (kind === 'skill' || kind === 'gear') {
        id = Number(id);
        if (!(id >= 0 && id < 35)) throw new UsageError(`bad skill id ${idRaw}`);
        current = kind === 'skill' ? (ch.skills?.[id] ?? 0) : (ch._mods?.skills?.[id] ?? 0);
        from = n(values.from, kind === 'skill' ? 100 : current);
        to = n(values.to, kind === 'skill' ? 200 : current + 100);
        label = kind === 'skill' ? `skill ${id}` : `gear ${id}`;
      } else if (kind === 'star') {
        if (!idRaw) throw new UsageError(`graph series ${spec} needs an attribute name (star:strength)`);
        id = String(id).toLowerCase();
        if (!STAT_KEYS.includes(id)) throw new UsageError(`bad star attribute ${idRaw}`);
        current = ch._mods?.stats?.[id] ?? 0;
        from = n(values.from, 0);
        to = n(values.to, FIRM_CHANNEL_MAX);
        label = `star ${id}`;
      } else {
        throw new UsageError(`graph series must be stat:name, skill:id, gear:id or star:name (${spec})`);
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
    const out = path.resolve(values.out === 'dfo-dps-report.html' ? 'graph.html' : values.out);
    writePage(out, html);
    if (!values.json) console.log(`graph written: ${out}`);
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
      const statArgs = Array.isArray(values.stat) ? values.stat : [values.stat];
      if (statArgs.length > 1) throw new UsageError('scale accepts one --stat per run; run it once per stat');
      const k = String(statArgs[0]).toLowerCase();
      if (!['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck'].includes(k)) throw new UsageError(`unknown stat ${k}`);
      rows.push(...one(`stat ${k}`, 'stat', k, liveStat(ch, k), 100));
    } else if (values.skill) {
      const id = n(values.skill, -1);
      if (!(id >= 0 && id < 35)) throw new UsageError('--skill expects a skill id 0..34');
      rows.push(...one(`skill ${id}`, 'skill', id, ch.skills?.[id] ?? 0, 200));
    } else if (values['gear-skill']) {
      const id = n(values['gear-skill'], -1);
      if (!(id >= 0 && id < 35)) throw new UsageError('--gear-skill expects a skill id 0..34');
      const cur = ch._mods?.skills?.[id] ?? 0;
      rows.push(...one(`gear skill ${id}`, 'gear', id, cur, cur + 100));
    } else {
      throw new UsageError('scale needs --stat <name>, --skill <id>, --gear-skill <id>, or --all');
    }
    textOut(values, `${characterLabel(ch)}  |  target ${values.target}  |  ${values.core}${ch.online ? ' / online' : ' / offline'}`);
    if (!values.json) printScale(rows, values);
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
    textOut(values, `${characterLabel(ch)}  |  ${values.core}${ch.online ? ' / online' : ' / offline'}  |  real pools`);
    textOut(values, table(out.map((x) => [x.label, x.hp.toLocaleString(), x.cap || '-', fmt(x.perHit), x.headroom ? `${fmt(x.headroom)}x` : '-', fmt(x.speed), fmt(x.dmg), x.verdict]), ['Boss', 'HP', 'Cap', 'Per hit', 'Headroom', '+5% speed', '+5% dmg', 'Verdict'], ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'left']));
    textOut(values, '\n+5% speed and +5% damage are separate one-change DPS runs against each pool.');
    textOut(values, 'Headroom = cap / expected landed hit. Above 1x, damage can grow that many times before the cap makes speed strictly better; at or below 1x, speed is already better.');
    for (const [label, t] of [['Breach', gate], ['Curbing 1,000 HP', targets[1].t]]) {
      const rows = rankWeapons(ch, { ...scenarioOf(ch, values, traits, t), target: t, health: t.maxHealth, traits: t.bossTraits ?? [] }, { top: 5 });
      textOut(values, `\nTop weapons - ${label}`);
      textOut(values, table(rows.map((x) => [`${x.materialName} ${x.name}`, x.twoHanded ? '2H' : '1H', fmt(x.cappedDps), fmt(x.perSwing), fmt2(x.aps)]), ['Weapon', 'Hands', 'Capped DPS', 'Per swing', 'APS'], ['left', 'left', 'right', 'right', 'right']));
    }
    const crossover = [];
    for (const hp of [500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8400, 12000]) {
      const t = bossTarget({ level: ch.level, health: hp, traits: ['curbing'] });
      const sc = { ...scenarioOf(ch, values, traits, t), target: t, health: hp, traits: ['curbing'] };
      const best = rankWeapons(ch, sc, { top: 1 })[0];
      const a = analyze(ch, sc);
      crossover.push({ hp, cap: a.cap, best: best ? `${best.materialName} ${best.name}` : '-', dps: best?.cappedDps ?? 0, perHit: best?.perHit ?? 0 });
    }
    textOut(values, '\nBest weapon by Curbing boss health (the speed/damage crossover)');
    textOut(values, table(crossover.map((x) => [x.hp.toLocaleString(), x.cap, x.best, fmt(x.dps), fmt(x.perHit)]), ['Boss HP', 'Cap', 'Best weapon', 'Capped DPS', 'Best landed hit'], ['right', 'right', 'left', 'right', 'right']));
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
      unaware: scenario.unaware, firstBlow: scenario.firstBlow, healthShare: scenario.healthShare, attackerHealthShare: scenario.attackerHealthShare,
      backstabUptime: scenario.backstabUptime, players: n(values.players, 1), blowX: n(values['blow-x'], 1),
      rri: !values['no-rri'], pair: values.pair, bowSpam: values.spam, potencyPct: n(values.potency, 0), pierce: n(values.pierce, 0), weapon: scenario.weapon,
      gameBuild: scenario.gameBuild,
    });
    const out = path.resolve(values.out);
    writePage(out, html);
    console.log(`report written: ${out}`);
    return;
  }

  if (cmd === 'compare') {
    const statList = Array.isArray(values.stat) ? values.stat : values.stat ? [values.stat] : [];
    const changes = statList.map((s) => {
      const m = /^([a-z]+|\d+)=(-?\d+)$/i.exec(s);
      if (!m) throw new UsageError(`--stat expects name=value, got ${s}`);
      return { name: m[1].toLowerCase(), value: Number(m[2]) };
    });
    if (!changes.length && !values.weapon) throw new UsageError('compare needs --stat name=value and/or --weapon template:material');
    const c2 = JSON.parse(JSON.stringify(ch));
    for (const c of changes) {
      if (c.name in c2.stats) c2.stats[c.name] = c.value;
      else if (/^\d+$/.test(c.name)) c2.skills[Number(c.name)] = c.value;
      else throw new UsageError(`unknown stat "${c.name}" (use strength, agility, speed, luck, endurance, willpower, intelligence, personality, or a skill id)`);
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
