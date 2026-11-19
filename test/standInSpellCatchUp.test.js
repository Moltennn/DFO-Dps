import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCwsCast } from '../src/cws.js';
import { gateTarget, weaponOf } from '../src/model.js';
import { simulateRelayFight } from '../src/relayFight.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { COURT_ROUND_MS } from '../vendor/upstream/a3eb1605/src/scenes/gate/gateCourt.js';
import { createStandInSpell } from '../vendor/upstream/a3eb1605/src/scenes/gate/standInSpell.js';

const item = weapon(121, { material: 9 });
const ch = simCharacter(character({
  level: 45, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
}), item);
const health = 100000;
const target = () => ({ ...gateTarget(45, { health, traits: [] }), activeEffects: [] });
const rolls = () => 0.99;
const spell = {
  name: 'Catch-up', index: 1, element: 4, rangeType: 1,
  effects: [{
    type: 1, subType: 0,
    magnitudeBaseLow: 200, magnitudeBaseHigh: 200, magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
    durationBase: 5, durationMod: 0, durationPerLevel: 1, chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
  }],
};
const seconds = (round) => round * COURT_ROUND_MS / 1000;

function oracle() {
  let clock = 0;
  let draws = 0;
  const claims = [];
  const body = { entity: target(), warded: false };
  const door = createStandInSpell({
    player: Object.assign(Object.create(ch), { health: 100 }),
    say() {}, now: () => clock, rolls: () => { draws += 1; return rolls(); },
    boss: () => body,
    landOnBoss: (_, damage, _kind, round) => {
      if (round) claims.push([clock / 1000, damage]);
      return true;
    },
  });
  return {
    claims, draws: () => draws,
    cast(round) {
      clock = round * COURT_ROUND_MS;
      assert.equal(door.spellOnBoss(spell), true);
    },
    frame(round) {
      clock = round * COURT_ROUND_MS;
      door.standInRound();
    },
  };
}

test('ORACLE: a three-round frame gap lands one claim; known local divergence: three separate claims', () => {
  const regular = oracle();
  regular.cast(0);
  for (const round of [1, 2, 3]) regular.frame(round);
  assert.deepEqual(regular.claims.map(([t]) => t), [1, 2, 3].map(seconds));
  const total = regular.claims.reduce((sum, [, damage]) => sum + damage, 0);

  const stalled = oracle();
  stalled.cast(0);
  stalled.frame(3);
  assert.deepEqual(stalled.claims, [[seconds(3), total]]);
  assert.equal(stalled.draws(), regular.draws());

  const localTarget = target();
  resolveCwsCast({ spell, caster: { entity: ch }, casterLevel: ch.level, target: localTarget, rolls, hurt() {} });
  const local = simulateRelayFight(ch, {
    target: localTarget, health, weapon: weaponOf(item), seed: 7, trace: true,
    maxBlows: 1, maxSeconds: seconds(3), cwsRolls: rolls,
  }).claimLog.filter((c) => c.kind === 'dot').map((c) => [c.t, c.claim]);
  assert.deepEqual(local, regular.claims.map(([t, damage]) => [t, Math.round(damage)]),
    'the local relay bills each due round separately, unlike the stalled frame');
});

test('ORACLE: a backwards frame resets the clock without ticking a live DoT', () => {
  const rewound = oracle();
  rewound.cast(5);
  const castDraws = rewound.draws();
  rewound.frame(2);
  rewound.frame(2);
  assert.deepEqual(rewound.claims, []);
  assert.equal(rewound.draws(), castDraws);

  const regular = oracle();
  regular.cast(2);
  regular.frame(3);
  assert.equal(regular.claims.length, 1);
  rewound.frame(3);
  assert.deepEqual(rewound.claims, regular.claims, 'the next tick is relative to the reset clock');
  assert.equal(rewound.draws(), regular.draws());
});

test('ORACLE: idle frames do not tick and a new DoT does not inherit the idle gap', () => {
  const idle = oracle();
  idle.frame(0);
  idle.frame(5);
  assert.deepEqual(idle.claims, []);
  assert.equal(idle.draws(), 0);

  idle.cast(10);
  const castDraws = idle.draws();
  idle.frame(10);
  assert.deepEqual(idle.claims, []);
  assert.equal(idle.draws(), castDraws);

  const regular = oracle();
  regular.cast(10);
  regular.frame(11);
  assert.equal(regular.claims.length, 1);
  idle.frame(11);
  assert.deepEqual(idle.claims, regular.claims);
  assert.equal(idle.draws(), regular.draws());
});
