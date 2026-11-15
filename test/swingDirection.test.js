/*
 * test/swingDirection.test.js - Stage 2.13: the swing direction the game actually draws.
 *
 * The game draws one direction per attack, before the blow's own rolls:
 *
 *   WeaponManager.cs:343            Random.Range((int)UpRight, (int)DownRight + 1)
 *   characters/weaponStates.js:278  CLICK_ATTACK_DIRECTIONS - UpRight, Left, Right, DownLeft, Down, DownRight
 *   characters/anims.js:33          FPSWeapon.OnAttackDirection -> StrikeUp/Left/Right/DownLeft/Down/DownRight
 *   combat/playerWeapon.js:1032     Math.floor(rolls() * 6), one draw an attack
 *
 * So six strikes are equally likely; the direction adds its flat damage and to-hit
 * (FormulaHelper.CalculateSwingModifiers -> playerAttackOptions :1344) inside the one blow, ahead of the crit,
 * the defence, the trait and the cap. A bow's release is forced to StrikeDown (:1113).
 *
 * The oracle here is upstream's own table and its own pcaaoAttackDamage: the test never feeds a local
 * intermediate to it, and the direction is drawn with upstream's expression, not the simulator's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze, RANDOM_SWING, SWING_DIRECTIONS, referenceFoe as simReferenceFoe, gateTarget, weaponOf,
} from '../src/model.js';
import { SWING_MODS } from '../src/data.js';
import { fight } from '../src/fight.js';
import { rankBuilds } from '../src/objectives.js';
import { maxCharacter } from '../src/maxprofile.js';
import { upstream, pcaaoModules, referenceFoe } from './harness/upstream.mjs';
import { character, simCharacter, upstreamEntity, weapon, upstreamWeapon, fresh } from './harness/fixtures.mjs';
import { generator, summarize } from './harness/prng.mjs';
import { compareSample } from './harness/differential.mjs';

const OPTS = { core: 'overhaul', rri: false, passiveOn: true, stacks: 5 };
const DRAW = (u) => u.playerWeapon.CLICK_ATTACK_DIRECTIONS.map((d) => u.anims.DIRECTION_TO_STRIKE[d]);
const DESC = () => character({
  level: 30, raceId: 1,
  stats: { strength: 80, agility: 70, speed: 80, luck: 50 },
  skills: 0, skillOverride: { 28: 100, 29: 100, 30: 80, 32: 100, 33: 100, 34: 40 },
});

test('1. the six directions are upstream\'s own table, equally likely, and the default is the draw', async () => {
  const u = await upstream();
  // The distribution is the upstream tables' product, not a copy kept here.
  assert.deepEqual([...SWING_DIRECTIONS], [...DRAW(u)]);
  assert.equal(SWING_DIRECTIONS.length, 6);
  assert.equal(new Set(SWING_DIRECTIONS).size, 6);
  // every strike's modifiers are the game's own (data.js SWING_MODS is FormulaHelper.CalculateSwingModifiers)
  for (const key of SWING_DIRECTIONS) {
    assert.deepEqual(SWING_MODS[key], u.playerWeapon.SWING_MODS[key], key);
  }
  assert.deepEqual(SWING_MODS.StrikeLeft, SWING_MODS.StrikeRight, 'the two side swings are the same modifiers');

  // analyze() draws by default, and no direction is privileged
  const ch = simCharacter(DESC(), weapon(121, { material: 9 }));
  const r = analyze(ch, { target: simReferenceFoe(30, 'tough'), ...OPTS });
  assert.equal(r.swing, RANDOM_SWING);
  assert.deepEqual(r.swingDirections, [...SWING_DIRECTIONS]);
  assert.equal(r.swingMix.length, 6);
  for (const m of r.swingMix) {
    assert.equal(m.chance, 1 / 6);
    assert.equal(m.key, SWING_DIRECTIONS[r.swingMix.indexOf(m)]);
  }
  assert.ok(Math.abs(r.swingMix.reduce((s, m) => s + m.chance, 0) - 1) < 1e-12);
  // an explicit direction stays a single, exact injection
  const one = analyze(ch, { target: simReferenceFoe(30, 'tough'), ...OPTS, swing: 'StrikeUp' });
  assert.equal(one.swing, 'StrikeUp');
  assert.deepEqual(one.swingDirections, ['StrikeUp']);
  assert.equal(one.swingMix.length, 1);
});

test('2. each of the six directions, for several weapon types, against the game\'s own blow', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const desc = DESC();
  const target = referenceFoe(u, 30, 'tough');
  const localTarget = simReferenceFoe(30, 'tough');
  const weapons = [
    { id: 'katana', item: weapon(121, { material: 9 }) },
    { id: 'warhammer', item: weapon(126, { material: 9 }) },
    { id: 'short blade', item: weapon(117, { material: 9 }) },
    { id: 'fists', item: null },
  ];
  for (const [w, { id, item }] of weapons.entries()) {
    for (const key of SWING_DIRECTIONS) {
      const mod = u.playerWeapon.SWING_MODS[key];
      const rng = generator(0x7a00 + w * 101 + SWING_DIRECTIONS.indexOf(key) * 7);
      const sample = [];
      for (let i = 0; i < 12000; i++) {
        sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
          weapon: item ? fresh(upstreamWeapon(item)) : null,
          damageMod: mod.damage, toHitMod: mod.toHit,
          rolls: rng, modules, backstabChance: 0,
        }));
      }
      const r = analyze(item ? simCharacter(desc, item) : simCharacter(desc), { target: localTarget, ...OPTS, swing: key });
      const cmp = compareSample({ expected: sample, actual: r.perSwing });
      const s = summarize(sample);
      assert.ok(cmp.ok, `${id} ${key}: ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)}`);
    }
  }
});

test('3. the full draw: the default is the equal mixture, and the neutral default is rejected', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const desc = DESC();
  const item = weapon(121, { material: 9 });
  const target = referenceFoe(u, 30, 'tough');
  const localTarget = simReferenceFoe(30, 'tough');
  const local = simCharacter(desc, item);
  const r = analyze(local, { target: localTarget, ...OPTS });

  // (a) exact enumeration: the default is the mean of the six directions, not a sample
  const directions = SWING_DIRECTIONS.map((key) => analyze(local, { target: localTarget, ...OPTS, swing: key }));
  const mean = (f) => directions.reduce((s, x) => s + f(x), 0) / directions.length;
  assert.ok(Math.abs(r.perSwing - mean((x) => x.perSwing)) < 1e-12, 'per swing is the draw\'s expectation');
  assert.ok(Math.abs(r.cappedPerSwing - mean((x) => x.cappedPerSwing)) < 1e-12, 'and so is the capped figure');

  // (b) upstream, drawing the direction with the game's own expression before each blow
  const dirs = u.playerWeapon.CLICK_ATTACK_DIRECTIONS;
  const rng = generator(0x7b00);
  const sample = [];
  for (let i = 0; i < 20000; i++) {
    const key = u.anims.DIRECTION_TO_STRIKE[dirs[Math.floor(rng() * dirs.length)]];
    const mod = u.playerWeapon.SWING_MODS[key];
    sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
      weapon: fresh(upstreamWeapon(item)), damageMod: mod.damage, toHitMod: mod.toHit,
      rolls: rng, modules, backstabChance: 0,
    }));
  }
  const cmp = compareSample({ expected: sample, actual: r.perSwing });
  const s = summarize(sample);
  assert.ok(cmp.ok, `draw: ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)}`);

  // a weak build too: at a low skill the hit clamp is where the direction's +-10 to-hit bites hardest
  const weakDesc = character({ level: 10, raceId: 1, stats: { strength: 50, agility: 50, speed: 50, luck: 50 }, skills: 0, skillOverride: { 29: 30, 34: 20 } });
  const weakItem = weapon(121, { material: 3 });
  const weakTarget = referenceFoe(u, 10, 'tough');
  const weakLocal = analyze(simCharacter(weakDesc, weakItem), { target: simReferenceFoe(10, 'tough'), ...OPTS });
  const rng2 = generator(0x7b80);
  const weakSample = [];
  for (let i = 0; i < 20000; i++) {
    const key = u.anims.DIRECTION_TO_STRIKE[dirs[Math.floor(rng2() * dirs.length)]];
    const mod = u.playerWeapon.SWING_MODS[key];
    weakSample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(weakDesc), weakTarget, {
      weapon: fresh(upstreamWeapon(weakItem)), damageMod: mod.damage, toHitMod: mod.toHit,
      rolls: rng2, modules, backstabChance: 0,
    }));
  }
  const ws = summarize(weakSample);
  const wc = compareSample({ expected: weakSample, actual: weakLocal.perSwing });
  assert.ok(wc.ok, `weak draw: ${weakLocal.perSwing.toFixed(4)} vs ${ws.mean.toFixed(4)} +/- ${(1.96 * ws.se).toFixed(4)}`);

  // (c) the old unconditional neutral is a different card, and the gate's endgame katana shows it
  const rri = { ...OPTS, rri: true };
  const neutral = analyze(maxCharacter(121), { target: gateTarget(45), health: gateTarget(45).maxHealth, ...rri });
  const old = analyze(maxCharacter(121), { target: gateTarget(45), health: gateTarget(45).maxHealth, ...rri, swing: 'StrikeLeft' });
  assert.ok(neutral.cappedDps < old.cappedDps * 0.999, `the neutral card (${old.cappedDps.toFixed(2)}) is not the draw (${neutral.cappedDps.toFixed(2)})`);
  assert.ok(Math.abs(old.cappedDps - 857.19) < 0.01 && Math.abs(neutral.cappedDps - 853.49) < 0.01);
  // and for a weak build the neutral row is further out: the hit clamp makes the average nonlinear
  const weakOld = analyze(simCharacter(weakDesc, weakItem), { target: simReferenceFoe(10, 'tough'), ...OPTS, swing: 'StrikeLeft' });
  assert.ok(Math.abs(weakOld.dps / weakLocal.dps - 1) > 0.03, `weak build neutral ${weakOld.dps.toFixed(3)} vs draw ${weakLocal.dps.toFixed(3)}`);
});

test('4. criticals and the per-hit cap: the draw composes with both, and a bow\'s release is forced', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const base = DESC();
  const desc = { ...base, skillOverride: { ...base.skillOverride, 26: 100, 34: 100 } }; // critical chance 100%
  const item = weapon(126, { material: 9 });
  const target = referenceFoe(u, 30, 'tough');
  const localTarget = simReferenceFoe(30, 'tough');
  const cap = 12;
  const dirs = u.playerWeapon.CLICK_ATTACK_DIRECTIONS;
  const rng = generator(0x7c00);
  const sample = [];
  for (let i = 0; i < 12000; i++) {
    const key = u.anims.DIRECTION_TO_STRIKE[dirs[Math.floor(rng() * dirs.length)]];
    const mod = u.playerWeapon.SWING_MODS[key];
    const d = u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
      weapon: fresh(upstreamWeapon(item)), damageMod: mod.damage, toHitMod: mod.toHit,
      rolls: rng, modules, backstabChance: 0,
    });
    sample.push(Math.min(d, cap));
  }
  const r = analyze(simCharacter(desc, item), { target: { ...localTarget, hitCap: cap }, ...OPTS });
  const s = summarize(sample);
  const cmp = compareSample({ expected: sample, actual: r.cappedPerSwing });
  assert.ok(cmp.ok, `crit + cap draw: ${r.cappedPerSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)}`);
  assert.ok(r.cappedPerSwing < r.perSwing, 'the cap binds');
  // the cap is inside each direction's mixture, so the draw's capped figure is the mean of the six capped figures
  const mean = SWING_DIRECTIONS.reduce((sum, key) => sum + analyze(simCharacter(desc, item), {
    target: { ...localTarget, hitCap: cap }, ...OPTS, swing: key,
  }).cappedPerSwing, 0) / SWING_DIRECTIONS.length;
  assert.ok(Math.abs(r.cappedPerSwing - mean) < 1e-12);

  // a bow's release is StrikeDown whatever the draw says (playerWeapon.js:1113)
  const bowItem = weapon(129, { material: 9 }); // a short bow pulls x1, so this test is the direction alone
  const bow = analyze(simCharacter(base, bowItem), { target: localTarget, ...OPTS });
  assert.deepEqual(bow.swingDirections, ['StrikeDown']);
  const mod = u.playerWeapon.SWING_MODS.StrikeDown;
  const rng2 = generator(0x7d00);
  const bowSample = [];
  for (let i = 0; i < 60000; i++) {
    bowSample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(base), target, {
      weapon: fresh(upstreamWeapon(bowItem)), damageMod: mod.damage, toHitMod: mod.toHit,
      rolls: rng2, modules, backstabChance: 0,
    }));
  }
  const bc = compareSample({ expected: bowSample, actual: bow.perSwing });
  const bs = summarize(bowSample);
  assert.ok(bc.ok, `bow release: ${bow.perSwing.toFixed(4)} vs ${bs.mean.toFixed(4)} +/- ${(1.96 * bs.se).toFixed(4)}`);
});

test('5. a whole fight under the draw, against seeded upstream fights that draw per blow', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const desc = DESC();
  const item = weapon(121, { material: 9 });
  const target = referenceFoe(u, 30, 'tough');
  const health = 12000;
  const local = fight(simCharacter(desc, item), { target: simReferenceFoe(30, 'tough'), health, ...OPTS });
  assert.ok(local && local.ttk > 0);
  const dirs = u.playerWeapon.CLICK_ATTACK_DIRECTIONS;
  const reps = 160;
  const times = [];
  for (let k = 0; k < reps; k++) {
    const body = { ...target, relayHealth: false, maxHealth: health, health };
    const rng = generator(0x7e00 + k * 37);
    let t = 0;
    while (body.health > 0 && t < 6000) {
      const key = u.anims.DIRECTION_TO_STRIKE[dirs[Math.floor(rng() * dirs.length)]];
      const mod = u.playerWeapon.SWING_MODS[key];
      const d = u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), body, {
        weapon: fresh(upstreamWeapon(item)), damageMod: mod.damage, toHitMod: mod.toHit,
        rolls: rng, modules, backstabChance: 0,
      });
      body.health -= d;
      t += 1 / local.snapshot.cadence.aps;
    }
    times.push(t);
  }
  const s = summarize(times);
  const rel = local.ttk / s.mean - 1;
  assert.ok(Math.abs(rel) < 0.01, `fight: model ${local.ttk.toFixed(3)} s vs seeded ${s.mean.toFixed(3)} +/- ${(1.96 * s.se).toFixed(3)} (${(rel * 100).toFixed(2)}%)`);
});

test('6. a ranking whose order the draw changes, with the objective and target named', () => {
  const target = simReferenceFoe(45, 'tough');
  const entries = [{ id: 117, ch: maxCharacter(117) }, { id: 120, ch: maxCharacter(120) }];
  const old = rankBuilds(entries, { ...OPTS, rri: true, objective: 'snapshot', target, swing: 'StrikeLeft' });
  const draw = rankBuilds(entries, { ...OPTS, rri: true, objective: 'snapshot', target });
  const order = (r) => r.rows.map((x) => x.id).join(',');
  assert.equal(old.objective, 'snapshot');
  assert.equal(draw.objective, 'snapshot');
  // the neutral card puts the short blade first; the draw reverses it (each build's average direction differs)
  assert.equal(order(old), '117,120');
  assert.equal(order(draw), '120,117');
  for (const row of draw.rows) {
    assert.deepEqual(row.assumptions, draw.rows[0].assumptions);
    assert.equal(row.assumptions.objective, 'snapshot');
  }
  // and the draw's values are the analyze() cards, not a separate calculation
  const r117 = analyze(maxCharacter(117), { ...OPTS, rri: true, target });
  assert.equal(draw.rows.find((x) => x.id === 117).value, r117.dps);
});
