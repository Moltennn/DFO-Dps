/*
 * test/fight.test.js - Stage 2.12a: the whole-fight evaluation of health-dependent damage.
 *
 * The three foe-health effects and where upstream reads them:
 *   axe / blunt mastery   systems/weaponMastery.js:118-126  `share(target)` against WEAPON_HALF_LINE (0.5), the climb's
 *                         halves' rate below / above it
 *   venom                 systems/loot/lootPowers.js:320    `share(target) < 0.5` doubles the flat
 *   execute               systems/loot/lootPowers.js:329    `share(target) < p.below/100` adds pct
 * `share` is `combat/healthShare.js:24-40` - `health / maxHealth`. Each is read where it already was (the weapon-blow
 * modifiers / lootBlow), so the fight only changes the SHARE the blow sees.
 *
 * Sections 1-5 are differential: upstream's own functions on a body whose health is set, or the worn-item blow sampled
 * at that share. Section 6 is the whole fight: a seeded blow-by-blow where health really falls, against the walk in
 * src/fight.js. Section 7 checks that a what-if enters the fight as its equipped item does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, weaponOf, masteryPct, referenceFoe } from '../src/model.js';
import { standInTarget } from '../src/target.js';
import { fight, healthThresholds } from '../src/fight.js';
import { maxCharacter, maxRun } from '../src/maxprofile.js';
import { upstream, pcaaoModules, playerEntity } from './harness/upstream.mjs';
import { upstreamBody } from './harness/upstreamBodies.mjs';
import { character, simCharacter, upstreamEntity, weapon, upstreamWeapon } from './harness/fixtures.mjs';
import { sampleWorn } from './harness/outcomes.mjs';
import { generator } from './harness/prng.mjs';
import { weaponPastPct } from '../vendor/upstream/a3eb1605/src/systems/weaponMastery.js';
import { powerOf } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';

const DRAWS = 200000;
const SHARES = [0.9, 0.75, 0.6, 0.5, 0.49, 0.4, 0.2];
const Z = 3.5;
/**
 * An upstream body of the gate's stand-in with its health at `share` (a fresh body: nothing carries over). `relayHealth`
 * is cleared so `combat/healthShare.js` reads `health / maxHealth` from the body itself: a relay body's share is its
 * owner's word (the caller's `healthShare` in the model), and the stand-in's placeholder health would read as whole.
 */
const bodyAt = (body, share) => ({ ...body, relayHealth: false, health: share * body.maxHealth, maxHealth: body.maxHealth });

test('1. axe and blunt mastery across the half line equal upstream\'s own weaponPastPct, exactly', () => {
  for (const [label, tpl, skill] of [['axe (127)', 127, 31], ['blunt (126)', 126, 32]]) {
    const desc = character({ level: 1, raceId: 1, online: true, masterSkills: true, mastered: [skill], skills: 0, skillOverride: { [skill]: 130 } });
    const ch = simCharacter(desc, weapon(tpl, { material: 9 }));
    const w = weaponOf(weapon(tpl, { material: 9 }));
    const ent = playerEntity({ level: 1, skills: { [skill]: 130 } });
    Object.assign(ent, { isPlayer: true, masterSkills: true, masteredSkills: [skill], _online: true });
    for (const share of SHARES) {
      const up = weaponPastPct(upstreamWeapon(weapon(tpl, { material: 9 })), ent, { isPlayer: false, health: share * 100, maxHealth: 100 }, { online: true });
      assert.equal(masteryPct(ch, w, {}, { healthShare: share }), up, `${label} at ${share}`);
    }
    // the halves: paid below 0.5 for the axe, at and above for the blunt (the boundary itself included)
    const at = (share) => masteryPct(ch, w, {}, { healthShare: share });
    if (skill === 31) assert.ok(at(0.49) > 0 && at(0.5) === 0, 'axe pays only under half');
    else assert.ok(at(0.5) > 0 && at(0.49) === 0, 'blunt pays at and above half');
  }
});

test('2. venom is doubled below the half line - each share against the worn-item blow', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 150, 34: 30 } });
  const item = weapon(121, { material: 9 });
  const fields = { rarity: 'rare', imprint: 'tsaesci-fang' };
  const local = { ...item, ...fields };
  for (const [i, share] of SHARES.entries()) {
    const up = sampleWorn(u, { attacker: upstreamEntity(desc), body: bodyAt(body, share), item, fields, seed: 0x8100 + i * 53, draws: DRAWS });
    const r = analyze(simCharacter(desc, local), { target: standInTarget(31), core: 'overhaul', weapon: weaponOf(local), healthShare: share, swing: 'StrikeLeft' });
    const z = (r.perSwing - up.mean) / up.se;
    assert.ok(Math.abs(z) < Z, `venom at ${share}: local ${r.perSwing.toFixed(4)} vs upstream ${up.mean.toFixed(4)} +/- ${(1.96 * up.se).toFixed(4)} (z ${z.toFixed(2)})`);
  }
});

test('3. execute around its threshold (Sweet Mother\'s Kiss: below 25%)', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 150, 34: 30 } });
  const item = weapon(121, { material: 9 });
  const fields = { rarity: 'legendary', legendary: 'night-mothers-embrace' };
  const local = { ...item, ...fields };
  for (const [i, share] of [0.4, 0.3, 0.25, 0.24, 0.1].entries()) {
    const up = sampleWorn(u, { attacker: upstreamEntity(desc), body: bodyAt(body, share), item, fields, seed: 0x8200 + i * 67, draws: DRAWS });
    const r = analyze(simCharacter(desc, local), { target: standInTarget(31), core: 'overhaul', weapon: weaponOf(local), healthShare: share, swing: 'StrikeLeft' });
    const z = (r.perSwing - up.mean) / up.se;
    assert.ok(Math.abs(z) < Z, `execute at ${share}: local ${r.perSwing.toFixed(4)} vs upstream ${up.mean.toFixed(4)} +/- ${(1.96 * up.se).toFixed(4)} (z ${z.toFixed(2)})`);
  }
  // the threshold is in the fight's segment list (0.25), beside the constant 0.5
  assert.deepEqual(healthThresholds([powerOf('night-mothers-embrace')]), [1, 0.5, 0.25, 0]);
});

test('4. the attacker-health effects do not move with the foe\'s health (rage and Berserker)', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 150, 34: 30 } });
  const item = weapon(121, { material: 9 });
  const fields = { rarity: 'legendary', legendary: 'gortwogs-cleaver' };
  const local = { ...item, ...fields };
  for (const [i, [attackerShare, foeShare]] of [[0.2, 0.9], [0.2, 0.3], [0.6, 0.9], [0.6, 0.3]].entries()) {
    const attacker = upstreamEntity(desc);
    attacker.health = attackerShare * attacker.maxHealth;
    const up = sampleWorn(u, { attacker, body: bodyAt(body, foeShare), item, fields, seed: 0x8300 + i * 29, draws: DRAWS });
    const r = analyze(simCharacter(desc, local), { target: standInTarget(31), core: 'overhaul', weapon: weaponOf(local), healthShare: foeShare, attackerHealthShare: attackerShare, swing: 'StrikeLeft' });
    const z = (r.perSwing - up.mean) / up.se;
    assert.ok(Math.abs(z) < Z, `rage ${attackerShare} at foe ${foeShare}: local ${r.perSwing.toFixed(4)} vs upstream ${up.mean.toFixed(4)} (z ${z.toFixed(2)})`);
  }
  // the fight varies ONLY the foe's health: the attacker's declaration is the same in every segment
  const f = fight(simCharacter(desc, local), { target: standInTarget(31), health: 12000, core: 'overhaul', weapon: weaponOf(local), attackerHealthShare: 0.2 });
  assert.ok(f.segments.every((s) => {
    const r = analyze(simCharacter(desc, local), { target: standInTarget(31), core: 'overhaul', weapon: weaponOf(local), healthShare: s.share, attackerHealthShare: 0.2 });
    return r.perSwing === s.perSwing;
  }), 'each segment is the blow at that share with the declared attacker health');
  // and the attacker's own condition fires identically in both segments
  const hi = f.segments[0];
  const lo = f.segments[f.segments.length - 1];
  assert.ok(hi.perSwing / analyze(simCharacter(desc, local), { target: standInTarget(31), core: 'overhaul', weapon: weaponOf(local), healthShare: hi.share, attackerHealthShare: 1 }).perSwing > 1.25);
  assert.ok(lo.perSwing / analyze(simCharacter(desc, local), { target: standInTarget(31), core: 'overhaul', weapon: weaponOf(local), healthShare: lo.share, attackerHealthShare: 1 }).perSwing > 1.25);

  // Berserker's Frenzy is the same kind of term (martialPowers.js:217): the wielder's share, declared for the fight
  const bers = { ...desc, martialPath: 'berserker', masterSkills: true };
  const at = (attackerShare, foeShare) => analyze(simCharacter(bers, local), {
    target: standInTarget(31), core: 'overhaul', weapon: weaponOf(local), healthShare: foeShare, attackerHealthShare: attackerShare,
  }).dps;
  assert.ok(at(0.3, 0.75) > at(1, 0.75) * 1.15, 'Frenzy pays below half the WIELDER\'s health');
  assert.equal(at(0.3, 0.75), at(0.3, 0.25), 'and the foe\'s health does not move it');
});

test('5. the thresholds compose with critical hits, the trait and the cap', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 26: 100, 34: 100 } }); // crit 100
  const item = weapon(126, { material: 9 });
  const fields = { rarity: 'rare', imprint: 'tsaesci-fang' };
  const local = { ...item, ...fields };
  const traits = ['stoneskin'];
  for (const [i, [share, cap]] of [[0.7, 0], [0.3, 0], [0.7, 9], [0.3, 9]].entries()) {
    const up = sampleWorn(u, {
      attacker: upstreamEntity(desc), body: bodyAt(body, share), item, fields, seed: 0x8400 + i * 41, draws: DRAWS,
      after: (d) => {
        const t = u.bossTraits.bossStrike({ bossTraits: traits }, d, { kind: 'melee', weapon: upstreamWeapon(item) }).damage;
        return cap > 0 ? Math.min(t, cap) : t;
      },
    });
    const r = analyze(simCharacter(desc, local), { target: { ...standInTarget(31), bossTraits: traits, hitCap: cap }, core: 'overhaul', weapon: weaponOf(local), healthShare: share, swing: 'StrikeLeft' });
    const mine = cap > 0 ? r.cappedPerSwing : r.perSwing;
    const z = (mine - up.mean) / up.se;
    assert.ok(Math.abs(z) < Z, `venom crit100 stoneskin at ${share}, cap ${cap}: ${mine.toFixed(4)} vs ${up.mean.toFixed(4)} (z ${z.toFixed(2)})`);
  }
});

test('6. a whole fight where the health really falls: the walk against a seeded blow-by-blow', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const { body: template } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 150, 34: 30 } });
  const item = weapon(121, { material: 9 });
  const fields = { rarity: 'rare', imprint: 'tsaesci-fang' }; // venom: the blow changes at half health
  const local = { ...item, ...fields };
  const R = 8;
  const f = fight(simCharacter(desc, local), { target: standInTarget(31), health: R * 325, core: 'overhaul', weapon: weaponOf(local) });
  assert.ok(f, 'the walk terminates');
  assert.equal(f.segments.length, 2, 'one segment above half, one below');
  // upstream: health really falls, blow by blow, each struck at the share that stands
  const reps = [];
  for (let k = 0; k < 300; k++) {
    const body = bodyAt(template, 1);
    body.maxHealth = body.health = R * 325;
    const attacker = upstreamEntity(desc);
    const slot = u.equip.equipTableOf(attacker); // the weapon must be worn by THIS entity: wornPowers reads its table
    const rng = generator(0x8500 + k * 131);
    let blows = 0;
    let seconds = 0;
    const aps = f.snapshot.cadence.aps; // the cadence is verified separately (swing law); this test is the damage walk
    while (body.health > 0 && blows < 100000) {
      const w = { ...upstreamWeapon(item), ...fields };
      slot[u.equip.EQUIP_SLOTS.RightHand] = w;
      const d = u.pcaao.pcaaoAttackDamage(attacker, body, { weapon: w, rolls: rng, modules, backstabChance: 0 });
      body.health -= d;
      blows += 1;
      seconds += 1 / aps;
    }
    slot[u.equip.EQUIP_SLOTS.RightHand] = null;
    reps.push(seconds);
  }
  const mean = reps.reduce((a, b) => a + b, 0) / reps.length;
  const sd = Math.sqrt(reps.reduce((a, b) => a + (b - mean) ** 2, 0) / (reps.length - 1));
  const se = sd / Math.sqrt(reps.length);
  const z = (f.ttk - mean) / se;
  assert.ok(Math.abs(z) < 4, `whole fight: walk ${f.ttk.toFixed(3)} s vs upstream mean ${mean.toFixed(3)} +/- ${(1.96 * se).toFixed(3)} (z ${z.toFixed(2)})`);
  // and the fight is neither snapshot: the venom half is faster than the whole-fight figure above, slower below
  const snap = f.snapshot.dps;
  const hi = analyze(simCharacter(desc, local), { target: standInTarget(31), core: 'overhaul', weapon: weaponOf(local), healthShare: 0.75 }).dps;
  const lo = analyze(simCharacter(desc, local), { target: standInTarget(31), core: 'overhaul', weapon: weaponOf(local), healthShare: 0.25 }).dps;
  assert.ok(lo > hi * 1.05, 'venom pays below half (the segments differ)');
  // venom pays below half, so the fight is faster than the full-health snapshot and slower than an all-low-half one
  assert.ok(f.dps > snap, `the whole-fight rate (${f.dps.toFixed(1)}) is above the full-health snapshot (${snap.toFixed(1)})`);
  assert.ok(f.dps < lo, `and below the low-half rate (${lo.toFixed(1)})`);
});

test('7. a fight what-if is the equipped item: an execute priced equals the item carrying it', () => {
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 150, 34: 30 } });
  const base = local(121, {});
  const target = standInTarget(31);
  const f0 = fight(simCharacter(desc, base), { target, health: 12000, core: 'overhaul', weapon: weaponOf(base) });
  const priced = f0.with({ imprint: powerOf('night-mothers-embrace') });
  const carried = fight(simCharacter(desc, local(121, { imprint: 'night-mothers-embrace' })), { target, health: 12000, core: 'overhaul', weapon: weaponOf(local(121, { imprint: 'night-mothers-embrace' })) });
  assert.equal(priced.ttk, carried.ttk);
  assert.equal(priced.dps, carried.dps);
  assert.deepEqual(priced.segments.map((s) => [s.hi, s.lo, s.share]), carried.segments.map((s) => [s.hi, s.lo, s.share]));
  // pricing the power it already carries is no change (upstream counts a power once)
  assert.equal(carried.with({ imprint: powerOf('night-mothers-embrace') }).ttk, carried.ttk);
  // a build with no foe-health effect has one blow per segment: the fight is the snapshot rate plus the kill blow
  const plain = fight(simCharacter(desc, base), { target, health: 12000, core: 'overhaul', weapon: weaponOf(base) });
  assert.equal(plain.segments.length, 2);
  assert.equal(plain.segments[0].perSwing, plain.segments[1].perSwing);
});

const local = (tpl, spec = {}) => ({
  ...weapon(tpl, { material: 9 }), ...(spec.imprint ? { rarity: 'rare', imprint: spec.imprint } : {}),
});
