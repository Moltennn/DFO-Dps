//! `src/gearLines.js` (R4a): an item's lines as the game reads them, over the lootRarity readers in [`crate::loot`]. Each
//! function cites the JS line it ports. The module is a thin adapter, as the JS is: no second reading of a line.
//!
//! The JS `num(v, d = 0)` (gearLines.js:27) is `Number(v)` when finite, else 0 (see [`num`]). The lines are `Value`s:
//! an affix record is the object the JS holds (`{ id, param?, value, gem? }`), the list is the array.

use crate::generated::data::WEAPONS;
use crate::loot::{gem_line, read_lines_list, socket_gems, socket_max, sockets_of, valid_affix};
use crate::round::to_int32;
use crate::value::{obj_table_has, Value};

/// `num(v, d = 0)` (gearLines.js:27): `Number(v)` when it is finite, else 0.
fn num(v: &Value) -> f64 {
    let n = v.to_number();
    if n.is_finite() {
        n
    } else {
        0.0
    }
}

/// `laidLines(item)` (gearLines.js:33-37): the piece's own lines (no gem line), then one line per set socket in the
/// sockets' order (`layGemLines`, lootRarity.js:2085). An item with no socket keeps its `affixes` as they are; the
/// falsy entries are dropped only in the socketed case (the JS `.filter(Boolean)`).
pub fn laid_lines(item: &Value) -> Vec<Value> {
    let list: Vec<Value> = item.get("affixes").items().to_vec();
    if sockets_of(item).is_empty() {
        return list;
    }
    let mut out: Vec<Value> = list
        .into_iter()
        .filter(|a| a.get("gem").is_nullish())
        .collect();
    out.extend(socket_gems(item).iter().map(|g| gem_line(item, g)));
    out.retain(|v| v.truthy());
    out
}

/// `readItemLines(item)` (gearLines.js:40): `readLines` over the laid lines, the gem cap applied, nothing else dropped.
pub fn read_item_lines(item: &Value) -> Vec<Value> {
    read_lines_list(&laid_lines(item))
}

/// `validItemLines(item)` (gearLines.js:43): the read lines that are [`valid_affix`].
pub fn valid_item_lines(item: &Value) -> Vec<Value> {
    read_item_lines(item)
        .into_iter()
        .filter(valid_affix)
        .collect()
}

/// `weaponDamagePct(item)` (gearLines.js:46; lootRarity.js:2475-2479): the sum of the `damage` lines' `value | 0` over
/// the read lines (not validated, as affixWeaponDamage reads them).
pub fn weapon_damage_pct(item: &Value) -> f64 {
    read_item_lines(item).iter().fold(0.0, |n, a| {
        if a.get("id").is_str("damage") {
            n + f64::from(to_int32(a.get("value").to_number()))
        } else {
            n + 0.0
        }
    })
}

/// `bladeLines(item)` (gearLines.js:53-64): the valid slayer lines summed per group (`slayerByGroup`, keyed by the
/// param's string), their total, and the valid elemental lines kept as lines (`{ param, value }`) with their total.
pub fn blade_lines(item: &Value) -> Value {
    let lines = valid_item_lines(item);
    let mut by_group = Value::Obj(Vec::new());
    for a in lines.iter().filter(|a| a.get("id").is_str("slayer")) {
        let key = a.get("param").to_js_string();
        let prev = by_group.get(&key).num_or(0.0);
        by_group.set(&key, Value::Num(prev + num(a.get("value"))));
    }
    let slayer = match &by_group {
        Value::Obj(entries) => entries.iter().fold(0.0, |n, (_, v)| n + v.num_or(0.0)),
        _ => 0.0,
    };
    let mut elemental_lines: Vec<Value> = Vec::new();
    for a in lines.iter().filter(|a| a.get("id").is_str("elemental")) {
        let mut l = Value::Obj(Vec::new());
        l.set("param", Value::Str(a.get("param").to_js_string()));
        l.set("value", Value::Num(num(a.get("value"))));
        elemental_lines.push(l);
    }
    let elemental = elemental_lines
        .iter()
        .fold(0.0, |n, l| n + l.get("value").num_or(0.0));
    let mut out = Value::Obj(Vec::new());
    out.set("slayerByGroup", by_group);
    out.set("slayer", Value::Num(slayer));
    out.set("elementalLines", Value::Arr(elemental_lines));
    out.set("elemental", Value::Num(elemental));
    out
}

/// `foldLines(items)` (gearLines.js:67-78): the stat and skill points the worn lines fold onto the entity, keyed by
/// their param (`stats[a.param] = (stats[a.param] ?? 0) + value | 0`).
pub fn fold_lines(items: &Value) -> Value {
    let mut stats = Value::Obj(Vec::new());
    let mut skills = Value::Obj(Vec::new());
    for it in items.items() {
        for a in valid_item_lines(it) {
            let v = f64::from(to_int32(a.get("value").to_number()));
            if a.get("id").is_str("stat") {
                add_to(&mut stats, a.get("param"), v);
            } else if a.get("id").is_str("skill") {
                add_to(&mut skills, a.get("param"), v);
            }
        }
    }
    let mut out = Value::Obj(Vec::new());
    out.set("stats", stats);
    out.set("skills", skills);
    out
}

/// `obj[key] = (obj[key] ?? 0) + v` (the JS key is the property key of `key`).
fn add_to(obj: &mut Value, key: &Value, v: f64) {
    let k = key.to_js_string();
    let prev = obj.get(&k).num_or(0.0);
    obj.set(&k, Value::Num(prev + v));
}

/// `socketsFor(templateIndex)` (gearLines.js:81): the sockets a weapon template holds, by `socketMax` of a Weapons
/// piece of that template (0 for a template the weapon table does not hold).
pub fn sockets_for(template: &Value) -> f64 {
    if !obj_table_has(WEAPONS, template) {
        return 0.0;
    }
    let item = Value::Obj(vec![
        ("group".to_owned(), Value::Str("Weapons".to_owned())),
        ("templateIndex".to_owned(), template.clone()),
    ]);
    socket_max(&item)
}
