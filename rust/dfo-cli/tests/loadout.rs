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

#[path = "../src/graph.rs"]
#[allow(dead_code)]
mod graph;
#[path = "../src/loadout.rs"]
#[allow(dead_code)]
mod loadout;

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

use dfo_core::loadout_shortlist::{shortlist_loadouts, ShortlistOpts};
use dfo_core::spells::Spellbook;
use dfo_core::value::Value::{self, Arr, Bool, Num, Obj, Str, Undefined};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn temp_root(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "dfo-cli-loadout-{label}-{}-{n}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("Saves")).expect("temp fixture root");
    root
}

fn js(args: &[&str], root: &Path) -> Output {
    Command::new("node")
        .env("LC_ALL", "en_US.UTF-8")
        .env("LANG", "en_US.UTF-8")
        .env("DAGGER_USER_DATA", root)
        .arg(repo_root().join("bin").join("dfo-dps.js"))
        .arg("loadout")
        .args(args)
        .current_dir(repo_root())
        .output()
        .expect("the JS CLI runs (this repository's Node project)")
}

/// One case: the CLI flags, and the modes/encounters the branch resolves from them (`src/cli.js:962-963`).
struct Case {
    args: &'static [&'static str],
    modes: &'static [&'static str],
    encounters: &'static [&'static str],
}

fn cases() -> Vec<Case> {
    vec![
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
    for key in ["trials", "seed", "maxSeconds", "maxBlows"] {
        out.set(key, values.get(key).clone());
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

#[test]
fn shortlist_text_matches_the_js() {
    let book = Spellbook::default();
    for case in cases() {
        let root = temp_root("text");
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
        let got = loadout::shortlist_text(&rankings(&case, &values, &book), trials, max_seconds);
        diff(
            &format!("text {:?}", case.args),
            &got,
            &String::from_utf8_lossy(&want.stdout),
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[test]
fn json_document_matches_the_js() {
    let book = Spellbook::default();
    for case in cases() {
        let root = temp_root("json");
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
        let got = loadout::shortlist_document(&rankings(&case, &values, &book), false);
        diff(
            &format!("json {:?}", case.args),
            &dfo_core::value::write(&got),
            &dfo_core::value::write(&from_json(&js_doc)),
        );
        let _ = std::fs::remove_dir_all(&root);
    }
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
