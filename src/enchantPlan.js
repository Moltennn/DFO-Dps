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
import { THEORY_LEVEL } from './theory.js';
import { cappedDpsWith, maxCharacter, maxRun } from './maxprofile.js';
import { imprintsFor, powerDps } from './imprints.js';
import { gateTarget } from './model.js';
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
  { type: 'StrengthensArmor', why: 'the armor channel is a min-set: a second copy still gives -5', benefit: '-5 armor value' },
  { type: 'AbsorbsSpells', why: 'a boolean: one piece already absorbs', benefit: 'spell absorb' },
  { type: 'IncreasedWeightAllowance', param: 1, why: 'the carry channel takes the maximum, not the sum', benefit: '+50% carry' },
]);

const STACKS = Object.freeze([
  { type: 'EnhancesSkill', why: 'each piece adds +15 to the skill, and different skills can share a piece' },
  { type: 'ExtraSpellPts', why: 'each piece adds its +75 spell points while its condition holds' },
  { type: 'RegensHealth', why: 'each piece ticks its own +1 every 4 rounds; weak beside a heal spell', benefit: '+1 HP / 4 rounds (≈0.05 HP/s)' },
  { type: 'RepairsObjects', why: 'each piece runs its own mend tick; one or a few is a player choice', benefit: '1 mend / 4 rounds' },
]);

const WEAPON_ONLY = Object.freeze([
  { type: 'CastWhenStrikes', why: 'the strike payload fires only from the weapon that struck' },
  { type: 'PotentVs', why: 'a strike payload: only the weapon that struck reads it' },
  { type: 'LowDamageVs', why: 'a strike payload: only the weapon that struck reads it' },
]);

const equipName = (t) => itemTemplate(t)?.name ?? SLOT_NAMES[t] ?? String(t);
const hitPointsOf = (t) => Number(itemTemplate(t)?.hitPoints ?? 400);

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

function addEffect(p, type, param, cost, benefit = '') {
  const value = param === undefined ? defaultParam(type) : param;
  if (p.effects.some((e) => e.type === type && e.param === value)) return false;
  if (p.effects.length >= ITEM_ENCHANTMENT_MAX) return false;
  if (cost > p.budget - p.spent) return false;
  p.effects.push({ type, param: value, cost, benefit, name: enchantmentName(type), paramName: enchantmentParamName(type, value) });
  p.spent += cost;
  return true;
}

function skillIdOf(template) {
  const w = WEAPONS[template];
  return w ? SKILLS[w.skill] : SKILLS.LongBlade;
}

const skillIdsFor = (template) => [...new Set([skillIdOf(template), SKILLS.CriticalStrike])];

/** The next +15-skill boss DPS, after the points already planned (`extra`). */
function skillGain(ch, base, id, extra = {}, target) {
  const now = JSON.parse(JSON.stringify(ch));
  for (const [sid, points] of Object.entries(extra)) {
    now._mods.skills = { ...(now._mods.skills ?? {}), [sid]: (now._mods.skills?.[sid] ?? 0) + points };
  }
  const next = JSON.parse(JSON.stringify(now));
  next._mods.skills = { ...(next._mods.skills ?? {}), [id]: (next._mods.skills?.[id] ?? 0) + 15 };
  return Math.max(0, maxRun(next, { target }).cappedDps - maxRun(now, { target }).cappedDps);
}

/** The weapon's strike candidates, priced by their actual capped spell DPS. */
function weaponCandidates(ch, base, group, target) {
  const out = [];
  for (const param of [50, 53, 52, 54, 56, 33, 20, 25, 16, 7, 55, 67]) {
    const cost = enchantmentCost('CastWhenStrikes', param);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    const raw = enchantDps({ enchantments: [{ type: ENCHANTMENT_TYPES.CastWhenStrikes, param }] }, ch, target, {
      hit: base.hit.hit, aps: base.cadence.aps,
    });
    if (!(raw.dps > 0)) continue;
    // A proc is one more hit on the same boss; cap it like one.
    const perHit = raw.perSwing / Math.max(1e-9, base.hit.hit);
    const capped = base.cap > 0 ? Math.min(perHit, base.cap) : perHit;
    const value = capped * base.hit.hit * base.cadence.aps;
    if (value > 0) out.push({ type: 'CastWhenStrikes', param, cost, value, label: enchantmentParamName('CastWhenStrikes', param) });
  }
  const pv = GROUP_PARAM[String(group).toLowerCase()] ?? 2;
  const pvValue = Math.max(0, cappedDpsWith(base, { flat: 5 }) - base.cappedDps);
  if (pvValue > 0) out.push({ type: 'PotentVs', param: pv, cost: enchantmentCost('PotentVs', pv), value: pvValue, label: `${enchantmentName('PotentVs')}: ${enchantmentParamName('PotentVs', pv)}` });
  for (const id of skillIdsFor(ch._template)) {
    const value = skillGain(ch, base, id, {}, target);
    if (value > 0) out.push({ type: 'EnhancesSkill', param: id, cost: enchantmentCost('EnhancesSkill', id), value, label: enchantmentParamName('EnhancesSkill', id) });
  }
  return out.filter((x) => x.value > 0 && Number.isFinite(x.cost)).sort((a, b) => b.value / b.cost - a.value / a.cost);
}

/** A priority plan: one-piece utilities first, then skills, then regeneration. */
export function planEnchants({ weapon = 123, shield = 'auto', soulGem = false, skill = null, group = 'humanoid', repairs = 1, regen = 0, target = gateTarget(THEORY_LEVEL) } = {}) {
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
  const base = maxRun(ch, { target });
  const skillId = skill == null ? skillIdOf(w.template) : Number(skill);
  const extra = {};
  const swings = Math.max(1, Math.round((base.ttk || 20) * base.cadence.aps));
  const maxProcs = Math.max(1, Math.min(3, Math.floor(hitPointsOf(w.template) / (10 * swings))));

  // Weapon: strike procs first, limited by the condition a fight can pay, then skills.
  const weaponCands = weaponCandidates(ch, base, group, target);
  let procs = 0;
  for (const c of weaponCands) {
    if (w.effects.length >= ITEM_ENCHANTMENT_MAX) break;
    if (c.type === 'CastWhenStrikes' && procs >= maxProcs) continue;
    if (addEffect(w, c.type, c.param, c.cost, `${Math.round(c.value)} DPS`)) {
      if (c.type === 'EnhancesSkill') extra[c.param] = (extra[c.param] ?? 0) + 15;
      if (c.type === 'CastWhenStrikes') procs++;
    }
  }

  // One-piece utilities: shield/helm first, then whatever has room.
  const order = pieces.slice(1).sort((a, b) => b.budget - a.budget);
  for (const u of ONE_PIECE) {
    const cost = enchantmentCost(u.type, u.param);
    const host = order.find((p) => p.spent + cost <= p.budget && p.effects.length < ITEM_ENCHANTMENT_MAX);
    if (host) addEffect(host, u.type, u.param, cost, u.benefit);
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
        const value = skillGain(ch, base, id, extra, target);
        if (value <= 0) continue;
        if (!best || value / cost > best.value / best.cost) best = { id, cost, value };
      }
      if (!best || !addEffect(p, 'EnhancesSkill', best.id, best.cost, `${Math.round(best.value)} DPS`)) break;
      extra[best.id] = (extra[best.id] ?? 0) + 15;
    }
  }

  // QoL is a count, not an automatic fill: the player may want none, one or a few.
  const repairCost = enchantmentCost('RepairsObjects');
  const repairHosts = [w, ...pieces.slice(1).sort((a, b) => b.budget - a.budget)];
  let repairsLeft = Math.max(0, Math.trunc(Number(repairs) || 0));
  for (const p of repairHosts) {
    if (repairsLeft <= 0) break;
    if (addEffect(p, 'RepairsObjects', undefined, repairCost, '1 mend / 4 rounds')) repairsLeft--;
  }
  const regenCost = enchantmentCost('RegensHealth', 0);
  let regenLeft = Math.max(0, Math.trunc(Number(regen) || 0));
  for (const p of pieces.slice(1).sort((a, b) => b.budget - a.budget)) {
    if (regenLeft <= 0) break;
    if (addEffect(p, 'RegensHealth', 0, regenCost, '+1 HP / 4 rounds')) regenLeft--;
  }

  const rows = pieces.map((p) => ({
    slot: p.slot, template: p.template, item: p.item,
    base: p.base, soul: p.soul, budget: p.budget, spent: p.spent, left: p.budget - p.spent,
    effects: p.effects,
  }));
  const chosen = rows.flatMap((r) => r.effects);
  const chosenCount = (type, param) => chosen.filter((e) => e.type === type && (param === undefined || e.param === param)).length;
  const weaponRatings = weaponCands.map((c) => ({
    type: c.type, param: c.param, label: c.label, cost: c.cost, value: c.value, benefit: `${Math.round(c.value)} DPS`,
    chosen: chosenCount(c.type, c.param), rate: c.value / c.cost,
  }));
  const pvParam = GROUP_PARAM[String(group).toLowerCase()] ?? 2;
  if (!weaponRatings.some((r) => r.type === 'PotentVs')) {
    const pvValue = Math.max(0, cappedDpsWith(base, { flat: 5 }) - base.cappedDps);
    const pvCost = enchantmentCost('PotentVs', pvParam);
    weaponRatings.push({ type: 'PotentVs', param: pvParam, label: `${enchantmentName('PotentVs')}: ${enchantmentParamName('PotentVs', pvParam)}`, cost: pvCost, value: pvValue, benefit: `${Math.round(pvValue)} DPS`, chosen: chosenCount('PotentVs', pvParam), rate: pvCost > 0 ? pvValue / pvCost : 0 });
  }
  const skillRatings = skillIdsFor(w.template).map((id) => {
    const value = skillGain(ch, base, id, {}, target);
    const cost = enchantmentCost('EnhancesSkill', id);
    return { id, label: enchantmentParamName('EnhancesSkill', id), cost, value, benefit: `${Math.round(value)} DPS`, chosen: chosenCount('EnhancesSkill', id), rate: cost > 0 ? value / cost : 0 };
  });
  const utilityRatings = [
    ...ONE_PIECE.map((u) => ({ type: u.type, label: enchantmentName(u.type), cost: enchantmentCost(u.type, u.param), benefit: u.benefit, chosen: chosenCount(u.type, u.param) })),
    { type: 'RepairsObjects', label: enchantmentName('RepairsObjects'), cost: repairCost, benefit: '1 mend / 4 rounds', chosen: chosenCount('RepairsObjects') },
    { type: 'RegensHealth', label: enchantmentName('RegensHealth'), cost: regenCost, benefit: '+1 HP / 4 rounds (≈0.05 HP/s)', chosen: chosenCount('RegensHealth') },
    { type: 'ExtraSpellPts', label: 'Extra Spell Points', cost: enchantmentCost('ExtraSpellPts', 0), benefit: '+75 max MP', chosen: 0 },
    { type: 'VampiricEffect', label: 'Vampiric Effect (at range)', cost: enchantmentCost('VampiricEffect', 0), benefit: '+1 HP / 4 rounds per foe', chosen: 0 },
    { type: 'ImprovesTalents', label: 'Improves Talents: Athleticism', cost: enchantmentCost('ImprovesTalents', 1), benefit: 'Athleticism', chosen: 0 },
    { type: 'FeatherWeight', label: 'Feather Weight', cost: enchantmentCost('FeatherWeight'), benefit: 'weight to 0.25 kg', chosen: 0 },
  ];
  const raw = maxRun(ch);
  const imprintPool = imprintsFor(w.template)
    .map((rec) => ({
      name: rec.name, power: rec.power,
      baseDps: powerDps(rec.power, base, false, { capped: true }),
      triggerDps: powerDps(rec.power, base, true, { capped: true }),
      uncappedDps: powerDps(rec.power, raw, false),
    }));
  const imprintBase = imprintPool.slice().sort((a, b) => b.baseDps - a.baseDps)[0] ?? null;
  const imprintTrigger = imprintPool.slice().sort((a, b) => b.triggerDps - a.triggerDps)[0] ?? null;
  const imprintUncapped = imprintPool.slice().sort((a, b) => b.uncappedDps - a.uncappedDps)[0] ?? null;
  const imprint = { base: imprintBase, trigger: imprintTrigger, uncapped: imprintUncapped };
  return {
    weapon: w.template, weaponName: w.item, shield: pieces.find((p) => /Shield|Buckler/.test(p.slot))?.template ?? null,
    soulGem: !!soulGem, soulPoints: soulGem ? SOUL_GEM_POINTS : 0,
    group, baseDps: base.cappedDps, uncappedDps: raw.dps, skillId, rows, imprint, swings, maxProcs,
    repairs: Math.max(0, Math.trunc(Number(repairs) || 0)), regen: Math.max(0, Math.trunc(Number(regen) || 0)),
    ratings: { weapon: weaponRatings, skills: skillRatings, utility: utilityRatings },
    onePiece: ONE_PIECE, stacks: STACKS, weaponOnly: WEAPON_ONLY,
  };
}

/** Readable effect line, e.g. "Cast When Strikes: Hand of Decay (1,830)". */
export const effectLine = (e) => `${e.name}${e.paramName && e.paramName !== 'undefined' ? `: ${e.paramName}` : ''} (${e.cost.toLocaleString()}${e.benefit ? `; ${e.benefit}` : ''})`;
