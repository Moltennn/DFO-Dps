//! The small vendored helpers that `src/target.js` calls (milestone R3a), ported as functions. Tables come
//! from `crate::generated` (written by `tools/rust-data.mjs`); each function cites the vendored line it ports.
//!
//! Registries. The vendored modules let a mod register an answer: `registerEnemyGroup` (combat/enemyGroups.js:64),
//! `registerSilverDoubleVeto` (combat/formulas.js:466), `registerCustomArmorValue` (systems/armorMaterials.js:111),
//! the custom enemy careers (characters/enemy/customEnemies.js:20) and the custom item classes (rriItems.js). On
//! the import path `src/target.js` reaches, nothing registers one (`installEnemyExpansion` is the only caller of
//! `registerEnemyGroup`, and it is not run at import), so each registry is modelled as EMPTY. The one built-in
//! table is `RRI_CLASSES` (rriItems.js:581), whose keys are 513..=526 only: `customItemClass` answers for those
//! ids alone, so the armour helpers below are exact for every template id outside 513..=526 (the vectors stay
//! there; see `rust/README.md`).
//!
//! JS `undefined` is `None`. A JS career index that is `undefined` is passed as NaN where a lookup is made, since
//! no table key equals NaN and no key is `undefined` (the same miss in JS).

use crate::generated::armor_materials::{
    ARMOR_MATERIAL, BODY_PARTS, PLATE_ARMOR_VALUES, SHIELD_PARTS, SHIELD_VALUES,
};
use crate::generated::enemy_equipment::{
    PIECE_BODY_PART, SHIELD_PARTS as ENEMY_SHIELD_PARTS, SHIELD_VALUE as ENEMY_SHIELD_VALUE,
};
use crate::generated::enemy_groups::{ENEMY_GROUPS, ENEMY_GROUP_BY_CAREER};
use crate::generated::equip::{EQUIP_SLOT_NAMES, SLOT_FOR_BODY_PART};
use crate::generated::equip_rules::SLOT_RULES;
use crate::generated::formulas::GROUP_BITS;
use crate::generated::paperdoll::EQUIP_SLOTS;
use crate::round::{is_integer, to_int32, trunc};
use crate::target::Item;

/// `careerAttackModifier(attackModifierFlags, group)` (combat/formulas.js:191-197): +1 when the group's bonus bit
/// is set in `flags`, else -1 when its phobia bit is set (bonus first), else 0. A group with no bit pair is 0.
pub fn career_attack_modifier(flags: f64, group: f64) -> f64 {
    let Some((bonus, phobia)) = group_bits(group) else {
        return 0.0;
    };
    if (to_int32(flags) & to_int32(bonus)) as f64 == bonus {
        1.0
    } else if (to_int32(flags) & to_int32(phobia)) as f64 == phobia {
        -1.0
    } else {
        0.0
    }
}

/// `GROUP_BITS[group]` (formulas.js:178): the `[bonus, phobia]` pair of an integer group, else nothing.
fn group_bits(group: f64) -> Option<(f64, f64)> {
    if !is_integer(group) || group < 0.0 {
        return None;
    }
    GROUP_BITS.get(group as usize).copied()
}

/// `silverDoubles(target)` (combat/formulas.js:468-471): silver doubles unless a registered veto answers true.
/// No veto is registered on this path (see the module doc), so it always doubles.
pub fn silver_doubles() -> bool {
    true
}

/// `enemyEntityGroup(careerIndex)` (combat/enemyGroups.js:69-75) with no mod group registered: the table's group
/// for the career, else `ENEMY_GROUPS.None`.
pub fn enemy_entity_group(career_index: f64) -> f64 {
    ENEMY_GROUP_BY_CAREER
        .iter()
        .find(|(k, _)| *k as f64 == career_index)
        .map_or(ENEMY_GROUPS.none, |(_, g)| *g)
}

/// The shield's value for a shield template (armorMaterials.js:62-67 `SHIELD_VALUES`), else `None`.
fn shield_value(template: Option<f64>) -> Option<f64> {
    let t = template?;
    SHIELD_VALUES.iter().find(|(k, _)| *k == t).map(|(_, v)| *v)
}

/// `isShieldTemplate(templateIndex)` (armorMaterials.js:74): one of the four shield templates.
pub fn is_shield_template(template: Option<f64>) -> bool {
    shield_value(template).is_some()
}

/// `materialArmorValue(material)` (armorMaterials.js:53-58): leather 3, chain 6 (Chain or Chain2), plate
/// 7..21 by metal, else 0. A plate metal is `material - 0x200` up to Daedric (`plateMetal`, :41); a value past it,
/// or a non-integer metal, reads `undefined ?? 0`, so it is 0.
pub fn material_armor_value(material: f64) -> f64 {
    if material == ARMOR_MATERIAL.leather {
        3.0
    } else if material == ARMOR_MATERIAL.chain || material == ARMOR_MATERIAL.chain2 {
        6.0
    } else if material >= ARMOR_MATERIAL.iron {
        plate_armor_value(material)
    } else {
        0.0
    }
}

fn plate_armor_value(material: f64) -> f64 {
    let metal = material - ARMOR_MATERIAL.iron;
    if material > ARMOR_MATERIAL.daedric || !is_integer(metal) {
        return 0.0;
    }
    PLATE_ARMOR_VALUES
        .get(metal as usize)
        .copied()
        .unwrap_or(0.0)
}

/// `itemArmorValue(item)` (armorMaterials.js:114-123) with no custom armour value registered. A shield (an
/// Armor-group item of a shield template) is its own value and is never halved; any other item is its material's
/// value, halved (truncated) when it is an artifact of the Armor group. A material that is absent is Leather.
/// `None` is the JS `undefined` item, which reads as leather.
pub fn item_armor_value(item: Option<&Item>) -> f64 {
    let armor = item.is_some_and(|i| i.is_armor);
    let template = item.and_then(|i| i.template_index);
    if armor && is_shield_template(template) {
        return shield_value(template).unwrap_or(0.0);
    }
    let material = item
        .and_then(|i| i.material)
        .unwrap_or(ARMOR_MATERIAL.leather);
    let result = material_armor_value(material);
    if armor && item.is_some_and(|i| i.artifact) {
        trunc(result / 2.0)
    } else {
        result
    }
}

/// `slotForBodyPart(part)` (systems/equip.js:496): the equip slot a body part's armour is worn in, else `None`.
/// The table is the probed inverse map of `SLOT_BODY_PART` (see `tools/rust-data.mjs`, the `equip` source).
pub fn slot_for_body_part(part: f64) -> f64 {
    SLOT_FOR_BODY_PART
        .iter()
        .find(|(p, _)| *p as f64 == part)
        .map_or(EQUIP_SLOTS.none, |(_, s)| *s)
}

/// The equip slot's name for an `EQUIP_SLOTS` key (the names SLOT_RULES holds), else `None`.
fn equip_slot_by_name(name: &str) -> Option<f64> {
    EQUIP_SLOT_NAMES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, id)| *id)
}

/// The body part a worn slot covers, the inverse of [`slot_for_body_part`] (`SLOT_BODY_PART.get(slot)`).
fn body_part_of_slot(slot: f64) -> Option<f64> {
    SLOT_FOR_BODY_PART
        .iter()
        .find(|(_, s)| *s == slot)
        .map(|(p, _)| *p as f64)
}

/// `armorSlotRule(templateIndex).slot` (systems/equip.js:436) for a classic armour template: the slot name in
/// SLOT_RULES.Armor. (A custom class's slot comes first in JS; no custom class answers here, see the module doc.)
fn armor_slot_name(template: Option<f64>) -> Option<&'static str> {
    let t = template?;
    SLOT_RULES
        .armor
        .iter()
        .find(|(k, _)| *k as f64 == t)
        .map(|(_, rule)| rule.slot)
}

/// `armorBodyParts(item)` (systems/equip.js:452-458): the body parts an Armor-group piece covers. A shield covers
/// its SHIELD_PARTS; any other piece covers the one part its slot maps to, and nothing when that is no part.
pub fn armor_body_parts(item: Option<&Item>) -> Vec<f64> {
    let Some(item) = item else {
        return Vec::new();
    };
    if !item.is_armor {
        return Vec::new();
    }
    let template = item.template_index;
    if is_shield_template(template) {
        return shield_parts(template).to_vec();
    }
    let part = armor_slot_name(template)
        .and_then(equip_slot_by_name)
        .and_then(body_part_of_slot);
    part.map_or_else(Vec::new, |p| vec![p])
}

/// The parts a shield covers (armorMaterials.js:68-73 `SHIELD_PARTS`), else none (`?? []`).
fn shield_parts(template: Option<f64>) -> &'static [f64] {
    let Some(t) = template else {
        return &[];
    };
    SHIELD_PARTS
        .iter()
        .find(|(k, _)| *k == t)
        .map(|(_, parts)| *parts)
        .unwrap_or(&[])
}

/// `conditionPercentage(item)` (systems/item/itemTemplates.js:277-278): `trunc(100 * current / max)` when the
/// maximum is above 0 (`item.maxCondition ?? 0`), else 100. An absent current condition reads 0.
pub fn condition_percentage(item: Option<&Item>) -> f64 {
    let max = item.and_then(|i| i.max_condition).unwrap_or(0.0);
    if max > 0.0 {
        let current = item.and_then(|i| i.current_condition).unwrap_or(0.0);
        trunc((100.0 * current) / max)
    } else {
        100.0
    }
}

/// The kind of enemy a mobile type is (`enemyEntityType`, enemyBasics.js:108-113).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntityType {
    Monster,
    Class,
}

/// `enemyEntityType(id)` (characters/enemy/enemyBasics.js:108-113): 0..=42 is a monster, 128..=146 a class, any
/// other integer is none (its custom branch answers null: no custom enemy is registered). A non-integer is none.
pub fn enemy_entity_type(id: f64) -> Option<EntityType> {
    if !is_integer(id) {
        None
    } else if (0.0..=42.0).contains(&id) {
        Some(EntityType::Monster)
    } else if (128.0..=146.0).contains(&id) {
        Some(EntityType::Class)
    } else {
        None
    }
}

/// `enemyCareerIndex(id)` (enemyBasics.js:117-120): a class's career index is its id less 128; any other id is
/// its own career index.
pub fn enemy_career_index(id: f64) -> f64 {
    if enemy_entity_type(id) == Some(EntityType::Class) {
        id - 128.0
    } else {
        id
    }
}

/// One worn piece as `equipArmour` hands it to [`enemy_armor_values`] (target.js:514): its template (`piece`),
/// its material, and whether it is a shield. A `None` field is the JS `undefined` (no `item` is ever passed on
/// this path, so a piece's value is `materialArmorValue(material)`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ArmourPieceRef {
    pub piece: Option<f64>,
    pub material: Option<f64>,
    pub shield: bool,
}

/// `enemyArmorValues(entity, armorPieces)` (combat/enemyEquipment.js:298-325): seven struck-part values from 100.
/// A shield subtracts its value x5 on each part it covers (`SHIELD_VALUE`/`SHIELD_PARTS`, :84-89). Any other piece
/// subtracts its material's value x5 on its body part (`PIECE_BODY_PART`, :74-82), except the Feet, which the Feet
/// bound leaves alone (:314). A class is clamped to 60, a monster to its own `armor` (its `armorValue x 5`, :318-323).
pub fn enemy_armor_values(is_class: bool, armor: f64, pieces: &[ArmourPieceRef]) -> [f64; 7] {
    let mut av = [100.0; 7];
    for a in pieces {
        if a.shield {
            let bonus = enemy_shield_value(a.piece);
            for part in enemy_shield_parts(a.piece) {
                av[*part as usize] -= bonus * 5.0;
            }
        } else {
            let Some(part) = a.piece.and_then(piece_body_part) else {
                continue;
            };
            if part == BODY_PARTS.feet {
                continue;
            }
            av[part as usize] -= material_armor_value(a.material.unwrap_or(f64::NAN)) * 5.0;
        }
    }
    if is_class {
        for v in &mut av {
            if *v > 60.0 {
                *v = 60.0;
            }
        }
    } else {
        for v in &mut av {
            if *v > armor {
                *v = armor;
            }
        }
    }
    av
}

/// `SHIELD_VALUE[piece] ?? 0` (enemyEquipment.js:83).
fn enemy_shield_value(piece: Option<f64>) -> f64 {
    let Some(p) = piece else {
        return 0.0;
    };
    ENEMY_SHIELD_VALUE
        .iter()
        .find(|(k, _)| *k as f64 == p)
        .map_or(0.0, |(_, v)| *v)
}

/// `SHIELD_PARTS[piece] ?? []` (enemyEquipment.js:84-89).
fn enemy_shield_parts(piece: Option<f64>) -> &'static [f64] {
    let Some(p) = piece else {
        return &[];
    };
    ENEMY_SHIELD_PARTS
        .iter()
        .find(|(k, _)| *k as f64 == p)
        .map(|(_, parts)| *parts)
        .unwrap_or(&[])
}

/// `PIECE_BODY_PART[piece]` (enemyEquipment.js:74-82): the body part a classic piece covers, else none.
fn piece_body_part(piece: f64) -> Option<f64> {
    PIECE_BODY_PART
        .iter()
        .find(|(k, _)| *k as f64 == piece)
        .map(|(_, p)| *p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plate_metals_and_misses() {
        assert_eq!(material_armor_value(512.0), 7.0);
        assert_eq!(material_armor_value(521.0), 21.0);
        assert_eq!(material_armor_value(522.0), 0.0);
        assert_eq!(material_armor_value(512.5), 0.0);
        assert_eq!(material_armor_value(259.0), 6.0);
    }

    #[test]
    fn enemy_groups_fall_back_to_none() {
        assert_eq!(enemy_entity_group(15.0), ENEMY_GROUPS.undead);
        assert_eq!(enemy_entity_group(f64::NAN), ENEMY_GROUPS.none);
        assert_eq!(enemy_entity_group(43.0), ENEMY_GROUPS.none);
    }
}
