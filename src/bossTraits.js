/*
 * dfo-dps - the relay bosses' traits and the damage they resist.
 *
 * The law is the game's own: this module is a thin adapter over
 * vendor/upstream/a3eb1605/src/systems/bossTraits.js, so trait selection and
 * resistance cannot drift from the pinned client.
 *
 * HOW A RELAY BOSS GETS ITS TRAITS (upstream)
 *   scenes/dungeonContext.js:4410  giveBossTraits(entity, relayBossTraits(name, mobile), { own: false })
 *   systems/bossTraits.js:405-409  relayBossTraits(name, kind) hashes `name` and `kind` (eliteFoes.js
 *                                  eliteHash -> eliteRng) and picks one element proof out of
 *                                  ELEMENT_TRAITS and one weapon answer out of RELAY_BOSS_BLOW_TRAITS.
 * So the identity that matters is the stand-in's NAME and its mobile type. The gate and the
 * Remnant use literal names; the Sky-ketch's Warden name goes through the client's text core
 * (systems/ketch/ketchWords.js:191 `t('ketch.kind.tonal', 'The Tonal Warden')`), which means a
 * localized client seeds different traits. That is an upstream quirk, recorded in
 * the assumptions register (A10) and covered by a test; this project models the English client.
 *
 * WHERE RESISTANCE IS APPLIED (upstream, before the claim leaves the machine)
 *   melee   scenes/dungeonContext.js:4544  bossStrikeAt(entity, dmg, 'melee', strikingWeapon, null, ...)
 *   arrow   scenes/dungeonContext.js:4856  bossStrikeAt(entity, dmg, 'arrow', null, null, ...)
 *   spell   scenes/gate/standInSpell.js:204 bossStrike(entity, counted, { kind: 'spell', element })
 * which is ahead of the relay's per-claim cap and allowance (net/gate/gateBrain.js applyHit) and
 * ahead of `standInShown` (gateBoss.js:142), so: damage -> trait -> cap -> allowance.
 *
 * WHAT EACH TRAIT DOES (systems/bossTraits.js:210-224)
 *   bladeturning  a blade (or an arrow; any weapon that is not blunt) lands WEAPON_RESIST_SHARE (1/2)
 *   stoneskin     a blunt weapon, a fist or Hand Wraps lands WEAPON_RESIST_SHARE (1/2)
 *   flameproof, frostproof, venomproof, stormproof, spellproof
 *                 a spell of that element lands RESIST_SHARE (1/4); element 4 is magic
 *   A resisted blow is `Math.max(1, Math.round(d))`; nothing is reduced twice for one blow.
 * A weapon's own `elemental` affix is NOT a spell: upstream scales it by the target's career
 * tolerance (`lootPowers.js:164-167` elementShare), not by a boss trait.
 */
import {
  ELEMENT_TRAITS,
  RESIST_SHARE,
  WEAPON_RESIST_SHARE,
  bossStrike,
  bossTraitsOf,
  relayBossTraits,
} from '../vendor/upstream/a3eb1605/src/systems/bossTraits.js';

export { ELEMENT_TRAITS, RESIST_SHARE, WEAPON_RESIST_SHARE, bossStrike, bossTraitsOf, relayBossTraits };

/**
 * The three online bosses' identities - the only literals in this file, and each
 * sourced to the client. The traits are DERIVED from them, never listed here.
 */
export const RELAY_BOSSES = Object.freeze({
  breach: Object.freeze({
    encounter: 'breach',
    name: 'Valkynaz Ruhn',
    mobile: 31, // world/gate/gateBoss.js:63 BOSS_LOOKS.ruhn; net/gate/gateLaw.js:292-293 GATE_BOSSES
    source: 'net/gate/gateLaw.js:292-293, world/gate/gateBoss.js:63',
  }),
  skyketch: Object.freeze({
    encounter: 'skyketch',
    // The English name: systems/ketch/ketchWords.js:191 `tonal: () => t('ketch.kind.tonal', 'The Tonal Warden')`.
    // A localized client hashes its own string and gets other traits (the assumptions register A10).
    name: 'The Tonal Warden',
    mobile: 36, // scenes/ketch/ketchFight.js:57 KT_WARDEN_LOOK
    source: 'systems/ketch/ketchWords.js:191, scenes/ketch/ketchFight.js:57',
  }),
  abyss: Object.freeze({
    encounter: 'abyss',
    name: 'The Brass Remnant', // scenes/superDungeon/sdRemnant.js:100 (a literal)
    mobile: 36, // scenes/superDungeon/sdRemnant.js:97 SD_REMNANT_MOBILE
    source: 'scenes/superDungeon/sdRemnant.js:97-103',
  }),
});

/** The traits `relayBossTraits` gives one of the three, by encounter id (null if unknown). */
export function relayTraitsFor(id) {
  const boss = RELAY_BOSSES[String(id ?? '').toLowerCase()];
  if (!boss) return null;
  return Object.freeze(relayBossTraits(boss.name, boss.mobile));
}

/** The element-proof trait for a spell element index (ELEMENT_TRAITS order), or null. */
export const elementTraitOf = (element) => (Number.isInteger(element) ? (ELEMENT_TRAITS[element] ?? null) : null);

/**
 * One blow as the boss's traits leave it (systems/bossTraits.js `bossStrike`): the kind is
 * 'melee' | 'arrow' | 'spell'; `weapon` is the item swung (null for a fist or a spell) and
 * `element` is the spell's element index. A blow that is not resisted comes back unchanged;
 * a resisted one is `max(1, round(d))`, exactly as upstream resolves it.
 */
export function resistBlow(traits, damage, { kind = 'melee', weapon = null, element = null } = {}) {
  if (!traits?.length || !(damage > 0)) return damage;
  return bossStrike({ bossTraits: traits }, damage, { kind, weapon, element }).damage;
}

/** The same for a spell (or a Cast When Strikes proc, or a DoT round): its element's proof. */
export function resistSpell(traits, damage, element) {
  return resistBlow(traits, damage, { kind: 'spell', element });
}
