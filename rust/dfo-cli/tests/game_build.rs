//! The shipped-build selector `--game-build` (0.1.14631), differentially against the real JS CLI.
//!
//! `src/cli.js:383-384` validates the value globally; `:899-904` refuses it on every command whose card does not go
//! through `scenarioOf`; `:1918-1998,2063` move the theory cap sheet and its formula-cap row; `report.js:30,146-151`
//! thread it into the page. The model change behind it is checked case by case in `dfo-core/tests/model_blow.rs` and
//! the vector files; this file pins the CLI around it, byte for byte against the JS.
//!
//! Every case here sets its own empty `DAGGER_USER_DATA` root, so no save, launcher config or `SPELLS.STD` is read. A
//! missing `node` panics rather than skips: a skipped differential proves nothing.

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
    assert_eq!(
        String::from_utf8_lossy(&got.stdout),
        String::from_utf8_lossy(&want.stdout),
        "stdout differs for {args:?}"
    );
}

/// A usage error: both exit 2 with the same stderr and no stdout.
fn same_usage(args: &[&str], root: &Path) {
    let want = js(args, root);
    let got = rust(args, root);
    assert_eq!(
        want.status.code(),
        Some(2),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    assert_eq!(got.status.code(), Some(2), "rust {args:?}");
    assert_eq!(
        String::from_utf8_lossy(&got.stderr).trim_end(),
        String::from_utf8_lossy(&want.stderr).trim_end(),
        "stderr differs for {args:?}"
    );
    assert!(got.stdout.is_empty(), "no stdout for {args:?}");
}

#[test]
fn an_unknown_shipped_build_is_refused() {
    let root = temp_root("validate");
    same_usage(&["build", "--theory", "--game-build", "14513"], &root);
    same_usage(&["build", "--theory", "--game-build", ""], &root);
    same_usage(&["build", "--theory", "--game-build", "146310"], &root);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_validation_order_is_the_js_one() {
    // `validateFlags` runs `--shield` (`src/cli.js:375-379`) before `--game-build` (`:383-384`), and
    // `checkOutputFlags` runs the `--out` refusal (`:897-898`) before the per-command `--game-build` refusal
    // (`:901-903`). Both flags bad at once must name the JS's first one, not the second.
    let root = temp_root("order");
    same_usage(
        &[
            "build",
            "--theory",
            "--shield",
            "bogus",
            "--game-build",
            "bogus",
        ],
        &root,
    );
    same_usage(
        &["saves", "--out", "x.html", "--game-build", "14631"],
        &root,
    );
    // And the pair in the order the JS accepts: a good shield with a bad build is the build's message.
    same_usage(
        &[
            "build",
            "--theory",
            "--shield",
            "auto",
            "--game-build",
            "bogus",
        ],
        &root,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn a_gear_line_past_the_js_enumeration_limit_crashes_like_the_js() {
    // `model.js:1024` `Array.from({ length: gear.hi - gear.lo + 1 })` and `:1076` `Math.min(...plain)`: a hypothetical
    // `--gear-lb` makes the JS throw a `RangeError` (exit 1, stack on stderr). The port used to loop to an OOM; it now
    // raises the same `RangeError` (exit 1, message line only, as for every other JS crash here). Both are instant, so
    // the case is timeout-safe; every legal card (~1,620 blows) stays far below.
    let root = temp_root("range");
    for gear in ["1e16", "43000000000"] {
        // adds > 2^32-1: `Array.from`'s own length guard, deterministic.
        let args = [
            "build",
            "--theory",
            "--game-build",
            "14631",
            "--gear-lb",
            gear,
            "--json",
        ];
        let want = js(&args, &root);
        let got = rust(&args, &root);
        assert_eq!(
            want.status.code(),
            Some(1),
            "the JS crash for {gear}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        assert_eq!(
            got.status.code(),
            Some(1),
            "the same crash for {gear}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert!(
            String::from_utf8_lossy(&want.stderr).contains("RangeError: Invalid array length"),
            "js {gear}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&got.stderr).trim_end(),
            "RangeError: Invalid array length",
            "rust {gear} prints the message line only"
        );
        assert!(got.stdout.is_empty(), "no card for {gear}");
    }
    // adds below 2^32 but far past V8's spread limit: which `RangeError` the JS raises depends on the remaining stack
    // (`Array.from`'s own bound, the `push` loop, or `Math.min(...plain)`), so only the class is pinned here.
    for gear in ["1e8", "1e9"] {
        let args = [
            "build",
            "--theory",
            "--game-build",
            "14631",
            "--gear-lb",
            gear,
            "--json",
        ];
        let want = js(&args, &root);
        let got = rust(&args, &root);
        assert_eq!(want.status.code(), Some(1), "js {gear} crashes");
        assert_eq!(got.status.code(), Some(1), "rust {gear} crashes");
        assert!(
            String::from_utf8_lossy(&want.stderr).contains("RangeError"),
            "js {gear}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        let rust_err = String::from_utf8_lossy(&got.stderr);
        assert_eq!(
            rust_err.trim_end().lines().count(),
            1,
            "rust {gear} prints the message line only: {rust_err}"
        );
        assert!(
            rust_err.starts_with("RangeError: "),
            "rust {gear}: {rust_err}"
        );
        assert!(got.stdout.is_empty(), "no card for {gear}");
    }
    // The cut never enumerates the add, so the same flag prices as before (the 0.44% channel is a single number).
    let cut = rust(
        &[
            "build",
            "--theory",
            "--game-build",
            "14512",
            "--gear-lb",
            "1e8",
            "--json",
        ],
        &root,
    );
    assert_eq!(
        cut.status.code(),
        Some(0),
        "14512 prices the same gear line: {}",
        String::from_utf8_lossy(&cut.stderr)
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn a_legal_gear_heavy_card_still_prices() {
    // Below the JS's own enumeration limit the card is priced, and the port's guard must not narrow that: the largest
    // LEGAL split is 535 gear points (~1,620 blows), and 5000 points still price in seconds on both sides.
    let root = temp_root("legal");
    for gear in ["535", "5000"] {
        let args = [
            "build",
            "--theory",
            "--game-build",
            "14631",
            "--gear-lb",
            gear,
            "--json",
        ];
        let want = js(&args, &root);
        let got = rust(&args, &root);
        assert_eq!(want.status.code(), Some(0), "js {gear}");
        assert_eq!(got.status.code(), Some(0), "rust {gear}");
        assert_eq!(
            String::from_utf8_lossy(&got.stdout),
            String::from_utf8_lossy(&want.stdout),
            "stdout differs for gear {gear}"
        );
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_commands_that_price_a_card_read_it() {
    let root = temp_root("accepts");
    for cmd in [
        "build",
        "objective",
        "rank",
        "compare",
        "scale",
        "tradeoff",
        "theory",
        "enchant",
    ] {
        // `compare` has no `--json` document and needs a change to price (`src/cli.js:891-897, 2277-2304`);
        // `scale` needs one channel (`:2128-2203`).
        let extra: &[&str] = match cmd {
            "compare" => &["--stat", "strength=10"],
            "scale" => &["--json", "--stat", "strength"],
            _ => &["--json"],
        };
        for build in ["14631", "14512"] {
            let mut args = vec![cmd, "--theory", "--game-build", build];
            args.extend_from_slice(extra);
            same(&args, &root);
        }
    }
    // The default is an explicit 14512 run.
    same(&["build", "--theory", "--json"], &root);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn every_other_command_refuses_it_by_name() {
    let root = temp_root("refuses");
    // The planners (`weapons`, `skills`, `imprints`, `loadout`, `real-dps`, `enchant-plan`, `gear-plan`) take the flag
    // as of the planner step; only the commands that price neither a card nor a plan refuse it.
    for cmd in ["firmament", "probe", "saves", "doctor", "spells", "spell"] {
        same_usage(&[cmd, "--theory", "--game-build", "14631"], &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_theory_card_moves_with_the_build() {
    let root = temp_root("theory");
    same(&["theory", "--game-build", "14631", "--json"], &root);
    same(&["theory", "--game-build", "14512", "--json"], &root);
    same(&["theory", "--game-build", "14631"], &root);
    // The formula-cap row and the 320% captions follow the build, so the default card is the 14512 one.
    same(&["theory", "--json"], &root);
    same(&["theory"], &root);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_gear_heavy_card_moves_and_carries_the_add() {
    let root = temp_root("gear");
    let heavy = [
        "build",
        "--theory",
        "--gear-lb",
        "535",
        "--gear-cs",
        "370",
        "--damage-pct",
        "15",
    ];
    let drift: Vec<String> = heavy
        .iter()
        .map(|s| (*s).to_owned())
        .chain([
            "--game-build".to_owned(),
            "14631".to_owned(),
            "--json".to_owned(),
        ])
        .collect();
    let cut: Vec<String> = heavy
        .iter()
        .map(|s| (*s).to_owned())
        .chain([
            "--game-build".to_owned(),
            "14512".to_owned(),
            "--json".to_owned(),
        ])
        .collect();
    let plain: Vec<String> = heavy
        .iter()
        .map(|s| (*s).to_owned())
        .chain(["--json".to_owned()])
        .collect();
    let drift: Vec<&str> = drift.iter().map(String::as_str).collect();
    let cut: Vec<&str> = cut.iter().map(String::as_str).collect();
    let plain: Vec<&str> = plain.iter().map(String::as_str).collect();
    same(&drift, &root);
    same(&cut, &root);
    // The default card equals the explicit 14512 card, and the add is absent there.
    let plain_card = rust(&plain, &root);
    let pinned = rust(&cut, &root);
    assert_eq!(
        String::from_utf8_lossy(&plain_card.stdout),
        String::from_utf8_lossy(&pinned.stdout),
        "no --game-build is 14512"
    );
    assert!(!String::from_utf8_lossy(&plain_card.stdout).contains("gearAdd"));
    assert!(String::from_utf8_lossy(&rust(&drift, &root).stdout).contains("gearAdd"));
    fs::remove_dir_all(&root).expect("cleanup");
}
