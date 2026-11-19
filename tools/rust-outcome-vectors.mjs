import {
  TOLERANCE, blowOutcomes, blowFightTier, mergeToFightTier, mergeToCarryTier, createBlowSampler, tierMeans,
} from '../src/blowOutcomes.js';
import { weaponOf, SWING_DIRECTIONS, createCarryState } from '../src/model.js';
import { makeTarget } from '../src/target.js';
import { encodeValue as V } from './rust-codec.mjs';
import { readFileSync } from 'node:fs';

const dv = new DataView(new ArrayBuffer(8));
function neighbour(x, offset = 1n) {
  if (x === 0) return Number(offset) * Number.MIN_VALUE;
  if (!Number.isFinite(x)) return x;
  dv.setFloat64(0, x);
  dv.setBigUint64(0, dv.getBigUint64(0) + (x < 0 ? -offset : offset));
  return dv.getFloat64(0);
}
const around = x => [neighbour(x, -1n), x, neighbour(x), neighbour(x, 2n)];

const atom = o => [o.p, o.direction, o.directionIndex, o.facing, o.backstab, o.crit, o.hit, o.whole, o.part,
  o.roll, o.preFinish, o.card, o.blowBase, o.branch, o.blow, o.echoDamage, o.damage, o.claim, o.cappedDamage,
  o.echoMask, o.echoHits, o.echoEligible, o.formulaPositive, o.strikesDamage, o.strikesPositive];
const head = t => [t.kind, t.exact, t.carry, t.hand, t.cap, t.directions, t.total, t.meta, t.mergedFrom, !!t.carryResolve, Object.values(tierMeans(t))];
function checked(f) {
  try { return f(); } catch (e) { return e.name; }
}

function samples(t) {
  const sampler = createBlowSampler(t);
  const index = new Map(t.outcomes.map((o, i) => [o, i]));
  // Use the actual private Sum body, unchanged, to avoid rebuilding O(n^2) prefix samplers.
  const sum = new Sum();
  const cdf = t.outcomes.filter(o => o.p > 0).map(o => { sum.add(o.p); return sum.value; });
  if (!Object.is(sampler.total, cdf.at(-1))) throw new Error('CDF total disagrees with sampler');
  const rolls = new Set([0, 0.5, neighbour(1, -1n), -Number.MIN_VALUE, 1, NaN]);
  for (const edge of cdf) {
    const u = edge / sampler.total;
    for (const r of around(u)) rolls.add(r);
    // Division rounds too: also find the first u whose product reaches this edge.
    if (u > 0 && u <= 1 && Number.isFinite(sampler.total)) {
      let r = u;
      while (r * sampler.total < edge) r = neighbour(r);
      // A subnormal prefix can have an enormous interval of equivalent products. Find its
      // start in the ordered, nonnegative double bit space rather than stepping through it.
      dv.setFloat64(0, r);
      let hi = dv.getBigUint64(0), lo = 0n;
      const prev = neighbour(r, -1n);
      if (prev * sampler.total >= edge) {
        while (lo < hi) {
          const mid = (lo + hi) >> 1n;
          dv.setBigUint64(0, mid);
          if (dv.getFloat64(0) * sampler.total >= edge) hi = mid;
          else lo = mid + 1n;
        }
        dv.setBigUint64(0, hi);
        r = dv.getFloat64(0);
      }
      for (const roll of around(r)) rolls.add(roll);
    }
  }
  return [sampler.total, cdf, [...rolls].map(roll => [roll,
    checked(() => index.get(sampler.outcomeAt(roll))), index.get(sampler.sample({float: () => roll}))])];
}

const src = readFileSync(new URL('../src/blowOutcomes.js', import.meta.url), 'utf8');
const sumSource = src.match(/^class Sum \{[\s\S]*?^\}/m)?.[0];
if (!sumSource) throw new Error('Cannot locate blowOutcomes.js Sum');
const Sum = Function(`return (${sumSource});`)();

export function outcomeVectors(Out) {
  const out = new Out('blow_outcomes', 'R4c: encodeValue tier head and every atom in order; binary64 CDF and explicit-roll selections', true);
  const counts = {};
  const emit = (kind, ...v) => { out.add(kind, ...v.map(V)); counts[kind] = (counts[kind] ?? 0) + 1; };
  const tier = (kind, t) => emit(kind, head(t), t.outcomes.map(atom));
  const record = (ch, args, trace = false) => {
    const full = blowOutcomes(ch, args);
    const fight = mergeToFightTier(full);
    emit('build', ch, args);
    tier('full', full);
    tier('fight', fight);
    emit('sample_fight', checked(() => samples(fight)));
    if (args.carry === true) {
      const carry = blowFightTier(ch, args);
      tier('carry', carry);
      emit('sample_carry', checked(() => samples(carry)));
      if (trace) {
        const state = createCarryState();
        const indices = [o => o.blowBase > 0 && o.echoMask !== 0, o => !o.hit, o => o.hit && !(o.blowBase > 0), o => o.blowBase > 0 && !o.crit,
          o => o.blowBase > 0 && o.crit && o.backstab, o => o.blowBase > 0 && o.crit, o => o.blowBase > 0 && !o.whole]
          .map(f => carry.outcomes.findIndex(f)).filter(i => i >= 0);
        emit('trace', Array.from({length: 3}, () => indices).flat().map(i => [i, atom(carry.carryResolve(carry.outcomes[i], state))]));
      }
    }
  };
  const neutral = makeTarget({isPlayer:true});
  const small = {min:3, max:3, damagePct:0, bonusDamage:0, material:0, conditionPercent:100};
  const ch = {stats:{strength:50}, skills:{19:45}};
  for (const target of [undefined, null, neutral, {...neutral, relayBody:true}, {...neutral, warded:true}]) {
    for (const backstabChance of [-0, ...around(1), ...around(100), NaN, 0]) {
      record(ch, {weapon:small, target, core:'classic', swing:'neutral', carry:true, backstabUptime:0.5,
        backstabChance, firmamentDamagePct:-30, potentVs:-2, imprints:[{kind:'echo', chance:50}]}, true);
    }
  }
  record({stats:{strength:0}}, {target:neutral, core:'classic', swing:'neutral', carry:true,
    loot:{flat:10}, potentVs:5}, true);
  record(ch, {weapon:{...small, min:4, max:3}, target:neutral, swing:null, carry:1, offHand:1});
  record(ch, {weapon:{...small, bonusDamage:NaN}, target:neutral, core:'classic', swing:'neutral', carry:true}, true);
  const heavy = {...small, min:200, max:200};
  for (const imprints of [[], [{kind:'execute', pct:20, below:150}], [{kind:'bane', pct:20, foes:[-1]}],
    [0, Number.MIN_VALUE, 0.5, 1].map(chance => ({kind:'echo', chance}))]) {
    record(ch, {weapon:heavy, core:'classic', swing:'neutral', carry:true, imprints}, true);
  }
  for (const health of [...around(0), ...around(30)]) {
    for (const hitCap of [undefined, -0, ...around(1), ...around(2)]) {
      record(ch, {weapon:small, target:{...neutral, hitCap}, swing:'neutral', traits:['curbing'], health});
    }
  }
  return {
    build(i, ch, it, targets) {
      for (let j = 0; j < 8; j++) {
        const k = i * 8 + j;
        const t = targets[(i + 19 * j) % targets.length];
        const held = {...it, minDamage: 1 + (i % 7), maxDamage: 1 + (i % 7) + (i % 3)};
        const offWeapon = {...held, templateIndex: [113, 115, 120, 124, 129, 560, 562, 563][i % 8]};
        const actor = {...ch, weapon: j === 0 ? null : held, offWeapon,
          wraps: i % 2 ? {...held, templateIndex:561} : null, firmamentDamagePct: 5 + (i % 4) * 3.25};
        const weapon = j === 1 ? null : j === 2 ? {...weaponOf(held), min: 2, max: 3} : undefined;
        const args = {
          weapon, target: t && {...t, healthShare: [0, 0.25, 0.5, 1][i % 4],
            hitCap: [undefined, -0, 1, 1.5, 2.5, 50, NaN, -1][i % 8],
            watchful: i % 29 === 0, revenant: {edge: {watchful: i % 23 === 0}},
            bossTraits: i % 5 ? [] : ['curbing', 'stoneskin'], minMetalToHit: i % 5 ? t.minMetalToHit : 7},
          swing: k % 37 ? SWING_DIRECTIONS[(i + j) % 6] : 'random',
          core: j === 3 ? 'classic' : j % 2 ? 'overhaul' : undefined,
          hand: [undefined, 'off', 'main'][k % 3], offHand: i % 7 === 0, dual: j === 4 || j === 7, pair: j === 6,
          rri: k % 41 === 0, critDamage: j !== 6, passiveOn: j !== 5, softMaterialRequirements: j !== 7,
          carry: true, health: [0, ...around(30), 501, NaN, -1][i % 8], traits: j === 3 ? ['curbing', 'bladeturning'] : undefined,
          healthShare: [undefined, ...around(0.5), null, 0.25, 1][j],
          backstabChance: [undefined, -1, 0, 1, neighbour(1), 37, 100, 101, NaN][k % 9],
          backstabUptime: [0, 0.51, 1, neighbour(1, -1n), -1, 2, NaN, Number.MIN_VALUE][(i + j) % 8],
          potentVs: [-6, 0, 4, 5.5, NaN, undefined][k % 6],
          imprints: [[], [{kind:'echo', chance:100}], [{kind:'echo', chance:37.5}, {kind:'echo', chance:15}],
            [{kind:'flow', pct:5, max:5}], [{kind:'flow', pct:8}], [{kind:'echo', chance:NaN}, {kind:'echo', chance:'5'}]][i % 6],
          flowStacks: [undefined, 0, 0.5, 3, NaN][j % 5], loot: {pct: i % 10, flat: i % 5},
          equipmentDamageEnhanced: i % 2 === 0, firmamentDamagePct: j % 2 ? undefined : -5.5, bowSpam: j % 3 === 0,
        };
        record(actor, args, true);
        if (i % 16 === 0) record(actor, {...args, carry: false});
      }
    },
    write() {
      emit('tolerance', TOLERANCE);
      for (const hand of [null, false, '', 'left', 0]) emit('bad_hand', hand, checked(() => blowOutcomes({}, {hand})));
      emit('bad_kind', checked(() => createBlowSampler(blowOutcomes({}))), checked(() => mergeToCarryTier(blowOutcomes({}))));
      const row = (p, idx, fields = {}) => ({p, direction:'StrikeLeft', directionIndex:0, facing:false,
        backstab:false, crit:false, hit:true, whole:true, part:0, roll:idx, preFinish:0, card:0,
        blow:idx, echoDamage:0, damage:idx, claim:idx, cappedDamage:idx, echoMask:0, echoHits:0,
        echoEligible:false, formulaPositive:false, strikesDamage:idx, strikesPositive:false, ...fields});
      for (let i = 0; i < 2048; i++) {
        const q = i % 4 === 0 ? 0.5 : neighbour(TOLERANCE, BigInt(i - 1024));
        const p = [q, Number.MIN_VALUE, -0, 0, NaN, -2, 1 - q, 2 ** -53, 2 ** -54];
        if (i % 8 === 1) p.push(Infinity);
        if (i % 8 === 2) p.splice(1, 7, -0);
        if (i % 8 === 3) p.splice(0, p.length, 0, -1, NaN);
        if (i % 8 === 4) p.splice(0, p.length, Number.MIN_VALUE, 0, Number.MIN_VALUE);
        const t = {kind: 'fight', outcomes: p.map((p, j) => row(p, j)), total: 6};
        emit('sample_raw', p, checked(() => samples(t)));

        // Adjacent damage keys at tolerance scale must not merge; -0/+0 and NaNs do.
        // Comparator ties (including NaN subtraction) keep first-group order, not p order.
        const rows = [row(q, 0, {blow:-0}), row(2 ** -54, 1, {blow:0}), row(1 - q, 2, {blow:0}),
          row(q, 3, {blow:0, strikesPositive:true}), row(q, 4, {blow:0, formulaPositive:true}),
          ...around(TOLERANCE).reverse().map((blow, j) => row(q, 5+j, {blow})), row(q, 13, {blow:Number.MIN_VALUE}),
          row(q, 9, {blow:NaN, facing:true}), row(q, 10, {blow:Infinity, facing:true, strikesPositive:true}),
          row(q, 11, {blow:NaN, facing:true, formulaPositive:true}), row(q, 12, {blow:NaN, facing:true})];
        const full = {kind:'full', exact:true, hand:'main', cap:0, directions:['StrikeLeft'], outcomes: rows,
          meta:{carryResolve: () => { throw new Error('synthetic tier has no resolver'); }}};
        emit('merge_raw', rows.map(atom), mergeToFightTier(full).outcomes.map(atom), mergeToCarryTier(full).outcomes.map(atom));
      }
      console.log(`blow_outcomes: ${Object.entries(counts).map(([k,v]) => `${k} ${v}`).join(', ')}`);
      return {blow_outcomes: out.write()};
    },
  };
}
