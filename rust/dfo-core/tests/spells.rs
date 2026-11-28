mod common;
use dfo_core::{
    boss_traits as b, enchants as e, spells as s,
    value::Value::{self, Arr, Bool, Null, Num, Str},
};
use std::collections::BTreeMap;

fn strv(s: &str) -> Value {
    Str(s.into())
}
fn opt(v: Option<f64>) -> Value {
    v.map_or(Null, Num)
}
fn strings<const N: usize>(s: [&str; N]) -> Value {
    Arr(s.map(strv).into())
}
fn obj(v: &[(&str, Value)]) -> Value {
    Value::Obj(v.iter().map(|(k, v)| ((*k).into(), v.clone())).collect())
}
fn bytes(v: &Value) -> Vec<u8> {
    let hex = v.as_str().unwrap();
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}
fn mode(v: &Value) -> s::Mode {
    match v.as_str().unwrap() {
        "avg" => s::Mode::Avg,
        "min" => s::Mode::Min,
        "max" => s::Mode::Max,
        _ => panic!("bad mode"),
    }
}

#[test]
fn differential() {
    let defs = Default::default();
    let mut standard = None;
    let mut counts = BTreeMap::new();
    for mut c in common::stream("spells") {
        let kind = c.kind.clone();
        let mut v = || c.value(&defs);
        let got = match kind.as_str() {
            "target_cost_table" => Arr(s::TARGET_COST_MULT
                .iter()
                .map(|(k, v)| Arr(vec![Num(*k as f64), Num(*v)]))
                .collect()),
            "stock" | "custom_book" | "parse_book" => {
                let input = v();
                let stock = input.as_str().is_some();
                let records = if stock {
                    s::read_spells_std(&bytes(&input))
                } else {
                    input.items().to_vec()
                };
                let book = s::spells_by_index_map(records.clone());
                let result = Arr(vec![
                    Arr(records),
                    Arr(book
                        .entries()
                        .iter()
                        .map(|(id, sp)| Arr(vec![id.clone(), sp.clone()]))
                        .collect()),
                ]);
                if !stock {
                    standard = Some(book);
                }
                result
            }
            "record" => {
                s::read_spell_record(&bytes(&v()), v().to_number() as usize).unwrap_or(Null)
            }
            "effect" => {
                let (e, skill, online, level, mode_v) =
                    (v(), v().to_number(), v().truthy(), v().to_number(), v());
                let (gold, sp) = s::effect_cost(&e, |_| skill, online);
                Arr(vec![
                    Num(s::effect_school(&e)),
                    obj(&[("gold", Num(gold)), ("sp", Num(sp))]),
                    Num(s::magnitude_at(&e, level, mode(&mode_v))),
                    Num(s::spell_rounds(&e, level)),
                ])
            }
            "climb" => s::fighting_climb(&v(), &v()),
            "effect_grid" => {
                let (mut sp, ch, t, masks) = (v(), v(), v(), v());
                let cost = s::spell_cost(&sp, &ch, !ch.get("online").strict_eq(&Bool(false)));
                assert_eq!(masks.items().len(), 16);
                let results = masks
                    .items()
                    .iter()
                    .map(|flags| {
                        sp.set("effectFlags", flags.clone());
                        let damage = s::spell_damage(&sp, &ch, &t, &Value::Undefined, s::Mode::Avg);
                        Arr(vec![
                            damage.get("damage").clone(),
                            damage.get("saving").clone(),
                        ])
                    })
                    .collect();
                Arr(vec![Num(cost), Arr(results)])
            }
            "saving" => {
                let (t, o, check, flags, lands) = (
                    v(),
                    v(),
                    v().to_number() as i32,
                    v().to_number() as i32,
                    v().to_number(),
                );
                let (chance, immune) = s::saving_chance_outcome(&t, &o);
                Arr(vec![
                    obj(&[("chance", Num(chance)), ("immune", Bool(immune))]),
                    Num(s::saving_chance(&t, &o)),
                    Bool(s::spell_has_flags(
                        o.get("element").to_number(),
                        check,
                        flags,
                    )),
                    Num(s::saving_lands(lands)),
                ])
            }
            "card" => {
                let (sp, ch, t, o, m) = (v(), v(), v(), v(), v());
                let online = if matches!(o.get("online"), Value::Undefined) {
                    !ch.get("online").strict_eq(&Bool(false))
                } else {
                    o.get("online").truthy()
                };
                Arr(vec![
                    Num(s::spell_cost(&sp, &ch, online)),
                    s::spell_damage(&sp, &ch, &t, &o, mode(&m)),
                    Num(s::cast_rate(&ch, o.get("castSpeedPct").num_or(0.0))),
                    s::analyze_spell(&sp, &ch, &t, &o),
                    s::spell_rotation(&sp, &ch, &t, &o),
                ])
            }
            "resolve" => Arr(s::resolve_spells(&v(), standard.as_ref().unwrap())
                .into_iter()
                .cloned()
                .collect()),
            "enchant" => {
                let (item, ch, t, o) = (v(), v(), v(), v());
                let book = standard.as_ref().unwrap();
                let bills = e::cws_bill_capacity(&item);
                Arr(vec![
                    Arr(e::enchantment_rows(&item).cloned().collect()),
                    Arr(e::payload_rows(&item).cloned().collect()),
                    e::rebuild_enchant_mods(&Arr(vec![item.clone(), item.clone()])),
                    Arr(e::cast_when_strikes(&item, book)
                        .into_iter()
                        .map(|s| s.get("index").clone())
                        .collect()),
                    e::strike_enchantments(&item, &ch, &t, &o, book),
                    e::enchant_dps(&item, &ch, &t, &o, book),
                    opt(bills),
                    opt(e::procs_before_break(&item)),
                    Str(e::bill_capacity_note(bills.unwrap_or(0.0))),
                ])
            }
            "catalogue" => {
                let (kind, p, tmpl) = (v().to_number(), v(), v());
                Arr(vec![
                    Arr(e::enchantment_param_values(kind).map(Num).collect()),
                    opt(e::default_param(kind)),
                    opt(e::enchantment_cost(
                        kind,
                        (!p.is_nullish()).then(|| p.to_number()),
                    )),
                    Num(e::item_enchantment_points(&tmpl)),
                ])
            }
            "boss" => {
                let (entity, name, mobile, id, damage, o) =
                    (v(), v(), v(), v(), v().to_number(), v());
                let mut seed = v().to_number() as u32;
                let element = o.get("element").to_number();
                let index = usize::try_from(element as i64).ok();
                let (kind, weapon, whole) = (
                    o.get("kind").as_str().unwrap(),
                    o.get("weapon"),
                    o.get("whole").truthy(),
                );
                let traits = b::boss_traits_of(&entity);
                let (landed, thorns) = b::boss_strike(&entity, damage, kind, weapon, index, whole);
                Arr(vec![
                    Num(b::elite_rng_next(&mut seed)),
                    Arr(traits.to_vec()),
                    strings(b::relay_boss_traits(
                        name.as_str().unwrap(),
                        mobile.as_str().unwrap(),
                    )),
                    b::relay_traits_for(&id).map_or(Null, strings),
                    b::element_trait_of(element).map_or(Null, strv),
                    obj(&[("damage", Num(landed)), ("thorns", Num(thorns))]),
                    Num(b::resist_blow(traits, damage, kind, weapon, index)),
                    Num(b::resist_spell(traits, damage, index)),
                ])
            }
            _ => c.fail("unknown vector kind"),
        };
        c.check_out("R5a", &got);
        *counts.entry(c.kind).or_insert(0) += 1;
    }
    for family in [
        "record",
        "climb",
        "effect",
        "effect_grid",
        "saving",
        "card",
        "resolve",
        "enchant",
        "catalogue",
        "boss",
    ] {
        let min = common::floor("spells", family);
        assert!(
            counts.get(family).copied().unwrap_or(0) >= min,
            "{family}: missing vectors (expected >= {min})"
        );
    }
    assert_eq!(counts["stock"], 1);
    assert_eq!(counts["parse_book"], 1);
    assert_eq!(counts["target_cost_table"], 1);
    assert_eq!(counts["custom_book"], 1);
}
