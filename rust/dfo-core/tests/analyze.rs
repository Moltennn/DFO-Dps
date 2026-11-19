mod common;
use dfo_core::{
    analyze as a,
    spells::spells_by_index_map,
    value::{write, Value},
};
use std::collections::BTreeMap;
use Value::{Arr, Bool, Null, Num, Obj, Str, Undefined};

fn difference(expected: &Value, got: &Value, path: &str) -> Option<String> {
    match (expected, got) {
        (Obj(e), Obj(g)) => {
            for ((ek, ev), (gk, gv)) in e.iter().zip(g) {
                if ek != gk {
                    return Some(format!("{path}: expected key {ek:?}, got {gk:?}"));
                }
                if let Some(d) = difference(ev, gv, &format!("{path}.{ek}")) {
                    return Some(d);
                }
            }
            (e.len() != g.len()).then(|| {
                format!(
                    "{path}: keys expected {:?}, got {:?}",
                    e.iter().map(|x| &x.0).collect::<Vec<_>>(),
                    g.iter().map(|x| &x.0).collect::<Vec<_>>()
                )
            })
        }
        (Arr(e), Arr(g)) => {
            if e.len() != g.len() {
                return Some(format!(
                    "{path}: expected length {}, got {}",
                    e.len(),
                    g.len()
                ));
            }
            e.iter()
                .zip(g)
                .enumerate()
                .find_map(|(i, (e, g))| difference(e, g, &format!("{path}[{i}]")))
        }
        (Num(e), Num(g)) if common::same(*e, *g) => None,
        _ if expected == got => None,
        _ => Some(format!("{path}: expected {expected:?}, got {got:?}")),
    }
}

#[test]
fn differential() {
    let defs = Default::default();
    let mut book = None;
    let mut counts = BTreeMap::new();
    for mut c in common::stream("analysis") {
        let kind = c.kind.clone();
        let mut v = || c.value(&defs);
        if kind == "book" {
            let records = v();
            assert!(records.items().len() > 3);
            assert!(book
                .replace(spells_by_index_map(records.items().iter().cloned()))
                .is_none());
            c.done();
            continue;
        }
        let book = book
            .as_ref()
            .expect("stock and explicit probe spellbook before analysis cases");
        let got = match kind.as_str() {
            "body_level" => Num(a::GATE_BODY_LEVEL),
            "boss_defaults" => a::boss_target(&v()).unwrap_or_else(|e| c.fail(&e)),
            "refusal" => {
                let opts = v();
                let msg = a::boss_target(&opts).expect_err("bossTarget must refuse invalid body");
                if msg.contains("cannot be set beside it") {
                    Str(msg)
                } else {
                    Null
                }
            }
            "ref" | "boss" | "gate" | "relay" => {
                let (level, opts, ch, mut extra, actual_target, overlays) =
                    (v(), v(), v(), v(), v(), v());
                let target = match kind.as_str() {
                    "ref" => a::reference_foe(&level, &opts),
                    "boss" => a::boss_target(&opts).unwrap_or_else(|e| c.fail(&e)),
                    "gate" => a::gate_target(&level, &opts),
                    _ => opts,
                };
                let actual_target = if matches!(actual_target, Null) {
                    let mut t = target.clone();
                    for (k, v) in overlays.entries() {
                        t.set(k, v.clone());
                    }
                    t
                } else {
                    actual_target
                };
                extra.set("target", actual_target);
                Arr(vec![target, a::analyze(&ch, &extra, book).to_value()])
            }
            "ranks" => {
                let (ch, scenario, opts, edit) = (v(), v(), v(), v());
                let base = a::analyze(&ch, &scenario, book);
                Arr(vec![
                    a::marginals(&ch, &base, &scenario, book),
                    a::rank_affixes(&ch, &base, &scenario, book),
                    a::rank_weapons(&ch, &scenario, &opts, book),
                    a::current_weapon_row(&ch, &scenario, book),
                    a::analyze_with(&ch, &scenario, &edit, book).to_value(),
                ])
            }
            "probe" => {
                let (ch, args) = (v(), v());
                a::analyze(&ch, &args, book).to_value()
            }
            _ => c.fail("unexpected case family"),
        };
        c.expect("=>");
        let expected_text = c.word();
        let got_text = write(&got);
        if expected_text != got_text {
            let expected = dfo_core::value::parse(&expected_text).unwrap();
            c.fail(
                &difference(&expected, &got, &kind)
                    .unwrap_or_else(|| "noncanonical fixture".to_owned()),
            );
        }
        c.done();
        *counts.entry(kind).or_insert(0) += 1;
    }
    assert!(book.is_some());
    for (family, floor) in [
        ("ref", 2000),
        ("boss", 2000),
        ("gate", 2000),
        ("relay", 2000),
        ("ranks", 28),
        ("probe", 200),
        ("refusal", 4),
        ("body_level", 1),
        ("boss_defaults", 4),
    ] {
        assert!(
            counts.get(family).copied().unwrap_or(0) >= floor,
            "missing vectors: {family}"
        );
    }
}

#[test]
fn empty_book_is_explicit() {
    let book = spells_by_index_map([]);
    let ch = Obj(vec![("level".into(), Num(1.0))]);
    let card = a::analyze(&ch, &Undefined, &book).to_value();
    assert_eq!(card.get("enchantProcs"), &Arr(vec![]));
    assert_eq!(card.get("allowance"), &Null);
    assert_eq!(card.get("target").get("isClass"), &Bool(false));
}
