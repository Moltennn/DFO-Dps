/*
 * dfo-dps - Cast When Strikes (CWS) events for the ordinary fight (Stage 3.5.1).
 *
 * Upstream: a CWS row is `{ type: 2, param: <SPELLS.STD index> }`. It rides the Strikes payload at the tail of
 * `calculateAttackDamage` (vendor:combat/formulas.js:826-836, vendor:systems/enchantments.js:590-602). The row fires
 * on a blow whose final damage is not 0, whose off-hand `whole` draw passed, on an enchanted item, when the target is
 * not warded, and when the attacker is the player or the damage is positive. It casts immediately, before the host
 * applies the melee blow, and pays 10 condition (deferred here).
 *
 * The guard reads the damage BEFORE the Strikes payload: `doItemEnchantmentPayloads` gets one `damage` and stores it
 * in each row's `env` (enchantments.js:1031-1072); Potent Vs / Low Damage Vs only change the separate `damageOut`.
 * That pre-payload value is `strikesDamage`/`strikesPositive` on the blow outcome. `formulaPositive` is the POST-payload
 * value and belongs to Flow and Many Endings, not to CWS.
 *
 * The payload walk also stops at the first enchantment type the vendored REGISTRY does not answer
 * (`enchantments.js:1052-1060`). `payloadRows` in src/enchants.js carries that order/abort.
 *
 * This module implements the DIRECT DAMAGE part only:
 *   - the exact `isDamageHealth` family: classic (4, 0) Damage Health;
 *   - the per-effect absorption / reflection / resistance gates in `applySpell` order;
 *   - `rollMagnitude` and `savingThrow` with the game's formula and percentile law;
 *   - the damage-health pierce (`spellPierce`) and the online school/potency multiplier (`spellPowerMult`);
 *   - the first-effect-only reflection quirk.
 *
 * Deferred: Continuous Damage (1,0) and every other family, DoTs, condition costs, wear and break. A deferred effect
 * still passes the per-effect gates (so reflection/gate order is preserved) but contributes no direct damage.
 *
 * The RNG is a `rolls()` function supplied by the caller. The fight simulator gives it a dedicated stream; tests may
 * inject a scripted sequence. Nothing here uses `Math.random`.
 */
import { tryAbsorption } from '../vendor/upstream/a3eb1605/src/systems/absorption.js';
import { powerIdsOf, powerOf } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { POTENCY_CAP, SPELL_POWER_MOST } from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';
import { EFFECT_FLAGS, ELEMENT_FLAG_BY_INDEX } from './target.js';
import { fightingClimb } from '../vendor/upstream/a3eb1605/src/systems/spell/spellPower.js';
import { effectSchool, savingChanceOutcome, standardSpells } from './spells.js';
import { ENCHANTMENT_TYPES, payloadRows } from './enchants.js';
import { validItemLines } from './gearLines.js';

/** systems/effects.js:440 - `e.type === 4 && e.subType === 0`. NOT the broader local DAMAGE_HEALTH set. */
export const isDamageHealth = (e) => !!e && e.type === 4 && e.subType === 0;

/** systems/effects.js:510-515 - the best live chance of one effect kind. */
function bestLiveChance(target, kind) {
  let best = 0;
  for (const a of target?.activeEffects ?? []) {
    if (a.kind === kind && !a.ended && (a.chance ?? 0) > best) best = a.chance;
  }
  return best;
}

/** systems/spellcast.js:109-115 - Elemental Resistance is additive over live instances. */
function elementalResistanceChance(target, element) {
  let total = 0;
  for (const a of target?.activeEffects ?? []) {
    if (a.kind === 'elementalResistance' && a.element === element && !a.ended) total += a.chance ?? 0;
  }
  return total;
}

/** systems/effects.js:51 - Dice100.Roll: `floor(roll * 100) < chance`. */
const dice100 = (chance, roll01) => Math.floor(roll01 * 100) < chance;

/** systems/spellcast.js:229-236 - EntityEffect.GetMagnitude, verbatim. */
export function rollMagnitude(effect, casterLevel, rolls) {
  const range = (lo, hi) => lo + Math.floor(rolls() * (hi + 1 - lo));
  const base = range(effect.magnitudeBaseLow ?? 0, effect.magnitudeBaseHigh ?? 0);
  const plus = range(effect.magnitudeLevelBase ?? 0, effect.magnitudeLevelHigh ?? 0);
  const per = Math.max(1, effect.magnitudePerLevel ?? 1);
  return base + plus * Math.floor(casterLevel / per);
}

/** systems/spellcast.js:203-226 - SavingThrow, verbatim: absolute elemental resistance, then the
 *  chance and its prorated percentile. `pierce` is DamageHealth's `spellPierce` (BAL9). Returns 0..100. */
export function savingThrow(element, effectFlags, target, rolls, pierce = 0) {
  const resist = elementalResistanceChance(target, element);
  if (resist > 0 && Math.floor(rolls() * 100) < resist) return 0;
  const sc = savingChanceOutcome(target, { element, effectFlags, pierce });
  if (sc.immune) return 0;
  const saving = sc.chance;
  let percent = 100;
  const roll = 1 + Math.floor(rolls() * 100);
  if (roll <= saving) percent = saving - 20 <= roll ? 100 - 5 * (saving - roll) : 0;
  return Math.max(0, Math.min(100, percent));
}

/** spellPower.js:56-65 - the school past 100, online only. `fightingClimb` is upstream's own (master-capped and
 *  mentored); the local build's `online` flag stands in for `isOnlinePage()`, as in src/spells.js:357-359. */
export function schoolPotencyFor(caster, school) {
  if (caster?.online === false) return 1;
  // The local build is the PLAYER (characterFromSave does not carry `isPlayer`); masterCappedSkill's player
  // gate and master-skill cap are upstream's.
  const climb = fightingClimb({ ...caster, isPlayer: true }, school);
  return climb > 100 ? 1 + (climb - 100) * 0.01 : 1;
}

/**
 * The registered spell-power and pierce inputs the supported build model can carry:
 *   - `potency` lines on worn pieces, summed under POTENCY_CAP (lootPowers.js:747-758);
 *   - Arcane Surge while the wearer's magicka stands above its line (:750-757);
 *   - a `pierce` power's points (Magnus's Gaze, :762);
 *   - the caller's explicit `potencyPct` / `pierce` scenario inputs (the card's own options).
 * The cap is SPELL_POWER_MOST. Firmament spell power/pierce is not a field of the `simulateFight` build model, so a
 * caller that has one must pass it explicitly; this function does not invent it.
 */
export function spellPowerInputs(ch, { potencyPct = 0, pierce = 0, items = [] } = {}) {
  const seenItems = new Set();
  const worn = [...(ch?.worn ?? ch?.items ?? []), ...items].filter((it) => {
    if (!it || seenItems.has(it)) return false;
    seenItems.add(it);
    return true;
  });
  let potency = 0;
  let surge = null;
  let piercePower = null;
  const seen = new Set(); // wornPowers counts a power ONCE by id (lootPowers.js:247-253)
  for (const it of worn) {
    for (const a of validItemLines(it)) if (a.id === 'potency') potency += a.value | 0;
    for (const id of powerIdsOf(it)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const power = powerOf(id);
      if (!power) continue;
      if (power.kind === 'surge' && !surge) surge = power;
      else if (power.kind === 'pierce' && !piercePower) piercePower = power;
    }
  }
  potency = Math.min(POTENCY_CAP, potency);
  if (
    surge &&
    ch?.maxMagicka > 0 &&
    Number.isFinite(ch.magicka) &&
    ch.magicka > (ch.maxMagicka * (surge.above ?? 0)) / 100
  ) potency += surge.pct ?? 0;
  return {
    potencyPct: Math.min(SPELL_POWER_MOST, potency + Math.max(0, Number(potencyPct) || 0)),
    pierce: Math.max(0, Number(pierce) || 0) + (piercePower?.points ?? 0),
  };
}

/**
 * The CWS rows of one item, in the item's own order, with the record each `param` resolves to (or null when the
 * spellbook has no such row). The row itself is kept even when the record is missing: that is upstream's per-row
 * lookup, where a missing record casts nothing but the row was still walked. `payloadRows` stops at an unregistered
 * type exactly where `doItemEnchantmentPayloads` returns.
 */
export function cwsRows(item, standard = standardSpells()) {
  const out = [];
  for (const e of payloadRows(item)) {
    if (e.type !== ENCHANTMENT_TYPES.CastWhenStrikes) continue;
    const param = Number(e.param);
    const spell = standard && typeof standard.get === 'function' ? (standard.get(param) ?? null) : null;
    out.push({ param, spell });
  }
  return out;
}

/**
 * The Strikes eligibility gate for one blow (the CWS row's own guard plus the dispatcher's item/whole gates):
 *   `!target || damage === 0 || target.warded` -> no cast
 *   `charged && isEnchantedItem(charged) && (attacker.isPlayer || damage > 0) && whole`
 * `strikesPositive` is the PRE-payload formula damage > 0, i.e. the outcome's `strikesPositive` - NOT
 * `formulaPositive`, which is the post-Potent-Vs value Flow and Many Endings read.
 */
export function cwsEligible({
  target = null, strikesPositive = false, whole = false, item = null, standard = standardSpells(),
} = {}) {
  if (!target) return false;
  if (!strikesPositive) return false; // the row's `damage === 0` guard; a miss / fully stopped blow
  if (target.warded) return false;
  if (!whole) return false;
  // The dispatcher's outer `(attacker.isPlayer || damage > 0)` gate is subsumed by the row's stricter guard above.
  return cwsRows(item, standard).length > 0;
}

/**
 * Resolve one CWS cast's direct damage on `target`, in upstream `applySpell` order. When `hurt` is supplied it applies
 * each effect's damage as the host's landing sink; otherwise the caller applies the returned total.
 *
 * `hurt(n)` is the host's landing sink, if the caller has one: it returns false once the target is dead. Later effects
 * are still rolled (their draws are upstream's) but no longer counted or applied. Without `hurt`, every effect is
 * counted (the single-effect tests).
 *
 * @returns {{ damage: number, absorbed: number, reflected: number, resisted: number, deferred: number,
 *   effects: object[] }}
 */
export function resolveCwsCast({
  spell, caster = null, casterLevel = 1, target = null, rolls = Math.random,
  pierce = 0, potencyPct = 0, hurt = null,
} = {}) {
  if (typeof rolls !== 'function') throw new TypeError('resolveCwsCast: rolls must be a function');
  if (!spell || !target) return { damage: 0, absorbed: 0, reflected: 0, resisted: 0, deferred: 0, effects: [] };
  const rangeType = Number.isInteger(spell.rangeType) ? spell.rangeType : 0;
  const element = Number.isInteger(spell.element) ? spell.element : 4;
  const effectFlags = ELEMENT_FLAG_BY_INDEX[element] ?? EFFECT_FLAGS.Magic;
  const saveScaled = rangeType !== 0; // GetMagnitude's CasterOnly gate
  const casterEntity = caster?.entity ?? null;
  const powerPct = Math.min(SPELL_POWER_MOST, Math.max(0, Number(potencyPct) || 0));
  const effects = [];
  let damage = 0;
  let absorbed = 0;
  let reflected = 0;
  let resisted = 0;
  let deferred = 0;
  let reflectedCount = 0;
  let dead = false;

  for (const e of spell.effects ?? []) {
    if (!e || e.type <= -1) continue;
    // EntityEffectManager's assign-time chain, per effect: absorption, reflection, resistance (effects.js:991-1038).
    const spent = tryAbsorption(e, rangeType, target, {
      absorbing: !!target?._enchantMods?.absorbsSpells,
      rolls,
    });
    if (spent > 0) {
      absorbed += 1;
      effects.push({ type: e.type, subType: e.subType, absorbed: true, applied: false });
      continue;
    }
    if (casterEntity && casterEntity !== target && reflectedCount === 0) {
      const fc = bestLiveChance(target, 'spellReflection');
      if (fc > 0 && dice100(fc, rolls())) {
        reflectedCount += 1;
        reflected += 1;
        effects.push({ type: e.type, subType: e.subType, reflected: true, applied: false });
        continue;
      }
    }
    if (rangeType !== 0) {
      const rc = bestLiveChance(target, 'spellResistance');
      if (rc > 0 && Math.floor(rolls() * 100) < rc) {
        resisted += 1;
        effects.push({ type: e.type, subType: e.subType, resisted: true, applied: false });
        continue;
      }
    }
    if (!isDamageHealth(e)) {
      // The direct-damage stage does not apply this family. It still consumed the gates above, preserving the
      // per-effect order; its own duration/magnitude draws are deferred with the family.
      deferred += 1;
      effects.push({ type: e.type, subType: e.subType, deferred: true, applied: false });
      continue;
    }
    const magnitude = rollMagnitude(e, casterLevel, rolls);
    const percent = saveScaled ? savingThrow(element, effectFlags, target, rolls, pierce) : 100;
    let n = saveScaled ? Math.trunc((magnitude * percent) / 100) : magnitude;
    const school = effectSchool(e);
    const spellPower = schoolPotencyFor(casterEntity, school) * Math.max(0.5, 1 + powerPct / 100);
    if (n > 0 && spellPower !== 1) n = Math.max(1, Math.round(n * spellPower));
    const applied = !dead && n > 0;
    if (applied) {
      damage += n;
      if (hurt && hurt(n) === false) dead = true;
    }
    effects.push({
      type: e.type, subType: e.subType, magnitude, savePercent: percent, school,
      spellPower, damage: n, applied,
    });
  }

  return { damage, absorbed, reflected, resisted, deferred, effects };
}
