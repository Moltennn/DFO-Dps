/*
 * test/berserker.test.js - Stage 2.9: Berserker's Frenzy reads the BERSERKER's health (audit F5 / H2-023).
 *
 * systems/martialPowers.js:216-218 `case 'berserker': if (share(attacker) < N.frenzy.below) pct += N.frenzy.pct`
 * and :274-276 martialPace `share(e) < N.frenzy.below ? N.frenzy.pace`, with N.frenzy = { below: 0.5, pct: 20,
 * pace: 10 } (systems/martialPaths.js:71) and `share` = combat/healthShare.js healthShare: the body's
 * `health / maxHealth` (1 where it says none; the relay's word for a relay body, which a player is not).
 * The comparison is strict (`< 0.5`). The foe's share is read by other powers (Axe, Blunt Weapon, execute),
 * never by Frenzy.
 *
 * Before Stage 2.9 the local model read the FOE's share (`opts.healthShare`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, martialBlowPct, martialPace, weaponOf } from '../src/model.js';
import { standInTarget } from '../src/target.js';
import { upstream, pcaaoModules, playerEntity } from './harness/upstream.mjs';
import { upstreamBody } from './harness/upstreamBodies.mjs';
import { character, simCharacter, weapon, upstreamWeapon, fresh } from './harness/fixtures.mjs';
import { generator } from './harness/prng.mjs';

/** An upstream player holding Berserker with `health` of `maxHealth`, folded by upstream's own functions. */
function berserker(u, { health = 100, maxHealth = 100, level = 30, skills = {}, stats = {} } = {}) {
  const e = playerEntity({ level, raceId: 1, stats, skills });
  e.martialPath = 'berserker';
  e.masterSkills = true;
  e.masteredSkills = [...u.martialPaths.MARTIAL_BY_ID.berserker.skills];
  e.health = health;
  e.maxHealth = maxHealth;
  u.entityMods.computeEntityMods(e);
  return e;
}
const foe = (health, maxHealth) => ({ isPlayer: false, health, maxHealth, mobileType: 31, careerIndex: 31 });
const SHARES = [1, 0.75, 0.51, 0.5, 0.49, 0.25, 0.01];

test('Frenzy: the premise - upstream reads the attacker\'s share, strictly below one half', async () => {
  const u = await upstream();
  assert.deepEqual({ ...u.martialPaths.MARTIAL_NUMBERS.frenzy }, { below: 0.5, pct: 20, pace: 10 });
  const hurt = berserker(u, { health: 40 });
  assert.equal(u.martialPowers.martialBlowPct(hurt, foe(100, 100)), 20, 'attacker at 40%, foe whole: +20');
  assert.equal(u.martialPowers.martialBlowPct(berserker(u), foe(10, 100)), 0, 'attacker whole, foe at 10%: nothing');
  assert.equal(u.martialPowers.martialBlowPct(berserker(u, { health: 50 }), foe(100, 100)), 0, 'exactly half is not below half');
});

test('Frenzy: blow and pace over the attacker-share x foe-share grid equal upstream\'s own functions', async () => {
  const u = await upstream();
  let n = 0;
  for (const mine of SHARES) {
    for (const theirs of SHARES) {
      const e = berserker(u, { health: mine * 1000, maxHealth: 1000 });
      const f = foe(theirs * 1000, 1000);
      const ch = { martialPath: 'berserker' };
      const opts = { attackerHealthShare: mine, healthShare: theirs };
      assert.equal(martialBlowPct(ch, f, opts), u.martialPowers.martialBlowPct(e, f), `blow: self ${mine}, foe ${theirs}`);
      assert.equal(martialPace(ch, opts), u.martialPowers.martialPace({ entity: e }), `pace: self ${mine}, foe ${theirs}`);
      n++;
    }
  }
  assert.equal(n, SHARES.length ** 2);
});

test('Frenzy: changing the FOE\'s health alone never moves the Berserker\'s component; changing the attacker\'s does', () => {
  const ch = { martialPath: 'berserker' };
  for (const mine of [1, 0.4]) {
    const seen = new Set();
    for (const theirs of SHARES) {
      seen.add(martialBlowPct(ch, {}, { attackerHealthShare: mine, healthShare: theirs }));
      seen.add(martialPace(ch, { attackerHealthShare: mine, healthShare: theirs }) + 1000);
    }
    assert.equal(seen.size, 2, `attacker at ${mine}: one blow value and one pace value whatever the foe's health`);
  }
  assert.equal(martialBlowPct(ch, {}, { attackerHealthShare: 0.4 }), 20);
  assert.equal(martialBlowPct(ch, {}, { attackerHealthShare: 1 }), 0);
  assert.equal(martialBlowPct(ch, {}, {}), 0, 'the default is full health (the assumptions register M5)');
  // The foe-reading powers still read the foe: Axe/Blunt mastery (weaponMastery.js:16-18) is untouched.
});

test('Frenzy end to end: sampled blows with the four health combinations', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const item = weapon(121, { material: 9 });
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 120, 34: 30 }, martialPath: 'berserker', masterSkills: true });
  const DRAWS = 200000;
  const combos = [
    { id: 'attacker healthy, foe injured', self: 1, foe: 0.2 },
    { id: 'attacker injured, foe healthy', self: 0.3, foe: 1 },
    { id: 'both healthy', self: 1, foe: 1 },
    { id: 'both injured', self: 0.3, foe: 0.2 },
  ];
  const means = {};
  for (const [index, c] of combos.entries()) {
    const e = berserker(u, { health: c.self * 1000, maxHealth: 1000, level: 30, skills: { 29: 120, 34: 30 }, stats: { strength: 80, agility: 80, speed: 80, luck: 50 } });
    const target = { ...body, health: c.foe * 1000, maxHealth: 1000 };
    const rng = generator(0x2c00 + index * 131);
    let sum = 0; let sq = 0;
    for (let i = 0; i < DRAWS; i++) {
      const d = u.pcaao.pcaaoAttackDamage(e, target, { weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0 });
      sum += d; sq += d * d;
    }
    const m = sum / DRAWS;
    const se = Math.sqrt((sq / DRAWS - m * m) / DRAWS);
    const target31 = standInTarget(31);
    const r = analyze(simCharacter(desc, item), { target: target31, core: 'overhaul', weapon: weaponOf(item), attackerHealthShare: c.self, healthShare: c.foe });
    const z = (r.perSwing - m) / se;
    means[c.id] = { up: m, local: r.perSwing };
    assert.ok(Math.abs(z) < 3.5, `${c.id}: ${r.perSwing.toFixed(4)} vs ${m.toFixed(4)} +/- ${(1.96 * se).toFixed(4)} (z ${z.toFixed(2)})`);
  }
  // Frenzy is in the oracle at all: the injured berserker hits harder than the healthy one, the foe's health is irrelevant.
  assert.ok(means['attacker injured, foe healthy'].up > means['both healthy'].up * 1.1);
  assert.ok(Math.abs(means['attacker healthy, foe injured'].up / means['both healthy'].up - 1) < 0.01);
});
