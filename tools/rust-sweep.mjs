/*
 * tools/rust-sweep.mjs - which golden-vector cases a generator wrote by hand, and which came out of a seeded sweep.
 *
 * `tools/vector-freeze.mjs` must keep every hand-written case (the boundary probes: an exact edge, an error row, a
 * case written one line at a time) and may drop some of a seeded sweep. It cannot guess which is which, so the
 * generator records it: `sweep()` wraps the indexed loops (`for (let i = 0; i < N; i++)`), and every `Out.add` outside
 * one is hand-written and written to `<module>.hand`.
 *
 * A loop over a literal list (`for (const x of [0, 1, NaN])`) is NOT wrapped: those cases are hand-picked probes and
 * stay whole.
 */

let sweepDepth = 0;

/** Run a seeded, index-driven sweep: the cases it writes are `sampled`, never hand-written. */
export function sweep(fn) {
  sweepDepth++;
  try {
    return fn();
  } finally {
    sweepDepth--;
  }
}

/** True while a seeded sweep is writing (so `Out.add` does not record the case as hand-written). */
export function inSweep() {
  return sweepDepth > 0;
}
