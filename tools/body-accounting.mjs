#!/usr/bin/env node
/*
 * tools/body-accounting.mjs - the field-level accounting of the 43 classic monster rows (Stage 2.8).
 *
 * For every monster 0-42 it prints, as Markdown:
 *   - the shipped row, the Meaner Monsters + overhaul row (what the pre-2.8 harness minted) and the
 *     row the client's boot mints from (Enemy Expansion with MUDEX: src/target.js mintRow), for the
 *     fields a body reads - level, armorValue, minMetalToHit, affinity;
 *   - the other fields the boot changes, which no target body reads;
 *   - the hit chance and expected damage per swing of three attackers against the pre-2.8 body
 *     (level 0, the shipped row's armour), against the shipped row at its own level, and against the
 *     minted body - so a difference only a mid-level attacker sees is visible.
 *
 * The minted bodies are checked equal to upstream's own (test/targetBody.test.js); the per-swing
 * numbers are this project's model on those bodies (src/model.js analyze).
 *
 *   node tools/body-accounting.mjs > /tmp/body-accounting.md
 */
import { analyze, weaponOf } from '../src/model.js';
import { enemyRowOf, enemyTarget, mintRow } from '../src/target.js';
import { character, simCharacter, weapon } from '../test/harness/fixtures.mjs';

const BODY = ['level', 'armorValue', 'minMetalToHit', 'affinity'];
const SHIPPED = { pcaao: false, meanerMonsters: false, enemyExpansion: false };
const MEANER = { pcaao: true, meanerMonsters: true, enemyExpansion: false };
const ATTACKERS = [
  { id: 'weak', label: 'L10, skill 40, AGI 45', level: 10, skill: 40, agility: 45, strength: 60, speed: 60 },
  { id: 'mid', label: 'L20, skill 60, AGI 55', level: 20, skill: 60, agility: 55, strength: 60, speed: 60 },
  { id: 'max', label: 'L45, skill 140, AGI 90', level: 45, skill: 140, agility: 90, strength: 90, speed: 90 },
];
const item = weapon(121, { material: 6 });

/** The pre-2.8 enemyTarget(m): level Number(null) = 0, skills 35, the shipped row's armour. */
function preStage(m) {
  const t = enemyTarget(m, { boot: SHIPPED });
  return { ...t, level: 0, combatLevel: 0, skills: Object.fromEntries(Array.from({ length: 35 }, (_, i) => [i, 35])) };
}
function swing(a, target) {
  const desc = character({ level: a.level, raceId: 1, stats: { strength: a.strength, agility: a.agility, speed: a.speed, luck: 50 }, skills: 0, skillOverride: { 29: a.skill, 34: 20 } });
  const r = analyze(simCharacter(desc, item), { target, core: 'overhaul', weapon: weaponOf(item) });
  return { hit: r.hit.hit, per: r.perSwing };
}
const f = (v) => (v === undefined ? '-' : String(v));
const pct = (a, b) => (b > 0 ? `${a >= b ? '+' : ''}${((a / b - 1) * 100).toFixed(1)}%` : '-');

const rows = [];
const fieldTally = new Map();
for (let m = 0; m <= 42; m++) {
  const raw = enemyRowOf(m);
  const meaner = mintRow(m, { boot: MEANER });
  const minted = mintRow(m);
  const other = Object.keys({ ...raw, ...minted }).filter((k) => !BODY.includes(k) && JSON.stringify(raw[k]) !== JSON.stringify(minted[k]));
  for (const k of Object.keys({ ...raw, ...minted })) if (JSON.stringify(raw[k]) !== JSON.stringify(minted[k])) fieldTally.set(k, (fieldTally.get(k) ?? 0) + 1);
  const bodyFields = BODY.filter((k) => JSON.stringify(raw[k]) !== JSON.stringify(minted[k]));
  let effect = { };
  if (Number.isInteger(minted.level)) {
    for (const a of ATTACKERS) {
      effect[a.id] = { pre: swing(a, preStage(m)), shipped: swing(a, enemyTarget(m, { boot: SHIPPED })), minted: swing(a, enemyTarget(m)) };
    }
  }
  rows.push({ m, raw, meaner, minted, other, bodyFields, effect });
}

const out = [];
out.push('| Mobile | Affinity | Shipped L / AV / metal | Meaner Monsters L / AV | Minted (boot) L / AV / metal | Body fields the boot changes | Other fields the boot changes (no body reads them) |');
out.push('|---|---|---|---|---|---|---|');
for (const r of rows) {
  out.push(`| ${r.m} | ${f(r.raw.affinity)} | ${f(r.raw.level)} / ${f(r.raw.armorValue)} / ${f(r.raw.minMetalToHit)} | ${f(r.meaner.level)} / ${f(r.meaner.armorValue)} | ${f(r.minted.level)} / ${f(r.minted.armorValue)} / ${f(r.minted.minMetalToHit)} | ${r.bodyFields.join(', ') || 'none'} | ${r.other.join(', ') || 'none'} |`);
}
out.push('');
out.push('| Mobile | ' + ATTACKERS.map((a) => `${a.label}: hit pre-2.8 / shipped / minted | per swing pre-2.8 / shipped / minted (minted vs pre-2.8)`).join(' | ') + ' |');
out.push('|---|' + ATTACKERS.map(() => '---|---').join('|') + '|');
for (const r of rows) {
  if (!r.effect.mid) { out.push(`| ${r.m} | ` + ATTACKERS.map(() => 'no body (no row level) | -').join(' | ') + ' |'); continue; }
  out.push(`| ${r.m} | ` + ATTACKERS.map((a) => {
    const e = r.effect[a.id];
    return `${e.pre.hit.toFixed(3)} / ${e.shipped.hit.toFixed(3)} / ${e.minted.hit.toFixed(3)} | ${e.pre.per.toFixed(2)} / ${e.shipped.per.toFixed(2)} / ${e.minted.per.toFixed(2)} (${pct(e.minted.per, e.pre.per)})`;
  }).join(' | ') + ' |');
}
out.push('');
out.push(`Fields the boot changes, by row count: ${[...fieldTally].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
const n = (pred) => rows.filter(pred).length;
out.push(`Rows whose body fields differ from the shipped row: level ${n((r) => r.bodyFields.includes('level'))}, armorValue ${n((r) => r.bodyFields.includes('armorValue'))}, minMetalToHit ${n((r) => r.bodyFields.includes('minMetalToHit'))}, affinity ${n((r) => r.bodyFields.includes('affinity'))}; any ${n((r) => r.bodyFields.length > 0)}; none ${n((r) => r.bodyFields.length === 0)}.`);
for (const a of ATTACKERS) {
  const moved = rows.filter((r) => r.effect[a.id] && Math.abs(r.effect[a.id].minted.per - r.effect[a.id].shipped.per) > 1e-9);
  const hitMoved = rows.filter((r) => r.effect[a.id] && Math.abs(r.effect[a.id].minted.hit - r.effect[a.id].shipped.hit) > 1e-9);
  const vsPre = rows.filter((r) => r.effect[a.id] && Math.abs(r.effect[a.id].minted.per - r.effect[a.id].pre.per) > 1e-9);
  out.push(`${a.label}: the shipped-vs-minted row moves the hit chance on ${hitMoved.length} rows and the damage per swing on ${moved.length}; the pre-2.8 body differs from the minted one on ${vsPre.length} rows.`);
}
console.log(out.join('\n'));
