mod common;

use common::Case;
use dfo_core::allowance::*;
use std::collections::BTreeMap;

fn phases(c: &mut Case) -> Vec<Phase> {
    let n = c.u64();
    (0..n)
        .map(|_| Phase {
            at: c.f64(),
            shield_s: c.f64(),
        })
        .collect()
}

/// `count (perClaim interval start(opt))*`
fn streams(c: &mut Case) -> Vec<Stream> {
    let n = c.u64();
    (0..n)
        .map(|_| Stream {
            kind: Kind::Blow,
            name: None,
            per_claim: c.f64(),
            interval: c.f64(),
            start: c.opt(),
        })
        .collect()
}

/// The `Run` fields, or the word `null`.
fn check_run(c: &mut Case, got: Option<&Run>) {
    if c.peek() == Some("null") {
        c.word();
        c.check_eq("result is null", true, got.is_none());
        return;
    }
    let Some(r) = got else {
        c.fail("expected a run, got None")
    };
    let e = c.bool();
    c.check_eq("killed", e, r.killed);
    let v = c.opt();
    c.check_opt("ttk", v, r.ttk);
    for (what, got) in [
        ("fightSeconds", r.fight_seconds),
        ("shieldedSeconds", r.shielded_seconds),
        ("activeSeconds", r.active_seconds),
    ] {
        let exp = c.f64();
        c.check_f64(what, exp, got);
    }
    for (what, got) in [
        ("claimsOffered", r.claims_offered),
        ("claimsAccepted", r.claims_accepted),
        ("claimsRefused", r.claims_refused),
    ] {
        let exp = c.u64();
        c.check_eq(what, exp, got);
    }
    for (what, got) in [
        ("offered", r.offered),
        ("claimed", r.claimed),
        ("landed", r.landed),
        ("clipped", r.clipped),
        ("landedShare", r.landed_share),
        ("burst5", r.burst5),
    ] {
        let exp = c.f64();
        c.check_f64(what, exp, got);
    }
    let v = c.opt();
    c.check_opt("dryAt", v, r.dry_at);
    for (what, got) in [
        ("immunityShare", r.immunity_share),
        ("openingS", r.opening_s),
        ("splitPenaltyS", r.split_penalty_s),
    ] {
        let exp = c.f64();
        c.check_f64(what, exp, got);
    }
}

#[test]
fn allowance_matches_js_vectors() {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    let mut nulls = 0;
    let mut kills = 0;
    let mut boundary_hits = 0;
    for mut c in common::load("allowance") {
        let kind = c.kind.clone();
        match kind.as_str() {
            "ref_of" => {
                let (lv, r) = (c.f64(), c.f64());
                c.check_f64(&format!("ref_of({lv:?})"), r, ref_of(lv));
            }
            "law" => {
                let lv = c.f64();
                let l = allowance_law(lv);
                let exp = [c.f64(), c.f64(), c.f64(), c.f64(), c.f64(), c.f64()];
                let got = [
                    l.reference.unwrap(),
                    l.depth,
                    l.rate,
                    l.cap,
                    l.hit_hz,
                    l.share.unwrap(),
                ];
                for (i, w) in ["ref", "depth", "rate", "cap", "hitHz", "share"]
                    .iter()
                    .enumerate()
                {
                    c.check_f64(&format!("law({lv:?}).{w}"), exp[i], got[i]);
                }
            }
            "spec" => {
                let level = c.f64();
                let players = c.f64();
                let opening = c.f64();
                let imm = c.opt();
                let ph = phases(&mut c);
                c.expect("=>");
                let s = allowance_spec(level, players, &ph, opening, imm);
                let e = c.f64();
                c.check_f64("level", e, s.level);
                let e = c.f64();
                c.check_f64("players", e, s.players);
                let e = c.f64();
                c.check_f64("openingS", e, s.opening_s);
                let e = c.opt();
                c.check_opt("immunityShare", e, s.immunity_share);
                let ep = phases(&mut c);
                c.check_eq("phase count", ep.len(), s.phases.len());
                for (a, b) in ep.iter().zip(&s.phases) {
                    c.check_f64("phase.at", a.at, b.at);
                    c.check_f64("phase.shieldS", a.shield_s, b.shield_s);
                }
            }
            "streams" => {
                let capped = c.f64();
                let hit = c.f64();
                let aps = c.f64();
                let cap = c.f64();
                let with_procs = c.bool();
                let np = c.u64();
                let procs: Vec<Proc> = (0..np)
                    .map(|_| Proc {
                        name: c.opt_name(),
                        damage: c.f64(),
                        dot_tick: c.f64(),
                    })
                    .collect();
                c.expect("=>");
                let got = claim_streams(&ClaimInput {
                    capped_per_swing: capped,
                    hit,
                    aps,
                    procs: &procs,
                    cap,
                    with_procs,
                });
                let n = c.u64();
                c.check_eq("stream count", n as usize, got.len());
                for g in &got {
                    let k = match c.word().as_str() {
                        "b" => Kind::Blow,
                        "p" => Kind::Proc,
                        "d" => Kind::Dot,
                        w => c.fail(&format!("bad kind `{w}`")),
                    };
                    c.check_eq("kind", k, g.kind);
                    let e = c.opt_name();
                    c.check_eq("name", e, g.name.clone());
                    let e = c.f64();
                    c.check_f64("perClaim", e, g.per_claim);
                    let e = c.f64();
                    c.check_f64("interval", e, g.interval);
                    let e = c.f64();
                    c.check_opt("start", Some(e), g.start);
                }
            }
            "steady" => {
                let law = Law {
                    reference: None,
                    depth: c.f64(),
                    rate: c.f64(),
                    cap: c.f64(),
                    hit_hz: c.f64(),
                    share: None,
                };
                let st = streams(&mut c);
                c.expect("=>");
                let s = steady_state(&st, &law);
                for (what, got) in [
                    ("offeredDps", s.offered_dps),
                    ("claimsPerSecond", s.claims_per_second),
                    ("claimLimitedDps", s.claim_limited_dps),
                    ("refill", s.refill),
                    ("sustainedDps", s.sustained_dps),
                ] {
                    let e = c.f64();
                    c.check_f64(what, e, got);
                }
                let e = c.bool();
                c.check_eq("saturated", e, s.saturated);
            }
            "simulate" | "simulate_shield_end" => {
                let share = c.f64();
                let law = Law {
                    reference: None,
                    depth: c.f64(),
                    rate: c.f64(),
                    cap: c.f64(),
                    hit_hz: c.f64(),
                    share: None,
                };
                let fresh = c.bool();
                let opening = c.f64();
                let imm = c.opt();
                let split = c.f64();
                let max_s = c.f64();
                let burst_w = c.f64();
                let mode = c.int();
                let ph = phases(&mut c);
                let st = streams(&mut c);
                c.expect("=>");
                let f1 = move |s: &Stream, hp: f64, _t: f64| s.per_claim * (0.5 + hp / share);
                let f2 = |_: &Stream, _: f64, _: f64| -1.0;
                let f3 = |_: &Stream, _: f64, _: f64| f64::NAN;
                let f4 = |s: &Stream, _: f64, t: f64| {
                    if t < 10.0 {
                        s.per_claim
                    } else {
                        s.per_claim * 2.0
                    }
                };
                let mut p = SimParams::new(share, law, &st);
                p.phases = ph;
                p.opening_s = opening;
                p.immunity_share = imm;
                p.split_penalty_s = split;
                p.fresh = fresh;
                p.max_seconds = max_s;
                p.burst_window_s = burst_w;
                p.per_claim_at = match mode {
                    0 => None,
                    1 => Some(&f1),
                    2 => Some(&f2),
                    3 => Some(&f3),
                    4 => Some(&f4),
                    m => c.fail(&format!("unknown mode {m}")),
                };
                let run = simulate_allowance(&p);
                if kind == "simulate_shield_end" {
                    let r = run.as_ref().unwrap();
                    // the boundary must really be exercised: a phase shield was raised and later claims landed
                    if r.shielded_seconds > 0.0 && r.claims_accepted > 0 {
                        boundary_hits += 1;
                    }
                }
                if run.is_none() {
                    nulls += 1;
                }
                if run.as_ref().is_some_and(|r| r.killed) {
                    kills += 1;
                }
                check_run(&mut c, run.as_ref());
            }
            "run" => {
                let level = c.f64();
                let share = c.f64();
                let has_spec = c.bool();
                let opening = c.f64();
                let imm = c.opt();
                let ph = phases(&mut c);
                let st = streams(&mut c);
                let fresh = c.bool();
                let split = c.f64();
                c.expect("=>");
                let spec = Spec {
                    level,
                    players: 1.0,
                    phases: ph,
                    opening_s: opening,
                    immunity_share: imm,
                };
                let got = run_allowance(level, share, has_spec.then_some(&spec), &st, fresh, split);
                if c.peek() == Some("null") {
                    c.word();
                    c.check_eq("result is null", true, got.is_none());
                } else {
                    let Some(r) = got else {
                        c.fail("expected a report, got None")
                    };
                    let l = r.law;
                    for (what, got) in [
                        ("law.ref", l.reference.unwrap()),
                        ("law.depth", l.depth),
                        ("law.rate", l.rate),
                        ("law.cap", l.cap),
                        ("law.hitHz", l.hit_hz),
                        ("law.share", l.share.unwrap()),
                        ("share", r.share),
                    ] {
                        let e = c.f64();
                        c.check_f64(what, e, got);
                    }
                    check_run(&mut c, Some(&r.run));
                    for (what, got) in [
                        ("ceilingDps", r.ceiling_dps),
                        ("sustainedDps", r.sustained_dps),
                    ] {
                        let e = c.f64();
                        c.check_f64(what, e, got);
                    }
                    let e = c.bool();
                    c.check_eq("saturated", e, r.saturated);
                    for (what, got) in [
                        ("claimsPerSecond", r.claims_per_second),
                        ("burst5Dps", r.burst5_dps),
                    ] {
                        let e = c.f64();
                        c.check_f64(what, e, got);
                    }
                    let e = c.opt();
                    c.check_opt("averageDps", e, r.average_dps);
                }
            }
            other => c.fail(&format!("unknown kind `{other}`")),
        }
        c.done();
        *seen.entry(kind).or_default() += 1;
    }
    assert!(
        nulls >= 4,
        "allowance.txt: only {nulls} null simulate results"
    );
    assert!(
        boundary_hits >= 8,
        "allowance.txt: only {boundary_hits} shield-end boundary cases ran a shield"
    );
    assert!(kills >= 50, "allowance.txt: only {kills} simulated kills");
    for (kind, min) in [
        ("ref_of", 90),
        ("law", 90),
        ("spec", 200),
        ("streams", 150),
        ("steady", 150),
        ("simulate", 150),
        ("simulate_shield_end", 8),
        ("run", 100),
    ] {
        let n = seen.get(kind).copied().unwrap_or(0);
        assert!(
            n >= min,
            "allowance.txt: only {n} `{kind}` cases (expected >= {min})"
        );
    }
}
