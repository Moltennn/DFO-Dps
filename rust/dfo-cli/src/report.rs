//! The single-file report page of `src/report.js` (R8): `buildReport`, pure data in, one HTML string out.
//!
//! Everything is precomputed by the shared analysis (`dfo_core::analyze`, the `src/model.js` port) and the page needs no
//! server and no network. This module owns only the markup: the JS `esc`, the number formats, the cards and tables, and
//! the page shell copied line for line from the JS template literal. No file I/O and no CLI wiring here (the `report`
//! command owns both); the HTML escaping is the shared renderer's one-pass `esc` (`crate::graph::escape`).
//!
//! [`build_report`] takes the character, the JS `buildReport` options record (a missing key takes the JS destructuring
//! default) and the spellbook the analysis reads, and returns the string the JS returns. A caller that writes it to a
//! file or a socket does the I/O.
//!
//! Every caption `buildReport` escapes is escaped here too, so a hostile character, target or trait name is text, never
//! markup, exactly where the JS escapes it.

use dfo_core::analyze::{
    analyze, boss_target, current_weapon_row, gate_target, marginals, rank_affixes, rank_weapons,
    reference_foe,
};
use dfo_core::enchant_plan::grouped_number_of;
use dfo_core::generated::data::{
    BOSS_TRAITS, BOSS_TRAIT_TEXT, GATE_HIT_CAP_X, GATE_TTK_S, MARTIAL_PATHS, SOURCE,
};
use dfo_core::round::{js_max, math_round};
use dfo_core::save::{character_label, live_stat};
use dfo_core::spells::Spellbook;
use dfo_core::value::number_to_string;
use dfo_core::value::Value::{self, Arr, Bool, Null, Num, Obj, Str, Undefined};

use crate::graph::escape;

/// `n1`: `(Math.round(n * 10) / 10).toFixed(1)`; `-` for a non-finite input.
fn n1(n: f64) -> String {
    if !n.is_finite() {
        return "-".to_owned();
    }
    let r = math_round(n * 10.0) / 10.0;
    if r.abs() >= 1e21 {
        number_to_string(r)
    } else if r == 0.0 {
        "0.0".to_owned()
    } else {
        format!("{r:.1}")
    }
}

/// `n2`: `(Math.round(n * 100) / 100).toFixed(2)`; `-` for a non-finite input.
fn n2(n: f64) -> String {
    if !n.is_finite() {
        return "-".to_owned();
    }
    let r = math_round(n * 100.0) / 100.0;
    if r.abs() >= 1e21 {
        number_to_string(r)
    } else if r == 0.0 {
        "0.00".to_owned()
    } else {
        format!("{r:.2}")
    }
}

/// `` `${Math.round(n * 100)}%` ``; `-` for a non-finite input.
fn pct(n: f64) -> String {
    if n.is_finite() {
        format!("{}%", number_to_string(math_round(n * 100.0)))
    } else {
        "-".to_owned()
    }
}

/// `` `${n >= 0 ? '+' : ''}${n1(n)}` ``.
fn signed(n: f64) -> String {
    format!("{}{}", if n >= 0.0 { "+" } else { "" }, n1(n))
}

/// `card`: one summary tile.
fn card(label: &str, value: &str, sub: Option<&str>, tone: &str) -> String {
    format!(
        "<div class=\"card {tone}\"><div class=\"k\">{}</div><div class=\"v\">{}</div>{}</div>",
        escape(label),
        escape(value),
        sub.map_or_else(String::new, |s| format!(
            "<div class=\"s\">{}</div>",
            escape(s)
        ))
    )
}

fn grouped(n: f64) -> String {
    grouped_number_of(n)
}

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

fn str_array(values: &[Value]) -> Value {
    Arr(values.to_vec())
}

/// `bossTraitText[t] ?? ''` for the generated table's fields.
fn boss_trait_text(t: &str) -> &'static str {
    let p = &BOSS_TRAIT_TEXT;
    match t {
        "warded" => p.warded,
        "flameproof" => p.flameproof,
        "frostproof" => p.frostproof,
        "venomproof" => p.venomproof,
        "stormproof" => p.stormproof,
        "spellproof" => p.spellproof,
        "bladeturning" => p.bladeturning,
        "stoneskin" => p.stoneskin,
        "curbing" => p.curbing,
        "wrathful" => p.wrathful,
        "thorned" => p.thorned,
        _ => "",
    }
}

/// `MARTIAL_PATHS[id]?.name ?? id` (the path name, or the id itself for an unknown one).
fn martial_path_name(id: &Value) -> String {
    let p = &MARTIAL_PATHS;
    let name = match id.as_str() {
        Some("blademaster") => p.blademaster.name,
        Some("warblade") => p.warblade.name,
        Some("vanguard") => p.vanguard.name,
        Some("ranger") => p.ranger.name,
        Some("bladedancer") => p.bladedancer.name,
        Some("bloodletter") => p.bloodletter.name,
        Some("cutthroat") => p.cutthroat.name,
        Some("assassin") => p.assassin.name,
        Some("shadowdancer") => p.shadowdancer.name,
        Some("juggernaut") => p.juggernaut.name,
        Some("woodsman") => p.woodsman.name,
        Some("berserker") => p.berserker.name,
        Some("crusader") => p.crusader.name,
        Some("brawler") => p.brawler.name,
        Some("windrunner") => p.windrunner.name,
        _ => return id.to_js_string(),
    };
    name.to_owned()
}

/// `MARTIAL_PATHS[id]?.passive ?? ''`.
fn martial_path_passive(id: &Value) -> &'static str {
    let p = &MARTIAL_PATHS;
    match id.as_str() {
        Some("blademaster") => p.blademaster.passive,
        Some("warblade") => p.warblade.passive,
        Some("vanguard") => p.vanguard.passive,
        Some("ranger") => p.ranger.passive,
        Some("bladedancer") => p.bladedancer.passive,
        Some("bloodletter") => p.bloodletter.passive,
        Some("cutthroat") => p.cutthroat.passive,
        Some("assassin") => p.assassin.passive,
        Some("shadowdancer") => p.shadowdancer.passive,
        Some("juggernaut") => p.juggernaut.passive,
        Some("woodsman") => p.woodsman.passive,
        Some("berserker") => p.berserker.passive,
        Some("crusader") => p.crusader.passive,
        Some("brawler") => p.brawler.passive,
        Some("windrunner") => p.windrunner.passive,
        _ => "",
    }
}

/// `gateHealth(level)` (`src/data.js:251`): `GATE_TTK_S * gateRefDps(level)`.
pub fn gate_health(level: f64) -> f64 {
    GATE_TTK_S * dfo_core::allowance::ref_of(level)
}

/// `gateHitCap(level)` (`src/data.js:252`): `GATE_HIT_CAP_X * gateRefDps(level)`.
pub fn gate_hit_cap(level: f64) -> f64 {
    GATE_HIT_CAP_X * dfo_core::allowance::ref_of(level)
}

fn opt(opts: &Value, key: &str, default: Value) -> Value {
    match opts.get(key) {
        Undefined => default,
        v => v.clone(),
    }
}

fn armor_first(target: &Value) -> Value {
    let first = target.get("armorValues").at(0);
    if first.is_nullish() {
        Num(0.0)
    } else {
        first.clone()
    }
}

// ---------------------------------------------------------------------------------------------------------------
// the tables (src/report.js:21-140)
// ---------------------------------------------------------------------------------------------------------------

/// `breakdown(r)`.
fn breakdown(r: &Value) -> String {
    let p = r.get("damage").get("parts");
    let w = r.get("weapon");
    let signed_int = |v: &Value| {
        format!(
            "{}{}",
            if v.to_number() >= 0.0 { "+" } else { "" },
            v.to_js_string()
        )
    };
    let mut rows: Vec<(String, String, String)> = vec![
        (
            "Weapon roll".to_owned(),
            format!(
                "{}-{}",
                p.get("roll").at(0).to_js_string(),
                p.get("roll").at(1).to_js_string()
            ),
            "template base, before modifiers".to_owned(),
        ),
        (
            "Material".to_owned(),
            signed_int(p.get("matMod")),
            if w.truthy() {
                w.get("materialName").to_js_string()
            } else {
                String::new()
            },
        ),
        (
            "Strength".to_owned(),
            signed_int(p.get("strMod")),
            if p.get("twoHanded").truthy() {
                "two-handed x2"
            } else {
                "one-handed"
            }
            .to_owned(),
        ),
        (
            "Proficiency".to_owned(),
            signed_int(p.get("prof")),
            "career Expertise".to_owned(),
        ),
        (
            "Race".to_owned(),
            signed_int(p.get("racial")),
            "racial weapon bonus".to_owned(),
        ),
        (
            "Mastery / gear".to_owned(),
            format!("{}%", n1(p.get("mastery").to_number())),
            "online skill past 100 and gear skill".to_owned(),
        ),
    ];
    // `report.js:30`: `...(p.gearAdd ? [...] : [])`, the 14631 flat add, after the mastery/gear row.
    if p.get("gearAdd").truthy() {
        rows.push((
            "Gear add (flat)".to_owned(),
            n1(p.get("gearAdd").get("mean").to_number()),
            format!(
                "integer uniform {}..{} on the roll, enumerated per blow (0.1.14631 only)",
                p.get("gearAdd").get("lo").to_js_string(),
                p.get("gearAdd").get("hi").to_js_string()
            ),
        ));
    }
    rows.extend([
        (
            "Martial passive".to_owned(),
            format!("{}%", n1(p.get("martial").to_number())),
            "path passive".to_owned(),
        ),
        (
            "Slayer affix".to_owned(),
            format!("{}%", n1(p.get("slayer").to_number())),
            String::new(),
        ),
        (
            "Critical Strike".to_owned(),
            format!(
                "{} chance, x{}",
                pct(r.get("hit").get("crit").get("chance").to_number()),
                n2(r.get("hit").get("crit").get("damageMult").to_number())
            ),
            if r.get("core").is_str("overhaul") {
                "damage multiplier"
            } else {
                "hit chance only"
            }
            .to_owned(),
        ),
        (
            "Hit chance".to_owned(),
            pct(r.get("hit").get("hit").to_number()),
            format!(
                "base {}, armor {}, other {}",
                r.get("hit").get("terms").get("base").to_js_string(),
                r.get("hit").get("terms").get("armour").to_js_string(),
                r.get("hit").get("terms").get("other").to_js_string()
            ),
        ),
        (
            "Swing time".to_owned(),
            format!("{} s", n2(r.get("cadence").get("seconds").to_number())),
            format!(
                "{} swings/s, tick {}s",
                n2(r.get("cadence").get("aps").to_number()),
                n2(r.get("cadence").get("tick").to_number())
            ),
        ),
        (
            "Damage per hit".to_owned(),
            format!(
                "{}-{} (avg {})",
                r.get("damage").get("min").to_js_string(),
                r.get("damage").get("max").to_js_string(),
                n1(r.get("damage").get("avg").to_number())
            ),
            format!(
                "crit {}-{}",
                r.get("damage").get("critMin").to_js_string(),
                r.get("damage").get("critMax").to_js_string()
            ),
        ),
        (
            "Expected per swing".to_owned(),
            n1(r.get("perSwing").to_number()),
            "hit chance x damage, criticals included".to_owned(),
        ),
    ]);
    rows.into_iter()
        .map(|(k, v, s)| {
            format!(
                "<tr><td class=\"k\">{}</td><td class=\"v\">{}</td><td class=\"d\">{}</td></tr>",
                escape(&k),
                escape(&v),
                escape(&s)
            )
        })
        .collect()
}

/// `marginalTable(rows)`.
fn marginal_table(rows: &Value) -> String {
    let max = rows
        .items()
        .iter()
        .fold(1.0f64, |m, r| js_max(m, r.get("delta").to_number().abs()));
    rows.items()
        .iter()
        .map(|r| {
            let delta = r.get("delta").to_number();
            let w = js_max(1.0, math_round((delta.abs() / max) * 100.0));
            let cls = if delta > 0.0001 {
                "good"
            } else if delta < -0.0001 {
                "bad"
            } else {
                "flat"
            };
            format!(
                "<tr><td class=\"k\">{}</td><td class=\"v\">{}</td><td class=\"d\">{}%</td><td class=\"bar\"><span class=\"{}\" style=\"width:{}%\"></span></td></tr>",
                escape(&r.get("label").to_js_string()),
                signed(delta),
                signed(r.get("pct").to_number()),
                cls,
                number_to_string(w)
            )
        })
        .collect()
}

/// `weaponTable(rows, current)`.
fn weapon_table(rows: &Value, current: &Value) -> String {
    let mut list: Vec<Value> = Vec::new();
    if current.truthy() {
        let mut row = current.clone();
        row.set("current", Bool(true));
        list.push(row);
    }
    for row in rows.items() {
        let mut row = row.clone();
        row.set("current", Bool(false));
        list.push(row);
    }
    let best = list.iter().fold(1.0f64, |m, r| {
        let v = r.get("cappedDps").to_number();
        let v = if v != 0.0 {
            v
        } else {
            r.get("dps").to_number()
        };
        js_max(m, v)
    });
    list.iter()
        .map(|r| {
            let capped = r.get("cappedDps").to_number();
            let capped = if capped != 0.0 {
                capped
            } else {
                r.get("dps").to_number()
            };
            let w = js_max(2.0, math_round((capped / best) * 100.0));
            let is_current = r.get("current").truthy();
            let name = if is_current {
                format!("{} (equipped)", r.get("name").to_js_string())
            } else {
                format!(
                    "{} {}",
                    r.get("materialName").to_js_string(),
                    r.get("name").to_js_string()
                )
            };
            format!(
                "<tr class=\"{}\"><td class=\"k\">{}</td><td>{}</td><td>{}</td><td class=\"v\">{}</td><td class=\"v\">{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td class=\"bar\"><span class=\"good\" style=\"width:{}%\"></span></td></tr>",
                if is_current { "on" } else { "" },
                escape(&name),
                escape(&r.get("skill").to_js_string()),
                if r.get("twoHanded").truthy() { "2H" } else { "1H" },
                n1(r.get("dps").to_number()),
                n1(r.get("cappedDps").to_number()),
                n1(r.get("perSwing").to_number()),
                n2(r.get("aps").to_number()),
                pct(r.get("hit").to_number()),
                pct(r.get("crit").to_number()),
                number_to_string(w)
            )
        })
        .collect()
}

/// `targetTable(ch, scenario, players, blowX)`.
fn target_table(
    ch: &Value,
    scenario: &Value,
    players: f64,
    blow_x: f64,
    book: &Spellbook,
) -> String {
    let level = ch.get("level").clone();
    let mut rows: Vec<(String, Value)> = Vec::new();
    for id in ["soft", "tough", "armoured", "human"] {
        let mut sc = Obj(scenario.entries().to_vec());
        sc.set("target", reference_foe(&level, &Str(id.to_owned())));
        sc.set("health", Num(0.0));
        sc.set("traits", Arr(vec![]));
        rows.push((id.to_owned(), analyze(ch, &sc, book).to_value()));
    }
    let hp = opt(scenario, "health", Num(0.0)).to_number();
    let hp = if hp != 0.0 { hp } else { 5000.0 };
    let mut sc = Obj(scenario.entries().to_vec());
    sc.set("health", Num(hp));
    sc.set(
        "target",
        boss_target(&obj([
            ("level", level.clone()),
            ("armorValue", Num(0.0)),
            ("health", Num(hp)),
            ("traits", scenario.get("traits").clone()),
        ]))
        .expect("a reference boss has no stand-in body"),
    );
    rows.push(("boss".to_owned(), analyze(ch, &sc, book).to_value()));
    let mut sc = Obj(scenario.entries().to_vec());
    sc.set(
        "target",
        gate_target(
            &level,
            &obj([("players", Num(players)), ("blowX", Num(blow_x))]),
        ),
    );
    sc.set(
        "health",
        Num(gate_health(ch.get("level").to_number()) * js_max(1.0, players.floor())),
    );
    sc.set("traits", Null);
    rows.push(("gate".to_owned(), analyze(ch, &sc, book).to_value()));
    let traits = scenario.get("traits").items();
    rows.into_iter()
        .map(|(id, r)| {
            let label = if id == "boss" {
                format!(
                    "Boss{}",
                    if traits.is_empty() {
                        String::new()
                    } else {
                        format!(
                            " ({})",
                            traits
                                .iter()
                                .map(Value::to_js_string)
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                    }
                )
            } else if id == "gate" {
                "Gate - Ruhn".to_owned()
            } else {
                let mut chars = id.chars();
                match chars.next() {
                    Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            };
            let target = r.get("target");
            let armor = if target.get("isClass").truthy() {
                "60 (class)".to_owned()
            } else {
                armor_first(target).to_js_string()
            };
            let ttk = r.get("ttk");
            format!(
                "<tr><td class=\"k\">{}</td><td>{}</td><td>{}</td><td class=\"v\">{}</td><td class=\"v\">{}</td><td>{}</td></tr>",
                escape(&label),
                escape(&armor),
                pct(r.get("hit").get("hit").to_number()),
                n1(r.get("dps").to_number()),
                n1(r.get("cappedDps").to_number()),
                if ttk.truthy() {
                    format!("{} s", n1(ttk.to_number()))
                } else {
                    "-".to_owned()
                }
            )
        })
        .collect()
}

/// `traitTable(ch, scenario)`.
fn trait_table(ch: &Value, scenario: &Value, book: &Spellbook) -> String {
    let hp = opt(scenario, "health", Num(0.0)).to_number();
    let hp = if hp != 0.0 { hp } else { 5000.0 };
    let level = ch.get("level").clone();
    ["curbing", "warded", "bladeturning", "stoneskin", "wrathful", "thorned"]
        .iter()
        .map(|t| {
            let traits = Arr(vec![Str((*t).to_owned())]);
            let mut sc = Obj(scenario.entries().to_vec());
            sc.set(
                "target",
                boss_target(&obj([
                    ("level", level.clone()),
                    ("armorValue", Num(0.0)),
                    ("health", Num(hp)),
                    ("traits", traits.clone()),
                ]))
                .expect("a reference boss has no stand-in body"),
            );
            sc.set("health", Num(hp));
            sc.set("traits", traits);
            let r = analyze(ch, &sc, book).to_value();
            let ttk = r.get("ttk");
            format!(
                "<tr><td class=\"k\">{}</td><td class=\"v\">{}</td><td class=\"v\">{}</td><td>{}</td><td>{}</td><td class=\"d\">{}</td></tr>",
                escape(t),
                n1(r.get("dps").to_number()),
                n1(r.get("cappedDps").to_number()),
                pct(r.get("capLoss").to_number()),
                if ttk.truthy() {
                    format!("{} s", n1(ttk.to_number()))
                } else {
                    "-".to_owned()
                },
                escape(boss_trait_text(t))
            )
        })
        .collect()
}

/// `theoryTable(ch, scenario, players, blowX)`.
fn theory_table(
    ch: &Value,
    scenario: &Value,
    players: f64,
    blow_x: f64,
    book: &Spellbook,
) -> String {
    let level = ch.get("level").clone();
    let curbing = || Arr(vec![Str("curbing".to_owned())]);
    let pool = |label: &str, health: f64| {
        (
            label.to_owned(),
            boss_target(&obj([
                ("level", level.clone()),
                ("health", Num(health)),
                ("traits", curbing()),
            ]))
            .expect("a reference boss has no stand-in body"),
            Some(curbing()),
        )
    };
    let pools = vec![
        (
            "Gate - Ruhn".to_owned(),
            gate_target(
                &level,
                &obj([("players", Num(players)), ("blowX", Num(blow_x))]),
            ),
            None,
        ),
        pool("Curbing 1,000", 1000.0),
        pool("Curbing 2,000", 2000.0),
        pool("Curbing 5,000", 5000.0),
        pool("Curbing 10,000", 10000.0),
    ];
    pools
        .into_iter()
        .map(|(label, t, traits)| {
            let mut sc = Obj(scenario.entries().to_vec());
            sc.set("target", t.clone());
            sc.set("health", opt(&t, "maxHealth", Num(0.0)));
            let own = t.get("bossTraits");
            sc.set(
                "traits",
                traits.unwrap_or_else(|| if own.is_nullish() { Arr(vec![]) } else { own.clone() }),
            );
            let a = analyze(ch, &sc, book).to_value();
            let per_hit =
                a.get("perSwing").to_number() / js_max(1e-9, a.get("hit").get("hit").to_number());
            let best = rank_weapons(ch, &sc, &obj([("top", Num(1.0))]), book);
            let best = best.at(0).clone();
            let cap = a.get("cap").to_number();
            let headroom = if cap > 0.0 { Some(cap / per_hit) } else { None };
            let max_health = t.get("maxHealth").to_number();
            let best_ttk = if best.truthy() {
                let shields = if t.get("phaseShields").truthy() {
                    t.get("phaseShields").to_number() * t.get("shieldSeconds").to_number()
                } else {
                    0.0
                };
                (max_health + a.get("ward").to_number()) / best.get("cappedDps").to_number()
                    + shields
            } else {
                a.get("ttk").to_number()
            };
            let best_dps = if best.truthy() {
                best.get("cappedDps").to_number()
            } else {
                a.get("cappedDps").to_number()
            };
            format!(
                "<tr><td class=\"k\">{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td class=\"v\">{}</td><td>{}</td></tr>",
                escape(&label),
                grouped(max_health),
                if cap != 0.0 { number_to_string(cap) } else { "-".to_owned() },
                n1(per_hit),
                match headroom {
                    Some(h) if h != 0.0 => format!("{}x", n2(h)),
                    _ => "-".to_owned(),
                },
                if best.truthy() {
                    escape(&format!(
                        "{} {}",
                        best.get("materialName").to_js_string(),
                        best.get("name").to_js_string()
                    ))
                } else {
                    "-".to_owned()
                },
                n1(best_dps),
                if best_ttk != 0.0 {
                    format!("{} s", n1(best_ttk))
                } else {
                    "-".to_owned()
                }
            )
        })
        .collect()
}

fn set_array(v: &mut Value, i: usize, x: Value) {
    if let Arr(items) = v {
        if items.len() <= i {
            items.resize(i + 1, Undefined);
        }
        items[i] = x;
    }
}

/// `scalingTable(ch, scenario, r)`.
fn scaling_table(ch: &Value, scenario: &Value, r: &Value, book: &Spellbook) -> String {
    let base = {
        let capped = r.get("cappedDps").to_number();
        if capped != 0.0 {
            capped
        } else {
            r.get("dps").to_number()
        }
    };
    let mut rows: Vec<(String, f64, f64, f64)> = Vec::new();
    let mut run = |label: String, current: f64, cap: f64, edit: &dyn Fn(&mut Value, f64)| {
        let mut c = dfo_core::analyze::json_clone(ch);
        edit(&mut c, cap);
        let mut sc = Obj(scenario.entries().to_vec());
        sc.set("weapon", Undefined);
        let rr = analyze(&c, &sc, book).to_value();
        let capped = rr.get("cappedDps").to_number();
        let dps = if capped != 0.0 {
            capped
        } else {
            rr.get("dps").to_number()
        };
        rows.push((label, current, cap, dps));
    };
    for k in ["strength", "agility", "speed", "luck"] {
        let cur = live_stat(ch, k);
        run(format!("stat {k}"), cur, 100.0, &|c, v| {
            let mut stats = c.get("stats").clone();
            stats.set(k, Num(v));
            c.set("stats", stats);
        });
    }
    let weapon_id = r.get("weapon").get("skillId");
    let weapon_id = if weapon_id.is_nullish() {
        Num(30.0)
    } else {
        weapon_id.clone()
    };
    let ws = ch.get("skills").prop(&weapon_id).num_or(0.0);
    run("weapon skill".to_owned(), ws, 200.0, &|c, v| {
        let mut skills = c.get("skills").clone();
        set_array(&mut skills, weapon_id.to_number() as usize, Num(v));
        c.set("skills", skills);
    });
    // `ch.skills?.[34] ?? 0` (`src/report.js:127`): a save with fewer than 35 skill entries has no index 34, and the
    // JS reads 0. `to_number` of a missing entry is NaN, which printed "NaN → 200".
    let crit = ch.get("skills").prop(&Num(34.0)).num_or(0.0);
    run("Critical Strike".to_owned(), crit, 200.0, &|c, v| {
        let mut skills = c.get("skills").clone();
        set_array(&mut skills, 34, Num(v));
        c.set("skills", skills);
    });
    let gear = ch.get("_mods").get("skills").prop(&weapon_id).num_or(0.0);
    let skill = r.get("weapon").get("skill");
    let gear_label = if skill.is_nullish() {
        "weapon".to_owned()
    } else {
        skill.to_js_string()
    };
    run(format!("gear {gear_label}"), gear, gear + 100.0, &|c, v| {
        let mut mods = c.get("_mods").clone();
        if !matches!(mods, Obj(_)) {
            mods = Obj(vec![]);
        }
        let mut skills = mods.get("skills").clone();
        if !matches!(skills, Obj(_)) {
            skills = Obj(vec![]);
        }
        skills.set(&weapon_id.to_js_string(), Num(v));
        mods.set("skills", skills);
        c.set("_mods", mods);
    });
    rows.into_iter()
        .map(|(label, current, cap, at_cap)| {
            format!(
                "<tr><td class=\"k\">{}</td><td>{} → {}</td><td class=\"v\">{}</td><td class=\"v\">{}</td><td>{}{}</td></tr>",
                escape(&label),
                number_to_string(current),
                number_to_string(cap),
                n1(base),
                n1(at_cap),
                if at_cap - base >= 0.0 { "+" } else { "" },
                n1(at_cap - base)
            )
        })
        .collect()
}

/// `capTable(ch, scenario)`.
fn cap_table(ch: &Value, scenario: &Value, book: &Spellbook) -> String {
    let level = ch.get("level").clone();
    [500.0, 1000.0, 2500.0, 5000.0, 10000.0, 25000.0]
        .iter()
        .map(|hp| {
            let target = boss_target(&obj([
                ("level", level.clone()),
                ("armorValue", Num(0.0)),
                ("health", Num(*hp)),
                ("traits", Arr(vec![Str("curbing".to_owned())])),
            ]))
            .expect("a reference boss has no stand-in body");
            let mut sc = Obj(scenario.entries().to_vec());
            sc.set("target", target);
            sc.set("traits", Arr(vec![Str("curbing".to_owned())]));
            sc.set("health", Num(*hp));
            let r = analyze(ch, &sc, book).to_value();
            let ttk = r.get("ttk");
            format!(
                "<tr><td class=\"k\">{} HP</td><td>{}</td><td class=\"v\">{}</td><td class=\"v\">{}</td><td>{}</td><td>{}</td></tr>",
                grouped(*hp),
                number_to_string(r.get("cap").to_number()),
                n1(r.get("dps").to_number()),
                n1(r.get("cappedDps").to_number()),
                pct(r.get("capLoss").to_number()),
                if ttk.truthy() {
                    format!("{} s", n1(ttk.to_number()))
                } else {
                    "-".to_owned()
                }
            )
        })
        .collect()
}

/// The page template: `src/report.js:176-301`, with each `${...}` replaced by a `\u{1}NAME\u{1}` marker.
const PAGE: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DFO DPS - \u{1}NAME\u{1}</title>
<style>
  :root{
    --bg:#12100e;--panel:#1b1814;--panel2:#221e19;--line:#3a3026;--line2:#4a3b2b;
    --bone:#e9e4d9;--dim:#a8a092;--brass:#c08a3e;--brass2:#e0b76a;--good:#7fae6a;--bad:#c25b4e;--flat:#6d6457;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--bone);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
  main{max-width:1120px;margin:0 auto;padding:28px 20px 60px}
  h1{font:600 26px/1.15 Georgia,serif;letter-spacing:.02em;margin:0 0 4px;color:var(--brass2)}
  h2{font:600 17px/1.2 Georgia,serif;color:var(--brass2);margin:34px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
  .sub{color:var(--dim);margin:0 0 22px}
  .rules{color:var(--dim);font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;min-height:82px}
  .card .k{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
  .card .v{font:600 24px/1.15 var(--mono);color:var(--bone);margin-top:4px}
  .card .s{color:var(--dim);font-size:12px;margin-top:3px}
  .card.good .v{color:var(--good)} .card.bad .v{color:var(--bad)} .card.brass .v{color:var(--brass2)}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
  th{color:var(--dim);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
  td.k{color:var(--bone);white-space:nowrap}
  td.v{font-family:var(--mono);color:var(--brass2);white-space:nowrap}
  td.d{color:var(--dim)}
  tr.on td{background:rgba(192,138,62,.09)}
  td.bar{width:26%;min-width:90px}
  .bar span{display:block;height:8px;border-radius:3px;background:var(--brass)}
  .bar span.good{background:var(--good)} .bar span.bad{background:var(--bad)} .bar span.flat{background:var(--flat)}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media(max-width:780px){.cols{grid-template-columns:1fr}}
  .note{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--brass);border-radius:6px;padding:12px 14px;color:var(--dim);font-size:13px;margin:12px 0}
  .note b{color:var(--bone)}
  .tag{display:inline-block;border:1px solid var(--line2);border-radius:999px;padding:1px 8px;margin:0 4px 4px 0;font-size:12px;color:var(--dim)}
  .tag.on{border-color:var(--brass);color:var(--brass2);background:rgba(192,138,62,.1)}
  code{font-family:var(--mono);color:var(--brass2)}
  footer{margin-top:44px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
  .foot{display:flex;flex-wrap:wrap;gap:8px 18px;justify-content:space-between}
</style></head><body><main>
  <h1>DFO DPS Lab</h1>
  <p class="sub">\u{1}LABEL\u{1} &middot; \u{1}WEAPON\u{1} &middot; \u{1}RULESET\u{1}</p>

  <div class="grid">
    \u{1}CARD1\u{1}
    \u{1}CARD2\u{1}
    \u{1}CARD3\u{1}
    \u{1}CARD4\u{1}
    \u{1}CARD5\u{1}
    \u{1}CARD6\u{1}
    \u{1}CARD7\u{1}
    \u{1}CARD8\u{1}
    \u{1}CARD9\u{1}
    \u{1}CARD10\u{1}
    \u{1}CARD11\u{1}
  </div>

  \u{1}NOTE\u{1}

  \u{1}BACKNOTE\u{1}
  <div class="note"><b>Target:</b> \u{1}TARGET\u{1}, level \u{1}LEVEL\u{1}.
    \u{1}CAPBLOCK\u{1}
    \u{1}WARDBLOCK\u{1}
    \u{1}WRATHBLOCK\u{1}
  </div>

  <h2>Where the damage comes from</h2>
  <table><thead><tr><th>Term</th><th>Value</th><th>What it is</th></tr></thead><tbody>\u{1}BREAKDOWN\u{1}</tbody></table>

  <div class="cols">
    <section>
      <h2>What matters</h2>
      <table><thead><tr><th>Change</th><th>\u{1}HEADER\u{1}</th><th>%</th><th></th></tr></thead><tbody>\u{1}MARGINALS\u{1}</tbody></table>
      <p class="note">Stats are live-capped at 100. Once a stat reads 100, more points are wasted unless a max-stat effect lifts the ceiling. Weapon skill still pays past 100 online: it adds to hit chance and, through mastery, damage or pace.</p>
    </section>
    <section>
      <h2>Affixes and enchants</h2>
  <table><thead><tr><th>Change</th><th>\u{1}HEADER2\u{1}</th><th>%</th><th></th></tr></thead><tbody>\u{1}AFFIXES\u{1}</tbody></table>
  <p class="note">Affixes are the loot-rarity lines. <b>+N% damage</b> is the weapon's own roll multiplier. <b>+N weapon skill</b> is a gear skill line: it adds to hit chance and, online, to the past-100 mastery and gear damage. <b>+N Strength</b> is a stat line and is wasted once the live stat is at 100. Enchantment procs (CastWhenStrikes) are not scored in v1.</p>

  <h2>Boss cap sensitivity</h2>
      <table><thead><tr><th>Boss HP</th><th>Cap</th><th>DPS</th><th>Capped</th><th>Loss</th><th>TTK</th></tr></thead><tbody>\u{1}CAPTABLE\u{1}</tbody></table>
      <p class="note"><b>Curbing</b> binds only when a blow would take more than 5% of the boss's maximum health. At this build's <b>expected landed hit</b> (\u{1}LANDED\u{1}), that starts below about \u{1}THRESHOLD\u{1} HP. Above it, the cap does nothing.</p>
    </section>
  </div>

  <h2>Weapons for this build</h2>
  <table><thead><tr><th>Weapon</th><th>Skill</th><th>Hands</th><th>DPS</th><th>Capped</th><th>Per swing</th><th>APS</th><th>Hit</th><th>Crit</th><th></th></tr></thead><tbody>\u{1}WEAPONS\u{1}</tbody></table>
  <p class="note">The ranking holds the character's skills, effects and gear skill affixes fixed, and gives every candidate a fresh 100% condition item. The equipped row keeps its own affixes. Materials are Iron through Daedric.</p>

  <h2>Real boss pools and the speed/damage crossover</h2>
  <table><thead><tr><th>Pool</th><th>HP</th><th>Cap</th><th>Landed hit</th><th>Headroom</th><th>Best weapon</th><th>Best DPS</th><th>TTK</th></tr></thead><tbody>\u{1}THEORY\u{1}</tbody></table>
  <p class="note">The gate boss's real solo pool at level \u{1}GATELEVEL\u{1} is \u{1}GATEHEALTH\u{1} HP (240 seconds of level reference damage) with a \u{1}GATEHITCAP\u{1} per-blow server cap and two 3s phase shields. Curbing is 5% of max HP. <b>Headroom</b> is cap / expected landed hit: above 1x, damage can grow that many times before speed is strictly better; at or below 1x, speed is already better.</p>

  <h2>Scaling headroom</h2>
  <table><thead><tr><th>Channel</th><th>Current → cap</th><th>DPS now</th><th>DPS at cap</th><th>Δ</th></tr></thead><tbody>\u{1}SCALING\u{1}</tbody></table>
  <p class="note">Stats are live-capped at 100; there is no more DPS from attributes once they read 100. Only a <b>mastered</b> skill may read past 100: Long Blade is mastered here, so its raw climb to 200 pays; Critical Strike is not, so its raw value stops at 100 and the gear/enchant/effect lines are what carry it above. Gear skill is the affix channel and is not capped by the softcap.</p>

  <h2>Targets</h2>

  <table><thead><tr><th>Target</th><th>Armor</th><th>Hit</th><th>DPS</th><th>Capped</th><th>TTK</th></tr></thead><tbody>\u{1}TARGETTABLE\u{1}</tbody></table>

  <h2>Boss traits, one at a time</h2>
  <table><thead><tr><th>Trait</th><th>DPS</th><th>Capped</th><th>Loss</th><th>TTK</th><th>Effect</th></tr></thead><tbody>\u{1}TRAITTABLE\u{1}</tbody></table>
  <p class="note">These rows use the same \u{1}NOTEHP\u{1} HP boss and the equipped weapon, with only the named trait active. Curbing binds when a blow would take more than 5% of that pool; Bladeturning/Stoneskin depend on the weapon class; Warded adds a 30% pool; Wrathful changes the boss's damage, not yours.</p>

  <h2>Boss traits</h2>
  <div>\u{1}TAGS\u{1}</div>
  <table><thead><tr><th>Trait</th><th>Effect</th></tr></thead><tbody>\u{1}SELECTED\u{1}</tbody></table>

  <h2>Ruleset</h2>
  <table><tbody>
    <tr><td class="k">Combat core</td><td class="d">\u{1}CORE\u{1}</td></tr>
    <tr><td class="k">Online rules</td><td class="d">\u{1}ONLINE\u{1}</td></tr>
    <tr><td class="k">Weapon condition</td><td class="d">\u{1}CONDITION\u{1}\u{1}CONDSUFFIX\u{1}</td></tr>
    <tr><td class="k">Martial path</td><td class="d">\u{1}PATH\u{1}</td></tr>
    <tr><td class="k">Mentor</td><td class="d">off (solo build planning)</td></tr>
    <tr><td class="k">Armor</td><td class="d">damage is shown before the foe's worn/natural armor reduction; the game's Combat Stats card does the same</td></tr>
  </tbody></table>

  <footer><div class="foot"><span>dfo-forge - model from \u{1}REPO\u{1} @ \u{1}COMMIT\u{1} (\u{1}DATE\u{1}) · live check \u{1}VERIFIED\u{1}</span><span>not affiliated with Bethesda Softworks or ZeniMax Media</span></div></footer>
</main></body></html>"#;

/// `buildReport(ch, opts)` (`src/report.js:142-303`): the whole single-file page.
pub fn build_report(ch: &Value, opts: &Value, book: &Spellbook) -> String {
    let weapon = opts.get("weapon");
    let base_ch = if weapon.get("item").truthy() {
        let mut c = ch.clone();
        c.set("weapon", weapon.get("item").clone());
        c
    } else {
        ch.clone()
    };
    let target = opts.get("target").clone();
    let trait_list = if opts.get("traits").is_nullish() {
        target.get("bossTraits").items().to_vec()
    } else {
        opts.get("traits").items().to_vec()
    };
    let scenario = obj([
        ("target", target.clone()),
        ("core", opt(opts, "core", Str("overhaul".to_owned()))),
        ("traits", str_array(&trait_list)),
        ("health", opt(opts, "health", Num(0.0))),
        ("swing", opt(opts, "swing", Str("StrikeLeft".to_owned()))),
        ("passiveOn", opt(opts, "passiveOn", Bool(true))),
        ("stacks", opt(opts, "stacks", Num(5.0))),
        ("rhythm", opt(opts, "rhythm", Bool(false))),
        ("unaware", opt(opts, "unaware", Bool(false))),
        ("firstBlow", opt(opts, "firstBlow", Bool(false))),
        ("healthShare", opt(opts, "healthShare", Num(1.0))),
        (
            "attackerHealthShare",
            opt(opts, "attackerHealthShare", Num(1.0)),
        ),
        ("backstabUptime", opt(opts, "backstabUptime", Num(0.0))),
        ("rri", opt(opts, "rri", Bool(true))),
        ("pair", opt(opts, "pair", Bool(false))),
        ("bowSpam", opt(opts, "bowSpam", Bool(false))),
        ("potencyPct", opt(opts, "potencyPct", Num(0.0))),
        ("pierce", opt(opts, "pierce", Num(0.0))),
        // A direct caller that leaves the key out prices the LIVE build, as `src/report.js:146` does (its destructured
        // default is `DEFAULT_GAME_BUILD`).
        (
            "gameBuild",
            opt(
                opts,
                "gameBuild",
                Str(dfo_core::model_blow::DEFAULT_GAME_BUILD.to_owned()),
            ),
        ),
    ]);
    let players = opt(opts, "players", Num(1.0)).to_number();
    let blow_x = opt(opts, "blowX", Num(1.0)).to_number();
    let health = scenario.get("health").to_number();
    let core = scenario.get("core");
    let r = analyze(&base_ch, &scenario, book);
    let card_r = r.to_value();
    let w = card_r.get("weapon");
    let rs = marginals(&base_ch, &r, &scenario, book);
    let affixes = rank_affixes(&base_ch, &r, &scenario, book);
    let weapons = rank_weapons(&base_ch, &scenario, &obj([("top", Num(15.0))]), book);
    let cur = current_weapon_row(&base_ch, &scenario, book);
    let target_label = if target.get("isClass").truthy() {
        "Human foe".to_owned()
    } else {
        format!("Monster, armor {}", armor_first(&target).to_js_string())
    };
    let path = ch.get("martialPath");
    let ruleset = format!(
        "{}{}{}",
        core.to_js_string(),
        if ch.get("online").truthy() {
            " / online"
        } else {
            " / offline"
        },
        if path.truthy() {
            format!(" / {}", martial_path_name(path))
        } else {
            String::new()
        }
    );
    let cap = card_r.get("cap").to_number();
    let cap_line = if cap != 0.0 {
        format!(
            "{}: {} per hit{}",
            if card_r.get("capSource").is_str("hit cap") {
                "Hit cap"
            } else {
                "Curbing cap"
            },
            number_to_string(cap),
            if card_r.get("capSource").is_str("curbing") {
                format!(" (5% of {} HP)", grouped(health))
            } else {
                String::new()
            }
        )
    } else {
        "No per-hit cap active".to_owned()
    };
    let affinity = if target.get("group").truthy() {
        format!(", {}", target.get("group").to_js_string())
    } else {
        String::new()
    };
    let claim_ttk = r.totals.claim_total_ttk;
    let ceiling_ttk = r.totals.ceiling_total_ttk;
    let ttk_gap = match (claim_ttk, ceiling_ttk) {
        (Some(claim), Some(ceiling)) if claim != 0.0 => Some((claim - ceiling).abs() / claim),
        _ => None,
    };
    let ttk_gap_note = if card_r.get("allowance").truthy()
        && ceiling_ttk.is_some_and(|t| t != 0.0)
        && (claim_ttk.is_none() || ttk_gap.is_some_and(|g| g > 0.01))
    {
        let ceiling = ceiling_ttk.unwrap();
        let figures = match claim_ttk {
            None => format!(
                "ceiling {} s; the allowance-sustained run never kills - the ceiling can promise a kill the allowance refuses",
                n1(ceiling)
            ),
            Some(claim) if claim > ceiling => format!(
                "ceiling {} s; allowance-sustained {} s - the ceiling can promise a kill the allowance refuses",
                n1(ceiling),
                n1(claim)
            ),
            Some(claim) => format!(
                "ceiling {} s; allowance-sustained {} s - ceiling and allowance-sustained differ by {}",
                n1(ceiling),
                n1(claim),
                pct(ttk_gap.unwrap_or(0.0))
            ),
        };
        format!("<div class=\"note\"><b>Ceiling vs allowance:</b> {figures}.</div>")
    } else {
        String::new()
    };
    let backstab = card_r.get("backstab");
    let allowance = card_r.get("allowance");
    let total_ttk = r.totals.total_ttk;
    let ttk_capped = match total_ttk {
        Some(t) => format!("{} s", n1(t)),
        None => "-".to_owned(),
    };
    let ttk_allowance = match total_ttk {
        Some(t) => format!("{} s", n1(t)),
        None => {
            if allowance.truthy() {
                "no kill".to_owned()
            } else {
                "no allowance run".to_owned()
            }
        }
    };
    let ttk_note_allowance = if health != 0.0 {
        format!(
            "{} HP{} · ceiling: {}",
            grouped(health),
            if card_r.get("ward").truthy() {
                format!(" + {} ward", card_r.get("ward").to_js_string())
            } else {
                String::new()
            },
            ceiling_ttk.map_or_else(|| "-".to_owned(), |t| format!("{} s", n1(t)))
        )
    } else {
        "no boss health set".to_owned()
    };
    let ttk_note_capped = if health != 0.0 {
        format!(
            "{} HP{}{}",
            grouped(health),
            if card_r.get("ward").truthy() {
                format!(" + {} ward", card_r.get("ward").to_js_string())
            } else {
                String::new()
            },
            if card_r.get("enchantDps").to_number() > 0.0 {
                " · weapon + procs"
            } else {
                ""
            }
        )
    } else {
        "no boss health set".to_owned()
    };

    let card_uncapped = card(
        "Uncapped weapon DPS",
        &n1(card_r.get("dps").to_number()),
        Some(&format!(
            "{} per swing x {}/s",
            n1(card_r.get("perSwing").to_number()),
            n2(card_r.get("cadence").get("aps").to_number())
        )),
        "brass",
    );
    let card_capped = {
        let sub = if cap != 0.0 {
            format!("{cap_line} - a ceiling")
        } else {
            "no cap".to_owned()
        };
        card(
            "Per-hit-capped DPS",
            &n1(card_r.get("cappedDps").to_number()),
            Some(&sub),
            if cap != 0.0 { "bad" } else { "good" },
        )
    };
    let card_allowance = if allowance.truthy() {
        card(
            "Allowance-sustained DPS",
            &n1(allowance.get("sustainedDps").to_number()),
            Some(&format!(
                "relay allowance refill {}/s{}",
                n1(allowance.get("law").get("rate").to_number()),
                if allowance.get("saturated").truthy() {
                    " (the limit)"
                } else {
                    ""
                }
            )),
            "good",
        )
    } else {
        String::new()
    };
    let card_burst = if allowance.truthy() {
        card(
            "Opening burst",
            &n1(allowance.get("burst5Dps").to_number()),
            Some(&format!(
                "first 5 s, {} bucket",
                n1(allowance.get("law").get("depth").to_number())
            )),
            "brass",
        )
    } else {
        String::new()
    };
    let has_enchant = card_r.get("enchantDps").to_number() > 0.0;
    let card_enchant = if has_enchant {
        card(
            "Enchant DPS (ceiling component)",
            &n1(card_r.get("enchantDps").to_number()),
            Some(&format!(
                "{} per landed hit",
                n1(card_r.get("enchantPerSwing").to_number())
            )),
            "brass",
        )
    } else {
        String::new()
    };
    let card_total = if has_enchant {
        card(
            "Total (per-hit-capped ceiling)",
            &n1(card_r.get("ceilingTotalDps").to_number()),
            Some("capped weapon + proc estimate before allowance"),
            "good",
        )
    } else {
        String::new()
    };
    let card_hit = card(
        "Hit chance",
        &pct(card_r.get("hit").get("hit").to_number()),
        Some(&format!(
            "{} critical",
            pct(card_r.get("hit").get("crit").get("chance").to_number())
        )),
        "",
    );
    let card_damage = card(
        "Damage / hit",
        &format!(
            "{}-{}",
            card_r.get("damage").get("min").to_js_string(),
            card_r.get("damage").get("max").to_js_string()
        ),
        Some(&format!(
            "avg {}; crit {}-{}",
            n1(card_r.get("damage").get("avg").to_number()),
            card_r.get("damage").get("critMin").to_js_string(),
            card_r.get("damage").get("critMax").to_js_string()
        )),
        "",
    );
    let card_backstab = if backstab.get("chance").to_number() > 0.0 {
        card(
            "Backstab",
            &format!("{} ×3", pct(backstab.get("chance").to_number())),
            Some(&if backstab.get("uptime").to_number() > 0.0 {
                format!(
                    "uptime {}; raw crit {}-{}",
                    pct(backstab.get("uptime").to_number()),
                    backstab.get("critMin").to_js_string(),
                    backstab.get("critMax").to_js_string()
                )
            } else {
                format!(
                    "available; raw crit {}-{}",
                    backstab.get("critMin").to_js_string(),
                    backstab.get("critMax").to_js_string()
                )
            }),
            "",
        )
    } else {
        String::new()
    };
    let card_swing = card(
        "Swing time",
        &format!("{} s", n2(card_r.get("cadence").get("seconds").to_number())),
        Some(&format!(
            "{} swings/s",
            n2(card_r.get("cadence").get("aps").to_number())
        )),
        "",
    );
    let card_ttk = if target.get("allowance").truthy() {
        card(
            "Time to kill (allowance-sustained)",
            &ttk_allowance,
            Some(&ttk_note_allowance),
            "",
        )
    } else {
        card(
            "Time to kill (per-hit-capped ceiling)",
            &ttk_capped,
            Some(&ttk_note_capped),
            "",
        )
    };
    let back_note = if backstab.get("uptime").to_number() > 0.0 {
        format!(
            "<div class=\"note\"><b>Backstab:</b> {} chance of ×3 from behind; the DPS uses a {} behind uptime (expected ×{}). Raw backstab crit {}-{}; the per-hit cap is applied after this. A displayed 600 is a backstab crit; the health bar may only lose the cap ({}).</div>",
            pct(backstab.get("chance").to_number()),
            pct(backstab.get("uptime").to_number()),
            n2(backstab.get("expectedMult").to_number()),
            backstab.get("critMin").to_js_string(),
            backstab.get("critMax").to_js_string(),
            if cap != 0.0 {
                number_to_string(cap)
            } else {
                "none".to_owned()
            }
        )
    } else {
        String::new()
    };
    let target_caption = format!("{}{}", escape(&target_label), escape(&affinity));
    let level = escape(&target.get("level").to_js_string());
    let cap_block = if cap != 0.0 {
        format!(
            "<br><b>{}</b> Your per-hit range is {}-{} (crit {}-{}); {} of the uncapped DPS is lost to the cap.",
            escape(&cap_line),
            card_r.get("damage").get("min").to_js_string(),
            card_r.get("damage").get("max").to_js_string(),
            card_r.get("damage").get("critMin").to_js_string(),
            card_r.get("damage").get("critMax").to_js_string(),
            pct(card_r.get("capLoss").to_number())
        )
    } else {
        String::new()
    };
    let ward_block = if card_r.get("ward").truthy() {
        format!(
            "<br><b>Warded:</b> {} points absorb the first blows; the time-to-kill includes that pool.",
            card_r.get("ward").to_js_string()
        )
    } else {
        String::new()
    };
    let wrath_block = if card_r.get("wrath").truthy() {
        let wrath_at = card_r.get("wrathAt").to_number();
        let ttk = card_r.get("ttk").to_number();
        format!(
            "<br><b>Wrathful:</b> it enrages at {}s; {}",
            card_r.get("wrathAt").to_js_string(),
            if ttk != 0.0 && ttk > wrath_at {
                "your kill is slower than that."
            } else {
                "your kill is before that."
            }
        )
    } else {
        String::new()
    };
    let header = if cap != 0.0 { "Capped DPS" } else { "DPS" };
    let landed =
        card_r.get("perSwing").to_number() / js_max(1e-9, card_r.get("hit").get("hit").to_number());
    let gate_level = ch.get("level").to_number();
    let tags: String = BOSS_TRAITS
        .iter()
        .map(|t| {
            format!(
                "<span class=\"tag {}\">{}</span> ",
                if trait_list.iter().any(|v| v.is_str(t)) {
                    "on"
                } else {
                    ""
                },
                escape(t)
            )
        })
        .collect();
    let selected: String = trait_list
        .iter()
        .map(|t| {
            let name = t.to_js_string();
            format!(
                "<tr><td class=\"k\">{}</td><td class=\"d\">{}</td></tr>",
                escape(&name),
                escape(boss_trait_text(&name))
            )
        })
        .collect();
    let note_hp = opt(&scenario, "health", Num(0.0)).to_number();
    let note_hp = if note_hp != 0.0 { note_hp } else { 5000.0 };
    let condition = card_r.get("notes").get("condition").to_number();

    let values = [
        ("NAME", escape(&ch.get("name").to_js_string())),
        ("LABEL", escape(&character_label(ch))),
        (
            "WEAPON",
            escape(&if w.truthy() {
                format!(
                    "{} {}",
                    w.get("materialName").to_js_string(),
                    w.get("name").to_js_string()
                )
            } else {
                "bare hands".to_owned()
            }),
        ),
        ("RULESET", escape(&ruleset)),
        ("CARD1", card_uncapped),
        ("CARD2", card_capped),
        ("CARD3", card_allowance),
        ("CARD4", card_burst),
        ("CARD5", card_enchant),
        ("CARD6", card_total),
        ("CARD7", card_hit),
        ("CARD8", card_damage),
        ("CARD9", card_backstab),
        ("CARD10", card_swing),
        ("CARD11", card_ttk),
        ("NOTE", ttk_gap_note),
        ("BACKNOTE", back_note),
        ("TARGET", target_caption),
        ("LEVEL", level),
        ("CAPBLOCK", cap_block),
        ("WARDBLOCK", ward_block),
        ("WRATHBLOCK", wrath_block),
        ("BREAKDOWN", breakdown(&card_r)),
        ("HEADER", header.to_owned()),
        ("HEADER2", header.to_owned()),
        ("MARGINALS", marginal_table(&rs)),
        ("AFFIXES", marginal_table(&affixes)),
        ("CAPTABLE", cap_table(&base_ch, &scenario, book)),
        ("LANDED", n1(landed)),
        ("THRESHOLD", grouped(math_round(landed / 0.05))),
        ("WEAPONS", weapon_table(&weapons, &cur)),
        (
            "THEORY",
            theory_table(&base_ch, &scenario, players, blow_x, book),
        ),
        ("GATELEVEL", number_to_string(gate_level)),
        ("GATEHEALTH", grouped(gate_health(gate_level))),
        ("GATEHITCAP", number_to_string(gate_hit_cap(gate_level))),
        ("SCALING", scaling_table(&base_ch, &scenario, &card_r, book)),
        (
            "TARGETTABLE",
            target_table(&base_ch, &scenario, players, blow_x, book),
        ),
        ("TRAITTABLE", trait_table(&base_ch, &scenario, book)),
        ("NOTEHP", grouped(note_hp)),
        ("TAGS", tags),
        (
            "SELECTED",
            if selected.is_empty() {
                "<tr><td class=\"d\" colspan=\"2\">No traits selected.</td></tr>".to_owned()
            } else {
                selected
            },
        ),
        (
            "CORE",
            escape(if core.is_str("overhaul") {
                "Physical Combat And Armor Overhaul v1.44 (default)"
            } else {
                "Classic DFO / Daggerfall Unity FormulaHelper"
            }),
        ),
        (
            "ONLINE",
            if ch.get("online").truthy() {
                "on - past-100 weapon mastery, gear skill affixes"
            } else {
                "off - past-100 skills read as 100"
            }
            .to_owned(),
        ),
        ("CONDITION", pct(condition)),
        (
            "CONDSUFFIX",
            if condition < 1.0 {
                " - the overhaul's condition multiplier is applied"
            } else {
                ""
            }
            .to_owned(),
        ),
        (
            "PATH",
            escape(&if path.truthy() {
                format!(
                    "{} - {}",
                    martial_path_name(path),
                    martial_path_passive(path)
                )
            } else {
                "none".to_owned()
            }),
        ),
        ("REPO", escape(SOURCE.repo)),
        (
            "COMMIT",
            escape(SOURCE.commit.get(..7).unwrap_or(SOURCE.commit)),
        ),
        ("DATE", escape(SOURCE.date)),
        ("VERIFIED", escape(SOURCE.verified)),
    ];
    let mut page = String::with_capacity(PAGE.len());
    let mut rest = PAGE;
    while let Some(start) = rest.find("\\u{1}") {
        page.push_str(&rest[..start]);
        let after = &rest[start + 5..];
        let Some(end) = after.find("\\u{1}") else {
            // An unterminated marker is not one; keep the rest verbatim.
            page.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let name = &after[..end];
        match values.iter().find(|(key, _)| *key == name) {
            Some((_, value)) => page.push_str(value),
            None => page.push_str(&rest[start..start + 5 + end + 5]),
        }
        rest = &after[end + 5..];
    }
    page.push_str(rest);
    page
}
