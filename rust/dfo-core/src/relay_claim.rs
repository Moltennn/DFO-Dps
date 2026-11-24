//! The relay's claim engine: one ordered claim at a time. Port of `src/relayClaim.js`
//! (`createRelayClaimEngine`), which mirrors the vendored `gateBrain.js` `applyHit` (:1298) and
//! `spendBlow` (:3411).
//!
//! Order kept exactly as the JS (`relayClaim.js:142-216`): dead fight, then a claim that is not a
//! positive finite number (neither touches a clock), then the shield, then `spendBlow`'s token
//! refill (the clock moves even when the claim is refused for want of a token), then the damage
//! purse refill and `got = max(0, min(claim, cap, bucket, hp))`. Nothing is rounded.
//!
//! Boundary with JS: the JS accepts `claim({t, damage})`, `claim({t, d})` or `claim(t, damage)` with
//! arbitrary values. Here `t` and `damage` are `f64`; a JS value that is not a number is modelled
//! as `NAN` (for `damage` the JS also treats it as invalid, via `Number.isFinite`). The engine
//! returns one [`ClaimResult`] per call; the JS result object's `claim`/`damage` echo of the raw
//! input is `claim` here.
//!
//! The engine does NOT model what the JS engine documents as out of scope (pose/floor/court test,
//! Sundered halves, stun multiplier, `restoreShare`, the Wrath clock, multi-body `spendBlow`;
//! assumptions register M30).

// The JS writes `!(tokens >= 1)` on purpose: it is also true for NaN, which `tokens < 1` is not.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

use crate::allowance::{allowance_law, Law};
use crate::round::{js_max, js_min, or_default};
use std::fmt;

/// `KILL_EPS` (`relayClaim.js:29`; gateBrain.js:1344).
pub const KILL_EPS: f64 = 1e-6;

/// JS `TypeError` / `RangeError` as a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimError {
    Type(String),
    Range(String),
}

impl fmt::Display for ClaimError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClaimError::Type(m) => write!(f, "TypeError: {m}"),
            ClaimError::Range(m) => write!(f, "RangeError: {m}"),
        }
    }
}

impl std::error::Error for ClaimError {}

fn positive(v: f64) -> bool {
    v.is_finite() && v > 0.0
}

/// Why a claim was accepted or refused (`result.reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Accepted,
    AcceptedClipped,
    Empty,
    Dead,
    Invalid,
    Shielded,
    NoToken,
}

impl Reason {
    /// The JS string.
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Accepted => "accepted",
            Reason::AcceptedClipped => "accepted-clipped",
            Reason::Empty => "empty",
            Reason::Dead => "dead",
            Reason::Invalid => "invalid",
            Reason::Shielded => "shielded",
            Reason::NoToken => "noToken",
        }
    }
}

/// The per-claim result object (`relayClaim.js:114-140`, filled through `:216`).
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimResult {
    pub t: f64,
    /// The raw claim as offered (`result.claim` / `result.damage`).
    pub claim: f64,
    pub accepted: bool,
    pub refused: bool,
    pub reason: Reason,
    pub token_spent: bool,
    pub want: f64,
    pub capped: f64,
    pub got: f64,
    pub clipped: f64,
    pub cap_clip: f64,
    pub bucket_clip: f64,
    pub health_clip: f64,
    pub bucket_before: f64,
    pub bucket_refilled: f64,
    pub bucket_after: f64,
    pub tokens_before: f64,
    pub tokens_refilled: f64,
    pub tokens_after: f64,
    pub hp_after: f64,
    pub clipped_after: f64,
    pub dealt_after: f64,
    pub killed: bool,
    pub dead: bool,
}

/// `summary()` (`relayClaim.js:220-266`).
#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub level: f64,
    pub reference: Option<f64>,
    pub share: f64,
    pub hp: f64,
    pub remaining_share: f64,
    pub killed: bool,
    pub killed_at: Option<f64>,
    pub time: f64,
    pub claims: u64,
    pub accepted: u64,
    pub refused: u64,
    pub invalid: u64,
    pub dead: u64,
    pub shielded: u64,
    pub no_token: u64,
    pub empty: u64,
    pub offered: f64,
    pub dealt: f64,
    pub clipped: f64,
    pub refused_offer: f64,
    pub cap_clip: f64,
    pub bucket_clip: f64,
    pub health_clip: f64,
    pub landed_share: f64,
    pub saturated: bool,
    pub bucket_limited: u64,
    pub token_limited: u64,
    pub dry_at: Option<f64>,
    pub bucket: f64,
    pub bucket_at: f64,
    pub bucket_capacity: f64,
    pub bucket_rate: f64,
    pub tokens: f64,
    pub token_at: f64,
    pub token_capacity: f64,
    pub token_rate: f64,
    pub cap: f64,
    pub shield_until: f64,
    pub accepted_dps: Option<f64>,
    pub offered_dps: Option<f64>,
    pub kill_dps: Option<f64>,
    pub first_accepted_at: Option<f64>,
    pub last_claim_at: Option<f64>,
}

/// A streaming relay allowance for one player.
#[derive(Debug, Clone)]
pub struct RelayClaimEngine {
    level: f64,
    law: Law,
    share: f64,
    hp: f64,
    bucket: f64,
    bucket_at: f64,
    tokens: f64,
    token_at: f64,
    shield_until: f64,
    time: f64,
    killed: bool,
    killed_at: Option<f64>,
    claims: u64,
    accepted: u64,
    refused: u64,
    invalid: u64,
    dead: u64,
    shielded: u64,
    no_token: u64,
    empty: u64,
    offered: f64,
    dealt: f64,
    clipped: f64,
    cap_clip: f64,
    bucket_clip: f64,
    health_clip: f64,
    bucket_limited: u64,
    token_limited: u64,
    dry_at: Option<f64>,
    first_accepted_at: Option<f64>,
    last_claim_at: Option<f64>,
}

/// Constructor options (`createRelayClaimEngine({level, share, law, fresh, shieldUntil})`).
/// `level` defaults to 1 and `fresh` to true; `shield_until` to 0.
#[derive(Debug, Clone, Copy)]
pub struct Options {
    pub level: f64,
    pub share: f64,
    pub law: Option<Law>,
    pub fresh: bool,
    pub shield_until: f64,
}

impl Options {
    /// The JS defaults for everything but `share`.
    pub fn new(share: f64) -> Self {
        Options {
            level: 1.0,
            share,
            law: None,
            fresh: true,
            shield_until: 0.0,
        }
    }
}

impl RelayClaimEngine {
    /// `createRelayClaimEngine` (`relayClaim.js:43-82`). `share` and the law's `depth`, `rate`,
    /// `cap`, `hit_hz` must be positive finite numbers.
    pub fn new(o: Options) -> Result<Self, ClaimError> {
        if !positive(o.share) {
            return Err(ClaimError::Type(
                "relayClaim: share must be a positive finite number".into(),
            ));
        }
        let law = o.law.unwrap_or_else(|| allowance_law(o.level));
        for (key, v) in [
            ("depth", law.depth),
            ("rate", law.rate),
            ("cap", law.cap),
            ("hitHz", law.hit_hz),
        ] {
            if !positive(v) {
                return Err(ClaimError::Type(format!(
                    "relayClaim: law.{key} must be a positive finite number"
                )));
            }
        }
        Ok(RelayClaimEngine {
            level: match law.reference {
                Some(r) => r - 5.0,
                None => o.level,
            },
            law,
            share: o.share,
            hp: o.share,
            bucket: if o.fresh { law.depth } else { 0.0 },
            bucket_at: 0.0,
            tokens: law.hit_hz,
            token_at: 0.0,
            shield_until: js_max(0.0, or_default(o.shield_until, 0.0)),
            time: 0.0,
            killed: false,
            killed_at: None,
            claims: 0,
            accepted: 0,
            refused: 0,
            invalid: 0,
            dead: 0,
            shielded: 0,
            no_token: 0,
            empty: 0,
            offered: 0.0,
            dealt: 0.0,
            clipped: 0.0,
            cap_clip: 0.0,
            bucket_clip: 0.0,
            health_clip: 0.0,
            bucket_limited: 0,
            token_limited: 0,
            dry_at: None,
            first_accepted_at: None,
            last_claim_at: None,
        })
    }

    /// The `refused(result, reason)` helper (`relayClaim.js:84-98`).
    fn refuse(&mut self, mut r: ClaimResult, reason: Reason) -> ClaimResult {
        self.claims += 1;
        self.refused += 1;
        match reason {
            Reason::Dead => self.dead += 1,
            Reason::Invalid => self.invalid += 1,
            Reason::Shielded => self.shielded += 1,
            Reason::NoToken => self.no_token += 1,
            // `refused()` is only ever called with these four reasons.
            Reason::Accepted | Reason::AcceptedClipped | Reason::Empty => {}
        }
        r.refused = true;
        r.reason = reason;
        r.tokens_after = self.tokens;
        r.bucket_after = self.bucket;
        r.hp_after = self.hp;
        r.clipped_after = self.clipped;
        r.dealt_after = self.dealt;
        r.killed = false;
        r.dead = self.killed;
        r
    }

    /// One claim at time `t` (seconds, non-decreasing) for `damage` (`relayClaim.js:104-217`).
    /// On `Err` the engine is unchanged (the JS throws before touching state).
    pub fn claim(&mut self, t: f64, damage: f64) -> Result<ClaimResult, ClaimError> {
        let raw = damage;
        if !t.is_finite() {
            return Err(ClaimError::Type(
                "relayClaim: t must be a finite number of seconds".into(),
            ));
        }
        if t < self.time {
            return Err(ClaimError::Range(format!(
                "relayClaim: claims must be in non-decreasing time order ({t} < {})",
                self.time
            )));
        }
        self.time = t;
        self.last_claim_at = Some(t);

        let mut r = ClaimResult {
            t,
            claim: raw,
            accepted: false,
            refused: false,
            reason: Reason::Invalid, // overwritten on every path below
            token_spent: false,
            want: 0.0,
            capped: 0.0,
            got: 0.0,
            clipped: 0.0,
            cap_clip: 0.0,
            bucket_clip: 0.0,
            health_clip: 0.0,
            bucket_before: self.bucket,
            bucket_refilled: self.bucket,
            bucket_after: self.bucket,
            tokens_before: self.tokens,
            tokens_refilled: self.tokens,
            tokens_after: self.tokens,
            hp_after: self.hp,
            clipped_after: self.clipped,
            dealt_after: self.dealt,
            killed: false,
            dead: self.killed,
        };

        // applyHit's first gate: a dead fight, then a claim that is not a positive finite number.
        if self.killed {
            return Ok(self.refuse(r, Reason::Dead));
        }
        if !positive(raw) {
            return Ok(self.refuse(r, Reason::Invalid));
        }
        self.offered += raw;
        r.want = raw;

        // ... then the shield (before spendBlow), then spendBlow's token bucket.
        if t < self.shield_until {
            return Ok(self.refuse(r, Reason::Shielded));
        }

        let law = self.law;
        r.tokens_before = self.tokens;
        self.tokens = js_min(
            law.hit_hz,
            self.tokens + js_max(0.0, t - self.token_at) * law.hit_hz,
        );
        self.token_at = t;
        r.tokens_refilled = self.tokens;
        if !(self.tokens >= 1.0) {
            self.token_limited += 1;
            r.tokens_after = self.tokens;
            return Ok(self.refuse(r, Reason::NoToken));
        }
        self.tokens -= 1.0;
        r.token_spent = true;
        r.tokens_after = self.tokens;

        // ... then the purse: refilled at `rate` a second to `depth`, and the health that stands.
        r.bucket_before = self.bucket;
        self.bucket = js_min(
            law.depth,
            self.bucket + js_max(0.0, t - self.bucket_at) * law.rate,
        );
        self.bucket_at = t;
        r.bucket_refilled = self.bucket;
        r.bucket_after = self.bucket;

        let capped = js_min(raw, law.cap);
        let bucket_got = js_min(capped, self.bucket);
        let got = js_min(bucket_got, self.hp);
        r.capped = capped;
        r.got = got;
        r.cap_clip = raw - capped;
        r.bucket_clip = capped - bucket_got;
        r.health_clip = bucket_got - got;
        r.clipped = raw - got;
        if r.bucket_clip > 0.0 {
            self.bucket_limited += 1;
            if self.dry_at.is_none() {
                self.dry_at = Some(t);
            }
        }

        self.bucket -= got;
        self.clipped += r.clipped;
        self.cap_clip += r.cap_clip;
        self.bucket_clip += r.bucket_clip;
        self.health_clip += r.health_clip;
        r.bucket_after = self.bucket;

        if got > 0.0 {
            self.accepted += 1;
            self.dealt += got;
            if self.first_accepted_at.is_none() {
                self.first_accepted_at = Some(t);
            }
            self.hp = js_max(0.0, self.hp - got);
            if self.hp <= KILL_EPS {
                self.hp = 0.0;
                self.killed = true;
                self.killed_at = Some(t);
                r.killed = true;
            }
            r.accepted = true;
            r.reason = if r.clipped > 0.0 {
                Reason::AcceptedClipped
            } else {
                Reason::Accepted
            };
        } else {
            self.empty += 1;
            self.refused += 1;
            r.refused = true;
            r.reason = Reason::Empty;
        }
        r.clipped_after = self.clipped;
        r.dealt_after = self.dealt;
        r.hp_after = self.hp;
        r.dead = self.killed;
        self.claims += 1;
        Ok(r)
    }

    /// The counters and current state; no claim history (`relayClaim.js:220-266`).
    pub fn summary(&self) -> Summary {
        let secs = self.time;
        let share = self.share;
        let law = &self.law;
        Summary {
            level: self.level,
            reference: law.reference,
            share,
            hp: self.hp,
            // mutation: equivalent - the else arm is unreachable: new (:221) refuses any share that is not a positive finite number before it is stored (:245), and relayClaim.js:44 throws on the same input, so share > 0 on every path (JS remainingShare relayClaim.js:227 reads `initialShare > 0` the same way).
            // mutation: equivalent - the guard can differ from `>=` only at share == 0, which new refuses (:221; relayClaim.js:44), so `>=` changes no value.
            remaining_share: if share > 0.0 { self.hp / share } else { 0.0 },
            killed: self.killed,
            killed_at: self.killed_at,
            time: secs,
            claims: self.claims,
            accepted: self.accepted,
            refused: self.refused,
            invalid: self.invalid,
            dead: self.dead,
            shielded: self.shielded,
            no_token: self.no_token,
            empty: self.empty,
            offered: self.offered,
            dealt: self.dealt,
            clipped: self.clipped,
            refused_offer: js_max(0.0, self.offered - self.dealt - self.clipped),
            cap_clip: self.cap_clip,
            bucket_clip: self.bucket_clip,
            health_clip: self.health_clip,
            landed_share: if self.offered > 0.0 {
                self.dealt / self.offered
            } else {
                0.0
            },
            saturated: self.bucket_limited > 0,
            bucket_limited: self.bucket_limited,
            token_limited: self.token_limited,
            dry_at: self.dry_at,
            bucket: self.bucket,
            bucket_at: self.bucket_at,
            bucket_capacity: law.depth,
            bucket_rate: law.rate,
            tokens: self.tokens,
            token_at: self.token_at,
            token_capacity: law.hit_hz,
            token_rate: law.hit_hz,
            cap: law.cap,
            shield_until: self.shield_until,
            accepted_dps: if secs > 0.0 {
                Some(self.dealt / secs)
            } else {
                None
            },
            offered_dps: if secs > 0.0 {
                Some(self.offered / secs)
            } else {
                None
            },
            kill_dps: match self.killed_at {
                Some(k) if self.killed && k > 0.0 => Some(share / k),
                _ => None,
            },
            first_accepted_at: self.first_accepted_at,
            last_claim_at: self.last_claim_at,
        }
    }

    /// `engine.level`.
    pub fn level(&self) -> f64 {
        self.level
    }
    /// `engine.law`.
    pub fn law(&self) -> &Law {
        &self.law
    }
    /// `engine.hp`.
    pub fn hp(&self) -> f64 {
        self.hp
    }
    /// `engine.bucket`.
    pub fn bucket(&self) -> f64 {
        self.bucket
    }
    /// `engine.tokens`.
    pub fn tokens(&self) -> f64 {
        self.tokens
    }
    /// `engine.killed`.
    pub fn killed(&self) -> bool {
        self.killed
    }
    /// `engine.killedAt`.
    pub fn killed_at(&self) -> Option<f64> {
        self.killed_at
    }
    /// `engine.time`.
    pub fn time(&self) -> f64 {
        self.time
    }
    /// `engine.shieldUntil`.
    pub fn shield_until(&self) -> f64 {
        self.shield_until
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constructor_checks() {
        assert!(RelayClaimEngine::new(Options::new(0.0)).is_err());
        assert!(RelayClaimEngine::new(Options::new(f64::INFINITY)).is_err());
        let mut o = Options::new(100.0);
        o.law = Some(Law {
            reference: None,
            depth: 10.0,
            rate: 0.0,
            cap: 5.0,
            hit_hz: 4.0,
            share: None,
        });
        assert!(RelayClaimEngine::new(o).is_err());
        assert!(RelayClaimEngine::new(Options::new(100.0)).is_ok());
    }

    #[test]
    fn one_claim_is_capped_then_bucketed() {
        // level 1: ref 6, depth 90, cap 72, rate 18
        let mut e = RelayClaimEngine::new(Options::new(1000.0)).unwrap();
        let r = e.claim(1.0, 100.0).unwrap();
        assert_eq!(r.reason, Reason::AcceptedClipped);
        assert_eq!(r.got, 72.0);
        assert_eq!(r.cap_clip, 28.0);
        assert!(r.token_spent);
        // order is enforced and an error leaves the engine alone
        assert!(matches!(e.claim(0.5, 1.0), Err(ClaimError::Range(_))));
        assert!(matches!(e.claim(f64::NAN, 1.0), Err(ClaimError::Type(_))));
        assert_eq!(e.time(), 1.0);
    }

    #[test]
    fn shield_is_strict_and_dead_fights_refuse() {
        let mut o = Options::new(50.0);
        o.shield_until = 2.0;
        let mut e = RelayClaimEngine::new(o).unwrap();
        assert_eq!(e.claim(1.9, 10.0).unwrap().reason, Reason::Shielded);
        // exactly at shieldUntil is accepted (relayClaim.js:149 `t < shieldUntil`)
        assert_eq!(e.claim(2.0, 10.0).unwrap().reason, Reason::Accepted);
        let r = e.claim(3.0, 1000.0).unwrap();
        assert!(r.killed);
        assert_eq!(e.claim(4.0, 1.0).unwrap().reason, Reason::Dead);
    }
}
