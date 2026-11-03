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
import { BOSS_TRAIT_TEXT, MARTIAL_PATHS, MATERIALS, RACE_NAMES, SOURCE, WEAPONS } from './data.js';
import { buildReport } from './report.js';
import {
  analyze, bossTarget, currentWeaponRow, marginals, rankAffixes, rankWeapons, referenceFoe,
  syntheticWeapon, weaponOf,
} from './model.js';
import {
  characterFromSave, characterLabel, listSaves, liveStat, loadSave, resolveSave,
  skillName, skillValue,
} from './save.js';

const HELP = `dfo-dps - DFO Online melee DPS and build lab

Usage:
  dfo-dps build  [options]            one build against one target (default)
  dfo-dps rank weapons [options]      rank every melee template/material
  dfo-dps report [options]            write a single-file HTML report
  dfo-dps compare [options]           baseline vs one change
  dfo-dps saves                       list saves under the DFO user data folder
  dfo-dps doctor                      show save/build/ruleset information

Common options:
  --save <SAVE4|path>                 save slot or SaveData.txt (default: newest)
  --target <soft|tough|armoured|human|boss>   reference foe (default: armoured)
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
  --first-blow                        first blow at this foe (Assassin; also First Blood / Duelist's Vambrace)
  --health-share <0..1>               foe's health share for Axe/Blunt mastery (default: 1)
  --no-crit-damage                    overhaul crit adds hit only
  --no-passive                        switch the path passive off
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
  'no-crit-damage': { type: 'boolean', default: false },
  'no-passive': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  top: { type: 'string', default: '20' },
  out: { type: 'string', default: 'dfo-dps-report.html' },
  stat: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h', default: false },
};

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
  const { entry, save } = loadSave(values.save);
  const ch = characterFromSave(save, {
    online: !values.offline,
    slot: entry.slot,
    file: entry.file,
    martialPath: values.passive !== undefined
      ? (values.passive === 'none' ? null : values.passive)
      : undefined,
  });
  return { ch, entry, save };
}

function traitsOf(values) {
  return String(values.traits ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function targetOf(ch, values, traits) {
  const level = n(values.level, ch.level);
  const target = String(values.target ?? 'armoured').toLowerCase();
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
    traits,
    health: String(values.target).toLowerCase() === 'boss' ? n(values.health, 5000) : n(values.health, 0),
    swing: values.swing,
    critDamage: !values['no-crit-damage'],
    passiveOn: !values['no-passive'],
    stacks: n(values.stacks, 5),
    rhythm: values.rhythm,
    unaware: values.unaware,
    firstBlow: values['first-blow'],
    healthShare: n(values['health-share'], 1),
    weapon: weaponOverride(values),
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
      damage: { min: r.damage.min, max: r.damage.max, avg: r.damage.avg, critMin: r.damage.critMin, critMax: r.damage.critMax, critAvg: r.damage.critAvg },
      perSwing: r.perSwing, aps: r.cadence.aps, swingSeconds: r.cadence.seconds,
      dps: r.dps, cappedDps: r.cappedDps, cap: r.cap, capLoss: r.capLoss,
      ward: r.ward, ttk: r.ttk, wrath: r.wrath,
      terms: r.damage.parts,
    },
    ...extra,
  };
}

function printBuild(ch, r, targetPreset, values) {
  const w = r.weapon;
  const traits = r.traits;
  console.log(`${characterLabel(ch)}`);
  console.log(`${w ? `${w.materialName} ${w.name}` : 'bare hands'}  |  ${r.core}${ch.online ? ' / online' : ' / offline'}${ch.martialPath ? ` / ${MARTIAL_PATHS[ch.martialPath]?.name ?? ch.martialPath}` : ''}`);
  const hasFirstBlood = (ch.legendaries ?? []).some((l) => l.id === 'duelists-vambrace');
  if (hasFirstBlood) console.log(`First Blood (Duelist's Vambrace): ${values['first-blow'] ? 'on - opening blow +60%' : 'available - opening blow +60%, sustained shown (pass --first-blow to compare the card)'}`);
  console.log(`target: ${targetPreset}${r.target.isClass ? ' (class)' : ''}, level ${r.target.level}${r.health ? `, ${r.health.toLocaleString()} HP` : ''}${traits.length ? `, traits: ${traits.join(', ')}` : ''}`);
  console.log('');
  console.log(table([
    ['Hit chance', pc(r.hit.hit), `${pc(r.hit.crit.chance)} critical, x${fmt2(r.hit.crit.damageMult)}`],
    ['Damage / hit', `${r.damage.min}-${r.damage.max}`, `avg ${fmt(r.damage.avg)}; crit ${r.damage.critMin}-${r.damage.critMax}`],
    ['Expected / swing', fmt(r.perSwing), 'hit chance and criticals included'],
    ['Swing time', `${fmt2(r.cadence.seconds)} s`, `${fmt2(r.cadence.aps)} swings/s`],
    ['DPS', fmt(r.dps), r.cap ? `capped ${fmt(r.cappedDps)} (${pc(r.capLoss)} lost)` : 'no per-hit cap'],
    ['Time to kill', r.ttk ? `${fmt(r.ttk)} s` : '-', r.ward ? `${r.health?.toLocaleString()} HP + ${r.ward} ward` : (r.health ? `${r.health.toLocaleString()} HP` : 'no boss health')],
  ], ['Metric', 'Value', 'Notes']));
  if (r.cap) console.log(`\nCurbing cap: ${r.cap} per hit (5% of ${r.health.toLocaleString()} HP).`);
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
    critDamage: !values['no-crit-damage'], weapon: undefined,
  });
  console.log(`\nWhat matters (${r.cap ? 'capped DPS' : 'DPS'})`);
  console.log(table(ms.map((m) => [m.label, `${m.delta >= 0 ? '+' : ''}${fmt(m.delta)}`, `${m.delta >= 0 ? '+' : ''}${fmt(m.pct)}%`]), ['Change', r.cap ? 'Capped DPS' : 'DPS', '%'], ['left', 'right', 'right']));
  const affixes = rankAffixes(marginalCh, r, {
    target: r.target, core: r.core, traits, health: r.health ?? 0, swing: values.swing,
    passiveOn: !values['no-passive'], stacks: n(values.stacks, 5), rhythm: values.rhythm,
    unaware: values.unaware, firstBlow: values['first-blow'], healthShare: n(values['health-share'], 1),
    critDamage: !values['no-crit-damage'],
  });
  console.log(`\nAffixes / enchants (${r.cap ? 'capped DPS' : 'DPS'})`);
  console.log(table(affixes.map((m) => [m.label, `${m.delta >= 0 ? '+' : ''}${fmt(m.delta)}`, `${m.delta >= 0 ? '+' : ''}${fmt(m.pct)}%`]), ['Change', r.cap ? 'Capped DPS' : 'DPS', '%'], ['left', 'right', 'right']));
  const ranking = rankWeapons(ch, {
    target: r.target, core: r.core, traits, health: r.health ?? 0, swing: values.swing,
    passiveOn: !values['no-passive'], stacks: n(values.stacks, 5), rhythm: values.rhythm,
    unaware: values.unaware, firstBlow: values['first-blow'], healthShare: n(values['health-share'], 1),
    critDamage: !values['no-crit-damage'],
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
      weapon: scenario.weapon,
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
  printBuild(ch, r, values.target, values);
}
