# dfo-core frozen golden vectors

A **deterministic sample** of the golden vectors `node tools/rust-vectors.mjs` generates into `rust/tests/vectors/`.
Those full files are 3.78 GB of text (3.52 GiB, 144 MB gzipped) and are not committed; they are archived outside the
repository, under `~/.local/share/dfo-tools/vectors-archive/` (`DFO_ARCHIVE_DIR` moves it). The archive made from the
generators these vectors match, with the `.hand` files and the `.spellbook` stamp beside the `.txt` ones, is:

```
dfo-vectors-full-2026-11-28-09-35-58.tar.gz
sha256 b2fd893c4716ca6c8a138ca26f69ecfd14058cecb0b3b3205d98ddcd0d197c93
```

`rust/dfo-core/tests/common/mod.rs` reads this directory. Set `DFO_VECTORS_DIR` to read the full generated set instead
(the opt-in comparison tier), or `DFO_FROZEN_DIR` to read another copy of a sample.

`oracle/` beside this file is a different kind of answer: the frozen stdout of the three dfo-core JavaScript oracles
(`planner_oracle.mjs`, `probe_oracle.mjs`, `sidebar_oracle.mjs`), with its own `MANIFEST` and README. `tests/common/oracle.rs`
replays it; it is not a golden vector module and the manifest below does not name it.

## What is here

One `<module>.txt.gz` per module (gzip -9, the same text format the generators write), plus `MANIFEST`:

```
module <name> <gzip-sha256> <raw-sha256> <raw-bytes> <cases>
kind   <name> <kind> kept/total <hand-picked|sampled>
branch <name> <kind> <field> <values, comma-joined>
```

`module` pins the exact bytes and the case count. `kind` records how many cases of each family the sample keeps. `branch`
records, per kind and named option field, the values the sample keeps of the fields the tests branch on (the game build,
`core`, `dual`, `durability`, `rri`, `pair`, `relay`, `warded`, `carry`, and the combinations set together). The freeze
tool's `--audit` fails if the full set has a witnessed value of one of those fields that the sample lacks.

## How the sample is chosen

1. **Every hand-written case is kept.** `tools/rust-vectors.mjs` marks the lines it writes outside a seeded sweep
   (`tools/rust-sweep.mjs`'s `sweep()`), and records their indices in `<module>.hand`. Those are the boundary probes:
   an exact edge, an error or refusal row, the definitions a case refers to, the small families written one case at a
   time. A module without a `.hand` file is a hard failure, never "no hand cases".
2. **A seeded sweep is sampled by a stable hash, not a stride.** A case is kept when
   `sha256(kind \0 index-within-kind) < threshold`; the threshold is a per-kind share from the `PLAN` table in
   `tools/vector-freeze.mjs`. A stride (`index % N`) would keep exactly the indices whose option bits repeat with the
   period (`i & 1`, `i % 4`, ...), so whole branches would always fall on dropped indices; the hash has no such period.
   A case that carries a witnessed branch value the kept set is missing is added back, so no branch falls out.
3. `blow_outcomes` is special: one record per build (`build full fight sample_fight [carry sample_carry trace]`) is kept
   or dropped **as a unit**, so `sample_fight`/`trace` cannot outlive the tier they index. A witness keeps the whole
   record, and a hand-written record is kept whole. `merge_raw` names the last build, so the last `build` row is kept.
4. `real_build` addresses its `shortlist` cases by index, so that file is kept whole.

Sample totals: 31 modules, gzipped to about 29 MiB (a little under the 30 MiB cap the owner fixed); the freeze tool fails
outside the 20-30 MiB band. Regenerating it from unchanged inputs is byte-identical (`node tools/gate.mjs freeze`).

## What the sample does not claim

- It is a sample, not the full set: a sampled case is the JS's own answer, but the sample does not contain every answer.
- The branch record covers the option fields named above, read out of the encoded option records. It does not enumerate
  every value of every token (damages, seeds and ids are data, not branches).

## Regenerate

```sh
node tools/rust-vectors.mjs              # writes rust/tests/vectors/ (needs Node, ~4 min, synthetic spellbook)
node tools/vector-freeze.mjs             # rewrites this directory and MANIFEST, then audits it
node tools/vector-freeze.mjs --verify    # check the committed sample against its own MANIFEST
node tools/vector-freeze.mjs --check     # prove the sample is what the generators' output would produce now
node tools/vector-freeze.mjs --audit     # audit the committed sample: hand cases, branch values, size band
node tools/vector-freeze.mjs --archive   # write the full set (with the .hand files and .spellbook) to the archive
node tools/gate.mjs freeze               # verify, regenerate, and prove the sample is byte-identical
node tools/gate.mjs freeze --write       # rewrite the committed sample from the generated vectors and audit it
```

The generators stamp the book they were made with (`.spellbook` beside the vectors); the freeze tool refuses a set made
with `DFO_REAL_SPELLS=1`, because the sample ships the synthetic book only. Expected outputs are copied from the
generators' output byte for byte; nothing is recomputed, so a sampled case is still the JS's own answer.
