//! `dfo-cli probe`: the capture discovery, terminal card, HTML page and `--json` output of `src/cli.js:1266-1386`.
//!
//! The rules are all in `dfo_core::probe` (`src/probe.js`); this module owns only the I/O the core refuses: the newest
//! capture under `~/.local/share/dfo-tools/probe-mod/captures` (or its `old/` folder with `--old`), `JSON.parse`, the
//! text card, `JSON.stringify(summary, null, 2)` and the report page. The page's markup is assembled here exactly as
//! `src/cli.js:1329-1384` does, from the shared renderer (`crate::graph`, a port of `src/graph.js`). Like the JS, the
//! page is written in BOTH modes (`probe.html` by default, `--out <file>` otherwise) and only the text mode prints the
//! `probe page written: <file>` line.
//!
//! Deliberate deviations, all on the write path, never on a number:
//! - **The page is create-only.** It is opened with `create_new(true)` (`O_CREAT|O_EXCL`), so no existing file is ever
//!   truncated - not the capture, not an unrelated save or report, not a hard/symlink/dangling alias. An existing
//!   `--out` (including the default `probe.html`, and including the capture itself) is refused with exit 2 and a path
//!   that names the collision; choose a new file. The JS `fs.writeFileSync` truncates instead, so an existing report
//!   path must be removed or renamed first - intentional, and the reason no lexical same-path check is kept.
//! - A write failure returns no partial card on stdout (the JS prints the card before it writes).
//! - Capture-derived text inserted into the page (the chart names in a note, the table's values) is HTML-escaped, where
//!   the JS inserts it raw. Safe captures render byte-identically; a hostile name is shown as text, not markup.
//! - `path.resolve` is normalised here with `Components`; a `..` that climbs above the root is dropped instead of
//!   clamped the Node way. The produced page for a fresh path is byte-identical to the JS's.
//!
//! Discovery reads `capturedAt` the same way `Date.parse(...) || mtime` does, but the parser here understands only the
//! ISO-8601 shapes a capture writes: a timezone-less stamp is read as UTC (V8 reads the host's local zone), and a shape
//! V8 would also parse but this does not (a bare year such as `2026`, a numeric stamp) keeps the file's mtime. A
//! malformed capture's `JSON.parse` message is `serde_json`'s, not V8's, as everywhere else in this CLI, and a write
//! failure's OS text is Rust's where Node's wording differs.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use dfo_core::probe::{chart_totals, summarize_probe};
use dfo_core::value::{number_to_string, Value};
use serde_json::Value as JsonValue;

use crate::graph::{self, escape, LineChart, Point, Section, Series};
use crate::{fmt, json, pc, table, CliError};

/// `probe [capture.json]`, `--data <capture>`, `--old`, `--level`, `--players`, `--json`, `--out <file>`.
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
    out_flag: Option<&str>,
) -> Result<String, CliError> {
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
    // `const out = path.resolve(values.out === 'dfo-dps-report.html' ? 'probe.html' : values.out)` (`:1329`).
    let out = out_path(out_flag);
    write_page(&out, &html(&summary))?;
    if as_json {
        Ok(format!("{}\n", json(&summary)))
    } else {
        Ok(format!(
            "{}probe page written: {}\n",
            text(&summary),
            out.display()
        ))
    }
}

/// `values.out`'s default was `dfo-dps-report.html`, which `probe` renames to `probe.html`, then resolved (`:1329`).
fn out_path(given: Option<&str>) -> PathBuf {
    let name = match given {
        None | Some("dfo-dps-report.html") => "probe.html",
        Some(name) => name,
    };
    normalized(name)
}

/// The page write, create-only (`src/cli.js:868-873` with a deliberate difference, module doc): `O_CREAT|O_EXCL` never
/// truncates an existing file, so the capture, an unrelated save and an alias all survive; the caller must pick a new
/// path. A failed write may leave a partial report; do not unlink a path that may have been replaced.
fn write_page(out: &Path, page: &str) -> Result<(), CliError> {
    let created = OpenOptions::new().write(true).create_new(true).open(out);
    let mut file = created.map_err(|e| CliError {
        message: format!(
            "cannot write {}: {}",
            out.display(),
            node_write_error(&e, out)
        ),
        code: 2,
    })?;
    file.write_all(page.as_bytes()).map_err(|e| CliError {
        message: format!(
            "cannot write {}: {}",
            out.display(),
            node_write_error(&e, out)
        ),
        code: 2,
    })
}

/// Node's `writeFileSync` wording for the failures a create-only page write meets, where the OS fact is the same.
/// `EEXIST` is the intended refusal for every existing file (see the module doc), so it says what to do instead.
fn node_write_error(e: &std::io::Error, path: &Path) -> String {
    match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!(
            "EEXIST: file already exists, open '{}' (the report page is create-only: choose a new path)",
            path.display()
        ),
        std::io::ErrorKind::NotFound => {
            format!(
                "ENOENT: no such file or directory, open '{}'",
                path.display()
            )
        }
        std::io::ErrorKind::IsADirectory => {
            format!(
                "EISDIR: illegal operation on a directory, open '{}'",
                path.display()
            )
        }
        std::io::ErrorKind::PermissionDenied => {
            format!("EACCES: permission denied, open '{}'", path.display())
        }
        _ => e.to_string(),
    }
}

/// `path.resolve(p)`'s output shape: absolute, `.` dropped, `..` folded lexically. A `..` that climbs above the root
/// is dropped (Node clamps it there).
fn normalized(p: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for component in absolute(p).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
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
        out.push_str(&table(
            &fight_rows(f, false),
            &["Metric", "Value"],
            &[false, true],
        ));
        out.push('\n');
    }
    out
}

/// The same row list `src/cli.js:1303-1326` builds, in the same order and with the same fallbacks. `page` picks the
/// HTML table's own `Split samples` wording (`${f.halves.length}`, `:1364`) over the card's.
fn fight_rows(f: &Value, page: bool) -> Vec<Vec<String>> {
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
            if page {
                "Largest 0.1 s step".into()
            } else {
                "Largest 0.1s step".into()
            },
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
            } else if page {
                halves.to_string()
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

/// The report page `src/cli.js:1329-1384`: one section pair per fight, then `multiGraphPage`.
///
/// The JS inserts the summary's own strings (weapon, imprint, sub-phase and chart names) raw into the table and the
/// note; this port escapes them (module doc). A capture of ordinary text renders byte-identically.
fn html(summary: &Value) -> String {
    let fights = summary.get("fights").items();
    let mut sections = Vec::new();
    for (i, f) in fights.iter().enumerate() {
        let content = f.get("content").to_js_string();
        let seconds = fmt(f.get("seconds"));
        let hp_curve = line_chart(
            &format!("{content} fight {} - boss health", i + 1),
            "Seconds",
            "Boss HP %",
            "HP",
            f.get("curve").items(),
            ("t", "hp"),
        );
        let dps_curve = line_chart(
            &format!("{content} fight {} - landed DPS", i + 1),
            "Seconds",
            "DPS",
            "Landed DPS",
            f.get("dpsCurve").items(),
            ("x", "y"),
        );
        // `chartTotals(f.chart)`: capture-derived names reach the note unescaped in the JS.
        let totals = chart_totals(f.get("chart"));
        let names: Vec<String> = totals
            .get("names")
            .items()
            .iter()
            .map(|n| escape(&n.to_js_string()))
            .collect();
        sections.push(Section {
            title: format!(
                "{content} - {} ({seconds} s)",
                if f.get("name").truthy() {
                    f.get("name").to_js_string()
                } else {
                    "boss".to_owned()
                }
            ),
            note: format!(
                "HP-derived figures, not the fight-end chart. Largest 0.1 s step is the best cap probe; no-damage time is the known immunity (tuning forks, phase shields). A tilde means the chart listed only the top 10 and the remaining players are filled at the median known level. The top-10 best blow and blows are the chart's rows, not the whole group.{}",
                if names.is_empty() {
                    String::new()
                } else {
                    format!(" Chart names: {}.", names.join(", "))
                }
            ),
            chart: hp_curve,
            table: html_table(f),
        });
        sections.push(Section {
            title: format!("{content} - landed DPS over time"),
            note: "Per-sample health delta at 10 Hz; a gap is an immune window or a phase shield."
                .to_owned(),
            chart: dps_curve,
            table: String::new(),
        });
    }
    if sections.is_empty() {
        sections.push(Section {
            title: "No fights".to_owned(),
            note: "No boss health samples found.".to_owned(),
            chart: String::new(),
            table: String::new(),
        });
    }
    let players = summary.get("players").to_js_string();
    graph::multi_graph_page(
        "DFO Combat Probe",
        &format!(
            "Read-only boss-bar capture. Level {}, {players} player{}. HP-derived figures; the fight-end chart is shown only as a cross-check.",
            summary.get("level").to_js_string(),
            if summary.get("players").to_number() == 1.0 { "" } else { "s" }
        ),
        &sections,
    )
}

/// One `lineChart` call of the report. `keys` reads each point's axes (`("t", "hp")` for the health curve, `("x", "y")`
/// for the DPS curve), as the JS's own `p.t`/`p.hp` do.
fn line_chart(
    title: &str,
    x_label: &str,
    y_label: &str,
    name: &str,
    points: &[Value],
    keys: (&str, &str),
) -> String {
    let mut chart = LineChart::new(title, x_label, y_label, Vec::new());
    chart.series = vec![Series {
        name: name.to_owned(),
        points: points
            .iter()
            .map(|p| Point {
                x: p.get(keys.0).to_number(),
                y: p.get(keys.1).to_number(),
            })
            .collect(),
    }];
    graph::line_chart(&chart)
}

/// The page's table (`src/cli.js:1352-1370`): the card rows, HTML-escaped, in `<tr><td class="k">key</td><td>value</td></tr>`.
fn html_table(f: &Value) -> String {
    let rows: String = fight_rows(f, true)
        .iter()
        .map(|row| {
            format!(
                "<tr><td class=\"k\">{}</td><td>{}</td></tr>",
                escape(&row[0]),
                escape(&row[1])
            )
        })
        .collect();
    format!(
        "<div class=\"table\"><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>{rows}</tbody></table></div>"
    )
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
