//! The R8 plural `spells` command, end to end against the real JS CLI over synthetic `SPELLS.STD` data.
//!
//! Every success case runs `bin/dfo-dps.js spells ...` and the Rust binary on the same arguments under one temp
//! `DAGGER_USER_DATA` root, then compares stdout, the exit code and the written page byte for byte. The book is a
//! synthetic `SPELLS.STD` written here (never the machine's ARENA2), reached either through an explicit `--data <dir>`
//! or the launcher's `config.json` -> `arena2Path` fallback, and the custom records come from a synthetic save under
//! `Saves/SAVE1/SaveData.txt` (never a real save).
//!
//! The pool is the branch's merge (`src/cli.js:1485`): every standard record in the book's order, then the save's custom
//! records - the save's stock indices are dropped because the book already carries them. The cases pin that merge, the
//! `--json` list (with the page still written), the empty-book line (text and `--json`), the default page name, the
//! create-only writer's collision refusal, and the usage refusals.
//!
//! `tests/spells_report.rs` pins the renderer over the same synthetic book; this file pins the command around it. A
//! missing `node` panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::{js_root as js, pin_mtime, rust_root as rust, take_page, temp_root};

use std::fs;
use std::path::{Path, PathBuf};

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

/// A success case: same exit code, byte-identical stdout (the card and page-write line) and page.
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

/// A `--json` success case: same exit code, byte-identical stdout (the ranked list) and page.
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
        "the JSON list differs for {args:?}"
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

/// One effect as the record layout stores it: `(type, subType, durationBase, durationMod, durationPerLevel,
/// magnitudeBaseLow, magnitudeBaseHigh, magnitudeLevelBase, magnitudeLevelHigh, magnitudePerLevel)`.
type SpellEffect = (i8, i8, u8, u8, u8, u8, u8, u8, u8, u8);

/// One 89-byte `SPELLS.STD` record (`src/spells.js:24-50`, field for field as `tests/spell.rs` writes it).
fn spell_record(
    index: u8,
    name: &str,
    element: u8,
    range_type: u8,
    effects: &[SpellEffect],
) -> Vec<u8> {
    let mut b = vec![0u8; 0x59];
    for i in 0..3 {
        let (t, st) = effects.get(i).map_or((-1, -1), |e| (e.0, e.1));
        b[2 * i] = t as u8;
        b[2 * i + 1] = st as u8;
    }
    b[6] = element;
    b[7] = range_type;
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

/// The synthetic book: an instant bolt, a DoT, a debug name the list drops, a non-damage Shield (`damage > 0` drops
/// it), a range-scaled fire bolt, and twenty more damaging instants (`Spell 06`..`Spell 25`) so the page's
/// `slice(0, 20)` truncates and the ranking order is strictly increasing magnitude.
fn spells_std() -> Vec<u8> {
    let mut records: Vec<Vec<u8>> = vec![
        spell_record(1, "Bolt", 4, 0, &[(4, 0, 0, 0, 1, 10, 20, 0, 0, 1)]),
        spell_record(2, "Burn", 4, 0, &[(1, 0, 2, 1, 1, 4, 8, 0, 0, 1)]),
        spell_record(3, "Lvl 1 Probe", 4, 0, &[(4, 0, 0, 0, 1, 1, 3, 0, 0, 1)]),
        spell_record(4, "Shield", 4, 0, &[(35, -1, 0, 5, 1, 0, 0, 0, 0, 1)]),
        spell_record(5, "Far Bolt", 0, 2, &[(4, 0, 0, 0, 1, 20, 40, 1, 1, 2)]),
    ];
    for i in 0..20u8 {
        let name = format!("Spell {:02}", i + 6);
        let magnitude = 21 + i * 5;
        records.push(spell_record(
            i + 6,
            &name,
            4,
            0,
            &[(4, 0, 0, 0, 1, magnitude, magnitude, 0, 0, 1)],
        ));
    }
    records.concat()
}

/// `<root>/ARENA2/SPELLS.STD`, returning the directory for `--data`.
fn write_arena(root: &Path) -> PathBuf {
    let arena = root.join("ARENA2");
    fs::create_dir_all(&arena).expect("arena dir");
    fs::write(arena.join("SPELLS.STD"), spells_std()).expect("synthetic SPELLS.STD");
    pin_mtime(&arena.join("SPELLS.STD"));
    arena
}

/// The launcher's own shape: `config.json` -> `arena2Path`, so `standardSpells()` finds the book with no `--data`.
fn write_config(root: &Path, arena: &Path) {
    let path = arena.to_string_lossy().replace('\\', "\\\\");
    fs::write(
        root.join("config.json"),
        format!(r#"{{"arena2Path":"{path}"}}"#),
    )
    .expect("launcher config");
    pin_mtime(&root.join("config.json"));
}

/// A synthetic offline save whose `spells` hold two stock indices (1 and 2, which the branch's merge drops because the
/// book already supplies them) and two custom records (no `index`, so they survive the merge and print after the book).
fn save_with_spells() -> String {
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
    let skills = (0..35).map(|_| "60").collect::<Vec<_>>().join(",");
    format!(
        r#"{{"name":"Spell Fixture","level":20,"raceId":1,"race":"Breton","gender":"male",
"health":90,"maxHealth":120,"magicka":30,"maxMagicka":80,
"stats":{{{stats}}},"skills":[{skills}],"masterSkills":true,"masteredSkills":[22],
"martialPath":"blademaster","items":[],
"spells":[1,2,
{{"name":"Custom Zap","element":4,"rangeType":0,"effects":[
{{"type":4,"subType":0,"magnitudeBaseLow":6,"magnitudeBaseHigh":12,
"magnitudeLevelBase":0,"magnitudeLevelHigh":0,"magnitudePerLevel":1}}]}},
{{"name":"Custom Burn","element":4,"rangeType":0,"effects":[
{{"type":1,"subType":0,"durationBase":2,"durationMod":1,"durationPerLevel":1,
"magnitudeBaseLow":5,"magnitudeBaseHigh":5,"magnitudeLevelBase":0,"magnitudeLevelHigh":0,
"magnitudePerLevel":1}}]}}]}}"#
    )
}

fn write_save(root: &Path) {
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    fs::write(dir.join("SaveData.txt"), save_with_spells()).expect("fixture save");
    pin_mtime(&dir.join("SaveData.txt"));
}

#[test]
fn spells_text_and_page_match_the_js() {
    let root = temp_root("text");
    let arena = write_arena(&root);
    write_save(&root);
    write_config(&root, &arena);
    let page = root.join("spells.html");
    let out = page.to_str().unwrap();

    // The theory caster over the merged pool: the standard book, then the save's two custom records.
    same(&["spells", "--theory", "--out", out], &root, &page);
    same(
        &["spells", "--theory", "--save", "SAVE1", "--out", out],
        &root,
        &page,
    );
    // Scenario flags the branch reads.
    same(
        &[
            "spells",
            "--theory",
            "--level",
            "30",
            "--target",
            "soft",
            "--potency",
            "30",
            "--pierce",
            "10",
            "--seconds",
            "10",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    same(
        &[
            "spells",
            "--theory",
            "--cast-speed",
            "20",
            "--mana-limit",
            "--magicka",
            "50",
            "--seconds",
            "10",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    // A boss target prints its grouped HP in the subtitle.
    same(
        &[
            "spells", "--theory", "--target", "boss", "--health", "8000", "--out", out,
        ],
        &root,
        &page,
    );
    // `--save` without `--theory` uses the save's character and still merges the same book.
    same(&["spells", "--save", "SAVE1", "--out", out], &root, &page);
    // `--list`/`--all-spells`/`--standard`/`--spell` are ignored by this branch, exactly as the JS ignores them.
    for extra in [
        &["--list"][..],
        &["--all-spells"][..],
        &["--standard"][..],
        &["--spell", "Bolt"][..],
    ] {
        let mut args = vec!["spells", "--theory", "--out", out];
        args.extend(extra);
        same(&args, &root, &page);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn spells_json_and_page_match_the_js() {
    let root = temp_root("json");
    let arena = write_arena(&root);
    write_save(&root);
    write_config(&root, &arena);
    let page = root.join("rows.html");
    let out = page.to_str().unwrap();
    // The page is still written, and stdout is the ranked list.
    same_json(
        &["spells", "--theory", "--json", "--out", out],
        &root,
        &page,
    );
    same_json(
        &["spells", "--save", "SAVE1", "--json", "--out", out],
        &root,
        &page,
    );
    same_json(
        &[
            "spells",
            "--theory",
            "--level",
            "30",
            "--potency",
            "20",
            "--seconds",
            "10",
            "--json",
            "--out",
            out,
        ],
        &root,
        &page,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

/// The pool really is the branch's merge: the ranked list (which the page truncates to twenty rows) carries the custom
/// records only the save supplies, and the save's stock indices still resolve to the book's records once.
#[test]
fn the_pool_merges_standard_and_custom_records() {
    let root = temp_root("merge");
    let arena = write_arena(&root);
    write_save(&root);
    write_config(&root, &arena);
    let out = root.join("merge.html");
    // No `--theory`: the save supplies the character, so its custom records reach `resolveSpells`.
    let want = js(
        &[
            "spells",
            "--save",
            "SAVE1",
            "--json",
            "--out",
            out.to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(want.status.code(), Some(0));
    let list: serde_json::Value = serde_json::from_slice(&want.stdout).expect("the JS prints JSON");
    let rows = list.as_array().expect("a list");
    let names: Vec<&str> = rows
        .iter()
        .map(|r| r["name"].as_str().expect("a name"))
        .collect();
    // Every damaging standard record (24 minus the debug name and the Shield) plus the two custom records.
    assert_eq!(names.len(), 25, "{names:?}");
    assert!(
        names.contains(&"Custom Zap") && names.contains(&"Custom Burn"),
        "{names:?}"
    );
    assert!(
        !names.contains(&"Lvl 1 Probe") && !names.contains(&"Shield"),
        "{names:?}"
    );
    // The save's stock indices resolve to the book's records, so neither is listed twice.
    assert_eq!(
        names.iter().filter(|n| **n == "Bolt").count(),
        1,
        "{names:?}"
    );
    assert_eq!(
        names.iter().filter(|n| **n == "Burn").count(),
        1,
        "{names:?}"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn spells_default_output_name_matches_the_js() {
    let root = temp_root("default-name");
    let arena = write_arena(&root);
    write_config(&root, &arena);
    for args in [
        // `path.resolve(values.out === 'dfo-dps-report.html' ? 'spells.html' : values.out)`.
        &["spells", "--theory"][..],
        &["spells", "--theory", "--out", "dfo-dps-report.html"][..],
    ] {
        let want = js(args, &root);
        assert_eq!(
            want.status.code(),
            Some(0),
            "js {args:?}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        let want_page = take_page(&root.join("spells.html"));
        let got = rust(args, &root);
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
        page_diff(args, &take_page(&root.join("spells.html")), &want_page);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

/// An empty book is the JS `No standard damage spells found. Check --data / ARENA2.` line, exit 0, no page - in text and
/// `--json` mode (that line is a plain `console.log`, so the JSON branch prints it too).
#[test]
fn the_empty_book_line_matches_the_js() {
    let root = temp_root("empty");
    let page = root.join("spells.html");
    for args in [
        &["spells", "--theory"][..],
        &["spells", "--theory", "--json"][..],
        &["spells", "--theory", "--data", "nowhere"][..],
        &["spells", "--theory", "--data", ""][..],
    ] {
        let want = js(args, &root);
        assert_eq!(want.status.code(), Some(0), "js {args:?}");
        assert_eq!(
            String::from_utf8_lossy(&want.stdout),
            "No standard damage spells found. Check --data / ARENA2.\n",
            "js {args:?}"
        );
        let got = rust(args, &root);
        assert_eq!(got.status.code(), Some(0), "rust {args:?}");
        assert_eq!(
            String::from_utf8_lossy(&got.stdout),
            String::from_utf8_lossy(&want.stdout),
            "stdout differs for {args:?}"
        );
        assert!(!page.exists(), "no page for an empty book: {args:?}");
    }
    // A short `SPELLS.STD` (not a whole record) is also an empty book: both print the line and write no page.
    let short = temp_root("short");
    let arena = short.join("ARENA2");
    fs::create_dir_all(&arena).expect("arena dir");
    fs::write(arena.join("SPELLS.STD"), vec![0u8; 0x58]).expect("short book");
    pin_mtime(&arena.join("SPELLS.STD"));
    // The page path is inside the fixture the call runs against: an `--out` under another root is a write the cache
    // could neither see nor replay.
    let short_page = short.join("spells.html");
    let args = [
        "spells",
        "--theory",
        "--data",
        arena.to_str().unwrap(),
        "--out",
        short_page.to_str().unwrap(),
    ];
    let want = js(&args, &short);
    assert_eq!(want.status.code(), Some(0));
    let got = rust(&args, &short);
    assert_eq!(got.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&got.stdout),
        String::from_utf8_lossy(&want.stdout),
        "the short-book line differs"
    );
    assert!(!short_page.exists(), "no page for a short book");
    fs::remove_dir_all(&root).expect("cleanup");
    fs::remove_dir_all(&short).expect("cleanup");
}

/// The page write is create-only, like every page command of this slice: an existing path (an older report, a
/// save-shaped file) is refused with exit 2 and left byte-identical, where the JS `writeFileSync` truncates it.
#[test]
fn spells_refuses_to_overwrite() {
    let root = temp_root("create-only");
    let arena = write_arena(&root);
    write_config(&root, &arena);
    for (name, body) in [
        ("spells.html", &b"an older report"[..]),
        ("SaveData.txt", &b"a game save the CLI must never touch"[..]),
    ] {
        let path = root.join(name);
        fs::write(&path, body).expect("fixture");
        pin_mtime(&path);
        let got = rust(
            &["spells", "--theory", "--out", path.to_str().unwrap()],
            &root,
        );
        assert_eq!(got.status.code(), Some(2), "rust {name}");
        assert!(
            String::from_utf8_lossy(&got.stderr).contains("cannot write "),
            "rust: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert!(got.stdout.is_empty(), "no card before a failed page write");
        assert_eq!(
            fs::read(&path).expect("fixture survives"),
            body,
            "{name} intact"
        );
    }
    // The JS truncates the same path; this is the documented divergence, not parity.
    let want = js(
        &[
            "spells",
            "--theory",
            "--out",
            root.join("spells.html").to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(want.status.code(), Some(0));
    assert_ne!(
        fs::read(root.join("spells.html")).expect("JS page"),
        b"an older report",
        "the JS overwrites"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

/// A flag outside the command stays refused by name; extra positionals are a deliberate strictness (the JS ignores them).
#[test]
fn the_refusals_are_explicit() {
    let root = temp_root("refusals");
    let arena = write_arena(&root);
    write_config(&root, &arena);
    let page = root.join("spells.html");
    let out = page.to_str().unwrap();
    // `--sort` is validated globally by `validateFlags`, for every command, so both CLIs refuse it word for word.
    same_usage(
        &["spells", "--theory", "--sort", "nope", "--out", out],
        &root,
        &page,
    );
    // A flag outside the command stays refused by name.
    for (args, refusal) in [
        (
            &["build", "--theory", "--list"][..],
            "--list is not read by build; spell and spells read it (spells ignores --list, --all-spells, --standard and --spell)",
        ),
        (
            &["spells", "--theory", "--family", "bow", "--out", out][..],
            "--family is not read by spells; imprints reads it",
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
    // Extra positionals: the JS ignores them; this slice refuses them on purpose, as its other commands do.
    let got = rust(&["spells", "--theory", "extra", "--out", out], &root);
    assert_eq!(got.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&got.stderr).contains("unexpected positional argument"));
    assert!(!page.exists(), "no page for an extra positional");
    let want = js(&["spells", "--theory", "extra", "--out", out], &root);
    assert_eq!(want.status.code(), Some(0), "the JS ignores the positional");
    if page.exists() {
        fs::remove_file(&page).expect("cleanup the JS page");
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn help_lists_the_spells_command() {
    let root = temp_root("help");
    let got = rust(&["--help"], &root);
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    for line in [
        "dfo-forge spells",
        "spells page written:",
        "No standard damage spells found",
        "--data <dir>",
    ] {
        assert!(text.contains(line), "help names {line}");
    }
    fs::remove_dir_all(&root).expect("cleanup");
}
