/*
 * dfo-dps - the relay's per-player damage allowance (encounter law).
 *
 * The client computes a blow and CLAIMS it; the relay's brain decides how much
 * of the claim lands. For a gate boss (and the Sky-ketch and Abyss bodies,
 * which spend the same hand and purse) the verdict for one claim is
 * (vendor/upstream/a3eb1605/src/net/gate/gateBrain.js):
 *
 *   joinFight   :1213  a player joins with bucket = BUCKET_DEPTH_X x ref (empty
 *                      if the boss is already wounded) and GATE_HIT_HZ_MAX tokens;
 *                      their share of the boss is BOSS_TTK_S x ref health.
 *   applyHit    :1298  refused outright while the boss is shielded (no token
 *                      spent), then spendBlow takes a token, then
 *                         got = min(claim, HIT_CAP_X x ref, bucket, health left)
 *                      The bucket refills BUCKET_RATE_X x ref a second up to
 *                      BUCKET_DEPTH_X x ref. What the claim exceeds `got` by is
 *                      DISCARDED (counted as `clipped`), never deferred.
 *   spendBlow   :3411  a token bucket, GATE_HIT_HZ_MAX deep and refilling that
 *                      many a second; a claim with no token is refused whole.
 *
 * ref = dpsRef(level) = 5 + level (level 1..60), gateBrain.js:302.
 *
 * What this file adds on top of the law is only a deterministic expected-value
 * schedule of claims (see ASSUMPTION below) and the metrics read off it. It
 * has no imports, so the per-hit model (model.js) and the encounter wrapper
 * (purse.js) share ONE implementation.
 *
 * ASSUMPTION (the assumptions register A7): a build's landed blows are evenly spaced
 * at 1 / (swings a second x hit chance) and each carries its expected capped
 * damage. The real stream is random; test/allowance.test.js checks this
 * schedule against seeded random streams run through the game's own applyHit.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** The relay's published constants (gateBrain.js:302-311). */
export const ALLOWANCE = Object.freeze({ depthX: 15, rateX: 3, hitCapX: 12, hitHz: 4, shareS: 240, refMin: 1, refMax: 60 });

/** One magic round in real seconds: a damage-over-time claim lands once a round. */
export const DOT_ROUND_S = 5;

/** The Breach's phase fractions and ward (gateBrain.js:328-329 PHASE_AT, SHIELD_MS). */
export const BREACH_PHASES = Object.freeze([
  Object.freeze({ at: 0.66, shieldS: 3 }),
  Object.freeze({ at: 0.33, shieldS: 3 }),
]);

/** dpsRef(level): the reference damage a second at a (clamped) level. */
export const refOf = (level) => 5 + clamp(Math.floor(Number(level) || 1), ALLOWANCE.refMin, ALLOWANCE.refMax);

/** The per-player law at a level: depth, refill, per-claim cap and the claim-rate bucket. */
export function allowanceLaw(level) {
  const ref = refOf(level);
  return {
    ref,
    depth: ALLOWANCE.depthX * ref,
    rate: ALLOWANCE.rateX * ref,
    cap: ALLOWANCE.hitCapX * ref,
    hitHz: ALLOWANCE.hitHz,
    share: ALLOWANCE.shareS * ref,
  };
}

/**
 * What a target declares so the per-hit model can run the encounter: who is
 * fighting at what level, how many share the boss (the pool and every player's
 * allowance scale together, so one player's view is pool / players), and its
 * shields. `immunityShare`/`openingS` are the Sky-ketch's calibrated windows.
 */
export function allowanceSpec(level, { players = 1, phases = BREACH_PHASES, openingS = 0, immunityShare = null } = {}) {
  return Object.freeze({
    level,
    players: Math.max(1, Math.floor(Number(players) || 1)),
    phases: Object.freeze((phases ?? []).map((p) => Object.freeze({ at: p.at, shieldS: Number(p.shieldS) || 0 }))),
    openingS: Math.max(0, Number(openingS) || 0),
    immunityShare: Number.isFinite(immunityShare) ? immunityShare : null,
  });
}

/**
 * The claims one build offers, from a per-hit result (plain numbers):
 *
 *   blow   every landed swing is one claim: its expected capped damage per
 *          landed blow (cappedPerSwing / hit). An imprint or an enchantment is IN that
 *          blow (src/model.js), not a multiplier laid over its mean here.
 *   proc   each Cast When Strikes spell is its OWN claim on the boss
 *          (standInSpell.js:198-217 land(..., HIT_KINDS.Spell)); the client
 *          opens a fresh blow sequence for each (gateCourt.js:412 blowQ), so it
 *          spends its own token and its own bucket, capped on its own.
 *   dot    the damage-over-time ticks of all procs arrive as ONE summed claim
 *          per round (standInSpell.js:131-151), capped once.
 *
 * Potent Vs / Low Damage Vs (+-5) ride inside the blow upstream and are NOT
 * folded in here (see the assumptions register): they matter only for a build that
 * does not already exceed the allowance.
 */
export function claimStreams({ cappedPerSwing, hit, aps, procs = [], cap = 0, withProcs = true }) {
  const out = [];
  const h = Math.max(0, Math.min(1, Number(hit) || 0));
  const swings = Number(aps) || 0;
  const per = Number(cappedPerSwing) || 0;
  if (!(h > 0) || !(swings > 0) || !(per > 0)) return out;
  const interval = 1 / (swings * h);
  const limit = (v) => (cap > 0 ? Math.min(v, cap) : v);
  const blow = limit(per / h);
  out.push({ kind: 'blow', perClaim: blow, interval, start: interval });
  if (!withProcs) return out;
  let dot = 0;
  for (const p of procs ?? []) {
    const instant = Number(p?.damage) || 0;
    if (instant > 0) out.push({ kind: 'proc', name: p.name, perClaim: limit(instant), interval, start: interval });
    dot += Number(p?.dotTick) || 0;
  }
  if (dot > 0) out.push({ kind: 'dot', perClaim: limit(dot), interval: DOT_ROUND_S, start: interval });
  return out;
}

/**
 * Run claims through the relay's law over time.
 *
 * @param {object} p
 * @param {number} p.share        this player's share of the boss's health
 * @param {{depth:number, rate:number, cap:number, hitHz:number}} p.law
 * @param {Array}  p.streams      claimStreams()
 * @param {Array}  [p.phases]     [{at, shieldS}] shields raised as health falls through `at`
 * @param {number} [p.openingS]   immunity at the start (calibrated content)
 * @param {number} [p.immunityShare] calibrated share of the fight in which nothing lands
 * @param {number} [p.splitPenaltyS]
 * @param {boolean} [p.fresh=true] false: joined a wounded boss, so the bucket starts empty (gateBrain.js:1231-1240)
 * @param {(stream: object, hp: number, t: number) => number} [p.perClaimAt] what a claim is worth at the health that
 *   stands when it is made - the same law, with the claim a function of the foe's share instead of a constant (a
 *   health-dependent blow such as venom's doubling or axe mastery). Default: the stream's own `perClaim`.
 */
export function simulateAllowance({ share, law, streams, phases = [], openingS = 0, immunityShare = null, splitPenaltyS = 0, fresh = true, maxSeconds = 3600, burstWindowS = 5, perClaimAt = null }) {
  const { depth, rate, cap, hitHz } = law;
  const total = Number(share) || 0;
  if (!(total > 0) || !streams.length) return null;

  let t = 0;
  let hp = total;
  let bucket = fresh ? depth : 0;
  let bucketAt = 0;
  let tokens = hitHz;
  let tokenAt = 0;
  let shieldUntil = 0;
  let shielded = 0;
  let phaseAt = 0;
  const order = [...phases].sort((a, b) => b.at - a.at);

  let offered = 0;
  let claimed = 0;
  let landed = 0;
  let claims = 0;
  let accepted = 0;
  let refused = 0;
  let clipped = 0;
  let burst = 0;
  let dryAt = null;
  const burstEnd = Math.max(0, burstWindowS - Math.max(0, Number(openingS) || 0));

  // Next-claim times per stream, advanced independently (a merge of fixed-interval streams).
  const next = streams.map((s) => s.start ?? s.interval);

  while (hp > 1e-9 && t < maxSeconds) {
    let k = 0;
    for (let i = 1; i < next.length; i++) if (next[i] < next[k] - 1e-12) k = i;
    if (next[k] > maxSeconds) break;
    const s = streams[k];
    t = next[k];
    next[k] += s.interval;

    bucket = Math.min(depth, bucket + Math.max(0, t - bucketAt) * rate);
    bucketAt = t;
    tokens = Math.min(hitHz, tokens + Math.max(0, t - tokenAt) * hitHz);
    tokenAt = t;

    const claim = perClaimAt ? Math.max(0, Number(perClaimAt(s, hp, t)) || 0) : s.perClaim;
    offered += claim;
    claims += 1;
    if (t < shieldUntil) {
      // refused before a token is spent; the law is strict (vendor/upstream/a3eb1605/src/net/gate/gateBrain.js:1308@a3eb1605
      // `now < B.shieldUntil`), so a claim at exactly the shield's end is accepted
      refused += 1;
      continue;
    }
    if (tokens < 1) {
      refused += 1;
      continue;
    }
    tokens -= 1;
    claimed += claim;
    const want = Math.min(claim, cap);
    const got = Math.max(0, Math.min(want, bucket, hp));
    if (got < Math.min(want, hp) - 1e-9 && dryAt === null) dryAt = t;
    clipped += claim - got;
    bucket -= got;
    hp -= got;
    landed += got;
    accepted += 1;
    if (t <= burstEnd) burst += got;
    while (phaseAt < order.length && hp <= total * order[phaseAt].at) {
      const until = t + (Number(order[phaseAt].shieldS) || 0);
      shielded += Math.max(0, until - Math.max(t, shieldUntil));
      shieldUntil = Math.max(shieldUntil, until);
      phaseAt += 1;
    }
  }

  const killed = hp <= 1e-9;
  const immune = Number.isFinite(immunityShare) ? clamp(immunityShare, 0, 0.95) : 0;
  const ttk = killed ? (Number(openingS) || 0) + t / Math.max(1e-9, 1 - immune) + Math.max(0, splitPenaltyS) : null;
  return {
    killed,
    ttk,
    fightSeconds: t,
    shieldedSeconds: shielded,
    activeSeconds: Math.max(0, t - shielded),
    claimsOffered: claims,
    claimsAccepted: accepted,
    claimsRefused: refused,
    offered,
    claimed,
    landed,
    clipped,
    landedShare: claimed > 0 ? landed / claimed : 0,
    burst5: burst,
    dryAt,
    immunityShare: immune,
    openingS: Number(openingS) || 0,
    splitPenaltyS: Math.max(0, splitPenaltyS),
  };
}

/**
 * Offered damage a second before the relay, and the rate it can possibly
 * sustain. The steady-state rate is a fixed point, not a time average: once
 * the bucket is dry every accepted point is a refilled one, so the relay
 * accepts exactly min(offered, refill) - and a claim rate above the token
 * bucket's is thinned in proportion.
 */
export function steadyState(streams, law) {
  let dps = 0;
  let claimsPerS = 0;
  for (const s of streams) {
    dps += s.perClaim / s.interval;
    claimsPerS += 1 / s.interval;
  }
  const thin = claimsPerS > law.hitHz ? law.hitHz / claimsPerS : 1;
  const offeredDps = dps;
  const claimLimitedDps = dps * thin;
  return {
    offeredDps,
    claimsPerSecond: claimsPerS,
    claimLimitedDps,
    refill: law.rate,
    sustainedDps: Math.min(claimLimitedDps, law.rate),
    saturated: claimLimitedDps > law.rate,
  };
}

/**
 * The encounter's answer for one build: the discrete run plus the metrics, all
 * named for what they are.
 *
 *   ceilingDps    offeredDps - per-hit-capped, before the relay (what the old
 *                 "Boss DPS" showed). A ceiling, never an outcome.
 *   sustainedDps  the allowance fixed point min(offered, refill).
 *   burst5Dps     accepted damage in the first 5 s / 5 (the opening bucket).
 *   averageDps    share / ttk - the whole fight's mean, shields included.
 *   ttk           expected time to kill (null if the build cannot kill).
 */
export function runAllowance({ level, share, spec, streams, fresh = true, splitPenaltyS = 0 }) {
  const law = allowanceLaw(level);
  const run = simulateAllowance({
    share,
    law,
    streams,
    phases: spec?.phases ?? [],
    openingS: spec?.openingS ?? 0,
    immunityShare: spec?.immunityShare ?? null,
    splitPenaltyS,
    fresh,
  });
  if (!run) return null;
  const steady = steadyState(streams, law);
  return {
    law,
    share,
    ...run,
    ceilingDps: steady.offeredDps,
    sustainedDps: steady.sustainedDps,
    saturated: steady.saturated,
    claimsPerSecond: steady.claimsPerSecond,
    burst5Dps: run.burst5 / 5,
    averageDps: run.ttk ? share / run.ttk : null,
  };
}
