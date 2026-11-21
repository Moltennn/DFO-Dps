//! The R8 `enchant` card, differentially against the real JS CLI where it can be, and by local invariant elsewhere.
//!
//! The branch (`src/cli.js:1449-1477`) is not exported, so the differential cases drive `bin/dfo-dps.js enchant --theory`
//! (no save is read or written) and compare stdout byte for byte with [`enchant::text`], plus the `--json` document
//! member by member with [`enchant::document`]. The character, target, scenario, strike payload and card are the shared
//! core's, so those cases pin the rendering and the formatting, not a number.
//!
//! A synthetic weapon with enchantment rows, and a hand-built strike payload with procs, cover what the theory weapon
//! cannot reach without the game's `SPELLS.STD` (row type names, the spell lookup, the flat Potent Vs term and the proc
//! line). Those cases are a LOCAL INVARIANT - not an oracle check - pinning the branch's literal captions and the JS
//! `fmt`/`table` arithmetic.
//!
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

#[path = "../src/enchant.rs"]
mod enchant;

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use dfo_core::analyze::{analyze, boss_target, gate_target, reference_foe};
use dfo_core::enchants::strike_enchantments;
use dfo_core::maxprofile::Profiles as MaxProfiles;
use dfo_core::spells::Spellbook;
use dfo_core::theory::theory_character;
use dfo_core::value::Value::{self, Arr, Bool, Null, Num, Obj, Str};
use serde_json::{Map, Value as JsonValue};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

/// The JS `scenarioOf(...)` over the defaults, at a potency; the branch overrides only `target`/`health`/potency/pierce,
/// which start at these values already.
fn scenario(target: &Value, potency: f64) -> Value {
    obj([
        ("target", target.clone()),
        ("core", Str("overhaul".to_owned())),
        ("rri", Bool(true)),
        ("traits", Null),
        (
            "health",
            Num(if target.get("isBoss").truthy() {
                target.get("maxHealth").to_number()
            } else {
                0.0
            }),
        ),
        ("swing", Str("random".to_owned())),
        ("critDamage", Bool(true)),
        ("passiveOn", Bool(true)),
        ("stacks", Num(5.0)),
        ("rhythm", Bool(false)),
        ("unaware", Bool(false)),
        ("firstBlow", Bool(false)),
        ("healthShare", Num(1.0)),
        ("attackerHealthShare", Num(1.0)),
        ("backstabUptime", Num(0.0)),
        ("firmamentDamagePct", Num(0.0)),
        ("pair", Bool(false)),
        ("dual", Bool(false)),
        ("bowSpam", Bool(false)),
        ("potencyPct", Num(potency)),
        ("pierce", Num(0.0)),
    ])
}

/// The CLI's theory character at its defaults (`loadCharacter`, `src/cli.js:401-431`): the legal gear budget fills
/// `gearLB`/`gearCS`/`damagePct` when the flags are absent, so a bare `theoryCharacter({})` is not the same character.
fn theory_character_like_cli() -> Value {
    let book = Spellbook::default();
    let legal = MaxProfiles::new(&book)
        .legal_gear(&Num(123.0), &Value::Undefined)
        .expect("the legal gear budget");
    theory_character(&obj([
        ("level", Num(45.0)),
        ("race", Str("darkelf".to_owned())),
        ("blade", Num(123.0)),
        ("material", Num(9.0)),
        ("gearLB", Num(legal.get("lb").to_number())),
        ("gearCS", Num(legal.get("cs").to_number())),
        ("damagePct", Num(legal.get("dmg").to_number())),
        ("starStats", Obj(vec![])),
        ("starSkills", Obj(vec![])),
        ("starDamage", Num(0.0)),
    ]))
    .expect("the theory character builds")
}

/// The branch's `enchantTarget`: for the theory default (`--target` absent means `armoured`), a gate body.
fn enchant_target() -> Value {
    gate_target(&Num(45.0), &Obj(vec![]))
}

/// The branch's `opts` and `r` for one case, as `src/cli.js:1456-1460` builds them.
fn card(ch: &Value, target: &Value, potency: f64) -> (Value, Value) {
    let opts = obj([
        ("level", Num(45.0)),
        ("potencyPct", Num(potency)),
        ("pierce", Num(0.0)),
    ]);
    let book = Spellbook::default();
    let strike = strike_enchantments(ch.get("weapon"), ch, target, &opts, &book);
    let sc = scenario(target, potency);
    let analyzed = analyze(ch, &sc, &book).to_value();
    (strike, analyzed)
}

fn js(args: &[&str], root: &std::path::Path) -> Output {
    Command::new("node")
        .arg(repo_root().join("bin").join("dfo-dps.js"))
        .args(args)
        .current_dir(root)
        .env("DAGGER_USER_DATA", root)
        .output()
        .expect("the JS CLI runs (this repository's Node project)")
}

/// A fresh temp root with no `Saves` folder: `--theory` reads none, and nothing is written.
fn temp_root(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("dfo-cli-enchant-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("temp fixture root");
    root
}

fn same(args: &[&str], label: &str) {
    let root = temp_root(label);
    let want = js(args, &root);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    let ch = theory_character_like_cli();
    let target = enchant_target();
    let (strike, card) = card(&ch, &target, 0.0);
    let got = enchant::text(&ch, ch.get("weapon"), &strike, &card);
    assert_eq!(
        got,
        String::from_utf8_lossy(&want.stdout),
        "the enchant card differs for {args:?}"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn the_theory_card_matches_the_js() {
    same(&["enchant", "--theory"], "default");
}

#[test]
fn a_potency_and_target_change_only_the_numbers() {
    for (args, label, target, potency) in [
        (
            &["enchant", "--theory", "--target", "soft"][..],
            "soft",
            reference_foe(&Num(45.0), &Str("soft".to_owned())),
            0.0,
        ),
        (
            &["enchant", "--theory", "--target", "boss"][..],
            "boss",
            boss_target(&obj([
                ("level", Num(45.0)),
                ("armorValue", Num(0.0)),
                ("health", Num(5000.0)),
                ("traits", Arr(vec![])),
            ]))
            .expect("the boss target builds"),
            0.0,
        ),
        (
            &["enchant", "--theory", "--potency", "30"][..],
            "potency",
            enchant_target(),
            30.0,
        ),
    ] {
        let root = temp_root(label);
        let want = js(args, &root);
        assert_eq!(want.status.code(), Some(0), "js {args:?}");
        let ch = theory_character_like_cli();
        let (strike, card) = card(&ch, &target, potency);
        assert_eq!(
            enchant::text(&ch, ch.get("weapon"), &strike, &card),
            String::from_utf8_lossy(&want.stdout),
            "the enchant card differs for {args:?}"
        );
        fs::remove_dir_all(&root).expect("cleanup");
    }
}

fn to_json(v: &Value) -> JsonValue {
    match v {
        Value::Undefined | Value::Null => JsonValue::Null,
        Value::Bool(b) => JsonValue::Bool(*b),
        Value::Num(n) => {
            serde_json::Number::from_f64(*n).map_or(JsonValue::Null, JsonValue::Number)
        }
        Value::Str(s) => JsonValue::String(s.clone()),
        Value::Arr(items) => JsonValue::Array(items.iter().map(to_json).collect()),
        Value::Obj(entries) => {
            let mut out = Map::new();
            for (k, v) in entries {
                out.insert(k.clone(), to_json(v));
            }
            JsonValue::Object(out)
        }
    }
}

/// A JSON document's numbers as doubles, so `0` (parsed) and `0.0` (built) compare equal.
fn doubles(v: &JsonValue) -> JsonValue {
    match v {
        JsonValue::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            serde_json::Number::from_f64(f).map_or(JsonValue::Null, JsonValue::Number)
        }
        JsonValue::Array(items) => JsonValue::Array(items.iter().map(doubles).collect()),
        JsonValue::Object(map) => {
            JsonValue::Object(map.iter().map(|(k, v)| (k.clone(), doubles(v))).collect())
        }
        other => other.clone(),
    }
}

#[test]
fn the_json_document_matches_the_js() {
    let root = temp_root("json");
    let want = js(&["enchant", "--theory", "--json"], &root);
    assert_eq!(want.status.code(), Some(0), "js runs");
    let parsed: JsonValue =
        serde_json::from_slice(&want.stdout).expect("the JS --json document parses");
    let ch = theory_character_like_cli();
    let target = enchant_target();
    let (strike, card) = card(&ch, &target, 0.0);
    let got = doubles(&to_json(&enchant::document(
        ch.get("weapon"),
        &strike,
        &card,
    )));
    assert_eq!(got, doubles(&parsed), "the enchant --json document differs");
    fs::remove_dir_all(&root).expect("cleanup");
}

/// A synthetic weapon of the test's own (no save, no `SPELLS.STD`): rows a theory blade cannot carry.
fn synthetic_item() -> Value {
    obj([
        ("name", Str("Synthetic Katana".to_owned())),
        ("group", Str("Weapons".to_owned())),
        ("templateIndex", Num(123.0)),
        ("material", Num(9.0)),
        ("maxCondition", Num(100.0)),
        ("currentCondition", Num(100.0)),
        ("equipSlot", Num(19.0)),
        (
            "enchantments",
            Arr(vec![
                obj([("type", Num(2.0)), ("param", Num(25.0))]),
                obj([("type", Num(4.0)), ("param", Num(1.0))]),
                obj([("type", Num(10.0)), ("param", Str("29".to_owned()))]),
                obj([("type", Num(18.0))]),
            ]),
        ),
    ])
}

/// A strike payload of the test's own, so the proc line and the spell lookup run without the game's data.
fn synthetic_strike() -> Value {
    obj([
        ("procDamage", Num(12.0)),
        ("procDamageMin", Num(10.0)),
        ("procDamageMax", Num(14.0)),
        ("procDot", Num(5.0)),
        ("procDotMin", Num(4.0)),
        ("procDotMax", Num(6.0)),
        ("flat", Num(5.0)),
        (
            "procs",
            Arr(vec![
                obj([
                    ("name", Str("Fireball".to_owned())),
                    ("index", Num(25.0)),
                    ("damage", Num(12.0)),
                    ("min", Num(10.0)),
                    ("max", Num(14.0)),
                    ("dotTick", Num(1.0)),
                    ("dotRounds", Num(2.0)),
                ]),
                obj([
                    ("name", Str("Shock".to_owned())),
                    ("index", Num(33.0)),
                    ("damage", Num(0.0)),
                    ("min", Num(0.0)),
                    ("max", Num(0.0)),
                    ("dotTick", Num(0.0)),
                    ("dotRounds", Num(0.0)),
                ]),
            ]),
        ),
    ])
}

/// The branch's metric card reads; a synthetic card makes the allowance arms explicit.
fn synthetic_card(ttk: Value, allowance: bool) -> Value {
    obj([
        ("dps", Num(880.4234457405319)),
        ("enchantDps", Num(25.25)),
        ("ceilingTotalDps", Num(905.6734457405319)),
        ("totalTtk", ttk),
        ("ceilingTotalTtk", Num(21.224584158861077)),
        ("claimSustainedDps", Num(150.0)),
        ("procsBeforeBreak", Num(10.0)),
        ("target", obj([("allowance", Bool(allowance))])),
        ("allowance", if allowance { obj([]) } else { Null }),
    ])
}

/// LOCAL INVARIANT, not an oracle check: the branch's literal captions and the JS `fmt`/`table` arithmetic.
#[test]
fn the_rows_and_proc_line_are_the_branchs_text() {
    let item = synthetic_item();
    let strike = synthetic_strike();
    let card = synthetic_card(Num(76.0), true);
    let ch = obj([
        ("name", Str("Fixture".to_owned())),
        ("raceId", Num(4.0)),
        ("career", obj([("name", Str("Longblade".to_owned()))])),
        ("level", Num(45.0)),
    ]);
    let text = enchant::text(&ch, &item, &strike, &card);
    let expected = "\
Fixture - Dark Elf Longblade, level 45  |  Synthetic Katana
Enchantment      Param  Spell
-----------      -----  -----
CastWhenStrikes     25  Fireball
PotentVs             1  -
EnhancesSkill       29  -
VisionProblems       -  -
Metric                                 Value
------                                 -----
Uncapped weapon DPS                    880.4
Enchant per landed hit                 17.0 + 1.0 DoT DPS
Enchant DPS (ceiling component)        25.3
Total (per-hit-capped ceiling)         905.7
Allowance-sustained DPS                150.0
Time to kill (allowance-sustained)     76.0 s
Time to kill (per-hit-capped ceiling)  21.2 s
CWS bills covered (bill-only)          10
Procs                                  Fireball DoT 1.0/round, Shock 0.0
";
    assert_eq!(text, expected);
}

/// LOCAL INVARIANT: the allowance time-to-kill arms the branch distinguishes.
#[test]
fn the_allowance_arms_are_pinned() {
    let item = synthetic_item();
    let strike = synthetic_strike();
    let ch = obj([("name", Str("Fixture".to_owned())), ("level", Num(45.0))]);

    let no_kill = enchant::text(&ch, &item, &strike, &synthetic_card(Null, true));
    assert!(
        no_kill.contains("Time to kill (allowance-sustained)     no kill"),
        "{no_kill}"
    );

    let bare = enchant::text(&ch, &item, &strike, &synthetic_card(Num(76.0), false));
    assert!(
        !bare.contains("Allowance-sustained DPS"),
        "the allowance block must be absent without an allowance target"
    );
    assert!(
        !bare.contains("Time to kill (allowance-sustained)"),
        "only the target's allowance flag opens the block"
    );
}

/// LOCAL INVARIANT: a missing `param` and the `?? e.type` fallback both read as the JS does.
#[test]
fn an_unknown_type_falls_back_to_its_number() {
    let item = obj([("enchantments", Arr(vec![obj([("type", Num(99.0))])]))]);
    let strike = obj([("procs", Arr(vec![]))]);
    let card = synthetic_card(Num(1.0), false);
    let text = enchant::text(
        &obj([("name", Str("X".to_owned())), ("level", Num(1.0))]),
        &item,
        &strike,
        &card,
    );
    let row = text
        .lines()
        .find(|l| l.starts_with("99"))
        .unwrap_or_default();
    assert_eq!(row, format!("99{}-  -", " ".repeat(15)));
}
