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
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bootOfCode, canonOf, DESCS } from './rust-data.mjs';

import { createRng, _initialStateForTests } from '../src/rng.js';
import {
  allowanceLaw, allowanceSpec, BREACH_PHASES, claimStreams, refOf, runAllowance, simulateAllowance, steadyState,
} from '../src/allowance.js';
import { createRelayClaimEngine } from '../src/relayClaim.js';
import {
  conditionMultiplier, damageModifier, pcaaoDamageModifier, SKILLS, swingFrameSeconds, swingHandling, swingHeft, unityRound,
  analyze,
} from '../src/model.js';
import { SWING_HANDLING, WEAPONS } from '../src/data.js';
import {
  armourConditionMultiplier, armourMaterialId, armourPiece, armourReduction, bodyPartWeights, careerTolerance,
  elementShare, enemyTarget, enemyTypeBonusRange, enemyTypeBonusValue, enemyTypeBonusValues, enemyTypeGroup,
  equipArmour, hasWornEquipment, intrinsicDamage, isSkeletalTarget, leftHandShield, makeTarget, monsterHideDamage,
  naturalDamageResistance, shieldBeatsUnderArmour, shieldBlockChance, shieldReduction, silverApplies,
  skeletalSilverDamage, standInTarget, struckSlotItem, targetExpectedDamage, targetPartDamage, targetPartOutcomes,
  enemyRowOf, careerIndexOf, isClassEnemyOf, materialRequirementMultiplier, mintRow, targetGroupOf,
} from '../src/target.js';
import { assignEnemyEquipment } from '../vendor/upstream/a3eb1605/src/combat/enemyEquipment.js';
import { createDexEquipmentAssigner } from '../vendor/upstream/a3eb1605/src/systems/enemyExpansion/dexEquipment.js';
import { dexRead } from '../vendor/upstream/a3eb1605/src/systems/enemyExpansion/dexInstall.js';
import { ENEMY_BASICS } from '../vendor/upstream/a3eb1605/src/characters/enemy/enemyBasics.js';
import { rollEnemyWeaponPoison } from '../vendor/upstream/a3eb1605/src/systems/poisons.js';
import { liveStat } from '../src/save.js';
import { careerAttackModifier, silverDoubles } from '../vendor/upstream/a3eb1605/src/combat/formulas.js';
import { enemyEntityGroup } from '../vendor/upstream/a3eb1605/src/combat/enemyGroups.js';
import { enemyArmorValues } from '../vendor/upstream/a3eb1605/src/combat/enemyEquipment.js';
import { isShieldTemplate, itemArmorValue, materialArmorValue } from '../vendor/upstream/a3eb1605/src/systems/armorMaterials.js';
import { armorBodyParts, slotForBodyPart } from '../vendor/upstream/a3eb1605/src/systems/equip.js';
import { conditionPercentage } from '../vendor/upstream/a3eb1605/src/systems/item/itemTemplates.js';
import { enemyCareerIndex, enemyEntityType } from '../vendor/upstream/a3eb1605/src/characters/enemy/enemyBasics.js';
// R4a: the value codec (tools/rust-codec.mjs, re-exported below), the save helpers, the gear and socket readers, the
// lootRarity readers and foeGroup
import { encodeValue, numToken } from './rust-codec.mjs';
import {
  effectiveSkill, masterCappedSkill, masterSkillsActive, PROFICIENCY_FLAG, rebuildEnchantMods, rebuildMods,
  characterLabel, characterFromSave, skillModOf, skillName, skillValue, WEAPON_SKILL,
} from '../src/save.js';
import {
  bladeLines, foldLines, laidLines, readItemLines, socketsFor, validItemLines, weaponDamagePct,
} from '../src/gearLines.js';
import { perfectGem, perfectSockets, socketAffixes, socketCount } from '../src/sockets.js';
import {
  allLegendaries, AFFIX_KINDS, AFFIX_RANGES, countedPieces, gemLine, LEGENDARY_POWERS, powerIdsOf, powerOf, readLines,
  socketGems, socketMax, socketsOf, validAffix,
} from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { foeGroup } from '../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';
import { ALL_GEM_IDS } from '../vendor/upstream/a3eb1605/src/systems/loot/gemGrades.js';
import { theoryCharacter } from '../src/theory.js';
import { genBlowFamilies } from './rust-blow-vectors.mjs';
import { genSpellFamilies } from './rust-spell-vectors.mjs';
import { genAnalysisFamilies } from './rust-analysis-vectors.mjs';
import { genFightFamilies } from './rust-fight-vectors.mjs';
import { genPlanningFamilies } from './rust-planning-vectors.mjs';
import { genFirmamentFamilies } from './rust-firmament-vectors.mjs';
import { genPlannerFamilies } from './rust-planner-vectors.mjs';
import { genForgeFamilies } from './rust-forge-vectors.mjs';
import { genForgeGearFamilies } from './rust-forge-gear-vectors.mjs';

export { encodeValue };

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
  constructor(module, note, streaming = false) {
    this.module = module;
    this.lines = [];
    this.note = note;
    this.path = join(outDir, `${module}.txt`);
    if (streaming) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(this.path, `${this.header().join('\n')}\n`);
      this.count = 0;
    }
  }
  add(...tokens) {
    const line = tokens.join(' ');
    if (this.count === undefined) this.lines.push(line);
    else {
      appendFileSync(this.path, `${line}\n`);
      this.count++;
    }
  }
  header() {
    return [
      `# dfo-core golden vectors | generator: tools/rust-vectors.mjs | module: ${this.module} | format: v1`,
      `# ${this.note}`,
      '# tokens: f64 = 16 hex digits of IEEE bits; int = decimal; u32 = 8 hex; bool = 1/0; opt = - or f64; name = n:<4 hex per UTF-16 unit>',
    ];
  }
  write() {
    if (this.count !== undefined) return this.count;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(this.path, `${[...this.header(), ...this.lines].join('\n')}\n`);
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
    out.add('math_round', F(x), F(Math.round(x)));
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

// ---------------------------------------------------------------------------------------------------------------
// maketarget (R3b): the target builders, gearEnemy, and the enemy equipment, through the REAL JS. Every random input
// is a roll the JS draws from a scripted sequence; the values it consumed are written (as f64 bits), so the Rust
// replays the same rolls and must consume exactly as many. Files: maketarget.txt. Kinds and grammars are in
// rust/README.md (R3b); the Rust reader is tests/maketarget.rs.
// ---------------------------------------------------------------------------------------------------------------
const MT_IDS = [...Array.from({ length: 43 }, (_, i) => i), ...Array.from({ length: 19 }, (_, i) => 128 + i)];
const MT_STATS = ['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck'];
const MT_FLAGS = ['resistanceFlags', 'immunityFlags', 'lowToleranceFlags', 'criticalWeaknessFlags', 'attackModifierFlags', 'weaponArmorShieldsBitfield'];
const MT_EFFECT_KINDS = ['disease', 'poison', 'artifact', 'racialOverride', 'fortifyAttribute', 'drainAttribute', 'transferAttribute', 'spellShield'];
const MT_SLOTS = [12, 13, 15, 18, 19, 20, 21, 23, 26];
const MT_MATERIALS = [0, 256, 259, 512, 513, 514, 515, 516, 517, 518, 519, 520, 521];
const OB = (b) => (b === null || b === undefined ? '-' : B(b));
const OS = (s) => (s === null || s === undefined ? '-' : N(s));
const MINT_DESC = DESCS.get('mint_rows:MINT_ROWS').of;
const ENEMY_DESC = DESCS.get('enemy_basics:ENEMY_BASICS').of;

/** The target's canonical tokens (the Rust `canon_target` writes the same, in the same order). */
function effTokens(a, o) {
  const k = a.kind;
  const tag = ['disease', 'poison', 'artifact'].includes(k) ? 'M' : k === 'racialOverride' ? 'R' : k === 'fortifyAttribute' ? 'F'
    : (k === 'drainAttribute' || k === 'transferAttribute') ? 'D' : 'X';
  o.push(tag, B(!!a.ended));
  if (tag === 'M' || tag === 'R') for (const s of MT_STATS) o.push(F(a.statMods?.[s] ?? 0));
  else if (tag === 'F' || tag === 'D') {
    const i = MT_STATS.indexOf(a.stat);
    o.push(i < 0 ? '-' : I(i), F(a.magnitude ?? 0));
  }
}
function canonTarget(t) {
  const o = [B(!!t.isPlayer), OB(t.isClass), O(t.careerIndex)];
  if (t.career === null || t.career === undefined) o.push('-');
  else {
    for (const k of MT_FLAGS) o.push(O(t.career[k]));
    for (const k of MT_STATS) o.push(O(t.career[k]));
  }
  o.push(O(t.level), O(t.combatLevel), O(t.mobileType), OS(t.affinity), OS(t.group));
  for (const k of MT_STATS) o.push(F(t.stats?.[k] ?? NaN));
  const sk = Object.keys(t.skills ?? {}).map(Number).sort((a, b) => a - b);
  o.push(I(sk.length));
  for (const id of sk) o.push(I(id), F(t.skills[id]));
  o.push(I(t.armorValues.length));
  for (const v of t.armorValues) o.push(F(v));
  const slots = t.equip?.slots ?? {};
  const keys = Object.keys(slots).map(Number).filter((s) => slots[s]).sort((a, b) => a - b);
  o.push(I(keys.length));
  for (const s of keys) {
    const it = slots[s];
    o.push(F(s), B(it.group === 'Armor'), O(it.templateIndex), O(it.material), B(!!it.artifact), O(it.maxCondition), O(it.currentCondition));
  }
  o.push(O(t.minMetalToHit), B(!!t.spareGear), F(t.health), F(t.maxHealth), OB(t.relayBody), OS(t.levelSource));
  const effs = t.activeEffects ?? [];
  o.push(I(effs.length));
  for (const a of effs) effTokens(a, o);
  for (const s of MT_STATS) o.push(F(t._mods?.stats?.[s] ?? 0));
  for (const s of MT_STATS) o.push(F(t._mods?.statMax?.[s] ?? 0));
  if (t.basics === null || t.basics === undefined) o.push('-');
  else o.push(...canonOf(MINT_DESC, t.basics, []));
  return o.join(',');
}
const rowCanon = (row) => (row === null || row === undefined ? '-' : canonOf(MINT_DESC, row, []).join(';'));
const enemyRowCanon = (row) => (row === null || row === undefined ? '-' : canonOf(ENEMY_DESC, row, []).join(';'));

/** A roll script: values from a local PRNG, with the 0 and the largest double below 1 as edges. */
function rollScript(R, n = 512) {
  const script = Array.from({ length: n }, () => (R.chance(1 / 16) ? (R.chance(0.5) ? 0 : 1 - 2 ** -53) : R.unit()));
  let i = 0;
  const used = [];
  return {
    rolls: () => {
      if (i >= script.length) throw new Error('maketarget: the roll script ran out');
      const v = script[i++];
      used.push(v);
      return v;
    },
    used: () => used,
  };
}
/** The ROLLS block: `-` for no roll function, else the count and the consumed values. */
const rollsTokens = (used) => (used === null ? ['-'] : [I(used.length), ...used.map(F)]);

/** The target module as gearEnemy reads it under one boot: a copy of src/target.js whose UPSTREAM_BOOT is the boot
 *  (the only ambient input gearEnemy has, target.js:562 and :539). Every import is rewritten to an absolute URL, so the
 *  copy shares every vendored module instance with this generator. The copy is written to the OS temp directory. */
async function targetUnderBoot(code) {
  const srcDir = join(here, '..', 'src');
  const b = bootOfCode(code);
  let text = readFileSync(join(srcDir, 'target.js'), 'utf8');
  text = text.replace(/from '(\.\.?\/[^']+)'/g, (_, p) => `from '${pathToFileURL(resolve(srcDir, p)).href}'`);
  const head = 'export const UPSTREAM_BOOT = Object.freeze({';
  const at = text.indexOf(head);
  if (at < 0 || text.indexOf(head, at + 1) >= 0) throw new Error('maketarget: target.js must hold one UPSTREAM_BOOT');
  const end = text.indexOf('});', at) + 3;
  const boot = `export const UPSTREAM_BOOT = Object.freeze({ pcaao: ${b.pcaao}, meanerMonsters: ${b.meanerMonsters}, enemyExpansion: ${b.enemyExpansion} });`;
  text = text.slice(0, at) + boot + text.slice(end);
  const file = join(tmpdir(), `dfo-target-boot-${code}-${process.pid}.mjs`);
  writeFileSync(file, text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(file, { force: true });
  }
}
const MT_CODES_ALL = [0, 1, 2, 3, 4, 5, 6, 7];

/** A career object: its flag bytes and stats, each present or absent. */
function randomCareer(R) {
  const c = {};
  for (const k of MT_FLAGS) if (R.chance(0.7)) c[k] = R.int(0, 127);
  for (const k of MT_STATS) if (R.chance(0.85)) c[k] = R.chance(0.1) ? R.range(0, 100) : R.int(0, 100);
  return c;
}
/** The CAREER input tokens: `-` for none, else `c` and 14 opts (6 flag bytes, 8 stats). */
const careerTokens = (c) => (c === null || c === undefined ? ['-'] : ['c', ...MT_FLAGS.map((k) => O(c[k])), ...MT_STATS.map((k) => O(c[k]))]);

/** A synthetic makeTarget's fields: each present or absent, the JS object holds only the present keys. */
function synthMake(R) {
  const f = {};
  if (R.chance(0.3)) f.isPlayer = R.chance(0.5);
  if (R.chance(0.5)) f.isClass = R.chance(0.5);
  if (R.chance(0.6)) f.level = R.int(1, 45);
  if (R.chance(0.3)) f.combatLevel = R.int(1, 45);
  if (R.chance(0.5)) f.mobileType = R.pick(MT_IDS);
  if (R.chance(0.5)) f.careerIndex = R.int(-1, 40);
  if (R.chance(0.4)) f.career = randomCareer(R);
  if (R.chance(0.4)) f.affinity = R.pick(['Human', 'Animal', 'Undead', 'Daedra', 'Daylight', 'Darkness']);
  if (R.chance(0.4)) f.group = R.pick(['humanoid', 'undead', 'daedra', 'animal']);
  if (R.chance(0.3)) f.stats = Object.fromEntries(MT_STATS.filter(() => R.chance(0.9)).map((k) => [k, R.chance(0.1) ? R.range(-5, 120) : R.int(0, 120)]));
  if (R.chance(0.3)) f.skills = Object.fromEntries(Array.from({ length: R.int(0, 6) }, () => [R.int(0, 34), R.int(0, 100)]));
  if (R.chance(0.3)) f.armorValues = Array.from({ length: 7 }, () => (R.chance(0.2) ? R.range(-50, 100) : R.int(-50, 100)));
  if (R.chance(0.4)) {
    const slots = {};
    for (const s of MT_SLOTS) if (R.chance(0.3)) slots[s] = { group: R.chance(0.8) ? 'Armor' : 'Weapons', templateIndex: R.pick([102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112]), material: R.pick(MT_MATERIALS), artifact: R.chance(0.1), maxCondition: R.int(0, 400), currentCondition: R.int(0, 400) };
    f.equip = { slots };
  }
  if (R.chance(0.2)) f.minMetalToHit = R.chance(0.2) ? undefined : R.int(-1, 6);
  if (R.chance(0.3)) f.spareGear = R.chance(0.5);
  if (R.chance(0.3)) f.health = R.int(1, 500);
  if (R.chance(0.3)) f.maxHealth = R.int(1, 500);
  if (R.chance(0.3)) {
    f.activeEffects = Array.from({ length: R.int(0, 3) }, () => {
      const kind = R.pick(MT_EFFECT_KINDS);
      const a = { kind, ended: R.chance(0.2) };
      if (['disease', 'poison', 'artifact', 'racialOverride'].includes(kind)) a.statMods = Object.fromEntries(MT_STATS.map((k) => [k, R.int(-20, 20)]));
      else if (kind === 'fortifyAttribute' || kind === 'drainAttribute' || kind === 'transferAttribute') {
        if (R.chance(0.8)) a.stat = R.pick(MT_STATS);
        a.magnitude = R.int(0, 30);
      }
      return a;
    });
  }
  if (R.chance(0.2)) f._mods = { stats: Object.fromEntries(MT_STATS.map((k) => [k, R.int(-10, 10)])), statMax: Object.fromEntries(MT_STATS.map((k) => [k, R.int(0, 20)])) };
  if (R.chance(0.3)) {
    const id = R.pick(MT_IDS);
    const code = R.int(0, 7);
    f.basics = mintRow(id, { boot: bootOfCode(code) }) ?? undefined;
    f.__basicsId = [id, code];
  }
  if (R.chance(0.2)) f.relayBody = true;
  if (R.chance(0.2)) f.levelSource = R.pick(['player', 'override', 'mint']);
  return f;
}
/** The make input tokens (the Rust reader is `read_make_fields`). */
function makeTokens(f) {
  const t = [OB(f.isPlayer), OB(f.isClass), O(f.level), O(f.combatLevel), O(f.mobileType), O(f.careerIndex)];
  t.push(...careerTokens(f.career ?? null));
  t.push(OS(f.affinity), OS(f.group));
  if (f.stats === undefined) t.push('-');
  else t.push('s', ...MT_STATS.map((k) => O(f.stats[k])));
  if (f.skills === undefined) t.push('-');
  else {
    const ks = Object.keys(f.skills).map(Number).sort((a, b) => a - b);
    t.push('k', I(ks.length));
    for (const k of ks) t.push(I(k), F(f.skills[k]));
  }
  if (f.armorValues === undefined) t.push('-');
  else t.push('a', I(f.armorValues.length), ...f.armorValues.map((v) => F(v)));
  if (f.equip === undefined) t.push('-');
  else {
    const ks = Object.keys(f.equip.slots).map(Number).sort((a, b) => a - b);
    t.push('e', I(ks.length));
    for (const s of ks) {
      const it = f.equip.slots[s];
      t.push(F(s), B(it.group === 'Armor'), O(it.templateIndex), O(it.material), B(!!it.artifact), O(it.maxCondition), O(it.currentCondition));
    }
  }
  if (!('minMetalToHit' in f)) t.push('-');
  else if (f.minMetalToHit === undefined) t.push('u');
  else t.push(F(f.minMetalToHit));
  t.push(OB(f.spareGear), O(f.health), O(f.maxHealth));
  if (f.activeEffects === undefined) t.push('-');
  else {
    t.push('v', I(f.activeEffects.length));
    for (const a of f.activeEffects) {
      t.push(a.kind, B(!!a.ended));
      if (['disease', 'poison', 'artifact', 'racialOverride'].includes(a.kind)) t.push(...MT_STATS.map((k) => F(a.statMods[k])));
      else if (a.kind !== 'spellShield') t.push(OS(a.stat), F(a.magnitude));
    }
  }
  if (f._mods === undefined) t.push('-');
  else t.push('m', ...MT_STATS.map((k) => F(f._mods.stats[k])), ...MT_STATS.map((k) => F(f._mods.statMax[k])));
  if (f.__basicsId === undefined) t.push('-');
  else t.push('b', I(f.__basicsId[0]), I(f.__basicsId[1]));
  t.push(OB(f.relayBody), OS(f.levelSource));
  return t;
}
/** The JS object for a make input: the basics key is the minted row (or absent), `__basicsId` is generator-only. */
function makeFields(f) {
  const { __basicsId, ...rest } = f;
  return rest;
}

const ENEMY_SPECS = [
  {}, { level: 1 }, { playerLevel: 9 }, { level: 21 }, { playerLevel: 37, exactLevel: true }, { level: 45 },
  { level: 0 }, { playerLevel: 1.5 },
];

/** A RangeError is the JS refusing a build (target.js:651-690); any other throw is a bug and is not swallowed. */
const refused = (e) => {
  if (!(e instanceof RangeError)) throw e;
  return null;
};

// ---- boundary probes (R3b, second pass) ------------------------------------------------------------------------
// Every threshold the arms test a roll against is probed at its bucket edges. A roll r decides `floor(r * N) < T` (a
// dice100 chance, T = chance, N = 100) or `lo + floor(r * (hi + 1 - lo))` (a range); its flip points are the bucket
// starts b(k) = least r with floor(r * N) >= k, and the doubles just below b(k) and just above it. For each threshold
// T the set covers b(T-1), b(T), b(T+1), their predecessors and successors. See rust/README.md (R3b, boundary probes).
const nextUp = (x) => (x === 0 ? 5e-324 : step(x, 1));
const prevDownOf = (x) => step(x, -1);
/** The least double r with Math.floor(r * N) >= k (a bucket start of floor(r * N)). */
function bucketStart(k, N) {
  if (k <= 0) return 0;
  let r = k / N;
  while (Math.floor(r * N) < k) r = nextUp(r);
  while (Math.floor(prevDownOf(r) * N) >= k) r = prevDownOf(r);
  return r;
}
/** The thresholds (percent) the arms test a roll against, and the armour thresholds of the class arm (+-10 steps). */
const BOUND_T100 = [0, 5, 10, 20, 30, 35, 40, 50, 60, 65, 70, 75, 80, 90];
/** The bucket starts of floor(r * 256) where a material ladder step lands (the partial sums of MATERIALS_BY_MODIFIER). */
const MAT_K256 = [0, 1, 63, 64, 65, 127, 128, 191, 192, 193, 201, 202, 203, 222, 223, 235, 236, 243, 244, 248, 249, 251, 252, 253, 254, 255];
/** Constant roll values (each applied to every roll of a case): the bucket starts and their predecessors for the range
 *  widths the arms draw (N = 2..8 and 13), the percent thresholds (+-1, plus the successor of each start), and the material
 *  edges. Plus 0 and the largest double below 1. */
function boundaryValues() {
  const s = new Set([0, 1 - 2 ** -53]);
  const edges = (k, N) => {
    if (k < 0 || k >= N) return;
    const r = bucketStart(k, N);
    s.add(r);
    if (r > 0) s.add(prevDownOf(r));
  };
  for (const N of [2, 3, 4, 5, 6, 7, 8, 13]) for (let k = 0; k < N; k++) edges(k, N);
  for (const T of BOUND_T100) {
    for (const k of [T - 1, T, T + 1]) {
      edges(k, 100);
      if (k >= 0 && k < 100) s.add(nextUp(bucketStart(k, 100)));
    }
  }
  for (const k of MAT_K256) edges(k, 256);
  return [...s];
}
/** The single-roll overwrites of an index probe: the percent edges and the predecessor of each threshold's start. */
function indexValues() {
  const s = new Set();
  for (const T of BOUND_T100) {
    for (const k of [T - 1, T, T + 1]) if (k >= 0 && k < 100) s.add(bucketStart(k, 100));
    if (T > 0) s.add(prevDownOf(bucketStart(T, 100)));
  }
  return [...s];
}
/** The f64 of a 16-hex-digit token (the inverse of F). */
const fromF = (h) => {
  dv.setBigUint64(0, BigInt(`0x${h}`));
  return dv.getFloat64(0);
};
/** Predicates over a GEAR_OUT token list, for the branches a constant fill cannot reach (a background sequence is
 *  searched so the branch is taken; the index probes then overwrite a roll of that branch). */
const isWeaponTpl = (t) => (t >= 113 && t <= 130) || t === 513 || t === 514;
/** The secondary weapon in the left hand (classic: rollEnemyEquipment's second `dice100`, enemyEquipment.js:253-257). */
const wantLeftWeapon = (tk) => {
  const rl = tk[0] === '-' ? 1 : 3;
  return tk[rl] === 'W' && isWeaponTpl(fromF(tk[rl + 1]));
};
/** The Dai-Katana in the right hand (EnemyEntity's big weapon, rriEnemyEquipment.js:88-89: a 90% re-roll follows it). */
const wantDaiKatana = (tk) => tk[0] === 'W' && fromF(tk[1]) === 123;
const WANT = { left: wantLeftWeapon, dai: wantDaiKatana };
const hashText = (text) => [...text].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 0x811c9dc5);
/** The material of every hand and armour piece a GEAR_OUT token list carries (after any conversion). */
const materialsOf = (tk) => {
  const out = [];
  let i = 0;
  if (tk[i] === 'W') {
    out.push(fromF(tk[i + 2]));
    i += 3;
  } else i += 1;
  if (tk[i] === 'W') {
    out.push(fromF(tk[i + 2]));
    i += 3;
  } else if (tk[i] === 'S') i += 2;
  else i += 1;
  const n = Number(tk[i]);
  i += 1;
  for (let p = 0; p < n; p++) {
    out.push(fromF(tk[i + 1]));
    i += 3;
  }
  return out;
};
/** A Mithril or Adamantium material (5 or 6): converted by the Warlord's Mithril-or-better rule, not by the Ebony one. */
const wantIn56 = (tk) => materialsOf(tk).some((x) => (x & 0xff) === 5 || (x & 0xff) === 6);
/** A material at least `m`, and no Orcish one: the arm did not convert it, so the conversion at the 0.80 edge flips the
 *  answer (a converted piece is Orcish, 8, and a converting roll leaves no piece at least `m` unconverted). */
const wantFlip = (m) => (tk) => {
  const ms = materialsOf(tk).map((x) => x & 0xff);
  return ms.some((x) => x >= m) && !ms.includes(8);
};

/** Runs one case with `rolls`; a RangeError is the refusal (null), any other throw is a bug. */
const runRefusable = (run, rolls) => {
  try {
    return run(rolls);
  } catch (e) {
    return refused(e);
  }
};
/** A random sequence with its values replaced by the script: the consumed values are what the JS drew. */
function scriptRun(script, run) {
  let i = 0;
  const used = [];
  const rolls = () => {
    if (i >= script.length) throw new Error('maketarget: a probe script ran out');
    const v = script[i++];
    used.push(v);
    return v;
  };
  return { used, result: runRefusable(run, rolls) };
}
/** Every roll is `v`; `n` is how many the JS drew. */
function constRun(v, run) {
  let n = 0;
  const rolls = () => {
    n++;
    if (n > 100000) throw new Error('maketarget: a constant probe does not stop');
    return v;
  };
  const result = runRefusable(run, rolls);
  return { n, result };
}

async function genMaketarget() {
  const out = new Out('maketarget', 'families: mint (rows) | make (synthetic makeTarget) | enemy, stand (enemyTarget, standInTarget) | gear (gearEnemy) | scalar (materialRequirementMultiplier, targetGroupOf, enemyRowOf, careerIndexOf, isClassEnemyOf) | classic (assignEnemyEquipment) | rri (the Enemy Expansion delegate). Grammar: rust/README.md R3b');
  const R = makeLcg(0x3b01);
  const fam = {};
  const bump = (k) => { fam[k] = (fam[k] ?? 0) + 1; };
  // gearEnemy reads UPSTREAM_BOOT: one module copy per boot (see targetUnderBoot).
  const TARGET_UNDER = [];
  for (const code of MT_CODES_ALL) TARGET_UNDER[code] = await targetUnderBoot(code);

  // mint
  for (const code of MT_CODES_ALL) {
    for (let id = -10; id <= 300; id++) {
      const row = mintRow(id, { boot: bootOfCode(code) });
      out.add('mint', F(id), I(code), '=>', rowCanon(row));
      bump('mint');
    }
  }

  // make: synthetic fields through the real makeTarget
  for (let i = 0; i < 2400; i++) {
    const f = synthMake(R);
    const target = makeTarget(makeFields(f));
    out.add('make', ...makeTokens(f), '=>', canonTarget(target));
    bump('make');
  }

  // enemy and stand: enemyTarget / standInTarget per boot, mobile id and option set
  for (const code of MT_CODES_ALL) {
    for (const id of MT_IDS) {
      ENEMY_SPECS.forEach((spec, si) => {
        const career = (id + code + si) % 2 === 0 ? randomCareer(R) : null;
        const armorValues = si === 3 ? [60, 60, 60, 60, 60, 60, 60] : undefined;
        // Absent rolls (JS null) for a third of the cases: the City Watch knight then refuses unless exact.
        const withRolls = (id + code + si) % 3 !== 0;
        const rs = rollScript(R);
        let result = null;
        try {
          result = enemyTarget(id, {
            level: spec.level, playerLevel: spec.playerLevel, career: career ?? undefined, armorValues,
            health: si === 1 ? 50 : undefined, maxHealth: si === 2 ? 80 : undefined,
            rolls: withRolls ? rs.rolls : undefined, exactLevel: spec.exactLevel ?? false, boot: bootOfCode(code),
          });
        } catch (e) {
          result = refused(e);
        }
        const used = withRolls ? rollsTokens(rs.used()) : ['-'];
        out.add('enemy', F(id), I(code), O(spec.playerLevel), O(spec.level), ...careerTokens(career), ...(armorValues ? ['a', I(7), ...armorValues.map((v) => F(v))] : ['-']),
          O(si === 1 ? 50 : undefined), O(si === 2 ? 80 : undefined), B(spec.exactLevel ?? false), ...used,
          '=>', result ? canonTarget(result) : '!');
        bump('enemy');
      });
      {
        let result = null;
        try {
          result = standInTarget(id, { boot: bootOfCode(code) });
        } catch (e) {
          result = refused(e);
        }
        out.add('stand', F(id), I(code), '=>', result ? canonTarget(result) : '!');
        bump('enemy');
      }
    }
  }

  // gear: gearEnemy under each boot (the copy), two roll scripts per case
  for (const code of MT_CODES_ALL) {
    const T = TARGET_UNDER[code];
    for (const id of MT_IDS) {
      for (const L of [undefined, 9, 21, 37]) {
        for (const seed of [0, 1]) {
          const career = seed === 1 ? randomCareer(R) : null;
          const pl = seed === 0 ? undefined : L;
          let target = null;
          try {
            target = enemyTarget(id, { playerLevel: L, career: career ?? undefined, exactLevel: true, boot: bootOfCode(code) });
          } catch (e) {
            target = refused(e);
          }
          const rs = rollScript(R);
          if (target !== null) T.gearEnemy(target, { playerLevel: pl, rolls: rs.rolls });
          const used = target !== null ? rs.used() : [];
          out.add('gear', F(id), I(code), O(L), O(pl), ...careerTokens(career), ...rollsTokens(used), '=>', target !== null ? canonTarget(target) : '!');
          bump('gear');
        }
      }
    }
  }

  // scalar: the small target helpers
  for (let i = 0; i < 1200; i++) {
    const min = R.chance(0.2) ? undefined : R.pick([-1, 0, 1, 2, 3, 4, 5, 6, 2.5, NaN, 0.5]);
    const weaponNull = R.chance(0.2);
    const wmat = R.chance(0.2) ? undefined : R.pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 2.5]);
    const soft = R.chance(0.7);
    const target = min === undefined ? {} : { minMetalToHit: min };
    const weapon = weaponNull ? null : (wmat === undefined ? {} : { material: wmat });
    const r = materialRequirementMultiplier(target, weapon, { soft });
    out.add('mrm', O(min), weaponNull ? '-' : 'w', ...(weaponNull ? [] : [O(wmat)]), B(soft), '=>', F(r));
    bump('scalar');
  }
  for (let i = 0; i < 400; i++) {
    const careerIndex = R.chance(0.2) ? undefined : R.int(-1, 40);
    const affinity = R.chance(0.3) ? null : R.pick(['Human', 'Animal', 'Undead']);
    const isClass = R.chance(0.3);
    const args = { affinity, isClass };
    if (careerIndex !== undefined) args.careerIndex = careerIndex;
    const g = targetGroupOf(args);
    out.add('tgo', O(careerIndex), OS(affinity), B(isClass), '=>', OS(g));
    bump('scalar');
  }
  for (let i = 0; i < 200; i++) {
    const id = R.chance(0.7) ? R.pick(MT_IDS) : R.int(-5, 150);
    out.add('erow', F(id), '=>', enemyRowCanon(enemyRowOf(id)));
    bump('scalar');
  }
  for (let i = 0; i < 200; i++) {
    const id = R.chance(0.7) ? R.pick(MT_IDS) : R.int(-5, 200);
    out.add('cidx', F(id), '=>', F(careerIndexOf(id)));
    bump('scalar');
  }
  for (let i = 0; i < 200; i++) {
    const id = R.chance(0.7) ? R.pick(MT_IDS) : R.int(-5, 200);
    out.add('iscl', F(id), '=>', B(isClassEnemyOf(id)));
    bump('scalar');
  }

  // classic: assignEnemyEquipment, the classic loadout and its armour values
  for (let i = 0; i < 2400; i++) {
    const id = R.pick(MT_IDS);
    const isClass = id >= 128;
    const variant = R.pick([null, 0, 1, 2]);
    const armor = R.pick([0, 5, 30, 60, 100, -10]);
    const pl = R.int(1, 45);
    const rs = rollScript(R);
    const eq = assignEnemyEquipment({ mobileType: id, isClass, armor }, variant, pl, rs.rolls);
    out.add('classic', F(id), B(isClass), O(variant), F(armor), F(pl), ...rollsTokens(rs.used()), '=>', ...gearOutTokens(eq, null));
    bump('classic');
  }

  // rri: the Enemy Expansion delegate (the copy of RRI's arm), per mudex set
  const propsByMudex = new Map();
  for (const mudex of [false, true]) {
    const read = dexRead({ mudex, log: () => {} });
    propsByMudex.set(mudex, (id) => read.classic.get(Number(id))?.props ?? read.enemies.get(Number(id))?.props ?? null);
  }
  for (let i = 0; i < 2400; i++) {
    const id = R.pick(MT_IDS);
    const isClass = id >= 128;
    const variant = R.pick([null, 0, 1, 2]);
    const pl = R.int(1, 45);
    const level = R.chance(0.6) ? R.int(1, 45) : undefined;
    const armor = R.pick([0, 5, 30, 60, 100]);
    const mudex = R.chance(0.5);
    const team = R.pick(['Orcs', 'Centaurs', 'KnightsAndMages', 'Criminals', 'PlayerEnemy']);
    const bitfield = R.chance(0.5) ? R.int(0, 0xffff) : undefined;
    const career = bitfield === undefined ? null : { weaponArmorShieldsBitfield: bitfield };
    const assign = createDexEquipmentAssigner(propsByMudex.get(mudex));
    const entity = { mobileType: id, isClass, armor, career, basics: { team } };
    if (level !== undefined) entity.level = level;
    const rs = rollScript(R);
    const eq = assign(entity, variant, pl, { rolls: rs.rolls });
    if (eq === null) throw new Error('maketarget: the Enemy Expansion arm answered null with the switches at their defaults');
    out.add('rri', F(id), B(isClass), O(variant), F(pl), O(level), F(armor), B(mudex), OS(team), O(bitfield), ...rollsTokens(rs.used()), '=>', ...gearOutTokens(eq, eq.rightHand?.poisonType ?? null));
    bump('rri');
  }

  // ---- boundary probes: each base run with the constant fills, and (for `indexed` bases) with one roll overwritten ----
  const BOUND_VALUES = boundaryValues();
  const IDX_VALUES = indexValues();
  const emitProbe = (kind, inputs, rollTok, result) => {
    out.add(kind, ...inputs, ...rollTok, '=>', ...(result ?? ['!']));
    bump(kind);
  };
  const probeBase = (kind, inputs, run, indexed, want = null, all = false, attempts = 256) => {
    const backgroundOf = (attempt) => {
      const R2 = makeLcg(hashText(`${kind}|${inputs.join('|')}|${attempt}`));
      const s = Array.from({ length: 512 }, () => R2.unit());
      return { s, b: scriptRun(s, run) };
    };
    // The background: the first seed whose run takes the wanted branch (attempt 0 when nothing is wanted).
    let chosen = null;
    for (let attempt = 0; attempt < attempts && chosen === null; attempt++) {
      const c = backgroundOf(attempt);
      if (want === null || (c.b.result !== null && want(c.b.result))) chosen = c;
      if (want === null) break;
    }
    if (chosen === null) {
      console.warn(`maketarget: no background of ${kind} ${inputs.join(' ')} takes the wanted branch in ${attempts} seeds`);
      chosen = backgroundOf(0);
    }
    const { s: script, b: base } = chosen;
    for (const v of BOUND_VALUES) {
      const c = constRun(v, run);
      emitProbe(kind, inputs, ['K', F(v), I(c.n)], c.result);
    }
    if (indexed) {
      // `all` covers every decision of the base; otherwise the first 8.
      const span = all ? base.used.length : Math.min(base.used.length, 8);
      for (let k = 0; k < span; k++) {
        for (const v of IDX_VALUES) {
          const s = script.slice();
          s[k] = v;
          const r = scriptRun(s, run);
          emitProbe(kind, inputs, [I(r.used.length), ...r.used.map((x) => F(x))], r.result);
        }
      }
    }
    return { script, base };
  };

  // bclassic: assignEnemyEquipment (the classic loadout). Variants null/0/1/2, the city watch (146), a class, a monster.
  const CLASSIC_BOUND = [
    { id: 0, isClass: false, variant: null, pl: 1, indexed: true },
    { id: 0, isClass: false, variant: 0, pl: 1, indexed: true, want: 'left' },
    { id: 0, isClass: false, variant: 0, pl: 9 },
    { id: 0, isClass: false, variant: 0, pl: 10 },
    { id: 0, isClass: false, variant: 1, pl: 45, indexed: true },
    { id: 0, isClass: false, variant: 2, pl: 11 },
    { id: 141, isClass: true, variant: 0, pl: 9, indexed: true, want: 'left' },
    { id: 146, isClass: true, variant: 0, pl: 9 },
    { id: 146, isClass: true, variant: 1, pl: 45 },
    { id: 135, isClass: true, variant: 0, pl: 2 },
    { id: 128, isClass: true, variant: 2, pl: 10 },
    { id: 143, isClass: true, variant: null, pl: 1 },
  ];
  for (const b of CLASSIC_BOUND) {
    probeBase('bclassic', [F(b.id), B(b.isClass), O(b.variant), F(60), F(b.pl)],
      (rolls) => gearOutTokens(assignEnemyEquipment({ mobileType: b.id, isClass: b.isClass, armor: 60 }, b.variant, b.pl, rolls), null),
      b.indexed === true, WANT[b.want] ?? null);
  }

  // brri: the Enemy Expansion delegate's arm. Every class (a variant-0 base, and a bitfield that forbids plate or not),
  // the combat classes' second variant, the orcs and centaurs with their variants (Orcs convert), and a monster with none.
  const RRI_BOUND = [];
  for (let id = 128; id <= 146; id++) {
    // The combat classes at variant 0 take the secondary weapon (a left-hand weapon) when the second 50% test passes.
    const combat = [136, 140, 145].includes(id);
    RRI_BOUND.push({ id, isClass: true, variant: 0, pl: 9, mudex: id % 2 === 1, bitfield: id % 2 === 0 ? 0 : 256, team: 'PlayerEnemy', indexed: combat, want: combat ? 'left' : null });
  }
  for (const id of [143, 144, 145, 146, 140, 136, 135]) {
    // The Barbarian's variant-1 big weapon is the Dai-Katana often enough to take its 90% re-roll.
    RRI_BOUND.push({ id, isClass: true, variant: 1, pl: 37, mudex: true, bitfield: 448, team: 'PlayerEnemy', indexed: id === 143, want: id === 143 ? 'dai' : null });
  }
  for (const [id, variant, team] of [[7, 0, 'Orcs'], [21, 0, 'Orcs'], [8, 1, 'Centaurs'], [12, 1, 'Orcs'], [24, 2, 'Orcs']]) {
    RRI_BOUND.push({ id, isClass: false, variant, pl: 9, mudex: false, bitfield: 0, team });
  }
  RRI_BOUND.push({ id: 0, isClass: false, variant: null, pl: 9, mudex: false, bitfield: 0, team: 'Criminals' });
  for (const b of RRI_BOUND) {
    probeBase('brri', [F(b.id), B(b.isClass), O(b.variant), F(b.pl), '-', F(60), B(b.mudex), OS(b.team), O(b.bitfield)],
      (rolls) => {
        const assign = createDexEquipmentAssigner(propsByMudex.get(b.mudex));
        const eq = assign({ mobileType: b.id, isClass: b.isClass, armor: 60, career: { weaponArmorShieldsBitfield: b.bitfield }, basics: { team: b.team } }, b.variant, b.pl, { rolls });
        return gearOutTokens(eq, eq.rightHand?.poisonType ?? null);
      },
      b.indexed === true, WANT[b.want] ?? null);
  }

  // borcish: the Orcish conversion (rriEnemyEquipment.js:434-466) over the four Orcs-team types (enemyBasics.js: 7 orc,
  // 12 orc sergeant, 21 orc shaman, 24 orc warlord). An Ebony-and-up material (a Warlord's Mithril-and-up) is Orcish 80%
  // of the time. The 80% roll is the LAST roll the arm draws: the poison (:253) and every equipment roll come first, and
  // convertOrcish (:255) draws only for an Orcs-team foe. So the last consumed value is the conversion roll, and
  // checkConversionRoll asserts it. Reach (enemyEquipment.js:99-112): the combined value is (level - 10) x 4 below level
  // 10, (level - 10) x 2 from 10, plus floor(roll x 256), clamped to 0..256. Ebony needs 250 or more and Mithril 237 or
  // more, so Ebony is reached from level 9 and Mithril from level 6; levels 8 and 5 cannot reach them.
  const ORC_BASES = [
    { id: 7, variant: 0, threshold: 7, levels: [1, 8, 9, 10, 45] },
    { id: 21, variant: 0, threshold: 7, levels: [1, 8, 9, 10, 45] },
    { id: 12, variant: 1, threshold: 7, levels: [1, 8, 9, 10, 45] },
    { id: 24, variant: 2, threshold: 5, levels: [1, 5, 6, 9, 45] },
  ];
  const orcInputs = (b, pl) => [F(b.id), B(false), O(b.variant), F(pl), '-', F(60), B(false), OS('Orcs'), O(0)];
  const orcRun = (b, pl) => (rolls) => {
    const assign = createDexEquipmentAssigner(propsByMudex.get(false));
    const eq = assign({ mobileType: b.id, isClass: false, armor: 60, career: { weaponArmorShieldsBitfield: 0 }, basics: { team: 'Orcs' } }, b.variant, pl, { rolls });
    return gearOutTokens(eq, eq.rightHand?.poisonType ?? null);
  };
  /** The sequence with its last roll (the conversion roll) replaced by `v`. */
  const lastRollAt = (script, base, run, v) => {
    const s = script.slice();
    s[base.used.length - 1] = v;
    return scriptRun(s, run);
  };
  /** The conversion roll is the last value drawn: overwritten at the 0.80 edges it keeps the consumed count, and the edge
   *  below (0.79, which passes the 80% test) converts where the edge at 0.80 (which fails it) does not. */
  const checkConversionRoll = (script, base, run, id, pl) => {
    const pass = lastRollAt(script, base, run, prevDownOf(bucketStart(80, 100)));
    const fail = lastRollAt(script, base, run, bucketStart(80, 100));
    if (pass.used.length !== base.used.length || fail.used.length !== base.used.length) {
      throw new Error(`maketarget: borcish ${id} at level ${pl}: the last roll changes the consumed count`);
    }
    if (JSON.stringify(pass.result) === JSON.stringify(fail.result)) {
      throw new Error(`maketarget: borcish ${id} at level ${pl}: the last roll is not the conversion roll`);
    }
  };
  for (const b of ORC_BASES) {
    for (const pl of b.levels) {
      const inputs = orcInputs(b, pl);
      const run = orcRun(b, pl);
      // Each call also emits the constant fills (every roll the same edge value), once per level.
      if (pl === 9) {
        // Every decision index, over a background whose material is Ebony (Mithril for the Warlord) and not converted.
        // About 1 seed in 100 has an Ebony roll at level 9 that the 80% test leaves unconverted, hence 4096 seeds.
        const { script, base } = probeBase('borcish', inputs, run, true, wantFlip(b.threshold), true, 4096);
        checkConversionRoll(script, base, run, b.id, pl);
      } else if (pl === 45) {
        // The conversion roll alone, over a background holding a Mithril or Adamantium material: the Ebony rule leaves it
        // Mithril and the Warlord's Mithril rule converts it, so a swap of the two thresholds changes the answer.
        const { script, base } = probeBase('borcish', inputs, run, false, wantIn56);
        const last = base.used.length - 1;
        for (const v of IDX_VALUES) {
          const s = script.slice();
          s[last] = v;
          const r = scriptRun(s, run);
          emitProbe('borcish', inputs, [I(r.used.length), ...r.used.map((x) => F(x))], r.result);
        }
      } else {
        probeBase('borcish', inputs, run, false);
      }
    }
  }

  // bgear: gearEnemy under a boot (the copy). Classes at the city watch's player level (code 7, and 5 with DEX on and
  // Meaner Monsters off), and the monsters whose career index a variant table names (and one it does not).
  const GEAR_BOUND = [];
  for (let id = 128; id <= 146; id++) GEAR_BOUND.push({ id, code: 7, L: 9, pl: undefined, indexed: id <= 131 });
  for (const id of [135, 139, 146, 141]) GEAR_BOUND.push({ id, code: 5, L: 37, pl: undefined });
  for (const id of [0, 6, 7, 8, 12, 21, 24]) GEAR_BOUND.push({ id, code: 7, L: undefined, pl: 9 });
  for (const b of GEAR_BOUND) {
    probeBase('bgear', [F(b.id), I(b.code), O(b.L), O(b.pl), '-'],
      (rolls) => {
        let target;
        try {
          target = enemyTarget(b.id, { playerLevel: b.L, exactLevel: true, boot: bootOfCode(b.code) });
        } catch (e) {
          return refused(e);
        }
        TARGET_UNDER[b.code].gearEnemy(target, { playerLevel: b.pl, rolls });
        return [canonTarget(target)];
      },
      b.indexed === true);
  }

  // benemy: the City Watch knight's roll (enemyEntity.js:207, `3 + floor(roll x 4)`), per player level and boot.
  for (const code of [0, 7]) {
    for (const pl of [1, 2, 9, 45]) {
      probeBase('benemy', [F(146), I(code), O(pl), '-', '-', '-', '-', '-', B(false)],
        (rolls) => {
          try {
            return [canonTarget(enemyTarget(146, { playerLevel: pl, exactLevel: false, rolls, boot: bootOfCode(code) }))];
          } catch (e) {
            return refused(e);
          }
        },
        false);
    }
  }

  // bpoison: rollEnemyWeaponPoison (systems/poisons.js:250): the level gate, the 5% (60% Assassin) chance, the type.
  // The type roll (`128 + floor(r x 8)`) is drawn only after the chance roll passes, so a constant fill can reach it only
  // with a chance value that passes too (none of the edge values do). So: constants at the level gate (1 and 9), and
  // PAIRS for player level 9: the chance roll 0 (passes both the 5 and the 60 percent tests), then each boundary value as
  // the type roll; and the index-0 probes of the chance roll itself.
  const POISON_MOBS = [0, 7, 8, 12, 21, 24, 135, 139, 146, 141];
  const poisonRun = (mob, pl) => (rolls) => [O(rollEnemyWeaponPoison(mob, pl, rolls))];
  for (const mob of POISON_MOBS) {
    for (const pl of [1, 9]) probeBase('bpoison', [F(mob), F(pl)], poisonRun(mob, pl), false);
    // Player level 2 (the gate is `<= 1`): the chance edges only, so a gate of 2 would change the answer.
    for (const v of [0, bucketStart(5, 100), prevDownOf(bucketStart(5, 100)), 1 - 2 ** -53]) {
      const c = constRun(v, poisonRun(mob, 2));
      emitProbe('bpoison', [F(mob), F(2)], ['K', F(v), I(c.n)], c.result);
    }
  }
  for (const mob of POISON_MOBS) {
    const inputs = [F(mob), F(9)];
    for (const v of BOUND_VALUES) {
      const rest = Array.from({ length: 510 }, () => R.unit());
      const r = scriptRun([0, v, ...rest], poisonRun(mob, 9));
      emitProbe('bpoison', inputs, [I(r.used.length), ...r.used.map((x) => F(x))], r.result);
    }
    for (const v of IDX_VALUES) {
      const rest = Array.from({ length: 510 }, () => R.unit());
      const r = scriptRun([v, ...rest], poisonRun(mob, 9));
      emitProbe('bpoison', inputs, [I(r.used.length), ...r.used.map((x) => F(x))], r.result);
    }
  }

  console.log(`maketarget: ${Object.entries(fam).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return out.write();
}

/** The GEAR_OUT tokens of an arm's answer: right, left, the armour pieces, the armour values, the poison. */
function gearOutTokens(eq, poison) {
  const t = [];
  if (eq.rightHand) t.push('W', F(eq.rightHand.templateIndex), F(eq.rightHand.material));
  else t.push('-');
  if (!eq.leftHand) t.push('-');
  else if (eq.leftHand.shield) t.push('S', F(eq.leftHand.templateIndex));
  else t.push('W', F(eq.leftHand.templateIndex), F(eq.leftHand.material));
  t.push(I(eq.armorPieces.length));
  for (const p of eq.armorPieces) t.push(F(p.piece), F(p.material), B(!!p.shield));
  for (const v of eq.armorValues) t.push(F(v));
  t.push(O(poison));
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// R4a: the value codec, the save helpers, the gearLines and sockets readers, the lootRarity readers and foeGroup.
// Inputs are DEFINITIONS (`def <index> <value>`, written once) that cases refer to as `@<index>`, so a character or an
// item list is written once and read by many cases. Each case's expected output is the JS value's encoding; the Rust
// compares the canonical write of its own value with that token. Every family has at least 2000 cases (the Rust test
// asserts it); the generator prints the counts.
// ---------------------------------------------------------------------------------------------------------------
const STAT_NAMES = ['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck'];
const NUM_POOL = [
  0, -0, 1, -1, 0.5, 1.5, 2.5, -2.5, 3, 7, 49.5, 50, 99, 100, 100.5, 101, 124.9, 125, 149, 150, 174, 175, 199, 200, 200.5,
  201, 255, 1e6, 1e21, 1e-7, 1e-6, 123456789012345680000, 0.1, 5e-324, Number.MAX_SAFE_INTEGER, 2 ** 53 + 2, NaN, Infinity,
  -Infinity, 1.7976931348623157e308, -3e-300,
  // the number-to-string windows (n = exponent + 1: fixed for 1..=21 and -5..=0, exponent form outside), both sides of each
  1e-5, 1.5e-5, 9.99e-7, 1.5e-6, -1.5e-6, 1.5e-7, 9.99e-7, 1e15, 1e16, 9.99e20, 1e20, 12345.678, 0.0001, 0.001,
  4294967294, 4294967295, 4294967296, 2.5e-300, 1e-300, 1e308, 0.30000000000000004,
  // the negatives of the exponent-window and range boundaries (the sign arm of number_to_string)
  -1e21, -1e-7, -123456789012345680000, -5e-324, -1.7976931348623157e308, -1e-6, -1e20, -0.1,
];
const STR_POOL = [
  '', 'a', '0', '5', ' 12 ', '0x1f', '-0x1f', '0b101', '0o17', '1e3', '.5', '5.', '+7', '-0', '1e', 'Infinity', '-Infinity',
  'infinity', '1_000', '  42  ', '﻿7', '\u0085 7', 'Hello', 'é', '漢字', '😀', '\u0000', ' ',
  'multi\nline', 'a;b:c,d[e]{f}', 'undefined', 'null', 'true', '1e400', '4.9e-324', '00012', '+.5', '-.5e-3', '1.e2',
  'e5', '0x',
  // radix forms past 2^53 (exact up to 128 bits in the port; rounding to nearest even): 120-bit hex, a tie, binary, octal
  '0x' + 'f'.repeat(30), '0x1' + '0'.repeat(15) + '1', '0b' + '1'.repeat(70), '0o' + '7'.repeat(40), '0X' + 'ab'.repeat(15),
  // zero in each radix (the empty mantissa), 64 bits exactly, 2^64, a tie at bit 11 of 65 bits and the same tie broken by
  // a sticky bit, a 54-bit tie in 64 bits, long forms past 128 and past 1024 bits (overflow to Infinity)
  '0x0', '0o0', '0b0', '0x00000000000000000000', '0x' + 'f'.repeat(16), '0x1' + '0'.repeat(16), '0x1' + '0'.repeat(13) + '800',
  '0x1' + '0'.repeat(13) + '801', '0x8000000000000400', '0x8000000000000401', '0x20000000000001', '0x20000000000003',
  '0b' + '1'.repeat(64), '0b' + '1'.repeat(65), '0b' + '10'.repeat(40), '0o' + '1' + '0'.repeat(21), '0o' + '7'.repeat(21),
  '0x' + 'f'.repeat(40), '0x' + 'f'.repeat(256), '0x' + 'f'.repeat(300),
  // uppercase radix prefixes and digits (each prefix is its own table row), mixed case digits
  '0O17', '0B101', '0X1F', '0x1F', '0XaB', '0Xab', '0O' + '7'.repeat(40), '0B' + '1'.repeat(70), '0X' + 'AB'.repeat(15),
  // decimal scanner: a '.' at either end, an exponent in either case and with each sign, and forms with no digits
  '+.5e1', '.5E1', '1.E2', '5E-1', '1E3', '1E+3', '1e+3', '5.', '.e3', 'E5', '5E', '+', '-', '.', '+.', '-.5', '5e-1',
];
const KEY_POOL = ['a', 'b', 'c', '0', '7', '10', '4294967294', '4294967295', 'name', 'ünï', 'x;y', '', 'Fire', '1.5', '-1', '01'];

function randomCodePoint(R) {
  const band = R.u32() % 5;
  if (band === 0) return R.int(0x20, 0x7e);
  if (band === 1) return R.int(0xa0, 0x2fff);
  if (band === 2) return R.int(0x3040, 0x9fff);
  if (band === 3) return R.int(0x10000, 0x1f9ff);
  return R.int(0, 0x1f);
}

function randomString(R) {
  let s = '';
  const n = R.int(0, 6);
  for (let i = 0; i < n; i++) s += String.fromCodePoint(randomCodePoint(R));
  return s;
}

/** A random JS value of the codec's kinds, nested up to `depth`. */
function genValue(R, depth) {
  const r = R.u32() % 100;
  if (depth <= 0 || r < 40) {
    switch (R.u32() % 6) {
      case 0: return undefined;
      case 1: return null;
      case 2: return R.chance(0.5);
      case 3: return R.chance(0.6) ? R.pick(NUM_POOL) : R.bits();
      case 4: return R.chance(0.6) ? R.pick(STR_POOL) : randomString(R);
      default: return R.pick(NUM_POOL);
    }
  }
  if (r < 65) {
    const n = R.int(0, 4);
    return Array.from({ length: n }, () => genValue(R, depth - 1));
  }
  const o = {};
  const n = R.int(0, 4);
  for (let i = 0; i < n; i++) o[R.pick(KEY_POOL)] = genValue(R, depth - 1);
  return o;
}

function genValueFamily() {
  const out = new Out(
    'value',
    'kinds: value <tok> (write(parse(tok)) = tok) | tonum <v> => <f64> (Number) | tostr <v> => <s> (String) | truthy <v> => <b> (!!) | prop <v> <k> => <tok> (v?.[k]); tokens: rust/README.md, R4a',
  );
  const R = makeLcg(0x7a1e01);
  const fam = {};
  const add = (kind, ...t) => {
    out.add(kind, ...t);
    fam[kind] = (fam[kind] ?? 0) + 1;
  };
  // A deterministic sweep: every pool entry and each special shape at the top level, through each read. The random draws
  // reach a top-level string or number only rarely, so a boundary of a pool (a radix prefix, an exponent window) would
  // otherwise go unprobed.
  const SWEEP = [
    ...NUM_POOL, ...STR_POOL, undefined, null, true, false, [], {}, ['5'], [null, undefined, 1], { a: 0 }, ['x', ' 7 '],
    [[' 0x1f ']], { 1: 'a', b: null },
  ];
  for (const v of SWEEP) {
    add('value', encodeValue(v));
    add('tonum', encodeValue(v), '=>', numToken(Number(v)));
    add('tostr', encodeValue(v), '=>', encodeValue(String(v)));
    add('truthy', encodeValue(v), '=>', v ? 'b1' : 'b0');
  }
  // Identity and comparison: `===` and SameValueZero (`[a].includes(b)`) over every pool entry paired with an equal copy
  // (a fresh copy of an object: JS identity is never shared with the encoded value) and with a different entry.
  const copyOf = (v) => (typeof v === 'object' && v !== null ? structuredClone(v) : v);
  const POOL = [...STR_POOL, ...NUM_POOL, undefined, null, true, false, [], {}, ['5'], { a: 1 }];
  for (let i = 0; i < POOL.length; i++) {
    const x = POOL[i];
    const y = POOL[(i + 1) % POOL.length];
    add('seq', encodeValue(x), encodeValue(copyOf(x)), '=>', encodeValue(x === copyOf(x)));
    add('seq', encodeValue(x), encodeValue(y), '=>', encodeValue(x === y));
    add('svz', encodeValue(x), encodeValue(copyOf(x)), '=>', encodeValue([x].includes(copyOf(x))));
    add('svz', encodeValue(x), encodeValue(y), '=>', encodeValue([x].includes(y)));
  }
  for (let i = 0; i < 2200; i++) {
    const x = genValue(R, 2);
    const y = R.chance(0.5) ? copyOf(x) : genValue(R, 2);
    add('seq', encodeValue(x), encodeValue(y), '=>', encodeValue(x === y));
    if (i < 1000) add('svz', encodeValue(x), encodeValue(y), '=>', encodeValue([x].includes(y)));
  }
  for (let i = 0; i < 3000; i++) add('value', encodeValue(genValue(R, 3)));
  for (let i = 0; i < 2500; i++) {
    const v = genValue(R, 3);
    add('tonum', encodeValue(v), '=>', numToken(Number(v)));
  }
  for (let i = 0; i < 2500; i++) {
    const v = genValue(R, 3);
    add('tostr', encodeValue(v), '=>', encodeValue(String(v)));
  }
  for (let i = 0; i < 2000; i++) {
    const v = genValue(R, 3);
    add('truthy', encodeValue(v), '=>', v ? 'b1' : 'b0');
  }
  // A read of one half of an astral character is a lone surrogate, which is not a value (the codec refuses it): such a
  // read is skipped, not written, so the count below is the number of cases the Rust side sees.
  for (let n = 0; n < 2500; ) {
    const v = genValue(R, 3);
    const k = R.chance(0.5) ? R.pick(KEY_POOL) : genValue(R, 1);
    let got;
    try {
      got = encodeValue(v?.[k]);
    } catch {
      continue;
    }
    add('prop', encodeValue(v), encodeValue(k), '=>', got);
    n++;
  }
  console.log(`value: ${Object.entries(fam).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return out.write();
}

// ---- items, affixes and characters: the inputs of the save, gear, sockets and loot families ----------------------
const ITEM_GROUPS = ['Weapons', 'Armor', 'Jewellery', 'MensClothing', 'WomensClothing', 'Gems', 'Clothing', 'Potions'];
const ITEM_TEMPLATES = [113, 114, 115, 118, 120, 124, 127, 129, 131, 560, 563, 102, 103, 109, 110, 111, 112, 513, 15, 1900, 1924, 7, 131];
const RARITIES = ['common', 'magic', 'rare', 'legendary', 'gilded', 'artifact', undefined, null];
const AFFIX_KIND_IDS = Object.keys(AFFIX_KINDS);
const LEGENDARY_IDS = allLegendaries().map((l) => l.id);
const LEGENDARY_FEW = LEGENDARY_IDS.slice(0, 6);

/** One affix record, valid or not: a kind, a param its kind may name (or not), and a value at the band's edges. */
function genAffix(R) {
  const id = R.pick(AFFIX_KIND_IDS);
  const k = AFFIX_KINDS[id];
  const range = AFFIX_RANGES[id];
  const max = range.legendary[1];
  const a = { id };
  if (Array.isArray(k.params)) {
    a.param = R.chance(0.93) ? R.pick(k.params) : R.pick([undefined, null, 'bogus', 999]);
  } else if (R.chance(0.1)) {
    a.param = R.pick([null, 'extra', 0]);
  }
  a.value = R.pick([
    1, 2, 3, max - 1, max, max + 1, 0, -1, 1.5, NaN, '5', undefined, Math.floor(max / 2), range.rare[1],
    range.rare[1] + 1, range.rare[1] - 1, range.magic[0], range.magic[1], range.legendary[0], 1e9,
  ]);
  return a;
}

/** A piece of equipment, shaped as the fields the readers read (any of them may be missing or odd). */
function genItem(R) {
  const it = {
    group: R.chance(0.95) ? R.pick(ITEM_GROUPS) : undefined,
    templateIndex: R.chance(0.9) ? R.pick(ITEM_TEMPLATES) : R.pick([undefined, null, 0, 7.5, '113']),
    material: R.pick([0, 9, 256, 512, 520, undefined]),
    rarity: R.pick(RARITIES),
    equipSlot: R.pick([19, 21, 12, 18, 26, null, undefined, -1, '19']),
    artifact: R.chance(0.1),
  };
  if (R.chance(0.1)) it.affixes = undefined;
  else if (R.chance(0.03)) it.affixes = null;
  else it.affixes = Array.from({ length: R.int(0, 5) }, () => (R.chance(0.03) ? null : genAffix(R)));
  if (R.chance(0.3)) it.legendary = R.pick(LEGENDARY_FEW);
  if (R.chance(0.3)) it.sockets = Array.from({ length: R.int(0, 3) }, () => R.pick(['empty', ...ALL_GEM_IDS, 'junk', null]));
  else if (R.chance(0.1)) it.socket = R.pick(['ruby', 'empty', 'bogus', 'perfect-amber']);
  if (R.chance(0.3)) it.imprint = R.pick(LEGENDARY_FEW);
  if (R.chance(0.5)) it.enchantments = Array.from({ length: R.int(0, 3) }, () => ({
    type: R.pick([10, 10, 3, 9]),
    param: R.pick([0, 5, 14, 34, 35, -1, 1.5, '7', NaN, undefined]),
  }));
  // A set gem's own line (gemLine is the JS's), sometimes with a value past its cap (law 6 reads the cap).
  if (Array.isArray(it.sockets) && R.chance(0.7)) {
    for (const g of it.sockets) {
      const line = gemLine(it, g);
      if (!line) continue;
      if (!Array.isArray(it.affixes)) it.affixes = [];
      it.affixes.push(R.chance(0.2) ? { ...line, value: R.pick([0, 1, 40, 100, 3.5]) } : line);
    }
  }
  return it;
}

/** A list of pieces (null entries and repeated legendaries included: the readers must skip or count them). */
function genItemList(R) {
  return Array.from({ length: R.int(0, 5) }, () => (R.chance(0.05) ? null : genItem(R)));
}

const SAVE_BLADES = [113, 114, 115, 118, 120, 121, 124, 127, 129, 131];
/** A character from the theory builder, over the grid of levels, races, blades, skill and gear lines. */
function theoryPick(R) {
  return theoryCharacter({
    level: R.pick([1, 2, 9, 45]),
    race: R.pick([1, 2, 3, 4, 5, 6, 7, 8]),
    blade: R.pick(SAVE_BLADES),
    material: R.pick([0, 9, 256]),
    gearLB: R.pick([0, 1, -1, 15, 40]),
    gearCS: R.pick([0, 5, -5]),
    rawBlade: R.pick([0, 50, 99, 100, 100.5, 101, 124.9, 125, 150, 175, 200, 201, -5, 300]),
    rawCrit: R.pick([0, 100, 150, 200]),
    rawBackstab: R.pick([100, 175, 200]),
    vampire: R.chance(0.3),
    starStats: { strength: R.pick([0, 20, -30, 100]), luck: R.pick([0, 10, -20]) },
    starSkills: R.chance(0.5) ? {} : { 5: R.pick([15, -15, 3]), 10: R.pick([-20, 0]), 28: 15 },
    starDamage: R.pick([0, 20, 50]),
    sockets: R.chance(0.3) ? ['ruby', 'empty'] : [],
    martialPath: null,
  });
}

/** The same character with the mastery switches and the mastered skills varied (online, offline, a list with odd entries). */
function saveVariant(R, ch) {
  const c = structuredClone(ch);
  const mode = R.u32() % 4;
  if (mode === 0) c.online = false;
  if (mode === 1) {
    c.online = false;
    c.masterSkills = true;
  }
  if (mode === 2) {
    c.online = undefined;
    c.masterSkills = false;
  }
  c.masteredSkills = R.chance(0.2)
    ? undefined
    : Array.from({ length: R.int(0, 5) }, () => R.pick([5, 28, 29, 30, 33, 34, 0, NaN, '28', 1.5]));
  return c;
}

/** A character with odd fields: the values the readers must read as JS reads them (strings, missing, null, NaN). */
function syntheticChar(R) {
  const skills = Array.from({ length: R.chance(0.8) ? 35 : R.int(0, 40) }, () => (
    R.chance(0.1) ? R.pick([undefined, null, '150', ' 50 ', 'x']) : R.pick(NUM_POOL)
  ));
  const effectKinds = ['disease', 'poison', 'artifact', 'racialOverride', 'fortifyAttribute', 'drainAttribute',
    'transferAttribute', 'spellShield'];
  const activeEffects = Array.from({ length: R.int(0, 5) }, () => {
    const e = {};
    if (R.chance(0.9)) e.kind = R.pick(effectKinds);
    if (R.chance(0.2)) e.ended = R.chance(0.5);
    if (R.chance(0.7)) e.statMods = Object.fromEntries(STAT_NAMES.filter(() => R.chance(0.5)).map((s) => [s, R.pick(NUM_POOL)]));
    if (R.chance(0.5)) e.stat = R.pick([...STAT_NAMES, 'bogus', undefined]);
    if (R.chance(0.5)) e.magnitude = R.pick(NUM_POOL);
    if (R.chance(0.5)) e.skillMods = Object.fromEntries(Array.from({ length: R.int(0, 3) }, () => [String(R.int(0, 34)), R.pick(NUM_POOL)]));
    return e;
  });
  return {
    name: R.pick(['', 'Syn', 'Ünï', '😀 x', 'A;B', undefined, null, 3]),
    raceId: R.pick([1, 2, 8, 9, 0, undefined, null, '1', -1, 1.5, NaN]),
    race: R.pick(['', 'Nord', undefined, null, 5]),
    career: R.pick([null, undefined, { name: 'Mage' }, { name: '' }, { name: 0 }, {}]),
    level: R.pick([1, 2.5, -0, NaN, 1e21, undefined, null, 7]),
    skills,
    stats: Object.fromEntries(STAT_NAMES.map((s) => [s, R.chance(0.9) ? R.pick(NUM_POOL) : R.pick([undefined, null, '60'])])),
    activeEffects,
    online: R.pick([true, false, undefined]),
    masterSkills: R.pick([true, false, undefined]),
    masteredSkills: Array.from({ length: R.int(0, 4) }, () => R.pick([5, 28, 33, NaN, 1.5, 0])),
    _mods: {
      stats: Object.fromEntries(STAT_NAMES.filter(() => R.chance(0.4)).map((s) => [s, R.pick(NUM_POOL)])),
      statMax: Object.fromEntries(STAT_NAMES.filter(() => R.chance(0.3)).map((s) => [s, R.pick(NUM_POOL)])),
      skills: Object.fromEntries(Array.from({ length: R.int(0, 4) }, () => [String(R.int(0, 34)), R.pick(NUM_POOL)])),
    },
    _enchantMods: {
      skillMods: Object.fromEntries(Array.from({ length: R.int(0, 4) }, () => [String(R.int(0, 34)), R.pick(NUM_POOL)])),
      chanceToHitMod: 0,
    },
  };
}

/** The fields the save helpers read, copied only when present (a missing key stays missing). */
const SAVE_KEYS = [
  'online', 'masterSkills', 'masteredSkills', 'skills', 'stats', 'activeEffects', '_mods', '_enchantMods', 'name',
  'raceId', 'race', 'career', 'level',
];
function saveProjection(ch) {
  const p = {};
  for (const k of SAVE_KEYS) if (k in ch) p[k] = ch[k];
  return p;
}

// ---- coverage: deterministic items the random draws would rarely hit ------------------------------------------------
const COVER_TEMPLATE = { Weapons: 115, Armor: 102, Jewellery: 133, MensClothing: 163, WomensClothing: 200 };

/**
 * One item per affix kind, group, param and value at the band's edges (1, the Magic bottom, the Rare top and one past,
 * the Legendary top and one past, 0). A skill's ~35 params take the kind's first group only, to keep the file small.
 */
function coverageItems() {
  const items = [];
  for (const id of AFFIX_KIND_IDS) {
    const k = AFFIX_KINDS[id];
    const r = AFFIX_RANGES[id];
    const params = Array.isArray(k.params) ? k.params : [undefined];
    const groups = params.length > 10 ? [k.groups[0]] : k.groups;
    const values = [1, r.magic[0], r.rare[1], r.rare[1] + 1, r.legendary[1], r.legendary[1] + 1, 0];
    for (const group of groups) {
      for (const p of params) {
        for (const value of values) {
          const a = { id };
          if (p !== undefined) a.param = p;
          a.value = value;
          items.push({ group, templateIndex: COVER_TEMPLATE[group], rarity: 'rare', equipSlot: 19, affixes: [a] });
        }
      }
    }
  }
  return items;
}

/** A stack of three or four copies of each gem on a weapon or a piece of armour: the Rare cap of a kind binds on these. */
function gemStackItems() {
  const items = [];
  for (const g of ALL_GEM_IDS) {
    for (const [group, template, copies] of [['Weapons', 115, 3], ['Weapons', 113, 4], ['Armor', 102, 3]]) {
      const it = { group, templateIndex: template, rarity: 'rare', equipSlot: 19, sockets: Array.from({ length: copies }, () => g) };
      it.affixes = it.sockets.map((s) => gemLine(it, s));
      items.push(it);
    }
  }
  return items;
}

function genSaveFamily() {
  const out = new Out(
    'save',
    'defs: `def <i> <value>` (a character projection, an item list, a save, an options record); kinds: eff <v> => f64 | msa @ch => b | mcs @ch <id> <raw> => v | smo @ch <id> => f64 | sv @ch <id> => f64 | ls @ch <stat> => f64 | rem @items => v | rm @items => v | cl @ch => s | sn <id> => s | wsk <id> => v | pf <id> => v | cfs @save @opts => v (characterFromSave) | cfsa @save @opts => [ch, analysis]',
  );
  const R = makeLcg(0x5a0e01);
  const fam = {};
  const add = (kind, ...t) => {
    out.add(kind, ...t);
    fam[kind] = (fam[kind] ?? 0) + 1;
  };
  const chars = [];
  const charIdx = [];
  let di = 0;
  for (let i = 0; i < 40; i++) {
    const ch = saveProjection(saveVariant(R, theoryPick(R)));
    out.add('def', String(di), encodeValue(ch));
    chars.push(ch);
    charIdx.push(di++);
  }
  for (let i = 0; i < 60; i++) {
    const ch = saveProjection(syntheticChar(R));
    out.add('def', String(di), encodeValue(ch));
    chars.push(ch);
    charIdx.push(di++);
  }
  const lists = [];
  const listIdx = [];
  for (let i = 0; i < 80; i++) {
    const list = genItemList(R);
    out.add('def', String(di), encodeValue(list));
    lists.push(list);
    listIdx.push(di++);
  }
  const ch = () => {
    const i = R.u32() % chars.length;
    return { ref: `@${charIdx[i]}`, val: chars[i] };
  };
  const pickList = () => {
    const i = R.u32() % lists.length;
    return { ref: `@${listIdx[i]}`, val: lists[i] };
  };
  // Effect sweep: every effect kind that reads a stat, with the magnitude or the statMods entry missing, zero, negative,
  // ended, or on each attribute, at a base of 50 and of 0. The defaults (`?? 0`) and the arm of each sign are read here.
  const SWEEP_KINDS = ['disease', 'poison', 'artifact', 'racialOverride', 'fortifyAttribute', 'drainAttribute', 'transferAttribute'];
  const SWEEP_EFFECTS = [
    (s) => ({}),
    (s) => ({ magnitude: 0 }),
    (s) => ({ magnitude: 3 }),
    (s) => ({ magnitude: -2 }),
    (s) => ({ magnitude: 60, ended: true }),
    (s) => ({ statMods: {} }),
    (s) => ({ statMods: { [s]: 0 } }),
    (s) => ({ statMods: { [s]: 2 } }),
    (s) => ({ statMods: { [s]: -4 }, magnitude: 1, ended: false }),
    // the positive threshold of a racialOverride is `> 0`: a value of 0.5 or 1 must be read as above it
    (s) => ({ statMods: { [s]: 0.5 } }),
    (s) => ({ statMods: { [s]: 1 } }),
  ];
  for (const kind of SWEEP_KINDS) {
    for (const stat of STAT_NAMES) {
      for (const base of [50, 0]) {
        for (const variant of SWEEP_EFFECTS) {
          const e = { kind, stat, ...variant(stat) };
          const ch = {
            stats: Object.fromEntries(STAT_NAMES.map((s) => [s, base])),
            activeEffects: [e],
            _mods: { stats: {}, statMax: {} },
          };
          out.add('def', String(di), encodeValue(ch));
          chars.push(ch);
          charIdx.push(di);
          const other = STAT_NAMES[(STAT_NAMES.indexOf(stat) + 3) % STAT_NAMES.length];
          add('ls', `@${di}`, encodeValue(stat), '=>', numToken(liveStat(ch, stat)));
          add('ls', `@${di}`, encodeValue(other), '=>', numToken(liveStat(ch, other)));
          di++;
        }
      }
    }
  }
  // Coverage: each item of every kind as a one-piece list (the stat, skill and armour folds of rebuildMods, one item each).
  for (const it of [...coverageItems(), ...gemStackItems()]) {
    const list = [it];
    out.add('def', String(di), encodeValue(list));
    add('rm', `@${di}`, '=>', encodeValue(rebuildMods(list)));
    di++;
  }
  const SKILL_IDS = [0, 1, 5, 10, 16, 28, 29, 30, 31, 32, 33, 34];
  const idOf = () => (R.chance(0.7) ? R.pick(SKILL_IDS) : R.pick([NaN, null, undefined, '5', -1, 35, 1.5, 0, 34]));
  for (let i = 0; i < 2000; i++) {
    const v = R.chance(0.7) ? R.pick(NUM_POOL) : genValue(R, 0);
    add('eff', encodeValue(v), '=>', numToken(effectiveSkill(v)));
  }
  for (const v of [...NUM_POOL, '150', ' 50 ', undefined, null, true]) {
    add('eff', encodeValue(v), '=>', numToken(effectiveSkill(v)));
  }
  for (let i = 0; i < 2000; i++) {
    const c = ch();
    add('msa', c.ref, '=>', encodeValue(masterSkillsActive(c.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const c = ch();
    const id = idOf();
    const raw = R.chance(0.8) ? R.pick(NUM_POOL) : genValue(R, 0);
    add('mcs', c.ref, encodeValue(id), encodeValue(raw), '=>', encodeValue(masterCappedSkill(c.val, id, raw)));
  }
  for (let i = 0; i < 2000; i++) {
    const c = ch();
    const id = idOf();
    add('smo', c.ref, encodeValue(id), '=>', numToken(skillModOf(c.val, id)));
  }
  for (let i = 0; i < 2000; i++) {
    const c = ch();
    const id = idOf();
    add('sv', c.ref, encodeValue(id), '=>', numToken(skillValue(c.val, id)));
  }
  for (let i = 0; i < 2000; i++) {
    const c = ch();
    const stat = R.pick(STAT_NAMES);
    add('ls', c.ref, encodeValue(stat), '=>', numToken(liveStat(c.val, stat)));
  }
  for (let i = 0; i < 2000; i++) {
    const l = pickList();
    add('rem', l.ref, '=>', encodeValue(rebuildEnchantMods(l.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const l = pickList();
    add('rm', l.ref, '=>', encodeValue(rebuildMods(l.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const c = ch();
    add('cl', c.ref, '=>', encodeValue(characterLabel(c.val)));
  }
  for (let i = 0; i < 2000; i++) {
    // 'length' is the SKILL_NAMES array's own length (a number, 35): JS returns it, not a name.
    const id = R.chance(0.7) ? R.int(0, 36) : R.pick([NaN, -1, 1.5, '5', 'Medical', undefined, null, 1e21, '34', 35, 'length', 4294967295, '4294967295', 4294967296]);
    add('sn', encodeValue(id), '=>', encodeValue(skillName(id)));
  }
  const TEMPLATE_KEYS = [113, 114, 115, 118, 120, 121, 124, 127, 129, 130, 131, 560, 563, 102, 0, 999, '113', NaN, undefined];
  for (let i = 0; i < 2000; i++) {
    const id = R.chance(0.8) ? R.pick(TEMPLATE_KEYS) : R.int(-1, 700);
    add('wsk', encodeValue(id), '=>', encodeValue(WEAPON_SKILL[id]));
  }
  for (let i = 0; i < 2000; i++) {
    const id = R.chance(0.8) ? R.int(0, 36) : R.pick([28, 29, 30, 31, 32, 33, 'Medical', NaN, undefined, '28']);
    add('pf', encodeValue(id), '=>', encodeValue(PROFICIENCY_FLAG[id]));
  }

  // ---- characterFromSave: the raw save and the caller's options, exactly as they read the worn list and its folds ----
  // A save is written once and read with several option records; the shapes that differ are the two the function branches
  // on: a raw save (items carry `equipSlot`, `_mods` / `_enchantMods` may be absent) and a live snapshot (`equipSlots`
  // is the game's own table, `equipSlot` on the item may be stale). Absent vs null is kept (a missing key stays missing),
  // and every top-level field the model does NOT read is present so the reader proves it is ignored.
  const rawSave = (R) => {
    const worn = R.chance(0.7);
    const item = () => {
      const it = genItem(R);
      if (worn) it.equipSlot = R.pick([19, 21, 12, 18, 20, 23, 26, 0, -1, 19.5, '19']);
      else delete it.equipSlot;
      if (R.chance(0.25)) it.legendary = R.pick(LEGENDARY_FEW);
      if (R.chance(0.25)) it.group = 'Weapons';
      if (R.chance(0.1)) it.templateIndex = 563;
      return it;
    };
    const save = {
      name: R.pick(['', 'Syn', 'Ünï', undefined, null, 3]),
      level: R.pick([1, 2.5, -0, NaN, 1e21, undefined, null, 7]),
      raceId: R.pick([1, 2, 8, 9, 0, undefined, null, '1', -1, 1.5, NaN]),
      race: R.pick(['', 'Nord', undefined, null, 5]),
      gender: R.pick(['male', 'female', '', undefined]),
      career: R.pick([null, undefined, { name: 'Mage' }, { name: '' }, { name: 0 }, {}]),
      reflexes: R.pick([1, 2, 0, undefined, NaN]),
      health: R.pick([0, 1, 700, -5, undefined, NaN]),
      maxHealth: R.pick([0, 1, 700, undefined, NaN]),
      magicka: R.pick([0, 50, undefined, null, NaN]),
      spellPoints: R.pick([0, 50, undefined, null]),
      maxMagicka: R.pick([0, 100, undefined, null, NaN]),
      maxSpellPoints: R.pick([0, 100, undefined, null]),
      ...(R.chance(0.4) ? { maxMagickaBase: R.pick([100, 0, undefined, NaN, '150']) } : {}),
      spells: R.chance(0.2) ? undefined : Array.from({ length: R.int(0, 3) }, () => (R.chance(0.3) ? R.int(0, 40) : { name: 'Fireball', effects: [] })),
      readiedSpellIndex: R.pick([null, undefined, 0, 4, '2']),
      stats: Object.fromEntries(STAT_NAMES.map((s) => [s, R.chance(0.9) ? R.pick(NUM_POOL) : R.pick([undefined, null, '60'])])),
      skills: Array.from({ length: R.chance(0.8) ? 35 : R.int(0, 40) }, () => (
        R.chance(0.1) ? R.pick([undefined, null, '150', ' 50 ', 'x']) : R.pick(NUM_POOL)
      )),
      activeEffects: Array.from({ length: R.int(0, 3) }, () => (R.chance(0.1) ? null : {
        kind: R.pick(['disease', 'racialOverride', 'fortifyAttribute', undefined]),
        statMods: R.chance(0.5) ? { strength: R.pick(NUM_POOL) } : undefined,
        magnitude: R.pick(NUM_POOL),
        ended: R.pick([true, false, undefined]),
      })),
      masterSkills: R.pick([true, false, undefined]),
      masteredSkills: R.chance(0.2) ? undefined : Array.from({ length: R.int(0, 4) }, () => R.pick([5, 28, 33, NaN, 1.5, 0])),
      martialPath: R.pick([null, undefined, 'assassin', '']),
      items: R.chance(0.05) ? undefined : Array.from({ length: R.int(0, 5) }, () => (R.chance(0.05) ? null : item())),
      // A top-level field no read touches: it must not reach the character.
      ignoredTopLevel: R.pick([undefined, null, 1, 'x', { nested: true }]),
      folder: R.pick(['SAVE1', undefined]),
    };
    // `_mods` / `_enchantMods`: present as the two copies, present but missing a channel, or absent entirely.
    if (R.chance(0.5)) {
      save._mods = {
        stats: R.chance(0.8) ? Object.fromEntries(STAT_NAMES.filter(() => R.chance(0.4)).map((s) => [s, R.pick(NUM_POOL)])) : undefined,
        statMax: Object.fromEntries(STAT_NAMES.filter(() => R.chance(0.3)).map((s) => [s, R.pick(NUM_POOL)])),
        skills: R.chance(0.8) ? Object.fromEntries(Array.from({ length: R.int(0, 4) }, () => [String(R.int(0, 34)), R.pick(NUM_POOL)])) : undefined,
        extraChannel: 7,
      };
    }
    if (R.chance(0.5)) {
      save._enchantMods = {
        skillMods: R.chance(0.8) ? Object.fromEntries(Array.from({ length: R.int(0, 4) }, () => [String(R.int(0, 34)), R.pick(NUM_POOL)])) : undefined,
        chanceToHitMod: R.pick([0, 5, NaN]),
        other: 'kept',
      };
    }
    // The live equip table: present (even empty), or absent. Its records may differ from `items` on purpose (the stale
    // `equipSlot` case); the slot key is a number's string form as the game stores it.
    if (R.chance(0.5)) {
      save.equipSlots = {};
      for (const slot of R.pick([[19], [19, 21], [18, 12, 20], [], [19, 21, 23]])) {
        const it = R.chance(0.08) ? R.pick([null, 0, 'x']) : item();
        save.equipSlots[String(slot)] = it;
      }
    }
    return save;
  };
  const optsRecord = (R) => {
    const o = {};
    if (R.chance(0.7)) o.online = R.pick([true, false, undefined, null, 1, 'false']);
    if (R.chance(0.4)) o.martialPath = R.pick([null, undefined, 'warblade', '']);
    if (R.chance(0.3)) o.slot = R.pick(['SAVE1', null, undefined, 2]);
    if (R.chance(0.3)) o.file = R.pick(['/tmp/SaveData.txt', null, undefined]);
    if (R.chance(0.2)) o.passiveOn = R.pick([true, false]);
    return o;
  };
  const saves = new Map();
  const saveIdx = [];
  for (let i = 0; i < 400; i++) {
    const s = rawSave(R);
    out.add('def', String(di), encodeValue(s));
    saves.set(di, s);
    saveIdx.push(di++);
  }
  const optsByIdx = new Map();
  const optsIdx = [];
  for (let i = 0; i < 40; i++) {
    const o = optsRecord(R);
    out.add('def', String(di), encodeValue(o));
    optsByIdx.set(di, o);
    optsIdx.push(di++);
  }
  // A focused handful the random draw would rarely pair: an empty live table, no item slot at all, no `items`, a live
  // table whose record disagrees with the item's own stale mark, and a save with only one of the two folds.
  const focused = [
    { items: [{ group: 'Weapons', templateIndex: 117, equipSlot: 19 }], equipSlots: {}, ignoredTopLevel: 'x' },
    { items: [{ group: 'Weapons', templateIndex: 117 }] },
    { stats: {}, skills: [] },
    { items: [], equipSlots: { 19: { group: 'Weapons', templateIndex: 118 } } },
    { items: [{ group: 'Weapons', templateIndex: 117, equipSlot: 19 }], _mods: { stats: { strength: 5 } } },
    { items: [{ group: 'Weapons', templateIndex: 117, equipSlot: 19 }], _enchantMods: { skillMods: { 28: 5 } } },
    { items: [{ group: 'Weapons', templateIndex: 117, equipSlot: 19 }], _mods: {} },
    { items: [{ group: 'Weapons', templateIndex: 117, equipSlot: 19 }], _enchantMods: {} },
    // `equipSlots` and `items` disagree on the same piece: the live table wins over the stale mark.
    {
      items: [{ group: 'Weapons', templateIndex: 121, equipSlot: 21, name: 'Stale' }, { group: 'Weapons', templateIndex: 121, name: 'Live' }],
      equipSlots: { 19: { group: 'Weapons', templateIndex: 121, name: 'Live' } },
    },
    // A live table with a slot key that is not a canonical index (Number(key) keeps the fraction).
    { equipSlots: { '19.5': { group: 'Weapons', templateIndex: 124, name: 'Odd' } } },
    // A raw save whose two-hand piece is at the left hand only (right falls back to left, off hand is then null).
    { items: [{ group: 'Weapons', templateIndex: 123, equipSlot: 21 }] },
    // `equipSlots` is truthy but not an object (`typeof` says no): the items' own marks are the worn list.
    { items: [{ group: 'Weapons', templateIndex: 117, equipSlot: 19 }], equipSlots: 'slot 19' },
    { items: [{ group: 'Weapons', templateIndex: 117, equipSlot: 19 }], equipSlots: 1 },
    { items: [{ group: 'Weapons', templateIndex: 117, equipSlot: 19 }], equipSlots: true },
    // An object/array `equipSlots` that is empty still counts as live (an empty table wins: nothing is worn).
    { items: [{ group: 'Weapons', templateIndex: 117, equipSlot: 19 }], equipSlots: [] },
    { items: [{ group: 'Weapons', templateIndex: 563, equipSlot: 19 }, { group: 'Weapons', templateIndex: 117, equipSlot: 19 }] },
    // Absent vs null: the `??` fallbacks (`magicka ?? spellPoints`) and the `||` defaults read them differently.
    { magicka: null, spellPoints: 50 },
    { spellPoints: 50 },
    { magicka: 0, spellPoints: 50 },
    { name: '', level: 0, race: null, gender: '' },
    { career: null, martialPath: null, readiedSpellIndex: null },
    // A stale raw shape: the same piece in `items` carries a packed/negative mark while the live table holds it at 19.
    { items: [{ group: 'Weapons', templateIndex: 118, equipSlot: -1 }, { group: 'Weapons', templateIndex: 118, equipSlot: 19 }], equipSlots: { 19: { group: 'Weapons', templateIndex: 118 } } },
    // `_mods` null (`truthy` false: a re-fold) vs `_mods` with an explicit null channel (`{}`).
    { items: [], _mods: null },
    { items: [], _mods: { stats: null, skills: null } },
    { items: [], _enchantMods: null },
    { items: [], _enchantMods: { skillMods: null } },
  ];
  const focusedIdx = [];
  for (const s of focused) {
    out.add('def', String(di), encodeValue(s));
    saves.set(di, s);
    focusedIdx.push(di++);
  }
  const read = (save, opts) => characterFromSave(structuredClone(save), structuredClone(opts));
  // The mutation guard: the reader clones and never writes its inputs.
  for (const idx of [...focusedIdx, ...saveIdx.slice(0, 40)]) {
    const save = saves.get(idx);
    const o = optsByIdx.get(optsIdx[0]);
    const beforeSave = encodeValue(save);
    const beforeOpts = encodeValue(o);
    read(save, o);
    if (beforeSave !== encodeValue(save) || beforeOpts !== encodeValue(o)) {
      throw new Error(`characterFromSave mutated its input (save @${idx})`);
    }
  }
  for (const idx of focusedIdx) add('cfs', `@${idx}`, encodeValue({}), '=>', encodeValue(read(saves.get(idx), {})));
  for (let i = 0; i < 2400; i++) {
    const pick = saveIdx[R.u32() % saveIdx.length];
    const oi = optsIdx[R.u32() % optsIdx.length];
    add('cfs', `@${pick}`, `@${oi}`, '=>', encodeValue(read(saves.get(pick), optsByIdx.get(oi))));
  }
  // The analysis parity: a save the model can price (the random ones carry absurd stats that make `analyze` itself
  // throw), and the character `characterFromSave` builds from it must answer the card `analyze` answers for a saved
  // character. The Rust side runs its own `analyze` over the character it built, with an empty spellbook.
  const board = (items, extra = {}) => ({
    level: 45, raceId: 5, career: { name: 'Longblade' },
    stats: { strength: 60, intelligence: 40, willpower: 40, agility: 60, endurance: 50, personality: 40, speed: 50, luck: 50 },
    skills: Array.from({ length: 35 }, () => 100), items, health: 700, maxHealth: 700, ...extra,
  });
  const analysisSaves = [
    board([{ group: 'Weapons', templateIndex: 121, material: 9, name: 'Daedric Katana', equipSlot: 19, maxCondition: 100, currentCondition: 100 }]),
    board([{ group: 'Weapons', templateIndex: 123, material: 9, name: 'Daedric Dai-katana', equipSlot: 19, maxCondition: 100, currentCondition: 100 }]),
    board([{ group: 'Weapons', templateIndex: 118, material: 3, name: 'Elven Broadsword', equipSlot: 19, maxCondition: 100, currentCondition: 100 },
      { group: 'Weapons', templateIndex: 121, material: 9, name: 'Daedric Katana', equipSlot: 21, maxCondition: 100, currentCondition: 100 }]),
    board([{ group: 'Armor', templateIndex: 102, material: 521, name: 'Daedric Cuirass', equipSlot: 18, maxCondition: 100, currentCondition: 100 }]),
    board([{ group: 'Weapons', templateIndex: 121, material: 9, name: 'Daedric Katana', maxCondition: 100, currentCondition: 100 }],
      { equipSlots: { 19: { group: 'Weapons', templateIndex: 123, material: 9, name: 'Live Dai-katana', maxCondition: 100, currentCondition: 100 } } }),
  ];
  const analysisBook = new Map();
  for (const save of analysisSaves) {
    out.add('def', String(di), encodeValue(save));
    add('cfsa', `@${di}`, encodeValue({ online: false }), '=>', encodeValue(analyze(read(save, { online: false }), { standard: analysisBook })));
    di++;
  }
  console.log(`save: ${Object.entries(fam).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return out.write();
}

function genGearFamily() {
  const out = new Out(
    'gear',
    'defs: `def <i> <value>` (items, item lists); kinds: laid @item => arr | ril @item => arr | vil @item => arr | wdp @item => f64 | bl @item => obj | fl @items => obj | sf <template> => f64 (socketsFor)',
  );
  const R = makeLcg(0x6ea701);
  const fam = {};
  const add = (kind, ...t) => {
    out.add(kind, ...t);
    fam[kind] = (fam[kind] ?? 0) + 1;
  };
  let di = 0;
  const items = [];
  const itemIdx = [];
  for (let i = 0; i < 400; i++) {
    const it = genItem(R);
    out.add('def', String(di), encodeValue(it));
    items.push(it);
    itemIdx.push(di++);
  }
  const lists = [];
  const listIdx = [];
  for (let i = 0; i < 80; i++) {
    const list = genItemList(R);
    out.add('def', String(di), encodeValue(list));
    lists.push(list);
    listIdx.push(di++);
  }
  const it = () => {
    const i = R.u32() % items.length;
    return { ref: `@${itemIdx[i]}`, val: items[i] };
  };
  const list = () => {
    const i = R.u32() % lists.length;
    return { ref: `@${listIdx[i]}`, val: lists[i] };
  };
  for (let i = 0; i < 2000; i++) {
    const x = it();
    add('laid', x.ref, '=>', encodeValue(laidLines(x.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const x = it();
    add('ril', x.ref, '=>', encodeValue(readItemLines(x.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const x = it();
    add('vil', x.ref, '=>', encodeValue(validItemLines(x.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const x = it();
    add('wdp', x.ref, '=>', numToken(weaponDamagePct(x.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const x = it();
    add('bl', x.ref, '=>', encodeValue(bladeLines(x.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const x = list();
    add('fl', x.ref, '=>', encodeValue(foldLines(x.val)));
  }
  // Coverage: every item of every kind (one affix each), and each gem stack, through each reader.
  for (const v of [...coverageItems(), ...gemStackItems()]) {
    const ref = `@${di}`;
    out.add('def', String(di++), encodeValue(v));
    const list = [v];
    const lref = `@${di}`;
    out.add('def', String(di++), encodeValue(list));
    add('laid', ref, '=>', encodeValue(laidLines(v)));
    add('ril', ref, '=>', encodeValue(readItemLines(v)));
    add('vil', ref, '=>', encodeValue(validItemLines(v)));
    add('wdp', ref, '=>', numToken(weaponDamagePct(v)));
    add('bl', ref, '=>', encodeValue(bladeLines(v)));
    add('fl', lref, '=>', encodeValue(foldLines(list)));
  }
  const TEMPLATES = [113, 114, 115, 118, 120, 121, 124, 127, 129, 130, 131, 560, 563, 102, 0, 7, 999, '113', '560', undefined, null, 7.5];
  for (let i = 0; i < 2000; i++) {
    const t = R.chance(0.85) ? R.pick(TEMPLATES) : R.int(0, 700);
    add('sf', encodeValue(t), '=>', numToken(socketsFor(t)));
  }
  console.log(`gear: ${Object.entries(fam).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return out.write();
}

function genSocketsFamily() {
  const out = new Out(
    'sockets',
    'defs: `def <i> <value>` (items); kinds: scount <item|template> => f64 | saff @item => arr | pgem <kind> => s | psock <item|template> => arr',
  );
  const R = makeLcg(0x50c4e7);
  const fam = {};
  const add = (kind, ...t) => {
    out.add(kind, ...t);
    fam[kind] = (fam[kind] ?? 0) + 1;
  };
  let di = 0;
  const items = [];
  const itemIdx = [];
  for (let i = 0; i < 400; i++) {
    const it = genItem(R);
    out.add('def', String(di), encodeValue(it));
    items.push(it);
    itemIdx.push(di++);
  }
  const it = () => {
    const i = R.u32() % items.length;
    return { ref: `@${itemIdx[i]}`, val: items[i] };
  };
  const TEMPLATES = [113, 114, 115, 118, 120, 121, 124, 127, 129, 130, 131, 560, 563, 102, 0, 7, '113', undefined, null];
  const itemOrTemplate = () => {
    if (R.chance(0.7)) {
      const x = it();
      return { ref: x.ref, val: x.val };
    }
    const t = R.chance(0.85) ? R.pick(TEMPLATES) : R.int(0, 700);
    return { ref: encodeValue(t), val: t };
  };
  for (let i = 0; i < 2000; i++) {
    const x = itemOrTemplate();
    add('scount', x.ref, '=>', numToken(socketCount(x.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const x = it();
    add('saff', x.ref, '=>', encodeValue(socketAffixes(x.val)));
  }
  // Coverage: every item of every kind and each gem stack, through the three item readers.
  for (const v of [...coverageItems(), ...gemStackItems()]) {
    const ref = `@${di}`;
    out.add('def', String(di++), encodeValue(v));
    add('scount', ref, '=>', numToken(socketCount(v)));
    add('saff', ref, '=>', encodeValue(socketAffixes(v)));
    add('psock', ref, '=>', encodeValue(perfectSockets(v)));
  }
  const KINDS = ['diamond', 'ruby', 'amber', 'flawless', 0, 1, null, undefined, 'sapphire', ''];
  for (let i = 0; i < 2000; i++) {
    const k = R.pick(KINDS);
    add('pgem', encodeValue(k), '=>', encodeValue(perfectGem(k)));
  }
  for (let i = 0; i < 2000; i++) {
    const x = itemOrTemplate();
    add('psock', x.ref, '=>', encodeValue(perfectSockets(x.val)));
  }
  console.log(`sockets: ${Object.entries(fam).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return out.write();
}

function genLootFamily() {
  const out = new Out(
    'loot',
    'defs: `def <i> <value>` (items, item lists, targets); kinds: rl @item => arr | va <affix> => b | gl @item <gem> => v | sg @item => arr | so @item => arr | sm @item => f64 | cp @list => arr | pio @item => arr | po <id> => v | fg @target => v',
  );
  const R = makeLcg(0x100711);
  const fam = {};
  const add = (kind, ...t) => {
    out.add(kind, ...t);
    fam[kind] = (fam[kind] ?? 0) + 1;
  };
  let di = 0;
  const items = [];
  const itemIdx = [];
  for (let i = 0; i < 400; i++) {
    const it = genItem(R);
    out.add('def', String(di), encodeValue(it));
    items.push(it);
    itemIdx.push(di++);
  }
  const lists = [];
  const listIdx = [];
  for (let i = 0; i < 80; i++) {
    const list = genItemList(R);
    out.add('def', String(di), encodeValue(list));
    lists.push(list);
    listIdx.push(di++);
  }
  const it = () => {
    const i = R.u32() % items.length;
    return { ref: `@${itemIdx[i]}`, val: items[i] };
  };
  const list = () => {
    const i = R.u32() % lists.length;
    return { ref: `@${listIdx[i]}`, val: lists[i] };
  };
  for (let i = 0; i < 2000; i++) {
    const x = it();
    add('rl', x.ref, '=>', encodeValue(readLines(x.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const a = R.chance(0.8) ? genAffix(R) : R.pick([genValue(R, 2), null, undefined, 'damage', { id: 'constructor' }]);
    add('va', encodeValue(a), '=>', validAffix(a) ? 'b1' : 'b0');
  }
  const GEMS = [...ALL_GEM_IDS, 'bogus', 'ruby ', null, 5, 'perfect-amber', 'chipped-empty', undefined];
  for (let i = 0; i < 2000; i++) {
    const x = it();
    const g = R.pick(GEMS);
    add('gl', x.ref, encodeValue(g), '=>', encodeValue(gemLine(x.val, g)));
  }
  for (let i = 0; i < 2000; i++) {
    const x = it();
    add('sg', x.ref, '=>', encodeValue(socketGems(x.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const x = it();
    add('so', x.ref, '=>', encodeValue(socketsOf(x.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const x = it();
    add('sm', x.ref, '=>', numToken(socketMax(x.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const l = list();
    add('cp', l.ref, '=>', encodeValue(countedPieces(l.val)));
  }
  for (let i = 0; i < 2000; i++) {
    const x = it();
    add('pio', x.ref, '=>', encodeValue(powerIdsOf(x.val)));
  }
  // Coverage: every item of every kind and each gem stack through the readers; every coverage affix through validAffix,
  // and every set gem through gemLine.
  for (const v of [...coverageItems(), ...gemStackItems()]) {
    const ref = `@${di}`;
    out.add('def', String(di++), encodeValue(v));
    add('rl', ref, '=>', encodeValue(readLines(v)));
    add('sg', ref, '=>', encodeValue(socketGems(v)));
    add('so', ref, '=>', encodeValue(socketsOf(v)));
    add('sm', ref, '=>', numToken(socketMax(v)));
    add('pio', ref, '=>', encodeValue(powerIdsOf(v)));
    for (const a of v.affixes ?? []) add('va', encodeValue(a), '=>', validAffix(a) ? 'b1' : 'b0');
    for (const g of v.sockets ?? []) add('gl', ref, encodeValue(g), '=>', encodeValue(gemLine(v, g)));
  }
  // powerOf: every id either table holds, once each (the table's own and the legendaries' own powers), then the odd
  // inputs, then random picks. An inherited name ('constructor', '__proto__') is left out: JS answers the Object.prototype
  // member (a function, or the prototype object), which a codec value cannot hold; the port refuses it (rust/README.md).
  const INHERITED = new Set(Object.getOwnPropertyNames(Object.prototype));
  const OWN_POWER_IDS = allLegendaries().filter((l) => l.power !== undefined && l.power !== null).map((l) => l.id);
  const POWER_TABLE_IDS = Object.keys(LEGENDARY_POWERS);
  const POWER_IDS = [...new Set([...POWER_TABLE_IDS, ...OWN_POWER_IDS, ...LEGENDARY_IDS])].filter((id) => !INHERITED.has(id));
  const BOTH_POWER_IDS = OWN_POWER_IDS.filter((id) => POWER_TABLE_IDS.includes(id));
  console.log(`powerOf: ${POWER_IDS.length} ids (${POWER_TABLE_IDS.length} in LEGENDARY_POWERS, ${OWN_POWER_IDS.length} with an own power, ${BOTH_POWER_IDS.length} in both)`);
  const ODD_POWER_INPUTS = [null, undefined, NaN, 5, true, ['wall-of-daggerfall'], { id: 'wyrmbane' }, '', 'nope', 'Foxglove', ' wyrmbane'];
  for (const id of [...POWER_IDS, ...ODD_POWER_INPUTS]) add('po', encodeValue(id), '=>', encodeValue(powerOf(id)));
  for (let i = 0; i < 2000; i++) {
    const id = R.chance(0.9) ? R.pick(POWER_IDS) : R.pick(ODD_POWER_INPUTS);
    add('po', encodeValue(id), '=>', encodeValue(powerOf(id)));
  }
  for (let i = 0; i < 2000; i++) {
    const t = R.chance(0.8)
      ? { isPlayer: R.pick([true, false, undefined]), affinity: R.pick(['Human', 'Undead', 'Animal', undefined, null]), careerIndex: R.pick([0, 6, 7, 8, 12, 15, 21, 24, 128, 130, 140, 146, 99, undefined, null, NaN]) }
      : { isPlayer: false, affinity: 'Human', careerIndex: R.int(0, 60) };
    add('fg', encodeValue(t), '=>', encodeValue(foeGroup(t)));
  }
  console.log(`loot: ${Object.entries(fam).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return out.write();
}

counts.value = genValueFamily();
counts.save = genSaveFamily();
counts.gear = genGearFamily();
counts.sockets = genSocketsFamily();
counts.loot = genLootFamily();
Object.assign(counts, genBlowFamilies(Out, makeLcg));
Object.assign(counts, genSpellFamilies(Out, makeLcg));
Object.assign(counts, genAnalysisFamilies(Out, makeLcg));
Object.assign(counts, genFightFamilies(Out, makeLcg));
Object.assign(counts, genPlanningFamilies(Out, makeLcg));

counts.maketarget = await genMaketarget();
Object.assign(counts, genFirmamentFamilies(Out, makeLcg));
Object.assign(counts, genPlannerFamilies(Out));
Object.assign(counts, genForgeFamilies(Out));
Object.assign(counts, genForgeGearFamilies(Out));
counts.round = genRound();
counts.rng = genRng();
counts.damage = genDamage();
counts.allowance = genAllowance();
counts.relay_claim = genRelay();
counts.swing = genSwing();
counts.target = genTarget();
for (const [k, v] of Object.entries(counts)) console.log(`${k}: ${v} lines -> ${join('rust', 'tests', 'vectors', `${k}.txt`)}`);
