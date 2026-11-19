//! Expected strikes payload and item-maker facts (`src/enchants.js`, `src/enchantData.js`).
use crate::generated::enchant_data::{ENCHANTMENT_PRICE_ROWS, ITEM_ENCHANTMENT_POINTS};
pub use crate::generated::enchant_data::{ITEM_ENCHANTMENT_MAX, PARAM_NONE};
use crate::generated::enchantments::STRIKE_AFFINITY;
pub use crate::generated::enchantments::{
    ENCHANTMENT_TYPES, POTENT_VS_FLAT, PROCS_BEFORE_BREAK_BASIS, REGISTERED_ENCHANTMENT_TYPES,
};
pub use crate::generated::save_tables::ENHANCE_SKILL_MOD;
pub use crate::model_blow::{mobile_affinity_matches, payload_rows};
use crate::round::js_min;
pub use crate::save::rebuild_enchant_mods;
use crate::spells::{numbers, object, spell_damage, Mode, Spellbook, MAGIC_ROUND_SECONDS};
use crate::value::{number_to_string, obj_table_get, Value, Value::Num};

pub fn enchantment_rows(item: &Value) -> impl Iterator<Item = &Value> {
    item.get("enchantments")
        .items()
        .iter()
        .filter(|e| e.truthy() && e.get("type").to_number() >= 0.0)
}

pub fn cast_when_strikes<'a>(item: &Value, standard: &'a Spellbook) -> Vec<&'a Value> {
    payload_rows(item)
        .filter(|e| {
            e.get("type")
                .strict_eq(&Num(ENCHANTMENT_TYPES.cast_when_strikes))
        })
        .filter_map(|e| standard.get(&Num(e.get("param").to_number())))
        .collect()
}

pub fn strike_enchantments(
    item: &Value,
    ch: &Value,
    target: &Value,
    opts: &Value,
    standard: &Spellbook,
) -> Value {
    let opts = object([
        ("level", opts.get("level").clone()),
        ("potencyPct", opts.get("potencyPct").clone()),
        ("pierce", opts.get("pierce").clone()),
    ]);
    // mutation: equivalent - only the avg/min/max slots (indices 0..=2) are written or read in either array.
    let (mut proc_damage, mut proc_dot) = ([0.0; 3], [0.0; 3]);
    let mut procs = Vec::new();
    for sp in cast_when_strikes(item, standard) {
        let d = [Mode::Avg, Mode::Min, Mode::Max].map(|m| spell_damage(sp, ch, target, &opts, m));
        let instant = d.each_ref().map(|o| o.get("instant").to_number());
        let dot = d.each_ref().map(|o| o.get("dotPerTick").to_number());
        for i in 0..3 {
            proc_damage[i] += instant[i];
            proc_dot[i] += dot[i];
        }
        procs.push(object([
            ("name", sp.get("name").clone()),
            ("index", sp.get("index").clone()),
            ("damage", Num(instant[0])),
            ("min", Num(instant[1])),
            ("max", Num(instant[2])),
            ("dotTick", Num(dot[0])),
            // mutation: equivalent - DoT rounds depend on duration settings and level, not the magnitude mode.
            ("dotRounds", d[0].get("dotRounds").clone()),
        ]));
    }
    let mut flat = 0.0;
    for e in payload_rows(item) {
        let Some(group) = obj_table_get(STRIKE_AFFINITY, e.get("param")) else {
            continue;
        };
        if target.get("group").is_str(group) {
            if e.get("type").strict_eq(&Num(ENCHANTMENT_TYPES.potent_vs)) {
                flat += POTENT_VS_FLAT;
            }
            if e.get("type")
                .strict_eq(&Num(ENCHANTMENT_TYPES.low_damage_vs))
            {
                flat -= POTENT_VS_FLAT;
            }
        }
    }
    let mut result = numbers([
        ("procDamage", proc_damage[0]),
        ("procDamageMin", proc_damage[1]),
        ("procDamageMax", proc_damage[2]),
        ("procDot", proc_dot[0]),
        ("procDotMin", proc_dot[1]),
        ("procDotMax", proc_dot[2]),
        ("flat", flat),
    ]);
    result.set("procs", Value::Arr(procs));
    result
}

pub fn enchant_dps(
    item: &Value,
    ch: &Value,
    target: &Value,
    opts: &Value,
    standard: &Spellbook,
) -> Value {
    let mut out = strike_enchantments(item, ch, target, opts, standard);
    let cap = opts.get("cap").num_or(0.0);
    let hit = opts.get("hit").num_or(1.0);
    let aps = opts.get("aps").num_or(1.0);
    let cap_one = |v| if cap > 0.0 { js_min(v, cap) } else { v };
    let proc_damage = ["damage", "min", "max"].map(|k| {
        out.get("procs")
            .items()
            .iter()
            .fold(0.0, |a, p| a + cap_one(p.get(k).to_number()))
    });
    let dot = ["procDot", "procDotMin", "procDotMax"].map(|k| cap_one(out.get(k).to_number()));
    let per_swing = proc_damage.map(|d| hit * d);
    let dot_dps = dot.map(|d| d / MAGIC_ROUND_SECONDS);
    let dps = std::array::from_fn::<_, 3, _>(|i| per_swing[i] * aps + dot_dps[i]);
    for (k, v) in [
        ("procDamage", proc_damage[0]),
        ("procDamageMin", proc_damage[1]),
        ("procDamageMax", proc_damage[2]),
        ("procDot", dot[0]),
        ("perSwing", per_swing[0]),
        ("perSwingMin", per_swing[1]),
        ("perSwingMax", per_swing[2]),
        ("dps", dps[0]),
        ("dpsMin", dps[1]),
        ("dpsMax", dps[2]),
        ("dotDps", dot_dps[0]),
        ("dotDpsMin", dot_dps[1]),
        ("dotDpsMax", dot_dps[2]),
    ] {
        out.set(k, Num(v));
    }
    out
}

pub fn cws_bill_capacity(item: &Value) -> Option<f64> {
    let cond = item.get("currentCondition").to_number();
    let max = item.get("maxCondition").to_number();
    if !cond.is_finite() || cond <= 0.0 || !max.is_finite() || max <= 0.0 {
        return None;
    }
    Some((cond / crate::durability::CWS_CONDITION_COST).floor())
}

pub fn bill_capacity_note(n: f64) -> String {
    format!(
        "{} CWS bills of 10 covered (bill-only; ordinary wear shortens it)",
        number_to_string(n)
    )
}

pub use cws_bill_capacity as procs_before_break;

pub fn enchantment_param_values(kind: f64) -> impl Iterator<Item = f64> {
    ENCHANTMENT_PRICE_ROWS
        .iter()
        .filter(move |(t, _, _)| *t == kind)
        .map(|(_, p, _)| *p)
}

pub fn default_param(kind: f64) -> Option<f64> {
    enchantment_param_values(kind).next()
}

pub fn enchantment_cost(kind: f64, param: Option<f64>) -> Option<f64> {
    let param = param.or_else(|| default_param(kind))?;
    ENCHANTMENT_PRICE_ROWS
        .iter()
        .find(|(t, p, _)| *t == kind && *p == param)
        .map(|(_, _, cost)| *cost)
}

pub fn item_enchantment_points(index: &Value) -> f64 {
    obj_table_get(ITEM_ENCHANTMENT_POINTS, &Num(index.to_number())).unwrap_or(0.0)
}
