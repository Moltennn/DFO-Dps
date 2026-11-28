//! The enchant plan against the real JS (`tools/rust-planner-vectors.mjs`).

mod common;

use dfo_core::enchant_plan as E;
use dfo_core::enchants::enchantment_name;
use dfo_core::maxprofile::Profiles;
use dfo_core::spells::{spells_by_index_map, Spellbook};
use dfo_core::value::Value::{self, Arr, Null, Num, Str};
use std::collections::BTreeMap;

fn s(text: &str) -> Value {
    Str(text.to_owned())
}

/// Every family the file carries; a new one must be added here and to a test below, so it cannot pass unread.
const KINDS: &[&str] = &[
    "gear",
    "best",
    "sortdps",
    "sortrate",
    "grouped",
    "rate",
    "cost",
    "hitpoints",
    "skillpts",
    "apply",
    "strike",
    "consts",
    "maxprocs",
    "count",
    "select",
    "matrix",
    "plan",
    "line",
    "skillids",
    "skillid",
    "name",
];

/// Stream `enchant_plan` for `kinds` only. Each test must see the fixture `book` row first, gets the row itself (so a
/// family can read its own pre-`=>` tokens), and asserts the floors of its own families: one file, several `#[test]`s,
/// which libtest runs in parallel.
fn replay(
    kinds: &[&str],
    floors: &[&str],
    check: impl Fn(&str, &mut common::Case, &common::Defs, &Spellbook, &mut Profiles<'_>) -> Value,
) {
    let defs = Default::default();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut book = None;
    let mut profiles: Option<Profiles<'_>> = None;
    for mut row in common::stream("enchant_plan") {
        let kind = row.kind.clone();
        if kind == "book" {
            let v = row.value(&defs);
            assert!(!v.items().is_empty());
            let b = book.replace(spells_by_index_map(v.items().iter().cloned()));
            assert!(b.is_none());
            profiles = book.as_ref().map(Profiles::new);
            row.done();
            continue;
        }
        assert!(
            KINDS.contains(&kind.as_str()),
            "unexpected enchant_plan kind {kind}"
        );
        if !kinds.contains(&kind.as_str()) {
            continue;
        }
        let book = book.as_ref().expect("enchant_plan: fixture spellbook");
        let profiles = profiles.as_mut().expect("enchant_plan: frontier cache");
        let got = check(&kind, &mut row, &defs, book, profiles);
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
    for &kind in floors {
        let floor = common::floor("enchant_plan", kind);
        let n = counts.get(kind).copied().unwrap_or(0);
        assert!(n >= floor, "enchant_plan/{kind}: {n} cases, floor {floor}");
    }
}

#[test]
fn gear() {
    replay(&["gear"], &["gear"], |kind, row, defs, _, _| match kind {
        "gear" => {
            // A `b1` token before `=>` marks a template the JS refuses: `Err` must become `null`, not a panic.
            let opts = row.value(defs);
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
        other => panic!("unexpected enchant_plan kind {other}"),
    });
}

/// `best`, `apply`, `plan` and `matrix` share one `Profiles` cache, and each family warms it for the next. Kept in one
/// test so the cache is built once; the families here are the expensive ones.
#[test]
fn plans() {
    replay(
        &["best", "apply", "plan", "matrix"],
        &["best", "plan", "matrix"],
        |kind, row, defs, book, profiles| match kind {
            "best" => {
                let family = row.value(defs);
                let target = row.value(defs);
                E::best_weapon_for_family_with(&family, &target, profiles)
                    .expect("bestWeaponForFamily")
            }
            "apply" => {
                let _tag = row.value(defs);
                let ch = row.value(defs);
                let plan = row.value(defs);
                let target = row.value(defs);
                E::apply_plan_dps(&ch, &plan, &target, book)
            }
            "matrix" => E::plan_matrix_with(&row.value(defs), profiles).expect("planMatrix"),
            "plan" => E::plan_enchants_with(&row.value(defs), profiles).expect("planEnchants"),
            other => panic!("unexpected enchant_plan kind {other}"),
        },
    );
}

#[test]
fn lines_and_pure_functions() {
    replay(
        &[
            "line",
            "sortdps",
            "sortrate",
            "grouped",
            "rate",
            "cost",
            "hitpoints",
            "skillpts",
            "strike",
            "consts",
            "maxprocs",
            "count",
            "select",
            "skillids",
            "skillid",
            "name",
        ],
        &["line"],
        |kind, row, defs, _, _| match kind {
            "sortdps" => {
                let mut list = row.value(defs).items().to_vec();
                E::sort_by_dps(&mut list);
                Arr(list)
            }
            "sortrate" => {
                let mut list = row.value(defs).items().to_vec();
                E::sort_by_rate(&mut list);
                Arr(list)
            }
            "grouped" => s(&E::grouped_number_of(row.value(defs).to_number())),
            "rate" => {
                let value = row.value(defs).to_number();
                let cost = row.value(defs).to_number();
                Num(E::guarded_rate(value, cost))
            }
            "cost" => {
                let kind = row.value(defs).to_js_string();
                let param = match row.value(defs) {
                    Null => None,
                    x => Some(x.to_number()),
                };
                Num(E::cost_of_kind(&kind, param))
            }
            "hitpoints" => Num(E::hit_points_of_template(row.value(defs).to_number())),
            "skillpts" => {
                let mut ch = row.value(defs);
                let id = row.value(defs).to_number();
                let points = row.value(defs).to_number();
                E::add_skill_points_of(&mut ch, id, points);
                ch
            }
            "strike" => {
                let _ = row.value(defs);
                Arr(E::strike_params().iter().map(|v| Num(*v)).collect())
            }
            "consts" => {
                let _ = row.value(defs);
                Arr(vec![Num(10.0), Num(400.0), Num(800.0)])
            }
            "maxprocs" => Num(dfo_core::enchant_plan::max_procs_of(
                row.value(defs).to_number(),
                row.value(defs).to_number(),
            )),
            "count" => Num(dfo_core::enchant_plan::count_input(
                &row.value(defs),
                row.value(defs).to_number(),
            )),
            "select" => {
                let cands = row.value(defs);
                let budget = row.value(defs).to_number();
                let max_procs = row.value(defs).to_number();
                Arr(dfo_core::enchant_plan::select_weapon_candidates(
                    cands.items(),
                    budget,
                    max_procs,
                ))
            }
            "line" => s(&E::effect_line(&row.value(defs))),
            "skillids" => Arr(E::skill_ids_for_template(row.value(defs).to_number())
                .into_iter()
                .map(Num)
                .collect()),
            "skillid" => E::skill_id_of_template(row.value(defs).to_number()).map_or(Null, Num),
            "name" => s(&enchantment_name(&row.value(defs).to_js_string())),
            other => panic!("unexpected enchant_plan kind {other}"),
        },
    );
}
