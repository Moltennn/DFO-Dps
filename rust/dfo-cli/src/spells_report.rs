//! The plural `spells` HTML page of `src/cli.js:1480-1514` (R8): the ranked rotation list, its two bar charts, the
//! table and the `--json` document.
//!
//! Pure data in, one HTML string / one [`Value`] out: the character, the target and the branch's `opts` come from the
//! caller, and every spell number is the shared core's (`dfo_core::spells::spell_rotation`, which is `analyze_spell` and
//! `spell_cost` in one card, and `dfo_core::save::skill_name`). This module owns only the branch's `list` construction
//! (`:1492-1494`), the JS `fmt`, the table markup, the two `barChart` calls, the subtitle and the `multiGraphPage` shell.
//!
//! No file I/O, no `--data` lookup, no pool resolution, no `--out` name, no page write and no CLI wiring: the command
//! that reads `standardSpells`/`resolveSpells`, applies the theory caster, writes `spells.html` and prints
//! `spells page written:` lives in `main.rs`. The empty list is the caller's `No standard damage spells found. Check
//! --data / ARENA2.` line (`:1495`), before any page is built.
//!
//! [`fmt`] is a local copy of the CLI's private helper (`src/cli.js:386`), as `spell`, `imprints` and `tradeoff` keep
//! theirs, so this module and `tests/spells_report.rs` compile without `main.rs`. The debug-name filter is the singular
//! branch's own [`crate::spell::debug_name`], not a second regex. The subtitle's HP grouping is
//! `dfo_core::enchant_plan::grouped_number_of`, the port's documented en-US pin of `toLocaleString()` (a non-en-US host
//! would group differently in the JS; no locale dependency is added here).

use std::cmp::Ordering;

use dfo_core::enchant_plan::grouped_number_of;
use dfo_core::round::{js_max, math_round};
use dfo_core::save::{character_label, skill_name};
use dfo_core::spells::{spell_rotation, Spellbook};
use dfo_core::value::{number_to_string, Value, Value::Num};

use crate::graph::{bar_chart, multi_graph_page, BarChart, BarSeries, Section};
use crate::spell::debug_name;

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

/// One `{ sp, r }` row of the branch's `list`.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub spell: Value,
    pub rotation: Value,
}

impl Entry {
    pub fn window_dps(&self) -> f64 {
        self.rotation.get("windowDps").to_number()
    }
}

/// The plural pool merge (`src/cli.js:1485`): `[...standard.values(), ...known.filter((sp) => !standard.has(sp.index))]`.
/// Every standard record in the book's own order, then the save's records `resolve_spells` kept that the book does not
/// already carry. `known` is `resolveSpells(ch.spells, standard)`'s output, so its stock indices are the same records
/// the first half supplies and only its custom records survive the filter.
pub fn pool(standard: &Spellbook, known: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = standard
        .entries()
        .iter()
        .map(|(_, sp)| sp.clone())
        .collect();
    out.extend(
        known
            .iter()
            .filter(|sp| standard.get(sp.get("index")).is_none())
            .cloned(),
    );
    out
}

/// The branch's `list` (`src/cli.js:1492-1494`): every pool record at the `seconds` window, a nonzero `damage` and not
/// a debug name, highest `windowDps` first. `opts` is the branch's option record without `seconds`; each call gets
/// `{ ...opts, seconds }`. The sort is stable, and a NaN difference is JS's "equal" (the insertion order is kept).
pub fn ranked(
    pool: &[Value],
    ch: &Value,
    target: &Value,
    opts: &Value,
    seconds: f64,
) -> Vec<Entry> {
    let mut opts = opts.clone();
    opts.set("seconds", Num(seconds));
    let mut list: Vec<Entry> = pool
        .iter()
        .map(|sp| Entry {
            spell: sp.clone(),
            rotation: spell_rotation(sp, ch, target, &opts),
        })
        .filter(|e| e.rotation.get("damage").to_number() > 0.0 && !debug_name(&e.spell))
        .collect();
    list.sort_by(|a, b| {
        let d = b.window_dps() - a.window_dps();
        if d < 0.0 {
            Ordering::Less
        } else if d > 0.0 {
            Ordering::Greater
        } else {
            Ordering::Equal
        }
    });
    list
}

/// One row of the page table (`src/cli.js:1499`). `sp.name` and `skillName(r.school)` are inserted raw, as the JS does;
/// the numbers are the JS `${...}` string forms.
fn table_row(e: &Entry) -> String {
    let sp = &e.spell;
    let r = &e.rotation;
    let cost = r.get("cost").to_number();
    let dot_rounds = r.get("dotRounds");
    format!(
        "<tr><td class=\"k\">{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
        sp.get("name").to_js_string(),
        skill_name(r.get("school")).to_js_string(),
        r.get("cost").to_js_string(),
        fmt(r.get("damage").to_number()),
        fmt(r.get("windowDps").to_number()),
        fmt(r.get("manaDps").to_number()),
        fmt(r.get("dotDps").num_or(0.0)),
        fmt(r.get("damage").to_number() / js_max(1.0, cost)),
        if dot_rounds.truthy() {
            format!("{} r", dot_rounds.to_js_string())
        } else {
            "-".to_owned()
        }
    )
}

/// The table markup of the first section (`src/cli.js:1499`).
fn table_html(top: &[Entry]) -> String {
    format!(
        "<table><thead><tr><th>Spell</th><th>School</th><th>Cost</th><th>Damage</th><th>Window DPS</th><th>Cast DPS</th><th>DoT DPS</th><th>dmg/SP</th><th>DoT</th></tr></thead><tbody>{}</tbody></table>",
        top.iter().map(table_row).collect::<String>()
    )
}

/// The branch's title, subtitle and two sections (`src/cli.js:1497-1507`). `seconds`, `potency` and `pierce` are the
/// already-resolved `n(values.seconds, 30)` / `n(values.potency, 0)` / `n(values.pierce, 0)`.
fn sections(
    ch: &Value,
    list: &[Entry],
    target: &Value,
    seconds: f64,
    potency: f64,
    pierce: f64,
) -> (String, Vec<Section>) {
    let top = &list[..list.len().min(20)];
    let labels: Vec<String> = top
        .iter()
        .map(|e| e.spell.get("name").to_js_string())
        .collect();
    let dps = bar_chart(&BarChart::new(
        "Sustained spell DPS (30s window)",
        labels.clone(),
        vec![BarSeries {
            name: "DPS".to_owned(),
            values: top
                .iter()
                .map(|e| e.rotation.get("windowDps").to_number())
                .collect(),
        }],
    ));
    let eff = bar_chart(&BarChart::new(
        "Damage per spell point",
        labels,
        vec![BarSeries {
            name: "dmg/SP".to_owned(),
            values: top
                .iter()
                .map(|e| {
                    e.rotation.get("damage").to_number()
                        / js_max(1.0, e.rotation.get("cost").to_number())
                })
                .collect(),
        }],
    ));
    let target_text = if target.get("isBoss").truthy() {
        format!(
            "Breach {} HP",
            grouped_number_of(target.get("maxHealth").to_number())
        )
    } else {
        format!("level {}", target.get("level").to_js_string())
    };
    let subtitle = format!(
        "{} | {} standard damage spells | {} | {}s window | potency {}% | pierce {}",
        character_label(ch),
        list.len(),
        target_text,
        number_to_string(seconds),
        number_to_string(potency),
        number_to_string(pierce)
    );
    let sections = vec![
        Section {
            title: "Sustained DPS".to_owned(),
            note: "Mana is treated as solved by default; --mana-limit prices the pool. A DoT is one instance per target and renews, never stacks. DPS cells are averages; the bar is the average.".to_owned(),
            chart: dps,
            table: table_html(top),
        },
        Section {
            title: "Damage per spell point".to_owned(),
            note: "The metric that binds a long fight. A 30s window may not spend the whole pool.".to_owned(),
            chart: eff,
            table: String::new(),
        },
    ];
    (subtitle, sections)
}

/// The whole page (`src/cli.js:1501-1508`): `multiGraphPage` with the branch's title and subtitle.
pub fn page(
    ch: &Value,
    list: &[Entry],
    target: &Value,
    seconds: f64,
    potency: f64,
    pierce: f64,
) -> String {
    let (subtitle, sections) = sections(ch, list, target, seconds, potency, pierce);
    multi_graph_page("DFO spell ceiling", &subtitle, &sections)
}

/// The `--json` document (`src/cli.js:1512`): `{ index: sp.index, name: sp.name, ...r }`. The spread's `r` carries its
/// own `name` and `index`, and a key set twice keeps its first position with the later value.
pub fn document(list: &[Entry]) -> Value {
    Value::Arr(
        list.iter()
            .map(|e| {
                let mut out = Value::Obj(vec![]);
                out.set("index", e.spell.get("index").clone());
                out.set("name", e.spell.get("name").clone());
                for (key, value) in e.rotation.entries() {
                    out.set(key, value.clone());
                }
                out
            })
            .collect(),
    )
}
