/*
 * test/pricing.test.js - Stage 2.9, F2: pricing runs the one damage calculation.
 *
 * Before Stage 2.9 `cappedDpsWith` (src/maxprofile.js) re-derived a capped DPS from the main hand's rolls and
 * disagreed with `analyze` even when nothing was changed: +9.5% for the Pistolet pair, +5.4% for a dual build,
 * -3.9% with a backstab (audit F2), and a Potent Vs worth of a pair included a phantom +47.5 DPS. Pricing now
 * re-runs the same card with the change entering the blow where the game puts it (`result.with(edit)`):
 *   - a loot power's percentage and flat: lootBlow's step, systems/loot/lootPowers.js:286-347 (the slayer-style
 *     `pct` of the whole blow with the elemental/venom `flat` added after), before the martial path, the crit,
 *     the material and condition, the defence and the cap;
 *   - Potent Vs: the +5 `strikesModulateDamage` of the Strikes payload (systems/enchantments.js:622-631,
 *     :1068), added in the formulas.js tail (:826-840) after the defence and the off hand's share, to a blow
 *     that is `whole` - a swing that missed included: the payload runs for a player whatever the blow did
 *     and upstream's calculateAttackDamage answers 5 for a miss (an off-hand blow is whole OFF_HAND_BLOW.blowWeight of the time), before a shaft's
 *     pull, the boss trait and the cap.
 *
 * What is verified here, and how:
 *   differential  per-swing means against upstream's own calculateAttackDamage (a real line / enchantment on the
 *                 oracle's weapon, upstream's own body, trait and cap) - sections 3 and 4;
 *   local invariant  no-change identity and what-if == the same line on the item (section 1, 2): these show the
 *                 two paths are ONE path; they are not upstream parity on their own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, gateTarget, weaponOf } from '../src/model.js';
import { standInTarget } from '../src/target.js';
import { maxCharacter, maxRun } from '../src/maxprofile.js';
import { powerDps } from '../src/imprints.js';
import { WEAPONS } from '../src/data.js';
import { offHandToHit } from '../src/dualWield.js';
import { upstream, pcaaoModules } from './harness/upstream.mjs';
import { upstreamBody } from './harness/upstreamBodies.mjs';
import { sampleCalc } from './harness/outcomes.mjs';
import { character, simCharacter, upstreamEntity, weapon, upstreamWeapon } from './harness/fixtures.mjs';
import { generator } from './harness/prng.mjs';
import { WAIVERS, expectKnownDiscrepancy } from './harness/waivers.mjs';

const GATE = () => gateTarget(45);
// The audited figures below (547.37, 499.89, 1016.39, 891.74) are the VENDORED CUT's, recorded before the default
// flipped, so the scenario and every character name the cut (CHANGELOG-MECHANICS.md, the default-flip entry).
const OPTS = { core: 'overhaul', rri: true, healthShare: 1, passiveOn: true, stacks: 5, swing: 'StrikeLeft', gameBuild: '14512' };

/** The supported weapon configurations, as the pricing code sees them. */
function configs() {
  const gate = GATE();
  const run = (ch, extra = {}) => analyze(ch, { ...OPTS, target: gate, health: gate.maxHealth, pair: !!ch._pair, dual: !!ch._dual, ...extra });
  // The CHARACTER carries the build as well as the scenario (the gear points it is built with follow the law).
  const cut = { gameBuild: '14512' };
  const dual = maxCharacter(121, cut);
  dual._dual = true;
  dual.offWeapon = { ...dual.weapon, equipSlot: 21 };
  return [
    { id: 'one-handed (katana)', run: () => run(maxCharacter(121, cut)) },
    { id: 'two-handed (dai-katana)', run: () => run(maxCharacter(123, cut)) },
    { id: 'paired weapons (Pistolet)', run: () => run(maxCharacter(562, cut)), pair: true },
    { id: 'dual wield (katana + katana)', run: () => run(dual), dual: true },
    { id: 'backstab on (katana, uptime 1)', run: () => run(maxCharacter(121, cut), { backstabUptime: 1 }) },
    { id: 'backstab off (katana)', run: () => run(maxCharacter(121, cut), { backstabUptime: 0 }) },
    { id: 'hand wraps', run: () => run(maxCharacter(563, cut)) },
    { id: 'long bow', run: () => run(maxCharacter(130, cut)) },
  ];
}

test('1. no change: pricing evaluates to the canonical analysis, for every supported configuration', () => {
  for (const c of configs()) {
    const base = c.run();
    if (c.pair) assert.ok(base.pair, `${c.id}: really a pair`);
    if (c.dual) assert.ok(base.dual, `${c.id}: really dual`);
    for (const [label, edit] of [['empty edit', {}], ['loot 0', { loot: { pct: 0, flat: 0 } }], ['potentVs 0', { potentVs: 0 }]]) {
      const again = base.with(edit);
      for (const k of ['perSwing', 'cappedPerSwing', 'dps', 'cappedDps', 'cappedDpsMin', 'cappedDpsMax']) {
        assert.equal(again[k], base[k], `${c.id} / ${label}: ${k}`);
      }
    }
    // the priced path: a power that changes nothing prices at the base, capped and uncapped
    for (const kind of ['chain', 'quake', 'conduit', 'siphon', 'surge']) {
      assert.equal(powerDps({ kind }, base, true, { capped: true }), base.carriedCappedDps, `${c.id}: ${kind} capped`);
      assert.equal(powerDps({ kind }, base, false), base.carriedDps, `${c.id}: ${kind} uncapped`);
    }
    assert.equal(powerDps({ kind: 'bane', pct: 50 }, base, false, { capped: true }), base.carriedCappedDps, `${c.id}: an untriggered power is the base`);
  }
});

test('1b. the audit\'s discrepancies are gone: pair, dual and backstab at no change are exactly the analysis', () => {
  const [, , pair, dual, backstab] = configs();
  // pre-2.9 helper at no change: Pistolet 547.37 vs 499.89 (+9.5%), dual 1071.49 vs 1016.39 (+5.4%), backstab 857.19 vs 891.74 (-3.9%)
  const p = pair.run(); const d = dual.run(); const b = backstab.run();
  assert.equal(p.with({ loot: { pct: 0, flat: 0 } }).cappedDps, p.cappedDps);
  assert.ok(Math.abs(p.cappedDps - 499.89) < 0.01, `pair ${p.cappedDps}`);
  assert.ok(Math.abs(d.cappedDps - 1016.39) < 0.01, `dual ${d.cappedDps}`);
  assert.ok(Math.abs(b.cappedDps - 891.74) < 0.01, `backstab ${b.cappedDps}`);
  // and a flat that does something prices through the same card: the backstab base keeps its mixture. (Every
  // backstabbed blow of the max profile is x3 and already past the 600 cap, so the capped figure cannot move;
  // the uncapped one does.)
  assert.equal(b.backstab.expectedMult, 3);
  assert.equal(b.with({ loot: { pct: 0, flat: 8 } }).cappedDps, b.cappedDps, 'saturated at the cap');
  assert.ok(b.with({ loot: { pct: 0, flat: 8 } }).dps > b.dps);
});

test('2. a what-if is the same line on the item: pct = a slayer line, flat = an elemental line (local invariant)', () => {
  const gate = GATE();
  assert.equal(gate.group, 'daedra');
  for (const c of configs().filter((x) => !x.dual && !x.pair)) {
    const base = c.run();
    const ch = maxCharacter(c.id.includes('dai') ? 123 : c.id.includes('wraps') ? 563 : c.id.includes('bow') ? 130 : 121, { gameBuild: '14512' });
    const lineItem = (affixes) => ({ ...ch.weapon, affixes: [...(ch.weapon.affixes ?? []), ...affixes] });
    const real = (affixes, extra = {}) => analyze({ ...ch, weapon: lineItem(affixes) }, { ...OPTS, target: gate, health: gate.maxHealth, ...extra });
    const extra = c.id.includes('backstab on') ? { backstabUptime: 1 } : {};
    if (c.id.includes('wraps')) continue; // wraps carry their lines on `wraps`, not `weapon`
    for (const [what, line] of [
      // 30 is the top of the slayer band (a line above it is invalid and upstream ignores it)
      [{ loot: { pct: 30, flat: 0 } }, [{ id: 'slayer', param: 'daedra', value: 30 }]],
      [{ loot: { pct: 0, flat: 8 } }, [{ id: 'elemental', param: 'fire', value: 8 }]],
      [{ loot: { pct: 30, flat: 6 } }, [{ id: 'slayer', param: 'daedra', value: 30 }, { id: 'elemental', param: 'fire', value: 6 }]],
    ]) {
      const a = base.with(what); const b = real(line, extra);
      for (const k of ['perSwing', 'cappedPerSwing', 'cappedDps', 'dps', 'carriedPerSwing', 'carriedCappedPerSwing', 'carriedCappedDps', 'carriedDps']) assert.equal(a[k], b[k], `${c.id}: ${JSON.stringify(what)} ${k}`);
    }
  }
});

test('2b. in a dual build the what-if rides the main-hand item; a pair is one item for both guns', () => {
  const gate = GATE();
  const [, , pair, dual] = configs();
  const d = dual.run();
  const dp = d.with({ potentVs: 5 });
  // the off hand does not carry it: its own analysis is unchanged, the main hand's moves
  assert.equal(dp.offHand.cappedPerSwing, d.offHand.cappedPerSwing, 'off hand unchanged');
  assert.ok(dp.cappedPerSwing > d.cappedPerSwing);
  const p = pair.run();
  const pp = p.with({ potentVs: 5 });
  // a pair is one item: both guns carry it - the pair's swing is the mean of the two hands' blows, so its
  // gain is the main hand's plus the off hand's (at 0.8), each read from the hand's own card
  const hand = (offHand) => analyze(maxCharacter(562, { gameBuild: '14512' }), { ...OPTS, target: GATE(), health: GATE().maxHealth, pair: false, offHand });
  const [m0, o0] = [hand(false), hand(true)];
  const [m1, o1] = [m0.with({ potentVs: 5 }), o0.with({ potentVs: 5 })];
  assert.ok(m1.cappedPerSwing > m0.cappedPerSwing && o1.cappedPerSwing > o0.cappedPerSwing, 'both hands move');
  assert.ok(Math.abs(pp.cappedPerSwing - p.cappedPerSwing - ((m1.cappedPerSwing - m0.cappedPerSwing) + (o1.cappedPerSwing - o0.cappedPerSwing)) / 2) < 1e-9);
  assert.ok(pp.cappedPerSwing > p.cappedPerSwing);
  // the audit's phantom: the pair's Potent Vs is worth a few DPS (aps x half of five per landed blow, the
  // off hand at 0.8), never the +47.5 the helper's baseline offset added
  const gain = pp.cappedDps - p.cappedDps;
  // Potent Vs rides EVERY swing (a miss returns the five too): at most aps x half of (5 + 5 x 0.8) a second
  const ceiling = p.cadence.aps * 0.5 * (5 + 5 * 0.8) + 1e-9;
  assert.ok(gain > 0 && gain <= ceiling, `pair Potent Vs gain ${gain.toFixed(3)} within (0, ${ceiling.toFixed(3)}]`);
  assert.ok(gain < 10, 'not the +47.5 phantom');
  void gate;
});

// ── upstream differentials ──────────────────────────────────────────────────

const CAREER_DESC = (extra = {}) => character({ level: 30, raceId: 1, stats: { strength: 60, agility: 80, speed: 80, luck: 50 }, skills: 0, skillOverride: { 29: 150, 32: 150, 33: 150, 34: 30, 19: 50, ...extra } });

/** Upstream's own blow (test/harness/outcomes.mjs sampleCalc) for a character description. */
const sampleBlow = (u, _modules, { desc, ...rest }) => sampleCalc(u, { attacker: upstreamEntity(desc), ...rest });

const DRAWS = 250000;

test('3. Potent Vs on a landed blow matches upstream: main hand, off hand (weight 0.8), trait, cap, bow, backstab', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  void modules;
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const enchanted = [{ type: 4, param: 1 }]; // PotentVs vs Daedra (enchantments.js:622-631; ENEMY affinity 1)
  const target = standInTarget(31);
  const cases = [
    { id: 'katana, main hand', tpl: 121, skill: 29, traits: [], cap: 0 },
    { id: 'katana, off hand (whole 80% of the time)', tpl: 121, skill: 29, traits: [], cap: 0, offHand: true },
    { id: 'warhammer vs stoneskin, binding cap 9', tpl: 126, skill: 32, traits: ['stoneskin'], cap: 9 },
    { id: 'katana off hand vs bladeturning, cap 7', tpl: 121, skill: 29, traits: ['bladeturning'], cap: 7, offHand: true },
    { id: 'long bow: +5 BEFORE the pull, bladeturning arrows, cap 40', tpl: 130, skill: 33, traits: ['bladeturning'], cap: 40, bow: true },
    { id: 'katana with a backstab (chance 50), cap 600', tpl: 121, skill: 29, traits: [], cap: 600, backstab: true },
  ];
  for (const [index, c] of cases.entries()) {
    const desc = CAREER_DESC();
    const item = weapon(c.tpl, { material: 9 });
    const kind = c.bow ? 'arrow' : 'melee';
    const after = (d) => {
      const pulled = c.bow ? u.bowBloom.bowFastDamage({ pull: 1.5, fast: 0 }, d) : d;
      const t = c.traits.length ? u.bossTraits.bossStrike({ bossTraits: c.traits }, pulled, { kind, weapon: upstreamWeapon(item) }).damage : pulled;
      return c.cap > 0 ? Math.min(t, c.cap) : t;
    };
    const run = (extra) => sampleBlow(u, modules, { desc, item, extra, body, seed: 0x2d00 + index * 947, draws: DRAWS, offHand: !!c.offHand, backstabChance: c.backstab ? 50 : 0, after });
    const withPv = run({ enchantments: enchanted, isIdentified: true });
    const without = run({});
    const tgt = { ...target, bossTraits: c.traits, hitCap: c.cap };
    const baseLocal = analyze(simCharacter(desc, item), { target: tgt, core: 'overhaul', weapon: weaponOf(item), offHand: !!c.offHand, backstabUptime: c.backstab ? 1 : 0, swing: 'StrikeLeft' });
    const priced = baseLocal.with({ potentVs: 5 });
    const pick = (r) => (c.cap > 0 ? r.cappedPerSwing : r.perSwing);
    const zWith = (pick(priced) - withPv.mean) / withPv.se;
    const zBase = (pick(baseLocal) - without.mean) / without.se;
    assert.ok(Math.abs(zBase) < 3.5, `${c.id}: base ${pick(baseLocal).toFixed(4)} vs ${without.mean.toFixed(4)} (z ${zBase.toFixed(2)})`);
    assert.ok(Math.abs(zWith) < 3.5, `${c.id}: with Potent Vs ${pick(priced).toFixed(4)} vs ${withPv.mean.toFixed(4)} +/- ${(1.96 * withPv.se).toFixed(4)} (z ${zWith.toFixed(2)})`);
    // and the marginal itself - the gain a pricing helper reports - is upstream's, within its sampling error
    const gainUp = withPv.mean - without.mean;
    const gainSe = Math.hypot(withPv.se, without.se);
    const gainLocal = pick(priced) - pick(baseLocal);
    assert.ok(Math.abs(gainLocal - gainUp) < 4 * gainSe + 1e-9, `${c.id}: gain ${gainLocal.toFixed(4)} vs upstream ${gainUp.toFixed(4)} +/- ${(1.96 * gainSe).toFixed(4)}`);
    assert.ok(gainUp > 0, `${c.id}: the oracle sees the enchantment (${gainUp.toFixed(4)})`);
  }
});

test('4. a loot line (percentage + flat) on the blow matches upstream, in the game\'s order, with trait and cap', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const target = standInTarget(31);
  const affixes = [{ id: 'slayer', param: 'daedra', value: 30 }, { id: 'elemental', param: 'fire', value: 8 }];
  const cases = [
    { id: 'katana, 30% + 8 flat', tpl: 121, skill: 29, traits: [], cap: 0, crit: 30 },
    { id: 'katana, crit 100 (the flat is multiplied by the crit, once)', tpl: 121, skill: 29, traits: [], cap: 0, crit: 100 },
    { id: 'warhammer, stoneskin, binding cap 12', tpl: 126, skill: 32, traits: ['stoneskin'], cap: 12, crit: 30 },
    { id: 'katana, backstab 50, cap 600', tpl: 121, skill: 29, traits: [], cap: 600, crit: 30, backstab: true },
  ];
  for (const [index, c] of cases.entries()) {
    const desc = CAREER_DESC({ 34: c.crit });
    const item = weapon(c.tpl, { material: 9 });
    const after = (d) => {
      const t = c.traits.length ? u.bossTraits.bossStrike({ bossTraits: c.traits }, d, { kind: 'melee', weapon: upstreamWeapon(item) }).damage : d;
      return c.cap > 0 ? Math.min(t, c.cap) : t;
    };
    const up = sampleBlow(u, modules, { desc, item, extra: { affixes }, body, seed: 0x2e00 + index * 613, draws: DRAWS, backstabChance: c.backstab ? 50 : 0, after });
    const tgt = { ...target, bossTraits: c.traits, hitCap: c.cap };
    const baseLocal = analyze(simCharacter(desc, item), { target: tgt, core: 'overhaul', weapon: weaponOf(item), backstabUptime: c.backstab ? 1 : 0, swing: 'StrikeLeft' });
    const priced = baseLocal.with({ loot: { pct: 30, flat: 8 } });
    const mine = c.cap > 0 ? priced.cappedPerSwing : priced.perSwing;
    const z = (mine - up.mean) / up.se;
    assert.ok(Math.abs(z) < 3.5, `${c.id}: ${mine.toFixed(4)} vs ${up.mean.toFixed(4)} +/- ${(1.96 * up.se).toFixed(4)} (z ${z.toFixed(2)})`);
  }
});

test('5. W-LOOT-CARRY: the carried metric is the held item\'s stream; the card still floors each blow', async () => {
  // lootPowers.js:176-181 shareOf: floor(damage x pct / 100 + carry), the remainder kept per held item. A fresh
  // item per blow (the card) floors; the one item the game holds carries, and its long-run mean is the EXACT
  // share - sum f_i = sum x_i + c_0 - c_n, so the stream's total differs from the exact total by under one point.
  // The carried metric (src/model.js `carriedPerSwing`/`carriedDps`) is that exact mean, proved here; the card's
  // own estimate path (info.estimate reads the carry, never writes it) keeps flooring, and the pin below holds
  // that divergence while the fight streams still floor too.
  const u = await upstream();
  const modules = pcaaoModules(u);
  void modules;
  const { body } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const desc = CAREER_DESC();
  const item = weapon(121, { material: 9 });
  const affixes = [{ id: 'slayer', param: 'daedra', value: 25 }];
  const rng = generator(0x2f01);
  const attacker = upstreamEntity(desc);
  const held = { ...upstreamWeapon(item), affixes };
  const N = 250000;
  let sum = 0; let sq = 0;
  for (let i = 0; i < N; i++) {
    const d = u.formulas.calculateAttackDamage(attacker, body, { weapon: held, rolls: rng, backstabChance: 0 });
    sum += d; sq += d * d;
  }
  const m = sum / N; const se = Math.sqrt((sq / N - m * m) / N);
  const baseLocal = analyze(simCharacter(desc, item), { target: standInTarget(31), core: 'overhaul', weapon: weaponOf(item), swing: 'StrikeLeft' });
  const priced = baseLocal.with({ loot: { pct: 25, flat: 0 } });
  const carried = priced.carriedPerSwing;
  // The carried metric is the exact share passed down the pipeline; the sample still carries the integer stages
  // (the crit's unityRound, the hide's) applied per integer blow, whose dither is worth a fraction of a point
  // here (0.18%), so the bound is 0.5% - still 4x tighter than the card's own 2.2% gap, which the pin below keeps.
  const rel = Math.abs(carried / m - 1);
  assert.ok(rel < 0.005, `carried ${carried.toFixed(4)} vs held ${m.toFixed(4)} (${(rel * 100).toFixed(2)}%, z ${((carried - m) / se).toFixed(2)})`);
  // The card is upstream's own estimate path (info.estimate reads the carry, never writes it), so each blow floors:
  // the gap this waiver keeps pinning - 19.03 against 19.45 on this 25% line, +2.2%.
  const card = priced.perSwing;
  // Card-vs-carried on a humanoid slayer line is asserted separately in lootCarry.test.js §4 (different fixture).
  expectKnownDiscrepancy(assert, 'W-LOOT-CARRY', (m - card) / se > 8 && m / card - 1 > 0.005, { upstream: m, card, z: (m - card) / se });
});
