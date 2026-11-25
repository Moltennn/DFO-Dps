//! The R8 `report` command, differentially against the real JS CLI over synthetic fixtures.
//!
//! Each success case runs `bin/dfo-dps.js report ...` and the Rust binary with the same arguments in the same temp
//! `DAGGER_USER_DATA` root, then compares stdout (the `report written:` line) and the written page byte for byte. The
//! page itself is exact-differential in `tests/report.rs`; this file pins the command around it: flag plumbing, the
//! scenario `src/cli.js:2263-2275` builds, the default output name, usage errors and the write.
//!
//! The write is create-only (the deliberate deviation `probe`/`graph` pin): an existing output path is refused with
//! exit 2 and left byte-identical - the report's own imported save, an unrelated save-shaped file, an older report, a
//! hard link, a symlink and a dangling symlink - where the JS `writeFileSync` truncates it. `report_refuses_to_overwrite`
//! shows both sides of that difference.
//!
//! Every fixture is built here (never a real save) under a temp root. A missing `node` panics rather than skips: a
//! skipped differential proves nothing.

mod common;

use common::{js, js_root, pin_mtime, rust, rust_root, take_page, temp_root};

use std::fs;
use std::path::{Path, PathBuf};

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

/// A success case: same exit code, byte-identical stdout and page. `page` is the absolute path both CLIs write.
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
    let got_page = take_page(page);
    page_diff(args, &got_page, &want_page);
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

/// The offline save shape `tests/saves.rs` uses: a main hand and an off hand, stats and skills.
fn offline_save() -> String {
    let stats = [
        "strength",
        "intelligence",
        "willpower",
        "agility",
        "endurance",
        "personality",
        "speed",
        "luck",
    ]
    .map(|k| format!("\"{k}\":50"))
    .join(",");
    let skills = (0..35)
        .map(|i| (40 + i % 10).to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"{{"name":"Fixture","level":{level},"raceId":1,"race":"Breton","gender":"female",
"reflexes":2,"health":90,"maxHealth":120,"magicka":30,"maxMagicka":80,
"stats":{{{stats}}},"skills":[{skills}],"masterSkills":true,"masteredSkills":[11,29],
"martialPath":"blademaster",
"items":[
{{"group":"Weapons","templateIndex":121,"equipSlot":19,"name":"Iron Longsword","material":9,"currentCondition":100,"maxCondition":100}},
{{"group":"Weapons","templateIndex":122,"equipSlot":21,"name":"Iron Dagger","material":9,"currentCondition":100,"maxCondition":100}}]}}"#,
        level = 30
    )
}

fn write_save(root: &Path) -> PathBuf {
    let folder = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&folder).expect("save folder");
    let file = folder.join("SaveData.txt");
    fs::write(&file, offline_save()).expect("save fixture");
    pin_mtime(&file);
    file
}

#[test]
fn report_theory_text_and_page_match_the_js() {
    let root = temp_root("theory");
    let page = root.join("theory.html");
    let out = page.to_str().unwrap();

    // The default report: no flags, so the theory `armoured` target is the gate.
    same(&["report", "--theory", "--out", out], &root, &page);
    // A boss with traits: the target block, the trait tags and the selected-trait table.
    same(
        &[
            "report",
            "--theory",
            "--target",
            "boss",
            "--health",
            "6000",
            "--traits",
            "curbing,warded",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    // The classic core and a named passive: the ruleset rows and the class arm.
    same(
        &[
            "report",
            "--theory",
            "--core",
            "classic",
            "--passive",
            "blademaster",
            "--target",
            "human",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    // A theory blade/material override plus a gap raise, a named swing and the paired arm.
    same(
        &[
            "report",
            "--theory",
            "--weapon",
            "121:5",
            "--gear-lb",
            "20",
            "--gear-cs",
            "5",
            "--swing",
            "StrikeLeft",
            "--pair",
            "--players",
            "2",
            "--blow-x",
            "2",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    // The offhand arm and the potency/pierce scenario knobs.
    same(
        &[
            "report",
            "--theory",
            "--dual",
            "--potency",
            "10",
            "--pierce",
            "5",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn report_threads_the_shipped_build_into_the_page() {
    // `src/cli.js:2286` threads `scenario.gameBuild` into `buildReport`, and `report.js:30` adds the flat row. Both
    // sides are compared byte for byte, so this pins the wiring and the row in one go.
    let root = temp_root("game-build");
    let page = root.join("build.html");
    let out = page.to_str().unwrap();
    same(
        &["report", "--theory", "--game-build", "14631", "--out", out],
        &root,
        &page,
    );
    same(
        &["report", "--theory", "--game-build", "14512", "--out", out],
        &root,
        &page,
    );
    // The default is an explicit 14512 run: same page bytes.
    same(&["report", "--theory", "--out", out], &root, &page);
    // A command that does not read it refuses it by name, as `checkOutputFlags` does.
    let refusal = root.join("refused.html");
    same_usage(
        &[
            "report",
            "--game-build",
            "14513",
            "--out",
            refusal.to_str().unwrap(),
        ],
        &root,
        &refusal,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn report_from_an_imported_save_matches_the_js() {
    let root = temp_root("save");
    write_save(&root);
    let page = root.join("saved.html");
    let out = page.to_str().unwrap();

    same(&["report", "--out", out], &root, &page);
    // A save `--weapon` override reaches the scenario and the page.
    same(
        &[
            "report", "--weapon", "121:5", "--target", "boss", "--health", "4000", "--out", out,
        ],
        &root,
        &page,
    );
    // Offline rules and a named passive over the save body.
    same(
        &["report", "--offline", "--passive", "none", "--out", out],
        &root,
        &page,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn report_default_output_name_matches_the_js() {
    let root = temp_root("default-name");
    // Both CLIs run in the temp root, so the JS `dfo-dps-report.html` default lands there (never the checkout).
    for args in [
        &["report", "--theory"][..],
        // The default `--out` is already the report name: no per-command rename, unlike probe/graph.
        &["report", "--theory", "--out", "dfo-dps-report.html"][..],
    ] {
        let want = js_root(args, &root);
        assert_eq!(
            want.status.code(),
            Some(0),
            "js {args:?}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        let want_page = take_page(&root.join("dfo-dps-report.html"));
        let got = rust_root(args, &root);
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
            args,
            &take_page(&root.join("dfo-dps-report.html")),
            &want_page,
        );
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn report_refusals_match_the_js_where_they_can() {
    let root = temp_root("refusals");
    let page = root.join("report.html");
    let out = page.to_str().unwrap();
    // `--json` has no `report` branch: both sides refuse it by name (checkOutputFlags).
    same_usage(
        &["report", "--theory", "--json", "--out", out],
        &root,
        &page,
    );
    // A series flag is graph-only; the JS accepts and drops it, this slice refuses it by name (no page either side).
    let got = rust(
        &["report", "--theory", "--series", "stat:speed", "--out", out],
        &root,
    );
    assert_eq!(got.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&got.stderr)
            .contains("--series is not read by report; only graph reads it"),
        "rust: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert!(got.stdout.is_empty());
    assert!(!page.exists(), "no page on the refusal");
    let want = js(
        &["report", "--theory", "--series", "stat:speed", "--out", out],
        &root,
    );
    assert_eq!(want.status.code(), Some(0), "the JS accepts the flag");
    fs::remove_file(&page).expect("cleanup the JS page");
    // A bad trait is a flag-level refusal before the branch.
    same_usage(
        &["report", "--theory", "--traits", "nope", "--out", out],
        &root,
        &page,
    );
    // Extra positionals: the JS ignores them, this slice refuses them on purpose.
    let got = rust(&["report", "--theory", "extra", "--out", out], &root);
    assert_eq!(got.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&got.stderr).contains("unexpected positional argument"));
    assert!(!page.exists(), "no page for an extra positional");
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

/// The report page is create-only: no existing path is truncated - not the report's own imported save, not an
/// unrelated save-shaped file, not an older report, not a hard/symlink/dangling alias - where the JS truncates all.
#[test]
fn report_refuses_to_overwrite() {
    let root = temp_root("create-only");
    let save = write_save(&root);
    let save_text = fs::read(&save).expect("save fixture");

    // The imported save, named directly as the page path.
    assert_refused(
        &["report", "--out", save.to_str().unwrap()],
        &root,
        &save,
        &save_text,
    );

    // An unrelated save-shaped file and an existing report are refused and byte-identical.
    let unrelated = root.join("SaveData.txt");
    fs::write(&unrelated, "a game save the CLI must never touch").expect("save fixture");
    pin_mtime(&unrelated);
    assert_refused(
        &["report", "--theory", "--out", unrelated.to_str().unwrap()],
        &root,
        &unrelated,
        b"a game save the CLI must never touch",
    );
    let report = root.join("report.html");
    fs::write(&report, "an older report").expect("report fixture");
    pin_mtime(&report);
    assert_refused(
        &["report", "--theory", "--out", report.to_str().unwrap()],
        &root,
        &report,
        b"an older report",
    );

    // A page path that is a directory: the create-only opener refuses it and stdout stays empty.
    let got = rust(&["report", "--theory", "--out", "."], &root);
    assert_eq!(got.status.code(), Some(2), "rust page dir");
    assert!(
        String::from_utf8_lossy(&got.stderr).contains("cannot write "),
        "rust: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert!(got.stdout.is_empty(), "no card before a failed page write");

    // Unix aliases: a hard link, a symlink and a dangling symlink all exist to `O_EXCL`, so all are refused.
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let hard = root.join("hard.html");
        fs::hard_link(&save, &hard).expect("hard link fixture");
        assert_refused(
            &["report", "--out", hard.to_str().unwrap()],
            &root,
            &hard,
            &save_text,
        );
        assert_eq!(fs::read(&save).expect("save survives"), save_text);

        let link = root.join("link.html");
        symlink(&save, &link).expect("symlink fixture");
        assert_refused(
            &["report", "--out", link.to_str().unwrap()],
            &root,
            &link,
            &save_text,
        );
        assert_eq!(
            fs::read(&save).expect("the symlink target survives"),
            save_text
        );

        let dangling = root.join("dangling.html");
        symlink(root.join("never-written.html"), &dangling).expect("dangling fixture");
        let got = rust(
            &["report", "--theory", "--out", dangling.to_str().unwrap()],
            &root,
        );
        assert_eq!(got.status.code(), Some(2), "dangling symlink");
        assert!(
            String::from_utf8_lossy(&got.stderr).contains("EEXIST"),
            "a dangling symlink exists too: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert!(
            fs::symlink_metadata(&dangling).is_ok(),
            "the dangling symlink survives"
        );
        assert!(!root.join("never-written.html").exists());
        // Done asserting them: a symlink is never cacheable, so the later call must not see one.
        fs::remove_file(&dangling).expect("cleanup the dangling symlink");
        fs::remove_file(&link).expect("cleanup the symlink");
        fs::remove_file(&hard).expect("cleanup the hard link");
    }

    // What the deviation protects: the JS truncates the save it imported into a page.
    let want = js(&["report", "--out", save.to_str().unwrap()], &root);
    assert_eq!(want.status.code(), Some(0), "js overwrite fixture");
    assert!(
        fs::read_to_string(&save)
            .expect("the JS wrote its page")
            .starts_with("<!doctype html>"),
        "the JS overwrote the imported save with its page"
    );

    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn help_lists_the_report_command() {
    let root = temp_root("help");
    let got = rust(&["--help"], &root);
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    assert!(text.contains("dfo-cli report"), "help names the report");
    assert!(text.contains("report written:"), "help describes the line");
    fs::remove_dir_all(&root).expect("cleanup");
}
