/*
 * test/harness/outcomes.mjs - compare a blow's OUTCOMES with upstream's, not just its mean.
 *
 * `sampleUpstream` draws upstream's own blows (combat/pcaao.js pcaaoAttackDamage, then whatever the host
 * does to the finished blow) against a body upstream built, grouping the final damage by the body part it
 * struck. `compareDistributions` sets each part's observed value counts against a local probability map
 * (src/model.js `blowDistribution`) with a z statistic per value. Nothing local goes to upstream: the
 * oracle is handed the same INPUTS (a character description, an item, a body it built itself).
 */
import { upstreamEntity, upstreamWeapon, fresh } from './fixtures.mjs';
import { generator } from './prng.mjs';
import { offHandDamage, offHandToHit } from '../../src/dualWield.js';

/**
 * Non-critical landed blows, grouped by struck part: `{ byPart: Map[7], counts[7] }`.
 * `after(d)` is the host's step on the finished blow (a bow's pull, a boss trait, the cap); it runs
 * on every landed blow, crit or not, in `means`.
 */
export function sampleUpstream(u, modules, { desc, item, body, offHand = false, seed, draws, after = (d) => d, backstabChance = 0 }) {
  const rng = generator(seed);
  const byPart = Array.from({ length: 7 }, () => new Map());
  const counts = new Array(7).fill(0);
  const all = { n: draws, sum: 0, sq: 0 };
  for (let i = 0; i < draws; i++) {
    const notes = {};
    let part = -1;
    const raw = u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), body, {
      weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance, notes,
      onStruck: (p) => { part = p; },
      ...(offHand ? { toHitMod: offHandToHit(desc.stats.agility), blowShare: offHandDamage } : {}),
    });
    const d = raw > 0 ? after(raw) : raw;
    all.sum += d; all.sq += d * d;
    if (!(raw > 0) || notes.critical || notes.backstab || part < 0) continue;
    counts[part] += 1;
    byPart[part].set(d, (byPart[part].get(d) ?? 0) + 1);
  }
  const mean = all.sum / draws;
  return { byPart, counts, mean, se: Math.sqrt(Math.max(0, all.sq / draws - mean * mean) / draws) };
}

/** Per part and value: the standardized gap between upstream's count and the local probability. */
export function compareDistributions(sample, local, { minCount = 2000 } = {}) {
  const gaps = [];
  for (let part = 0; part < 7; part++) {
    const n = sample.counts[part];
    if (n < minCount) continue;
    const seen = sample.byPart[part];
    for (const value of new Set([...seen.keys(), ...local[part].keys()])) {
      const p = local[part].get(value) ?? 0;
      const c = seen.get(value) ?? 0;
      if (p === 0) { gaps.push({ part, value, c, p, z: Infinity }); continue; }
      const sd = Math.sqrt(n * p * (1 - p));
      gaps.push({ part, value, c, p, z: sd > 0 ? (c - n * p) / sd : (c === n * p ? 0 : Infinity) });
    }
  }
  return gaps;
}
export const worst = (gaps) => gaps.reduce((m, g) => (Math.abs(g.z) > Math.abs(m?.z ?? 0) ? g : m), null);

/**
 * Upstream's whole blow - formulas.js calculateAttackDamage, the tail's payloads included - sampled N times,
 * then the host's steps `after` (a shaft's pull, a boss trait, the relay cap). A fresh item every blow: the
 * card's own value, no carried remainder (docs W-LOOT-CARRY). `attacker` is any upstream entity (a path
 * holder from `pathHolder`, or `upstreamEntity(desc)`).
 */
export function sampleCalc(u, { attacker, body, item, extra = {}, seed, draws, offHand = false, backstabChance = 0, after = (d) => d }) {
  const rng = generator(seed);
  let sum = 0; let sq = 0;
  for (let i = 0; i < draws; i++) {
    const raw = u.formulas.calculateAttackDamage(attacker, body, {
      weapon: { ...upstreamWeapon(item), ...extra }, rolls: rng, backstabChance,
      ...(offHand ? { toHitMod: offHandToHit(attacker.stats.agility), ...u.handsLaw.OFF_HAND_BLOW } : {}),
    });
    const d = raw > 0 || extra.enchantments ? after(raw) : raw;
    sum += d; sq += d * d;
  }
  const mean = sum / draws;
  return { mean, se: Math.sqrt(Math.max(0, sq / draws - mean * mean) / draws) };
}

/**
 * An upstream player that HOLDS a martial path (isPlayer, Master Skills in force, both of the path's skills
 * mastered: martialPaths.js:874-886), with its health, and `_mods` folded by upstream's own registered folds.
 */
export function pathHolder(u, { path = null, desc, health = 100, maxHealth = 100 }) {
  const e = upstreamEntity(desc);
  if (path) {
    e.martialPath = path;
    e.masterSkills = true;
    e.masteredSkills = [...u.martialPaths.MARTIAL_BY_ID[path].skills];
  }
  e.health = health;
  e.maxHealth = maxHealth;
  u.entityMods.computeEntityMods(e);
  return e;
}

/**
 * Upstream's whole blow with the item WORN: the weapon sits in the attacker's equip table (lootPowers.js
 * wornPowers reads the worn pieces, and `blowPowers` a weapon's power only for the weapon that struck), a fresh
 * copy every blow so no fractional remainder is carried (docs W-LOOT-CARRY). The first `warm` blows are drawn
 * and thrown away: a Flow power's stacks build through landed blows (lootStrike), and are read at five after.
 * `fields` are the item's own upstream fields (rarity/imprint/legendary/affixes/enchantments).
 */
export function sampleWorn(u, { attacker, body, item, fields = {}, seed, draws, warm = 0, offHand = false, calc = {}, after = (d) => d }) {
  const rng = generator(seed);
  const slot = u.equip.equipTableOf(attacker);
  const hand = offHand ? u.equip.EQUIP_SLOTS.LeftHand : u.equip.EQUIP_SLOTS.RightHand;
  let sum = 0; let sq = 0;
  for (let i = -warm; i < draws; i++) {
    const w = { ...upstreamWeapon(item), ...fields };
    slot[hand] = w;
    const raw = u.formulas.calculateAttackDamage(attacker, body, {
      weapon: w, rolls: rng, backstabChance: 0, ...calc,
      ...(offHand ? { toHitMod: offHandToHit(attacker.stats.agility), ...u.handsLaw.OFF_HAND_BLOW } : {}),
    });
    if (i < 0) continue;
    const d = raw > 0 || fields.enchantments ? after(raw) : raw;
    sum += d; sq += d * d;
  }
  slot[hand] = null;
  const mean = sum / draws;
  return { mean, se: Math.sqrt(Math.max(0, sq / draws - mean * mean) / draws) };
}
