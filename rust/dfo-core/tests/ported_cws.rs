//! Ported from `test/cws.test.js`: ordinary-enemy Cast When Strikes, as known values.
//!
//! LOCAL INVARIANTS (the JS file says so itself: "These tests do not use the oracle"). The row order, the Strikes gate,
//! the (4,0)-only direct family, the per-effect absorption/reflection/resistance gates, and the fight loop's event
//! order are pinned here on the port's own API.

mod ported_common;

use dfo_core::cws::{
    cws_eligible, cws_rows, is_continuous_damage, is_damage_health, resolve_cws_cast, Cast, Caster,
};
use dfo_core::rolls::Rolls;
use dfo_core::simulate_fight::{simulate_fight_cached, FightRolls};
use dfo_core::spells::{spells_by_index_map, Spellbook};
use ported_common::*;

fn effect(type_: f64, sub_type: f64, magnitude: f64) -> Value {
    obj([
        ("type", n(type_)),
        ("subType", n(sub_type)),
        ("magnitudeBaseLow", n(magnitude)),
        ("magnitudeBaseHigh", n(magnitude)),
        ("magnitudeLevelBase", n(0.0)),
        ("magnitudeLevelHigh", n(0.0)),
        ("magnitudePerLevel", n(1.0)),
        ("durationBase", n(0.0)),
        ("durationMod", n(0.0)),
        ("durationPerLevel", n(1.0)),
        ("chanceBase", n(0.0)),
        ("chanceMod", n(0.0)),
        ("chancePerLevel", n(1.0)),
    ])
}

fn spell_of(effects: Vec<Value>, index: f64, name: &str) -> Value {
    obj([
        ("name", s(name)),
        ("index", n(index)),
        ("element", n(4.0)),
        ("rangeType", n(1.0)),
        ("effects", arr(effects)),
    ])
}

fn basic() -> Desc {
    Desc::new()
        .level(30.0)
        .stat("strength", 70.0)
        .stat("agility", 60.0)
        .stat("speed", 60.0)
        .stat("luck", 50.0)
        .skills(0.0)
        .skill(29, 70.0)
        .skill(34, 40.0)
        .skill(19, 50.0)
}

fn item_with(params: &[f64]) -> Value {
    let mut it = weapon(121.0, 9.0, 1.0);
    it.set(
        "enchantments",
        arr(params
            .iter()
            .map(|p| obj([("type", n(2.0)), ("param", n(*p))]))
            .collect()),
    );
    it
}

fn target() -> Value {
    let mut t = reference_foe(30.0, "tough");
    t.set("health", n(1000.0));
    t.set("maxHealth", n(1000.0));
    t.set("activeEffects", arr(vec![]));
    t
}

fn half() -> impl Rolls {
    || 0.5
}

#[test]
fn cws_rows_keep_the_item_order_and_resolve_a_missing_record_to_none() {
    let item = item_with(&[7.0, 9.0, 7.0]);
    let book = spells_by_index_map([spell_of(vec![effect(4.0, 0.0, 10.0)], 7.0, "Test Bolt")]);
    let rows = cws_rows(&item, &book);
    assert_eq!(
        rows.iter().map(|(p, _)| *p).collect::<Vec<_>>(),
        [7.0, 9.0, 7.0]
    );
    assert_eq!(rows[0].1.expect("a record").get("name"), &s("Test Bolt"));
    assert!(rows[1].1.is_none());
    assert_eq!(rows[2].1.expect("a record").get("name"), &s("Test Bolt"));
}

#[test]
fn the_strikes_gate_target_damage_ward_whole_item_cws_row() {
    let item = item_with(&[1.0]);
    let book = spells_by_index_map([spell_of(vec![effect(4.0, 0.0, 10.0)], 1.0, "Test Bolt")]);
    let t = target();
    assert!(cws_eligible(&t, true, true, &item, &book));
    assert!(!cws_eligible(&Value::Null, true, true, &item, &book));
    assert!(
        !cws_eligible(&t, false, true, &item, &book),
        "a miss / fully stopped blow"
    );
    assert!(
        !cws_eligible(&t, true, false, &item, &book),
        "the off-hand whole draw failed"
    );
    let mut warded = t.clone();
    warded.set("warded", b(true));
    assert!(
        !cws_eligible(&warded, true, true, &item, &book),
        "a warded target"
    );
    let bare = weapon(121.0, 9.0, 1.0);
    assert!(!cws_eligible(&t, true, true, &bare, &book), "no CWS row");
    assert!(!cws_eligible(&t, true, true, &Value::Null, &book));
    // A missing spell record is still a CWS row: the row is walked, it simply casts nothing.
    assert!(cws_eligible(&t, true, true, &item, &Spellbook::default()));
}

#[test]
fn direct_damage_is_the_actual_is_damage_health_family_4_0() {
    assert!(is_damage_health(&effect(4.0, 0.0, 10.0)));
    assert!(!is_damage_health(&effect(1.0, 0.0, 10.0)));
    assert!(!is_damage_health(&effect(11.0, 8.0, 10.0)));
    assert!(is_continuous_damage(&effect(1.0, 0.0, 10.0)));
    assert!(!is_continuous_damage(&effect(4.0, 0.0, 10.0)));

    let caster = obj([("entity", obj([("level", n(30.0))]))]);
    let cast = Cast {
        caster: Caster::Entity(&caster),
        level: 30.0,
        pierce: 0.0,
        potency_pct: 0.0,
    };
    let mut t = target();
    let plain = resolve_cws_cast(
        &spell_of(vec![effect(4.0, 0.0, 10.0)], 1.0, "Test Bolt"),
        &mut t,
        &cast,
        &mut half(),
        None,
    );
    assert_eq!(f(plain.get("damage")), 8.0);
    assert_eq!(f(plain.get("deferred")), 0.0);
    assert_eq!(f(plain.get("effects").at(0).get("savePercent")), 80.0);

    // A (1,0) spell with no rounds stands for nothing: no round, no entry, no draws; and it is the DoT family.
    let mut t = target();
    let dot = resolve_cws_cast(
        &spell_of(vec![effect(1.0, 0.0, 10.0)], 1.0, "Test Bolt"),
        &mut t,
        &cast,
        &mut half(),
        None,
    );
    assert_eq!(f(dot.get("damage")), 0.0);
    assert_eq!(f(dot.get("deferred")), 0.0);
    assert_eq!(f(dot.get("continuous")), 0.0);
    assert_eq!(f(dot.get("effects").at(0).get("rounds")), 0.0);
    assert!(t.get("activeEffects").items().is_empty());

    let mut t = target();
    let transfer = resolve_cws_cast(
        &spell_of(vec![effect(11.0, 8.0, 10.0)], 1.0, "Test Bolt"),
        &mut t,
        &cast,
        &mut half(),
        None,
    );
    assert_eq!(f(transfer.get("damage")), 0.0);
    assert_eq!(f(transfer.get("deferred")), 1.0);
}

#[test]
fn resistance_and_immunity_gates() {
    let caster = obj([("entity", obj([("level", n(30.0))]))]);
    let cast = Cast {
        caster: Caster::Entity(&caster),
        level: 30.0,
        pierce: 0.0,
        potency_pct: 0.0,
    };
    let spell = spell_of(vec![effect(4.0, 0.0, 10.0)], 1.0, "Test Bolt");

    let mut resist_target = target();
    resist_target.set(
        "activeEffects",
        arr(vec![obj([
            ("kind", s("spellResistance")),
            ("chance", n(100.0)),
        ])]),
    );
    let resist = resolve_cws_cast(&spell, &mut resist_target, &cast, &mut half(), None);
    assert_eq!(f(resist.get("damage")), 0.0);
    assert_eq!(f(resist.get("resisted")), 1.0);

    let mut elemental_target = target();
    elemental_target.set(
        "activeEffects",
        arr(vec![obj([
            ("kind", s("elementalResistance")),
            ("element", n(4.0)),
            ("chance", n(100.0)),
        ])]),
    );
    let elemental = resolve_cws_cast(&spell, &mut elemental_target, &cast, &mut half(), None);
    assert_eq!(f(elemental.get("damage")), 0.0);
    assert_eq!(
        f(elemental.get("resisted")),
        0.0,
        "elemental resistance is inside savingThrow, not the assign-time gate"
    );

    let mut immune_target = target();
    immune_target.set("career", obj([("immunityFlags", n(2.0))]));
    let immune = resolve_cws_cast(&spell, &mut immune_target, &cast, &mut half(), None);
    assert_eq!(f(immune.get("damage")), 0.0);
}

#[test]
fn only_the_first_effect_reflects_and_later_effects_still_land() {
    let caster = obj([("entity", obj([("level", n(30.0))]))]);
    let cast = Cast {
        caster: Caster::Entity(&caster),
        level: 30.0,
        pierce: 0.0,
        potency_pct: 0.0,
    };
    let mut t = target();
    t.set(
        "activeEffects",
        arr(vec![obj([
            ("kind", s("spellReflection")),
            ("chance", n(100.0)),
        ])]),
    );
    let one = resolve_cws_cast(
        &spell_of(vec![effect(4.0, 0.0, 10.0)], 1.0, "Test Bolt"),
        &mut t,
        &cast,
        &mut half(),
        None,
    );
    assert_eq!(f(one.get("damage")), 0.0);
    assert_eq!(f(one.get("reflected")), 1.0);

    let mut t = target();
    t.set(
        "activeEffects",
        arr(vec![obj([
            ("kind", s("spellReflection")),
            ("chance", n(100.0)),
        ])]),
    );
    let two = resolve_cws_cast(
        &spell_of(
            vec![effect(4.0, 0.0, 10.0), effect(4.0, 0.0, 20.0)],
            1.0,
            "Test Bolt",
        ),
        &mut t,
        &cast,
        &mut half(),
        None,
    );
    assert_eq!(
        f(two.get("damage")),
        16.0,
        "the second effect lands: 20 x 80%"
    );
    assert_eq!(f(two.get("reflected")), 1.0);
}

#[test]
fn absorption_reads_the_career_channel_and_the_absorbs_spells_enchantment() {
    let caster = obj([("entity", obj([("level", n(30.0))]))]);
    let cast = Cast {
        caster: Caster::Entity(&caster),
        level: 30.0,
        pierce: 0.0,
        potency_pct: 0.0,
    };
    let spell = spell_of(vec![effect(4.0, 0.0, 10.0)], 1.0, "Test Bolt");

    let mut career = target();
    career.set("career", obj([("spellAbsorptionFlags", n(4.0))]));
    career.set("magicka", n(0.0));
    career.set("maxMagicka", n(1000.0));
    let r = resolve_cws_cast(&spell, &mut career, &cast, &mut half(), None);
    assert_eq!(f(r.get("damage")), 0.0);
    assert_eq!(f(r.get("absorbed")), 1.0);

    let mut ench = target();
    ench.set("_enchantMods", obj([("absorbsSpells", b(true))]));
    ench.set("magicka", n(0.0));
    ench.set("maxMagicka", n(1000.0));
    let mut low = || 0.4;
    let r = resolve_cws_cast(&spell, &mut ench, &cast, &mut low, None);
    assert_eq!(f(r.get("damage")), 0.0);
    assert_eq!(f(r.get("absorbed")), 1.0);

    let mut ench = target();
    ench.set("_enchantMods", obj([("absorbsSpells", b(true))]));
    ench.set("magicka", n(0.0));
    ench.set("maxMagicka", n(1000.0));
    let mut high = || 0.6;
    let r = resolve_cws_cast(&spell, &mut ench, &cast, &mut high, None);
    assert!(f(r.get("damage")) > 0.0);
    assert_eq!(f(r.get("absorbed")), 0.0);
}

// ── the fight loop (`test/cws.test.js`'s last four tests) ─────────

fn fight_book() -> Spellbook {
    spells_by_index_map([spell_of(vec![effect(4.0, 0.0, 100.0)], 1.0, "Test Bolt")])
}

fn fight_args(target: Value, health: f64, max_blows: f64) -> Value {
    obj([
        ("target", target),
        ("health", n(health)),
        ("seed", n(0.0)),
        ("trace", b(true)),
        ("maxBlows", n(max_blows)),
    ])
}

/// The CWS rolls come from `FightRolls::cws`; the spellbook is the caller's `book`.
fn run(ch: &Value, target: Value, health: f64, max_blows: f64, book: &Spellbook) -> Value {
    let mut cache = dfo_core::simulate_fight::create_tier_cache();
    let mut rolls = half();
    simulate_fight_cached(
        ch,
        &fight_args(target, health, max_blows),
        book,
        &mut cache,
        FightRolls {
            cws: Some(&mut rolls),
            condition: None,
        },
    )
    .expect("a fight")
}

#[test]
fn the_fight_applies_cws_before_the_melee_blow_and_a_cws_kill_drops_the_blow() {
    let book = fight_book();
    let item = item_with(&[1.0]);
    let ch = basic().sim(Some(item));
    let r = run(&ch, target(), 500.0, 1.0, &book);
    let trace = r.get("trace").items();
    let cws_trace = r.get("cwsTrace").items();
    assert_eq!(trace.len(), 1);
    assert_eq!(cws_trace.len(), 1);
    assert_eq!(f(cws_trace[0].get("swing")), 1.0);
    assert_eq!(f(cws_trace[0].get("t")), f(trace[0].get("t")));
    assert_eq!(f(trace[0].get("cwsDamage")), 80.0);
    assert!(trace[0].get("meleeApplied").truthy());
    assert_eq!(
        f(r.get("damageDealt")),
        f(r.get("cwsDamage")) + f(trace[0].get("damage"))
    );

    let kill = run(&ch, target(), 5.0, 2.0, &book);
    assert!(kill.get("kill").truthy());
    assert_eq!(f(kill.get("cwsKills")), 1.0);
    assert_eq!(f(kill.get("blows")), 1.0);
    assert!(kill.get("trace").at(0).get("cwsKill").truthy());
    assert!(!kill.get("trace").at(0).get("meleeApplied").truthy());
    assert!(
        f(kill.get("trace").at(0).get("blowDamage")) > 0.0,
        "the melee blow was rolled, then dropped"
    );
    assert_eq!(f(kill.get("damageDealt")), f(kill.get("cwsDamage")));
    assert_eq!(f(kill.get("ttk")), f(kill.get("cwsTrace").at(0).get("t")));
}

#[test]
fn a_miss_and_a_ward_cast_nothing() {
    let book = fight_book();
    let item = item_with(&[1.0]);
    let ch = basic().sim(Some(item));
    // The JS uses seed 4 for the miss; the port's own seed is the RNG stream, so a miss is found by scanning blows.
    let r = run(&ch, target(), 500.0, 40.0, &book);
    let trace = r.get("trace").items();
    let cws_trace = r.get("cwsTrace").items();
    // Every CWS event belongs to a blow that was a positive whole Strikes hit.
    for event in cws_trace {
        let swing = f(event.get("swing"));
        let row = trace
            .iter()
            .find(|e| f(e.get("swing")) == swing)
            .expect("the melee row of the swing");
        assert!(row.get("formulaPositive").truthy(), "swing {swing}");
        assert!(row.get("whole").truthy(), "swing {swing}");
    }

    let mut warded = target();
    warded.set("warded", b(true));
    let w = run(&ch, warded, 500.0, 3.0, &book);
    assert_eq!(f(w.get("cwsCasts")), 0.0);
    assert!(w.get("cwsTrace").items().is_empty());
}

#[test]
fn missing_records_zero_damage_spells_and_multiple_rows_keep_their_order() {
    let item = item_with(&[99.0]);
    let ch = basic().sim(Some(item));
    let missing = run(&ch, target(), 500.0, 1.0, &Spellbook::default());
    let cws = missing.get("cwsTrace").items();
    assert_eq!(cws.len(), 1);
    assert!(cws[0].get("missing").truthy());
    assert_eq!(f(cws[0].get("damage")), 0.0);
    assert!(missing.get("trace").at(0).get("meleeApplied").truthy());

    let zero_book = spells_by_index_map([spell_of(vec![effect(1.0, 0.0, 10.0)], 1.0, "Zero")]);
    let ch = basic().sim(Some(item_with(&[1.0])));
    let zero = run(&ch, target(), 500.0, 1.0, &zero_book);
    let cws = zero.get("cwsTrace").items();
    assert_eq!(cws.len(), 1);
    assert_eq!(f(cws[0].get("damage")), 0.0);
    assert_eq!(f(cws[0].get("deferred")), 0.0);
    assert!(cws[0].get("effects").at(0).get("continuous").truthy());
    assert_eq!(f(cws[0].get("effects").at(0).get("rounds")), 0.0);
    assert!(zero.get("trace").at(0).get("meleeApplied").truthy());

    let two_book = spells_by_index_map([
        spell_of(vec![effect(4.0, 0.0, 10.0)], 1.0, "First"),
        spell_of(vec![effect(4.0, 0.0, 20.0)], 2.0, "Second"),
    ]);
    let ch = basic().sim(Some(item_with(&[1.0, 2.0])));
    let two = run(&ch, target(), 500.0, 1.0, &two_book);
    let cws = two.get("cwsTrace").items();
    let indexes: Vec<f64> = cws.iter().map(|e| f(e.get("index"))).collect();
    assert_eq!(indexes, [1.0, 2.0]);
    let damages: Vec<f64> = cws.iter().map(|e| f(e.get("damage"))).collect();
    assert_eq!(damages, [8.0, 16.0]);
    assert_eq!(f(two.get("cwsDamage")), 24.0);
}

#[test]
fn cws_rng_is_isolated_and_deterministic_with_an_injected_stream() {
    let book = fight_book();
    let ch = basic().sim(Some(item_with(&[1.0])));
    let a = run(&ch, target(), 500.0, 5.0, &book);
    let b = run(&ch, target(), 500.0, 5.0, &book);
    assert_eq!(f(a.get("cwsDamage")), f(b.get("cwsDamage")));
    assert_eq!(a.get("cwsTrace"), b.get("cwsTrace"));

    // Without an injected stream the fight's own CWS stream still replays bit for bit.
    let mut cache = dfo_core::simulate_fight::create_tier_cache();
    let c = simulate_fight_cached(
        &ch,
        &fight_args(target(), 500.0, 5.0),
        &book,
        &mut cache,
        FightRolls::default(),
    )
    .expect("a fight");
    let d = simulate_fight_cached(
        &ch,
        &fight_args(target(), 500.0, 5.0),
        &book,
        &mut dfo_core::simulate_fight::create_tier_cache(),
        FightRolls::default(),
    )
    .expect("a fight");
    assert_eq!(f(c.get("cwsDamage")), f(d.get("cwsDamage")));
    assert_eq!(c.get("cwsTrace"), d.get("cwsTrace"));
}
