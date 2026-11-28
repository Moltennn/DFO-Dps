//! The JS-oracle cache key and entry handling, without a CLI spawn where none is needed.
//!
//! The key covers `bin/`, `src/`, `vendor/` and `package.json` under the JS tree, the node version, the argv, cwd,
//! the child env, stdin and every entry of the fixture root. This test copies those trees once, points
//! `DFO_ORACLE_JS_ROOT` at the copy, and asserts one byte in each input moves the key (a cache miss) while a `rust/`,
//! `test/`, `.cache/firmament-plans.json` or `DFO_ORACLE_*` change does not.
//!
//! It also proves the safety net and the entry format: a scratch JS program whose input is outside every hashed tree is
//! caught by spot 1.0; a corrupt, truncated or swapped entry runs live and is rewritten; and two concurrent writers on
//! one key leave one valid entry. Everything the test spawns is `node -e` (the cache's `js_batch`), never the CLI.
//!
//! One test function, and `#[ignore]`d: the cache reads process-global `DFO_ORACLE_*` variables, so parallel `#[test]`s
//! would race, and it needs the live JavaScript (`DFO_ORACLE=live cargo test -p dfo-cli --test oracle_key -- --ignored`).

mod common;

use common::{js_batch, oracle_key, repo_root};

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

/// A fixed epoch (2023-11-14) for every fixture file: an old mtime is what makes a fixture cacheable.
const PINNED: u64 = 1_700_000_000;

fn scratch(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "dfo-oracle-key-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("scratch dir");
    path
}

fn pin(path: &Path) {
    fs::File::options()
        .write(true)
        .open(path)
        .expect("fixture opens")
        .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(PINNED))
        .expect("pinned mtime");
}

fn write_pinned(path: &Path, body: impl AsRef<[u8]>) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("fixture parent");
    }
    fs::write(path, body).expect("fixture file");
    pin(path);
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("copy dir");
    for entry in fs::read_dir(from).expect("read tree") {
        let entry = entry.expect("tree entry");
        let target = to.join(entry.file_name());
        let meta = fs::symlink_metadata(entry.path()).expect("tree metadata");
        if meta.is_dir() {
            copy_dir(&entry.path(), &target);
        } else if meta.is_file() {
            fs::copy(entry.path(), &target).expect("copy file");
        }
    }
}

/// The JS tree the key hashes: `bin/`, `src/`, `vendor/` and `package.json`, as a private copy.
fn copied_js_tree(base: &Path) -> PathBuf {
    let tree = base.join("js");
    for top in ["bin", "src", "vendor"] {
        copy_dir(&repo_root().join(top), &tree.join(top));
    }
    fs::create_dir_all(&tree).expect("tree root");
    fs::copy(repo_root().join("package.json"), tree.join("package.json")).expect("package.json");
    tree
}

/// A fixture root carrying the launcher config, its `SPELLS.STD` and one save, all with pinned mtimes.
fn fixture(base: &Path) -> PathBuf {
    let root = base.join("root");
    write_pinned(
        &root.join("Saves").join("SAVE1").join("SaveData.txt"),
        r#"{"name":"Key","level":1,"raceId":1,"race":"Breton","health":10,"maxHealth":10,"stats":{"strength":10},"skills":[],"items":[]}"#,
    );
    write_pinned(
        &root.join("config.json"),
        format!(r#"{{"arena2Path":{:?}}}"#, root.join("arena2")),
    );
    write_pinned(&root.join("arena2").join("SPELLS.STD"), "spells-v1");
    root
}

/// One call's key: the same argv, root and env unless the test is mutating that field.
fn key(root: &Path, extra_env: &[(&str, &OsStr)], stdin: Option<&[u8]>) -> String {
    let mut env = vec![("DAGGER_USER_DATA", root.as_os_str())];
    env.extend_from_slice(extra_env);
    oracle_key(
        &repo_root(),
        Some(root),
        &["rank", "--theory", "--json"],
        &env,
        stdin,
    )
    .0
}

fn base_key(root: &Path) -> String {
    key(root, &[], None)
}

fn assert_miss(name: &str, base: &str, changed: &str) {
    assert_ne!(base, changed, "{name} must move the key (a cache miss)");
}

fn restore(path: &Path, body: &[u8]) {
    fs::write(path, body).expect("restore file");
    pin(path);
}

/// Part 1: every hashed input moves the key; the excluded trees and the `DFO_ORACLE_*` knobs do not.
fn key_covers_every_input(tree: &Path, root: &Path) {
    let base = base_key(root);
    let verdict = oracle_key(
        &repo_root(),
        Some(root),
        &["rank", "--theory", "--json"],
        &[("DAGGER_USER_DATA", root.as_os_str())],
        None,
    )
    .1;
    assert_eq!(verdict, "cacheable", "the pinned fixture is readable");

    let flip = |path: &Path, original: &[u8]| {
        let mut bytes = original.to_vec();
        bytes[0] ^= 0x01;
        fs::write(path, bytes).expect("flipped file");
    };
    let src = tree.join("src").join("usageError.js");
    let vendor = tree.join("vendor").join("upstream").join("README.md");
    let package = tree.join("package.json");
    let spells = root.join("arena2").join("SPELLS.STD");
    let config = root.join("config.json");
    let save = root.join("Saves").join("SAVE1").join("SaveData.txt");
    let cases: [(&str, PathBuf); 7] = [
        ("a bin file", tree.join("bin").join("dfo-dps.js")),
        ("a src file", src.clone()),
        ("a vendor file", vendor.clone()),
        ("package.json", package.clone()),
        ("the fixture SPELLS.STD", spells.clone()),
        ("the launcher config.json", config.clone()),
        ("a save", save.clone()),
    ];
    for (name, path) in cases {
        let original = fs::read(&path).expect("input file");
        // A comment append for the JS trees (so the change is one byte even in a comment), a flip for the rest.
        if path == src || path == vendor {
            let mut changed = original.clone();
            changed.extend_from_slice(b"\n// scratch\n");
            fs::write(&path, &changed).expect("append comment");
        } else {
            flip(&path, &original);
        }
        let moved = base_key(root);
        restore(&path, &original);
        assert_miss(name, &base, &moved);
        assert_eq!(base, base_key(root), "{name}: undo restores the key");
    }

    // The fields outside the fixture root: the child env, an argv token and stdin.
    assert_miss(
        "LANG",
        &base,
        &key(root, &[("LANG", OsStr::new("fi_FI.UTF-8"))], None),
    );
    assert_miss(
        "an argv token",
        &base,
        &oracle_key(
            &repo_root(),
            Some(root),
            &["rank", "--theory"],
            &[("DAGGER_USER_DATA", root.as_os_str())],
            None,
        )
        .0,
    );
    assert_miss("a stdin byte", &base, &key(root, &[], Some(b"x")));

    // Excluded on purpose: the port, the JS tests, the firmament plan cache and the cache's own knobs.
    fs::create_dir_all(tree.join("rust").join("dfo-core")).expect("rust tree");
    fs::write(tree.join("rust").join("dfo-core").join("scratch.txt"), "x").expect("rust scratch");
    fs::create_dir_all(tree.join("test").join("harness")).expect("test tree");
    fs::write(tree.join("test").join("harness").join("scratch.js"), "x").expect("test scratch");
    fs::create_dir_all(tree.join(".cache")).expect("plan cache dir");
    fs::write(tree.join(".cache").join("firmament-plans.json"), "{}").expect("plan cache");
    assert_eq!(
        base,
        base_key(root),
        "rust/, test/ and .cache/ are not inputs"
    );
    for (name, value) in [
        ("DFO_ORACLE", "use"),
        ("DFO_ORACLE_SPOT", "1.0"),
        ("DFO_ORACLE_SALT", "salt"),
        ("DFO_ORACLE_MAX_MB", "1"),
        ("DFO_ORACLE_STATS", "/nonexistent/stats"),
    ] {
        std::env::set_var(name, value);
        assert_eq!(base, base_key(root), "{name} is not an input");
    }
    std::env::set_var("DFO_ORACLE_STATS", root.join("stats.txt"));
}

/// Part 1b: a second worktree's fixture root keys the same, so one cache directory can be shared by every worktree. The
/// launcher `config.json` names its own root's `arena2Path`, so this only holds because the fixture bytes are
/// canonicalised with the root placeholder (a raw hash made every case a permanent miss).
fn a_copy_of_the_fixture_keys_the_same(base: &Path) {
    // A root of its own at another path; only the root itself is walked, never its parent.
    let twin = scratch("twin").join("root");
    fs::create_dir_all(&twin).expect("twin root");
    write_pinned(
        &twin.join("Saves").join("SAVE1").join("SaveData.txt"),
        r#"{"name":"Key","level":1,"raceId":1,"race":"Breton","health":10,"maxHealth":10,"stats":{"strength":10},"skills":[],"items":[]}"#,
    );
    write_pinned(
        &twin.join("config.json"),
        format!(r#"{{"arena2Path":{:?}}}"#, twin.join("arena2")),
    );
    write_pinned(&twin.join("arena2").join("SPELLS.STD"), "spells-v1");

    // Every entry and mode must match; `config.json` names its own root, so its length follows the path and the key
    // below is what proves its CONTENT counts as the same.
    let entries = |root: &Path| {
        use std::os::unix::fs::PermissionsExt;
        fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
            for entry in fs::read_dir(dir).expect("read") {
                let entry = entry.expect("entry");
                let path = entry.path();
                let meta = fs::symlink_metadata(&path).expect("meta");
                let len = if path.file_name().is_some_and(|n| n == "config.json") {
                    0
                } else {
                    meta.len()
                };
                out.push(format!(
                    "{} mode={:o} len={len}",
                    path.strip_prefix(root).unwrap().to_string_lossy(),
                    meta.permissions().mode() & 0o777
                ));
                if meta.is_dir() {
                    walk(root, &path, out);
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out.sort();
        out
    };
    assert_eq!(
        entries(base),
        entries(&twin),
        "the two roots must hold the same entries with the same modes"
    );
    assert_eq!(
        base_key(base),
        base_key(&twin),
        "a fixture root at another path must key the same (a shared cache depends on it)"
    );
}

/// Part 2: the detector. A scratch program's only input is a file outside every hashed tree, so the key cannot see it;
/// spot 1.0 re-runs the program live, sees the changed answer, panics and deletes the entry.
fn spot_catches_an_unhashed_input(base: &Path, cache: &Path) {
    let outside = base.join("outside.txt");
    fs::write(&outside, "one").expect("outside file");
    std::env::set_var("DFO_ORACLE_JS_ROOT", base.join("js"));
    std::env::set_var("DFO_ORACLE", "use");
    std::env::set_var("DFO_ORACLE_DIR", cache);
    std::env::set_var("DFO_ORACLE_STATS", cache.join("stats.txt"));
    std::env::set_var("DFO_ORACLE_SPOT", "1.0");
    std::env::remove_var("DFO_ORACLE_SALT");

    let program = format!(
        "const fs = require('node:fs'); process.stdout.write(fs.readFileSync({}, 'utf8'));",
        serde_json::to_string(outside.to_str().expect("utf-8 path")).expect("path literal"),
    );
    let args = ["-e", program.as_str()];
    let first = js_batch(&args, b"");
    assert_eq!(first.status.code(), Some(0), "scratch program runs");
    assert_eq!(first.stdout, b"one", "the entry stores the first answer");

    fs::write(&outside, "two").expect("outside file changes");
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| js_batch(&args, b"")));
    std::panic::set_hook(previous);
    let payload = result.expect_err("spot 1.0 must catch the changed answer");
    let message = payload
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| payload.downcast_ref::<&str>().copied())
        .unwrap_or("");
    assert!(
        message.contains("oracle spot mismatch"),
        "the panic names the spot check: {message}"
    );
    assert_eq!(
        fs::read_dir(cache.join("v1"))
            .map(|dir| dir.count())
            .unwrap_or(0),
        0,
        "a mismatched entry is deleted"
    );
}

/// Part 3: corrupt, truncated and swapped entries run live and are rewritten; two concurrent writers of one key leave
/// one valid entry.
fn corrupt_entries_and_concurrent_writers(base: &Path, cache: &Path) {
    std::env::set_var("DFO_ORACLE_JS_ROOT", base.join("js"));
    std::env::set_var("DFO_ORACLE", "use");
    std::env::set_var("DFO_ORACLE_DIR", cache);
    let stats = cache.join("stats.txt");
    fs::create_dir_all(cache).expect("cache dir");
    fs::write(&stats, "").expect("stats file");
    std::env::set_var("DFO_ORACLE_STATS", &stats);
    std::env::set_var("DFO_ORACLE_SPOT", "0");

    let count = |prefix: &str| {
        fs::read_to_string(&stats)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.starts_with(prefix))
            .count()
    };
    let key_of = |program: &str| oracle_key(&repo_root(), None, &["-e", program], &[], Some(b"")).0;

    let alpha = "process.stdout.write('alpha')";
    let beta = "process.stdout.write('beta')";
    assert_eq!(js_batch(&["-e", alpha], b"").stdout, b"alpha");
    assert_eq!(count("miss "), 1, "the first call misses");
    let alpha_key = key_of(alpha);
    let entry = cache.join("v1").join(&alpha_key);
    assert!(entry.is_file(), "a miss stores the entry under its key");

    // Truncated: the header length no longer matches the file.
    fs::write(&entry, b"OCv1").expect("truncate");
    assert_eq!(js_batch(&["-e", alpha], b"").stdout, b"alpha");
    assert_eq!(count("corrupt"), 1, "a truncated entry is counted corrupt");
    assert_eq!(js_batch(&["-e", alpha], b"").stdout, b"alpha");
    assert_eq!(count("hit "), 1, "the live run rewrote a valid entry");

    // Swapped: another key's entry at this path.
    assert_eq!(js_batch(&["-e", beta], b"").stdout, b"beta");
    fs::copy(cache.join("v1").join(key_of(beta)), &entry).expect("swap entry");
    assert_eq!(js_batch(&["-e", alpha], b"").stdout, b"alpha");
    assert_eq!(count("corrupt"), 2, "a key mismatch is corrupt");
    assert_eq!(js_batch(&["-e", alpha], b"").stdout, b"alpha");
    assert_eq!(count("hit "), 2, "the swapped entry is rewritten");

    // Two concurrent writers of one key: both miss and run live, one rename wins, and the entry is valid.
    fs::remove_dir_all(cache.join("v1")).expect("clear entries");
    let gamma = "process.stdout.write('gamma')";
    std::thread::scope(|scope| {
        for _ in 0..2 {
            scope.spawn(|| {
                assert_eq!(js_batch(&["-e", gamma], b"").stdout, b"gamma");
            });
        }
    });
    assert!(
        cache.join("v1").join(key_of(gamma)).is_file(),
        "concurrent writers leave the entry"
    );
    let leftovers = fs::read_dir(cache.join("v1"))
        .expect("entry dir")
        .map(|entry| entry.expect("entry").file_name())
        .filter(|name| name.to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(leftovers, 0, "no tmp files survive a successful rename");
    assert_eq!(js_batch(&["-e", gamma], b"").stdout, b"gamma");
    assert_eq!(count("hit "), 3, "the concurrently written entry is valid");

    let summary = common::oracle_summary(&stats).expect("the stats file parses");
    assert!(
        summary.starts_with("3 hit, 6 miss, 0 uncacheable, 2 corrupt; spot 0 checked, 0 mismatch"),
        "the gate's one-line summary: {summary}"
    );
}

/// This is the live cache's own test: it spawns Node and copies `bin/`, `src/`, `vendor/` and `package.json`, so it is
/// `#[ignore]`d rather than a silent no-op pass. A live run asks for it by name:
///
///   DFO_ORACLE=live cargo test -p dfo-cli --test oracle_key -- --ignored
///
/// (`node tools/gate.mjs rust --live` sets `DFO_ORACLE` for the suite but does not pass `--ignored`; this test is a
/// cache-mechanics check, not a differential).
#[test]
#[ignore = "live JS cache mechanics: run with DFO_ORACLE=live cargo test -- --ignored"]
fn the_key_covers_its_inputs_and_the_cache_fails_open() {
    if !common::live_js() {
        panic!(
            "DFO_ORACLE must name a live mode (live, use or fresh): this test copies the JS tree and spawns Node, so the \
             frozen replay cannot answer it"
        );
    }
    let base = scratch("s3");
    let tree = copied_js_tree(&base);
    let root = fixture(&base);
    std::env::set_var("DFO_ORACLE_JS_ROOT", &tree);
    std::env::set_var("DFO_ORACLE", "off");
    std::env::set_var("DFO_ORACLE_DIR", base.join("cache"));
    std::env::set_var("DFO_ORACLE_STATS", base.join("stats.txt"));
    std::env::set_var("DFO_ORACLE_SPOT", "0");

    key_covers_every_input(&tree, &root);
    a_copy_of_the_fixture_keys_the_same(&root);
    spot_catches_an_unhashed_input(&base, &base.join("cache-spot"));
    corrupt_entries_and_concurrent_writers(&base, &base.join("cache-corrupt"));
}
