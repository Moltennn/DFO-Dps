//! Ported from `test/probe.test.js`: the Combat Probe reader, as known values.
//!
//! LOCAL INVARIANTS on synthetic captures (never a real save or capture), matching the JS file's own fixtures.

mod ported_common;

use dfo_core::probe::{split_fights, summarize_probe};
use ported_common::*;

/// `test/probe.test.js`'s `capture()`: 10 samples a second for `seconds`, health falling to 0, optional gap/halves.
fn capture(seconds: f64, gap: (f64, f64), content: &str, halves: bool) -> Value {
    let mut samples = Vec::new();
    let steps = seconds * 10.0;
    let mut hp = 100.0;
    for i in 0..=(steps as i64) {
        let t = (i as f64) * 100.0;
        let in_gap = gap.1 > 0.0 && t >= gap.0 * 1000.0 && t < (gap.0 + gap.1) * 1000.0;
        if !in_gap {
            hp = f64::max(0.0, 100.0 - (i as f64 / steps) * 100.0);
        }
        let frac = i as f64 / steps;
        samples.push(obj([
            ("t", n(t)),
            ("wall", n(1_700_000_000_000.0 + t)),
            (
                "boss",
                obj([
                    ("content", s(content)),
                    ("name", s("The Warden")),
                    ("sub", s("level 45")),
                    ("hp", n(hp)),
                    ("warded", b(false)),
                    ("wrath", b(false)),
                    ("tags", arr(vec![])),
                    (
                        "halves",
                        arr(if halves && frac > 0.5 {
                            vec![
                                obj([("name", s("Gold")), ("hp", n(hp)), ("state", s(""))]),
                                obj([("name", s("Silver")), ("hp", n(hp)), ("state", s(""))]),
                            ]
                        } else {
                            vec![]
                        }),
                    ),
                ]),
            ),
        ]));
    }
    obj([
        ("version", n(1.0)),
        ("build", s("test")),
        ("level", n(45.0)),
        ("players", n(1.0)),
        ("startedAt", n(0.0)),
        ("endedAt", n(steps * 100.0)),
        ("samples", arr(samples)),
        ("events", arr(vec![])),
        ("chart", Value::Null),
    ])
}

fn summarize(data: &Value) -> Value {
    summarize_probe(data, &Value::Undefined).expect("a probe capture")
}

/// Set the same `gate` record on every sample (the JS fixture mutates each `s.gate`).
fn each_gate(data: &mut Value, gate: Value) {
    let samples: Vec<Value> = data
        .get("samples")
        .items()
        .iter()
        .map(|s| {
            let mut s = s.clone();
            s.set("gate", gate.clone());
            s
        })
        .collect();
    data.set("samples", arr(samples));
}

#[test]
fn a_clean_60_second_capture_reads_200_dps_1000_burst_and_no_immunity() {
    let s = summarize(&capture(60.0, (0.0, 0.0), "breach", false));
    assert_eq!(s.get("fights").items().len(), 1);
    let fight = s.get("fights").at(0).clone();
    assert_eq!(f(fight.get("maxHp")), 12000.0);
    let damage = f(fight.get("damage"));
    assert!((damage - 12000.0).abs() < 1.0, "damage {damage}");
    let dps = f(fight.get("dps"));
    assert!((dps - 200.0).abs() < 3.0, "dps {dps}");
    let burst = f(fight.get("burst5"));
    assert!((burst - 1000.0).abs() < 30.0, "burst {burst}");
    assert!(f(fight.get("immunityShare")) < 0.02);
}

#[test]
fn a_five_second_no_damage_gap_is_read_as_immunity() {
    let s = summarize(&capture(60.0, (25.0, 5.0), "breach", false));
    let fight = s.get("fights").at(0).clone();
    let immunity = f(fight.get("immunityS"));
    assert!(immunity > 4.0 && immunity < 6.0, "gap {immunity}");
    let share = f(fight.get("immunityShare"));
    assert!(share > 0.07 && share < 0.11, "share {share}");
}

#[test]
fn two_pulls_split_into_two_fights() {
    let a = capture(20.0, (0.0, 0.0), "breach", false);
    let b = capture(20.0, (0.0, 0.0), "breach", false);
    let shift = 60_000.0;
    let shifted: Vec<Value> = b
        .get("samples")
        .items()
        .iter()
        .map(|s| {
            let mut s = s.clone();
            s.set("t", n(f(s.get("t")) + shift));
            s.set("wall", n(f(s.get("wall")) + shift));
            s
        })
        .collect();
    let mut joined = a.clone();
    let mut samples = a.get("samples").items().to_vec();
    samples.extend(shifted);
    joined.set("samples", arr(samples));
    let s = summarize(&joined);
    assert_eq!(s.get("fights").items().len(), 2);
}

#[test]
fn the_split_halves_are_carried_through() {
    let s = summarize(&capture(60.0, (0.0, 0.0), "breach", true));
    let fight = s.get("fights").at(0).clone();
    assert!(!fight.get("halves").items().is_empty());
    assert_eq!(fight.get("halves").at(0).get("halves").items().len(), 2);
}

#[test]
fn a_non_probe_json_is_refused() {
    let err = summarize_probe(&obj([("version", n(2.0))]), &Value::Undefined)
        .expect_err("a non-probe document");
    assert!(err.contains("Combat Probe"), "{err}");
}

#[test]
fn a_slow_weapon_cadence_is_not_mistaken_for_immunity() {
    let mut samples = Vec::new();
    let mut hp = 100.0;
    for i in 0..=600 {
        let t = (i as f64) * 100.0;
        if i > 0 && i % 10 == 0 {
            hp = f64::max(0.0, hp - 100.0 / 60.0);
        }
        samples.push(obj([
            ("t", n(t)),
            (
                "boss",
                obj([
                    ("content", s("breach")),
                    ("name", s("The Warden")),
                    ("sub", s("")),
                    ("hp", n(hp)),
                    ("tags", arr(vec![])),
                    ("halves", arr(vec![])),
                ]),
            ),
        ]));
    }
    let data = obj([
        ("version", n(1.0)),
        ("level", n(45.0)),
        ("players", n(1.0)),
        ("samples", arr(samples)),
    ]);
    let fight = summarize(&data).get("fights").at(0).clone();
    assert!(f(fight.get("immunityS")) < 0.5);
}

#[test]
fn per_player_levels_from_the_chart_add_their_own_share() {
    let mut data = capture(60.0, (0.0, 0.0), "breach", false);
    data.set("levels", nums([45.0, 45.0]));
    data.set("players", n(2.0));
    let fight = summarize(&data).get("fights").at(0).clone();
    assert_eq!(f(fight.get("players")), 2.0);
    assert_eq!(f(fight.get("maxHp")), 24000.0);
    assert!((f(fight.get("damage")) - 24000.0).abs() < 1.0);
}

#[test]
fn a_top_10_chart_fills_the_remaining_players_at_the_median_level() {
    let mut data = capture(60.0, (0.0, 0.0), "breach", false);
    data.set("players", n(49.0));
    data.set("levels", nums(vec![31.0; 10]));
    let fight = summarize(&data).get("fights").at(0).clone();
    assert_eq!(f(fight.get("players")), 49.0);
    assert_eq!(fight.get("levels").items().len(), 10);
    assert_eq!(f(fight.get("levelFill")), 31.0);
    assert!(fight.get("maxHpEstimated").truthy());
    assert_eq!(f(fight.get("maxHp")), 240.0 * 36.0 * 49.0);
}

#[test]
fn the_gate_state_makes_the_boss_hp_exact_and_gives_the_landed_total() {
    let mut data = capture(60.0, (0.0, 0.0), "breach", false);
    each_gate(
        &mut data,
        obj([
            ("max", n(423360.0)),
            ("fighters", n(49.0)),
            ("phase", n(1.0)),
        ]),
    );
    data.set("players", n(49.0));
    data.set("levels", nums(vec![31.0; 10]));
    let fight = summarize(&data).get("fights").at(0).clone();
    assert_eq!(f(fight.get("maxHp")), 423360.0);
    assert!(!fight.get("maxHpEstimated").truthy());
    assert_eq!(f(fight.get("players")), 49.0);

    let mut data = capture(86.0, (0.0, 0.0), "breach", false);
    data.set("players", n(6.0));
    data.set("levels", nums(vec![31.0; 6]));
    each_gate(
        &mut data,
        obj([
            ("max", n(45300.0)),
            ("hp", n(1183.0)),
            ("fighters", n(6.0)),
            ("phase", n(3.0)),
        ]),
    );
    let fight = summarize(&data).get("fights").at(0).clone();
    assert_eq!(f(fight.get("maxHp")), 45300.0);
    assert_eq!(f(fight.get("damage")), 44117.0);
    assert!(!fight.get("maxHpEstimated").truthy());
    assert_eq!(fight.get("outcome"), &s("ended"));
}

#[test]
fn a_chart_that_says_fallen_overrides_stale_gate_hp_and_makes_the_damage_the_whole_pool() {
    let mut data = capture(86.0, (0.0, 0.0), "breach", false);
    data.set("players", n(6.0));
    data.set("levels", nums(vec![31.0; 6]));
    each_gate(
        &mut data,
        obj([
            ("max", n(45300.0)),
            ("hp", n(1183.0)),
            ("fighters", n(6.0)),
            ("phase", n(3.0)),
        ]),
    );
    data.set(
        "chart",
        obj([
            ("sub", s("Valkynaz Ruhn has fallen - 6 challengers")),
            ("rows", arr(vec![])),
        ]),
    );
    let fight = summarize(&data).get("fights").at(0).clone();
    assert_eq!(f(fight.get("damage")), 45300.0);
    assert_eq!(fight.get("outcome"), &s("kill"));
    assert!(!fight.get("maxHpEstimated").truthy());
}

#[test]
fn the_flat_chart_rows_give_best_and_blows() {
    let mut data = capture(60.0, (0.0, 0.0), "breach", false);
    data.set(
        "chart",
        obj([
            ("sub", s("Valkynaz Ruhn has fallen - 2 challengers")),
            (
                "rows",
                arr(vec![
                    obj([("cls", s("wb-dmg-row wb-dmg-head")), ("text", s("#"))]),
                    obj([("cls", s("wb-dmg-row")), ("text", s("1A"))]),
                    obj([("cls", s("wb-dmg-rank")), ("text", s("1"))]),
                    obj([("cls", s("wb-dmg-name")), ("text", s("A"))]),
                    obj([("cls", s("wb-dmg-lv")), ("text", s("Lv 31"))]),
                    obj([
                        ("cls", s("wb-dmg-damage wb-dmg-num")),
                        ("text", s("10,000")),
                    ]),
                    obj([("cls", s("wb-dmg-share")), ("text", s("50%"))]),
                    obj([("cls", s("wb-dmg-blows")), ("text", s("120"))]),
                    obj([("cls", s("wb-dmg-best")), ("text", s("516"))]),
                    obj([("cls", s("wb-dmg-cx")), ("text", s("0"))]),
                    obj([("cls", s("wb-dmg-falls")), ("text", s("1"))]),
                    obj([("cls", s("wb-dmg-heal")), ("text", s("200"))]),
                ]),
            ),
        ]),
    );
    let top = summarize(&data).get("fights").at(0).get("chartTop").clone();
    assert_eq!(top.at(0).get("name"), &s("A"));
    assert_eq!(f(top.at(0).get("best")), 516.0);
    assert_eq!(f(top.at(0).get("blows")), 120.0);
    assert_eq!(f(top.at(0).get("falls")), 1.0);
    assert_eq!(f(top.at(0).get("healed")), 200.0);
}

#[test]
fn a_mid_fight_join_reports_since_join_damage_and_keeps_the_whole_kill_total() {
    let mut data = capture(86.0, (0.0, 0.0), "breach", false);
    data.set("players", n(6.0));
    data.set("levels", nums(vec![31.0; 6]));
    each_gate(
        &mut data,
        obj([
            ("max", n(45300.0)),
            ("hp", n(0.0)),
            ("fighters", n(6.0)),
            ("phase", n(3.0)),
        ]),
    );
    let mut first = data.get("samples").at(0).clone();
    first.set(
        "gate",
        obj([
            ("max", n(27300.0)),
            ("hp", n(18535.0)),
            ("fighters", n(3.0)),
            ("phase", n(1.0)),
        ]),
    );
    let mut samples = data.get("samples").items().to_vec();
    samples[0] = first;
    data.set("samples", arr(samples));
    data.set("outcome", s("kill"));
    let fight = summarize(&data).get("fights").at(0).clone();
    assert!(fight.get("midFight").truthy());
    assert_eq!(f(fight.get("damage")), 45300.0);
    assert_eq!(f(fight.get("damageSinceJoin")), 36535.0);
    assert!((f(fight.get("joinedAtPct")) - (18535.0 / 27300.0) * 100.0).abs() < 1e-9);
    assert_eq!(fight.get("outcome"), &s("kill"));
}

#[test]
fn the_player_snapshot_names_the_weapon_and_imprint() {
    let mut data = capture(60.0, (0.0, 0.0), "breach", false);
    data.set(
        "playerEnd",
        obj([
            (
                "weapon",
                obj([("name", s("Broadsword")), ("imprint", s("warp-edge"))]),
            ),
            ("offWeapon", obj([("name", s("Broadsword"))])),
        ]),
    );
    let fight = summarize(&data).get("fights").at(0).clone();
    assert_eq!(fight.get("weapon"), &s("Broadsword"));
    assert_eq!(fight.get("offWeapon"), &s("Broadsword"));
    assert_eq!(fight.get("imprint"), &s("warp-edge"));
}

#[test]
fn a_phase_bar_jump_or_boss_heal_does_not_split_one_gate_fight() {
    let mut samples = Vec::new();
    for i in 0..=200 {
        let bar = if i < 100 {
            100.0 - (i as f64) * 0.4
        } else {
            60.0 - ((i - 100) as f64) * 0.6
        };
        let gate_hp = 100000.0 - (i as f64) * 400.0;
        let boss_hp = if i == 100 { bar + 8.0 } else { bar };
        let hp = if i == 120 { gate_hp + 2825.0 } else { gate_hp };
        samples.push(obj([
            ("t", n((i as f64) * 100.0)),
            (
                "boss",
                obj([
                    ("content", s("breach")),
                    ("name", s("Valkynaz Ruhn")),
                    ("sub", s("")),
                    ("hp", n(boss_hp)),
                    ("halves", arr(vec![])),
                    ("tags", arr(vec![])),
                ]),
            ),
            (
                "gate",
                obj([
                    ("hp", n(hp)),
                    ("max", n(100000.0)),
                    ("fighters", n(40.0)),
                    ("phase", n(2.0)),
                ]),
            ),
        ]));
    }
    assert_eq!(split_fights(&samples, 5000.0, 1.0).len(), 1);
}
