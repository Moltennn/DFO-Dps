/*
 * dfo-dps - the relay's claim engine (Stage 3.3): one ordered claim at a time.
 *
 * The law is vendored, not re-derived (vendor/upstream/a3eb1605/src/net/gate/gateBrain.js):
 *
 *   joinFight :1213  a joining player gets `bucket = 15 x ref` (empty on a wounded boss) and `rate = 4` tokens.
 *   applyHit  :1298  refuses a non-finite or non-positive claim outright; refuses while the boss is shielded; then
 *                    `spendBlow` charges ONE token (a four-token bucket, refilled at four a second - :3411); then the
 *                    damage purse refills at `3 x ref` a second to `15 x ref` and pays
 *                        got = max(0, min(claim, 12 x ref, bucket, boss health))
 *                    The excess is CLIPPED and discarded (:1329-1336), never deferred. `ref = 5 + level`.
 *
 * `spendBlow` refills its token bucket BEFORE the check and updates its clock even when the claim is refused; the
 * bucket itself is refilled only after a token is spent. This engine keeps that order, so its stored `tokens` and
 * `bucket` are the game's after every claim, including a refused one. It does not refill either clock for a claim the
 * game refuses before `spendBlow` (invalid damage, shielded, dead).
 *
 * NOT in this engine, because the per-hit model has no geometry or host state: the pose/floor/court/reach test, the
 * Sundered halves, the stun/profile hit multiplier, `restoreShare`, the Wrath clock and the `spendBlow` multi-body
 * sequence. They are documented in the assumptions register M30. `claim` is the final damage the host would present; one
 * claim spends one token. The phase-ward lifecycle is not scheduled here: a caller may declare a fixed `shieldUntil`
 * (seconds), and a claim at exactly that time is accepted (`now < shieldUntil` refuses, :1308).
 *
 * Nothing is rounded: the game's bucket and token arithmetic is floating point, and `got` is the game's own min().
 * The engine stores no claim history: it returns one result per call and keeps counters plus current state.
 */
import { allowanceLaw } from './allowance.js';

const KILL_EPS = 1e-6; // gateBrain.js:1344 `f.hp <= 1e-6` falls

const positive = (v) => Number.isFinite(v) && v > 0;

/**
 * A streaming relay allowance for one player.
 *
 * @param {object} o
 * @param {number} [o.level=1] the player's level (`dpsRef` clamps it to 1..60)
 * @param {number} o.share the player's share of the boss's health (the pool this engine empties)
 * @param {object} [o.law] an explicit `allowanceLaw` result (tests/what-ifs); defaults to `allowanceLaw(level)`
 * @param {boolean} [o.fresh=true] false: joined a wounded boss, so the damage bucket starts empty (:1231-1240)
 * @param {number} [o.shieldUntil=0] seconds; claims before it are refused without spending a token
 */
export function createRelayClaimEngine({ level = 1, share, law = null, fresh = true, shieldUntil = 0 } = {}) {
  if (!positive(share)) throw new TypeError('relayClaim: share must be a positive finite number');
  const L = law ?? allowanceLaw(level);
  for (const key of ['depth', 'rate', 'cap', 'hitHz']) {
    if (!positive(L[key])) throw new TypeError(`relayClaim: law.${key} must be a positive finite number`);
  }
  const initialShare = share;
  const state = {
    level: L.ref != null ? L.ref - 5 : level,
    law: L,
    share: initialShare,
    hp: initialShare,
    bucket: fresh ? L.depth : 0,
    bucketAt: 0,
    tokens: L.hitHz,
    tokenAt: 0,
    shieldUntil: Math.max(0, Number(shieldUntil) || 0),
    time: 0,
    killed: false,
    killedAt: null,
    claims: 0,
    accepted: 0,
    refused: 0,
    invalid: 0,
    dead: 0,
    shielded: 0,
    noToken: 0,
    empty: 0,
    offered: 0,
    dealt: 0,
    clipped: 0,
    capClip: 0,
    bucketClip: 0,
    healthClip: 0,
    bucketLimited: 0,
    tokenLimited: 0,
    dryAt: null,
    firstAcceptedAt: null,
    lastClaimAt: null,
  };

  const refused = (result, reason) => {
    state.claims += 1;
    state.refused += 1;
    state[reason] += 1;
    result.refused = true;
    result.reason = reason;
    result.tokensAfter = state.tokens;
    result.bucketAfter = state.bucket;
    result.hpAfter = state.hp;
    result.clippedAfter = state.clipped;
    result.dealtAfter = state.dealt;
    result.killed = false;
    result.dead = state.killed;
    return result;
  };

  /**
   * One claim. `{t, damage}` (or `{t, d}`) with `t` in seconds, non-decreasing.
   * @returns {object} the per-claim result; the engine's state is updated in place.
   */
  function claim(event) {
    const t = typeof event === 'object' && event !== null ? Number(event.t) : Number(event);
    const raw = typeof event === 'object' && event !== null
      ? (event.damage !== undefined ? event.damage : event.d)
      : arguments[1];
    if (!Number.isFinite(t)) throw new TypeError('relayClaim: t must be a finite number of seconds');
    if (t < state.time) throw new RangeError(`relayClaim: claims must be in non-decreasing time order (${t} < ${state.time})`);
    state.time = t;
    state.lastClaimAt = t;

    const result = {
      t,
      claim: raw,
      damage: raw,
      accepted: false,
      refused: false,
      reason: null,
      tokenSpent: false,
      want: 0,
      capped: 0,
      got: 0,
      clipped: 0,
      capClip: 0,
      bucketClip: 0,
      healthClip: 0,
      bucketBefore: state.bucket,
      bucketRefilled: state.bucket,
      bucketAfter: state.bucket,
      tokensBefore: state.tokens,
      tokensRefilled: state.tokens,
      tokensAfter: state.tokens,
      hpAfter: state.hp,
      clippedAfter: state.clipped,
      dealtAfter: state.dealt,
      killed: false,
      dead: state.killed,
    };

    // applyHit's first gate: a dead fight, then a claim that is not a positive finite number. Neither touches a clock.
    if (state.killed) return refused(result, 'dead');
    if (!positive(raw)) return refused(result, 'invalid');
    state.offered += raw;
    result.want = raw;

    // ... then the shield (before spendBlow), then spendBlow's token bucket.
    if (t < state.shieldUntil) return refused(result, 'shielded');

    result.tokensBefore = state.tokens;
    state.tokens = Math.min(L.hitHz, state.tokens + Math.max(0, t - state.tokenAt) * L.hitHz);
    state.tokenAt = t;
    result.tokensRefilled = state.tokens;
    if (!(state.tokens >= 1)) {
      state.tokenLimited += 1;
      result.tokensAfter = state.tokens;
      return refused(result, 'noToken');
    }
    state.tokens -= 1;
    result.tokenSpent = true;
    result.tokensAfter = state.tokens;

    // ... then the purse: a 15 x ref bucket, refilled at 3 x ref a second, and the health that stands.
    result.bucketBefore = state.bucket;
    state.bucket = Math.min(L.depth, state.bucket + Math.max(0, t - state.bucketAt) * L.rate);
    state.bucketAt = t;
    result.bucketRefilled = state.bucket;
    result.bucketAfter = state.bucket;

    const capped = Math.min(raw, L.cap);
    const bucketGot = Math.min(capped, state.bucket);
    const got = Math.min(bucketGot, state.hp);
    result.capped = capped;
    result.got = got;
    result.capClip = raw - capped;
    result.bucketClip = capped - bucketGot;
    result.healthClip = bucketGot - got;
    result.clipped = raw - got;
    if (result.bucketClip > 0) {
      state.bucketLimited += 1;
      if (state.dryAt === null) state.dryAt = t;
    }

    state.bucket -= got;
    state.clipped += result.clipped;
    state.capClip += result.capClip;
    state.bucketClip += result.bucketClip;
    state.healthClip += result.healthClip;
    result.bucketAfter = state.bucket;

    if (got > 0) {
      state.accepted += 1;
      state.dealt += got;
      if (state.firstAcceptedAt === null) state.firstAcceptedAt = t;
      state.hp = Math.max(0, state.hp - got);
      if (state.hp <= KILL_EPS) {
        state.hp = 0;
        state.killed = true;
        state.killedAt = t;
        result.killed = true;
      }
      result.accepted = true;
      result.reason = result.clipped > 0 ? 'accepted-clipped' : 'accepted';
    } else {
      state.empty += 1;
      state.refused += 1;
      result.refused = true;
      result.reason = 'empty';
    }
    result.clippedAfter = state.clipped;
    result.dealtAfter = state.dealt;
    result.hpAfter = state.hp;
    result.dead = state.killed;
    state.claims += 1;
    return result;
  }

  /** The counters and current state; no claim history. */
  function summary() {
    const secs = state.time;
    return {
      level: state.level,
      ref: L.ref,
      share: initialShare,
      hp: state.hp,
      remainingShare: initialShare > 0 ? state.hp / initialShare : 0,
      killed: state.killed,
      killedAt: state.killedAt,
      time: secs,
      claims: state.claims,
      accepted: state.accepted,
      refused: state.refused,
      invalid: state.invalid,
      dead: state.dead,
      shielded: state.shielded,
      noToken: state.noToken,
      empty: state.empty,
      offered: state.offered,
      dealt: state.dealt,
      clipped: state.clipped,
      refusedOffer: Math.max(0, state.offered - state.dealt - state.clipped),
      capClip: state.capClip,
      bucketClip: state.bucketClip,
      healthClip: state.healthClip,
      landedShare: state.offered > 0 ? state.dealt / state.offered : 0,
      saturated: state.bucketLimited > 0,
      bucketLimited: state.bucketLimited,
      tokenLimited: state.tokenLimited,
      dryAt: state.dryAt,
      bucket: state.bucket,
      bucketAt: state.bucketAt,
      bucketCapacity: L.depth,
      bucketRate: L.rate,
      tokens: state.tokens,
      tokenAt: state.tokenAt,
      tokenCapacity: L.hitHz,
      tokenRate: L.hitHz,
      cap: L.cap,
      shieldUntil: state.shieldUntil,
      acceptedDps: secs > 0 ? state.dealt / secs : null,
      offeredDps: secs > 0 ? state.offered / secs : null,
      killDps: state.killed && state.killedAt > 0 ? initialShare / state.killedAt : null,
      firstAcceptedAt: state.firstAcceptedAt,
      lastClaimAt: state.lastClaimAt,
    };
  }

  return {
    claim,
    summary,
    get level() { return state.level; },
    get law() { return L; },
    get share() { return initialShare; },
    get hp() { return state.hp; },
    get bucket() { return state.bucket; },
    get tokens() { return state.tokens; },
    get killed() { return state.killed; },
    get killedAt() { return state.killedAt; },
    get time() { return state.time; },
    get shieldUntil() { return state.shieldUntil; },
  };
}
