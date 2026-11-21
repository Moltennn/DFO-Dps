//! The `enchant` card of `src/cli.js:1449-1477` (R8): the enchantment rows table, the metrics table and the `--json`
//! document. Pure data in, strings out: no file I/O, no target selection, no analysis and no CLI wiring.
//!
//! The rows and every number are already computed by the caller - `dfo_core::enchants`' strike payload and
//! `dfo_core::analyze`'s card - so nothing here changes a DPS figure. Only the captions, the JS `fmt`/`table` and the
//! JS `--json` shape are owned here. The JS branch (`src/cli.js:1449-1477`) is not exported, so `tests/enchant.rs`
//! drives the real modules and the branch's own template strings against these functions.
//!
//! [`text`] is the three `textOut` calls joined by newlines, with the trailing one a `console.log` would add; the
//! caller must not add another. [`document`] is the `--json` object, left as a [`Value`] for the CLI's own encoder.
//! `fmt`, `table` and the JS `length` are local copies, as `report`'s and `imprints`' are, so this module and its test
//! compile on their own.
//!
//! The branch refuses a character with no weapon before it renders (`src/cli.js:1451-1454`); [`text`] and [`document`]
//! take an item and do not repeat that refusal.
//!
//! shortcut: a row's `type` is read as a number for the name lookup (`ENCHANTMENT_TYPES` has numeric keys); a string
//! `"2"` would print the raw text in the JS but the name here. Real items carry numbers; revisit if a reader accepts
//! string types.

use dfo_core::enchants::enchantment_rows;
use dfo_core::generated::enchant_data::ENCHANTMENT_TYPE_ID;
use dfo_core::round::math_round;
use dfo_core::save::character_label;
use dfo_core::value::{number_to_string, Value, Value::Num};

/// JS `(Math.round(v * 10) / 10).toFixed(1)`; `-` for a non-finite input (`src/cli.js:386`).
fn fmt(v: f64) -> String {
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
fn table(rows: &[Vec<String>], headers: &[&str], aligns: &[bool]) -> String {
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

/// The JS `names[e.type] ?? e.type` (`src/cli.js:1458`): the reverse of `ENCHANTMENT_TYPES` (Name -> id).
fn type_name(kind: &Value) -> String {
    let id = kind.to_number();
    ENCHANTMENT_TYPE_ID
        .iter()
        .find(|(_, v)| *v == id)
        .map_or_else(|| kind.to_js_string(), |(name, _)| (*name).to_owned())
}

/// `e.param ?? '-'` (`src/cli.js:1462`): a missing param prints the JS `-`.
fn param_cell(e: &Value) -> String {
    if e.get("param").is_nullish() {
        "-".to_owned()
    } else {
        e.get("param").to_js_string()
    }
}

/// `strike.procs.find((p) => p.index === Number(e.param))?.name ?? 'spell'` for a Cast When Strikes row.
fn spell_cell(e: &Value, strike: &Value) -> String {
    if !e.get("type").strict_eq(&Num(2.0)) {
        return "-".to_owned();
    }
    let index = e.get("param").to_number();
    strike
        .get("procs")
        .items()
        .iter()
        .find(|p| p.get("index").strict_eq(&Num(index)))
        .map_or_else(|| "spell".to_owned(), |p| p.get("name").to_js_string())
}

/// The rows of the enchantment table (`src/cli.js:1462`), item order.
fn row_cells(item: &Value, strike: &Value) -> Vec<Vec<String>> {
    enchantment_rows(item)
        .map(|e| {
            vec![
                type_name(e.get("type")),
                param_cell(e),
                spell_cell(e, strike),
            ]
        })
        .collect()
}

/// The enchantment table (`src/cli.js:1462`): `Enchantment`, `Param`, `Spell`.
fn rows_table(item: &Value, strike: &Value) -> String {
    table(
        &row_cells(item, strike),
        &["Enchantment", "Param", "Spell"],
        &[false, true, false],
    )
}

/// `strike.procs.map((p) => \`${p.name} ${p.dotTick ? \`DoT ${fmt(p.dotTick)}/round\` : fmt(p.damage)}\`).join(', ') || '-'`.
fn procs_cell(strike: &Value) -> String {
    let joined = strike
        .get("procs")
        .items()
        .iter()
        .map(|p| {
            let amount = if p.get("dotTick").truthy() {
                format!("DoT {}/round", fmt(p.get("dotTick").to_number()))
            } else {
                fmt(p.get("damage").to_number())
            };
            format!("{} {amount}", p.get("name").to_js_string())
        })
        .collect::<Vec<_>>()
        .join(", ");
    if joined.is_empty() {
        "-".to_owned()
    } else {
        joined
    }
}

/// The metric rows (`src/cli.js:1463-1474`), in the branch's order.
fn metric_cells(strike: &Value, card: &Value) -> Vec<Vec<String>> {
    let dot = strike.get("procDot");
    let per_hit = format!(
        "{}{}",
        fmt(strike.get("procDamage").to_number() + strike.get("flat").to_number()),
        if dot.truthy() {
            format!(" + {} DoT DPS", fmt(dot.to_number() / 5.0))
        } else {
            String::new()
        }
    );
    let mut rows = vec![
        vec![
            "Uncapped weapon DPS".to_owned(),
            fmt(card.get("dps").to_number()),
        ],
        vec!["Enchant per landed hit".to_owned(), per_hit],
        vec![
            "Enchant DPS (ceiling component)".to_owned(),
            fmt(card.get("enchantDps").to_number()),
        ],
        vec![
            "Total (per-hit-capped ceiling)".to_owned(),
            fmt(card.get("ceilingTotalDps").to_number()),
        ],
    ];
    if card.get("target").get("allowance").truthy() {
        let ttk = card.get("totalTtk");
        rows.push(vec![
            "Allowance-sustained DPS".to_owned(),
            fmt(card.get("claimSustainedDps").to_number()),
        ]);
        rows.push(vec![
            "Time to kill (allowance-sustained)".to_owned(),
            if !ttk.is_nullish() {
                format!("{} s", fmt(ttk.to_number()))
            } else if card.get("allowance").truthy() {
                "no kill".to_owned()
            } else {
                "no allowance run".to_owned()
            },
        ]);
        rows.push(vec![
            "Time to kill (per-hit-capped ceiling)".to_owned(),
            if card.get("ceilingTotalTtk").truthy() {
                format!("{} s", fmt(card.get("ceilingTotalTtk").to_number()))
            } else {
                "-".to_owned()
            },
        ]);
    }
    rows.push(vec![
        "CWS bills covered (bill-only)".to_owned(),
        if card.get("procsBeforeBreak").is_nullish() {
            "-".to_owned()
        } else {
            card.get("procsBeforeBreak").to_js_string()
        },
    ]);
    rows.push(vec!["Procs".to_owned(), procs_cell(strike)]);
    rows
}

/// The metrics table (`src/cli.js:1463-1475`): each `console.log` line, no trailing newline.
fn metrics_table(strike: &Value, card: &Value) -> String {
    table(&metric_cells(strike, card), &["Metric", "Value"], &[])
}

/// The whole text card (`src/cli.js:1461-1475`): the label, the enchantment rows and the metrics, each followed by
/// the newline `console.log` adds. The caller prints it as is.
pub fn text(ch: &Value, item: &Value, strike: &Value, card: &Value) -> String {
    let name = if item.get("name").is_nullish() {
        "weapon".to_owned()
    } else {
        item.get("name").to_js_string()
    };
    format!(
        "{}  |  {}\n{}\n{}\n",
        character_label(ch),
        name,
        rows_table(item, strike),
        metrics_table(strike, card)
    )
}

/// The `--json` document (`src/cli.js:1476`) in the JS key order, ready for the CLI's encoder. `enchantments` is the
/// same filtered rows the table draws, not the table's cells.
pub fn document(item: &Value, strike: &Value, card: &Value) -> Value {
    let mut result = Value::Obj(Vec::new());
    for (key, source) in [
        ("weaponDps", "dps"),
        ("enchantDps", "enchantDps"),
        ("totalDps", "totalDps"),
        ("totalTtk", "totalTtk"),
        ("ceilingTotalDps", "ceilingTotalDps"),
        ("ceilingTotalTtk", "ceilingTotalTtk"),
        ("claimTotalTtk", "claimTotalTtk"),
        ("claimSustainedDps", "claimSustainedDps"),
        ("procsBeforeBreak", "procsBeforeBreak"),
        ("procsBeforeBreakBasis", "procsBeforeBreakBasis"),
    ] {
        result.set(key, card.get(source).clone());
    }
    let mut out = Value::Obj(Vec::new());
    out.set(
        "enchantments",
        Value::Arr(enchantment_rows(item).cloned().collect()),
    );
    out.set("strike", strike.clone());
    out.set("result", result);
    out
}
