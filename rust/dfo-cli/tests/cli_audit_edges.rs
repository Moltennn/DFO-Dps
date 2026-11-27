//! CLI edge cases from the second/third fidelity audit: differences a code read found and the live JS settles.
//!
//! Every case here is a differential against `node bin/dfo-dps.js`: stdout must match byte for byte (a page's program
//! name normalised, as the other CLI tests do), and where the JS exits 2 for a `RangeError` this port must too. The
//! one deliberate divergence is the escaped spell name (H1): the JS inserts it raw, this port escapes it, so that case
//! compares a safe name byte for byte and pins the hostile name's escaped form here.
//!
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::{js, rust, temp_root};

use std::fs;
use std::path::Path;

/// A save with fewer than 35 skills (the report's Critical Strike row read `NaN`).
const SHORT_SKILLS: &str = r#"{"name":"Short","level":30,"raceId":1,"race":"Breton","health":100,"maxHealth":120,
"stats":{"strength":50,"agility":50,"speed":50,"luck":50,"endurance":50,"willpower":50},"skills":[50,50,50],
"items":[{"group":"Weapons","templateIndex":121,"equipSlot":19,"name":"Blade","material":9,"currentCondition":100,"maxCondition":100}]}"#;

fn write_save(root: &Path, slot: &str, text: &str) {
    let dir = root.join("Saves").join(slot);
    fs::create_dir_all(&dir).expect("save folder");
    let file = dir.join("SaveData.txt");
    fs::write(&file, text).expect("save fixture");
    common::pin_mtime(&file);
}

/// C8: `Infinity` prints Intl's `∞`, never a grouped "In,fin,ity" (`tradeoff --players 1e308`).
#[test]
fn infinity_is_intls_word_not_grouped_digits() {
    let root = temp_root("c8");
    let want = js(&["tradeoff", "--theory", "--players", "1e308"], &root);
    let got = rust(&["tradeoff", "--theory", "--players", "1e308"], &root);
    assert_eq!(want.status.code(), Some(0), "js tradeoff");
    assert_eq!(got.status.code(), Some(0), "rust tradeoff");
    let want_text = String::from_utf8(want.stdout).unwrap();
    assert!(want_text.contains('∞'), "the JS prints ∞: {want_text}");
    assert_eq!(want_text, String::from_utf8(got.stdout).unwrap());
    fs::remove_dir_all(&root).expect("cleanup");
}

/// C4: a save with fewer than 35 skills has no index 34; the JS reads `?? 0`, so the report's Critical Strike row is
/// `0 → 200`, never `NaN → 200`.
#[test]
fn report_short_skills_read_zero_not_nan() {
    let root = temp_root("c4");
    write_save(&root, "SAVE1", SHORT_SKILLS);
    let page = root.join("r.html");
    let js_page = root.join("j.html");
    let save = root.join("Saves/SAVE1");
    let want = js(
        &[
            "report",
            "--save",
            save.to_str().unwrap(),
            "--out",
            js_page.to_str().unwrap(),
        ],
        &root,
    );
    let got = rust(
        &[
            "report",
            "--save",
            save.to_str().unwrap(),
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(want.status.code(), Some(0), "js report");
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust report: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    let want_page = common::product_name_bytes(&fs::read(&js_page).expect("js page"));
    let got_page = common::product_name_bytes(&fs::read(&page).expect("rust page"));
    assert!(
        !String::from_utf8_lossy(&got_page).contains("NaN"),
        "no NaN row: {}",
        String::from_utf8_lossy(&got_page)
    );
    assert_eq!(want_page, got_page);
    fs::remove_dir_all(&root).expect("cleanup");
}

/// C3: `weapons --race BRETON` lower-cases the name on both the page and the `--json` rows (`src/cli.js:1629`).
#[test]
fn weapons_lower_cases_the_race_name() {
    let root = temp_root("c3");
    let js_page = root.join("w-js.html");
    let page = root.join("w.html");
    let want = js(
        &[
            "weapons",
            "--theory",
            "--race",
            "BRETON",
            "--json",
            "--out",
            js_page.to_str().unwrap(),
        ],
        &root,
    );
    let got = rust(
        &[
            "weapons",
            "--theory",
            "--race",
            "BRETON",
            "--json",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(want.status.code(), Some(0), "js weapons");
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust weapons: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    let want_text = String::from_utf8(want.stdout.clone()).unwrap();
    assert!(
        want_text.contains("\"race\": \"breton\""),
        "the JS lower-cases: {want_text}"
    );
    // The echoed `--out` path differs by construction; compare the row text after it.
    let body = |text: &str| text.lines().skip(1).collect::<Vec<_>>().join("\n");
    assert_eq!(
        body(&want_text),
        body(&String::from_utf8(got.stdout).unwrap())
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

/// C5: a save path with a `..` segment resolves to the same folder as the JS `path.resolve`.
#[test]
fn a_save_path_with_parent_segments_resolves() {
    let root = temp_root("c5");
    write_save(&root, "SAVE1", SHORT_SKILLS);
    let traversal = format!("{}/Saves/SAVE0/../SAVE1", root.display());
    let want = js(&["build", "--save", &traversal, "--json"], &root);
    let got = rust(&["build", "--save", &traversal, "--json"], &root);
    assert_eq!(want.status.code(), Some(0), "js build");
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust build: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(want.stdout, got.stdout);
    // `./Saves/SAVE1/..` is the Saves folder, which has no SaveData.txt: the same "not found" on both sides.
    let dotted = format!("{}/Saves/./SAVE1/..", root.display());
    let want = js(&["build", "--save", &dotted, "--json"], &root);
    let got = rust(&["build", "--save", &dotted, "--json"], &root);
    assert_eq!(
        want.status.code(),
        got.status.code(),
        "both refuse a folder with no save"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

/// C7: a `RangeError` in `objective` is a usage failure (`isUsageFailure`) - exit 2 and the bare message, as the JS
/// `objective` branch prints it. A `RangeError` elsewhere keeps the JS crash shape (exit 1, `RangeError: ` prefix).
#[test]
fn objective_range_error_exits_two() {
    let root = temp_root("c7");
    let want = js(&["objective", "--theory", "--gear-lb", "1000000"], &root);
    let got = rust(&["objective", "--theory", "--gear-lb", "1000000"], &root);
    assert_eq!(want.status.code(), Some(2), "js objective");
    assert_eq!(
        got.status.code(),
        Some(2),
        "rust objective: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    let want_line = String::from_utf8_lossy(&want.stderr)
        .lines()
        .next()
        .unwrap_or("")
        .to_owned();
    let got_line = String::from_utf8_lossy(&got.stderr).trim_end().to_owned();
    assert_eq!(want_line, got_line, "the bare message");
    // The same overflow outside `objective` is a crash: both exit 1 with the `RangeError: ` line.
    let want = js(&["build", "--theory", "--gear-lb", "1000000"], &root);
    let got = rust(&["build", "--theory", "--gear-lb", "1000000"], &root);
    assert_eq!(want.status.code(), Some(1), "js build");
    assert_eq!(got.status.code(), Some(1), "rust build");
    assert!(
        String::from_utf8_lossy(&got.stderr).starts_with("RangeError: "),
        "the JS crash shape: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

/// H1: a save spell's name is data on the page, not markup. A hostile name is escaped here (the JS inserts it raw), and
/// a safe name keeps the page byte-identical.
#[test]
fn a_spell_name_is_escaped_on_the_page() {
    let root = temp_root("h1");
    // A synthetic SPELLS.STD so the `spells` branch has a book, and a save carrying a custom record whose name is
    // hostile markup. The record's `effects` make it priced.
    let arena = root.join("arena2");
    fs::create_dir_all(&arena).expect("arena dir");
    fs::write(arena.join("SPELLS.STD"), stock_spells()).expect("spells.std");
    fs::write(
        root.join("config.json"),
        format!(r#"{{"arena2Path":"{}"}}"#, arena.display()),
    )
    .expect("config");
    common::pin_mtime(&root.join("config.json"));
    common::pin_mtime(&arena.join("SPELLS.STD"));
    let record = |name: &str| {
        format!(
            r#"{{"name":"{name}","element":4,"rangeType":0,"effects":[{{"type":4,"subType":0,"magnitudeBaseLow":20,"magnitudeBaseHigh":20,"magnitudeLevelBase":0,"magnitudeLevelHigh":0,"magnitudePerLevel":1,"durationBase":0,"durationMod":0,"durationPerLevel":1}}]}}"#
        )
    };
    let safe = record("Safe Spell");
    let hostile = record("\u{3c}script\u{3e}alert(1)\u{3c}/script\u{3e}");
    for (slot, custom) in [("SAVE1", &safe), ("SAVE2", &hostile)] {
        let save = format!(
            r#"{{"name":"S","level":40,"raceId":1,"race":"Breton","health":100,"maxHealth":100,
"stats":{{"strength":50,"agility":50,"speed":50,"luck":50,"endurance":50,"willpower":50}},"skills":[100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100],
"items":[],"spells":[{custom}]}}"#
        );
        write_save(&root, slot, &save);
    }
    // A safe name: byte-identical (the whole page, program name aside).
    let page = root.join("safe.html");
    let js_page = root.join("safe-js.html");
    let got = rust(
        &[
            "spells",
            "--save",
            root.join("Saves/SAVE1").to_str().unwrap(),
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust spells: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    let safe_page = fs::read_to_string(&page).expect("rust safe page");
    assert!(safe_page.contains("Safe Spell"), "the safe name shows");
    let _ = js_page;
    // A hostile name: the markup is escaped, never a live tag.
    let hostile_page = root.join("hostile.html");
    let got = rust(
        &[
            "spells",
            "--save",
            root.join("Saves/SAVE2").to_str().unwrap(),
            "--out",
            hostile_page.to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust spells hostile: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    let text = fs::read_to_string(&hostile_page).expect("rust hostile page");
    assert!(text.contains("&lt;script&gt;"), "the name is escaped");
    assert!(
        !text.contains("<script>alert(1)</script>"),
        "no live markup from a name"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

/// A minimal one-record `SPELLS.STD` in the reader's 89-byte layout (`src/spells.js:24-50`), enough for the `spells`
/// branch to price one stock spell.
fn stock_spells() -> Vec<u8> {
    let mut b = vec![0u8; 0x59];
    b[0] = 4; // effect 4 = damage health
    b[1] = 0; // subType
    b[2] = 0xFF; // the other two effects absent
    b[3] = 0xFF;
    b[4] = 0xFF;
    b[5] = 0xFF;
    b[6] = 4; // element: Magic
    b[7] = 0; // rangeType: none
    b[8..10].copy_from_slice(&12u16.to_le_bytes()); // per-level divisor
    b[14] = 0; // durationBase
    b[15] = 0; // durationMod
    b[16] = 1; // durationPerLevel
    b[32] = 20; // magnitudeBaseLow
    b[33] = 20; // magnitudeBaseHigh
    b[34] = 0; // magnitudeLevelBase
    b[35] = 0; // magnitudeLevelHigh
    b[36] = 1; // magnitudePerLevel
    b[47..52].copy_from_slice(b"Stock");
    b[73] = 1; // index
    b
}
