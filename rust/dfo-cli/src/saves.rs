//! Read-only save discovery and loading: the I/O half of `src/save.js` (`:17-104`), which `dfo-core` deliberately does
//! not own. It also resolves the launcher's `config.json` to the ARENA2 directory and loads `SPELLS.STD` into the
//! caller-owned [`Spellbook`] (`src/save.js:28-40`, `src/spells.js:72-93`): the core parses the bytes, this file only
//! opens them.
//!
//! A save is discovered under the DFO user-data folder (`DAGGER_USER_DATA` first, then the client's platform folder),
//! opened once for reading and parsed to a [`Value`]; nothing here writes, copies or retains the document. The
//! character a save becomes is `dfo_core::save::character_from_save` (AGENTS.md rule 11: the core does no file I/O).
//!
//! HOSTILE INPUT: the read is bounded by [`MAX_SAVE_BYTES`], and `serde_json` refuses a document nested past its own
//! recursion limit, so a runaway or crafted file is an ordinary error rather than an unbounded allocation or a stack
//! overflow. Errors can identify the source path, but do not include save contents.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use dfo_core::spells::{read_spells_std, spells_by_index_map, Spellbook};
use dfo_core::value::Value;
use serde_json::Value as JsonValue;

/// The largest document this will read (a save or a `SaveInfo.txt`): 64 MiB, as the workbench import uses. A real
/// `SaveData.txt` is a few hundred KiB, so this refuses a runaway file while leaving ordinary saves untouched.
pub const MAX_SAVE_BYTES: u64 = 64 * 1024 * 1024;

/// The largest `SPELLS.STD` this will read. The stock file is under 8 KiB; the cap only stops a runaway replacement
/// from being read whole (the JS `readFileSync` has no bound, so this is a port choice, not a behaviour change).
pub const MAX_SPELL_BYTES: u64 = 8 * 1024 * 1024;

/// One save folder, as `listSaves` reports it (`src/save.js:47-70`).
#[derive(Debug, Clone, PartialEq)]
pub struct SaveEntry {
    pub slot: String,
    pub folder: PathBuf,
    pub file: PathBuf,
    /// `statSync(data).mtimeMs`: milliseconds since the epoch.
    pub mtime: f64,
    /// `SaveInfo.txt`'s `saveName || folder name`.
    pub name: String,
    /// `SaveInfo.txt`'s `characterName || ''`.
    pub character: String,
}

/// `os.homedir()`: `HOME` as Node's libuv reads it (an empty value is that empty path, not a fallback), else the OS
/// user database; on Windows `USERPROFILE` is the variable. The fallback matters because a relative path would make
/// save discovery read the working directory - `HOME` unset on Linux must not turn `<cwd>/.config` into the user data.
fn home() -> PathBuf {
    let var = if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    };
    if let Some(value) = std::env::var_os(var) {
        return PathBuf::from(value);
    }
    std::env::home_dir().unwrap_or_default()
}

/// A set, non-empty environment variable. `process.env.X` is falsy for both, so neither counts.
fn non_empty_env(name: &str) -> Option<String> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string_lossy().into_owned())
}

/// `path.resolve(p)`: an absolute path, or the working directory joined with a relative one.
fn absolute(p: &str) -> PathBuf {
    let path = Path::new(p);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

/// `userDataDir(home)` (`src/save.js:17-26`): `DAGGER_USER_DATA`, else the client's platform user-data folder.
pub fn user_data_dir() -> PathBuf {
    if let Some(dir) = non_empty_env("DAGGER_USER_DATA") {
        return absolute(&dir);
    }
    let home = home();
    let base = if cfg!(target_os = "windows") {
        non_empty_env("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        Some(home.join("Library").join("Application Support"))
    } else {
        non_empty_env("XDG_CONFIG_HOME").map(PathBuf::from)
    };
    base.unwrap_or_else(|| home.join(".config"))
        .join("Daggerfall JavaScript")
}

/// `savesDir(home)` (`src/save.js:42-44`).
pub fn saves_dir() -> PathBuf {
    user_data_dir().join("Saves")
}

/// `configPath(home)` (`src/save.js:28-30`): the launcher's `config.json` in the user-data folder.
pub fn config_path() -> PathBuf {
    user_data_dir().join("config.json")
}

/// The launcher's `arena2Path` exactly as `arena2Dir()` reads it (`src/save.js:33-40`, `cfg.arena2Path || null`):
/// `None` when the config is missing, unparseable or not an object, and `None` for a falsy `arena2Path` (empty string,
/// `0`, `false`, `null`). Any truthy value is `Some`, string or not: the JS does not type-check it, and a non-string
/// makes `path.join` throw later - a distinction [`launcher_book`] keeps.
fn launcher_path() -> Option<Value> {
    let cfg = read_json(&config_path()).ok()?;
    if !matches!(cfg, Value::Obj(_)) {
        return None;
    }
    let path = cfg.get("arena2Path");
    path.truthy().then(|| path.clone())
}

/// The launcher arm of `standardSpells()` (`src/spells.js:82-93`) as the JS module cache fills it: `None` only when
/// `arena2Dir()` is falsy, i.e. when the JS `if (!resolved) return new Map()` fires and a caller's `dir` can still win.
/// `Some` otherwise, though the book may itself be empty (a missing/oversized file, or a truthy non-string
/// `arena2Path`, which makes `path.join` throw inside the JS `try`).
pub fn launcher_book() -> Option<Spellbook> {
    let path = launcher_path()?;
    Some(match path.as_str() {
        Some(_) => load_spellbook_from(&absolute(&path.to_js_string())),
        None => Spellbook::default(),
    })
}

/// `standardSpells()` (`src/spells.js:82-93`) minus the module cache: the launcher's `SPELLS.STD` as a caller-owned
/// [`Spellbook`]. A missing config, a missing/oversized/unreadable file, or an unusable path is an empty book, exactly
/// as the JS's `try`/`catch` returns a fresh empty `Map` without caching it.
pub fn load_spellbook() -> Spellbook {
    launcher_book().unwrap_or_default()
}

/// `standardSpells(values.data ?? undefined)` as one fresh process observes it (`src/cli.js:1520`, `src/spells.js:82-93`).
///
/// The JS `_standard` cache is filled before the `spell` branch: `loadCharacter`'s `legalGear` (including for
/// `--theory`) and the CLI's own `analyze` both call `standardSpells()` with no argument. So a resolvable launcher
/// config - even one whose `SPELLS.STD` is missing or unreadable, or whose `arena2Path` is a truthy non-string - wins,
/// and the branch's `--data` is ignored. Only when `arena2Dir()` is falsy does `standardSpells(dataDir)` return (and
/// cache) the explicit directory; with neither the book is empty. Reproduced rather than "fixed": `--data` is honoured
/// exactly when the launcher has no usable config, and the differential pins both arms.
pub fn standard_spells(data: Option<&str>) -> Spellbook {
    launcher_book().unwrap_or_else(|| {
        data.map_or_else(Spellbook::default, |dir| {
            load_spellbook_from(Path::new(dir))
        })
    })
}

/// `standardSpells(dir)` with an explicit directory (`--data`): the same bounded read and empty-book fallback, so a
/// missing, oversized or unreadable `SPELLS.STD` is the JS `try`/`catch`'s empty map. A falsy `dir` (the JS
/// `if (!resolved) return new Map()`) is the empty book without touching the filesystem.
pub fn load_spellbook_from(dir: &Path) -> Spellbook {
    if dir.as_os_str().is_empty() {
        return Spellbook::default();
    }
    match read_bounded(&dir.join("SPELLS.STD"), MAX_SPELL_BYTES) {
        Ok(bytes) => spells_by_index_map(read_spells_std(&bytes)),
        Err(_) => Spellbook::default(),
    }
}

/// Read a file at most `limit` bytes; a bigger one is an error (`take` reads one byte past to tell the two apart).
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, std::io::Error> {
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file larger than the limit",
        ));
    }
    Ok(bytes)
}

/// `JSON.parse(fs.readFileSync(path))` for the files here, as the JS-like [`Value`] the core reads.
///
/// `serde_json` keeps an object's own key order (`preserve_order`), rejects malformed text, and, like `JSON.parse`,
/// keeps the last of two duplicate keys. A number too large for an f64 is a parse error where JS gives `Infinity`.
fn read_json(path: &Path) -> Result<Value, String> {
    let file =
        fs::File::open(path).map_err(|e| format!("could not open the file: {}", e.kind()))?;
    let mut text = String::new();
    // `take` bounds the allocation; reading one byte past the limit distinguishes "at the limit" from "over".
    file.take(MAX_SAVE_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("could not read the file: {}", e.kind()))?;
    if text.len() as u64 > MAX_SAVE_BYTES {
        return Err(format!(
            "the file is larger than the {} MiB limit",
            MAX_SAVE_BYTES / (1024 * 1024)
        ));
    }
    let doc: JsonValue = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(json_to_value(&doc))
}

/// `JsonValue` to the core's [`Value`]; `Value::set` puts an integer-like key in JS order.
fn json_to_value(v: &JsonValue) -> Value {
    match v {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(b) => Value::Bool(*b),
        JsonValue::Number(n) => Value::Num(n.as_f64().unwrap_or(f64::NAN)),
        JsonValue::String(s) => Value::Str(s.clone()),
        JsonValue::Array(items) => Value::Arr(items.iter().map(json_to_value).collect()),
        JsonValue::Object(map) => {
            let mut out = Value::Obj(Vec::new());
            for (k, v) in map {
                out.set(k, json_to_value(v));
            }
            out
        }
    }
}

/// `statSync(file).mtimeMs`, in milliseconds, computed the way Node does (`sec * 1000 + nsec / 1e6`, which keeps the
/// double's precision).
fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6)
        .unwrap_or(0.0)
}

/// All `SAVE*` folders that have a `SaveData.txt`, newest first (`src/save.js:47-70`). A missing `Saves` folder is an
/// empty list (`readdirSync` is caught). The folder names sort first and both sorts are stable, as the JS's are.
pub fn list_saves() -> Result<Vec<SaveEntry>, String> {
    let dir = saves_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let folder = dir.join(&name);
        let data = folder.join("SaveData.txt");
        if !data.exists() {
            continue;
        }
        // `SaveInfo.txt` is optional: a missing or malformed one is ignored.
        let info = read_json(&folder.join("SaveInfo.txt")).ok();
        let text = |key: &str| {
            info.as_ref()
                .map(|i| i.get(key))
                .filter(|v| v.truthy())
                .map(|v| v.to_js_string())
        };
        let stat = fs::metadata(&data).map_err(|e| e.kind().to_string())?;
        out.push(SaveEntry {
            slot: name.clone(),
            folder,
            file: data,
            mtime: mtime_ms(&stat),
            name: text("saveName").unwrap_or(name),
            character: text("characterName").unwrap_or_default(),
        });
    }
    out.sort_by(|a, b| {
        b.mtime
            .partial_cmp(&a.mtime)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

/// Resolve a save argument: a path, a save folder name, or a slot number (`src/save.js:72-94`). An empty reference
/// takes the newest save.
pub fn resolve_save(reference: &str) -> Result<SaveEntry, String> {
    let saves = list_saves()?;
    if reference.is_empty() {
        return saves
            .into_iter()
            .next()
            .ok_or_else(|| format!("no saves found under {}", saves_dir().to_string_lossy()));
    }
    let as_path = absolute(reference);
    if as_path.exists() {
        if as_path.is_dir() {
            let file = as_path.join("SaveData.txt");
            if !file.exists() {
                return Err(format!("{} not found", file.to_string_lossy()));
            }
            return Ok(SaveEntry {
                slot: basename(&as_path),
                folder: as_path,
                file,
                mtime: 0.0,
                name: String::new(),
                character: String::new(),
            });
        }
        let folder = as_path.parent().map(Path::to_path_buf).unwrap_or_default();
        return Ok(SaveEntry {
            slot: basename(&folder),
            folder,
            file: as_path,
            mtime: 0.0,
            name: String::new(),
            character: String::new(),
        });
    }
    let wanted = if reference.chars().all(|c| c.is_ascii_digit()) {
        format!("SAVE{reference}")
    } else {
        reference.to_uppercase()
    };
    saves
        .iter()
        .find(|s| s.slot.to_uppercase() == wanted)
        .cloned()
        .ok_or_else(|| {
            let available: Vec<&str> = saves.iter().map(|s| s.slot.as_str()).collect();
            format!(
                "save \"{reference}\" not found. Available: {}",
                if available.is_empty() {
                    "(none)".to_owned()
                } else {
                    available.join(", ")
                }
            )
        })
}

fn basename(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `loadSave(ref)` (`src/save.js:96-104`): the entry and the parsed save document. Read-only.
pub fn load_save(reference: &str) -> Result<(SaveEntry, Value), String> {
    let entry = resolve_save(reference)?;
    let save = read_json(&entry.file)
        .map_err(|e| format!("could not read {}: {e}", entry.file.to_string_lossy()))?;
    if !matches!(save, Value::Obj(_) | Value::Arr(_)) {
        return Err(format!(
            "{} is not a save object",
            entry.file.to_string_lossy()
        ));
    }
    Ok((entry, save))
}

/// `new Date(mtime).toISOString().slice(0, 16).replace('T', ' ')` (`src/cli.js:937`): UTC, to the minute.
pub fn iso_minute(ms: f64) -> String {
    // `new Date(x)` truncates its time value toward zero (TimeClip).
    let t = if ms.is_finite() { ms.trunc() as i64 } else { 0 };
    let days = t.div_euclid(86_400_000);
    let rem = t.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let (hours, minutes) = (rem / 3_600_000, (rem / 60_000) % 60);
    format!("{y:04}-{m:02}-{d:02} {hours:02}:{minutes:02}")
}

/// Days since 1970-01-01 to a proleptic-Gregorian date (Howard Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// JSON.parse rounds a long decimal to the nearest double before the core reads it.
    #[test]
    fn preserves_save_number_rounding() {
        let json = serde_json::from_str("1.00000000000000011102230246251565404236316680908203126")
            .unwrap();
        assert_eq!(
            json_to_value(&json),
            Value::Num(f64::from_bits(1.0f64.to_bits() + 1))
        );
    }

    /// A local invariant (not an oracle check): the formatter's epoch, leap-day and pre-epoch cases.
    #[test]
    fn iso_minute_formats_utc_minutes() {
        assert_eq!(iso_minute(0.0), "1970-01-01 00:00");
        assert_eq!(iso_minute(1_709_251_199_999.0), "2024-02-29 23:59");
        assert_eq!(iso_minute(-1_000.0), "1969-12-31 23:59");
        assert_eq!(iso_minute(f64::NAN), "1970-01-01 00:00");
    }
}
