//! `dfo-cli probe`: the capture discovery and text/`--json` output of `src/cli.js:1266-1302` and `:1385-1386`.
//!
//! The rules are all in `dfo_core::probe` (`src/probe.js`); this module owns only the I/O the core refuses: the newest
//! capture under `~/.local/share/dfo-tools/probe-mod/captures` (or its `old/` folder with `--old`), `JSON.parse`, the
//! text card and `JSON.stringify(summary, null, 2)`.
//!
//! Boundary, deliberately: the probe HTML page (`src/cli.js:1329-1384`, `multiGraphPage`/`writePage`) belongs to the
//! shared HTML/SVG renderer and is not ported here. So this command never writes `probe.html`, never prints the JS
//! `probe page written: <file>` line, and refuses an explicit `--out` instead of accepting a file it would not write.
//! The text card and the JSON document are otherwise byte-for-byte the JS ones. Discovery reads `capturedAt` the same
//! way `Date.parse(...) || mtime` does, but the parser here understands only the ISO-8601 shapes a capture writes: a
//! timezone-less stamp is read as UTC (V8 reads the host's local zone), and a shape V8 would also parse but this does
//! not (a bare year such as `2026`, a numeric stamp) keeps the file's mtime. A malformed capture's `JSON.parse` message
//! is `serde_json`'s, not V8's, as everywhere else in this CLI.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use dfo_core::probe::summarize_probe;
use dfo_core::value::{number_to_string, Value};
use serde_json::Value as JsonValue;

use crate::{fmt, json, pc, table, CliError};

/// `probe [capture.json]`, `--data <capture>`, `--old`, `--level`, `--players`, `--json`.
///
/// `level`/`players` are `Some` only when the flag was given, as the JS `levelOverride`/`playersOverride` reads them
/// from `argv` rather than from the parsed defaults.
pub fn command(
    positional: Option<&str>,
    data_flag: Option<&str>,
    old: bool,
    level: Option<f64>,
    players: Option<f64>,
    as_json: bool,
    out_given: bool,
) -> Result<String, CliError> {
    if out_given {
        return Err(CliError {
            message: "--out is not supported by this CLI slice yet: the probe page HTML needs the shared renderer"
                .into(),
            code: 2,
        });
    }
    // `parsed.positionals[1] ?? values.data`, then `if (!file)`: an empty string is falsy in JS, so it falls through
    // to discovery rather than reading the working directory.
    let named = positional.or(data_flag).filter(|f| !f.is_empty());
    let file = match named {
        Some(file) => file.to_owned(),
        None => latest_capture(old)?,
    };
    let path = absolute(&file);
    let capture = read_json(&path).map_err(|e| CliError {
        message: format!("probe: cannot read {file}: {e}"),
        code: 2,
    })?;
    let opts = match (level, players) {
        (None, None) => Value::Obj(Vec::new()),
        (level, players) => {
            let mut opts = Value::Obj(Vec::new());
            if let Some(level) = level {
                opts.set("level", Value::Num(level));
            }
            if let Some(players) = players {
                opts.set("players", Value::Num(players));
            }
            opts
        }
    };
    let summary =
        summarize_probe(&capture, &opts).map_err(|message| CliError { message, code: 1 })?;
    if as_json {
        return Ok(format!("{}\n", json(&summary)));
    }
    Ok(text(&summary))
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

/// `os.homedir()`: `HOME`, then `USERPROFILE`.
fn home() -> PathBuf {
    ["HOME", "USERPROFILE"]
        .iter()
        .find_map(|name| {
            std::env::var_os(name)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_default()
}

/// `path.join(os.homedir(), '.local/share/dfo-tools/probe-mod/captures')` (`src/cli.js:1269`).
fn captures_dir() -> PathBuf {
    home()
        .join(".local")
        .join("share")
        .join("dfo-tools")
        .join("probe-mod")
        .join("captures")
}

/// The newest `.json` in the live capture folder, or in `old/` with `--old` (`src/cli.js:1269-1287`): a capture's
/// `capturedAt` (via [`date_parse`]) outranks the file's mtime; an unreadable or unstamped file keeps its mtime.
fn latest_capture(old: bool) -> Result<String, CliError> {
    let live = captures_dir();
    let dir = if old { live.join("old") } else { live };
    let mut latest: Option<(String, f64)> = None;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".json") {
                continue;
            }
            let full = dir.join(&name);
            let mut at = mtime_ms(&full);
            if let Ok(capture) = read_json(&full) {
                let stamp = capture.get("capturedAt");
                // `Date.parse(...) || at`: a zero stamp (epoch) also keeps the mtime, and so does an unparsed one.
                if let Some(parsed) = date_parse(&stamp.to_js_string()).filter(|p| *p != 0.0) {
                    at = parsed;
                }
            }
            if latest.as_ref().is_none_or(|(_, best)| at > *best) {
                latest = Some((full.to_string_lossy().into_owned(), at));
            }
        }
    }
    latest.map(|(file, _)| file).ok_or_else(|| CliError {
        message: format!(
            "probe: no capture in {}{}",
            dir.display(),
            if old {
                ""
            } else {
                " (try --old for captures/old)"
            }
        ),
        code: 2,
    })
}

/// `statSync(file).mtimeMs`, computed the way Node does.
fn mtime_ms(path: &Path) -> f64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6)
        .unwrap_or(0.0)
}

/// The largest capture read, as `saves::MAX_SAVE_BYTES`: a real capture is a few MiB, a runaway is refused.
const MAX_CAPTURE_BYTES: u64 = 64 * 1024 * 1024;

/// `JSON.parse(fs.readFileSync(path, 'utf8'))`, read-only. `serde_json` keeps key order and rejects malformed text; a
/// malformed document's message is the parser's own, so it is not byte-identical to V8's (documented above).
fn read_json(path: &Path) -> Result<Value, String> {
    let file = fs::File::open(path).map_err(|e| node_error(&e, path))?;
    let mut text = String::new();
    file.take(MAX_CAPTURE_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|e| node_error(&e, path))?;
    if text.len() as u64 > MAX_CAPTURE_BYTES {
        return Err("capture is larger than the 64 MiB limit".into());
    }
    let doc: JsonValue = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(json_to_value(&doc))
}

/// Node's own `ENOENT`/`EISDIR` wording (it appends the path and the operation), so the one-line refusal reads like
/// the JS one where Rust has the same fact. Any other OS error keeps Rust's message.
fn node_error(e: &std::io::Error, path: &Path) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => {
            format!(
                "ENOENT: no such file or directory, open '{}'",
                path.display()
            )
        }
        std::io::ErrorKind::IsADirectory => {
            "EISDIR: illegal operation on a directory, read".to_owned()
        }
        _ => e.to_string(),
    }
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

/// `Date.parse(text)` for a capture's `capturedAt`: `YYYY-MM-DD`, then an optional `T`/space time `HH:MM[:SS[.fff]]`
/// with an optional `Z` or `±HH:MM` offset. Anything else is `None`, and the caller keeps the mtime (as `|| at` does).
/// A stamp without an offset is read as UTC; V8 reads the host's local zone - documented in this module's header.
/// shortcut: only the ISO shapes a capture writes; a format V8 parses and this rejects falls back to the mtime, which
/// only reorders discovery. Upgrade if a capture format ever writes another stamp shape.
fn date_parse(text: &str) -> Option<f64> {
    let text = text.trim();
    // Byte slicing below assumes ASCII; `Date.parse` understands only ASCII date shapes anyway.
    if !text.is_ascii() || text.len() < 10 {
        return None;
    }
    let date = &text[..10];
    let rest = &text[10..];
    let (y, m, d) = (
        int_part(&date[..4])?,
        int_part(&date[5..7])?,
        int_part(&date[8..10])?,
    );
    if date.as_bytes()[4] != b'-' || date.as_bytes()[7] != b'-' || !(1..=12).contains(&m) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut millis, mut offset_ms) = (0, 0, 0, 0, 0);
    if !rest.is_empty() {
        let rest = rest.strip_prefix('T').or_else(|| rest.strip_prefix(' '))?;
        if rest.len() < 5 {
            return None;
        }
        hour = int_part(&rest[..2])?;
        minute = int_part(&rest[3..5])?;
        if rest.as_bytes()[2] != b':' || hour > 23 || minute > 59 {
            return None;
        }
        let mut tail = &rest[5..];
        if let Some(after) = tail.strip_prefix(':') {
            if after.len() < 2 {
                return None;
            }
            second = int_part(&after[..2])?;
            tail = &after[2..];
            if second > 59 {
                return None;
            }
        }
        if let Some(after) = tail.strip_prefix('.') {
            let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
            if digits.is_empty() {
                return None;
            }
            millis = int_part(&format!("{digits:0<3}")[..3])?;
            tail = &after[digits.len()..];
        }
        if tail == "Z" || tail == "z" {
            tail = "";
        } else if let Some(after) = tail.strip_prefix(['+', '-']) {
            let sign = if tail.starts_with('-') { -1 } else { 1 };
            let (oh, om) = match after.len() {
                2 => (int_part(after)?, 0),
                5 if after.as_bytes()[2] == b':' => {
                    (int_part(&after[..2])?, int_part(&after[3..5])?)
                }
                _ => return None,
            };
            offset_ms = sign * (oh * 3_600_000 + om * 60_000);
            tail = "";
        }
        if !tail.is_empty() {
            return None;
        }
    }
    let days = days_from_civil(y, m, d);
    Some(
        days as f64 * 86_400_000.0
            + hour as f64 * 3_600_000.0
            + minute as f64 * 60_000.0
            + second as f64 * 1000.0
            + millis as f64
            - offset_ms as f64,
    )
}

fn int_part(s: &str) -> Option<i64> {
    (!s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

/// Days since 1970-01-01 for a proleptic-Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The `--json` or text output of `src/cli.js:1293-1301`.
fn text(summary: &Value) -> String {
    let fights = summary.get("fights").items();
    let mut out = format!(
        "Combat Probe  |  {} fight{}  |  level {}, {} player{}  |  build {}\n",
        fights.len(),
        if fights.len() == 1 { "" } else { "s" },
        summary.get("level").to_js_string(),
        summary.get("players").to_js_string(),
        if summary.get("players").to_number() == 1.0 {
            ""
        } else {
            "s"
        },
        if summary.get("build").truthy() {
            summary.get("build").to_js_string()
        } else {
            "-".to_owned()
        }
    );
    if fights.is_empty() {
        out.push_str(
            "No boss health samples found. Arm the probe before the pull and stop it after.\n",
        );
    }
    for (i, f) in fights.iter().enumerate() {
        out.push_str(&format!(
            "\nFight {}  |  {}  |  {}  |  {} s\n",
            i + 1,
            f.get("content").to_js_string(),
            if f.get("name").truthy() {
                f.get("name").to_js_string()
            } else {
                "boss".to_owned()
            },
            fmt(f.get("seconds"))
        ));
        out.push_str(&table(&fight_rows(f), &["Metric", "Value"], &[false, true]));
        out.push('\n');
    }
    out
}

/// The same row list `src/cli.js:1303-1326` builds, in the same order and with the same fallbacks.
fn fight_rows(f: &Value) -> Vec<Vec<String>> {
    let estimated = f.get("maxHpEstimated").truthy();
    let tilde = if estimated { "~" } else { "" };
    let mid = f.get("midFight").truthy();
    let max_hp = if f.get("maxHp").is_nullish() {
        "-".to_owned()
    } else {
        format!("{tilde}{}", fmt(f.get("maxHp")))
    };
    let damage = if f.get("damage").is_nullish() {
        format!("{}%", fmt(f.get("hpLost")))
    } else {
        format!("{tilde}{}", fmt(f.get("damage")))
    };
    let dps = if f.get("dps").is_nullish() {
        "-".to_owned()
    } else if mid {
        format!("{tilde}{} (since join)", fmt(f.get("dpsSinceJoin")))
    } else {
        format!("{tilde}{}", fmt(f.get("dps")))
    };
    let mut rows: Vec<Vec<String>> = vec![
        vec!["Boss health".into(), max_hp],
        vec!["Landing damage".into(), damage],
        vec!["Landed DPS".into(), dps],
        vec![
            "Damage since join".into(),
            if mid {
                fmt(f.get("damageSinceJoin"))
            } else {
                "-".to_owned()
            },
        ],
        vec![
            "Boss heals".into(),
            if f.get("bossHeal").to_number() > 0.0 {
                fmt(f.get("bossHeal"))
            } else {
                "-".to_owned()
            },
        ],
        vec![
            "Joined at".into(),
            if mid {
                format!("{}%", fmt(f.get("joinedAtPct")))
            } else {
                "-".to_owned()
            },
        ],
        vec![
            "Burst 5s".into(),
            if f.get("burst5").is_nullish() {
                "-".to_owned()
            } else {
                format!("{tilde}{}", fmt(f.get("burst5")))
            },
        ],
        vec![
            "Levels".into(),
            format!(
                "{} known / {} players{}",
                f.get("levels").items().len(),
                f.get("players").to_js_string(),
                if estimated {
                    format!(", fill {}", f.get("levelFill").to_js_string())
                } else {
                    String::new()
                }
            ),
        ],
        vec!["Outcome".into(), f.get("outcome").to_js_string()],
        vec![
            "Weapon".into(),
            if f.get("weapon").is_nullish() {
                "-".to_owned()
            } else {
                f.get("weapon").to_js_string()
            },
        ],
        vec![
            "Off hand".into(),
            if f.get("offWeapon").is_nullish() {
                "-".to_owned()
            } else {
                f.get("offWeapon").to_js_string()
            },
        ],
        vec![
            "Imprint".into(),
            if f.get("imprint").is_nullish() {
                "-".to_owned()
            } else {
                f.get("imprint").to_js_string()
            },
        ],
        vec![
            "Largest 0.1s step".into(),
            if f.get("maxStep").is_nullish() {
                format!("{}%", fmt(f.get("maxStepPct")))
            } else {
                fmt(f.get("maxStep"))
            },
        ],
        vec![
            "No-damage time".into(),
            format!(
                "{} s ({})",
                fmt(f.get("immunityS")),
                pc(f.get("immunityShare"))
            ),
        ],
        vec![
            "Warded time".into(),
            if f.get("wardedS").to_number() > 0.0 {
                format!("{} s", fmt(f.get("wardedS")))
            } else {
                "-".to_owned()
            },
        ],
        vec!["Sub-phases".into(), {
            let subs = f.get("subs").items();
            if subs.is_empty() {
                "-".to_owned()
            } else {
                subs.iter()
                    .take(3)
                    .map(|s| {
                        format!(
                            "{} {}s",
                            s.get("name").to_js_string(),
                            fmt(s.get("seconds"))
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            }
        }],
        vec!["Split samples".into(), {
            let halves = f.get("halves").items().len();
            if halves == 0 {
                "-".to_owned()
            } else {
                format!("{halves} samples with halves")
            }
        }],
    ];
    let tops = f.get("chartTop").items();
    if tops
        .iter()
        .any(|r| r.get("best").to_number() > 0.0 || r.get("blows").to_number() > 0.0)
    {
        let zero = |v: &Value| {
            let n = v.to_number();
            if n == 0.0 || n.is_nan() {
                0.0
            } else {
                n
            }
        };
        let best = tops
            .iter()
            .map(|r| zero(r.get("best")))
            .fold(f64::NEG_INFINITY, f64::max);
        let sum = |key: &str| tops.iter().map(|r| zero(r.get(key))).sum::<f64>();
        rows.push(vec!["Top-10 best blow".into(), fmt(&Value::Num(best))]);
        rows.push(vec!["Top-10 blows".into(), number_to_string(sum("blows"))]);
        rows.push(vec![
            "Top-10 falls / healed".into(),
            format!(
                "{} / {}",
                number_to_string(sum("falls")),
                fmt(&Value::Num(sum("healed")))
            ),
        ]);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Local invariants of the two helpers the discovery depends on (no JS oracle here; the CLI differential in
    /// `tests/probe.rs` covers the whole path).
    #[test]
    fn date_parse_reads_the_capture_stamp_shapes() {
        assert_eq!(date_parse("1970-01-01T00:00:00.000Z"), Some(0.0));
        assert_eq!(
            date_parse("2024-02-29T23:59:59.999Z"),
            Some(1_709_251_199_999.0)
        );
        assert_eq!(date_parse("2024-02-29"), Some(1_709_164_800_000.0));
        // A `+02:00` stamp is that many hours before its UTC reading.
        assert_eq!(
            date_parse("2024-02-29T23:59:59.999+02:00"),
            Some(1_709_251_199_999.0 - 7_200_000.0)
        );
        assert_eq!(date_parse("0"), None);
        assert_eq!(date_parse("not a date"), None);
        // Non-ASCII text is not a stamp (and byte slicing never panics on it).
        assert_eq!(date_parse("20é4-02-29T23:59:59.999Z"), None);
        assert_eq!(date_parse("2024-02-29Ta:59:59"), None);
    }
}
