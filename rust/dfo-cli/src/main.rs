//! `dfo-cli`: the thin command line over `dfo-core` (R8; the `saves`, `build`, `objective`, `rank`, `compare`, `scale`,
//! `doctor`, `probe`, `graph`, `report`, `firmament`, `imprints`, `enchant`, `enchant-plan`/`gear-plan`, `tradeoff`,
//! `spell`, `spells`, `theory`, `weapons`/`skills` and `loadout`/`real-dps` slice).
//!
//! This is the JS `src/cli.js` `build` card, `objective` command, `rank` card, `compare` card, `scale` curve, `saves`
//! listing, `doctor`, `probe`, `graph`, `report`, `firmament`, `imprints`, `enchant`, `enchant-plan`/`gear-plan`,
//! `tradeoff`, `spell`, `spells` and `theory`,
//! and only that: [`main`] parses the flags those read, replays the JS validation (`numFlag`, the enum checks,
//! `sampledOptions`) with the same messages, builds either the level-45 theory character or the one an imported save
//! describes, the target and
//! the scenario, then prints `printBuild`,
//! `printObjective`, `printRank`, the `compare` table, `printScale` or `{ character, weapons, current }` as `--json`
//! does. `build --json` prints `summary()` and `objective --json` prints the evaluated row; `build`'s text card is
//! `printBuild` with the what-ifs the JS runs after it. `compare` is the table `compare` prints after applying `--stat`
//! and `--weapon`; `scale` is one channel's curve, or `--all`'s current-to-cap summary. `doctor` prints
//! the save/build/ruleset summary over the same imported character. `probe` reads a Combat Probe capture read-only: its
//! discovery, terminal card, JSON document and HTML report page live in [`probe`], its rules are `dfo_core::probe`, and
//! the page's markup comes from [`graph`] (the `src/graph.js` port). The page is written in both modes, as the JS does
//! (`probe.html`, or `--out <file>`), and only the text mode prints the JS `probe page written:` line. `graph` prices one
//! `--series` channel over `--from`..`--to` (`src/cli.js:2057-2127`), writes `graph.html` (or `--out`) through the same
//! create-only writer, and prints the JS `graph written:` line (text) or the series document (`--json`). `report` renders
//! `src/report.js` `buildReport` (the page lives in [`report`], pure data in and HTML out) at the shared scenario, writes
//! `dfo-dps-report.html` (or `--out`) through the same writer, and prints the JS `report written:` line. `firmament`
//! plans each `--build` at `--stars` (`dfo_core::firmament::plan_build`), prints the JS card or its `--json` document,
//! and writes `firmament.html` (or `--out`) from [`firmament::firmament_section`] through the same [`graph`] page. All
//! four page writes are create-only (`O_CREAT|O_EXCL`): an existing file - the capture, the graph's own input save, an
//! unrelated save or report, or any hard/symlink alias - is refused with exit 2 and left untouched, where the JS would
//! truncate it. Reports must target a new path.
//!
//! `imprints` renders `dfo_core::imprints::rank_all` through [`imprints`] (the `src/cli.js:1219-1263` card and page):
//! `--family` picks one family after the ranking (an unknown one is the JS's stderr line and exit 2), `--sort` takes
//! `boss`/`uncapped`/`conditional`, and the resolved order is `--uncapped` first, then `--cap-aware` (boss), then
//! `--sort`. It writes `imprints.html` (or `--out`, create-only, renaming the default report name as `probe`/`graph`
//! do) and prints the JS `imprints page written:` line in text mode, or the JS `--json` document instead. No save is
//! read: the rows are the theory max profiles, as the JS branch's `rankAll` call is.
//!
//! `enchant` renders the equipped weapon's enchantment rows and Cast When Strikes price (`src/cli.js:1449-1477`) through
//! [`enchant`] (pure data in, strings out): the card is [`enchant::text`], the `--json` object [`enchant::document`], and
//! the procs are priced by `dfo_core::enchants` from the launcher's `SPELLS.STD` (`saves::load_spellbook`). The target is
//! the branch's own: a raw `--target armoured` is the Breach gate here too (not the reference foe `target_of` prices), and
//! `analyze` reruns at that target with the branch's `potency`/`pierce`. A character with no weapon prints the JS
//! `No weapon equipped.` line and exits 0.
//!
//! `spell` is the whole singular branch (`src/cli.js:1516-1599`): the one-spell rotation card, the `--list` spellbook
//! table and the `--all-spells` price table, text or `--json`, from [`spell`] (pure data in, strings out).
//! `--standard` shows every standard record, and the theory caster tweak is applied inside the branch. The book is the JS
//! `standardSpells()` one, including its module cache: a resolvable launcher `config.json` -> `arena2Path` wins over
//! `--data`, which is read only when the launcher has no usable config (see [`saves::standard_spells`]). `--json` with
//! `--list` is refused as the JS `checkOutputFlags` refuses it ("spell --list"); `--all-spells` keeps the JS double
//! output (table, then the `--json` document), because that branch prints through `console.log`. A `--standard` run whose
//! pool prices nothing reproduces the JS destructuring crash (exit 1) rather than inventing a card.
//!
//! `spells` is the plural branch (`src/cli.js:1480-1514`): every standard damage spell priced by `spellRotation` over the
//! requested window, ranked by window DPS, rendered by [`spells_report`] as the `DFO spell ceiling` page (two bar charts
//! and the top-20 table) or its `--json` list. Its pool is the JS merge `[...standard.values(), ...known.filter(!standard
//! .has(index))]` - every standard record in the book's own order, then the save's custom records - not the singular
//! `pool`; an empty list is the JS `No standard damage spells found. Check --data / ARENA2.` line, exit 0, no page.
//!
//! `weapons` and its alias `skills` render the level-45 weapon ceiling page through [`weapons`] (`src/cli.js:1601-1804`):
//! the melee and dual-pair rows, the relay/uncapped sections, and - unless `--categories` - one skill curve per weapon
//! family plus the Critical Strike curve. `--categories` condenses the rows to one winner per type per slot. Every row is
//! the shared `analyze`; the branch's `makeMax` never passes `--level`, so the characters stay level 45 and `--level` only
//! moves the reference foe and the Breach. The page is create-only, as `report`'s is, and the JS prints
//! `weapons page written:` only in text mode; `--json` prints `{ level, firmCharts, rows, cs }` in both modes.
//!
//! `loadout` and its alias `real-dps` are the whole `src/cli.js:961-1082` branch: with `--shortlist <K>` the sampled
//! ranking card (or its `--json` document), otherwise the every-template report ([`loadout::report_text`], the
//! `loadouts.html` page from [`loadout::report_page`] through the same create-only writer, or the row list with
//! `--json`). `--uncapped`/`--cap-aware` pick the modes, `--encounter`/`--all-encounters` the cap-aware bodies. The rows
//! are `dfo_core::real_build::real_weapon_loadouts`, the rankings `dfo_core::loadout_shortlist::shortlist_loadouts`, the
//! imprint ratings `dfo_core::imprints::rank_all`, and the plan table `dfo_core::firmament::plan_build`/`plan_summary`;
//! the module owns only the JS presentation. A shortlist validation failure (`RangeError`-shape) is exit 2, as
//! `isUsageFailure` decides it for the JS.
//!
//! The JS `firmament` command also keeps a disk cache (`.cache/firmament-plans.json`, keyed by a source fingerprint) and
//! its card starts `Firmament plans (N cached, M computed)`. This CLI writes no cache at all: a plan is a pure function of
//! its build and purse, every run replans, and the card says `Firmament plans` with no counts, because reporting a cache
//! hit it never had would be an invented fact. `--refresh` is accepted and changes nothing (there is no cache to
//! invalidate); a plan's numbers are identical either way.
//!
//! The save is imported READ-ONLY by [`saves`]: discovery and parsing live there, the character normalisation is
//! `dfo_core::save::character_from_save`, and nothing is retained or written (AGENTS.md rule 11). Every flag this
//! slice does not price, and every other command, is refused by name instead of being accepted and ignored.
//!
//! Every rule lives in `dfo-core`; this file owns argument text, the two output formats and exit codes (a usage
//! error is 2, as `bin/dfo-dps.js` does).

// The shared renderer is a whole port of `src/graph.js`: `probe` uses `lineChart`/`multiGraphPage`, `graph` uses
// `lineChart`/`graphPage`, `firmament` and `imprints` use `multiGraphPage`, and `barChart` serves `imprints`.
mod enchant;
mod enchant_plan;
mod firmament;
#[allow(dead_code)]
mod graph;
mod imprints;
mod loadout;
mod probe;
mod report;
mod saves;
mod spell;
mod spells_report;
mod theory;
mod tradeoff;
mod weapons;

use std::collections::HashMap;
use std::process::ExitCode;

use dfo_core::analyze::{
    analyze, boss_target, current_weapon_row, gate_target, marginals, rank_affixes, rank_weapons,
    reference_foe,
};
use dfo_core::encounters::{encounter_by_id, encounter_target, ENCOUNTER_IDS};
use dfo_core::firmament::{build_by_id, build_ids, plan_build};
use dfo_core::firmament_law::FIRMAMENT_NODES;
use dfo_core::generated::data::{BOSS_TRAITS, RACE_NAMES, SOURCE, WEAPONS};
use dfo_core::generated::level_cap::LEVEL_CAP;
use dfo_core::generated::theory::{DEFAULT_BLADE, THEORY_LEVEL, THEORY_RACES};
use dfo_core::maxprofile::Profiles;
use dfo_core::model_blow::{synthetic_weapon, weapon_of};
use dfo_core::objectives::{
    evaluate_objective, MIN_STOCHASTIC_TRIALS, OBJECTIVE_IDS, STOCHASTIC_OBJECTIVE_IDS,
};
use dfo_core::round::{js_max, math_round};
use dfo_core::save::{character_label, live_stat, skill_name, skill_value};
use dfo_core::spells::{resolve_spells, Spellbook};
use dfo_core::theory::theory_character;
use dfo_core::value::{number_to_string, obj_table_get, string_to_number, Value, Value::*};

const HELP: &str = "\
dfo-cli - the saves, build, objective, rank, compare, doctor, probe, graph, report, firmament, imprints, enchant, enchant-plan, gear-plan, tradeoff, spell, spells, theory, weapons/skills and loadout/real-dps slice of dfo-dps (Rust core)

Usage:
  dfo-cli saves
  dfo-cli doctor [--save <slot|folder|path>] [--offline]
  dfo-cli build [--save <slot|folder|path>] [options]
  dfo-cli build --theory [options]
  dfo-cli objective [--save <slot|folder|path>] [options]
  dfo-cli objective --theory [options]
  dfo-cli rank [weapons] [--save <slot|folder|path>] [options]
  dfo-cli rank [weapons] --theory [options]
  dfo-cli compare [--save <slot|folder|path>] --stat <name=value> [--weapon <template:material>]
  dfo-cli compare --theory --stat <name=value> [--weapon <template:material>]
  dfo-cli scale [--save <slot|folder|path>] (--stat <name> | --skill <id> | --gear-skill <id> | --all) [--from <n>] [--to <n>] [--step <n>] [--json]
  dfo-cli scale --theory (--stat <name> | --skill <id> | --gear-skill <id> | --all) [--from <n>] [--to <n>] [--step <n>] [--json]
  dfo-cli probe [capture.json] [--old] [--level <n>] [--players <n>] [--json] [--out <file>]
  dfo-cli graph [--theory] [--series <spec,...>] [--from <n>] [--to <n>] [--step <n>] [--uncapped] [--json] [--out <file>]
  dfo-cli report [--theory] [--save <slot|folder|path>] [options] [--out <file>]
  dfo-cli firmament [--build <id,...>] [--stars <n>] [--refresh] [--json] [--out <file>]
  dfo-cli imprints [--family <key>] [--sort <boss|uncapped|conditional>] [--uncapped] [--cap-aware] [--vampire] [--firmament] [--json] [--out <file>]
  dfo-cli enchant-plan [--theory] [--weapon <template[:material]>] [--shield <template|none|auto>] [--soul-gem] [--group <undead|daedra|humanoid|animal>] [--repairs <n>] [--regen <n>] [--uncapped | --cap-aware | --all] [--json] [--out <file>]
  dfo-cli gear-plan [same flags as enchant-plan]
  dfo-cli enchant [--theory] [--save <slot|folder|path>] [options] [--json]
  dfo-cli spell [--list | --all-spells | --spell <index|name>] [--theory] [--save <slot|folder|path>] [--data <dir>] [--standard] [options] [--json]
  dfo-cli spells [--theory] [--save <slot|folder|path>] [--data <dir>] [options] [--json] [--out <file>]
  dfo-cli tradeoff [--theory] [--save <slot|folder|path>] [options] [--json]
  dfo-cli theory [--theory] [options] [--json]
  dfo-cli weapons [--categories] [--firmament] [--vampire] [--race <name>] [--level <n>] [--json] [--out <file>]
  dfo-cli skills  [same flags as weapons]
  dfo-cli loadout [--uncapped | --cap-aware] [--encounter <id>] [--all-encounters] [--shortlist <K>] [--json] [--out <file>]
  dfo-cli real-dps [same flags as loadout]

`saves` lists the save folders under the DFO user-data folder (newest first). `doctor` prints the model pin, the
save folders and the imported character's build/ruleset summary. `build` prices one build against one target: with
--theory for the level-45 theory character, otherwise for the imported save (read-only). `objective` scores one build
on one named objective (deterministic or sampled), text or `--json`, and `rank` prices every melee template/material
the same way. `compare` prices the same build twice, before and after the `--stat`/`--weapon` changes. `scale` prices
one channel's DPS curve to its cap (`--stat`, `--skill`, `--gear-skill`), text `printScale` or the `--json` rows, or
`--all`'s current-to-cap summary (text only). `build` prints the JS `printBuild` card; with `--json` it prints
`summary()` instead. `rank` text is the JS card, `--json` is
`{ character, weapons, current }`. `probe` reads a Combat Probe capture (the newest under
~/.local/share/dfo-tools/probe-mod/captures, or a named file), text or `--json`, and writes the report page the JS
writes (`probe.html`, or `--out <file>`): text mode also prints the JS `probe page written:` line. The page is
create-only: an existing file (the capture, a save, a report, any alias) is refused and left untouched, so choose a
new path. `graph` prices one channel per `--series` spec (`stat:<name>`, `skill:<id>`, `gear:<id>` or `star:<name>`)
across `--from`..`--to` by `--step`, writes `graph.html` (or `--out`, also create-only) and prints the JS
`graph written:` line, or the series document with `--json`. `report` writes the single-file HTML page of
`src/report.js` (`dfo-dps-report.html`, or `--out`, also create-only) and prints the JS `report written:` line.
`firmament` plans the star tree for each `--build` (all eight by default) at `--stars`, writes `firmament.html` (or
`--out`, also create-only) and prints the JS `firmament page written:` line, or the plan document with `--json`; the
plans are recomputed every run (no disk cache, and so no `N cached, M computed` counts in the card), where the JS keeps
one in `.cache/firmament-plans.json`. `imprints` ranks every Weapon Legendary's power on each family's best max-profile
weapon (or the one `--family` names), writes `imprints.html` (or `--out`, also create-only) and prints the JS
`imprints page written:` line, or the `--json` rows instead; the order is `--uncapped`, then `--cap-aware` (boss), then
`--sort`. `enchant` prints the equipped weapon's enchantment rows and its Cast When Strikes price (the same card as the
JS), text or `--json`; no save with a weapon prints the JS `No weapon equipped.` line and exits 0. `spell` prints the
one-spell rotation card, the resolved spellbook table (`--list`) or the priced table (`--all-spells`), text or `--json`:
`--standard` shows every standard record instead of the character's spellbook, `--spell <index|name>` picks the record
(index, then case-insensitive name, then a name substring), `--data <dir>` names an ARENA2 directory, and the theory
character gets the branch's caster tweak. As in the JS, a resolvable launcher config wins over `--data` (the module book
cache is filled before the branch reads it), `--list` returns before `--all-spells`/`--spell`, and `--all-spells` prints
its table even under `--json`. `spells` ranks every standard damage spell plus the save's custom records by 30-second
window DPS, writes the `DFO spell ceiling` page (`spells.html`, or `--out`, also create-only) and prints the JS
`spells page written:` line, or the ranked `--json` list; an empty pool prints the JS
`No standard damage spells found. Check --data / ARENA2.` line and exits 0. `enchant-plan` (and its alias `gear-plan`)
plans the per-piece enchantment priority fill against the level-45 Breach (or, with `--uncapped`, the no-cap tough
reference foe): `--weapon` picks the template, `--shield`/`--soul-gem`/`--group`/`--repairs`/`--regen` are the branch's
options, and `--all` prints both matrices. It writes `enchant-plan.html` (or `enchant-plans.html` for `--all`, or
`--out`, also create-only) and prints the JS `enchant plan written:` / `enchant plans page written:` line, or the plan
document with `--json`; a group outside the four named ones is the JS stderr line and exit 2. `tradeoff` prices
+5% attack speed against +5% weapon damage over the Breach gate and five Curbing pools, then the top weapons and the
speed/damage crossover by boss health (`--target`/`--health`/`--armor` do not reach those fixed pools).
`theory` prints the level-45 long-blade ceiling card: the header, the push stages, the cap sheet, both scaling curves,
the Firmament and legal-frontier tables, the long-blade table and the result card, text or `--json`; it always reads
the theory character and needs a boss/gate target (a reference foe is refused, where the JS card crashes).
`weapons` (and its alias `skills`) prints the level-45 weapon ceiling page: every melee template and the dual pairs at
their real Firmament trees, the per-hit-capped table, the relay/uncapped sections and, unless `--categories`, one
skill-scaling curve per weapon family plus the Critical Strike curve. `--categories` keeps one winner per weapon type
per hand slot. It writes `weapons.html` (`skills.html` for the alias, or `--out`, also create-only) and prints the JS
`weapons page written:` line, or the `{ level, firmCharts, rows, cs }` document with `--json`. The characters are always
level 45 (the JS `makeMax` never passes `--level`); `--level` moves the reference foe and the Breach only.

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
  --cast-speed <pct> --magicka <n>     spell: cast rate / magicka-pool override
  --mana-limit                         spell: price the magicka pool (default: mana is solved)
  --seconds <n>                        spell/spells: fight length for sustain (default 30)
  --no-effects                        drop active effects
  --base-stats <n>                    set all eight base attributes to n
  --objective <id>                    snapshot, fight, relay, relay-ceiling, stochastic-ttk, kill-probability,
                                      stochastic-relay (objective command default: snapshot)
  --trials <n> --seed <int> --max-seconds <n> --max-blows <n> --no-carry --samples
                                      sampled objective options (defaults 1000, 0, 900, 6000)
  --top <n>                           rows in the ranking (default 20)
  --stat <name=value>                 compare: one attribute or skill id change (repeatable)
  --stat <name>                       scale: one attribute to curve to 100
  --skill <id>                        scale: one raw skill id to curve to 200
  --gear-skill <id>                   scale: one gear skill affix to curve to current+100
  --from <n> --to <n> --step <n>      scale/graph: the channel range (scale default: current to cap; step 10)
  --all                               scale: every relevant channel at once (text only);
                                      enchant-plan: both the uncapped and the cap-aware matrices
  --data <dir>                        spell/spells: an ARENA2 directory holding SPELLS.STD (read only when the launcher
                                      has no usable config: the JS module cache is filled before the branch; see README)
  --data <capture.json>               probe: a capture file
  --list                              spell: the resolved spellbook table
  --all-spells                        spell: price every damaging spell (table, and the --json document)
  --spell <index|name>                spell: the record to price (index, name, then name substring)
  --standard                          spell: use every standard record, not just the character's spellbook
  --old                               probe: read the newest capture in captures/old
  --out <file>                        probe/graph/report/firmament/imprints/spells/weapons/loadout: the page (default probe.html /
                                      graph.html / dfo-dps-report.html / firmament.html / imprints.html / spells.html /
                                      weapons.html / loadouts.html; must not exist yet)
  --series <spec,...>                 graph: stat:name, skill:id, gear:id or star:name (default stat:strength,stat:agility)
  --from <n> --to <n> --step <n>      graph: the channel range (default per series kind; step 10)
  --uncapped                          graph: plot uncapped DPS instead of the per-hit-capped line;
                                      imprints: rank by uncapped DPS (wins over --sort)
  --build <id,...>                    firmament: longblade, shortblade, axe, blunt, bow, fists, destruction, tank
                                      (default: all eight)
  --stars <n>                         firmament: stars to spend, 0..98 (default 98)
  --refresh                           firmament: accepted for parity; this CLI keeps no disk cache, so it recomputes
                                      every run either way
  --family <key>                      imprints: LongBlade, ShortBlade, Axe, BluntWeapon, Archery or HandToHand
  --sort <boss|uncapped|conditional>  imprints order (default boss; --uncapped wins, then --cap-aware)
  --cap-aware                         imprints: rank by boss DPS (the default order, named explicitly);
                                      enchant-plan: the cap-aware mode, named explicitly;
                                      loadout: price only the cap-aware modes
  --encounter <id>                    loadout: the content whose cap-aware rows are priced (default breach)
  --all-encounters                    loadout: one cap-aware section per content, in breach/skyketch/abyss order
  --shortlist <K>                     loadout: sample the top K eligible loadouts per target instead of the report
                                      (must be a positive integer; 0 keeps the report)
  --categories                        weapons/skills: one winner per weapon type per hand slot, sorted by DPS
  --shield <template|none|auto>       enchant-plan: the shield template (default auto)
  --soul-gem                          enchant-plan: add 5,000 enchantment points to every piece
  --group <undead|daedra|humanoid|animal>  enchant-plan target for Potent Vs (default daedra)
  --repairs <n>                       enchant-plan: Repairs Objects copies on the set (default 1; 0 = none)
  --regen <n>                         enchant-plan: Regens Health copies (default 0; heal spells are stronger)
  --json
  -h, --help

Every JS `COMMANDS` entry is handled. A flag a command does not read is refused by name instead of being accepted and
ignored, as the JS `parseArgs`/`validateFlags` do.";

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
    let mut values = Values::new(&parsed)?;
    let command = parsed
        .positionals
        .first()
        .cloned()
        .unwrap_or_else(|| "build".into());
    // `src/cli.js:921`: `if (cmd === 'theory' || cmd === 'weapons' || cmd === 'skills') values.theory = true`. The
    // three commands read the level-45 theory character, so none of them imports a save.
    if command == "theory" || command == "weapons" || command == "skills" {
        values.theory = true;
    }
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
    if command == "objective" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return objective(&values);
    }
    if command == "compare" {
        // Extra positionals are ignored by the JS and refused here on purpose, as `build` and `rank` do: a strict
        // refusal, not a silent drop.
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        // `src/cli.js:918-920`: checked after `checkOutputFlags`, before the branch.
        if parsed.flag("all") {
            return Err(usage(
                "compare does not take --all; use scale --all for every channel",
            ));
        }
        return compare(&values);
    }
    if command == "probe" {
        // The JS takes at most one positional (`capture.json`) and ignores the rest; this slice refuses extras, as the
        // other ported commands do. `--out` is refused by the probe module itself (the page HTML is not ported).
        if let Some(extra) = parsed.positionals.get(2) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return probe::command(
            parsed.positionals.get(1).map(String::as_str),
            values.data.as_deref(),
            values.old,
            values.nums.get("level").copied(),
            values.nums.get("players").copied(),
            values.json,
            parsed.raw("out"),
        );
    }
    if command == "graph" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return graph_command(&values, parsed.raw("out"));
    }
    if command == "report" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return report_command(&values, parsed.raw("out"));
    }
    if command == "firmament" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return firmament_command(&values, parsed.raw("out"));
    }
    if command == "imprints" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return imprints_command(&values, parsed.raw("out"));
    }
    if command == "enchant" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return enchant_command(&values);
    }
    if command == "enchant-plan" || command == "gear-plan" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return enchant_plan_command(&values, parsed.raw("out"));
    }
    if command == "spell" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return spell_command(&values);
    }
    if command == "spells" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return spells_command(&values, parsed.raw("out"));
    }
    if command == "tradeoff" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return tradeoff_command(&values);
    }
    if command == "theory" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return theory_command(&values);
    }
    if command == "weapons" || command == "skills" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return weapons_command(&command, &values, parsed.raw("out"));
    }
    if command == "scale" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return scale_command(&values);
    }
    if command == "loadout" || command == "real-dps" {
        if let Some(extra) = parsed.positionals.get(1) {
            return Err(usage(format!("unexpected positional argument \"{extra}\"")));
        }
        check_output_flags(&command, &parsed)?;
        return loadout_command(&values, parsed.raw("out"));
    }
    if command != "rank" {
        // Every name in the JS `COMMANDS` list is now handled above (`loadout`/`real-dps` last), so anything left is a
        // name the JS does not know either: `unknown command "<cmd>"` and the help text, exit 2.
        return Err(usage(format!("unknown command \"{command}\"\n\n{HELP}")));
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
/// The commands of this slice (`build`, `rank`, `compare`, `scale`, `saves`, `doctor`, `probe`, `graph`, `report`,
/// `firmament`, `imprints`, `enchant`, `tradeoff`): `probe`, `graph`, `report`, `firmament` and `imprints` write a page,
/// and `build`, `rank`, `objective`, `scale`, `probe`, `graph`, `firmament`, `imprints`, `enchant` and `tradeoff` read
/// `--json`.
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
    // `--stat` is priced by `compare` and `scale`; `--all` by `compare`, `scale` and `enchant-plan`; JS accepts and
    // ignores them elsewhere, and this CLI refuses them by name, as it does `--out`, never silently.
    if command != "compare" && command != "scale" {
        let name = "stat";
        if parsed.raw(name).is_some() || parsed.flag(name) {
            return Err(usage(format!(
                "--{name} is not read by {command}; compare and scale read it"
            )));
        }
    }
    if command != "compare"
        && command != "scale"
        && command != "enchant-plan"
        && command != "gear-plan"
        && (parsed.raw("all").is_some() || parsed.flag("all"))
    {
        return Err(usage(format!(
            "--all is not read by {command}; compare, scale, enchant-plan and gear-plan read it"
        )));
    }
    // `--skill`/`--gear-skill` are priced by `scale` alone.
    if command != "scale" {
        for name in ["skill", "gear-skill"] {
            if parsed.raw(name).is_some() || parsed.flag(name) {
                return Err(usage(format!(
                    "--{name} is not read by {command}; only scale reads it"
                )));
            }
        }
    }
    // `--data` is the probe's capture file and the spell commands' ARENA2 directory; `--old` is the probe's alone.
    if command != "probe"
        && command != "spell"
        && command != "spells"
        && parsed.raw("data").is_some()
    {
        return Err(usage(format!(
            "--data is not read by {command}; probe, spell and spells read it"
        )));
    }
    if command != "probe" && parsed.flag("old") {
        return Err(usage(format!(
            "--old is not read by {command}; only probe reads it"
        )));
    }
    // The spell flags are read by `spell` and `spells` (which the JS ignores `--list`/`--all-spells`/`--standard`/
    // `--spell` for); the JS accepts and ignores them elsewhere, this CLI names them.
    if command != "spell" && command != "spells" {
        for name in [
            "list",
            "all-spells",
            "standard",
            "spell",
            "mana-limit",
            "seconds",
            "cast-speed",
            "magicka",
        ] {
            if parsed.raw(name).is_some() || parsed.flag(name) {
                return Err(usage(format!(
                    "--{name} is not read by {command}; spell and spells read it (spells ignores --list, --all-spells, --standard and --spell)"
                )));
            }
        }
    }
    // `--series` is priced by `graph` alone, and `--uncapped` by `graph` and `imprints`; JS accepts and ignores them
    // elsewhere, and this CLI refuses them by name.
    if command != "graph" && (parsed.raw("series").is_some() || parsed.flag("series")) {
        return Err(usage(format!(
            "--series is not read by {command}; only graph reads it"
        )));
    }
    if command != "graph"
        && command != "imprints"
        && command != "enchant-plan"
        && command != "gear-plan"
        && command != "loadout"
        && command != "real-dps"
        && (parsed.raw("uncapped").is_some() || parsed.flag("uncapped"))
    {
        return Err(usage(format!(
            "--uncapped is not read by {command}; graph, imprints, enchant-plan, gear-plan, loadout and real-dps read it"
        )));
    }
    // `--from`/`--to`/`--step` are shared by `graph` and `scale`.
    if command != "graph" && command != "scale" {
        for name in ["from", "to", "step"] {
            if parsed.raw(name).is_some() || parsed.flag(name) {
                return Err(usage(format!(
                    "--{name} is not read by {command}; graph and scale read it"
                )));
            }
        }
    }
    // `--build`/`--stars`/`--refresh` are priced by `firmament` alone; the JS accepts and ignores them elsewhere.
    if command != "firmament" {
        for name in ["build", "stars", "refresh"] {
            if parsed.raw(name).is_some() || parsed.flag(name) {
                return Err(usage(format!(
                    "--{name} is not read by {command}; only firmament reads it"
                )));
            }
        }
    }
    // `--categories` is the weapons/skills page's condensed table; refused by name elsewhere, as the JS accepts and
    // ignores it.
    if command != "weapons" && command != "skills" && parsed.flag("categories") {
        return Err(usage(format!(
            "--categories is not read by {command}; weapons and skills read it"
        )));
    }
    // `--encounter`/`--all-encounters`/`--shortlist` are the loadout report's content and sample selectors; the JS
    // accepts and ignores them elsewhere, this CLI names them.
    if command != "loadout" && command != "real-dps" {
        for name in ["encounter", "all-encounters", "shortlist"] {
            if parsed.raw(name).is_some() || parsed.flag(name) {
                return Err(usage(format!(
                    "--{name} is not read by {command}; loadout and real-dps read it"
                )));
            }
        }
    }
    // `--family`/`--sort`/`--cap-aware` are read by `imprints` and `--cap-aware` by `enchant-plan` and `loadout` too
    // (the JS validates `--sort` globally, which [`Values::new`] still does before this runs).
    if command != "imprints" {
        for name in ["family", "sort"] {
            if parsed.raw(name).is_some() || parsed.flag(name) {
                return Err(usage(format!(
                    "--{name} is not read by {command}; imprints reads it"
                )));
            }
        }
        if command != "enchant-plan"
            && command != "gear-plan"
            && command != "loadout"
            && command != "real-dps"
            && (parsed.raw("cap-aware").is_some() || parsed.flag("cap-aware"))
        {
            return Err(usage(format!(
                "--cap-aware is not read by {command}; imprints, enchant-plan, gear-plan, loadout and real-dps read it"
            )));
        }
    }
    // `--shield`/`--soul-gem`/`--group`/`--repairs`/`--regen` are read by `enchant-plan` alone.
    if command != "enchant-plan" && command != "gear-plan" {
        for name in ["shield", "soul-gem", "group", "repairs", "regen"] {
            if parsed.raw(name).is_some() || parsed.flag(name) {
                return Err(usage(format!(
                    "--{name} is not read by {command}; enchant-plan and gear-plan read it"
                )));
            }
        }
    }
    if parsed.raw("out").is_some() && !listed(FILE_COMMANDS) {
        return Err(usage(format!(
            "--out is only for commands that write a file ({FILE_COMMANDS}), not \"{command}\""
        )));
    }
    // `checkOutputFlags` (`src/cli.js:892-897`): the command name in the message is `spell --list` / `scale --all`
    // when that branch has no JSON form. Only `spell --list` lacks one; every other `spell` mode has its document.
    let unsupported = if command == "scale" && parsed.flag("all") {
        Some("scale --all".to_owned())
    } else if command == "spell" && parsed.flag("list") {
        Some("spell --list".to_owned())
    } else if listed(JSON_COMMANDS) {
        None
    } else {
        Some(command.to_owned())
    };
    if parsed.flag("json") {
        if let Some(name) = unsupported {
            return Err(usage(format!(
                "--json is not supported by \"{name}\"; commands with JSON output: {JSON_COMMANDS}"
            )));
        }
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
    "no-effects save offline passive bare out objective trials seed max-seconds max-blows no-carry samples stat all ",
    "data old series from to step uncapped skill gear-skill build stars refresh family sort cap-aware ",
    "shield soul-gem group repairs regen categories ",
    "list all-spells standard spell mana-limit seconds cast-speed magicka ",
    "encounter all-encounters shortlist",
);

fn in_flags(list: &str, name: &str) -> bool {
    list.split_whitespace().any(|f| f == name)
}

const BOOLEAN_FLAGS: &str = concat!(
    "theory json vampire firmament rhythm unaware first-blow behind pair dual spam no-crit-damage no-passive ",
    "no-rri help offline bare no-effects no-carry samples all old uncapped refresh cap-aware list all-spells standard ",
    "mana-limit soul-gem categories all-encounters",
);

const MULTI: [&str; 3] = ["star-stat", "star-skill", "stat"];

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
                "--{name} is not read by this CLI (JS theory only prints an obsolete note for it; use --gear-lb/--gear-cs)"
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
const NUMERIC_FLAGS: [(&str, f64, Range); 30] = [
    ("level", THEORY_LEVEL, range(1.0, LEVEL_CAP, true, false)),
    ("stacks", 5.0, range(0.0, 5.0, true, false)),
    ("players", 1.0, range(1.0, f64::INFINITY, true, false)),
    ("health", 5000.0, range(0.0, f64::INFINITY, false, true)),
    ("armor", 0.0, range(0.0, f64::INFINITY, false, false)),
    ("backstab", 0.0, range(0.0, 1.0, false, false)),
    ("blow-x", 1.0, range(0.0, f64::INFINITY, false, true)),
    ("top", 20.0, range(1.0, f64::INFINITY, true, false)),
    (
        "trials",
        MIN_STOCHASTIC_TRIALS as f64,
        range(1.0, f64::INFINITY, true, false),
    ),
    ("potency", 0.0, ANY),
    ("pierce", 0.0, ANY),
    ("health-share", 1.0, range(0.0, 1.0, false, false)),
    ("self-health-share", 1.0, range(0.0, 1.0, false, false)),
    ("gear-lb", 0.0, range(0.0, f64::INFINITY, false, false)),
    ("gear-cs", 0.0, range(0.0, f64::INFINITY, false, false)),
    ("repairs", 1.0, range(0.0, f64::INFINITY, true, false)),
    ("regen", 0.0, range(0.0, f64::INFINITY, true, false)),
    ("damage-pct", 0.0, ANY),
    ("stars", 98.0, range(0.0, 98.0, true, false)),
    (
        "blade",
        DEFAULT_BLADE,
        range(1.0, f64::INFINITY, true, false),
    ),
    ("star-damage", 0.0, ANY),
    ("base-stats", 50.0, ANY),
    ("from", 0.0, ANY),
    ("to", 0.0, ANY),
    ("step", 10.0, range(0.0, f64::INFINITY, false, true)),
    ("skill", -1.0, range(0.0, 34.0, true, false)),
    ("gear-skill", -1.0, range(0.0, 34.0, true, false)),
    ("seconds", 30.0, range(0.0, f64::INFINITY, false, true)),
    ("cast-speed", 0.0, ANY),
    ("magicka", 0.0, ANY),
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
    /// `--shield`: `none`, `auto` or an item template id, lower-cased (the `enchant-plan` option).
    shield: String,
    /// `--soul-gem`: 5,000 extra enchantment points on every piece.
    soul_gem: bool,
    /// `--group`: the Potent Vs group, lower-cased (`undead`/`daedra`/`humanoid`/`animal`).
    group: String,
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
    /// `--objective`: the id exactly as typed (`printObjective` validates it against the list).
    objective: Option<String>,
    /// `--encounter`: the loadout content id, lower-cased (`validateFlags` bounds it).
    encounter: String,
    /// `--all-encounters`: one cap-aware section per content, in `ENCOUNTER_IDS` order.
    all_encounters: bool,
    /// `--shortlist`: raw text, so `Number()` and `.trim()` keep the JS's `0`/empty/`junk` distinction.
    shortlist: String,
    /// `--seed`, `--max-seconds`, `--max-blows`: raw strings, validated by [`sampled_options`] only when an
    /// objective is priced (the JS validates them inside `printObjective`, not in `validateFlags`).
    seed: Option<String>,
    max_seconds: Option<String>,
    max_blows: Option<String>,
    no_carry: bool,
    samples: bool,
    /// `--stat` as typed, in order: `compare` parses each one (the JS validates them inside the branch).
    stat: Vec<String>,
    /// `--data`: the probe capture file (the JS also uses it for ARENA2, which this slice does not port).
    data: Option<String>,
    /// `--old`: the probe reads `captures/old` instead of the live folder.
    old: bool,
    /// `--series`: raw comma list, split and validated by the graph command (the JS splits in the branch).
    series: Option<String>,
    /// `--uncapped`: the graph plots uncapped DPS; `imprints` ranks by uncapped DPS.
    uncapped: bool,
    /// `--family`: the imprints family key, exactly as typed (the JS looks it up case-insensitively).
    family: Option<String>,
    /// `--sort`: the imprints order, exactly as typed; `validateFlags` bounds it before the branch.
    sort: Option<String>,
    /// `--cap-aware`: imprints' boss order (the same as the default), named explicitly.
    cap_aware: bool,
    /// `--base-stats` exactly as typed (the graph subtitle prints the JS raw flag text).
    base_stats_raw: Option<String>,
    /// `--all`: `scale` prices every channel at once.
    all: bool,
    /// `--build`: raw comma list of firmament build ids (the command splits and trims it, as the JS does).
    build: Option<String>,
    /// `--list`: `spell --list`, the resolved spellbook table.
    list: bool,
    /// `--all-spells`: price every damaging spell, then its `--json` document.
    all_spells: bool,
    /// `--standard`: `spell` uses every standard record, not just the character's spellbook.
    standard: bool,
    /// `--spell`: the record to price by index or name.
    spell_query: Option<String>,
    /// `--mana-limit`: price the magicka pool instead of solving mana.
    mana_limit: bool,
    /// `--categories`: the weapons/skills page shows one winner per type per slot.
    categories: bool,
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
        // `validateFlags` (`src/cli.js:372-374`): the imprints order, checked here for every command as the JS does.
        if let Some(sort) = parsed.raw("sort") {
            if !["boss", "uncapped", "conditional"].contains(&sort) {
                return Err(usage(format!(
                    "--sort must be boss, uncapped or conditional, got \"{sort}\""
                )));
            }
        }
        // `validateFlags` (`src/cli.js:382-384`): every command's `--encounter`, checked before the branch runs.
        if let Some(encounter) = parsed.raw("encounter") {
            if !ENCOUNTER_IDS.contains(&encounter.to_lowercase().as_str()) {
                return Err(usage(format!(
                    "--encounter must be one of {}, got \"{encounter}\"",
                    ENCOUNTER_IDS.join(", ")
                )));
            }
        }
        let weapon = match parsed.raw("weapon") {
            Some(raw) => Some(weapon_flag(raw)?),
            None => None,
        };
        // `validateFlags` (`src/cli.js:375-379`): `--shield` must be a template number, `none` or `auto`.
        let shield = match parsed.raw("shield") {
            Some(raw) => {
                let shield = raw.to_lowercase();
                if shield != "none"
                    && shield != "auto"
                    && (shield.is_empty()
                        || dfo_core::enchants::item_enchantment_name(&Str(shield.clone()))
                            .is_none())
                {
                    return Err(usage(format!(
                        "--shield must be a template number, none or auto, got \"{raw}\""
                    )));
                }
                shield
            }
            None => "auto".to_owned(),
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
            shield,
            soul_gem: parsed.flag("soul-gem"),
            group: parsed
                .raw("group")
                .map(|g| g.to_lowercase())
                .unwrap_or_else(|| "daedra".to_owned()),
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
            objective: parsed.raw("objective").map(str::to_owned),
            encounter: parsed.raw("encounter").unwrap_or("breach").to_lowercase(),
            all_encounters: parsed.flag("all-encounters"),
            shortlist: parsed.raw("shortlist").unwrap_or("0").to_owned(),
            seed: parsed.raw("seed").map(str::to_owned),
            max_seconds: parsed.raw("max-seconds").map(str::to_owned),
            max_blows: parsed.raw("max-blows").map(str::to_owned),
            no_carry: parsed.flag("no-carry"),
            samples: parsed.flag("samples"),
            stat: parsed.multi("stat"),
            data: parsed.raw("data").map(str::to_owned),
            old: parsed.flag("old"),
            series: parsed.raw("series").map(str::to_owned),
            uncapped: parsed.flag("uncapped"),
            family: parsed.raw("family").map(str::to_owned),
            sort: parsed.raw("sort").map(str::to_owned),
            cap_aware: parsed.flag("cap-aware"),
            base_stats_raw: parsed.raw("base-stats").map(str::to_owned),
            all: parsed.flag("all"),
            build: parsed.raw("build").map(str::to_owned),
            list: parsed.flag("list"),
            all_spells: parsed.flag("all-spells"),
            standard: parsed.flag("standard"),
            spell_query: parsed.raw("spell").map(str::to_owned),
            mana_limit: parsed.flag("mana-limit"),
            categories: parsed.flag("categories"),
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
    let target = target_of(
        &ch,
        values,
        &values.traits,
        values.nums.get("health").copied(),
    )?;
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
    let target = target_of(
        &ch,
        values,
        &values.traits,
        values.nums.get("health").copied(),
    )?;
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

// ---------------------------------------------------------------------------------------------------------------
// the graph command (src/cli.js:2057-2127)
// ---------------------------------------------------------------------------------------------------------------

/// `STAT_KEYS` (`src/cli.js:464`): the eight attributes `star:` accepts.
const STAT_KEYS: [&str; 8] = [
    "strength",
    "intelligence",
    "willpower",
    "agility",
    "endurance",
    "personality",
    "speed",
    "luck",
];

/// `FIRM_CHANNEL_MAX` (`src/cli.js:465`).
const FIRM_CHANNEL_MAX: f64 = 15.0;

/// `scaleRange` (`src/cli.js:713-722`): `from..=to` in `step` (at least 1) increments, each rounded to two decimals,
/// with the exact `to` appended when the last rounded point did not land on it (a strict `!==`, as the JS does).
fn scale_range(values: &Values, current: f64, cap: f64) -> Vec<f64> {
    let from = values.nums.get("from").copied().unwrap_or(current);
    let to = values.nums.get("to").copied().unwrap_or(cap);
    let step = js_max(1.0, values.nums.get("step").copied().unwrap_or(10.0));
    let mut out = Vec::new();
    // `!(to >= from)`: a NaN bound fails the check as well, so no point is produced.
    if !matches!(
        to.partial_cmp(&from),
        Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
    ) {
        return out;
    }
    let mut v = from;
    while v <= to + 1e-9 {
        out.push(math_round(v * 100.0) / 100.0);
        v += step;
    }
    if out.last().copied() != Some(to) {
        out.push(to);
    }
    out
}

/// One `graph` series as the command builds it: its label and the priced `{ x, y }` points.
struct GraphSeries {
    name: String,
    points: Vec<(f64, f64)>,
}

/// `dfo-dps graph` (`src/cli.js:2057-2127`): one curve per `--series`, the JS page, and the `--json` series document.
/// The page goes through `probe`'s create-only writer: an existing `graph.html` (or `--out`) is refused, never truncated.
fn graph_command(values: &Values, out_flag: Option<&str>) -> Result<String, CliError> {
    let book = saves::load_spellbook();
    let ch = character(values, &book)?;
    let target = target_of(
        &ch,
        values,
        &values.traits,
        values.nums.get("health").copied(),
    )?;
    let mut scenario = scenario_of(&ch, values, &values.traits, &target);
    // `scenarioOf` (`src/cli.js:559`): a save's `--weapon` override lives on the scenario; the theory character already
    // applied it when it was built.
    if !values.theory {
        if let Some((tpl, mat)) = values.weapon {
            scenario.set("weapon", synthetic_weapon(&Num(tpl), &Num(mat), values.rri));
        }
    }
    let spec_text = values
        .series
        .clone()
        .unwrap_or_else(|| "stat:strength,stat:agility".to_owned());
    let specs: Vec<&str> = spec_text
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let mut series = Vec::new();
    for spec in specs {
        // `const [kindRaw, idRaw] = spec.split(':')`: a third segment is dropped, as the JS destructuring drops it.
        let mut parts = spec.split(':');
        let kind_raw = parts.next().unwrap_or("");
        let id_raw = parts.next();
        let kind = kind_raw.to_lowercase();
        // `if (!idRaw)`: an empty or absent id both take the "needs an attribute name" branch.
        let id_present = id_raw.filter(|s| !s.is_empty());
        let apply = |c: &mut Value, id: &str, value: f64| match kind.as_str() {
            "stat" => {
                let mut stats = c.get("stats").clone();
                stats.set(id, Num(value));
                c.set("stats", stats);
            }
            "skill" => set_skill(c, id, value),
            "star" => {
                let mut mods = c.get("_mods").clone();
                if mods.is_nullish() {
                    mods = obj([("stats", Obj(vec![])), ("skills", Obj(vec![]))]);
                }
                let mut stats = mods.get("stats").clone();
                if stats.is_nullish() {
                    stats = Obj(vec![]);
                }
                stats.set(id, Num(value));
                mods.set("stats", stats);
                let mut stat_max = mods.get("statMax").clone();
                if stat_max.is_nullish() {
                    stat_max = Obj(vec![]);
                }
                stat_max.set(id, Num(js_max(0.0, value)));
                mods.set("statMax", stat_max);
                c.set("_mods", mods);
            }
            _ => {
                let mut mods = c.get("_mods").clone();
                if mods.is_nullish() {
                    mods = obj([("stats", Obj(vec![])), ("skills", Obj(vec![]))]);
                }
                let mut skills = mods.get("skills").clone();
                if skills.is_nullish() {
                    skills = Obj(vec![]);
                }
                skills.set(id, Num(value));
                mods.set("skills", skills);
                c.set("_mods", mods);
            }
        };
        let (id, from, to, label): (String, f64, f64, String) = match kind.as_str() {
            "stat" => {
                let Some(id) = id_present else {
                    return Err(usage(format!(
                        "graph series {spec} needs an attribute name (stat:strength)"
                    )));
                };
                let id = id.to_lowercase();
                (
                    id.clone(),
                    values.nums.get("from").copied().unwrap_or(50.0),
                    values.nums.get("to").copied().unwrap_or(100.0),
                    format!("stat {id}"),
                )
            }
            "skill" | "gear" => {
                let id = skill_id_flag(id_raw)?;
                let current = if kind == "skill" {
                    ch.get("skills").prop(&Num(id)).num_or(0.0)
                } else {
                    ch.get("_mods").get("skills").prop(&Num(id)).num_or(0.0)
                };
                let (def_from, def_to) = if kind == "skill" {
                    (100.0, 200.0)
                } else {
                    (current, current + 100.0)
                };
                let key = number_to_string(id);
                (
                    key.clone(),
                    values.nums.get("from").copied().unwrap_or(def_from),
                    values.nums.get("to").copied().unwrap_or(def_to),
                    format!("{kind} {key}"),
                )
            }
            "star" => {
                let Some(id) = id_present else {
                    return Err(usage(format!(
                        "graph series {spec} needs an attribute name (star:strength)"
                    )));
                };
                let id = id.to_lowercase();
                if !STAT_KEYS.contains(&id.as_str()) {
                    return Err(usage(format!("bad star attribute {id}")));
                }
                (
                    id.clone(),
                    values.nums.get("from").copied().unwrap_or(0.0),
                    values.nums.get("to").copied().unwrap_or(FIRM_CHANNEL_MAX),
                    format!("star {id}"),
                )
            }
            _ => {
                return Err(usage(format!(
                    "graph series must be stat:name, skill:id, gear:id or star:name ({spec})"
                )));
            }
        };
        let mut points = Vec::new();
        for value in scale_range(values, from, to) {
            let mut c = dfo_core::analyze::json_clone(&ch);
            apply(&mut c, &id, value);
            let r = analyze(&c, &scenario, &book);
            points.push((value, if values.uncapped { r.dps } else { r.capped_dps }));
        }
        series.push(GraphSeries {
            name: label,
            points,
        });
    }
    let title = "DFO DPS - stat curves";
    let mut flags: Vec<String> = Vec::new();
    if values.bare {
        flags.push("bare".into());
    }
    if values.no_effects {
        flags.push("no effects".into());
    }
    if let Some(raw) = &values.base_stats_raw {
        flags.push(format!("base {raw}"));
    }
    flags.push(
        if values.uncapped {
            "uncapped"
        } else {
            "capped"
        }
        .into(),
    );
    let flags = flags.join(", ");
    let health = target.get("health");
    let subtitle = format!(
        "{} | {}{} | {}{} | {flags}",
        character_label(&ch),
        values.core,
        if ch.get("online").truthy() {
            " / online"
        } else {
            " / offline"
        },
        values.target,
        if health.truthy() {
            format!(" {} HP", grouped(target.get("maxHealth")))
        } else {
            String::new()
        }
    );
    let chart_series: Vec<graph::Series> = series
        .iter()
        .map(|s| graph::Series {
            name: s.name.clone(),
            points: s
                .points
                .iter()
                .map(|&(x, y)| graph::Point { x, y })
                .collect(),
        })
        .collect();
    let chart = graph::line_chart(&graph::LineChart::new(
        title,
        "Value",
        if values.uncapped { "DPS" } else { "Capped DPS" },
        chart_series,
    ));
    let html = graph::graph_page(title, &subtitle, &chart);
    // `path.resolve(values.out === 'dfo-dps-report.html' ? 'graph.html' : values.out)` (`:2121`).
    let out = match out_flag {
        None | Some("dfo-dps-report.html") => "graph.html".to_owned(),
        Some(name) => name.to_owned(),
    };
    let out = probe::normalized(&out);
    probe::write_page(&out, &html)?;
    if values.json {
        let doc = Arr(series
            .iter()
            .map(|s| {
                obj([
                    ("name", Str(s.name.clone())),
                    (
                        "points",
                        Arr(s
                            .points
                            .iter()
                            .map(|&(x, y)| obj([("x", Num(x)), ("y", Num(y))]))
                            .collect()),
                    ),
                ])
            })
            .collect());
        return Ok(format!("{}\n", json(&doc)));
    }
    Ok(format!("graph written: {}\n", out.display()))
}

/// `dfo-dps scale` (`src/cli.js:2128-2203`): one channel's DPS curve (text `printScale` or the `--json` rows), or
/// `--all`'s current-to-cap summary. Every point comes from `analyze` over a JSON copy of the character with the one
/// field set, exactly as the JS does; nothing here is a second reading of a rule.
fn scale_command(values: &Values) -> Result<String, CliError> {
    let book = saves::load_spellbook();
    let ch = character(values, &book)?;
    let target = target_of(
        &ch,
        values,
        &values.traits,
        values.nums.get("health").copied(),
    )?;
    let mut scenario = scenario_of(&ch, values, &values.traits, &target);
    // `scenarioOf` (`src/cli.js:559`): a save's `--weapon` override lives on the scenario; the theory character already
    // applied it when it was built.
    if !values.theory {
        if let Some((tpl, mat)) = values.weapon {
            scenario.set("weapon", synthetic_weapon(&Num(tpl), &Num(mat), values.rri));
        }
    }
    // `const weaponId = r?.weapon?.skillId ?? weaponOf(ch.weapon)?.skillId ?? 30`: the resolved descriptor is the
    // scenario's override when there is one, else the character's own weapon (`weaponOf(ch.weapon)`, no RRI).
    let resolved_weapon = if matches!(scenario.get("weapon"), Undefined) {
        weapon_of(&ch.get("weapon").clone(), false)
    } else {
        scenario.get("weapon").clone()
    };
    let weapon_id = match resolved_weapon.get("skillId") {
        Num(n) => *n,
        _ => 30.0,
    };
    // `one(label, kind, id, current, cap)`: the curve, one row per `scaleRange` point.
    let one = |label: &str, kind: &str, id: &Value, current: f64, cap: f64| -> Vec<ScaleRow> {
        let mut rows = Vec::new();
        for value in scale_range(values, current, cap) {
            let mut c = dfo_core::analyze::json_clone(&ch);
            apply_scale(&mut c, kind, id, value);
            let rr = analyze(&c, &scenario, &book);
            rows.push(ScaleRow {
                label: label.to_owned(),
                value,
                dps: rr.dps,
                capped_dps: rr.capped_dps,
                per_swing: rr.per_swing,
                ttk: rr.ttk,
                dps_min: rr.dps_min,
                dps_max: rr.dps_max,
                capped_dps_min: rr.capped_dps_min,
                capped_dps_max: rr.capped_dps_max,
            });
        }
        rows
    };
    if values.all {
        // `addSummary`: price the current and the cap as two whole runs, so the row's DPS pair is the delta.
        let summary_run = |label: &str, current: f64, cap: f64, make: &dyn Fn(&mut Value, f64)| {
            let mut c0 = dfo_core::analyze::json_clone(&ch);
            let mut c1 = dfo_core::analyze::json_clone(&ch);
            make(&mut c0, current);
            make(&mut c1, cap);
            let r0 = analyze(&c0, &scenario, &book);
            let r1 = analyze(&c1, &scenario, &book);
            (
                label.to_owned(),
                format!("{} → {}", number_to_string(current), number_to_string(cap)),
                r0.capped_dps,
                r1.capped_dps - r0.capped_dps,
                r1.per_swing,
                r1.ttk,
            )
        };
        let mut summary: Vec<(String, String, f64, f64, f64, Option<f64>)> = Vec::new();
        for k in [
            "strength",
            "agility",
            "speed",
            "luck",
            "endurance",
            "willpower",
        ] {
            let cur = live_stat(&ch, k);
            let key = Str(k.to_owned());
            summary.push(summary_run(
                &format!("stat {k}"),
                cur,
                100.0,
                &move |c, v| {
                    apply_scale(c, "stat", &key, v);
                },
            ));
        }
        for (label, id) in [("skill weapon", weapon_id), ("skill critical", 34.0)] {
            let cur = ch.get("skills").prop(&Num(id)).num_or(0.0);
            let key = Num(id);
            summary.push(summary_run(label, cur, 200.0, &move |c, v| {
                apply_scale(c, "skill", &key, v);
            }));
        }
        let gear_cur = ch
            .get("_mods")
            .get("skills")
            .prop(&Num(weapon_id))
            .num_or(0.0);
        let key = Num(weapon_id);
        summary.push(summary_run(
            "gear skill",
            gear_cur,
            gear_cur + 100.0,
            &move |c, v| {
                apply_scale(c, "gear", &key, v);
            },
        ));
        let mut out = format!(
            "{}  |  {}{}  |  {}\n",
            character_label(&ch),
            values.core,
            if ch.get("online").truthy() {
                " / online"
            } else {
                " / offline"
            },
            values.target
        );
        let rows: Vec<Vec<String>> = summary
            .iter()
            .map(|(label, values_text, capped, delta, per_swing, ttk)| {
                vec![
                    label.clone(),
                    values_text.clone(),
                    fmt(&Num(*capped)),
                    format!(
                        "{}{}",
                        if *delta >= 0.0 { "+" } else { "" },
                        fmt(&Num(*delta))
                    ),
                    fmt(&Num(*per_swing)),
                    ttk_cell(*ttk),
                ]
            })
            .collect();
        out.push_str(&table(
            &rows,
            &[
                "Channel",
                "Current → cap",
                "Capped DPS now",
                "Δ at cap",
                "Per swing at cap",
                "TTK at cap",
            ],
            &[false, true, true, true, true, true],
        ));
        return Ok(format!("{out}\n"));
    }
    let mut rows: Vec<ScaleRow> = Vec::new();
    if let Some(first) = values.stat.first() {
        if values.stat.len() > 1 {
            return Err(usage(
                "scale accepts one --stat per run; run it once per stat",
            ));
        }
        let k = first.to_lowercase();
        if !STAT_KEYS.contains(&k.as_str()) {
            return Err(usage(format!("unknown stat {k}")));
        }
        rows.extend(one(
            &format!("stat {k}"),
            "stat",
            &Str(k.clone()),
            live_stat(&ch, &k),
            100.0,
        ));
    } else if let Some(&id) = values.nums.get("skill") {
        if !(0.0..35.0).contains(&id) {
            return Err(usage("--skill expects a skill id 0..34"));
        }
        let cur = ch.get("skills").prop(&Num(id)).num_or(0.0);
        rows.extend(one(
            &format!("skill {}", number_to_string(id)),
            "skill",
            &Num(id),
            cur,
            200.0,
        ));
    } else if let Some(&id) = values.nums.get("gear-skill") {
        if !(0.0..35.0).contains(&id) {
            return Err(usage("--gear-skill expects a skill id 0..34"));
        }
        let cur = ch.get("_mods").get("skills").prop(&Num(id)).num_or(0.0);
        rows.extend(one(
            &format!("gear skill {}", number_to_string(id)),
            "gear",
            &Num(id),
            cur,
            cur + 100.0,
        ));
    } else {
        return Err(usage(
            "scale needs --stat <name>, --skill <id>, --gear-skill <id>, or --all",
        ));
    }
    if values.json {
        let arr = Arr(rows
            .iter()
            .map(|r| {
                obj([
                    ("label", Str(r.label.clone())),
                    ("value", Num(r.value)),
                    ("dps", Num(r.dps)),
                    ("dpsMin", Num(r.dps_min)),
                    ("dpsMax", Num(r.dps_max)),
                    ("cappedDps", Num(r.capped_dps)),
                    ("cappedDpsMin", Num(r.capped_dps_min)),
                    ("cappedDpsMax", Num(r.capped_dps_max)),
                    ("perSwing", Num(r.per_swing)),
                    ("ttk", r.ttk.map_or(Null, Num)),
                ])
            })
            .collect());
        return Ok(format!("{}\n", json(&arr)));
    }
    let mut out = format!(
        "{}  |  target {}  |  {}{}\n",
        character_label(&ch),
        values.target,
        values.core,
        if ch.get("online").truthy() {
            " / online"
        } else {
            " / offline"
        }
    );
    let table_rows: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            vec![
                r.label.clone(),
                number_to_string(r.value),
                fmt(&Num(r.dps)),
                fmt(&Num(r.capped_dps)),
                fmt(&Num(r.per_swing)),
                ttk_cell(r.ttk),
            ]
        })
        .collect();
    out.push_str(&table(
        &table_rows,
        &["Channel", "Value", "DPS", "Capped", "Per swing", "TTK"],
        &[false, true, true, true, true, true],
    ));
    Ok(format!("{out}\n"))
}

/// One `scale` curve row: the JS object `{ label, value, dps, ..., perSwing, ttk }` (`src/cli.js:2152`).
struct ScaleRow {
    label: String,
    value: f64,
    dps: f64,
    dps_min: f64,
    dps_max: f64,
    capped_dps: f64,
    capped_dps_min: f64,
    capped_dps_max: f64,
    per_swing: f64,
    ttk: Option<f64>,
}

/// The `one` body's edit, `src/cli.js:2138-2152`: a JSON copy with one field set. `scale` reaches `stat`, `skill` and
/// `gear`; the JS `one` also has a `star` arm, which only `graph` selects.
fn apply_scale(c: &mut Value, kind: &str, id: &Value, value: f64) {
    match kind {
        "stat" => {
            let mut stats = c.get("stats").clone();
            stats.set(&id.to_js_string(), Num(value));
            c.set("stats", stats);
        }
        "skill" => set_skill(c, &id.to_js_string(), value),
        _ => {
            // `gear`: `_mods.skills[id] = value`, with the two maps created when absent.
            let key = id.to_js_string();
            let mut mods = c.get("_mods").clone();
            if mods.is_nullish() {
                mods = obj([("stats", Obj(vec![])), ("skills", Obj(vec![]))]);
            }
            let mut skills = mods.get("skills").clone();
            if skills.is_nullish() {
                skills = Obj(vec![]);
            }
            skills.set(&key, Num(value));
            mods.set("skills", skills);
            c.set("_mods", mods);
        }
    }
}

/// `dfo-dps report` (`src/cli.js:2263-2275`): the single-file page from [`report::build_report`] at the scenario the
/// other page commands share, written through `probe`'s create-only writer. The JS `writeFileSync` truncates an
/// existing path; this refuses it with exit 2 and leaves it untouched (the same deliberate deviation `probe`/`graph`
/// pin). stdout is the JS `report written: <file>` line in both modes - `report` has no `--json` branch.
fn report_command(values: &Values, out_flag: Option<&str>) -> Result<String, CliError> {
    let book = saves::load_spellbook();
    let ch = character(values, &book)?;
    let target = target_of(
        &ch,
        values,
        &values.traits,
        values.nums.get("health").copied(),
    )?;
    let mut scenario = scenario_of(&ch, values, &values.traits, &target);
    // `scenarioOf` (`src/cli.js:559`): a save's `--weapon` override lives on the scenario; the theory character already
    // applied it when it was built.
    if !values.theory {
        if let Some((tpl, mat)) = values.weapon {
            scenario.set("weapon", synthetic_weapon(&Num(tpl), &Num(mat), values.rri));
        }
    }
    // The JS passes `traitsOf(values)`, not the scenario's nullish fallback: an empty `--traits` stays a list, so the
    // target's own traits do not replace it (`buildReport`'s `traits ?? target?.bossTraits ?? []`).
    let opts = obj([
        ("target", target),
        ("core", scenario.get("core").clone()),
        (
            "traits",
            Arr(values.traits.iter().map(|t| Str(t.clone())).collect()),
        ),
        ("health", scenario.get("health").clone()),
        ("swing", scenario.get("swing").clone()),
        ("passiveOn", scenario.get("passiveOn").clone()),
        ("stacks", scenario.get("stacks").clone()),
        ("rhythm", scenario.get("rhythm").clone()),
        ("unaware", scenario.get("unaware").clone()),
        ("firstBlow", scenario.get("firstBlow").clone()),
        ("healthShare", scenario.get("healthShare").clone()),
        (
            "attackerHealthShare",
            scenario.get("attackerHealthShare").clone(),
        ),
        ("backstabUptime", scenario.get("backstabUptime").clone()),
        ("players", Num(values.num("players", 1.0))),
        ("blowX", Num(values.num("blow-x", 1.0))),
        ("rri", Bool(values.rri)),
        ("pair", Bool(values.pair)),
        ("bowSpam", Bool(values.spam)),
        ("potencyPct", Num(values.num("potency", 0.0))),
        ("pierce", Num(values.num("pierce", 0.0))),
        ("weapon", scenario.get("weapon").clone()),
    ]);
    let html = report::build_report(&ch, &opts, &book);
    // `path.resolve(values.out)`: the JS default name, with no per-command rename (unlike probe/graph).
    let out = probe::normalized(out_flag.unwrap_or("dfo-dps-report.html"));
    probe::write_page(&out, &html)?;
    Ok(format!("report written: {}\n", out.display()))
}

/// `dfo-dps firmament` (`src/cli.js:1390-1441`): plan each `--build` at `--stars`, print the JS card (or the `--json`
/// document), and write the multi-section page from [`firmament::firmament_section`] through the shared renderer.
///
/// The JS also keeps a disk cache (`.cache/firmament-plans.json`) and prints `Firmament plans (N cached, M computed)`;
/// this CLI writes no cache, replans every run, and prints the bare `Firmament plans` line, so it never claims a cache
/// hit it did not have (module doc). `--refresh` therefore changes nothing. The page is create-only, as `report`'s is.
fn firmament_command(values: &Values, out_flag: Option<&str>) -> Result<String, CliError> {
    let all: Vec<String> = build_ids().iter().map(|id| id.to_js_string()).collect();
    // `values.build ? String(values.build).split(',').map(trim).filter(Boolean) : buildIds()`; an empty string is falsy
    // in the JS `values.build ?`, so it takes every build, while a whitespace-only value is truthy and splits to none.
    let ids: Vec<String> = match values.build.as_deref() {
        None | Some("") => all.clone(),
        Some(raw) => raw
            .split(',')
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .map(str::to_owned)
            .collect(),
    };
    let unknown: Vec<&str> = ids
        .iter()
        .filter(|id| build_by_id(&Str((*id).clone())).is_none())
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        return Err(usage(format!(
            "unknown firmament build: {} (choose {})",
            unknown.join(", "),
            all.join(", ")
        )));
    }
    // `--stars` is validated as an integer 0..98, so the JS re-clamp here is an identity; absent is 98.
    let stars = values.nums.get("stars").copied().unwrap_or(98.0);
    // The JS `--refresh` drops its disk cache; this CLI keeps none, so it recomputes either way (module doc).
    let plans: Vec<Value> = ids
        .iter()
        .filter_map(|id| build_by_id(&Str(id.clone())))
        .map(|build| plan_build(build, &obj([("stars", Num(stars))])))
        .collect();
    let mut out = String::from("Firmament plans\n");
    if !values.json {
        let rows: Vec<Vec<String>> = plans
            .iter()
            .map(|p| {
                let sum = dfo_core::firmament::plan_summary(p);
                vec![
                    p.get("build").get("name").to_js_string(),
                    p.get("startName").to_js_string(),
                    format!(
                        "{}/{}{}",
                        p.get("stars").to_js_string(),
                        p.get("starBudget").to_js_string(),
                        if p.get("freeStars").truthy() {
                            format!(" (+{} free)", p.get("freeStars").to_js_string())
                        } else {
                            String::new()
                        }
                    ),
                    group_cell(p, &sum),
                    sum.get("counts").get("notable").to_js_string(),
                    sum.get("counts").get("keystone").to_js_string(),
                ]
            })
            .collect();
        out.push_str(&format!(
            "{}\n",
            table(
                &rows,
                &["Build", "Start", "Stars", "Group", "Notables", "Keystones"],
                &[false, false, true, true, true, true]
            )
        ));
    }
    let sections: Vec<graph::Section> = plans.iter().map(firmament::firmament_section).collect();
    let html = graph::multi_graph_page(
        "DFO Firmament trees",
        &format!(
            "The game's own {FIRMAMENT_NODES} stars, {} Stars per build, no Craft points assumed. One deterministic channel-coverage plan per build; keystones are never walked through. The weapons page +Firmament column is the flat channel ceiling, not this allocation.",
            number_to_string(stars)
        ),
        &sections,
    );
    // `path.resolve(values.out === 'dfo-dps-report.html' ? 'firmament.html' : values.out)` (`:1431`).
    let out_path = match out_flag {
        None | Some("dfo-dps-report.html") => "firmament.html".to_owned(),
        Some(name) => name.to_owned(),
    };
    let out_path = probe::normalized(&out_path);
    probe::write_page(&out_path, &html)?;
    if values.json {
        let doc = Arr(plans
            .iter()
            .map(|p| {
                obj([
                    ("build", p.get("build").get("id").clone()),
                    ("name", p.get("build").get("name").clone()),
                    ("start", p.get("tree").get("start").clone()),
                    ("startName", p.get("startName").clone()),
                    ("stars", p.get("stars").clone()),
                    ("budget", p.get("starBudget").clone()),
                    ("freeStars", p.get("freeStars").clone()),
                    ("keys", p.get("tree").get("keys").clone()),
                    ("totals", p.get("totals").clone()),
                ])
            })
            .collect());
        return Ok(format!("{}\n", json(&doc)));
    }
    out.push_str(&format!("firmament page written: {}\n", out_path.display()));
    Ok(out)
}

/// `dfo-dps imprints` (`src/cli.js:1219-1263`): rank every imprint family (or the one `--family` names) through
/// `dfo_core::imprints::rank_all`, print the JS card or the `--json` rows, and write the page from [`imprints`].
///
/// The order is resolved exactly as the JS nested ternary: `--uncapped`, then `--cap-aware` (boss), then `--sort`. The
/// rows are the theory max profiles; no save is read. `--family ''` is falsy in the JS `values.family ?`, so it keeps
/// every family rather than raising; an unknown non-empty key is the JS `console.error` + `process.exit(2)`.
fn imprints_command(values: &Values, out_flag: Option<&str>) -> Result<String, CliError> {
    let family = values
        .family
        .as_deref()
        .filter(|f| !f.is_empty())
        .map(|f| {
            dfo_core::imprints::imprint_family_by_id(&Str(f.to_owned()))
                .map(|found| found.get("key").to_js_string())
                .ok_or_else(|| CliError {
                    message: format!("unknown imprint family: {f}"),
                    code: 2,
                })
        })
        .transpose()?;
    let sort = if values.uncapped {
        "uncapped"
    } else if values.cap_aware {
        "boss"
    } else {
        match values.sort.as_deref() {
            Some("uncapped") => "uncapped",
            Some("conditional") => "conditional",
            _ => "boss",
        }
    };
    let book = saves::load_spellbook();
    let mut profiles = Profiles::new(&book);
    let ranked = dfo_core::imprints::rank_all(
        &obj([
            ("firmament", Bool(values.firmament)),
            ("vampire", Bool(values.vampire)),
            ("sort", Str(sort.to_owned())),
        ]),
        &mut profiles,
    )
    .map_err(usage)?;
    let rows = Arr(ranked
        .items()
        .iter()
        .filter(|f| family.as_ref().is_none_or(|key| f.get("key").is_str(key)))
        .cloned()
        .collect());
    // `path.resolve(values.out === 'dfo-dps-report.html' ? 'imprints.html' : values.out)`.
    let out = match out_flag {
        None | Some("dfo-dps-report.html") => "imprints.html".to_owned(),
        Some(name) => name.to_owned(),
    };
    let out = probe::normalized(&out);
    probe::write_page(&out, &imprints::page(&rows, values.firmament, sort))?;
    if values.json {
        return Ok(format!("{}\n", json(&imprints_doc(&rows))));
    }
    Ok(format!(
        "{}imprints page written: {}\n",
        imprints::text(&rows),
        out.display()
    ))
}

/// `dfo-dps enchant` (`src/cli.js:1449-1477`): the equipped weapon's enchantment procs, text or `--json`. The card and
/// `--json` document are `enchant::text`/`enchant::document`; this owns the target/scenario the JS branch rebuilds and
/// the Cast When Strikes payload's spellbook.
///
/// The branch resolves `enchantTarget` (a raw `--target armoured` is the gate), rebuilds `r` at that target with the
/// branch's `potency`/`pierce`, and uses `strikeEnchantments` with `{ level, potencyPct, pierce }` - no `standard`, so
/// the JS default `standardSpells()` (the launcher's `SPELLS.STD`) prices the procs, exactly as [`saves::load_spellbook`]
/// does here. A save with no weapon prints the JS line and exits 0.
///
/// `dfo-dps enchant-plan` / `dfo-dps gear-plan` (`src/cli.js:1084-1217`): the per-piece enchant priority plan, one
/// weapon (text, `--json` or its page), or both modes' matrices with `--all` (text, `--json` or the plans page). The
/// plan is `dfo_core::enchant_plan::plan_enchants`/`plan_matrix`; this function owns the branch's flag resolution, the
/// mode select, the create-only page write and the two `... page written:` lines.
///
/// `--shield` and `--group` were already validated by [`Values::new`]; `--group` is refused here with the JS
/// `console.error` line and exit 2, because the JS checks it inside the branch.
fn enchant_plan_command(values: &Values, out_flag: Option<&str>) -> Result<String, CliError> {
    const GROUPS: [&str; 4] = ["undead", "daedra", "humanoid", "animal"];
    if !GROUPS.contains(&values.group.as_str()) {
        return Err(usage(format!("unknown Potent Vs group: {}", values.group)));
    }
    let weapon = values.weapon.map_or(123.0, |(tpl, _)| tpl);
    let repairs = 0.0f64.max(values.num("repairs", 1.0).trunc());
    let regen = 0.0f64.max(values.num("regen", 0.0).trunc());
    let book = saves::load_spellbook();
    // `gateTarget(THEORY_LEVEL)` and `referenceFoe(THEORY_LEVEL, 'tough')`: the branch's own two targets.
    let gate = gate_target(&Num(THEORY_LEVEL), &Obj(vec![]));
    let uncapped_target = reference_foe(&Num(THEORY_LEVEL), &Str("tough".to_owned()));
    let all_modes: [(&'static str, &'static str, bool, Value); 2] = [
        ("uncapped", "Uncapped theory", true, uncapped_target),
        ("cap", "Cap-aware", false, gate),
    ];
    let selected: Vec<(&'static str, &'static str, bool, Value)> = if values.uncapped {
        vec![all_modes[0].clone()]
    } else if values.cap_aware {
        vec![all_modes[1].clone()]
    } else if values.all {
        all_modes.to_vec()
    } else {
        vec![all_modes[1].clone()]
    };
    if values.all {
        let mut profiles = Profiles::new(&book);
        let modes: Vec<enchant_plan::AllMode> = selected
            .iter()
            .map(|(key, label, force_skills, target)| enchant_plan::AllMode {
                key,
                label,
                matrix: dfo_core::enchant_plan::plan_matrix_with(
                    &obj([
                        ("soulGem", Bool(values.soul_gem)),
                        ("repairs", Num(repairs)),
                        ("regen", Num(regen)),
                        ("group", Str(values.group.clone())),
                        ("forceSkills", Bool(*force_skills)),
                        ("target", target.clone()),
                    ]),
                    &mut profiles,
                )
                .expect("planMatrix"),
            })
            .collect();
        let out_path = probe::normalized(match out_flag {
            None | Some("dfo-dps-report.html") => "enchant-plans.html",
            Some(name) => name,
        });
        probe::write_page(&out_path, &enchant_plan::all_page(&modes, values.soul_gem))?;
        if values.json {
            return Ok(format!("{}\n", json(&enchant_plan::all_document(&modes))));
        }
        let mut printed = enchant_plan::all_text(&modes, values.soul_gem);
        printed.push_str(&format!(
            "enchant plans page written: {}\n",
            out_path.display()
        ));
        return Ok(printed);
    }
    let (_, _, force_skills, target) = &selected[0];
    let plan = dfo_core::enchant_plan::plan_enchants(
        &obj([
            ("weapon", Num(weapon)),
            ("shield", Str(values.shield.clone())),
            ("soulGem", Bool(values.soul_gem)),
            ("group", Str(values.group.clone())),
            ("repairs", Num(repairs)),
            ("regen", Num(regen)),
            ("forceSkills", Bool(*force_skills)),
            ("target", target.clone()),
        ]),
        &book,
    )
    .expect("planEnchants");
    let out_path = probe::normalized(match out_flag {
        None | Some("dfo-dps-report.html") => "enchant-plan.html",
        Some(name) => name,
    });
    probe::write_page(&out_path, &enchant_plan::page(&plan, &values.group))?;
    if values.json {
        return Ok(format!("{}\n", json(&enchant_plan::document(&plan))));
    }
    let mut printed = enchant_plan::text(&plan);
    printed.push_str(&format!("enchant plan written: {}\n", out_path.display()));
    Ok(printed)
}

fn enchant_command(values: &Values) -> Result<String, CliError> {
    let book = saves::load_spellbook();
    let ch = character(values, &book)?;
    if !ch.get("weapon").truthy() {
        return Ok("No weapon equipped. Pass --weapon or load a save with a weapon.\n".to_owned());
    }
    let target = target_of(
        &ch,
        values,
        &values.traits,
        values.nums.get("health").copied(),
    )?;
    // `const enchantTarget = values.target === 'armoured' ? gateTarget(n(values.level, ch.level), { traits }) : target`
    // (`src/cli.js:1455`). The test is the RAW flag, not the resolved target, so a save's `--target armoured` is the
    // gate here too even though `target_of` priced its reference foe. `traits` is the array itself (`traitsOf` gives
    // `[]`), which `gateTarget`'s `traits ?? relayTraitsFor('breach')` does NOT replace - only null/undefined does.
    let enchant_target = if values.target == "armoured" {
        let mut opts = Obj(vec![]);
        opts.set(
            "traits",
            Arr(values.traits.iter().map(|t| Str(t.clone())).collect()),
        );
        gate_target(
            &Num(values.num("level", ch.get("level").to_number())),
            &opts,
        )
    } else {
        target.clone()
    };
    let opts = obj([
        (
            "level",
            Num(values.num("level", ch.get("level").to_number())),
        ),
        ("potencyPct", Num(values.num("potency", 0.0))),
        ("pierce", Num(values.num("pierce", 0.0))),
    ]);
    let strike = dfo_core::enchants::strike_enchantments(
        ch.get("weapon"),
        &ch,
        &enchant_target,
        &opts,
        &book,
    );
    // `analyze(ch, { ...scenario, target: enchantTarget, health: ... , potencyPct, pierce })` (`:1460`).
    let mut scenario = scenario_of(&ch, values, &values.traits, &target);
    // `scenarioOf` carries `weapon: values.theory ? undefined : weaponOverride(values)`; the branch overwrites only the
    // target, health, potency and pierce, so a save's `--weapon` still prices the weapon DPS line (`:559`).
    if !values.theory {
        if let Some((tpl, mat)) = values.weapon {
            scenario.set("weapon", synthetic_weapon(&Num(tpl), &Num(mat), values.rri));
        }
    }
    scenario.set("target", enchant_target.clone());
    scenario.set(
        "health",
        Num(if enchant_target.get("isBoss").truthy() {
            enchant_target.get("maxHealth").to_number()
        } else {
            0.0
        }),
    );
    scenario.set("potencyPct", Num(values.num("potency", 0.0)));
    scenario.set("pierce", Num(values.num("pierce", 0.0)));
    let card = analyze(&ch, &scenario, &book).to_value();
    let item = ch.get("weapon");
    if values.json {
        return Ok(format!(
            "{}\n",
            json(&enchant::document(item, &strike, &card))
        ));
    }
    Ok(enchant::text(&ch, item, &strike, &card))
}

/// `dfo-dps spell` (`src/cli.js:1516-1599`): one spell's rotation card, the `--list` spellbook table, or the
/// `--all-spells` price table, text or `--json`. The renderers own the strings and documents; this owns the branch's
/// pool resolution, pricing, selection, empty-book line and the theory caster tweak.
///
/// The book is `standardSpells(values.data ?? undefined)` as one fresh JS process observes it: the module cache is
/// already warm from `loadCharacter`'s `legalGear` and the pre-branch `analyze`, so a resolvable launcher config wins
/// over `--data` ([`saves::standard_spells`]). `resolveSpells(ch.spells, standard)` then takes the save's indices and
/// custom records, and `pool = values.standard ? standardList : (known.length ? known : standardList)`.
///
/// Ordinals are faithful to the JS branch: `--list` returns before `--all-spells`, `--all-spells` prints its table even
/// under `--json` (that branch uses `console.log`, not `textOut`), and the empty-book line fires only when neither
/// `--spell` nor `--standard` is given. A `--standard` run with no matching record has no `priced[0]`, which the JS
/// destructuring turns into a crash (exit 1); that is reproduced rather than papered over, with the message line only
/// (V8's frames are not reproduced, as `objective`'s engine refusals are not).
fn spell_command(values: &Values) -> Result<String, CliError> {
    let book = saves::load_spellbook();
    let ch = character(values, &book)?;
    // `src/cli.js:1517`: the theory caster tweak, inside the branch (so a save is untouched).
    let ch = if values.theory { theory_caster(ch) } else { ch };
    // `standardSpells(values.data ?? undefined)`: the module cache is already warm from the pre-branch analysis, so a
    // resolvable launcher config wins over `--data` (see [`saves::standard_spells`]).
    let data_book = saves::standard_spells(values.data.as_deref());
    let standard_list: Vec<Value> = data_book
        .entries()
        .iter()
        .map(|(_, sp)| sp.clone())
        .collect();
    let known: Vec<Value> = resolve_spells(ch.get("spells"), &data_book)
        .into_iter()
        .cloned()
        .collect();
    let pool: Vec<Value> = if values.standard || known.is_empty() {
        standard_list.clone()
    } else {
        known
    };
    // `searchPool = values.spell != null ? [...pool, ...standardList.filter(...)] : pool`: the pool's records keep
    // their place, then every standard record the pool does not already carry by index.
    let search_pool: Vec<Value> = match values.spell_query {
        Some(_) => {
            let mut search = pool.clone();
            search.extend(
                standard_list
                    .iter()
                    .filter(|sp| {
                        !pool
                            .iter()
                            .any(|p| p.get("index").strict_eq(sp.get("index")))
                    })
                    .cloned(),
            );
            search
        }
        None => pool.clone(),
    };
    // `spellTarget = values.target === 'armoured' ? gateTarget(level, { traits }) : target` (`:1527`): the RAW flag,
    // and `traits` is the array itself, even empty, so no relay traits are substituted (`?? ` only replaces nullish).
    let (spell_target, opts) = spell_target_and_opts(values, &ch)?;
    let priced = spell::price_pool(&pool, &ch, &spell_target, &opts);
    let search_priced = spell::price_search(&search_pool, &ch, &spell_target, &opts);
    // `if (!priced.length && values.spell == null && !values.standard)` (`:1546-1549`): the `--spell` and `--standard`
    // flags are part of the test.
    if priced.is_empty() && values.spell_query.is_none() && !values.standard {
        return Ok(
            "No damaging spells in the spellbook. Pass --spell <index|name> or --standard.\n"
                .to_owned(),
        );
    }
    if values.list {
        return Ok(spell::text(&ch, &pool, &spell_target, &opts));
    }
    if values.all_spells {
        let mut out = spell::all_spells_text(&priced);
        if values.json {
            out.push_str(&format!("{}\n", json(&spell::all_spells_document(&priced))));
        }
        return Ok(out);
    }
    let chosen = spell::select(&priced, &search_priced, values.spell_query.as_deref()).ok_or_else(|| {
        match values.spell_query.as_deref() {
            Some(query) => usage(format!(
                "spell \"{query}\" not found in the resolved spellbook"
            )),
            // The JS `const { sp } = chosen` on `priced[0]` undefined: a crash, exit 1.
            None => CliError {
                message: "TypeError: Cannot destructure property 'sp' of 'chosen' as it is undefined."
                    .to_owned(),
                code: 1,
            },
        }
    })?;
    let mut rotation_opts = opts.clone();
    rotation_opts.set("seconds", Num(values.num("seconds", 30.0)));
    let r = dfo_core::spells::spell_rotation(&chosen.sp, &ch, &spell_target, &rotation_opts);
    if values.json {
        return Ok(format!(
            "{}\n",
            json(&spell::rotation_document(&chosen.sp, &r))
        ));
    }
    Ok(spell::rotation_text(
        &ch,
        &chosen.sp,
        &r,
        &values.target,
        &spell_target,
    ))
}

/// The `spell`/`spells` branches' shared `spellTarget` and `opts` (`src/cli.js:1486-1491` and `:1527-1538`): the RAW
/// `--target armoured` is the Breach gate (not the reference foe `target_of` prices), `traits` is the array itself even
/// when empty, and the branch's `opts` carries the resolved level. The singular and plural branches build the same two
/// records, field for field, so they share one reader.
fn spell_target_and_opts(values: &Values, ch: &Value) -> Result<(Value, Value), CliError> {
    let level = values.num("level", ch.get("level").to_number());
    let spell_target = if values.target == "armoured" {
        let mut opts = Obj(vec![]);
        opts.set(
            "traits",
            Arr(values.traits.iter().map(|t| Str(t.clone())).collect()),
        );
        gate_target(&Num(level), &opts)
    } else {
        target_of(
            ch,
            values,
            &values.traits,
            values.nums.get("health").copied(),
        )?
    };
    // The branch's `opts` (`:1528-1538`), in the JS key order.
    let mut opts = obj([
        ("level", Num(level)),
        ("online", Bool(!ch.get("online").strict_eq(&Bool(false)))),
        ("potencyPct", Num(values.num("potency", 0.0))),
        ("pierce", Num(values.num("pierce", 0.0))),
        ("castSpeedPct", Num(values.num("cast-speed", 0.0))),
        ("manaSolved", Bool(!values.mana_limit)),
        (
            "health",
            Num(if spell_target.get("isBoss").truthy() {
                spell_target.get("maxHealth").to_number()
            } else {
                0.0
            }),
        ),
        (
            "traits",
            Arr(spell_target.get("bossTraits").items().to_vec()),
        ),
    ]);
    if let Some(magicka) = values.nums.get("magicka") {
        opts.set("magicka", Num(*magicka));
    }
    Ok((spell_target, opts))
}

/// `dfo-dps spells` (`src/cli.js:1480-1514`): every standard damage spell as the `DFO spell ceiling` page, or its
/// `--json` list. The renderer is [`spells_report`]; this owns the branch's pool merge, empty-list line, page name and
/// the create-only write.
///
/// The pool is `[...standard.values(), ...known.filter((sp) => !standard.has(sp.index))]`: the standard book's own
/// order, then the save's custom records (its stock indices resolve to the same book records and are dropped). Unlike
/// the singular command, `--list`/`--all-spells`/`--spell` do not apply: their flags stay accepted (the shared allowlist)
/// and are ignored exactly as the JS ignores them here.
fn spells_command(values: &Values, out_flag: Option<&str>) -> Result<String, CliError> {
    let book = saves::load_spellbook();
    let ch = character(values, &book)?;
    // `src/cli.js:1481`: the theory caster tweak, the same one the singular branch applies.
    let ch = if values.theory { theory_caster(ch) } else { ch };
    // `standardSpells(values.data ?? undefined)`: a resolvable launcher config wins over `--data`, as on `spell`.
    let data_book = saves::standard_spells(values.data.as_deref());
    let known: Vec<Value> = resolve_spells(ch.get("spells"), &data_book)
        .into_iter()
        .cloned()
        .collect();
    let pool = spells_report::pool(&data_book, &known);
    let (spell_target, opts) = spell_target_and_opts(values, &ch)?;
    let seconds = values.num("seconds", 30.0);
    let potency = values.num("potency", 0.0);
    let pierce = values.num("pierce", 0.0);
    let list = spells_report::ranked(&pool, &ch, &spell_target, &opts, seconds);
    // `if (!list.length) { console.log('No standard damage spells found. Check --data / ARENA2.'); return; }`: before
    // any page is built, exit 0. The line is a plain `console.log`, so it prints under `--json` too, and no page exists.
    if list.is_empty() {
        return Ok("No standard damage spells found. Check --data / ARENA2.\n".to_owned());
    }
    // `path.resolve(values.out === 'dfo-dps-report.html' ? 'spells.html' : values.out)` (`:1509`).
    let out = match out_flag {
        None | Some("dfo-dps-report.html") => "spells.html".to_owned(),
        Some(name) => name.to_owned(),
    };
    let out = probe::normalized(&out);
    let html = spells_report::page(&ch, &list, &spell_target, seconds, potency, pierce);
    probe::write_page(&out, &html)?;
    if values.json {
        return Ok(format!("{}\n", json(&spells_report::document(&list))));
    }
    Ok(format!("spells page written: {}\n", out.display()))
}

/// `src/cli.js:1517`: the theory caster the `spell`/`spells` branches build - Destruction 200 and mastered, a spell
/// point pool (falling back to `floor(intelligence * 3)` when it has none), and the name the card prints.
fn theory_caster(mut ch: Value) -> Value {
    let mut skills = Arr(ch.get("skills").items().to_vec());
    if let Value::Arr(items) = &mut skills {
        while items.len() <= 22 {
            items.push(Num(0.0));
        }
        items[22] = Num(200.0);
    }
    ch.set("skills", skills);
    // `[...new Set([...(ch.masteredSkills ?? []), 22])]`: append if absent, same-value-zero, keeping the saved order.
    let mut mastered = ch.get("masteredSkills").items().to_vec();
    if !mastered.iter().any(|v| v.strict_eq(&Num(22.0))) {
        mastered.push(Num(22.0));
    }
    ch.set("masteredSkills", Arr(mastered));
    // `ch.maxMagicka || Math.floor((ch.stats.intelligence ?? 100) * 3)`: a falsy pool (0/NaN) takes the fallback.
    if !ch.get("maxMagicka").truthy() {
        ch.set(
            "maxMagicka",
            Num((ch.get("stats").get("intelligence").num_or(100.0) * 3.0).floor()),
        );
    }
    ch.set("name", Str("Level 45 theory caster".to_owned()));
    ch
}

/// `dfo-dps tradeoff` (`src/cli.js:2204-2252`): speed vs damage over the Breach gate and five Curbing pools, text or
/// `--json`. The pools, the verdict text and the crossover are [`tradeoff`]'s; this owns the character, the base
/// scenario and the two flags the gate carries.
///
/// The branch never calls `targetOf`: it builds `scenarioOf(ch, values, traits, t)` per pool with that pool's own
/// target, then overwrites `target`, `health` and `traits` (`src/cli.js:2218`). So `--target`, `--health` and
/// `--armor` do not reach the pools (they are overridden), and `--level` only moves the theory character; the fields
/// that do reach them are the shared scenario options and a save's `--weapon`. The gate's level is `ch.level`, not
/// `n(values.level, ch.level)` (`src/cli.js:2207`).
fn tradeoff_command(values: &Values) -> Result<String, CliError> {
    let book = saves::load_spellbook();
    let ch = character(values, &book)?;
    let players = values.num("players", 1.0);
    let blow_x = values.num("blow-x", 1.0);
    let gate = gate_target(
        ch.get("level"),
        &obj([("players", Num(players)), ("blowX", Num(blow_x))]),
    );
    // The per-pool spread replaces `target`, `health` and `traits`, so any target prices the same shared options; the
    // gate body is the one the branch names. A save's `--weapon` still rides the scenario (`src/cli.js:559`).
    let mut scenario = scenario_of(&ch, values, &values.traits, &gate);
    if !values.theory {
        if let Some((tpl, mat)) = values.weapon {
            scenario.set("weapon", synthetic_weapon(&Num(tpl), &Num(mat), values.rri));
        }
    }
    if values.json {
        return Ok(format!(
            "{}\n",
            json(&tradeoff::document(&ch, &scenario, players, blow_x, &book))
        ));
    }
    Ok(tradeoff::text(
        &ch,
        &scenario,
        &values.core,
        players,
        blow_x,
        &book,
    ))
}

/// The JS `--json` document (`src/cli.js:1262`): one record per family, one row per imprint, field for field.
fn imprints_doc(rows: &Value) -> Value {
    let mut families = Vec::new();
    for f in rows.items() {
        let mut list = Vec::new();
        for r in f.get("rows").items() {
            list.push(obj([
                ("id", r.get("id").clone()),
                ("record", r.get("name").clone()),
                ("power", r.get("power").get("name").clone()),
                ("weapon", r.get("weapon").clone()),
                ("baseDps", r.get("baseDps").clone()),
                ("conditionalDps", r.get("conditionalDps").clone()),
                ("uncappedDps", r.get("uncappedDps").clone()),
                ("delta", r.get("delta").clone()),
                ("uncappedDelta", r.get("uncappedDelta").clone()),
                ("triggerDelta", r.get("triggerDelta").clone()),
                ("trigger", r.get("trigger").clone()),
                ("hit", r.get("hit").clone()),
                ("effect", r.get("power").get("brief").clone()),
            ]));
        }
        families.push(obj([
            ("family", f.get("key").clone()),
            ("weapon", f.get("weapon").clone()),
            ("template", f.get("template").clone()),
            ("baseDps", f.get("base").get("carriedCappedDps").clone()),
            ("cardBaseDps", f.get("base").get("cappedDps").clone()),
            ("metric", Str("carried".to_owned())),
            ("rows", Arr(list)),
        ]));
    }
    Arr(families)
}

/// The card's `Group` cell (`src/cli.js:1408`): the blow row for a weapon build, the cast-cost row for a spell build,
/// else the plan's own HP. `s.rows.find(...)?.value ?? 0` is the first row with that key, or 0 when there is none.
fn group_cell(plan: &Value, sum: &Value) -> String {
    let build = plan.get("build");
    let row = |key: &str| -> Value {
        for r in sum.get("rows").items() {
            if r.get("key").is_str(key) {
                return r.get("value").clone();
            }
        }
        Num(0.0)
    };
    if build.get("skill").truthy() {
        format!("{}%", row("blow").to_js_string())
    } else if build.get("school").truthy() {
        format!("{}%", row("castCost").to_js_string())
    } else {
        format!(
            "{} HP",
            number_to_string(plan.get("totals").get("hp").num_or(0.0))
        )
    }
}

/// `ch.skills[id] = value` for a skill id the JS accepts (`Number(idRaw)` in `0..35`). A fractional id is a named
/// property of the array in the JS, which no analysis reads: the write is a no-op there too, so the curve is flat.
fn set_skill(c: &mut Value, id: &str, value: f64) {
    let id = string_to_number(id);
    let mut skills = c.get("skills").clone();
    if let Value::Arr(items) = &mut skills {
        if id.trunc() == id {
            let index = id as usize;
            if items.len() <= index {
                items.resize(index + 1, Undefined);
            }
            items[index] = Num(value);
        }
    }
    c.set("skills", skills);
}

/// `Number(idRaw)` for a `skill:`/`gear:` spec, with the JS's `!(id >= 0 && id < 35)` check and `bad skill id ${idRaw}`
/// message.
/// `Number(idRaw)` for a `skill:`/`gear:` spec, with the JS's `!(id >= 0 && id < 35)` check and `bad skill id ${idRaw}`
/// message. `Number(undefined)` is NaN, so a bare `skill` spec is refused; `skill:` is `Number("")` = 0, a real skill.
fn skill_id_flag(id_raw: Option<&str>) -> Result<f64, CliError> {
    let Some(raw) = id_raw else {
        return Err(usage("bad skill id undefined"));
    };
    let id = string_to_number(raw);
    if !(0.0..35.0).contains(&id) {
        return Err(usage(format!("bad skill id {raw}")));
    }
    Ok(id)
}

/// `^([a-z]+|\d+)=(-?\d+)$` (the `/i` flag lower-cases the left side): the two `--stat` spellings `compare` accepts.
fn split_stat(text: &str) -> Option<(String, f64)> {
    let (left, right) = text.split_once('=')?;
    let digits_ok = |s: &str| {
        let body = s.strip_prefix('-').unwrap_or(s);
        !body.is_empty() && body.chars().all(|c| c.is_ascii_digit())
    };
    if !digits_ok(right) {
        return None;
    }
    let letters = !left.is_empty() && left.chars().all(|c| c.is_ascii_alphabetic());
    let digits = !left.is_empty() && left.chars().all(|c| c.is_ascii_digit());
    if !letters && !digits {
        return None;
    }
    Some((left.to_lowercase(), string_to_number(right)))
}

/// `theory [options]` (`src/cli.js:1806-2054`): the renderer is [`theory::render`]; this command resolves the theory
/// character, its target and the base scenario exactly as the shared load does, and prints the JS `>38%` stderr warning.
fn theory_command(values: &Values) -> Result<String, CliError> {
    let book = saves::load_spellbook();
    let ch = character(values, &book)?;
    let target = target_of(
        &ch,
        values,
        &values.traits,
        values.nums.get("health").copied(),
    )?;
    let scenario = scenario_of(&ch, values, &values.traits, &target);
    let blade = ch.get("weapon").get("templateIndex");
    let material = ch.get("weapon").get("material");
    let input = theory::Input {
        level: values.num("level", THEORY_LEVEL),
        race: values.race.clone().unwrap_or_else(|| "darkelf".into()),
        blade: if blade.is_nullish() {
            DEFAULT_BLADE
        } else {
            blade.to_number()
        },
        material: if material.is_nullish() {
            9.0
        } else {
            material.to_number()
        },
        star_stats: values.star_stats.clone(),
        star_skills: values.star_skills.clone(),
        vampire: values.vampire,
        gear: theory::GearFlags {
            lb: values.nums.get("gear-lb").copied(),
            cs: values.nums.get("gear-cs").copied(),
            damage_pct: values.nums.get("damage-pct").copied(),
            star_damage: values
                .star_damage
                .unwrap_or(if values.firmament { 30.0 } else { 0.0 }),
        },
        // `src/cli.js:1918`: the raw typed preset, remapped only for the exact `armoured` spelling.
        target_name: if values.theory && values.target == "armoured" {
            "gate".to_owned()
        } else {
            values.target.clone()
        },
        rri: values.rri,
    };
    let rendered = theory::render(&input, &scenario, &book).map_err(usage)?;
    // `src/cli.js:1817-1819`: the hypothetical damage line's warning, on stderr before the card.
    let damage = input
        .gear
        .damage_pct
        .unwrap_or_else(|| rendered_damage(&rendered));
    if damage > 38.0 {
        eprintln!(
            "WARNING: {}% damage is above every Legendary record's fixed line (the best record carries 38%); this is a hypothetical build.",
            number_to_string(damage)
        );
    }
    if values.json {
        return Ok(format!("{}\n", json(&rendered.document)));
    }
    Ok(rendered.text)
}

/// The resolved damage line the card printed, for the `>38%` warning when `--damage-pct` was absent.
fn rendered_damage(rendered: &theory::Rendered) -> f64 {
    rendered.document.get("character").get("damage").to_number()
}

/// `dfo-dps weapons` / `dfo-dps skills` (`src/cli.js:1601-1804`): the weapon ceiling page from [`weapons::render`].
///
/// `--categories` condenses the rows to one winner per type per slot and drops the family/Critical Strike curves; the
/// default shows every row and every curve. The page is create-only (the same deliberate deviation `probe`/`graph`/
/// `report` pin), the default name is `weapons.html` for `weapons` and `skills.html` for the alias, and the JS renames
/// only the untouched report default. text mode prints `weapons page written:`; either mode prints the `--json` document.
/// `dfo-dps loadout` / `dfo-dps real-dps` (`src/cli.js:961-1082`): the shortlist card or the full real-loadout report.
///
/// `--shortlist K` reranks the top K eligible deterministic loadouts per target through
/// [`dfo_core::loadout_shortlist`]; without it the command prices every weapon template and hold configuration
/// (`realWeaponLoadouts`) and prints the two terminal cards plus, always, the create-only `loadouts.html` page (or
/// `--out`, with `loadout page written:` in text mode only). `--json` prints the ranking list or the row list with no
/// `enchPlan`. `--uncapped`/`--cap-aware` pick the modes; `--encounter`/`--all-encounters` pick the cap-aware bodies.
///
/// A shortlist validation failure is a usage error (exit 2), as `isUsageFailure` decides for the JS `RangeError`s.
fn loadout_command(values: &Values, out_flag: Option<&str>) -> Result<String, CliError> {
    // `src/cli.js:962`: `values.uncapped ? ['uncapped'] : values['cap-aware'] ? ['cap'] : ['uncapped', 'cap']`.
    let modes: Vec<&str> = if values.uncapped {
        vec!["uncapped"]
    } else if values.cap_aware {
        vec!["cap"]
    } else {
        vec!["uncapped", "cap"]
    };
    // `:963`: every id, or the one requested (already lower-cased and validated).
    let requested: Vec<String> = if values.all_encounters {
        ENCOUNTER_IDS.iter().map(|id| (*id).to_owned()).collect()
    } else {
        vec![values.encounter.clone()]
    };
    // `:969-981`: `Number(values.shortlist)`, and the branch runs when it is non-zero OR the raw text is empty.
    let k = string_to_number(values.shortlist.trim());
    if k != 0.0 || values.shortlist.trim().is_empty() {
        if !safe_integer(k) || k < 1.0 {
            return Err(usage(
                "--shortlist must be a positive integer (0 disables it)",
            ));
        }
        if values.no_carry {
            return Err(usage(
                "--no-carry does not apply to --shortlist: shortlist sampling always uses carry",
            ));
        }
        return loadout_shortlist(values, &modes, &requested, k);
    }
    // `:982-1081`: the full report.
    let book = saves::load_spellbook();
    let uncapped_rows = if modes.contains(&"uncapped") {
        dfo_core::real_build::real_weapon_loadouts(
            &["uncapped".to_owned()],
            values.vampire,
            "breach",
            &book,
        )
        .map_err(usage)?
    } else {
        Vec::new()
    };
    let mut cap_rows: Vec<(&str, Vec<Value>)> = Vec::new();
    if modes.contains(&"cap") {
        for id in &requested {
            let rows = dfo_core::real_build::real_weapon_loadouts(
                &["cap".to_owned()],
                values.vampire,
                id,
                &book,
            )
            .map_err(usage)?;
            let id = ENCOUNTER_IDS
                .iter()
                .find(|e| *e == id)
                .copied()
                .unwrap_or("breach");
            cap_rows.push((id, rows));
        }
    }
    // `:1005`: `rankAll({ sort: 'uncapped' })`, the first three rows per family.
    let mut profiles = Profiles::new(&book);
    let ranked =
        dfo_core::imprints::rank_all(&obj([("sort", Str("uncapped".to_owned()))]), &mut profiles)
            .map_err(usage)?;
    let imprint_rows: Vec<Value> = ranked
        .items()
        .iter()
        .flat_map(|f| {
            f.get("rows")
                .items()
                .iter()
                .take(3)
                .map(|r| {
                    obj([
                        ("family", f.get("name").clone()),
                        ("power", r.get("power").get("name").clone()),
                        ("weapon", r.get("weapon").clone()),
                        ("carriedBoss", r.get("baseDps").clone()),
                        ("carriedUncapped", r.get("uncappedDps").clone()),
                    ])
                })
                .collect::<Vec<_>>()
        })
        .collect();
    // `:1006-1011`: every build's plan summary row.
    let plans: Vec<Value> = build_ids()
        .iter()
        .filter_map(build_by_id)
        .map(|build| plan_build(build, &obj([])))
        .collect();
    let plan_table = loadout::plan_rows(&plans);
    // `path.resolve(values.out === 'dfo-dps-report.html' ? 'loadouts.html' : values.out)`.
    let out = match out_flag {
        None | Some("dfo-dps-report.html") => "loadouts.html".to_owned(),
        Some(name) => name.to_owned(),
    };
    let out = probe::normalized(&out);
    let page = loadout::report_page(&uncapped_rows, &cap_rows, &imprint_rows, plan_table.items());
    probe::write_page(&out, &page)?;
    let mut all_rows: Vec<Value> = uncapped_rows.clone();
    for (_, rows) in &cap_rows {
        all_rows.extend(rows.iter().cloned());
    }
    if values.json {
        return Ok(format!("{}\n", json(&loadout::report_document(&all_rows))));
    }
    Ok(format!(
        "{}loadout page written: {}\n",
        loadout::report_text(&uncapped_rows, &cap_rows),
        out.display()
    ))
}

/// `printLoadoutShortlist` (`src/cli.js:636-669`): one `shortlistLoadouts` per mode (and per encounter for a cap mode),
/// in the JS order, then the card or its document.
fn loadout_shortlist(
    values: &Values,
    modes: &[&str],
    requested: &[String],
    k: f64,
) -> Result<String, CliError> {
    // `src/cli.js:637-639`: one `--objective` needs one shortlist mode.
    if values.objective.is_some() && modes.len() > 1 {
        return Err(usage(
            "--objective requires one shortlist mode: --uncapped for stochastic-ttk or kill-probability; --cap-aware for stochastic-relay",
        ));
    }
    let sampling = sampled_options(values)?;
    let book = saves::load_spellbook();
    let health = values.nums.get("health").copied().map(Num).unwrap_or(Null);
    let mut rankings: Vec<Value> = Vec::new();
    for mode in modes {
        let encounters: Vec<Option<&str>> = if *mode == "cap" {
            requested.iter().map(|e| Some(e.as_str())).collect()
        } else {
            vec![None]
        };
        for encounter in encounters {
            let opts = obj([
                ("k", Num(k)),
                ("mode", Str((*mode).to_owned())),
                (
                    "encounter",
                    encounter.map_or(Undefined, |e| Str(e.to_owned())),
                ),
                ("vampire", Bool(values.vampire)),
                (
                    "objective",
                    values
                        .objective
                        .as_deref()
                        .map_or(Undefined, |o| Str(o.to_owned())),
                ),
                ("trials", Num(sampling.trials)),
                ("seed", Num(sampling.seed)),
                ("maxSeconds", Num(sampling.max_seconds)),
                ("maxBlows", Num(sampling.max_blows)),
                ("health", health.clone()),
            ]);
            rankings.push(
                dfo_core::loadout_shortlist::shortlist_loadouts(
                    &dfo_core::loadout_shortlist::ShortlistOpts::from_value(&opts),
                    &book,
                )
                .map_err(shortlist_error)?,
            );
        }
    }
    if values.json {
        return Ok(format!(
            "{}\n",
            json(&loadout::shortlist_document(&rankings, values.samples))
        ));
    }
    Ok(loadout::shortlist_text(
        &rankings,
        sampling.trials,
        sampling.max_seconds,
    ))
}

/// The shortlist guards as `isUsageFailure` reads them (`src/usageError.js`): a `RangeError` is bad input (exit 2), and
/// the mode/objective guard is named there too; every other message keeps its crash exit 1.
fn shortlist_error(message: String) -> CliError {
    let usage_failure = message.starts_with("(uncapped|cap) shortlist: choose ")
        || message.starts_with("uncapped shortlist: choose ")
        || message.starts_with("cap shortlist: choose ")
        || message.starts_with("--shortlist")
        || message.starts_with("--trials")
        || message.starts_with("--health")
        || message.starts_with("unknown shortlist mode");
    CliError {
        message,
        code: if usage_failure { 2 } else { 1 },
    }
}

/// `dfo-dps weapons` / `dfo-dps skills` (`src/cli.js:1638-1803`): the weapon ceiling page.
fn weapons_command(
    command: &str,
    values: &Values,
    out_flag: Option<&str>,
) -> Result<String, CliError> {
    let book = saves::load_spellbook();
    let input = weapons::Input {
        // `n(values.level, THEORY_LEVEL)`: the reference foe's and the Breach's level. The characters are level 45.
        level: values.num("level", THEORY_LEVEL),
        firmament: values.firmament,
        vampire: values.vampire,
        race: values.race.clone(),
        categories: values.categories,
    };
    let rendered = weapons::render(&input, &book).map_err(usage)?;
    // `path.resolve(values.out === 'dfo-dps-report.html' ? defaultOut : values.out)`.
    let default_out = if command == "weapons" {
        "weapons.html"
    } else {
        "skills.html"
    };
    let out = match out_flag {
        None | Some("dfo-dps-report.html") => default_out.to_owned(),
        Some(name) => name.to_owned(),
    };
    let out = probe::normalized(&out);
    probe::write_page(&out, &rendered.page)?;
    // `if (!values.json) console.log(...)` then the `if (values.json) console.log(...)` document.
    if values.json {
        return Ok(format!("{}\n", json(&rendered.document)));
    }
    Ok(format!("weapons page written: {}\n", out.display()))
}

/// `dfo-dps compare` (`src/cli.js:2277-2304`): the same build before and after `--stat`/`--weapon`, as a four-column
/// table. The base run drops the scenario's weapon override (it prices the equipped weapon), the changed run applies it.
fn compare(values: &Values) -> Result<String, CliError> {
    let book = saves::load_spellbook();
    let ch = character(values, &book)?;
    let target = target_of(
        &ch,
        values,
        &values.traits,
        values.nums.get("health").copied(),
    )?;
    let scenario = scenario_of(&ch, values, &values.traits, &target);
    let mut changes: Vec<(String, f64)> = Vec::new();
    for raw in &values.stat {
        let Some((name, value)) = split_stat(raw) else {
            return Err(usage(format!("--stat expects name=value, got {raw}")));
        };
        changes.push((name, value));
    }
    if changes.is_empty() && values.weapon.is_none() {
        return Err(usage(
            "compare needs --stat name=value and/or --weapon template:material",
        ));
    }
    let mut c2 = dfo_core::analyze::json_clone(&ch);
    for (name, value) in changes {
        let mut stats = c2.get("stats").clone();
        // JS `name in ch.stats` counts the inherited `constructor`; any other inherited name has an upper-case letter
        // and cannot pass `^[a-z]+$`, so this one key is the whole difference. Setting it is a no-op for the model.
        if stats.has(&name) || name == "constructor" {
            stats.set(&name, Num(value));
            c2.set("stats", stats);
        } else if name.chars().all(|c| c.is_ascii_digit()) {
            // `ch.skills[Number(name)] = value`: the model reads skill ids 0..34 only (`save.js` `skillValue`,
            // `model.js`), so a smaller array extends to reach one, and a larger id (a JS hole) changes nothing.
            let index = string_to_number(&name) as usize;
            let mut skills = c2.get("skills").clone();
            if let Value::Arr(items) = &mut skills {
                if index < 35 {
                    if items.len() <= index {
                        items.resize(index + 1, Undefined);
                    }
                    items[index] = Num(value);
                }
            }
            c2.set("skills", skills);
        } else {
            return Err(usage(format!(
                "unknown stat \"{name}\" (use strength, agility, speed, luck, endurance, willpower, intelligence, personality, or a skill id)"
            )));
        }
    }
    let w2 = values
        .weapon
        .map(|(tpl, mat)| synthetic_weapon(&Num(tpl), &Num(mat), false))
        .unwrap_or(Undefined);
    // `analyze(ch, { ...scenario, weapon: undefined })`: the base run prices the weapon the character carries (for a
    // save this drops `scenarioOf`'s override), and the changed run applies the `--weapon` override (or none).
    let mut base = scenario.clone();
    base.set("weapon", Undefined);
    let mut changed = scenario.clone();
    changed.set("weapon", w2);
    let r = analyze(&ch, &base, &book);
    let r2 = analyze(&c2, &changed, &book);
    let signed =
        |delta: f64, text: String| format!("{}{}", if delta >= 0.0 { "+" } else { "" }, text);
    let d_dps = r2.dps - r.dps;
    let d_per_swing = r2.per_swing - r.per_swing;
    let d_hit = (r2.hit.get("hit").to_number() - r.hit.get("hit").to_number()) * 100.0;
    let d_crit = (r2.hit.get("crit").get("chance").to_number()
        - r.hit.get("crit").get("chance").to_number())
        * 100.0;
    let d_seconds = r2.cadence.get("seconds").to_number() - r.cadence.get("seconds").to_number();
    let d_capped = r2.capped_dps - r.capped_dps;
    let rows: Vec<Vec<String>> = vec![
        vec![
            "DPS".to_owned(),
            fmt(&Num(r.dps)),
            fmt(&Num(r2.dps)),
            signed(d_dps, fmt(&Num(d_dps))),
        ],
        vec![
            "Per swing".to_owned(),
            fmt(&Num(r.per_swing)),
            fmt(&Num(r2.per_swing)),
            signed(d_per_swing, fmt(&Num(d_per_swing))),
        ],
        vec![
            "Hit".to_owned(),
            pc(&r.hit.get("hit").clone()),
            pc(&r2.hit.get("hit").clone()),
            signed(d_hit, format!("{} pt", fmt(&Num(d_hit)))),
        ],
        vec![
            "Crit".to_owned(),
            pc(r.hit.get("crit").get("chance")),
            pc(r2.hit.get("crit").get("chance")),
            signed(d_crit, format!("{} pt", fmt(&Num(d_crit)))),
        ],
        vec![
            "Swing time".to_owned(),
            format!("{}s", fmt2(&r.cadence.get("seconds").clone())),
            format!("{}s", fmt2(&r2.cadence.get("seconds").clone())),
            signed(d_seconds, format!("{}s", fmt2(&Num(d_seconds)))),
        ],
        vec![
            "Capped DPS".to_owned(),
            fmt(&Num(r.capped_dps)),
            fmt(&Num(r2.capped_dps)),
            signed(d_capped, fmt(&Num(d_capped))),
        ],
    ];
    Ok(format!(
        "{}\n{}\n",
        character_label(&ch),
        table(
            &rows,
            &["Metric", "Before", "After", "Change"],
            &[false, false, false, false]
        )
    ))
}

// ---------------------------------------------------------------------------------------------------------------
// the objective command (src/cli.js printObjective, sampledOptions)
// ---------------------------------------------------------------------------------------------------------------
const MAX_STOCHASTIC_TRIALS: f64 = 1_000_000.0;

fn safe_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x && x.abs() <= 9_007_199_254_740_991.0
}

/// `sampledOptions` (`src/cli.js:565-577`): always validated, even for a deterministic objective, because
/// `printObjective` reads the sampling defaults through it.
struct Sampling {
    trials: f64,
    seed: f64,
    max_seconds: f64,
    max_blows: f64,
}

fn sampled_options(values: &Values) -> Result<Sampling, CliError> {
    let trials = values.num("trials", MIN_STOCHASTIC_TRIALS as f64);
    if !safe_integer(trials) {
        return Err(usage("--trials must be an integer"));
    }
    if trials < MIN_STOCHASTIC_TRIALS as f64 {
        return Err(usage(format!(
            "--trials: at least {MIN_STOCHASTIC_TRIALS} trials are required"
        )));
    }
    if trials > MAX_STOCHASTIC_TRIALS {
        return Err(usage(format!(
            "--trials: at most {} trials are allowed",
            dfo_core::enchant_plan::grouped_number_of(MAX_STOCHASTIC_TRIALS)
        )));
    }
    let seed = match &values.seed {
        Some(raw) if raw.trim().is_empty() => {
            return Err(usage("--seed must be a safe integer"));
        }
        Some(raw) => string_to_number(raw.trim()),
        None => 0.0,
    };
    if !safe_integer(seed) {
        return Err(usage("--seed must be a safe integer"));
    }
    let max_seconds = match &values.max_seconds {
        Some(raw) => string_to_number(raw.trim()),
        None => 900.0,
    };
    if !max_seconds.is_finite() || max_seconds <= 0.0 {
        return Err(usage("--max-seconds must be positive"));
    }
    let max_blows = match &values.max_blows {
        Some(raw) => string_to_number(raw.trim()),
        None => 6000.0,
    };
    if !safe_integer(max_blows) || max_blows <= 0.0 {
        return Err(usage("--max-blows must be a positive integer"));
    }
    Ok(Sampling {
        trials,
        seed,
        max_seconds,
        max_blows,
    })
}

/// JS destructuring defaults (`= null`): an absent key prints `null`, not omitted as `undefined` would be.
fn nullish_to_null(v: &Value) -> Value {
    if v.is_nullish() {
        Null
    } else {
        v.clone()
    }
}

/// `isUsageFailure` (`src/usageError.js`): only the library guards it names are bad input (exit 2). Anything else - a
/// ranged build, a Pistolet pair, a fist schedule the sampler refuses - keeps its crash (exit 1 in `bin/dfo-dps.js`; the
/// Rust front end prints the message without V8's stack).
fn objective_error(message: String) -> CliError {
    const USAGE: [&str; 5] = [
        "the target is a relay body",
        "the target is not a relay body",
        "a positive target health is required",
        "the build cannot empty the pool",
        "the relay fight does not terminate",
    ];
    let usage_failure = message.starts_with("evaluateObjective(\"")
        && USAGE.iter().any(|tail| {
            message
                .split_once("\"): ")
                .is_some_and(|(_, rest)| rest.starts_with(tail))
        });
    CliError {
        message,
        code: if usage_failure { 2 } else { 1 },
    }
}

/// `dfo-dps objective` (`src/cli.js:579-634`): one build on one named objective, text or `--json`.
fn objective(values: &Values) -> Result<String, CliError> {
    let name = values.objective.as_deref().unwrap_or("snapshot");
    let known: Vec<&str> = OBJECTIVE_IDS
        .iter()
        .chain(STOCHASTIC_OBJECTIVE_IDS.iter())
        .copied()
        .collect();
    if !known.contains(&name) {
        return Err(usage(format!(
            "unknown objective: {name} (choose {})",
            known.join(", ")
        )));
    }
    let sampling = sampled_options(values)?;
    let seed = sampling.seed;
    let pool = values.nums.get("health").copied();
    if let Some(pool) = pool {
        if !pool.is_finite() || pool <= 0.0 {
            return Err(usage("a positive target pool is required (set --health)"));
        }
    }
    let book = saves::load_spellbook();
    let ch = character(values, &book)?;
    let traits = values.traits.clone();
    // `targetOf(ch, { ...values, health: undefined }, traits)`: the pool is applied after the body exists.
    let mut target = target_of(&ch, values, &traits, None)?;
    if let Some(pool) = pool {
        if target.get("isBoss").truthy() {
            target.set("health", Num(pool));
            target.set("maxHealth", Num(pool));
        }
    }
    if !traits.is_empty() {
        target.set(
            "bossTraits",
            Arr(traits.iter().map(|t| Str(t.clone())).collect()),
        );
    }
    let stochastic = STOCHASTIC_OBJECTIVE_IDS.contains(&name);
    // `simulateFight` supports a plain ordinary foe only: a boss/gate body or boss traits are refused up front.
    if stochastic
        && name != "stochastic-relay"
        && (target.get("isBoss").truthy()
            || !target.get("bossTraits").items().is_empty()
            || target.get("phaseShields").truthy())
    {
        return Err(usage(format!(
            "{name} needs a plain ordinary foe; supported targets: soft, tough, armoured, human (use stochastic-relay for gate or breach)"
        )));
    }
    let health = pool.unwrap_or_else(|| target.get("maxHealth").to_number());
    // JS `!(health > 0)`: NaN and both zeros refuse; an infinity is a positive pool.
    if health.is_nan() || health <= 0.0 {
        return Err(usage("a positive target pool is required (set --health)"));
    }
    let carry = !values.no_carry;
    // `objective === 'stochastic-relay' ? Math.max(1, Number(target.allowance?.players) || 1) : null`
    let relay_players = if name == "stochastic-relay" {
        let players = target.get("allowance").get("players").to_number();
        let players = if players.is_nan() || players == 0.0 {
            1.0
        } else {
            players
        };
        Some(js_max(1.0, players))
    } else {
        None
    };
    let mut scenario = scenario_of(&ch, values, &traits, &target);
    if !values.theory {
        if let Some((tpl, mat)) = values.weapon {
            scenario.set("weapon", synthetic_weapon(&Num(tpl), &Num(mat), values.rri));
        }
    }
    scenario.set("objective", Str(name.to_owned()));
    scenario.set("health", Num(health));
    scenario.set("trials", Num(sampling.trials));
    scenario.set("seed", Num(sampling.seed));
    scenario.set("maxSeconds", Num(sampling.max_seconds));
    scenario.set("maxBlows", Num(sampling.max_blows));
    scenario.set("carry", Bool(carry));
    let row = evaluate_objective(&ch, &scenario, &book).map_err(objective_error)?;

    let metric = match row.get("metric").as_str() {
        Some(metric) => metric.to_owned(),
        None if name == "snapshot" => "snapshot-dps".to_owned(),
        None if name == "relay-ceiling" => "ceiling-dps".to_owned(),
        None => "kill-rate".to_owned(),
    };
    let damage_mode = match row.get("damageMode").as_str() {
        Some(mode) => mode.to_owned(),
        None => {
            if target.get("allowance").truthy() && name != "snapshot" && name != "fight" {
                "relay".to_owned()
            } else {
                "uncapped".to_owned()
            }
        }
    };
    let trial_count = nullish_to_null(row.get("n"));
    let horizon = nullish_to_null(row.get("horizonSeconds"));
    let kill_probability = nullish_to_null(row.get("killProbability"));
    let ci = nullish_to_null(row.get("ci"));
    let assumptions = row.get("assumptions").clone();
    let detail = row.get("detail").clone();
    let value = row.get("value").clone();

    if values.json {
        let detail = if values.samples {
            detail
        } else {
            match &detail {
                Obj(entries) => Obj(entries
                    .iter()
                    .filter(|(k, _)| k.as_str() != "samples" && k.as_str() != "seeds")
                    .cloned()
                    .collect()),
                other => other.clone(),
            }
        };
        let out = obj([
            ("objective", Str(name.to_owned())),
            ("metric", Str(metric)),
            ("unit", row.get("unit").clone()),
            ("value", value),
            ("n", trial_count),
            ("horizonSeconds", horizon),
            ("damageMode", Str(damage_mode)),
            ("carry", Bool(carry)),
            ("seed", Num(seed)),
            ("killProbability", kill_probability),
            ("ci", ci),
            ("assumptions", assumptions),
            ("detail", detail),
        ]);
        return Ok(format!("{}\n", json(&out)));
    }

    let pct = |v: &Value| format!("{}%", fmt2(&Num(v.to_number() * 100.0)));
    let kill_line = if kill_probability.truthy() {
        format!(
            "{} [{}, {}]",
            pct(kill_probability.get("p")),
            pct(kill_probability.get("lo")),
            pct(kill_probability.get("hi"))
        )
    } else {
        "n/a".to_owned()
    };
    let ttk = detail.get("ttk");
    let kills = if detail.get("kills").is_nullish() {
        "n/a".to_owned()
    } else {
        detail.get("kills").to_js_string()
    };
    let ttk_line = if ttk.get("mean").is_nullish() {
        "n/a".to_owned()
    } else {
        let mean = ttk.get("mean").to_number();
        let ci95 = ttk.get("ci95").to_number();
        format!(
            "{} s [{}, {}] from {kills} kills",
            fmt2(&Num(mean)),
            fmt2(&Num(mean - ci95)),
            fmt2(&Num(mean + ci95))
        )
    };
    let censored = if detail.get("censored").is_nullish() {
        "n/a".to_owned()
    } else {
        detail.get("censored").to_js_string()
    };
    let n_line = if trial_count.is_nullish() {
        "n/a".to_owned()
    } else {
        trial_count.to_js_string()
    };
    let horizon_line = if horizon.is_nullish() {
        "n/a".to_owned()
    } else {
        format!("{} s", horizon.to_js_string())
    };
    let pool_label = match relay_players {
        None => format!("Total pool: {}", Num(health).to_js_string()),
        Some(players) => format!(
            "Pool per player (simulated share): {} (total {} / {} players)",
            fmt2(&Num(health / players)),
            Num(health).to_js_string(),
            Num(players).to_js_string()
        ),
    };
    let mut out = String::new();
    out.push_str(&format!(
        "Objective: {name} | Metric: {metric} | Value: {} {}\n",
        fmt2(&value),
        row.get("unit").to_js_string()
    ));
    out.push_str(&format!(
        "n: {n_line} | Kills: {kills} | Censored: {censored}\n"
    ));
    out.push_str(&format!("Kill probability (Wilson 95%): {kill_line}\n"));
    out.push_str(&format!("Mean TTK (95% CI, kills only): {ttk_line}\n"));
    out.push_str(&format!(
        "Horizon: {horizon_line} | Damage mode: {damage_mode} | Carry: {} | Seed: {}\n",
        if stochastic {
            if carry {
                "on"
            } else {
                "off"
            }
        } else {
            "n/a"
        },
        Num(seed).to_js_string()
    ));
    out.push_str(&format!(
        "Target assumptions: {} | {pool_label}\n",
        json_compact(assumptions.get("target"))
    ));
    out.push_str(&format!(
        "Basis: {}\n",
        assumptions.get("basis").to_js_string()
    ));
    Ok(out)
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

fn target_of(
    ch: &Value,
    values: &Values,
    traits: &[String],
    health: Option<f64>,
) -> Result<Value, CliError> {
    let requested = values.target.to_lowercase();
    let level = values.num("level", ch.get("level").to_number());
    let trait_list = || Arr(traits.iter().map(|t| Str(t.clone())).collect());
    Ok(match requested.as_str() {
        // The JS remap: for the theory character `armoured` is a reference preset that prices the gate; a save keeps it
        // as the reference foe it names (`src/cli.js:505`).
        "armoured" if values.theory => gate_body(values, traits, level, health),
        "gate" | "breach" | "ruhn" => gate_body(values, traits, level, health),
        "boss" => boss_target(&obj([
            ("level", Num(level)),
            ("armorValue", Num(values.num("armor", 0.0))),
            ("health", Num(health.unwrap_or(5000.0))),
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
fn gate_body(values: &Values, traits: &[String], level: f64, health: Option<f64>) -> Value {
    let mut opts = obj([
        ("players", Num(values.num("players", 1.0))),
        ("blowX", Num(values.num("blow-x", 1.0))),
    ]);
    if let Some(health) = health {
        opts.set("health", Num(health));
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

/// `r.ttk ? `${fmt(r.ttk)} s` : '-'` (`src/cli.js:726,2166`): a null/undefined/zero/NaN ttk prints `-`.
fn ttk_cell(ttk: Option<f64>) -> String {
    match ttk {
        Some(t) if Num(t).truthy() => format!("{} s", fmt(&Num(t))),
        _ => "-".to_owned(),
    }
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

/// `JSON.stringify(v)`: the compact form the text card embeds with a template literal (`${JSON.stringify(...)}`).
fn json_compact(v: &Value) -> String {
    let mut out = String::new();
    write_json_compact(v, &mut out);
    out
}

fn write_json_compact(v: &Value, out: &mut String) {
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
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_compact(item, out);
            }
            out.push(']');
        }
        Obj(entries) => {
            out.push('{');
            let mut first = true;
            for (k, val) in entries.iter().filter(|(_, v)| !matches!(v, Undefined)) {
                if !first {
                    out.push(',');
                }
                first = false;
                write_json_string(k, out);
                out.push(':');
                write_json_compact(val, out);
            }
            out.push('}');
        }
    }
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
