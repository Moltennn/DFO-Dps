/*
 * test/integration.test.js - Stage 2.11c: the 2.11a/2.11b changes composed.
 *
 * Each subsystem has its own differential; this file asks the question those cannot: does ONE blow carrying every one of
 * them at once still follow upstream, and does an item that CARRIES a modifier evaluate exactly as the base build with
 * that modifier priced (`with`)?
 *
 * The oracle walks upstream's actual sequence with the item WORN:
 *   pcaaoAttackDamage            the overhaul core (the struck part handed back through `onStruck`)
 *   doItemEnchantmentPayloads    the formula tail's Strikes payloads (Potent Vs / Low Damage Vs), for a player whatever
 *                                the blow did (combat/formulas.js:826-840)
 *   lootStrike                   the strike listener: the Echo's roll, `again()` (lootPowers.js:374-376, :444-454)
 *   takeOwed / door.hurtFoe      the host's choice: a body the relay runs is OWED into the claim (dungeonContext.js:4528-4531);
 *                                a foe a door holds is its own hit
 * Nothing local is handed to it: it is given the item, its sockets, and the dice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, weaponOf, blowDistribution, gateTarget } from '../src/model.js';
import { enemyTarget, standInTarget } from '../src/target.js';
import { maxCharacter, maxRun } from '../src/maxprofile.js';
import { upstream, pcaaoModules } from './harness/upstream.mjs';
import { upstreamBody } from './harness/upstreamBodies.mjs';
import { character, simCharacter, upstreamEntity, weapon, upstreamWeapon } from './harness/fixtures.mjs';
import { generator } from './harness/prng.mjs';
import { compareDistributions, worst } from './harness/outcomes.mjs';
import { takeOwed, setPlayerDoor } from '../vendor/upstream/a3eb1605/src/systems/playerDoor.js';
import { _resetLootPowersForTests, _setLootPowersRandForTests } from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';
import { powerOf, setGem } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { doItemEnchantmentPayloads, PAYLOAD } from '../vendor/upstream/a3eb1605/src/systems/enchantments.js';

const DRAWS = 200000;
const PV = { type: 4, param: 1 }; // PotentVs vs Daedra
const DAEDRA = 1;
const KEY = ['perSwing', 'cappedPerSwing', 'cappedPerSwingMin', 'cappedPerSwingMax', 'dps', 'cappedDps', 'perSwingMin', 'perSwingMax'];

/** An upstream item built the game's way: own lines, empty sockets, each gem set through `setGem`. */
function wornItem(template, { own = [], gems = [], imprint = null, rows = [] } = {}) {
  const it = {
    ...upstreamWeapon(weapon(template, { material: 9 })), rarity: 'rare', affixes: own.map((a) => ({ ...a })),
    ...(imprint ? { imprint } : {}), ...(rows.length ? { enchantments: rows.map((r) => ({ ...r })), isIdentified: true } : {}),
  };
  if (gems.length) { it.sockets = gems.map(() => 'empty'); gems.forEach((g, i) => assert.ok(setGem(it, g, i), `setGem ${g}`)); }
  return it;
}
const localItem = (template, { own = [], gems = [], imprint = null, rows = [] } = {}) => ({
  ...weapon(template, { material: 9 }), rarity: 'rare', affixes: own.map((a) => ({ ...a })),
  ...(imprint ? { imprint } : {}), ...(rows.length ? { enchantments: rows.map((r) => ({ ...r })) } : {}),
  ...(gems.length ? { sockets: [...gems] } : {}),
});

/** The host's claim, sampled through upstream's own functions; the door decides owed vs own hit. */
function sampleBlow(u, modules, { desc, template, spec, body, seed, draws = DRAWS, dice = () => 0, traits = [], cap = 0 }) {
  _resetLootPowersForTests();
  _setLootPowersRandForTests(dice);
  const rng = generator(seed);
  const attacker = upstreamEntity(desc);
  const slot = u.equip.equipTableOf(attacker);
  const w0 = wornItem(template, spec);
  const struck = (d) => (traits.length && d > 0 ? u.bossTraits.bossStrike({ bossTraits: traits }, d, { kind: 'melee', weapon: w0 }).damage : d);
  const byPart = Array.from({ length: 7 }, () => new Map());
  const counts = new Array(7).fill(0);
  let sum = 0; let sq = 0; let owedTimes = 0;
  for (let i = 0; i < draws; i++) {
    const w = { ...w0 };
    slot[u.equip.EQUIP_SLOTS.RightHand] = w;
    const notes = {};
    let part = -1;
    const core = u.pcaao.pcaaoAttackDamage(attacker, body, { weapon: w, rolls: rng, modules, backstabChance: 0, notes, onStruck: (p) => { part = p; } });
    const d = attacker.isPlayer ? doItemEnchantmentPayloads(PAYLOAD.Strikes, w, { entity: attacker, target: body, damage: core, nowMinutes: 0 }) : core;
    if (d > 0) u.lootPowers.lootStrike(attacker, body, d, w, { blow: true });
    const owed = takeOwed(body);
    if (owed > 0) owedTimes++;
    const claim = struck(d) + (owed > 0 ? struck(owed) : 0);
    const value = cap > 0 ? Math.min(claim, cap) : claim;
    sum += value; sq += value * value;
    if (core > 0 && !notes.critical && part >= 0) { counts[part] += 1; byPart[part].set(value, (byPart[part].get(value) ?? 0) + 1); }
  }
  slot[u.equip.EQUIP_SLOTS.RightHand] = null;
  _setLootPowersRandForTests(null);
  _resetLootPowersForTests();
  const mean = sum / draws;
  return { byPart, counts, mean, owedTimes, se: Math.sqrt(Math.max(0, sq / draws - mean * mean) / draws) };
}

test('1. one blow carrying every 2.11a/2.11b change at once matches upstream, value by value', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  // own lines + five gems (three diamonds past the +25 cap, two rubies past the +6), a slayer line, Potent Vs, and an
  // Echo: the damage line, the gem cap, the elemental cap, the slayer sum, the Strikes payload, the power, the claim.
  const spec = {
    own: [{ id: 'damage', value: 25 }, { id: 'elemental', param: 'fire', value: 4 }, { id: 'slayer', param: 'daedra', value: 20 }],
    gems: ['perfect-diamond', 'perfect-diamond', 'perfect-diamond', 'perfect-ruby', 'perfect-ruby'],
    rows: [PV],
  };
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 40 }, skills: 0, skillOverride: { 29: 150, 32: 150, 34: 30 } });
  for (const [i, [label, traits, cap]] of [['plain', [], 0], ['stoneskin, cap 60', ['stoneskin'], 60], ['stoneskin, cap 600', ['stoneskin'], 600]].entries()) {
    const sample = sampleBlow(u, modules, { desc, template: 126, spec: { ...spec, imprint: 'warp-edge' }, body, seed: 0x7100 + i * 37, traits, cap });
    const local = localItem(126, { ...spec, imprint: 'warp-edge' });
    const target = { ...standInTarget(31), bossTraits: traits, hitCap: cap };
    const r = analyze(simCharacter(desc, local), { target, core: 'overhaul', weapon: weaponOf(local), swing: 'StrikeLeft' });
    const dist = Array.from({ length: 7 }, (_, part) => blowDistribution(r.damage.plainRolls, part, {
      target, weapon: r.weapon, traits, cap, echoes: [100], potentVs: 5,
    }));
    const bad = worst(compareDistributions(sample, dist));
    assert.ok(Math.abs(bad.z) < 4.5, `${label}: part ${bad.part} value ${bad.value}: upstream ${bad.c} of ${sample.counts[bad.part]}, local ${bad.p.toFixed(5)}, z ${bad.z.toFixed(1)}`);
  }
});

test('2. equipped == priced, exactly, across configurations and edits; an edit never moves the base', () => {
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 28: 150, 29: 150, 30: 150, 32: 150, 33: 150, 34: 30, 19: 50 } });
  const target = standInTarget(31);
  const run = (item, extra = {}, off = null) => {
    const ch = simCharacter(desc, item);
    if (off) { ch.offWeapon = off; ch._dual = true; }
    return analyze(ch, { target, core: 'overhaul', weapon: weaponOf(item), ...extra });
  };
  const CONFIGS = [
    { id: 'one-handed', tpl: 121, extra: {} },
    { id: 'two-handed', tpl: 123, extra: {} },
    { id: 'pair', tpl: 562, extra: { pair: true } },
    { id: 'dual', tpl: 121, extra: { dual: true }, off: true },
    { id: 'bow', tpl: 130, extra: {} },
    { id: 'backstab', tpl: 121, extra: { backstabUptime: 1 } },
  ];
  // the edit priced, and the same change CARRIED by the item
  const EDITS = [
    { label: 'flow', edit: { imprint: powerOf('anseis-edge') }, spec: { imprint: 'anseis-edge' } },
    { label: 'venom', edit: { imprint: powerOf('tsaesci-fang') }, spec: { imprint: 'tsaesci-fang' } },
    { label: 'echo', edit: { imprint: powerOf('warp-edge') }, spec: { imprint: 'warp-edge' } },
    { label: 'Potent Vs', edit: { potentVs: 5 }, spec: { rows: [PV] } },
    { label: 'loot 25%', edit: { loot: { pct: 25, flat: 0 } }, spec: { own: [{ id: 'slayer', param: 'daedra', value: 25 }] } },
    { label: 'loot +6 fire', edit: { loot: { pct: 0, flat: 6 } }, spec: { own: [{ id: 'elemental', param: 'fire', value: 6 }] } },
    // a damage line is a CARD change: it is priced by placing the line on the item (what marginals/rankWeapons do), not by
    // a what-if channel, so it is checked here as the same line twice (the slayer + elemental pair) instead
    { label: 'two line kinds at once', edit: { loot: { pct: 25, flat: 6 } }, spec: { own: [{ id: 'slayer', param: 'daedra', value: 25 }, { id: 'elemental', param: 'fire', value: 6 }] } },
  ];
  for (const c of CONFIGS) {
    const baseItem = localItem(c.tpl, {});
    const offItem = c.off ? localItem(c.tpl, {}) : null;
    const item = baseItem;
    const base = run(item, c.extra, offItem);
    const before = Object.fromEntries(KEY.map((k) => [k, base[k]]));
    for (const { label, edit, spec } of EDITS) {
      const priced = base.with(edit);
      const carried = localItem(c.tpl, spec);
      if (c.off) {
        // an imprint or a row rides the MAIN-hand item; the off-hand item is its own and unchanged
        const e = run(carried, c.extra, offItem);
        for (const k of KEY) assert.equal(e[k], priced[k], `${c.id} / ${label}: ${k}`);
        assert.equal(e.offHand.cappedPerSwing, base.offHand.cappedPerSwing, `${c.id} / ${label}: the off hand carries nothing`);
        continue;
      }
      const e = run(carried, c.extra);
      for (const k of KEY) assert.equal(e[k], priced[k], `${c.id} / ${label}: ${k}`);
    }
    // pricing never moves the base it was priced from, and no edit is no change
    for (const k of KEY) assert.equal(base[k], before[k], `${c.id}: base unchanged by pricing`);
    const plain = run(item, c.extra, offItem);
    for (const k of KEY) assert.equal(plain[k], base[k], `${c.id}: no edit, no change`);
  }
  // pricing a power the build ALREADY carries is no change: upstream's wornPowers counts a power once (lootPowers.js:247-253)
  for (const id of ['anseis-edge', 'warp-edge', 'tsaesci-fang', 'gortwogs-cleaver']) {
    const carried = run(localItem(121, { imprint: id }));
    const again = carried.with({ imprint: powerOf(id) });
    for (const k of KEY) assert.equal(again[k], carried[k], `carried ${id}, priced again: ${k}`);
  }
});

test('3. the ordinary-foe arm of Many Endings: with a foe record the echo is its own hit, nothing is owed', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const { body } = await upstreamBody({ kind: 'mint', mobile: 31 }); // a world foe's body, not a relay stand-in
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 80, speed: 80, luck: 40 }, skills: 0, skillOverride: { 29: 150, 34: 30 } });
  const item = weapon(121, { material: 9 });
  let own = 0;
  setPlayerDoor({ foes: () => [{ entity: body, dead: false }], feet: () => [0, 0, 0], hurtFoe: (_f, n) => { own += n; }, castOnPlayer: () => {} });
  let sample;
  try {
    sample = sampleBlow(u, modules, { desc, template: 121, spec: { imprint: 'warp-edge' }, body, seed: 0x7200, dice: () => 0 });
  } finally {
    setPlayerDoor(null);
  }
  // the echo landed through the door's own door (hurtFoe), and nothing was owed: the two arms are distinct
  const doorMean = own / DRAWS;
  assert.ok(doorMean > 0, 'the door saw the echo as its own hit');
  assert.equal(sample.owedTimes, 0, 'nothing was owed to a claim with a foe record');
  const local = analyze(simCharacter(desc, item), { target: enemyTarget(31), core: 'overhaul', weapon: weaponOf(item), swing: 'StrikeLeft' });
  const priced = local.with({ imprint: { kind: 'echo', chance: 100 } });
  const z = (priced.perSwing - (sample.mean + doorMean)) / sample.se;
  assert.ok(Math.abs(z) < 4, `ordinary foe: local ${priced.perSwing.toFixed(3)} vs upstream ${(sample.mean + doorMean).toFixed(3)} +/- ${(1.96 * sample.se).toFixed(3)} (z ${z.toFixed(2)})`);
  // the same base without the power is the local base
  assert.ok(priced.perSwing > local.perSwing * 1.9, 'the echo doubles the blow there');
});

test('4. no regression in the Stage 2.9 corrections the composition touches', () => {
  const gate = gateTarget(45);
  // the saturated gate build is still exactly what Stage 2.9/2.8 reported, now on Stage 2.13's six-way draw (the
  // neutral StrikeLeft is 857.19; the click draw's expectation is 853.49). Those are a3eb1605 figures, so 14512.
  const max = maxRun(maxCharacter(121, { gameBuild: '14512' }), { target: gate, gameBuild: '14512' });
  assert.equal(max.cappedDps.toFixed(2), '853.49');
  assert.ok(max.ttk > 75 && max.ttk < 77);
  // a build with no gems and no powers is untouched by either stage
  const plain = analyze(simCharacter(character({ level: 30, raceId: 1, stats: { strength: 70, agility: 70, speed: 70, luck: 50 }, skills: 0, skillOverride: { 29: 100, 34: 40 } }), weapon(121, { material: 9 })), { target: gate, core: 'overhaul' });
  assert.equal(plain.with({}).cappedDps, plain.cappedDps);
  assert.equal(plain.with({ loot: { pct: 0, flat: 0 }, potentVs: 0 }).cappedDps, plain.cappedDps);
});
