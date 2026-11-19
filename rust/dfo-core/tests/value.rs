//! The generic value codec and the JS reads over it (R4a), against `tests/vectors/value.txt` written by
//! `tools/rust-vectors.mjs`. Kinds: `value <tok>` (the JS encoding parses and writes back to itself), `tonum`
//! (`Number(v)`), `tostr` (`String(v)`), `truthy` (`!!v`), `prop` (`v?.[k]`).

mod common;

use dfo_core::value::{self, Value};
use std::collections::BTreeMap;

#[test]
fn value_codec_and_js_reads_match_the_vectors() {
    let defs = common::Defs::new();
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for mut c in common::load("value") {
        let kind = c.kind.clone();
        match kind.as_str() {
            "value" => {
                let tok = c.word();
                let v = value::parse(&tok).unwrap_or_else(|e| c.fail(&format!("{e}")));
                c.check_eq("codec round trip", tok.clone(), value::write(&v));
            }
            "tonum" => {
                let v = c.value(&defs);
                c.check_out("Number(v)", &Value::Num(v.to_number()));
            }
            "tostr" => {
                let v = c.value(&defs);
                c.check_out("String(v)", &Value::Str(v.to_js_string()));
            }
            "truthy" => {
                let v = c.value(&defs);
                c.check_out("!!v", &Value::Bool(v.truthy()));
            }
            "prop" => {
                let v = c.value(&defs);
                let k = c.value(&defs);
                c.check_out("v?.[k]", &v.prop(&k));
            }
            "seq" => {
                let a = c.value(&defs);
                let b = c.value(&defs);
                c.check_out("a === b", &Value::Bool(a.strict_eq(&b)));
            }
            "svz" => {
                let a = c.value(&defs);
                let b = c.value(&defs);
                c.check_out("[a].includes(b)", &Value::Bool(a.same_value_zero(&b)));
            }
            other => c.fail(&format!("unknown kind `{other}`")),
        }
        c.done();
        *seen.entry(kind).or_default() += 1;
    }
    for (kind, min) in [
        ("value", 2000),
        ("tonum", 2000),
        ("tostr", 2000),
        ("truthy", 1000),
        ("prop", 2000),
        ("seq", 2000),
        ("svz", 1000),
    ] {
        let n = seen.get(kind).copied().unwrap_or(0);
        assert!(
            n >= min,
            "value.txt: only {n} `{kind}` cases (expected >= {min})"
        );
    }
}
