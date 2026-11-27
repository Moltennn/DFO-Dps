//! Save and capture text: the decode edges the JS `JSON.parse` accepts and a strict reader refused.
//!
//! Node decodes a file as UTF-8 with replacement (an invalid byte is U+FFFD) and `JSON.parse` keeps an unpaired
//! surrogate escape as a lone UTF-16 unit. `serde_json` refused both, so a save the JS loads made this CLI exit 2. The
//! port now decodes lossily and replaces unpaired surrogate escapes, and every case here is a differential against the
//! real JS CLI: the *load* must succeed on both, and every other byte of the card must match. A lone surrogate itself
//! prints as U+FFFD here where the JS prints the raw unit, the one residual difference (rust/README.md).
//!
//! The malformed-record cases are the other direction: the JS throws on some of them and the port stays lenient. Those
//! are documented known differences with a pinning case, not a differential.
//!
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::{js, pin_mtime, rust, temp_root};

use std::fs;
use std::path::Path;

/// A save folder whose `SaveData.txt` is the given raw bytes (a lone surrogate and an invalid byte are not valid UTF-8
/// text, so the bytes are written, not a `&str`).
fn write_raw_save(root: &Path, bytes: &[u8]) {
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    let file = dir.join("SaveData.txt");
    fs::write(&file, bytes).expect("save fixture");
    pin_mtime(&file);
}

fn write_save(root: &Path, text: &str) {
    write_raw_save(root, text.as_bytes());
}

/// The save folder's path as text, owned so a borrowed argument array may outlive the temporary.
fn save_arg(root: &Path) -> String {
    root.join("Saves/SAVE1")
        .to_str()
        .expect("utf-8 path")
        .to_owned()
}

fn stats() -> String {
    [
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
    .join(",")
}

/// The reference save around one raw `name` value, so a byte-level text case can carry escape sequences verbatim.
fn save_with_name(name_json: &str) -> String {
    format!(
        r#"{{"name":{name_json},"level":30,"raceId":1,"race":"Breton","health":100,"maxHealth":120,
"stats":{{{}}},"skills":[100],"items":[
{{"group":"Weapons","templateIndex":121,"equipSlot":19,"name":"Blade","material":9,"currentCondition":100,"maxCondition":100}}]}}"#,
        stats()
    )
}

/// Both CLIs load the save; the Rust card matches the JS card except for the surrogate itself. The JS writes the lone
/// unit as the escape `\ud83d`, so the comparison rewrites that exact escape to U+FFFD on the JS side.
fn same_loading_except(name_json: &str, js_escape: Option<&str>) {
    let root = temp_root("json-edge");
    write_save(&root, &save_with_name(name_json));
    let save = save_arg(&root);
    let args = ["build", "--save", save.as_str(), "--json"];
    let want = js(&args, &root);
    let got = rust(&args, &root);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js loads: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust loads: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    let want_text = String::from_utf8(want.stdout).expect("js stdout is utf-8");
    let got_text = String::from_utf8(got.stdout).expect("rust stdout is utf-8");
    let want_text = match js_escape {
        Some(escape) => want_text.replace(escape, "\u{FFFD}"),
        None => want_text,
    };
    assert_eq!(
        want_text, got_text,
        "the card matches but for the surrogate"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn a_lone_surrogate_escape_loads_on_both_sides() {
    // `"Bob\ud83d"`: an unpaired high surrogate, kept as a lone UTF-16 unit by JSON.parse.
    same_loading_except(r#""Bob\ud83d""#, Some("\\ud83d"));
}

#[test]
fn a_pair_and_an_escaped_backslash_are_untouched() {
    // `"\ud83d\ude00"` is one astral character, identical on both sides: no substitution.
    same_loading_except(r#""\ud83d\ude00""#, None);
    // `"\\ud800"` is the TEN literal characters `\ud800`, not an escape: identical on both sides.
    same_loading_except(r#""\\ud800""#, None);
}

#[test]
fn an_invalid_utf8_byte_decodes_lossily() {
    let root = temp_root("json-utf8");
    let mut bytes = save_with_name(r#""Bob""#).into_bytes();
    // Replace the `b` of `Bob` with an invalid UTF-8 byte: Node substitutes U+FFFD in the name.
    let at = bytes
        .windows(3)
        .position(|w| w == b"Bob")
        .expect("fixture name");
    bytes[at + 1] = 0xff;
    write_raw_save(&root, &bytes);
    let save = save_arg(&root);
    let args = ["build", "--save", save.as_str(), "--json"];
    let want = js(&args, &root);
    let got = rust(&args, &root);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js loads: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust loads: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(want.stdout, got.stdout, "U+FFFD on both sides");
    fs::remove_dir_all(&root).expect("cleanup");
}

/// A `SaveInfo.txt` whose name carries a lone surrogate escape loads (the JS reads it; the port used to refuse it).
#[test]
fn a_saveinfo_lone_surrogate_escape_loads() {
    let root = temp_root("json-info");
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    fs::write(dir.join("SaveData.txt"), save_with_name(r#""Blade""#)).expect("save");
    pin_mtime(&dir.join("SaveData.txt"));
    let info = dir.join("SaveInfo.txt");
    fs::write(
        &info,
        "{\"saveName\":\"Bob\\ud83d\",\"characterName\":\"Al\\ud83d\"}",
    )
    .expect("info");
    pin_mtime(&info);
    let want = js(&["saves"], &root);
    let got = rust(&["saves"], &root);
    assert_eq!(want.status.code(), Some(0), "js saves");
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust saves: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    let want_text = String::from_utf8(want.stdout)
        .unwrap()
        .replace("\\ud83d", "\u{FFFD}");
    assert_eq!(want_text, String::from_utf8(got.stdout).unwrap());
    fs::remove_dir_all(&root).expect("cleanup");
}

/// A `config.json` whose `arena2Path` carries a lone surrogate escape is still read (the JS `JSON.parse` accepts it).
#[test]
fn a_config_lone_surrogate_escape_is_read() {
    let root = temp_root("json-config");
    let config = root.join("config.json");
    fs::write(&config, "{\"arena2Path\":\"/nonexistent/\\ud83d\"}").expect("config");
    pin_mtime(&config);
    write_save(&root, &save_with_name(r#""Blade""#));
    // Both fall back to the empty spellbook (the path does not exist); the card and the exit code must match.
    let save = save_arg(&root);
    let args = ["build", "--save", save.as_str()];
    let want = js(&args, &root);
    let got = rust(&args, &root);
    assert_eq!(want.status.code(), Some(0), "js build");
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust build: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(want.stdout, got.stdout);
    fs::remove_dir_all(&root).expect("cleanup");
}

/// A capture with a lone surrogate escape loads; the port used to refuse the file (exit 2).
#[test]
fn a_capture_lone_surrogate_escape_loads() {
    let root = temp_root("json-capture");
    let capture = root.join("capture.json");
    fs::write(
        &capture,
        r#"{"version":1,"build":"players","level":45,"players":1,"samples":[
{"t":0,"boss":{"hp":100,"name":"The Warden\ud83d","content":"breach"}},
{"t":1000,"boss":{"hp":90,"name":"The Warden\ud83d","content":"breach"}}],
"events":[],"chart":null}"#,
    )
    .expect("capture");
    pin_mtime(&capture);
    let page = root.join("p.html");
    let args = [
        "probe",
        capture.to_str().unwrap(),
        "--out",
        page.to_str().unwrap(),
    ];
    let got = rust(&args, &root);
    // The JS prints its card; the port's page is create-only, so the capture path is only checked for "not refused".
    assert!(
        !String::from_utf8_lossy(&got.stderr).contains("cannot read"),
        "the port reads the capture: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_ne!(got.status.code(), Some(2), "not a read refusal");
    fs::remove_dir_all(&root).expect("cleanup");
}

/// KNOWN DIFFERENCE (rust/README.md): the JS THROWS on these malformed records and the port stays lenient. Each case is
/// pinned here so the divergence is a decision, not an accident: the port must exit 0 and print its card.
#[test]
fn malformed_records_the_js_throws_on_stay_lenient() {
    let root = temp_root("json-lenient");
    let cases = [
        // `effects: [null]` - the JS `e.type` read throws; the port skips the null entry.
        (
            r#"{"group":"Weapons","templateIndex":121,"equipSlot":19,"name":"Blade","material":9,"currentCondition":100,"maxCondition":100,"enchantments":[{"type":20,"param":0,"effects":[null]}]}"#,
            "effects null",
        ),
        // A non-array `enchantments` - the JS `.map` throws; the port reads it as absent.
        (
            r#"{"group":"Weapons","templateIndex":121,"equipSlot":19,"name":"Blade","material":9,"currentCondition":100,"maxCondition":100,"enchantments":"x"}"#,
            "enchantments string",
        ),
    ];
    for (item, label) in cases {
        let save = format!(
            r#"{{"name":"Lenient","level":30,"raceId":1,"race":"Breton","health":100,"maxHealth":120,
"stats":{{{}}},"skills":[100],"items":[{}]}}"#,
            stats(),
            item
        );
        write_save(&root, &save);
        let save = save_arg(&root);
        let got = rust(&["build", "--save", save.as_str()], &root);
        assert_eq!(
            got.status.code(),
            Some(0),
            "{label}: the port stays lenient: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        assert!(!got.stdout.is_empty(), "{label}: the port prints a card");
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

/// A save that is a JSON array (not an object) still loads on both sides (the port accepts `Obj | Arr`).
#[test]
fn an_array_save_is_not_a_read_refusal() {
    let root = temp_root("json-array");
    write_save(&root, "[]");
    let got = rust(&["saves"], &root);
    assert_eq!(got.status.code(), Some(0), "saves lists it");
    fs::remove_dir_all(&root).expect("cleanup");
}

/// The odd save shapes a code read named, each against the live JS: a truthy non-object `_mods`/`_enchantMods`, an array
/// `_mods.stats`, a non-array `activeEffects`, `spells` entries that are null/string/array, a string `masteredSkills`, and
/// the whole save as an array. `build --json` must match byte for byte.
#[test]
fn the_odd_save_shapes_build_like_the_js() {
    let root = temp_root("json-shapes");
    let head = r#"{"name":"Shapes","level":30,"raceId":1,"race":"Breton","health":100,"maxHealth":120,
"stats":{"strength":50,"agility":50,"speed":50,"luck":50,"endurance":50,"willpower":50},
"skills":[40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74],
"items":[{"group":"Weapons","templateIndex":121,"equipSlot":19,"name":"Blade","material":9,"currentCondition":100,"maxCondition":100}]"#;
    let shapes = [
        (r#","_mods":"x"}"#, "truthy string _mods"),
        (r#","_mods":["a"]}"#, "array _mods"),
        (r#","_enchantMods":7}"#, "numeric _enchantMods"),
        (
            r#","_mods":{"stats":[1,2],"skills":"x"}}"#,
            "array _mods.stats, string skills",
        ),
        (r#","activeEffects":"x"}"#, "string activeEffects"),
        (r#","activeEffects":{"a":1}}"#, "object activeEffects"),
        (
            r#","spells":[null,"x",[1,2],{"name":"C","effects":[{"type":4,"subType":0,"magnitudeBaseLow":5,"magnitudeBaseHigh":5,"magnitudeLevelBase":0,"magnitudeLevelHigh":0,"magnitudePerLevel":1}]}]}"#,
            "spells null/string/array/record",
        ),
        (r#","masteredSkills":"29"}"#, "string masteredSkills"),
        (r#","masteredSkills":null}"#, "null masteredSkills"),
    ];
    let save = save_arg(&root);
    for (text, label) in shapes {
        // The whole save as text plus the shape's own tail; validity is the JS's to decide.
        write_save(&root, &format!("{head}{text}"));
        let want = js(&["build", "--save", save.as_str(), "--json"], &root);
        let got = rust(&["build", "--save", save.as_str(), "--json"], &root);
        assert_eq!(
            want.status.code(),
            got.status.code(),
            "{label}: exit codes differ (js {} / rust {}): js stderr {} / rust stderr {}",
            want.status.code().unwrap_or(-1),
            got.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&want.stderr),
            String::from_utf8_lossy(&got.stderr)
        );
        if want.status.code() == Some(0) {
            assert_eq!(
                want.stdout,
                got.stdout,
                "{label}: stdout differs: js {} / rust {}",
                String::from_utf8_lossy(&want.stderr),
                String::from_utf8_lossy(&got.stderr)
            );
        }
    }
    // The whole save as a bare array: both build the level-1 nobody.
    write_save(&root, "[]");
    let want = js(&["build", "--save", save.as_str(), "--json"], &root);
    let got = rust(&["build", "--save", save.as_str(), "--json"], &root);
    assert_eq!(want.status.code(), got.status.code(), "array save exit");
    assert_eq!(want.stdout, got.stdout, "array save card");
    fs::remove_dir_all(&root).expect("cleanup");
}

/// The enumeration limit without a gear add (`--blow-x` at a huge value is the JS `RangeError`): both exit with the same
/// code and the same one-line message, and the port never allocates.
#[test]
fn the_enumeration_limit_is_the_js_range_error() {
    let root = temp_root("json-limit");
    // `--blow-x` scales the enumerated gear adds; a value past the JS's array-length ceiling is its own RangeError.
    for value in ["100000000", "1e12"] {
        let want = js(&["build", "--theory", "--blow-x", value], &root);
        let got = rust(&["build", "--theory", "--blow-x", value], &root);
        assert_eq!(
            want.status.code(),
            got.status.code(),
            "--blow-x {value}: exit (js {} / rust {})",
            want.status.code().unwrap_or(-1),
            got.status.code().unwrap_or(-1)
        );
        let want_line = String::from_utf8_lossy(&want.stderr)
            .lines()
            .next()
            .unwrap_or("")
            .to_owned();
        let got_line = String::from_utf8_lossy(&got.stderr)
            .lines()
            .next()
            .unwrap_or("")
            .to_owned();
        assert_eq!(
            want_line, got_line,
            "--blow-x {value}: the one-line message"
        );
    }
    fs::remove_dir_all(&root).expect("cleanup");
}
