//! Stand-in traits (`src/bossTraits.js` and the pinned client).
pub use crate::generated::boss_traits::*;
use crate::{model_blow, round::math_round, value::Value};

pub fn element_trait_of(element: f64) -> Option<&'static str> {
    ELEMENT_TRAITS
        .iter()
        .enumerate()
        .find(|(i, _)| *i as f64 == element)
        .map(|(_, t)| *t)
}

pub fn boss_traits_of(entity: &Value) -> &[Value] {
    entity.get("bossTraits").items()
}

/// One Mulberry32 draw (eliteFoes.js:164–172), with the caller's state.
pub fn elite_rng_next(a: &mut u32) -> f64 {
    *a = a.wrapping_add(0x6d2b79f5);
    let mut t = (*a ^ (*a >> 15)).wrapping_mul(*a | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    f64::from(t ^ (t >> 14)) / 4294967296.0
}

pub fn relay_boss_traits(name: &str, kind: &str) -> [&'static str; 2] {
    // eliteFoes.js:150-172: FNV-1a over UTF-16 with comma separators, then Mulberry32.
    let mut a = 0x811c9dc5_u32;
    for part in ["relay-boss", name, kind] {
        for c in part.encode_utf16().chain([u16::from(b',')]) {
            a = (a ^ u32::from(c)).wrapping_mul(0x01000193);
        }
    }
    let mut pick = |list: &'static [&'static str]| {
        let r = elite_rng_next(&mut a);
        // The unsigned numerator is at most 2^32-1: the product stays below either list's length.
        list[(r * list.len() as f64).floor() as usize]
    };
    [pick(ELEMENT_TRAITS), pick(RELAY_BOSS_BLOW_TRAITS)]
}

pub fn relay_traits_for(id: &Value) -> Option<[&'static str; 2]> {
    let key = id.to_js_string().to_lowercase();
    RELAY_BOSSES
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, boss)| relay_boss_traits(boss.name, &crate::value::number_to_string(boss.mobile)))
}

pub use model_blow::resist_blow;

pub fn resist_spell(traits: &[Value], damage: f64, element: Option<usize>) -> f64 {
    resist_blow(traits, damage, "spell", &Value::Null, element)
}

pub fn boss_strike(
    entity: &Value,
    damage: f64,
    kind: &str,
    weapon: &Value,
    element: Option<usize>,
    whole: bool,
) -> (f64, f64) {
    let traits = boss_traits_of(entity);
    if whole || damage <= 0.0 || damage.is_nan() {
        return (damage, 0.0);
    }
    let landed = resist_blow(traits, damage, kind, weapon, element);
    let thorns = if matches!(kind, "melee" | "arrow") && traits.iter().any(|t| t.is_str("thorned"))
    {
        crate::round::js_max(1.0, math_round(landed * THORN_SHARE))
    } else {
        0.0
    };
    (landed, thorns)
}
