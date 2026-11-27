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
    // The CLI's own ceiling is accepted by the core, so a GUI can pass what the CLI passes.
    assert_eq!(
        dfo_core::simulate_fight::paired_fight_seeds(
            &Num(dfo_core::simulate_fight::MAX_FIGHT_SEEDS),
            &Num(0.0)
        )
        .len(),
        1_000_000
    );
    // A legitimate count still generates.
    assert_eq!(
        dfo_core::simulate_fight::paired_fight_seeds(&Num(10.0), &Num(0.0)).len(),
        10
    );
}

#[test]
fn a_shortlist_trial_count_the_cli_accepts_is_not_refused_by_the_core() {
    use dfo_core::loadout_shortlist::{shortlist_loadouts, ShortlistOpts};
    // The CLI's `--trials` ceiling (`dfo-cli`'s `MAX_STOCHASTIC_TRIALS`) is 1,000,000; the core's cap must be at least
    // that or it refuses a command line the CLI accepts. One past the cap is the boundary that must refuse (the guard
    // runs before any fight is sampled, so this is cheap).
    let cap = dfo_core::simulate_fight::MAX_FIGHT_SEEDS;
    assert!(
        cap >= 1_000_000.0,
        "the core cap must cover the CLI's own --trials ceiling"
    );
    let book = Spellbook::default();
    let past = ShortlistOpts::from_value(&obj([
        (
            "trials",
            Num(dfo_core::simulate_fight::MAX_FIGHT_SEEDS + 1.0),
        ),
        ("k", Num(1.0)),
    ]));
    let err = shortlist_loadouts(&past, &book).unwrap_err();
    assert!(err.contains("at most"), "{err}");
    // At the cap the trials check passes: the refusal (if any) is about something else.
    let at = ShortlistOpts::from_value(&obj([
        ("trials", Num(dfo_core::simulate_fight::MAX_FIGHT_SEEDS)),
        ("k", Num(0.0)),
    ]));
    let err = shortlist_loadouts(&at, &book).unwrap_err();
    assert!(
        !err.contains("trials"),
        "1,000,000 trials is not refused: {err}"
    );
}

#[test]
fn a_requested_horizon_or_budget_the_cli_accepts_is_priced_by_work_not_refused() {
    // The CLI accepts ANY positive finite `--max-seconds` and any positive safe-integer `--max-blows`
    // (`dfo-cli`'s `sampled_options`), so the core cannot refuse the REQUEST. A fight that ends early must price, and
    // 100,000,000 seconds is what the CLI's help shows as legal.
    let book = Spellbook::default();
    let ch = theory();
    let args = obj([
        (
            "target",
            obj([("health", Num(40.0)), ("maxHealth", Num(40.0))]),
        ),
        ("health", Num(40.0)),
        ("swing", s("StrikeDown")),
        ("maxSeconds", Num(100_000_000.0)),
        ("maxBlows", Num(9_007_199_254_740_991.0)),
    ]);
    let row =
        dfo_core::simulate_fight::simulate_fight(&ch, &args, &book).expect("a short fight prices");
    assert!(row.get("kill").truthy(), "the boss dies quickly: {row:?}");
    assert!(
        row.get("blows").to_number() < 1_000.0,
        "the fight ends on the kill, far short of the request"
    );
    // The work guards themselves: the message a GUI sees, and the caps' edges. (Running the 100-million-blow arm end to
    // end is minutes of real blows, so the cap's WIRING is what this pins; the fight above proves the accepted request
    // reaches the same code.)
    match guard(|| {
        dfo_core::simulate_fight::past_work_cap("blow", dfo_core::simulate_fight::MAX_FIGHT_BLOWS)
    }) {
        Err(CoreFault::Range(message)) => {
            assert!(message.contains("blow"), "{message}");
            assert!(message.contains("100000000"), "{message}");
        }
        other => panic!("the work cap must be a RangeError: {other:?}"),
    }
    assert_eq!(dfo_core::simulate_fight::MAX_FIGHT_BLOWS, 100_000_000.0);
    // 5 s rounds: about 58 days of billed damage before the round cap.
    assert_eq!(
        dfo_core::simulate_fight::MAX_FIGHT_ROUNDS * 5.0,
        5_000_000.0
    );
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

// ── 4. a batch's shared cache is bounded at every fight ─────────────

#[test]
fn a_durability_batch_does_not_grow_its_shared_cache_with_every_fight() {
    // `simulate_fights` shares ONE cache across seeds. Each fight numbers its own items and restarts `epoch` at 0, so the
    // wear keys of the previous fight can never be asked for again; without a per-fight clear the map grows by one entry
    // per (item, band) per SEED (the review's finding). The FIXED keys are pure functions of the shared scenario, so they
    // survive and the batch keeps its reuse.
    use dfo_core::simulate_fight::{create_tier_cache, FightRolls};
    let book = Spellbook::default();
    let mut ch = theory();
    // A durable, worn main hand: the durability path is what creates `Wearing` keys.
    let mut weapon = ch.get("weapon").clone();
    weapon.set("maxCondition", Num(100.0));
    weapon.set("currentCondition", Num(100.0));
    ch.set("weapon", weapon.clone());
    ch.set("worn", Arr(vec![weapon]));
    let args = obj([
        (
            "target",
            obj([("health", Num(5000.0)), ("maxHealth", Num(5000.0))]),
        ),
        ("health", Num(5000.0)),
        ("swing", s("StrikeDown")),
        ("durability", Value::Bool(true)),
        ("maxBlows", Num(12.0)),
        ("maxSeconds", Num(60.0)),
    ]);
    let mut cache = create_tier_cache();
    let mut sizes = Vec::new();
    for seed in 0..40 {
        let mut run = args.clone();
        run.set("seed", Num(seed as f64));
        dfo_core::simulate_fight::simulate_fight_cached(
            &ch,
            &run,
            &book,
            &mut cache,
            FightRolls::default(),
        )
        .expect("a legal short fight");
        sizes.push(cache.cached_tiers());
    }
    // Without the per-fight clear this grows with the seed count (one `(epoch, item, band)` triple per fight at least).
    // With it, the map is the fixed tiers plus the current fight's wear entries: a small constant, not a slope.
    let after_warmup = sizes[10];
    assert!(
        *sizes.last().unwrap() <= after_warmup,
        "the cache must not grow per fight: {sizes:?}"
    );
    assert!(
        after_warmup <= 64,
        "a short durability fight holds a few dozen tiers: {sizes:?}"
    );
    // The reuse is still there: the fixed keys are not thrown away, so the map is non-empty after a fight.
    assert!(after_warmup > 0, "{sizes:?}");
}

// ── 5. a NaN roll range does not excuse a huge add count ─────────────

#[test]
fn a_non_numeric_weapon_bound_does_not_unbind_the_gear_enumeration() {
    // The reported case: `min` is not a number, so the roll range is NaN, with a ~1e12 gear add. `check_enumeration` used
    // to return on the NaN roll count and then loop the adds forever; it must refuse on the ADD count first (the JS
    // `Array.from({ length: adds })` is what allocates, whatever the rolls are).
    use dfo_core::model_blow::{damage_model, gear_blow_add, Carry};
    use dfo_core::target::Target;
    use dfo_core::value::Value::{Bool, Str};
    // A 14631 online attacker with a huge gear skill bonus on the weapon's skill id: the add range is ~1e12 wide.
    let ch = obj([
        ("online", Bool(true)),
        ("skills", obj([("29", Num(200.0)), ("30", Num(200.0))])),
        ("masterSkills", Bool(true)),
        ("masteredSkills", Arr(vec![Num(29.0), Num(30.0)])),
        (
            "_mods",
            obj([("skills", obj([("29", Num(5e12)), ("30", Num(5e12))]))]),
        ),
        (
            "stats",
            obj([
                ("strength", Num(50.0)),
                ("speed", Num(50.0)),
                ("agility", Num(50.0)),
            ]),
        ),
    ]);
    let mut w = obj([
        ("skillId", Num(29.0)),
        ("min", Str("x".to_owned())),
        ("max", Num(100.0)),
        ("damagePct", Num(0.0)),
        ("bonusDamage", Num(0.0)),
        ("material", Num(1.0)),
        ("twoHanded", Bool(false)),
        ("powers", Arr(vec![])),
    ]);
    let opts = obj([("gameBuild", s("14631")), ("core", s("classic"))]);
    let t = Target::default();
    let gear = gear_blow_add(&ch, &w, Some(&t), &opts);
    assert!(
        gear.is_some_and(|(lo, hi)| hi - lo > 1e9),
        "the fixture's add range is huge: {gear:?}"
    );
    // Rendering the weapon's bound as a non-number, as a hand-made record can.
    w.set("min", Str("x".to_owned()));
    let out = guard(|| {
        damage_model(
            &ch,
            &w,
            Some(&t),
            "StrikeLeft",
            "classic",
            &opts,
            &mut Carry::default(),
        )
    });
    match out {
        Err(CoreFault::Range(message)) => {
            assert!(
                message.contains("array length") || message.contains("stack"),
                "{message}"
            );
        }
        other => panic!("a huge add with a NaN roll must refuse, not allocate: {other:?}"),
    }
}
