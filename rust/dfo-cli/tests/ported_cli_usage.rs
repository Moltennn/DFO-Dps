//! Ported from `test/cliUsage.test.js`: the usage-error contract, as Rust-only assertions.
//!
//! LOCAL INVARIANTS on the port's own binary (no Node, no differential): a usage error exits 2, prints no stack, and
//! names the bad value; an unknown command is reported before any save lookup; commands that read no save run with an
//! empty save folder. The JS snapshots the exact stderr bytes; those live in the CLI snapshot stage, not here.

use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_dfo-forge"))
}

/// A fresh empty user-data root, so no real save is read.
fn empty_root(label: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root =
        std::env::temp_dir().join(format!("dfo-ported-cli-{label}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("Saves")).expect("a temp save folder");
    root
}

fn run(root: &std::path::Path, args: &[&str]) -> std::process::Output {
    bin()
        .args(args)
        .current_dir(root)
        .env("DAGGER_USER_DATA", root)
        .env("HOME", root)
        .env("LC_ALL", "en_US.UTF-8")
        .env("LANG", "en_US.UTF-8")
        .output()
        .expect("the Rust CLI runs")
}

/// A fresh page path under the temp root: the report page is create-only, so a reused path is a usage error.
fn page(root: &std::path::Path, name: &str) -> String {
    root.join(format!("{name}.html"))
        .to_str()
        .expect("utf-8 page path")
        .to_owned()
}

/// Exit 2, stderr carries `needle`, and no stack frame is printed.
fn usage_error(root: &std::path::Path, args: &[&str], needle: &str) {
    let out = run(root, args);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{args:?}: {stderr}");
    assert!(stderr.contains(needle), "{args:?}: {stderr}");
    assert!(
        !stderr.contains("\n    at "),
        "a usage error prints no stack: {stderr}"
    );
}

#[test]
fn an_unknown_target_exits_2_and_lists_the_valid_names() {
    let root = empty_root("target");
    usage_error(
        &root,
        &["build", "--theory", "--target", "toguh"],
        "unknown target \"toguh\"",
    );
    let out = run(&root, &["build", "--theory", "--target", "toguh"]);
    let stderr = String::from_utf8_lossy(&out.stderr);
    for name in [
        "soft", "tough", "armoured", "human", "boss", "gate", "breach", "ruhn", "skyketch", "abyss",
    ] {
        assert!(stderr.contains(name), "the list names {name}: {stderr}");
    }
}

#[test]
fn validation_errors_exit_2_without_a_stack() {
    let root = empty_root("validation");
    usage_error(&root, &["compare", "--theory"], "compare needs --stat");
    usage_error(
        &root,
        &[
            "scale", "--theory", "--stat", "strength", "--stat", "agility",
        ],
        "one --stat per run",
    );
    usage_error(&root, &["scale", "--theory"], "scale needs --stat");
    usage_error(
        &root,
        &["graph", "--theory", "--series", "skill:abc"],
        "bad skill id",
    );
    usage_error(
        &root,
        &["graph", "--theory", "--series", "foo"],
        "graph series must be",
    );
    usage_error(
        &root,
        &["graph", "--theory", "--series", "stat"],
        "needs an attribute name",
    );
    usage_error(
        &root,
        &["build", "--theory", "--weapon", "999:9"],
        "unknown weapon template 999",
    );
    usage_error(
        &root,
        &["report", "--theory", "--out", "/no/such/dir/x.html"],
        "cannot write /no/such/dir/x.html",
    );
}

#[test]
fn an_unknown_core_exits_2() {
    let root = empty_root("core");
    usage_error(
        &root,
        &["build", "--theory", "--core", "clasic"],
        "unknown core \"clasic\"",
    );
}

#[test]
fn game_build_validates_and_selects_the_shipped_build() {
    let root = empty_root("build");
    usage_error(
        &root,
        &["build", "--theory", "--game-build", "14513"],
        "--game-build must be one of 14512, 14631",
    );
    let plain = run(&root, &["build", "--theory", "--json"]);
    let cut = run(
        &root,
        &["build", "--theory", "--game-build", "14512", "--json"],
    );
    let drift = run(
        &root,
        &["build", "--theory", "--game-build", "14631", "--json"],
    );
    for (label, out) in [("plain", &plain), ("cut", &cut), ("drift", &drift)] {
        assert_eq!(
            out.status.code(),
            Some(0),
            "{label}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    assert_eq!(
        plain.stdout, drift.stdout,
        "no --game-build is the live build"
    );
    assert_ne!(
        plain.stdout, cut.stdout,
        "14512 moves the card back to the cut"
    );
    let live = String::from_utf8_lossy(&plain.stdout);
    let cut_text = String::from_utf8_lossy(&cut.stdout);
    assert!(
        live.contains("\"gearAdd\""),
        "the live card carries the flat add"
    );
    assert!(
        !cut_text.contains("\"gearAdd\""),
        "and the cut has no such field"
    );
}

#[test]
fn game_build_is_rejected_by_every_command_that_does_not_read_it() {
    let root = empty_root("notread");
    for cmd in ["firmament", "probe", "saves", "doctor", "spells", "spell"] {
        let out = run(&root, &[cmd, "--theory", "--game-build", "14631"]);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{cmd}: {stderr}");
        assert!(
            stderr.contains(&format!("--game-build is not read by {cmd}")),
            "{cmd}: {stderr}"
        );
    }
    for cmd in [
        "build",
        "rank",
        "imprints",
        "weapons",
        "skills",
        "enchant-plan",
        "gear-plan",
    ] {
        let p = page(&root, cmd);
        let mut argv = vec![cmd, "--theory", "--game-build", "14631"];
        if matches!(
            cmd,
            "imprints" | "weapons" | "skills" | "enchant-plan" | "gear-plan"
        ) {
            argv.extend(["--out", p.as_str()]);
        }
        let out = run(&root, &argv);
        assert_eq!(
            out.status.code(),
            Some(0),
            "{cmd}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

#[test]
fn help_names_every_accepted_target_and_describes_all_data_and_compare() {
    let root = empty_root("help");
    let out = run(&root, &["--help"]);
    assert_eq!(out.status.code(), Some(0));
    let text = String::from_utf8_lossy(&out.stdout);
    for name in [
        "soft", "tough", "armoured", "human", "boss", "gate", "breach", "ruhn", "skyketch", "abyss",
    ] {
        assert!(text.contains(name), "help names {name}");
    }
    assert!(
        text.contains("scale: every relevant channel"),
        "help describes scale --all's meaning"
    );
    assert!(
        !text.contains("scale/compare every relevant channel"),
        "help does not attribute --all to compare"
    );
    // `--data` is a probe/spell/spells flag, and each is named.
    assert!(text.contains("--data"), "help describes --data");
}

#[test]
fn commands_that_read_no_save_run_with_an_empty_save_folder() {
    let root = empty_root("nosave");
    for (i, args) in [
        &["imprints"][..],
        &["enchant-plan"][..],
        &["firmament", "--build", "bow"][..],
        &["loadout", "--uncapped", "--target", "soft"][..],
        &["weapons"][..],
        &["saves"][..],
        &["doctor"][..],
    ]
    .into_iter()
    .enumerate()
    {
        let p = page(&root, &format!("nosave{i}"));
        let mut argv: Vec<&str> = args.to_vec();
        if !matches!(args[0], "saves" | "doctor") {
            argv.extend(["--out", p.as_str()]);
        }
        let out = run(&root, &argv);
        assert_eq!(
            out.status.code(),
            Some(0),
            "{argv:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

#[test]
fn probe_without_a_capture_is_a_usage_error_not_a_save_lookup() {
    let root = empty_root("probe");
    let out = run(&root, &["probe"]);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{stderr}");
    assert!(stderr.contains("probe: no capture"), "{stderr}");
    assert!(!stderr.contains("no saves found"), "{stderr}");
    assert!(!stderr.contains("\n    at "), "{stderr}");
}

#[test]
fn an_unknown_command_is_reported_before_any_save_lookup() {
    let root = empty_root("unknown");
    let out = run(&root, &["buidl"]);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{stderr}");
    assert!(stderr.contains("unknown command \"buidl\""), "{stderr}");
    assert!(!stderr.contains("no saves found"), "{stderr}");
}

#[test]
fn a_missing_or_named_away_save_is_a_usage_error() {
    let root = empty_root("missing");
    let missing = run(&root, &["build", "--target", "soft"]);
    let stderr = String::from_utf8_lossy(&missing.stderr);
    assert_eq!(missing.status.code(), Some(2), "{stderr}");
    assert!(stderr.contains("no saves found under"), "{stderr}");
    assert!(stderr.contains("Saves"), "{stderr}");
    assert!(!stderr.contains("\n    at "), "{stderr}");
    let named = run(&root, &["rank", "--save", "nope"]);
    let stderr = String::from_utf8_lossy(&named.stderr);
    assert_eq!(named.status.code(), Some(2), "{stderr}");
    assert!(stderr.contains("save \"nope\" not found"), "{stderr}");
    assert!(!stderr.contains("\n    at "), "{stderr}");
}

#[test]
fn star_channels_are_usage_errors() {
    let root = empty_root("star");
    usage_error(
        &root,
        &["build", "--theory", "--star-stat", "strength=99"],
        "Firmament attribute channel is capped",
    );
    usage_error(
        &root,
        &["build", "--theory", "--star-skill", "99=1"],
        "bad skill id",
    );
}

#[test]
fn json_writes_json_and_nothing_else_for_every_command_that_supports_it() {
    let root = empty_root("json");
    for args in [
        &["enchant", "--theory", "--json"][..],
        &["scale", "--theory", "--stat", "strength", "--json"][..],
        &["tradeoff", "--theory", "--json"][..],
        &["build", "--theory", "--json"][..],
        &["theory", "--json"][..],
    ] {
        let out = run(&root, args);
        assert_eq!(
            out.status.code(),
            Some(0),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let text = String::from_utf8_lossy(&out.stdout);
        let trimmed = text.trim();
        assert!(
            trimmed.starts_with('{') || trimmed.starts_with('['),
            "{args:?} must print only JSON"
        );
        assert!(trimmed.ends_with('}') || trimmed.ends_with(']'), "{args:?}");
    }
}

#[test]
fn out_is_rejected_where_the_command_writes_no_file() {
    let root = empty_root("noout");
    let p = page(&root, "noout");
    for cmd in ["build", "theory", "compare", "scale", "enchant", "tradeoff"] {
        let out = run(
            &root,
            &[cmd, "--theory", "--stat", "strength", "--out", p.as_str()],
        );
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{cmd}: {stderr}");
        assert!(
            stderr.contains("--out is only for commands that write a file"),
            "{cmd}: {stderr}"
        );
        assert!(
            stderr.contains(&format!("not \"{cmd}\"")),
            "{cmd}: {stderr}"
        );
    }
}

// ── loadoutShortlist.test.js: the shortlist's usage errors ─────────────────

#[test]
fn invalid_shortlist_options_exit_2() {
    let root = empty_root("shortlist");
    for (args, needle) in [
        (&["loadout", "--shortlist=-1"][..], "shortlist"),
        (&["loadout", "--shortlist", "1.5"][..], "shortlist"),
        (&["loadout", "--shortlist", "9999"][..], "eligible"),
        (
            &[
                "loadout",
                "--shortlist",
                "1",
                "--objective",
                "stochastic-relay",
            ][..],
            "uncapped",
        ),
        (
            &[
                "loadout",
                "--shortlist",
                "1",
                "--cap-aware",
                "--objective",
                "kill-probability",
            ][..],
            "stochastic-relay",
        ),
        (
            &["loadout", "--shortlist", "1", "--trials", "999"][..],
            "1000",
        ),
        (
            &[
                "loadout",
                "--shortlist",
                "1",
                "--cap-aware",
                "--health",
                "100",
            ][..],
            "does not apply",
        ),
        (
            &["loadout", "--shortlist", "1", "--health", "0"][..],
            "must be a positive",
        ),
        (
            &["loadout", "--shortlist", "1", "--no-carry"][..],
            "--no-carry does not apply to --shortlist",
        ),
    ] {
        let out = run(&root, args);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{args:?}: {stderr}");
        assert!(stderr.contains(needle), "{args:?}: {stderr}");
    }
}

// ── objectiveCli.test.js: the objective command's usage refusals ───────────

#[test]
fn objective_usage_errors_exit_2_and_list_the_objective_names() {
    let root = empty_root("objective");
    for (args, needle) in [
        (
            &[
                "objective",
                "--theory",
                "--target",
                "soft",
                "--objective",
                "toString",
            ][..],
            "unknown objective",
        ),
        (
            &[
                "objective",
                "--theory",
                "--target",
                "soft",
                "--objective",
                "stochastic-ttk",
                "--trials",
                "999",
            ][..],
            "at least 1000 trials",
        ),
        (
            &[
                "objective",
                "--theory",
                "--target",
                "soft",
                "--trials",
                "1000.5",
            ][..],
            "integer",
        ),
        (
            &[
                "objective",
                "--theory",
                "--target",
                "soft",
                "--objective",
                "stochastic-relay",
            ][..],
            "not a relay body",
        ),
        (
            &[
                "objective",
                "--theory",
                "--target",
                "soft",
                "--objective",
                "fight",
                "--health",
                "0",
            ][..],
            "positive",
        ),
        (
            &[
                "objective",
                "--theory",
                "--target",
                "soft",
                "--seed",
                "1.25",
            ][..],
            "integer",
        ),
    ] {
        let out = run(&root, args);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{args:?}: {stderr}");
        assert!(stderr.contains(needle), "{args:?}: {stderr}");
    }
    // The unknown-objective message lists every accepted name.
    let out = run(
        &root,
        &[
            "objective",
            "--theory",
            "--target",
            "soft",
            "--objective",
            "toString",
        ],
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    for name in [
        "snapshot",
        "fight",
        "relay",
        "relay-ceiling",
        "stochastic-ttk",
        "stochastic-relay",
        "kill-probability",
    ] {
        assert!(stderr.contains(name), "the list names {name}: {stderr}");
    }
}
