/*
 * dfo-dps - the exact per-blow outcome distribution (Stage 3.1).
 *
 * `analyze` reduces one swing to expectations. This module keeps the DISTRIBUTION the same pipeline produces, as a
 * list of joint outcomes with probabilities, in three tiers:
 *
 *   full   one outcome per branch of the upstream blow, nothing merged: direction, body part, critical, hit/miss,
 *          off-hand `whole`, the damage roll (index, pre-finish and finished value), backstab, the shield/armour
 *          outcome and the echo mask all survive. For tests, inspection and debugging.
 *   fight  the full tier merged on the joint key (direction, facing, backstab, critical, hit, whole, echo mask,
 *          blow, echo hit) - body part and roll index are marginalised away; nothing else is. A fight needs this.
 *   sample a cumulative table over the fight tier, drawn with a seeded stream (createBlowSampler).
 *
 * NOTHING IS APPROXIMATED OR SAMPLED in the full and fight tiers: every random dimension of the blow is enumerated,
 * each outcome goes through the unchanged nonlinear pipeline (src/model.js hitModel, damageModel, afterShare ...) before
 * it is weighted, and a probability is only ever added to another's when the two outcomes are identical on the merge
 * key. The probabilities are binary64 sums of products, so "exact" means exact up to rounding: they sum to 1 within
 * TOLERANCE, and merging conserves the total within the same bound (both verified by the tests).
 *
 * THE DIMENSIONS (the stage record section 1.1; combat/pcaao.js:1614-1866, combat/formulas.js:830-878,
 * combat/playerWeapon.js:1032):
 *
 *   direction   uniform over the six strikes; a bow's release is StrikeDown, a gun's shot neutral (model.js)
 *   facing      the foe's back is to the player with probability `backstabUptime`  (a scenario input, as in analyze)
 *   critical    Bernoulli(crit.chance) - changes the hit chance (+crit/4) and the finished damage
 *   body part   the 20-slot table's seven weights - changes the hit chance, the armour and the shield's strong spot
 *   hit         Bernoulli(clamped chance | direction, facing, critical, part)
 *   roll        uniform over the damage roll x enemy-type bonus values (damageModel's rolls); backstab x3 is a branch
 *               of the facing outcome (probability Backstabbing / 100, rolled only on a hit)
 *   shield      block / no block, conditional on the part (targetPartOutcomes)
 *   whole       an off-hand blow counts whole with OFF_HAND_BLOW.blowWeight (formulas.js:830), independently of
 *               everything above; it gates the Strikes payload (Potent Vs) - a main-hand blow is always whole
 *   echo        Many Endings: one Bernoulli per power on a landed blow whose final damage is > 0
 *   strikesPositive  the PRE-payload formula damage > 0 - the CWS guard. `formulaPositive` is the POST-payload value
 *                    Flow and Many Endings read.
 *
 * A MISS is its own outcome, even when its damage is 0 and even when a Strikes payload (Potent Vs) gives it damage:
 * `hit` says whether the swing landed, `damage` what the blow was worth.
 *
 * WHAT IS NOT HERE (the fight loop owns it): the Cast When Strikes cast itself (this module carries its trigger as
 * `strikesPositive`/`strikesDamage`; `src/simulateFight.js` and `src/cws.js` resolve it), DoTs, dynamic Flow state,
 * ordinary equipment wear and breaks (`src/durability.js` under `durability: true`), the relay's bucket, dual-hand
 * scheduling. The off-hand `whole` flag is carried so the fight loop can gate those on it.
 *
 * The setup lines (weapon, target, simOpts, caps, powers) mirror `analyzeCard` in src/model.js and are checked against
 * it: test/blowOutcomes.test.js asserts that the distribution's means equal analyze()'s perSwing / cappedPerSwing.
 */
import {
  RANDOM_SWING, SWING_DIRECTIONS, afterShare, additionsTo, bowOf, conditionMultiplier, damageModel, echoChances,
  finishBlow, hitModel, skill, strikesNet, weaponBlow, weaponOf, referenceFoe,
} from './model.js';
import { CURB_SHARE, RRI_WEAPON_DAMAGE, WEAPONS } from './data.js';
import { powerIdsOf, powerOf } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import {
  bodyPartWeights, hasWornEquipment, intrinsicDamage, materialRequirementMultiplier, targetPartOutcomes,
} from './target.js';
import { OFF_HAND_BLOW, offHandDamage } from './dualWield.js';

/** The tolerance on total probability (a sum of at most ~1e5 products in binary64). */
export const TOLERANCE = 1e-12;

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Neumaier-compensated accumulation, so merging many small probabilities does not drift. */
class Sum {
  constructor() { this.s = 0; this.c = 0; }
  add(x) {
    const t = this.s + x;
    this.c += Math.abs(this.s) >= Math.abs(x) ? (this.s - t) + x : (x - t) + this.s;
    this.s = t;
  }
  get value() { return this.s + this.c; }
}

/**
 * The full-tier distribution of ONE blow (one hand). Every full outcome also carries `echoEligible`: whether the
 * final formula damage was greater than zero, i.e. whether an echo could be rolled at all. It is a full-tier field
 * because the fight tier already resolves the echo into `echoMask` / `echoDamage`.
 *
 * @param {object} ch   the build, as `analyze` reads it
 * @param {object} args the `analyze` scenario (target, core, weapon, traits, health, swing, backstabUptime, imprints,
 *   potentVs, rri, healthShare, ...) plus `hand`: 'main' (default) or 'off'. In a dual build (`dual`, `offWeapon`) 'off'
 *   is the off-hand weapon's blow, as `analyze` builds it; with `offHand: true` it is the given weapon struck with the
 *   off hand's terms (a Pistolet pair). Whether the two hands alternate is scheduling and is not modelled here.
 * @returns {{ kind: 'full', exact: true, hand, cap, directions, outcomes: object[], total: number, meta: object }}
 */
export function blowOutcomes(ch, args = {}) {
  let {
    weapon, target, core = 'overhaul', swing = RANDOM_SWING, critDamage = true,
    traits = null, health = null, passiveOn = true, hand = 'main', ...opts
  } = args;
  if (hand !== 'main' && hand !== 'off') throw new RangeError(`blowOutcomes: hand must be 'main' or 'off' (got ${hand})`);
  let chUse = ch;
  const dualOff = hand === 'off' && opts.dual && ch.offWeapon && !WEAPONS[ch.weapon?.templateIndex]?.twoHanded
    && !WEAPONS[ch.offWeapon.templateIndex]?.twoHanded && !WEAPONS[ch.offWeapon.templateIndex]?.gun;
  if (dualOff) {
    // analyzeCard's dual arm: the off-hand weapon is its own item, with no what-if riding on it
    chUse = { ...ch, weapon: ch.offWeapon };
    weapon = weaponOf(ch.offWeapon, { rri: !!opts.rri });
    opts = { ...opts, loot: null, imprints: null, potentVs: 0 };
  }
  opts = { ...opts, dual: false, pair: false, offHand: hand === 'off' || opts.offHand === true };
  const offHand = opts.offHand;

  let w = weapon === undefined ? weaponOf(chUse.weapon, { rri: !!opts.rri }) : weapon;
  if (w && opts.rri) {
    const rr = RRI_WEAPON_DAMAGE[w.templateIndex];
    if (rr) w = { ...w, min: rr.min, max: rr.max };
  }
  const t = target ?? { ...referenceFoe(chUse.level, 'tough') };
  const tgt = { ...t, group: t.group ?? null, affinity: t.affinity ?? null };
  const traitList = traits ?? t.bossTraits ?? [];
  const wraps = !w && chUse.wraps ? weaponOf(chUse.wraps, { rri: !!opts.rri }) : null;
  const swingKeys = swing === RANDOM_SWING
    ? (w?.ranged ? (w.gun ? ['StrikeLeft'] : ['StrikeDown']) : [...SWING_DIRECTIONS])
    : [swing];
  const directionP = 1 / swingKeys.length;

  const matReqMulti = materialRequirementMultiplier(tgt, w, { soft: opts.softMaterialRequirements !== false });
  const heldPowers = (w ?? wraps)?.powers ?? [];
  const powerAdditions = additionsTo(heldPowers, opts.imprints);
  const simOpts = {
    ...opts, passiveOn, critDamage,
    healthShare: opts.healthShare ?? t.healthShare ?? 1,
    firmamentDamagePct: opts.firmamentDamagePct ?? chUse.firmamentDamagePct ?? 0,
    wraps, matReqMulti, imprintsExtra: powerAdditions,
    ...(opts.carry === true ? { carryBases: true } : {}),
  };

  // backstab: the host's chance, as analyzeCard reads it
  const watchful = tgt?.watchful === true || tgt?.revenant?.edge?.watchful === true;
  const backSkill = watchful ? 0 : (opts.backstabChance != null ? num(opts.backstabChance, 0) : skill(chUse, 19, simOpts));
  const backUptime = clamp(num(opts.backstabUptime, 0), 0, 1);
  const backProb = backSkill > 1 ? clamp(backSkill, 0, 100) / 100 : 0;
  const behind = backUptime > 0 && backSkill !== 0;

  // the per-hit cap
  const bossHealth = num(health, 0);
  const curbCap = traitList.includes('curbing') && bossHealth > 0 ? Math.max(1, Math.round(bossHealth * CURB_SHARE)) : 0;
  const hardCap = num(t.hitCap, 0);
  const caps = [curbCap, hardCap].filter((n) => n > 0);
  const cap = caps.length ? Math.min(...caps) : 0;

  const strikeKind = w?.ranged ? 'arrow' : 'melee';
  const bow = bowOf(w, opts);
  const strikes = num(opts.potentVs, 0) + strikesNet((w ?? wraps)?.item ?? null, tgt);
  const echoes = echoChances([...heldPowers, ...powerAdditions]);
  // The echo powers ALIGNED with `echoes`, each with the equipped power ID it came from (or `null` for a what-if addition).
  // `afterShare`'s `echoMask` bit i is this list's entry i; a break can then keep only the IDs a surviving item still wears
  // (upstream `blowPowers`' same-ID clause, lootPowers.js:262-268) instead of keeping or dropping the whole aggregate.
  const heldItem = (w ?? wraps)?.item ?? null;
  const heldEchoPowers = heldItem
    ? [...new Set(powerIdsOf(heldItem))].filter((id) => typeof id === 'string' && (powerOf(id)?.chance ?? 0) > 0 && powerOf(id)?.kind === 'echo')
      .map((id) => ({ id, chance: powerOf(id).chance, source: 'item' }))
    : [];
  const whatIfEchoPowers = powerAdditions
    .filter((p) => p?.kind === 'echo' && (p.chance ?? 0) > 0)
    .map((p) => ({ id: null, chance: p.chance, source: 'what-if' }));
  const echoPowers = [...heldEchoPowers, ...whatIfEchoPowers];
  const geared = core === 'overhaul' && hasWornEquipment(tgt);
  const weights = bodyPartWeights(core);
  const relay = !!tgt.relayBody;
  const wholeP = offHand ? OFF_HAND_BLOW.blowWeight : 1;

  // The blow after the card, as outcomes: the target's defence (armour / shield per part, or the intrinsic arm), the
  // off hand's share, the Strikes payload (only when whole), the pull, the trait, the echo - model.js's own functions.
  const ctxOf = (whole) => ({
    weapon: w, offHand: false, traits: traitList, strikeKind, bow, potentVs: whole ? strikes : 0, echoes, relay,
    warded: tgt.warded === true,
  });
  const cache = new Map();
  const resolve = (card, part, whole) => {
    const key = `${card}|${part}|${whole ? 1 : 0}`;
    let r = cache.get(key);
    if (r) return r;
    const ctx = ctxOf(whole);
    if (geared) {
      r = targetPartOutcomes(tgt, card, part, { weapon: w })
        .flatMap(({ p, damage }) => afterShare(offHand ? offHandDamage(damage) : damage, p, ctx));
    } else {
      const defended = intrinsicDamage(tgt, card, { weapon: w });
      r = afterShare(offHand ? offHandDamage(defended) : defended, 1, ctx);
    }
    cache.set(key, r);
    return r;
  };
  const missCache = new Map();
  const miss = (whole) => {
    let r = missCache.get(whole);
    if (!r) { r = afterShare(0, 1, ctxOf(whole)); missCache.set(whole, r); }
    return r;
  };

  // SCENARIO `carry: true`: the fight loop draws an atom and re-resolves the percentage channels with the live
  // remainder, in upstream's stage order, then the unchanged non-percentage stages (crit, material, condition, the
  // defence, the off-hand share, the payload, the trait, the cap). The atom keeps the pre-percentage base and the
  // branch it took through `resolve`; the tier's probabilities do not depend on the damage, so the sampled sequence
  // stays valid. `critMult` is set during the enumeration below (the same for every direction).
  let critMult = 1;
  const conditionMult = w ? conditionMultiplier(w, simOpts.equipmentDamageEnhanced === true) : 1;
  const resolveOne = (card, part, whole, branch) => {
    const list = geared
      ? targetPartOutcomes(tgt, card, part, { weapon: w })
        .flatMap(({ p, damage }) => afterShare(offHand ? offHandDamage(damage) : damage, p, ctxOf(whole)))
      : afterShare(offHand ? offHandDamage(intrinsicDamage(tgt, card, { weapon: w })) : intrinsicDamage(tgt, card, { weapon: w }), 1, ctxOf(whole));
    return list[branch];
  };
  const carryResolve = opts.carry === true ? (draw, state) => {
    // A miss never reaches shareOf, and a landed blow with a base of 0 (or the classic fist arm's negative base) never
    // reaches weaponBlow at all - damageModel guards `d > 0` (src/model.js) and upstream lootBlow returns at
    // `!(damage > 0)` (lootPowers.js:287) - so neither consumes nor advances a remainder, and neither may gain the
    // elemental/venom flat. Fall back to the enumerated (floor) outcome.
    if (!draw.hit || !(draw.blowBase > 0)) return draw;
    let card = weaponBlow(chUse, w, draw.blowBase, tgt, { ...simOpts, carryState: state });
    if (draw.backstab) card *= 3; // the x3 is taken before the critical/material/condition stages, as damageModel does
    card = finishBlow(card, {
      core, critMult, matReq: num(simOpts.matReqMulti, 1), conditionMult, hasWeapon: !!w,
    }, draw.crit);
    const o = resolveOne(card, draw.part, draw.whole, draw.branch);
    // The resolve list's shape is damage-independent except at the `damage > 0` gate (ASSUMPTION M43); should a branch
    // ever be gone, keep the enumerated (floor) outcome rather than crash. Not observed on the shipped fixtures.
    return o ? finish({ ...draw }, o, cap) : draw;
  } : null;

  const outcomes = [];
  const wholes = offHand ? [[true, wholeP], [false, 1 - wholeP]] : [[true, 1]];
  swingKeys.forEach((direction, di) => {
    const h = hitModel(chUse, w, tgt, direction, core, simOpts);
    const d = damageModel(chUse, w, tgt, direction, core, simOpts);
    critMult = d.crit.damageMult;
    const hb = behind ? hitModel(chUse, w, tgt, direction, core, { ...simOpts, backstabBonus: backSkill }) : h;
    const facings = [{ facing: false, backstab: false, weight: behind ? 1 - backUptime : 1, h, plain: d.plainRolls, crit: d.critRolls, scale: 1 }];
    if (behind) {
      if (backProb < 1) facings.push({ facing: true, backstab: false, weight: backUptime * (1 - backProb), h: hb, plain: d.plainRolls, crit: d.critRolls, scale: 1 });
      if (backProb > 0) facings.push({ facing: true, backstab: true, weight: backUptime * backProb, h: hb, plain: d.backstabPlainRolls, crit: d.backstabCritRolls, scale: 3 });
    }
    for (const f of facings) {
      if (!(f.weight > 0)) continue;
      for (const crit of [false, true]) {
        const pc = crit ? f.h.crit.chance : 1 - f.h.crit.chance;
        if (!(pc > 0)) continue;
        const cards = crit ? f.crit : f.plain;
        const nRoll = cards.length;
        for (let part = 0; part < 7; part++) {
          const wt = weights[part] ?? 0;
          if (!(wt > 0)) continue;
          const ph = (crit ? f.h.byPart.crit : f.h.byPart.plain)[part];
          const base = directionP * f.weight * pc * wt;
          for (const [whole, pw] of wholes) {
            if (!(pw > 0)) continue;
            const common = { direction, directionIndex: di, facing: f.facing, backstab: f.backstab, crit, part, whole };
            if (ph > 0) {
              for (let r = 0; r < nRoll; r++) {
                const hitOutcomes = resolve(cards[r], part, whole);
                for (let branch = 0; branch < hitOutcomes.length; branch++) {
                  const o = hitOutcomes[branch];
                  const p = base * pw * ph * (1 / nRoll) * o.p;
                  if (!(p > 0)) continue;
                  outcomes.push(finish({
                    p, ...common, hit: true, roll: r, preFinish: d.preFinishRolls[r] * f.scale, card: cards[r],
                    // the carried stream's re-resolution key: the pre-percentage base and the defence/payload branch
                    ...(opts.carry === true ? { blowBase: d.blowBaseRolls?.[r], branch } : {}),
                  }, o, cap));
                }
              }
            }
            if (ph < 1) {
              for (const o of miss(whole)) {
                const p = base * pw * (1 - ph) * o.p;
                if (!(p > 0)) continue;
                outcomes.push(finish({ p, ...common, backstab: false, hit: false, roll: -1, preFinish: 0, card: 0 }, o, cap)); // the x3 is rolled on a hit only
              }
            }
          }
        }
      }
    }
  });

  const total = outcomes.reduce((s, o) => s + o.p, 0);
  const flowPower = [...heldPowers, ...powerAdditions].find((p) => p?.kind === 'flow') ?? null;
  return {
    kind: 'full', exact: true, hand, cap,
    directions: swingKeys,
    outcomes, total,
    meta: {
      geared, relay, offHand, echoes: [...echoes], echoPowers, potentVs: strikes, bow: !!bow,
      hand,
      // the value the tier's loot percentage actually read; null when no Flow power rides this hand
      flowStacks: flowPower ? num(simOpts.flowStacks, num(flowPower.max, 1)) : null,
      backstab: { behind, uptime: backUptime, chance: backProb, skill: backSkill },
      // scenario `carry: true` only: the per-fight re-resolution of a drawn atom with a live remainder
      carryResolve,
    },
  };
}

/**
 * Fill the damage fields of one outcome from afterShare's result `o` ({ v, x, echoMask, echoHits }):
 *   blow          the formula's blow after the defence, share, payload, pull and trait (on a relay body it carries the
 *                 owed echo); this is what the per-hit cap clips
 *   echoDamage    an ordinary foe's echo as its own hit (no trait, no cap)
 *   damage        uncapped total, blow + echoDamage
 *   claim         min(blow, cap) - what the relay is offered for the blow itself
 *   cappedDamage  claim + echoDamage - the cap's effect on the swing (model.js `claimed`)
 */
function finish(outcome, o, cap) {
  const blow = o.v;
  const echoDamage = o.x ?? 0;
  const claim = cap > 0 ? Math.min(blow, cap) : blow;
  // Explicit assignments, same order as the Object.assign source it replaces: the keys land after the caller's
  // p/common/hit/roll/preFinish/card fields exactly as before, and the 11 values are primitives so there is no
  // shared-reference difference.
  outcome.blow = blow;
  outcome.echoDamage = echoDamage;
  outcome.damage = blow + echoDamage;
  outcome.claim = claim;
  outcome.cappedDamage = claim + echoDamage;
  outcome.echoMask = o.echoMask ?? 0;
  outcome.echoHits = o.echoHits ?? 0;
  outcome.echoEligible = o.echoEligible === true;
  outcome.formulaPositive = o.formulaPositive === true;
  outcome.strikesDamage = o.strikesDamage ?? 0;
  outcome.strikesPositive = o.strikesPositive === true;
  return outcome;
}

const keyOf = (o) => [
  o.directionIndex, o.facing ? 1 : 0, o.backstab ? 1 : 0, o.crit ? 1 : 0, o.hit ? 1 : 0, o.whole ? 1 : 0,
  o.echoMask, o.blow, o.echoDamage, o.formulaPositive ? 1 : 0, o.strikesPositive ? 1 : 0,
].join('|');

/**
 * The fight tier: the full tier merged on (direction, facing, backstab, critical, hit, whole, echo mask, blow, echo
 * hit). Body part, roll index and the card value are marginalised away; every other distinction survives, so two
 * outcomes with equal damage but different crit, direction, hit or whole stay apart. Sorted deterministically.
 *
 * Why the omitted fields are safe:
 *   damage      = blow + echoDamage (both in the key)
 *   claim       = min(blow, cap) (the tier's `cap` is fixed; the cap is not random)
 *   cappedDamage= claim + echoDamage (both in the key and the tier cap)
 *   echoHits    = popcount(echoMask) (one bit per echo power)
 * Body part and roll index have already changed the blow through armour/shield/material/condition; no downstream
 * Stage 3.1 mechanic reads either. The full tier keeps them for inspection and for a future stage that needs them.
 */
export function mergeToFightTier(full) {
  const groups = new Map();
  for (const o of full.outcomes) {
    const k = keyOf(o);
    let g = groups.get(k);
    if (!g) {
      g = { first: o, sum: new Sum() };
      groups.set(k, g);
    }
    g.sum.add(o.p);
  }
  const outcomes = [...groups.values()].map(({ first: o, sum }) => Object.freeze({
    p: sum.value,
    direction: o.direction, directionIndex: o.directionIndex, facing: o.facing, backstab: o.backstab,
    crit: o.crit, hit: o.hit, whole: o.whole, echoMask: o.echoMask, echoHits: o.echoHits, echoEligible: o.echoEligible === true, formulaPositive: o.formulaPositive === true,
    strikesDamage: o.strikesDamage, strikesPositive: o.strikesPositive === true,
    blow: o.blow, echoDamage: o.echoDamage, damage: o.damage, claim: o.claim, cappedDamage: o.cappedDamage,
  }));
  outcomes.sort((a, b) => a.directionIndex - b.directionIndex
    || a.facing - b.facing || a.backstab - b.backstab || a.crit - b.crit || a.hit - b.hit || a.whole - b.whole
    || a.echoMask - b.echoMask || a.blow - b.blow || a.echoDamage - b.echoDamage);
  const t = new Sum();
  for (const o of outcomes) t.add(o.p);
  return { kind: 'fight', exact: true, hand: full.hand, cap: full.cap, directions: full.directions, outcomes, total: t.value, meta: full.meta, mergedFrom: full.outcomes.length };
}

/**
 * The CARRIED fight tier (`blowOutcomes(ch, { carry: true })`): the fight tier with the pre-percentage base and the
 * `resolve` branch kept on every landed atom, plus the tier's `carryResolve(atom, state)` from `blowOutcomes`'s meta.
 * The key is the ordinary one plus (part, blowBase, branch): two atoms with the same pre-percentage base and branch are
 * identical for every remainder state, so the distribution's probabilities still sum to 1 and the sampler's one draw
 * stays valid; only the integer values are re-resolved per draw.
 */
export function mergeToCarryTier(full) {
  if (!full.meta?.carryResolve) throw new TypeError('mergeToCarryTier: needs blowOutcomes with carry: true');
  const groups = new Map();
  for (const o of full.outcomes) {
    const k = `${keyOf(o)}|${o.part}|${o.blowBase ?? ''}|${o.branch ?? ''}`;
    let g = groups.get(k);
    if (!g) {
      g = { first: o, sum: new Sum() };
      groups.set(k, g);
    }
    g.sum.add(o.p);
  }
  const outcomes = [...groups.values()].map(({ first: o, sum }) => Object.freeze({
    p: sum.value,
    direction: o.direction, directionIndex: o.directionIndex, facing: o.facing, backstab: o.backstab,
    crit: o.crit, hit: o.hit, whole: o.whole, echoMask: o.echoMask, echoHits: o.echoHits, echoEligible: o.echoEligible === true, formulaPositive: o.formulaPositive === true,
    strikesDamage: o.strikesDamage, strikesPositive: o.strikesPositive === true,
    blow: o.blow, echoDamage: o.echoDamage, damage: o.damage, claim: o.claim, cappedDamage: o.cappedDamage,
    part: o.part, blowBase: o.blowBase, branch: o.branch,
  }));
  outcomes.sort((a, b) => a.directionIndex - b.directionIndex
    || a.facing - b.facing || a.backstab - b.backstab || a.crit - b.crit || a.hit - b.hit || a.whole - b.whole
    || a.echoMask - b.echoMask || a.part - b.part || (a.blowBase ?? -1) - (b.blowBase ?? -1)
    || (a.branch ?? -1) - (b.branch ?? -1) || a.blow - b.blow || a.echoDamage - b.echoDamage);
  const t = new Sum();
  for (const o of outcomes) t.add(o.p);
  return {
    kind: 'fight', exact: true, carry: true, hand: full.hand, cap: full.cap, directions: full.directions,
    outcomes, total: t.value, meta: full.meta, carryResolve: full.meta.carryResolve, mergedFrom: full.outcomes.length,
  };
}

/** One call: the fight tier of a blow (carried when the scenario asks for `carry: true`). */
export const blowFightTier = (ch, args) => (args?.carry === true
  ? mergeToCarryTier(blowOutcomes(ch, args))
  : mergeToFightTier(blowOutcomes(ch, args)));

/** Moments of a tier (any tier), for comparison with analyze(): probability-weighted means of the damage fields. */
export function tierMeans(tier) {
  const m = { perSwing: new Sum(), cappedPerSwing: new Sum(), claim: new Sum(), hit: new Sum(), crit: new Sum(), whole: new Sum() };
  for (const o of tier.outcomes) {
    m.perSwing.add(o.p * o.damage);
    m.cappedPerSwing.add(o.p * o.cappedDamage);
    m.claim.add(o.p * o.claim);
    if (o.hit) m.hit.add(o.p);
    if (o.crit) m.crit.add(o.p);
    if (o.whole) m.whole.add(o.p);
  }
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.value]));
}

/**
 * The sampling tier: a cumulative table over a FIGHT tier. `sample(stream)` is NOT enumeration - it draws one outcome of
 * the same joint distribution with one `stream.float()` draw.
 *
 * Mapping (documented, deterministic): u = float() in [0, 1); the outcome is the first whose cumulative probability
 * exceeds u * total, found by binary search; outcomes with p = 0 are never returned; a u*total that rounding puts at or
 * past the last cumulative value returns the last outcome with p > 0. `total` is the table's own sum (within TOLERANCE
 * of 1), so no probability mass is created or lost by normalisation.
 */
export function createBlowSampler(fight) {
  if (!fight || fight.kind !== 'fight') throw new TypeError('createBlowSampler: needs a fight-tier distribution (mergeToFightTier)');
  const live = fight.outcomes.filter((o) => o.p > 0);
  if (!live.length) throw new RangeError('createBlowSampler: the distribution has no outcome');
  const cdf = new Float64Array(live.length);
  const s = new Sum();
  live.forEach((o, i) => { s.add(o.p); cdf[i] = s.value; });
  const total = cdf[cdf.length - 1];
  const at = (u) => {
    const x = u * total;
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid] > x) hi = mid; else lo = mid + 1;
    }
    return live[lo];
  };
  return {
    kind: 'sampler', sampled: true, size: live.length, total,
    /** The outcome for a given u in [0, 1) - exposed so the mapping itself is testable. */
    outcomeAt(u) {
      if (!(u >= 0 && u < 1)) throw new RangeError(`createBlowSampler: u must be in [0, 1) (got ${u})`);
      return at(u);
    },
    /** One draw from `stream` (a rng.js stream). */
    sample(stream) {
      return at(stream.float());
    },
  };
}
