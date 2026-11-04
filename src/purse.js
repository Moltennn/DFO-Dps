/*
 * dfo-dps - the boss purse simulation.
 *
 * A blow is claimed, then the boss body takes it only as far as
 *   min(blow, hit cap, purse, remaining health)
 * and the purse refills at `rate` while the account may land at most `hitHz`
 * blows a second (a token bucket: four in hand, four a second back).
 *
 * The simulation is per player. Phase shields pause damage while the purse
 * refills. An encounter whose immunity or split timing is not calibrated is
 * returned with `calibrated: false`; the page must not present its TTK as a
 * measurement.
 */
import { encounterById, purseOf } from './encounters.js';

/**
 * @param {any} base an `analyze()` run against the encounter target
 * @param {string} encounterId
 * @param {{ level?: number, maxSeconds?: number, splitPenaltyS?: number }} [opts]
 */
export function simulatePurse(base, encounterId, { level = 45, maxSeconds = 3600, splitPenaltyS = 0, mult = 1, flat = 0 } = {}) {
  const encounter = encounterById(encounterId);
  if (!encounter) throw new Error(`unknown encounter: ${encounterId}`);
  const { depth, rate, cap, hitHz, ref } = purseOf(level);
  const health = Number(base?.health) || 0;
  const capRun = Number(base?.cap) || 0;
  if (!(health > 0) || !(capRun > 0)) return null;

  const ward = Number(base?.ward) || 0;
  const total = health + ward;
  const hit = Math.max(0, Math.min(1, Number(base?.hit?.hit) || 0));
  const aps = Number(base?.cadence?.aps) || 0;
  const perSwing = Number(base?.cappedPerSwing) || 0;
  if (!(aps > 0) || !(perSwing > 0)) return null;

  // A landed blow is the swing's capped damage without the miss chance; the
  // imprint's same-hit multiplier and flat addition ride the blow.
  const perBlow = hit > 0 ? (perSwing * mult) / hit + flat : 0;
  const blowInterval = hit > 0 ? 1 / (aps * hit) : Infinity;
  if (!(perBlow > 0) || !Number.isFinite(blowInterval)) return null;

  const phases = [...(encounter.phases ?? [])].sort((a, b) => b.at - a.at);
  const immunityShare = encounter.immunity?.share;
  const calibrated = !!encounter.calibrated;

  let t = 0;
  let hp = total;
  let bucket = depth;
  let bucketAt = 0;
  let tokens = hitHz;
  let rateAt = 0;
  let shieldUntil = 0;
  let phaseAt = 0;
  let claimed = 0;
  let landed = 0;
  let hits = 0;
  let burst5 = 0;

  while (hp > 1e-9 && t < maxSeconds) {
    t += blowInterval;
    bucket = Math.min(depth, bucket + Math.max(0, t - bucketAt) * rate);
    bucketAt = t;
    tokens = Math.min(hitHz, tokens + Math.max(0, t - rateAt) * hitHz);
    rateAt = t;
    if (t <= shieldUntil) continue; // the phase shield, no damage claim lands
    if (tokens < 1) continue; // the account's blow limit drops this one
    tokens -= 1;
    claimed += perBlow;
    const got = Math.max(0, Math.min(perBlow, capRun, bucket, hp));
    bucket -= got;
    hp -= got;
    landed += got;
    hits += 1;
    if (t <= 5) burst5 += got;
    while (phaseAt < phases.length && hp <= total * phases[phaseAt].at) {
      shieldUntil = Math.max(shieldUntil, t + (Number(phases[phaseAt].shieldS) || 0));
      phaseAt += 1;
    }
  }

  // An uncalibrated immunity is a share of the fight in which nothing lands.
  const immune = Number.isFinite(immunityShare) ? Math.max(0, Math.min(0.95, immunityShare)) : 0;
  const ttk = t / Math.max(1e-9, 1 - immune) + Math.max(0, splitPenaltyS);
  const sustainedDps = ttk > 0 ? landed / ttk : 0;
  return {
    encounter: encounter.id,
    calibrated,
    ttk,
    burst5,
    sustainedDps,
    landedShare: claimed > 0 ? landed / claimed : 0,
    hits,
    claimed,
    landed,
    cap: capRun,
    purseDepth: depth,
    purseRate: rate,
    hitHz,
    ref,
    immunityShare: immune,
    splitPenaltyS,
    phases: phases.length,
  };
}
