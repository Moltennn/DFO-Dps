//! The R8 `compare` slice, differentially against the real JS CLI.
//!
//! Every success case runs `bin/dfo-dps.js compare ...` and the Rust binary with the same arguments and compares stdout
//! byte for byte (the four-column card), then the usage errors compare stderr and the exit code. The JS is the oracle.
//!
//! The theory cases read no save. The save-backed cases write their own tiny fixture under a temp `DAGGER_USER_DATA`
//! root (never a real save), which also proves the read-only import feeds the comparison. A missing `node` panics
//! rather than skips, because a skipped differential proves nothing.
//!
//! LIMITATION: `compare` prints text only, so the only output is the card; `--json` and `--out` are refused on both
//! sides and `unsupported_boundaries` pins that.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
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
        .env("LC_ALL", "en_US.UTF-8")
        .env("LANG", "en_US.UTF-8")
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

/// A fresh empty user-data root (no config, no save, so both CLIs take the empty spellbook).
fn empty_root(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "dfo-cli-compare-{label}-{}-{n}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("Saves")).expect("temp root");
    root
}

/// The offline save shape (`items[].equipSlot`): a main hand and an off hand.
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

/// A `DAGGER_USER_DATA` root with one imported save (`SAVE1`).
fn save_root(label: &str) -> PathBuf {
    let root = empty_root(label);
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("fixture save folder");
    fs::write(dir.join("SaveData.txt"), offline_save()).expect("fixture save");
    root
}

fn same(args: &[&str]) {
    same_in(&empty_root("same"), args);
}

fn same_in(root: &Path, args: &[&str]) {
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
    let _ = fs::remove_dir_all(root);
}

/// A refusal this port reproduces word for word: same exit code and same stderr line.
fn same_usage(args: &[&str]) {
    let root = empty_root("usage");
    let want = js_env(args, &root);
    let got = rust_env(args, &root);
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
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn compare_theory_stat_matches_the_js_cli() {
    same(&["compare", "--theory", "--stat", "strength=110"]);
    same(&["compare", "--theory", "--stat", "strength=0"]);
    same(&["compare", "--theory", "--stat", "strength=-20"]);
    same(&["compare", "--theory", "--stat", "luck=100"]);
    same(&["compare", "--theory", "--stat", "speed=120"]);
    same(&["compare", "--theory", "--stat", "personality=80"]);
    same(&["compare", "--theory", "--stat", "29=200"]);
    same(&["compare", "--theory", "--stat", "34=0"]);
    same(&["compare", "--theory", "--stat", "34=300"]);
    same(&["compare", "--theory", "--stat", "0=150"]);
    // A skill id past the model's 0..34 range (a JS array hole, or a non-index property) changes nothing.
    same(&["compare", "--theory", "--stat", "35=150"]);
    same(&["compare", "--theory", "--stat", "4294967295=5"]);
    same(&["compare", "--theory", "--stat", "99999999999999999999=5"]);
    same(&["compare", "--theory", "--stat", "00=150"]);
    same(&["compare", "--theory", "--stat=strength=110"]);
    same(&["compare", "--theory", "--stat=29=200"]);
    same(&[
        "compare",
        "--theory",
        "--stat",
        "strength=110",
        "--stat=agility=80",
    ]);
    same(&[
        "compare",
        "--theory",
        "--stat",
        "strength=110",
        "--stat",
        "agility=90",
    ]);
    // The left side is lower-cased, so a mixed-case attribute name is the same attribute.
    same(&["compare", "--theory", "--stat", "Strength=110"]);
    same(&["compare", "--theory", "--stat", "29=-5"]);
    // `name in ch.stats` is true for the inherited `constructor`, so JS accepts it and writes an unused key: the card
    // is unchanged, and so is this port's.
    same(&["compare", "--theory", "--stat", "constructor=10"]);
}

#[test]
fn compare_theory_weapon_and_scenario_match_the_js_cli() {
    same(&["compare", "--theory", "--weapon", "121:3"]);
    same(&["compare", "--theory", "--weapon", "129:1"]);
    same(&["compare", "--theory", "--weapon", "118"]);
    same(&[
        "compare",
        "--theory",
        "--weapon",
        "121:3",
        "--stat",
        "strength=110",
    ]);
    same(&[
        "compare", "--theory", "--stat", "29=200", "--weapon", "118:2",
    ]);
    same(&[
        "compare",
        "--theory",
        "--target",
        "boss",
        "--health",
        "12000",
        "--stat",
        "strength=110",
    ]);
    same(&[
        "compare",
        "--theory",
        "--target",
        "gate",
        "--stat",
        "endurance=90",
    ]);
    same(&[
        "compare",
        "--theory",
        "--race",
        "redguard",
        "--stat",
        "strength=80",
    ]);
    same(&[
        "compare",
        "--theory",
        "--level",
        "30",
        "--stat",
        "strength=80",
    ]);
    same(&[
        "compare",
        "--theory",
        "--core",
        "classic",
        "--stat",
        "strength=80",
    ]);
    same(&["compare", "--theory", "--behind", "--stat", "agility=80"]);
    same(&[
        "compare",
        "--theory",
        "--no-crit-damage",
        "--stat",
        "strength=80",
    ]);
    same(&[
        "compare",
        "--theory",
        "--swing",
        "StrikeUp",
        "--stat",
        "strength=80",
    ]);
    same(&[
        "compare",
        "--theory",
        "--firmament",
        "--stat",
        "strength=80",
    ]);
    same(&["compare", "--theory", "--vampire", "--stat", "strength=80"]);
    same(&["compare", "--theory", "--no-rri", "--stat", "strength=80"]);
    same(&[
        "compare",
        "--theory",
        "--target",
        "gate",
        "--players",
        "3",
        "--stat",
        "endurance=80",
    ]);
}

#[test]
fn compare_from_an_imported_save_matches_the_js_cli() {
    // The save-backed character is the `characterFromSave` normalisation, read read-only.
    let root = save_root("save-stat");
    same_in(
        &root,
        &["compare", "--save", "SAVE1", "--stat", "strength=60"],
    );

    let root = save_root("save-skill");
    same_in(&root, &["compare", "--save", "SAVE1", "--stat", "29=100"]);

    let root = save_root("save-weapon");
    same_in(&root, &["compare", "--save", "SAVE1", "--weapon", "121:3"]);

    // `--no-rri` keeps `weaponOverride`'s synthetic item (rri false) but `analyze` then applies the RRI damage table.
    let root = save_root("save-no-rri");
    same_in(
        &root,
        &[
            "compare",
            "--save",
            "SAVE1",
            "--no-rri",
            "--stat",
            "strength=60",
            "--weapon",
            "121:3",
        ],
    );

    let root = save_root("save-both");
    same_in(
        &root,
        &[
            "compare",
            "--save",
            "SAVE1",
            "--stat",
            "strength=60",
            "--stat",
            "34=50",
            "--weapon",
            "121:3",
        ],
    );

    // The save's own target and scenario flags: `armoured` stays the reference foe it names, unlike the theory remap.
    let root = save_root("save-target");
    same_in(
        &root,
        &[
            "compare", "--save", "SAVE1", "--target", "tough", "--stat", "luck=80",
        ],
    );
}

#[test]
fn compare_usage_matches_the_js_cli() {
    same_usage(&["compare", "--theory"]);
    same_usage(&["compare", "--theory", "--stat", "strength"]);
    same_usage(&["compare", "--theory", "--stat", "strength="]);
    same_usage(&["compare", "--theory", "--stat", "=110"]);
    same_usage(&["compare", "--theory", "--stat", "strength=11.5"]);
    same_usage(&["compare", "--theory", "--stat", "strength=+10"]);
    same_usage(&["compare", "--theory", "--stat", "nope=10"]);
    same_usage(&["compare", "--theory", "--stat", "ab1=10"]);
    same_usage(&["compare", "--theory", "--stat", "strength=1e3"]);
    same_usage(&["compare", "--theory", "--stat", "strength= 10"]);
    same_usage(&["compare", "--theory", "--stat", "strength=--10"]);
    same_usage(&["compare", "--theory", "--stat", "strength=10="]);
    same_usage(&["compare", "--theory", "--stat", "strength=110", "--all"]);
    same_usage(&["compare", "--theory", "--stat", "strength=110", "--json"]);
    same_usage(&[
        "compare",
        "--theory",
        "--stat",
        "strength=110",
        "--out",
        "x.html",
    ]);
    // The JS branch ignores positionals after the command; this CLI refuses it on purpose, as `build` and `rank` do.
    let got = rust(&["compare", "--theory", "--stat", "strength=110", "extra"]);
    assert_eq!(got.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&got.stderr).contains("unexpected positional argument"));
    assert_eq!(
        js_env(
            &["compare", "--theory", "--stat", "strength=110", "extra"],
            &empty_root("extra")
        )
        .status
        .code(),
        Some(0),
        "the JS ignores an extra positional"
    );
    // A flag-level validation still wins over the branch's own checks.
    same_usage(&[
        "compare",
        "--theory",
        "--level",
        "0",
        "--stat",
        "strength=110",
    ]);
}

/// The boundary this slice states instead of pretending to support: `compare` has no JSON form and writes no file,
/// and the code refuses both by name with the JS message. It also refuses an unparsed command.
#[test]
fn unsupported_boundaries_are_explicit() {
    same_usage(&["compare", "--theory", "--stat", "strength=110", "--json"]);
    same_usage(&[
        "compare",
        "--theory",
        "--stat",
        "strength=110",
        "--out",
        "x.html",
    ]);
    let got = rust(&["scale", "--theory", "--stat", "strength"]);
    assert_eq!(got.status.code(), Some(2));
    let text = String::from_utf8_lossy(&got.stderr);
    assert!(
        text.contains("the \"scale\" command is not ported yet"),
        "{text}"
    );
    assert!(text.contains("`compare`"), "{text}");
    // Flags the ported commands do not price are refused by name, not silently ignored (JS accepts both and drops them).
    for args in [
        &["build", "--theory", "--stat", "strength=110"][..],
        &["rank", "--theory", "--all"][..],
        &["build", "--theory", "--all"][..],
    ] {
        let got = rust(args);
        assert_eq!(got.status.code(), Some(2), "rust {args:?}");
        assert!(
            String::from_utf8_lossy(&got.stderr).contains("is not supported by this CLI slice"),
            "rust {args:?}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert!(got.stdout.is_empty(), "no card for {args:?}");
    }
}
