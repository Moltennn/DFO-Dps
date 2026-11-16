/*
 * dfo-dps - ordinary weapon durability: a blow's wear, the Cast When Strikes condition bill, and the break leaf
 * (Stage 3.5.2).
 *
 * Upstream, in the order a blow meets it (the live overhaul core `pcaao.js:1798-1860`, then the outer tail of
 * `combat/formulas.js:769`, `:826-836`):
 *
 *   damageEquipment   combat/formulas.js:569-597 (stock) / combat/pcaao.js:1847-1860 (the overhaul's own call)
 *                     - `target.spareGear` returns at once;
 *                     - the attacker's weapon always takes `trunc((10 * damage + 50) / 100)`, where `damage` is the
 *                       damage that WENT THROUGH the core (after the target's armour), and a 0 amount draws one
 *                       `dice100(20)` roll that can turn it into 1 (formulas.js:583-586);
 *                     - that amount then goes through `dfuBlowWear` (equip.js:555) and `blowWear` (:563-568): the
 *                       port's scale is 1 and the DFU multiple is 1, so a whole amount draws no roll;
 *                     - the struck side's shield (when it covers the part) or armour slot also wears;
 *   lowerCondition    systems/equip.js:570-608 - clamp at 0, say the break line, unequip by IDENTITY, clear
 *                     `owner.weapon` when it is the broken item, fire the Breaks edge; true on a break.
 *
 *   Cast When Strikes enchantments.js:585-602, :1124-1133 - the row casts, then returns
 *                     `{ durabilityLoss: 10 }`; `applyResults` bills it through `enchantLowerCondition` immediately, so
 *                     the bill is after the cast and is paid even when the cast was resisted, absorbed, deferred or had
 *                     no record. A `spareGear` target zeroes the bill (:1066-1072).
 *
 * Scope: the attacker's weapon, and its CWS bill. The target's shield/armour wear is traced above but not modelled
 * here (the target contract is an ordinary foe whose armour is read from its minted body, not a condition-bearing
 * equip table). Relay durability is out of scope: `simulateFight` refuses `spareGear` targets.
 *
 * All state passed in here is the fight's own clone; no caller-owned item is touched.
 */
import { EQUIP_SLOTS } from '../vendor/upstream/a3eb1605/src/characters/paperdoll/paperdoll.js';
import { conditionPercentage } from '../vendor/upstream/a3eb1605/src/systems/item/itemTemplates.js';
import { lowerCondition } from '../vendor/upstream/a3eb1605/src/systems/equip.js';

/** `DURABILITY_LOSS_ON_STRIKE` (systems/enchantments.js:115): one CWS row's condition bill. */
export const CWS_CONDITION_COST = 10;

/** `dice100(20)` (combat/formulas.js:585): the chance the zero-amount floor becomes one point. */
export const WEAR_FLOOR_CHANCE = 20;

/** `FormulaHelper.DamageEquipment`'s amount (combat/formulas.js:583), integer division. */
export const wearAmount = (damage) => (damage > 0 ? Math.trunc((10 * damage + 50) / 100) : 0);

/** `dice100` (combat/formulas.js:51): `Math.floor(roll * 100) < chance`. */
export const dice100 = (chance, roll) => Math.floor(roll * 100) < chance;

/**
 * One blow's wear on the port's actual scale: `CONDITION_WEAR_SCALE` 1 and `DFU_WEAR_MULTIPLE` 1 (systems/equip.js:500-568),
 * so `dfuBlowWear`/`blowWear` is the identity and draws nothing. The only draw is the 20% floor roll, and only when the
 * integer amount is 0 (damage 1..4). `rolls` is the fight's condition stream.
 */
export function blowWear(damage, rolls) {
  let amount = wearAmount(damage);
  if (amount === 0 && damage > 0 && dice100(WEAR_FLOOR_CHANCE, rolls())) amount = 1;
  return amount;
}

/** One CWS row's bill; a relay stand-in (`spareGear`) pays none (enchantments.js:1066-1072). */
export const cwsBill = (target) => (target?.spareGear ? 0 : CWS_CONDITION_COST);

/**
 * The fight's synthetic owner, in `lowerCondition`'s terms: DFU's equip table (the two hand slots) and the active
 * weapon. No host is attached, so `lowerCondition`'s unhookable doors see an ordinary owner; `items` is the (empty)
 * pack the fight never carries.
 */
export function makeOwner(main = null, off = null) {
  const slots = [];
  if (main) slots[EQUIP_SLOTS.RightHand] = main;
  if (off) slots[EQUIP_SLOTS.LeftHand] = off;
  return { equip: { slots }, weapon: main ?? null, items: [] };
}

/** Upstream's break leaf (systems/equip.js:570-608) over the fight's owner. Mutates the fight's clone only. */
export const wearItem = (owner, item, amount, say = null) => (
  amount > 0 && item ? lowerCondition(item, amount, owner, say) : false
);

/** The live condition percentage (`conditionPercentage`, systems/item/itemTemplates.js:277-279), or null. */
export const conditionPct = (item) => (item ? conditionPercentage(item) : null);

/** A fight-local deep-enough clone of one item: the arrays a wear/bill can read are copied, so no caller item changes. */
export const cloneItem = (it) => {
  if (!it || typeof it !== 'object') return it ?? null;
  return {
    ...it,
    ...(Array.isArray(it.affixes) ? { affixes: it.affixes.map((a) => (a && typeof a === 'object' ? { ...a } : a)) } : {}),
    ...(Array.isArray(it.enchantments) ? { enchantments: it.enchantments.map((e) => (e && typeof e === 'object' ? { ...e } : e)) } : {}),
    ...(Array.isArray(it.sockets) ? { sockets: it.sockets.map((s) => (s && typeof s === 'object' ? { ...s } : s)) } : {}),
  };
};
