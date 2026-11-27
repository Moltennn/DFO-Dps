//! The R8 `loadout` / `real-dps` command, end to end against the real JS CLI.
//!
//! Every success case runs `bin/dfo-dps.js loadout ...` and the Rust binary on the same arguments under one temp
//! `DAGGER_USER_DATA` root, then compares stdout, the exit code and (for the default report) the written page byte for
//! byte. The theory domain reads no save and no `SPELLS.STD` (the temp root has no launcher `config.json`, so the JS
//! `standardSpells()` default is an empty book, as `Spellbook::default()` is on the Rust side).
//!
//! Covered: both aliases, the shortlist card and its `--json` document (`stochastic-ttk`, `kill-probability`, a relay
//! mode, `--seed`/`--max-seconds`), the default report (`--uncapped`, `--cap-aware`, `--all-encounters`, `--vampire`)
//! in text and `--json`, every usage refusal the branch reads, and the create-only writer. The tables themselves are the
//! core's records (pinned by `dfo-core/tests/real_build.rs` and `tests/loadout.rs`); this file pins the command around
//! them.
//!
//! Known deliberate differences, asserted below rather than glossed over:
//! - the JS accepts and ignores `--target`/`--series`/`--family`/`--stat`/`--build`/`--categories` here; this CLI
//!   refuses each by name (exit 2), as every other unported flag.
//! - a positional extra is ignored by the JS and refused here.
//! - an existing `--out` path is refused create-only here where the JS truncates it.
//!
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::{js_root as js, pin_mtime, rust_root as rust, take_page, temp_root};

use std::fs;
use std::path::Path;

fn page_diff(args: &[&str], got: &[u8], want: &[u8]) {
    if got != want {
        let at = got
            .iter()
            .zip(want)
            .position(|(a, b)| a != b)
            .unwrap_or_else(|| got.len().min(want.len()));
        let from = at.saturating_sub(160);
        panic!(
            "the page differs for {args:?} at byte {at} (lens {} vs {}):\nrust: {:?}\njs:   {:?}",
            got.len(),
            want.len(),
            String::from_utf8_lossy(&got[from..(at + 240).min(got.len())]),
            String::from_utf8_lossy(&want[from..(at + 240).min(want.len())]),
        );
    }
}

/// A text success case (no page): same exit code and byte-identical stdout/stderr.
fn same(args: &[&str], root: &Path) {
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
}

/// A text success case: same exit code, byte-identical stdout (card and page-write line) and page.
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
    page_diff(args, &take_page(page), &want_page);
}

/// A `--json` success case (no page): same exit code and byte-identical stdout (the document).
fn same_json(args: &[&str], root: &Path) {
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
}

/// A `--json` report: the document on stdout, and the page is written in both modes.
fn same_json_page(args: &[&str], root: &Path, page: &Path) {
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
    page_diff(args, &take_page(page), &want_page);
}

/// A shared usage error: both exit 2 with the same stderr and no page. `js_stderr` is the JS wording when the two CLIs
/// intentionally differ (`None` means byte-identical).
fn same_usage(args: &[&str], root: &Path, page: &Path, js_stderr: Option<&str>) {
    let want = js(args, root);
    let got = rust(args, root);
    assert_eq!(
        want.status.code(),
        Some(2),
        "js {args:?}: stdout {} stderr {}",
        String::from_utf8_lossy(&want.stdout),
        String::from_utf8_lossy(&want.stderr)
    );
    assert_eq!(got.status.code(), Some(2), "rust {args:?}");
    match js_stderr {
        None => assert_eq!(
            String::from_utf8_lossy(&got.stderr).trim_end(),
            String::from_utf8_lossy(&want.stderr).trim_end(),
            "stderr differs for {args:?}"
        ),
        Some(text) => {
            assert!(String::from_utf8_lossy(&want.stderr).contains(text));
            assert!(!got.stderr.is_empty());
        }
    }
    assert!(got.stdout.is_empty(), "no stdout for {args:?}");
    assert!(!page.exists(), "no page for {args:?}");
}

/// One shortlist case in its own temp root: the sampled rows cost ~15 s each, so each case is a `#[test]` and libtest
/// runs them side by side (the gate's thread budget bounds the total). Every case here was a call in the one loop before.
fn text_case(label: &str, args: &[&str]) {
    let root = temp_root(label);
    same(args, &root);
    let _ = fs::remove_dir_all(&root);
}

fn json_case(label: &str, args: &[&str]) {
    let root = temp_root(label);
    same_json(args, &root);
    let _ = fs::remove_dir_all(&root);
}

// The default: both modes, one Breach ranking each.
#[test]
fn shortlist_text_default_matches_the_js() {
    text_case(
        "shortlist-text",
        &["loadout", "--shortlist", "1", "--max-blows", "20"],
    );
}

// The alias is the same branch.
#[test]
fn shortlist_text_alias_matches_the_js() {
    text_case(
        "shortlist-text-alias",
        &["real-dps", "--shortlist", "1", "--max-blows", "20"],
    );
}

// `--uncapped` with the probability objective.
#[test]
fn shortlist_text_kill_probability_matches_the_js() {
    text_case(
        "shortlist-text-probability",
        &[
            "loadout",
            "--shortlist",
            "1",
            "--uncapped",
            "--objective",
            "kill-probability",
            "--max-blows",
            "20",
        ],
    );
}

// A specific content, two rows, a longer blow budget.
#[test]
fn shortlist_text_cap_aware_skyketch_matches_the_js() {
    text_case(
        "shortlist-text-skyketch",
        &[
            "loadout",
            "--shortlist",
            "2",
            "--cap-aware",
            "--encounter",
            "skyketch",
            "--max-blows",
            "60",
        ],
    );
}

// A non-default seed and horizon (the header prints both).
#[test]
fn shortlist_text_seed_and_horizon_match_the_js() {
    text_case(
        "shortlist-text-seed",
        &[
            "loadout",
            "--shortlist",
            "1",
            "--uncapped",
            "--seed",
            "7",
            "--max-seconds",
            "120",
            "--max-blows",
            "20",
        ],
    );
}

// `--health` prices a smaller ordinary pool.
#[test]
fn shortlist_text_health_matches_the_js() {
    text_case(
        "shortlist-text-health",
        &[
            "loadout",
            "--shortlist",
            "1",
            "--uncapped",
            "--health",
            "250",
            "--max-blows",
            "20",
        ],
    );
}

#[test]
fn shortlist_json_default_matches_the_js() {
    json_case(
        "shortlist-json",
        &["loadout", "--shortlist", "1", "--max-blows", "20", "--json"],
    );
}

#[test]
fn shortlist_json_alias_matches_the_js() {
    json_case(
        "shortlist-json-alias",
        &[
            "real-dps",
            "--shortlist",
            "2",
            "--max-blows",
            "20",
            "--json",
        ],
    );
}

// `--samples` keeps every row's `detail`; off, it is pruned. Both are pinned.
#[test]
fn shortlist_json_samples_match_the_js() {
    json_case(
        "shortlist-json-samples",
        &[
            "loadout",
            "--shortlist",
            "1",
            "--max-blows",
            "20",
            "--samples",
            "--json",
        ],
    );
}

#[test]
fn shortlist_json_cap_aware_abyss_matches_the_js() {
    json_case(
        "shortlist-json-abyss",
        &[
            "loadout",
            "--shortlist",
            "1",
            "--cap-aware",
            "--encounter",
            "abyss",
            "--max-blows",
            "20",
            "--json",
        ],
    );
}

#[test]
fn report_text_default() {
    let root = temp_root("report-text-default");
    let page = root.join("loadouts.html");
    same_page(&["loadout", "--out", page.to_str().unwrap()], &root, &page);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn report_text_alias() {
    let root = temp_root("report-text-alias");
    let page = root.join("loadouts.html");
    same_page(&["real-dps", "--out", page.to_str().unwrap()], &root, &page);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn report_text_uncapped() {
    let root = temp_root("report-text-uncapped");
    let page = root.join("loadouts.html");
    same_page(
        &["loadout", "--uncapped", "--out", page.to_str().unwrap()],
        &root,
        &page,
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn report_text_uncapped_all_encounters() {
    let root = temp_root("report-text-uncapped-all");
    let page = root.join("loadouts.html");
    // `--all-encounters` with the uncapped mode only: the cap bodies are not priced, so they do not reach the page.
    same_page(
        &[
            "loadout",
            "--uncapped",
            "--all-encounters",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn report_text_cap_aware() {
    let root = temp_root("report-text-capped");
    let page = root.join("loadouts.html");
    same_page(
        &["loadout", "--cap-aware", "--out", page.to_str().unwrap()],
        &root,
        &page,
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn report_text_cap_aware_encounter() {
    let root = temp_root("report-text-capped-abyss");
    let page = root.join("loadouts.html");
    same_page(
        &[
            "loadout",
            "--cap-aware",
            "--encounter",
            "abyss",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn report_text_cap_aware_all_encounters() {
    let root = temp_root("report-text-capped-all");
    let page = root.join("loadouts.html");
    same_page(
        &[
            "loadout",
            "--cap-aware",
            "--all-encounters",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn report_text_vampire() {
    let root = temp_root("report-text-vampire");
    let page = root.join("loadouts.html");
    same_page(
        &["loadout", "--vampire", "--out", page.to_str().unwrap()],
        &root,
        &page,
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn report_json_default() {
    let root = temp_root("report-json-default");
    let page = root.join("loadouts.html");
    same_json_page(
        &["loadout", "--json", "--out", page.to_str().unwrap()],
        &root,
        &page,
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn report_json_uncapped() {
    let root = temp_root("report-json-uncapped");
    let page = root.join("loadouts.html");
    same_json_page(
        &[
            "real-dps",
            "--uncapped",
            "--json",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn report_json_cap_aware_all_encounters() {
    let root = temp_root("report-json-capped-all");
    let page = root.join("loadouts.html");
    same_json_page(
        &[
            "loadout",
            "--cap-aware",
            "--all-encounters",
            "--json",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn usage_refusals_match_the_js() {
    let root = temp_root("usage");
    let page = root.join("loadouts.html");
    // The shortlist guards.
    same_usage(&["loadout", "--shortlist", "1.5"], &root, &page, None);
    same_usage(&["loadout", "--shortlist", "abc"], &root, &page, None);
    same_usage(&["loadout", "--shortlist", ""], &root, &page, None);
    same_usage(&["loadout", "--shortlist", "999"], &root, &page, None);
    same_usage(
        &["loadout", "--shortlist", "1", "--no-carry"],
        &root,
        &page,
        None,
    );
    same_usage(
        &["loadout", "--shortlist", "1", "--health", "0"],
        &root,
        &page,
        None,
    );
    same_usage(
        &["loadout", "--shortlist", "1", "--trials", "10"],
        &root,
        &page,
        None,
    );
    same_usage(
        &["loadout", "--shortlist", "1", "--trials", "1000001"],
        &root,
        &page,
        None,
    );
    same_usage(
        &[
            "loadout",
            "--cap-aware",
            "--shortlist",
            "1",
            "--health",
            "500",
        ],
        &root,
        &page,
        None,
    );
    // `--objective` needs one shortlist mode, and each mode allows its own objectives.
    same_usage(
        &["loadout", "--shortlist", "1", "--objective", "nope"],
        &root,
        &page,
        None,
    );
    same_usage(
        &[
            "loadout",
            "--cap-aware",
            "--shortlist",
            "1",
            "--objective",
            "stochastic-ttk",
        ],
        &root,
        &page,
        None,
    );
    same_usage(
        &[
            "loadout",
            "--uncapped",
            "--shortlist",
            "1",
            "--objective",
            "stochastic-relay",
        ],
        &root,
        &page,
        None,
    );
    // The global flag validation.
    same_usage(&["loadout", "--encounter", "nope"], &root, &page, None);
    same_usage(&["loadout", "--level", "0"], &root, &page, None);
    let _ = fs::remove_dir_all(&root);
}

/// One "the JS accepts it, this CLI refuses it by name" case in its own temp root. Each case costs a full JS loadout
/// run (minutes on a cold cache), so each is its own `#[test]`: under the gate's per-test queue they run side by side.
fn refused_but_accepted_by_the_js(label: &str, args: &[&str]) {
    let root = temp_root(label);
    let js = js(args, &root);
    assert_eq!(
        js.status.code(),
        Some(0),
        "the JS accepts {args:?}: {}",
        String::from_utf8_lossy(&js.stderr)
    );
    let _ = fs::remove_file(root.join("loadouts.html"));
    let got = rust(args, &root);
    assert_eq!(got.status.code(), Some(2), "this CLI refuses {args:?}");
    assert!(!got.stderr.is_empty());
    let _ = fs::remove_dir_all(&root);
}

// The JS accepts and ignores these here; this CLI names each one, as every unported flag.
#[test]
fn the_cli_refuses_target_where_the_js_ignores_it() {
    refused_but_accepted_by_the_js(
        "refuse-target",
        &["loadout", "--target", "bogus", "--shortlist", "1"],
    );
}

#[test]
fn the_cli_refuses_series_where_the_js_ignores_it() {
    refused_but_accepted_by_the_js("refuse-series", &["loadout", "--series", "stat:strength"]);
}

#[test]
fn the_cli_refuses_family_where_the_js_ignores_it() {
    refused_but_accepted_by_the_js("refuse-family", &["loadout", "--family", "Archery"]);
}

#[test]
fn the_cli_refuses_stat_where_the_js_ignores_it() {
    refused_but_accepted_by_the_js("refuse-stat", &["loadout", "--stat", "strength=1"]);
}

#[test]
fn the_cli_refuses_build_where_the_js_ignores_it() {
    refused_but_accepted_by_the_js("refuse-build", &["loadout", "--build", "bow"]);
}

#[test]
fn the_cli_refuses_categories_where_the_js_ignores_it() {
    refused_but_accepted_by_the_js("refuse-categories", &["loadout", "--categories"]);
}

#[test]
fn the_cli_refuses_a_positional_extra_where_the_js_ignores_it() {
    refused_but_accepted_by_the_js("refuse-extra", &["loadout", "--shortlist", "1", "extra"]);
}

// The create-only writer: an existing path is refused and left untouched, where the JS truncates it.
#[test]
fn the_create_only_writer_refuses_an_existing_page() {
    let root = temp_root("refusals");
    let page = root.join("loadouts.html");
    fs::write(&page, b"keep me").expect("a pre-existing page");
    pin_mtime(&page);
    let got = rust(&["loadout", "--out", page.to_str().unwrap()], &root);
    assert_eq!(got.status.code(), Some(2), "the create-only refusal");
    assert_eq!(fs::read(&page).expect("the file survives"), b"keep me");
    let _ = fs::remove_dir_all(&root);
}
