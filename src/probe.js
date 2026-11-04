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
export function fightSummary(samples, { content = 'unknown', level = 45, players = 1 } = {}) {
  const first = samples[0];
  const last = samples.at(-1);
  const seconds = Math.max(1e-9, (last.t - first.t) / 1000);
  const boss = encounterById(content);
  const maxHp = boss ? boss.shareX * bossRef(level) * (boss.hpX ?? 1) * players : null;
  const hpLost = Math.max(0, hpOf(first) - hpOf(last));
  const damage = maxHp != null ? (hpLost / 100) * maxHp : null;
  const dps = damage != null ? damage / seconds : null;

  const five = samples.find((s) => s.t >= first.t + 5000) ?? last;
  const burst5 = maxHp != null ? (Math.max(0, hpOf(first) - hpOf(five)) / 100) * maxHp : null;

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
    .filter((s) => (s.boss?.halves?.length ?? 0) > 0)
    .map((s) => ({ t: s.t, halves: s.boss.halves }));

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
    name: first.boss.name ?? '',
    sub: first.boss.sub ?? '',
    level,
    players,
    maxHp,
    seconds,
    hpLost,
    damage,
    dps,
    burst5,
    maxStep,
    maxStepPct,
    immunityS: gapS,
    immunityShare,
    halves,
    curve,
    dpsCurve,
    chart: null,
  };
}

/** Read a probe JSON and summarise every fight it holds. */
export function summarizeProbe(data, { level, players } = {}) {
  if (!data || data.version !== 1) throw new Error('not a Combat Probe capture (version 1)');
  const lv = isNum(level) ? Number(level) : Number(data.level) || 45;
  const pl = isNum(players) ? Number(players) : Number(data.players) || 1;
  const samples = Array.isArray(data.samples) ? data.samples : [];
  const fights = splitFights(samples).map((f) => {
    const content = data.content && data.content !== 'auto' ? data.content : (f[0].boss?.content ?? 'unknown');
    const out = fightSummary(f, { content, level: lv, players: pl });
    out.chart = data.chart ?? null;
    return out;
  });
  return { build: data.build ?? '', startedAt: data.startedAt ?? 0, endedAt: data.endedAt ?? 0, level: lv, players: pl, fights };
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

export const probeConstants = (level) => purseOf(level);
