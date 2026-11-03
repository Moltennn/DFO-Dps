/*
 * dfo-dps - a single-file HTML report.
 *
 * Everything is precomputed here; the page needs no server and no network.
 * The palette follows the game's enhanced skin so it reads beside DFO.
 */
import { BOSS_TRAITS, BOSS_TRAIT_TEXT, MATERIALS, MARTIAL_PATHS, SOURCE } from './data.js';
import { characterLabel } from './save.js';
import { analyze, bossTarget, currentWeaponRow, marginals, rankAffixes, rankWeapons, referenceFoe } from './model.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n1 = (n) => (Number.isFinite(n) ? (Math.round(n * 10) / 10).toFixed(1) : '-');
const n2 = (n) => (Number.isFinite(n) ? (Math.round(n * 100) / 100).toFixed(2) : '-');
const pct = (n) => (Number.isFinite(n) ? `${Math.round(n * 100)}%` : '-');
const signed = (n) => `${n >= 0 ? '+' : ''}${n1(n)}`;

function card(label, value, sub, tone = '') {
  return `<div class="card ${tone}"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`;
}

function breakdown(r) {
  const p = r.damage.parts;
  const rows = [
    ['Weapon roll', `${p.roll[0]}-${p.roll[1]}`, 'template base, before modifiers'],
    ['Material', `${p.matMod >= 0 ? '+' : ''}${p.matMod}`, `${r.weapon?.materialName ?? ''}`],
    ['Strength', `${p.strMod >= 0 ? '+' : ''}${p.strMod}`, `${r.damage.parts.twoHanded ? 'two-handed x2' : 'one-handed'}`],
    ['Proficiency', `${p.prof >= 0 ? '+' : ''}${p.prof}`, 'career Expertise'],
    ['Race', `${p.racial >= 0 ? '+' : ''}${p.racial}`, 'racial weapon bonus'],
    ['Mastery / gear', `${n1(p.mastery)}%`, 'online skill past 100 and gear skill'],
    ['Martial passive', `${n1(p.martial)}%`, 'path passive'],
    ['Slayer affix', `${n1(p.slayer)}%`, ''],
    ['Critical Strike', `${pct(r.hit.crit.chance)} chance, x${n2(r.hit.crit.damageMult)}`, `${r.core === 'overhaul' ? 'damage multiplier' : 'hit chance only'}`],
    ['Hit chance', pct(r.hit.hit), `base ${r.hit.terms.base}, armor ${r.hit.terms.armour}, other ${r.hit.terms.other}`],
    ['Swing time', `${n2(r.cadence.seconds)} s`, `${n2(r.cadence.aps)} swings/s, tick ${n2(r.cadence.tick)}s`],
    ['Damage per hit', `${r.damage.min}-${r.damage.max} (avg ${n1(r.damage.avg)})`, `crit ${r.damage.critMin}-${r.damage.critMax}`],
    ['Expected per swing', n1(r.perSwing), 'hit chance x damage, criticals included'],
  ];
  return rows.map(([k, v, s]) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td><td class="d">${esc(s)}</td></tr>`).join('');
}

function marginalTable(rows, header = 'DPS') {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.delta)));
  return rows.map((r) => {
    const w = Math.max(1, Math.round((Math.abs(r.delta) / max) * 100));
    const cls = r.delta > 0.0001 ? 'good' : r.delta < -0.0001 ? 'bad' : 'flat';
    return `<tr><td class="k">${esc(r.label)}</td><td class="v">${signed(r.delta)}</td><td class="d">${signed(r.pct)}%</td><td class="bar"><span class="${cls}" style="width:${w}%"></span></td></tr>`;
  }).join('');
}

function weaponTable(rows, current) {
  const list = [];
  if (current) list.push({ ...current, current: true });
  list.push(...rows.map((r) => ({ ...r, current: false })));
  const best = Math.max(1, ...list.map((r) => r.cappedDps || r.dps));
  return list.map((r) => {
    const w = Math.max(2, Math.round(((r.cappedDps || r.dps) / best) * 100));
    const name = r.current ? `${r.name} (equipped)` : `${r.materialName} ${r.name}`;
    return `<tr class="${r.current ? 'on' : ''}"><td class="k">${esc(name)}</td><td>${esc(r.skill)}</td><td>${r.twoHanded ? '2H' : '1H'}</td><td class="v">${n1(r.dps)}</td><td class="v">${n1(r.cappedDps)}</td><td>${n1(r.perSwing)}</td><td>${n2(r.aps)}</td><td>${pct(r.hit)}</td><td>${pct(r.crit)}</td><td class="bar"><span class="good" style="width:${w}%"></span></td></tr>`;
  }).join('');
}

function targetTable(ch, scenario) {
  const rows = [];
  for (const id of ['soft', 'tough', 'armoured', 'human']) {
    const r = analyze(ch, { ...scenario, target: referenceFoe(ch.level, id), health: 0, traits: [] });
    rows.push({ id, r });
  }
  const hp = scenario.health || 5000;
  const b = analyze(ch, { ...scenario, target: bossTarget({ level: ch.level, armorValue: 0, health: hp, traits: scenario.traits }), health: hp });
  rows.push({ id: 'boss', r: b });
  return rows.map(({ id, r }) => {
    const label = id === 'boss' ? `Boss${scenario.traits.length ? ` (${scenario.traits.join(', ')})` : ''}` : id[0].toUpperCase() + id.slice(1);
    const armor = r.target.isClass ? '60 (class)' : String(r.target.armorValues?.[0] ?? 0);
    return `<tr><td class="k">${esc(label)}</td><td>${esc(armor)}</td><td>${pct(r.hit.hit)}</td><td class="v">${n1(r.dps)}</td><td class="v">${n1(r.cappedDps)}</td><td>${r.ttk ? `${n1(r.ttk)} s` : '-'}</td></tr>`;
  }).join('');
}

function traitTable(ch, scenario) {
  const hp = scenario.health || 5000;
  const ids = ['curbing', 'warded', 'bladeturning', 'stoneskin', 'wrathful', 'thorned'];
  return ids.map((t) => {
    const r = analyze(ch, { ...scenario, target: bossTarget({ level: ch.level, armorValue: 0, health: hp, traits: [t] }), health: hp, traits: [t] });
    return `<tr><td class="k">${esc(t)}</td><td class="v">${n1(r.dps)}</td><td class="v">${n1(r.cappedDps)}</td><td>${pct(r.capLoss)}</td><td>${r.ttk ? `${n1(r.ttk)} s` : '-'}</td><td class="d">${esc(BOSS_TRAIT_TEXT[t] ?? '')}</td></tr>`;
  }).join('');
}

function capTable(ch, scenario) {
  const levels = [500, 1000, 2500, 5000, 10000, 25000];
  return levels.map((hp) => {
    const target = bossTarget({ level: ch.level, armorValue: 0, health: hp, traits: ['curbing'] });
    const r = analyze(ch, { ...scenario, target, traits: ['curbing'], health: hp });
    return `<tr><td class="k">${hp.toLocaleString()} HP</td><td>${r.cap}</td><td class="v">${n1(r.dps)}</td><td class="v">${n1(r.cappedDps)}</td><td>${pct(r.capLoss)}</td><td>${r.ttk ? `${n1(r.ttk)} s` : '-'}</td></tr>`;
  }).join('');
}

export function buildReport(ch, {
  target, core = 'overhaul', traits = [], health = 0, swing = 'StrikeLeft',
  passiveOn = true, stacks = 5, rhythm = false, unaware = false, firstBlow = false,
  healthShare = 1, weapon = null,
} = {}) {
  const baseCh = weapon?.item ? { ...ch, weapon: weapon.item } : ch;
  const scenario = { target, core, traits, health, swing, passiveOn, stacks, rhythm, unaware, firstBlow, healthShare };
  const r = analyze(baseCh, scenario);
  const sustained = analyze(baseCh, { ...scenario, firstBlow: false });
  const opening = (ch.legendaries ?? []).some((l) => l.id === 'duelists-vambrace')
    ? analyze(baseCh, { ...scenario, firstBlow: true })
    : null;
  const w = r.weapon;
  const rs = marginals(baseCh, r, scenario);
  const affixes = rankAffixes(baseCh, r, scenario);
  const weapons = rankWeapons(baseCh, scenario, { top: 15 });
  const cur = currentWeaponRow(baseCh, scenario);
  const targetLabel = target?.isClass ? 'Human foe' : `Monster, armor ${target?.armorValues?.[0] ?? 0}`;
  const ruleset = `${core}${ch.online ? ' / online' : ' / offline'}${ch.martialPath ? ` / ${MARTIAL_PATHS[ch.martialPath]?.name ?? ch.martialPath}` : ''}`;
  const capLine = r.cap ? `Curbing cap: ${r.cap} per hit (5% of ${health.toLocaleString()} HP)` : 'No per-hit cap active';
  const affinity = target?.group ? `, ${target.group}` : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DFO DPS - ${esc(ch.name)}</title>
<style>
  :root{
    --bg:#12100e;--panel:#1b1814;--panel2:#221e19;--line:#3a3026;--line2:#4a3b2b;
    --bone:#e9e4d9;--dim:#a8a092;--brass:#c08a3e;--brass2:#e0b76a;--good:#7fae6a;--bad:#c25b4e;--flat:#6d6457;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--bone);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
  main{max-width:1120px;margin:0 auto;padding:28px 20px 60px}
  h1{font:600 26px/1.15 Georgia,serif;letter-spacing:.02em;margin:0 0 4px;color:var(--brass2)}
  h2{font:600 17px/1.2 Georgia,serif;color:var(--brass2);margin:34px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
  .sub{color:var(--dim);margin:0 0 22px}
  .rules{color:var(--dim);font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;min-height:82px}
  .card .k{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
  .card .v{font:600 24px/1.15 var(--mono);color:var(--bone);margin-top:4px}
  .card .s{color:var(--dim);font-size:12px;margin-top:3px}
  .card.good .v{color:var(--good)} .card.bad .v{color:var(--bad)} .card.brass .v{color:var(--brass2)}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
  th{color:var(--dim);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
  td.k{color:var(--bone);white-space:nowrap}
  td.v{font-family:var(--mono);color:var(--brass2);white-space:nowrap}
  td.d{color:var(--dim)}
  tr.on td{background:rgba(192,138,62,.09)}
  td.bar{width:26%;min-width:90px}
  .bar span{display:block;height:8px;border-radius:3px;background:var(--brass)}
  .bar span.good{background:var(--good)} .bar span.bad{background:var(--bad)} .bar span.flat{background:var(--flat)}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media(max-width:780px){.cols{grid-template-columns:1fr}}
  .note{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--brass);border-radius:6px;padding:12px 14px;color:var(--dim);font-size:13px;margin:12px 0}
  .note b{color:var(--bone)}
  .tag{display:inline-block;border:1px solid var(--line2);border-radius:999px;padding:1px 8px;margin:0 4px 4px 0;font-size:12px;color:var(--dim)}
  .tag.on{border-color:var(--brass);color:var(--brass2);background:rgba(192,138,62,.1)}
  code{font-family:var(--mono);color:var(--brass2)}
  footer{margin-top:44px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
  .foot{display:flex;flex-wrap:wrap;gap:8px 18px;justify-content:space-between}
</style></head><body><main>
  <h1>DFO DPS Lab</h1>
  <p class="sub">${esc(characterLabel(ch))} &middot; ${esc(w ? `${w.materialName} ${w.name}` : 'bare hands')} &middot; ${esc(ruleset)}</p>

  <div class="grid">
    ${card('DPS', n1(r.dps), `${n1(r.perSwing)} per swing x ${n2(r.cadence.aps)}/s`, 'brass')}
    ${card('Capped DPS', n1(r.cappedDps), r.cap ? capLine : 'no cap', r.cap ? 'bad' : 'good')}
    ${card('Hit chance', pct(r.hit.hit), `${pct(r.hit.crit.chance)} critical`, '')}
    ${card('Damage / hit', `${r.damage.min}-${r.damage.max}`, `avg ${n1(r.damage.avg)}; crit ${r.damage.critMin}-${r.damage.critMax}`)}
    ${card('Swing time', `${n2(r.cadence.seconds)} s`, `${n2(r.cadence.aps)} swings/s`)}
    ${card('Time to kill', r.ttk ? `${n1(r.ttk)} s` : '-', r.health ? `${r.health.toLocaleString()} HP${r.ward ? ` + ${r.ward} ward` : ''}` : 'no boss health set')}
  </div>

  ${opening ? `<div class="note"><b>First Blood (Duelist's Vambrace):</b> the opening blow deals 60% more. Opening per swing ${n1(opening.perSwing)}; sustained per swing ${n1(sustained.perSwing)}. The live Combat Stats card's Damage and Per swing tiles show the opening value; the cards above show the ${scenario.firstBlow ? 'opening' : 'sustained'} one. Add or remove <code>--first-blow</code> to switch.</div>` : ''}
  <div class="note"><b>Target:</b> ${esc(targetLabel)}${esc(affinity)}, level ${esc(target?.level ?? '-')}.
    ${r.cap ? `<br><b>${esc(capLine)}</b> Your per-hit range is ${r.damage.min}-${r.damage.max} (crit ${r.damage.critMin}-${r.damage.critMax}); ${pct(r.capLoss)} of the uncapped DPS is lost to the cap.` : ''}
    ${r.ward ? `<br><b>Warded:</b> ${r.ward} points absorb the first blows; the time-to-kill includes that pool.` : ''}
    ${r.wrath ? `<br><b>Wrathful:</b> it enrages at ${r.wrathAt}s; ${r.ttk && r.ttk > r.wrathAt ? 'your kill is slower than that.' : 'your kill is before that.'}` : ''}
  </div>

  <h2>Where the damage comes from</h2>
  <table><thead><tr><th>Term</th><th>Value</th><th>What it is</th></tr></thead><tbody>${breakdown(r)}</tbody></table>

  <div class="cols">
    <section>
      <h2>What matters</h2>
      <table><thead><tr><th>Change</th><th>${r.cap ? 'Capped DPS' : 'DPS'}</th><th>%</th><th></th></tr></thead><tbody>${marginalTable(rs, r.cap ? 'Capped DPS' : 'DPS')}</tbody></table>
      <p class="note">Stats are live-capped at 100. Once a stat reads 100, more points are wasted unless a max-stat effect lifts the ceiling. Weapon skill still pays past 100 online: it adds to hit chance and, through mastery, damage or pace.</p>
    </section>
    <section>
      <h2>Affixes and enchants</h2>
  <table><thead><tr><th>Change</th><th>${r.cap ? 'Capped DPS' : 'DPS'}</th><th>%</th><th></th></tr></thead><tbody>${marginalTable(affixes, r.cap ? 'Capped DPS' : 'DPS')}</tbody></table>
  <p class="note">Affixes are the loot-rarity lines. <b>+N% damage</b> is the weapon's own roll multiplier. <b>+N weapon skill</b> is a gear skill line: it adds to hit chance and, online, to the past-100 mastery and gear damage. <b>+N Strength</b> is a stat line and is wasted once the live stat is at 100. Enchantment procs (CastWhenStrikes) are not scored in v1.</p>

  <h2>Boss cap sensitivity</h2>
      <table><thead><tr><th>Boss HP</th><th>Cap</th><th>DPS</th><th>Capped</th><th>Loss</th><th>TTK</th></tr></thead><tbody>${capTable(baseCh, scenario)}</tbody></table>
      <p class="note"><b>Curbing</b> binds only when a blow would take more than 5% of the boss's maximum health. At this build's per-hit, that starts below about ${Math.round((r.damage.max / 0.05)).toLocaleString()} HP. Above it, the cap does nothing.</p>
    </section>
  </div>

  <h2>Weapons for this build</h2>
  <table><thead><tr><th>Weapon</th><th>Skill</th><th>Hands</th><th>DPS</th><th>Capped</th><th>Per swing</th><th>APS</th><th>Hit</th><th>Crit</th><th></th></tr></thead><tbody>${weaponTable(weapons, cur)}</tbody></table>
  <p class="note">The ranking holds the character's skills, effects and gear skill affixes fixed, and gives every candidate a fresh 100% condition item. The equipped row keeps its own affixes. Materials are Iron through Daedric.</p>

  <h2>Targets</h2>
  <table><thead><tr><th>Target</th><th>Armor</th><th>Hit</th><th>DPS</th><th>Capped</th><th>TTK</th></tr></thead><tbody>${targetTable(baseCh, scenario)}</tbody></table>

  <h2>Boss traits, one at a time</h2>
  <table><thead><tr><th>Trait</th><th>DPS</th><th>Capped</th><th>Loss</th><th>TTK</th><th>Effect</th></tr></thead><tbody>${traitTable(baseCh, scenario)}</tbody></table>
  <p class="note">These rows use the same ${ (scenario.health || 5000).toLocaleString() } HP boss and the equipped weapon, with only the named trait active. Curbing binds when a blow would take more than 5% of that pool; Bladeturning/Stoneskin depend on the weapon class; Warded adds a 30% pool; Wrathful changes the boss's damage, not yours.</p>

  <h2>Boss traits</h2>
  <div>${BOSS_TRAITS.map((t) => `<span class="tag ${traits.includes(t) ? 'on' : ''}">${esc(t)}</span> `).join('')}</div>
  <table><thead><tr><th>Trait</th><th>Effect</th></tr></thead><tbody>${traits.map((t) => `<tr><td class="k">${esc(t)}</td><td class="d">${esc(BOSS_TRAIT_TEXT[t] ?? '')}</td></tr>`).join('') || '<tr><td class="d" colspan="2">No traits selected.</td></tr>'}</tbody></table>

  <h2>Ruleset</h2>
  <table><tbody>
    <tr><td class="k">Combat core</td><td class="d">${esc(core === 'overhaul' ? 'Physical Combat And Armor Overhaul v1.44 (default)' : 'Classic DFO / Daggerfall Unity FormulaHelper')}</td></tr>
    <tr><td class="k">Online rules</td><td class="d">${ch.online ? 'on - past-100 weapon mastery, gear skill affixes' : 'off - past-100 skills read as 100'}</td></tr>
    <tr><td class="k">Weapon condition</td><td class="d">${pct(r.notes.condition)}${r.notes.condition < 1 ? ' - the overhaul\'s condition multiplier is applied' : ''}</td></tr>
    <tr><td class="k">Martial path</td><td class="d">${esc(ch.martialPath ? `${MARTIAL_PATHS[ch.martialPath]?.name ?? ch.martialPath} - ${MARTIAL_PATHS[ch.martialPath]?.passive ?? ''}` : 'none')}</td></tr>
    <tr><td class="k">Mentor</td><td class="d">off (solo build planning)</td></tr>
    <tr><td class="k">Armor</td><td class="d">damage is shown before the foe's worn/natural armor reduction; the game's Combat Stats card does the same</td></tr>
  </tbody></table>

  <footer><div class="foot"><span>dfo-dps - model from ${esc(SOURCE.repo)} @ ${esc(SOURCE.commit.slice(0, 7))} (${esc(SOURCE.date)}) · live check ${esc(SOURCE.verified)}</span><span>not affiliated with Bethesda Softworks or ZeniMax Media</span></div></footer>
</main></body></html>`;
  return html;
}
