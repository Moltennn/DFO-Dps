/*
 * dfo-dps - a real loadout calculation.
 *
 * Starts from the max character, applies the actual Firmament tree plan
 * (flat + percent channels folded and capped the way firmamentPowers.js does),
 * then the enchant plan for that weapon, then the best weapon imprint that
 * fits. The result is a chain: tree only -> tree + enchants -> tree +
 * enchants + imprint.
 */
import { SKILLS, WEAPONS } from './data.js';
import { blowPct } from '../vendor/firmament/firmamentLaw.js';
import { buildById, effectiveValue, planBuild } from './firmament.js';
import { planEnchants } from './enchantPlan.js';
import { IMPRINT_FAMILIES, imprintsFor, powerDps } from './imprints.js';
import { maxCharacter, maxRun } from './maxprofile.js';
import { referenceFoe } from './model.js';
import { encounterTarget } from './encounters.js';
import { simulatePurse } from './purse.js';
import { THEORY_LEVEL } from './theory.js';
import { ENCHANTMENT_TYPES } from './enchants.js';

const ATTRS = ['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck'];
const BUILD_ID = Object.freeze({
  LongBlade: 'longblade', ShortBlade: 'shortblade', Axe: 'axe', BluntWeapon: 'blunt',
  Archery: 'bow', HandToHand: 'fists',
});
const MONSTER_KINDS = new Set(['bane', 'sanctified', 'moon']);
const ENCHANT_ID = Object.freeze({
  CastWhenStrikes: ENCHANTMENT_TYPES.CastWhenStrikes,
  PotentVs: ENCHANTMENT_TYPES.PotentVs,
});

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Apply the real tree channels: flat + percent held together at each channel's cap. */
export function applyFirmament(ch, plan) {
  const totals = plan.totals;
  const stats = { ...(ch._mods.stats ?? {}) };
  const statMax = { ...(ch._mods.statMax ?? {}) };
  for (const a of ATTRS) {
    const v = effectiveValue(totals, a);
    if (v > 0) {
      stats[a] = (stats[a] ?? 0) + v;
      statMax[a] = (statMax[a] ?? 0) + v;
    }
  }
  const skills = { ...(ch._mods.skills ?? {}) };
  const names = new Set();
  for (const key of Object.keys(totals)) {
    if (key.startsWith('skill.')) names.add(key.slice(6));
    else if (key.startsWith('skillPct.')) names.add(key.slice(9));
  }
  for (const name of names) {
    const id = SKILLS[name];
    const v = effectiveValue(totals, `skill.${name}`);
    if (Number.isInteger(id) && v > 0) skills[id] = (skills[id] ?? 0) + v;
  }
  ch._mods.stats = stats;
  ch._mods.statMax = statMax;
  ch._mods.skills = skills;
  ch.firmamentDamagePct = blowPct(totals, { skill: plan.build.skill });
  return ch;
}

/** Apply the real Firmament plan for a weapon family to a character. */
export function applyTree(ch, familyKey) {
  return applyFirmament(ch, planBuild(buildById(BUILD_ID[familyKey] ?? familyKey), {}));
}

/** Apply the enchant plan's skill lines and weapon strike rows. */
function applyEnchants(ch, plan) {
  const skills = { ...(ch._mods.skills ?? {}) };
  const item = ch.weapon ?? ch.wraps;
  const enchants = [...(item?.enchantments ?? [])];
  for (const row of plan.rows) {
    for (const e of row.effects) {
      if (e.type === 'EnhancesSkill') skills[e.param] = (skills[e.param] ?? 0) + 15;
      else if (ENCHANT_ID[e.type]) enchants.push({ type: ENCHANT_ID[e.type], param: e.param });
    }
  }
  ch._mods.skills = skills;
  if (item) {
    item.enchantments = enchants;
    item.currentCondition = item.maxCondition = Math.max(1, Number(item.maxCondition) || 800);
  }
  return ch;
}

/** The best eligible imprint for this weapon and target. */
function bestImprint(template, run, capped) {
  const baseline = capped ? run.cappedDps : run.dps;
  const rows = imprintsFor(template)
    .filter((rec) => !MONSTER_KINDS.has(rec.power.kind))
    .map((rec) => ({
      name: rec.name, power: rec.power,
      dps: powerDps(rec.power, run, false, { capped }),
    }))
    .filter((rec) => rec.dps > baseline + 1e-9)
    .sort((a, b) => b.dps - a.dps);
  return rows[0] ?? null;
}

/** The same-hit imprint effect on one blow. Echo is not credited by the purse. */
function imprintEffect(power) {
  if (!power) return {};
  if (power.kind === 'flow') return { mult: 1 + ((power.pct ?? 0) * (power.max ?? 1)) / 100 };
  if (power.kind === 'venom') return { flat: power.flat ?? 0 };
  return {};
}

/** One real loadout for one template. */
export function realTemplate(template, family, { mode = 'uncapped', vampire = false, dual = false, encounter = 'breach' } = {}) {
  const capped = mode !== 'uncapped';
  const target = capped ? encounterTarget(encounter, THEORY_LEVEL) : referenceFoe(THEORY_LEVEL, 'tough');
  const tree = planBuild(buildById(BUILD_ID[family.key] ?? family.key), {});
  const treeCh = applyFirmament(maxCharacter(template, { vampire }), tree);
  if (dual) {
    treeCh.offWeapon = { ...treeCh.weapon, equipSlot: 21 };
    treeCh._dual = true;
  }
  const treeRun = maxRun(treeCh, { target });
  const group = target.group ?? (capped ? 'none' : 'humanoid');
  const enchPlan = planEnchants({ weapon: template, soulGem: true, forceSkills: !capped, target, group });
  const enchCh = applyEnchants(clone(treeCh), enchPlan);
  if (dual && enchCh.offWeapon) {
    enchCh.offWeapon.enchantments = [...(enchCh.weapon?.enchantments ?? [])];
    enchCh.offWeapon.currentCondition = enchCh.offWeapon.maxCondition = Math.max(1, Number(enchCh.offWeapon.maxCondition) || 800);
  }
  const enchRun = maxRun(enchCh, { target });
  const imprint = bestImprint(template, enchRun, capped);
  const total = enchRun.enchantDps + (imprint?.dps ?? enchRun.cappedDps);
  const purse = capped ? simulatePurse(enchRun, encounter, { level: THEORY_LEVEL, ...imprintEffect(imprint?.power) }) : null;
  return {
    mode, family: family.name, key: family.key, weapon: WEAPONS[template]?.name ?? String(template), template, dual, encounter,
    treeStars: tree.stars, freeStars: tree.freeStars, treeBlow: treeCh.firmamentDamagePct,
    treeDps: treeRun.totalDps, enchDps: enchRun.totalDps, totalDps: total,
    ttk: purse?.ttk ?? enchRun.ttk,
    burst5: purse?.burst5 ?? null,
    sustainedDps: purse?.sustainedDps ?? null,
    averageDps: purse?.averageDps ?? null,
    ceilingDps: purse?.ceilingDps ?? null,
    landedShare: purse?.landedShare ?? null,
    calibrated: purse?.calibrated ?? true,
    imprint: imprint?.name ?? null, imprintPower: imprint?.power?.name ?? null,
    enchPlan,
  };
}

/** Every weapon template in every hold configuration, not just the winners. */
export function realWeaponLoadouts({ modes = ['uncapped', 'cap'], vampire = false, encounter = 'breach' } = {}) {
  const out = [];
  for (const mode of modes) {
    for (const family of IMPRINT_FAMILIES) {
      for (const t of family.templates) {
        const w = WEAPONS[t];
        if (!w) continue;
        const category = w.skill === 'HandToHand' ? 'Fists' : w.twoHanded ? '2H' : '1H';
        out.push({ ...realTemplate(t, family, { mode, vampire, encounter }), category });
        if (!w.twoHanded && w.skill !== 'Archery' && w.skill !== 'HandToHand') {
          out.push({ ...realTemplate(t, family, { mode, vampire, dual: true, encounter }), category: 'DW' });
        }
      }
    }
  }
  return out;
}
