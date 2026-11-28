mod common;
use dfo_core::{
    model_blow::*,
    target::{Career, Item, Live, Target},
    value::Value,
};
use std::collections::BTreeMap;

fn n(v: f64) -> Value {
    Value::Num(v)
}
fn b(v: bool) -> Value {
    Value::Bool(v)
}
fn s(v: &str) -> Value {
    Value::Str(v.into())
}
fn arr(v: Vec<Value>) -> Value {
    Value::Arr(v)
}
fn nums(v: impl IntoIterator<Item = f64>) -> Value {
    arr(v.into_iter().map(n).collect())
}
fn obj(v: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Obj(v.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn tag(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn f(v: &Value) -> f64 {
    v.to_number()
}
fn opt(v: &Value) -> Option<f64> {
    (!v.is_nullish()).then(|| f(v))
}
fn boolean(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        _ => None,
    }
}

fn target(v: &Value) -> Option<Target> {
    if v.is_nullish() {
        return None;
    }
    let stats = |obj: &Value, default| {
        [
            "strength",
            "intelligence",
            "willpower",
            "agility",
            "endurance",
            "personality",
            "speed",
            "luck",
        ]
        .map(|k| obj.get(k).num_or(default))
    };
    let career = v.get("career");
    let c = |k| opt(career.get(k));
    let slots = v.get("equip").get("slots");
    let item = |v: &Value| Item {
        is_armor: v.get("group").is_str("Armor"),
        template_index: opt(v.get("templateIndex")),
        material: opt(v.get("material")),
        artifact: v.get("artifact").truthy(),
        max_condition: opt(v.get("maxCondition")),
        current_condition: opt(v.get("currentCondition")),
    };
    let mut equip_slots: Vec<_> = slots
        .entries()
        .iter()
        .filter(|(_, v)| v.truthy())
        .map(|(k, v)| (k.parse().unwrap(), item(v)))
        .collect();
    equip_slots.extend(
        slots
            .items()
            .iter()
            .enumerate()
            .filter(|(_, v)| v.truthy())
            .map(|(k, v)| (k as f64, item(v))),
    );
    let mods = v.get("_mods");
    Some(Target {
        is_class: boolean(v.get("isClass")),
        is_player: v.get("isPlayer").truthy(),
        career_index: opt(v.get("careerIndex")),
        level: opt(v.get("level")),
        combat_level: opt(v.get("combatLevel")),
        mobile_type: opt(v.get("mobileType")),
        group: v.get("group").as_str().map(str::to_owned),
        affinity: v.get("affinity").as_str().map(str::to_owned),
        relay_body: boolean(v.get("relayBody")),
        warded: v.get("warded").strict_eq(&b(true)),
        spare_gear: v.get("spareGear").truthy(),
        career: Career {
            resistance_flags: c("resistanceFlags"),
            immunity_flags: c("immunityFlags"),
            low_tolerance_flags: c("lowToleranceFlags"),
            critical_weakness_flags: c("criticalWeaknessFlags"),
            ..Default::default()
        },
        live: Live {
            stats: stats(v.get("stats"), f64::NAN),
            stat_mods: stats(mods.get("stats"), 0.0),
            stat_max: stats(mods.get("statMax"), 0.0),
            ..Default::default()
        },
        equip_slots,
        ..Default::default()
    })
}

fn outcomes(v: Vec<BlowOutcome>) -> Value {
    arr(v
        .into_iter()
        .map(|v| {
            obj([
                ("p", n(v.p)),
                ("v", n(v.v)),
                ("x", n(v.x)),
                ("echoMask", n(f64::from(v.echo_mask))),
                ("echoHits", n(f64::from(v.echo_hits))),
                ("echoEligible", b(v.echo_eligible)),
                ("formulaPositive", b(v.formula_positive)),
                ("strikesDamage", n(v.strikes_damage)),
                ("strikesPositive", b(v.strikes_positive)),
            ])
        })
        .collect())
}

#[test]
fn model_matches_js() {
    let (defs, cases) = common::load_with_defs("model_blow");
    let mut seen = BTreeMap::new();
    for mut c in cases {
        let kind = c.kind.clone();
        let a = c.value(&defs);
        let w = c.value(&defs);
        let got = match kind.as_str() {
            "resist" => {
                let kind = c.value(&defs);
                let weapon = c.value(&defs);
                let element = c.value(&defs).to_number() as usize;
                n(resist_blow(
                    a.items(),
                    w.to_number(),
                    tag(&kind),
                    &weapon,
                    Some(element),
                ))
            }
            "weapon" => weapon_of(&a, w.truthy()),
            "cadence" => {
                let opts = c.value(&defs);
                arr(vec![cadence(&a, &w, &opts), ranged_cadence(&a, &w, &opts)])
            }
            _ => {
                let raw_t = c.value(&defs);
                let target = target(&raw_t);
                let t = target.as_ref();
                let opts = c.value(&defs);
                match kind.as_str() {
                    "scalar" => {
                        let name = c.value(&defs);
                        let id = c.value(&defs);
                        let core = c.value(&defs);
                        let sharp = c.value(&defs).truthy();
                        arr(vec![
                            n(combat_stat(&a, tag(&name), &opts)),
                            n(skill(&a, &id, &opts)),
                            racial_modifiers(&a, &w, tag(&core), &opts),
                            n(martial_pace(&a, &opts)),
                            n(mastery_pace(&a, &w)),
                            n(martial_blow_pct(&a, t, &opts)),
                            n(mastery_pct(&a, &w, &opts)),
                            b(is_blade(&w)),
                            b(is_blunt(&w)),
                            if w.truthy() {
                                n(weapon_to_hit(&w))
                            } else {
                                w.clone()
                            },
                            n(weapon_resist_factor(&w, opts.get("traits").items())),
                            n(condition_multiplier(&w, sharp)),
                            arr(swing_directions().map(s).collect()),
                        ])
                    }
                    "hit" | "damage" => {
                        let swing = c.value(&defs);
                        let core = c.value(&defs);
                        if kind == "hit" {
                            hit_model(&a, &w, &raw_t, tag(&swing), tag(&core), &opts)
                        } else {
                            damage_model(
                                &a,
                                &w,
                                t,
                                tag(&swing),
                                tag(&core),
                                &opts,
                                &mut Carry::default(),
                            )
                        }
                    }
                    "live" => {
                        let damages = c.value(&defs);
                        let mut state = create_carry_state();
                        nums(damages.items().iter().enumerate().map(|(i, d)| {
                            let key = if w.truthy() { (i % 2) as u64 } else { 0 };
                            weapon_blow(
                                &a,
                                &w,
                                f(d),
                                t,
                                &opts,
                                &mut Carry {
                                    state: Some(&mut state),
                                    weapon_key: key,
                                    loot_key: key,
                                },
                            )
                        }))
                    }
                    "loot" => {
                        let list = c.value(&defs);
                        let (pct, flat) = loot_power_terms(list.items(), t, &opts);
                        arr(vec![
                            obj([("pct", n(pct)), ("flat", n(flat))]),
                            arr(weapon_powers(&w, &opts)),
                            nums(echo_chances(list.items())),
                        ])
                    }
                    "outcomes" => {
                        let ds = c.value(&defs);
                        let part = f(&c.value(&defs));
                        let ds: Vec<_> = ds.items().iter().map(f).collect();
                        let mut ctx = opts.clone();
                        ctx.set("bow", bow_of(&w, &opts));
                        ctx.set(
                            "relay",
                            b(target.as_ref().is_some_and(|t| t.relay_body == Some(true))),
                        );
                        ctx.set("warded", b(target.as_ref().is_some_and(|t| t.warded)));
                        ctx.set(
                            "strikeKind",
                            s(if w.get("ranged").truthy() {
                                "arrow"
                            } else {
                                "melee"
                            }),
                        );
                        arr(vec![
                            outcomes(resolve_blow(ds[0], part, t, &w, &ctx)),
                            outcomes(after_share(ds[0], 0.25, &w, &ctx)),
                            arr(blow_distribution(&ds, part, t, &w, &opts)
                                .into_iter()
                                .map(|(d, p)| nums([d, p]))
                                .collect()),
                        ])
                    }
                    "misc" => {
                        let args = c.value(&defs);
                        let x = |i| args.at(i);
                        let y = |i| f(x(i));
                        arr(vec![
                            n(expected_capped(y(0), y(1), y(2))),
                            n(finish_blow(y(3), x(4), w.truthy())),
                            n(backstab_damage(y(3), y(5), y(6))),
                            bow_of(&w, &opts),
                            n(bow_blow(y(3), x(7))),
                            n(bow_fast_damage(x(7), y(3))),
                            n(strikes_net(&a, t)),
                            synthetic_weapon(x(8), x(9), x(10).truthy()),
                            b(mobile_affinity_matches(raw_t.get("mobileType"), x(11))),
                        ])
                    }
                    _ => c.fail("unknown family"),
                }
            }
        };
        c.check_out(&kind, &got);
        c.done();
        *seen.entry(kind).or_insert(0) += 1;
    }
    for k in [
        "scalar", "cadence", "hit", "damage", "live", "loot", "outcomes", "misc", "weapon",
        "resist",
    ] {
        let min = common::floor("model_blow", k);
        assert!(
            seen.get(k).copied().unwrap_or(0) >= min,
            "short {k} family (expected >= {min})"
        );
    }
}
