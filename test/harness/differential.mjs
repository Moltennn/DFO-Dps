/*
 * test/harness/differential.mjs - compare one calculation stage of this
 * project with the same stage of the pinned game implementation.
 *
 * A "stage" is a pure function of one input. Each case supplies the input and
 * the two answers are compared:
 *
 *   exact   - deterministic arithmetic: identical, bit for bit
 *   close   - floating point through different orders: within a tolerance
 *   sampled - a stochastic result (dice): windows checked against a seeded
 *             Monte Carlo mean with a 95% confidence interval
 *
 * A case may declare `waived: '<id>'` when the audit has already established a
 * known discrepancy. A waived case MUST diverge: if it starts agreeing, the
 * waiver is stale and the test fails, so a fix can never hide behind it.
 */

import { summarize } from './prng.mjs';
import { assertFinite } from './upstream.mjs';

/**
 * A comparison result is only meaningful if both sides produced real numbers.
 * A stub that leaked into a measured path answers NaN, and `NaN === NaN` would
 * otherwise pass silently, so every stage result is screened first.
 */
function screen(label, value) {
  try {
    return assertFinite(label, value);
  } catch (e) {
    return { __screened: e.message };
  }
}

/** The first place two JSON-like values differ, for a readable failure. */
export function firstDifference(a, b, at = '') {
  if (Object.is(a, b)) return null;
  if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
    return { at: at || '(value)', expected: b, actual: a, delta: a - b };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      const d = firstDifference(a[k], b[k], at ? `${at}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  return { at: at || '(value)', expected: b, actual: a, delta: undefined };
}

const fmt = (v) => {
  if (v && typeof v === 'object' && '__screened' in v) return `[screen] ${v.__screened}`;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(6);
  return JSON.stringify(v);
};

/** A case's name for a message (its id, else its label, else the input). */
const names = (c) => c.id ?? c.label ?? JSON.stringify(c.input);

/** One comparison. `expected` is upstream (the oracle), `actual` is this project. */
export function compareCase({ expected, actual, tolerance = 0, scale = 1 }) {
  if (tolerance === 0) {
    const d = firstDifference(actual, expected);
    return d ? { ok: false, diff: d } : { ok: true };
  }
  const walk = (a, b, at) => {
    if (typeof a === 'number' && typeof b === 'number') {
      const allowed = tolerance * Math.max(1, Math.abs(scale === 1 ? b : scale));
      return Math.abs(a - b) <= allowed ? null : { at: at || '(value)', expected: b, actual: a, delta: a - b };
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return { at: `${at}.length`, expected: b.length, actual: a.length };
      for (let i = 0; i < a.length; i++) {
        const d = walk(a[i], b[i], `${at}[${i}]`);
        if (d) return d;
      }
      return null;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const d = walk(a[k], b[k], at ? `${at}.${k}` : k);
        if (d) return d;
      }
      return null;
    }
    return Object.is(a, b) ? null : { at: at || '(value)', expected: b, actual: a };
  };
  const d = walk(actual, expected, '');
  return d ? { ok: false, diff: d } : { ok: true };
}

/**
 * Run a stage: for every case, compute upstream's answer and this project's and
 * compare. Returns a report; `stage()` below turns it into a node:test body.
 */
export async function runStage({ name, cases, upstream: oracle, simulator: sim, mode = 'exact', tolerance = 1e-12, scale = 1, waivers = {} }) {
  const failures = [];
  const staleWaivers = [];
  const waived = [];

  for (const c of cases) {
    const expected = screen(`upstream ${names(c)}`, await oracle(c.input, c));
    const actual = screen(`simulator ${names(c)}`, await sim(c.input, c));
    const r = compareCase({ expected, actual, tolerance: mode === 'exact' ? 0 : tolerance, scale });

    if (c.waived) {
      const w = waivers[c.waived];
      if (!w) throw new Error(`case ${c.label ?? c.id} waives ${c.waived}, which is not in the waiver table`);
      if (r.ok) staleWaivers.push({ id: c.waived, label: c.label ?? c.id, input: c.input });
      else waived.push({ id: c.waived, label: c.label ?? c.id });
      continue;
    }
    if (!r.ok) failures.push({ label: c.label ?? c.id, input: c.input, ...r.diff });
  }

  return { name, cases: cases.length, failures, staleWaivers, waived };
}

/** A readable discrepancy report: input, expected (upstream), actual, divergence point. */
export function formatReport(report) {
  const lines = [];
  for (const f of report.failures) {
    lines.push(`✗ ${report.name}: ${f.label}`);
    lines.push(`    input:     ${JSON.stringify(f.input)}`);
    lines.push(`    upstream:  ${fmt(f.expected)}   <- expected`);
    lines.push(`    simulator: ${fmt(f.actual)}   <- actual`);
    lines.push(`    diverged at: ${f.at}${f.delta !== undefined ? `  (delta ${fmt(f.delta)})` : ''}`);
  }
  for (const s of report.staleWaivers) {
    lines.push(`✗ ${report.name}: stale waiver ${s.id} on "${s.label}" - the two now agree, so the waiver must be removed`);
  }
  return lines.join('\n');
}

/** Assert a report is clean, or throw with the full discrepancy listing. */
export function expectClean(assert, report) {
  if (report.failures.length || report.staleWaivers.length) {
    assert.fail(`\n${formatReport(report)}\n\n${report.failures.length} failing, ${report.staleWaivers.length} stale waiver(s) of ${report.cases} case(s).`);
  }
}

/**
 * A sampled comparison: upstream's stochastic result against this project's
 * expectation. `samples` upstream draws are summarized; the expectation must
 * fall inside the mean's 95% confidence interval (widened by `tolerance`).
 */
export function compareSample({ expected, actual, tolerance = 0, label = '' }) {
  const s = summarize(expected);
  const allowed = s.ci95 + tolerance * Math.max(1, Math.abs(s.mean));
  const ok = Math.abs(actual - s.mean) <= allowed;
  return {
    ok,
    summary: s,
    detail: ok
      ? null
      : {
          at: label || 'mean',
          expected: s.mean,
          actual,
          delta: actual - s.mean,
          ci95: s.ci95,
        },
  };
}
