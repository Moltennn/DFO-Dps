/*
 * test/dualWield.test.js - C3: a pair is tempo, not twice the damage.
 *
 * Upstream (vendor/upstream/a3eb1605):
 *   combat/twoHands/handsLaw.js      strikeHandOf (a flurry within FLURRY_WINDOW), DUAL (flurry from
 *                                    frame 1, off damage x0.8, off to-hit by Agility, off weight x1.5,
 *                                    off burden by weight), offHandDamage/offHandToHit/offHandHold
 *   combat/playerWeapon.js:803-830   a flurry's blow starts one frame in (four ticks), an off blow holds
 *                                    the burden in whole ticks at its end
 *   combat/playerWeapon.js:1244-1257 the off hand alone takes offHandToHit and OFF_HAND_BLOW
 *
 * The schedule is checked against the game's own weapon machine, driven here exactly as the game's
 * test drives it (test/combat/twohands.test.js:145-183): blows counted, at two frame rates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, referenceFoe, gateTarget, weaponOf } from '../src/model.js';
import { DUAL, OFF_HAND_BLOW, FLURRY_TICKS, dualSchedule, swingsRatio, damageRatio, offHandToHit, offHandDamage, offHandBurden, averageOffHandHold } from '../src/dualWield.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { upstream } from './harness/upstream.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const TOUGH = () => referenceFoe(45, 'tough');

/** A character with a named weapon and (optionally) the same weapon in the other hand. */
function pair(template, { material = 9, agility = 50, strength = 50, speed = 50, skill = 150, off = true, crit = 0 } = {}) {
  const skillId = template >= 113 && template <= 117 ? 28 // short blade
    : template >= 118 && template <= 123 ? 29 // long blade
    : template === 127 || template === 128 ? 31 // axe
    : template === 129 || template === 130 ? 33 // archery
    : 32; // blunt (115, 124, 125, 126)
  const ch = simCharacter(
    character({ level: 45, stats: { strength, agility, speed }, skillOverride: { [skillId]: skill, 34: crit } }),
    weapon(template, { material }),
  );
  return off ? { ...ch, offWeapon: { ...ch.weapon, equipSlot: 21 } } : ch;
}
const run = (ch, extra = {}) => analyze(ch, { target: TOUGH(), rri: false, ...extra });

/**
 * The game's own machine, driven as its test drives it: a held button, one blow at a time, the frame
 * dropped when a tick's remainder cannot fill it. Returns the blows a second and which hand threw them.
 */
async function machine({ template, paired = false, speed = 50, strength = 50, agility = 50, seconds = 200, fps = 144 }) {
  const u = await upstream();
  const { PlayerWeapon } = u.playerWeapon;
  const { EQUIP_SLOTS } = u.equip;
  const mk = (m) => ({ group: 'Weapons', templateIndex: template, material: m, maxCondition: 1000, currentCondition: 1000 });
  const right = mk(1);
  const left = paired ? mk(2) : null;
  const pw = new PlayerWeapon({ liveSpeed: speed });
  const entity = { stats: { speed, strength, agility }, equip: { slots: { [EQUIP_SLOTS.RightHand]: right, ...(left ? { [EQUIP_SLOTS.LeftHand]: left } : {}) } } };
  pw.updateHands(right, left);
  pw.applyWeapon();
  pw.animCtx = () => pw.swingCtx(entity);
  let blows = 0;
  let offBlows = 0;
  const dt = 1 / fps;
  for (let t = 0; t < seconds; t += dt) {
    if (pw.machine.state === 'Idle' && pw.clickAttack(() => 0.5)) {
      blows += 1;
      if (pw.strike.off) offBlows += 1;
    }
    pw.update(dt);
    pw.updateHands(right, left);
    pw.applyWeapon();
  }
  return { blowsPerSecond: blows / seconds, blows, offBlows, offShare: blows ? offBlows / blows : 0 };
}

// ── the law ─────────────────────────────────────────────────────────────────
test('law: the constants and per-hand terms are the game\'s own', async () => {
  const u = await upstream();
  assert.deepEqual({ ...DUAL }, { ...u.handsLaw.DUAL });
  assert.deepEqual({ ...OFF_HAND_BLOW }, { ...u.handsLaw.OFF_HAND_BLOW });
  assert.equal(FLURRY_TICKS, 5 - u.handsLaw.DUAL.FLURRY_FROM_FRAME);
  for (const a of [0, 30, 44, 45, 50, 55, 70, 100, 140]) assert.equal(offHandToHit(a), u.handsLaw.offHandToHit(a), `offHandToHit(${a})`);
  for (const d of [0, -3, 1, 2, 4, 8, 13]) assert.equal(offHandDamage(d), u.handsLaw.offHandDamage(d), `offHandDamage(${d})`);
  for (const [w, s] of [[0.5, 50], [4.5, 50], [4.5, 90], [7, 50]]) assert.ok(near(offHandBurden(w, s), u.handsLaw.offHandBurden(w, s)));
});

test('schedule: a pair makes two blows per eight ticks, one weapon one per five', () => {
  const s = dualSchedule({ mainTick: 0.2, offTick: 0.2, burden: 1 });
  assert.equal(s.mainTicks, 4);
  assert.equal(s.offTicks, 4);
  assert.ok(near(s.period, 1.6));
  assert.ok(near(s.swingsPerSecond, 1.25));
  assert.ok(near(swingsRatio(s), 1.25));
  // a burden is paid in whole ticks at the off blow's end, averaged exactly over a fight
  const b = 1.1;
  const heavy = dualSchedule({ mainTick: 0.2, offTick: 0.2, burden: b });
  assert.ok(near(heavy.hold, 4 * (b - 1)));
  assert.ok(near(heavy.offTicks, 4 + 4 * (b - 1)));
  assert.ok(swingsRatio(heavy) < 1.25, 'the off arm slows the exchange');
  // a blow no slower than the swing law's slowest never holds
  assert.equal(averageOffHandHold({ burden: 1.3, ticks: 4, tick: 0.4 }), 0);
});

test('schedule: matches the game\'s machine, blows a second, for four weapons and two frame rates', async () => {
  for (const template of [113, 120, 121, 124]) {
    const ch = pair(template, { off: true });
    const single = run(pair(template, { off: false }));
    const dual = run(ch, { dual: true });
    const sched = dualSchedule({ mainTick: single.cadence.tick, offTick: dual.offHand.cadence.tick, burden: offHandBurden(weaponOf(weapon(template, { material: 9 })).weight, 50) });
    for (const fps of [30, 144]) {
      const one = await machine({ template, paired: false, fps });
      const two = await machine({ template, paired: true, fps });
      const rate = two.blowsPerSecond / one.blowsPerSecond;
      // the model's swings ratio against the machine's, at either frame rate (the machine quantises a
      // tick to whole frames, so it runs a couple of percent slower)
      assert.ok(Math.abs(rate - swingsRatio(sched)) < 0.03, `${template} @${fps}fps: machine x${rate.toFixed(3)} vs schedule x${swingsRatio(sched).toFixed(3)}`);
      // both hands throw, in turn
      assert.ok(two.offShare > 0.45 && two.offShare < 0.55, `${template}: off hand threw ${(two.offShare * 100).toFixed(0)}%`);
      assert.equal(one.offBlows, 0, 'one weapon never strikes with the other hand');
    }
  }
});

// ── the model against one weapon ────────────────────────────────────────────
test('model: a matched pair at low accuracy lands the pinned ~9% edge, not 80%', () => {
  const single = run(pair(113, { off: false, skill: 60 }));
  const dual = run(pair(113, { off: true, skill: 60 }), { dual: true });
  const ratio = dual.dps / single.dps;
  assert.ok(ratio > 1.05 && ratio < 1.13, `pair x${ratio.toFixed(3)}`);
  assert.ok(near(dual.cadence.aps / single.cadence.aps, 1.25, 1e-9), 'a quarter more swings');
  assert.ok(dual.dps < single.dps * 1.25, 'never two blows a swing');
});

test('model: with no accuracy penalty the pair is exactly (1 + 0.8) / (8/5)', () => {
  // Agility 100: offHandToHit is 0, so the off blow is exactly 0.8 of the main blow (same weapon).
  const single = run(pair(113, { off: false, agility: 100, skill: 150 }));
  const dual = run(pair(113, { off: true, agility: 100, skill: 150 }), { dual: true });
  assert.ok(near(dual.dps / single.dps, (1 + 0.8) * 5 / 8, 0.01), `${dual.dps / single.dps} (per-blow rounding keeps it within 1%)`);
});

test('model: each hand is its own blow - damage, accuracy, crit and traits', () => {
  // A low skill keeps the hit chance off the 3..97 clamp so the off hand's accuracy term is visible.
  const ch = pair(121, { agility: 30, skill: 60 });
  const dual = run(ch, { dual: true });
  const main = analyze(ch, { target: TOUGH() });
  const off = dual.offHand;
  // the main hand is the ordinary blow
  assert.ok(near(dual.perSwing * 2 - off.perSwing, main.perSwing, 1e-9));
  // the off hand is less sure (Agility 30 -> -7) and lands 0.8 of the blow
  assert.equal(offHandToHit(30), -7);
  assert.equal(off.hit.terms.other, main.hit.terms.other - 7, 'the Agility term on the swing channel');
  assert.ok(off.hit.hitPlain < main.hit.hitPlain, 'the off swing is less accurate');
  assert.ok(off.perSwing < main.perSwing, 'and lands less');
  const noPenalty = run(pair(121, { agility: 100, skill: 120 }), { dual: true });
  assert.ok(near(noPenalty.offHand.hit.hitPlain, analyze(pair(121, { agility: 100, skill: 120 }), { target: TOUGH() }).hit.hitPlain, 1e-9), 'Agility 100: the same accuracy');
  // criticals are the same model on both hands; the off blow is 0.8 of it
  assert.ok(near(off.hit.crit.chance, main.hit.crit.chance));
  assert.ok(Math.abs(off.damage.critAvg - offHandDamage(Math.round(main.damage.critAvg))) <= 1, 'off crit = 0.8 of the main blow, rounded');
});

test('model: a heavy off weapon slows the exchange through its burden, not its stats', () => {
  const light = run(pair(120, { off: true, strength: 50 }), { dual: true });
  const heavy = analyze({ ...pair(120, { off: true, strength: 50 }), offWeapon: { ...weapon(124, { material: 9 }), equipSlot: 21 } }, { target: TOUGH(), dual: true });
  assert.ok(heavy.cadence.period > light.cadence.period, 'a mace off hand is slower than a longsword');
  assert.ok(heavy.offHand.cadence.tick > light.offHand.cadence.tick, 'its own tick is what paces it');
  // the burden is the game's, from the off weapon's weight at this Strength
  assert.ok(near(heavy.schedule.hold, averageOffHandHold({ burden: offHandBurden(4.5, 50), ticks: FLURRY_TICKS, tick: heavy.offHand.cadence.tick }), 1e-12));
});

// ── the hands' items ────────────────────────────────────────────────────────
test('elemental affixes: each hand\'s own, once, and the off hand\'s at its share', () => {
  const base = pair(121, { off: true, agility: 100, skill: 150 });
  const noAffix = run(base, { dual: true });
  const mainAffix = run({ ...base, weapon: { ...base.weapon, affixes: [{ id: 'elemental', param: 'fire', value: 10 }] } }, { dual: true });
  const offAffix = run({ ...base, offWeapon: { ...base.offWeapon, affixes: [{ id: 'elemental', param: 'fire', value: 10 }] } }, { dual: true });
  // a main-hand affix rides the main blow: +10 on a landed blow, averaged over the two hands and the hit chance
  const hit = noAffix.hit.hit;
  assert.ok(near(mainAffix.perSwing - noAffix.perSwing, (10 * hit) / 2, 1e-9), `${mainAffix.perSwing - noAffix.perSwing}`);
  // an off-hand affix rides the off blow, which then takes its 0.8 share (with the same hit chance), averaged
  assert.ok(near(offAffix.perSwing - noAffix.perSwing, (10 * 0.8 * noAffix.offHand.hit.hit) / 2, 1e-9), `${offAffix.perSwing - noAffix.perSwing}`);
  // and never twice
  assert.ok(mainAffix.perSwing - noAffix.perSwing < 5.5, 'not the doubled contribution');
});

test('procs: the main hand fires every landed blow, the off hand at 0.8 weight', () => {
  const spell = { name: 'x', element: 4, rangeType: 0, cost: 10, effects: [{ type: 4, subType: 0, magnitudeBaseLow: 40, magnitudeBaseHigh: 40, magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1, durationBase: 0, durationMod: 0, durationPerLevel: 1, chanceBase: 0, chanceMod: 0, chancePerLevel: 1 }] };
  const standard = new Map([[7, spell]]);
  const base = pair(121, { off: true, agility: 100, skill: 150 });
  const none = run(base, { dual: true, standard });
  const main = run({ ...base, weapon: { ...base.weapon, maxCondition: 100, currentCondition: 100, enchantments: [{ type: 2, param: 7 }] } }, { dual: true, standard });
  const off = run({ ...base, offWeapon: { ...base.offWeapon, maxCondition: 100, currentCondition: 100, enchantments: [{ type: 2, param: 7 }] } }, { dual: true, standard });
  assert.equal(none.enchantPerSwing, 0);
  assert.ok(main.enchantPerSwing > 0);
  // the same spell on the off hand contributes OFF_HAND_BLOW.blowWeight of a main-hand proc
  assert.ok(near(off.enchantPerSwing, main.enchantPerSwing * OFF_HAND_BLOW.blowWeight, 1e-9), `${off.enchantPerSwing} vs ${main.enchantPerSwing * 0.8}`);
});

// ── the encounter ───────────────────────────────────────────────────────────
test('C1: each hand is its own time-ordered claim at the Breach', () => {
  const ch = pair(121, { off: true, agility: 50, skill: 150 });
  const gate = gateTarget(45);
  const single = analyze(pair(121, { off: false, agility: 50, skill: 150 }), { target: gate, health: 12000 });
  const dual = analyze(ch, { target: gate, health: 12000, dual: true });
  assert.ok(dual.allowance && single.allowance);
  // claims a second: one a period from each hand, each weighted by its own hit chance
  const expected = dual.cadence.aps * (dual.hit.hit + dual.offHand.hit.hit) / 2;
  assert.ok(near(dual.allowance.claimsPerSecond, expected, 1e-9), `${dual.allowance.claimsPerSecond} vs ${expected}`);
  // both hands' damage is offered, at the exchange's rate
  assert.ok(dual.allowance.ceilingDps > single.allowance.ceilingDps, 'the pair offers more a second');
  assert.ok(dual.allowance.ceilingDps < single.allowance.ceilingDps * 1.25);
  // and the allowance still bounds it
  assert.ok(dual.ttk >= (12000 - 750) / 150 - 1e-9);
});

test('C2: a boss trait resolves each hand\'s own blow', () => {
  // main hand a blade, off hand a hammer: stoneskin halves the hammer alone
  const ch = { ...pair(121, { off: true, agility: 50 }), offWeapon: { ...weapon(124, { material: 9 }), equipSlot: 21 } };
  const gate = gateTarget(45);
  const dual = analyze(ch, { target: gate, health: 12000, dual: true });
  const mainOnly = analyze(pair(121, { off: false, agility: 50 }), { target: gate, health: 12000 });
  assert.ok(near(mainOnly.perSwing - (dual.perSwing * 2 - dual.offHand.perSwing), 0, 1e-9), 'the main blow is the same as alone');
  // the off hand's blow is halved by stoneskin before its own 0.8 share
  const neutralOff = analyze(ch, { target: gate, health: 12000, dual: true, traits: [] }).offHand;
  assert.ok(near(dual.offHand.perSwing / neutralOff.perSwing, 0.5, 0.02), `off hand halved: ${(dual.offHand.perSwing / neutralOff.perSwing).toFixed(3)}`);
});

// ── what is not a pair ──────────────────────────────────────────────────────
test('single weapon and two-handed weapons are untouched', () => {
  const s = run(pair(121, { off: false }));
  assert.equal(s.dual, undefined);
  assert.ok(near(s.cadence.seconds, 5 * s.cadence.tick, 1e-12), 'a single weapon is five ticks a blow');
  // a two-handed main hand never enters a pair
  const two = analyze({ ...pair(123, { off: false }), offWeapon: { ...weapon(121, { material: 9 }), equipSlot: 21 } }, { target: TOUGH(), dual: true });
  assert.ok(!two.dual);
});
