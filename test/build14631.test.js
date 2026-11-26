/*
 * test/build14631.test.js - the 0.1.14631 drift finding, which is now the DEFAULT build.
 *
 * `gameBuild: '14631'` is the default (`src/model.js` DEFAULT_GAME_BUILD) and every case below also pins that the
 * no-flag output is byte-identical to an explicit '14631' run, while an explicit '14512' still selects the vendored
 * cut at a3eb1605. '14631' is a fact readable only in the shipped
 * build, so these are LOCAL INVARIANTS cited from `dist:` (rule 10, weak evidence), never oracle checks:
 *
 *   GEAR-14631 (dist:weaponMastery-AR4ipaqT.js:9f201d8ae37fa0b8:1384@0.1.14631 `b()` and :835 `g()`, and
 *               dist:spellcast-EF3EGbYP.js:03aaae5902c8daf4:229764@0.1.14631 `Sy()`, called from `Ob` at
 *               :234707): the gear is a FLAT add on the roll, uniform on [floor(s/10), floor(s/5)]; the mastery
 *               percent is the climb only, Axe/Blunt share the sword's single term and nothing is capped at 320.
 *               The guard is the TARGET (!isPlayer && !warded), with the attacker online and not on fists.
 *   BRAND-14631 (dist:lootPowers-Dm823tWJ.js:f7eb7a0c6af4da01:3482@0.1.14631): the brand power adds
 *               floor(flat x elementShare(target, power.element)) to the flat accumulator.
 *
 * Placement (the add is part of the ROLL, before Strength/material/enemy-type/blow modifiers and the crit) is
 * asserted through the card's own fields; the carried-chain ratio `xy` is unmodelled (`ASSUMPTION:` in
 * src/model.js gearBlowAdd) and the Gilded item that carries brand, and the defender sigil set, are unmodelled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  analyze, bossTarget, createCarryState, damageModel, gearBlowAdd, lootPowerTerms, masteryPct, referenceFoe, weaponBlow,
  weaponOf,
} from '../src/model.js';
import { blowFightTier, tierMeans } from '../src/blowOutcomes.js';
import { GEAR_MASTERY_POINTS, gearMasteryPoints, theoryCharacter, theoryCaps } from '../src/theory.js';
import { legalGear } from '../src/maxprofile.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';

/** A level-30 player: no Swing, proficiency or racial damage terms, so the card's rolls are the weapon's own. */
const PLAIN = (gear, { online = true } = {}) => {
  const ch = simCharacter(character({
    level: 30, raceId: 1, stats: { strength: 50 }, skills: 0, skillOverride: { 29: 100, 34: 0 },
    online, masterSkills: true, mastered: [29],
  }), weapon(120, { material: 1 }));
  ch._mods.skills[29] = gear;
  return ch;
};
/** A steel longsword with its roll pinned at 100, so every number below is the formula's own. */
const ROLL_100 = () => ({ ...weaponOf(weapon(120, { material: 1 })), min: 100, max: 100 });
const STRUCK = () => referenceFoe(5, 'tough');
/** A card at an explicit build. The default is the VENDORED CUT here: these fixtures pin a3eb1605's numbers, so they must
 *  name it (the live default no longer is the cut). */
const card = (ch, build = '14512', target = STRUCK()) => analyze(ch, {
  ...(build ? { gameBuild: build } : {}), swing: 'StrikeLeft', target, weapon: ROLL_100(),
});

test('14631 gear: the flat add range and mean at gear 0 / 250 / 700, no mastery percent', () => {
  // Local invariant, cited from the shipped dist: build 0.1.14631 (weak evidence): b() rolls
  // uniform[floor(s/10), floor(s/5)] and Sy adds it to the roll as e+a.
  const expected = {
    0: null,
    250: { lo: 25, hi: 50, mean: 37.5 },
    700: { lo: 70, hi: 140, mean: 105 },
  };
  for (const [gear, add] of Object.entries(expected).map(([g, v]) => [Number(g), v])) {
    const r = card(PLAIN(gear), '14631');
    if (add) assert.deepEqual(r.damage.parts.gearAdd, add, `gear ${gear} add`);
    else assert.equal(r.damage.parts.gearAdd, undefined, `gear ${gear} add`);
    assert.equal(r.damage.parts.mastery, 0, `gear ${gear}: the climb alone is 0, the gear is not a percent`);
    // A 100 roll: the mean add is the average blow; the range is the add's own bounds.
    assert.equal(r.damage.avg, 100 + (add ? add.mean : 0), `gear ${gear} mean damage`);
    assert.equal(r.damage.min, 100 + (add ? add.lo : 0), `gear ${gear} min damage`);
    assert.equal(r.damage.max, 100 + (add ? add.hi : 0), `gear ${gear} max damage`);
  }
});

test('14631 gear: the flat add does NOT scale with the blow (unlike a percent)', () => {
  // Local invariant, cited from the shipped dist: build 0.1.14631 (weak evidence): the add is points on the
  // roll, so the delta a roll of 200 sees is exactly the delta a roll of 100 sees.
  const delta = (ch) => card(ch, '14631').damage.avg - card(PLAIN(0), '14631').damage.avg;
  const heavy = { ...ROLL_100(), min: 200, max: 200 };
  const a = analyze(PLAIN(700), { gameBuild: '14631', swing: 'StrikeLeft', target: STRUCK(), weapon: heavy }).damage.avg;
  const b = analyze(PLAIN(0), { gameBuild: '14631', swing: 'StrikeLeft', target: STRUCK(), weapon: heavy }).damage.avg;
  assert.equal(a - b, delta(PLAIN(700)), 'the same +105 mean at roll 100 and roll 200');
});

test('14631 gear: the guards - player target, warded, offline, fists', () => {
  // Local invariant, cited from the shipped dist: build 0.1.14631 (weak evidence): b()'s guard is the TARGET
  // (`!n || n.isPlayer || n.warded || sigilDueling()`), plus the attacker online and not on fists.
  const geared = PLAIN(700);
  const w = ROLL_100();
  assert.equal(gearBlowAdd(geared, w, STRUCK(), { gameBuild: '14631' }).hi, 140, 'an NPC target passes');
  assert.equal(gearBlowAdd(geared, w, { isPlayer: true }, { gameBuild: '14631' }), null, 'a player target does not');
  assert.equal(gearBlowAdd(geared, w, { ...STRUCK(), warded: true }, { gameBuild: '14631' }), null, 'a warded target does not');
  assert.equal(gearBlowAdd(PLAIN(700, { online: false }), w, STRUCK(), { gameBuild: '14631' }), null, 'offline does not');
  assert.equal(gearBlowAdd(geared, { skillId: 30 }, STRUCK(), { gameBuild: '14631' }), null, 'Hand-to-Hand does not');
  // and through the card: a player target keeps the roll, a warded one is the card's own early return
  assert.equal(card(geared, '14631', { ...STRUCK(), isPlayer: true }).damage.avg, 100);
  assert.equal(card(geared, '14631', { ...STRUCK(), warded: true }).damage.avg, 100);
  assert.equal(card(PLAIN(700, { online: false }), '14631').damage.avg, 100);
  assert.equal(analyze(geared, { gameBuild: '14631', swing: 'StrikeLeft', target: STRUCK(), weapon: null }).damage.parts.gearAdd, undefined, 'bare fists');
});

test('14631 gear: Axe and Blunt share the sword\'s single climb (the half line is gone)', () => {
  // Local invariant, cited from the shipped dist: build 0.1.14631 (weak evidence): _() has one arm for
  // LongBlade/Archery/Axe/BluntWeapon, while '14512' doubles the axe below / the blunt at-or-above the half line.
  for (const [tpl, id] of [[120, 29], [127, 31], [126, 32]]) {
    const ch = simCharacter(character({
      level: 30, raceId: 1, stats: { strength: 50 }, skills: 0, skillOverride: { [id]: 200, 34: 0 },
      online: true, masterSkills: true, mastered: [id],
    }), weapon(tpl, { material: 1 }));
    const w = weaponOf(weapon(tpl, { material: 1 }));
    for (const share of [0.9, 0.49]) {
      assert.equal(masteryPct(ch, w, {}, { gameBuild: '14631', healthShare: share }), 40, `skill ${id} at ${share}`);
    }
    assert.equal(masteryPct(ch, w, {}, { gameBuild: '14512', healthShare: 0.49 }), id === 31 ? 80 : (id === 32 ? 0 : 40));
    assert.equal(masteryPct(ch, w, {}, { gameBuild: '14512', healthShare: 0.9 }), id === 32 ? 80 : (id === 31 ? 0 : 40));
  }
});

test('14631 gear: the theory card at gear 0 / 250 / 700, mean add and exact support', () => {
  // Local invariant, cited from the shipped dist: build 0.1.14631 (weak evidence): the add's mean is 0.15 x s
  // (the uniform's arithmetic mean) and its support is the whole integer range, not one sampled value.
  const g = legalGear(123);
  const at = (gear) => {
    const ch = theoryCharacter({ gearLB: gear, gearCS: g.cs, damagePct: g.dmg });
    return analyze(ch, { gameBuild: '14631', target: referenceFoe(45, 'tough'), core: 'overhaul', rri: true });
  };
  assert.equal(at(0).damage.parts.gearAdd, undefined, 'no gear, no add');
  assert.deepEqual(at(250).damage.parts.gearAdd, { lo: 25, hi: 50, mean: 37.5 });
  assert.deepEqual(at(700).damage.parts.gearAdd, { lo: 70, hi: 140, mean: 105 });
  assert.equal(at(700).damage.parts.mastery, 40, 'the 700 gear points buy no percent; the climb is 40');
});

test('14631 gear: an exhaustive joint card, so a cap inside the spread is clipped per blow', () => {
  // Local invariant: the shipped build's add is a uniform INTEGER on [lo, hi]; the card enumerates every
  // (roll, add) pair, so a per-hit cap clips the blows themselves and `cappedPerSwing` equals the fight tier's.
  // (A mean-add card loses the inside-cap mass: it read 109.22 instead of 102.32 on the hit-cap case below.)
  const g = legalGear(123);
  const ch = theoryCharacter({ gearLB: 535, gearCS: g.cs, damagePct: g.dmg });
  const target = bossTarget({ level: 45, health: 4000, traits: ['curbing'] });
  for (const build of ['14512', '14631']) {
    const args = { gameBuild: build, target, health: 4000, traits: ['curbing'] };
    const card = analyze(ch, args);
    const tier = tierMeans(blowFightTier(ch, args));
    assert.equal(card.cap, 200, `${build}: curbing 4000 -> a 200 cap`);
    assert.ok(card.cappedPerSwing < card.perSwing, `${build}: the cap binds`);
    // exhaustive joint equality: the card and the enumerated tier are the same distribution
    assert.ok(Math.abs(card.perSwing - tier.perSwing) < 1e-9, `${build} perSwing ${card.perSwing} vs ${tier.perSwing}`);
    assert.ok(Math.abs(card.cappedPerSwing - tier.cappedPerSwing) < 1e-9, `${build} capped ${card.cappedPerSwing} vs ${tier.cappedPerSwing}`);
  }
  // the 535-gear Dai-katana's blows (138..275 under 14631) straddle the 200 cap; the exact capped mean is 194
  const r = analyze(ch, { gameBuild: '14631', target, health: 4000, traits: ['curbing'] });
  assert.ok(r.damage.max > r.cap && r.damage.min < r.cap, `cap ${r.cap} inside ${r.damage.min}..${r.damage.max}`);
  assert.ok(Math.abs(r.cappedPerSwing - 194) < 1e-9, `capped ${r.cappedPerSwing}`);
  // the reviewer's own fixture: curbing at 200 HP is a 10 cap, far under every blow, so the claim is 10 all along
  const tiny = analyze(ch, { gameBuild: '14631', target: bossTarget({ level: 45, health: 200, traits: ['curbing'] }), health: 200, traits: ['curbing'] });
  assert.equal(tiny.cap, 10);
  assert.ok(Math.abs(tiny.cappedPerSwing - 10 * tiny.hit.hit) < 1e-9, `capped ${tiny.cappedPerSwing}`);
});

test('14631 gear: a hit cap inside the spread clips per blow, identical on the card and the tier', () => {
  // Local invariant: same joint enumeration, one hard cap instead of the curbing share. The real longsword's roll
  // (2..16) at 700 gear gives 72..156 under 14631, so a 115 cap sits INSIDE the spread and trims only part of it;
  // the 14512 card is 8..65 and the cap never binds. Exact exhaustive capped mean: 102.32361502347419.
  const target = { ...STRUCK(), hitCap: 115 };
  const args = { gameBuild: '14631', target, swing: 'StrikeLeft', weapon: weaponOf(weapon(120, { material: 1 })) };
  const r = analyze(PLAIN(700), args);
  const tier = tierMeans(blowFightTier(PLAIN(700), args));
  assert.equal(r.cap, 115);
  assert.ok(r.damage.min < r.cap && r.cap < r.damage.max, `115 inside ${r.damage.min}..${r.damage.max}`);
  assert.ok(r.cappedPerSwing < r.perSwing, `capped ${r.cappedPerSwing} vs ${r.perSwing}`);
  assert.ok(Math.abs(r.cappedPerSwing - tier.cappedPerSwing) < 1e-9, 'card == tier');
  assert.ok(Math.abs(r.perSwing - tier.perSwing) < 1e-9, 'uncapped card == tier');
  assert.ok(Math.abs(r.cappedPerSwing - 102.32361502347419) < 1e-9, `the enumerated capped mean: ${r.cappedPerSwing}`);
  // The cut enumerates too, and its spread sits under the cap, so nothing clips there.
  const cut = analyze(PLAIN(700), { ...args, gameBuild: '14512' });
  assert.equal(cut.cappedPerSwing, cut.perSwing);
});

test('14631 gear: sharing the work of equal roll values changes no blow', () => {
  // Local invariant (no oracle): damageModel runs the per-blow stages once per distinct roll value and lays them out
  // per blow. A one-roll weapon has no two equal (roll + add) sums, so nothing is shared there: the full card must be
  // those cards laid out add by add.
  const ch = PLAIN(700);
  const opts = { gameBuild: '14631', carryBases: true, firmamentDamagePct: 7 }; // a percentage channel, for the carry
  const w = { ...ROLL_100(), min: 10, max: 18, damagePct: 10 };
  const model = (weapon, extra = {}) => damageModel(ch, weapon, STRUCK(), 'StrikeLeft', 'overhaul', { ...opts, ...extra });
  const full = model(w);
  const singles = Array.from({ length: 9 }, (_, i) => model({ ...w, min: 10 + i, max: 10 + i }));
  const LISTS = ['plainRolls', 'critRolls', 'preFinishRolls', 'blowBaseRolls', 'backstabPlainRolls', 'backstabCritRolls'];
  for (const key of LISTS) {
    const want = Array.from({ length: 71 }, (_, add) => singles.map((s) => s[key][add])).flat();
    assert.deepEqual(full[key], want, key);
  }
  assert.ok(new Set(full.preFinishRolls).size < full.preFinishRolls.length / 4, 'values are shared');
  for (const [key, min, max, avg] of [['plainRolls', 'min', 'max', 'avg'], ['critRolls', 'critMin', 'critMax', 'critAvg']]) {
    assert.equal(full[avg], full[key].reduce((a, b) => a + b, 0) / full[key].length, avg);
    assert.equal(full[min], Math.min(...full[key]), min);
    assert.equal(full[max], Math.max(...full[key]), max);
  }
  // A live carry remainder moves between equal blows, so nothing may be shared there: every blow in turn.
  const live = model(w, { carryState: createCarryState() });
  const carryState = createCarryState();
  const want = live.blowBaseRolls.map((d) => weaponBlow(ch, w, d, STRUCK(), { ...opts, carryState }));
  assert.deepEqual(live.preFinishRolls, want);
  assert.notDeepEqual(want, full.preFinishRolls, 'the carry is live');
});

test('14631 gear: the fight tier\'s support IS the add\'s support (700 gear)', () => {
  // Local invariant: the tier's landed blows span the same lo..hi the card reports for the 100-roll fixture.
  const tier = blowFightTier(PLAIN(700), { gameBuild: '14631', target: STRUCK(), weapon: ROLL_100(), swing: 'StrikeLeft' });
  const blows = tier.outcomes.filter((o) => o.hit).map((o) => o.blow);
  assert.equal(Math.min(...blows), 170, 'roll 100 + lo 70');
  assert.equal(Math.max(...blows), 240, 'roll 100 + hi 140');
  const r = card(PLAIN(700), '14631');
  assert.equal(r.damage.min, Math.min(...blows));
  assert.equal(r.damage.max, Math.max(...blows));
});

test('14631 gear: a bow and the off hand keep the widened band', () => {
  // Local invariant: a bow's pull and the off hand's share act on each blow, so both see the full integer add.
  const bow = analyze(PLAIN(700), { gameBuild: '14631', target: STRUCK(), weapon: weaponOf(weapon(129, { material: 1 })), swing: 'StrikeDown' });
  assert.ok(bow.damage.plainRolls.length > 1, 'the bow card enumerates every integer add');
  assert.ok(new Set(bow.damage.plainRolls).size > 1, 'the pull keeps the widened band');
  assert.ok(bow.damage.critMax >= bow.damage.max);
  const off = analyze(PLAIN(700), { gameBuild: '14631', target: STRUCK(), weapon: ROLL_100(), swing: 'StrikeLeft', offHand: true });
  assert.ok(off.damage.max - off.damage.min > 0, `off hand band ${off.damage.min}..${off.damage.max}`);
  assert.ok(off.damage.max <= 0.8 * 240 + 0.2 * 170, 'the off-hand share is applied per blow, inside the support');
});

test('14512 regression: the cut\'s card numbers still hold (roll 100, NPC target)', () => {
  // Local invariant: the 14512 column of the same 100-roll card - gear 250 -> 210, gear 700 -> 408 at a 100 roll,
  // 100 + floor(100 x min(320, gear x 0.44) / 100). `--game-build 14512` must reproduce them.
  assert.equal(card(PLAIN(0)).damage.avg, 100);
  assert.equal(card(PLAIN(250)).damage.avg, 210);
  assert.equal(card(PLAIN(700)).damage.avg, 408);
  assert.equal(card(PLAIN(728)).damage.avg, 320 + 100, 'capped at +320% (728 points: 320.32 -> 320)');
  assert.equal(card(PLAIN(727)).damage.avg, 419, '319.88 is floored, not rounded');
});

test('the default is the live build; only an explicit 14512 selects the cut', () => {
  // Local invariant: `buildOf`/`gameBuildOf` resolve '14512' and nothing else to the cut, so an ABSENT key is the live
  // build - the flip - while `--game-build 14512` still prices a3eb1605's numbers exactly.
  const ch = theoryCharacter({ gearLB: 250, gearCS: 370, damagePct: 25 });
  const args = { target: referenceFoe(45, 'tough'), core: 'overhaul', rri: true };
  const plain = analyze(ch, args);
  const live = analyze(ch, { ...args, gameBuild: '14631' });
  const cut = analyze(ch, { ...args, gameBuild: '14512' });
  assert.deepEqual(plain, live, 'no --game-build is the live build');
  assert.notDeepEqual(plain, cut, 'and it is not the cut');
  assert.equal(cut.damage.parts.gearAdd, undefined, '14512 has no flat-add field at all');
  assert.equal(cut.damage.parts.mastery, 150, 'the 14512 gear percent is untouched (40 climb + 110 gear)');
  // The live build: the percent is the climb alone and the flat add is on the roll.
  assert.equal(live.damage.parts.mastery, 40);
  assert.deepEqual(live.damage.parts.gearAdd, { lo: 25, hi: 50, mean: 37.5 });
});

test('the brand power prices only on the live build, and an unknown string normalises to it', () => {
  // Local invariant: `buildOf` resolves only an explicit '14512' to the cut, so '14631', an absent key and a typo all
  // price the live law (the CLI refuses a typo before it reaches a formula).
  const retribution = { kind: 'brand', element: 'fire', flat: 8 };
  const normal = { career: {} };
  assert.deepEqual(lootPowerTerms([retribution], normal, { gameBuild: '14631' }), { pct: 0, flat: 8 });
  assert.deepEqual(lootPowerTerms([retribution], { career: { resistanceFlags: 8 } }, { gameBuild: '14631' }), { pct: 0, flat: 4 }, 'resistant: half, floored');
  assert.deepEqual(lootPowerTerms([retribution], { career: { immunityFlags: 8 } }, { gameBuild: '14631' }), { pct: 0, flat: 0 }, 'immune: none');
  // The under-half-health doubling is venom's, not brand's.
  assert.deepEqual(lootPowerTerms([retribution], normal, { gameBuild: '14631', healthShare: 0.1 }), { pct: 0, flat: 8 });
  // An absent key is the live build too.
  assert.deepEqual(lootPowerTerms([retribution], normal, {}), { pct: 0, flat: 8 });
  // '14512' has no brand power: the vendored switch's default arm adds nothing.
  assert.deepEqual(lootPowerTerms([retribution], normal, { gameBuild: '14512' }), { pct: 0, flat: 0 });
});

test('the 14631 cap sheet drops the gear percent, the 14512 sheet is byte-identical', async () => {
  // Local invariant: the cap sheet is prose, but it must not tell a 14631 reader to cap gear at 320%.
  const { THEORY_CAPS } = await import('../src/theory.js');
  assert.deepEqual(theoryCaps('14512'), THEORY_CAPS, 'the 14512 sheet is the frozen table');
  const drifted = theoryCaps('14631');
  const row = (list) => list.find((c) => c.channel === 'Gear Long Blade');
  assert.match(row(drifted).formula, /flat uniform/, '14631 says flat, not a percent');
  assert.doesNotMatch(row(drifted).formula, /0\.44/);
  assert.equal(drifted.length, THEORY_CAPS.length, 'only the gear row changes');
  assert.deepEqual(drifted.filter((c) => c.channel !== 'Gear Long Blade'), THEORY_CAPS.filter((c) => c.channel !== 'Gear Long Blade'));
  // And the formula-cap row itself: 14512 still needs 728 points, 14631 has no such cap at all.
  assert.equal(gearMasteryPoints('14512'), GEAR_MASTERY_POINTS);
  assert.equal(gearMasteryPoints('14631'), null);
});

test('an unknown gameBuild prices as the live build (one normalisation point)', () => {
  // Local invariant: `buildOf` resolves only '14512' to the cut, so a typo cannot silently select a3eb1605's numbers -
  // it prices the live build, exactly as an absent key does.
  const live = card(PLAIN(700), '14631');
  for (const bogus of ['14630', '1463', '', '14731', '14631', '14513']) {
    const r = bogus === '14631' ? card(PLAIN(700), bogus) : analyze(PLAIN(700), { gameBuild: bogus, swing: 'StrikeLeft', target: STRUCK(), weapon: ROLL_100() });
    assert.deepEqual(r, live, `${JSON.stringify(bogus)} prices as the live build`);
  }
  // And only the exact cut string is different.
  assert.notDeepEqual(card(PLAIN(700), '14512'), live, 'the cut string is the only one that opts out');
});

test('the dist: citations in this file are pinned (rule 1, pin first)', () => {
  // Local invariant: every `dist:<chunk>:<sha16>@<version>`-shaped citation below must match a pin record, or the
  // citation is not valid evidence at all (AGENTS.md rule 1). The check is by hand until tooling exists.
  const here = new URL(import.meta.url);
  const pins = new URL('../vendor/dist-pins/0.1.14631.json', import.meta.url);
  assert.ok(fs.existsSync(pins), 'the 0.1.14631 pin record is committed');
  const record = JSON.parse(fs.readFileSync(pins, 'utf8'));
  assert.equal(record.version, '0.1.14631');
  const byChunk = new Map(record.pinnedChunks.map((c) => [c.chunk, c]));
  const source = fs.readFileSync(here, 'utf8');
  const cited = new Set(source.match(/dist:[\w.-]+:[0-9a-f]{16}:[^@\s]+@[\d.]+/g) ?? []);
  assert.ok(cited.size >= 3, `citations found: ${cited.size}`);
  for (const cite of cited) {
    const [, chunk, sha, version] = /^dist:([\w.-]+):([0-9a-f]{16}):[^@\s]+@([\d.]+)$/.exec(cite);
    assert.equal(version, record.version, `${cite}: the pin record's version`);
    const pin = byChunk.get(chunk);
    assert.ok(pin, `${cite}: chunk is not pinned`);
    assert.equal(pin.sha256.slice(0, 16), sha, `${cite}: sha16`);
  }
});
