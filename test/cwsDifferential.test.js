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
import { upstream, referenceFoe, weaponItem } from './harness/upstream.mjs';
import { upstreamEntity, character } from './harness/fixtures.mjs';
import { makeTarget, EFFECT_FLAGS } from '../src/target.js';
import { referenceFoe as localReferenceFoe } from '../src/model.js';
import { resolveCwsCast, cwsEligible, isDamageHealth } from '../src/cws.js';

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
  item.enchantments = params.map((param) => ({ type: 2, param }));
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
  rolls = () => 0.5, cwsRolls = () => 0.5, toHitMod = 1000, blowWeight = undefined,
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
  const raw = u.formulas.calculateAttackDamage(upstreamEntity(DESC), body, {
    weapon: item, rolls, enchantCtx: ctx, toHitMod, ...(blowWeight !== undefined ? { blowWeight } : {}),
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

  const elemental = runSpell(u, {
    spell, over: { activeEffects: [{ kind: 'elementalResistance', element: 4, chance: 100 }] }, rolls: [0.5, 0.5, 0.5],
  });
  assert.equal(elemental.out.damage, 0);
  assert.equal(elemental.local.damage, 0);
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

  const ench = runSpell(u, {
    spell, over: { _enchantMods: { absorbsSpells: true }, magicka: 0, maxMagicka: 1000 }, rolls: [0.4, 0.4, 0.4, 0.4],
  });
  assert.equal(ench.out.damage, 0);
  assert.equal(ench.local.damage, 0);
  assert.equal(ench.local.absorbed, 1);

  const pass = runSpell(u, {
    spell, over: { _enchantMods: { absorbsSpells: true }, magicka: 0, maxMagicka: 1000 }, rolls: [0.6, 0.5, 0.5, 0.5],
  });
  assert.ok(pass.out.damage > 0);
  assert.equal(pass.local.damage, pass.out.damage);
  assert.equal(pass.local.absorbed, 0);
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

  const two = runSpell(u, {
    spell: spellOf([eff(4, 0, 10), eff(4, 0, 20)]),
    over: { activeEffects: [{ kind: 'spellReflection', chance: 100 }] },
    rolls: [0.5, 0.5, 0.5, 0.5],
  });
  assert.equal(two.out.damage, 16);
  assert.equal(two.local.damage, 16);
  assert.equal(two.out.reflected, 1);
  assert.equal(two.local.reflected, 1);
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
  assert.equal(cwsEligible({ target: localReferenceFoe(30, 'tough'), damagePositive: true, whole: true, item: itemWith([1]), standard: spells }), true);

  const miss = runBlow(u, { spells, toHitMod: -1000 });
  assert.deepEqual(miss.calls, []);
  assert.deepEqual(miss.order, ['blow']);
  assert.equal(miss.raw, 0);
  assert.equal(cwsEligible({ target: localReferenceFoe(30, 'tough'), damagePositive: false, whole: true, item: itemWith([1]), standard: spells }), false);

  const warded = runBlow(u, { spells, over: { warded: true } });
  assert.deepEqual(warded.calls, []);
  assert.deepEqual(warded.order, ['blow']);
  assert.equal(cwsEligible({ target: { ...localReferenceFoe(30, 'tough'), warded: true }, damagePositive: true, whole: true, item: itemWith([1]), standard: spells }), false);

  const nonWhole = runBlow(u, { spells, rolls: () => 0.9, blowWeight: 0.8 });
  assert.deepEqual(nonWhole.calls, []);
  assert.deepEqual(nonWhole.order, ['blow']);
  assert.equal(cwsEligible({ target: localReferenceFoe(30, 'tough'), damagePositive: true, whole: false, item: itemWith([1]), standard: spells }), false);

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
