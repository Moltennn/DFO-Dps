//! Ported from `test/relayClaim.test.js`, `test/purse.test.js` and `test/flowState.test.js`: the relay claim engine's
//! contract, the encounter purses and the local Flow clock, as known values.
//!
//! LOCAL INVARIANTS on the JS files' hand-written numbers. `tests/relay_claim.rs` and `tests/relay_fight.rs` hold the
//! seeded parity vectors; these keep the named boundary cases alive.

mod ported_common;

use dfo_core::allowance::{allowance_law, Law};
use dfo_core::encounters::{encounter_target, purse_of, ENCOUNTER_IDS};
use dfo_core::flow_state::FlowState;
use dfo_core::purse::simulate_purse;
use dfo_core::relay_claim::{Options, Reason, RelayClaimEngine};
use ported_common::*;

const LEVEL: f64 = 45.0;
const SHARE: f64 = 12000.0;

fn engine() -> RelayClaimEngine {
    let mut o = Options::new(SHARE);
    o.level = LEVEL;
    RelayClaimEngine::new(o).expect("the level-45 engine")
}

fn claim(engine: &mut RelayClaimEngine, t: f64, damage: f64) -> dfo_core::relay_claim::ClaimResult {
    engine.claim(t, damage).expect("an accepted call")
}

#[test]
fn the_relay_constants_are_the_games_and_a_fresh_join_starts_full() {
    let law = allowance_law(LEVEL);
    assert_eq!(
        [law.depth, law.rate, law.cap, law.hit_hz],
        [750.0, 150.0, 600.0, 4.0]
    );
    let e = engine();
    assert_eq!(e.bucket(), 750.0);
    assert_eq!(e.tokens(), 4.0);
    assert_eq!(e.hp(), SHARE);
    let s = e.summary();
    assert_eq!(s.bucket_capacity, 750.0);
    assert_eq!(s.token_capacity, 4.0);
    assert_eq!(s.claims, 0);
}

#[test]
fn tokens_and_bucket_at_exact_boundaries() {
    let mut e = engine();
    let got: Vec<f64> = (0..5).map(|_| claim(&mut e, 0.0, 100.0).got).collect();
    assert_eq!(got, [100.0, 100.0, 100.0, 100.0, 0.0]);
    // The fifth call is the refusal: re-derive it to read its fields (the calls above already moved the engine).
    let mut e = engine();
    for _ in 0..4 {
        claim(&mut e, 0.0, 100.0);
    }
    let refused = claim(&mut e, 0.0, 100.0);
    assert_eq!(refused.reason, Reason::NoToken);
    assert_eq!(refused.tokens_before, 0.0);
    assert_eq!(refused.tokens_after, 0.0);
    assert_eq!(refused.bucket_before, 350.0);
    assert_eq!(
        refused.bucket_after, 350.0,
        "the bucket is not refilled when no token is spent"
    );
    assert_eq!(e.tokens(), 0.0);
    assert_eq!(e.bucket(), 350.0);

    // 0.249 s gives 0.996 of a token: still refused; 0.25 s reaches exactly 1 and is accepted.
    let before = claim(&mut e, 0.249, 100.0);
    assert_eq!(before.reason, Reason::NoToken);
    assert!(near_eps(before.tokens_after, 0.996, 1e-12));
    let at = claim(&mut e, 0.25, 100.0);
    assert!(at.accepted);
    assert!(near_eps(at.tokens_after, 0.0, 1e-12));
    assert!(near(at.bucket_before, 350.0));
    assert!(near(at.bucket_refilled, 350.0 + 0.25 * 150.0));
    assert!(near(at.bucket_after, 350.0 + 0.25 * 150.0 - 100.0));
}

#[test]
fn zero_negative_and_non_finite_claims_are_refused_before_any_clock_is_touched() {
    let mut e = engine();
    for d in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let r = claim(&mut e, 0.0, d);
        assert_eq!(r.reason, Reason::Invalid, "damage {d}");
        assert!(!r.token_spent);
        assert_eq!(r.tokens_before, 4.0);
        assert_eq!(r.bucket_before, 750.0);
    }
    assert_eq!(e.summary().invalid, 5);
    assert_eq!(e.tokens(), 4.0);
    assert_eq!(e.bucket(), 750.0);
    assert!(claim(&mut e, 0.0, 100.0).accepted);
    assert_eq!(e.tokens(), 3.0);
    let s = e.summary();
    assert!(near(s.dealt + s.clipped + s.refused_offer, s.offered));
}

#[test]
fn the_cap_the_bucket_and_the_health_clip_in_that_order() {
    let mut e = engine();
    let a = claim(&mut e, 0.0, 600.0);
    assert_eq!(a.got, 600.0);
    assert_eq!(a.cap_clip, 0.0);
    let b = claim(&mut e, 0.0, 601.0);
    assert_eq!(b.got, 150.0, "the bucket has 150 left");
    assert_eq!(b.cap_clip, 1.0);
    assert_eq!(b.bucket_clip, 450.0);
    let c = claim(&mut e, 0.0, 900.0);
    assert_eq!(c.got, 0.0);
    assert_eq!(c.reason, Reason::Empty);
    assert_eq!(c.bucket_clip, 600.0);
    assert!(
        c.token_spent,
        "the token is spent even when the purse is empty"
    );

    // Health clip: a custom deep bucket and a small pool.
    let mut o = Options::new(100.0);
    o.level = LEVEL;
    o.law = Some(Law {
        depth: 1000.0,
        cap: 1000.0,
        ..allowance_law(LEVEL)
    });
    let mut small = RelayClaimEngine::new(o).expect("the custom law");
    let k = claim(&mut small, 0.0, 150.0);
    assert_eq!(k.got, 100.0);
    assert_eq!(k.health_clip, 50.0);
    assert!(k.killed);
    assert_eq!(small.hp(), 0.0);
    assert_eq!(claim(&mut small, 1.0, 10.0).reason, Reason::Dead);
}

#[test]
fn an_exact_bucket_can_be_emptied_then_refills_at_three_times_ref() {
    let mut o = Options::new(SHARE);
    o.level = LEVEL;
    o.law = Some(Law {
        cap: 10000.0,
        ..allowance_law(LEVEL)
    });
    let mut e = RelayClaimEngine::new(o).expect("the deep-cap law");
    let drained = claim(&mut e, 0.0, 750.0);
    assert_eq!(drained.got, 750.0);
    assert_eq!(e.bucket(), 0.0);
    let at100 = claim(&mut e, 0.1, 100.0);
    assert_eq!(at100.got, 15.0, "0.1 s x 150/s");
    assert_eq!(at100.bucket_clip, 85.0);
    assert_eq!(e.bucket(), 0.0);
    let at1 = claim(&mut e, 1.0, 200.0);
    assert_eq!(at1.got, 135.0, "0.9 s x 150/s");
    assert_eq!(e.bucket(), 0.0);
    let at5 = claim(&mut e, 5.0, 600.0);
    assert_eq!(at5.got, 600.0, "4 s x 150/s, capped at the 750 depth");
    assert_eq!(e.bucket(), 0.0);
}

#[test]
fn a_fixed_shield_refuses_before_the_token_and_exactly_its_end_is_accepted() {
    let mut o = Options::new(SHARE);
    o.level = LEVEL;
    o.shield_until = 1.0;
    let mut e = RelayClaimEngine::new(o).expect("a shielded engine");
    let before = claim(&mut e, 0.999, 100.0);
    assert_eq!(before.reason, Reason::Shielded);
    assert!(!before.token_spent);
    assert_eq!(e.tokens(), 4.0);
    assert_eq!(e.bucket(), 750.0);
    let at = claim(&mut e, 1.0, 100.0);
    assert!(at.accepted);
    assert_eq!(e.tokens(), 3.0);
    // The game checks the damage first, so an invalid claim while shielded is invalid.
    assert_eq!(claim(&mut e, 1.5, 0.0).reason, Reason::Invalid);
}

#[test]
fn a_wounded_boss_join_starts_with_an_empty_bucket_but_four_tokens() {
    let mut o = Options::new(SHARE);
    o.level = LEVEL;
    o.fresh = false;
    let mut e = RelayClaimEngine::new(o).expect("a wounded join");
    assert_eq!(e.bucket(), 0.0);
    assert_eq!(e.tokens(), 4.0);
    let first = claim(&mut e, 0.0, 100.0);
    assert_eq!(first.reason, Reason::Empty);
    assert!(first.token_spent);
    let later = claim(&mut e, 1.0, 100.0);
    assert_eq!(later.got, 100.0);
    assert_eq!(later.bucket_before, 0.0);
    assert_eq!(later.bucket_refilled, 150.0, "one second of refill");
    assert_eq!(later.bucket_after, 50.0);
}

#[test]
fn ordering_ties_and_deterministic_replay() {
    let mut e = engine();
    claim(&mut e, 1.0, 10.0);
    assert!(
        e.claim(0.5, 10.0).is_err(),
        "claims must be in non-decreasing time order"
    );
    let list = [
        (0.0, 100.0),
        (0.0, 200.0),
        (0.25, 900.0),
        (1.0, 0.0),
        (1.0, 600.0),
        (2.0, 750.0),
    ];
    let run = || {
        let mut e = engine();
        for (t, d) in list {
            claim(&mut e, t, d);
        }
        e.summary()
    };
    assert_eq!(run(), run());
    assert_eq!(run().claims, list.len() as u64);
}

#[test]
fn a_long_stream_is_streaming_counters_only_and_identical_on_replay() {
    let run = || {
        let mut e = engine();
        for i in 0..50_000 {
            let _ = claim(&mut e, i as f64 * 0.3, 100.0);
        }
        e.summary()
    };
    let a = run();
    let b = run();
    assert_eq!(a, b);
    assert_eq!(a.claims, 50_000);
    assert!(a.accepted > 0 && a.accepted < a.claims);
    assert!(a.bucket.is_finite() && a.bucket >= 0.0 && a.bucket <= 750.0);
    assert!(a.tokens >= 0.0 && a.tokens < 4.0);
}

#[test]
fn the_engine_clock_is_the_claim_timestamp_and_refused_claims_do_not_move_the_purse() {
    let mut e = engine();
    for _ in 0..4 {
        assert!(claim(&mut e, 0.0, 100.0).accepted);
    }
    let no_token = claim(&mut e, 0.1, 100.0);
    assert_eq!(no_token.reason, Reason::NoToken);
    assert_eq!(e.time(), 0.1, "the engine clock is the claim time");
    assert_eq!(
        e.bucket(),
        350.0,
        "a no-token claim does not refill the purse"
    );
    assert!(near(e.tokens(), 0.4), "the token clock did advance");

    let mut o = Options::new(SHARE);
    o.level = LEVEL;
    o.shield_until = 1.0;
    let mut shielded = RelayClaimEngine::new(o).expect("a shielded engine");
    assert_eq!(claim(&mut shielded, 0.5, 100.0).reason, Reason::Shielded);
    assert_eq!(shielded.time(), 0.5);
    assert_eq!(shielded.tokens(), 4.0);
    assert_eq!(shielded.bucket(), 750.0);
    assert_eq!(claim(&mut shielded, 0.6, 0.0).reason, Reason::Invalid);
    assert_eq!(shielded.time(), 0.6);
    assert_eq!(shielded.tokens(), 4.0);
    assert_eq!(shielded.bucket(), 750.0);
}

// ── purse.test.js ─────────────────────────────────────────────────

fn purse_base(over: impl FnOnce(&mut Value)) -> Value {
    let mut base = obj([
        ("health", n(12000.0)),
        ("ward", n(0.0)),
        ("cap", n(600.0)),
        ("cappedPerSwing", n(400.0)),
        ("hit", obj([("hit", n(1.0))])),
        ("cadence", obj([("aps", n(1.0))])),
    ]);
    over(&mut base);
    base
}

fn purse(base: &Value, id: &str) -> Value {
    simulate_purse(base, &s(id), &obj([("level", n(45.0))])).expect("a priced purse")
}

#[test]
fn the_level_45_purse_is_750_deep_150_a_second_600_a_blow_4_blows_a_second() {
    let p = purse_of(&n(45.0));
    assert_eq!(f(p.get("ref")), 50.0);
    assert_eq!(f(p.get("depth")), 750.0);
    assert_eq!(f(p.get("rate")), 150.0);
    assert_eq!(f(p.get("cap")), 600.0);
    assert_eq!(f(p.get("hitHz")), 4.0);
}

#[test]
fn the_breach_target_is_12000_hp_with_two_3_second_shields() {
    let t = encounter_target(&s("breach"), &n(45.0), &Value::Undefined);
    assert_eq!(f(t.get("health")), 12000.0);
    assert_eq!(f(t.get("hitCap")), 600.0);
    assert_eq!(f(t.get("phaseShields")), 2.0);
    assert_eq!(f(t.get("shieldSeconds")), 3.0);
}

#[test]
fn the_sky_ketch_target_is_30000_hp_and_still_uses_the_600_cap() {
    let t = encounter_target(&s("skyketch"), &n(45.0), &Value::Undefined);
    assert_eq!(f(t.get("health")), 30000.0);
    assert_eq!(f(t.get("hitCap")), 600.0);
    assert!(ENCOUNTER_IDS.contains(&"skyketch"));
}

#[test]
fn a_build_above_the_refill_drains_the_purse_then_settles_at_the_refill_rate() {
    let r = purse(&purse_base(|_| {}), "breach");
    let ttk = f(r.get("ttk"));
    assert!((75.0..=80.0).contains(&ttk), "ttk {ttk}");
    assert!(f(r.get("burst5")) > 0.0);
    assert!(r.get("calibrated").truthy());
}

#[test]
fn a_build_below_the_refill_never_empties_the_purse() {
    let r = purse(&purse_base(|b| b.set("cappedPerSwing", n(100.0))), "abyss");
    assert!(near_eps(f(r.get("ttk")), 120.0, 1e-6));
    assert!(f(r.get("burst5")) > 0.0);
}

#[test]
fn the_four_blows_a_second_token_bucket_drops_blows_above_it() {
    let r = purse(
        &purse_base(|b| {
            b.set("cappedPerSwing", n(100.0));
            b.set("cadence", obj([("aps", n(10.0))]));
        }),
        "breach",
    );
    let share = f(r.get("landedShare"));
    assert!(share > 0.35 && share < 0.45, "share {share}");
    assert!(f(r.get("hits")) > 0.0);
}

#[test]
fn the_per_blow_cap_binds_above_600() {
    let r = purse(
        &purse_base(|b| b.set("cappedPerSwing", n(1000.0))),
        "breach",
    );
    assert!(f(r.get("landed")) / f(r.get("hits")) <= 600.0 + 1e-9);
}

#[test]
fn phase_shields_add_their_seconds_to_the_kill() {
    let slow = purse_base(|b| b.set("cappedPerSwing", n(100.0)));
    let plain = purse(&slow, "abyss");
    let breach = purse(&slow, "breach");
    assert_eq!(f(breach.get("phases")), 2.0);
    // Two 3 s wards; a claim at each ward's exact end is accepted and buys a second back: 6 - 2 = 4 s.
    assert!(near_eps(
        f(breach.get("ttk")) - f(plain.get("ttk")),
        4.0,
        1e-9
    ));
}

#[test]
fn the_sky_ketch_capture_turns_its_immunity_into_an_opening_and_a_share() {
    let r = purse(&purse_base(|_| {}), "skyketch");
    assert!(r.get("calibrated").truthy());
    assert_eq!(f(r.get("openingS")), 6.6);
    let share = f(r.get("immunityShare"));
    assert!(share > 0.17 && share < 0.19);
    assert_eq!(f(r.get("burst5")), 0.0);
    let plain = purse(&purse_base(|_| {}), "abyss");
    assert!(!plain.get("calibrated").truthy());
}

#[test]
fn the_split_penalty_is_added_only_when_asked_for() {
    let base = purse_base(|_| {});
    let a = purse(&base, "abyss");
    let b = simulate_purse(
        &base,
        &s("abyss"),
        &obj([("level", n(45.0)), ("splitPenaltyS", n(10.0))]),
    )
    .expect("a split penalty");
    assert!(near_eps(f(b.get("ttk")) - f(a.get("ttk")), 10.0, 1e-9));
    assert!(!a.get("calibrated").truthy());
}

// ── flowState.test.js ─────────────────────────────────────────────

#[test]
fn flow_clock_strict_expiry_cap_whole_and_eligibility_gates() {
    let mut f = FlowState::new(&obj([("max", n(5.0)), ("seconds", n(6.0))]));
    assert_eq!(f.stacks_at(0.0), 0.0);
    assert_eq!(f.hit(0.0, true, true).after, 1.0);
    assert_eq!(f.stacks_at(5.999), 1.0);
    assert_eq!(
        f.stacks_at(6.0),
        0.0,
        "at exactly flowUntil the stack is gone"
    );
    for t in 6..11 {
        f.hit(t as f64, true, true);
    }
    assert_eq!(f.stacks_at(10.0), 5.0);
    assert!(
        !f.hit(10.0, false, true).built,
        "a non-whole blow does not charge"
    );
    assert_eq!(f.stacks_at(10.0), 5.0);
    assert!(
        !f.hit(10.0, true, false).built,
        "a warded/zero blow does not charge"
    );
    assert_eq!(f.hit(10.0, true, true).after, 5.0, "the cap");
    assert!(f.until > 10.0, "a charged blow refreshes the duration");
}

#[test]
fn flow_stacks_are_applied_through_the_existing_blow_fight_tier_option() {
    let item = {
        let mut it = weapon(121.0, 9.0, 1.0);
        it.set("rarity", s("legendary"));
        it.set("legendary", s("anseis-edge"));
        it
    };
    let ch = Desc::new()
        .level(30.0)
        .stat("strength", 70.0)
        .stat("agility", 60.0)
        .stat("speed", 60.0)
        .stat("luck", 50.0)
        .skills(0.0)
        .skill(29, 70.0)
        .skill(34, 40.0)
        .skill(19, 50.0)
        .sim(Some(item.clone()));
    let target = reference_foe(30.0, "tough");
    let weapon_row = dfo_core::model_blow::weapon_of(&item, false);
    let mut means = Vec::new();
    for stacks in 0..=5 {
        let args = obj([
            ("target", target.clone()),
            ("health", n(12000.0)),
            ("weapon", weapon_row.clone()),
            ("flowStacks", n(stacks as f64)),
        ]);
        let tier = dfo_core::blow_outcomes::blow_fight_tier(&ch, &args).expect("a tier");
        let mean = dfo_core::blow_outcomes::tier_means(&tier).per_swing;
        let card = analyze(&ch, &args).per_swing;
        assert!(
            (mean - card).abs() <= 1e-12 * card.abs().max(1.0),
            "stacks {stacks}: tier {mean} vs analyze {card}"
        );
        means.push(mean);
    }
    for s in 1..means.len() {
        assert!(means[s] > means[s - 1], "stack {s} raises the blow");
    }
}
