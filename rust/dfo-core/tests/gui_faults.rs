//! The checked scenario entry, the Forge's boundary guard, and the bounds that keep a hand-made record from hanging the
//! port. LOCAL INVARIANTS: no vendored JS function prices these inputs (most of them the JS throws on), so the cases pin
//! the guard's shape, not a number the JS produces.

use dfo_core::analyze::{analyze, analyze_checked, ScenarioFault};
use dfo_core::fault::{guard, CoreFault};
use dfo_core::firmament_law::Tree;
use dfo_core::forge::{apply_tree_to_character, build_item, GearFault, GearSpec};
use dfo_core::model_blow::JsRangeError;
use dfo_core::spells::Spellbook;
use dfo_core::value::Value::{self, Arr, Null, Num, Obj, Str};

fn s(text: &str) -> Value {
    Str(text.to_owned())
}

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    Obj(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn theory() -> Value {
    dfo_core::theory::theory_character(&obj([("blade", Num(123.0))])).expect("theory character")
}

// ── 5. a wrong-shaped scenario is a typed fault ──────────────────────

#[test]
fn a_checked_scenario_refuses_what_would_panic() {
    let book = Spellbook::default();
    let ch = theory();
    // The reported case: `{"target": 5}` panicked in `analyze_card` (`Value::set` on a number).
    for (args, want) in [
        (
            obj([("target", Num(5.0))]),
            ScenarioFault::NotARecord("target"),
        ),
        (
            obj([("target", s("a target"))]),
            ScenarioFault::NotARecord("target"),
        ),
        (
            obj([("weapon", Num(1.0))]),
            ScenarioFault::NotARecord("weapon"),
        ),
        (
            obj([("traits", Num(2.0))]),
            ScenarioFault::NotAList("traits"),
        ),
        (
            obj([("imprints", s("echo"))]),
            ScenarioFault::NotAList("imprints"),
        ),
    ] {
        assert_eq!(analyze_checked(&ch, &args, &book).unwrap_err(), want);
    }
    assert_eq!(
        analyze_checked(&Num(1.0), &obj([]), &book).unwrap_err(),
        ScenarioFault::NotAnObject("the character")
    );
    assert_eq!(
        analyze_checked(&ch, &Null, &book).unwrap_err(),
        ScenarioFault::NotAnObject("the scenario")
    );
    // A typo is an absent key, which the JS prices as the reference foe: not a fault.
    assert!(analyze_checked(&ch, &obj([("targt", Num(5.0))]), &book).is_ok());
    // A valid scenario reaches exactly the plain card.
    let args = obj([("target", obj([("health", Num(4000.0))]))]);
    assert_eq!(
        analyze_checked(&ch, &args, &book).expect("valid").dps,
        analyze(&ch, &args, &book).dps,
        "the checked entry changes no number on a valid scenario"
    );
}

// ── 10. the boundary guard ──────────────────────────────────────────

#[test]
fn the_guard_turns_a_panic_into_a_typed_fault() {
    assert_eq!(guard(|| 6 * 7), Ok(42), "a clean call answers its value");
    assert_eq!(
        guard(|| panic!("a plain message")),
        Err(CoreFault::Message("a plain message".to_owned()))
    );
    let owned = "built".to_owned();
    assert_eq!(
        guard(move || panic!("{owned}")),
        Err(CoreFault::Panic("built".to_owned()))
    );
    assert_eq!(
        guard(|| std::panic::panic_any(JsRangeError("RangeError: nope".to_owned()))),
        Err(CoreFault::Range("RangeError: nope".to_owned()))
    );
    assert_eq!(
        guard(|| std::panic::panic_any(7_u8)),
        Err(CoreFault::Unknown)
    );
    // The hook is put back: a later panic in the process still reaches whatever hook a host installed.
    assert_eq!(guard(|| 1).unwrap(), 1);
}

// ── 7-9. the bounds ─────────────────────────────────────────────────

#[test]
fn a_trial_count_past_the_cap_is_a_range_error_not_an_allocation() {
    let fault = guard(|| dfo_core::simulate_fight::paired_fight_seeds(&Num(1e12), &Num(0.0)));
    assert!(matches!(fault, Err(CoreFault::Range(_))), "{fault:?}");
    // A legitimate count still generates.
    assert_eq!(
        dfo_core::simulate_fight::paired_fight_seeds(&Num(10.0), &Num(0.0)).len(),
        10
    );
}

#[test]
fn a_shortlist_trial_count_past_the_cap_is_refused() {
    use dfo_core::loadout_shortlist::ShortlistOpts;
    let opts = ShortlistOpts::from_value(&obj([("trials", Num(1e9)), ("k", Num(1.0))]));
    let book = Spellbook::default();
    let err = dfo_core::loadout_shortlist::shortlist_loadouts(&opts, &book).unwrap_err();
    assert!(err.contains("at most"), "{err}");
}

#[test]
fn a_fight_horizon_or_blow_budget_past_the_cap_is_a_range_error() {
    // A hand-made scenario must not spin the loop to the heat death of the universe.
    let ch = theory();
    let book = Spellbook::default();
    let base = obj([
        (
            "target",
            obj([("health", Num(4000.0)), ("maxHealth", Num(4000.0))]),
        ),
        ("health", Num(4000.0)),
        ("swing", s("StrikeDown")),
    ]);
    for extra in [
        obj([("maxSeconds", Num(1e9))]),
        obj([("maxBlows", Num(1e18))]),
    ] {
        let mut args = base.clone();
        for (k, v) in extra.entries() {
            args.set(k, v.clone());
        }
        let out = guard(|| dfo_core::simulate_fight::simulate_fight(&ch, &args, &book));
        assert!(matches!(out, Err(CoreFault::Range(_))), "{out:?}");
    }
    // A legal short fight prices.
    let mut args = base;
    args.set("maxSeconds", Num(1.0));
    args.set("maxBlows", Num(10.0));
    assert!(dfo_core::simulate_fight::simulate_fight(&ch, &args, &book).is_ok());
}

#[test]
fn a_material_count_past_the_cap_is_a_range_error() {
    let ch = theory();
    let book = Spellbook::default();
    let out = guard(|| {
        dfo_core::analyze::rank_weapons(
            &ch,
            &obj([]),
            &obj([("materials", Num(1e9)), ("top", Num(3.0))]),
            &book,
        )
    });
    assert!(matches!(out, Err(CoreFault::Range(_))), "{out:?}");
}

#[test]
fn an_echo_list_past_the_cap_is_a_range_error_not_an_exponential_loop() {
    let echoes: Vec<Value> = (0..40).map(|_| Num(10.0)).collect();
    let out = guard(|| {
        dfo_core::model_blow::after_share(10.0, 1.0, &Num(1.0), &obj([("echoes", Arr(echoes))]))
    });
    assert!(matches!(out, Err(CoreFault::Range(_))), "{out:?}");
}

#[test]
fn a_weapon_line_that_is_not_a_number_is_refused_by_the_spec_reader() {
    // A GUI hands over the record it holds; a non-record line is a spec fault, not a silent drop.
    let spec = obj([
        ("template", Num(123.0)),
        ("material", Num(9.0)),
        ("rarity", s("rare")),
        ("lines", Arr(vec![Num(25.0)])),
    ]);
    assert!(matches!(
        GearSpec::from_value(&spec),
        Err(GearFault::Spec(_))
    ));
    assert!(build_item(&GearSpec::lines_of(123.0, 9.0, "rare", vec![Num(25.0)])).is_err());
}

#[test]
fn applying_a_tree_twice_is_refused_and_a_bad_character_is_typed() {
    let ch = theory();
    let tree = Tree {
        start: Some("sp.start".into()),
        keys: vec![],
    };
    let once = apply_tree_to_character(&ch, &s("longblade"), &tree).expect("first");
    assert!(matches!(
        apply_tree_to_character(&once, &s("longblade"), &tree),
        Err(dfo_core::forge::ApplyFault::AlreadyCarriesTree)
    ));
    assert!(matches!(
        apply_tree_to_character(&s("not a character"), &s("longblade"), &tree),
        Err(dfo_core::forge::ApplyFault::NotACharacter)
    ));
}
