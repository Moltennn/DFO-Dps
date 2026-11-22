//! The singular `spell` cards of `src/cli.js:1516-1599` (R8): the resolved spellbook table (`--list`), the priced
//! spell table (`--all-spells`) and one spell's rotation card, plus their `--json` documents.
//!
//! Pure data in and strings out: the character, the resolved pool, the target and the branch's `opts` record come from
//! the caller, and every number comes from the shared core (`dfo_core::spells::{analyze_spell, spell_cost,
//! spell_rotation}`). This module owns only the JS `fmt`/`fmt2`/`pc`/`table` helpers, the pool pricing and JavaScript
//! sort, the selection cells, the cards and the `--json` shapes. No file I/O, no `--data` lookup, no pool resolution,
//! no target selection and no CLI wiring.
//!
//! The one deliberate JS stdout oddity is kept: `--all-spells` prints its table through `console.log` (not `textOut`),
//! so `--json --all-spells` prints the table *and* the JSON document, while the rotation card's `textOut` lines are
//! suppressed under `--json`.
//!
//! [`fmt`] and [`table`] are local copies of the CLI's private helpers (`src/cli.js:386-399`), as `imprints`,
//! `enchant` and `tradeoff` keep theirs, so this module and `tests/spell.rs` compile without `main.rs`.

use std::cmp::Ordering;

use dfo_core::enchant_plan::grouped_number_of;
use dfo_core::round::math_round;
use dfo_core::save::{character_label, skill_name};
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

/// JS `` `${Math.round(v * 100)}%` ``; `-` for a non-finite input (`src/cli.js:388`). `number_to_string` is `String`,
/// so a rounded `-0` prints `0%` and a huge value keeps JS's exponent form.
fn pc(v: f64) -> String {
    if !v.is_finite() {
        return "-".to_owned();
    }
    format!("{}%", number_to_string(math_round(v * 100.0)))
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

/// One priced record: the spell as it appears in the pool and its `analyzeSpell` card.
#[derive(Clone, Debug)]
pub struct Priced {
    pub sp: Value,
    pub r: Value,
}

/// `b.r.dps - a.r.dps` (`src/cli.js:1542,1545`): a NaN difference is JS's "equal", so the stable sort keeps the pool
/// order there (Rust `sort_by` is stable too).
pub fn by_dps(a: &Priced, b: &Priced) -> Ordering {
    let diff = b.r.get("dps").to_number() - a.r.get("dps").to_number();
    if diff.is_nan() || diff == 0.0 {
        Ordering::Equal
    } else if diff < 0.0 {
        Ordering::Less
    } else {
        Ordering::Greater
    }
}

fn priced_from(pool: &[Value], ch: &Value, target: &Value, opts: &Value) -> Vec<Priced> {
    let mut out: Vec<Priced> = pool
        .iter()
        .map(|sp| Priced {
            sp: sp.clone(),
            r: analyze_spell(sp, ch, target, opts),
        })
        .collect();
    out.sort_by(by_dps);
    out
}

/// `priced` (`src/cli.js:1540-1542`): the pool's damaging, non-debug records, sorted by DPS (descending).
pub fn price_pool(pool: &[Value], ch: &Value, target: &Value, opts: &Value) -> Vec<Priced> {
    priced_from(pool, ch, target, opts)
        .into_iter()
        .filter(|x| x.r.get("damage").to_number() > 0.0 && !debug_name(&x.sp))
        .collect()
}

/// `searchPriced` (`src/cli.js:1543-1545`): the search pool's damaging records, sorted by DPS. The debug-name filter is
/// deliberately absent here, as in the JS, so `--spell "Lvl 1 Probe"` can still find the record.
pub fn price_search(
    search_pool: &[Value],
    ch: &Value,
    target: &Value,
    opts: &Value,
) -> Vec<Priced> {
    priced_from(search_pool, ch, target, opts)
        .into_iter()
        .filter(|x| x.r.get("damage").to_number() > 0.0)
        .collect()
}

/// `values.spell` selection (`src/cli.js:1560-1567`): without a query the best priced record; with one, an index or
/// case-insensitive name match first, then a name substring. `None` means the query found nothing (the caller's
/// `UsageError`), or a query-less selection over an empty pool (the JS destructuring crash).
pub fn select<'a>(
    priced: &'a [Priced],
    search_priced: &'a [Priced],
    query: Option<&str>,
) -> Option<&'a Priced> {
    let Some(query) = query else {
        return priced.first();
    };
    let q = query.trim();
    let lower = q.to_lowercase();
    let exact = |x: &Priced| {
        x.sp.get("index").to_js_string() == q
            || x.sp.get("name").to_js_string().to_lowercase() == lower
    };
    search_priced.iter().find(|x| exact(x)).or_else(|| {
        search_priced.iter().find(|x| {
            x.sp.get("name")
                .to_js_string()
                .to_lowercase()
                .contains(&lower)
        })
    })
}

/// `--all-spells`' table (`src/cli.js:1556`), with the newline `console.log` adds. Printed even under `--json` (the JS
/// branch uses `console.log`, not `textOut`), which is why the command can append [`all_spells_document`] after it.
pub fn all_spells_text(rows: &[Priced]) -> String {
    let cells: Vec<Vec<String>> = rows
        .iter()
        .map(|x| {
            let r = &x.r;
            vec![
                name_cell(&x.sp),
                skill_name(r.get("school")).to_js_string(),
                number_to_string(r.get("cost").to_number()),
                fmt(r.get("damage").to_number()),
                fmt(r.get("dps").to_number()),
                format!("{}s", fmt2(r.get("castSeconds").to_number())),
                number_to_string(r.get("castsPerPool").to_number()),
                fmt(r.get("poolDamage").to_number()),
            ]
        })
        .collect();
    format!(
        "{}\n",
        table(
            &cells,
            &["Spell", "School", "Cost", "Damage", "DPS", "Cast", "Casts", "Pool dmg",],
            &[false, false, true, true, true, true, true, true],
        )
    )
}

/// `{ index: sp.index, name: sp.name, ...r }` (`src/cli.js:1557,1597`) in the JS key order: the spread's `index` and
/// `name` overwrite the two leading keys in place.
fn document(sp: &Value, r: &Value) -> Value {
    let mut out = Value::Obj(Vec::new());
    out.set("index", sp.get("index").clone());
    out.set("name", sp.get("name").clone());
    for (k, v) in r.entries() {
        out.set(k, v.clone());
    }
    out
}

/// The `--all-spells` `--json` document (`src/cli.js:1557`): one entry per priced record, in the table's order.
pub fn all_spells_document(rows: &[Priced]) -> Value {
    Value::Arr(
        rows.iter()
            .map(|x| document(&x.sp, &x.r))
            .collect::<Vec<_>>(),
    )
}

/// `r.elements?.length` + the effects table (`src/cli.js:1593-1595`). The rounds cell is `e.rounds ?? 1` passed raw to
/// `table`, and the note is `e.note ?? ''`.
fn effects_text(r: &Value) -> String {
    let rows: Vec<Vec<String>> = r
        .get("elements")
        .items()
        .iter()
        .map(|e| {
            let magnitude = e.get("magnitude");
            vec![
                e.get("key").to_js_string(),
                if magnitude.is_nullish() {
                    "-".to_owned()
                } else {
                    fmt(magnitude.to_number())
                },
                if e.get("rounds").is_nullish() {
                    "1".to_owned()
                } else {
                    e.get("rounds").to_js_string()
                },
                fmt(e.get("damage").to_number()),
                if e.get("note").is_nullish() {
                    String::new()
                } else {
                    e.get("note").to_js_string()
                },
            ]
        })
        .collect();
    table(
        &rows,
        &["Effect", "Magnitude", "Rounds", "Damage", "Note"],
        &[false, true, true, true, false],
    )
}

/// The one-spell rotation card (`src/cli.js:1570-1596`): the label, the metrics table, then the effects block. Each
/// `textOut` line is followed by the newline `console.log` adds; the caller prints the result as is. Under `--json` the
/// JS `textOut` prints nothing, so the caller uses [`rotation_document`] alone.
///
/// `target` is the raw `values.target` flag the JS prints (not the resolved target's name), and `spell_target` supplies
/// the resolved level and boss pool. `r` is `spellRotation`, already computed by the caller.
pub fn rotation_text(
    ch: &Value,
    sp: &Value,
    r: &Value,
    target: &str,
    spell_target: &Value,
) -> String {
    let dot = r.get("dotRounds").truthy();
    let mana_solved = r.get("manaSolved").truthy();
    let num = |k: &str| number_to_string(r.get(k).to_number());
    let mut rows: Vec<Vec<String>> = vec![
        vec!["Spell cost".to_owned(), format!("{} SP", num("cost"))],
        vec![
            "Instant damage".to_owned(),
            fmt(r.get("instant").to_number()),
        ],
    ];
    if dot {
        rows.push(vec![
            "DoT per tick".to_owned(),
            fmt(r.get("dotPerTick").to_number()),
        ]);
        rows.push(vec![
            "DoT duration".to_owned(),
            format!(
                "{} rounds ({} s)",
                num("dotRounds"),
                fmt(r.get("dotSeconds").to_number())
            ),
        ]);
        rows.push(vec![
            "DoT total".to_owned(),
            fmt(r.get("dotTotal").to_number()),
        ]);
    }
    rows.extend([
        vec!["Damage / cast".to_owned(), fmt(r.get("damage").to_number())],
        vec![
            "Cast time".to_owned(),
            format!("{} s", fmt2(r.get("castSeconds").to_number())),
        ],
        vec!["Burst DPS".to_owned(), fmt(r.get("burstDps").to_number())],
        vec!["DPS".to_owned(), fmt(r.get("dps").to_number())],
        vec!["Magicka pool".to_owned(), num("magicka")],
        vec![
            "Fight window".to_owned(),
            format!("{} s", fmt(r.get("seconds").to_number())),
        ],
        vec!["Casts used".to_owned(), num("casts")],
        vec![
            "Total damage".to_owned(),
            fmt(r.get("totalDamage").to_number()),
        ],
        vec!["Cast DPS".to_owned(), fmt(r.get("manaDps").to_number())],
        vec!["Window DPS".to_owned(), fmt(r.get("windowDps").to_number())],
    ]);
    if dot {
        rows.push(vec!["DoT DPS".to_owned(), fmt(r.get("dotDps").to_number())]);
    }
    rows.push(vec![
        "Mana solved".to_owned(),
        if mana_solved { "yes" } else { "no" }.to_owned(),
    ]);
    if !mana_solved {
        rows.push(vec![
            "Time to empty".to_owned(),
            format!("{} s", fmt(r.get("timeToEmpty").to_number())),
        ]);
        let pool_kill = r.get("poolKill");
        rows.push(vec![
            "Pool kill".to_owned(),
            if pool_kill.is_nullish() {
                "-".to_owned()
            } else if pool_kill.truthy() {
                "yes".to_owned()
            } else {
                "no".to_owned()
            },
        ]);
        rows.push(vec![
            "Mana left".to_owned(),
            fmt(r.get("manaLeft").to_number()),
        ]);
    }
    rows.push(vec![
        "Saving throw".to_owned(),
        format!("{} lands", pc(r.get("saving").to_number())),
    ]);
    rows.push(vec![
        "Power multiplier".to_owned(),
        format!("x{}", fmt2(r.get("powerMult").to_number())),
    ]);
    let is_boss = spell_target.get("isBoss").truthy();
    rows.push(vec![
        "Target".to_owned(),
        format!(
            "{}, level {}{}",
            if is_boss { "Breach" } else { target },
            spell_target.get("level").to_js_string(),
            if is_boss {
                format!(
                    ", {} HP",
                    grouped_number_of(spell_target.get("maxHealth").to_number())
                )
            } else {
                String::new()
            }
        ),
    ]);
    let ttk = r.get("ttk");
    rows.push(vec![
        "Time to kill".to_owned(),
        if ttk.truthy() {
            format!("{} s", fmt(ttk.to_number()))
        } else {
            "-".to_owned()
        },
    ]);
    let mut out = format!(
        "{}  |  {} ({})\n{}\n",
        character_label(ch),
        sp.get("name").to_js_string(),
        skill_name(r.get("school")).to_js_string(),
        table(&rows, &["Metric", "Value"], &[])
    );
    if !r.get("elements").items().is_empty() {
        out.push_str(&format!("\nEffects\n{}\n", effects_text(r)));
    }
    out
}

/// The one-spell `--json` document (`src/cli.js:1597`).
pub fn rotation_document(sp: &Value, r: &Value) -> Value {
    document(sp, r)
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
