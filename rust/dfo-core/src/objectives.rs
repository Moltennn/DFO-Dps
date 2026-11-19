//! Deterministic and sampled ranking objectives (`src/objectives.js`).
#![allow(clippy::neg_cmp_op_on_partial_ord)]
use crate::{
    analyze::analyze,
    fight::{edited, num, obj},
    relay_fight::simulate_relay_fights,
    simulate_fight::simulate_fights,
    spells::Spellbook,
    value::{
        self,
        Value::{self, Arr, Bool, Null, Num, Obj, Str, Undefined},
    },
};
use std::cmp::Ordering;

pub const MIN_STOCHASTIC_TRIALS: usize = 1000;
const MIN_PAIRED_PAIRS: usize = 8;
const T95: [f64; 30] = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160,
    2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056,
    2.052, 2.048, 2.045, 2.042,
];

pub fn student_t95(df: usize) -> f64 {
    df.checked_sub(1)
        .and_then(|i| T95.get(i).copied())
        .unwrap_or(1.96)
}

pub struct Objective {
    pub id: &'static str,
    pub label: &'static str,
    pub unit: &'static str,
    pub needs_health: bool,
    pub needs_relay: bool,
    pub metric: Option<&'static str>,
    pub basis: &'static str,
}

pub const OBJECTIVE_IDS: [&str; 4] = ["snapshot", "fight", "relay", "relay-ceiling"];
pub const STOCHASTIC_OBJECTIVE_IDS: [&str; 3] =
    ["stochastic-ttk", "kill-probability", "stochastic-relay"];
pub static OBJECTIVES: [Objective; 7] = [
    Objective { id: "snapshot", label: "full-health snapshot DPS (uncapped)", unit: "dps", needs_health: false, needs_relay: false, metric: None, basis: "the blow at full foe health, uncapped - the card, not a fight" },
    Objective { id: "fight", label: "whole-fight kill rate (health-dependent terms walked)", unit: "dps", needs_health: true, needs_relay: false, metric: None, basis: "pool / ttk of the walk over the foe's health (src/fight.js fight)" },
    Objective { id: "relay", label: "relay kill rate (the allowance applied to every claim)", unit: "dps", needs_health: true, needs_relay: true, metric: None, basis: "pool / allowance ttk (src/fight.js fightRelay) - saturates at the relay's refill" },
    Objective { id: "relay-ceiling", label: "per-hit-capped offered DPS before the relay", unit: "dps", needs_health: true, needs_relay: true, metric: None, basis: "capped claims / fight seconds - a ceiling, not an outcome; the discriminator when relay ties" },
    Objective { id: "stochastic-ttk", label: "sampled whole-fight kill rate (mean TTK of the trials that kill)", unit: "dps", needs_health: true, needs_relay: false, metric: Some("kill-rate"), basis: "pool / mean sampled TTK of the killing trials (simulateFights); a trial that does not kill inside the horizon is reported by killProbability, never folded into the mean" },
    Objective { id: "kill-probability", label: "sampled probability of killing inside the horizon", unit: "probability", needs_health: true, needs_relay: false, metric: Some("kill-probability"), basis: "share of sampled fights that kill inside maxSeconds, with a Wilson interval (simulateFights); the ordinary fight, not a relay body" },
    Objective { id: "stochastic-relay", label: "sampled relay kill rate (mean TTK of the trials that kill)", unit: "dps", needs_health: true, needs_relay: true, metric: Some("kill-rate"), basis: "relay pool / mean sampled TTK of the killing trials (simulateRelayFights); censored trials are reported by killProbability, not folded into the mean" },
];

fn s(text: &str) -> Value {
    Str(text.into())
}
fn n(x: usize) -> Value {
    Num(x as f64)
}
fn fallback<'a>(v: &'a Value, default: &'a Value) -> &'a Value {
    if v.is_nullish() {
        default
    } else {
        v
    }
}
fn field(v: &Value, key: &str) -> Value {
    fallback(v.get(key), &Null).clone()
}
fn copy(v: &Value, keys: &[&str]) -> Value {
    Obj(keys
        .iter()
        .map(|k| ((*k).into(), v.get(k).clone()))
        .collect())
}
fn definition(id: &Value) -> Option<&'static Objective> {
    let key = id.to_js_string();
    OBJECTIVES.iter().find(|d| d.id == key)
}
fn objective(opts: &Value) -> Value {
    match opts.get("objective") {
        Undefined => s("snapshot"),
        v => v.clone(),
    }
}
fn pool(opts: &Value) -> f64 {
    num(
        fallback(opts.get("health"), opts.get("target").get("maxHealth")),
        0.0,
    )
}

pub fn target_assumptions(target: &Value) -> Value {
    if !target.truthy() {
        return Null;
    }
    let allowance = target.get("allowance");
    obj([
        (
            "kind",
            s(if allowance.truthy() {
                "relay"
            } else if target.get("isBoss").truthy() {
                "boss"
            } else {
                "foe"
            }),
        ),
        ("mobileType", field(target, "mobileType")),
        ("careerIndex", field(target, "careerIndex")),
        ("group", field(target, "group")),
        ("level", field(target, "level")),
        ("combatLevel", field(target, "combatLevel")),
        ("maxHealth", field(target, "maxHealth")),
        ("hitCap", Num(num(target.get("hitCap"), 0.0))),
        ("traits", Arr(target.get("bossTraits").items().to_vec())),
        ("minMetalToHit", field(target, "minMetalToHit")),
        (
            "allowance",
            if allowance.truthy() {
                obj([
                    ("level", allowance.get("level").clone()),
                    ("players", allowance.get("players").clone()),
                    (
                        "phases",
                        fallback(
                            allowance.get("phases").get("length"),
                            &n(allowance.get("phases").items().len()),
                        )
                        .clone(),
                    ),
                ])
            } else {
                Null
            },
        ),
    ])
}

pub fn evaluate_objective(ch: &Value, opts: &Value, book: &Spellbook) -> Result<Value, String> {
    let objective = objective(opts);
    let name = objective.to_js_string();
    let error = |tail: &str| format!("evaluateObjective(\"{name}\"): {tail}");
    let def = definition(&objective).ok_or_else(|| {
        format!(
            "evaluateObjective: unknown objective \"{name}\" (one of {})",
            [
                OBJECTIVE_IDS.as_slice(),
                STOCHASTIC_OBJECTIVE_IDS.as_slice()
            ]
            .concat()
            .join(", ")
        )
    })?;
    let target = opts.get("target");
    if !target.truthy() {
        return Err(error("a declared target is required"));
    }
    if def.needs_relay && !target.get("allowance").truthy() {
        return Err(error("the target is not a relay body (no allowance)"));
    }
    let pool = pool(opts);
    if def.needs_health && !(pool > 0.0) {
        return Err(error("a positive target health is required"));
    }
    let mut args = opts.clone();
    args.set("health", Num(pool));
    let mut assumptions = obj([
        ("objective", objective.clone()),
        ("target", target_assumptions(target)),
        ("health", if def.needs_health { Num(pool) } else { Null }),
        ("basis", s(def.basis)),
    ]);
    if let Some(metric) = def.metric {
        let trials = match args.get("seeds") {
            Arr(xs) => xs.len() as f64,
            _ => num(args.get("trials"), MIN_STOCHASTIC_TRIALS as f64).floor(),
        };
        if trials < MIN_STOCHASTIC_TRIALS as f64 {
            return Err(error(&format!("at least {MIN_STOCHASTIC_TRIALS} trials are required (the audit's first-pass minimum; got {})", Num(trials).to_js_string())));
        }
        let relay = objective.is_str("stochastic-relay");
        if !relay && target.get("allowance").truthy() {
            return Err(error(
                "the target is a relay body; use \"stochastic-relay\"",
            ));
        }
        let sim = if relay {
            simulate_relay_fights(ch, &args, book)?
        } else {
            simulate_fights(ch, &args, book)?
        };
        if matches!(sim, Null) {
            return Err(error("the sampled fight did not run"));
        }
        let kp = sim.get("killProbability");
        let ttk = sim.get("ttk");
        let mean = field(ttk, "mean");
        let samples = sim
            .get("rows")
            .items()
            .iter()
            .map(|r| {
                let kill = r.get("kill").truthy();
                obj([
                    ("seed", r.get("seed").clone()),
                    ("kill", Bool(kill)),
                    ("ttk", if kill { r.get("ttk").clone() } else { Null }),
                ])
            })
            .collect();
        assumptions.set(
            "carry",
            Bool(matches!(
                fallback(args.get("carry"), &Bool(true)),
                Bool(true)
            )),
        );
        let mode = field(&sim, "damageMode");
        let mut detail = copy(&sim, &["trials", "kills", "censored", "killProbability"]);
        for (key, val) in [
            ("damageMode", mode.clone()),
            ("ttk", ttk.clone()),
            ("seeds", sim.get("seeds").clone()),
            ("samples", Arr(samples)),
        ] {
            detail.set(key, val);
        }
        let key = if relay { "terminations" } else { "outcomes" };
        detail.set(key, sim.get(key).clone());
        let (value, ci) = if objective.is_str("kill-probability") {
            (
                kp.get("p").clone(),
                obj([
                    ("metric", s("kill-probability")),
                    ("method", s("wilson")),
                    ("p", kp.get("p").clone()),
                    ("lo", kp.get("lo").clone()),
                    ("hi", kp.get("hi").clone()),
                    ("level", Num(0.95)),
                    ("n", kp.get("n").clone()),
                ]),
            )
        } else if matches!(mean, Null) {
            (Num(0.0), Null)
        } else {
            let m = mean.to_number();
            let ci = ttk.get("ci95").to_number();
            (
                Num(sim.get("health").to_number() / m),
                obj([
                    ("metric", s("mean-ttk")),
                    ("mean", mean),
                    ("se", ttk.get("se").clone()),
                    ("lo", Num(m - ci)),
                    ("hi", Num(m + ci)),
                    ("level", Num(0.95)),
                    ("n", ttk.get("n").clone()),
                ]),
            )
        };
        return Ok(obj([
            ("objective", objective),
            ("metric", s(metric)),
            ("unit", s(def.unit)),
            ("direction", s("max")),
            ("n", sim.get("trials").clone()),
            ("horizonSeconds", sim.get("horizonSeconds").clone()),
            ("damageMode", mode),
            ("killProbability", kp.clone()),
            ("assumptions", assumptions),
            ("detail", detail),
            ("value", value),
            ("ci", ci),
        ]));
    }
    let (value, detail) = match objective.as_str() {
        Some("snapshot") => {
            if pool == 0.0 {
                args.set("health", Undefined);
            }
            args.set(
                "healthShare",
                fallback(opts.get("healthShare"), &Num(1.0)).clone(),
            );
            let r = analyze(ch, &args, book);
            (
                Num(r.dps),
                obj([
                    ("dps", Num(r.dps)),
                    ("cappedDps", Num(r.capped_dps)),
                    ("perSwing", Num(r.per_swing)),
                    ("hit", r.hit.get("hit").clone()),
                    ("aps", r.cadence.get("aps").clone()),
                ]),
            )
        }
        Some("fight") => {
            let f = crate::fight::fight(ch, &args, book);
            if matches!(f, Null) {
                return Err(error("the build cannot empty the pool"));
            }
            let mut detail = copy(&f, &["killDps", "outputDps", "ttk", "blows", "overkill"]);
            detail.set("segments", n(f.get("segments").items().len()));
            (f.get("killDps").clone(), detail)
        }
        _ => {
            let f = crate::fight::fight_relay(ch, &args, book);
            if matches!(f, Null) {
                return Err(error("the relay fight does not terminate"));
            }
            if objective.is_str("relay") {
                (
                    f.get("killDps").clone(),
                    copy(
                        &f,
                        &[
                            "killDps",
                            "ttk",
                            "saturated",
                            "ceilingDps",
                            "acceptedDps",
                            "uncappedDps",
                            "marginDps",
                            "cap",
                            "refillDps",
                        ],
                    ),
                )
            } else {
                (
                    f.get("ceilingDps").clone(),
                    copy(
                        &f,
                        &[
                            "ceilingDps",
                            "saturated",
                            "marginDps",
                            "ttk",
                            "acceptedDps",
                            "uncappedDps",
                        ],
                    ),
                )
            }
        }
    };
    Ok(obj([
        ("objective", objective),
        ("unit", s(def.unit)),
        ("direction", s("max")),
        ("assumptions", assumptions),
        ("value", value),
        ("detail", detail),
    ]))
}

pub fn paired_difference(a: &Value, b: &Value, opts: &Value) -> Result<Value, String> {
    let (Arr(a_samples), Arr(b_samples)) = (
        a.get("detail").get("samples"),
        b.get("detail").get("samples"),
    ) else {
        return Err("pairedDifference: both rows must carry per-seed samples".into());
    };
    if a_samples.len() != b_samples.len() {
        return Err(format!(
            "pairedDifference: different trial counts ({} vs {})",
            a_samples.len(),
            b_samples.len()
        ));
    }
    let default = s(
        if a.get("metric").is_str("kill-probability") || b.get("metric").is_str("kill-probability")
        {
            "kill"
        } else {
            "ttk"
        },
    );
    let metric = fallback(opts.get("metric"), &default);
    let mut diffs = Vec::new();
    for (a, b) in a_samples.iter().zip(b_samples) {
        if !a.get("seed").strict_eq(b.get("seed")) {
            return Err("pairedDifference: the rows were not run on the same seeds".into());
        }
        let (ak, bk) = (a.get("kill").truthy(), b.get("kill").truthy());
        if metric.is_str("kill") {
            diffs.push(f64::from(u8::from(ak)) - f64::from(u8::from(bk)));
        } else if ak && bk {
            diffs.push(a.get("ttk").to_number() - b.get("ttk").to_number());
        }
    }
    let count = diffs.len();
    let mut out = obj([
        ("metric", metric.clone()),
        ("n", n(count)),
        ("dropped", n(a_samples.len() - count)),
    ]);
    let numbers = if count < 2 {
        [Null, Null, Null, Null, Null, Bool(true), Null]
    } else {
        let m = diffs.iter().fold(0.0, |a, d| a + d) / count as f64;
        let sd = (diffs.iter().fold(0.0, |a, d| {
            let x = d - m;
            a + x * x
        }) / (count - 1) as f64)
            .sqrt();
        let se = sd / (count as f64).sqrt();
        let ci = student_t95(count - 1) * se;
        let (lo, hi) = (m - ci, m + ci);
        let zero = lo <= 0.0 && hi >= 0.0;
        [
            Num(m),
            Num(se),
            Num(ci),
            Num(lo),
            Num(hi),
            Bool(zero),
            if count < MIN_PAIRED_PAIRS {
                Null
            } else {
                Bool(!zero)
            },
        ]
    };
    for (key, value) in [
        "mean",
        "se",
        "ci95",
        "lo",
        "hi",
        "containsZero",
        "separated",
    ]
    .into_iter()
    .zip(numbers)
    {
        out.set(key, value);
    }
    Ok(out)
}

fn json_key(v: &Value) -> Value {
    match v {
        Num(x) if !x.is_finite() => Null,
        Num(x) if *x == 0.0 => Num(0.0),
        Undefined => Null,
        Arr(xs) => Arr(xs.iter().map(json_key).collect()),
        Obj(xs) => Obj(xs
            .iter()
            .filter(|(_, v)| !matches!(v, Undefined))
            .map(|(k, v)| (k.clone(), json_key(v)))
            .collect()),
        _ => v.clone(),
    }
}

fn differs<T: PartialEq>(mut keys: impl Iterator<Item = T>) -> bool {
    keys.next()
        .is_some_and(|first| keys.any(|other| first != other))
}

fn disjoint(a: &Value, b: &Value) -> bool {
    a.get("hi").to_number() < b.get("lo").to_number()
        || b.get("hi").to_number() < a.get("lo").to_number()
}

fn compare_rows(a: &Value, b: &Value, by_probability: bool) -> Ordering {
    let cmp = |d: f64| d.partial_cmp(&0.0).unwrap_or(Ordering::Equal);
    if by_probability {
        // mutation: equivalent - a missing p sorts below every Wilson p in [0, 1], whether its sentinel is -1 or -2.
        let p = |r: &Value| fallback(r.get("killProbability").get("p"), &Num(-1.0)).to_number();
        let d = p(b) - p(a);
        if d != 0.0 {
            return cmp(d);
        }
    }
    cmp(b.get("value").to_number() - a.get("value").to_number())
}

fn sort_by_probability(stochastic: bool, objective: &Value, censoring_differs: bool) -> bool {
    stochastic && !objective.is_str("kill-probability") && censoring_differs
}

pub fn rank_builds(entries: &[Value], opts: &Value, book: &Spellbook) -> Result<Value, String> {
    const TRIAL_ERROR: &str =
        "rankBuilds: rows were evaluated with different trials, seeds or horizons";
    if entries.is_empty() {
        return Err("rankBuilds: at least one entry is required".into());
    }
    let objective = objective(opts);
    let stochastic = objective
        .as_str()
        .is_some_and(|id| STOCHASTIC_OBJECTIVE_IDS.contains(&id));
    if stochastic
        && differs(entries.iter().map(|e| {
            let scenario = e.get("scenario");
            value::write(&json_key(&Arr(["trials", "maxSeconds", "seed", "seeds"]
                .map(|key| fallback(scenario.get(key), opts.get(key)).clone())
                .to_vec())))
        }))
    {
        return Err(TRIAL_ERROR.into());
    }
    let rows: Vec<_> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let ch = fallback(e.get("ch"), fallback(e.get("build"), e));
            let id = fallback(e.get("id"), &n(i)).clone();
            match evaluate_objective(ch, &edited(opts, e.get("scenario")), book) {
                Ok(row) => edited(
                    &obj([("id", id), ("value", row.get("value").clone())]),
                    &row,
                ),
                Err(err) => obj([
                    ("id", id),
                    ("objective", objective.clone()),
                    ("value", Null),
                    ("error", Str(err)),
                ]),
            }
        })
        .collect();
    if differs(
        rows.iter()
            .filter(|r| r.get("assumptions").truthy())
            .map(|r| value::write(&json_key(r.get("assumptions")))),
    ) {
        return Err("rankBuilds: rows were evaluated against different target assumptions".into());
    }
    if stochastic
        && differs(
            rows.iter()
                .filter(|r| matches!(r.get("detail").get("samples"), Arr(_)))
                .map(|r| {
                    let seeds = r
                        .get("detail")
                        .get("seeds")
                        .items()
                        .iter()
                        .map(|x| {
                            if x.is_nullish() {
                                String::new()
                            } else {
                                x.to_js_string()
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    format!(
                        "{}|{}|{seeds}",
                        r.get("n").to_js_string(),
                        r.get("horizonSeconds").to_js_string()
                    )
                }),
        )
    {
        return Err(TRIAL_ERROR.into());
    }
    let (mut ok, mut failed): (Vec<_>, Vec<_>) = rows
        .into_iter()
        .partition(|r| matches!(r.get("value"), Num(x) if x.is_finite()));
    let mut censoring_differs = false;
    if stochastic {
        let kp_rows = ok
            .iter()
            .enumerate()
            .filter(|(_, r)| r.get("killProbability").truthy())
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        for &i in &kp_rows {
            ok[i].set("censoringDiffers", Bool(false));
        }
        for (pos, &i) in kp_rows.iter().enumerate() {
            for &j in &kp_rows[pos + 1..] {
                let (a, b) = (ok[i].get("killProbability"), ok[j].get("killProbability"));
                if disjoint(a, b) {
                    censoring_differs = true;
                    ok[i].set("censoringDiffers", Bool(true));
                    ok[j].set("censoringDiffers", Bool(true));
                }
            }
        }
    }
    let by_probability = sort_by_probability(stochastic, &objective, censoring_differs);
    ok.sort_by(|a, b| compare_rows(a, b, by_probability));
    for (i, row) in ok.iter_mut().enumerate() {
        row.set("rank", n(i + 1));
    }
    for row in &mut failed {
        row.set("rank", Null);
    }
    if stochastic {
        for i in 1..ok.len() {
            let (above, below) = ok.split_at_mut(i);
            let (a, b) = (&above[i - 1], &mut below[0]);
            let compare = (|| {
                let paired = paired_difference(a, b, &Undefined)?;
                b.set("ttkSeparated", paired.get("separated").clone());
                let is_ttk = paired.get("metric").is_str("ttk");
                b.set("paired", paired);
                if is_ttk {
                    b.set(
                        "pairedKill",
                        paired_difference(a, b, &obj([("metric", s("kill"))]))?,
                    );
                }
                Ok::<(), String>(())
            })();
            if let Err(e) = compare {
                b.set("ttkSeparated", Null);
                b.set("paired", obj([("error", Str(e))]));
            }
        }
    }
    ok.extend(failed);
    let label = definition(&objective).map_or_else(|| objective.clone(), |d| s(d.label));
    Ok(obj([
        ("objective", objective),
        ("label", label),
        ("target", target_assumptions(opts.get("target"))),
        ("health", Num(pool(opts))),
        ("rows", Arr(ok)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_by_probability_only_for_separated_conditional_scores() {
        assert!(sort_by_probability(true, &s("stochastic-relay"), true));
        assert!(!sort_by_probability(true, &s("stochastic-relay"), false));
        assert!(!sort_by_probability(true, &s("kill-probability"), true));
        assert!(!sort_by_probability(false, &s("snapshot"), true));
        let row = |value, p| {
            obj([
                ("value", Num(value)),
                ("killProbability", obj([("p", Num(p))])),
            ])
        };
        let a = row(20.0, 0.4);
        let b = row(10.0, 0.7);
        assert_eq!(compare_rows(&a, &b, true), Ordering::Greater);
        assert_eq!(compare_rows(&a, &b, false), Ordering::Less);
        assert_eq!(compare_rows(&a, &row(10.0, 0.4), true), Ordering::Less);
        assert_eq!(compare_rows(&row(5.0, f64::NAN), &b, true), Ordering::Equal);
    }

    #[test]
    fn touching_wilson_intervals_overlap() {
        let a = obj([("lo", Num(0.1)), ("hi", Num(0.4))]);
        let b = obj([("lo", Num(0.4)), ("hi", Num(0.8))]);
        assert!(!disjoint(&a, &b));
        assert!(!disjoint(&b, &a));
        let c = obj([("lo", Num(0.41)), ("hi", Num(0.8))]);
        assert!(disjoint(&a, &c));
        assert!(disjoint(&c, &a));
    }

    #[test]
    fn ranking_json_keys_normalize_negative_zero_not_its_value() {
        assert_eq!(value::write(&json_key(&Num(-0.0))), value::write(&Num(0.0)));
        assert_eq!(value::write(&json_key(&Num(1.0))), value::write(&Num(1.0)));
    }
}
