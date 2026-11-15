/*
 * test/harness/blowConfigs.mjs - the Stage 3.1 scenarios, as DESCRIPTIONS.
 *
 * A scenario names inputs only (a character description, an item, a body request, the host's settings). The local side
 * is built here (`localSide`) and the upstream side in test/blowDifferential.test.js from the same inputs; neither side is
 * ever handed the other's output. The ten scenarios are the Part A configurations plus an ordinary-foe echo.
 */
import { character, simCharacter, weapon } from './fixtures.mjs';
import { referenceFoe, weaponOf } from '../../src/model.js';
import { enemyTarget, equipArmour, standInTarget } from '../../src/target.js';

export const PV = Object.freeze({ type: 4, param: 1 }); // Potent Vs vs Daedra (enchantments.js:622-631)
export const CAREER = Object.freeze({ strength: 60, intelligence: 50, willpower: 60, agility: 90, endurance: 70, personality: 50, speed: 90, luck: 80 });
export const CUIRASS_AND_TOWER = Object.freeze([
  { templateIndex: 102, material: 519, condition: 0.8 },
  { templateIndex: 112, material: 0, condition: 1 },
]);
export const DAEDRA_BONUS = 0x02;

const STRONG = (extra = {}, career = {}) => character({
  level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 80, willpower: 100 }, skills: 0,
  skillOverride: { 28: 150, 29: 150, 30: 150, 32: 150, 33: 150, 34: 100, 19: 50, ...extra }, career,
});
const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 }, skills: 0, skillOverride: { 29: 70, 34: 40 },
});

/** @type {Array<object>} */
export const CONFIGS = [
  { id: '1 basic katana', desc: BASIC(), template: 121, target: 'reference', seed: 0x3101, draws: 300000 },
  {
    id: '2 strong gate: crit, backstab, echo, Potent Vs, trait, cap', desc: STRONG(), template: 121,
    fields: { rarity: 'rare', imprint: 'warp-edge', enchantments: [PV] }, echoPower: 'warp-edge',
    target: 'relay', traits: ['bladeturning'], cap: 24, uptime: 0.5, seed: 0x3102, draws: 400000,
  },
  {
    id: '3 same build, uncapped', desc: STRONG(), template: 121,
    fields: { rarity: 'rare', imprint: 'warp-edge', enchantments: [PV] }, echoPower: 'warp-edge',
    target: 'relay', traits: ['bladeturning'], cap: 0, uptime: 0.5, seed: 0x3103, draws: 400000,
  },
  // A hypothetical two-echo what-if: the game has only one echo power (`warp-edge`), so the oracle drives two
  // lootStrike calls from one item to test the local multi-branch expansion; it is not a real upstream item.
  {
    id: '4 same build, two echo powers (what-if)', desc: STRONG(), template: 121,
    fields: { rarity: 'rare', imprint: 'warp-edge', enchantments: [PV] }, echoPower: 'warp-edge', echoCalls: 2,
    target: 'relay', traits: ['bladeturning'], cap: 24, uptime: 0.5, seed: 0x3104, draws: 400000,
  },
  { id: '5 dai-katana', desc: STRONG(), template: 123, target: 'relay', traits: ['stoneskin'], cap: 30, uptime: 0.3, seed: 0x3105, draws: 300000 },
  { id: '6 long bow', desc: STRONG(), template: 130, bow: true, target: 'relay', traits: ['bladeturning'], cap: 24, uptime: 0.4, seed: 0x3106, draws: 300000 },
  {
    id: '7a dual, main hand', desc: STRONG(), template: 121, dual: true, hand: 'main', fields: { enchantments: [PV] },
    target: 'relay', traits: [], cap: 30, uptime: 0.5, seed: 0x3107, draws: 300000,
  },
  {
    id: '7b dual, off hand', desc: STRONG(), template: 121, dual: true, hand: 'off', fields: { enchantments: [PV] },
    target: 'relay', traits: [], cap: 30, uptime: 0.5, seed: 0x3108, draws: 400000,
  },
  { id: '8 cuirass + tower shield', desc: BASIC(), template: 121, target: 'worn', cap: 12, seed: 0x3109, draws: 400000 },
  {
    id: '9 shield + live enemy-type bonus', desc: STRONG({ 34: 60, 19: 0 }, { attackModifierFlags: DAEDRA_BONUS }), template: 121,
    target: 'worn', cap: 0, seed: 0x310a, draws: 500000,
  },
  {
    id: '10 echo on an ordinary foe (its own hit)', desc: BASIC(), template: 121, fields: { rarity: 'rare', imprint: 'warp-edge' },
    echoPower: 'warp-edge', target: 'worn', pieces: [], door: true, cap: 0, seed: 0x310b, draws: 300000,
  },
  {
    id: '11 gun (Thunderlock), neutral direction', desc: BASIC(), template: 560, gun: true,
    target: 'reference', seed: 0x310c, draws: 200000,
  },
  {
    id: '12 fists', desc: BASIC(), template: null, target: 'reference', seed: 0x310d, draws: 200000,
  },
];

/** The local target a scenario names. */
export function localTarget(cfg) {
  const traits = cfg.traits ?? [];
  if (cfg.target === 'reference') return referenceFoe(30, 'tough');
  if (cfg.target === 'relay') return { ...standInTarget(31), bossTraits: traits, hitCap: cfg.cap ?? 0 };
  const t = enemyTarget(31, { career: CAREER });
  equipArmour(t, cfg.pieces ?? CUIRASS_AND_TOWER, { armorValues: true });
  return { ...t, bossTraits: traits, hitCap: cfg.cap ?? 0 };
}

/** The item as this project holds it. */
export const localItem = (cfg) => (cfg.template == null ? null : { ...weapon(cfg.template, { material: 9 }), ...(cfg.fields ?? {}) });

/** The local build and the arguments for `blowOutcomes` / `analyze` (the hand named by the scenario). */
export function localSide(cfg) {
  const item = localItem(cfg);
  const ch = simCharacter(cfg.desc, item);
  const extra = {};
  if (cfg.dual) {
    ch.offWeapon = { ...localItem(cfg), equipSlot: 21 };
    ch._dual = true;
    extra.dual = true;
  }
  const args = {
    target: localTarget(cfg), core: 'overhaul', weapon: item ? weaponOf(item) : null, backstabUptime: cfg.uptime ?? 0, ...extra,
    ...(cfg.echoCalls === 2 ? { imprints: [{ kind: 'echo', chance: 10 }] } : {}),
  };
  return { ch, item, args, hand: cfg.hand ?? 'main' };
}
