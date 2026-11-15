/*
 * test/harness/prng.mjs - deterministic, unbiased-enough randomness for the
 * differential tests.
 *
 * No test may depend on Math.random. Every stochastic comparison takes a seed,
 * so a failure reproduces exactly. The generators here are small, well-known
 * 32-bit algorithms with good statistical behaviour (mulberry32 and
 * xoshiro128**), never a naive LCG: an LCG's low bits correlate and gave the
 * audit a 99% "hit rate" against a 97% clamp before it was replaced.
 */

/** mulberry32: one 32-bit state word, period 2^32. Returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** xoshiro128**: four 32-bit state words, period 2^128-1. Returns floats in [0, 1). */
export function xoshiro128ss(seed = 1) {
  const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
  let s0 = seed >>> 0 || 1;
  let s1 = 0x9e3779b9;
  let s2 = 0x243f6a88;
  let s3 = 0xb7e15162;
  // Warm up so nearby seeds do not start in lockstep.
  for (let i = 0; i < 16; i++) {
    const t = (s1 << 9) >>> 0;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
  }
  return function next() {
    const result = (Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0) / 4294967296;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    return result;
  };
}

/** A named generator so a test states which one it uses. */
export const PRNG = Object.freeze({ mulberry32, xoshiro128ss });

/** The harness's default: mulberry32 (the one upstream's own card test uses). */
export const generator = (seed, kind = 'mulberry32') => PRNG[kind](seed);

/** An integer in [lo, hi] inclusive, from a [0,1) stream. */
export const intBetween = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/** A float in [lo, hi). */
export const floatBetween = (rng, lo, hi) => lo + rng() * (hi - lo);

/** One element of `list`. */
export const pick = (rng, list) => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

/** `count` distinct seeds from one root, so every case is independent but reproducible. */
export const seeds = (root, count) => Array.from({ length: count }, (_, i) => (root + i * 0x9e3779b9) >>> 0);

/** mean and sample standard deviation of a numeric sample. */
export function summarize(sample) {
  const n = sample.length;
  if (!n) return { n: 0, mean: NaN, sd: NaN, se: NaN, ci95: NaN };
  const mean = sample.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? sample.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  return { n, mean, sd, se, ci95: 1.96 * se };
}
