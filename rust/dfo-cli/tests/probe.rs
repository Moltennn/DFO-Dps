//! The R8 `probe` slice, differentially against the real JS CLI over synthetic captures.
//!
//! Every fixture here is built in this test (never a real capture), written to a temp file, and both CLIs are run on it.
//! stdout (the card plus its `probe page written:` line, or the `--json` document), stderr and the page file (`probe.html`
//! by default, `--out <file>` otherwise) are compared byte for byte. A real capture is never opened: only temp fixtures,
//! and a temp `HOME` for discovery.
//!
//! Deliberate deviations pinned here:
//! - the page write is create-only (`O_CREAT|O_EXCL`): every existing output path is refused with exit 2 and left
//!   byte-identical - the capture, an unrelated file, an existing report, a hard link, a symlink, a dangling symlink.
//!   The JS truncates instead: `probe_page_write_is_create_only` and `probe_refuses_to_overwrite_its_capture`;
//! - capture-derived text inserted into the page (chart names, table values) is escaped by the Rust CLI, raw in the JS:
//!   `probe_escapes_capture_derived_text_in_the_page`.
//!
//! A missing `node` panics rather than skips: a skipped differential proves nothing.

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

/// The page the JS and the Rust CLI both write: `probe.html` unless `--out` names another file.
fn page(cwd: &Path, name: &str) -> Vec<u8> {
    fs::read(cwd.join(name)).expect("the CLI wrote its report page")
}

/// A successful run: both exit 0, stdout matches byte for byte (card, page-write line or JSON), and the page file does
/// too. The JS page is read before the Rust run replaces it; the Rust page is returned (then removed).
fn same(args: &[&str], cwd: &Path, page_name: &str) -> String {
    let want = js(args, cwd);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    let want_page = page(cwd, page_name);
    fs::remove_file(cwd.join(page_name)).expect("cleanup the JS page");
    let got = rust(args, cwd);
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
    let got_page = page(cwd, page_name);
    if got_page != want_page {
        let at = got_page
            .iter()
            .zip(&want_page)
            .position(|(a, b)| a != b)
            .unwrap_or_else(|| got_page.len().min(want_page.len()));
        let from = at.saturating_sub(120);
        panic!(
            "the page differs for {args:?} at byte {at} (lens {} vs {}):\nrust: {:?}\njs:   {:?}",
            got_page.len(),
            want_page.len(),
            String::from_utf8_lossy(&got_page[from..(at + 200).min(got_page.len())]),
            String::from_utf8_lossy(&want_page[from..(at + 200).min(want_page.len())]),
        );
    }
    fs::remove_file(cwd.join(page_name)).expect("cleanup the page");
    String::from_utf8_lossy(&got_page).into_owned()
}

/// The default page (`probe.html`), discarded.
fn same_text(args: &[&str], cwd: &Path) {
    let _ = same(args, cwd, "probe.html");
}

/// The default page (`probe.html`), discarded; the JSON document is what stdout carries.
fn same_json(args: &[&str], cwd: &Path) {
    let _ = same(args, cwd, "probe.html");
}

/// The page emitted must be the JS's own SVG, so the two renderers must agree on the whole call, not just stdout.
fn same_page_html(args: &[&str], cwd: &Path, page_name: &str) {
    let html = same(args, cwd, page_name);
    assert!(
        html.starts_with("<!doctype html>"),
        "the page is the renderer's document"
    );
    assert!(
        !cwd.join("probe.html").exists(),
        "an --out page is the only one"
    );
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

#[test]
fn probe_text_json_and_page_match_the_js_on_a_named_capture() {
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

    // An explicit `--out`: same bytes as the default, and the page-write line names the absolute path.
    same_page_html(
        &["probe", &file, "--out", "custom.html"],
        &dir,
        "custom.html",
    );
    same_page_html(
        &["probe", &file, "--json", "--out", "custom.html"],
        &dir,
        "custom.html",
    );
    fs::remove_dir_all(&dir).expect("cleanup");
}

/// The chart's row names reach the page note (`chartTotals`). Safe text renders identically to the JS.
#[test]
fn probe_page_note_lists_the_chart_names_like_the_js() {
    let dir = temp_dir("names");
    let mut text = capture(20, true);
    let rows =
        r#""rows":[{"cls":"wb-dmg-name","text":"Fixture"},{"cls":"wb-dmg-name","text":"Second"}]"#;
    text = text.replace(r#""rows":[]"#, rows);
    let file = write_capture(&dir, "names.json", &text);
    let html = same_text_html(&["probe", &file], &dir);
    assert!(
        html.contains("Chart names: Fixture, Second."),
        "the note lists the chart names"
    );
    fs::remove_dir_all(&dir).expect("cleanup");
}

/// The default page's bytes, when a test wants to look inside it.
fn same_text_html(args: &[&str], cwd: &Path) -> String {
    same(args, cwd, "probe.html")
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
        assert_eq!(want.status.code(), Some(0), "js {args:?}");
        let want_page = page(&live, "probe.html");
        fs::remove_file(live.join("probe.html")).expect("cleanup the JS page");
        let got = run(env!("CARGO_BIN_EXE_dfo-cli"), args);
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
        assert_eq!(
            page(&live, "probe.html"),
            want_page,
            "the page differs for {args:?}"
        );
        fs::remove_file(live.join("probe.html")).expect("cleanup");
    };
    with_home(&["probe"]);
    with_home(&["probe", "--json"]);
    with_home(&["probe", "--old"]);
    with_home(&["probe", "--old", "--json"]);

    // The no-capture message and its exit code, in an empty home. No page is written.
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
        assert!(
            !empty.join("probe.html").exists(),
            "no page without a capture"
        );
    };
    no_capture(&["probe"]);
    no_capture(&["probe", "--old"]);

    fs::remove_dir_all(&root).expect("cleanup");
    fs::remove_dir_all(&empty).expect("cleanup");
}

#[test]
fn probe_prints_the_card_without_fights_like_the_js() {
    let dir = temp_dir("nofight");
    // A version-1 capture with too few samples for one pull: the header, the "no boss health samples" line, the
    // `No fights` page section, no table.
    let empty = write_capture(
        &dir,
        "empty.json",
        r#"{"version":1,"build":"synthetic","level":45,"players":1,"samples":[],"chart":null}"#,
    );
    let html = same_text_html(&["probe", &empty], &dir);
    assert!(
        html.contains("<h2>No fights</h2>") && html.contains("No boss health samples found."),
        "the empty page has its own section"
    );
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
        assert!(!dir.join("probe.html").exists());
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
    // stack around it; the Rust front end prints the message alone, as it does for every crash). No page either way.
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
    assert!(!dir.join("probe.html").exists());

    // A page path that is a directory: the Rust CLI's create-only opener sees "already exists" and refuses with exit 2,
    // and stdout stays empty (the page write happens before anything is printed). The JS instead opens the directory and
    // fails with EISDIR: both refuse the same input, with different words (the create-only contract, module doc).
    let want = js(&["probe", &file, "--out", "."], &dir);
    let got = rust(&["probe", &file, "--out", "."], &dir);
    assert_eq!(want.status.code(), Some(2), "js page dir");
    assert_eq!(got.status.code(), Some(2), "rust page dir");
    assert!(
        String::from_utf8_lossy(&want.stderr).contains("cannot write "),
        "js: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    assert!(
        String::from_utf8_lossy(&got.stderr).contains("cannot write "),
        "rust: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert!(got.stdout.is_empty(), "no card before a failed page write");

    // Extra positionals: the JS ignores them, this slice refuses them on purpose.
    let got = rust(&["probe", &file, "extra"], &dir);
    assert_eq!(got.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&got.stderr).contains("unexpected positional argument"));

    fs::remove_dir_all(&dir).expect("cleanup");
}

/// Assert a create-only refusal: exit 2, an `EEXIST` line naming the path, no card on stdout, the file left intact.
fn assert_refused(args: &[&str], cwd: &Path, out: &Path, before: &[u8]) {
    let got = rust(args, cwd);
    assert_eq!(
        got.status.code(),
        Some(2),
        "rust {args:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    let line = String::from_utf8_lossy(&got.stderr).into_owned();
    assert!(
        line.contains("EEXIST") && line.contains(&out.to_string_lossy().into_owned()),
        "the refusal names the collision: {line}"
    );
    assert!(got.stdout.is_empty(), "no card on a refused write");
    assert_eq!(
        fs::read(out).expect("the existing file survives"),
        before,
        "the existing file was truncated by {args:?}"
    );
}

/// The page write is create-only: no existing file is truncated - not the capture, not an unrelated file, not a report,
/// not a hard/symlink/dangling alias - where the JS `writeFileSync` would truncate all of them.
#[test]
fn probe_page_write_is_create_only() {
    let dir = temp_dir("create-only");
    let text = capture(10, false);
    let file = write_capture(&dir, "capture.json", &text);

    // The capture itself, under every spelling of the same path.
    for out in [&file[..], "./capture.json", "capture.json"] {
        assert_refused(
            &["probe", "./capture.json", "--out", out],
            &dir,
            &PathBuf::from(&file),
            text.as_bytes(),
        );
    }
    let nested = dir.join("nested");
    fs::create_dir(&nested).expect("nested dir");
    assert_refused(
        &["probe", "../capture.json", "--out", "../capture.json"],
        &nested,
        &PathBuf::from(&file),
        text.as_bytes(),
    );

    // An unrelated existing file (a save-shaped fixture and a previous report) is refused and byte-identical.
    let save = dir.join("SaveData.txt");
    fs::write(&save, "a game save the CLI must never touch").expect("save fixture");
    assert_refused(
        &["probe", "capture.json", "--out", "SaveData.txt"],
        &dir,
        &save,
        b"a game save the CLI must never touch",
    );
    let report = dir.join("probe.html");
    fs::write(&report, "an older report").expect("report fixture");
    assert_refused(
        &["probe", "capture.json"],
        &dir,
        &report,
        b"an older report",
    );

    // Unix aliases: a hard link, a symlink and a dangling symlink all exist to `O_EXCL`, so all are refused.
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let hard = dir.join("hard.html");
        fs::hard_link(&file, &hard).expect("hard link fixture");
        assert_refused(
            &["probe", "capture.json", "--out", "hard.html"],
            &dir,
            &hard,
            text.as_bytes(),
        );
        assert_eq!(fs::read_to_string(&file).expect("capture survives"), text);

        let link = dir.join("link.html");
        symlink(&file, &link).expect("symlink fixture");
        assert_refused(
            &["probe", "capture.json", "--out", "link.html"],
            &dir,
            &link,
            text.as_bytes(),
        );
        assert_eq!(
            fs::read_to_string(&file).expect("the symlink target survives"),
            text
        );

        let dangling = dir.join("dangling.html");
        symlink(dir.join("never-written.html"), &dangling).expect("dangling fixture");
        let got = rust(&["probe", "capture.json", "--out", "dangling.html"], &dir);
        assert_eq!(got.status.code(), Some(2), "dangling symlink");
        assert!(
            String::from_utf8_lossy(&got.stderr).contains("EEXIST"),
            "a dangling symlink exists too: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert!(
            fs::symlink_metadata(&dangling).is_ok(),
            "the dangling symlink survives"
        );
        assert!(!dir.join("never-written.html").exists());
    }

    // What the deviation protects: the JS truncates an unrelated save and the capture itself into a page.
    let want = js(&["probe", "capture.json", "--out", "SaveData.txt"], &dir);
    assert_eq!(want.status.code(), Some(0), "js save overwrite fixture");
    assert!(
        fs::read_to_string(&save)
            .expect("the JS wrote its page")
            .starts_with("<!doctype html>"),
        "the JS overwrote the unrelated save with its page"
    );
    let want = js(&["probe", "capture.json", "--out", "capture.json"], &dir);
    assert_eq!(want.status.code(), Some(0), "js overwrite fixture");
    assert!(
        fs::read_to_string(&file)
            .expect("the JS wrote its page")
            .starts_with("<!doctype html>"),
        "the JS overwrote the capture with its page"
    );

    fs::remove_dir_all(&dir).expect("cleanup");
}

/// Capture-derived text is escaped on the page (the JS inserts it raw). The capture's own JSON is unaffected.
#[test]
fn probe_escapes_capture_derived_text_in_the_page() {
    let dir = temp_dir("escape");
    let mut text = capture(20, true);
    // The weapon and sub-phase names reach the page's raw table cells.
    text = text.replace(
        r#""name":"Test Blade""#,
        r#""name":"<b>Blade</b> & \"friends\"""#,
    );
    text = text.replace(r#""sub":"phase one""#, r#""sub":"<i>phase</i>""#);
    text = text.replace(
        r#""rows":[]"#,
        r#""rows":[{"cls":"wb-dmg-name","text":"<img src=x onerror=alert(1)>"}]"#,
    );
    let file = write_capture(&dir, "hostile.json", &text);

    let got = rust(&["probe", &file], &dir);
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    let got_html = fs::read_to_string(dir.join("probe.html")).expect("the Rust page");
    assert!(
        got_html.contains("<td>&lt;b&gt;Blade&lt;/b&gt; &amp; &quot;friends&quot;</td>"),
        "the weapon is escaped in its table cell"
    );
    assert!(
        got_html.contains("&lt;i&gt;phase&lt;/i&gt; 20.0s"),
        "the sub-phase is escaped in its table cell"
    );
    assert!(
        got_html.contains("Chart names: &lt;img src=x onerror=alert(1)&gt;."),
        "the chart name is escaped in the note"
    );
    assert!(
        !got_html.contains("<b>Blade</b>")
            && !got_html.contains("<i>phase</i>")
            && !got_html.contains("<img src=x"),
        "no capture text is inserted as markup"
    );

    // The JS inserts the same text raw, so the pages differ only there: this pins the deviation, not a parity claim.
    let want = js(&["probe", &file], &dir);
    assert_eq!(want.status.code(), Some(0), "js hostile capture");
    let want_html = fs::read_to_string(dir.join("probe.html")).expect("the JS page");
    assert!(
        want_html.contains("<td><b>Blade</b> & \"friends\"</td>")
            && want_html.contains("<img src=x onerror=alert(1)>"),
        "the JS page keeps raw markup (the deviation is real)"
    );
    // The terminal card still carries the raw text on both sides, byte for byte.
    assert_eq!(
        String::from_utf8_lossy(&got.stdout),
        String::from_utf8_lossy(&want.stdout),
        "the card is unaffected by the page escaping"
    );

    fs::remove_dir_all(&dir).expect("cleanup");
}
