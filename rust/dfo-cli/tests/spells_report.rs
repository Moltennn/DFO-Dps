//! Local invariants for the plural `spells` renderer's two branch-specific pieces: the standard/custom pool merge and the
//! window-DPS ranking. The page and `--json` bytes are checked end to end against the real JS CLI in
//! `tests/cli_spells.rs`; these cases say what the merge and the filter must do on their own, without `node`.
//!
//! `src/spells_report.rs` is not exported by `main.rs`, so it is included by path (as `tests/graph.rs` includes
//! `src/graph.rs`); the debug-name filter it reuses is `src/spell.rs`'s.

#[path = "../src/graph.rs"]
#[allow(dead_code)]
mod graph;
#[path = "../src/spell.rs"]
#[allow(dead_code)]
mod spell;
#[path = "../src/spells_report.rs"]
#[allow(dead_code)]
mod spells_report;

use dfo_core::analyze::gate_target;
use dfo_core::maxprofile::Profiles as MaxProfiles;
use dfo_core::spells::read_spells_std;
use dfo_core::spells::spells_by_index_map;
use dfo_core::theory::theory_character;
use dfo_core::value::Value::{self, Arr, Bool, Num, Obj, Str};

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

/// One effect as the record layout stores it: `(type, subType, durationBase, durationMod, durationPerLevel,
/// magnitudeBaseLow, magnitudeBaseHigh, magnitudeLevelBase, magnitudeLevelHigh, magnitudePerLevel)`.
type SpellEffect = (i8, i8, u8, u8, u8, u8, u8, u8, u8, u8);

fn spell_record(
    index: u8,
    name: &str,
    element: u8,
    range_type: u8,
    effects: &[SpellEffect],
) -> Vec<u8> {
    let mut b = vec![0u8; 0x59];
    for i in 0..3 {
        let (t, st) = effects.get(i).map_or((-1, -1), |e| (e.0, e.1));
        b[2 * i] = t as u8;
        b[2 * i + 1] = st as u8;
    }
    b[6] = element;
    b[7] = range_type;
    b[8..10].copy_from_slice(&12u16.to_le_bytes());
    for (i, e) in effects.iter().enumerate() {
        b[14 + 3 * i] = e.2;
        b[15 + 3 * i] = e.3;
        b[16 + 3 * i] = e.4;
        b[32 + 5 * i] = e.5;
        b[33 + 5 * i] = e.6;
        b[34 + 5 * i] = e.7;
        b[35 + 5 * i] = e.8;
        b[36 + 5 * i] = e.9;
    }
    let bytes = name.as_bytes();
    b[47..47 + bytes.len().min(25)].copy_from_slice(&bytes[..bytes.len().min(25)]);
    b[73] = index;
    b
}

/// Four records: an instant bolt, a zero-damage Warder, a debug name and a second bolt the book does not carry (as a
/// save's custom record would not).
fn book() -> dfo_core::spells::Spellbook {
    let records = [
        spell_record(1, "Bolt", 4, 0, &[(4, 0, 0, 0, 1, 10, 20, 0, 0, 1)]),
        spell_record(2, "Warder", 4, 0, &[(35, -1, 0, 5, 1, 0, 0, 0, 0, 1)]),
        spell_record(3, "Lvl 1 Probe", 4, 0, &[(4, 0, 0, 0, 1, 1, 3, 0, 0, 1)]),
        spell_record(4, "Bolt Prime", 4, 0, &[(4, 0, 0, 0, 1, 30, 60, 0, 0, 1)]),
    ]
    .concat();
    spells_by_index_map(read_spells_std(&records))
}

fn custom(name: &str, low: u8, high: u8) -> Value {
    obj([
        (
            "effects",
            Arr(vec![obj([
                ("type", Num(4.0)),
                ("subType", Num(0.0)),
                ("magnitudeBaseLow", Num(f64::from(low))),
                ("magnitudeBaseHigh", Num(f64::from(high))),
                ("magnitudeLevelBase", Num(0.0)),
                ("magnitudeLevelHigh", Num(0.0)),
                ("magnitudePerLevel", Num(1.0)),
            ])]),
        ),
        ("name", Str(name.to_owned())),
        ("element", Num(4.0)),
        ("rangeType", Num(0.0)),
    ])
}

/// `loadCharacter`/`theoryCharacter` for `--theory`, then the branch's caster tweak (`src/cli.js:1481`).
fn caster() -> Value {
    let book = dfo_core::spells::Spellbook::default();
    let legal = MaxProfiles::new(&book)
        .legal_gear(&Num(123.0), &Value::Undefined)
        .expect("the legal gear budget");
    let mut ch = theory_character(&obj([
        ("level", Num(45.0)),
        ("race", Str("darkelf".to_owned())),
        ("blade", Num(123.0)),
        ("material", Num(9.0)),
        ("gearLB", Num(legal.get("lb").to_number())),
        ("gearCS", Num(legal.get("cs").to_number())),
        ("damagePct", Num(legal.get("dmg").to_number())),
        ("vampire", Bool(false)),
        ("starStats", Obj(vec![])),
        ("starSkills", Obj(vec![])),
        ("starDamage", Num(0.0)),
    ]))
    .expect("the theory character builds");
    let mut skills = Arr(ch.get("skills").items().to_vec());
    if let Value::Arr(items) = &mut skills {
        items[22] = Num(200.0);
    }
    ch.set("skills", skills);
    let mut mastered = ch.get("masteredSkills").items().to_vec();
    if !mastered.iter().any(|v| v.strict_eq(&Num(22.0))) {
        mastered.push(Num(22.0));
    }
    ch.set("masteredSkills", Arr(mastered));
    ch.set("name", Str("Level 45 theory caster".to_owned()));
    ch
}

fn branch_opts(ch: &Value) -> (Value, Value) {
    let target = gate_target(&Num(45.0), &obj([("traits", Arr(vec![]))]));
    let opts = obj([
        ("level", Num(45.0)),
        ("online", Bool(!ch.get("online").strict_eq(&Bool(false)))),
        ("potencyPct", Num(0.0)),
        ("pierce", Num(0.0)),
        ("castSpeedPct", Num(0.0)),
        ("manaSolved", Bool(true)),
        ("health", Num(target.get("maxHealth").to_number())),
        ("traits", Arr(target.get("bossTraits").items().to_vec())),
    ]);
    (target, opts)
}

/// A LOCAL INVARIANT for `src/cli.js:1485`: the book's own order first, then only the known records whose index the book
/// does not carry. A stock index in `known` duplicates a book record; a custom record has no index and survives.
#[test]
fn pool_puts_the_book_first_and_appends_only_custom_records() {
    let book = book();
    // The save's `spells`: the book's index 1 (dropped), then two custom records.
    let known = vec![
        book.get(&Num(1.0)).expect("index 1 in the book").clone(),
        custom("Custom Zap", 6, 12),
        custom("Custom Burn", 5, 5),
    ];
    let got = spells_report::pool(&book, &known);
    let names: Vec<String> = got.iter().map(|sp| sp.get("name").to_js_string()).collect();
    assert_eq!(
        names,
        [
            "Bolt",
            "Warder",
            "Lvl 1 Probe",
            "Bolt Prime",
            "Custom Zap",
            "Custom Burn",
        ]
    );
}

/// A LOCAL INVARIANT for `src/cli.js:1492-1494`: nonzero damage and no debug name, sorted by window DPS descending, with
/// the page's first twenty rows the highest. `Bolt Prime` out-damages `Bolt`, and the custom record sits between them.
#[test]
fn ranked_filters_and_sorts_by_window_dps() {
    let ch = caster();
    let (target, opts) = branch_opts(&ch);
    let book = book();
    let known = vec![custom("Custom Zap", 20, 20)];
    let pool = spells_report::pool(&book, &known);
    let list = spells_report::ranked(&pool, &ch, &target, &opts, 30.0);
    let names: Vec<String> = list
        .iter()
        .map(|e| e.spell.get("name").to_js_string())
        .collect();
    // The Warder is the zero-damage record and `Lvl 1 Probe` the debug name; both are filtered.
    assert_eq!(names, ["Bolt Prime", "Custom Zap", "Bolt"]);
    assert!(list
        .windows(2)
        .all(|w| w[0].window_dps() >= w[1].window_dps()));
    // The rotation card is the shared core's `spellRotation`, at the branch's `{ ...opts, seconds }`.
    let mut rotation_opts = opts.clone();
    rotation_opts.set("seconds", Num(30.0));
    for e in &list {
        assert_eq!(
            dfo_core::value::write(&e.rotation),
            dfo_core::value::write(&dfo_core::spells::spell_rotation(
                &e.spell,
                &ch,
                &target,
                &rotation_opts
            ))
        );
    }
}
