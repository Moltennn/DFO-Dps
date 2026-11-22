//! The R8 `weapons`/`skills` command, end to end against the real JS CLI.
//!
//! Every case runs `bin/dfo-dps.js <cmd> ...` and the Rust binary with the same arguments under one temp
//! `DAGGER_USER_DATA` root, then compares stdout byte for byte (the `weapons page written:` line, or the `--json`
//! document) and the written page byte for byte. Both variants are covered: the default page (every row, one skill curve
//! per family, the Critical Strike curve) and `--categories` (one winner per type per slot), for `weapons` and its alias
//! `skills`, across `--firmament`, `--vampire`, `--race` and `--level`, text and `--json`.
//!
//! Nothing reads a real save or a real `SPELLS.STD` (the page reads neither): every case sets `DAGGER_USER_DATA` to its
//! own empty temp root, so neither CLI can see the player's launcher config or game files. The page is create-only, so
//! each case owns its own `--out` path (an existing file is refused, where the JS truncates - the deliberate deviation
//! pinned here).
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

fn temp_root(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "dfo-cli-weapons-{label}-{}-{n}",
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

fn page_diff(got: &[u8], want: &[u8], label: &str) {
    if got != want {
        let at = got
            .iter()
            .zip(want)
            .position(|(a, b)| a != b)
            .unwrap_or_else(|| got.len().min(want.len()));
        let from = at.saturating_sub(120);
        panic!(
            "the page differs for {label} at byte {at} (lens {} vs {}):\nrust: {:?}\njs:   {:?}",
            got.len(),
            want.len(),
            String::from_utf8_lossy(&got[from..(at + 200).min(got.len())]),
            String::from_utf8_lossy(&want[from..(at + 200).min(want.len())]),
        );
    }
}

/// One text success case: same exit code, byte-identical stdout (the write line) and page, each CLI owning its own
/// `--out` path in turn so the create-only writer never meets the other's file.
fn same(args: &[&str], root: &Path) {
    let page = root.join(format!(
        "page-{}.html",
        args.join("-").replace(['/', ' '], "_")
    ));
    let out = page.to_str().unwrap();
    let mut full = args.to_vec();
    full.extend(["--out", out]);

    let want = js(&full, root);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {full:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    let want_page = fs::read(&page).expect("the JS wrote its weapons page");
    fs::remove_file(&page).expect("cleanup");

    let got = rust(&full, root);
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust {full:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&got.stdout),
        String::from_utf8_lossy(&want.stdout),
        "stdout differs for {full:?}"
    );
    page_diff(
        &fs::read(&page).expect("the Rust CLI wrote its weapons page"),
        &want_page,
        &format!("{full:?}"),
    );
    fs::remove_file(&page).expect("cleanup");
}

/// A `--json` success case: same exit code and stdout (the document); the page is still written, but it is the same
/// bytes as the text case's, so only the stdout is compared here.
fn same_json(args: &[&str], root: &Path) {
    let page = root.join(format!(
        "json-{}.html",
        args.join("-").replace(['/', ' '], "_")
    ));
    let out = page.to_str().unwrap();
    let mut full = args.to_vec();
    full.extend(["--json", "--out", out]);

    let want = js(&full, root);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {full:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    fs::remove_file(&page).expect("cleanup");
    let got = rust(&full, root);
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust {full:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&got.stdout),
        String::from_utf8_lossy(&want.stdout),
        "the JSON document differs for {full:?}"
    );
    fs::remove_file(&page).expect("cleanup");
}

#[test]
fn weapons_text_and_page_match_the_js() {
    let root = temp_root("text");
    for args in [
        // The default page: every row, six family curves and the Critical Strike curve.
        &["weapons"][..],
        // The alias is the same branch with its own default page name.
        &["skills"][..],
        // `--categories` drops the curves and keeps one winner per type per slot.
        &["weapons", "--categories"][..],
        &["skills", "--categories"][..],
        // `--firmament` moves the family curves and the Critical Strike curve, not the rows.
        &["weapons", "--firmament"][..],
        &["weapons", "--firmament", "--categories"][..],
        // The vampire suffix and the race override.
        &["weapons", "--vampire"][..],
        &["weapons", "--race", "redguard"][..],
        // `--level` moves the reference foe and the Breach, not the level-45 characters.
        &["weapons", "--level", "30"][..],
    ] {
        same(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn weapons_json_matches_the_js() {
    let root = temp_root("json");
    for args in [
        &["weapons"][..],
        &["skills"][..],
        &["weapons", "--categories"][..],
        &["weapons", "--firmament"][..],
        &["weapons", "--vampire"][..],
        &["weapons", "--race", "redguard"][..],
        &["weapons", "--level", "30"][..],
    ] {
        same_json(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn weapons_default_output_names_match_the_js() {
    let root = temp_root("default-name");
    for command in ["weapons", "skills"] {
        // `path.resolve(values.out === 'dfo-dps-report.html' ? defaultOut : values.out)`: no `--out` and the untouched
        // report default both rename to the command's page.
        for out_flag in [None, Some("dfo-dps-report.html")] {
            let mut args = vec![command];
            if let Some(name) = out_flag {
                args.extend(["--out", name]);
            }
            let want = js(&args, &root);
            assert_eq!(
                want.status.code(),
                Some(0),
                "js {args:?}: {}",
                String::from_utf8_lossy(&want.stderr)
            );
            let default_page = root.join(format!("{command}.html"));
            let want_page = fs::read(&default_page).expect("the JS wrote its page");
            fs::remove_file(&default_page).expect("cleanup");

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
            page_diff(
                &fs::read(&default_page).expect("the Rust CLI wrote its page"),
                &want_page,
                &format!("{args:?}"),
            );
            fs::remove_file(&default_page).expect("cleanup");
        }
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

/// The page is create-only (every page command of this slice): an existing file is refused with exit 2 and left
/// byte-identical, where the JS `writeFileSync` truncates it.
#[test]
fn weapons_refuses_to_overwrite() {
    let root = temp_root("create-only");
    let path = root.join("keep.html");
    fs::write(&path, "an older report").expect("fixture");
    let got = rust(&["weapons", "--out", path.to_str().unwrap()], &root);
    assert_eq!(
        got.status.code(),
        Some(2),
        "rust: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    let line = String::from_utf8_lossy(&got.stderr).into_owned();
    assert!(
        line.contains("EEXIST") && line.contains(&path.to_string_lossy().into_owned()),
        "the refusal names the collision: {line}"
    );
    assert!(got.stdout.is_empty(), "no card on a refused write");
    assert_eq!(
        fs::read(&path).expect("the existing file survives"),
        b"an older report"
    );
    // The JS truncates the same path: the documented divergence, not parity.
    let want = js(&["weapons", "--out", path.to_str().unwrap()], &root);
    assert_eq!(want.status.code(), Some(0));
    assert_ne!(fs::read(&path).expect("JS page"), b"an older report");
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_refusals_are_explicit() {
    let root = temp_root("refusals");
    let page = root.join("never.html");
    let out = page.to_str().unwrap();
    // `--categories` is the weapons/skills page's; outside those it is refused by name (the JS accepts and ignores it).
    for args in [
        &["report", "--theory", "--categories", "--out", out][..],
        &["build", "--theory", "--categories"][..],
    ] {
        let got = rust(args, &root);
        assert_eq!(got.status.code(), Some(2), "rust {args:?}");
        assert!(
            String::from_utf8_lossy(&got.stderr).contains("is not supported by this CLI slice"),
            "rust {args:?}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert!(!page.exists(), "no page for {args:?}");
        let want = js(args, &root);
        assert_eq!(want.status.code(), Some(0), "the JS accepts {args:?}");
        if page.exists() {
            fs::remove_file(&page).expect("cleanup the JS page");
        }
    }
    // Extra positionals: the JS ignores them, this slice refuses them on purpose.
    let got = rust(&["weapons", "extra", "--out", out], &root);
    assert_eq!(got.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&got.stderr).contains("unexpected positional argument"));
    assert!(!page.exists(), "no page for an extra positional");
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn help_lists_the_weapons_command() {
    let root = temp_root("help");
    let got = rust(&["--help"], &root);
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    for flag in [
        "dfo-cli weapons",
        "dfo-cli skills",
        "--categories",
        "weapons page written:",
    ] {
        assert!(text.contains(flag), "help names {flag}");
    }
    fs::remove_dir_all(&root).expect("cleanup");
}
