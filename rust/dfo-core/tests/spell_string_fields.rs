//! JS `+` on hand-edited data: a save's custom spell record (or an effect field) may carry a string, and ECMAScript
//! `+` CONCATENATES rather than adds. `'10' + '20'` is `'1020'`, so `(low + high) / 2` is 510, not 15, and a min/max
//! arm writes `'10' + 0` as `'100'`. The vectors in `spells.txt` (`rust-spell-vectors.mjs`) are the differential; this
//! pins the arithmetic directly so a change to `js_plus`/`add_number`/`magnitude_at` is caught without the file.
//!
//! These are the real JS answers (`node`: `magnitudeAt`, `spellCost`), copied - a local invariant from the live engine.

use dfo_core::spells::{effect_cost, magnitude_at, spell_cost, spell_damage, spell_rounds, Mode};
use dfo_core::value::Value::{self, Bool, Null, Num, Obj, Str};
use dfo_core::value::{add_num, add_number, js_plus};

fn effect(low: Value, high: Value, ll: Value, lh: Value, per: Value) -> Value {
    Obj(vec![
        ("type".into(), Num(4.0)),
        ("subType".into(), Num(0.0)),
        ("magnitudeBaseLow".into(), low),
        ("magnitudeBaseHigh".into(), high),
        ("magnitudeLevelBase".into(), ll),
        ("magnitudeLevelHigh".into(), lh),
        ("magnitudePerLevel".into(), per),
    ])
}

/// The first custom record: every field a string (`durationBase:'2'` and the rest).
fn string_record() -> Value {
    Obj(vec![
        ("type".into(), Num(4.0)),
        ("subType".into(), Num(0.0)),
        ("magnitudeBaseLow".into(), Str("10".into())),
        ("magnitudeBaseHigh".into(), Str("20".into())),
        ("magnitudeLevelBase".into(), Str("1".into())),
        ("magnitudeLevelHigh".into(), Str("2".into())),
        ("magnitudePerLevel".into(), Str("3".into())),
        ("durationBase".into(), Str("2".into())),
        ("durationMod".into(), Str("1".into())),
        ("durationPerLevel".into(), Str("1".into())),
        ("chanceBase".into(), Str("5".into())),
        ("chanceMod".into(), Str("0".into())),
        ("chancePerLevel".into(), Str("1".into())),
    ])
}

/// `js_plus` is ECMAScript `+`: a string operand concatenates, two numbers add, `true`/`null` are 1/0 numerically.
#[test]
fn js_plus_concatenates_a_string_operand() {
    assert_eq!(
        js_plus(&Str("10".into()), &Str("20".into())),
        Str("1020".into())
    );
    assert_eq!(js_plus(&Str("10".into()), &Num(20.0)), Str("1020".into()));
    assert_eq!(js_plus(&Num(10.0), &Num(20.0)), Num(30.0));
    assert_eq!(js_plus(&Bool(true), &Null), Num(1.0));
    // The number form the caller's next operator reads.
    assert_eq!(add_number(&Str("10".into()), &Str("20".into())), 1020.0);
    assert_eq!(add_num(&Str("10".into()), 0.0), 100.0);
}

/// `(low + high) / 2` over the first record's strings: JS gives 510, so the whole card's damage is 308.55.
#[test]
fn a_string_record_magnitude_and_card() {
    let e = string_record();
    assert_eq!(magnitude_at(&e, 1.0, Mode::Avg), 510.0);
    // The min/max arms pick the raw string, then `'10' + 0` is `'100'` / `'20' + 0` is `'200'`.
    assert_eq!(magnitude_at(&e, 1.0, Mode::Min), 100.0);
    assert_eq!(magnitude_at(&e, 1.0, Mode::Max), 200.0);
    // The cost is the JS `effectCost` at skill 100 online: gold 10256, sp 256.
    assert_eq!(effect_cost(&e, |_| 100.0, true), (10256.0, 256.0));
    let sp = Obj(vec![("effects".into(), Value::Arr(vec![e.clone()]))]);
    assert_eq!(spell_cost(&sp, &Obj(vec![]), true), 2820.0);
    let card = spell_damage(&sp, &Obj(vec![]), &Obj(vec![]), &Obj(vec![]), Mode::Avg);
    assert!((card.get("damage").to_number() - 308.55).abs() < 1e-9);
}

/// A record with only the two base fields: JS gives NaN (the missing level fields are undefined in the `+`).
#[test]
fn a_missing_level_field_is_nan() {
    let e = Obj(vec![
        ("type".into(), Num(4.0)),
        ("subType".into(), Num(0.0)),
        ("magnitudeBaseLow".into(), Num(10.0)),
        ("magnitudeBaseHigh".into(), Num(20.0)),
    ]);
    assert!(magnitude_at(&e, 1.0, Mode::Avg).is_nan());
    // `true + null` is 1, so `/ 2` is 0.5.
    let e = effect(Bool(true), Null, Num(0.0), Num(0.0), Num(1.0));
    assert_eq!(magnitude_at(&e, 1.0, Mode::Avg), 0.5);
}

/// `e.durationBase + e.durationMod * max(...)`: a string `durationBase` concatenates (`'3' + 1*...`).
#[test]
fn a_string_duration_base_concatenates() {
    let rounds = |base: Value| {
        Obj(vec![
            ("durationBase".into(), base),
            ("durationMod".into(), Num(1.0)),
            ("durationPerLevel".into(), Num(1.0)),
        ])
    };
    // JS: `'3' + 1 * max(1, floor(5/1))` = `'3' + 5` = `'35'` -> Number 35.
    assert_eq!(spell_rounds(&rounds(Str("3".into())), 5.0), 35.0);
    assert_eq!(spell_rounds(&rounds(Num(3.0)), 5.0), 8.0);
}
