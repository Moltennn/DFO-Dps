//! The lootRarity readers and `foeGroup` (R4a) against `tests/vectors/loot.txt`: `readLines`, `validAffix`, `gemLine`,
//! `socketGems`, `socketsOf`, `socketMax`, `countedPieces`, `powerIdsOf`, `powerOf`, `foeGroup`.

mod common;

use dfo_core::loot::*;
use dfo_core::value::Value;
use std::collections::BTreeMap;

fn arr(v: Vec<Value>) -> Value {
    Value::Arr(v)
}

#[test]
fn loot_readers_match_the_js_vectors() {
    let (defs, cases) = common::load_with_defs("loot");
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for mut c in cases {
        let kind = c.kind.clone();
        match kind.as_str() {
            "rl" => {
                let it = c.value(&defs);
                c.check_out("readLines", &arr(read_lines(&it)));
            }
            "va" => {
                let a = c.value(&defs);
                c.check_out("validAffix", &Value::Bool(valid_affix(&a)));
            }
            "gl" => {
                let it = c.value(&defs);
                let g = c.value(&defs);
                c.check_out("gemLine", &gem_line(&it, &g));
            }
            "sg" => {
                let it = c.value(&defs);
                c.check_out("socketGems", &arr(socket_gems(&it)));
            }
            "so" => {
                let it = c.value(&defs);
                c.check_out("socketsOf", &arr(sockets_of(&it)));
            }
            "sm" => {
                let it = c.value(&defs);
                c.check_out("socketMax", &Value::Num(socket_max(&it)));
            }
            "cp" => {
                let list = c.value(&defs);
                c.check_out("countedPieces", &arr(counted_pieces(list.items())));
            }
            "pio" => {
                let it = c.value(&defs);
                c.check_out("powerIdsOf", &arr(power_ids_of(&it)));
            }
            "po" => {
                let id = c.value(&defs);
                c.check_out("powerOf", &power_of(&id));
            }
            "fg" => {
                let t = c.value(&defs);
                let got = foe_group(&t).map_or(Value::Null, |s| Value::Str(s.to_owned()));
                c.check_out("foeGroup", &got);
            }
            other => c.fail(&format!("unknown kind `{other}`")),
        }
        c.done();
        *seen.entry(kind).or_default() += 1;
    }
    for kind in ["rl", "va", "gl", "sg", "so", "sm", "cp", "pio", "po", "fg"] {
        let n = seen.get(kind).copied().unwrap_or(0);
        assert!(
            n >= 2000,
            "loot.txt: only {n} `{kind}` cases (expected >= 2000)"
        );
    }
}
