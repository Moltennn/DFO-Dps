//! The JS side of the CLI differential tests, and the JS-oracle output cache (design: `oracle-cache/DESIGN.md`).
//!
//! Every CLI test spawns `node bin/dfo-dps.js` the same way: one locale, one `HOME`, and `DAGGER_USER_DATA` when the
//! case reads or writes a user-data tree. Those spawns live here, once, so a test file keeps only its own `same*()`
//! assertions and the arguments it runs.
//!
//! `DFO_ORACLE=use` reads and writes the cache, `fresh` skips reads and writes it, and `off` (the default) is the plain
//! spawn. With `DFO_ORACLE_STATS` set, every call appends one line there (see [`oracle_summary`] for the summary the
//! gate prints). A hit is re-run live when the first 8 bytes of `sha256(salt || key)` fall under `DFO_ORACLE_SPOT`;
//! a mismatch panics with a diff and deletes the entry, so the cache can never hide JS drift. The Rust binary always
//! runs live; only the JS answer is cached.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The repository root: this crate lives at `<repo>/rust/dfo-cli`.
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// The tree the JS code is read from: the repository, or `DFO_ORACLE_JS_ROOT` (a test-only override so a test can
/// copy `bin/`, `src/`, `vendor/` and `package.json` and flip bytes without touching the checkout).
fn js_tree() -> PathBuf {
    std::env::var_os("DFO_ORACLE_JS_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(repo_root)
}

/// A fresh, uniquely labelled temp root (`<temp>/dfo-cli-<label>-<pid>-<n>`), with an empty `Saves` folder. A theory
/// case reads none; a save-backed case writes its own tiny fixture there.
pub fn temp_root(label: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("dfo-cli-{label}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("Saves")).expect("temp fixture root");
    root
}

/// An empty user-data root shared by the theory cases that take no `--save`: pinned, so the JS can never read the host
/// launcher config or the player's saves, and one process creates it once.
pub fn pinned_root() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("dfo-cli-pinned-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Saves")).expect("pinned fixture root");
        root
    })
}

/// A fixture file's mtime is part of the oracle key, and one fresher than [`PINNED_MTIME`] makes every call that reads
/// it uncacheable. A case that writes a save, a config or a capture pins it here: any old, fixed stamp is cacheable,
/// and only a case whose assertion depends on file order (`listSaves` newest first) needs distinct values.
pub fn pin_mtime(path: &Path) {
    pin_mtime_at(path, 1_700_000_000);
}

/// [`pin_mtime`] at an explicit epoch second, for a case whose assertion depends on which of two files is newer.
pub fn pin_mtime_at(path: &Path, secs: u64) {
    fs::File::options()
        .write(true)
        .open(path)
        .expect("fixture file opens")
        .set_modified(UNIX_EPOCH + Duration::from_secs(secs))
        .expect("fixture mtime");
}

/// An empty, process-wide `HOME`, pinned for every child so `os.homedir()` discovery can never read the host. A case
/// that needs a home of its own passes `HOME` explicitly.
pub fn home_root() -> &'static Path {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        let home = std::env::temp_dir().join(format!("dfo-cli-home-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let _ = fs::create_dir_all(&home);
        home
    })
}

/// The page's bytes after a run, then the file is removed so the next CLI can write the same path.
pub fn take_page(path: &Path) -> Vec<u8> {
    let bytes = fs::read(path).expect("the CLI wrote its page");
    fs::remove_file(path).expect("cleanup the page");
    bytes
}

/// The JS CLI at the repository root with a fixture root as `DAGGER_USER_DATA`.
pub fn js(args: &[&str], root: &Path) -> Output {
    js_at(
        &repo_root(),
        args,
        Some(root),
        &[("DAGGER_USER_DATA", root.as_os_str())],
        None,
    )
}

/// The JS CLI at the repository root with the pinned empty user-data root (a `--theory` case).
pub fn js_pinned(args: &[&str]) -> Output {
    js(args, pinned_root())
}

/// The JS CLI with the fixture root as both cwd and `DAGGER_USER_DATA` (a case that writes its page relative to it).
pub fn js_root(args: &[&str], root: &Path) -> Output {
    js_at(
        root,
        args,
        Some(root),
        &[("DAGGER_USER_DATA", root.as_os_str())],
        None,
    )
}

/// The JS CLI at the repository root with `DAGGER_USER_DATA`, then `--out <page>`.
pub fn js_page(args: &[&str], page: &Path, root: &Path) -> Output {
    let mut argv: Vec<&str> = args.to_vec();
    argv.push("--out");
    argv.push(page.to_str().expect("utf-8 page path"));
    js(&argv, root)
}

/// The JS CLI in `cwd`, whose own tree is the fixture root (an explicit capture path is passed in `args`).
pub fn js_cwd(args: &[&str], cwd: &Path) -> Output {
    js_at(cwd, args, Some(cwd), &[], None)
}

/// The JS CLI in `cwd` with the caller's own env; `root` is the fixture tree the call reads (for the key).
pub fn js_at(
    cwd: &Path,
    args: &[&str],
    root: Option<&Path>,
    env: &[(&str, &OsStr)],
    stdin: Option<&[u8]>,
) -> Output {
    let live = || {
        let mut command = Command::new("node");
        command
            .arg(js_tree().join("bin").join("dfo-dps.js"))
            .args(args)
            .current_dir(cwd);
        apply_env(&mut command, env);
        finish(command, stdin)
    };
    run_js(cwd, root, args, env, stdin, &live)
}

/// A batch oracle: `node <args...>` with the call list on stdin (the `-e` program text is part of `args`). Its only
/// fixture input is the code tree itself, so there is no fixture root to hash.
pub fn js_batch(args: &[&str], stdin: &[u8]) -> Output {
    let cwd = repo_root();
    let live = || {
        let mut command = Command::new("node");
        command.args(args).current_dir(&cwd);
        apply_env(&mut command, &[]);
        finish(command, Some(stdin))
    };
    run_js(&cwd, None, args, &[], Some(stdin), &live)
}

/// The Rust CLI at the repository root with a fixture root as `DAGGER_USER_DATA`.
pub fn rust(args: &[&str], root: &Path) -> Output {
    rust_at(
        &repo_root(),
        args,
        &[("DAGGER_USER_DATA", root.as_os_str())],
    )
}

/// The Rust CLI at the repository root with the pinned empty user-data root (a `--theory` case).
pub fn rust_pinned(args: &[&str]) -> Output {
    rust(args, pinned_root())
}

/// The Rust CLI with the fixture root as cwd and `DAGGER_USER_DATA`.
pub fn rust_root(args: &[&str], root: &Path) -> Output {
    rust_at(root, args, &[("DAGGER_USER_DATA", root.as_os_str())])
}

/// The Rust CLI in `cwd` with no extra child env.
pub fn rust_cwd(args: &[&str], cwd: &Path) -> Output {
    rust_at(cwd, args, &[])
}

/// The Rust CLI in `cwd` with the caller's own env.
pub fn rust_at(cwd: &Path, args: &[&str], env: &[(&str, &OsStr)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_dfo-cli"));
    command.args(args).current_dir(cwd);
    apply_env(&mut command, env);
    command.output().expect("the Rust CLI binary runs")
}

/// One locale for every child: the host's `LC_*` set is dropped and `LC_ALL`/`LANG` pinned, so `toLocaleString()`
/// grouping cannot move with the host. `HOME` is pinned for the same reason (`os.homedir()` discovery, probe).
fn apply_env(command: &mut Command, env: &[(&str, &OsStr)]) {
    for name in LC_VARS {
        command.env_remove(name);
    }
    command
        .env("LC_ALL", "en_US.UTF-8")
        .env("LANG", "en_US.UTF-8")
        .env("HOME", home_root());
    for (name, value) in env {
        command.env(name, value);
    }
}

const LC_VARS: [&str; 14] = [
    "LC_ALL",
    "LC_CTYPE",
    "LC_NUMERIC",
    "LC_TIME",
    "LC_COLLATE",
    "LC_MONETARY",
    "LC_MESSAGES",
    "LC_PAPER",
    "LC_NAME",
    "LC_ADDRESS",
    "LC_TELEPHONE",
    "LC_MEASUREMENT",
    "LC_IDENTIFICATION",
    "LANGUAGE",
];

fn finish(mut command: Command, stdin: Option<&[u8]>) -> Output {
    match stdin {
        None => command.output().expect("the CLI runs"),
        Some(bytes) => {
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut child = command.spawn().expect("the CLI runs");
            child
                .stdin
                .as_mut()
                .expect("piped stdin")
                .write_all(bytes)
                .expect("the call list is written");
            child.wait_with_output().expect("the CLI finishes")
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The key: `sha256("dfo-oracle/v1\0" || fields)`, each field `name \0 u64-LE length value`, in design order.

/// Variables the child may see that the key ignores: a deny-list, never a whitelist, so an extra variable is a miss.
const ENV_DENY: [&str; 11] = [
    "PWD",
    "OLDPWD",
    "SHLVL",
    "_",
    "TERM",
    "COLORTERM",
    "TMPDIR",
    "TEMP",
    "TMP",
    "PATH",
    "LANGUAGE",
];
const ENV_DENY_PREFIX: [&str; 3] = ["CARGO_", "RUST_", "DFO_ORACLE"];

/// A fixture file whose mtime is fresher than this window was written during the run, so its key cannot be reused.
const PINNED_MTIME: Duration = Duration::from_secs(300);

// ---------------------------------------------------------------------------------------------------------------------
// The cache: `DFO_ORACLE=use|fresh|off`, one entry per key, atomic tmp+rename, corrupt entries fail open.

/// What the environment asks of the cache. `off` (the default) is the plain spawn; `fresh` skips reads and writes an
/// entry; `use` reads and writes one.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CacheMode {
    Off,
    Use,
    Fresh,
}

fn cache_mode() -> CacheMode {
    match std::env::var("DFO_ORACLE").ok().as_deref() {
        Some("use") => CacheMode::Use,
        Some("fresh") => CacheMode::Fresh,
        _ => CacheMode::Off,
    }
}

/// `<checkout>/.cache/oracle`, never shared between worktrees unless `DFO_ORACLE_DIR` says so (`.cache/` is gitignored).
fn oracle_dir() -> PathBuf {
    std::env::var_os("DFO_ORACLE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root().join(".cache").join("oracle"))
}

/// The fraction of hits re-run against real JS (`DFO_ORACLE_SPOT`, default 5 %).
fn spot_fraction() -> f64 {
    std::env::var("DFO_ORACLE_SPOT")
        .ok()
        .and_then(|text| text.parse::<f64>().ok())
        .filter(|fraction| fraction.is_finite())
        .unwrap_or(0.05)
        .clamp(0.0, 1.0)
}

/// `first8bytes(sha256(salt || key)) < fraction`: the design's spot-check selector. A fraction of 1.0 selects every hit
/// (`u64::MAX as f64` is below 1.0, so the explicit check keeps the top end exact).
fn spot_selected(key: &str) -> bool {
    let mut hashed = std::env::var("DFO_ORACLE_SALT")
        .unwrap_or_default()
        .into_bytes();
    hashed.extend_from_slice(key.as_bytes());
    let first = u64::from_be_bytes(sha256(&hashed)[..8].try_into().expect("8 bytes"));
    spot_fraction() >= 1.0 || (first as f64) < spot_fraction() * (u64::MAX as f64)
}

/// One line per call, appended to `DFO_ORACLE_STATS`; [`oracle_summary`] turns the file into the gate's line.
fn stats(line: &str) {
    let Some(path) = std::env::var_os("DFO_ORACLE_STATS") else {
        return;
    };
    static FILE_LOCK: Mutex<()> = Mutex::new(());
    let _guard = FILE_LOCK.lock();
    if let Ok(mut out) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(PathBuf::from(path))
    {
        // One `write_all` per line: O_APPEND keeps concurrent test binaries' lines whole.
        let _ = out.write_all(format!("{line}\n").as_bytes());
    }
}

/// The stats file as the gate prints it: `N hit, N miss, N uncacheable, N corrupt; spot K checked, N mismatch; est.
/// saved S s`. A spot-checked hit is re-run live, so it saves nothing: `saved` counts only the hits that were replayed.
pub fn oracle_summary(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let (mut hit, mut miss, mut uncacheable, mut corrupt, mut spot, mut mismatch) =
        (0, 0, 0, 0, 0, 0);
    let mut saved = 0.0;
    for line in text.lines() {
        if let Some(secs) = line.strip_prefix("hit ") {
            hit += 1;
            saved += secs.parse::<f64>().unwrap_or(0.0);
        } else if let Some(rest) = line.strip_prefix("spot ok ") {
            // `spot ok <stored_secs> <live_secs>`: the hit above saved nothing.
            saved -= rest
                .split_whitespace()
                .next()
                .and_then(|secs| secs.parse::<f64>().ok())
                .unwrap_or(0.0);
        } else if line.starts_with("miss ") {
            miss += 1;
        } else if line.starts_with("uncacheable ") {
            uncacheable += 1;
        } else if line == "corrupt" {
            corrupt += 1;
        } else if line.starts_with("spot ") {
            spot += 1;
            if line == "spot mismatch" {
                mismatch += 1;
            }
        }
    }
    Some(format!(
        "{hit} hit, {miss} miss, {uncacheable} uncacheable, {corrupt} corrupt; spot {spot} checked, {mismatch} mismatch; est. saved {:.1} s",
        saved.max(0.0)
    ))
}

/// The literal root and its canonical form, longest first, plus `HOME`: the design's stable-path forms.
fn stable_forms(root: Option<&Path>) -> Vec<(String, String)> {
    let mut forms = vec![(
        home_root().to_string_lossy().into_owned(),
        "@HOME@".to_owned(),
    )];
    if let Some(root) = root {
        forms.push((root.to_string_lossy().into_owned(), "@ROOT@".to_owned()));
        if let Ok(real) = fs::canonicalize(root) {
            forms.push((real.to_string_lossy().into_owned(), "@ROOTREAL@".to_owned()));
        }
    }
    forms.sort_by_key(|(form, _)| std::cmp::Reverse(form.len()));
    forms
}

const PLACEHOLDERS: [&str; 3] = ["@ROOTREAL@", "@ROOT@", "@HOME@"];

/// Replace the current run's paths with placeholders. A placeholder already in the bytes makes the entry ambiguous.
fn stabilise(bytes: &[u8], forms: &[(String, String)]) -> Result<Vec<u8>, String> {
    let text =
        String::from_utf8(bytes.to_vec()).map_err(|_| "non-UTF-8 oracle output".to_owned())?;
    if PLACEHOLDERS
        .iter()
        .any(|placeholder| text.contains(placeholder))
    {
        return Err("placeholder collision".to_owned());
    }
    let mut out = text;
    for (form, placeholder) in forms {
        out = out.replace(form, placeholder);
    }
    Ok(out.into_bytes())
}

/// The placeholders back to this run's paths, on replay.
fn instantiate(bytes: &[u8], forms: &[(String, String)]) -> Vec<u8> {
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    let mut pairs: Vec<(&String, &String)> = forms.iter().map(|(form, ph)| (ph, form)).collect();
    pairs.sort_by_key(|(placeholder, _)| std::cmp::Reverse(placeholder.len()));
    for (placeholder, form) in pairs {
        text = text.replace(placeholder, form);
    }
    text.into_bytes()
}

/// Every file under the root and its content hash, for the before/after diff that finds the written files.
fn snapshot(root: &Path) -> BTreeMap<String, [u8; 32]> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, [u8; 32]>) {
        let Ok(listing) = fs::read_dir(dir) else {
            return;
        };
        for entry in listing.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                walk(root, &path, out);
            } else if meta.is_file() {
                if let (Ok(rel), Ok(bytes)) = (path.strip_prefix(root), fs::read(&path)) {
                    out.insert(rel.to_string_lossy().replace('\\', "/"), sha256(&bytes));
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

/// One stored file: its path relative to the root, length, content hash (the header's `files`) and its body.
struct FileMeta {
    rel: String,
    len: u64,
    sha256: String,
    body: Vec<u8>,
}

/// A decoded entry: the header fields the tests need and the raw (placeholdered) output.
struct Entry {
    exit: i32,
    js_secs: f64,
    files: Vec<FileMeta>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

const ENTRY_MAGIC: &[u8; 4] = b"OCv1";
const ENTRY_LIMIT: usize = 16 * 1024 * 1024;

/// Write one entry: `magic | u32-LE header length | header JSON | payload`, to a unique tmp name then rename. A rename
/// in the same directory is atomic, so concurrent writers leave one valid entry, never half of each.
fn write_entry(dir: &Path, key: &str, header: &serde_json::Value, payload: &[u8]) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let header = serde_json::to_vec(header).expect("the entry header serialises");
    let mut bytes = Vec::with_capacity(8 + header.len() + payload.len());
    bytes.extend_from_slice(ENTRY_MAGIC);
    bytes.extend_from_slice(&(header.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(payload);
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let tmp = dir.join(format!(".{key}.{nonce}.tmp"));
    if fs::write(&tmp, &bytes).is_err() || fs::rename(&tmp, dir.join(key)).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// Read and validate one entry. A key mismatch, a short read, a bad length or checksum is `None`; the caller deletes
/// the file and runs live, so a corrupt entry never panics.
fn read_entry(dir: &Path, key: &str, root: Option<&Path>) -> Option<Entry> {
    let bytes = fs::read(dir.join(key)).ok()?;
    if bytes.len() < 8 || &bytes[..4] != ENTRY_MAGIC {
        return None;
    }
    let len = u32::from_be_bytes(bytes[4..8].try_into().ok()?) as usize;
    if bytes.len() < 8 + len {
        return None;
    }
    let header: serde_json::Value = serde_json::from_slice(&bytes[8..8 + len]).ok()?;
    let payload = &bytes[8 + len..];
    if header.get("key").and_then(|v| v.as_str()) != Some(key) {
        return None;
    }
    let number = |name: &str| header.get(name).and_then(|v| v.as_u64());
    let (stdout_len, stderr_len) = (number("stdout_len")?, number("stderr_len")?);
    if header.get("payload_sha256").and_then(|v| v.as_str()) != Some(&sha256_hex(payload)) {
        return None;
    }
    let mut files = Vec::new();
    let mut at = (stdout_len + stderr_len) as usize;
    for file in header.get("files")?.as_array()? {
        let len = file.get("len")?.as_u64()?;
        let rel = file.get("rel")?.as_str()?.to_owned();
        let body = payload.get(at..at + len as usize)?.to_vec();
        if file.get("sha256")?.as_str()? != sha256_hex(&body) {
            return None;
        }
        files.push(FileMeta {
            rel,
            len,
            sha256: sha256_hex(&body),
            body,
        });
        at += len as usize;
    }
    if payload.len()
        != (stdout_len + stderr_len) as usize + files.iter().map(|f| f.len as usize).sum::<usize>()
    {
        return None;
    }
    // A stored file outside the fixture root cannot be replayed inside it.
    if files.iter().any(|file| {
        root.is_none()
            || file.rel.is_empty()
            || Path::new(&file.rel).is_absolute()
            || file.rel.split('/').any(|part| part == "..")
    }) {
        return None;
    }
    Some(Entry {
        exit: header.get("exit")?.as_i64()? as i32,
        js_secs: header.get("js_secs")?.as_f64()?,
        files,
        stdout: payload[..stdout_len as usize].to_vec(),
        stderr: payload[stdout_len as usize..(stdout_len + stderr_len) as usize].to_vec(),
    })
}

/// Write the entry's output and files back into the fixture root, exactly as the JS wrote them.
fn replay(entry: &Entry, root: Option<&Path>, forms: &[(String, String)]) -> Option<Output> {
    if !entry.files.is_empty() {
        let root = root?;
        for file in &entry.files {
            let path = root.join(&file.rel);
            if path
                .parent()
                .is_some_and(|dir| fs::create_dir_all(dir).is_err())
                || fs::write(&path, instantiate(&file.body, forms)).is_err()
            {
                return None;
            }
        }
    }
    Some(Output {
        status: ExitStatus::from_raw(entry.exit),
        stdout: instantiate(&entry.stdout, forms),
        stderr: instantiate(&entry.stderr, forms),
    })
}

/// A readable diff: which of stdout/stderr/exit moved, and the first differing byte.
fn spot_diff(cached: &[u8], live: &[u8]) -> String {
    let at = cached
        .iter()
        .zip(live)
        .position(|(a, b)| a != b)
        .unwrap_or(cached.len().min(live.len()));
    let from = at.saturating_sub(80);
    format!(
        "byte {at} (lens {} vs {}):\n  cached: {:?}\n  live:   {:?}",
        cached.len(),
        live.len(),
        String::from_utf8_lossy(&cached[from..(at + 160).min(cached.len())]),
        String::from_utf8_lossy(&live[from..(at + 160).min(live.len())]),
    )
}

/// One JS spawn, cached or live. `live` builds and runs the command; it runs twice on a re-checked hit.
fn run_js(
    cwd: &Path,
    root: Option<&Path>,
    args: &[&str],
    env: &[(&str, &OsStr)],
    stdin: Option<&[u8]>,
    live: &dyn Fn() -> Output,
) -> Output {
    let mode = cache_mode();
    if mode == CacheMode::Off {
        // The S2 dry run: the key and its verdict only, no entry read or written.
        if std::env::var_os("DFO_ORACLE_STATS").is_some() {
            let (key, summary, verdict) = compute(cwd, root, args, env, stdin);
            stats(&format!("{key} {summary} {verdict}"));
        }
        return live();
    }
    let (key, summary, verdict) = compute(cwd, root, args, env, stdin);
    if let Some(reason) = verdict.strip_prefix("uncacheable:") {
        let timed = Instant::now();
        let out = live();
        stats(&format!(
            "uncacheable {reason} ({:.3}s)",
            timed.elapsed().as_secs_f64()
        ));
        return out;
    }
    let forms = stable_forms(root);
    let dir = oracle_dir().join("v1");
    if mode == CacheMode::Use {
        match read_entry(&dir, &key, root) {
            Some(entry) => {
                // What the replayed files held before this request: the spot re-run starts from the same state.
                let prior: Vec<(PathBuf, Option<Vec<u8>>)> = root.map_or_else(Vec::new, |root| {
                    entry
                        .files
                        .iter()
                        .map(|file| {
                            let path = root.join(&file.rel);
                            let body = fs::read(&path).ok();
                            (path, body)
                        })
                        .collect()
                });
                match replay(&entry, root, &forms) {
                    Some(output) => {
                        stats(&format!("hit {:.3}", entry.js_secs));
                        if !spot_selected(&key) {
                            return output;
                        }
                        // Restore the pre-request state, so the live run writes its files from the same start and a
                        // replayed page can never stand in for a live run that stopped writing one.
                        for (path, body) in &prior {
                            match body {
                                Some(body) => {
                                    let _ = fs::write(path, body);
                                }
                                None => {
                                    let _ = fs::remove_file(path);
                                }
                            }
                        }
                        let before = root.map(snapshot);
                        let timed = Instant::now();
                        let got = live();
                        let secs = timed.elapsed().as_secs_f64();
                        let written = written_files(root, before);
                        if let Some(diff) = spot_compare(&entry, &got, &written, &forms, args) {
                            let _ = fs::remove_file(dir.join(&key));
                            stats("spot mismatch");
                            panic!(
                                "oracle spot mismatch for {summary} (entry deleted; JS drifted from the cached answer)\n{diff}"
                            );
                        }
                        stats(&format!("spot ok {:.3} {secs:.3}", entry.js_secs));
                        return output;
                    }
                    None => {
                        // Replay failed on this filesystem: treat it like a corrupt entry and run live.
                        let _ = fs::remove_file(dir.join(&key));
                        stats("corrupt");
                    }
                }
            }
            None if dir.join(&key).exists() => {
                let _ = fs::remove_file(dir.join(&key));
                stats("corrupt");
            }
            None => {}
        }
    }
    let before = root.map(snapshot);
    let timed = Instant::now();
    let out = live();
    let secs = timed.elapsed().as_secs_f64();
    if out.status.signal().is_some() {
        stats("uncacheable signal exit");
        return out;
    }
    let written = written_files(root, before);
    if let Some(outside) = outside_root_write(args, cwd, root) {
        stats(&format!("uncacheable outside-root write: {outside}"));
        return out;
    }
    if let Some(path) = stderr_path_outside_root(&out.stderr, root) {
        stats(&format!("uncacheable stderr path outside the root: {path}"));
        return out;
    }
    match store_entry(&dir, &key, args, &out, secs, &written, &forms) {
        StoreResult::Stored => stats(&format!("miss {secs:.3}")),
        // The call ran live either way; it is counted once, by its reason.
        StoreResult::Skipped(reason) => stats(&format!("uncacheable {reason}")),
    }
    out
}

enum StoreResult {
    Stored,
    Skipped(String),
}

/// The argv as the header stores it: the current run's paths replaced by their placeholders.
fn canonical_argv(args: &[&str], forms: &[(String, String)]) -> Vec<String> {
    let mut out: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    for (form, placeholder) in forms {
        for arg in &mut out {
            *arg = arg.replace(form, placeholder);
        }
    }
    out
}

/// Store one live answer: the output, the exit code and every file written under the root, stabilised.
fn store_entry(
    dir: &Path,
    key: &str,
    args: &[&str],
    out: &Output,
    secs: f64,
    written: &[(String, Vec<u8>)],
    forms: &[(String, String)],
) -> StoreResult {
    let stdout = match stabilise(&out.stdout, forms) {
        Ok(bytes) => bytes,
        Err(reason) => return StoreResult::Skipped(reason),
    };
    let stderr = match stabilise(&out.stderr, forms) {
        Ok(bytes) => bytes,
        Err(reason) => return StoreResult::Skipped(reason),
    };
    let mut payload = stdout.clone();
    payload.extend_from_slice(&stderr);
    let mut files = Vec::new();
    for (rel, body) in written {
        let stable = match stabilise(body, forms) {
            Ok(bytes) => bytes,
            Err(reason) => return StoreResult::Skipped(reason),
        };
        files.push(FileMeta {
            rel: rel.clone(),
            len: stable.len() as u64,
            sha256: sha256_hex(&stable),
            body: stable.clone(),
        });
        payload.extend_from_slice(&stable);
    }
    if payload.len() + 4096 > ENTRY_LIMIT {
        return StoreResult::Skipped("oversize entry".to_owned());
    }
    let header = serde_json::json!({
        "key": key,
        "argv": canonical_argv(args, forms),
        "code": code_fingerprint().unwrap_or_default(),
        "node": node_fingerprint().unwrap_or_default(),
        "exit": out.status.into_raw(),
        "js_secs": secs,
        "files": files.iter().map(|file| serde_json::json!({
            "rel": file.rel, "len": file.len, "sha256": file.sha256,
        })).collect::<Vec<_>>(),
        "stdout_len": stdout.len(),
        "stderr_len": stderr.len(),
        "payload_sha256": sha256_hex(&payload),
    });
    write_entry(dir, key, &header, &payload);
    StoreResult::Stored
}

/// The files a live run created or changed under the root (a content difference; deletions are not replayed).
fn written_files(
    root: Option<&Path>,
    before: Option<BTreeMap<String, [u8; 32]>>,
) -> Vec<(String, Vec<u8>)> {
    let (Some(root), Some(before)) = (root, before) else {
        return Vec::new();
    };
    snapshot(root)
        .into_iter()
        .filter(|(rel, sha)| before.get(rel) != Some(sha))
        .filter_map(|(rel, _)| Some((rel.clone(), fs::read(root.join(&rel)).ok()?)))
        .collect()
}

/// A `--out` path outside the fixture root is a write the cache cannot see or replay.
fn outside_root_write(args: &[&str], cwd: &Path, root: Option<&Path>) -> Option<String> {
    let mut out: Option<&str> = None;
    for (i, arg) in args.iter().enumerate() {
        if let Some(value) = arg.strip_prefix("--out=") {
            out = Some(value);
        } else if *arg == "--out" {
            out = args.get(i + 1).copied();
        }
    }
    let out = out?;
    let joined = if Path::new(out).is_absolute() {
        PathBuf::from(out)
    } else {
        cwd.join(out)
    };
    let inside = root.is_some_and(|root| joined.starts_with(root) || same_dir(&joined, root));
    (!inside).then(|| out.to_owned())
}

/// Every absolute path in stderr has to be under the root, or the stored stderr names a file the cache does not cover.
/// The placeholders come out first, so a stabilised stderr keeps its own path.
fn stderr_path_outside_root(stderr: &[u8], root: Option<&Path>) -> Option<String> {
    let root = root?;
    let text = String::from_utf8_lossy(stderr);
    for token in text.split(|c: char| c.is_whitespace() || ":\"'`(),".contains(c)) {
        let token = token.trim_end_matches(['.', ';']);
        if !token.starts_with('/') || PLACEHOLDERS.iter().any(|p| token.contains(p)) {
            continue;
        }
        if !Path::new(token).starts_with(root) {
            return Some(token.to_owned());
        }
    }
    None
}

/// Compare a spot re-run against the stored entry: stdout, stderr, exit code, and the set and bytes of written files.
fn spot_compare(
    entry: &Entry,
    got: &Output,
    written: &[(String, Vec<u8>)],
    forms: &[(String, String)],
    args: &[&str],
) -> Option<String> {
    let (Ok(stdout), Ok(stderr)) = (stabilise(&got.stdout, forms), stabilise(&got.stderr, forms))
    else {
        return Some(format!("live output is not stabilisable for {args:?}"));
    };
    let mut diffs = Vec::new();
    if entry.exit != got.status.into_raw() {
        diffs.push(format!("exit {} vs {}", entry.exit, got.status.into_raw()));
    }
    if entry.stdout != stdout {
        diffs.push(format!("stdout {}", spot_diff(&entry.stdout, &stdout)));
    }
    if entry.stderr != stderr {
        diffs.push(format!("stderr {}", spot_diff(&entry.stderr, &stderr)));
    }
    let want = entry
        .files
        .iter()
        .map(|file| (file.rel.clone(), file.sha256.clone(), file.len))
        .collect::<Vec<_>>();
    let live = written
        .iter()
        .map(|(rel, body)| match stabilise(body, forms) {
            Ok(bytes) => Ok((rel.clone(), sha256_hex(&bytes), bytes.len() as u64)),
            Err(reason) => Err(format!("live file {rel} is not stabilisable: {reason}")),
        })
        .collect::<Result<Vec<_>, _>>();
    match live {
        Ok(live) if want != live => diffs.push(format!("files cached {want:?}\n  live {live:?}")),
        Ok(_) => {}
        Err(reason) => diffs.push(reason),
    }
    (!diffs.is_empty()).then(|| format!("{args:?}: {}", diffs.join("\n")))
}

/// One call's key and verdict (`cacheable` or `uncacheable:<reason>`), for `tests/oracle_key.rs`. It is the same key the
/// cache uses as the entry name, so two calls whose keys differ can never share an entry.
pub fn oracle_key(
    cwd: &Path,
    root: Option<&Path>,
    args: &[&str],
    env: &[(&str, &OsStr)],
    stdin: Option<&[u8]>,
) -> (String, String) {
    let (key, _, verdict) = compute(cwd, root, args, env, stdin);
    (key, verdict)
}

/// One call's key, a short argv summary for the log, and `cacheable` or `uncacheable:<reason>`.
fn compute(
    cwd: &Path,
    root: Option<&Path>,
    args: &[&str],
    env: &[(&str, &OsStr)],
    stdin: Option<&[u8]>,
) -> (String, String, String) {
    let mut reason: Option<String> = None;
    let mut uncacheable = |why: String| {
        if reason.is_none() {
            reason = Some(why);
        }
    };

    // The literal root and its canonical form, longest first, so one replacement cannot hide the other.
    let mut forms: Vec<(String, &str)> = Vec::new();
    if let Some(root) = root {
        match root.to_str() {
            Some(text) => forms.push((text.to_owned(), "@ROOT@")),
            None => uncacheable("non-UTF-8 root".to_owned()),
        }
        match fs::canonicalize(root) {
            Ok(real) => match real.to_str() {
                Some(text) => forms.push((text.to_owned(), "@ROOTREAL@")),
                None => uncacheable("non-UTF-8 root".to_owned()),
            },
            Err(_) => uncacheable(format!("fixture root unreadable: {}", root.display())),
        }
    }
    forms.retain(|(form, _)| !form.is_empty());
    forms.sort_by_key(|(form, _)| std::cmp::Reverse(form.len()));
    let home = home_root().to_string_lossy().into_owned();
    // The repository path is not an input (its content is hashed as `code`), and a worktree copy must key the same, so
    // a child variable that names `<repo>/rust/target/debug` (`LD_LIBRARY_PATH` under `cargo test`) keeps no path.
    let repo = fs::canonicalize(repo_root()).unwrap_or_else(|_| repo_root());
    let repo = repo.to_string_lossy().into_owned();
    let canon = |text: &str| {
        let mut out = text.to_owned();
        for (form, placeholder) in &forms {
            out = out.replace(form, placeholder);
        }
        out = out.replace(&home, "@HOME@");
        out.replace(&repo, "@REPO@")
    };

    let code = match code_fingerprint() {
        Ok(code) => code,
        Err(why) => {
            uncacheable(why);
            "code-unavailable".to_owned()
        }
    };
    let node = match node_fingerprint() {
        Ok(node) => node,
        Err(why) => {
            uncacheable(why);
            "node-unavailable".to_owned()
        }
    };

    let argv = args
        .iter()
        .map(|arg| canon(arg))
        .collect::<Vec<_>>()
        .join("\u{0}");
    let cwd_field = if same_dir(cwd, &repo_root()) {
        "@REPO@".to_owned()
    } else if let Some(root) = root.filter(|root| cwd.starts_with(root) || same_dir(cwd, root)) {
        // Inside the fixture root: the root form plus the relative tail, so a subdirectory is still one stable field.
        let tail = cwd.strip_prefix(root).unwrap_or(cwd);
        if tail.as_os_str().is_empty() {
            "@ROOT@".to_owned()
        } else {
            format!("@ROOT@/{}", tail.to_string_lossy())
        }
    } else {
        uncacheable(format!(
            "cwd outside the root: {}",
            canon(&cwd.to_string_lossy())
        ));
        canon(&cwd.to_string_lossy())
    };
    let env_field = env_field(env, &canon);
    let stdin_field = stdin.map_or_else(|| "none".to_owned(), sha256_hex);
    let fixture = fixture_field(root, &mut uncacheable);
    argv_scan(args, cwd, root, &mut uncacheable);
    mode_scan(args, &mut uncacheable);
    launcher_scan(cwd, root, env, &canon, &mut uncacheable);

    let mut fields = Vec::new();
    for (name, value) in [
        ("code", code.as_str()),
        ("node", node.as_str()),
        ("argv", argv.as_str()),
        ("cwd", cwd_field.as_str()),
        ("env", env_field.as_str()),
        ("stdin", stdin_field.as_str()),
        ("fixture", fixture.as_str()),
    ] {
        fields.extend_from_slice(name.as_bytes());
        fields.push(0);
        fields.extend_from_slice(&(value.len() as u64).to_le_bytes());
        fields.extend_from_slice(value.as_bytes());
    }
    let mut hashed = b"dfo-oracle/v1\0".to_vec();
    hashed.extend_from_slice(&fields);

    // One entry per line: the summary collapses whitespace, so a batch oracle's `-e` program text stays on one line.
    let text = args
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let summary = if text.chars().count() > 120 {
        format!("{}...", text.chars().take(117).collect::<String>())
    } else {
        text
    };
    let verdict = match reason {
        None => "cacheable".to_owned(),
        Some(why) => format!("uncacheable:{why}"),
    };
    (sha256_hex(&hashed), summary, verdict)
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Every variable the child sees, minus the deny-list, sorted, with the root and `HOME` canonicalised. This mirrors
/// [`apply_env`]: the parent's inherited env, the host's `LC_*` dropped, the pinned locale and `HOME`, then the extras.
fn env_field(env: &[(&str, &OsStr)], canon: &dyn Fn(&str) -> String) -> String {
    let mut view: BTreeMap<String, String> = std::env::vars_os()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect();
    for name in LC_VARS {
        view.remove(name);
    }
    view.retain(|name, _| {
        !ENV_DENY.contains(&name.as_str()) && !ENV_DENY_PREFIX.iter().any(|p| name.starts_with(p))
    });
    view.insert("LC_ALL".to_owned(), "en_US.UTF-8".to_owned());
    view.insert("LANG".to_owned(), "en_US.UTF-8".to_owned());
    view.insert(
        "HOME".to_owned(),
        home_root().to_string_lossy().into_owned(),
    );
    for (name, value) in env {
        view.insert((*name).to_owned(), value.to_string_lossy().into_owned());
    }
    view.iter()
        .map(|(name, value)| format!("{name}={}", canon(value)))
        .collect::<Vec<_>>()
        .join("\u{0}")
}

/// `sha256` over every entry under the root: `(relpath, kind, mode, len, sha256, mtime_ns)`. A file whose mtime is
/// fresh is a fixture written during this run, so the key could never be reused: uncacheable until the case pins it.
fn fixture_field(root: Option<&Path>, uncacheable: &mut dyn FnMut(String)) -> String {
    let Some(root) = root else {
        return "none".to_owned();
    };
    let mut entries = Vec::new();
    if let Err(why) = walk_fixture(root, root, &mut entries, uncacheable) {
        uncacheable(why);
        return "none".to_owned();
    }
    entries.sort();
    let mut bytes = Vec::new();
    for (rel, kind, mode, len, sha, mtime) in entries {
        bytes.extend_from_slice(rel.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(kind.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&mode.to_le_bytes());
        bytes.extend_from_slice(&len.to_le_bytes());
        bytes.extend_from_slice(&sha);
        bytes.extend_from_slice(&mtime.to_le_bytes());
    }
    sha256_hex(&bytes)
}

type FixtureEntry = (String, String, u16, u64, [u8; 32], i128);

fn walk_fixture(
    root: &Path,
    dir: &Path,
    entries: &mut Vec<FixtureEntry>,
    uncacheable: &mut dyn FnMut(String),
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let listing =
        fs::read_dir(dir).map_err(|e| format!("fixture unreadable: {}: {e}", dir.display()))?;
    for entry in listing {
        let entry = entry.map_err(|e| format!("fixture unreadable: {}: {e}", dir.display()))?;
        let path = entry.path();
        let rel = match path.strip_prefix(root) {
            Ok(rel) => rel.to_string_lossy().into_owned(),
            Err(_) => return Err("fixture path outside the root".to_owned()),
        };
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| format!("fixture unreadable: {}: {e}", path.display()))?;
        let mode = (meta.permissions().mode() & 0o777) as u16;
        if meta.file_type().is_symlink() {
            uncacheable(format!("fixture symlink: {rel}"));
        } else if meta.is_dir() {
            // A directory's own mtime moves whenever an entry is created, so only files carry one into the key.
            entries.push((rel, "dir".to_owned(), mode, 0, [0u8; 32], 0));
            walk_fixture(root, &path, entries, uncacheable)?;
        } else if meta.is_file() {
            let sha = sha256(
                &fs::read(&path)
                    .map_err(|e| format!("fixture unreadable: {}: {e}", path.display()))?,
            );
            if is_fresh(&meta) {
                uncacheable(format!("fixture mtime not pinned: {rel}"));
            }
            entries.push((
                rel,
                "file".to_owned(),
                mode,
                meta.len(),
                sha,
                mtime_ns(&meta),
            ));
        } else {
            uncacheable(format!("fixture special file: {rel}"));
        }
    }
    Ok(())
}

/// A fixture file's mtime has to predate the run for the key to be reusable; anything fresher is written by the case.
fn is_fresh(meta: &fs::Metadata) -> bool {
    match (meta.modified(), SystemTime::now().checked_sub(PINNED_MTIME)) {
        (Ok(stamp), Some(cutoff)) => stamp >= cutoff,
        _ => true,
    }
}

fn mtime_ns(meta: &fs::Metadata) -> i128 {
    match meta.modified() {
        Ok(stamp) => match stamp.duration_since(UNIX_EPOCH) {
            Ok(since) => since.as_nanos() as i128,
            Err(before) => -(before.duration().as_nanos() as i128),
        },
        Err(_) => 0,
    }
}

/// The shapes the design names as uncacheable by argv alone: a `firmament` card without `--refresh` reads the JS's own
/// `.cache/firmament-plans.json`, and a `probe` without an explicit file discovers a capture under `$HOME`.
fn mode_scan(args: &[&str], uncacheable: &mut dyn FnMut(String)) {
    let has = |flag: &str| {
        args.iter()
            .any(|arg| *arg == flag || arg.starts_with(&format!("{flag}=")))
    };
    if args.first() == Some(&"firmament") && !has("--refresh") {
        uncacheable("firmament without --refresh".to_owned());
    }
    if args.first() == Some(&"probe") {
        let positional = args
            .iter()
            .skip(1)
            .find(|arg| !arg.starts_with('-'))
            .is_some();
        if !positional && !has("--data") {
            uncacheable("probe without an explicit file".to_owned());
        }
    }
}

/// An argv token that names an existing path outside the root and the repository is an input the key cannot cover.
fn argv_scan(args: &[&str], cwd: &Path, root: Option<&Path>, uncacheable: &mut dyn FnMut(String)) {
    for token in args {
        if token.starts_with('-') || token.is_empty() {
            continue;
        }
        let candidate = Path::new(token);
        let candidate = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            cwd.join(candidate)
        };
        let Ok(real) = fs::canonicalize(&candidate) else {
            continue;
        };
        let inside_root = root.is_some_and(|root| real.starts_with(root) || same_dir(&real, root));
        if !inside_root && !real.starts_with(repo_root()) {
            uncacheable(format!("argv path outside the root: {token}"));
        }
    }
}

/// The launcher `config.json` and the `SPELLS.STD` it points at, as the child resolves them (`src/spells.js:82-93`,
/// `src/save.js:17-40`): inside the root the fixture hash covers them, outside it the call is uncacheable. A missing
/// config is not an input, because nothing is read.
fn launcher_scan(
    cwd: &Path,
    root: Option<&Path>,
    env: &[(&str, &OsStr)],
    canon: &dyn Fn(&str) -> String,
    uncacheable: &mut dyn FnMut(String),
) {
    let Some(root) = root else {
        return;
    };
    let child_env = |name: &str| {
        env.iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| PathBuf::from(value))
    };
    let user_data = child_env("DAGGER_USER_DATA").or_else(|| {
        let home = child_env("HOME").unwrap_or_else(|| home_root().to_path_buf());
        // shortcut: the Linux user-data base only; the macOS and Windows bases are unused by the CLI tests.
        Some(
            std::env::var_os("XDG_CONFIG_HOME").map_or_else(|| home.join(".config"), PathBuf::from),
        )
        .map(|base| base.join("Daggerfall JavaScript"))
    });
    let Some(user_data) = user_data else {
        return;
    };
    let user_data = if user_data.is_absolute() {
        user_data
    } else {
        cwd.join(user_data)
    };
    let config = user_data.join("config.json");
    if !config.exists() {
        return;
    }
    if !config.starts_with(root) {
        uncacheable(format!(
            "launcher config outside the root: {}",
            canon(&config.to_string_lossy())
        ));
        return;
    }
    let Some(cfg) = fs::read_to_string(&config)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter(serde_json::Value::is_object)
    else {
        return;
    };
    let Some(arena2) = cfg.get("arena2Path").and_then(|path| path.as_str()) else {
        return;
    };
    if arena2.is_empty() {
        return;
    }
    let arena2 = if Path::new(arena2).is_absolute() {
        PathBuf::from(arena2)
    } else {
        cwd.join(arena2)
    };
    let spells = arena2.join("SPELLS.STD");
    if spells.exists() && !spells.starts_with(root) {
        uncacheable(format!(
            "launcher SPELLS.STD outside the root: {}",
            canon(&spells.to_string_lossy())
        ));
    }
}

/// The design's `code` field: `bin/`, `src/`, `vendor/` and `package.json` under [`js_root`], hashed once per process.
/// `DFO_ORACLE_JS_ROOT` (the key test only) bypasses the cache, because the test flips files in one process.
fn code_fingerprint() -> Result<String, String> {
    static CODE: OnceLock<Result<String, String>> = OnceLock::new();
    if std::env::var_os("DFO_ORACLE_JS_ROOT").is_some() {
        return code_fingerprint_at(&js_tree());
    }
    CODE.get_or_init(|| code_fingerprint_at(&js_tree())).clone()
}

fn code_fingerprint_at(base: &Path) -> Result<String, String> {
    let mut entries: Vec<(String, [u8; 32])> = Vec::new();
    for top in ["bin", "src", "vendor"] {
        walk_code(base, &base.join(top), &mut entries)?;
    }
    let package = base.join("package.json");
    entries.push((
        "package.json".to_owned(),
        sha256(&fs::read(&package).map_err(|e| format!("code unreadable: package.json: {e}"))?),
    ));
    entries.sort();
    let mut bytes = Vec::new();
    for (rel, sha) in entries {
        bytes.extend_from_slice(rel.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&sha);
    }
    Ok(sha256_hex(&bytes))
}

fn walk_code(base: &Path, dir: &Path, entries: &mut Vec<(String, [u8; 32])>) -> Result<(), String> {
    for entry in
        fs::read_dir(dir).map_err(|e| format!("code unreadable: {}: {e}", dir.display()))?
    {
        let entry = entry.map_err(|e| format!("code unreadable: {}: {e}", dir.display()))?;
        let path = entry.path();
        let rel = match path.strip_prefix(base) {
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => return Err("code path outside the repository".to_owned()),
        };
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| format!("code unreadable: {}: {e}", path.display()))?;
        if meta.file_type().is_symlink() {
            return Err(format!("symlink in code tree: {rel}"));
        }
        if meta.is_dir() {
            walk_code(base, &path, entries)?;
        } else if meta.is_file() {
            entries.push((
                rel,
                sha256(
                    &fs::read(&path)
                        .map_err(|e| format!("code unreadable: {}: {e}", path.display()))?,
                ),
            ));
        } else {
            return Err(format!("special file in code tree: {rel}"));
        }
    }
    Ok(())
}

/// The design's `node` field: `process.version`, `process.versions.icu`, `unicode` and `tz`, read once per process.
fn node_fingerprint() -> Result<String, String> {
    static NODE: OnceLock<Result<String, String>> = OnceLock::new();
    NODE.get_or_init(|| {
        let out = Command::new("node")
            .arg("-p")
            .arg(r#"process.version+"|"+process.versions.icu+"|"+process.versions.unicode+"|"+process.versions.tz"#)
            .output()
            .map_err(|e| format!("node fingerprint: {e}"))?;
        if !out.status.success() {
            return Err("node fingerprint failed".to_owned());
        }
        String::from_utf8(out.stdout)
            .map(|text| text.trim_end_matches('\n').to_owned())
            .map_err(|_| "node fingerprint is not UTF-8".to_owned())
    })
    .clone()
}

// ---------------------------------------------------------------------------------------------------------------------
// SHA-256 (FIPS 180-4): 60 lines beat a new dependency for the test harness; the first call pins it to two published
// vectors.

fn sha256(data: &[u8]) -> [u8; 32] {
    self_check();
    sha256_raw(data)
}

fn sha256_raw(data: &[u8]) -> [u8; 32] {
    const H0: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state = H0;
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&(data.len() as u64).wrapping_mul(8).to_be_bytes());
    for chunk in message.chunks(64) {
        let mut words = [0u32; 64];
        for (i, word) in words.iter_mut().take(16).enumerate() {
            let at = 4 * i;
            *word = u32::from_be_bytes([chunk[at], chunk[at + 1], chunk[at + 2], chunk[at + 3]]);
        }
        for i in 16..64 {
            let s0 = words[i - 15].rotate_right(7)
                ^ words[i - 15].rotate_right(18)
                ^ (words[i - 15] >> 3);
            let s1 = words[i - 2].rotate_right(17)
                ^ words[i - 2].rotate_right(19)
                ^ (words[i - 2] >> 10);
            words[i] = words[i - 16]
                .wrapping_add(s0)
                .wrapping_add(words[i - 7])
                .wrapping_add(s1);
        }
        let mut w = state;
        for i in 0..64 {
            let s1 = w[4].rotate_right(6) ^ w[4].rotate_right(11) ^ w[4].rotate_right(25);
            let ch = (w[4] & w[5]) ^ (!w[4] & w[6]);
            let t1 = w[7]
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(words[i]);
            let s0 = w[0].rotate_right(2) ^ w[0].rotate_right(13) ^ w[0].rotate_right(22);
            let maj = (w[0] & w[1]) ^ (w[0] & w[2]) ^ (w[1] & w[2]);
            let t2 = s0.wrapping_add(maj);
            w[7] = w[6];
            w[6] = w[5];
            w[5] = w[4];
            w[4] = w[3].wrapping_add(t1);
            w[3] = w[2];
            w[2] = w[1];
            w[1] = w[0];
            w[0] = t1.wrapping_add(t2);
        }
        for i in 0..8 {
            state[i] = state[i].wrapping_add(w[i]);
        }
    }
    let mut out = [0u8; 32];
    for (i, word) in state.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn self_check() {
    static CHECKED: OnceLock<()> = OnceLock::new();
    CHECKED.get_or_init(|| {
        assert_eq!(
            hex(&sha256_raw(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(&sha256_raw(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    });
}

fn sha256_hex(data: &[u8]) -> String {
    hex(&sha256(data))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
