import { simulateRelayFight, simulateRelayFights } from '../src/relayFight.js';
import { encounterTarget, ENCOUNTER_IDS, purseOf } from '../src/encounters.js';
import { simulatePurse } from '../src/purse.js';
import { createFlowState } from '../src/flowState.js';
import { gateTarget, referenceFoe, syntheticWeapon } from '../src/model.js';
import { evaluateObjective, pairedDifference, rankBuilds, OBJECTIVE_IDS, STOCHASTIC_OBJECTIVE_IDS } from '../src/objectives.js';
import { pairedFightSeeds } from '../src/simulateFight.js';
import { spellsByIndexMap } from '../src/spells.js';
import { theoryCharacter } from '../src/theory.js';
import { encodeValue as V } from './rust-codec.mjs';

export function genRelayFight(Out, records, standard) {
  const direct = records.find(sp => sp.index === 242).effects[0];
  const fixed = (magnitude, extra = {}) => ({ ...direct, magnitudeBaseLow: magnitude, magnitudeBaseHigh: magnitude, magnitudeLevelBase: 0, magnitudeLevelHigh: 0, ...extra });
  records = [...records, { index: 246, name: 'fractional self cast', rangeType: 0, element: 0, effects: [fixed(1.75)] },
    { index: 247, name: 'level step', rangeType: 0, element: 0, effects: [fixed(8, { magnitudeLevelBase: 8, magnitudeLevelHigh: 8, magnitudePerLevel: 2 })] }];
  standard = spellsByIndexMap(records);
  const out = new Out('relay_fight', 'R7 seeded relay and encounter vectors', true);
  out.add('book', V(records));
  const put = (kind, input, f) => {
    let want;
    try { want = f(); } catch (e) { want = e.message; }
    out.add(kind, ...input.map(V), '=>', V(want));
  };
  const templates = [113, 117, 119, 121, 124, 125, 126, 127];
  const item = (template, material) => syntheticWeapon(template, material).item;
  const dot = { kind: 'continuousDamage', effect: records.find(sp => sp.index === 241).effects[0], caster: null,
    casterLevel: 10, roundsRemaining: 2, spellPower: 10, element: 4, flag: 16, saveScaled: false, spell: 'Already active', index: 241 };
  for (let i = 0; i < 216; i++) {
    const level = 1 + i % 65;
    const template = templates[i % templates.length];
    const ch = theoryCharacter({ level, blade: template, rawBlade: 120 + i % 70, race: 1 + i % 8, online: !!(i & 4) });
    ch.weapon = { ...item(template, i % 10) };
    ch._dual = !!(i & 2);
    ch.offWeapon = ch._dual ? { ...item(templates[i % 5], (i + 5) % 10) } : null;
    if (i % 4) ch.weapon.enchantments = [240, 241, 242, 244, 9999].filter((_, k) => (i + k) % 3 === 0).map(param => ({ type: 2, param }));
    if (ch.offWeapon && i % 5 === 0) Object.assign(ch.offWeapon, { rarity: 'legendary', legendary: 'anseis-edge', enchantments: [{ type: 2, param: 241 }] });
    if (i % 7 === 0) Object.assign(ch.weapon, { rarity: 'legendary', legendary: 'anseis-edge' });
    if (i % 13 === 0 && ch.offWeapon) Object.assign(ch.offWeapon, { rarity: 'rare', imprint: 'warp-edge' });
    const id = ENCOUNTER_IDS[i % 3];
    const tOpts = { players: [1, 2, 3.4, 0, -3][i % 5], traits: i % 13 === 0 ? ['spellproof'] : null };
    const target = i % 4 ? encounterTarget(id, level, tOpts) : gateTarget(level, { ...tOpts, blowX: 1 + i % 3 });
    if (i < 72) put('target', [id, level, tOpts], () => encounterTarget(id, level, tOpts));
    target.warded = i % 17 === 0;
    target.activeEffects = i % 11 === 0 ? [dot, { ...dot, roundsRemaining: 1, element: 0 }] : [];
    const opts = { target, health: [1, 24, 76, 111, 217, 360, 998, undefined][i % 8],
      trace: i % 9 !== 0, traceAll: i % 7 !== 0, carry: [true, false, undefined, null][i % 4],
      core: i % 3 ? 'overhaul' : 'classic', maxBlows: [1, 4, 7, 12, 20, 45][i % 6],
      maxSeconds: [0, 1, 4.5, 10, 22, 45, 26][i % 7], fresh: i % 5 !== 0,
      shieldUntil: [0, 0.2, 1, 5, 7, -1][i % 6], imprint: i % 5 ? { kind: 'execute', below: 25 + i % 60, pct: 33 } : { kind: 'echo', chance: 100 },
      potencyPct: i % 37, pierce: i % 13, trials: 10, seed: i % 2 ? -i * 1081 : i * 9241 };
    const batch = simulateRelayFights(ch, { ...opts, standard });
    put('batch', [ch, opts], () => batch);
    if (i % 6 === 0) {
      const seeds = [batch.seeds.at(-1), batch.seeds[0], batch.seeds.at(-1)];
      const args = { ...opts, seeds };
      const reuse = simulateRelayFights(ch, { ...args, standard });
      for (const row of reuse.rows) {
        if (V(row) !== V(simulateRelayFight(ch, { ...opts, seed: row.seed, standard }))) throw new Error('JS batch/standalone mismatch');
      }
      put('reuse', [ch, args], () => reuse);
    }
  }
  const ch = theoryCharacter({ level: 35, blade: 121, rawBlade: 160 });
  ch.weapon = { ...item(121, 9), enchantments: [{ type: 2, param: 240 }, { type: 2, param: 241 }, { type: 2, param: 9999 }], rarity: 'legendary', legendary: 'anseis-edge' };
  const target = gateTarget(35, { traits: ['flameproof', 'spellproof'] });
  const opts = { target, health: 600, maxSeconds: 21, trace: true, traceAll: true, seed: -11 };
  for (const edit of [{ durability: true }, { health: 0 }, { target: null }, { weapon: syntheticWeapon(129, 9) }, { weapon: null }, { seed: null }, { seed: '1' }, { seed: 2 ** 53 }, { cwsRolls: false }, { events: [] }, { imprint: { kind: 'echo', chance: 25 }, imprints: [{ kind: 'echo', chance: 50 }] }, { target: { ...target, relayBody: 1 }, imprint: { kind: 'echo', chance: 50 } }]) {
    const a = { ...opts, ...edit };
    put('single', [ch, a], () => simulateRelayFight(ch, { ...a, standard }));
  }
  for (const seeds of [[], [0, 0.5], [1, 2, 2]]) {
    put('extraBatch', [ch, { ...opts, seeds, carryState: {} }], () => simulateRelayFights(ch, { ...opts, seeds, carryState: new Map(), standard }));
  }
  for (const a of [{ ...opts, maxBlows: 1, maxSeconds: 0, seed: undefined, trials: 0 },
    { ...opts, maxBlows: 1, maxSeconds: 0, seed: undefined },
    { ...opts, maxBlows: 1, maxSeconds: undefined, seeds: [1] }]) {
    put('extraBatch', [ch, a], () => simulateRelayFights(ch, { ...a, standard }));
  }
  const ranged = { ...ch, offWeapon: item(129, 9) };
  for (const [actor, a] of [[ranged, { ...opts, pair: true }], [ch, { ...opts, seed: undefined }],
    [ch, { ...opts, health: undefined, target: { allowance: {} } }],
    [ch, { ...opts, target: { ...target, allowance: {} } }],
    [ch, { ...opts, target: { ...target, relayBody: false } }],
    [ch, { ...opts, imprint: { kind: 'flow', pct: 12 }, weapon: syntheticWeapon(113, 9) }]]) {
    put('single', [actor, a], () => simulateRelayFight(actor, { ...a, standard }));
  }
  const event = (t, blow, extra = {}) => ({ t, outcome: { blow, hit: true, whole: true, echoMask: 0, strikesPositive: false, formulaPositive: true, ...extra } });
  const inf = Number.POSITIVE_INFINITY;
  for (const events of [[], [event(0, 0.49999999999999994), event(1, 0.5), event(2, 2.5), event(3, 0), event(5, 0.1, { echoDamage: 0.4, echoMask: -1 })],
    [event(0, inf), event(0, 250), event(0, 250), event(0, 250), event(0, 250), event(0, 250)],
    [event(0, 10), event(6, 1), event(6, 0, { whole: false }), event(8, 10, { formulaPositive: false })],
    [event(3, 20), event(2.5, 2)]]) {
    const a = { ...opts, events, __relayEventsTest: true };
    put('single', [ch, a], () => simulateRelayFight(ch, { ...a, standard }));
  }
  for (const a of [{ ...opts, maxSeconds: undefined, events: [event(3600.5, 3)] },
    { ...opts, maxSeconds: 2, events: [event(2, 1)] },
    { ...opts, maxSeconds: 5, maxBlows: 1, events: [event(0.5, 1)], target: { ...target, activeEffects: [{ ...dot, spellPower: 1, effect: { ...dot.effect, magnitudeBaseLow: 0.75, magnitudeBaseHigh: 0.75, magnitudeLevelBase: 0, magnitudeLevelHigh: 0 } }] } }]) {
    const args = { ...a, __relayEventsTest: true };
    put('single', [ch, args], () => simulateRelayFight(ch, { ...args, standard }));
  }
  for (const [index, level] of [[246, 1], [247, undefined]]) {
    const actor = { ...ch, online: false, level, weapon: { ...ch.weapon, enchantments: [{ type: 2, param: index }] } };
    const a = { ...opts, __relayEventsTest: true, events: [event(0.5, 1, { strikesPositive: true })] };
    put('single', [actor, a], () => simulateRelayFight(actor, { ...a, standard }));
  }
  for (const [element, magnitude] of [[0.5, 20], [0, 0.75], [4, 20]]) {
    const actor = { ...ch, weapon: item(121, 9) };
    const active = { ...dot, effect: fixed(magnitude), spellPower: 1, element };
    const a = { ...opts, __relayEventsTest: true, events: [], maxSeconds: 5, target: { ...target, activeEffects: [active] } };
    put('single', [actor, a], () => simulateRelayFight(actor, { ...a, standard }));
  }
  for (const traits of [[], ['flameproof']]) {
    const actor = { ...ch, weapon: item(121, 9) };
    const active = { ...dot, effect: fixed(0.25), spellPower: 1, element: 0 };
    const a = { ...opts, __relayEventsTest: true, events: [], maxSeconds: 5, target: { ...target, bossTraits: traits, activeEffects: [active, active, active] } };
    put('single', [actor, a], () => simulateRelayFight(actor, { ...a, standard }));
  }
  for (const shieldUntil of [0, 0.5, 5, 5.000001]) for (const warded of [true, false]) {
    const a = { ...opts, shieldUntil, target: { ...target, warded, activeEffects: [dot, { ...dot, element: 2 }] }, maxBlows: 2,
      events: [event(0.5, 10, { strikesPositive: true }), event(5, 25, { strikesPositive: true })], __relayEventsTest: true };
    const script = (index, override) => {
      const log = [];
      const row = simulateRelayFight(ch, { ...a, standard, cwsRolls: () => {
        const i = log.length;
        const r = i === index ? override : ((i * 37 + 13) % 100) / 100;
        log.push(r);
        return r;
      } });
      put('script', [ch, a, log], () => row);
      return log.length;
    };
    const draws = script(-1, 0);
    for (let i = 0; i < draws; i++) for (const r of [0, 0.009999999999999998, 0.01, 0.19999999999999998, 0.2, 0.49999999999999994, 0.5, 0.9999999999999999]) script(i, r);
  }
  for (const level of [undefined, -3, '30', 1, 45, 60, 73, Infinity]) put('law', [level], () => purseOf(level));
  put('target', ['No such encounter', 22, {}], () => encounterTarget('No such encounter', 22));
  for (const id of [...ENCOUNTER_IDS, 'SKYKETCH', 'nope']) for (const cap of [0, 4, 75]) {
    const base = { target, health: 400, ward: 20, cap, cappedPerSwing: 9, hit: { hit: 0.8 }, cadence: { aps: 2 }, enchantProcs: [{ damage: 7, dotTick: 4 }] };
    const p = { splitPenaltyS: 0.3 };
    put('purse', [base, id, p], () => simulatePurse(base, id, p));
  }
  for (const health of [0, 0.125, 40]) for (const cap of [0.125, 10]) {
    const base = { health, ward: 4, cap, cappedPerSwing: 2, hit: { hit: 0.8 }, cadence: { aps: 2 } };
    put('purse', [base, 'abyss', {}], () => simulatePurse(base, 'abyss'));
  }
  for (const config of [{}, { max: -3, seconds: -1, stacks: 8, until: 8 }, { max: 2.8, seconds: '1', stacks: 99, until: 0.1 }, { max: 'x', stacks: 'x', until: NaN }, { max: 7, seconds: 4, stacks: 2.9, until: 1 }]) {
    const seq = [[0, false, true], [0.1, true, false], [0.2, true, true], [1, true, true], [1.1, true, true], [1.2, true, true], [5.2, true, false], [9, true, true]];
    put('flow', [config, seq], () => {
      const flow = createFlowState(config);
      return seq.map(([t, whole, eligible]) => [flow.hit(t, { whole, eligible }), flow.state(t)]);
    });
  }
  const seeds = pairedFightSeeds(1000, -17);
  const foe = referenceFoe(35, 'tough');
  const weak = { ...ch, weapon: { ...item(113, 0), minDamage: 1, maxDamage: 1 } };
  const stronger = { ...ch, weapon: { ...item(121, 9), minDamage: 50, maxDamage: 50 } };
  const entries = [{ id: 'weak', build: weak }, { id: 'strong', ch: stronger }, { id: 'same', ch: stronger }, { id: 'ranged', ch, scenario: { weapon: syntheticWeapon(129, 9) } }];
  for (const objective of [...OBJECTIVE_IDS, ...STOCHASTIC_OBJECTIVE_IDS]) {
    const a = { objective, target: objective.includes('relay') ? target : foe, health: 0.75, seeds, maxSeconds: 2.2, maxBlows: 5 };
    put('objective', [ch, a], () => evaluateObjective(ch, { ...a, standard }));
    put('rank', [entries, a], () => rankBuilds(entries, { ...a, standard }));
  }
  put('rank', [[ch], {}], () => rankBuilds([ch], {}));
  const noHealth = { objective: 'snapshot', target: { ...foe, maxHealth: undefined }, health: NaN };
  put('objective', [ch, noHealth], () => evaluateObjective(ch, { ...noHealth, standard }));
  for (const health of [0, 1]) {
    const a = { ...noHealth, target: { ...target, bossTraits: ['curbing'], healthShare: 0.15 }, health, imprints: [{ kind: 'execute', below: 150, pct: 60 }] };
    put('objective', [ch, a], () => evaluateObjective(ch, { ...a, standard }));
  }
  for (const maxSeconds of [0, 2]) {
    const a = { objective: 'stochastic-ttk', target: foe, trials: 1000, maxSeconds, health: 0.5 };
    put('objective', [ch, a], () => evaluateObjective(ch, { ...a, standard }));
  }
  const normalized = { objective: 'stochastic-ttk', target: foe, health: 1, trials: 1000, maxSeconds: 0, seed: 0 };
  put('rank', [[ch, { ch, scenario: { seed: -0 } }], normalized], () => rankBuilds([ch, { ch, scenario: { seed: -0 } }], { ...normalized, standard }));
  const different = { objective: 'stochastic-ttk', target: foe, health: 1, trials: 1000, maxSeconds: 0, seed: 0 };
  put('rank', [[ch, { ch, scenario: { seed: 1 } }], different], () => rankBuilds([ch, { ch, scenario: { seed: 1 } }], { ...different, standard }));
  for (const a of [{ objective: 'unknown', target }, {}, { objective: 'relay', target: foe }, { objective: 'fight', target, health: 0 },
    { objective: 'stochastic-ttk', target: foe, health: 20, seeds: [1] }, { objective: 'kill-probability', target, health: 20, trials: 1000 },
    { objective: 'snapshot', target: foe, health: null, healthShare: 0 }]) {
    put('objective', [ch, a], () => evaluateObjective(ch, { ...a, standard }));
  }
  for (const [es, a] of [[[], {}], [[ch, { ch, scenario: { health: 21 } }], { objective: 'fight', target: foe, health: 20 }],
    [[ch, { ch, scenario: { seeds: [2] } }], { objective: 'stochastic-ttk', target: foe, health: 20, seeds: [1] }]]) {
    put('rank', [es, a], () => rankBuilds(es, { ...a, standard }));
  }
  const sample = (n, fn, metric) => ({ metric, detail: { samples: Array.from({ length: n }, (_, i) => ({ seed: i, ...fn(i) })) } });
  for (let n = 0; n < 36; n++) {
    const a = sample(n, i => ({ kill: true, ttk: 1.61 + i % 13 * 0.351 }), n % 2 ? 'kill-rate' : 'kill-probability');
    const b = sample(n, i => ({ kill: n < 32 || i % 3 !== 1, ttk: 2.06 + i % 4 * 0.317 }));
    for (const metric of [undefined, 'kill', 'ttk']) put('paired', [a, b, { metric }], () => pairedDifference(a, b, { metric }));
  }
  for (const [a, b] of [[{}, {}], [sample(1, () => ({})), sample(2, () => ({}))], [sample(1, () => ({})), sample(1, () => ({ seed: 7 }))],
    [sample(8, () => ({ kill: true, ttk: NaN })), sample(8, () => ({ kill: true, ttk: 1 }))]]) {
    put('paired', [a, b, {}], () => pairedDifference(a, b));
  }
  return out.write();
}
