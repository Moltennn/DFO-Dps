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

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// A fresh temp root with an empty `Saves` folder and no launcher config: the empty spellbook fallback.
fn temp_root(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "dfo-cli-loadout-cli-{label}-{}-{n}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("Saves")).expect("temp fixture root");
    root
}

fn js(args: &[&str], root: &Path) -> Output {
    Command::new("node")
        .env("LC_ALL", "en_US.UTF-8")
        .env("LANG", "en_US.UTF-8")
        .arg(repo_root().join("bin").join("dfo-dps.js"))
        .args(args)
        .current_dir(root)
        .env("DAGGER_USER_DATA", root)
        .output()
        .expect("the JS CLI runs (this repository's Node project)")
}

fn rust(args: &[&str], root: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_dfo-cli"))
        .args(args)
        .current_dir(root)
        .env("DAGGER_USER_DATA", root)
        .output()
        .expect("the Rust CLI binary runs")
}

/// One page's bytes after a run, then removed so the other CLI can write the same path.
fn take_page(path: &Path) -> Vec<u8> {
    let bytes = fs::read(path).expect("the CLI wrote its page");
    fs::remove_file(path).expect("cleanup the page");
    bytes
}

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

#[test]
fn shortlist_text_matches_the_js() {
    let root = temp_root("shortlist-text");
    // The default: both modes, one Breach ranking each.
    same(&["loadout", "--shortlist", "1", "--max-blows", "20"], &root);
    // The alias is the same branch.
    same(
        &["real-dps", "--shortlist", "1", "--max-blows", "20"],
        &root,
    );
    // `--uncapped` with the probability objective.
    same(
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
        &root,
    );
    // A specific content, two rows, a longer blow budget.
    same(
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
        &root,
    );
    // A non-default seed and horizon (the header prints both).
    same(
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
        &root,
    );
    // `--health` prices a smaller ordinary pool.
    same(
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
        &root,
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn shortlist_json_matches_the_js() {
    let root = temp_root("shortlist-json");
    same_json(
        &["loadout", "--shortlist", "1", "--max-blows", "20", "--json"],
        &root,
    );
    same_json(
        &[
            "real-dps",
            "--shortlist",
            "2",
            "--max-blows",
            "20",
            "--json",
        ],
        &root,
    );
    // `--samples` keeps every row's `detail`; off, it is pruned. Both are pinned.
    same_json(
        &["loadout", "--shortlist", "1", "--max-blows", "20", "--json"],
        &root,
    );
    same_json(
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
        &root,
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn default_report_text_and_page_match_the_js() {
    let root = temp_root("report-text");
    let page = root.join("loadouts.html");
    let out = page.to_str().unwrap();
    same_page(&["loadout", "--out", out], &root, &page);
    same_page(&["real-dps", "--out", out], &root, &page);
    same_page(&["loadout", "--uncapped", "--out", out], &root, &page);
    // `--all-encounters` with the uncapped mode only: the cap bodies are not priced, so they do not reach the page.
    same_page(
        &["loadout", "--uncapped", "--all-encounters", "--out", out],
        &root,
        &page,
    );
    same_page(&["loadout", "--cap-aware", "--out", out], &root, &page);
    same_page(
        &[
            "loadout",
            "--cap-aware",
            "--encounter",
            "abyss",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    same_page(
        &["loadout", "--cap-aware", "--all-encounters", "--out", out],
        &root,
        &page,
    );
    same_page(&["loadout", "--vampire", "--out", out], &root, &page);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn default_report_json_and_page_match_the_js() {
    let root = temp_root("report-json");
    let page = root.join("loadouts.html");
    let out = page.to_str().unwrap();
    same_json_page(&["loadout", "--json", "--out", out], &root, &page);
    same_json_page(
        &["real-dps", "--uncapped", "--json", "--out", out],
        &root,
        &page,
    );
    same_json_page(
        &[
            "loadout",
            "--cap-aware",
            "--all-encounters",
            "--json",
            "--out",
            out,
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

#[test]
fn deliberate_refusals_and_create_only_writer() {
    let root = temp_root("refusals");
    let page = root.join("loadouts.html");

    // The JS accepts and ignores these here; this CLI names each one, as every unported flag.
    let refusals: &[&[&str]] = &[
        &["loadout", "--target", "bogus", "--shortlist", "1"],
        &["loadout", "--series", "stat:strength"],
        &["loadout", "--family", "Archery"],
        &["loadout", "--stat", "strength=1"],
        &["loadout", "--build", "bow"],
        &["loadout", "--categories"],
        &["loadout", "--shortlist", "1", "extra"],
    ];
    for args in refusals {
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
    }

    // The create-only writer: an existing path is refused and left untouched, where the JS truncates it.
    fs::write(&page, b"keep me").expect("a pre-existing page");
    let got = rust(&["loadout", "--out", page.to_str().unwrap()], &root);
    assert_eq!(got.status.code(), Some(2), "the create-only refusal");
    assert_eq!(fs::read(&page).expect("the file survives"), b"keep me");
    let _ = fs::remove_dir_all(&root);
}
