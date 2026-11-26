//! The R8 `tradeoff` command, differentially against the real JS CLI.
//!
//! Every case runs `bin/dfo-dps.js tradeoff ...` and the Rust binary with the same arguments and compares stdout byte
//! for byte, text and `--json`, over the theory character and over synthetic saves. The JS is the oracle: a port that
//! drifts from `src/cli.js:2204-2252` fails here. The pool rows, the verdict text and the crossover are pinned by
//! `dfo-cli/tests/tradeoff.rs`; this file pins the command around them - the branch's scenario overrides, the shared
//! flags that reach the pools, and the refusals.
//!
//! The branch never calls `targetOf`: each pool's `scenarioOf(ch, values, traits, t)` is overwritten at `target`,
//! `health` and `traits` (`src/cli.js:2218`), so `--target`/`--health`/`--armor` change no number and `--level` only
//! moves the theory character. The cases below assert that directly (equal stdout for two flag sets), rather than
//! trusting `build`'s generic target handling.
//!
//! Nothing reads a real save or a real `SPELLS.STD`: each case writes its own tiny fixture under a temp
//! `DAGGER_USER_DATA` root. A save whose main hand carries Cast When Strikes rows still prices through the launcher's
//! book, and `cws_save_matches_the_js` proves a nonzero proc reads the same on both sides. A missing `node` panics
//! rather than skips, because a skipped differential proves nothing.

mod common;

use common::{js, pin_mtime, rust, temp_root};

use std::fs;
use std::path::Path;

fn same(args: &[&str], root: &Path) {
    let want = js(args, root);
    let got = rust(args, root);
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

/// A refusal both CLIs share: exit 2 and the same stderr.
fn same_usage(args: &[&str], root: &Path) {
    let want = js(args, root);
    let got = rust(args, root);
    assert_eq!(
        want.status.code(),
        Some(2),
        "js {args:?}: stdout {} stderr {}",
        String::from_utf8_lossy(&want.stdout),
        String::from_utf8_lossy(&want.stderr)
    );
    assert_eq!(
        got.status.code(),
        Some(2),
        "rust {args:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&got.stderr).trim_end(),
        String::from_utf8_lossy(&want.stderr).trim_end(),
        "stderr differs for {args:?}"
    );
}

/// The offline save shape (`items[].equipSlot`): a main hand and an off hand, stats and skills.
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
        r#"{{"name":"Fixture","level":30,"raceId":1,"race":"Breton","gender":"female",
"reflexes":2,"health":90,"maxHealth":120,"magicka":30,"maxMagicka":80,
"stats":{{{stats}}},"skills":[{skills}],"masterSkills":true,"masteredSkills":[11,29],
"martialPath":"blademaster",
"items":[
{{"group":"Weapons","templateIndex":121,"equipSlot":19,"name":"Iron Longsword","material":9,"currentCondition":100,"maxCondition":100}},
{{"group":"Weapons","templateIndex":122,"equipSlot":21,"name":"Iron Dagger","material":9,"currentCondition":100,"maxCondition":100}}]}}"#
    )
}

/// The live save shape (`equipSlots`, `_mods`, `_enchantMods`, effects) whose main hand carries two Cast When Strikes
/// rows, indexed 1 and 2 to match the synthetic `SPELLS.STD` below.
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
"currentCondition":100,"maxCondition":100,"affixes":[{{"id":"damage","value":12}}],
"enchantments":[{{"type":2,"param":"1"}},{{"type":2,"param":2}}]}}}},
"_mods":{{"stats":{{}},"skills":{{}}}},"_enchantMods":{{"skillMods":{{}},"chanceToHitMod":0}},
"activeEffects":[],"masterSkills":true,"masteredSkills":[29,34],"martialPath":"berserker","legendaries":[]}}"#
    )
}

fn write_save(root: &Path, slot: &str, body: &str) {
    let dir = root.join("Saves").join(slot);
    fs::create_dir_all(&dir).expect("save folder");
    fs::write(dir.join("SaveData.txt"), body).expect("fixture save");
    pin_mtime(&dir.join("SaveData.txt"));
}

/// One 89-byte `SPELLS.STD` record, field for field as `src/spells.js:24-50` reads it.
fn spell_record(index: u8, name: &str, element: u8, effects: &[(i8, i8, u8, u8)]) -> Vec<u8> {
    let mut b = vec![0u8; 0x59];
    for i in 0..3 {
        let (t, st) = effects.get(i).map_or((-1, -1), |e| (e.0, e.1));
        b[2 * i] = t as u8;
        b[2 * i + 1] = st as u8;
    }
    b[6] = element;
    b[8..10].copy_from_slice(&12u16.to_le_bytes());
    for (i, e) in effects.iter().enumerate() {
        b[32 + 5 * i] = e.2;
        b[33 + 5 * i] = e.3;
    }
    let bytes = name.as_bytes();
    b[47..47 + bytes.len().min(25)].copy_from_slice(&bytes[..bytes.len().min(25)]);
    b[73] = index;
    b
}

/// An instant DamageHealth (4,0) and a ContinuousDamageHealth (1,0) DoT, indexed 1 and 2 to match `cws_save`.
fn spells_std() -> Vec<u8> {
    [
        spell_record(1, "Bolt", 4, &[(4, 0, 10, 20)]),
        spell_record(2, "Burn", 4, &[(1, 0, 4, 8)]),
    ]
    .concat()
}

fn json_string(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().replace('\\', "\\\\"))
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

// ---------------------------------------------------------------------------------------------------------------

#[test]
fn the_theory_card_matches_the_js() {
    let root = temp_root("theory");
    same(&["tradeoff", "--theory"], &root);
    same(&["tradeoff", "--theory", "--json"], &root);
    // The default command is `build`, so this is the one case that must name it.
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_pool_flags_do_not_reach_the_pools() {
    let root = temp_root("overrides");
    // `--target`, `--health` and `--armor` are overwritten per pool; `--target skyketch` would even be a relay body
    // under `build`'s generic handling. `--blow-x` and `--players` DO reach the gate pool (its cap), so they are not
    // compared here; they are covered by `the_shared_scenario_flags_match_the_js`.
    let base = js(&["tradeoff", "--theory"], &root);
    assert_eq!(base.status.code(), Some(0));
    for args in [
        &[
            "tradeoff", "--theory", "--target", "skyketch", "--health", "8000", "--armor", "30",
        ][..],
        &["tradeoff", "--theory", "--target", "boss"][..],
        &["tradeoff", "--theory", "--traits", "warded"][..],
    ] {
        let out = js(args, &root);
        assert_eq!(out.status.code(), Some(0), "js {args:?}");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&base.stdout),
            "the pools ignore {}",
            args.join(" ")
        );
        same(args, &root);
    }
    // The other direction: the gate cap really does move with the blow multiplier, on both sides.
    let doubled = js(&["tradeoff", "--theory", "--blow-x", "2"], &root);
    assert_ne!(
        String::from_utf8_lossy(&doubled.stdout),
        String::from_utf8_lossy(&base.stdout),
        "the gate cap follows --blow-x"
    );
    same(&["tradeoff", "--theory", "--blow-x", "2"], &root);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_shared_scenario_flags_match_the_js() {
    let root = temp_root("variants");
    for args in [
        &["tradeoff", "--theory", "--level", "30"][..],
        &["tradeoff", "--theory", "--core", "Classic"][..],
        &["tradeoff", "--theory", "--players", "3", "--json"][..],
        &["tradeoff", "--theory", "--blow-x", "2", "--json"][..],
        &["tradeoff", "--theory", "--core", "classic"][..],
        &["tradeoff", "--theory", "--core", "classic", "--json"][..],
        &["tradeoff", "--theory", "--swing", "StrikeUp"][..],
        &["tradeoff", "--theory", "--stacks", "3", "--rhythm"][..],
        &["tradeoff", "--theory", "--no-rri"][..],
        &["tradeoff", "--theory", "--no-passive", "--json"][..],
        &["tradeoff", "--theory", "--no-crit-damage"][..],
        &["tradeoff", "--theory", "--behind", "--json"][..],
        &[
            "tradeoff",
            "--theory",
            "--health-share",
            "0.5",
            "--self-health-share",
            "0.4",
        ][..],
        &["tradeoff", "--theory", "--unaware", "--first-blow"][..],
        &["tradeoff", "--theory", "--weapon", "118:5", "--json"][..],
        &["tradeoff", "--theory", "--blade", "118", "--race", "nord"][..],
        &["tradeoff", "--theory", "--gear-lb", "200"][..],
        &["tradeoff", "--theory", "--vampire", "--firmament"][..],
        &["tradeoff", "--theory", "--base-stats", "70", "--json"][..],
        &["tradeoff", "--theory", "--no-effects"][..],
        &["tradeoff", "--theory", "--bare", "--json"][..],
    ] {
        same(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn an_offline_save_matches_the_js() {
    let root = temp_root("offline-save");
    write_save(&root, "SAVE30", &offline_save());
    for args in [
        &["tradeoff", "--save", "SAVE30"][..],
        &["tradeoff", "--save", "SAVE30", "--json"][..],
        // A save's `--weapon` override rides the scenario; the rest still price the same fixed pools.
        &["tradeoff", "--save", "SAVE30", "--weapon", "122:5"][..],
        &["tradeoff", "--save", "SAVE30", "--offline", "--json"][..],
        &[
            "tradeoff",
            "--save",
            "SAVE30",
            "--passive",
            "none",
            "--json",
        ][..],
        &["tradeoff", "--save", "SAVE30", "--bare"][..],
        &["tradeoff", "--save", "SAVE30", "--swing", "StrikeDown"][..],
    ] {
        same(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn cws_save_matches_the_js() {
    let root = temp_root("cws");
    write_save(&root, "SAVE30", &cws_save());
    write_spellbook(&root);

    // A nonzero proc proves the synthetic book was read on both sides (an empty book would price 0).
    let js_json = js(&["tradeoff", "--save", "SAVE30", "--json"], &root);
    assert_eq!(js_json.status.code(), Some(0));
    let out = String::from_utf8_lossy(&js_json.stdout);
    assert!(
        !out.contains("\"dmg\": 0,"),
        "the CWS procs should be priced from the synthetic book: {out}"
    );
    for args in [
        &["tradeoff", "--save", "SAVE30"][..],
        &["tradeoff", "--save", "SAVE30", "--json"][..],
        &["tradeoff", "--save", "SAVE30", "--potency", "30"][..],
        &["tradeoff", "--save", "SAVE30", "--pierce", "20", "--json"][..],
        &["tradeoff", "--save", "SAVE30", "--no-effects"][..],
    ] {
        same(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn an_armed_save_without_a_book_matches_the_js() {
    let root = temp_root("no-book");
    write_save(&root, "SAVE30", &cws_save());
    // No launcher config: both read an empty book and the procs price 0.
    for args in [
        &["tradeoff", "--save", "SAVE30"][..],
        &["tradeoff", "--save", "SAVE30", "--json"][..],
    ] {
        same(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_flag_refusals_match_the_js() {
    let root = temp_root("usage");
    // `tradeoff` writes no page, so `--out` is the JS `checkOutputFlags` refusal.
    same_usage(&["tradeoff", "--theory", "--out", "x.html"], &root);
    // The global `validateFlags` refusals fire before the branch.
    same_usage(&["tradeoff", "--theory", "--target", "bogus"], &root);
    same_usage(&["tradeoff", "--theory", "--core", "bogus"], &root);
    same_usage(&["tradeoff", "--theory", "--sort", "bogus"], &root);
    same_usage(&["tradeoff", "--theory", "--swing", "bogus"], &root);
    same_usage(&["tradeoff", "--theory", "--traits", "bogus"], &root);
    // A positional the JS branch ignores is refused by this slice on purpose, so only the exit code is compared.
    let extra = rust(&["tradeoff", "--theory", "junk"], &root);
    assert_eq!(extra.status.code(), Some(2));
    assert!(!extra.stderr.is_empty(), "a refusal explains itself");
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn help_lists_the_tradeoff_command() {
    let root = temp_root("help");
    let got = rust(&["--help"], &root);
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    for flag in ["dfo-forge tradeoff", "speed/damage", "--json"] {
        assert!(text.contains(flag), "help names {flag}");
    }
    fs::remove_dir_all(&root).expect("cleanup");
}
