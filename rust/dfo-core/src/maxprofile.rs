//! Maximum profiles and the evaluated legal frontier (`src/maxprofile.js`).
use crate::analyze::{analyze, gate_target, reference_foe, Analysis};
use crate::gear_profile::{legal_totals, weapon_skill_of};
pub use crate::gear_profile::{slots_for, validate_plan};
use crate::generated::data::{SKILLS, WEAPONS};
use crate::round::js_max;
use crate::sockets::perfect_sockets;
use crate::spells::Spellbook;
use crate::theory::{add, default, obj, s, theory_character, theory_fists, THEORY_LEVEL};
use crate::value::{
    obj_table_get,
    Value::{self, Arr, Bool, Num, Undefined},
};
use std::collections::HashMap;

pub fn build_max(template: &Value, opts: &Value) -> Result<Value, String> {
    let t = Num(template.to_number());
    let w = obj_table_get(WEAPONS, &t)
        .ok_or_else(|| format!("unknown weapon template {}", template.to_js_string()))?;
    let skill = weapon_skill_of(&t);
    let h2h = w.skill == "HandToHand";
    let mastered = [skill, SKILLS.critical_strike, SKILLS.backstabbing];
    let firm = opts.get("firmament").truthy();
    let stars = Num(if firm { 15.0 } else { 0.0 });
    let mut star_stats = obj([]);
    let mut star_skills = obj([]);
    if firm {
        for key in ["strength", "agility", "speed", "luck"] {
            star_stats.set(key, stars.clone());
        }
        for id in mastered {
            star_skills.set(&Num(id).to_js_string(), stars.clone());
        }
    }
    let gs = default(opts.get("gearSkill"), Num(0.0));
    let gc = default(opts.get("gearCrit"), Num(0.0));
    let common = obj([
        ("starStats", star_stats),
        ("starSkills", star_skills),
        // mutation: equivalent - both theory builders clamp starDamage above 30 to 30, so 31 produces the same character.
        ("starDamage", Num(if firm { 30.0 } else { 0.0 })),
        ("race", opts.get("race").clone()),
        ("vampire", opts.get("vampire").clone()),
    ]);
    let mut input = common;
    if h2h {
        input.set("gearH2H", gs);
        input.set("gearCrit", gc);
        input.set("wraps", Bool(true));
        let mut ch = theory_fists(&input);
        ch.set("martialPath", s("blademaster"));
        return Ok(ch);
    }
    input.set("blade", t.clone());
    input.set("damagePct", opts.get("damagePct").clone());
    input.set("sockets", Arr(perfect_sockets(&t)));
    let mut ch = theory_character(&input)?;
    let mut career = ch.get("career").clone();
    // mutation: equivalent - every supported WEAPONS row uses skill 28..=33; each has a PROFICIENCY_FLAG entry.
    let prof = crate::save::proficiency_flag(&Num(skill)).unwrap_or(0.0) as u32;
    career.set("weaponArmorShieldsBitfield", Num(f64::from(prof << 16)));
    ch.set("career", career);
    let mut skills = ch.get("skills").items().to_vec();
    skills[skill as usize] = Num(200.0);
    ch.set("skills", Arr(skills));
    ch.set(
        "masteredSkills",
        Arr(mastered.into_iter().map(Num).collect()),
    );
    let mut mods = ch.get("_mods").clone();
    let mut skill_mods = mods.get("skills").clone();
    skill_mods.set(&Num(skill).to_js_string(), add(&gs, &stars));
    skill_mods.set(
        &Num(SKILLS.critical_strike).to_js_string(),
        add(&gc, &stars),
    );
    mods.set("skills", skill_mods);
    ch.set("_mods", mods);
    ch.set("martialPath", s("blademaster"));
    ch.set("_pair", Bool(t.strict_eq(&Num(562.0))));
    Ok(ch)
}

fn tough() -> Value {
    reference_foe(&Num(THEORY_LEVEL), &s("tough"))
}
pub(crate) fn gate() -> Value {
    gate_target(&Num(THEORY_LEVEL), &Undefined)
}

/// The scenario a max-profile card is priced under: the level-45 gate/ordinary-target identity, plus the shipped
/// build (`--game-build`, GEAR-14631 / BRAND-14631). `game_build` is `Undefined` when the caller has no opinion, which
/// prices as the live build.
fn scenario(target: Value, game_build: &Value) -> Value {
    let mut args = obj([
        ("target", target),
        ("core", s("overhaul")),
        ("rri", Bool(true)),
        ("healthShare", Num(1.0)),
        ("passiveOn", Bool(true)),
        // mutation: equivalent - all scenario readers of stacks use Blademaster's clamp: the only reader is
        // `model_blow.rs:787`, `clamp(num("stacks", 5), 0, 5)`, so 5 and 6 both clamp to 5. Raising the default past the
        // clamp cannot move a card.
        ("stacks", Num(5.0)),
    ]);
    // `Undefined` and `Null` are the two no-opinion values `is_nullish` covers, so one test is the whole guard (the
    // `!matches!(game_build, Undefined) && !game_build.is_nullish()` form it replaces had a redundant conjunct).
    if !game_build.is_nullish() {
        args.set("gameBuild", game_build.clone());
    }
    args
}

pub(crate) fn run_args(ch: &Value, opts: &Value) -> Value {
    let t = if opts.get("gate").truthy() {
        gate()
    } else if matches!(opts.get("target"), Undefined) {
        tough()
    } else {
        opts.get("target").clone()
    };
    let health = crate::theory::nullish(t.get("maxHealth"), Num(0.0));
    let mut args = scenario(t, opts.get("gameBuild"));
    args.set("health", health);
    args.set("pair", Bool(ch.get("_pair").truthy()));
    args.set("dual", Bool(ch.get("_dual").truthy()));
    args
}

pub fn max_run(ch: &Value, opts: &Value, book: &Spellbook) -> Analysis {
    analyze(ch, &run_args(ch, opts), book)
}

/// Caller-owned cache; the immutable spellbook is fixed for this cache's lifetime.
/// The tuple key uses the same template, shield and `gameBuild` coercions as the JS cache: the 14631 gear law can move
/// the frontier WINNER (a flat add favours weapon-skill points over Critical Strike), so the cache must key on it.
pub struct Profiles<'a> {
    pub(crate) book: &'a Spellbook,
    cache: HashMap<(String, String, String), (f64, Value)>,
}

impl<'a> Profiles<'a> {
    pub fn new(book: &'a Spellbook) -> Self {
        Self {
            book,
            cache: HashMap::new(),
        }
    }

    fn evaluated(&mut self, template: &Value, opts: &Value) -> Result<&(f64, Value), String> {
        let t = Num(template.to_number());
        obj_table_get(WEAPONS, &t)
            .ok_or_else(|| format!("unknown weapon template {}", template.to_js_string()))?;
        let shield = opts.get("shield");
        let game_build = crate::model_blow::game_build(opts);
        let key = (
            t.to_js_string(),
            if shield.is_nullish() {
                String::new()
            } else {
                shield.to_js_string()
            },
            game_build.to_owned(),
        );
        match self.cache.entry(key) {
            std::collections::hash_map::Entry::Occupied(e) => Ok(e.into_mut()),
            std::collections::hash_map::Entry::Vacant(e) => {
                let skill = weapon_skill_of(&t);
                let points = legal_totals(&obj([
                    ("weaponTemplate", t.clone()),
                    ("skill", Num(skill)),
                    ("shield", shield.clone()),
                ]));
                let raw_args = scenario(tough(), &s(game_build));
                let gate = gate();
                let health = gate.get("maxHealth").clone();
                let mut gate_args = scenario(gate, &s(game_build));
                gate_args.set("health", health);
                let mut rows = Vec::new();
                for p in points.items() {
                    let ch = build_max(&t, &gear_options(p, &Undefined))?;
                    let r = analyze(&ch, &raw_args, self.book);
                    let g = analyze(&ch, &gate_args, self.book);
                    let mut p = p.clone();
                    p.set("dps", Num(r.dps));
                    p.set("cappedDps", Num(g.capped_dps));
                    p.set(
                        "allowanceDps",
                        g.allowance.as_ref().map_or(Num(g.capped_dps), |a| {
                            crate::theory::nullish(a.get("averageDps"), Num(g.capped_dps))
                        }),
                    );
                    rows.push(p);
                }
                Ok(e.insert((skill, Arr(rows))))
            }
        }
    }

    pub fn legal_frontier(&mut self, template: &Value, opts: &Value) -> Result<&Value, String> {
        Ok(&self.evaluated(template, opts)?.1)
    }

    pub fn legal_gear(&mut self, template: &Value, opts: &Value) -> Result<Value, String> {
        let metric = default(opts.get("metric"), s("uncapped"));
        let field = match metric.to_js_string().as_str() {
            "uncapped" => "dps",
            "capped" => "cappedDps",
            "allowance" => "allowanceDps",
            m => return Err(format!("unknown metric \"{m}\"")),
        };
        let (skill, rows) = self.evaluated(template, opts)?;
        let max = rows
            .items()
            .iter()
            .map(|p| p.get(field).to_number())
            .fold(f64::NEG_INFINITY, js_max);
        let mut ties = rows
            .items()
            .iter()
            .filter(|p| tied(p.get(field).to_number(), max));
        let mut best = ties
            .next()
            .ok_or_else(|| "no legal gear point attains the metric".to_owned())?
            .clone();
        best.set("skill", Num(*skill));
        best.set("metric", metric);
        best.set("metricField", s(field));
        best.set("alternatives", Arr(ties.cloned().collect()));
        best.set("violations", validate_plan(best.get("plan")));
        Ok(best)
    }

    pub fn legal_gear_plan(&mut self, template: &Value, opts: &Value) -> Result<Value, String> {
        Ok(self.legal_gear(template, opts)?.get("plan").clone())
    }

    pub fn max_character(&mut self, template: &Value, opts: &Value) -> Result<Value, String> {
        // The gear budget it wears is picked at the caller's build (`legal_gear` re-prices the frontier), and the card
        // it returns is priced at it too, so `opts.gameBuild` reaches both.
        let legal = self.legal_gear(template, opts)?;
        build_max(template, &gear_options(&legal, opts))
    }
}

fn tied(value: f64, max: f64) -> bool {
    (value - max).abs() <= 1e-9
}

fn gear_options(p: &Value, opts: &Value) -> Value {
    obj([
        ("gearSkill", p.get("lb").clone()),
        ("gearCrit", p.get("cs").clone()),
        ("damagePct", p.get("dmg").clone()),
        ("firmament", opts.get("firmament").clone()),
        ("vampire", opts.get("vampire").clone()),
        ("race", opts.get("race").clone()),
    ])
}

#[cfg(test)]
mod tests {
    #[test]
    fn metric_tie_includes_threshold_but_not_its_successor() {
        let boundary = 1e-9_f64;
        assert!(super::tied(0.0, boundary));
        assert!(!super::tied(0.0, boundary.next_up()));
    }
}
