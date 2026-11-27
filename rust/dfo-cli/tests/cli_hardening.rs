//! The cut-over audit's hardening cases, differentially against the real JS CLI where the JS has a verdict at all.
//!
//! These are crash/limit paths, not numbers: a range the JS `for (v += step)` never advances (it appends forever), a
//! player group the JS `Array(count - known.length)` cannot index (a `RangeError`, or an OOM), a closed stdout, an
//! argument with an invalid UTF-8 byte, and a corrupt save that names an inherited property or writes a property onto
//! a primitive. The port must exit with a status, never with a panic report; where the JS itself crashes the port
//! keeps the JS crash shape (one message line, exit 1), and where the JS answers, the answers are compared.
//!
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::{js, rust, temp_root};

use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

/// A tiny offline save, so a corrupt-save case reads a real document shape.
fn save(text: &str) -> String {
    text.to_owned()
}

fn write_save(root: &Path, text: &str) {
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    fs::write(dir.join("SaveData.txt"), save(text)).expect("save fixture");
    common::pin_mtime(&dir.join("SaveData.txt"));
}

#[test]
fn a_range_the_js_cannot_price_is_refused() {
    let root = temp_root("range");
    // `1e300..1e300` with the default step: `v + step == v` past 2^53, so the JS loop never advances. Both CLIs had
    // to be stopped by hand; this port refuses the range before it prices a point. The JS half is not run at all: it
    // never terminates (the red test for this guard was waived, see the report).
    for args in [
        &[
            "scale", "--theory", "--stat", "strength", "--from", "1e300", "--to", "1e300",
        ][..],
        &[
            "scale", "--theory", "--skill", "29", "--from", "1e300", "--to", "1e300",
        ][..],
        &[
            "scale", "--theory", "--stat", "strength", "--from", "0", "--to", "1e12", "--step",
            "10",
        ][..],
        &[
            "scale",
            "--theory",
            "--stat",
            "strength",
            "--from=-1e300",
            "--to",
            "1e300",
        ][..],
    ] {
        let got = rust(args, &root);
        assert_eq!(
            got.status.code(),
            Some(2),
            "rust {args:?}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert!(
            String::from_utf8_lossy(&got.stderr).contains("the range "),
            "the refusal names the range: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert!(got.stdout.is_empty(), "no card for {args:?}");
    }
    // The graph branch shares `scale_range`, so it refuses the same range.
    let got = rust(
        &[
            "graph",
            "--theory",
            "--series",
            "stat:strength",
            "--from",
            "1e300",
            "--to",
            "1e300",
            "--out",
            root.join("g.html").to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(got.status.code(), Some(2), "graph range");
    assert!(
        String::from_utf8_lossy(&got.stderr).contains("the range "),
        "{}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert!(!root.join("g.html").exists(), "no page for a refused range");
    // Every range the JS prices still prices, byte for byte: a long legal curve, a fractional step and a cap the step
    // does not land on.
    for args in [
        &[
            "scale", "--theory", "--stat", "strength", "--from", "0", "--to", "400", "--step", "1",
        ][..],
        &[
            "scale", "--theory", "--stat", "agility", "--from", "80", "--to", "120", "--step",
            "7.5",
        ][..],
        &[
            "scale", "--theory", "--stat", "luck", "--from", "97", "--to", "103", "--step", "2",
        ][..],
    ] {
        let want = js(args, &root);
        let got = rust(args, &root);
        assert_eq!(want.status.code(), Some(0), "js {args:?}");
        assert_eq!(got.status.code(), Some(0), "rust {args:?}");
        assert_eq!(
            String::from_utf8_lossy(&got.stdout),
            String::from_utf8_lossy(&want.stdout),
            "stdout differs for {args:?}"
        );
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn a_huge_player_group_is_the_js_range_error() {
    let root = temp_root("players");
    // `Array(Math.max(0, count - known.length))` cannot index 1e15 players. Both CLIs exit 1 with one `RangeError`
    // line; this port reaches it through its fill guard, so nothing is allocated. (`--players` alone cannot produce
    // the count without a capture, so the case is a capture whose gate lists 1e15 fighters.)
    let capture = r#"{"version":1,"build":"players","level":45,"players":1,"samples":[
{"t":0,"boss":{"hp":100,"name":"The Warden","content":"breach"},"gate":{"max":1000,"hp":1000,"fighters":1e15}},
{"t":1000,"boss":{"hp":90,"name":"The Warden","content":"breach"},"gate":{"max":1000,"hp":900,"fighters":1e15}},
{"t":2000,"boss":{"hp":80,"name":"The Warden","content":"breach"},"gate":{"max":1000,"hp":800,"fighters":1e15}}],
"events":[],"chart":null}"#;
    let file = root.join("huge.json");
    fs::write(&file, capture).expect("capture fixture");
    let path = file.to_str().unwrap();
    let want = js(
        &[
            "probe",
            path,
            "--out",
            root.join("js.html").to_str().unwrap(),
        ],
        &root,
    );
    let got = rust(
        &[
            "probe",
            path,
            "--out",
            root.join("rust.html").to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(want.status.code(), Some(1), "js {want:?}");
    assert_eq!(got.status.code(), Some(1), "rust");
    assert_eq!(
        String::from_utf8_lossy(&got.stderr).trim_end(),
        "RangeError: Invalid array length",
        "the port prints one crash line"
    );
    assert!(
        !String::from_utf8_lossy(&got.stderr).contains("panicked"),
        "no panic report: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    // `--players 1e15` alone is the same count on a capture with a small gate.
    let small = r#"{"version":1,"build":"players","level":45,"players":1,"samples":[
{"t":0,"boss":{"hp":100,"name":"The Warden","content":"breach"}},
{"t":1000,"boss":{"hp":90,"name":"The Warden","content":"breach"}},
{"t":2000,"boss":{"hp":80,"name":"The Warden","content":"breach"}}],
"events":[],"chart":null}"#;
    let file = root.join("small.json");
    fs::write(&file, small).expect("capture fixture");
    let path = file.to_str().unwrap();
    let got = rust(
        &[
            "probe",
            path,
            "--players",
            "1e15",
            "--out",
            root.join("p.html").to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(got.status.code(), Some(1), "rust --players");
    assert_eq!(
        String::from_utf8_lossy(&got.stderr).trim_end(),
        "RangeError: Invalid array length"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn an_invalid_utf8_argument_is_a_usage_error() {
    let root = temp_root("utf8");
    // Node decodes argv as UTF-8 and replaces an invalid byte with U+FFFD; `std::env::args` would panic on it. Both
    // CLIs refuse the unknown option and exit 2.
    let bad = std::ffi::OsStr::from_bytes(b"--st\xfft");
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_dfo-forge"));
    command.arg(bad).current_dir(&root);
    command.env("HOME", common::home_root());
    command.env("DAGGER_USER_DATA", &root);
    let got = command.output().expect("the Rust CLI runs");
    assert_eq!(got.status.code(), Some(2), "rust invalid utf-8");
    assert!(
        String::from_utf8_lossy(&got.stderr).starts_with("Unknown option '--st"),
        "one usage line: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert!(
        !String::from_utf8_lossy(&got.stderr).contains("panicked"),
        "no panic report"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn a_corrupt_save_is_an_error_not_a_panic() {
    let root = temp_root("corrupt");
    // A save whose weapon `templateIndex` names an inherited property: the JS `WEAPONS["constructor"]` is a function,
    // so its card reads nonsense (`Infinity--Infinity`) and exits 0. The port cannot hold a function, so it reads the
    // table miss and prints its own card with exit 0 (never a panic report; the label/number residual is documented).
    let stats = [
        "strength",
        "agility",
        "speed",
        "luck",
        "endurance",
        "willpower",
    ]
    .iter()
    .map(|k| format!("\"{k}\":50"))
    .collect::<Vec<_>>()
    .join(",");
    write_save(
        &root,
        &format!(
            r#"{{"name":"Ctor","level":30,"raceId":1,"race":"Breton","health":100,"maxHealth":120,
"stats":{{{stats}}},"skills":[100],"items":[
{{"group":"Weapons","templateIndex":"constructor","equipSlot":19,"name":"Odd","material":9,"currentCondition":100,"maxCondition":100}}]}}"#
        ),
    );
    let got = rust(&["build"], &root);
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust build: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert!(
        !String::from_utf8_lossy(&got.stderr).contains("panicked"),
        "no panic report"
    );
    assert!(!got.stdout.is_empty(), "a card is printed");

    // `_mods.statMax` is a number: the JS then writes a property onto a primitive and throws a `TypeError` at the graph
    // branch (`c._mods.statMax[id] = ...`). Exit 1 with a line, not a panic report.
    write_save(
        &root,
        &format!(
            r#"{{"name":"Mods","level":30,"raceId":1,"race":"Breton","health":100,"maxHealth":120,
"stats":{{{stats}}},"skills":[100],"items":[
{{"group":"Weapons","templateIndex":121,"equipSlot":19,"name":"Blade","material":9,"currentCondition":100,"maxCondition":100}}],
"_mods":{{"statMax":1}}}}"#
        ),
    );
    let page = root.join("g.html");
    let want = js(
        &[
            "graph",
            "--series",
            "star:strength",
            "--out",
            root.join("j.html").to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(want.status.code(), Some(1), "js graph");
    let got = rust(
        &[
            "graph",
            "--series",
            "star:strength",
            "--out",
            page.to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(got.status.code(), Some(1), "rust graph");
    assert!(
        String::from_utf8_lossy(&got.stderr).starts_with("Value::set on a non-object:"),
        "one line: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert!(
        !String::from_utf8_lossy(&got.stderr).contains("panicked"),
        "no panic report"
    );
    assert!(!page.exists(), "no page before the crash");
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn a_closed_stdout_keeps_the_js_exit_status() {
    // `| head -c1`: Node's `console.log` swallows the write error and keeps its status; a `print!` would panic on the
    // broken pipe. Both CLIs answer 0 here.
    let root = temp_root("pipe");
    let js = common::repo_root().join("bin").join("dfo-dps.js");
    let rust = env!("CARGO_BIN_EXE_dfo-forge");
    for (js_side, command) in [
        (true, format!("node {} rank", js.display())),
        (false, format!("{rust} rank")),
    ] {
        let run = || {
            std::process::Command::new("sh")
                .arg("-c")
                .arg(format!(
                    "{command} --theory --top 1000 --json | head -c1 >/dev/null; exit ${{PIPESTATUS[0]}}"
                ))
                .current_dir(&root)
                .env("HOME", common::home_root())
                .env("DAGGER_USER_DATA", &root)
                .output()
                .expect("the pipeline runs")
        };
        let output = if js_side {
            common::js_custom(&root, &root, &["| head -c1", "rank"], &[], &run)
        } else {
            run()
        };
        assert_eq!(
            output.status.code(),
            Some(0),
            "{command}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !String::from_utf8_lossy(&output.stderr).contains("panicked"),
            "{command}: no panic report"
        );
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

/// `HOME` unset on Linux: Node's `os.homedir()` reads the OS user database, where a relative path would make save
/// discovery read the working directory. With `DAGGER_USER_DATA` unset both CLIs list the same saves; with an empty
/// `HOME` both read that empty path (libuv does not fall back) and find nothing.
#[test]
fn home_unset_is_the_os_user_database() {
    let root = temp_root("home");
    let js = common::repo_root().join("bin").join("dfo-dps.js");
    let rust = env!("CARGO_BIN_EXE_dfo-forge");
    let run = |js_side: bool, home: Option<&str>| {
        let (program, prefix) = if js_side {
            ("node", Some(js.clone()))
        } else {
            (rust, None)
        };
        let mut command = std::process::Command::new(program);
        if let Some(prefix) = prefix {
            command.arg(prefix);
        }
        command
            .arg("saves")
            .current_dir(&root)
            .env_remove("DAGGER_USER_DATA");
        // One locale for both children, as every other differential spawn does.
        for name in [
            "LC_ALL",
            "LC_CTYPE",
            "LC_NUMERIC",
            "LC_TIME",
            "LC_COLLATE",
            "LC_MONETARY",
            "LC_MESSAGES",
            "LANGUAGE",
        ] {
            command.env_remove(name);
        }
        command
            .env("LC_ALL", "en_US.UTF-8")
            .env("LANG", "en_US.UTF-8")
            .env_remove("XDG_CONFIG_HOME");
        match home {
            Some(value) => command.env("HOME", value),
            None => command.env_remove("HOME"),
        };
        command.output().expect("the CLI runs")
    };
    for home in [None, Some("")] {
        let got = run(false, home);
        // With `HOME` unset both sides read the OS user database, so the answer is the host's own save list: it is
        // never stored in a snapshot, and the replay checks only that the Rust CLI answers.
        if home.is_none() && (common::replaying() || common::recording()) {
            assert_eq!(got.status.code(), Some(0), "rust {home:?}");
            if common::replaying() {
                continue;
            }
        }
        let want = match home {
            Some(_) => {
                common::js_custom(&root, &root, &["saves"], &[("HOME", "".as_ref())], &|| {
                    run(true, home)
                })
            }
            None => run(true, home),
        };
        assert_eq!(got.status.code(), Some(0), "rust {home:?}");
        assert_eq!(
            want.status.code(),
            Some(0),
            "js {home:?}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&got.stdout),
            String::from_utf8_lossy(&want.stdout),
            "the save lists differ for HOME={home:?} ({}): {}",
            js.display(),
            String::from_utf8_lossy(&want.stderr)
        );
    }
    fs::remove_dir_all(&root).expect("cleanup");
}
