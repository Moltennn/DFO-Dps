mod common;

use dfo_core::swing::*;
use std::collections::BTreeMap;

#[test]
fn swing_matches_js_vectors() {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for mut c in common::load("swing") {
        let kind = c.kind.clone();
        match kind.as_str() {
            "swing_frame" => {
                let (speed, heft, handling) = (c.opt(), c.opt(), c.opt());
                let r = c.f64();
                c.check_f64(
                    &format!("swing_frame_seconds({speed:?}, {heft:?}, {handling:?})"),
                    r,
                    swing_frame_seconds(speed, heft, handling),
                );
            }
            "swing_heft" => {
                let (w, s) = (c.opt(), c.opt());
                let r = c.f64();
                c.check_f64(&format!("swing_heft({w:?}, {s:?})"), r, swing_heft(w, s));
            }
            "swing_handling" => {
                let has = c.bool();
                let type_ = c.opt();
                let short_blade = c.bool();
                let two_handed = c.bool();
                let r = c.f64();
                let w = SwingWeapon {
                    type_,
                    short_blade,
                    two_handed,
                };
                c.check_f64(
                    &format!("swing_handling(has={has}, {type_:?}, short={short_blade}, two={two_handed})"),
                    r,
                    swing_handling(has.then_some(&w)),
                );
            }
            "classic_strength" => {
                let s = c.f64();
                let fixed = match c.word().as_str() {
                    "-" => None,
                    "1" => Some(true),
                    "0" => Some(false),
                    t => c.fail(&format!("bad opts token `{t}`")),
                };
                let r = c.f64();
                c.check_f64(
                    &format!("classic_strength({s:?}, {fixed:?})"),
                    r,
                    classic_strength(s, fixed),
                );
            }
            other => c.fail(&format!("unknown kind `{other}`")),
        }
        c.done();
        *seen.entry(kind).or_default() += 1;
    }
    for kind in [
        "swing_frame",
        "swing_heft",
        "swing_handling",
        "classic_strength",
    ] {
        let min = common::floor("swing", kind);
        let n = seen.get(kind).copied().unwrap_or(0);
        assert!(
            n >= min,
            "swing.txt: only {n} `{kind}` cases (expected >= {min})"
        );
    }
}
