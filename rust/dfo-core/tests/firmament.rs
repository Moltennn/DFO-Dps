//! The Firmament sky, law readers and planner against the real JS (`tools/rust-firmament-vectors.mjs`).
//!
//! `nodes`/`adj`/`signs`/`builds`/`statdefs`/`statKeys` are the generated tables themselves: the JS row is the oracle and
//! the port rebuilds it from `generated::firmament`, so a changed star, edge, word or preset fails here. Every case is a
//! whole ordered value compared through the codec (f64 as bits).

mod common;

use dfo_core::firmament::{
    build_by_id, builds, node_has_off, off_stat, plan_build, plan_from_tree, plan_key, plan_summary,
};
use dfo_core::firmament_law::{
    self as law, blow_pct, cast_cost_pct, effective_value, is_start, node_keys, stat_words,
    totals_from_value, Tree,
};
use dfo_core::generated::firmament::{
    FIRM_ADJ, FIRM_NODES, SERPENT, SIGNS, START_KEYS, STAT_DEF_ROWS,
};
use dfo_core::value::Value::{self, Arr, Bool, Null, Num, Obj, Str};
use std::collections::BTreeMap;

fn s(text: &str) -> Value {
    Str(text.to_owned())
}

fn node_row(key: &str) -> Value {
    let n = FIRM_NODES
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, n)| n)
        .expect("generated node");
    let mut out = Obj(vec![]);
    out.set("key", s(n.key));
    out.set("kind", s(n.kind));
    out.set("ring", s(n.ring));
    out.set("sector", s(n.sector));
    out.set("cluster", n.cluster.map_or(Null, s));
    out.set("name", s(n.name));
    out.set(
        "stats",
        Obj(n
            .stats
            .iter()
            .map(|(k, v)| ((*k).to_owned(), Num(*v)))
            .collect()),
    );
    if let Some(text) = n.text {
        out.set("text", s(text));
    }
    out.set("x", Num(n.x));
    out.set("y", Num(n.y));
    out
}

fn stat_def_row(d: law::StatDef) -> Value {
    let mut o = Obj(vec![]);
    o.set("kind", s(d.kind));
    o.set("max", Num(d.max));
    o.set("min", Num(d.min));
    o
}

#[test]
fn firmament() {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut nodes_checked = false;
    for mut row in common::stream("firmament") {
        let kind = row.kind.clone();
        let defs = std::collections::HashMap::new();
        let got = match kind.as_str() {
            "nodes" => {
                nodes_checked = true;
                Arr(node_keys().map(node_row).collect())
            }
            "adj" => Arr(FIRM_ADJ
                .iter()
                .map(|(k, vs)| Arr(vec![s(k), Arr(vs.iter().map(|v| s(v)).collect())]))
                .collect()),
            "builds" => Arr(builds().to_vec()),
            "signs" => {
                let mut out = Obj(vec![]);
                out.set(
                    "SIGNS",
                    Arr(SIGNS
                        .iter()
                        .map(|x| {
                            let mut o = Obj(vec![]);
                            o.set("id", s(x.id));
                            o.set("name", s(x.name));
                            o
                        })
                        .collect()),
                );
                let mut serpent = Obj(vec![]);
                serpent.set("id", s(SERPENT.id));
                serpent.set("name", s(SERPENT.name));
                out.set("SERPENT", serpent);
                out.set("START_KEYS", Arr(START_KEYS.iter().map(|k| s(k)).collect()));
                out
            }
            "constants" => Arr(vec![
                Num(law::FIRMAMENT_STARS),
                Num(law::FIRMAMENT_NODES as f64),
            ]),
            "statdefs" => Arr(STAT_DEF_ROWS
                .iter()
                .map(|(k, _)| Arr(vec![s(k), law::stat_def(k).map_or(Null, stat_def_row)]))
                .collect()),
            "statKeys" => {
                // The sorted channel alphabet, checked against the generated table: every key resolves.
                let got = Arr(STAT_DEF_ROWS.iter().map(|(k, _)| s(k)).collect::<Vec<_>>());
                let mut sorted: Vec<Value> = got.items().to_vec();
                sorted.sort_by_key(|v| v.to_js_string());
                for k in &sorted {
                    let key = k.to_js_string();
                    assert!(law::stat_def(&key).is_some(), "statDef misses {key}");
                }
                got
            }
            "statdef" => {
                let key = row.value(&defs).to_js_string();
                law::stat_def(&key).map_or(Null, stat_def_row)
            }
            "words" => {
                let key = row.value(&defs).to_js_string();
                let v = row.value(&defs).to_number();
                s(&stat_words(&key, v))
            }
            "isstart" => {
                let key = row.value(&defs).to_js_string();
                Bool(is_start(&key))
            }
            "buildbyid" => {
                let id = row.value(&defs);
                build_by_id(&id).cloned().unwrap_or(Null)
            }
            "plan" => {
                let build = row.value(&defs);
                let opts = row.value(&defs);
                plan_build(&build, &opts)
            }
            "fromtree" => {
                let build = row.value(&defs);
                let opts = row.value(&defs);
                plan_from_tree(&build, &opts)
            }
            "key" => {
                let id = row.value(&defs);
                let stars = row.value(&defs);
                let start = row.value(&defs);
                plan_key(&id, &stars, &start)
            }
            "summary" => {
                let plan = row.value(&defs);
                plan_summary(&plan)
            }
            "blow" => {
                let totals = row.value(&defs);
                let opts = row.value(&defs);
                Num(blow_pct(
                    &totals_from_value(&totals),
                    opts.get("skill").as_str(),
                    opts.get("group").as_str(),
                    opts.get("unaware").truthy(),
                    opts.get("wounded").truthy(),
                ))
            }
            "castcost" => {
                let totals = row.value(&defs);
                let schools = row.value(&defs);
                let names: Vec<&str> = schools
                    .items()
                    .iter()
                    .map(|x| x.as_str().unwrap_or(""))
                    .collect();
                Num(cast_cost_pct(&totals_from_value(&totals), &names))
            }
            "effective" => {
                let totals = row.value(&defs);
                let keys = row.value(&defs);
                Arr(keys
                    .items()
                    .iter()
                    .map(|k| {
                        Num(effective_value(
                            &totals_from_value(&totals),
                            &k.to_js_string(),
                        ))
                    })
                    .collect())
            }
            "treestats" => {
                let tree = row.value(&defs);
                let typed = Tree {
                    start: tree.get("start").to_js_string(),
                    keys: tree
                        .get("keys")
                        .items()
                        .iter()
                        .map(|k| k.to_js_string())
                        .collect(),
                };
                let totals = law::tree_stats(&typed);
                let mut out = Obj(vec![]);
                for (k, v) in totals.entries {
                    out.set(&k, Num(v));
                }
                out
            }
            "blowtree" => {
                let tree = row.value(&defs);
                let opts = row.value(&defs);
                let typed = Tree {
                    start: tree.get("start").to_js_string(),
                    keys: tree
                        .get("keys")
                        .items()
                        .iter()
                        .map(|k| k.to_js_string())
                        .collect(),
                };
                Num(blow_pct(
                    &law::tree_stats(&typed),
                    opts.get("skill").as_str(),
                    opts.get("group").as_str(),
                    opts.get("unaware").truthy(),
                    opts.get("wounded").truthy(),
                ))
            }
            "castcosttree" => {
                let tree = row.value(&defs);
                let schools = row.value(&defs);
                let typed = Tree {
                    start: tree.get("start").to_js_string(),
                    keys: tree
                        .get("keys")
                        .items()
                        .iter()
                        .map(|k| k.to_js_string())
                        .collect(),
                };
                let names: Vec<&str> = schools
                    .items()
                    .iter()
                    .map(|x| x.as_str().unwrap_or(""))
                    .collect();
                Num(cast_cost_pct(&law::tree_stats(&typed), &names))
            }
            "smallstats" => {
                let stats = row.value(&defs);
                let owned: Vec<(String, f64)> = stats
                    .entries()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.to_number()))
                    .collect();
                let pairs: Vec<(&str, f64)> = owned.iter().map(|(k, v)| (k.as_str(), *v)).collect();
                let mut out = Obj(vec![]);
                for (k, v) in law::small_stats(&pairs) {
                    out.set(&k, Num(v));
                }
                out
            }
            "skillnames" => {
                let totals = row.value(&defs);
                Arr(law::skill_names(&totals_from_value(&totals))
                    .into_iter()
                    .map(|n| s(&n))
                    .collect())
            }
            "isprice" => {
                let key = row.value(&defs).to_js_string();
                let v = row.value(&defs).to_number();
                Bool(law::is_price(&key, v))
            }
            "treeprices" => {
                let tree = row.value(&defs);
                let typed = Tree {
                    start: tree.get("start").to_js_string(),
                    keys: tree
                        .get("keys")
                        .items()
                        .iter()
                        .map(|k| k.to_js_string())
                        .collect(),
                };
                let totals = law::tree_stats(&typed);
                Obj(totals
                    .prices
                    .iter()
                    .map(|(k, v)| (k.clone(), Num(*v)))
                    .collect())
            }
            "castcostparts" => {
                // Unreachable from the sky (the generator asserts no star prices a castCost channel): the two price
                // terms of `cast_cost_pct` are only exercised here for completeness.
                let totals = row.value(&defs);
                let prices = row.value(&defs);
                let schools = row.value(&defs);
                let mut t = totals_from_value(&totals);
                for (k, v) in prices.entries() {
                    t.prices.push((k.clone(), v.to_number()));
                }
                let names: Vec<&str> = schools
                    .items()
                    .iter()
                    .map(|x| x.as_str().unwrap_or(""))
                    .collect();
                Num(cast_cost_pct(&t, &names))
            }
            "statsparts" => {
                let gains = row.value(&defs);
                let prices = row.value(&defs);
                let owned: Vec<(String, f64)> = gains
                    .entries()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.to_number()))
                    .collect();
                let priced: Vec<(String, f64)> = prices
                    .entries()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.to_number()))
                    .collect();
                let t = law::stats_from_parts(&owned, &priced);
                let mut entries = Obj(vec![]);
                for (k, v) in t.entries {
                    entries.set(&k, Num(v));
                }
                let mut paid = Obj(vec![]);
                for (k, v) in t.prices {
                    paid.set(&k, Num(v));
                }
                Arr(vec![entries, paid])
            }
            "offstat" => {
                let build = row.value(&defs);
                let key = row.value(&defs).to_js_string();
                Bool(off_stat(&build, &key))
            }
            "nodehasoff" => {
                let key = row.value(&defs);
                let build = row.value(&defs);
                let connector = row.value(&defs).truthy();
                Bool(match key.as_str() {
                    None => false,
                    Some(k) => node_has_off(k, &build, connector),
                })
            }
            other => panic!("unexpected firmament vector kind {other}"),
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
    assert!(nodes_checked, "firmament: the node table row is missing");
    // Every plan walk, summary and law read is proved by its own cases; the floors are the generated domain sizes.
    for (kind, floor) in [
        ("plan", 500),
        ("summary", 90),
        ("fromtree", 60),
        ("blow", 200),
        ("castcost", 160),
        ("effective", 45),
        ("words", 4000),
        ("statdef", 120),
        ("isstart", 130),
        ("buildbyid", 30),
        ("treestats", 12),
        ("treeprices", 12),
        ("statsparts", 12),
        ("blowtree", 20),
        ("castcosttree", 6),
        ("smallstats", 300),
        ("skillnames", 5),
        ("isprice", 200),
        ("offstat", 400),
        ("nodehasoff", 1500),
    ] {
        let n = counts.get(kind).copied().unwrap_or(0);
        assert!(n >= floor, "firmament/{kind}: {n} cases, floor {floor}");
    }
}
