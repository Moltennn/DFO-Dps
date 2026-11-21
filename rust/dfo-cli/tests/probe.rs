//! The R8 `probe` slice, differentially against the real JS CLI over synthetic captures.
//!
//! Every fixture here is built in this test (never a real capture), written to a temp file, and both CLIs are run on it.
//! `--json` compares stdout byte for byte. The text card compares byte for byte once the JS's `probe page written:`
//! line is dropped: that page (and its default `probe.html`) is the shared HTML renderer's, which this slice does not
//! port, and the Rust CLI deliberately writes no page and prints no such line. `--out` is refused by the Rust CLI for
//! the same reason, and the test pins that refusal.
//!
//! Discovery (the newest capture under `~/.local/share/dfo-tools/probe-mod/captures`, `--old`, the no-capture message)
//! runs both CLIs with a temp `HOME`. A missing `node` panics rather than skips: a skipped differential proves nothing.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn temp_dir(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir =
        std::env::temp_dir().join(format!("dfo-cli-probe-{label}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// The JS CLI runs with the temp dir as its working directory: it always writes the probe page beside it (`probe.html`
/// by default), and a test must never leave that in the checkout.
fn js(args: &[&str], cwd: &Path) -> Output {
    Command::new("node")
        .arg(repo_root().join("bin").join("dfo-dps.js"))
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("the JS CLI runs (this repository's Node project)")
}

fn rust(args: &[&str], cwd: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_dfo-cli"))
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("the Rust CLI binary runs")
}

/// JS stdout without the page-write line; the page is the deferred HTML side effect (see the module doc).
fn js_without_page(stdout: &[u8]) -> String {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter(|l| !l.starts_with("probe page written: "))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A synthetic capture: a 10 Hz boss bar draining over `seconds`, a gate bar that drains and heals once, warded
/// halves in the second part, a sub-phase label, and an optional fight-end chart table.
fn capture(seconds: u32, chart: bool) -> String {
    capture_with(seconds, chart, true)
}

/// The same, with or without a `gate` sample field (a capture recorded without the gate-state patch has none).
fn capture_with(seconds: u32, chart: bool, gate: bool) -> String {
    let n = seconds * 10;
    let mut rows = Vec::new();
    for i in 0..=n {
        let t = i * 100;
        let post = i * 2 > n;
        let boss_hp = (100.0 - (i as f64 / n as f64) * 100.0).max(0.0);
        // The gate drains, heals +400 at halfway, then drains to zero at the end.
        let gate_hp = if i == n {
            0.0
        } else if i <= n / 2 {
            12000.0 - i as f64 * 10.0
        } else {
            12000.0 - (n / 2) as f64 * 10.0 + 400.0 - (i - n / 2) as f64 * 10.0
        };
        let gold = if post { boss_hp } else { 0.0 };
        let halves_json = if post {
            format!(
                r#"[{{"name":"Gold","hp":{gold},"state":"warded"}},{{"name":"Silver","hp":{gold},"state":""}}]"#
            )
        } else {
            "[]".to_string()
        };
        let gate_json = if gate {
            format!(
                r#""gate":{{"hp":{gate_hp},"max":12000,"fighters":1,"phase":1,"boss":"ruhn","fell":{}}}"#,
                i == n
            )
        } else {
            String::new()
        };
        rows.push(format!(
            r#"{{"t":{t},"wall":{wall},"boss":{{"content":"breach","name":"The Warden","sub":"phase one","hp":{boss_hp},"halves":{halves_json}}}{maybe_comma}{gate_json}}}"#,
            wall = 1_700_000_000_000u64 + t as u64,
            maybe_comma = if gate { "," } else { "" },
            gate_json = gate_json,
        ));
    }
    let chart = if chart {
        r##","chart":{"title":"Damage Dealt","sub":"The Warden has fallen - 1 challenger","text":"#ChallengerDamageShareBlowsBestCrystalsFallsHealed1FixtureLv 4512,5329%185492000","table":[{"name":"Fixture","level":"Lv 45","damage":"12,532","share":"9%","blows":"185","best":"492","crystals":"0","falls":"0","healed":"360"}],"rows":[]}"##
    } else {
        ""
    };
    format!(
        r#"{{"version":1,"build":"synthetic","level":45,"players":1,"startedAt":0,"endedAt":{ended},"samples":[{samples}],"events":[],"outcome":"kill","playerEnd":{{"weapon":{{"name":"Test Blade","imprint":"sharp"}},"offWeapon":null}}{chart}}}"#,
        ended = n * 100,
        samples = rows.join(","),
        chart = chart
    )
}

fn write_capture(dir: &Path, name: &str, text: &str) -> String {
    let path = dir.join(name);
    fs::write(&path, text).expect("capture fixture");
    path.to_string_lossy().into_owned()
}

fn same_text(args: &[&str], cwd: &Path) {
    let want = js(args, cwd);
    let got = rust(args, cwd);
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
        js_without_page(&got.stdout),
        js_without_page(&want.stdout),
        "stdout differs for {args:?}"
    );
    // The deferred side effect: the JS wrote its page, the Rust CLI wrote nothing.
    assert!(
        cwd.join("probe.html").exists(),
        "the JS CLI writes probe.html (this is the boundary, not Rust parity)"
    );
    fs::remove_file(cwd.join("probe.html")).expect("cleanup the JS page");
}

fn same_json(args: &[&str], cwd: &Path) {
    let want = js(args, cwd);
    let got = rust(args, cwd);
    assert_eq!(want.status.code(), Some(0), "js {args:?}");
    assert_eq!(got.status.code(), want.status.code(), "rust {args:?}");
    assert_eq!(
        String::from_utf8_lossy(&got.stdout),
        String::from_utf8_lossy(&want.stdout),
        "stdout differs for {args:?}"
    );
    fs::remove_file(cwd.join("probe.html")).expect("cleanup the JS page");
}

#[test]
fn probe_text_and_json_match_the_js_on_a_named_capture() {
    let dir = temp_dir("named");
    let file = write_capture(&dir, "capture.json", &capture(60, true));

    same_text(&["probe", &file], &dir);
    same_text(&["probe", "--data", &file], &dir);
    same_text(&["probe", &file, "--level", "30"], &dir);
    same_text(&["probe", &file, "--players", "5"], &dir);
    same_text(&["probe", &file, "--level", "30", "--players", "5"], &dir);
    // No chart rows: the top-10 block is absent, and the capture is not marked "kill" by the chart text.
    let plain = write_capture(&dir, "plain.json", &capture(30, false));
    same_text(&["probe", &plain], &dir);

    // Mid-fight: the gate starts below 95% of its max, so the "since join" rows fill in.
    let mut mid = capture(60, false);
    let before = mid.clone();
    mid = mid.replace(
        r#""gate":{"hp":12000,"max":12000"#,
        r#""gate":{"hp":9000,"max":12000"#,
    );
    assert_ne!(mid, before, "the fixture's first gate sample moved");
    let mid = write_capture(&dir, "mid.json", &mid);
    same_text(&["probe", &mid], &dir);

    // No gate bar at all: the health-derived figures are estimated, so the tilde and the level fill show.
    let bare = write_capture(&dir, "bare.json", &capture_with(40, false, false));
    same_text(&["probe", &bare], &dir);
    same_json(&["probe", &bare, "--json"], &dir);

    for args in [
        &["probe", &file, "--json"][..],
        &["probe", "--data", &file, "--json"][..],
        &["probe", &file, "--json", "--level", "30", "--players", "5"][..],
        &["probe", &plain, "--json"][..],
    ] {
        same_json(args, &dir);
    }
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn probe_discovers_the_newest_capture_like_the_js() {
    let root = temp_dir("discovery");
    let live = root
        .join(".local")
        .join("share")
        .join("dfo-tools")
        .join("probe-mod")
        .join("captures");
    fs::create_dir_all(live.join("old")).expect("captures folder");
    // `capturedAt` outranks the file's mtime: the older mtime file carries the newer stamp.
    let newer = capture(20, false).replace(
        r#""version":1"#,
        r#""version":1,"capturedAt":"2026-11-04T04:23:27.201Z""#,
    );
    let older = capture(10, false).replace(
        r#""version":1"#,
        r#""version":1,"capturedAt":"2026-11-01T00:00:00.000Z""#,
    );
    fs::write(live.join("a.json"), &older).expect("older capture");
    fs::write(live.join("b.json"), &newer).expect("newer capture");
    fs::write(live.join("not-a-capture.txt"), "ignored").expect("non-json file");
    // The archive folder keeps its own capture; `--old` must pick it.
    let archived = capture(15, false).replace(
        r#""version":1"#,
        r#""version":1,"capturedAt":"2026-10-01T00:00:00.000Z""#,
    );
    fs::write(live.join("old").join("c.json"), &archived).expect("archived capture");

    let with_home = |args: &[&str]| {
        let run = |program: &str, extra: &[&str]| {
            let mut command = Command::new(program);
            if program == "node" {
                command.arg(repo_root().join("bin").join("dfo-dps.js"));
            }
            command
                .args(extra)
                .current_dir(&live)
                .env("HOME", &root)
                .output()
                .expect("the CLI runs")
        };
        let want = run("node", args);
        let got = run(env!("CARGO_BIN_EXE_dfo-cli"), args);
        assert_eq!(want.status.code(), Some(0), "js {args:?}");
        assert_eq!(
            got.status.code(),
            Some(0),
            "rust {args:?}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert_eq!(
            js_without_page(&got.stdout),
            js_without_page(&want.stdout),
            "stdout differs for {args:?}"
        );
        let _ = fs::remove_file(live.join("probe.html"));
    };
    with_home(&["probe"]);
    with_home(&["probe", "--json"]);
    with_home(&["probe", "--old"]);
    with_home(&["probe", "--old", "--json"]);

    // The no-capture message and its exit code, in an empty home.
    let empty = temp_dir("empty-home");
    let no_capture = |args: &[&str]| {
        let want = Command::new("node")
            .arg(repo_root().join("bin").join("dfo-dps.js"))
            .args(args)
            .current_dir(&empty)
            .env("HOME", &empty)
            .output()
            .expect("the JS CLI runs");
        let got = Command::new(env!("CARGO_BIN_EXE_dfo-cli"))
            .args(args)
            .current_dir(&empty)
            .env("HOME", &empty)
            .output()
            .expect("the Rust CLI runs");
        assert_eq!(want.status.code(), Some(2), "js {args:?}");
        assert_eq!(got.status.code(), Some(2), "rust {args:?}");
        assert_eq!(
            String::from_utf8_lossy(&got.stderr),
            String::from_utf8_lossy(&want.stderr),
            "stderr differs for {args:?}"
        );
        assert!(got.stdout.is_empty(), "no card without a capture");
    };
    no_capture(&["probe"]);
    no_capture(&["probe", "--old"]);

    fs::remove_dir_all(&root).expect("cleanup");
    fs::remove_dir_all(&empty).expect("cleanup");
}

#[test]
fn probe_prints_the_card_without_fights_like_the_js() {
    let dir = temp_dir("nofight");
    // A version-1 capture with too few samples for one pull: the header, the "no boss health samples" line, no table.
    let empty = write_capture(
        &dir,
        "empty.json",
        r#"{"version":1,"build":"synthetic","level":45,"players":1,"samples":[],"chart":null}"#,
    );
    same_text(&["probe", &empty], &dir);
    same_json(&["probe", &empty, "--json"], &dir);
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn probe_refusals_match_the_js_where_they_can() {
    let dir = temp_dir("refusals");
    let file = write_capture(&dir, "capture.json", &capture(10, false));

    // An unreadable capture: both refuse with exit 2. For a missing file and a directory the OS facts are the same, so
    // the whole line must match; for malformed JSON the parser's text differs (V8 vs serde_json), so compare the prefix.
    for bad in [
        dir.join("missing.json").to_string_lossy().into_owned(),
        dir.to_string_lossy().into_owned(),
    ] {
        let want = js(&["probe", &bad], &dir);
        let got = rust(&["probe", &bad], &dir);
        assert_eq!(want.status.code(), Some(2), "js {bad}");
        assert_eq!(got.status.code(), Some(2), "rust {bad}");
        assert_eq!(
            String::from_utf8_lossy(&got.stderr),
            String::from_utf8_lossy(&want.stderr),
            "stderr differs for {bad}"
        );
    }
    let bad = write_capture(&dir, "bad.json", "{ not json");
    let want = js(&["probe", &bad], &dir);
    let got = rust(&["probe", &bad], &dir);
    assert_eq!(want.status.code(), Some(2), "js bad capture");
    assert_eq!(got.status.code(), Some(2), "rust bad capture");
    let prefix = format!("probe: cannot read {bad}: ");
    let want_text = String::from_utf8_lossy(&want.stderr);
    let got_text = String::from_utf8_lossy(&got.stderr);
    assert!(want_text.contains(&prefix), "js line: {want_text}");
    assert!(
        got_text
            .lines()
            .any(|l| l.starts_with(&prefix) && l.len() > prefix.len()),
        "rust line: {got_text}"
    );

    // A JSON document that is not a version-1 capture: the core's error text, exit 1 on both sides (the JS prints a
    // stack around it; the Rust front end prints the message alone, as it does for every crash).
    let other = write_capture(&dir, "other.json", r#"{"version":2,"samples":[]}"#);
    let want = js(&["probe", &other], &dir);
    let got = rust(&["probe", &other], &dir);
    assert_eq!(want.status.code(), Some(1), "js non-capture");
    assert_eq!(got.status.code(), Some(1), "rust non-capture");
    assert!(
        String::from_utf8_lossy(&want.stderr).contains("not a Combat Probe capture (version 1)")
    );
    assert_eq!(
        String::from_utf8_lossy(&got.stderr).trim_end(),
        "not a Combat Probe capture (version 1)"
    );

    // The deferred HTML: an explicit `--out` is refused by name instead of being accepted and ignored or never
    // written. (The JS would write that file; this slice has no renderer yet.)
    let got = rust(&["probe", &file, "--out", "x.html"], &dir);
    assert_eq!(got.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&got.stderr).contains("--out is not supported by this CLI slice")
    );
    assert!(!dir.join("x.html").exists());

    // Extra positionals: the JS ignores them, this slice refuses them on purpose.
    let got = rust(&["probe", &file, "extra"], &dir);
    assert_eq!(got.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&got.stderr).contains("unexpected positional argument"));

    fs::remove_dir_all(&dir).expect("cleanup");
}
