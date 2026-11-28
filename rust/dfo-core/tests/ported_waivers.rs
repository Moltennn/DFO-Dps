//! Ported from the self-expiring waiver pins: `test/procBudget.test.js` §"waiver pin (W-PROC-BUDGET)" and
//! `test/pricing.test.js` §5 (W-LOOT-CARRY).
//!
//! A waiver is not a pass: it asserts a known divergence is STILL present, so a fix fails this test on purpose and the
//! waiver must be removed and the fix recorded in `CHANGELOG-MECHANICS.md`. The waiver text (title, detail and
//! evidence) is committed at `rust/WAIVERS.md`, the Rust-side home of `test/harness/waivers.mjs`; the test below reads
//! it and fails if an id, its title or a quoted piece of its evidence goes missing, so removing a waiver is noticed. The
//! `test/*.test.js` names in that text are historical (the JS suite at the revision that still had it). The oracle halves
//! of those JS tests (the vendored `applyHit` replay, the 250,000-blow upstream sample) cannot be ported; they are
//! listed as lost in `rust/PORTED-TESTS.md`.

mod ported_common;

use dfo_core::spells::{spells_by_index_map, Spellbook};
use ported_common::*;

/// `rust/WAIVERS.md` still declares both ids with their title and evidence, so removing a waiver is noticed here.
#[test]
fn both_waivers_are_still_declared() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("WAIVERS.md");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    for (id, title, evidence) in [
        (
            "W-PROC-BUDGET",
            "The explicit card ceiling sums Cast When Strikes damage before the shared relay budget",
            "710.09 ceiling DPS vs 150 paid DPS",
        ),
        (
            "W-LOOT-CARRY",
            "The stateless estimates and explicit floor streams omit the held item's fraction",
            "z was 6.90 when recorded",
        ),
    ] {
        assert!(
            text.contains(&format!("## {id}\n")),
            "the waiver {id} is still declared in rust/WAIVERS.md"
        );
        assert!(
            text.contains(title),
            "the waiver {id} keeps its title"
        );
        assert!(
            text.contains(evidence),
            "the waiver {id} keeps its quoted evidence ({evidence})"
        );
    }
}

/// `heavyProcs()` of `test/procBudget.test.js`: three Cast When Strikes rows, each a big instant (4,0) effect.
fn heavy_procs() -> (Value, Spellbook) {
    let mut item = weapon(121.0, 9.0, 1.0);
    item.set(
        "enchantments",
        arr([1.0, 2.0, 3.0]
            .into_iter()
            .map(|p| obj([("type", n(2.0)), ("param", n(p))]))
            .collect()),
    );
    let ch = Desc::new()
        .level(45.0)
        .skills(100.0)
        .stat("strength", 70.0)
        .stat("agility", 60.0)
        .stat("speed", 100.0)
        .stat("luck", 50.0)
        .sim(Some(item));
    let book = spells_by_index_map((1..=3).map(|i| {
        obj([
            ("name", s(&format!("DoT {i}"))),
            ("index", n(f64::from(i))),
            ("element", n(4.0)),
            ("rangeType", n(1.0)),
            (
                "effects",
                arr(vec![obj([
                    ("type", n(4.0)),
                    ("subType", n(0.0)),
                    ("magnitudeBaseLow", n(1000.0)),
                    ("magnitudeBaseHigh", n(1000.0)),
                    ("magnitudeLevelBase", n(0.0)),
                    ("magnitudeLevelHigh", n(0.0)),
                    ("magnitudePerLevel", n(1.0)),
                    ("durationBase", n(0.0)),
                    ("durationMod", n(0.0)),
                    ("durationPerLevel", n(1.0)),
                    ("chanceBase", n(0.0)),
                    ("chanceMod", n(0.0)),
                    ("chancePerLevel", n(1.0)),
                ])]),
            ),
        ])
    }));
    (ch, book)
}

/// W-PROC-BUDGET: the explicit ceiling sums Cast When Strikes damage on top of the per-hit-capped weapon figure, so it
/// promises a SHORTER kill than the allowance itself grants. The pin holds that the ceiling is still the shorter one.
#[test]
fn w_proc_budget_the_ceiling_still_prices_cws_procs_above_the_allowance() {
    let (ch, book) = heavy_procs();
    let gate = gate_target(45.0);
    let card = dfo_core::analyze::analyze(
        &ch,
        &obj([
            ("target", gate.clone()),
            ("health", gate.get("maxHealth").clone()),
        ]),
        &book,
    );
    assert!(
        card.enchant_dps > 0.0,
        "the procs price (the fixture must exercise them)"
    );
    let allowance = card
        .allowance
        .as_ref()
        .expect("the fixture runs through the allowance");
    assert!(
        matches!(allowance.get("sustainedDps"), Value::Num(_)),
        "the fixture runs through the allowance"
    );
    let ceiling = card
        .total_ttk_cap_only
        .expect("the ceiling's own kill time");
    let claim = card
        .totals
        .claim_total_ttk
        .expect("the allowance's kill time");
    // The waiver: the ceiling (procs summed on top of the capped weapon rate) predicts the shorter kill.
    assert!(
        ceiling < claim,
        "W-PROC-BUDGET is stale: the ceiling {ceiling} no longer beats the allowance {claim}; remove the waiver and \
         record the fix in CHANGELOG-MECHANICS.md"
    );
    // The waiver's structural claim: the ceiling kill time is the health over the capped weapon rate PLUS the expected
    // proc component (then the shields). That sum never pays the shared relay budget, which is the divergence.
    let health = card.health.expect("the gate's pool");
    let shields = card.shields;
    let expected = (health + card.ward) / (card.capped_dps + card.enchant_dps) + shields;
    assert!(
        ((ceiling - expected) / expected).abs() < 1e-12,
        "W-PROC-BUDGET is stale: the ceiling kill {ceiling} is no longer the capped rate {} plus the proc component {} \
         ({expected}); the divergence is gone, so remove the waiver and record the fix in CHANGELOG-MECHANICS.md",
        card.capped_dps,
        card.enchant_dps
    );
    let ceiling_dps = card
        .totals
        .ceiling_total_dps
        .expect("the ceiling's own rate");
    // And the ceiling really is distinct from the paid rate: the uncapped proc sum is far above it.
    let sustained = card.totals.claim_sustained_dps.expect("a sustained rate");
    assert!(
        ceiling_dps > sustained * 1.5,
        "the ceiling {ceiling_dps} should stand well above the paid rate {sustained}"
    );
}

/// W-LOOT-CARRY: the stateless card floors each blow, while the carried metric is the exact long-run share, so the
/// carried figure is the higher one on a percentage line. The pin holds that gap is still there.
#[test]
fn w_loot_carry_the_carried_metric_still_sits_above_the_flooring_card() {
    let mut item = weapon(121.0, 9.0, 1.0);
    item.set(
        "affixes",
        arr(vec![obj([
            ("id", s("slayer")),
            ("param", s("daedra")),
            ("value", n(25.0)),
        ])]),
    );
    let ch = Desc::new().level(30.0).skills(100.0).sim(Some(item));
    let gate = gate_target(45.0);
    let card = dfo_core::analyze::analyze(
        &ch,
        &obj([
            ("target", gate.clone()),
            ("health", gate.get("maxHealth").clone()),
        ]),
        &book(),
    );
    let floor = card.per_swing;
    let carried = card.totals.carried_per_swing;
    assert!(floor > 0.0, "the card prices a blow");
    assert!(
        carried > floor,
        "W-LOOT-CARRY is stale: the carried mean {carried} no longer sits above the card's floor {floor}; remove the \
         waiver and record the fix in CHANGELOG-MECHANICS.md"
    );
    // The gap is the carry's own rounding, a per-cent-scale effect, not a different mechanic.
    let rel = carried / floor - 1.0;
    assert!(
        rel < 0.05,
        "the carried gap ({:.3}%) is a carry remainder, not a moved number",
        rel * 100.0
    );
}
