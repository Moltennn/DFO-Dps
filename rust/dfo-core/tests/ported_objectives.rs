//! Ported from `test/objectives.test.js` (Parts A and C): the metric semantics and the named objectives.
//!
//! LOCAL INVARIANTS on the JS file's own scenario (a3eb1605, `gameBuild: '14512'`), which it pins deliberately.

mod ported_common;

use dfo_core::objectives::{evaluate_objective, rank_builds, target_assumptions, OBJECTIVE_IDS};
use ported_common::*;

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
fn metric_semantics_kill_rate_output_rate_and_the_expected_blow_are_distinct() {
    let card = dfo_core::fight::fight(
        &max_character(127.0),
        &with(
            scenario(),
            [
                ("target", reference_foe(45.0, "tough")),
                ("health", n(12000.0)),
            ],
        ),
        &book(),
    );
    let field_num = |k: &str| card.get(k).to_number();
    assert_eq!(
        card.get("killDps"),
        card.get("dps"),
        "killDps is the 2.12a `dps`"
    );
    let ttk = field_num("ttk");
    assert!(near_eps(
        field_num("killDps"),
        field_num("health") / ttk,
        1e-9
    ));
    let (overkill, per_swing, blows) = (
        field_num("overkill"),
        field_num("expectedPerSwing"),
        field_num("blows"),
    );
    assert!(
        near_eps(overkill, per_swing * blows - field_num("health"), 1e-9),
        "overkill is dealt - health"
    );
    let (output, kill) = (field_num("outputDps"), field_num("killDps"));
    assert!(
        output > kill,
        "the damage rate is above the kill rate by the last blow"
    );
    assert!(
        near_eps(output / kill, 1.0 + overkill / field_num("health"), 1e-9),
        "exactly the overkill share"
    );
    assert!(overkill > 0.0 && overkill < per_swing * 2.0);

    // A bigger pool: the same blow, less relative overkill - the two rates converge.
    let big = dfo_core::fight::fight(
        &max_character(127.0),
        &with(
            scenario(),
            [
                ("target", reference_foe(45.0, "tough")),
                ("health", n(120000.0)),
            ],
        ),
        &book(),
    );
    let big_overkill = f(big.get("overkill"));
    let big_health = f(big.get("health"));
    assert!(big_overkill / big_health < overkill / field_num("health") / 5.0);
    assert!(f(big.get("outputDps")) / f(big.get("killDps")) < 1.01);
}

#[test]
fn every_objective_is_named_and_every_result_says_its_target() {
    let target = gate_target(45.0);
    for objective in OBJECTIVE_IDS {
        let r = evaluate_objective(
            &max_character(121.0),
            &with(
                scenario(),
                [
                    ("objective", s(objective)),
                    ("target", target.clone()),
                    ("health", target.get("maxHealth").clone()),
                ],
            ),
            &book(),
        )
        .expect("an objective");
        assert_eq!(r.get("objective"), &s(objective));
        assert_eq!(r.get("direction"), &s("max"));
        assert_eq!(r.get("unit"), &s("dps"));
        assert_eq!(r.get("assumptions").get("objective"), &s(objective));
        let kind = if target.get("allowance").truthy() {
            "relay"
        } else {
            "foe"
        };
        assert_eq!(r.get("assumptions").get("target").get("kind"), &s(kind));
        assert_eq!(
            f(r.get("assumptions").get("target").get("mobileType")),
            31.0
        );
        assert_eq!(
            f(r.get("assumptions")
                .get("target")
                .get("allowance")
                .get("level")),
            45.0
        );
        let value = f(r.get("value"));
        assert!(value.is_finite() && value > 0.0);
        assert!(
            r.get("assumptions").get("basis").to_js_string().len() > 10,
            "the basis is stated"
        );
    }
    assert_eq!(
        target_assumptions(&reference_foe(45.0, "tough")).get("kind"),
        &s("foe")
    );
    assert_eq!(
        target_assumptions(&gate_target(45.0)).get("kind"),
        &s("relay")
    );
    let unknown = evaluate_objective(
        &max_character(121.0),
        &with(
            scenario(),
            [("objective", s("boss-dps")), ("target", target.clone())],
        ),
        &book(),
    )
    .expect_err("an unknown objective is refused");
    assert!(unknown.contains("unknown objective"), "{unknown}");
    let wrong_body = evaluate_objective(
        &max_character(121.0),
        &with(
            scenario(),
            [
                ("objective", s("relay")),
                ("target", reference_foe(45.0, "tough")),
            ],
        ),
        &book(),
    )
    .expect_err("a relay objective on a foe is refused");
    assert!(wrong_body.contains("not a relay body"), "{wrong_body}");
    let no_target = evaluate_objective(
        &max_character(121.0),
        &with(scenario(), [("objective", s("snapshot"))]),
        &book(),
    )
    .expect_err("a missing target is refused");
    assert!(
        no_target.contains("a declared target is required"),
        "{no_target}"
    );
}

#[test]
fn no_implicit_switching_snapshot_and_whole_fight_orderings_can_differ() {
    let book = book();
    let entries: Vec<Value> = [126.0, 117.0, 121.0]
        .into_iter()
        .map(|t| obj([("id", n(t)), ("ch", max_character(t))]))
        .collect();
    let snap = rank_builds(
        &entries,
        &with(
            scenario(),
            [
                ("objective", s("snapshot")),
                ("target", reference_foe(45.0, "tough")),
            ],
        ),
        &book,
    )
    .expect("a snapshot ranking");
    let walk = rank_builds(
        &entries,
        &with(
            scenario(),
            [
                ("objective", s("fight")),
                ("target", reference_foe(45.0, "tough")),
                ("health", n(12000.0)),
            ],
        ),
        &book,
    )
    .expect("a fight ranking");
    assert_eq!(snap.get("objective"), &s("snapshot"));
    assert_eq!(walk.get("objective"), &s("fight"));
    assert_eq!(
        f(snap.get("health")),
        f(reference_foe(45.0, "tough").get("maxHealth")),
        "the ranking records the pool it was declared against"
    );
    let order = |r: &Value| -> Vec<f64> {
        r.get("rows")
            .items()
            .iter()
            .map(|row| f(row.get("id")))
            .collect()
    };
    let (so, wo) = (order(&snap), order(&walk));
    assert!(
        so.iter().position(|v| *v == 126.0) < so.iter().position(|v| *v == 117.0),
        "snapshot order {so:?}"
    );
    assert!(
        wo.iter().position(|v| *v == 117.0) < wo.iter().position(|v| *v == 126.0),
        "fight order {wo:?}"
    );
    let first_assumptions = walk.get("rows").at(0).get("assumptions").clone();
    for row in walk.get("rows").items() {
        assert_eq!(row.get("assumptions"), &first_assumptions);
    }
    for (i, row) in walk.get("rows").items().iter().enumerate() {
        assert_eq!(f(row.get("rank")), (i + 1) as f64);
    }
}

#[test]
fn relay_aware_and_uncapped_orderings_differ() {
    let book = book();
    let target = gate_target(45.0);
    let entries: Vec<Value> = [563.0, 121.0, 117.0, 116.0, 113.0, 126.0, 123.0]
        .into_iter()
        .map(|t| obj([("id", n(t)), ("ch", max_character(t))]))
        .collect();
    let opts = |objective: &str| {
        with(
            scenario(),
            [
                ("objective", s(objective)),
                ("target", target.clone()),
                ("health", target.get("maxHealth").clone()),
            ],
        )
    };
    let uncapped = rank_builds(&entries, &opts("snapshot"), &book).expect("an uncapped ranking");
    let ceiling = rank_builds(&entries, &opts("relay-ceiling"), &book).expect("a ceiling ranking");
    let relay = rank_builds(&entries, &opts("relay"), &book).expect("a relay ranking");
    let order = |r: &Value| -> Vec<f64> {
        r.get("rows")
            .items()
            .iter()
            .map(|row| f(row.get("id")))
            .collect()
    };
    let by_id = |r: &Value| -> Vec<(f64, f64)> {
        r.get("rows")
            .items()
            .iter()
            .map(|row| (f(row.get("id")), f(row.get("value"))))
            .collect()
    };
    assert_eq!(
        order(&uncapped)[0],
        123.0,
        "uncapped {:?}",
        order(&uncapped)
    );
    assert_eq!(order(&ceiling)[0], 117.0, "ceiling {:?}", order(&ceiling));
    assert_ne!(order(&uncapped), order(&ceiling));
    // The relay's kill rate collapses: the top few are within a couple of per cent.
    let top: Vec<f64> = relay
        .get("rows")
        .items()
        .iter()
        .take(4)
        .map(|row| f(row.get("value")))
        .collect();
    let hi = top.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let lo = top.iter().copied().fold(f64::INFINITY, f64::min);
    assert!((hi - lo) / hi < 0.02, "relay top-4 spread");
    for row in relay.get("rows").items() {
        assert!(row.get("detail").get("saturated").truthy());
    }
    let (rv, cv) = (by_id(&relay), by_id(&ceiling));
    let value = |rows: &[(f64, f64)], id: f64| rows.iter().find(|(k, _)| *k == id).unwrap().1;
    assert!((value(&rv, 117.0) / value(&rv, 126.0) - 1.0).abs() < 0.02);
    assert!(value(&cv, 117.0) > value(&cv, 126.0) * 2.0);
    for row in relay.get("rows").items() {
        assert!(matches!(row.get("detail").get("saturated"), Value::Bool(_)));
        assert!(f(row.get("detail").get("marginDps")).is_finite());
        assert_eq!(f(row.get("detail").get("cap")), f(target.get("hitCap")));
    }
    assert_ne!(order(&relay), order(&uncapped));
}

#[test]
fn a_ranking_is_deterministic_and_refuses_mixed_target_conditions() {
    let book = book();
    let opts = with(
        scenario(),
        [
            ("objective", s("fight")),
            ("target", reference_foe(45.0, "tough")),
            ("health", n(12000.0)),
        ],
    );
    let entries = || {
        vec![
            obj([("id", n(121.0)), ("ch", max_character(121.0))]),
            obj([("id", n(126.0)), ("ch", max_character(126.0))]),
        ]
    };
    let a = rank_builds(&entries(), &opts, &book).expect("a ranking");
    let b = rank_builds(&entries(), &opts, &book).expect("a ranking");
    assert_eq!(a, b);
    let mixed = rank_builds(
        &[
            obj([("id", s("a")), ("ch", max_character(121.0))]),
            obj([
                ("id", s("b")),
                ("ch", max_character(121.0)),
                ("scenario", obj([("target", gate_target(45.0))])),
            ]),
        ],
        &with(
            scenario(),
            [
                ("objective", s("snapshot")),
                ("target", reference_foe(45.0, "tough")),
            ],
        ),
        &book,
    )
    .expect_err("mixed target conditions are refused");
    assert!(mixed.contains("different target assumptions"), "{mixed}");
}

#[test]
fn a_row_that_cannot_be_evaluated_is_kept_and_marked() {
    let book = book();
    let rows = rank_builds(
        &[
            obj([("id", n(121.0)), ("ch", max_character(121.0))]),
            obj([("id", n(126.0)), ("ch", max_character(126.0))]),
        ],
        &with(
            scenario(),
            [
                ("objective", s("relay")),
                ("target", reference_foe(45.0, "tough")),
            ],
        ),
        &book,
    )
    .expect("a ranking with failing rows");
    assert_eq!(rows.get("rows").items().len(), 2);
    for row in rows.get("rows").items() {
        let error = row.get("error").to_js_string();
        assert!(error.contains("not a relay body"), "{error}");
        assert!(row.get("rank").is_nullish());
    }
}
