//! Committed JS answers (`tests/snapshots/`), the replay of the differential tests without Node.
//!
//! `DFO_ORACLE=snapshot` answers every JS call from `<DFO_SNAPSHOT_DIR>/<test binary>.snap` and never spawns anything.
//! `DFO_ORACLE=record` runs the real JS and writes one part file per test under `DFO_SNAPSHOT_STAGE`; the committed
//! files are written only by `node tools/snapshots.mjs record`, from a run in which every test passed (so each stored
//! answer agreed with the Rust binary, or with the test's own expectation of a deliberate difference). No test run
//! ever writes `tests/snapshots/`.
//!
//! A call's identity is (test name, call number in that test); its argv, cwd, extra env, stdin and the fixture's file
//! contents are stored beside the answer and must match on replay, so a stale answer cannot be used for new inputs.
//! `tests/snapshots/MANIFEST` holds each file's SHA-256 over the gzip -9 bytes on disk: any changed byte fails the
//! replay. A file is read transparently whether it is gzipped (the committed form) or plain.
//!
//! The shapes the JS-oracle cache cannot hold, handled here:
//!   - writes outside the fixture root: the top level of a cwd outside the root and an outside `--out` file are
//!     captured and replayed at the current run's paths;
//!   - `probe` discovery: the capture lives in the fixture root, whose contents are part of the identity;
//!   - `firmament` without `--refresh`: the card's `(N cached, M computed)` counts come from the recording machine's
//!     `.cache/`, so they are stored as zeroes;
//!   - a call that reads the host itself (`HOME` unset) is never routed here; the test skips its JS half.
//!
//! The pinned empty user-data root is shared by concurrent tests, so its contents are neither identity nor output.

use super::oracle::{home_root, pinned_root, product_name, repo_root, sha256_hex, stats};
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Output};
use std::sync::{Mutex, OnceLock};

/// An argv token longer than this (a batch oracle's `-e` program) is stored as its digest.
const LONG_ARG: usize = 512;

/// One call as the test makes it.
pub struct Call<'a> {
    pub cwd: &'a Path,
    pub root: Option<&'a Path>,
    pub args: &'a [&'a str],
    pub env: &'a [(&'a str, &'a OsStr)],
    pub stdin: Option<&'a [u8]>,
}

fn snapshot_dir() -> PathBuf {
    std::env::var_os("DFO_SNAPSHOT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("snapshots")
        })
}

/// `(test name, call number)`: libtest names each test's thread after the test.
fn next_call() -> (String, usize) {
    static COUNTS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
    let thread = std::thread::current();
    let test = thread
        .name()
        .filter(|name| *name != "main")
        .expect("a snapshot call is made on the test's own thread")
        .to_owned();
    let mut counts = COUNTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let n = counts.entry(test.clone()).or_insert(0);
    let index = *n;
    *n += 1;
    (test, index)
}

/// This run's paths and their placeholders, longest first so one cannot hide another. A temp directory named only by
/// the call (an `--out` in a second fixture) is `@TMPn@` in order of first appearance.
fn forms(call: &Call) -> Vec<(String, String)> {
    let mut forms: Vec<(String, String)> = Vec::new();
    let mut add = |path: &Path, name: &str| {
        let literal = path.to_string_lossy().into_owned();
        if let Ok(real) = fs::canonicalize(path) {
            let real = real.to_string_lossy().into_owned();
            if real != literal {
                forms.push((real, format!("@{name}REAL@")));
            }
        }
        forms.push((literal, format!("@{name}@")));
    };
    add(home_root(), "HOME");
    add(&repo_root(), "REPO");
    if let Some(root) = call.root {
        add(root, "ROOT");
    }
    let temp = format!("{}/", std::env::temp_dir().display());
    let cwd = call.cwd.to_string_lossy();
    let named = call
        .args
        .iter()
        .copied()
        .chain([cwd.as_ref()])
        .chain(call.env.iter().filter_map(|(_, value)| value.to_str()));
    let mut extra = 0;
    for token in named {
        let Some(at) = token.find(&temp) else {
            continue;
        };
        let first = token[at + temp.len()..].split('/').next().unwrap_or("");
        let dir = format!("{temp}{first}");
        if first.is_empty() || forms.iter().any(|(form, _)| *form == dir) {
            continue;
        }
        forms.push((dir, format!("@TMP{extra}@")));
        extra += 1;
    }
    forms.sort_by_key(|(form, _)| std::cmp::Reverse(form.len()));
    forms
}

fn stable(text: &str, forms: &[(String, String)]) -> String {
    let mut out = text.to_owned();
    for (form, placeholder) in forms {
        out = out.replace(form, placeholder);
    }
    out
}

fn instantiate(bytes: &[u8], forms: &[(String, String)]) -> Vec<u8> {
    let mut text = String::from_utf8(bytes.to_vec()).expect("snapshot text is UTF-8");
    for (form, placeholder) in forms {
        text = text.replace(placeholder.as_str(), form);
    }
    text.into_bytes()
}

/// An output body ready to store; a body that already holds a placeholder would be replayed wrongly.
fn stored(bytes: &[u8], forms: &[(String, String)], what: &str) -> Vec<u8> {
    let text = std::str::from_utf8(bytes)
        .unwrap_or_else(|_| panic!("{what} is not UTF-8: it cannot be a snapshot"));
    assert!(
        !forms.iter().any(|(_, ph)| text.contains(ph.as_str())),
        "{what} already contains a path placeholder"
    );
    stable(text, forms).into_bytes()
}

/// The identity lines of a call, as stored: what must be equal for the stored answer to apply.
fn identity(call: &Call, forms: &[(String, String)]) -> Vec<(&'static str, String)> {
    let argv: Vec<String> = call
        .args
        .iter()
        .map(|arg| {
            if arg.len() > LONG_ARG {
                format!("sha256:{}", sha256_hex(arg.as_bytes()))
            } else {
                stable(arg, forms)
            }
        })
        .collect();
    let env: BTreeMap<&str, String> = call
        .env
        .iter()
        .map(|(name, value)| (*name, stable(&value.to_string_lossy(), forms)))
        .collect();
    vec![
        (
            "argv",
            serde_json::to_string(&argv).expect("argv serialises"),
        ),
        ("cwd", stable(&call.cwd.to_string_lossy(), forms)),
        ("env", serde_json::to_string(&env).expect("env serialises")),
        (
            "stdin",
            call.stdin.map_or_else(|| "-".to_owned(), sha256_hex),
        ),
        ("fixture", fixture(call.root, forms)),
    ]
}

/// The fixture's names and contents (no mode or mtime: a test whose answer depends on them asserts it itself).
fn fixture(root: Option<&Path>, forms: &[(String, String)]) -> String {
    let Some(root) = root else {
        return "-".to_owned();
    };
    if root == pinned_root() {
        return "pinned".to_owned();
    }
    let mut entries = Vec::new();
    walk(root, root, usize::MAX, &mut |rel, path, meta| {
        let body = if meta.is_symlink() {
            let target = fs::read_link(path).unwrap_or_default();
            format!("link {}", stable(&target.to_string_lossy(), forms))
        } else if meta.is_file() {
            match fs::read(path) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => sha256_hex(product_name(&stable(&text, forms)).as_bytes()),
                    Err(raw) => sha256_hex(raw.as_bytes()),
                },
                Err(_) => "unreadable".to_owned(),
            }
        } else {
            "other".to_owned()
        };
        entries.push(format!("{rel}\0{body}\n"));
    });
    entries.sort();
    sha256_hex(entries.concat().as_bytes())
}

fn walk(root: &Path, dir: &Path, depth: usize, f: &mut dyn FnMut(String, &Path, &fs::Metadata)) {
    let Ok(listing) = fs::read_dir(dir) else {
        return;
    };
    for entry in listing.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        f(rel.to_string_lossy().into_owned(), &path, &meta);
        if meta.is_dir() && depth > 1 {
            walk(root, &path, depth - 1, f);
        }
    }
}

/// The `--out` value, resolved against the cwd.
fn out_path(call: &Call) -> Option<PathBuf> {
    let mut out = None;
    for (i, arg) in call.args.iter().enumerate() {
        if let Some(value) = arg.strip_prefix("--out=") {
            out = Some(value);
        } else if *arg == "--out" {
            out = call.args.get(i + 1).copied();
        }
    }
    out.map(|out| call.cwd.join(out))
}

/// Every file a call may write, by its replayable place (`root:<rel>`, `cwd:<name>`, `out`) with its content and mtime
/// (a rewrite with the same bytes still counts: the JS wrote it).
fn writable(call: &Call) -> BTreeMap<String, (Option<std::time::SystemTime>, Vec<u8>)> {
    let mut out = BTreeMap::new();
    let mut take = |place: String, path: &Path| {
        let Ok(meta) = fs::metadata(path) else {
            return;
        };
        if meta.is_file() {
            if let Ok(bytes) = fs::read(path) {
                out.insert(place, (meta.modified().ok(), bytes));
            }
        }
    };
    let root = call.root.filter(|root| *root != pinned_root());
    if let Some(root) = root {
        walk(root, root, usize::MAX, &mut |rel, path, meta| {
            if meta.is_file() {
                take(format!("root:{rel}"), path);
            }
        });
    }
    let cwd_inside = root.is_some_and(|root| call.cwd.starts_with(root));
    if !cwd_inside {
        walk(call.cwd, call.cwd, 1, &mut |rel, path, meta| {
            if meta.is_file() {
                take(format!("cwd:{rel}"), path);
            }
        });
    }
    if let Some(path) = out_path(call) {
        let covered = root.is_some_and(|root| path.starts_with(root))
            || (!cwd_inside && path.parent() == Some(call.cwd));
        if !covered {
            take("out".to_owned(), &path);
        }
    }
    out
}

fn place_path(call: &Call, place: &str) -> PathBuf {
    if let Some(rel) = place.strip_prefix("root:") {
        call.root.expect("a root file needs a root").join(rel)
    } else if let Some(rel) = place.strip_prefix("cwd:") {
        call.cwd.join(rel)
    } else {
        out_path(call).expect("an `out` file needs --out")
    }
}

/// The JS firmament card without `--refresh` counts its disk cache hits, which belong to the recording machine.
fn zero_cache_counts(call: &Call, stdout: Vec<u8>) -> Vec<u8> {
    if call.args.first() != Some(&"firmament") || call.args.contains(&"--refresh") {
        return stdout;
    }
    let text = String::from_utf8(stdout).expect("checked UTF-8");
    match text.split_once('\n') {
        Some((first, rest)) if first.starts_with("Firmament plans (") => {
            format!("Firmament plans (0 cached, 0 computed)\n{rest}").into_bytes()
        }
        _ => text.into_bytes(),
    }
}

fn binary() -> &'static str {
    env!("CARGO_CRATE_NAME")
}

fn block(out: &mut Vec<u8>, tag: &str, body: &[u8]) {
    out.extend_from_slice(format!("{tag} {}\n", body.len()).as_bytes());
    out.extend_from_slice(body);
    out.push(b'\n');
}

/// Run the real JS and append its answer to this test's part file.
pub fn record(call: &Call, live: &dyn Fn() -> Output) -> Output {
    let stage = PathBuf::from(
        std::env::var_os("DFO_SNAPSHOT_STAGE")
            .expect("DFO_ORACLE=record is run by `node tools/snapshots.mjs record`"),
    )
    .join(binary());
    let (test, index) = next_call();
    let forms = forms(call);
    let identity = identity(call, &forms);
    let before = writable(call);
    let got = live();
    let after = writable(call);

    let mut entry = format!("#call {test} {index}\n").into_bytes();
    for (name, value) in identity {
        assert!(!value.contains('\n'), "a newline in the {name} of {test}");
        entry.extend_from_slice(format!("{name} {value}\n").as_bytes());
    }
    entry.extend_from_slice(format!("exit {}\n", got.status.into_raw()).as_bytes());
    let stdout = stored(&got.stdout, &forms, "stdout");
    block(&mut entry, "stdout", &zero_cache_counts(call, stdout));
    block(&mut entry, "stderr", &stored(&got.stderr, &forms, "stderr"));
    for (place, stamped) in &after {
        if before.get(place) != Some(stamped) {
            // The checkout cwd is shared by every concurrently recording test, so a new file there is not attributable
            // to this call. A page the call writes must go to its own fixture root (`--out`).
            assert!(
                !place.starts_with("cwd:") || call.cwd != repo_root(),
                "{test}: the JS call wrote {place} in the shared checkout cwd; pass --out into the fixture root"
            );
            let body = stored(&stamped.1, &forms, place);
            block(&mut entry, &format!("file {place}"), &body);
        }
    }
    entry.extend_from_slice(b"#end\n");

    fs::create_dir_all(&stage).expect("the stage directory");
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(stage.join(format!("{test}.part")))
        .and_then(|mut file| file.write_all(&entry))
        .expect("the snapshot part is written");
    got
}

struct Entry {
    lines: HashMap<String, String>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    files: Vec<(String, Vec<u8>)>,
}

/// The stored calls by (test name, call number).
type Entries = HashMap<(String, usize), Entry>;

/// This binary's snapshot file, checked against the manifest and parsed once. The file is gzip -9 (the manifest digest
/// is over those bytes); a plain file is read as it is, so the replay test can seal its own.
fn entries() -> &'static Result<Entries, String> {
    static ENTRIES: OnceLock<Result<Entries, String>> = OnceLock::new();
    ENTRIES.get_or_init(|| {
        let dir = snapshot_dir();
        let name = format!("{}.snap", binary());
        let stored = fs::read(dir.join(&name))
            .map_err(|e| format!("no snapshot file {}: {e}", dir.join(&name).display()))?;
        let manifest = fs::read_to_string(dir.join("MANIFEST"))
            .map_err(|e| format!("no snapshot MANIFEST in {}: {e}", dir.display()))?;
        let want = manifest
            .lines()
            .filter_map(|line| line.strip_prefix(&format!("{name} ")))
            .find_map(|rest| rest.split(' ').next())
            .ok_or_else(|| format!("{name} is not in the MANIFEST"))?;
        if want != sha256_hex(&stored) {
            return Err(format!(
                "{name} does not match its MANIFEST digest: it was edited or damaged"
            ));
        }
        let bytes = unpack(&stored).map_err(|e| format!("{name} is not readable gzip: {e}"))?;
        parse(&bytes).ok_or_else(|| format!("{name} is malformed"))
    })
}

/// A snapshot file's bytes: gunzipped when it carries the gzip magic, otherwise taken as written.
fn unpack(stored: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    if stored.starts_with(&[0x1f, 0x8b]) {
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(stored).read_to_end(&mut bytes)?;
        Ok(bytes)
    } else {
        Ok(stored.to_vec())
    }
}

fn parse(mut at: &[u8]) -> Option<Entries> {
    fn line<'a>(at: &mut &'a [u8]) -> Option<&'a str> {
        let end = at.iter().position(|b| *b == b'\n')?;
        let line = std::str::from_utf8(&at[..end]).ok()?;
        *at = &at[end + 1..];
        Some(line)
    }
    let mut out = HashMap::new();
    while !at.is_empty() {
        let (test, index) = line(&mut at)?.strip_prefix("#call ")?.rsplit_once(' ')?;
        let key = (test.to_owned(), index.parse().ok()?);
        let mut entry = Entry {
            lines: HashMap::new(),
            stdout: Vec::new(),
            stderr: Vec::new(),
            files: Vec::new(),
        };
        loop {
            let head = line(&mut at)?;
            if head == "#end" {
                break;
            }
            let (tag, value) = head.split_once(' ')?;
            if matches!(tag, "stdout" | "stderr" | "file") {
                let (place, len) = if tag == "file" {
                    value.rsplit_once(' ')?
                } else {
                    ("", value)
                };
                let len: usize = len.parse().ok()?;
                let body = at.get(..len)?.to_vec();
                at = at.get(len..)?.strip_prefix(b"\n")?;
                match tag {
                    "stdout" => entry.stdout = body,
                    "stderr" => entry.stderr = body,
                    _ => entry.files.push((place.to_owned(), body)),
                }
            } else {
                entry.lines.insert(tag.to_owned(), value.to_owned());
            }
        }
        if out.insert(key, entry).is_some() {
            return None;
        }
    }
    Some(out)
}

/// The stored JS answer: output, exit status and written files. Spawns nothing.
pub fn replay(call: &Call) -> Output {
    let (test, index) = next_call();
    let regenerate = "see `node tools/snapshots.mjs record` in rust/README.md";
    let entries = match entries() {
        Ok(entries) => entries,
        Err(why) => panic!("snapshot replay: {why}; {regenerate}"),
    };
    let entry = entries
        .get(&(test.clone(), index))
        .unwrap_or_else(|| panic!("no snapshot for {test} call {index}; {regenerate}"));
    let forms = forms(call);
    for (name, value) in identity(call, &forms) {
        let want = entry.lines.get(name).map(String::as_str).unwrap_or("");
        assert!(
            want == value,
            "stale snapshot for {test} call {index}: the {name} moved\n  stored: {want}\n  now:    {value}\n{regenerate}"
        );
    }
    for (place, body) in &entry.files {
        let path = place_path(call, place);
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).expect("the replayed file's directory");
        }
        fs::write(&path, instantiate(body, &forms)).expect("the replayed file is written");
    }
    stats(&format!("snap {} {test} {index}", binary()));
    let exit = entry.lines.get("exit").and_then(|v| v.parse().ok());
    Output {
        status: ExitStatus::from_raw(exit.expect("a stored exit status")),
        stdout: instantiate(&entry.stdout, &forms),
        stderr: instantiate(&entry.stderr, &forms),
    }
}
