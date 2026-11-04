/*
 * dfo-dps - the boss encounters' damage purses.
 *
 * The purse is the boss body's own law, not a modifier:
 *   depth  15 x reference damage
 *   refill  3 x reference damage a second
 *   cap    12 x reference damage per blow
 *   tokens  4 blows a second (four in hand, four a second back)
 *
 * The reference is `5 + level` (net/gate/gateBrain.js dpsRef). The breach,
 * the Sky-ketch and the Abyss all use that body; what changes per content is
 * the share a player brings, the phase shields, and the encounter mechanics
 * (the ketch's immune windows, the Abyss's clock puzzle and gold/silver split).
 *
 * Only the breach is calibrated. The other two carry their known mechanics
 * and are marked `calibrated: false` until the probe measures the windows.
 */
import { bossTarget } from './model.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const BOSS_REF_MAX = 60;
export const bossRef = (level) => 5 + clamp(Math.floor(Number(level) || 1), 1, BOSS_REF_MAX);
export const PURSE = Object.freeze({ depthX: 15, rateX: 3, hitCapX: 12, hitHz: 4 });

/** Ref per player at a level: share, purse depth, refill and cap. */
export function purseOf(level) {
  const ref = bossRef(level);
  return {
    ref,
    depth: PURSE.depthX * ref,
    rate: PURSE.rateX * ref,
    cap: PURSE.hitCapX * ref,
    hitHz: PURSE.hitHz,
  };
}

/**
 * The online boss contents. Names are content names, never boss or phase names.
 * `shareX` is the health a player adds: `shareX * ref`.
 *
 * `calibrated: false` means the purse is known but the encounter's immunity or
 * split timing is not; the page must say so rather than invent a TTK.
 */
export const ENCOUNTERS = Object.freeze({
  breach: Object.freeze({
    id: 'breach',
    name: 'Breach',
    shareX: 240,
    hpX: 1,
    group: 'daedra',
    armorValue: 12,
    phases: Object.freeze([
      Object.freeze({ at: 0.66, shieldS: 3 }),
      Object.freeze({ at: 0.33, shieldS: 3 }),
    ]),
    immunity: null,
    split: null,
    calibrated: true,
    note: 'Dagon\'s Breach: 240 s share per player, two 3 s phase shields.',
  }),
  skyketch: Object.freeze({
    id: 'skyketch',
    name: 'Sky-ketch',
    shareX: 600,
    hpX: 1,
    group: null,
    armorValue: 0,
    phases: null,
    immunity: Object.freeze({
      share: null,
      reasons: Object.freeze(['tuning forks up', 'a second mechanic']),
    }),
    split: null,
    calibrated: false,
    note: 'Sky-ketch: 600 s share per player, the same purse; the boss is immune while the tuning forks are up and during one other mechanic, and it has phases.',
  }),
  abyss: Object.freeze({
    id: 'abyss',
    name: 'Abyss',
    shareX: 240,
    hpX: 1,
    group: null,
    armorValue: 0,
    phases: null,
    immunity: null,
    split: Object.freeze({
      targets: Object.freeze(['gold', 'silver']),
      windowS: null,
      at: null,
    }),
    calibrated: false,
    note: 'Abyss: the clock puzzle gates access; the brass boss has phases, one of which splits it into gold and silver, and both must die close in time. The share is the shared body\'s 240 x ref, still to be confirmed for this boss.',
  }),
});

export const ENCOUNTER_IDS = Object.freeze(Object.keys(ENCOUNTERS));
export const encounterById = (id) => ENCOUNTERS[String(id ?? '').toLowerCase()] ?? null;
export const DEFAULT_ENCOUNTER = 'breach';

/** The boss target for one player of an encounter, with the purse's cap. */
export function encounterTarget(id, level, { players = 1, traits = [] } = {}) {
  const e = encounterById(id) ?? ENCOUNTERS[DEFAULT_ENCOUNTER];
  const { ref, cap } = purseOf(level);
  const shields = e.phases?.length ?? 0;
  const shieldSeconds = e.phases?.reduce((a, p) => a + (Number(p.shieldS) || 0), 0) ?? 0;
  return bossTarget({
    level,
    armorValue: e.armorValue,
    group: e.group,
    health: e.shareX * ref * (e.hpX ?? 1) * Math.max(1, Math.floor(players)),
    traits,
    hitCap: cap,
    phaseShields: shields,
    shieldSeconds: shieldSeconds / Math.max(1, shields),
  });
}
