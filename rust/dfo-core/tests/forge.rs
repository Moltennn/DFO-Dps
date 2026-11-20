//! The Forge (manual Firmament editing) against the real vendored law (`tools/rust-forge-vectors.mjs`).
//!
//! Every case is a whole ordered value compared through the codec (f64 as bits). Families: `allocate` (the preview or
//! its fault word), `refund`, `apply` (the whole analysis before and after a tree), the tree's own `treefault` and
//! `faultvalue`, the budget helpers, the readers beside the previews, and the saved-allocation decode.

mod common;

use dfo_core::firmament_law::{
    self as law, clean_keys, craft_points_for, firm_cost_of, fits, points_left, refund_silver,
    stars_for, Tree, TreeFault,
};
use dfo_core::forge::{
    apply_tree_to_character, decode_saved_firmament, difference, preview_allocate, preview_refund,
    preview_respec, totals, tree_fault_of, tree_to_value, AllocateFault, Budget, RefundFault,
    SavedFirmament,
};
use dfo_core::value::Value::{self, Bool, Num, Obj, Str};
use std::collections::BTreeMap;

fn s(text: &str) -> Value {
    Str(text.to_owned())
}

fn num(n: f64) -> Value {
    Num(n)
}

fn words(list: &[String]) -> Value {
    Value::Arr(list.iter().map(|k| s(k)).collect())
}

fn fault_word(f: Option<TreeFault>) -> &'static str {
    f.map_or("-", TreeFault::word)
}

/// The allocate preview as the vector writes it: an error word (or, for the over-budget arm, its own numbers), or
/// `{ path, cost, pointsLeft, tree }`.
fn allocate_value(tree: &Tree, key: &str, budget: Budget) -> Value {
    match preview_allocate(tree, key, budget) {
        Err(AllocateFault::OverBudget {
            combat,
            stars,
            total,
            purse,
        }) => {
            let mut out = Obj(vec![]);
            out.set("fault", s("over-budget"));
            out.set("combat", num(combat));
            out.set("stars", num(stars));
            out.set("total", num(total));
            out.set("purse", num(purse));
            out
        }
        Err(fault) => s(match fault {
            AllocateFault::Tree(TreeFault::Key) => "tree-firm-key",
            AllocateFault::Tree(TreeFault::Start) => "tree-firm-start",
            AllocateFault::Tree(TreeFault::Path) => "tree-firm-path",
            AllocateFault::Tree(TreeFault::Points) => "tree-firm-points",
            AllocateFault::NoStart => "no-start",
            AllocateFault::UnknownNode => "unknown-node",
            AllocateFault::StartKey => "start-key",
            AllocateFault::AlreadyAllocated => "already-allocated",
            AllocateFault::NotReachable => "not-reachable",
            AllocateFault::OverBudget { .. } => unreachable!(),
        }),
        Ok(p) => {
            let mut out = Obj(vec![]);
            out.set("path", words(&p.path));
            out.set("cost", num(p.cost));
            out.set("pointsLeft", p.points_left.to_value());
            out.set("tree", tree_to_value(&p.resulting_tree));
            out
        }
    }
}

fn refund_value(tree: &Tree, key: &str, renown: f64) -> Value {
    match preview_refund(tree, key, renown) {
        Err(fault) => s(match fault {
            RefundFault::NoStart => "no-start",
            RefundFault::UnknownNode => "unknown-node",
            RefundFault::StartSign => "start-sign",
            RefundFault::NotAllocated => "not-allocated",
        }),
        Ok(p) => {
            let mut out = Obj(vec![]);
            out.set("removed", words(&p.removed));
            out.set("tree", tree_to_value(&p.resulting_tree));
            out.set("silver", num(p.refund_silver));
            out
        }
    }
}

fn respec_value(tree: &Tree) -> Value {
    let p = preview_respec(tree);
    let mut out = Obj(vec![]);
    out.set("removed", words(&p.removed));
    out.set("tree", tree_to_value(&p.resulting_tree));
    out.set("gold", num(p.gold));
    out.set("silver", num(p.refund_silver));
    out
}

fn diffs(prev: &Tree, next: &Tree) -> Value {
    let d = difference(prev, next);
    let mut out = Obj(vec![]);
    out.set("added", words(&d.added));
    out.set("removed", words(&d.removed));
    out.set("startChanged", Bool(d.start_changed));
    out
}

fn totals_value(tree: &Tree) -> Value {
    let mut out = Obj(vec![]);
    for (k, v) in totals(tree) {
        out.set(&k, num(v));
    }
    out
}

/// The decode as the vector writes it: `absent`, `empty`, or `[tree, { start, keys }]`.
fn decode_value(save: &Value) -> Value {
    match decode_saved_firmament(save) {
        SavedFirmament::Absent => s("absent"),
        SavedFirmament::EmptyTree => s("empty"),
        SavedFirmament::Tree(tree) => Value::Arr(vec![s("tree"), tree_to_value(&tree)]),
    }
}

#[test]
fn forge() {
    let (defs, cases) = common::load_with_defs("forge");
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for mut c in cases {
        let kind = c.kind.clone();
        let defs = &defs;
        let mut v = || c.value(defs);
        let got = match kind.as_str() {
            "allocate" => {
                let raw = v();
                let bytes = dfo_core::value::write(&raw);
                let tree = Tree::from_value(&raw);
                let key = v().to_js_string();
                let budget = Budget::new(v().to_number(), v().to_number());
                let out = allocate_value(&tree, &key, budget);
                assert_eq!(
                    bytes,
                    dfo_core::value::write(&raw),
                    "allocate mutated its tree"
                );
                out
            }
            "refund" => {
                let raw = v();
                let bytes = dfo_core::value::write(&raw);
                let tree = Tree::from_value(&raw);
                let key = v().to_js_string();
                let renown = v().to_number();
                let out = refund_value(&tree, &key, renown);
                assert_eq!(
                    bytes,
                    dfo_core::value::write(&raw),
                    "refund mutated its tree"
                );
                out
            }
            "apply" => {
                let opts = v();
                let opts_bytes = dfo_core::value::write(&opts);
                let build = v();
                let raw = v();
                let tree_bytes = dfo_core::value::write(&raw);
                let tree = Tree::from_value(&raw);
                let ch = dfo_core::theory::theory_character(&opts).expect("theoryCharacter");
                let ch_bytes = dfo_core::value::write(&ch);
                let book = dfo_core::spells::Spellbook::default();
                let before = dfo_core::analyze::analyze(&ch, &Obj(vec![]), &book).to_value();
                let after = match apply_tree_to_character(&ch, &build, &tree) {
                    Ok(applied) => {
                        dfo_core::analyze::analyze(&applied, &Obj(vec![]), &book).to_value()
                    }
                    Err(e) => c.fail(&e.message()),
                };
                assert_eq!(
                    tree_bytes,
                    dfo_core::value::write(&raw),
                    "apply mutated its tree"
                );
                assert_eq!(
                    ch_bytes,
                    dfo_core::value::write(&ch),
                    "apply mutated the character"
                );
                assert_eq!(
                    opts_bytes,
                    dfo_core::value::write(&opts),
                    "apply mutated its options"
                );
                Value::Arr(vec![before, after])
            }
            "respec" => {
                let raw = v();
                let bytes = dfo_core::value::write(&raw);
                let out = respec_value(&Tree::from_value(&raw));
                assert_eq!(
                    bytes,
                    dfo_core::value::write(&raw),
                    "respec mutated its tree"
                );
                out
            }
            "treefault" => {
                let tree = Tree::from_value(&v());
                let budget = Budget::new(v().to_number(), v().to_number());
                s(fault_word(tree_fault_of(&tree, budget)))
            }
            "faultvalue" => {
                let raw = v();
                s(fault_word(law::tree_fault_value(
                    &raw,
                    v().to_number(),
                    v().to_number(),
                )))
            }
            "path" => {
                let raw = v();
                let tree = Tree::from_value(&raw);
                let key = v().to_js_string();
                words(&law::path_to(&tree, &key))
            }
            "alloc" => {
                let raw = v();
                let tree = Tree::from_value(&raw);
                let key = v().to_js_string();
                Bool(law::allocatable(&tree, &key))
            }
            "takes" => {
                let raw = v();
                let tree = Tree::from_value(&raw);
                let key = v().to_js_string();
                words(&law::refund_takes(&tree, &key))
            }
            "stars" => num(stars_for(v().to_number())),
            "craft" => {
                let ranks = v();
                num(craft_points_for(
                    ranks
                        .items()
                        .iter()
                        .map(|x| x.to_number())
                        .collect::<Vec<_>>(),
                ))
            }
            "silver" => {
                let removed = v().to_number();
                num(refund_silver(removed, v().to_number()))
            }
            "budget" => {
                let renown = v().to_number();
                let ranks = v();
                let ranks: Vec<f64> = ranks.items().iter().map(|x| x.to_number()).collect();
                Value::Arr(vec![
                    Budget::renown(renown).to_value(),
                    Budget::ranks(ranks.clone()).to_value(),
                    Budget::of(renown, ranks).to_value(),
                ])
            }
            "totals" => totals_value(&Tree::from_value(&v())),
            "diff" => diffs(&Tree::from_value(&v()), &Tree::from_value(&v())),
            "clean" => {
                let keys: Vec<String> = v().items().iter().map(Value::to_js_string).collect();
                words(&clean_keys(&keys))
            }
            "cost" => {
                let keys: Vec<String> = v().items().iter().map(Value::to_js_string).collect();
                let stars = v().to_number();
                let craft = v().to_number();
                let (combat, life) = firm_cost_of(&keys);
                let (left_stars, left_craft) = points_left(&keys, stars, craft);
                let mut cost = Obj(vec![]);
                cost.set("combat", num(combat));
                cost.set("life", num(life));
                let mut left = Obj(vec![]);
                left.set("stars", num(left_stars));
                left.set("craft", num(left_craft));
                let mut out = Obj(vec![]);
                out.set("cost", cost);
                out.set("fits", Bool(fits(&keys, stars, craft)));
                out.set("left", left);
                out
            }
            "decode" => {
                let raw = v();
                let bytes = dfo_core::value::write(&raw);
                let out = decode_value(&raw);
                assert_eq!(
                    bytes,
                    dfo_core::value::write(&raw),
                    "decode mutated its save"
                );
                out
            }
            other => c.fail(&format!("unexpected forge kind {other}")),
        };
        c.expect("=>");
        let want = c.word();
        let text = dfo_core::value::write(&got);
        if want != text {
            let i = want
                .bytes()
                .zip(text.bytes())
                .take_while(|(a, b)| a == b)
                .count();
            let excerpt = |x: &str| x[i.saturating_sub(120)..x.len().min(i + 160)].to_owned();
            c.fail(&format!(
                "{kind} byte {i}: expected {}; got {}",
                excerpt(&want),
                excerpt(&text)
            ));
        }
        c.done();
        *counts.entry(kind).or_insert(0) += 1;
    }
    for (kind, floor) in [
        ("allocate", 10000),
        ("refund", 5000),
        ("respec", 10),
        ("path", 6000),
        ("alloc", 6000),
        ("takes", 6000),
        ("apply", 12),
        ("treefault", 20),
        ("faultvalue", 8),
        ("stars", 10),
        ("craft", 8),
        ("silver", 28),
        ("budget", 24),
        ("totals", 10),
        ("diff", 6),
        ("clean", 4),
        ("cost", 16),
        ("decode", 13),
    ] {
        let n = counts.get(kind).copied().unwrap_or(0);
        assert!(n >= floor, "forge/{kind}: {n} cases, floor {floor}");
    }
}
