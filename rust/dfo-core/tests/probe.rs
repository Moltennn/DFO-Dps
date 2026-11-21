//! `dfo_core::probe` against the REAL `src/probe.js`, over synthetic fixtures.
//!
//! `tests/probe_oracle.mjs` builds capture-shaped documents (never a real capture), calls the JS module and prints one
//! line per case; each line is replayed here through the port and compared token for token. A skipped differential proves
//! nothing, so a missing `node` fails the test.

use dfo_core::{
    probe,
    value::{self, Value},
};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn oracle_lines() -> Vec<String> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("probe_oracle.mjs");
    let out = Command::new("node")
        .arg(&script)
        .current_dir(repo_root())
        .output()
        .expect("the probe oracle script runs (this repository's Node project)");
    assert_eq!(
        out.status.code(),
        Some(0),
        "oracle {script:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .expect("the oracle's output is UTF-8")
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

fn parse(token: &str) -> Value {
    value::parse(token).expect("an oracle token is a canonical value")
}

/// A readable first difference, since comparing every field by text hides which one moved.
fn difference(expected: &Value, got: &Value, path: &str) -> Option<String> {
    match (expected, got) {
        (Value::Obj(e), Value::Obj(g)) => {
            for ((ek, ev), (gk, gv)) in e.iter().zip(g) {
                if ek != gk {
                    return Some(format!("{path}: expected key {ek:?}, got {gk:?}"));
                }
                if let Some(d) = difference(ev, gv, &format!("{path}.{ek}")) {
                    return Some(d);
                }
            }
            (e.len() != g.len()).then(|| {
                format!(
                    "{path}: keys expected {:?}, got {:?}",
                    e.iter().map(|x| &x.0).collect::<Vec<_>>(),
                    g.iter().map(|x| &x.0).collect::<Vec<_>>()
                )
            })
        }
        (Value::Arr(e), Value::Arr(g)) => {
            if e.len() != g.len() {
                return Some(format!(
                    "{path}: expected length {}, got {}",
                    e.len(),
                    g.len()
                ));
            }
            e.iter()
                .zip(g)
                .enumerate()
                .find_map(|(i, (e, g))| difference(e, g, &format!("{path}[{i}]")))
        }
        (Value::Num(e), Value::Num(g)) if e.is_nan() && g.is_nan() => None,
        _ if expected == got => None,
        _ => Some(format!("{path}: expected {expected:?}, got {got:?}")),
    }
}

fn check(kind: &str, line: &str, expected: &Value, got: &Value) {
    let exp = value::write(expected);
    let act = value::write(got);
    if exp != act {
        let detail =
            difference(expected, got, kind).unwrap_or_else(|| "noncanonical fixture".to_owned());
        panic!("{line}\n  {detail}");
    }
}

#[test]
fn differential() {
    let lines = oracle_lines();
    assert!(
        lines.len() >= 250,
        "the oracle printed too few cases: {}",
        lines.len()
    );
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for line in &lines {
        let mut toks = line.split(' ');
        let kind = toks.next().expect("a kind");
        let input = parse(toks.next().expect("an input token"));
        let opts = parse(toks.next().expect("an opts token"));
        assert_eq!(toks.next(), Some("=>"), "{line}");
        let expected = toks.next().map(parse).expect("an expected token");
        assert_eq!(toks.next(), None, "{line} (trailing tokens)");
        *seen.entry(kind.to_owned()).or_insert(0) += 1;
        match kind {
            "summary" => {
                let got =
                    probe::summarize_probe(&input, &opts).unwrap_or_else(|e| panic!("{line}: {e}"));
                check(kind, line, &expected, &got);
            }
            "fight" => {
                check(
                    kind,
                    line,
                    &expected,
                    &probe::fight_summary(input.items(), &opts),
                );
            }
            "split" => {
                let [gap, min] = opts.items() else {
                    panic!("{line}: split opts are [gap, min]")
                };
                let got = probe::split_fights(input.items(), gap.to_number(), min.to_number());
                let got = Value::Arr(got.into_iter().map(Value::Arr).collect());
                check(kind, line, &expected, &got);
            }
            "charttop" => check(kind, line, &expected, &probe::chart_top(&input)),
            "charttotals" => check(kind, line, &expected, &probe::chart_totals(&input)),
            "constants" => check(kind, line, &expected, &probe::probe_constants(&input)),
            "content" => {
                let [name, sub] = input.items() else {
                    panic!("{line}: content input is [name, sub]")
                };
                let got =
                    probe::boss_content(name, sub).map_or(Value::Null, |c| Value::Str(c.into()));
                check(kind, line, &expected, &got);
            }
            "outcome" => {
                check(
                    kind,
                    line,
                    &expected,
                    &Value::Str(
                        probe::gate_outcome(input.get("gate"), input.get("samples").items()).into(),
                    ),
                );
            }
            "refusal" => {
                let err =
                    probe::summarize_probe(&input, &opts).expect_err("must refuse a non-capture");
                assert_eq!(
                    err,
                    expected
                        .as_str()
                        .unwrap_or_else(|| panic!("{line}: refusal text")),
                    "{line}"
                );
            }
            other => panic!("{line}: unknown oracle kind `{other}`"),
        }
    }
    for (kind, floor) in [
        ("summary", 30),
        ("fight", 5),
        ("split", 6),
        ("charttop", 8),
        ("charttotals", 4),
        ("constants", 10),
        ("content", 20),
        ("outcome", 20),
        ("refusal", 3),
    ] {
        assert!(
            seen.get(kind).copied().unwrap_or(0) >= floor,
            "the oracle covered too few `{kind}` cases: {:?}",
            seen.get(kind).copied().unwrap_or(0)
        );
    }
}

#[test]
fn a_fractional_player_count_is_truncated_not_refused() {
    // LOCAL ASSUMPTION (src/probe.js:65): the JS `Array(count - known.length)` is a RangeError for a non-integer count,
    // and `tests/probe_oracle.mjs` pins that the JS throws. The port answers the same document instead of panicking.
    let sample = |t: f64, hp: f64| {
        Value::Obj(vec![
            ("t".into(), Value::Num(t)),
            (
                "boss".into(),
                Value::Obj(vec![("hp".into(), Value::Num(hp))]),
            ),
        ])
    };
    let samples = Value::Arr(vec![
        sample(0.0, 100.0),
        sample(1000.0, 90.0),
        sample(2000.0, 80.0),
    ]);
    let mut data = Value::Obj(vec![
        ("version".into(), Value::Num(1.0)),
        ("players".into(), Value::Num(2.0)),
        ("levels".into(), Value::Arr(vec![])),
        ("samples".into(), samples.clone()),
    ]);
    let out = probe::summarize_probe(&data, &Value::Undefined).expect("the port answers");
    assert_eq!(out.get("fights").items().len(), 1);
    let fight = &out.get("fights").items()[0];
    assert_eq!(fight.get("players"), &Value::Num(2.0));

    // A fractional count: the JS throws (pinned in `tests/probe_oracle.mjs`); the port truncates the player fill, so the
    // fight's own count is the integer one. The capture's top-level `players` still echoes the document (as the JS does).
    data.set("players", Value::Num(2.5));
    let frac = probe::summarize_probe(&data, &Value::Undefined).expect("the port answers");
    assert_eq!(frac.get("players"), &Value::Num(2.5));
    assert_eq!(
        frac.get("fights").items()[0].get("players"),
        &Value::Num(2.0)
    );
}

#[test]
fn boss_content_is_the_source_regex_order() {
    // ORACLE (`src/probe.js:17-23`): the first matching family wins, and the sky-ketch name outranks the rest.
    let content = |name: &str, sub: &str| {
        probe::boss_content(&Value::Str(name.into()), &Value::Str(sub.into()))
            .unwrap_or("unknown")
            .to_owned()
    };
    assert_eq!(content("Sky-ketch Warden", ""), "skyketch");
    assert_eq!(content("", "tonal steersman"), "skyketch");
    assert_eq!(content("Abyss Remnant", ""), "abyss");
    assert_eq!(content("Brass Clock", ""), "abyss");
    assert_eq!(content("Valkynaz Ruhn", "level 45"), "breach");
    assert_eq!(content("The Warden", ""), "breach");
    assert_eq!(content("plain foe", ""), "unknown");
}

#[test]
fn a_capture_that_is_not_version_one_is_refused() {
    // ORACLE (`src/probe.js:195`): the message is the JS `Error`'s.
    let err = probe::summarize_probe(&Value::Num(1.0), &Value::Undefined).unwrap_err();
    assert_eq!(err, "not a Combat Probe capture (version 1)");
    let err = probe::summarize_probe(&Value::Null, &Value::Undefined).unwrap_err();
    assert_eq!(err, "not a Combat Probe capture (version 1)");
}
