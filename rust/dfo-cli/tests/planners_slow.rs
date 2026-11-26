//! The two SAMPLED planner commands, opt-in because they are minutes each: `loadout`/`real-dps` replan every weapon
//! template and then walk a purse per row. Everything else about `--game-build` is in `planners.rs`; this file is the
//! pair that would otherwise dominate the gate.
//!
//! Run it with `PLANNERS_SLOW=1 cargo test -p dfo-cli --test planners_slow` (the Rust gate passes that variable when
//! `--full` is given). Without it every test here returns at once and reports itself ignored in its name, so the expensive
//! coverage exists but never runs in the default gate.
//!
//! Same contract as `planners.rs`: byte-identical stdout and page against the JS at both builds, one run per command line
//! per CLI, and the two builds must differ.

mod common;

use common::{js_root as js, rust_root as rust, take_page, temp_root};

use std::fs;
use std::path::Path;

fn enabled() -> bool {
    std::env::var("PLANNERS_SLOW").is_ok_and(|v| v == "1")
}

/// Run one command line on both CLIs once, comparing stdout and page. Returns the JS page so the caller can compare
/// builds from the same two runs.
fn same(args: &[&str], root: &Path, page: &Path) -> Vec<u8> {
    let want = js(args, root);
    let want_page = take_page(page);
    let got = rust(args, root);
    let got_page = take_page(page);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
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
    assert_eq!(got_page, want_page, "the page differs for {args:?}");
    want_page
}

fn moves_pages(args: &[&str], root: &Path, primary: &Path) {
    let stem = primary
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("page");
    let mut pages = Vec::new();
    for (build, tag) in [("14512", "cut"), ("14631", "drift")] {
        let page = primary.with_file_name(format!("{stem}-{tag}.html"));
        let mut full = args.to_vec();
        let out = page.to_str().unwrap();
        full.extend_from_slice(&["--out", out, "--game-build", build]);
        pages.push(same(&full, root, &page));
    }
    assert_ne!(pages[0], pages[1], "14631 must move the page for {args:?}");
}

#[test]
fn loadout_uncapped_takes_the_shipped_build() {
    if !enabled() {
        return;
    }
    let root = temp_root("loadout-uncapped");
    moves_pages(
        &["loadout", "--uncapped"],
        &root,
        &root.join("primary.html"),
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn loadout_cap_aware_takes_the_shipped_build() {
    if !enabled() {
        return;
    }
    let root = temp_root("loadout-cap");
    moves_pages(
        &["loadout", "--cap-aware", "--encounter", "breach"],
        &root,
        &root.join("primary.html"),
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn real_dps_takes_the_shipped_build() {
    if !enabled() {
        return;
    }
    // `real-dps` is the alias of `loadout` (the same branch), so one mode is enough to pin that it reads the flag.
    let root = temp_root("real-dps");
    moves_pages(
        &["real-dps", "--uncapped"],
        &root,
        &root.join("primary.html"),
    );
    fs::remove_dir_all(&root).expect("cleanup");
}
