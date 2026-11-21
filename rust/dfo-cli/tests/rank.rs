//! The R8 `rank --theory` slice, differentially against the real JS CLI.
//!
//! Every case runs `bin/dfo-dps.js rank ...` and the Rust binary with the same arguments and compares stdout byte for
//! byte (the text card and `--json`), then the usage errors compare stderr and the exit code. The JS is the oracle:
//! a port that drifts from `src/cli.js`, `src/model.js` or `src/theory.js` fails here.
//!
//! The repo is a Node project and this test spawns `node`; if it cannot, the test panics rather than skips (a skipped
//! differential proves nothing). No save is read: every case passes `--theory`.

use std::path::PathBuf;
use std::process::{Command, Output};

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

#[test]
fn rank_theory_text_matches_the_js_cli() {
    same(&["rank", "--theory"]);
    same(&["rank", "weapons", "--theory"]);
    same(&["rank", "--theory", "--top", "1000"]);
    same(&["rank", "--theory", "--target", "gate", "--top", "1000"]);
}

#[test]
fn rank_theory_json_matches_the_js_cli() {
    same(&["rank", "--theory", "--json"]);
    same(&["rank", "weapons", "--theory", "--json"]);
    same(&["rank", "--theory", "--top", "5", "--json"]);
    same(&["rank", "--theory", "--top", "1"]);
    same(&["rank", "--theory", "--top", "100", "--json"]);
    same(&["rank", "--theory", "--top", "1000", "--json"]);
    same(&["rank", "--theory", "--top", "1e20", "--json"]);
    same(&["rank", "--theory", "--top=7", "--json"]);
}

#[test]
fn rank_targets_and_remap_match() {
    // `armoured` is analysed as the gate for the theory character; the header keeps the typed name.
    same(&["rank", "--theory", "--target", "armoured"]);
    same(&["rank", "--theory", "--target", "gate", "--json"]);
    same(&["rank", "--theory", "--target", "breach"]);
    same(&["rank", "--theory", "--target", "ruhn"]);
    same(&["rank", "--theory", "--target", "soft", "--json"]);
    same(&["rank", "--theory", "--target", "tough"]);
    same(&["rank", "--theory", "--target", "human"]);
    same(&["rank", "--theory", "--target", "skyketch", "--json"]);
    same(&["rank", "--theory", "--target", "abyss"]);
    same(&[
        "rank", "--theory", "--target", "boss", "--health", "1200", "--armor", "30", "--json",
    ]);
    same(&[
        "rank",
        "--theory",
        "--target",
        "boss",
        "--traits",
        "curbing,wrathful",
    ]);
    same(&[
        "rank",
        "--theory",
        "--target",
        "gate",
        "--players",
        "3",
        "--blow-x",
        "2",
        "--json",
    ]);
    same(&["rank", "--theory", "--target", "gate", "--health", "1000"]);
}

#[test]
fn rank_theory_flags_match() {
    same(&["rank", "--theory", "--race", "redguard", "--json"]);
    same(&["rank", "--theory", "--race", "nord", "--blade", "121"]);
    same(&["rank", "--theory", "--blade", "118", "--json"]);
    same(&[
        "rank",
        "--theory",
        "--gear-lb",
        "250",
        "--gear-cs",
        "370",
        "--json",
    ]);
    same(&["rank", "--theory", "--damage-pct", "15", "--vampire"]);
    same(&[
        "rank", "--theory", "--swing", "StrikeUp", "--stacks", "3", "--rhythm",
    ]);
    same(&["rank", "--theory", "--behind", "--json"]);
    same(&["rank", "--theory", "--backstab", "0.4"]);
    same(&[
        "rank",
        "--theory",
        "--health-share",
        "0.5",
        "--self-health-share",
        "0.4",
        "--json",
    ]);
    same(&["rank", "--theory", "--unaware", "--first-blow"]);
    same(&["rank", "--theory", "--core", "classic", "--json"]);
    same(&[
        "rank",
        "--theory",
        "--no-crit-damage",
        "--no-passive",
        "--no-rri",
    ]);
    same(&["rank", "--theory", "--firmament", "--json"]);
    same(&[
        "rank",
        "--theory",
        "--star-stat",
        "strength=10,agility=5",
        "--star-skill",
        "29=15",
        "--json",
    ]);
    same(&[
        "rank",
        "--theory",
        "--star-damage",
        "12",
        "--potency",
        "8",
        "--pierce",
        "4",
    ]);
    same(&["rank", "--theory", "--weapon", "121:3", "--json"]);
    same(&["rank", "--theory", "--weapon", "121", "--json"]);
    same(&["rank", "--theory", "--weapon", "129:1"]);
    same(&["rank", "--theory", "--blade", "131", "--json"]);
    same(&["rank", "--theory", "--level", "30", "--json"]);
    same(&["rank", "--theory", "--target", "ARMOURED", "--json"]);
    same(&["rank", "--theory", "--core", "Overhaul", "--json"]);
    same(&["rank", "--theory", "--blade", "129", "--json"]);
    same(&[
        "rank",
        "--theory",
        "--star-stat",
        "strength=10",
        "--star-stat",
        "strength=5",
        "--json",
    ]);
    same(&[
        "rank",
        "--theory",
        "--star-skill",
        "29=15,34=5",
        "--star-skill",
        "29=3",
        "--json",
    ]);
    // A non-boss target takes --health as the scenario's pool, not a body override.
    same(&[
        "rank", "--theory", "--target", "soft", "--health", "500", "--json",
    ]);
    same(&[
        "rank",
        "--theory",
        "--target",
        "human",
        "--behind",
        "--backstab",
        "0.5",
    ]);
    same(&[
        "rank", "--theory", "--target", "tough", "--level", "20", "--no-rri",
    ]);
    same(&[
        "rank", "--theory", "--target", "boss", "--armor", "100", "--json",
    ]);
    same(&[
        "rank", "--theory", "--target", "soft", "--traits", "curbing",
    ]);
    same(&[
        "rank",
        "--theory",
        "--target",
        "skyketch",
        "--players",
        "2",
        "--json",
    ]);
    same(&["rank", "--theory", "--target", "human", "--level", "10"]);
    same(&["rank", "--theory", "--firmament", "--star-damage", "20"]);
    same(&["rank", "--theory", "--gear-lb", "0", "--gear-cs", "0"]);
    same(&["rank", "--theory", "--no-effects", "--json"]);
    same(&["rank", "--theory", "--base-stats", "80", "--json"]);
    same(&["rank", "--theory", "--base-stats", "80", "--vampire"]);
    // JS Number() semantics on the numeric flags: hex and exponent text, and an empty --traits list.
    same(&["rank", "--theory", "--level", "0x10", "--json"]);
    same(&["rank", "--theory", "--level", "1e1", "--json"]);
    same(&["rank", "--theory", "--traits=", "--json"]);
    same(&[
        "rank", "--theory", "--target", "tough", "--target", "soft", "--json",
    ]);
}

/// A usage error: both print to stderr, exit 2, and no stack (the JS bin prints the UsageError message only).
fn same_usage(args: &[&str]) {
    let want = js(args);
    let got = rust(args);
    assert_eq!(want.status.code(), Some(2), "js {args:?}");
    assert_eq!(
        got.status.code(),
        Some(2),
        "rust {args:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&got.stderr).trim_end(),
        String::from_utf8_lossy(&want.stderr).trim_end(),
        "stderr differs for {args:?}"
    );
}

#[test]
fn rank_usage_errors_exit_2_with_the_same_message() {
    same_usage(&["rank", "--theory", "--target", "toguh"]);
    same_usage(&["rank", "--theory", "--level", "0"]);
    same_usage(&["rank", "--theory", "--level", "abc"]);
    same_usage(&["rank", "--theory", "--stacks", "9"]);
    same_usage(&["rank", "--theory", "--players", "0"]);
    same_usage(&["rank", "--theory", "--health", "0"]);
    same_usage(&["rank", "--theory", "--armor", "abc"]);
    same_usage(&["rank", "--theory", "--backstab", "2"]);
    same_usage(&["rank", "--theory", "--blow-x", "0"]);
    same_usage(&["rank", "--theory", "--top", "0"]);
    same_usage(&["rank", "--theory", "--top", "abc"]);
    same_usage(&["rank", "--theory", "--top=-1"]);
    same_usage(&["rank", "--theory", "--level=-1"]);
    same_usage(&["rank", "--theory", "--backstab=2"]);
    same_usage(&["rank", "--theory", "--potency", "abc"]);
    same_usage(&["rank", "--theory", "--pierce", "abc"]);
    same_usage(&["rank", "--theory", "--gear-lb", "abc"]);
    same_usage(&["rank", "--theory", "--damage-pct", "abc"]);
    same_usage(&["rank", "--theory", "--health-share", "2"]);
    same_usage(&["rank", "--theory", "--self-health-share", "abc"]);
    same_usage(&["rank", "--theory", "--star-damage", "abc"]);
    same_usage(&["rank", "--theory", "--swing", "nope"]);
    same_usage(&["rank", "--theory", "--traits", "nope"]);
    same_usage(&["rank", "--theory", "--core", "clasic"]);
    same_usage(&["rank", "--theory", "--race", "nope"]);
    same_usage(&["rank", "--theory", "--blade", "999"]);
    same_usage(&["rank", "--theory", "--blade", "abc"]);
    same_usage(&["rank", "--theory", "--weapon", "999:9"]);
    same_usage(&["rank", "--theory", "--weapon", "121:abc"]);
    same_usage(&["rank", "--theory", "--weapon", "121:99"]);
    same_usage(&["rank", "--theory", "--star-stat", "strength=99"]);
    same_usage(&["rank", "--theory", "--star-stat", "nope=1"]);
    same_usage(&["rank", "--theory", "--star-skill", "99=1"]);
    same_usage(&["rank", "--theory", "--star-skill", "29=x"]);
    same_usage(&["rank", "--theory", "--target="]);
    same_usage(&["rank", "--theory", "--race="]);
    same_usage(&["rank", "--theory", "--swing="]);
    same_usage(&["rank", "--theory", "--core="]);
    same_usage(&["rank", "--theory", "--blade="]);
    same_usage(&["rank", "--theory", "--level="]);
    same_usage(&["rank", "--theory", "--health="]);
    same_usage(&["rank", "--theory", "--traits", "curbing,nope"]);
    same_usage(&["rank", "--theory", "--target", "tough", "--target", "nope"]);
}

#[test]
fn unsupported_and_unknown_options_fail_explicitly() {
    let cases: [&[&str]; 9] = [
        &["rank", "--save", "SAVE4"],
        &["build", "--theory"],
        &["rank", "--theory", "--out", "x.html"],
        &["rank", "--theory", "--bogus"],
        &["rank", "--theory", "--passive", "none"],
        &["rank", "--theory", "--bare"],
        &["rank", "--theory", "--encounter", "breach"],
        &["rank", "--theory", "--target"],
        &["rank", "weapons", "extra"],
    ];
    for args in cases {
        let got = rust(args);
        assert_eq!(got.status.code(), Some(2), "rust {args:?}");
        assert!(
            !String::from_utf8_lossy(&got.stderr).contains("\n  at "),
            "no stack for {args:?}"
        );
        assert!(
            !got.stderr.is_empty(),
            "a refusal explains itself for {args:?}"
        );
    }
    // A bare `rank` really does need a save, and says so instead of printing a save-less card.
    let got = rust(&["rank"]);
    assert_eq!(got.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&got.stderr).contains("--theory"));
    assert!(got.stdout.is_empty());
}

#[test]
fn help_lists_the_slice_and_exits_0() {
    let got = rust(&["--help"]);
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    for flag in ["rank", "--theory", "--json", "--target", "--blade"] {
        assert!(text.contains(flag), "help names {flag}");
    }
}
