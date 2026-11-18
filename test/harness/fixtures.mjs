/*
 * test/harness/fixtures.mjs - characters, foes and weapons built the same way
 * for both sides of a comparison.
 *
 * A fixture is a plain description; `simCharacter` turns it into this
 * project's character, and `upstreamEntity` turns it into the game's entity
 * shape. Nothing is measured in this file.
 */
import { characterFromSave } from '../../src/save.js';
import { playerEntity, weaponItem } from './upstream.mjs';

export const STAT_KEYS = Object.freeze(['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck']);

/** A deterministic character description (the same one feeds both sides). */
export function character({
  level = 30,
  raceId = 1,
  stats = {},
  skills = 40,
  skillOverride = {},
  career = {},
  martialPath = null,
  mastered = [],
  masterSkills = false,
  online = false,
} = {}) {
  const skillArray = Array.from({ length: 35 }, (_, i) => ({ ...(typeof skills === 'number' ? {} : skills) }[i] ?? (typeof skills === 'number' ? skills : 40)));
  for (const [id, v] of Object.entries(skillOverride)) skillArray[Number(id)] = v;
  return {
    level,
    raceId,
    stats: { strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50, ...stats },
    skills: skillArray,
    career: { weaponArmorShieldsBitfield: 0, abilityFlagsAndSpellPointsBitfield: 0, attackModifierFlags: 0, ...career },
    martialPath,
    mastered,
    masterSkills,
    online,
  };
}

/** The same description as this project's character (save import path). */
export function simCharacter(desc, item = null) {
  const save = {
    name: 'fixture',
    level: desc.level,
    raceId: desc.raceId,
    race: 'fixture',
    stats: desc.stats,
    skills: desc.skills,
    health: 100,
    maxHealth: 100,
    reflexes: 2,
    career: desc.career,
    items: item ? [item] : [],
    activeEffects: [],
    masterSkills: desc.masterSkills,
    masteredSkills: desc.mastered,
    martialPath: desc.martialPath,
    _mods: { stats: {}, skills: {}, statMax: {} },
    _enchantMods: { skillMods: {}, chanceToHitMod: 0 },
  };
  const ch = characterFromSave(save, { online: desc.online });
  return ch;
}

/** The same description as the game's entity. */
export function upstreamEntity(desc, item = null) {
  return playerEntity({
    level: desc.level,
    raceId: desc.raceId,
    stats: desc.stats,
    skills: Object.fromEntries(desc.skills.map((v, i) => [i, v])),
    career: desc.career,
  });
}

/** A weapon item for both sides (the roll is resolved from the template). */
export function weapon(templateIndex, { material = 0, condition = 1, flags = 0 } = {}) {
  return { ...weaponItem(templateIndex, { material, condition }), flags, equipSlot: 19 };
}

/** The item as the game's formula sees it (no equip slot needed). */
export const upstreamWeapon = (item) => ({
  group: 'Weapons',
  templateIndex: item.templateIndex,
  material: item.material,
  flags: item.flags ?? 0,
  name: item.name,
  maxCondition: item.maxCondition,
  currentCondition: item.currentCondition,
});

/** A freshly-cloned item, so wear in one blow cannot leak into the next. */
export const fresh = (item) => ({ ...item });

/**
 * One Continuous Damage Health (1,0) spell record, in the shape `applySpell` reads.
 *
 * `rounds` is the number of magic rounds the spell stands for, and it IS `durationBase`: `rollDuration`
 * (vendor:systems/effects.js:611-616) returns `durationBase + durationMod * mult`, so with `durationMod` 0 the rolled
 * duration is `durationBase` however high the caster level. `pushActive` (:767-772) runs the FIRST round at the cast and
 * leaves `rounds - 1`, so `rounds` rounds are one cast tick plus `rounds - 1` tick passes - not `durationBase - 1`.
 * `magnitudeHigh` widens the magnitude roll (one draw, :229-235 of vendor:systems/spellcast.js) for a per-tick re-roll.
 */
export function dotSpell({
  magnitude = 10, magnitudeHigh = magnitude, rounds = 5, element = 4, rangeType = 1, index = 1, name = 'Test DoT',
} = {}) {
  return {
    name,
    index,
    element,
    rangeType,
    effects: [{
      type: 1, subType: 0,
      magnitudeBaseLow: magnitude, magnitudeBaseHigh: magnitudeHigh,
      magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
      durationBase: rounds, durationMod: 0, durationPerLevel: 1,
      chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
    }],
  };
}
