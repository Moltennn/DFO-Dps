//! The enchant plan against the real JS (`tools/rust-planner-vectors.mjs`).

mod common;

use dfo_core::enchant_plan as E;
use dfo_core::enchants::enchantment_name;
use dfo_core::value::Value::{self, Arr, Null, Num, Str};
use std::collections::BTreeMap;

fn s(text: &str) -> Value {
    Str(text.to_owned())
}

#[test]
fn enchant_plan() {
    let defs = Default::default();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut book = None;
    let mut profiles: Option<dfo_core::maxprofile::Profiles<'_>> = None;
    for mut row in common::stream("enchant_plan") {
        let kind = row.kind.clone();
        if kind == "book" {
            let v = row.value(&defs);
            assert!(!v.items().is_empty());
            let b = book.replace(dfo_core::spells::spells_by_index_map(
                v.items().iter().cloned(),
            ));
            assert!(b.is_none());
            profiles = book.as_ref().map(dfo_core::maxprofile::Profiles::new);
            row.done();
            continue;
        }
        let book = book.as_ref().expect("enchant_plan: fixture spellbook");
        let profiles = profiles.as_mut().expect("enchant_plan: frontier cache");
        let got = match kind.as_str() {
            "gear" => {
                let opts = row.value(&defs);
                let refused = row.peek() == Some("b1");
                if refused {
                    row.word();
                }
                if refused {
                    match E::gear_pieces(&opts) {
                        Err(_) => Null,
                        Ok(v) => v,
                    }
                } else {
                    E::gear_pieces(&opts).expect("gearPieces accepts a known template")
                }
            }
            "best" => {
                let family = row.value(&defs);
                let target = row.value(&defs);
                E::best_weapon_for_family_with(&family, &target, profiles)
                    .expect("bestWeaponForFamily")
            }
            "sortdps" => {
                let values = row.value(&defs);
                let mut list = values.items().to_vec();
                E::sort_by_dps(&mut list);
                Arr(list)
            }
            "sortrate" => {
                let values = row.value(&defs);
                let mut list = values.items().to_vec();
                E::sort_by_rate(&mut list);
                Arr(list)
            }
            "grouped" => {
                let x = row.value(&defs).to_number();
                s(&E::grouped_number_of(x))
            }
            "rate" => {
                let value = row.value(&defs).to_number();
                let cost = row.value(&defs).to_number();
                Num(E::guarded_rate(value, cost))
            }
            "cost" => {
                let kind = row.value(&defs).to_js_string();
                let param = match row.value(&defs) {
                    Null => None,
                    v => Some(v.to_number()),
                };
                Num(E::cost_of_kind(&kind, param))
            }
            "hitpoints" => {
                let template = row.value(&defs).to_number();
                Num(E::hit_points_of_template(template))
            }
            "skillpts" => {
                let base = row.value(&defs);
                let id = row.value(&defs).to_number();
                let points = row.value(&defs).to_number();
                let mut ch = base;
                E::add_skill_points_of(&mut ch, id, points);
                ch
            }
            "apply" => {
                let _tag = row.value(&defs);
                let ch = row.value(&defs);
                let plan = row.value(&defs);
                let target = row.value(&defs);
                E::apply_plan_dps(&ch, &plan, &target, book)
            }
            "strike" => {
                let _ = row.value(&defs);
                Arr(E::strike_params().iter().map(|v| Num(*v)).collect())
            }
            "consts" => {
                let _ = row.value(&defs);
                Arr(vec![Num(10.0), Num(400.0), Num(800.0)])
            }
            "maxprocs" => {
                let hp = row.value(&defs).to_number();
                let swings = row.value(&defs).to_number();
                Num(dfo_core::enchant_plan::max_procs_of(hp, swings))
            }
            "count" => {
                let v = row.value(&defs);
                let d = row.value(&defs).to_number();
                Num(dfo_core::enchant_plan::count_input(&v, d))
            }
            "select" => {
                let cands = row.value(&defs);
                let budget = row.value(&defs).to_number();
                let max_procs = row.value(&defs).to_number();
                Arr(dfo_core::enchant_plan::select_weapon_candidates(
                    cands.items(),
                    budget,
                    max_procs,
                ))
            }
            "matrix" => {
                let opts = row.value(&defs);
                E::plan_matrix_with(&opts, profiles).expect("planMatrix")
            }
            "plan" => {
                let opts = row.value(&defs);
                E::plan_enchants_with(&opts, profiles).expect("planEnchants")
            }
            "line" => {
                let e = row.value(&defs);
                s(&E::effect_line(&e))
            }
            "skillids" => {
                let template = row.value(&defs).to_number();
                Arr(E::skill_ids_for_template(template)
                    .into_iter()
                    .map(Num)
                    .collect())
            }
            "skillid" => {
                let template = row.value(&defs).to_number();
                E::skill_id_of_template(template).map_or(Null, Num)
            }
            "name" => {
                let kind = row.value(&defs).to_js_string();
                s(&enchantment_name(&kind))
            }
            other => panic!("unexpected enchant_plan kind {other}"),
        };
        row.expect("=>");
        let want = row.word();
        let text = dfo_core::value::write(&got);
        if want != text {
            let i = want
                .bytes()
                .zip(text.bytes())
                .take_while(|(a, b)| a == b)
                .count();
            let excerpt = |x: &str| x[i.saturating_sub(120)..x.len().min(i + 160)].to_owned();
            row.fail(&format!(
                "{kind} byte {i}: expected {}; got {}",
                excerpt(&want),
                excerpt(&text)
            ));
        }
        row.done();
        *counts.entry(kind).or_insert(0) += 1;
    }
    assert!(book.is_some(), "enchant_plan: the spellbook row is missing");
    for (kind, floor) in [
        ("gear", 200),
        ("plan", 100),
        ("matrix", 5),
        ("best", 12),
        ("line", 200),
    ] {
        let n = counts.get(kind).copied().unwrap_or(0);
        assert!(n >= floor, "enchant_plan/{kind}: {n} cases, floor {floor}");
    }
    let _ = counts;
}
