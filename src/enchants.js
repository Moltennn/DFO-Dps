/*
 * dfo-dps - item enchantments and loot-affix procs.
 *
 * A Cast When Strikes row is `{type: 2, param: <SPELLS.STD index>}`.
 * It fires on every landed blow, not on a chance, with the spell's own
 * saving throw (enchantments.js CastWhenStrikes). Potent Vs is +5 flat
 * on a landed blow against one affinity; Low Damage Vs is -5.
 */
import { standardSpells } from './spells.js';
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
const AFFIX_GROUP = Object.freeze({ undead: 'undead', daedra: 'daedra', humanoid: 'humanoid', animal: 'animal' });

export const enchantmentRows = (item) => (item?.enchantments ?? []).filter((e) => e && e.type >= 0);

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
  for (const e of enchantmentRows(item)) {
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
  for (const sp of castWhenStrikes(item, standard)) {
    const d = spellDamage(sp, ch, target, { level, potencyPct, pierce });
    procDamage += d.damage;
    procs.push({ name: sp.name, index: sp.index, damage: d.damage });
  }
  let flat = 0;
  for (const e of enchantmentRows(item)) {
    const group = AFFINITY[e.param];
    if (!group) continue;
    if (e.type === ENCHANTMENT_TYPES.PotentVs && target?.group === group) flat += POTENT_VS_FLAT;
    if (e.type === ENCHANTMENT_TYPES.LowDamageVs && target?.group === group) flat -= POTENT_VS_FLAT;
  }
  return { procDamage, flat, procs };
}

/** Expected enchant damage per landed blow and per second. */
export function enchantDps(item, ch, target, {
  hit = 1, aps = 1, level = ch?.level ?? 1, potencyPct = 0, pierce = 0,
} = {}) {
  const s = strikeEnchantments(item, ch, target, { level, potencyPct, pierce });
  const perSwing = hit * (s.procDamage + s.flat);
  return { ...s, perSwing, dps: perSwing * aps };
}

/** Procs a weapon's condition can pay for (10 per Cast When Strikes). */
export function procsBeforeBreak(item) {
  const cond = Number(item?.currentCondition);
  const max = Number(item?.maxCondition);
  if (!Number.isFinite(cond) || cond <= 0) return null;
  if (!Number.isFinite(max) || max <= 0) return null;
  return Math.floor(cond / 10);
}
