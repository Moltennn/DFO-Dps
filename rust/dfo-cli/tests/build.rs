//! The R8 `build` slice, differentially against the real JS CLI.
//!
//! Every case runs `bin/dfo-dps.js build ...` and the Rust binary with the same arguments and compares stdout byte for
//! byte. The JS is the oracle: a port that drifts from `src/cli.js` `printBuild` or `summary()` fails here.
//!
//! The theory cases read no save. The save-backed cases write their own tiny fixture under a temp `DAGGER_USER_DATA`
//! root (never a real save), which also proves the read-only import feeds the build card.
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.
//!
//! LIMITATION: the JS prices Cast When Strikes rows (`enchantments[].type = 2`) through the game's `SPELLS.STD`, and
//! `build` resolves it from the launcher's `config.json` -> `arena2Path`. This slice now does the same read-only lookup
//! (`saves::load_spellbook`), and `cws_*` below proves a nonzero proc over a synthetic temp `SPELLS.STD` (never the
//! machine's real one). A missing config, a bad one, or a missing/oversized `SPELLS.STD` is an empty book on both sides,
//! and `build_missing_config_matches_the_js` pins that. A save's custom spell records are read by `spell` and `spells` only,
//! never by Cast When Strikes (the JS does the same), and `--data` remains unported here.
//!
//! The spellbook tests set `DAGGER_USER_DATA` to their own temp root, so neither CLI can read the player's launcher
//! config or game files.

mod common;

use common::{
    js as js_env, js_pinned as js, pin_mtime, rust as rust_env, rust_pinned as rust, temp_root,
};

use std::fs;
use std::path::{Path, PathBuf};

/// A success case: both exit 0 and stdout matches byte for byte.
fn same(args: &[&str]) {
    let want = js(args);
    let got = rust(args);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    assert_eq!(
        got.status.code(),
        want.status.code(),
        "rust {args:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&got.stdout),
        String::from_utf8_lossy(&want.stdout),
        "stdout differs for {args:?}"
    );
}

fn same_env(args: &[&str], root: &Path) {
    let want = js_env(args, root);
    let got = rust_env(args, root);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    assert_eq!(
        got.status.code(),
        want.status.code(),
        "rust {args:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&got.stdout),
        String::from_utf8_lossy(&want.stdout),
        "stdout differs for {args:?}"
    );
}
/// The offline save shape (`items[].equipSlot`): a main hand and an off hand, so the summary's `weapon` and the
/// `current`-free `topWeapons` both have something real to price.
fn offline_save(level: u32) -> String {
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
{{"group":"Weapons","templateIndex":122,"equipSlot":21,"name":"Iron Dagger","material":9,"currentCondition":100,"maxCondition":100}}]}}"#
    )
}

/// The live save shape (`equipSlots`, `_mods`, `_enchantMods`, affixes, enchantments and effects).
fn live_save() -> String {
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
    .map(|k| format!("\"{k}\":60"))
    .join(",");
    let skills = (0..35).map(|_| "77").collect::<Vec<_>>().join(",");
    format!(
        r#"{{"name":"Live Fixture","level":30,"raceId":1,"race":"Breton","gender":"male",
"health":150,"maxHealth":200,"magicka":120,"maxMagicka":240,
"stats":{{{stats}}},"skills":[{skills}],
"equipSlots":{{
"4":{{"group":"Jewelry","templateIndex":300,"name":"Live Ring","affixes":[{{"id":"stat","param":"luck","value":8}}]}},
"19":{{"group":"Weapons","templateIndex":121,"name":"Live Katana","material":5,"currentCondition":80,"maxCondition":100,
"affixes":[{{"id":"damage","value":12}},{{"id":"skill","param":29,"value":7}},{{"id":"stat","param":"strength","value":4}},
{{"id":"slayer","param":"undead","value":9}},{{"id":"elemental","param":"fire","value":6}}],
"enchantments":[{{"type":10,"param":"29"}},{{"type":10,"param":34}}]}}}},
"_mods":{{"stats":{{"agility":5}},"skills":{{"29":3}},"statMax":{{"agility":10}}}},
"_enchantMods":{{"skillMods":{{"29":15}},"chanceToHitMod":0}},
"activeEffects":[
{{"kind":"fortifyAttribute","stat":"strength","magnitude":8,"ended":false}},
{{"kind":"drainAttribute","stat":"speed","magnitude":3,"ended":false}},
{{"kind":"fortifyAttribute","stat":"strength","magnitude":50,"ended":true}}],
"masterSkills":true,"masteredSkills":[29,34],"martialPath":"berserker","legendaries":[]}}"#
    )
}

#[test]
fn build_theory_json_matches_the_js_cli() {
    // The JSON branch is untouched by the text port: these all still compare to `summary()` byte for byte.
    same(&["build", "--theory", "--json"]);
    same(&["build", "--theory", "--json", "--top", "1"]);
    same(&["build", "--theory", "--json", "--top", "5"]);
    same(&[
        "build", "--theory", "--json", "--target", "boss", "--health", "9000",
    ]);
    same(&[
        "build",
        "--theory",
        "--json",
        "--target",
        "gate",
        "--players",
        "3",
    ]);
    same(&["build", "--theory", "--json", "--weapon", "121:3"]);
    same(&["build", "--theory", "--json", "--blade", "118"]);
    same(&["build", "--theory", "--json", "--race", "redguard"]);
    same(&[
        "build",
        "--theory",
        "--json",
        "--gear-lb",
        "250",
        "--gear-cs",
        "370",
        "--damage-pct",
        "15",
    ]);
    same(&[
        "build", "--theory", "--json", "--swing", "StrikeUp", "--stacks", "3", "--rhythm",
    ]);
    same(&["build", "--theory", "--json", "--firmament"]);
    same(&[
        "build",
        "--theory",
        "--json",
        "--no-crit-damage",
        "--no-passive",
        "--no-rri",
    ]);
    same(&["build", "--theory", "--json", "--level", "30", "--vampire"]);
    same(&["build", "--theory", "--json", "--base-stats", "80"]);
    // The theory remap and the raw preset text: `armoured` is analysed as the gate but `preset` keeps the typed name.
    same(&["build", "--theory", "--json", "--target", "ARMOURED"]);
    same(&[
        "build",
        "--theory",
        "--json",
        "--target",
        "breach",
        "--players",
        "2",
        "--blow-x",
        "2",
    ]);
    same(&[
        "build",
        "--theory",
        "--json",
        "--behind",
        "--backstab",
        "0.4",
    ]);
    same(&[
        "build",
        "--theory",
        "--json",
        "--star-stat",
        "strength=10,agility=5",
        "--star-damage",
        "12",
    ]);
}

#[test]
fn build_is_the_default_command() {
    // No positional command means `build`, in both CLIs (`src/cli.js:912`).
    same(&["--theory", "--top", "2"]);
    same(&["--theory", "--target", "soft"]);
    same(&["--theory", "--json", "--top", "2"]);
    same(&["--theory", "--json", "--target", "soft"]);
}

#[test]
fn build_theory_text_matches_the_js_cli() {
    same(&["build", "--theory"]);
    same(&["build", "--theory", "--top", "1"]);
    same(&["build", "--theory", "--target", "boss", "--health", "9000"]);
    same(&["build", "--theory", "--target", "gate", "--players", "3"]);
    same(&["build", "--theory", "--weapon", "121:3"]);
    same(&["build", "--theory", "--blade", "118"]);
    same(&["build", "--theory", "--race", "redguard"]);
    same(&[
        "build",
        "--theory",
        "--gear-lb",
        "250",
        "--gear-cs",
        "370",
        "--damage-pct",
        "15",
    ]);
    same(&[
        "build", "--theory", "--swing", "StrikeUp", "--stacks", "3", "--rhythm",
    ]);
    same(&["build", "--theory", "--firmament"]);
    same(&[
        "build",
        "--theory",
        "--no-crit-damage",
        "--no-passive",
        "--no-rri",
    ]);
    same(&["build", "--theory", "--level", "30", "--vampire"]);
    same(&["build", "--theory", "--base-stats", "80"]);
    // The theory remap and the raw preset text: `armoured` is analysed as the gate and the header says so.
    same(&["build", "--theory", "--target", "ARMOURED"]);
    same(&[
        "build",
        "--theory",
        "--target",
        "breach",
        "--players",
        "2",
        "--blow-x",
        "2",
    ]);
    same(&["build", "--theory", "--behind", "--backstab", "0.4"]);
    // `warded`/`wrathful` exercise the ward note and the Wrathful line; `curbing` the cap source and its 5% note.
    same(&[
        "build",
        "--theory",
        "--target",
        "boss",
        "--traits",
        "warded,wrathful",
    ]);
    same(&[
        "build", "--theory", "--target", "boss", "--health", "1000", "--traits", "curbing",
    ]);
    // The three allowance-note branches: a refused kill (the default card), a run that never kills, a gap inside 1%
    // (no note), and a gap just above it. `--blade 127` is the small-gap case, `113` the no-note one, and the huge pool
    // also pins `toLocaleString` grouping (`800,000`).
    same(&[
        "build", "--theory", "--target", "gate", "--health", "800000",
    ]);
    same(&[
        "build", "--theory", "--target", "gate", "--health", "200000",
    ]);
    same(&["build", "--theory", "--blade", "127"]);
    same(&["build", "--theory", "--blade", "113"]);
    same(&["build", "--theory", "--blade", "114"]);
    // `--top` only sizes the JSON summary's ranking; the text card is fixed at 8 rows, so this pins that too.
    same(&["build", "--theory", "--top", "3"]);
}

#[test]
fn build_offline_save_text_matches_the_js() {
    let root = temp_root("offline-text");
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    fs::write(dir.join("SaveData.txt"), offline_save(20)).expect("fixture save");
    pin_mtime(&dir.join("SaveData.txt"));

    for args in [
        &["build"][..],
        &["build", "--save", "SAVE1"][..],
        &["build", "--target", "soft"][..],
        &["build", "--target", "boss", "--health", "8000"][..],
        &["build", "--offline"][..],
        &["build", "--passive", "none"][..],
        &["build", "--bare"][..],
        &["build", "--no-effects"][..],
        &["build", "--core", "classic"][..],
        &["build", "--base-stats", "75"][..],
        &["build", "--weapon", "121:3"][..],
        &["build", "--target", "boss", "--traits", "warded,wrathful"][..],
    ] {
        same_env(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn build_live_save_text_matches_the_js() {
    let root = temp_root("live-text");
    let dir = root.join("Saves").join("SAVE20");
    fs::create_dir_all(&dir).expect("save folder");
    fs::write(dir.join("SaveData.txt"), live_save()).expect("fixture save");
    pin_mtime(&dir.join("SaveData.txt"));

    for args in [
        &["build"][..],
        &["build", "--target", "tough"][..],
        &["build", "--target", "gate"][..],
        &["build", "--json", "--target", "gate"][..],
        &["build", "--no-effects"][..],
        &["build", "--weapon", "121"][..],
        &["build", "--dual"][..],
    ] {
        same_env(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn build_usage_errors_match_the_js() {
    // Flag validation happens in `validateFlags` in both CLIs, so these messages are compared word for word.
    fn same_usage(args: &[&str]) {
        let want = js(args);
        let got = rust(args);
        assert_eq!(want.status.code(), Some(2), "js {args:?}");
        assert_eq!(got.status.code(), Some(2), "rust {args:?}");
        assert_eq!(
            String::from_utf8_lossy(&got.stderr).trim_end(),
            String::from_utf8_lossy(&want.stderr).trim_end(),
            "stderr differs for {args:?}"
        );
    }
    same_usage(&["build", "--theory", "--json", "--target", "toguh"]);
    same_usage(&["build", "--theory", "--json", "--level", "0"]);
    same_usage(&["build", "--theory", "--json", "--top", "0"]);
    same_usage(&["build", "--theory", "--json", "--weapon", "999:9"]);
    same_usage(&["build", "--theory", "--json", "--traits", "nope"]);
    same_usage(&["build", "--theory", "--json", "--out", "x.html"]);

    // The parser's own text is not this port's (node's `parseArgs` appends the whole help; this slice prints the
    // message only), so an unknown option compares the exit code and that the refusal explains itself.
    let got = rust(&["build", "--theory", "--json", "--bogus"]);
    assert_eq!(got.status.code(), Some(2));
    assert!(!got.stderr.is_empty());
    assert!(got.stdout.is_empty());
    assert_eq!(
        js(&["build", "--theory", "--json", "--bogus"])
            .status
            .code(),
        Some(2)
    );

    // Extra positionals are ignored by the JS and refused here on purpose (as `rank` does): a strict refusal, not a
    // silent drop.
    let got = rust(&["build", "--theory", "--json", "extra"]);
    assert_eq!(
        got.status.code(),
        Some(2),
        "rust refuses an extra positional"
    );
    assert!(!got.stderr.is_empty());
    assert_eq!(
        js(&["build", "--theory", "--json", "extra"]).status.code(),
        Some(0),
        "the JS ignores it"
    );
}

#[test]
fn build_offline_save_json_matches_the_js() {
    let root = temp_root("offline");
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    fs::write(dir.join("SaveData.txt"), offline_save(20)).expect("fixture save");
    pin_mtime(&dir.join("SaveData.txt"));

    for args in [
        &["build", "--json"][..],
        &["build", "--json", "--save", "SAVE1"][..],
        &["build", "--json", "--top", "3"][..],
        &["build", "--json", "--target", "soft"][..],
        &["build", "--json", "--target", "boss", "--health", "8000"][..],
        &["build", "--json", "--offline"][..],
        &["build", "--json", "--passive", "none"][..],
        &["build", "--json", "--bare"][..],
        &["build", "--json", "--no-effects"][..],
        &["build", "--json", "--core", "classic"][..],
        &["build", "--json", "--base-stats", "75"][..],
        &["build", "--json", "--weapon", "121:3"][..],
    ] {
        same_env(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn build_live_save_json_matches_the_js() {
    let root = temp_root("live");
    let dir = root.join("Saves").join("SAVE20");
    fs::create_dir_all(&dir).expect("save folder");
    fs::write(dir.join("SaveData.txt"), live_save()).expect("fixture save");
    pin_mtime(&dir.join("SaveData.txt"));

    for args in [
        &["build", "--json"][..],
        &["build", "--json", "--top", "2"][..],
        &["build", "--json", "--target", "tough"][..],
        &["build", "--json", "--no-effects"][..],
        &["build", "--json", "--weapon", "121"][..],
        &["build", "--json", "--dual"][..],
    ] {
        same_env(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn build_missing_save_fails_like_the_js() {
    let root = temp_root("empty");
    let want = js_env(&["build", "--json"], &root);
    let got = rust_env(&["build", "--json"], &root);
    assert_eq!(want.status.code(), Some(2), "js");
    assert_eq!(got.status.code(), Some(2), "rust");
    assert!(got.stdout.is_empty());
    assert!(!got.stderr.is_empty());
    fs::remove_dir_all(&root).expect("cleanup");
}

// ---------------------------------------------------------------------------------------------------------------
// Cast When Strikes through a synthetic SPELLS.STD: the launcher config lookup (`src/save.js:28-40`,
// `src/spells.js:82-93`) on both sides. Nothing here reads a real config or game file.
// ---------------------------------------------------------------------------------------------------------------

/// One effect as the record layout stores it: `(type, subType, durationBase, durationMod, durationPerLevel,
/// magnitudeBaseLow, magnitudeBaseHigh, magnitudeLevelBase, magnitudeLevelHigh, magnitudePerLevel)`.
type SpellEffect = (i8, i8, u8, u8, u8, u8, u8, u8, u8, u8);

/// One 89-byte `SPELLS.STD` record, field for field as `src/spells.js:24-50` reads it (LE cost, NUL-terminated name).
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
        // durationBase, durationMod, durationPerLevel
        b[14 + 3 * i] = e.2;
        b[15 + 3 * i] = e.3;
        b[16 + 3 * i] = e.4;
        // magnitudeBaseLow/High, magnitudeLevelBase/High, magnitudePerLevel
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

/// A two-spell book: an instant DamageHealth (4,0) and a ContinuousDamageHealth (1,0) DoT.
fn spells_std() -> Vec<u8> {
    [
        spell_record(1, "Bolt", 4, &[(4, 0, 0, 0, 1, 10, 20, 0, 0, 1)]),
        spell_record(2, "Burn", 4, &[(1, 0, 2, 1, 1, 4, 8, 0, 0, 1)]),
    ]
    .concat()
}

/// The live save shape with two Cast When Strikes rows pointing at that book.
fn cws_save() -> String {
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
    .map(|k| format!("\"{k}\":60"))
    .join(",");
    let skills = (0..35).map(|_| "77").collect::<Vec<_>>().join(",");
    format!(
        r#"{{"name":"CWS Fixture","level":30,"raceId":1,"race":"Breton","gender":"male",
"health":150,"maxHealth":200,"magicka":120,"maxMagicka":240,
"stats":{{{stats}}},"skills":[{skills}],
"equipSlots":{{"19":{{"group":"Weapons","templateIndex":121,"name":"Live Katana","material":5,
"currentCondition":80,"maxCondition":100,"affixes":[{{"id":"damage","value":12}}],
"enchantments":[{{"type":2,"param":"1"}},{{"type":2,"param":2}}]}}}},
"_mods":{{"stats":{{}},"skills":{{}}}},"_enchantMods":{{"skillMods":{{}},"chanceToHitMod":0}},
"activeEffects":[],"masterSkills":true,"masteredSkills":[29,34],"martialPath":"berserker","legendaries":[]}}"#
    )
}

/// Write the synthetic `SPELLS.STD` under `<root>/ARENA2` and point `config.json` at it (the launcher's own shape).
fn write_spellbook(root: &Path) {
    let arena = root.join("ARENA2");
    fs::create_dir_all(&arena).expect("arena dir");
    fs::write(arena.join("SPELLS.STD"), spells_std()).expect("synthetic SPELLS.STD");
    fs::write(
        root.join("config.json"),
        format!(r#"{{"arena2Path":{}}}"#, json_string(&arena)),
    )
    .expect("launcher config");
    // One stamp for both: no assertion here depends on which of the config and the book is newer.
    pin_mtime(&arena.join("SPELLS.STD"));
    pin_mtime(&root.join("config.json"));
}

/// A JSON string body for a path (the fixture paths are ASCII).
fn json_string(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().replace('\\', "\\\\"))
}

fn cws_root(label: &str) -> PathBuf {
    let root = temp_root(label);
    let dir = root.join("Saves").join("SAVE30");
    fs::create_dir_all(&dir).expect("save folder");
    fs::write(dir.join("SaveData.txt"), cws_save()).expect("fixture save");
    pin_mtime(&dir.join("SaveData.txt"));
    root
}

#[test]
fn build_prices_cast_when_strikes_from_the_launcher_spellbook() {
    let root = cws_root("cws");
    write_spellbook(&root);

    // A nonzero proc: the JSON proves the book was read (an empty book would report enchantDps 0).
    let json = rust_env(&["build", "--json"], &root);
    assert_eq!(json.status.code(), Some(0));
    let text = String::from_utf8_lossy(&json.stdout);
    assert!(
        !text.contains("\"enchantDps\": 0,"),
        "the CWS procs are priced from the synthetic book: {text}"
    );
    for args in [
        &["build"][..],
        &["build", "--json"][..],
        &["build", "--target", "tough"][..],
        &["build", "--target", "boss", "--health", "8000", "--json"][..],
        &["rank"][..],
        &["rank", "--json"][..],
    ] {
        same_env(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn a_missing_or_bad_launcher_config_is_an_empty_book_like_the_js() {
    // Each variant must match the JS, where the `try`/`catch` in `arena2Path`/`standardSpells` falls back to no spells.
    for (label, config) in [
        ("no-config", None),
        ("bad-json", Some("{not json")),
        ("array", Some("[1,2]")),
        ("null", Some("null")),
        ("no-key", Some(r#"{"other":1}"#)),
        ("empty-path", Some(r#"{"arena2Path":""}"#)),
        ("numeric-path", Some(r#"{"arena2Path":7}"#)),
        ("dangling", Some(r#"{"arena2Path":"/nonexistent/arena2"}"#)),
    ] {
        let root = cws_root(label);
        if let Some(text) = config {
            fs::write(root.join("config.json"), text).expect("launcher config");
            pin_mtime(&root.join("config.json"));
        }
        for args in [
            &["build"][..],
            &["build", "--json"][..],
            &["rank", "--json"][..],
        ] {
            same_env(args, &root);
        }
        // No book means no proc: both sides print an enchant-free card.
        let out = String::from_utf8_lossy(&js_env(&["build", "--json"], &root).stdout).into_owned();
        assert!(
            out.contains("\"enchantDps\": 0,"),
            "{label}: an unreadable config leaves the procs out: {out}"
        );
        fs::remove_dir_all(&root).expect("cleanup");
    }
}

#[test]
fn a_missing_spells_std_is_an_empty_book_like_the_js() {
    let root = cws_root("cws-nofile");
    let arena = root.join("ARENA2");
    fs::create_dir_all(&arena).expect("arena dir");
    fs::write(
        root.join("config.json"),
        format!(r#"{{"arena2Path":{}}}"#, json_string(&arena)),
    )
    .expect("launcher config");
    pin_mtime(&root.join("config.json"));
    // Missing file: both fall back to an empty book (the JS `catch` returns a fresh empty `Map`).
    same_env(&["build", "--json"], &root);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn an_oversized_spells_std_is_refused_by_the_ports_own_bound() {
    // The JS `readFileSync` has no size bound; this port stops past `MAX_SPELL_BYTES` and reads the file as no book.
    // That is a port guard (an unbounded read of a replacement file would be a hostile-input hole), so this asserts
    // the port's own behaviour rather than a JS-identical card; the missing-file case above proves the shared fallback.
    let root = cws_root("cws-big");
    let arena = root.join("ARENA2");
    fs::create_dir_all(&arena).expect("arena dir");
    fs::write(arena.join("SPELLS.STD"), vec![0u8; 8 * 1024 * 1024 + 1]).expect("oversized file");
    fs::write(
        root.join("config.json"),
        format!(r#"{{"arena2Path":{}}}"#, json_string(&arena)),
    )
    .expect("launcher config");
    let out = rust_env(&["build", "--json"], &root);
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("\"enchantDps\": 0,"));
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn help_lists_build() {
    let got = rust(&["--help"]);
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    assert!(text.contains("build"), "help names build");
    assert!(text.contains("--json"), "help names --json");
}
