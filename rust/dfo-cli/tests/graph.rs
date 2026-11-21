//! The R8 report-rendering primitives, differentially against the REAL `src/graph.js`.
//!
//! One `node --input-type=module` run imports `src/graph.js`, renders the case list below, and prints its answers as
//! JSON; each is compared byte for byte with the module's own rendering (`src/graph.js:4-96`). The cases carry HTML
//! metacharacters in every caller-supplied string (titles, axis labels, tick labels, series names, page headings) and
//! `toFixed` ties (`0.125`, `2.675`, x-axis labels), which is where a hand-written renderer drifts. A skipped
//! differential proves nothing, so a missing `node` panics.
//!
//! `src/graph.rs` is not wired into `main.rs` by this slice (the `graph` command owns that), so this test includes it
//! by path and exercises its public API directly.

#[path = "../src/graph.rs"]
mod graph;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use graph::{LineChart, Point, Section, Series, Tick};
use serde_json::{json, Value};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

const ORACLE: &str = r#"
import { readFileSync } from 'node:fs';
import { lineChart, graphPage, multiGraphPage } from './src/graph.js';
const calls = JSON.parse(readFileSync(0, 'utf8'));
const out = calls.map((c) => c.kind === 'line'
  ? lineChart(c.input)
  : c.kind === 'page' ? graphPage(c.input) : multiGraphPage(c.input));
process.stdout.write(JSON.stringify(out));
"#;

/// Every case: the module's rendering, and the JSON call the real JS makes for the same input.
struct Case {
    expected: String,
    call: Value,
}

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn series(name: &str, points: &[(f64, f64)]) -> Series {
    Series {
        name: name.to_owned(),
        points: points.iter().map(|&(x, y)| point(x, y)).collect(),
    }
}

fn tick(at: f64, label: &str) -> Tick {
    Tick {
        at,
        label: label.to_owned(),
    }
}

/// The JS-shaped `lineChart` argument: `xLabel`/`xTicks`/`yTicks`/`invertY` are the JS names.
fn line_call(c: &LineChart) -> Value {
    json!({
        "title": c.title,
        "xLabel": c.x_label,
        "yLabel": c.y_label,
        "width": c.width,
        "height": c.height,
        "invertY": c.invert_y,
        "xTicks": c.x_ticks.as_ref().map(|ticks| ticks.iter()
            .map(|t| json!({ "x": t.at, "label": t.label })).collect::<Vec<_>>()),
        "yTicks": c.y_ticks.as_ref().map(|ticks| ticks.iter()
            .map(|t| json!({ "y": t.at, "label": t.label })).collect::<Vec<_>>()),
        "series": c.series.iter().map(|s| json!({
            "name": s.name,
            "points": s.points.iter().map(|p| json!({ "x": p.x, "y": p.y })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

fn line(c: LineChart) -> Case {
    Case {
        expected: graph::line_chart(&c),
        call: json!({ "kind": "line", "input": line_call(&c) }),
    }
}

fn page(title: &str, subtitle: &str, chart: &str) -> Case {
    Case {
        expected: graph::graph_page(title, subtitle, chart),
        call: json!({ "kind": "page", "input": { "title": title, "subtitle": subtitle, "chart": chart } }),
    }
}

fn section(title: &str, note: &str, chart: &str, table: &str) -> Section {
    Section {
        title: title.to_owned(),
        note: note.to_owned(),
        chart: chart.to_owned(),
        table: table.to_owned(),
    }
}

fn multi(title: &str, subtitle: &str, sections: &[Section]) -> Case {
    Case {
        expected: graph::multi_graph_page(title, subtitle, sections),
        call: json!({
            "kind": "multi",
            "input": {
                "title": title,
                "subtitle": subtitle,
                "sections": sections.iter().map(|s| json!({
                    "title": s.title, "note": s.note, "chart": s.chart, "table": s.table,
                })).collect::<Vec<_>>(),
            },
        }),
    }
}

fn cases() -> Vec<Case> {
    let mut cases = Vec::new();

    // Defaults: unsafe headings, axis labels and series names must be escaped everywhere they land.
    let mut chart = LineChart::new(
        "DPS <curves> & 'more'",
        "Effective \"weapon\" skill",
        "DPS 'capped'",
        vec![
            series(
                "Vampire <clan>",
                &[(10.0, 120.0), (20.0, 180.5), (30.0, 210.25)],
            ),
            series(
                "order & chaos",
                &[(10.0, 90.0), (25.0, 150.0), (30.0, 260.0)],
            ),
        ],
    );
    cases.push(line(chart.clone()));

    // Explicit axes (unsafe labels), inverted y, fractional geometry, and `toFixed` ties in the points and the ticks.
    chart.width = 1000.5;
    chart.height = 431.0;
    chart.invert_y = true;
    chart.x_ticks = Some(vec![
        tick(0.0, "zero & <one>"),
        tick(0.125, "0.125"),
        tick(2.5, "tie 2.5"),
        tick(1e21, "big"),
    ]);
    chart.y_ticks = Some(vec![
        tick(0.0, "0"),
        tick(1.25, "1.25"),
        tick(2.675, "2.675"),
        tick(1e21, "1e21"),
    ]);
    chart.series = vec![
        series("<inline>", &[(0.125, 2.675), (2.5, 1.25), (1e21, 1.0)]),
        series("quote\"and'apostrophe", &[(0.0, -0.125), (1.0, 9.995)]),
    ];
    cases.push(line(chart.clone()));

    // Default axes from fractional and 100+ values: x labels pick `toFixed(1)`/`toFixed(0)`, y labels `toFixed(0)`.
    chart.width = 920.0;
    chart.height = 430.0;
    chart.invert_y = false;
    chart.x_ticks = None;
    chart.y_ticks = None;
    chart.series = vec![series(
        "a",
        &[(100.125, 150.5), (260.675, 999.0), (421.0, 132.25)],
    )];
    cases.push(line(chart));

    // No series at all: the JS still renders its grid over an empty domain (NaN coordinates), and so must the port.
    cases.push(line(LineChart::new("empty", "x", "y", vec![])));

    cases.push(page(
        "Report <a href=\"x\">& 'q'",
        "Sub & <b>raw</b>",
        "<svg>raw & unescaped</svg>",
    ));
    cases.push(page("Plain", "Nothing to escape", ""));

    let sections = [
        section(
            "Section <1> & 'two'",
            "<b>bold</b> & raw <i>note</i>",
            "<svg><text>raw & unescaped</text></svg>",
            "<div>table & markup</div>",
        ),
        section("Empty", "", "", ""),
    ];
    cases.push(multi("Probe <page> & 'x'", "Level 1 & <2>", &sections));
    cases.push(multi("Probe", "No sections", &[]));

    cases
}

fn oracle() -> Vec<String> {
    let calls: Vec<Value> = cases().iter().map(|c| c.call.clone()).collect();
    let mut child = Command::new("node")
        .arg("--input-type=module")
        .arg("-e")
        .arg(ORACLE)
        .current_dir(repo_root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("node runs (this repository's Node project)");
    let input = serde_json::to_vec(&calls).expect("the call list serialises");
    child
        .stdin
        .as_mut()
        .expect("piped stdin")
        .write_all(&input)
        .expect("the call list is written");
    let out = child.wait_with_output().expect("node finishes");
    assert_eq!(
        out.status.code(),
        Some(0),
        "oracle: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = out.stdout;
    serde_json::from_slice(&stdout).expect("the oracle prints a JSON string array")
}

#[test]
fn renders_line_charts_and_pages_like_the_js() {
    let js = oracle();
    let cases = cases();
    assert_eq!(cases.len(), js.len(), "the oracle answered every case");
    for (i, (case, want)) in cases.iter().zip(js).enumerate() {
        assert_eq!(
            case.expected, want,
            "case {i} differs from src/graph.js (JS output {want:?})"
        );
    }
}
