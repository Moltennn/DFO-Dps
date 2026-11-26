//! Combat Probe capture analysis (`src/probe.js`): split the 10 Hz boss-bar samples into fights, derive the landed DPS,
//! the opening burst, the no-damage gaps, the split halves and the fight-end damage chart.
//!
//! Pure rules only: plain [`Value`] data in, [`Value`] out, no file I/O, no clock, no randomness. The JS module is the
//! source of truth (`src/probe.js:17-274`); `tests/probe_oracle.mjs` drives the real module over synthetic captures and
//! `tests/probe.rs` replays every case here, field for field.
//!
//! A non-integer (or NaN) `players` makes the JS `fightSummary` throw a `RangeError` from `Array(count - known.length)`
//! (`src/probe.js:65`); this port truncates that count and answers instead. A capture carries a whole player count, so
//! the two agree on every real input; `tests/probe_oracle.mjs` pins that the JS throws for such a document, and
//! `tests/probe.rs` pins the port's truncation as a local invariant (not a differential).
#![allow(clippy::neg_cmp_op_on_partial_ord)] // `!(dt > 0)` is the JS guard, and it also rejects NaN.

use crate::encounters::{boss_ref, encounter_by_id, purse_of, Encounter};
use crate::round::{js_max, js_min, or_default};
use crate::value::string_to_number;
use crate::value::Value;
use crate::value::Value::{Arr, Bool, Null, Num, Obj, Str, Undefined};

fn obj<const N: usize>(rows: [(&str, Value); N]) -> Value {
    Obj(rows.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn s(text: &str) -> Value {
    Str(text.into())
}

/// `v ?? d` (`undefined` and `null` only).
fn nz(v: &Value, d: Value) -> Value {
    if v.is_nullish() {
        d
    } else {
        v.clone()
    }
}

fn opt_num(v: Option<f64>) -> Value {
    v.map_or(Null, Num)
}

/// `Number.isFinite(Number(v))` (`src/probe.js:14`).
fn is_num(v: &Value) -> bool {
    v.to_number().is_finite()
}

/// `hpOf(s)` (`:24`): the boss bar's health, or null.
fn hp_of(sample: &Value) -> Option<f64> {
    let boss = sample.get("boss");
    let hp = boss.get("hp");
    (boss.truthy() && is_num(hp)).then(|| hp.to_number())
}

/// A JS subtraction of a missing `hpOf` coerces its null to 0.
fn hp0(sample: &Value) -> f64 {
    hp_of(sample).unwrap_or(0.0)
}

/// `splitHp(s)` (`:25`): the gate's health when the gate has one, else the boss bar's.
fn split_hp(sample: &Value) -> Option<f64> {
    let gate = sample.get("gate");
    if gate.truthy() && is_num(gate.get("hp")) {
        Some(gate.get("hp").to_number())
    } else {
        hp_of(sample)
    }
}

/// The last element of `items.filter(truthy)`, as the JS `.at(-1) ?? null` reads it.
fn last_truthy(items: &[Value]) -> Value {
    items
        .iter()
        .rev()
        .find(|g| g.truthy())
        .cloned()
        .unwrap_or(Null)
}

/// `bossContent(name = '', sub = '')` (`:17-23`): the content from the boss itself, so a stale label reads right.
/// The JS defaults apply to `undefined` only; a null name stays `"null"`.
pub fn boss_content(name: &Value, sub: &Value) -> Option<&'static str> {
    let text = |v: &Value| match v {
        Undefined => String::new(),
        v => v.to_js_string(),
    };
    let text = format!("{} {}", text(name), text(sub)).to_lowercase();
    let checks: [(&[&str], &'static str); 3] = [
        (&["ketch", "tonal", "steersman"], "skyketch"),
        (&["abyss", "brass", "remnant", "clock"], "abyss"),
        (
            &[
                "valkynaz", "ruhn", "burning", "rime", "dagon", "breach", "court", "champion",
                "warden",
            ],
            "breach",
        ),
    ];
    for (needles, content) in checks {
        if needles.iter().any(|n| text.contains(n)) {
            return Some(content);
        }
    }
    None
}

/// `splitFights(samples, {gapMs = 5000, minSeconds = 1})` (`:28-49`): split at a gap, a name change, a restart, or a
/// health refill (more than 5% of the bar back) unless more fighters grew the shared gate; keep a fight only when it has
/// more than two samples and lasts `minSeconds`.
pub fn split_fights(samples: &[Value], gap_ms: f64, min_seconds: f64) -> Vec<Vec<Value>> {
    let mut fights: Vec<Vec<Value>> = Vec::new();
    let mut cur: Vec<Value> = Vec::new();
    for sample in samples.iter().filter(|s| hp_of(s).is_some()) {
        if let Some(prev) = cur.last() {
            let name_change = !nz(prev.get("boss").get("name"), s(""))
                .strict_eq(&nz(sample.get("boss").get("name"), s("")));
            let (sg, pg) = (sample.get("gate"), prev.get("gate"));
            let share_grow = sg.truthy()
                && pg.truthy()
                && sg.get("fighters").to_number() > pg.get("fighters").to_number()
                && sg.get("max").to_number() >= pg.get("max").to_number();
            let restart = split_hp(prev).is_some_and(|p| p <= 0.01)
                && split_hp(sample).is_some_and(|c| c > 95.0);
            let split_max = or_default(sg.get("max").to_number(), 100.0);
            let refill = match (split_hp(prev), split_hp(sample)) {
                (Some(p), Some(c)) => c > p + split_max * 0.05 && !share_grow,
                _ => false,
            };
            if sample.get("t").to_number() - prev.get("t").to_number() > gap_ms
                || name_change
                || restart
                || refill
            {
                fights.push(cur);
                cur = Vec::new();
            }
        }
        cur.push(sample.clone());
    }
    if !cur.is_empty() {
        fights.push(cur);
    }
    fights.retain(|f| {
        f.len() > 2
            && (f.last().unwrap().get("t").to_number() - f[0].get("t").to_number()) / 1000.0
                >= min_seconds
    });
    fights
}

/// `encounterById(content)` with its `String(id ?? '')` read (`src/encounters.js:95`).
fn encounter(content: &Value) -> Option<&'static Encounter> {
    encounter_by_id(&nz(content, s("")))
}

/// `gateOutcome(gate, samples)` (`:225-229`).
pub fn gate_outcome(gate: &Value, samples: &[Value]) -> &'static str {
    if gate.truthy() {
        return if gate.get("fell").truthy() || gate.get("hp").to_number() <= 0.0 {
            "kill"
        } else {
            "ended"
        };
    }
    match samples.iter().filter_map(hp_of).next_back() {
        Some(last) if last <= 0.01 => "kill",
        _ => "ended",
    }
}

/// The most filled players this prices (`Array(Math.max(0, count - known.length)).fill(fill)`). A port guard: the JS
/// allocates until V8 throws or the process dies, and a real capture lists a handful of players, so every card the JS
/// prices still prices. A count past it raises the JS `RangeError` (the CLI prints it as its crash line, exit 1).
const MAX_PROBE_PLAYERS: f64 = 1_000_000.0;

/// `fightSummary(samples, opts)` (`:52-191`): the capture's damage figures for one fight.
pub fn fight_summary(samples: &[Value], opts: &Value) -> Value {
    let first = samples.first().expect("a fight holds samples");
    let last = samples.last().expect("a fight holds samples");
    let seconds = js_max(
        1e-9,
        (last.get("t").to_number() - first.get("t").to_number()) / 1000.0,
    );
    // The destructured defaults apply to `undefined` only: a caller's explicit `null` stays `null`.
    let content = match opts.get("content") {
        Undefined => s("unknown"),
        v => v.clone(),
    };
    let level = match opts.get("level") {
        Undefined => Num(45.0),
        v => v.clone(),
    };
    let players = match opts.get("players") {
        Undefined => 1.0,
        v => v.to_number(),
    };
    let boss = encounter(&content);

    let gate = opts.get("gate");
    let g = if gate.is_nullish() {
        last_truthy(
            &samples
                .iter()
                .map(|s| s.get("gate"))
                .cloned()
                .collect::<Vec<_>>(),
        )
    } else {
        gate.clone()
    };
    let gate_max = (g.get("max").to_number() > 0.0).then(|| g.get("max").to_number());
    let gate_players = (g.get("fighters").to_number() > 0.0).then(|| g.get("fighters").to_number());
    let gate_hp = is_num(g.get("hp")).then(|| g.get("hp").to_number());

    let known: Vec<f64> = opts
        .get("levels")
        .items()
        .iter()
        // `Number.isFinite(v)`: a string level is rejected here, not coerced (unlike `summarizeProbe`).
        .filter_map(|v| match v {
            Num(n) if n.is_finite() && (1.0..=60.0).contains(n) => Some(*n),
            _ => None,
        })
        .collect();
    let count = js_max(
        1.0,
        js_max(gate_players.unwrap_or(players), known.len() as f64),
    );
    let mut sorted = known.clone();
    sorted.sort_by(f64::total_cmp);
    // `fill` is the median level, or the caller's `level` value as given (a string stays a string).
    let fill = if sorted.is_empty() {
        level.clone()
    } else {
        Num(sorted[sorted.len() / 2])
    };
    // ASSUMPTION: the JS `Array(count - known.length)` throws on a non-integer count; this port truncates it.
    let fill_count = (count - known.len() as f64).max(0.0).trunc();
    // `Array(...)` cannot hold this many players: the JS throws a `RangeError` (or dies of OOM), so a crafted capture
    // or `--players 1e15` is that same crash line and exit 1, not a multi-gigabyte fill. Every group the JS prices is
    // far below the guard, so no card moves.
    if fill_count > MAX_PROBE_PLAYERS {
        std::panic::panic_any(crate::model_blow::JsRangeError(
            "RangeError: Invalid array length".to_owned(),
        ));
    }
    let filled = fill_count as usize;
    let max_hp_estimated = gate_max.is_none() && count > 1.0 && count > known.len() as f64;
    let max_hp = match (gate_max, boss) {
        (Some(gm), _) => Some(gm),
        (None, Some(boss)) => Some(
            known
                .iter()
                .copied()
                .chain(std::iter::repeat_n(fill.to_number(), filled))
                .fold(0.0, |sum, l| sum + boss.share_x * boss_ref(l) * boss.hp_x),
        ),
        (None, None) => None,
    };
    let last_hp = samples.iter().filter_map(hp_of).next_back();
    let chart_kill = opts.get("chartKill").truthy();
    let outcome = opts.get("outcome");
    let kill = outcome.is_str("kill")
        || chart_kill
        || if g.truthy() {
            g.get("fell").truthy() || g.get("hp").to_number() <= 0.0
        } else {
            last_hp.is_some_and(|v| v <= 0.01)
        };

    let first_gate = samples
        .iter()
        .map(|s| s.get("gate"))
        .find(|g| g.truthy())
        .cloned()
        .unwrap_or(Null);
    let gate_m0 =
        (first_gate.get("max").to_number() > 0.0).then(|| first_gate.get("max").to_number());
    let gate_h0 = is_num(first_gate.get("hp")).then(|| first_gate.get("hp").to_number());
    let mid_fight =
        gate_m0.is_some() && gate_h0.is_some() && gate_h0.unwrap() < gate_m0.unwrap() * 0.95;
    let mut boss_heal = 0.0;
    for i in 1..samples.len() {
        let a = samples[i - 1].get("gate");
        let b = samples[i].get("gate");
        // mutation: equivalent - this arm's own guard is strict `>`, so a `>=` mutant adds only a zero term (or, on an
        // equal pair, `+0`), which no `bossHeal` sum can observe; a missing/NaN hp on either side makes the comparison
        // false and the subtraction NaN, and the `b.truthy()` guard keeps a half from being read at all.
        if a.truthy()
            && b.truthy()
            && a.get("max").to_number() == b.get("max").to_number()
            && b.get("hp").to_number() > a.get("hp").to_number()
        {
            boss_heal += b.get("hp").to_number() - a.get("hp").to_number();
        }
    }
    let bar_lost = (hp_of(first).is_some() && hp_of(last).is_some())
        .then(|| js_max(0.0, hp0(first) - hp0(last)));
    let base_damage = if kill && gate_max.is_some() {
        gate_max
    } else if gate_max.is_some() && gate_hp.is_some() {
        Some(js_max(0.0, gate_max.unwrap() - gate_hp.unwrap()))
    } else if let (Some(lost), Some(max)) = (bar_lost, max_hp) {
        Some((lost / 100.0) * max)
    } else {
        None
    };
    let damage = base_damage.map(|d| d + boss_heal);
    let hp_lost = if kill {
        Some(100.0)
    } else if gate_max.is_some() && damage.is_some() {
        Some((damage.unwrap() / gate_max.unwrap()) * 100.0)
    } else {
        bar_lost
    };
    let dps = damage.map(|d| d / seconds);
    let pre_join_damage = if mid_fight {
        js_max(0.0, gate_m0.unwrap() - gate_h0.unwrap())
    } else {
        0.0
    };
    let damage_since_join = damage.map(|d| js_max(0.0, d - pre_join_damage));
    let dps_since_join = damage_since_join.map(|d| d / seconds);
    let joined_at_pct = mid_fight.then(|| (gate_h0.unwrap() / gate_m0.unwrap()) * 100.0);

    let five = samples
        .iter()
        // shortcut: a string `t` stamp makes the JS `first.t + 5000` concatenate; a capture writes numeric stamps, so
        // this adds numerically. Upgrade if a capture format ever writes string stamps.
        .find(|s| s.get("t").to_number() >= first.get("t").to_number() + 5000.0)
        .unwrap_or(last);
    let first_hp = samples.iter().find(|s| hp_of(s).is_some());
    let burst5 = match (max_hp, first_hp, hp_of(five)) {
        (Some(max), Some(_), Some(_)) => {
            Some((js_max(0.0, hp0(first_hp.unwrap()) - hp0(five)) / 100.0) * max)
        }
        _ => None,
    };

    let mut steps = Vec::new();
    let mut since_hit = 0.0;
    for i in 1..samples.len() {
        let dt = (samples[i].get("t").to_number() - samples[i - 1].get("t").to_number()) / 1000.0;
        let dh = hp0(&samples[i - 1]) - hp0(&samples[i]);
        since_hit += dt;
        if dh > 0.05 {
            steps.push(since_hit);
            since_hit = 0.0;
        }
    }
    let mut sorted_steps = steps.clone();
    sorted_steps.sort_by(f64::total_cmp);
    let normal_gap = if sorted_steps.is_empty() {
        0.1
    } else {
        sorted_steps[sorted_steps.len() / 2]
    };
    let immunity_floor = js_max(0.5, normal_gap * 2.5);

    let mut gap_s = 0.0;
    let mut max_step_pct = 0.0;
    let mut quiet = 0.0;
    for i in 1..samples.len() {
        let dt = (samples[i].get("t").to_number() - samples[i - 1].get("t").to_number()) / 1000.0;
        let dh = hp0(&samples[i - 1]) - hp0(&samples[i]);
        max_step_pct = js_max(max_step_pct, dh);
        if dh <= 0.05 {
            quiet += dt;
        } else {
            if quiet > immunity_floor {
                gap_s += js_max(0.0, quiet - normal_gap);
            }
            quiet = 0.0;
        }
    }
    if quiet > immunity_floor {
        gap_s += js_max(0.0, quiet - normal_gap);
    }
    let max_step = max_hp.map(|m| (max_step_pct / 100.0) * m);
    let immunity_share = js_min(0.95, gap_s / seconds);

    let halves: Vec<Value> = samples
        .iter()
        .filter(|sample| {
            let hs = sample.get("boss").get("halves");
            !hs.items().is_empty()
                && (content.is_str("abyss")
                    || hs.items().iter().any(|h| {
                        let name = nz(h.get("name"), s("")).to_js_string().to_lowercase();
                        name.contains("gold") || name.contains("silver")
                    }))
        })
        .map(|sample| {
            obj([
                ("t", sample.get("t").clone()),
                ("halves", sample.get("boss").get("halves").clone()),
            ])
        })
        .collect();

    let mut warded_s = 0.0;
    let mut sub_map: Vec<(Value, f64)> = Vec::new();
    for i in 1..samples.len() {
        let dt = (samples[i].get("t").to_number() - samples[i - 1].get("t").to_number()) / 1000.0;
        let prev = samples[i - 1].get("boss");
        // `/warded/i.test(h.state ?? '') || /warded/.test(h.cls ?? '')`: only the state test is case-insensitive.
        let warded = prev.get("halves").items().iter().any(|h| {
            h.get("hp").to_number() > 0.0
                && (nz(h.get("state"), s(""))
                    .to_js_string()
                    .to_lowercase()
                    .contains("warded")
                    || nz(h.get("cls"), s("")).to_js_string().contains("warded"))
        });
        if warded {
            warded_s += dt;
        }
        let name = if prev.get("sub").truthy() {
            prev.get("sub").clone()
        } else {
            s("(no sub-phase)")
        };
        match sub_map.iter_mut().find(|(k, _)| k.same_value_zero(&name)) {
            Some((_, seconds)) => *seconds += dt,
            None => sub_map.push((name, dt)),
        }
    }
    sub_map.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let subs: Vec<Value> = sub_map
        .iter()
        .map(|(name, seconds)| obj([("name", name.clone()), ("seconds", Num(*seconds))]))
        .collect();

    let curve: Vec<Value> = samples
        .iter()
        .map(|sample| {
            obj([
                (
                    "t",
                    Num((sample.get("t").to_number() - first.get("t").to_number()) / 1000.0),
                ),
                ("hp", opt_num(hp_of(sample))),
            ])
        })
        .collect();
    let mut dps_curve = Vec::new();
    for i in 1..samples.len() {
        let dt = (samples[i].get("t").to_number() - samples[i - 1].get("t").to_number()) / 1000.0;
        if !(dt > 0.0) {
            continue;
        }
        let dh = js_max(0.0, hp0(&samples[i - 1]) - hp0(&samples[i]));
        let value = match max_hp {
            Some(m) => (dh / 100.0) * m / dt,
            None => (dh / dt) * 1000.0,
        };
        dps_curve.push(obj([
            (
                "x",
                Num((samples[i].get("t").to_number() - first.get("t").to_number()) / 1000.0),
            ),
            ("y", Num(value)),
        ]));
    }

    let first_boss = samples.iter().find(|sample| sample.get("boss").truthy());
    let player_end = opts.get("playerEnd");
    let weapon = player_end.get("weapon");
    let off_weapon = player_end.get("offWeapon");
    let imprint = if weapon.get("imprint").is_nullish() {
        off_weapon.get("imprint")
    } else {
        weapon.get("imprint")
    };

    obj([
        ("content", content),
        (
            "name",
            nz(
                first_boss.map_or(&Value::Undefined, |b| b.get("boss").get("name")),
                s(""),
            ),
        ),
        (
            "sub",
            nz(
                first_boss.map_or(&Value::Undefined, |b| b.get("boss").get("sub")),
                s(""),
            ),
        ),
        ("level", level),
        ("players", Num(known.len() as f64 + filled as f64)),
        ("levels", Arr(known.iter().map(|v| Num(*v)).collect())),
        ("levelFill", fill),
        ("maxHpEstimated", Bool(max_hp_estimated)),
        (
            "gate",
            if g.truthy() {
                obj([
                    ("max", opt_num(gate_max)),
                    ("hp", opt_num(gate_hp)),
                    ("fighters", opt_num(gate_players)),
                    ("phase", nz(g.get("phase"), Null)),
                ])
            } else {
                Null
            },
        ),
        (
            "outcome",
            s(if kill {
                "kill"
            } else {
                gate_outcome(&g, samples)
            }),
        ),
        ("weapon", nz(weapon.get("name"), Null)),
        ("offWeapon", nz(off_weapon.get("name"), Null)),
        ("imprint", nz(imprint, Null)),
        ("maxHp", opt_num(max_hp)),
        ("seconds", Num(seconds)),
        ("hpLost", opt_num(hp_lost)),
        ("damage", opt_num(damage)),
        ("dps", opt_num(dps)),
        ("dpsSinceJoin", opt_num(dps_since_join)),
        ("damageSinceJoin", opt_num(damage_since_join)),
        ("bossHeal", Num(boss_heal)),
        ("midFight", Bool(mid_fight)),
        ("preJoinDamage", Num(pre_join_damage)),
        ("joinedAtPct", opt_num(joined_at_pct)),
        ("burst5", opt_num(burst5)),
        ("maxStep", opt_num(max_step)),
        ("maxStepPct", Num(max_step_pct)),
        ("immunityS", Num(gap_s)),
        ("immunityShare", Num(immunity_share)),
        ("wardedS", Num(warded_s)),
        ("subs", Arr(subs)),
        ("halves", Arr(halves)),
        ("curve", Arr(curve)),
        ("dpsCurve", Arr(dps_curve)),
        ("chart", Null),
        ("chartTop", Null),
    ])
}

/// `chartTotals(chart)` (`:215-222`).
pub fn chart_totals(chart: &Value) -> Value {
    if !chart.get("rows").truthy() {
        return Null;
    }
    let mut names = Vec::new();
    for row in chart.get("rows").items() {
        if row.get("cls").to_js_string().contains("wb-dmg-name") {
            names.push(row.get("text").clone());
        }
    }
    obj([
        ("names", Arr(names)),
        ("text", nz(chart.get("text"), s(""))),
    ])
}

/// `summarizeProbe(data, {level, players})` (`:194-212`): every fight the capture holds.
pub fn summarize_probe(data: &Value, opts: &Value) -> Result<Value, String> {
    if !data.truthy() || !matches!(data.get("version"), Num(n) if *n == 1.0) {
        return Err("not a Combat Probe capture (version 1)".into());
    }
    let lv = if is_num(opts.get("level")) {
        opts.get("level").to_number()
    } else {
        or_default(data.get("level").to_number(), 45.0)
    };
    let levels: Vec<f64> = data
        .get("levels")
        .items()
        .iter()
        .map(Value::to_number)
        .filter(|n| n.is_finite() && (1.0..=60.0).contains(n))
        .collect();
    let pl = if is_num(opts.get("players")) {
        opts.get("players").to_number()
    } else {
        or_default(
            data.get("players").to_number(),
            if levels.is_empty() {
                1.0
            } else {
                levels.len() as f64
            },
        )
    };
    let samples: Vec<Value> = data.get("samples").items().to_vec();
    let chart = data.get("chart");
    let part = |key: &str| nz(chart.get(key), s("")).to_js_string();
    let chart_text = format!("{} {} {}", part("sub"), part("title"), part("text")).to_lowercase();
    let chart_kill = chart_text.contains("has fallen") || chart_text.contains("fallen -");

    let battles: Vec<Value> = split_fights(&samples, 5000.0, 1.0)
        .into_iter()
        .map(|fight| {
            let first = &fight[0];
            let boss = first.get("boss");
            let content = match boss_content(boss.get("name"), boss.get("sub")) {
                Some(content) => s(content),
                None => {
                    let content = data.get("content");
                    if content.truthy() && !content.is_str("auto") {
                        content.clone()
                    } else {
                        nz(boss.get("content"), s("unknown"))
                    }
                }
            };
            let fg = if data.get("gate").is_nullish() {
                last_truthy(
                    &fight
                        .iter()
                        .map(|s| s.get("gate"))
                        .cloned()
                        .collect::<Vec<_>>(),
                )
            } else {
                data.get("gate").clone()
            };
            let mut out = fight_summary(
                &fight,
                &obj([
                    ("content", content),
                    ("level", Num(lv)),
                    ("players", Num(pl)),
                    ("levels", Arr(levels.iter().map(|v| Num(*v)).collect())),
                    ("gate", fg),
                    ("chartKill", Bool(chart_kill)),
                    ("outcome", nz(data.get("outcome"), Null)),
                    (
                        "playerEnd",
                        nz(data.get("playerEnd"), nz(data.get("playerStart"), Null)),
                    ),
                ]),
            );
            out.set("chart", nz(chart, Null));
            out.set("chartTop", chart_top(chart));
            out
        })
        .collect();

    let players = if pl == 0.0 || pl.is_nan() {
        if levels.is_empty() {
            1.0
        } else {
            levels.len() as f64
        }
    } else {
        pl
    };
    Ok(obj([
        ("build", nz(data.get("build"), s(""))),
        ("startedAt", nz(data.get("startedAt"), Num(0.0))),
        ("endedAt", nz(data.get("endedAt"), Num(0.0))),
        ("level", Num(lv)),
        ("players", Num(players)),
        ("fights", Arr(battles)),
    ]))
}

/// `num(v)` in `chartTop` (`:232`): keep `[0-9.-]`, then `Number(...)`.
fn chart_num(v: &Value) -> f64 {
    let text = nz(v, s("")).to_js_string();
    let cleaned: String = text
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    string_to_number(&cleaned)
}

/// `Number((String(r.level ?? '').match(/\d+/) ?? [])[0]) || null` (`:263`).
fn chart_level(v: &Value) -> Option<f64> {
    let text = nz(v, s("")).to_js_string();
    let digits: String = text
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    if digits.is_empty() {
        return None;
    }
    let n = string_to_number(&digits);
    // `Number(...) || null`: a zero becomes null (the digits are always finite).
    (n != 0.0).then_some(n)
}

/// The first whitespace-separated word, as `String(v).split(/\s+/)[0]` (`:245`).
fn first_word(text: &str) -> String {
    text.split(char::is_whitespace)
        .next()
        .unwrap_or("")
        .to_owned()
}

/// The flat `wb-dmg-*` rows rebuilt into the named record (`:236-258`).
fn flat_rows(chart: &Value) -> Vec<Value> {
    let mut flat: Vec<Value> = Vec::new();
    let mut cur: Option<usize> = None;
    for row in chart.get("rows").items() {
        let cls = row.get("cls").to_js_string();
        if cls.contains("wb-dmg-row") {
            if cls.contains("wb-dmg-head") {
                cur = None;
                continue;
            }
            flat.push(Obj(Vec::new()));
            cur = Some(flat.len() - 1);
            continue;
        }
        let Some(i) = cur else {
            continue;
        };
        let key = first_word(&cls);
        if [
            "wb-dmg-rank",
            "wb-dmg-name",
            "wb-dmg-lv",
            "wb-dmg-damage",
            "wb-dmg-share",
            "wb-dmg-blows",
            "wb-dmg-best",
            "wb-dmg-cx",
            "wb-dmg-falls",
            "wb-dmg-heal",
        ]
        .contains(&key.as_str())
        {
            flat[i].set(&key, row.get("text").clone());
        }
    }
    flat.iter()
        .filter(|r| r.get("wb-dmg-name").truthy())
        .map(|r| {
            obj([
                ("name", r.get("wb-dmg-name").clone()),
                ("level", r.get("wb-dmg-lv").clone()),
                ("damage", r.get("wb-dmg-damage").clone()),
                ("share", r.get("wb-dmg-share").clone()),
                ("blows", r.get("wb-dmg-blows").clone()),
                ("best", r.get("wb-dmg-best").clone()),
                ("crystals", r.get("wb-dmg-cx").clone()),
                ("falls", r.get("wb-dmg-falls").clone()),
                ("healed", r.get("wb-dmg-heal").clone()),
            ])
        })
        .collect()
}

/// `chartTop(chart)` (`:231-272`): the top-10 chart rows: damage, share, blows, best, crystals, falls, healed.
pub fn chart_top(chart: &Value) -> Value {
    let table = chart.get("table");
    let table_ok = matches!(table, Arr(_))
        && table
            .items()
            .iter()
            .any(|r| !r.get("damage").is_nullish() || !r.get("best").is_nullish());
    let rows: Vec<Value> = if table_ok {
        table.items().to_vec()
    } else {
        flat_rows(chart)
    };
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            // `r.crystals ?? r.nums?.[4]`, and the same for falls/healed.
            let fallback = |k: &str, i: usize| nz(r.get(k), r.get("nums").at(i).clone());
            obj([
                ("name", r.get("name").clone()),
                ("level", opt_num(chart_level(r.get("level")))),
                ("damage", Num(chart_num(r.get("damage")))),
                ("share", nz(r.get("share"), s(""))),
                ("blows", Num(chart_num(r.get("blows")))),
                ("best", Num(chart_num(r.get("best")))),
                ("crystals", Num(chart_num(&fallback("crystals", 4)))),
                ("falls", Num(chart_num(&fallback("falls", 5)))),
                ("healed", Num(chart_num(&fallback("healed", 6)))),
            ])
        })
        .filter(|r| r.get("name").truthy())
        .collect();
    Arr(out)
}

/// `probeConstants(level)` (`:274`).
pub fn probe_constants(level: &Value) -> Value {
    purse_of(level)
}
