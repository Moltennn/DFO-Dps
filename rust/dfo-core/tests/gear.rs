//! `src/gearLines.js` and `src/sockets.js` (R4a) against `tests/vectors/gear.txt` and `tests/vectors/sockets.txt`.
//! Items and lists are `def` lines, referred to as `@<index>`; every output is compared as its canonical token.

mod common;

use dfo_core::gear_lines::*;
use dfo_core::sockets::*;
use dfo_core::value::Value;
use std::collections::BTreeMap;

fn arr(v: Vec<Value>) -> Value {
    Value::Arr(v)
}

#[test]
fn gear_lines_match_the_js_vectors() {
    let (defs, cases) = common::load_with_defs("gear");
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for mut c in cases {
        let kind = c.kind.clone();
        match kind.as_str() {
            "laid" => {
                let it = c.value(&defs);
                c.check_out("laidLines", &arr(laid_lines(&it)));
            }
            "ril" => {
                let it = c.value(&defs);
                c.check_out("readItemLines", &arr(read_item_lines(&it)));
            }
            "vil" => {
                let it = c.value(&defs);
                c.check_out("validItemLines", &arr(valid_item_lines(&it)));
            }
            "wdp" => {
                let it = c.value(&defs);
                c.check_out("weaponDamagePct", &Value::Num(weapon_damage_pct(&it)));
            }
            "bl" => {
                let it = c.value(&defs);
                c.check_out("bladeLines", &blade_lines(&it));
            }
            "fl" => {
                let items = c.value(&defs);
                c.check_out("foldLines", &fold_lines(&items));
            }
            "sf" => {
                let t = c.value(&defs);
                c.check_out("socketsFor", &Value::Num(sockets_for(&t)));
            }
            other => c.fail(&format!("unknown kind `{other}`")),
        }
        c.done();
        *seen.entry(kind).or_default() += 1;
    }
    for kind in ["laid", "ril", "vil", "wdp", "bl", "fl", "sf"] {
        let min = common::floor("gear", kind);
        let n = seen.get(kind).copied().unwrap_or(0);
        assert!(
            n >= min,
            "gear.txt: only {n} `{kind}` cases (expected >= {min})"
        );
    }
}

#[test]
fn sockets_match_the_js_vectors() {
    let (defs, cases) = common::load_with_defs("sockets");
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for mut c in cases {
        let kind = c.kind.clone();
        match kind.as_str() {
            "scount" => {
                let x = c.value(&defs);
                c.check_out("socketCount", &Value::Num(socket_count(&x)));
            }
            "saff" => {
                let it = c.value(&defs);
                c.check_out("socketAffixes", &arr(socket_affixes(&it)));
            }
            "pgem" => {
                let k = c.value(&defs);
                c.check_out("perfectGem", &Value::Str(perfect_gem(&k)));
            }
            "psock" => {
                let x = c.value(&defs);
                c.check_out("perfectSockets", &arr(perfect_sockets(&x)));
            }
            other => c.fail(&format!("unknown kind `{other}`")),
        }
        c.done();
        *seen.entry(kind).or_default() += 1;
    }
    for kind in ["scount", "saff", "pgem", "psock"] {
        let min = common::floor("sockets", kind);
        let n = seen.get(kind).copied().unwrap_or(0);
        assert!(
            n >= min,
            "sockets.txt: only {n} `{kind}` cases (expected >= {min})"
        );
    }
}
