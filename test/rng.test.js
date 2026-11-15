/*
 * test/rng.test.js - Stage 3.1, Part B: the seeded stream RNG (src/rng.js).
 *
 * What is verified:
 *   determinism       the same seed and the same use give the same values, in any stream-creation order
 *   independence      a stream's values depend on (seed, name) only: draws in one stream never move another
 *   snapshot/restore  a restored generator or stream continues exactly as the original did, draws included
 *   accounting        every draw is counted, per stream, and only draws are counted
 *   invalid input     predictable TypeError / RangeError, never a silent coercion
 *   ambient state     the module never reads Math.random (checked on the source, comments stripped)
 *   the generator     xoshiro128** against an independent step function written here from the published algorithm, and
 *                     a coarse uniformity check
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createRng, _initialStateForTests } from '../src/rng.js';

const take = (stream, n) => Array.from({ length: n }, () => stream.next());

test('1. the same seed and the same use give the same sequence; a different seed does not', () => {
  const a = createRng(42);
  const b = createRng(42);
  assert.deepEqual(take(a.stream('blow'), 50), take(b.stream('blow'), 50));
  assert.notDeepEqual(take(createRng(42).stream('blow'), 8), take(createRng(43).stream('blow'), 8));
  assert.notDeepEqual(take(createRng(0).stream('blow'), 8), take(createRng(-1).stream('blow'), 8), 'zero and negative seeds are distinct');
  // large safe integers keep their high bits
  assert.notDeepEqual(take(createRng(2 ** 40).stream('x'), 8), take(createRng(2 ** 40 + 1).stream('x'), 8));
  assert.notDeepEqual(take(createRng(1).stream('x'), 8), take(createRng(1 + 2 ** 32).stream('x'), 8), 'the high half of the seed matters');
  assert.equal(createRng(7).seed, 7);
});

test('2. streams are independent: extra draws in one never move another, nor does creation order', () => {
  const quiet = createRng(99);
  const expectBlow = take(quiet.stream('blow'), 20);
  const expectEcho = take(quiet.stream('echo'), 20);

  const busy = createRng(99);
  const echo = busy.stream('echo'); // created first this time
  take(echo, 1000); // many draws in another stream
  assert.deepEqual(take(busy.stream('blow'), 20), expectBlow, 'blow is untouched by 1000 echo draws');
  const fresh = createRng(99);
  take(fresh.stream('blow'), 500);
  assert.deepEqual(take(fresh.stream('echo'), 20), expectEcho, 'and the other way round');

  assert.notDeepEqual(expectBlow, expectEcho, 'two names, two sequences');
  // names that differ by one character still diverge
  assert.notDeepEqual(take(createRng(5).stream('spell'), 6), take(createRng(5).stream('spelm'), 6));
  // no initial state is the all-zero fixed point
  for (const name of ['', 'a', 'blow'].slice(1)) assert.ok(_initialStateForTests(0, name).some((w) => w !== 0));
});

test('3. a stream matches an independent xoshiro128** step function from the same state', () => {
  const rng = createRng(2024);
  const s = rng.stream('blow');
  const state = [...s.snapshot().state];
  // the published algorithm, written out directly (Blackman & Vigna), with explicit 32-bit arithmetic
  const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
  const step = () => {
    const result = (Math.imul(rotl((Math.imul(state[1], 5)) >>> 0, 7), 9)) >>> 0;
    const t = (state[1] << 9) >>> 0;
    state[2] = (state[2] ^ state[0]) >>> 0;
    state[3] = (state[3] ^ state[1]) >>> 0;
    state[1] = (state[1] ^ state[2]) >>> 0;
    state[0] = (state[0] ^ state[3]) >>> 0;
    state[2] = (state[2] ^ t) >>> 0;
    state[3] = rotl(state[3], 11);
    return result;
  };
  for (let i = 0; i < 1000; i++) assert.equal(s.next(), step(), `draw ${i}`);
});

test('4. float() is in [0, 1), int(n) is in [0, n), and the sequence is roughly uniform', () => {
  const s = createRng(31337).stream('blow');
  const bins = new Array(10).fill(0);
  const N = 100000;
  for (let i = 0; i < N; i++) {
    const f = s.float();
    assert.ok(f >= 0 && f < 1);
    bins[Math.floor(f * 10)]++;
  }
  // Pearson chi-square, 9 degrees of freedom: the 0.999 quantile is 27.88 (fixed in advance)
  const chi = bins.reduce((a, o) => a + ((o - N / 10) ** 2) / (N / 10), 0);
  assert.ok(chi < 27.88, `chi-square ${chi.toFixed(2)} for ${bins}`);
  const ints = new Array(7).fill(0);
  for (let i = 0; i < 70000; i++) { const k = s.int(7); assert.ok(Number.isInteger(k) && k >= 0 && k < 7); ints[k]++; }
  assert.ok(ints.every((c) => Math.abs(c - 10000) < 400), `int(7): ${ints}`);
  assert.equal(s.int(1), 0);
});

test('5. draw accounting: every draw counts, per stream, and nothing else does', () => {
  const rng = createRng(1);
  assert.deepEqual(rng.draws(), {}, 'no stream, no draws');
  const blow = rng.stream('blow');
  blow.next(); blow.float(); blow.int(6);
  rng.stream('echo').next();
  assert.deepEqual(rng.draws(), { blow: 3, echo: 1 });
  assert.equal(blow.draws, 3);
  rng.stream('blow'); // fetching a stream is not a draw
  rng.snapshot();
  assert.deepEqual(rng.draws(), { blow: 3, echo: 1 });
  assert.equal(rng.stream('spell').draws, 0, 'a new stream starts at zero');
});

test('6. snapshot and restore: a generator continues exactly as the original did', () => {
  const rng = createRng(777);
  const blow = rng.stream('blow');
  take(blow, 10);
  take(rng.stream('echo'), 3);
  const snap = rng.snapshot();
  const json = JSON.parse(JSON.stringify(snap)); // the snapshot is plain data
  const expectBlow = take(blow, 25);
  const expectEcho = take(rng.stream('echo'), 25);
  const drawsAfter = rng.draws();

  take(rng.stream('late'), 5); // a stream created after the snapshot
  rng.restore(json);
  assert.deepEqual(rng.draws(), { blow: 10, echo: 3 }, 'draw counts are restored, the late stream is gone');
  assert.deepEqual(take(rng.stream('blow'), 25), expectBlow);
  assert.deepEqual(take(rng.stream('echo'), 25), expectEcho);
  assert.deepEqual(rng.draws(), drawsAfter);
  // a discarded stream starts fresh when used again
  assert.deepEqual(take(rng.stream('late'), 5), take(createRng(777).stream('late'), 5));

  // per-stream: restore one stream only
  const s = createRng(5).stream('blow');
  take(s, 4);
  const one = s.snapshot();
  const next = take(s, 6);
  s.restore(one);
  assert.deepEqual(take(s, 6), next);
  assert.equal(s.draws, 10);
  // a snapshot is a copy, not a view: drawing after taking it leaves it untouched, and restoring twice works
  const frozen = JSON.stringify(one);
  take(s, 3);
  assert.equal(JSON.stringify(one), frozen);
  s.restore(one);
  assert.deepEqual(take(s, 6), next);
  s.restore(one);
  assert.deepEqual(take(s, 6), next);
});

test('7. invalid input is rejected predictably', () => {
  for (const bad of [undefined, null, '1', 1.5, NaN, Infinity, 2 ** 53, {}, [], true]) {
    assert.throws(() => createRng(bad), TypeError, `seed ${String(bad)}`);
  }
  assert.doesNotThrow(() => createRng(0));
  assert.doesNotThrow(() => createRng(Number.MAX_SAFE_INTEGER));
  assert.doesNotThrow(() => createRng(-Number.MAX_SAFE_INTEGER));
  const rng = createRng(1);
  for (const bad of [undefined, null, '', 5, {}, 'x'.repeat(65)]) assert.throws(() => rng.stream(bad), TypeError, `name ${String(bad)}`);
  assert.doesNotThrow(() => rng.stream('x'.repeat(64)));
  const s = rng.stream('blow');
  for (const bad of [0, -1, 1.5, NaN, 2 ** 32 + 1, '3']) assert.throws(() => s.int(bad), RangeError, `int(${String(bad)})`);
  assert.equal(s.draws, 0, 'a rejected call draws nothing');
  // snapshots: wrong seed, wrong stream, malformed
  const other = createRng(2);
  assert.throws(() => rng.restore(other.snapshot()), TypeError, 'a snapshot of another seed');
  assert.throws(() => rng.restore(null), TypeError);
  assert.throws(() => rng.restore({ seed: 1 }), TypeError);
  const snap = rng.snapshot();
  assert.throws(() => rng.stream('other').restore(snap.streams[0]), TypeError, 'a snapshot of another stream');
  assert.throws(() => s.restore({ name: 'blow', state: [1, 2, 3], draws: 0 }), TypeError);
  assert.throws(() => s.restore({ name: 'blow', state: [0, 0, 0, 0], draws: 0 }), RangeError, 'the all-zero state');
  assert.throws(() => s.restore({ name: 'blow', state: [1, 2, 3, -4], draws: 0 }), TypeError);
  assert.throws(() => s.restore({ name: 'blow', state: [1, 2, 3, 4], draws: -1 }), TypeError);
});

test('8. no global state and no ambient randomness', () => {
  // a generator is its own: two instances share nothing
  const a = createRng(8);
  const b = createRng(8);
  take(a.stream('blow'), 100);
  assert.deepEqual(b.draws(), {});
  assert.deepEqual(take(b.stream('blow'), 3), take(createRng(8).stream('blow'), 3));
  // Math.random is neither read nor perturbed
  const real = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return 0.5; };
  try {
    const r = createRng(3);
    take(r.stream('blow'), 50); r.stream('echo').float(); r.snapshot(); r.restore(r.snapshot());
  } finally {
    Math.random = real;
  }
  assert.equal(calls, 0, 'Math.random was never called');
  for (const f of ['src/rng.js', 'src/blowOutcomes.js']) {
    const code = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /Math\.random|Date\.now|crypto\./, `${f} reads no ambient source`);
  }
});
