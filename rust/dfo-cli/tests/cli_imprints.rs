//! The R8 `imprints` command, differentially against the real JS CLI.
//!
//! Each success case runs `bin/dfo-dps.js imprints ...` and the Rust binary with the same arguments, then compares
//! stdout (the card plus its `imprints page written:` line, or the `--json` document) and the written page byte for
//! byte. `tests/imprints.rs` pins the renderer over `rank_all` rows; this file pins the command around it: the
//! `--family` lookup and filter, the `--uncapped`/`--cap-aware`/`--sort` precedence, the default output name, the
//! refusals and the create-only write.
//!
//! The one deliberate difference is the create-only writer every page command of this slice pins: an existing output
//! path is refused with exit 2 and left byte-identical, where the JS `writeFileSync` truncates it.
//!
//! A missing `node` panics rather than skips: a skipped differential proves nothing.

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
        "dfo-cli-imprints-{label}-{}-{n}",
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

/// The page's bytes after a run, then the file is removed so the next CLI can write the same path.
fn take_page(path: &Path) -> Vec<u8> {
    let bytes = fs::read(path).expect("the CLI wrote its imprints page");
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
        let from = at.saturating_sub(120);
        panic!(
            "the page differs for {args:?} at byte {at} (lens {} vs {}):\nrust: {:?}\njs:   {:?}",
            got.len(),
            want.len(),
            String::from_utf8_lossy(&got[from..(at + 200).min(got.len())]),
            String::from_utf8_lossy(&want[from..(at + 200).min(want.len())]),
        );
    }
}

/// A text success case: same exit code, byte-identical stdout (card and page-write line) and page.
fn same(args: &[&str], root: &Path, page: &Path) {
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

/// A `--json` success case: same exit code, byte-identical stdout (the document) and page.
fn same_json(args: &[&str], root: &Path, page: &Path) {
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
        "the JSON document differs for {args:?}"
    );
    page_diff(args, &take_page(page), &want_page);
}

/// A usage error: both exit 2 with the same stderr and no page written.
fn same_usage(args: &[&str], root: &Path, page: &Path) {
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
    assert!(!page.exists(), "no page for {args:?}");
}

#[test]
fn imprints_text_and_page_match_the_js() {
    let root = temp_root("text");
    let page = root.join("imprints.html");
    let out = page.to_str().unwrap();

    // Every family, the default boss order.
    same(&["imprints", "--out", out], &root, &page);
    // One family by key, with the uncapped order.
    same(
        &[
            "imprints", "--family", "Archery", "--sort", "uncapped", "--out", out,
        ],
        &root,
        &page,
    );
    // `--firmament` changes the rows and the subtitle; `--cap-aware` names the boss order.
    same(
        &["imprints", "--firmament", "--cap-aware", "--out", out],
        &root,
        &page,
    );
    // `--uncapped` wins over `--sort conditional` (the JS ternary's first arm).
    same(
        &[
            "imprints",
            "--uncapped",
            "--sort",
            "conditional",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    // `--cap-aware` beats `--sort uncapped` (the second arm): the order stays boss.
    same(
        &[
            "imprints",
            "--cap-aware",
            "--sort",
            "uncapped",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    // `--family ''` is falsy in the JS `values.family ?`, so every family is kept rather than refused.
    same(&["imprints", "--family", "", "--out", out], &root, &page);
    // `imprintFamilyById` lower-cases the key.
    same(
        &["imprints", "--family", "SHORTBLADE", "--out", out],
        &root,
        &page,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn imprints_json_matches_the_js() {
    let root = temp_root("json");
    let page = root.join("rows.html");
    let out = page.to_str().unwrap();
    for args in [
        &["imprints", "--json", "--out", out][..],
        &[
            "imprints",
            "--family",
            "HandToHand",
            "--sort",
            "conditional",
            "--json",
            "--out",
            out,
        ][..],
        &["imprints", "--vampire", "--json", "--out", out][..],
    ] {
        same_json(args, &root, &page);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn imprints_default_output_name_matches_the_js() {
    let root = temp_root("default-name");
    let run = |program: &str, args: &[&str]| {
        let mut command = Command::new(program);
        if program == "node" {
            command.arg(repo_root().join("bin").join("dfo-dps.js"));
        }
        command
            .args(args)
            .current_dir(&root)
            .env("DAGGER_USER_DATA", &root)
            .output()
            .expect("the CLI runs")
    };
    for args in [
        // The JS `--out` default is the report name, which imprints renames to `imprints.html`.
        &["imprints"][..],
        &["imprints", "--out", "dfo-dps-report.html"][..],
    ] {
        let want = run("node", args);
        assert_eq!(
            want.status.code(),
            Some(0),
            "js {args:?}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        let want_page = take_page(&root.join("imprints.html"));
        let got = run(env!("CARGO_BIN_EXE_dfo-cli"), args);
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
        page_diff(args, &take_page(&root.join("imprints.html")), &want_page);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn imprints_refusals_match_the_js() {
    let root = temp_root("refusals");
    let page = root.join("imprints.html");
    let out = page.to_str().unwrap();
    // An unknown family is the JS `console.error` line and exit 2, before any page is written.
    same_usage(
        &["imprints", "--family", "nope", "--out", out],
        &root,
        &page,
    );
    // `--sort` is validated globally by `validateFlags`, for every command.
    same_usage(&["imprints", "--sort", "nope", "--out", out], &root, &page);
    same_usage(&["build", "--sort", "nope"], &root, &page);
    // `--family`/`--sort`/`--cap-aware` are refused by name outside `imprints`; the JS accepts and ignores each.
    for args in [
        &["report", "--theory", "--family", "bow", "--out", out][..],
        &["build", "--theory", "--sort", "uncapped"][..],
        &["graph", "--theory", "--cap-aware"][..],
    ] {
        let got = rust(args, &root);
        assert_eq!(got.status.code(), Some(2), "rust {args:?}");
        assert!(
            String::from_utf8_lossy(&got.stderr).contains("is not supported by this CLI slice"),
            "rust {args:?}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert!(got.stdout.is_empty(), "no card for {args:?}");
        assert!(!page.exists(), "no page for {args:?}");
        let want = js(args, &root);
        assert_eq!(want.status.code(), Some(0), "the JS accepts {args:?}");
        // The JS may still write its page for a command it accepts the flag on (e.g. `report`).
        if page.exists() {
            fs::remove_file(&page).expect("cleanup the JS page");
        }
    }
    // `--series` stays graph-only, and it is not read by `imprints`.
    let got = rust(&["imprints", "--series", "stat:speed", "--out", out], &root);
    assert_eq!(got.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&got.stderr).contains("is not supported by this CLI slice"));
    assert!(!page.exists(), "no page with --series");
    // Extra positionals: the JS ignores them, this slice refuses them on purpose.
    let got = rust(&["imprints", "extra", "--out", out], &root);
    assert_eq!(got.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&got.stderr).contains("unexpected positional argument"));
    assert!(!page.exists(), "no page for an extra positional");
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn help_lists_the_imprints_command() {
    let root = temp_root("help");
    let got = rust(&["--help"], &root);
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    for flag in [
        "dfo-cli imprints",
        "--family <key>",
        "--sort <boss|uncapped|conditional>",
        "--cap-aware",
        "imprints page written:",
    ] {
        assert!(text.contains(flag), "help names {flag}");
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

/// The imprints page is create-only: no existing path is truncated - an older report, a save-shaped file, a hard link,
/// a symlink and a directory - where the JS truncates all of them.
#[test]
fn imprints_refuses_to_overwrite() {
    let root = temp_root("create-only");

    let report = root.join("imprints.html");
    fs::write(&report, "an older report").expect("report fixture");
    assert_refused(
        &["imprints", "--out", report.to_str().unwrap()],
        &root,
        &report,
        b"an older report",
    );

    let save = root.join("SaveData.txt");
    fs::write(&save, "a game save the CLI must never touch").expect("save fixture");
    assert_refused(
        &["imprints", "--out", save.to_str().unwrap()],
        &root,
        &save,
        b"a game save the CLI must never touch",
    );

    // A page path that is a directory: the create-only opener refuses it and stdout stays empty.
    let got = rust(&["imprints", "--out", "."], &root);
    assert_eq!(got.status.code(), Some(2), "rust page dir");
    assert!(
        String::from_utf8_lossy(&got.stderr).contains("cannot write "),
        "rust: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert!(got.stdout.is_empty(), "no card before a failed page write");

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let target = root.join("keep.txt");
        fs::write(&target, "kept").expect("fixture");
        let before = fs::read(&target).expect("fixture");
        let hard = root.join("hard.html");
        fs::hard_link(&target, &hard).expect("hard link fixture");
        assert_refused(
            &["imprints", "--out", hard.to_str().unwrap()],
            &root,
            &hard,
            &before,
        );
        let link = root.join("link.html");
        symlink(&target, &link).expect("symlink fixture");
        assert_refused(
            &["imprints", "--out", link.to_str().unwrap()],
            &root,
            &link,
            &before,
        );
        let dangling = root.join("dangling.html");
        symlink(root.join("never-written.html"), &dangling).expect("dangling fixture");
        let got = rust(&["imprints", "--out", dangling.to_str().unwrap()], &root);
        assert_eq!(got.status.code(), Some(2), "dangling symlink");
        assert!(
            String::from_utf8_lossy(&got.stderr).contains("EEXIST"),
            "a dangling symlink exists too: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert_eq!(fs::read(&target).expect("target survives"), before);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

/// Assert a create-only refusal: exit 2, an `EEXIST` line naming the path, no stdout, the file left intact.
fn assert_refused(args: &[&str], root: &Path, out: &Path, before: &[u8]) {
    let got = rust(args, root);
    assert_eq!(
        got.status.code(),
        Some(2),
        "rust {args:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    let line = String::from_utf8_lossy(&got.stderr).into_owned();
    assert!(
        line.contains("EEXIST") && line.contains(&out.to_string_lossy().into_owned()),
        "the refusal names the collision: {line}"
    );
    assert!(got.stdout.is_empty(), "no card on a refused write");
    assert_eq!(
        fs::read(out).expect("the existing file survives"),
        before,
        "the existing file was truncated by {args:?}"
    );
}
