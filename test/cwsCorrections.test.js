/*
 * test/cwsCorrections.test.js - the Stage 3.5.1 audit corrections (F1-F5), local side.
 *
 * These tests pin the corrected pieces without the oracle:
 *   - F1: the CWS guard's PRE-payload damage (`strikesPositive`) is distinct from `formulaPositive`;
 *   - the payload abort at an unregistered enchantment type, including Potent Vs after it;
 *   - online school potency, spell power and pierce;
 *   - a multi-effect cast stops counting after death;
 *   - an echo kill suppresses the melee blow's damage;
 *   - the closure audit (the stage record): equipped-piece identity by hand/slot and countedPieces,
 *     the `_online` master-skills branch, ExtraSpellPts read only where Surge reads the fold, and the target contract.
 * The upstream differential for the same cases is test/cwsDifferential.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { bossTarget, gateTarget, referenceFoe, weaponOf, strikesNet } from '../src/model.js';
import { encounterTarget } from '../src/encounters.js';
import { blowFightTier } from '../src/blowOutcomes.js';
import { cwsEligible, cwsRows, equippedForFight, liveMaxMagicka, resolveCwsCast, spellPowerInputs, schoolPotencyFor } from '../src/cws.js';
import { payloadRows } from '../src/enchants.js';
import { characterFromSave } from '../src/save.js';
import { enemyTarget, makeTarget, standInTarget } from '../src/target.js';
import { simulateFight } from '../src/simulateFight.js';

const WEAK = () => character({
  level: 30, raceId: 1, stats: { strength: 0, agility: 50, speed: 50, luck: 50 }, skills: 0,
});
const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const effect = (type, subType, magnitude = 10) => ({
  type, subType,
  magnitudeBaseLow: magnitude, magnitudeBaseHigh: magnitude,
  magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
  durationBase: 0, durationMod: 0, durationPerLevel: 1,
  chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
});
const spellOf = (effects, { index = 1, name = 'Test Bolt', element = 4, rangeType = 1 } = {}) => ({
  name, index, element, rangeType, effects,
});
const itemWith = (ench, templateIndex = 113) => {
  const it = weapon(templateIndex, { material: 9 });
  it.enchantments = ench;
  return it;
};
const daedraTarget = (health = 100000) => ({
  ...referenceFoe(30, 'tough'), mobileType: 25, health, maxHealth: health,
});
/** A raw save for characterFromSave: the same description simCharacter builds, plus the caller's fields. */
const saveFor = (desc, extra = {}) => ({
  name: 'fixture', level: desc.level, raceId: desc.raceId, race: 'fixture', stats: desc.stats, skills: desc.skills,
  health: 100, maxHealth: 100, reflexes: 2, career: desc.career, items: [], activeEffects: [],
  masterSkills: desc.masterSkills, masteredSkills: desc.mastered, martialPath: desc.martialPath,
  _mods: { stats: {}, skills: {}, statMax: {} }, _enchantMods: { skillMods: {}, chanceToHitMod: 0 }, ...extra,
});
const potencyItem = (value, extra = {}) => {
  const it = weapon(121, { material: 9 });
  it.affixes = [{ id: 'potency', value }];
  it.enchantments = [{ type: 2, param: 1 }];
  return Object.assign(it, extra);
};

test('F1: the guard reads pre-payload damage, not the post-Potent-Vs formulaPositive', () => {
  const standard = new Map([[1, spellOf([effect(4, 0)])]]);
  const pvItem = itemWith([{ type: 4, param: 1 }, { type: 2, param: 1 }]); // Potent Vs + CWS
  const pvCh = simCharacter(WEAK(), pvItem);
  const pvTier = blowFightTier(pvCh, { target: daedraTarget(), weapon: weaponOf(pvItem) });
  const pvMiss = pvTier.outcomes.find((o) => !o.hit && !o.strikesPositive && o.formulaPositive);
  assert.ok(pvMiss, 'a Potent Vs miss is in the tier');
  assert.equal(pvMiss.blow, 5, 'the post-payload blow is +5');
  assert.equal(cwsEligible({ target: daedraTarget(), strikesPositive: pvMiss.strikesPositive, whole: pvMiss.whole, item: pvItem, standard }), false);

  const pvRun = simulateFight(pvCh, {
    target: daedraTarget(), health: 100000, weapon: weaponOf(pvItem), seed: 0, trace: true, maxBlows: 1,
    standard, cwsRolls: () => 0.5,
  });
  assert.equal(pvRun.trace[0].hit, false);
  assert.equal(pvRun.trace[0].formulaPositive, true, 'Flow/echo still see the post-payload value');
  assert.equal(pvRun.trace[0].strikesPositive, false, 'the CWS guard sees 0');
  assert.equal(pvRun.cwsCasts, 0, 'no CWS on a Potent Vs miss');

  const lvItem = itemWith([{ type: 20, param: 1 }, { type: 2, param: 1 }]); // Low Damage Vs + CWS
  const lvCh = simCharacter(WEAK(), lvItem);
  const lvTier = blowFightTier(lvCh, { target: daedraTarget(), weapon: weaponOf(lvItem) });
  const lvZero = lvTier.outcomes.find((o) => o.hit && o.whole && o.strikesPositive && !o.formulaPositive && o.blow === 0);
  assert.ok(lvZero, 'a hit whose positive pre-payload damage Low Damage Vs takes to zero is in the tier');
  assert.equal(cwsEligible({ target: daedraTarget(), strikesPositive: lvZero.strikesPositive, whole: lvZero.whole, item: lvItem, standard }), true);

  const lvRun = simulateFight(lvCh, {
    target: daedraTarget(), health: 100000, weapon: weaponOf(lvItem), seed: 104, trace: true, maxBlows: 1,
    standard, cwsRolls: () => 0.5,
  });
  assert.equal(lvRun.trace[0].hit, true);
  assert.equal(lvRun.trace[0].blowDamage, 0, 'the melee blow is zero after Low Damage Vs');
  assert.equal(lvRun.trace[0].strikesPositive, true, 'the guard saw the positive pre-payload damage');
  assert.equal(lvRun.trace[0].formulaPositive, false);
  assert.ok(lvRun.cwsCasts > 0, 'the CWS casts on a positive-to-zero blow');
});

test('payload traversal stops at an unregistered type, including Potent Vs rows after it', () => {
  const standard = new Map([[1, spellOf([effect(4, 0)])]]);
  const before = itemWith([{ type: 18, param: 0 }, { type: 2, param: 1 }]);
  const after = itemWith([{ type: 2, param: 1 }, { type: 18, param: 0 }]);
  assert.deepEqual(cwsRows(before, standard), [], 'a CWS row after VisionProblems never runs');
  assert.equal(cwsRows(after, standard).length, 1, 'a CWS row before it does');
  assert.equal(payloadRows(before).length, 0);
  assert.equal(payloadRows(after).length, 1, 'the CWS row before it is reached; the unregistered type is not');

  assert.equal(strikesNet(itemWith([{ type: 18, param: 0 }, { type: 4, param: 1 }]), { mobileType: 25 }), 0);
  assert.equal(strikesNet(itemWith([{ type: 4, param: 1 }, { type: 18, param: 0 }]), { mobileType: 25 }), 5);

  const chBefore = simCharacter(WEAK(), before);
  const noCast = simulateFight(chBefore, {
    target: daedraTarget(), health: 100000, weapon: weaponOf(before), seed: 0, trace: true, maxBlows: 1,
    standard, cwsRolls: () => 0.5,
  });
  assert.equal(noCast.cwsCasts, 0);

  const chAfter = simCharacter(WEAK(), after);
  let cast = null;
  for (let seed = 0; seed < 200 && !cast; seed++) {
    const r = simulateFight(chAfter, {
      target: daedraTarget(), health: 100000, weapon: weaponOf(after), seed, trace: true, maxBlows: 1,
      standard, cwsRolls: () => 0.5,
    });
    if (r.cwsCasts > 0) cast = r;
  }
  assert.ok(cast, 'a positive blow with the CWS row before the unregistered type casts');
});

test('online school potency, spell power and pierce are applied in the resolver', () => {
  const spell = spellOf([effect(4, 0, 10)]);
  const target = referenceFoe(30, 'tough');
  const base = resolveCwsCast({ spell, caster: { entity: {} }, casterLevel: 30, target, rolls: () => 0.5 });
  assert.equal(base.damage, 8);

  const powered = resolveCwsCast({
    spell, caster: { entity: {} }, casterLevel: 30, target, rolls: () => 0.5, potencyPct: 20, pierce: 15,
  });
  assert.equal(powered.damage, 12, '20% power and 15 pierce take the 50/50 save to full');

  const mastered = character({
    level: 30, raceId: 1, stats: { strength: 0, agility: 50, speed: 50, luck: 50 },
    skills: { 22: 150 }, masterSkills: true, mastered: [22], online: true,
  });
  const masteredCh = simCharacter(mastered, itemWith([]));
  const masteredPower = schoolPotencyFor(masteredCh, 22);
  assert.ok(masteredPower > 1, 'a mastered skill past 100 lifts the school potency');
  const school = resolveCwsCast({
    spell, caster: { entity: masteredCh }, casterLevel: 30, target, rolls: () => 0.5,
  });
  assert.equal(school.damage, Math.max(1, Math.round(8 * masteredPower)));

  // The save's offline switch is NOT the online branch: the game sets the player entity's `_online = isOnlinePage()`
  // (world.js:25813 at a3eb1605), and masterSkills.js:111 reads `_online` first. An online character with
  // `masterSkills: false` still has master skills in force, so a mastered school reads past 100.
  const defaultOnline = character({
    level: 30, raceId: 1, stats: { strength: 0, agility: 50, speed: 50, luck: 50 },
    skills: { 22: 150 }, mastered: [22], online: true,
  });
  assert.equal(defaultOnline.masterSkills, false);
  assert.equal(schoolPotencyFor(simCharacter(defaultOnline, itemWith([])), 22), 1.17,
    'online master skills are in force by the page lane, not by the offline switch');

  const unmastered = character({
    level: 30, raceId: 1, stats: { strength: 0, agility: 50, speed: 50, luck: 50 },
    skills: { 22: 150 }, online: true,
  });
  assert.equal(schoolPotencyFor(simCharacter(unmastered, itemWith([])), 22), 1, 'the master cap applies');

  const offline = character({
    level: 30, raceId: 1, stats: { strength: 0, agility: 50, speed: 50, luck: 50 },
    skills: { 22: 150 }, masterSkills: true, mastered: [22], online: false,
  });
  assert.equal(schoolPotencyFor(simCharacter(offline, itemWith([])), 22), 1, 'school potency is online only');
  const ambiguous = { ...simCharacter(offline, itemWith([])), online: undefined };
  assert.equal(schoolPotencyFor(ambiguous, 22), 1, 'a missing online flag is offline, not an implicit online');
});

test('gear potency, Arcane Surge and Magnus\'s Gaze feed the resolver inputs', () => {
  const potency = itemWith([], 121);
  potency.affixes = [{ id: 'potency', value: 10 }];
  const surge = { ...weapon(121, { material: 9 }), equipSlot: 20, rarity: 'legendary', legendary: 'shalidors-brand' };
  const pierce = { ...weapon(121, { material: 9 }), rarity: 'legendary', legendary: 'eye-of-magnus' };

  const withSurge = spellPowerInputs({ worn: [potency, surge], magicka: 90, maxMagicka: 100 });
  assert.equal(withSurge.potencyPct, 35, '10 potency + 25 surge');
  const withPierce = spellPowerInputs({ worn: [pierce], magicka: 0, maxMagicka: 0 });
  assert.equal(withPierce.pierce, 15);
  const capped = spellPowerInputs({ worn: [potency] }, { potencyPct: 45, pierce: 20 });
  assert.equal(capped.potencyPct, 50, 'the spell-power cap');
  assert.equal(capped.pierce, 20);
});

test('F4: a multi-effect cast stops counting after the target dies', () => {
  const spell = spellOf([effect(4, 0, 10), effect(4, 0, 20)]);
  let health = 5;
  let hurt = 0;
  const cast = resolveCwsCast({
    spell, caster: { entity: {} }, casterLevel: 30, target: referenceFoe(30, 'tough'), rolls: () => 0.5,
    hurt: (n) => { hurt += n; health = Math.max(0, health - n); return health > 0; },
  });
  assert.equal(health, 0);
  assert.equal(hurt, 8);
  assert.equal(cast.damage, 8, 'only the first effect is counted');
  assert.equal(cast.effects[0].applied, true);
  assert.equal(cast.effects[1].applied, false, 'the later effect is still rolled, not counted');
  assert.equal(cast.effects[1].damage, 16);
});

test('F5: an echo kill suppresses the melee blow and its accounting', () => {
  // LOCAL: seed 19 selects the killing echo in the floor tier; this checks the event order, not the sampler.
  const item = { ...weapon(121, { material: 9 }), rarity: 'rare', imprint: 'warp-edge' };
  const ch = simCharacter(BASIC(), item);
  const r = simulateFight(ch, {
    target: referenceFoe(30, 'tough'), health: 20, weapon: weaponOf(item), seed: 19, trace: true, maxBlows: 1, carry: false,
  });
  assert.equal(r.trace[0].echoKill, true);
  assert.equal(r.trace[0].blowDamage, 23);
  assert.equal(r.trace[0].echoDamage, 23);
  assert.equal(r.trace[0].meleeApplied, false, 'the melee blow is dropped after the echo kills');
  assert.equal(r.damageDealt, 23, 'only the echo is counted');
  assert.equal(r.overkill, 3);
  assert.equal(r.kill, true);
  assert.equal(r.ttk, r.trace[0].t);
});


test('D1: the equipped list is read once, by slot/content, not by object identity', () => {
  const potency = itemWith([{ type: 2, param: 1 }]);
  potency.affixes = [{ id: 'potency', value: 10 }];
  const ch = simCharacter(BASIC(), potency);
  assert.equal(ch.worn.length, 1);
  assert.notEqual(ch.worn[0], potency, 'characterFromSave clones the item');
  const effective = equippedForFight(ch, [weaponOf(potency).item]);
  assert.equal(effective.length, 1, 'the scenario weapon replaces the worn clone in its slot');
  assert.equal(spellPowerInputs(ch, { worn: effective }).potencyPct, 10);
  assert.equal(spellPowerInputs(ch, { worn: [ch.worn[0], potency] }).potencyPct, 10, 'clones in one slot count once');

  const standard = new Map([[1, spellOf([effect(4, 0, 10)])]]);
  const run = simulateFight(ch, {
    target: daedraTarget(), health: 100000, weapon: weaponOf(potency), seed: 0, trace: true, maxBlows: 1,
    standard, cwsRolls: () => 0.5,
  });
  assert.equal(run.cwsTrace[0].damage, 9, '8 x 1.1 (round 8.8), not 8 x 1.2');
});

test('C1: a live snapshot clone and the caller\'s scenario weapon are ONE equipped piece', () => {
  // save.equipSlots holds the live table; characterFromSave stamps `equipSlot` on its clones (src/save.js:248-253)
  // while the caller's original has none. A key that reads the slot when present and content otherwise sees two pieces.
  const pot = potencyItem(10);
  delete pot.equipSlot;
  const ch = characterFromSave(saveFor(BASIC(), { equipSlots: { 19: pot } }), { online: false });
  assert.equal(ch.worn.length, 1);
  assert.equal(ch.worn[0].equipSlot, 19, 'the worn clone carries its slot');
  assert.equal(pot.equipSlot, undefined, 'the caller\'s original does not');
  const effective = equippedForFight(ch, [pot]);
  assert.equal(effective.length, 1, 'one main-hand weapon, not the clone beside it');
  assert.equal(spellPowerInputs(ch, { worn: effective }).potencyPct, 10);

  const standard = new Map([[1, spellOf([effect(4, 0, 10)])]]);
  const run = simulateFight(ch, {
    target: daedraTarget(), health: 100000, weapon: weaponOf(pot), seed: 0, trace: true, maxBlows: 1,
    standard, cwsRolls: () => 0.5,
  });
  assert.equal(run.cwsTrace[0].damage, 9, 'a double count would read 20% and deal 10');
});

test('C2: a what-if main-hand weapon REPLACES the worn main hand', () => {
  const worn = potencyItem(10);
  const ch = simCharacter(BASIC(), worn);
  const whatIf = potencyItem(12, { templateIndex: 122 });
  delete whatIf.equipSlot; // a hypothetical piece the caller holds, not a save slot
  const effective = equippedForFight(ch, [whatIf]);
  assert.equal(effective.length, 1, 'the worn main hand is replaced, not joined');
  assert.equal(effective[0].templateIndex, 122, 'the what-if weapon is the main-hand piece');
  assert.equal(spellPowerInputs(ch, { worn: effective }).potencyPct, 12);

  const standard = new Map([[1, spellOf([effect(4, 0, 18)])]]); // 18 -> save 80% -> 14: 1.10, 1.12 and 1.22 round apart
  const run = simulateFight(ch, {
    target: daedraTarget(), health: 100000, weapon: weaponOf(whatIf), seed: 0, trace: true, maxBlows: 1,
    standard, cwsRolls: () => 0.5,
  });
  assert.equal(run.cwsTrace[0].damage, 16, '14 x 1.12; 10% (the worn hand alone) gives 15 and 22% (both) gives 17');
});

test('C2b: main and off hand are overlaid independently, one piece per hand', () => {
  const main = potencyItem(10);
  const off = potencyItem(12, { equipSlot: 21 });
  const ch = characterFromSave(saveFor(BASIC(), { items: [main, off] }), { online: false });
  assert.equal(ch.weapon?.equipSlot, 19);
  assert.equal(ch.offWeapon?.equipSlot, 21);
  const potencyOf = (weapons) => spellPowerInputs(ch, { worn: equippedForFight(ch, weapons) }).potencyPct;

  assert.equal(potencyOf([main, off]), 22, 'both hands, each once');
  assert.equal(potencyOf([main]), 22, 'the off hand is untouched');
  assert.equal(potencyOf([potencyItem(5), off]), 17, 'a main-hand override replaces 10 with 5');
  assert.equal(potencyOf([null, potencyItem(7)]), 17, 'an off-hand override replaces 12 with 7, main kept');
  const offClone = { ...off, affixes: [{ id: 'potency', value: 9 }] };
  assert.equal(potencyOf([main, offClone]), 19, 'a clone of the off hand replaces it, never doubles it');
});

test('C5: a Legendary record counts once, as its power does (countedPieces)', () => {
  const leg = (slot, legendary = 'eye-of-magnus') => ({
    group: 'Jewellery', templateIndex: 135, name: 'ring', equipSlot: slot, rarity: 'legendary', legendary,
    affixes: [{ id: 'potency', value: 10 }],
  });
  assert.equal(spellPowerInputs({ worn: [leg(4), leg(5)] }).potencyPct, 10,
    'the same Legendary in two slots adds its line once (lootRarity.js:2348-2357)');
  assert.equal(spellPowerInputs({ worn: [leg(4), leg(5, 'shalidors-brand')] }).potencyPct, 20,
    'two different records each count');
  assert.equal(equippedForFight({ worn: [leg(4), leg(5)] }, []).length, 1);
});

test('C6: distinct pieces are never collapsed by their content', () => {
  const ring = { group: 'Jewellery', templateIndex: 135, name: 'ring', affixes: [{ id: 'potency', value: 10 }] };
  assert.equal(spellPowerInputs({ worn: [{ ...ring }, { ...ring }] }).potencyPct, 20,
    'two slotless pieces with identical content are still two pieces');
  assert.equal(spellPowerInputs({ worn: [{ ...ring }, { ...ring, affixes: [{ id: 'potency', value: 15 }] }] }).potencyPct, 25,
    'the content key is not an identity');
  const slotted = (value) => ({ ...ring, equipSlot: 4, affixes: [{ id: 'potency', value }] });
  assert.equal(spellPowerInputs({ worn: [slotted(10), slotted(15)] }).potencyPct, 15,
    'a hand-built list holds one piece per slot: the later occupant');
});

test('C7: a scenario weapon replaces ITS hand, never a content-identical piece in the other hand', () => {
  // 18 magnitude -> 80% save -> 14: 1.15 rounds to 16, 1.20 to 17, so the damage distinguishes the tables.
  const standard = new Map([[1, spellOf([effect(4, 0, 18)])]]);
  const over = potencyItem(5);
  delete over.equipSlot;
  for (const order of ['main first', 'off first']) {
    const items = order === 'main first'
      ? [potencyItem(10), potencyItem(10, { equipSlot: 21 })]
      : [potencyItem(10, { equipSlot: 21 }), potencyItem(10)];
    const ch = characterFromSave(saveFor(BASIC(), { items }), { online: false });
    ch._dual = true;
    const effective = equippedForFight(ch, [over, ch.offWeapon]);
    assert.deepEqual(effective.map((it) => [it.equipSlot, it.affixes[0].value]), [[19, 5], [21, 10]], order);
    assert.equal(spellPowerInputs(ch, { worn: effective }).potencyPct, 15, order);
    const run = simulateFight(ch, {
      target: daedraTarget(), health: 100000, weapon: weaponOf(over), dual: true, seed: 0, trace: true, maxBlows: 1,
      standard, cwsRolls: () => 0.5,
    });
    assert.equal(run.cwsTrace[0].damage, 16, `${order}: 14 x 1.15; 17 means the main override was lost`);
  }
});

test('C7b: the off hand overrides its own piece; both hands can be overridden', () => {
  const main = potencyItem(10);
  const off = potencyItem(10, { equipSlot: 21 });
  const ch = characterFromSave(saveFor(BASIC(), { items: [main, off] }), { online: false });
  const offOver = potencyItem(5);
  delete offOver.equipSlot;
  let effective = equippedForFight(ch, [ch.weapon, offOver]);
  assert.deepEqual(effective.map((it) => [it.equipSlot, it.affixes[0].value]), [[19, 10], [21, 5]]);
  assert.equal(spellPowerInputs(ch, { worn: effective }).potencyPct, 15);
  const mainOver = potencyItem(5);
  delete mainOver.equipSlot;
  effective = equippedForFight(ch, [mainOver, offOver]);
  assert.deepEqual(effective.map((it) => [it.equipSlot, it.affixes[0].value]), [[19, 5], [21, 5]]);
  assert.equal(spellPowerInputs(ch, { worn: effective }).potencyPct, 10);

  // The fight's off hand is the build's `offWeapon`; make it the override so both overridden hands are the ones fought.
  ch.offWeapon = offOver;
  const standard = new Map([[1, spellOf([effect(4, 0, 18)])]]);
  const run = simulateFight(ch, {
    target: daedraTarget(), health: 100000, weapon: weaponOf(mainOver), dual: true, seed: 0, trace: true, maxBlows: 1,
    standard, cwsRolls: () => 0.5,
  });
  assert.equal(run.cwsTrace[0].damage, 15, '14 x 1.10; 16 means an override crossed hands');
});

test('C7c: a duplicated Legendary across the hands counts at the LOWEST slot, as upstream orders the table', () => {
  const leg = (slot, value) => ({
    ...weapon(121, { material: 9 }), equipSlot: slot, rarity: 'legendary', legendary: 'wyrmbane',
    affixes: [{ id: 'potency', value }], enchantments: [{ type: 2, param: 1 }],
  });
  const ch = characterFromSave(saveFor(BASIC(), { items: [leg(19, 10), leg(21, 10)] }), { online: false });
  const offOver = leg(21, 15);
  delete offOver.equipSlot;
  const effective = equippedForFight(ch, [ch.weapon, offOver]);
  assert.equal(effective.length, 1, 'one Legendary record');
  assert.equal(effective[0].equipSlot, 19, 'the slot-19 copy is the one the table keeps');
  assert.equal(spellPowerInputs(ch, { worn: effective }).potencyPct, 10);

  const standard = new Map([[1, spellOf([effect(4, 0, 18)])]]);
  const run = simulateFight(ch, {
    target: daedraTarget(), health: 100000, weapon: weaponOf(effective[0]), dual: true, seed: 0, trace: true, maxBlows: 1,
    standard, cwsRolls: () => 0.5,
  });
  assert.equal(run.cwsTrace[0].damage, 15, '14 x 1.10; 16 means the higher-slot copy counted');
});

test('C7d: a clone of a slotless worn piece is still one piece', () => {
  const ring = { group: 'Jewellery', templateIndex: 135, name: 'ring', affixes: [{ id: 'potency', value: 10 }] };
  const ch = { worn: [{ ...ring }], weapon: null, items: [] };
  const effective = equippedForFight(ch, [{ ...ring }]);
  assert.equal(effective.length, 1, 'the slotless content match unifies the caller\'s clone');
  assert.equal(spellPowerInputs(ch, { worn: effective }).potencyPct, 10);
});

test('C8: the equip table reads in SLOT order, so a duplicated Legendary keeps its lowest slot', () => {
  const ring = (slot, value) => ({
    group: 'Jewellery', templateIndex: 135, name: 'ring', equipSlot: slot, rarity: 'legendary',
    legendary: 'eye-of-magnus', affixes: [{ id: 'potency', value }],
  });
  assert.equal(spellPowerInputs({ worn: [ring(5, 10), ring(4, 15)] }).potencyPct, 15, 'slot 4 is read first');
  assert.equal(spellPowerInputs({ worn: [ring(4, 15), ring(5, 10)] }).potencyPct, 15);
  const ch = characterFromSave(saveFor(BASIC(), { items: [ring(5, 10), ring(4, 15)] }), { online: false });
  const whatIf = potencyItem(5);
  delete whatIf.equipSlot;
  const effective = equippedForFight(ch, [whatIf]);
  assert.deepEqual(effective.map((it) => [it.equipSlot, it.affixes[0].value]), [[4, 15], [19, 5]]);
  assert.equal(spellPowerInputs(ch, { worn: effective }).potencyPct, 20,
    '15 at slot 4 + the 5 what-if; an insertion-order table would keep the slot-5 copy (15)');
});

test('D2: a build without `worn` is rejected instead of reading the whole inventory', () => {
  const ring = { group: 'Jewellery', templateIndex: 135, name: 'ring', affixes: [{ id: 'potency', value: 10 }] };
  assert.throws(() => spellPowerInputs({ items: [ring] }), /equipped/);
  const item = itemWith([{ type: 2, param: 1 }]);
  const ch = simCharacter(WEAK(), item);
  const noWorn = { ...ch };
  delete noWorn.worn;
  assert.throws(() => simulateFight(noWorn, {
    target: daedraTarget(), health: 1000, weapon: weaponOf(item), seed: 0, maxBlows: 1,
  }), /equipped/);
});

test('S1: the ordinary-target contract refuses relay/boss/cap shapes and accepts the ordinary constructors', () => {
  const item = itemWith([{ type: 2, param: 1 }]);
  const ch = simCharacter(WEAK(), item);
  const ordinary = referenceFoe(30, 'tough');
  const run = (target, extra = {}) => simulateFight(ch, {
    target, health: 1000, weapon: weaponOf(item), seed: 0, maxBlows: 1, ...extra,
  });
  assert.equal(ordinary.spareGear, false);

  // Every accepted ordinary constructor.
  assert.equal(run(referenceFoe(30, 'tough')).cwsCapable, true);
  assert.equal(run(makeTarget({ level: 30 })).cwsCapable, true);
  assert.equal(run(enemyTarget(31)).cwsCapable, true);
  assert.equal(run(null).cwsCapable, true, 'the default foe is ordinary');

  // Relay stand-ins and spareGear, by TRUTHINESS (the tier reads `!!tgt.relayBody`, blowOutcomes.js:148).
  for (const t of [
    standInTarget(31), { ...ordinary, relayBody: true }, { ...ordinary, relayBody: 1 },
    { ...ordinary, relayBody: 'yes' }, { ...ordinary, spareGear: true }, { ...ordinary, spareGear: 1 },
  ]) {
    assert.throws(() => run(t), /relay|spareGear/, JSON.stringify(t.relayBody ?? t.spareGear));
  }

  // Boss shapes: the flag, the traits, the phase shields, the shield pool and the boss constructors.
  for (const t of [
    { ...ordinary, isBoss: true }, { ...ordinary, isBoss: 1 }, { ...ordinary, bossTraits: ['curbing'] },
    bossTarget({ level: 30 }), gateTarget(45), encounterTarget('breach', 45),
  ]) {
    assert.throws(() => run(t), /ordinary foe|relay|spareGear/);
  }
  for (const t of [{ ...ordinary, phaseShields: 1 }, { ...ordinary, phaseShields: 'x' }, { ...ordinary, shieldPool: [] }]) {
    assert.throws(() => run(t), /ordinary foe/);
  }

  // A per-hit cap and scenario boss traits are the MELEE contract; a CWS cast resolves under neither, so a fight that
  // can cast refuses them instead of mixing the two halves silently.
  assert.throws(() => run({ ...ordinary, hitCap: 5 }), /per-hit cap/);
  assert.throws(() => run(ordinary, { traits: ['curbing'] }), /traits/);
  assert.throws(() => run(ordinary, { traits: ['bladeturning'] }), /traits/);

  // Without a CWS row both are supported (Stage 3.2 capped mode, Stage 3.3 traits) and are not refused.
  const plain = simCharacter(WEAK(), weapon(121, { material: 9 }));
  const melee = { target: { ...ordinary, hitCap: 5 }, health: 100, weapon: weaponOf(plain.weapon), seed: 11, maxBlows: 2 };
  assert.equal(simulateFight(plain, { ...melee, damageMode: 'capped' }).cwsCapable, false);
  assert.equal(simulateFight(plain, { ...melee, target: ordinary, traits: ['curbing'] }).cwsCapable, false);
});

test('Arcane Surge reads the LIVE maximum magicka; a declared base adds the ExtraSpellPts fold once', () => {
  const surge = { ...weapon(121, { material: 9 }), equipSlot: 20, rarity: 'legendary', legendary: 'shalidors-brand' };
  const extra = { ...weapon(121, { material: 9 }), enchantments: [{ type: 3, param: 0 }] };
  const surgeExtra = { ...surge, enchantments: [{ type: 3, param: 0 }] };

  // A LIVE value is the accessor's number (what a save stores): the fold is already in it and is never added again.
  assert.equal(liveMaxMagicka({ maxMagicka: 175, _enchantMods: { maxMagicka: 75 } }), 175);
  assert.equal(
    spellPowerInputs({ worn: [surge], magicka: 180, maxMagicka: 175, _enchantMods: { maxMagicka: 75 } }).potencyPct,
    25,
    '180 is above 75% of the live 175; adding the fold again (250) would read below the line',
  );
  // A DECLARED BASE is folded once.
  assert.equal(liveMaxMagicka({ maxMagickaBase: 100, _enchantMods: { maxMagicka: 75 } }), 175);
  assert.equal(liveMaxMagicka({ maxMagickaBase: 100 }), 100);
  const below = spellPowerInputs({ worn: [surge], magicka: 120, maxMagickaBase: 100, _enchantMods: { maxMagicka: 75 } });
  assert.equal(below.potencyPct, 0, '120 is below 75% of the live 175');
  const above = spellPowerInputs({ worn: [surge], magicka: 140, maxMagickaBase: 100, _enchantMods: { maxMagicka: 75 } });
  assert.equal(above.potencyPct, 25);

  // An own getter is live (the game's accessor) and is not refused for lacking a fold.
  const getter = { worn: [surgeExtra], magicka: 180, _enchantMods: { maxMagicka: 75 } };
  Object.defineProperty(getter, 'maxMagicka', { get: () => 175 });
  assert.equal(liveMaxMagicka(getter), 175);
  assert.equal(spellPowerInputs(getter).potencyPct, 25);

  // The threshold is strict, and reads the live number.
  assert.equal(spellPowerInputs({ worn: [surge], magicka: 75, maxMagicka: 100 }).potencyPct, 0);
  assert.equal(spellPowerInputs({ worn: [surge], magicka: 76, maxMagicka: 100 }).potencyPct, 25);

  // ExtraSpellPts is required only where a Surge reads a DECLARED BASE.
  assert.equal(spellPowerInputs({ worn: [extra], maxMagicka: 100 }).potencyPct, 0, 'no Surge: the fold is not read');
  assert.throws(() => spellPowerInputs({ worn: [surgeExtra], maxMagickaBase: 100 }), /ExtraSpellPts/);
  assert.equal(
    spellPowerInputs({ worn: [surgeExtra], maxMagickaBase: 100, magicka: 140, _enchantMods: { maxMagicka: 75 } }).potencyPct,
    25,
  );
  assert.equal(
    spellPowerInputs({ worn: [surgeExtra], maxMagicka: 175, magicka: 140 }).potencyPct,
    25,
    'a live value needs no fold and is not refused',
  );
});

test('C4: ExtraSpellPts gear alone does not refuse an ordinary fight', () => {
  const extra = { ...weapon(121, { material: 9 }), enchantments: [{ type: 3, param: 0 }] };
  const ch = simCharacter(BASIC(), extra);
  const r = simulateFight(ch, {
    target: referenceFoe(30, 'tough'), health: 500, weapon: weaponOf(extra), seed: 1, maxBlows: 5,
  });
  assert.equal(r.cwsCapable, false, 'no CWS row: no spell-power path is resolved');
  assert.ok(r.blows > 0);
});

test('C4b: a declared-base Surge build without the fold is refused; a save-derived live value is not', () => {
  const item = {
    ...weapon(121, { material: 9 }), rarity: 'legendary', legendary: 'shalidors-brand',
    enchantments: [{ type: 3, param: 0 }, { type: 2, param: 1 }],
  };
  const args = {
    target: referenceFoe(30, 'tough'), health: 500, weapon: weaponOf(item), seed: 1, maxBlows: 5,
    standard: new Map([[1, spellOf([effect(4, 0, 10)])]]),
  };
  // The lab fixture declares a BASE: the fold it needs is missing, so the threshold cannot be computed.
  const base = characterFromSave(saveFor(BASIC(), { items: [item], maxMagickaBase: 100 }), { online: false });
  assert.equal(base._enchantMods.maxMagicka, undefined, 'the rebuilt fold carries no max magicka');
  assert.equal(base.maxMagickaBase, 100);
  assert.throws(() => simulateFight(base, args), /ExtraSpellPts/);

  // A save-derived character carries the LIVE value (the ExtraSpellPts channel is already in it): no fold is added
  // and the fight runs.
  const live = characterFromSave(saveFor(BASIC(), { items: [item], maxMagicka: 175 }), { online: false });
  assert.equal(live.maxMagickaBase, undefined);
  assert.equal(liveMaxMagicka(live), 175);
  const run = simulateFight(live, args);
  assert.equal(run.cwsCapable, true);
  assert.ok(run.blows > 0);
});

test('the potency cap and the rounding are the upstream floors', () => {
  const triple = itemWith([{ type: 2, param: 1 }]);
  triple.affixes = [
    { id: 'potency', value: 15 }, { id: 'potency', value: 15 }, { id: 'potency', value: 15 },
  ];
  assert.equal(spellPowerInputs({ worn: [triple] }).potencyPct, 30, 'POTENCY_CAP 30, not 45');
  const ten = itemWith([{ type: 2, param: 1 }]);
  ten.affixes = [{ id: 'potency', value: 10 }];
  const ch = simCharacter(BASIC(), ten);
  const standard = new Map([[1, spellOf([effect(4, 0, 10)])]]);
  const run = simulateFight(ch, {
    target: daedraTarget(), health: 100000, weapon: weaponOf(ten), seed: 0, trace: true, maxBlows: 1,
    standard, cwsRolls: () => 0.5,
  });
  assert.equal(run.cwsTrace[0].damage, 9, '8.8 rounds to 9; floor would be 8');
});

test('the caster level reaches the CWS magnitude', () => {
  const levelScaling = effect(4, 0, 10);
  levelScaling.magnitudeLevelBase = 2;
  levelScaling.magnitudeLevelHigh = 2;
  levelScaling.magnitudePerLevel = 10;
  const item = itemWith([{ type: 2, param: 1 }]);
  const ch = simCharacter(BASIC(), item);
  const standard = new Map([[1, spellOf([levelScaling])]]);
  const run = simulateFight(ch, {
    target: daedraTarget(), health: 100000, weapon: weaponOf(item), seed: 0, trace: true, maxBlows: 1,
    standard, cwsRolls: () => 0.5,
  });
  assert.equal(run.cwsTrace[0].damage, 12, '10 + 2 x floor(30/10) = 16, save 80% -> 12');
});

test('a killing CWS row stops later rows', () => {
  const item = itemWith([{ type: 2, param: 1 }, { type: 2, param: 2 }]);
  const standard = new Map([
    [1, spellOf([effect(4, 0, 100)], { index: 1, name: 'first' })],
    [2, spellOf([effect(4, 0, 100)], { index: 2, name: 'second' })],
  ]);
  const ch = simCharacter(BASIC(), item);
  const run = simulateFight(ch, {
    target: daedraTarget(5), health: 5, weapon: weaponOf(item), seed: 0, trace: true, maxBlows: 1,
    standard, cwsRolls: () => 0.5,
  });
  assert.equal(run.cwsTrace.length, 1, 'the second row finds no live foe');
  assert.equal(run.cwsCasts, 1);
});

test('a CWS kill suppresses the echo as well as the melee', () => {
  const item = { ...weapon(121, { material: 9 }), rarity: 'rare', imprint: 'warp-edge' };
  item.enchantments = [{ type: 2, param: 1 }];
  const standard = new Map([[1, spellOf([effect(4, 0, 100)])]]);
  const ch = simCharacter(BASIC(), item);
  let run = null;
  for (let seed = 0; seed < 100 && !run; seed += 1) {
    const r = simulateFight(ch, {
      target: daedraTarget(5), health: 5, weapon: weaponOf(item), seed, trace: true, maxBlows: 1,
      standard, cwsRolls: () => 0.5,
    });
    if (r.trace[0]?.cwsKill && r.trace[0]?.echoHits > 0) run = r;
  }
  assert.ok(run, 'a seed with a CWS hit and an echo roll');
  assert.equal(run.trace[0].cwsKill, true);
  assert.equal(run.trace[0].echoApplied, 0, 'the echo is after the killing CWS and does not run');
  assert.equal(run.trace[0].meleeApplied, false);
  assert.equal(run.damageDealt, run.cwsDamage);
});
