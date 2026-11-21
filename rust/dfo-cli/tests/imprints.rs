//! The R8 `imprints` card and page, differentially against the REAL JS CLI.
//!
//! Each case runs `bin/dfo-dps.js imprints ...`, reads its stdout and its written page, and compares both byte for byte
//! with [`imprints::text`] and [`imprints::page`] over the rows `dfo_core::imprints::rank_all` returns (already pinned
//! by `dfo_core/tests/imprints.rs`). The real CLI computes every family per run (`rankAll`, then the `--family` filter),
//! so each case is one `rank_all` call on the Rust side too.
//!
//! The JS branch (`src/cli.js:1219-1263`) is not exported, so this pins the real rows' rendering (formats, table widths,
//! bar charts and page shell), not hostile captions; `tests/cli_imprints.rs` pins the whole command around it,
//! including the `--json` document and the create-only writer. A missing `node` panics rather than skips: a skipped
//! differential proves nothing.

#[path = "../src/graph.rs"]
#[allow(dead_code)]
mod graph;
#[path = "../src/imprints.rs"]
mod imprints;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

use dfo_core::imprints::rank_all;
use dfo_core::maxprofile::Profiles;
use dfo_core::spells::Spellbook;
use dfo_core::value::Value::{self, Bool, Obj, Str};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// One case: the flags the JS CLI receives, plus the already-resolved options the JS branch reads.
struct Case {
    args: Vec<&'static str>,
    label: &'static str,
    firmament: bool,
    sort: &'static str,
    /// `--family`'s key, applied after `rank_all` as `src/cli.js:1226-1228` filters.
    family: Option<&'static str>,
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            args: vec!["imprints"],
            label: "every family, default boss order",
            firmament: false,
            sort: "boss",
            family: None,
        },
        Case {
            args: vec!["imprints", "--sort", "uncapped"],
            label: "every family, uncapped order",
            firmament: false,
            sort: "uncapped",
            family: None,
        },
        Case {
            args: vec!["imprints", "--firmament", "--sort", "conditional"],
            label: "every family, +Firmament, trigger order",
            firmament: true,
            sort: "conditional",
            family: None,
        },
        Case {
            args: vec!["imprints", "--family", "Archery", "--sort", "uncapped"],
            label: "the Archery family only",
            firmament: false,
            sort: "uncapped",
            family: Some("Archery"),
        },
    ]
}

fn temp_root(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "dfo-cli-imprints-{label}-{}-{n}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("Saves")).expect("temp fixture root");
    root
}

fn js(args: &[&str], out: &Path, root: &Path) -> Output {
    Command::new("node")
        .env("LC_ALL", "en_US.UTF-8")
        .env("LANG", "en_US.UTF-8")
        .env("DAGGER_USER_DATA", root)
        .arg(repo_root().join("bin").join("dfo-dps.js"))
        .args(args)
        .arg("--out")
        .arg(out)
        .current_dir(repo_root())
        .output()
        .expect("the JS CLI runs (this repository's Node project)")
}

/// The JS branch's `rankAll({ firmament, vampire, sort })` options.
fn options(firmament: bool, sort: &str) -> Value {
    let mut out = Obj(vec![]);
    out.set("firmament", Bool(firmament));
    out.set("vampire", Bool(false));
    out.set("sort", Str(sort.to_owned()));
    out
}

fn diff(label: &str, got: &[u8], want: &[u8]) {
    if got == want {
        return;
    }
    let at = got
        .iter()
        .zip(want)
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| got.len().min(want.len()));
    let from = at.saturating_sub(120);
    panic!(
        "{label} differs at byte {at} (lens {} vs {}):\nrust: {:?}\njs:   {:?}",
        got.len(),
        want.len(),
        String::from_utf8_lossy(&got[from..(at + 200).min(got.len())]),
        String::from_utf8_lossy(&want[from..(at + 200).min(want.len())]),
    );
}

#[test]
fn renders_the_imprints_card_and_page_like_the_js() {
    let book = Spellbook::default();
    for (i, case) in cases().iter().enumerate() {
        let root = temp_root(&format!("{i}"));
        let out = root.join("imprints.html");
        let want = js(&case.args, &out, &root);
        assert_eq!(
            want.status.code(),
            Some(0),
            "js {}: {}",
            case.args.join(" "),
            String::from_utf8_lossy(&want.stderr)
        );
        let want_page = fs::read(&out).expect("the JS CLI wrote its imprints page");
        let _ = fs::remove_dir_all(&root);

        let mut profiles = Profiles::new(&book);
        let ranked = rank_all(&options(case.firmament, case.sort), &mut profiles)
            .expect("the core ranks every imprint family");
        // `src/cli.js:1226-1228`: `rankAll(...)` then `.filter((f) => f.key === family.key)`.
        let rows = Value::Arr(
            ranked
                .items()
                .iter()
                .filter(|f| {
                    case.family
                        .is_none_or(|key| f.get("key").to_js_string() == key)
                })
                .cloned()
                .collect(),
        );
        let got_stdout = format!(
            "{}imprints page written: {}\n",
            imprints::text(&rows),
            out.to_string_lossy()
        );
        diff(
            &format!("{}: stdout", case.label),
            got_stdout.as_bytes(),
            &want.stdout,
        );
        let got_page = imprints::page(&rows, case.firmament, case.sort);
        diff(
            &format!("{}: page", case.label),
            got_page.as_bytes(),
            &want_page,
        );
    }
}

#[test]
fn text_formats_and_table_widths_are_the_js_ones() {
    // Local invariants for the helpers the differential cannot isolate (the JS branch is not exported).
    assert_eq!(imprints::fmt(0.0), "0.0");
    assert_eq!(imprints::fmt(-0.0), "0.0");
    assert_eq!(imprints::fmt(0.125), "0.1");
    assert_eq!(imprints::fmt(0.15), "0.2");
    assert_eq!(imprints::fmt(1234.56), "1234.6");
    assert_eq!(imprints::fmt(1e21), "1e+21");
    assert_eq!(imprints::fmt(f64::NAN), "-");
    // `table` measures UTF-16 code units, as the JS `length`/`padStart` do.
    assert_eq!(
        imprints::table(
            &[vec!["😀".to_owned(), "x".to_owned()]],
            &["A", "B"],
            &[false, false],
        ),
        "A   B\n-   -\n😀  x"
    );
}
