# dfo-core (Rust), milestone R1

A Cargo workspace with one library crate, `dfo-core`: edition 2021, **no dependencies** (std only).
It is a bit-exact port of a few pure rule modules of the JS in `../src/`. The JS and the vendored
upstream (`../vendor/upstream/a3eb1605`) stay the source of truth; this crate changes no mechanic.
Nothing here is wired into the CLI or the reports.

## Scope of R1

Pure functions and small state machines only: plain numbers in, numbers out, no `fs`, no clock,
no ambient randomness. Rounding is kept as the JS has it (`floor`/`trunc`/`fround`/half-to-even,
`Math.min/max` with JS NaN and `-0` behaviour, JS `%`). `f64` is the JS number.

| Module | JS source | Rust file |
|---|---|---|
| `round`: `unity_round`, `fround`, `trunc`, `floor`, JS `%`/`min`/`max`/clamp, `ToUint32`/`ToInt32`, `imul`, `Number(x)\|\|d` | `src/model.js:49-63` (+ the JS builtins the other modules use) | `dfo-core/src/round.rs` |
| `rng`: FNV-1a, SplitMix32, xoshiro128**, named streams, `float`/`int`, snapshot/restore, seed folding, validation | `src/rng.js:1-182` (all of it) | `dfo-core/src/rng.rs` |
| `damage`: `damage_modifier`, `pcaao_damage_modifier`, `apply_pct`, `carried_pct`, `carried_firmament`, `condition_multiplier` | `src/model.js:171-173`, `:182-184`, `:632-634`, `:642`, `:646`, `:651-674` | `dfo-core/src/damage.rs` |
| `allowance`: `ref_of`, `allowance_law`, `allowance_spec`, `claim_streams`, `simulate_allowance`, `steady_state`, `run_allowance` | `src/allowance.js:34-296` (whole file; it has no imports) | `dfo-core/src/allowance.rs` |
| `relay_claim`: the claim engine (constructor, `claim`, `summary`) | `src/relayClaim.js:29-283` | `dfo-core/src/relay_claim.rs` |

Boundaries with JS (also in the module docs): stream names are `&[u16]` (UTF-16 units, so lone
surrogates work); a JS value that is not a number is modelled as `NaN`; JS `TypeError`/`RangeError`
are `Result` errors; `perClaimAt` is a closure; counters are `u64`; `Rng::draws` is in creation
order (JS `draws()` is an object, so integer-like names such as `"10"` would sort first there).

### Not ported in R1, on purpose

- `swingFrameSeconds`, `swingHeft`, `swingHandling` (`src/model.js:381-399`): they read the `SWING_*`
  tables of `src/data.js`; they belong with the data milestone.
- `classicStrength` (`src/model.js:179`): module-private and a two-way switch over the two ported
  functions; it moves with the model.
- `rng.js` `_initialStateForTests` is ported as `rng::initial_state` (and tested through it);
  `fnv1a`/`splitmix32` are module-private in JS and are ported as pub helpers (checked through the
  initial states and against the public FNV-1a test vectors).
- Everything else in `src/` (target, model analysis, blow outcomes, cws, fight loops, relay fight,
  objectives, CLI, reports): see the plan below.

## Run

```
node tools/rust-vectors.mjs        # from the repository root: writes rust/tests/vectors/*.txt
cd rust && cargo test
cd rust && cargo fmt --check
cd rust && cargo clippy --all-targets -- -D warnings
```

The vector tests **fail** (they never skip) if a vector file is missing, lacks its header, or has
fewer cases of a kind than a stated floor. The vector files are generated, about 7 MB, and not
committed (`rust/.gitignore`): run the generator first on a fresh checkout.

## Vectors: what is proven

`tools/rust-vectors.mjs` imports the real JS modules and writes one text file per module
(`round`, `rng`, `damage`, `allowance`, `relay_claim`). Format: one case per line, `kind token...`,
f64 as 16 hex digits of IEEE bits, integers decimal, `=>` between inputs and outputs; documented in
the generator's header. Output is deterministic (fixed local PRNG, no `Math.random`, no clock;
a second run is byte-identical). `applyPct`, `carriedPct`, `carriedFirmament` are not exported by
`src/model.js`, so the generator cuts their exact source text out of the file and evaluates it
(it fails loudly if the text moves).

Proven, and only this: for the inputs in the vector files (seeded sweeps plus the hand-picked
edge cases listed in the generator) the Rust output equals the JS output bit for bit, NaN
compared as "both NaN" (JS NaN payloads are not meaningful). That covers ties at .5, `-0`,
`1e-9` boundary of `apply_pct`, values near 2^53, negative and limit seeds, multi-byte, astral and
lone-surrogate names, 0- and 64-unit names, 10 000-draw sequences, snapshot/restore traces,
shield/token/bucket/health clipping and kills in the claim engine.

Not proven: any input outside the vectors; the all-zero-state fix of `rng` (a fixed point no
(seed, name) is known to reach, so it is unreachable by vector); stream names that are not
valid Unicode inside `allowance` (names never reach a number); behaviour of the JS when given
non-number arguments (not representable).

## Plan for R2 and later (a plan, not done)

Order chosen by dependency; each step ships only with vectors (or the upstream goldens) that fail first.

1. **R2, data tables.** The main blocker: the model reads `src/data.js` and the vendored upstream
   tables (`vendor/upstream/a3eb1605/src/...`), which are JS modules. Recommended: generate Rust
   `const` tables with a generator in the same style as `tools/rust-vectors.mjs` (import the real
   JS, emit `rust/dfo-core/src/generated/*.rs`, with a header and a `--check` mode that fails if
   the committed output is stale). Why: no JS runtime and no parser at run time, tables are
   reviewable, and the vendor hash check already pins the source. Reading the JS at run time would
   need a JS interpreter or an ad-hoc parser; a second hand-copy would break "one source of truth".
   Then port `swing*` (needs the `SWING_*` tables) and `classicStrength`.
2. **R3, target** (`src/target.js`): resistances, parts, `makeTarget`; pure given R2 tables.
3. **R4, blow outcomes and rolls** (`src/blowOutcomes.js`, the roll/crit/dodge stages of
   `src/model.js`): the first place `rng` streams and `damage` meet; differential against the JS
   with the same seeds (the JS `rng.js` is the generator, so sequences already match).
4. **R5, model analysis** (`src/model.js` `analyze`, gear lines `src/gearLines.js`, enchants,
   dual wield): the biggest module; split by stage with a vector set per stage.
5. **R6, fight loops** (`src/fight.js`, `src/simulateFight.js`, `src/cws.js`,
   `src/durability.js`): stateful, depend on R3-R5 and on `rng` traces.
6. **R7, relay fight and objectives** (`src/relay*.js`, objectives): depend on R6 plus the
   already ported `allowance`/`relay_claim`.
7. **R8, CLI and reports** (`src/cli.js`, `src/report.js`, `src/graph.js`): I/O last, once the
   core is proven; keep it a thin layer over the library.

Open choices for the maintainer: whether the (6.8 MB) vector files are committed or regenerated in
CI, and whether `rust/` gets its own CI job (`cargo test`, `fmt --check`, `clippy -D warnings`).
