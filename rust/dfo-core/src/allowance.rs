//! The relay's per-player damage allowance. Port of the pure parts of `src/allowance.js` (the
//! whole file is pure: it has no imports). The law is the vendored one
//! (`vendor/upstream/a3eb1605/src/net/gate/gateBrain.js` `joinFight` :1213, `applyHit` :1298,
//! `spendBlow` :3411, constants :302-311, :328-329).
//!
//! Boundaries with JS:
//! * Numbers that the JS coerces with `Number(x) || d` arrive here as `f64` (an absent/undefined
//!   value is `NAN`); [`or_default`] reproduces the coercion.
//! * `simulateAllowance`'s `perClaimAt` callback is an `Option<&dyn Fn(&Stream, f64, f64) -> f64>`.
//! * Counters (`claims`, `accepted`, ...) are JS numbers that only ever hold small non-negative
//!   integers; they are `u64` here.
//! * Stream and proc names are `Option<String>`; names that are not valid Unicode (lone surrogates)
//!   are not representable (names never reach a number).
//! * `phases` are sorted with an insertion sort driven by the JS comparator `b.at - a.at`
//!   (stable, never panics on NaN, same order as V8's stable sort for a consistent comparator).
//!
//! Citations are `src/allowance.js:LINE`.

// The JS writes `!(x > 0)` on purpose: it is also true for NaN, which `x <= 0` is not.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

use crate::round::{js_clamp, js_max, js_min, or_default};

/// `perClaimAt(stream, hp, t)`: what a claim is worth at the health that stands when it is made.
pub type PerClaimAt<'a> = &'a dyn Fn(&Stream, f64, f64) -> f64;

/// `ALLOWANCE` (`:37`), gateBrain.js:302-311.
pub const DEPTH_X: f64 = 15.0;
pub const RATE_X: f64 = 3.0;
pub const HIT_CAP_X: f64 = 12.0;
pub const HIT_HZ: f64 = 4.0;
pub const SHARE_S: f64 = 240.0;
pub const REF_MIN: f64 = 1.0;
pub const REF_MAX: f64 = 60.0;

/// `DOT_ROUND_S` (`:40`): one magic round in real seconds.
pub const DOT_ROUND_S: f64 = 5.0;

/// A shield raised as health falls through `at` (`{at, shieldS}`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Phase {
    pub at: f64,
    pub shield_s: f64,
}

/// `BREACH_PHASES` (`:43-46`; gateBrain.js:328-329). The fractions and the ward are the generated rows
/// (`generated::allowance`, from the real JS): never hand-copied here.
pub const BREACH_PHASES: [Phase; 2] = {
    let [a, b] = crate::generated::allowance::BREACH_PHASES else {
        panic!("generated BREACH_PHASES has two phases")
    };
    [
        Phase {
            at: a.0,
            shield_s: a.1,
        },
        Phase {
            at: b.0,
            shield_s: b.1,
        },
    ]
};

/// `refOf(level)` (`:49`): `5 + clamp(floor(Number(level) || 1), 1, 60)`.
pub fn ref_of(level: f64) -> f64 {
    5.0 + js_clamp(or_default(level, 1.0).floor(), REF_MIN, REF_MAX)
}

/// The per-player law (`allowanceLaw`, `:52-62`). `reference` and `share` are `None` only for a
/// hand-built law (the JS engine accepts a law without them, `relayClaim.js:51`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Law {
    pub reference: Option<f64>,
    pub depth: f64,
    pub rate: f64,
    pub cap: f64,
    pub hit_hz: f64,
    pub share: Option<f64>,
}

/// `allowanceLaw(level)` (`:52-62`).
pub fn allowance_law(level: f64) -> Law {
    let r = ref_of(level);
    Law {
        reference: Some(r),
        depth: DEPTH_X * r,
        rate: RATE_X * r,
        cap: HIT_CAP_X * r,
        hit_hz: HIT_HZ,
        share: Some(SHARE_S * r),
    }
}

/// `allowanceSpec` result (`:70-78`).
#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    pub level: f64,
    pub players: f64,
    pub phases: Vec<Phase>,
    pub opening_s: f64,
    pub immunity_share: Option<f64>,
}

/// `allowanceSpec(level, {players, phases, openingS, immunityShare})` (`:70-78`). Pass
/// `&BREACH_PHASES` for the JS default of `phases`; `players` is `1.0` and `opening_s` `0.0` by
/// default; a non-finite `immunity_share` becomes `None`.
pub fn allowance_spec(
    level: f64,
    players: f64,
    phases: &[Phase],
    opening_s: f64,
    immunity_share: Option<f64>,
) -> Spec {
    Spec {
        level,
        players: js_max(1.0, or_default(players, 1.0).floor()),
        phases: phases
            .iter()
            .map(|p| Phase {
                at: p.at,
                shield_s: or_default(p.shield_s, 0.0),
            })
            .collect(),
        opening_s: js_max(0.0, or_default(opening_s, 0.0)),
        immunity_share: immunity_share.filter(|v| v.is_finite()),
    }
}

/// Which claim a stream carries (`kind`, `:106,111,114`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Blow,
    Proc,
    Dot,
}

/// One claim stream: `{kind, name?, perClaim, interval, start}`.
#[derive(Debug, Clone, PartialEq)]
pub struct Stream {
    pub kind: Kind,
    pub name: Option<String>,
    pub per_claim: f64,
    pub interval: f64,
    /// `None` is JS `undefined`: `simulateAllowance` then starts at `interval` (`:162`).
    pub start: Option<f64>,
}

/// A Cast-When-Strikes proc: `{name, damage, dotTick}` (`:109-113`).
#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    pub name: Option<String>,
    pub damage: f64,
    pub dot_tick: f64,
}

/// `claimStreams` argument (`:97`). `cap: 0.0` and `with_procs: true` are the JS defaults.
#[derive(Debug, Clone)]
pub struct ClaimInput<'a> {
    pub capped_per_swing: f64,
    pub hit: f64,
    pub aps: f64,
    pub procs: &'a [Proc],
    pub cap: f64,
    pub with_procs: bool,
}

/// `claimStreams` (`:97-116`): the claims one build offers.
pub fn claim_streams(input: &ClaimInput) -> Vec<Stream> {
    let mut out = Vec::new();
    let h = js_max(0.0, js_min(1.0, or_default(input.hit, 0.0)));
    let swings = or_default(input.aps, 0.0);
    let per = or_default(input.capped_per_swing, 0.0);
    if !(h > 0.0) || !(swings > 0.0) || !(per > 0.0) {
        return out;
    }
    let interval = 1.0 / (swings * h);
    let cap = input.cap;
    let limit = |v: f64| if cap > 0.0 { js_min(v, cap) } else { v };
    let blow = limit(per / h);
    out.push(Stream {
        kind: Kind::Blow,
        name: None,
        per_claim: blow,
        interval,
        start: Some(interval),
    });
    if !input.with_procs {
        return out;
    }
    let mut dot = 0.0;
    for p in input.procs {
        let instant = or_default(p.damage, 0.0);
        if instant > 0.0 {
            out.push(Stream {
                kind: Kind::Proc,
                name: p.name.clone(),
                per_claim: limit(instant),
                interval,
                start: Some(interval),
            });
        }
        dot += or_default(p.dot_tick, 0.0);
    }
    if dot > 0.0 {
        out.push(Stream {
            kind: Kind::Dot,
            name: None,
            per_claim: limit(dot),
            interval: DOT_ROUND_S,
            start: Some(interval),
        });
    }
    out
}

/// `simulateAllowance` arguments (`:134`). Defaults: see [`SimParams::new`].
pub struct SimParams<'a> {
    pub share: f64,
    pub law: Law,
    pub streams: &'a [Stream],
    pub phases: Vec<Phase>,
    pub opening_s: f64,
    pub immunity_share: Option<f64>,
    pub split_penalty_s: f64,
    pub fresh: bool,
    pub max_seconds: f64,
    pub burst_window_s: f64,
    /// `perClaimAt(stream, hp, t)`.
    pub per_claim_at: Option<PerClaimAt<'a>>,
}

impl<'a> SimParams<'a> {
    /// The JS defaults: no phases, no opening, no immunity, no split penalty, `fresh`,
    /// `maxSeconds = 3600`, `burstWindowS = 5`, no `perClaimAt`.
    pub fn new(share: f64, law: Law, streams: &'a [Stream]) -> Self {
        SimParams {
            share,
            law,
            streams,
            phases: Vec::new(),
            opening_s: 0.0,
            immunity_share: None,
            split_penalty_s: 0.0,
            fresh: true,
            max_seconds: 3600.0,
            burst_window_s: 5.0,
            per_claim_at: None,
        }
    }
}

/// The result of `simulateAllowance` (`:211-230`).
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub killed: bool,
    pub ttk: Option<f64>,
    pub fight_seconds: f64,
    pub shielded_seconds: f64,
    pub active_seconds: f64,
    pub claims_offered: u64,
    pub claims_accepted: u64,
    pub claims_refused: u64,
    pub offered: f64,
    pub claimed: f64,
    pub landed: f64,
    pub clipped: f64,
    pub landed_share: f64,
    pub burst5: f64,
    pub dry_at: Option<f64>,
    pub immunity_share: f64,
    pub opening_s: f64,
    pub split_penalty_s: f64,
}

/// Stable insertion sort by the JS comparator `(a, b) => b.at - a.at`.
fn sort_phases_desc(phases: &mut [Phase]) {
    for i in 1..phases.len() {
        let mut j = i;
        while j > 0 {
            // comparator(prev, cur) = cur.at - prev.at; > 0 means cur sorts before prev
            if phases[j].at - phases[j - 1].at > 0.0 {
                phases.swap(j, j - 1);
                j -= 1;
            } else {
                break;
            }
        }
    }
}

/// `simulateAllowance` (`:134-231`): claims through the relay's law over time. `None` is the JS
/// `null` (no positive share, or no streams).
///
/// The caller must keep every stream `interval` positive (a zero interval never advances `t`; the
/// JS would not terminate either).
pub fn simulate_allowance(p: &SimParams) -> Option<Run> {
    let (depth, rate, cap, hit_hz) = (p.law.depth, p.law.rate, p.law.cap, p.law.hit_hz);
    let total = or_default(p.share, 0.0);
    if !(total > 0.0) || p.streams.is_empty() {
        return None;
    }

    let mut t = 0.0_f64;
    let mut hp = total;
    let mut bucket = if p.fresh { depth } else { 0.0 };
    let mut bucket_at = 0.0_f64;
    let mut tokens = hit_hz;
    let mut token_at = 0.0_f64;
    let mut shield_until = 0.0_f64;
    let mut shielded = 0.0_f64;
    let mut phase_at = 0usize;
    let mut order = p.phases.clone();
    sort_phases_desc(&mut order);

    let mut offered = 0.0_f64;
    let mut claimed = 0.0_f64;
    let mut landed = 0.0_f64;
    let mut claims = 0u64;
    let mut accepted = 0u64;
    let mut refused = 0u64;
    let mut clipped = 0.0_f64;
    let mut burst = 0.0_f64;
    let mut dry_at: Option<f64> = None;
    let burst_end = js_max(
        0.0,
        p.burst_window_s - js_max(0.0, or_default(p.opening_s, 0.0)),
    );

    let mut next: Vec<f64> = p
        .streams
        .iter()
        .map(|s| s.start.unwrap_or(s.interval))
        .collect();

    while hp > 1e-9 && t < p.max_seconds {
        let mut k = 0usize;
        for i in 1..next.len() {
            if next[i] < next[k] - 1e-12 {
                k = i;
            }
        }
        if next[k] > p.max_seconds {
            break;
        }
        let s = &p.streams[k];
        t = next[k];
        next[k] += s.interval;

        bucket = js_min(depth, bucket + js_max(0.0, t - bucket_at) * rate);
        bucket_at = t;
        tokens = js_min(hit_hz, tokens + js_max(0.0, t - token_at) * hit_hz);
        token_at = t;

        let claim = match p.per_claim_at {
            Some(f) => js_max(0.0, or_default(f(s, hp, t), 0.0)),
            None => s.per_claim,
        };
        offered += claim;
        claims += 1;
        if t < shield_until {
            // refused before a token is spent; the law is strict (src/allowance.js:180;
            // vendor/upstream/a3eb1605/src/net/gate/gateBrain.js:1308@a3eb1605 `now < B.shieldUntil`),
            // so a claim at exactly the shield's end is accepted
            refused += 1;
            continue;
        }
        if tokens < 1.0 {
            refused += 1;
            continue;
        }
        tokens -= 1.0;
        claimed += claim;
        let want = js_min(claim, cap);
        let got = js_max(0.0, js_min(js_min(want, bucket), hp));
        if got < js_min(want, hp) - 1e-9 && dry_at.is_none() {
            dry_at = Some(t);
        }
        clipped += claim - got;
        bucket -= got;
        hp -= got;
        landed += got;
        accepted += 1;
        if t <= burst_end {
            burst += got;
        }
        while phase_at < order.len() && hp <= total * order[phase_at].at {
            let until = t + or_default(order[phase_at].shield_s, 0.0);
            shielded += js_max(0.0, until - js_max(t, shield_until));
            shield_until = js_max(shield_until, until);
            phase_at += 1;
        }
    }

    let killed = hp <= 1e-9;
    let immune = match p.immunity_share {
        Some(v) if v.is_finite() => js_clamp(v, 0.0, 0.95),
        _ => 0.0,
    };
    let ttk = if killed {
        Some(
            or_default(p.opening_s, 0.0)
                // mutation: equivalent - `immune` is clamped to [0, 0.95] just above, so `1.0 - immune` is in
                // [0.05, 1.0] and every floor this line could hold (1e-9, 1e-10, ...) is far below 0.05: js_max
                // never picks it, so changing the constant cannot change any reachable ttk.
                + t / js_max(1e-9, 1.0 - immune)
                + js_max(0.0, p.split_penalty_s),
        )
    } else {
        None
    };
    Some(Run {
        killed,
        ttk,
        fight_seconds: t,
        shielded_seconds: shielded,
        active_seconds: js_max(0.0, t - shielded),
        claims_offered: claims,
        claims_accepted: accepted,
        claims_refused: refused,
        offered,
        claimed,
        landed,
        clipped,
        landed_share: if claimed > 0.0 { landed / claimed } else { 0.0 },
        burst5: burst,
        dry_at,
        immunity_share: immune,
        opening_s: or_default(p.opening_s, 0.0),
        split_penalty_s: js_max(0.0, p.split_penalty_s),
    })
}

/// The result of `steadyState` (`:250-257`).
#[derive(Debug, Clone, PartialEq)]
pub struct Steady {
    pub offered_dps: f64,
    pub claims_per_second: f64,
    pub claim_limited_dps: f64,
    pub refill: f64,
    pub sustained_dps: f64,
    pub saturated: bool,
}

/// `steadyState(streams, law)` (`:240-258`): offered damage a second before the relay and the
/// rate it can sustain (a fixed point, not a time average).
pub fn steady_state(streams: &[Stream], law: &Law) -> Steady {
    let mut dps = 0.0_f64;
    let mut claims_per_s = 0.0_f64;
    for s in streams {
        dps += s.per_claim / s.interval;
        claims_per_s += 1.0 / s.interval;
    }
    let thin = if claims_per_s > law.hit_hz {
        law.hit_hz / claims_per_s
    } else {
        1.0
    };
    let claim_limited = dps * thin;
    Steady {
        offered_dps: dps,
        claims_per_second: claims_per_s,
        claim_limited_dps: claim_limited,
        refill: law.rate,
        sustained_dps: js_min(claim_limited, law.rate),
        saturated: claim_limited > law.rate,
    }
}

/// The encounter's answer for one build (`runAllowance`, `:271-296`): the run plus the named
/// metrics. `ceiling_dps` is per-hit-capped before the relay; `sustained_dps` the allowance fixed
/// point; `burst5_dps` the first five seconds; `average_dps` the whole fight's mean.
#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub law: Law,
    pub share: f64,
    pub run: Run,
    pub ceiling_dps: f64,
    pub sustained_dps: f64,
    pub saturated: bool,
    pub claims_per_second: f64,
    pub burst5_dps: f64,
    /// `run.ttk ? share / run.ttk : null` (a zero or NaN `ttk` is falsy in JS).
    pub average_dps: Option<f64>,
}

/// `runAllowance` (`:271-296`). `spec` is `spec?.` in the JS: `None` gives no phases, no opening,
/// no immunity.
pub fn run_allowance(
    level: f64,
    share: f64,
    spec: Option<&Spec>,
    streams: &[Stream],
    fresh: bool,
    split_penalty_s: f64,
) -> Option<Report> {
    let law = allowance_law(level);
    let mut params = SimParams::new(share, law, streams);
    params.phases = spec.map(|s| s.phases.clone()).unwrap_or_default();
    params.opening_s = spec.map_or(0.0, |s| s.opening_s);
    params.immunity_share = spec.and_then(|s| s.immunity_share);
    params.split_penalty_s = split_penalty_s;
    params.fresh = fresh;
    let run = simulate_allowance(&params)?;
    let steady = steady_state(streams, &law);
    let average_dps = match run.ttk {
        Some(ttk) if !(ttk.is_nan() || ttk == 0.0) => Some(share / ttk),
        _ => None,
    };
    Some(Report {
        law,
        share,
        ceiling_dps: steady.offered_dps,
        sustained_dps: steady.sustained_dps,
        saturated: steady.saturated,
        claims_per_second: steady.claims_per_second,
        burst5_dps: run.burst5 / 5.0,
        average_dps,
        run,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_clamps_and_defaults() {
        assert_eq!(ref_of(1.0), 6.0);
        assert_eq!(ref_of(60.0), 65.0);
        assert_eq!(ref_of(1000.0), 65.0);
        assert_eq!(ref_of(-3.0), 6.0);
        assert_eq!(ref_of(f64::NAN), 6.0); // Number(undefined) || 1
        assert_eq!(ref_of(0.0), 6.0);
        assert_eq!(ref_of(59.9), 64.0);
    }

    #[test]
    fn law_scales_with_ref() {
        let l = allowance_law(10.0);
        assert_eq!(l.reference, Some(15.0));
        assert_eq!(l.depth, 225.0);
        assert_eq!(l.rate, 45.0);
        assert_eq!(l.cap, 180.0);
        assert_eq!(l.hit_hz, 4.0);
        assert_eq!(l.share, Some(3600.0));
    }

    /// The JS defaults of `simulateAllowance` (`src/allowance.js:134`), which `SimParams::new` must carry: only a
    /// hand-built `SimParams` that skips a default can observe these, so no vector can pin them.
    #[test]
    fn sim_params_new_keeps_the_js_defaults() {
        let law = allowance_law(1.0);
        let p = SimParams::new(100.0, law, &[]);
        assert_eq!(p.opening_s, 0.0);
        assert_eq!(p.split_penalty_s, 0.0);
        assert_eq!(p.max_seconds, 3600.0);
        assert_eq!(p.burst_window_s, 5.0);
        assert!(p.phases.is_empty());
        assert_eq!(p.immunity_share, None);
        assert!(p.fresh);
        assert!(p.per_claim_at.is_none());
    }

    #[test]
    fn phases_sort_descending_and_stable() {
        let mut v = [
            Phase {
                at: 0.3,
                shield_s: 1.0,
            },
            Phase {
                at: 0.6,
                shield_s: 2.0,
            },
            Phase {
                at: 0.3,
                shield_s: 3.0,
            },
        ];
        sort_phases_desc(&mut v);
        assert_eq!(v.map(|p| p.shield_s), [2.0, 1.0, 3.0]);
    }

    #[test]
    fn no_share_or_no_streams_is_null() {
        let law = allowance_law(1.0);
        assert!(simulate_allowance(&SimParams::new(0.0, law, &[])).is_none());
        let s = [Stream {
            kind: Kind::Blow,
            name: None,
            per_claim: 1.0,
            interval: 1.0,
            start: Some(1.0),
        }];
        assert!(simulate_allowance(&SimParams::new(f64::NAN, law, &s)).is_none());
        assert!(simulate_allowance(&SimParams::new(10.0, law, &s)).is_some());
    }
}
