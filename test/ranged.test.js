import test from 'node:test';
import assert from 'node:assert/strict';
import { theoryCharacter } from '../src/theory.js';
import { analyze, referenceFoe, syntheticWeapon } from '../src/model.js';
import { SKILLS } from '../src/data.js';

function shooter(templateIndex) {
  const ch = theoryCharacter({ blade: templateIndex });
  ch.weapon = {
    name: 'Test', group: 'Weapons', templateIndex, material: 9,
    maxCondition: 100, currentCondition: 100, equipSlot: 19,
    affixes: [{ id: 'damage', value: 40 }],
  };
  ch.skills[SKILLS.Archery] = 200;
  ch.masteredSkills = [SKILLS.Archery, SKILLS.CriticalStrike, SKILLS.Backstabbing];
  ch._mods.skills = { [SKILLS.Archery]: 240, [SKILLS.CriticalStrike]: 540 };
  ch.career = { ...ch.career, weaponArmorShieldsBitfield: 32 << 16 };
  return ch;
}

test('a bow paces at its BOW_FAST window and spamming is slower', () => {
  const ch = shooter(130);
  const target = referenceFoe(45, 'tough');
  const paced = analyze(ch, { target, core: 'overhaul', rri: true });
  const spam = analyze(ch, { target, core: 'overhaul', rri: true, bowSpam: true });
  assert.equal(paced.cadence.bow, true);
  assert.equal(paced.cadence.seconds, 1.25);
  assert.ok(spam.cadence.seconds < paced.cadence.seconds);
  assert.ok(paced.dps > spam.dps, `${paced.dps} vs ${spam.dps}`);
});

test('the Long Bow is slower but hits harder than the Short Bow', () => {
  const target = referenceFoe(45, 'tough');
  const short = analyze(shooter(129), { target, core: 'overhaul', rri: true });
  const long = analyze(shooter(130), { target, core: 'overhaul', rri: true });
  assert.ok(long.damage.avg > short.damage.avg);
  assert.ok(long.cadence.seconds > short.cadence.seconds);
});

test('a Pistolet pair is two machines and the off hand is weaker', () => {
  const target = referenceFoe(45, 'tough');
  const ch = shooter(562);
  const single = analyze(ch, { target, core: 'overhaul', rri: true });
  const pair = analyze(ch, { target, core: 'overhaul', rri: true, pair: true });
  assert.equal(single.cadence.gun, true);
  assert.ok(pair.cadence.pair);
  assert.ok(pair.dps > single.dps);
  assert.ok(pair.dps < single.dps * 2, 'off hand is x0.8');
});

test('the Thunderlock uses Archery and the two-handed Strength term', () => {
  const target = referenceFoe(45, 'tough');
  const r = analyze(shooter(560), { target, core: 'overhaul', rri: true });
  assert.equal(r.weapon.skillId, SKILLS.Archery);
  assert.equal(r.damage.parts.strMod, 10); // 100 Strength, two-handed
  assert.equal(r.cadence.gun, true);
});
