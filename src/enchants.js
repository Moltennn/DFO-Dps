/*
 * dfo-dps - item enchantments and loot-affix procs.
 *
 * A Cast When Strikes row is `{type: 2, param: <SPELLS.STD index>}`.
 * It rides the Strikes payload on a qualifying blow (the row's own guard
 * plus the item/whole gates; enchantments.js CastWhenStrikes), with the
 * spell's own saving throw. Potent Vs is +5 flat on a qualifying blow
 * against one affinity; Low Damage Vs is -5. The payload walk stops at the
 * first enchantment type the vendored REGISTRY does not answer.
 */
import { MAGIC_ROUND_SECONDS, standardSpells } from './spells.js';
import { spellDamage } from './spells.js';

export const ENCHANTMENT_TYPES = Object.freeze({
  None: -1,
  CastWhenUsed: 0,
  CastWhenHeld: 1,
  CastWhenStrikes: 2,
  ExtraSpellPts: 3,
  PotentVs: 4,
  RegensHealth: 5,
  VampiricEffect: 6,
  IncreasedWeightAllowance: 7,
  RepairsObjects: 8,
  AbsorbsSpells: 9,
  EnhancesSkill: 10,
  FeatherWeight: 11,
  StrengthensArmor: 12,
  ImprovesTalents: 13,
  GoodRepWith: 14,
  SoulBound: 15,
  ItemDeteriorates: 16,
  UserTakesDamage: 17,
  VisionProblems: 18,
  WalkingProblems: 19,
  LowDamageVs: 20,
  HealthLeech: 21,
  BadReactionsFrom: 22,
  ExtraWeight: 23,
  WeakensArmor: 24,
  BadRepWith: 25,
  SpecialArtifactEffect: 26,
});

export const ENHANCE_SKILL_MOD = 15;
export const POTENT_VS_FLAT = 5;
const AFFINITY = Object.freeze({ 0: 'undead', 1: 'daedra', 2: 'humanoid', 3: 'animal' });

export const enchantmentRows = (item) => (item?.enchantments ?? []).filter((e) => e && e.type >= 0);

/**
 * The classic types `vendor:systems/enchantments.js`'s REGISTRY answers (`:509-980`). `doItemEnchantmentPayloads`
 * RETURNS at the first row whose `REGISTRY.get(type)` is undefined (`:1052-1060`), so every later row - Strikes rows
 * included - never runs. `VisionProblems` (18) and `WalkingProblems` (19) are the two classic keys the registry does
 * not answer; any type outside 0..26 is also unknown. A second list would drift, so `test/cwsDifferential.test.js`
 * checks this set against the vendored registry's own payload walk.
 */
export const REGISTERED_ENCHANTMENT_TYPES = new Set(
  Array.from({ length: 27 }, (_, i) => i).filter((t) => t !== ENCHANTMENT_TYPES.VisionProblems && t !== ENCHANTMENT_TYPES.WalkingProblems),
);

/** The rows the payload walk actually reaches: item order, up to (not including) the first unregistered type. */
export function payloadRows(item) {
  const out = [];
  for (const e of enchantmentRows(item)) {
    if (!REGISTERED_ENCHANTMENT_TYPES.has(e.type)) break;
    out.push(e);
  }
  return out;
}

/** The held fold: EnhancesSkill is +15 to its param. The save's own
 *  `_enchantMods` is the live copy; this rebuilds it for a raw save. */
export function rebuildEnchantMods(items) {
  const skillMods = {};
  let chanceToHitMod = 0;
  for (const item of items ?? []) {
    for (const e of enchantmentRows(item)) {
      if (e.type === ENCHANTMENT_TYPES.EnhancesSkill) {
        const id = Number(e.param);
        if (id >= 0 && id < 35) skillMods[id] = (skillMods[id] ?? 0) + ENHANCE_SKILL_MOD;
      }
    }
  }
  return { skillMods, chanceToHitMod };
}

/** Cast When Strikes rows, resolved through the standard spellbook. */
export function castWhenStrikes(item, standard = standardSpells()) {
  const out = [];
  for (const e of payloadRows(item)) {
    if (e.type !== ENCHANTMENT_TYPES.CastWhenStrikes) continue;
    const sp = standard.get(Number(e.param));
    if (sp) out.push(sp);
  }
  return out;
}

/** The expected extra damage from one landed blow: each proc's spell
 *  damage plus the flat Potent Vs / Low Damage Vs rows. */
export function strikeEnchantments(item, ch, target, {
  level = ch?.level ?? 1,
  potencyPct = 0,
  pierce = 0,
  standard = standardSpells(),
} = {}) {
  const procs = [];
  let procDamage = 0;
  let procDamageMin = 0;
  let procDamageMax = 0;
  let procDot = 0;
  let procDotMin = 0;
  let procDotMax = 0;
  for (const sp of castWhenStrikes(item, standard)) {
    const d = spellDamage(sp, ch, target, { level, potencyPct, pierce });
    const dMin = spellDamage(sp, ch, target, { level, potencyPct, pierce, mode: 'min' });
    const dMax = spellDamage(sp, ch, target, { level, potencyPct, pierce, mode: 'max' });
    // A strike proc's DoT refreshes; it does not stack its whole duration on every hit.
    procDamage += d.instant;
    procDamageMin += dMin.instant;
    procDamageMax += dMax.instant;
    procDot += d.dotPerTick;
    procDotMin += dMin.dotPerTick;
    procDotMax += dMax.dotPerTick;
    procs.push({ name: sp.name, index: sp.index, damage: d.instant, min: dMin.instant, max: dMax.instant, dotTick: d.dotPerTick, dotRounds: d.dotRounds });
  }
  let flat = 0;
  for (const e of payloadRows(item)) {
    const group = AFFINITY[e.param];
    if (!group) continue;
    if (e.type === ENCHANTMENT_TYPES.PotentVs && target?.group === group) flat += POTENT_VS_FLAT;
    if (e.type === ENCHANTMENT_TYPES.LowDamageVs && target?.group === group) flat -= POTENT_VS_FLAT;
  }
  return { procDamage, procDamageMin, procDamageMax, procDot, procDotMin, procDotMax, flat, procs };
}

/** Expected enchant damage per landed blow and per second. */
export function enchantDps(item, ch, target, {
  hit = 1, aps = 1, level = ch?.level ?? 1, potencyPct = 0, pierce = 0, cap = 0, standard,
} = {}) {
  // `standard` lets a caller (a test, or a snapshot of the spellbook) supply SPELLS.STD instead of ARENA2.
  const s = strikeEnchantments(item, ch, target, { level, potencyPct, pierce, ...(standard ? { standard } : {}) });
  // Each Cast When Strikes spell is its own hit, so each gets its own per-hit cap.
  const capOne = (v) => (cap > 0 ? Math.min(v, cap) : v);
  const procDamage = s.procs.reduce((a, p) => a + capOne(p.damage), 0);
  const procDamageMin = s.procs.reduce((a, p) => a + capOne(p.min), 0);
  const procDamageMax = s.procs.reduce((a, p) => a + capOne(p.max), 0);
  const procDot = s.procs.reduce((a, p) => a + capOne(p.dotTick ?? 0), 0);
  const procDotMin = cap > 0 ? Math.min(s.procDotMin ?? 0, cap) : (s.procDotMin ?? 0);
  const procDotMax = cap > 0 ? Math.min(s.procDotMax ?? 0, cap) : (s.procDotMax ?? 0);
  // Potent Vs / Low Damage Vs are NOT priced here any more: they are the blow's own Strikes payload
  // (formulas.js:826-840, enchantments.js:1068), read by src/model.js `strikesNet` where the game applies them -
  // after the defence and the off hand's share, to a swing that missed too - so the item and `with({ potentVs })`
  // are one calculation (Stage 2.11a). `s.flat` stays on the result for the card's text.
  const perSwing = hit * procDamage;
  const perSwingMin = hit * procDamageMin;
  const perSwingMax = hit * procDamageMax;
  const dotDps = procDot / MAGIC_ROUND_SECONDS;
  const dotDpsMin = procDotMin / MAGIC_ROUND_SECONDS;
  const dotDpsMax = procDotMax / MAGIC_ROUND_SECONDS;
  return {
    ...s, procDamage, procDamageMin, procDamageMax, procDot,
    perSwing, perSwingMin, perSwingMax,
    dps: perSwing * aps + dotDps,
    dpsMin: perSwingMin * aps + dotDpsMin,
    dpsMax: perSwingMax * aps + dotDpsMax,
    dotDps, dotDpsMin, dotDpsMax,
  };
}

/**
 * How many Cast When Strikes BILLS an item's remaining condition can pay in full: `floor(condition / 10)`, 10 per row
 * (`vendor:systems/enchantments.js:115`, `:585-602`).
 *
 * This is a BILL-ONLY figure. It ignores ordinary wear, which the same blow pays first (`damageEquipment`,
 * `vendor:combat/formulas.js:569-597`: `trunc((10 * damage + 50) / 100)` of the damage that went through the core), so a
 * hard-hitting weapon is worn out by blows well before its bills are. It is also not a cast count: the row walk casts first
 * and bills after, so the cast that exhausts the item is real and is not in this number, and every later row of the same blow
 * still casts and pays. Read it as "the most CWS bills this condition covers if nothing else wears the weapon", and take casts,
 * breaks and weapon lifetime from `simulateFights({ durability: true })` (`durability.breakProbability`,
 * `timeToFirstBreak`), which pays both. It is not a prediction of procs before the weapon breaks.
 */
export function cwsBillCapacity(item) {
  const cond = Number(item?.currentCondition);
  const max = Number(item?.maxCondition);
  if (!Number.isFinite(cond) || cond <= 0) return null;
  if (!Number.isFinite(max) || max <= 0) return null;
  return Math.floor(cond / 10);
}

/** What `procsBeforeBreak` counts - carried beside it so no consumer reads it as a cast or lifetime prediction. */
export const PROCS_BEFORE_BREAK_BASIS = 'cws-bill-only';

/** The CLI/report words for the bill-only figure; one home so every surface says the same thing. */
export const billCapacityNote = (n) => `${n} CWS bills of 10 covered (bill-only; ordinary wear shortens it)`;

/**
 * Kept for API compatibility (CLI JSON, `analyze().procsBeforeBreak`): the SAME number as `cwsBillCapacity`, with its
 * original name. The name is misleading - it is a bill-only bound, not procs before the weapon breaks; see
 * `cwsBillCapacity` and `PROCS_BEFORE_BREAK_BASIS`.
 */
export function procsBeforeBreak(item) {
  return cwsBillCapacity(item);
}
