#!/usr/bin/env node
/*
 * Golden-vector generator for the Rust port (rust/dfo-core, milestones R1 and R2; R2 adds swing.txt).
 *
 *   node tools/rust-vectors.mjs
 *
 * Runs the REAL JS modules (src/rng.js, src/allowance.js, src/relayClaim.js, src/model.js) and writes
 * deterministic plain-text vector files to rust/tests/vectors/. Output is reproducible: no Math.random, no
 * Date, no environment; a fixed local PRNG (`makeLcg`) drives the sweeps. Run it twice and diff to check.
 *
 * FILE FORMAT (all files)
 *   - UTF-8, LF line ends. Lines starting with '#' are comments (the first is the header naming this generator);
 *     blank lines are ignored.
 *   - One case per line: `<kind> <token> <token> ...`, tokens separated by single spaces.
 *   - A token `=>` separates a case's inputs from its expected outputs (where present).
 *   - Token types (the parser knows each position's type from the kind):
 *       f64   exactly 16 lowercase hex digits: the IEEE-754 bits (so -0, NaN, Infinity round-trip). NaN is always
 *             written as the canonical 7ff8000000000000: the payload of a JS NaN is not meaningful.
 *       int   decimal integer (counts, int32/uint32 results, draws).
 *       u32   exactly 8 lowercase hex digits.
 *       bool  1 or 0.
 *       opt   `-` for JS null/undefined, otherwise an f64.
 *       name  `n:` followed by the string's UTF-16 code units, 4 hex digits each (lone surrogates are legal; an
 *             empty string is `n:`). In a trace op the `n:` prefix is dropped.
 *       word  a bare ASCII word (`ok`, `err`, `null`, a reason such as `accepted-clipped`).
 *   - Each kind is documented where its generator is written below.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRng, _initialStateForTests } from '../src/rng.js';
import {
  allowanceLaw, allowanceSpec, BREACH_PHASES, claimStreams, refOf, runAllowance, simulateAllowance, steadyState,
} from '../src/allowance.js';
import { createRelayClaimEngine } from '../src/relayClaim.js';
import {
  conditionMultiplier, damageModifier, pcaaoDamageModifier, SKILLS, swingFrameSeconds, swingHandling, swingHeft, unityRound,
} from '../src/model.js';
import { SWING_HANDLING, WEAPONS } from '../src/data.js';
import {
  armourConditionMultiplier, armourMaterialId, armourPiece, armourReduction, bodyPartWeights, careerTolerance,
  elementShare, enemyTarget, enemyTypeBonusRange, enemyTypeBonusValue, enemyTypeBonusValues, enemyTypeGroup,
  equipArmour, hasWornEquipment, intrinsicDamage, isSkeletalTarget, leftHandShield, makeTarget, monsterHideDamage,
  naturalDamageResistance, shieldBeatsUnderArmour, shieldBlockChance, shieldReduction, silverApplies,
  skeletalSilverDamage, standInTarget, struckSlotItem, targetExpectedDamage, targetPartDamage, targetPartOutcomes,
} from '../src/target.js';
import { liveStat } from '../src/save.js';
import { careerAttackModifier, silverDoubles } from '../vendor/upstream/a3eb1605/src/combat/formulas.js';
import { enemyEntityGroup } from '../vendor/upstream/a3eb1605/src/combat/enemyGroups.js';
import { enemyArmorValues } from '../vendor/upstream/a3eb1605/src/combat/enemyEquipment.js';
import { isShieldTemplate, itemArmorValue, materialArmorValue } from '../vendor/upstream/a3eb1605/src/systems/armorMaterials.js';
import { armorBodyParts, slotForBodyPart } from '../vendor/upstream/a3eb1605/src/systems/equip.js';
import { conditionPercentage } from '../vendor/upstream/a3eb1605/src/systems/item/itemTemplates.js';
import { enemyCareerIndex, enemyEntityType } from '../vendor/upstream/a3eb1605/src/characters/enemy/enemyBasics.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'rust', 'tests', 'vectors');
const modelSource = readFileSync(join(here, '..', 'src', 'model.js'), 'utf8');

// ---------------------------------------------------------------------------------------------------------------
// encoding helpers
// ---------------------------------------------------------------------------------------------------------------
const dv = new DataView(new ArrayBuffer(8));
const F = (x) => {
  if (typeof x !== 'number') throw new Error(`F: not a number: ${String(x)}`);
  if (Number.isNaN(x)) return '7ff8000000000000';
  dv.setFloat64(0, x);
  return dv.getBigUint64(0).toString(16).padStart(16, '0');
};
const O = (x) => (x === null || x === undefined ? '-' : F(x));
const B = (b) => (b ? '1' : '0');
const I = (n) => {
  if (!Number.isInteger(n)) throw new Error(`I: not an integer: ${n}`);
  return String(n === 0 ? 0 : n); // never "-0"
};
const U8 = (v) => (v >>> 0).toString(16).padStart(8, '0');
const nh = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i).toString(16).padStart(4, '0')).join('');
const N = (s) => `n:${nh(s)}`;
const NO = (s) => (s === null || s === undefined ? '-' : N(s));
const bitsToF = (hi, lo) => { dv.setUint32(0, hi >>> 0); dv.setUint32(4, lo >>> 0); return dv.getFloat64(0); };
/** the adjacent double of a non-zero finite x, toward +Infinity (dir=1) or -Infinity (dir=-1) */
const step = (x, dir) => {
  dv.setFloat64(0, x);
  const b = dv.getBigUint64(0);
  dv.setBigUint64(0, (x > 0) === (dir > 0) ? b + 1n : b - 1n);
  return dv.getFloat64(0);
};

/** A fixed 32-bit generator for the sweeps (never Math.random). */
function makeLcg(seed) {
  let s = seed >>> 0;
  const u32 = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    let x = s;
    x ^= x >>> 15;
    x = Math.imul(x, 0x2c1b3c6d) >>> 0;
    x ^= x >>> 12;
    return x >>> 0;
  };
  const unit = () => u32() / 4294967296;
  return {
    u32,
    unit,
    range: (lo, hi) => lo + (hi - lo) * unit(),
    int: (lo, hi) => lo + (u32() % (hi - lo + 1)),
    pick: (arr) => arr[u32() % arr.length],
    chance: (p) => unit() < p,
    bits: () => bitsToF(u32(), u32()),
    /** a safe integer of either sign, up to 2^53-1 */
    seed: () => {
      const mag = (u32() & 0x1fffff) * 4294967296 + u32();
      return mag * (u32() & 1 ? -1 : 1);
    },
  };
}

class Out {
  constructor(module, note) {
    this.module = module;
    this.lines = [];
    this.note = note;
  }
  add(...tokens) {
    this.lines.push(tokens.join(' '));
  }
  write() {
    const head = [
      `# dfo-core golden vectors | generator: tools/rust-vectors.mjs | module: ${this.module} | format: v1`,
      `# ${this.note}`,
      '# tokens: f64 = 16 hex digits of IEEE bits; int = decimal; u32 = 8 hex; bool = 1/0; opt = - or f64; name = n:<4 hex per UTF-16 unit>',
    ];
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${this.module}.txt`), `${[...head, ...this.lines].join('\n')}\n`);
    return this.lines.length;
  }
}

const counts = {};

// ---------------------------------------------------------------------------------------------------------------
// round
// ---------------------------------------------------------------------------------------------------------------
function genRound() {
  const out = new Out('round', 'kinds: unity_round|fround|trunc|floor|uint32|int32|is_integer|is_safe_integer x r | rem|max|min a b r | clamp v lo hi r | imul a b r | finite_or|or_default x d r');
  const R = makeLcg(0x1001);

  const specials = [
    0, -0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 3.5, -3.5, 0.1, 0.9, 1.1, -0.1, -0.9,
    0.49999999999999994, 0.5000000000000001, -0.49999999999999994, -0.5000000000000001,
    1.4999999999999998, 1.5000000000000002, 2.4999999999999996, 2.5000000000000004,
    2251799813685248.5, 4503599627370495.5, 4503599627370496, 4503599627370497, 4503599627370495,
    9007199254740991, -9007199254740991, 9007199254740992, -9007199254740992, 9007199254740993,
    1e15 + 0.5, 1e300, -1e300, 1.7976931348623157e308, -1.7976931348623157e308,
    Infinity, -Infinity, NaN, 5e-324, -5e-324, 2.2250738585072014e-308, 1e-9, -1e-9, 1e-300,
    2147483647, 2147483648, -2147483648, -2147483649, 4294967295, 4294967296, 4294967297, -4294967295, -4294967296,
    4294967295.5, -4294967295.5, 2 ** 53 + 2, 2 ** 63, 2 ** 64, 2 ** 80, -(2 ** 64),
    // fround: halfway between neighbouring f32s, subnormal edge, overflow edge
    16777216, 16777217, 16777218, 16777219, 1 + 2 ** -24, 1 + 3 * 2 ** -24, 1 + 2 ** -23, 0.1 + 2 ** -30,
    3.4028234663852886e38, 3.4028235677973362e38, 3.4028235677973366e38, 3.4028236692093846e38, 1e39, -1e39,
    1.401298464324817e-45, 7.006492321624085e-46, 7.006492321624087e-46, 1e-46, -1e-46, 1.1754943508222875e-38,
  ];
  const V = [...specials];
  for (let k = -40; k <= 40; k++) V.push(k + 0.5);
  for (let k = -12; k <= 12; k++) {
    for (const x of [k + 0.5, k + 0.25, k - 0.5]) {
      if (x !== 0) { V.push(step(x, 1)); V.push(step(x, -1)); }
    }
  }
  for (let i = 0; i < 300; i++) V.push(R.range(-100, 100));
  for (let i = 0; i < 300; i++) V.push(R.range(-1e6, 1e6));
  for (let i = 0; i < 200; i++) V.push(R.int(-1000000, 1000000) + 0.5);
  for (let i = 0; i < 100; i++) V.push(R.int(-1e6, 1e6) * 2 ** R.int(-20, 20));
  for (let i = 0; i < 250; i++) V.push(R.bits());
  for (let i = 0; i < 100; i++) V.push(R.seed() + 0.5 * (R.u32() & 1)); // large, near and above 2^52

  for (const x of V) {
    out.add('unity_round', F(x), F(unityRound(x)));
    out.add('fround', F(x), F(Math.fround(x)));
    out.add('trunc', F(x), F(Math.trunc(x)));
    out.add('floor', F(x), F(Math.floor(x)));
    out.add('uint32', F(x), I(x >>> 0));
    out.add('int32', F(x), I(x | 0));
    out.add('is_integer', F(x), B(Number.isInteger(x)));
    out.add('is_safe_integer', F(x), B(Number.isSafeInteger(x)));
  }

  const A = [0, -0, 1, -1, 5, -5, 5.5, -5.5, 2 ** 32, -(2 ** 32), 2 ** 32 + 1, -(2 ** 32 + 1), 2 ** 53 - 1, -(2 ** 53 - 1), NaN, Infinity, -Infinity, 1e300, 3.7, -3.7, 4294967295, -4294967295, 0.5, -0.5];
  const Bs = [2, -2, 3, 4294967296, -4294967296, 0, -0, Infinity, -Infinity, NaN, 0.5, 1e-300, 2 ** 53, 7, -7];
  for (const a of A) for (const b of Bs) out.add('rem', F(a), F(b), F(a % b));
  for (let i = 0; i < 300; i++) {
    const a = R.seed() + (R.chance(0.3) ? 0.25 : 0);
    out.add('rem', F(a), F(4294967296), F(a % 4294967296));
    const b = R.range(-50, 50);
    const c = R.range(-1e9, 1e9);
    out.add('rem', F(c), F(b), F(c % b));
  }

  const M = [0, -0, 1, -1, NaN, Infinity, -Infinity, 0.5, 5e-324, -5e-324, 60, 1e-9];
  for (const a of M) {
    for (const b of M) {
      out.add('max', F(a), F(b), F(Math.max(a, b)));
      out.add('min', F(a), F(b), F(Math.min(a, b)));
    }
  }
  for (let i = 0; i < 300; i++) {
    const a = R.chance(0.2) ? R.pick(M) : R.range(-100, 100);
    const b = R.chance(0.2) ? R.pick(M) : R.range(-100, 100);
    out.add('max', F(a), F(b), F(Math.max(a, b)));
    out.add('min', F(a), F(b), F(Math.min(a, b)));
  }
  for (const v of M) {
    for (const lo of [0, -0, 1, 1.5, -Infinity, NaN, 60, -1]) {
      for (const hi of [60, 0, -0, Infinity, NaN, -1, 1]) {
        out.add('clamp', F(v), F(lo), F(hi), F(Math.max(lo, Math.min(hi, v))));
      }
    }
  }

  const E = [0, 1, -1, 2147483647, -2147483648, 0x85ebca6b | 0, 0xc2b2ae35 | 0, 0x27d4eb2f, 0x01000193, 5, 9, 65536, -65536];
  for (const a of E) for (const b of E) out.add('imul', I(a), I(b), I(Math.imul(a, b)));
  for (let i = 0; i < 400; i++) {
    const a = R.u32() | 0;
    const b = R.u32() | 0;
    out.add('imul', I(a), I(b), I(Math.imul(a, b)));
  }

  for (const x of [...M, 3.5, -2.5, 1e300]) {
    for (const d of [0, 1, -2.5, 60]) {
      out.add('finite_or', F(x), F(d), F(Number.isFinite(x) ? x : d));
      out.add('or_default', F(x), F(d), F(Number(x) || d));
    }
  }
  return out.write();
}

// ---------------------------------------------------------------------------------------------------------------
// rng
// ---------------------------------------------------------------------------------------------------------------
function genRng() {
  const out = new Out('rng', 'kinds: init seed name s0 s1 s2 s3 | seed_check seed ok|err | name_check name ok|err | seq seed name count u32... | floats seed name count f64... | ints seed name n count int... | int_bad n | state seed name k s0 s1 s2 s3 draws | trace seed op... (ops: n<name>=u32, f<name>=f64, i<name>:<n>=int, S, R<slot>, D=<name>:<draws>,... or D=-)');
  const R = makeLcg(0x2002);
  const MAXS = 2 ** 53 - 1;
  const seeds = [0, -0, 1, -1, 2, 42, 12345, -12345, 4294967295, 4294967296, 4294967297, -4294967295, -4294967296, -4294967297,
    2 ** 31, -(2 ** 31), 2 ** 32 * 3 + 7, -(2 ** 32 * 3 + 7), 123456789012, -123456789012, 2 ** 52, -(2 ** 52), MAXS, -MAXS, MAXS - 1, -MAXS + 1];
  const legal = ['blow', 'echo', 'spell', 'a', 'x'.repeat(64), 'é', '日本語', '🎲', '\ud800', '\udc00x', 'a\u0000b', '😀'.repeat(32), '0', '10', 'Blow', ' ', 'a'.repeat(63)];
  const illegal = ['', 'a'.repeat(65), '😀'.repeat(33), 'x'.repeat(100), '😀'.repeat(32) + 'a'];

  // initial state: the full cross of the hand-picked seeds and names, plus a random sweep
  const stateOf = (seed, name) => _initialStateForTests(seed, name);
  for (const seed of seeds) for (const name of legal) out.add('init', F(seed), N(name), ...stateOf(seed, name).map(U8));
  for (let i = 0; i < 400; i++) {
    const seed = R.seed();
    const name = R.chance(0.5) ? `s${R.u32()}` : R.pick(legal);
    out.add('init', F(seed), N(name), ...stateOf(seed, name).map(U8));
  }

  // validation
  for (const v of [0, -0, 1, -1, MAXS, -MAXS, MAXS + 1, -(MAXS + 1), 2 ** 53, 2 ** 53 + 2, 1.5, -1.5, 0.1, NaN, Infinity, -Infinity, 1e21, 2 ** 64, 5e-324]) {
    let ok = true;
    try { createRng(v); } catch { ok = false; }
    out.add('seed_check', F(v), ok ? 'ok' : 'err');
  }
  for (const name of [...legal, ...illegal]) {
    let ok = true;
    try { createRng(1).stream(name); } catch { ok = false; }
    out.add('name_check', N(name), ok ? 'ok' : 'err');
  }
  for (const n of [0, -1, -0, 0.5, 1.5, NaN, Infinity, -Infinity, 4294967297, 2 ** 53, 4294967296.5]) {
    const s = createRng(7).stream('q');
    let threw = false;
    try { s.int(n); } catch { threw = true; }
    if (!threw || s.draws !== 0) throw new Error(`rust-vectors: int(${n}) was expected to throw before any draw`);
    out.add('int_bad', F(n));
  }

  // long sequences: 10_000 draws (several pairs), plus a sweep of short ones
  const longPairs = [[0, 'blow'], [1, 'echo'], [-1, 'spell'], [MAXS, '🎲'], [-MAXS, 'x'.repeat(64)], [12345, '日本語'], [2 ** 32, '\ud800']];
  for (const [seed, name] of longPairs) {
    const s = createRng(seed).stream(name);
    const v = [];
    for (let i = 0; i < 10000; i++) v.push(U8(s.next()));
    if (s.draws !== 10000) throw new Error('rust-vectors: draw count');
    out.add('seq', F(seed), N(name), '10000', ...v);
  }
  for (let i = 0; i < 200; i++) {
    const seed = R.chance(0.2) ? R.pick(seeds) : R.seed();
    const name = R.chance(0.5) ? `k${R.u32()}` : R.pick(legal);
    const s = createRng(seed).stream(name);
    const cnt = R.int(1, 48);
    const v = [];
    for (let j = 0; j < cnt; j++) v.push(U8(s.next()));
    out.add('seq', F(seed), N(name), I(cnt), ...v);
  }
  // floats and ints
  for (const [seed, name] of longPairs) {
    const a = createRng(seed).stream(name);
    const v = [];
    for (let i = 0; i < 128; i++) v.push(F(a.float()));
    out.add('floats', F(seed), N(name), '128', ...v);
  }
  for (const n of [1, 2, 3, 6, 10, 100, 255, 65536, 16777216, 1000003, 4294967295, 4294967296]) {
    for (const [seed, name] of [[0, 'blow'], [-7, 'echo'], [MAXS, 'spell'], [31337, '🎲']]) {
      const s = createRng(seed).stream(name);
      const v = [];
      for (let i = 0; i < 64; i++) v.push(I(s.int(n)));
      out.add('ints', F(seed), N(name), I(n), '64', ...v);
    }
  }
  // state after k draws
  for (const [seed, name] of [[0, 'blow'], [-1, 'spell'], [MAXS, '日本語'], [-MAXS, 'x'.repeat(64)]]) {
    for (const k of [0, 1, 2, 7, 100, 5000]) {
      const s = createRng(seed).stream(name);
      for (let i = 0; i < k; i++) s.next();
      const snap = s.snapshot();
      out.add('state', F(seed), N(name), I(k), ...snap.state.map(U8), I(snap.draws));
    }
  }

  // traces: interleaved streams, snapshot, restore (streams created after a snapshot are discarded), draw counts
  const traceNames = ['blow', 'echo', 'spell', 'x', 'é', '日本語', '🎲', 'a'.repeat(64), '\ud800', '0', '10'];
  const traceInts = [1, 2, 6, 10, 100, 4294967296];
  for (let tcase = 0; tcase < 120; tcase++) {
    const seed = tcase < seeds.length ? seeds[tcase] : R.seed();
    const rng = createRng(seed);
    const snaps = [];
    const toks = [];
    const ops = R.int(20, 120);
    for (let i = 0; i < ops; i++) {
      const r = R.u32() % 100;
      const name = R.pick(traceNames);
      if (r < 45) {
        toks.push(`n${nh(name)}=${U8(rng.stream(name).next())}`);
      } else if (r < 60) {
        toks.push(`f${nh(name)}=${F(rng.stream(name).float())}`);
      } else if (r < 70) {
        const n = R.pick(traceInts);
        toks.push(`i${nh(name)}:${n}=${I(rng.stream(name).int(n))}`);
      } else if (r < 78) {
        snaps.push(rng.snapshot());
        toks.push('S');
      } else if (r < 85 && snaps.length) {
        const k = R.int(0, snaps.length - 1);
        rng.restore(snaps[k]);
        toks.push(`R${k}`);
      } else {
        const d = rng.snapshot().streams.map((s) => `${nh(s.name)}:${s.draws}`);
        toks.push(`D=${d.length ? d.join(',') : '-'}`);
      }
    }
    toks.push(`D=${(() => { const d = rng.snapshot().streams.map((s) => `${nh(s.name)}:${s.draws}`); return d.length ? d.join(',') : '-'; })()}`);
    out.add('trace', F(seed), ...toks);
  }
  return out.write();
}

// ---------------------------------------------------------------------------------------------------------------
// damage (src/model.js). applyPct, carriedPct and carriedFirmament are module-private there, so their exact source
// text is cut out of src/model.js and evaluated: the vectors come from the real lines, not from a copy.
// ---------------------------------------------------------------------------------------------------------------
function grab(re, label) {
  const m = modelSource.match(re);
  if (!m) throw new Error(`rust-vectors: cannot find ${label} in src/model.js (the source moved; update this generator)`);
  return m[0];
}
const privateSource = [
  grab(/function applyPct\(damage, pct\) \{\n[^}]*\n\}/, 'applyPct'),
  grab(/const carriedPct = [^;]*;/, 'carriedPct'),
  grab(/const carriedFirmament = [^;]*;/, 'carriedFirmament'),
].join('\n');
const { applyPct, carriedPct, carriedFirmament } = new Function('floor', 'trunc', `${privateSource}\nreturn { applyPct, carriedPct, carriedFirmament };`)(Math.floor, Math.trunc);

function genDamage() {
  const out = new Out('damage', 'kinds: damage_modifier|pcaao_damage_modifier str r | apply_pct|carried_pct|carried_firmament damage pct r | condition_multiplier has(bool) conditionPercent(opt) conditionPct blunt(bool) sharpEdge(bool) r');
  const R = makeLcg(0x3003);

  const strs = [NaN, Infinity, -Infinity, 0, -0, 50, 55, 54.999999999999993, 55.00000000000001, 59.99999999999999, 60, 1e300, -1e300, 49.5, -9007199254740991];
  for (let s = -20; s <= 150; s++) strs.push(s);
  for (let i = 0; i < 300; i++) strs.push(R.range(-20, 150));
  for (const s of strs) {
    out.add('damage_modifier', F(s), F(damageModifier(s)));
    out.add('pcaao_damage_modifier', F(s), F(pcaaoDamageModifier(s)));
  }

  const dmgs = [0, 1, 2, 3, 5, 7, 10, 13, 17, 25, 33, 50, 99, 100, 101, 250, 1000, 12345, 0.5, 2.5, -0, -5, NaN, Infinity, 2 ** 53, 2 ** 53 - 1, 1e15];
  const pcts = [0, -0, -5, 1, 2, 3, 5, 7, 10, 12.5, 15, 20, 25, 29, 30, 33, 45, 50, 66.6, 75, 100, 150, 300, 320, 0.001, 1e-7, NaN, Infinity, -Infinity, 1e9];
  const pairs = [];
  for (const d of dmgs) for (const p of pcts) pairs.push([d, p]);
  // the 1e-9 guard: whole products that fp computes a hair short, found by brute force over small integers
  let rescued = 0;
  for (let d = 1; d <= 400 && rescued < 400; d++) {
    for (let p = 1; p <= 320; p++) {
      if ((d * p) % 100 === 0 && Math.floor(d * (p / 100)) !== (d * p) / 100) { pairs.push([d, p]); rescued++; }
    }
  }
  if (rescued === 0) throw new Error('rust-vectors: expected some products that the 1e-9 guard rescues');
  // the guard's boundary itself: k - eps for eps around 1e-9
  for (const k of [1, 2, 3, 10, 100]) {
    for (const eps of [0, 1e-12, 5e-10, 9.9e-10, 1e-9, 1.1e-9, 1.5e-9, 2e-9, 1e-8]) pairs.push([1, 100 * (k - eps)], [10, 10 * (k - eps)], [k, 100]);
  }
  for (let i = 0; i < 700; i++) pairs.push([R.chance(0.5) ? R.int(0, 5000) : R.range(0, 5000), R.chance(0.5) ? R.int(0, 350) : R.range(0, 350)]);
  for (let i = 0; i < 100; i++) pairs.push([R.range(-100, 100), R.range(-50, 350)]);
  for (const [d, p] of pairs) {
    out.add('apply_pct', F(d), F(p), F(applyPct(d, p)));
    out.add('carried_pct', F(d), F(p), F(carriedPct(d, p)));
    out.add('carried_firmament', F(d), F(p), F(carriedFirmament(d, p)));
  }

  const cps = [NaN, Infinity, -Infinity, -0, 5.5, 5.9, 5.0, 5.0000001, 6.0, 5.999, 75.9, 76, 91.99999, 92, 100.5];
  for (let p = -5; p <= 130; p++) cps.push(p);
  const weapon = (cp, cpct, blunt) => ({ skillId: blunt ? SKILLS.BluntWeapon : SKILLS.LongBlade, conditionPercent: cp, conditionPct: cpct });
  for (const blunt of [false, true]) {
    for (const sharp of [false, true]) {
      for (const cp of cps) out.add('condition_multiplier', '1', F(cp), F(0), B(blunt), B(sharp), F(conditionMultiplier(weapon(cp, 0, blunt), sharp)));
      // conditionPercent absent: Math.trunc(conditionPct * 100)
      for (let p = 0; p <= 120; p++) {
        const frac = p / 100;
        out.add('condition_multiplier', '1', '-', F(frac), B(blunt), B(sharp), F(conditionMultiplier(weapon(null, frac, blunt), sharp)));
      }
      for (const frac of [NaN, 0.059, 0.0599, 0.29, 0.57, 0.58, 0.755, 0.7599999, 0.91999999, 1.2, -0.5, 0.075 * 10]) {
        out.add('condition_multiplier', '1', '-', F(frac), B(blunt), B(sharp), F(conditionMultiplier(weapon(undefined, frac, blunt), sharp)));
      }
      out.add('condition_multiplier', '0', '-', F(0), B(blunt), B(sharp), F(conditionMultiplier(null, sharp)));
    }
  }
  return out.write();
}

// ---------------------------------------------------------------------------------------------------------------
// allowance
// ---------------------------------------------------------------------------------------------------------------
const phaseTokens = (phases) => [I(phases.length), ...phases.flatMap((p) => [F(p.at), F(p.shieldS)])];
const streamTokens = (streams) => [I(streams.length), ...streams.flatMap((s) => [F(s.perClaim), F(s.interval), O(s.start)])];
const RUN_KEYS = [['killed', 'b'], ['ttk', 'o'], ['fightSeconds', 'f'], ['shieldedSeconds', 'f'], ['activeSeconds', 'f'], ['claimsOffered', 'i'], ['claimsAccepted', 'i'], ['claimsRefused', 'i'], ['offered', 'f'], ['claimed', 'f'], ['landed', 'f'], ['clipped', 'f'], ['landedShare', 'f'], ['burst5', 'f'], ['dryAt', 'o'], ['immunityShare', 'f'], ['openingS', 'f'], ['splitPenaltyS', 'f']];
const TOK = { f: F, o: O, b: B, i: I };
const runTokens = (run) => (run ? RUN_KEYS.map(([k, t]) => TOK[t](run[k])) : ['null']);

function randomBuild(R) {
  const level = R.chance(0.1) ? R.range(0, 70) : R.int(1, 60);
  const players = R.chance(0.7) ? 1 : R.int(2, 8);
  const hit = R.chance(0.1) ? R.pick([0, 1, 1.5, -1, NaN]) : R.range(0.2, 1);
  const aps = R.chance(0.05) ? R.pick([0, -1, NaN]) : R.range(0.6, 6);
  const cappedPerSwing = R.chance(0.1) ? R.pick([0, -5, NaN, 1e9]) : R.range(1, 3000);
  const cap = R.chance(0.5) ? 0 : R.range(10, 2000);
  const procs = [];
  for (let i = R.int(0, 3); i > 0; i--) {
    procs.push({
      name: R.chance(0.8) ? `proc${R.int(0, 99)}` : undefined,
      damage: R.chance(0.3) ? R.pick([0, NaN, -4]) : R.range(1, 1500),
      dotTick: R.chance(0.5) ? 0 : R.range(1, 400),
    });
  }
  return { level, players, hit, aps, cappedPerSwing, cap, procs, withProcs: R.chance(0.85) };
}

function genAllowance() {
  const out = new Out('allowance', 'kinds: ref_of level r | law level ref depth rate cap hitHz share | spec level players openingS immunity(opt) nphases (at shieldS)* => level players openingS immunity(opt) nphases (at shieldS)* | streams cappedPerSwing hit aps cap withProcs nprocs (name(-|name) damage dotTick)* => nstreams (kind(b|p|d) name perClaim interval start)* | steady depth rate cap hitHz nstreams (perClaim interval start)* => offeredDps claimsPerSecond claimLimitedDps refill sustainedDps saturated | simulate|simulate_shield_end share depth rate cap hitHz fresh openingS immunity(opt) splitPenaltyS maxSeconds burstWindowS mode nphases (at shieldS)* nstreams (perClaim interval start(opt))* => null | killed ttk fightSeconds shieldedSeconds activeSeconds claimsOffered claimsAccepted claimsRefused offered claimed landed clipped landedShare burst5 dryAt immunityShare openingS splitPenaltyS | run level share hasSpec openingS immunity(opt) nphases (at shieldS)* nstreams (perClaim interval start)* fresh splitPenaltyS => null | law(ref depth rate cap hitHz share) share run-fields... ceilingDps sustainedDps saturated claimsPerSecond burst5Dps averageDps(opt). simulate modes: 0 none, 1 perClaim*(0.5+hp/share), 2 -1, 3 NaN, 4 t<10 ? perClaim : perClaim*2');
  const R = makeLcg(0x4004);

  const levels = [-5, 0, 0.5, 1, 1.9, 2, 10, 59.5, 59.99, 60, 61, 1000, NaN, Infinity, -Infinity, -0];
  for (let i = 0; i < 80; i++) levels.push(R.range(-5, 70));
  for (const lv of levels) {
    out.add('ref_of', F(lv), F(refOf(lv)));
    const l = allowanceLaw(lv);
    out.add('law', F(lv), F(l.ref), F(l.depth), F(l.rate), F(l.cap), F(l.hitHz), F(l.share));
  }

  // spec
  const playersList = [undefined, NaN, 0, 0.5, 1, 2, 2.9, -3, 1e9, Infinity];
  const phaseSets = [BREACH_PHASES, [], [{ at: 0.5, shieldS: 2 }], [{ at: 0.3, shieldS: NaN }, { at: 0.6, shieldS: 1.5 }, { at: 0.3, shieldS: -1 }]];
  for (const players of playersList) {
    for (const phases of phaseSets) {
      for (const [openingS, imm] of [[0, null], [2.5, 0.3], [-1, NaN], [NaN, Infinity], [7, 2], [0, -0.5]]) {
        const spec = allowanceSpec(10, { players, phases, openingS, immunityShare: imm });
        out.add('spec', F(10), F(players === undefined ? NaN : players), F(openingS), O(imm),
          ...phaseTokens(phases), '=>', F(spec.level), F(spec.players), F(spec.openingS), O(spec.immunityShare), ...phaseTokens(spec.phases.map((p) => ({ at: p.at, shieldS: p.shieldS }))));
      }
    }
  }

  // claim streams
  const builds = [];
  for (let i = 0; i < 150; i++) builds.push(randomBuild(R));
  for (const hit of [0.5, 1, 0.0001]) builds.push({ level: 10, players: 1, hit, aps: 2, cappedPerSwing: 100, cap: 50, procs: [{ name: 'a', damage: 10, dotTick: 3 }, { name: undefined, damage: 0, dotTick: 4 }], withProcs: true });
  builds.push({ level: 10, players: 1, hit: 0.5, aps: 2, cappedPerSwing: 100, cap: 0, procs: [{ name: 'a', damage: 10, dotTick: 3 }], withProcs: false });
  for (const b of builds) {
    const s = claimStreams({ cappedPerSwing: b.cappedPerSwing, hit: b.hit, aps: b.aps, procs: b.procs, cap: b.cap, withProcs: b.withProcs });
    out.add('streams', F(b.cappedPerSwing), F(b.hit), F(b.aps), F(b.cap), B(b.withProcs), I(b.procs.length),
      ...b.procs.flatMap((p) => [NO(p.name), F(p.damage), F(p.dotTick)]), '=>',
      I(s.length), ...s.flatMap((x) => [{ blow: 'b', proc: 'p', dot: 'd' }[x.kind], NO(x.name), F(x.perClaim), F(x.interval), F(x.start)]));
  }

  // steady state
  const laws = [{ depth: 90, rate: 18, cap: 72, hitHz: 4 }, { depth: 225, rate: 45, cap: 180, hitHz: 4 }, { depth: 975, rate: 195, cap: 780, hitHz: 4 }, { depth: 1, rate: 1, cap: 1, hitHz: 0.5 }];
  for (const b of builds) {
    const law = laws[R.int(0, laws.length - 1)];
    const s = claimStreams({ cappedPerSwing: b.cappedPerSwing, hit: b.hit, aps: b.aps, procs: b.procs, cap: b.cap, withProcs: b.withProcs });
    const st = steadyState(s, law);
    out.add('steady', F(law.depth), F(law.rate), F(law.cap), F(law.hitHz), ...streamTokens(s), '=>', F(st.offeredDps), F(st.claimsPerSecond), F(st.claimLimitedDps), F(st.refill), F(st.sustainedDps), B(st.saturated));
  }
  for (const st0 of [[], [{ perClaim: 10, interval: 1 }], [{ perClaim: 10, interval: 0.1 }, { perClaim: 1, interval: 0.1 }], [{ perClaim: 0, interval: 5 }], [{ perClaim: 5, interval: 0 }]]) {
    const law = laws[1];
    const st = steadyState(st0, law);
    out.add('steady', F(law.depth), F(law.rate), F(law.cap), F(law.hitHz), ...streamTokens(st0), '=>', F(st.offeredDps), F(st.claimsPerSecond), F(st.claimLimitedDps), F(st.refill), F(st.sustainedDps), B(st.saturated));
  }

  // simulate
  const perClaimAtOf = (mode, share) => {
    if (mode === 1) return (s, hp) => s.perClaim * (0.5 + hp / share);
    if (mode === 2) return () => -1;
    if (mode === 3) return () => NaN;
    if (mode === 4) return (s, hp, t) => (t < 10 ? s.perClaim : s.perClaim * 2);
    return null;
  };
  const simCases = [];
  const base = (over) => ({ share: 1000, law: laws[0], streams: [{ perClaim: 50, interval: 1, start: 1 }], phases: [], openingS: 0, immunityShare: null, splitPenaltyS: 0, fresh: true, maxSeconds: 3600, burstWindowS: 5, mode: 0, ...over });
  simCases.push(base({}));
  simCases.push(base({ streams: [{ perClaim: 50, interval: 0.1, start: 0.1 }] })); // token-limited
  simCases.push(base({ streams: [{ perClaim: 500, interval: 0.5, start: 0.5 }], share: 20000 })); // bucket dry
  simCases.push(base({ streams: [{ perClaim: 80, interval: 0.5, start: 0.5 }], phases: BREACH_PHASES, share: 3000 }));
  simCases.push(base({ streams: [{ perClaim: 80, interval: 0.5, start: 0.5 }], phases: [{ at: 0.33, shieldS: 3 }, { at: 0.66, shieldS: 3 }, { at: 0.66, shieldS: 1 }], share: 3000 }));
  simCases.push(base({ fresh: false, streams: [{ perClaim: 60, interval: 1 }] }));
  simCases.push(base({ immunityShare: 0.5, openingS: 4, splitPenaltyS: 2.5 }));
  simCases.push(base({ immunityShare: NaN }));
  simCases.push(base({ immunityShare: 5 }));
  simCases.push(base({ immunityShare: -1 }));
  simCases.push(base({ splitPenaltyS: -3 }));
  simCases.push(base({ maxSeconds: 5 })); // cannot kill in time
  simCases.push(base({ maxSeconds: 0 }));
  simCases.push(base({ streams: [] }));
  simCases.push(base({ share: 0 }));
  simCases.push(base({ share: NaN }));
  simCases.push(base({ share: -4 }));
  simCases.push(base({ streams: [{ perClaim: 30, interval: 1, start: 1 }, { perClaim: 30, interval: 1, start: 1 }, { perClaim: 99, interval: 2.5 }] })); // ties
  simCases.push(base({ streams: [{ perClaim: 30, interval: 1, start: 0.5 }, { perClaim: 20, interval: 1, start: 0.5 + 1e-13 }] })); // within the 1e-12 merge tolerance
  simCases.push(base({ openingS: 3, burstWindowS: 5, streams: [{ perClaim: 40, interval: 0.25, start: 0.25 }] }));
  simCases.push(base({ openingS: 9, burstWindowS: 5 }));
  simCases.push(base({ streams: [{ perClaim: NaN, interval: 1, start: 1 }] }));
  simCases.push(base({ streams: [{ perClaim: 10, interval: NaN, start: 1 }] }));
  simCases.push(base({ streams: [{ perClaim: 70, interval: 1, start: 1 }], share: 60 })); // dies on the first claim
  for (const mode of [1, 2, 3, 4]) simCases.push(base({ mode, streams: [{ perClaim: 100, interval: 0.7, start: 0.7 }], share: 2500 }));
  // Shield ending exactly on a claim time (src/allowance.js:180, strict `t < shieldUntil`; gateBrain.js:1308). Interval 1 and
  // start 1 are binary-exact, so the claim at t = until falls exactly on the shield's end and must be accepted. Emitted as
  // the named kind `simulate_shield_end`.
  const wide = { depth: 1000, rate: 100, cap: 100, hitHz: 4 };
  const boundary = [];
  for (const shieldS of [1, 3]) {
    // 100 hp, 10 a claim: hp <= 66 after claim 4 (t=4), <= 33 after claim 7 (t=7)
    boundary.push(base({ share: 100, law: wide, streams: [{ perClaim: 10, interval: 1, start: 1 }], phases: [{ at: 0.66, shieldS }, { at: 0.33, shieldS }] }));
    boundary.push(base({ share: 100, law: wide, streams: [{ perClaim: 10, interval: 1, start: 1 }], phases: [{ at: 0.5, shieldS }] }));
    // unsorted phases, and a second stream whose claims also fall inside and at the end of the shield
    boundary.push(base({ share: 100, law: wide, streams: [{ perClaim: 10, interval: 1, start: 1 }, { perClaim: 1, interval: 0.5, start: 0.5 }], phases: [{ at: 0.33, shieldS }, { at: 0.66, shieldS }] }));
  }
  boundary.push(base({ share: 100, law: wide, streams: [{ perClaim: 10, interval: 1, start: 1 }], phases: [{ at: 0.66, shieldS: 1 }, { at: 0.66, shieldS: 0 }] }));
  boundary.push(base({ share: 100, law: wide, streams: [{ perClaim: 10, interval: 0.25, start: 0.25 }], phases: [{ at: 0.5, shieldS: 1 }] }));
  for (const c of boundary) { c.kind = 'simulate_shield_end'; simCases.push(c); }

  for (let i = 0; i < 160; i++) {
    const b = randomBuild(R);
    const law = allowanceLaw(b.level);
    let streams = claimStreams({ cappedPerSwing: b.cappedPerSwing, hit: b.hit, aps: b.aps, procs: b.procs, cap: R.chance(0.5) ? law.cap : 0, withProcs: b.withProcs });
    if (R.chance(0.2) || !streams.length) {
      streams = [];
      for (let j = R.int(1, 3); j > 0; j--) {
        const interval = R.range(0.1, 3);
        streams.push({ perClaim: R.range(1, 2500), interval, start: R.chance(0.5) ? interval : undefined });
      }
    }
    simCases.push(base({
      share: (law.share / b.players) * R.range(0.05, 1.5),
      law: { depth: law.depth, rate: law.rate, cap: law.cap, hitHz: law.hitHz },
      streams,
      phases: R.chance(0.5) ? BREACH_PHASES : (R.chance(0.5) ? [] : [{ at: R.range(0.1, 0.9), shieldS: R.range(0, 5) }]),
      openingS: R.chance(0.3) ? R.range(0, 8) : 0,
      immunityShare: R.chance(0.3) ? R.range(0, 1) : null,
      splitPenaltyS: R.chance(0.2) ? R.range(0, 10) : 0,
      fresh: R.chance(0.8),
      maxSeconds: R.chance(0.2) ? R.range(10, 600) : 3600,
      burstWindowS: R.chance(0.8) ? 5 : R.range(1, 10),
      mode: R.chance(0.15) ? R.int(1, 4) : 0,
    }));
  }
  for (const c of simCases) {
    const run = simulateAllowance({
      share: c.share,
      law: c.law,
      streams: c.streams,
      phases: c.phases,
      openingS: c.openingS,
      immunityShare: c.immunityShare,
      splitPenaltyS: c.splitPenaltyS,
      fresh: c.fresh,
      maxSeconds: c.maxSeconds,
      burstWindowS: c.burstWindowS,
      perClaimAt: perClaimAtOf(c.mode, c.share),
    });
    out.add(c.kind ?? 'simulate', F(c.share), F(c.law.depth), F(c.law.rate), F(c.law.cap), F(c.law.hitHz), B(c.fresh), F(c.openingS), O(c.immunityShare), F(c.splitPenaltyS), F(c.maxSeconds), F(c.burstWindowS), I(c.mode),
      ...phaseTokens(c.phases), ...streamTokens(c.streams), '=>', ...runTokens(run));
  }

  // runAllowance
  const runCases = [];
  for (let i = 0; i < 120; i++) {
    const b = randomBuild(R);
    const law = allowanceLaw(b.level);
    const streams = claimStreams({ cappedPerSwing: b.cappedPerSwing, hit: b.hit, aps: b.aps, procs: b.procs, cap: law.cap, withProcs: b.withProcs });
    const hasSpec = R.chance(0.7);
    const spec = hasSpec ? allowanceSpec(b.level, { players: b.players, phases: R.chance(0.6) ? BREACH_PHASES : [], openingS: R.chance(0.3) ? R.range(0, 6) : 0, immunityShare: R.chance(0.3) ? R.range(0, 0.9) : null }) : undefined;
    runCases.push({ level: b.level, share: (law.share / b.players) * R.range(0.1, 1.2), spec, streams, fresh: R.chance(0.8), split: R.chance(0.2) ? R.range(0, 8) : 0 });
  }
  runCases.push({ level: 1, share: 100, spec: undefined, streams: [], fresh: true, split: 0 });
  runCases.push({ level: 1, share: 0, spec: undefined, streams: [{ perClaim: 1, interval: 1, start: 1 }], fresh: true, split: 0 });
  runCases.push({ level: 30, share: 5000, spec: allowanceSpec(30, {}), streams: [{ perClaim: 100, interval: 0.5, start: 0.5 }], fresh: true, split: 0 });
  runCases.push({ level: 30, share: 5000, spec: allowanceSpec(30, { openingS: 0, immunityShare: 0 }), streams: [{ perClaim: 100, interval: 0.5, start: 0.5 }], fresh: true, split: 0 }); // ttk path
  runCases.push({ level: 30, share: 5000, spec: undefined, streams: [{ perClaim: 100000, interval: 0.5, start: 0 }], fresh: true, split: 0 }); // first claim at t=0: ttk may be 0 (falsy)
  for (const c of runCases) {
    const r = runAllowance({ level: c.level, share: c.share, spec: c.spec, streams: c.streams, fresh: c.fresh, splitPenaltyS: c.split });
    const sp = c.spec;
    const head = ['run', F(c.level), F(c.share), B(!!sp), F(sp ? sp.openingS : 0), O(sp ? sp.immunityShare : null), ...phaseTokens(sp ? sp.phases : []), ...streamTokens(c.streams), B(c.fresh), F(c.split), '=>'];
    if (!r) { out.add(...head, 'null'); continue; }
    out.add(...head, F(r.law.ref), F(r.law.depth), F(r.law.rate), F(r.law.cap), F(r.law.hitHz), F(r.law.share), F(r.share), ...runTokens(r),
      F(r.ceilingDps), F(r.sustainedDps), B(r.saturated), F(r.claimsPerSecond), F(r.burst5Dps), O(r.averageDps));
  }
  return out.write();
}

// ---------------------------------------------------------------------------------------------------------------
// relay claim engine
// ---------------------------------------------------------------------------------------------------------------
const RESULT_KEYS = [['reason', 's'], ['t', 'f'], ['claim', 'f'], ['accepted', 'b'], ['refused', 'b'], ['tokenSpent', 'b'], ['want', 'f'], ['capped', 'f'], ['got', 'f'], ['clipped', 'f'], ['capClip', 'f'], ['bucketClip', 'f'], ['healthClip', 'f'], ['bucketBefore', 'f'], ['bucketRefilled', 'f'], ['bucketAfter', 'f'], ['tokensBefore', 'f'], ['tokensRefilled', 'f'], ['tokensAfter', 'f'], ['hpAfter', 'f'], ['clippedAfter', 'f'], ['dealtAfter', 'f'], ['killed', 'b'], ['dead', 'b']];
const SUMMARY_KEYS = [['level', 'f'], ['ref', 'o'], ['share', 'f'], ['hp', 'f'], ['remainingShare', 'f'], ['killed', 'b'], ['killedAt', 'o'], ['time', 'f'], ['claims', 'i'], ['accepted', 'i'], ['refused', 'i'], ['invalid', 'i'], ['dead', 'i'], ['shielded', 'i'], ['noToken', 'i'], ['empty', 'i'], ['offered', 'f'], ['dealt', 'f'], ['clipped', 'f'], ['refusedOffer', 'f'], ['capClip', 'f'], ['bucketClip', 'f'], ['healthClip', 'f'], ['landedShare', 'f'], ['saturated', 'b'], ['bucketLimited', 'i'], ['tokenLimited', 'i'], ['dryAt', 'o'], ['bucket', 'f'], ['bucketAt', 'f'], ['bucketCapacity', 'f'], ['bucketRate', 'f'], ['tokens', 'f'], ['tokenAt', 'f'], ['tokenCapacity', 'f'], ['tokenRate', 'f'], ['cap', 'f'], ['shieldUntil', 'f'], ['acceptedDps', 'o'], ['offeredDps', 'o'], ['killDps', 'o'], ['firstAcceptedAt', 'o'], ['lastClaimAt', 'o']];
const RTOK = { ...TOK, s: (v) => String(v) };

function genRelay() {
  const out = new Out('relay_claim', 'kinds: relay_ctor level share law(0 | 1 depth rate cap hitHz ref(opt)) => ok|err | relay level share fresh shieldUntil law(0 | 1 depth rate cap hitHz ref(opt)) nclaims (t damage)* => per-claim (E | R reason t claim accepted refused tokenSpent want capped got clipped capClip bucketClip healthClip bucketBefore bucketRefilled bucketAfter tokensBefore tokensRefilled tokensAfter hpAfter clippedAfter dealtAfter killed dead)* then the summary fields in SUMMARY order (see tools/rust-vectors.mjs SUMMARY_KEYS)');
  const R = makeLcg(0x5005);

  const lawTokens = (law) => (law ? ['1', F(law.depth), F(law.rate), F(law.cap), F(law.hitHz), O(law.ref)] : ['0']);
  const build = (level, share, fresh, shieldUntil, law) => createRelayClaimEngine({ level, share, fresh, shieldUntil, law: law ?? null });

  // constructor checks
  const customLaw = (o) => ({ depth: 90, rate: 18, cap: 72, hitHz: 4, ref: 6, ...o });
  const ctorCases = [
    [1, 100, null], [1, 0, null], [1, -1, null], [1, NaN, null], [1, Infinity, null], [0, 5e-324, null], [NaN, 10, null], [60, 1e300, null],
    [1, 100, customLaw({})], [1, 100, customLaw({ depth: 0 })], [1, 100, customLaw({ rate: -1 })], [1, 100, customLaw({ cap: NaN })], [1, 100, customLaw({ hitHz: Infinity })],
    [1, 100, customLaw({ ref: undefined })], [3, 100, customLaw({ ref: undefined })], [1, 100, customLaw({ ref: 20 })],
  ];
  for (const [level, share, law] of ctorCases) {
    let ok = true;
    try { build(level, share, true, 0, law); } catch { ok = false; }
    out.add('relay_ctor', F(level), F(share), ...lawTokens(law), '=>', ok ? 'ok' : 'err');
  }

  const scenario = (level, share, fresh, shieldUntil, law, claims) => {
    const eng = build(level, share, fresh, shieldUntil, law);
    const toks = [];
    for (const [t, d] of claims) {
      let r;
      try { r = eng.claim({ t, damage: d }); } catch { toks.push('E'); continue; }
      toks.push('R', ...RESULT_KEYS.map(([k, ty]) => RTOK[ty](r[k])));
    }
    const s = eng.summary();
    toks.push(...SUMMARY_KEYS.map(([k, ty]) => RTOK[ty](s[k])));
    out.add('relay', F(level), F(share), B(fresh), F(shieldUntil), ...lawTokens(law), I(claims.length), ...claims.flatMap(([t, d]) => [F(t), F(d)]), '=>', ...toks);
  };

  // hand-picked
  scenario(1, 1000, true, 0, null, [[1, 100], [1, 100], [1.1, 30], [2, 30], [3, 30], [4, 30]]);
  scenario(1, 1000, true, 0, null, [[0, 10], [0, 10], [0, 10], [0, 10], [0, 10], [0, 10], [0.25, 10], [0.5, 10]]); // token-limited, then refill
  scenario(1, 100000, true, 0, null, Array.from({ length: 40 }, (_, i) => [i * 0.25, 72])); // bucket runs dry
  scenario(1, 100000, false, 0, null, [[0, 50], [1, 50], [2, 50], [3, 50]]); // wounded boss: empty bucket
  scenario(1, 200, true, 2, null, [[0.5, 10], [1.99, 10], [2, 10], [2.5, 10]]); // shield, boundary accepted
  scenario(10, 300, true, 0, null, [[1, 0], [2, -5], [3, NaN], [4, Infinity], [5, -Infinity], [6, 20], [7, 1e-300], [8, 5e-324]]); // invalid claims
  scenario(10, 100, true, 0, null, [[1, 60], [2, 60], [3, 1000], [4, 5], [5, 5]]); // kill then dead
  scenario(10, 100, true, 0, null, [[1, 99.9999995], [2, 5], [3, 5]]); // leaves a residue <= 1e-6: killed
  scenario(10, 100, true, 0, null, [[1, 99.99], [2, 5]]); // residue above the epsilon: alive
  scenario(1, 500, true, 0, null, [[1, 10], [0.5, 10], [NaN, 10], [Infinity, 10], [-Infinity, 10], [2, 10]]); // order and finite-time errors
  scenario(1, 500, true, 0, customLaw({}), [[1, 100], [2, 100], [3, 100]]);
  scenario(1, 500, true, 0, customLaw({ ref: undefined }), [[1, 100], [2, 100]]);
  scenario(1, 500, true, 0, customLaw({ depth: 20, rate: 5, cap: 15, hitHz: 2, ref: 9 }), Array.from({ length: 30 }, (_, i) => [i * 0.2, 30]));
  scenario(1, 500, true, NaN, null, [[1, 10]]);
  scenario(1, 500, true, -3, null, [[1, 10]]);
  scenario(1, 500, true, Infinity, null, [[1, 10], [2, 10]]);
  scenario(60, 15600, true, 0, null, Array.from({ length: 30 }, (_, i) => [i * 0.3, 1500 + i]));
  scenario(1, 1e-7, true, 0, null, [[1, 5], [2, 5]]);
  scenario(1, 50, true, 0, null, []);

  // random
  for (let i = 0; i < 220; i++) {
    const level = R.chance(0.1) ? R.range(-3, 70) : R.int(1, 60);
    const law = allowanceLaw(level);
    const share = law.share * R.range(0.02, 1.5);
    const fresh = R.chance(0.75);
    const shieldUntil = R.chance(0.25) ? R.range(0, 20) : 0;
    const useLaw = R.chance(0.15) ? customLaw({ depth: R.range(5, 500), rate: R.range(1, 100), cap: R.range(2, 400), hitHz: R.range(0.5, 8), ref: R.chance(0.5) ? R.int(6, 65) : undefined }) : null;
    const n = R.int(5, 90);
    const claims = [];
    let t = R.chance(0.5) ? 0 : R.range(0, 2);
    for (let j = 0; j < n; j++) {
      const gap = R.chance(0.15) ? 0 : (R.chance(0.1) ? R.range(1, 8) : R.range(0.01, 0.4));
      t += gap;
      let d = R.range(0.1, law.ref * R.pick([2, 5, 15, 40]));
      const r = R.u32() % 60;
      if (r === 0) d = 0; else if (r === 1) d = -d; else if (r === 2) d = NaN; else if (r === 3) d = Infinity;
      claims.push([R.chance(0.02) ? t - R.range(0.1, 1) : t, d]);
    }
    scenario(level, share, fresh, shieldUntil, useLaw, claims);
  }
  return out.write();
}

// ---------------------------------------------------------------------------------------------------------------
// swing (src/model.js:381-399 and :179). swingFrameSeconds, swingHeft and swingHandling are exported; classicStrength
// is module-private, so its exact source text is cut out of src/model.js and evaluated (it fails loudly if it moves).
// ---------------------------------------------------------------------------------------------------------------
const { classicStrength } = new Function(
  'damageModifier', 'pcaaoDamageModifier',
  `${grab(/function classicStrength\(str, opts = \{\}\) \{\n[^}]*\n\}/, 'classicStrength')}\nreturn { classicStrength };`,
)(damageModifier, pcaaoDamageModifier);

function genSwing() {
  const out = new Out('swing', 'kinds: swing_frame speed(opt) heft(opt) handling(opt) r | swing_heft weight(opt) strength(opt) r | swing_handling has(bool) type(opt) shortBlade(bool) twoHanded(bool) r (has 0 = no weapon: the next three tokens are the placeholders - 0 0) | classic_strength str opts(- = opts lacks the key, 1 = true, 0 = false) r. opt: - for undefined (the JS default applies), else f64');
  const R = makeLcg(0x6006);

  // swingFrameSeconds: the full cross of the hand-picked values, then a sweep
  const speeds = [undefined, NaN, Infinity, -Infinity, -0, 0, 0.5, 49.5, 50, 50.5, 100, 100.5, -5, 150, 1e300, -1e300, 5e-324, 1e-9];
  for (let i = 0; i < 40; i++) speeds.push(R.range(-20, 120));
  const hefts = [undefined, NaN, Infinity, -1, 0, 0.5, 1, 1.2, 2, 1e300];
  const handlings = [undefined, NaN, -0.5, 0, 0.4, 1.5, ...Object.values(SWING_HANDLING)];
  for (const s of speeds) {
    for (const h of hefts) {
      for (const hd of handlings) out.add('swing_frame', O(s), O(h), O(hd), F(swingFrameSeconds(s, { heft: h, handling: hd })));
    }
  }
  const handlingPool = handlings.filter((x) => x !== undefined);
  for (let i = 0; i < 300; i++) {
    const s = R.range(-20, 120);
    const h = R.range(0.5, 2);
    const hd = R.pick(handlingPool);
    out.add('swing_frame', F(s), F(h), F(hd), F(swingFrameSeconds(s, { heft: h, handling: hd })));
  }

  // swingHeft
  const weights = [undefined, NaN, Infinity, -Infinity, -1, -0, 0, 0.5, 0.75, 2, 2.5, 3.5, 5, 7, 7.5, 1e9, 20];
  const strengths = [undefined, NaN, -Infinity, -10, 0, 1, 20, 49, 50, 51, 99.9, 100, 101, 150, 1e9];
  for (const w of weights) for (const s of strengths) out.add('swing_heft', O(w), O(s), F(swingHeft(w, s)));
  for (let i = 0; i < 300; i++) {
    const w = R.range(-2, 12);
    const s = R.range(-10, 160);
    out.add('swing_heft', F(w), F(s), F(swingHeft(w, s)));
  }

  // swingHandling: no weapon, every WEAPONS template, synthetic types (absent, NaN, -0, off-table, out-of-range), flags
  const weaponCases = [null, undefined, ...Object.values(WEAPONS)];
  for (const t of [undefined, NaN, -0, 0, 1, 2, 3, 4, 4.5, 5, 13, 14, 15, 16, 17, 18, 19, 20, 100, -4]) {
    weaponCases.push({ type: t, shortBlade: false, twoHanded: false });
  }
  for (const t of [4, 0, 15, 17, undefined]) {
    for (const sb of [false, true]) for (const th of [false, true]) weaponCases.push({ type: t, shortBlade: sb, twoHanded: th });
  }
  for (const w of weaponCases) {
    if (!w) out.add('swing_handling', '0', '-', '0', '0', F(swingHandling(w)));
    else out.add('swing_handling', '1', O(w.type), B(!!w.shortBlade), B(!!w.twoHanded), F(swingHandling(w)));
  }

  // classicStrength: the Strength term with the opts key absent, true, or false
  const strs = [NaN, Infinity, -Infinity, 0, -0, 1e-9, 50, 49.5, 55, 75.5, 100, 150, -5, 1e300, -1e300];
  for (let i = 0; i < 120; i++) strs.push(R.range(-20, 150));
  for (const s of strs) {
    for (const fixed of [undefined, true, false]) {
      const opts = fixed === undefined ? {} : { fixedStrengthDamageModifier: fixed };
      out.add('classic_strength', F(s), fixed === undefined ? '-' : B(fixed), F(classicStrength(s, opts)));
    }
  }
  return out.write();
}

// ---------------------------------------------------------------------------------------------------------------
// target (src/target.js, R3a: the pure half up to gearEnemy). The builders (enemyTarget, standInTarget, makeTarget)
// and armourPiece make the targets and the worn pieces the vectors read, through the real JS; every function under
// test is called directly on those objects. Targets and attackers are written once as definitions (`tgt`, `atk`),
// and cases refer to them by id, so a case stays short.
// ---------------------------------------------------------------------------------------------------------------
const TARGET_STATS = ['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck'];
const TARGET_EFFECT_KINDS = ['disease', 'poison', 'artifact', 'racialOverride', 'fortifyAttribute', 'drainAttribute', 'transferAttribute', 'spellShield'];
const STAT_MOD_KINDS = new Set(['disease', 'poison', 'artifact', 'racialOverride']);
const STAT_NAME_KINDS = new Set(['fortifyAttribute', 'drainAttribute', 'transferAttribute']);
const GEAR_TEMPLATES = [102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112];
const GEAR_MATERIALS = [0, 256, 259, 512, 513, 514, 515, 516, 517, 518, 519, 520, 521];
const BYTES = [0, 1, 2, 3, 4, 5, 8, 9, 16, 17, 32, 64, 96, 128, 255, 0x0c, 0x30, 0x7f];
const PARTS = [0, 1, 2, 3, 4, 5, 6, 0, 2, 4, 6, 7, -1, 2.5];
// float32 edges (2^24 + 1 is the first integer a float32 rounds; 3.4028235e38 is the largest float32; 1.4e-45 the
// smallest subnormal) and the 1e-9 boundary sit with the ties at .5, -0 and the infinities.
const DAMAGES = [0, -0, 1, 0.5, 2.5, 3.5, 4.5, -3, 7.25, 12.345, 49.5, 100, 250.75, 1000, 1e6, 1e15, 5e-324, 1e-9, NaN, Infinity, -Infinity, 33.333333333333336, 16777217, 16777216.5, 3.4028235e38, 1.401298464324817e-45, 1e-9 + 1e-17];
const MAPS = [null, (x) => x * 0.75, (x) => x + 1, (x) => Math.floor(x / 3)];

function genTarget() {
  const R = makeLcg(0x7a2e);
  const out = new Out('target', [
    'defs: tgt id isPlayer(b) isClass(opt bool: - = null/undefined, 1 true, 0 false) careerIndex(opt) level(opt) combatLevel(opt) CAREER LIVE n(armorValues) f64* n(slots) (slot f64, ITEM)*;',
    'atk id LIVE attackModifierFlags(opt) CAREER. CAREER = 5 opts (resistanceFlags immunityFlags lowToleranceFlags criticalWeaknessFlags attackModifierFlags).',
    'LIVE = 8 f64 stats (NaN = missing) n(effects) (kind ended payload)* 16 opts (_mods.stats then _mods.statMax); payload = 8 opts (statMods) for disease|poison|artifact|racialOverride, or name(-|n:) opt(magnitude) for fortify|drain|transferAttribute, or nothing.',
    'ITEM = group=Armor(b) templateIndex(opt) material(opt) artifact(b) maxCondition(opt) currentCondition(opt). ITEMOPT = 0 | 1 ITEM. WOPT = 0 | 1 skillId material flags itemFlags (opts). TREF/AREF = - | tgt/atk id.',
    'cases: career_tolerance flag CAREER => word | element_share TREF element(-|n:) => f64 | natural TREF => f64 | live_stat t|a id stat => f64 | enemy_type_group TREF => f64 | bonus_range AREF TREF => group decoded bonus penalty will targetLevel | bonus_value AREF TREF roll => f64 | bonus_values AREF TREF => n f64* | silver_applies TREF WOPT => b | skeletal_damage damage TREF WOPT => f64 | is_skeletal TREF => b | monster_hide TREF damage blunt natural(opt, - = default) exact => f64 | intrinsic_damage TREF damage WOPT exact => f64',
    'armour_material_id ITEMOPT => f64 | armour_condition ITEMOPT sharp => f64 | armour_reduction ITEMOPT damage natural blunt unarmed sharp => f64 | shield_reduction (same) => f64 | shield_block TREF strong ITEMOPT => f64 | shield_beats TREF part natural(opt) sharp => b | struck_slot TREF part => ITEMOPT | left_hand TREF => ITEMOPT | has_worn TREF => b',
    'part_outcomes TREF damage part WOPT sharp => n (p damage)* | part_damage TREF damage part WOPT sharp => f64 | expected_damage TREF damage WOPT weights(- default, else n f64*) map(- none, 1 x*0.75, 2 x+1, 3 floor(x/3)) => f64|-',
    'equip_armour TREF n ITEM* armorValues(b) => n (slot ITEM)* m f64* | material_armor_value material(NaN = missing) => f64 | item_armor_value ITEMOPT => f64 | enemy_group career => f64 | career_attack_modifier flags group => f64 | enemy_entity_type id => monster|class|null | enemy_career_index id => f64 | slot_for_body_part part => f64 | armor_body_parts ITEMOPT => n part* | condition_percentage ITEMOPT => f64 | armour_piece max(opt) condition => f64 | body_part_weights overhaul|struck|undef => n f64* | silver_doubles TREF => b | is_shield_template t(opt) => b | enemy_armor_values isClass(b) armor n (piece(opt) material(opt) shield(b))* => 7 f64',
  ].join(' | '));

  // ---- the targets, built by the real builders, gear worn by the real armourPiece / equipArmour ----
  const zoo = [];
  const ids = new Map();
  const addT = (t) => {
    ids.set(t, zoo.length);
    zoo.push(t);
    return t;
  };
  const cloneTarget = (t) => ({
    ...t,
    stats: { ...(t.stats ?? {}) },
    activeEffects: [...(t.activeEffects ?? [])],
    armorValues: t.armorValues ? [...t.armorValues] : t.armorValues,
    equip: { slots: { ...(t.equip?.slots ?? {}) } },
  });
  const byte = () => R.pick(BYTES);
  const randMods = () => Object.fromEntries(TARGET_STATS.filter(() => R.chance(0.5)).map((k) => [k, R.pick([0, 5, -3, 12.5, 100, NaN, undefined])]));
  const randEffects = () => Array.from({ length: R.int(0, 3) }, () => {
    const kind = R.pick(TARGET_EFFECT_KINDS);
    const ended = R.chance(0.2);
    if (STAT_MOD_KINDS.has(kind)) return { kind, ended, statMods: randMods() };
    if (STAT_NAME_KINDS.has(kind)) {
      return { kind, ended, stat: R.pick([...TARGET_STATS, 'vitality', undefined]), magnitude: R.pick([undefined, 0, 3, -2.5, 40, NaN]) };
    }
    return { kind, ended };
  });
  const randStats = () => Object.fromEntries(TARGET_STATS.map((k) => [k, R.chance(0.08) ? undefined : R.pick([50, 50, 49, 51, 0, 100, 150, -5, 33.5, NaN, Infinity, 62.25])]));
  const randomItem = () => (R.chance(0.05) ? null : {
    group: R.chance(0.8) ? 'Armor' : R.pick(['Weapons', 'MensClothing', undefined]),
    templateIndex: R.pick([...GEAR_TEMPLATES, 113, 200, 500, 512, undefined, 109.5]),
    material: R.pick([undefined, null, 0, 256, 259, 512, 513, 514, 515, 516, 517, 518, 519, 520, 521, 3, 300, NaN, 0.5]),
    artifact: R.chance(0.1),
    maxCondition: R.pick([undefined, null, 0, 1, 40, 100, 255, -5, NaN, 7.5, 60]),
    // the percentage thresholds of conditionPercentage's ladder (5/6, 15/16, 40/41, 60/61, 75/76, 91/92), and 100
    currentCondition: R.pick([undefined, null, 0, 1, 5, 6, 16, 20, 41, 50, 61, 76, 92, 100, 77, 255, NaN, 3]),
  });
  const randomWeapon = () => {
    if (R.chance(0.15)) return null;
    const w = {
      skillId: R.pick([SKILLS.BluntWeapon, SKILLS.LongBlade, SKILLS.ShortBlade, SKILLS.Axe, undefined, 99]),
      material: R.pick([undefined, 0, 1, 2, 2, 3, NaN, 2.5]),
      flags: R.pick([undefined, 0, 16, 0x11, 0x0f, NaN, 32, -1]),
    };
    if (R.chance(0.5)) w.item = { flags: R.pick([undefined, 0, 16, 0x10, 7, NaN]) };
    return w;
  };
  const randPieces = () => Array.from({ length: R.int(1, 3) }, () => armourPiece(R.pick(GEAR_TEMPLATES), {
    material: R.pick(GEAR_MATERIALS),
    condition: R.pick([0, 0.1, 0.3, 0.5, 0.8, 0.95, 1, 1.5, -1, NaN]),
  }));

  let monsters = 0;
  let classes = 0;
  let skipped = 0;
  for (let id = 0; id <= 42; id++) {
    try {
      addT(enemyTarget(id, { exactLevel: true }));
      monsters++;
    } catch {
      skipped++; // a mobile with no body (39 is an empty slot): the builder refuses it, as the game would
    }
  }
  for (let id = 128; id <= 146; id++) {
    for (const lvl of [1, 9, 37]) {
      try {
        addT(enemyTarget(id, { playerLevel: lvl, exactLevel: true }));
        classes++;
      } catch {
        skipped++;
      }
    }
  }
  addT(standInTarget(31));
  addT(standInTarget(36));
  const built = zoo.length;
  for (let i = 0; i < 120; i++) {
    const g = cloneTarget(zoo[R.int(0, built - 1)]);
    equipArmour(g, randPieces(), { armorValues: R.chance(0.5) });
    addT(g);
  }
  for (let i = 0; i < 240; i++) {
    const t = makeTarget({
      isPlayer: R.chance(0.1),
      isClass: R.pick([true, false, false, undefined]),
      careerIndex: R.pick([-1, 0, 2, 3, 9, 14, 15, 18, 22, 25, 26, 27, 28, 31, 36, 38, 40, 41, 45, 12, 1.5, NaN, undefined, null]),
      career: R.chance(0.6) ? { resistanceFlags: byte(), immunityFlags: byte(), lowToleranceFlags: byte(), criticalWeaknessFlags: byte(), attackModifierFlags: byte() } : null,
      level: R.pick([1, 2, 10, 21, 45, 37, 0.5, NaN, undefined, 6]),
      combatLevel: R.pick([null, undefined, 1, 30, 0, NaN, 21, 12]),
      stats: randStats(),
      activeEffects: randEffects(),
      _mods: R.chance(0.3) ? { stats: randMods(), statMax: randMods() } : undefined,
      armorValues: R.pick([undefined, [], Array.from({ length: 7 }, () => R.range(0, 100))]),
    });
    if (R.chance(0.45)) equipArmour(t, randPieces(), { armorValues: R.chance(0.5) });
    addT(t);
  }
  const attackers = [];
  const aids = new Map();
  for (let i = 0; i < 60; i++) {
    const a = {
      stats: randStats(),
      activeEffects: randEffects(),
      _mods: R.chance(0.5) ? { stats: randMods(), statMax: randMods() } : undefined,
      attackModifierFlags: R.chance(0.5) ? byte() : undefined,
      career: R.chance(0.5) ? { resistanceFlags: byte(), immunityFlags: byte(), lowToleranceFlags: byte(), criticalWeaknessFlags: byte(), attackModifierFlags: byte() } : null,
    };
    aids.set(a, attackers.length);
    attackers.push(a);
  }

  const TREF = (t) => (t === null || t === undefined ? '-' : String(ids.get(t)));
  const AREF = (a) => (a === null || a === undefined ? '-' : String(aids.get(a)));
  const pickT = () => (R.chance(0.08) ? null : zoo[R.int(0, zoo.length - 1)]);
  const pickTn = () => zoo[R.int(0, zoo.length - 1)];
  const pickA = () => (R.chance(0.15) ? null : attackers[R.int(0, attackers.length - 1)]);
  const itemTok = (it) => [B(it.group === 'Armor'), O(it.templateIndex), O(it.material), B(!!it.artifact), O(it.maxCondition), O(it.currentCondition)];
  const ITEMOPT = (it) => (it === null || it === undefined ? ['0'] : ['1', ...itemTok(it)]);
  const WOPT = (w) => (w === null || w === undefined ? ['0'] : ['1', O(w.skillId), O(w.material), O(w.flags), O(w.item?.flags)]);
  const careerTok = (c) => [O(c?.resistanceFlags), O(c?.immunityFlags), O(c?.lowToleranceFlags), O(c?.criticalWeaknessFlags), O(c?.attackModifierFlags)];
  const effectTok = (a) => {
    const head = [a.kind, B(!!a.ended)];
    if (STAT_MOD_KINDS.has(a.kind)) return [...head, ...TARGET_STATS.map((k) => O(a.statMods?.[k]))];
    if (STAT_NAME_KINDS.has(a.kind)) return [...head, NO(a.stat), O(a.magnitude)];
    return head;
  };
  const liveTok = (ch) => [
    ...TARGET_STATS.map((k) => F(typeof ch?.stats?.[k] === 'number' ? ch.stats[k] : NaN)),
    I((ch?.activeEffects ?? []).length), ...(ch?.activeEffects ?? []).flatMap(effectTok),
    ...TARGET_STATS.map((k) => O(ch?._mods?.stats?.[k])), ...TARGET_STATS.map((k) => O(ch?._mods?.statMax?.[k])),
  ];
  const slotEntries = (t) => Object.entries(t.equip?.slots ?? {})
    .filter(([, it]) => it)
    .map(([k, it]) => [Number(k), it])
    .sort((a, b) => a[0] - b[0]);
  const armorTok = (t) => [I((t.armorValues ?? []).length), ...(t.armorValues ?? []).map((v) => F(v))];
  const equipOut = (t) => {
    const sl = slotEntries(t);
    return [I(sl.length), ...sl.flatMap(([s, it]) => [F(s), ...itemTok(it)]), ...armorTok(t)];
  };
  for (let i = 0; i < zoo.length; i++) {
    const t = zoo[i];
    const sl = slotEntries(t);
    out.add('tgt', String(i), B(!!t.isPlayer), t.isClass === undefined || t.isClass === null ? '-' : B(!!t.isClass),
      O(t.careerIndex), O(t.level), O(t.combatLevel), ...careerTok(t.career), ...liveTok(t), ...armorTok(t),
      I(sl.length), ...sl.flatMap(([s, it]) => [F(s), ...itemTok(it)]));
  }
  for (let i = 0; i < attackers.length; i++) {
    const a = attackers[i];
    out.add('atk', String(i), ...liveTok(a), O(a.attackModifierFlags), ...careerTok(a.career));
  }
  const strike = () => ({ natural: R.pick([0, 0.1, 0.25, 0.5, -0.5, NaN, 0.0666, 1]), blunt: R.chance(0.5), unarmed: R.chance(0.2), sharp: R.chance(0.3) });
  const dmg = () => (R.chance(0.5) ? R.pick(DAMAGES) : R.range(-20, 320));
  const wtoks = (wm) => (wm === null ? ['-'] : [I(wm.length), ...wm.map((x) => F(x))]);

  // A: career tolerance and the elemental share
  const FLAGS = [0, 1, 2, 3, 4, 5, 8, 16, 17, 32, 33, 64, 96, 128, 255, -1, 1.5, NaN, Infinity, 1e9, -0];
  const ELEMENTS = ['fire', 'Fire', 'FROST', 'shock', 'Poison', 'magic', 'MAGIC', '', 'constructor', '__proto__', 'toString', 'fire ', 'Ice', 'i̇gnis', 'Kold'];
  for (let i = 0; i < 2400; i++) {
    const c = R.chance(0.1) ? null : { resistanceFlags: byte(), immunityFlags: byte(), lowToleranceFlags: byte(), criticalWeaknessFlags: byte(), attackModifierFlags: byte() };
    const flag = R.pick(FLAGS);
    out.add('career_tolerance', F(flag), ...careerTok(c), '=>', careerTolerance(c, flag));
  }
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    const e = R.chance(0.1) ? null : R.pick(ELEMENTS);
    out.add('element_share', TREF(t), e === null ? '-' : N(e), '=>', F(elementShare(t, e)));
  }

  // B: natural resistance and liveStat
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    out.add('natural', TREF(t), '=>', F(naturalDamageResistance(t)));
  }
  for (let i = 0; i < 2400; i++) {
    const useT = R.chance(0.5);
    const ch = useT ? pickTn() : attackers[R.int(0, attackers.length - 1)];
    const stat = R.pick(TARGET_STATS);
    out.add('live_stat', useT ? 't' : 'a', String(useT ? ids.get(ch) : aids.get(ch)), stat, '=>', F(liveStat(ch, stat)));
  }

  // C: the enemy-type bonus and the target's group
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    out.add('enemy_type_group', TREF(t), '=>', F(enemyTypeGroup(t)));
  }
  for (let i = 0; i < 2400; i++) {
    const a = pickA();
    const t = pickT();
    const r = enemyTypeBonusRange(a, t);
    out.add('bonus_range', AREF(a), TREF(t), '=>', F(r.group), F(r.decoded), F(r.bonus), F(r.penalty), F(r.will), F(r.targetLevel));
  }
  for (let i = 0; i < 2400; i++) {
    const a = pickA();
    const t = pickT();
    const roll = R.chance(0.2) ? R.pick([0, 1e-9, 0.5, 0.999999999, 1]) : R.unit();
    out.add('bonus_value', AREF(a), TREF(t), F(roll), '=>', F(enemyTypeBonusValue(a, t, roll)));
  }
  for (let i = 0; i < 2400; i++) {
    const a = pickA();
    const t = pickT();
    const vals = enemyTypeBonusValues(a, t);
    out.add('bonus_values', AREF(a), TREF(t), '=>', I(vals.length), ...vals.map((v) => F(v)));
  }

  // D: silver and the Skeletal Warrior
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    const w = randomWeapon();
    out.add('silver_applies', TREF(t), ...WOPT(w), '=>', B(silverApplies(t, w)));
  }
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    const w = randomWeapon();
    const d = dmg();
    out.add('skeletal_damage', F(d), TREF(t), ...WOPT(w), '=>', F(skeletalSilverDamage(d, t, w)));
  }
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    out.add('is_skeletal', TREF(t), '=>', B(isSkeletalTarget(t)));
  }

  // E: the monster hide and the intrinsic damage
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    const d = dmg();
    const blunt = R.chance(0.5);
    const nat = R.chance(0.3) ? undefined : R.pick([0, 0.1, 0.25, 0.5, 0.3333, -0.5, 1, NaN]);
    const exact = R.chance(0.3);
    out.add('monster_hide', TREF(t), F(d), B(blunt), nat === undefined ? '-' : F(nat), B(exact), '=>', F(monsterHideDamage(t, d, blunt, nat, exact)));
  }
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    const w = randomWeapon();
    const d = dmg();
    const exact = R.chance(0.3);
    out.add('intrinsic_damage', TREF(t), F(d), ...WOPT(w), B(exact), '=>', F(intrinsicDamage(t, d, { weapon: w, exact })));
  }

  // F: worn armour and the armour reduction rows
  for (let i = 0; i < 2400; i++) {
    const it = randomItem();
    out.add('armour_material_id', ...ITEMOPT(it), '=>', F(armourMaterialId(it)));
  }
  for (let i = 0; i < 2400; i++) {
    const it = randomItem();
    const sharp = R.chance(0.3);
    out.add('armour_condition', ...ITEMOPT(it), B(sharp), '=>', F(armourConditionMultiplier(it, { sharpEdge: sharp })));
  }
  for (let i = 0; i < 2400; i++) {
    const it = randomItem();
    const d = dmg();
    const s = strike();
    const opts = { natural: s.natural, blunt: s.blunt, unarmed: s.unarmed, sharpEdge: s.sharp };
    out.add('armour_reduction', ...ITEMOPT(it), F(d), F(s.natural), B(s.blunt), B(s.unarmed), B(s.sharp), '=>', F(armourReduction(it, d, opts)));
  }
  for (let i = 0; i < 2400; i++) {
    const it = randomItem();
    const d = dmg();
    const s = strike();
    const opts = { natural: s.natural, blunt: s.blunt, unarmed: s.unarmed, sharpEdge: s.sharp };
    out.add('shield_reduction', ...ITEMOPT(it), F(d), F(s.natural), B(s.blunt), B(s.unarmed), B(s.sharp), '=>', F(shieldReduction(it, d, opts)));
  }

  // G: the shield, the struck slot, the left hand, the worn check
  for (let i = 0; i < 2400; i++) {
    const t = pickTn();
    const strong = R.chance(0.5);
    const it = randomItem();
    out.add('shield_block', TREF(t), B(strong), ...ITEMOPT(it), '=>', F(shieldBlockChance(t, strong, it)));
  }
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    const part = R.pick(PARTS);
    const nat = R.chance(0.3) ? undefined : R.pick([0, 0.2, 0.4, NaN]);
    const sharp = R.chance(0.3);
    out.add('shield_beats', TREF(t), F(part), nat === undefined ? '-' : F(nat), B(sharp), '=>', B(shieldBeatsUnderArmour(t, part, nat, { sharpEdge: sharp })));
  }
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    const part = R.pick(PARTS);
    out.add('struck_slot', TREF(t), F(part), '=>', ...ITEMOPT(struckSlotItem(t, part)));
  }
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    out.add('left_hand', TREF(t), '=>', ...ITEMOPT(leftHandShield(t)));
  }
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    out.add('has_worn', TREF(t), '=>', B(hasWornEquipment(t)));
  }

  // H: the per-part outcomes, the part damage and the weighted expectation
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    const d = dmg();
    const part = R.pick(PARTS);
    const w = randomWeapon();
    const sharp = R.chance(0.3);
    const o = targetPartOutcomes(t, d, part, { weapon: w, sharpEdge: sharp });
    out.add('part_outcomes', TREF(t), F(d), F(part), ...WOPT(w), B(sharp), '=>', I(o.length), ...o.flatMap((x) => [F(x.p), F(x.damage)]));
  }
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    const d = dmg();
    const part = R.pick(PARTS);
    const w = randomWeapon();
    const sharp = R.chance(0.3);
    out.add('part_damage', TREF(t), F(d), F(part), ...WOPT(w), B(sharp), '=>', F(targetPartDamage(t, d, part, { weapon: w, sharpEdge: sharp })));
  }
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    const d = dmg();
    const w = randomWeapon();
    const wm = R.chance(0.6) ? null : Array.from({ length: R.int(0, 9) }, () => R.pick([0, 0.1, 0.2, 0.3, 0.5, 1, 2, NaN, 0.25]));
    const mi = R.int(0, MAPS.length - 1);
    const v = targetExpectedDamage(t, d, { weapon: w, weights: wm ?? undefined, map: MAPS[mi] });
    out.add('expected_damage', TREF(t), F(d), ...WOPT(w), ...wtoks(wm), String(mi), '=>', O(v));
  }

  // I: equipArmour on minted pieces
  for (let i = 0; i < 2000; i++) {
    const base = pickTn();
    const pieces = randPieces();
    const av = R.chance(0.5);
    const after = cloneTarget(base);
    equipArmour(after, pieces, { armorValues: av });
    out.add('equip_armour', TREF(base), I(pieces.length), ...pieces.flatMap((p) => itemTok(p)), B(av), '=>', ...equipOut(after));
  }

  // J: the scalar helpers of the vendored modules, and the armour piece's condition
  for (let i = 0; i < 2400; i++) {
    const m = R.pick([undefined, null, 0, -0, 3, 256, 259, 300, 511, 512, 513, 516, 521, 522, 0.5, 512.5, -1, NaN, Infinity, 1e9]);
    out.add('material_armor_value', F(m === undefined || m === null ? NaN : m), '=>', F(materialArmorValue(m)));
  }
  for (let i = 0; i < 2400; i++) {
    const it = randomItem();
    out.add('item_armor_value', ...ITEMOPT(it), '=>', F(itemArmorValue(it)));
  }
  const CAREER_IDS = [-3, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 128, 1.5, -0, NaN, Infinity];
  for (let i = 0; i < 2400; i++) {
    const c = R.pick(CAREER_IDS);
    out.add('enemy_group', F(c), '=>', F(enemyEntityGroup(c)));
  }
  for (let i = 0; i < 2400; i++) {
    const fl = R.chance(0.8) ? byte() : R.pick([NaN, 256, -1, 3.7, 0x1ff]);
    const group = R.pick([-1, 0, 1, 2, 3, 4, 1.5, NaN, -0]);
    out.add('career_attack_modifier', F(fl), F(group), '=>', F(careerAttackModifier(fl, group)));
  }
  const MOBILE_IDS = [0, 1, 2, 39, 41, 42, 43, 127, 128, 129, 146, 147, -0, -1, 1.5, NaN, Infinity];
  for (let i = 0; i < 2400; i++) {
    const id = R.chance(0.8) ? R.int(-5, 200) : R.pick(MOBILE_IDS);
    out.add('enemy_entity_type', F(id), '=>', enemyEntityType(id) ?? 'null');
  }
  for (let i = 0; i < 2400; i++) {
    const id = R.chance(0.8) ? R.int(-5, 200) : R.pick(MOBILE_IDS);
    out.add('enemy_career_index', F(id), '=>', F(enemyCareerIndex(id)));
  }
  for (let i = 0; i < 2400; i++) {
    const part = R.pick(PARTS);
    out.add('slot_for_body_part', F(part), '=>', F(slotForBodyPart(part)));
  }
  for (let i = 0; i < 2400; i++) {
    const it = randomItem();
    const ps = armorBodyParts(it);
    out.add('armor_body_parts', ...ITEMOPT(it), '=>', I(ps.length), ...ps.map((p) => F(p)));
  }
  for (let i = 0; i < 2400; i++) {
    const it = randomItem();
    out.add('condition_percentage', ...ITEMOPT(it), '=>', F(conditionPercentage(it)));
  }
  for (let i = 0; i < 2400; i++) {
    const tmpl = R.pick(GEAR_TEMPLATES);
    const mat = R.pick(GEAR_MATERIALS);
    const cond = R.pick([NaN, -1, 0, 0.3, 0.5, 0.999, 1, 2, Infinity, -Infinity, 1e-9, 0.7]);
    const it = armourPiece(tmpl, { material: mat, condition: cond });
    out.add('armour_piece', O(it.maxCondition), F(cond), '=>', F(it.currentCondition));
  }
  for (const core of ['overhaul', 'struck', 'undef']) {
    const w = core === 'undef' ? bodyPartWeights() : bodyPartWeights(core);
    out.add('body_part_weights', core, '=>', I(w.length), ...w.map((x) => F(x)));
  }
  for (let i = 0; i < 2400; i++) {
    const t = pickT();
    out.add('silver_doubles', TREF(t), '=>', B(silverDoubles(t)));
  }
  const SHIELD_IDS = [109, 110, 111, 112, 113, 102, 108, 109.5, NaN, 0, -0, 512, undefined, null];
  for (let i = 0; i < 2400; i++) {
    const t = R.pick(SHIELD_IDS);
    out.add('is_shield_template', O(t), '=>', B(isShieldTemplate(t)));
  }
  for (let i = 0; i < 2400; i++) {
    const isClass = R.chance(0.5);
    const armor = R.pick([0, 100, 60, 25, 5, 30.5, 1000, -10, NaN, 300]);
    const pieces = Array.from({ length: R.int(0, 4) }, () => ({
      piece: R.pick([...GEAR_TEMPLATES, 113, 500, undefined]),
      material: R.pick([undefined, ...GEAR_MATERIALS, 3]),
      ...(R.chance(0.25) ? { shield: true } : {}),
    }));
    out.add('enemy_armor_values', B(isClass), F(armor), I(pieces.length), ...pieces.flatMap((p) => [O(p.piece), O(p.material), B(!!p.shield)]), '=>', ...enemyArmorValues({ isClass, armor }, pieces).map((v) => F(v)));
  }

  const perKind = {};
  for (const line of out.lines) {
    const k = line.split(' ', 1)[0];
    if (k !== 'tgt' && k !== 'atk') perKind[k] = (perKind[k] ?? 0) + 1;
  }
  console.log(`target: ${zoo.length} targets (${monsters} monster rows, ${classes} class rows, ${skipped} mobiles refused by the builder), ${attackers.length} attackers`);
  for (const [k, n] of Object.entries(perKind)) console.log(`target:   ${k}: ${n} cases`);
  return out.write();
}

counts.round = genRound();
counts.rng = genRng();
counts.damage = genDamage();
counts.allowance = genAllowance();
counts.relay_claim = genRelay();
counts.swing = genSwing();
counts.target = genTarget();
for (const [k, v] of Object.entries(counts)) console.log(`${k}: ${v} lines -> ${join('rust', 'tests', 'vectors', `${k}.txt`)}`);
