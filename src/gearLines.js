/*
 * dfo-dps - an item's lines, read as the game reads them.
 *
 * Upstream has ONE reading of a piece's lines (systems/loot/lootRarity.js), and every reader of a line goes through
 * it. This module is a thin adapter over those functions, not a second interpretation:
 *
 *   layGemLines   :2085-2088   the piece's own lines, then its gems' - one a set socket, in the sockets' order, each
 *                              exactly `gemLine(item, gem)` (graded: a perfect diamond is +12, a plain one +6)
 *   readLines     :2155-2165   the lines as the readers read them: a piece's own lines WHOLE, and each GEM line holding
 *                              what is left of its kind-and-param's cap (gemPieceCap = the top of the kind's Rare
 *                              band: damage 25, fire/frost 6, stat 10) in the sockets' order - law 6 (GEM1)
 *   validAffix    :839-847     a kind the table knows, a param that kind allows, an integer value 1..the Legendary top
 *   linesOf       lootPowers.js:129-132   readLines(item) filtered to the kind AND validAffix
 *   affixFold     :2373-2406   (stats, skills) readLines, validAffix, `a.value | 0`
 *   affixWeaponDamage :2475    the sum of the 'damage' lines of readLines(weapon), `trunc(d * (1 + pct/100))` -
 *                              no validAffix on the piece's own lines (a gem line is validated inside readLines)
 *
 * What this project reads from a line: stat, skill, damage (weapon), slayer, elemental. The other kinds (armor,
 * weight, resist, leech, thorns, focus, standing, warmth, dry, castSpeed, potency, wellspring, technique) do not
 * reach an outgoing weapon blow here and are unsupported inputs (the assumptions register M24).
 */
import {
  readLines, validAffix, gemLine, socketGems, socketsOf, socketMax,
} from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { WEAPONS } from './data.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * The piece's lines with its gems laid after its own (layGemLines). An item with no socket list keeps its
 * `affixes` as they are: a snapshot that already carries its gems' lines marked `gem` is read as it stands.
 */
export function laidLines(item) {
  const list = Array.isArray(item?.affixes) ? item.affixes : [];
  if (!socketsOf(item).length) return list;
  return [...list.filter((a) => a?.gem == null), ...socketGems(item).map((g) => gemLine(item, g))].filter(Boolean);
}

/** The lines as the readers read them (readLines over the laid lines): the gem cap applied, nothing else dropped. */
export const readItemLines = (item) => readLines({ ...item, affixes: laidLines(item) });

/** The lines the blow and the fold read: `linesOf` / `affixFold` - read, then only the valid ones. */
export const validItemLines = (item) => readItemLines(item).filter((a) => validAffix(a));

/** affixWeaponDamage's percentage (lootRarity.js:2475-2479): the 'damage' lines of readLines, `value | 0`. */
export const weaponDamagePct = (item) => readItemLines(item).reduce((n, a) => n + (a?.id === 'damage' ? (a.value | 0) : 0), 0);

/**
 * What lootBlow reads off the held item (lootPowers.js:292-296): every valid 'slayer' line (a line per param, THEIR
 * VALUES SUMMED when a param repeats) and every valid 'elemental' line, kept as LINES because the flat is floored
 * per line, after that line's own career tolerance.
 */
export function bladeLines(item) {
  const lines = validItemLines(item);
  const slayerByGroup = {};
  for (const a of lines) if (a.id === 'slayer') slayerByGroup[String(a.param)] = (slayerByGroup[String(a.param)] ?? 0) + num(a.value);
  const elementalLines = lines.filter((a) => a.id === 'elemental').map((a) => ({ param: String(a.param), value: num(a.value) }));
  return {
    slayerByGroup,
    slayer: Object.values(slayerByGroup).reduce((n, v) => n + v, 0),
    elementalLines,
    elemental: elementalLines.reduce((n, l) => n + l.value, 0),
  };
}

/** The stat and skill points the worn lines fold onto the entity (affixFold): `{ stats, skills }`. */
export function foldLines(items) {
  const stats = {};
  const skills = {};
  for (const it of items ?? []) {
    for (const a of validItemLines(it)) {
      const v = a.value | 0;
      if (a.id === 'stat') stats[a.param] = (stats[a.param] ?? 0) + v;
      else if (a.id === 'skill') skills[a.param] = (skills[a.param] ?? 0) + v;
    }
  }
  return { stats, skills };
}

/** How many sockets a weapon template holds (lootRarity.js:2004-2011 socketMax), 0 for a template this project lacks. */
export const socketsFor = (templateIndex) => (WEAPONS[templateIndex] ? socketMax({ group: 'Weapons', templateIndex }) : 0);
