import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSkill, liveStat, skillValue } from '../src/save.js';
import { analyze, gateTarget } from '../src/model.js';
import {
  GEAR_CS_LINES, GEAR_H2H_LINES, GEAR_LB_LINES, GEAR_SKILL_LINES, LONG_BLADES, theoryBlade, theoryCharacter, theoryFists,
} from '../src/theory.js';
import { legalGear } from '../src/maxprofile.js';
import { legalTotals, maxSingleSkill } from '../src/gearProfile.js';
import { SKILLS } from '../src/data.js';

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

test('the rolled-line slot counts are not a point budget; the legal single-skill max is 535', () => {
  // 8 slots can ROLL Long Blade and 18 can roll Critical Strike. That is a count of slots, not 30
  // points each: the old 8 x 30 = 240 and 18 x 30 = 540 profile is unreachable.
  assert.equal(GEAR_LB_LINES, 8);
  assert.equal(GEAR_CS_LINES, 18);
  assert.equal(GEAR_SKILL_LINES, 26);
  assert.equal(maxSingleSkill({ weaponTemplate: 123 }), 535);
  assert.equal(maxSingleSkill({ weaponTemplate: 123, skill: SKILLS.CriticalStrike }), 535);
  const frontier = legalTotals({ weaponTemplate: 123 });
  assert.ok(!frontier.some((p) => p.lb >= 240 && p.cs >= 540), 'the old profile is not on the frontier');
  assert.ok(!frontier.some((p) => p.cs > 535), 'Critical Strike cannot pass 535');

  const g = legalGear(123);
  assert.deepEqual([g.lb, g.cs, g.dmg], [250, 370, 25]);
  assert.deepEqual(g.violations, []);
  const ch = theoryCharacter({ gearLB: g.lb, gearCS: g.cs, damagePct: g.dmg });
  const r = analyze(ch, { target: gateTarget(45), core: 'overhaul', rri: true });
  // 40% raw climb + 250 gear points x 0.44 = 150% mastery.
  assert.ok(near(r.damage.parts.mastery, 150));
  assert.equal(r.hit.crit.chance, 1);
  assert.ok(r.dps > r.cappedDps);
  // The Breach body is a Daedra Lord (career 31, x0.95 hide), now applied before the cap.
  assert.ok(r.cappedDps > 775 && r.cappedDps < 805);
});

test('a different long blade keeps the damage affix and changes the template', () => {
  const ch = theoryCharacter({ damagePct: 38 }); // the best Legendary record's fixed line (warp-edge)
  for (const idx of LONG_BLADES) {
    const c = theoryBlade(ch, idx, 9);
    assert.equal(c.weapon.templateIndex, idx);
    assert.equal(c.weapon.affixes.find((a) => a.id === 'damage').value, 38);
  }
});


test('the Firmament lifts the live attribute ceiling and adds to the formula skill', () => {
  const ch = theoryCharacter({ starStats: { strength: 15, speed: 15 }, starSkills: { 29: 15, 34: 15 } });
  assert.equal(liveStat(ch, 'strength'), 115);
  assert.equal(liveStat(ch, 'speed'), 115);
  assert.equal(skillValue(ch, 29), 155); // effectiveSkill(200)=140 + 15
  assert.equal(skillValue(ch, 34), 155);
  assert.equal(ch.skills[29] + ch._mods.skills[29], 215); // the sheet's raw + mods
  const r = analyze(ch, { target: gateTarget(45), core: 'overhaul', rri: true });
  assert.equal(r.damage.parts.strMod, 12); // 115 Strength, two-handed
});

test('a gear stat affix fills headroom but does not lift the 100 ceiling', () => {
  const ch = theoryCharacter();
  ch._mods.stats.strength = 15;
  assert.equal(liveStat(ch, 'strength'), 100);
  ch._mods.statMax.strength = 15;
  assert.equal(liveStat(ch, 'strength'), 115);
});


test('the Firmament blow channel raises uncapped DPS and is priced apart from gear skill', () => {
  const base = analyze(theoryCharacter(), { target: gateTarget(45), core: 'overhaul', rri: true });
  const star = analyze(theoryCharacter({ starDamage: 30 }), { target: gateTarget(45), core: 'overhaul', rri: true });
  assert.ok(star.dps > base.dps);
  assert.ok(Math.abs(star.dps / base.dps - 1.3) < 0.02, `${base.dps} -> ${star.dps}`);
});


test('the Hand-to-Hand reference lands in the reported ~450 band', () => {
  assert.equal(GEAR_H2H_LINES, 17);
  const c = theoryFists({
    gearH2H: 240,
    starStats: { strength: 15, agility: 15, speed: 15, luck: 15 },
    starSkills: { 30: 15, 34: 15, 19: 15 },
    starDamage: 30,
  });
  assert.equal(c.weapon, null);
  c.martialPath = 'berserker';
  // The community band is the fists against a NEUTRAL body (no boss traits), which is what the
  // reference captures were taken on.
  // Frenzy reads the BERSERKER's own health (martialPowers.js:217): the capture is a player below half health.
  const r = analyze(c, { target: gateTarget(45), core: 'overhaul', rri: true, health: 12000, attackerHealthShare: 0.49, traits: [] });
  assert.ok(r.dps > 420 && r.dps < 480, `H2H at 320 gear + Firmament, neutral body: ${r.dps}`);
  // Against the real Warden, stoneskin halves a fist blow (systems/bossTraits.js bluntBlow).
  const live = analyze(c, { target: gateTarget(45), core: 'overhaul', rri: true, health: 12000, attackerHealthShare: 0.49 });
  assert.deepEqual(live.traits, ['spellproof', 'stoneskin']);
  assert.ok(live.dps > r.dps * 0.45 && live.dps < r.dps * 0.55, `fists at the Breach: ${live.dps} vs neutral ${r.dps}`);
});
