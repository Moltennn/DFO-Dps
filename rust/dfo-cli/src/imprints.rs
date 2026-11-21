//! The `imprints` card and page of `src/cli.js` (R8): the terminal table and the `multiGraphPage` sections.
//!
//! The rows are `dfo_core::imprints::rank_all`'s (already ported and differentially pinned); this module owns only the
//! rendering: the JS number format and ASCII table, the per-family terminal block, the bar chart, the section table and
//! the page shell. It is pure data in, strings out: no file I/O, no clock, no CLI wiring, no decision that changes a
//! DPS number. [`super::imprints_command`] owns the I/O, the flag resolution and the `--json` document
//! (`src/cli.js:1219-1263`); [`page`] and [`text`] are its two outputs.
//!
//! `--json` is not part of this module: its document is assembled in `main.rs` from the same rows.
//!
//! [`fmt`] and [`table`] mirror the CLI's private helpers (`src/cli.js:386-399`). They are kept local, as `report`'s
//! `n1`/`n2`/`pct` are, so this module and `tests/imprints.rs` compile on their own; `main.rs` keeps its own copies for
//! its other cards. Widths are UTF-16 code units, as JS `length` is.

use dfo_core::generated::theory::THEORY_LEVEL;
use dfo_core::round::math_round;
use dfo_core::value::{number_to_string, Value};

use crate::graph::{bar_chart, multi_graph_page, BarChart, BarSeries, Section};

/// JS `(Math.round(v * 10) / 10).toFixed(1)`; `-` for a non-finite input (`src/cli.js:386`).
pub fn fmt(v: f64) -> String {
    if !v.is_finite() {
        return "-".to_owned();
    }
    let r = math_round(v * 10.0) / 10.0;
    if r.abs() >= 1e21 {
        number_to_string(r)
    } else if r == 0.0 {
        "0.0".to_owned()
    } else {
        format!("{r:.1}")
    }
}

/// `String.prototype.length` in UTF-16 code units.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.padStart(width)` / `s.padEnd(width)` (`src/cli.js:394`).
fn pad(s: &str, width: usize, right: bool) -> String {
    let fill = width.saturating_sub(utf16_len(s));
    if right {
        format!("{}{s}", " ".repeat(fill))
    } else {
        format!("{s}{}", " ".repeat(fill))
    }
}

/// `table(rows, headers, aligns)` (`src/cli.js:390-399`): the terminal table, including the rule under the headers.
pub fn table(rows: &[Vec<String>], headers: &[&str], aligns: &[bool]) -> String {
    let mut widths: Vec<usize> = headers.iter().map(|h| utf16_len(h)).collect();
    for row in rows {
        for (i, c) in row.iter().enumerate() {
            widths[i] = widths[i].max(utf16_len(c));
        }
    }
    let line = |cells: &[String]| {
        cells
            .iter()
            .enumerate()
            .map(|(i, c)| pad(c, widths[i], aligns.get(i).copied().unwrap_or(false)))
            .collect::<Vec<_>>()
            .join("  ")
            .trim_end()
            .to_owned()
    };
    let header: Vec<String> = headers.iter().map(|h| (*h).to_owned()).collect();
    let mut out = vec![
        line(&header),
        line(
            &headers
                .iter()
                .map(|h| "-".repeat(utf16_len(h)))
                .collect::<Vec<_>>(),
        ),
    ];
    for row in rows {
        out.push(line(row));
    }
    out.join("\n")
}

/// The rows of the terminal card (`src/cli.js:1233`).
fn text_rows(f: &Value) -> Vec<Vec<String>> {
    f.get("rows")
        .items()
        .iter()
        .map(|r| {
            vec![
                r.get("power").get("name").to_js_string(),
                r.get("name").to_js_string(),
                r.get("weapon").to_js_string(),
                r.get("hit").to_js_string(),
                fmt(r.get("baseDps").to_number()),
                fmt(r.get("delta").to_number()),
                fmt(r.get("uncappedDps").to_number()),
                fmt(r.get("uncappedDelta").to_number()),
                fmt(r.get("conditionalDps").to_number()),
                fmt(r.get("triggerDelta").to_number()),
                r.get("trigger").to_js_string(),
                r.get("power").get("brief").to_js_string(),
            ]
        })
        .collect()
}

/// The terminal card (`src/cli.js:1229-1235`): the bytes the command prints in text mode before its page-write line
/// (each `console.log` adds its newline). The caller appends `imprints page written: <file>` itself.
pub fn text(rows: &Value) -> String {
    let mut printed = String::from("Weapon imprints\n");
    for f in rows.items() {
        printed.push_str(&format!(
            "\n{} - {} ({} carried per-hit-capped DPS; the Breach allowance is not applied to imprint rankings)\n",
            f.get("name").to_js_string(),
            f.get("weapon").to_js_string(),
            fmt(f.get("base").get("carriedCappedDps").to_number())
        ));
        printed.push_str(&table(
            &text_rows(f),
            &[
                "Imprint",
                "Of",
                "On",
                "Hit",
                "Boss carried DPS",
                "Boss carried gain",
                "Uncapped carried DPS",
                "Uncapped carried gain",
                "Trigger carried DPS",
                "Trigger carried gain",
                "Trigger",
                "Effect",
            ],
            &[
                false, false, false, false, true, true, true, true, true, true, false, false,
            ],
        ));
        printed.push('\n');
    }
    printed
}

/// The raw section table body (`src/cli.js:1247`): the JS inserts these constant captions as markup, not input text.
fn section_table(f: &Value) -> String {
    let body: String = f
        .get("rows")
        .items()
        .iter()
        .map(|r| {
            format!(
                "<tr><td class=\"k\" style=\"white-space:normal;min-width:300px\">{}<br><span style=\"color:#a8a092;font-size:11px\">of {} - {}</span></td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td style=\"white-space:normal;min-width:180px\">{}</td></tr>",
                r.get("power").get("name").to_js_string(),
                r.get("name").to_js_string(),
                r.get("power").get("brief").to_js_string(),
                r.get("weapon").to_js_string(),
                r.get("hit").to_js_string(),
                fmt(r.get("baseDps").to_number()),
                fmt(r.get("delta").to_number()),
                fmt(r.get("uncappedDps").to_number()),
                fmt(r.get("uncappedDelta").to_number()),
                r.get("trigger").to_js_string()
            )
        })
        .collect();
    format!(
        "<div class=\"table\"><table><thead><tr><th>Imprint</th><th>On</th><th>Hit</th><th>Carried per-hit-capped DPS</th><th>Carried per-hit-capped gain</th><th>Carried uncapped DPS</th><th>Carried uncapped gain</th><th>Trigger</th></tr></thead><tbody>{body}</tbody></table></div>"
    )
}

/// `multiGraphPage`'s sections (`src/cli.js:1237-1254`): one bar chart and one table per family.
pub fn sections(rows: &Value) -> Vec<Section> {
    rows.items()
        .iter()
        .map(|f| {
            let chart = bar_chart(&BarChart::new(
                format!(
                    "{} imprints - {}",
                    f.get("name").to_js_string(),
                    f.get("weapon").to_js_string()
                ),
                f.get("rows")
                    .items()
                    .iter()
                    .map(|r| r.get("power").get("name").to_js_string())
                    .collect(),
                vec![
                    BarSeries {
                        name: "Boss".to_owned(),
                        values: f
                            .get("rows")
                            .items()
                            .iter()
                            .map(|r| r.get("baseDps").to_number())
                            .collect(),
                    },
                    BarSeries {
                        name: "Trigger".to_owned(),
                        values: f
                            .get("rows")
                            .items()
                            .iter()
                            .map(|r| r.get("conditionalDps").to_number())
                            .collect(),
                    },
                    BarSeries {
                        name: "Uncapped".to_owned(),
                        values: f
                            .get("rows")
                            .items()
                            .iter()
                            .map(|r| r.get("uncappedDps").to_number())
                            .collect(),
                    },
                ],
            ));
            Section {
                title: format!(
                    "{} - {}",
                    f.get("name").to_js_string(),
                    f.get("weapon").to_js_string()
                ),
                note: format!(
                    "Every Weapon Legendary's power may sit on any weapon of its group; only Chain Lightning (a shot) and Earthshaker (a melee blow) narrow it. Each row reads the power on this family's best weapon. The DPS figures are the CARRIED mean (a held item carries a percentage line's fraction, so its long-run mean is the exact share), not the card's per-blow floor. Boss is the level-{} Breach (Daedra, 600 per-hit cap); Uncapped is the same weapon with no cap. Trigger applies the condition only where it can occur at the Breach; otherwise it is marked. The imprint is the Legendary power only; the Rare's own affixes are separate.",
                    number_to_string(THEORY_LEVEL)
                ),
                chart,
                table: section_table(f),
            }
        })
        .collect()
}

/// The whole page (`src/cli.js:1255-1259`): `multiGraphPage` with the command's title and subtitle.
///
/// `sort` is the already-resolved CLI sort (`boss`, `uncapped` or `conditional`); `firmament` only changes the subtitle.
pub fn page(rows: &Value, firmament: bool, sort: &str) -> String {
    let ranked = match sort {
        "uncapped" => "uncapped",
        "conditional" => "trigger",
        _ => "boss",
    };
    multi_graph_page(
        "DFO weapon imprints",
        &format!(
            "The Reforge's Rare imprints on each family's best max-profile weapon{}. Boss is the level-45 Breach with its 600 cap; Uncapped is the same weapon without it. DPS is the carried mean (the held item's long-run share, not the card's per-blow floor). Ranked by {ranked} carried DPS.",
            if firmament { ", +Firmament" } else { "" }
        ),
        &sections(rows),
    )
}
