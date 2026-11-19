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
 * the Sky-ketch and the Abyss all use that body; their BODY is the game's one
 * relay stand-in (world/gate/gateBoss.js bossStandIn) for the content's look -
 * Valkynaz Ruhn's Daedra Lord (31) at the Breach, the Iron Atronach (36) for the
 * Sky-ketch Warden (scenes/ketch/ketchFight.js:57, :348) and the Abyss Remnant
 * (scenes/superDungeon/sdRemnant.js:97, :529). What changes per content is
 * the share a player brings, the phase shields, and the encounter mechanics
 * (the ketch's immune windows, the Abyss's clock puzzle and gold/silver split).
 *
 * The breach and the Sky-ketch Warden are calibrated (the Sky-ketch from a single solo capture); the Abyss carries
 * its known mechanics and is marked `calibrated: false` until the probe measures the windows.
 */
import { bossTarget } from './model.js';
import { ALLOWANCE, BREACH_PHASES, allowanceLaw, allowanceSpec, refOf } from './allowance.js';
import { relayTraitsFor } from './bossTraits.js';


export const BOSS_REF_MAX = ALLOWANCE.refMax;
export const bossRef = refOf;
export const PURSE = Object.freeze({ depthX: ALLOWANCE.depthX, rateX: ALLOWANCE.rateX, hitCapX: ALLOWANCE.hitCapX, hitHz: ALLOWANCE.hitHz });

/** Ref per player at a level: share, purse depth, refill and cap. */
export function purseOf(level) {
  const { ref, depth, rate, cap, hitHz } = allowanceLaw(level);
  return { ref, depth, rate, cap, hitHz };
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
    mobileType: 31,
    phases: BREACH_PHASES,
    immunity: null,
    split: null,
    calibrated: true,
    note: 'Dagon\'s Breach: 240 s share per player, two 3 s phase shields. The capture shows extra warded Ruhn\'s Blade/Flame windows; the model applies only the source\'s 3 s shields.',
  }),
  skyketch: Object.freeze({
    id: 'skyketch',
    name: 'Sky-ketch',
    shareX: 600,
    hpX: 1,
    group: null,
    mobileType: 36,
    phases: null,
    immunity: Object.freeze({
      share: 0.178,
      reasons: Object.freeze(['tuning forks up', 'The Discord']),
    }),
    openingS: 6.6,
    split: null,
    calibrated: true,
    note: 'Sky-ketch: 600 s share per player, the same purse. One solo capture: 6.6 s opening immunity and a 35.2 s The Discord window; the other no-damage gaps are downtime.',
  }),
  abyss: Object.freeze({
    id: 'abyss',
    name: 'Abyss',
    shareX: 240,
    hpX: 1,
    group: null,
    mobileType: 36,
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
export function encounterTarget(id, level, { players = 1, traits = null } = {}) {
  const e = encounterById(id) ?? ENCOUNTERS[DEFAULT_ENCOUNTER];
  const { ref, cap } = purseOf(level);
  const shields = e.phases?.length ?? 0;
  const shieldSeconds = e.phases?.reduce((a, p) => a + (Number(p.shieldS) || 0), 0) ?? 0;
  // The body is the game's relay stand-in for the content's look (model.js bossTarget -> target.js
  // standInTarget: world/gate/gateBoss.js bossStandIn) - its level, skills, armour and metal are the
  // game's, the same constructor for every content; only the mobile differs.
  const t = bossTarget({
    level,
    group: e.group,
    mobileType: e.mobileType,
    spareGear: true,
    health: e.shareX * ref * (e.hpX ?? 1) * Math.max(1, Math.floor(players)),
    // The boss's own traits from the game's selector (systems/bossTraits.js relayBossTraits), keyed by the
    // encounter's identity; an explicit list overrides for experiments.
    traits: traits ?? relayTraitsFor(e.id) ?? [],
    hitCap: cap,
    phaseShields: shields,
    shieldSeconds: shieldSeconds / Math.max(1, shields),
  });
  // The relay's per-player allowance applies to every content that spends the gate's hand and purse.
  t.allowance = allowanceSpec(level, { players, phases: e.phases ?? [], openingS: e.openingS, immunityShare: e.immunity?.share });
  return t;
}
