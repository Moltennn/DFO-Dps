//! The R8 `loadout` / `real-dps` `--shortlist` card and `--json` document, differentially against the real JS CLI.
//!
//! Each case runs `bin/dfo-dps.js loadout --shortlist ...` and feeds the same options to
//! [`dfo_core::loadout_shortlist::shortlist_loadouts`], then compares [`loadout::shortlist_text`] byte for byte with the
//! JS stdout and [`loadout::shortlist_document`] token for token with the JS `--json` document (same keys, same order,
//! same numbers). The rankings themselves are the core's (pinned by `dfo_core/tests/real_build.rs`); this file pins the
//! CLI presentation around them: the two header lines, the damage note, the column set and the `detail` pruning.
//!
//! No save and no `SPELLS.STD` are read: the JS `standardSpells()` default is an empty book when the temp
//! `DAGGER_USER_DATA` root has no launcher `config.json`, and the Rust side uses `Spellbook::default()`. A missing
//! `node` panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::temp_root;

#[path = "../src/graph.rs"]
#[allow(dead_code)]
mod graph;
#[path = "../src/loadout.rs"]
#[allow(dead_code)]
mod loadout;

use std::path::Path;
use std::process::Output;

use dfo_core::loadout_shortlist::{shortlist_loadouts, ShortlistOpts};
use dfo_core::spells::Spellbook;
use dfo_core::value::Value::{self, Arr, Bool, Num, Obj, Str, Undefined};

fn js(args: &[&str], root: &Path) -> Output {
    let mut argv = vec!["loadout"];
    argv.extend_from_slice(args);
    common::js(&argv, root)
}

/// One case: the CLI flags, and the modes/encounters the branch resolves from them (`src/cli.js:962-963`).
#[derive(Clone, Copy)]
struct Case {
    args: &'static [&'static str],
    modes: &'static [&'static str],
    encounters: &'static [&'static str],
}

fn cases() -> [Case; 4] {
    [
        // The default: both modes, one Breach ranking each.
        Case {
            args: &["--shortlist", "1", "--max-blows", "20"],
            modes: &["uncapped", "cap"],
            encounters: &["breach"],
        },
        // `--uncapped` with the other allowed objective.
        Case {
            args: &[
                "--shortlist",
                "1",
                "--uncapped",
                "--objective",
                "kill-probability",
                "--max-blows",
                "20",
            ],
            modes: &["uncapped"],
            encounters: &["breach"],
        },
        // `--cap-aware` prices the requested encounter, and its pool is the encounter's.
        Case {
            args: &[
                "--shortlist",
                "2",
                "--cap-aware",
                "--encounter",
                "skyketch",
                "--max-blows",
                "60",
            ],
            modes: &["cap"],
            encounters: &["skyketch"],
        },
        // A non-default seed and horizon reach both the sampled rows and the header.
        Case {
            args: &[
                "--shortlist",
                "1",
                "--uncapped",
                "--seed",
                "7",
                "--max-seconds",
                "120",
                "--max-blows",
                "20",
            ],
            modes: &["uncapped"],
            encounters: &["breach"],
        },
    ]
}
/// The branch's own `opts` (`src/cli.js:642`): `sampledOptions(values)` plus `k`, `objective`, `vampire`, `health`.
fn opts(values: &Value) -> Value {
    let mut out = Obj(vec![]);
    // The CLI resolves these flags numerically before it builds the options (`sampledOptions`), so a test that stands in
    // for the CLI must pass NUMBERS, not the raw flag strings: `ShortlistOpts::from_value` keeps the JS
    // `Number.isSafeInteger(trials)` guard, which a string would fail (a string IS a usage error on the JS side too).
    for key in ["trials", "seed", "maxSeconds", "maxBlows"] {
        let raw = values.get(key);
        let n = match raw {
            Str(s) => s.parse::<f64>().expect("a numeric flag"),
            other => other.to_number(),
        };
        out.set(key, Num(n));
    }
    out.set("k", Num(values.get("shortlist").to_number()));
    out.set("objective", values.get("objective").clone());
    out.set("vampire", Bool(false));
    out.set("health", values.get("health").clone());
    out
}

/// The four numbers the header prints: `opts.trials` and `opts.maxSeconds` as the CLI resolved them.
fn sampled(values: &Value) -> (f64, f64) {
    let trials = match values.get("trials") {
        Str(s) => s.parse::<f64>().expect("a numeric --trials"),
        other => other.to_number(),
    };
    let max_seconds = match values.get("maxSeconds") {
        Str(s) => s.parse::<f64>().expect("a numeric --max-seconds"),
        other => other.to_number(),
    };
    (trials, max_seconds)
}

/// The flags' values as the CLI would hold them (`sampledOptions`' own coercions).
fn cli_values(args: &[&str]) -> Value {
    let get = |name: &str| {
        args.iter()
            .position(|a| *a == name)
            .map(|i| args[i + 1].to_owned())
    };
    let mut out = Obj(vec![]);
    out.set(
        "shortlist",
        get("--shortlist").map_or_else(|| Str("0".to_owned()), Str),
    );
    out.set(
        "trials",
        get("--trials").map_or_else(|| Str("1000".to_owned()), Str),
    );
    out.set(
        "seed",
        get("--seed").map_or_else(|| Str("0".to_owned()), Str),
    );
    out.set(
        "maxSeconds",
        get("--max-seconds").map_or_else(|| Str("900".to_owned()), Str),
    );
    out.set(
        "maxBlows",
        get("--max-blows").map_or_else(|| Str("6000".to_owned()), Str),
    );
    out.set("objective", get("--objective").map_or(Undefined, Str));
    out
}

/// The ranking list in the JS order: `modes.flatMap((mode) => (mode === 'cap' ? encounters : [undefined])...)`.
fn rankings(case: &Case, values: &Value, book: &Spellbook) -> Vec<Value> {
    let base = opts(values);
    let mut out = Vec::new();
    for mode in case.modes {
        let encounters: Vec<Option<&str>> = if *mode == "cap" {
            case.encounters.iter().copied().map(Some).collect()
        } else {
            vec![None]
        };
        for encounter in encounters {
            let mut o = Obj(base.entries().to_vec());
            o.set("mode", Str((*mode).to_owned()));
            o.set(
                "encounter",
                encounter.map_or(Undefined, |e| Str(e.to_owned())),
            );
            let ranking = shortlist_loadouts(&ShortlistOpts::from_value(&o), book)
                .expect("the core shortlists a theory domain");
            out.push(ranking);
        }
    }
    out
}

/// `serde_json::Value` to the port's `Value`, the shape `tests/tradeoff.rs` uses for a JS document.
fn from_json(v: &serde_json::Value) -> Value {
    match v {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Bool(*b),
        serde_json::Value::Number(n) => Num(n.as_f64().expect("a number")),
        serde_json::Value::String(s) => Str(s.clone()),
        serde_json::Value::Array(xs) => Arr(xs.iter().map(from_json).collect()),
        serde_json::Value::Object(map) => {
            let mut out = Obj(vec![]);
            for (k, v) in map {
                out.set(k, from_json(v));
            }
            out
        }
    }
}

fn diff(label: &str, got: &str, want: &str) {
    if got == want {
        return;
    }
    let at = got
        .as_bytes()
        .iter()
        .zip(want.as_bytes())
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| got.len().min(want.len()));
    let from = at.saturating_sub(120);
    panic!(
        "{label} differs at byte {at} (lens {} vs {}):\nrust: {:?}\njs:   {:?}",
        got.len(),
        want.len(),
        &got[from..(at + 200).min(got.len())],
        &want[from..(at + 200).min(want.len())],
    );
}

/// One case in its own temp root: every sampled row costs ~20 s, so each case is a `#[test]` and libtest runs them
/// side by side (the gate's thread budget bounds the total).
fn run_case(label: &str, case: Case) {
    let root = temp_root(label);
    let values = cli_values(case.args);
    let (trials, max_seconds) = sampled(&values);
    let want = js(case.args, &root);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {:?}: {}",
        case.args,
        String::from_utf8_lossy(&want.stderr)
    );
    let book = Spellbook::default();
    let got = loadout::shortlist_text(&rankings(&case, &values, &book), trials, max_seconds);
    diff(
        &format!("text {:?}", case.args),
        &got,
        &String::from_utf8_lossy(&want.stdout),
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// One `--json` case in its own temp root.
fn run_json_case(label: &str, case: Case) {
    let root = temp_root(label);
    let values = cli_values(case.args);
    let mut args = case.args.to_vec();
    args.push("--json");
    let want = js(&args, &root);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    let js_doc: serde_json::Value =
        serde_json::from_slice(&want.stdout).expect("the JS prints JSON");
    let book = Spellbook::default();
    let got = loadout::shortlist_document(&rankings(&case, &values, &book), false);
    diff(
        &format!("json {:?}", case.args),
        &dfo_core::value::write(&got),
        &dfo_core::value::write(&from_json(&js_doc)),
    );
    let _ = std::fs::remove_dir_all(&root);
}

// The default: both modes, one Breach ranking each.
#[test]
fn shortlist_text_default_matches_the_js() {
    run_case("text", cases()[0]);
}

// `--uncapped` with the other allowed objective.
#[test]
fn shortlist_text_kill_probability_matches_the_js() {
    run_case("text-probability", cases()[1]);
}

// `--cap-aware` prices the requested encounter, and its pool is the encounter's.
#[test]
fn shortlist_text_cap_aware_skyketch_matches_the_js() {
    run_case("text-skyketch", cases()[2]);
}

// A non-default seed and horizon reach both the sampled rows and the header.
#[test]
fn shortlist_text_seed_and_horizon_match_the_js() {
    run_case("text-seed", cases()[3]);
}

#[test]
fn shortlist_json_default_matches_the_js() {
    run_json_case("json", cases()[0]);
}

#[test]
fn shortlist_json_kill_probability_matches_the_js() {
    run_json_case("json-probability", cases()[1]);
}

#[test]
fn shortlist_json_cap_aware_skyketch_matches_the_js() {
    run_json_case("json-skyketch", cases()[2]);
}

#[test]
fn shortlist_json_seed_and_horizon_match_the_js() {
    run_json_case("json-seed", cases()[3]);
}

#[test]
fn json_keeps_detail_only_with_samples() {
    let root = temp_root("samples");
    let values = cli_values(&["--shortlist", "1", "--uncapped", "--max-blows", "20"]);
    let book = Spellbook::default();
    let case = Case {
        args: &["--shortlist", "1", "--uncapped", "--max-blows", "20"],
        modes: &["uncapped"],
        encounters: &["breach"],
    };
    let ranked = rankings(&case, &values, &book);
    let kept = loadout::shortlist_document(&ranked, true);
    let stripped = loadout::shortlist_document(&ranked, false);
    let kept_row = kept.at(0).get("rows").at(0);
    let stripped_row = stripped.at(0).get("rows").at(0);
    assert!(
        !kept_row.get("detail").is_nullish(),
        "the sampled ranking carries a detail record"
    );
    assert!(
        stripped_row.get("detail").is_nullish(),
        "--samples off prunes every row's detail"
    );
    let _ = std::fs::remove_dir_all(&root);
}
