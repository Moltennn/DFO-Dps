//! The dependency-free report rendering primitives of `src/graph.js` (R8): `lineChart`, `graphPage`,
//! `multiGraphPage` and `barChart`, ready for the `graph`, `probe` and report commands of `dfo-cli`.
//!
//! Only rendering lives here: plain data in, one HTML/SVG string out, no file I/O, no clock, no randomness, and no
//! decision that changes a DPS number. The JS module (`src/graph.js:4-113`) is the source of truth;
//! `tests/graph.rs` drives the real module over synthetic charts and compares every byte. The page writer (`writePage`,
//! `src/cli.js:868-873`) and the `graph`/`probe` commands are not part of this file.
//!
//! Escaping is the JS `esc` (`src/graph.js:4`), applied to every caption and label a caller passes (`title`,
//! `xLabel`, `yLabel`, tick labels, series names, bar labels, bar units, page headings). `multiGraphPage` keeps the
//! JS's deliberate raw insertion for a section's `note`, `chart` and `table` (`:69-70`): those strings are markup the
//! caller assembled, and the probe's chart names reach the note unescaped in the JS too. Number formatting is JS
//! `toFixed`, not Rust's `{:.N}` (the two round exact ties differently: `(0.125).toFixed(2)` is `"0.13"`, Rust's is
//! `"0.12"`).

use dfo_core::round::{js_max, js_min};
use dfo_core::value::number_to_string;

/// `COLORS` (`src/graph.js:5`): the palette, indexed by series position.
const COLORS: [&str; 8] = [
    "#c08a3e", "#7fae6a", "#c25b4e", "#6fa8dc", "#c9a0dc", "#e0d36a", "#8fd3c7", "#d98cb3",
];

/// `esc` (`src/graph.js:4`): one pass over the five HTML metacharacters, `String(s)` already applied by the types.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// One `{ x, y }` point of a series.
#[derive(Debug, Clone, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// One `{ name, points }` series.
#[derive(Debug, Clone, PartialEq)]
pub struct Series {
    pub name: String,
    pub points: Vec<Point>,
}

/// One explicit axis label: `{ x, label }` on the x axis, `{ y, label }` on the y axis.
#[derive(Debug, Clone, PartialEq)]
pub struct Tick {
    pub at: f64,
    pub label: String,
}

/// A `lineChart` call. [`LineChart::new`] takes the arguments both report commands pass; the remaining fields are the
/// JS options (`width`, `height`, `xTicks`, `yTicks`, `invertY`) and default exactly as the JS parameters do.
#[derive(Debug, Clone, PartialEq)]
pub struct LineChart {
    pub title: String,
    pub x_label: String,
    pub y_label: String,
    pub series: Vec<Series>,
    pub width: f64,
    pub height: f64,
    pub x_ticks: Option<Vec<Tick>>,
    pub y_ticks: Option<Vec<Tick>>,
    pub invert_y: bool,
}

impl LineChart {
    pub fn new(
        title: impl Into<String>,
        x_label: impl Into<String>,
        y_label: impl Into<String>,
        series: Vec<Series>,
    ) -> Self {
        Self {
            title: title.into(),
            x_label: x_label.into(),
            y_label: y_label.into(),
            series,
            width: 920.0,
            height: 430.0,
            x_ticks: None,
            y_ticks: None,
            invert_y: false,
        }
    }
}

/// One `multiGraphPage` section: its heading, note, pre-rendered chart and optional table (markup, inserted raw as the
/// JS does).
#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    pub title: String,
    pub note: String,
    pub chart: String,
    pub table: String,
}

/// JS `Number.prototype.toFixed(digits)` for a finite double below 1e21.
///
/// The spec rounds the exact value of the double to `digits` fraction digits, picking the larger of two equidistant
/// integers, which makes a tie round away from zero. Rust's `{:.N}` rounds exact ties to even, so this formats the
/// exact decimal expansion (1100 digits covers the smallest subnormal, whose expansion has 1074) and rounds that.
/// `NaN`, the infinities and 1e21 and above follow the spec's own `String(x)` fallback, as the JS does.
///
/// shortcut: `digits` is taken as given (the JS `RangeError` above 100 is not modelled); every caller passes 0..=2.
fn to_fixed(x: f64, digits: usize) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let abs = x.abs();
    if abs >= 1e21 {
        return number_to_string(x);
    }
    let exact = format!("{:.1100}", abs);
    let (whole, fraction) = exact
        .split_once('.')
        .expect("precision formatting writes a point");
    let mut all: Vec<u8> = format!("{whole}{fraction}").into_bytes();
    let keep = whole.len() + digits;
    let round_up = all.get(keep).is_some_and(|d| *d >= b'5');
    all.truncate(keep);
    if round_up {
        let mut i = all.len();
        while i > 0 {
            i -= 1;
            if all[i] == b'9' {
                all[i] = b'0';
            } else {
                all[i] += 1;
                break;
            }
        }
        if i == 0 && all[0] == b'0' {
            all.insert(0, b'1');
        }
    }
    let point = all.len() - digits;
    let mut out = String::new();
    if x < 0.0 {
        out.push('-');
    }
    if digits == 0 {
        out.push_str(std::str::from_utf8(&all).expect("digits are ASCII"));
    } else {
        out.push_str(std::str::from_utf8(&all[..point]).expect("digits are ASCII"));
        out.push('.');
        out.push_str(std::str::from_utf8(&all[point..]).expect("digits are ASCII"));
    }
    out
}

/// JS `String(n)` for the attribute values the chart interpolates.
fn n(x: f64) -> String {
    number_to_string(x)
}

/// `lineChart` (`src/graph.js:7-42`): the single SVG line chart the report pages embed.
pub fn line_chart(chart: &LineChart) -> String {
    let legend_cols = 5;
    let legend_rows = chart.series.len().div_ceil(legend_cols).max(1);
    let left = 64.0;
    let right = 24.0;
    let top = 46.0 + (legend_rows - 1) as f64 * 16.0;
    let bottom = 54.0;
    let w = chart.width - left - right;
    let h = chart.height - top - bottom;

    let mut x_min = f64::INFINITY;
    let mut x_max = f64::NEG_INFINITY;
    let mut y_max = 1.0;
    for s in &chart.series {
        for p in &s.points {
            x_min = js_min(x_min, p.x);
            x_max = js_max(x_max, p.x);
            y_max = js_max(y_max, p.y);
        }
    }
    y_max *= 1.08;

    let sx = |x: f64| left + ((x - x_min) / js_max(1e-9, x_max - x_min)) * w;
    let sy = |y: f64| {
        if chart.invert_y {
            top + (y / y_max) * h
        } else {
            top + h - (y / y_max) * h
        }
    };

    let mut grid = String::new();
    let y_grid = chart.y_ticks.clone().unwrap_or_else(|| {
        (0..6)
            .map(|i| {
                let v = y_max * (1.0 - i as f64 / 5.0);
                Tick {
                    at: v,
                    label: to_fixed(v, if v >= 100.0 { 0 } else { 1 }),
                }
            })
            .collect()
    });
    for tick in &y_grid {
        let y = sy(tick.at);
        grid.push_str(&format!(
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"#3a3026\" stroke-width=\"1\"/>",
            n(left),
            n(y),
            n(left + w),
            n(y)
        ));
        grid.push_str(&format!(
            "<text x=\"{}\" y=\"{}\" fill=\"#a8a092\" font-size=\"11\" text-anchor=\"end\">{}</text>",
            n(left - 8.0),
            n(y + 4.0),
            escape(&tick.label)
        ));
    }
    let ticks = chart.x_ticks.clone().unwrap_or_else(|| {
        (0..6)
            .map(|i| {
                let x = x_min + ((x_max - x_min) * i as f64) / 5.0;
                Tick {
                    at: x,
                    label: to_fixed(x, if x % 1.0 != 0.0 { 1 } else { 0 }),
                }
            })
            .collect()
    });
    for tick in &ticks {
        let x = sx(tick.at);
        grid.push_str(&format!(
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"#2b241c\" stroke-width=\"1\"/>",
            n(x),
            n(top),
            n(x),
            n(top + h)
        ));
        grid.push_str(&format!(
            "<text x=\"{}\" y=\"{}\" fill=\"#a8a092\" font-size=\"11\" text-anchor=\"middle\">{}</text>",
            n(x),
            n(top + h + 20.0),
            escape(&tick.label)
        ));
    }

    let mut lines = String::new();
    for (i, s) in chart.series.iter().enumerate() {
        let color = COLORS[i % COLORS.len()];
        let pts = s
            .points
            .iter()
            .map(|p| format!("{},{}", to_fixed(sx(p.x), 1), to_fixed(sy(p.y), 1)))
            .collect::<Vec<_>>()
            .join(" ");
        lines.push_str(&format!(
            "<polyline points=\"{pts}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"2\"/>"
        ));
        for p in &s.points {
            lines.push_str(&format!(
                "<circle cx=\"{}\" cy=\"{}\" r=\"2.2\" fill=\"{}\"><title>{} {}: {}</title></circle>",
                to_fixed(sx(p.x), 1),
                to_fixed(sy(p.y), 1),
                color,
                escape(&s.name),
                n(p.x),
                to_fixed(p.y, 2)
            ));
        }
    }

    let mut legend = String::new();
    for (i, s) in chart.series.iter().enumerate() {
        let col = i % legend_cols;
        let row = i / legend_cols;
        legend.push_str(&format!(
            "<g transform=\"translate({}, {})\"><rect width=\"10\" height=\"10\" fill=\"{}\"/><text x=\"15\" y=\"9\" fill=\"#e9e4d9\" font-size=\"12\">{}</text></g>",
            n(left + col as f64 * 170.0),
            n(top - 18.0 - row as f64 * 16.0),
            COLORS[i % COLORS.len()],
            escape(&s.name)
        ));
    }

    let title = escape(&chart.title);
    let mut out = String::new();
    out.push_str(&format!(
        "<svg viewBox=\"0 0 {} {}\" width=\"100%\" role=\"img\" aria-label=\"{}\" style=\"display:block;max-width:100%;height:auto\">\n",
        n(chart.width),
        n(chart.height),
        title
    ));
    out.push_str(&format!(
        "    <rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" fill=\"#12100e\"/>\n",
        n(chart.width),
        n(chart.height)
    ));
    out.push_str(&format!(
        "    <text x=\"{}\" y=\"22\" fill=\"#e0b76a\" font-size=\"16\" font-family=\"Georgia,serif\">{}</text>\n",
        n(left),
        title
    ));
    out.push_str(&format!(
        "    <text x=\"{}\" y=\"{}\" fill=\"#a8a092\" font-size=\"12\">{}</text>\n",
        n(left),
        n(top + h + 44.0),
        escape(&chart.x_label)
    ));
    out.push_str(&format!(
        "    <text x=\"14\" y=\"{}\" fill=\"#a8a092\" font-size=\"12\" transform=\"rotate(-90 14 {})\">{}</text>\n",
        n(top + h / 2.0),
        n(top + h / 2.0),
        escape(&chart.y_label)
    ));
    out.push_str("    ");
    out.push_str(&grid);
    out.push_str(&lines);
    out.push_str(&legend);
    out.push_str("\n  </svg>");
    out
}

/// One `{ name, values }` series of a bar chart: `values[i]` pairs with `labels[i]`.
#[derive(Debug, Clone, PartialEq)]
pub struct BarSeries {
    pub name: String,
    pub values: Vec<f64>,
}

/// A `barChart` call. [`BarChart::new`] takes the arguments the report commands pass; `width` and `unit` are the JS
/// options and default as its parameters do.
#[derive(Debug, Clone, PartialEq)]
pub struct BarChart {
    pub title: String,
    pub labels: Vec<String>,
    pub series: Vec<BarSeries>,
    pub width: f64,
    pub unit: String,
}

impl BarChart {
    pub fn new(title: impl Into<String>, labels: Vec<String>, series: Vec<BarSeries>) -> Self {
        Self {
            title: title.into(),
            labels,
            series,
            width: 920.0,
            unit: String::new(),
        }
    }
}

/// `barChart` (`src/graph.js:89-113`): the horizontal grouped bars the report pages embed. Each series must carry one
/// value per label; a missing one panics, as the JS's `undefined.toFixed(0)` throws.
pub fn bar_chart(chart: &BarChart) -> String {
    let left = 170.0;
    let right = 70.0;
    let top = 48.0;
    let row_h = 26.0;
    let bottom = 24.0;
    let height = top + chart.labels.len() as f64 * row_h + bottom;
    let mut max = 1.0;
    for s in &chart.series {
        for &v in &s.values {
            max = js_max(max, v);
        }
    }
    let w = chart.width - left - right;
    let sx = |v: f64| left + (v / max) * w;
    let n_series = chart.series.len() as f64;
    let bh = js_max(3.0, (row_h - 7.0) / n_series - 1.0);
    let unit = escape(&chart.unit);

    let mut rows = String::new();
    for (i, label) in chart.labels.iter().enumerate() {
        let y = top + i as f64 * row_h;
        rows.push_str(&format!(
            "<text x=\"{}\" y=\"{}\" fill=\"#e9e4d9\" font-size=\"11\" text-anchor=\"end\">{}</text>",
            n(left - 8.0),
            n(y + row_h / 2.0 + 4.0),
            escape(label)
        ));
        for (j, s) in chart.series.iter().enumerate() {
            let val = s.values[i];
            let by = y + 3.0 + j as f64 * (bh + 1.0);
            let bw = js_max(1.0, sx(val) - left);
            rows.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{}\" rx=\"2\"/><text x=\"{}\" y=\"{}\" fill=\"#a8a092\" font-size=\"10\">{}{}</text>",
                n(left),
                n(by),
                n(bw),
                n(bh),
                COLORS[j % COLORS.len()],
                n(left + bw + 6.0),
                n(by + bh - 1.0),
                to_fixed(val, 0),
                unit
            ));
        }
    }

    let mut legend = String::new();
    for (j, s) in chart.series.iter().enumerate() {
        legend.push_str(&format!(
            "<g transform=\"translate({}, {})\"><rect width=\"10\" height=\"10\" fill=\"{}\"/><text x=\"15\" y=\"9\" fill=\"#e9e4d9\" font-size=\"12\">{}</text></g>",
            n(left + j as f64 * 190.0),
            n(top - 20.0),
            COLORS[j % COLORS.len()],
            escape(&s.name)
        ));
    }

    let title = escape(&chart.title);
    let mut out = String::new();
    out.push_str(&format!(
        "<svg viewBox=\"0 0 {} {}\" width=\"100%\" role=\"img\" aria-label=\"{}\" style=\"display:block;max-width:100%;height:auto\">\n",
        n(chart.width),
        n(height),
        title
    ));
    out.push_str(&format!(
        "    <rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" fill=\"#12100e\"/>\n",
        n(chart.width),
        n(height)
    ));
    out.push_str(&format!(
        "    <text x=\"{}\" y=\"24\" fill=\"#e0b76a\" font-size=\"16\" font-family=\"Georgia,serif\">{}</text>\n",
        n(left),
        title
    ));
    out.push_str("    ");
    out.push_str(&legend);
    out.push_str(&rows);
    out.push_str("\n  </svg>");
    out
}

/// `graphPage` (`src/graph.js:44-49`): headings are escaped; `chart` must be renderer-generated SVG, not input text.
pub fn graph_page(title: &str, subtitle: &str, chart: &str) -> String {
    let title = escape(title);
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title>\n<style>body{{margin:0;background:#12100e;color:#e9e4d9;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}}main{{max-width:1040px;margin:0 auto;padding:28px 20px 60px}}h1{{font:600 26px/1.15 Georgia,serif;color:#e0b76a;margin:0 0 4px}}p{{color:#a8a092;margin:0 0 18px}}.panel{{background:#1b1814;border:1px solid #3a3026;border-radius:8px;padding:14px}}</style></head>\n<body><main><h1>{title}</h1><p>{subtitle}</p><div class=\"panel\">{chart}</div></main></body></html>",
        subtitle = escape(subtitle)
    )
}

/// `multiGraphPage` (`src/graph.js:52-96`): the several-section page the `probe` command writes. `width` is the JS
/// default 1100. Section notes, charts and tables must be trusted markup; escape capture text before building them.
pub fn multi_graph_page(title: &str, subtitle: &str, sections: &[Section]) -> String {
    let mut body = String::new();
    for s in sections {
        body.push_str(&format!(
            "<section class=\"panel\"><h2>{}</h2>",
            escape(&s.title)
        ));
        if !s.note.is_empty() {
            body.push_str(&format!("<p class=\"note\">{}</p>", s.note));
        }
        body.push_str(&s.chart);
        if !s.table.is_empty() {
            body.push_str(&format!("<div class=\"table\">{}</div>", s.table));
        }
        body.push_str("</section>");
    }
    let title = escape(title);
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title>\n<style>\n  body{{margin:0;background:#12100e;color:#e9e4d9;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}}\n  main{{max-width:1100px;margin:0 auto;padding:30px 20px 70px}}\n  h1{{font:600 28px/1.15 Georgia,serif;color:#e0b76a;margin:0 0 6px}}\n  h2{{font:600 18px/1.2 Georgia,serif;color:#e0b76a;margin:0 0 6px}}\n  p{{color:#a8a092;margin:0 0 16px}}\n  .panel{{background:#1b1814;border:1px solid #3a3026;border-radius:8px;padding:16px;margin:18px 0}}\n  .note{{font-size:13px;color:#a8a092;margin:0 0 12px}}\n  .note b{{color:#e9e4d9}}\n  .table{{overflow-x:auto;margin-top:12px}}\n  table{{width:100%;border-collapse:collapse;font-size:13px}}\n  th,td{{text-align:left;padding:5px 8px;border-bottom:1px solid #3a3026;white-space:nowrap}}\n  th{{color:#a8a092;font-weight:500}}\n  td:not(:first-child){{text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e0b76a}}\n  .k{{color:#e9e4d9}}\n</style></head>\n<body><main><h1>{title}</h1><p>{subtitle}</p>{body}</main></body></html>",
        subtitle = escape(subtitle)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `toFixed`'s exact-value rounding (a tie rounds away from zero) and its 1e21 `String(x)` fallback. A local
    /// invariant: the differential above cannot reach every one of these values through a chart's geometry.
    #[test]
    fn to_fixed_matches_js() {
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(-0.125, 2), "-0.13");
        assert_eq!(to_fixed(2.675, 2), "2.67");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(-2.5, 0), "-3");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(1.005, 1), "1.0");
        assert_eq!(to_fixed(0.0, 1), "0.0");
        assert_eq!(to_fixed(-0.0, 1), "0.0");
        assert_eq!(to_fixed(1e21, 1), "1e+21");
        assert_eq!(to_fixed(-1e21, 2), "-1e+21");
        assert_eq!(to_fixed(9.999, 2), "10.00");
        assert_eq!(to_fixed(99.995, 1), "100.0");
        assert_eq!(to_fixed(f64::NAN, 1), "NaN");
        assert_eq!(to_fixed(f64::INFINITY, 1), "Infinity");
    }

    /// The five-character map: an apostrophe and a quote land as entities, and the five do not chain (`&amp;` stays).
    #[test]
    fn escape_covers_the_five_html_metacharacters() {
        assert_eq!(escape("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&#39;f");
        assert_eq!(escape("&amp;"), "&amp;amp;");
        assert_eq!(escape("plain"), "plain");
    }
}
