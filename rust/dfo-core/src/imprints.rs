//! The weapon imprint planner (`src/imprints.js`).
use crate::analyze::{analyze, analyze_with, Analysis};
use crate::generated::{
    data::WEAPONS,
    planning::{IMPRINT_FAMILIES, WEAPON_IMPRINTS},
};
use crate::maxprofile::{gate, run_args, Profiles};
use crate::spells::Spellbook;
use crate::theory::{obj, s};
use crate::value::{
    obj_table_get, parse,
    Value::{self, Arr, Bool, Null, Num, Obj, Undefined},
};
use std::cmp::Ordering;
use std::sync::OnceLock;

pub fn weapon_imprints() -> &'static [Value] {
    static TABLE: OnceLock<Value> = OnceLock::new();
    TABLE
        .get_or_init(|| parse(WEAPON_IMPRINTS).expect("generated weapon imprints"))
        .items()
}

pub fn imprint_families() -> &'static [Value] {
    static TABLE: OnceLock<Value> = OnceLock::new();
    TABLE
        .get_or_init(|| parse(IMPRINT_FAMILIES).expect("generated imprint families"))
        .items()
}

pub fn imprint_family_by_id(id: &Value) -> Option<&'static Value> {
    let key = id.to_js_string().to_lowercase();
    imprint_families()
        .iter()
        .find(|f| f.get("key").to_js_string().to_lowercase() == key)
}

fn power_fits(template: &Value, power: &Value) -> bool {
    let shot = obj_table_get(WEAPONS, template).is_some_and(|w| w.skill == "Archery");
    match power.get("kind").as_str() {
        Some("chain") => shot,
        Some("quake") => !shot,
        _ => true,
    }
}

pub fn imprints_for(template: &Value) -> Value {
    let t = Num(template.to_number());
    Arr(weapon_imprints()
        .iter()
        .filter(|r| power_fits(&t, r.get("power")))
        .cloned()
        .collect())
}

/// Like `Analysis::with` in JS, the source character and original analysis options
/// travel with the reprice; the serialized Analysis alone cannot perform a replay.
pub fn power_dps(
    power: &Value,
    ch: &Value,
    args: &Value,
    conditional: bool,
    capped: bool,
    book: &Spellbook,
) -> f64 {
    let priced = analyze_with(
        ch,
        args,
        &obj([
            ("imprint", power.clone()),
            ("assumeTriggers", Bool(conditional)),
        ]),
        book,
    );
    if capped {
        priced.totals.carried_capped_dps
    } else {
        priced.totals.carried_dps
    }
}

fn metadata(kind: &str) -> (&'static str, &'static str, bool) {
    match kind {
        "bane" => ("same hit", "foe is a dragonling or giant", false),
        "unaware" => ("same hit", "foe has not noticed you", false),
        "sanctified" => ("same hit", "foe is undead", false),
        "moon" => ("same hit", "night, or an animal", false),
        "rage" => ("same hit", "you are below 33% health", true),
        "chain" => ("other target", "a second foe within 6 m", false),
        "quake" => ("other targets", "another foe within 3 m", false),
        "venom" => ("same hit", "foe is below half health (×2)", true),
        "flow" => ("same hit", "five landed blows (steady)", true),
        "echo" => (
            "same claim",
            "10% a blow repeats in the same claim (a relay body: owed into it)",
            true,
        ),
        "conduit" => ("utility", "spell cost / magicka", false),
        "siphon" => ("utility", "a kill", false),
        "surge" => ("utility", "spell damage above 75% MP", false),
        _ => ("same hit", "", true),
    }
}

struct Host<'a> {
    template: &'a Value,
    ch: Value,
    cap_args: Value,
    raw_args: Value,
    base: Analysis,
    raw: Analysis,
}

fn strongest<'a, 'b>(hosts: impl Iterator<Item = &'a Host<'b>>) -> Option<&'a Host<'b>> {
    hosts.reduce(|a, b| {
        if b.base.totals.carried_capped_dps > a.base.totals.carried_capped_dps {
            b
        } else {
            a
        }
    })
}

fn weapon_name(template: &Value) -> Value {
    obj_table_get(WEAPONS, template).map_or_else(|| s(&template.to_js_string()), |w| s(w.name))
}

pub fn rank_family(
    family: &Value,
    opts: &Value,
    profiles: &mut Profiles<'_>,
) -> Result<Value, String> {
    let gate_opts = obj([("target", gate())]);
    let build_opts = obj([
        ("firmament", opts.get("firmament").clone()),
        ("vampire", opts.get("vampire").clone()),
    ]);
    let mut hosts = Vec::new();
    for t in family.get("templates").items() {
        if obj_table_get(WEAPONS, t).is_none() {
            continue;
        }
        let ch = profiles.max_character(t, &build_opts)?;
        let cap_args = run_args(&ch, &gate_opts);
        let raw_args = run_args(&ch, &Undefined);
        let base = analyze(&ch, &cap_args, profiles.book);
        let raw = analyze(&ch, &raw_args, profiles.book);
        hosts.push(Host {
            template: t,
            ch,
            cap_args,
            raw_args,
            base,
            raw,
        });
    }
    let mut out = Obj(family.entries().to_vec());
    let Some(best) = strongest(hosts.iter()) else {
        out.set("template", Null);
        out.set("base", Null);
        out.set("rows", Arr(vec![]));
        return Ok(out);
    };
    let mut rows = Vec::new();
    for record in weapon_imprints() {
        let power = record.get("power");
        let Some(host) = strongest(hosts.iter().filter(|h| power_fits(h.template, power))) else {
            continue;
        };
        let price = |args, conditional, capped| {
            power_dps(power, &host.ch, args, conditional, capped, profiles.book)
        };
        let kind = power.get("kind").as_str().unwrap_or("");
        let (hit, trigger, can_trigger) = metadata(kind);
        let base = price(&host.cap_args, false, true);
        let raw = price(&host.raw_args, false, false);
        let conditional = if can_trigger {
            price(&host.cap_args, true, true)
        } else {
            base
        };
        rows.push(obj([
            ("id", record.get("id").clone()),
            ("name", record.get("name").clone()),
            ("power", power.clone()),
            ("template", host.template.clone()),
            ("weapon", weapon_name(host.template)),
            ("baseDps", Num(base)),
            ("conditionalDps", Num(conditional)),
            ("uncappedDps", Num(raw)),
            ("delta", Num(base - host.base.totals.carried_capped_dps)),
            (
                "triggerDelta",
                Num(conditional - host.base.totals.carried_capped_dps),
            ),
            ("uncappedDelta", Num(raw - host.raw.totals.carried_dps)),
            ("hit", s(hit)),
            (
                "trigger",
                s(&format!(
                    "{trigger}{}",
                    if can_trigger {
                        ""
                    } else {
                        " (not at the gate)"
                    }
                )),
            ),
            ("unconditional", Bool(matches!(kind, "flow" | "echo"))),
        ]));
    }
    let keys: &[&str] = match opts.get("sort").as_str() {
        Some("uncapped") => &["uncappedDelta", "delta"],
        Some("conditional") => &["triggerDelta", "delta", "uncappedDelta"],
        _ => &["delta", "uncappedDelta"],
    };
    // Each JS `||` discards zero and NaN; stable sort retains source order on ties.
    rows.sort_by(|a, b| {
        keys.iter()
            .find_map(|k| {
                let d = b.get(k).to_number() - a.get(k).to_number();
                d.partial_cmp(&0.0).filter(|o| *o != Ordering::Equal)
            })
            .unwrap_or(Ordering::Equal)
    });
    out.set("template", best.template.clone());
    out.set("weapon", weapon_name(best.template));
    out.set("base", best.base.to_value());
    out.set("uncapped", best.raw.to_value());
    out.set("rows", Arr(rows));
    Ok(out)
}

pub fn rank_all(opts: &Value, profiles: &mut Profiles<'_>) -> Result<Value, String> {
    imprint_families()
        .iter()
        .map(|f| rank_family(f, opts, profiles))
        .collect::<Result<Vec<_>, _>>()
        .map(Arr)
}
