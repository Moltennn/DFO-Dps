//! The R8 `enchant` command, differentially against the real JS CLI.
//!
//! Every success case runs `bin/dfo-dps.js enchant ...` and the Rust binary with the same arguments and compares stdout
//! byte for byte, text and `--json`, over the theory character and over synthetic saves. The JS is the oracle: a port
//! that drifts from `src/cli.js:1449-1477` fails here. The card and document themselves are pinned by
//! `dfo-cli/tests/enchant.rs`; this file pins the command around them - the target remap, the scenario rebuild, the
//! spellbook, the missing-weapon line and the flag refusals.
//!
//! Nothing reads a real save or a real `SPELLS.STD`: each case writes its own tiny fixture under a temp
//! `DAGGER_USER_DATA` root. `cws_nonzero_procs_match_the_js` writes a two-spell book there too, so a nonzero Cast When
//! Strikes price is proven on both sides (an empty book prices 0). A missing `node` panics rather than skips, because a
//! skipped differential proves nothing.

mod common;

use common::{js, rust, temp_root};

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

/// The offline save shape (`items[].equipSlot`) with no weapon: `characterFromSave` gives `weapon: null`.
fn no_weapon_save() -> String {
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
        r#"{{"name":"Unarmed","level":20,"raceId":1,"race":"Breton","gender":"male",
"health":90,"maxHealth":120,"magicka":30,"maxMagicka":80,
"stats":{{{stats}}},"skills":[{skills}],"masterSkills":true,"masteredSkills":[11,29],
"martialPath":"blademaster","items":[]}}"#
    )
}

/// The live save shape (`equipSlots`) with a main hand carrying two Cast When Strikes rows.
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
}

// ---------------------------------------------------------------------------------------------------------------
// A synthetic SPELLS.STD under the temp root: reuse of the fixture shape `tests/build.rs` writes (never a game file).
// ---------------------------------------------------------------------------------------------------------------

/// One effect as the record stores it: `(type, subType, durationBase, durationMod, durationPerLevel,
/// magnitudeBaseLow, magnitudeBaseHigh, magnitudeLevelBase, magnitudeLevelHigh, magnitudePerLevel)`.
type SpellEffect = (i8, i8, u8, u8, u8, u8, u8, u8, u8, u8);

/// One 89-byte `SPELLS.STD` record, field for field as `src/spells.js:24-50` reads it.
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

/// An instant DamageHealth (4,0) and a ContinuousDamageHealth (1,0) DoT, indexed 1 and 2 to match `cws_save`.
fn spells_std() -> Vec<u8> {
    [
        spell_record(1, "Bolt", 4, &[(4, 0, 0, 0, 1, 10, 20, 0, 0, 1)]),
        spell_record(2, "Burn", 4, &[(1, 0, 2, 1, 1, 4, 8, 0, 0, 1)]),
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
}

// ---------------------------------------------------------------------------------------------------------------

#[test]
fn the_theory_card_matches_the_js() {
    let root = temp_root("theory");
    same(&["enchant", "--theory"], &root);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_theory_variants_match_the_js() {
    let root = temp_root("variants");
    for args in [
        &["enchant", "--theory", "--target", "soft"][..],
        &["enchant", "--theory", "--target", "tough"][..],
        &[
            "enchant", "--theory", "--target", "boss", "--health", "8000",
        ][..],
        &["enchant", "--theory", "--target", "gate", "--players", "2"][..],
        &["enchant", "--theory", "--potency", "30"][..],
        &["enchant", "--theory", "--pierce", "20"][..],
        &["enchant", "--theory", "--traits", "curbing"][..],
        &["enchant", "--theory", "--core", "classic"][..],
        &["enchant", "--theory", "--level", "30"][..],
        &["enchant", "--theory", "--weapon", "121:3"][..],
        &["enchant", "--theory", "--blade", "118", "--race", "nord"][..],
    ] {
        same(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_theory_json_document_matches_the_js() {
    let root = temp_root("json");
    for args in [
        &["enchant", "--theory", "--json"][..],
        &[
            "enchant", "--theory", "--target", "boss", "--health", "8000", "--json",
        ][..],
        &[
            "enchant",
            "--theory",
            "--target",
            "soft",
            "--potency",
            "30",
            "--json",
        ][..],
        &["enchant", "--theory", "--traits", "curbing", "--json"][..],
    ] {
        same(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn a_save_without_a_weapon_prints_the_js_line() {
    let root = temp_root("unarmed");
    write_save(&root, "SAVE1", &no_weapon_save());
    // The JS prints the line and returns 0; `--json` is ignored before it (the branch checks the item first).
    for args in [
        &["enchant", "--save", "SAVE1"][..],
        &["enchant", "--save", "SAVE1", "--json"][..],
    ] {
        same(args, &root);
    }
    let got = rust(&["enchant", "--save", "SAVE1"], &root);
    assert_eq!(
        String::from_utf8_lossy(&got.stdout),
        "No weapon equipped. Pass --weapon or load a save with a weapon.\n"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn an_armed_save_matches_the_js_with_and_without_a_book() {
    let root = temp_root("armed-nobook");
    write_save(&root, "SAVE30", &cws_save());
    // No launcher config: both read an empty book, so every proc is 0 and the card is the plain one.
    for args in [
        &["enchant", "--save", "SAVE30"][..],
        &["enchant", "--save", "SAVE30", "--json"][..],
        &[
            "enchant", "--save", "SAVE30", "--target", "boss", "--health", "8000",
        ][..],
        &["enchant", "--save", "SAVE30", "--potency", "30", "--json"][..],
        &["enchant", "--save", "SAVE30", "--target", "tough"][..],
        // A raw `armoured` is the Breach gate even for a save (the branch tests the flag, not the resolved foe).
        &[
            "enchant", "--save", "SAVE30", "--target", "armoured", "--json",
        ][..],
        &["enchant", "--save", "SAVE30", "--weapon", "121:5"][..],
    ] {
        same(args, &root);
    }
    let js_out = js(&["enchant", "--save", "SAVE30", "--json"], &root);
    let out = String::from_utf8_lossy(&js_out.stdout);
    assert!(
        out.contains("\"enchantDps\": 0,"),
        "without a book the procs are unpriced: {out}"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn cws_nonzero_procs_match_the_js() {
    let root = temp_root("cws");
    write_save(&root, "SAVE30", &cws_save());
    write_spellbook(&root);

    // A nonzero proc proves the synthetic book was read (an empty book would price 0).
    let js_json = js(&["enchant", "--save", "SAVE30", "--json"], &root);
    assert_eq!(js_json.status.code(), Some(0));
    let out = String::from_utf8_lossy(&js_json.stdout);
    assert!(
        !out.contains("\"enchantDps\": 0,"),
        "the CWS procs should be priced from the synthetic book: {out}"
    );
    for args in [
        &["enchant", "--save", "SAVE30"][..],
        &["enchant", "--save", "SAVE30", "--json"][..],
        &[
            "enchant", "--save", "SAVE30", "--target", "boss", "--health", "8000",
        ][..],
        &[
            "enchant",
            "--save",
            "SAVE30",
            "--target",
            "soft",
            "--potency",
            "30",
            "--json",
        ][..],
        &["enchant", "--save", "SAVE30", "--pierce", "20"][..],
    ] {
        same(args, &root);
    }
    // The text card names each proc and its amount.
    let js_text = js(&["enchant", "--save", "SAVE30"], &root);
    let text = String::from_utf8_lossy(&js_text.stdout).into_owned();
    assert!(
        text.contains("Bolt"),
        "the proc line names the spell: {text}"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_flag_refusals_match_the_js() {
    let root = temp_root("usage");
    // `enchant` writes no page, so `--out` is refused by both with the JS `checkOutputFlags` message.
    same_usage(&["enchant", "--theory", "--out", "x.html"], &root);
    // `--data` (an explicit ARENA2 dir) is read by the JS branch; this slice refuses it by name like the other ported
    // commands refuse an unported flag, rather than silently pricing from the launcher's book.
    let data = rust(&["enchant", "--theory", "--data", "/x"], &root);
    assert_eq!(data.status.code(), Some(2), "rust --data is refused");
    assert!(
        String::from_utf8_lossy(&data.stderr)
            .contains("--data is not read by enchant; probe, spell and spells read it"),
        "{}",
        String::from_utf8_lossy(&data.stderr)
    );
    assert_eq!(
        js(&["enchant", "--theory", "--data", "/x"], &root)
            .status
            .code(),
        Some(0),
        "the JS reads --data"
    );
    // A positional the branch ignores is refused by this slice on purpose, so only the exit code is compared.
    let extra = rust(&["enchant", "--theory", "junk"], &root);
    assert_eq!(extra.status.code(), Some(2));
    assert!(!extra.stderr.is_empty(), "a refusal explains itself");
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn help_lists_the_enchant_command() {
    let root = temp_root("help");
    let got = rust(&["--help"], &root);
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    for flag in [
        "dfo-cli enchant",
        "enchantment rows",
        "No weapon equipped",
        "--json",
    ] {
        assert!(text.contains(flag), "help names {flag}");
    }
    fs::remove_dir_all(&root).expect("cleanup");
}
