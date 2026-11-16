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
import { countedPieces, powerIdsOf, powerOf } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { EQUIP_SLOTS } from '../vendor/upstream/a3eb1605/src/characters/paperdoll/paperdoll.js';
import { POTENCY_CAP, SPELL_POWER_MOST } from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';
import { EFFECT_FLAGS, ELEMENT_FLAG_BY_INDEX } from './target.js';
import { fightingClimb } from '../vendor/upstream/a3eb1605/src/systems/spell/spellPower.js';
import { effectSchool, savingChanceOutcome, standardSpells } from './spells.js';
import { ENCHANTMENT_TYPES, enchantmentRows, payloadRows } from './enchants.js';
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
 *  mentored). The online gate is `isOnlinePage()`; the build's `online === true` is the local stand-in for it
 *  (src/spells.js reads the same build flag with a looser `online !== false` check). `masterSkillsActive` is a SECOND
 *  reading of the same page state: the game sets the player entity's `_online = isOnlinePage()` (world.js:25813 at
 *  a3eb1605), and masterSkills.js:111 reads
 *  `_online` before the offline `masterSkills` switch ("In force: always online; offline only when the player
 *  switched it on"). So the entity handed to `fightingClimb` carries `_online` from the same flag - an online
 *  character's master skills are in force whether or not the save's offline switch was set. */
export function schoolPotencyFor(caster, school) {
  if (caster?.online !== true) return 1;
  // The local build is the PLAYER (characterFromSave does not carry `isPlayer`); masterCappedSkill's player
  // gate and master-skill cap are upstream's.
  const climb = fightingClimb({ ...caster, isPlayer: true, _online: true }, school);
  return climb > 100 ? 1 + (climb - 100) * 0.01 : 1;
}

/**
 * vendor:systems/enchantments.js:1322-1326 - the live maximum magicka. One contract, stated at the boundary:
 *
 *   - `maxMagicka` is the LIVE value, as the game's accessor reports it. A save stores exactly that number
 *     (`full:systems/save/save.js:341` copies `maxMagicka` from the entity, whose accessor includes the ExtraSpellPts
 *     channel `maxMagickaModifier`, enchantments.js:1172-1176; the online-only folds are taken out by
 *     renownLayer.js:152-168 and are not this channel). A LIVE value is never folded again.
 *   - A caller that holds only a BASE value declares it as `maxMagickaBase`; the ExtraSpellPts fold
 *     (`_enchantMods.maxMagicka`) is then added once. This is the hand-built lab fixture's form.
 *   - An own getter is live (the game's accessor; chargen.js:398-421) and wins over both.
 *
 * Where an Arcane Surge power reads a declared BASE and a worn ExtraSpellPts row has no fold, `spellPowerInputs`
 * rejects rather than guesses. A live value needs no fold and is not refused.
 */
export function liveMaxMagicka(ch) {
  const desc = ch ? Object.getOwnPropertyDescriptor(ch, 'maxMagicka') : null;
  if (desc?.get) return ch.maxMagicka;
  if (Number.isFinite(ch?.maxMagickaBase)) return ch.maxMagickaBase + (ch?._enchantMods?.maxMagicka ?? 0);
  return ch?.maxMagicka ?? 0;
}

/** Whether the build declared a BASE maximum magicka (and so needs the ExtraSpellPts fold added once). A live accessor
 *  is never a base, whatever else the object carries. */
const declaresMaxMagickaBase = (ch) => Number.isFinite(ch?.maxMagickaBase)
  && !(ch ? Object.getOwnPropertyDescriptor(ch, 'maxMagicka')?.get : false);

/** One piece's content, apart from the slot it sits in: what makes two objects THE SAME piece. A live snapshot's
 *  `equipSlots` clone carries an `equipSlot` while the original the caller still holds does not (src/save.js:248-253),
 *  so a slot-only identity cannot see that the two are one piece. Object identity is not it either: characterFromSave clones
 *  every item (src/save.js:244) while analyze keeps the caller's object. */
function pieceContent(it) {
  if (!it) return '';
  const affixes = (Array.isArray(it.affixes) ? it.affixes : []).map((a) => [a?.id ?? '', a?.param ?? '', a?.value ?? '', a?.gem ?? '']);
  const ench = (Array.isArray(it.enchantments) ? it.enchantments : []).map((e) => [e?.type ?? '', e?.param ?? '']);
  return JSON.stringify([
    it.group ?? '', it.templateIndex ?? '', it.name ?? '', it.rarity ?? '', it.legendary ?? '',
    it.imprint ?? '', it.material ?? 0, it.flags ?? 0, it.maxCondition ?? 0, it.currentCondition ?? 0,
    affixes, ench,
  ]);
}

/** Two objects holding the same piece: the same content. Slot equality is NOT identity here - the equip table's order
 *  and count law is `equipList`/`countedPieces`, and content is only used where no slot can answer. */
const sameContent = (a, b) => !!a && !!b && pieceContent(a) === pieceContent(b);

/**
 * A hand-built list as the equip table holds it, in the table's own terms:
 *   - one piece per slot (a later entry takes the slot, as an equip rebuild does);
 *   - ordered by SLOT NUMBER, which is the equip table's order (`equipTableOf` = the slot array, equip.js:47) and so
 *     the order `countedPieces` reads - a duplicated Legendary record counts at its LOWEST slot, as upstream does;
 *   - a piece with no slot is its own entry, after the slotted ones;
 *   - then `countedPieces` (lootRarity.js:2348-2357) keeps the first copy of a Legendary id.
 */
function equipList(list) {
  const bySlot = new Map();
  const slotless = [];
  for (const it of list) {
    if (!it) continue;
    if (Number.isInteger(it.equipSlot)) bySlot.set(it.equipSlot, it);
    else slotless.push(it);
  }
  const ordered = [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([, it]) => it);
  return countedPieces([...ordered, ...slotless]);
}

/**
 * The effective equip table for a fight.
 *
 * Upstream reads ONE table - one piece per slot (`systems/equip.js` equipTableOf; `wornPieces` is
 * `countedPieces(table.filter(Boolean))`, lootPowers.js:134-137) - and a weapon is one entry in one hand slot
 * (paperdoll.js RightHand 19 / LeftHand 21). This builds that table: the build's `worn` pieces, with the scenario's
 * striking weapons overlaid as the occupants of the hand they strike with. The main-hand weapon REPLACES the
 * main-hand piece and the off-hand weapon replaces the off-hand piece; neither is ever a second copy beside it. A
 * Legendary record then counts once, the first the table lists (countedPieces, lootRarity.js:2348-2357).
 *
 * `weapons` = [main, off] as the fight actually wields them (`analyze`'s probe weapons). A scenario weapon replaces the
 * occupant of ITS hand: the build's `weapon`/`offWeapon` object first, then the slot that object is worn in, then the
 * hand slot itself. Content equality is used only for a hand-built list with no slots, and never across hands: an
 * identical weapon in the other hand is a different piece. A build with no `worn` list but an inventory is ambiguous
 * and is rejected: upstream reads only the equip table.
 */
export function equippedForFight(ch, weapons = []) {
  const base = ch?.worn;
  if (!Array.isArray(base)) {
    if (ch?.items != null) {
      throw new Error('simulateFight: the build has no equipped (`worn`) list; inventory items are not equipped gear');
    }
    return countedPieces(weapons.filter(Boolean));
  }
  const table = base.filter(Boolean).map((item, index) => ({
    item,
    slot: Number.isInteger(item?.equipSlot) ? item.equipSlot : null,
    index,
  }));
  const place = (item, occupant, hand) => {
    if (!item) return;
    // The hand's own piece first: by object (a live snapshot's clone is the build's `weapon`), then by the slot the
    // build already holds it in (`characterFromSave` takes the left hand as the main when the right is empty). The
    // scenario item's own `equipSlot` is NOT where it will be worn - a what-if piece may carry the slot it was minted
    // for while it is the off-hand weapon - so it is never read here.
    let at = -1;
    if (occupant) {
      at = table.findIndex((e) => e.item === occupant);
      if (at < 0 && Number.isInteger(occupant.equipSlot)) at = table.findIndex((e) => e.slot === occupant.equipSlot);
    }
    // The hand slot is the equip table's own address for a weapon (paperdoll.js RightHand/LeftHand).
    if (at < 0) at = table.findIndex((e) => e.slot === hand);
    // A hand-built list with no slots: recognise the same piece by content, ONLY among slotless entries. Content must
    // never match a piece in another hand - an identical weapon in the other hand is a different piece.
    if (at < 0) {
      const hits = [];
      table.forEach((e, i) => { if (e.slot == null && sameContent(e.item, item)) hits.push(i); });
      if (hits.length === 1) at = hits[0];
    }
    const slot = at >= 0 ? (table[at].slot ?? hand) : hand;
    // The table's entry carries the hand it occupies, so a later reader cannot re-derive a stale slot from the item.
    const worn = Number.isInteger(item.equipSlot) && item.equipSlot === slot ? item : { ...item, equipSlot: slot };
    if (at >= 0) table[at] = { item: worn, slot, index: table[at].index };
    else table.push({ item: worn, slot, index: base.length + table.length });
  };
  place(weapons[0] ?? null, ch?.weapon ?? null, EQUIP_SLOTS.RightHand);
  place(weapons[1] ?? null, ch?.offWeapon ?? null, EQUIP_SLOTS.LeftHand);
  // The equip table is ordered by slot (EQ table order); a hand-built piece with no slot keeps its list position after
  // the slotted ones. The order decides which copy of a duplicated Legendary record counts.
  return countedPieces(table
    .slice()
    .sort((a, b) => ((a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER)) || (a.index - b.index))
    .map((e) => e.item));
}

/**
 * The registered spell-power and pierce inputs the supported build model can carry:
 *   - `potency` lines on EQUIPPED pieces, summed under POTENCY_CAP (lootPowers.js:747-758);
 *   - Arcane Surge while the wearer's magicka stands above its line, against the LIVE maximum magicka (:750-757);
 *   - a `pierce` power's points (Magnus's Gaze, :762);
 *   - the caller's explicit `potencyPct` / `pierce` scenario inputs.
 * `worn` is the effective equip list (`equippedForFight`); when omitted, `ch.worn` is used, under the equip table's
 * own law (one piece per slot, a Legendary record once - countedPieces). A build with no `worn` list but an inventory
 * is rejected. The cap is SPELL_POWER_MOST.
 *
 * An ExtraSpellPts row feeds the maximum magicka the surge threshold reads (enchantments.js:1322-1326). Its fold is
 * required only where it is actually READ: when this build carries an Arcane Surge power and declared a BASE
 * `maxMagickaBase`. Without a Surge power, or with a LIVE `maxMagicka` (a save's number already contains the channel;
 * see `liveMaxMagicka`), the fold is never added and an unrelated ExtraSpellPts piece must not refuse the fight.
 */
export function spellPowerInputs(ch, { potencyPct = 0, pierce = 0, worn = null } = {}) {
  let list = worn ?? ch?.worn;
  if (list == null) {
    if (ch?.items != null) {
      throw new Error('spellPowerInputs: the build has no equipped (`worn`) list; inventory items are not equipped gear');
    }
    list = [];
  }
  if (!Array.isArray(list)) throw new TypeError('spellPowerInputs: the equipped list must be an array');
  const equipped = equipList(list);
  let potency = 0;
  let surge = null;
  let piercePower = null;
  let extraSpellPts = false;
  const seen = new Set(); // wornPowers counts a power ONCE by id (lootPowers.js:247-253)
  for (const it of equipped) {
    for (const a of validItemLines(it)) if (a.id === 'potency') potency += a.value | 0;
    if (!extraSpellPts) extraSpellPts = enchantmentRows(it).some((e) => e.type === ENCHANTMENT_TYPES.ExtraSpellPts);
    for (const id of powerIdsOf(it)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const power = powerOf(id);
      if (!power) continue;
      if (power.kind === 'surge' && !surge) surge = power;
      else if (power.kind === 'pierce' && !piercePower) piercePower = power;
    }
  }
  if (surge && extraSpellPts && declaresMaxMagickaBase(ch) && ch?._enchantMods?.maxMagicka == null) {
    throw new Error('spellPowerInputs: a base `maxMagickaBase` with ExtraSpellPts requires ch._enchantMods.maxMagicka (the fold)');
  }
  potency = Math.min(POTENCY_CAP, potency);
  const maxMagicka = liveMaxMagicka(ch);
  if (
    surge &&
    maxMagicka > 0 &&
    Number.isFinite(ch.magicka) &&
    ch.magicka > (maxMagicka * (surge.above ?? 0)) / 100
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
