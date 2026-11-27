//! The R8 `objective` slice, differentially against the real JS CLI.
//!
//! Every success case runs `bin/dfo-dps.js objective ...` and the Rust binary with the same arguments and compares
//! stdout byte for byte: the deterministic cards, the sampled cards and `--json` (with and without `--samples`). A
//! usage case compares stderr and the exit code, exactly as `bin/dfo-dps.js` prints it.
//!
//! The theory cases read no save, and the sampled ones keep the trial count at the audit's 1,000 minimum but shorten the
//! horizon and the blow budget (`--max-blows 12`) so a full run stays a few seconds; the seeds and the tier tables are
//! shared, so the recorded rows are still the real engine's. Every case sets `DAGGER_USER_DATA` to a fresh empty root, so
//! neither CLI reads the player's launcher config: both take the empty spellbook, which is the JS's own fallback.
//!
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::{js as js_env, pin_mtime, rust as rust_env, temp_root};

use std::fs;
use std::path::{Path, PathBuf};

/// The offline save shape (`items[].equipSlot`), as `tests/build.rs` writes it: a main hand and an off hand.
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

/// A `DAGGER_USER_DATA` root with one imported save (`SAVE1`), so the objective command prices a real character.
fn save_root(label: &str) -> PathBuf {
    let root = temp_root(label);
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("fixture save folder");
    fs::write(dir.join("SaveData.txt"), offline_save()).expect("fixture save");
    pin_mtime(&dir.join("SaveData.txt"));
    root
}

fn same(args: &[&str]) {
    same_in(&temp_root("same"), args);
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

/// Both refuse the same way: same exit code and same stderr line.
fn same_usage(args: &[&str]) {
    let root = temp_root("usage");
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
        String::from_utf8_lossy(&got.stderr),
        String::from_utf8_lossy(&want.stderr),
        "stderr differs for {args:?}"
    );
    assert!(got.stdout.is_empty(), "no stdout for {args:?}");
    let _ = fs::remove_dir_all(&root);
}

/// A sample the engine refuses for a reason `isUsageFailure` does not name: both crash with exit 1. V8 prints the
/// stack; the Rust front end prints the message line only, so the message is compared as a substring, not the frames.
fn same_crash(args: &[&str]) {
    let root = temp_root("crash");
    let want = js_env(args, &root);
    let got = rust_env(args, &root);
    let js_err = String::from_utf8_lossy(&want.stderr);
    let rust_err = String::from_utf8_lossy(&got.stderr);
    assert_eq!(want.status.code(), Some(1), "js {args:?}: {js_err}");
    assert_eq!(got.status.code(), Some(1), "rust {args:?}: {rust_err}");
    assert!(
        js_err.contains("bow and gun builds are not supported"),
        "js {args:?}"
    );
    assert!(
        rust_err.contains("bow and gun builds are not supported"),
        "rust {args:?}"
    );
    assert!(got.stdout.is_empty(), "no stdout for {args:?}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn objective_deterministic_text_matches_the_js_cli() {
    for preset in ["soft", "tough", "armoured", "human"] {
        same(&["objective", "--theory", "--target", preset]);
    }
    same(&["objective", "--theory", "--target", "gate"]);
    same(&[
        "objective",
        "--theory",
        "--target",
        "breach",
        "--health",
        "9000",
    ]);
    same(&[
        "objective",
        "--theory",
        "--target",
        "skyketch",
        "--health",
        "9000",
    ]);
    same(&["objective", "--theory", "--target", "abyss"]);
    same(&[
        "objective",
        "--theory",
        "--target",
        "boss",
        "--health",
        "12000",
        "--armor",
        "30",
    ]);
    same(&[
        "objective",
        "--theory",
        "--target",
        "boss",
        "--objective",
        "fight",
        "--health",
        "12000",
    ]);
    same(&[
        "objective",
        "--theory",
        "--target",
        "soft",
        "--health",
        "500",
    ]);
    same(&["objective", "--theory"]);
    same(&["objective", "--theory", "--objective", "fight"]);
    same(&[
        "objective",
        "--theory",
        "--target",
        "gate",
        "--objective",
        "fight",
        "--health",
        "5000",
    ]);
    same(&[
        "objective",
        "--theory",
        "--target",
        "gate",
        "--objective",
        "relay",
        "--players",
        "3",
    ]);
    same(&[
        "objective",
        "--theory",
        "--objective",
        "relay-ceiling",
        "--target",
        "gate",
        "--health",
        "9000",
    ]);
    same(&[
        "objective",
        "--theory",
        "--target",
        "soft",
        "--traits",
        "curbing",
    ]);
    // `--weapon` changes the theory blade when the character is built; `scenarioOf` keeps it undefined for theory.
    same(&[
        "objective",
        "--theory",
        "--weapon",
        "121:3",
        "--objective",
        "relay",
        "--target",
        "gate",
    ]);
    same(&[
        "objective",
        "--theory",
        "--core",
        "classic",
        "--behind",
        "--target",
        "tough",
        "--json",
    ]);
}

#[test]
fn objective_deterministic_json_matches_the_js_cli() {
    same(&["objective", "--theory", "--target", "soft", "--json"]);
    same(&["objective", "--theory", "--json"]);
    same(&["objective", "--theory", "--objective", "fight", "--json"]);
    same(&[
        "objective",
        "--theory",
        "--target",
        "gate",
        "--objective",
        "relay",
        "--health",
        "5000",
        "--players",
        "3",
        "--json",
    ]);
    same(&[
        "objective",
        "--theory",
        "--objective",
        "relay-ceiling",
        "--target",
        "breach",
        "--json",
    ]);
    same(&[
        "objective",
        "--theory",
        "--target",
        "boss",
        "--health",
        "12000",
        "--json",
    ]);
    // `--health` is the declared total pool and the relay line is the per-player share of it.
    same(&[
        "objective",
        "--theory",
        "--objective",
        "relay",
        "--target",
        "gate",
        "--health",
        "500",
        "--players",
        "3",
        "--json",
    ]);
    same(&[
        "objective",
        "--theory",
        "--target",
        "soft",
        "--health",
        "500",
        "--json",
    ]);
}

#[test]
fn objective_sampled_matches_the_js_cli() {
    let sampled_ttk = [
        "--objective",
        "stochastic-ttk",
        "--target",
        "soft",
        "--health",
        "5000",
        "--max-seconds",
        "10",
        "--max-blows",
        "12",
        "--seed",
        "7",
    ];
    let mut text = vec!["objective", "--theory"];
    text.extend_from_slice(&sampled_ttk);
    same(&text);

    let mut json = text.clone();
    json.push("--json");
    same(&json);

    let mut json_samples = json.clone();
    json_samples.push("--samples");
    same(&json_samples);

    let mut no_carry = json.clone();
    no_carry.push("--no-carry");
    same(&no_carry);

    let sample = [
        "objective",
        "--theory",
        "--objective",
        "kill-probability",
        "--target",
        "tough",
        "--health",
        "5000",
        "--max-seconds",
        "10",
        "--max-blows",
        "12",
        "--json",
        "--samples",
    ];
    same(&sample);
}

/// The CLI accepts any positive finite `--max-seconds` and any positive safe-integer `--max-blows`
/// (`sampled_options`), so the port cannot refuse the REQUEST. It bounds the work instead, and a fight that ends first
/// must price exactly as the JS: here the boss dies in about 0.3 s, so a 100,000,000-second horizon is never reached.
#[test]
fn a_horizon_past_the_old_core_cap_prices_the_js_answer() {
    same(&[
        "objective",
        "--theory",
        "--objective",
        "stochastic-ttk",
        "--target",
        "soft",
        "--health",
        "500",
        "--max-seconds",
        "100000000",
        "--max-blows",
        "12",
        "--seed",
        "7",
    ]);
    // The blow budget is the same kind of request (`--max-blows` takes any positive safe integer): the kill happens in
    // a handful of blows, so the huge budget is never reached.
    same(&[
        "objective",
        "--theory",
        "--objective",
        "stochastic-ttk",
        "--target",
        "soft",
        "--health",
        "500",
        "--max-seconds",
        "10",
        "--max-blows",
        "9007199254740991",
        "--seed",
        "7",
    ]);
}

#[test]
fn the_shipped_build_reaches_the_objective_scenarios() {
    // `src/cli.js:611-613` builds the scenario with `scenarioOf`, so `--game-build` must reach every objective that
    // prices a card. Both builds are compared to the JS byte for byte, and the two must differ: a gear-heavy theory
    // character (legal 535/370/15%) moves the deterministic relay and the sampled TTK, while the default card does not.
    let root = temp_root("game-build");
    let gear = ["--gear-lb", "535", "--gear-cs", "370", "--damage-pct", "15"];
    let cases: [&[&str]; 3] = [
        // The deterministic relay card (its `uncappedDps` and its drum).
        &[
            "objective",
            "--theory",
            "--json",
            "--objective",
            "relay",
            "--target",
            "breach",
        ],
        // The sampled TTK card at the audit's trial floor, with the same short horizon the other sampled cases use.
        &[
            "objective",
            "--theory",
            "--json",
            "--objective",
            "stochastic-ttk",
            "--target",
            "soft",
            "--health",
            "5000",
            "--max-seconds",
            "10",
            "--max-blows",
            "12",
            "--seed",
            "7",
            "--trials",
            "1000",
        ],
        // The deterministic relay-ceiling card over the same body.
        &[
            "objective",
            "--theory",
            "--json",
            "--objective",
            "relay-ceiling",
            "--target",
            "breach",
        ],
    ];
    for args in cases {
        let mut cut: Vec<&str> = args.to_vec();
        cut.extend_from_slice(&gear);
        cut.extend_from_slice(&["--game-build", "14512"]);
        let mut drift: Vec<&str> = args.to_vec();
        drift.extend_from_slice(&gear);
        drift.extend_from_slice(&["--game-build", "14631"]);
        same(&cut);
        same(&drift);
        let cut_out = js_env(&cut, &root).stdout;
        let drift_out = js_env(&drift, &root).stdout;
        assert_ne!(
            String::from_utf8_lossy(&cut_out),
            String::from_utf8_lossy(&drift_out),
            "14631 must move this gear-heavy card: {args:?}"
        );
    }
    // And the default is the live build: no flag prices the same bytes as an explicit 14631 run, and differs from 14512.
    let mut plain: Vec<&str> = cases[0].to_vec();
    plain.extend_from_slice(&gear);
    let mut explicit: Vec<&str> = plain.clone();
    explicit.extend_from_slice(&["--game-build", "14631"]);
    assert_eq!(
        String::from_utf8_lossy(&js_env(&plain, &root).stdout),
        String::from_utf8_lossy(&js_env(&explicit, &root).stdout),
        "no --game-build is 14631"
    );
    let mut cut: Vec<&str> = plain.clone();
    cut.extend_from_slice(&["--game-build", "14512"]);
    assert_ne!(
        String::from_utf8_lossy(&js_env(&plain, &root).stdout),
        String::from_utf8_lossy(&js_env(&cut, &root).stdout),
        "14512 still selects the cut"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn objective_relay_sampled_matches_the_js_cli() {
    let base = [
        "objective",
        "--theory",
        "--objective",
        "stochastic-relay",
        "--target",
        "gate",
        "--health",
        "5000",
        "--players",
        "3",
        "--max-seconds",
        "10",
        "--max-blows",
        "12",
        "--trials",
        "1000",
    ];
    same(&base);

    let mut json = base.to_vec();
    json.push("--json");
    same(&json);

    let mut text = [
        "objective",
        "--theory",
        "--objective",
        "stochastic-relay",
        "--target",
        "skyketch",
        "--health",
        "9000",
        "--max-seconds",
        "10",
        "--max-blows",
        "12",
    ]
    .to_vec();
    same(&text);

    text.extend_from_slice(&["--no-carry", "--json"]);
    same(&text);
}

#[test]
fn objective_from_an_imported_save_matches_the_js_cli() {
    // The save-backed character is the `characterFromSave` normalisation; the objective command reads it read-only.
    let root = save_root("save-text");
    same_in(&root, &["objective", "--save", "SAVE1", "--target", "soft"]);

    let root = save_root("save-json");
    same_in(
        &root,
        &[
            "objective",
            "--save",
            "SAVE1",
            "--target",
            "tough",
            "--objective",
            "fight",
            "--json",
        ],
    );

    let root = save_root("save-relay");
    same_in(
        &root,
        &[
            "objective",
            "--save",
            "SAVE1",
            "--objective",
            "relay",
            "--target",
            "gate",
            "--players",
            "2",
            "--json",
        ],
    );

    // A save's `--weapon` is the `scenarioOf` override (the theory character applies it when built instead).
    let root = save_root("save-weapon");
    same_in(
        &root,
        &[
            "objective",
            "--save",
            "SAVE1",
            "--weapon",
            "121:3",
            "--target",
            "soft",
            "--json",
        ],
    );
}

#[test]
fn objective_usage_matches_the_js_cli() {
    same_usage(&["objective", "--theory", "--objective", "toString"]);
    same_usage(&[
        "objective",
        "--theory",
        "--objective",
        "stochastic-ttk",
        "--trials",
        "999",
    ]);
    same_usage(&["objective", "--theory", "--trials", "1000.5"]);
    same_usage(&["objective", "--theory", "--trials", "0"]);
    same_usage(&["objective", "--theory", "--trials", "abc"]);
    same_usage(&["objective", "--theory", "--trials="]);
    same_usage(&["objective", "--theory", "--trials", "1000001"]);
    same_usage(&["objective", "--theory", "--seed", "1.25"]);
    same_usage(&["objective", "--theory", "--seed="]);
    same_usage(&["objective", "--theory", "--trials", "9007199254740992"]);
    same_usage(&["objective", "--theory", "--seed", "9007199254740992"]);
    same_usage(&["objective", "--theory", "--max-blows", "9007199254740992"]);
    same_usage(&["objective", "--theory", "--max-seconds", "1e400"]);
    same_usage(&["objective", "--theory", "--max-seconds", "0"]);
    same_usage(&["objective", "--theory", "--max-blows", "0"]);
    same_usage(&["objective", "--theory", "--max-blows", "1.5"]);
    same_usage(&["objective", "--theory", "--health", "0"]);
    same_usage(&["objective", "--theory", "--health", "1e400"]);
    same_usage(&[
        "objective",
        "--theory",
        "--objective",
        "fight",
        "--health",
        "0",
    ]);
    same_usage(&[
        "objective",
        "--theory",
        "--target",
        "soft",
        "--objective",
        "fight",
        "--health",
        "1e-300",
    ]);
    same_usage(&[
        "objective",
        "--theory",
        "--objective",
        "stochastic-relay",
        "--target",
        "soft",
    ]);
    same_usage(&[
        "objective",
        "--theory",
        "--objective",
        "relay",
        "--target",
        "soft",
    ]);
    same_usage(&[
        "objective",
        "--theory",
        "--target",
        "gate",
        "--objective",
        "stochastic-ttk",
    ]);
    same_usage(&[
        "objective",
        "--theory",
        "--target",
        "boss",
        "--objective",
        "kill-probability",
    ]);
    same_usage(&[
        "objective",
        "--theory",
        "--traits",
        "curbing",
        "--objective",
        "stochastic-ttk",
    ]);
    // `checkOutputFlags` (`src/cli.js:886-898`): `objective` writes no file but does take `--json`.
    same_usage(&["objective", "--theory", "--out", "x.html"]);
}

#[test]
fn objective_engine_refusals_crash_like_the_js_cli() {
    // A ranged template is refused by `simulateFight`, which `isUsageFailure` does not name: exit 1 and the message,
    // with V8's stack on the JS side and only the message line on the Rust side (both exit 1).
    same_crash(&[
        "objective",
        "--theory",
        "--weapon",
        "560",
        "--objective",
        "stochastic-ttk",
        "--target",
        "soft",
        "--max-blows",
        "12",
    ]);
}
