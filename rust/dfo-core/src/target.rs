//! The pure half of `src/target.js` (milestone R3a): the target as the hit path sees it. Resistances and the
//! elemental share, the enemy-type bonus, silver and the Skeletal Warrior, the monster hide, the worn armour and the
//! shield, and the per-part outcomes a blow resolves to.
//!
//! Ported in JS order from `src/target.js:53-523` (R3a), with `liveStat` from `src/save.js:167-181` and `NUM` from
//! `src/save.js:107`. The rest of the file is R3b: the builders and the gear are in `mint.rs` and `gear.rs`, and
//! `equip_armour_with` takes the RRI switches for the custom armour classes (see `rust/README.md`, R3b).
//!
//! The target value: each struct keeps only the fields these functions read, and its doc names the JS property.
//! JS `undefined` and `null` are `None`, except where the JS tests the value itself (`=== false`, `??`, `!!`); the
//! doc of each field says which. A JS value that is not a number, or a string where a number is read, is not
//! representable; the vectors never pass one (the README lists it). Every rounding and clamp is [`crate::round`]'s.

use crate::boot::RriSwitches;
use crate::generated::armor_materials::SHIELD_PARTS;
use crate::generated::data::{PCAAO_BODY_PARTS, SKILLS, STRUCK_BODY_PARTS};
use crate::generated::enemy_groups::ENEMY_GROUPS;
use crate::generated::paperdoll::EQUIP_SLOTS;
use crate::generated::pcaao::{PCAAO_REDUCTION_ROWS, SILVER_DOUBLED_CAREERS};
use crate::round::{
    finite_or, fround, is_integer, js_clamp, js_max, js_min, math_round, or_default, to_int32,
    trunc, unity_round,
};
use crate::vendored::{
    armor_body_parts_with, career_attack_modifier, condition_percentage, enemy_armor_values_with,
    enemy_entity_group, is_shield_template, item_armor_value, silver_doubles, slot_for_body_part,
    ArmourPieceRef,
};

/// The career flag bytes `careerTolerance` tests (`EFFECT_FLAGS`, target.js:73-75). Each is one bit.
pub const PARALYSIS: f64 = 1.0;
pub const MAGIC: f64 = 2.0;
pub const POISON: f64 = 4.0;
pub const FIRE: f64 = 8.0;
pub const FROST: f64 = 16.0;
pub const SHOCK: f64 = 32.0;
pub const DISEASE: f64 = 64.0;

/// Classic spell element index -> its flag (target.js:77-79): fire, frost, poison, shock, magic.
pub const ELEMENT_FLAG_BY_INDEX: [f64; 5] = [FIRE, FROST, POISON, SHOCK, MAGIC];

/// `careerTolerance`'s answer (target.js:94-102).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tolerance {
    Normal,
    Resistant,
    Immune,
    LowTolerance,
    CriticalWeakness,
}

/// The stat names `liveStat` is asked for (target.js:57-60 `STAT_KEYS`). The discriminant is the index of the
/// stat in [`Live::stats`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stat {
    Strength = 0,
    Intelligence = 1,
    Willpower = 2,
    Agility = 3,
    Endurance = 4,
    Personality = 5,
    Speed = 6,
    Luck = 7,
}

impl Stat {
    /// The stat a name is (`a.stat === name` in save.js compares names). Any other string is `None`.
    pub fn from_name(name: &str) -> Option<Stat> {
        Some(match name {
            "strength" => Stat::Strength,
            "intelligence" => Stat::Intelligence,
            "willpower" => Stat::Willpower,
            "agility" => Stat::Agility,
            "endurance" => Stat::Endurance,
            "personality" => Stat::Personality,
            "speed" => Stat::Speed,
            "luck" => Stat::Luck,
            _ => return None,
        })
    }
}

/// One of `ch.activeEffects` as `liveStat` reads it (save.js:170-177). The kinds that read no stat are `Other`.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// `disease`, `poison`, `artifact`: each stat's `statMods` value is added (`?? 0`, so a missing one is 0).
    StatMods { ended: bool, stat_mods: [f64; 8] },
    /// `racialOverride`: a stat's `statMods` value is added only when it is above 0.
    RacialOverride { ended: bool, stat_mods: [f64; 8] },
    /// `fortifyAttribute` on `stat` (`a.stat`, `None` when it names no stat): `magnitude` (`?? 0`) is added.
    Fortify {
        ended: bool,
        stat: Option<Stat>,
        magnitude: f64,
    },
    /// `drainAttribute` or `transferAttribute` on `stat`: `magnitude` (`?? 0`) is taken away.
    Drain {
        ended: bool,
        stat: Option<Stat>,
        magnitude: f64,
    },
    /// Any other kind (`spellShield` and the rest). It reads no stat, but `ended` is read for every kind: liveStat
    /// skips an ended effect before it looks at the kind (save.js:171).
    Other { ended: bool },
}

impl Effect {
    fn ended(&self) -> bool {
        match self {
            Effect::StatMods { ended, .. }
            | Effect::RacialOverride { ended, .. }
            | Effect::Fortify { ended, .. }
            | Effect::Drain { ended, .. }
            | Effect::Other { ended } => *ended,
        }
    }
}

/// What `liveStat(ch, name)` reads from an entity (save.js:167-181): the base `stats`, the `activeEffects`, and the
/// gear's `_mods` (`stats` and `statMax`). A base stat that is missing or not finite reads 0 (`NUM`), so a missing
/// base is stored as NaN. A mod that is missing reads 0 (`?? 0`), so it is stored as 0.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Live {
    /// `stats[name]`, indexed by [`Stat`] (NaN for a JS missing key).
    pub stats: [f64; 8],
    /// `activeEffects`.
    pub active_effects: Vec<Effect>,
    /// `_mods.stats[name]` (0 when `_mods` or the key is absent, as `?? 0` reads it).
    pub stat_mods: [f64; 8],
    /// `_mods.statMax[name]` (0 when absent).
    pub stat_max: [f64; 8],
}

/// The career fields the target reads (`career`, from ENEMY*.CFG / CLASS*.CFG in the game). A JS `null` career
/// and a career object that lacks the field read the same here, so each missing field is `None`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Career {
    /// `career.resistanceFlags`.
    pub resistance_flags: Option<f64>,
    /// `career.immunityFlags`.
    pub immunity_flags: Option<f64>,
    /// `career.lowToleranceFlags`.
    pub low_tolerance_flags: Option<f64>,
    /// `career.criticalWeaknessFlags`.
    pub critical_weakness_flags: Option<f64>,
    /// `career.attackModifierFlags` (read for an attacker, see [`attack_modifier_flags_of`]).
    pub attack_modifier_flags: Option<f64>,
    /// `career.weaponArmorShieldsBitfield` (R3b: the forbidden armour of the DEX copy, dexEquipment.js:83-89).
    pub weapon_armor_shields_bitfield: Option<f64>,
    /// `career.strength` .. `career.luck` (R3b: `targetStats`, target.js:584-586, in [`Stat`] order). `None` is a
    /// missing key, which `targetStats` reads as the default 50.
    pub stats: [Option<f64>; 8],
}

/// A worn piece, as the fields the armour functions read (an `item` in JS).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Item {
    /// `item.group === 'Armor'`. Every other group compares unequal to 'Armor', so one bit is enough here.
    pub is_armor: bool,
    /// `item.templateIndex`.
    pub template_index: Option<f64>,
    /// `item.material`.
    pub material: Option<f64>,
    /// `item.artifact` (JS truthiness).
    pub artifact: bool,
    /// `item.maxCondition`.
    pub max_condition: Option<f64>,
    /// `item.currentCondition`.
    pub current_condition: Option<f64>,
}

/// A weapon, as the functions read it (the `weapon` argument of the damage functions).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Weapon {
    /// `weapon.skillId`, compared with `SKILLS.BluntWeapon`.
    pub skill_id: Option<f64>,
    /// `weapon.material` (silver is 2).
    pub material: Option<f64>,
    /// `weapon.flags` (bit 0x10 is set on a weapon that is not an edged one for the Skeletal Warrior).
    pub flags: Option<f64>,
    /// `weapon.item?.flags`: the flags of the item the weapon wraps, read when `flags` is absent. Flattened
    /// here, because the functions read nothing else of `item`.
    pub item_flags: Option<f64>,
}

/// A struck body part's target: the fields the target functions read (`makeTarget`'s shape, target.js:713-742).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Target {
    /// `isPlayer` (JS truthiness). Every builder sets it.
    pub is_player: bool,
    /// `isClass`. The JS tests it with `=== false` (intrinsic damage, the target part path), so `None` (undefined)
    /// and `Some(false)` are different; `!!isClass` (equipArmour) reads both as false.
    pub is_class: Option<bool>,
    /// `careerIndex`. `None` is undefined or null, and the JS reads it with `??` or `!= null`.
    pub career_index: Option<f64>,
    /// `career`.
    pub career: Career,
    /// `level`, read by the enemy-type bonus only through `combatLevel ?? level`.
    pub level: Option<f64>,
    /// `combatLevel`.
    pub combat_level: Option<f64>,
    /// `stats`, `activeEffects` and `_mods`, read by `liveStat`.
    pub live: Live,
    /// `armorValues`: the struck-part values (seven, from makeTarget). `[0]` is read by equipArmour.
    pub armor_values: Vec<f64>,
    /// `equip.slots`: the worn piece in each slot id. A JS key whose value is null or undefined is not worn, so
    /// only the worn pieces are listed. An empty list is both `slots` absent and `slots` empty.
    pub equip_slots: Vec<(f64, Item)>,
    /// Whether `career` is an object (R3b). A JS `null` career has no fields, so `career` is then the default.
    pub has_career: bool,
    /// `mobileType` (`None` is undefined or null).
    pub mobile_type: Option<f64>,
    /// `affinity` (`None` is null or undefined).
    pub affinity: Option<String>,
    /// `group` (the target group a career names; `None` is null).
    pub group: Option<String>,
    /// `skills`: the (skill id, level) pairs of the object, in id order (`{}` is empty).
    pub skills: Vec<(i64, f64)>,
    /// `minMetalToHit`. `None` is undefined (`Number(undefined)` is NaN in `materialRequirementMultiplier`).
    pub min_metal_to_hit: Option<f64>,
    /// `spareGear` (JS truthiness).
    pub spare_gear: bool,
    /// `health`.
    pub health: f64,
    /// `maxHealth`.
    pub max_health: f64,
    /// `relayBody` (`Some(true)` for a relay stand-in; `None` is undefined).
    pub relay_body: Option<bool>,
    /// `levelSource`: `player`, `override` or `mint` (`None` is undefined).
    pub level_source: Option<String>,
    /// `basics`: the enemy row the body was minted from (`mintRow`'s row). `None` is undefined.
    pub basics: Option<&'static crate::generated::mint_rows::MintRowsValue>,
}

/// The attacker of the enemy-type bonus: the player's build (target.js:143, `attacker`). A JS `null` attacker is a
/// `{ stats: { willpower: 50 } }` (target.js:147), which [`enemy_type_bonus_range`] takes as `None`.
#[derive(Debug, Clone, PartialEq)]
pub struct Attacker {
    /// The attacker's `stats`, `activeEffects` and `_mods`.
    pub live: Live,
    /// `attackModifierFlags`, read before the career's.
    pub attack_modifier_flags: Option<f64>,
    /// `career`, for `career.attackModifierFlags` when the attacker's own is absent.
    pub career: Career,
}

/// `DFCareer.GetTolerance` over the four flag bytes (target.js:94-102; spellcast.js:61-68): `Resistant`, then
/// `Immune`, `LowTolerance`, `CriticalWeakness`, each tested as `((byte ?? 0) & flag) === flag`. A zero or NaN
/// flag is `Normal` (`!flag`).
pub fn career_tolerance(career: &Career, flag: f64) -> Tolerance {
    if flag == 0.0 || flag.is_nan() {
        return Tolerance::Normal;
    }
    let has = |byte: Option<f64>| (to_int32(byte.unwrap_or(0.0)) & to_int32(flag)) as f64 == flag;
    if has(career.resistance_flags) {
        Tolerance::Resistant
    } else if has(career.immunity_flags) {
        Tolerance::Immune
    } else if has(career.low_tolerance_flags) {
        Tolerance::LowTolerance
    } else if has(career.critical_weakness_flags) {
        Tolerance::CriticalWeakness
    } else {
        Tolerance::Normal
    }
}

/// `ELEMENT_FLAG_BY_NAME[name]` (target.js:81-87), lower-cased first (`String(element).toLowerCase()`). A name that
/// is none of the five, JS prototype names included, has no flag.
fn element_flag_by_name(lower: &str) -> Option<f64> {
    match lower {
        "fire" => Some(FIRE),
        "frost" => Some(FROST),
        "shock" => Some(SHOCK),
        "poison" => Some(POISON),
        "magic" => Some(MAGIC),
        _ => None,
    }
}

/// `elementShare(target, element)` (target.js:106-111; loot powers :164-167): what a weapon's elemental line deals
/// to the target: 0 when the target is immune to the element, 0.5 when it resists it, else 1. An element with no
/// flag (any name but the five) is 1; a missing element (JS `null`/`undefined`) reads as `''`, also no flag.
pub fn element_share(target: Option<&Target>, element: Option<&str>) -> f64 {
    let lower = element.unwrap_or("").to_lowercase();
    let Some(flag) = element_flag_by_name(&lower) else {
        return 1.0;
    };
    let career = target.map(|t| t.career).unwrap_or_default();
    match career_tolerance(&career, flag) {
        Tolerance::Immune => 0.0,
        Tolerance::Resistant => 0.5,
        _ => 1.0,
    }
}

/// `liveStat(ch, name)` (save.js:167-181): the stat after the active effects and the gear's mods, clamped to
/// `0..=100 + statMax`. A base that is missing or not finite reads 0 (`NUM`).
pub fn live_stat(live: &Live, name: Stat) -> f64 {
    let i = name as usize;
    let base = finite_or(live.stats[i], 0.0);
    let mut m = 0.0;
    for a in &live.active_effects {
        if a.ended() {
            continue;
        }
        match a {
            Effect::StatMods { stat_mods, .. } => m += stat_mods[i],
            Effect::RacialOverride { stat_mods, .. } => {
                if stat_mods[i] > 0.0 {
                    m += stat_mods[i];
                }
            }
            Effect::Fortify {
                stat, magnitude, ..
            } => {
                if *stat == Some(name) {
                    m += magnitude;
                }
            }
            Effect::Drain {
                stat, magnitude, ..
            } => {
                if *stat == Some(name) {
                    m -= magnitude;
                }
            }
            Effect::Other { .. } => {}
        }
    }
    m += live.stat_mods[i];
    let max_mod = js_max(0.0, live.stat_max[i]);
    js_max(0.0, js_min(100.0 + max_mod, base + m))
}

/// `naturalDamageResistance(target)` (target.js:113-120; combat/pcaao.js:1594-1605): Endurance, Strength and
/// Willpower above 50 each give a share of the damage (x0.002, x0.001, x0.001), summed in float32. No target is 0.
pub fn natural_damage_resistance(target: Option<&Target>) -> f64 {
    let Some(t) = target else {
        return 0.0;
    };
    let s = |stat: Stat| live_stat(&t.live, stat);
    let mut n = fround((s(Stat::Endurance) - 50.0) * fround(0.002));
    n = fround(n + fround((s(Stat::Strength) - 50.0) * fround(0.001)));
    n = fround(n + fround((s(Stat::Willpower) - 50.0) * fround(0.001)));
    n
}

/// `enemyTypeGroup(target)` (target.js:128-131): a player is Humanoid; any other target is its career's group
/// (`enemyEntityGroup(careerIndex ?? -1)`), not its affinity or class flag.
pub fn enemy_type_group(target: Option<&Target>) -> f64 {
    if target.is_some_and(|t| t.is_player) {
        return ENEMY_GROUPS.humanoid;
    }
    enemy_entity_group(target.and_then(|t| t.career_index).unwrap_or(-1.0))
}

/// `attackModifierFlagsOf(attacker)` (target.js:134-135): `attacker.attackModifierFlags ?? attacker.career
/// .attackModifierFlags ?? null`.
pub fn attack_modifier_flags_of(attacker: Option<&Attacker>) -> Option<f64> {
    attacker.and_then(|a| a.attack_modifier_flags.or(a.career.attack_modifier_flags))
}

/// What `enemyTypeBonusRange` returns (target.js:143-152).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BonusRange {
    /// The target's enemy-type group.
    pub group: f64,
    /// The attacker's bonus/phobia decoded for that group: 1 bonus, -1 phobia, 0 none.
    pub decoded: f64,
    /// The range of the bonus roll: `max(10 + will - trunc(level / 2), 0)`.
    pub bonus: f64,
    /// The phobia penalty: `max(trunc(level / 2) - will, 0)`.
    pub penalty: f64,
    /// The attacker's Willpower bonus: `trunc((willpower - 50) / 5)`.
    pub will: f64,
    /// The target's level for the bonus: `Number(combatLevel ?? level ?? 1) || 1`.
    pub target_level: f64,
}

/// `enemyTypeBonusRange(attacker, target)` (target.js:143-152). A missing attacker is the player at Willpower 50.
pub fn enemy_type_bonus_range(attacker: Option<&Attacker>, target: Option<&Target>) -> BonusRange {
    let group = enemy_type_group(target);
    let decoded = match attack_modifier_flags_of(attacker) {
        Some(flags) if group != ENEMY_GROUPS.none => career_attack_modifier(flags, group),
        _ => 0.0,
    };
    let willpower = match attacker {
        Some(a) => live_stat(&a.live, Stat::Willpower),
        None => 50.0,
    };
    let will = trunc((willpower - 50.0) / 5.0);
    let target_level = or_default(
        target
            .and_then(|t| t.combat_level.or(t.level))
            .unwrap_or(1.0),
        1.0,
    );
    let half = trunc(target_level / 2.0);
    BonusRange {
        group,
        decoded,
        bonus: js_max(10.0 + will - half, 0.0),
        penalty: js_max(half - will, 0.0),
        will,
        target_level,
    }
}

/// `enemyTypeBonusValue(attacker, target, roll01)` (target.js:156-161): `floor(roll01 x bonus)` for a bonus (0 when
/// the range is empty), the fixed `-penalty` for a phobia, else 0.
pub fn enemy_type_bonus_value(
    attacker: Option<&Attacker>,
    target: Option<&Target>,
    roll01: f64,
) -> f64 {
    let r = enemy_type_bonus_range(attacker, target);
    if r.decoded == 1.0 {
        if r.bonus > 0.0 {
            (roll01 * r.bonus).floor()
        } else {
            0.0
        }
    } else if r.decoded == -1.0 {
        0.0 - r.penalty
    } else {
        0.0
    }
}

/// `enemyTypeBonusValues(attacker, target)` (target.js:164-169): every value the bonus roll can take, each equally
/// likely: `0..bonus` for a bonus, `[-penalty]` for a phobia, `[0]` otherwise.
pub fn enemy_type_bonus_values(attacker: Option<&Attacker>, target: Option<&Target>) -> Vec<f64> {
    let r = enemy_type_bonus_range(attacker, target);
    if r.decoded == 1.0 {
        if r.bonus > 0.0 {
            (0..r.bonus as i64).map(|i| i as f64).collect()
        } else {
            vec![0.0]
        }
    } else if r.decoded == -1.0 {
        vec![0.0 - r.penalty]
    } else {
        vec![0.0]
    }
}

/// The Skeletal Warrior's career (target.js:123).
const SKELETAL_WARRIOR_INDEX: f64 = 15.0;

/// `isSkeletalTarget(target)` (target.js:178): the Skeletal Warrior's career.
pub fn is_skeletal_target(target: Option<&Target>) -> bool {
    target.and_then(|t| t.career_index) == Some(SKELETAL_WARRIOR_INDEX)
}

/// `silverApplies(target, weapon)` (target.js:179-182): silver (material 2) doubles against the six silver careers
/// and the Skeletal Warrior. A player target, a weapon of another material, or a missing target or weapon never
/// doubles.
pub fn silver_applies(target: Option<&Target>, weapon: Option<&Weapon>) -> bool {
    let (Some(t), Some(w)) = (target, weapon) else {
        return false;
    };
    if t.is_player || w.material != Some(2.0) || !silver_doubles() {
        return false;
    }
    is_skeletal_target(Some(t))
        || t.career_index
            .is_some_and(|c| SILVER_DOUBLED_CAREERS.contains(&c))
}

/// `skeletalSilverDamage(damage, target, weapon)` (target.js:183-193): a Skeletal Warrior halves a weapon whose
/// flags lack 0x10, then silver doubles it; any other silver target just doubles. A player or no weapon is the
/// damage as it is.
pub fn skeletal_silver_damage(
    damage: f64,
    target: Option<&Target>,
    weapon: Option<&Weapon>,
) -> f64 {
    let (Some(t), Some(w)) = (target, weapon) else {
        return damage;
    };
    if t.is_player {
        return damage;
    }
    if is_skeletal_target(Some(t)) {
        let flags = w.flags.or(w.item_flags).unwrap_or(0.0);
        let mut d = if (to_int32(flags) & 0x10) == 0 {
            trunc(damage / 2.0)
        } else {
            damage
        };
        if silver_applies(Some(t), Some(w)) {
            d *= 2.0;
        }
        return d;
    }
    if silver_applies(Some(t), Some(w)) {
        return damage * 2.0;
    }
    damage
}

/// `monsterHideDamage(target, damage, bluntWep, naturalDamResist, exact)` (target.js:200-229; combat/pcaao.js
/// `pcaaoPercentageReductionCalculationForMonsters`): the innate hide of a monster that wears nothing on the struck
/// part, by its career group. The result includes natural resistance. `nat` of `None` is
/// `naturalDamageResistance(target)` (the JS default). `exact` skips the defensive round (the carried mean).
pub fn monster_hide_damage(
    target: Option<&Target>,
    damage: f64,
    blunt: bool,
    nat: Option<f64>,
    exact: bool,
) -> f64 {
    let nat = nat.unwrap_or_else(|| natural_damage_resistance(target));
    let r = |m: f64| {
        let v = fround(damage * fround(fround(m) - nat));
        if exact {
            v
        } else {
            unity_round(v)
        }
    };
    let c = target.and_then(|t| t.career_index).unwrap_or(f64::NAN);
    let group = enemy_entity_group(c);
    let g = ENEMY_GROUPS;
    // Each arm picks the multiplier the JS returns through `r`; `r` is pure, so one call at the end is the same.
    let mult = if group == g.animals {
        1.0
    } else if group == g.undead {
        if c == 15.0 {
            0.8
        } else {
            1.0
        }
    } else if group == g.humanoid {
        if c == 22.0 {
            if blunt {
                1.21
            } else {
                0.71
            }
        } else if c == 2.0 {
            if blunt {
                0.66
            } else {
                1.26
            }
        } else {
            1.0
        }
    } else if group == g.daedra {
        if c == 27.0 {
            0.95
        } else if c == 25.0 {
            if blunt {
                1.04
            } else {
                0.84
            }
        } else if c == 31.0 {
            0.95
        } else {
            1.0
        }
    } else if group == g.none {
        if c == 38.0 {
            if blunt {
                1.4
            } else {
                1.0
            }
        } else if c == 36.0 {
            if blunt {
                0.6
            } else {
                0.9
            }
        } else {
            1.0
        }
    } else {
        1.0
    };
    r(mult)
}

/// `intrinsicDamage(target, damage, { weapon, exact })` (target.js:238-250): a gearless target's damage. A monster
/// (`isClass === false` with a career) takes its hide; any other target takes natural resistance alone. A damage
/// that is not above 0, or a missing target, is returned as it is.
pub fn intrinsic_damage(
    target: Option<&Target>,
    damage: f64,
    weapon: Option<&Weapon>,
    exact: bool,
) -> f64 {
    if damage.is_nan() || damage <= 0.0 {
        return damage;
    }
    let Some(t) = target else {
        return damage;
    };
    let natural = natural_damage_resistance(Some(t));
    let blunt = weapon.is_some_and(|w| w.skill_id == Some(SKILLS.blunt_weapon));
    if t.is_class == Some(false) && t.career_index.is_some() {
        return monster_hide_damage(Some(t), damage, blunt, Some(natural), exact);
    }
    let v = fround(damage * fround(1.0 - natural));
    if exact {
        v
    } else {
        unity_round(v)
    }
}

/// `armourMaterialId(item)` (target.js:272-291; combat/pcaao.js:657-688): a non-shield piece's material value
/// halved (truncated); a shield by its own material (leather 1 .. daedric 10). No item is 1.
pub fn armour_material_id(item: Option<&Item>) -> f64 {
    let Some(it) = item else {
        return 1.0;
    };
    if !is_shield_template(it.template_index) {
        return trunc(item_armor_value(Some(it)) / 2.0);
    }
    let m = it.material.unwrap_or(0.0);
    if m == 0.0 {
        1.0
    } else if m == 256.0 || m == 259.0 {
        2.0
    } else if m == 512.0 {
        3.0
    } else if m == 513.0 || m == 514.0 {
        4.0
    } else if m == 515.0 {
        5.0
    } else if m == 516.0 {
        6.0
    } else if m == 517.0 || m == 518.0 {
        7.0
    } else if m == 519.0 {
        8.0
    } else if m == 520.0 {
        9.0
    } else if m == 521.0 {
        10.0
    } else {
        1.0
    }
}

/// `armourConditionMultiplier(item, { sharpEdge })` (target.js:296-308; combat/pcaao.js:627-648): worn armour
/// reduces less as it wears. Without `sharpEdge`, a piece at 76% or better is 1.
pub fn armour_condition_multiplier(item: Option<&Item>, sharp_edge: bool) -> f64 {
    if item.is_none() {
        return 1.0;
    }
    let pct = condition_percentage(item);
    if pct >= 76.0 && !sharp_edge {
        return 1.0;
    }
    if pct >= 92.0 {
        fround(0.85)
    } else if pct >= 76.0 {
        fround(0.95)
    } else if pct >= 61.0 {
        1.0
    } else if pct >= 41.0 {
        fround(1.1)
    } else if pct >= 16.0 {
        fround(1.2)
    } else if pct >= 6.0 {
        fround(1.35)
    } else if pct <= 5.0 {
        fround(1.5)
    } else {
        1.0
    }
}

/// How a blow strikes: its natural resistance, whether it is blunt, whether it is unarmed, and the sharp-edge flag.
/// `natural` defaults to 0, as the JS does for `armourReduction` and `shieldReduction`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Strike {
    pub natural: f64,
    pub blunt: bool,
    pub unarmed: bool,
    pub sharp_edge: bool,
}

/// `reduce(damage, base, cap, cond, nat)` (target.js:261-262; pcaao.js:1139-1146): one row's reduction. Every term is
/// float32 and the result is Mathf.Round (half to even).
fn reduce(damage: f64, base: f64, cap: f64, cond: f64, nat: f64) -> f64 {
    let limit = fround(js_min(fround(base * cond), fround(cap)));
    let x = fround(limit - nat);
    unity_round(fround(damage * x))
}

/// `table(rows, material, damage, cond, nat)` (target.js:265-268): the row for a material, or `1/1` outside the
/// ladder (`rows[material]` is a JS lookup by key).
fn table(rows: &[(i64, &[f64])], material: f64, damage: f64, cond: f64, nat: f64) -> f64 {
    match rows.iter().find(|(k, _)| *k as f64 == material) {
        Some((_, row)) => reduce(damage, row[0], row[1], cond, nat),
        None => reduce(damage, 1.0, 1.0, cond, nat),
    }
}

/// The equip slot's worn piece, if any (`slots[slot]`).
fn slot_item(target: &Target, slot: f64) -> Option<&Item> {
    target
        .equip_slots
        .iter()
        .find(|(s, _)| *s == slot)
        .map(|(_, item)| item)
}

/// `armourReduction(item, damage, opts)` (target.js:313-316; pcaao.js:1268-1299): a strike against a worn piece.
/// The unarmed, blunt or edged row of the piece's material.
pub fn armour_reduction(item: Option<&Item>, damage: f64, s: Strike) -> f64 {
    let rows = if s.unarmed {
        PCAAO_REDUCTION_ROWS.unarmed_rows
    } else if s.blunt {
        PCAAO_REDUCTION_ROWS.blunt_rows
    } else {
        PCAAO_REDUCTION_ROWS.edged_rows
    };
    table(
        rows,
        armour_material_id(item),
        damage,
        armour_condition_multiplier(item, s.sharp_edge),
        s.natural,
    )
}

/// `shieldReduction(shield, damage, opts)` (target.js:319-323; pcaao.js:1259-1275): the blocking shield's own row.
pub fn shield_reduction(shield: Option<&Item>, damage: f64, s: Strike) -> f64 {
    let rows = if s.unarmed {
        PCAAO_REDUCTION_ROWS.shield_unarmed_rows
    } else if s.blunt {
        PCAAO_REDUCTION_ROWS.shield_blunt_rows
    } else {
        PCAAO_REDUCTION_ROWS.shield_edged_rows
    };
    table(
        rows,
        armour_material_id(shield),
        damage,
        armour_condition_multiplier(shield, s.sharp_edge),
        s.natural,
    )
}

/// `struckSlotItem(target, part)` (target.js:326-331; pcaao.js:192-196): the piece the equip table wears on a body
/// part, if any. A part with no slot (`EQUIP_SLOTS.None`) has no piece.
pub fn struck_slot_item(target: Option<&Target>, part: f64) -> Option<&Item> {
    let t = target?;
    let slot = slot_for_body_part(part);
    if slot == EQUIP_SLOTS.none {
        return None;
    }
    slot_item(t, slot)
}

/// `leftHandShield(target)` (target.js:335-338; pcaao.js:201-205): the LEFT HAND's piece when it is an Armor-group
/// shield, else `None`. A weapon in that hand never blocks.
pub fn left_hand_shield(target: Option<&Target>) -> Option<&Item> {
    let item = slot_item(target?, EQUIP_SLOTS.left_hand)?;
    (item.is_armor && is_shield_template(item.template_index)).then_some(item)
}

/// `hasWornEquipment(target)` (target.js:341-346): whether any equip slot holds a piece.
pub fn has_worn_equipment(target: Option<&Target>) -> bool {
    target.is_some_and(|t| !t.equip_slots.is_empty())
}

/// `pcaaoShieldBlockChanceCalculation` (target.js:348-388; pcaao.js:1519-1570): the integer block percentage before
/// the dice. A strong spot (a part the shield covers) uses the shield's base bent by agility, speed, strength,
/// endurance, willpower and luck; a weak spot its smaller base. The C# clamps are discarded upstream, so none apply.
pub fn shield_block_chance(target: &Target, strong_spot: bool, shield: Option<&Item>) -> f64 {
    let (strong, weak) = match shield.and_then(|s| s.template_index) {
        Some(109.0) => (30.0, 20.0),
        Some(110.0) => (35.0, 10.0),
        Some(111.0) => (45.0, 5.0),
        Some(112.0) => (55.0, -5.0),
        _ => (40.0, 0.0),
    };
    let d = |k: Stat| live_stat(&target.live, k) - 50.0;
    let steps: [(f64, f64); 6] = if strong_spot {
        [
            (d(Stat::Agility), 0.3),
            (d(Stat::Speed), 0.3),
            (d(Stat::Strength), 0.3),
            (d(Stat::Endurance), 0.2),
            (d(Stat::Willpower), 0.1),
            (d(Stat::Luck), 0.1),
        ]
    } else {
        [
            (d(Stat::Agility), 0.3),
            (d(Stat::Speed), 0.2),
            (d(Stat::Strength), 0.2),
            (d(Stat::Endurance), 0.1),
            (d(Stat::Willpower), 0.1),
            (d(Stat::Luck), 0.1),
        ]
    };
    let mut n = fround(if strong_spot { strong } else { weak });
    for (stat, k) in steps {
        n = fround(n + fround(stat * fround(k)));
    }
    unity_round(n)
}

/// `pcaaoCompareShieldToUnderArmor` (target.js:393-402; pcaao.js:1573-1590): the shield reduces only when its average
/// over a nominal 100 is at least as good as the piece under it (bare skin reduces by natural resistance alone).
pub fn shield_beats_under_armour(
    target: Option<&Target>,
    part: f64,
    nat: Option<f64>,
    sharp_edge: bool,
) -> bool {
    let nat = nat.unwrap_or_else(|| natural_damage_resistance(target));
    let Some(shield) = left_hand_shield(target) else {
        return false;
    };
    let shield_left = table(
        PCAAO_REDUCTION_ROWS.average_shield_rows,
        armour_material_id(Some(shield)),
        100.0,
        armour_condition_multiplier(Some(shield), sharp_edge),
        nat,
    );
    let under_left = match struck_slot_item(target, part) {
        Some(under) => table(
            PCAAO_REDUCTION_ROWS.average_armor_rows,
            armour_material_id(Some(under)),
            100.0,
            armour_condition_multiplier(Some(under), sharp_edge),
            nat,
        ),
        None => unity_round(fround(100.0 * fround(1.0 - nat))),
    };
    shield_left <= under_left
}

/// One outcome of a struck part: its probability and the whole-number damage it leaves (target.js:404-436).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Outcome {
    pub p: f64,
    pub damage: f64,
}

fn whole(damage: f64) -> Vec<Outcome> {
    vec![Outcome { p: 1.0, damage }]
}

/// `targetPartOutcomes(target, damage, part, { weapon, sharpEdge })` (target.js:416-436): one struck body part's
/// damage after the defence, as the outcomes a blow can produce, each with its probability. A shield block is
/// rolled first (`dice100(chance)`): a block gives the shield's row, a miss gives the worn piece, else the hide,
/// else natural resistance. Everything after this (the relay cap, the off hand) acts on each outcome, not on the mean.
pub fn target_part_outcomes(
    target: Option<&Target>,
    damage: f64,
    part: f64,
    weapon: Option<&Weapon>,
    sharp_edge: bool,
) -> Vec<Outcome> {
    if damage.is_nan() || damage <= 0.0 {
        return whole(damage);
    }
    let Some(t) = target else {
        return whole(damage);
    };
    let natural = natural_damage_resistance(Some(t));
    let blunt = weapon.is_some_and(|w| w.skill_id == Some(SKILLS.blunt_weapon));
    let strike = Strike {
        natural,
        blunt,
        unarmed: weapon.is_none(),
        sharp_edge,
    };
    let under = match struck_slot_item(Some(t), part) {
        Some(armour) => armour_reduction(Some(armour), damage, strike),
        None if t.is_class == Some(false) && !t.is_player => {
            monster_hide_damage(Some(t), damage, blunt, Some(natural), false)
        }
        None => unity_round(fround(damage * fround(1.0 - natural))),
    };
    let Some(shield) = left_hand_shield(Some(t)) else {
        return whole(under);
    };
    let strong = shield_parts_of(shield.template_index).contains(&part);
    let chance = shield_block_chance(t, strong, Some(shield));
    let p = js_clamp(chance, 0.0, 100.0) / 100.0;
    if p <= 0.0 || !shield_beats_under_armour(Some(t), part, Some(natural), sharp_edge) {
        return whole(under);
    }
    let blocked = shield_reduction(Some(shield), damage, strike);
    if p >= 1.0 {
        return whole(blocked);
    }
    vec![
        Outcome { p, damage: blocked },
        Outcome {
            p: 1.0 - p,
            damage: under,
        },
    ]
}

/// The parts a shield covers (`SHIELD_PARTS.get(template) ?? []`, armorMaterials.js:68-73).
fn shield_parts_of(template: Option<f64>) -> &'static [f64] {
    let Some(t) = template else {
        return &[];
    };
    SHIELD_PARTS
        .iter()
        .find(|(k, _)| *k == t)
        .map(|(_, parts)| *parts)
        .unwrap_or(&[])
}

/// `targetPartDamage` (target.js:442-445): the expectation of [`target_part_outcomes`]. Only for a display, since
/// the hit path acts on the outcomes, never on this mean.
pub fn target_part_damage(
    target: Option<&Target>,
    damage: f64,
    part: f64,
    weapon: Option<&Weapon>,
    sharp_edge: bool,
) -> f64 {
    let o = target_part_outcomes(target, damage, part, weapon, sharp_edge);
    if o.len() == 1 {
        o[0].damage
    } else {
        o[0].p * o[0].damage + o[1].p * o[1].damage
    }
}

/// `targetExpectedDamage(target, damage, { weapon, weights, map })` (target.js:449-475): the expectation over the
/// body-part weights (`weights[part] ?? 0`, a zero or NaN weight is skipped). `map`, if given, maps each part's
/// post-defence damage (the off hand's share, for example). The result is `None` where the JS returns `null` (no
/// part had a weight). With no worn piece on any part, every part answers the same integer, which is returned
/// exactly, so the weighted sum's float error cannot move a later round.
pub fn target_expected_damage(
    target: Option<&Target>,
    damage: f64,
    weapon: Option<&Weapon>,
    weights: &[f64],
    map: Option<&dyn Fn(f64) -> f64>,
) -> Option<f64> {
    let Some(t) = target else {
        return Some(damage);
    };
    if damage.is_nan() || damage <= 0.0 {
        return Some(damage);
    }
    let mut sum = 0.0;
    let mut first: Option<f64> = None;
    let mut uniform = true;
    for part in 0..7 {
        let w = weights.get(part).copied().unwrap_or(0.0);
        if w == 0.0 || w.is_nan() {
            continue;
        }
        let v = target_part_damage(Some(t), damage, part as f64, weapon, false);
        match first {
            None => first = Some(v),
            Some(f) => {
                if v != f {
                    uniform = false;
                }
            }
        }
        sum += w * v;
    }
    if uniform {
        return match (map, first) {
            (Some(m), Some(f)) => Some(m(f)),
            _ => first,
        };
    }
    if let Some(m) = map {
        let mut mapped = 0.0;
        for part in 0..7 {
            let w = weights.get(part).copied().unwrap_or(0.0);
            if w == 0.0 || w.is_nan() {
                continue;
            }
            mapped += w * m(target_part_damage(
                Some(t),
                damage,
                part as f64,
                weapon,
                false,
            ));
        }
        return Some(mapped);
    }
    Some(sum)
}

/// The `core` argument of `bodyPartWeights` (target.js:478-485): `'overhaul'` (the default) or any other core.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Core {
    #[default]
    Overhaul,
    Other,
}

/// `bodyPartWeights(core)` (target.js:478-485): each struck part's share of the list (the overhaul's PCAAO list, or
/// the classic STRUCK list). Seven weights, one per part; `counts[part]++` over the list, divided by its length.
pub fn body_part_weights(core: Core) -> Vec<f64> {
    match core {
        Core::Overhaul => part_weights(PCAAO_BODY_PARTS),
        Core::Other => part_weights(STRUCK_BODY_PARTS),
    }
}

/// The share of a body-part list each part has (`new Array(7).fill(0)`, `counts[part]++`, then `/ length`). Every
/// listed part is an integer in 0..=6 (asserted by the generated tables' use here).
fn part_weights(parts: &[f64]) -> Vec<f64> {
    let mut counts = [0.0; 7];
    for part in parts {
        debug_assert!(is_integer(*part) && (0.0..7.0).contains(part));
        counts[*part as usize] += 1.0;
    }
    counts.iter().map(|n| n / parts.len() as f64).collect()
}

/// `equipArmour(target, pieces, { armorValues })` (target.js:503-523) for pieces that are already minted items (an
/// Armor-group item passes through unchanged; the descriptor path minted them, R3b). Each piece goes to the slot its
/// body part names (a shield to the left hand), if that slot is empty. With `armor_values`, the struck-part
/// `armorValues` are recomputed from the pieces (`enemyArmorValues`, :516-520).
pub fn equip_armour(target: &mut Target, pieces: &[Item], armor_values: bool) {
    equip_armour_with(target, pieces, armor_values, None);
}

/// [`equip_armour`] with the RRI switches the custom armour classes read (`None`: the classic table alone, as R3a).
pub fn equip_armour_with(
    target: &mut Target,
    pieces: &[Item],
    armor_values: bool,
    rri: Option<&RriSwitches>,
) {
    let mut slots = target.equip_slots.clone();
    let mut armour_pieces: Vec<ArmourPieceRef> = Vec::new();
    for item in pieces {
        let shield = is_shield_template(item.template_index);
        let slot = if shield {
            EQUIP_SLOTS.left_hand
        } else {
            match armor_body_parts_with(Some(item), rri).first() {
                Some(part) => slot_for_body_part(*part),
                None => EQUIP_SLOTS.none,
            }
        };
        if slot == EQUIP_SLOTS.none || slots.iter().any(|(s, _)| *s == slot) {
            continue;
        }
        slots.push((slot, *item));
        armour_pieces.push(ArmourPieceRef {
            piece: item.template_index,
            material: item.material,
            shield,
        });
    }
    target.equip_slots = slots;
    if armor_values {
        let armor = target.armor_values.first().copied().unwrap_or(0.0);
        let is_class = target.is_class == Some(true);
        target.armor_values =
            enemy_armor_values_with(is_class, armor, &armour_pieces, rri).to_vec();
    }
}

/// The condition `armourPiece` writes (target.js:489-493), given the minted maximum:
/// `max(0, min(max, Math.round(max x clamp(condition, 0, 1))))`. The minter that gives `max` is R3b.
pub fn armour_piece_current(max: Option<f64>, condition: f64) -> f64 {
    let max = max.unwrap_or(0.0);
    js_max(
        0.0,
        js_min(max, math_round(max * js_clamp(condition, 0.0, 1.0))),
    )
}
