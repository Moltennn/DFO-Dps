/*
 * dfo-dps - explicit ranking objectives.
 *
 * Every DPS-like number this project reports means something different, and ranking builds by the wrong one is a
 * correctness error, not a preference:
 *
 *   snapshot       the blow at FULL foe health, uncapped (`analyze(...).dps`): the card's rate, before any fight.
 *   fight          the whole-fight kill rate over the declared pool (`fight`), health-dependent terms walked.
 *   relay          the kill rate with the relay's allowance applied to every claim (`fightRelay`): the boss's pace,
 *                  not the build's once the build saturates.
 *   relay-ceiling  the per-hit-capped offered rate before the relay (`fightRelay().ceilingDps`): NOT an outcome - the
 *                  ceiling a saturated build would reach if the relay lifted its refill - the number that tells two
 *                  builds apart when `relay` ties them.
 *
 * Stage 3.8 adds three SAMPLED objectives beside those four (none of the four changes): `stochastic-ttk` and
 * `stochastic-relay` (kill rate = pool / mean TTK of the killing trials, 1,000+ seeds) and `kill-probability` (the
 * Wilson share that kills inside the horizon). A sampled row carries its metric, n, horizon and a 95% interval;
 * sampled rankings pair the builds on the same seeds and flag a row not separated from the one above it.
 *
 * Nothing here switches objective implicitly: a caller names one, and every row says which one produced it and against
 * what target. `rankBuilds` refuses to mix target conditions or sampled trial tables.
 */
import { analyze } from './model.js';
import { fight, fightRelay } from './fight.js';
import { simulateFights } from './simulateFight.js';
import { simulateRelayFights } from './relayFight.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * Below this many both-kill pairs a paired TTK difference is reported but NOT called separated: the normal/t
 * interval is too wide to be a ranking claim. The audit's own floor for a reported mean is 1,000 trials
 *; this is only a guard against a pathological sample.
 */
const MIN_PAIRED_PAIRS = 8;

// Two-sided 95% Student t, df 1..30. At df = 999 (a 1,000-trial paired sample) this is 1.962, so the 1.96 normal
// quantile is used above the table: the difference is negligible there and material only for small n.
const T95 = Object.freeze([
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
]);
const studentT95 = (df) => (df >= 1 && df <= T95.length ? T95[df - 1] : 1.96);

/**
 * The audit's first-pass minimum (§4.12): below this a mean or a probability is not reported. Every stochastic
 * objective refuses fewer trials rather than printing a number that looks settled.
 */
export const MIN_STOCHASTIC_TRIALS = 1000;

/**
 * The sampled objectives (Stage 3.8). They are ADDITIVE: the deterministic four keep their names and numbers. A row
 * names its objective, its metric, the trial count, the horizon and a 95% interval. `stochastic-ttk` and
 * `stochastic-relay` rank by kill rate (pool / mean TTK of the killing trials), never by TTK itself, because
 * `rankBuilds` sorts descending and TTK is a minimum; the conditional mean is reported beside `killProbability` so
 * censored trials are visible instead of silently dragging the mean.
 */
const STOCHASTIC = Object.freeze({
  'stochastic-ttk': Object.freeze({
    id: 'stochastic-ttk',
    label: 'sampled whole-fight kill rate (mean TTK of the trials that kill)',
    unit: 'dps',
    metric: 'kill-rate',
    needsHealth: true,
    needsRelay: false,
    stochastic: true,
    basis: 'pool / mean sampled TTK of the killing trials (simulateFights); a trial that does not kill inside the horizon is reported by killProbability, never folded into the mean',
  }),
  'kill-probability': Object.freeze({
    id: 'kill-probability',
    label: 'sampled probability of killing inside the horizon',
    unit: 'probability',
    metric: 'kill-probability',
    needsHealth: true,
    needsRelay: false,
    stochastic: true,
    basis: 'share of sampled fights that kill inside maxSeconds, with a Wilson interval (simulateFights); the ordinary fight, not a relay body',
  }),
  'stochastic-relay': Object.freeze({
    id: 'stochastic-relay',
    label: 'sampled relay kill rate (mean TTK of the trials that kill)',
    unit: 'dps',
    metric: 'kill-rate',
    needsHealth: true,
    needsRelay: true,
    stochastic: true,
    basis: 'relay pool / mean sampled TTK of the killing trials (simulateRelayFights); censored trials are reported by killProbability, not folded into the mean',
  }),
});
export const STOCHASTIC_OBJECTIVE_IDS = Object.freeze(Object.keys(STOCHASTIC));

export const OBJECTIVES = Object.freeze({
  snapshot: Object.freeze({
    id: 'snapshot',
    label: 'full-health snapshot DPS (uncapped)',
    unit: 'dps',
    needsHealth: false,
    needsRelay: false,
    basis: 'the blow at full foe health, uncapped - the card, not a fight',
  }),
  fight: Object.freeze({
    id: 'fight',
    label: 'whole-fight kill rate (health-dependent terms walked)',
    unit: 'dps',
    needsHealth: true,
    needsRelay: false,
    basis: 'pool / ttk of the walk over the foe\'s health (src/fight.js fight)',
  }),
  relay: Object.freeze({
    id: 'relay',
    label: 'relay kill rate (the allowance applied to every claim)',
    unit: 'dps',
    needsHealth: true,
    needsRelay: true,
    basis: 'pool / allowance ttk (src/fight.js fightRelay) - saturates at the relay\'s refill',
  }),
  'relay-ceiling': Object.freeze({
    id: 'relay-ceiling',
    label: 'per-hit-capped offered DPS before the relay',
    unit: 'dps',
    needsHealth: true,
    needsRelay: true,
    basis: 'capped claims / fight seconds - a ceiling, not an outcome; the discriminator when relay ties',
  }),
  ...STOCHASTIC,
});
// The deterministic objectives: the Stage 2.12 four, unchanged. The sampled ones have their own list.
export const OBJECTIVE_IDS = Object.freeze(['snapshot', 'fight', 'relay', 'relay-ceiling']);

/** What a ranking was computed against: the target's identity, defences and, for a relay body, its allowance. */
export function targetAssumptions(target) {
  if (!target) return null;
  return {
    kind: target.allowance ? 'relay' : (target.isBoss ? 'boss' : 'foe'),
    mobileType: target.mobileType ?? null,
    careerIndex: target.careerIndex ?? null,
    group: target.group ?? null,
    level: target.level ?? null,
    combatLevel: target.combatLevel ?? null,
    maxHealth: target.maxHealth ?? null,
    hitCap: num(target.hitCap, 0),
    traits: [...(target.bossTraits ?? [])],
    minMetalToHit: target.minMetalToHit ?? null,
    allowance: target.allowance
      ? { level: target.allowance.level, players: target.allowance.players, phases: target.allowance.phases?.length ?? 0 }
      : null,
  };
}

/**
 * One sampled build on one target. Shared by the three stochastic objectives: the per-seed rows are kept (compactly)
 * so `pairedDifference` can compare builds on the SAME seeds; the full trial rows are not copied into the ranking.
 */
function evaluateStochastic(objective, def, ch, scenario, target, pool) {
  const trials = Array.isArray(scenario.seeds)
    ? scenario.seeds.length
    : Math.floor(num(scenario.trials, MIN_STOCHASTIC_TRIALS));
  if (trials < MIN_STOCHASTIC_TRIALS) {
    throw new RangeError(`evaluateObjective("${objective}"): at least ${MIN_STOCHASTIC_TRIALS} trials are required (the audit's first-pass minimum; got ${trials})`);
  }
  const relay = objective === 'stochastic-relay';
  if (!relay && target.allowance) {
    throw new Error(`evaluateObjective("${objective}"): the target is a relay body; use "stochastic-relay"`);
  }
  const sim = relay
    ? simulateRelayFights(ch, { ...scenario, target, health: pool })
    : simulateFights(ch, { ...scenario, target, health: pool });
  if (!sim) throw new Error(`evaluateObjective("${objective}"): the sampled fight did not run`);

  const kp = sim.killProbability;
  const meanTtk = sim.ttk?.mean ?? null;
  const samples = sim.rows.map((r) => ({ seed: r.seed, kill: !!r.kill, ttk: r.kill ? r.ttk : null }));
  const common = {
    objective,
    metric: def.metric,
    unit: def.unit,
    direction: 'max',
    n: sim.trials,
    horizonSeconds: sim.horizonSeconds,
    damageMode: sim.damageMode ?? null,
    killProbability: kp,
    assumptions: { objective, target: targetAssumptions(target), health: pool, basis: def.basis, carry: (scenario.carry ?? true) === true },
    detail: {
      trials: sim.trials,
      kills: sim.kills,
      censored: sim.censored,
      killProbability: kp,
      damageMode: sim.damageMode ?? null,
      ttk: sim.ttk,
      seeds: sim.seeds,
      samples,
      ...(relay ? { terminations: sim.terminations } : { outcomes: sim.outcomes }),
    },
  };
  if (objective === 'kill-probability') {
    return {
      ...common,
      value: kp.p,
      ci: { metric: 'kill-probability', method: 'wilson', p: kp.p, lo: kp.lo, hi: kp.hi, level: 0.95, n: kp.n },
    };
  }
  // ASSUMPTION M42: the score is a kill rate, because TTK is a minimum and the ranking is max-only. With no kill in
  // the horizon there is no mean TTK; the score is 0 and the censoring stays visible in killProbability.
  return {
    ...common,
    value: meanTtk === null ? 0 : sim.health / meanTtk,
    ci: meanTtk === null ? null : {
      metric: 'mean-ttk', mean: meanTtk, se: sim.ttk.se,
      lo: meanTtk - sim.ttk.ci95, hi: meanTtk + sim.ttk.ci95, level: 0.95, n: sim.ttk.n,
    },
  };
}

/**
 * One build on one objective, with the objective and the target it was computed against.
 *
 * @param {object} ch  the build, as `analyze` reads it
 * @param {object} opts  `objective` (one of OBJECTIVE_IDS or STOCHASTIC_OBJECTIVE_IDS), `target` (required), `health`
 *   (the pool), and any `analyze` scenario option (`weapon`, `core`, `backstabUptime`, ...) - the same options the
 *   plain calculation takes. The sampled objectives also read `trials` (>= 1000), `seeds`, `seed` and `maxSeconds`.
 */
export function evaluateObjective(ch, { objective = 'snapshot', target = null, health = null, ...scenario } = {}) {
  const def = OBJECTIVES[objective];
  if (!def) throw new Error(`evaluateObjective: unknown objective "${objective}" (one of ${[...OBJECTIVE_IDS, ...STOCHASTIC_OBJECTIVE_IDS].join(', ')})`);
  if (!target) throw new Error(`evaluateObjective("${objective}"): a declared target is required`);
  if (def.needsRelay && !target.allowance) throw new Error(`evaluateObjective("${objective}"): the target is not a relay body (no allowance)`);
  const pool = health == null ? num(target.maxHealth, 0) : num(health, 0);
  if (def.needsHealth && !(pool > 0)) throw new Error(`evaluateObjective("${objective}"): a positive target health is required`);
  if (def.stochastic) return evaluateStochastic(objective, def, ch, scenario, target, pool);
  const assumptions = { objective, target: targetAssumptions(target), health: def.needsHealth ? pool : null, basis: def.basis };
  const base = { objective, unit: def.unit, direction: 'max', assumptions };

  if (objective === 'snapshot') {
    const r = analyze(ch, { ...scenario, target, health: pool || undefined, healthShare: scenario.healthShare ?? 1 });
    return { ...base, value: r.dps, detail: { dps: r.dps, cappedDps: r.cappedDps, perSwing: r.perSwing, hit: r.hit.hit, aps: r.cadence.aps } };
  }
  if (objective === 'fight') {
    const f = fight(ch, { ...scenario, target, health: pool });
    if (!f) throw new Error('evaluateObjective("fight"): the build cannot empty the pool');
    return { ...base, value: f.killDps, detail: { killDps: f.killDps, outputDps: f.outputDps, ttk: f.ttk, blows: f.blows, overkill: f.overkill, segments: f.segments.length } };
  }
  const fr = fightRelay(ch, { ...scenario, target, health: pool });
  if (!fr) throw new Error(`evaluateObjective("${objective}"): the relay fight does not terminate`);
  if (objective === 'relay') {
    return {
      ...base,
      value: fr.killDps,
      detail: {
        killDps: fr.killDps, ttk: fr.ttk, saturated: fr.saturated, ceilingDps: fr.ceilingDps,
        acceptedDps: fr.acceptedDps, uncappedDps: fr.uncappedDps, marginDps: fr.marginDps, cap: fr.cap, refillDps: fr.refillDps,
      },
    };
  }
  return {
    ...base,
    value: fr.ceilingDps,
    detail: { ceilingDps: fr.ceilingDps, saturated: fr.saturated, marginDps: fr.marginDps, ttk: fr.ttk, acceptedDps: fr.acceptedDps, uncappedDps: fr.uncappedDps },
  };
}

/**
 * The paired difference between two sampled rows on the SAME seeds: `mean(a - b)`, its standard error and a 95%
 * interval. The default metric is TTK over the trials where both builds kill; a `kill-probability` row uses its
 * per-seed kill indicator instead (a difference of two proportions). `dropped` counts trials omitted because one side
 * was censored - the conditional TTK comparison is stated for what it is, not an unconditional one. `separated` is
 * `null` below `MIN_PAIRED_PAIRS` both-kill pairs: the interval is still printed, but it is not a ranking claim.
 * `rankBuilds` copies it to the row as `ttkSeparated`. The interval uses the Student t quantile for small samples
 * (1.96 at a 1,000-trial sample).
 */
export function pairedDifference(a, b, { metric } = {}) {
  const sa = a?.detail?.samples;
  const sb = b?.detail?.samples;
  if (!Array.isArray(sa) || !Array.isArray(sb)) throw new Error('pairedDifference: both rows must carry per-seed samples');
  if (sa.length !== sb.length) throw new Error(`pairedDifference: different trial counts (${sa.length} vs ${sb.length})`);
  const useMetric = metric ?? (a?.metric === 'kill-probability' || b?.metric === 'kill-probability' ? 'kill' : 'ttk');
  const d = [];
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i].seed !== sb[i].seed) throw new Error('pairedDifference: the rows were not run on the same seeds');
    if (useMetric === 'kill') d.push((sa[i].kill ? 1 : 0) - (sb[i].kill ? 1 : 0));
    else if (sa[i].kill && sb[i].kill) d.push(sa[i].ttk - sb[i].ttk);
  }
  const n = d.length;
  const dropped = sa.length - n;
  if (n < 2) {
    return { metric: useMetric, n, dropped, mean: null, se: null, ci95: null, lo: null, hi: null, containsZero: true, separated: null };
  }
  const mean = d.reduce((x, y) => x + y, 0) / n;
  const sd = Math.sqrt(d.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const ci95 = studentT95(n - 1) * se;
  const lo = mean - ci95;
  const hi = mean + ci95;
  const containsZero = lo <= 0 && hi >= 0;
  return {
    metric: useMetric, n, dropped, mean, se, ci95, lo, hi, containsZero,
    separated: n < MIN_PAIRED_PAIRS ? null : !containsZero,
  };
}

/**
 * Rank builds on ONE objective and ONE target. `entries` is `[{ id, ch }]` (a bare `ch` takes the id `i`).
 * Rows are highest-first; every row carries its value, the objective and the target assumptions. A row that cannot be
 * evaluated (a build that cannot kill the pool, a relay objective on a foe) is kept with `error` and sorts last -
 * never silently dropped.
 *
 * A sampled ranking is PAIRED on common random numbers: the row below another carries `ttkSeparated` (false when the
 * paired 95% interval contains 0, null below 8 both-kill pairs) and the paired difference itself. It never reorders.
 * When two rows' kill probabilities are statistically different (Wilson intervals do not overlap), the affected rows
 * carry `censoringDiffers` and the ranking is ordered by kill probability first, then by kill rate: a conditional TTK
 * must not reward a build that only kills its luckiest seeds. Rows with different trials, seeds or horizons are
 * refused.
 */
export function rankBuilds(entries, { objective = 'snapshot', target = null, health = null, ...scenario } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('rankBuilds: at least one entry is required');
  const stochastic = STOCHASTIC_OBJECTIVE_IDS.includes(objective);
  if (stochastic) {
    // fail before simulating when an entry declares a different trial table (common random numbers need one)
    const declared = (e) => {
      const s = e?.scenario ?? {};
      return JSON.stringify({
        trials: s.trials ?? scenario.trials ?? null,
        maxSeconds: s.maxSeconds ?? scenario.maxSeconds ?? null,
        seed: s.seed ?? scenario.seed ?? null,
        seeds: s.seeds ?? scenario.seeds ?? null,
      });
    };
    if (new Set(entries.map(declared)).size > 1) {
      throw new Error('rankBuilds: rows were evaluated with different trials, seeds or horizons');
    }
  }
  const rows = entries.map((e, i) => {
    const ch = e?.ch ?? e?.build ?? e;
    const id = e?.id ?? i;
    try {
      const r = evaluateObjective(ch, { ...scenario, objective, target, health, ...(e?.scenario ?? {}) });
      return { id, value: r.value, ...r };
    } catch (err) {
      return { id, objective, value: null, error: String(err?.message ?? err) };
    }
  });
  // one target, one objective: refuse to compare rows computed against different conditions
  const seen = rows.filter((r) => r.assumptions).map((r) => JSON.stringify(r.assumptions));
  if (new Set(seen).size > 1) throw new Error('rankBuilds: rows were evaluated against different target assumptions');
  if (stochastic) {
    // common random numbers need one trial table: same n, same horizon, same seeds
    const keys = rows.filter((r) => Array.isArray(r.detail?.samples))
      .map((r) => `${r.n}|${r.horizonSeconds}|${r.detail.seeds.join(',')}`);
    if (new Set(keys).size > 1) throw new Error('rankBuilds: rows were evaluated with different trials, seeds or horizons');
  }
  const ok = rows.filter((r) => Number.isFinite(r.value));
  const failed = rows.filter((r) => !Number.isFinite(r.value));
  // Censoring guard: a conditional kill rate must not reward a build that only kills its luckiest seeds. When two
  // Wilson intervals do not overlap, the affected rows are flagged and every row is ordered by kill probability first,
  // then by the kill rate. When they all overlap, the kill rate is the primary key as before.
  let anyCensoringDiffers = false;
  if (stochastic) {
    const kpRows = ok.filter((r) => r.killProbability);
    for (const r of kpRows) r.censoringDiffers = false;
    for (let i = 0; i < kpRows.length; i += 1) {
      for (let j = i + 1; j < kpRows.length; j += 1) {
        const a = kpRows[i].killProbability;
        const b = kpRows[j].killProbability;
        if (a.hi < b.lo || b.hi < a.lo) {
          anyCensoringDiffers = true;
          kpRows[i].censoringDiffers = true;
          kpRows[j].censoringDiffers = true;
        }
      }
    }
  }
  const byKillProbability = stochastic && objective !== 'kill-probability' && anyCensoringDiffers;
  ok.sort((a, b) => {
    if (byKillProbability) {
      const d = (b.killProbability?.p ?? -1) - (a.killProbability?.p ?? -1);
      if (d !== 0) return d;
    }
    return b.value - a.value;
  });
  ok.forEach((r, i) => { r.rank = i + 1; });
  failed.forEach((r) => { r.rank = null; });
  if (stochastic) {
    // flags only: the rows keep their score order, even when the paired interval cannot separate them. `ttkSeparated`
    // compares per-seed TTK over the seeds BOTH kill, while the score uses each row's own killers (ASSUMPTION M42);
    // the paired kill-indicator difference is carried beside it so the two readings cannot be confused.
    for (let i = 1; i < ok.length; i += 1) {
      try {
        const paired = pairedDifference(ok[i - 1], ok[i]);
        ok[i].ttkSeparated = paired.separated;
        ok[i].paired = paired;
        if (paired.metric === 'ttk') ok[i].pairedKill = pairedDifference(ok[i - 1], ok[i], { metric: 'kill' });
      } catch (err) {
        ok[i].ttkSeparated = null;
        ok[i].paired = { error: String(err?.message ?? err) };
      }
    }
  }
  return {
    objective,
    label: OBJECTIVES[objective]?.label ?? objective,
    target: targetAssumptions(target),
    health: health == null ? num(target?.maxHealth, 0) : num(health, 0),
    rows: [...ok, ...failed],
  };
}
