//! The boot: which mods the game's client has switched on when it mints an enemy (R3b). An explicit value, so no
//! ambient state (no settings store, no `UPSTREAM_BOOT` global) reaches a mint or an equipment roll.
//!
//! In the JS, `src/target.js:629` `UPSTREAM_BOOT` is the shipped boot: each mod's `Enabled` default
//! (`shippedOn`, target.js:626, over `MOD_SETTINGS`), so `pcaao`, `meanerMonsters` and `enemyExpansion` are all true
//! (`systems/modSettings.js`). `"boot"` in the JS names the set of mods the minted rows assume (the assumptions
//! register A15): a builder's `boot` parameter is one such set, and `gearEnemy` reads the module-level one. The port
//! takes the set explicitly everywhere. Every switch the JS reads from the settings store is a field here, at its
//! shipped default (from the generated tables, `tools/rust-data.mjs`).

use crate::generated::mod_settings::MOD_ENABLED_DEFAULTS;
use crate::generated::rri_items::RRI_ENABLED_DEFAULTS;

/// Roleplay & Realism: Items' switches the enemy equipment reads (`rriModule`, rriItems.js:41-42): `Enabled` and the
/// module key must both be on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RriSwitches {
    /// `Enabled`: the mod is loaded.
    pub enabled: bool,
    /// `newWeapons`: the Archer's Axe and the Light Flail.
    pub new_weapons: bool,
    /// `newArmor`: the chain and light armour sets.
    pub new_armor: bool,
    /// `realisticEnemyEquipment`: the mod's enemy arm (combat/rriEnemyEquipment.js:246).
    pub realistic_enemy_equipment: bool,
}

impl RriSwitches {
    /// The mod's shipped defaults (modSettings.js `roleplay-realism-items`).
    pub fn shipped() -> RriSwitches {
        let d = &RRI_ENABLED_DEFAULTS;
        RriSwitches {
            enabled: d.enabled.unwrap_or(false),
            new_weapons: d.new_weapons.unwrap_or(false),
            new_armor: d.new_armor.unwrap_or(false),
            realistic_enemy_equipment: d.realistic_enemy_equipment.unwrap_or(false),
        }
    }

    /// `rriModule(key)` for a module switch `on`: `Enabled && on` (rriItems.js:42).
    pub fn module(&self, on: bool) -> bool {
        self.enabled && on
    }
}

/// The boot: the three mods the minted rows depend on (target.js:629), the RRI switches the equipment reads, and the
/// one settings-store read the equipment equip table makes (`Enhancements.BowLeftHandWithSwitching`, read by
/// `getItemHands`, characters/equipTable.js:33; its shipped default is `False`, settingsDefaults.js:204).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Boot {
    /// Physical Combat And Armor Overhaul's `Enabled` (its Meaner Monsters edit, combat/pcaaoMeanerMonsters.js).
    pub pcaao: bool,
    /// Meaner Monsters' `Enabled` (characters/meanerMonsters.js).
    pub meaner_monsters: bool,
    /// Daggerfall Enemy Expansion's `Enabled` (systems/enemyExpansion/dexInstall.js). Also the switch that makes the
    /// mod's equipment delegate (the RRI arm) the one `gearEnemy` calls.
    pub enemy_expansion: bool,
    /// Roleplay & Realism: Items' switches.
    pub rri: RriSwitches,
    /// `BowLeftHandWithSwitching`: a bow goes in the left hand (LeftOnly) rather than both hands.
    pub bow_left_hand: bool,
}

/// `shippedOn(vendor)` (target.js:626): the mod's shipped `Enabled` default, from the generated table.
fn shipped_on(vendor: &str) -> bool {
    MOD_ENABLED_DEFAULTS
        .iter()
        .find(|(k, _)| *k == vendor)
        .is_some_and(|(_, on)| *on)
}

impl Boot {
    /// `UPSTREAM_BOOT` (target.js:629): every mod at its shipped default, the RRI switches at theirs, the bow in both
    /// hands (the setting's shipped `False`).
    pub fn shipped() -> Boot {
        Boot {
            pcaao: shipped_on("pcaao"),
            meaner_monsters: shipped_on("meanerMonsters"),
            enemy_expansion: shipped_on("daggerfall-enemy-expansion"),
            rri: RriSwitches::shipped(),
            bow_left_hand: false,
        }
    }

    /// The boot with the three mod switches given, and the rest shipped.
    pub fn with_mods(pcaao: bool, meaner_monsters: bool, enemy_expansion: bool) -> Boot {
        Boot {
            pcaao,
            meaner_monsters,
            enemy_expansion,
            ..Boot::shipped()
        }
    }

    /// The row-table code of the three mod switches: bit 0 pcaao, bit 1 meanerMonsters, bit 2 enemyExpansion (the
    /// `boot` argument of `mintRow`, which only these three flags reach). `generated::mint_rows` is keyed by it.
    pub fn code(&self) -> usize {
        (self.pcaao as usize)
            | ((self.meaner_monsters as usize) << 1)
            | ((self.enemy_expansion as usize) << 2)
    }

    /// The boot of a row-table code (the inverse of [`Boot::code`], the rest shipped).
    pub fn from_code(code: usize) -> Boot {
        Boot::with_mods(code & 1 != 0, code & 2 != 0, code & 4 != 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_is_enabled_and_switch() {
        // Local invariant, cited from `vendor/upstream/a3eb1605/src/systems/roleplayRealismItems/rriItems.js:42`:
        // `rriModule = (key) => rriEnabled() && modSetting(RRI_VENDOR, key) === true`, i.e. AND, not OR.
        let rri = |enabled| RriSwitches {
            enabled,
            new_weapons: false,
            new_armor: false,
            realistic_enemy_equipment: false,
        };
        assert!(!rri(false).module(false));
        assert!(!rri(false).module(true));
        assert!(!rri(true).module(false));
        assert!(rri(true).module(true));
    }

    #[test]
    fn unknown_vendor_is_off() {
        // Local invariant, cited from `src/target.js:626`: `shippedOn` reads `MOD_SETTINGS[vendor]`, so a vendor the
        // table does not name is off (`?.` yields undefined). The three real keys are on (generated table).
        assert!(!shipped_on("not-a-vendor"));
        assert!(!shipped_on(""));
        assert!(shipped_on("pcaao"));
        assert!(shipped_on("meanerMonsters"));
        assert!(shipped_on("daggerfall-enemy-expansion"));
    }
}
