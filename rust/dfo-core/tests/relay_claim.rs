mod common;

use common::Case;
use dfo_core::allowance::Law;
use dfo_core::relay_claim::{Options, RelayClaimEngine};
use std::collections::BTreeMap;

fn ff(c: &mut Case, what: &str, got: f64) {
    let e = c.f64();
    c.check_f64(what, e, got);
}
fn fo(c: &mut Case, what: &str, got: Option<f64>) {
    let e = c.opt();
    c.check_opt(what, e, got);
}
fn fb(c: &mut Case, what: &str, got: bool) {
    let e = c.bool();
    c.check_eq(what, e, got);
}
fn fi(c: &mut Case, what: &str, got: u64) {
    let e = c.u64();
    c.check_eq(what, e, got);
}

/// `0` or `1 depth rate cap hitHz ref(opt)`.
fn law(c: &mut Case) -> Option<Law> {
    match c.word().as_str() {
        "0" => None,
        "1" => Some(Law {
            depth: c.f64(),
            rate: c.f64(),
            cap: c.f64(),
            hit_hz: c.f64(),
            reference: c.opt(),
            share: None,
        }),
        w => c.fail(&format!("bad law marker `{w}`")),
    }
}

#[test]
fn relay_claim_matches_js_vectors() {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    let (mut errors, mut kills, mut shielded, mut no_token, mut dry, mut invalid) =
        (0, 0, 0, 0, 0, 0);
    for mut c in common::load("relay_claim") {
        let kind = c.kind.clone();
        match kind.as_str() {
            "relay_ctor" => {
                let level = c.f64();
                let share = c.f64();
                let l = law(&mut c);
                c.expect("=>");
                let ok = c.word() == "ok";
                let mut o = Options::new(share);
                o.level = level;
                o.law = l;
                c.check_eq("constructor accepted", ok, RelayClaimEngine::new(o).is_ok());
            }
            "relay" => {
                let level = c.f64();
                let share = c.f64();
                let fresh = c.bool();
                // `-` is an absent shieldUntil: the constructor's default stands (Options::new, relayClaim.js:59).
                let shield = c.opt();
                let l = law(&mut c);
                let n = c.u64();
                let claims: Vec<(f64, f64)> = (0..n).map(|_| (c.f64(), c.f64())).collect();
                c.expect("=>");
                let mut o = Options::new(share);
                o.level = level;
                o.fresh = fresh;
                if let Some(s) = shield {
                    o.shield_until = s;
                }
                o.law = l;
                let mut e = RelayClaimEngine::new(o).unwrap_or_else(|x| c.fail(&x.to_string()));
                for (i, (t, d)) in claims.iter().enumerate() {
                    let res = e.claim(*t, *d);
                    match c.word().as_str() {
                        "E" => {
                            errors += 1;
                            c.check_eq(&format!("claim {i} errored"), true, res.is_err());
                        }
                        "R" => {
                            let r = res
                                .unwrap_or_else(|x| c.fail(&format!("claim {i}: unexpected {x}")));
                            let w = |s: &str| format!("claim {i} {s}");
                            let reason = c.word();
                            c.check_eq(&w("reason"), reason.as_str(), r.reason.as_str());
                            match reason.as_str() {
                                "shielded" => shielded += 1,
                                "noToken" => no_token += 1,
                                "invalid" => invalid += 1,
                                "empty" => dry += 1,
                                _ => {}
                            }
                            ff(&mut c, &w("t"), r.t);
                            ff(&mut c, &w("claim"), r.claim);
                            fb(&mut c, &w("accepted"), r.accepted);
                            fb(&mut c, &w("refused"), r.refused);
                            fb(&mut c, &w("tokenSpent"), r.token_spent);
                            for (name, got) in [
                                ("want", r.want),
                                ("capped", r.capped),
                                ("got", r.got),
                                ("clipped", r.clipped),
                                ("capClip", r.cap_clip),
                                ("bucketClip", r.bucket_clip),
                                ("healthClip", r.health_clip),
                                ("bucketBefore", r.bucket_before),
                                ("bucketRefilled", r.bucket_refilled),
                                ("bucketAfter", r.bucket_after),
                                ("tokensBefore", r.tokens_before),
                                ("tokensRefilled", r.tokens_refilled),
                                ("tokensAfter", r.tokens_after),
                                ("hpAfter", r.hp_after),
                                ("clippedAfter", r.clipped_after),
                                ("dealtAfter", r.dealt_after),
                            ] {
                                ff(&mut c, &w(name), got);
                            }
                            fb(&mut c, &w("killed"), r.killed);
                            fb(&mut c, &w("dead"), r.dead);
                        }
                        x => c.fail(&format!("bad claim marker `{x}`")),
                    }
                }
                let s = e.summary();
                if s.killed {
                    kills += 1;
                }
                ff(&mut c, "summary.level", s.level);
                fo(&mut c, "summary.ref", s.reference);
                ff(&mut c, "summary.share", s.share);
                ff(&mut c, "summary.hp", s.hp);
                ff(&mut c, "summary.remainingShare", s.remaining_share);
                fb(&mut c, "summary.killed", s.killed);
                fo(&mut c, "summary.killedAt", s.killed_at);
                ff(&mut c, "summary.time", s.time);
                for (name, got) in [
                    ("claims", s.claims),
                    ("accepted", s.accepted),
                    ("refused", s.refused),
                    ("invalid", s.invalid),
                    ("dead", s.dead),
                    ("shielded", s.shielded),
                    ("noToken", s.no_token),
                    ("empty", s.empty),
                ] {
                    fi(&mut c, &format!("summary.{name}"), got);
                }
                for (name, got) in [
                    ("offered", s.offered),
                    ("dealt", s.dealt),
                    ("clipped", s.clipped),
                    ("refusedOffer", s.refused_offer),
                    ("capClip", s.cap_clip),
                    ("bucketClip", s.bucket_clip),
                    ("healthClip", s.health_clip),
                    ("landedShare", s.landed_share),
                ] {
                    ff(&mut c, &format!("summary.{name}"), got);
                }
                fb(&mut c, "summary.saturated", s.saturated);
                fi(&mut c, "summary.bucketLimited", s.bucket_limited);
                fi(&mut c, "summary.tokenLimited", s.token_limited);
                fo(&mut c, "summary.dryAt", s.dry_at);
                for (name, got) in [
                    ("bucket", s.bucket),
                    ("bucketAt", s.bucket_at),
                    ("bucketCapacity", s.bucket_capacity),
                    ("bucketRate", s.bucket_rate),
                    ("tokens", s.tokens),
                    ("tokenAt", s.token_at),
                    ("tokenCapacity", s.token_capacity),
                    ("tokenRate", s.token_rate),
                    ("cap", s.cap),
                    ("shieldUntil", s.shield_until),
                ] {
                    ff(&mut c, &format!("summary.{name}"), got);
                }
                for (name, got) in [
                    ("acceptedDps", s.accepted_dps),
                    ("offeredDps", s.offered_dps),
                    ("killDps", s.kill_dps),
                    ("firstAcceptedAt", s.first_accepted_at),
                    ("lastClaimAt", s.last_claim_at),
                ] {
                    fo(&mut c, &format!("summary.{name}"), got);
                }
            }
            other => c.fail(&format!("unknown kind `{other}`")),
        }
        c.done();
        *seen.entry(kind).or_default() += 1;
    }
    for (what, n, min) in [
        ("thrown claims", errors, 5),
        ("kills", kills, 20),
        ("shielded refusals", shielded, 10),
        ("noToken refusals", no_token, 10),
        ("empty (bucket-dry) results", dry, 5),
        ("invalid refusals", invalid, 10),
    ] {
        assert!(
            n >= min,
            "relay_claim.txt: only {n} {what} (expected >= {min})"
        );
    }
    for (kind, min) in [("relay_ctor", 14), ("relay", 200)] {
        let n = seen.get(kind).copied().unwrap_or(0);
        assert!(
            n >= min,
            "relay_claim.txt: only {n} `{kind}` cases (expected >= {min})"
        );
    }
}
