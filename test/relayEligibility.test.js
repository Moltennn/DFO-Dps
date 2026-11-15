/*
 * test/relayEligibility.test.js - Stage 3.4.2: the pre-pull/pre-trait eligibility field.
 *
 * `formulaPositive` is the strike listener's gate (formula damage > 0, before the pull and the target trait). It must
 * survive the full and fight tiers, and it must be part of the merge key so an eligible miss and an ineligible miss
 * cannot collapse into one outcome. The Potent Vs miss is the real example: hit=false, formulaPositive=true, blow=5.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { blowOutcomes, blowFightTier, mergeToFightTier } from '../src/blowOutcomes.js';
import { gateTarget, weaponOf } from '../src/model.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';

const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});

test('formulaPositive is set independently of echo eligibility', () => {
  const item = weapon(121, { material: 9 }); // no echo power
  const ch = simCharacter(BASIC(), item);
  const full = blowOutcomes(ch, { target: gateTarget(45, { health: 2000 }), health: 2000, weapon: weaponOf(item) });
  const positive = full.outcomes.filter((o) => o.formulaPositive);
  assert.ok(positive.length > 0);
  assert.ok(positive.every((o) => o.echoEligible === false), 'no echo power: eligibility is not echo eligibility');
  const tier = mergeToFightTier(full);
  assert.ok(tier.outcomes.every((o) => o.formulaPositive === true || o.blow === 0));
});

test('a Potent Vs miss is positive pre-trait and not a hit', () => {
  const item = { ...weapon(121, { material: 9 }), enchantments: [{ type: 4, param: 1 }] };
  const ch = simCharacter(BASIC(), item);
  const full = blowOutcomes(ch, { target: gateTarget(45, { health: 2000 }), health: 2000, weapon: weaponOf(item) });
  const miss5 = full.outcomes.filter((o) => o.hit === false && o.blow === 5);
  assert.ok(miss5.length > 0, 'the Potent Vs miss branch exists');
  assert.ok(miss5.every((o) => o.formulaPositive === true), 'the listener gate is the pre-trait formula damage');
});

test('the fight merge key cannot collapse outcomes with different formulaPositive', () => {
  const base = {
    p: 0.5, direction: 'StrikeLeft', directionIndex: 3, facing: false, backstab: false, crit: false, hit: false,
    whole: true, echoMask: 0, echoHits: 0, blow: 0, echoDamage: 0, damage: 0, claim: 0, cappedDamage: 0,
  };
  const full = {
    kind: 'full',
    outcomes: [
      { ...base, formulaPositive: true },
      { ...base, formulaPositive: false },
    ],
  };
  const tier = mergeToFightTier(full);
  assert.equal(tier.outcomes.length, 2, 'different eligibility is a different key');
  assert.equal(tier.outcomes.filter((o) => o.formulaPositive).length, 1);
  assert.equal(tier.total, 1);
});
