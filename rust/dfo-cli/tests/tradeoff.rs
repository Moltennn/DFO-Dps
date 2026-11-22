//! The R8 `tradeoff` card and `--json` document, differentially against the REAL JS CLI.
//!
//! The branch (`src/cli.js:2204-2252`) is not exported, so every case runs `bin/dfo-dps.js tradeoff --theory` (no save
//! is read or written) and compares the output with [`tradeoff::text`] and [`tradeoff::document`]. The pools, the two
//! top-weapon cards and the crossover are the shared core's own (`dfo_core::analyze`, `gate_target`, `boss_target`,
//! `rank_weapons`), so this pins the presentation: the JS `fmt`/`fmt2`, the `toLocaleString` grouping, the verdict
//! text, the table widths and the `--json` record's keys and numbers. Numbers move only if the core moves, which its own
//! vectors pin.
//!
//! The text card is compared byte for byte. The `--json` document is compared as parsed JSON, member by member: the
//! command's encoder (`JSON.stringify(v, null, 2)`) only adds whitespace, and it is `main.rs`'s, not this port's.
//!
//! The character and base scenario are rebuilt exactly as `loadCharacter`/`scenarioOf` build them for `--theory`
//! (`src/cli.js:401-431`, `:531-560`); that code is not exportable either, so it is mirrored here, as `tests/enchant.rs`
//! mirrors its branch. `--players`, `--blow-x`, `--level` and `--core` reach the pools through the gate target, the
//! character level and the scenario core, so the second case carries them.
//!
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

#[path = "../src/tradeoff.rs"]
mod tradeoff;

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

use dfo_core::analyze::gate_target;
use dfo_core::maxprofile::Profiles as MaxProfiles;
use dfo_core::spells::Spellbook;
use dfo_core::theory::theory_character;
use dfo_core::value::Value::{self, Bool, Null, Num, Obj, Str};
use serde_json::Value as JsonValue;

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

/// One case: the flags the JS CLI receives, plus the resolved inputs the branch reads.
struct Case {
    args: &'static [&'static str],
    label: &'static str,
    level: f64,
    players: f64,
    blow_x: f64,
    core: &'static str,
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            args: &["tradeoff", "--theory"],
            label: "the theory defaults",
            level: 45.0,
            players: 1.0,
            blow_x: 1.0,
            core: "overhaul",
        },
        // The gate pool and every boss pool carry the level; the gate carries the players and the blow multiplier.
        Case {
            args: &[
                "tradeoff",
                "--theory",
                "--level",
                "30",
                "--players",
                "3",
                "--blow-x",
                "2",
                "--core",
                "classic",
            ],
            label: "level 30, three players, double blow, classic core",
            level: 30.0,
            players: 3.0,
            blow_x: 2.0,
            core: "classic",
        },
    ]
}

/// `loadCharacter` for `--theory`: the legal gear budget fills `gearLB`/`gearCS`/`damagePct` when the flags are absent.
fn theory_character_like_cli(level: f64, book: &Spellbook) -> Value {
    let legal = MaxProfiles::new(book)
        .legal_gear(&Num(123.0), &Value::Undefined)
        .expect("the legal gear budget");
    theory_character(&obj([
        ("level", Num(level)),
        ("race", Str("darkelf".to_owned())),
        ("blade", Num(123.0)),
        ("material", Num(9.0)),
        ("gearLB", Num(legal.get("lb").to_number())),
        ("gearCS", Num(legal.get("cs").to_number())),
        ("damagePct", Num(legal.get("dmg").to_number())),
        ("vampire", Bool(false)),
        ("starStats", Obj(vec![])),
        ("starSkills", Obj(vec![])),
        ("starDamage", Num(0.0)),
    ]))
    .expect("the theory character builds")
}

/// `scenarioOf(ch, values, traits, target)` for `--theory`: the base tradeoff replaces only `target`, `health` and
/// `traits` per pool (`src/cli.js:2218`), so every other field must match the JS object.
fn base_scenario(level: f64, players: f64, blow_x: f64, core: &str) -> Value {
    let target = gate_target(
        &Num(level),
        &obj([("players", Num(players)), ("blowX", Num(blow_x))]),
    );
    let health = target.get("maxHealth").to_number();
    obj([
        ("target", target),
        ("core", Str(core.to_owned())),
        ("rri", Bool(true)),
        ("traits", Null),
        ("health", Num(health)),
        // `swing: values.swing` is absent at the default, which `analyze` reads as `random`.
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
        ("potencyPct", Num(0.0)),
        ("pierce", Num(0.0)),
    ])
}

/// A fresh temp root per call, so the two cases never share one: `--theory` reads no save and writes nothing.
fn temp_root() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("dfo-cli-tradeoff-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("temp fixture root");
    root
}

fn js(args: &[&str], root: &std::path::Path) -> Output {
    Command::new("node")
        .arg(repo_root().join("bin").join("dfo-dps.js"))
        .args(args)
        .current_dir(repo_root())
        .env("DAGGER_USER_DATA", root)
        .output()
        .expect("the JS CLI runs (this repository's Node project)")
}

/// Run one case's JS side and return its stdout, asserting it succeeded.
fn want(case: &Case, json: bool) -> Vec<u8> {
    let root = temp_root();
    let args: Vec<&str> = case
        .args
        .iter()
        .copied()
        .chain(json.then_some("--json"))
        .collect();
    let out = js(&args, &root);
    assert_eq!(
        out.status.code(),
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    fs::remove_dir_all(&root).expect("cleanup");
    out.stdout
}

/// A JSON document as the core's `Value`, so both sides compare through the same canonical token (a number is its bits,
/// so `12000` from the JS and `12000.0` from the core are the same double).
fn from_json(v: JsonValue) -> Value {
    match v {
        JsonValue::Null => Null,
        JsonValue::Bool(b) => Bool(b),
        JsonValue::Number(n) => Num(n.as_f64().expect("a JSON number is a double")),
        JsonValue::String(s) => Str(s),
        JsonValue::Array(items) => Value::Arr(items.into_iter().map(from_json).collect()),
        JsonValue::Object(entries) => {
            let mut out = Obj(vec![]);
            for (k, v) in entries {
                out.set(&k, from_json(v));
            }
            out
        }
    }
}

#[test]
fn renders_the_text_card_like_the_js() {
    let book = Spellbook::default();
    for case in cases() {
        let want = want(&case, false);
        let ch = theory_character_like_cli(case.level, &book);
        let base = base_scenario(case.level, case.players, case.blow_x, case.core);
        let got =
            tradeoff::text(&ch, &base, case.core, case.players, case.blow_x, &book).into_bytes();
        if got != want {
            let at = got
                .iter()
                .zip(&want)
                .position(|(a, b)| a != b)
                .unwrap_or_else(|| got.len().min(want.len()));
            let from = at.saturating_sub(120);
            panic!(
                "{} differs at byte {at} (lens {} vs {}):\nrust: {:?}\njs:   {:?}",
                case.label,
                got.len(),
                want.len(),
                String::from_utf8_lossy(&got[from..(at + 200).min(got.len())]),
                String::from_utf8_lossy(&want[from..(at + 200).min(want.len())]),
            );
        }
    }
}

#[test]
fn renders_the_json_document_like_the_js() {
    let book = Spellbook::default();
    for case in cases() {
        let want: JsonValue =
            serde_json::from_slice(&want(&case, true)).expect("the JS prints JSON");
        let ch = theory_character_like_cli(case.level, &book);
        let base = base_scenario(case.level, case.players, case.blow_x, case.core);
        let got = tradeoff::document(&ch, &base, case.players, case.blow_x, &book);
        assert_eq!(
            dfo_core::value::write(&got),
            dfo_core::value::write(&from_json(want)),
            "{}: the --json document differs",
            case.label
        );
    }
}
