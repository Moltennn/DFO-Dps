//! The R8 `build --json` slice, differentially against the real JS CLI.
//!
//! Every case runs `bin/dfo-dps.js build ...` and the Rust binary with the same arguments and compares stdout byte for
//! byte. The JS is the oracle: a port that drifts from `src/cli.js` `summary()` fails here.
//!
//! The theory cases read no save. The save-backed cases write their own tiny fixture under a temp `DAGGER_USER_DATA`
//! root (never a real save), which also proves the read-only import feeds the build card. `build` text is not ported:
//! the Rust CLI must refuse it (exit 2) instead of printing a different format, while the JS text card is untouched.
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn js(args: &[&str]) -> Output {
    Command::new("node")
        .arg("bin/dfo-dps.js")
        .args(args)
        .current_dir(repo_root())
        .output()
        .expect("the JS CLI runs (this repository's Node project)")
}

fn rust(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_dfo-cli"))
        .args(args)
        .current_dir(repo_root())
        .output()
        .expect("the Rust CLI binary runs")
}

fn js_env(args: &[&str], root: &Path) -> Output {
    Command::new("node")
        .arg("bin/dfo-dps.js")
        .args(args)
        .current_dir(repo_root())
        .env("DAGGER_USER_DATA", root)
        .output()
        .expect("the JS CLI runs (this repository's Node project)")
}

fn rust_env(args: &[&str], root: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_dfo-cli"))
        .args(args)
        .current_dir(repo_root())
        .env("DAGGER_USER_DATA", root)
        .output()
        .expect("the Rust CLI binary runs")
}

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

/// A fresh temp root; the caller's fixture lives under `<root>/Saves`.
fn temp_root(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root =
        std::env::temp_dir().join(format!("dfo-cli-build-{label}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("Saves")).expect("temp fixture root");
    root
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
    same(&["--theory", "--json", "--top", "2"]);
    same(&["--theory", "--json", "--target", "soft"]);
}

#[test]
fn build_text_is_refused_explicitly() {
    // The JS prints its own text card; this slice does not port it and must say so instead of printing a different
    // format under the same command. Exit 2, a message naming `--json`, and no card on stdout.
    for args in [
        &["build", "--theory"][..],
        &["build", "--theory", "--target", "boss"][..],
        &["--theory"][..],
    ] {
        let got = rust(args);
        assert_eq!(got.status.code(), Some(2), "rust {args:?}");
        let stderr = String::from_utf8_lossy(&got.stderr);
        assert!(
            stderr.contains("--json"),
            "the refusal names the supported output: {args:?} -> {stderr}"
        );
        assert!(got.stdout.is_empty(), "no card for a refusal: {args:?}");
        // The JS still prints its card, so this is a documented gap, not a JS failure.
        assert_eq!(js(args).status.code(), Some(0), "js {args:?}");
    }
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

#[test]
fn help_lists_build() {
    let got = rust(&["--help"]);
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    assert!(text.contains("build"), "help names build");
    assert!(text.contains("--json"), "help names --json");
}
