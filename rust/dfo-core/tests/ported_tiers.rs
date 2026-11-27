//! Ported from `test/relayEligibility.test.js` and `test/tierCache.test.js`: the pre-trait eligibility field and the
//! batch tier cache, as local invariants.
//!
//! LOCAL INVARIANTS. `tests/blow_outcomes.rs` and `tests/simulate_fight.rs` hold the vectors; these keep the merge key
//! and the cache contract alive.

mod ported_common;

use dfo_core::blow_outcomes::{blow_fight_tier, blow_outcomes, merge_to_fight_tier};
use dfo_core::simulate_fight::{
    create_tier_cache, paired_fight_seeds, simulate_fight, simulate_fight_cached, simulate_fights,
    FightRolls,
};
use ported_common::*;

fn basic() -> Desc {
    Desc::new()
        .level(30.0)
        .stat("strength", 70.0)
        .stat("agility", 60.0)
        .stat("speed", 60.0)
        .stat("luck", 50.0)
        .skills(0.0)
        .skill(29, 70.0)
        .skill(34, 40.0)
        .skill(19, 50.0)
}

#[test]
fn formula_positive_is_set_independently_of_echo_eligibility() {
    let item = weapon(121.0, 9.0, 1.0);
    let ch = basic().sim(Some(item.clone()));
    let gate = dfo_core::analyze::gate_target(&n(45.0), &obj([("health", n(2000.0))]));
    let full = blow_outcomes(
        &ch,
        &obj([
            ("target", gate),
            ("health", n(2000.0)),
            ("weapon", dfo_core::model_blow::weapon_of(&item, false)),
        ]),
    )
    .expect("a blow tier");
    let positive: Vec<_> = full
        .outcomes
        .iter()
        .filter(|o| o.formula_positive)
        .collect();
    assert!(!positive.is_empty());
    assert!(
        positive.iter().all(|o| !o.echo_eligible),
        "no echo power: eligibility is not echo eligibility"
    );
    let tier = merge_to_fight_tier(&full);
    assert!(
        tier.outcomes
            .iter()
            .all(|o| o.formula_positive || o.blow == 0.0),
        "the fight tier keeps the gate"
    );
}

#[test]
fn a_potent_vs_miss_is_positive_pre_trait_and_not_a_hit() {
    let mut item = weapon(121.0, 9.0, 1.0);
    item.set(
        "enchantments",
        arr(vec![obj([("type", n(4.0)), ("param", n(1.0))])]),
    );
    let ch = basic().sim(Some(item.clone()));
    let gate = dfo_core::analyze::gate_target(&n(45.0), &obj([("health", n(2000.0))]));
    let full = blow_outcomes(
        &ch,
        &obj([
            ("target", gate),
            ("health", n(2000.0)),
            ("weapon", dfo_core::model_blow::weapon_of(&item, false)),
        ]),
    )
    .expect("a blow tier");
    let misses: Vec<_> = full
        .outcomes
        .iter()
        .filter(|o| !o.hit && o.blow == 5.0)
        .collect();
    assert!(!misses.is_empty(), "the Potent Vs miss branch exists");
    assert!(
        misses.iter().all(|o| o.formula_positive),
        "the listener gate is the pre-trait formula damage"
    );
}

#[test]
fn the_fight_merge_key_cannot_collapse_different_eligibility() {
    // The JS builds the pair by hand: two outcomes identical except `formulaPositive`. So does this.
    use dfo_core::blow_outcomes::{Atom, Hand, Tier, TierKind};
    let base = Atom {
        p: 0.5,
        direction_index: 3,
        hit: false,
        whole: true,
        ..Default::default()
    };
    let mut positive = base.clone();
    positive.formula_positive = true;
    let full = Tier {
        kind: TierKind::Full,
        hand: Hand::Main,
        cap: 0.0,
        directions: vec![s("StrikeLeft")],
        outcomes: vec![positive, base],
        total: 1.0,
        meta: obj([]),
        merged_from: None,
        carry_resolve: None,
    };
    let tier = merge_to_fight_tier(&full);
    assert_eq!(
        tier.outcomes.len(),
        2,
        "different eligibility is a different key"
    );
    assert_eq!(
        tier.outcomes.iter().filter(|o| o.formula_positive).count(),
        1
    );
    assert_eq!(tier.total, 1.0);
}

// ── tierCache.test.js ─────────────────────────────────────────────

/// `pairedFightSeeds(8, 20261117)` (`src/simulateFight.js`).
fn seeds8() -> Vec<Value> {
    paired_fight_seeds(&n(8.0), &n(20261117.0))
}

fn single_character() -> (Value, Value) {
    let it = weapon(121.0, 9.0, 1.0);
    (basic().sim(Some(it.clone())), it)
}

#[test]
fn a_single_weapon_batch_is_bit_identical_to_standalone_fights() {
    let (ch, it) = single_character();
    let seeds = seeds8();
    let args = obj([
        ("target", reference_foe(30.0, "tough")),
        ("health", n(40000.0)),
        ("weapon", dfo_core::model_blow::weapon_of(&it, false)),
        ("trace", b(true)),
    ]);
    let batch = simulate_fights(&ch, &with_seeds(&args, &seeds), &book()).expect("a batch");
    assert_eq!(f(batch.get("health")), 40000.0);
    let rows = batch.get("rows").items();
    assert_eq!(rows.len(), seeds.len());
    let mut cache = create_tier_cache();
    for (i, row) in rows.iter().enumerate() {
        let mut one = args.clone();
        one.set("seed", seeds[i].clone());
        let standalone =
            simulate_fight_cached(&ch, &one, &book(), &mut cache, FightRolls::default())
                .expect("a fight");
        assert_eq!(
            row.get("blowDamage"),
            standalone.get("blowDamage"),
            "seed {}",
            seeds[i].to_js_string()
        );
        assert_eq!(row.get("remaining"), standalone.get("remaining"));
    }
    // A fresh cache gives the same batch: the cache is not inherited across calls.
    let again = simulate_fights(&ch, &with_seeds(&args, &seeds), &book()).expect("a batch");
    assert_eq!(batch.get("rows"), again.get("rows"));
}

#[test]
fn a_dual_batch_and_a_durability_batch_stay_identical() {
    let (ch, it) = single_character();
    let mut dual = ch.clone();
    let mut off = it.clone();
    off.set("equipSlot", n(21.0));
    dual.set("offWeapon", off);
    dual.set("_dual", b(true));
    let seeds = paired_fight_seeds(&n(4.0), &n(20261117.0));
    let args = obj([
        ("target", reference_foe(30.0, "tough")),
        ("health", n(20000.0)),
        ("weapon", dfo_core::model_blow::weapon_of(&it, false)),
        ("dual", b(true)),
        ("trace", b(true)),
    ]);
    let batch = simulate_fights(&dual, &with_seeds(&args, &seeds), &book()).expect("a dual batch");
    for (i, row) in batch.get("rows").items().iter().enumerate() {
        let mut one = args.clone();
        one.set("seed", seeds[i].clone());
        let standalone = simulate_fight(&dual, &one, &book()).expect("a fight");
        assert_eq!(row.get("blowDamage"), standalone.get("blowDamage"));
    }

    // Durability: the same condition, so the wear stream is the same each run.
    let mut worn = weapon(121.0, 9.0, 0.5);
    worn.set("maxCondition", n(1000.0));
    worn.set("currentCondition", n(500.0));
    let ch = basic().sim(Some(worn.clone()));
    let args = obj([
        ("target", reference_foe(30.0, "tough")),
        ("health", n(20000.0)),
        ("weapon", dfo_core::model_blow::weapon_of(&worn, false)),
        ("durability", b(true)),
        ("trace", b(true)),
    ]);
    let batch = simulate_fights(&ch, &with_seeds(&args, &seeds), &book()).expect("a wear batch");
    for (i, row) in batch.get("rows").items().iter().enumerate() {
        let mut one = args.clone();
        one.set("seed", seeds[i].clone());
        let standalone = simulate_fight(&ch, &one, &book()).expect("a fight");
        assert_eq!(row.get("blowDamage"), standalone.get("blowDamage"));
        assert_eq!(row.get("wear"), standalone.get("wear"));
    }
}

fn with_seeds(args: &Value, seeds: &[Value]) -> Value {
    let mut out = args.clone();
    out.set("seeds", arr(seeds.to_vec()));
    out
}

#[test]
fn a_fight_tier_is_a_pure_function_of_its_inputs() {
    // The cache's premise: two calls with the same build and scenario answer the same table.
    let (ch, it) = single_character();
    let args = obj([
        ("target", reference_foe(30.0, "tough")),
        ("health", n(12000.0)),
        ("weapon", dfo_core::model_blow::weapon_of(&it, false)),
    ]);
    let a = blow_fight_tier(&ch, &args).expect("a tier");
    let b = blow_fight_tier(&ch, &args).expect("a tier");
    assert_eq!(a.outcomes.len(), b.outcomes.len());
    assert_eq!(a.total, b.total);
    for (x, y) in a.outcomes.iter().zip(&b.outcomes) {
        assert_eq!(x.blow, y.blow);
        assert_eq!(x.p, y.p);
    }
}
