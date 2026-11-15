/*
 * dfo-dps - seeded random streams (Stage 3.1).
 *
 * A small, explicit RNG for the stochastic evaluators. It is NOT upstream's generator: upstream draws from
 * `Math.random` (the blow's `rolls`, the loot powers' `_rand`, the spell path) and this project does not try to
 * reproduce that draw sequence (the stage record section 1.2). What it provides is what a reproducible
 * simulation needs:
 *
 *   - an explicit integer seed, never an ambient source (this file never touches Math.random, Date or crypto);
 *   - NAMED, independent streams ('blow', 'echo', 'spell', ...): a stream's sequence is a function of (seed, name)
 *     only, so extra draws in one stream, or creating streams in a different order, never change another's values;
 *   - snapshot / restore of every stream, and per-stream draw accounting.
 *
 * Generator: xoshiro128** (Blackman & Vigna, public domain), 128 bits of state, one 32-bit word per draw. A
 * stream's state is derived from the seed and the name with SplitMix32 over an FNV-1a hash of the name.
 * `float()` is `next() / 2^32`: a single draw, in [0, 1), at a resolution of 2^-32 (about 2.3e-10).
 *
 * No global state: every `createRng` call owns its streams.
 */

const MAX_NAME = 64;

const u32 = (x) => x >>> 0;
const rotl = (x, k) => u32((x << k) | (x >>> (32 - k)));

/** FNV-1a over the UTF-16 code units of `s`. */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** SplitMix32: advances `box.s` and returns the next output. */
function splitmix32(box) {
  box.s = u32(box.s + 0x9e3779b9);
  let z = box.s;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return u32(z ^ (z >>> 16));
}

function checkSeed(seed) {
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed)) {
    throw new TypeError(`rng: the seed must be a safe integer (got ${typeof seed === 'number' ? seed : typeof seed})`);
  }
  return seed;
}

function checkName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME) {
    throw new TypeError(`rng: a stream name must be a non-empty string of at most ${MAX_NAME} characters`);
  }
  return name;
}

/** The initial xoshiro128** state of stream `name` under `seed`: a pure function of the two. */
function initialState(seed, name) {
  // fold the 53-bit seed into two 32-bit halves (negative seeds keep their sign through the modulo)
  const lo = u32(seed % 4294967296);
  const hi = u32(Math.floor(seed / 4294967296));
  const box = { s: u32(lo ^ Math.imul(hi, 0x27d4eb2f) ^ fnv1a(name)) };
  const state = [splitmix32(box), splitmix32(box), splitmix32(box), splitmix32(box)];
  if (!(state[0] | state[1] | state[2] | state[3])) state[0] = 1; // the all-zero state is the generator's one fixed point
  return state;
}

class Stream {
  /** @param {string} name @param {number[]} state */
  constructor(name, state) {
    this.name = name;
    this._s = state;
    this._draws = 0;
  }

  /** The next 32-bit unsigned integer. One draw. */
  next() {
    const s = this._s;
    const result = u32(Math.imul(rotl(u32(Math.imul(s[1], 5)), 7), 9));
    const t = u32(s[1] << 9);
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    s[0] = u32(s[0]);
    s[1] = u32(s[1]);
    s[2] = u32(s[2]);
    s[3] = u32(s[3]);
    this._draws += 1;
    return result;
  }

  /** A float in [0, 1), `next() / 2^32`. One draw. */
  float() {
    return this.next() / 4294967296;
  }

  /** An integer in [0, n), `floor(float() * n)` (the game's `Random.Range(0, n)` shape). One draw. n in 1..2^32. */
  int(n) {
    if (!Number.isInteger(n) || n < 1 || n > 4294967296) throw new RangeError(`rng: int(n) needs an integer 1..2^32 (got ${n})`);
    return Math.floor(this.float() * n);
  }

  /** How many draws this stream has made (including before a restore: restoring sets it back). */
  get draws() {
    return this._draws;
  }

  /** A plain-data copy of this stream's state. */
  snapshot() {
    return { name: this.name, state: [...this._s], draws: this._draws };
  }

  /** Put this stream back to a snapshot of the SAME name. */
  restore(snap) {
    if (!snap || snap.name !== this.name || !Array.isArray(snap.state) || snap.state.length !== 4
      || !snap.state.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff)
      || !Number.isSafeInteger(snap.draws) || snap.draws < 0) {
      throw new TypeError(`rng: not a snapshot of stream "${this.name}"`);
    }
    if (!(snap.state[0] | snap.state[1] | snap.state[2] | snap.state[3])) throw new RangeError('rng: the all-zero state is invalid');
    this._s = [...snap.state];
    this._draws = snap.draws;
  }
}

/**
 * A set of independent named streams under one seed.
 *
 *   const rng = createRng(12345);
 *   rng.stream('blow').float();         // streams are created on first use
 *   rng.draws();                        // { blow: 1 }
 *   const snap = rng.snapshot();        // every stream that exists
 *   rng.restore(snap);                  // streams made after the snapshot are discarded (and start fresh when reused)
 */
export function createRng(seed) {
  checkSeed(seed);
  /** @type {Map<string, Stream>} */
  let streams = new Map();
  return {
    get seed() {
      return seed;
    },
    /** The named stream, created on first use. */
    stream(name) {
      checkName(name);
      let s = streams.get(name);
      if (!s) {
        s = new Stream(name, initialState(seed, name));
        streams.set(name, s);
      }
      return s;
    },
    /** Draws made so far, per stream (only streams that exist). */
    draws() {
      return Object.fromEntries([...streams].map(([name, s]) => [name, s.draws]));
    },
    /** A plain-data copy of every stream (JSON-safe). */
    snapshot() {
      return { seed, streams: [...streams.values()].map((s) => s.snapshot()) };
    },
    /** Replace every stream with the snapshot's. The snapshot must come from the same seed. */
    restore(snap) {
      if (!snap || snap.seed !== seed || !Array.isArray(snap.streams)) throw new TypeError('rng: not a snapshot of this generator (seed mismatch)');
      const next = new Map();
      for (const part of snap.streams) {
        checkName(part?.name);
        const s = new Stream(part.name, initialState(seed, part.name));
        s.restore(part);
        next.set(part.name, s);
      }
      streams = next;
    },
  };
}

/** The first state word of a stream, for tests that pin the derivation. */
export const _initialStateForTests = initialState;
