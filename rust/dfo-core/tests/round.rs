mod common;

use dfo_core::round::*;
use std::collections::BTreeMap;

#[test]
fn round_matches_js_vectors() {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for mut c in common::load("round") {
        let kind = c.kind.clone();
        match kind.as_str() {
            "unity_round" | "fround" | "trunc" | "floor" | "math_round" => {
                let (x, r) = (c.f64(), c.f64());
                let got = match kind.as_str() {
                    "unity_round" => unity_round(x),
                    "fround" => fround(x),
                    "trunc" => trunc(x),
                    "math_round" => math_round(x),
                    _ => floor(x),
                };
                c.check_f64(&format!("{kind}({x:?})"), r, got);
            }
            "uint32" => {
                let (x, r) = (c.f64(), c.int());
                c.check_eq(&format!("to_uint32({x:?})"), r, i64::from(to_uint32(x)));
            }
            "int32" => {
                let (x, r) = (c.f64(), c.int());
                c.check_eq(&format!("to_int32({x:?})"), r, i64::from(to_int32(x)));
            }
            "is_integer" => {
                let (x, r) = (c.f64(), c.bool());
                c.check_eq(&format!("is_integer({x:?})"), r, is_integer(x));
            }
            "is_safe_integer" => {
                let (x, r) = (c.f64(), c.bool());
                c.check_eq(&format!("is_safe_integer({x:?})"), r, is_safe_integer(x));
            }
            "rem" | "max" | "min" => {
                let (a, b, r) = (c.f64(), c.f64(), c.f64());
                let got = match kind.as_str() {
                    "rem" => js_rem(a, b),
                    "max" => js_max(a, b),
                    _ => js_min(a, b),
                };
                c.check_f64(&format!("{kind}({a:?}, {b:?})"), r, got);
            }
            "clamp" => {
                let (v, lo, hi, r) = (c.f64(), c.f64(), c.f64(), c.f64());
                c.check_f64(
                    &format!("clamp({v:?}, {lo:?}, {hi:?})"),
                    r,
                    js_clamp(v, lo, hi),
                );
            }
            "imul" => {
                let (a, b, r) = (c.int(), c.int(), c.int());
                let got = i64::from(imul(a as i32, b as i32));
                c.check_eq(&format!("imul({a}, {b})"), r, got);
            }
            "finite_or" | "or_default" => {
                let (x, d, r) = (c.f64(), c.f64(), c.f64());
                let got = if kind == "finite_or" {
                    finite_or(x, d)
                } else {
                    or_default(x, d)
                };
                c.check_f64(&format!("{kind}({x:?}, {d:?})"), r, got);
            }
            other => c.fail(&format!("unknown kind `{other}`")),
        }
        c.done();
        *seen.entry(kind).or_default() += 1;
    }
    // A truncated vector file must not pass: every kind has a floor on its case count.
    for kind in [
        "unity_round",
        "fround",
        "trunc",
        "floor",
        "math_round",
        "uint32",
        "int32",
        "is_integer",
        "is_safe_integer",
        "rem",
        "max",
        "min",
        "clamp",
        "imul",
        "finite_or",
        "or_default",
    ] {
        let min = common::floor("round", kind);
        let n = seen.get(kind).copied().unwrap_or(0);
        assert!(
            n >= min,
            "round.txt: only {n} `{kind}` cases (expected >= {min})"
        );
    }
}
