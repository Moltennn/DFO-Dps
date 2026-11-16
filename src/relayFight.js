/*
 * dfo-dps - seeded relay fights (Stage 3.3): Stage 3.2's blow schedule feeding the streaming claim engine.
 *
 * A relay fight is the SAME attack schedule and the SAME Stage 3.1 fight-tier draw as `simulateFight`; what changes is
 * where the blow goes. A blow whose final formula damage is positive is a claim on the relay
 * (`createRelayClaimEngine`), which applies the token hand, the per-claim cap and the damage bucket; a zero-damage miss
 * is not a claim and spends no token, while a Potent Vs miss is a 5-point claim (upstream `formulas.js:873-878` gates on
 * damage, not on the hit flag). The claim is the host-rounded (`Math.round`) UNCAPPED sampled blow (`outcome.blow`): on
 * a relay body it already carries the owed Many Endings echo, and the relay's own `HIT_CAP_X x ref` is the first cap the
 * blow meets. A blow rounded under 1 sends nothing (`gateCourt.hit`).
 *
 * Flow (Stage 3.4) is global, read BEFORE the blow, passed through `blowFightTier`'s existing `flowStacks` option and
 * charged after the strike listener on a whole, positive, non-warded blow. Many Endings uses the existing fight-tier echo
 * branch; a synthetic two-echo build is refused. A warded attack (`t < shieldUntil`) is sampled but sends no claim and
 * builds neither Flow nor echo; at exactly `shieldUntil` it is accepted.
 *
 * Health-dependent terms are rebuilt exactly as in Stage 3.2: the player's remaining share selects the fight-tier
 * segment, and a new table is built at 0.5 or an execute threshold. The engine's `hp` is the player's share of the
 * boss, so a refused claim does not move the tier.
 *
 * Excluded by this stage (the assumptions register M30/M31): CWS, DoTs, wear, phase-ward lifecycle, geometry, the Sundered
 * halves, stun/profile hit multipliers, Wrath, host/crystal hits and the multi-body `spendBlow` sequence. A build with
 * fists is refused by the Stage 3.2 schedule (the unarmed StrikeLeft frame list is not in the analytical cadence).
 * Relay durability is not implemented: `durability: true` is REFUSED (Stage 3.5.3g) rather than silently ignored;
 * omitted and `durability: false` keep the Stage 3.3 behaviour.
 */
import { echoChances, weaponOf, weaponPowers } from './model.js';
import { blowFightTier, createBlowSampler } from './blowOutcomes.js';
import { createRng } from './rng.js';
import { healthThresholds } from './fight.js';
import {
  createAttackSchedule, healthSegment, pairedFightSeeds, summarize, wilsonInterval,
} from './simulateFight.js';
import { createRelayClaimEngine } from './relayClaim.js';
import { createFlowState } from './flowState.js';

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
 *   `durability: true` is refused (relay durability is not implemented); `durability: false`/omitted is unchanged.
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
  // Ordinary durability is not implemented in the relay fight (Stage 3.5.3g). Ignoring the flag would make a caller
  // believe wear/breaks had been applied; refuse it with the same explicit error shape as the other unsupported modes.
  if (scenario.durability === true) {
    throw new Error('simulateRelayFight: relay durability is not supported; omit durability or pass durability: false');
  }
  // Refuse a ranged weapon on either hand BEFORE the schedule analysis, so a mixed melee + Pistolet pair cannot fall
  // through to a melee exchange (analyze's dual arm only checks the off hand for `twoHanded`, not `gun`).
  const mainWeapon = scenario.weapon === undefined ? (ch.weapon ? weaponOf(ch.weapon) : null) : scenario.weapon;
  const offWeapon = ch.offWeapon ? weaponOf(ch.offWeapon) : null;
  if (mainWeapon?.ranged || offWeapon?.ranged) {
    throw new Error('simulateRelayFight: bow and gun builds are not supported on either hand until their release/landing timing and ward/Flow behaviour are modelled');
  }
  // the blow model reads the WHOLE boss health for its cap/curb; the relay engine's pool is this player's share
  const schedule = createAttackSchedule(ch, { ...scenario, health });
  if (!schedule) return null;
  const probe = schedule.probe;
  const probeOffWeapon = probe.offHand?.weapon ?? (ch.offWeapon ? weaponOf(ch.offWeapon) : null);
  if (probe.weapon?.ranged || probeOffWeapon?.ranged) {
    throw new Error('simulateRelayFight: bow and gun builds are not supported on either hand until their release/landing timing and ward/Flow behaviour are modelled');
  }
  const dual = schedule.kind === 'dual';
  const mainPowers = weaponPowers(probe.weapon, scenario);
  const offPowers = dual && probe.offHand?.weapon ? weaponPowers(probe.offHand.weapon) : [];
  const powers = [...mainPowers, ...offPowers];
  // One Many Endings power is real (`warp-edge`). The local two-echo what-if is synthetic; refuse it rather than
  // pretending the game rolls two. A power on each hand is two real weapons, not two rolls on one blow.
  const mainEchoes = echoChances(mainPowers);
  const offEchoes = echoChances(offPowers);
  if (mainEchoes.length > 1 || offEchoes.length > 1) {
    throw new Error('simulateRelayFight: more than one Many Endings power on a hand is not supported');
  }
  if ((mainEchoes.length + offEchoes.length) > 0 && target?.relayBody !== true) {
    throw new Error('simulateRelayFight: a relay body is required for Many Endings (echo) support');
  }
  const mainFlow = mainPowers.find((p) => p?.kind === 'flow') ?? null;
  const offFlow = offPowers.find((p) => p?.kind === 'flow') ?? null;
  const flowPower = mainFlow ?? offFlow;
  const flow = createFlowState({
    max: flowPower ? (flowPower.max ?? 5) : 0,
    seconds: flowPower ? (flowPower.seconds ?? 6) : 0,
  });
  const flowByHand = { main: !!mainFlow, off: !!offFlow };
  if (scenario.seed !== undefined && !Number.isSafeInteger(scenario.seed)) {
    throw new TypeError('simulateRelayFight: seed must be a safe integer');
  }
  const seed = Number.isSafeInteger(scenario.seed) ? scenario.seed : 0;
  const rng = createRng(seed);
  const blowStream = rng.stream('blow');
  const shieldUntil = num(scenario.shieldUntil, 0);
  const engine = createRelayClaimEngine({
    level: spec.level,
    share: pool,
    fresh: scenario.fresh !== false,
    shieldUntil,
  });
  const bounds = healthThresholds(powers);
  const maxSeconds = num(scenario.maxSeconds, 3600);
  const maxBlows = Math.max(1, Math.floor(num(scenario.maxBlows, 1000000)));
  const trace = scenario.trace === true ? [] : null;
  const traceAll = scenario.traceAll === true ? [] : null;
  // TEST SEAM: `events` supplies pre-sampled attack outcomes (for the whole-compositor upstream differential). It is
  // accepted only with an explicit test brand and skips the local tier sampler while running the same Flow/claim/
  // rounding/engine path. Ordinary callers cannot pass it by accident.
  const provided = Array.isArray(scenario.events) && scenario.__relayEventsTest === true ? scenario.events : null;
  if (scenario.events !== undefined && !provided) {
    throw new Error('simulateRelayFight: events is a test-only option (use test/harness/relayEventSeam.mjs)');
  }

  const cache = new Map();
  const distribution = (index, hand, stacks) => {
    const key = `${index}|${hand}|${stacks}`;
    let d = cache.get(key);
    if (d) return d;
    const mid = (bounds[index] + bounds[index + 1]) / 2;
    const tier = blowFightTier(ch, {
      ...scenario, target, health, healthShare: mid, hand, flowStacks: stacks,
      ...(dual && !scenario.dual ? { dual: true } : {}),
    });
    d = { tier, sampler: createBlowSampler(tier), mid };
    cache.set(key, d);
    return d;
  };

  let attacks = 0;
  let claims = 0;
  let wardedAttacks = 0;
  let zeroDamage = 0;
  let roundedZero = 0;
  let flowBuilds = 0;
  let lastAttackAt = 0;
  let termination = 'schedule';
  let eventIndex = 0;
  let next = provided ? null : schedule.next();
  for (;;) {
    // The blow budget is checked before the horizon: if both bind, the fight stopped at the last attack, not at a
    // horizon it never reached.
    if (attacks >= maxBlows) { termination = 'maxBlows'; break; }
    const event = provided ? provided[eventIndex] : null;
    if (provided && !event) { termination = 'schedule'; break; }
    if (!provided && !next) { termination = 'schedule'; break; }
    const t = provided ? event.t : next.t;
    if (t > maxSeconds) { termination = 'horizon'; break; }
    attacks += 1;
    lastAttackAt = t;
    const hand = provided ? (event.hand ?? 'main') : (dual ? next.hand : 'main');
    const share = pool > 0 ? Math.max(0, Math.min(1, engine.hp / pool)) : 0;
    const index = healthSegment(bounds, share);
    // Flow is read BEFORE the blow, once per attack; a warded blow reads none for its (discarded) sample.
    const stackedBefore = flow.stacksAt(t);
    let outcome;
    let tierStacks = null;
    let tierHand = null;
    if (provided) {
      outcome = event.outcome;
      eventIndex += 1;
    } else {
      const dist = distribution(index, hand, stackedBefore);
      outcome = dist.sampler.sample(blowStream);
      tierStacks = dist.tier.meta.flowStacks;
      tierHand = dist.tier.meta.hand;
    }
    // Echo count is derived from the mask, not copied from a supplied count.
    const popcount = (mask) => {
      let n = 0;
      for (let m = mask | 0; m; m >>>= 1) n += m & 1;
      return n;
    };
    const echoHits = popcount(outcome.echoMask);
    // The client's ward flag is the phase shield evaluated for this attack (gateCourt.target/body): no Flow, no echo,
    // no claim. The engine keeps its own shield clock too, but the compositor never sends a warded claim.
    const warded = t < shieldUntil;
    if (warded) {
      wardedAttacks += 1;
      if (traceAll) traceAll.push({
        t, hand, segment: index, share, warded: true, raw: null, claim: null,
        tierStacks, tierHand,
        hit: outcome.hit, whole: outcome.whole, echoMask: outcome.echoMask, echoHits,
        stacksBefore: stackedBefore, stacksAfter: stackedBefore, flowUntil: flow.until, flowBuilt: false,
        got: 0, accepted: false, reason: 'warded', bucket: engine.bucket, tokens: engine.tokens, hp: engine.hp,
      });
      if (engine.killed) { termination = 'kill'; break; }
      if (!provided) next = schedule.next();
      continue;
    }
    // A relay tier's `blow` already carries the owed echo (echoDamage 0). The event seam receives the pre-echo and echo
    // components separately from upstream, so the compositor composes them here; production is unchanged.
    const echoDamage = provided ? Math.max(0, num(outcome.echoDamage, 0)) : 0;
    const raw = outcome.blow + echoDamage;
    // The listener predicate is the PRE-PULL, PRE-TRAIT formula damage (`formulaPositive`), not the post-trait `blow`.
    // On melee the two agree because boss resistance never takes a positive damage below 1; the name is the source's.
    const eligible = outcome.formulaPositive === true;
    // The strike listener's Flow arm: only a whole, eligible blow refreshes; the stack read was before the blow.
    const flowResult = flow.hit(t, { whole: outcome.whole, eligible: eligible && flowByHand[hand] });
    if (flowResult.built) flowBuilds += 1;
    if (!(raw > 0)) {
      zeroDamage += 1;
      if (traceAll) traceAll.push({
        t, hand, segment: index, share, warded: false, raw, claim: null,
        tierStacks, tierHand,
        hit: outcome.hit, whole: outcome.whole, echoMask: outcome.echoMask, echoHits,
        stacksBefore: flowResult.before, stacksAfter: flowResult.after, flowUntil: flowResult.until, flowBuilt: flowResult.built,
        got: 0, accepted: false, reason: 'zero', bucket: engine.bucket, tokens: engine.tokens, hp: engine.hp,
      });
      if (engine.killed) { termination = 'kill'; break; }
      if (!provided) next = schedule.next();
      continue;
    }
    // The host's wire rounds the final number and sends nothing below 1 (gateCourt.hit). Flow and echo already ran.
    const claim = Math.round(raw);
    if (!(claim >= 1)) {
      roundedZero += 1;
      if (traceAll) traceAll.push({
        t, hand, segment: index, share, warded: false, raw, claim: null,
        tierStacks, tierHand,
        hit: outcome.hit, whole: outcome.whole, echoMask: outcome.echoMask, echoHits,
        stacksBefore: flowResult.before, stacksAfter: flowResult.after, flowUntil: flowResult.until, flowBuilt: flowResult.built,
        got: 0, accepted: false, reason: 'rounded-zero', bucket: engine.bucket, tokens: engine.tokens, hp: engine.hp,
      });
      if (engine.killed) { termination = 'kill'; break; }
      if (!provided) next = schedule.next();
      continue;
    }
    const result = engine.claim({ t, damage: claim });
    claims += 1;
    if (traceAll) traceAll.push({
      t, hand, segment: index, share, warded: false, raw, claim,
      tierStacks, tierHand,
      hit: outcome.hit, whole: outcome.whole, echoMask: outcome.echoMask, echoHits,
      stacksBefore: flowResult.before, stacksAfter: flowResult.after, flowUntil: flowResult.until, flowBuilt: flowResult.built,
      got: result.got, accepted: result.accepted, reason: result.reason,
      bucket: result.bucketAfter, tokens: result.tokensAfter, hp: result.hpAfter,
    });
    if (trace) {
      trace.push({
        t, hand, segment: index, share, claim,
        tierStacks, tierHand,
        hit: outcome.hit, whole: outcome.whole, echoMask: outcome.echoMask, echoHits,
        stacksBefore: flowResult.before, stacksAfter: flowResult.after, flowUntil: flowResult.until,
        flowBuilt: flowResult.built,
        got: result.got, clipped: result.clipped, bucketClip: result.bucketClip,
        capClip: result.capClip, healthClip: result.healthClip,
        accepted: result.accepted, reason: result.reason,
        bucket: result.bucketAfter, tokens: result.tokensAfter, hp: result.hpAfter,
      });
    }
    if (engine.killed) { termination = 'kill'; break; }
    if (!provided) next = schedule.next();
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
    wardedAttacks,
    zeroDamage,
    roundedZero,
    flowBuilds,
    flow: flow.state(time),
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
    traceAll,
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
    wardedAttacks: summarize(rows.map((r) => r.wardedAttacks)),
    zeroDamage: summarize(rows.map((r) => r.zeroDamage)),
    roundedZero: summarize(rows.map((r) => r.roundedZero)),
    flowBuilds: summarize(rows.map((r) => r.flowBuilds)),
    flowStacks: summarize(rows.map((r) => r.flow.stacks)),
    bucket: summarize(rows.map((r) => r.bucket)),
    tokens: summarize(rows.map((r) => r.tokens)),
    saturated: rows.filter((r) => r.saturated).length,
    outputDps: summarize(rows.map((r) => r.outputDps)),
    killDps: summarize(kills.map((r) => r.killDps)),
    rows,
    with: (edit = {}) => simulateRelayFights(ch, { ...args, ...edit }),
  };
}
