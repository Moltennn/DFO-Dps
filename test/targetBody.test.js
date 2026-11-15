/*
 * test/targetBody.test.js - Stage 2.8: the target-construction boundary.
 *
 * Every assertion compares a local body with the body UPSTREAM mints for itself, in its own realm
 * booted as the client boots (test/harness/upstreamBodies.mjs: a worker thread running the vendored
 * installEnemyExpansion, makeEnemyEntity and bossStandIn). The oracle is handed a test's inputs - a
 * mobile, a career, a player level - and never a field of a local target.
 *
 * It covers the audit's F6 (enemyTarget's missing level became 0; the raw row stood for the minted
 * one) and F8 (the Sky-ketch and Abyss bodies carried armour 0 and the content level), and shows that
 * each check would have failed on the construction it replaces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { analyze, gateTarget, referenceFoe, weaponOf } from '../src/model.js';
import { ENCOUNTERS, encounterTarget } from '../src/encounters.js';
import { UPSTREAM_BOOT, enemyRowOf, enemyTarget, mintRow, standInTarget } from '../src/target.js';
import { upstream, pcaaoModules, PROJECT } from './harness/upstream.mjs';
import { compareBody, oracleEntity, upstreamBodies, upstreamBody } from './harness/upstreamBodies.mjs';
import { compareSample } from './harness/differential.mjs';
import { character, simCharacter, upstreamEntity, weapon, upstreamWeapon, fresh } from './harness/fixtures.mjs';
import { generator, summarize } from './harness/prng.mjs';

const MONSTERS = Array.from({ length: 43 }, (_, i) => i);
const CLASSES = Array.from({ length: 19 }, (_, i) => 128 + i);
const CLASS_CAREER = Object.freeze({ strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50, hitPointsPerLevel: 8 });
const CAREER = Object.freeze({ strength: 70, intelligence: 50, willpower: 60, agility: 55, endurance: 65, personality: 50, speed: 55, luck: 40 });
const ENCOUNTER_LEVELS = [5, 20, 45, 60];

/** The construction this stage replaced, kept here only as the mutant each check must catch:
 *  `Number(null)` is finite, so the level became 0 and its skills `max(0, 0 || 1) * 5 + 30`; the
 *  armour and metal came from the raw table row (src/target.js before Stage 2.8). */
function preStageEnemyTarget(mobile) {
  const row = enemyRowOf(mobile);
  const isClass = mobile >= 128;
  return {
    ...enemyTarget(mobile, isClass ? { level: 1, exactLevel: true } : {}),
    level: 0,
    skills: Object.fromEntries(Array.from({ length: 35 }, (_, i) => [i, 35])),
    armorValues: new Array(7).fill(isClass ? 100 : (Number(row?.armorValue) || 0) * 5),
    minMetalToHit: isClass ? -1 : row.minMetalToHit,
  };
}
/** The pre-Stage-2.8 Sky-ketch / Abyss body: a card foe at the content level with the row's armour 0. */
function preStageEncounterBody(id, level) {
  const t = encounterTarget(id, level);
  return {
    ...t,
    combatLevel: level,
    skills: referenceFoe(level, { isClass: false, armorValue: 0 }).skills,
    armorValues: new Array(7).fill(0),
    minMetalToHit: -1,
  };
}

test('the oracle realm boots as the client boots: Enemy Expansion with MUDEX, the shipped switches', async () => {
  const { boot } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  // installEnemyExpansion() read the mods' own switches (no argument): DEX loaded, and MUDEX with it
  // because Meaner Monsters is on (dexInstall.js:183-190).
  assert.equal(boot.loaded, true, 'Enemy Expansion loaded for the game');
  assert.equal(boot.mudex, true, 'MUDEX loaded beside it');
  assert.equal(boot.dexLoaded && boot.mudexLoaded, true);
  assert.equal(boot.meanerMonstersAlone, false, 'Meaner Monsters\' own row and the overhaul\'s edit stand aside (dexSwitches.js:28)');
  // The local boot is read from the same shipped defaults, and agrees with what the realm did.
  assert.deepEqual(UPSTREAM_BOOT, { pcaao: true, meanerMonsters: true, enemyExpansion: true });
  assert.equal(UPSTREAM_BOOT.enemyExpansion, boot.loaded);
  assert.equal(UPSTREAM_BOOT.enemyExpansion && UPSTREAM_BOOT.meanerMonsters, boot.mudex);
  // Why the hit path may still be sampled in the unbooted realm: the boot's combat doors leave every
  // classic foe alone - no classic row is skeletal, and the group/language doors read only the
  // mod's own fifty (ids from 256).
  assert.deepEqual(boot.classicSkeletal, []);
  assert.ok(boot.customEnemyIds.length > 0 && boot.customEnemyIds.every((id) => id >= 256));
});

test('every classic monster body (all 43 rows) is the one upstream mints - or refused where upstream mints none', async () => {
  const { bodies } = await upstreamBodies([
    ...MONSTERS.map((mobile) => ({ kind: 'mint', mobile })),
    ...MONSTERS.map((mobile) => ({ kind: 'mint', mobile, career: CAREER })),
  ]);
  let compared = 0;
  for (const mobile of MONSTERS) {
    const [bare, careered] = [bodies[mobile], bodies[MONSTERS.length + mobile]];
    if (!Number.isInteger(bare.level)) {
      // Mobile 39 is an empty slot: upstream mints level undefined and NaN skills from it.
      assert.equal(mobile, 39, `only the empty slot has no level (mobile ${mobile})`);
      assert.ok(!Number.isFinite(bare.skills), 'upstream mints no usable body from it');
      assert.throws(() => enemyTarget(mobile), /carries no level/);
      continue;
    }
    assert.deepEqual(compareBody(enemyTarget(mobile), bare), [], `mobile ${mobile}`);
    assert.deepEqual(compareBody(enemyTarget(mobile, { career: CAREER }), careered), [], `mobile ${mobile} with a career`);
    // The minted row itself, field for field where the body reads it.
    for (const k of ['level', 'armorValue', 'minMetalToHit', 'affinity']) {
      assert.deepEqual(mintRow(mobile)[k], bare.basics[k], `mobile ${mobile} row.${k}`);
    }
    compared++;
  }
  assert.equal(compared, 42, 'all 42 monsters with a row level');
});

test('every class foe body is minted at the player level it is handed (and the watchman\'s roll)', async () => {
  const requests = [];
  for (const mobile of CLASSES) for (const playerLevel of [1, 20, 45]) requests.push({ kind: 'mint', mobile, career: CLASS_CAREER, playerLevel, exactLevel: true });
  for (const roll of [0, 0.3, 0.999]) requests.push({ kind: 'mint', mobile: 146, career: CLASS_CAREER, playerLevel: 20, roll });
  const { bodies } = await upstreamBodies(requests);
  requests.forEach((r, i) => {
    const local = r.exactLevel
      ? enemyTarget(r.mobile, { level: r.playerLevel, career: CLASS_CAREER, exactLevel: true })
      : enemyTarget(r.mobile, { level: r.playerLevel, career: CLASS_CAREER, rolls: () => r.roll });
    assert.deepEqual(compareBody(local, bodies[i]), [], `class ${r.mobile} at ${r.playerLevel} ${r.exactLevel ? 'exact' : `roll ${r.roll}`}`);
  });
});

test('the 43 monster rows: what the boot changes, and what it never touches', async () => {
  const { bodies } = await upstreamBodies(MONSTERS.map((mobile) => ({ kind: 'mint', mobile })));
  const changed = { level: [], armorValue: [], minMetalToHit: [], affinity: [] };
  for (const mobile of MONSTERS) {
    const raw = enemyRowOf(mobile);
    for (const k of Object.keys(changed)) if (JSON.stringify(raw[k]) !== JSON.stringify(bodies[mobile].basics[k])) changed[k].push(mobile);
  }
  // No edit of the shipped boot moves a monster's metal requirement or its affinity, so the
  // minMetalToHit and the group/affinity terms never depended on which row was read.
  assert.deepEqual(changed.minMetalToHit, [], 'minMetalToHit is the shipped row\'s for every monster');
  assert.deepEqual(changed.affinity, [], 'affinity is the shipped row\'s for every monster');
  // The level and the armour do move: the rows the body must take from the booted mint.
  assert.ok(changed.level.length > 0 && changed.armorValue.length > 0);
  for (const mobile of [...new Set([...changed.level, ...changed.armorValue])]) {
    assert.deepEqual(compareBody(enemyTarget(mobile), bodies[mobile]), [], `mobile ${mobile}: the minted, not the shipped, row`);
  }
});

test('F6: a missing, null or invalid level never becomes level 0', async () => {
  const { bodies } = await upstreamBodies([31, 7, 15].map((mobile) => ({ kind: 'mint', mobile })));
  const [lord] = bodies;
  // Missing and null: the minted row's level (the game ignores a player level for a monster).
  assert.equal(enemyTarget(31).level, lord.level);
  assert.equal(enemyTarget(31, { level: undefined }).level, lord.level);
  assert.equal(enemyTarget(31, { level: null }).level, lord.level);
  assert.equal(enemyTarget(31, { playerLevel: null }).level, lord.level);
  assert.equal(enemyTarget(31).levelSource, 'mint');
  // Invalid: refused, never coerced.
  for (const bad of [0, -1, 2.5, NaN, Infinity, -Infinity, '', 'abc', '0', true, {}, []]) {
    assert.throws(() => enemyTarget(31, { level: bad }), RangeError, `level ${String(bad)}`);
    assert.throws(() => enemyTarget(128, { level: bad }), RangeError, `class level ${String(bad)}`);
  }
  assert.throws(() => enemyTarget(31, { level: 20, playerLevel: 21 }), /disagree/);
  // A class foe has no level of its own: the player's must be handed, and the watchman's roll answered.
  assert.throws(() => enemyTarget(128), /player's level/);
  assert.throws(() => enemyTarget(128, { level: null }), /player's level/);
  assert.throws(() => enemyTarget(146, { level: 20 }), /Range\(3, 7\)/);
  // Explicit 0 is refused because nothing upstream mints at 0: every monster body with a row level
  // is 1 or more, and a class foe takes a player's level.
  const { bodies: all } = await upstreamBodies(MONSTERS.map((mobile) => ({ kind: 'mint', mobile })));
  assert.ok(all.every((b) => b.level === undefined || b.level >= 1), 'no upstream body has level 0');
  assert.ok(Math.min(...all.filter((b) => Number.isInteger(b.level)).map((b) => b.level)) >= 1);
  // An explicit monster level is a labelled scenario override, never mistaken for the game's body.
  const over = enemyTarget(31, { level: 30 });
  assert.equal(over.levelSource, 'override');
  assert.equal(over.level, 30);
  assert.notDeepEqual(compareBody(over, lord), [], 'an override is not the minted body');
  // The check would have caught F6: the pre-2.8 construction differs from upstream for every
  // monster that has a row level.
  const caught = MONSTERS.filter((m) => m !== 39 && compareBody(preStageEnemyTarget(m), all[m]).some((d) => d.field === 'level'));
  assert.equal(caught.length, 42, 'level 0 is caught on all 42 monsters');
});

test('F8: the Breach, Sky-ketch and Abyss bodies are one upstream stand-in, at every content level', async () => {
  const { bodies: [ruhn, iron] } = await upstreamBodies([{ kind: 'standIn', mobile: 31 }, { kind: 'standIn', mobile: 36 }]);
  // Upstream's own bodies: armour 60 on all seven parts, every metal bites, skills 100; the level is
  // the minted row's - 21 for the Daedra Lord, 16 for the Iron Atronach under the client's boot.
  assert.deepEqual(ruhn.armorValues, new Array(7).fill(60));
  assert.deepEqual(iron.armorValues, new Array(7).fill(60));
  assert.equal(ruhn.minMetalToHit, 0);
  assert.equal(iron.minMetalToHit, 0);
  for (const level of ENCOUNTER_LEVELS) {
    assert.deepEqual(compareBody(gateTarget(level), ruhn, { combatLevel: true }), [], `gate at ${level}`);
    assert.deepEqual(compareBody(encounterTarget('breach', level), ruhn, { combatLevel: true }), [], `breach at ${level}`);
    assert.deepEqual(compareBody(encounterTarget('skyketch', level), iron, { combatLevel: true }), [], `skyketch at ${level}`);
    assert.deepEqual(compareBody(encounterTarget('abyss', level), iron, { combatLevel: true }), [], `abyss at ${level}`);
    assert.equal(encounterTarget('skyketch', level).level, level, 'the content level stays the boss\'s own field');
  }
  // One construction path: each encounter's body is standInTarget's for its look, field for field.
  for (const [id, mobile] of [['breach', 31], ['skyketch', 36], ['abyss', 36]]) {
    const t = encounterTarget(id, 45);
    const s = standInTarget(mobile);
    for (const k of ['combatLevel', 'skills', 'armorValues', 'minMetalToHit', 'careerIndex', 'affinity', 'mobileType', 'stats']) {
      assert.deepEqual(t[k], s[k], `${id}.${k} is standInTarget(${mobile})'s`);
    }
  }
  // No encounter states a body of its own.
  for (const [id, e] of Object.entries(ENCOUNTERS)) {
    for (const k of ['armorValue', 'armorValues', 'minMetalToHit', 'level', 'combatLevel', 'skills']) {
      assert.equal(Object.hasOwn(e, k), false, `${id} carries no ${k}`);
    }
  }
  // Encounter mechanics are unchanged by the body: traits, cap, health and phases ride as before.
  assert.deepEqual(encounterTarget('skyketch', 45).bossTraits, ['frostproof', 'stoneskin']);
  assert.deepEqual(encounterTarget('abyss', 45).bossTraits, ['spellproof', 'stoneskin']);
  // The check would have caught F8: the pre-2.8 Sky-ketch/Abyss body differs in its armour and level.
  for (const id of ['skyketch', 'abyss']) {
    for (const level of ENCOUNTER_LEVELS) {
      const fields = compareBody(preStageEncounterBody(id, level), iron, { combatLevel: true }).map((d) => d.field);
      assert.ok(fields.includes('armorValues') && fields.includes('combatLevel') && fields.includes('minMetalToHit'), `${id} at ${level}: ${fields}`);
    }
  }
});

/** Upstream's blows against its own body, sampled; the local per swing against the local boss. */
async function midLevel({ level, skill, agility, seed, draws }) {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const desc = character({ level, raceId: 1, stats: { strength: 60, agility, speed: 60, luck: 50 }, skills: 0, skillOverride: { 29: skill, 34: 20 } });
  const item = weapon(121, { material: 6 });
  const { bodies } = await upstreamBodies([{ kind: 'standIn', mobile: 31 }, { kind: 'standIn', mobile: 36 }]);
  const out = {};
  for (const [id, body] of [['breach', bodies[0]], ['skyketch', bodies[1]], ['abyss', bodies[1]]]) {
    const e = oracleEntity(body);
    const rng = generator(seed + id.length);
    const sample = [];
    for (let i = 0; i < draws; i++) {
      sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), e, { weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0 }));
    }
    const per = (t) => analyze(simCharacter(desc, item), { target: { ...t, bossTraits: [], hitCap: 0 }, core: 'overhaul', weapon: weaponOf(item) });
    out[id] = {
      sample,
      hit: sample.filter((d) => d > 0).length / draws,
      local: per(encounterTarget(id, level)),
      before: per(preStageEncounterBody(id, level)),
    };
  }
  return out;
}

test('a mid-level attacker against the three bosses: the body is the game\'s, and the old one is far outside', async () => {
  // The audit's level-20 attacker: hit clamps at 97% against armour 60, so the old armour-0 body
  // (hit ~0.50) is the visible error.
  const r = await midLevel({ level: 20, skill: 60, agility: 55, seed: 0x2800, draws: 40000 });
  for (const [id, x] of Object.entries(r)) {
    const cmp = compareSample({ expected: x.sample, actual: x.local.perSwing });
    const s = summarize(x.sample);
    assert.ok(cmp.ok, `${id}: ${x.local.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)}`);
    assert.ok(Math.abs(x.local.hit.hit - x.hit) < 0.01, `${id} hit ${x.local.hit.hit} vs ${x.hit}`);
    assert.ok(!compareSample({ expected: x.sample, actual: x.before.perSwing }).ok, `${id}: the pre-2.8 body is caught`);
  }
  assert.ok(r.skyketch.before.perSwing < 0.6 * r.skyketch.local.perSwing, 'the old Sky-ketch body under-read per swing by over 40%');
});

test('a weaker attacker below the 97% clamp: the hit chance itself reads the body\'s armour', async () => {
  // Below the clamp the armour value is measured, not just its gross error: a body five points off
  // in either direction would leave the CI.
  const r = await midLevel({ level: 10, skill: 40, agility: 45, seed: 0x2810, draws: 40000 });
  for (const [id, x] of Object.entries(r)) {
    assert.ok(x.hit < 0.95, `${id}: the attacker is below the clamp (hit ${x.hit.toFixed(3)})`);
    const s = summarize(x.sample);
    assert.ok(compareSample({ expected: x.sample, actual: x.local.perSwing }).ok, `${id}: ${x.local.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)}`);
    const desc = character({ level: 10, raceId: 1, stats: { strength: 60, agility: 45, speed: 60, luck: 50 }, skills: 0, skillOverride: { 29: 40, 34: 20 } });
    const item = weapon(121, { material: 6 });
    for (const off of [-5, 5]) {
      const t = encounterTarget(id, 10);
      const wrong = analyze(simCharacter(desc, item), { target: { ...t, armorValues: t.armorValues.map((a) => a + off), bossTraits: [], hitCap: 0 }, core: 'overhaul', weapon: weaponOf(item) });
      assert.ok(!compareSample({ expected: x.sample, actual: wrong.perSwing }).ok, `${id}: armour ${60 + off} would be caught (${wrong.perSwing.toFixed(4)})`);
    }
  }
});

test('the oracle is independent of local target construction', async () => {
  // 1. No test hands a local target's body to an upstream entity, and the oracle's harness never
  //    loads this project's code.
  const testDir = path.join(PROJECT, 'test');
  const copy = /\b\w+\.(level|skills|armorValues|stats|minMetalToHit|equip|armor)\s*=\s*[^;\n]*\blocal\w*\b/;
  for (const f of fs.readdirSync(testDir).filter((n) => n.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(testDir, f), 'utf8');
    assert.equal(copy.test(src), false, `${f} assigns a local target's field to another entity`);
    assert.equal(/Object\.values\(local\w*\.skills\)/.test(src), false, `${f} copies local skills`);
  }
  for (const f of ['upstreamBodies.mjs', 'upstreamBodyWorker.mjs']) {
    const src = fs.readFileSync(path.join(testDir, 'harness', f), 'utf8');
    assert.equal(/from\s+['"][^'"]*\/src\//.test(src) || /\.\.\/\.\.\/src/.test(src), false, `${f} imports nothing from src/`);
  }

  // 2. Changing a local target definition moves only the local side. Built under a different boot
  //    (Meaner Monsters' rows, as the pre-2.8 harness minted them), the local Iron Atronach is level
  //    21; the oracle's body is unchanged, and the comparison fails.
  const before = (await upstreamBody({ kind: 'standIn', mobile: 36 })).body;
  const noDex = { pcaao: true, meanerMonsters: true, enemyExpansion: false };
  const wrong = standInTarget(36, { boot: noDex });
  assert.equal(wrong.level, 21);
  const after = (await upstreamBody({ kind: 'standIn', mobile: 36 })).body;
  assert.deepEqual(after, before, 'the oracle body did not move');
  assert.deepEqual(compareBody(wrong, after).map((d) => d.field), ['level'], 'and the changed local body is caught');
  assert.deepEqual(compareBody(enemyTarget(7, { boot: noDex }), (await upstreamBody({ kind: 'mint', mobile: 7 })).body).map((d) => d.field), ['armorValues']);

  // 3. Editing the table in THIS realm reaches neither side: the local body reads the frozen shipped
  //    table, and the oracle mints in its own realm.
  const u = await upstream();
  const row = u.enemyBasics.ENEMY_BASICS[36];
  const was = row.level;
  row.level = 99;
  try {
    assert.equal(standInTarget(36).level, 16, 'the local body reads VANILLA_ENEMY_BASICS');
    assert.equal((await upstreamBody({ kind: 'standIn', mobile: 36 })).body.level, 16, 'the oracle realm has its own table');
  } finally {
    row.level = was;
  }
});
