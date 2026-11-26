//! The R8 report renderer, differentially against the REAL `src/report.js`.
//!
//! One `node --input-type=module` run imports `src/report.js`, builds its character and targets from `src/theory.js` and
//! `src/model.js` (synthetic fixtures only: never a save, never a game file), renders the case list below and prints its
//! answers as JSON; each is compared byte for byte with [`report::build_report`]. The cases carry HTML metacharacters in
//! the character name, race and the target group, which is where a hand-written renderer leaks markup, and one case
//! leaves the weapon hands bare so the empty captions are exercised too.
//!
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::js_batch;

#[path = "../src/graph.rs"]
#[allow(dead_code)]
mod graph;
#[path = "../src/report.rs"]
mod report;

use dfo_core::analyze::{boss_target, gate_target};
use dfo_core::spells::Spellbook;
use dfo_core::theory::{theory_character, theory_fists};
use dfo_core::value::Value::{self, Arr, Num, Str};
use serde_json::{json, Value as JsonValue};
const ORACLE: &str = r#"
import { readFileSync } from 'node:fs';
import { buildReport } from './src/report.js';
import { theoryCharacter, theoryFists } from './src/theory.js';
import { bossTarget, gateTarget } from './src/model.js';
const cases = JSON.parse(readFileSync(0, 'utf8'));
const out = cases.map((c) => {
  const ch = c.fists
    ? theoryFists({ level: 45, race: 'darkelf', gearH2H: 30, gearCrit: 10 })
    : theoryCharacter({ level: 45, race: 'darkelf', blade: 123, material: 9, gearLB: 30, gearCS: 10, damagePct: 10 });
  ch.name = c.name;
  ch.race = c.race;
  const target = c.target.kind === 'gate'
    ? gateTarget(45, { players: c.players, blowX: c.blowX })
    : bossTarget({ level: 45, armorValue: 0, health: c.health, traits: c.target.traits });
  target.group = c.group;
  return buildReport(ch, {
    target, core: c.core, traits: c.traits, health: target.maxHealth,
    swing: 'StrikeLeft', players: c.players, blowX: c.blowX, backstabUptime: c.backstabUptime,
  });
});
process.stdout.write(JSON.stringify(out));
"#;

/// One differential case: the options both sides receive, plus the Rust character edits the oracle describes.
struct Case {
    fists: bool,
    name: &'static str,
    race: &'static str,
    group: &'static str,
    target: JsonValue,
    core: &'static str,
    traits: Vec<&'static str>,
    players: f64,
    blow_x: f64,
    backstab_uptime: f64,
    health: f64,
}

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Value::Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

fn strings(values: &[&str]) -> Value {
    Arr(values.iter().map(|s| Str((*s).to_owned())).collect())
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            fists: false,
            name: "Report <a href=\"x\">& 'q'",
            race: "Dark Elf & <kin>",
            group: "daedra & <'q'>",
            target: json!({ "kind": "gate" }),
            core: "overhaul",
            traits: vec![],
            players: 1.0,
            blow_x: 1.0,
            backstab_uptime: 0.0,
            health: 0.0,
        },
        Case {
            fists: false,
            name: "Plain theory blade",
            race: "Dark Elf",
            group: "undead",
            target: json!({ "kind": "boss", "traits": ["curbing", "warded"] }),
            core: "classic",
            traits: vec!["curbing", "warded"],
            players: 1.0,
            blow_x: 2.0,
            backstab_uptime: 0.5,
            health: 5000.0,
        },
        // Bare fists: the empty weapon caption, no affix rows and the Hand-to-Hand skill channel.
        Case {
            fists: true,
            name: "Fists & <wraps>",
            race: "Dark Elf",
            group: "human",
            target: json!({ "kind": "gate" }),
            core: "overhaul",
            traits: vec![],
            players: 2.0,
            blow_x: 1.0,
            backstab_uptime: 0.0,
            health: 0.0,
        },
        // A name that spells a marker literally: the page must keep it as text, never substitute it a second time.
        Case {
            fists: false,
            name: "Literal \\u{1}NAME\\u{1} & \\u{1}TARGET\\u{1}",
            race: "Dark Elf",
            group: "undead",
            target: json!({ "kind": "boss", "traits": ["curbing"] }),
            core: "overhaul",
            traits: vec!["curbing"],
            players: 1.0,
            blow_x: 1.0,
            backstab_uptime: 0.0,
            health: 5000.0,
        },
    ]
}

fn scenario(case: &Case) -> String {
    let ch = if case.fists {
        theory_fists(&obj([
            ("level", Num(45.0)),
            ("race", Str("darkelf".to_owned())),
            ("gearH2H", Num(30.0)),
            ("gearCrit", Num(10.0)),
        ]))
    } else {
        theory_character(&obj([
            ("level", Num(45.0)),
            ("race", Str("darkelf".to_owned())),
            ("blade", Num(123.0)),
            ("material", Num(9.0)),
            ("gearLB", Num(30.0)),
            ("gearCS", Num(10.0)),
            ("damagePct", Num(10.0)),
        ]))
        .expect("the synthetic theory character builds")
    };
    let mut ch = ch;
    ch.set("name", Str(case.name.to_owned()));
    ch.set("race", Str(case.race.to_owned()));
    let target = match case.target.get("kind").and_then(JsonValue::as_str) {
        Some("gate") => gate_target(
            &Num(45.0),
            &obj([("players", Num(case.players)), ("blowX", Num(case.blow_x))]),
        ),
        _ => boss_target(&obj([
            ("level", Num(45.0)),
            ("armorValue", Num(0.0)),
            ("health", Num(case.health)),
            ("traits", strings(&case.traits)),
        ]))
        .expect("a reference boss has no stand-in body"),
    };
    let mut target = target;
    target.set("group", Str(case.group.to_owned()));
    let opts = obj([
        ("target", target.clone()),
        ("core", Str(case.core.to_owned())),
        ("traits", strings(&case.traits)),
        (
            "health",
            Num(if case.health != 0.0 {
                case.health
            } else {
                target.get("maxHealth").to_number()
            }),
        ),
        ("swing", Str("StrikeLeft".to_owned())),
        ("players", Num(case.players)),
        ("blowX", Num(case.blow_x)),
        ("backstabUptime", Num(case.backstab_uptime)),
    ]);
    report::build_report(&ch, &opts, &Spellbook::default())
}

fn oracle() -> Vec<String> {
    let calls: Vec<JsonValue> = cases()
        .iter()
        .map(|c| {
            json!({
                "fists": c.fists,
                "name": c.name,
                "race": c.race,
                "group": c.group,
                "target": c.target,
                "core": c.core,
                "traits": c.traits,
                "players": c.players,
                "blowX": c.blow_x,
                "backstabUptime": c.backstab_uptime,
                "health": c.health,
            })
        })
        .collect();
    let input = serde_json::to_vec(&calls).expect("the call list serialises");
    let out = js_batch(&["--input-type=module", "-e", ORACLE], &input);
    assert_eq!(
        out.status.code(),
        Some(0),
        "oracle: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).expect("the oracle prints a JSON string array")
}

#[test]
fn renders_the_report_page_like_the_js() {
    let js = oracle();
    let cases = cases();
    assert_eq!(cases.len(), js.len(), "the oracle answered every case");
    for (i, (case, want)) in cases.iter().zip(js).enumerate() {
        let got = scenario(case);
        // Only the footer's program name is normalised (`common::product_name`); every other byte is compared as-is.
        assert_eq!(
            common::product_name(&got),
            common::product_name(&want),
            "case {i} ({}) differs from src/report.js",
            case.name
        );
    }
}

#[test]
fn escaping_inserts_text_not_markup() {
    let case = &cases()[0];
    let html = scenario(case);
    assert!(html.contains("Report &lt;a href=&quot;x&quot;&gt;&amp; &#39;q&#39;"));
    assert!(html.contains("daedra &amp; &lt;&#39;q&#39;&gt;"));
    assert!(!html.contains("<a href=\"x\">"));
}

#[test]
fn literal_markers_survive_as_text() {
    // A name containing the literal marker text must reach the page unchanged, as the JS template literal does.
    let case = &cases()[3];
    let html = scenario(case);
    assert!(
        html.contains("Literal \\u{1}NAME\\u{1} &amp; \\u{1}TARGET\\u{1}"),
        "the literal markers were substituted again"
    );
}

#[test]
fn gate_health_and_cap_are_the_data_functions() {
    // `gateHealth(45)` is `240 * (5 + 45)` and `gateHitCap(45)` is `12 * (5 + 45)`, both from src/data.js.
    assert_eq!(report::gate_health(45.0), 12000.0);
    assert_eq!(report::gate_hit_cap(45.0), 600.0);
}
