//! Local invariants for the theory card's two branch-specific pieces: the stage ladder and the cap sheet. The whole
//! card and its `--json` document are checked end to end against the real JS CLI in `tests/cli_theory.rs`; these cases
//! say what the stage overrides and the generated cap table must do on their own, without `node`.
//!
//! `src/theory.rs` is not exported by `main.rs`, so it is included by path (as `tests/spells_report.rs` includes
//! `src/spells_report.rs`).

#[path = "../src/theory.rs"]
#[allow(dead_code)]
mod theory;

use dfo_core::analyze::gate_target;
use dfo_core::generated::theory::THEORY_CAPS;
use dfo_core::spells::Spellbook;
use dfo_core::theory::THEORY_LEVEL;
use dfo_core::value::Value::{self, Arr, Bool, Null, Num, Obj, Str};

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

/// The JS `scenarioOf` record for the theory flags these cases use: the gate body, its health, and the branch defaults.
fn scenario() -> Value {
    let target = gate_target(&Num(THEORY_LEVEL), &Obj(vec![]));
    obj([
        ("target", target.clone()),
        ("core", Str("overhaul".to_owned())),
        ("rri", Bool(true)),
        ("traits", Null),
        ("health", target.get("maxHealth").clone()),
        ("swing", Str("random".to_owned())),
        ("critDamage", Bool(true)),
        ("passiveOn", Bool(true)),
        ("stacks", Num(5.0)),
        ("rhythm", Bool(false)),
        ("unaware", Bool(false)),
        ("firstBlow", Bool(false)),
        ("healthShare", Num(1.0)),
        ("attackerHealthShare", Num(1.0)),
        ("backstabUptime", Num(0.0)),
        ("pair", Bool(false)),
        ("dual", Bool(false)),
        ("bowSpam", Bool(false)),
        ("potencyPct", Num(0.0)),
        ("pierce", Num(0.0)),
    ])
}

fn input(gear: theory::GearFlags) -> theory::Input {
    theory::Input {
        level: THEORY_LEVEL,
        race: "darkelf".to_owned(),
        blade: 123.0,
        material: 9.0,
        star_stats: Vec::new(),
        star_skills: Vec::new(),
        vampire: false,
        gear,
        target_name: "gate".to_owned(),
        rri: true,
    }
}

/// A LOCAL INVARIANT for `src/cli.js:1849-1860`: five stages in the JS order, the first two with no gear and empty
/// sockets, the last three on the resolved gear line, and `Vampire` the only one that turns the racial override on.
#[test]
fn the_stage_ladder_keeps_the_js_order_and_overrides() {
    let rendered = theory::render(
        &input(theory::GearFlags::default()),
        &scenario(),
        &Spellbook::default(),
    )
    .expect("the card builds");
    let stages = rendered.document.get("stages").items().to_vec();
    let labels: Vec<String> = stages
        .iter()
        .map(|s| s.get("label").to_js_string())
        .collect();
    assert_eq!(
        labels,
        [
            "Naked skills",
            "Mastered skills",
            "Legal gear (no damage line)",
            "Legal gear + damage line",
            "Vampire",
        ]
    );
    for (i, stage) in stages.iter().enumerate() {
        assert_eq!(
            stage.get("raw").to_number(),
            if i == 0 { 100.0 } else { 200.0 }
        );
        assert!(stage.get("sockets").items().is_empty());
        assert_eq!(stage.get("vampire").truthy(), i == 4);
    }
    // The two bare stages price no gear line; the legal ones carry it, and only the last two a damage affix.
    assert_eq!(stages[0].get("gearLB").to_number(), 0.0);
    assert_eq!(stages[1].get("gearLB").to_number(), 0.0);
    assert_eq!(stages[2].get("damage").to_number(), 0.0);
    assert!(stages[3].get("gearLB").to_number() > 0.0);
    assert!(stages[3].get("damage").to_number() > 0.0);
    assert!(rendered.text.contains("\nPush stages\n"));
}

/// A LOCAL INVARIANT: the cap sheet is the generated `THEORY_CAPS`, in its own order, on the document and in the text.
#[test]
fn the_cap_sheet_is_the_generated_table_in_order() {
    let rendered = theory::render(
        &input(theory::GearFlags::default()),
        &scenario(),
        &Spellbook::default(),
    )
    .expect("the card builds");
    let channels: Vec<String> = rendered
        .document
        .get("caps")
        .items()
        .iter()
        .map(|cap| cap.get("channel").to_js_string())
        .collect();
    let want: Vec<&str> = THEORY_CAPS.iter().map(|cap| cap.channel).collect();
    assert_eq!(channels, want);
    assert!(rendered.text.contains("\nCaps (push in this order)\n"));
    for cap in THEORY_CAPS {
        assert!(
            rendered.text.contains(cap.note),
            "the note prints: {}",
            cap.channel
        );
    }
}

/// A LOCAL INVARIANT: a reference foe (no HP line) is refused with a message before any card is built, where the JS
/// dereferences a null `health` and crashes.
#[test]
fn a_reference_foe_is_a_usage_error_not_a_crash() {
    let mut base = scenario();
    base.set(
        "target",
        dfo_core::analyze::reference_foe(&Num(THEORY_LEVEL), &Str("tough".to_owned())),
    );
    base.set("health", Num(0.0));
    let got = theory::render(
        &input(theory::GearFlags::default()),
        &base,
        &Spellbook::default(),
    );
    let err = got.expect_err("a reference foe has no health line");
    assert!(err.contains("boss or gate target"), "{err}");
    let _ = Arr(vec![]);
}
