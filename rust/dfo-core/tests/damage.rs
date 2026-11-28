mod common;

use dfo_core::damage::*;
use std::collections::BTreeMap;

#[test]
fn damage_matches_js_vectors() {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for mut c in common::load("damage") {
        let kind = c.kind.clone();
        match kind.as_str() {
            "damage_modifier" | "pcaao_damage_modifier" => {
                let (s, r) = (c.f64(), c.f64());
                let got = if kind == "damage_modifier" {
                    damage_modifier(s)
                } else {
                    pcaao_damage_modifier(s)
                };
                c.check_f64(&format!("{kind}({s:?})"), r, got);
            }
            "apply_pct" | "carried_pct" | "carried_firmament" => {
                let (d, p, r) = (c.f64(), c.f64(), c.f64());
                let got = match kind.as_str() {
                    "apply_pct" => apply_pct(d, p),
                    "carried_pct" => carried_pct(d, p),
                    _ => carried_firmament(d, p),
                };
                c.check_f64(&format!("{kind}({d:?}, {p:?})"), r, got);
            }
            "condition_multiplier" => {
                let has = c.bool();
                let cp = c.opt();
                let cpct = c.f64();
                let blunt = c.bool();
                let sharp = c.bool();
                let r = c.f64();
                let w = Wear {
                    condition_percent: cp,
                    condition_pct: cpct,
                    blunt,
                };
                let got = condition_multiplier(has.then_some(&w), sharp);
                c.check_f64(
                    &format!("condition_multiplier(has={has}, {cp:?}, {cpct:?}, blunt={blunt}, sharp={sharp})"),
                    r,
                    got,
                );
            }
            other => c.fail(&format!("unknown kind `{other}`")),
        }
        c.done();
        *seen.entry(kind).or_default() += 1;
    }
    for kind in [
        "damage_modifier",
        "pcaao_damage_modifier",
        "apply_pct",
        "carried_pct",
        "carried_firmament",
        "condition_multiplier",
    ] {
        // The floor is the sample's own count for the kind (MANIFEST), never a copied number: a truncated file fails.
        let min = common::floor("damage", kind);
        let n = seen.get(kind).copied().unwrap_or(0);
        assert!(
            n >= min,
            "damage.txt: only {n} `{kind}` cases (expected >= {min})"
        );
    }
}
