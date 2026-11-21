//! The R8 save slice, differentially against the real JS CLI over synthetic fixtures.
//!
//! Each case writes its own tiny save folder (never a real save) under a temp `DAGGER_USER_DATA` root and runs both
//! `bin/dfo-dps.js` and the Rust binary with that root. Stdout must match byte for byte: `saves` and the save-backed
//! `rank` (text and `--json`), across the offline shape (`items[].equipSlot`) and the live shape (`equipSlots`).
//!
//! Usage errors compare the exit code and require stderr where the JS's own text is a parser's, not this port's. A
//! skipped differential proves nothing, so a missing `node` panics.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// A fresh temp root; the caller's fixture lives under `<root>/Saves`.
fn temp_root(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root =
        std::env::temp_dir().join(format!("dfo-cli-saves-{label}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("Saves")).expect("temp fixture root");
    root
}

fn write(path: &Path, text: &str) {
    fs::write(path, text).expect("fixture file");
}

fn set_mtime(path: &Path, when: &str) {
    // A fixed, unambiguous mtime: seconds since the epoch, then the file is set to it.
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

fn cli(program: &str, args: &[&str], root: &Path) -> Output {
    Command::new(program)
        .args(args)
        .current_dir(repo_root())
        .env("DAGGER_USER_DATA", root)
        .output()
        .expect("the CLI runs")
}

fn js(args: &[&str], root: &Path) -> Output {
    Command::new("node")
        .arg("bin/dfo-dps.js")
        .args(args)
        .current_dir(repo_root())
        .env("DAGGER_USER_DATA", root)
        .output()
        .expect("the JS CLI runs (this repository's Node project)")
}

fn rust(args: &[&str], root: &Path) -> Output {
    cli(env!("CARGO_BIN_EXE_dfo-cli"), args, root)
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

fn same_usage(args: &[&str], root: &Path) {
    let want = js(args, root);
    let got = rust(args, root);
    assert_eq!(
        want.status.code(),
        Some(2),
        "js {args:?} root {root:?}: stdout {:?} stderr {:?}",
        String::from_utf8_lossy(&want.stdout),
        String::from_utf8_lossy(&want.stderr)
    );
    assert_eq!(got.status.code(), Some(2), "rust {args:?}");
    assert!(
        !got.stderr.is_empty(),
        "a refusal explains itself: {args:?}"
    );
}

/// A refusal this port reproduces word for word (a checked command/flag pair, not a parser's own text).
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
fn saves_lists_the_fixture_newest_first_and_matches_the_js() {
    let root = temp_root("list");
    let saves = root.join("Saves");
    for (slot, name, character, when) in [
        ("SAVE1", "Older", "Aerith", "1709251199"),
        ("SAVE12", "Newest", "Bobby", "1709251200"),
    ] {
        let dir = saves.join(slot);
        fs::create_dir_all(&dir).expect("save folder");
        write(&dir.join("SaveData.txt"), &offline_save(12));
        write(
            &dir.join("SaveInfo.txt"),
            &format!(r#"{{"saveName":"{name}","characterName":"{character}"}}"#),
        );
        set_mtime(&dir.join("SaveData.txt"), when);
    }
    // A folder with no SaveData.txt is not a save.
    fs::create_dir_all(saves.join("SAVE2")).expect("empty save folder");

    same(&["saves"], &root);
    // A named slot is the same card, and the default rank reads the newest save.
    same(&["rank", "--save", "SAVE1", "--json"], &root);
    same(&["rank", "--save", "1", "--json"], &root);
    same(&["rank", "--json"], &root);
    same_usage(&["rank", "--save", "3"], &root);
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_offline_save_shape_ranks_like_the_js() {
    let root = temp_root("offline");
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    write(&dir.join("SaveData.txt"), &offline_save(20));

    for args in [
        &["rank"][..],
        &["rank", "weapons"][..],
        &["rank", "--json"][..],
        &["rank", "weapons", "--json"][..],
        &["rank", "--top", "5"][..],
        &["rank", "--target", "soft", "--json"][..],
        &["rank", "--target", "tough"][..],
        &["rank", "--target", "boss", "--health", "8000", "--json"][..],
        &["rank", "--target", "breach", "--players", "2"][..],
        &["rank", "--offline", "--json"][..],
        &["rank", "--passive", "none"][..],
        &["rank", "--passive", "assassin", "--json"][..],
        &["rank", "--bare", "--json"][..],
        &["rank", "--no-effects", "--json"][..],
        &["rank", "--core", "classic"][..],
        &["rank", "--base-stats", "75"][..],
    ] {
        same(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_live_save_shape_ranks_like_the_js() {
    let root = temp_root("live");
    let dir = root.join("Saves").join("SAVE20");
    fs::create_dir_all(&dir).expect("save folder");
    write(&dir.join("SaveData.txt"), &live_save());
    write(
        &dir.join("SaveInfo.txt"),
        r#"{"saveName":"Live","characterName":"Livehero"}"#,
    );

    for args in [
        &["saves"][..],
        &["rank"][..],
        &["rank", "--json"][..],
        &["rank", "--offline"][..],
        &["rank", "--passive", "none", "--json"][..],
        &["rank", "--bare"][..],
        &["rank", "--no-effects", "--json"][..],
        &["rank", "--target", "tough", "--top", "1000", "--json"][..],
        // A save keeps the worn weapon unless `--weapon` overrides it (the theory character has its own blade).
        &["rank", "--weapon", "121:3", "--json"][..],
        &["rank", "--weapon", "121"][..],
    ] {
        same(args, &root);
    }
    // `--json` and `--out` are refused by `saves`, with the JS's own messages.
    for args in [&["saves", "--json"][..], &["saves", "--out", "x.html"][..]] {
        same_usage_text(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn a_save_is_found_by_slot_number_folder_or_file() {
    let root = temp_root("resolve");
    let dir = root.join("Saves").join("SAVE7");
    fs::create_dir_all(&dir).expect("save folder");
    write(&dir.join("SaveData.txt"), &offline_save(9));

    same(&["rank", "--save", "SAVE7", "--json"], &root);
    same(&["rank", "--save", "7", "--json"], &root);
    same(
        &[
            "rank",
            "--save",
            dir.join("SaveData.txt").to_str().expect("utf-8 path"),
            "--json",
        ],
        &root,
    );
    same(
        &[
            "rank",
            "--save",
            dir.to_str().expect("utf-8 path"),
            "--json",
        ],
        &root,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn an_empty_or_broken_root_fails_like_the_js() {
    let empty = temp_root("empty");
    // `saves` has a card for "no saves found"; `rank` is a usage error for both CLIs.
    same(&["saves"], &empty);
    same_usage(&["rank"], &empty);
    same_usage(&["rank", "--save", "SAVE1"], &empty);

    // A missing/mistyped save is a usage error with the same exit code (the JS's parser text is not this port's).
    let root = temp_root("broken");
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    write(&dir.join("SaveData.txt"), "{ not json");
    same_usage(&["rank"], &root);
    // A JSON array is an object to the JS guard (`typeof raw === 'object'`): both build the level-1 nobody.
    write(&dir.join("SaveData.txt"), "[1, 2]");
    same(&["rank"], &root);
    write(&dir.join("SaveData.txt"), "null");
    same_usage(&["rank"], &root);

    fs::remove_dir_all(&empty).expect("cleanup");
    fs::remove_dir_all(&root).expect("cleanup");
}
