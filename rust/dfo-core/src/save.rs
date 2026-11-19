//! The pure half of `src/save.js` (R4a): the character a save becomes, read as the model reads it. A character is a
//! [`Value`] (the object `characterFromSave` builds), so each read is the JS read of its field. Each function cites the
//! JS lines it ports. Not ported (file and launcher I/O, a save's parse): `userDataDir`, `configPath`, `arena2Dir`,
//! `savesDir`, `listSaves`, `resolveSave`, `loadSave`, `characterFromSave`. The model reads a built character, not a
//! file, so no pure function here needs them (see `rust/README.md`, R4a).
//!
//! The field names are the JS keys: `online`, `masterSkills`, `masteredSkills`, `skills`, `_enchantMods.skillMods`,
//! `_mods.skills`, `_mods.stats`, `_mods.statMax`, `activeEffects` (each entry's `kind`, `ended`, `statMods`, `stat`,
//! `magnitude`, `skillMods`), `stats`, `name`, `raceId`, `race`, `career.name`, `level`.

use crate::gear_lines::{valid_item_lines, weapon_damage_pct};
use crate::generated::data::{RACE_NAMES, SKILL_NAMES};
use crate::generated::js_prototypes::{ARRAY_PROTOTYPE_KEYS, OBJECT_PROTOTYPE_KEYS};
use crate::generated::save_tables::{ENHANCE_SKILL_MOD, PROFICIENCY_FLAG, WEAPON_SKILL};
use crate::round::{js_max, js_min, to_int32};
use crate::value::{number_to_string, obj_table_get, refuse_inherited, Value};

/// `WEAPON_SKILL[template]` (save.js:116-123): the skill a template swings with, or `undefined`.
pub fn weapon_skill(template: &Value) -> Option<f64> {
    obj_table_get(WEAPON_SKILL, template)
}

/// `PROFICIENCY_FLAG[skill]` (save.js:126-129): the proficiency bit of a weapon skill, or `undefined`.
pub fn proficiency_flag(skill: &Value) -> Option<f64> {
    obj_table_get(PROFICIENCY_FLAG, skill)
}

/// `effectiveSkill(v)` (save.js:132-137), SOFTCAP1: a point past 100 is worth a quarter, plus the milestones. A
/// value that is not a finite number reads as 0 (`Number.isFinite`), and the raw skill is clamped to 0..=200.
pub fn effective_skill(v: &Value) -> f64 {
    let raw = js_max(0.0, js_min(200.0, v.finite_or(0.0)));
    // mutation: equivalent - at raw == 100 the milestone arm gives floor(100 + 0 + 0) = 100 = raw, so `< 100.0` agrees.
    if raw <= 100.0 {
        return raw;
    }
    let milestones = if raw >= 200.0 {
        15.0
    } else if raw >= 175.0 {
        9.0
    } else if raw >= 150.0 {
        5.0
    } else if raw >= 125.0 {
        2.0
    } else {
        0.0
    };
    (100.0 + (raw - 100.0) * 0.25 + milestones).floor()
}

/// `masterSkillsActive(ch)` (save.js:140-142), SOFTCAP3: online is always in force; offline the saved switch decides.
pub fn master_skills_active(ch: &Value) -> bool {
    ch.get("online").strict_eq(&Value::Bool(true))
        || ch.get("masterSkills").strict_eq(&Value::Bool(true))
}

/// `masterCappedSkill(ch, id, raw)` (save.js:145-149), SOFTCAP4: only a mastered skill may read past 100. Without the
/// mastery switches it is `Math.min(raw, 100)` (a number, `raw` coerced); with a `null`/`undefined` id it is `raw`
/// itself; with an id in `masteredSkills` (SameValueZero) it is `raw` itself; otherwise `Math.min(raw, 100)`.
pub fn master_capped_skill(ch: &Value, id: &Value, raw: &Value) -> Value {
    if !master_skills_active(ch) {
        return Value::Num(js_min(raw.to_number(), 100.0));
    }
    if id.is_nullish() {
        return raw.clone();
    }
    let mastered = ch
        .get("masteredSkills")
        .items()
        .iter()
        .any(|m| m.same_value_zero(id));
    if mastered {
        raw.clone()
    } else {
        Value::Num(js_min(raw.to_number(), 100.0))
    }
}

/// `skillModOf(ch, id)` (save.js:152-158): the skill's mods on top of the softcap, the enchantment channel and the
/// gear's `_mods.skills`, plus each live `racialOverride` effect's `skillMods` (an ended one is skipped).
pub fn skill_mod_of(ch: &Value, id: &Value) -> f64 {
    let mut m = ch.get("_enchantMods").get("skillMods").prop(id).num_or(0.0)
        + ch.get("_mods").get("skills").prop(id).num_or(0.0);
    for a in ch.get("activeEffects").items() {
        if a.get("kind").is_str("racialOverride") && !a.get("ended").truthy() {
            m += a.get("skillMods").prop(id).num_or(0.0);
        }
    }
    m
}

/// `skillValue(ch, id)` (save.js:161-164): what a formula reads, the softcap of the saved skill (`?? 0`, then
/// [`master_capped_skill`] and [`effective_skill`]) plus [`skill_mod_of`].
pub fn skill_value(ch: &Value, id: &Value) -> f64 {
    let raw = ch.get("skills").prop(id);
    let raw = if raw.is_nullish() {
        Value::Num(0.0)
    } else {
        raw
    };
    effective_skill(&master_capped_skill(ch, id, &raw)) + skill_mod_of(ch, id)
}

/// `liveStat(ch, name)` (save.js:167-181): the attribute after the active effects and the gear's mods, clamped to
/// `0..=100 + max(0, statMax)`. A base that is not a finite number reads 0 (`NUM`). Effects: `disease`, `poison` and
/// `artifact` add their `statMods[name] ?? 0`; `racialOverride` adds it only when above 0; `fortifyAttribute` on this
/// stat adds `magnitude ?? 0`; `drainAttribute` and `transferAttribute` on it take it away. An ended effect is skipped.
pub fn live_stat(ch: &Value, name: &str) -> f64 {
    let base = ch.get("stats").get(name).finite_or(0.0);
    let mut m = 0.0;
    for a in ch.get("activeEffects").items() {
        if !a.truthy() || a.get("ended").truthy() {
            continue;
        }
        let names_stat = a.get("stat").is_str(name);
        match a.get("kind").as_str() {
            Some("disease" | "poison" | "artifact") => {
                m += a.get("statMods").get(name).num_or(0.0);
            }
            Some("racialOverride") => {
                let v = a.get("statMods").get(name).num_or(0.0);
                // mutation: equivalent - at v == 0 the arm adds 0, and m + 0.0 is m, so `v >= 0.0` agrees.
                if v > 0.0 {
                    m += v;
                }
            }
            Some("fortifyAttribute") if names_stat => {
                m += a.get("magnitude").num_or(0.0);
            }
            Some("drainAttribute" | "transferAttribute") if names_stat => {
                m -= a.get("magnitude").num_or(0.0);
            }
            _ => {}
        }
    }
    m += ch.get("_mods").get("stats").get(name).num_or(0.0);
    let max_mod = js_max(0.0, ch.get("_mods").get("statMax").get(name).num_or(0.0));
    js_max(0.0, js_min(100.0 + max_mod, base + m))
}

/// `rebuildEnchantMods(items)` (save.js:192-204): the held enchantment fold. Every enchantment of type 10 whose `param`
/// is a skill id in 0..35 (`Number(param)`) adds [`ENHANCE_SKILL_MOD`] to that skill. The chance-to-hit fold is 0.
pub fn rebuild_enchant_mods(items: &Value) -> Value {
    let mut skill_mods = Value::Obj(Vec::new());
    for item in items.items() {
        for e in item.get("enchantments").items() {
            if !e.get("type").strict_eq(&Value::Num(10.0)) {
                continue;
            }
            let id = e.get("param").to_number();
            if (0.0..35.0).contains(&id) {
                let key = number_to_string(id);
                let prev = skill_mods.get(&key).num_or(0.0);
                skill_mods.set(&key, Value::Num(prev + ENHANCE_SKILL_MOD));
            }
        }
    }
    let mut out = Value::Obj(Vec::new());
    out.set("skillMods", skill_mods);
    out.set("chanceToHitMod", Value::Num(0.0));
    out
}

/// `addMap(obj, key, value)` (save.js:183-186): `obj[key] = (obj[key] ?? 0) + value`. save.js also skips a null or `''`
/// key and a non-finite value. The callers here pass only the validated lines' params (a stat, skill or slayer name:
/// never null or empty) and integer values, so that skip is unreachable and is not ported.
fn add_map(obj: &mut Value, key: &Value, value: f64) {
    let k = key.to_js_string();
    let prev = obj.get(&k).num_or(0.0);
    obj.set(&k, Value::Num(prev + value));
}

/// `rebuildMods(items)` (save.js:207-230): the modifier channels from the worn gear. A piece with a null or undefined
/// `equipSlot` is skipped; a Weapons piece adds its [`weapon_damage_pct`]; each of its valid lines adds `value | 0` to
/// `stats`, `skills` or `slayer` by param, or to every `armoredParts` slot for an `armor` line.
pub fn rebuild_mods(items: &Value) -> Value {
    let mut stats = Value::Obj(Vec::new());
    let mut skills = Value::Obj(Vec::new());
    let mut weapon_damage = 0.0;
    let mut slayer = Value::Obj(Vec::new());
    let mut armored = [0.0_f64; 7];
    for it in items.items() {
        if !it.truthy() || it.get("equipSlot").is_nullish() {
            continue;
        }
        if it.get("group").is_str("Weapons") {
            weapon_damage += weapon_damage_pct(it);
        }
        for a in valid_item_lines(it) {
            let v = f64::from(to_int32(a.get("value").to_number()));
            match a.get("id").as_str() {
                Some("stat") => add_map(&mut stats, a.get("param"), v),
                Some("skill") => add_map(&mut skills, a.get("param"), v),
                Some("slayer") => add_map(&mut slayer, a.get("param"), v),
                Some("armor") => {
                    for p in armored.iter_mut() {
                        *p += v;
                    }
                }
                _ => {}
            }
        }
    }
    let mut out = Value::Obj(Vec::new());
    out.set("stats", stats);
    out.set("skills", skills);
    out.set("weaponDamagePct", Value::Num(weapon_damage));
    out.set("slayer", slayer);
    out.set(
        "armoredParts",
        Value::Arr(armored.iter().map(|x| Value::Num(*x)).collect()),
    );
    out
}

/// `characterLabel(ch)` (save.js:309-313): `${name} - ${race}${career}, level ${level}`, where the race is
/// `RACE_NAMES[raceId] ?? ch.race ?? ''` and the career is ` ${career.name}` when the name is truthy.
pub fn character_label(ch: &Value) -> String {
    let race = match obj_table_get(RACE_NAMES, ch.get("raceId")) {
        Some(name) => name.to_owned(),
        None => {
            let r = ch.get("race");
            if r.is_nullish() {
                String::new()
            } else {
                r.to_js_string()
            }
        }
    };
    let career_name = ch.get("career").get("name");
    let career = if career_name.truthy() {
        format!(" {}", career_name.to_js_string())
    } else {
        String::new()
    };
    format!(
        "{} - {}{}, level {}",
        ch.get("name").to_js_string(),
        race,
        career,
        ch.get("level").to_js_string()
    )
}

/// `skillName(id)` (save.js:315-317): `SKILL_NAMES[id] ?? String(id)`. `SKILL_NAMES` is an array, so an index (an integer, or
/// a canonical index string) names a skill. `length` is the array's own length (a number, 35); any other inherited array or
/// object member is a function or an object, which is refused ([`refuse_inherited`]). Anything else is its own string.
pub fn skill_name(id: &Value) -> Value {
    if let Some(name) = id.array_index().and_then(|i| SKILL_NAMES.get(i)) {
        return Value::Str((*name).to_owned());
    }
    if id.is_str("length") {
        return Value::Num(SKILL_NAMES.len() as f64);
    }
    let k = id.to_js_string();
    refuse_inherited(
        &k,
        "the skill names",
        &[OBJECT_PROTOTYPE_KEYS, ARRAY_PROTOTYPE_KEYS],
    );
    Value::Str(k)
}
