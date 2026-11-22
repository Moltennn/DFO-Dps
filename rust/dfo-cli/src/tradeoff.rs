//! The `tradeoff` card and `--json` document of `src/cli.js` (R8), pure data in and strings out.
//!
//! The pools, the two top-weapon cards and the speed/damage crossover are `src/cli.js:2204-2252`: the gate and five
//! Curbing pools, three one-change runs per pool (`+5%` attack speed, `+5%` damage), the headroom and verdict, then
//! `rankWeapons` at the gate and at 1,000 HP, then the best weapon at each health in the crossover list. Every number
//! comes from the existing read-only analysis (`dfo_core::analyze`, `gate_target`, `boss_target`, `rank_weapons`); this
//! module owns only the presentation: the JS `fmt`/`fmt2`/`table` helpers, the `toLocaleString` grouping and the verdict
//! text.
//!
//! The caller resolves the character (a save or `--theory`) and the base scenario exactly as the other cards do; the
//! module replaces only `target`, `health` and `traits` per pool (the JS `baseScenario` spread). `core_label` is the
//! typed `--core` the header prints (`values.core`), not the lower-cased scenario value. No file I/O, no clock, no
//! randomness and no CLI wiring live here: [`text`] returns the bytes the command prints, ending in the newline
//! `console.log` adds. `--json` is not this module's: [`document`] returns the plain record, and `main.rs` encodes it
//! with its own `JSON.stringify(v, null, 2)`, as `imprints` leaves its document to `main.rs`.
//!
//! [`fmt`], [`fmt2`] and [`table`] are local copies of the CLI's private helpers (`src/cli.js:386-399`), as
//! `imprints` and `report` keep theirs, so this module and `tests/tradeoff.rs` compile without `main.rs`.

use dfo_core::analyze::{analyze, boss_target, gate_target, rank_weapons};
use dfo_core::enchant_plan::grouped_number_of;
use dfo_core::round::{js_max, math_round};
use dfo_core::save::character_label;
use dfo_core::spells::Spellbook;
use dfo_core::value::Value::{Arr, Null, Num, Obj, Str};
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
    out.extend(rows.iter().map(|r| line(r)));
    out.join("\n")
}

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

fn strings(values: &[&str]) -> Value {
    Arr(values.iter().map(|s| Str((*s).to_owned())).collect())
}

/// One `out` row (`src/cli.js:2229`).
struct Pool {
    label: String,
    hp: f64,
    cap: f64,
    per_hit: f64,
    headroom: Option<f64>,
    speed: f64,
    speed_min: f64,
    speed_max: f64,
    dmg: f64,
    dmg_min: f64,
    dmg_max: f64,
    verdict: String,
}

/// One `crossover` row (`src/cli.js:2246`).
struct Cross {
    hp: f64,
    cap: f64,
    best: String,
    dps: f64,
    per_hit: f64,
}

/// `{ ...base, target, health, traits }`, the JS `baseScenario` spread of `src/cli.js:2218`.
fn pool_scenario(base: &Value, target: &Value, traits: &Value) -> Value {
    let mut out = match base {
        Obj(entries) => Obj(entries.clone()),
        _ => Obj(vec![]),
    };
    out.set("target", target.clone());
    out.set("health", Num(target.get("maxHealth").to_number()));
    out.set("traits", traits.clone());
    out
}

fn curbing() -> Value {
    strings(&["curbing"])
}

/// The six pools (`src/cli.js:2208-2215`): the shipped gate, then the Curbing reference bosses.
fn targets(level: &Value, players: f64, blow_x: f64) -> Vec<(String, Value)> {
    let boss = |health: f64| {
        boss_target(&obj([
            ("level", level.clone()),
            ("health", Num(health)),
            ("traits", curbing()),
        ]))
        .expect("a reference boss has no stand-in body")
    };
    vec![
        (
            "Gate - Ruhn".to_owned(),
            gate_target(
                level,
                &obj([("players", Num(players)), ("blowX", Num(blow_x))]),
            ),
        ),
        ("Curbing 1,000 HP".to_owned(), boss(1000.0)),
        ("Curbing 2,000 HP".to_owned(), boss(2000.0)),
        ("Curbing 5,000 HP".to_owned(), boss(5000.0)),
        ("Curbing 10,000 HP".to_owned(), boss(10000.0)),
        ("Curbing 25,000 HP".to_owned(), boss(25000.0)),
    ]
}

/// The `out` loop (`src/cli.js:2216-2230`).
fn pools(ch: &Value, base: &Value, targets: &[(String, Value)], book: &Spellbook) -> Vec<Pool> {
    targets
        .iter()
        .map(|(label, t)| {
            let traits = t.get("bossTraits");
            let traits = if traits.is_nullish() {
                Arr(vec![])
            } else {
                traits.clone()
            };
            let sc = pool_scenario(base, t, &traits);
            let base_run = analyze(ch, &sc, book);
            let mut speed_sc = Obj(sc.entries().to_vec());
            speed_sc.set("attackSpeedPct", Num(5.0));
            let speed = analyze(ch, &speed_sc, book);
            let mut dmg_sc = Obj(sc.entries().to_vec());
            dmg_sc.set("damagePct", Num(5.0));
            let dmg = analyze(ch, &dmg_sc, book);
            let hit = base_run.hit.get("hit").to_number();
            let per_hit = base_run.per_swing / js_max(1e-9, hit);
            let cap = base_run.cap;
            let headroom = if cap > 0.0 { Some(cap / per_hit) } else { None };
            let verdict = if cap == 0.0 || cap.is_nan() {
                "equal (no cap)".to_owned()
            } else if per_hit >= cap {
                "speed wins now".to_owned()
            } else {
                format!(
                    "damage until +{}%",
                    fmt((headroom.unwrap_or(0.0) - 1.0) * 100.0)
                )
            };
            Pool {
                label: label.clone(),
                hp: t.get("maxHealth").to_number(),
                cap,
                per_hit,
                headroom,
                speed: speed.capped_dps,
                speed_min: speed.capped_dps_min,
                speed_max: speed.capped_dps_max,
                dmg: dmg.capped_dps,
                dmg_min: dmg.capped_dps_min,
                dmg_max: dmg.capped_dps_max,
                verdict,
            }
        })
        .collect()
}

/// `rankWeapons(ch, sc, { top })` over one pool (`src/cli.js:2236,2244`).
fn ranked(ch: &Value, sc: &Value, top: f64, book: &Spellbook) -> Value {
    rank_weapons(ch, sc, &obj([("top", Num(top))]), book)
}

fn weapon_name(row: &Value) -> String {
    format!(
        "{} {}",
        row.get("materialName").to_js_string(),
        row.get("name").to_js_string()
    )
}

fn hands(row: &Value) -> &'static str {
    if row.get("twoHanded").truthy() {
        "2H"
    } else {
        "1H"
    }
}

/// The top-weapon card rows (`src/cli.js:2238`).
fn weapon_rows(rows: &Value) -> Vec<Vec<String>> {
    rows.items()
        .iter()
        .map(|x| {
            vec![
                weapon_name(x),
                hands(x).to_owned(),
                fmt(x.get("cappedDps").to_number()),
                fmt(x.get("perSwing").to_number()),
                fmt2(x.get("aps").to_number()),
            ]
        })
        .collect()
}

/// The crossover (`src/cli.js:2240-2247`): the best weapon by Curbing health.
fn crossover(ch: &Value, base: &Value, level: &Value, book: &Spellbook) -> Vec<Cross> {
    [
        500.0, 750.0, 1000.0, 1500.0, 2000.0, 2500.0, 3000.0, 4000.0, 5000.0, 6000.0, 8400.0,
        12000.0,
    ]
    .into_iter()
    .map(|hp| {
        let t = boss_target(&obj([
            ("level", level.clone()),
            ("health", Num(hp)),
            ("traits", curbing()),
        ]))
        .expect("a reference boss has no stand-in body");
        let sc = pool_scenario(base, &t, &curbing());
        let rows = ranked(ch, &sc, 1.0, book);
        let best = rows.at(0);
        let a = analyze(ch, &sc, book);
        Cross {
            hp,
            cap: a.cap,
            best: if best.truthy() {
                weapon_name(best)
            } else {
                "-".to_owned()
            },
            // `best?.cappedDps ?? 0` and `best?.perHit ?? 0`: an empty top-1 list is 0, not NaN.
            dps: if best.truthy() {
                best.get("cappedDps").to_number()
            } else {
                0.0
            },
            per_hit: if best.truthy() {
                best.get("perHit").to_number()
            } else {
                0.0
            },
        }
    })
    .collect()
}

fn pool_rows(rows: &[Pool]) -> Vec<Vec<String>> {
    rows.iter()
        .map(|x| {
            vec![
                x.label.clone(),
                grouped_number_of(x.hp),
                // `x.cap || '-'`: a zero or NaN cap prints a dash (NaN is falsy in JS).
                if x.cap == 0.0 || x.cap.is_nan() {
                    "-".to_owned()
                } else {
                    number_to_string(x.cap)
                },
                fmt(x.per_hit),
                // `x.headroom ? `${fmt(x.headroom)}x` : '-'`: 0 and NaN are falsy, an infinity is not.
                match x.headroom {
                    Some(h) if h != 0.0 && !h.is_nan() => format!("{}x", fmt(h)),
                    _ => "-".to_owned(),
                },
                fmt(x.speed),
                fmt(x.dmg),
                x.verdict.clone(),
            ]
        })
        .collect()
}

fn cross_rows(rows: &[Cross]) -> Vec<Vec<String>> {
    rows.iter()
        .map(|x| {
            vec![
                grouped_number_of(x.hp),
                number_to_string(x.cap),
                x.best.clone(),
                fmt(x.dps),
                fmt(x.per_hit),
            ]
        })
        .collect()
}

/// The text card (`src/cli.js:2231-2249`): every `textOut` line and table, newline-terminated.
pub fn text(
    ch: &Value,
    base: &Value,
    core_label: &str,
    players: f64,
    blow_x: f64,
    book: &Spellbook,
) -> String {
    let level = ch.get("level").clone();
    let targets = targets(&level, players, blow_x);
    let pools = pools(ch, base, &targets, book);
    let mut out = format!(
        "{}  |  {}{}  |  real pools\n",
        character_label(ch),
        core_label,
        if ch.get("online").truthy() {
            " / online"
        } else {
            " / offline"
        }
    );
    out.push_str(&table(
        &pool_rows(&pools),
        &[
            "Boss",
            "HP",
            "Cap",
            "Per hit",
            "Headroom",
            "+5% speed",
            "+5% dmg",
            "Verdict",
        ],
        &[false, true, true, true, true, true, true, false],
    ));
    out.push('\n');
    out.push_str(
        "\n+5% speed and +5% damage are separate one-change DPS runs against each pool.\n",
    );
    out.push_str("Headroom = cap / expected landed hit. Above 1x, damage can grow that many times before the cap makes speed strictly better; at or below 1x, speed is already better.\n");
    for (label, t) in [
        ("Breach", &targets[0].1),
        ("Curbing 1,000 HP", &targets[1].1),
    ] {
        let traits = t.get("bossTraits");
        let traits = if traits.is_nullish() {
            Arr(vec![])
        } else {
            traits.clone()
        };
        let sc = pool_scenario(base, t, &traits);
        let rows = ranked(ch, &sc, 5.0, book);
        out.push_str(&format!("\nTop weapons - {label}\n"));
        out.push_str(&table(
            &weapon_rows(&rows),
            &["Weapon", "Hands", "Capped DPS", "Per swing", "APS"],
            &[false, false, true, true, true],
        ));
        out.push('\n');
    }
    out.push_str("\nBest weapon by Curbing boss health (the speed/damage crossover)\n");
    out.push_str(&table(
        &cross_rows(&crossover(ch, base, &level, book)),
        &[
            "Boss HP",
            "Cap",
            "Best weapon",
            "Capped DPS",
            "Best landed hit",
        ],
        &[true, true, false, true, true],
    ));
    out.push('\n');
    out
}

/// The `--json` document (`src/cli.js:2250`): the `{ pools, crossover }` object; the caller stringifies it with its own
/// `JSON.stringify(v, null, 2)` encoder, as `imprints` leaves its `--json` document to `main.rs`.
pub fn document(ch: &Value, base: &Value, players: f64, blow_x: f64, book: &Spellbook) -> Value {
    let level = ch.get("level").clone();
    let targets = targets(&level, players, blow_x);
    let pools = pools(ch, base, &targets, book);
    let cross = crossover(ch, base, &level, book);
    let pool_values = Arr(pools
        .iter()
        .map(|x| {
            obj([
                ("label", Str(x.label.clone())),
                ("hp", Num(x.hp)),
                ("cap", Num(x.cap)),
                ("perHit", Num(x.per_hit)),
                ("headroom", x.headroom.map_or(Null, Num)),
                ("speed", Num(x.speed)),
                ("speedMin", Num(x.speed_min)),
                ("speedMax", Num(x.speed_max)),
                ("dmg", Num(x.dmg)),
                ("dmgMin", Num(x.dmg_min)),
                ("dmgMax", Num(x.dmg_max)),
                ("verdict", Str(x.verdict.clone())),
            ])
        })
        .collect());
    let cross_values = Arr(cross
        .iter()
        .map(|x| {
            obj([
                ("hp", Num(x.hp)),
                ("cap", Num(x.cap)),
                ("best", Str(x.best.clone())),
                ("dps", Num(x.dps)),
                ("perHit", Num(x.per_hit)),
            ])
        })
        .collect());
    obj([("pools", pool_values), ("crossover", cross_values)])
}
