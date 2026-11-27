//! GUI-facing boundary findings: the Forge API's own contract, the sidebar's unknown propagation, the gear builder's
//! strictness, and the panics a GUI can reach from a malformed record. Every case here is a LOCAL INVARIANT (no vendored
//! JS function prices these inputs); the golden vectors and JS parity are untouched.
//!
//! Items that would differ from the JS on inputs the JS prices are fixed in the Rust-only Forge/API layer and documented
//! in `rust/FORGE-API.md` (the empty sky, the second application of a tree, and `build_item`'s strict spec checks).

use dfo_core::firmament::plan_summary;
use dfo_core::firmament_law::Tree;
use dfo_core::forge::{apply_tree_to_character, build_item, tree_plan, GearFault, GearSpec};
use dfo_core::sidebar::{
    affix_armor_points, armor_fold_parts, firmament_layer, Fact, Imported, Sky,
};
use dfo_core::value::Value::{self, Arr, Null, Num, Obj, Str};

fn s(text: &str) -> Value {
    Str(text.to_owned())
}

/// An object from its pairs, in order (`Obj` is the JS object literal).
fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    Obj(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn line(id: &str, param: Option<&str>, value: Value) -> Value {
    let mut a = obj([("id", s(id))]);
    if let Some(p) = param {
        a.set("param", s(p));
    }
    a.set("value", value);
    a
}

fn theory() -> Value {
    dfo_core::theory::theory_character(&obj([("blade", Num(123.0))])).expect("theory character")
}

fn stat(ch: &Value, key: &str) -> f64 {
    ch.get("_mods").get("stats").get(key).finite_or(0.0)
}

// ── 1. the empty tree is no sign ─────────────────────────────────────

#[test]
fn an_empty_tree_applies_no_sign() {
    let ch = theory();
    let applied = apply_tree_to_character(&ch, &s("longblade"), &Tree::empty())
        .expect("the empty tree is a whole tree");
    assert_eq!(
        stat(&applied, "luck"),
        stat(&ch, "luck"),
        "the empty sky is no sign: the Serpent's +2 luck must not land"
    );
    assert_eq!(
        applied.get("firmamentDamagePct"),
        &Num(0.0),
        "no sign leaves no tree blow"
    );
    // The plan a GUI shows for the same tree carries no sign and no channels.
    let plan = tree_plan(&s("longblade"), &Tree::empty()).expect("empty plan");
    assert_eq!(plan.get("totals"), &obj([]));
    assert_eq!(plan.get("tree").get("start"), &Null);
}

// ── 2. a second application is refused, not stacked ──────────────────

#[test]
fn a_second_application_is_refused_instead_of_stacking() {
    let ch = theory();
    let tree = Tree {
        start: Some("sp.start".into()),
        keys: vec![],
    };
    let once = apply_tree_to_character(&ch, &s("longblade"), &tree).expect("first apply");
    assert_eq!(
        stat(&once, "luck") - stat(&ch, "luck"),
        2.0,
        "the Serpent is +2 luck once"
    );
    assert!(
        apply_tree_to_character(&once, &s("longblade"), &tree).is_err(),
        "a character that already carries a Forge tree is refused, never folded twice"
    );
    // A non-object character is a typed fault, not the `Value::set` panic.
    assert!(apply_tree_to_character(&Null, &s("longblade"), &tree).is_err());
}

// ── 3. absent totals are unknown, not a zero sky ─────────────────────

fn known_facts() -> Imported {
    Imported {
        max_health: Fact::Known(240.0),
        max_magicka: Fact::Known(77.0),
        health: Fact::Known(180.0),
        magicka: Fact::Known(40.0),
        level: Fact::Known(10.0),
        endurance: Fact::Known(60.0),
        hit_points_per_level: Fact::Known(12.0),
        spell_point_bitfield: Fact::Known(4096.0),
        intelligence: Fact::Known(77.0),
        worn: vec![],
        enchant_mods: Null,
    }
}

#[test]
fn absent_totals_are_unknown_not_a_zero_sky() {
    let facts = known_facts();
    for totals in [Value::Undefined, Null, Num(1.0), Arr(vec![]), s("totals")] {
        let sky = firmament_layer(&facts, &totals);
        assert_eq!(
            sky,
            Sky {
                hp: Fact::Unknown,
                mp: Fact::Unknown,
                even: Fact::Unknown
            },
            "totals {totals:?} are absent, so the sky is unknown (not the sky asleep)"
        );
    }
    // An explicitly present (even empty) totals object is the law's own zero sky.
    let sky = firmament_layer(&facts, &obj([]));
    assert_eq!(sky.hp, Fact::Known(0.0));
    assert_eq!(sky.mp, Fact::Known(0.0));
}

// ── 4. build_item refuses a spec the game would never mint ───────────

#[test]
fn build_item_refuses_illegal_affix_values() {
    // A value must be a finite number: a string and a negative are refused (validatePlan only checks the top).
    assert!(build_item(&GearSpec::lines_of(
        123.0,
        9.0,
        "rare",
        vec![line("damage", None, s("25"))]
    ))
    .is_err());
    assert!(build_item(&GearSpec::lines_of(
        123.0,
        9.0,
        "rare",
        vec![line("damage", None, Num(-5.0))]
    ))
    .is_err());
    // A line that is not a record is refused, not silently dropped.
    assert!(build_item(&GearSpec::lines_of(123.0, 9.0, "rare", vec![Num(25.0)])).is_err());
    // A fractional template is not a template (it used to truncate onto armour row 102).
    assert!(matches!(
        build_item(&GearSpec::lines_of(102.5, 0.0, "rare", vec![])),
        Err(GearFault::UnknownTemplate(_))
    ));
    // A material its group has no ladder for is refused.
    assert!(build_item(&GearSpec::lines_of(
        123.0,
        1000.0,
        "rare",
        vec![line("damage", None, Num(25.0))]
    ))
    .is_err());
    assert!(build_item(&GearSpec::legendary(102.0, -1.0, "the-warden")).is_err());
    // The affix kind must be a real kind: an unknown id is refused by `validatePlan` already.
    assert!(build_item(&GearSpec::lines_of(
        123.0,
        9.0,
        "rare",
        vec![line("nonsense", None, Num(5.0))]
    ))
    .is_err());
    // A legal spec still builds, including a line at the band floor and one below it that the JS mints (the golden
    // corpus prices that shape, so this stays legal; see FORGE-API.md).
    assert!(build_item(&GearSpec::lines_of(
        123.0,
        9.0,
        "rare",
        vec![line("damage", None, Num(25.0))]
    ))
    .is_ok());
    assert!(build_item(&GearSpec::lines_of(
        123.0,
        9.0,
        "rare",
        vec![line("damage", None, Num(5.0))]
    ))
    .is_ok());
}

// ── 6. the armour fold counts a piece once ───────────────────────────

fn armour_piece(template: f64, slot: f64, armour: f64, legendary: Option<&str>) -> Value {
    let mut it = obj([
        ("group", s("Armor")),
        ("templateIndex", Num(template)),
        ("material", Num(0.0)),
        ("equipSlot", Num(slot)),
        ("affixes", Arr(vec![line("armor", None, Num(armour))])),
    ]);
    if let Some(id) = legendary {
        it.set("rarity", s("legendary"));
        it.set("legendary", s(id));
    }
    it
}

#[test]
fn the_armour_fold_skips_a_duplicate_slot_and_a_duplicate_legendary() {
    // Two pieces claiming one equipSlot: the equip table keeps the first, so the fold adds only its 15.
    let first = armour_piece(102.0, 18.0, 15.0, None);
    let second = armour_piece(102.0, 18.0, 12.0, None);
    assert_eq!(
        affix_armor_points(&[first.clone(), second.clone()]),
        affix_armor_points(std::slice::from_ref(&first)),
        "a stale duplicate slot adds nothing"
    );
    assert_eq!(affix_armor_points(std::slice::from_ref(&first))[3], 15.0);
    assert_eq!(
        armor_fold_parts(&[first, second], &[0.0; 7])[3],
        15.0,
        "the fold keeps the first piece's 15"
    );
    // A Legendary record counts once (the vendor's `countedPieces`): two copies, two slots, one line.
    let copy_a = armour_piece(102.0, 18.0, 12.0, Some("the-warden"));
    let copy_b = armour_piece(102.0, 21.0, 12.0, Some("the-warden"));
    assert_eq!(
        affix_armor_points(&[copy_a.clone(), copy_b.clone()])[3],
        12.0,
        "the second copy of one Legendary adds no line"
    );
}

/// The vendor's order (`equip.js:360-367`, `lootRarity.js:2356-2362`): the equip table drops a slot loser FIRST, the
/// table is in SLOT order, pieces with no affix list are filtered, and only then does `countedPieces` keep a Legendary's
/// first copy. A fold that counts before the slot rule, or does not sort first, keeps a different copy.
#[test]
fn the_armour_fold_counts_in_the_vendors_order() {
    let plain = armour_piece(102.0, 18.0, 12.0, None);
    let warden_at = |slot: f64, template: f64, armour: f64| {
        armour_piece(template, slot, armour, Some("the-warden"))
    };
    // [plain@18, warden@18, warden@26]: the slot loser is the SECOND warden, so the pair that survives is
    // [plain@18, warden@26] and BOTH lines count (chest 12, feet 20). Every value is inside the `armor` band (top 20), so
    // no line is dropped by `validAffix` and the case cannot pass by that route.
    let fold = affix_armor_points(&[
        plain.clone(),
        warden_at(18.0, 102.0, 15.0),
        warden_at(26.0, 108.0, 20.0),
    ]);
    assert_eq!(fold[3], 12.0, "the plain cuirass's 12 on the chest");
    assert_eq!(fold[6], 20.0, "the surviving warden's 20 on the feet");
    // [warden@26, warden@18]: sorted by slot, the first copy of the record is the one at slot 18, so 15 lands on the
    // chest and the feet get nothing. Counting before sorting would keep the @26 copy instead.
    let fold = affix_armor_points(&[warden_at(26.0, 108.0, 20.0), warden_at(18.0, 102.0, 15.0)]);
    assert_eq!(fold[3], 15.0, "the slot-18 copy is the one that counts");
    assert_eq!(fold[6], 0.0, "the @26 copy of the same record adds nothing");
    // A copy with no affix list is filtered BEFORE `countedPieces`, so it does not consume the record: the copy that
    // carries the line counts. (The fold's rule is `wornItems`' filter, not just `readLines`' fallback.)
    let mut bare = armour_piece(102.0, 18.0, 0.0, Some("the-warden"));
    bare.set("affixes", Arr(vec![]));
    let fold = affix_armor_points(&[bare, warden_at(26.0, 108.0, 20.0)]);
    assert_eq!(fold[6], 20.0, "the copy that carries the line counts");
}

// ── the panics a GUI can reach from a malformed record ───────────────

#[test]
fn a_fight_with_no_samples_summarizes_as_null() {
    assert_eq!(
        dfo_core::probe::fight_summary(&[], &obj([])),
        Null,
        "an empty capture has no summary; it must not panic"
    );
}

#[test]
fn a_non_array_active_effects_list_does_not_panic_a_cast() {
    use dfo_core::cws::{resolve_cws_cast, Cast, Caster};
    use dfo_core::rolls::Rolls;
    struct Half;
    impl Rolls for Half {
        fn roll(&mut self) -> f64 {
            0.5
        }
    }
    let mut target = obj([
        ("activeEffects", Num(5.0)),
        ("health", Num(500.0)),
        ("maxHealth", Num(500.0)),
        ("armorValues", Arr((0..7).map(|_| Num(0.0)).collect())),
    ]);
    let effect = obj([
        ("type", Num(1.0)),
        ("subType", Num(0.0)),
        ("magnitudeBaseLow", Num(10.0)),
        ("magnitudeBaseHigh", Num(10.0)),
        ("magnitudeLevelBase", Num(0.0)),
        ("magnitudeLevelHigh", Num(0.0)),
        ("magnitudePerLevel", Num(0.0)),
        ("durationBase", Num(10.0)),
    ]);
    let spell = obj([
        ("effects", Arr(vec![effect])),
        ("element", Num(4.0)),
        ("rangeType", Num(0.0)),
        ("name", s("Stock")),
    ]);
    let cast = resolve_cws_cast(
        &spell,
        &mut target,
        &Cast {
            caster: Caster::Absent,
            level: 10.0,
            pierce: 0.0,
            potency_pct: 0.0,
        },
        &mut Half,
        None,
    );
    assert!(
        cast.truthy(),
        "the cast still resolves; a malformed effect list is replaced"
    );
}

#[test]
fn marginals_do_not_panic_on_a_fractional_weapon_skill_id() {
    use dfo_core::analyze::{analyze, marginals};
    use dfo_core::spells::Spellbook;
    let book = Spellbook::default();
    let ch = theory();
    let mut w = ch.get("weapon").clone();
    w.set("skillId", Num(1.5));
    let scenario = obj([("weapon", w), ("target", obj([]))]);
    let baseline = analyze(&ch, &scenario, &book);
    let rows = marginals(&ch, &baseline, &scenario, &book);
    assert_eq!(rows.items().len(), 9, "the what-if rows still answer");
}

#[test]
fn a_plan_summary_sorts_nan_totals_without_panicking() {
    // Channel rows whose comparator is not a total order (a NaN row between two finite rows whose keys order the other
    // way): the JS comparator has the same cycle, but the JS sort does not panic.
    let mut keys: Vec<String> = vec!["a".into()];
    for i in 0..27 {
        keys.push(format!("b{i:02}"));
    }
    keys.push("m".into());
    keys.push("z".into());
    let channels: Vec<Value> = keys
        .iter()
        .map(|k| obj([("key", s(k)), ("invert", Value::Bool(false))]))
        .collect();
    let build = obj([
        ("channels", Arr(channels)),
        ("skill", Null),
        ("school", Null),
        ("name", s("test")),
    ]);
    let mut totals = obj([]);
    for key in &keys {
        totals.set(
            key,
            Num(match key.as_str() {
                "a" => 1.0,
                "m" => f64::NAN,
                "z" => 5.0,
                _ => 2.0,
            }),
        );
    }
    let plan = obj([
        ("build", build),
        ("tree", obj([("start", Null), ("keys", Arr(vec![]))])),
        ("totals", totals),
        ("stars", Num(0.0)),
        ("starBudget", Num(98.0)),
    ]);
    let summary = plan_summary(&plan);
    assert!(summary.get("rows").items().len() >= 3);
}
