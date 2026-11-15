/*
 * test/gearLines.test.js - Stage 2.11b, Part A: a piece's lines are read the way the game reads them.
 *
 * The audit's finding: the local gear fold skipped upstream's `readLines` and `validAffix`, summed every gem line
 * whole (three perfect diamonds read +36% where the game reads +25: law 6, lootRarity.js:2151-2165), let a
 * repeated element overwrite instead of adding, and trusted lines the game ignores (a 50% slayer, a poison
 * elemental).
 *
 * The oracle builds each item the UPSTREAM way - its own lines, empty sockets, then `setGem` (which lays the gem
 * lines through upstream's `gemLine` and `layGemLines`) - and reads it with upstream's own readers: `affixFold`
 * (stats, skills), `affixWeaponDamage` (the weapon's damage), `lootBlow` (slayer, elemental). The local side gets
 * only the same INPUTS (own lines, a socket list). Nothing computed locally goes to the oracle.
 *
 * Supported line kinds: stat, skill, damage, slayer, elemental (the assumptions register M24); every other kind is an
 * unsupported input that no outgoing weapon blow reads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, weaponBlow, weaponOf, gateTarget } from '../src/model.js';
import { standInTarget } from '../src/target.js';
import { rebuildMods } from '../src/save.js';
import { socketAffixes, socketCount, perfectSockets } from '../src/sockets.js';
import { bladeLines, foldLines, laidLines, weaponDamagePct, validItemLines, socketsFor } from '../src/gearLines.js';
import { maxCharacter, maxRun } from '../src/maxprofile.js';
import { WEAPONS } from '../src/data.js';
import { upstream, pcaaoModules } from './harness/upstream.mjs';
import { upstreamBody } from './harness/upstreamBodies.mjs';
import { character, simCharacter, upstreamEntity, weapon, upstreamWeapon } from './harness/fixtures.mjs';
import { sampleWorn } from './harness/outcomes.mjs';
import { generator } from './harness/prng.mjs';
import * as R from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { lootBlow } from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';

const STATS = R.AFFIX_KINDS.stat.params;
const SKILLS = R.AFFIX_KINDS.skill.params;
const GEMS = R.ALL_GEM_IDS;
const TEMPLATES = [113, 116, 120, 121, 123, 124, 126, 128, 130, 563];

/** A seeded item description: own lines (some illegal on purpose), a socket list of gems. Pure INPUTS. */
function describeItem(rng, template) {
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const own = [];
  const n = Math.floor(rng() * 5);
  for (let i = 0; i < n; i++) {
    const roll = rng();
    if (roll < 0.15) own.push({ id: 'bogus', value: 5 }); // an unknown kind
    else if (roll < 0.3) own.push({ id: 'slayer', param: pick(R.SLAYER_FOES), value: 31 + Math.floor(rng() * 40) }); // above the Legendary band
    else if (roll < 0.4) own.push({ id: 'elemental', param: 'poison', value: 6 }); // not a proc element
    else if (roll < 0.5) own.push({ id: 'stat', param: 'nonsense', value: 5 });
    else if (roll < 0.55) own.push({ id: 'damage', value: 0 }); // below the band: invalid, and a 0
    else if (roll < 0.7) own.push({ id: 'damage', value: 5 + Math.floor(rng() * 21) });
    else if (roll < 0.8) own.push({ id: 'slayer', param: pick(R.SLAYER_FOES), value: 10 + Math.floor(rng() * 21) });
    else if (roll < 0.9) own.push({ id: 'elemental', param: pick(R.PROC_ELEMENTS), value: 1 + Math.floor(rng() * 10) });
    else if (roll < 0.95) own.push({ id: 'stat', param: pick(STATS), value: 5 + Math.floor(rng() * 11) });
    else own.push({ id: 'skill', param: pick(SKILLS), value: 10 + Math.floor(rng() * 21) });
  }
  // sockets mostly hold the SAME gem (that is what a cap bites on), at a mix of grades
  const main = pick(GEMS);
  const sockets = Array.from({ length: Math.floor(rng() * (R.socketMax({ group: 'Weapons', templateIndex: template }) + 1)) }, () => (rng() < 0.7 ? main : pick(GEMS)));
  return { own, sockets };
}
/** The item as THIS project holds it: own lines in `affixes`, the gems in `sockets`. */
const localItem = (t, d) => ({ ...weapon(t, { material: 9 }), rarity: 'rare', affixes: d.own.map((a) => ({ ...a })), ...(d.sockets.length ? { sockets: [...d.sockets] } : {}) });
/** The item as UPSTREAM builds it: empty sockets, each gem set through setGem (layGemLines). */
function upstreamItem(t, d) {
  const it = { ...upstreamWeapon(weapon(t, { material: 9 })), rarity: 'rare', affixes: d.own.map((a) => ({ ...a })) };
  if (d.sockets.length) {
    it.sockets = d.sockets.map(() => R.SOCKET_EMPTY);
    d.sockets.forEach((g, i) => assert.ok(R.setGem(it, g, i), `setGem ${g}`));
  }
  return it;
}
/** affixWeaponDamage's percentage, recovered from its truncated result (1e6 x 1.36 truncates to 1,359,999, so round). */
const upstreamPct = (it) => Math.round((R.affixWeaponDamage(it, 1_000_000) / 10_000 - 100) * 100) / 100;
const wornEntity = (u, item) => { const e = upstreamEntity(character({})); u.equip.equipTableOf(e)[19] = item; return e; };

test('1. socket counts are upstream\'s for every weapon template', () => {
  for (const t of Object.keys(WEAPONS).map(Number)) {
    assert.equal(socketsFor(t), R.socketMax({ group: 'Weapons', templateIndex: t }), `template ${t}`);
    assert.equal(socketCount(t), socketsFor(t));
    assert.equal(perfectSockets(t).length, socketsFor(t));
  }
});

test('2. differential: 400 seeded items - stats and skills (affixFold), weapon damage (affixWeaponDamage)', async () => {
  const u = await upstream();
  const rng = generator(0x2b01);
  let capped = 0; let invalid = 0;
  for (let i = 0; i < 400; i++) {
    const t = TEMPLATES[i % TEMPLATES.length];
    const d = describeItem(rng, t);
    const up = upstreamItem(t, d);
    const mine = localItem(t, d);
    // stats / skills: the whole fold
    const fold = R.affixFold(wornEntity(u, up));
    const local = rebuildMods([{ ...mine, equipSlot: 19 }]);
    assert.deepEqual(local.stats, fold.stats, `item ${i}: stats`);
    assert.deepEqual(local.skills, fold.skills, `item ${i}: skills ${JSON.stringify({ own: d.own, sockets: d.sockets })} local ${JSON.stringify(local.skills)} up ${JSON.stringify(fold.skills)}`);
    assert.deepEqual(foldLines([mine]), { stats: fold.stats, skills: fold.skills });
    // weapon damage: pct from affixWeaponDamage on a large blow
    const pct = upstreamPct(up);
    assert.equal(weaponDamagePct(mine), pct, `item ${i}: damage %`);
    assert.equal(weaponOf(mine).damagePct, pct);
    assert.equal(local.weaponDamagePct, pct);
    if (R.readLines({ ...up }).some((a, k) => a !== up.affixes[k])) capped++; // a gem line the cap actually cut
    if (d.own.some((a) => !R.validAffix(a))) invalid++;
  }
  assert.ok(capped > 20 && invalid > 50, `the sample exercises the cap (${capped}) and invalid lines (${invalid})`);
});

test('3. differential: slayer and elemental through lootBlow - per line, repeats summed, invalid ignored, gem cap', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const rng = generator(0x2b02);
  const attacker = upstreamEntity(character({}));
  const ch = simCharacter(character({ level: 30, raceId: 1, skills: 0 }), null);
  ch.online = false;
  const target = standInTarget(31);
  let lines = 0;
  for (let i = 0; i < 400; i++) {
    const t = TEMPLATES[i % TEMPLATES.length];
    const d = describeItem(rng, t);
    // bias toward the interesting case: repeated element / slayer lines and element gems
    if (i % 3 === 0) { d.own.push({ id: 'elemental', param: 'fire', value: 4 }, { id: 'slayer', param: 'daedra', value: 12 }, { id: 'slayer', param: 'daedra', value: 9 }); d.sockets = d.sockets.slice(0, 1).concat(['perfect-ruby', 'perfect-ruby']).slice(0, Math.max(d.sockets.length, 1)); }
    const up = upstreamItem(t, d);
    const mine = localItem(t, d);
    const w = weaponOf(mine);
    for (const dmg of [1, 7, 23, 100, 777]) {
      // `estimate`: lootBlow without a carried remainder - the card's value (W-LOOT-CARRY is a separate waiver)
      const expected = lootBlow(up, dmg, attacker, { ...body, affinity: 'Daedra', careerIndex: 31, isPlayer: false }, { estimate: true });
      const actual = weaponBlow(ch, w, dmg, target, {});
      assert.equal(actual, expected, `item ${i}, blow ${dmg}: ${JSON.stringify({ own: d.own, sockets: d.sockets })}`);
    }
    lines += validItemLines(mine).length;
  }
  assert.ok(lines > 300);
});

test('4. the +25% cap: three perfect diamonds read 25, not 36; the piece\'s own damage line reads whole', () => {
  const three = { ...weapon(123, { material: 9 }), rarity: 'legendary', affixes: [{ id: 'damage', value: 25 }], sockets: ['perfect-diamond', 'perfect-diamond', 'perfect-diamond'] };
  assert.equal(socketAffixes(three).length, 3);
  assert.deepEqual(socketAffixes(three).map((a) => a.value), [12, 12, 12], 'as lines each is 12');
  assert.deepEqual(laidLines(three).map((a) => a.value), [25, 12, 12, 12]);
  const read = R.readLines({ ...three, affixes: laidLines(three) });
  assert.deepEqual(read.map((a) => a.value), [25, 12, 12, 1], 'law 6: 12 + 12 + 1 = 25');
  assert.equal(weaponDamagePct(three), 25 + 25);
  // the same through the upstream-built item
  const up = { ...upstreamWeapon(weapon(123, { material: 9 })), rarity: 'legendary', affixes: [{ id: 'damage', value: 25 }], sockets: ['empty', 'empty', 'empty'] };
  for (let i = 0; i < 3; i++) R.setGem(up, 'perfect-diamond', i);
  assert.equal(upstreamPct(up), 50);
  // a short blade has one socket: nothing to cap; a one-hander two: 24
  assert.equal(weaponDamagePct({ ...weapon(116, { material: 9 }), sockets: ['perfect-diamond'] }), 12);
  assert.equal(weaponDamagePct({ ...weapon(121, { material: 9 }), sockets: ['perfect-diamond', 'perfect-diamond'] }), 24);
  // a repeated element adds, not overwrites; the cap is the kind's Rare top (fire 6)
  const rubies = { ...weapon(123, { material: 9 }), affixes: [{ id: 'elemental', param: 'fire', value: 4 }, { id: 'elemental', param: 'fire', value: 3 }], sockets: ['perfect-ruby', 'perfect-ruby', 'perfect-ruby'] };
  assert.equal(bladeLines(rubies).elemental, 4 + 3 + 6, 'own lines whole, three rubies read 6 together');
  // a stat gem: three Malachites read 10 (the stat Rare top), each 8
  assert.equal(foldLines([{ ...weapon(123, { material: 9 }), sockets: ['perfect-malachite', 'perfect-malachite', 'perfect-malachite'] }]).stats.strength, 8 + 2);
});

test('5. invalid and unsupported lines are handled as upstream handles them', () => {
  const item = { ...weapon(121, { material: 9 }), affixes: [
    { id: 'slayer', param: 'daedra', value: 99 }, // above the band: invalid, ignored
    { id: 'slayer', param: 'dragon', value: 10 }, // not a foe kind
    { id: 'elemental', param: 'poison', value: 6 }, // not a proc element
    { id: 'bogus', value: 3 },
    { id: 'stat', param: 'strength', value: 7.5 }, // not an integer
    { id: 'slayer', param: 'daedra', value: 20 }, // valid
    { id: 'leech', value: 5 }, { id: 'thorns', value: 5 }, // unsupported kinds: no outgoing blow
  ] };
  assert.equal(bladeLines(item).slayer, 20);
  assert.deepEqual(bladeLines(item).elementalLines, []);
  assert.equal(validItemLines(item).length, 3, 'the valid slayer, leech and thorns lines');
  assert.equal(foldLines([item]).stats.strength, undefined);
  // and the blow: the 99% slayer does nothing
  const ch = simCharacter(character({ level: 30, raceId: 1, skills: 0 }), null);
  ch.online = false;
  const gate = standInTarget(31);
  const bare = weaponBlow(ch, weaponOf(weapon(121, { material: 9 })), 100, gate, {});
  assert.equal(weaponBlow(ch, weaponOf(item), 100, gate, {}), bare + Math.floor(100 * 20 / 100), 'only the valid 20% reads');
});

// ── builds ──────────────────────────────────────────────────────────────────

const DRAWS = 250000;
const check = (id, local, up) => {
  const z = (local - up.mean) / up.se;
  assert.ok(Math.abs(z) < 3.5, `${id}: local ${local.toFixed(4)} vs upstream ${up.mean.toFixed(4)} +/- ${(1.96 * up.se).toFixed(4)} (z ${z.toFixed(2)})`);
};

test('6. representative builds through the whole blow match upstream\'s worn-item blow (1H, 2H, dual hands)', async () => {
  const u = await upstream();
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const desc = character({ level: 30, raceId: 1, stats: { strength: 60, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 150, 32: 150, 34: 30 } });
  const target = standInTarget(31);
  const builds = [
    { id: '1H katana: 2 diamonds + own slayer 30 + fire 6', tpl: 121, d: { own: [{ id: 'slayer', param: 'daedra', value: 30 }, { id: 'elemental', param: 'fire', value: 6 }], sockets: ['perfect-diamond', 'perfect-diamond'] } },
    { id: '2H dai-katana: 3 diamonds (the +36 vs +25 case) + own damage 25', tpl: 123, d: { own: [{ id: 'damage', value: 25 }], sockets: ['perfect-diamond', 'perfect-diamond', 'perfect-diamond'] } },
    { id: '2H warhammer: 3 rubies + own fire 4 (repeated element)', tpl: 126, d: { own: [{ id: 'elemental', param: 'fire', value: 4 }], sockets: ['perfect-ruby', 'perfect-ruby', 'perfect-ruby'] }, skill: 32 },
    { id: 'dual off hand: katana, 2 diamonds + invalid slayer 99', tpl: 121, d: { own: [{ id: 'slayer', param: 'daedra', value: 99 }], sockets: ['perfect-diamond', 'perfect-diamond'] }, offHand: true },
  ];
  for (const [i, b] of builds.entries()) {
    const item = localItem(b.tpl, b.d);
    const up = upstreamItem(b.tpl, b.d);
    const { rarity, affixes, sockets, ...rest } = up;
    const fields = { rarity, affixes, ...(sockets ? { sockets } : {}) };
    const sample = sampleWorn(u, { attacker: upstreamEntity(desc), body, item: weapon(b.tpl, { material: 9 }), fields, seed: 0x5100 + i * 59, draws: DRAWS, offHand: !!b.offHand });
    const mine = analyze(simCharacter(desc, item), { target, core: 'overhaul', weapon: weaponOf(item), offHand: !!b.offHand, swing: 'StrikeLeft' });
    check(b.id, mine.perSwing, sample);
    // the old reading (every gem line whole, as plain lines) is outside upstream wherever a cap bites
    const raw = { ...item, sockets: undefined, affixes: [...item.affixes, ...socketAffixes(item).map(({ gem, ...l }) => l)] };
    const old = analyze(simCharacter(desc, raw), { target, core: 'overhaul', weapon: weaponOf(raw), offHand: !!b.offHand, swing: 'StrikeLeft' });
    const caps = b.id.includes('3 ') ;
    if (caps) assert.ok(Math.abs(old.perSwing - sample.mean) / sample.se > 5, `${b.id}: the uncapped reading is rejected (${old.perSwing.toFixed(3)} vs ${sample.mean.toFixed(3)})`);
  }
});

test('7. the max profile reads its three diamonds through the cap', () => {
  const g = gateTarget(45);
  const ch = maxCharacter(123);
  assert.equal(ch.weapon.sockets.length, 3);
  assert.equal(weaponOf(ch.weapon).damagePct, 25 + 25, 'a legal gear plan\'s 25% line + 25 from three diamonds');
  // and every three-socket weapon: the reading equals upstream's
  for (const t of Object.keys(WEAPONS).map(Number).filter((x) => socketsFor(x) === 3)) {
    const c = maxCharacter(t);
    const up = { ...upstreamWeapon(c.weapon), rarity: 'legendary', affixes: [...(c.weapon.affixes ?? [])], sockets: c.weapon.sockets.map(() => 'empty') };
    c.weapon.sockets.forEach((gm, i) => R.setGem(up, gm, i));
    assert.equal(weaponOf(c.weapon).damagePct, upstreamPct(up), `template ${t}`);
  }
  assert.ok(maxRun(ch, { target: g }).cappedDps > 0);
});
