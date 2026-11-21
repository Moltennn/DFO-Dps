//! `dfo-cli`: the thin command line over `dfo-core` (R8, the `rank --theory` slice).
//!
//! This is the JS `src/cli.js` `rank` path, and only that: [`main`] parses the flags the rank card reads, replays
//! the JS validation (`numFlag`, the enum checks) with the same messages, builds the level-45 theory character, the
//! target and the scenario, then prints `printRank` or `{ character, weapons, current }` as `--json` does.
//! No save is read or written (R8's I/O lands later): `rank` without `--theory` fails explicitly, and every flag the
//! slice does not price is refused by name instead of being accepted and ignored.
//!
//! Every rule lives in `dfo-core`; this file owns argument text, the two output formats and exit codes (a usage
//! error is 2, as `bin/dfo-dps.js` does).

use std::collections::HashMap;
use std::process::ExitCode;

use dfo_core::analyze::{
    boss_target, current_weapon_row, gate_target, rank_weapons, reference_foe,
};
use dfo_core::encounters::{encounter_by_id, encounter_target, ENCOUNTER_IDS};
use dfo_core::generated::data::{BOSS_TRAITS, WEAPONS};
use dfo_core::generated::level_cap::LEVEL_CAP;
use dfo_core::generated::theory::{DEFAULT_BLADE, THEORY_LEVEL, THEORY_RACES};
use dfo_core::maxprofile::Profiles;
use dfo_core::round::math_round;
use dfo_core::save::character_label;
use dfo_core::spells::Spellbook;
use dfo_core::theory::theory_character;
use dfo_core::value::{number_to_string, string_to_number, Value, Value::*};

const HELP: &str = "\
dfo-cli - the rank slice of dfo-dps (Rust core)

Usage:
  dfo-cli rank [weapons] --theory [options]

Rank every melee template/material for the level-45 theory character. No save is read; `rank` without
--theory fails. Text is the JS `rank` card; --json is `{ character, weapons, current }`.

Flags:
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

Unsupported here (they need a save or another command): --save, --offline, --passive, --bare, --encounter,
--out and the other commands' flags.";

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
                "the \"{command}\" command is not ported yet; this slice supports only `rank --theory`"
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
    rank(&values)
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
    "no-effects",
);

fn in_flags(list: &str, name: &str) -> bool {
    list.split_whitespace().any(|f| f == name)
}

const BOOLEAN_FLAGS: &str = concat!(
    "theory json vampire firmament rhythm unaware first-blow behind pair dual spam no-crit-damage no-passive ",
    "no-rri help offline bare no-effects",
);

const MULTI: [&str; 2] = ["star-stat", "star-skill"];

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
                "--{name} is not supported by the rank slice (it needs a save, another command, or is not ported yet)"
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
    if !values.theory {
        return Err(usage(
            "rank without --theory needs a save; the Rust slice has no save I/O yet (pass --theory)",
        ));
    }
    let book = Spellbook::default();
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

fn character(values: &Values, book: &Spellbook) -> Result<Value, CliError> {
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
    if let Some(v) = values.base_stats {
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
    Ok(ch)
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
        // The JS remap: `armoured` is a reference preset, but the theory character prices the gate.
        "armoured" | "gate" | "breach" | "ruhn" => {
            let mut opts = obj([
                ("players", Num(values.num("players", 1.0))),
                ("blowX", Num(values.num("blow-x", 1.0))),
            ]);
            if values.nums.contains_key("health") {
                opts.set("health", Num(values.num("health", 0.0)));
            }
            if !traits.is_empty() {
                opts.set("traits", trait_list());
            }
            gate_target(&Num(level), &opts)
        }
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

fn fmt(v: &Value) -> String {
    let n = v.to_number();
    if n.is_finite() {
        format!("{:.1}", math_round(n * 10.0) / 10.0)
    } else {
        "-".to_owned()
    }
}

fn fmt2(v: &Value) -> String {
    let n = v.to_number();
    if n.is_finite() {
        format!("{:.2}", math_round(n * 100.0) / 100.0)
    } else {
        "-".to_owned()
    }
}

fn pc(v: &Value) -> String {
    let n = v.to_number();
    if n.is_finite() {
        format!("{}%", math_round(n * 100.0))
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

fn table(rows: &[Vec<String>], headers: &[&str], aligns: &[bool]) -> String {
    let mut widths: Vec<usize> = headers.iter().map(|h| h.len()).collect();
    for row in rows {
        for (i, c) in row.iter().enumerate() {
            widths[i] = widths[i].max(c.len());
        }
    }
    let line = |cells: &[String]| {
        let joined: Vec<String> = cells
            .iter()
            .enumerate()
            .map(|(i, c)| {
                if aligns.get(i).copied().unwrap_or(false) {
                    format!("{:>width$}", c, width = widths[i])
                } else {
                    format!("{:<width$}", c, width = widths[i])
                }
            })
            .collect();
        joined.join("  ").trim_end().to_owned()
    };
    let header: Vec<String> = headers.iter().map(|h| (*h).to_owned()).collect();
    let mut out = vec![
        line(&header),
        line(
            &headers
                .iter()
                .map(|h| "-".repeat(h.len()))
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
