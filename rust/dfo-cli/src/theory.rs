//! The whole `theory` card of `src/cli.js:1806-2054` (R8): the header table, the five push stages, the cap sheet,
//! the attribute/skill curves, the three Firmament tables, the legal gear frontier, the long-blade table, the result
//! card and the `--json` document.
//!
//! Pure data in, one string / one [`Value`] out: every character is `dfo_core::theory::theory_character`'s, every DPS
//! number is the shared `dfo_core::analyze::analyze`, the gear budgets are `dfo_core::maxprofile::Profiles`, and the cap
//! sheet is the generated `THEORY_CAPS`. This module owns only the branch's presentation: the JS `fmt`/`fmt2`/`pc`/
//! `table` helpers, the stage list, the curve sweeps, the captions and the JSON shapes. No file I/O, no flag parsing, no
//! clock: the caller resolves the character, the target and the base scenario.
//!
//! The JS branch prints two warnings to stderr before the card (the obsolete `--gear-lines`/`--line-points` note and
//! the `>38%` damage warning). Both are the caller's to emit; the flag table accepts the obsolete pair for `theory` and
//! refuses it elsewhere.
//!
//! Unported variant, explicit: the JS branch crashes (`TypeError: Cannot read properties of null (reading
//! 'toLocaleString')`) on a reference-foe target, because a non-boss card has no `health` to print. This port refuses
//! such a target with a usage error before writing anything, rather than reproducing a crash.
//!
//! [`fmt`], [`fmt2`], [`pc`], [`table`] and [`crate::allowance_rows`] are local copies of the CLI's private helpers
//! (`src/cli.js:386-399,729-737`), as the other card modules keep theirs, so this module and `tests/theory.rs` compile
//! without `main.rs`.

use dfo_core::analyze::analyze;
use dfo_core::enchant_plan::grouped_number_of;
use dfo_core::gear_profile::{max_point_total, max_single_skill};
use dfo_core::generated::data::{RACE_NAMES, WEAPONS};
use dfo_core::generated::gear_profile::AFFIX_DAMAGE_TOP;
use dfo_core::generated::theory::{GEAR_MASTERY_POINTS, LONG_BLADES};
use dfo_core::maxprofile::Profiles;
use dfo_core::round::math_round;
use dfo_core::save::{live_stat, skill_value};
use dfo_core::sockets::perfect_sockets;
use dfo_core::spells::Spellbook;
use dfo_core::theory::{gear_mastery_points, theory_blade, theory_caps, theory_character};
use dfo_core::value::{
    number_to_string, obj_table_get, Value,
    Value::{Arr, Bool, Null, Num, Obj, Str, Undefined},
};

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

/// JS `(Math.round(v * 100) / 100).toFixed(2)`; `-` for a non-finite input (`src/cli.js:387`).
fn fmt2(v: f64) -> String {
    if !v.is_finite() {
        return "-".to_owned();
    }
    let r = math_round(v * 100.0) / 100.0;
    if r.abs() >= 1e21 {
        number_to_string(r)
    } else if r == 0.0 {
        "0.00".to_owned()
    } else {
        format!("{r:.2}")
    }
}

/// JS `` `${Math.round(v * 100)}%` ``; `-` for a non-finite input (`src/cli.js:388`).
fn pc(v: f64) -> String {
    if !v.is_finite() {
        return "-".to_owned();
    }
    format!("{}%", number_to_string(math_round(v * 100.0)))
}

/// `String.prototype.length` in UTF-16 code units.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.padStart(width)` / `s.padEnd(width)` (`src/cli.js:394`).
fn pad(s: &str, width: usize, right: bool) -> String {
    let fill = width.saturating_sub(utf16_len(s));
    if right {
        format!("{}{s}", " ".repeat(fill))
    } else {
        format!("{s}{}", " ".repeat(fill))
    }
}

/// `table(rows, headers, aligns)` (`src/cli.js:390-399`): the terminal table, including the rule under the headers.
/// The JS widths are one per header (`Math.max(h.length, ...rows.map((r) => r[i]))`), so a row wider than the headers
/// keeps its extra cells un-padded, exactly as `padEnd(undefined)` leaves them.
fn table(rows: &[Vec<String>], headers: &[&str], aligns: &[bool]) -> String {
    let mut widths: Vec<usize> = headers.iter().map(|h| utf16_len(h)).collect();
    for row in rows {
        for (i, c) in row.iter().enumerate() {
            if i < widths.len() {
                widths[i] = widths[i].max(utf16_len(c));
            }
        }
    }
    let line = |cells: &[String]| {
        cells
            .iter()
            .enumerate()
            .map(|(i, c)| {
                pad(
                    c,
                    widths.get(i).copied().unwrap_or(0),
                    aligns.get(i).copied().unwrap_or(false),
                )
            })
            .collect::<Vec<_>>()
            .join("  ")
            .trim_end()
            .to_owned()
    };
    let header: Vec<String> = headers.iter().map(|h| (*h).to_owned()).collect();
    let mut out = vec![
        line(&header),
        line(
            &headers
                .iter()
                .map(|h| "-".repeat(utf16_len(h)))
                .collect::<Vec<_>>(),
        ),
    ];
    out.extend(rows.iter().map(|r| line(r)));
    out.join("\n")
}

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

fn n(v: f64) -> String {
    number_to_string(v)
}

/// `x ? `${fmt(x)} s` : '-'`: a null/zero/NaN ttk prints `-` (`src/cli.js:1945`).
fn ttk_text(ttk: Option<f64>) -> String {
    match ttk {
        Some(t) if t != 0.0 && !t.is_nan() => format!("{} s", fmt(t)),
        _ => "-".to_owned(),
    }
}

/// `allowanceRows` (`src/cli.js:729-737`), copied from the build card's helper by the same name.
fn allowance_rows(a: &Value) -> Vec<Vec<String>> {
    let law = a.get("law");
    let dry = a.get("dryAt");
    vec![
        vec![
            "Allowance-sustained DPS".to_owned(),
            fmt(a.get("sustainedDps").to_number()),
            format!(
                "the allowance's refill {}/s{}",
                fmt(law.get("rate").to_number()),
                if a.get("saturated").truthy() {
                    " - this build exceeds it, so it is the limit"
                } else {
                    " - this build is below it"
                }
            ),
        ],
        vec![
            "Opening burst".to_owned(),
            fmt(a.get("burst5Dps").to_number()),
            format!(
                "first 5 s: the {} bucket plus refill{}",
                fmt(law.get("depth").to_number()),
                if dry.is_nullish() {
                    "; never spent".to_owned()
                } else {
                    format!("; spent after {} s", fmt(dry.to_number()))
                }
            ),
        ],
        vec![
            "Kill-average DPS".to_owned(),
            if a.get("averageDps").truthy() {
                fmt(a.get("averageDps").to_number())
            } else {
                "-".to_owned()
            },
            format!(
                "{} HP share over the whole fight, shields included",
                fmt(a.get("share").to_number())
            ),
        ],
        vec![
            "Allowance kept".to_owned(),
            pc(a.get("landedShare").to_number()),
            "of the claims that won a blow token, the part the relay accepted".to_owned(),
        ],
    ]
}

/// The branch's `--gear-*` / `--damage-pct` overrides: `None` is the JS default (the legal maximum).
#[derive(Debug, Clone, Default)]
pub struct GearFlags {
    pub lb: Option<f64>,
    pub cs: Option<f64>,
    pub damage_pct: Option<f64>,
    /// `--star-damage`, else the branch's `--firmament ? 30 : 0`.
    pub star_damage: f64,
}

/// The resolved `make` base of `src/cli.js:1823-1829`.
#[derive(Debug, Clone)]
pub struct Input {
    pub level: f64,
    /// The race id or name the theory builder resolves (`values.race ?? 'darkelf'`).
    pub race: String,
    pub blade: f64,
    pub material: f64,
    pub star_stats: Vec<(String, f64)>,
    pub star_skills: Vec<(String, f64)>,
    pub vampire: bool,
    pub gear: GearFlags,
    /// The JS `targetName`: the typed `--target`, remapped to `gate` for the theory `armoured`.
    pub target_name: String,
    /// `!values['no-rri']`.
    pub rri: bool,
    /// `values['game-build'] ?? '14512'` (`src/cli.js:1918,1963,1971,1998,2063`): the cap sheet and the
    /// formula-cap row follow it. The scenario carries it too, so the numbers do.
    pub game_build: String,
}

/// The resolved `maxLb` / `maxCs` / `damage` the card prints and the stages read.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Gear {
    pub lb: f64,
    pub cs: f64,
    pub damage: f64,
}

/// One `make(...)` call (`src/cli.js:1824-1829`): the base options, then these fields spread over them.
#[derive(Debug, Clone)]
struct Make {
    raw: f64,
    gear: Gear,
    vampire: bool,
    empty_sockets: bool,
    star_stats: Vec<(String, f64)>,
    star_skills: Vec<(String, f64)>,
    star_damage: f64,
}

/// `{ ...base, [k]: v }` for the string-keyed star maps: an existing key keeps its position.
fn merge(base: &[(String, f64)], key: &str, value: f64) -> Vec<(String, f64)> {
    let mut out = base.to_vec();
    match out.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = value,
        None => out.push((key.to_owned(), value)),
    }
    out
}

fn star_map(pairs: &[(String, f64)]) -> Value {
    let mut out = Obj(vec![]);
    for (k, v) in pairs {
        out.set(k, Num(*v));
    }
    out
}

fn star_value(pairs: &[(String, f64)], key: &str) -> f64 {
    pairs
        .iter()
        .find(|(k, _)| k == key)
        .map_or(0.0, |(_, v)| *v)
}

/// The theory character a run reads (`make`, `src/cli.js:1824-1829`).
fn make(input: &Input, m: &Make) -> Result<Value, String> {
    let sockets = if m.empty_sockets {
        Arr(vec![])
    } else {
        Arr(perfect_sockets(&Num(input.blade)))
    };
    theory_character(&obj([
        ("level", Num(input.level)),
        ("race", Str(input.race.clone())),
        ("blade", Num(input.blade)),
        ("material", Num(input.material)),
        ("rawBlade", Num(m.raw)),
        ("rawCrit", Num(m.raw)),
        ("rawBackstab", Num(m.raw)),
        ("gearLB", Num(m.gear.lb)),
        ("gearCS", Num(m.gear.cs)),
        ("damagePct", Num(m.gear.damage)),
        ("vampire", Bool(m.vampire)),
        ("starStats", star_map(&m.star_stats)),
        ("starSkills", star_map(&m.star_skills)),
        ("starDamage", Num(m.star_damage)),
        ("sockets", sockets),
        ("martialPath", Str("blademaster".to_owned())),
    ]))
}

/// `run(c)` and `behind(c)` (`src/cli.js:1830-1832`): the caller's scenario with the character's own
/// `firmamentDamagePct`, and a second run whose `backstabUptime` is 1.
fn run(ch: &Value, base: &Value, book: &Spellbook, backstab: bool) -> dfo_core::analyze::Analysis {
    let mut sc = base.clone();
    sc.set("firmamentDamagePct", ch.get("firmamentDamagePct").clone());
    if backstab {
        sc.set("backstabUptime", Num(1.0));
    }
    analyze(ch, &sc, book)
}

/// One `stages` entry (`src/cli.js:1849-1860`), without the character and analysis the JS also keeps.
#[derive(Debug, Clone)]
struct Stage {
    label: &'static str,
    raw: f64,
    gear: Gear,
    vampire: bool,
    /// `Some([])` is the JS `sockets: []`; `None` is a stage that never set the key.
    sockets: Option<Value>,
    dps: f64,
    dps_min: f64,
    dps_max: f64,
    capped_dps: f64,
    capped_min: f64,
    capped_max: f64,
    behind: f64,
    behind_min: f64,
    behind_max: f64,
    per_swing: f64,
    aps: f64,
    ttk: Option<f64>,
}

/// One evaluated frontier point (`src/cli.js:1836-1840`).
#[derive(Debug, Clone)]
struct Split {
    lb: f64,
    cs: f64,
    dmg: f64,
    total: f64,
    dps: f64,
    capped_dps: f64,
    per_swing: f64,
    ttk: Option<f64>,
}

/// One row of the attribute curve (`src/cli.js:1863-1877`).
#[derive(Debug, Clone)]
struct StatRow {
    stat: &'static str,
    d50: f64,
    d75: f64,
    d100: f64,
    capped100: f64,
    delta: f64,
    last10: f64,
}

/// One row of the skill and gear curve (`src/cli.js:1879-1904`).
#[derive(Debug, Clone)]
struct SkillRow {
    label: &'static str,
    value: f64,
    dps: f64,
    capped_dps: f64,
    behind: f64,
    per_swing: f64,
    ttk: Option<f64>,
}

/// One Firmament attribute channel (`src/cli.js:1961-1965`): the four cells' DPS and capped DPS, and the live +15.
#[derive(Debug, Clone)]
struct FirmStatRow {
    channel: &'static str,
    cells: Vec<(f64, f64)>,
    live: f64,
}

/// One Firmament skill channel (`src/cli.js:1966-1974`): DPS and capped cells plus the +15 sheet/formula values.
#[derive(Debug, Clone)]
struct FirmSkillRow {
    name: &'static str,
    dps: Vec<f64>,
    capped: Vec<f64>,
    sheet: f64,
    formula: f64,
}

/// One row of the long-blade table (`src/cli.js:1906-1911`).
#[derive(Debug, Clone)]
struct BladeRow {
    template: f64,
    name: String,
    two_handed: bool,
    dps: f64,
    dps_min: f64,
    dps_max: f64,
    capped_dps: f64,
    capped_min: f64,
    capped_max: f64,
    per_swing: f64,
    aps: f64,
    damage: f64,
    cap_loss: f64,
    ttk: Option<f64>,
}

/// Everything the two outputs share: the computed rows and the card the JS keeps beside them.
struct Computed {
    input: Input,
    race_name: String,
    blade_name: String,
    online: bool,
    legal: Value,
    gear: Gear,
    lb_cap: f64,
    cs_cap: f64,
    explicit_gear: bool,
    card: Value,
    max_ch: Value,
    max_behind: Value,
    stages: Vec<Stage>,
    stats: Vec<StatRow>,
    skills: Vec<SkillRow>,
    firm_stats: Vec<FirmStatRow>,
    firm_skills: Vec<FirmSkillRow>,
    firm_damage: Vec<dfo_core::analyze::Analysis>,
    splits: Vec<Split>,
    frontier_max_total: f64,
    blades: Vec<BladeRow>,
    star_damage: f64,
}

/// The card's two outputs: the text the JS `console.log`s (already newline-terminated) and the `--json` document.
#[derive(Debug, Clone)]
pub struct Rendered {
    pub text: String,
    pub document: Value,
}

/// `theory [options]` (`src/cli.js:1806-2054`): the whole card over the caller's character, target and base scenario.
pub fn render(input: &Input, base: &Value, book: &Spellbook) -> Result<Rendered, String> {
    let blade = Num(input.blade);
    let mut profiles = Profiles::new(book);
    // The legal budget is picked at the caller's build: under 14631 the frontier winner can move (a flat add favours
    // weapon-skill points over Critical Strike). The frontier rows below are re-priced at the scenario's build too.
    let build_opts = obj([("gameBuild", Str(input.game_build.clone()))]);
    let legal = profiles.legal_gear(&blade, &build_opts)?;
    let legal_gear = Gear {
        lb: legal.get("lb").to_number(),
        cs: legal.get("cs").to_number(),
        damage: legal.get("dmg").to_number(),
    };
    let gear = Gear {
        lb: input.gear.lb.unwrap_or(legal_gear.lb),
        cs: input.gear.cs.unwrap_or(legal_gear.cs),
        damage: input.gear.damage_pct.unwrap_or(legal_gear.damage),
    };
    let lb_cap = max_single_skill(&obj([("weaponTemplate", blade.clone())]));
    let cs_cap = max_single_skill(&obj([
        ("weaponTemplate", blade.clone()),
        ("skill", Num(34.0)),
    ]));
    let explicit_gear = input.gear.lb.is_some() || input.gear.cs.is_some();

    let max_ch = make(input, &base_make(input, 200.0, gear, input.vampire, false))?;
    let max_r = run(&max_ch, base, book, false);
    let max_behind = run(&max_ch, base, book, true);
    let card = max_r.to_value();

    // A reference foe carries no `health`, which the JS card then dereferences and crashes on. Refuse it here, once,
    // with a message (the deliberate divergence documented at the module top).
    if card.get("health").is_nullish() {
        return Err(
            "the theory card needs a boss or gate target (a reference foe has no HP line, and the JS card crashes on it)"
                .to_owned(),
        );
    }

    let stages = stage_rows(input, base, book, gear)?;

    // The legal frontier re-run at THIS target (`src/cli.js:1836-1840`).
    let frontier = profiles
        .legal_frontier(&blade, &build_opts)?
        .items()
        .to_vec();
    let mut splits: Vec<Split> = Vec::with_capacity(frontier.len());
    for p in &frontier {
        let point = Gear {
            lb: p.get("lb").to_number(),
            cs: p.get("cs").to_number(),
            damage: p.get("dmg").to_number(),
        };
        let ch = make(input, &base_make(input, 200.0, point, input.vampire, false))?;
        let a = run(&ch, base, book, false);
        splits.push(Split {
            lb: point.lb,
            cs: point.cs,
            dmg: point.damage,
            total: point.lb + point.cs,
            dps: a.dps,
            capped_dps: a.capped_dps,
            per_swing: a.per_swing,
            ttk: a.ttk,
        });
    }
    splits.sort_by(|a, b| a.lb.total_cmp(&b.lb));

    let stats = stat_rows(base, book, &max_ch)?;
    let skills = skill_rows(input, base, book, &max_ch)?;
    let firm_stats = firm_stat_rows(input, base, book, gear)?;
    let firm_skills = firm_skill_rows(input, base, book, gear)?;
    let firm_damage = [0.0, 10.0, 20.0, 30.0]
        .into_iter()
        .map(|v| {
            let ch = make(
                input,
                &Make {
                    raw: 200.0,
                    gear,
                    vampire: input.vampire,
                    empty_sockets: false,
                    star_stats: input.star_stats.clone(),
                    star_skills: input.star_skills.clone(),
                    star_damage: v,
                },
            )?;
            Ok(run(&ch, base, book, false))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let mut blades: Vec<BladeRow> = LONG_BLADES
        .iter()
        .map(|&idx| {
            let c = theory_blade(&max_ch, &Num(idx), &Num(input.material))?;
            let a = run(&c, base, book, false);
            let c_card = a.to_value();
            let w = c_card.get("weapon");
            Ok(BladeRow {
                template: idx,
                name: obj_table_get(WEAPONS, &Num(idx))
                    .map_or_else(String::new, |t| t.name.to_owned()),
                two_handed: w.get("twoHanded").truthy(),
                dps: a.dps,
                dps_min: a.dps_min,
                dps_max: a.dps_max,
                capped_dps: a.capped_dps,
                capped_min: a.capped_dps_min,
                capped_max: a.capped_dps_max,
                per_swing: a.per_swing,
                aps: a.cadence.get("aps").to_number(),
                damage: c_card.get("damage").get("avg").to_number(),
                cap_loss: a.cap_loss,
                ttk: a.ttk,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    blades.sort_by(|a, b| b.capped_dps.total_cmp(&a.capped_dps));

    let race_name = obj_table_get(RACE_NAMES, max_ch.get("raceId"))
        .map_or_else(|| max_ch.get("race").to_js_string(), |name| name.to_owned());

    let computed = Computed {
        input: input.clone(),
        race_name,
        blade_name: obj_table_get(WEAPONS, &blade).map_or_else(String::new, |t| t.name.to_owned()),
        online: max_ch.get("online").truthy(),
        legal,
        gear,
        lb_cap,
        cs_cap,
        explicit_gear,
        card,
        max_ch,
        max_behind: max_behind.to_value(),
        stages,
        stats,
        skills,
        firm_stats,
        firm_skills,
        firm_damage,
        splits,
        frontier_max_total: max_point_total(&obj([("weaponTemplate", blade)])),
        blades,
        star_damage: input.gear.star_damage,
    };
    Ok(Rendered {
        text: text(&computed),
        document: document(&computed),
    })
}

fn base_make(input: &Input, raw: f64, gear: Gear, vampire: bool, empty_sockets: bool) -> Make {
    Make {
        raw,
        gear,
        vampire,
        empty_sockets,
        star_stats: input.star_stats.clone(),
        star_skills: input.star_skills.clone(),
        star_damage: input.gear.star_damage,
    }
}

/// The five push stages (`src/cli.js:1849-1860`).
fn stage_rows(
    input: &Input,
    base: &Value,
    book: &Spellbook,
    gear: Gear,
) -> Result<Vec<Stage>, String> {
    [
        (
            "Naked skills",
            100.0,
            Gear {
                lb: 0.0,
                cs: 0.0,
                damage: 0.0,
            },
            false,
            true,
        ),
        (
            "Mastered skills",
            200.0,
            Gear {
                lb: 0.0,
                cs: 0.0,
                damage: 0.0,
            },
            false,
            true,
        ),
        (
            "Legal gear (no damage line)",
            200.0,
            Gear {
                lb: gear.lb,
                cs: gear.cs,
                damage: 0.0,
            },
            false,
            false,
        ),
        ("Legal gear + damage line", 200.0, gear, false, false),
        ("Vampire", 200.0, gear, true, false),
    ]
    .into_iter()
    .map(|(label, raw, stage_gear, vampire, empty_sockets)| {
        let ch = make(
            input,
            &base_make(input, raw, stage_gear, vampire, empty_sockets),
        )?;
        let a = run(&ch, base, book, false);
        let b = run(&ch, base, book, true);
        Ok(Stage {
            label,
            raw,
            gear: stage_gear,
            vampire,
            sockets: empty_sockets.then(|| Arr(vec![])),
            dps: a.dps,
            dps_min: a.dps_min,
            dps_max: a.dps_max,
            capped_dps: a.capped_dps,
            capped_min: a.capped_dps_min,
            capped_max: a.capped_dps_max,
            behind: b.capped_dps,
            behind_min: b.capped_dps_min,
            behind_max: b.capped_dps_max,
            per_swing: a.per_swing,
            aps: a.cadence.get("aps").to_number(),
            ttk: a.ttk,
        })
    })
    .collect()
}

/// One attribute at a time, everything else at the ceiling (`src/cli.js:1863-1877`).
fn stat_rows(base: &Value, book: &Spellbook, max_ch: &Value) -> Result<Vec<StatRow>, String> {
    let mut out = Vec::new();
    for k in [
        "strength",
        "agility",
        "speed",
        "luck",
        "endurance",
        "intelligence",
        "willpower",
        "personality",
    ] {
        let at = |v: f64| -> Result<(f64, f64), String> {
            let mut c = dfo_core::analyze::json_clone(max_ch);
            let mut stats = c.get("stats").clone();
            stats.set(k, Num(v));
            c.set("stats", stats);
            let mut mods = c.get("_mods").clone();
            let mut mod_stats = mods.get("stats").clone();
            mod_stats.set(k, Num(0.0));
            mods.set("stats", mod_stats);
            let mut stat_max = mods.get("statMax").clone();
            stat_max.set(k, Num(0.0));
            mods.set("statMax", stat_max);
            c.set("_mods", mods);
            let a = run(&c, base, book, false);
            Ok((a.dps, a.capped_dps))
        };
        let (d50, _) = at(50.0)?;
        let (d75, _) = at(75.0)?;
        let (d90, _) = at(90.0)?;
        let (d100, capped100) = at(100.0)?;
        out.push(StatRow {
            stat: k,
            d50,
            d75,
            d100,
            capped100,
            delta: d100 - d50,
            last10: d100 - d90,
        });
    }
    out.sort_by(|a, b| b.delta.total_cmp(&a.delta));
    Ok(out)
}

/// The skill and gear curve (`src/cli.js:1879-1904`): raw rows drop the star, gear rows replace the line.
fn skill_rows(
    input: &Input,
    base: &Value,
    book: &Spellbook,
    max_ch: &Value,
) -> Result<Vec<SkillRow>, String> {
    let mut out = Vec::new();
    let mut add = |label: &'static str,
                   kind: &str,
                   id: &str,
                   list: &[f64],
                   backstab: bool|
     -> Result<(), String> {
        for &v in list {
            let mut c = dfo_core::analyze::json_clone(max_ch);
            let mut mods = c.get("_mods").clone();
            let mut skill_mods = mods.get("skills").clone();
            if kind == "raw" {
                let mut raw = c.get("skills").clone();
                if let Value::Arr(items) = &mut raw {
                    if let Ok(index) = id.parse::<usize>() {
                        if items.len() <= index {
                            items.resize(index + 1, Undefined);
                        }
                        items[index] = Num(v);
                    }
                }
                c.set("skills", raw);
                let line = skill_mods.get(id).to_number();
                skill_mods.set(
                    id,
                    Num(0.0f64.max(line - star_value(&input.star_skills, id))),
                );
            } else {
                skill_mods.set(id, Num(v));
            }
            mods.set("skills", skill_mods);
            c.set("_mods", mods);
            let a = run(&c, base, book, backstab);
            let b = run(&c, base, book, true);
            out.push(SkillRow {
                label,
                value: v,
                dps: a.dps,
                capped_dps: a.capped_dps,
                behind: b.capped_dps,
                per_swing: a.per_swing,
                ttk: a.ttk,
            });
        }
        Ok(())
    };
    add(
        "Raw Long Blade",
        "raw",
        "29",
        &[100.0, 125.0, 150.0, 175.0, 200.0],
        false,
    )?;
    add(
        "Raw Critical Strike",
        "raw",
        "34",
        &[100.0, 125.0, 150.0, 175.0, 200.0],
        false,
    )?;
    add(
        "Raw Backstabbing (behind)",
        "raw",
        "19",
        &[100.0, 125.0, 150.0, 175.0, 200.0],
        true,
    )?;
    add(
        "Gear Long Blade (legal to 535)",
        "gear",
        "29",
        &[0.0, 200.0, 400.0, 535.0],
        false,
    )?;
    // `14512`'s formula cap is the 320% row's hypothetical; `14631` has no such cap, so the row is skipped.
    if let Some(formula_cap) = gear_mastery_points(&input.game_build) {
        add(
            "Gear Long Blade (formula cap, hypothetical)",
            "gear",
            "29",
            &[formula_cap],
            false,
        )?;
    }
    add(
        "Gear Critical Strike (legal to 535)",
        "gear",
        "34",
        &[0.0, 200.0, 400.0, 535.0],
        false,
    )?;
    Ok(out)
}

/// The Firmament attribute channels (`src/cli.js:1957-1965`).
fn firm_stat_rows(
    input: &Input,
    base: &Value,
    book: &Spellbook,
    gear: Gear,
) -> Result<Vec<FirmStatRow>, String> {
    ["strength", "speed", "agility", "luck"]
        .into_iter()
        .map(|k| {
            let cells = [0.0, 5.0, 10.0, 15.0]
                .iter()
                .map(|&v| {
                    let ch = make(
                        input,
                        &Make {
                            raw: 200.0,
                            gear,
                            vampire: input.vampire,
                            empty_sockets: false,
                            star_stats: merge(&input.star_stats, k, v),
                            star_skills: input.star_skills.clone(),
                            star_damage: input.gear.star_damage,
                        },
                    )?;
                    let a = run(&ch, base, book, false);
                    Ok((a.dps, a.capped_dps))
                })
                .collect::<Result<Vec<_>, String>>()?;
            let at_max = make(
                input,
                &Make {
                    raw: 200.0,
                    gear,
                    vampire: input.vampire,
                    empty_sockets: false,
                    star_stats: merge(&input.star_stats, k, 15.0),
                    star_skills: input.star_skills.clone(),
                    star_damage: input.gear.star_damage,
                },
            )?;
            Ok(FirmStatRow {
                channel: k,
                cells,
                live: live_stat(&at_max, k),
            })
        })
        .collect()
}

/// The Firmament skill channels (`src/cli.js:1966-1974`).
fn firm_skill_rows(
    input: &Input,
    base: &Value,
    book: &Spellbook,
    gear: Gear,
) -> Result<Vec<FirmSkillRow>, String> {
    [
        ("29", "Long Blade"),
        ("34", "Critical Strike"),
        ("19", "Backstabbing"),
    ]
    .into_iter()
    .map(|(id, name)| {
        let mut dps = Vec::new();
        let mut capped = Vec::new();
        let mut sheet = 0.0;
        let mut formula = 0.0;
        for &v in &[0.0, 5.0, 10.0, 15.0] {
            let ch = make(
                input,
                &Make {
                    raw: 200.0,
                    gear,
                    vampire: input.vampire,
                    empty_sockets: false,
                    star_stats: input.star_stats.clone(),
                    star_skills: merge(&input.star_skills, id, v),
                    star_damage: input.gear.star_damage,
                },
            )?;
            let a = run(&ch, base, book, id == "19");
            dps.push(a.dps);
            capped.push(a.capped_dps);
            if v == 15.0 {
                let index = id.parse::<usize>().unwrap_or(0);
                sheet = ch.get("skills").at(index).to_number()
                    + ch.get("_mods").get("skills").get(id).to_number();
                formula = skill_value(&ch, &Num(id.parse::<f64>().unwrap_or(f64::NAN)));
            }
        }
        Ok(FirmSkillRow {
            name,
            dps,
            capped,
            sheet,
            formula,
        })
    })
    .collect()
}

fn text(c: &Computed) -> String {
    let card = &c.card;
    let gear = c.gear;
    let max_ch = &c.max_ch;
    let parts = card.get("damage").get("parts");
    let mut out = String::new();

    out.push_str(&format!(
        "Level {} theory long blade  |  {}  |  Daedric {}\n",
        n(c.input.level),
        c.race_name,
        c.blade_name
    ));
    out.push_str(&format!(
        "overhaul / {}{}  |  target {} level {}, {} HP, {} per-hit cap\n",
        if c.online { "online" } else { "offline" },
        if c.input.rri { " / RRI" } else { "" },
        c.input.target_name,
        card.get("target").get("level").to_js_string(),
        grouped_number_of(card.get("health").to_number()),
        if card.get("cap").truthy() {
            n(card.get("cap").to_number())
        } else {
            "no".to_owned()
        }
    ));
    out.push('\n');

    // The header table (`src/cli.js:1917-1942`).
    let live = |k: &str| n(live_stat(max_ch, k));
    let attrs = ["strength", "agility", "speed", "luck"]
        .iter()
        .map(|k| format!("{k} {}", live(k)))
        .collect::<Vec<_>>()
        .join(", ");
    let raw_skill = |id: &str| {
        let index = id.parse::<usize>().unwrap_or(0);
        let raw = max_ch.get("skills").at(index).to_number();
        let mod_of = max_ch.get("_mods").get("skills").get(id).to_number();
        (
            raw,
            mod_of,
            raw + mod_of,
            skill_value(max_ch, &Num(id.parse::<f64>().unwrap_or(f64::NAN))),
        )
    };
    let (lb_raw, lb_mod, lb_sheet, lb_formula) = raw_skill("29");
    let (cs_raw, cs_mod, cs_sheet, cs_formula) = raw_skill("34");
    let gear_note = if c.explicit_gear {
        let over_cap = gear.lb > c.lb_cap || gear.cs > c.cs_cap;
        let frontier = c.splits.iter().find(|x| x.lb == gear.lb && x.cs == gear.cs);
        if over_cap {
            format!(
                "ILLEGAL: {}; shown as a hypothetical build",
                if gear.lb > c.lb_cap {
                    format!("weapon skill {} is above {}", n(gear.lb), n(c.lb_cap))
                } else {
                    format!("Critical Strike {} is above {}", n(gear.cs), n(c.cs_cap))
                }
            )
        } else if let Some(point) = frontier {
            if gear.damage > point.dmg {
                format!(
                    "ILLEGAL: damage {}% is above the {}% attainable at {} / {}; shown as a hypothetical build",
                    n(gear.damage),
                    n(point.dmg),
                    n(point.lb),
                    n(point.cs)
                )
            } else if gear.damage == point.dmg {
                format!(
                    "explicit legal frontier point ({} / {} / damage {}%)",
                    n(point.lb),
                    n(point.cs),
                    n(point.dmg)
                )
            } else {
                format!(
                    "UNVERIFIED: {}% is below the {}% the frontier plan carries at {} / {}; a lower damage line is not checked here",
                    n(gear.damage),
                    n(point.dmg),
                    n(point.lb),
                    n(point.cs)
                )
            }
        } else {
            "HYPOTHETICAL: attainable but not a DPS frontier point (a lower split is dominated)"
                .to_owned()
        }
    } else {
        format!(
            "legal maximum for {}: {} / {} / damage {}% (the best uncapped split)",
            c.blade_name,
            n(c.legal.get("lb").to_number()),
            n(c.legal.get("cs").to_number()),
            n(c.legal.get("dmg").to_number())
        )
    };
    let sockets = perfect_sockets(&Num(c.input.blade)).len();
    let header = vec![
        vec![
            "Attributes".to_owned(),
            attrs,
            "live values; Firmament lifts the 100 ceiling, gear stat affixes do not".to_owned(),
        ],
        vec![
            "Raw skills".to_owned(),
            format!(
                "Long Blade raw {}, mod +{}, sheet {}, formula {}; Critical Strike raw {}, mod +{}, sheet {}, formula {}",
                n(lb_raw), n(lb_mod), n(lb_sheet), n(lb_formula),
                n(cs_raw), n(cs_mod), n(cs_sheet), n(cs_formula)
            ),
            "the sheet prints raw + mods; the formula reads effectiveSkill(raw) + mods".to_owned(),
        ],
        vec![
            "Gear".to_owned(),
            format!(
                "weapon skill {} / Critical Strike {} / damage {}%",
                n(gear.lb),
                n(gear.cs),
                n(gear.damage)
            ),
            gear_note,
        ],
        vec![
            "Weapon".to_owned(),
            format!("Daedric {}", c.blade_name),
            format!(
                "RRI {}-{}, weight {}",
                card.get("weapon").get("min").to_js_string(),
                card.get("weapon").get("max").to_js_string(),
                if card.get("weapon").get("twoHanded").truthy() { "2H" } else { "1H" }
            ),
        ],
        vec![
            "Damage affix".to_owned(),
            format!("{}%", n(gear.damage)),
            format!(
                "a weapon's damage line: a Rare tops at {}%, a Legendary record's is fixed (the best in the game is 38%)",
                n(AFFIX_DAMAGE_TOP.rare)
            ),
        ],
        vec![
            "Sockets".to_owned(),
            format!("{sockets} x perfect diamond"),
            format!(
                "+{}% damage; a two-hander has 3, a one-hander 2, a short blade 1",
                n(12.0 * sockets as f64)
            ),
        ],
        vec![
            "Firmament blow".to_owned(),
            format!("{}%", n(c.star_damage)),
            "general weapon-blow channel, cap +30% (+50% with conditions)".to_owned(),
        ],
        vec![
            "Mastery / gear".to_owned(),
            format!("{}%", fmt(parts.get("mastery").to_number())),
            "raw climb + gear channel".to_owned(),
        ],
        vec![
            "Hit / crit".to_owned(),
            format!(
                "{} / {} x{}",
                pc(card.get("hit").get("hit").to_number()),
                pc(card.get("hit").get("crit").get("chance").to_number()),
                fmt2(card.get("hit").get("crit").get("damageMult").to_number())
            ),
            "critical damage multiplier".to_owned(),
        ],
    ];
    out.push_str(&table(&header, &["Term", "Value", "Notes"], &[]));
    out.push('\n');

    out.push_str("\nPush stages\n");
    out.push_str(&table(
        &c.stages
            .iter()
            .map(|s| {
                vec![
                    s.label.to_owned(),
                    n(s.raw),
                    format!("{}+{}", n(s.gear.lb), n(s.gear.cs)),
                    format!("{}%", n(s.gear.damage)),
                    fmt(s.dps),
                    fmt(s.capped_dps),
                    fmt(s.behind),
                    fmt(s.per_swing),
                    fmt2(s.aps),
                    ttk_text(s.ttk),
                ]
            })
            .collect::<Vec<_>>(),
        &[
            "Stage",
            "Raw skill",
            "Gear",
            "Damage",
            "DPS",
            "Capped",
            "Behind",
            "Per swing",
            "APS",
            "TTK",
        ],
        &[false, true, true, true, true, true, true, true, true, true],
    ));
    out.push('\n');

    out.push_str("\nCaps (push in this order)\n");
    out.push_str(&table(
        &theory_caps(&c.input.game_build)
            .iter()
            .map(|cap| {
                vec![
                    cap.channel.to_owned(),
                    cap.cap.to_owned(),
                    cap.formula.to_owned(),
                    cap.note.to_owned(),
                ]
            })
            .collect::<Vec<_>>(),
        &["Channel", "Cap", "Formula", "What it means"],
        &[],
    ));
    out.push('\n');

    out.push_str("\nAttribute scaling (everything else at the ceiling)\n");
    out.push_str(&table(
        &c.stats
            .iter()
            .map(|x| {
                vec![
                    x.stat.to_owned(),
                    fmt(x.d50),
                    fmt(x.d75),
                    fmt(x.d100),
                    fmt(x.capped100),
                    format!("{}{}", if x.delta >= 0.0 { "+" } else { "" }, fmt(x.delta)),
                    format!(
                        "{}{}",
                        if x.last10 >= 0.0 { "+" } else { "" },
                        fmt(x.last10)
                    ),
                ]
            })
            .collect::<Vec<_>>(),
        &[
            "Attribute",
            "DPS 50",
            "DPS 75",
            "DPS 100",
            "Capped 100",
            "50 -> 100",
            "90 -> 100",
        ],
        &[false, true, true, true, true, true, true],
    ));
    out.push('\n');
    out.push_str("The DPS columns are uncapped averages and isolate the varied attribute (its star is dropped so 50..100 means the sheet); Capped 100 is the full build at the Breach. Luck is flat here only because Critical Strike already holds chance at 100%.\n");

    out.push_str("\nSkill and gear scaling\n");
    out.push_str(&table(
        &c.skills
            .iter()
            .map(|x| {
                vec![
                    x.label.to_owned(),
                    n(x.value),
                    fmt(x.dps),
                    fmt(x.capped_dps),
                    fmt(x.behind),
                    fmt(x.per_swing),
                    ttk_text(x.ttk),
                ]
            })
            .collect::<Vec<_>>(),
        &[
            "Channel",
            "Value",
            "DPS",
            "Capped",
            "Behind",
            "Per swing",
            "TTK",
        ],
        &[false, true, true, true, true, true, true],
    ));
    out.push('\n');
    out.push_str(&format!(
        "The \"formula cap\" row is hypothetical: the legal single-skill maximum is 535 points (the weapon record + 17 Exalted slots); {}.\n",
        if c.input.game_build == "14631" {
            "0.1.14631 drops the 320% cap (the gear is flat, no percent)".to_owned()
        } else {
            format!("the 320% mastery cap would need {} points", n(GEAR_MASTERY_POINTS))
        }
    ));

    out.push_str("\nFirmament attributes (the tree caps a channel at +15; the gain also lifts the 100 ceiling)\n");
    out.push_str("--firmament is the per-channel ceiling, not a legal 98-star allocation: the tree budget is 98 stars. Use --star-stat/--star-skill for the channels you actually own.\n");
    out.push_str(&table(
        &c.firm_stats
            .iter()
            .map(|x| {
                let mut row = vec![x.channel.to_owned()];
                row.extend(x.cells.iter().map(|(dps, _)| fmt(*dps)));
                row.extend(x.cells.iter().map(|(_, capped)| fmt(*capped)));
                row.push(n(x.live));
                row
            })
            .collect::<Vec<_>>(),
        &[
            "Attribute",
            "+0 DPS",
            "+5 DPS",
            "+10 DPS",
            "+15 DPS",
            "+0 cap",
            "+5 cap",
            "+10 cap",
            "+15 cap",
            "Live +15",
        ],
        &[false, true, true, true, true, true, true, true, true, true],
    ));
    out.push('\n');
    out.push_str("Speed is clamped to 98/100 by the swing law, so Speed past 100 does nothing for cadence. Luck's critical divisor steps at 125, so +15 Luck from 100 is dead for critical chance. Strength is the one that keeps paying: it adds damage and RRI swing speed.\n");

    out.push_str("\nFirmament skills (the +15 sits on top of effectiveSkill(raw); the sheet prints raw + mods)\n");
    out.push_str(&table(
        &c.firm_skills
            .iter()
            .map(|x| {
                let mut row = vec![x.name.to_owned()];
                row.extend(x.dps.iter().map(|v| fmt(*v)));
                row.extend(x.capped.iter().map(|v| fmt(*v)));
                row.push(n(x.sheet));
                row.push(n(x.formula));
                row
            })
            .collect::<Vec<_>>(),
        &[
            "Skill",
            "+0 DPS",
            "+5 DPS",
            "+10 DPS",
            "+15 DPS",
            "+0 cap",
            "+5 cap",
            "+10 cap",
            "+15 cap",
            "Sheet +15",
            "Formula +15",
        ],
        &[
            false, true, true, true, true, true, true, true, true, true, true,
        ],
    ));
    out.push('\n');
    out.push_str(&format!(
        "The sheet showing 215 is raw 200 + 15; the formula reads 155 (effectiveSkill(200)=140 + 15). Gear skill adds on top of both, and for Long Blade it converts at 0.44% per point{}.\n",
        if c.input.game_build == "14631" {
            ", and on 0.1.14631 that percent is gone: the gear is a flat add on the roll, no cap"
        } else {
            ", capped at +320%"
        }
    ));

    out.push_str("\nFirmament weapon blow (general channel cap +30%; conditions can take the total to +50%)\n");
    let firm_values = [0.0, 10.0, 20.0, 30.0];
    let damage_rows = vec![
        {
            let mut row = vec!["DPS".to_owned()];
            row.extend(c.firm_damage.iter().map(|a| fmt(a.dps)));
            row
        },
        {
            let mut row = vec!["Capped".to_owned()];
            row.extend(c.firm_damage.iter().map(|a| fmt(a.capped_dps)));
            row
        },
    ];
    let mut headers = vec!["".to_owned()];
    headers.extend(firm_values.iter().map(|v| format!("+{}% DPS", n(*v))));
    headers.extend(firm_values.iter().map(|v| format!("+{}% cap", n(*v))));
    let header_refs: Vec<&str> = headers.iter().map(String::as_str).collect();
    out.push_str(&table(
        &damage_rows,
        &header_refs,
        &[false, true, true, true, true, true, true, true, true],
    ));
    out.push('\n');

    // The frontier (`src/cli.js:1992-2013`).
    let key_of = |x: &Split| format!("{}/{}/{}", n(x.lb), n(x.cs), n(x.dmg));
    let total_row = c.splits.iter().find(|x| x.total == c.frontier_max_total);
    let mut keep: Vec<String> = Vec::new();
    keep.push(format!(
        "{}/{}/{}",
        n(c.legal.get("lb").to_number()),
        n(c.legal.get("cs").to_number()),
        n(c.legal.get("dmg").to_number())
    ));
    if let Some(first) = c.splits.first() {
        keep.push(key_of(first));
    }
    if let Some(last) = c.splits.last() {
        keep.push(key_of(last));
    }
    if let Some(row) = total_row {
        keep.push(key_of(row));
    }
    let step = 1usize.max((c.splits.len() as f64 / 16.0).ceil() as usize);
    let shown: Vec<&Split> = c
        .splits
        .iter()
        .enumerate()
        .filter(|(i, x)| i % step == 0 || keep.contains(&key_of(x)))
        .map(|(_, x)| x)
        .collect();

    out.push_str(&format!(
        "\nLegal gear frontier ({} attainable splits of the 18 worn slots)\n",
        n(c.splits.len() as f64)
    ));
    out.push_str(&format!(
        "Single-skill maximum: weapon skill {}, Critical Strike {}; highest combined total {}.\n",
        n(c.lb_cap),
        n(c.cs_cap),
        n(c.frontier_max_total)
    ));
    let on_frontier = c.splits.iter().find(|x| x.lb == gear.lb && x.cs == gear.cs);
    if c.explicit_gear && (gear.lb > c.lb_cap || gear.cs > c.cs_cap) {
        out.push_str(&format!(
            "WARNING: ILLEGAL allocation. {}{}. The build is shown for comparison only; the rows below are what the slots can reach.\n",
            if gear.lb > c.lb_cap {
                format!("Weapon skill {} is above the legal single-skill maximum {}", n(gear.lb), n(c.lb_cap))
            } else {
                String::new()
            },
            if gear.lb > c.lb_cap && gear.cs > c.cs_cap {
                format!(
                    "; Critical Strike {} is above {}",
                    n(gear.cs),
                    n(c.cs_cap)
                )
            } else if gear.cs > c.cs_cap {
                format!("Critical Strike {} is above {}", n(gear.cs), n(c.cs_cap))
            } else {
                String::new()
            }
        ));
    } else if let Some(point) = on_frontier.filter(|_| c.explicit_gear) {
        if gear.damage > point.dmg {
            out.push_str(&format!(
                "WARNING: ILLEGAL damage line. At {} weapon skill / {} Critical Strike the best attainable damage line is {}%, not {}%. The build is shown for comparison only.\n",
                n(point.lb),
                n(point.cs),
                n(point.dmg),
                n(gear.damage)
            ));
        } else if gear.damage != point.dmg {
            out.push_str(&format!(
                "NOTE: the frontier plan at {} / {} carries a {}% damage line; {}% is lower, and this tool does not verify a different damage roll at the same split.\n",
                n(point.lb),
                n(point.cs),
                n(point.dmg),
                n(gear.damage)
            ));
        } else {
            out.push_str(&format!(
                "Explicit frontier point: {} weapon skill / {} Critical Strike / damage {}%.\n",
                n(point.lb),
                n(point.cs),
                n(point.dmg)
            ));
        }
    } else if c.explicit_gear {
        out.push_str(&format!(
            "WARNING: {} weapon skill / {} Critical Strike is attainable but not on the DPS frontier (a lower split dominates it). The rows below are the trade-offs.\n",
            n(gear.lb),
            n(gear.cs)
        ));
    } else {
        out.push_str(&format!(
            "Default max: {} weapon skill / {} Critical Strike / damage {}% ({}; ties: {}).\n",
            n(c.legal.get("lb").to_number()),
            n(c.legal.get("cs").to_number()),
            n(c.legal.get("dmg").to_number()),
            c.legal.get("metric").to_js_string(),
            n(c.legal.get("alternatives").items().len() as f64)
        ));
    }
    out.push_str(&table(
        &shown
            .iter()
            .map(|x| {
                vec![
                    n(x.lb),
                    n(x.cs),
                    n(x.total),
                    format!("{}%", n(x.dmg)),
                    fmt(x.dps),
                    fmt(x.capped_dps),
                    fmt(x.per_swing),
                    ttk_text(x.ttk),
                ]
            })
            .collect::<Vec<_>>(),
        &[
            "Weapon skill",
            "Critical Strike",
            "Points",
            "Damage",
            "DPS",
            "Capped",
            "Per swing",
            "TTK",
        ],
        &[true, true, true, true, true, true, true, true],
    ));
    out.push('\n');

    out.push_str("\nLong blades at the ceiling\n");
    out.push_str(&table(
        &c.blades
            .iter()
            .map(|x| {
                vec![
                    x.name.clone(),
                    if x.two_handed {
                        "2H".to_owned()
                    } else {
                        "1H".to_owned()
                    },
                    fmt(x.dps),
                    fmt(x.capped_dps),
                    fmt(x.per_swing),
                    fmt2(x.aps),
                    fmt(x.damage),
                    pc(x.cap_loss),
                    ttk_text(x.ttk),
                ]
            })
            .collect::<Vec<_>>(),
        &[
            "Blade",
            "Hands",
            "DPS",
            "Capped",
            "Per swing",
            "APS",
            "Avg hit",
            "Cap loss",
            "TTK",
        ],
        &[false, false, true, true, true, true, true, true, true],
    ));
    out.push('\n');
    out.push_str("The table holds the legal 18-slot budget (weapon + seven body pieces + ten jewellery pieces). A one-handed blade plus a shield has one more armour-group slot, so a shield build reaches one Exalted skill line further; the 1H rows are a lower bound.\n");
    if let Some(best) = c.blades.first() {
        out.push_str(&format!(
            "Best at this target: {} ({} capped DPS, {} uncapped).\n",
            best.name,
            fmt(best.capped_dps),
            fmt(best.dps)
        ));
    }

    let title = {
        let mut chars = c.input.target_name.chars();
        match chars.next() {
            Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
            None => String::new(),
        }
    };
    out.push_str(&format!("\n{} result\n", title));
    let mut result_rows = vec![
        vec!["Uncapped DPS".to_owned(), fmt(card.get("dps").to_number())],
        vec![
            "Per-hit-capped DPS (ceiling)".to_owned(),
            fmt(card.get("cappedDps").to_number()),
        ],
    ];
    if card.get("allowance").truthy() {
        result_rows.extend(allowance_rows(card.get("allowance")).into_iter().take(3));
    }
    result_rows.push(vec![
        "Per-hit range".to_owned(),
        format!(
            "{}-{} (crit {}-{})",
            card.get("damage").get("min").to_js_string(),
            card.get("damage").get("max").to_js_string(),
            card.get("damage").get("critMin").to_js_string(),
            card.get("damage").get("critMax").to_js_string()
        ),
    ]);
    result_rows.push(vec![
        "Cap loss".to_owned(),
        pc(card.get("capLoss").to_number()),
    ]);
    result_rows.push(vec![
        "Time to kill".to_owned(),
        format!("{} s", fmt(card.get("ttk").to_number())),
    ]);
    result_rows.push(vec![
        "Behind / backstab".to_owned(),
        format!(
            "{} capped ({} x3)",
            fmt(c.max_behind.get("cappedDps").to_number()),
            pc(c.max_behind.get("backstab").get("chance").to_number())
        ),
    ]);
    result_rows.push(vec![
        "Phase shields".to_owned(),
        format!(
            "{} x {}s ({}s)",
            card.get("target").get("phaseShields").to_js_string(),
            card.get("target").get("shieldSeconds").to_js_string(),
            card.get("shields").to_js_string()
        ),
    ]);
    out.push_str(&table(&result_rows, &["Metric", "Value"], &[]));
    out.push('\n');

    // `src/cli.js:2031-2033`: the crti-min-over-cap paragraph.
    let crit = card.get("hit").get("crit");
    if card.get("cap").truthy()
        && crit.get("chance").to_number() >= 1.0
        && card.get("damage").get("critMin").to_number() >= card.get("cap").to_number()
    {
        out.push_str(&format!(
            "At 100% critical chance every blow is a critical, and the critical minimum is already over the per-hit cap: the {}% damage line adds 0 capped DPS. Speed is the only attribute that still buys capped DPS here; Strength helps only through the RRI swing law.\nAgainst an uncapped boss the same build is {} DPS.\n",
            n(gear.damage),
            fmt(card.get("dps").to_number())
        ));
    }
    out
}

fn document(c: &Computed) -> Value {
    let card = &c.card;
    let hit = card.get("hit");
    let damage = card.get("damage");

    let character = obj([
        ("level", Num(c.input.level)),
        ("race", Str(c.race_name.clone())),
        ("blade", Str(c.blade_name.clone())),
        ("material", Num(c.input.material)),
        ("slots", Num(18.0)),
        ("maxLb", Num(c.gear.lb)),
        ("maxCs", Num(c.gear.cs)),
        ("damage", Num(c.gear.damage)),
        (
            "legal",
            obj([
                ("lb", c.legal.get("lb").clone()),
                ("cs", c.legal.get("cs").clone()),
                ("dmg", c.legal.get("dmg").clone()),
                ("metric", c.legal.get("metric").clone()),
                (
                    "ties",
                    Num(c.legal.get("alternatives").items().len() as f64),
                ),
                ("violations", c.legal.get("violations").clone()),
            ]),
        ),
        (
            "singleSkill",
            obj([("weapon", Num(c.lb_cap)), ("critical", Num(c.cs_cap))]),
        ),
        ("frontierPoints", Num(c.splits.len() as f64)),
        ("frontierMaxTotal", Num(c.frontier_max_total)),
    ]);

    let result = obj([
        ("dps", card.get("dps").clone()),
        ("dpsMin", card.get("dpsMin").clone()),
        ("dpsMax", card.get("dpsMax").clone()),
        ("cappedDps", card.get("cappedDps").clone()),
        ("cappedDpsMin", card.get("cappedDpsMin").clone()),
        ("cappedDpsMax", card.get("cappedDpsMax").clone()),
        ("perSwing", card.get("perSwing").clone()),
        ("aps", card.get("cadence").get("aps").clone()),
        ("ttk", card.get("ttk").clone()),
        ("cap", card.get("cap").clone()),
        ("capLoss", card.get("capLoss").clone()),
        ("hit", hit.get("hit").clone()),
        ("critChance", hit.get("crit").get("chance").clone()),
        ("critMult", hit.get("crit").get("damageMult").clone()),
        (
            "damage",
            obj([
                ("min", damage.get("min").clone()),
                ("max", damage.get("max").clone()),
                ("critMin", damage.get("critMin").clone()),
                ("critMax", damage.get("critMax").clone()),
            ]),
        ),
        ("terms", damage.get("parts").clone()),
    ]);
    let stages = Arr(c
        .stages
        .iter()
        .map(|stage| {
            let mut row = obj([
                ("label", Str(stage.label.to_owned())),
                ("raw", Num(stage.raw)),
                ("gearLB", Num(stage.gear.lb)),
                ("gearCS", Num(stage.gear.cs)),
                ("damage", Num(stage.gear.damage)),
                ("vampire", Bool(stage.vampire)),
            ]);
            if let Some(sockets) = &stage.sockets {
                row.set("sockets", sockets.clone());
            }
            for (key, value) in [
                ("dps", stage.dps),
                ("dpsMin", stage.dps_min),
                ("dpsMax", stage.dps_max),
                ("cappedDps", stage.capped_dps),
                ("cappedDpsMin", stage.capped_min),
                ("cappedDpsMax", stage.capped_max),
                ("behind", stage.behind),
                ("behindMin", stage.behind_min),
                ("behindMax", stage.behind_max),
                ("perSwing", stage.per_swing),
                ("aps", stage.aps),
            ] {
                row.set(key, Num(value));
            }
            row.set("ttk", stage.ttk.map_or(Null, Num));
            row
        })
        .collect());

    let caps = Arr(theory_caps(&c.input.game_build)
        .iter()
        .map(|cap| {
            obj([
                ("channel", Str(cap.channel.to_owned())),
                ("cap", Str(cap.cap.to_owned())),
                ("formula", Str(cap.formula.to_owned())),
                ("note", Str(cap.note.to_owned())),
            ])
        })
        .collect());

    let stats = Arr(c
        .stats
        .iter()
        .map(|row| {
            obj([
                ("stat", Str(row.stat.to_owned())),
                ("d50", Num(row.d50)),
                ("d75", Num(row.d75)),
                ("d100", Num(row.d100)),
                ("capped100", Num(row.capped100)),
                ("delta", Num(row.delta)),
                ("last10", Num(row.last10)),
            ])
        })
        .collect());

    let skills = Arr(c
        .skills
        .iter()
        .map(|row| {
            obj([
                ("label", Str(row.label.to_owned())),
                ("value", Num(row.value)),
                ("dps", Num(row.dps)),
                ("cappedDps", Num(row.capped_dps)),
                ("behind", Num(row.behind)),
                ("perSwing", Num(row.per_swing)),
                ("ttk", row.ttk.map_or(Null, Num)),
            ])
        })
        .collect());

    let splits = Arr(c
        .splits
        .iter()
        .map(|row| {
            obj([
                ("lb", Num(row.lb)),
                ("cs", Num(row.cs)),
                ("dmg", Num(row.dmg)),
                ("total", Num(row.total)),
                ("dps", Num(row.dps)),
                ("cappedDps", Num(row.capped_dps)),
                ("perSwing", Num(row.per_swing)),
                ("ttk", row.ttk.map_or(Null, Num)),
            ])
        })
        .collect());

    let blades = Arr(c
        .blades
        .iter()
        .map(|row| {
            obj([
                ("templateIndex", Num(row.template)),
                ("name", Str(row.name.clone())),
                ("twoHanded", Bool(row.two_handed)),
                ("dps", Num(row.dps)),
                ("dpsMin", Num(row.dps_min)),
                ("dpsMax", Num(row.dps_max)),
                ("cappedDps", Num(row.capped_dps)),
                ("cappedDpsMin", Num(row.capped_min)),
                ("cappedDpsMax", Num(row.capped_max)),
                ("perSwing", Num(row.per_swing)),
                ("aps", Num(row.aps)),
                ("damage", Num(row.damage)),
                ("capLoss", Num(row.cap_loss)),
                ("ttk", row.ttk.map_or(Null, Num)),
            ])
        })
        .collect());

    obj([
        ("character", character),
        ("result", result),
        ("stages", stages),
        ("caps", caps),
        ("stats", stats),
        ("skills", skills),
        ("splits", splits),
        ("blades", blades),
    ])
}
