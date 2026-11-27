//! Ported from `test/racial.test.js` and `test/ranged.test.js`: the racial arms and the ranged paces.
//!
//! LOCAL INVARIANTS on the JS files' hand-written tables. `tests/model_blow.rs` holds the parity vectors for the same
//! functions.

mod ported_common;

use dfo_core::model_blow::{cadence, damage_model, racial_modifiers, weapon_of};
use ported_common::*;

const SKILL_OF: [(f64, f64); 5] = [
    (113.0, 28.0),
    (121.0, 29.0),
    (126.0, 32.0),
    (127.0, 31.0),
    (129.0, 33.0),
];

fn ch_of(race_id: f64, template: Option<f64>) -> Desc {
    let skill_id = template
        .and_then(|t| SKILL_OF.iter().find(|(k, _)| *k == t).map(|(_, v)| *v))
        .unwrap_or(30.0);
    Desc::new()
        .level(30.0)
        .race(race_id)
        .stat("strength", 80.0)
        .stat("agility", 70.0)
        .stat("speed", 90.0)
        .stat("luck", 60.0)
        .stat("endurance", 75.0)
        .stat("willpower", 50.0)
        .skills(50.0)
        .skill(skill_id as usize, 80.0)
        .skill(34, 40.0)
        .skill(19, 0.0)
}

/// `racialModifiers(ch, weapon | null, core)` as `{damage, toHit}`.
fn terms(race_id: f64, template: Option<f64>, core: &str) -> (f64, f64) {
    let item = template.map(|t| weapon(t, 9.0, 1.0));
    let ch = ch_of(race_id, template).sim(item.clone());
    let w = item.map_or(Value::Null, |it| weapon_of(&it, false));
    let out = racial_modifiers(&ch, &w, core, &obj([]));
    (f(out.get("damage")), f(out.get("toHit")))
}

// Race ids (`src/data.js` RACES): the DFU numbering the JS test names.
const ARGONIAN: f64 = 8.0;
const BRETON: f64 = 1.0;
const DARK_ELF: f64 = 4.0;
const HIGH_ELF: f64 = 5.0;
const KHAJIIT: f64 = 7.0;
const NORD: f64 = 3.0;
const REDGUARD: f64 = 2.0;
const WOOD_ELF: f64 = 6.0;

#[test]
fn every_weapon_arm_is_the_js_table() {
    for (race, template, want) in [
        (ARGONIAN, 113.0, (4.0, 7.0)),
        (DARK_ELF, 121.0, (5.0, 5.0)),
        (DARK_ELF, 113.0, (2.0, 5.0)),
        (WOOD_ELF, 113.0, (3.0, 6.0)),
        (WOOD_ELF, 129.0, (5.0, 12.0)),
        (KHAJIIT, 113.0, (3.0, 6.0)),
        (NORD, 127.0, (7.0, 5.0)),
        (NORD, 126.0, (6.0, 6.0)),
        (REDGUARD, 121.0, (3.0, 12.0)),
        (REDGUARD, 126.0, (4.0, 7.0)),
        (REDGUARD, 127.0, (7.0, 5.0)),
        (REDGUARD, 129.0, (2.0, 5.0)),
    ] {
        assert_eq!(
            terms(race, Some(template), "overhaul"),
            want,
            "race {race}, template {template}"
        );
    }
}

#[test]
fn the_wood_elf_archery_luck_term_is_over_25_not_over_20() {
    let archery = terms(WOOD_ELF, Some(129.0), "overhaul");
    assert_eq!(archery, (5.0, 12.0));
    let short = terms(WOOD_ELF, Some(113.0), "overhaul");
    assert_eq!(archery.1 - short.1, 6.0);
}

#[test]
fn the_two_unarmed_arms() {
    assert_eq!(terms(NORD, None, "overhaul"), (3.0, 0.0));
    assert_eq!(terms(KHAJIIT, None, "overhaul"), (6.0, 6.0));
    for race in [BRETON, REDGUARD, DARK_ELF, HIGH_ELF, WOOD_ELF, ARGONIAN] {
        assert_eq!(
            terms(race, None, "overhaul"),
            (0.0, 0.0),
            "race {race} fists"
        );
    }
}

#[test]
fn races_without_an_arm_stay_at_zero_and_an_arm_is_for_its_own_skill() {
    for race in [BRETON, HIGH_ELF] {
        for template in [113.0, 121.0, 126.0, 127.0, 129.0] {
            assert_eq!(
                terms(race, Some(template), "overhaul"),
                (0.0, 0.0),
                "race {race}, template {template}"
            );
        }
        assert_eq!(terms(race, None, "overhaul"), (0.0, 0.0));
    }
    assert_eq!(terms(WOOD_ELF, Some(121.0), "overhaul"), (0.0, 0.0));
    assert_eq!(terms(KHAJIIT, Some(127.0), "overhaul"), (0.0, 0.0));
    assert_eq!(terms(ARGONIAN, Some(129.0), "overhaul"), (0.0, 0.0));
}

#[test]
fn the_classic_ladder_including_the_redguard_archer_quirk() {
    assert_eq!(
        terms(DARK_ELF, Some(129.0), "classic"),
        (7.0, 7.0),
        "the Dark Elf arm wins over archery"
    );
    assert_eq!(
        terms(WOOD_ELF, Some(129.0), "classic"),
        (10.0, 10.0),
        "level / 3"
    );
    assert_eq!(
        terms(REDGUARD, Some(129.0), "classic"),
        (0.0, 0.0),
        "a Redguard archer gets nothing"
    );
    assert_eq!(
        terms(REDGUARD, Some(121.0), "classic"),
        (10.0, 10.0),
        "a Redguard non-archer gets level / 3"
    );
    assert_eq!(terms(BRETON, Some(113.0), "classic"), (0.0, 0.0));
    assert_eq!(
        terms(WOOD_ELF, Some(113.0), "classic"),
        (0.0, 0.0),
        "the Wood Elf short blade is overhaul-only"
    );
    assert_eq!(
        terms(NORD, None, "classic"),
        (0.0, 0.0),
        "no unarmed stock arm"
    );
}

#[test]
fn the_damage_is_in_the_weapon_blow_and_the_hit_in_the_to_hit_base() {
    let ch = ch_of(WOOD_ELF, Some(113.0)).sim(Some(weapon(113.0, 9.0, 1.0)));
    let w = weapon_of(&weapon(113.0, 9.0, 1.0), false);
    let target = reference_foe(30.0, "tough");
    let dmg = damage_model(
        &ch,
        &w,
        Some(&dfo_core::target::Target::default()),
        "StrikeLeft",
        "overhaul",
        &obj([]),
        &mut Default::default(),
    );
    let parts = dmg.get("parts");
    assert_eq!(f(parts.get("racial")), 3.0);
    assert_eq!(f(parts.get("dmgMods")), f(parts.get("prof")) + 3.0);
    let r = analyze(
        &ch,
        &obj([("target", target.clone()), ("core", s("overhaul"))]),
    );
    assert_eq!(f(r.hit.get("racial").get("toHit")), 6.0);
    let breton = analyze(
        &ch_of(BRETON, Some(113.0)).sim(Some(weapon(113.0, 9.0, 1.0))),
        &obj([("target", target), ("core", s("overhaul"))]),
    );
    assert_eq!(f(breton.damage.get("parts").get("racial")), 0.0);
    assert_eq!(f(breton.hit.get("racial").get("toHit")), 0.0);
    assert!(r.per_swing > breton.per_swing);
}

#[test]
fn a_nord_and_a_khajiit_fist_beat_a_breton_fist() {
    for (race, want) in [(NORD, (3.0, 0.0)), (KHAJIIT, (6.0, 6.0))] {
        let ch = ch_of(race, None).sim(None);
        let r = analyze(
            &ch,
            &obj([
                ("target", reference_foe(30.0, "tough")),
                ("core", s("overhaul")),
            ]),
        );
        assert!(matches!(r.weapon, Value::Null));
        assert_eq!(f(r.damage.get("parts").get("racial")), want.0);
        assert_eq!(f(r.hit.get("racial").get("toHit")), want.1);
        let breton = analyze(
            &ch_of(BRETON, None).sim(None),
            &obj([
                ("target", reference_foe(30.0, "tough")),
                ("core", s("overhaul")),
            ]),
        );
        assert!(
            r.per_swing > breton.per_swing,
            "race {race} fists beat a Breton's"
        );
    }
}

// ── ranged.test.js ────────────────────────────────────────────────

fn shooter(template: f64) -> Value {
    let mut ch = dfo_core::theory::theory_character(&obj([("blade", n(template))]))
        .expect("the theory character");
    let mut weapon = obj([
        ("name", s("Test")),
        ("group", s("Weapons")),
        ("templateIndex", n(template)),
        ("material", n(9.0)),
        ("maxCondition", n(100.0)),
        ("currentCondition", n(100.0)),
        ("equipSlot", n(19.0)),
        (
            "affixes",
            arr(vec![obj([("id", s("damage")), ("value", n(40.0))])]),
        ),
    ]);
    let _ = &mut weapon;
    ch.set("weapon", weapon);
    ch.set("skills", {
        let mut values: Vec<Value> = ch.get("skills").items().to_vec();
        values[33] = n(200.0);
        arr(values)
    });
    ch.set("masteredSkills", nums([33.0, 34.0, 19.0]));
    ch.set(
        "_mods",
        obj([("skills", obj([("33", n(240.0)), ("34", n(540.0))]))]),
    );
    let mut career = ch.get("career").clone();
    career.set("weaponArmorShieldsBitfield", n((32.0f64) * 65536.0));
    ch.set("career", career);
    ch
}

#[test]
fn a_bow_paces_at_its_bow_fast_window_and_spamming_is_slower() {
    let ch = shooter(130.0);
    let target = reference_foe(45.0, "tough");
    let paced = analyze(
        &ch,
        &obj([
            ("target", target.clone()),
            ("core", s("overhaul")),
            ("rri", b(true)),
        ]),
    );
    let spam = analyze(
        &ch,
        &obj([
            ("target", target),
            ("core", s("overhaul")),
            ("rri", b(true)),
            ("bowSpam", b(true)),
        ]),
    );
    assert!(paced.cadence.get("bow").truthy());
    assert_eq!(f(paced.cadence.get("seconds")), 1.25);
    assert!(f(spam.cadence.get("seconds")) < f(paced.cadence.get("seconds")));
    assert!(paced.dps > spam.dps, "{} vs {}", paced.dps, spam.dps);
}

#[test]
fn the_long_bow_is_slower_but_hits_harder_than_the_short_bow() {
    let target = reference_foe(45.0, "tough");
    let short = analyze(
        &shooter(129.0),
        &obj([
            ("target", target.clone()),
            ("core", s("overhaul")),
            ("rri", b(true)),
        ]),
    );
    let long = analyze(
        &shooter(130.0),
        &obj([
            ("target", target),
            ("core", s("overhaul")),
            ("rri", b(true)),
        ]),
    );
    assert!(f(long.damage.get("avg")) > f(short.damage.get("avg")));
    assert!(f(long.cadence.get("seconds")) > f(short.cadence.get("seconds")));
}

#[test]
fn a_pistolet_pair_is_two_machines_and_the_off_hand_is_weaker() {
    let target = reference_foe(45.0, "tough");
    let ch = shooter(562.0);
    let single = analyze(
        &ch,
        &obj([
            ("target", target.clone()),
            ("core", s("overhaul")),
            ("rri", b(true)),
        ]),
    );
    let pair = analyze(
        &ch,
        &obj([
            ("target", target),
            ("core", s("overhaul")),
            ("rri", b(true)),
            ("pair", b(true)),
        ]),
    );
    assert!(single.cadence.get("gun").truthy());
    assert!(f(pair.cadence.get("seconds")) > 0.0);
    assert!(pair.dps > single.dps);
    assert!(pair.dps < single.dps * 2.0, "off hand is x0.8");
}

#[test]
fn the_thunderlock_uses_archery_and_the_two_handed_strength_term() {
    let target = reference_foe(45.0, "tough");
    let r = analyze(
        &shooter(560.0),
        &obj([
            ("target", target),
            ("core", s("overhaul")),
            ("rri", b(true)),
        ]),
    );
    assert_eq!(f(r.weapon.get("skillId")), 33.0);
    assert_eq!(f(r.damage.get("parts").get("strMod")), 10.0);
    assert!(r.cadence.get("gun").truthy());
}

#[test]
fn the_card_cadence_reads_the_weapon_not_a_constant() {
    // A plain check that `cadence` is a function of the weapon row, not a fixed 1 s.
    let ch = ch_of(BRETON, Some(121.0)).sim(Some(weapon(121.0, 9.0, 1.0)));
    let a = cadence(&ch, &weapon_of(&weapon(121.0, 9.0, 1.0), false), &obj([]));
    let b = cadence(&ch, &weapon_of(&weapon(122.0, 9.0, 1.0), false), &obj([]));
    assert!(f(b.get("seconds")) > f(a.get("seconds")));
}
