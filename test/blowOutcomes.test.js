/*
 * test/blowOutcomes.test.js - Stage 3.1, Parts C and D: the per-blow outcome distribution and its sampler (src/blowOutcomes.js).
 *
 * LOCAL tests: they hold the module to its own contract and to `analyze`; they are NOT upstream parity (that is
 * test/blowDifferential.test.js). What is verified here:
 *   normalisation      the full and the fight tier each sum to 1 within TOLERANCE, and merging conserves probability
 *   same pipeline      the distribution's means equal analyze()'s perSwing / cappedPerSwing / hit chance for every scenario
 *                      (a second damage formula would show here)
 *   no information lost in the merge   outcomes with equal damage but different direction / crit / hit / whole / echo / facing stay apart
 *   shape              six directions for a melee swing, StrikeDown for a bow, neutral for a gun; a miss is its own outcome
 *   sampler            the CDF mapping, its boundaries, determinism, draw accounting, and the empirical joint distribution
 *   isolation          nothing existing changes: analyze is called, not altered
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, referenceFoe, weaponOf, SWING_DIRECTIONS } from '../src/model.js';
import { blowOutcomes, mergeToFightTier, blowFightTier, tierMeans, createBlowSampler, TOLERANCE } from '../src/blowOutcomes.js';
import { createRng } from '../src/rng.js';
import { PCAAO_BODY_PARTS } from '../src/data.js';
import { powerOf } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { CONFIGS, localSide, localTarget } from './harness/blowConfigs.mjs';
import { compareCounts, jointKey } from './harness/blowOracle.mjs';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test('1. both tiers are normalised, and merging conserves probability', () => {
  for (const cfg of CONFIGS) {
    const { ch, args, hand } = localSide(cfg);
    const full = blowOutcomes(ch, { ...args, hand });
    const fight = mergeToFightTier(full);
    assert.ok(Math.abs(full.total - 1) <= TOLERANCE, `${cfg.id}: full tier sums to ${full.total}`);
    assert.ok(Math.abs(fight.total - 1) <= TOLERANCE, `${cfg.id}: fight tier sums to ${fight.total}`);
    assert.ok(full.outcomes.every((o) => o.p > 0 && o.p <= 1));
    assert.equal(fight.mergedFrom, full.outcomes.length);
    assert.ok(fight.outcomes.length < full.outcomes.length, `${cfg.id}: merging reduces the tier`);
    // per merge key, the fight tier's probability is the sum of the full tier's (checked against an independent grouping)
    const by = new Map();
    for (const o of full.outcomes) by.set(jointKey(o), (by.get(jointKey(o)) ?? 0) + o.p);
    assert.equal(by.size, fight.outcomes.length, `${cfg.id}: the same number of joint keys`);
    for (const o of fight.outcomes) assert.ok(near(by.get(jointKey(o)), o.p, 1e-12), `${cfg.id}: ${jointKey(o)}`);
    assert.ok(Object.isFrozen(fight.outcomes[0]), 'fight outcomes are immutable');
  }
});

test('2. the distribution is the same pipeline as analyze(): its means equal the card, capped and uncapped', () => {
  for (const cfg of CONFIGS) {
    const { ch, args, hand } = localSide(cfg);
    const fight = blowFightTier(ch, { ...args, hand });
    const m = tierMeans(fight);
    // the card for the hand: a dual build's off hand is analyze's `.offHand`; a main hand is the same build alone
    const card = cfg.dual && hand === 'off'
      ? analyze(ch, { ...args }).offHand
      : analyze(ch, { ...args, dual: false });
    assert.ok(near(m.perSwing, card.perSwing, 1e-12), `${cfg.id}: uncapped ${m.perSwing} vs ${card.perSwing}`);
    assert.ok(near(m.cappedPerSwing, card.cappedPerSwing, 1e-12), `${cfg.id}: capped ${m.cappedPerSwing} vs ${card.cappedPerSwing}`);
    assert.ok(near(m.hit, card.hit.hit, 1e-12), `${cfg.id}: hit ${m.hit} vs ${card.hit.hit}`);
    assert.ok(near(m.crit, card.hit.crit.chance, 1e-12), `${cfg.id}: crit chance`);
  }
  // explicit directions, the echo what-if, and the off-hand option of a pair, through the same comparison
  const { ch, args } = localSide(CONFIGS[1]);
  for (const swing of ['StrikeUp', 'StrikeDown', 'StrikeLeft']) {
    const f = blowFightTier(ch, { ...args, swing });
    assert.deepEqual(f.directions, [swing]);
    assert.ok(near(tierMeans(f).perSwing, analyze(ch, { ...args, swing }).perSwing, 1e-12), swing);
  }
  const pair = blowFightTier(ch, { ...args, hand: 'off' });
  assert.ok(near(tierMeans(pair).cappedPerSwing, analyze(ch, { ...args, offHand: true }).cappedPerSwing, 1e-12), 'offHand: true');
});

test('3a. exact independent branch probabilities: direction, body part, whole, backstab and echo', () => {
  // direction: the upstream six-strike table, exactly one sixth each
  const dirDesc = character({ level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 }, skills: 0, skillOverride: { 29: 70, 34: 40 } });
  const dirItem = weapon(121, { material: 9 });
  const dirCh = simCharacter(dirDesc, dirItem);
  const dir = blowFightTier(dirCh, { target: referenceFoe(30, 'tough'), weapon: weaponOf(dirItem) });
  assert.equal(dir.directions.length, 6);
  for (let i = 0; i < 6; i++) assert.ok(near(dir.outcomes.filter((o) => o.directionIndex === i).reduce((s, o) => s + o.p, 0), 1 / 6, 1e-12));

  // body part: the 20-slot upstream table's seven counts, exactly
  const counts = new Array(7).fill(0);
  for (const part of PCAAO_BODY_PARTS) counts[part]++;
  const full = blowOutcomes(dirCh, { target: referenceFoe(30, 'tough'), weapon: weaponOf(dirItem) });
  for (let part = 0; part < 7; part++) {
    const p = full.outcomes.filter((o) => o.part === part).reduce((s, o) => s + o.p, 0);
    assert.ok(near(p, counts[part] / PCAAO_BODY_PARTS.length, 1e-12), `part ${part}: ${p}`);
  }

  // off-hand whole: the upstream 80% weight, and the two branches sum to the landed/missed total
  const off = blowFightTier(dirCh, { target: referenceFoe(30, 'tough'), weapon: weaponOf(dirItem), hand: 'off' });
  assert.ok(near(off.outcomes.filter((o) => o.whole).reduce((s, o) => s + o.p, 0), 0.8, 1e-12));

  // backstab: Backstabbing / 100 of the landed facing blows (the x3 is rolled on a hit only)
  const stabDesc = character({ level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 }, skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 } });
  const stab = blowFightTier(simCharacter(stabDesc, dirItem), { target: referenceFoe(30, 'tough'), weapon: weaponOf(dirItem), backstabUptime: 0.5 });
  const hitFacing = stab.outcomes.filter((o) => o.facing && o.hit).reduce((s, o) => s + o.p, 0);
  const backstab = stab.outcomes.filter((o) => o.backstab).reduce((s, o) => s + o.p, 0);
  assert.ok(near(backstab / hitFacing, 50 / 100, 1e-12), `backstab share ${backstab / hitFacing}`);

  // echo: one and two powers, against the independent product of the upstream chances
  const echoChance = powerOf('warp-edge').chance / 100;
  for (const cfg of CONFIGS.filter((c) => c.echoPower)) {
    const { ch, args } = localSide(cfg);
    const cfgFull = blowOutcomes(ch, args);
    const eligible = cfgFull.outcomes.filter((o) => o.echoEligible).reduce((s, o) => s + o.p, 0);
    const masks = [0, 1, 2, 3].map((mask) => cfgFull.outcomes.filter((o) => o.echoEligible && o.echoMask === mask).reduce((s, o) => s + o.p, 0));
    const n = cfg.echoCalls === 2 ? 2 : 1;
    for (let mask = 0; mask < (1 << n); mask++) {
      let expected = 1;
      for (let k = 0; k < n; k++) expected *= (mask >> k) & 1 ? echoChance : 1 - echoChance;
      assert.ok(near(masks[mask] / eligible, expected, 1e-12), `${cfg.id}: echo mask ${mask}: ${masks[mask] / eligible} vs ${expected}`);
    }
    if (n === 1) assert.equal(masks[2] + masks[3], 0, `${cfg.id}: one power cannot set bit 2`);
  }
});

test('3b. every fight-tier field is either preserved or derivable from the merge key', () => {
  for (const cfg of CONFIGS) {
    const { ch, args, hand } = localSide(cfg);
    const full = blowOutcomes(ch, { ...args, hand });
    const fight = mergeToFightTier(full);
    assert.ok(full.outcomes.every((o) => Number.isInteger(o.part) && 'roll' in o && 'preFinish' in o && 'card' in o), `${cfg.id}: the full tier keeps part and roll fields`);
    for (const o of fight.outcomes) {
      assert.ok(!('part' in o) && !('roll' in o) && !('preFinish' in o) && !('card' in o), `${cfg.id}: the fight tier marginalises part/roll detail`);
      assert.equal(o.damage, o.blow + o.echoDamage, `${cfg.id}: damage derives`);
      assert.equal(o.claim, fight.cap > 0 ? Math.min(o.blow, fight.cap) : o.blow, `${cfg.id}: claim derives`);
      assert.equal(o.cappedDamage, o.claim + o.echoDamage, `${cfg.id}: capped derives`);
      assert.equal(o.echoHits, [...Array(8)].filter((_, i) => (o.echoMask >> i) & 1).length, `${cfg.id}: echo hits derive from the mask`);
    }
  }
});

test('3c. full outcomes keep the finish() shape: the same keys in the same order, all primitive values', () => {
  // finish() fills the damage/echo fields onto the caller's outcome object. This pins its observable shape (the 11
  // appended fields, their order and their primitive types), since the insertion order is what JSON/`Object.keys`
  // readers see and a change here silently alters serialised tiers.
  const appended = [
    'blow', 'echoDamage', 'damage', 'claim', 'cappedDamage',
    'echoMask', 'echoHits', 'echoEligible', 'formulaPositive', 'strikesDamage', 'strikesPositive',
  ];
  const base = ['p', 'direction', 'directionIndex', 'facing', 'backstab', 'crit', 'part', 'whole', 'hit', 'roll', 'preFinish', 'card'];
  const { ch, args, hand } = localSide(CONFIGS[1]);
  const full = blowOutcomes(ch, { ...args, hand });
  assert.ok(full.outcomes.length > 0);
  for (const o of full.outcomes) {
    assert.deepEqual(Object.keys(o), [...base, ...appended], 'the outcome keys and their insertion order');
    assert.equal(Object.keys(o).length, base.length + appended.length, 'no extra field sneaks in');
    for (const k of ['blow', 'echoDamage', 'damage', 'claim', 'cappedDamage', 'strikesDamage']) {
      assert.equal(typeof o[k], 'number', `${k} is a number`);
    }
    for (const k of ['echoMask', 'echoHits']) assert.ok(Number.isInteger(o[k]), `${k} is an integer`);
    for (const k of ['echoEligible', 'formulaPositive', 'strikesPositive']) {
      assert.equal(typeof o[k], 'boolean', `${k} is a boolean`);
    }
    assert.equal(o.damage, o.blow + o.echoDamage, 'damage is blow + echoDamage');
    assert.equal(o.claim, full.cap > 0 ? Math.min(o.blow, full.cap) : o.blow, 'claim is blow under the cap');
    assert.equal(o.cappedDamage, o.claim + o.echoDamage, 'cappedDamage is claim + echoDamage');
  }
});

test('3. the merge keeps every distinction the fight needs: nothing is merged only because damage matches', () => {
  // an off-hand blow with no Strikes payload: whole and not-whole deal the SAME damage and must stay two outcomes
  const desc = character({ level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 }, skills: 0, skillOverride: { 29: 70, 34: 40 } });
  const item = weapon(121, { material: 9 });
  const ch = simCharacter(desc, item);
  const tgt = referenceFoe(30, 'tough');
  const off = blowFightTier(ch, { target: tgt, weapon: weaponOf(item), hand: 'off' });
  const wholeP = off.outcomes.filter((o) => o.whole).reduce((s, o) => s + o.p, 0);
  assert.ok(near(wholeP, 0.8, 1e-12), `whole ${wholeP}`);
  const twin = (o) => off.outcomes.find((q) => !q.whole && q.directionIndex === o.directionIndex && q.crit === o.crit && q.hit === o.hit && q.blow === o.blow);
  const wholes = off.outcomes.filter((o) => o.whole);
  assert.ok(wholes.length > 0 && wholes.every((o) => twin(o)), 'every whole outcome has a not-whole twin of equal damage');
  assert.equal(blowFightTier(ch, { target: tgt, weapon: weaponOf(item) }).outcomes.every((o) => o.whole), true, 'a main hand is always whole');

  // direction, crit and hit distinctions survive equal damage
  const main = blowFightTier(ch, { target: tgt, weapon: weaponOf(item) });
  const damages = new Map();
  for (const o of main.outcomes) {
    const k = String(o.blow);
    if (!damages.has(k)) damages.set(k, new Set());
    damages.get(k).add(`${o.directionIndex}|${o.crit}|${o.hit}`);
  }
  assert.ok([...damages.values()].some((s) => s.size > 1), 'one damage value is reached by several (direction, crit, hit) states, all kept');
  assert.ok(main.outcomes.some((o) => !o.hit && o.blow === 0), 'a miss is its own outcome');
  // the six directions are each one sixth, exactly
  for (let i = 0; i < 6; i++) {
    const p = main.outcomes.filter((o) => o.directionIndex === i).reduce((s, o) => s + o.p, 0);
    assert.ok(near(p, 1 / 6, 1e-12), `direction ${i}: ${p}`);
  }
  assert.deepEqual(main.directions, [...SWING_DIRECTIONS]);

  // a landed blow and a miss both worth 5 (Potent Vs pays on a miss): `hit` keeps them apart
  const pv = { ...item, enchantments: [{ type: 4, param: 1 }] };
  const gate = localTarget(CONFIGS[1]);
  const pvTier = blowFightTier(simCharacter(desc, pv), { target: { ...gate, bossTraits: [], hitCap: 0 }, weapon: weaponOf(pv) });
  const missFive = pvTier.outcomes.filter((o) => !o.hit && o.blow === 5);
  assert.ok(missFive.length > 0 && near(missFive.reduce((s, o) => s + o.p, 0), 1 - tierMeans(pvTier).hit, 1e-12), 'every miss is worth the 5 and is still a miss');

  // facing / backstab stay apart too
  const stabber = simCharacter(character({ level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 }, skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 } }), item);
  const back = blowFightTier(stabber, { target: tgt, weapon: weaponOf(item), backstabUptime: 0.5 });
  assert.ok(back.outcomes.some((o) => o.facing && o.backstab) && back.outcomes.some((o) => o.facing && !o.backstab) && back.outcomes.some((o) => !o.facing));
  const p3 = back.outcomes.filter((o) => o.backstab).reduce((s, o) => s + o.p, 0);
  const pFacingHit = back.outcomes.filter((o) => o.facing && o.hit).reduce((s, o) => s + o.p, 0);
  assert.ok(near(p3 / pFacingHit, 50 / 100, 1e-9), 'x3 is Backstabbing/100 of the landed facing blows');
});

test('4. shape: a bow releases StrikeDown, a gun is neutral, caps clip the claim and never the damage', () => {
  const desc = character({ level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 }, skills: 0, skillOverride: { 33: 90, 34: 40 } });
  const tgt = referenceFoe(30, 'tough');
  const bowItem = weapon(130, { material: 9 });
  const bow = blowFightTier(simCharacter(desc, bowItem), { target: tgt, weapon: weaponOf(bowItem) });
  assert.deepEqual(bow.directions, ['StrikeDown']);
  assert.ok(bow.outcomes.every((o) => o.directionIndex === 0));
  const gunItem = weapon(560, { material: 9 });
  const gun = blowFightTier(simCharacter(desc, gunItem), { target: tgt, weapon: weaponOf(gunItem) });
  assert.deepEqual(gun.directions, ['StrikeLeft'], 'a gun has no swing state: the neutral entry');
  // an explicit direction on a bow is honoured (the caller asked for it)
  assert.deepEqual(blowFightTier(simCharacter(desc, bowItem), { target: tgt, weapon: weaponOf(bowItem), swing: 'StrikeUp' }).directions, ['StrikeUp']);

  const cfg = CONFIGS[1];
  const { ch, args } = localSide(cfg);
  const fight = blowFightTier(ch, args);
  for (const o of fight.outcomes) {
    assert.equal(o.claim, Math.min(o.blow, cfg.cap), 'the claim is the blow under the cap');
    assert.equal(o.cappedDamage, o.claim + o.echoDamage);
    assert.equal(o.damage, o.blow + o.echoDamage);
    assert.ok(o.cappedDamage <= o.damage);
  }
  assert.ok(fight.outcomes.some((o) => o.claim < o.blow), 'the cap binds on this build');
  const uncapped = blowFightTier(ch, { ...args, target: { ...args.target, hitCap: 0 } });
  assert.ok(uncapped.outcomes.every((o) => o.claim === o.blow));
  assert.ok(near(tierMeans(uncapped).perSwing, tierMeans(fight).perSwing, 1e-12), 'the cap leaves the uncapped damage alone');
  assert.ok(tierMeans(fight).cappedPerSwing < tierMeans(fight).perSwing);
  // a relay body carries the echo in the blow; an ordinary foe's echo is its own hit
  assert.ok(fight.outcomes.every((o) => o.echoDamage === 0) && fight.outcomes.some((o) => o.echoHits > 0));
  const own = localSide(CONFIGS.find((c) => c.door));
  const ordinary = blowFightTier(own.ch, own.args);
  assert.ok(ordinary.outcomes.some((o) => o.echoDamage > 0) && ordinary.outcomes.every((o) => o.claim === o.blow));
  assert.throws(() => blowOutcomes(ch, { ...args, hand: 'both' }), RangeError);
});

test('5. the sampler: a documented CDF mapping with safe boundaries', () => {
  const { ch, args } = localSide(CONFIGS[1]);
  const fight = blowFightTier(ch, args);
  const sampler = createBlowSampler(fight);
  assert.equal(sampler.sampled, true);
  assert.ok(Math.abs(sampler.total - 1) <= TOLERANCE);
  const live = fight.outcomes.filter((o) => o.p > 0);
  assert.equal(sampler.size, live.length);
  assert.equal(sampler.outcomeAt(0), live[0], 'u = 0 is the first outcome');
  assert.equal(sampler.outcomeAt(1 - 2 ** -53), live[live.length - 1], 'the largest u below 1 is the last');
  assert.equal(sampler.outcomeAt(-0), live[0]);
  for (const bad of [1, 1.5, -0.1, NaN, Infinity]) assert.throws(() => sampler.outcomeAt(bad), RangeError, String(bad));
  // every outcome owns exactly the interval its probability names (boundaries included)
  let cum = 0;
  for (let i = 0; i < live.length; i++) {
    const o = live[i];
    const mid = (cum + o.p / 2) / sampler.total;
    assert.equal(sampler.outcomeAt(Math.min(mid, 1 - 2 ** -53)), o, 'the middle of an outcome\'s interval maps to it');
    cum += o.p;
    // exact CDF boundaries: [previous cumulative, this cumulative) belongs to this outcome; the boundary itself
    // belongs to the next (half-open intervals, the documented mapping)
    if (i + 1 < live.length) {
      const boundary = cum / sampler.total;
      // the table's internal CDF is accumulated with compensation; a boundary read from a naive sum differs by
      // a few ulps, so step 1e-12 across it rather than demanding bitwise the same index
      const above = Math.min(1 - 2 ** -53, boundary + 1e-12);
      const below = Math.max(0, boundary - 1e-12);
      assert.equal(sampler.outcomeAt(above), live[i + 1], 'just above the boundary is the next interval');
      assert.equal(sampler.outcomeAt(below), o, 'just below the boundary stays here');
    }
  }
  // a zero-probability outcome is never returned, and a table of one outcome always returns it
  const withZero = { ...fight, outcomes: [{ ...live[0], p: 0 }, ...live] };
  assert.ok(createBlowSampler(withZero).outcomeAt(0).p > 0);
  assert.equal(createBlowSampler({ ...fight, outcomes: [live[0]] }).outcomeAt(0.999), live[0]);
  assert.throws(() => createBlowSampler({ ...fight, outcomes: [] }), RangeError);
  assert.throws(() => createBlowSampler(blowOutcomes(ch, args)), TypeError, 'the full tier is not a sampling table');
});

test('6. sampling is deterministic, counts its draws, and reproduces the enumerated joint distribution', () => {
  const { ch, args } = localSide(CONFIGS[1]);
  const fight = blowFightTier(ch, args);
  const sampler = createBlowSampler(fight);
  const run = (seed, n) => {
    const rng = createRng(seed);
    const s = rng.stream('blow');
    const out = [];
    for (let i = 0; i < n; i++) out.push(sampler.sample(s));
    return { out, rng };
  };
  const a = run(11, 500);
  assert.deepEqual(a.out, run(11, 500).out, 'same seed, same outcomes');
  assert.notDeepEqual(a.out.map(jointKey), run(12, 500).out.map(jointKey));
  assert.deepEqual(a.rng.draws(), { blow: 500 }, 'one draw per sampled blow');
  // another stream moving does not change the blow stream
  const rng = createRng(11);
  rng.stream('echo').next();
  const s = rng.stream('blow');
  assert.deepEqual(Array.from({ length: 500 }, () => sampler.sample(s)), a.out);

  // the empirical frequencies of the JOINT outcome, against the enumerated probabilities (seed fixed in advance)
  const N = 400000;
  const big = createRng(0x3110).stream('blow');
  const counts = new Map();
  for (let i = 0; i < N; i++) { const k = jointKey(sampler.sample(big)); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const expected = new Map(fight.outcomes.map((o) => [jointKey(o), o.p]));
  const r = compareCounts(counts, N, expected);
  assert.ok(r.ok, `sampled joint distribution: chi z ${r.chiZ.toFixed(2)}, max cell z ${r.maxZ.toFixed(2)} (${r.cells} cells), unsupported ${r.unsupported.length}`);
  assert.ok(r.cells > 100, `many cells compared (${r.cells})`);
});

test('7. the cost of enumeration is bounded and the same inputs give the same distribution', () => {
  for (const cfg of CONFIGS) {
    const { ch, args, hand } = localSide(cfg);
    const t0 = performance.now();
    const full = blowOutcomes(ch, { ...args, hand });
    const ms = performance.now() - t0;
    assert.ok(full.outcomes.length < 100000, `${cfg.id}: ${full.outcomes.length} full-tier outcomes`);
    assert.ok(ms < 2000, `${cfg.id}: ${ms.toFixed(0)} ms (a generous ceiling, the measurement is in the stage report)`);
    const again = blowFightTier(ch, { ...args, hand });
    assert.deepEqual(again.outcomes.map(jointKey), blowFightTier(ch, { ...args, hand }).outcomes.map(jointKey));
  }
});

test('8. existing evaluators are untouched by the new module', () => {
  const { ch, args } = localSide(CONFIGS[1]);
  const before = analyze(ch, args);
  blowOutcomes(ch, args);
  const after = analyze(ch, args);
  for (const k of ['perSwing', 'cappedPerSwing', 'dps', 'cappedDps', 'ttk']) assert.equal(after[k], before[k], k);
});
