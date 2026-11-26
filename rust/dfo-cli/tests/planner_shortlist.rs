//! `loadout --shortlist --game-build 14631`, DIFFERENTIALLY against the real JS CLI - the one planner branch no test
//! covered at a shipped build: `loadoutShortlist.js` ~32/~47 and `loadout_shortlist.rs` ~221/~250 forward and key on the
//! build, and before this file nothing exercised either at `14631`.
//!
//! The shortlist is the slowest planner (it samples 1,000 fights per row and re-plans each candidate's chain), so this is
//! one case per build at the smallest legal settings: `--shortlist 1 --max-blows 1`. Both builds are compared byte for
//! byte, and they must differ - a flag that is accepted but changes nothing would pass a plain parity case.
//!
//! A missing `node` panics rather than skips: a skipped differential proves nothing.

mod common;

use common::{js_root as js, rust_root as rust, take_page, temp_root};

use std::fs;
use std::path::Path;

/// Both CLIs on the same arguments under one temp root: same exit code and byte-identical stdout/stderr.
fn same(args: &[&str], root: &Path) -> Vec<u8> {
    let want = js(args, root);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    let got = rust(args, root);
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust {args:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&got.stdout),
        String::from_utf8_lossy(&want.stdout),
        "stdout differs for {args:?}"
    );
    assert_eq!(
        String::from_utf8_lossy(&got.stderr),
        String::from_utf8_lossy(&want.stderr),
        "stderr differs for {args:?}"
    );
    got.stdout
}

#[test]
fn the_uncapped_shortlist_moves_with_the_shipped_build() {
    let root = temp_root("shortlist-game-build");
    let base = ["loadout", "--shortlist", "1", "--max-blows", "1", "--json"];
    let mut drift = base.to_vec();
    drift.extend_from_slice(&["--game-build", "14631"]);
    let drift_text = same(&drift, &root);
    let mut cut = base.to_vec();
    cut.extend_from_slice(&["--game-build", "14512"]);
    let cut_text = same(&cut, &root);
    // The default is the live build: the 14512 rows are the ones that move.
    let plain = same(&base, &root);
    assert_eq!(
        String::from_utf8_lossy(&plain),
        String::from_utf8_lossy(&drift_text),
        "no --game-build is 14631"
    );
    assert_ne!(
        String::from_utf8_lossy(&drift_text),
        String::from_utf8_lossy(&cut_text),
        "14631 must move the shortlist"
    );
    // The sampled column alone: `rank_builds`' scenario carries the build (`loadout_shortlist.rs:250`), and a whole-stdout
    // comparison would pass on the deterministic columns alone. Pin the sampled `value` it ranks the row by.
    let value_of = |text: &[u8], build: &str| -> f64 {
        let doc: serde_json::Value =
            serde_json::from_slice(text).expect("the shortlist --json document parses");
        let row = &doc.as_array().expect("one ranking per mode")[0]["rows"][0];
        assert_eq!(row["deterministicRank"], 1, "{build}");
        row["value"]
            .as_f64()
            .unwrap_or_else(|| panic!("no sampled value for {build}"))
    };
    let cut_value = value_of(&cut_text, "14512");
    let drift_value = value_of(&drift_text, "14631");
    assert_ne!(
        cut_value, drift_value,
        "the sampled ranking must be priced at the caller's build (14512 gives {cut_value}, 14631 {drift_value})"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

/// `enchant-plan --all`: both matrices, which are `planMatrix` and (through it) `bestWeaponForFamily`. No other test runs
/// `--all` at a shipped build, so either forwarding site could lose the build unnoticed. The `--all` branch writes its page
/// even with `--json` and the writer is create-only, so each run names its own `--out`.
#[test]
fn the_all_matrices_move_with_the_shipped_build() {
    let root = temp_root("all-game-build");
    let run = |tag: &str, build: Option<&str>| {
        let page = root.join(format!("{tag}.html"));
        let mut args = vec![
            "enchant-plan",
            "--all",
            "--json",
            "--out",
            page.to_str().expect("a UTF-8 page path"),
        ];
        if let Some(build) = build {
            args.extend_from_slice(&["--game-build", build]);
        }
        let want = js(&args, &root);
        assert_eq!(
            want.status.code(),
            Some(0),
            "js {args:?}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        // The writer is create-only: drop the JS page so the Rust run writes the same path.
        take_page(&page);
        let got = rust(&args, &root);
        assert_eq!(
            got.status.code(),
            Some(0),
            "rust {args:?}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&got.stdout),
            String::from_utf8_lossy(&want.stdout),
            "stdout differs for {args:?}"
        );
        take_page(&page);
        got.stdout
    };
    let drift_text = run("drift", Some("14631"));
    let cut_text = run("cut", Some("14512"));
    let plain = run("plain", None);
    assert_eq!(
        String::from_utf8_lossy(&plain),
        String::from_utf8_lossy(&drift_text),
        "no --game-build is 14631"
    );
    assert_ne!(
        String::from_utf8_lossy(&drift_text),
        String::from_utf8_lossy(&cut_text),
        "14631 must move the matrices"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}
