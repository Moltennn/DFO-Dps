//! `--game-build` on the PLANNERS (imprints, weapons/skills, enchant-plan/gear-plan, loadout/real-dps), differentially
//! against the real JS CLI.
//!
//! `src/maxprofile.js`, `src/imprints.js`, `src/enchantPlan.js` and `src/realBuild.js` forge their own scenario instead
//! of taking `scenarioOf`, so before this step these commands refused `--game-build` by name. Each case below runs both
//! CLIs at `14512` and at `14631` and compares stdout (and the page, where the command writes one) byte for byte, then
//! asserts that the two builds really differ: a flag that is accepted but changes nothing would pass a plain parity case.
//!
//! The 14631 law is the shipped build's (`dist:` evidence, cited in CHANGELOG-MECHANICS.md); parity with the JS is what
//! proves the port, not the game. Every case sets its own empty `DAGGER_USER_DATA` root, so neither CLI reads a save.
//! A missing `node` panics rather than skips: a skipped differential proves nothing.

mod common;

use common::{js_root as js, rust_root as rust, take_page, temp_root};

use std::fs;
use std::path::Path;
/// A page case: same exit code, byte-identical stdout and page.
fn same_page(args: &[&str], root: &Path, page: &Path) {
    let want = js(args, root);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    let want_page = take_page(page);
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
    let got_page = take_page(page);
    if got_page != want_page {
        let at = got_page
            .iter()
            .zip(&want_page)
            .position(|(a, b)| a != b)
            .unwrap_or(got_page.len().min(want_page.len()));
        let from = at.saturating_sub(120);
        panic!(
            "the page differs for {args:?} at byte {at} ({} vs {} bytes):\nrust: {:?}\njs:   {:?}",
            got_page.len(),
            want_page.len(),
            String::from_utf8_lossy(&got_page[from..(at + 200).min(got_page.len())]),
            String::from_utf8_lossy(&want_page[from..(at + 200).min(want_page.len())])
        );
    }
}

/// A page-writing command needs a distinct `--out` per run (the writer is create-only), so a pair of runs is spelled
/// out rather than through [`moves`]. `primary` only names the pair: `<stem>-cut.html` / `<stem>-drift.html`. The
/// pages are compared byte for byte, and the two pages must differ (stdout is only the `... page written:` line).
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
        same_page(&full, root, &page);
        // `take_page` removed it; read the JS page again for the cross-build check.
        let mut again = args.to_vec();
        let page2 = primary.with_file_name(format!("{stem}-{tag}-js.html"));
        again.extend_from_slice(&["--out", page2.to_str().unwrap(), "--game-build", build]);
        let want = js(&again, root);
        assert_eq!(want.status.code(), Some(0), "js {again:?}");
        pages.push(fs::read(&page2).expect("the JS page"));
    }
    assert_ne!(pages[0], pages[1], "14631 must move {args:?}");
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
fn imprints_takes_the_shipped_build() {
    let root = temp_root("imprints");
    moves_pages(&["imprints", "--json"], &root, &root.join("primary.html"));
    // The family filter picks the same rows from the same priced hosts.
    moves_pages(
        &["imprints", "--json", "--family", "LongBlade"],
        &root,
        &root.join("family.html"),
    );
    // `--sort uncapped` re-orders by the uncapped price, which also moves.
    let cut = js(
        &[
            "imprints",
            "--json",
            "--sort",
            "uncapped",
            "--game-build",
            "14512",
        ],
        &root,
    )
    .stdout;
    let drift = js(
        &[
            "imprints",
            "--json",
            "--sort",
            "uncapped",
            "--game-build",
            "14631",
        ],
        &root,
    )
    .stdout;
    assert_ne!(
        String::from_utf8_lossy(&cut),
        String::from_utf8_lossy(&drift),
        "14631 must move the uncapped order"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn enchant_plan_takes_the_shipped_build() {
    let root = temp_root("enchant-plan");
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
    moves_pages(&["weapons"], &root, &root.join("primary-weapons.html"));
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn loadout_and_real_dps_take_the_shipped_build() {
    let root = temp_root("loadout");
    // The loadout chain is the slow one (both tiers re-plan every template), so pin the uncapped tier in full, then
    // the cap-aware tier once, then `real-dps` (the same branch, `cmd === 'loadout' || cmd === 'real-dps'`).
    moves_pages(
        &["loadout", "--uncapped"],
        &root,
        &root.join("primary-loadout.html"),
    );
    moves_pages(
        &["loadout", "--cap-aware", "--encounter", "breach"],
        &root,
        &root.join("primary-loadout-cap.html"),
    );
    // The alias prices the same rows: a JSON run at each build proves it takes the flag and that it moves. (Its page
    // is the same writer `loadout` exercises above.) Each run needs its own `--out`: the writer is create-only.
    let drift_page = root.join("alias-drift.html");
    let alias = rust(
        &[
            "real-dps",
            "--uncapped",
            "--json",
            "--out",
            drift_page.to_str().unwrap(),
            "--game-build",
            "14631",
        ],
        &root,
    );
    assert_eq!(
        alias.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&alias.stderr)
    );
    let cut_page = root.join("alias-cut.html");
    let plain = rust(
        &[
            "real-dps",
            "--uncapped",
            "--json",
            "--out",
            cut_page.to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(
        plain.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&plain.stderr)
    );
    assert_ne!(
        String::from_utf8_lossy(&alias.stdout),
        String::from_utf8_lossy(&plain.stdout),
        "14631 must move real-dps"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_commands_without_a_planner_still_refuse_it() {
    let root = temp_root("refuses");
    for cmd in ["saves", "doctor", "firmament", "probe", "spell", "spells"] {
        same_usage(&[cmd, "--theory", "--game-build", "14631"], &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}
