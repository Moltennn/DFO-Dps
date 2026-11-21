//! The Firmament page of `src/firmament.js` (R8): `firmamentSvg` and `firmamentSection`, pure data in and markup out.
//!
//! The plan is `dfo_core::firmament`'s (already ported); this module owns only the drawing: the sky cropped to the lit
//! path, the 589 lines, the 518 stars, the start/keystone labels, and the two summary tables. `planSummary` is the core
//! port, so nothing here re-reads a total. The escaping is the shared renderer's `esc` (`crate::graph::escape`), applied
//! where the JS applies it: star names, stat words and summary row text, never the section title (the page shell escapes
//! that itself, as `multiGraphPage` does).
//!
//! `vendor/firmament/firmamentTree.js` is generated into `dfo_core::generated::firmament` with `FIRM_EDGES` in the
//! upstream array's insertion order (the order the SVG draws its lines in; `FIRM_ADJ` is sorted and cannot rebuild it).
//! The bounds are not pinned: they are the min/max over the stars, as `FIRM_BOUNDS` is.
//!
//! No file I/O here: [`firmament_section`] returns the page section the `firmament` command hands to
//! `graph::multi_graph_page`, and the command owns the card, the JSON document and the create-only write.

use std::collections::{HashMap, HashSet};

use dfo_core::firmament::plan_summary;
use dfo_core::firmament_law::{node, node_keys, sign_name, stat_words, Node};
use dfo_core::generated::firmament::FIRM_EDGES;
use dfo_core::round::{js_max, js_min};
use dfo_core::value::{number_to_string, Value};

use crate::graph::{escape, Section};

/// `KIND_COLOR` (`src/firmament.js:417`): a star's fill when the plan has it.
fn kind_color(kind: &str) -> &'static str {
    match kind {
        "start" => "#e0b76a",
        "keystone" => "#c25b4e",
        "notable" => "#c08a3e",
        "small" => "#7fae6a",
        "road" => "#6fa8dc",
        _ => "#e9e4d9",
    }
}

/// `n(x)`: the JS `${x}` of a number (`String(x)`).
fn n(x: f64) -> String {
    number_to_string(x)
}

/// The stars by key, for the edge lookups and the per-star drawing (the JS `FIRM_NODES`).
fn sky() -> HashMap<&'static str, Node> {
    node_keys().filter_map(node).map(|n| (n.key, n)).collect()
}

/// The `plan.build?.name ?? 'a build'` the SVG's aria label reads.
fn build_name(plan: &Value) -> String {
    match plan.get("build") {
        Value::Undefined | Value::Null => "a build".to_owned(),
        build => match build.get("name") {
            Value::Undefined | Value::Null => "a build".to_owned(),
            name => name.to_js_string(),
        },
    }
}

/// `firmamentSvg` (`src/firmament.js:420-450`): the sky, with the plan lit and the rest of the 518 stars as context.
/// `height` is the JS option (the caller passes its default 720).
pub fn firmament_svg(plan: &Value, height: f64) -> String {
    let nodes = sky();
    let tree = plan.get("tree");
    let mut lit: HashSet<&str> = HashSet::new();
    if let Some(start) = tree.get("start").as_str() {
        lit.insert(start);
    }
    for key in tree.get("keys").items() {
        if let Some(key) = key.as_str() {
            lit.insert(key);
        }
    }
    let pad = 170.0;
    // The sky's own bounds (`FIRM_BOUNDS` is the min/max over the stars).
    let (mut b_x0, mut b_y0, mut b_x1, mut b_y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for n in nodes.values() {
        b_x0 = js_min(b_x0, n.x);
        b_y0 = js_min(b_y0, n.y);
        b_x1 = js_max(b_x1, n.x);
        b_y1 = js_max(b_y1, n.y);
    }
    // Crop to the lit path, not the whole sky. An empty path follows the JS `Math.min(...[])` arms (no real plan is).
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for n in nodes.values().filter(|n| lit.contains(n.key)) {
        min_x = js_min(min_x, n.x);
        min_y = js_min(min_y, n.y);
        max_x = js_max(max_x, n.x);
        max_y = js_max(max_y, n.y);
    }
    let x0 = js_max(b_x0 - 40.0, min_x - pad);
    let x1 = js_min(b_x1 + 40.0, max_x + pad);
    let y0 = js_max(b_y0 - 40.0, min_y - pad);
    let y1 = js_min(b_y1 + 40.0, max_y + pad);
    let view_box = format!("{} {} {} {}", n(x0), n(y0), n(x1 - x0), n(y1 - y0));

    let mut edges = String::new();
    for edge in FIRM_EDGES {
        let on = lit.contains(edge.a) && lit.contains(edge.b);
        let (na, nb) = (nodes[edge.a], nodes[edge.b]);
        edges.push_str(&format!(
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"{}\" opacity=\"{}\"/>",
            n(na.x),
            n(na.y),
            n(nb.x),
            n(nb.y),
            if on { "#c08a3e" } else { "#2b241c" },
            if on { "2.2" } else { "1" },
            if on { "0.95" } else { "0.7" }
        ));
    }

    let mut stars = String::new();
    for key in node_keys() {
        let Some(star) = nodes.get(key) else { continue };
        let on = lit.contains(star.key);
        let color = if on { kind_color(star.kind) } else { "#2b241c" };
        let r = if !on {
            "3"
        } else {
            match star.kind {
                "start" => "22",
                "keystone" => "14",
                "notable" => "11",
                "road" => "8",
                _ => "7",
            }
        };
        let stats = star
            .stats
            .iter()
            .map(|(k, v)| escape(&stat_words(k, *v)))
            .collect::<Vec<_>>()
            .join(", ");
        stars.push_str(&format!(
            "<circle cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"2\"><title>{} - {} - {}</title></circle>",
            n(star.x),
            n(star.y),
            r,
            color,
            if on { "#12100e" } else { "none" },
            escape(star.name),
            star.kind,
            stats
        ));
    }

    let mut labels = String::new();
    for key in node_keys() {
        let Some(star) = nodes.get(key) else { continue };
        if lit.contains(star.key) && (star.kind == "start" || star.kind == "keystone") {
            labels.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" fill=\"#e9e4d9\" font-size=\"30\" paint-order=\"stroke\" stroke=\"#12100e\" stroke-width=\"6\">{}</text>",
                n(star.x + 28.0),
                n(star.y + 10.0),
                escape(star.name)
            ));
        }
    }

    format!(
        "<svg viewBox=\"{view_box}\" width=\"100%\" height=\"{}\" preserveAspectRatio=\"xMidYMid meet\" role=\"img\" aria-label=\"Firmament tree for {}\" style=\"display:block;max-width:100%\">\n    <rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"#12100e\"/>\n    {edges}{stars}{labels}\n  </svg>",
        n(height),
        escape(&build_name(plan)),
        n(x0),
        n(y0),
        n(x1 - x0),
        n(y1 - y0)
    )
}

/// `firmamentSection` (`src/firmament.js:452-467`): the tree, the channel totals and the stars taken.
pub fn firmament_section(plan: &Value) -> Section {
    let sum = plan_summary(plan);
    let mut channel_rows = String::new();
    for row in sum.get("rows").items().iter().take(30) {
        channel_rows.push_str(&format!(
            "<tr><td class=\"k\">{}</td><td>{}</td></tr>",
            escape(&row.get("text").to_js_string()),
            row.get("value").to_js_string()
        ));
    }
    let mut notable_rows = String::new();
    for star in sum.get("picked").items() {
        let stats = star
            .get("stats")
            .entries()
            .iter()
            .map(|(k, v)| escape(&stat_words(k, v.to_number())))
            .collect::<Vec<_>>()
            .join(", ");
        notable_rows.push_str(&format!(
            "<tr><td class=\"k\">{}</td><td>{}</td><td>{}</td><td style=\"white-space:normal;min-width:280px\">{}</td></tr>",
            escape(&star.get("name").to_js_string()),
            escape(&star.get("kind").to_js_string()),
            escape(&sign_name(&star.get("sector").to_js_string())),
            stats
        ));
    }
    let table = format!(
        "<div class=\"table\"><h3>What the tree gives</h3><table><thead><tr><th>Channel</th><th>Value</th></tr></thead><tbody>{channel_rows}</tbody></table></div>\n    <div class=\"table\"><h3>Notables and keystones</h3><table><thead><tr><th>Star</th><th>Kind</th><th>Sign</th><th>Stats</th></tr></thead><tbody>{}</tbody></table></div>",
        if notable_rows.is_empty() {
            "<tr><td colspan=\"4\">none</td></tr>"
        } else {
            &notable_rows
        }
    );
    let free = sum.get("freeStars").to_number();
    let free_text = if free == 0.0 || free.is_nan() {
        String::new()
    } else {
        format!(" ({} free)", n(free))
    };
    let counts = sum.get("counts");
    Section {
        title: format!(
            "{} - {}, {}/{} stars{free_text}",
            plan.get("build").get("name").to_js_string(),
            plan.get("startName").to_js_string(),
            plan.get("stars").to_js_string(),
            plan.get("starBudget").to_js_string()
        ),
        note: format!(
            "Channel plan: {} small, {} road, {} notable, {} keystone. The plan stops when no remaining star adds to this build, so the free points\nare yours. Small and road stars can be connectors to a relevant notable; they may carry\noff-build stats but are not scored. The weapons page +Firmament column is the flat channel ceiling (+15 STR/AGI/SPEED/LUCK, +15 weapon/Critical Strike, +30% blow); this is a real path, so it may leave some of those short and leave the rest free. It never walks through a keystone.",
            counts.get("small").to_js_string(),
            counts.get("road").to_js_string(),
            counts.get("notable").to_js_string(),
            counts.get("keystone").to_js_string()
        ),
        chart: format!(
            "<div style=\"font-size:12px;color:#a8a092;margin:0 0 8px\"><span style=\"color:#e0b76a\">&#9679; start</span> &nbsp; <span style=\"color:#7fae6a\">&#9679; small</span> &nbsp; <span style=\"color:#6fa8dc\">&#9679; road</span> &nbsp; <span style=\"color:#c08a3e\">&#9679; notable</span> &nbsp; <span style=\"color:#c25b4e\">&#9679; keystone</span></div>{}",
            firmament_svg(plan, 720.0)
        ),
        table,
    }
}
