import * as F from '../src/simulateFight.js';
import { referenceFoe, syntheticWeapon } from '../src/model.js';
import { theoryCharacter } from '../src/theory.js';
import { character, simCharacter, weapon } from '../test/harness/fixtures.mjs';
import { encodeValue as V } from './rust-codec.mjs';

export function genSimulateFight(Out, records, standard) {
  const out = new Out('simulate_fight', 'R6b seeded full rows and batch summaries', true);
  out.add('book', V(records));
  const put = (kind, args, value) => out.add(kind, ...args.map(V), '=>', V(value));
  const result = f => { try { return f(); } catch (e) { return e.message; } };
  const templates = [113, 117, 119, 121, 124, 125, 126, 127];
  const item = (template, material, condition) => ({ ...syntheticWeapon(template, material).item,
    maxCondition: 100, currentCondition: condition });
  const rows = [240, 241, 242, 244, 9999];
  const chars = [];
  const cases = [];
  for (let i = 0; i < 216; i++) {
    const level = 1 + i % 23;
    const ch = theoryCharacter({ level, blade: templates[i % templates.length], rawBlade: 105 + i % 78, race: 1 + i % 8, online: !!(i & 4) });
    const dur = !!(i & 1);
    ch.weapon = item(templates[i % templates.length], i % 10, [0, 1, 9, 10, 11, 20, 21, 99, 300][i % 9]);
    ch._dual = !!(i & 2);
    ch.offWeapon = ch._dual ? item(templates[(i * 3 + 1) % 5], (i + 5) % 10, [4, 50, 11, 140, 20][i % 5]) : null;
    if (i % 4 !== 0) ch.weapon.enchantments = [rows[i % 5], rows[(i + 1) % 5]].map(param => ({ type: 2, param }));
    if (ch.offWeapon && i % 5 === 0) ch.offWeapon.enchantments = [{ type: 2, param: 241 }];
    if (i % 11 === 0) Object.assign(ch.weapon, { rarity: 'legendary', legendary: 'shalidors-brand' });
    if (i % 12 === 0) {
      ch.weapon.equipSlot = 0;
      ch.worn = [ch.weapon];
    }
    chars.push(ch);
    const target = { ...referenceFoe(level, ['tough', 'human', 'standard'][i % 3]), warded: i % 19 === 0,
      activeEffects: i % 9 ? [] : [{ kind: 'spellReflection', chance: 19 }, { kind: 'spellResistance', chance: 23 }] };
    const opts = { target, health: [1, 24, 76, 111, 217, 360, 998][i % 7],
      durability: dur, trace: i % 17 !== 0, carry: [true, false, undefined, null][i % 4],
      core: i % 3 ? 'overhaul' : 'classic',
      maxBlows: [1, 4, 7, 12, 20, 45][i % 6], maxSeconds: [0, 1, 4.5, 10, 22, 45, 26][i % 7],
      backstabUptime: [0, 0.3, 1][i % 3], backstabChance: 44, damageMode: i % 6 ? 'uncapped' : 'capped',
      imprint: i % 5 ? { kind: 'execute', below: 25 + i % 60, pct: 33 } : { kind: 'echo', chance: 100 },
      potencyPct: i % 37, pierce: i % 13, trials: 10, seed: i % 2 ? -i * 1081 : i * 9241 };
    cases.push(opts);
    const got = F.simulateFights(ch, { ...opts, standard });
    put('batch', [ch, opts], got);
    if (i % 6 === 0) {
      const first = got.rows[0], last = got.rows.at(-1);
      const seeds = [last.seed, first.seed, last.seed];
      const again = F.simulateFights(ch, { ...opts, standard, seeds });
      for (const row of again.rows) {
        if (V(row) !== V(F.simulateFight(ch, { ...opts, standard, seed: row.seed }))) throw new Error('JS batch/standalone mismatch');
      }
      put('reuse', [ch, { ...opts, seeds }], again);
      const edit = { seed: first.seed, maxSeconds: 17, maxBlows: 4, health: 123, carry: !opts.carry, imprint: { kind: 'echo', chance: 100 } };
      put('with', [ch, { ...opts, seed: first.seed }, edit], first.with(edit));
    }
  }
  for (const [n, seed] of [[0, 0], [-1, 7], [1, 0], [2, -1], [5, 2 ** 32], [31, -(2 ** 40)], [9, Number.MAX_SAFE_INTEGER],
    ['4.9', '13'], [null, 1], [2.9, 0.5], [NaN, 2], [7, Number.MIN_SAFE_INTEGER], [10, 2 ** 53]]) {
    put('seeds', [n, seed], F.pairedFightSeeds(n, seed));
  }
  for (const [bounds, x] of [[[1, 0.75, 0.5, 0], 0.5], [[1, 0.5, 0.15, 0], NaN], [[1, 0.5, 0], -1], [[1, 0.5, 0], 2], [[1, 0.5, 0], 0.49]]) {
    put('segment', [bounds, x], F.healthSegment(bounds, x));
  }
  for (const xs of [[], [NaN, Infinity, null, '3'], [-0], [0, -0], [-0, 0], [1, 9], [1, 16, 3, 4, 8, 19], [1e-19, -1e20, 1e20, -1, 16, 5e-14], [1e308, 1e308]]) {
    for (const opts of [{}, { p10: -1, p90: 2 }, { p10: null, p90: NaN }, { p10: Infinity, p90: -Infinity }]) put('summary', [xs, opts], F.summarize(xs, opts));
  }
  for (const n of [-1, 0, 1, 3, 15, 999]) for (const k of [0, 1, n, n / 3]) for (const z of [0, 1.96, -1.5, 3.1]) {
    put('wilson', [k, n, z], F.wilsonInterval(k, n, z));
  }
  for (let n = 1; n < 256; n++) {
    const z = 1.96, t = z * z, den = 1 + t / n;
    if ((1 + t / (2 * n)) / den + z * Math.sqrt(t / (4 * n * n)) / den > 1) {
      put('wilson', [n, n, z], F.wilsonInterval(n, n, z));
      break;
    }
  }
  put('durability', [[]], F.durabilityStats([]));
  for (const [i, template] of [113, 117, 123, 129, 130, 560, 562].entries()) {
    for (const bowDrawback of [false, true]) {
      const ch = { ...chars[5 + i], weapon: item(template, 2, 50) };
      const opts = { ...cases[5 + i], bowDrawback };
      put('schedule', [ch, opts], result(() => {
        const schedule = F.createAttackSchedule(ch, { ...opts, standard });
        return schedule && [schedule.health, schedule.assumptions, schedule.probe.healthShare, Array.from({ length: 18 }, () => schedule.next())];
      }));
    }
  }
  const ch = chars[1], opts = cases[1];
  for (const [actor, args] of [[ch, { pair: true }], [{ ...ch, _pair: true }, {}], [ch, {}]]) {
    put('schedule', [actor, args], result(() => {
      const schedule = F.createAttackSchedule(actor, { ...args, standard });
      return [schedule.health, schedule.assumptions, schedule.probe.healthShare, Array.from({ length: 18 }, () => schedule.next())];
    }));
    put('single', [actor, { ...args, health: 5 }], result(() => F.simulateFight(actor, { ...args, health: 5, standard })));
  }
  for (const edit of [{ pair: true }, { seed: null }, { seed: '1' }, { seed: 2 ** 53 }, { health: 0 },
    { cwsRolls: false }, { conditionRolls: null }, { target: { ...opts.target, relayBody: 1 } },
    ...['isBoss', 'phaseShields', 'shieldPool', 'revenant', 'bout', 'companion', 'spareGear', 'hitCap'].map(key => ({ target: { ...opts.target, [key]: true } })),
    { target: { ...opts.target, bossTraits: ['x'] } }, { traits: ['x'] }, { weapon: syntheticWeapon(129, 3) },
    { weapon: null }, { maxBlows: -3, maxSeconds: 40 }, { maxBlows: 4 }]) {
    put('single', [ch, { ...opts, ...edit }], result(() => F.simulateFight(ch, { ...opts, ...edit, standard })));
  }
  put('single', [chars[0], { target: opts.target, health: 10 }], F.simulateFight(chars[0], { target: opts.target, health: 10, standard }));
  const scripted = { ...opts, health: 170, maxSeconds: 27, maxBlows: 20, seed: -19 };
  const log = [[], []];
  const draw = i => () => {
    const r = ((log[i].length * 37 + i * 13) % 100) / 100;
    log[i].push(r);
    return r;
  };
  const scriptedRow = F.simulateFight(ch, { ...scripted, standard, cwsRolls: draw(0), conditionRolls: draw(1) });
  put('script', [ch, scripted, log], scriptedRow);
  const specialCh = { ...chars[0], worn: [], weapon: { ...item(113, 9, 20), minDamage: 8, maxDamage: 8,
    enchantments: [{ type: 2, param: 240 }, { type: 2, param: 242 }, { type: 2, param: 9999 }] } };
  const specialOpts = { target: { ...referenceFoe(1, 'human'), activeEffects: [] }, health: 1, durability: true,
    trace: true, backstabUptime: 0, core: 'classic', seeds: [0, 1, 2, 3, 4, 5, 6], imprint: { kind: 'echo', chance: 100 } };
  const billBatch = F.simulateFights(specialCh, { ...specialOpts, standard });
  if (!billBatch.rows.some(row => row.breaks.some(b => b.afterKill && !b.again))) throw new Error('R6b: no distinct post-kill bill break');
  put('extraBatch', [specialCh, specialOpts], billBatch);
  const hit = F.createAttackSchedule(specialCh, { ...specialOpts, standard }).next().t;
  for (const maxSeconds of [hit, hit - Number.EPSILON]) {
    const onHorizon = { ...specialOpts, maxSeconds };
    put('extraBatch', [specialCh, onHorizon], F.simulateFights(specialCh, { ...onHorizon, standard }));
  }
  const plain = { ...specialCh, weapon: item(113, 2, 100) };
  const defaultBatch = { health: 10, maxSeconds: 0 };
  put('extraBatch', [plain, defaultBatch], F.simulateFights(plain, { ...defaultBatch, standard }));
  const long = { health: 1e16, maxSeconds: 3e6, carry: false };
  put('single', [plain, long], F.simulateFight(plain, { ...long, standard }));
  const levelMissing = { ...specialCh, level: undefined };
  put('extraBatch', [levelMissing, specialOpts], F.simulateFights(levelMissing, { ...specialOpts, standard }));
  const unminted = { ...plain, weapon: { ...plain.weapon, maxCondition: 0, currentCondition: 0 } };
  const unmintedOpts = { ...specialOpts, health: 100, maxSeconds: 3, seed: 0 };
  put('single', [unminted, unmintedOpts], F.simulateFight(unminted, { ...unmintedOpts, standard }));
  const active = { kind: 'continuousDamage', effect: records.find(sp => sp.index === 241).effects[0], caster: null,
    casterLevel: 10, roundsRemaining: 2, spellPower: 10, element: 4, flag: 16, saveScaled: false, spell: 'Already active', index: 241 };
  for (const maxSeconds of [1, 5, 15]) {
    const oo = { ...specialOpts, target: { ...specialOpts.target, activeEffects: [active] }, health: 700, maxSeconds, maxBlows: 1 };
    put('extraBatch', [specialCh, oo], F.simulateFights(specialCh, { ...oo, standard }));
  }
  const echoHand = { rarity: 'rare', imprint: 'warp-edge' };
  const dualCh = { ...plain, _dual: true, stats: { ...plain.stats, strength: 15, speed: 70 },
    weapon: { ...item(113, 9, 100), ...echoHand }, offWeapon: { ...item(125, 9, 1), ...echoHand } };
  const dualOpts = { ...specialOpts, health: 1000, seeds: Array.from({ length: 24 }, (_, i) => i), maxBlows: 8 };
  put('extraBatch', [dualCh, dualOpts], F.simulateFights(dualCh, { ...dualOpts, standard }));
  const inactiveDual = { ...dualCh, _dual: false };
  put('extraBatch', [inactiveDual, dualOpts], F.simulateFights(inactiveDual, { ...dualOpts, standard }));
  const one = { ...dualOpts, seeds: undefined, trials: 0, maxSeconds: 0 };
  put('extraBatch', [plain, one], F.simulateFights(plain, { ...one, standard }));
  put('durability', [[{ weaponsBroken: 3, breaks: [], time: 1, condition: {}, conditionPct: {} }]],
    F.durabilityStats([{ weaponsBroken: 3, breaks: [], time: 1, condition: {}, conditionPct: {} }]));
  const rangedPair = { ...specialOpts, pair: true, weapon: syntheticWeapon(129, 3) };
  put('single', [plain, rangedPair], result(() => F.simulateFight(plain, { ...rangedPair, standard })));
  const custom = { ...syntheticWeapon(121, 8), min: 23, max: 25 };
  for (const durability of [true, false]) {
    const override = { ...specialOpts, durability, weapon: custom, health: 400, maxBlows: 3 };
    put('extraBatch', [dualCh, override], F.simulateFights(dualCh, { ...override, standard }));
  }
  const tieWeapon = { ...weapon(121, { material: 9 }), enchantments: [{ type: 2, param: 241 }] };
  const tieCh = simCharacter(character({ level: 30, raceId: 1,
    stats: { strength: 70, agility: 60, speed: 60, luck: 50 }, skills: 0,
    skillOverride: { 29: 70, 34: 40, 19: 50 } }), tieWeapon);
  const tieArgs = { target: referenceFoe(30, 'tough'), health: 1e6, seed: 2, trace: true, maxSeconds: 12,
    attackSpeedPct: 17.159183673469394 };
  const tied = F.simulateFight(tieCh, { ...tieArgs, standard });
  if (!tied.trace.some(e => e.t === 5) || !tied.cwsTrace.some(e => e.round && e.t === 5)) throw new Error('R6b: no blow/round tie');
  put('single', [tieCh, tieArgs], tied);
  const probe = (ch, args) => F.simulateFight(ch, { ...args, standard });
  const emit = (ch, args, row = probe(ch, args)) => put('single', [ch, args], row);
  const find = (ch, args, predicate) => {
    for (let seed = 0; seed < 64; seed++) {
      const input = { ...args, seed };
      const row = probe(ch, input);
      if (predicate(row, input)) return emit(ch, input, row);
    }
    throw new Error(`R6b: no boundary row for ${predicate}`);
  };
  const light = { ...plain, stats: { ...plain.stats, strength: 50 }, weapon: { ...item(113, 2, 100), minDamage: 1, maxDamage: 1 } };
  const short = { ...specialOpts, maxBlows: 1, maxSeconds: 1, carry: false, critDamage: false, swing: 'neutral' };
  for (const dual of [false, true]) for (const _dual of [false, true]) for (const offWeapon of [null, item(117, 2, 100)]) {
    emit({ ...light, _dual, offWeapon }, { ...short, dual });
  }
  emit(light, { ...short, weapon: { ...syntheticWeapon(113, 2), item: specialCh.weapon } });
  const infiniteCondition = { ...plain, weapon: { ...plain.weapon, currentCondition: Infinity } };
  find(infiniteCondition, short, row => row.trace[0]?.strikesDamage >= 5);
  find(plain, { ...short, durability: false, potencyPct: 0, potentVs: Number.MAX_VALUE, imprint: null,
    imprints: [{ kind: 'echo', chance: 100 }, { kind: 'echo', chance: 99 }] },
  row => row.trace[0]?.echoHits === 2 && row.trace[0].echoDamage === 0);
  find(light, { ...short, durability: false }, row => row.killSource === 'echo' && row.echoDamage === 1);
  const billCh = { ...light, weapon: { ...light.weapon, currentCondition: 15, enchantments: specialCh.weapon.enchantments } };
  for (const imprint of [null, short.imprint]) {
    find(billCh, { ...short, imprint }, (row, input) => row.breaks.some(b => b.afterKill && !b.again)
      && row.trace[0].echoSuppressed === !!imprint
      && probe(billCh, { ...input, durability: false }).trace[0]?.echoDamage === Number(!!imprint));
  }
  const lethalRound = { ...active, effect: { ...active.effect, magnitudeBaseLow: 100000, magnitudeBaseHigh: 100000 } };
  const lethalTieArgs = { ...tieArgs, durability: true, target: { ...tieArgs.target, activeEffects: [lethalRound] }, health: 1000 };
  let breakOnTie = false;
  for (let seed = 0; seed < 24 && !breakOnTie; seed++) for (let condition = 1; condition <= 40; condition++) {
    const actor = { ...tieCh, worn: [], weapon: { ...tieWeapon, maxCondition: 100, currentCondition: condition, enchantments: [] } };
    const input = { ...lethalTieArgs, seed, maxSeconds: 5 };
    const row = probe(actor, input);
    if (row.killSource === 'dot' && row.ttk === 5 && row.trace.some(e => e.t === 5 && e.broke)) {
      emit(actor, input, row);
      breakOnTie = true;
      break;
    }
  }
  if (!breakOnTie) throw new Error('R6b: no weapon break at the lethal round tie');
  const missingCondition = { ...light, weapon: { ...light.weapon, currentCondition: undefined } };
  find(missingCondition, short, row => {
    const hit = row.trace[0];
    return hit?.strikesDamage > 0 && hit.strikesDamage < 5 && hit.wear === 0 && hit.condition === null;
  });

  // Put the same item echo on both hands. A breaking off hand can keep it, and
  // promotion then owes both the flight tail and any whole held ticks.
  const heldArgs = { ...dualOpts, trace: true, health: 1e5, maxBlows: 18, maxSeconds: 30, imprint: null };
  const needed = new Set(['zero echo hits', 'one echo hit', 'held promotion']);
  for (let condition = 1; condition <= 20 && needed.size; condition++) {
    const actor = { ...dualCh, weapon: { ...item(113, 9, 1000), ...echoHand },
      offWeapon: { ...item(118, 9, condition), ...echoHand } };
    const schedule = F.createAttackSchedule(actor, { ...heldArgs, standard });
    const events = Array.from({ length: heldArgs.maxBlows }, () => schedule.next());
    for (let seed = 0; seed < 32 && needed.size; seed++) {
      const input = { ...heldArgs, seed };
      const row = probe(actor, input);
      const i = row.trace.findIndex(e => e.hand === 'off' && e.broke);
      if (i < 0 || !row.trace[i + 1]) continue;
      const hit = row.trace[i];
      const zero = !hit.echoSuppressed && hit.echoHits === 0 && needed.delete('zero echo hits');
      const one = !hit.echoSuppressed && hit.echoHits === 1 && hit.echoDamage > 0 && needed.delete('one echo hit');
      const held = events[i].holdTicks > 0 && needed.delete('held promotion');
      if (zero || one || held) emit(actor, input, row);
    }
  }
  if (needed.size) throw new Error(`R6b: no break probe for ${[...needed].join(', ')}`);
  const entries = [{ id: 'caster', ch: chars[1] }, { id: 'no-caster', ch: chars[0] }];
  const paired = { ...opts, trials: 3, health: 53, maxSeconds: 10 };
  for (const p of [paired, { ...paired, seeds: [0, -100, 0, 20] }, { ...paired, seeds: [] }]) {
    put('paired', [entries, p], result(() => F.simulatePairedFights(entries, { ...p, standard })));
  }
  put('paired', [[], paired], result(() => F.simulatePairedFights([], { ...paired, standard })));
  const edit = { trials: 2, seed: 47, maxSeconds: 1.23, carry: false };
  put('batchWith', [ch, opts, edit], F.simulateFights(ch, { ...opts, standard }).with(edit));
  return out.write();
}
