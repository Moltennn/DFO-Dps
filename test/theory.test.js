import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSkill } from '../src/save.js';
import { analyze, gateTarget } from '../src/model.js';
import {
  GEAR_CS_LINES, GEAR_LB_LINES, GEAR_SKILL_LINES, LONG_BLADES, theoryBlade, theoryCharacter,
} from '../src/theory.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('the theory character is level 45, at the live stat and skill ceilings', () => {
  const ch = theoryCharacter();
  assert.equal(ch.level, 45);
  assert.equal(ch.weapon.templateIndex, 123);
  assert.equal(ch.weapon.name, 'Dai-katana');
  assert.equal(ch.stats.strength, 100);
  assert.equal(ch.stats.speed, 100);
  assert.equal(ch.skills[29], 200);
  assert.equal(ch.skills[34], 200);
  assert.equal(ch.skills[19], 200);
  assert.equal(effectiveSkill(200), 140);
  assert.ok(ch.masteredSkills.includes(29));
  assert.ok(ch.masteredSkills.includes(34));
  assert.ok(ch.masteredSkills.includes(19));
});

test('at raw 200 and no gear: /10 Strength doubled for two hands, 70% crit x2.4', () => {
  const ch = theoryCharacter();
  const r = analyze(ch, { target: gateTarget(45), core: 'overhaul', rri: true });
  assert.equal(r.damage.parts.strMod, 10);
  assert.equal(r.damage.parts.matMod, 6);
  assert.equal(r.damage.parts.prof, 9);
  assert.equal(r.damage.parts.racial, 8);
  assert.equal(r.damage.parts.mastery, 40);
  assert.ok(near(r.hit.crit.chance, 0.7));
  assert.ok(near(r.hit.crit.damageMult, 2.4, 1e-5));
  assert.equal(r.cap, 600);
});

test('the practical gear ceiling is 8 Long Blade lines and 18 Critical Strike lines', () => {
  assert.equal(GEAR_LB_LINES, 8);
  assert.equal(GEAR_CS_LINES, 18);
  assert.equal(GEAR_SKILL_LINES, 26);
  const ch = theoryCharacter({ gearLB: GEAR_LB_LINES * 30, gearCS: GEAR_CS_LINES * 30 });
  const r = analyze(ch, { target: gateTarget(45), core: 'overhaul', rri: true });
  // 40% raw climb + 240 gear points x 0.44 = 145.6% mastery.
  assert.ok(near(r.damage.parts.mastery, 145.6, 1e-6));
  assert.equal(r.hit.crit.chance, 1);
  assert.ok(r.hit.crit.damageMult > 7.7 && r.hit.crit.damageMult < 7.9);
  assert.ok(r.dps > r.cappedDps);
  assert.ok(r.cappedDps > 800 && r.cappedDps < 830);
});

test('a different long blade keeps the damage affix and changes the template', () => {
  const ch = theoryCharacter({ damagePct: 40 });
  for (const idx of LONG_BLADES) {
    const c = theoryBlade(ch, idx, 9);
    assert.equal(c.weapon.templateIndex, idx);
    assert.equal(c.weapon.affixes.find((a) => a.id === 'damage').value, 40);
  }
});
