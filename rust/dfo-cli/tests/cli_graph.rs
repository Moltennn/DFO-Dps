//! The R8 `graph` command, differentially against the real JS CLI over synthetic fixtures.
//!
//! Each case runs `bin/dfo-dps.js graph ...` and the Rust binary with the same arguments, then compares stdout (the
//! `graph written:` line or the `--json` series document) and the written page byte for byte. The page goes through the
//! shared renderer (`src/graph.rs`), so this pins the whole command, not only the primitives `tests/graph.rs` covers.
//!
//! The write is create-only (the deliberate deviation `probe` pinned): an existing output path is refused with exit 2
//! and left byte-identical - the graph's own save, an unrelated save-shaped fixture, an earlier report, a hard link, a
//! symlink and a dangling symlink. The JS `writeFileSync` truncates all of them; `graph_refuses_to_overwrite` shows both
//! sides of that difference.
//!
//! Every fixture is built here (never a real save) and lives under a temp `DAGGER_USER_DATA` root, so neither CLI reads
//! the player's data. A missing `node` panics rather than skips: a skipped differential proves nothing.

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

/// A success case: same exit code, byte-identical stdout, byte-identical page. `page` is the absolute path both CLIs
/// write (`graph.html` is only the JS default name, so every case passes `--out`).
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

/// A save folder `SaveData.txt` under the temp root, named so discovery picks it.
fn write_save(root: &Path) -> PathBuf {
    let folder = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&folder).expect("save folder");
    let file = folder.join("SaveData.txt");
    fs::write(&file, offline_save()).expect("save fixture");
    pin_mtime(&file);
    file
}

#[test]
fn graph_theory_text_and_page_match_the_js() {
    let root = temp_root("theory");
    let page = root.join("graph.html");

    // The default series pair, at the default 50..100 range and step 10.
    same(
        &["graph", "--theory", "--out", page.to_str().unwrap()],
        &root,
        &page,
    );
    // Every series kind, with explicit ranges and a fractional step.
    same(
        &[
            "graph",
            "--theory",
            "--series",
            "stat:speed,skill:29,gear:29,star:strength",
            "--from",
            "0",
            "--to",
            "12",
            "--step",
            "2.5",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    // Uncapped, plus the subtitle flags the JS echoes as typed.
    same(
        &[
            "graph",
            "--theory",
            "--series",
            "stat:strength",
            "--from",
            "80",
            "--to",
            "90",
            "--uncapped",
            "--bare",
            "--no-effects",
            "--base-stats",
            "60",
            "--target",
            "boss",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    // A reversed range has no points; the chart still renders, and the series document keeps the empty list.
    same(
        &[
            "graph",
            "--theory",
            "--series",
            "stat:strength",
            "--from",
            "100",
            "--to",
            "50",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    // `--from`/`--to` are finite-number flags in this version: a non-numeric value is refused before the branch.
    same_usage(
        &[
            "graph",
            "--theory",
            "--series",
            "stat:speed",
            "--to",
            "abc",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    // A fractional step is taken as given: the range points are rounded to two decimals and `to` is appended.
    same(
        &[
            "graph",
            "--theory",
            "--series",
            "skill:29,gear:34,star:luck",
            "--from",
            "0",
            "--to",
            "30",
            "--step",
            "7.5",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    // The theory `armoured` remap: the page subtitle keeps the typed preset, the body is the gate.
    same(
        &[
            "graph",
            "--theory",
            "--series",
            "stat:luck",
            "--to",
            "60",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    // A fractional skill id passes the JS range check but writes an array named property no analysis reads: its curve
    // is flat. The label keeps `String(Number(idRaw))`.
    same(
        &[
            "graph",
            "--theory",
            "--series",
            "skill:29.5,gear:34.25",
            "--from",
            "0",
            "--to",
            "4",
            "--step",
            "2",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    // `skill:` is `Number("")` = skill 0, a real id; a third colon segment is dropped by the JS destructuring; a
    // mixed-case kind and a mixed-case stat name take the JS lower-case normalisation. `gear:3` has no folded mod on
    // the theory sheet, so its default range is `0..100` (`_mods.skills?.[id] ?? 0`). An unknown stat name is not
    // validated by the JS either: it writes a key no analysis reads, so that curve is flat.
    same(
        &[
            "graph",
            "--theory",
            "--series",
            "skill:,STAT:Strength:ignored,Gear:20,gear:3, stat:speed,stat:charisma , ",
            "--from",
            "40",
            "--to",
            "44",
            "--step",
            "2",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    // A boss target with traits: the subtitle carries the grouped health and the scenario carries the traits.
    same(
        &[
            "graph",
            "--theory",
            "--series",
            "stat:strength",
            "--target",
            "boss",
            "--health",
            "1200",
            "--traits",
            "curbing,wrathful",
            "--to",
            "60",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    // A theory `--weapon` is applied when the character is built (the scenario's weapon stays undefined), and the
    // subtitle keeps the blade the theory character carries.
    same(
        &[
            "graph",
            "--theory",
            "--series",
            "stat:speed",
            "--to",
            "70",
            "--weapon",
            "121:5",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    // An empty `--series` is a present value (only nullish falls back to the default pair): no curves at all.
    same(
        &[
            "graph",
            "--theory",
            "--series",
            "",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn graph_json_matches_the_js() {
    let root = temp_root("json");
    let page = root.join("series.html");
    for args in [
        &["graph", "--theory", "--json"][..],
        &[
            "graph",
            "--theory",
            "--json",
            "--series",
            "stat:speed",
            "--to",
            "70",
        ][..],
        &[
            "graph",
            "--theory",
            "--json",
            "--series",
            "skill:29,gear:34,star:agility",
            "--from",
            "1",
            "--to",
            "9",
            "--step",
            "3",
        ][..],
        &[
            "graph",
            "--theory",
            "--json",
            "--series",
            "stat:strength",
            "--from",
            "100",
            "--to",
            "50",
        ][..],
        // An empty `--series` is a present value: no curves, and `[]` is the whole JSON document.
        &["graph", "--theory", "--json", "--series", ""][..],
    ] {
        let mut full: Vec<&str> = args.to_vec();
        let out = page.to_str().unwrap().to_owned();
        full.push("--out");
        full.push(&out);
        same(&full, &root, &page);
        assert!(
            !page.exists(),
            "the page is removed after the comparison, not asserted here"
        );
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_shipped_build_reaches_the_graph_scenario() {
    // `src/cli.js:2057-2127`: `graph` prices its series through `scenarioOf`, so `--game-build` must reach it.
    let root = temp_root("game-build");
    let page = root.join("drift.html");
    let out = page.to_str().unwrap();
    same(
        &[
            "graph",
            "--theory",
            "--game-build",
            "14631",
            "--series",
            "stat:strength",
            "--from",
            "0",
            "--to",
            "20",
            "--step",
            "10",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    same(
        &[
            "graph",
            "--theory",
            "--series",
            "stat:strength",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn help_lists_the_graph_command() {
    let got = rust(&["--help"], &temp_root("help"));
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    for flag in [
        "dfo-cli graph",
        "--series <spec,...>",
        "--uncapped",
        "--step <n>",
    ] {
        assert!(text.contains(flag), "help names {flag}");
    }
}

#[test]
fn graph_default_output_name_matches_the_js() {
    let root = temp_root("default-name");
    // Both CLIs run in the temp root, so the JS `graph.html` default lands there (never the checkout).
    for args in [
        &["graph", "--theory"][..],
        // The JS default `--out` value is the report name; `graph` renames it to `graph.html`.
        &["graph", "--theory", "--out", "dfo-dps-report.html"][..],
        &["graph", "--theory", "--json"][..],
    ] {
        let want = js_root(args, &root);
        assert_eq!(
            want.status.code(),
            Some(0),
            "js {args:?}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        let want_page = take_page(&root.join("graph.html"));
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
        page_diff(args, &take_page(&root.join("graph.html")), &want_page);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn graph_from_an_imported_save_matches_the_js() {
    let root = temp_root("save");
    write_save(&root);
    let page = root.join("saved.html");
    same(
        &[
            "graph",
            "--series",
            "stat:strength,skill:29,gear:29",
            "--to",
            "80",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    same(
        &[
            "graph",
            "--json",
            "--series",
            "star:speed,gear:34",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    // A save `--weapon` override reaches the scenario, so the curve prices the named blade.
    same(
        &[
            "graph",
            "--series",
            "stat:speed",
            "--to",
            "70",
            "--weapon",
            "121:5",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    // `--offline` changes the imported rule set and the subtitle's rules word; `--core` keeps its typed case in the
    // subtitle while the scenario lower-cases it.
    same(
        &[
            "graph",
            "--offline",
            "--core",
            "Classic",
            "--series",
            "stat:strength,skill:29",
            "--to",
            "60",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    // A named passive and a target preset over the save body.
    same(
        &[
            "graph",
            "--passive",
            "none",
            "--target",
            "boss",
            "--health",
            "4000",
            "--series",
            "stat:agility",
            "--to",
            "60",
            "--json",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
        &page,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn graph_refusals_match_the_js_where_they_can() {
    let root = temp_root("refusals");
    let page = root.join("graph.html");
    let out = page.to_str().unwrap();
    for args in [
        &["graph", "--theory", "--series", "speed", "--out", out][..],
        &["graph", "--theory", "--series", "stat:", "--out", out][..],
        &["graph", "--theory", "--series", "stat", "--out", out][..],
        &["graph", "--theory", "--series", "skill:35", "--out", out][..],
        &["graph", "--theory", "--series", "skill", "--out", out][..],
        &["graph", "--theory", "--series", "skill:abc", "--out", out][..],
        &["graph", "--theory", "--series", "gear:-1", "--out", out][..],
        &["graph", "--theory", "--series", "star:", "--out", out][..],
        &[
            "graph",
            "--theory",
            "--series",
            "star:charisma",
            "--out",
            out,
        ][..],
        &[
            "graph",
            "--theory",
            "--series",
            "stat:strength",
            "--step",
            "0",
            "--out",
            out,
        ][..],
        &[
            "graph",
            "--theory",
            "--series",
            "stat:strength",
            "--from",
            "abc",
            "--out",
            out,
        ][..],
    ] {
        same_usage(args, &root, &page);
    }
    // Extra positionals: the JS ignores them, this slice refuses them on purpose.
    let got = rust(&["graph", "--theory", "extra", "--out", out], &root);
    assert_eq!(got.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&got.stderr).contains("unexpected positional argument"));
    assert!(!page.exists(), "no page for an extra positional");
    fs::remove_dir_all(&root).expect("cleanup");
}

/// The graph-only flags are refused by name on the other ported commands (the JS accepts and drops them); a flag-level
/// number check still runs first, as `validateFlags` does before the branch.
#[test]
fn graph_flags_are_refused_elsewhere() {
    let root = temp_root("boundary");
    for (args, refusal) in [
        (
            &["build", "--theory", "--series", "stat:speed"][..],
            "--series is not read by build; only graph reads it",
        ),
        (
            &["rank", "--theory", "--uncapped"][..],
            "--uncapped is not read by rank; graph, imprints, enchant-plan, gear-plan, loadout and real-dps read it",
        ),
        (
            &["build", "--theory", "--from", "10"][..],
            "--from is not read by build; graph and scale read it",
        ),
        (
            &["build", "--theory", "--to", "10"][..],
            "--to is not read by build; graph and scale read it",
        ),
        (
            &["build", "--theory", "--step", "10"][..],
            "--step is not read by build; graph and scale read it",
        ),
    ] {
        let got = rust(args, &root);
        assert_eq!(got.status.code(), Some(2), "rust {args:?}");
        assert!(
            String::from_utf8_lossy(&got.stderr).contains(refusal),
            "rust {args:?}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert!(got.stdout.is_empty(), "no card for {args:?}");
        // The JS accepts all of them, so only the refusal is pinned here.
        let want = js(args, &root);
        assert_eq!(want.status.code(), Some(0), "js {args:?}");
    }
    // `--step 0` is a flag-level refusal on both sides (numFlag runs before the command branch).
    let got = rust(&["build", "--theory", "--step", "0"], &root);
    let want = js(&["build", "--theory", "--step", "0"], &root);
    assert_eq!(got.status.code(), Some(2));
    assert_eq!(want.status.code(), Some(2));
    assert_eq!(
        String::from_utf8_lossy(&got.stderr).trim_end(),
        String::from_utf8_lossy(&want.stderr).trim_end()
    );
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

/// The graph page is create-only: no existing path is truncated - not the graph's own save, not an unrelated
/// save-shaped file, not an older report, not a hard/symlink/dangling alias - where the JS would truncate all of them.
#[test]
fn graph_refuses_to_overwrite() {
    let root = temp_root("create-only");
    let save = write_save(&root);
    let save_text = fs::read(&save).expect("save fixture");

    // The imported save, named directly as the page path.
    assert_refused(
        &["graph", "--out", save.to_str().unwrap()],
        &root,
        &save,
        &save_text,
    );

    // An unrelated save-shaped file and an existing report are refused and byte-identical.
    let unrelated = root.join("SaveData.txt");
    fs::write(&unrelated, "a game save the CLI must never touch").expect("save fixture");
    pin_mtime(&unrelated);
    assert_refused(
        &["graph", "--theory", "--out", unrelated.to_str().unwrap()],
        &root,
        &unrelated,
        b"a game save the CLI must never touch",
    );
    let report = root.join("graph.html");
    fs::write(&report, "an older graph").expect("report fixture");
    pin_mtime(&report);
    assert_refused(
        &["graph", "--theory", "--out", report.to_str().unwrap()],
        &root,
        &report,
        b"an older graph",
    );

    // A page path that is a directory: the create-only opener sees "already exists" and refuses with exit 2, and stdout
    // stays empty. The JS opens the directory and fails with EISDIR; both refuse the same input, with different words.
    let got = rust(&["graph", "--theory", "--out", "."], &root);
    assert_eq!(got.status.code(), Some(2), "rust page dir");
    assert!(
        String::from_utf8_lossy(&got.stderr).contains("cannot write "),
        "rust: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert!(got.stdout.is_empty(), "no card before a failed page write");
    // The same directory path, spelled absolutely: the JS call's cwd is the checkout, so "." would be an argv path
    // outside the fixture root (and the refusal is the same either way).
    let dir_path = root.to_str().expect("utf-8 fixture path");
    let want = js(&["graph", "--theory", "--out", dir_path], &root);
    assert_eq!(want.status.code(), Some(2), "js page dir");

    // Unix aliases: a hard link, a symlink and a dangling symlink all exist to `O_EXCL`, so all are refused.
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let hard = root.join("hard.html");
        fs::hard_link(&save, &hard).expect("hard link fixture");
        assert_refused(
            &["graph", "--out", hard.to_str().unwrap()],
            &root,
            &hard,
            &save_text,
        );
        assert_eq!(fs::read(&save).expect("save survives"), save_text);

        let link = root.join("link.html");
        symlink(&save, &link).expect("symlink fixture");
        assert_refused(
            &["graph", "--out", link.to_str().unwrap()],
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
            &["graph", "--theory", "--out", dangling.to_str().unwrap()],
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
        // Done asserting them: a symlink or a hard link is never cacheable, so the later call must not see one.
        fs::remove_file(&dangling).expect("cleanup the dangling symlink");
        fs::remove_file(&link).expect("cleanup the symlink");
        fs::remove_file(&hard).expect("cleanup the hard link");
    }

    // What the deviation protects: the JS truncates the save it imported into a page.
    let want = js(&["graph", "--out", save.to_str().unwrap()], &root);
    assert_eq!(want.status.code(), Some(0), "js overwrite fixture");
    assert!(
        fs::read_to_string(&save)
            .expect("the JS wrote its page")
            .starts_with("<!doctype html>"),
        "the JS overwrote the imported save with its page"
    );

    fs::remove_dir_all(&root).expect("cleanup");
}
