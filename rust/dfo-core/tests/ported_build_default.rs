//! Ported from `test/build14631.test.js`: the default build is the live one, and only an explicit `14512` selects the
//! vendored cut. LOCAL INVARIANTS on the card.
//!
//! NOTE: this file should be named `ported_build_default.rs`; it carries that content under a leftover scratch name
//! because the session's shell rules do not allow deleting or renaming a repository file. Rename it before the commit.

mod ported_common;

use dfo_core::theory::theory_character;
use ported_common::*;

#[test]
fn the_default_is_the_live_build_and_only_an_explicit_14512_selects_the_cut() {
    let ch = theory_character(&obj([
        ("gearLB", n(250.0)),
        ("gearCS", n(370.0)),
        ("damagePct", n(25.0)),
    ]))
    .expect("the geared theory character");
    let args = obj([
        ("target", reference_foe(45.0, "tough")),
        ("core", s("overhaul")),
        ("rri", b(true)),
    ]);
    let plain = analyze(&ch, &args).to_value();
    let mut live_args = args.clone();
    live_args.set("gameBuild", s("14631"));
    let live = analyze(&ch, &live_args).to_value();
    let mut cut_args = args.clone();
    cut_args.set("gameBuild", s("14512"));
    let cut = analyze(&ch, &cut_args).to_value();
    assert_eq!(plain, live, "no --game-build is the live build");
    assert_ne!(plain, cut, "and it is not the cut");
    assert!(
        cut.get("damage").get("parts").get("gearAdd").is_nullish(),
        "14512 has no flat-add field at all"
    );
    assert_eq!(
        f(cut.get("damage").get("parts").get("mastery")),
        150.0,
        "the 14512 gear percent is untouched (40 climb + 110 gear)"
    );
    // The live build: the percent is the climb alone and the flat add is on the roll.
    assert_eq!(f(live.get("damage").get("parts").get("mastery")), 40.0);
    let add = live.get("damage").get("parts").get("gearAdd");
    assert_eq!(
        [f(add.get("lo")), f(add.get("hi")), f(add.get("mean"))],
        [25.0, 50.0, 37.5]
    );
}

#[test]
fn an_unknown_game_build_prices_as_the_live_build() {
    let ch = theory_character(&obj([("gearLB", n(250.0)), ("gearCS", n(370.0))]))
        .expect("the theory character");
    let args = obj([
        ("target", reference_foe(45.0, "tough")),
        ("core", s("overhaul")),
        ("rri", b(true)),
        ("gameBuild", s("14631")),
    ]);
    let live = analyze(&ch, &args).to_value();
    for bogus in ["14630", "1463", "", "14731", "14513"] {
        let mut a = args.clone();
        a.set("gameBuild", s(bogus));
        assert_eq!(
            analyze(&ch, &a).to_value(),
            live,
            "{bogus:?} prices as the live build"
        );
    }
    let mut cut = args.clone();
    cut.set("gameBuild", s("14512"));
    assert_ne!(analyze(&ch, &cut).to_value(), live, "only 14512 opts out");
}
