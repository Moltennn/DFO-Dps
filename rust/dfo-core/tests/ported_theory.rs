//! Ported from `test/theory.test.js`, `test/sockets.test.js` and `test/spells.test.js`: the theory character, its gear
//! budgets, the socket law and the spell card.
//!
//! LOCAL INVARIANTS on known values. `tests/theory.rs` holds the parity vectors; these keep the named assertions.

mod ported_common;

use dfo_core::sockets::{perfect_sockets, socket_affixes, socket_count};
use dfo_core::spells::{
    analyze_spell, effect_school, spell_cost, spell_damage, spell_rotation, Mode,
};
use dfo_core::theory::{
    theory_blade, theory_character, theory_fists, GEAR_CS_LINES, GEAR_LB_LINES, GEAR_SKILL_LINES,
    LONG_BLADES,
};
use ported_common::*;

#[test]
fn the_theory_character_is_level_45_at_the_live_stat_and_skill_ceilings() {
    let ch = theory_character(&obj([])).expect("the default theory character");
    assert_eq!(f(ch.get("level")), 45.0);
    assert_eq!(f(ch.get("weapon").get("templateIndex")), 123.0);
    assert_eq!(ch.get("weapon").get("name"), &s("Dai-katana"));
    assert_eq!(f(ch.get("stats").get("strength")), 100.0);
    assert_eq!(f(ch.get("stats").get("speed")), 100.0);
    for id in [29usize, 34, 19] {
        assert_eq!(f(ch.get("skills").at(id)), 200.0);
    }
    let mastered: Vec<f64> = ch.get("masteredSkills").items().iter().map(f).collect();
    for id in [29.0, 34.0, 19.0] {
        assert!(mastered.contains(&id), "mastered {id}");
    }
}

#[test]
fn at_raw_200_and_no_gear_the_parts_are_the_js_numbers() {
    let ch = theory_character(&obj([])).expect("the default theory character");
    let r = analyze(
        &ch,
        &obj([
            ("target", gate_target(45.0)),
            ("core", s("overhaul")),
            ("rri", b(true)),
            ("gameBuild", s("14512")),
        ]),
    );
    let parts = &r.damage.get("parts");
    assert_eq!(f(parts.get("strMod")), 10.0);
    assert_eq!(f(parts.get("matMod")), 6.0);
    assert_eq!(f(parts.get("prof")), 9.0);
    assert_eq!(f(parts.get("racial")), 8.0);
    assert_eq!(f(parts.get("mastery")), 40.0);
    assert!(near_eps(f(r.hit.get("crit").get("chance")), 0.7, 1e-9));
    assert!(near_eps(f(r.hit.get("crit").get("damageMult")), 2.4, 1e-5));
    assert_eq!(r.cap, 600.0);
}

#[test]
fn the_rolled_line_slot_counts_are_not_a_point_budget_and_the_legal_max_is_535() {
    assert_eq!(GEAR_LB_LINES, 8.0);
    assert_eq!(GEAR_CS_LINES, 18.0);
    assert_eq!(GEAR_SKILL_LINES, 26.0);
    assert_eq!(
        dfo_core::gear_profile::max_single_skill(&obj([("weaponTemplate", n(123.0))])),
        535.0
    );
    assert_eq!(
        dfo_core::gear_profile::max_single_skill(&obj([
            ("weaponTemplate", n(123.0)),
            ("skill", n(34.0)),
        ])),
        535.0
    );
    let frontier = dfo_core::gear_profile::legal_totals(&obj([("weaponTemplate", n(123.0))]));
    let rows = frontier.items();
    assert!(
        !rows
            .iter()
            .any(|p| f(p.get("lb")) >= 240.0 && f(p.get("cs")) >= 540.0),
        "the old 240/540 profile is not on the frontier"
    );
    assert!(
        !rows.iter().any(|p| f(p.get("cs")) > 535.0),
        "Critical Strike cannot pass 535"
    );

    let book = book();
    let mut profiles = dfo_core::maxprofile::Profiles::new(&book);
    let g = profiles
        .legal_gear(&n(123.0), &obj([("gameBuild", s("14512"))]))
        .expect("the legal gear point");
    assert_eq!(
        [f(g.get("lb")), f(g.get("cs")), f(g.get("dmg"))],
        [250.0, 370.0, 25.0]
    );
    assert_eq!(g.get("violations").items().len(), 0);
    let ch = theory_character(&obj([
        ("gearLB", n(250.0)),
        ("gearCS", n(370.0)),
        ("damagePct", n(25.0)),
    ]))
    .expect("the geared theory character");
    let r = analyze(
        &ch,
        &obj([
            ("target", gate_target(45.0)),
            ("core", s("overhaul")),
            ("rri", b(true)),
            ("gameBuild", s("14512")),
        ]),
    );
    assert!(near(f(r.damage.get("parts").get("mastery")), 150.0));
    assert_eq!(f(r.hit.get("crit").get("chance")), 1.0);
    assert!(r.dps > r.capped_dps);
    assert!(r.capped_dps > 775.0 && r.capped_dps < 805.0);
}

#[test]
fn a_different_long_blade_keeps_the_damage_affix_and_changes_the_template() {
    let ch = theory_character(&obj([("damagePct", n(38.0))])).expect("the theory character");
    for idx in LONG_BLADES {
        let c = theory_blade(&ch, &n(*idx), &n(9.0)).expect("a long blade");
        assert_eq!(f(c.get("weapon").get("templateIndex")), *idx);
        let affix = c
            .get("weapon")
            .get("affixes")
            .items()
            .iter()
            .find(|a| a.get("id").is_str("damage"))
            .expect("the damage affix");
        assert_eq!(f(affix.get("value")), 38.0);
    }
}

#[test]
fn socket_counts_follow_the_weapon_size() {
    assert_eq!(socket_count(&n(116.0)), 1.0, "Shortsword");
    assert_eq!(socket_count(&n(120.0)), 2.0, "Longsword");
    assert_eq!(socket_count(&n(123.0)), 3.0, "Dai-katana");
    assert_eq!(socket_count(&n(563.0)), 2.0, "Hand Wraps");
}

#[test]
fn perfect_diamond_sockets_are_twelve_percent_each_but_read_at_the_rare_band_top() {
    let ch = theory_character(&obj([
        ("damagePct", n(40.0)),
        ("sockets", arr(perfect_sockets(&n(123.0)))),
    ]))
    .expect("the socketed character");
    let w = dfo_core::model_blow::weapon_of(ch.get("weapon"), false);
    // Three perfect diamonds are 36 as lines, but a piece's gems read at most the top of the damage Rare band together
    // (lootRarity.js:2151-2165 readLines, law 6): 12 + 12 + 1 = 25. The piece's own 40 reads whole.
    assert_eq!(f(w.get("damagePct")), 40.0 + 25.0);
    let affixes = socket_affixes(ch.get("weapon"));
    assert_eq!(affixes.len(), 3);
    assert_eq!(f(affixes[0].get("value")), 12.0);
}

#[test]
fn hand_wraps_carry_damage_and_sockets_onto_the_fist_blow_and_are_one_handed() {
    let bare = theory_fists(&obj([("gearH2H", n(510.0)), ("gearCrit", n(540.0))]));
    let wrapped = theory_fists(&obj([
        ("gearH2H", n(510.0)),
        ("gearCrit", n(540.0)),
        ("wraps", b(true)),
    ]));
    let target = reference_foe(45.0, "tough");
    let a = analyze(
        &bare,
        &obj([
            ("target", target.clone()),
            ("core", s("overhaul")),
            ("rri", b(true)),
        ]),
    );
    let b = analyze(
        &wrapped,
        &obj([
            ("target", target),
            ("core", s("overhaul")),
            ("rri", b(true)),
        ]),
    );
    assert!(wrapped.get("wraps").truthy());
    let (ta, tb) = (a.total_dps.expect("a total"), b.total_dps.expect("a total"));
    assert!(tb > ta);
    assert!(f(b.damage.get("avg")) > f(a.damage.get("avg")));
    let wraps = dfo_core::model_blow::weapon_of(wrapped.get("wraps"), false);
    assert!(!wraps.get("twoHanded").truthy());
    assert_eq!(socket_count(&n(563.0)), 2.0);
    assert!(!dfo_core::generated::data::WEAPONS
        .iter()
        .find(|w| w.0 == 127)
        .map(|w| w.1.two_handed)
        .unwrap_or(true));
    assert!(dfo_core::generated::data::WEAPONS
        .iter()
        .find(|w| w.0 == 128)
        .map(|w| w.1.two_handed)
        .unwrap_or(false));
}

#[test]
fn dual_wield_strikes_with_the_off_hand_and_two_handed_weapons_never_pair() {
    let mut ch = theory_character(&obj([
        ("blade", n(121.0)),
        ("gearLB", n(240.0)),
        ("gearCS", n(540.0)),
        ("damagePct", n(40.0)),
        ("sockets", arr(perfect_sockets(&n(121.0)))),
    ]))
    .expect("the dual character");
    let off = {
        let mut o = ch.get("weapon").clone();
        o.set("equipSlot", n(21.0));
        o
    };
    ch.set("offWeapon", off);
    let target = reference_foe(45.0, "tough");
    let single = analyze(
        &ch,
        &obj([
            ("target", target.clone()),
            ("core", s("overhaul")),
            ("rri", b(true)),
        ]),
    );
    let dual = analyze(
        &ch,
        &obj([
            ("target", target),
            ("core", s("overhaul")),
            ("rri", b(true)),
            ("dual", b(true)),
        ]),
    );
    assert!(matches!(dual.hands, dfo_core::analyze::Hands::Dual { .. }));
    assert!(dual.dps > single.dps);
    assert!(dual.dps < single.dps * 2.0);

    // A two-handed main hand is not dual-wielded.
    let mut two = theory_character(&obj([("blade", n(123.0))])).expect("the dai-katana");
    let off = {
        let mut o = two.get("weapon").clone();
        o.set("equipSlot", n(21.0));
        o
    };
    two.set("offWeapon", off);
    let r = analyze(
        &two,
        &obj([
            ("target", reference_foe(45.0, "tough")),
            ("core", s("overhaul")),
            ("rri", b(true)),
            ("dual", b(true)),
        ]),
    );
    assert!(!matches!(r.hands, dfo_core::analyze::Hands::Dual { .. }));
}

// ── spells.test.js ────────────────────────────────────────────────

fn mage() -> Value {
    let mut ch = theory_character(&obj([])).expect("the theory character");
    ch.set("maxMagicka", n(300.0));
    ch.set("magicka", n(300.0));
    ch
}

fn effect_base() -> Value {
    obj([
        ("type", n(4.0)),
        ("subType", n(0.0)),
        ("durationBase", n(0.0)),
        ("durationMod", n(0.0)),
        ("durationPerLevel", n(0.0)),
        ("chanceBase", n(0.0)),
        ("chanceMod", n(0.0)),
        ("chancePerLevel", n(0.0)),
        ("magnitudeBaseLow", n(20.0)),
        ("magnitudeBaseHigh", n(20.0)),
        ("magnitudeLevelBase", n(0.0)),
        ("magnitudeLevelHigh", n(0.0)),
        ("magnitudePerLevel", n(1.0)),
    ])
}

fn bolt() -> Value {
    obj([
        ("name", s("Test Bolt")),
        ("element", n(0.0)),
        ("rangeType", n(0.0)),
        ("cost", n(100.0)),
        ("effects", arr(vec![effect_base()])),
    ])
}

#[test]
fn a_damage_spell_prices_and_lands_with_the_live_school_and_saving_throw() {
    let ch = mage();
    let sp = bolt();
    let target = reference_foe(45.0, "tough");
    let dmg = spell_damage(&sp, &ch, &target, &obj([]), Mode::Avg);
    assert_eq!(effect_school(sp.get("effects").at(0)), 22.0);
    assert_eq!(f(dmg.get("school")), 22.0);
    assert!(f(dmg.get("damage")) > 0.0);
    let saving = f(dmg.get("saving"));
    assert!(saving > 0.0 && saving < 1.0);
    assert!(spell_cost(&sp, &ch, false) >= 5.0);
}

#[test]
fn a_continuous_damage_spell_adds_its_rounds() {
    let ch = mage();
    let dot = obj([
        ("name", s("Test DoT")),
        ("element", n(0.0)),
        ("rangeType", n(0.0)),
        ("cost", n(100.0)),
        (
            "effects",
            arr(vec![obj([
                ("type", n(1.0)),
                ("subType", n(0.0)),
                ("durationBase", n(10.0)),
                ("durationMod", n(0.0)),
                ("durationPerLevel", n(1.0)),
                ("chanceBase", n(0.0)),
                ("chanceMod", n(0.0)),
                ("chancePerLevel", n(0.0)),
                ("magnitudeBaseLow", n(5.0)),
                ("magnitudeBaseHigh", n(5.0)),
                ("magnitudeLevelBase", n(0.0)),
                ("magnitudeLevelHigh", n(0.0)),
                ("magnitudePerLevel", n(1.0)),
            ])]),
        ),
    ]);
    let r = spell_damage(
        &dot,
        &ch,
        &reference_foe(45.0, "tough"),
        &obj([]),
        Mode::Avg,
    );
    let damage = f(r.get("damage"));
    assert!(damage > 5.0 * 10.0 * 0.5, "{damage}");
}

#[test]
fn the_spell_card_exposes_cost_cast_time_dps_and_pool_sustain() {
    let ch = mage();
    let card = analyze_spell(
        &bolt(),
        &ch,
        &reference_foe(45.0, "tough"),
        &obj([
            ("health", n(12000.0)),
            ("potencyPct", n(30.0)),
            ("pierce", n(10.0)),
            ("castSpeedPct", n(20.0)),
        ]),
    );
    assert!(f(card.get("dps")) > 0.0);
    let cast = f(card.get("castSeconds"));
    assert!(cast > 0.0 && cast < 1.0);
    assert!(f(card.get("castsPerPool")) > 0.0);
    assert!(near(
        f(card.get("poolDamage")),
        f(card.get("damage")) * f(card.get("castsPerPool"))
    ));
    assert!(f(card.get("ttk")) > 0.0);
}

#[test]
fn a_spell_rotation_carries_min_avg_max_dps() {
    let ch = mage();
    let r = spell_rotation(
        &bolt(),
        &ch,
        &reference_foe(45.0, "tough"),
        &obj([("seconds", n(30.0)), ("health", n(12000.0))]),
    );
    let (lo, mid, hi) = (
        f(r.get("windowDpsMin")),
        f(r.get("windowDps")),
        f(r.get("windowDpsMax")),
    );
    assert!(lo <= mid && mid <= hi, "{lo} {mid} {hi}");
    let (mlo, mmid, mhi) = (
        f(r.get("manaDpsMin")),
        f(r.get("manaDps")),
        f(r.get("manaDpsMax")),
    );
    assert!(mlo <= mmid && mmid <= mhi);
}
