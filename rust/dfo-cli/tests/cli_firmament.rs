//! The R8 `firmament` command, differentially against the real JS CLI.
//!
//! Each success case runs `bin/dfo-dps.js firmament ...` and the Rust binary with the same arguments, then compares the
//! written page byte for byte, and the `--json` document byte for byte. `tests/firmament.rs` already pins the per-plan
//! markup (`firmamentSvg`/`firmamentSection`) against `src/firmament.js`; this file pins the command around it: the
//! `--build` split, the star purse, the default output name, the card, the refusals and the write.
//!
//! Three deliberate differences, all documented in `src/main.rs`'s module doc:
//! - the JS card starts `Firmament plans (N cached, M computed)` from its disk cache; this CLI keeps no cache and prints
//!   the bare `Firmament plans`, so it never reports a cache hit it did not have. [`normalized_stdout`] drops that
//!   parenthetical before comparing, and [`card_has_no_cache_counts`] pins the difference itself.
//! - the page is create-only (the deliberate deviation `probe`/`graph`/`report` pin): an existing path is refused with
//!   exit 2 and left byte-identical, where the JS `writeFileSync` truncates it.
//! - `--refresh` is accepted and changes nothing here; the JS uses it to drop its cache. Every case passes it to the JS
//!   so its cache is never read, and the plans must agree regardless. (The JS oracle still writes its own cache under
//!   the checkout's gitignored `.cache/` at the end of a run; the Rust binary writes no cache at all.)
//!
//! A missing `node` panics rather than skips: a skipped differential proves nothing.

mod common;

use common::{js, js_root, pin_mtime, rust, rust_root, take_page, temp_root};

use std::fs;
use std::path::Path;

/// The card's first line without the JS cache parenthetical; every other line is the JS's own text.
fn normalized_stdout(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes).into_owned();
    match text.split_once('\n') {
        Some((first, rest)) if first.starts_with("Firmament plans") => {
            format!("Firmament plans\n{rest}")
        }
        _ => text,
    }
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

/// A text success case: same exit code, the same card after the cache parenthetical, a byte-identical page.
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
        normalized_stdout(&got.stdout),
        normalized_stdout(&want.stdout),
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
fn firmament_theory_text_and_page_match_the_js() {
    let root = temp_root("builds");
    let page = root.join("firmament.html");
    let out = page.to_str().unwrap();

    // One build, the default 98 stars.
    same(
        &[
            "firmament",
            "--build",
            "longblade",
            "--refresh",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    // Several builds with padding around the commas, and a small purse whose free stars show in the card and section.
    same(
        &[
            "firmament",
            "--build",
            " bow , destruction ,tank ",
            "--stars",
            "24",
            "--refresh",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    // Zero stars: an empty path, the `0/0` card and the free-line suffix rules.
    same(
        &[
            "firmament",
            "--build",
            "fists",
            "--stars",
            "0",
            "--refresh",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    // No `--build`: every preset, in `buildIds()` order.
    same(&["firmament", "--refresh", "--out", out], &root, &page);
    // `--build ''` is falsy in the JS `values.build ?`, so it is every build too.
    same(
        &["firmament", "--build", "", "--refresh", "--out", out],
        &root,
        &page,
    );
    // A whitespace-only `--build` is truthy in JS and splits to no ids: an empty card body and no sections.
    same(
        &["firmament", "--build", "  , ", "--refresh", "--out", out],
        &root,
        &page,
    );
    // `buildById` lower-cases, and a repeated id plans twice: `LongBlade`/`LONGblade` are the one preset.
    same(
        &[
            "firmament",
            "--build",
            "LongBlade,LONGblade",
            "--refresh",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn firmament_json_matches_the_js() {
    let root = temp_root("json");
    let page = root.join("plans.html");
    let out = page.to_str().unwrap();
    for args in [
        &[
            "firmament",
            "--build",
            "bow",
            "--refresh",
            "--json",
            "--out",
            out,
        ][..],
        &[
            "firmament",
            "--build",
            "longblade,axe,destruction",
            "--stars",
            "37",
            "--refresh",
            "--json",
            "--out",
            out,
        ][..],
        &[
            "firmament",
            "--build",
            "",
            "--refresh",
            "--json",
            "--out",
            out,
        ][..],
    ] {
        same_json(args, &root, &page);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn firmament_default_output_name_matches_the_js() {
    let root = temp_root("default-name");
    // Both CLIs run in the temp root, so the JS `firmament.html` default lands there (never the checkout).
    for args in [
        &["firmament", "--build", "bow", "--refresh"][..],
        // The default `--out` is the report name, which firmament renames to `firmament.html`.
        &[
            "firmament",
            "--build",
            "bow",
            "--refresh",
            "--out",
            "dfo-dps-report.html",
        ][..],
    ] {
        let want = js_root(args, &root);
        assert_eq!(
            want.status.code(),
            Some(0),
            "js {args:?}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        let want_page = take_page(&root.join("firmament.html"));
        let got = rust_root(args, &root);
        assert_eq!(
            got.status.code(),
            Some(0),
            "rust {args:?}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert_eq!(
            normalized_stdout(&got.stdout),
            normalized_stdout(&want.stdout),
            "stdout differs for {args:?}"
        );
        page_diff(args, &take_page(&root.join("firmament.html")), &want_page);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

/// The card never reports a cache hit: this CLI has no disk cache, so its first line is the bare `Firmament plans` and
/// the JS's `(N cached, M computed)` suffix is absent (the documented observable difference).
#[test]
fn card_has_no_cache_counts() {
    let root = temp_root("no-cache");
    let page = root.join("firmament.html");
    let out = page.to_str().unwrap();
    let got = rust(&["firmament", "--build", "bow", "--out", out], &root);
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    let first = String::from_utf8_lossy(&got.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .to_owned();
    assert_eq!(first, "Firmament plans");
    assert!(
        !first.contains("cached") && !first.contains("computed"),
        "no cache claim without a cache: {first}"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn firmament_refusals_match_the_js_where_they_can() {
    let root = temp_root("refusals");
    let page = root.join("firmament.html");
    let out = page.to_str().unwrap();
    // An unknown build is the JS's one stderr line and exit 2.
    same_usage(
        &[
            "firmament",
            "--build",
            "longblade,nope",
            "--refresh",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    // `--stars` is a validated integer 0..98: a fraction and an out-of-range value fail before the branch.
    same_usage(
        &["firmament", "--stars", "2.5", "--refresh", "--out", out],
        &root,
        &page,
    );
    same_usage(
        &["firmament", "--stars", "99", "--refresh", "--out", out],
        &root,
        &page,
    );
    // A `--build` outside `firmament` is refused here by name; the JS accepts and ignores it.
    let got = rust(
        &["report", "--theory", "--build", "bow", "--out", out],
        &root,
    );
    assert_eq!(got.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&got.stderr)
            .contains("--build is not read by report; only firmament reads it"),
        "rust: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert!(got.stdout.is_empty());
    assert!(!page.exists(), "no page on the refusal");
    let want = js(
        &["report", "--theory", "--build", "bow", "--out", out],
        &root,
    );
    assert_eq!(want.status.code(), Some(0), "the JS accepts the flag");
    if page.exists() {
        fs::remove_file(&page).expect("cleanup the JS page");
    }
    // Extra positionals: the JS ignores them, this slice refuses them on purpose.
    let got = rust(&["firmament", "--refresh", "extra", "--out", out], &root);
    assert_eq!(got.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&got.stderr).contains("unexpected positional argument"));
    assert!(!page.exists(), "no page for an extra positional");
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn help_lists_the_firmament_command() {
    let root = temp_root("help");
    let got = rust(&["--help"], &root);
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    for flag in [
        "dfo-cli firmament",
        "--build <id,...>",
        "--stars <n>",
        "--refresh",
    ] {
        assert!(text.contains(flag), "help names {flag}");
    }
    assert!(
        text.contains("firmament page written:"),
        "help describes the line"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

/// The firmament page is create-only: no existing path is truncated - an older report, a save-shaped file, a hard link
/// and a symlink - where the JS truncates all of them.
#[test]
fn firmament_refuses_to_overwrite() {
    let root = temp_root("create-only");

    let report = root.join("firmament.html");
    fs::write(&report, "an older report").expect("report fixture");
    pin_mtime(&report);
    assert_refused(
        &[
            "firmament",
            "--build",
            "bow",
            "--out",
            report.to_str().unwrap(),
        ],
        &root,
        &report,
        b"an older report",
    );

    let save = root.join("SaveData.txt");
    fs::write(&save, "a game save the CLI must never touch").expect("save fixture");
    pin_mtime(&save);
    assert_refused(
        &[
            "firmament",
            "--build",
            "bow",
            "--out",
            save.to_str().unwrap(),
        ],
        &root,
        &save,
        b"a game save the CLI must never touch",
    );

    // A page path that is a directory: the create-only opener refuses it and stdout stays empty.
    let got = rust(&["firmament", "--build", "bow", "--out", "."], &root);
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
            &[
                "firmament",
                "--build",
                "bow",
                "--out",
                hard.to_str().unwrap(),
            ],
            &root,
            &hard,
            &before,
        );
        let link = root.join("link.html");
        symlink(&target, &link).expect("symlink fixture");
        assert_refused(
            &[
                "firmament",
                "--build",
                "bow",
                "--out",
                link.to_str().unwrap(),
            ],
            &root,
            &link,
            &before,
        );
        let dangling = root.join("dangling.html");
        symlink(root.join("never-written.html"), &dangling).expect("dangling fixture");
        let got = rust(
            &[
                "firmament",
                "--build",
                "bow",
                "--out",
                dangling.to_str().unwrap(),
            ],
            &root,
        );
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
