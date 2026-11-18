/*
 * test/procBudget.test.js - Stage 3.7: the per-hit cap and the DoT round (the proc budget).
 *
 * Two rules meet here, both read from the relay's own law:
 *   - one magic round's DoT is ONE claim: all procs' ticks summed, then capped once (`src/allowance.js:108-114`
 *     `claimStreams`, vendor:scenes/gate/standInSpell.js:131-151);
 *   - a DoT round is `DOT_ROUND_S` seconds (`src/allowance.js:40`), the same 5 s the spell library's
 *     `MAGIC_ROUND_SECONDS` uses (`src/spells.js:21`).
 *
 * 3.7: the card and the allowance claim the same DoT round - all procs' ticks summed, capped once - and a dual pair
 * claims that round ONCE, from the one like-kind entry a body carries (vendor:systems/effects.js:1091-1103).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { analyze, gateTarget, referenceFoe, weaponOf } from '../src/model.js';
import { enchantDps, strikeEnchantments } from '../src/enchants.js';
import { ALLOWANCE, DOT_ROUND_S, claimStreams, refOf } from '../src/allowance.js';
import { MAGIC_ROUND_SECONDS } from '../src/spells.js';
import { buildReport } from '../src/report.js';
import { theoryCharacter } from '../src/theory.js';
import { perfectSockets } from '../src/sockets.js';
import { expectKnownDiscrepancy } from './harness/waivers.mjs';
import { expandStreams, relayStream } from './harness/relay.mjs';

const BASIC = () => character({ level: 45, raceId: 1, skills: 40, online: false });

/** One Continuous Damage Health (1,0) spell, magnitude `mag`, ten rounds. */
const dotSpell = (index, mag = 1000) => ({
  name: `DoT ${index}`, index, element: 4, rangeType: 1,
  effects: [{
    type: 1, subType: 0,
    magnitudeBaseLow: mag, magnitudeBaseHigh: mag,
    magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
    durationBase: 10, durationMod: 0, durationPerLevel: 1,
    chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
  }],
});

/** A weapon with TWO Cast When Strikes rows, each a big DoT: the summed round is what the cap sees. */
const twoDotItem = () => {
  const it = weapon(121, { material: 9 });
  it.enchantments = [{ type: 2, param: 1 }, { type: 2, param: 2 }];
  return it;
};

/** One Cast When Strikes DoT row on a long blade, and the same piece in the other hand: a dual pair of one spell. */
const dotPair = (mag = 200) => {
  const main = weapon(121, { material: 9 });
  main.enchantments = [{ type: 2, param: 1 }];
  const off = { ...main, equipSlot: 21 };
  const ch = simCharacter(character({ level: 30, raceId: 1, skills: 40, online: false }), main);
  ch.offWeapon = off;
  ch._dual = true;
  return { ch, main, off, standard: new Map([[1, dotSpell(1, mag)]]) };
};

/** A card's DoT part: what `enchantDps` adds a second beyond the proc damage (an `enchantDps` over 5 s). */
const dotPart = (card) => card.enchantDps - card.enchantPerSwing * card.cadence.aps;

test('3.7b: one DoT round is one claim - the card and the allowance cap the same summed round', () => {
  const item = twoDotItem();
  const ch = simCharacter(BASIC(), item);
  const target = referenceFoe(45, 'tough');
  const standard = new Map([[1, dotSpell(1)], [2, dotSpell(2)]]);
  const cap = ALLOWANCE.hitCapX * refOf(45); // the relay's per-hit cap for a CWS proc claim: 12 x ref
  const s = strikeEnchantments(item, ch, target, { level: 45, standard });
  const e = enchantDps(item, ch, target, { hit: 1, aps: 1, level: 45, cap, standard });
  const streams = claimStreams({ cappedPerSwing: 100, hit: 1, aps: 1, procs: s.procs, cap });
  const dot = streams.find((x) => x.kind === 'dot');
  const tick = s.procs[0].dotTick;

  assert.equal(s.procs.length, 2);
  assert.equal(tick, 555, 'the round of one magnitude-1000 DoT at an average 55.5% save');
  assert.ok(2 * tick > cap, 'the summed round is over the cap, each tick under it');
  // Both sides now follow the allowance's law - the round summed, then capped ONCE (3.7b).
  assert.equal(e.procDot, 600, 'sum-then-cap: min(1110, 600)');
  assert.equal(e.dotDpsMax, 600 / MAGIC_ROUND_SECONDS, 'the maximum round is capped the same way');
  // The allowance: the same sum, the same single cap - the card and the claim agree.
  assert.equal(dot.perClaim, 600, 'sum-then-cap: min(1110, 600)');
  assert.equal(e.procDot, dot.perClaim, 'the card and the allowance claim the same round');
});

test('3.7a: the DoT round is 5 s in the allowance and in the spell library alike (two homes, one value)', () => {
  assert.equal(DOT_ROUND_S, MAGIC_ROUND_SECONDS);
  assert.equal(DOT_ROUND_S, 5);
});

test('3.7c: a dual pair claims ONE DoT round, from one merged entry', () => {
  const { ch, main, standard } = dotPair();
  const gate = gateTarget(30);
  const target = gate;
  const single = simCharacter(character({ level: 30, raceId: 1, skills: 40, online: false }), main);
  const oneHand = analyze(single, { target, health: gate.maxHealth, weapon: weaponOf(main), standard });
  const dual = analyze(ch, { target, health: gate.maxHealth, weapon: weaponOf(main), dual: true, standard });
  const tick = strikeEnchantments(main, single, target, { level: 30, standard }).procDot;

  // The pair: the body carries ONE like-kind entry (effects.js:1091-1103), so the one hand's round once - not the two
  // hands' rounds added (the pre-3.7c card priced 1 + 0.8 of it).
  assert.equal(dotPart(dual), tick / DOT_ROUND_S, 'the pair claims the round once');
  assert.equal(dual.enchantDps, oneHand.enchantDps, 'and its enchant DPS is the one-hand build\'s');
  assert.equal(dotPart(oneHand), tick / DOT_ROUND_S, 'one hand: the round once per 5 s');

  // A DoT on the OFF hand alone: the off hand hosts the merged entry, and the round is not scaled by its 0.8
  // whole-blown share (a round is not a blow).
  const offOnly = dotPair();
  offOnly.ch.weapon.enchantments = [];
  const offCard = analyze(offOnly.ch, { target, health: gate.maxHealth, weapon: weaponOf(offOnly.main), dual: true, standard });
  assert.equal(dotPart(offCard), tick / DOT_ROUND_S, 'the off hand hosts the one entry, unweighted');

  // Differing magnitudes on the two hands: upstream keeps the incumbent's own magnitude, and the card's incumbent is
  // the main hand's (M37). Swapping which hand carries which row changes the answer, so the host choice is pinned
  // rather than averaged.
  const two = new Map([[1, dotSpell(1, 200)], [2, dotSpell(2, 300)]]);
  const rowItem = (param) => {
    const it = weapon(121, { material: 9 });
    it.enchantments = [{ type: 2, param }];
    return it;
  };
  const tickOf = (param) => strikeEnchantments(rowItem(param), single, target, { level: 30, standard: two }).procDot;
  const small = tickOf(1);
  const big = tickOf(2);
  assert.notEqual(big, small, 'the two rows differ');
  const swapOf = (mainParam, offParam) => {
    const m = rowItem(mainParam);
    const c = simCharacter(character({ level: 30, raceId: 1, skills: 40, online: false }), m);
    c.offWeapon = { ...rowItem(offParam), equipSlot: 21 };
    c._dual = true;
    return c;
  };
  const mainBig = analyze(swapOf(2, 1), { target, health: gate.maxHealth, weapon: weaponOf(rowItem(2)), dual: true, standard: two });
  const offBig = analyze(swapOf(1, 2), { target, health: gate.maxHealth, weapon: weaponOf(rowItem(1)), dual: true, standard: two });
  assert.equal(dotPart(mainBig), big / DOT_ROUND_S, 'the main hand\'s magnitude is the entry');
  assert.equal(dotPart(offBig), small / DOT_ROUND_S, 'swapped: the other hand hosts, and its magnitude is the entry');

  // The allowance is offered ONE dot stream for the pair, at the merged round's size.
  const streams = dual.allowance?.streams ?? [];
  assert.equal(streams.filter((s) => s.kind === 'dot').length, 1, 'one dot stream, not one a hand');
  assert.equal(streams.find((s) => s.kind === 'dot')?.perClaim, tick);
});

test('pin: a single-hand DoT card and a no-DoT pair price the round once (unchanged by 3.7c)', () => {
  const { ch, main, standard } = dotPair();
  const gate = gateTarget(30);
  const target = gate;
  const single = simCharacter(character({ level: 30, raceId: 1, skills: 40, online: false }), main);
  const oneHand = analyze(single, { target, health: gate.maxHealth, weapon: weaponOf(main), standard });
  assert.equal(oneHand.enchantDps, dotPart(oneHand), 'this fixture has no proc damage: the card is its DoT round');

  // A pair with no DoT is untouched: there is no dot term at all, so the enchant figure is exactly its per-blow run.
  const instant = new Map([[1, {
    ...dotSpell(1),
    effects: [{ ...dotSpell(1).effects[0], type: 4, durationBase: 0 }],
  }]]);
  const instantDual = analyze(ch, { target, health: gate.maxHealth, weapon: weaponOf(main), dual: true, standard: instant });
  assert.equal(dotPart(instantDual), 0);
  assert.equal(instantDual.enchantDps, instantDual.enchantPerSwing * instantDual.cadence.aps);
  const bareDual = analyze(ch, { target, health: gate.maxHealth, weapon: weaponOf(main), dual: true });
  assert.equal(dotPart(bareDual), 0);
  assert.equal(bareDual.enchantDps, 0, 'no enchantment, no enchant damage');
});

test('3.7 band: the dual DoT pair\'s enchant and total DPS bands bracket the central value', () => {
  const { ch, main, standard } = dotPair();
  const gate = gateTarget(30);
  const dual = analyze(ch, { target: gate, health: gate.maxHealth, weapon: weaponOf(main), dual: true, standard });
  assert.ok(dual.enchantDpsMin <= dual.enchantDps && dual.enchantDps <= dual.enchantDpsMax,
    `enchantDps ${dual.enchantDps} inside [${dual.enchantDpsMin}, ${dual.enchantDpsMax}]`);
  assert.ok(dual.ceilingTotalDpsMin <= dual.ceilingTotalDps && dual.ceilingTotalDps <= dual.ceilingTotalDpsMax,
    `ceilingTotalDps ${dual.ceilingTotalDps} inside [${dual.ceilingTotalDpsMin}, ${dual.ceilingTotalDpsMax}]`);
  assert.equal(dual.totalDpsMin, null);
  assert.equal(dual.totalDpsMax, null);
});

test('3.7 band: a Pistolet pair claims one merged DoT round and its band brackets it', () => {
  const gun = weapon(562, { material: 4 });
  gun.equipSlot = 19;
  gun.enchantments = [{ type: 2, param: 1 }];
  const ch = simCharacter(character({ level: 30, raceId: 1, skills: 40, online: false }), gun);
  const standard = new Map([[1, dotSpell(1, 200)]]);
  const gate = gateTarget(30);
  const pair = analyze(ch, { target: gate, health: gate.maxHealth, weapon: weaponOf(gun), pair: true, standard });
  const tick = strikeEnchantments(gun, ch, gate, { level: 30, standard }).procDot;
  assert.ok(tick > 0, 'the fixture has a DoT round');
  assert.equal(pair.enchantDps, tick / DOT_ROUND_S, 'the pair claims the merged round once');
  assert.ok(pair.enchantDpsMin <= pair.enchantDps && pair.enchantDps <= pair.enchantDpsMax,
    `enchantDps ${pair.enchantDps} inside [${pair.enchantDpsMin}, ${pair.enchantDpsMax}]`);
  assert.ok(pair.ceilingTotalDpsMin <= pair.ceilingTotalDps && pair.ceilingTotalDps <= pair.ceilingTotalDpsMax,
    `ceilingTotalDps ${pair.ceilingTotalDps} inside [${pair.ceilingTotalDpsMin}, ${pair.ceilingTotalDpsMax}]`);
  assert.equal(pair.totalDpsMin, null);
  assert.equal(pair.totalDpsMax, null);
  assert.equal(pair.totalDps, pair.claimSustainedDps);
  assert.equal(pair.totalTtk, pair.claimTotalTtk);
});

/** The waiver pin's build (and M44's labels): three big instant procs at the level-45 gate. */
const heavyProcs = () => {
  const item = weapon(121, { material: 9 });
  item.enchantments = [{ type: 2, param: 1 }, { type: 2, param: 2 }, { type: 2, param: 3 }];
  const desc = character({
    level: 45, raceId: 1, stats: { strength: 70, agility: 60, speed: 100, luck: 50 }, skills: 100, online: false,
  });
  const ch = simCharacter(desc, item);
  const instant = (index) => ({
    ...dotSpell(index, 1000),
    effects: [{ ...dotSpell(index, 1000).effects[0], type: 4, durationBase: 0 }],
  });
  return { ch, item, standard: new Map([[1, instant(1)], [2, instant(2)], [3, instant(3)]]) };
};

test('Phase 2: raw card totals follow the vendored relay on a saturated proc schedule', async () => {
  // ORACLE: replay the card's existing expected-value schedule through vendored gateBrain.applyHit.
  // This compares selection of the card totals, not how the card estimates the schedule.
  const { ch, item, standard } = heavyProcs();
  const target = gateTarget(45);
  const card = analyze(ch, { target, health: target.maxHealth, weapon: weaponOf(item), standard });
  const claims = expandStreams(card.allowance.streams, 120);
  assert.equal(card.allowance.streams.filter(s => s.kind === 'proc').length, 3);
  const fight = await relayStream({ level: 45, claims, share: target.maxHealth, phases: target.allowance.phases });
  assert.ok(fight.killedAt > card.ceilingTotalTtk * 2, 'the vendored kill is distinct from the ceiling');

  // No phase wards or death to skew steady state: measure between two late, drained bucket reads.
  const long = await relayStream({ level: 45, claims, share: 100000000 });
  const drained = long.rows.filter(r => r.t >= 60 && r.got > 0 && r.bucketAfter === 0);
  const a = drained[0], b = drained.at(-1);
  assert.ok(b.t > a.t + 30, 'a substantial post-burst window');
  const sustained = (b.dealtAfter - a.dealtAfter) / (b.t - a.t);
  assert.ok(card.ceilingTotalDps > sustained * 2, 'the uncapped proc sum is distinct from the paid rate');
  // Keep the old claim fields under test separately from the default fields.
  assert.ok(Math.abs(card.claimTotalTtk - fight.killedAt) < 1e-8);
  assert.ok(Math.abs(card.claimSustainedDps - sustained) < 1e-8);
  assert.ok(Math.abs(card.totalDps - sustained) < 1e-8,
    `raw totalDps ${card.totalDps}, vendored ${sustained}; totalTtk ${card.totalTtk}, vendored ${fight.killedAt}`);
  assert.ok(Math.abs(card.totalTtk - fight.killedAt) < 1e-8);
});

test('Phase 2: ordinary foes keep the old raw totals and bands', () => {
  // Local control: same proc build, but no relay allowance to use.
  const { ch, item, standard } = heavyProcs();
  const card = analyze(ch, { target: referenceFoe(45, 'tough'), health: 12000, weapon: weaponOf(item), standard });
  assert.ok(card.enchantDps > 0);
  assert.equal(card.totalDps, card.cappedDps + card.enchantDps);
  assert.equal(card.totalTtk, (card.health + card.ward) / card.totalDps + card.shields);
  assert.equal(card.totalTtk, card.totalTtkCapOnly);
  assert.equal(card.totalDpsMin, card.cappedDpsMin + card.enchantDpsMin);
  assert.equal(card.totalDpsMax, card.cappedDpsMax + card.enchantDpsMax);
});

test('Phase 2: declared allowance without a run still has no total kill time', () => {
  // Local control: default DPS can fall back, but only explicit ceiling time can do that.
  const { ch, item, standard } = heavyProcs();
  const gate = gateTarget(45);
  const card = analyze(ch, { target: { ...gate, maxHealth: 0 }, weapon: weaponOf(item), standard });
  assert.ok(card.target.allowance);
  assert.equal(card.allowance, null);
  assert.equal(card.totalTtk, null);
  assert.equal(card.totalDps, card.ceilingTotalDps);
  assert.equal(card.totalDpsMin, card.ceilingTotalDpsMin);
  assert.equal(card.totalDpsMax, card.ceilingTotalDpsMax);
  assert.match(buildReport(ch, { target: card.target, weapon: weaponOf(item) }), /no allowance run/);
});

test('waiver pin (W-PROC-BUDGET): the ceiling still prices CWS procs on top of the capped weapon figure', () => {
  // Three big instant procs at the gate saturate the allowance: the ceiling (ttkCapOnly) prices their full summed rate
  // on top of the capped weapon figure, while the allowance can only pay the refill, so the ceiling promises a kill the
  // allowance refuses.
  const { ch, item, standard } = heavyProcs();
  const gate = gateTarget(45);
  const card = analyze(ch, { target: gate, health: gate.maxHealth, weapon: weaponOf(item), standard });
  assert.ok(card.enchantDps > 0, 'the procs price');
  // `ttkCapOnly` is the WEAPON-only ceiling; `totalTtkCapOnly` is the ceiling with the procs summed on top, and
  // `claimTotalTtk` is what the allowance itself grants. The ceiling promises the shorter kill.
  assert.ok(card.allowance?.sustainedDps !== null, 'the fixture runs through the allowance');
  expectKnownDiscrepancy(assert, 'W-PROC-BUDGET', card.totalTtkCapOnly < card.claimTotalTtk, {
    ceilingWithProcsTtk: card.totalTtkCapOnly, allowanceWithProcsTtk: card.claimTotalTtk, enchantDps: card.enchantDps,
    sustainedDps: card.allowance?.sustainedDps ?? null,
  });
});

// ── M44: the labelling split - the ceiling's numbers, and the claim-based run beside them ──────────────────────────

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Run the real CLI in theory mode (no save needed); its default gate target carries the allowance. */
const cli = (cmd, extra = [], json = false) => execFileSync(
  process.execPath,
  [path.join(REPO, 'bin', 'dfo-dps.js'), cmd, '--theory', ...extra, ...(json ? ['--json'] : [])],
  { env: { ...process.env, HOME: os.tmpdir() }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
);
/** `build --json` prints one document; `enchant --json` prints its table first (existing behaviour). */
const cliJson = (cmd, extra = []) => {
  const out = cli(cmd, extra, true);
  const at = out.startsWith('{') ? 0 : out.indexOf('\n{') + 1;
  assert.ok(at >= 0, `${cmd}: a JSON document in the output`);
  return JSON.parse(out.slice(at));
};

test('M44: the ceiling aliases are the same numbers as the fields they name', () => {
  const g30 = gateTarget(30);
  const { ch, main, standard } = dotPair();
  const single = simCharacter(character({ level: 30, raceId: 1, skills: 40, online: false }), main);
  const one = analyze(single, { target: g30, health: g30.maxHealth, weapon: weaponOf(main), standard });
  const dual = analyze(ch, { target: g30, health: g30.maxHealth, weapon: weaponOf(main), dual: true, standard });
  const { ch: pinCh, item: pinItem, standard: pinStd } = heavyProcs();
  const g45 = gateTarget(45);
  const pin = analyze(pinCh, { target: g45, health: g45.maxHealth, weapon: weaponOf(pinItem), standard: pinStd });

  for (const [name, card] of [['single-hand DoT', one], ['dual DoT pair', dual], ['waiver pin', pin]]) {
    assert.equal(card.ceilingTotalDps, card.cappedDps + card.enchantDps, `${name}: ceiling still sums weapon and procs`);
    assert.equal(card.ceilingTotalTtk, card.totalTtkCapOnly, `${name}: ceilingTotalTtk is totalTtkCapOnly`);
    assert.equal(card.claimTotalTtk, card.allowance.ttk, `${name}: claimTotalTtk is the allowance run's own ttk`);
    assert.equal(card.claimSustainedDps, card.allowance.sustainedDps, `${name}: claimSustainedDps is allowance.sustainedDps`);
    assert.equal(card.totalDps, card.claimSustainedDps, `${name}: default DPS is sustained`);
    assert.equal(card.totalTtk, card.claimTotalTtk, `${name}: default TTK is the claim result`);
  }
  assert.equal(pin.claimTotalTtk, pin.totalTtk, 'when the allowance kills, the existing totalTtk IS the claim figure');

  // No allowance spec: there is no claim run, so the claim aliases say so instead of borrowing the ceiling.
  const noRelay = analyze(single, { target: referenceFoe(30, 'tough'), health: 5000, weapon: weaponOf(main) });
  assert.equal(noRelay.allowance, null);
  assert.equal(noRelay.claimTotalTtk, null);
  assert.equal(noRelay.claimSustainedDps, null);
  assert.equal(noRelay.ceilingTotalTtk, noRelay.totalTtkCapOnly);
});

test('M44: the ceiling can promise a kill the allowance refuses - named, and printed beside it', () => {
  const { ch, item, standard } = heavyProcs();
  const gate = gateTarget(45);
  const card = analyze(ch, { target: gate, health: gate.maxHealth, weapon: weaponOf(item), standard });
  assert.ok(card.ceilingTotalTtk < card.claimTotalTtk,
    `ceiling ${card.ceilingTotalTtk.toFixed(2)} s < allowance-sustained ${card.claimTotalTtk.toFixed(2)} s`);
  assert.ok(card.claimTotalTtk > card.ceilingTotalTtk * 2, 'more than twice as long: not a rounding difference');

  // The HTML report labels both figures on the card...
  const html = buildReport(ch, { target: gate, health: gate.maxHealth, weapon: weaponOf(item) });
  assert.match(html, /Total \(per-hit-capped ceiling\)/);
  assert.match(html, /Allowance-sustained DPS/);
  assert.match(html, /ceiling: [\d.]+ s/, 'the time-to-kill card names the ceiling figure');
  // ...and says what the gap means on a build whose weapon blows the allowance cannot pay (a no-proc build: the gap
  // is the allowance-only clipping, not a proc sum).
  const geared = theoryCharacter({ level: 45, gearLB: 240, gearCS: 540, damagePct: 40, sockets: perfectSockets(123), martialPath: 'blademaster' });
  const bound = buildReport(geared, { target: gate, health: gate.maxHealth });
  assert.match(bound, /Ceiling vs allowance/, 'the divergence note is printed');
  assert.match(bound, /the ceiling can promise a kill the allowance refuses/, 'and it names the direction');

  // The CLI table labels them the same way, and its JSON carries the split as new fields.
  const text = cli('build');
  assert.match(text, /Allowance-sustained DPS/);
  assert.match(text, /Ceiling vs allowance/);
  assert.match(text, /allowance-sustained [\d.]+ s/, 'the CLI prints the claim-based kill time');
  const build = cliJson('build').result;
  assert.equal(build.ceilingTotalDps, build.cappedDps + build.enchantDps, 'ceilingTotalDps keeps the old sum');
  assert.equal(build.totalDps, build.claimSustainedDps);
  assert.equal(build.totalTtk, build.claimTotalTtk);
  assert.equal(build.totalTtkCapOnly, build.ceilingTotalTtk);
  assert.equal(build.totalDpsMin, null);
  assert.equal(build.totalDpsMax, null);
  assert.ok(build.ceilingTotalDpsMin <= build.ceilingTotalDps && build.ceilingTotalDps <= build.ceilingTotalDpsMax);
  assert.equal(typeof build.ceilingTotalTtk, 'number', 'ceilingTotalTtk is exported');
  assert.ok(build.claimTotalTtk >= build.ceilingTotalTtk, 'the saturated theory build: the claim figure is not shorter than the ceiling');
  assert.equal(typeof build.claimSustainedDps, 'number', 'claimSustainedDps is exported');
  const enchantText = cli('enchant', [], true);
  const enchant = JSON.parse(enchantText.slice(enchantText.indexOf('\n{') + 1)).result;
  assert.equal(enchant.totalDps, enchant.claimSustainedDps);
  assert.equal(enchant.totalTtk, enchant.claimTotalTtk);
  assert.ok(enchant.ceilingTotalDps > enchant.totalDps);
  assert.equal(Number(enchantText.match(/Total \(per-hit-capped ceiling\)\s+([\d.]+)/)?.[1]), Number(enchant.ceilingTotalDps.toFixed(1)));
  assert.equal(Number(enchantText.match(/Allowance-sustained DPS\s+([\d.]+)/)?.[1]), Number(enchant.totalDps.toFixed(1)));
  assert.equal(typeof enchant.claimTotalTtk, 'number');
});

test('Phase 2: a censored kill stays null in the raw card and CLI JSON', () => {
  const { ch, item } = heavyProcs();
  const gate = gateTarget(45, { health: 100000000 });
  const card = analyze(ch, { target: gate, health: gate.maxHealth, weapon: weaponOf(item) });
  assert.ok(card.allowance, 'the allowance run exists - it just never kills inside the horizon');
  assert.equal(card.claimTotalTtk, null, 'the run killed nothing: no claim figure');
  assert.ok(Number.isFinite(card.ceilingTotalTtk) && card.ceilingTotalTtk > 0, 'the ceiling still has a finite kill time');
  assert.equal(card.totalTtk, null, 'no ceiling fallback for a censored kill');
  assert.equal(card.claimSustainedDps, card.allowance.sustainedDps, 'the sustained figure exists even when the kill does not');
  assert.equal(card.totalDps, card.claimSustainedDps);

  const html = buildReport(ch, { target: gate, health: gate.maxHealth, weapon: weaponOf(item) });
  assert.match(html, /Time to kill \(allowance-sustained\)/);
  assert.match(html, /no kill/);
  assert.match(html, /the allowance-sustained run never kills/);

  const text = cli('build', ['--health', '100000000']);
  assert.match(text, /no kill/, 'the CLI says the claim run never kills, not "-"');
  assert.match(text, /the allowance-sustained run never kills/);
  const json = cliJson('build', ['--health', '100000000']).result;
  assert.equal(json.claimTotalTtk, null);
  assert.ok(Number.isFinite(json.ceilingTotalTtk));
  assert.equal(json.totalTtk, null, 'the JSON totalTtk stays censored');
  assert.equal(json.totalDps, json.claimSustainedDps);
});

test('M44: the gap note names its direction - the ceiling is not always the shorter figure', () => {
  // A level-45 gate at 1,000 HP: the run kills within/just after the first shield, so the card's flat +6 s is not paid
  // and the allowance-sustained figure is the SHORTER one. The fixed "promises a kill" sentence would be a lie there.
  const weak = theoryCharacter({ level: 45, rawBlade: 100, rawCrit: 50, rawBackstab: 100, blade: 121 });
  weak.masteredSkills = [];
  const gate = gateTarget(45, { health: 1000 });
  const card = analyze(weak, { target: gate, health: 1000 });
  assert.ok(card.claimTotalTtk < card.ceilingTotalTtk,
    `claim ${card.claimTotalTtk.toFixed(2)} s < ceiling ${card.ceilingTotalTtk.toFixed(2)} s`);

  const html = buildReport(weak, { target: gate, health: 1000 });
  assert.match(html, /ceiling and allowance-sustained differ by \d+%/);
  assert.doesNotMatch(html, /the ceiling can promise a kill the allowance refuses/);

  const text = cli('build', ['--health', '1000']);
  assert.match(text, /ceiling and allowance-sustained differ by \d+%/);
  assert.doesNotMatch(text, /the ceiling can promise a kill the allowance refuses/);

  // The other direction keeps the fixed sentence (same build, 2,000 HP: the run outlasts the ceiling).
  const long = cli('build', ['--health', '2000']);
  assert.match(long, /the ceiling can promise a kill the allowance refuses/);
  assert.doesNotMatch(long, /differ by/);
});

test('M44: without an allowance the kill time is labelled as the per-hit-capped ceiling', () => {
  const weak = theoryCharacter({ level: 45, rawBlade: 100, rawCrit: 50, rawBackstab: 100, blade: 121 });
  weak.masteredSkills = [];
  const foe = referenceFoe(45, 'tough');
  const html = buildReport(weak, { target: foe, health: 5000 });
  assert.match(html, /Time to kill \(per-hit-capped ceiling\)/);

  const text = cli('build', ['--target', 'tough', '--health', '5000']);
  assert.match(text, /Time to kill \(per-hit-capped ceiling\)/);
  const enchant = cliJson('enchant', ['--target', 'tough']).result;
  assert.equal(enchant.totalDps, enchant.ceilingTotalDps);
  assert.equal(enchant.claimSustainedDps, null);

  // No boss health at all: the row is a placeholder (fmt(null) is '-'), never "null"/"NaN".
  const bare = cli('build', ['--target', 'tough']);
  assert.match(bare, /Time to kill \(per-hit-capped ceiling\)/);
  assert.match(bare, /Time to kill \(per-hit-capped ceiling\)\s+-\s+no boss health/, "fmt(null) renders '-'");
  assert.doesNotMatch(bare, /null|NaN/);
});
