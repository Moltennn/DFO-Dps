//! Ported from `test/invariants.test.js`: the 13 properties the JS file pins, minus the two that need the vendored
//! oracle (marked below).
//!
//! Each is a LOCAL INVARIANT: an inequality or a known value the engine must satisfy whatever the numbers are. The
//! oracle-module parity cases (skill boundaries against upstream, the combat-stats smoke test) cannot be ported; they
//! are listed as lost in `rust/PORTED-TESTS.md`. Their known reference values (`effectiveSkill(125) == 108`) are
//! asserted here from the JS file's own expectations.

mod ported_common;

use dfo_core::damage::{damage_modifier, pcaao_damage_modifier};
use dfo_core::model_blow::expected_capped;
use dfo_core::save::{effective_skill, live_stat};
use ported_common::*;

#[test]
fn invariant_a_hit_is_never_certain_and_never_hopeless() {
    let mut r = lcg(4242);
    for _ in 0..500 {
        let level = 1.0 + (r() * 60.0).floor();
        let ch = Desc::new()
            .level(level)
            .stat("strength", (r() * 120.0).floor())
            .stat("agility", (r() * 120.0).floor())
            .stat("speed", (r() * 120.0).floor())
            .stat("luck", (r() * 120.0).floor())
            .sim(None);
        for preset in ["soft", "tough", "armoured", "human"] {
            let card = analyze(&ch, &obj([("target", reference_foe(level, preset))]));
            let hit = &card.hit;
            let (plain, mixed) = (f(hit.get("hitPlain")), f(hit.get("hit")));
            assert!(
                (0.03 - 1e-12..=0.97 + 1e-12).contains(&plain),
                "plain hit {plain} ({preset})"
            );
            assert!(
                (0.03 - 1e-12..=0.97 + 1e-12).contains(&mixed),
                "crit-weighted hit {mixed} ({preset})"
            );
        }
    }
}

#[test]
fn invariant_damage_ranges_are_ordered_and_non_negative() {
    let mut r = lcg(90210);
    let blades = [113.0, 120.0, 123.0, 126.0, 129.0];
    for _ in 0..200 {
        let level = 1.0 + (r() * 60.0).floor();
        let template = blades[(r() * 5.0).floor() as usize];
        let material = (r() * 10.0).floor();
        let ch = Desc::new()
            .level(level)
            .stat("strength", (r() * 120.0).floor())
            .sim(Some(weapon(template, material, 1.0)));
        let d = &analyze(&ch, &obj([("target", reference_foe(level, "tough"))])).damage;
        let (min, avg, max) = (f(d.get("min")), f(d.get("avg")), f(d.get("max")));
        assert!(
            min >= 0.0 && min <= avg && avg <= max,
            "plain {min}/{avg}/{max}"
        );
        let (cmin, cavg, cmax) = (
            f(d.get("critMin")),
            f(d.get("critAvg")),
            f(d.get("critMax")),
        );
        assert!(
            cmin >= 0.0 && cmin <= cavg && cavg <= cmax,
            "crit {cmin}/{cavg}/{cmax}"
        );
        assert!(
            cmax >= max,
            "a critical hit is never smaller than a plain one"
        );
    }
}

#[test]
fn invariant_the_per_hit_cap_never_increases_dps_and_binds_only_above_it() {
    assert_eq!(expected_capped(10.0, 20.0, 100.0), 15.0);
    assert_eq!(expected_capped(10.0, 20.0, 5.0), 5.0);
    for cap in [1.0, 5.0, 10.0, 15.0, 20.0, 50.0] {
        let mut prev = f64::NEG_INFINITY;
        for d in [1.0, 3.0, 7.0, 12.0, 18.0, 25.0] {
            let v = expected_capped(d, d + 4.0, cap);
            assert!(v <= cap + 1e-12, "cap {cap} bounds {v}");
            assert!(v >= prev - 1e-12, "monotone in the roll span");
            prev = v;
        }
    }
}

#[test]
fn invariant_skill_boundaries_100_125_200_read_as_the_game_reads_them() {
    // The JS asserts parity with the vendored `skillSoftcap.effectiveSkill`; the values it pins are these.
    for v in [100.0, 101.0, 125.0, 150.0, 175.0, 200.0] {
        assert!(effective_skill(&n(v)).is_finite(), "effectiveSkill({v})");
    }
    assert_eq!(effective_skill(&n(100.0)), 100.0);
    assert_eq!(effective_skill(&n(125.0)), 108.0);
    assert_eq!(effective_skill(&n(200.0)), 140.0);
}

#[test]
fn invariant_an_attribute_stops_at_100_unless_a_stat_max_channel_lifts_it() {
    let mut ch = Desc::new().stat("strength", 100.0).sim(None);
    assert_eq!(live_stat(&ch, "strength"), 100.0);
    ch.set(
        "_mods",
        obj([
            ("stats", obj([("strength", n(15.0))])),
            ("skills", Obj(vec![])),
        ]),
    );
    assert_eq!(
        live_stat(&ch, "strength"),
        100.0,
        "a mod cannot pass the ceiling"
    );
    ch.set(
        "_mods",
        obj([
            ("stats", obj([("strength", n(15.0))])),
            ("statMax", obj([("strength", n(15.0))])),
            ("skills", Obj(vec![])),
        ]),
    );
    assert_eq!(live_stat(&ch, "strength"), 115.0);
    let r = analyze(&ch, &obj([("target", reference_foe(45.0, "tough"))]));
    assert_eq!(
        f(r.damage.get("parts").get("strMod")),
        ((115.0 - 50.0) / 10.0_f64).floor(),
        "the formula reads the lifted value"
    );
}

#[test]
fn invariant_the_breach_pool_cap_and_phase_shields_are_the_relays_numbers() {
    for level in [1.0, 30.0, 45.0, 60.0] {
        let reference = 5.0 + level;
        let t = gate_target(level);
        assert_eq!(f(t.get("hitCap")), 12.0 * reference, "cap {level}");
        assert_eq!(f(t.get("maxHealth")), 240.0 * reference, "pool {level}");
        assert_eq!(f(t.get("phaseShields")), 2.0);
    }
}

#[test]
fn invariant_no_build_beats_the_breach_refill_rate_for_long() {
    let level = 45.0;
    let reference = 5.0 + level;
    let ch = geared();
    let gate = gate_target(level);
    let r = analyze(
        &ch,
        &obj([
            ("target", gate.clone()),
            ("health", gate.get("maxHealth").clone()),
            ("rri", b(true)),
            ("stacks", n(5.0)),
        ]),
    );
    let a = r
        .allowance
        .as_ref()
        .expect("the Breach target runs the relay allowance");
    assert!(
        r.capped_dps > 3.0 * reference * 2.0,
        "the per-hit-capped figure is a ceiling, far above the allowance"
    );
    assert_eq!(
        f(a.get("sustainedDps")),
        3.0 * reference,
        "sustained DPS is the refill rate"
    );
    let avg = f(a.get("averageDps"));
    assert!(
        avg <= 3.0 * reference * 1.15,
        "kill-average {avg} within the allowance"
    );
    // (share - depth) / rate = (12,000 - 750) / 150 = 75 s.
    let floor = (f(gate.get("maxHealth")) - 15.0 * reference) / (3.0 * reference);
    let ttk = r.ttk.expect("a kill");
    assert!(
        ttk >= floor - 1e-6,
        "no solo kill under {floor} s ({ttk} s)"
    );
}

#[test]
fn invariant_a_blow_over_the_cap_is_clipped_and_the_clip_is_reported() {
    let ch = geared();
    let gate = gate_target(45.0);
    let r = analyze(
        &ch,
        &obj([
            ("target", gate.clone()),
            ("health", gate.get("maxHealth").clone()),
            ("rri", b(true)),
            ("stacks", n(5.0)),
        ]),
    );
    assert!(r.cap > 0.0);
    assert!(r.capped_dps < r.dps, "the cap binds this build");
    assert!(r.cap_loss > 0.0 && r.cap_loss < 1.0);
    let mut uncapped_target = gate.clone();
    uncapped_target.set("hitCap", n(0.0));
    let uncapped = analyze(
        &ch,
        &obj([
            ("target", uncapped_target),
            ("health", n(0.0)),
            ("rri", b(true)),
            ("stacks", n(5.0)),
        ]),
    );
    assert_eq!(uncapped.capped_dps, uncapped.dps, "no cap, no loss");
}

#[test]
fn invariant_condition_thresholds_change_the_blow() {
    let at = |pct: f64| {
        let ch = Desc::new()
            .level(30.0)
            .stat("strength", 60.0)
            .skills(0.0)
            .sim(Some(weapon_at(121.0, pct, 9.0)));
        f(
            analyze(&ch, &obj([("target", reference_foe(30.0, "tough"))]))
                .damage
                .get("avg"),
        )
    };
    let whole = at(100.0);
    assert!(
        at(95.0) <= whole + 1e-9,
        "no edge bonus without the wear module"
    );
    assert!(at(50.0) < whole, "a worn blade cuts less at 50% (x0.85)");
    assert!(at(30.0) < at(50.0), "and less again at 30% (x0.7)");
    assert!(at(3.0) < at(30.0), "and least when nearly broken (x0.25)");
}

#[test]
fn invariant_pve_spells_never_crit_and_the_cast_recovery_is_the_throughput_floor() {
    let spell = obj([
        ("name", s("fixture")),
        ("element", n(4.0)),
        ("rangeType", n(0.0)),
        ("cost", n(10.0)),
        (
            "effects",
            arr(vec![obj([
                ("type", n(4.0)),
                ("subType", n(0.0)),
                ("magnitudeBaseLow", n(10.0)),
                ("magnitudeBaseHigh", n(20.0)),
                ("magnitudeLevelBase", n(1.0)),
                ("magnitudeLevelHigh", n(1.0)),
                ("magnitudePerLevel", n(1.0)),
                ("durationBase", n(0.0)),
                ("durationMod", n(0.0)),
                ("durationPerLevel", n(1.0)),
                ("chanceBase", n(0.0)),
                ("chanceMod", n(0.0)),
                ("chancePerLevel", n(1.0)),
            ])]),
        ),
    ]);
    let ch = Desc::new().level(30.0).stat("speed", 50.0).sim(None);
    let card =
        dfo_core::spells::analyze_spell(&spell, &ch, &reference_foe(30.0, "tough"), &obj([]));
    assert_eq!(
        f(card.get("castSeconds")),
        0.7,
        "Speed 50: the 0.7 s recovery"
    );
    assert!(card.get("crit").is_nullish(), "no spell critical");
}

#[test]
fn invariant_every_damage_path_reports_finite_numbers() {
    let mut r = lcg(31337);
    let blades = [113.0, 121.0, 126.0, 129.0];
    for _ in 0..120 {
        let level = 1.0 + (r() * 60.0).floor();
        let ch = Desc::new()
            .level(level)
            .stat("strength", (r() * 120.0).floor())
            .stat("agility", (r() * 120.0).floor())
            .stat("speed", (r() * 120.0).floor())
            .stat("luck", (r() * 120.0).floor())
            .sim(Some(weapon(
                blades[(r() * 4.0).floor() as usize],
                (r() * 10.0).floor(),
                r(),
            )));
        let card = analyze(
            &ch,
            &obj([
                ("target", reference_foe(level, "tough")),
                ("rri", b(r() < 0.5)),
            ]),
        );
        for (name, value) in [
            ("perSwing", card.per_swing),
            ("dps", card.dps),
            ("cappedDps", card.capped_dps),
            ("perSwingMin", card.per_swing_min),
            ("perSwingMax", card.per_swing_max),
            ("dpsMin", card.dps_min),
            ("dpsMax", card.dps_max),
            ("cappedDpsMin", card.capped_dps_min),
            ("cappedDpsMax", card.capped_dps_max),
        ] {
            assert!(value.is_finite(), "{name} is finite ({value})");
        }
        let aps = f(card.cadence.get("aps"));
        assert!(aps.is_finite() && aps > 0.0);
    }
}

#[test]
fn invariant_the_strength_term_is_over_ten_everywhere_it_is_used() {
    for s in [0.0, 25.0, 50.0, 66.0, 80.0, 100.0, 115.0] {
        assert_eq!(pcaao_damage_modifier(s), ((s - 50.0) / 10.0).floor());
    }
    assert_eq!(damage_modifier(50.0), 0.0);
}

// `invariant: the simulator never claims a value the vendored oracle contradicts on the per-hit core` is not portable:
// it compares the card against `upstream().combatStats.computeCombatStats`. Its role is covered by the frozen per-blow
// vectors (`tests/model_blow.rs`), which were generated from that same oracle. Listed as lost in PORTED-TESTS.md.

/// The legal level-45 long blade (`maxCharacter(123)`).
fn geared() -> Value {
    let book = book();
    let mut profiles = dfo_core::maxprofile::Profiles::new(&book);
    profiles
        .max_character(&n(123.0), &obj([]))
        .expect("the legal max profile")
}
