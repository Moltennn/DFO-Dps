//! The sampled shortlist over the real loadout universe (`src/loadoutShortlist.js`).
//!
//! The JS keeps a module-level `universeCache`; a universe is a pure function of its key, so the cache is not ported:
//! the caller owns one (the CLI keeps it), which is what makes the JS's cache-hit and cache-miss paths the same code
//! here.
//!
//! `MAX_RUN_SCENARIO` is the scenario `maxRun` prices the deterministic row under; the sampled fight must use the same
//! swing law, so the ranking's scenario is this constant, not a caller default.

use crate::generated::firmament::MAX_RUN_SCENARIO;
use crate::imprints::imprint_families;
use crate::maxprofile::Profiles;
use crate::objectives::{rank_builds, MIN_STOCHASTIC_TRIALS};
use crate::real_build::{
    is_sampled_loadout, real_build_stages_with, real_weapon_loadouts_with, StageOpts,
};
use crate::simulate_fight::paired_fight_seeds;
use crate::spells::Spellbook;
use crate::theory::obj;
use crate::value::Value::{self, Arr, Bool, Null, Num, Obj, Str};

/// The errors `shortlistLoadouts` raises, as the JS messages.
fn err(message: impl Into<String>) -> String {
    message.into()
}

/// The options `shortlistLoadouts` reads. `objective` defaults from the mode, which is why it is optional.
pub struct ShortlistOpts {
    pub k: f64,
    pub mode: String,
    pub encounter: String,
    pub vampire: bool,
    pub objective: Option<String>,
    pub trials: f64,
    pub seed: f64,
    pub max_seconds: f64,
    pub max_blows: f64,
    pub health: Value,
    /// The shipped build (`--game-build`); additive, defaulting to the live build. The universe is priced per build,
    /// so a shortlist's cache key carries it (a 14631 shortlist cannot reuse a 14512 one).
    pub game_build: String,
}

impl ShortlistOpts {
    /// Read the options, applying the JS defaults (`objective` from the mode, `trials` from `MIN_STOCHASTIC_TRIALS`).
    ///
    /// A NUMERIC option keeps its number; a value that is not a number becomes NaN, never a coerced one. The JS guards
    /// are `Number.isSafeInteger(k)`/`Number.isSafeInteger(trials)`, which reject a STRING (`"3"`, `"1000"`) and every
    /// non-integer; `v ?? d` / `Number(v)` would have accepted `"1000"`, where the JS throws. Absent is the default.
    pub fn from_value(opts: &Value) -> Self {
        let mode = opts
            .get("mode")
            .as_str()
            .map_or_else(|| "uncapped".to_owned(), str::to_owned);
        let objective = opts
            .get("objective")
            .as_str()
            .map(str::to_owned)
            .or_else(|| {
                Some(match mode.as_str() {
                    "cap" => "stochastic-relay".to_owned(),
                    _ => "stochastic-ttk".to_owned(),
                })
            });
        // `Number.isSafeInteger`-faithful for `k` and `trials`, which the JS guards that way: a number is itself, a
        // missing key is the default, anything else is NaN (so the guard rejects it exactly where the JS does). `seed`,
        // `maxSeconds` and `maxBlows` are JS `num(v, d)` (`Number.isFinite(Number(v)) ? Number(v) : d`), so a numeric
        // string IS coerced there - keep the `num_or_default` coercion.
        let strict_integer = |key: &str, fallback: f64| match opts.get(key) {
            Value::Undefined => fallback,
            Value::Num(n) => *n,
            _ => f64::NAN,
        };
        let coerced = |key: &str, fallback: f64| match opts.get(key) {
            Value::Undefined => fallback,
            v => v.num_or_default(fallback),
        };
        Self {
            k: strict_integer("k", 0.0),
            encounter: opts
                .get("encounter")
                .as_str()
                .map_or_else(|| "breach".to_owned(), str::to_owned),
            vampire: opts.get("vampire").truthy(),
            mode,
            objective,
            trials: strict_integer("trials", MIN_STOCHASTIC_TRIALS as f64),
            seed: coerced("seed", 0.0),
            max_seconds: coerced("maxSeconds", 900.0),
            max_blows: coerced("maxBlows", 6000.0),
            health: match opts.get("health") {
                Value::Undefined => Null,
                v => v.clone(),
            },
            game_build: crate::model_blow::game_build(opts).to_owned(),
        }
    }
}

/// `MAX_RUN_SCENARIO` as the object `rankBuilds` takes.
pub fn max_run_scenario() -> Value {
    obj([
        ("core", Str(MAX_RUN_SCENARIO.core.into())),
        ("rri", Bool(MAX_RUN_SCENARIO.rri)),
        ("passiveOn", Bool(MAX_RUN_SCENARIO.passive_on)),
        ("stacks", Num(MAX_RUN_SCENARIO.stacks)),
    ])
}

/// The whole eligible universe for one key, sorted by deterministic total DPS (the JS `universeCache` value).
pub fn eligible_universe(opts: &ShortlistOpts, book: &Spellbook) -> Result<Vec<Value>, String> {
    let mut profiles = Profiles::new(book);
    eligible_universe_with(opts, &mut profiles)
}

/// [`eligible_universe`] on a caller-owned frontier cache, so a shortlist reuses the universe's evaluations.
pub fn eligible_universe_with(
    opts: &ShortlistOpts,
    profiles: &mut Profiles<'_>,
) -> Result<Vec<Value>, String> {
    let mut rows: Vec<Value> = real_weapon_loadouts_with(
        std::slice::from_ref(&opts.mode),
        opts.vampire,
        &opts.encounter,
        &opts.game_build,
        profiles,
    )?
    .into_iter()
    .filter(is_sampled_loadout)
    .collect();
    // `sort((a, b) => b.totalDps - a.totalDps)`: stable, first row wins a tie.
    rows.sort_by(|a, b| {
        let d = b.get("totalDps").to_number() - a.get("totalDps").to_number();
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Equal
        }
    });
    Ok(rows)
}

fn round_down(v: f64) -> f64 {
    v.floor()
}

fn is_safe_integer(v: f64) -> bool {
    v.is_finite() && v.fract() == 0.0 && v.abs() <= 9007199254740991.0
}

fn objective_allowed(mode: &str, objective: &str) -> bool {
    if mode == "cap" {
        objective == "stochastic-relay"
    } else {
        objective == "stochastic-ttk" || objective == "kill-probability"
    }
}

/// `shortlistLoadouts`: rerank the top k eligible deterministic loadouts on one target, keeping their imprints.
pub fn shortlist_loadouts(opts: &ShortlistOpts, book: &Spellbook) -> Result<Value, String> {
    let mut profiles = Profiles::new(book);
    shortlist_loadouts_with(opts, &mut profiles)
}

/// [`shortlist_loadouts`] on a caller-owned frontier cache: the universe and the staged candidates share one
/// evaluation per weapon template.
pub fn shortlist_loadouts_with(
    opts: &ShortlistOpts,
    profiles: &mut Profiles<'_>,
) -> Result<Value, String> {
    let book = profiles.book;
    if opts.mode != "uncapped" && opts.mode != "cap" {
        return Err(err(format!("unknown shortlist mode: {}", opts.mode)));
    }
    if opts.mode == "cap" && !opts.health.is_nullish() {
        return Err(err(
            "--health does not apply to --cap-aware shortlists: the relay encounter sets the pool",
        ));
    }
    let objective = opts.objective.clone().unwrap_or_default();
    if !objective_allowed(&opts.mode, &objective) {
        let allowed = if opts.mode == "cap" {
            vec!["stochastic-relay"]
        } else {
            vec!["stochastic-ttk", "kill-probability"]
        };
        return Err(err(format!(
            "{} shortlist: choose {}, not {objective}",
            opts.mode,
            allowed.join(" or ")
        )));
    }
    if !is_safe_integer(opts.k) || opts.k < 1.0 {
        return Err(err(
            "--shortlist must be a positive integer (0 disables it in the CLI)",
        ));
    }
    if !is_safe_integer(opts.trials) || opts.trials < MIN_STOCHASTIC_TRIALS as f64 {
        return Err(err(format!(
            "--trials: at least {MIN_STOCHASTIC_TRIALS} trials are required"
        )));
    }
    // A sampled shortlist prices every candidate on this many fights; the JS `Array.from` would allocate until V8 throws.
    // The cap is the CLI's own `--trials` ceiling (`simulate_fight::MAX_FIGHT_SEEDS`), so the core never refuses a count
    // the CLI accepts, and it sits far below an allocation that hurts.
    if opts.trials > crate::simulate_fight::MAX_FIGHT_SEEDS {
        return Err(err(format!(
            "--trials: at most {} trials are priced",
            crate::simulate_fight::MAX_FIGHT_SEEDS
        )));
    }

    let universe = eligible_universe_with(opts, profiles)?;
    let k = round_down(opts.k) as usize;
    if k > universe.len() {
        return Err(err(format!(
            "--shortlist: {k} exceeds the {} eligible loadouts",
            universe.len()
        )));
    }
    let candidates: Vec<Value> = universe.into_iter().take(k).collect();
    let stages: Vec<_> = candidates
        .iter()
        .map(|row| {
            let family = imprint_families()
                .iter()
                .find(|f| f.get("key").strict_eq(row.get("key")))
                .cloned()
                .unwrap_or_else(|| Obj(vec![]));
            let stage_opts = StageOpts {
                mode: opts.mode.clone(),
                vampire: opts.vampire,
                dual: row.get("dual").truthy(),
                encounter: opts.encounter.clone(),
                game_build: opts.game_build.clone(),
            };
            real_build_stages_with(row.get("template"), &family, &stage_opts, profiles)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let seeds = paired_fight_seeds(&Num(opts.trials), &Num(opts.seed));
    let entries: Vec<Value> = stages
        .iter()
        .enumerate()
        .map(|(id, st)| {
            let imprint = st.imprint.get("power");
            obj([
                ("id", Num(id as f64)),
                ("ch", st.ench_ch.clone()),
                (
                    "scenario",
                    obj([(
                        "imprint",
                        if imprint.is_nullish() {
                            crate::value::UNDEFINED.clone()
                        } else {
                            imprint.clone()
                        },
                    )]),
                ),
            ])
        })
        .collect();
    let mut scenario = max_run_scenario();
    scenario.set("gameBuild", Str(opts.game_build.clone()));
    scenario.set("objective", Str(objective.clone()));
    scenario.set("target", stages[0].target.clone());
    scenario.set("health", opts.health.clone());
    scenario.set("seeds", Arr(seeds));
    scenario.set("maxSeconds", Num(opts.max_seconds));
    scenario.set("maxBlows", Num(opts.max_blows));
    let ranking = rank_builds(&entries, &scenario, book)?;

    let damage_note = if opts.mode == "cap" {
        "Sampled melee and Cast When Strikes (direct and supported Continuous Damage) go through the relay allowance; live Flow, no wear; phase-ward timing is not modelled. Deterministic DPS is a ceiling plus modeled proc DPS, before the allowance."
    } else {
        "Sampled melee and Cast When Strikes (direct and supported Continuous Damage) damage the ordinary foe; no wear, and Flow held at its steady-state maximum stacks. Deterministic DPS includes modeled proc DPS."
    };
    let rows: Vec<Value> = ranking
        .get("rows")
        .items()
        .iter()
        .map(|row| {
            let id = row.get("id").to_number() as usize;
            let cand = &candidates[id];
            let mut out = row.clone();
            out.set("key", cand.get("key").clone());
            out.set("family", cand.get("family").clone());
            out.set("weapon", cand.get("weapon").clone());
            out.set("template", cand.get("template").clone());
            out.set("category", cand.get("category").clone());
            out.set("dual", cand.get("dual").clone());
            out.set("imprint", cand.get("imprint").clone());
            out.set("deterministicRank", Num(id as f64 + 1.0));
            out.set("deterministicTotalDps", cand.get("totalDps").clone());
            out.set(
                "deterministicProcDps",
                Num(stages[id].ench_run.card.fields.enchant_dps),
            );
            let damage_mode = match row.get("damageMode") {
                Value::Undefined | Value::Null => Str(if opts.mode == "cap" {
                    "relay"
                } else {
                    "uncapped"
                }
                .into()),
                v => v.clone(),
            };
            out.set("damageMode", damage_mode);
            out.set("damageNote", Str(damage_note.into()));
            match row.get("ttkSeparated") {
                Value::Undefined | Value::Null => out.set("ttkSeparated", Null),
                v => out.set("ttkSeparated", v.clone()),
            }
            match row.get("censoringDiffers") {
                Value::Undefined | Value::Null => out.set("censoringDiffers", Null),
                v => out.set("censoringDiffers", v.clone()),
            }
            out
        })
        .collect();
    let encounter = if opts.mode == "cap" {
        Str(opts.encounter.clone())
    } else {
        Null
    };
    let mut out = ranking;
    out.set("mode", Str(opts.mode.clone()));
    out.set("encounter", encounter);
    out.set("seed", Num(opts.seed));
    out.set("maxBlows", Num(opts.max_blows));
    out.set("rows", Arr(rows));
    Ok(out)
}
