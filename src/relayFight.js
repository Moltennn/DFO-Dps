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
 * Included since Stage 3.7d: Cast When Strikes procs and Continuous Damage rounds are claims of their own on the relay
 * body. A blow that carries a CWS row resolves the cast INSIDE the blow's formula, before the host's blow claim
 * (`vendor:combat/formulas.js:826-836`), so a cast kill suppresses the blow claim; a proc is its own claim
 * (`vendor:scenes/gate/standInSpell.js:198-217`) and the cast's first DoT round rides it. Later rounds are ONE claim per
 * round carrying the sum of the live entries' ticks (`standInSpell.js:131-151`), at `k x MAGIC_ROUND_SECONDS` from t=0,
 * after the blow at an equal timestamp (M35); the entry itself is one like-kind entry per body (renewal,
 * `vendor:systems/effects.js:1091-1103`). A DoT round ticks even when the body is turned, but the host sends no claim
 * during `t < shieldUntil` or an explicit `target.warded` (`standInSpell.js:219-236`, `gateCourt.js:1159-1168` @ a3eb1605).
 *
 * Excluded by this stage (the assumptions register M30/M31/M38): wear, phase-ward lifecycle, geometry, the Sundered
 * halves, stun/profile hit multipliers, Wrath, host/crystal hits and the multi-body `spendBlow` sequence. A build with
 * fists is refused by the Stage 3.2 schedule (the unarmed StrikeLeft frame list is not in the analytical cadence).
 * Relay durability is not a gap: a relay body is a `spareGear` stand-in (`vendor:world/gate/gateBoss.js:161`), and the
 * game wears nothing on it - every blow's `damageEquipment` returns at once (`vendor:combat/formulas.js:569-574`, WBX6)
 * and every Strikes payload's durability bill is zeroed (`vendor:systems/enchantments.js:1066-1072`, WBX F2). There is
 * nothing to model, so `durability: true` stays REFUSED (Stage 3.5.3g): a wear pass here would invent a loss the game
 * never takes. Omitted and `durability: false` keep the Stage 3.3 behaviour.
 */
import { createCarryState, echoChances, weaponOf, weaponPowers } from './model.js';
import { blowFightTier, createBlowSampler } from './blowOutcomes.js';
import { createRng } from './rng.js';
import { healthThresholds } from './fight.js';
import {
  createAttackSchedule, healthSegment, pairedFightSeeds, summarize, wilsonInterval,
} from './simulateFight.js';
import { createRelayClaimEngine } from './relayClaim.js';
import { createFlowState } from './flowState.js';
import { cwsEligible, cwsRows, equippedForFight, resolveCwsCast, spellPowerInputs, tickActiveEffects } from './cws.js';
import { MAGIC_ROUND_SECONDS } from './spells.js';
import { resistSpell } from './bossTraits.js';

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
 *   `durability: true` is refused (a relay body is `spareGear` and the game wears nothing on it);
 *   `durability: false`/omitted is unchanged.
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
  // A relay body is `spareGear`, so the game wears nothing there (`vendor:combat/formulas.js:569-574`,
  // `vendor:systems/enchantments.js:1066-1072`): there is no wear to model. Ignoring the flag would still make a caller
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
  // The cast's own stream, exactly as the ordinary fight takes one (simulateFight.js): a new stream is independent of
  // the blow stream, so a build with no CWS row draws nothing and its fight is bit-identical.
  const cwsStream = rng.stream('cws');
  const cwsRolls = scenario.cwsRolls === undefined ? () => cwsStream.float() : scenario.cwsRolls;
  if (typeof cwsRolls !== 'function') throw new TypeError('simulateRelayFight: cwsRolls must be a function');
  // STAGE 3.7d: the fight owns the target's live spell state (the target clone of simulateFight.js:313-315), so a
  // batch's trials cannot inherit an entry. The caller's object keeps its own effects, and `target` in the result stays
  // the caller's.
  const baseTarget = target;
  const fightTarget = baseTarget
    ? { ...baseTarget, activeEffects: (baseTarget.activeEffects ?? []).map((a) => ({ ...a })) }
    : null;
  // The boss's traits for a SPELL, read as a blow reads them (`scenario.traits ?? target.bossTraits`, blowOutcomes.js). A
  // relay body's element-proof trait cuts a Cast When Strikes cast and each carried round
  // (vendor:scenes/gate/standInSpell.js:51-58, :204-205; test/standInSpellDifferential.test.js).
  const bossTraits = scenario.traits ?? fightTarget?.bossTraits ?? [];
  const standard = scenario.standard;
  const strikeItems = [probe.weapon?.item, probe.offHand?.weapon?.item].filter(Boolean);
  const castsCws = strikeItems.some((it) => cwsRows(it, standard).length > 0);
  const cwsPower = castsCws
    ? spellPowerInputs(ch, {
      potencyPct: scenario.potencyPct, pierce: scenario.pierce,
      worn: equippedForFight(ch, [probe.weapon?.item ?? null, probe.offHand?.weapon?.item ?? null]),
    })
    : { potencyPct: 0, pierce: 0 };
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
  // The carried stream's per-fight remainders (scenario `carry: true`): one state per fight (ASSUMPTION M43).
  const carryState = scenario.carry === true ? createCarryState() : null;
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
  let wardedAttacks = 0;
  let zeroDamage = 0;
  let roundedZero = 0;
  let flowBuilds = 0;
  let lastAttackAt = 0;
  let termination = 'schedule';
  let eventIndex = 0;
  let next = provided ? null : schedule.next();
  // STAGE 3.7e: the claims and their proceeds by kind ('blow' | 'proc' | 'dot'), and who made the kill. Every claim goes
  // through `send`, so these always add up to the engine's own counters.
  const claimsByKind = { blow: 0, proc: 0, dot: 0 };
  const dealtByKind = { blow: 0, proc: 0, dot: 0 };
  const clippedByKind = { blow: 0, proc: 0, dot: 0 };
  let killSource = null;
  let lastBilledAt = 0;
  const claimLog = scenario.trace === true ? [] : null;
  /** One claim at the host's wire boundary (round, then drop under 1: gateCourt.js:1164-1165@a3eb1605). */
  const send = (t, kind, damage, hand = null) => {
    const claim = Math.round(damage);
    if (!(claim >= 1)) return null;
    const result = engine.claim({ t, damage: claim });
    claimsByKind[kind] += 1;
    dealtByKind[kind] += result.got;
    clippedByKind[kind] += result.clipped;
    lastBilledAt = Math.max(lastBilledAt, t);
    if (claimLog) {
      claimLog.push({
        t, kind, hand, claim, got: result.got, accepted: result.accepted, reason: result.reason,
        clipped: result.clipped, bucket: result.bucketAfter, tokens: result.tokensAfter, hp: result.hpAfter,
      });
    }
    if (engine.killed && killSource === null) killSource = kind === 'proc' ? 'cws' : kind;
    return { claim, result };
  };
  // STAGE 3.7d, the round clock: rounds at k x MAGIC_ROUND_SECONDS from t=0 (M35), billed AFTER the blow at an equal
  // timestamp. A turned round still ticks and counts down (standInSpell.js:137-150,219-236@a3eb1605). The clock and
  // the drain run only when the fight can hold an entry - it casts, or the caller's target arrived with a live
  // continuousDamage entry (the target's own state, cloned like the ordinary fight's, and billed the same way).
  const hasLiveDot = (fightTarget?.activeEffects ?? [])
    .some((a) => a?.kind === 'continuousDamage' && (a.roundsRemaining ?? 0) > 0);
  const holdsEntries = castsCws || hasLiveDot;
  let nextRoundT = MAGIC_ROUND_SECONDS;
  const dotRound = (at) => {
    let total = 0;
    // each tick is resisted by its own element as it lands, then summed (standInSpell.js:51-58 `counting(got, resist)`)
    tickActiveEffects(fightTarget, {
      hurt: (n, info) => { total += Math.max(0, n > 0 ? resistSpell(bossTraits, n, info?.element ?? null) : n); },
    }, cwsRolls);
    if (total > 0 && at >= shieldUntil && !fightTarget.warded) send(at, 'dot', total);
  };
  /** Rounds due at or before `at` (the ones strictly before it ran at the loop's head). True when the boss fell. */
  const roundsAt = (at) => {
    while (holdsEntries && nextRoundT <= at && !engine.killed) { dotRound(nextRoundT); nextRoundT += MAGIC_ROUND_SECONDS; }
    return engine.killed;
  };
  /** Rounds due strictly before `at`: the blow at an equal timestamp lands first (M35). */
  const roundsBefore = (at) => {
    while (holdsEntries && nextRoundT < at && !engine.killed) { dotRound(nextRoundT); nextRoundT += MAGIC_ROUND_SECONDS; }
    return engine.killed;
  };
  for (;;) {
    // The blow budget is checked before the horizon: if both bind, the fight stopped at the last attack, not at a
    // horizon it never reached.
    if (attacks >= maxBlows) { termination = 'maxBlows'; break; }
    const event = provided ? provided[eventIndex] : null;
    if (provided && !event) { termination = 'schedule'; break; }
    if (!provided && !next) { termination = 'schedule'; break; }
    const t = provided ? event.t : next.t;
    if (t > maxSeconds) { termination = 'horizon'; break; }
    // Rounds due strictly before this attack's time; the round at an equal timestamp comes after the blow (M35).
    if (roundsBefore(t) && engine.killed) { termination = 'kill'; break; }
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
      const sampled = dist.sampler.sample(blowStream);
      outcome = dist.tier.carryResolve ? dist.tier.carryResolve(sampled, carryState) : sampled;
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
      roundsAt(t);
      if (engine.killed) { termination = 'kill'; break; }
      if (!provided) next = schedule.next();
      continue;
    }
    // STAGE 3.7d: the Strikes payload runs inside the blow's formula, so the cast's claim lands BEFORE the blow's
    // (formulas.js:826-836; the ordinary fight's order is simulateFight.js:557-562). The cast is one claim - its direct
    // damage and its first round together - and a killing cast suppresses the blow claim. The ward is the relay's own
    // clock (ASSUMPTION M38); nothing sets target.warded here.
    if (castsCws) {
      const rowItem = hand === 'off' ? (probe.offHand?.weapon?.item ?? null) : (probe.weapon?.item ?? null);
      if (cwsEligible({
        target: fightTarget, strikesPositive: outcome.strikesPositive === true, whole: outcome.whole === true, item: rowItem, standard,
      })) {
        for (const row of cwsRows(rowItem, standard)) {
          if (!row.spell || engine.killed) continue;
          let castDamage = 0;
          resolveCwsCast({
            spell: row.spell, caster: { entity: ch }, casterLevel: num(ch.level, 1), target: fightTarget, rolls: cwsRolls,
            pierce: cwsPower.pierce, potencyPct: cwsPower.potencyPct,
            hurt: (n) => { castDamage += n; },
          });
          // the cast's hurts are summed, then the element-proof trait cuts the SUM once; under one point it is sent as
          // it is (standInSpell.js:204-206)
          if (castDamage >= 1) castDamage = resistSpell(bossTraits, castDamage, Number.isInteger(row.spell.element) ? row.spell.element : null);
          if (castDamage > 0) send(t, 'proc', castDamage, hand);
        }
      }
      if (engine.killed) { termination = 'kill'; break; }
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
      roundsAt(t);
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
      roundsAt(t);
      if (engine.killed) { termination = 'kill'; break; }
      if (!provided) next = schedule.next();
      continue;
    }
    // The blow itself goes through `send` like every other claim (3.7e accounting; the boundary is unchanged).
    const { result } = send(t, 'blow', raw, hand);
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
    roundsAt(t);
    if (engine.killed) { termination = 'kill'; break; }
    if (!provided) next = schedule.next();
  }

  // The drain: rounds still due inside the horizon are billed after the loop ends (simulateFight.js:728-731), so a DoT
  // cast on the last blow is still counted and can kill. Guarded like the loop's own clock: no entry can exist otherwise,
  // and it stops as soon as no live entry is left (a no-op pass would claim nothing anyway).
  const liveDot = () => (fightTarget?.activeEffects ?? [])
    .some((a) => a?.kind === 'continuousDamage' && (a.roundsRemaining ?? 0) > 0);
  while (holdsEntries && liveDot() && nextRoundT <= maxSeconds && !engine.killed) {
    dotRound(nextRoundT);
    nextRoundT += MAGIC_ROUND_SECONDS;
  }
  if (engine.killed) termination = 'kill';

  const s = engine.summary();
  // Fight elapsed time is independent of the claim clock: the claim engine only sees positive landed claims. A fight
  // ended by the blow budget or the schedule still ends at the last claim it BILLED (a drained DoT round after the last
  // blow, simulateFight.js:476), not at the last blow.
  const time = s.killed ? s.killedAt
    : termination === 'horizon' ? maxSeconds
      : Math.max(lastAttackAt, lastBilledAt);
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
    claimsByKind,
    dealtByKind,
    clippedByKind,
    killSource: s.killed ? (killSource ?? 'blow') : null,
    claimLog,
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
    // STAGE 3.7e: the claim kinds and the kill source are totals over the batch, never mixed silently into one figure
    // (rule 7). `claimsByKind` sums to `claims`, `dealtByKind` to `damageDealt`, and the kill tally to `kills`.
    claimsByKind: {
      blow: rows.reduce((a, r) => a + (r.claimsByKind?.blow ?? 0), 0),
      proc: rows.reduce((a, r) => a + (r.claimsByKind?.proc ?? 0), 0),
      dot: rows.reduce((a, r) => a + (r.claimsByKind?.dot ?? 0), 0),
    },
    dealtByKind: {
      blow: rows.reduce((a, r) => a + (r.dealtByKind?.blow ?? 0), 0),
      proc: rows.reduce((a, r) => a + (r.dealtByKind?.proc ?? 0), 0),
      dot: rows.reduce((a, r) => a + (r.dealtByKind?.dot ?? 0), 0),
    },
    killSource: {
      blow: rows.filter((r) => r.killSource === 'blow').length,
      cws: rows.filter((r) => r.killSource === 'cws').length,
      dot: rows.filter((r) => r.killSource === 'dot').length,
    },
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
