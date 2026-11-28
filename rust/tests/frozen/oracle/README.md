# dfo-core frozen JS oracle answers

The JSON-free differential tests `tests/planner_mutants.rs`, `tests/probe.rs` and `tests/sidebar.rs` replay the answers of
`rust/dfo-core/tests/{planner,probe,sidebar}_oracle.mjs`. Those scripts drove the real project (`src/`, `vendor/` and the
tools) while it existed; their stdout is stored here so the Rust suite needs no Node.

```
oracle <name> <script> <gzip-sha256> <raw-sha256> <raw-bytes> <lines>
```

One `<name>.txt.gz` per oracle: gzip -9 of the script's stdout (nothing added), and `MANIFEST` pins the gzip bytes, the
decoded bytes, the decoded size and the non-empty line count. `tests/common/oracle.rs` reads one through
`oracle_lines(name, script)`, which verifies all four before returning a line; a missing file, a corrupt gzip, a digest
or count mismatch and a short answer are hard failures, never skips.

## Re-record and compare while the JS exists

```sh
node tools/oracle-freeze.mjs            # write this directory from the live scripts
node tools/oracle-freeze.mjs --check    # compare: fails if a recorded answer would differ
node tools/gate.mjs oracle              # the same check as a gate step (the rust gate runs it too)
node tools/gate.mjs oracle --write      # the gate's spelling of a re-record
```

## Run the tests against the live JS instead

`DFO_CORE_ORACLE=live cargo test -p dfo-core` spawns each script again and compares against the port in the ordinary way
(a missing `node` is a failure, not a skip). The gate's `--live` does this for the whole suite. `DFO_CORE_ORACLE=frozen`
(or unset) is the default replay; any other value fails loudly rather than silently choosing a tier.

## Evidence class

A frozen answer proves what the JS printed when it was recorded (parity with that revision), not what the game does. It
cannot be re-derived once `src/`, `vendor/` and the scripts are gone; until then `--check` is what keeps it honest.
