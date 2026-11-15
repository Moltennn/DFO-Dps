/*
 * dfo-dps - seeded relay fights (Stage 3.3): Stage 3.2's blow schedule feeding the streaming claim engine.
 *
 * A relay fight is the SAME attack schedule and the SAME Stage 3.1 fight-tier draw as `simulateFight`; what changes is
 * where the blow goes. A landed, positive blow is a claim on the relay (`createRelayClaimEngine`), which applies the
 * token hand, the per-claim cap and the damage bucket. A miss is not a claim (upstream `applyHit` is refused for
 * `d <= 0` before a token is spent), so a missed swing consumes no token; the attack still occupies its scheduled
 * time. The claim is the UNCAPPED sampled blow (`outcome.damage`): the relay's own `HIT_CAP_X x ref` is the first cap
 * the blow meets, never a second (pre-capped) one.
 *
 * Health-dependent terms are rebuilt exactly as in Stage 3.2: the player's remaining share selects the fight-tier
 * segment, and a new table is built at 0.5 or an execute threshold. The engine's `hp` is the player's share of the
 * boss, so a refused claim does not move the tier.
 *
 * Excluded by this stage (the assumptions register M30): Many Endings/echo claims (a build carrying one is refused rather
 * than letting the tier's echo ride into the claim), CWS, DoTs, Flow, phase-ward lifecycle, geometry, the Sundered
 * halves, stun/profile hit multipliers, Wrath, host/crystal hits and the multi-body `spendBlow` sequence. A build with
 * fists is refused by the Stage 3.2 schedule (the unarmed StrikeLeft frame list is not in the analytical cadence).
 */
import { weaponPowers } from './model.js';
import { blowFightTier, createBlowSampler } from './blowOutcomes.js';
import { createRng } from './rng.js';
import { healthThresholds } from './fight.js';
import {
  createAttackSchedule, healthSegment, pairedFightSeeds, summarize, wilsonInterval,
} from './simulateFight.js';
import { createRelayClaimEngine } from './relayClaim.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function normalizeScenario(args) {
  const scenario = { ...args };
  if (scenario.imprint) {
    scenario.imprints = [...(scenario.imprints ?? []), scenario.imprint];
    delete scenario.imprint;
  }
  return scenario;
}

/**
 * One seeded relay fight.
 *
 * @param {object} ch the build
 * @param {object} args `analyze`/`simulateFight` args plus `target` (must carry `allowance`), `health`, `seed`,
 *   `fresh` (false: a wounded boss, empty damage bucket), `shieldUntil` (seconds), `maxSeconds`, `maxBlows`, `trace`.
 * @returns {null|object} null when the target is not a relay body or the schedule cannot run
 */
export function simulateRelayFight(ch, args = {}) {
  const scenario = normalizeScenario(args);
  const target = scenario.target ?? null;
  const spec = target?.allowance ?? null;
  if (!spec) return null;
  const health = num(scenario.health, num(target?.maxHealth, 0));
  const players = Math.max(1, num(spec.players, 1));
  const pool = health / players;
  if (!(pool > 0)) return null;
  // the blow model reads the WHOLE boss health for its cap/curb; the relay engine's pool is this player's share
  const schedule = createAttackSchedule(ch, { ...scenario, health });
  if (!schedule) return null;
  const probe = schedule.probe;
  const dual = schedule.kind === 'dual';
  const powers = [
    ...weaponPowers(probe.weapon, scenario),
    ...(dual && probe.offHand?.weapon ? weaponPowers(probe.offHand.weapon, scenario) : []),
  ];
  if (powers.some((p) => p?.kind === 'echo')) {
    throw new Error('simulateRelayFight: Many Endings (echo) claims are not supported in Stage 3.3');
  }
  if (scenario.seed !== undefined && !Number.isSafeInteger(scenario.seed)) {
    throw new TypeError('simulateRelayFight: seed must be a safe integer');
  }
  const seed = Number.isSafeInteger(scenario.seed) ? scenario.seed : 0;
  const rng = createRng(seed);
  const blowStream = rng.stream('blow');
  const engine = createRelayClaimEngine({
    level: spec.level,
    share: pool,
    fresh: scenario.fresh !== false,
    shieldUntil: num(scenario.shieldUntil, 0),
  });
  const bounds = healthThresholds(powers);
  const maxSeconds = num(scenario.maxSeconds, 3600);
  const maxBlows = Math.max(1, Math.floor(num(scenario.maxBlows, 1000000)));
  const trace = scenario.trace === true ? [] : null;

  const cache = new Map();
  const distribution = (index, hand) => {
    const key = `${index}|${hand}`;
    let d = cache.get(key);
    if (d) return d;
    const mid = (bounds[index] + bounds[index + 1]) / 2;
    const tier = blowFightTier(ch, {
      ...scenario, target, health, healthShare: mid, hand,
      ...(dual && !scenario.dual ? { dual: true } : {}),
    });
    d = { tier, sampler: createBlowSampler(tier), mid };
    cache.set(key, d);
    return d;
  };

  let attacks = 0;
  let claims = 0;
  let lastAttackAt = 0;
  let termination = 'schedule';
  let next = schedule.next();
  for (;;) {
    // The blow budget is checked before the horizon: if both bind, the fight stopped at the last attack, not at a
    // horizon it never reached.
    if (attacks >= maxBlows) { termination = 'maxBlows'; break; }
    if (!next) { termination = 'schedule'; break; }
    if (next.t > maxSeconds) { termination = 'horizon'; break; }
    attacks += 1;
    lastAttackAt = next.t;
    const hand = dual ? next.hand : 'main';
    const share = pool > 0 ? Math.max(0, Math.min(1, engine.hp / pool)) : 0;
    const index = healthSegment(bounds, share);
    const dist = distribution(index, hand);
    const outcome = dist.sampler.sample(blowStream);
    if (outcome.hit && outcome.damage > 0) {
      const result = engine.claim({ t: next.t, damage: outcome.damage });
      claims += 1;
      if (trace) {
        trace.push({
          t: next.t, hand, segment: index, share, claim: outcome.damage,
          got: result.got, clipped: result.clipped, bucketClip: result.bucketClip,
          capClip: result.capClip, healthClip: result.healthClip,
          accepted: result.accepted, reason: result.reason,
          bucket: result.bucketAfter, tokens: result.tokensAfter, hp: result.hpAfter,
        });
      }
    }
    if (engine.killed) { termination = 'kill'; break; }
    next = schedule.next();
  }

  const s = engine.summary();
  // Fight elapsed time is independent of the claim clock: the claim engine only sees positive landed claims.
  const time = s.killed ? s.killedAt
    : termination === 'horizon' ? maxSeconds
      : lastAttackAt;
  const outputDps = time > 0 ? s.dealt / time : null;
  return {
    seed,
    kill: s.killed,
    ttk: s.killedAt,
    time,
    claimTime: s.time,
    lastAttackAt,
    termination,
    censored: !s.killed,
    censoredAt: s.killed ? null : time,
    health: pool,
    remainingHealth: s.hp,
    overkill: s.healthClip,
    damageDealt: s.dealt,
    offered: s.offered,
    clipped: s.clipped,
    refusedDamage: s.refusedOffer,
    capClip: s.capClip,
    bucketClip: s.bucketClip,
    healthClip: s.healthClip,
    claims: s.claims,
    attacks,
    accepted: s.accepted,
    refused: s.refused,
    invalid: s.invalid,
    shielded: s.shielded,
    noToken: s.noToken,
    empty: s.empty,
    saturated: s.saturated,
    dryAt: s.dryAt,
    bucket: s.bucket,
    bucketCapacity: s.bucketCapacity,
    tokens: s.tokens,
    tokenCapacity: s.tokenCapacity,
    remainingShare: s.remainingShare,
    outputDps,
    killDps: s.killDps,
    landedShare: s.landedShare,
    law: {
      level: spec.level, ref: s.ref, depth: s.bucketCapacity, rate: s.bucketRate,
      cap: s.cap, hitHz: s.tokenRate, share: pool,
    },
    schedule: schedule.assumptions,
    target,
    trace,
    with: (edit = {}) => simulateRelayFight(ch, { ...args, ...edit }),
  };
}

/**
 * Run `trials` independent relay fights. `ttk`/`killDps` are conditional on a kill; `killProbability` is the overall
 * share that kills inside the horizon. `time` is each fight's elapsed time (kill time, the horizon, or the last attack
 * when a budget stops it earlier); `outputDps` is dealt / `time` over every trial, while `killDps` stays conditional on
 * a kill. `damageDealt`, `overkill`, `clipped`, `time` and the bucket state cover every trial.
 */
export function simulateRelayFights(ch, args = {}) {
  const trials = Math.max(1, Math.floor(num(args.trials, Array.isArray(args.seeds) ? args.seeds.length : 1000)));
  const seeds = Array.isArray(args.seeds) ? [...args.seeds] : pairedFightSeeds(trials, num(args.seed, 0));
  if (!seeds.length) throw new RangeError('simulateRelayFights: at least one seed is required');
  const rows = seeds.map((seed) => simulateRelayFight(ch, { ...args, seed }));
  if (rows.some((r) => !r)) return null;
  const kills = rows.filter((r) => r.kill);
  const ttk = summarize(kills.map((r) => r.ttk));
  return {
    trials: rows.length,
    seeds,
    health: rows[0].health,
    kills: kills.length,
    censored: rows.length - kills.length,
    ttk,
    ttkConditional: ttk,
    killProbability: wilsonInterval(kills.length, rows.length),
    horizonSeconds: num(args.maxSeconds, 3600),
    time: summarize(rows.map((r) => r.time)),
    claimTime: summarize(rows.map((r) => r.claimTime)),
    lastAttackAt: summarize(rows.map((r) => r.lastAttackAt)),
    terminations: {
      kill: rows.filter((r) => r.termination === 'kill').length,
      horizon: rows.filter((r) => r.termination === 'horizon').length,
      maxBlows: rows.filter((r) => r.termination === 'maxBlows').length,
      schedule: rows.filter((r) => r.termination === 'schedule').length,
    },
    damageDealt: summarize(rows.map((r) => r.damageDealt)),
    offered: summarize(rows.map((r) => r.offered)),
    clipped: summarize(rows.map((r) => r.clipped)),
    refusedDamage: summarize(rows.map((r) => r.refusedDamage)),
    overkill: summarize(rows.map((r) => r.overkill)),
    accepted: summarize(rows.map((r) => r.accepted)),
    refused: summarize(rows.map((r) => r.refused)),
    claims: summarize(rows.map((r) => r.claims)),
    bucket: summarize(rows.map((r) => r.bucket)),
    tokens: summarize(rows.map((r) => r.tokens)),
    saturated: rows.filter((r) => r.saturated).length,
    outputDps: summarize(rows.map((r) => r.outputDps)),
    killDps: summarize(kills.map((r) => r.killDps)),
    rows,
    with: (edit = {}) => simulateRelayFights(ch, { ...args, ...edit }),
  };
}
