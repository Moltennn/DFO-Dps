//! Ported from `test/model.test.js` and `test/classicStrength.test.js`: the card's known values.
//!
//! LOCAL INVARIANTS on known numbers (the JS files pin the same values). The per-blow differential suite and the frozen
//! vectors are what prove the port; these keep the named assertions alive without Node.

mod ported_common;

use dfo_core::damage::{damage_modifier, pcaao_damage_modifier};
use dfo_core::model_blow::{cadence, expected_capped, weapon_of};
use dfo_core::swing::swing_frame_seconds;
use ported_common::*;

fn save_character() -> Value {
    Desc::new()
        .level(5.0)
        .stat("strength", 80.0)
        .skills(40.0)
        .sim(Some(weapon(120.0, 1.0, 1.0)))
}

#[test]
fn strength_terms_are_classic_over_five_and_overhaul_over_ten() {
    assert_eq!(damage_modifier(80.0), 6.0);
    assert_eq!(damage_modifier(50.0), 0.0);
    assert_eq!(damage_modifier(40.0), -2.0);
    assert_eq!(pcaao_damage_modifier(80.0), 3.0);
    assert_eq!(pcaao_damage_modifier(75.0), 2.0);
}

#[test]
fn classic_longsword_str_80_is_over_ten_live_and_over_five_uninstalled() {
    let ch = save_character();
    let live = analyze(
        &ch,
        &obj([
            ("target", reference_foe(5.0, "soft")),
            ("core", s("classic")),
            ("critDamage", b(false)),
            ("swing", s("StrikeLeft")),
        ]),
    );
    let dmg = &live.damage;
    assert_eq!(f(dmg.get("min")), 2.0 + 3.0, "2 + floor((80-50)/10)");
    assert_eq!(f(dmg.get("max")), 16.0 + 3.0);
    assert_eq!(f(dmg.get("parts").get("matMod")), 0.0, "steel");
    assert_eq!(f(dmg.get("parts").get("strMod")), 3.0);

    let stock = analyze(
        &ch,
        &obj([
            ("target", reference_foe(5.0, "soft")),
            ("core", s("classic")),
            ("critDamage", b(false)),
            ("fixedStrengthDamageModifier", b(false)),
            ("swing", s("StrikeLeft")),
        ]),
    );
    assert_eq!(f(stock.damage.get("min")), 8.0, "2 + floor((80-50)/5)");
    assert_eq!(f(stock.damage.get("max")), 22.0);
    assert_eq!(f(stock.damage.get("parts").get("strMod")), 6.0);
}

#[test]
fn overhaul_longsword_strength_is_over_ten_and_two_handed_doubles_it() {
    let ch = save_character();
    let one = analyze(
        &ch,
        &obj([
            ("target", reference_foe(5.0, "soft")),
            ("core", s("overhaul")),
        ]),
    );
    assert_eq!(f(one.damage.get("parts").get("strMod")), 3.0);
    let claymore = weapon_of(&weapon(122.0, 1.0, 1.0), false);
    let two = analyze(
        &ch,
        &obj([
            ("target", reference_foe(5.0, "soft")),
            ("core", s("overhaul")),
            ("weapon", claymore),
        ]),
    );
    assert_eq!(f(two.damage.get("parts").get("strMod")), 6.0);
}

#[test]
fn the_source_stats_card_fixture_is_str_66_steel_longsword_in_the_overhaul() {
    let ch = Desc::new()
        .level(5.0)
        .stat("strength", 66.0)
        .stat("agility", 58.0)
        .stat("speed", 54.0)
        .stat("luck", 47.0)
        .skills(40.0)
        .skill(29, 55.0)
        .skill(34, 36.0)
        .skill(20, 12.0)
        .sim(Some(weapon(120.0, 1.0, 1.0)));
    let r = analyze(
        &ch,
        &obj([
            ("target", reference_foe(5.0, "tough")),
            ("core", s("overhaul")),
            ("swing", s("StrikeLeft")),
            ("gameBuild", s("14512")),
        ]),
    );
    assert_eq!(f(r.damage.get("parts").get("strMod")), 1.0);
    assert_eq!(f(r.damage.get("min")), 3.0);
    assert_eq!(f(r.damage.get("max")), 17.0);
    let hit = f(r.hit.get("hit"));
    assert!(hit > 0.03 && hit < 0.97);
    assert_eq!(f(r.hit.get("crit").get("skill")), 36.0);
}

#[test]
fn swing_cadence_speed_50_is_one_second_and_speed_100_about_0_6s() {
    let at50 = swing_frame_seconds(Some(50.0), None, None);
    let at100 = swing_frame_seconds(Some(100.0), None, None);
    let at20 = swing_frame_seconds(Some(20.0), None, None);
    assert!(near_eps(at50, 0.1989795918367347, 1e-12));
    assert!(near_eps(5.0 * at50, 0.9948979591836735, 1e-12));
    assert!(near_eps(5.0 * at100, 0.5969387755102041, 1e-12));
    assert!(at20 > at50);
    assert!(near_eps(
        swing_frame_seconds(Some(0.0), None, None),
        0.2785714285714286,
        1e-12
    ));
}

#[test]
fn cadence_reads_weapon_weight_and_handling() {
    let ch = save_character();
    let katana = weapon_of(&weapon(121.0, 9.0, 1.0), false);
    let claymore = weapon_of(&weapon(122.0, 9.0, 1.0), false);
    let a = cadence(&ch, &katana, &obj([]));
    let b = cadence(&ch, &claymore, &obj([]));
    assert!(f(b.get("seconds")) > f(a.get("seconds")));
    assert_eq!(f(a.get("handling")), 1.0);
    assert_eq!(f(b.get("handling")), 1.06);
}

#[test]
fn reference_foes_armour_is_five_times_and_class_foes_flat_sixty() {
    assert_eq!(
        f(reference_foe(10.0, "soft").get("armorValues").at(0)),
        30.0
    );
    assert_eq!(
        f(reference_foe(10.0, "armoured").get("armorValues").at(0)),
        -50.0
    );
    assert_eq!(
        f(reference_foe(10.0, "human").get("armorValues").at(0)),
        60.0
    );
    assert!(reference_foe(10.0, "human").get("isClass").truthy());
    assert_eq!(f(reference_foe(10.0, "soft").get("skills").get("20")), 80.0);
    assert_eq!(
        f(reference_foe(30.0, "soft").get("skills").get("20")),
        100.0
    );
}

#[test]
fn curbing_is_the_uniform_mean_of_min_max_clipped_at_the_cap() {
    assert_eq!(expected_capped(10.0, 20.0, 100.0), 15.0);
    assert_eq!(expected_capped(10.0, 20.0, 5.0), 5.0);
    assert_eq!(
        expected_capped(10.0, 20.0, 15.0),
        (10.0 + 11.0 + 12.0 + 13.0 + 14.0 + 15.0 * 6.0) / 11.0
    );
}

#[test]
fn effective_skill_milestones_are_100_108_140() {
    assert_eq!(dfo_core::save::effective_skill(&n(100.0)), 100.0);
    assert_eq!(dfo_core::save::effective_skill(&n(125.0)), 108.0);
    assert_eq!(dfo_core::save::effective_skill(&n(200.0)), 140.0);
}

#[test]
fn online_mastery_a_mastered_long_blade_at_107_plus_20_gear_skill() {
    let mut ch = Desc::new()
        .level(5.0)
        .skill(29, 107.0)
        .mastered(&[29.0])
        .master_skills(true)
        .online(true)
        .sim(Some(weapon(120.0, 1.0, 1.0)));
    ch.set(
        "_mods",
        obj([("skills", obj([("29", n(20.0))])), ("stats", Obj(vec![]))]),
    );
    let r = analyze(
        &ch,
        &obj([
            ("target", reference_foe(5.0, "tough")),
            ("core", s("overhaul")),
            ("swing", s("StrikeLeft")),
            ("gameBuild", s("14512")),
        ]),
    );
    assert!(near_eps(
        f(r.damage.get("parts").get("mastery")),
        9.8,
        0.001
    ));
    let mut off = Desc::new()
        .level(5.0)
        .skill(29, 107.0)
        .mastered(&[29.0])
        .master_skills(true)
        .online(false)
        .sim(Some(weapon(120.0, 1.0, 1.0)));
    off.set("_mods", obj([("skills", obj([("29", n(20.0))]))]));
    let ro = analyze(
        &off,
        &obj([
            ("target", reference_foe(5.0, "tough")),
            ("core", s("overhaul")),
            ("gameBuild", s("14512")),
        ]),
    );
    assert_eq!(f(ro.damage.get("parts").get("mastery")), 0.0);
}

#[test]
fn the_curbing_cap_only_binds_below_20x_the_per_hit() {
    let ch = save_character();
    let small_target = dfo_core::analyze::boss_target(&obj([
        ("level", n(5.0)),
        ("health", n(200.0)),
        ("traits", arr(vec![s("curbing")])),
    ]))
    .expect("a curbing boss");
    let small = analyze(
        &ch,
        &obj([
            ("target", small_target),
            ("traits", arr(vec![s("curbing")])),
            ("health", n(200.0)),
        ]),
    );
    assert_eq!(small.cap, 10.0);
    assert!(small.capped_dps < small.dps);
    assert!(small.cap_loss > 0.0);
    let large_target = dfo_core::analyze::boss_target(&obj([
        ("level", n(5.0)),
        ("health", n(2500.0)),
        ("traits", arr(vec![s("curbing")])),
    ]))
    .expect("a curbing boss");
    let large = analyze(
        &ch,
        &obj([
            ("target", large_target),
            ("traits", arr(vec![s("curbing")])),
            ("health", n(2500.0)),
        ]),
    );
    assert_eq!(large.cap, 125.0);
    assert!(near_eps(large.capped_dps, large.dps, 1e-9));
    assert_eq!(large.cap_loss, 0.0);
}

#[test]
fn a_live_equip_table_is_the_authority_over_saved_items_and_the_mods_cache() {
    let mut it = weapon(121.0, 9.0, 1.0);
    it.set("minDamage", n(1.0));
    it.set("maxDamage", n(16.0));
    it.set("name", s("Katana of the Cat"));
    let save = obj([
        ("level", n(10.0)),
        ("stats", obj(STAT_KEYS.map(|k| (k, n(50.0))))),
        ("skills", nums(vec![40.0; 35])),
        (
            "equipSlots",
            obj([
                ("19", it),
                (
                    "6",
                    obj([
                        ("group", s("Jewellery")),
                        ("name", s("Bracelet of Practice")),
                        (
                            "affixes",
                            arr(vec![obj([
                                ("id", s("skill")),
                                ("param", n(29.0)),
                                ("value", n(10.0)),
                            ])]),
                        ),
                    ]),
                ),
            ]),
        ),
        (
            "_mods",
            obj([("stats", Obj(vec![])), ("skills", obj([("29", n(999.0))]))]),
        ),
        ("_enchantMods", obj([("skillMods", Obj(vec![]))])),
    ]);
    let ch = dfo_core::save::character_from_save(&save, &obj([("online", b(true))]));
    assert_eq!(f(ch.get("_mods").get("skills").get("29")), 10.0);
    assert_eq!(f(ch.get("weapon").get("minDamage")), 1.0);
    assert_eq!(f(ch.get("weapon").get("maxDamage")), 16.0);
}

#[test]
fn the_real_gate_boss_is_8400_hp_plate_60_cap_420_and_two_3s_shields_at_level_30() {
    let t = gate_target(30.0);
    assert_eq!(f(t.get("maxHealth")), 8400.0);
    assert_eq!(f(t.get("armorValues").at(0)), 60.0);
    assert_eq!(f(t.get("hitCap")), 420.0);
    assert_eq!(f(t.get("phaseShields")), 2.0);
    assert_eq!(f(t.get("shieldSeconds")), 3.0);
    let ch = save_character();
    let r = analyze(
        &ch,
        &obj([
            ("target", t.clone()),
            ("health", n(8400.0)),
            ("traits", arr(vec![])),
        ]),
    );
    assert_eq!(r.cap, 420.0);
    assert!(r.cap_source.is_str("hit cap"));
    assert!(r.ttk.expect("a kill") > 8400.0 / r.capped_dps);
}

#[test]
fn backstab_is_99_percent_times_three_and_the_gate_group_health_scales() {
    let ch = Desc::new()
        .level(5.0)
        .stat("strength", 80.0)
        .skills(40.0)
        .skill(19, 99.0)
        .sim(Some(weapon(120.0, 1.0, 1.0)));
    let base = analyze(
        &ch,
        &obj([
            ("target", reference_foe(5.0, "soft")),
            ("core", s("overhaul")),
            ("swing", s("StrikeLeft")),
        ]),
    );
    let behind = analyze(
        &ch,
        &obj([
            ("target", reference_foe(5.0, "soft")),
            ("core", s("overhaul")),
            ("backstabUptime", n(1.0)),
            ("swing", s("StrikeLeft")),
        ]),
    );
    assert!(behind.backstab.chance > 0.98);
    assert_eq!(behind.backstab.multiplier, 3.0);
    assert!((behind.backstab.crit_min - base.damage.get("critMin").to_number() * 3.0).abs() <= 1.0);
    assert!(behind.dps > base.dps * 2.8);
    let grouped = dfo_core::analyze::gate_target(&n(30.0), &obj([("players", n(4.0))]));
    assert_eq!(f(grouped.get("maxHealth")), 33600.0);
}

#[test]
fn dps_carries_a_min_avg_max_range_and_the_average_sits_inside_it() {
    let ch = Desc::new()
        .level(5.0)
        .stat("strength", 80.0)
        .skills(40.0)
        .online(true)
        .sim(Some(weapon(120.0, 1.0, 1.0)));
    let r = analyze(
        &ch,
        &obj([
            ("target", reference_foe(5.0, "soft")),
            ("core", s("overhaul")),
        ]),
    );
    assert!(r.dps_min <= r.dps && r.dps <= r.dps_max);
    assert!(r.capped_dps_min <= r.capped_dps && r.capped_dps <= r.capped_dps_max);
    let (lo, hi) = (
        r.total_dps_min.expect("a range"),
        r.total_dps_max.expect("a range"),
    );
    assert!(lo <= r.total_dps.expect("a total") && r.total_dps.expect("a total") <= hi);
}

// ── classicStrength.test.js ─────────────────────────────────────

fn classic_character(strength: f64, extra_skills: &[(usize, f64)]) -> Desc {
    let mut d = Desc::new()
        .level(30.0)
        .race(1.0)
        .stat("strength", strength)
        .stat("agility", 70.0)
        .stat("speed", 90.0)
        .stat("luck", 60.0)
        .stat("endurance", 75.0)
        .stat("willpower", 50.0)
        .skills(50.0)
        .skill(29, 80.0)
        .skill(34, 40.0)
        .skill(19, 0.0);
    for (id, v) in extra_skills {
        d = d.skill(*id, *v);
    }
    d
}

#[test]
fn classic_live_over_ten_and_uninstalled_stock_over_five_in_the_whole_blow() {
    let ch = classic_character(80.0, &[]).sim(Some(weapon(120.0, 1.0, 1.0)));
    let live = analyze(
        &ch,
        &obj([
            ("target", reference_foe(30.0, "tough")),
            ("core", s("classic")),
            ("critDamage", b(false)),
            ("swing", s("StrikeLeft")),
        ]),
    );
    let stock = analyze(
        &ch,
        &obj([
            ("target", reference_foe(30.0, "tough")),
            ("core", s("classic")),
            ("critDamage", b(false)),
            ("fixedStrengthDamageModifier", b(false)),
            ("swing", s("StrikeLeft")),
        ]),
    );
    assert_eq!(f(live.damage.get("parts").get("strMod")), 3.0);
    assert_eq!(f(stock.damage.get("parts").get("strMod")), 6.0);
    assert_eq!(f(live.damage.get("min")), 5.0);
    assert_eq!(f(live.damage.get("max")), 19.0);
    assert_eq!(f(stock.damage.get("min")), 8.0);
    assert_eq!(f(stock.damage.get("max")), 22.0);
}

#[test]
fn classic_option_never_touches_the_overhaul_strength_path() {
    let ch = classic_character(80.0, &[]).sim(Some(weapon(120.0, 1.0, 1.0)));
    let live = analyze(
        &ch,
        &obj([
            ("target", reference_foe(30.0, "tough")),
            ("core", s("overhaul")),
            ("swing", s("StrikeLeft")),
        ]),
    );
    let stock = analyze(
        &ch,
        &obj([
            ("target", reference_foe(30.0, "tough")),
            ("core", s("overhaul")),
            ("fixedStrengthDamageModifier", b(false)),
            ("swing", s("StrikeLeft")),
        ]),
    );
    assert_eq!(f(live.damage.get("parts").get("strMod")), 3.0);
    assert_eq!(f(stock.damage.get("parts").get("strMod")), 3.0);
    let claymore = weapon_of(&weapon(122.0, 1.0, 1.0), false);
    let two = analyze(
        &ch,
        &obj([
            ("target", reference_foe(30.0, "tough")),
            ("core", s("overhaul")),
            ("weapon", claymore),
            ("swing", s("StrikeLeft")),
        ]),
    );
    assert_eq!(f(two.damage.get("parts").get("strMod")), 6.0);
}
