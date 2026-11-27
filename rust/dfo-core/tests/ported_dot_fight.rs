//! Ported from `test/dotFight.test.js`: the Continuous Damage (1,0) lifecycle inside the ordinary fight.
//!
//! LOCAL INVARIANTS on the JS file's own fixture (rolls all 0.5: magnitude 10, an 80% save, 8 a round). The rules:
//! a round bills only on a live foe; rounds fall on the 5 s fight clock; a round kill ends the cast and names the DoT;
//! at an equal timestamp the blow resolves before the round; a second trial with the same seed fights the same fight.

mod ported_common;

use dfo_core::simulate_fight::{
    create_attack_schedule, simulate_fight, simulate_fights, FightRolls,
};
use dfo_core::spells::{spells_by_index_map, Spellbook};
use ported_common::*;

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

fn cws_item() -> Value {
    let mut it = weapon(121.0, 9.0, 1.0);
    it.set(
        "enchantments",
        arr(vec![obj([("type", n(2.0)), ("param", n(1.0))])]),
    );
    it
}

fn effect(type_: f64, magnitude: f64) -> Value {
    obj([
        ("type", n(type_)),
        ("subType", n(0.0)),
        ("magnitudeBaseLow", n(magnitude)),
        ("magnitudeBaseHigh", n(magnitude)),
        ("magnitudeLevelBase", n(0.0)),
        ("magnitudeLevelHigh", n(0.0)),
        ("magnitudePerLevel", n(1.0)),
        ("durationBase", n(if type_ == 1.0 { 3.0 } else { 0.0 })),
        ("durationMod", n(0.0)),
        ("durationPerLevel", n(1.0)),
        ("chanceBase", n(0.0)),
        ("chanceMod", n(0.0)),
        ("chancePerLevel", n(1.0)),
    ])
}

/// `dotSpellWith({ magnitude, rounds, direct, directFirst })`: one (1,0) effect, optionally with a (4,0) beside it.
fn spell_with(magnitude: f64, rounds: f64, direct: f64, direct_first: bool) -> Value {
    let mut dot = effect(1.0, magnitude);
    dot.set("durationBase", n(rounds));
    let mut effects = vec![dot];
    if direct > 0.0 {
        let instant = effect(4.0, direct);
        if direct_first {
            effects.insert(0, instant);
        } else {
            effects.push(instant);
        }
    }
    obj([
        ("name", s("Test DoT")),
        ("index", n(1.0)),
        ("element", n(4.0)),
        ("rangeType", n(1.0)),
        ("effects", arr(effects)),
    ])
}

fn book_for(spell: Value) -> Spellbook {
    spells_by_index_map([spell])
}

fn fight_args(health: f64, max_seconds: f64) -> Value {
    obj([
        ("target", reference_foe(30.0, "tough")),
        ("health", n(health)),
        ("maxSeconds", n(max_seconds)),
        ("trace", b(true)),
        ("seed", n(3.0)),
    ])
}

fn run(health: f64, max_seconds: f64, spell: Value) -> Value {
    let ch = basic().sim(Some(cws_item()));
    let book = book_for(spell);
    let mut rolls = || 0.5;
    let mut cache = dfo_core::simulate_fight::create_tier_cache();
    dfo_core::simulate_fight::simulate_fight_cached(
        &ch,
        &fight_args(health, max_seconds),
        &book,
        &mut cache,
        FightRolls {
            cws: Some(&mut rolls),
            condition: None,
        },
    )
    .expect("a fight")
}

#[test]
fn a_round_after_the_spell_has_already_killed_bills_nothing() {
    let run = run(10.0, 12.0, spell_with(1000.0, 3.0, 1000.0, true));
    let row = run.get("cwsTrace").at(0).clone();
    assert_eq!(
        f(row.get("effects").at(0).get("type")),
        4.0,
        "the direct effect is first"
    );
    assert_eq!(
        f(row.get("dotDamage")),
        0.0,
        "a round on a dead foe bills nothing"
    );
    assert!(row.get("kill").truthy());
    assert_eq!(
        run.get("killSource"),
        &s("cws"),
        "the direct damage killed, not the DoT"
    );
    assert_eq!(
        f(run.get("overkill")),
        790.0,
        "the dead round does not inflate the overkill"
    );
    assert_eq!(
        f(run.get("damageDealt")),
        (f(run.get("health")) - f(run.get("remainingHealth"))) + f(run.get("overkill")),
        "dealt = the hp drop plus overkill"
    );
}

#[test]
fn rounds_that_fall_after_the_last_blow_are_billed() {
    let ch = basic().sim(Some(cws_item()));
    let book = book_for(spell_with(10.0, 3.0, 0.0, false));
    let mut rolls = || 0.5;
    let mut args = fight_args(1e6, 12.0);
    args.set("maxBlows", n(1.0));
    let mut cache = dfo_core::simulate_fight::create_tier_cache();
    let run = dfo_core::simulate_fight::simulate_fight_cached(
        &ch,
        &args,
        &book,
        &mut cache,
        FightRolls {
            cws: Some(&mut rolls),
            condition: None,
        },
    )
    .expect("a fight");
    assert_eq!(f(run.get("blows")), 1.0, "one blow");
    assert_eq!(run.get("endReason"), &s("blowBudget"));
    let round_times: Vec<f64> = run
        .get("cwsTrace")
        .items()
        .iter()
        .filter(|e| e.get("round").truthy())
        .map(|e| f(e.get("t")))
        .collect();
    assert_eq!(
        round_times,
        [5.0, 10.0],
        "the rounds after the last blow still fall on the clock"
    );
    assert_eq!(
        f(run.get("dotDamage")),
        24.0,
        "the cast round and both drained rounds"
    );
    assert!(near(
        f(run.get("remainingHealth")),
        f(run.get("health")) - f(run.get("damageDealt"))
    ));
}

#[test]
fn the_health_segments_carry_the_round_damage_too() {
    let run = run(5000.0, 12.0, spell_with(10.0, 3.0, 0.0, false));
    assert!(run
        .get("cwsTrace")
        .items()
        .iter()
        .any(|e| e.get("round").truthy()));
    let segments = run.get("segments").items();
    let damage: f64 = segments.iter().map(|s| f(s.get("damage"))).sum();
    assert!(
        near(damage, f(run.get("damageDealt"))),
        "the segments add up to dealt"
    );
    let cws: f64 = segments.iter().map(|s| f(s.get("cwsDamage"))).sum();
    assert!(near(cws, f(run.get("cwsDamage"))));
}

#[test]
fn every_round_is_accounted_and_the_traces_reconcile_with_the_health_drops() {
    let run = run(5000.0, 12.0, spell_with(10.0, 3.0, 0.0, false));
    let rounds: Vec<Value> = run
        .get("cwsTrace")
        .items()
        .iter()
        .filter(|e| e.get("round").truthy())
        .cloned()
        .collect();
    assert!(!rounds.is_empty(), "a DoT round landed inside the fight");
    assert!(
        rounds.iter().all(|e| f(e.get("damage")) == 8.0),
        "each round is the 8 the seed gives"
    );
    let cast_and_rounds: f64 = run
        .get("cwsTrace")
        .items()
        .iter()
        .map(|e| f(e.get("damage")))
        .sum();
    assert!(near(f(run.get("cwsDamage")), cast_and_rounds));

    // Replay the health: a blow row bills its cast, its echo and its melee blow; a round row bills its own round.
    let mut events: Vec<(f64, i32, f64, f64)> = run
        .get("trace")
        .items()
        .iter()
        .map(|r| {
            (
                f(r.get("t")),
                0,
                f(r.get("cwsDamage")) + f(r.get("echoApplied")) + f(r.get("damage")),
                f(r.get("remaining")),
            )
        })
        .chain(
            rounds
                .iter()
                .map(|r| (f(r.get("t")), 1, f(r.get("damage")), f(r.get("remaining")))),
        )
        .collect();
    events.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut hp = f(run.get("health"));
    let mut drops = 0.0;
    for (t, _, dmg, remaining) in events {
        let before = hp;
        hp = f64::max(0.0, hp - dmg);
        drops += before - hp;
        assert!(near(remaining, hp), "remaining after the event at {t}");
    }
    assert!(near(
        drops,
        f(run.get("health")) - f(run.get("remainingHealth"))
    ));
    assert!(near(
        f(run.get("damageDealt")),
        f(run.get("cwsDamage")) + f(run.get("echoDamage")) + f(run.get("meleeDamage"))
    ));
}

#[test]
fn rounds_fall_on_the_five_second_clock_and_the_cast_bills_its_own_round() {
    let ch = basic().sim(Some(cws_item()));
    let book = book_for(spell_with(10.0, 3.0, 0.0, false));
    let mut schedule = create_attack_schedule(
        &ch,
        &obj([
            ("target", reference_foe(30.0, "tough")),
            ("health", n(1e6)),
            (
                "weapon",
                dfo_core::model_blow::weapon_of(&cws_item(), false),
            ),
        ]),
        &book,
    )
    .expect("a schedule")
    .expect("a weapon schedule");
    let first_hit = schedule.next().expect("a first blow").t;
    let card = run(1e6, 12.0, spell_with(10.0, 3.0, 0.0, false));
    let casts: Vec<Value> = card
        .get("cwsTrace")
        .items()
        .iter()
        .filter(|e| !e.get("round").truthy())
        .cloned()
        .collect();
    assert!(!casts.is_empty(), "the fight cast");
    assert!(
        near(f(casts[0].get("t")), first_hit),
        "the first cast is the first blow"
    );
    assert_eq!(
        f(casts[0].get("dotDamage")),
        8.0,
        "the cast bills its own round, at the cast time"
    );
    let round_times: Vec<f64> = card
        .get("cwsTrace")
        .items()
        .iter()
        .filter(|e| e.get("round").truthy())
        .map(|e| f(e.get("t")))
        .collect();
    assert_eq!(round_times, [5.0, 10.0], "rounds fall on the clock anchors");

    // durationBase 1 = one round, the cast's own: nothing is left for a boundary.
    let one = run(1e6, 12.0, spell_with(10.0, 1.0, 0.0, false));
    assert_eq!(f(one.get("cwsTrace").at(0).get("dotDamage")), 8.0);
    assert!(
        !one.get("cwsTrace")
            .items()
            .iter()
            .any(|e| e.get("round").truthy()),
        "a one-round DoT never reaches an anchor"
    );
}

#[test]
fn a_round_that_kills_ends_the_cast_and_names_the_dot() {
    let run = run(10.0, 12.0, spell_with(1000.0, 3.0, 1000.0, false));
    let row = run.get("cwsTrace").at(0).clone();
    assert_eq!(
        f(row.get("dotDamage")),
        800.0,
        "the round is 1000 rolled, 80% kept"
    );
    assert!(row.get("kill").truthy(), "the round killed");
    assert_eq!(
        f(row.get("damage")),
        800.0,
        "the later (4,0) effect did not land"
    );
    assert_eq!(f(row.get("effects").at(1).get("type")), 4.0);
    assert!(
        !row.get("effects").at(1).get("applied").truthy(),
        "no later effect of the same spell applies after the killing round"
    );
    assert!(run.get("kill").truthy());
    assert_eq!(
        run.get("killSource"),
        &s("dot"),
        "the kill belongs to the DoT round"
    );
    assert_eq!(f(run.get("remainingHealth")), 0.0);
}

#[test]
fn at_an_equal_timestamp_the_blow_resolves_before_the_round() {
    let ch = basic().sim(Some(cws_item()));
    let book = book_for(spell_with(10.0, 3.0, 0.0, false));
    let mut rolls = || 0.5;
    let mut args = fight_args(1e6, 12.0);
    args.set("seed", n(2.0));
    args.set("attackSpeedPct", n(17.159183673469394));
    let mut cache = dfo_core::simulate_fight::create_tier_cache();
    let run = dfo_core::simulate_fight::simulate_fight_cached(
        &ch,
        &args,
        &book,
        &mut cache,
        FightRolls {
            cws: Some(&mut rolls),
            condition: None,
        },
    )
    .expect("a fight");
    let blow_at5 = run
        .get("trace")
        .items()
        .iter()
        .find(|r| (f(r.get("t")) - 5.0).abs() < 1e-9)
        .cloned()
        .expect("the fixture has a blow at exactly 5 s");
    let round_at5: Vec<Value> = run
        .get("cwsTrace")
        .items()
        .iter()
        .filter(|e| e.get("round").truthy() && (f(e.get("t")) - 5.0).abs() < 1e-9)
        .cloned()
        .collect();
    assert_eq!(round_at5.len(), 1, "exactly one round on the 5 s anchor");
    assert_eq!(f(round_at5[0].get("damage")), 8.0);
    assert!(
        near(
            f(round_at5[0].get("remaining")),
            f(blow_at5.get("remaining")) - 8.0
        ),
        "the round is billed after the blow, on the health the blow left"
    );
    assert!(f(blow_at5.get("remaining")) > f(round_at5[0].get("remaining")));
}

#[test]
fn a_second_trial_with_the_same_seed_fights_the_same_fight() {
    let ch = basic().sim(Some(cws_item()));
    let book = book_for(spell_with(10.0, 3.0, 0.0, false));
    let mut cache = dfo_core::simulate_fight::create_tier_cache();
    let first = simulate_fight(&ch, &fight_args(1e6, 12.0), &book).expect("a fight");
    let second = simulate_fight(&ch, &fight_args(1e6, 12.0), &book).expect("a fight");
    let _ = &mut cache;
    assert_eq!(second.get("cwsTrace"), first.get("cwsTrace"));
    let remaining = |r: &Value| -> Vec<f64> {
        r.get("trace")
            .items()
            .iter()
            .map(|row| f(row.get("remaining")))
            .collect()
    };
    assert_eq!(remaining(&second), remaining(&first));
    assert_eq!(f(second.get("cwsDamage")), f(first.get("cwsDamage")));

    // The batch form: two identical seeds must produce the same fight.
    let mut args = fight_args(1e6, 12.0);
    args.set("seeds", nums([3.0, 3.0]));
    let batch = simulate_fights(&ch, &args, &book).expect("a batch");
    assert_eq!(
        batch.get("rows").at(1).get("cwsTrace"),
        batch.get("rows").at(0).get("cwsTrace")
    );
    assert_eq!(
        remaining(batch.get("rows").at(1)),
        remaining(batch.get("rows").at(0))
    );
}
