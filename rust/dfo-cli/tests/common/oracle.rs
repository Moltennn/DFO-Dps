//! The JS side of the CLI differential tests, and the dry run of the JS-oracle cache.
//!
//! Every CLI test spawns `node bin/dfo-dps.js` the same way: one locale, one `HOME`, and `DAGGER_USER_DATA` when the
//! case reads or writes a user-data tree. Those spawns live here, once, so a test file keeps only its own `same*()`
//! assertions and the arguments it runs.
//!
//! With `DFO_ORACLE_STATS` set, each JS spawn also computes the design's cache key and appends
//! `key argv-summary cacheable` or `key argv-summary uncacheable:<reason>` to that file. It reads and writes no entry and
//! changes no output: the dry run proves the key is stable and the reasons are honest. With the variable unset nothing is
//! computed beyond the spawn itself.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The repository root: this crate lives at `<repo>/rust/dfo-cli`.
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
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
    let mut command = Command::new("node");
    command
        .arg(repo_root().join("bin").join("dfo-dps.js"))
        .args(args)
        .current_dir(cwd);
    apply_env(&mut command, env);
    log_call(cwd, root, args, env, stdin);
    finish(command, stdin)
}

/// A batch oracle: `node <args...>` with the call list on stdin (the `-e` program text is part of `args`). Its only
/// fixture input is the code tree itself, so there is no fixture root to hash.
pub fn js_batch(args: &[&str], stdin: &[u8]) -> Output {
    let cwd = repo_root();
    let mut command = Command::new("node");
    command.args(args).current_dir(&cwd);
    apply_env(&mut command, &[]);
    log_call(&cwd, None, args, &[], Some(stdin));
    finish(command, Some(stdin))
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

fn log_call(
    cwd: &Path,
    root: Option<&Path>,
    args: &[&str],
    env: &[(&str, &OsStr)],
    stdin: Option<&[u8]>,
) {
    let Some(stats) = std::env::var_os("DFO_ORACLE_STATS") else {
        return;
    };
    let (key, summary, verdict) = compute(cwd, root, args, env, stdin);
    static FILE_LOCK: Mutex<()> = Mutex::new(());
    let _guard = FILE_LOCK.lock();
    if let Ok(mut out) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(PathBuf::from(stats))
    {
        let _ = writeln!(out, "{key} {summary} {verdict}");
    }
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

/// The design's `code` field: `bin/`, `src/`, `vendor/` and `package.json`, hashed once per process.
fn code_fingerprint() -> Result<String, String> {
    static CODE: OnceLock<Result<String, String>> = OnceLock::new();
    CODE.get_or_init(|| {
        let base = repo_root();
        let mut entries: Vec<(String, [u8; 32])> = Vec::new();
        for top in ["bin", "src", "vendor"] {
            walk_code(&base, &base.join(top), &mut entries)?;
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
    })
    .clone()
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
