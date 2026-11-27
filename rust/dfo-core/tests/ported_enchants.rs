//! Ported from `test/enchants.test.js` and `test/realBuild.test.js`: the enchantment channels and the real-loadout
//! universe, as local invariants.
//!
//! LOCAL INVARIANTS. `tests/imprints.rs`, `tests/planner_mutants.rs` and `tests/real_build.rs` hold the parity vectors;
//! these keep the named assertions. The Cast When Strikes pricing cases need a spell record in the book, which the
//! synthetic spellbook supplies at run time — those are covered by the CWS vectors (`tests/cws.rs`) instead.

mod ported_common;

use dfo_core::save::rebuild_enchant_mods;
use ported_common::*;

#[test]
fn enhances_skill_is_fifteen_per_row_on_top_of_the_softcap() {
    let items = arr(vec![obj([(
        "enchantments",
        arr(vec![
            obj([("type", n(10.0)), ("param", n(29.0))]),
            obj([("type", n(10.0)), ("param", n(29.0))]),
        ]),
    )])]);
    let mods = rebuild_enchant_mods(&items);
    assert_eq!(f(mods.get("skillMods").get("29")), 30.0);
}

#[test]
fn potent_vs_is_a_flat_five_on_the_matching_affinity_only() {
    // `strikesNet` reads the body's affinity: mobile type 31 is a Daedra row, 32 an Undead one.
    let mut item = weapon(120.0, 9.0, 1.0);
    item.set(
        "enchantments",
        arr(vec![obj([("type", n(4.0)), ("param", n(1.0))])]),
    );
    let net = |mobile: f64| {
        dfo_core::model_blow::strikes_net(
            &item,
            Some(&dfo_core::target::Target {
                mobile_type: Some(mobile),
                ..Default::default()
            }),
        )
    };
    assert_eq!(net(31.0), 5.0, "a Daedra body");
    assert_eq!(net(32.0), 0.0, "an Undead body");
}

#[test]
fn a_weapon_with_no_enchantments_adds_nothing() {
    let mut item = weapon(120.0, 9.0, 1.0);
    item.set("enchantments", arr(vec![]));
    let ch = Desc::new().level(45.0).skills(100.0).sim(Some(item));
    let mut boss =
        dfo_core::analyze::boss_target(&obj([("level", n(45.0)), ("health", n(12000.0))]))
            .expect("a boss");
    boss.set("traits", arr(vec![]));
    let card = analyze(
        &ch,
        &obj([
            ("target", boss),
            ("health", n(12000.0)),
            ("core", s("overhaul")),
            ("rri", b(true)),
        ]),
    );
    assert_eq!(card.enchant_dps, 0.0);
    assert_eq!(card.total_dps, Some(card.dps));
}

// ── realBuild.test.js ─────────────────────────────────────────────

#[test]
fn real_loadouts_cover_every_family_in_both_modes() {
    let rows = dfo_core::real_build::real_weapon_loadouts(
        &["uncapped".to_owned(), "cap".to_owned()],
        false,
        "breach",
        "14512",
        &book(),
    )
    .expect("the loadout universe");
    assert!(rows.len() >= 30, "only {} rows", rows.len());
    for mode in ["uncapped", "cap"] {
        let families: std::collections::BTreeSet<String> = rows
            .iter()
            .filter(|r| r.get("mode").is_str(mode))
            .map(|r| r.get("family").to_js_string())
            .collect();
        assert_eq!(families.len(), 6, "{mode}: {families:?}");
    }
}

#[test]
fn the_tree_is_real_the_chain_is_ordered_and_the_cap_never_beats_the_uncapped() {
    let rows = dfo_core::real_build::real_weapon_loadouts(
        &["uncapped".to_owned(), "cap".to_owned()],
        false,
        "breach",
        "14512",
        &book(),
    )
    .expect("the loadout universe");
    for r in &rows {
        let stars = f(r.get("treeStars"));
        assert!(
            stars > 0.0 && stars <= 98.0,
            "{}",
            r.get("family").to_js_string()
        );
        assert_eq!(f(r.get("freeStars")), 98.0 - stars);
        assert!(f(r.get("treeDps")) > 0.0);
        assert!(f(r.get("enchDps")) >= f(r.get("treeDps")));
        assert!(f(r.get("totalDps")) >= f(r.get("enchDps")) - 1e-9);
    }
    let families: std::collections::BTreeSet<String> = rows
        .iter()
        .map(|r| r.get("family").to_js_string())
        .collect();
    for family in families {
        let best = |mode: &str| {
            rows.iter()
                .filter(|r| r.get("family").is_str(&family) && r.get("mode").is_str(mode))
                .map(|r| f(r.get("totalDps")))
                .fold(f64::NEG_INFINITY, f64::max)
        };
        assert!(best("cap") <= best("uncapped") + 1e-9, "{family}");
    }
}

#[test]
fn every_loadout_carries_an_imprint_and_no_monster_type_damage_power() {
    let rows = dfo_core::real_build::real_weapon_loadouts(
        &["cap".to_owned()],
        false,
        "breach",
        "14512",
        &book(),
    )
    .expect("the loadout universe");
    assert!(rows.len() >= 15, "only {} rows", rows.len());
    let forbidden = ["Dragonsbane", "Sanctified", "Hunter's Moon"];
    for r in &rows {
        let power = r.get("imprintPower").to_js_string();
        assert!(!power.is_empty(), "every loadout carries an imprint");
        assert!(!forbidden.contains(&power.as_str()), "{power}");
    }
    let long: Vec<&Value> = rows
        .iter()
        .filter(|r| r.get("family").is_str("LongBlade") || r.get("family").is_str("Long Blade"))
        .collect();
    if !long.is_empty() {
        let cats: std::collections::BTreeSet<String> = long
            .iter()
            .map(|r| r.get("category").to_js_string())
            .collect();
        for want in ["1H", "2H", "DW"] {
            assert!(cats.contains(want), "long blade {want}: {cats:?}");
        }
        assert!(long
            .iter()
            .any(|r| r.get("imprintPower").is_str("Many Endings")));
    }
}
