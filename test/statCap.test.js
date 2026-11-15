/*
 * test/statCap.test.js - Stage 2.9: Light Step / Windborne are summed BEFORE the stat ceiling.
 *
 * systems/martialPowers.js:364-375 martialFold writes the path's +10 into `_mods.stats` (Shadowdancer's
 * Light Step: Agility; Windrunner's Windborne: Speed); systems/entityMods.js:160-185 computeEntityMods sums
 * every fold onto `entity._mods`; systems/statMods.js:121-141 liveStat returns
 * `min(max(base + mod, 0), 100 + statMax)`. A base of 95 with Light Step is therefore 100. Before Stage 2.9
 * the bonus was added to the ALREADY clamped value (105) - hit chance +1 .. +3 for a base near the ceiling
 * (audit F4).
 *
 * The oracle builds an entity upstream recognises as holding the path (isPlayer, martialPath, Master Skills
 * in force, both of the path's skills mastered - martialPaths.js:874-886 martialHeld), lets upstream's own
 * folds compute its `_mods`, and reads upstream's own liveStat. Nothing local is handed to it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, combatStat, hitModel, weaponOf } from '../src/model.js';
import { standInTarget } from '../src/target.js';
import { upstream, pcaaoModules, playerEntity } from './harness/upstream.mjs';
import { upstreamBody } from './harness/upstreamBodies.mjs';
import { character, simCharacter, weapon, upstreamWeapon, fresh } from './harness/fixtures.mjs';
import { generator } from './harness/prng.mjs';

const BASES = [40, 85, 89, 90, 91, 95, 99, 100];
const PATHS = [null, 'shadowdancer', 'windrunner'];

/** An upstream entity that HOLDS the path, with `_mods` folded by upstream's own registered folds. */
function upstreamHolder(u, { path, stats, statMax = {}, level = 30, skills = {} }) {
  const entity = playerEntity({ level, raceId: 1, stats, skills });
  if (path) {
    entity.martialPath = path;
    entity.masterSkills = true;
    entity.masteredSkills = [...u.martialPaths.MARTIAL_BY_ID[path].skills];
  }
  u.entityMods.computeEntityMods(entity);
  for (const [k, v] of Object.entries(statMax)) entity._mods.statMax[k] = v;
  return entity;
}
function localHolder(path, stats, statMax = {}, extra = {}) {
  const desc = character({ level: 30, raceId: 1, stats, skills: 0, martialPath: path, masterSkills: !!path, mastered: path ? [] : [], ...extra });
  const ch = simCharacter(desc, null);
  ch._mods = { ...(ch._mods ?? {}), stats: { ...(ch._mods?.stats ?? {}) }, statMax: { ...statMax } };
  return { ch, desc };
}

test('upstream really folds the path into _mods.stats and clamps after it (the premise)', async () => {
  const u = await upstream();
  const e = upstreamHolder(u, { path: 'shadowdancer', stats: { agility: 95, speed: 95 } });
  assert.equal(e._mods.stats.agility, 10, 'martialFold: Light Step +10 Agility');
  assert.equal(e._mods.stats.speed ?? 0, 0);
  assert.equal(u.statMods.liveStat(e, 'agility'), 100, '95 + 10 clamps at 100, not 105');
  assert.equal(u.statMods.liveStat(upstreamHolder(u, { path: 'windrunner', stats: { speed: 95 } }), 'speed'), 100);
  // A path that is not held (skills not mastered) folds nothing.
  const unheld = playerEntity({ stats: { agility: 50 } });
  unheld.martialPath = 'shadowdancer';
  assert.deepEqual(u.entityMods.computeEntityMods(unheld).stats, {});
});

test('the combat stat equals upstream liveStat: every base x path, with and without a raised ceiling', async () => {
  const u = await upstream();
  let compared = 0;
  for (const path of PATHS) {
    for (const base of BASES) {
      for (const statMax of [{}, { agility: 5, speed: 5 }]) {
        const stats = { agility: base, speed: base, strength: base, luck: base };
        const e = upstreamHolder(u, { path, stats, statMax });
        const { ch } = localHolder(path, stats, statMax);
        for (const name of ['agility', 'speed', 'strength', 'luck']) {
          assert.equal(combatStat(ch, name), u.statMods.liveStat(e, name), `${path ?? 'no path'}, base ${base}, statMax ${JSON.stringify(statMax)}, ${name}`);
          compared++;
        }
      }
    }
  }
  assert.equal(compared, 3 * 8 * 2 * 4);
  // The cases that distinguish the orders: a base near the ceiling.
  const e = upstreamHolder(u, { path: 'shadowdancer', stats: { agility: 95 } });
  assert.equal(combatStat(localHolder('shadowdancer', { agility: 95 }).ch, 'agility'), u.statMods.liveStat(e, 'agility'));
  assert.equal(combatStat(localHolder('shadowdancer', { agility: 95 }).ch, 'agility'), 100);
  assert.equal(combatStat(localHolder('shadowdancer', { agility: 95 }, { agility: 5 }).ch, 'agility'), 105, 'a raised ceiling keeps the bonus up to it');
  // A path's stat only moves its own stat.
  assert.equal(combatStat(localHolder('shadowdancer', { speed: 90 }).ch, 'speed'), 90);
  assert.equal(combatStat(localHolder('windrunner', { agility: 90 }).ch, 'agility'), 90);
  // passiveOn:false (the path asleep) adds nothing.
  assert.equal(combatStat(localHolder('shadowdancer', { agility: 70 }).ch, 'agility', { passiveOn: false }), 70);
});

test('hit chance with the path, sampled through upstream pcaaoAttackDamage, below the 97% ceiling', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const item = weapon(121, { material: 6 });
  const cases = [];
  for (const [path, stat] of [['shadowdancer', 'agility'], ['windrunner', 'speed']]) {
    for (const base of [80, 95, 100]) cases.push({ path, stat, base });
  }
  const DRAWS = 300000;
  for (const [index, c] of cases.entries()) {
    const stats = { strength: 60, agility: 60, speed: 60, luck: 40, [c.stat]: c.base };
    const e = upstreamHolder(u, { path: c.path, stats, level: 8, skills: { 29: 35, 34: 0 } });
    const rng = generator(0x2b00 + index * 409);
    let hits = 0;
    for (let i = 0; i < DRAWS; i++) {
      if (u.pcaao.pcaaoAttackDamage(e, body, { weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0 }) > 0) hits += 1;
    }
    const rate = hits / DRAWS;
    const se = Math.sqrt(rate * (1 - rate) / DRAWS);
    const desc = character({ level: 8, raceId: 1, stats, skills: 0, skillOverride: { 29: 35, 34: 0 }, martialPath: c.path, masterSkills: true });
    const r = analyze(simCharacter(desc, item), { target: standInTarget(31), core: 'overhaul', weapon: weaponOf(item) });
    assert.ok(rate < 0.9 && rate > 0.1, `${c.path} base ${c.base}: below the ceiling (hit ${rate.toFixed(3)})`);
    assert.ok(Math.abs(r.hit.hit - rate) < 3.5 * se, `${c.path} ${c.stat} ${c.base}: local hit ${r.hit.hit.toFixed(4)} vs upstream ${rate.toFixed(4)} +/- ${(1.96 * se).toFixed(4)}`);
  }
});

test('the other post-clamp stat adds the audit asked about: none shares the order', async () => {
  // Every other source of a stat in the hit path (gear and Firmament channels, effects) is summed inside
  // liveStat (src/save.js, the same `_mods.stats` and `statMax` the upstream function reads). The path's
  // Dodging +15 (martialFold) is read only for a Shadowdancer TARGET's dodge, which no foe is.
  const { ch } = localHolder(null, { agility: 98 });
  ch._mods.stats.agility = 10; // a gear affix: 98 + 10 clamps at 100
  assert.equal(combatStat(ch, 'agility'), 100);
});
