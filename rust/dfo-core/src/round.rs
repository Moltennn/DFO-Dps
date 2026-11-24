//! JS numeric semantics the model leans on: rounding, `Math.min/max`, `%`, `|0`, `>>>0`.
//!
//! Everything here is an `f64` (the JS number) unless the JS operation is an integer one. Edge
//! cases (all covered by `tests/round.rs` against vectors from the real JS engine):
//!
//! * `-0` is kept: `floor(-0) = -0`, `trunc(-0.5) = -0`, `unity_round(-0.0) = -0`.
//! * NaN and infinities follow IEEE exactly as JS does. NaN payload bits are not meaningful in JS
//!   (the engine may canonicalise them), so tests compare "both NaN" rather than payload bits.
//! * `%` is the truncated remainder (`fmod`): the sign follows the dividend, `x % 0` is NaN,
//!   `inf % y` is NaN, `x % inf` is `x`. Rust's `f64 % f64` is the same operation; [`js_rem`]
//!   only names it.
//! * `Math.max`/`Math.min` return NaN if either argument is NaN and order `-0 < +0`. Rust's
//!   `f64::max`/`f64::min` ignore NaN and may return either zero, so they must NOT be used where
//!   a port needs the JS result: use [`js_max`] / [`js_min`].

/// Unity's `Mathf.Round`, half to even. Ports `src/model.js:57-63` `unityRound`
/// (itself `vendor/upstream/a3eb1605` `combat/pcaao.js` `unityRound`).
///
/// Literal port, including the odd corners: `f % 2 === 0` is false for a NaN `f`, so NaN gives
/// NaN; `+inf` gives `+inf` (`d` is NaN, falls to the parity arm); `-inf` gives `-inf`.
#[allow(clippy::if_same_then_else)] // literal port: the `d < 0.5` and even-`f` arms both return `f`
pub fn unity_round(x: f64) -> f64 {
    let f = x.floor();
    let d = x - f;
    if d > 0.5 {
        f + 1.0
    } else if d < 0.5 {
        f
    } else if f % 2.0 == 0.0 {
        f
    } else {
        f + 1.0
    }
}

/// `Math.fround`: round to the nearest `f32` (ties to even) and widen back (`src/model.js:52`).
pub fn fround(x: f64) -> f64 {
    f64::from(x as f32)
}

/// `Math.trunc` (`src/model.js:49`).
pub fn trunc(x: f64) -> f64 {
    x.trunc()
}

/// `Math.floor` (`src/model.js:51`).
pub fn floor(x: f64) -> f64 {
    x.floor()
}

/// JS `a % b` on numbers: truncated remainder, sign of the dividend (used by `src/rng.js:62`).
pub fn js_rem(a: f64, b: f64) -> f64 {
    a % b
}

/// `Math.max(a, b)`: NaN if either is NaN; `+0` beats `-0`.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() { b } else { a };
    }
    // mutation: equivalent - the NaN and both-zero cases returned above, so `>` and `>=` differ only
    // at `a == b`; both arms then answer that same double (ECMAScript `Math.max`, 21.3.2.24).
    if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: NaN if either is NaN; `-0` beats `+0`.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() { a } else { b };
    }
    // mutation: equivalent - the NaN and both-zero cases returned above, so `<` and `<=` differ only
    // at `a == b`; both arms then answer that same double (ECMAScript `Math.min`, 21.3.2.25).
    if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(lo, Math.min(hi, v))`, the `clamp` of `src/model.js:50` and `src/allowance.js:34`
/// (note the argument order: NaN `v` gives NaN; `lo > hi` gives `lo`).
pub fn js_clamp(v: f64, lo: f64, hi: f64) -> f64 {
    js_max(lo, js_min(hi, v))
}

/// ECMAScript `ToUint32` (`x >>> 0`): NaN and infinities give 0, otherwise truncate and wrap.
pub fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    let m = x.trunc() % 4294967296.0;
    let m = if m < 0.0 { m + 4294967296.0 } else { m };
    m as u32
}

/// ECMAScript `ToInt32` (`x | 0`).
pub fn to_int32(x: f64) -> i32 {
    to_uint32(x) as i32
}

/// `Math.imul` on int32 operands (`src/rng.js:31,40,41,81,64`).
pub fn imul(a: i32, b: i32) -> i32 {
    a.wrapping_mul(b)
}

/// `Number.isFinite(v) ? v : d` (`src/model.js:54` `num`).
pub fn finite_or(v: f64, d: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        d
    }
}

/// `Number(v) || d`: the default replaces NaN and both zeros (`-0` too), as in
/// `src/allowance.js:49,99-101,136`.
pub fn or_default(v: f64, d: f64) -> f64 {
    if v.is_nan() || v == 0.0 {
        d
    } else {
        v
    }
}

/// `Number.isInteger`.
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

/// `Number.isSafeInteger`: an integer with `|x| <= 2^53 - 1`.
pub fn is_safe_integer(x: f64) -> bool {
    is_integer(x) && x.abs() <= 9007199254740991.0
}

/// JS `Math.round`: the nearest integer, a tie toward +Infinity (so `-2.5` gives `-2`), and `-0` for `-0.5 <= x < 0`
/// (ECMAScript 21.3.2.28). Not [`f64::round`], which rounds ties away from zero. Used by `src/target.js`
/// (`armourPiece`, the Math.round of the condition) and moved here (R3b) so every module shares one copy.
pub fn math_round(x: f64) -> f64 {
    // math_round(-0) and math_round(0) must keep the input (sign included); the last arm does that on its
    // own (`floor` of an integer is itself and the remainder is 0 < 0.5), so no zero guard is needed.
    if (-0.5..0.0).contains(&x) {
        return -0.0;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_to_even_ties() {
        assert_eq!(unity_round(0.5), 0.0);
        assert_eq!(unity_round(1.5), 2.0);
        assert_eq!(unity_round(2.5), 2.0);
        // floor(-0.5) = -1, a tie, -1 is odd, so -1 + 1 = +0 (not -0)
        assert_eq!(unity_round(-0.5).to_bits(), 0.0f64.to_bits());
        assert_eq!(unity_round(-0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(unity_round(-1.5), -2.0);
        assert_eq!(unity_round(-2.5), -2.0);
        assert!(unity_round(f64::NAN).is_nan());
    }

    #[test]
    fn signed_zero_in_min_max() {
        assert_eq!(js_max(-0.0, 0.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(js_max(0.0, -0.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(js_min(0.0, -0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(js_min(-0.0, 0.0).to_bits(), (-0.0f64).to_bits());
        assert!(js_max(f64::NAN, 1.0).is_nan());
        assert!(js_min(1.0, f64::NAN).is_nan());
    }

    #[test]
    fn js_remainder_signs() {
        assert_eq!(js_rem(-1.0, 4294967296.0), -1.0);
        assert!(js_rem(1.0, 0.0).is_nan());
        assert_eq!(js_rem(-4.0, 2.0).to_bits(), (-0.0f64).to_bits());
    }

    #[test]
    fn math_round_ties_go_up_and_zero_keeps_its_sign() {
        assert_eq!(math_round(0.5), 1.0);
        assert_eq!(math_round(-0.5).to_bits(), (-0.0f64).to_bits());
        assert_eq!(math_round(-1.5), -1.0);
        assert_eq!(math_round(-2.5), -2.0);
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(-0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(math_round(0.49999999999999994), 0.0);
        assert!(math_round(f64::NAN).is_nan());
    }

    #[test]
    fn uint32_wraps() {
        assert_eq!(to_uint32(-1.0), 4294967295);
        assert_eq!(to_uint32(4294967296.0), 0);
        assert_eq!(to_uint32(f64::NAN), 0);
        assert_eq!(to_int32(2147483648.0), -2147483648);
    }
}
