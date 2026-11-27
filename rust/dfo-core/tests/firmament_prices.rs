//! P1 regression: a Firmament plan's keystone PRICES ride a hidden symbol in JS and cannot survive a `Value`
//! round-trip, so every plan reader re-derives them from the plan's own tree. This pins the arithmetic without a vector
//! file: the full-sky long-blade group read is 21 (gains past the 30 cap, then `sh.k`/`rt.k`'s -5/-4 price), where a
//! price-free rebuild gives the cap 30; `applyFirmament` writes the same 21 into `firmamentDamagePct`.
//!
//! The numbers are the real JS (`planSummary(planFromTree(longblade, { start: 'sp.start', keys: <full sky> })).rows`) -
//! a local invariant copied from the live engine, not a computed expectation. `tests/firmament.rs` is the differential.

use dfo_core::firmament::{build_by_id, plan_from_tree, plan_summary, plan_totals, tree_blow};
use dfo_core::real_build::apply_firmament;
use dfo_core::value::Value::{self, Arr, Num, Obj, Str};

/// The full sky: every non-start star after `sp.start`.
fn full_sky() -> Vec<&'static str> {
    dfo_core::generated::firmament::FIRM_NODES
        .iter()
        .filter(|n| !dfo_core::generated::firmament::START_KEYS.contains(&n.0))
        .map(|n| n.0)
        .collect()
}

fn plan(start: &str, keys: &[&str]) -> Value {
    let build = build_by_id(&Value::Str("longblade".into())).expect("longblade build");
    let opts = Obj(vec![
        ("start".into(), Str(start.into())),
        (
            "keys".into(),
            Arr(keys.iter().map(|k| Str((*k).into())).collect()),
        ),
    ]);
    plan_from_tree(build, &opts)
}

fn blow(plan: &Value) -> Option<f64> {
    plan_summary(plan)
        .get("rows")
        .items()
        .iter()
        .find(|r| r.get("key").as_str() == Some("blow"))
        .map(|r| r.get("value").to_number())
}

#[test]
fn a_full_sky_plan_pays_its_keystones_after_the_group_cap() {
    let plan = plan("sp.start", &full_sky());
    // The prices the plan paid ride beside the channels (the JS `PRICES` symbol).
    let totals = plan_totals(&plan);
    assert!(
        totals.prices.iter().any(|(_, v)| *v < 0.0),
        "the plan carries a negative price: {totals:?}"
    );
    assert_eq!(blow(&plan), Some(21.0), "cap 30 with the -9 priced");
    assert_eq!(tree_blow(&plan), 21.0);
}

#[test]
fn apply_firmament_writes_the_priced_blow() {
    let ch = Obj(vec![
        ("name".into(), Str("T".into())),
        ("level".into(), Num(45.0)),
        ("raceId".into(), Num(1.0)),
        ("stats".into(), Obj(vec![])),
        ("skills".into(), Obj(vec![])),
        ("career".into(), Obj(vec![])),
        (
            "_mods".into(),
            Obj(vec![
                ("stats".into(), Obj(vec![])),
                ("statMax".into(), Obj(vec![])),
                ("skills".into(), Obj(vec![])),
            ]),
        ),
        (
            "_enchantMods".into(),
            Obj(vec![("skillMods".into(), Obj(vec![]))]),
        ),
    ]);
    let applied = apply_firmament(&ch, &plan("sp.start", &full_sky()));
    assert_eq!(applied.get("firmamentDamagePct"), &Num(21.0));
}

/// A priced small tree (`sh.k` is weaponDmg -5): the gains are only the start's, so the price can drive the read to the
/// floor - the JS gives 0, not the cap (the price is paid, the sky grants little).
#[test]
fn a_small_priced_tree_pays_its_price_to_the_floor() {
    assert_eq!(blow(&plan("sp.start", &["sh.k"])), Some(0.0));
    assert_eq!(blow(&plan("sp.start", &["sh.k", "rt.k"])), Some(0.0));
}
