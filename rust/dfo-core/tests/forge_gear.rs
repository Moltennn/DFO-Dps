//! The Forge's gear (`dfo_core::forge::build_item`, `preview_equip_main_hand`) against the real engine
//! (`tools/rust-forge-gear-vectors.mjs`).
//!
//! Families: `gearbuild` (a spec minted, or the validator's refusal), `gearwear` (a main-hand wear's resulting
//! character, displaced pieces and slot, or its typed refusal), and `gearequip` (the whole analysis card before and
//! after a legal wear, so the baseline is pinned and the wear's effect on the numbers is proven).

mod common;

use dfo_core::forge::{
    build_item, can_wear_main_hand, preview_equip_main_hand, GearFault, GearSpec,
};
use dfo_core::value::Value::{self, Arr, Num, Obj, Str};
use std::collections::BTreeMap;

fn s(text: &str) -> Value {
    Str(text.to_owned())
}

/// The fault as the vector writes it: `['illegal', ...sentences]`, or the bare word.
fn fault_value(f: GearFault) -> Value {
    match f {
        GearFault::Illegal(bad) => Value::Arr(
            std::iter::once(s("illegal"))
                .chain(bad.into_iter().map(|x| s(&x)))
                .collect(),
        ),
        GearFault::UnknownRecord(_) => s("unknown-record"),
        GearFault::UnknownTemplate(_) => s("unknown-template"),
        GearFault::Spec(_) => s("bad-spec"),
        GearFault::NotMainHand => s("not-main-hand"),
        GearFault::NoWornList => s("no-worn-list"),
    }
}

fn build_value(spec: &GearSpec) -> Value {
    match build_item(spec) {
        Ok(item) => item,
        Err(f) => fault_value(f),
    }
}

fn wear_value(character: &Value, item: &Value) -> Value {
    match preview_equip_main_hand(character, item) {
        Err(f) => fault_value(f),
        Ok(p) => {
            let mut out = Obj(vec![]);
            out.set("slot", Num(p.slot));
            out.set("displaced", Arr(p.displaced));
            out.set("character", p.character);
            out
        }
    }
}

#[test]
fn forge_gear() {
    let (defs, cases) = common::load_with_defs("forge_gear");
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for mut c in cases {
        let kind = c.kind.clone();
        let defs = &defs;
        let mut v = || c.value(defs);
        let got = match kind.as_str() {
            "gearbuild" => {
                let raw = v();
                let bytes = dfo_core::value::write(&raw);
                let spec = match GearSpec::from_value(&raw) {
                    Ok(spec) => spec,
                    Err(f) => {
                        c.expect("=>");
                        let want = c.word();
                        let text = dfo_core::value::write(&fault_value(f));
                        if want != text {
                            c.fail(&format!("expected {want}; got {text}"));
                        }
                        c.done();
                        *counts.entry(kind.clone()).or_insert(0) += 1;
                        continue;
                    }
                };
                let out = build_value(&spec);
                assert_eq!(
                    bytes,
                    dfo_core::value::write(&raw),
                    "the builder mutated its spec"
                );
                out
            }
            "gearwear" => {
                let ch = v();
                let ch_bytes = dfo_core::value::write(&ch);
                let item = v();
                let item_bytes = dfo_core::value::write(&item);
                let out = wear_value(&ch, &item);
                assert_eq!(
                    ch_bytes,
                    dfo_core::value::write(&ch),
                    "the wear mutated its character"
                );
                assert_eq!(
                    item_bytes,
                    dfo_core::value::write(&item),
                    "the wear mutated its item"
                );
                out
            }
            "gearequip" => {
                let ch = v();
                let ch_bytes = dfo_core::value::write(&ch);
                let item = v();
                let item_bytes = dfo_core::value::write(&item);
                let preview = match preview_equip_main_hand(&ch, &item) {
                    Ok(p) => p,
                    Err(e) => c.fail(&e.message()),
                };
                let book = dfo_core::spells::Spellbook::default();
                let before = dfo_core::analyze::analyze(&ch, &Obj(vec![]), &book).to_value();
                let after =
                    dfo_core::analyze::analyze(&preview.character, &Obj(vec![]), &book).to_value();
                assert_eq!(
                    ch_bytes,
                    dfo_core::value::write(&ch),
                    "gearequip mutated its character"
                );
                assert_eq!(
                    item_bytes,
                    dfo_core::value::write(&item),
                    "gearequip mutated its item"
                );
                Value::Arr(vec![before, after])
            }
            other => c.fail(&format!("unexpected forge_gear kind {other}")),
        };
        c.expect("=>");
        let want = c.word();
        let text = dfo_core::value::write(&got);
        if want != text {
            let i = want
                .bytes()
                .zip(text.bytes())
                .take_while(|(a, b)| a == b)
                .count();
            let excerpt = |x: &str| x[i.saturating_sub(120)..x.len().min(i + 160)].to_owned();
            c.fail(&format!(
                "{kind} byte {i}: expected {}; got {}",
                excerpt(&want),
                excerpt(&text)
            ));
        }
        c.done();
        *counts.entry(kind).or_insert(0) += 1;
    }
    for kind in ["gearbuild", "gearwear", "gearequip"] {
        let floor = common::floor("forge_gear", kind);
        let n = counts.get(kind).copied().unwrap_or(0);
        assert!(n >= floor, "forge_gear/{kind}: {n} cases, floor {floor}");
    }
}

/// The corpus the two tests above replay must keep the shapes that matter: a wear that displaces another piece, a
/// wear that clears both hands, a refused shield and a refused ring. These are LOCAL INVARIANTS of the corpus (a
/// generator that stopped producing them would pass every case above by comparing fewer shapes), not oracle checks.
#[test]
fn the_wear_corpus_keeps_its_displacements_and_refusals() {
    let (defs, cases) = common::load_with_defs("forge_gear");
    let (mut displaced, mut cleared, mut refused, mut equipped) = (0, 0, 0, 0);
    for mut c in cases {
        if c.kind != "gearwear" {
            continue;
        }
        let ch = c.value(&defs);
        let item = c.value(&defs);
        match preview_equip_main_hand(&ch, &item) {
            Err(_) => refused += 1,
            Ok(p) => {
                equipped += 1;
                displaced += usize::from(!p.displaced.is_empty());
                // Both hands cleared: the displaced list holds a right-hand and a left-hand piece.
                let hands: Vec<f64> = p
                    .displaced
                    .iter()
                    .map(|d| {
                        ch.get("worn")
                            .items()
                            .iter()
                            .find(|w| without_slot(w) == without_slot(d))
                            .map_or(f64::NAN, |w| w.get("equipSlot").to_number())
                    })
                    .collect();
                if hands.contains(&19.0) && hands.contains(&21.0) {
                    cleared += 1;
                }
            }
        }
    }
    // A local invariant: these shapes are in the corpus, so the replayed cases cover them.
    assert!(equipped >= 25, "only {equipped} legal wears");
    assert!(displaced >= 15, "only {displaced} wears displace a piece");
    assert!(cleared >= 1, "no wear clears both hands");
    assert!(refused >= 2, "only {refused} refused wears");
}

fn without_slot(v: &Value) -> Value {
    Value::Obj(
        v.entries()
            .iter()
            .filter(|(k, _)| k != "equipSlot")
            .cloned()
            .collect(),
    )
}

/// The main-hand guard a GUI calls before offering the wear: it must agree with the preview's own refusal.
#[test]
fn the_main_hand_guard_matches_the_wear() {
    let (defs, cases) = common::load_with_defs("forge_gear");
    let mut checked = 0;
    for mut c in cases {
        if c.kind != "gearwear" {
            continue;
        }
        let ch = c.value(&defs);
        let item = c.value(&defs);
        let guard = can_wear_main_hand(&item);
        let wear = preview_equip_main_hand(&ch, &item);
        assert_eq!(
            guard,
            wear.is_ok(),
            "the main-hand guard and the wear disagree on an item"
        );
        checked += 1;
    }
    assert!(checked >= 30, "only {checked} gearwear cases");
}
