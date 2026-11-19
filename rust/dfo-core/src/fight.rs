//! Expected whole-pool and relay fights (`src/fight.js`).
#![allow(clippy::neg_cmp_op_on_partial_ord)] // The JS negated guards also reject NaN.
use crate::allowance::{
    allowance_law, claim_streams, simulate_allowance, ClaimInput, Phase, Run, SimParams,
};
use crate::analyze::analyze;
use crate::model_blow::weapon_powers;
use crate::round::{js_max, js_min};
use crate::spells::Spellbook;
use crate::value::Value::{self, Arr, Bool, Null, Num, Obj};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

pub(crate) fn obj<const N: usize>(rows: [(&str, Value); N]) -> Value {
    Obj(rows.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

pub(crate) fn num(v: &Value, default: f64) -> f64 {
    Num(v.to_number()).finite_or(default)
}

pub fn health_thresholds(powers: &[Value]) -> Vec<f64> {
    let mut bounds = vec![1.0, 0.5, 0.0];
    for p in powers.iter().filter(|p| p.get("kind").is_str("execute")) {
        let below = num(p.get("below"), 0.0);
        // mutation: equivalent - including either endpoint (0 or 100) adds an existing share (0 or 1), removed by dedup.
        if below > 0.0 && below < 100.0 {
            bounds.push(below / 100.0);
        }
    }
    bounds.sort_by(|a, b| b.total_cmp(a));
    bounds.dedup();
    bounds
}

pub(crate) fn scenario(args: &Value) -> Value {
    let imprint = args.get("imprint");
    if !imprint.truthy() {
        return Obj(args.entries().to_vec());
    }
    let mut out = Obj(args
        .entries()
        .iter()
        .filter(|(k, _)| k != "imprint")
        .cloned()
        .collect());
    let mut imprints = args.get("imprints").items().to_vec();
    imprints.push(imprint.clone());
    out.set("imprints", Arr(imprints));
    out
}

fn health(args: &Value) -> f64 {
    num(
        args.get("health"),
        num(args.get("target").get("maxHealth"), 0.0),
    )
}

pub(crate) fn at(args: &Value, health: f64, share: f64) -> Value {
    let mut args = args.clone();
    args.set("healthShare", Num(share));
    args.set("health", Num(health));
    args
}

fn thresholds(weapon: &Value, args: &Value) -> Vec<f64> {
    let weapon = if weapon.is_nullish() {
        args.get("weapon")
    } else {
        weapon
    };
    health_thresholds(&weapon_powers(weapon, args))
}

pub fn fight(ch: &Value, args: &Value, book: &Spellbook) -> Value {
    let args = scenario(args);
    let health = health(&args);
    // mutation: equivalent - allowing health == 0 leaves hp and t at zero; no band acts and the final guard returns Null.
    if health <= 0.0 {
        return Null;
    }
    let probe = analyze(ch, &at(&args, health, 1.0), book);
    let bounds = thresholds(&probe.weapon, &args);
    let (mut hp, mut t, mut blows, mut dealt) = (health, 0.0, 0.0, 0.0);
    let mut segments = Vec::new();
    for band in bounds.windows(2) {
        // mutation: equivalent - at hp == 0 every nonnegative floor leaves above == 0; the rest of the bands are skipped.
        if hp <= 0.0 {
            break;
        }
        let (hi, lo) = (band[0], band[1]);
        let above = js_max(0.0, hp - lo * health);
        if !(above > 0.0) {
            continue;
        }
        let share = (hi + lo) / 2.0;
        let r = analyze(ch, &at(&args, health, share), book);
        let per = r.per_swing;
        let aps = num(r.cadence.get("aps"), 0.0);
        if !(per > 0.0) || aps <= 0.0 {
            return Null;
        }
        let n = (above / per - 1e-9).ceil();
        let seconds = n / aps;
        t += seconds;
        hp -= n * per;
        dealt += n * per;
        blows += n;
        segments.push(obj([
            ("hi", Num(hi)),
            ("lo", Num(lo)),
            ("share", Num(share)),
            ("perSwing", Num(per)),
            ("aps", Num(aps)),
            ("blows", Num(n)),
            ("seconds", Num(seconds)),
        ]));
    }
    // mutation: equivalent - t == 0 implies all n were zero (each nonzero n is >= 1 and finite positive aps cannot make 1/aps zero), so hp remains positive and the second guard refuses.
    if !(t > 0.0) || hp > 0.0 {
        return Null;
    }
    obj([
        ("killDps", Num(health / t)),
        ("dps", Num(health / t)),
        ("outputDps", Num(dealt / t)),
        ("expectedPerSwing", Num(ratio(dealt, blows))),
        ("overkill", Num(dealt - health)),
        ("ttk", Num(t)),
        ("blows", Num(blows)),
        ("health", Num(health)),
        ("segments", Arr(segments)),
        ("snapshot", probe.to_value()),
    ])
}

pub use fight as fight_dps;

pub(crate) fn edited(args: &Value, edit: &Value) -> Value {
    let mut args = Obj(args.entries().to_vec());
    for (k, v) in edit.entries() {
        args.set(k, v.clone());
    }
    args
}

/// The JS `fight(...).with(edit)` reruns against the original scenario, not the snapshot.
pub fn fight_with(ch: &Value, args: &Value, edit: &Value, book: &Spellbook) -> Value {
    fight(ch, &edited(args, edit), book)
}

pub fn fight_relay_with(ch: &Value, args: &Value, edit: &Value, book: &Spellbook) -> Value {
    fight_relay(ch, &edited(args, edit), book)
}

fn ratio(n: f64, d: f64) -> f64 {
    if d > 0.0 {
        n / d
    } else {
        0.0
    }
}

fn run_value(r: &Run) -> Value {
    obj([
        ("killed", Bool(r.killed)),
        ("ttk", r.ttk.map_or(Null, Num)),
        ("fightSeconds", Num(r.fight_seconds)),
        ("shieldedSeconds", Num(r.shielded_seconds)),
        ("activeSeconds", Num(r.active_seconds)),
        ("claimsOffered", Num(r.claims_offered as f64)),
        ("claimsAccepted", Num(r.claims_accepted as f64)),
        ("claimsRefused", Num(r.claims_refused as f64)),
        ("offered", Num(r.offered)),
        ("claimed", Num(r.claimed)),
        ("landed", Num(r.landed)),
        ("clipped", Num(r.clipped)),
        ("landedShare", Num(r.landed_share)),
        ("burst5", Num(r.burst5)),
        ("dryAt", r.dry_at.map_or(Null, Num)),
        ("immunityShare", Num(r.immunity_share)),
        ("openingS", Num(r.opening_s)),
        ("splitPenaltyS", Num(r.split_penalty_s)),
    ])
}

pub fn fight_relay(ch: &Value, args: &Value, book: &Spellbook) -> Value {
    let args = scenario(args);
    let spec = args.get("target").get("allowance");
    if !spec.truthy() {
        return Null;
    }
    let health = health(&args);
    let pool = health / js_max(1.0, num(spec.get("players"), 1.0));
    // mutation: equivalent - allowing pool == 0 cannot produce a relay run: simulate_allowance rejects a nonpositive share.
    if pool <= 0.0 {
        return Null;
    }
    let probe = analyze(ch, &at(&args, health, 1.0), book);
    // mutation: equivalent - cap is selected from finite hardCap and curbing (finite health multiplied by CURB_SHARE < 1), or zero, so finite_or never takes its fallback.
    let cap = Num(probe.cap).finite_or(0.0);
    // mutation: equivalent - hit probabilities are clamped to finite bounds or NaN. A NaN in the hit terms also propagates through Defence::branch into capped_per_swing (including hand averaging); claim_streams refuses that damage even if the hit fallback changes to 1.
    let hit = num(probe.hit.get("hit"), 0.0);
    let aps = num(probe.cadence.get("aps"), 0.0);
    // mutation: equivalent - allowing a zero hit or aps here, or joining these two failures with &&, still returns Null because claim_streams refuses either nonpositive input.
    if cap <= 0.0 || hit <= 0.0 || aps <= 0.0 {
        return Null;
    }
    let bounds = thresholds(&probe.weapon, &args);
    let streams = claim_streams(&ClaimInput {
        capped_per_swing: probe.capped_per_swing,
        hit,
        aps,
        procs: &[],
        cap,
        with_procs: false,
    });
    if streams.is_empty() {
        return Null;
    }
    let cache = RefCell::new(BTreeMap::new());
    let uncapped = Cell::new(0.0);
    let per_claim = |_: &_, hp: f64, _: f64| {
        // mutation: equivalent - hp starts at pool and every accepted claim subtracts nonnegative damage, so hp/pool <= 1 and raising the upper clamp to 2 cannot affect the share.
        let share = js_max(1e-9, js_min(1.0, hp / pool));
        let mut cache = cache.borrow_mut();
        let i = bounds[1..]
            .iter()
            .position(|&lo| share > lo)
            .expect("a positive share is above the final zero threshold");
        let seg = cache.entry(i).or_insert_with(|| {
            let (hi, lo) = (bounds[i], bounds[i + 1]);
            let mid = (hi + lo) / 2.0;
            let r = analyze(ch, &at(&args, health, mid), book);
            obj([
                ("hi", Num(hi)),
                ("lo", Num(lo)),
                ("share", Num(mid)),
                ("perSwing", Num(r.per_swing)),
                ("cappedPerSwing", Num(r.capped_per_swing)),
                // mutation: equivalent - the segment changes only healthShare; cadence (including dual/pair scheduling) is share-independent, and the probe already required finite positive aps.
                ("aps", Num(num(r.cadence.get("aps"), 0.0))),
            ])
        });
        uncapped.set(uncapped.get() + seg.get("perSwing").to_number() / hit);
        seg.get("cappedPerSwing").to_number() / hit
    };
    let law = allowance_law(spec.get("level").to_number());
    let mut params = SimParams::new(pool, law, &streams);
    params.phases = spec
        .get("phases")
        .items()
        .iter()
        .map(|p| Phase {
            at: p.get("at").to_number(),
            shield_s: p.get("shieldS").to_number(),
        })
        .collect();
    params.opening_s = spec.get("openingS").num_or_default(0.0);
    params.immunity_share = match spec.get("immunityShare") {
        Num(n) => Some(*n),
        _ => None,
    };
    params.per_claim_at = Some(&per_claim);
    let Some(run) = simulate_allowance(&params).filter(|r| r.killed) else {
        return Null;
    };
    // mutation: equivalent - the one stream has positive spacing; only its finite next times <= maxSeconds update fight_seconds, which starts at zero.
    let seconds = Num(run.fight_seconds).finite_or(0.0);
    let ttk = run.ttk.expect("a killed allowance run has a TTK");
    let ceiling = ratio(run.offered, seconds);
    obj([
        ("ttk", Num(ttk)),
        ("fightSeconds", Num(seconds)),
        ("killDps", Num(pool / ttk)),
        ("pool", Num(pool)),
        ("cap", Num(cap)),
        ("refillDps", Num(law.rate)),
        ("bucketDepth", Num(law.depth)),
        ("tokensPerSecond", Num(law.hit_hz)),
        ("uncappedDps", Num(ratio(uncapped.get(), seconds))),
        ("ceilingDps", Num(ceiling)),
        ("acceptedDps", Num(ratio(run.landed, seconds))),
        ("saturated", Bool(run.dry_at.is_some())),
        ("marginDps", Num(ceiling - law.rate)),
        ("clippedShare", Num(ratio(run.clipped, run.offered))),
        ("burst5Dps", Num(run.burst5 / 5.0)),
        ("claimsOffered", Num(run.claims_offered as f64)),
        ("claimsAccepted", Num(run.claims_accepted as f64)),
        ("claimsRefused", Num(run.claims_refused as f64)),
        ("shieldedSeconds", Num(run.shielded_seconds)),
        ("segments", Arr(cache.into_inner().into_values().collect())),
        ("run", run_value(&run)),
        ("snapshot", probe.to_value()),
    ])
}
