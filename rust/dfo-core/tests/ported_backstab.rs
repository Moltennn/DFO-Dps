//! Ported from `test/backstab.test.js`: the backstab chance, the flat to-hit term, the ×3 gate and its position in the
//! blow.
//!
//! LOCAL INVARIANTS on the JS file's hand-written values. The differential suite compared the assembled blow with the
//! game; `tests/model_blow.rs` carries the port's seeded parity vectors.

mod ported_common;

use dfo_core::model_blow::{backstab_damage, damage_model, hit_model, weapon_of};
use dfo_core::round::unity_round;
use ported_common::*;

fn player(skill: f64) -> Desc {
    Desc::new()
        .level(30.0)
        .stat("strength", 70.0)
        .stat("agility", 60.0)
        .stat("speed", 60.0)
        .stat("luck", 50.0)
        .stat("endurance", 50.0)
        .stat("willpower", 50.0)
        .skills(0.0)
        .skill(29, 100.0)
        .skill(34, 40.0)
        .skill(19, skill)
}

fn tough() -> Value {
    reference_foe(30.0, "tough")
}

#[test]
fn the_chance_is_the_live_backstabbing_skill() {
    let item = weapon(121.0, 9.0, 1.0);
    for skill in [0.0_f64, 1.0, 2.0, 50.0, 100.0, 150.0] {
        let live = skill.min(100.0);
        let ch = player(skill).sim(Some(item.clone()));
        let r = analyze(
            &ch,
            &obj([
                ("target", tough()),
                ("core", s("overhaul")),
                ("backstabUptime", n(1.0)),
            ]),
        );
        assert_eq!(r.backstab.skill, live, "skill {skill}");
        let want = if live > 1.0 {
            (live / 100.0).min(1.0)
        } else {
            0.0
        };
        assert_eq!(r.backstab.chance, want, "skill {skill}");
        assert_eq!(
            r.backstab.to_hit, live,
            "the flat to-hit term is the live skill"
        );
        assert_eq!(r.backstab.uptime, 1.0);
    }
    // A caller can hand the raw chance (the upstream function takes it directly).
    let ch = player(0.0).sim(Some(item));
    let raw = analyze(
        &ch,
        &obj([
            ("target", tough()),
            ("core", s("overhaul")),
            ("backstabUptime", n(1.0)),
            ("backstabChance", n(150.0)),
        ]),
    );
    assert_eq!(raw.backstab.skill, 150.0);
    assert_eq!(raw.backstab.chance, 1.0);
}

#[test]
fn no_back_facing_no_chance_and_no_hit_term() {
    let item = weapon(121.0, 9.0, 1.0);
    let ch = player(50.0).sim(Some(item));
    let ordinary = analyze(&ch, &obj([("target", tough()), ("core", s("overhaul"))]));
    let explicit = analyze(
        &ch,
        &obj([
            ("target", tough()),
            ("core", s("overhaul")),
            ("backstabUptime", n(0.0)),
        ]),
    );
    assert_eq!(ordinary.backstab.uptime, 0.0);
    assert_eq!(
        ordinary.backstab.chance, 0.5,
        "the per-landed-blow chance is exposed"
    );
    assert_eq!(ordinary.backstab.to_hit, 50.0);
    assert_eq!(f(ordinary.hit.get("terms").get("backstab")), 0.0);
    assert_eq!(ordinary.per_swing, explicit.per_swing);
    assert_eq!(ordinary.capped_per_swing, explicit.capped_per_swing);
    assert_eq!(f(ordinary.hit.get("hit")), f(explicit.hit.get("hit")));
}

#[test]
fn a_watchful_revenant_never_gives_one() {
    let item = weapon(121.0, 9.0, 1.0);
    let ch = player(100.0).sim(Some(item));
    let mut watchful = tough();
    watchful.set("revenant", obj([("edge", obj([("watchful", b(true))]))]));
    let r = analyze(
        &ch,
        &obj([
            ("target", watchful),
            ("core", s("overhaul")),
            ("backstabUptime", n(1.0)),
        ]),
    );
    assert!(r.backstab.watchful);
    assert_eq!(r.backstab.skill, 0.0);
    assert_eq!(r.backstab.chance, 0.0);
    assert_eq!(f(r.hit.get("terms").get("backstab")), 0.0);
    let plain = analyze(&ch, &obj([("target", tough()), ("core", s("overhaul"))]));
    assert_eq!(
        r.per_swing, plain.per_swing,
        "the Watchful body is the ordinary body"
    );
}

#[test]
fn the_chance_is_added_flat_to_the_hit_roll() {
    let item = weapon(121.0, 9.0, 1.0);
    let ch = player(20.0)
        .skill(29, 50.0)
        .skill(34, 0.0)
        .skill(19, 20.0)
        .sim(Some(item.clone()));
    let w = weapon_of(&item, false);
    let ordinary = hit_model(&ch, &w, &tough(), "StrikeLeft", "overhaul", &obj([]));
    let behind = hit_model(
        &ch,
        &w,
        &tough(),
        "StrikeLeft",
        "overhaul",
        &obj([("backstabBonus", n(20.0))]),
    );
    for part in 0..7 {
        let (o, b) = (
            f(ordinary.get("byPart").get("plain").at(part)),
            f(behind.get("byPart").get("plain").at(part)),
        );
        assert!(b >= o, "part {part}");
        if o < 0.77 {
            assert!(near_eps(b - o, 0.2, 1e-9), "part {part}: +20 points");
        }
    }
    assert_eq!(f(behind.get("terms").get("backstab")), 20.0);
    assert_eq!(f(ordinary.get("terms").get("backstab")), 0.0);
    let uptime = analyze(
        &ch,
        &obj([
            ("target", tough()),
            ("core", s("overhaul")),
            ("backstabUptime", n(1.0)),
        ]),
    );
    let no = analyze(&ch, &obj([("target", tough()), ("core", s("overhaul"))]));
    assert!(f(uptime.hit.get("hit")) > f(no.hit.get("hit")));
    assert_eq!(f(uptime.hit.get("terms").get("backstab")), 20.0);
}

#[test]
fn the_x3_gate_and_the_dice_threshold() {
    assert_eq!(backstab_damage(10.0, 0.0, 0.0), 10.0);
    assert_eq!(
        backstab_damage(10.0, 1.0, 0.0),
        10.0,
        "level > 1 is the gate"
    );
    assert_eq!(backstab_damage(10.0, 2.0, 0.0), 30.0);
    assert_eq!(backstab_damage(10.0, 50.0, 0.0), 30.0);
    assert_eq!(backstab_damage(10.0, 50.0, 0.49), 30.0);
    assert_eq!(
        backstab_damage(10.0, 50.0, 0.5),
        10.0,
        "floor(0.5 x 100) is not < 50"
    );
    assert_eq!(backstab_damage(10.0, 100.0, 0.999), 30.0);
    assert_eq!(
        backstab_damage(10.0, 150.0, 0.999),
        30.0,
        "above 100 always lands"
    );
}

#[test]
fn the_x3_is_before_the_critical_and_the_material_requirement() {
    let item = weapon(121.0, 9.0, 1.0);
    let ch = player(50.0)
        .skill(29, 100.0)
        .skill(34, 55.0)
        .sim(Some(item.clone()));
    let w = weapon_of(&item, false);
    let dmg = damage_model(
        &ch,
        &w,
        Some(&dfo_core::target::Target::default()),
        "StrikeLeft",
        "overhaul",
        &obj([]),
        &mut Default::default(),
    );
    let plain: Vec<f64> = dmg.get("plainRolls").items().iter().map(f).collect();
    let backstab: Vec<f64> = dmg
        .get("backstabPlainRolls")
        .items()
        .iter()
        .map(f)
        .collect();
    assert_eq!(backstab.len(), plain.len());
    for (b, p) in backstab.iter().zip(&plain) {
        assert_eq!(*b, p * 3.0, "no crit/condition: exactly x3");
    }
    let crit_mult = f(dmg.get("crit").get("damageMult"));
    assert!(
        crit_mult > 1.0 && crit_mult.fract() != 0.0,
        "a fractional crit multiplier exercises the rounding order"
    );
    let crit: Vec<f64> = dmg.get("backstabCritRolls").items().iter().map(f).collect();
    for (i, p) in plain.iter().enumerate() {
        assert_eq!(crit[i], unity_round(p * 3.0 * crit_mult));
    }
}

#[test]
fn the_outcome_is_a_x1_x3_mixture_not_a_scaled_average() {
    let item = weapon(121.0, 9.0, 1.0);
    let ch = player(50.0).sim(Some(item));
    let ordinary = analyze(&ch, &obj([("target", tough()), ("core", s("overhaul"))]));
    let behind = analyze(
        &ch,
        &obj([
            ("target", tough()),
            ("core", s("overhaul")),
            ("backstabUptime", n(1.0)),
        ]),
    );
    let always = analyze(
        &ch,
        &obj([
            ("target", tough()),
            ("core", s("overhaul")),
            ("backstabUptime", n(1.0)),
            ("backstabChance", n(100.0)),
        ]),
    );
    assert_eq!(
        behind.backstab.expected_mult, 2.0,
        "1 + 2 x 0.5 at full uptime"
    );
    assert!(behind.per_swing > ordinary.per_swing);
    assert!(
        behind.per_swing < always.per_swing,
        "a 50% chance is not the always-x3 outcome"
    );
    assert!(always.per_swing > ordinary.per_swing * 2.5);
    let half = analyze(
        &ch,
        &obj([
            ("target", tough()),
            ("core", s("overhaul")),
            ("backstabUptime", n(0.5)),
        ]),
    );
    assert!(half.per_swing > ordinary.per_swing && half.per_swing < behind.per_swing);
    assert_eq!(half.backstab.expected_mult, 1.5);
}

#[test]
fn a_skill_of_1_gains_the_hit_term_but_never_the_x3() {
    let item = weapon(121.0, 9.0, 1.0);
    let ch = player(1.0)
        .skill(29, 50.0)
        .skill(34, 0.0)
        .skill(19, 1.0)
        .sim(Some(item));
    let ordinary = analyze(&ch, &obj([("target", tough()), ("core", s("overhaul"))]));
    let behind = analyze(
        &ch,
        &obj([
            ("target", tough()),
            ("core", s("overhaul")),
            ("backstabUptime", n(1.0)),
        ]),
    );
    assert_eq!(behind.backstab.chance, 0.0);
    assert_eq!(f(behind.hit.get("terms").get("backstab")), 1.0);
    assert!(
        behind.per_swing > ordinary.per_swing,
        "the +1 hit term still helps"
    );
}
