/*
 * dfo-dps - the Reforge's weapon imprints.
 *
 * LOOT10: a Rare may carry one Legendary's power. The records and their
 * powers below are the game's own (systems/loot/lootRarity.js): a weapon
 * record fits a template when it names no templates or names this one,
 * and Chain Lightning fits only a shot, Earthshaker only a melee blow.
 * The ranking is the power's DPS on the family's best max-profile weapon.
 * The Rare's own affixes are separate and are not part of this table.
 */
import { SKILLS, WEAPONS } from './data.js';
import { maxCharacter, maxRun } from './maxprofile.js';

/** Weapon Legendaries that can supply an imprint, with their power. */
export const WEAPON_IMPRINTS = Object.freeze([
  { id: 'wyrmbane', name: 'Wyrmbane', templates: null,
    power: { name: 'Dragonsbane', kind: 'bane', pct: 50, brief: '+50% vs dragons and giants' } },
  { id: 'nightwhisper', name: 'Nightwhisper', templates: [113, 114, 116, 117],
    power: { name: 'Silent Death', kind: 'unaware', pct: 100, brief: '+100% vs unaware foes' } },
  { id: 'graveward', name: 'Graveward', templates: [124, 125, 126, 127, 128],
    power: { name: 'Sanctified', kind: 'sanctified', pct: 40, brief: 'Undead: +40% damage' } },
  { id: 'stormcaller', name: "Stormcaller's Bow", templates: [129, 130],
    power: { name: 'Chain Lightning', kind: 'chain', share: 50, metres: 6, brief: 'Arrows jump 50% to a nearby foe' } },
  { id: 'anseis-edge', name: "Ansei's Edge", templates: [118, 119, 120, 121, 122, 123],
    power: { name: 'Way of the Sword', kind: 'flow', pct: 6, max: 5, seconds: 6, brief: '+6% per hit, up to 5 (6s)' } },
  { id: 'tsaesci-fang', name: 'Tsaesci Fang', templates: [114, 117, 121, 123],
    power: { name: "Serpent's Kiss", kind: 'venom', flat: 8, brief: '+8 poison, x2 under half' } },
  { id: 'orsiniums-anvil', name: "Orsinium's Anvil", templates: [124, 125, 126],
    power: { name: 'Earthshaker', kind: 'quake', share: 25, metres: 3, brief: 'Hits splash 25% within 3 m' } },
  { id: 'glenmoril-bow', name: 'The Glenmoril Bow', templates: [129, 130],
    power: { name: "Hunter's Moon", kind: 'moon', pct: 35, beast: 35, brief: 'At night: +35%, +70% vs animals' } },
  { id: 'direnni-staff', name: 'The Direnni Staff', templates: [115],
    power: { name: 'Arcane Conduit', kind: 'conduit', less: 20, mana: 3, brief: '-20% spell cost; hits give 3 MP' } },
  { id: 'gortwogs-cleaver', name: "Gortwog's Cleaver", templates: [127, 128],
    power: { name: 'Orc Rage', kind: 'rage', heal: 10, below: 33, pct: 30, brief: '+30% when low; kills heal' } },
  { id: 'worms-tooth', name: "Worm's Tooth", templates: [113, 114],
    power: { name: 'Soul Siphon', kind: 'siphon', pct: 15, brief: 'Kills restore 15% magicka' } },
  { id: 'warp-edge', name: 'Warp-Edge', templates: [118, 122, 123],
    power: { name: 'Many Endings', kind: 'echo', chance: 10, brief: '10% chance to strike twice' } },
  { id: 'shalidors-brand', name: "Shalidor's Brand", templates: [118, 119, 120],
    power: { name: 'Arcane Surge', kind: 'surge', pct: 25, above: 75, brief: '+25% spell damage above 75% MP' } },
]);

const FAMILIES = Object.freeze([
  { key: 'LongBlade', name: 'Long Blade', templates: [118, 119, 120, 121, 122, 123] },
  { key: 'ShortBlade', name: 'Short Blade', templates: [113, 114, 116, 117] },
  { key: 'Axe', name: 'Axe', templates: [127, 128] },
  { key: 'BluntWeapon', name: 'Blunt Weapon', templates: [115, 124, 125, 126] },
  { key: 'Archery', name: 'Archery', templates: [129, 130, 560, 562] },
  { key: 'HandToHand', name: 'Hand-to-Hand', templates: [563] },
]);

export const IMPRINT_FAMILIES = FAMILIES;

const isShot = (t) => WEAPONS[t]?.skill === 'Archery';

/** LOOT F1's fit, on the power rather than only the record. */
function powerFits(template, power) {
  if (power.kind === 'chain') return isShot(template);
  if (power.kind === 'quake') return !isShot(template);
  return true;
}

/** The records a Rare of this template can be reforged from. */
export const imprintsFor = (template) => WEAPON_IMPRINTS.filter((rec) =>
  (rec.templates === null || rec.templates.includes(Number(template))) && powerFits(Number(template), rec.power));

/**
 * A power's DPS on a base run. `conditional` applies its trigger (the foe
 * is undead, the wielder is low, a second foe is in reach, ...); the base
 * run applies only what is unconditional.
 */
export function powerDps(power, base, conditional = false) {
  const hit = base.hit?.hit ?? 1;
  const aps = base.cadence?.aps ?? 1;
  let mult = 0;
  let flat = 0;
  switch (power.kind) {
    case 'bane': if (conditional) mult += (power.pct ?? 0) / 100; break;
    case 'unaware': if (conditional) mult += (power.pct ?? 0) / 100; break;
    case 'sanctified': if (conditional) mult += (power.pct ?? 0) / 100; break;
    case 'moon': if (conditional) mult += (power.beast ?? power.pct ?? 0) / 100; break;
    case 'rage': if (conditional) mult += (power.pct ?? 0) / 100; break;
    case 'chain': if (conditional) mult += (power.share ?? 0) / 100; break;
    case 'quake': if (conditional) mult += (power.share ?? 0) / 100; break;
    case 'flow': mult += ((power.pct ?? 0) * (power.max ?? 1)) / 100; break;
    case 'echo': mult += (power.chance ?? 0) / 100; break;
    case 'venom': flat += conditional ? (power.flat ?? 0) * 2 : (power.flat ?? 0); break;
    case 'conduit': case 'siphon': case 'surge': break;
    default: break;
  }
  return base.dps * (1 + mult) + flat * hit * aps;
}

const TRIGGER = Object.freeze({
  bane: 'foe is a dragon or giant',
  unaware: 'foe has not noticed you',
  sanctified: 'foe is undead',
  moon: 'night, or an animal',
  rage: 'you are below 33% health',
  chain: 'a second foe within 6 m',
  quake: 'another foe within 3 m',
  venom: 'foe is below half health (x2)',
  flow: 'five landed blows (steady)',
  echo: 'the 10% extra strike lands',
  conduit: 'spell cost / magicka',
  siphon: 'a kill',
  surge: 'spell damage above 75% MP',
});

/** Rank the family's eligible imprints on its best max-profile weapon. */
export function rankFamily(family, { firmament = false, vampire = false, sort = 'base' } = {}) {
  const bases = new Map();
  for (const t of family.templates) {
    if (!WEAPONS[t]) continue;
    bases.set(t, maxRun(maxCharacter(t, { firmament, vampire })));
  }
  let best = null;
  for (const [t, base] of bases) if (!best || base.dps > best.base.dps) best = { template: t, base };
  if (!best) return { ...family, template: null, base: null, rows: [] };
  const rows = WEAPON_IMPRINTS.map((rec) => {
    // Each imprint is read on the best weapon of this family it actually fits.
    const eligible = family.templates.filter((t) => bases.has(t) && (rec.templates === null || rec.templates.includes(t)) && powerFits(t, rec.power));
    if (!eligible.length) return null;
    const host = eligible.reduce((a, t) => (bases.get(t).dps > bases.get(a).dps ? t : a), eligible[0]);
    const base = bases.get(host);
    const baseDps = powerDps(rec.power, base, false);
    const conditionalDps = powerDps(rec.power, base, true);
    return {
      id: rec.id, name: rec.name, power: rec.power, template: host, weapon: WEAPONS[host]?.name ?? String(host),
      baseDps, conditionalDps,
      delta: baseDps - base.dps,
      triggerDelta: conditionalDps - base.dps,
      trigger: TRIGGER[rec.power.kind] ?? '',
      unconditional: rec.power.kind === 'flow' || rec.power.kind === 'echo',
    };
  }).filter(Boolean).sort((a, b) => {
    if (sort === 'conditional') return b.conditionalDps - a.conditionalDps || b.baseDps - a.baseDps;
    return b.baseDps - a.baseDps || b.conditionalDps - a.conditionalDps;
  });
  return {
    ...family,
    template: best.template,
    weapon: WEAPONS[best.template]?.name ?? String(best.template),
    base: best.base,
    rows,
  };
}

export const rankAll = (opts = {}) => FAMILIES.map((f) => rankFamily(f, opts));

export const imprintFamilyById = (id) => FAMILIES.find((f) => f.key.toLowerCase() === String(id).toLowerCase()) ?? null;
