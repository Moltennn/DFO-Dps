/*
 * test/longBow.test.js - Stage 2.9: the shaft's pull is applied to the finished blow.
 *
 * combat/arrowFlight.js:501-510 (full checkout; shaftOnRelayBody / playerArrowHitFoe) takes the number
 * calculateAttackDamage returns - crit, material requirement, condition, the shield and armour, the off
 * hand's share all done - and hands it to bowFastDamage (combat/bowBloom.js:73-79:
 * `max(1, round(dmg * pull * (100 - 20k) / 100))`); the boss's trait and the relay cap come after. The long
 * bow (template 130) pulls x1.5, the short bow (129) x1. Before Stage 2.9 the pull sat inside the weapon
 * blow, before the crit, material, condition and armour: -0.93% .. +0.29% per swing (audit F3).
 *
 * Outcomes are compared value by value (test/harness/outcomes.mjs) and per swing, against upstream's own
 * body; the host's steps are applied on the oracle side by upstream's own functions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, blowDistribution, weaponOf } from '../src/model.js';
import { enemyTarget, equipArmour, standInTarget } from '../src/target.js';
import { upstream, pcaaoModules } from './harness/upstream.mjs';
import { oracleEntity, upstreamBody, upstreamWear } from './harness/upstreamBodies.mjs';
import { character, simCharacter, weapon, upstreamWeapon, fresh } from './harness/fixtures.mjs';
import { compareDistributions, sampleUpstream, worst } from './harness/outcomes.mjs';

const CLASS_CAREER = Object.freeze({ strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50, hitPointsPerLevel: 8 });
const DAEDRIC = [102, 103, 104, 105, 106, 107, 108].map((templateIndex) => ({ templateIndex, material: 521, condition: 1 }));
const DRAWS = 250000;
const Z_MAX = 4.5; // fixed before the run

const CASES = [
  { id: 'long bow, ordinary (boss body)', tpl: 130, body: 'boss', cond: 1, crit: 40, traits: [], cap: 0, spam: false },
  { id: 'long bow, 5.9% condition', tpl: 130, body: 'boss', cond: 0.059, crit: 40, traits: [], cap: 0, spam: false },
  { id: 'long bow, crit 100', tpl: 130, body: 'boss', cond: 1, crit: 100, traits: [], cap: 0, spam: false },
  { id: 'long bow vs a full daedric class foe', tpl: 130, body: 'daedric', cond: 1, crit: 40, traits: [], cap: 0, spam: false },
  { id: 'long bow, bladeturning boss, binding cap 12', tpl: 130, body: 'boss', cond: 1, crit: 40, traits: ['bladeturning'], cap: 12, spam: false },
  { id: 'long bow, stoneskin (arrows unaffected), cap 600', tpl: 130, body: 'boss', cond: 1, crit: 40, traits: ['stoneskin'], cap: 600, spam: false },
  { id: 'long bow, fast-shot stacks held (x0.2)', tpl: 130, body: 'boss', cond: 1, crit: 40, traits: [], cap: 0, spam: true },
  { id: 'control: short bow (pull 1), daedric foe', tpl: 129, body: 'daedric', cond: 1, crit: 40, traits: [], cap: 0, spam: false },
  { id: 'control: katana, daedric foe', tpl: 121, body: 'daedric', cond: 1, crit: 40, traits: [], cap: 0, spam: false },
];

async function setup(u) {
  const { body: boss } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const { body: klass } = await upstreamBody({ kind: 'mint', mobile: 128, career: CLASS_CAREER, playerLevel: 30 });
  const { BOW_FAST } = u.bowBloom;
  return { boss, klass, BOW_FAST };
}

function build(u, c, { boss, klass, BOW_FAST }) {
  const skill = c.tpl === 121 ? 29 : 33;
  const desc = character({ level: 30, raceId: 1, stats: { strength: 70, agility: 70, speed: 70, luck: 50 }, skills: 0, skillOverride: { [skill]: 120, 34: c.crit } });
  const item = weapon(c.tpl, { material: 9, condition: c.cond });
  const body = c.body === 'boss' ? boss : upstreamWear(u, oracleEntity(klass), DAEDRIC);
  const local = c.body === 'boss' ? standInTarget(31) : enemyTarget(128, { level: 30, career: CLASS_CAREER });
  if (c.body !== 'boss') equipArmour(local, DAEDRIC, { armorValues: true });
  const pull = u.bowBloom.bowKindOf(upstreamWeapon(item)).pull;
  const shot = { pull, fast: c.spam ? BOW_FAST.most : 0 };
  const kind = c.tpl === 121 ? 'melee' : 'arrow';
  const after = (d) => {
    const pulled = c.tpl === 121 ? d : u.bowBloom.bowFastDamage(shot, d); // arrowFlight.js:501-510
    const t = c.traits.length ? u.bossTraits.bossStrike({ bossTraits: c.traits }, pulled, { kind, weapon: fresh(upstreamWeapon(item)) }).damage : pulled;
    return c.cap > 0 ? Math.min(t, c.cap) : t;
  };
  return { desc, item, body, local, after, pull };
}

test('long bow: the pull sits after the finished blow - outcome by outcome against upstream', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const ctx = await setup(u);
  const mutantsCaught = [];
  for (const [index, c] of CASES.entries()) {
    const { desc, item, body, local, after, pull } = build(u, c, ctx);
    assert.equal(pull, c.tpl === 130 ? 1.5 : 1, `${c.id}: the pull upstream reads for this template`);
    const r = analyze(simCharacter(desc, item), { target: local, core: 'overhaul', weapon: weaponOf(item), bowSpam: c.spam });
    const sample = sampleUpstream(u, modules, { desc, item, body, seed: 0x2a00 + index * 733, draws: DRAWS, after });
    const dist = Array.from({ length: 7 }, (_, part) => blowDistribution(r.damage.plainRolls, part, { target: local, weapon: r.weapon, traits: c.traits, cap: c.cap, bowSpam: c.spam }));
    const gaps = compareDistributions(sample, dist);
    assert.ok(gaps.length >= 8, `${c.id}: values compared (${gaps.length})`);
    const bad = worst(gaps);
    assert.ok(Math.abs(bad.z) < Z_MAX, `${c.id}: part ${bad.part} value ${bad.value}: upstream ${bad.c} of ${sample.counts[bad.part]}, local p ${bad.p.toFixed(5)}, z ${bad.z.toFixed(1)}`);
    // The mutant: the pull applied to the card roll BEFORE the defence (the pre-2.9 position, for the part
    // of it a card roll can express), then the trait and the cap.
    if (c.tpl === 130 && (c.body === 'daedric' || c.traits.length)) {
      const early = r.damage.plainRolls.map((d) => Math.max(1, Math.round(d * pull * (c.spam ? 0.2 : 1))));
      const legacy = Array.from({ length: 7 }, (_, part) => blowDistribution(early, part, { target: local, weapon: { ...r.weapon, ranged: false }, traits: c.traits, cap: c.cap }));
      if (Math.abs(worst(compareDistributions(sample, legacy)).z) >= Z_MAX) mutantsCaught.push(c.id);
    }
  }
  assert.ok(mutantsCaught.length >= 2, `the early-pull order is rejected on: ${mutantsCaught.join('; ') || 'nothing'}`);
});

test('long bow: per-swing means (crits included) against upstream, and the controls are untouched', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const ctx = await setup(u);
  for (const [index, c] of CASES.entries()) {
    const { desc, item, body, local, after } = build(u, c, ctx);
    const target = { ...local, bossTraits: c.traits, hitCap: c.cap };
    const r = analyze(simCharacter(desc, item), { target, core: 'overhaul', weapon: weaponOf(item), bowSpam: c.spam });
    const s = sampleUpstream(u, modules, { desc, item, body, seed: 0x2a80 + index * 311, draws: DRAWS, after });
    const mine = c.cap > 0 ? r.cappedPerSwing : r.perSwing;
    const z = (mine - s.mean) / s.se;
    assert.ok(Math.abs(z) < 3.5, `${c.id}: ${mine.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)} (z ${z.toFixed(2)})`);
  }
});

test('long bow: the card shows the pulled blow, the rolls stay the card\'s own', () => {
  const desc = character({ level: 30, raceId: 1, stats: { strength: 70, agility: 70, speed: 70, luck: 50 }, skills: 0, skillOverride: { 33: 120, 34: 40 } });
  const long = analyze(simCharacter(desc, weapon(130, { material: 9 })), { target: standInTarget(31), core: 'overhaul' });
  assert.deepEqual(long.damage.bow, { pull: 1.5, fast: 0 });
  assert.ok(long.damage.max > Math.max(...long.damage.plainRolls), 'the displayed maximum is the pulled one');
  const short = analyze(simCharacter(desc, weapon(129, { material: 9 })), { target: standInTarget(31), core: 'overhaul' });
  assert.equal(short.damage.max, Math.max(...short.damage.plainRolls), 'a short bow pulls x1');
});
