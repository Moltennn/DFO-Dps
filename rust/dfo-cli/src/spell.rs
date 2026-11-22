//! The `spell --list` terminal card of `src/cli.js:1550-1554` (R8): the header line and the spellbook table.
//!
//! Pure data in and strings out: the character, the resolved pool, the target and the branch's `opts` record come from
//! the caller, and every number comes from the shared core (`dfo_core::spells::spell_cost` and `analyze_spell`). This
//! module owns only the JS `fmt`/`table` helpers, the `index ?? '-'` / `String(name ?? '')` cells and the caption.
//! No file I/O, no `--data` lookup, no pool resolution, no `priced` gate and no CLI wiring; `--json` is refused for
//! `spell --list` by `checkOutputFlags` (`src/cli.js:892`), so there is no document to return.
//!
//! [`fmt`] and [`table`] are local copies of the CLI's private helpers (`src/cli.js:386-399`), as `imprints`,
//! `enchant` and `tradeoff` keep theirs, so this module and `tests/spell.rs` compile without `main.rs`.

use dfo_core::round::math_round;
use dfo_core::save::character_label;
use dfo_core::spells::{analyze_spell, spell_cost};
use dfo_core::value::{number_to_string, Value};

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

/// `sp.index ?? '-'`: a custom record need not carry an index.
fn index_cell(sp: &Value) -> String {
    let index = sp.get("index");
    if index.is_nullish() {
        "-".to_owned()
    } else {
        index.to_js_string()
    }
}

/// `String(sp.name ?? '')`: the `table` helper's own `String(c ?? '')`, not a `-` placeholder.
fn name_cell(sp: &Value) -> String {
    let name = sp.get("name");
    if name.is_nullish() {
        String::new()
    } else {
        name.to_js_string()
    }
}

/// `debugName` (`src/cli.js:1539`): `^(Lvl |!)/i.test(String(sp?.name ?? ''))`. A record with no name is not a debug
/// name (`String(undefined ?? '')` is `''`).
pub fn debug_name(sp: &Value) -> bool {
    let name = sp.get("name");
    let text = if name.is_nullish() {
        String::new()
    } else {
        name.to_js_string().to_lowercase()
    };
    text.starts_with("lvl ") || text.starts_with('!')
}

/// `priced`'s per-record test (`src/cli.js:1540-1545`): a damaging record that is not a debug name. The `--list`
/// branch still gates on this pool being non-empty, even though the list itself shows every record.
#[allow(dead_code)]
pub fn priced(sp: &Value, ch: &Value, target: &Value, opts: &Value) -> bool {
    !debug_name(sp)
        && analyze_spell(sp, ch, target, opts)
            .get("damage")
            .to_number()
            > 0.0
}

/// The card (`src/cli.js:1550-1554`): the label line, then the table, each followed by the newline `console.log`
/// adds. `pool` is the already-resolved spellbook in the JS pool's order; `target` and `opts` are the branch's
/// `spellTarget` and `opts` records. The caller prints the result as is.
pub fn text(ch: &Value, pool: &[Value], target: &Value, opts: &Value) -> String {
    let online = !ch.get("online").strict_eq(&Value::Bool(false));
    let rows: Vec<Vec<String>> = pool
        .iter()
        .map(|sp| {
            let damage = analyze_spell(sp, ch, target, opts)
                .get("damage")
                .to_number();
            vec![
                index_cell(sp),
                name_cell(sp),
                number_to_string(spell_cost(sp, ch, online)),
                fmt(damage),
            ]
        })
        .collect();
    format!(
        "{}  |  {} spell(s)\n{}\n",
        character_label(ch),
        pool.len(),
        table(
            &rows,
            &["Index", "Spell", "Cost", "Damage"],
            &[true, false, true, true],
        )
    )
}
