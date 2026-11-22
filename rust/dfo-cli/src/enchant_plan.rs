//! The `enchant-plan` / `gear-plan` text card of `src/cli.js:1161-1191` (R8): the plan header, the optional imprint
//! line, the per-piece table and the four explanatory tables, as text.
//!
//! Pure data in, one string out: the plan is `dfo_core::enchant_plan::plan_enchants`'s own value, so every number is the
//! shared core's and nothing here prices an effect. This module owns only the branch's captions, its `fmt`/`table` and
//! the JS `effectLine`/`enchantmentName` calls, and no file I/O: the page write, the `enchant plan written:` line, the
//! flag parsing and the `--json` document are the CLI's (see `main.rs`, still wiring this module). The `--all` matrix
//! and the HTML page are not ported here; the single plan's text card is.
//!
//! [`fmt`] and [`table`] are local copies of the CLI's private helpers (`src/cli.js:386-399`), as `imprints`' are, so
//! this module and `tests/enchant_plan.rs` compile without `main.rs`. Widths are UTF-16 code units, as JS `length` is.

use dfo_core::enchant_plan::effect_line;
use dfo_core::enchants::enchantment_name;
use dfo_core::generated::firmament::SOUL_GEM_POINTS;
use dfo_core::round::math_round;
use dfo_core::value::{number_to_string, Value, Value::Obj};

use crate::graph::{multi_graph_page, Section};

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

/// `r.effects.map((e) => effectLine(e)).join('; ') || '-'` (`src/cli.js:1172`).
fn effects_cell(row: &Value) -> String {
    let joined = row
        .get("effects")
        .items()
        .iter()
        .map(effect_line)
        .collect::<Vec<_>>()
        .join("; ");
    if joined.is_empty() {
        "-".to_owned()
    } else {
        joined
    }
}

/// The per-piece table (`src/cli.js:1171-1174`).
fn piece_rows(plan: &Value) -> Vec<Vec<String>> {
    plan.get("rows")
        .items()
        .iter()
        .map(|r| {
            vec![
                r.get("slot").to_js_string(),
                r.get("item").to_js_string(),
                r.get("base").to_js_string(),
                if r.get("soul").truthy() {
                    r.get("soul").to_js_string()
                } else {
                    "-".to_owned()
                },
                r.get("budget").to_js_string(),
                r.get("spent").to_js_string(),
                r.get("left").to_js_string(),
                effects_cell(r),
            ]
        })
        .collect()
}

/// `r.effects.map((e) => effectLine(e)).join('<br>') || '-'`: the page's markup join, never `; ` (that is inside an
/// effect line's own cost/benefit).
fn effects_html(row: &Value) -> String {
    let joined = row
        .get("effects")
        .items()
        .iter()
        .map(effect_line)
        .collect::<Vec<_>>()
        .join("<br>");
    if joined.is_empty() {
        "-".to_owned()
    } else {
        joined
    }
}

/// `plan.rows.flatMap((r) => r.effects.filter((e) => e.type === u.type).map(() => r.slot))`.
fn placed_slots(plan: &Value, kind: &Value) -> Vec<String> {
    plan.get("rows")
        .items()
        .iter()
        .flat_map(|r| {
            r.get("effects")
                .items()
                .iter()
                .filter(|e| e.get("type").strict_eq(kind))
                .map(|_| r.get("slot").to_js_string())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// "Only one piece needs it" (`src/cli.js:1177-1181`).
fn one_piece_rows(plan: &Value) -> Vec<Vec<String>> {
    plan.get("onePiece")
        .items()
        .iter()
        .map(|u| {
            let placed = placed_slots(plan, u.get("type"));
            vec![
                enchantment_name(&u.get("type").to_js_string()),
                if placed.is_empty() {
                    "-".to_owned()
                } else {
                    placed.join(", ")
                },
                u.get("why").to_js_string(),
            ]
        })
        .collect()
}

/// "Stacks per piece" (`src/cli.js:1183-1187`): only the effects the plan placed.
fn stack_rows(plan: &Value) -> Vec<Vec<String>> {
    plan.get("stacks")
        .items()
        .iter()
        .filter_map(|u| {
            let n = plan
                .get("rows")
                .items()
                .iter()
                .map(|r| {
                    r.get("effects")
                        .items()
                        .iter()
                        .filter(|e| e.get("type").strict_eq(u.get("type")))
                        .count()
                })
                .sum::<usize>();
            (n > 0).then(|| {
                vec![
                    enchantment_name(&u.get("type").to_js_string()),
                    number_to_string(n as f64),
                    u.get("why").to_js_string(),
                ]
            })
        })
        .collect()
}

/// "How the effects rate" (`src/cli.js:1189-1191`), the three tables in the branch's order.
fn rating_tables(plan: &Value) -> String {
    let ratings = plan.get("ratings");
    let weapon: Vec<Vec<String>> = ratings
        .get("weapon")
        .items()
        .iter()
        .map(|r| {
            let cost = r.get("cost").to_number();
            vec![
                r.get("label").to_js_string(),
                fmt(r.get("value").to_number()),
                r.get("cost").to_js_string(),
                fmt(r.get("value").to_number() * 1000.0 / cost),
                r.get("chosen").to_js_string(),
            ]
        })
        .collect();
    let skills: Vec<Vec<String>> = ratings
        .get("skills")
        .items()
        .iter()
        .map(|r| {
            vec![
                r.get("label").to_js_string(),
                fmt(r.get("futureValue").to_number()),
                fmt(r.get("value").to_number()),
                r.get("cost").to_js_string(),
                r.get("chosen").to_js_string(),
            ]
        })
        .collect();
    let utility: Vec<Vec<String>> = ratings
        .get("utility")
        .items()
        .iter()
        .map(|r| {
            vec![
                r.get("label").to_js_string(),
                r.get("benefit").to_js_string(),
                r.get("cost").to_js_string(),
                r.get("chosen").to_js_string(),
            ]
        })
        .collect();
    [
        table(
            &weapon,
            &["Weapon proc", "DPS", "Cost", "DPS / 1k", "Chosen"],
            &[false, true, true, true, true],
        ),
        table(
            &skills,
            &["Skill +15", "No-cap DPS", "Gate DPS", "Cost", "Chosen"],
            &[false, true, true, true, true],
        ),
        table(
            &utility,
            &["Utility", "Benefit", "Cost", "Chosen"],
            &[false, false, true, true],
        ),
    ]
    .join("\n")
}

/// The `--json` document of the single plan (`src/cli.js:1215`): the plan value itself, which `main.rs` encodes the way
/// `JSON.stringify(plan, null, 2)` does.
pub fn document(plan: &Value) -> Value {
    plan.clone()
}

/// `value ?? fallback`: a nullish plan field reads as the JS default (a `null` plan's `rows` is `[]`).
fn or_num(value: &Value, fallback: f64) -> f64 {
    if value.is_nullish() {
        fallback
    } else {
        value.to_number()
    }
}

/// One table body cell (`x.family`, `x.weapon`, ...) with the JS template literal's `String(...)`.
fn cell(value: &Value) -> String {
    value.to_js_string()
}

/// The `--all` summary of one matrix (`src/cli.js:1102-1112`): `procs` counts the weapon's own Cast When Strikes rows,
/// `repairs` every Repairs Objects row, and `spent`/`budget`/`left` sum the whole set.
fn summarize(matrix: &Value) -> Vec<Value> {
    matrix
        .items()
        .iter()
        .map(|x| {
            let rows = x.get("plan").get("rows");
            let procs = rows.items().first().map_or(0.0, |r| {
                r.get("effects")
                    .items()
                    .iter()
                    .filter(|e| e.get("type").is_str("CastWhenStrikes"))
                    .count() as f64
            });
            let repairs = rows
                .items()
                .iter()
                .flat_map(|r| r.get("effects").items().iter())
                .filter(|e| e.get("type").is_str("RepairsObjects"))
                .count() as f64;
            let mut spent = 0.0;
            let mut budget = 0.0;
            for r in rows.items() {
                spent += r.get("spent").to_number();
                budget += r.get("budget").to_number();
            }
            let mut out = Obj(vec![]);
            out.set("family", x.get("family").clone());
            out.set(
                "weapon",
                if x.get("weapon").is_nullish() {
                    Value::Str("-".to_owned())
                } else {
                    x.get("weapon").clone()
                },
            );
            out.set("skillPieces", Value::Num(or_num(x.get("skillPieces"), 0.0)));
            out.set("csPieces", Value::Num(or_num(x.get("csPieces"), 0.0)));
            out.set("procs", Value::Num(procs));
            out.set("repairs", Value::Num(repairs));
            out.set(
                "carriedBase",
                Value::Num(or_num(x.get("plan").get("carriedBaseDps"), 0.0)),
            );
            out.set(
                "cardDps",
                Value::Num(or_num(x.get("plan").get("cardPlanDps"), 0.0)),
            );
            out.set(
                "cardFutureDps",
                Value::Num(or_num(x.get("plan").get("cardUncappedPlanDps"), 0.0)),
            );
            out.set("spent", Value::Num(spent));
            out.set("budget", Value::Num(budget));
            out.set("left", Value::Num(budget - spent));
            out
        })
        .collect()
}

/// `const melee = matrix.filter((x) => ['LongBlade', ...].includes(x.key))` then, for the cap mode, the highest
/// `skillPieces` first (`src/cli.js:1118-1121`); only the first row is shown.
fn canonical(matrix: &Value, cap: bool) -> Option<Value> {
    let mut melee: Vec<Value> = matrix
        .items()
        .iter()
        .filter(|x| {
            [
                "LongBlade",
                "ShortBlade",
                "Axe",
                "BluntWeapon",
                "HandToHand",
            ]
            .iter()
            .any(|k| x.get("key").is_str(k))
        })
        .cloned()
        .collect();
    if cap {
        melee.sort_by(|a, b| {
            b.get("skillPieces")
                .to_number()
                .partial_cmp(&a.get("skillPieces").to_number())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    melee.first().cloned()
}

/// `x.plan?.rows ?? []`, the rows a summary reads.
fn plan_rows(x: &Value) -> Value {
    match x.get("plan").get("rows") {
        rows @ Value::Arr(_) => rows.clone(),
        _ => Value::Arr(vec![]),
    }
}

/// "Canonical melee layout" (`src/cli.js:1122`): `''` when the row carries no plan.
fn canonical_html(row: &Option<Value>) -> String {
    let Some(row) = row else {
        return String::new();
    };
    if !matches!(row.get("plan"), Value::Obj(_)) {
        return String::new();
    }
    let body: String = row
        .get("plan")
        .get("rows")
        .items()
        .iter()
        .map(|r| {
            let effects = effects_html(r);
            format!(
                "<tr><td class=\"k\">{}</td><td>{}</td><td style=\"white-space:normal;min-width:320px\">{}</td></tr>",
                r.get("slot").to_js_string(),
                r.get("item").to_js_string(),
                effects,
            )
        })
        .collect();
    format!(
        "<div class=\"table\"><h3>Canonical melee layout ({} - {})</h3><table><thead><tr><th>Slot</th><th>Item</th><th>Enchantments</th></tr></thead><tbody>{body}</tbody></table></div>",
        row.get("family").to_js_string(),
        row.get("weapon").to_js_string(),
    )
}

/// The `--all` summary table (`src/cli.js:1113-1116`), as the page's markup (a `cap` run adds the no-cap column).
fn summary_html(summary: &[Value], cap: bool) -> String {
    let head = format!(
        "<tr><th>Family</th><th>Best weapon</th><th>Weapon skill pieces</th><th>CS pieces</th><th>Procs</th><th>Repairs</th><th>Weapon DPS (carried)</th>{}<th>Spent</th><th>Left</th></tr>",
        if cap {
            "<th>Gate plan (card ceiling)</th><th>No-cap plan (card)</th>"
        } else {
            "<th>Uncapped plan DPS (card)</th>"
        }
    );
    let body: String = summary
        .iter()
        .map(|x| {
            let plans = if cap {
                format!(
                    "<td>{}</td><td>{}</td>",
                    fmt(x.get("cardDps").to_number()),
                    fmt(x.get("cardFutureDps").to_number())
                )
            } else {
                format!("<td>{}</td>", fmt(x.get("cardDps").to_number()))
            };
            format!(
                "<tr><td class=\"k\">{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td>{}<td>{}</td><td>{}</td></tr>",
                cell(x.get("family")),
                cell(x.get("weapon")),
                cell(x.get("skillPieces")),
                cell(x.get("csPieces")),
                cell(x.get("procs")),
                cell(x.get("repairs")),
                fmt(x.get("carriedBase").to_number()),
                plans,
                cell(x.get("spent")),
                cell(x.get("left")),
            )
        })
        .collect();
    format!("<div class=\"table\"><table><thead>{head}</thead><tbody>{body}</tbody></table></div>")
}

/// One `--all` mode: its resolved label, the matrix summary, the canonical melee row and the section markup.
pub struct AllMode {
    pub key: &'static str,
    pub label: &'static str,
    pub matrix: Value,
}

impl AllMode {
    fn summary(&self) -> Vec<Value> {
        summarize(&self.matrix)
    }

    fn melee(&self) -> Option<Value> {
        canonical(&self.matrix, self.key == "cap")
    }

    fn html(&self) -> String {
        let cap = self.key == "cap";
        summary_html(&self.summary(), cap) + &canonical_html(&self.melee())
    }
}

/// The `--all` text card (`src/cli.js:1129-1140`): one block per selected mode, each `console.log`'s newline kept. The
/// caller appends its own `enchant plans page written: <file>` line.
pub fn all_text(modes: &[AllMode], soul_gem: bool) -> String {
    let mut printed = String::new();
    for r in modes {
        let cap = r.key == "cap";
        printed.push_str(&format!(
            "\nEnchant plans by weapon type  |  {}  |  {}",
            r.label,
            if soul_gem {
                format!("soul gem +{}", number_to_string(SOUL_GEM_POINTS))
            } else {
                "template points only".to_owned()
            }
        ));
        printed.push('\n');
        let rows: Vec<Vec<String>> = r
            .summary()
            .iter()
            .map(|x| {
                let mut row = vec![
                    cell(x.get("family")),
                    cell(x.get("weapon")),
                    cell(x.get("skillPieces")),
                    cell(x.get("csPieces")),
                    cell(x.get("procs")),
                    cell(x.get("repairs")),
                    fmt(x.get("carriedBase").to_number()),
                ];
                row.push(fmt(x.get("cardDps").to_number()));
                if cap {
                    row.push(fmt(x.get("cardFutureDps").to_number()));
                }
                row.push(cell(x.get("spent")));
                row.push(cell(x.get("left")));
                row
            })
            .collect();
        let mut headers: Vec<&str> = vec![
            "Family",
            "Best",
            "Weapon skill",
            "CS",
            "Procs",
            "Repairs",
            "Weapon DPS (carried)",
            if cap {
                "Gate plan (card ceiling)"
            } else {
                "Uncapped plan DPS (card)"
            },
        ];
        if cap {
            headers.push("No-cap plan (card)");
        }
        headers.extend(["Spent", "Left"]);
        let mut aligns: Vec<bool> = vec![false, false, true, true, true, true, true];
        aligns.push(true);
        if cap {
            aligns.push(true);
        }
        aligns.extend([true, true]);
        printed.push_str(&table(&rows, &headers, &aligns));
        printed.push('\n');
        if let Some(melee) = r.melee() {
            if matches!(melee.get("plan"), Value::Obj(_)) {
                printed.push_str(&format!(
                    "\nCanonical melee layout ({} - {})\n",
                    melee.get("family").to_js_string(),
                    melee.get("weapon").to_js_string()
                ));
                let rows: Vec<Vec<String>> = plan_rows(&melee)
                    .items()
                    .iter()
                    .map(|row| {
                        vec![
                            row.get("slot").to_js_string(),
                            row.get("item").to_js_string(),
                            effects_cell(row),
                        ]
                    })
                    .collect();
                printed.push_str(&table(
                    &rows,
                    &["Slot", "Item", "Enchantments"],
                    &[false, false, false],
                ));
                printed.push('\n');
            }
        }
    }
    printed
}

/// The `--all` page (`src/cli.js:1142-1154`): `multiGraphPage` with the two modes' summaries and canonical layouts.
pub fn all_page(modes: &[AllMode], soul_gem: bool) -> String {
    let sections: Vec<Section> = modes
        .iter()
        .map(|r| Section {
            title: format!("{} per weapon type", r.label),
            note: if r.key == "uncapped" {
                "Theoretical maximum: no per-hit cap, the legal gear frontier for the weapon (weapon skill / Critical Strike / damage across the 18 slots). Every melee family uses the same shape; only the weapon-skill name changes.".to_owned()
            } else {
                "Current Breach: 600 per-hit cap. Skill lines are bought only where their capped marginal DPS is positive.".to_owned()
            },
            chart: String::new(),
            table: r.html(),
        })
        .collect();
    multi_graph_page(
        "DFO enchant plans by weapon type",
        &format!(
            "{} | uncapped theory and cap-aware setups side by side.",
            if soul_gem {
                format!(
                    "Soul gem +{} on every piece",
                    number_to_string(SOUL_GEM_POINTS)
                )
            } else {
                "Template points only".to_owned()
            }
        ),
        &sections,
    )
}

/// The `--all --json` document (`src/cli.js:1157`): one entry per mode with its label, summary and per-family rows.
pub fn all_document(modes: &[AllMode]) -> Value {
    let entries: Vec<Value> = modes
        .iter()
        .map(|r| {
            let mut out = Obj(vec![]);
            out.set("mode", Value::Str(r.key.to_owned()));
            out.set("label", Value::Str(r.label.to_owned()));
            out.set("summary", Value::Arr(r.summary()));
            let plans: Vec<Value> = r
                .matrix
                .items()
                .iter()
                .map(|x| {
                    let mut p = Obj(vec![]);
                    p.set("family", x.get("family").clone());
                    p.set("weapon", x.get("weapon").clone());
                    p.set("rows", plan_rows(x));
                    p
                })
                .collect();
            out.set("plans", Value::Arr(plans));
            out
        })
        .collect();
    let mut out = Obj(vec![]);
    out.set("modes", Value::Arr(entries));
    out
}

/// The single plan's page (`src/cli.js:1192-1212`): `multiGraphPage` with the per-piece table, the one-piece and stacks
/// explanations, the weapon-only rows and the ratings.
pub fn page(plan: &Value, group: &str) -> String {
    let piece_table = format!(
        "<div class=\"table\"><table><thead><tr><th>Slot</th><th>Item</th><th>Base</th><th>Soul</th><th>Budget</th><th>Spent</th><th>Left</th><th>Enchantments</th></tr></thead><tbody>{}</tbody></table></div>",
        plan.get("rows")
            .items()
            .iter()
            .map(|r| format!(
                "<tr><td class=\"k\">{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td style=\"white-space:normal;min-width:320px\">{}</td></tr>",
                r.get("slot").to_js_string(),
                r.get("item").to_js_string(),
                r.get("base").to_js_string(),
                if r.get("soul").truthy() {
                    r.get("soul").to_js_string()
                } else {
                    "-".to_owned()
                },
                r.get("budget").to_js_string(),
                r.get("spent").to_js_string(),
                r.get("left").to_js_string(),
                effects_html(r)
            ))
            .collect::<String>()
    );
    let one_table = format!(
        "<div class=\"table\"><h3>Only one piece needs it</h3><table><thead><tr><th>Effect</th><th>Placed on</th><th>Why</th></tr></thead><tbody>{}</tbody></table></div>",
        plan.get("onePiece")
            .items()
            .iter()
            .map(|u| {
                let placed = placed_slots(plan, u.get("type"));
                format!(
                    "<tr><td class=\"k\">{}</td><td>{}</td><td style=\"white-space:normal\">{}</td></tr>",
                    enchantment_name(&u.get("type").to_js_string()),
                    if placed.is_empty() { "-".to_owned() } else { placed.join(", ") },
                    u.get("why").to_js_string()
                )
            })
            .collect::<String>()
    );
    let stack_body: String = plan
        .get("stacks")
        .items()
        .iter()
        .filter_map(|u| {
            let n = plan
                .get("rows")
                .items()
                .iter()
                .map(|r| {
                    r.get("effects")
                        .items()
                        .iter()
                        .filter(|e| e.get("type").strict_eq(u.get("type")))
                        .count()
                })
                .sum::<usize>();
            (n > 0).then(|| {
                format!(
                    "<tr><td class=\"k\">{}</td><td>{}</td><td style=\"white-space:normal\">{}</td></tr>",
                    enchantment_name(&u.get("type").to_js_string()),
                    number_to_string(n as f64),
                    u.get("why").to_js_string()
                )
            })
        })
        .collect();
    let stack_table = format!(
        "<div class=\"table\"><h3>Stacks per piece</h3><table><thead><tr><th>Effect</th><th>Copies</th><th>Why</th></tr></thead><tbody>{stack_body}</tbody></table></div>"
    );
    let weapon_table = format!(
        "<div class=\"table\"><h3>Weapon only</h3><table><thead><tr><th>Effect</th><th>Why</th></tr></thead><tbody>{}</tbody></table></div>",
        plan.get("weaponOnly")
            .items()
            .iter()
            .map(|u| format!(
                "<tr><td class=\"k\">{}</td><td style=\"white-space:normal\">{}</td></tr>",
                enchantment_name(&u.get("type").to_js_string()),
                u.get("why").to_js_string()
            ))
            .collect::<String>()
    );
    let ratings = plan.get("ratings");
    let mut rating_rows: Vec<[String; 5]> = Vec::new();
    for r in ratings.get("weapon").items() {
        rating_rows.push([
            "Weapon proc".to_owned(),
            r.get("label").to_js_string(),
            format!(
                "{} DPS ({} / 1k)",
                fmt(r.get("value").to_number()),
                fmt(r.get("value").to_number() * 1000.0 / r.get("cost").to_number())
            ),
            r.get("cost").to_js_string(),
            r.get("chosen").to_js_string(),
        ]);
    }
    for r in ratings.get("skills").items() {
        rating_rows.push([
            "Skill +15".to_owned(),
            r.get("label").to_js_string(),
            format!(
                "{} DPS no-cap, {} at the cap",
                fmt(r.get("futureValue").to_number()),
                fmt(r.get("value").to_number())
            ),
            r.get("cost").to_js_string(),
            r.get("chosen").to_js_string(),
        ]);
    }
    for r in ratings.get("utility").items() {
        rating_rows.push([
            "Utility".to_owned(),
            r.get("label").to_js_string(),
            r.get("benefit").to_js_string(),
            r.get("cost").to_js_string(),
            r.get("chosen").to_js_string(),
        ]);
    }
    let rating_table = format!(
        "<div class=\"table\"><h3>How the effects rate</h3><table><thead><tr><th>Category</th><th>Effect</th><th>Benefit</th><th>Cost</th><th>Chosen</th></tr></thead><tbody>{}</tbody></table></div>",
        rating_rows
            .iter()
            .map(|r| format!(
                "<tr><td class=\"k\">{}</td><td>{}</td><td style=\"white-space:normal\">{}</td><td>{}</td><td>{}</td></tr>",
                r[0], r[1], r[2], r[3], r[4]
            ))
            .collect::<String>()
    );
    let shield = plan
        .get("rows")
        .items()
        .iter()
        .find(|r| {
            let slot = r.get("slot").to_js_string();
            slot.contains("Shield") || slot.contains("Buckler")
        })
        .map(|r| format!(" + {}", r.get("item").to_js_string()))
        .unwrap_or_default();
    let imprint = plan.get("imprint").get("base");
    let imprint_note = if imprint.truthy() {
        format!(
            " The weapon's imprint is separate from this budget: best boss {} ({} carried DPS), best uncapped {} ({} carried DPS).",
            imprint.get("power").get("name").to_js_string(),
            fmt(imprint.get("carriedDps").to_number()),
            plan.get("imprint").get("uncapped").get("power").get("name").to_js_string(),
            fmt(plan.get("imprint").get("uncapped").get("carriedUncappedDps").to_number())
        )
    } else {
        String::new()
    };
    let note = format!(
        "Boss-first fill against the level-45 Breach ({group}, 600 per-hit cap). Backstabbing is not planned: its ×3 is capped after the roll, so +15 Backstabbing adds no capped DPS on the capped weapons. Uncapped theory puts weapon skill and Critical Strike on every piece; cap-aware buys only what the current cap pays. One-piece effects go out once; Repairs Objects is a player-chosen count (default 1); Regens Health is optional and off by default (heal spells are stronger). Empty pieces have no remaining effect that added capped DPS. Strike procs are capped per hit too; the weapon holds {} proc row{} over its {}-swing Breach fight (10 condition a proc). {}{imprint_note}",
        plan.get("maxProcs").to_js_string(),
        if plan.get("maxProcs").to_number() == 1.0 { "" } else { "s" },
        plan.get("swings").to_js_string(),
        if plan.get("soulGem").truthy() {
            "The soul gem is applied to every piece."
        } else {
            "No soul gem: base template points only."
        }
    );
    multi_graph_page(
        "DFO enchant plan",
        &format!(
            "{}{}; {}. Budgets are the game's ItemTemplates enchantmentPoints plus the stated soul gem; a POWER is positive, a side effect negative.",
            plan.get("weaponName").to_js_string(),
            shield,
            if plan.get("soulGem").truthy() {
                format!("soul gem +{} on every piece", number_to_string(SOUL_GEM_POINTS))
            } else {
                "template enchantment points only".to_owned()
            }
        ),
        &[Section {
            title: "Per piece".to_owned(),
            note,
            chart: String::new(),
            table: piece_table + &one_table + &stack_table + &weapon_table + &rating_table,
        }],
    )
}

/// The whole text card (`src/cli.js:1160-1191`): the header, the optional imprint line, the piece table and the four
/// explanatory tables, each followed by the newline `console.log` adds. The caller prints it as is and appends its own
/// `enchant plan written: <file>` line.
pub fn text(plan: &Value) -> String {
    let mut printed = String::new();
    let shield = plan.get("shield");
    printed.push_str(&format!(
        "Enchant plan  |  {}{}  |  {}  |  Potent Vs: {}  |  {} strike proc{} (condition)\n",
        plan.get("weaponName").to_js_string(),
        if shield.truthy() {
            format!(" + {}", shield.to_js_string())
        } else {
            String::new()
        },
        if plan.get("soulGem").truthy() {
            format!("soul gem +{}", number_to_string(SOUL_GEM_POINTS))
        } else {
            "template points only".to_owned()
        },
        plan.get("group").to_js_string(),
        plan.get("maxProcs").to_js_string(),
        if plan.get("maxProcs").to_number() == 1.0 {
            ""
        } else {
            "s"
        },
    ));
    let base = plan.get("imprint").get("base");
    if base.truthy() {
        let uncapped = plan.get("imprint").get("uncapped");
        let boss = base.get("carriedDps").to_number();
        let no_cap = uncapped.get("carriedUncappedDps").to_number();
        printed.push_str(&format!(
            "Weapon imprint (separate, carried mean): boss {} {} (+{}); uncapped {} {} (+{})\n",
            base.get("power").get("name").to_js_string(),
            fmt(boss),
            fmt(boss - plan.get("carriedBaseDps").to_number()),
            uncapped.get("power").get("name").to_js_string(),
            fmt(no_cap),
            fmt(no_cap - plan.get("carriedUncappedDps").to_number()),
        ));
    }
    printed.push('\n');
    printed.push_str(&table(
        &piece_rows(plan),
        &[
            "Slot",
            "Item",
            "Base",
            "Soul",
            "Budget",
            "Spent",
            "Left",
            "Enchantments",
        ],
        &[false, false, true, true, true, true, true, false],
    ));
    printed.push('\n');
    printed.push_str("\nOnly one piece needs it\n");
    printed.push_str(&table(
        &one_piece_rows(plan),
        &["Effect", "Placed on", "Why"],
        &[false, false, false],
    ));
    printed.push('\n');
    printed.push_str("\nStacks per piece\n");
    printed.push_str(&table(
        &stack_rows(plan),
        &["Effect", "Copies", "Why"],
        &[false, true, false],
    ));
    printed.push('\n');
    printed.push_str("\nHow the effects rate\n");
    printed.push_str(&rating_tables(plan));
    printed.push('\n');
    printed
}
