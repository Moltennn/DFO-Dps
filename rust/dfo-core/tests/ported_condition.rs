//! Ported from `test/condition.test.js` (Stage 2.5, the weapon-condition damage band).
//!
//! LOCAL INVARIANTS, cited from the vendored cut: the percentage truncation, every band boundary, the blunt/blade
//! split, `sharpEdge`, and the half-to-even rounding inside the band. The differential suite compared the assembled
//! blow to the game; these are the values the JS file asserts by hand.

mod ported_common;

use dfo_core::damage::{condition_multiplier, Wear};
use dfo_core::model_blow::{condition_multiplier as blow_multiplier, weapon_of};
use dfo_core::round::unity_round;
use ported_common::*;

const BLADE: f64 = 121.0; // Katana: Long Blade
const BLUNT: f64 = 126.0; // Warhammer: Blunt Weapon

/// `weaponOf(at(template, pct))`, the card's weapon row.
fn weapon_row(template: f64, pct: f64, material: f64) -> Value {
    weapon_of(&weapon_at(template, pct, material), false)
}

/// The band as the formula applies it (`test/condition.test.js` `band()`): the multiplier, or the integer-rounded blow.
fn band(template: f64, pct: f64, sharp_edge: bool, damage: f64, material: f64) -> f64 {
    let w = weapon_row(template, pct, material);
    let mult = blow_multiplier(&w, sharp_edge);
    if mult == 1.0 {
        damage
    } else {
        unity_round(damage * mult)
    }
}

#[test]
fn the_percentage_is_truncated_not_floated() {
    assert_eq!(f(weapon_row(BLADE, 5.0, 9.0).get("conditionPercent")), 5.0);
    assert_eq!(f(weapon_row(BLADE, 5.9, 9.0).get("conditionPercent")), 5.0);
    assert_eq!(f(weapon_row(BLADE, 6.0, 9.0).get("conditionPercent")), 6.0);
    assert_eq!(
        f(weapon_row(BLADE, 75.9, 9.0).get("conditionPercent")),
        75.0
    );
    assert_eq!(
        f(weapon_row(BLADE, 76.0, 9.0).get("conditionPercent")),
        76.0
    );
    assert_eq!(
        f(weapon_row(BLADE, 91.9, 9.0).get("conditionPercent")),
        91.0
    );
    assert_eq!(
        f(weapon_row(BLADE, 92.0, 9.0).get("conditionPercent")),
        92.0
    );
    // A fractional current still truncates (59.5 / 1000 -> 5).
    let mut fractional = weapon(BLADE, 9.0, 1.0);
    fractional.set("maxCondition", n(1000.0));
    fractional.set("currentCondition", n(59.5));
    assert_eq!(
        f(weapon_of(&fractional, false).get("conditionPercent")),
        5.0
    );
    // No maximum reads as full.
    let no_max = obj([
        ("group", s("Weapons")),
        ("templateIndex", n(BLADE)),
        ("material", n(9.0)),
        ("maxCondition", n(0.0)),
        ("currentCondition", n(0.0)),
    ]);
    assert_eq!(f(weapon_of(&no_max, false).get("conditionPercent")), 100.0);
}

#[test]
fn every_blade_band() {
    for (pct, want) in [
        (0.0, 25.0),
        (5.0, 25.0),
        (5.9, 25.0),
        (6.0, 45.0),
        (15.0, 45.0),
        (16.0, 70.0),
        (40.0, 70.0),
        (41.0, 85.0),
        (60.0, 85.0),
        (61.0, 100.0),
        (75.0, 100.0),
        (76.0, 100.0),
        (92.0, 100.0),
        (100.0, 100.0),
    ] {
        assert_eq!(band(BLADE, pct, false, 100.0, 9.0), want, "blade {pct}%");
    }
}

#[test]
fn every_blunt_band() {
    for (pct, want) in [
        (0.0, 50.0),
        (5.0, 50.0),
        (5.9, 50.0),
        (6.0, 65.0),
        (15.0, 65.0),
        (16.0, 80.0),
        (40.0, 80.0),
        (41.0, 90.0),
        (60.0, 90.0),
        (61.0, 100.0),
        (75.0, 100.0),
        (76.0, 100.0),
        (92.0, 100.0),
        (100.0, 100.0),
    ] {
        assert_eq!(band(BLUNT, pct, false, 100.0, 9.0), want, "blunt {pct}%");
    }
}

#[test]
fn sharp_edge_restores_the_over_75_percent_bands() {
    // The module reads the same weapon row: a blade's wear row is its `conditionPercent`.
    let wear = |template: f64, pct: f64| Wear {
        condition_percent: Some(pct),
        condition_pct: pct / 100.0,
        blunt: template == BLUNT,
    };
    assert_eq!(condition_multiplier(Some(&wear(BLADE, 75.0)), true), 1.0);
    assert_eq!(condition_multiplier(Some(&wear(BLADE, 76.0)), true), 1.1);
    assert_eq!(condition_multiplier(Some(&wear(BLADE, 91.0)), true), 1.1);
    assert_eq!(condition_multiplier(Some(&wear(BLADE, 92.0)), true), 1.3);
    assert_eq!(condition_multiplier(Some(&wear(BLUNT, 76.0)), true), 1.0);
    assert_eq!(condition_multiplier(Some(&wear(BLUNT, 92.0)), true), 1.1);
    // The lower bands are unchanged by the module.
    assert_eq!(band(BLADE, 5.9, true, 100.0, 9.0), 25.0);
    assert_eq!(band(BLUNT, 5.9, true, 100.0, 9.0), 50.0);
}

#[test]
fn the_blow_is_rounded_half_to_even_inside_the_band() {
    // 10 x 0.45 = 4.5 -> 4; 10 x 0.25 = 2.5 -> 2; 10 x 0.65 = 6.5 -> 6.
    assert_eq!(band(BLADE, 10.0, false, 10.0, 9.0), 4.0);
    assert_eq!(band(BLADE, 0.0, false, 10.0, 9.0), 2.0);
    assert_eq!(band(BLUNT, 10.0, false, 10.0, 9.0), 6.0);
    // 7 x 0.85 = 5.95 -> 6.
    assert_eq!(band(BLADE, 50.0, false, 7.0, 9.0), 6.0);
}

#[test]
fn the_material_does_not_change_the_band() {
    for material in [0.0, 1.0, 5.0, 9.0] {
        assert_eq!(band(BLADE, 50.0, false, 100.0, material), 85.0);
        assert_eq!(band(BLADE, 5.9, false, 100.0, material), 25.0);
    }
}

#[test]
fn a_worn_blade_cuts_less_than_a_fresh_one_through_the_card() {
    // The card's own `damage.avg` reads the band: the same character at 100% and at 5.9% differs, and 50% sits between.
    let at = |pct: f64| {
        let ch = Desc::new()
            .level(30.0)
            .stat("strength", 60.0)
            .skills(0.0)
            .skill(29, 100.0)
            .skill(34, 40.0)
            .sim(Some(weapon_at(BLADE, pct, 9.0)));
        f(
            analyze(&ch, &obj([("target", reference_foe(30.0, "tough"))]))
                .damage
                .get("avg"),
        )
    };
    let whole = at(100.0);
    assert!(at(95.0) <= whole + 1e-9);
    assert!(at(50.0) < whole);
    assert!(at(30.0) < at(50.0));
    assert!(at(3.0) < at(30.0));
}

#[test]
fn fists_do_not_take_a_weapon_condition_band() {
    let ch = Desc::new().level(30.0).skills(0.0);
    let worn = obj([
        ("group", s("Weapons")),
        ("templateIndex", n(563.0)),
        ("material", n(0.0)),
        ("maxCondition", n(1000.0)),
        ("currentCondition", n(59.0)),
    ]);
    let mut fresh = worn.clone();
    fresh.set("currentCondition", n(1000.0));
    let mut a = ch.sim(None);
    a.set("wraps", worn);
    let mut b = ch.sim(None);
    b.set("wraps", fresh);
    let args = obj([("target", reference_foe(30.0, "tough"))]);
    let ra = analyze(&a, &args);
    let rb = analyze(&b, &args);
    assert!(near(ra.per_swing, rb.per_swing));
    assert!(matches!(ra.weapon, Value::Null));
}
