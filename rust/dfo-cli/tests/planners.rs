//! `--game-build` on the PLANNERS (imprints, weapons/skills, enchant-plan/gear-plan, loadout/real-dps), differentially
//! against the real JS CLI.
//!
//! `src/maxprofile.js`, `src/imprints.js`, `src/enchantPlan.js` and `src/realBuild.js` forge their own scenario instead
//! of taking `scenarioOf`, so before this step these commands refused `--game-build` by name. Each case below runs both
//! CLIs at `14512` and at `14631`, compares stdout and the page byte for byte, and asserts the two builds really differ:
//! a flag that is accepted but changes nothing would pass a plain parity case.
//!
//! COST. These commands re-price every weapon family, and the JS side is the slow half (imprints ~25 s, weapons ~25 s
//! per run, once the oracle cache answers). Each distinct command line therefore runs exactly ONCE per CLI: the page and
//! stdout of that run are what the comparison and the cross-build check both read. `planners_slow.rs` holds the two
//! sampled cases, which are opt-in because one of them simulates a thousand fights.
//!
//! Every case sets its own empty `DAGGER_USER_DATA` root, so neither CLI reads a save. A missing `node` panics rather
//! than skips: a skipped differential proves nothing.

mod common;

use common::{js_root as js, rust_root as rust, take_page, temp_root};

use std::fs;
use std::path::Path;

/// One run's bytes: exit code, stdout and the page it wrote (empty when the command writes none).
struct Run {
    code: Option<i32>,
    stdout: Vec<u8>,
    page: Vec<u8>,
    stderr: Vec<u8>,
}

/// Run one command line on both CLIs, with a private page file for each. No command line is run twice.
fn both(args: &[&str], root: &Path, page: &Path) -> (Run, Run) {
    let want = js(args, root);
    let want_page = if page.exists() {
        take_page(page)
    } else {
        Vec::new()
    };
    let got = rust(args, root);
    let got_page = if page.exists() {
        take_page(page)
    } else {
        Vec::new()
    };
    (
        Run {
            code: want.status.code(),
            stdout: want.stdout,
            page: want_page,
            stderr: want.stderr,
        },
        Run {
            code: got.status.code(),
            stdout: got.stdout,
            page: got_page,
            stderr: got.stderr,
        },
    )
}

/// A success case: both exit 0, stdout and page byte-identical.
fn same(args: &[&str], root: &Path, page: &Path) -> Run {
    let (want, got) = both(args, root, page);
    assert_eq!(
        want.code,
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    assert_eq!(
        got.code,
        want.code,
        "rust {args:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&got.stdout),
        String::from_utf8_lossy(&want.stdout),
        "stdout differs for {args:?}"
    );
    if got.page != want.page {
        let at = got
            .page
            .iter()
            .zip(&want.page)
            .position(|(a, b)| a != b)
            .unwrap_or(got.page.len().min(want.page.len()));
        let from = at.saturating_sub(120);
        panic!(
            "the page differs for {args:?} at byte {at} ({} vs {} bytes):\nrust: {:?}\njs:   {:?}",
            got.page.len(),
            want.page.len(),
            String::from_utf8_lossy(&got.page[from..(at + 200).min(got.page.len())]),
            String::from_utf8_lossy(&want.page[from..(at + 200).min(want.page.len())])
        );
    }
    // The JS run is returned so the caller can compare builds without a second run.
    Run {
        code: want.code,
        stdout: want.stdout,
        page: want.page,
        stderr: want.stderr,
    }
}

/// A page-writing command needs a distinct `--out` per run (the writer is create-only), so a pair of builds is spelled
/// out rather than through [`moves`]. `primary` only names the files. One run per build per CLI: the JS page of each
/// build is compared to the Rust page and to the other build's JS page.
fn moves_pages(args: &[&str], root: &Path, primary: &Path) {
    let stem = primary
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("page");
    let mut js_pages = Vec::new();
    for (build, tag) in [("14512", "cut"), ("14631", "drift")] {
        let page = primary.with_file_name(format!("{stem}-{tag}.html"));
        let mut full = args.to_vec();
        let out = page.to_str().unwrap();
        full.extend_from_slice(&["--out", out, "--game-build", build]);
        let want = same(&full, root, &page);
        js_pages.push(want.page);
    }
    assert_ne!(
        js_pages[0], js_pages[1],
        "14631 must move the page for {args:?}"
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
fn the_commands_without_a_planner_still_refuse_it() {
    let root = temp_root("refuses");
    for cmd in ["saves", "doctor", "firmament", "probe", "spell", "spells"] {
        same_usage(&[cmd, "--theory", "--game-build", "14631"], &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn imprints_takes_the_shipped_build() {
    let root = temp_root("imprints");
    // The full ranking at both builds, in one run each.
    moves_pages(&["imprints", "--json"], &root, &root.join("primary.html"));
    // The family filter reads the same priced hosts, one family instead of six (`--family` narrows, it does not re-price).
    moves_pages(
        &["imprints", "--json", "--family", "LongBlade"],
        &root,
        &root.join("family.html"),
    );
    // `--sort uncapped` re-orders by the uncapped price, which moves with the build.
    moves_pages(
        &[
            "imprints",
            "--json",
            "--family",
            "LongBlade",
            "--sort",
            "uncapped",
        ],
        &root,
        &root.join("uncapped.html"),
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn enchant_plan_takes_the_shipped_build() {
    let root = temp_root("enchant-plan");
    // The cap-aware mode (the default) and the uncapped mode are the branch's two matrices.
    moves_pages(
        &["enchant-plan", "--json"],
        &root,
        &root.join("primary.html"),
    );
    moves_pages(
        &["enchant-plan", "--json", "--uncapped"],
        &root,
        &root.join("uncapped.html"),
    );
    // `gear-plan` is the alias on one weapon, which exercises the single-plan arm rather than the matrix.
    moves_pages(
        &["gear-plan", "--json", "--weapon", "124"],
        &root,
        &root.join("weapon.html"),
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn weapons_and_skills_take_the_shipped_build() {
    let root = temp_root("weapons");
    moves_pages(&["weapons", "--json"], &root, &root.join("primary.html"));
    // `skills` is the alias command (its own entry in `GAME_BUILD_READERS`), and `--categories` condenses the rows.
    moves_pages(&["skills", "--json"], &root, &root.join("alias.html"));
    moves_pages(
        &["weapons", "--json", "--categories"],
        &root,
        &root.join("categories.html"),
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn weapons_page_takes_the_shipped_build() {
    let root = temp_root("weapons-page");
    moves_pages(&["weapons"], &root, &root.join("primary.html"));
    fs::remove_dir_all(&root).expect("cleanup");
}
