/*
 * dfo-dps - what a piece of gear can legally carry (the maximum profile's budget).
 *
 * The maximum profile is not "30 points in every line": a line is a thing a piece has to
 * be able to hold. The rules are the game's (vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js):
 *
 *   AFFIX_RANGES          a skill line's band: Magic [5,10], Rare [10,20], Legendary [20,30] (:486)
 *   AFFIX_COUNTS          how many lines a rolled piece has: Magic 1-2, Rare 3-4 (:507)
 *   kindLines             ONE line per kind's param per piece: a skill can appear once per param (:679-682)
 *   skillKin              which skills a ROLLED line may name: a weapon its own skill and the strike's kin
 *                         (Critical Strike, Backstabbing, Dodging), armour the body's twelve, jewellery
 *                         the mind's thirteen and Hand-to-Hand/Critical Strike (:703-716, :784-788)
 *   legendariesFor        the Legendary records a piece may be minted from (group + templates) (:1310-1314)
 *   exaltLegendary        one in ten Legendaries gains ONE line of a KIND it does not already carry
 *                         (LOOT2, :1770-1790). The skill kind's PARAM is drawn evenly from every skill
 *                         (`pick(kindParams(id, item))`, :1785-1788) - the kin lean belongs to the roll's
 *                         own draw (`pickSkill`, :818-826), not to the Exalted. So an Exalted piece may
 *                         name a skill its group cannot roll, and a record that carries any skill line
 *                         can never gain another one.
 *   honeableLines         only a rolled line (Magic/Rare/Exalted's extra) may be honed, up to its band's
 *                         top; a Legendary's RECORD lines are fixed and never honed (:2243-2250)
 *
 * Consequences for the two skills the weapon pages optimise (the weapon's own skill and
 * Critical Strike):
 *
 *   - a Legendary record contributes its fixed lines: one skill line at its record value, plus its fixed
 *     damage line on a weapon;
 *   - an Exalted piece contributes ONE extra line of a kind the record lacks. If the record carries no
 *     skill line, that line may be +30 of ANY skill (the param draw is not kin-filtered);
 *   - a Rare piece contributes up to 20 + 20 for two skills its group may ROLL (the weapon's skill and
 *     Critical Strike are different params, so one line each is legal), plus a weapon's damage line at 25;
 *   - a Magic piece contributes at most two lines, so 10 + 10 or one skill and the damage line;
 *   - one piece can never contribute both 30s: one Exalted line, one kind.
 *
 * So the old profile (8 x 30 + 18 x 30 = 780 points, both skills at 30 on every piece) is illegal at
 * every shared slot. This module enumerates what is legal and leaves the choice of split to the caller.
 */
import {
  AFFIX_COUNTS, AFFIX_IDS, AFFIX_KINDS, AFFIX_RANGES,
  allLegendaries, legendariesFor, skillKin,
} from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { SKILLS, WEAPONS } from './data.js';

/** The worn body slots the skill lines can sit on (itemTemplates: Cuirass..Boots). */
export const ARMOUR_SLOTS = Object.freeze([102, 103, 104, 105, 106, 107, 108]);
/** The ten jewellery pieces: amulet, torc, two rings, two bracers, two bracelets, two marks. */
export const JEWEL_SLOTS = Object.freeze([133, 138, 135, 135, 134, 134, 136, 136, 137, 137]);
/** The band tops the bands give (AFFIX_RANGES.skill). */
export const SKILL_BAND_TOP = Object.freeze({
  magic: AFFIX_RANGES.skill.magic[1],
  rare: AFFIX_RANGES.skill.rare[1],
  legendary: AFFIX_RANGES.skill.legendary[1],
});
/** A weapon's damage line band top by rarity (AFFIX_RANGES.damage). */
export const AFFIX_DAMAGE_TOP = Object.freeze({
  magic: AFFIX_RANGES.damage.magic[1],
  rare: AFFIX_RANGES.damage.rare[1],
  legendary: AFFIX_RANGES.damage.legendary[1],
});
/** The Exalted extra's band floor is the top half's start (ceil((20 + 30) / 2)). */
export const EXALTED_SKILL_FLOOR = Math.ceil((AFFIX_RANGES.skill.legendary[0] + AFFIX_RANGES.skill.legendary[1]) / 2);
/** The game's skill ids (0..34); the Exalted's skill kind may name any of them. */
export const SKILL_IDS = Object.freeze(Array.from({ length: 35 }, (_, i) => i));

const isSkillLine = (a) => a?.id === 'skill';
const keyOf = (a) => `${a?.id}:${a?.param ?? ''}`;
const SKILL_NAME = (id) => Object.fromEntries(Object.entries(SKILLS).map(([name, value]) => [value, name]))[id] ?? `skill ${id}`;

/** The skill a weapon template actually uses (the default the budget optimises). */
export const weaponSkillOf = (templateIndex) => SKILLS[WEAPONS[templateIndex]?.skill] ?? SKILLS.LongBlade;

/** The item shape the upstream predicates read. */
const itemOf = (group, templateIndex) => ({ group, templateIndex });

/** One line's top in `rarity`'s band, or null when the kind has no such band. */
const bandTop = (id, rarity) => AFFIX_RANGES[id]?.[rarity]?.[1] ?? null;

/** The skills a ROLLED line (Magic/Rare) may name on this slot. */
export function rolledSkills(templateIndex, group) {
  const { own, kin } = skillKin(itemOf(group, templateIndex));
  return Object.freeze([...new Set([...(own == null ? [] : [own]), ...kin])].sort((a, b) => a - b));
}

/** Whether a ROLLED line on this slot may name `skill`. */
export const canRollSkill = (templateIndex, group, skill) => rolledSkills(templateIndex, group).includes(skill);

/**
 * The kinds `exaltLegendary` may draw for this record on this slot: the group's kinds it does not carry,
 * or (none left) a kind with a param its lines leave free. A record's own skill line therefore closes the
 * skill kind; a record with no skill line leaves it open (whatever the group can roll).
 */
export function exaltedKinds(record, group) {
  const carried = new Set((record?.affixes ?? []).map((a) => a?.id));
  const kinds = AFFIX_IDS.filter((id) => AFFIX_KINDS[id].groups.includes(group));
  const pool = kinds.filter((id) => !carried.has(id));
  if (pool.length) return Object.freeze(pool);
  const free = (id) => (AFFIX_KINDS[id].params ?? []).some((p) => !(record?.affixes ?? []).some((a) => a?.id === id && a.param === p));
  return Object.freeze(kinds.filter((id) => AFFIX_KINDS[id].params && free(id)));
}

/** Whether this record's Exalted extra may be a skill line at all. */
export const canExaltSkill = (record, group) => exaltedKinds(record, group).includes('skill');

/** Does any record that fits this slot leave the skill kind open for its Exalted line? */
export function canExaltSkillHere(templateIndex, group) {
  return legendariesFor(itemOf(group, templateIndex)).some((r) => canExaltSkill(r, group));
}

/**
 * The legal contributions one slot can make to (weaponSkill, Critical Strike, damage), as a Pareto set.
 * `skill` is the weapon's own skill id (SKILLS.LongBlade for a long blade); for armour and jewellery it
 * is the build's weapon skill. Damage is a weapon-only line.
 */
export function slotOptions(templateIndex, group, skill) {
  const item = itemOf(group, templateIndex);
  const out = [];
  const add = (lb, cs, dmg, piece) => {
    if (lb > 0 || cs > 0 || dmg > 0) out.push({ lb, cs, dmg, piece: { ...piece, group, template: templateIndex } });
  };
  const rollSkill = (id) => canRollSkill(templateIndex, group, id);
  const weapon = group === 'Weapons';

  // A Rare: 3-4 lines, up to one per skill param, a weapon's damage line at its band top.
  {
    const lines = [];
    if (rollSkill(skill)) lines.push({ id: 'skill', param: skill, value: SKILL_BAND_TOP.rare });
    if (rollSkill(SKILLS.CriticalStrike)) lines.push({ id: 'skill', param: SKILLS.CriticalStrike, value: SKILL_BAND_TOP.rare });
    const dmg = weapon ? AFFIX_DAMAGE_TOP.rare : 0;
    if (dmg) lines.push({ id: 'damage', value: dmg });
    add(rollSkill(skill) ? SKILL_BAND_TOP.rare : 0, rollSkill(SKILLS.CriticalStrike) ? SKILL_BAND_TOP.rare : 0, dmg, { rarity: 'rare', lines });
  }
  // A Magic: 1-2 lines only, so at most two of the three channels. All of these are dominated by the
  // Rare line above; they are enumerated so the validator and tests see the whole law.
  {
    const choices = [
      { skill: true, cs: true, dmg: false },
      { skill: true, cs: false, dmg: true },
      { skill: false, cs: true, dmg: true },
    ];
    for (const c of choices) {
      const lines = [];
      const lb = c.skill && rollSkill(skill) ? SKILL_BAND_TOP.magic : 0;
      const cs = c.cs && rollSkill(SKILLS.CriticalStrike) ? SKILL_BAND_TOP.magic : 0;
      const dmg = c.dmg && weapon ? AFFIX_DAMAGE_TOP.magic : 0;
      if (lb) lines.push({ id: 'skill', param: skill, value: lb });
      if (cs) lines.push({ id: 'skill', param: SKILLS.CriticalStrike, value: cs });
      if (dmg) lines.push({ id: 'damage', value: dmg });
      add(lb, cs, dmg, { rarity: 'magic', lines });
    }
  }

  // Legendary records: their fixed lines, and (one in ten) ONE Exalted line of a kind they lack.
  for (const r of legendariesFor(item)) {
    const fixed = (r.affixes ?? []).filter((a) => a?.id !== 'gem');
    const dmg = Number(fixed.find((a) => a.id === 'damage')?.value) || 0;
    const skillLine = fixed.find((a) => isSkillLine(a) && a.param === skill);
    const critLine = fixed.find((a) => isSkillLine(a) && a.param === SKILLS.CriticalStrike);
    add(
      skillLine ? Math.min(skillLine.value, SKILL_BAND_TOP.legendary) : 0,
      critLine ? Math.min(critLine.value, SKILL_BAND_TOP.legendary) : 0,
      dmg,
      { rarity: 'legendary', record: r.id, lines: fixed.map((a) => ({ ...a })) },
    );
    if (canExaltSkill(r, group)) {
      // The Exalted's skill param is NOT kin-filtered upstream (exaltLegendary's pick over kindParams):
      // any skill the kind names may land, then honed to the band's top.
      for (const id of [skill, SKILLS.CriticalStrike]) {
        add(id === skill ? SKILL_BAND_TOP.legendary : 0, id === SKILLS.CriticalStrike ? SKILL_BAND_TOP.legendary : 0, dmg, {
          rarity: 'legendary',
          record: r.id,
          exalted: true,
          lines: [...fixed.map((a) => ({ ...a })), { id: 'skill', param: id, value: SKILL_BAND_TOP.legendary }],
        });
      }
    }
  }

  // Pareto frontier over the three channels, one entry per point.
  const seen = new Map();
  for (const o of out) seen.set(`${o.lb},${o.cs},${o.dmg}`, o);
  const unique = [...seen.values()];
  return unique
    .filter((a) => !unique.some((b) => b !== a && b.lb >= a.lb && b.cs >= a.cs && b.dmg >= a.dmg && (b.lb > a.lb || b.cs > a.cs || b.dmg > a.dmg)))
    .sort((a, b) => b.lb - a.lb || b.cs - a.cs || b.dmg - a.dmg);
}

/** The slot templates for a build: the weapon, the seven body pieces, the ten jewellery pieces (and a shield). */
export function slotsFor({ weaponTemplate = 123, shield = null } = {}) {
  const out = [{ kind: 'weapon', template: weaponTemplate, group: 'Weapons' }];
  for (const t of ARMOUR_SLOTS) out.push({ kind: 'armour', template: t, group: 'Armor' });
  for (const t of JEWEL_SLOTS) out.push({ kind: 'jewellery', template: t, group: 'Jewellery' });
  if (shield) out.push({ kind: 'shield', template: shield, group: 'Armor' });
  return out;
}

/** Pareto over (lb, cs, dmg) totals, or over (lb, cs) alone when damage is not an objective. */
function pareto(points, withDamage = true) {
  const unique = new Map();
  for (const p of points) unique.set(`${p.lb},${p.cs},${p.dmg}`, p);
  const list = [...unique.values()];
  return list
    .filter((a) => !list.some((b) => {
      if (b === a) return false;
      const channels = withDamage ? b.lb >= a.lb && b.cs >= a.cs && b.dmg >= a.dmg : b.lb >= a.lb && b.cs >= a.cs;
      const better = withDamage ? b.lb > a.lb || b.cs > a.cs || b.dmg > a.dmg : b.lb > a.lb || b.cs > a.cs;
      return channels && better;
    }))
    .sort((a, b) => b.lb - a.lb || b.cs - a.cs || b.dmg - a.dmg);
}

/**
 * Every legal total the slots can reach, Pareto-reduced. Each total carries the per-slot choice that made
 * it (`plan`), so a caller can present or validate the exact plan. `withDamage` false reduces over the
 * two skill channels alone (the point budget), ignoring the weapon's damage line.
 */
function buildTotals({ weaponTemplate = 123, skill = weaponSkillOf(weaponTemplate), shield = null } = {}, withDamage) {
  const slots = slotsFor({ weaponTemplate, shield });
  let frontier = [{ lb: 0, cs: 0, dmg: 0, plan: [] }];
  for (const slot of slots) {
    const options = slotOptions(slot.template, slot.group, skill);
    const next = [];
    for (const f of frontier) {
      for (const o of options) {
        next.push({
          lb: f.lb + o.lb,
          cs: f.cs + o.cs,
          dmg: Math.max(f.dmg, o.dmg),
          plan: [...f.plan, { ...o.piece, lb: o.lb, cs: o.cs, dmg: o.dmg }],
        });
      }
    }
    frontier = pareto(next, withDamage);
  }
  return frontier;
}

/** The DPS frontier: points no other legal point beats in skill AND damage. */
export const legalTotals = (opts) => buildTotals(opts, true);

/** The point frontier: totals no other legal point beats in the two skill channels (damage ignored). */
export const legalPointTotals = (opts) => buildTotals(opts, false);

/** The highest combined (weapon skill + Critical Strike) total the slots can reach. */
export function maxPointTotal(opts = {}) {
  return legalPointTotals(opts).reduce((m, p) => Math.max(m, p.lb + p.cs), 0);
}

/** The highest single skill the slots can reach (all legal lines spent on one skill). */
export function maxSingleSkill({ weaponTemplate = 123, skill = weaponSkillOf(weaponTemplate), shield = null } = {}) {
  return legalPointTotals({ weaponTemplate, skill, shield }).reduce(
    (m, p) => Math.max(m, skill === SKILLS.CriticalStrike ? p.cs : p.lb),
    0,
  );
}

/**
 * Check a plan against the rules, clearly. `plan` is a list of pieces
 * `{ template, group, rarity, lines: [{ id, param, value }], record?, exalted? }`.
 * `lines` lists the lines that matter to the caller; a rolled piece may carry its other rolled lines
 * (a Rare's 3-4) that no caller reads. Answers an array of human-readable violations (empty when legal).
 */
export function validatePlan(plan) {
  const bad = [];
  for (const piece of plan ?? []) {
    const item = itemOf(piece.group, piece.template);
    const lines = piece.lines ?? [];
    const skills = lines.filter(isSkillLine);

    if (piece.rarity === 'legendary') {
      const record = legendariesFor(item).find((r) => r.id === piece.record);
      if (!record) {
        bad.push(`${piece.template}: no Legendary record "${piece.record}" fits this piece`);
        continue;
      }
      const carried = new Set((record.affixes ?? []).map((a) => a?.id));
      const fixed = new Map((record.affixes ?? []).filter((a) => a?.id !== 'gem').map((a) => [keyOf(a), a]));
      if (canExaltSkill(record, piece.group) === false && piece.exalted) bad.push(`${piece.template}: this record has no free kind to exalt`);
      let extras = 0;
      for (const a of lines) {
        const own = fixed.get(keyOf(a));
        if (own) {
          if (a.value !== own.value) bad.push(`${piece.template}: ${keyOf(a)} is fixed at ${own.value}, not ${a.value}`);
          continue;
        }
        extras += 1;
        if (!piece.exalted) bad.push(`${piece.template}: ${keyOf(a)} is not this record's line`);
        if (carried.has(a.id)) bad.push(`${piece.template}: the Exalted line repeats a carried kind (${a.id})`);
        const kind = AFFIX_KINDS[a.id];
        if (!kind) {
          bad.push(`${piece.template}: "${a.id}" is not an affix kind`);
          continue;
        }
        if (kind.params ? !kind.params.includes(a.param) : a.param !== undefined) bad.push(`${piece.template}: ${a.param} is not a ${a.id} param`);
        const top = bandTop(a.id, 'legendary');
        if (top == null) bad.push(`${piece.template}: no Legendary band for a ${a.id} line`);
        else if (a.value > top) bad.push(`${piece.template}: ${a.id} ${a.value} is above the Legendary band (${top})`);
        const floor = AFFIX_RANGES[a.id] ? Math.ceil((AFFIX_RANGES[a.id].legendary[0] + AFFIX_RANGES[a.id].legendary[1]) / 2) : null;
        if (floor != null && a.value < floor) bad.push(`${piece.template}: an Exalted ${a.id} line starts at ${floor}`);
      }
      if (extras > 1) bad.push(`${piece.template}: one Exalted line only`);
      if (piece.exalted && extras === 0) bad.push(`${piece.template}: marked exalted but carries no Exalted line`);
    } else {
      if (piece.rarity !== 'magic' && piece.rarity !== 'rare') bad.push(`${piece.template}: unknown rarity "${piece.rarity}"`);
      const maxLines = AFFIX_COUNTS[piece.rarity]?.[1] ?? 0;
      if (lines.length > maxLines) bad.push(`${piece.template}: too many lines for a ${piece.rarity}`);
      for (const a of lines) {
        const kind = AFFIX_KINDS[a.id];
        if (!kind) {
          bad.push(`${piece.template}: "${a.id}" is not an affix kind`);
          continue;
        }
        if (kind.params ? !kind.params.includes(a.param) : a.param !== undefined) bad.push(`${piece.template}: ${a.param} is not a ${a.id} param`);
        const top = bandTop(a.id, piece.rarity);
        if (top == null) {
          bad.push(`${piece.template}: no ${piece.rarity} band for a ${a.id} line`);
          continue;
        }
        if (a.id === 'skill' && !canRollSkill(piece.template, piece.group, a.param)) {
          bad.push(`${piece.template}: ${SKILL_NAME(a.param)} is not a skill a ${piece.rarity} ${piece.group} piece may roll`);
        }
        if (Number.isFinite(a.value) && a.value > top) bad.push(`${piece.template}: ${a.id} ${a.value} is above the ${piece.rarity} band (${top})`);
      }
    }
    if (new Set(skills.map((a) => a.param)).size !== skills.length) bad.push(`${piece.template}: one line per skill param`);
  }
  return bad;
}

/** The Legendary records that fit one slot, for display and for tests. */
export function recordsFor(templateIndex, group) {
  return legendariesFor(itemOf(group, templateIndex)).map((r) => ({
    id: r.id,
    skills: (r.affixes ?? []).filter(isSkillLine).map((a) => ({ param: a.param, value: a.value })),
    canExaltSkill: canExaltSkill(r, group),
  }));
}

/** Every Legendary record in the game (for a test that nothing legal is missed). */
export const allRecords = () => allLegendaries();
