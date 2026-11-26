//! The whole `weapons` / `skills` page of `src/cli.js:1601-1804` (R8): the level-45 weapon ceiling and its skill curves.
//!
//! Pure data in, one HTML string and one [`Value`] document out. Every number is the shared core's: the characters are
//! `dfo_core::theory::theory_character`/`theory_fists`, the gear budgets `dfo_core::maxprofile::Profiles::legal_gear` and
//! `dfo_core::gear_profile::max_single_skill`, the Firmament trees `dfo_core::real_build::apply_tree`, and every DPS is
//! `dfo_core::analyze::analyze`. This module owns only the branch's presentation: the row objects, the category
//! selection, the family and Critical Strike curves, the table markup, the captions, the page shell and the `--json`
//! document. No file I/O, no flag parsing, no clock: the caller owns the flags and the `--out` name.
//!
//! Two variants share one path: `--categories` shows the per-slot winners with the two relay sections, and the default
//! shows every row plus one `lineChart` per weapon family and the Critical Strike curve. The category table and the two
//! relay notes are built once and used by both.
//!
//! [`fmt`] is a local copy of the CLI's private helper (`src/cli.js:386`), as `imprints`, `spells_report` and `theory`
//! keep theirs, so this module and `tests/weapons.rs` compile without `main.rs`. `toLocaleString()` is
//! `dfo_core::enchant_plan::grouped_number_of`, the port's documented en-US pin.
//!
//! The JS `makeMax` never passes `--level` to its character builders, so every row and curve is the level-45 theory
//! character and `--level` only moves the reference foe and the Breach; this module reproduces that exactly.

use std::cmp::Ordering;

use dfo_core::analyze::{analyze, gate_target, reference_foe, Analysis};
use dfo_core::enchant_plan::grouped_number_of;
use dfo_core::gear_profile::max_single_skill;
use dfo_core::generated::data::{SKILLS, WEAPONS};
use dfo_core::maxprofile::Profiles;
use dfo_core::round::math_round;
use dfo_core::save::{effective_skill, proficiency_flag, weapon_skill};
use dfo_core::sockets::perfect_sockets;
use dfo_core::spells::Spellbook;
use dfo_core::theory::{theory_character, theory_fists};
use dfo_core::value::{
    number_to_string, obj_table_get, Value,
    Value::{Arr, Bool, Num, Obj, Str, Undefined},
};

use crate::graph::{
    bar_chart, line_chart, multi_graph_page, BarChart, BarSeries, LineChart, Point, Section, Series,
};

/// The one-handed templates the branch pairs with themselves (`src/cli.js:1677`).
const DUAL_TEMPLATES: [f64; 10] = [
    113.0, 114.0, 116.0, 117.0, 118.0, 119.0, 120.0, 121.0, 124.0, 127.0,
];

/// The six families the curves sweep, in the branch's order (`src/cli.js:1726-1733`). `None` is the fist shape.
const FAMILIES: [(&str, &str, &[Option<f64>]); 6] = [
    (
        "LongBlade",
        "Long blades",
        &[
            Some(118.0),
            Some(119.0),
            Some(120.0),
            Some(121.0),
            Some(122.0),
            Some(123.0),
        ],
    ),
    (
        "ShortBlade",
        "Short blades",
        &[Some(113.0), Some(114.0), Some(116.0), Some(117.0)],
    ),
    (
        "BluntWeapon",
        "Blunt weapons",
        &[Some(115.0), Some(124.0), Some(125.0), Some(126.0)],
    ),
    ("Axe", "Axes", &[Some(127.0), Some(128.0)]),
    ("HandToHand", "Hand-to-Hand", &[None]),
    (
        "Archery",
        "Bows and firearms",
        &[Some(129.0), Some(130.0), Some(560.0), Some(562.0)],
    ),
];

/// The raw skill points the family curves sweep, then the gear points from 0 to the legal single-skill maximum.
const RAW_VALUES: [f64; 11] = [
    100.0, 110.0, 120.0, 130.0, 140.0, 150.0, 160.0, 170.0, 180.0, 190.0, 200.0,
];

/// JS `(Math.round(v * 10) / 10).toFixed(1)`; `-` for a non-finite input (`src/cli.js:386`).
fn fmt(v: f64) -> String {
    if !v.is_finite() {
        return "-".to_owned();
    }
    let r = math_round(v * 10.0) / 10.0;
    if r.abs() >= 1e21 {
        number_to_string(r)
    } else if r == 0.0 {
        "0.0".to_owned()
    } else {
        format!("{r:.1}")
    }
}

/// `cell(v)` (`src/cli.js:1704`): `Number.isFinite(v) ? fmt(v) : '-'`; a `null` (an absent burst or TTK) renders `-`,
/// where `to_number()` would coerce it.
fn cell(v: Option<f64>) -> String {
    match v {
        Some(n) if n.is_finite() => fmt(n),
        _ => "-".to_owned(),
    }
}

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

/// The JS `(a, b) => b.<field> - a.<field>` comparator: a NaN difference is "equal", so the stable sort keeps order.
fn by_desc(a: f64, b: f64) -> Ordering {
    let d = b - a;
    if d < 0.0 {
        Ordering::Less
    } else if d > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// `familyOf(t)` (`src/cli.js:1608`): a template's weapon skill, or `HandToHand` for the fist shape.
fn family_of(t: Option<f64>) -> &'static str {
    t.and_then(|t| obj_table_get(WEAPONS, &Num(t)))
        .map_or("HandToHand", |w| w.skill)
}

/// The skill id a template swings with (`SKILLS[tpl.skill]`), read through the core's table.
fn skill_id_of(t: f64) -> f64 {
    weapon_skill(&Num(t)).unwrap_or(SKILLS.long_blade)
}

/// The branch's `MELEE` list (`src/cli.js:1607`): every template with a weapon skill and no ammo, in table order.
fn melee_templates() -> Vec<f64> {
    WEAPONS
        .iter()
        .filter(|(_, w)| !w.skill.is_empty() && w.ammo != Some(true))
        .map(|(id, _)| *id as f64)
        .collect()
}

/// `nameOf(t)` (`src/cli.js:1662`): the fist shape is named for its wraps, every other row for its template.
fn name_of(t: Option<f64>) -> String {
    if family_of(t) == "HandToHand" {
        "H2H (wraps)".to_owned()
    } else {
        t.and_then(|t| obj_table_get(WEAPONS, &Num(t)))
            .map_or_else(String::new, |w| w.name.to_owned())
    }
}

/// One row of the branch's `rows` (`src/cli.js:1663-1688`), typed so the table, the curves and the document agree.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub template: f64,
    pub name: String,
    pub skill: String,
    pub two_handed: bool,
    pub dual: bool,
    pub path: String,
    pub race: String,
    pub max_dps: f64,
    pub gate_dps: f64,
    pub gate_ceiling: f64,
    pub gate_ttk: Option<f64>,
    pub gate_burst: Option<f64>,
    pub per_swing: f64,
    pub aps: f64,
}

impl Row {
    /// The JS row object, keys in the literal's order; `dual` only on the dual rows (`src/cli.js:1669-1687`).
    pub fn value(&self) -> Value {
        let mut out = Obj(vec![]);
        out.set("template", Num(self.template));
        out.set("name", Str(self.name.clone()));
        out.set("skill", Str(self.skill.clone()));
        out.set("twoHanded", Bool(self.two_handed));
        if self.dual {
            out.set("dual", Bool(true));
        }
        out.set("path", Str(self.path.clone()));
        out.set("race", Str(self.race.clone()));
        out.set("maxDps", Num(self.max_dps));
        out.set("gateDps", Num(self.gate_dps));
        out.set("gateCeiling", Num(self.gate_ceiling));
        out.set("gateTtk", self.gate_ttk.map_or(Value::Null, Num));
        out.set("gateBurst", self.gate_burst.map_or(Value::Null, Num));
        out.set("perSwing", Num(self.per_swing));
        out.set("aps", Num(self.aps));
        out
    }
}

/// `SKILL_LABELS[r.skill] ?? r.skill` (`src/cli.js:1702,1705`).
fn skill_label(skill: &str) -> String {
    match skill {
        "ShortBlade" => "Short Blade".to_owned(),
        "LongBlade" => "Long Blade".to_owned(),
        "BluntWeapon" => "Blunt Weapon".to_owned(),
        "Archery" => "Archery".to_owned(),
        "HandToHand" => "Hand-to-Hand".to_owned(),
        other => other.to_owned(),
    }
}

/// `categoryOf(r)` (`src/cli.js:1691`): a dual pair first, then the fist shape, then the hand count.
fn category_of(r: &Row) -> &'static str {
    if r.dual {
        "DW"
    } else if r.skill == "HandToHand" {
        "Fists"
    } else if r.two_handed {
        "2H"
    } else {
        "1H"
    }
}

/// The `Hands` cell (`src/cli.js:1705`).
fn hands(r: &Row) -> &'static str {
    if r.dual {
        "Dual"
    } else if r.skill == "HandToHand" {
        "Fists"
    } else if r.two_handed {
        "2H"
    } else {
        "1H"
    }
}

/// The branch's `topRows` (`src/cli.js:1696-1700`): in each hand slot, the best-`maxDps` row of every weapon skill, then
/// every survivor by `maxDps`. One row per weapon type per slot, so one blade family cannot take the whole page.
pub fn category_rows(rows: &[Row]) -> Vec<Row> {
    let mut out: Vec<Row> = Vec::new();
    for slot in ["1H", "2H", "DW", "Fists"] {
        let mut list: Vec<&Row> = rows.iter().filter(|r| category_of(r) == slot).collect();
        list.sort_by(|a, b| by_desc(a.max_dps, b.max_dps));
        let mut seen: Vec<&str> = Vec::new();
        for r in list {
            if !seen.contains(&r.skill.as_str()) {
                seen.push(&r.skill);
                out.push(r.clone());
            }
        }
    }
    out.sort_by(|a, b| by_desc(a.max_dps, b.max_dps));
    out
}

/// `maxTable` (`src/cli.js:1705`): the per-hit-capped ceiling beside the relay's kill-average and the uncapped DPS.
pub fn table(rows: &[Row]) -> String {
    let body: String = rows
        .iter()
        .map(|r| {
            format!(
                "<tr><td class=\"k\">{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                r.name,
                skill_label(&r.skill),
                hands(r),
                r.path,
                cell(Some(r.max_dps)),
                cell(Some(r.gate_ceiling)),
                cell(Some(r.gate_dps)),
                cell(r.gate_burst),
                if r.gate_ttk.is_some_and(|t| t != 0.0 && !t.is_nan()) {
                    format!("{} s", cell(r.gate_ttk))
                } else {
                    "-".to_owned()
                }
            )
        })
        .collect();
    format!(
        "<table><thead><tr><th>Weapon</th><th>Type</th><th>Hands</th><th>Path</th><th>Uncapped DPS</th><th>Per-hit-capped</th><th>Boss kill-avg DPS</th><th>Boss burst 5s</th><th>Boss TTK</th></tr></thead><tbody>{body}</tbody></table>"
    )
}

/// `bossNote` (`src/cli.js:1723`): the displayed list's relay leader, then the full pool's winner.
fn boss_note(
    boss_top: &Row,
    gate_top: &Row,
    gate_health: f64,
    gate_hit_cap: f64,
    level: f64,
) -> String {
    format!(
        "<b>{}</b> leads this list at <b>{} kill-average DPS</b> through the relay's per-player allowance{}. The full pool's Breach winner is <b>{}</b> at <b>{}</b>. This is the real Firmament tree at the level-45 Breach: {} HP, a {} per-hit cap and a {} a second allowance refill; the per-hit-capped column is the ceiling before that allowance.",
        boss_top.name,
        cell(Some(boss_top.gate_dps)),
        if boss_top.gate_ttk.is_some_and(|t| t != 0.0 && !t.is_nan()) {
            format!(" ({} s TTK)", cell(boss_top.gate_ttk))
        } else {
            String::new()
        },
        gate_top.name,
        cell(Some(gate_top.gate_dps)),
        grouped_number_of(gate_health),
        number_to_string(gate_hit_cap),
        number_to_string(3.0 * (5.0 + level))
    )
}

/// `uncappedNote` (`src/cli.js:1724`): the uncapped ceiling at the same legal gear profile. `categories` adds the
/// per-slot sentence the condensed variant prints.
pub fn uncapped_note(top: &Row, categories: bool) -> String {
    format!(
        "<b>{}</b> is the {} at <b>{} DPS</b> ({}, Dunmer), using the real Firmament tree and no per-hit cap. Enchants and imprints are on the loadout page, not this table. Full health and Blademaster only: Berserker's below-half upkeep is not assumed. All rows are Dunmer; DPS cells are averages.{}",
        top.name,
        if categories {
            "best of every type"
        } else {
            "absolute uncapped ceiling"
        },
        cell(Some(top.max_dps)),
        top.path,
        if categories {
            " One row per weapon type per slot, including the Hand Wraps fist row; the table is sorted by uncapped DPS."
        } else {
            ""
        }
    )
}

/// `subtitle` (`src/cli.js:1782`): the shared profile line and the Breach's own numbers.
fn subtitle(level: f64, vampire: bool, gate_health: f64, gate_hit_cap: f64) -> String {
    format!(
        "Level {} | real Firmament tree | Dunmer | career expertise | Blademaster, no Berserker | legal gear profile (weapon skill / Critical Strike / damage per weapon) | target: level-{} tough, no per-hit cap | boss: {} HP, {} per-hit cap{}",
        number_to_string(level),
        number_to_string(level),
        grouped_number_of(gate_health),
        number_to_string(gate_hit_cap),
        if vampire { " | vampire +30 CS" } else { "" }
    )
}

/// The branch's flags, as the caller resolved them.
#[derive(Debug, Clone)]
pub struct Input {
    /// `n(values.level, THEORY_LEVEL)`: the reference foe's and the Breach's level, never the character's.
    pub level: f64,
    /// `!!values.firmament`.
    pub firmament: bool,
    pub vampire: bool,
    /// `values.race` lower-cased; `None` leaves every row and curve on the branch's Dunmer.
    pub race: Option<String>,
    /// `--categories`: the per-slot winners instead of the whole list, and no family curves.
    pub categories: bool,
    /// `values['game-build'] ?? DEFAULT_GAME_BUILD`: the shipped build every card and frontier this page prices is read at.
    pub game_build: String,
}

/// The two outputs: the page the JS writes and the `--json` document it prints (which is built in both modes, because
/// the JS computes `cs` before it prints either).
#[derive(Debug, Clone)]
pub struct Rendered {
    pub page: String,
    pub document: Value,
}

/// The `makeMax` options (`src/cli.js:1616-1651`): `None` is the JS default (the legal maximum / the branch's raw).
/// `vampire` is the branch's closed-over `values.vampire`, not a per-chart option.
#[derive(Debug, Clone)]
struct MakeOpts {
    race: String,
    firmament: bool,
    vampire: bool,
    raw: f64,
    gear: Option<f64>,
    crit_gear: Option<f64>,
    /// The page's `--game-build`: the legal split the character wears is picked at it.
    game_build: String,
}

impl MakeOpts {
    /// `makeMax`'s defaults. The branch's `rows` and dual pairs hardcode `firmament: false`; only the family curves pass
    /// `firmCharts`, so a `--firmament` row is the same row.
    fn base(input: &Input, firmament: bool) -> Self {
        Self {
            race: input.race.as_deref().unwrap_or("darkelf").to_owned(),
            firmament,
            vampire: input.vampire,
            raw: 200.0,
            gear: None,
            crit_gear: None,
            game_build: input.game_build.clone(),
        }
    }
}

/// The four Firmament star channels a `--firmament` chart carries (`src/cli.js:1621,1633`).
fn star_stats(firmament: bool) -> Value {
    if firmament {
        obj([
            ("strength", Num(15.0)),
            ("agility", Num(15.0)),
            ("speed", Num(15.0)),
            ("luck", Num(15.0)),
        ])
    } else {
        Obj(vec![])
    }
}

/// The three skill channels a `--firmament` chart carries, per weapon skill.
fn star_skills(firmament: bool, skill_id: f64) -> Value {
    if firmament {
        let mut out = Obj(vec![]);
        out.set(&Num(skill_id).to_js_string(), Num(15.0));
        out.set(&Num(SKILLS.critical_strike).to_js_string(), Num(15.0));
        out.set(&Num(SKILLS.backstabbing).to_js_string(), Num(15.0));
        out
    } else {
        Obj(vec![])
    }
}

/// `makeMax` (`src/cli.js:1616-1651`): the level-45 theory character for one template, at its legal gear profile with
/// the requested overrides. The JS never passes `--level` here, so neither does this.
fn make_max(profiles: &mut Profiles, t: Option<f64>, o: &MakeOpts) -> Result<Value, String> {
    let family = family_of(t);
    let legal_template = if family == "HandToHand" {
        t.unwrap_or(563.0)
    } else {
        t.unwrap_or(123.0)
    };
    // The legal budget is picked at the page's build: under 14631 the flat add makes weapon-skill points beat Critical
    // Strike, so `legalGear` can return a different split (measured 250/370/25% -> 350/252/38% on 118).
    let legal = profiles.legal_gear(
        &Num(legal_template),
        &obj([("gameBuild", Str(o.game_build.clone()))]),
    )?;
    let legal_lb = legal.get("lb").to_number();
    let legal_cs = legal.get("cs").to_number();
    let legal_dmg = legal.get("dmg").to_number();

    if family == "HandToHand" {
        let mut ch = theory_fists(&obj([
            ("race", Str(o.race.clone())),
            ("rawH2H", Num(o.raw)),
            ("gearH2H", Num(o.gear.unwrap_or(legal_lb))),
            ("gearCrit", Num(o.crit_gear.unwrap_or(legal_cs))),
            ("starStats", star_stats(o.firmament)),
            ("starSkills", star_skills(o.firmament, SKILLS.hand_to_hand)),
            ("starDamage", Num(if o.firmament { 30.0 } else { 0.0 })),
            ("vampire", Bool(o.vampire)),
            ("wraps", Bool(true)),
        ]));
        // `ch.martialPath = martial` and the branch's own name.
        ch.set("martialPath", Str("blademaster".to_owned()));
        ch.set("name", Str("Level 45 Hand-to-Hand".to_owned()));
        return Ok(ch);
    }

    let template = t.ok_or_else(|| "a weapon curve needs a template".to_owned())?;
    let tpl = obj_table_get(WEAPONS, &Num(template))
        .ok_or_else(|| format!("unknown weapon template {template}"))?;
    let skill_id = skill_id_of(template);
    let mut ch = theory_character(&obj([
        ("blade", Num(template)),
        ("race", Str(o.race.clone())),
        ("gearLB", Num(0.0)),
        ("gearCS", Num(0.0)),
        ("damagePct", Num(legal_dmg)),
        ("vampire", Bool(o.vampire)),
        ("starStats", star_stats(o.firmament)),
        ("starSkills", star_skills(o.firmament, skill_id)),
        ("starDamage", Num(if o.firmament { 30.0 } else { 0.0 })),
        ("sockets", Arr(perfect_sockets(&Num(template)))),
        ("martialPath", Str("blademaster".to_owned())),
    ]))?;
    // `ch.career = { ...(ch.career ?? {}), weaponArmorShieldsBitfield: (PROF_OF[tpl.skill] ?? 0) << 16 }`.
    let prof = proficiency_flag(&Num(skill_id)).unwrap_or(0.0);
    let mut career = ch.get("career").clone();
    career.set("weaponArmorShieldsBitfield", Num(prof * 65536.0));
    ch.set("career", career);
    // `ch.skills[skillId] = raw`: the character builder never wrote the other weapon skills, so extend to reach it.
    let mut skills = ch.get("skills").clone();
    if let Arr(items) = &mut skills {
        let index = skill_id as usize;
        if items.len() <= index {
            items.resize(index + 1, Num(100.0));
        }
        items[index] = Num(o.raw);
    }
    ch.set("skills", skills);
    ch.set(
        "masteredSkills",
        Arr(vec![
            Num(skill_id),
            Num(SKILLS.critical_strike),
            Num(SKILLS.backstabbing),
        ]),
    );
    let mut mods = ch.get("_mods").clone();
    let mut mod_skills = mods.get("skills").clone();
    let gap = if o.firmament { 15.0 } else { 0.0 };
    mod_skills.set(
        &Num(skill_id).to_js_string(),
        Num(o.gear.unwrap_or(legal_lb) + gap),
    );
    mod_skills.set(
        &Num(SKILLS.critical_strike).to_js_string(),
        Num(o.crit_gear.unwrap_or(legal_cs) + gap),
    );
    mods.set("skills", mod_skills);
    ch.set("_mods", mods);
    ch.set("_pair", Bool(template == 562.0));
    ch.set("name", Str(format!("Level 45 {}", tpl.name)));
    Ok(ch)
}

/// `makeDual` (`src/cli.js:1653-1658`): the same character with a second hand carrying the weapon.
fn make_dual(profiles: &mut Profiles, t: f64, o: &MakeOpts) -> Result<Value, String> {
    let mut ch = make_max(profiles, Some(t), o)?;
    let mut off = ch.get("weapon").clone();
    off.set("equipSlot", Num(21.0));
    ch.set("offWeapon", off);
    ch.set("_dual", Bool(true));
    Ok(ch)
}

/// `maxRun` (`src/cli.js:1611`): the uncapped reference target, the branch's own scenario. `game_build` is the
/// page's `--game-build` (the 14631 gear law moves every row and curve).
fn run_max(ch: &Value, target: &Value, game_build: &str, book: &Spellbook) -> Analysis {
    analyze(
        ch,
        &obj([
            ("target", target.clone()),
            ("core", Str("overhaul".to_owned())),
            ("rri", Bool(true)),
            ("healthShare", Num(1.0)),
            ("passiveOn", Bool(true)),
            ("stacks", Num(5.0)),
            ("pair", Bool(ch.get("_pair").truthy())),
            ("dual", Bool(ch.get("_dual").truthy())),
            ("gameBuild", Str(game_build.to_owned())),
        ]),
        book,
    )
}

/// `gateRun` (`src/cli.js:1612`): the Breach, with its own health.
fn run_gate(ch: &Value, gate: &Value, game_build: &str, book: &Spellbook) -> Analysis {
    analyze(
        ch,
        &obj([
            ("target", gate.clone()),
            ("core", Str("overhaul".to_owned())),
            ("rri", Bool(true)),
            ("health", gate.get("maxHealth").clone()),
            ("healthShare", Num(1.0)),
            ("passiveOn", Bool(true)),
            ("stacks", Num(5.0)),
            ("pair", Bool(ch.get("_pair").truthy())),
            ("dual", Bool(ch.get("_dual").truthy())),
            ("gameBuild", Str(game_build.to_owned())),
        ]),
        book,
    )
}

/// `g.allowance?.averageDps ?? g.cappedDps`: a present allowance with a nullish average falls back to the ceiling.
fn gate_dps(g: &Analysis) -> f64 {
    g.allowance
        .as_ref()
        .and_then(|a| {
            let v = a.get("averageDps");
            (!v.is_nullish()).then(|| v.to_number())
        })
        .unwrap_or(g.capped_dps)
}

/// One row from a character and its two runs (`src/cli.js:1669-1673,1683-1686`).
fn row_of(template: f64, name: String, dual: bool, race: &str, r: &Analysis, g: &Analysis) -> Row {
    Row {
        template,
        name,
        skill: family_of(Some(template)).to_owned(),
        two_handed: if family_of(Some(template)) == "HandToHand" {
            false
        } else {
            obj_table_get(WEAPONS, &Num(template)).is_some_and(|w| w.two_handed)
        },
        dual,
        path: "blademaster".to_owned(),
        race: race.to_owned(),
        max_dps: r.dps,
        gate_dps: gate_dps(g),
        gate_ceiling: g.capped_dps,
        gate_ttk: g.ttk,
        gate_burst: g.allowance.as_ref().and_then(|a| {
            let v = a.get("burst5Dps");
            (!v.is_nullish()).then(|| v.to_number())
        }),
        per_swing: r.per_swing,
        aps: r.cadence.get("aps").to_number(),
    }
}

/// The branch's whole `rows` list (`src/cli.js:1663-1689`): every melee template, then the dual pairs, both by
/// uncapped DPS. The final sort is stable over the melee list first, as the JS's two sorts are.
fn rows(
    input: &Input,
    profiles: &mut Profiles,
    max_target: &Value,
    gate: &Value,
    book: &Spellbook,
) -> Result<Vec<Row>, String> {
    let race = input.race.as_deref().unwrap_or("darkelf");
    let mut out: Vec<Row> = Vec::new();
    for t in melee_templates() {
        let ch = make_max(profiles, Some(t), &MakeOpts::base(input, false))?;
        let tree = dfo_core::real_build::apply_tree(&ch, family_of(Some(t)));
        let r = run_max(&tree, max_target, &input.game_build, book);
        let g = run_gate(&tree, gate, &input.game_build, book);
        out.push(row_of(t, name_of(Some(t)), false, race, &r, &g));
    }
    out.sort_by(|a, b| by_desc(a.max_dps, b.max_dps));
    for t in DUAL_TEMPLATES {
        let ch = make_dual(profiles, t, &MakeOpts::base(input, false))?;
        let tree = dfo_core::real_build::apply_tree(&ch, family_of(Some(t)));
        let r = run_max(&tree, max_target, &input.game_build, book);
        let g = run_gate(&tree, gate, &input.game_build, book);
        let name = format!("Dual {}", name_of(Some(t)));
        out.push(row_of(t, name, true, race, &r, &g));
    }
    out.sort_by(|a, b| by_desc(a.max_dps, b.max_dps));
    Ok(out)
}

/// `gearVals` (`src/cli.js:1740-1742`): 30, 60, ... below the legal single-skill maximum, then the maximum itself.
fn gear_values(max: f64) -> Vec<f64> {
    let mut out = Vec::new();
    let mut v = 30.0;
    while v < max {
        out.push(v);
        v += 30.0;
    }
    out.push(max);
    out
}

/// One family's `lineChart` section (`src/cli.js:1735-1761`).
fn family_section(
    input: &Input,
    profiles: &mut Profiles,
    family: &(&str, &str, &[Option<f64>]),
    max_target: &Value,
    book: &Spellbook,
) -> Result<Section, String> {
    let (key, title, templates) = *family;
    // `f.key === 'HandToHand' ? 563 : (f.templates.find((t) => t != null) ?? 123)`.
    let chart_template = if key == "HandToHand" {
        563.0
    } else {
        templates.iter().flatten().next().copied().unwrap_or(123.0)
    };
    let gear_max = max_single_skill(&obj([("weaponTemplate", Num(chart_template))]));
    let culprit = profiles.legal_gear(
        &Num(chart_template),
        &obj([("gameBuild", Str(input.game_build.clone()))]),
    )?;
    let race = input.race.as_deref().unwrap_or("darkelf");
    let gear_vals = gear_values(gear_max);

    let mut series = Vec::new();
    for t in templates {
        let mut points = Vec::new();
        for &v in &RAW_VALUES {
            let ch = make_max(
                profiles,
                *t,
                &MakeOpts {
                    race: race.to_owned(),
                    firmament: input.firmament,
                    vampire: input.vampire,
                    raw: v,
                    gear: Some(0.0),
                    crit_gear: None,
                    game_build: input.game_build.clone(),
                },
            )?;
            points.push(Point {
                x: effective_skill(&Num(v)),
                y: run_max(&ch, max_target, &input.game_build, book).dps,
            });
        }
        for &v in &gear_vals {
            let ch = make_max(
                profiles,
                *t,
                &MakeOpts {
                    race: race.to_owned(),
                    firmament: input.firmament,
                    vampire: input.vampire,
                    raw: 200.0,
                    gear: Some(v),
                    crit_gear: None,
                    game_build: input.game_build.clone(),
                },
            )?;
            points.push(Point {
                x: 140.0 + v,
                y: run_max(&ch, max_target, &input.game_build, book).dps,
            });
        }
        series.push(Series {
            name: name_of(*t),
            points,
        });
    }

    let ranged_note = if key == "Archery" {
        " Bows use the paced BOW_FAST window; the Pistolet is a pair."
    } else {
        ""
    };
    let note = format!(
        "One line per weapon: raw training 100 -> 200 is effective 100 -> 140; gear lines continue from effective 140 to {} (the legal single-skill maximum: every other slot carries the build's legal share). Max legal gear, Dunmer, career expertise, best path, {}% damage line, sockets, no per-hit cap. The table uses the real Firmament tree; these curves are the flat skill-scaling view.{}{}{}",
        number_to_string(140.0 + gear_max),
        number_to_string(culprit.get("dmg").to_number()),
        if key == "Axe" || key == "HandToHand" {
            " Blademaster, full health; no Berserker below-half assumption."
        } else {
            ""
        },
        if input.firmament {
            " Firmament channels on."
        } else {
            ""
        },
        ranged_note
    );
    Ok(Section {
        title: title.to_owned(),
        note,
        chart: line_chart(&LineChart::new(
            format!("{title}: effective skill"),
            "Effective weapon skill",
            "DPS",
            series,
        )),
        table: String::new(),
    })
}

/// `csMaxFor(t)` (`src/cli.js:1764`): the legal Critical Strike single-skill maximum for a template.
fn cs_max_for(t: f64) -> f64 {
    max_single_skill(&obj([
        ("weaponTemplate", Num(t)),
        ("skill", Num(SKILLS.critical_strike)),
    ]))
}

/// The Critical Strike curve (`src/cli.js:1763-1780`) and its series document.
fn cs_section(
    input: &Input,
    profiles: &mut Profiles,
    rows: &[Row],
    max_target: &Value,
    book: &Spellbook,
) -> Result<(Section, Value), String> {
    // `topPerFamily`: the first (highest-`maxDps`) non-dual row of each family, in the families' order.
    let top_per_family: Vec<Row> = FAMILIES
        .iter()
        .filter_map(|(key, _, _)| {
            rows.iter()
                .find(|r| !r.dual && family_of(Some(r.template)) == *key)
                .cloned()
        })
        .collect();
    let mut series = Vec::new();
    let mut document = Vec::new();
    for row in &top_per_family {
        let top = cs_max_for(row.template);
        let mut values = Vec::new();
        let mut v = 0.0;
        while v < top {
            values.push(v);
            v += 60.0;
        }
        values.push(top);
        let mut points = Vec::new();
        for &v in &values {
            let ch = make_max(
                profiles,
                Some(row.template),
                &MakeOpts {
                    race: row.race.clone(),
                    firmament: input.firmament,
                    vampire: input.vampire,
                    raw: 200.0,
                    gear: None,
                    crit_gear: Some(v),
                    game_build: input.game_build.clone(),
                },
            )?;
            points.push(Point {
                x: v,
                y: run_max(&ch, max_target, &input.game_build, book).dps,
            });
        }
        series.push(Series {
            name: row.name.clone(),
            points: points.clone(),
        });
        document.push(obj([
            ("name", Str(row.name.clone())),
            (
                "points",
                Arr(points
                    .iter()
                    .map(|p| obj([("x", Num(p.x)), ("y", Num(p.y))]))
                    .collect()),
            ),
        ]));
    }
    let cs_cap = top_per_family
        .iter()
        .map(|row| cs_max_for(row.template))
        .fold(0.0, f64::max);
    let section = Section {
        title: "Critical Strike scales every weapon".to_owned(),
        note: format!(
            "The best weapon of each family, raw 200 and its legal weapon-skill share, with Critical Strike gear from 0 to {} (the legal single-skill maximum). Critical Strike is the shared multiplier: chance caps at 100%, then every point adds 0.01 to the multiplier.",
            number_to_string(cs_cap)
        ),
        chart: line_chart(&LineChart::new(
            format!("Critical Strike gear 0 -> {}", number_to_string(cs_cap)),
            "Critical Strike gear points",
            "DPS",
            series,
        )),
        table: String::new(),
    };
    Ok((section, Arr(document)))
}

/// The two relay sections both variants share (`src/cli.js:1712-1724,1787-1793`).
fn relay_sections(
    display: &[Row],
    pool: &[Row],
    level: f64,
    gate_health: f64,
    gate_hit_cap: f64,
    categories: bool,
) -> Vec<Section> {
    let mut boss_rows = display.to_vec();
    boss_rows.sort_by(|a, b| by_desc(a.gate_dps, b.gate_dps));
    let mut uncapped_rows = display.to_vec();
    uncapped_rows.sort_by(|a, b| by_desc(a.max_dps, b.max_dps));

    let boss_bar = bar_chart(&BarChart::new(
        "Breach kill-average DPS by weapon - level-45, through the relay allowance",
        boss_rows.iter().map(|r| r.name.clone()).collect(),
        vec![BarSeries {
            name: "Kill-average".to_owned(),
            values: boss_rows.iter().map(|r| r.gate_dps).collect(),
        }],
    ));
    let uncapped_bar = bar_chart(&BarChart::new(
        "Uncapped DPS by weapon - no per-hit cap",
        uncapped_rows.iter().map(|r| r.name.clone()).collect(),
        vec![BarSeries {
            name: "Firmament".to_owned(),
            values: uncapped_rows.iter().map(|r| r.max_dps).collect(),
        }],
    ));

    // `gateTop` reads the FULL pool under the JS's STABLE sort, so a tie keeps the earlier row; `max_by` would keep
    // the last, and every short blade ties here because the relay allowance caps them together.
    let mut pool_by_gate = pool.to_vec();
    pool_by_gate.sort_by(|a, b| by_desc(a.gate_dps, b.gate_dps));
    let gate_top = pool_by_gate
        .into_iter()
        .next()
        .expect("the branch always carries its weapon rows");
    let top = uncapped_rows
        .first()
        .cloned()
        .expect("the page always carries a row");
    vec![
        Section {
            title: "Breach DPS through the relay allowance - level-45".to_owned(),
            note: boss_note(&boss_rows[0], &gate_top, gate_health, gate_hit_cap, level),
            chart: boss_bar,
            table: String::new(),
        },
        Section {
            title: "Uncapped DPS".to_owned(),
            note: uncapped_note(&top, categories),
            chart: uncapped_bar,
            table: table(&uncapped_rows),
        },
    ]
}

/// `weapons`/`skills` (`src/cli.js:1601-1804`): the whole page and its `--json` document.
pub fn render(input: &Input, book: &Spellbook) -> Result<Rendered, String> {
    let max_target = reference_foe(&Num(input.level), &Str("tough".to_owned()));
    let gate = gate_target(&Num(input.level), &Undefined);
    let gate_health = gate.get("maxHealth").to_number();
    let gate_hit_cap = gate.get("hitCap").to_number();
    let mut profiles = Profiles::new(book);

    let pool = rows(input, &mut profiles, &max_target, &gate, book)?;
    let display = if input.categories {
        category_rows(&pool)
    } else {
        pool.clone()
    };

    let (cs_section, cs_document) = cs_section(input, &mut profiles, &pool, &max_target, book)?;

    let mut sections = relay_sections(
        &display,
        &pool,
        input.level,
        gate_health,
        gate_hit_cap,
        input.categories,
    );
    if !input.categories {
        for family in &FAMILIES {
            sections.push(family_section(
                input,
                &mut profiles,
                family,
                &max_target,
                book,
            )?);
        }
        sections.push(cs_section);
    }
    let page = multi_graph_page(
        "DFO weapon ceiling and skill scaling",
        &subtitle(input.level, input.vampire, gate_health, gate_hit_cap),
        &sections,
    );

    let document = obj([
        ("level", Num(input.level)),
        ("firmCharts", Bool(input.firmament)),
        ("rows", Arr(display.iter().map(Row::value).collect())),
        ("cs", cs_document),
    ]);
    Ok(Rendered { page, document })
}
