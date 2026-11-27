//! The R8 `enchant-plan` / `gear-plan` command, differentially against the real JS CLI.
//!
//! Every success case runs `bin/dfo-dps.js` and the Rust binary with the same arguments under a temp `DAGGER_USER_DATA`
//! root, then compares stdout byte for byte and the written page byte for byte. The JS is the oracle: a port that
//! drifts from `src/cli.js:1084-1217` fails here. The card, `--json` and page renderers themselves are pinned by
//! `tests/enchant_plan.rs`; this file pins the command around them - the flag resolution, the mode select, the `--json`
//! document, the output names, the create-only writer and the refusals.
//!
//! Both programs are run in the same directory with an explicit `--out` except for the default-name cases, because the
//! JS `writeFileSync` truncates an existing page while this CLI is create-only (the one deliberate difference, shared
//! with `probe`/`graph`/`report`/`imprints`).
//!
//! Nothing reads a real save or a real `SPELLS.STD`: one fixture writes a two-record synthetic `SPELLS.STD` and the
//! launcher's `config.json` under the temp root, so the strike procs and the imprint line price a real book. A missing
//! `node` panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::{js_root as js, pin_mtime, rust_root as rust, take_page, temp_root};

use std::fs;
use std::path::Path;

fn page_diff(args: &[&str], got: &[u8], want: &[u8]) {
    if got == want {
        return;
    }
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

/// A text success case: byte-identical stdout (card plus `... page written:`) and page.
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

/// A `--json` success case: byte-identical stdout (the document) and page.
fn same_json(args: &[&str], root: &Path, page: &Path) {
    same(args, root, page);
}

/// One 89-byte `SPELLS.STD` record (field for field as `src/spells.js:24-50` reads it).
type SpellEffect = (i8, i8, u8, u8, u8, u8, u8, u8, u8, u8);

fn spell_record(index: u8, name: &str, element: u8, effects: &[SpellEffect]) -> Vec<u8> {
    let mut b = vec![0u8; 0x59];
    for i in 0..3 {
        let (t, st) = effects.get(i).map_or((-1, -1), |e| (e.0, e.1));
        b[2 * i] = t as u8;
        b[2 * i + 1] = st as u8;
    }
    b[6] = element;
    b[8..10].copy_from_slice(&12u16.to_le_bytes());
    for (i, e) in effects.iter().enumerate() {
        b[14 + 3 * i] = e.2;
        b[15 + 3 * i] = e.3;
        b[16 + 3 * i] = e.4;
        b[32 + 5 * i] = e.5;
        b[33 + 5 * i] = e.6;
        b[34 + 5 * i] = e.7;
        b[35 + 5 * i] = e.8;
        b[36 + 5 * i] = e.9;
    }
    let bytes = name.as_bytes();
    b[47..47 + bytes.len().min(25)].copy_from_slice(&bytes[..bytes.len().min(25)]);
    b[73] = index;
    b
}

/// `Tinker's Glow` (7) and `Rime Pip` (16), two of the twelve Cast When Strikes ids, so the weapon's proc row and the
/// rating table price real spells. An instant DamageHealth and a ContinuousDamageHealth DoT.
fn spells_std() -> Vec<u8> {
    [
        spell_record(7, "Tinker's Glow", 4, &[(4, 0, 0, 0, 1, 30, 45, 0, 0, 1)]),
        spell_record(16, "Rime Pip", 4, &[(1, 0, 2, 1, 1, 8, 14, 0, 0, 1)]),
    ]
    .concat()
}

fn write_spellbook(root: &Path) {
    let arena = root.join("ARENA2");
    fs::create_dir_all(&arena).expect("arena dir");
    fs::write(arena.join("SPELLS.STD"), spells_std()).expect("synthetic SPELLS.STD");
    fs::write(
        root.join("config.json"),
        format!(
            r#"{{"arena2Path":"{}"}}"#,
            arena.to_string_lossy().replace('\\', "\\\\")
        ),
    )
    .expect("launcher config");
    // One stamp for both: no assertion here depends on which of the config and the book is newer.
    pin_mtime(&arena.join("SPELLS.STD"));
    pin_mtime(&root.join("config.json"));
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

#[test]
fn the_single_plan_text_and_page_match_the_js() {
    let root = temp_root("single");
    let page = root.join("plan.html");
    let out = page.to_str().unwrap().to_owned();
    // The defaults: no launcher config, so the empty book prices no proc and the header still names the shield template.
    same(&["enchant-plan", "--theory", "--out", &out], &root, &page);
    // `gear-plan` is the same branch (`cmd === 'enchant-plan' || cmd === 'gear-plan'`).
    same(&["gear-plan", "--theory", "--out", &out], &root, &page);
    // Every branch option at once: the soul gem, three repairs and two regens, another Potent Vs group, no shield.
    same(
        &[
            "enchant-plan",
            "--theory",
            "--shield",
            "none",
            "--soul-gem",
            "--repairs",
            "3",
            "--regen",
            "2",
            "--group",
            "undead",
            "--out",
            &out,
        ],
        &root,
        &page,
    );
    // The uncapped mode (the tough reference foe, weapon skill and Critical Strike forced) on a one-handed blade.
    same(
        &[
            "enchant-plan",
            "--theory",
            "--uncapped",
            "--weapon",
            "121",
            "--out",
            &out,
        ],
        &root,
        &page,
    );
    // `--cap-aware` names the default mode explicitly, and a named shield template.
    same(
        &[
            "enchant-plan",
            "--theory",
            "--cap-aware",
            "--weapon",
            "118",
            "--shield",
            "109",
            "--out",
            &out,
        ],
        &root,
        &page,
    );
    // The branch lower-cases both `--shield` and `--group`; `--repairs 0` places no mend row.
    same(
        &[
            "enchant-plan",
            "--theory",
            "--group",
            "ANIMAL",
            "--shield",
            "NONE",
            "--repairs",
            "0",
            "--out",
            &out,
        ],
        &root,
        &page,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_single_plan_with_a_synthetic_book_matches_the_js() {
    let root = temp_root("book");
    write_spellbook(&root);
    let page = root.join("book.html");
    let out = page.to_str().unwrap().to_owned();
    same(
        &["enchant-plan", "--theory", "--weapon", "121", "--out", &out],
        &root,
        &page,
    );
    same(
        &[
            "enchant-plan",
            "--theory",
            "--weapon",
            "118",
            "--soul-gem",
            "--uncapped",
            "--group",
            "animal",
            "--out",
            &out,
        ],
        &root,
        &page,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_single_plan_json_matches_the_js() {
    let root = temp_root("json");
    write_spellbook(&root);
    let page = root.join("rows.html");
    let out = page.to_str().unwrap().to_owned();
    for args in [
        vec!["enchant-plan", "--theory", "--json", "--out", &out],
        vec![
            "enchant-plan",
            "--theory",
            "--weapon",
            "121",
            "--soul-gem",
            "--group",
            "humanoid",
            "--json",
            "--out",
            &out,
        ],
    ] {
        same_json(&args, &root, &page);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_all_plans_text_json_and_page_match_the_js() {
    let root = temp_root("all");
    write_spellbook(&root);
    let page = root.join("plans.html");
    let out = page.to_str().unwrap().to_owned();
    // Both matrices: six families each, the summary table and the canonical melee layout per mode.
    same(
        &["enchant-plan", "--theory", "--all", "--out", &out],
        &root,
        &page,
    );
    // `--all` with the soul gem, the repairs/regen counts and another group.
    same(
        &[
            "enchant-plan",
            "--theory",
            "--all",
            "--soul-gem",
            "--repairs",
            "2",
            "--regen",
            "1",
            "--group",
            "undead",
            "--out",
            &out,
        ],
        &root,
        &page,
    );
    // `--json` prints the one document the branch's `console.log(JSON.stringify(...))` does.
    same_json(
        &["gear-plan", "--theory", "--all", "--json", "--out", &out],
        &root,
        &page,
    );
    // `--uncapped --all` selects the uncapped mode alone (`values.uncapped ? [allModes[0]] : ... values.all ? ...`).
    same(
        &[
            "enchant-plan",
            "--theory",
            "--all",
            "--uncapped",
            "--out",
            &out,
        ],
        &root,
        &page,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_default_output_names_match_the_js() {
    for (args, name) in [
        (&["enchant-plan", "--theory"][..], "enchant-plan.html"),
        (&["gear-plan", "--theory"][..], "enchant-plan.html"),
        (
            &["enchant-plan", "--theory", "--all"][..],
            "enchant-plans.html",
        ),
        (
            &[
                "enchant-plan",
                "--theory",
                "--all",
                "--out",
                "dfo-dps-report.html",
            ][..],
            "enchant-plans.html",
        ),
        (
            &["enchant-plan", "--theory", "--out", "dfo-dps-report.html"][..],
            "enchant-plan.html",
        ),
    ] {
        let root = temp_root("names");
        let page = root.join(name);
        same(args, &root, &page);
        fs::remove_dir_all(&root).expect("cleanup");
    }
}

#[test]
fn enchant_plan_refusals_match_the_js() {
    let root = temp_root("refusals");
    let page = root.join("plan.html");
    let out = page.to_str().unwrap().to_owned();
    // An unknown Potent Vs group is the JS stderr line and exit 2, before any page is written. The JS checks it only
    // when that branch runs, so `--group` is accepted elsewhere; this CLI refuses the flag outside the branch instead.
    let want = js(
        &["enchant-plan", "--theory", "--group", "nope", "--out", &out],
        &root,
    );
    assert_eq!(want.status.code(), Some(2), "js group");
    let got = rust(
        &["enchant-plan", "--theory", "--group", "nope", "--out", &out],
        &root,
    );
    assert_eq!(got.status.code(), Some(2), "rust group");
    assert_eq!(
        String::from_utf8_lossy(&got.stderr).trim_end(),
        String::from_utf8_lossy(&want.stderr).trim_end(),
        "the group refusal line differs"
    );
    assert!(!page.exists(), "no page for an unknown group");
    // `--shield` is validated globally by `validateFlags` (every command), with the same message.
    for args in [
        &[
            "enchant-plan",
            "--theory",
            "--shield",
            "nope",
            "--out",
            &out,
        ][..],
        &["build", "--theory", "--shield", "nope"][..],
    ] {
        let want = js(args, &root);
        assert_eq!(want.status.code(), Some(2), "js {args:?}");
        let got = rust(args, &root);
        assert_eq!(got.status.code(), Some(2), "rust {args:?}");
        assert_eq!(
            String::from_utf8_lossy(&got.stderr).trim_end(),
            String::from_utf8_lossy(&want.stderr).trim_end(),
            "stderr differs for {args:?}"
        );
        assert!(got.stdout.is_empty(), "no stdout for {args:?}");
        assert!(!page.exists(), "no page for {args:?}");
    }
    // The branch's own flags are refused by name outside it; the JS accepts and ignores them.
    for (args, refusal) in [
        (
            &["imprints", "--shield", "none", "--out", &out][..],
            "--shield is not read by imprints; enchant-plan and gear-plan read it",
        ),
        (
            &["build", "--theory", "--soul-gem"][..],
            "--soul-gem is not read by build; enchant-plan and gear-plan read it",
        ),
        (
            &["imprints", "--group", "daedra", "--out", &out][..],
            "--group is not read by imprints; enchant-plan and gear-plan read it",
        ),
        (
            &["build", "--theory", "--repairs", "2"][..],
            "--repairs is not read by build; enchant-plan and gear-plan read it",
        ),
        (
            &["build", "--theory", "--regen", "2"][..],
            "--regen is not read by build; enchant-plan and gear-plan read it",
        ),
    ] {
        let got = rust(args, &root);
        assert_eq!(got.status.code(), Some(2), "rust {args:?}");
        assert!(
            String::from_utf8_lossy(&got.stderr).contains(refusal),
            "rust {args:?}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert!(!page.exists(), "no page for {args:?}");
    }
    // Extra positionals: the JS ignores them, this slice refuses them on purpose.
    let got = rust(&["enchant-plan", "extra", "--out", &out], &root);
    assert_eq!(got.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&got.stderr).contains("unexpected positional argument"));
    assert!(!page.exists(), "no page for an extra positional");
    fs::remove_dir_all(&root).expect("cleanup");
}

/// Both the single plan and the two-mode `--all` page are create-only: no existing path is truncated - an older report,
/// a save-shaped file, a hard link, a symlink and a directory - where the JS truncates all of them.
#[test]
fn enchant_plan_refuses_to_overwrite() {
    let root = temp_root("create-only");
    for args_for in [
        &["enchant-plan", "--theory"][..],
        &["gear-plan", "--theory", "--all"][..],
    ] {
        let report = root.join("older.html");
        let _ = fs::remove_file(&report);
        fs::write(&report, "an older report").expect("report fixture");
        pin_mtime(&report);
        let mut args = args_for.to_vec();
        let path = report.to_str().unwrap();
        args.extend(["--out", path]);
        assert_refused(&args, &root, &report, b"an older report");
        let _ = fs::remove_file(&report);

        let save = root.join("SaveData.txt");
        fs::write(&save, "a game save the CLI must never touch").expect("save fixture");
        pin_mtime(&save);
        let mut args = args_for.to_vec();
        args.extend(["--out", save.to_str().unwrap()]);
        assert_refused(&args, &root, &save, b"a game save the CLI must never touch");

        // A page path that is a directory: the create-only opener refuses it and stdout stays empty.
        let mut args = args_for.to_vec();
        args.extend(["--out", "."]);
        let got = rust(&args, &root);
        assert_eq!(got.status.code(), Some(2), "rust page dir {args:?}");
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
            let _ = fs::remove_file(&hard);
            fs::hard_link(&target, &hard).expect("hard link fixture");
            let mut args = args_for.to_vec();
            args.extend(["--out", hard.to_str().unwrap()]);
            assert_refused(&args, &root, &hard, &before);
            let _ = fs::remove_file(&hard);
            let link = root.join("link.html");
            let _ = fs::remove_file(&link);
            symlink(&target, &link).expect("symlink fixture");
            let mut args = args_for.to_vec();
            args.extend(["--out", link.to_str().unwrap()]);
            assert_refused(&args, &root, &link, &before);
            let _ = fs::remove_file(&link);
            let dangling = root.join("dangling.html");
            let _ = fs::remove_file(&dangling);
            symlink(root.join("never-written.html"), &dangling).expect("dangling fixture");
            let mut args = args_for.to_vec();
            args.extend(["--out", dangling.to_str().unwrap()]);
            let got = rust(&args, &root);
            assert_eq!(got.status.code(), Some(2), "dangling symlink");
            assert!(
                String::from_utf8_lossy(&got.stderr).contains("EEXIST"),
                "a dangling symlink exists too: {}",
                String::from_utf8_lossy(&got.stderr)
            );
            assert_eq!(fs::read(&target).expect("target survives"), before);
            let _ = fs::remove_file(&dangling);
            let _ = fs::remove_file(&target);
        }
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn alias_commands_write_the_same_page() {
    // `enchant-plan` and `gear-plan` share one branch, so both must produce the same bytes (and the same stdout line).
    let root = temp_root("alias");
    let page = root.join("alias.html");
    let out = page.to_str().unwrap().to_owned();
    let want = js(&["enchant-plan", "--theory", "--out", &out], &root);
    assert_eq!(want.status.code(), Some(0), "js");
    let want_page = take_page(&page);
    let gear = js(&["gear-plan", "--theory", "--out", &out], &root);
    assert_eq!(gear.status.code(), Some(0), "js gear-plan");
    assert_eq!(
        gear.stdout, want.stdout,
        "the JS itself treats the alias alike"
    );
    let gear_page = take_page(&page);
    page_diff(&["gear-plan", "--theory"], &gear_page, &want_page);

    let rust_plan = rust(&["enchant-plan", "--theory", "--out", &out], &root);
    assert_eq!(rust_plan.status.code(), Some(0), "rust enchant-plan");
    let rust_page = take_page(&page);
    assert_eq!(
        rust_plan.stdout, want.stdout,
        "the alias's card must be the same bytes"
    );
    page_diff(&["enchant-plan", "--theory"], &rust_page, &want_page);

    let rust_gear = rust(&["gear-plan", "--theory", "--out", &out], &root);
    assert_eq!(rust_gear.status.code(), Some(0), "rust gear-plan");
    assert_eq!(
        rust_gear.stdout, rust_plan.stdout,
        "gear-plan and enchant-plan print the same card"
    );
    page_diff(&["gear-plan", "--theory"], &take_page(&page), &want_page);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn help_lists_both_plan_commands() {
    let root = temp_root("help");
    let got = rust(&["--help"], &root);
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    for flag in [
        "dfo-forge enchant-plan",
        "dfo-forge gear-plan",
        "--shield <template|none|auto>",
        "--soul-gem",
        "--group <undead|daedra|humanoid|animal>",
        "--repairs <n>",
        "--regen <n>",
        "enchant plan written:",
        "enchant plans page written:",
        "enchant-plan.html",
        "enchant-plans.html",
    ] {
        assert!(text.contains(flag), "help names {flag}");
    }
    fs::remove_dir_all(&root).expect("cleanup");
}
