/*
 * dfo-dps - dual wield: the schedule and the off hand's terms.
 *
 * The law is the game's own (vendor/upstream/a3eb1605/src/combat/twoHands/handsLaw.js), so the
 * constants and the off hand's surety/share/burden cannot drift from the pinned client.
 *
 * THE EXCHANGE (upstream)
 *   combat/twoHands/handsLaw.js:127-151  a strike begun within FLURRY_WINDOW (0.75 s) of the last one
 *                                        ending is the other hand's; `flurry` is a pair's only.
 *   combat/playerWeapon.js:803-830       a flurry's blow starts DUAL.FLURRY_FROM_FRAME (1) frames into
 *                                        its five-frame swing - FOUR ticks, at any frame rate - and an
 *                                        off-hand blow then holds `offHandHold` whole ticks at its end
 *                                        (its weapon's weight against Strength, `offHandBurden`).
 *   combat/playerWeapon.js:1244-1257     the off hand alone takes `offHandToHit(agility)` on the swing's
 *                                        to-hit channel and `OFF_HAND_BLOW` (share x0.8 of the rolled
 *                                        damage; weight 0.8 of a blow for what a blow sets off).
 *   A main-hand blow in a pair is the ordinary blow: full damage, full accuracy, full procs.
 *
 * So a held pair is lead, off, lead, off: 4 main ticks, then 4 off ticks plus the off hand's burden.
 * Against one weapon's 5 ticks a blow that is 2 blows per (8 + burden) ticks - the 1.22-1.28x swings
 * and 1.06-1.11x damage the game's own test pins (test/combat/twohands.test.js:145-183).
 */
import {
  DUAL,
  OFF_HAND_BLOW,
  offHandBurden,
  offHandDamage,
  offHandHold,
  offHandToHit,
  strikeHandOf,
} from '../vendor/upstream/a3eb1605/src/combat/twoHands/handsLaw.js';
import { SWING_FRAME_MAX } from '../vendor/upstream/a3eb1605/src/characters/weaponStates.js';

export { DUAL, OFF_HAND_BLOW, offHandBurden, offHandDamage, offHandHold, offHandToHit, strikeHandOf };

/** The five-frame swing's ticks once the flurry starts FLURRY_FROM_FRAME frames in (4). */
export const FLURRY_TICKS = 5 - DUAL.FLURRY_FROM_FRAME;
/** A single weapon's swing is five ticks. */
export const SINGLE_TICKS = 5;

/**
 * The long-run hold an off-hand blow pays: `offHandHold` in whole ticks with the fraction carried, so
 * over a fight the burden is paid exactly - `(min(burden, slowest-frame) - 1) x ticks`. A blow no
 * slower than SWING_FRAME_MAX never holds.
 */
export function averageOffHandHold({ burden = 1, ticks = FLURRY_TICKS, tick = 0 } = {}) {
  const most = tick > 0 ? Math.max(1, SWING_FRAME_MAX / tick) : 1;
  return Math.max(0, (Math.min(burden, most) - 1) * ticks);
}

/**
 * One exchange, in the units the machine uses: `mainTick`/`offTick` are the two weapons' own frame
 * times (their weights and handling, at the wielder's Speed and Strength); `burden` is
 * `offHandBurden(offWeight, strength)`.
 *
 * `period` is the seconds of one lead blow plus one off blow. `swingsPerSecond` counts both blows.
 */
export function dualSchedule({ mainTick, offTick, burden = 1 }) {
  const mainTicks = FLURRY_TICKS;
  const hold = averageOffHandHold({ burden, ticks: FLURRY_TICKS, tick: offTick });
  const offTicks = FLURRY_TICKS + hold;
  const period = mainTicks * mainTick + offTicks * offTick;
  return {
    mainTicks,
    offTicks,
    hold,
    period,
    swingsPerSecond: period > 0 ? 2 / period : 0,
    blowsPerSecondPerHand: period > 0 ? 1 / period : 0,
    mainSeconds: mainTicks * mainTick,
    offSeconds: offTicks * offTick,
    // what one weapon alone does, for the ratio
    singlePeriod: SINGLE_TICKS * mainTick,
  };
}

/** The swings a pair makes per swing of the same weapon alone (the game's 1.22-1.28x). */
export const swingsRatio = (schedule) => 2 * schedule.singlePeriod / schedule.period;

/**
 * The damage one exchange deals against one weapon's single blow, for the comparison the game's test
 * makes: `main` and `off` are the two hands' expected damage per landed blow (already weighted).
 */
export function damageRatio(schedule, mainPerBlow, offPerBlow) {
  return ((mainPerBlow + offPerBlow) / schedule.period) / (mainPerBlow / schedule.singlePeriod);
}
