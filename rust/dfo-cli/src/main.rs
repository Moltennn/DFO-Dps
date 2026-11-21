//! `dfo-cli`: the thin command line over `dfo-core` (R8; the `saves`, `build`, `rank` and `doctor` slice).
//!
//! This is the JS `src/cli.js` `build` card, `rank` card, `saves` listing and `doctor`, and only that: [`main`]
//! parses the flags those read, replays the JS validation (`numFlag`, the enum checks) with the same messages, builds
//! either the level-45 theory character or the one an imported save describes, the target and the scenario, then prints
//! `printBuild`, `printRank` or `{ character, weapons, current }` as `--json` does. `build --json` prints `summary()`;
//! its text card is `printBuild` with the what-ifs the JS runs after it. `doctor` prints the save/build/ruleset summary
//! over the same imported character.
//!
//! The save is imported READ-ONLY by [`saves`]: discovery and parsing live there, the character normalisation is
//! `dfo_core::save::character_from_save`, and nothing is retained or written (AGENTS.md rule 11). Every flag this
//! slice does not price, and every other command, is refused by name instead of being accepted and ignored.
//!
//! Every rule lives in `dfo-core`; this file owns argument text, the two output formats and exit codes (a usage
//! error is 2, as `bin/dfo-dps.js` does).

mod saves;

use std::collections::HashMap;
use std::process::ExitCode;

use dfo_core::analyze::{
    analyze, boss_target, current_weapon_row, gate_target, marginals, rank_affixes, rank_weapons,
    reference_foe,
};
use dfo_core::encounters::{encounter_by_id, encounter_target, ENCOUNTER_IDS};
use dfo_core::generated::data::{BOSS_TRAITS, RACE_NAMES, SOURCE, WEAPONS};
use dfo_core::generated::level_cap::LEVEL_CAP;
use dfo_core::generated::theory::{DEFAULT_BLADE, THEORY_LEVEL, THEORY_RACES};
use dfo_core::maxprofile::Profiles;
use dfo_core::model_blow::{synthetic_weapon, weapon_of};
use dfo_core::round::math_round;
use dfo_core::save::{character_label, live_stat, skill_name, skill_value};
use dfo_core::spells::Spellbook;
use dfo_core::theory::theory_character;
use dfo_core::value::{number_to_string, obj_table_get, string_to_number, Value, Value::*};

const HELP: &str = "\
dfo-cli - the saves, build, rank and doctor slice of dfo-dps (Rust core)

Usage:
  dfo-cli saves
  dfo-cli doctor [--save <slot|folder|path>] [--offline]
  dfo-cli build [--save <slot|folder|path>] [options]
  dfo-cli build --theory [options]
  dfo-cli rank [weapons] [--save <slot|folder|path>] [options]
  dfo-cli rank [weapons] --theory [options]

`saves` lists the save folders under the DFO user-data folder (newest first). `doctor` prints the model pin, the
save folders and the imported character's build/ruleset summary. `build` prices one build against one target: with
--theory for the level-45 theory character, otherwise for the imported save (read-only). `rank` prices every melee
template/material the same way. `build` prints the JS `printBuild` card; with `--json` it prints `summary()` instead.
`rank` text is the JS card, `--json` is `{ character, weapons, current }`.

Flags:
  --save <SAVE4|folder|SaveData.txt>  the save to import (default: the newest under the user-data folder)
  --offline                           offline rules (past-100 skills read as 100)
  --passive <path|none>               martial path override
  --bare                              strip gear affixes/enchants/legendaries
  --target <soft|tough|armoured|human|boss|gate|breach|ruhn|skyketch|abyss>  (default armoured; with --theory
                                      armoured is analysed as the Breach gate, as src/cli.js does)
  --level <n> --armor <n> --health <n> --traits <a,b> --players <n> --blow-x <n>
  --core <overhaul|classic> --swing <random|StrikeLeft|...> --stacks <0-5> --rhythm --unaware --first-blow
  --behind --backstab <0..1> --health-share <0..1> --self-health-share <0..1>
  --weapon <template[:material]>      theory blade/material override
  --race <breton|redguard|nord|darkelf|highelf|woodelf|khajiit|argonian>
  --blade <template>                  theory long blade (default 123, Dai-katana)
  --gear-lb <n> --gear-cs <n>         gear points on weapon skill / Critical Strike (default: legal max)
  --damage-pct <n> --vampire
  --firmament --star-stat <name=n,...> --star-skill <id=n,...> --star-damage <pct>
  --no-rri --no-crit-damage --no-passive --pair --dual --spam --potency <pct> --pierce <n>
  --no-effects                        drop active effects
  --base-stats <n>                    set all eight base attributes to n
  --top <n>                           rows in the ranking (default 20)
  --json
  -h, --help

Unsupported here (another command, or a flag this slice does not read): --out, --encounter, --shortlist,
--objective and the other commands' flags.";

fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(out) => {
            print!("{out}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{}", e.message);
            ExitCode::from(e.code)
        }
    }
}

struct CliError {
    message: String,
    code: u8,
}

fn usage(message: impl Into<String>) -> CliError {
    CliError {
        message: message.into(),
        code: 2,
    }
}

fn run(args: Vec<String>) -> Result<String, CliError> {
    let parsed = parse(&args)?;
    if parsed.flag("help") {
        return Ok(format!("{HELP}\n"));
    }
    // The JS validates the flags before it looks at the command, so a bad number wins over an unknown command.
    let values = Values::new(&parsed)?;
    let command = parsed
        .positionals
        .first()
        .cloned()
        .unwrap_or_else(|| "build".into());
    if command == "saves" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return saves_command();
    }
    if command == "doctor" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return doctor_command(&values);
    }
    if command == "build" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return build(&values);
    }
    if command != "rank" {
        const COMMANDS: [&str; 23] = [
            "build",
            "objective",
            "rank",
            "weapons",
            "report",
            "compare",
            "scale",
            "tradeoff",
            "theory",
            "spell",
            "spells",
            "enchant",
            "firmament",
            "imprints",
            "probe",
            "enchant-plan",
            "gear-plan",
            "loadout",
            "real-dps",
            "skills",
            "graph",
            "saves",
            "doctor",
        ];
        return Err(if COMMANDS.contains(&command.as_str()) {
            usage(format!(
                "the \"{command}\" command is not ported yet; this slice supports `saves`, `build`, `rank` and `doctor`"
            ))
        } else {
            usage(format!("unknown command \"{command}\"\n\n{HELP}"))
        });
    }
    if let Some(extra) = parsed.positionals.get(1) {
        if extra != "weapons" {
            return Err(usage(format!(
                "unknown rank target \"{extra}\" (this slice supports `rank` and `rank weapons`)"
            )));
        }
    }
    if let Some(extra) = parsed.positionals.get(2) {
        return Err(usage(format!("unexpected positional argument \"{extra}\"")));
    }
    check_output_flags(&command, &parsed)?;
    rank(&values)
}

/// `checkOutputFlags` (`src/cli.js:885-898`): reject a flag the command would ignore instead of accepting it silently.
/// The commands of this slice (`build`, `rank`, `saves`, `doctor`): only `build` and `rank` read `--json`, none read
/// `--out`.
fn check_output_flags(command: &str, parsed: &Parsed) -> Result<(), CliError> {
    const FILE_COMMANDS: &str = concat!(
        "report, spells, weapons, skills, firmament, imprints, probe, enchant-plan, gear-plan, loadout, ",
        "real-dps, graph",
    );
    const JSON_COMMANDS: &str = concat!(
        "build, objective, rank, scale, tradeoff, theory, spell, spells, enchant, weapons, skills, firmament, ",
        "imprints, probe, enchant-plan, gear-plan, loadout, real-dps, graph",
    );
    let listed = |list: &str| list.split(", ").any(|f| f.trim() == command);
    if parsed.raw("out").is_some() && !listed(FILE_COMMANDS) {
        return Err(usage(format!(
            "--out is only for commands that write a file ({FILE_COMMANDS}), not \"{command}\""
        )));
    }
    if parsed.flag("json") && !listed(JSON_COMMANDS) {
        return Err(usage(format!(
            "--json is not supported by \"{command}\"; commands with JSON output: {JSON_COMMANDS}"
        )));
    }
    Ok(())
}

/// `dfo-dps saves` (`src/cli.js:934-939`): the whole card, or `No saves found.` with an empty folder.
fn saves_command() -> Result<String, CliError> {
    let saves = saves::list_saves().map_err(usage)?;
    if saves.is_empty() {
        return Ok("No saves found.\n".to_owned());
    }
    let rows: Vec<Vec<String>> = saves
        .iter()
        .map(|s| {
            vec![
                s.slot.clone(),
                s.name.clone(),
                s.character.clone(),
                saves::iso_minute(s.mtime),
            ]
        })
        .collect();
    Ok(format!(
        "{}\n",
        table(
            &rows,
            &["Slot", "Save", "Character", "Modified"],
            &[false, false, false, false]
        )
    ))
}

/// `dfo-dps doctor` (`src/cli.js:941-959`): the model pin, the save folders, then the imported character's build and
/// ruleset summary. A missing or unreadable save is one `save: <message>` line, not an error: the command still exits
/// 0 (the JS catches it around the whole load-and-print block).
fn doctor_command(values: &Values) -> Result<String, CliError> {
    let mut out = format!(
        "dfo-dps  |  model {} @ {} ({})  |  live-checked {}\n",
        SOURCE.repo,
        SOURCE.commit.get(..7).unwrap_or(SOURCE.commit),
        SOURCE.date,
        SOURCE.verified
    );
    let saves = saves::list_saves().map_err(usage)?;
    let slots: Vec<&str> = saves.iter().map(|s| s.slot.as_str()).collect();
    out.push_str(&format!(
        "saves: {}\n",
        if slots.is_empty() {
            "(none)".to_owned()
        } else {
            slots.join(", ")
        }
    ));
    let loaded = saves::load_save(values.save.as_deref().unwrap_or(""));
    let (entry, save) = match loaded {
        Ok(loaded) => loaded,
        Err(e) => {
            out.push_str(&format!("save: {e}\n"));
            return Ok(out);
        }
    };
    let ch = dfo_core::save::character_from_save(
        &save,
        &obj([
            ("online", Bool(!values.offline)),
            ("slot", Str(entry.slot)),
            ("file", Str(entry.file.to_string_lossy().into_owned())),
        ]),
    );
    let field = |name: &str| ch.get(name).to_js_string();
    out.push_str(&format!("save: {}\n", entry.file.to_string_lossy()));
    out.push_str(&format!(
        "character: {}  |  {} rules  |  path {}\n",
        character_label(&ch),
        if ch.get("online").truthy() {
            "online"
        } else {
            "offline"
        },
        match ch.get("martialPath") {
            Null | Undefined => "none".to_owned(),
            path => path.to_js_string(),
        }
    ));
    let mastered: Vec<String> = ch
        .get("masteredSkills")
        .items()
        .iter()
        .map(|id| skill_name(id).to_js_string())
        .collect();
    out.push_str(&format!(
        "level {}, reflexes {}, masterSkills {}, mastered [{}]\n",
        field("level"),
        field("reflexes"),
        field("masterSkills"),
        mastered.join(", ")
    ));
    let weapon = ch.get("weapon");
    out.push_str(&format!(
        "weapon: {}\n",
        if weapon.truthy() {
            format!(
                "{} ({}, material {})",
                weapon.get("name").to_js_string(),
                weapon.get("templateIndex").to_js_string(),
                weapon.get("material").to_js_string()
            )
        } else {
            "bare hands".to_owned()
        }
    ));
    let stats: Vec<String> = [
        "strength",
        "agility",
        "speed",
        "luck",
        "endurance",
        "willpower",
    ]
    .iter()
    .map(|k| format!("{k} {}", number_to_string(live_stat(&ch, k))))
    .collect();
    out.push_str(&format!("live stats: {}\n", stats.join(", ")));
    // `ch.weapon ? (weaponOf(ch.weapon)?.skillId ?? 30) : 30`
    let skill_id = if weapon.truthy() {
        match weapon_of(weapon, false).get("skillId") {
            Num(n) => Num(*n),
            _ => Num(30.0),
        }
    } else {
        Num(30.0)
    };
    let raw_skill = |id: &Value| match ch.get("skills").prop(id) {
        Undefined | Null => Num(0.0),
        v => v,
    };
    out.push_str(&format!(
        "weapon skill: {} (raw {})\n",
        number_to_string(skill_value(&ch, &skill_id)),
        raw_skill(&skill_id).to_js_string()
    ));
    out.push_str(&format!(
        "crit skill: {} (raw {})\n",
        number_to_string(skill_value(&ch, &Num(34.0))),
        raw_skill(&Num(34.0)).to_js_string()
    ));
    Ok(out)
}

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------
// argument parsing: node's `parseArgs` shape for the flags this slice knows
// ---------------------------------------------------------------------------------------------------------------

struct Parsed {
    positionals: Vec<String>,
    /// Flag name (without `--`) to its textual value; a boolean is present with no value.
    flags: Vec<(String, Option<String>)>,
}

impl Parsed {
    fn raw(&self, name: &str) -> Option<&str> {
        self.flags
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .and_then(|(_, v)| v.as_deref())
    }

    fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|(k, v)| k == name && v.is_none())
    }

    fn multi(&self, name: &str) -> Vec<String> {
        self.flags
            .iter()
            .filter(|(k, _)| k == name)
            .filter_map(|(_, v)| v.clone())
            .collect()
    }
}

/// Every `optsSpec` name of `src/cli.js`; anything outside this is an unknown option.
const ALL_FLAGS: &str = concat!(
    "save target level armor health traits core offline weapon swing passive stacks rhythm unaware first-blow ",
    "health-share self-health-share bare base-stats no-effects behind backstab players blow-x categories build stars ",
    "refresh family sort shield soul-gem group repairs regen cap-aware encounter all-encounters shortlist objective ",
    "trials seed max-seconds max-blows no-carry samples old pair dual spam series uncapped theory race blade ",
    "gear-lines line-points gear-lb gear-cs vampire firmament star-stat star-skill star-damage spell list all-spells ",
    "standard potency pierce cast-speed magicka seconds mana-limit data no-rri all from to step skill gear-skill ",
    "damage-pct no-crit-damage no-passive json top out stat help",
);

/// The flags this slice prices. Every other name in `ALL_FLAGS` gets an explicit "not supported" error, never a
/// silent default.
const SUPPORTED: &str = concat!(
    "theory json vampire firmament rhythm unaware first-blow behind pair dual spam no-crit-damage no-passive no-rri ",
    "help target level armor health traits core weapon swing stacks race blade gear-lb gear-cs star-stat star-skill ",
    "star-damage potency pierce backstab players blow-x health-share self-health-share top damage-pct base-stats ",
    "no-effects save offline passive bare out",
);

fn in_flags(list: &str, name: &str) -> bool {
    list.split_whitespace().any(|f| f == name)
}

const BOOLEAN_FLAGS: &str = concat!(
    "theory json vampire firmament rhythm unaware first-blow behind pair dual spam no-crit-damage no-passive ",
    "no-rri help offline bare no-effects",
);

const MULTI: [&str; 2] = ["star-stat", "star-skill"];

/// `Object.keys(MARTIAL_PATHS)` (`src/data.js:223-239`): the `--passive` ids, in the table's own order.
const MARTIAL_PATH_NAMES: &str = concat!(
    "blademaster warblade vanguard ranger bladedancer bloodletter cutthroat assassin shadowdancer ",
    "juggernaut woodsman berserker crusader brawler windrunner",
);

fn parse(args: &[String]) -> Result<Parsed, CliError> {
    let mut positionals = Vec::new();
    let mut flags: Vec<(String, Option<String>)> = Vec::new();
    let mut i = 0;
    let mut rest_positional = false;
    while i < args.len() {
        let arg = &args[i];
        if rest_positional || !arg.starts_with('-') || arg == "-" {
            positionals.push(arg.clone());
            i += 1;
            continue;
        }
        if arg == "--" {
            rest_positional = true;
            i += 1;
            continue;
        }
        let Some(body) = arg.strip_prefix("--") else {
            if arg == "-h" {
                flags.push(("help".into(), None));
                i += 1;
                continue;
            }
            return Err(usage(format!("Unknown option '{arg}'")));
        };
        let (name, inline) = match body.split_once('=') {
            Some((n, v)) => (n, Some(v.to_owned())),
            None => (body, None),
        };
        if !in_flags(ALL_FLAGS, name) {
            return Err(usage(format!("Unknown option '--{name}'")));
        }
        if !in_flags(SUPPORTED, name) {
            return Err(usage(format!(
                "--{name} is not supported by this CLI slice (it needs a save, another command, or is not ported yet)"
            )));
        }
        if in_flags(BOOLEAN_FLAGS, name) {
            if inline.is_some() {
                return Err(usage(format!(
                    "Option '--{name}' does not take an argument"
                )));
            }
            flags.push((name.to_owned(), None));
            i += 1;
            continue;
        }
        let value = match inline {
            Some(v) => v,
            None => match args.get(i + 1) {
                Some(next) if !next.starts_with('-') => {
                    i += 1;
                    next.clone()
                }
                _ => {
                    return Err(usage(format!("Option '--{name} <value>' argument missing")));
                }
            },
        };
        if !MULTI.contains(&name) {
            // A repeated single-value option keeps its last value, as node's parseArgs does.
            flags.retain(|(k, _)| k != name);
        }
        flags.push((name.to_owned(), Some(value)));
        i += 1;
    }
    Ok(Parsed { positionals, flags })
}

// ---------------------------------------------------------------------------------------------------------------
// flag values and the JS validation messages (src/cli.js: validateFlags, numFlag, rangeText)
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Range {
    min: f64,
    max: f64,
    int: bool,
    exclusive_min: bool,
}

const fn range(min: f64, max: f64, int: bool, exclusive_min: bool) -> Range {
    Range {
        min,
        max,
        int,
        exclusive_min,
    }
}

const ANY: Range = range(f64::NEG_INFINITY, f64::INFINITY, false, false);

/// Every numeric option `validateFlags` bounds, with its JS default.
const NUMERIC_FLAGS: [(&str, f64, Range); 18] = [
    ("level", THEORY_LEVEL, range(1.0, LEVEL_CAP, true, false)),
    ("stacks", 5.0, range(0.0, 5.0, true, false)),
    ("players", 1.0, range(1.0, f64::INFINITY, true, false)),
    ("health", 5000.0, range(0.0, f64::INFINITY, false, true)),
    ("armor", 0.0, range(0.0, f64::INFINITY, false, false)),
    ("backstab", 0.0, range(0.0, 1.0, false, false)),
    ("blow-x", 1.0, range(0.0, f64::INFINITY, false, true)),
    ("top", 20.0, range(1.0, f64::INFINITY, true, false)),
    ("potency", 0.0, ANY),
    ("pierce", 0.0, ANY),
    ("health-share", 1.0, range(0.0, 1.0, false, false)),
    ("self-health-share", 1.0, range(0.0, 1.0, false, false)),
    ("gear-lb", 0.0, range(0.0, f64::INFINITY, false, false)),
    ("gear-cs", 0.0, range(0.0, f64::INFINITY, false, false)),
    ("damage-pct", 0.0, ANY),
    (
        "blade",
        DEFAULT_BLADE,
        range(1.0, f64::INFINITY, true, false),
    ),
    ("star-damage", 0.0, ANY),
    ("base-stats", 50.0, ANY),
];

struct Values {
    theory: bool,
    json: bool,
    vampire: bool,
    firmament: bool,
    rhythm: bool,
    unaware: bool,
    first_blow: bool,
    behind: bool,
    pair: bool,
    dual: bool,
    spam: bool,
    crit_damage: bool,
    passive_on: bool,
    rri: bool,
    /// Every supported numeric flag that was given; absent stays out.
    nums: HashMap<&'static str, f64>,
    target: String,
    core: String,
    swing: String,
    traits: Vec<String>,
    weapon: Option<(f64, f64)>,
    race: Option<String>,
    blade: f64,
    star_damage: Option<f64>,
    base_stats: Option<f64>,
    no_effects: bool,
    star_stats: Vec<(String, f64)>,
    star_skills: Vec<(String, f64)>,
    /// `--save`: the slot, folder or `SaveData.txt` path; `None` takes the newest save.
    save: Option<String>,
    offline: bool,
    bare: bool,
    /// `--passive`: lower-cased path id, or `none` for no path.
    passive: Option<String>,
}

fn range_text(what: &str, min: f64, max: f64, exclusive_min: bool) -> String {
    let one = if what == "integer" { "an" } else { "a" };
    if min == f64::NEG_INFINITY && max == f64::INFINITY {
        return format!("{one} finite {what}");
    }
    if max == f64::INFINITY {
        if exclusive_min {
            return if min == 0.0 {
                format!("{one} positive {what}")
            } else {
                format!("{one} {what} greater than {min}")
            };
        }
        return if min == 0.0 {
            format!("{one} non-negative {what}")
        } else {
            format!("{one} {what} at least {min}")
        };
    }
    if min == f64::NEG_INFINITY {
        return format!("{one} {what} at most {max}");
    }
    if exclusive_min {
        format!("{one} {what} greater than {min} and at most {max}")
    } else {
        format!("{one} {what} from {min} to {max}")
    }
}

fn num_flag(parsed: &Parsed, name: &str, def: f64, range: Range) -> Result<f64, CliError> {
    let Some(raw) = parsed.raw(name) else {
        return Ok(def);
    };
    let text = raw.trim();
    let value = if text.is_empty() {
        f64::NAN
    } else {
        string_to_number(text)
    };
    let what = if range.int { "integer" } else { "number" };
    let in_range = value.is_finite()
        && !(range.int && value.trunc() != value)
        && if range.exclusive_min {
            value > range.min
        } else {
            value >= range.min
        }
        && value <= range.max;
    if !in_range {
        return Err(usage(format!(
            "--{name} must be {}, got \"{raw}\"",
            range_text(what, range.min, range.max, range.exclusive_min)
        )));
    }
    Ok(value)
}

fn weapon_keys() -> String {
    WEAPONS
        .iter()
        .map(|(id, _)| id.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn swing_mod_keys() -> Vec<&'static str> {
    vec![
        "StrikeLeft",
        "StrikeRight",
        "StrikeUp",
        "StrikeDownRight",
        "StrikeDownLeft",
        "StrikeDown",
    ]
}

fn race_id(race: &str) -> Option<f64> {
    match race.to_lowercase().as_str() {
        "breton" => Some(THEORY_RACES.breton),
        "redguard" => Some(THEORY_RACES.redguard),
        "nord" => Some(THEORY_RACES.nord),
        "darkelf" => Some(THEORY_RACES.darkelf),
        "highelf" => Some(THEORY_RACES.highelf),
        "woodelf" => Some(THEORY_RACES.woodelf),
        "khajiit" => Some(THEORY_RACES.khajiit),
        "argonian" => Some(THEORY_RACES.argonian),
        _ => None,
    }
}

fn race_keys() -> String {
    [
        "breton", "redguard", "nord", "darkelf", "highelf", "woodelf", "khajiit", "argonian",
    ]
    .join(", ")
}

/// `src/cli.js` `WEAPON_MATERIAL_MAX`: `MATERIALS.length - 1`.
const WEAPON_MATERIAL_MAX: f64 = 9.0;

fn weapon_flag(raw: &str) -> Result<(f64, f64), CliError> {
    let parts: Vec<&str> = raw.split(':').collect();
    if parts.len() > 2 {
        return Err(usage(format!(
            "--weapon expects template or template:material (e.g. 121:9), got \"{raw}\""
        )));
    }
    let tpl = string_to_number(parts[0]);
    let Some((_, template)) = WEAPONS
        .iter()
        .find(|(id, _)| *id as f64 == tpl && tpl.trunc() == tpl)
    else {
        return Err(usage(format!(
            "--weapon: unknown weapon template {}. Melee templates: {}",
            parts[0],
            weapon_keys()
        )));
    };
    if template.ammo == Some(true) {
        return Err(usage(format!(
            "--weapon template {tpl} is ammunition, not a weapon"
        )));
    }
    let mut material = 9.0;
    if parts.len() == 2 {
        let raw_material = parts[1].trim();
        material = string_to_number(raw_material);
        if raw_material.is_empty()
            || material.trunc() != material
            || material < 0.0
            || material > WEAPON_MATERIAL_MAX
        {
            return Err(usage(format!(
                "--weapon material must be an integer from 0 to {WEAPON_MATERIAL_MAX}, got \"{}\"",
                parts[1]
            )));
        }
    }
    Ok((tpl, material))
}

fn valid_targets() -> Vec<String> {
    let mut out: Vec<String> = [
        "soft", "tough", "armoured", "human", "boss", "gate", "breach", "ruhn",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    for id in ENCOUNTER_IDS {
        if !out.iter().any(|t| t == id) {
            out.push(id.to_owned());
        }
    }
    out
}

impl Values {
    fn new(parsed: &Parsed) -> Result<Self, CliError> {
        let mut nums = HashMap::new();
        for &(name, def, bounds) in &NUMERIC_FLAGS {
            if parsed.raw(name).is_some() {
                nums.insert(name, num_flag(parsed, name, def, bounds)?);
            }
        }
        if let Some(raw) = parsed.raw("blade") {
            let template = string_to_number(raw);
            if template.trunc() != template || !WEAPONS.iter().any(|(id, _)| *id as f64 == template)
            {
                return Err(usage(format!(
                    "--blade: unknown weapon template {raw}. Melee templates: {}",
                    weapon_keys()
                )));
            }
        }
        let swing = parsed.raw("swing").unwrap_or("random").to_owned();
        if swing != "random" && !swing_mod_keys().contains(&swing.as_str()) {
            return Err(usage(format!(
                "--swing must be random or one of {}, got \"{swing}\"",
                swing_mod_keys().join(", ")
            )));
        }
        let traits: Vec<String> = parsed
            .raw("traits")
            .unwrap_or("")
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        for trait_name in &traits {
            if !BOSS_TRAITS.contains(&trait_name.as_str()) {
                return Err(usage(format!(
                    "--traits has no \"{trait_name}\"; choose {}",
                    BOSS_TRAITS.join(", ")
                )));
            }
        }
        if let Some(race) = parsed.raw("race") {
            if race_id(race).is_none() {
                return Err(usage(format!(
                    "--race must be one of {}, got \"{race}\"",
                    race_keys()
                )));
            }
        }
        let weapon = match parsed.raw("weapon") {
            Some(raw) => Some(weapon_flag(raw)?),
            None => None,
        };
        let core = parsed.raw("core").unwrap_or("overhaul").to_owned();
        if !matches!(core.to_lowercase().as_str(), "overhaul" | "classic") {
            return Err(usage(format!(
                "unknown core \"{core}\" (choose overhaul, classic)"
            )));
        }
        let target = parsed.raw("target").unwrap_or("armoured").to_owned();
        if !valid_targets().iter().any(|t| *t == target.to_lowercase()) {
            return Err(usage(format!(
                "unknown target \"{target}\" (choose {})",
                valid_targets().join(", ")
            )));
        }
        let blade = nums.get("blade").copied().unwrap_or(DEFAULT_BLADE);
        let star_damage = nums.get("star-damage").copied();
        let base_stats = nums.get("base-stats").copied();
        let (star_stats, star_skills) = star_options(parsed)?;
        let passive = match parsed.raw("passive") {
            Some(raw) => {
                let passive = raw.to_lowercase();
                if passive != "none" && !in_flags(MARTIAL_PATH_NAMES, &passive) {
                    return Err(usage(format!(
                        "--passive must be none or one of {}, got \"{raw}\"",
                        MARTIAL_PATH_NAMES
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(", ")
                    )));
                }
                Some(passive)
            }
            None => None,
        };
        Ok(Values {
            theory: parsed.flag("theory"),
            json: parsed.flag("json"),
            vampire: parsed.flag("vampire"),
            firmament: parsed.flag("firmament"),
            rhythm: parsed.flag("rhythm"),
            unaware: parsed.flag("unaware"),
            first_blow: parsed.flag("first-blow"),
            behind: parsed.flag("behind"),
            pair: parsed.flag("pair"),
            dual: parsed.flag("dual"),
            spam: parsed.flag("spam"),
            crit_damage: !parsed.flag("no-crit-damage"),
            passive_on: !parsed.flag("no-passive"),
            rri: !parsed.flag("no-rri"),
            nums,
            target,
            core,
            swing,
            traits,
            weapon,
            race: parsed.raw("race").map(str::to_owned),
            blade,
            star_damage,
            base_stats,
            no_effects: parsed.flag("no-effects"),
            star_stats,
            star_skills,
            save: parsed.raw("save").map(str::to_owned),
            offline: parsed.flag("offline"),
            bare: parsed.flag("bare"),
            passive,
        })
    }

    fn num(&self, name: &str, def: f64) -> f64 {
        self.nums.get(name).copied().unwrap_or(def)
    }
}

/// The `starOptions` pairs: (attribute or skill id, points).
type StarPairs = (Vec<(String, f64)>, Vec<(String, f64)>);

/// `src/cli.js` `starOptions`: the `--firmament` presets, then the `name=value` pairs (each capped at +-15).
fn star_options(parsed: &Parsed) -> Result<StarPairs, CliError> {
    const FIRM_CHANNEL_MAX: f64 = 15.0;
    let preset = parsed.flag("firmament");
    let mut stats: Vec<(String, f64)> = if preset {
        ["strength", "agility", "speed", "luck"]
            .iter()
            .map(|k| ((*k).to_owned(), 15.0))
            .collect()
    } else {
        vec![]
    };
    let mut skills: Vec<(String, f64)> = if preset {
        ["29", "34", "19"]
            .iter()
            .map(|k| ((*k).to_owned(), 15.0))
            .collect()
    } else {
        vec![]
    };
    let pairs = |name: &str| -> Vec<String> {
        parsed
            .multi(name)
            .iter()
            .flat_map(|x| x.split(','))
            .map(|x| x.trim().to_owned())
            .filter(|x| !x.is_empty())
            .collect()
    };
    for part in pairs("star-stat") {
        let Some((key, value)) = split_pair(&part, true) else {
            return Err(usage(format!("--star-stat expects name=value, got {part}")));
        };
        let key = key.to_lowercase();
        if ![
            "strength",
            "intelligence",
            "willpower",
            "agility",
            "endurance",
            "personality",
            "speed",
            "luck",
        ]
        .contains(&key.as_str())
        {
            return Err(usage(format!("unknown attribute {key}")));
        }
        let value = string_to_number(&value);
        if !(-FIRM_CHANNEL_MAX..=FIRM_CHANNEL_MAX).contains(&value) {
            return Err(usage(format!(
                "Firmament attribute channel is capped at +-{FIRM_CHANNEL_MAX}"
            )));
        }
        match stats.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => stats.push((key, value)),
        }
    }
    for part in pairs("star-skill") {
        let Some((id, value)) = split_pair(&part, false) else {
            return Err(usage(format!("--star-skill expects id=value, got {part}")));
        };
        let id = string_to_number(&id);
        if !(0.0..35.0).contains(&id) {
            return Err(usage(format!("bad skill id {}", number_to_string(id))));
        }
        let value = string_to_number(&value);
        if !(-FIRM_CHANNEL_MAX..=FIRM_CHANNEL_MAX).contains(&value) {
            return Err(usage(format!(
                "Firmament skill channel is capped at +-{FIRM_CHANNEL_MAX}"
            )));
        }
        let key = if id == id.trunc() {
            (id as i64).to_string()
        } else {
            number_to_string(id)
        };
        match skills.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => skills.push((key, value)),
        }
    }
    Ok((stats, skills))
}

/// `^([a-z]+)=(-?\d+)$` or `^(\d+)=(-?\d+)$`, the two patterns `starOptions` tests.
fn split_pair(part: &str, letters: bool) -> Option<(String, String)> {
    let (key, value) = part.split_once('=')?;
    let digits_ok = |s: &str| {
        let body = s.strip_prefix('-').unwrap_or(s);
        !body.is_empty() && body.chars().all(|c| c.is_ascii_digit())
    };
    if !digits_ok(value) {
        return None;
    }
    let key_ok = !key.is_empty()
        && key.chars().all(|c| {
            if letters {
                c.is_ascii_alphabetic()
            } else {
                c.is_ascii_digit()
            }
        });
    key_ok.then(|| (key.to_owned(), value.to_owned()))
}

// ---------------------------------------------------------------------------------------------------------------
// character, target and scenario (src/cli.js loadCharacter, targetOf, scenarioOf)
// ---------------------------------------------------------------------------------------------------------------

fn rank(values: &Values) -> Result<String, CliError> {
    // `standardSpells()` (`src/spells.js:82-93`): the launcher's `SPELLS.STD`, empty when absent.
    let book = saves::load_spellbook();
    let ch = character(values, &book)?;
    let target = target_of(&ch, values, &values.traits)?;
    let scenario = scenario_of(&ch, values, &values.traits, &target);
    let top = values.num("top", 20.0);
    let rows = rank_weapons(&ch, &scenario, &obj([("top", Num(top))]), &book);
    let current = current_weapon_row(&ch, &scenario, &book);
    if values.json {
        Ok(format!(
            "{}\n",
            json(&obj([
                ("character", Str(character_label(&ch))),
                ("weapons", rows),
                ("current", current),
            ]))
        ))
    } else {
        Ok(format!("{}\n", print_rank(&ch, &rows, values, &current)))
    }
}

/// `dfo-dps build` (`src/cli.js:2306-2314`): the `summary()` object with `--json`, `printBuild` otherwise.
fn build(values: &Values) -> Result<String, CliError> {
    // `standardSpells()` (`src/spells.js:82-93`): the launcher's `SPELLS.STD`, empty when absent.
    let book = saves::load_spellbook();
    let ch = character(values, &book)?;
    let target = target_of(&ch, values, &values.traits)?;
    let mut scenario = scenario_of(&ch, values, &values.traits, &target);
    // `scenarioOf` (`src/cli.js:559`): `weapon: values.theory ? undefined : weaponOverride(values)`. For the theory
    // character `--weapon` was already applied when the character was built, so only a save takes the override here.
    if !values.theory {
        if let Some((tpl, mat)) = values.weapon {
            scenario.set("weapon", synthetic_weapon(&Num(tpl), &Num(mat), values.rri));
        }
    }
    let r = analyze(&ch, &scenario, &book);
    if values.json {
        let summary = build_summary(&ch, &r, values, &scenario, &book);
        return Ok(format!("{}\n", json(&summary)));
    }
    // `printBuild(ch, r, values.theory && values.target === 'armoured' ? 'gate' : values.target, values)`: the preset
    // text stays as typed, even when `armoured` was analysed as the gate.
    let preset = if values.theory && values.target == "armoured" {
        "gate"
    } else {
        values.target.as_str()
    };
    Ok(format!("{}\n", print_build(&ch, &r, preset, values, &book)))
}

/// JS `summary()` (`src/cli.js:671-720`): the character, weapon, ruleset, target and result, then the caller's
/// `preset`, `marginals` and `topWeapons`. The JS `--json` branch asks for `top: n(values.top, 10)`, which resolves to
/// `--top`'s default 20 because `optsSpec` declares one; this uses the same default.
fn build_summary(
    ch: &Value,
    r: &dfo_core::analyze::Analysis,
    values: &Values,
    scenario: &Value,
    book: &Spellbook,
) -> Value {
    let card = r.to_value();
    let target = card.get("target");
    let hit = card.get("hit");
    let damage = card.get("damage");
    let cadence = card.get("cadence");
    let weapon = card.get("weapon");
    let live = |name: &str| Num(live_stat(ch, name));
    let race = match obj_table_get(RACE_NAMES, ch.get("raceId")) {
        Some(name) => Str(name.to_owned()),
        None => ch.get("race").clone(),
    };
    let career_name = ch.get("career").get("name");
    obj([
        (
            "character",
            obj([
                ("name", ch.get("name").clone()),
                ("level", ch.get("level").clone()),
                ("race", race),
                (
                    "career",
                    if career_name.truthy() {
                        career_name.clone()
                    } else {
                        Null
                    },
                ),
                ("path", ch.get("martialPath").clone()),
                ("online", ch.get("online").clone()),
                (
                    "stats",
                    obj([
                        ("strength", live("strength")),
                        ("agility", live("agility")),
                        ("speed", live("speed")),
                        ("luck", live("luck")),
                        ("endurance", live("endurance")),
                        ("willpower", live("willpower")),
                    ]),
                ),
                (
                    "skills",
                    obj([
                        (
                            "weapon",
                            Num(skill_value(
                                ch,
                                &match weapon.get("skillId") {
                                    Undefined | Null => Num(30.0),
                                    id => id.clone(),
                                },
                            )),
                        ),
                        ("critical", Num(skill_value(ch, &Num(34.0)))),
                        ("dodging", Num(skill_value(ch, &Num(20.0)))),
                    ]),
                ),
            ]),
        ),
        (
            "weapon",
            if weapon.truthy() {
                obj([
                    ("name", weapon.get("name").clone()),
                    ("templateIndex", weapon.get("templateIndex").clone()),
                    ("material", weapon.get("materialName").clone()),
                    ("skill", weapon.get("skill").clone()),
                    ("twoHanded", weapon.get("twoHanded").clone()),
                    ("condition", weapon.get("conditionPct").clone()),
                    ("min", weapon.get("min").clone()),
                    ("max", weapon.get("max").clone()),
                ])
            } else {
                Null
            },
        ),
        (
            "ruleset",
            obj([
                ("core", card.get("core").clone()),
                ("online", ch.get("online").clone()),
                ("mentor", Bool(false)),
            ]),
        ),
        (
            "target",
            obj([
                ("preset", Str(values.target.clone())),
                ("isClass", target.get("isClass").clone()),
                ("level", target.get("level").clone()),
                ("group", target.get("group").clone()),
                (
                    "armor",
                    match target.get("armorValues").at(0) {
                        Undefined | Null => Num(0.0),
                        v => v.clone(),
                    },
                ),
                ("health", card.get("health").clone()),
                ("traits", card.get("traits").clone()),
            ]),
        ),
        (
            "result",
            obj([
                ("hit", hit.get("hit").clone()),
                ("critChance", hit.get("crit").get("chance").clone()),
                ("critMult", hit.get("crit").get("damageMult").clone()),
                ("backstab", card.get("backstab").clone()),
                ("dual", Bool(card.get("dual").truthy())),
                ("pair", Bool(card.get("pair").truthy())),
                (
                    "damage",
                    obj([
                        ("min", damage.get("min").clone()),
                        ("max", damage.get("max").clone()),
                        ("avg", damage.get("avg").clone()),
                        ("critMin", damage.get("critMin").clone()),
                        ("critMax", damage.get("critMax").clone()),
                        ("critAvg", damage.get("critAvg").clone()),
                    ]),
                ),
                ("perSwing", card.get("perSwing").clone()),
                ("aps", cadence.get("aps").clone()),
                ("swingSeconds", cadence.get("seconds").clone()),
                ("dps", card.get("dps").clone()),
                ("dpsMin", card.get("dpsMin").clone()),
                ("dpsMax", card.get("dpsMax").clone()),
                ("cappedDps", card.get("cappedDps").clone()),
                ("cappedDpsMin", card.get("cappedDpsMin").clone()),
                ("cappedDpsMax", card.get("cappedDpsMax").clone()),
                ("cap", card.get("cap").clone()),
                ("capLoss", card.get("capLoss").clone()),
                ("carriedPerSwing", card.get("carriedPerSwing").clone()),
                ("carriedDps", card.get("carriedDps").clone()),
                ("carriedCappedDps", card.get("carriedCappedDps").clone()),
                ("enchantDps", card.get("enchantDps").clone()),
                ("enchantDpsMin", card.get("enchantDpsMin").clone()),
                ("enchantDpsMax", card.get("enchantDpsMax").clone()),
                ("totalDps", card.get("totalDps").clone()),
                ("totalDpsMin", card.get("totalDpsMin").clone()),
                ("totalDpsMax", card.get("totalDpsMax").clone()),
                ("enchantPerSwing", card.get("enchantPerSwing").clone()),
                ("enchantProcs", card.get("enchantProcs").clone()),
                ("procsBeforeBreak", card.get("procsBeforeBreak").clone()),
                (
                    "procsBeforeBreakBasis",
                    card.get("procsBeforeBreakBasis").clone(),
                ),
                ("ward", card.get("ward").clone()),
                ("ttk", card.get("ttk").clone()),
                ("totalTtk", card.get("totalTtk").clone()),
                ("totalTtkCapOnly", card.get("totalTtkCapOnly").clone()),
                ("wrath", card.get("wrath").clone()),
                ("ceilingTotalDps", card.get("ceilingTotalDps").clone()),
                ("ceilingTotalDpsMin", card.get("ceilingTotalDpsMin").clone()),
                ("ceilingTotalDpsMax", card.get("ceilingTotalDpsMax").clone()),
                ("ceilingTotalTtk", card.get("ceilingTotalTtk").clone()),
                ("claimTotalTtk", card.get("claimTotalTtk").clone()),
                ("claimSustainedDps", card.get("claimSustainedDps").clone()),
                ("terms", damage.get("parts").clone()),
            ]),
        ),
        ("preset", Str(values.target.clone())),
        ("marginals", marginals(ch, r, scenario, book)),
        (
            "topWeapons",
            // The JS text says `n(values.top, 10)`, but `optsSpec` gives `--top` the default "20", so 20 is what an
            // unspecified flag resolves to; this fallback keeps the same rows.
            rank_weapons(
                ch,
                scenario,
                &obj([("top", Num(values.num("top", 20.0)))]),
                book,
            ),
        ),
    ])
}

/// `loadCharacter` (`src/cli.js:401-449`): the level-45 theory character with `--theory`, otherwise the character the
/// imported save describes. The save is read-only and dropped after the character is built (AGENTS.md rule 11).
fn character(values: &Values, book: &Spellbook) -> Result<Value, CliError> {
    if !values.theory {
        let (entry, save) =
            saves::load_save(values.save.as_deref().unwrap_or("")).map_err(usage)?;
        let martial = match values.passive.as_deref() {
            Some("none") => Null,
            Some(path) => Str(path.to_owned()),
            None => Undefined,
        };
        let ch = dfo_core::save::character_from_save(
            &save,
            &obj([
                ("online", Bool(!values.offline)),
                ("slot", Str(entry.slot)),
                ("file", Str(entry.file.to_string_lossy().into_owned())),
                ("martialPath", martial),
            ]),
        );
        let mut ch = if values.bare { bare_character(&ch) } else { ch };
        if values.no_effects {
            ch.set("activeEffects", Arr(vec![]));
        }
        return Ok(set_base_stats(ch, values.base_stats));
    }
    let mut blade = values.blade;
    let mut material = 9.0;
    if let Some((tpl, mat)) = values.weapon {
        blade = tpl;
        material = mat;
    }
    let legal = Profiles::new(book)
        .legal_gear(&Num(blade), &Undefined)
        .map_err(usage)?;
    let legal_field = |k: &str| legal.get(k).to_number();
    let star_stats = obj_pairs(&values.star_stats);
    let star_skills = obj_pairs(&values.star_skills);
    let star_damage = values
        .star_damage
        .unwrap_or(if values.firmament { 30.0 } else { 0.0 });
    let opts = obj([
        ("level", Num(values.num("level", THEORY_LEVEL))),
        (
            "race",
            Str(values.race.clone().unwrap_or_else(|| "darkelf".into())),
        ),
        ("blade", Num(blade)),
        ("material", Num(material)),
        (
            "gearLB",
            Num(values
                .nums
                .get("gear-lb")
                .copied()
                .unwrap_or_else(|| legal_field("lb"))),
        ),
        (
            "gearCS",
            Num(values
                .nums
                .get("gear-cs")
                .copied()
                .unwrap_or_else(|| legal_field("cs"))),
        ),
        (
            "damagePct",
            Num(values
                .nums
                .get("damage-pct")
                .copied()
                .unwrap_or_else(|| legal_field("dmg"))),
        ),
        ("vampire", Bool(values.vampire)),
        ("starStats", star_stats),
        ("starSkills", star_skills),
        ("starDamage", Num(star_damage)),
    ]);
    // Both builders refuse a bad input with a UsageError in the JS, so this is exit 2.
    let mut ch = theory_character(&opts).map_err(usage)?;
    if values.no_effects {
        ch.set("activeEffects", Arr(vec![]));
    }
    Ok(set_base_stats(ch, values.base_stats))
}

/// `--base-stats`: every one of the eight base attributes.
fn set_base_stats(mut ch: Value, base_stats: Option<f64>) -> Value {
    if let Some(v) = base_stats {
        let mut stats = ch.get("stats").clone();
        for k in [
            "strength",
            "intelligence",
            "willpower",
            "agility",
            "endurance",
            "personality",
            "speed",
            "luck",
        ] {
            stats.set(k, Num(v));
        }
        ch.set("stats", stats);
    }
    ch
}

/// `bareCharacter` (`src/cli.js:451-458`): `JSON.parse(JSON.stringify(ch))` with the gear folds, the legendaries and the
/// main-hand affixes stripped.
fn bare_character(ch: &Value) -> Value {
    let mut c = dfo_core::analyze::json_clone(ch);
    let mut mods = Obj(vec![]);
    mods.set("stats", Obj(vec![]));
    mods.set("skills", Obj(vec![]));
    c.set("_mods", mods);
    let mut enchant = Obj(vec![]);
    enchant.set("skillMods", Obj(vec![]));
    enchant.set("chanceToHitMod", Num(0.0));
    c.set("_enchantMods", enchant);
    c.set("legendaries", Arr(vec![]));
    if c.get("weapon").truthy() {
        let mut weapon = c.get("weapon").clone();
        weapon.set("affixes", Arr(vec![]));
        c.set("weapon", weapon);
    }
    c
}

fn obj_pairs(pairs: &[(String, f64)]) -> Value {
    let mut out = Obj(vec![]);
    for (k, v) in pairs {
        out.set(k, Num(*v));
    }
    out
}

fn target_of(ch: &Value, values: &Values, traits: &[String]) -> Result<Value, CliError> {
    let requested = values.target.to_lowercase();
    let level = values.num("level", ch.get("level").to_number());
    let trait_list = || Arr(traits.iter().map(|t| Str(t.clone())).collect());
    Ok(match requested.as_str() {
        // The JS remap: for the theory character `armoured` is a reference preset that prices the gate; a save keeps it
        // as the reference foe it names (`src/cli.js:505`).
        "armoured" if values.theory => gate_body(values, traits, level),
        "gate" | "breach" | "ruhn" => gate_body(values, traits, level),
        "boss" => boss_target(&obj([
            ("level", Num(level)),
            ("armorValue", Num(values.num("armor", 0.0))),
            ("health", Num(values.num("health", 5000.0))),
            (
                "traits",
                if traits.is_empty() {
                    Arr(vec![])
                } else {
                    trait_list()
                },
            ),
        ]))
        .map_err(usage)?,
        id if encounter_by_id(&Str(id.to_owned())).is_some() => {
            let mut opts = obj([("players", Num(values.num("players", 1.0)))]);
            if !traits.is_empty() {
                opts.set("traits", trait_list());
            }
            encounter_target(&Str(id.to_owned()), &Num(level), &opts)
        }
        preset => reference_foe(&Num(level), &Str(preset.to_owned())),
    })
}

/// The Breach gate body (`gateTarget`) at the scenario's level and options.
fn gate_body(values: &Values, traits: &[String], level: f64) -> Value {
    let mut opts = obj([
        ("players", Num(values.num("players", 1.0))),
        ("blowX", Num(values.num("blow-x", 1.0))),
    ]);
    if values.nums.contains_key("health") {
        opts.set("health", Num(values.num("health", 0.0)));
    }
    if !traits.is_empty() {
        opts.set(
            "traits",
            Arr(traits.iter().map(|t| Str(t.clone())).collect()),
        );
    }
    gate_target(&Num(level), &opts)
}

fn scenario_of(ch: &Value, values: &Values, traits: &[String], target: &Value) -> Value {
    let health = if target.get("isBoss").truthy() {
        target.get("maxHealth").to_number()
    } else {
        values.num("health", 0.0)
    };
    obj([
        ("target", target.clone()),
        ("core", Str(values.core.to_lowercase())),
        ("rri", Bool(values.rri)),
        (
            "traits",
            if traits.is_empty() {
                Null
            } else {
                Arr(traits.iter().map(|t| Str(t.clone())).collect())
            },
        ),
        ("health", Num(health)),
        ("swing", Str(values.swing.clone())),
        ("critDamage", Bool(values.crit_damage)),
        ("passiveOn", Bool(values.passive_on)),
        ("stacks", Num(values.num("stacks", 5.0))),
        ("rhythm", Bool(values.rhythm)),
        ("unaware", Bool(values.unaware)),
        ("firstBlow", Bool(values.first_blow)),
        ("healthShare", Num(values.num("health-share", 1.0))),
        (
            "attackerHealthShare",
            Num(values.num("self-health-share", 1.0)),
        ),
        (
            "backstabUptime",
            Num(if values.behind {
                1.0
            } else {
                values.num("backstab", 0.0)
            }),
        ),
        (
            "firmamentDamagePct",
            Num(ch.get("firmamentDamagePct").finite_or(0.0)),
        ),
        ("pair", Bool(values.pair)),
        ("dual", Bool(values.dual)),
        ("bowSpam", Bool(values.spam)),
        ("potencyPct", Num(values.num("potency", 0.0))),
        ("pierce", Num(values.num("pierce", 0.0))),
    ])
}

// ---------------------------------------------------------------------------------------------------------------
// the rank card (src/cli.js printRank, fmt, fmt2, pc, table)
// ---------------------------------------------------------------------------------------------------------------

/// JS `(Math.round(v * 10) / 10).toFixed(1)`. A result of `-0` prints unsigned (`(-0).toFixed(1)` is `"0.0"`), and
/// `toFixed` itself switches to `String(x)` at 1e21 and above (`(1e21).toFixed(1)` is `"1e+21"`).
fn fmt(v: &Value) -> String {
    let n = v.to_number();
    if n.is_finite() {
        let r = math_round(n * 10.0) / 10.0;
        if r.abs() >= 1e21 {
            number_to_string(r)
        } else if r == 0.0 {
            "0.0".to_owned()
        } else {
            format!("{r:.1}")
        }
    } else {
        "-".to_owned()
    }
}

/// JS `(Math.round(v * 100) / 100).toFixed(2)`, with the same `-0` and 1e21 rules as [`fmt`].
fn fmt2(v: &Value) -> String {
    let n = v.to_number();
    if n.is_finite() {
        let r = math_round(n * 100.0) / 100.0;
        if r.abs() >= 1e21 {
            number_to_string(r)
        } else if r == 0.0 {
            "0.00".to_owned()
        } else {
            format!("{r:.2}")
        }
    } else {
        "-".to_owned()
    }
}

/// JS `` `${Math.round(v * 100)}%` ``: `String(-0)` is `"0"`, so a rounded `-0` prints `"0%"`. `number_to_string` is
/// JS `String`, so a huge rounded value keeps JS's exponent form (`1e+21`, not a long digit run).
fn pc(v: &Value) -> String {
    let n = v.to_number();
    if n.is_finite() {
        format!("{}%", number_to_string(math_round(n * 100.0)))
    } else {
        "-".to_owned()
    }
}

fn cell(v: &Value) -> String {
    match v {
        Undefined | Null => String::new(),
        _ => v.to_js_string(),
    }
}

/// JS `String.prototype.length`: UTF-16 code units, not bytes or chars.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.padStart(width)` / `s.padEnd(width)`: pad to `width` UTF-16 code units, as the JS `table` does.
fn pad(s: &str, width: usize, right: bool) -> String {
    let fill = width.saturating_sub(utf16_len(s));
    if right {
        format!("{}{s}", " ".repeat(fill))
    } else {
        format!("{s}{}", " ".repeat(fill))
    }
}

fn table(rows: &[Vec<String>], headers: &[&str], aligns: &[bool]) -> String {
    let mut widths: Vec<usize> = headers.iter().map(|h| utf16_len(h)).collect();
    for row in rows {
        for (i, c) in row.iter().enumerate() {
            widths[i] = widths[i].max(utf16_len(c));
        }
    }
    let line = |cells: &[String]| {
        let joined: Vec<String> = cells
            .iter()
            .enumerate()
            .map(|(i, c)| pad(c, widths[i], aligns.get(i).copied().unwrap_or(false)))
            .collect();
        joined.join("  ").trim_end().to_owned()
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

fn print_rank(ch: &Value, rows: &Value, values: &Values, current: &Value) -> String {
    let mut all: Vec<Value> = Vec::new();
    if current.truthy() {
        all.push(current.clone());
    }
    all.extend(rows.items().iter().cloned());
    let table_rows: Vec<Vec<String>> = all
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let name = if current.truthy() && i == 0 {
                format!("{} (equipped)", cell(r.get("name")))
            } else {
                format!("{} {}", cell(r.get("materialName")), cell(r.get("name")))
            };
            vec![
                name,
                cell(r.get("skill")),
                if r.get("twoHanded").truthy() {
                    "2H".to_owned()
                } else {
                    "1H".to_owned()
                },
                fmt(r.get("dps")),
                fmt(r.get("cappedDps")),
                fmt(r.get("perSwing")),
                fmt2(r.get("aps")),
                pc(r.get("hit")),
                pc(r.get("crit")),
            ]
        })
        .collect();
    let table = table(
        &table_rows,
        &[
            "Weapon",
            "Skill",
            "Hands",
            "DPS",
            "Capped",
            "Per swing",
            "APS",
            "Hit",
            "Crit",
        ],
        &[false, false, false, true, true, true, true, true, true],
    );
    format!(
        "{}  |  {}{}  |  target {}\n\n{}",
        character_label(ch),
        values.core,
        if ch.get("online").truthy() {
            " / online"
        } else {
            " / offline"
        },
        values.target,
        table
    )
}

// ---------------------------------------------------------------------------------------------------------------
// the build card (src/cli.js printBuild, allowanceRows, weaponLabel, the table helpers above)
// ---------------------------------------------------------------------------------------------------------------

/// `MARTIAL_PATHS[id]?.name ?? id` for a path id. Deliberately narrow: a JS prototype key such as `toString` would
/// resolve to an inherited function there, which this port does not reproduce (an inherited member is not a path
/// name), so any other id keeps its own text.
fn martial_path_name(id: Value) -> Value {
    let p = &dfo_core::generated::data::MARTIAL_PATHS;
    let name = match id.as_str() {
        Some("blademaster") => p.blademaster.name,
        Some("warblade") => p.warblade.name,
        Some("vanguard") => p.vanguard.name,
        Some("ranger") => p.ranger.name,
        Some("bladedancer") => p.bladedancer.name,
        Some("bloodletter") => p.bloodletter.name,
        Some("cutthroat") => p.cutthroat.name,
        Some("assassin") => p.assassin.name,
        Some("shadowdancer") => p.shadowdancer.name,
        Some("juggernaut") => p.juggernaut.name,
        Some("woodsman") => p.woodsman.name,
        Some("berserker") => p.berserker.name,
        Some("crusader") => p.crusader.name,
        Some("brawler") => p.brawler.name,
        Some("windrunner") => p.windrunner.name,
        _ => return id,
    };
    Str(name.to_owned())
}

/// `weaponLabel` (`src/cli.js:269`): `Material Name`, unless the name already carries the material.
fn weapon_label(w: &Value) -> String {
    if !w.truthy() {
        return "bare hands".to_owned();
    }
    let name = w.get("name").to_js_string();
    let material = w.get("materialName").to_js_string();
    if name.starts_with(&material) {
        name
    } else {
        format!("{material} {name}")
    }
}

/// `r.health.toLocaleString()` (en-US grouping; the same formatter the enchant plan pins). Every caller guards the
/// value with its JS truthiness first, and `health` is finite by construction (`finite_or`), so the formatter only sees
/// a finite number.
fn grouped(v: &Value) -> String {
    dfo_core::enchant_plan::grouped_number_of(v.to_number())
}

/// `allowanceRows` (`src/cli.js:729-737`): the relay's verdict, one named row per metric.
fn allowance_rows(a: &Value) -> Vec<Vec<String>> {
    let law = a.get("law");
    let dry = a.get("dryAt");
    vec![
        vec![
            "Allowance-sustained DPS".to_owned(),
            fmt(a.get("sustainedDps")),
            format!(
                "the allowance's refill {}/s{}",
                fmt(law.get("rate")),
                if a.get("saturated").truthy() {
                    " - this build exceeds it, so it is the limit"
                } else {
                    " - this build is below it"
                }
            ),
        ],
        vec![
            "Opening burst".to_owned(),
            fmt(a.get("burst5Dps")),
            format!(
                "first 5 s: the {} bucket plus refill{}",
                fmt(law.get("depth")),
                // JS `a.dryAt != null`: a spent bucket at exactly 0 s is a real value (only null/undefined mean "never").
                // JS `a.dryAt != null`: a spent bucket at exactly 0 s is a real value (only null/undefined mean "never").
                if dry.is_nullish() {
                    "; never spent".to_owned()
                } else {
                    format!("; spent after {} s", fmt(dry))
                }
            ),
        ],
        vec![
            "Kill-average DPS".to_owned(),
            if a.get("averageDps").truthy() {
                fmt(a.get("averageDps"))
            } else {
                "-".to_owned()
            },
            format!(
                "{} HP share over the whole fight, shields included",
                fmt(a.get("share"))
            ),
        ],
        vec![
            "Allowance kept".to_owned(),
            pc(a.get("landedShare")),
            "of the claims that won a blow token, the part the relay accepted".to_owned(),
        ],
    ]
}

/// The what-if scenario `printBuild` hands `marginals` and `rankAffixes` (`src/cli.js:794-808`): the card's target
/// and traits, not the full `scenarioOf` record (no pair/dual/bowSpam/potency/pierce).
fn whatif_scenario(r: &dfo_core::analyze::Analysis, values: &Values) -> Value {
    let card = r.to_value();
    let health = card.get("health");
    obj([
        ("target", card.get("target").clone()),
        ("core", card.get("core").clone()),
        ("traits", card.get("traits").clone()),
        (
            "health",
            if health.truthy() {
                health.clone()
            } else {
                Num(0.0)
            },
        ),
        ("swing", Str(values.swing.clone())),
        ("passiveOn", Bool(values.passive_on)),
        ("stacks", Num(values.num("stacks", 5.0))),
        ("rhythm", Bool(values.rhythm)),
        ("unaware", Bool(values.unaware)),
        ("firstBlow", Bool(values.first_blow)),
        ("healthShare", Num(values.num("health-share", 1.0))),
        (
            "backstabUptime",
            Num(if values.behind {
                1.0
            } else {
                values.num("backstab", 0.0)
            }),
        ),
        ("critDamage", Bool(values.crit_damage)),
        ("rri", Bool(values.rri)),
    ])
}

/// `printBuild` (`src/cli.js:739-821`).
fn print_build(
    ch: &Value,
    r: &dfo_core::analyze::Analysis,
    target_preset: &str,
    values: &Values,
    book: &Spellbook,
) -> String {
    let card = r.to_value();
    let w = card.get("weapon");
    let traits = card.get("traits");
    let mut out = String::new();
    out.push_str(&format!("{}\n", character_label(ch)));
    let path = ch.get("martialPath");
    out.push_str(&format!(
        "{}{}{}  |  {}{}{}\n",
        weapon_label(w),
        if card.get("dual").truthy() {
            " / dual"
        } else {
            ""
        },
        if card.get("pair").truthy() {
            " / pair"
        } else {
            ""
        },
        cell(card.get("core")),
        if ch.get("online").truthy() {
            " / online"
        } else {
            " / offline"
        },
        if path.truthy() {
            format!(" / {}", martial_path_name(path.clone()).to_js_string())
        } else {
            String::new()
        },
    ));
    let health = card.get("health");
    out.push_str(&format!(
        "target: {}{}, level {}{}{}\n",
        target_preset,
        if card.get("target").get("isClass").truthy() {
            " (class)"
        } else {
            ""
        },
        card.get("target").get("level").to_js_string(),
        if health.truthy() {
            format!(", {} HP", grouped(health))
        } else {
            String::new()
        },
        if traits.items().is_empty() {
            String::new()
        } else {
            format!(
                ", traits: {}",
                traits
                    .items()
                    .iter()
                    .map(|v| v.to_js_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        },
    ));
    out.push('\n');

    let has_allowance = card.get("target").get("allowance").truthy();
    let totals = &r.totals;
    let ttk_line = if let Some(t) = totals.total_ttk {
        format!("{} s", fmt(&Num(t)))
    } else if card.get("allowance").truthy() {
        "no kill".to_owned()
    } else if has_allowance {
        "no allowance run".to_owned()
    } else {
        "-".to_owned()
    };
    let ttk_label = if has_allowance {
        "Time to kill (allowance-sustained)"
    } else {
        "Time to kill (per-hit-capped ceiling)"
    };
    let ttk_note = if health.truthy() {
        format!(
            "{} HP{}{}",
            grouped(health),
            if card.get("ward").truthy() {
                format!(" + {} ward", card.get("ward").to_js_string())
            } else {
                String::new()
            },
            if has_allowance {
                format!(
                    "; ceiling: {}",
                    totals
                        .ceiling_total_ttk
                        .map_or("-".to_owned(), |t| format!("{} s", fmt(&Num(t))))
                )
            } else if card.get("enchantDps").to_number() > 0.0 {
                " (weapon + procs)".to_owned()
            } else {
                String::new()
            }
        )
    } else {
        "no boss health".to_owned()
    };
    let damage = card.get("damage");
    let hit = card.get("hit");
    let backstab = card.get("backstab");
    let cadence = card.get("cadence");
    let mut rows: Vec<Vec<String>> = vec![vec![
        "Hit chance".to_owned(),
        pc(hit.get("hit")),
        format!(
            "{} critical, x{}",
            pc(hit.get("crit").get("chance")),
            fmt2(hit.get("crit").get("damageMult"))
        ),
    ]];
    let has_backstab = backstab.get("chance").to_number() > 0.0;
    if has_backstab {
        rows.push(vec![
            "Backstab".to_owned(),
            format!("{} x3", pc(backstab.get("chance"))),
            if backstab.get("uptime").to_number() > 0.0 {
                format!(
                    "uptime {}; expected x{}",
                    pc(backstab.get("uptime")),
                    fmt2(backstab.get("expectedMult"))
                )
            } else {
                "available; use --behind".to_owned()
            },
        ]);
    }
    rows.push(vec![
        "Damage / hit".to_owned(),
        format!(
            "{}-{}",
            damage.get("min").to_js_string(),
            damage.get("max").to_js_string()
        ),
        format!(
            "avg {}; crit {}-{}",
            fmt(damage.get("avg")),
            damage.get("critMin").to_js_string(),
            damage.get("critMax").to_js_string()
        ),
    ]);
    if has_backstab {
        rows.push(vec![
            "Backstab hit".to_owned(),
            format!(
                "{}-{}",
                backstab.get("min").to_js_string(),
                backstab.get("max").to_js_string()
            ),
            format!(
                "crit {}-{}",
                backstab.get("critMin").to_js_string(),
                backstab.get("critMax").to_js_string()
            ),
        ]);
    }
    rows.push(vec![
        "Expected / swing".to_owned(),
        fmt(card.get("perSwing")),
        "hit chance and criticals included".to_owned(),
    ]);
    rows.push(vec![
        "Swing time".to_owned(),
        format!("{} s", fmt2(cadence.get("seconds"))),
        format!("{} swings/s", fmt2(cadence.get("aps"))),
    ]);
    let cap = card.get("cap");
    rows.push(vec![
        "Uncapped weapon DPS".to_owned(),
        fmt(card.get("dps")),
        if cap.truthy() {
            format!(
                "per-hit-capped {} ({} lost) - a ceiling{}",
                fmt(card.get("cappedDps")),
                pc(card.get("capLoss")),
                if has_allowance {
                    ", not what the boss accepts"
                } else {
                    ""
                }
            )
        } else {
            "no per-hit cap".to_owned()
        },
    ]);
    if card.get("enchantDps").to_number() > 0.0 {
        let before = card.get("procsBeforeBreak");
        rows.push(vec![
            "Enchant procs (ceiling component)".to_owned(),
            fmt(card.get("enchantDps")),
            format!(
                "{} per landed hit{}",
                fmt(card.get("enchantPerSwing")),
                if before.truthy() {
                    format!(
                        "; {}",
                        dfo_core::enchants::bill_capacity_note(before.to_number())
                    )
                } else {
                    String::new()
                }
            ),
        ]);
        rows.push(vec![
            "Total (per-hit-capped ceiling)".to_owned(),
            fmt(card.get("ceilingTotalDps")),
            "capped weapon + proc estimate before allowance".to_owned(),
        ]);
    }
    if let Some(a) = match card.get("allowance") {
        Null | Undefined => None,
        v => Some(v.clone()),
    } {
        rows.extend(allowance_rows(&a));
    }
    rows.push(vec![ttk_label.to_owned(), ttk_line, ttk_note]);
    out.push_str(&format!(
        "{}\n",
        table(&rows, &["Metric", "Value", "Notes"], &[false, false, false])
    ));

    // `ttkGap` is truthiness-guarded on both figures, so a 0 reads as "no gap".
    let claim_ttk = totals.claim_total_ttk;
    let ceiling_ttk = totals.ceiling_total_ttk;
    let gap = match (claim_ttk, ceiling_ttk) {
        (Some(claim), Some(ceiling)) if claim != 0.0 && ceiling != 0.0 => {
            Some((claim - ceiling).abs() / claim)
        }
        _ => None,
    };
    if card.get("allowance").truthy()
        && ceiling_ttk.is_some_and(|c| c != 0.0)
        && (claim_ttk.is_none() || gap.is_some_and(|g| g > 0.01))
    {
        let ceiling = ceiling_ttk.unwrap();
        let figures = match (claim_ttk, gap) {
            (None, _) => format!(
                "ceiling {} s; the allowance-sustained run never kills - the ceiling can promise a kill the allowance refuses",
                fmt(&Num(ceiling))
            ),
            (Some(claim), Some(_)) if claim > ceiling => format!(
                "ceiling {} s; allowance-sustained {} s - the ceiling can promise a kill the allowance refuses",
                fmt(&Num(ceiling)),
                fmt(&Num(claim))
            ),
            (Some(claim), Some(g)) => format!(
                "ceiling {} s; allowance-sustained {} s - ceiling and allowance-sustained differ by {}",
                fmt(&Num(ceiling)),
                fmt(&Num(claim)),
                pc(&Num(g))
            ),
            // Unreachable: the guard above needs a gap above 0.01 when the claim run exists.
            (Some(claim), None) => format!(
                "ceiling {} s; allowance-sustained {} s",
                fmt(&Num(ceiling)),
                fmt(&Num(claim))
            ),
        };
        out.push_str(&format!("\nCeiling vs allowance: {figures}.\n"));
    }
    if cap.truthy() {
        out.push_str(&format!(
            "\n{}: {} per hit{}.\n",
            if card.get("capSource").is_str("hit cap") {
                "Per-hit hit cap"
            } else {
                "Curbing cap"
            },
            cap.to_js_string(),
            if card.get("capSource").is_str("curbing") {
                format!(" (5% of {} HP)", grouped(health))
            } else {
                String::new()
            }
        ));
    }
    let target = card.get("target");
    if target.get("phaseShields").truthy() {
        out.push_str(&format!(
            "Phase shields: {} x {}s ({}s added to ceiling TTK).\n",
            target.get("phaseShields").to_js_string(),
            target.get("shieldSeconds").to_js_string(),
            card.get("shields").to_js_string()
        ));
    }
    if card.get("wrath").truthy() {
        out.push_str(&format!(
            "Wrathful: enrages at {}s.\n",
            card.get("wrathAt").to_js_string()
        ));
    }

    out.push_str("\nWhere the damage comes from\n");
    let p = damage.get("parts");
    let roll = p.get("roll");
    let signed = |v: &Value| {
        format!(
            "{}{}",
            if v.to_number() >= 0.0 { "+" } else { "" },
            v.to_js_string()
        )
    };
    out.push_str(&format!(
        "{}\n",
        table(
            &[
                vec![
                    "weapon roll".to_owned(),
                    format!(
                        "{}-{}",
                        roll.at(0).to_js_string(),
                        roll.at(1).to_js_string()
                    ),
                ],
                vec![
                    "material".to_owned(),
                    format!(
                        "{} ({})",
                        signed(p.get("matMod")),
                        if w.truthy() {
                            w.get("materialName").to_js_string()
                        } else {
                            "-".to_owned()
                        }
                    ),
                ],
                vec![
                    "strength".to_owned(),
                    format!(
                        "{}{}",
                        signed(p.get("strMod")),
                        if p.get("twoHanded").truthy() {
                            " (two-handed x2)"
                        } else {
                            ""
                        }
                    ),
                ],
                vec!["proficiency".to_owned(), signed(p.get("prof"))],
                vec!["race".to_owned(), signed(p.get("racial"))],
                vec![
                    "mastery / gear".to_owned(),
                    format!("{}%", fmt(p.get("mastery"))),
                ],
                vec!["martial".to_owned(), format!("{}%", fmt(p.get("martial")))],
                vec!["slayer".to_owned(), format!("{}%", fmt(p.get("slayer")))],
                vec![
                    "hit terms".to_owned(),
                    format!(
                        "base {}, armor {}, other {}",
                        hit.get("terms").get("base").to_js_string(),
                        hit.get("terms").get("armour").to_js_string(),
                        hit.get("terms").get("other").to_js_string()
                    ),
                ],
                vec![
                    "speed".to_owned(),
                    format!(
                        "tick {}s, heft {}, handling {}, pace {}%",
                        fmt2(cadence.get("tick")),
                        fmt2(cadence.get("heft")),
                        fmt2(cadence.get("handling")),
                        fmt(cadence.get("pace"))
                    ),
                ],
            ],
            &["Term", "Value"],
            &[false, false],
        )
    ));

    let marginal_ch = match values.weapon {
        Some((tpl, mat)) => {
            let mut c = dfo_core::analyze::json_clone(ch);
            c.set(
                "weapon",
                synthetic_weapon(&Num(tpl), &Num(mat), values.rri)
                    .get("item")
                    .clone(),
            );
            c
        }
        None => ch.clone(),
    };
    let whatif = whatif_scenario(r, values);
    let base = if cap.truthy() { "capped DPS" } else { "DPS" };
    let ms = marginals(&marginal_ch, r, &whatif, book);
    out.push_str(&format!("\nWhat matters ({base})\n"));
    out.push_str(&format!(
        "{}\n",
        table(
            &ms.items()
                .iter()
                .map(|m| {
                    let delta = m.get("delta").to_number();
                    vec![
                        m.get("label").to_js_string(),
                        format!(
                            "{}{}",
                            if delta >= 0.0 { "+" } else { "" },
                            fmt(m.get("delta"))
                        ),
                        format!(
                            "{}{}%",
                            if delta >= 0.0 { "+" } else { "" },
                            fmt(m.get("pct"))
                        ),
                    ]
                })
                .collect::<Vec<_>>(),
            &[
                "Change",
                if cap.truthy() { "Capped DPS" } else { "DPS" },
                "%"
            ],
            &[false, true, true],
        )
    ));
    let affixes = rank_affixes(&marginal_ch, r, &whatif, book);
    out.push_str(&format!("\nAffixes / enchants ({base})\n"));
    out.push_str(&format!(
        "{}\n",
        table(
            &affixes
                .items()
                .iter()
                .map(|m| {
                    let delta = m.get("delta").to_number();
                    vec![
                        m.get("label").to_js_string(),
                        format!(
                            "{}{}",
                            if delta >= 0.0 { "+" } else { "" },
                            fmt(m.get("delta"))
                        ),
                        format!(
                            "{}{}%",
                            if delta >= 0.0 { "+" } else { "" },
                            fmt(m.get("pct"))
                        ),
                    ]
                })
                .collect::<Vec<_>>(),
            &[
                "Change",
                if cap.truthy() { "Capped DPS" } else { "DPS" },
                "%"
            ],
            &[false, true, true],
        )
    ));
    let ranking = rank_weapons(ch, &whatif, &obj([("top", Num(8.0))]), book);
    out.push_str("\nTop melee weapons\n");
    out.push_str(&table(
        &ranking
            .items()
            .iter()
            .map(|x| {
                vec![
                    format!(
                        "{} {}",
                        x.get("materialName").to_js_string(),
                        x.get("name").to_js_string()
                    ),
                    if x.get("twoHanded").truthy() {
                        "2H".to_owned()
                    } else {
                        "1H".to_owned()
                    },
                    fmt(x.get("dps")),
                    fmt(x.get("cappedDps")),
                    fmt(x.get("perSwing")),
                    fmt2(x.get("aps")),
                ]
            })
            .collect::<Vec<_>>(),
        &["Weapon", "Hands", "DPS", "Capped", "Per swing", "APS"],
        &[false, false, true, true, true, true],
    ));
    out
}

// ---------------------------------------------------------------------------------------------------------------
// JSON.stringify(v, null, 2): the only encoder --json needs (undefined omitted in objects, null in arrays)
// ---------------------------------------------------------------------------------------------------------------

fn json(v: &Value) -> String {
    let mut out = String::new();
    write_json(v, 0, &mut out);
    out
}

fn write_json(v: &Value, level: usize, out: &mut String) {
    match v {
        Undefined | Null => out.push_str("null"),
        Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Num(n) => {
            if n.is_finite() {
                out.push_str(&number_to_string(*n));
            } else {
                out.push_str("null");
            }
        }
        Str(s) => write_json_string(s, out),
        Arr(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                push_indent(level + 1, out);
                write_json(item, level + 1, out);
            }
            out.push('\n');
            push_indent(level, out);
            out.push(']');
        }
        Obj(entries) => {
            let entries: Vec<_> = entries
                .iter()
                .filter(|(_, v)| !matches!(v, Undefined))
                .collect();
            if entries.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push_str("{\n");
            for (i, (k, val)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                push_indent(level + 1, out);
                write_json_string(k, out);
                out.push_str(": ");
                write_json(val, level + 1, out);
            }
            out.push('\n');
            push_indent(level, out);
            out.push('}');
        }
    }
}

fn push_indent(level: usize, out: &mut String) {
    for _ in 0..level {
        out.push_str("  ");
    }
}

fn write_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    // Local invariants (not oracle checks): these pin the JS facts the formatters must reproduce, each read from the
    // real engine while writing this port (`(-0).toFixed(1)` is `"0.0"`, `String(-0)` is `"0"`).
    #[test]
    fn padded_zero_is_unsigned_like_to_fixed() {
        assert_eq!(fmt(&Num(-0.0)), "0.0");
        assert_eq!(fmt(&Num(-0.04)), "0.0");
        assert_eq!(fmt(&Num(-0.06)), "-0.1");
        assert_eq!(fmt2(&Num(-0.0)), "0.00");
        assert_eq!(fmt2(&Num(-0.004)), "0.00");
        // `Math.round(-0.001 * 100)` is `-0`, and `(-0).toFixed(2)` is `"0.00"`.
        assert_eq!(fmt2(&Num(-0.001)), "0.00");
        assert_eq!(fmt2(&Num(-0.04)), "-0.04");
        assert_eq!(fmt2(&Num(-0.006)), "-0.01");
        assert_eq!(pc(&Num(-0.0)), "0%");
        assert_eq!(pc(&Num(-0.004)), "0%");
        assert_eq!(pc(&Num(-0.006)), "-1%");
        assert_eq!(pc(&Num(-0.04)), "-4%");
        // `String` keeps the exponent form a huge number rounds to (`1e+21`), not a long digit run.
        assert_eq!(pc(&Num(1e19)), "1e+21%");
        // `toFixed` switches to `String(x)` at 1e21 and above, after the rounding step.
        assert_eq!(fmt(&Num(1e20)), "100000000000000000000.0");
        assert_eq!(fmt(&Num(1e21)), "1e+21");
        assert_eq!(fmt(&Num(1.5e21)), "1.5e+21");
        assert_eq!(fmt2(&Num(1e21)), "999999999999999868928.00");
        assert_eq!(fmt2(&Num(1.5e21)), "1.5e+21");
    }

    #[test]
    fn allowance_dry_at_zero_is_spent_not_never() {
        let report = obj([
            (
                "law",
                obj([
                    ("rate", Num(150.0)),
                    ("depth", Num(750.0)),
                    ("share", Num(12000.0)),
                ]),
            ),
            ("sustainedDps", Num(150.0)),
            ("saturated", Bool(true)),
            ("burst5Dps", Num(259.6)),
            // JS `dryAt != null` is true for 0; only null/undefined mean "never spent".
            ("dryAt", Num(0.0)),
            ("averageDps", Num(157.9)),
            ("share", Num(12000.0)),
            ("landedShare", Num(0.22)),
        ]);
        let rows = allowance_rows(&report);
        assert_eq!(
            rows[1][2],
            "first 5 s: the 750.0 bucket plus refill; spent after 0.0 s"
        );
        let mut never = report.clone();
        never.set("dryAt", Null);
        assert_eq!(
            allowance_rows(&never)[1][2],
            "first 5 s: the 750.0 bucket plus refill; never spent"
        );
    }

    #[test]
    fn table_widths_count_utf16_units() {
        // `'あ'.length === 1`; Rust `'あ'.len_utf8()` is 3. A two-character name must pad to the header's width, not
        // past it, so a table of CJK text keeps JS's column alignment.
        assert_eq!(utf16_len("あ"), 1);
        assert_eq!(utf16_len("😀"), 2);
        assert_eq!(pad("あい", 5, false), "あい   ");
        assert_eq!(pad("あい", 5, true), "   あい");
        assert_eq!(pad("😀", 3, false), "😀 ");
        let out = table(
            &[vec!["あ".to_owned(), "1".to_owned()]],
            &["名前", "n"],
            &[false, true],
        );
        // The JS oracle for these exact inputs: `header.length` counts UTF-16 units (NOT bytes), so the column is two
        // wide and `あ` pads with one space, never with three.
        assert_eq!(out, "名前  n\n--  -\nあ   1");
    }
}
