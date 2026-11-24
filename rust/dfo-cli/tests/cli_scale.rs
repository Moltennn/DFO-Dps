//! The R8 `scale` command, differentially against the real JS CLI over theory and synthetic saves.
//!
//! Every case runs `bin/dfo-dps.js scale ...` and the Rust binary with the same arguments and compares stdout (and
//! stderr for a refusal) byte for byte. The JS is the oracle: a port that drifts from `src/cli.js` `scaleRange`,
//! `printScale`, the `--all` summary or the `--json` rows fails here.
//!
//! Theory cases read no save. The save-backed cases write their own tiny fixtures under a temp `DAGGER_USER_DATA` root
//! (never a real save), which also proves the read-only import feeds the curve. A missing `node` panics rather than
//! skips, because a skipped differential proves nothing.
//!
//! LIMITATION: `scale --all --json` is refused by both CLIs (`checkOutputFlags`). The JS also prices Cast When Strikes
//! through `SPELLS.STD`; these fixtures carry no `type = 2` enchantment, and the empty-book fallback is the same on both
//! sides (`tests/build.rs` covers the synthetic book).

mod common;

use common::{js, rust, temp_root};

use std::fs;
use std::path::{Path, PathBuf};

/// A success case: both exit 0, stdout byte-identical.
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
        Some(0),
        "rust {args:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&got.stdout),
        String::from_utf8_lossy(&want.stdout),
        "stdout differs for {args:?}"
    );
}

/// A usage refusal: both exit 2 with the same stderr line and no stdout.
fn same_usage(args: &[&str], root: &Path) {
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
}

/// The offline save shape: a main hand (long blade) and an off hand, stats and skills.
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

/// The live save shape (`equipSlots`, `_mods` with a gear skill, `_enchantMods`, effects).
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
    let skills = (0..35)
        .map(|i| (50 + i % 20).to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"{{"name":"Live Fixture","level":30,"raceId":1,"race":"Breton","gender":"male",
"health":150,"maxHealth":200,"magicka":120,"maxMagicka":240,
"stats":{{{stats}}},"skills":[{skills}],
"equipSlots":{{
"4":{{"group":"Jewelry","templateIndex":300,"name":"Live Ring","affixes":[{{"id":"stat","param":"luck","value":8}}]}},
"19":{{"group":"Weapons","templateIndex":121,"name":"Live Katana","material":5,"currentCondition":80,"maxCondition":100,
"affixes":[{{"id":"damage","value":12}},{{"id":"skill","param":29,"value":7}},{{"id":"stat","param":"strength","value":4}}],
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

/// A save whose `skills` array is short (the JS `c.skills[id] = v` grows it, holes become null in the JSON copy) and
/// whose `_mods` is absent (the gear write creates the map).
fn short_save() -> String {
    r#"{"name":"Short","level":12,"raceId":3,"race":"Nord",
"health":70,"maxHealth":90,"stats":{"strength":45,"agility":55},
"skills":[30,40],"items":[
{"group":"Weapons","templateIndex":122,"equipSlot":19,"name":"Steel Dagger","material":3,"currentCondition":100,"maxCondition":100}]}"#
        .to_owned()
}

/// Write `text` as `<root>/Saves/<folder>/SaveData.txt`.
fn write_save(root: &Path, folder: &str, text: &str) -> PathBuf {
    let dir = root.join("Saves").join(folder);
    fs::create_dir_all(&dir).expect("save folder");
    let file = dir.join("SaveData.txt");
    fs::write(&file, text).expect("save fixture");
    file
}

#[test]
fn scale_theory_curves_match_the_js() {
    let root = temp_root("theory");

    // A mixed-case attribute is lower-cased by the branch, as the JS does.
    same(&["scale", "--theory", "--stat", "Strength"], &root);

    // One attribute: the default range is current (100) to 100, so one row.
    for stat in [
        "strength",
        "intelligence",
        "willpower",
        "agility",
        "endurance",
        "personality",
        "speed",
        "luck",
    ] {
        same(&["scale", "--theory", "--stat", stat], &root);
    }
    // The range flags: mid-range points, a non-10 step and a cap that the step does not land on.
    same(
        &[
            "scale", "--theory", "--stat", "agility", "--from", "80", "--to", "120", "--step", "5",
        ],
        &root,
    );
    same(
        &[
            "scale", "--theory", "--stat", "speed", "--from", "90", "--to", "95", "--step", "3",
        ],
        &root,
    );
    same(
        &[
            "scale", "--theory", "--stat", "luck", "--from", "97", "--to", "103", "--step", "2",
        ],
        &root,
    );
    same(
        &[
            "scale", "--theory", "--stat", "strength", "--from", "10", "--to", "100", "--step",
            "30",
        ],
        &root,
    );
    // A fractional step is legal (only `--step` has an exclusive-minimum bound).
    same(
        &[
            "scale", "--theory", "--stat", "strength", "--from", "90", "--to", "100", "--step",
            "7.5",
        ],
        &root,
    );
    // `--to` below `--from`: the JS returns no points; the text card is the bare header.
    same(
        &[
            "scale", "--theory", "--stat", "strength", "--from", "100", "--to", "50",
        ],
        &root,
    );

    // Raw skills: the default 100..200, and a skill the character carries at 200.
    same(&["scale", "--theory", "--skill", "29"], &root);
    same(&["scale", "--theory", "--skill", "0"], &root);
    same(&["scale", "--theory", "--skill", "34"], &root);
    same(
        &[
            "scale", "--theory", "--skill", "29", "--from", "100", "--to", "130", "--step", "15",
        ],
        &root,
    );
    same(
        &[
            "scale", "--theory", "--skill", "20", "--from", "0", "--to", "50", "--step", "20",
        ],
        &root,
    );

    // Gear skill affixes: the default range is current..current+100.
    same(&["scale", "--theory", "--gear-skill", "29"], &root);
    same(&["scale", "--theory", "--gear-skill", "34"], &root);
    same(
        &[
            "scale",
            "--theory",
            "--gear-skill",
            "29",
            "--from",
            "0",
            "--to",
            "20",
            "--step",
            "10",
        ],
        &root,
    );
    same(
        &[
            "scale",
            "--theory",
            "--gear-skill",
            "34",
            "--from",
            "0",
            "--to",
            "0",
            "--step",
            "1",
        ],
        &root,
    );

    // The target/scenario flags the curve prices: the curve is re-analysed with them, as the JS does.
    same(
        &[
            "scale", "--theory", "--stat", "strength", "--target", "tough",
        ],
        &root,
    );
    same(
        &[
            "scale", "--theory", "--stat", "strength", "--core", "classic", "--no-rri",
        ],
        &root,
    );
    same(
        &[
            "scale", "--theory", "--skill", "29", "--weapon", "121:5", "--from", "100", "--to",
            "120",
        ],
        &root,
    );
    same(
        &[
            "scale", "--theory", "--stat", "strength", "--behind", "--from", "100",
        ],
        &root,
    );
    same(
        &["scale", "--theory", "--gear-skill", "29", "--vampire"],
        &root,
    );
    same(
        &["scale", "--theory", "--stat", "luck", "--base-stats", "40"],
        &root,
    );
    // A mixed-case `--core`/`--target` is lower-cased for the analysis but printed as typed, as the JS does.
    same(
        &[
            "scale", "--theory", "--stat", "strength", "--core", "OVERHAUL", "--target", "Tough",
        ],
        &root,
    );

    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn scale_all_matches_the_js() {
    let root = temp_root("all");
    same(&["scale", "--theory", "--all"], &root);
    same(&["scale", "--theory", "--all", "--target", "tough"], &root);
    same(&["scale", "--theory", "--all", "--vampire"], &root);
    // `--all` reads no `--from`/`--to`/`--step`; they are ignored by the JS branch, so both agree.
    same(
        &["scale", "--theory", "--all", "--from", "50", "--to", "60"],
        &root,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn scale_json_matches_the_js() {
    let root = temp_root("json");
    same(
        &["scale", "--theory", "--stat", "strength", "--json"],
        &root,
    );
    same(
        &[
            "scale", "--theory", "--stat", "agility", "--from", "80", "--to", "120", "--step", "5",
            "--json",
        ],
        &root,
    );
    same(
        &[
            "scale", "--theory", "--skill", "29", "--from", "100", "--to", "130", "--step", "15",
            "--json",
        ],
        &root,
    );
    same(
        &[
            "scale", "--theory", "--skill", "0", "--from", "100", "--to", "100", "--json",
        ],
        &root,
    );
    same(
        &["scale", "--theory", "--gear-skill", "29", "--json"],
        &root,
    );
    same(
        &[
            "scale", "--theory", "--stat", "strength", "--from", "100", "--to", "50", "--json",
        ],
        &root,
    );
    same(
        &[
            "scale", "--theory", "--skill", "34", "--target", "boss", "--json",
        ],
        &root,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn scale_usage_matches_the_js() {
    let root = temp_root("usage");
    // No channel selected.
    same_usage(&["scale", "--theory"], &root);
    // An unknown attribute, and two `--stat`s in one run.
    same_usage(&["scale", "--theory", "--stat", "nope"], &root);
    same_usage(
        &[
            "scale", "--theory", "--stat", "strength", "--stat", "agility",
        ],
        &root,
    );
    // Skill ids outside 0..34 (a flag-level `numFlag` refusal for both).
    same_usage(&["scale", "--theory", "--skill=35"], &root);
    same_usage(&["scale", "--theory", "--skill=-1"], &root);
    same_usage(&["scale", "--theory", "--gear-skill=35"], &root);
    same_usage(&["scale", "--theory", "--gear-skill=-1"], &root);
    // An empty value is a flag-level refusal for the two integer ids and a branch refusal for the name.
    same_usage(&["scale", "--theory", "--skill="], &root);
    same_usage(&["scale", "--theory", "--gear-skill="], &root);
    same_usage(&["scale", "--theory", "--stat="], &root);
    // `-0` is a real id 0 (the label is `String(-0)`, `"0"`); it reaches the curve, not a refusal.
    same(
        &[
            "scale",
            "--theory",
            "--skill=-0",
            "--from",
            "100",
            "--to",
            "100",
        ],
        &root,
    );
    same(
        &[
            "scale",
            "--theory",
            "--gear-skill=-0",
            "--from",
            "0",
            "--to",
            "0",
        ],
        &root,
    );
    // `--json` has no `--all` form in either CLI.
    same_usage(&["scale", "--theory", "--all", "--json"], &root);
    // `--out` writes no file here; the JS refuses it too.
    same_usage(
        &["scale", "--theory", "--stat", "strength", "--out", "x.html"],
        &root,
    );
    // A flag-level bound still runs before the branch (step 0, an unknown target).
    same_usage(
        &["scale", "--theory", "--stat", "strength", "--step", "0"],
        &root,
    );
    same_usage(
        &[
            "scale", "--theory", "--stat", "strength", "--target", "nope",
        ],
        &root,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn scale_from_an_imported_save_matches_the_js() {
    let root = temp_root("save");
    write_save(&root, "SAVE1", &offline_save());
    write_save(&root, "SAVE2", &live_save());

    // The default: the newest save (SAVE2).
    same(&["scale", "--stat", "strength"], &root);
    same(
        &[
            "scale", "--stat", "agility", "--from", "80", "--to", "120", "--step", "5",
        ],
        &root,
    );
    same(&["scale", "--skill", "29", "--json"], &root);
    same(
        &["scale", "--skill", "34", "--from", "50", "--to", "90"],
        &root,
    );
    // The gear affix the live save carries (`_mods.skills[29] = 3`), and one it does not (34 -> 0).
    same(&["scale", "--gear-skill", "29"], &root);
    same(
        &["scale", "--gear-skill", "34", "--from", "0", "--to", "10"],
        &root,
    );
    same(&["scale", "--all"], &root);

    // A named save slot and the offline shape: the same channel over a different character.
    same(&["scale", "--save", "SAVE1", "--stat", "strength"], &root);
    same(&["scale", "--save", "SAVE1", "--all"], &root);
    same(
        &["scale", "--save", "SAVE1", "--skill", "29", "--json"],
        &root,
    );
    same(
        &["scale", "--save", "SAVE1", "--gear-skill", "29", "--json"],
        &root,
    );

    // `--weapon` overrides the scenario's descriptor, and `--all` reads its skill id.
    same(
        &[
            "scale", "--save", "SAVE1", "--stat", "strength", "--weapon", "123:9",
        ],
        &root,
    );
    same(
        &["scale", "--save", "SAVE1", "--all", "--weapon", "123:9"],
        &root,
    );

    fs::remove_dir_all(&root).expect("cleanup");
}

/// A short `skills` array and a missing `_mods`: the JS grows the array (holes are `null` in the JSON copy) and creates
/// the maps on a gear write, so a curve over an unset id reads 0 and still prices.
#[test]
fn scale_over_sparse_skills_and_missing_mods_matches_the_js() {
    let root = temp_root("sparse");
    write_save(&root, "SAVE1", &short_save());

    same(
        &[
            "scale", "--skill", "5", "--from", "0", "--to", "200", "--step", "50",
        ],
        &root,
    );
    same(&["scale", "--skill", "34", "--json"], &root);
    same(
        &["scale", "--gear-skill", "29", "--from", "0", "--to", "10"],
        &root,
    );
    same(&["scale", "--all"], &root);
    same(&["scale", "--stat", "intelligence"], &root);
    // A fractional live stat: `String(v)` in the `current → cap` cell and the range's two-decimal rounding both follow
    // the JS templates, not a fixed format.
    write_save(
        &root,
        "SAVE2",
        r#"{"name":"Frac","level":20,"raceId":2,"race":"Redguard","health":80,"maxHealth":100,
"stats":{"strength":62.5,"agility":37.25},"skills":[80],"items":[]}"#,
    );
    same(&["scale", "--save", "SAVE2", "--all"], &root);
    same(
        &[
            "scale", "--save", "SAVE2", "--stat", "strength", "--to", "70", "--step", "2.5",
        ],
        &root,
    );
    same(
        &["scale", "--save", "SAVE2", "--stat", "agility", "--json"],
        &root,
    );
    // A raw skill already past its 200 cap: `current → cap` reads `250 → 200` and the delta is negative, as the JS
    // prints it (the summary prices both runs regardless of direction).
    write_save(
        &root,
        "SAVE3",
        r#"{"name":"Over","level":45,"raceId":1,"race":"Breton","health":100,"maxHealth":100,
"stats":{"strength":100,"agility":100},"skills":[250],"masterSkills":true,"items":[]}"#,
    );
    same(&["scale", "--save", "SAVE3", "--all"], &root);
    same(&["scale", "--save", "SAVE3", "--skill", "0"], &root);
    // No weapon at all: the weapon id falls back to 30 (HandToHand), so `--all`'s skill and gear rows use 30.
    write_save(
        &root,
        "SAVE4",
        r#"{"name":"Fists","level":30,"raceId":6,"race":"Khajiit","health":90,"maxHealth":90,
"stats":{"strength":70,"agility":80},"skills":[100,100,100],"items":[]}"#,
    );
    same(&["scale", "--save", "SAVE4", "--all"], &root);
    same(&["scale", "--save", "SAVE4", "--stat", "strength"], &root);

    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn scale_flags_are_refused_elsewhere() {
    let root = temp_root("boundary");
    // `--skill`/`--gear-skill` are priced by `scale` alone; the other ported commands refuse them by name.
    for (args, refusal) in [
        (
            &["build", "--theory", "--skill", "29"][..],
            "--skill is not read by build; only scale reads it",
        ),
        (
            &["rank", "--theory", "--gear-skill", "29"][..],
            "--gear-skill is not read by rank; only scale reads it",
        ),
        (
            &["graph", "--theory", "--skill", "29"][..],
            "--skill is not read by graph; only scale reads it",
        ),
    ] {
        let got = rust(args, &root);
        assert_eq!(got.status.code(), Some(2), "rust {args:?}");
        assert!(
            String::from_utf8_lossy(&got.stderr).contains(refusal),
            "rust {args:?}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert!(got.stdout.is_empty(), "no card for {args:?}");
        let want = js(args, &root);
        assert_eq!(want.status.code(), Some(0), "js accepts {args:?}");
    }
    // `--from`/`--to`/`--step` now belong to graph and scale; `compare` still refuses them.
    for (args, refusal) in [
        (
            &[
                "compare",
                "--theory",
                "--stat",
                "strength=110",
                "--from",
                "1",
            ][..],
            "--from is not read by compare; graph and scale read it",
        ),
        (
            &["build", "--theory", "--from", "1"][..],
            "--from is not read by build; graph and scale read it",
        ),
        (
            &["build", "--theory", "--to", "1"][..],
            "--to is not read by build; graph and scale read it",
        ),
        (
            &["build", "--theory", "--step", "1"][..],
            "--step is not read by build; graph and scale read it",
        ),
    ] {
        let got = rust(args, &root);
        assert_eq!(got.status.code(), Some(2), "rust {args:?}");
        assert!(
            String::from_utf8_lossy(&got.stderr).contains(refusal),
            "rust {args:?}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn help_lists_the_scale_command() {
    let got = rust(&["--help"], &temp_root("help"));
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    for flag in [
        "dfo-cli scale",
        "--skill <id>",
        "--gear-skill <id>",
        "--stat <name>",
        "--all",
    ] {
        assert!(text.contains(flag), "help names {flag}");
    }
}
