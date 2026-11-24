//! The swing cadence and weapon-handling arithmetic of `src/model.js` (milestone R2), plus the classic
//! Strength term of the stock arm.
//!
//! Every function is a literal port: the order of the operations is the JS's, and each rounding
//! or clamp is the JS `Math.min`/`Math.max` (see [`crate::round`]). The tables come from
//! `crate::generated::data`, which `tools/rust-data.mjs` writes from `src/data.js`.
//!
//! JS `undefined` is `None` here (a JS default parameter applies to `undefined` only); a JS
//! `null` or a non-finite number is treated the way `num()` treats it, as the JS does.

use crate::damage::{damage_modifier, pcaao_damage_modifier};
use crate::generated::data::{
    SWING_BASE_FRAME, SWING_FRAME_MAX, SWING_FRAME_MIN, SWING_HANDLING, SWING_HEFT_FREE_KG,
    SWING_HEFT_MAX, SWING_HEFT_PER_KG, SWING_SHORT_BLADE, SWING_TEMPO_AT_0, SWING_TEMPO_AT_100,
    SWING_TWO_HANDED, WEAPON_TYPES,
};
use crate::round::{finite_or, js_clamp, js_max, js_min};

/// `num(v, d)` of `src/model.js:54`: `Number.isFinite(v) ? v : d`, with `undefined` as NaN.
fn num(v: Option<f64>, d: f64) -> f64 {
    finite_or(v.unwrap_or(f64::NAN), d)
}

/// `SWING_HANDLING[t]` for a numeric key `t`: the table is keyed by integers, and a JS lookup
/// with a non-integer or NaN key finds nothing (`undefined`). `-0` finds key 0, as in JS.
fn handling_of_type(t: f64) -> Option<f64> {
    SWING_HANDLING
        .iter()
        .find(|(k, _)| (*k as f64) == t)
        .map(|(_, v)| *v)
}

/// `swingFrameSeconds(speed, { heft = 1, handling = 1 } = {})` (`src/model.js:381-385`): one anim
/// frame in seconds. `speed` is clamped to 0..100 (a non-finite speed reads as 50); the result is
/// clamped to `SWING_FRAME_MIN..SWING_FRAME_MAX`.
pub fn swing_frame_seconds(speed: Option<f64>, heft: Option<f64>, handling: Option<f64>) -> f64 {
    let s = js_clamp(num(speed, 50.0), 0.0, 100.0);
    let tempo = 1.0 + ((50.0 - s) / 100.0) * (SWING_TEMPO_AT_0 - SWING_TEMPO_AT_100);
    js_clamp(
        SWING_BASE_FRAME * tempo * heft.unwrap_or(1.0) * handling.unwrap_or(1.0),
        SWING_FRAME_MIN,
        SWING_FRAME_MAX,
    )
}

/// `swingHeft(weightKg, strength)` (`src/model.js:388-393`): the heft multiplier of a weapon.
/// The weight is at least 0 (a non-finite weight reads as 0); the strength is clamped to 0..100
/// (a non-finite strength, or `undefined`, reads as 50).
pub fn swing_heft(weight_kg: Option<f64>, strength: Option<f64>) -> f64 {
    // mutation: equivalent, both `0.0` on this line. A `1.0` clamp or a `1.0` default answers the same
    // 1.0: only a weight below 1 sees the floor, and the largest load either can then make is
    // `1 * (150 - 0) / 100 = 1.5`, below `SWING_HEFT_FREE_KG` (2.5, src/data.js:167), so the excess
    // still clamps to 0 (`src/model.js:388-393`, `Math.max(0, ...)`).
    let w = js_max(0.0, num(weight_kg, 0.0));
    let str_ = js_clamp(num(strength, 50.0), 0.0, 100.0);
    let load = (w * (150.0 - str_)) / 100.0;
    1.0 + js_min(
        SWING_HEFT_MAX,
        js_max(0.0, (load - SWING_HEFT_FREE_KG) * SWING_HEFT_PER_KG),
    )
}

/// The weapon fields `swingHandling` reads (`src/model.js:395-399`). `type_` is `w.type`
/// (`None` is `undefined`); `short_blade` and `two_handed` are the template's flags.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SwingWeapon {
    pub type_: Option<f64>,
    pub short_blade: bool,
    pub two_handed: bool,
}

/// `swingHandling(w)` (`src/model.js:395-399`). No weapon (`None`, the JS `!w`) is the Melee row
/// (`SWING_HANDLING[WEAPON_TYPES.Melee]`, written `SWING_SHORT_BLADE * 0 + ...` in the JS). A short
/// blade takes the short-blade row; any other weapon takes its type's row, or 1 when the type has
/// none. A two-handed weapon is then scaled by `SWING_TWO_HANDED`.
pub fn swing_handling(w: Option<&SwingWeapon>) -> f64 {
    let Some(w) = w else {
        return SWING_SHORT_BLADE * 0.0 + handling_of_type(WEAPON_TYPES.melee).unwrap_or(f64::NAN);
    };
    let kind = if w.short_blade {
        SWING_SHORT_BLADE
    } else {
        w.type_.and_then(handling_of_type).unwrap_or(1.0)
    };
    kind * if w.two_handed { SWING_TWO_HANDED } else { 1.0 }
}

/// `classicStrength(str, opts = {})` (`src/model.js:179-181`), module-private in the JS: the stock
/// arm's Strength term. `fixed_strength_damage_modifier` is `opts.fixedStrengthDamageModifier`
/// (`None` when `opts` lacks it). Only `Some(false)` selects the uninstalled DFU `/5` term
/// ([`damage_modifier`]); every other value selects the PCAAO `/10` term, as `=== false` does.
pub fn classic_strength(str_: f64, fixed_strength_damage_modifier: Option<bool>) -> f64 {
    if fixed_strength_damage_modifier == Some(false) {
        damage_modifier(str_)
    } else {
        pcaao_damage_modifier(str_)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_clamped_and_speed_reads_as_50_when_missing() {
        // at speed 50 the tempo is 1, so the frame is the base frame
        assert_eq!(
            swing_frame_seconds(Some(50.0), None, None),
            SWING_BASE_FRAME
        );
        assert_eq!(swing_frame_seconds(None, None, None), SWING_BASE_FRAME);
        assert_eq!(
            swing_frame_seconds(Some(f64::NAN), None, None),
            SWING_BASE_FRAME
        );
        // a huge heft hits the top clamp
        assert_eq!(
            swing_frame_seconds(Some(50.0), Some(1e9), None),
            SWING_FRAME_MAX
        );
    }

    #[test]
    fn heft_is_one_when_light() {
        assert_eq!(swing_heft(Some(0.5), Some(50.0)), 1.0);
        assert_eq!(swing_heft(None, None), 1.0);
    }

    #[test]
    fn handling_rows() {
        let melee = swing_handling(None);
        assert_eq!(melee, 0.9);
        let dagger = SwingWeapon {
            type_: Some(4.0),
            short_blade: true,
            two_handed: false,
        };
        assert_eq!(swing_handling(Some(&dagger)), SWING_SHORT_BLADE);
        let unknown_type = SwingWeapon {
            type_: Some(14.0),
            short_blade: false,
            two_handed: false,
        };
        assert_eq!(swing_handling(Some(&unknown_type)), 1.0);
    }

    #[test]
    fn classic_strength_switches_on_false_only() {
        assert_eq!(classic_strength(100.0, None), 5.0);
        assert_eq!(classic_strength(100.0, Some(true)), 5.0);
        assert_eq!(classic_strength(100.0, Some(false)), 10.0);
    }
}
