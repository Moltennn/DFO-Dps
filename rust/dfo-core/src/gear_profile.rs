//! Legal affix budgets (`src/gearProfile.js`), using the shipped Legendary registry.
pub use crate::generated::gear_profile::*;
use crate::generated::{
    data::SKILLS,
    equip_rules::SLOT_RULES,
    loot_rarity::{AFFIX_COUNTS, AFFIX_IDS},
    planning::*,
};
use crate::theory::{default, nullish, obj, s};
use crate::value::{
    obj_table_get, parse,
    Value::{self, Arr, Bool, Num, Undefined},
};
use std::collections::HashMap;
use std::sync::OnceLock;

fn table(cell: &'static OnceLock<Value>, encoded: &str) -> &'static Value {
    cell.get_or_init(|| parse(encoded).expect("generated planner table"))
}

pub fn all_records() -> &'static [Value] {
    static DATA: OnceLock<Value> = OnceLock::new();
    table(&DATA, LEGENDARIES).items()
}

fn kinds() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    table(&DATA, AFFIX_KINDS)
}

fn ranges() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    table(&DATA, AFFIX_RANGES)
}

fn garment(group: &Value) -> bool {
    group.is_str("MensClothing") || group.is_str("WomensClothing")
}

pub fn legendaries_for(template: &Value, group: &Value) -> Vec<&'static Value> {
    let mut pool: Vec<_> = all_records()
        .iter()
        .filter(|r| {
            (r.get("group").strict_eq(group)
                || (r.get("group").is_str("Clothing") && garment(group)))
                && (!r.get("templates").truthy() || contains(r.get("templates").items(), template))
        })
        .collect();
    if pool.iter().any(|r| r.get("exclusive").truthy()) {
        pool.retain(|r| r.get("exclusive").truthy());
    }
    pool
}

pub fn weapon_skill_of(template: &Value) -> f64 {
    crate::save::weapon_skill(template).unwrap_or(SKILLS.long_blade)
}

pub fn rolled_skills(template: &Value, group: &Value) -> Vec<f64> {
    let kin = match group.as_str() {
        Some("Weapons") => STRIKE_KIN,
        Some("Armor") => BODY_KIN,
        Some("Jewellery") => JEWEL_KIN,
        Some("MensClothing") => {
            if obj_table_get(SLOT_RULES.mens_clothing, template).and_then(|r| r.slot)
                == Some("Feet")
            {
                FEET_KIN
            } else {
                STREET_KIN
            }
        }
        Some("WomensClothing") => {
            if obj_table_get(SLOT_RULES.womens_clothing, template).and_then(|r| r.slot)
                == Some("Feet")
            {
                FEET_KIN
            } else {
                STREET_KIN
            }
        }
        _ => &[],
    };
    let mut out = kin.to_vec();
    if group.is_str("Weapons") {
        if let Some((_, id)) = WEAPON_KIN
            .iter()
            .find(|(t, _)| template.strict_eq(&Num(*t)))
        {
            out.push(*id);
        }
    }
    out.sort_by(f64::total_cmp);
    out.dedup();
    out
}

pub fn can_roll_skill(template: &Value, group: &Value, skill: &Value) -> bool {
    matches!(skill, Num(id) if rolled_skills(template, group).contains(id))
}

fn contains(values: &[Value], key: &Value) -> bool {
    values.iter().any(|v| v.same_value_zero(key))
}
fn is_skill(a: &Value) -> bool {
    a.get("id").is_str("skill")
}

pub fn exalted_kinds(record: &Value, group: &Value) -> Vec<&'static str> {
    let affixes = record.get("affixes").items();
    let pool = AFFIX_IDS
        .iter()
        .copied()
        .filter(|id| contains(kinds().get(id).get("groups").items(), group));
    let fresh: Vec<_> = pool
        .clone()
        .filter(|id| !affixes.iter().any(|a| a.get("id").is_str(id)))
        .collect();
    if !fresh.is_empty() {
        return fresh;
    }
    pool.filter(|id| {
        kinds().get(id).get("params").items().iter().any(|p| {
            !affixes
                .iter()
                .any(|a| a.get("id").is_str(id) && a.get("param").strict_eq(p))
        })
    })
    .collect()
}

pub fn can_exalt_skill(record: &Value, group: &Value) -> bool {
    exalted_kinds(record, group).contains(&"skill")
}

pub fn can_exalt_skill_here(template: &Value, group: &Value) -> bool {
    legendaries_for(template, group)
        .iter()
        .any(|r| can_exalt_skill(r, group))
}

fn line(id: &str, param: Value, value: f64) -> Value {
    if matches!(param, Undefined) {
        obj([("id", s(id)), ("value", Num(value))])
    } else {
        obj([("id", s(id)), ("param", param), ("value", Num(value))])
    }
}

// Vendored band tops and record magnitudes in these three channels are nonnegative integers.
#[derive(Clone)]
struct Point {
    channels: [u32; 3],
    detail: Value,
}

impl Point {
    fn value(&self, key: &str) -> Value {
        let [lb, cs, dmg] = self.channels.map(f64::from);
        obj([
            ("lb", Num(lb)),
            ("cs", Num(cs)),
            ("dmg", Num(dmg)),
            (key, self.detail.clone()),
        ])
    }
}

fn pareto(points: Vec<Point>) -> Vec<Point> {
    let mut indices = HashMap::new();
    let mut unique = Vec::new();
    for p in points {
        // JS Map overwrites the value without changing the first insertion position.
        let n = unique.len();
        let i = *indices.entry(p.channels).or_insert(n);
        if i == n {
            unique.push(p);
        } else {
            unique[i] = p;
        }
    }
    let mut kept: Vec<_> = unique
        .iter()
        .filter(|a| {
            !unique.iter().any(|b| {
                let pairs = b.channels.iter().zip(&a.channels);
                pairs.clone().all(|(b, a)| b >= a) && pairs.clone().any(|(b, a)| b > a)
            })
        })
        .cloned()
        .collect();
    kept.sort_by_key(|a| std::cmp::Reverse(a.channels));
    kept
}

fn options(template: &Value, group: &Value, skill: &Value) -> Vec<Point> {
    let mut out = vec![];
    let mut add = |lb: f64, cs: f64, dmg: f64, mut piece: Value| {
        let channels = [lb as u32, cs as u32, dmg as u32];
        if channels.iter().any(|&n| n != 0) {
            piece.set("group", group.clone());
            piece.set("template", template.clone());
            out.push(Point {
                channels,
                detail: piece,
            });
        }
    };
    let crit = Num(SKILLS.critical_strike);
    let roll_skill = can_roll_skill(template, group, skill);
    let roll_crit = can_roll_skill(template, group, &crit);
    let weapon = group.is_str("Weapons");
    for (rarity, skill_top, damage_top, a, b, c) in [
        (
            "rare",
            SKILL_BAND_TOP.rare,
            AFFIX_DAMAGE_TOP.rare,
            true,
            true,
            true,
        ),
        (
            "magic",
            SKILL_BAND_TOP.magic,
            AFFIX_DAMAGE_TOP.magic,
            true,
            true,
            false,
        ),
        (
            "magic",
            SKILL_BAND_TOP.magic,
            AFFIX_DAMAGE_TOP.magic,
            true,
            false,
            true,
        ),
        (
            "magic",
            SKILL_BAND_TOP.magic,
            AFFIX_DAMAGE_TOP.magic,
            false,
            true,
            true,
        ),
    ] {
        let lb = if a && roll_skill { skill_top } else { 0.0 };
        let cs = if b && roll_crit { skill_top } else { 0.0 };
        let dmg = if c && weapon { damage_top } else { 0.0 };
        let mut lines = vec![];
        if lb != 0.0 {
            lines.push(line("skill", skill.clone(), lb));
        }
        if cs != 0.0 {
            lines.push(line("skill", crit.clone(), cs));
        }
        if dmg != 0.0 {
            lines.push(line("damage", Undefined, dmg));
        }
        add(
            lb,
            cs,
            dmg,
            obj([("rarity", s(rarity)), ("lines", Arr(lines))]),
        );
    }
    for r in legendaries_for(template, group) {
        let fixed: Vec<_> = r
            .get("affixes")
            .items()
            .iter()
            .filter(|a| !a.get("id").is_str("gem"))
            .cloned()
            .collect();
        let dmg = fixed
            .iter()
            .find(|a| a.get("id").is_str("damage"))
            // mutation: equivalent - every shipped record damage line has a positive finite numeric value, so num_or never falls back.
            .map_or(0.0, |a| a.get("value").num_or(0.0));
        let fixed_skill = |id| {
            fixed
                .iter()
                .find(|a| is_skill(a) && a.get("param").strict_eq(id))
                .map_or(0.0, |a| {
                    a.get("value").to_number().min(SKILL_BAND_TOP.legendary)
                })
        };
        let piece = || obj([("rarity", s("legendary")), ("record", r.get("id").clone())]);
        let mut p = piece();
        p.set("lines", Arr(fixed.clone()));
        add(fixed_skill(skill), fixed_skill(&crit), dmg, p);
        if can_exalt_skill(r, group) {
            let top = SKILL_BAND_TOP.legendary;
            for id in [skill, &crit] {
                let mut p = piece();
                p.set("exalted", Bool(true));
                let mut lines = fixed.clone();
                lines.push(line("skill", id.clone(), top));
                p.set("lines", Arr(lines));
                add(
                    if id.strict_eq(skill) { top } else { 0.0 },
                    if id.strict_eq(&crit) { top } else { 0.0 },
                    dmg,
                    p,
                );
            }
        }
    }
    pareto(out)
}

pub fn slot_options(template: &Value, group: &Value, skill: &Value) -> Value {
    Arr(options(template, group, skill)
        .iter()
        .map(|p| p.value("piece"))
        .collect())
}

pub fn slots_for(opts: &Value) -> Value {
    let slot = |kind, template, group| {
        obj([
            ("kind", s(kind)),
            ("template", template),
            ("group", s(group)),
        ])
    };
    let mut out = vec![slot(
        "weapon",
        default(opts.get("weaponTemplate"), Num(123.0)),
        "Weapons",
    )];
    out.extend(
        ARMOUR_SLOTS
            .iter()
            .map(|&t| slot("armour", Num(t), "Armor")),
    );
    out.extend(
        JEWEL_SLOTS
            .iter()
            .map(|&t| slot("jewellery", Num(t), "Jewellery")),
    );
    let shield = opts.get("shield");
    if shield.truthy() {
        out.push(slot("shield", shield.clone(), "Armor"));
    }
    Arr(out)
}

fn totals(opts: &Value, with_damage: bool) -> Vec<Point> {
    let skill = default(
        opts.get("skill"),
        Num(weapon_skill_of(&default(
            opts.get("weaponTemplate"),
            Num(123.0),
        ))),
    );
    let mut pieces = Vec::new();
    let mut frontier = vec![([0_u32; 3], Vec::<usize>::new())];
    for slot in slots_for(opts).items() {
        let mut next = Vec::new();
        let options = options(slot.get("template"), slot.get("group"), &skill);
        for ([lb, cs, dmg], plan) in &frontier {
            for (i, p) in options.iter().enumerate() {
                let [a, b, c] = p.channels;
                let mut plan = plan.clone();
                plan.push(pieces.len() + i);
                next.push(([lb + a, cs + b, (*dmg).max(c)], plan));
            }
        }
        for p in options {
            let mut piece = p.detail;
            for (key, n) in ["lb", "cs", "dmg"].into_iter().zip(p.channels) {
                piece.set(key, Num(f64::from(n)));
            }
            pieces.push(piece);
        }
        frontier = reduce_totals(next, with_damage);
    }
    frontier
        .into_iter()
        .map(|(channels, plan)| Point {
            channels,
            detail: Arr(plan.into_iter().map(|i| pieces[i].clone()).collect()),
        })
        .collect()
}

fn reduce_totals(
    mut points: Vec<([u32; 3], Vec<usize>)>,
    with_damage: bool,
) -> Vec<([u32; 3], Vec<usize>)> {
    // Stable descending sort followed by keeping the last representative of each equal point.
    points.sort_by_key(|p| std::cmp::Reverse(p.0));
    let mut kept: Vec<([u32; 3], Vec<usize>)> = Vec::new();
    let mut iter = points.into_iter().peekable();
    while let Some(p) = iter.next() {
        if iter.peek().is_some_and(|q| q.0 == p.0) {
            continue;
        }
        let [x, y, z] = p.0;
        if !kept.iter().any(|q| {
            let [_, b, c] = q.0;
            b >= y
                && if with_damage {
                    c >= z
                } else {
                    q.0[..2] != [x, y]
                }
        }) {
            kept.push(p);
        }
    }
    kept
}

pub fn legal_totals(opts: &Value) -> Value {
    Arr(totals(opts, true).iter().map(|p| p.value("plan")).collect())
}
pub fn legal_point_totals(opts: &Value) -> Value {
    Arr(totals(opts, false)
        .iter()
        .map(|p| p.value("plan"))
        .collect())
}
pub fn max_point_total(opts: &Value) -> f64 {
    f64::from(
        totals(opts, false)
            .iter()
            .map(|p| p.channels[0] + p.channels[1])
            .max()
            // mutation: equivalent - a weapon always offers Rare damage, and every other build slot is Armor or Jewellery and offers Rare Critical Strike.
            .unwrap_or(0),
    )
}
pub fn max_single_skill(opts: &Value) -> f64 {
    let i = usize::from(opts.get("skill").strict_eq(&Num(SKILLS.critical_strike)));
    f64::from(
        totals(opts, false)
            .iter()
            .map(|p| p.channels[i])
            .max()
            // mutation: equivalent - every build slot offers Rare damage or Rare Critical Strike, so the Pareto set is never empty.
            .unwrap_or(0),
    )
}

fn key(a: &Value) -> String {
    format!(
        "{}:{}",
        a.get("id").to_js_string(),
        nullish(a.get("param"), s("")).to_js_string()
    )
}

pub fn validate_plan(plan: &Value) -> Value {
    let mut bad = Vec::new();
    for piece in plan.items() {
        let t = piece.get("template");
        let g = piece.get("group");
        let rarity = piece.get("rarity");
        let lines = piece.get("lines").items();
        let mut push = |msg: String| bad.push(s(&format!("{}: {msg}", t.to_js_string())));
        let legend = rarity.is_str("legendary");
        let exalted = piece.get("exalted").truthy();
        let mut fixed = &[][..];
        if legend {
            let id = piece.get("record");
            let Some(r) = legendaries_for(t, g)
                .into_iter()
                .find(|r| r.get("id").strict_eq(id))
            else {
                push(format!(
                    "no Legendary record \"{}\" fits this piece",
                    id.to_js_string()
                ));
                continue;
            };
            fixed = r.get("affixes").items();
            if !can_exalt_skill(r, g) && exalted {
                push("this record has no free kind to exalt".into());
            }
        } else {
            let max = match rarity.as_str() {
                Some("magic") => AFFIX_COUNTS.magic[1] as usize,
                Some("rare") => AFFIX_COUNTS.rare[1] as usize,
                _ => {
                    push(format!("unknown rarity \"{}\"", rarity.to_js_string()));
                    0
                }
            };
            if lines.len() > max {
                push(format!("too many lines for a {}", rarity.to_js_string()));
            }
        }
        let mut extras = 0;
        for a in lines {
            let id = a.get("id").to_js_string();
            let param = a.get("param");
            let value = a.get("value");
            if legend {
                if let Some(own) = fixed
                    .iter()
                    .rev()
                    .find(|f| !f.get("id").is_str("gem") && key(f) == key(a))
                {
                    if !own.get("value").strict_eq(value) {
                        push(format!(
                            "{} is fixed at {}, not {}",
                            key(a),
                            own.get("value").to_js_string(),
                            value.to_js_string()
                        ));
                    }
                    continue;
                }
                extras += 1;
                if !exalted {
                    push(format!("{} is not this record's line", key(a)));
                }
                if fixed.iter().any(|f| f.get("id").strict_eq(a.get("id"))) {
                    push(format!("the Exalted line repeats a carried kind ({id})"));
                }
            }
            let kind = kinds().get(&id);
            if matches!(kind, Undefined) {
                push(format!("\"{id}\" is not an affix kind"));
                continue;
            }
            let params = kind.get("params");
            if if params.truthy() {
                !contains(params.items(), param)
            } else {
                !matches!(param, Undefined)
            } {
                push(format!("{} is not a {id} param", param.to_js_string()));
            }
            let band = ranges().get(&id).get(&rarity.to_js_string());
            let top = band.at(1);
            if legend {
                if top.is_nullish() {
                    push(format!("no Legendary band for a {id} line"));
                } else if value.to_number() > top.to_number() {
                    push(format!(
                        "{id} {} is above the Legendary band ({})",
                        value.to_js_string(),
                        top.to_js_string()
                    ));
                }
                let floor = ((band.at(0).to_number() + top.to_number()) / 2.0).ceil();
                if value.to_number() < floor {
                    push(format!("an Exalted {id} line starts at {floor}"));
                }
            } else {
                let rarity = rarity.to_js_string();
                if top.is_nullish() {
                    push(format!("no {rarity} band for a {id} line"));
                    continue;
                }
                if id == "skill" && !can_roll_skill(t, g, param) {
                    let name = param
                        .array_index()
                        .and_then(|i| SKILL_KEYS.get(i))
                        .map_or_else(
                            || format!("skill {}", param.to_js_string()),
                            |s| (*s).to_owned(),
                        );
                    push(format!(
                        "{name} is not a skill a {rarity} {} piece may roll",
                        g.to_js_string()
                    ));
                }
                if value.finite_or(f64::NAN) > top.to_number() {
                    push(format!(
                        "{id} {} is above the {rarity} band ({})",
                        value.to_js_string(),
                        top.to_js_string()
                    ));
                }
            }
        }
        if extras > 1 {
            push("one Exalted line only".into());
        }
        if exalted && legend && extras == 0 {
            push("marked exalted but carries no Exalted line".into());
        }
        let skills: Vec<_> = lines.iter().filter(|a| is_skill(a)).collect();
        if skills.iter().enumerate().any(|(i, a)| {
            skills[..i]
                .iter()
                .any(|b| a.get("param").same_value_zero(b.get("param")))
        }) {
            push("one line per skill param".into());
        }
    }
    Arr(bad)
}

pub fn records_for(template: &Value, group: &Value) -> Value {
    Arr(legendaries_for(template, group)
        .iter()
        .map(|r| {
            obj([
                ("id", r.get("id").clone()),
                (
                    "skills",
                    Arr(r
                        .get("affixes")
                        .items()
                        .iter()
                        .filter(|a| is_skill(a))
                        .map(|a| {
                            obj([
                                ("param", a.get("param").clone()),
                                ("value", a.get("value").clone()),
                            ])
                        })
                        .collect()),
                ),
                ("canExaltSkill", Bool(can_exalt_skill(r, group))),
            ])
        })
        .collect())
}
