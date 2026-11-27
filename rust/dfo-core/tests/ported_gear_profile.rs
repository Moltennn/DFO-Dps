//! Ported from `test/gearProfile.test.js`: the gear-profile law (`src/gearProfile.js`), as known values.
//!
//! LOCAL INVARIANTS. `tests/gear_profile.rs` holds the parity vectors from the JS; these keep the named assertions
//! (the 535 single-skill max, the 620 point total, the Exalted-floor law, `validatePlan`'s refusals). The upstream-law
//! halves (`AFFIX_RANGES` read from the vendored module, `exaltLegendary` forced over 3,000 draws) cannot be ported and
//! are cited as covered by `tests/gear_profile.rs`'s `constants`/`slot` families.

mod ported_common;

use dfo_core::gear_profile::{
    all_records, can_exalt_skill, can_exalt_skill_here, can_roll_skill, legal_point_totals,
    legal_totals, max_point_total, max_single_skill, records_for, rolled_skills, slot_options,
    slots_for, validate_plan, weapon_skill_of, AFFIX_DAMAGE_TOP, EXALTED_SKILL_FLOOR,
    SKILL_BAND_TOP,
};
use ported_common::*;

const LONG_BLADE: f64 = 29.0;
const CRITICAL_STRIKE: f64 = 34.0;
const HAND_TO_HAND: f64 = 30.0;

#[test]
fn the_bands_and_the_exalted_floor_are_the_games_numbers() {
    assert_eq!(SKILL_BAND_TOP.magic, 10.0);
    assert_eq!(SKILL_BAND_TOP.rare, 20.0);
    assert_eq!(SKILL_BAND_TOP.legendary, 30.0);
    assert_eq!(AFFIX_DAMAGE_TOP.rare, 25.0);
    assert_eq!(EXALTED_SKILL_FLOOR, 25.0);
}

#[test]
fn a_rolled_line_follows_skill_kin_and_the_exalted_line_does_not() {
    assert!(can_roll_skill(&n(102.0), &s("Armor"), &n(LONG_BLADE)));
    assert!(can_roll_skill(&n(102.0), &s("Armor"), &n(CRITICAL_STRIKE)));
    assert!(can_roll_skill(
        &n(135.0),
        &s("Jewellery"),
        &n(CRITICAL_STRIKE)
    ));
    assert!(!can_roll_skill(&n(135.0), &s("Jewellery"), &n(LONG_BLADE)));
    assert!(!rolled_skills(&n(135.0), &s("Jewellery")).contains(&LONG_BLADE));
    // The Exalted extra is not kin-filtered: a jewellery record with no skill line can gain +30 Long Blade.
    assert!(can_exalt_skill_here(&n(135.0), &s("Jewellery")));
    let options = slot_options(&n(135.0), &s("Jewellery"), &n(LONG_BLADE));
    let pairs: Vec<(f64, f64)> = options
        .items()
        .iter()
        .map(|o| (f(o.get("lb")), f(o.get("cs"))))
        .collect();
    assert_eq!(pairs, [(30.0, 0.0), (0.0, 30.0)]);
}

#[test]
fn a_piece_can_carry_both_skills_at_20_never_both_at_30() {
    for (template, group, skill) in [
        (123.0, "Weapons", LONG_BLADE),
        (102.0, "Armor", LONG_BLADE),
        (135.0, "Jewellery", LONG_BLADE),
        (563.0, "Weapons", HAND_TO_HAND),
    ] {
        for o in slot_options(&n(template), &s(group), &n(skill)).items() {
            assert!(
                !(f(o.get("lb")) == SKILL_BAND_TOP.legendary
                    && f(o.get("cs")) == SKILL_BAND_TOP.legendary),
                "{template}: both 30s"
            );
        }
    }
    // A weapon record always carries a skill line, so no weapon can Exalt a skill.
    assert!(!can_exalt_skill_here(&n(123.0), &s("Weapons")));
    let weapon_max = slot_options(&n(123.0), &s("Weapons"), &n(LONG_BLADE))
        .items()
        .iter()
        .map(|o| f(o.get("lb")).max(f(o.get("cs"))))
        .fold(f64::NEG_INFINITY, f64::max);
    assert_eq!(weapon_max, 25.0);
    assert!(slot_options(&n(123.0), &s("Weapons"), &n(LONG_BLADE))
        .items()
        .iter()
        .any(|o| f(o.get("lb")) == 20.0 && f(o.get("cs")) == 20.0));
    // An armour record can Exalt a skill.
    assert!(can_exalt_skill_here(&n(102.0), &s("Armor")));
    let armour_max = slot_options(&n(102.0), &s("Armor"), &n(LONG_BLADE))
        .items()
        .iter()
        .map(|o| f(o.get("lb")).max(f(o.get("cs"))))
        .fold(f64::NEG_INFINITY, f64::max);
    assert_eq!(armour_max, 30.0);
}

#[test]
fn every_records_exalted_capacity_matches_the_kind_not_carried_law() {
    assert!(all_records().len() >= 39);
    for record in all_records() {
        let carries_skill = record
            .get("affixes")
            .items()
            .iter()
            .any(|a| a.get("id").is_str("skill"));
        assert_eq!(
            can_exalt_skill(record, record.get("group")),
            !carries_skill,
            "{} ({})",
            record.get("id").to_js_string(),
            record.get("group").to_js_string()
        );
    }
    // And the records that fit a slot are the game's own list.
    for (template, group) in [(123.0, "Weapons"), (102.0, "Armor"), (135.0, "Jewellery")] {
        let ours: Vec<String> = records_for(&n(template), &s(group))
            .items()
            .iter()
            .map(|r| r.get("id").to_js_string())
            .collect();
        let theirs: Vec<String> = dfo_core::gear_profile::legendaries_for(&n(template), &s(group))
            .iter()
            .map(|r| r.get("id").to_js_string())
            .collect();
        let mut a = ours;
        let mut b = theirs;
        a.sort();
        b.sort();
        assert_eq!(a, b, "template {template}");
    }
}

#[test]
fn the_old_240_540_780_profile_is_not_reachable() {
    for template in [113.0, 117.0, 121.0, 123.0, 126.0, 127.0, 129.0] {
        let skill = weapon_skill_of(&n(template));
        let opts = obj([("weaponTemplate", n(template)), ("skill", n(skill))]);
        let totals = legal_totals(&opts);
        assert!(
            !totals
                .items()
                .iter()
                .any(|p| f(p.get("lb")) >= 240.0 && f(p.get("cs")) >= 540.0),
            "{template}: the old 240/540 exists"
        );
        let max_total = max_point_total(&opts);
        assert!(
            !totals
                .items()
                .iter()
                .any(|p| f(p.get("lb")) + f(p.get("cs")) > max_total),
            "{template}: above the legal total"
        );
    }
    assert_eq!(
        max_single_skill(&obj([("weaponTemplate", n(123.0))])),
        535.0
    );
    assert_eq!(
        max_single_skill(&obj([
            ("weaponTemplate", n(123.0)),
            ("skill", n(CRITICAL_STRIKE)),
        ])),
        535.0
    );
    assert_eq!(max_point_total(&obj([("weaponTemplate", n(123.0))])), 620.0);
    assert!(legal_point_totals(&obj([("weaponTemplate", n(123.0))]))
        .items()
        .iter()
        .all(|p| f(p.get("lb")) + f(p.get("cs")) <= 620.0));
    assert!(780.0 > max_point_total(&obj([("weaponTemplate", n(123.0))])));
}

#[test]
fn the_per_skill_and_point_budgets_are_level_independent_and_the_slots_are_the_worn_pieces() {
    // No level argument exists: the same budgets stand at every level; only the loot gate is level-dependent.
    assert_eq!(max_point_total(&obj([("weaponTemplate", n(123.0))])), 620.0);
    assert_eq!(
        max_single_skill(&obj([("weaponTemplate", n(123.0))])),
        535.0
    );
    assert_eq!(
        slots_for(&obj([("weaponTemplate", n(123.0))]))
            .items()
            .len(),
        18
    );
    assert_eq!(
        slots_for(&obj([("weaponTemplate", n(117.0)), ("shield", n(111.0)),]))
            .items()
            .len(),
        19
    );
}

#[test]
fn validate_plan_rejects_illegal_allocations_clearly() {
    let bad = |plan: Value| validate_plan(&plan).to_js_string();
    // A Rare may not exceed its band.
    assert!(bad(arr(vec![obj([
        ("template", n(102.0)),
        ("group", s("Armor")),
        ("rarity", s("rare")),
        (
            "lines",
            arr(vec![obj([
                ("id", s("skill")),
                ("param", n(LONG_BLADE)),
                ("value", n(21.0)),
            ])]),
        ),
    ])]))
    .contains("above the rare band"));
    // A Magic holds at most two lines.
    assert!(bad(arr(vec![obj([
        ("template", n(102.0)),
        ("group", s("Armor")),
        ("rarity", s("magic")),
        (
            "lines",
            arr(vec![
                obj([
                    ("id", s("skill")),
                    ("param", n(LONG_BLADE)),
                    ("value", n(10.0)),
                ]),
                obj([
                    ("id", s("skill")),
                    ("param", n(CRITICAL_STRIKE)),
                    ("value", n(10.0)),
                ]),
                obj([
                    ("id", s("stat")),
                    ("param", s("strength")),
                    ("value", n(5.0)),
                ]),
            ]),
        ),
    ])]))
    .contains("too many lines"));
    // One line per skill param.
    assert!(bad(arr(vec![obj([
        ("template", n(102.0)),
        ("group", s("Armor")),
        ("rarity", s("rare")),
        (
            "lines",
            arr(vec![
                obj([
                    ("id", s("skill")),
                    ("param", n(LONG_BLADE)),
                    ("value", n(20.0)),
                ]),
                obj([
                    ("id", s("skill")),
                    ("param", n(LONG_BLADE)),
                    ("value", n(20.0)),
                ]),
            ]),
        ),
    ])]))
    .contains("one line per skill"));
    // Jewellery cannot ROLL Long Blade.
    assert!(bad(arr(vec![obj([
        ("template", n(135.0)),
        ("group", s("Jewellery")),
        ("rarity", s("rare")),
        (
            "lines",
            arr(vec![obj([
                ("id", s("skill")),
                ("param", n(LONG_BLADE)),
                ("value", n(20.0)),
            ])]),
        ),
    ])]))
    .contains("may roll"));
    // A record's own line is fixed.
    assert!(bad(arr(vec![obj([
        ("template", n(123.0)),
        ("group", s("Weapons")),
        ("rarity", s("legendary")),
        ("record", s("anseis-edge")),
        (
            "lines",
            arr(vec![
                obj([("id", s("damage")), ("value", n(30.0))]),
                obj([
                    ("id", s("stat")),
                    ("param", s("agility")),
                    ("value", n(12.0)),
                ]),
                obj([
                    ("id", s("skill")),
                    ("param", n(LONG_BLADE)),
                    ("value", n(30.0)),
                ]),
            ]),
        ),
    ])]))
    .contains("fixed at 25"));
    // A record that already carries a skill cannot Exalt another skill line; an Exalted line starts at 25.
    assert!(bad(arr(vec![obj([
        ("template", n(123.0)),
        ("group", s("Weapons")),
        ("rarity", s("legendary")),
        ("record", s("anseis-edge")),
        ("exalted", b(true)),
        (
            "lines",
            arr(vec![obj([
                ("id", s("skill")),
                ("param", n(CRITICAL_STRIKE)),
                ("value", n(30.0)),
            ])]),
        ),
    ])]))
    .contains("Exalted line repeats a carried kind"));
    assert!(bad(arr(vec![obj([
        ("template", n(102.0)),
        ("group", s("Armor")),
        ("rarity", s("legendary")),
        ("record", s("the-warden")),
        ("exalted", b(true)),
        (
            "lines",
            arr(vec![
                obj([("id", s("armor")), ("value", n(15.0))]),
                obj([
                    ("id", s("stat")),
                    ("param", s("endurance")),
                    ("value", n(12.0)),
                ]),
                obj([
                    ("id", s("resist")),
                    ("param", s("magic")),
                    ("value", n(40.0)),
                ]),
                obj([
                    ("id", s("skill")),
                    ("param", n(LONG_BLADE)),
                    ("value", n(24.0)),
                ]),
            ]),
        ),
    ])]))
    .contains("starts at 25"));
    // A legal pair is accepted.
    assert_eq!(
        validate_plan(&arr(vec![
            obj([
                ("template", n(102.0)),
                ("group", s("Armor")),
                ("rarity", s("rare")),
                (
                    "lines",
                    arr(vec![
                        obj([
                            ("id", s("skill")),
                            ("param", n(LONG_BLADE)),
                            ("value", n(20.0)),
                        ]),
                        obj([
                            ("id", s("skill")),
                            ("param", n(CRITICAL_STRIKE)),
                            ("value", n(20.0)),
                        ]),
                    ]),
                ),
            ]),
            obj([
                ("template", n(102.0)),
                ("group", s("Armor")),
                ("rarity", s("legendary")),
                ("record", s("the-warden")),
                ("exalted", b(true)),
                (
                    "lines",
                    arr(vec![
                        obj([("id", s("armor")), ("value", n(15.0))]),
                        obj([
                            ("id", s("stat")),
                            ("param", s("endurance")),
                            ("value", n(12.0)),
                        ]),
                        obj([
                            ("id", s("resist")),
                            ("param", s("magic")),
                            ("value", n(40.0)),
                        ]),
                        obj([
                            ("id", s("skill")),
                            ("param", n(LONG_BLADE)),
                            ("value", n(30.0)),
                        ]),
                    ]),
                ),
            ]),
        ]))
        .items()
        .len(),
        0
    );
}
