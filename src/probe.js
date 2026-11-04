/*
 * dfo-dps - read a Combat Probe capture.
 *
 * The probe records the boss bar at 10 Hz (read-only, no game code changed).
 * This module splits the samples into fights, derives the landed DPS, the
 * opening burst, the no-damage gaps (immunity) and the split halves, and
 * compares the fight-end damage chart with the health-derived total.
 *
 * The chart is deliberately not the source of truth: `dealt` also counts
 * phase-shield damage and adds, and the chart is built at `fell`.
 */
import { bossRef, encounterById, purseOf } from './encounters.js';

const isNum = (v) => Number.isFinite(Number(v));

/** Content from the boss itself, so a capture with a stale label still reads right. */
export function bossContent(name = '', sub = '') {
  const s = `${name} ${sub}`.toLowerCase();
  if (/ketch|tonal|steersman/.test(s)) return 'skyketch';
  if (/abyss|brass|remnant|clock/.test(s)) return 'abyss';
  if (/valkynaz|ruhn|burning|rime|dagon|breach|court|champion|warden/.test(s)) return 'breach';
  return null;
}
const hpOf = (s) => (s?.boss && isNum(s.boss.hp) ? Number(s.boss.hp) : null);

/** Split samples at a gap, a name change or a health refill. */
export function splitFights(samples = [], { gapMs = 5000, minSeconds = 1 } = {}) {
  const rows = samples.filter((s) => hpOf(s) != null);
  const fights = [];
  let cur = [];
  for (const s of rows) {
    const prev = cur.at(-1);
    if (prev) {
      const nameChange = (s.boss.name ?? '') !== (prev.boss.name ?? '');
      const refill = hpOf(s) > hpOf(prev) + 5;
      if (s.t - prev.t > gapMs || nameChange || refill) {
        fights.push(cur);
        cur = [];
      }
    }
    cur.push(s);
  }
  if (cur.length) fights.push(cur);
  return fights.filter((f) => f.length > 2 && (f.at(-1).t - f[0].t) / 1000 >= minSeconds);
}

/** The capture's damage figures for one fight. */
export function fightSummary(samples, { content = 'unknown', level = 45, players = 1, levels = [], gate = null, chartKill = false, outcome = null, playerEnd = null } = {}) {
  const first = samples[0];
  const last = samples.at(-1);
  const seconds = Math.max(1e-9, (last.t - first.t) / 1000);
  const boss = encounterById(content);
  const g = gate ?? samples.map((s) => s.gate).filter(Boolean).at(-1) ?? null;
  const gateMax = Number(g?.max) > 0 ? Number(g.max) : null;
  const gatePlayers = Number(g?.fighters) > 0 ? Number(g.fighters) : null;
  const gateHp = Number.isFinite(Number(g?.hp)) ? Number(g.hp) : null;
  const known = levels.filter((v) => Number.isFinite(v) && v >= 1 && v <= 60);
  const count = Math.max(1, gatePlayers ?? players, known.length);
  const sorted = known.slice().sort((a, b) => a - b);
  const fill = sorted.length ? sorted[Math.floor(sorted.length / 2)] : level;
  const lvList = [...known, ...Array(Math.max(0, count - known.length)).fill(fill)];
  const maxHpEstimated = !gateMax && count > 1 && count > known.length;
  const maxHp = gateMax ?? (boss ? lvList.reduce((a, l) => a + boss.shareX * bossRef(l) * (boss.hpX ?? 1), 0) : null);
  const lastHp = samples.map(hpOf).filter((v) => v != null).at(-1);
  const kill = outcome === 'kill' || chartKill || (g ? !!(g.fell || Number(g.hp) <= 0) : lastHp != null && lastHp <= 0.01);
  const firstGate = samples.map((s) => s.gate).filter(Boolean)[0] ?? null;
  const gateM0 = Number(firstGate?.max) > 0 ? Number(firstGate.max) : null;
  const gateH0 = Number.isFinite(Number(firstGate?.hp)) ? Number(firstGate.hp) : null;
  const midFight = gateM0 != null && gateH0 != null && gateH0 < gateM0 * 0.95;
  const barLost = hpOf(first) != null && hpOf(last) != null ? Math.max(0, hpOf(first) - hpOf(last)) : null;
  const damage = kill && gateMax != null ? gateMax : gateMax != null && gateHp != null ? Math.max(0, gateMax - gateHp) : barLost != null && maxHp != null ? (barLost / 100) * maxHp : null;
  const hpLost = kill ? 100 : gateMax != null && damage != null ? (damage / gateMax) * 100 : barLost;
  const dps = damage != null ? damage / seconds : null;
  const preJoinDamage = midFight ? Math.max(0, gateM0 - gateH0) : 0;
  const damageSinceJoin = damage != null ? Math.max(0, damage - preJoinDamage) : null;
  const dpsSinceJoin = damageSinceJoin != null ? damageSinceJoin / seconds : null;
  const joinedAtPct = midFight ? (gateH0 / gateM0) * 100 : null;

  const five = samples.find((s) => s.t >= first.t + 5000) ?? last;
  const firstHp = samples.find((s) => hpOf(s) != null);
  const burst5 = maxHp != null && firstHp && hpOf(five) != null ? (Math.max(0, hpOf(firstHp) - hpOf(five)) / 100) * maxHp : null;

  const steps = [];
  let sinceHit = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    const dh = hpOf(samples[i - 1]) - hpOf(samples[i]);
    sinceHit += dt;
    if (dh > 0.05) {
      steps.push(sinceHit);
      sinceHit = 0;
    }
  }
  const sortedSteps = steps.slice().sort((a, b) => a - b);
  const normalGap = sortedSteps.length ? sortedSteps[Math.floor(sortedSteps.length / 2)] : 0.1;
  const immunityFloor = Math.max(0.5, normalGap * 2.5);

  let gapS = 0;
  let maxStepPct = 0;
  let quiet = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    const dh = hpOf(samples[i - 1]) - hpOf(samples[i]);
    maxStepPct = Math.max(maxStepPct, dh);
    if (dh <= 0.05) {
      quiet += dt;
    } else {
      if (quiet > immunityFloor) gapS += Math.max(0, quiet - normalGap);
      quiet = 0;
    }
  }
  if (quiet > immunityFloor) gapS += Math.max(0, quiet - normalGap);
  const maxStep = maxHp != null ? (maxStepPct / 100) * maxHp : null;
  const immunityShare = Math.min(0.95, gapS / seconds);

  const halves = samples
    .filter((s) => (s.boss?.halves?.length ?? 0) > 0
      && (content === 'abyss' || s.boss.halves.some((h) => /gold|silver/i.test(h.name ?? ''))))
    .map((s) => ({ t: s.t, halves: s.boss.halves }));

  let wardedS = 0;
  const subMap = new Map();
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    const prev = samples[i - 1].boss;
    if ((prev?.halves ?? []).some((h) => Number(h.hp) > 0 && (/warded/i.test(h.state ?? '') || /warded/.test(h.cls ?? '')))) wardedS += dt;
    const name = prev?.sub || '(no sub-phase)';
    subMap.set(name, (subMap.get(name) ?? 0) + dt);
  }
  const subs = [...subMap].map(([name, seconds]) => ({ name, seconds })).sort((a, b) => b.seconds - a.seconds);

  const curve = samples.map((s) => ({ t: (s.t - first.t) / 1000, hp: hpOf(s) }));
  const dpsCurve = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    if (!(dt > 0)) continue;
    const dh = Math.max(0, hpOf(samples[i - 1]) - hpOf(samples[i]));
    const value = maxHp != null ? (dh / 100) * maxHp / dt : (dh / dt) * 1000;
    dpsCurve.push({ x: (samples[i].t - first.t) / 1000, y: value });
  }

  return {
    content,
    name: samples.find((s) => s.boss)?.boss?.name ?? '',
    sub: samples.find((s) => s.boss)?.boss?.sub ?? '',
    level,
    players: lvList.length,
    levels: known,
    levelFill: fill,
    maxHpEstimated,
    gate: g ? { max: gateMax, hp: gateHp, fighters: gatePlayers, phase: g.phase ?? null } : null,
    outcome: kill ? 'kill' : gateOutcome(g, samples),
    weapon: playerEnd?.weapon?.name ?? null,
    offWeapon: playerEnd?.offWeapon?.name ?? null,
    imprint: playerEnd?.weapon?.imprint ?? playerEnd?.offWeapon?.imprint ?? null,
    maxHp,
    seconds,
    hpLost,
    damage,
    dps,
    dpsSinceJoin,
    damageSinceJoin,
    midFight,
    preJoinDamage,
    joinedAtPct,
    burst5,
    maxStep,
    maxStepPct,
    immunityS: gapS,
    immunityShare,
    wardedS,
    subs,
    halves,
    curve,
    dpsCurve,
    chart: null,
    chartTop: null,
  };
}

/** Read a probe JSON and summarise every fight it holds. */
export function summarizeProbe(data, { level, players } = {}) {
  if (!data || data.version !== 1) throw new Error('not a Combat Probe capture (version 1)');
  const lv = isNum(level) ? Number(level) : Number(data.level) || 45;
  const levels = Array.isArray(data.levels) ? data.levels.map(Number).filter((v) => Number.isFinite(v) && v >= 1 && v <= 60) : [];
  const pl = isNum(players) ? Number(players) : Number(data.players) || levels.length || 1;
  const samples = Array.isArray(data.samples) ? data.samples : [];
  const chartText = `${data.chart?.sub ?? ''} ${data.chart?.title ?? ''} ${data.chart?.text ?? ''}`.toLowerCase();
  const chartKill = /has fallen|fallen -/.test(chartText);
  const fights = splitFights(samples).map((f) => {
    const content = bossContent(f[0].boss?.name, f[0].boss?.sub)
      ?? (data.content && data.content !== 'auto' ? data.content : (f[0].boss?.content ?? 'unknown'));
    const fg = data.gate ?? f.map((s) => s.gate).filter(Boolean).at(-1) ?? null;
    const out = fightSummary(f, { content, level: lv, players: pl, levels, gate: fg, chartKill, outcome: data.outcome, playerEnd: data.playerEnd ?? data.playerStart ?? null });
    out.chart = data.chart ?? null;
    out.chartTop = chartTop(data.chart);
    return out;
  });
  return { build: data.build ?? '', startedAt: data.startedAt ?? 0, endedAt: data.endedAt ?? 0, level: lv, players: pl || levels.length || 1, fights };
}

/** The capture's own damage chart, summed per player. */
export function chartTotals(chart) {
  if (!chart?.rows) return null;
  const names = [];
  for (const row of chart.rows) {
    if (/wb-dmg-name/.test(row.cls)) names.push(row.text);
  }
  return { names, text: chart.text ?? '' };
}

/** The top-10 chart rows: damage, share, blows, best, crystals, falls, healed. */
export function gateOutcome(gate, samples = []) {
  if (gate) return gate.fell || Number(gate.hp) <= 0 ? 'kill' : 'ended';
  const last = samples.map(hpOf).filter((v) => v != null).at(-1);
  return last != null && last <= 0.01 ? 'kill' : 'ended';
}

export function chartTop(chart) {
  const num = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  let rows = chart?.table;
  if (!Array.isArray(rows) || !rows.some((r) => r.damage != null || r.best != null)) {
    const flat = [];
    let cur = null;
    for (const r of chart?.rows ?? []) {
      if (/wb-dmg-row/.test(r.cls)) {
        if (/wb-dmg-head/.test(r.cls)) { cur = null; continue; }
        cur = {};
        flat.push(cur);
        continue;
      }
      if (!cur) continue;
      const cls = String(r.cls).split(/\s+/)[0];
      if (['wb-dmg-rank', 'wb-dmg-name', 'wb-dmg-lv', 'wb-dmg-damage', 'wb-dmg-share', 'wb-dmg-blows', 'wb-dmg-best', 'wb-dmg-cx', 'wb-dmg-falls', 'wb-dmg-heal'].includes(cls)) cur[cls] = r.text;
    }
    rows = flat.filter((r) => r['wb-dmg-name']).map((r) => ({
      name: r['wb-dmg-name'],
      level: r['wb-dmg-lv'],
      damage: r['wb-dmg-damage'],
      share: r['wb-dmg-share'],
      blows: r['wb-dmg-blows'],
      best: r['wb-dmg-best'],
      crystals: r['wb-dmg-cx'],
      falls: r['wb-dmg-falls'],
      healed: r['wb-dmg-heal'],
    }));
  }
  if (!Array.isArray(rows)) return null;
  return rows.map((r) => ({
    name: r.name,
    level: Number((String(r.level ?? '').match(/\d+/) ?? [])[0]) || null,
    damage: num(r.damage),
    share: r.share ?? '',
    blows: num(r.blows),
    best: num(r.best),
    crystals: num(r.crystals ?? r.nums?.[4]),
    falls: num(r.falls ?? r.nums?.[5]),
    healed: num(r.healed ?? r.nums?.[6]),
  })).filter((r) => r.name);
}

export const probeConstants = (level) => purseOf(level);
