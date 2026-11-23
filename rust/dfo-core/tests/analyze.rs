mod common;
use dfo_core::{
    analyze as a,
    spells::{spells_by_index_map, Spellbook},
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

/// Every family the file carries; a new one must be added here and to a test below, so it cannot pass unread.
const KINDS: &[&str] = &[
    "ref",
    "boss",
    "gate",
    "relay",
    "ranks",
    "probe",
    "refusal",
    "body_level",
    "boss_defaults",
];

/// Stream `analysis` for `families` only. Each test must see the fixture `book` row first and asserts the floors of its
/// own families: one file, several `#[test]`s, which libtest runs in parallel.
fn replay(
    families: &[&str],
    floors: &[(&str, usize)],
    check: impl Fn(&str, &mut common::Case, &common::Defs, &Spellbook) -> Value,
) {
    let defs = Default::default();
    let mut book = None;
    let mut counts = BTreeMap::new();
    for mut c in common::stream("analysis") {
        let kind = c.kind.clone();
        if kind == "book" {
            let records = c.value(&defs);
            assert!(records.items().len() > 3);
            assert!(book
                .replace(spells_by_index_map(records.items().iter().cloned()))
                .is_none());
            c.done();
            continue;
        }
        assert!(
            KINDS.contains(&kind.as_str()),
            "unexpected case family {kind}"
        );
        if !families.contains(&kind.as_str()) {
            continue;
        }
        let book = book
            .as_ref()
            .expect("stock and explicit probe spellbook before analysis cases");
        let got = check(&kind, &mut c, &defs, book);
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
    for (family, floor) in floors {
        assert!(
            counts.get(*family).copied().unwrap_or(0) >= *floor,
            "missing vectors: {family}"
        );
    }
}

#[test]
fn targets() {
    replay(
        &["ref", "boss", "gate", "relay"],
        &[
            ("ref", 2000),
            ("boss", 2000),
            ("gate", 2000),
            ("relay", 2000),
        ],
        |kind, c, defs, book| {
            let mut v = || c.value(defs);
            let (level, opts, ch, mut extra, actual_target, overlays) =
                (v(), v(), v(), v(), v(), v());
            let target = match kind {
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
        },
    );
}

#[test]
fn bosses_and_refusals() {
    replay(
        &["body_level", "boss_defaults", "refusal"],
        &[("refusal", 4), ("body_level", 1), ("boss_defaults", 4)],
        |kind, c, defs, _| {
            let mut v = || c.value(defs);
            match kind {
                "body_level" => Num(a::GATE_BODY_LEVEL),
                "boss_defaults" => a::boss_target(&v()).unwrap_or_else(|e| c.fail(&e)),
                "refusal" => {
                    let opts = v();
                    let msg =
                        a::boss_target(&opts).expect_err("bossTarget must refuse invalid body");
                    if msg.contains("cannot be set beside it") {
                        Str(msg)
                    } else {
                        Null
                    }
                }
                other => panic!("unexpected case family {other}"),
            }
        },
    );
}

#[test]
fn ranks_and_probes() {
    replay(
        &["ranks", "probe"],
        &[("ranks", 28), ("probe", 200)],
        |kind, c, defs, book| {
            let mut v = || c.value(defs);
            match kind {
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
                other => panic!("unexpected case family {other}"),
            }
        },
    );
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
