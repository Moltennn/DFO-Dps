//! The R8 `theory` command, end to end against the real JS CLI.
//!
//! Every case runs `bin/dfo-dps.js theory ...` and the Rust binary with the same arguments under one temp
//! `DAGGER_USER_DATA` root, then compares stdout byte for byte (text and `--json`). The JS is the oracle: a port that
//! drifts from `src/cli.js:1806-2054` fails here. The card's renderer is pure data in and strings out, so this file
//! pins the whole card: the header, the push stages, the caps, both curves, the three Firmament tables, the frontier,
//! the long-blade table, the result card and every `--json` row.
//!
//! Nothing reads a real save or a real `SPELLS.STD` (the theory card reads neither): every case sets `DAGGER_USER_DATA`
//! to its own empty temp root, so neither CLI can see the player's launcher config or game files.
//!
//! LIMITS (deliberate, not parity claims):
//!   - a reference-foe target (`--target tough|soft|human`) crashes the JS card on `r.health.toLocaleString()`; this CLI
//!     refuses it with exit 2 and one message instead of reproducing a crash, so no case compares that shape.
//!   - the JS writes its `>38% damage` warning to stderr; the output-only cases do not pin it (the obsolete
//!     `--gear-lines`/`--line-points` note is compared, stderr included, by its own test).
//!   - `weapons`/`skills` (the same page family) remain unported and are not touched here.
//!
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::{js_root as js, rust_root as rust, temp_root};

use std::fs;
use std::path::Path;

/// A success case: both exit 0 and stdout matches byte for byte.
fn same(args: &[&str], root: &Path) {
    let want = js(args, root);
    let got = rust(args, root);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    assert_eq!(
        got.status.code(),
        want.status.code(),
        "rust {args:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    let (got, want) = (
        String::from_utf8_lossy(&got.stdout),
        String::from_utf8_lossy(&want.stdout),
    );
    if got != want {
        let lines: Vec<(&str, &str)> = got.lines().zip(want.lines()).collect();
        let at = lines.iter().position(|(a, b)| a != b).unwrap_or(0);
        let from = at.saturating_sub(3);
        panic!(
            "stdout differs for {args:?} at line {} (lens {} vs {}):\nrust: {:#?}\njs:   {:#?}",
            at + 1,
            got.len(),
            want.len(),
            &got.lines().collect::<Vec<_>>()[from..(at + 6).min(got.lines().count())],
            &want.lines().collect::<Vec<_>>()[from..(at + 6).min(want.lines().count())],
        );
    }
}

#[test]
fn the_default_card_matches_the_js() {
    let root = temp_root("default");
    same(&["theory"], &root);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_json_document_matches_the_js() {
    let root = temp_root("json");
    same(&["theory", "--json"], &root);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn a_boss_target_matches_the_js() {
    let root = temp_root("boss");
    same(&["theory", "--target", "boss", "--health", "9000"], &root);
    same(
        &["theory", "--target", "boss", "--health", "9000", "--json"],
        &root,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_firmament_preset_matches_the_js() {
    let root = temp_root("firmament");
    same(
        &[
            "theory",
            "--firmament",
            "--blade",
            "118",
            "--race",
            "redguard",
        ],
        &root,
    );
    same(
        &[
            "theory",
            "--firmament",
            "--blade",
            "118",
            "--race",
            "redguard",
            "--json",
        ],
        &root,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn explicit_gear_and_damage_match_the_js() {
    let root = temp_root("gear");
    same(
        &[
            "theory",
            "--gear-lb",
            "200",
            "--gear-cs",
            "300",
            "--damage-pct",
            "38",
        ],
        &root,
    );
    same(
        &[
            "theory",
            "--gear-lb",
            "200",
            "--gear-cs",
            "300",
            "--damage-pct",
            "38",
            "--json",
        ],
        &root,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_gate_spelling_and_a_preset_remap_match_the_js() {
    let root = temp_root("remap");
    same(&["theory", "--target", "ARMOURED"], &root);
    same(&["theory", "--target", "gate", "--players", "3"], &root);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_obsolete_gear_flags_print_the_js_note() {
    let root = temp_root("obsolete");
    for args in [
        &["theory", "--gear-lines", "5"][..],
        &["theory", "--line-points", "5"][..],
        &["theory", "--gear-lines", "5", "--line-points", "5"][..],
    ] {
        let want = js(args, &root);
        let got = rust(args, &root);
        assert_eq!(
            want.status.code(),
            Some(0),
            "js {args:?}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        assert_eq!(
            got.status.code(),
            want.status.code(),
            "rust {args:?}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert_eq!(got.stdout, want.stdout, "stdout differs for {args:?}");
        assert_eq!(
            String::from_utf8_lossy(&got.stderr),
            String::from_utf8_lossy(&want.stderr),
            "stderr differs for {args:?}"
        );
        assert!(
            String::from_utf8_lossy(&got.stderr)
                .contains("--gear-lines / --line-points are obsolete"),
            "the JS note is printed for {args:?}"
        );
    }
    // Every other command keeps the refusal by name (the JS accepts and ignores the pair there).
    let refused = rust(&["build", "--gear-lines", "5"], &root);
    assert_eq!(refused.status.code(), Some(2));
    assert!(refused.stdout.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&refused.stderr),
        "--gear-lines is not read by build; only theory prints the obsolete note\n"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_shipped_build_moves_the_cap_sheet_and_the_formula_cap_row() {
    // `src/cli.js:1918,1963,1971,1998,2063`: under `14631` the formula-cap row is skipped and the gear row of the cap
    // sheet says it is flat; `14512` is the frozen table. Both sides are compared byte for byte.
    let root = temp_root("game-build");
    for extra in [&["--json"][..], &[][..]] {
        for build in ["14631", "14512"] {
            let mut args = vec!["theory", "--game-build", build];
            args.extend_from_slice(extra);
            same(&args, &root);
        }
        // No flag is an explicit 14631 run, so the default is the live sheet.
        same(&["theory"], &root);
        same(&["theory", "--game-build", "14631"], &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn a_reference_foe_is_refused_instead_of_crashing() {
    let root = temp_root("foe");
    let got = rust(&["theory", "--target", "tough"], &root);
    assert_eq!(got.status.code(), Some(2));
    let want = js(&["theory", "--target", "tough"], &root);
    assert_eq!(
        want.status.code(),
        Some(1),
        "the JS card crashes on a reference foe"
    );
    assert!(String::from_utf8_lossy(&want.stderr).contains("toLocaleString"));
    assert!(got.stdout.is_empty(), "a refusal must print no card");
    assert!(String::from_utf8_lossy(&got.stderr).contains("boss or gate target"));
    fs::remove_dir_all(&root).expect("cleanup");
}
