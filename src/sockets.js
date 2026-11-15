/*
 * dfo-dps - gem sockets.
 *
 * A rare/legendary weapon/armour/jewellery piece can hold sockets:
 * short blade 1, one-handed 2, two-handed 3, armour/jewellery 1
 * (lootRarity.js socketMax). A set gem adds one line to the piece:
 * a perfect diamond is +12% damage on a weapon, a perfect ruby +6
 * fire, a perfect stat gem +8; a piece's gems read at most the top of the
 * kind's Rare band together (law 6, src/gearLines.js). Lines and counts are
 * upstream's own functions, not a table kept here.
 */
import { gemLine, socketGems } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { socketsFor } from './gearLines.js';

/** The perfect id a max profile uses (upstream's graded ids: `perfect-diamond` is +12% damage on a weapon). */
export const perfectGem = (kind) => `perfect-${kind}`;

/** How many sockets a weapon template holds: upstream's own socketMax (lootRarity.js:2004-2011). */
export const socketCount = (itemOrTemplate) => socketsFor(typeof itemOrTemplate === 'number' ? itemOrTemplate : itemOrTemplate?.templateIndex);

/**
 * Every set socket's line for one item: upstream's `gemLine` (lootRarity.js:2040), marked with its gem, in the
 * sockets' order. The cap on them (law 6) is applied where the lines are READ (src/gearLines.js readLines).
 */
export function socketAffixes(item) {
  if (!item) return [];
  return socketGems(item).map((g) => gemLine(item, g)).filter(Boolean);
}

/** The max profile's sockets: perfect diamonds in every weapon socket. */
export function perfectSockets(templateIndex) {
  return Array.from({ length: socketCount(templateIndex) }, () => perfectGem('diamond'));
}
