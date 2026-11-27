//! Ported from `test/imprints.test.js`: the imprint ranking's named assertions, as local invariants.
//!
//! LOCAL INVARIANTS at the recorded `14512` build the JS file names. `tests/imprints.rs` holds the parity vectors; these
//! keep the eligibility, ranking-shape and gate-cap claims alive.

mod ported_common;

use dfo_core::imprints::{imprint_families, imprints_for, power_dps, rank_all, rank_family};
use ported_common::*;

fn family(key: &str) -> Value {
    imprint_families()
        .iter()
        .find(|f| f.get("key").is_str(key))
        .unwrap_or_else(|| panic!("family {key}"))
        .clone()
}

fn max_character(template: f64) -> Value {
    let book = book();
    let mut profiles = dfo_core::maxprofile::Profiles::new(&book);
    profiles
        .max_character(&n(template), &obj([("gameBuild", s("14512"))]))
        .expect("a legal max profile")
}

#[test]
fn imprint_eligibility_is_the_weapons_group_then_the_powers_own_fit() {
    let ids = |template: f64| -> Vec<String> {
        imprints_for(&n(template))
            .items()
            .iter()
            .map(|r| r.get("id").to_js_string())
            .collect()
    };
    assert!(
        ids(127.0).iter().any(|i| i == "warp-edge"),
        "a mace may carry Many Endings"
    );
    assert!(
        ids(117.0).iter().any(|i| i == "anseis-edge"),
        "a wakizashi may carry Way of the Sword"
    );
    assert!(
        ids(563.0).iter().any(|i| i == "warp-edge"),
        "the wraps are Weapons"
    );
    let kinds = |template: f64| -> Vec<String> {
        imprints_for(&n(template))
            .items()
            .iter()
            .map(|r| r.get("power").get("kind").to_js_string())
            .collect()
    };
    assert!(kinds(129.0).iter().any(|k| k == "chain"));
    assert!(!kinds(129.0).iter().any(|k| k == "quake"));
    assert!(kinds(123.0).iter().any(|k| k == "quake"));
    assert!(!kinds(123.0).iter().any(|k| k == "chain"));
}

#[test]
fn a_power_is_priced_both_unconditionally_and_under_its_trigger() {
    let ch = max_character(123.0);
    let args = obj([("gameBuild", s("14512"))]);
    let flow = obj([("kind", s("flow")), ("pct", n(6.0)), ("max", n(5.0))]);
    // The JS assertion: the power's figure IS the same card re-run with its percentage in `loot`'s step.
    let flow_card = dfo_core::analyze::analyze_with(
        &ch,
        &args,
        &obj([("loot", obj([("pct", n(30.0)), ("flat", n(0.0))]))]),
        &book(),
    );
    let priced = power_dps(&flow, &ch, &args, false, false, &book());
    assert!(
        near(priced, flow_card.totals.carried_dps),
        "{priced} vs {}",
        flow_card.totals.carried_dps
    );
    // A bane's trigger is not live unless asked for.
    let base = dfo_core::analyze::analyze(&ch, &args, &book());
    let bane = obj([("kind", s("bane")), ("pct", n(50.0))]);
    let off = power_dps(&bane, &ch, &args, false, false, &book());
    assert!(
        near(off, base.totals.carried_dps),
        "the untriggered bane is the base rate"
    );
    let on_card = dfo_core::analyze::analyze_with(
        &ch,
        &args,
        &obj([("loot", obj([("pct", n(50.0)), ("flat", n(0.0))]))]),
        &book(),
    );
    let on = power_dps(&bane, &ch, &args, true, false, &book());
    assert!(
        near(on, on_card.totals.carried_dps),
        "bane {on} vs {}",
        on_card.totals.carried_dps
    );
}

#[test]
fn the_long_blade_ranking_keeps_every_weapon_power_read_on_a_long_blade() {
    let stock = book();
    let mut profiles = dfo_core::maxprofile::Profiles::new(&stock);
    let r = rank_family(
        &family("LongBlade"),
        &obj([("gameBuild", s("14512"))]),
        &mut profiles,
    )
    .expect("a ranking");
    let names: Vec<String> = r
        .get("rows")
        .items()
        .iter()
        .map(|x| x.get("power").get("name").to_js_string())
        .collect();
    for want in ["Way of the Sword", "Dragonsbane", "Arcane Surge"] {
        assert!(names.iter().any(|n| n == want), "missing {want}: {names:?}");
    }
    assert_eq!(
        r.get("rows").items().len(),
        dfo_core::imprints::weapon_imprints().len() - 1,
        "every power but the shot-only chain"
    );
    assert!(!names.iter().any(|n| n == "Chain Lightning"));
    let surge = r
        .get("rows")
        .items()
        .iter()
        .find(|x| x.get("power").get("name").is_str("Arcane Surge"))
        .expect("Arcane Surge");
    assert!(
        family("LongBlade")
            .get("templates")
            .items()
            .iter()
            .any(|t| t.strict_eq(surge.get("template"))),
        "the power is read on a family template"
    );
}

#[test]
fn the_boss_ranking_reflects_the_gate_cap_not_the_uncapped_ceiling() {
    let stock = book();
    let mut profiles = dfo_core::maxprofile::Profiles::new(&stock);
    let r = rank_family(
        &family("LongBlade"),
        &obj([("gameBuild", s("14512"))]),
        &mut profiles,
    )
    .expect("a ranking");
    let flow = r
        .get("rows")
        .items()
        .iter()
        .find(|x| x.get("power").get("name").is_str("Way of the Sword"))
        .expect("Way of the Sword");
    let delta = f(flow.get("delta"));
    let uncapped = f(flow.get("uncappedDelta"));
    assert!(delta >= 0.0);
    assert!(
        uncapped > delta * 5.0,
        "capped {delta} vs uncapped {uncapped}"
    );
    assert!(f(flow.get("uncappedDps")) > f(flow.get("baseDps")));
}

#[test]
fn every_family_returns_rows_and_a_base_weapon() {
    let stock = book();
    let mut profiles = dfo_core::maxprofile::Profiles::new(&stock);
    let all = rank_all(&obj([("gameBuild", s("14512"))]), &mut profiles).expect("a ranking");
    for f in all.items() {
        let rows = f.get("rows").items();
        assert!(!rows.is_empty(), "{}", f.get("key").to_js_string());
        assert!(
            f.get("base").get("cappedDps").to_number() > 0.0,
            "{}",
            f.get("key").to_js_string()
        );
        assert!(rows.iter().all(|r| r.get("baseDps").to_number() > 0.0));
    }
}

#[test]
fn every_weapon_imprint_has_a_live_power() {
    for record in dfo_core::imprints::weapon_imprints() {
        assert!(
            record.get("power").truthy(),
            "{} has a power",
            record.get("id").to_js_string()
        );
        assert!(
            !record.get("power").get("kind").to_js_string().is_empty(),
            "{} names a kind",
            record.get("id").to_js_string()
        );
    }
}
