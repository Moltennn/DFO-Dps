//! The R8 Firmament page, differentially against the REAL `src/firmament.js`.
//!
//! One `node --input-type=module` run imports `src/firmament.js`, renders each plan below with `firmamentSvg` and
//! `firmamentSection`, and prints the answers as JSON; each is compared byte for byte with [`firmament`]'s rendering of
//! the same plan. The plans are the core planner's own (`dfo_core::firmament::plan_build`, already differentially pinned),
//! serialised for the JS, so this test isolates the renderer: the sky, the edges, the crop, the labels and both tables.
//!
//! The last cases rehydrate a plan whose build name carries HTML metacharacters (`planFromTree` takes any build record),
//! which is where a hand-written renderer leaks markup into the SVG's aria label and the section title.
//!
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::js_batch;

#[path = "../src/firmament.rs"]
mod firmament;
#[path = "../src/graph.rs"]
#[allow(dead_code)]
mod graph;

use dfo_core::firmament::{build_by_id, builds, plan_build, plan_from_tree};
use dfo_core::value::Value::{self, Num, Obj, Str};
use serde_json::{json, Map, Value as JsonValue};
const ORACLE: &str = r#"
import { readFileSync } from 'node:fs';
import { firmamentSvg, firmamentSection } from './src/firmament.js';
const calls = JSON.parse(readFileSync(0, 'utf8'));
const out = calls.map((c) => c.kind === 'svg'
  ? firmamentSvg(c.plan, { height: c.height })
  : firmamentSection(c.plan));
process.stdout.write(JSON.stringify(out));
"#;

/// The plan as the JS reads it: the codec's own value, in the JS shape (a plain JSON document).
fn to_json(v: &Value) -> JsonValue {
    match v {
        Value::Undefined => JsonValue::Null,
        Value::Null => JsonValue::Null,
        Value::Bool(b) => JsonValue::Bool(*b),
        Value::Num(n) => {
            serde_json::Number::from_f64(*n).map_or(JsonValue::Null, JsonValue::Number)
        }
        Value::Str(s) => JsonValue::String(s.clone()),
        Value::Arr(items) => JsonValue::Array(items.iter().map(to_json).collect()),
        Value::Obj(entries) => {
            let mut out = Map::new();
            for (k, v) in entries {
                out.insert(k.clone(), to_json(v));
            }
            JsonValue::Object(out)
        }
    }
}

/// `planBuild(build)` at `stars`, the plan the Rust core and the JS both produce.
fn plan(id: &str, stars: f64) -> Value {
    let build = build_by_id(&Str(id.to_owned())).expect("a generated build");
    plan_build(build, &Obj(vec![("stars".to_owned(), Num(stars))]))
}

/// `planFromTree(build, ...)`: a build record of the test's own, over a real tree.
fn rehydrated(id: &str, name: &str) -> Value {
    let source = plan(id, 98.0);
    let tree = source.get("tree");
    let build = Obj(vec![
        ("name".to_owned(), Str(name.to_owned())),
        ("kind".to_owned(), Str("tank".to_owned())),
        ("channels".to_owned(), Value::Arr(vec![])),
    ]);
    plan_from_tree(
        &build,
        &Obj(vec![
            ("start".to_owned(), tree.get("start").clone()),
            ("keys".to_owned(), tree.get("keys").clone()),
            ("stars".to_owned(), source.get("stars").clone()),
            ("starBudget".to_owned(), source.get("starBudget").clone()),
        ]),
    )
}

/// Every case: the module's rendering, and the JSON call the real JS makes for the same plan.
struct Case {
    expected: String,
    call: JsonValue,
}

fn svg_case(plan: &Value, height: f64) -> Case {
    Case {
        expected: firmament::firmament_svg(plan, height),
        call: json!({ "kind": "svg", "plan": to_json(plan), "height": height }),
    }
}

fn section_case(plan: &Value) -> Case {
    let section = firmament::firmament_section(plan);
    // The section title, note and table are what the page shell consumes; the chart carries the SVG.
    let expected = format!(
        "{}\u{0}{}\u{0}{}\u{0}{}",
        section.title, section.note, section.chart, section.table
    );
    Case {
        expected,
        call: json!({ "kind": "section", "plan": to_json(plan) }),
    }
}

fn cases() -> Vec<Case> {
    let mut cases = Vec::new();
    let ids: Vec<String> = builds()
        .iter()
        .map(|b| b.get("id").to_js_string())
        .collect();
    for id in &ids {
        let plan = plan(id, 98.0);
        cases.push(svg_case(&plan, 720.0));
        cases.push(section_case(&plan));
    }
    // A smaller purse crops to fewer lit stars, and the free-stars suffix appears.
    for (id, stars) in [("bow", 24.0), ("tank", 12.0), ("destruction", 0.0)] {
        let plan = plan(id, stars);
        cases.push(svg_case(&plan, 430.0));
        cases.push(section_case(&plan));
    }
    // A plan whose build name is markup: the SVG aria label and the section title must read it as text.
    cases.push(section_case(&rehydrated(
        "longblade",
        "<script>&'\"</script>",
    )));
    cases.push(svg_case(
        &rehydrated("shortblade", "Blade & <Dancer>"),
        720.0,
    ));
    cases
}

fn oracle(calls: &[JsonValue]) -> Vec<JsonValue> {
    let input = serde_json::to_vec(calls).expect("the call list serialises");
    let out = js_batch(&["--input-type=module", "-e", ORACLE], &input);
    assert_eq!(
        out.status.code(),
        Some(0),
        "oracle: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = out.stdout;
    serde_json::from_slice(&stdout).expect("the oracle prints a JSON array")
}

#[test]
fn renders_the_firmament_page_like_the_js() {
    let cases = cases();
    let calls: Vec<JsonValue> = cases.iter().map(|c| c.call.clone()).collect();
    let js = oracle(&calls);
    assert_eq!(cases.len(), js.len(), "the oracle answered every case");
    for (i, (case, want)) in cases.iter().zip(js).enumerate() {
        // A section is returned as its four fields; the JS returns the record, so compare the joined fields.
        let want = if case.call["kind"] == "section" {
            let field = |k: &str| {
                want.get(k)
                    .map_or(String::new(), |x| x.as_str().unwrap_or("").to_owned())
            };
            format!(
                "{}\u{0}{}\u{0}{}\u{0}{}",
                field("title"),
                field("note"),
                field("chart"),
                field("table")
            )
        } else {
            want.as_str().unwrap_or("").to_owned()
        };
        assert_eq!(
            case.expected, want,
            "case {i} differs from src/firmament.js"
        );
    }
}
