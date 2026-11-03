/* The weapons page's max character, shared by the imprint and enchant planners. */
import { SKILLS, WEAPONS } from './data.js';
import { analyze, expectedCapped, gateTarget, referenceFoe } from './model.js';
import { perfectSockets } from './sockets.js';
import {
  DAMAGE_AFFIX_MAX, GEAR_CS_LINES, GEAR_H2H_LINES, GEAR_LB_LINES, GEAR_LINE_MAX,
  THEORY_LEVEL, theoryCharacter, theoryFists,
} from './theory.js';

const PROF_OF = Object.freeze({ ShortBlade: 1, LongBlade: 2, HandToHand: 4, Axe: 8, BluntWeapon: 16, Archery: 32 });
const MAX_WEAPON_GEAR = GEAR_LB_LINES * GEAR_LINE_MAX;
const MAX_CRIT_GEAR = GEAR_CS_LINES * GEAR_LINE_MAX;
const MAX_H2H_GEAR = GEAR_H2H_LINES * GEAR_LINE_MAX;

export function maxCharacter(template, { firmament = false, vampire = false, race = 'darkelf' } = {}) {
  const t = Number(template);
  const w = WEAPONS[t];
  if (!w) throw new Error(`unknown weapon template ${template}`);
  const starStats = firmament ? { strength: 15, agility: 15, speed: 15, luck: 15 } : {};
  if (w.skill === 'HandToHand') {
    const starSkills = firmament ? { [SKILLS.HandToHand]: 15, [SKILLS.CriticalStrike]: 15, [SKILLS.Backstabbing]: 15 } : {};
    const ch = theoryFists({
      race, rawH2H: 200, gearH2H: MAX_H2H_GEAR, gearCrit: MAX_CRIT_GEAR,
      starStats, starSkills, starDamage: firmament ? 30 : 0, vampire, wraps: true,
    });
    ch.martialPath = 'blademaster';
    return ch;
  }
  const skillId = SKILLS[w.skill];
  const starSkills = firmament ? { [skillId]: 15, [SKILLS.CriticalStrike]: 15, [SKILLS.Backstabbing]: 15 } : {};
  const ch = theoryCharacter({
    blade: t, race, gearLB: 0, gearCS: 0, damagePct: DAMAGE_AFFIX_MAX,
    vampire, starStats, starSkills, starDamage: firmament ? 30 : 0, sockets: perfectSockets(t),
  });
  ch.career = { ...(ch.career ?? {}), weaponArmorShieldsBitfield: (PROF_OF[w.skill] ?? 0) << 16 };
  ch.skills[skillId] = 200;
  ch.masteredSkills = [skillId, SKILLS.CriticalStrike, SKILLS.Backstabbing];
  ch._mods.skills = {
    ...(ch._mods.skills ?? {}),
    [skillId]: MAX_WEAPON_GEAR + (firmament ? 15 : 0),
    [SKILLS.CriticalStrike]: MAX_CRIT_GEAR + (firmament ? 15 : 0),
  };
  ch.martialPath = 'blademaster';
  ch._pair = t === 562;
  return ch;
}

export function maxRun(ch, { target = referenceFoe(THEORY_LEVEL, 'tough'), gate = false } = {}) {
  const t = gate ? gateTarget(THEORY_LEVEL) : target;
  return analyze(ch, {
    target: t,
    health: t.maxHealth ?? 0,
    core: 'overhaul', rri: true, healthShare: 1, passiveOn: true, stacks: 5,
    pair: !!ch?._pair, dual: !!ch?._dual,
  });
}

/** Capped DPS when the blow is multiplied and/or a flat amount is added per hit. */
export function cappedDpsWith(base, { mult = 1, flat = 0 } = {}) {
  const c = base.hit.crit.chance;
  const cap = base.cap;
  const d = base.damage;
  const plainAvg = d.avg * mult + flat;
  const critAvg = d.critAvg * mult + flat;
  const ePlain = cap > 0
    ? expectedCapped(Math.round(d.min * mult + flat), Math.round(d.max * mult + flat), cap)
    : plainAvg;
  const eCrit = cap > 0
    ? expectedCapped(Math.round(d.critMin * mult + flat), Math.round(d.critMax * mult + flat), cap)
    : critAvg;
  return ((1 - c) * base.hit.hitPlain * ePlain + c * base.hit.hitCrit * eCrit) * base.cadence.aps;
}
