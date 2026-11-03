/*
 * dfo-dps - gem sockets.
 *
 * A rare/legendary weapon/armour/jewellery piece can hold sockets:
 * short blade 1, one-handed 2, two-handed 3, armour/jewellery 1
 * (lootRarity.js socketMax). A set gem adds one line to the piece:
 * a perfect diamond is +12% damage on a weapon, a perfect ruby +6
 * fire, a perfect stat gem +8. Gems never add skill lines.
 */
import { WEAPONS } from './data.js';

export const GEM_GRADE_LINES = Object.freeze({
  ruby: { weapon: { id: 'elemental', param: 'fire', value: 6 }, other: { id: 'resist', param: 'fire', value: 20 } },
  emerald: { weapon: { id: 'leech', value: 7 }, other: { id: 'resist', param: 'poison', value: 20 } },
  sapphire: { weapon: { id: 'elemental', param: 'frost', value: 6 }, other: { id: 'resist', param: 'frost', value: 20 } },
  diamond: { weapon: { id: 'damage', value: 12 }, other: { id: 'resist', param: 'magic', value: 20 } },
  jade: { weapon: { id: 'stat', param: 'willpower', value: 8 }, other: { id: 'stat', param: 'willpower', value: 8 } },
  turquoise: { weapon: { id: 'stat', param: 'agility', value: 8 }, other: { id: 'stat', param: 'personality', value: 8 } },
  malachite: { weapon: { id: 'stat', param: 'strength', value: 8 }, other: { id: 'stat', param: 'endurance', value: 8 } },
  amber: { weapon: { id: 'stat', param: 'speed', value: 8 }, other: { id: 'stat', param: 'luck', value: 6 } },
});
export const GEM_KINDS = Object.freeze(Object.keys(GEM_GRADE_LINES));

/** The perfect id a max profile uses. */
export const perfectGem = (kind) => `perfect-${kind}`;
export const gemKindOf = (id) => {
  if (typeof id !== 'string') return null;
  const k = id.includes('-') ? id.slice(id.indexOf('-') + 1) : id;
  return GEM_GRADE_LINES[k] ? k : null;
};

const SHORT_BLADES = new Set([113, 114, 116, 117]);
const TWO_HANDED = new Set([115, 122, 123, 125, 126, 128, 129, 130, 560]);

/** A weapon's sockets: short 1, one-handed 2, two-handed 3; armour/jewellery 1. */
export function socketCount(itemOrTemplate) {
  const t = typeof itemOrTemplate === 'number' ? itemOrTemplate : itemOrTemplate?.templateIndex;
  if (!WEAPONS[t]) return 0;
  if (SHORT_BLADES.has(t)) return 1;
  if (TWO_HANDED.has(t)) return 3;
  return 2;
}

/** The line a set gem adds, marked with its gem id. */
export function gemLine(item, gem) {
  const kind = gemKindOf(gem);
  if (!kind) return null;
  const row = GEM_GRADE_LINES[kind];
  const line = item?.group === 'Weapons' ? row.weapon : row.other;
  return { ...line, gem };
}

/** Every set socket's line for one item. */
export function socketAffixes(item) {
  if (!item) return [];
  const list = Array.isArray(item.sockets) ? item.sockets : item.socket ? [item.socket] : [];
  return list.map((gem) => (gem && gem !== 'empty' ? gemLine(item, gem) : null)).filter(Boolean);
}

/** The max profile's sockets: perfect diamonds in every weapon socket. */
export function perfectSockets(templateIndex) {
  return Array.from({ length: socketCount(templateIndex) }, () => perfectGem('diamond'));
}
