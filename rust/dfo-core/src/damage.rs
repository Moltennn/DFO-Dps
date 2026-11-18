//! The pure per-blow arithmetic of `src/model.js`. Plain numbers in, numbers out.
//!
//! Every function below is a literal port; the order of operations and the rounding calls are the
//! JS's. Results stay `f64` (JS numbers), integers included.
//!
//! Not ported (data-dependent): `swingFrameSeconds`, `swingHeft` and `swingHandling`
//! (`src/model.js:381-399`) read the `SWING_*` tables of `src/data.js`; they move with the data
//! loading milestone. See `rust/README.md`.

use crate::round::{js_max, trunc};

/// `damageModifier` (`src/model.js:171-173`): `floor((str - 50) / 5)`, the stock DFU Strength term.
pub fn damage_modifier(str_: f64) -> f64 {
    ((str_ - 50.0) / 5.0).floor()
}

/// `pcaaoDamageModifier` (`src/model.js:182-184`): `floor((str - 50) / 10)`.
pub fn pcaao_damage_modifier(str_: f64) -> f64 {
    ((str_ - 50.0) / 10.0).floor()
}

/// `applyPct` (`src/model.js:632-634`): the card's own percentage step, floored per blow:
/// `pct > 0 ? damage + floor(damage * (pct / 100) + 1e-9) : damage`. The `1e-9` is the JS's own
/// guard against a product that lands a hair under a whole number.
pub fn apply_pct(damage: f64, pct: f64) -> f64 {
    if pct > 0.0 {
        damage + (damage * (pct / 100.0) + 1e-9).floor()
    } else {
        damage
    }
}

/// `carriedPct` (`src/model.js:642`): the carried stream's long-run mean, `damage + damage*pct/100`
/// (multiply first, then divide, as written).
pub fn carried_pct(damage: f64, pct: f64) -> f64 {
    damage + (damage * pct) / 100.0
}

/// `carriedFirmament` (`src/model.js:646`): `Math.max(1, damage + damage*pct/100)`. Uses the JS
/// `Math.max` (NaN propagates).
pub fn carried_firmament(damage: f64, pct: f64) -> f64 {
    js_max(1.0, damage + (damage * pct) / 100.0)
}

/// The weapon fields `conditionMultiplier` reads (`src/model.js:651-674`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Wear {
    /// `w.conditionPercent` (the integer band; `None` is JS `null`/`undefined`, so `??` falls
    /// through to `conditionPct`).
    pub condition_percent: Option<f64>,
    /// `w.conditionPct`, a fraction (`0.59` is 59%).
    pub condition_pct: f64,
    /// `w.skillId === SKILLS.BluntWeapon`.
    pub blunt: bool,
}

/// `conditionMultiplier(w, sharpEdge)` (`src/model.js:651-674`; `pcaao.js:607-637`). `None` is a
/// missing weapon (multiplier 1). `pct` reads the integer band: `conditionPercent ??
/// Math.trunc(conditionPct * 100)`. A NaN band fails every comparison and so reads as the lowest
/// band (0.25 edged, 0.5 blunt), exactly as the JS falls through.
pub fn condition_multiplier(w: Option<&Wear>, sharp_edge: bool) -> f64 {
    let Some(w) = w else { return 1.0 };
    let pct = w
        .condition_percent
        .unwrap_or_else(|| trunc(w.condition_pct * 100.0));
    if pct >= 76.0 && !sharp_edge {
        return 1.0; // no edge bonus without the wear module (:655)
    }
    if w.blunt {
        if pct >= 92.0 {
            return 1.1;
        }
        if pct >= 76.0 {
            return 1.0;
        }
        if pct >= 61.0 {
            return 1.0;
        }
        if pct >= 41.0 {
            return 0.9;
        }
        if pct >= 16.0 {
            return 0.8;
        }
        if pct >= 6.0 {
            return 0.65;
        }
        if pct > 5.0 {
            return 1.0;
        }
        return 0.5;
    }
    if pct >= 92.0 {
        return 1.3;
    }
    if pct >= 76.0 {
        return 1.1;
    }
    if pct >= 61.0 {
        return 1.0;
    }
    if pct >= 41.0 {
        return 0.85;
    }
    if pct >= 16.0 {
        return 0.7;
    }
    if pct >= 6.0 {
        return 0.45;
    }
    if pct > 5.0 {
        return 1.0;
    }
    0.25
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_pct_guard_rescues_a_hair_under() {
        // 3 * (7/100) is not exactly 0.21; the 1e-9 keeps whole products whole.
        assert_eq!(apply_pct(100.0, 29.0), 129.0);
        assert_eq!(apply_pct(10.0, 0.0), 10.0);
        assert_eq!(apply_pct(10.0, -5.0), 10.0);
        assert_eq!(apply_pct(10.0, f64::NAN), 10.0);
    }

    #[test]
    fn modifiers_floor_toward_minus_infinity() {
        assert_eq!(damage_modifier(49.0), -1.0);
        assert_eq!(pcaao_damage_modifier(41.0), -1.0);
        assert_eq!(pcaao_damage_modifier(60.0), 1.0);
    }

    #[test]
    fn condition_bands() {
        let w = |p: f64, blunt| Wear {
            condition_percent: Some(p),
            condition_pct: 0.0,
            blunt,
        };
        assert_eq!(condition_multiplier(None, true), 1.0);
        assert_eq!(condition_multiplier(Some(&w(80.0, false)), false), 1.0);
        assert_eq!(condition_multiplier(Some(&w(80.0, false)), true), 1.1);
        assert_eq!(condition_multiplier(Some(&w(5.0, true)), false), 0.5);
        assert_eq!(condition_multiplier(Some(&w(f64::NAN, false)), false), 0.25);
    }
}
