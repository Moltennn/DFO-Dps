/*
 * test/cwsDifferential.test.js - Stage 3.5.1 independent CWS differential.
 *
 * The oracle is the pinned game's own `calculateAttackDamage` with an enchantCtx whose `applySpellToTarget` is the
 * host's landing: it calls the vendored `applySpell` with a seeded `rolls` and a hurt sink. The local side is
 * `src/cws.js`'s own resolver and `src/simulateFight.js`'s event loop. Nothing here copies a local number into the
 * oracle: every upstream call is handed only test inputs (spell record, target, item, rolls).
 *
 * What is compared:
 *   - CWS direct damage for Damage Health (4,0) spells, with the same seeded draws;
 *   - the per-effect absorption / reflection / resistance / elemental-resistance gates;
 *   - the trigger call/no-call matrix: miss, ward, off-hand whole/non-whole, missing record, zero-damage spell;
 *   - the event order (CWS inside the formula, melee blow after) and the host's no-blow-after-CWS-kill gate.
 *
 * Not claimed: event-level RNG equivalence with the game's default Math.random path, or any family other than 4,0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { upstream, referenceFoe, referenceFoe as upstreamReferenceFoe, weaponItem, playerEntity } from './harness/upstream.mjs';
import { upstreamEntity, character, simCharacter, weapon } from './harness/fixtures.mjs';
import { makeTarget, EFFECT_FLAGS } from '../src/target.js';
import { referenceFoe as localReferenceFoe, weaponOf, strikesNet } from '../src/model.js';
import { resolveCwsCast, cwsEligible, isDamageHealth, cwsRows, spellPowerInputs, schoolPotencyFor } from '../src/cws.js';
import { payloadRows } from '../src/enchants.js';
import { blowFightTier } from '../src/blowOutcomes.js';
import { createAttackSchedule, simulateFight, simulateFights, summarize } from '../src/simulateFight.js';
import { oracleEntity } from './harness/upstreamBodies.mjs';
import { oracleItem, upstreamFight } from './harness/fightOracle.mjs';
import { setPlayerDoor } from '../vendor/upstream/a3eb1605/src/systems/playerDoor.js';
import { _resetLootPowersForTests, _setLootPowersRandForTests } from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';
import { registerSpellPowerMod, registerSpellPierceMod, schoolPotency } from '../vendor/upstream/a3eb1605/src/systems/spell/spellPower.js';

const DESC = character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 }, skills: 50,
});

const CASTER = {
  isPlayer: true, level: 30, career: {}, skills: {}, activeEffects: [],
  stats: { strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50 },
  _mods: { stats: {}, skills: {}, statMax: {} },
};

const eff = (type, subType, magnitude = 10) => ({
  type, subType,
  magnitudeBaseLow: magnitude, magnitudeBaseHigh: magnitude,
  magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
  durationBase: 0, durationMod: 0, durationPerLevel: 1,
  chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
});

const spellOf = (effects, { index = 1, name = 'Test Bolt', element = 4, rangeType = 1 } = {}) => ({
  name, index, element, rangeType, effects,
});

const scripted = (values, fallback = 0.5) => {
  let i = 0;
  const fn = () => (i < values.length ? values[i++] : fallback);
  fn.used = () => i;
  return fn;
};

const upBody = (u, over = {}) => {
  const b = { ...referenceFoe(u, 30, 'tough') };
  Object.assign(b, {
    health: 1000, maxHealth: 1000, activeEffects: [], career: {}, skills: {},
    _mods: { stats: {}, skills: {}, statMax: {} }, magicka: 0, maxMagicka: 1000,
  }, over);
  return b;
};

const localBody = (over = {}) => makeTarget({
  isClass: false, level: 30, careerIndex: -1, career: {},
  stats: { strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50 },
  skills: {}, activeEffects: [], _mods: { stats: {}, skills: {}, statMax: {} },
  health: 1000, maxHealth: 1000, magicka: 0, maxMagicka: 1000,
  ...over,
});

const itemWith = (params, templateIndex = 113) => {
  const item = weaponItem(templateIndex, { material: 9, condition: 1 });
  item.equipSlot = 19;
  item.enchantments = params.map((param) => ({ type: 2, param }));
  return item;
};
/** An item with explicit enchantment rows (type/param objects), not CWS params. */
const enchItem = (rows, templateIndex = 113) => {
  const item = weaponItem(templateIndex, { material: 9, condition: 1 });
  item.equipSlot = 19;
  item.enchantments = rows.map((row) => ({ ...row }));
  return item;
};

/** One upstream spell landing, and the local resolver on the same inputs and the same draw script. */
function runSpell(u, { spell, over = {}, rolls = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], level = 30 } = {}) {
  const upTarget = upBody(u, over);
  const localTarget = localBody(over);
  const upDraws = scripted([...rolls]);
  const localDraws = scripted([...rolls]);
  let hurt = 0;
  const out = u.effects.applySpell(
    spell, level, upTarget, { hurt: (n) => { hurt += n; } }, upDraws, { entity: CASTER },
  );
  const local = resolveCwsCast({
    spell, caster: { entity: CASTER }, casterLevel: level, target: localTarget, rolls: localDraws,
  });
  return { out, hurt, local, upDraws: upDraws.used(), localDraws: localDraws.used(), upTarget, localTarget };
}

/** One upstream blow with the CWS context. `body.health` is mutated by the hurt sink, so a later CWS row sees the
 *  same live-foe gate the host's applySpellToTarget sees. */
function runBlow(u, {
  over = {}, item = itemWith([1]), spells = new Map([[1, spellOf([eff(4, 0, 10)])]]),
  rolls = () => 0.5, cwsRolls = () => 0.5, toHitMod = 1000, blowWeight = undefined, damageMod = undefined,
  attacker = null,
} = {}) {
  const body = upBody(u, over);
  const calls = [];
  const order = [];
  let hurt = 0;
  const ctx = {
    spellsByIndex: () => spells,
    applySpellToTarget: (record, attacker, target) => {
      if (!(body.health > 0)) return; // hostEnchant.js:216's live-foe lookup
      calls.push(record.index);
      order.push('cws');
      const out = u.effects.applySpell(
        record, attacker.level ?? 1, target,
        { hurt: (n) => { body.health = Math.max(0, body.health - n); hurt += n; } }, cwsRolls, { entity: attacker },
      );
      return out;
    },
  };
  const raw = u.formulas.calculateAttackDamage(attacker ?? upstreamEntity(DESC), body, {
    weapon: item, rolls, enchantCtx: ctx, toHitMod,
    ...(blowWeight !== undefined ? { blowWeight } : {}), ...(damageMod !== undefined ? { damageMod } : {}),
  });
  order.push('blow');
  return { raw, calls, order, hurt, body };
}

test('CWS direct damage: local resolver and upstream applySpell agree on damage and draws', async () => {
  const u = await upstream();
  const spell = spellOf([eff(4, 0, 10)]);
  const r = runSpell(u, { spell, rolls: [0.5, 0.5, 0.5] });
  assert.equal(r.out.damage, 8);
  assert.equal(r.local.damage, r.out.damage);
  assert.equal(r.hurt, r.out.damage);
  assert.equal(r.localDraws, r.upDraws, '2 magnitude draws + the save draw');
  assert.equal(r.local.effects[0].savePercent, 80);
});

test('CWS resistance: career tolerance, immunity, spell resistance and elemental resistance', async () => {
  const u = await upstream();
  const spell = spellOf([eff(4, 0, 10)]);

  const career = runSpell(u, { spell, over: { career: { resistanceFlags: EFFECT_FLAGS.Magic } }, rolls: [0.5, 0.5, 0.5] });
  assert.equal(career.local.damage, career.out.damage);

  const immune = runSpell(u, { spell, over: { career: { immunityFlags: EFFECT_FLAGS.Magic } }, rolls: [0.5, 0.5, 0.5] });
  assert.equal(immune.out.damage, 0);
  assert.equal(immune.local.damage, 0);

  const spellResist = runSpell(u, {
    spell, over: { activeEffects: [{ kind: 'spellResistance', chance: 100 }] }, rolls: [0.5, 0.5, 0.5],
  });
  assert.equal(spellResist.out.damage, 0);
  assert.equal(spellResist.local.damage, 0);
  assert.equal(spellResist.out.resisted, 1);
  assert.equal(spellResist.local.resisted, 1);
  assert.equal(spellResist.localDraws, spellResist.upDraws);

  const elemental = runSpell(u, {
    spell, over: { activeEffects: [{ kind: 'elementalResistance', element: 4, chance: 100 }] }, rolls: [0.5, 0.5, 0.5],
  });
  assert.equal(elemental.out.damage, 0);
  assert.equal(elemental.local.damage, 0);
  assert.equal(elemental.localDraws, elemental.upDraws);
});

test('CWS absorption: the career and the AbsorbsSpells enchantment', async () => {
  const u = await upstream();
  const spell = spellOf([eff(4, 0, 10)]);

  const career = runSpell(u, {
    spell, over: { career: { spellAbsorptionFlags: 4 }, magicka: 0, maxMagicka: 1000 }, rolls: [0.5, 0.5, 0.5],
  });
  assert.equal(career.out.damage, 0);
  assert.equal(career.local.damage, 0);
  assert.ok(career.out.absorbed > 0);
  assert.equal(career.local.absorbed, 1);
  assert.equal(career.localDraws, career.upDraws);

  const ench = runSpell(u, {
    spell, over: { _enchantMods: { absorbsSpells: true }, magicka: 0, maxMagicka: 1000 }, rolls: [0.4, 0.4, 0.4, 0.4],
  });
  assert.equal(ench.out.damage, 0);
  assert.equal(ench.local.damage, 0);
  assert.equal(ench.local.absorbed, 1);
  assert.equal(ench.localDraws, ench.upDraws);

  const pass = runSpell(u, {
    spell, over: { _enchantMods: { absorbsSpells: true }, magicka: 0, maxMagicka: 1000 }, rolls: [0.6, 0.5, 0.5, 0.5],
  });
  assert.ok(pass.out.damage > 0);
  assert.equal(pass.local.damage, pass.out.damage);
  assert.equal(pass.local.absorbed, 0);
  assert.equal(pass.localDraws, pass.upDraws);
});

test('CWS reflection: only the first effect reflects, later effects still land', async () => {
  const u = await upstream();
  const one = runSpell(u, {
    spell: spellOf([eff(4, 0, 10)]),
    over: { activeEffects: [{ kind: 'spellReflection', chance: 100 }] },
    rolls: [0.5, 0.5, 0.5],
  });
  assert.equal(one.out.damage, 0);
  assert.equal(one.local.damage, 0);
  assert.equal(one.out.reflected, 1);
  assert.equal(one.local.reflected, 1);
  assert.equal(one.localDraws, one.upDraws);

  const two = runSpell(u, {
    spell: spellOf([eff(4, 0, 10), eff(4, 0, 20)]),
    over: { activeEffects: [{ kind: 'spellReflection', chance: 100 }] },
    rolls: [0.5, 0.5, 0.5, 0.5],
  });
  assert.equal(two.out.damage, 16);
  assert.equal(two.local.damage, 16);
  assert.equal(two.out.reflected, 1);
  assert.equal(two.local.reflected, 1);
  assert.equal(two.localDraws, two.upDraws);
});

test('CWS family boundary: only isDamageHealth (4,0) is direct damage', async () => {
  const u = await upstream();
  assert.equal(isDamageHealth(eff(4, 0)), true);
  assert.equal(isDamageHealth(eff(1, 0)), false);
  assert.equal(isDamageHealth(eff(11, 8)), false);
  assert.equal(u.effects.isDamageHealth(eff(4, 0)), true);
  assert.equal(u.effects.isDamageHealth(eff(1, 0)), false);
  assert.equal(u.effects.isDamageHealth(eff(11, 8)), false);

  const dot = runSpell(u, { spell: spellOf([eff(1, 0, 10)]), rolls: [0.5, 0.5, 0.5] });
  assert.equal(dot.local.damage, 0);
  assert.equal(dot.local.deferred, 1);
  assert.equal(dot.out.damage, 0);

  const transfer = runSpell(u, { spell: spellOf([eff(11, 8, 10)]), rolls: [0.5, 0.5, 0.5] });
  assert.equal(transfer.local.damage, 0, 'Transfer Health is a separate family, not isDamageHealth');
  assert.equal(transfer.local.deferred, 1);
});

test('CWS trigger matrix: upstream call/no-call and the local gates agree', async () => {
  const u = await upstream();
  const spell = spellOf([eff(4, 0, 10)]);
  const spells = new Map([[1, spell]]);

  const hit = runBlow(u, { spells });
  assert.deepEqual(hit.calls, [1]);
  assert.deepEqual(hit.order, ['cws', 'blow']);
  assert.equal(hit.hurt, 8);
  assert.ok(hit.raw > 0);
  assert.equal(cwsEligible({ target: localReferenceFoe(30, 'tough'), strikesPositive: true, whole: true, item: itemWith([1]), standard: spells }), true);

  const miss = runBlow(u, { spells, toHitMod: -1000 });
  assert.deepEqual(miss.calls, []);
  assert.deepEqual(miss.order, ['blow']);
  assert.equal(miss.raw, 0);
  assert.equal(cwsEligible({ target: localReferenceFoe(30, 'tough'), strikesPositive: false, whole: true, item: itemWith([1]), standard: spells }), false);

  const warded = runBlow(u, { spells, over: { warded: true } });
  assert.deepEqual(warded.calls, []);
  assert.deepEqual(warded.order, ['blow']);
  assert.equal(cwsEligible({ target: { ...localReferenceFoe(30, 'tough'), warded: true }, strikesPositive: true, whole: true, item: itemWith([1]), standard: spells }), false);

  const nonWhole = runBlow(u, { spells, rolls: () => 0.9, blowWeight: 0.8 });
  assert.deepEqual(nonWhole.calls, []);
  assert.deepEqual(nonWhole.order, ['blow']);
  assert.equal(cwsEligible({ target: localReferenceFoe(30, 'tough'), strikesPositive: true, whole: false, item: itemWith([1]), standard: spells }), false);

  const whole = runBlow(u, { spells, rolls: () => 0.5, blowWeight: 0.8 });
  assert.deepEqual(whole.calls, [1]);

  const missing = runBlow(u, { spells: new Map() });
  assert.deepEqual(missing.calls, []);
  assert.deepEqual(missing.order, ['blow']);

  const zero = runBlow(u, { spells: new Map([[1, spellOf([eff(1, 0, 10)])]]) });
  assert.deepEqual(zero.calls, [1], 'a zero-damage spell still casts');
  assert.deepEqual(zero.order, ['cws', 'blow']);
  assert.equal(zero.hurt, 0);
});

test('CWS multiple rows: upstream walks them in item order', async () => {
  const u = await upstream();
  const spells = new Map([
    [1, spellOf([eff(4, 0, 10)], { index: 1, name: 'First' })],
    [2, spellOf([eff(4, 0, 20)], { index: 2, name: 'Second' })],
  ]);
  const r = runBlow(u, { item: itemWith([1, 2]), spells });
  assert.deepEqual(r.calls, [1, 2]);
  assert.equal(r.hurt, 8 + 16);
});

test('CWS kill: upstream order is CWS then blow, and the host gate drops the blow', async () => {
  const u = await upstream();
  const spells = new Map([[1, spellOf([eff(4, 0, 10)])]]);
  const kill = runBlow(u, { spells, over: { health: 5 } });
  assert.deepEqual(kill.calls, [1]);
  assert.deepEqual(kill.order, ['cws', 'blow']);
  assert.ok(kill.hurt >= 5);
  assert.equal(kill.body.health, 0);
  assert.ok(kill.raw > 0, 'the melee formula still returned a blow');
  const applied = kill.body.health > 0 ? kill.raw : 0; // dungeonContext.js:6781 damageFoe's foe.dead gate
  assert.equal(applied, 0, 'the melee blow is not applied after a CWS kill');

  const twoRows = new Map([
    [1, spellOf([eff(4, 0, 10)], { index: 1, name: 'First' })],
    [2, spellOf([eff(4, 0, 20)], { index: 2, name: 'Second' })],
  ]);
  const killedFirst = runBlow(u, { item: itemWith([1, 2]), spells: twoRows, over: { health: 5 } });
  assert.deepEqual(killedFirst.calls, [1], 'the second row finds no live foe after the first kills');
  assert.equal(killedFirst.body.health, 0);
});

const WEAK = () => character({
  level: 30, raceId: 1, stats: { strength: 0, agility: 50, speed: 50, luck: 50 }, skills: 0,
});
const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});
const localDaedra = () => ({ ...localReferenceFoe(30, 'tough'), mobileType: 25 });

test('F1: upstream guard, blowFightTier and simulateFight agree on Potent Vs misses and Low Damage Vs zeroing', async () => {
  const u = await upstream();
  const spell = spellOf([eff(4, 0, 10)]);
  const spells = new Map([[1, spell]]);

  // Potent Vs miss: upstream blow 5, NO cast; local pre-payload field is 0, post-payload field is 5.
  const pv = enchItem([{ type: 4, param: 1 }, { type: 2, param: 1 }]);
  const upPV = runBlow(u, { item: pv, spells, over: { mobileType: 25 }, toHitMod: -1000 });
  assert.deepEqual(upPV.calls, [], 'upstream casts nothing on a Potent Vs miss');
  assert.equal(upPV.raw, 5, 'the blow still returns the +5');
  const pvCh = simCharacter(WEAK(), pv);
  const pvTier = blowFightTier(pvCh, { target: localDaedra(), weapon: weaponOf(pv) });
  const pvMiss = pvTier.outcomes.find((o) => !o.hit && !o.strikesPositive && o.formulaPositive);
  assert.ok(pvMiss, 'the local tier carries the Potent Vs miss');
  const pvRun = simulateFight(pvCh, {
    target: localDaedra(), health: 100000, weapon: weaponOf(pv), seed: 0, trace: true, maxBlows: 1,
    standard: spells, cwsRolls: () => 0.5,
  });
  assert.equal(pvRun.trace[0].hit, false);
  assert.equal(pvRun.trace[0].strikesPositive, false);
  assert.equal(pvRun.trace[0].formulaPositive, true);
  assert.equal(pvRun.cwsCasts, 0, 'the simulator must not cast on the miss');

  // Low Damage Vs zeroing a positive blow: upstream blow 0, CAST is expected; local pre-payload field is positive.
  const lv = enchItem([{ type: 20, param: 1 }, { type: 2, param: 1 }]);
  const upLV = runBlow(u, { item: lv, spells, over: { mobileType: 25 }, toHitMod: 1000, damageMod: 0, attacker: upstreamEntity(WEAK()) });
  assert.deepEqual(upLV.calls, [1], 'upstream casts on a positive blow taken to zero');
  assert.equal(upLV.raw, 0, 'the post-payload blow is zero');
  const lvCh = simCharacter(WEAK(), lv);
  const lvTier = blowFightTier(lvCh, { target: localDaedra(), weapon: weaponOf(lv) });
  const lvZero = lvTier.outcomes.find((o) => o.hit && o.whole && o.strikesPositive && !o.formulaPositive && o.blow === 0);
  assert.ok(lvZero, 'the local tier carries the positive-to-zero hit');
  const lvRun = simulateFight(lvCh, {
    target: localDaedra(), health: 100000, weapon: weaponOf(lv), seed: 104, trace: true, maxBlows: 1,
    standard: spells, cwsRolls: () => 0.5,
  });
  assert.equal(lvRun.trace[0].hit, true);
  assert.equal(lvRun.trace[0].strikesPositive, true);
  assert.equal(lvRun.trace[0].formulaPositive, false);
  assert.equal(lvRun.trace[0].blowDamage, 0);
  assert.ok(lvRun.cwsCasts > 0, 'the simulator casts on the positive-to-zero hit');
});

test('payload walk: cwsRows/payloadRows/strikesNet match the vendored abort', async () => {
  const u = await upstream();
  const sentinel = { name: 'sent', index: 99, element: 4, rangeType: 1, effects: [] };
  const probe = (type) => {
    const calls = [];
    const item = { currentCondition: 100, maxCondition: 100, enchantments: [{ type, param: 1 }, { type: 2, param: 1 }] };
    const entity = { isPlayer: true, items: [item], equip: { slots: [] }, weapon: null };
    const ctx = {
      spellsByIndex: () => new Map([[1, sentinel]]),
      applySpellToTarget: (record) => calls.push(record.index),
      nowMinutes: 60,
    };
    u.enchantments.doItemEnchantmentPayloads(u.enchantments.PAYLOAD.Strikes, item, { entity, target: {}, damage: 1, ctx });
    return calls;
  };
  for (const type of [0, 1, 2, 3, 4, 20, 21, 26, 18, 19, 99]) {
    const item = enchItem([{ type, param: 1 }, { type: 2, param: 1 }]);
    const local = cwsRows(item, new Map([[1, spellOf([eff(4, 0, 10)])]])).length;
    assert.equal(local, probe(type).length, `type ${type}: the local row walk reaches the same CWS rows`);
    assert.equal(payloadRows(item).some((e) => e.type === 18 || e.type === 19 || e.type === 99), false);
  }

  const before = enchItem([{ type: 18, param: 0 }, { type: 4, param: 1 }]);
  const after = enchItem([{ type: 4, param: 1 }, { type: 18, param: 0 }]);
  const upBefore = runBlow(u, { item: before, spells: new Map(), toHitMod: -1000, over: { mobileType: 25 } });
  const upAfter = runBlow(u, { item: after, spells: new Map(), toHitMod: -1000, over: { mobileType: 25 } });
  assert.equal(upBefore.raw, 0, 'Potent Vs after an unregistered row never runs');
  assert.equal(upAfter.raw, 5, 'Potent Vs before it does');
  assert.equal(strikesNet(before, { mobileType: 25 }), 0);
  assert.equal(strikesNet(after, { mobileType: 25 }), 5);
});

test('spell power, pierce and online school potency match upstream applySpell', async () => {
  const u = await upstream();
  const spell = spellOf([eff(4, 0, 10)]);

  registerSpellPowerMod('audit-cws', () => 20);
  registerSpellPierceMod('audit-cws', () => 15);
  try {
    let upHurt = 0;
    u.effects.applySpell(spell, 30, upBody(u), { hurt: (n) => { upHurt += n; } }, () => 0.5, { entity: CASTER });
    const local = resolveCwsCast({
      spell, caster: { entity: CASTER }, casterLevel: 30, target: localBody(), rolls: () => 0.5,
      potencyPct: 20, pierce: 15,
    });
    assert.equal(local.damage, upHurt);
    assert.equal(local.damage, 12, '20% power and 15 pierce take the 50/50 save to full');
  } finally {
    registerSpellPowerMod('audit-cws', null);
    registerSpellPierceMod('audit-cws', null);
  }

  const mastered = {
    ...CASTER,
    skills: Array.from({ length: 35 }, (_, i) => (i === 22 ? 150 : 0)),
    masterSkills: true,
    masteredSkills: [22],
    online: true,
  };
  globalThis.location = { search: '?online' };
  try {
    let upHurt = 0;
    u.effects.applySpell(spell, 30, upBody(u), { hurt: (n) => { upHurt += n; } }, () => 0.5, { entity: mastered });
    const local = resolveCwsCast({
      spell, caster: { entity: mastered }, casterLevel: 30, target: localBody(), rolls: () => 0.5,
    });
    assert.equal(local.damage, upHurt);
    assert.ok(local.damage > 8, 'the mastered school past 100 lifts the damage');
  } finally {
    delete globalThis.location;
  }
});

test('gear potency, Arcane Surge and pierce inputs match the vendored loot law', async () => {
  const u = await upstream();
  const foe = { ...referenceFoe(u, 30, 'tough'), health: 1000, maxHealth: 1000, activeEffects: [], career: {} };
  const potency = {
    group: 'Jewellery', templateIndex: 135, name: 'ring', equipSlot: 9,
    affixes: [{ id: 'potency', value: 10 }], rarity: 'legendary', legendary: 'shalidors-brand',
  };
  const e = playerEntity({ level: 30 });
  e.equip.slots[9] = potency;
  e.magicka = 90;
  e.maxMagicka = 100;
  const local = spellPowerInputs({ worn: [potency], magicka: 90, maxMagicka: 100 });
  assert.equal(local.potencyPct, u.lootPowers.lootSpellPower(e, foe));
  assert.equal(local.pierce, u.lootPowers.lootSpellPierce(e, foe));

  const eye = { group: 'Jewellery', templateIndex: 133, name: 'amulet', equipSlot: 10, rarity: 'legendary', legendary: 'eye-of-magnus' };
  const e2 = playerEntity({ level: 30 });
  e2.equip.slots[10] = eye;
  assert.equal(spellPowerInputs({ worn: [eye] }).pierce, u.lootPowers.lootSpellPierce(e2, foe));
});

test('multi-effect death: local applied damage equals upstream hurt, not out.damage', async () => {
  const u = await upstream();
  const spell = spellOf([eff(4, 0, 10), eff(4, 0, 20)]);
  const upTarget = upBody(u, { health: 5 });
  let upHurt = 0;
  const out = u.effects.applySpell(spell, 30, upTarget, {
    hurt: (n) => {
      if (upTarget.health <= 0) return;
      upHurt += n;
      upTarget.health = Math.max(0, upTarget.health - n);
    },
  }, () => 0.5, { entity: CASTER });

  let health = 5;
  let localHurt = 0;
  const local = resolveCwsCast({
    spell, caster: { entity: CASTER }, casterLevel: 30, target: localBody({ health: 5 }), rolls: () => 0.5,
    hurt: (n) => {
      if (health <= 0) return false;
      localHurt += n;
      health = Math.max(0, health - n);
      return health > 0;
    },
  });
  assert.equal(local.damage, upHurt);
  assert.equal(local.damage, 8);
  assert.equal(out.damage, 24, 'applySpell counts the dead effect in out.damage');
  assert.equal(local.effects[1].applied, false);
});

test('echo kill: upstream hurtFoe and the local fight both drop the melee blow', async () => {
  const u = await upstream();
  const item = { ...weaponItem(121, { material: 9 }), rarity: 'rare', imprint: 'warp-edge' };
  const body = { ...referenceFoe(u, 30, 'tough'), health: 20, maxHealth: 20, activeEffects: [], career: {} };
  const attacker = playerEntity({ level: 30 });
  attacker.equip.slots[19] = item;
  let applied = 0;
  setPlayerDoor({
    foes: () => [{ entity: body, dead: false }],
    feet: () => [0, 0, 0],
    hurtFoe: (f, n) => {
      if (f.dead) return;
      applied += n;
      body.health = Math.max(0, body.health - n);
      f.dead = body.health <= 0;
    },
    castOnPlayer: () => {},
  });
  _resetLootPowersForTests();
  _setLootPowersRandForTests(() => 0);
  try {
    u.lootPowers.lootStrike(attacker, body, 23, item, { blow: true });
  } finally {
    _resetLootPowersForTests();
    setPlayerDoor(null);
  }
  assert.equal(body.health, 0);
  assert.equal(applied, 23);
  if (body.health > 0) applied += 23; // the host's melee blow after the listener
  assert.equal(applied, 23, 'the melee blow is not applied after the echo kills');

  const localItem = { ...weapon(121, { material: 9 }), rarity: 'rare', imprint: 'warp-edge' };
  const localCh = simCharacter(BASIC(), localItem);
  const localRun = simulateFight(localCh, {
    target: localReferenceFoe(30, 'tough'), health: 20, weapon: weaponOf(localItem), seed: 19, trace: true, maxBlows: 1,
  });
  assert.equal(localRun.trace[0].echoKill, true);
  assert.equal(localRun.trace[0].meleeApplied, false);
  assert.equal(localRun.damageDealt, 23);
  assert.equal(localRun.overkill, 3);
});


/**
 * One local build and the upstream host fight on the SAME event list and per-trial seeds. `events` is the schedule's
 * deterministic sequence up to `horizon`; every upstream call gets only test inputs (spell record, item, minted body,
 * events, seed).
 */
function fightPair(u, { item, offItem = null, pool, trials, seed, maxSeconds = 3600, horizon = 3600, standard = null }) {
  const ch = simCharacter(BASIC(), item);
  if (offItem) {
    ch.offWeapon = { ...offItem, equipSlot: 21 };
    ch._dual = true;
  }
  const args = {
    target: localReferenceFoe(30, 'tough'), health: pool, weapon: weaponOf(item),
    ...(offItem ? { dual: true } : {}), ...(standard ? { standard } : {}), maxSeconds,
  };
  const schedule = createAttackSchedule(ch, args);
  assert.ok(schedule);
  const events = [];
  for (let i = 0; i < 20000; i += 1) {
    const ev = schedule.next();
    if (!ev || ev.t > horizon) break;
    events.push(ev);
  }
  const local = simulateFights(ch, { ...args, trials, seed });
  assert.ok(local, 'the local fights ran');
  const up = local.seeds.map((s) => upstreamFight(u, {
    desc: BASIC(),
    item: oracleItem(item),
    offItem: offItem ? oracleItem(offItem) : null,
    body: oracleEntity({ ...upstreamReferenceFoe(u, 30, 'tough'), health: pool, maxHealth: pool }),
    events,
    seed: s,
    ...(standard ? { cws: standard } : {}),
  }));
  return { local, up, events };
}
const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));
/** A difference over the combined standard error: the independent-samples z of two means. */
const zOf = (a, b) => (a.mean - b.mean) / Math.hypot(a.se, b.se);
/** Two-proportion z (pooled), for the kill-source shares. */
const shareZ = (k1, n1, k2, n2) => {
  const p = (k1 + k2) / (n1 + n2);
  return ((k1 / n1) - (k2 / n2)) / Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
};

test('fight-level CWS: TTK agrees with the upstream host fight (main hand, gear potency)', async () => {
  const u = await upstream();
  const spells = new Map([[1, spellOf([eff(4, 0, 10)])]]);
  const item = enchItem([{ type: 2, param: 1 }], 121);
  item.affixes = [{ id: 'potency', value: 10 }]; // the potency line both sides must wear
  const { local, up } = fightPair(u, { item, pool: 12000, trials: 480, seed: 0x3510, standard: spells });
  assert.ok(local.ttk, 'the local fights kill');
  const upTtk = summarize(up.filter((r) => r.ttk != null).map((r) => r.ttk));
  assert.equal(local.ttk.n, 480);
  assert.equal(upTtk.n, 480);
  // The mean is the sensitive metric: a 5% spell-power error moves it by z ~ 8 at this n, while the sampling
  // standard error of the mean TTK is about 0.2%. |z| <= 4 (about four standard errors) and a 1% equivalence margin.
  const z = zOf(local.ttk, upTtk);
  assert.ok(Math.abs(z) <= 4, `TTK mean ${local.ttk.mean} vs ${upTtk.mean}: z ${z}`);
  assert.ok(rel(local.ttk.mean, upTtk.mean) <= 0.01, `TTK mean ${local.ttk.mean} vs ${upTtk.mean}`);
  for (const q of ['median', 'p10', 'p90']) {
    assert.ok(rel(local.ttk[q], upTtk[q]) <= 0.05, `TTK ${q} ${local.ttk[q]} vs ${upTtk[q]}`);
  }
});

test('fight-level CWS: the fixed-horizon damage and CWS share agree with the upstream host fight', async () => {
  const u = await upstream();
  const spells = new Map([[1, spellOf([eff(4, 0, 10)])]]);
  const item = enchItem([{ type: 2, param: 1 }], 121);
  item.affixes = [{ id: 'potency', value: 10 }];
  // The pool never empties inside the horizon: the comparison is damage over the same 600 s of blows, not a kill race.
  const { local, up } = fightPair(u, {
    item, pool: 1e9, trials: 240, seed: 0x3510, maxSeconds: 600, horizon: 600, standard: spells,
  });
  const lAll = summarize(local.rows.map((r) => r.damageDealt));
  const lCws = summarize(local.rows.map((r) => r.cwsDamage));
  const uAll = summarize(up.map((r) => r.damageDealt));
  const uCws = summarize(up.map((r) => r.cwsDamage));
  assert.ok(Math.abs(zOf(lAll, uAll)) <= 4 && rel(lAll.mean, uAll.mean) <= 0.01,
    `damage ${lAll.mean} vs ${uAll.mean}`);
  assert.ok(Math.abs(zOf(lCws, uCws)) <= 4 && rel(lCws.mean, uCws.mean) <= 0.02,
    `CWS damage ${lCws.mean} vs ${uCws.mean}`);
  const lShare = lCws.mean / lAll.mean;
  const uShare = uCws.mean / uAll.mean;
  assert.ok(lShare >= 0.15, `CWS is ${(lShare * 100).toFixed(1)}% of the horizon damage; too little to protect`);
  assert.ok(Math.abs(lShare - uShare) <= 0.02, `CWS share ${lShare} vs ${uShare}`);
});

test('fight-level CWS: the kill-source split (CWS / Many Endings / melee) agrees with the upstream host fight', async () => {
  const u = await upstream();
  const spells = new Map([[1, spellOf([eff(4, 0, 10)])]]);
  const item = enchItem([{ type: 2, param: 1 }], 121);
  Object.assign(item, { rarity: 'rare', imprint: 'warp-edge' }); // Many Endings rides the same blows
  const { local, up } = fightPair(u, { item, pool: 80, trials: 480, seed: 0x3510, standard: spells });
  assert.equal(local.kills, 480);
  assert.equal(up.filter((r) => r.ttk != null).length, 480);
  const n = 480;
  const count = (rows, k) => rows.filter((r) => r.killSource === k).length;
  for (const k of ['cws', 'echo', 'melee']) {
    const lc = count(local.rows, k);
    const uc = count(up, k);
    assert.ok(lc >= 20 && uc >= 20, `${k} kills ${lc} local / ${uc} upstream: too few to compare`);
    // A broken source reads 0 against its upstream share (CWS ~21%, echo ~7%, melee the rest): z far past 3.5.
    const z = shareZ(lc, n, uc, n);
    assert.ok(Math.abs(z) <= 3.5, `${k} kill share ${lc / n} vs ${uc / n}: z ${z}`);
  }
  assert.ok(count(local.rows, 'cws') / n >= 0.10, 'CWS kills are a real share of the fights');
});

test('fight-level CWS on the OFF hand agrees with the upstream host fight', async () => {
  const u = await upstream();
  const spells = new Map([[1, spellOf([eff(4, 0, 10)])]]);
  const main = weapon(121, { material: 9 });
  const off = enchItem([{ type: 2, param: 1 }], 121);
  off.affixes = [{ id: 'potency', value: 10 }];
  const { local, up } = fightPair(u, { item: main, offItem: off, pool: 9000, trials: 480, seed: 0x99, standard: spells });
  assert.ok(local.ttk, 'the local fights kill');
  const upTtk = summarize(up.filter((r) => r.ttk != null).map((r) => r.ttk));
  assert.equal(local.ttk.n, 480);
  assert.equal(upTtk.n, 480);
  assert.ok(Math.abs(zOf(local.ttk, upTtk)) <= 4 && rel(local.ttk.mean, upTtk.mean) <= 0.01,
    `TTK mean ${local.ttk.mean} vs ${upTtk.mean}`);
  const lCws = summarize(local.rows.map((r) => r.cwsDamage));
  const uCws = summarize(up.map((r) => r.cwsDamage));
  assert.ok(lCws.mean > 0 && uCws.mean > 0, 'the off hand casts');
  assert.ok(Math.abs(zOf(lCws, uCws)) <= 4 && rel(lCws.mean, uCws.mean) <= 0.02,
    `off-hand CWS damage ${lCws.mean} vs ${uCws.mean}`);
});

test('online school potency matches the upstream schoolPotency branch on the `_online` entity', async () => {
  const cases = [
    { online: true, skill: 150, mastered: true, masterSkills: false }, // the default online save
    { online: true, skill: 150, mastered: false, masterSkills: false },
    { online: true, skill: 150, mastered: true, masterSkills: true },
    { online: true, skill: 200, mastered: true, masterSkills: false },
    { online: false, skill: 150, mastered: true, masterSkills: true },
  ];
  for (const c of cases) {
    const desc = character({
      level: 30, raceId: 1, stats: { strength: 0, agility: 50, speed: 50, luck: 50 },
      skills: 0, skillOverride: { 22: c.skill }, mastered: c.mastered ? [22] : [],
      masterSkills: c.masterSkills, online: c.online,
    });
    const local = schoolPotencyFor(simCharacter(desc, enchItem([], 121)), 22);
    // The game sets the player entity's `_online = isOnlinePage()` (world.js:25813); schoolPotency's own `online`
    // option is that page lane (spellPower.js:66).
    const up = schoolPotency({ ...upstreamEntity(desc), _online: c.online, masterSkills: c.masterSkills, masteredSkills: c.mastered ? [22] : [] }, { online: c.online, school: 22 });
    assert.equal(local, up, JSON.stringify(c));
  }
  // The `_online` flag is load-bearing: without it upstream reads the OFFLINE master-skills switch on an online page.
  const desc = character({
    level: 30, raceId: 1, stats: { strength: 0, agility: 50, speed: 50, luck: 50 },
    skills: 0, skillOverride: { 22: 150 }, mastered: [22], online: true,
  });
  const up = { ...upstreamEntity(desc), masterSkills: false, masteredSkills: [22] };
  assert.equal(schoolPotency({ ...up, _online: true }, { online: true, school: 22 }), 1.17);
  assert.equal(schoolPotency({ ...up, _online: false }, { online: true, school: 22 }), 1,
    'without `_online` the offline switch caps the school at 100');
  assert.equal(schoolPotencyFor(simCharacter(desc, enchItem([], 121)), 22), 1.17);
});
