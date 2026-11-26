//! The real-loadout chain (`src/realBuild.js`): the Firmament tree applied to a built character, then the enchant plan,
//! then the best eligible imprint, and the loadout universe built from it.
//!
//! The JS mutates characters in place (`applyFirmament` writes `ch._mods`) and passes the SAME object on, so every step
//! here takes a `Value` and returns the edited one, with the caller cloning where the JS clones (`clone(gearCh)`).
//! `run.with({ imprint })` is `analyze_with` on the character and the scenario that produced the run, which is why the
//! stage carries `ch` and `args` beside the priced run.

use crate::analyze::{analyze_with, gate_target, reference_foe, Analysis};
use crate::enchants::ENCHANTMENT_TYPES;
use crate::encounters::encounter_target;
use crate::firmament::{build_by_id, plan_build, tree_blow};
use crate::firmament_law::{blow_pct, effective_value, Totals};
use crate::generated::data::WEAPONS;
use crate::generated::planning::SKILL_KEYS;
use crate::imprints::{imprint_families, imprints_for, power_dps};
use crate::maxprofile::{max_run, run_args, Profiles};
use crate::purse::simulate_purse;
use crate::spells::Spellbook;
use crate::theory::{obj, s, THEORY_LEVEL};
use crate::value::{
    obj_table_get,
    Value::{self, Arr, Bool, Null, Num, Obj, Undefined},
};

/// The build each weapon family's tree is planned from (`BUILD_ID`), with the identity fallback for a key that is not
/// one of them.
fn build_id_for(family_key: &str) -> &str {
    match family_key {
        "LongBlade" => "longblade",
        "ShortBlade" => "shortblade",
        "Axe" => "axe",
        "BluntWeapon" => "blunt",
        "Archery" => "bow",
        "HandToHand" => "fists",
        other => other,
    }
}

/// `SKILLS[name]`: the skill id a name maps to, or `None` when the name is not one of the game's skills.
fn skill_id_by_name(name: &str) -> Option<f64> {
    SKILL_KEYS.iter().position(|k| *k == name).map(|i| i as f64)
}

fn sub_object(v: &Value) -> Value {
    match v {
        Obj(_) => v.clone(),
        _ => Obj(vec![]),
    }
}

fn num_of(v: &Value) -> f64 {
    v.num_or_default(0.0)
}

fn totals_of(v: &Value) -> Totals {
    crate::firmament_law::totals_from_value(v)
}

/// `applyFirmament`: fold the tree's flat and percent channels into the character, each channel capped together.
pub fn apply_firmament(ch: &Value, plan: &Value) -> Value {
    let totals = plan.get("totals");
    let law = totals_of(totals);
    let mods = ch.get("_mods");
    let mut stats = sub_object(mods.get("stats"));
    let mut stat_max = sub_object(mods.get("statMax"));
    for a in crate::firmament_law::ATTRS {
        let v = effective_value(&law, a);
        if v > 0.0 {
            stats.set(a, Num(num_of(stats.get(a)) + v));
            stat_max.set(a, Num(num_of(stat_max.get(a)) + v));
        }
    }
    let mut skills = sub_object(mods.get("skills"));
    let mut names: Vec<String> = Vec::new();
    for (key, _) in totals.entries() {
        let name = key
            .strip_prefix("skill.")
            .or_else(|| key.strip_prefix("skillPct."));
        if let Some(name) = name {
            if !names.iter().any(|n| n == name) {
                names.push(name.to_owned());
            }
        }
    }
    for name in names {
        let Some(id) = skill_id_by_name(&name) else {
            continue;
        };
        let v = effective_value(&law, &format!("skill.{name}"));
        // mutation: equivalent - `>` -> `>=` and `0.0 -> 1`: the six family trees' skill channels are all whole numbers
        // >= 6 (the probe read every tree: 6,8,11,12,13,15 per family), never 0 and never in (0,1), so a zero arm and
        // a 1 threshold admit exactly the same names. The `apply` vectors carry the folded skill map.
        if v > 0.0 {
            let key = crate::value::number_to_string(id);
            skills.set(&key, Num(num_of(skills.get(&key)) + v));
        }
    }
    let mut mods = sub_object(mods);
    mods.set("stats", stats);
    mods.set("statMax", stat_max);
    mods.set("skills", skills);
    let mut out = ch.clone();
    out.set("_mods", mods);
    let skill = plan.get("build").get("skill");
    let blow = blow_pct(&law, skill.as_str(), None, false, false);
    out.set("firmamentDamagePct", Num(blow));
    out
}

/// `applyTree`: the real Firmament plan for a weapon family, applied to a character.
pub fn apply_tree(ch: &Value, family_key: &str) -> Value {
    // The JS `planBuild(buildById(...))` would throw on a missing build; the probe tree keeps the same shape.
    let plan = match family_tree(family_key) {
        Ok(plan) => plan,
        Err(_) => obj([("totals", Obj(vec![])), ("build", Obj(vec![]))]),
    };
    apply_firmament(ch, &plan)
}

/// `applyEnchants`: the plan's skill lines and weapon strike rows, on the weapon (or the wraps when there is no weapon).
fn apply_enchants(ch: &Value, plan: &Value) -> Value {
    let mut out = ch.clone();
    let on_weapon = !out.get("weapon").is_nullish();
    let item = if on_weapon {
        out.get("weapon").clone()
    } else {
        out.get("wraps").clone()
    };
    let mut skills = sub_object(out.get("_mods").get("skills"));
    let mut enchants = item.get("enchantments").items().to_vec();
    for row in plan.get("rows").items() {
        for e in row.get("effects").items() {
            let kind = e.get("type").to_js_string();
            if kind == "EnhancesSkill" {
                let key = e.get("param").to_js_string();
                skills.set(&key, Num(num_of(skills.get(&key)) + 15.0));
            } else if let Some(id) = item_enchant_id(&kind) {
                enchants.push(obj([("type", Num(id)), ("param", e.get("param").clone())]));
            }
        }
    }
    let mut mods = sub_object(out.get("_mods"));
    mods.set("skills", skills);
    out.set("_mods", mods);
    if item.truthy() {
        let mut item = item;
        item.set("enchantments", Arr(enchants));
        item.set("currentCondition", Num(set_condition(&item)));
        item.set("maxCondition", Num(set_condition(&item)));
        if on_weapon {
            out.set("weapon", item);
        } else {
            out.set("wraps", item);
        }
    }
    out
}

/// `Math.max(1, Number(item.maxCondition) || 800)`: the condition the chain writes back. Unlike `enchant_plan`'s copy
/// of the same line, this one IS observable: the chain's characters feed `simulatePurse` and the returned `enchCh`, and
/// the vectors' `stage` cases carry the written condition.
fn set_condition(item: &Value) -> f64 {
    let max = item.get("maxCondition").to_number();
    // mutation: equivalent - every item the chain visits is a built character's weapon, whose `maxCondition` is the
    // template's positive hitPoints (theory.js:107 sets 100, gear templates 1..50000), so neither the NaN nor the zero
    // arm fires and the literal is never written. This covers `0.0 -> 1` here and `800 -> 801` below; the `stage`
    // vectors carry the written condition, which is the template's own number in every case.
    let or = if max.is_nan() || max == 0.0 {
        // mutation: equivalent - `800 -> 801`: see the note above; this arm never runs for a built character.
        800.0
    } else {
        max
    };
    1.0f64.max(or)
}

fn item_enchant_id(kind: &str) -> Option<f64> {
    match kind {
        "CastWhenStrikes" => Some(ENCHANTMENT_TYPES.cast_when_strikes),
        "PotentVs" => Some(ENCHANTMENT_TYPES.potent_vs),
        _ => None,
    }
}

fn monster_kind(kind: &Value) -> bool {
    matches!(kind.as_str(), Some("bane" | "sanctified" | "moon"))
}

/// The stage the imprint step prices: the character, the scenario its run was made under, and that run.
pub struct Priced<'a> {
    pub ch: &'a Value,
    pub args: &'a Value,
    pub run: &'a Analysis,
}

/// `bestImprint`: the best eligible imprint for this weapon and target, with the card figure of the same winner.
fn best_imprint(template: &Value, priced: Priced<'_>, capped: bool, book: &Spellbook) -> Value {
    let baseline = if capped {
        priced.run.totals.carried_capped_dps
    } else {
        priced.run.totals.carried_dps
    };
    let mut rows: Vec<Value> = Vec::new();
    for rec in imprints_for(template).items() {
        let power = rec.get("power");
        if monster_kind(power.get("kind")) {
            continue;
        }
        let dps = power_dps(power, priced.ch, priced.args, false, capped, book);
        // mutation: equivalent - `>` -> `>=` and the `1e-9` epsilon: the passing rows beat the baseline by at least
        // 0.0085 and every non-passing row is exactly 0 (the probe read all 12 family/mode combinations), so neither an
        // inclusive comparison nor a smaller epsilon changes the set. The epsilon only guards a float-noise tie that
        // does not occur; the chosen imprint (`stage`'s `imprint`) is what the vectors pin.
        if dps > baseline + 1e-9 {
            rows.push(obj([
                ("name", rec.get("name").clone()),
                ("power", power.clone()),
                ("dps", Num(dps)),
            ]));
        }
    }
    // `sort((a, b) => b.dps - a.dps)[0]`: a stable descending sort, first row wins a tie.
    rows.sort_by(|a, b| {
        // mutation: equivalent - `-` -> `+` cannot change the pick: over all 12 family/mode combinations
        // `imprintsFor` inserts the passing rows in descending `dps` order already (the probe checked every family
        // template at both targets: 21 cases with 3 passing rows, 0 where insertion order differed from dps order),
        // so a sort that never orders keeps the same first row. The `[0]` pick is what the vectors pin.
        let d = num_of(b.get("dps")) - num_of(a.get("dps"));
        // mutation: equivalent - `0.0 -> 1` and `<` -> `<=`: passing rows differ by at least 54.66 (the probe read
        // every pair in all 12 family/mode combinations; no two tie), so a `1` threshold and an inclusive comparison
        // both order every pair exactly as the original. The rows also arrive already descending, so even an
        // unordered pair would leave the maximum first; `stage`'s `imprint` pins the pick.
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Equal
        }
    });
    let Some(best) = rows.first() else {
        return Null;
    };
    let carded = analyze_with(
        priced.ch,
        priced.args,
        &obj([("imprint", best.get("power").clone())]),
        book,
    );
    // `with()` returns the card, so the JS reads `carded.cappedDps` / `carded.dps` (the card figures, not carried).
    let card_dps = if capped {
        carded.card.fields.capped_dps
    } else {
        carded.card.fields.dps
    };
    let mut out = best.clone();
    out.set("cardDps", Num(card_dps));
    out
}

/// The tree a loadout's family is planned from. Every family key `imprintFamilies` publishes maps to a build in
/// `BUILDS` (the probe checked all six), so a missing build is an error rather than an empty tree: an empty tree would
/// silently price the gear row as if the sky gave nothing.
fn family_tree(family_key: &str) -> Result<Value, String> {
    let build = build_by_id(&s(build_id_for(family_key)))
        .ok_or_else(|| format!("no build for family {family_key}"))?;
    Ok(plan_build(build, &Obj(vec![])))
}

/// The options `realBuildStages` reads, as the JS destructured defaults leave them. `game_build` is additive: an
/// `..Default::default()` caller leaves the key out, which prices the LIVE build (as a JS caller with no `gameBuild`
/// does); name `"14512"` to reproduce the vendored cut. `StageOpts::from_value` reads `gameBuild`.
pub struct StageOpts {
    pub mode: String,
    pub vampire: bool,
    pub dual: bool,
    pub encounter: String,
    pub game_build: String,
}

impl Default for StageOpts {
    fn default() -> Self {
        Self {
            mode: "uncapped".to_owned(),
            vampire: false,
            dual: false,
            encounter: "breach".to_owned(),
            game_build: crate::model_blow::DEFAULT_GAME_BUILD.to_owned(),
        }
    }
}

impl StageOpts {
    /// Read the four keys from an options object, with the JS defaults for an absent key.
    pub fn from_value(opts: &Value) -> Self {
        let mut out = Self::default();
        if let Some(mode) = opts.get("mode").as_str() {
            out.mode = mode.to_owned();
        }
        match opts.get("vampire") {
            Undefined => (),
            v => out.vampire = v.truthy(),
        }
        match opts.get("dual") {
            Undefined => (),
            v => out.dual = v.truthy(),
        }
        if let Some(encounter) = opts.get("encounter").as_str() {
            out.encounter = encounter.to_owned();
        }
        if let Some(build) = opts.get("gameBuild").as_str() {
            out.game_build = crate::model_blow::game_build_name(build).to_owned();
        }
        out
    }

    /// The same options as the object the vectors pass.
    pub fn to_value(&self) -> Value {
        obj([
            ("mode", s(&self.mode)),
            ("vampire", Bool(self.vampire)),
            ("dual", Bool(self.dual)),
            ("encounter", s(&self.encounter)),
            ("gameBuild", s(&self.game_build)),
        ])
    }
}

/// The four stages of one loadout (JS `realBuildStages`). `treeCh` is the character after the tree, `enchCh` after the
/// enchant plan; the runs are the priced cards at those two stages.
pub struct Stages {
    pub capped: bool,
    pub target: Value,
    pub tree: Value,
    pub gear_ch: Value,
    pub tree_ch: Value,
    pub ench_ch: Value,
    pub ench_plan: Value,
    pub tree_run: Analysis,
    pub ench_run: Analysis,
    pub tree_args: Value,
    pub ench_args: Value,
    pub imprint: Value,
}

/// `realBuildStages`: the character chain behind one real loadout, at each stage.
pub fn real_build_stages(
    template: &Value,
    family: &Value,
    opts: &StageOpts,
    book: &Spellbook,
) -> Result<Stages, String> {
    let mut profiles = Profiles::new(book);
    real_build_stages_with(template, family, opts, &mut profiles)
}

/// [`real_build_stages`] on a caller-owned frontier cache: a batch over many loadouts evaluates each weapon template's
/// gear frontier once, as the JS module-level `_frontiers` map does.
pub fn real_build_stages_with(
    template: &Value,
    family: &Value,
    opts: &StageOpts,
    profiles: &mut Profiles<'_>,
) -> Result<Stages, String> {
    let book = profiles.book;
    let capped = opts.mode != "uncapped";
    let target = if capped {
        encounter_target(&s(&opts.encounter), &Num(THEORY_LEVEL), &Undefined)
    } else {
        reference_foe(&Num(THEORY_LEVEL), &s("tough"))
    };
    let family_key = family.get("key").to_js_string();
    let tree = family_tree(&family_key)?;
    // The shipped build rides every card this chain prices (the legal budget it picks and both runs it reads).
    let game_build = s(&opts.game_build);
    // The gear-only baseline is kept before the tree folds into the same character (`applyFirmament` mutates).
    let gear_ch = profiles.max_character(
        template,
        &obj([
            ("vampire", Bool(opts.vampire)),
            ("gameBuild", game_build.clone()),
        ]),
    )?;
    let mut tree_ch = apply_firmament(&gear_ch, &tree);
    if opts.dual {
        let mut off = tree_ch.get("weapon").clone();
        off.set("equipSlot", Num(21.0));
        tree_ch.set("offWeapon", off);
        tree_ch.set("_dual", Bool(true));
    }
    let tree_opts = obj([
        ("target", target.clone()),
        ("gameBuild", game_build.clone()),
    ]);
    let tree_args = run_args(&tree_ch, &tree_opts);
    let tree_run = max_run(&tree_ch, &tree_opts, book);
    let group = match target.get("group") {
        Undefined | Null => s(if capped { "none" } else { "humanoid" }),
        v => v.clone(),
    };
    let ench_plan = crate::enchant_plan::plan_enchants_with(
        &obj([
            ("weapon", template.clone()),
            ("soulGem", Bool(true)),
            ("forceSkills", Bool(!capped)),
            ("target", target.clone()),
            ("group", group),
            ("gameBuild", game_build.clone()),
        ]),
        profiles,
    )?;
    let mut ench_ch = apply_enchants(&tree_ch, &ench_plan);
    // mutation: equivalent - `&&` -> `||`: for a non-dual row `offWeapon` is absent, so the second term is false and
    // `||` is the same as `&&` there; for a dual row `real_build_stages` always set `offWeapon` (it copies the main
    // hand), so the second term is true and both tests agree. The vectors include dual rows at four encounters.
    if opts.dual && !ench_ch.get("offWeapon").is_nullish() {
        let main_enchants = ench_ch.get("weapon").get("enchantments").items().to_vec();
        let mut off = ench_ch.get("offWeapon").clone();
        off.set("enchantments", Arr(main_enchants));
        let condition = set_condition(&off);
        off.set("currentCondition", Num(condition));
        off.set("maxCondition", Num(condition));
        ench_ch.set("offWeapon", off);
    }
    let ench_opts = obj([
        ("target", target.clone()),
        ("gameBuild", game_build.clone()),
    ]);
    let ench_args = run_args(&ench_ch, &ench_opts);
    let ench_run = max_run(&ench_ch, &ench_opts, book);
    let imprint = best_imprint(
        template,
        Priced {
            ch: &ench_ch,
            args: &ench_args,
            run: &ench_run,
        },
        capped,
        book,
    );
    Ok(Stages {
        capped,
        target,
        tree,
        gear_ch,
        tree_ch,
        ench_ch,
        ench_plan,
        tree_run,
        ench_run,
        tree_args,
        ench_args,
        imprint,
    })
}

fn opt_field(v: Option<f64>) -> Value {
    v.map_or(Null, Num)
}

/// `realTemplate`: one real loadout row for one template.
pub fn real_template(
    template: &Value,
    family: &Value,
    opts: &StageOpts,
    book: &Spellbook,
) -> Result<Value, String> {
    let mut profiles = Profiles::new(book);
    real_template_with(template, family, opts, &mut profiles)
}

/// [`real_template`] on a caller-owned frontier cache.
pub fn real_template_with(
    template: &Value,
    family: &Value,
    opts: &StageOpts,
    profiles: &mut Profiles<'_>,
) -> Result<Value, String> {
    let book = profiles.book;
    let st = real_build_stages_with(template, family, opts, profiles)?;
    let ench_dps = st.ench_run.totals.carried_capped_dps + st.ench_run.card.fields.enchant_dps;
    let imprint_dps = if matches!(st.imprint, Null) {
        st.ench_run.totals.carried_capped_dps
    } else {
        num_of(st.imprint.get("dps"))
    };
    let total_dps = st.ench_run.card.fields.enchant_dps + imprint_dps;
    let card_imprint = if matches!(st.imprint, Null) {
        st.ench_run.card.fields.capped_dps
    } else {
        num_of(st.imprint.get("cardDps"))
    };
    let card_total_dps = st.ench_run.card.fields.enchant_dps + card_imprint;
    let imprinted = if matches!(st.imprint, Null) {
        analyze_with(&st.ench_ch, &st.ench_args, &Obj(vec![]), book)
    } else {
        analyze_with(
            &st.ench_ch,
            &st.ench_args,
            &obj([("imprint", st.imprint.get("power").clone())]),
            book,
        )
    };
    let purse = if st.capped {
        simulate_purse(
            &imprinted.to_value(),
            &s(&opts.encounter),
            &obj([("level", Num(THEORY_LEVEL))]),
        )?
    } else {
        Null
    };
    let purse_field = |key: &str| match purse.get(key) {
        Num(_) => purse.get(key).clone(),
        _ => Null,
    };
    let ttk = match purse.get("ttk") {
        Num(n) => Num(*n),
        _ => opt_field(st.ench_run.card.fields.ttk),
    };
    let calibrated = match purse.get("calibrated") {
        Bool(b) => Bool(*b),
        _ => Bool(true),
    };
    let weapon_name =
        obj_table_get(WEAPONS, template).map_or_else(|| s(&template.to_js_string()), |w| s(w.name));
    let mut out = obj([
        ("mode", s(&opts.mode)),
        ("family", family.get("name").clone()),
        ("key", family.get("key").clone()),
        ("weapon", weapon_name),
        ("template", template.clone()),
        ("dual", Bool(opts.dual)),
        ("encounter", s(&opts.encounter)),
        ("treeStars", st.tree.get("stars").clone()),
        ("freeStars", st.tree.get("freeStars").clone()),
        ("treeBlow", Num(tree_blow(&st.tree))),
        (
            "treeDps",
            Num(st.tree_run.totals.carried_capped_dps + st.tree_run.card.fields.enchant_dps),
        ),
        ("enchDps", Num(ench_dps)),
        ("totalDps", Num(total_dps)),
        ("metric", s("carried")),
        (
            "cardTreeDps",
            opt_field(st.tree_run.totals.ceiling_total_dps),
        ),
        (
            "cardEnchDps",
            opt_field(st.ench_run.totals.ceiling_total_dps),
        ),
        ("cardTotalDps", Num(card_total_dps)),
        ("ttk", ttk),
        ("burst5", purse_field("burst5")),
        ("sustainedDps", purse_field("sustainedDps")),
        ("averageDps", purse_field("averageDps")),
        ("ceilingDps", purse_field("ceilingDps")),
        ("landedShare", purse_field("landedShare")),
        ("calibrated", calibrated),
        ("imprint", st.imprint.get("name").clone()),
        ("imprintPower", st.imprint.get("power").get("name").clone()),
        ("enchPlan", st.ench_plan.clone()),
    ]);
    if matches!(out.get("imprint"), Undefined) {
        out.set("imprint", Null);
    }
    if matches!(out.get("imprintPower"), Undefined) {
        out.set("imprintPower", Null);
    }
    Ok(out)
}

/// `realWeaponLoadouts`: every weapon template in every hold configuration, not just the winners.
pub fn real_weapon_loadouts(
    modes: &[String],
    vampire: bool,
    encounter: &str,
    game_build: &str,
    book: &Spellbook,
) -> Result<Vec<Value>, String> {
    let mut profiles = Profiles::new(book);
    real_weapon_loadouts_with(modes, vampire, encounter, game_build, &mut profiles)
}

/// [`real_weapon_loadouts`] on a caller-owned frontier cache: every row of one universe reuses one evaluation per
/// weapon template, which is the JS `_frontiers` map's behaviour across a whole batch.
pub fn real_weapon_loadouts_with(
    modes: &[String],
    vampire: bool,
    encounter: &str,
    game_build: &str,
    profiles: &mut Profiles<'_>,
) -> Result<Vec<Value>, String> {
    // mutation: equivalent - dropping this normalisation (`let game_build = game_build.to_owned();`) leaves every price
    // unchanged: the value only ever reaches a scenario as `gameBuild`, and `model_blow::game_build` re-reads it with
    // `is_str("14512")` (`model_blow.rs:811`), so `"1463"`/`""` already price as the live build. It is kept because
    // `StageOpts::to_value` is a public shape that should carry the one name, not a caller's spelling.
    let game_build = crate::model_blow::game_build_name(game_build).to_owned();
    let mut out = Vec::new();
    for mode in modes {
        for family in imprint_families() {
            for t in family.get("templates").items() {
                let Some(w) = obj_table_get(WEAPONS, t) else {
                    continue;
                };
                let category = if w.skill == "HandToHand" {
                    "Fists"
                } else if w.two_handed {
                    "2H"
                } else {
                    "1H"
                };
                let opts = StageOpts {
                    mode: mode.clone(),
                    vampire,
                    dual: false,
                    encounter: encounter.to_owned(),
                    game_build: game_build.clone(),
                };
                let mut row = real_template_with(t, family, &opts, profiles)?;
                row.set("category", s(category));
                out.push(row);
                if !w.two_handed && w.skill != "Archery" && w.skill != "HandToHand" {
                    let dual_opts = StageOpts {
                        mode: mode.clone(),
                        vampire,
                        dual: true,
                        encounter: encounter.to_owned(),
                        game_build: game_build.clone(),
                    };
                    let mut row = real_template_with(t, family, &dual_opts, profiles)?;
                    row.set("category", s("DW"));
                    out.push(row);
                }
            }
        }
    }
    Ok(out)
}

/// `isSampledLoadout`: the sampled fight schedule supports melee weapon rows only.
pub fn is_sampled_loadout(row: &Value) -> bool {
    let family_ok = !row.get("family").is_str("Archery");
    let category_ok = !row.get("category").is_str("Fists");
    let ranged =
        obj_table_get(WEAPONS, row.get("template")).is_some_and(|w| w.ranged == Some(true));
    family_ok && category_ok && !ranged
}

/// The unexported `gateTarget` default the JS uses for a `target` it is not given; kept here so a caller that needs the
/// same foe as `planEnchants` can ask for it.
pub fn theory_gate_target() -> Value {
    gate_target(&Num(THEORY_LEVEL), &Undefined)
}
