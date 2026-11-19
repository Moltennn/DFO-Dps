//! The target builders of `src/target.js` (milestone R3b): `makeTarget` (:713), `enemyTarget` (:758), `standInTarget`
//! (:803), the private `mintedBody` (:669), `mintRow` (:640), and the helpers after `gearEnemy` in the file
//! (`materialRequirementMultiplier` :574, `targetGroupOf` :595, `enemyRowOf` :607, `careerIndexOf` :709,
//! `isClassEnemyOf` :710).
//!
//! The mint row comes from the generated table (`generated::mint_rows`, one row per boot code and classic id,
//! evaluated from the real `mintRow`), not from re-running the mods' edits: see `rust/README.md` (R3b).
//!
//! JS `undefined` against `null`: a `MakeFields` field that is `None` is an absent key, so `makeTarget`'s default
//! applies; `Some(None)` is a key present with `undefined` (the one place that matters: `minMetalToHit`, because the
//! spread of a body whose row lacks it overrides the default -1). Every other null and undefined reads the same.

use crate::boot::Boot;
use crate::generated::enemy_basics::{EnemyBasicsValue, ENEMY_BASICS};
use crate::generated::enemy_entity::KNIGHT_CITYWATCH_ID;
use crate::generated::enemy_groups::ENEMY_GROUPS;
use crate::generated::gate_boss::BOSS_ARMOR;
use crate::generated::mint_rows::{MintRowsValue, MINT_ROWS};
use crate::rolls::Rolls;
use crate::round::{fround, is_integer, js_min};
use crate::target::{Career, Effect, Item, Live, Target};
use crate::vendored::{enemy_career_index, enemy_entity_group, enemy_entity_type, EntityType};

/// A build the JS refuses (a RangeError, target.js:651-690, :770-773). The reason is not kept: the vectors record the
/// refusal and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refused;

/// `mintRow(mobileType, { boot })` (target.js:640-647): the row a foe of `mobileType` is minted from under `boot`. The
/// table holds every integer classic id under every boot code; any other id is `None` (the JS's null).
pub fn mint_row(mobile_type: f64, boot: &Boot) -> Option<&'static MintRowsValue> {
    if !is_integer(mobile_type) {
        return None;
    }
    let key = format!("{}/{}", boot.code(), mobile_type as i64);
    MINT_ROWS
        .iter()
        .find(|(k, _)| *k == key.as_str())
        .map(|(_, r)| r)
}

/// `wholeLevel(value)` (target.js:651-659): `None` for undefined or null; a whole number from 1 otherwise; anything else
/// is refused.
fn whole_level(v: Option<f64>) -> Result<Option<f64>, Refused> {
    match v {
        None => Ok(None),
        Some(n) if is_integer(n) && n >= 1.0 => Ok(Some(n)),
        Some(_) => Err(Refused),
    }
}

/// `skillsLevel(level)` (characters/enemy/enemyEntity.js:111-114) at every skill id 0..=34 (`skillsAtLevel`,
/// target.js:589-592): `min(100, level x 5 + 30)` for each.
pub fn skills_at_level(level: f64) -> Vec<(i64, f64)> {
    let s = level * 5.0 + 30.0;
    let s = if s > 100.0 { 100.0 } else { s };
    (0..35).map(|id| (id, s)).collect()
}

/// `targetStats(career)` (target.js:584-586): each stat the career's number when finite, else 50.
fn target_stats(career: Option<&Career>) -> [f64; 8] {
    let mut out = [50.0; 8];
    if let Some(c) = career {
        for (i, v) in c.stats.iter().enumerate() {
            if let Some(x) = v {
                if x.is_finite() {
                    out[i] = *x;
                }
            }
        }
    }
    out
}

/// What `mintedBody` returns (target.js:694-707), the fields a target is built from.
struct Body {
    mobile_type: f64,
    is_class: bool,
    career_index: f64,
    affinity: Option<&'static str>,
    group: Option<&'static str>,
    level: f64,
    stats: [f64; 8],
    skills: Vec<(i64, f64)>,
    armor_values: [f64; 7],
    min_metal_to_hit: Option<f64>,
    basics: &'static MintRowsValue,
}

/// `mintedBody(mobileType, { playerLevel, career, rolls, exactLevel, boot })` (target.js:669-707; the body of
/// `makeEnemyEntity`, enemyEntity.js:160-233). Private in the JS: reached through [`enemy_target`] and
/// [`stand_in_target`]. A class foe is minted at `player_level`; the City Watch knight adds `Range(3, 7)` from `rolls`
/// unless `exact_level`. A monster is minted at its row's level.
fn minted_body(
    mobile_type: f64,
    player_level: Option<f64>,
    career: Option<&Career>,
    rolls: Option<&mut dyn Rolls>,
    exact_level: bool,
    boot: &Boot,
) -> Result<Body, Refused> {
    let kind = enemy_entity_type(mobile_type);
    let is_class = kind == Some(EntityType::Class);
    if !is_integer(mobile_type) || (!is_class && kind != Some(EntityType::Monster)) {
        return Err(Refused);
    }
    let row = mint_row(mobile_type, boot).ok_or(Refused)?;
    let level = if is_class {
        let mut lv = whole_level(player_level)?.ok_or(Refused)?;
        if mobile_type == KNIGHT_CITYWATCH_ID && !exact_level {
            let r = rolls.ok_or(Refused)?;
            lv += 3.0 + (r.roll() * 4.0).floor();
        }
        lv
    } else {
        let lv = row.level.ok_or(Refused)?;
        if !is_integer(lv) || lv < 1.0 {
            return Err(Refused);
        }
        lv
    };
    let armor = if is_class {
        100.0
    } else {
        row.armor_value.unwrap_or(0.0) * 5.0
    };
    let career_index = enemy_career_index(mobile_type);
    let affinity = row.affinity;
    Ok(Body {
        mobile_type,
        is_class,
        career_index,
        affinity,
        group: target_group_of(Some(career_index), affinity, is_class),
        level,
        stats: target_stats(career),
        skills: skills_at_level(level),
        armor_values: [armor; 7],
        min_metal_to_hit: row.min_metal_to_hit,
        basics: row,
    })
}

/// The fields `makeTarget` takes (target.js:713-742). `None` is an absent key (the default applies); see the module doc
/// for `min_metal_to_hit`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MakeFields {
    pub is_player: Option<bool>,
    pub is_class: Option<bool>,
    pub level: Option<f64>,
    pub combat_level: Option<f64>,
    pub mobile_type: Option<f64>,
    pub career_index: Option<f64>,
    pub career: Option<Career>,
    pub affinity: Option<String>,
    pub group: Option<String>,
    pub stats: Option<[f64; 8]>,
    pub skills: Option<Vec<(i64, f64)>>,
    pub armor_values: Option<Vec<f64>>,
    pub equip_slots: Option<Vec<(f64, Item)>>,
    pub min_metal_to_hit: Option<Option<f64>>,
    pub spare_gear: Option<bool>,
    pub health: Option<f64>,
    pub max_health: Option<f64>,
    pub active_effects: Option<Vec<Effect>>,
    /// `_mods` as `(stats, statMax)`; a missing key is 0 (`?? 0`, save.js:178-179).
    pub mods: Option<([f64; 8], [f64; 8])>,
    pub basics: Option<&'static MintRowsValue>,
    pub relay_body: Option<bool>,
    pub level_source: Option<String>,
}

/// `makeTarget(fields)` (target.js:713-742): the defaults, then the given fields over them, then the combat level
/// (`combatLevel == null` takes the level).
pub fn make_target(f: MakeFields) -> Target {
    let level = f.level.unwrap_or(1.0);
    let has_career = f.career.is_some();
    let (stat_mods, stat_max) = f.mods.unwrap_or(([0.0; 8], [0.0; 8]));
    Target {
        is_player: f.is_player.unwrap_or(false),
        is_class: Some(f.is_class.unwrap_or(false)),
        career_index: Some(f.career_index.unwrap_or(-1.0)),
        career: f.career.unwrap_or_default(),
        has_career,
        level: Some(level),
        combat_level: Some(f.combat_level.unwrap_or(level)),
        mobile_type: f.mobile_type,
        affinity: f.affinity,
        group: f.group,
        live: Live {
            stats: f.stats.unwrap_or([50.0; 8]),
            active_effects: f.active_effects.unwrap_or_default(),
            stat_mods,
            stat_max,
        },
        armor_values: f.armor_values.unwrap_or_else(|| vec![0.0; 7]),
        equip_slots: f.equip_slots.unwrap_or_default(),
        skills: f.skills.unwrap_or_default(),
        min_metal_to_hit: f.min_metal_to_hit.unwrap_or(Some(-1.0)),
        spare_gear: f.spare_gear.unwrap_or(false),
        health: f.health.unwrap_or(100.0),
        max_health: f.max_health.unwrap_or(100.0),
        relay_body: f.relay_body,
        level_source: f.level_source,
        basics: f.basics,
    }
}

/// The options of `enemyTarget` (target.js:758-769). `None` is an absent option (the JS default applies).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EnemyOpts {
    /// `level`: the level asked (a monster's is an override, a class foe's is its player level).
    pub level: Option<f64>,
    /// `playerLevel`: the level a class foe is minted at.
    pub player_level: Option<f64>,
    /// `career`: the ENEMY*.CFG / CLASS*.CFG career the stats and the bytes come from.
    pub career: Option<Career>,
    /// `armorValues`: replaces the minted seven values.
    pub armor_values: Option<Vec<f64>>,
    /// `health` (default 100).
    pub health: Option<f64>,
    /// `maxHealth` (default: `health`).
    pub max_health: Option<f64>,
    /// `exactLevel`: the City Watch knight is not rolled up (enemyEntity.js:207).
    pub exact_level: bool,
}

/// `enemyTarget(mobileType, opts)` (target.js:758-792). `rolls` is the City Watch roll (enemyEntity.js:207); a knight
/// built without `exact_level` needs it. `boot` is the mods the body is minted under.
pub fn enemy_target(
    mobile_type: f64,
    o: &EnemyOpts,
    boot: &Boot,
    rolls: Option<&mut dyn Rolls>,
) -> Result<Target, Refused> {
    let asked = whole_level(o.level)?;
    let handed = whole_level(o.player_level)?;
    if let (Some(a), Some(h)) = (asked, handed) {
        if a != h {
            return Err(Refused);
        }
    }
    let given = asked.or(handed);
    let is_class = enemy_entity_type(mobile_type) == Some(EntityType::Class);
    let body = minted_body(
        mobile_type,
        if is_class { given } else { Some(1.0) },
        o.career.as_ref(),
        rolls,
        o.exact_level,
        boot,
    )?;
    let is_override = !is_class && given.is_some_and(|g| g != body.level);
    let level = match given {
        Some(g) if is_override => g,
        _ => body.level,
    };
    let level_source = if is_class {
        "player"
    } else if is_override {
        "override"
    } else {
        "mint"
    };
    let skills = if is_override {
        skills_at_level(level)
    } else {
        body.skills.clone()
    };
    let health = o.health.unwrap_or(100.0);
    Ok(make_target(MakeFields {
        is_class: Some(body.is_class),
        level: Some(level),
        mobile_type: Some(body.mobile_type),
        career_index: Some(body.career_index),
        career: o.career,
        affinity: body.affinity.map(str::to_owned),
        group: body.group.map(str::to_owned),
        stats: Some(body.stats),
        skills: Some(skills),
        armor_values: Some(
            o.armor_values
                .clone()
                .unwrap_or_else(|| body.armor_values.to_vec()),
        ),
        min_metal_to_hit: Some(body.min_metal_to_hit),
        spare_gear: Some(false),
        health: Some(health),
        max_health: Some(o.max_health.unwrap_or(health)),
        basics: Some(body.basics),
        level_source: Some(level_source.to_owned()),
        ..MakeFields::default()
    }))
}

/// `standInTarget(mobileType, { boot })` (target.js:803-812): the relay's boss body. Minted at player level 1 with no
/// career and the roll fixed at 0.5 (target.js:804), then every metal bites (`minMetalToHit` 0), BOSS_ARMOR on every
/// part, no wear (`spareGear`), and the relay-body flag.
pub fn stand_in_target(mobile_type: f64, boot: &Boot) -> Result<Target, Refused> {
    let mut half = || 0.5_f64;
    let roll: &mut dyn Rolls = &mut half;
    let body = minted_body(mobile_type, Some(1.0), None, Some(roll), false, boot)?;
    Ok(make_target(MakeFields {
        is_class: Some(body.is_class),
        level: Some(body.level),
        mobile_type: Some(body.mobile_type),
        career_index: Some(body.career_index),
        affinity: body.affinity.map(str::to_owned),
        group: body.group.map(str::to_owned),
        stats: Some(body.stats),
        skills: Some(body.skills.clone()),
        armor_values: Some(vec![BOSS_ARMOR; 7]),
        min_metal_to_hit: Some(Some(0.0)),
        spare_gear: Some(true),
        basics: Some(body.basics),
        relay_body: Some(true),
        level_source: Some("mint".to_owned()),
        ..MakeFields::default()
    }))
}

/// `materialRequirementMultiplier(target, weapon, { soft })` (target.js:574-582; pcaao.js:1640-1700). A weapon below
/// the target's metal takes `min(0.2 x (need - material), 0.9)` off; `soft` false refuses the blow whole (0).
/// `min` is `target.minMetalToHit` (`None`: undefined, which `Number()` reads as NaN). `weapon` is `None` for a JS
/// null weapon (1); `Some(material)` is a weapon whose material is `None` when absent (NaN).
pub fn material_requirement_multiplier(
    min: Option<f64>,
    weapon: Option<Option<f64>>,
    soft: bool,
) -> f64 {
    let Some(material) = weapon else {
        return 1.0;
    };
    let need = min.unwrap_or(f64::NAN);
    let material = material.unwrap_or(f64::NAN);
    if !need.is_finite() || !material.is_finite() || need < 0.0 || need <= material {
        return 1.0;
    }
    if !soft {
        return 0.0;
    }
    let penalty = js_min(fround((need - material) * fround(0.2)), fround(0.9));
    fround(1.0 - penalty)
}

/// `targetGroupOf({ careerIndex, affinity, isClass })` (target.js:595-603): a class or a Human is `humanoid`; otherwise
/// the career's group by its name (`animal` for Animals), or none. `career_index` `None` is the default -1.
pub fn target_group_of(
    career_index: Option<f64>,
    affinity: Option<&str>,
    is_class: bool,
) -> Option<&'static str> {
    if is_class || affinity == Some("Human") {
        return Some("humanoid");
    }
    let g = enemy_entity_group(career_index.unwrap_or(-1.0));
    let e = ENEMY_GROUPS;
    if g == e.undead {
        Some("undead")
    } else if g == e.daedra {
        Some("daedra")
    } else if g == e.humanoid {
        Some("humanoid")
    } else if g == e.animals {
        Some("animal")
    } else {
        None
    }
}

/// `enemyRowOf(mobileType)` (target.js:607): the shipped table's row for a mobile type (before any boot edit).
pub fn enemy_row_of(mobile_type: f64) -> Option<&'static EnemyBasicsValue> {
    if !is_integer(mobile_type) {
        return None;
    }
    ENEMY_BASICS
        .iter()
        .find(|(k, _)| *k as f64 == mobile_type)
        .map(|(_, r)| r)
}

/// `careerIndexOf(mobileType)` (target.js:709): `enemyCareerIndex(Number(mobileType))`.
pub fn career_index_of(mobile_type: f64) -> f64 {
    enemy_career_index(mobile_type)
}

/// `isClassEnemyOf(mobileType)` (target.js:710): the mobile type is a class (128..=146).
pub fn is_class_enemy_of(mobile_type: f64) -> bool {
    enemy_entity_type(mobile_type) == Some(EntityType::Class)
}
