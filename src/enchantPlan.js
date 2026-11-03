/*
 * dfo-dps - the item maker's budget and a per-piece enchant plan.
 *
 * The budget is the template's own enchantmentPoints (the game's
 * ItemTemplates.txt, vendored) plus 5,000 when a soul gem is used. A
 * POWER prices positive and a SIDE EFFECT negative in the game's table.
 * The plan is a priority fill, not a proof: one-piece effects are placed
 * once, then the build's skills are added where they fit.
 */
import { SKILLS, WEAPONS } from './data.js';
import { maxCharacter, maxRun } from './maxprofile.js';
import { imprintsFor, powerDps } from './imprints.js';
import { referenceFoe } from './model.js';
import { enchantDps, ENCHANTMENT_TYPES } from './enchants.js';
import {
  ITEM_ENCHANTMENT_MAX, defaultParam, enchantmentCost, enchantmentName, enchantmentParamName, itemEnchantmentPoints, itemTemplate,
} from './enchantData.js';

export const SOUL_GEM_POINTS = 5000;

const ARMOR = [102, 103, 104, 105, 106, 107, 108];
const SHIELD_DEFAULT = 111;
const JEWELRY = [133, 138, 135, 135, 134, 134, 136, 136, 137, 137];

const SLOT_NAMES = Object.freeze({
  102: 'Cuirass', 103: 'Gauntlets', 104: 'Greaves', 105: 'Left Pauldron', 106: 'Right Pauldron',
  107: 'Helm', 108: 'Boots', 109: 'Buckler', 110: 'Round Shield', 111: 'Kite Shield', 112: 'Tower Shield',
  133: 'Amulet', 134: 'Bracer', 135: 'Ring', 136: 'Bracelet', 137: 'Mark', 138: 'Torc', 139: 'Cloth Amulet',
});

const GROUP_PARAM = Object.freeze({ undead: 0, daedra: 1, humanoid: 2, animal: 3 });

const ONE_PIECE = Object.freeze([
  { type: 'StrengthensArmor', why: 'the armor channel is a min-set: a second copy still gives -5' },
  { type: 'AbsorbsSpells', why: 'a boolean: one piece already absorbs' },
  { type: 'IncreasedWeightAllowance', param: 1, why: 'the carry channel takes the maximum, not the sum' },
  { type: 'RepairsObjects', why: 'one mend target per 4 rounds; extra copies add no more mends' },
]);

const STACKS = Object.freeze([
  { type: 'EnhancesSkill', why: 'each piece adds +15 to the skill, and different skills can share a piece' },
  { type: 'ExtraSpellPts', why: 'each piece adds its +75 spell points while its condition holds' },
  { type: 'RegensHealth', why: 'each piece ticks its own +1 every 4 rounds' },
]);

const WEAPON_ONLY = Object.freeze([
  { type: 'CastWhenStrikes', why: 'the strike payload fires only from the weapon that struck' },
  { type: 'PotentVs', why: 'a strike payload: only the weapon that struck reads it' },
  { type: 'LowDamageVs', why: 'a strike payload: only the weapon that struck reads it' },
]);

const equipName = (t) => itemTemplate(t)?.name ?? SLOT_NAMES[t] ?? String(t);

function piece(slot, template) {
  return {
    slot, template, item: equipName(template),
    base: itemEnchantmentPoints(template), soul: 0, budget: itemEnchantmentPoints(template),
    effects: [],
  };
}

/** The standard equipped set; a two-handed weapon drops the shield unless one is named. */
export function gearPieces({ weapon = 123, shield = 'auto' } = {}) {
  const t = Number(weapon);
  if (!WEAPONS[t]) throw new Error(`unknown weapon template ${weapon}`);
  const w = WEAPONS[t];
  const noShield = w.twoHanded || w.ranged || w.skill === 'HandToHand';
  const pieces = [piece('Weapon', t)];
  for (const a of ARMOR) pieces.push(piece(SLOT_NAMES[a], a));
  const shieldIndex = shield === 'none' ? null : shield === 'auto' ? (noShield ? null : SHIELD_DEFAULT) : Number(shield);
  if (shieldIndex && itemTemplate(shieldIndex)) pieces.push(piece(SLOT_NAMES[shieldIndex] ?? 'Shield', shieldIndex));
  const seen = new Map();
  for (const j of JEWELRY) {
    const n = (seen.get(j) ?? 0) + 1;
    seen.set(j, n);
    pieces.push(piece(`${SLOT_NAMES[j]} ${n}`, j));
  }
  return pieces;
}

function addEffect(p, type, param, cost) {
  const value = param === undefined ? defaultParam(type) : param;
  if (p.effects.some((e) => e.type === type && e.param === value)) return false;
  if (p.effects.length >= ITEM_ENCHANTMENT_MAX) return false;
  if (cost > p.budget - p.spent) return false;
  p.effects.push({ type, param: value, cost, name: enchantmentName(type), paramName: enchantmentParamName(type, value) });
  p.spent += cost;
  return true;
}

function skillIdOf(template) {
  const w = WEAPONS[template];
  return w ? SKILLS[w.skill] : SKILLS.LongBlade;
}

const skillIdsFor = (template) => [...new Set([skillIdOf(template), SKILLS.CriticalStrike, SKILLS.Backstabbing])];

/** The next +15-skill DPS, after the points already planned (`extra`). */
function skillGain(ch, base, id, extra = {}) {
  const c = JSON.parse(JSON.stringify(ch));
  for (const [sid, points] of Object.entries(extra)) {
    c._mods.skills = { ...(c._mods.skills ?? {}), [sid]: (c._mods.skills?.[sid] ?? 0) + points };
  }
  c._mods.skills = { ...(c._mods.skills ?? {}), [id]: (c._mods.skills?.[id] ?? 0) + 15 };
  return Math.max(0, maxRun(c).dps - base.dps);
}

/** The weapon's strike candidates, priced by their actual spell DPS. */
function weaponCandidates(ch, base, group) {
  const target = referenceFoe(45, 'tough');
  const out = [];
  for (const param of [50, 53, 52, 54, 56, 33, 20, 25, 16, 7, 55, 67]) {
    const cost = enchantmentCost('CastWhenStrikes', param);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    const dps = enchantDps({ enchantments: [{ type: ENCHANTMENT_TYPES.CastWhenStrikes, param }] }, ch, target, {
      hit: base.hit.hit, aps: base.cadence.aps,
    }).dps;
    if (dps > 0) out.push({ type: 'CastWhenStrikes', param, cost, value: dps, label: enchantmentParamName('CastWhenStrikes', param) });
  }
  const pv = GROUP_PARAM[String(group).toLowerCase()] ?? 2;
  out.push({ type: 'PotentVs', param: pv, cost: enchantmentCost('PotentVs', pv), value: 5 * base.hit.hit * base.cadence.aps, label: enchantmentParamName('PotentVs', pv) });
  for (const id of skillIdsFor(ch._template)) {
    const value = skillGain(ch, base, id);
    if (value > 0) out.push({ type: 'EnhancesSkill', param: id, cost: enchantmentCost('EnhancesSkill', id), value, label: enchantmentParamName('EnhancesSkill', id) });
  }
  return out.filter((x) => x.value > 0 && Number.isFinite(x.cost)).sort((a, b) => b.value / b.cost - a.value / a.cost);
}

/** A priority plan: one-piece utilities first, then skills, then regeneration. */
export function planEnchants({ weapon = 123, shield = 'auto', soulGem = false, skill = null, group = 'humanoid' } = {}) {
  const pieces = gearPieces({ weapon, shield });
  for (const p of pieces) {
    p.soul = soulGem ? SOUL_GEM_POINTS : 0;
    p.budget = p.base + p.soul;
    p.spent = 0;
    p.effects = [];
  }
  const w = pieces[0];
  const ch = maxCharacter(w.template, {});
  ch._template = w.template;
  const base = maxRun(ch);
  const skillId = skill == null ? skillIdOf(w.template) : Number(skill);
  const extra = {};

  // Weapon: strike procs first, then the best skill line if it still pays.
  for (const c of weaponCandidates(ch, base, group)) {
    if (w.effects.length >= ITEM_ENCHANTMENT_MAX) break;
    if (addEffect(w, c.type, c.param, c.cost) && c.type === 'EnhancesSkill') extra[c.param] = (extra[c.param] ?? 0) + 15;
  }

  // One-piece utilities: shield/helm first, then whatever has room.
  const order = pieces.slice(1).sort((a, b) => b.budget - a.budget);
  for (const u of ONE_PIECE) {
    const cost = enchantmentCost(u.type, u.param);
    const host = order.find((p) => p.spent + cost <= p.budget && p.effects.length < ITEM_ENCHANTMENT_MAX);
    if (host) addEffect(host, u.type, u.param, cost);
  }

  // Skills: every piece that can hold +15 adds the best skill it can fit, with
  // the cap already paid by earlier pieces taken into account.
  for (const p of pieces.slice(1)) {
    for (;;) {
      let best = null;
      for (const id of skillIdsFor(w.template)) {
        if (skill != null && id !== skillId) continue;
        if (p.effects.some((e) => e.type === 'EnhancesSkill' && e.param === id)) continue;
        const cost = enchantmentCost('EnhancesSkill', id);
        if (cost > p.budget - p.spent) continue;
        const value = skillGain(ch, base, id, extra);
        if (value <= 0) continue;
        if (!best || value / cost > best.value / best.cost) best = { id, cost, value };
      }
      if (!best || !addEffect(p, 'EnhancesSkill', best.id, best.cost)) break;
      extra[best.id] = (extra[best.id] ?? 0) + 15;
    }
  }

  // Regeneration is the last useful sink; it is per-piece, so it stacks.
  const regenCost = enchantmentCost('RegensHealth', 0);
  for (const p of pieces.slice(1)) {
    addEffect(p, 'RegensHealth', 0, regenCost);
  }

  const rows = pieces.map((p) => ({
    slot: p.slot, template: p.template, item: p.item,
    base: p.base, soul: p.soul, budget: p.budget, spent: p.spent, left: p.budget - p.spent,
    effects: p.effects,
  }));
  const imprintPool = imprintsFor(w.template)
    .map((rec) => ({ name: rec.name, power: rec.power, baseDps: powerDps(rec.power, base, false), triggerDps: powerDps(rec.power, base, true) }));
  const imprintBase = imprintPool.slice().sort((a, b) => b.baseDps - a.baseDps)[0] ?? null;
  const imprintTrigger = imprintPool.slice().sort((a, b) => b.triggerDps - a.triggerDps)[0] ?? null;
  const imprint = { base: imprintBase, trigger: imprintTrigger };
  return {
    weapon: w.template, weaponName: w.item, shield: pieces.find((p) => /Shield|Buckler/.test(p.slot))?.template ?? null,
    soulGem: !!soulGem, soulPoints: soulGem ? SOUL_GEM_POINTS : 0,
    group, baseDps: base.dps, skillId, rows, imprint,
    onePiece: ONE_PIECE, stacks: STACKS, weaponOnly: WEAPON_ONLY,
  };
}

/** Readable effect line, e.g. "Cast When Strikes: Hand of Decay (1,830)". */
export const effectLine = (e) => `${e.name}${e.paramName && e.paramName !== 'undefined' ? `: ${e.paramName}` : ''} (${e.cost.toLocaleString()})`;
