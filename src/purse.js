/*
 * dfo-dps - the boss purse simulation (encounter wrapper).
 *
 * The law itself - what the relay accepts of a claim - lives in allowance.js,
 * the one implementation shared with the per-hit model (analyze() runs it for
 * every target that declares an allowance). This wrapper only picks the
 * encounter's phases/immunity and applies an imprint's same-hit multiplier and
 * flat addition to the blow's claim.
 *
 * An encounter whose immunity or split timing is not calibrated is returned
 * with `calibrated: false`; the page must not present its TTK as a measurement.
 */
import { encounterById, purseOf } from './encounters.js';
import { allowanceSpec, claimStreams, runAllowance } from './allowance.js';

/**
 * @param {any} base an `analyze()` run against the encounter target
 * @param {string} encounterId
 * @param {{ level?: number, splitPenaltyS?: number, mult?: number, flat?: number }} [opts]
 */
export function simulatePurse(base, encounterId, { level = 45, splitPenaltyS = 0 } = {}) {
  const encounter = encounterById(encounterId);
  if (!encounter) throw new Error(`unknown encounter: ${encounterId}`);
  const { depth, rate, cap, hitHz, ref } = purseOf(level);
  const players = Math.max(1, Math.floor(Number(base?.target?.allowance?.players) || 1));
  const health = (Number(base?.health) || 0) / players;
  const capRun = Number(base?.cap) || 0;
  if (!(health > 0) || !(capRun > 0)) return null;

  const ward = Number(base?.ward) || 0;
  const streams = claimStreams({
    cappedPerSwing: base?.cappedPerSwing,
    hit: base?.hit?.hit,
    aps: base?.cadence?.aps,
    procs: base?.enchantProcs,
    cap: capRun,
  });
  if (!streams.length) return null;

  const spec = allowanceSpec(level, {
    phases: encounter.phases ?? [],
    openingS: encounter.openingS,
    immunityShare: encounter.immunity?.share,
  });
  const run = runAllowance({ level, share: health + ward / players, spec, streams, splitPenaltyS });
  if (!run) return null;

  return {
    encounter: encounter.id,
    calibrated: !!encounter.calibrated,
    ttk: run.ttk,
    burst5: run.burst5,
    burst5Dps: run.burst5Dps,
    averageDps: run.averageDps,
    sustainedDps: run.sustainedDps,
    ceilingDps: run.ceilingDps,
    saturated: run.saturated,
    landedShare: run.landedShare,
    hits: run.claimsAccepted,
    claimed: run.claimed,
    landed: run.landed,
    cap: capRun,
    purseDepth: depth,
    purseRate: rate,
    hitHz,
    ref,
    immunityShare: run.immunityShare,
    openingS: run.openingS,
    splitPenaltyS: run.splitPenaltyS,
    phases: (encounter.phases ?? []).length,
  };
}
