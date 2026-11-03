import test from 'node:test';
import assert from 'node:assert/strict';
import { theoryCharacter } from '../src/theory.js';
import { referenceFoe } from '../src/model.js';
import { analyzeSpell, spellCost, spellDamage, spellRotation, effectSchool } from '../src/spells.js';
import { SKILLS } from '../src/data.js';

function mage() {
  const ch = theoryCharacter({});
  ch.skills[SKILLS.Destruction] = 200;
  ch.masteredSkills = [SKILLS.Destruction, SKILLS.CriticalStrike, SKILLS.Backstabbing];
  ch.maxMagicka = 300;
  ch.magicka = 300;
  return ch;
}

function bolt(over = {}) {
  const e = {
    type: 4, subType: 0, durationBase: 0, durationMod: 0, durationPerLevel: 0,
    chanceBase: 0, chanceMod: 0, chancePerLevel: 0,
    magnitudeBaseLow: 20, magnitudeBaseHigh: 20, magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
  };
  return { name: 'Test Bolt', element: 0, rangeType: 0, cost: 100, effects: [e, ...(over.effects ?? [])], ...over };
}

test('a damage spell prices and lands with the live school and saving throw', () => {
  const ch = mage();
  const sp = bolt();
  const target = referenceFoe(45, 'tough');
  const dmg = spellDamage(sp, ch, target);
  assert.equal(effectSchool(sp.effects[0]), SKILLS.Destruction);
  assert.equal(dmg.school, SKILLS.Destruction);
  assert.ok(dmg.damage > 0);
  assert.ok(dmg.saving > 0 && dmg.saving < 1);
  assert.ok(spellCost(sp, ch) >= 5);
});

test('a continuous damage spell adds its rounds', () => {
  const ch = mage();
  const dot = {
    name: 'Test DoT', element: 0, rangeType: 0, cost: 100,
    effects: [{
      type: 1, subType: 0, durationBase: 10, durationMod: 0, durationPerLevel: 1,
      chanceBase: 0, chanceMod: 0, chancePerLevel: 0,
      magnitudeBaseLow: 5, magnitudeBaseHigh: 5, magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
    }],
  };
  const r = spellDamage(dot, ch, referenceFoe(45, 'tough'));
  assert.ok(r.damage > 5 * 10 * 0.5, `${r.damage}`);
});

test('the spell card exposes cost, cast time, DPS and pool sustain', () => {
  const ch = mage();
  const card = analyzeSpell(bolt(), ch, referenceFoe(45, 'tough'), { health: 12000, potencyPct: 30, pierce: 10, castSpeedPct: 20 });
  assert.ok(card.dps > 0);
  assert.ok(card.castSeconds > 0 && card.castSeconds < 1);
  assert.ok(card.castsPerPool > 0);
  assert.equal(card.poolDamage, card.damage * card.castsPerPool);
  assert.ok(card.ttk > 0);
});


test('a spell rotation carries min/avg/max DPS', () => {
  const ch = mage();
  const r = spellRotation(bolt(), ch, referenceFoe(45, 'tough'), { seconds: 30, health: 12000 });
  assert.ok(r.windowDpsMin <= r.windowDps && r.windowDps <= r.windowDpsMax, `${r.windowDpsMin} ${r.windowDps} ${r.windowDpsMax}`);
  assert.ok(r.manaDpsMin <= r.manaDps && r.manaDps <= r.manaDpsMax);
});
