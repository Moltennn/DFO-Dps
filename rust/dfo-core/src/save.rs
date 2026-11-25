//! The pure half of `src/save.js` (R4a, R8): the character a save becomes, read as the model reads it. A character is a
//! [`Value`] (the object [`character_from_save`] builds), so each read is the JS read of its field. Each function cites
//! the JS lines it ports. Not ported (file and launcher I/O, a save's parse): `userDataDir`, `configPath`, `arena2Dir`,
//! `savesDir`, `listSaves`, `resolveSave`, `loadSave`. The model reads a built character, not a file, so no pure function
//! here needs them (see `rust/README.md`, R4a).
//!
//! The field names are the JS keys: `online`, `masterSkills`, `masteredSkills`, `skills`, `_enchantMods.skillMods`,
//! `_mods.skills`, `_mods.stats`, `_mods.statMax`, `activeEffects` (each entry's `kind`, `ended`, `statMods`, `stat`,
//! `magnitude`, `skillMods`), `stats`, `name`, `raceId`, `race`, `career.name`, `level`.

use crate::gear_lines::{valid_item_lines, weapon_damage_pct};
use crate::generated::data::{RACE_NAMES, SKILL_NAMES};
use crate::generated::js_prototypes::{ARRAY_PROTOTYPE_KEYS, OBJECT_PROTOTYPE_KEYS};
use crate::generated::save_tables::{ENHANCE_SKILL_MOD, PROFICIENCY_FLAG, SLOT, WEAPON_SKILL};
use crate::round::{is_integer, js_max, js_min, to_int32};
use crate::value::{number_to_string, obj_table_get, refuse_inherited, string_to_number, Value};

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
    // mutation: equivalent - for every raw in [200, 201] the result is floor(100 + (raw - 100) * 0.25 + 15) = floor(140 + d) with 0 <= d <= 0.25, which is 140: the 200 milestone's +15 absorbs the extra quarter point, so a clamp at 200 or at 201 gives the same effective skill for every input.
    let raw = js_max(0.0, js_min(200.0, v.finite_or(0.0)));
    // mutation: equivalent - at raw == 100 the milestone arm computes floor(100 + (100 - 100) * 0.25 + 0) = floor(100) = 100 = raw exactly, so `< 100.0` gives the same value at the one point where the two tests differ.
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
                // mutation: equivalent - m is never -0.0 (it starts at +0.0 and changes only by adding or subtracting finite values, which never yield -0 from +0), so at v == +-0 the added term leaves m unchanged, and `v >= 0.0` agrees with `v > 0.0` on the values that differ.
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

/// The stat keys `characterFromSave` copies (`src/save.js:246`).
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

/// `v ?? fallback` (null and undefined only, as the JS).
fn nullish(v: &Value, fallback: Value) -> Value {
    if v.is_nullish() {
        fallback
    } else {
        v.clone()
    }
}

/// `v || fallback` (JS truthiness: `''`, `0`, `NaN`, `null` and `false` take the fallback).
fn or_default(v: &Value, fallback: Value) -> Value {
    if v.truthy() {
        v.clone()
    } else {
        fallback
    }
}

/// `{ ...v }` (object spread): a new object of `v`'s own enumerable keys. A primitive spreads to `{}`, an array spreads
/// its indices, a string its UTF-16 units. One half of an astral character is a lone surrogate, which a `Value` cannot
/// hold, so that index is left out: the same undefined read as `Value::prop` on such a half (value.rs:278). The one
/// reader that could meet a spread string is `resolve_spells` (spells.rs), which keeps an object only with an `effects`
/// array; an index key never gives one, so a spell string resolves as the JS does (spells.js:103).
fn spread(v: &Value) -> Value {
    match v {
        Value::Obj(entries) => Value::Obj(entries.clone()),
        Value::Arr(items) => {
            let mut out = Value::Obj(Vec::new());
            for (i, item) in items.iter().enumerate() {
                out.set(&i.to_string(), item.clone());
            }
            out
        }
        Value::Str(s) => {
            let mut out = Value::Obj(Vec::new());
            for (i, unit) in s.encode_utf16().enumerate() {
                if let Ok(half) = String::from_utf16(&[unit]) {
                    out.set(&i.to_string(), Value::Str(half));
                }
            }
            out
        }
        _ => Value::Obj(Vec::new()),
    }
}

/// `Object.entries(v)` for the two kinds that are `typeof 'object'`: an object's own keys, an array's indices.
fn object_entries(v: &Value) -> Vec<(String, Value)> {
    match v {
        Value::Obj(entries) => entries.clone(),
        Value::Arr(items) => items
            .iter()
            .enumerate()
            .map(|(i, item)| (i.to_string(), item.clone()))
            .collect(),
        _ => Vec::new(),
    }
}

/// `typeof it === 'object'` (an array is one too; `null` is filtered by the callers' truthiness test).
fn is_object(v: &Value) -> bool {
    matches!(v, Value::Obj(_) | Value::Arr(_))
}

/// `it.group === 'Weapons'` (`src/save.js:264-268`).
fn is_weapon(it: &Value) -> bool {
    it.get("group").is_str("Weapons")
}

/// `it.templateIndex === 563`, the Hand Wraps template (`src/save.js:264-268`).
fn is_wraps(it: &Value) -> bool {
    is_weapon(it) && it.get("templateIndex").strict_eq(&Value::Num(563.0))
}

/// The character the model consumes (`characterFromSave`, `src/save.js:244-306`), from the save's plain object and the
/// caller's options. `opts.online` defaults to true (only `false` turns it off), `opts.martialPath` overrides the save's
/// path when present, and `opts.slot` / `opts.file` are the source's own metadata: the save object is never embedded in
/// the character (see AGENTS.md rule 11, Forge is not a save editor).
///
/// The worn list is the live equip table (`save.equipSlots`) when the save carries one, even an empty one; its entries
/// are the table's own records with `equipSlot: Number(key)` stamped on. Otherwise it is the save's `items` whose
/// `equipSlot` is a non-negative integer (packed pieces and stale marks drop out). The three folds follow that choice:
/// a live table re-folds the gear, a save carrying a live `_mods` keeps it (only an absent `stats`/`skills` defaults to
/// an empty object), and a raw save re-folds the gear. The rest is the model's reads: the softcapped stats and skills,
/// the active effects, the hands and `wraps`, the `legendaries` records and the two `_mods` / `_enchantMods` copies.
///
/// Nothing here mutates `save` or `opts`, and no field outside the ones the model reads is carried over.
pub fn character_from_save(save: &Value, opts: &Value) -> Value {
    let mut stats = Value::Obj(Vec::new());
    for k in STAT_KEYS {
        stats.set(k, Value::Num(save.get("stats").get(k).finite_or(0.0)));
    }
    let skills = Value::Arr(
        save.get("skills")
            .items()
            .iter()
            .map(|v| Value::Num(v.finite_or(0.0)))
            .collect(),
    );
    let items: Vec<Value> = save.get("items").items().iter().map(spread).collect();
    // A live snapshot carries the game's real equip table (`equip.slots`). The save's `items[].equipSlot` can be stale
    // or include packed pieces, so prefer the table: its item affixes are what the live Combat Stats card reads.
    let equip = save.get("equipSlots");
    let live_worn: Option<Vec<Value>> = if equip.truthy() && is_object(equip) {
        let mut out = Vec::new();
        for (slot, it) in object_entries(equip) {
            if !(it.truthy() && is_object(&it)) {
                continue;
            }
            let mut record = spread(&it);
            record.set("equipSlot", Value::Num(string_to_number(&slot)));
            out.push(record);
        }
        Some(out)
    } else {
        None
    };
    let worn: Vec<Value> = match &live_worn {
        Some(list) => list.clone(),
        None => items
            .iter()
            .filter(|it| match it.get("equipSlot") {
                Value::Num(n) => is_integer(*n) && *n >= 0.0,
                _ => false,
            })
            .cloned()
            .collect(),
    };
    let live = live_worn.is_some();
    let has_mods = live_worn.is_none() && save.get("_mods").truthy();
    let mods = if live {
        rebuild_mods(&Value::Arr(worn.clone()))
    } else if has_mods {
        let mut out = Value::Obj(Vec::new());
        out.set(
            "stats",
            nullish(save.get("_mods").get("stats"), Value::Obj(Vec::new())),
        );
        out.set(
            "skills",
            nullish(save.get("_mods").get("skills"), Value::Obj(Vec::new())),
        );
        out
    } else {
        rebuild_mods(&Value::Arr(items.clone()))
    };
    let mut legendaries = Vec::new();
    for it in &worn {
        if it.get("legendary").truthy() {
            let mut record = Value::Obj(Vec::new());
            record.set("id", it.get("legendary").clone());
            record.set("name", it.get("name").clone());
            legendaries.push(record);
        }
    }
    let wraps = worn.iter().find(|it| is_wraps(it)).cloned();
    // `it !== right` is JS identity: the same entry of the worn list, not an equal one, so the index is the identity.
    let right_index = worn
        .iter()
        .position(|it| {
            is_weapon(it)
                && !is_wraps(it)
                && it.get("equipSlot").strict_eq(&Value::Num(SLOT.right_hand))
        })
        .or_else(|| {
            worn.iter().position(|it| {
                is_weapon(it)
                    && !is_wraps(it)
                    && it.get("equipSlot").strict_eq(&Value::Num(SLOT.left_hand))
            })
        });
    let right = right_index.map(|i| worn[i].clone());
    let off_weapon = worn.iter().enumerate().find_map(|(i, it)| {
        let hand = it.get("equipSlot");
        let in_hand = hand.strict_eq(&Value::Num(SLOT.left_hand))
            || hand.strict_eq(&Value::Num(SLOT.right_hand));
        if Some(i) != right_index && is_weapon(it) && !is_wraps(it) && in_hand {
            Some(it.clone())
        } else {
            None
        }
    });
    let mut ch = Value::Obj(Vec::new());
    ch.set(
        "name",
        or_default(save.get("name"), Value::Str("Adventurer".to_owned())),
    );
    ch.set("level", Value::Num(save.get("level").finite_or(1.0)));
    ch.set("raceId", Value::Num(save.get("raceId").finite_or(0.0)));
    ch.set(
        "race",
        or_default(save.get("race"), Value::Str(String::new())),
    );
    ch.set(
        "gender",
        or_default(save.get("gender"), Value::Str(String::new())),
    );
    ch.set("career", nullish(save.get("career"), Value::Null));
    ch.set("reflexes", Value::Num(save.get("reflexes").finite_or(2.0)));
    let health = save.get("health").finite_or(1.0);
    ch.set("health", Value::Num(health));
    ch.set(
        "maxHealth",
        Value::Num(save.get("maxHealth").finite_or(js_max(1.0, health))),
    );
    ch.set(
        "magicka",
        Value::Num(nullish(save.get("magicka"), save.get("spellPoints").clone()).finite_or(0.0)),
    );
    ch.set(
        "maxMagicka",
        Value::Num(
            nullish(save.get("maxMagicka"), save.get("maxSpellPoints").clone()).finite_or(0.0),
        ),
    );
    // A lab fixture may hold a BASE instead of the save's live number; the fold is added where it is read.
    if let Value::Num(base) = save.get("maxMagickaBase") {
        if base.is_finite() {
            ch.set("maxMagickaBase", Value::Num(*base));
        }
    }
    ch.set(
        "spells",
        Value::Arr(
            save.get("spells")
                .items()
                .iter()
                .map(|sp| match sp {
                    Value::Num(_) => sp.clone(),
                    _ => spread(sp),
                })
                .collect(),
        ),
    );
    ch.set(
        "readiedSpellIndex",
        nullish(save.get("readiedSpellIndex"), Value::Null),
    );
    ch.set("stats", stats);
    ch.set("skills", skills);
    ch.set(
        "activeEffects",
        Value::Arr(
            save.get("activeEffects")
                .items()
                .iter()
                .map(spread)
                .collect(),
        ),
    );
    ch.set(
        "masterSkills",
        Value::Bool(save.get("masterSkills").strict_eq(&Value::Bool(true))),
    );
    ch.set(
        "masteredSkills",
        Value::Arr(save.get("masteredSkills").items().to_vec()),
    );
    let martial = if matches!(opts.get("martialPath"), Value::Undefined) {
        nullish(save.get("martialPath"), Value::Null)
    } else {
        opts.get("martialPath").clone()
    };
    ch.set("martialPath", martial);
    ch.set(
        "online",
        Value::Bool(!opts.get("online").strict_eq(&Value::Bool(false))),
    );
    ch.set("weapon", right.unwrap_or(Value::Null));
    ch.set("offWeapon", off_weapon.unwrap_or(Value::Null));
    ch.set("wraps", wraps.unwrap_or(Value::Null));
    ch.set("items", Value::Arr(items));
    ch.set("worn", Value::Arr(worn.clone()));
    let ch_mods = if live {
        let mut out = Value::Obj(Vec::new());
        out.set("stats", mods.get("stats").clone());
        out.set("skills", mods.get("skills").clone());
        out
    } else if has_mods {
        let mut out = spread(save.get("_mods"));
        out.set(
            "stats",
            spread(&nullish(
                save.get("_mods").get("stats"),
                Value::Obj(Vec::new()),
            )),
        );
        out.set(
            "skills",
            spread(&nullish(
                save.get("_mods").get("skills"),
                Value::Obj(Vec::new()),
            )),
        );
        out
    } else {
        let mut out = Value::Obj(Vec::new());
        out.set("stats", mods.get("stats").clone());
        out.set("skills", mods.get("skills").clone());
        out
    };
    ch.set("_mods", ch_mods);
    let enchant = save.get("_enchantMods");
    let ch_enchant = if enchant.truthy() {
        let mut out = spread(enchant);
        out.set(
            "skillMods",
            spread(&nullish(enchant.get("skillMods"), Value::Obj(Vec::new()))),
        );
        out
    } else {
        rebuild_enchant_mods(&Value::Arr(worn))
    };
    ch.set("_enchantMods", ch_enchant);
    ch.set("weaponDamagePct", mods.get("weaponDamagePct").clone());
    ch.set("slayer", mods.get("slayer").clone());
    ch.set("legendaries", Value::Arr(legendaries));
    ch.set("saveSlot", nullish(opts.get("slot"), Value::Null));
    ch.set("saveFile", nullish(opts.get("file"), Value::Null));
    ch
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
