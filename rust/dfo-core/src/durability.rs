//! Fight-local durability (`src/durability.js`). Items have stable keys even if their values match.
use crate::rolls::Rolls;
use crate::value::Value;

pub const CWS_CONDITION_COST: f64 = 10.0;
pub const WEAR_FLOOR_CHANCE: f64 = 20.0;

pub fn condition_percentage(item: &Value) -> f64 {
    let max = item.get("maxCondition");
    let current = item.get("currentCondition");
    crate::vendored::condition_percentage(Some(&crate::target::Item {
        max_condition: (!max.is_nullish()).then(|| max.to_number()),
        current_condition: (!current.is_nullish()).then(|| current.to_number()),
        ..Default::default()
    }))
}

pub fn condition_pct(item: &Value) -> Value {
    if item.truthy() {
        Value::Num(condition_percentage(item))
    } else {
        Value::Null
    }
}

pub fn wear_amount(damage: f64) -> f64 {
    // mutation: equivalent - for either signed zero or any 0 < damage <= 1, the positive arm truncates to +0, as the fallback does.
    if damage > 0.0 {
        ((10.0 * damage + 50.0) / 100.0).trunc()
    } else {
        0.0
    }
}

pub fn dice100(chance: f64, roll: f64) -> bool {
    (roll * 100.0).floor() < chance
}

pub fn blow_wear(damage: f64, rolls: &mut impl Rolls) -> f64 {
    let amount = wear_amount(damage);
    if amount == 0.0 && damage > 0.0 && dice100(WEAR_FLOOR_CHANCE, rolls.roll()) {
        1.0
    } else {
        amount
    }
}

pub fn cws_bill(target: Option<&crate::target::Target>) -> f64 {
    if target.is_some_and(|t| t.spare_gear) {
        0.0
    } else {
        CWS_CONDITION_COST
    }
}

/// The fight's owner needs identity, not a second mutable copy of the held records.
#[derive(Debug, Default, PartialEq)]
pub struct Owner {
    pub right: Option<u64>,
    pub left: Option<u64>,
    pub weapon: Option<u64>,
}

pub fn make_owner(main: Option<u64>, off: Option<u64>) -> Owner {
    Owner {
        right: main,
        left: off,
        weapon: main,
    }
}

pub fn clone_item(item: &Value) -> Value {
    if item.is_nullish() {
        Value::Null
    } else {
        item.clone()
    }
}

fn mint_condition(item: &mut Value) {
    use crate::generated::{
        armor_materials::ARMOR_MATERIAL as A,
        item_facts::CONDITION_HIT_POINTS,
        weapons::{CONDITION_MULTIPLIERS_BY_MATERIAL, WEAPON_CONDITION_POOL},
    };
    if !item.get("maxCondition").is_nullish() {
        return;
    }
    let group = item.get("group");
    let hp = crate::value::obj_table_get(CONDITION_HIT_POINTS, item.get("templateIndex"));
    let mut max = if hp.is_some() && group.is_str("Weapons") && !crate::loot::is_ammunition(item) {
        WEAPON_CONDITION_POOL
    } else {
        hp.unwrap_or(0.0)
    };
    let mat = item.get("material");
    // mutation: equivalent - a nullish material has no usable index, and scaling a zero pool by a positive finite factor is still +0.
    if !mat.is_nullish() && max > 0.0 {
        let metal = mat.to_number();
        let index = if group.is_str("Weapons") {
            mat.array_index()
        } else if group.is_str("Armor") && (A.iron..=A.daedric).contains(&metal) {
            Value::Num(metal - A.iron).array_index()
        } else {
            None
        };
        if let Some(&factor) = index.and_then(|i| CONDITION_MULTIPLIERS_BY_MATERIAL.get(i)) {
            max = (max * factor / 4.0).trunc();
        }
    }
    item.set("maxCondition", Value::Num(max));
    item.set("currentCondition", Value::Num(max));
}

pub fn lower_condition(owner: Option<&mut Owner>, key: u64, item: &mut Value, amount: f64) -> bool {
    mint_condition(item);
    // In this vendored graph QUALITY_EFFECTS is a poisoned stub: mintedOn returns NaN
    // for every row pool, so repoolWeapon never matches maxCondition or writes a mark.
    if item.get("maxCondition").to_number() <= 0.0 {
        return false;
    }
    let next = item.get("currentCondition").to_number() - amount;
    if next > 0.0 {
        item.set("currentCondition", Value::Num(next));
        return false;
    }
    item.set("currentCondition", Value::Num(0.0));
    if let Some(owner) = owner {
        let held = owner.right == Some(key) || owner.left == Some(key);
        for slot in [&mut owner.right, &mut owner.left, &mut owner.weapon] {
            if *slot == Some(key) {
                *slot = None;
            }
        }
        if let (true, Value::Obj(entries)) = (held, item) {
            entries.retain(|(k, _)| k != "equipSlot");
        }
    }
    true
}

pub fn wear_item(owner: &mut Owner, key: u64, item: &mut Value, amount: f64) -> bool {
    amount > 0.0 && item.truthy() && lower_condition(Some(owner), key, item, amount)
}
