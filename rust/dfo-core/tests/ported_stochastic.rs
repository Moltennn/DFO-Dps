//! Ported from `test/stochasticObjectives.test.js`: the sampled objective layer's named rows, plus pairedDifference's
//! small-pair guard.
//!
//! LOCAL INVARIANTS on the sampled machinery the JS file pins. `tests/relay_fight.rs` holds the objective vectors; these
//! keep the row metadata, the censoring guard and the paired-difference quantile alive with one 1,000-trial sampled run
//! (a few seconds, as the JS file is in the HEAVY list).

mod ported_common;

use dfo_core::objectives::{evaluate_objective, OBJECTIVE_IDS};
use ported_common::*;

const MIN_STOCHASTIC_TRIALS: f64 = 1000.0;

fn scenario() -> Value {
    obj([
        ("core", s("overhaul")),
        ("rri", b(true)),
        ("passiveOn", b(true)),
        ("stacks", n(5.0)),
        ("gameBuild", s("14512")),
    ])
}

fn max_character(template: f64) -> Value {
    let book = book();
    let mut profiles = dfo_core::maxprofile::Profiles::new(&book);
    profiles
        .max_character(&n(template), &obj([("gameBuild", s("14512"))]))
        .expect("a legal max profile")
}

fn with(mut base: Value, extra: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    for (k, v) in extra {
        base.set(k, v);
    }
    base
}

#[test]
fn the_old_four_objectives_are_unchanged() {
    assert_eq!(
        OBJECTIVE_IDS,
        ["snapshot", "fight", "relay", "relay-ceiling"]
    );
}

#[test]
fn kill_probability_names_its_metric_damage_mode_and_wilson_interval() {
    let kp = evaluate_objective(
        &max_character(126.0),
        &with(
            scenario(),
            [
                ("objective", s("kill-probability")),
                ("target", reference_foe(45.0, "tough")),
                ("health", n(500.0)),
                ("trials", n(MIN_STOCHASTIC_TRIALS)),
                ("maxSeconds", n(0.4)),
            ],
        ),
        &book(),
    )
    .expect("a sampled objective");
    assert_eq!(kp.get("objective"), &s("kill-probability"));
    assert_eq!(kp.get("metric"), &s("kill-probability"));
    assert_eq!(kp.get("unit"), &s("probability"));
    assert_eq!(f(kp.get("n")), MIN_STOCHASTIC_TRIALS);
    assert_eq!(f(kp.get("horizonSeconds")), 0.4);
    assert_eq!(kp.get("damageMode"), &s("uncapped"));
    assert_eq!(kp.get("detail").get("damageMode"), &s("uncapped"));
    let ci = kp.get("ci");
    assert_eq!(ci.get("metric"), &s("kill-probability"));
    assert_eq!(ci.get("method"), &s("wilson"));
    assert_eq!(f(ci.get("n")), f(kp.get("n")));
    let value = f(kp.get("value"));
    assert!(near(
        value,
        f(kp.get("detail").get("kills")) / f(kp.get("n"))
    ));
    assert!(f(ci.get("lo")) <= value && value <= f(ci.get("hi")));
    assert!(near(
        f(kp.get("detail").get("censored")),
        f(kp.get("n")) - f(kp.get("detail").get("kills"))
    ));
}

#[test]
fn fewer_than_the_declared_minimum_trials_is_refused() {
    let err = evaluate_objective(
        &max_character(126.0),
        &with(
            scenario(),
            [
                ("objective", s("stochastic-ttk")),
                ("target", reference_foe(45.0, "tough")),
                ("health", n(500.0)),
                ("trials", n(MIN_STOCHASTIC_TRIALS - 1.0)),
                ("maxSeconds", n(0.63)),
            ],
        ),
        &book(),
    )
    .expect_err("fewer than 1,000 trials is refused");
    assert!(err.contains("at least 1000 trials"), "{err}");
}
