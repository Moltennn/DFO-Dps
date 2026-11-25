/* The weapons page's max character, shared by the imprint and enchant planners. */
import { SKILLS, WEAPONS } from './data.js';
import { analyze, gateTarget, referenceFoe, DEFAULT_GAME_BUILD, gameBuildOf } from './model.js';
import { perfectSockets } from './sockets.js';
import { legalTotals, validatePlan, slotsFor } from './gearProfile.js';
import { THEORY_LEVEL, theoryCharacter, theoryFists } from './theory.js';

const PROF_OF = Object.freeze({ ShortBlade: 1, LongBlade: 2, HandToHand: 4, Axe: 8, BluntWeapon: 16, Archery: 32 });
const SKILL_OF_FAMILY = Object.freeze({ ShortBlade: SKILLS.ShortBlade, LongBlade: SKILLS.LongBlade, HandToHand: SKILLS.HandToHand, Axe: SKILLS.Axe, BluntWeapon: SKILLS.BluntWeapon, Archery: SKILLS.Archery });

/**
 * THE MAX CHARACTER BUILT WITH EXPLICIT GEAR (the raw builder; `maxCharacter` picks the legal budget).
 * `gearSkill` points sit on the weapon's own skill, `gearCrit` on Critical Strike, `damagePct` is the
 * weapon's damage line.
 */
export function buildMax(template, { gearSkill = 0, gearCrit = 0, damagePct = 0, firmament = false, vampire = false, race = 'darkelf' } = {}) {
  const t = Number(template);
  const w = WEAPONS[t];
  if (!w) throw new Error(`unknown weapon template ${template}`);
  const starStats = firmament ? { strength: 15, agility: 15, speed: 15, luck: 15 } : {};
  if (w.skill === 'HandToHand') {
    const starSkills = firmament ? { [SKILLS.HandToHand]: 15, [SKILLS.CriticalStrike]: 15, [SKILLS.Backstabbing]: 15 } : {};
    const ch = theoryFists({
      race, rawH2H: 200, gearH2H: gearSkill, gearCrit,
      starStats, starSkills, starDamage: firmament ? 30 : 0, vampire, wraps: true,
    });
    ch.martialPath = 'blademaster';
    return ch;
  }
  const skillId = SKILLS[w.skill];
  const starSkills = firmament ? { [skillId]: 15, [SKILLS.CriticalStrike]: 15, [SKILLS.Backstabbing]: 15 } : {};
  const ch = theoryCharacter({
    blade: t, race, gearLB: 0, gearCS: 0, damagePct,
    vampire, starStats, starSkills, starDamage: firmament ? 30 : 0, sockets: perfectSockets(t),
  });
  ch.career = { ...(ch.career ?? {}), weaponArmorShieldsBitfield: (PROF_OF[w.skill] ?? 0) << 16 };
  ch.skills[skillId] = 200;
  ch.masteredSkills = [skillId, SKILLS.CriticalStrike, SKILLS.Backstabbing];
  ch._mods.skills = {
    ...(ch._mods.skills ?? {}),
    [skillId]: gearSkill + (firmament ? 15 : 0),
    [SKILLS.CriticalStrike]: gearCrit + (firmament ? 15 : 0),
  };
  ch.martialPath = 'blademaster';
  ch._pair = t === 562;
  return ch;
}

const _frontiers = new Map();

/**
 * Every legal frontier point of a build, evaluated against the uncapped target and the level-45 Breach.
 * Cached per slot set: the frontier is small and the search is deterministic. `gameBuild` changes only the PRICE of
 * each point (the 14631 gear law), never the allocation, so the cache key includes it - a 14631 and a 14512 frontier
 * are different numbers.
 */
function evaluatedFrontier(template, { shield = null, gameBuild = DEFAULT_GAME_BUILD } = {}) {
  const t = Number(template);
  const w = WEAPONS[t];
  if (!w) throw new Error(`unknown weapon template ${template}`);
  const build = gameBuildOf(gameBuild);
  const key = `${t}:${shield ?? ''}:${build}`;
  if (_frontiers.has(key)) return _frontiers.get(key);
  const skill = SKILL_OF_FAMILY[w.skill] ?? SKILLS.HandToHand;
  const points = legalTotals({ weaponTemplate: t, skill, shield });
  const target = referenceFoe(THEORY_LEVEL, 'tough');
  const gate = gateTarget(THEORY_LEVEL);
  const evaluated = points.map((p) => {
    const ch = buildMax(t, { gearSkill: p.lb, gearCrit: p.cs, damagePct: p.dmg });
    const r = analyze(ch, { target, core: 'overhaul', rri: true, healthShare: 1, passiveOn: true, stacks: 5, gameBuild: build });
    const g = analyze(ch, { target: gate, core: 'overhaul', rri: true, health: gate.maxHealth, healthShare: 1, passiveOn: true, stacks: 5, gameBuild: build });
    return {
      ...p,
      dps: r.dps,
      cappedDps: g.cappedDps,
      allowanceDps: g.allowance?.averageDps ?? g.cappedDps,
    };
  });
  const out = { skill, evaluated };
  _frontiers.set(key, out);
  return out;
}

const METRICS = Object.freeze({ uncapped: 'dps', capped: 'cappedDps', allowance: 'allowanceDps' });

/**
 * The gear a max profile may actually wear, from the game's own allocation rules (gearProfile.js): the
 * (weapon skill, Critical Strike, damage) point on the legal frontier that gives the most DPS for
 * `metric`:
 *
 *   'uncapped'  the flat target's DPS (the default; the weapons page's headline ceiling)
 *   'capped'    the per-hit-capped ceiling at the level-45 Breach
 *   'allowance' the Breach's relay allowance, kill-average DPS
 *
 * `alternatives` holds every other point that ties the chosen one, so a caller never loses a tie the
 * rules leave open. `violations` re-checks the plan, so an illegal assumption cannot creep back in
 * silently.
 */
export function legalGear(template, { shield = null, metric = 'uncapped', gameBuild = DEFAULT_GAME_BUILD } = {}) {
  const field = METRICS[metric];
  if (!field) throw new Error(`unknown metric "${metric}"`);
  const { skill, evaluated } = evaluatedFrontier(template, { shield, gameBuild });
  const max = Math.max(...evaluated.map((p) => p[field]));
  const ties = evaluated.filter((p) => Math.abs(p[field] - max) <= 1e-9);
  const best = ties[0];
  return Object.freeze({
    ...best,
    skill,
    metric,
    metricField: field,
    alternatives: Object.freeze(ties.slice(1)),
    violations: Object.freeze(validatePlan(best.plan)),
  });
}

/** Every legal frontier point, evaluated (for callers that present the whole frontier). */
export function legalFrontier(template, opts) {
  return evaluatedFrontier(template, opts).evaluated;
}

/** The max character: the legal gear budget, then the usual ceiling identity. */
export function maxCharacter(template, { firmament = false, vampire = false, race = 'darkelf', gameBuild = DEFAULT_GAME_BUILD } = {}) {
  const g = legalGear(template, { gameBuild });
  return buildMax(Number(template), { gearSkill: g.lb, gearCrit: g.cs, damagePct: g.dmg, firmament, vampire, race });
}

/** Exposed for tests: the legal plan behind a profile. */
export const legalGearPlan = (template, opts) => legalGear(template, opts).plan;
export { slotsFor, validatePlan };

/**
 * One card of a max-profile character at the level-45 gate or an ordinary target. `gameBuild` is passed straight to the
 * scenario: the 14631 gear law moves the carried figure, never the build.
 */
export function maxRun(ch, { target = referenceFoe(THEORY_LEVEL, 'tough'), gate = false, gameBuild = DEFAULT_GAME_BUILD } = {}) {
  const t = gate ? gateTarget(THEORY_LEVEL) : target;
  return analyze(ch, {
    target: t,
    health: t.maxHealth ?? 0,
    core: 'overhaul', rri: true, healthShare: 1, passiveOn: true, stacks: 5,
    pair: !!ch?._pair, dual: !!ch?._dual,
    gameBuild,
  });
}

