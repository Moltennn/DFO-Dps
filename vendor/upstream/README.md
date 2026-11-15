# Vendored upstream client (verification oracle)

This directory holds the parts of the DFO Online client
(`Lattymoy/daggerfall-js-source`) that the verification harness measures
against. It is **not** used by the simulator at runtime; only `test/` and
`tools/` read it.

- `src/systems/bossTraits.js` and `src/combat/twoHands/handsLaw.js` are the modules the simulator reads at
  runtime (`src/bossTraits.js` and `src/dualWield.js` reuse the trait selector, `bossStrike` and the dual-wield
  law); everything else is for `test/` and `tools/` only.
- Pinned commit: `a3eb1605ea1dc391b691fe314377458a7e63e483` (2026-11-02, MIT).
- Licence: `a3eb1605/LICENSE.upstream` (verbatim, plus upstream's README).
- Every file's upstream path, hash and size: `a3eb1605/MANIFEST.json`.
- Every cut edge, why it is cut and what it must export:
  `a3eb1605/STUBS.md`.
- How the subset was chosen, how to re-pin it, and the parity gate:
  [`../../docs/SOURCES.md`](../../docs/SOURCES.md).

**Do not edit anything under `a3eb1605/` by hand.** The hashes are checked by
`npm run test:vendor` and `npm run vendor:verify`. To add a module, remove it
from the cut list in `tools/vendor-upstream.mjs` and regenerate:

```bash
node tools/vendor-upstream.mjs --from /path/to/daggerfall-js-source
```
