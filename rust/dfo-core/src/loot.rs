//! The lootRarity readers the item model calls (R4a), and `foeGroup` (lootPowers.js). Ported from
//! `vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js` (the call tree of `readLines`, `validAffix`, `gemLine`,
//! `socketGems`, `socketsOf`, `socketMax`, `countedPieces`, `powerIdsOf`, `powerOf`) and `systems/loot/lootPowers.js`
//! (`foeGroup`, :142-155). Each function cites its lines. The tables come from `crate::generated` (`tools/rust-data.mjs`):
//! the affix kinds' params and bands (`AFFIX_*`), the gem rows (`GEM_LINE_ROWS`), the template facts probed from the
//! weapon and item modules (`item_facts`), and the legendary powers as codec tokens (`LEGENDARY_POWER_TOKENS`).
//!
//! Registries are empty on the port's import path, as in `vendored.rs`: no legendary record carries a `power` field
//! (the generator checks it), the gilded registry is unset, and no custom legendary is registered. A piece's items are
//! read as the JS reads them (see `Value`); a non-array `affixes` or `sockets` is an empty list, as the JS reads it.
//! The vectors pass only the shapes the model produces (the README lists what is not representable).

use crate::generated::data::SKILLS;
use crate::generated::enemy_groups::ENEMY_GROUPS;
use crate::generated::equip_rules::WEAPON_HANDS;
use crate::generated::gem_grades::{ALL_GEM_IDS, GEM_GRADES};
use crate::generated::item_facts::{AMMUNITION_TEMPLATES, THUNDERLOCK_TEMPLATE, WEAPON_SKILL_USED};
use crate::generated::js_prototypes::OBJECT_PROTOTYPE_KEYS;
use crate::generated::loot_powers::{LEGENDARY_OWN_POWER_TOKENS, LEGENDARY_POWER_TOKENS};
use crate::generated::loot_rarity::{
    AFFIX_KIND_NAMES, AFFIX_LEGENDARY_TOP, AFFIX_PARAM_NUM, AFFIX_PARAM_STR, AFFIX_RARE_TOP,
    GEM_LINE_ROWS, SOCKET_EMPTY, SOCKET_GROUPS, WEAPON_SOCKETS,
};
use crate::round::{is_integer, js_max, js_min};
use crate::value::{map_table_get, obj_table_get, parse, refuse_inherited, Value};
use crate::vendored::enemy_entity_group;

/// `validAffix(a)` (lootRarity.js:839-848): a record of a kind the table knows (an own key of `AFFIX_KINDS`, so
/// `constructor` is not one), a param that kind names (a kind with params: one of them, SameValueZero; a kind without:
/// `param` is `undefined`), and an integer `value` from 1 to the kind's Legendary top. A non-object is not valid.
pub fn valid_affix(a: &Value) -> bool {
    if !matches!(a, Value::Obj(_) | Value::Arr(_)) {
        return false;
    }
    let Some(id) = a.get("id").as_str() else {
        return false;
    };
    if !AFFIX_KIND_NAMES.contains(&id) {
        return false;
    }
    let param = a.get("param");
    if let Some((_, list)) = AFFIX_PARAM_STR.iter().find(|(k, _)| *k == id) {
        if !list.iter().any(|p| param.is_str(p)) {
            return false;
        }
    } else if let Some((_, list)) = AFFIX_PARAM_NUM.iter().find(|(k, _)| *k == id) {
        if !list.iter().any(|p| param.same_value_zero(&Value::Num(*p))) {
            return false;
        }
    } else if !matches!(param, Value::Undefined) {
        return false;
    }
    let max = match AFFIX_LEGENDARY_TOP.iter().find(|(k, _)| *k == id) {
        Some((_, m)) => *m,
        None => return false,
    };
    match a.get("value") {
        Value::Num(v) => is_integer(*v) && *v >= 1.0 && *v <= max,
        _ => false,
    }
}

/// `gemPieceCap(id)` (lootRarity.js:2151): the top of a kind's Rare band (`AFFIX_RANGES[id]?.rare[1] ?? 0`).
pub fn gem_piece_cap(id: &str) -> f64 {
    AFFIX_RARE_TOP
        .iter()
        .find(|(k, _)| *k == id)
        .map_or(0.0, |(_, v)| *v)
}

/// `readLines(item)` (lootRarity.js:2155-2166) over the item's `affixes` list. See [`read_lines_list`].
pub fn read_lines(item: &Value) -> Vec<Value> {
    read_lines_list(item.get("affixes").items())
}

/// `readLines` over a list of affix records. A list with no gem line is returned as it stands. Otherwise each gem
/// line's value is held to what is left of its kind-and-param's cap (law 6: the cap is [`gem_piece_cap`], the sum of
/// the gem lines of one kind and param together), in the list's order; a line with nothing left reads as 0 (the
/// `Math.max(0, ...)`), and a line whose value does not change is the same record.
pub fn read_lines_list(list: &[Value]) -> Vec<Value> {
    if !list.iter().any(|a| !a.get("gem").is_nullish()) {
        return list.to_vec();
    }
    let mut used: Vec<(String, f64)> = Vec::new();
    list.iter()
        .map(|a| {
            if a.get("gem").is_nullish() || !valid_affix(a) {
                return a.clone();
            }
            let id = a.get("id").to_js_string();
            let param = a.get("param");
            let param_key = if param.is_nullish() {
                String::new()
            } else {
                param.to_js_string()
            };
            let key = format!("{id}:{param_key}");
            let spent = used
                .iter()
                .find(|(k, _)| *k == key)
                .map_or(0.0, |(_, v)| *v);
            let value = js_min(
                a.get("value").to_number(),
                js_max(0.0, gem_piece_cap(&id) - spent),
            );
            let pos = used.iter().position(|(k, _)| *k == key);
            match pos {
                Some(i) => used[i].1 = spent + value,
                None => used.push((key, value)),
            }
            if value == a.get("value").to_number() {
                a.clone()
            } else {
                let mut o = a.clone();
                o.set("value", Value::Num(value));
                o
            }
        })
        .collect()
}

/// `gemKind(id)` (gemGrades.js:66): the kind after the grade's dash (`ruby` for `flawless-ruby`); none for a non-gem.
pub fn gem_kind(gem: &Value) -> Option<&str> {
    let id = gem_id_str(gem)?;
    Some(match id.find('-') {
        Some(i) => &id[i + 1..],
        None => id,
    })
}

/// `gemGrade(id)` (gemGrades.js:67): the grade before the dash, `plain` when there is none; none for a non-gem.
pub fn gem_grade(gem: &Value) -> Option<&str> {
    let id = gem_id_str(gem)?;
    Some(match id.find('-') {
        Some(i) => &id[..i],
        None => "plain",
    })
}

fn gem_id_str(gem: &Value) -> Option<&str> {
    gem.as_str().filter(|s| ALL_GEM_IDS.contains(s))
}

/// `isGemId(id)` (gemGrades.js:64): a string that is one of the thirty-two ids (`ALL_GEM_IDS`).
pub fn is_gem_id(v: &Value) -> bool {
    gem_id_str(v).is_some()
}

/// `socketValues` membership: `empty` or a gem id (lootRarity.js:1971 `SOCKET_VALUES`).
fn is_socket_value(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| s == SOCKET_EMPTY || ALL_GEM_IDS.contains(&s))
}

/// `socketsOf(item)` (lootRarity.js:2020-2023): the `sockets` list when it is an array, else the one `socket` string
/// as a list of one when it is a socket value, else none.
pub fn sockets_of(item: &Value) -> Vec<Value> {
    match item.get("sockets") {
        Value::Arr(list) => list.clone(),
        _ => {
            let s = item.get("socket");
            if is_socket_value(s) {
                vec![s.clone()]
            } else {
                Vec::new()
            }
        }
    }
}

/// `socketGems(item)` (lootRarity.js:2037): the sockets that hold a gem, in order.
pub fn socket_gems(item: &Value) -> Vec<Value> {
    sockets_of(item).into_iter().filter(is_gem_id).collect()
}

/// `gemLine(item, gem)` (lootRarity.js:2040-2043): the gem's line for this piece, marked with its gem:
/// `{ id, param?, value, gem }` from the gem's row (`weapon` for a Weapons piece, else `other`) at the gem's grade.
/// `null` for a value that is not a gem. The `param` key is present only when the row names one.
pub fn gem_line(item: &Value, gem: &Value) -> Value {
    let (Some(kind), Some(grade)) = (gem_kind(gem), gem_grade(gem)) else {
        return Value::Null;
    };
    let side = if item.get("group").is_str("Weapons") {
        "weapon"
    } else {
        "other"
    };
    let row = GEM_LINE_ROWS.iter().find(|r| r.0 == kind && r.1 == side);
    let Some(&(_, _, id, param, values)) = row else {
        return Value::Null;
    };
    let grade_index = GEM_GRADES.iter().position(|g| *g == grade);
    let mut out = Value::Obj(Vec::new());
    out.set("id", Value::Str(id.to_owned()));
    if let Some(p) = param {
        out.set("param", Value::Str(p.to_owned()));
    }
    let value = match grade_index.and_then(|i| values.get(i)) {
        Some(v) => Value::Num(*v),
        None => Value::Undefined,
    };
    out.set("value", value);
    out.set("gem", gem.clone());
    out
}

/// `WEAPON_SOCKETS` by a weapon's size (lootRarity.js:2004-2011 `socketMax`): 0 for a piece outside the socket groups
/// and for ammunition; 1 for any other piece that is not a Weapon; a short blade one, a two-hander (`Both`, or the
/// Thunderlock) three, else two.
pub fn socket_max(item: &Value) -> f64 {
    let group = item.get("group");
    if !group.as_str().is_some_and(|g| SOCKET_GROUPS.contains(&g)) {
        return 0.0;
    }
    if !group.is_str("Weapons") {
        return 1.0;
    }
    if is_ammunition(item) {
        return 0.0;
    }
    let t = item.get("templateIndex");
    if map_table_get(WEAPON_SKILL_USED, t) == Some(SKILLS.short_blade) {
        return WEAPON_SOCKETS.short;
    }
    let two_handed = obj_table_get(WEAPON_HANDS, t) == Some("Both")
        || t.strict_eq(&Value::Num(THUNDERLOCK_TEMPLATE));
    if two_handed {
        WEAPON_SOCKETS.two
    } else {
        WEAPON_SOCKETS.one
    }
}

/// `isAmmunition(item)` (systems/item/itemTemplates.js:134): the item's template is in the ammunition set (`Set.has`,
/// SameValueZero).
pub fn is_ammunition(item: &Value) -> bool {
    let t = item.get("templateIndex");
    AMMUNITION_TEMPLATES
        .iter()
        .any(|x| t.same_value_zero(&Value::Num(*x)))
}

/// `countedPieces(pieces)` (lootRarity.js:2348-2357): a Legendary record counts once, its first copy in the list; every
/// other piece is kept.
pub fn counted_pieces(pieces: &[Value]) -> Vec<Value> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for it in pieces {
        let legendary = if it.get("rarity").is_str("legendary") {
            it.get("legendary").as_str().map(str::to_owned)
        } else {
            None
        };
        match legendary {
            None => out.push(it.clone()),
            Some(id) => {
                if !seen.contains(&id) {
                    seen.push(id);
                    out.push(it.clone());
                }
            }
        }
    }
    out
}

/// `powerIdsOf(it)` (lootRarity.js:1271): the power ids a piece carries, `[legendary, imprint, gilded]`, each taken only
/// for its rarity (`null` otherwise; an absent field is `undefined`, which the array keeps).
pub fn power_ids_of(it: &Value) -> Vec<Value> {
    let pick = |rarity: &str, key: &str| {
        if it.get("rarity").is_str(rarity) {
            it.get(key).clone()
        } else {
            Value::Null
        }
    };
    vec![
        pick("legendary", "legendary"),
        pick("rare", "imprint"),
        pick("gilded", "gilded"),
    ]
}

/// `powerOf(id)` (lootRarity.js:1268): `LEGENDARY_POWERS[id] ?? legendaryById(id)?.power ?? _gilded?.powerOf(id) ?? null`
/// for a string id, `null` for any other input. The three answers, in that order:
///
/// 1. `LEGENDARY_POWERS[id]` (`LEGENDARY_POWER_TOKENS`). An id in both this table and a legendary's own power reads the table
///    (`??` takes the first non-nullish value; the generator reports the overlap, and the vectors cover every id of both).
/// 2. The own `power` of the first legendary record with that id (`LEGENDARY_OWN_POWER_TOKENS`; a record with no power, or a
///    null one, falls through, as `??` does).
/// 3. `_gilded?.powerOf(id)`: the gilded registry is module-private and unset on this import path, so it is `undefined`
///    here, and the answer is `null`. The generator asserts `powerOf` of a made-up id is `null`.
///
/// An inherited name (`constructor`, `toString`, `__proto__`, ...) reads step 1 as the Object.prototype member: JS returns a
/// function (or the prototype object), which a `Value` cannot hold. The port panics (see [`refuse_inherited`]); the vectors
/// never pass one, and the test below pins the refusal. Reachable from a save whose legendary item carries such an id.
pub fn power_of(id: &Value) -> Value {
    let Some(s) = id.as_str() else {
        return Value::Null;
    };
    if let Some((_, tok)) = LEGENDARY_POWER_TOKENS.iter().find(|(k, _)| *k == s) {
        return parse(tok).unwrap_or_else(|e| panic!("generated power token: {e}"));
    }
    refuse_inherited(s, "LEGENDARY_POWERS", &[OBJECT_PROTOTYPE_KEYS]);
    match LEGENDARY_OWN_POWER_TOKENS.iter().find(|(k, _)| *k == s) {
        Some((_, tok)) => parse(tok).unwrap_or_else(|e| panic!("generated power token: {e}")),
        None => Value::Null,
    }
}

/// `foeGroup(target)` (lootPowers.js:142-155): the kind of foe a slayer's edge reads. A player or a missing target
/// is none; a Human affinity is `humanoid`; otherwise the enemy group of the career (`undead`, `daedra`, `humanoid`,
/// `animal`), and none for any other group.
pub fn foe_group(target: &Value) -> Option<&'static str> {
    if !target.truthy() || target.get("isPlayer").truthy() {
        return None;
    }
    if target.get("affinity").is_str("Human") {
        return Some("humanoid");
    }
    let g = enemy_entity_group(target.get("careerIndex").num_or(f64::NAN));
    if g == ENEMY_GROUPS.undead {
        Some("undead")
    } else if g == ENEMY_GROUPS.daedra {
        Some("daedra")
    } else if g == ENEMY_GROUPS.humanoid {
        Some("humanoid")
    } else if g == ENEMY_GROUPS.animals {
        Some("animal")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn affix(id: &str, param: Option<&str>, value: f64) -> Value {
        let mut a = Value::Obj(Vec::new());
        a.set("id", Value::Str(id.to_owned()));
        if let Some(p) = param {
            a.set("param", Value::Str(p.to_owned()));
        }
        a.set("value", Value::Num(value));
        a
    }

    #[test]
    fn validity_bounds() {
        assert!(valid_affix(&affix("damage", None, 40.0)));
        assert!(!valid_affix(&affix("damage", None, 41.0)));
        assert!(!valid_affix(&affix("damage", None, 0.0)));
        assert!(!valid_affix(&affix("damage", Some("x"), 5.0)));
        assert!(!valid_affix(&affix("stat", None, 5.0)));
        assert!(valid_affix(&affix("stat", Some("luck"), 15.0)));
        assert!(!valid_affix(&affix("constructor", None, 1.0)));
    }

    #[test]
    fn gem_cap_is_the_rare_top() {
        assert_eq!(gem_piece_cap("damage"), 25.0);
        assert_eq!(gem_piece_cap("nope"), 0.0);
    }

    #[test]
    #[should_panic(expected = "not representable")]
    fn power_of_refuses_an_inherited_name() {
        // JS: LEGENDARY_POWERS['constructor'] is the Object function, returned by `??` (not nullish).
        let _ = power_of(&Value::Str("constructor".into()));
    }

    #[test]
    fn power_of_is_null_for_a_non_string_and_an_unknown_id() {
        assert_eq!(power_of(&Value::Num(5.0)), Value::Null);
        assert_eq!(power_of(&Value::Str("nope".into())), Value::Null);
    }

    #[test]
    fn gem_kind_and_grade() {
        assert_eq!(gem_kind(&Value::Str("flawless-ruby".into())), Some("ruby"));
        assert_eq!(gem_grade(&Value::Str("ruby".into())), Some("plain"));
        assert_eq!(gem_kind(&Value::Str("bogus".into())), None);
    }
}
