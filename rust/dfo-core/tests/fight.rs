mod common;
use dfo_core::{cws as c, durability as d, fight as f, spells::spells_by_index_map, value::Value};
use std::collections::BTreeMap;
use Value::{Arr, Bool, Null, Num, Obj, Str};

fn check(vector: &mut common::Case, got: &Value, answers: &[String]) {
    vector.expect("=>");
    let token = vector.word();
    let expected = token.strip_prefix('@').map_or(token.as_str(), |i| {
        i.parse::<usize>()
            .ok()
            .and_then(|n| answers.get(n))
            .map(String::as_str)
            .unwrap_or_else(|| vector.fail("undefined answer"))
    });
    let actual = dfo_core::value::write(got);
    if actual != expected {
        let i = actual
            .bytes()
            .zip(expected.bytes())
            .take_while(|(a, b)| a == b)
            .count();
        let start = i.saturating_sub(75);
        vector.fail(&format!(
            "result differs at {i}: expected {}, got {}",
            &expected[start..expected.len().min(i + 75)],
            &actual[start..actual.len().min(i + 75)]
        ));
    }
}

fn num(v: &Value, key: &str) -> f64 {
    v.get(key).to_number()
}

fn active(target: &Value) -> Value {
    match target.get("activeEffects") {
        Arr(list) => Arr(list
            .iter()
            .map(|a| {
                Obj(a
                    .entries()
                    .iter()
                    .filter(|(k, _)| k != "caster")
                    .cloned()
                    .collect())
            })
            .collect()),
        v => v.clone(),
    }
}

fn replay(
    mut vector: common::Case,
    log: &Value,
    answers: &[String],
    run: impl FnOnce(&mut dyn FnMut() -> f64) -> Value,
) {
    let mut i = 0;
    let got = run(&mut || {
        let step = log
            .items()
            .get(i)
            .unwrap_or_else(|| vector.fail("extra roll"));
        assert_eq!(step.at(0).to_number(), i as f64);
        i += 1;
        step.at(1).to_number()
    });
    if i != log.items().len() {
        vector.fail(&format!("used {i} of {} rolls", log.items().len()));
    }
    check(&mut vector, &got, answers);
    vector.done();
}

#[test]
fn differential() {
    let mut counts = BTreeMap::new();
    let mut defs = common::Defs::default();
    let mut answers = Vec::new();
    let mut book = None;
    for mut vector in common::stream("fight") {
        let kind = vector.kind.clone();
        if kind == "def" {
            let id = vector.u64() as usize;
            let value = vector.value(&defs);
            assert!(defs.insert(id, value).is_none());
            vector.done();
            continue;
        }
        if kind == "answer" {
            assert_eq!(vector.u64() as usize, answers.len());
            answers.push(vector.word());
            vector.done();
            continue;
        }
        let mut v = || vector.value(&defs);
        if kind == "book" {
            let records = v();
            assert!(records.items().len() > 5);
            assert!(book
                .replace(spells_by_index_map(records.items().iter().cloned()))
                .is_none());
            vector.done();
            continue;
        }
        let book = book.as_ref().expect("stock and probe spellbook");
        *counts.entry(kind.clone()).or_insert(0) += 1;
        let got = match kind.as_str() {
            "thresholds" => Arr(f::health_thresholds(v().items())
                .into_iter()
                .map(Num)
                .collect()),
            "fight" => f::fight_dps(&v(), &v(), book),
            "relay" => f::fight_relay(&v(), &v(), book),
            "fight_with" => f::fight_with(&v(), &v(), &v(), book),
            "relay_with" => f::fight_relay_with(&v(), &v(), &v(), book),
            "magnitude" => {
                let (effect, level, log) = (v(), v(), v());
                replay(vector, &log, &answers, |mut rolls| {
                    Arr(vec![
                        c::roll_magnitude(&effect, level.to_number(), &mut rolls),
                        Bool(c::is_damage_health(&effect)),
                        Bool(c::is_continuous_damage(&effect)),
                    ])
                });
                continue;
            }
            "save" => {
                let (element, flags, t, pierce, log) = (v(), v(), v(), v(), v());
                replay(vector, &log, &answers, |mut rolls| {
                    Num(c::saving_throw(
                        element.to_number(),
                        flags.to_number(),
                        &t,
                        &mut rolls,
                        pierce.to_number(),
                    ))
                });
                continue;
            }
            "cast" => {
                let (sp, ch, mut target, opts, log) = (v(), v(), v(), v(), v());
                replay(vector, &log, &answers, |mut rolls| {
                    let mut hp = opts.get("hp").clone();
                    let mut landed = Vec::new();
                    let has_hurt = !hp.is_nullish();
                    let mut hurt = |n, meta: Option<&Value>| {
                        landed.push(Arr(vec![Num(n), meta.cloned().unwrap_or(Null)]));
                        hp = Num(dfo_core::round::js_max(0.0, hp.to_number() - n));
                        hp.to_number() > 0.0
                    };
                    let cast = c::Cast {
                        caster: if opts.get("self").truthy() {
                            c::Caster::Target
                        } else {
                            c::Caster::Entity(&ch)
                        },
                        level: num(&opts, "casterLevel"),
                        pierce: num(&opts, "pierce"),
                        potency_pct: num(&opts, "potencyPct"),
                    };
                    let calls = (0..num(&opts, "casts") as usize)
                        .map(|_| {
                            c::resolve_cws_cast(
                                &sp,
                                &mut target,
                                &cast,
                                &mut rolls,
                                if has_hurt { Some(&mut hurt) } else { None },
                            )
                        })
                        .collect();
                    let mut states = Vec::new();
                    for _ in 0..num(&opts, "ticks") as usize {
                        c::tick_active_effects(
                            &mut target,
                            if has_hurt { Some(&mut hurt) } else { None },
                            &mut rolls,
                        );
                        states.push(active(&target));
                    }
                    Arr(vec![
                        Arr(calls),
                        hp,
                        Arr(landed),
                        Arr(states),
                        active(&target),
                    ])
                });
                continue;
            }
            "equip" => {
                let (ch, w, ids) = (v(), v(), v());
                let refs = [w.at(0), w.at(1)];
                let occupant = |i| match ids.at(i) {
                    Num(n) => ch.get("worn").at(*n as usize),
                    v => v,
                };
                let occupants = [occupant(0), occupant(1)];
                Arr(vec![
                    c::equip_table_for_fight(&ch, refs, occupants)
                        .map_or_else(|e| Str(e.into()), Arr),
                    c::equipped_for_fight(&ch, refs, occupants).map_or_else(|e| Str(e.into()), Arr),
                ])
            }
            "power" => {
                let (ch, opts, accessor, caster, school) = (v(), v(), v(), v(), v());
                let accessor = if let Num(n) = accessor { Some(n) } else { None };
                Arr(vec![
                    Num(c::live_max_magicka(&ch, accessor)),
                    c::spell_power_inputs(&ch, &opts, accessor).unwrap_or_else(|e| Str(e.into())),
                    Num(c::school_potency_for(&caster, school.to_number())),
                ])
            }
            "rows" => {
                let (item, t, pos, whole) = (v(), v(), v(), v());
                let rows = c::cws_rows(&item, book)
                    .into_iter()
                    .map(|(param, sp)| {
                        Obj(vec![
                            ("param".into(), Num(param)),
                            ("spell".into(), sp.cloned().unwrap_or(Null)),
                        ])
                    })
                    .collect();
                Arr(vec![
                    Arr(rows),
                    Bool(c::cws_eligible(
                        &t,
                        pos.truthy(),
                        whole.truthy(),
                        &item,
                        book,
                    )),
                ])
            }
            "bills" => {
                let (mut item, mut t, ch, hp, log) = (v(), v(), v(), v(), v());
                replay(vector, &log, &answers, |mut rolls| {
                    let mut hp = hp.to_number();
                    let mut result = Vec::new();
                    let mut owner = d::make_owner(Some(1), None);
                    if c::cws_eligible(&t, true, true, &item, book) {
                        for (_, spell) in c::cws_rows(&item, book) {
                            let landing = if let Some(sp) = spell.filter(|_| hp > 0.0) {
                                c::resolve_cws_cast(
                                    sp,
                                    &mut t,
                                    &c::Cast {
                                        caster: c::Caster::Entity(&ch),
                                        ..Default::default()
                                    },
                                    &mut rolls,
                                    Some(&mut |n, _| {
                                        hp = dfo_core::round::js_max(0.0, hp - n);
                                        hp > 0.0
                                    }),
                                )
                            } else {
                                Null
                            };
                            let bill = d::cws_bill(Some(&dfo_core::target::Target {
                                spare_gear: t.get("spareGear").truthy(),
                                ..Default::default()
                            }));
                            let broke = d::wear_item(&mut owner, 1, &mut item, bill);
                            result.push(Arr(vec![
                                landing,
                                Num(bill),
                                Bool(broke),
                                item.get("currentCondition").clone(),
                                Num(hp),
                                Bool(owner.weapon.is_some()),
                            ]));
                        }
                    }
                    Arr(vec![Arr(result), item])
                });
                continue;
            }
            _ => vector.fail("unknown kind"),
        };
        check(&mut vector, &got, &answers);
        vector.done();
    }
    for kind in [
        "thresholds",
        "fight",
        "relay",
        "cast",
        "magnitude",
        "save",
        "equip",
        "power",
        "rows",
        "bills",
    ] {
        assert!(
            counts.get(kind).copied().unwrap_or_default() >= 2000,
            "missing {kind} cases"
        );
    }
}
