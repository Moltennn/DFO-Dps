/*
 * test/harness/swingMachine.mjs - the pinned game's own swing machine, with a weapon breaking at its hit frame.
 *
 * This drives upstream's `PlayerWeapon` (combat/playerWeapon.js: hand cache, `followHeldHand`, `strikeHandOf`,
 * `_swing`, the off hand's held burden, the per-step `getMeleeWeaponAnimTime` read through `swingCtx`) exactly as
 * test/dualWield.test.js drives it - a held button, one blow at a time, the frame dropped when a tick's remainder
 * cannot fill it - and breaks one hand's weapon at the moment its blow's `hit` event is reported, through upstream's own
 * `lowerCondition` (systems/equip.js:570-608), which unequips by identity. Nothing here reads this project's code.
 *
 * It returns every `start`/`hit`/`done` the machine reports, with the machine time they were reported at and the
 * hands mode in force, so a test can read exactly when the surviving hand next lands a hit.
 */
import { upstream } from './upstream.mjs';

const item = (templateIndex, material) => ({
  group: 'Weapons', templateIndex, material, maxCondition: 1000, currentCondition: 1000,
});

/**
 * @param {{ right: number, left?: number|null, stats?: object, speed?: number, breakHand?: 'R'|'L'|null,
 *   breakHit?: number, dt: number, hits: number }} cfg
 *   `right`/`left` are weapon template indexes; `breakHit` is the 1-based hit (of the whole exchange) whose weapon breaks
 *   the moment its hit is reported, `breakHand` the hand that holds it; `hits` ends the run after that many hits.
 */
export async function swingMachine({
  right, left = null, stats = {}, speed = 60, breakHand = null, breakHit = 0, dt, hits = 8, material = 9, recordHold = false,
}) {
  const u = await upstream();
  const { PlayerWeapon } = u.playerWeapon;
  const { EQUIP_SLOTS, lowerCondition } = u.equip;
  const slots = [];
  slots[EQUIP_SLOTS.RightHand] = item(right, material);
  if (left != null) slots[EQUIP_SLOTS.LeftHand] = item(left, material);
  const entity = { stats: { speed, strength: 50, agility: 50, ...stats }, equip: { slots }, items: [] };
  const pw = new PlayerWeapon({ liveSpeed: speed });
  const sync = () => {
    pw.updateHands(slots[EQUIP_SLOTS.RightHand] ?? null, slots[EQUIP_SLOTS.LeftHand] ?? null);
    pw.applyWeapon();
  };
  sync();
  pw.animCtx = () => pw.swingCtx(entity);
  const events = [];
  const landed = [];
  const holds = [];
  let broke = null;
  let t = 0;
  let count = 0;
  const armed = () => !!(slots[EQUIP_SLOTS.RightHand] || slots[EQUIP_SLOTS.LeftHand]);
  while (count < hits && armed() && t < 600) {
    if (pw.machine.state === 'Idle' && pw.clickAttack(() => 0.5)) {
      events.push({ t, e: 'start', hand: pw.strike?.hand ?? null, flurry: !!pw.strike?.flurry, mode: pw.handsMode });
      if (recordHold && pw.strike?.off) holds.push(pw.machine.hold ?? 0);
    }
    const evs = pw.update(dt);
    t += dt;
    for (const e of evs) {
      if (e === 'hit') {
        count += 1;
        const hand = pw.strike?.hand ?? null;
        const rec = { t, e, hand, flurry: !!pw.strike?.flurry, mode: pw.handsMode, hit: count };
        events.push(rec);
        landed.push(rec);
        if (!broke && breakHand && count === breakHit) {
          const slot = breakHand === 'R' ? EQUIP_SLOTS.RightHand : EQUIP_SLOTS.LeftHand;
          const it = slots[slot];
          if (!lowerCondition(it, 1e6, entity)) throw new Error('swingMachine: the weapon did not break');
          broke = { t, hand: breakHand, hit: count };
          events.push({ t, e: 'break', hand: breakHand });
        }
      } else events.push({ t, e, hand: pw.strike?.hand ?? null });
    }
    sync();
  }
  return { events, hits: landed, broke, holds, mode: pw.handsMode, lead: pw.leadHand };
}
