//! `src/dualWield.js` and its pure handsLaw dependencies.
use crate::generated::{
    hands_law::{DUAL, FLURRY_WINDOW},
    weapon_states::SWING_FRAME_MAX,
};
use crate::round::{finite_or, js_clamp, js_max, js_min, math_round, or_default};
use crate::swing::swing_heft;

pub const FLURRY_TICKS: f64 = 5.0 - DUAL.flurry_from_frame;
pub const SINGLE_TICKS: f64 = 5.0;
pub const OFF_HAND_BLOW_WEIGHT: f64 = DUAL.off_damage;

pub fn off_hand_to_hit(agility: f64) -> f64 {
    // mutation: equivalent - handsLaw.js:253 defaults nonfinite agility to 50; both 50 and 51 give Math.round((a - 50) * 0.1) == 0.
    let a = finite_or(agility, 50.0);
    js_clamp(
        DUAL.off_to_hit + math_round((a - 50.0) * DUAL.off_to_hit_per_agility),
        DUAL.off_to_hit_min,
        DUAL.off_to_hit_max,
    )
}

pub fn off_hand_burden(weight: f64, strength: f64) -> f64 {
    // mutation: equivalent - handsLaw.js:261 defaults falsy weight to 0; 1 kg instead loads at most 2.25 kg (off-hand 1.5x, STR 0), below the 2.5 kg free heft in both hands.
    let w = or_default(weight, 0.0);
    swing_heft(Some(w * DUAL.off_weight), Some(strength)) / swing_heft(Some(w), Some(strength))
}

pub fn off_hand_damage(damage: f64) -> f64 {
    if damage > 0.0 {
        js_max(1.0, math_round(damage * DUAL.off_damage))
    } else {
        damage
    }
}

pub fn average_off_hand_hold(burden: f64, ticks: f64, tick: f64) -> f64 {
    let most = if tick > 0.0 {
        js_max(1.0, SWING_FRAME_MAX / tick)
    } else {
        1.0
    };
    js_max(0.0, (js_min(burden, most) - 1.0) * ticks)
}

pub fn off_hand_hold(burden: f64, ticks: f64, tick: f64, carry: f64) -> (f64, f64) {
    let owed = average_off_hand_hold(burden, ticks, tick) + js_max(0.0, or_default(carry, 0.0));
    let hold = (owed + 1e-9).floor();
    (hold, js_max(0.0, owed - hold))
}

#[derive(Debug, Clone, Copy)]
pub struct DualSchedule {
    pub main_ticks: f64,
    pub off_ticks: f64,
    pub hold: f64,
    pub period: f64,
    pub swings_per_second: f64,
    pub blows_per_second_per_hand: f64,
    pub main_seconds: f64,
    pub off_seconds: f64,
    pub single_period: f64,
}

pub fn dual_schedule(main_tick: f64, off_tick: f64, burden: f64) -> DualSchedule {
    let main_ticks = FLURRY_TICKS;
    let hold = average_off_hand_hold(burden, FLURRY_TICKS, off_tick);
    let off_ticks = FLURRY_TICKS + hold;
    let main_seconds = main_ticks * main_tick;
    let off_seconds = off_ticks * off_tick;
    let period = main_seconds + off_seconds;
    DualSchedule {
        main_ticks,
        off_ticks,
        hold,
        period,
        swings_per_second: if period > 0.0 { 2.0 / period } else { 0.0 },
        blows_per_second_per_hand: if period > 0.0 { 1.0 / period } else { 0.0 },
        main_seconds,
        off_seconds,
        single_period: SINGLE_TICKS * main_tick,
    }
}

pub fn swings_ratio(schedule: &DualSchedule) -> f64 {
    2.0 * schedule.single_period / schedule.period
}

pub fn damage_ratio(schedule: &DualSchedule, main: f64, off: f64) -> f64 {
    ((main + off) / schedule.period) / (main / schedule.single_period)
}

pub fn strike_hand_of(
    mode: &str,
    lead: &str,
    last: &str,
    since_last: f64,
) -> (&'static str, bool, bool) {
    let lh = if lead == "L" { "L" } else { "R" };
    if !matches!(mode, "dual" | "fists") {
        return (lh, false, false);
    }
    let flurry = matches!(last, "R" | "L") && since_last <= FLURRY_WINDOW;
    let hand = if !flurry {
        lh
    } else if last == "L" {
        "R"
    } else {
        "L"
    };
    let dual = mode == "dual";
    (hand, dual && flurry, dual && hand != lh)
}
