//! The R8 `doctor` slice, differentially against the real JS CLI over synthetic fixtures.
//!
//! Each case writes its own tiny save folder (never a real save) under a temp `DAGGER_USER_DATA` root and runs both
//! `bin/dfo-dps.js` and the Rust binary with that root. Stdout must match byte for byte: the model pin, the `saves:`
//! listing (newest first), and the imported character's build/ruleset summary, in the offline shape
//! (`items[].equipSlot`) and the live shape (`equipSlots`).
//!
//! A missing, mistyped or malformed save is not an error: both print one `save: <message>` line and exit 0. For a
//! malformed document the message is the parser's own text (V8 vs `serde_json`), so that one case compares the exit
//! code, the `save: could not read <path>: ` prefix and a non-empty reason. A skipped differential proves nothing, so a
//! missing `node` panics.

mod common;

use common::{js, rust, temp_root};

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

fn write(path: &Path, text: &str) {
    fs::write(path, text).expect("fixture file");
}

fn set_mtime(path: &Path, when: &str) {
    let secs: u64 = when.parse().expect("epoch seconds");
    let stamp = SystemTime::UNIX_EPOCH + Duration::from_secs(secs);
    fs::File::options()
        .write(true)
        .open(path)
        .expect("fixture file opens")
        .set_modified(stamp)
        .expect("fixture mtime");
}

/// The offline save shape (`items[].equipSlot`): a main hand and an off hand.
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

/// A refusal this port reproduces word for word (the `checkOutputFlags` messages).
fn same_usage_text(args: &[&str], root: &Path) {
    let want = js(args, root);
    let got = rust(args, root);
    assert_eq!(want.status.code(), Some(2), "js {args:?}");
    assert_eq!(got.status.code(), Some(2), "rust {args:?}");
    assert_eq!(
        String::from_utf8_lossy(&got.stderr).trim_end(),
        String::from_utf8_lossy(&want.stderr).trim_end(),
        "stderr differs for {args:?}"
    );
    assert!(got.stdout.is_empty(), "no card for a refusal: {args:?}");
}

#[test]
fn doctor_on_an_empty_root_matches_the_js() {
    let root = temp_root("empty");
    same(&["doctor"], &root);
    for args in [
        &["doctor", "--json"][..],
        &["doctor", "--out", "x.html"][..],
    ] {
        same_usage_text(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn doctor_reports_the_offline_save_like_the_js() {
    let root = temp_root("offline");
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    write(&dir.join("SaveData.txt"), &offline_save(20));

    for args in [
        &["doctor"][..],
        &["doctor", "--offline"][..],
        &["doctor", "--save", "SAVE1"][..],
        &["doctor", "--save", "1"][..],
        &["doctor", "--save", dir.to_str().expect("utf-8 path")][..],
        &[
            "doctor",
            "--save",
            dir.join("SaveData.txt").to_str().expect("utf-8 path"),
        ][..],
    ] {
        same(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn doctor_reports_the_live_save_like_the_js() {
    let root = temp_root("live");
    let dir = root.join("Saves").join("SAVE20");
    fs::create_dir_all(&dir).expect("save folder");
    write(&dir.join("SaveData.txt"), &live_save());
    write(
        &dir.join("SaveInfo.txt"),
        r#"{"saveName":"Live","characterName":"Livehero"}"#,
    );

    for args in [
        &["doctor"][..],
        &["doctor", "--offline"][..],
        &["doctor", "--save", "SAVE20"][..],
        &["doctor", "--save", "20"][..],
    ] {
        same(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn doctor_lists_every_save_and_reads_the_named_one() {
    let root = temp_root("multi");
    let saves = root.join("Saves");
    for (slot, level, when) in [("SAVE1", 12, "1709251199"), ("SAVE12", 30, "1709251200")] {
        let dir = saves.join(slot);
        fs::create_dir_all(&dir).expect("save folder");
        write(&dir.join("SaveData.txt"), &offline_save(level));
        set_mtime(&dir.join("SaveData.txt"), when);
    }
    // The listing is newest first, so SAVE12 comes first; a named save is the one read.
    same(&["doctor"], &root);
    same(&["doctor", "--save", "SAVE1"], &root);
    same(&["doctor", "--save", "SAVE12"], &root);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn doctor_prints_a_missing_or_bad_save_as_one_line() {
    let root = temp_root("bad");
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    // A named-away save: the message is ours, so it must match the JS word for word.
    same(&["doctor"], &root);
    same(&["doctor", "--save", "SAVE2"], &root);

    // Malformed JSON: exit 0 and one line either way, but the parser's own text differs (V8 vs serde_json), documented
    // in rust/README.md. Compare the prefix and require a non-empty reason.
    write(&dir.join("SaveData.txt"), "{ not json");
    let want = js(&["doctor"], &root);
    let got = rust(&["doctor"], &root);
    assert_eq!(want.status.code(), Some(0), "js doctor on a bad save");
    assert_eq!(got.status.code(), Some(0), "rust doctor on a bad save");
    let want_text = String::from_utf8_lossy(&want.stdout);
    let got_text = String::from_utf8_lossy(&got.stdout);
    let want_prefix = format!(
        "save: could not read {}: ",
        dir.join("SaveData.txt").display()
    );
    assert!(want_text.contains(&want_prefix), "js line: {want_text}");
    assert!(got_text.contains(&want_prefix), "rust line: {got_text}");
    assert!(
        got_text
            .lines()
            .any(|l| l.starts_with(&want_prefix) && l.len() > want_prefix.len()),
        "the rust line explains itself: {got_text}"
    );
    // The pin and the listing still print before the failed load.
    assert_eq!(
        want_text.lines().take(2).collect::<Vec<_>>(),
        got_text.lines().take(2).collect::<Vec<_>>(),
        "the header and the saves line match"
    );

    // A JSON array is an object to both guards (the JS `typeof raw === 'object'`); `null` is refused by both.
    write(&dir.join("SaveData.txt"), "[1, 2]");
    same(&["doctor"], &root);
    write(&dir.join("SaveData.txt"), "null");
    same(&["doctor"], &root);

    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn doctor_reports_career_and_bare_hands_like_the_js() {
    let root = temp_root("edge");
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    // A career label, a bare-handed character with no weapon, `masteredSkills` not an array (the JS `ARRAY` gives []),
    // a racial effect, and a saved `online: false` the doctor option overrides (its default is online).
    write(
        &dir.join("SaveData.txt"),
        r#"{"name":"Edge","level":7,"raceId":99,"race":"Orc","gender":"male",
"career":{"name":"Nightblade"},"reflexes":3,"health":40,"maxHealth":50,"skills":[10],
"masteredSkills":"not-an-array","martialPath":null,"online":false,"stats":{"strength":30},
"activeEffects":[{"kind":"racialOverride","statMods":{"agility":5},"ended":false}],"items":[]}"#,
    );
    write(&dir.join("SaveInfo.txt"), r#"{"saveName":"Edge"}"#);
    same(&["doctor"], &root);
    same(&["doctor", "--offline"], &root);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn doctor_ignores_a_missing_saveinfo_and_refuses_extra_positionals() {
    let root = temp_root("extra");
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    write(&dir.join("SaveData.txt"), &offline_save(5));

    // The JS ignores an extra positional; this slice refuses it by name, as `saves` and `rank` already do.
    let got = rust(&["doctor", "extra"], &root);
    assert_eq!(got.status.code(), Some(2), "extra positional refused");
    assert!(String::from_utf8_lossy(&got.stderr).contains("unexpected positional argument"));
    assert!(got.stdout.is_empty());

    fs::remove_dir_all(&root).expect("cleanup");
}
