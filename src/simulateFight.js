/*
 * dfo-dps - seeded ordinary fight simulation (Stage 3.2 and later).
 *
 * A fight is a sequence of sampled blows from the Stage 3.1 fight-tier distribution. There is NO second damage formula:
 * each blow is one draw from `blowFightTier` (src/blowOutcomes.js), built with the same `analyze`/`hitModel`/`damageModel`
 * pipeline. The target's health at the moment of the blow selects the distribution: a health-dependent term (axe/blunt
 * mastery at half, venom at half, execute below its threshold) changes the distribution, so a new sampling table is built
 * when the remaining pool crosses one of `healthThresholds`.
 *
 * Scheduling (the model's assumptions are explicit in `assumptions`):
 *
 *   single melee   the attack starts at t=0; the hit lands at HIT_FRAME_MELEE x tick, then one swing every
 *                  `cadence.seconds` (five ticks). The existing `analyze` cadence is the interval.
 *   single ranged  the first hit is one frame into the cycle (`cadence.tick`) and the cycle is
 *                  `cadence.seconds`; the bow/gun host's first-hit frame is not exposed by the analytical cadence.
 *   dual wield     a fresh lead opens (five ticks, hit on frame 2), then the flurry exchange from `dualSchedule`:
 *                  lead (four ticks, hit one tick in), off (four ticks plus the off hand's held burden, hit one tick in).
 *                  This is the sched/order the model already uses for dual DPS; `dualSchedule` is the source.
 *
 * `simulateFight` is one seeded fight. `simulateFights` runs trials and reports the distribution. `simulatePairedFights`
 * runs several builds on the SAME seed list, which is the form a comparison should use. A Pistolet pair is refused:
 * its own machine and reload law are not part of this stage.
 *
 * Cast When Strikes direct damage (Stage 3.5.1) and supported Continuous Damage (Stage 3.6b) are sampled on an ordinary
 * foe from their own injectable stream. Cast-time damage resolves before the melee blow and later rounds tick on the
 * fight clock. A CWS fight takes no per-hit cap and no scenario boss traits (a melee-only fight supports both).
 *
 * Durability is opt-in (`durability: true`, Stage 3.5.2): ordinary weapon wear (the core's `damageEquipment`), the Cast
 * When Strikes condition bill, the break/unequip leaf and the surviving hand's promotion are modelled. The default
 * (`durability` false or omitted) keeps the Stage 3.1-3.5.1 no-wear path unchanged. Relay durability is NOT modelled:
 * this ordinary simulator refuses relay targets outright, and `simulateRelayFight` rejects `durability: true`
 * (Stage 3.5.3g).
 *
 * Excluded: relay bucket/token/claim and relay durability, other spell families, dynamic Flow stack increments,
 * ward lifecycle, ranged support, incoming damage, attacker health/death and pair support. The simulation does not
 * pretend those are present.
 */
import { analyze, conditionMultiplier, createCarryState, weaponOf, weaponPowers } from './model.js';
import { blowFightTier, createBlowSampler } from './blowOutcomes.js';
import { cwsEligible, cwsRows, equipTableForFight, equippedForFight, resolveCwsCast, spellPowerInputs, tickActiveEffects } from './cws.js';
import { MAGIC_ROUND_SECONDS } from './spells.js';
import { createRng } from './rng.js';
import { blowWear, cloneItem, conditionPct, cwsBill, makeOwner, wearItem } from './durability.js';
import { healthThresholds } from './fight.js';
import { DUAL, FLURRY_TICKS, offHandHold } from './dualWield.js';
import {
  HIT_FRAME_MELEE, HIT_FRAME_BOW, BOW_DRAWN_HOLD_FRAME, CLASSIC_UPDATE_INTERVAL, MELEE_NUM_FRAMES,
} from '../vendor/upstream/a3eb1605/src/characters/weaponStates.js';
import { EQUIP_SLOTS } from '../vendor/upstream/a3eb1605/src/characters/paperdoll/paperdoll.js';
import { powerIdsOf } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const popcount = (n) => { let c = 0; for (let v = n >>> 0; v; v &= v - 1) c += 1; return c; };

/** `with({ imprint })` is the same shorthand `fight()` takes: the power rides the item for the probe and the walk. */
function normalizeScenario(args) {
  const scenario = { ...args };
  if (scenario.imprint) {
    scenario.imprints = [...(scenario.imprints ?? []), scenario.imprint];
    delete scenario.imprint;
  }
  return scenario;
}

/**
 * The scenario keys that ride the ORIGINAL MAIN-HAND item, not the character or the fight. `analyze`'s `with(edit)` prices
 * an imprint / a loot power / Potent Vs on the main-hand weapon (`src/model.js:1010-1022`, `:1055`; the off-hand blow nulls
 * them, `src/blowOutcomes.js:96-99`), and an item that carries one is read by the same code. When that carrier breaks the
 * edits must go with it: upstream's powers and Strikes rows are read from the worn item (`systems/loot/lootPowers.js:244-258`,
 * `:262-268`; `combat/formulas.js:826-833`), and `lowerCondition` takes a broken item out of the equip table
 * (`systems/equip.js:570-608`). Character-level inputs (`potencyPct`, `pierce`, `flowStacks`, the target, the health, the
 * limits, the streams) are not carrier-bound and stay.
 */
const CARRIER_EDIT_KEYS = Object.freeze(['imprints', 'loot', 'potentVs']);
const withoutCarrierEdits = (scenario) => {
  const out = { ...scenario };
  for (const key of CARRIER_EDIT_KEYS) delete out[key];
  return out;
};

/** The first-hit frame of a flurry: the hit frame reached from FLURRY_FROM_FRAME. */
const FLURRY_HIT_FRAME = HIT_FRAME_MELEE - DUAL.FLURRY_FROM_FRAME;
/**
 * The ticks a melee swing still has to run after its hit frame: the strike's last frame is `MELEE_NUM_FRAMES.StrikeDown`
 * and the hit is `HIT_FRAME_MELEE` (`characters/weaponStates.js:226-237`). It is the same for a fresh swing (starts on frame
 * 0) and a flurry blow (starts on frame `DUAL.FLURRY_FROM_FRAME`): both reach the hit frame and end on the same last frame.
 * An off-hand blow adds its held burden on top (`holdTicks`, whole ticks held on the last frame, `machineStep`).
 */
const TAIL_TICKS = MELEE_NUM_FRAMES.StrikeDown - HIT_FRAME_MELEE;
/** The Thunderlock's shot lands on frame 1 (`characters/weaponStates.js:568-570`, the FIELD-GUN7 comment; the full
 *  checkout's `combat/gun/gunFeel.js` says "hit on frame 1", but its vendored binding is an inert stub). */
const GUN_HIT_FRAME = 1;

/**
 * The attack schedule for one build, without sampling. The returned `next()` is a deterministic sequence of
 * `{ t, hand, start, fresh }` hits; `assumptions` says where the timing came from.
 */
export function createAttackSchedule(ch, args = {}) {
  const scenario = normalizeScenario(args);
  if (scenario.pair || ch._pair) throw new Error('simulateFight: Pistolet pair is not supported in Stage 3.2');
  const target = scenario.target ?? null;
  const health = num(scenario.health, num(target?.maxHealth, 0));
  const wantsDual = !!(scenario.dual || ch._dual) && !!ch.offWeapon;
  // A `ch._dual` build is analysed as a pair even when the caller omits `dual`; the probe decides whether the pair is
  // a Pistolet pair (refused) or a melee exchange (supported).
  const probe = analyze(ch, { ...scenario, ...(wantsDual ? { dual: true } : {}), healthShare: 1, health });
  // `analyze` refuses a pair it cannot exchange (a two-handed or gun off hand); the simulator follows the same card
  // rather than alternating hands on a single-weapon analysis.
  const dual = wantsDual && !!probe.offHand && !probe.pair;
  if (wantsDual && probe.pair) throw new Error('simulateFight: Pistolet pair is not supported in Stage 3.2');
  const cad = probe.cadence;
  if (!cad || !(cad.seconds > 0)) return null;
  if (!probe.weapon) {
    throw new Error('simulateFight: fist scheduling is not supported (the unarmed StrikeLeft eight-tick list is not in the analytical cadence)');
  }

  if (!dual) {
    const ranged = !!probe.weapon?.ranged;
    const gun = !!probe.weapon?.gun;
    const bow = ranged && !gun;
    const tick = num(cad.tick, cad.seconds / 5);
    // A melee blow lands on HIT_FRAME_MELEE; a gun on GUN_HIT_FRAME of its own 14 fps clock; a bow looses on
    // HIT_FRAME_BOW of the classic 16 Hz draw clock, from the drawn idle (BOW_DRAWN_HOLD_FRAME) unless BowDrawback is on.
    const hitFrame = gun ? GUN_HIT_FRAME
      : bow ? (scenario.bowDrawback ? HIT_FRAME_BOW : HIT_FRAME_BOW - BOW_DRAWN_HOLD_FRAME)
        : HIT_FRAME_MELEE;
    const clock = bow ? CLASSIC_UPDATE_INTERVAL : tick;
    const first = hitFrame * clock;
    let i = 0;
    return {
      kind: 'single', hand: 'main', probe, target: probe.target, health,
      assumptions: {
        schedule: 'single',
        interval: cad.seconds,
        firstHit: first,
        hitFrame,
        tick: clock,
        ranged,
        bow,
        gun,
        note: gun ? 'the shot lands on its own frame 1'
          : bow ? 'the loose is HIT_FRAME_BOW of the classic draw clock'
            : 'first hit is the melee hit frame',
      },
      next() {
        const t = first + i * cad.seconds;
        i += 1;
        // `tail`: the ticks the swing in flight has left after this hit (melee only; a ranged build never breaks here)
        return { t, hand: 'main', start: t - first, fresh: true, tail: gun || bow ? null : TAIL_TICKS, holdTicks: 0 };
      },
    };
  }

  const mainTick = num(probe.cadence.tick, 0);
  const offTick = num(probe.offHand?.cadence?.tick, mainTick);
  if (!(mainTick > 0) || !(offTick > 0)) return null;
  const mainSeconds = num(probe.cadence.mainSeconds, FLURRY_TICKS * mainTick);
  const offSeconds = num(probe.cadence.offSeconds, FLURRY_TICKS * offTick);
  // the off hand's long-run held burden, in ticks, exactly as analyze's dual arm scheduled it
  const offHandHoldTicks = num(probe.schedule?.hold, Math.max(0, offSeconds / offTick - FLURRY_TICKS));
  let start = 0;
  let hand = 'main';
  let first = true;
  // The off hand pays its burden in WHOLE ticks held at its swing's end and carries the fraction to its next blow
  // (`offHandHold`, combat/twoHands/handsLaw.js:273-278). The schedule's own off blow keeps the averaged hold the exchange
  // is timed with (`offHandHoldTicks`); this integer is what the swing IN FLIGHT still owes if its weapon breaks at the hit.
  // `probe.schedule.hold` is `(min(burden, slowest) - 1) x FLURRY_TICKS`, so the burden it was built from is recovered
  // exactly and the same vendored function takes the carry.
  const burden = 1 + offHandHoldTicks / FLURRY_TICKS;
  let carry = 0;
  return {
    kind: 'dual', probe, target: probe.target, health,
    assumptions: {
      schedule: 'dual',
      mainTick, offTick, mainSeconds, offSeconds, offHandHoldTicks,
      firstLead: 5 * mainTick,
      flurryLead: mainSeconds,
      firstHit: `fresh lead at ${HIT_FRAME_MELEE} ticks; flurry hit at ${FLURRY_HIT_FRAME} tick`,
      note: 'fresh lead, then lead/off flurries with the off hand burden',
    },
    next() {
      if (hand === 'main') {
        const hit = start + (first ? HIT_FRAME_MELEE * mainTick : FLURRY_HIT_FRAME * mainTick);
        const duration = first ? 5 * mainTick : mainSeconds;
        const ev = { t: hit, hand: 'main', start, fresh: first, tail: TAIL_TICKS, holdTicks: 0 };
        start += duration;
        first = false;
        hand = 'off';
        return ev;
      }
      const hit = start + FLURRY_HIT_FRAME * offTick;
      const owed = offHandHold({ burden, ticks: FLURRY_TICKS, tick: offTick, carry });
      carry = owed.carry;
      const ev = { t: hit, hand: 'off', start, fresh: false, tail: TAIL_TICKS, holdTicks: owed.hold };
      start += offSeconds;
      hand = 'main';
      return ev;
    },
  };
}

/**
 * The health segment a pool share sits in. `healthThresholds` returns the bounds DESCENDING (1, 0.5, ..., 0).
 * A share exactly ON a threshold takes the segment above it: every health term upstream reads is a strict `<`
 * (axe/blunt mastery's halves, venom, execute) or blunt's `>=`, and at equality all of them read the not-below side.
 */
export function healthSegment(bounds, share) {
  for (let i = 0; i < bounds.length - 1; i++) if (share >= bounds[i + 1]) return i;
  return bounds.length - 2;
}

/**
 * The fight's own copies of the item state a wear/bill/break can mutate: the worn list, the two hand items and the
 * wraps. The caller's character and items are never touched. The synthetic `owner` is what upstream's `lowerCondition`
 * walks (the equip table and `owner.weapon`), so the break leaf is the game's own.
 */
function prepareDurability(ch, scenario) {
  const originals = Array.isArray(ch.worn) ? ch.worn.filter(Boolean) : [];
  const worn = originals.map(cloneItem);
  const byOriginal = new Map(originals.map((it, i) => [it, worn[i]]));
  const cloneRef = (it) => (it == null ? null : (byOriginal.get(it) ?? cloneItem(it)));
  const weaponItem = scenario.weapon && typeof scenario.weapon === 'object' ? scenario.weapon.item : null;
  const main = scenario.weapon !== undefined
    ? (weaponItem ? cloneRef(weaponItem) : cloneRef(scenario.weapon))
    : cloneRef(ch.weapon);
  const off = cloneRef(ch.offWeapon);
  // The fight's hand items carry the hand slot they occupy, so the full table's entries and `lowerCondition`'s item are
  // the same objects; a break can then remove exactly that item.
  if (main) main.equipSlot = EQUIP_SLOTS.RightHand;
  if (off) off.equipSlot = EQUIP_SLOTS.LeftHand;
  const fightCh = { ...ch, worn, weapon: main, offWeapon: off, wraps: cloneRef(ch.wraps) };
  const fightScenario = scenario.weapon !== undefined
    ? { ...scenario, weapon: (weaponItem ? { ...scenario.weapon, item: main } : scenario.weapon) }
    : { ...scenario };
  const owner = makeOwner(main, off);
  // An item SUPPLIED at 0 condition is already broken: nothing transitions when it is worn again, so it is not a weapon lost
  // in this fight (`weaponsBroken` counts transitions) and the break `lowerCondition` reports for it is a repeat.
  const suppliedBroken = new Set([main, off].filter((it) => it && (it.maxCondition ?? 0) > 0 && Number.isFinite(it.currentCondition) && it.currentCondition <= 0));
  return { ch: fightCh, scenario: fightScenario, owner, main, off, suppliedBroken, effective: null, breaks: [], wear: 0, endedByBreak: false };
}

/**
 * The blow-tier tables a BATCH (`simulateFights`) may share across its trials. A tier is a pure function of the build,
 * the scenario, the health segment, the hand and the item's condition band; the seed enters only at draw time
 * (`createBlowSampler`), so rebuilding the same table for every seed is pure setup cost. `simulateFight` keeps its own
 * cache when called standalone, so nothing is shared outside one `simulateFights` call.
 *
 * `idOf` is item IDENTITY (weak), never a per-fight ordinal: a durability fight clones its items, and identity keeps
 * two fights' copies apart rather than letting a clone inherit another clone's table.
 */
export function createTierCache() {
  const tiers = new Map();
  const itemIds = new WeakMap();
  let nextItemId = 1;
  return {
    tiers,
    idOf(item) {
      if (!item) return 0;
      let id = itemIds.get(item);
      if (!id) { id = nextItemId; nextItemId += 1; itemIds.set(item, id); }
      return id;
    },
  };
}

/** One seeded battle. The result is one of the samples `simulateFights` summarises. `seed` defaults to 0, so even an
 *  unseeded call is deterministic. Use `carry: false` for the stateless floor stream. */
export function simulateFight(ch, args = {}) {
  const scenario = normalizeScenario(args);
  scenario.carry ??= true;
  // `_tierCache` is shared by a batch; a standalone call gets its own. Strip the option before calling `blowFightTier`
  // or replaying via `.with()`, whose edits can change the inputs a tier reads.
  const tierCache = scenario._tierCache ?? createTierCache();
  delete scenario._tierCache;
  const withArgs = { ...args };
  delete withArgs._tierCache;
  if (scenario.pair || ch._pair) throw new Error('simulateFight: Pistolet pair is not supported in Stage 3.2');
  // Refuse ranged/gun on either hand before the schedule; a mixed melee + Pistolet pair must not fall through to melee.
  const mainWeapon = scenario.weapon === undefined ? (ch.weapon ? weaponOf(ch.weapon) : null) : scenario.weapon;
  const offWeapon = ch.offWeapon ? weaponOf(ch.offWeapon) : null;
  if (mainWeapon?.ranged || offWeapon?.ranged) {
    throw new Error('simulateFight: bow and gun builds are not supported on either hand');
  }
  // Stage 3.5.2: ordinary durability is an explicit scenario switch. Off (the default) is the Stage 3.1-3.5.1 path,
  // unchanged. On, the fight owns clones of the items and a synthetic equip table (src/durability.js).
  const durability = scenario.durability === true;
  const dur = durability ? prepareDurability(ch, scenario) : null;
  const fightCh = dur ? dur.ch : ch;
  let fightScenario = dur ? dur.scenario : scenario;
  const schedule = createAttackSchedule(fightCh, fightScenario);
  if (!schedule) return null;
  const pool = schedule.health;
  if (!(pool > 0)) return null;
  if (scenario.seed !== undefined && !Number.isSafeInteger(scenario.seed)) {
    throw new TypeError('simulateFight: seed must be a safe integer');
  }
  const seed = Number.isSafeInteger(scenario.seed) ? scenario.seed : 0;
  const rng = createRng(seed);
  const blowStream = rng.stream('blow');
  const cwsStream = rng.stream('cws');
  const conditionStream = durability ? rng.stream('condition') : null;
  const cwsRolls = scenario.cwsRolls === undefined ? () => cwsStream.float() : scenario.cwsRolls;
  if (typeof cwsRolls !== 'function') throw new TypeError('simulateFight: cwsRolls must be a function');
  const conditionRolls = scenario.conditionRolls === undefined
    ? (durability ? () => conditionStream.float() : null)
    : scenario.conditionRolls;
  if (durability && typeof conditionRolls !== 'function') throw new TypeError('simulateFight: conditionRolls must be a function');
  const standard = scenario.standard;
  const baseTarget = schedule.target;
  // The fight OWNS the target's live spell state (Stage 3.6b): `simulateFights` hands every trial the same scenario
  // object, and a Continuous Damage entry left on it would turn the next trial's cast into a renewal (no joined round).
  // The target is cloned per fight, as the durability path clones the items; the caller's object keeps its own effects.
  const target = baseTarget
    ? { ...baseTarget, activeEffects: (baseTarget.activeEffects ?? []).map((a) => ({ ...a })) }
    : null;
  const probe = schedule.probe;
  const strikeItems = [probe.weapon?.item, probe.offHand?.weapon?.item].filter(Boolean);
  // A CWS row can only ride the item that struck: `doItemEnchantmentPayloads(Strikes, item, ...)`
  // (enchantments.js:1031-1072). No CWS row on a striking item means no cast, so no spell-power path is resolved.
  const castsCws = strikeItems.some((it) => cwsRows(it, standard).length > 0);
  // The ordinary-enemy boundary. Upstream sends spareGear/relay bodies to the relay's own spell door
  // (hostEnchant.js:215) and its boss/shield/revenant/bout/companion arms are host additions; this simulator supports a
  // plain ordinary foe only (no `spareGear`, no relay body, no boss traits/caps/phase shields/shield pool, no revenant
  // last stand, no bout/companion). The flags are read by truthiness: the tier reads `!!tgt.relayBody`
  // (blowOutcomes.js:148), so a truthy non-`true` flag must not slip through a `=== true` guard.
  if (target) {
    if (!!target.relayBody || !!target.spareGear) {
      throw new Error('simulateFight: relay stand-ins and spareGear targets are not ordinary targets');
    }
    if (
      !!target.isBoss || (target.bossTraits?.length ?? 0) > 0
      || !!target.phaseShields || target.shieldPool != null
      || target.revenant != null || target.bout != null || target.companion != null
    ) {
      throw new Error('simulateFight: the supported target contract is a plain ordinary foe (no boss traits/caps/phase shields/shield pool/revenant/bout/companion)');
    }
  }
  // A per-hit cap and scenario boss traits are resolved by the MELEE blow only (blowOutcomes.js:111,:138; model.js:1232).
  // A CWS cast would be resolved by the direct-damage path, which knows neither, so the two halves of one fight would
  // follow different rules. Refused rather than silently mixed; without a CWS row both are the Stage 3.2/3.3 melee
  // contract and stay supported.
  if (castsCws) {
    if (!!target?.hitCap) {
      throw new Error('simulateFight: a target per-hit cap is not supported with Cast When Strikes (the cast is not capped)');
    }
    if ((scenario.traits?.length ?? 0) > 0) {
      throw new Error('simulateFight: boss `traits` are not supported with Cast When Strikes (the cast ignores them)');
    }
  }
  // The FULL equip table (before `countedPieces`): what a break rebuilds from. It keeps the hand items, a hand-slot
  // non-weapon (a shield), and every worn piece including a higher-slot copy of a Legendary record the count had
  // hidden. `spellPowerInputs` applies `countedPieces` to the CURRENT table on every read, so the surviving copy and
  // the shield count exactly as upstream's fresh `wornPieces` would.
  let fightTable = null;
  if (durability && Array.isArray(fightCh.worn)) {
    fightTable = equipTableForFight(fightCh, [probe.weapon?.item ?? null, probe.offHand?.weapon?.item ?? null]);
    dur.effective = fightTable;
  }
  let cwsPower = castsCws
    ? spellPowerInputs(fightCh, {
      potencyPct: scenario.potencyPct, pierce: scenario.pierce,
      worn: durability ? fightTable : equippedForFight(fightCh, [probe.weapon?.item ?? null, probe.offHand?.weapon?.item ?? null]),
    })
    : { potencyPct: 0, pierce: 0 };
  let dual = schedule.kind === 'dual';
  let powers = [
    ...weaponPowers(probe.weapon, fightScenario),
    ...(dual && probe.offHand?.weapon ? weaponPowers(probe.offHand.weapon, fightScenario) : []),
  ];
  let bounds = healthThresholds(powers);
  const maxSeconds = num(scenario.maxSeconds, 3600);
  const maxBlows = Math.max(1, Math.floor(num(scenario.maxBlows, 1000000)));
  const damageMode = scenario.damageMode === 'capped' ? 'capped' : 'uncapped';

  const slotItem = (hand) => (dur
    ? (dur.owner.equip.slots[hand === 'off' ? EQUIP_SLOTS.LeftHand : EQUIP_SLOTS.RightHand] ?? null)
    : (hand === 'off' ? (probe.offHand?.weapon?.item ?? null) : (probe.weapon?.item ?? null)));
  // Upstream's spellPowerMult reads the wearer's CURRENT worn powers when the spell resolves (lootPowers.js:747-763), so
  // a break by ordinary wear or by an earlier row's bill must reach the very next cast. Remove exactly the broken item
  // from the full table; everything else stays for the next `countedPieces` read.
  const dropItem = (item) => {
    if (!durability || !fightTable) return;
    fightTable = fightTable.filter((it) => it !== item);
    dur.effective = fightTable;
  };
  const refreshCwsPower = () => {
    if (!castsCws) return;
    cwsPower = spellPowerInputs(fightCh, {
      potencyPct: scenario.potencyPct, pierce: scenario.pierce, worn: fightTable ?? undefined,
    });
  };
  const cache = tierCache.tiers;
  // The carried stream's remainders: one state per fight, reset at its start
  // Keyed per channel and held item inside `weaponBlow`.
  const carryState = scenario.carry === true ? createCarryState() : null;
  // The health thresholds a tier was built under. A break/promotion changes them, and the segment index alone does not
  // say which threshold set it belongs to, so the epoch is part of the key (and a batch's other fights keep theirs).
  let epoch = 0;
  // The live tier for one hand. A wear/bill can cross a condition band, so the cache key carries the item (identity)
  // and the band's damage multiplier; within a band the tier is unchanged (conditionMultiplier, src/model.js:636-666).
  const bandOf = (item) => (durability && item ? conditionMultiplier(weaponOf(item)) : 1);
  const distribution = (index, hand, item, isDual, band) => {
    const key = durability ? `${epoch}|${index}|${hand}|${tierCache.idOf(item)}|${band}` : `${index}|${hand}`;
    let s = cache.get(key);
    if (s) return s;
    const mid = (bounds[index] + bounds[index + 1]) / 2;
    const tier = blowFightTier(fightCh, {
      ...fightScenario, target, health: pool, healthShare: mid, hand,
      ...(isDual && !fightScenario.dual ? { dual: true } : {}),
      ...(durability && hand === 'main' && item ? { weapon: weaponOf(item) } : {}),
    });
    s = { tier, sampler: createBlowSampler(tier), mid, band };
    cache.set(key, s);
    return s;
  };
  // After a break/promotion the surviving hand's powers (and so its health thresholds) are the table's.
  const refresh = () => {
    const main = slotItem('main');
    const off = slotItem('off');
    powers = [
      ...(main ? weaponPowers(weaponOf(main), fightScenario) : []),
      ...(dual && off ? weaponPowers(weaponOf(off), fightScenario) : []),
    ];
    bounds = healthThresholds(powers);
    epoch += 1; // every tier built under the old thresholds is stale; a new epoch keeps the batch's other entries
  };

  let hp = pool;
  let t = 0;
  let blows = 0;
  let dealt = 0;
  let cwsDealt = 0;
  let dotDealt = 0;
  let echoDealt = 0;
  let meleeDealt = 0;
  let cwsCasts = 0;
  let cwsKills = 0;
  let killSource = null;
  let ttk = null;
  const trace = scenario.trace === true ? [] : null;
  const cwsTrace = scenario.trace === true ? [] : null;
  const used = new Map();
  let scheduleNow = schedule;
  let clock = 0;
  let next = scheduleNow.next();
  // Stage 3.6b, the DoT round clock: rounds fall at k * MAGIC_ROUND_SECONDS on the FIGHT clock from t=0. That phase is an
  // ASSUMPTION (the record of this choice is the Stage 3.6 changelog entry) - the cast's own first round is billed
  // inside the cast, at the cast's time. At an
  // equal timestamp the BLOW resolves first and the round after it. A round bills the same
  // health path a cast does, and kills like one.
  let nextRoundT = MAGIC_ROUND_SECONDS;
  let lastHand = 'main'; // the hand a round's reporting segment rides (a round is no hand's blow)
  const tickRound = (at) => {
    tickActiveEffects(target, {
      hurt: (n, info) => {
        if (!(n > 0)) return;
        const shareNow = clamp(hp / pool, 0, 1);
        hp = Math.max(0, hp - n);
        cwsDealt += n;
        dotDealt += n;
        dealt += n;
        // The health segments are the fight's reporting split and must add up to `damageDealt` (objectives.js:103 reads
        // only their count). A round rides the segment it lands in and the hand of the last blow.
        const segIndex = healthSegment(bounds, shareNow);
        const segKey = `${segIndex}|${lastHand}`;
        const seg = used.get(segKey) ?? {
          segment: segIndex, hand: lastHand, share: (bounds[segIndex] + bounds[segIndex + 1]) / 2,
          blows: 0, damage: 0, cwsDamage: 0, echoDamage: 0, wear: 0,
        };
        seg.damage += n;
        seg.cwsDamage += n;
        used.set(segKey, seg);
        cwsTrace?.push({
          t: at, round: true, hand: null, row: null,
          spell: info?.spell ?? null, index: info?.index ?? null,
          damage: n, remaining: hp, kill: hp <= 0,
        });
        if (hp <= 0) { ttk = at; killSource = 'dot'; }
        t = at; // a round that bills is an event: the fight's elapsed time cannot lag it
        return hp > 0;
      },
    }, cwsRolls);
  };
  while (hp > 0 && blows < maxBlows && next && clock + next.t <= maxSeconds) {
    const tNow = clock + next.t;
    // Rounds due strictly before this blow. Equal timestamps are the tie rule's business, below the blow.
    while (nextRoundT < tNow && hp > 0) { tickRound(nextRoundT); nextRoundT += MAGIC_ROUND_SECONDS; }
    if (hp <= 0) break;
    const hand = dual ? next.hand : 'main';
    lastHand = hand;
    const item = slotItem(hand);
    if (durability && !item) { dur.endedByBreak = true; break; }
    const share = clamp(hp / pool, 0, 1);
    const index = healthSegment(bounds, share);
    const band = bandOf(item);
    const dist = distribution(index, hand, item, dual, band);
    const sampled = dist.sampler.sample(blowStream);
    const outcome = dist.tier.carryResolve ? dist.tier.carryResolve(sampled, carryState) : sampled;
    const blowDamage = damageMode === 'capped' ? outcome.claim : outcome.blow; // the host's melee blow
    let echoDamage = num(outcome.echoDamage, 0); // the strike listener's separate hit, before the host's blow
    t = tNow;
    blows += 1;
    // Ordinary wear: damageEquipment at the core's tail, BEFORE the whole draw and the Strikes payload
    // (formulas.js:769, :826-836). The damage is what went through the core (`strikesDamage`), not the post-payload
    // blow; a spareGear target wears nothing; a weapon with no condition to lower cannot break.
    let wear = 0;
    let brokeNow = false;
    if (durability && item && !target?.spareGear && outcome.strikesDamage > 0) {
      wear = blowWear(outcome.strikesDamage, conditionRolls);
      if (wear > 0) {
        const beforeCond = Number.isFinite(item.currentCondition) ? item.currentCondition : (item.maxCondition ?? null);
        const wasBroken = Number.isFinite(item.currentCondition) && item.currentCondition <= 0;
        const broke = wearItem(dur.owner, item, wear, null);
        const applied = beforeCond == null ? wear : Math.max(0, beforeCond - (item.currentCondition ?? 0));
        wear = applied;
        dur.wear += applied;
        if (broke) {
          brokeNow = true;
          dur.breaks.push({ t, hand, reason: 'wear', amount: wear, item: item.name ?? null, ...(wasBroken ? { again: true } : {}) });
          // The CWS payload of this blow resolves after the core's wear: refresh before the first row.
          dropItem(item);
          refreshCwsPower();
        }
      }
    }
    // CWS runs inside the blow's formula, before the strike listener (echo) and the host's melee blow. Its guard is the
    // PRE-payload damage (`strikesPositive`), not the post-Potent-Vs `formulaPositive` Flow/echo read.
    let cwsDamage = 0;
    let cwsCastsThis = 0;
    let cwsKill = false;
    let dotThisBlow = 0;
    let killedByDot = false;
    // A break by a bill AFTER the killing cast (the row walk continues past a kill, see below). It is a break of the
    // item like any other: it counts in `broke`/`breaks` and unequips the weapon before the strike listener, but it is kept
    // apart from `brokeNow` because the fight ends at the kill and never reaches the survivor promotion.
    let brokeAfterKill = false;
    if (cwsEligible({
      target, strikesPositive: outcome.strikesPositive === true, whole: outcome.whole === true, item, standard,
    })) {
      for (const row of cwsRows(item, standard)) {
        let rowBroke = false;
        let cast = null;
        let killed = false;
        // The foe is already dead: upstream's row walk has no death test (`doItemEnchantmentPayloads`, enchantments.js:
        // 1040-1085), and a row's `strikes` returns its 10-point bill whether or not the cast landed (`:585-602`) - but the
        // host's `applySpellToTarget` finds no live foe and returns without casting (`scenes/hostEnchant.js:198-209`,
        // `foes().find((x) => !x.dead && ...)`; no draw, no damage). So a later row is PROCESSED and BILLED but not CAST.
        const afterKill = cwsKill;
        const rowPower = { potencyPct: cwsPower.potencyPct, pierce: cwsPower.pierce };
        if (row.spell && !afterKill) {
          // The sink is the host's landing: later effects still roll, but they stop being counted/applied at death.
          const hurt = (n) => { hp = Math.max(0, hp - n); return hp > 0; };
          cast = resolveCwsCast({
            spell: row.spell, caster: { entity: fightCh }, casterLevel: num(fightCh.level, 1), target, rolls: cwsRolls,
            pierce: cwsPower.pierce, potencyPct: cwsPower.potencyPct, hurt,
          });
          cwsDamage += cast.damage + (cast.dotDamage ?? 0);
          dotThisBlow += cast.dotDamage ?? 0;
          cwsCastsThis += 1;
          killed = hp <= 0;
          if (killed) {
            hp = 0;
            cwsKill = true;
            cwsKills += 1;
            if (cast.dotKill) killedByDot = true;
          }
        }
        // The bill is INSIDE the row's applyResults, immediately after the cast (enchantments.js:1124-1133): it is paid
        // for a resisted, absorbed, deferred or missing-record cast, and a spareGear target zeroes it. The walk
        // continues after a break: upstream's row guard has no condition test, so a later row still casts and pays.
        let bill = 0;
        if (durability) {
          bill = cwsBill(target);
          if (bill > 0) {
            // `lowerCondition` reports a break every time it is applied to an item at 0 (it clamps and says so again), so a bill
            // on an already-broken item is a REPEAT report of the same break, not another weapon lost.
            const wasBroken = Number.isFinite(item.currentCondition) && item.currentCondition <= 0;
            const broke = wearItem(dur.owner, item, bill, null);
            if (broke) {
              if (afterKill) brokeAfterKill = true; else brokeNow = true;
              rowBroke = true;
              dur.breaks.push({
                t, hand, reason: 'cws', amount: bill, item: item.name ?? null,
                ...(afterKill ? { afterKill: true } : {}), ...(wasBroken ? { again: true } : {}),
              });
              // A later row on the same item still runs, but its caster's power is the equipment as it now stands.
              dropItem(item);
              refreshCwsPower();
            }
          }
        }
        cwsTrace?.push({
          t, hand, swing: blows, row: row.param,
          spell: row.spell ? (row.spell.name ?? null) : null,
          index: row.spell ? (row.spell.index ?? null) : null,
          missing: !row.spell,
          casterLevel: num(fightCh.level, 1),
          damage: cast ? cast.damage + (cast.dotDamage ?? 0) : 0,
          ...(cast ? {
            absorbed: cast.absorbed, reflected: cast.reflected, resisted: cast.resisted,
            deferred: cast.deferred, effects: cast.effects, dotDamage: cast.dotDamage ?? 0,
            ...(cast.dotKill ? { dotKill: true } : {}),
          } : {}),
          kill: killed,
          ...(afterKill ? { afterKill: true, cast: false } : {}),
          bill, broke: rowBroke,
          potencyPct: rowPower.potencyPct, pierce: rowPower.pierce,
          condition: durability ? (item?.currentCondition ?? null) : null,
          conditionPct: durability ? conditionPct(item) : null,
        });
        // Durability off: a later row after a kill has no observable effect (no cast, no bill), so the walk stops here exactly
        // as before. Durability on: it continues, because every later row still pays its bill.
        if (killed && !durability) break;
      }
    }
    // Upstream order after the formula: the strike listener's echo lands as its own hit (`hurtFoe`) first; the host's
    // melee blow lands after. A CWS kill (or an echo kill) makes `damageFoe` see `foe.dead`, so the later hit is not
    // applied. The swing still happened, so `blows` and the trace keep it.
    let echoApplied = 0;
    let echoKill = false;
    let meleeDamage = 0;
    // A broken weapon is no longer in wornPowers when the strike listener runs; Flow's current-blow damage was already read
    // before the wear and survives. The listener runs after the whole Strikes payload, so a break by a bill AFTER the killing
    // cast has unequipped the weapon by then too (`brokeAfterKill`; preserved below - the fight ends at the kill).
    //
    // On an ordinary break the echo is not simply "gone": upstream `blowPowers` keeps a worn item's power when its ID is also
    // on the striking weapon (`systems/loot/lootPowers.js:262-268`), so a surviving weapon carrying the SAME echo ID still
    // answers the breaking blow. The tier carries `meta.echoPowers` aligned with `echoMask` (item ID or what-if source); keep
    // only the sampled hits whose ITEM ID the surviving hand also wears. A what-if-only echo is never resurrected.
    let echoSuppressed = false;
    let echoHits = outcome.echoHits;
    if (durability && brokeAfterKill) {
      // preserve the existing post-kill-break behaviour: the weapon is unequipped before the listener and the fight is over
      if (echoDamage > 0) { echoSuppressed = true; echoDamage = 0; }
    } else if (durability && brokeNow) {
      const other = slotItem(hand === 'main' ? 'off' : 'main');
      const otherIds = new Set((other ? powerIdsOf(other) : []).filter((id) => typeof id === 'string'));
      const powers = dist.tier.meta.echoPowers ?? [];
      let eligibleMask = 0;
      for (let i = 0; i < powers.length; i += 1) {
        const p = powers[i];
        if (p?.source === 'item' && p.id && otherIds.has(p.id)) eligibleMask |= 1 << i;
      }
      const perHit = outcome.echoHits > 0 ? outcome.echoDamage / outcome.echoHits : 0;
      const hits = popcount((outcome.echoMask ?? 0) & eligibleMask);
      echoHits = hits;
      echoDamage = hits * perHit;
      echoSuppressed = eligibleMask === 0;
    }
    if (echoSuppressed) echoDamage = 0;
    if (!cwsKill && echoDamage > 0) {
      echoApplied = echoDamage;
      hp = Math.max(0, hp - echoApplied);
      echoKill = hp <= 0;
    }
    if (cwsKill) killSource = killedByDot ? 'dot' : 'cws';
    else if (echoKill) killSource = 'echo';
    if (!cwsKill && !echoKill && blowDamage > 0) {
      meleeDamage = blowDamage;
      hp = Math.max(0, hp - meleeDamage);
    }
    if (hp < 0) hp = 0;
    cwsDealt += cwsDamage;
    dotDealt += dotThisBlow;
    echoDealt += echoApplied;
    meleeDealt += meleeDamage;
    cwsCasts += cwsCastsThis;
    dealt += cwsDamage + echoApplied + meleeDamage;
    const key = `${index}|${hand}`;
    const u = used.get(key) ?? { segment: index, hand, share: dist.mid, blows: 0, damage: 0, cwsDamage: 0, echoDamage: 0, wear: 0 };
    u.blows += 1;
    u.damage += cwsDamage + echoApplied + meleeDamage;
    u.cwsDamage += cwsDamage;
    u.echoDamage += echoApplied;
    u.wear += wear;
    used.set(key, u);
    if (trace) trace.push({
      t, hand, swing: blows, segment: index, share, damage: meleeDamage, blowDamage, echoDamage, echoApplied,
      cwsDamage, cwsCasts: cwsCastsThis, cwsKill, echoKill, meleeApplied: meleeDamage > 0,
      strikesPositive: outcome.strikesPositive === true, strikesDamage: outcome.strikesDamage ?? 0,
      formulaPositive: outcome.formulaPositive === true,
      whole: outcome.whole === true, hit: outcome.hit, crit: outcome.crit,
      blow: outcome.blow, claim: outcome.claim, cappedDamage: outcome.cappedDamage,
      echoHits, remaining: Math.max(0, hp),
      ...(durability ? {
        wear, broke: brokeNow || brokeAfterKill, echoSuppressed,
        condition: item?.currentCondition ?? null,
        conditionPct: conditionPct(item),
        band, tierBand: dist.band,
        equippedAfter: { main: !!dur.owner.equip.slots[EQUIP_SLOTS.RightHand], off: !!dur.owner.equip.slots[EQUIP_SLOTS.LeftHand] },
      } : {}),
    });
    if (hp <= 0) { ttk = t; break; }
    // The round on this blow's own timestamp resolves AFTER the blow (the tie rule) - and only while the foe lives.
    while (nextRoundT <= t && hp > 0) { tickRound(nextRoundT); nextRoundT += MAGIC_ROUND_SECONDS; }
    if (hp <= 0) break;
    if (durability && brokeNow) {
      // Upstream follows the hand that still holds a weapon (playerWeapon.js:443-452): the survivor becomes the lead,
      // and the next swing is a single-weapon swing. With no weapon left the local model has no fist schedule
      // (Stage 3.2 refuses unarmed cadence), so the fight stops at this blow and says so.
      const survivor = slotItem(hand === 'main' ? 'off' : 'main');
      if (!survivor) { dur.endedByBreak = true; break; }
      const owner = dur.owner;
      owner.equip.slots[EQUIP_SLOTS.RightHand] = survivor;
      owner.equip.slots[EQUIP_SLOTS.LeftHand] = null;
      owner.weapon = survivor;
      survivor.equipSlot = EQUIP_SLOTS.RightHand;
      fightCh.weapon = survivor;
      fightCh.offWeapon = null;
      fightCh._dual = false;
      dual = false;
      // The what-if edits (`imprints`, `loot`, `potentVs`) belong to the ORIGINAL main-hand item. They rode the breaking blow
      // (already resolved), and when the main hand is the one that broke they must not move onto the promoted survivor: strip
      // them before the survivor's schedule, tier and thresholds are rebuilt. An off-hand break leaves the main carrier alive,
      // so its edits stay (and the off hand never carried them anyway - blowOutcomes.js:96-99).
      if (hand === 'main') fightScenario = withoutCarrierEdits(fightScenario);
      const single = createAttackSchedule(fightCh, { ...fightScenario, dual: false, weapon: weaponOf(survivor) });
      if (!single) { dur.endedByBreak = true; break; }
      scheduleNow = single;
      // The swing in flight is not cut: upstream's machine keeps stepping it to its last frame (and, for an off-hand blow,
      // through its held burden) before the next strike can begin, and every one of those remaining steps reads the tick of
      // the hand now in use - the survivor's (`swingCtx`/`getMeleeWeaponAnimTime`, playerWeapon.js:838-840, :1123-1140). The
      // next swing is then a fresh single-weapon swing (hands mode Single: `strikeHandOf` -> not a flurry), hit on frame 2.
      clock = t + (next.tail + next.holdTicks) * single.assumptions.tick;
      next = single.next();
      dropItem(item);
      refresh();
      refreshCwsPower();
    } else {
      next = scheduleNow.next();
    }
  }
  // The drain (Stage 3.6b): whichever way the loop ended - the horizon, the blow budget, a break that left no weapon, or
  // a round that never got to run - the rounds still due inside the horizon are billed while the foe lives. A round is
  // not a blow, so the blow budget does not stop it; a DoT that falls after the last blow is counted, and can kill.
  while (hp > 0 && nextRoundT <= maxSeconds) { tickRound(nextRoundT); nextRoundT += MAGIC_ROUND_SECONDS; }
  if (hp < 0) hp = 0;
  const remainingHealth = Math.max(0, hp);
  const kill = ttk !== null;
  // Why this fight stopped - exclusive, in the loop's own priority: a kill, then no weapon left (a break the local model
  // cannot continue past, no fist schedule), then the blow budget, then the time horizon.
  const endReason = kill ? 'kill' : (dur?.endedByBreak ? 'noWeaponLeft' : (blows >= maxBlows ? 'blowBudget' : 'horizon'));
  // Weapons that TRANSITIONED to 0 condition in this fight: at 0 at the end and not supplied at 0. (`endCondition.*.broken`
  // is the other reading, "at 0 at the end", and includes a supplied-broken piece.)
  const weaponsBroken = dur
    ? [dur.main, dur.off].filter((it) => it && !dur.suppliedBroken.has(it) && (it.maxCondition ?? 0) > 0
      && Number.isFinite(it.currentCondition) && it.currentCondition <= 0).length
    : 0;
  if (kill && killSource == null) killSource = 'melee';
  return {
    seed,
    kill,
    killSource: kill ? killSource : null,
    ttk,
    time: t,
    health: pool,
    remainingHealth,
    overkill: Math.max(0, dealt - pool),
    damageDealt: dealt,
    cwsDamage: cwsDealt,
    dotDamage: dotDealt,
    echoDamage: echoDealt,
    meleeDamage: meleeDealt,
    cwsCasts,
    cwsKills,
    cwsCapable: castsCws,
    blows,
    endReason,
    weaponsBroken,
    damageMode,
    outputDps: t > 0 ? dealt / t : null,
    killDps: kill ? pool / ttk : null,
    expectedPerSwing: blows > 0 ? dealt / blows : null,
    segments: [...used.values()].sort((a, b) => b.share - a.share),
    schedule: schedule.assumptions,
    bounds,
    target,
    trace,
    cwsTrace,
    ...(durability ? {
      durability: true,
      condition: { main: dur.main?.currentCondition ?? null, off: dur.off?.currentCondition ?? null },
      conditionPct: { main: conditionPct(dur.main), off: conditionPct(dur.off) },
      breaks: dur.breaks,
      wear: dur.wear,
      endedByBreak: dur.endedByBreak,
    } : { durability: false, condition: null, breaks: [], wear: 0, endedByBreak: false }),
    with: (edit = {}) => simulateFight(ch, { ...withArgs, ...edit }),
  };
}

/** Sample moments. `ttk` is null for no-kill runs and is summarised only over kills. */
export function summarize(values, { p10 = 0.1, p90 = 0.9 } = {}) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const se = n > 1 ? sd / Math.sqrt(n) : 0;
  const at = (q) => xs[Math.min(n - 1, Math.max(0, Math.floor((n - 1) * q)))];
  return {
    n, mean, sd, se, ci95: 1.96 * se, min: xs[0], max: xs[n - 1],
    median: at(0.5), p10: at(p10), p90: at(p90),
  };
}

/** Wilson score interval for a binomial share, the one small-sample interval that stays inside [0, 1]. */
export function wilsonInterval(kills, trials, z = 1.96) {
  if (!(trials > 0)) return null;
  const p = kills / trials;
  const den = 1 + (z * z) / trials;
  const mid = (p + (z * z) / (2 * trials)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / den;
  return { p, lo: Math.min(p, Math.max(0, mid - half)), hi: Math.max(p, Math.min(1, mid + half)), n: trials };
}

/** Deterministic paired seeds: one named stream, independent of the blows. */
export function pairedFightSeeds(count, seed = 0) {
  const n = Math.max(0, Math.floor(num(count, 0)));
  const stream = createRng(Number.isSafeInteger(seed) ? seed : 0).stream('seeds');
  return Array.from({ length: n }, () => Math.floor(stream.float() * 4294967296));
}

/**
 * The durability statistics of a set of `durability: true` fights (Stage 3.5.3b). Every denominator is the number of
 * TRIALS (`rows.length`) unless a field says "conditional".
 *
 *   fightsWithBreak / breakProbability   fights in which at least one weapon broke before the fight ended, over all trials
 *                                        (Wilson interval). A fight that kills first, runs out of horizon or budget first, or
 *                                        loses no weapon is a trial WITHOUT a break; the probability is of breaking within the
 *                                        fight as it was run, not of an item's lifetime.
 *   timeToFirstBreak                     summary of the first break's time over the fights that broke (CONDITIONAL on a break,
 *                                        so biased low as a lifetime). The fights that ended unbroken are right-censored at
 *                                        their own `time`; `timeAtRiskWithoutBreak` summarises those censoring times so the
 *                                        bias is visible.
 *   weaponsBroken                        distinct weapons (the build's main / off item) that reached 0 condition, per fight:
 *                                        `counts[k]` fights lost k, `mean` over all trials.
 *   breakEvents                          the break REPORTS: `distinct` (first break of an item, by `reason`: 'wear' or 'cws'),
 *                                        `afterKill` (a CWS bill paid by a row AFTER the killing cast), `repeats` (a bill on an
 *                                        item already at 0: `lowerCondition` reports it again, no new weapon lost).
 *   noWeaponLeft                         fights stopped because no weapon remained (no fist schedule), over all trials.
 *   endCondition                         per build hand, the raw and percent condition at the fight's end over the trials that
 *                                        had an item in that hand. `main`/`off` are the BUILD's hands, not the slots after a
 *                                        survivor is promoted.
 */
export function durabilityStats(rows) {
  const trials = rows.length;
  // A repeat report (`again`) is `lowerCondition` re-announcing a weapon already at 0 - never the weapon's first break - so a
  // fight "has a break" only if a weapon actually transitioned, and the first break is the first distinct one.
  const firstDistinct = (r) => r.breaks.find((b) => !b.again);
  const first = rows.map((r) => firstDistinct(r)?.t).filter((v) => Number.isFinite(v));
  const withBreak = rows.filter((r) => firstDistinct(r) !== undefined);
  const counts = [0, 0, 0];
  for (const r of rows) counts[Math.min(2, r.weaponsBroken)] += 1;
  const events = rows.flatMap((r) => r.breaks);
  const distinct = events.filter((b) => !b.again);
  const byReason = { wear: 0, cws: 0 };
  for (const b of distinct) byReason[b.reason] = (byReason[b.reason] ?? 0) + 1;
  const hand = (name) => {
    const have = rows.filter((r) => r.condition[name] !== null && r.condition[name] !== undefined);
    return {
      n: have.length,
      raw: summarize(have.map((r) => r.condition[name])),
      pct: summarize(have.map((r) => r.conditionPct[name]).filter((v) => v !== null && v !== undefined)),
      broken: have.filter((r) => r.condition[name] <= 0).length,
    };
  };
  const stopped = rows.filter((r) => r.endReason === 'noWeaponLeft').length;
  return {
    trials,
    fightsWithBreak: withBreak.length,
    breakProbability: wilsonInterval(withBreak.length, trials),
    timeToFirstBreak: summarize(first),
    // null when EVERY trial broke (no unbroken fight is at risk), like any empty summary
    timeAtRiskWithoutBreak: summarize(rows.filter((r) => firstDistinct(r) === undefined).map((r) => r.time)),
    weaponsBroken: { counts, mean: trials ? (counts[1] + 2 * counts[2]) / trials : 0 },
    breakEvents: {
      distinct: distinct.length,
      byReason,
      afterKill: distinct.filter((b) => b.afterKill).length,
      repeats: events.length - distinct.length,
    },
    noWeaponLeft: { count: stopped, probability: wilsonInterval(stopped, trials) },
    endCondition: { main: hand('main'), off: hand('off') },
  };
}

/**
 * Run `trials` independent fights. Pass `seeds` to reuse a fixed list (the paired form). Every result carries the
 * pool, the seed list, the number killed and the distributions of TTK, damage, overkill and blows. `ttk` (and its
 * alias `ttkConditional`) and `killDps` are CONDITIONAL on a kill: with censored fights they are biased low relative
 * to an unconditional time-to-kill. `killProbability` is the overall share of fights that kill inside
 * `horizonSeconds`, with a Wilson interval. `outputDps`, `damageDealt`, remaining and overkill cover every trial,
 * including a censored one (its `outputDps` is over the time it actually ran, not the full horizon; a trial that
 * landed no blow has no rate and is left out of that summary, whose `n` says how many rows it has).
 *
 * `censored` is every fight with no observed kill, whatever stopped it. `outcomes` splits it: `noWeaponLeft` (a break left no
 * weapon; the model has no fist schedule), `horizonCensored` (`maxSeconds`) and `blowBudgetCensored` (`maxBlows`) - read those,
 * not the total. With `durability: true`, `durability` carries the break statistics (see `durabilityStats`; denominator =
 * every trial). `simulatePairedFights` runs this once per build on shared seeds and does no pooling or paired differencing.
 */
export function simulateFights(ch, args = {}) {
  const trials = Math.max(1, Math.floor(num(args.trials, Array.isArray(args.seeds) ? args.seeds.length : 1000)));
  const seeds = Array.isArray(args.seeds) ? [...args.seeds] : pairedFightSeeds(trials, num(args.seed, 0));
  if (!seeds.length) throw new RangeError('simulateFights: at least one seed is required');
  // One table set for the whole batch: every trial shares the same build, scenario, target and condition bands, and
  // only the seed's draws differ. `simulateFight` treats `_tierCache` as internal and strips it from `.with()`.
  const tierCache = createTierCache();
  const rows = seeds.map((seed) => simulateFight(ch, { ...args, seed, _tierCache: tierCache }));
  // Row closures keep this cache alive; carried tables are large, so release them once the batch is sampled.
  tierCache.tiers.clear();
  if (rows.some((r) => !r)) return null;
  const kills = rows.filter((r) => r.kill);
  const pool = rows[0].health;
  const ttk = summarize(kills.map((r) => r.ttk));
  const output = summarize(rows.map((r) => r.outputDps));
  const killDps = summarize(kills.map((r) => r.killDps));
  return {
    trials: rows.length,
    seeds,
    health: pool,
    kills: kills.length,
    // `censored` is every fight with NO observed kill, whatever stopped it: the sum of `outcomes.noWeaponLeft`,
    // `outcomes.horizonCensored` and `outcomes.blowBudgetCensored`. The three are different things (a weapon-less fight is
    // censored by the local model's missing fist schedule, a horizon fight by the clock) - read `outcomes`, not this total.
    censored: rows.length - kills.length,
    outcomes: {
      killed: kills.length,
      noWeaponLeft: rows.filter((r) => r.endReason === 'noWeaponLeft').length,
      horizonCensored: rows.filter((r) => r.endReason === 'horizon').length,
      blowBudgetCensored: rows.filter((r) => r.endReason === 'blowBudget').length,
    },
    durability: args.durability === true ? durabilityStats(rows) : null,
    // `ttk`/`killDps` are CONDITIONAL on a kill; `killProbability` is the overall share of fights that kill inside the
    // horizon. With censored fights, the conditional mean is biased low relative to an unconditional TTK.
    ttk,
    ttkConditional: ttk,
    killProbability: wilsonInterval(kills.length, rows.length),
    horizonSeconds: num(args.maxSeconds, 3600),
    damageMode: rows[0].damageMode,
    outputDps: output,
    killDps,
    damageDealt: summarize(rows.map((r) => r.damageDealt)),
    overkill: summarize(rows.map((r) => r.overkill)),
    remainingHealth: summarize(rows.map((r) => r.remainingHealth)),
    blows: summarize(rows.map((r) => r.blows)),
    expectedPerSwing: summarize(rows.map((r) => r.expectedPerSwing)),
    rows,
    with: (edit = {}) => simulateFights(ch, { ...args, ...edit }),
  };
}

/**
 * Several builds on the SAME seed list, the form a paired comparison needs. `entries` is `[{id, ch}]`; the result
 * carries the shared seeds and each build's `simulateFights` result.
 */
export function simulatePairedFights(entries, args = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('simulatePairedFights: at least one entry is required');
  const trials = Math.max(1, Math.floor(num(args.trials, 1000)));
  const seeds = Array.isArray(args.seeds) ? [...args.seeds] : pairedFightSeeds(trials, num(args.seed, 0));
  return { seeds, trials: seeds.length, rows: entries.map((e) => ({ id: e.id, result: simulateFights(e.ch, { ...args, seeds }) })) };
}

/** Named aliases for callers that prefer the objective vocabulary. */
export const simulateFightDistribution = simulateFights;
