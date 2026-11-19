//! `src/sockets.js` (R4a): gem sockets as the max profile and the readers use them. Each function cites its JS line. The
//! counts and lines are upstream's own functions ([`crate::gear_lines::sockets_for`], [`crate::loot::socket_gems`],
//! [`crate::loot::gem_line`]), not a table kept here.

use crate::gear_lines::sockets_for;
use crate::loot::{gem_line, socket_gems};
use crate::value::Value;

/// `perfectGem(kind)` (sockets.js:16): the perfect id of a kind, `perfect-<kind>`.
pub fn perfect_gem(kind: &Value) -> String {
    format!("perfect-{}", kind.to_js_string())
}

/// `socketCount(itemOrTemplate)` (sockets.js:19): `socketsFor` of a template index given as a number, or of an item's
/// `templateIndex` (any other value reads as an item with none).
pub fn socket_count(item_or_template: &Value) -> f64 {
    let template = match item_or_template {
        Value::Num(_) => item_or_template.clone(),
        _ => item_or_template.get("templateIndex").clone(),
    };
    sockets_for(&template)
}

/// `socketAffixes(item)` (sockets.js:25-28): each set socket's gem line for the item, in the sockets' order, with the
/// falsy lines dropped. An absent item has none.
pub fn socket_affixes(item: &Value) -> Vec<Value> {
    if !item.truthy() {
        return Vec::new();
    }
    socket_gems(item)
        .iter()
        .map(|g| gem_line(item, g))
        .filter(Value::truthy)
        .collect()
}

/// `perfectSockets(templateIndex)` (sockets.js:31-33): a perfect diamond in each of the template's sockets.
pub fn perfect_sockets(template: &Value) -> Vec<Value> {
    let n = socket_count(template) as usize;
    let diamond = perfect_gem(&Value::Str("diamond".to_owned()));
    (0..n).map(|_| Value::Str(diamond.clone())).collect()
}
