//! The theory-character builders (`src/theory.js`). These saves have one synthetic
//! right-hand item at most, explicit mods, and always use the online save rules.
use crate::generated::data::{SKILLS, WEAPONS};
pub use crate::generated::theory::*;
use crate::sockets::perfect_sockets;
use crate::value::{
    obj_table_get,
    Value::{self, Arr, Bool, Null, Num, Obj, Str, Undefined},
};

pub(crate) fn s(text: &str) -> Value {
    Str(text.to_owned())
}

/// The points the gear's percent cap needs on this shipped build, or `None` when it has no percent cap
/// (`theory.js:50-53`).
pub fn gear_mastery_points(game_build: &str) -> Option<f64> {
    if game_build == "14631" {
        None
    } else {
        Some(GEAR_MASTERY_POINTS)
    }
}

/// The gear-mastery row of the cap sheet, per shipped build (`theory.js:56-70`): `14512` is the
/// `min(320, gear x 0.44)` percent, `14631` the flat roll add with no cap. The rest of the sheet is
/// build-independent.
pub fn theory_caps(game_build: &str) -> Vec<TheoryCapsItem> {
    // `14631` swaps the gear row for the shipped build's; every other string is the frozen `14512` table
    // (`theory.js:56-70`, whose `GEAR_CAPS[14512]` row is that table's own).
    if game_build != "14631" {
        return THEORY_CAPS.to_vec();
    }
    let Some((_, gear)) = GEAR_CAPS.iter().find(|(id, _)| *id == 14631) else {
        return THEORY_CAPS.to_vec();
    };
    THEORY_CAPS
        .iter()
        .map(|c| {
            if c.channel == "Gear Long Blade" {
                TheoryCapsItem {
                    channel: c.channel,
                    cap: gear.cap,
                    formula: gear.formula,
                    note: c.note,
                }
            } else {
                *c
            }
        })
        .collect()
}

pub(crate) fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

pub(crate) fn default(v: &Value, fallback: Value) -> Value {
    if matches!(v, Undefined) {
        fallback
    } else {
        v.clone()
    }
}

pub(crate) fn nullish(v: &Value, fallback: Value) -> Value {
    if v.is_nullish() {
        fallback
    } else {
        v.clone()
    }
}

pub(crate) fn add(a: &Value, b: &Value) -> Value {
    if matches!(a, Str(_) | Obj(_) | Arr(_)) || matches!(b, Str(_) | Obj(_) | Arr(_)) {
        Str(a.to_js_string() + &b.to_js_string())
    } else {
        Num(a.to_number() + b.to_number())
    }
}

fn entries(v: &Value) -> Vec<(String, Value)> {
    match v {
        Arr(xs) => xs
            .iter()
            .cloned()
            .enumerate()
            .map(|(i, x)| (i.to_string(), x))
            .collect(),
        _ => v.entries().to_vec(),
    }
}

fn firmament(lines: &Value, skill: bool) -> Value {
    let mut out = Obj(vec![]);
    for (key, v) in entries(lines) {
        let n = v.finite_or(0.0);
        if n == 0.0 {
            continue;
        }
        let key = if skill {
            let id = s(&key).to_number();
            if !(0.0..35.0).contains(&id) || id.fract() != 0.0 {
                continue;
            }
            Num(id).to_js_string()
        } else {
            key
        };
        if key != "__proto__" {
            out.set(&key, Num(n.clamp(-15.0, 15.0)));
        }
    }
    out
}

fn affix(id: &str, value: Value) -> Value {
    obj([("id", s(id)), ("value", value)])
}

fn hand_item(name: &str, template: Value, material: Value, condition: f64) -> Value {
    obj([
        ("name", s(name)),
        ("group", s("Weapons")),
        ("templateIndex", template),
        ("material", material),
        ("maxCondition", Num(condition)),
        ("currentCondition", Num(condition)),
        ("equipSlot", Num(19.0)),
    ])
}

pub fn theory_character(opts: &Value) -> Result<Value, String> {
    let blade = default(opts.get("blade"), Num(DEFAULT_BLADE));
    let template = Num(blade.to_number());
    let weapon = obj_table_get(WEAPONS, &template).ok_or_else(|| {
        format!(
            "theory expects a melee weapon template, got {}",
            blade.to_js_string()
        )
    })?;
    let mut item = hand_item(
        weapon.name,
        template,
        default(opts.get("material"), Num(9.0)),
        100.0,
    );
    let dmg = opts.get("damagePct");
    item.set(
        "affixes",
        Arr(if dmg.to_number() > 0.0 {
            vec![affix("damage", dmg.clone())]
        } else {
            vec![]
        }),
    );
    item.set("sockets", Arr(opts.get("sockets").items().to_vec()));
    Ok(build(opts, false, item))
}

pub fn theory_fists(opts: &Value) -> Value {
    build(opts, true, Null)
}

fn build(opts: &Value, fists: bool, item: Value) -> Value {
    let races = THEORY_RACES;
    let races = [
        ("breton", races.breton),
        ("redguard", races.redguard),
        ("nord", races.nord),
        ("darkelf", races.darkelf),
        ("highelf", races.highelf),
        ("woodelf", races.woodelf),
        ("khajiit", races.khajiit),
        ("argonian", races.argonian),
    ];
    let race = default(opts.get("race"), s("darkelf"));
    let race_id = match race {
        Num(n) => n,
        _ => {
            let key = race.to_js_string().to_lowercase();
            races
                .iter()
                .find(|(name, _)| *name == key)
                .map_or(THEORY_RACES.darkelf, |(_, id)| *id)
        }
    };
    let race_name = races
        .iter()
        .find(|(_, id)| *id == race_id)
        .map_or("Dark Elf", |(name, _)| *name);
    let own = if fists {
        SKILLS.hand_to_hand
    } else {
        SKILLS.long_blade
    };
    let crit = SKILLS.critical_strike;
    let back = SKILLS.backstabbing;
    let mastered = [own, crit, back];
    let mut skills = vec![Num(100.0); 35];
    for (id, key) in mastered.into_iter().zip([
        if fists { "rawH2H" } else { "rawBlade" },
        "rawCrit",
        "rawBackstab",
    ]) {
        skills[id as usize] = Num(default(opts.get(key), Num(200.0)).finite_or(0.0));
    }
    let stats = THEORY_STATS;
    let stats = obj([
        ("strength", Num(stats.strength)),
        ("intelligence", Num(stats.intelligence)),
        ("willpower", Num(stats.willpower)),
        ("agility", Num(stats.agility)),
        ("endurance", Num(stats.endurance)),
        ("personality", Num(stats.personality)),
        ("speed", Num(stats.speed)),
        ("luck", Num(stats.luck)),
    ]);
    let firm_stats = firmament(opts.get("starStats"), false);
    let firm_max = Obj(firm_stats
        .entries()
        .iter()
        // mutation: equivalent - firmament drops both signed zeros and never clamps a nonzero finite input to zero.
        .filter(|(_, v)| v.to_number() > 0.0)
        .cloned()
        .collect());
    let mut skill_mods = firmament(opts.get("starSkills"), true);
    for (id, key) in [
        (own, if fists { "gearH2H" } else { "gearLB" }),
        (crit, if fists { "gearCrit" } else { "gearCS" }),
    ] {
        let id = Num(id).to_js_string();
        skill_mods.set(
            &id,
            add(
                &nullish(skill_mods.get(&id), Num(0.0)),
                &default(opts.get(key), Num(0.0)),
            ),
        );
    }
    let active = if opts.get("vampire").truthy() {
        vec![obj([
            ("kind", s("racialOverride")),
            ("racial", s("vampirism")),
            (
                "skillMods",
                obj([
                    (&Num(SKILLS.hand_to_hand).to_js_string(), Num(30.0)),
                    (&Num(crit).to_js_string(), Num(30.0)),
                ]),
            ),
        ])]
    } else {
        vec![]
    };
    let items = Arr(if fists { vec![] } else { vec![item.clone()] });
    let is_wrap = item.get("templateIndex").strict_eq(&Num(563.0));
    let wraps = opts.get("wraps");
    let equipped_wraps = fists && wraps.truthy();
    let (weapon, wrap) = if is_wrap {
        (Null, item)
    } else if equipped_wraps {
        (
            Null,
            if matches!(wraps, Arr(_) | Obj(_)) {
                wraps.clone()
            } else {
                hand_wraps()
            },
        )
    } else {
        (item, Null)
    };
    obj([
        (
            "name",
            s(if equipped_wraps {
                "Level 45 theory fists (wraps)"
            } else if fists {
                "Level 45 theory fists"
            } else {
                "Level 45 theory long blade"
            }),
        ),
        (
            "level",
            Num(default(opts.get("level"), Num(THEORY_LEVEL)).finite_or(1.0)),
        ),
        ("raceId", Num(Num(race_id).finite_or(0.0))),
        ("race", s(race_name)),
        ("gender", s("male")),
        (
            "career",
            obj([
                ("name", s(if fists { "Hand-to-Hand" } else { "Longblade" })),
                (
                    "weaponArmorShieldsBitfield",
                    Num(if fists { 262144.0 } else { 131072.0 }),
                ),
                ("abilityFlagsAndSpellPointsBitfield", Num(0.0)),
                ("attackModifierFlags", Num(0.0)),
            ]),
        ),
        ("reflexes", Num(2.0)),
        ("health", Num(700.0)),
        ("maxHealth", Num(700.0)),
        ("magicka", Num(0.0)),
        ("maxMagicka", Num(0.0)),
        ("spells", Arr(vec![])),
        ("readiedSpellIndex", Null),
        ("stats", stats),
        ("skills", Arr(skills)),
        ("activeEffects", Arr(active)),
        ("masterSkills", Bool(true)),
        (
            "masteredSkills",
            Arr(mastered.into_iter().map(Num).collect()),
        ),
        (
            "martialPath",
            if fists {
                Null
            } else {
                nullish(opts.get("martialPath"), Null)
            },
        ),
        ("online", Bool(true)),
        ("weapon", weapon),
        ("offWeapon", Null),
        ("wraps", wrap),
        ("items", items.clone()),
        ("worn", items),
        (
            "_mods",
            obj([
                ("stats", firm_stats),
                ("statMax", firm_max),
                ("skills", skill_mods),
            ]),
        ),
        (
            "_enchantMods",
            obj([("skillMods", Obj(vec![])), ("chanceToHitMod", Num(0.0))]),
        ),
        ("weaponDamagePct", Undefined),
        ("slayer", Undefined),
        ("legendaries", Arr(vec![])),
        ("saveSlot", Null),
        ("saveFile", Null),
        (
            "firmamentDamagePct",
            Num(opts.get("starDamage").finite_or(0.0).clamp(-20.0, 30.0)),
        ),
    ])
}

fn hand_wraps() -> Value {
    let t = Num(563.0);
    let mut item = hand_item("Hand Wraps", t.clone(), Num(0.0), 400.0);
    item.set(
        "affixes",
        Arr(vec![
            affix("damage", Num(40.0)),
            obj([
                ("id", s("elemental")),
                ("param", s("fire")),
                ("value", Num(10.0)),
            ]),
        ]),
    );
    item.set("sockets", Arr(perfect_sockets(&t)));
    item.set(
        "enchantments",
        Arr(vec![obj([("type", Num(2.0)), ("param", Num(25.0))])]),
    );
    item
}

pub fn theory_blade(
    character: &Value,
    template: &Value,
    material: &Value,
) -> Result<Value, String> {
    let mut c = crate::analyze::json_clone(character);
    let weapon = obj_table_get(WEAPONS, template)
        .ok_or_else(|| format!("unknown weapon template {}", template.to_js_string()))?;
    let mut item = Obj(entries(c.get("weapon")));
    item.set("name", s(weapon.name));
    item.set("templateIndex", template.clone());
    item.set("material", default(material, Num(9.0)));
    item.set(
        "affixes",
        Arr(c
            .get("weapon")
            .get("affixes")
            .items()
            .iter()
            .filter(|a| a.get("id").is_str("damage"))
            .cloned()
            .collect()),
    );
    item.set("sockets", Arr(perfect_sockets(template)));
    c.set("weapon", item.clone());
    c.set("items", Arr(vec![item.clone()]));
    c.set("worn", Arr(vec![item]));
    Ok(c)
}
