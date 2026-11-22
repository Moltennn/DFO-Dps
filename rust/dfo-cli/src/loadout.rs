//! The `loadout` / `real-dps` branch of `src/cli.js` (`:636-669` the shortlist card, `:961-1082` the default report),
//! pure data in and strings/values out (R8).
//!
//! Every number is the core's own record: the rankings are `dfo_core::loadout_shortlist::shortlist_loadouts`' (already
//! differentially pinned by `dfo-core/tests/real_build.rs`), the report rows are
//! `dfo_core::real_build::real_weapon_loadouts`', the ratings `dfo_core::imprints::rank_all`'s and the plan table
//! `dfo_core::firmament::plan_build`/`plan_summary`'s. This module owns only the JS presentation: the shortlist's two
//! header lines, damage note, table and `--json` detail pruning, and the report's two terminal cards, its five page
//! sections and its row document. The caller resolves the modes, contents and options, runs the core entry points in the
//! JS order, and passes the records in.
//!
//! No file I/O, no sampling and no rule lives here. `--json` is returned as a [`Value`]; `main.rs` encodes it with its
//! own `JSON.stringify(v, null, 2)`, as `imprints` and `tradeoff` leave their documents.
//!
//! The number helpers are local copies of the CLI's private ones (`src/cli.js:386-399,654`), as `imprints`, `report` and
//! `tradeoff` keep theirs, so this module and `tests/loadout.rs` compile without `main.rs`. Widths are UTF-16 code units,
//! as JS `length` is.

use dfo_core::enchant_plan::effect_line;
use dfo_core::encounters::encounter_by_id;
use dfo_core::round::math_round;
use dfo_core::value::{
    number_to_string, Value,
    Value::{Arr, Num, Obj, Str, Undefined},
};

use crate::graph::{bar_chart, multi_graph_page, BarChart, BarSeries, Section};

/// JS `(Math.round(v * 100) / 100).toFixed(2)`; `-` for a non-finite input (`src/cli.js:387`).
fn fmt2(v: f64) -> String {
    if !v.is_finite() {
        return "-".to_owned();
    }
    let r = math_round(v * 100.0) / 100.0;
    if r.abs() >= 1e21 {
        number_to_string(r)
    } else if r == 0.0 {
        "0.00".to_owned()
    } else {
        format!("{r:.2}")
    }
}

/// The branch's local `pct = (v) => \`${fmt2(v * 100)}%\`` (`src/cli.js:654`).
fn pct(v: f64) -> String {
    format!("{}%", fmt2(v * 100.0))
}

/// `String.prototype.length` in UTF-16 code units (JS `length`, as `table` pads by it).
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

/// `table(rows, headers)` (`src/cli.js:390-399`) with the default left alignment, rule under the headers included.
fn table(rows: &[Vec<String>], headers: &[&str]) -> String {
    table_aligned(rows, headers, &[])
}

/// `table(rows, headers, aligns)` (`src/cli.js:390-399`): the terminal table, including the rule under the headers.
fn table_aligned(rows: &[Vec<String>], headers: &[&str], aligns: &[bool]) -> String {
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
    out.extend(rows.iter().map(|r| line(r)));
    out.join("\n")
}

/// `v ?? '-'`: a nullish field prints the dash, anything else its JS string form (`src/cli.js:661-666`).
fn or_dash(v: &Value) -> String {
    if v.is_nullish() {
        "-".to_owned()
    } else {
        v.to_js_string()
    }
}

/// The table's `value` cell: `row.error ?? (probability ? pct(row.value) : fmt2(row.value))`.
fn value_cell(row: &Value, probability: bool) -> String {
    if !row.get("error").is_nullish() {
        return row.get("error").to_js_string();
    }
    let value = row.get("value").to_number();
    if probability {
        pct(value)
    } else {
        fmt2(value)
    }
}

/// The table's CI cell: `row.ci ? \`[...]\` : '-'`.
fn ci_cell(row: &Value, probability: bool) -> String {
    let ci = row.get("ci");
    if !ci.truthy() {
        return "-".to_owned();
    }
    let bound = |key: &str| {
        let v = ci.get(key).to_number();
        if probability {
            pct(v)
        } else {
            fmt2(v)
        }
    };
    format!("[{}, {}]", bound("lo"), bound("hi"))
}

/// The table's kill-probability cell: `row.killProbability ? pct(row.killProbability.p) : '-'`.
fn probability_cell(row: &Value) -> String {
    let kp = row.get("killProbability");
    if !kp.truthy() {
        return "-".to_owned();
    }
    pct(kp.get("p").to_number())
}

/// One ranking's rows in the JS column order (`src/cli.js:660-667`).
fn row_cells(row: &Value, probability: bool) -> Vec<String> {
    vec![
        or_dash(row.get("rank")),
        row.get("deterministicRank").to_js_string(),
        format!(
            "{} · {}",
            row.get("category").to_js_string(),
            row.get("weapon").to_js_string()
        ),
        or_dash(row.get("imprint")),
        fmt2(row.get("deterministicTotalDps").to_number()),
        fmt2(row.get("deterministicProcDps").to_number()),
        value_cell(row, probability),
        probability_cell(row),
        ci_cell(row, probability),
        or_dash(row.get("ttkSeparated")),
        or_dash(row.get("censoringDiffers")),
    ]
}

/// `printLoadoutShortlist`'s text (`src/cli.js:650-668`): the bytes the command prints, starting with the leading
/// blank line of the block and ending with the table's newline. `trials` and `max_seconds` are the resolved
/// `opts.trials` / `opts.maxSeconds` the header prints (they are not ranking fields).
pub fn shortlist_text(rankings: &[Value], trials: f64, max_seconds: f64) -> String {
    let mut out = String::new();
    for r in rankings {
        let rows = r.get("rows").items();
        let top = rows
            .first()
            .expect("a shortlist always carries at least one row");
        let probability = r.get("objective").is_str("kill-probability");
        let pool_text = if r.get("mode").is_str("cap") {
            format!(
                "per-player pool {}",
                number_to_string(r.get("health").to_number())
            )
        } else {
            format!("pool {}", number_to_string(r.get("health").to_number()))
        };
        let encounter = match r.get("encounter").as_str() {
            Some(id) => encounter_by_id(&Str(id.to_owned()))
                .map_or_else(|| id.to_owned(), |e| e.name.to_owned()),
            None => "level-45 tough reference foe".to_owned(),
        };
        out.push_str(&format!(
            "\nLoadout shortlist | {encounter} | {} | {pool_text}\n",
            r.get("objective").to_js_string()
        ));
        out.push_str(&format!(
            "n: {} | Horizon: {} s / {} blows | Damage mode: {} | Seed: {}\n",
            number_to_string(trials),
            number_to_string(max_seconds),
            number_to_string(r.get("maxBlows").to_number()),
            top.get("damageMode").to_js_string(),
            number_to_string(r.get("seed").to_number())
        ));
        out.push_str(&format!("{}\n", top.get("damageNote").to_js_string()));
        let cells: Vec<Vec<String>> = rows.iter().map(|row| row_cells(row, probability)).collect();
        out.push_str(&table(
            &cells,
            &[
                "Rank",
                "Det. rank (melee)",
                "Weapon",
                "Imprint",
                "Det. DPS",
                "Proc DPS",
                if probability {
                    "Value (%)"
                } else {
                    "Kill rate (DPS)"
                },
                "Kill %",
                if probability {
                    "Wilson 95% CI"
                } else {
                    "Mean TTK 95% CI (s)"
                },
                "Separated",
                "Censoring differs",
            ],
        ));
        out.push('\n');
    }
    out
}

/// One object without `key`, order preserved (the JS `delete row.detail`, `src/cli.js:646`).
fn without_key(v: &Value, key: &str) -> Value {
    match v {
        Obj(entries) => Obj(entries
            .iter()
            .filter(|(k, _)| k.as_str() != key)
            .cloned()
            .collect()),
        other => other.clone(),
    }
}

/// `printLoadoutShortlist`'s `--json` document (`src/cli.js:645-648`): every row keeps its fields except `detail`
/// unless `--samples`. The caller encodes the returned array with `JSON.stringify(v, null, 2)`.
pub fn shortlist_document(rankings: &[Value], samples: bool) -> Value {
    let strip = |ranking: &Value| {
        let mut ranking = ranking.clone();
        if !samples {
            let rows: Vec<Value> = ranking
                .get("rows")
                .items()
                .iter()
                .map(|row| without_key(row, "detail"))
                .collect();
            ranking.set("rows", Arr(rows));
        }
        ranking
    };
    Arr(rankings.iter().map(strip).collect())
}

// ---------------------------------------------------------------------------------------------------------------
// the default report (`src/cli.js:982-1081`): every weapon template and hold configuration
// ---------------------------------------------------------------------------------------------------------------

/// `byDps` (`src/cli.js:988`): a copy sorted by `totalDps` descending, stable on ties.
fn by_dps(rows: &[Value]) -> Vec<Value> {
    let mut out = rows.to_vec();
    out.sort_by(|a, b| {
        let d = b.get("totalDps").to_number() - a.get("totalDps").to_number();
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Equal
        }
    });
    out
}

fn encounter<'a>(id: &str) -> Option<&'a dfo_core::encounters::Encounter> {
    encounter_by_id(&Str(id.to_owned()))
}

/// The two terminal cards (`src/cli.js:989-1001`): the uncapped list, then one cap-aware card per requested content.
/// Every number is a row's own field; the caller resolved the modes and the encounter ids.
pub fn report_text(uncapped_rows: &[Value], cap_rows: &[(&str, Vec<Value>)]) -> String {
    let mut out = String::new();
    if !uncapped_rows.is_empty() {
        let list = by_dps(uncapped_rows);
        out.push_str(&format!(
            "\nReal loadouts  |  uncapped theory  |  soul gem +{}\n",
            number_to_string(dfo_core::generated::firmament::SOUL_GEM_POINTS)
        ));
        let cells: Vec<Vec<String>> = list
            .iter()
            .map(|r| {
                vec![
                    format!(
                        "{} · {}",
                        r.get("category").to_js_string(),
                        r.get("family").to_js_string()
                    ),
                    r.get("weapon").to_js_string(),
                    or_dash(r.get("imprint")),
                    fmt_one(r.get("totalDps")),
                ]
            })
            .collect();
        out.push_str(&table_aligned(
            &cells,
            &["Family", "Weapon", "Imprint", "Total DPS (carried)"],
            &[false, false, false, true],
        ));
        out.push('\n');
    }
    for (id, rows) in cap_rows {
        let Some(e) = encounter(id) else { continue };
        let list = by_dps(rows);
        let soul = number_to_string(dfo_core::generated::firmament::SOUL_GEM_POINTS);
        let suffix = if e.calibrated {
            String::new()
        } else {
            "  |  uncalibrated mechanics".to_owned()
        };
        out.push_str(&format!(
            "\nReal loadouts  |  {}  |  soul gem +{soul}{suffix}\n",
            e.name
        ));
        let cells: Vec<Vec<String>> = list
            .iter()
            .map(|r| {
                vec![
                    format!(
                        "{} · {}",
                        r.get("category").to_js_string(),
                        r.get("family").to_js_string()
                    ),
                    r.get("weapon").to_js_string(),
                    or_dash(r.get("imprint")),
                    fmt_one(r.get("totalDps")),
                    fmt_one(r.get("burst5")),
                    fmt_one(r.get("sustainedDps")),
                    fmt_one(r.get("averageDps")),
                    fmt_one(r.get("ttk")),
                    percent(r.get("landedShare")),
                ]
            })
            .collect();
        out.push_str(&table_aligned(
            &cells,
            &[
                "Family",
                "Weapon",
                "Imprint",
                "Per-hit-capped DPS (carried)",
                "Burst 5s",
                "Sustained DPS",
                "Kill-avg DPS",
                "TTK",
                "Kept",
            ],
            &[false, false, false, true, true, true, true, true, false],
        ));
        out.push('\n');
    }
    out
}

/// JS `(Math.round(v * 10) / 10).toFixed(1)`; `-` for a non-number or a non-finite one (`src/cli.js:386`).
fn fmt_one(v: &Value) -> String {
    let n = match v {
        Num(n) if n.is_finite() => *n,
        _ => return "-".to_owned(),
    };
    let r = math_round(n * 10.0) / 10.0;
    if r.abs() >= 1e21 {
        number_to_string(r)
    } else if r == 0.0 {
        "0.0".to_owned()
    } else {
        format!("{r:.1}")
    }
}

/// JS `` `${Math.round(v * 100)}%` ``; `-` for a non-number or a non-finite one (`src/cli.js:388`).
fn percent(v: &Value) -> String {
    let n = match v {
        Num(n) if n.is_finite() => *n,
        _ => return "-".to_owned(),
    };
    format!("{}%", number_to_string(math_round(n * 100.0)))
}

/// One `realWeaponLoadouts` row as the page's table cells (`src/cli.js:1021,1043`): the JS inserts these raw.
fn uncapped_table_rows(list: &[Value]) -> String {
    list.iter()
        .map(|r| {
            format!(
                "<tr><td class=\"k\">{} · {}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                r.get("category").to_js_string(),
                r.get("family").to_js_string(),
                r.get("weapon").to_js_string(),
                or_dash(r.get("imprint")),
                fmt_one(r.get("totalDps"))
            )
        })
        .collect()
}

fn capped_table_rows(list: &[Value]) -> String {
    list.iter()
        .map(|r| {
            format!(
                "<tr><td class=\"k\">{} · {}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                r.get("category").to_js_string(),
                r.get("family").to_js_string(),
                r.get("weapon").to_js_string(),
                or_dash(r.get("imprint")),
                fmt_one(r.get("totalDps")),
                fmt_one(r.get("burst5")),
                fmt_one(r.get("sustainedDps")),
                fmt_one(r.get("averageDps")),
                fmt_one(r.get("ttk")),
                percent(r.get("landedShare"))
            )
        })
        .collect()
}

fn chart(title: &str, list: &[Value], series_name: &str, value: fn(&Value) -> f64) -> String {
    bar_chart(&BarChart::new(
        title,
        list.iter()
            .map(|r| {
                format!(
                    "{} {}",
                    r.get("category").to_js_string(),
                    r.get("weapon").to_js_string()
                )
            })
            .collect(),
        vec![BarSeries {
            name: series_name.to_owned(),
            values: list.iter().map(value).collect(),
        }],
    ))
}

/// The whole report page (`src/cli.js:1013-1077`). `uncapped` is empty when the mode is off; `cap_rows` holds one list
/// per requested content, already in the JS order; `imprint_rows` and `plans` are the branch's own two tables.
pub fn report_page(
    uncapped: &[Value],
    cap_rows: &[(&str, Vec<Value>)],
    imprint_rows: &[Value],
    plans: &[Value],
) -> String {
    let mut sections: Vec<Section> = Vec::new();
    let mut subtitle_modes: Vec<String> = Vec::new();
    if !uncapped.is_empty() {
        let list = by_dps(uncapped);
        sections.push(Section {
            title: "Uncapped theory - all weapons and hold configurations".to_owned(),
            note: "Every weapon template in every hand configuration. Total is the CARRIED figure: tree + enchants + the best eligible positive imprint; null means no positive imprint was used.".to_owned(),
            chart: chart(
                "Uncapped loadouts by carried DPS",
                &list,
                "Carried total DPS",
                |r| r.get("totalDps").to_number(),
            ),
            table: format!(
                "<div class=\"table\"><table><thead><tr><th>Family</th><th>Weapon</th><th>Imprint</th><th>Total DPS (carried)</th></tr></thead><tbody>{}</tbody></table></div>",
                uncapped_table_rows(&list)
            ),
        });
        subtitle_modes.push("uncapped".to_owned());
    }
    let mut cap_names: Vec<String> = Vec::new();
    for (id, rows) in cap_rows {
        let Some(e) = encounter(id) else { continue };
        cap_names.push(e.name.to_owned());
        let list = by_dps(rows);
        let mut ttk_list = list.clone();
        ttk_list.sort_by(|a, b| {
            let x = a.get("ttk").num_or(f64::INFINITY);
            let y = b.get("ttk").num_or(f64::INFINITY);
            match x.partial_cmp(&y) {
                Some(o) => o,
                None => std::cmp::Ordering::Equal,
            }
        });
        let ttk_chart = bar_chart(&BarChart::new(
            format!("{} time to kill - lower is better", e.name),
            ttk_list
                .iter()
                .map(|r| {
                    format!(
                        "{} {}",
                        r.get("category").to_js_string(),
                        r.get("weapon").to_js_string()
                    )
                })
                .collect(),
            vec![BarSeries {
                name: "TTK".to_owned(),
                values: ttk_list.iter().map(|r| r.get("ttk").num_or(0.0)).collect(),
            }],
        ));
        let uncalibrated = if e.calibrated {
            ""
        } else {
            " (uncalibrated mechanics)"
        };
        let calibration_note = if e.calibrated {
            ""
        } else {
            " The purse is known; the encounter immunity/split timing is not yet measured, so TTK is a purse-only baseline."
        };
        sections.push(Section {
            title: format!("{} - all weapons and hold configurations{uncalibrated}", e.name),
            note: format!(
                "{} The carried per-hit-capped DPS is a ceiling, not what the boss takes; Burst 5s (damage in the first five seconds), Sustained DPS (the refill rate once the opening allowance is spent), Kill-avg DPS (health over TTK) and TTK apply the relay's per-player allowance (750 depth, 150/s, 600 per blow, four blows/s at level 45). Purse kept is the share of that ceiling which lands after the purse. The imprint is chosen on the per-hit ceiling; under the purse Many Endings is not credited, because its extra blow is capped and spends the same four-blow budget.{calibration_note}",
                e.note
            ),
            chart: chart(
                &format!("{} loadouts by carried per-hit-cap DPS", e.name),
                &list,
                "Carried total DPS",
                |r| r.get("totalDps").to_number(),
            ),
            table: format!(
                "<div class=\"table\"><table><thead><tr><th>Family</th><th>Weapon</th><th>Imprint</th><th>Per-hit-capped DPS (carried)</th><th>Burst 5s</th><th>Sustained DPS</th><th>Kill-avg DPS</th><th>TTK</th><th>Allowance kept</th></tr></thead><tbody>{}</tbody></table></div>",
                capped_table_rows(&list)
            ),
        });
        sections.push(Section {
            title: format!("{} - time to kill", e.name),
            note: "Sorted by TTK, not DPS. Every build above the refill rate converges; the remaining differences are burst and phase time.".to_owned(),
            chart: ttk_chart,
            table: String::new(),
        });
    }
    // `:1002-1004`: the first 1H row's plan across uncapped, then cap, then the whole row list.
    let all_rows: Vec<&Value> = uncapped
        .iter()
        .chain(cap_rows.iter().flat_map(|(_, rows)| rows.iter()))
        .collect();
    let first_one_handed = all_rows
        .iter()
        .find(|r| r.get("category").is_str("1H"))
        .map(|r| r.get("enchPlan"));
    let shared = first_one_handed
        .unwrap_or_else(|| all_rows.first().map_or(&Undefined, |r| r.get("enchPlan")));
    if shared.truthy() {
        let body: String = shared
                .get("rows")
                .items()
                .iter()
                .map(|r| {
                    format!(
                        "<tr><td class=\"k\">{}</td><td>{}</td><td style=\"white-space:normal;min-width:360px\">{}</td></tr>",
                        r.get("slot").to_js_string(),
                        r.get("item").to_js_string(),
                        {
                            let lines: Vec<String> = r
                                .get("effects")
                                .items()
                                .iter()
                                .map(effect_line)
                                .collect();
                            if lines.is_empty() {
                                "-".to_owned()
                            } else {
                                lines.join("<br>")
                            }
                        }
                    )
                })
                .collect();
        sections.push(Section {
                title: "Shared enchant plan".to_owned(),
                note: "The same armour/jewellery enchant template is used by every loadout; only the weapon-skill name changes.".to_owned(),
                chart: String::new(),
                table: format!(
                    "<div class=\"table\"><table><thead><tr><th>Slot</th><th>Item</th><th>Enchantments</th></tr></thead><tbody>{body}</tbody></table></div>"
                ),
            });
    }
    sections.push(Section {
        title: "Imprint ratings".to_owned(),
        note: "Top three eligible imprints per family. Boss is the breach purse; Uncapped has no cap. Monster-type damage imprints are shown for reference but are not used in the loadouts.".to_owned(),
        chart: String::new(),
        table: format!(
            "<div class=\"table\"><table><thead><tr><th>Family</th><th>Imprint</th><th>Weapon</th><th>Per-hit-capped DPS (carried)</th><th>Uncapped DPS (carried)</th></tr></thead><tbody>{}</tbody></table></div>",
            imprint_rows
                .iter()
                .map(|r| {
                    format!(
                        "<tr><td class=\"k\">{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                        r.get("family").to_js_string(),
                        r.get("power").to_js_string(),
                        r.get("weapon").to_js_string(),
                        fmt_one(r.get("carriedBoss")),
                        fmt_one(r.get("carriedUncapped"))
                    )
                })
                .collect::<String>()
        ),
    });
    sections.push(Section {
        title: "Firmament plans used".to_owned(),
        note: "The real tree plans behind the loadouts. Free stars are not needed for damage.".to_owned(),
        chart: String::new(),
        table: format!(
            "<div class=\"table\"><table><thead><tr><th>Build</th><th>Start</th><th>Stars</th><th>Free</th><th>Group</th></tr></thead><tbody>{}</tbody></table></div>",
            plans
                .iter()
                .map(|r| {
                    format!(
                        "<tr><td class=\"k\">{}</td><td>{}</td><td>{}/98</td><td>{}</td><td>{}</td></tr>",
                        r.get("build").to_js_string(),
                        r.get("start").to_js_string(),
                        r.get("stars").to_js_string(),
                        r.get("free").to_js_string(),
                        r.get("group").to_js_string()
                    )
                })
                .collect::<String>()
        ),
    });
    let mut modes: Vec<String> = subtitle_modes;
    if !cap_names.is_empty() {
        modes.push(cap_names.join(" / "));
    }
    multi_graph_page(
        "DFO real loadouts",
        &format!(
            "Tree + enchants + best eligible positive imprint. Every weapon template, 1H / 2H / DW / Fists, in {}{} modes. Monster-type damage imprints are excluded.",
            // The JS inserts `wantsUncapped ? 'uncapped' : ''`, then ` and ` between the two requested modes only.
            modes.first().cloned().unwrap_or_default(),
            if modes.len() > 1 {
                format!(" and {}", modes[1])
            } else {
                String::new()
            }
        ),
        &sections,
    )
}

/// The `--json` row list (`src/cli.js:1080`): every row without its `enchPlan`, in the uncapped/cap order.
pub fn report_document(rows: &[Value]) -> Value {
    Arr(rows.iter().map(|r| without_key(r, "enchPlan")).collect())
}

/// The report's plan table (`src/cli.js:1006-1011`): `{ build: name, start: startName, stars, free: freeStars,
/// group }` per build, where `group` is the plan's capped blow/cast-cost percent or its HP. A separate small record from
/// the `--json` `plans` field, which the JS never prints (it prints `rows` only); the page's last section reads this.
pub fn plan_rows(plans: &[Value]) -> Value {
    Arr(plans
        .iter()
        .map(|p| {
            let sum = dfo_core::firmament::plan_summary(p);
            let row = |key: &str| {
                sum.get("rows")
                    .items()
                    .iter()
                    .find(|r| r.get("key").is_str(key))
                    .map_or(Num(0.0), |r| r.get("value").clone())
            };
            let build = p.get("build");
            let group = if build.get("skill").truthy() {
                format!("{}%", row("blow").to_js_string())
            } else if build.get("school").truthy() {
                format!("{}%", row("castCost").to_js_string())
            } else {
                format!(
                    "{} HP",
                    number_to_string(p.get("totals").get("hp").num_or(0.0))
                )
            };
            obj([
                ("build", build.get("name").clone()),
                ("start", p.get("startName").clone()),
                ("stars", p.get("stars").clone()),
                ("free", p.get("freeStars").clone()),
                ("group", Str(group)),
            ])
        })
        .collect())
}

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}
