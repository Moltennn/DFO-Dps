# Sources and provenance

## The authority

| | |
|---|---|
| Repository | `Lattymoy/daggerfall-js-source` (DFO Online, open-source edition) |
| Commit | `a3eb1605ea1dc391b691fe314377458a7e63e483` |
| Date | 2026-11-02 |
| Licence | MIT, Copyright (c) 2026 Lattymoy — copied to `vendor/upstream/a3eb1605/LICENSE.upstream` |
| Upstream README | `vendor/upstream/a3eb1605/LICENSE.upstream.md` |

The upstream README states that live development continues in a **private
repository**. Everything after this snapshot is unverifiable from here; a
mechanic that behaves differently live is a re-pin, not a silent edit.

The port is itself derived from Daggerfall Unity (`Interkarma/daggerfall-unity`,
MIT); upstream's own comments cite `FormulaHelper.cs` and friends. We cite the
port, because the port is what the game runs.

## Layout

```
vendor/upstream/a3eb1605/
  MANIFEST.json     every file: upstream path, sha256, size, role
  STUBS.md          generated table of cut edges and why each is cut
  LICENSE.upstream  upstream MIT licence (verbatim)
  src/...           the vendored subset, at its upstream paths
```

Unlike the rest of the subset, four laws are also read by the simulator at runtime: `systems/bossTraits.js`
(`src/bossTraits.js`, the trait law and the resistance function), `systems/loot/lootRarity.js` and
`systems/loot/lootLevelGate.js` (`src/gearProfile.js`, the affix/record/Exalted/hone law and the rarity
gate), `combat/twoHands/handsLaw.js` (`src/dualWield.js`), and `characters/enemy/enemyBasics.js` +
`combat/enemyGroups.js` (`src/target.js`, the enemy row, career index/group and intrinsic-defence law).
Their content has one home rather than a copy. Everything else here is used by `test/` and `tools/` only.

`MANIFEST.json` is written by `tools/vendor-upstream.mjs`; `npm run vendor:verify`
re-hashes the tree and fails on any modification, addition or removal. The test
`test/vendor-manifest.test.js` runs the same check, and additionally tampers
with a file to prove the check is live.

## What is vendored, and why

289 files out of roughly 900 modules in the client's combat import
graph, plus the JSON data files those modules import whole.

The **roots** (`ROOTS` in `tools/vendor-upstream.mjs`) are the modules the
simulator reimplements or needs to build the same inputs:

| Area | Modules |
|---|---|
| Per-hit core | `combat/combatStats.js`, `combat/pcaao.js`, `combat/formulas.js`, `combat/playerWeapon.js` (the swing table) |
| Cadence | `characters/weaponStates.js`, `combat/swingLaw.js`, `combat/twoHands/handsLaw.js`, `combat/bowBloom.js` |
| Power ceilings | `systems/powerCeiling.js`, `systems/entityMods.js`, `systems/weaponMastery.js`, `systems/martialPowers.js`, `systems/martialPaths.js`, `systems/firmamentPowers.js`, `systems/loot/lootPowers.js`, `systems/loot/lootRarity.js`, `systems/loot/lootLevelGate.js` |
| Spells | `systems/spellcast.js` (`savingChance`, `savingThrow`, `savingLands`, `careerTolerance`, `spellHasFlags`, `rollMagnitude`; vendored actual, not a stub). Its `player/motor.js` edge remains a stub for capsule/missile geometry; `savingChance` does not read those constants. |
| Stats and skills | `systems/statMods.js`, `systems/skills.js`, `systems/skillSoftcap.js`, `systems/masterSkills.js` |
| Relay boss law | `net/gate/gateBrain.js`, `net/gate/gateMods.js` (three files with `textManager`; the rest of `net/` stays cut) |
| Foes and gear | `systems/bossTraits.js`, `systems/equip.js`, `systems/armorMaterials.js`, `characters/equipTable.js`, `characters/weapons.js`, `characters/handWrapsIds.js`, `characters/thunderlockIds.js`, `characters/enemy/*`, `combat/enemyGroups.js`, `combat/enemyEquipment.js` (the enemy loadout and its ArmorValues pass), `systems/enemyExpansion/dexEquipment.js` and `combat/rriEnemyEquipment.js` (the booted delegate's class arm), `combat/clawMetal.js`, `combat/healthShare.js` |
| Foe bodies (Stage 2.8) | `systems/enemyExpansion/dexInstall.js` (`dexClassicRow`, `installEnemyExpansion` - the classic rows Daggerfall Enemy Expansion and MUDEX leave, and the boot the oracle realm runs), `world/gate/gateBoss.js` (`bossStandIn`, `BOSS_ARMOR`: the one constructor of the Breach, Sky-ketch and Abyss bodies). The roots pull in the mod's tables and readers, `characters/meanerMonsters.js`, `combat/pcaaoMeanerMonsters.js` and `characters/mobile/mobileUnit.js`; their render, net and scene edges stay stubs. |
| Martial and enchantment dependencies (Stage 2.9) | `systems/sigil/sigilSets.js` + `systems/sigil/setReach.js` (`setsDueling`: `lootPowers.js:245` `wornPowers` returns nothing while it is true; the stub's inert truthy answer meant **no worn Legendary power or imprint ever fired in the oracle**; Stage 2.11a), `systems/sigil/sigil.js` (`sigilDueling`: `martialPowers.js:124` asks it before any path acts; the stub's inert truthy answer switched every path off in the oracle), `formats/magicDef.js` and its `formats/save/saveTreeFile.js` (`ENCHANTMENT_TYPES`: the stub keyed the payload registry by proxies, so no Strikes payload ran). Added as roots; vendor parity runs a held path's fold and a Potent Vs payload in both trees. |
| Items, wear, settings | `systems/item/itemTemplates.js`, `systems/item/itemFields.js`, `systems/item/itemInfo.js`, `systems/inventory.js`, `systems/conditionRepair.js`, `systems/enchantments.js`, `systems/modSettings.js`, `systems/settings/*`, `systems/powerBlows.js`, `systems/spell/spellPower.js`, `systems/online/onlineLane.js` |

Everything the closure reaches is copied **whole and unmodified**. Three of
those (mod settings, settings, inventory) were added after the parity tool
proved a stub was changing a measured answer — see "The gate" below.

## Stubbed edges (122 files)

The combat graph reaches UI, rendering, world geometry, baked assets, the
network and player-movement code. Vendoring those would copy a 27 MB client. Each
such edge instead becomes a **stub at its upstream path**:

- it is importable (upstream calls registration seams at import time);
- calls are inert, because a registration must not throw at load;
- anything read as a **number** yields `NaN` and anything read as a **string**
  yields `[vendored stub]`;
- simple constant exports (`export const X = 60`) keep their upstream literal.

So a stub that leaks into a measured result is loud: `test/harness/upstream.mjs`
`assertFinite()` rejects it, and the differential suite compares against the
real modules. `STUBS.md` records every stub, its reason and the bindings its
importers ask for.

The harness measures the **offline, un-modded client**, which is what every stub
assumes: mod settings read their defaults, UI preferences read nothing, sigil
sets and the online lane are asleep.

Foe bodies are the one place the boot itself matters: the shipped defaults load
Daggerfall Enemy Expansion with MUDEX (`scenes/shared.js:1518`), which owns the
classic rows. The oracle mints every body in its own worker-thread realm after
that boot (`test/harness/upstreamBodies.mjs`), so the boot's in-place table edit
and its equipment delegate never reach the simulator's own modules
(the assumptions register A15).

## The gate: pruning must not change an answer

```bash
node tools/vendor-parity.mjs --from /path/to/daggerfall-js-source
```

This loads both the vendored subset and the **full** checkout, runs a fixed
seeded battery through each (weapon tables, hands, types, skill families,
damage modifiers, the card over 300 characters × 2 cores × 2 swings × 4 foes,
12,000 seeded blows through `pcaaoAttackDamage` against the Warden's body, trait
resistance, ceilings, bow laws, swing law; since Stage 2.8 every classic foe's
mint, the Enemy Expansion/MUDEX rows, `bossStandIn`, the boot itself and, after
it, every booted mint, stand-in and class loadout; since Stage 2.9 a held martial path's fold and `liveStat`, and a Potent Vs payload) and fails on any difference.

Current result: **1855 checks, 1855 identical, 0 diverged** (including 4 seeded relay runs through `joinFight`/`applyHit`). Run it whenever a
module is added to or removed from the cut list. A divergence means a stub is on
a measured path: vendor that module (remove it from `EXCLUDE`), do not adjust
the test.

## Re-pinning upstream (a separate change)

1. Check out the new commit in the upstream clone; note that it must be clean.
2. Update `UPSTREAM` in `tools/vendor-upstream.mjs` and `COMMIT` in
   `test/harness/upstream.mjs`.
3. `node tools/vendor-upstream.mjs --from <checkout>` — refuses a dirty tree or
   the wrong commit.
4. `node tools/vendor-parity.mjs --from <checkout>` — must be 0 diverged.
5. Re-derive the golden fixtures in `test/golden-upstream.test.js` from the
   new commit's tests; update the waiver table.
6. `npm test`, then record the re-pin and any behaviour change in
   `CHANGELOG-MECHANICS.md`.

## Source mapping (simulator → game)

| Simulator | Game | Notes |
|---|---|---|
| `src/model.js` `hitModel` | `combat/combatStats.js` `hitModel`, `combat/pcaao.js` `pcaaoSuccessfulHit` | verified: hit chance matches exactly |
| `src/model.js` `damageModel` / `weaponBlow` | `combat/combatStats.js` `damageModel`, `combat/pcaao.js` `pcaaoWeaponAttackDamage`, `systems/entityMods.js` (blow modifiers) | verified per-weapon; elemental and the missing reduction are waived |
| `src/model.js` `critModel` | `combat/combatStats.js` `criticalModel`, `combat/pcaao.js` `pcaaoCriticalStrike` | verified |
| `src/model.js` `cadence` | `characters/weaponStates.js` `swingFrameSeconds`/`swingHeft`/`swingHandling` | verified |
| `src/model.js` `rangedCadence` | `combat/bowBloom.js` (BOW_FAST/BOW_KINDS), `systems/weaponStates` (reload) | constants verified; full cycle not yet a stage |
| `src/data.js` tables | `characters/weapons.js`, `combat/fpsWeapon.js`, `characters/equipTable.js`, `combat/formulas.js` | verified programmatically for every template |
| `src/save.js` | `systems/statMods.js`, `systems/skills.js`, `systems/skillSoftcap.js`, `systems/masterSkills.js` | boundaries verified (100/125/200, 100→115) |
| `src/enchants.js` | `systems/enchantments.js`, `systems/loot/lootPowers.js` | procs not yet a differential stage (waived: budget) |
| `src/allowance.js` (shared by `src/purse.js` and `analyze()`) | `net/gate/gateBrain.js` `joinFight`, `applyHit`, `spendBlow` (vendored) | verified claim by claim against the game's own functions (`test/allowance.test.js`) |
| `src/dualWield.js` (a thin adapter, imported at runtime) | `combat/twoHands/handsLaw.js`, `characters/weaponStates.js` (vendored) | the exchange, the off hand's terms and its burden; driven against the game's machine in `test/dualWield.test.js` |
| `src/bossTraits.js` (a thin adapter, imported at runtime) | `systems/bossTraits.js` `relayBossTraits` + `bossStrike` (vendored) | the trait law itself, not a copy; tested for all three bosses and a 1,000-case grid |
| `src/target.js` (the target model, imported at runtime) | `characters/enemy/enemyBasics.js` (`ENEMY_BASICS`, `enemyCareerIndex`, `enemyEntityType`), `combat/enemyGroups.js` (`enemyEntityGroup`), `combat/pcaao.js` (`pcaaoNaturalDamageResistance`, `pcaaoPercentageReductionCalculationForMonsters`, the `minMetalToHit` multiplier), `systems/loot/lootPowers.js:164-167` (`elementShare`), `combat/pcaao.js` (`PCAAO_REDUCTION_ROWS`, `pcaaoArmorMaterialIdentifier`, `pcaaoAlterArmorReducBasedOnItemCondition`, the shield/armour reduction functions, `pcaaoShieldBlockChanceCalculation`, `pcaaoCompareShieldToUnderArmor`), `combat/enemyEquipment.js` (`armorOfMaterial`, `enemyArmorValues`), `systems/armorMaterials.js`, `systems/equip.js` (`slotForBodyPart`, `armorBodyParts`) | the enemy row, career group, intrinsic-defence law and the worn-armour/shield tables. Stage 2.2 stages compare the material id, condition multiplier, every reduction row, the block chance and the under-armour comparison, and sample the whole blow with gear; `careerTolerance` is a direct port of the vendored `systems/spellcast.js:61-68`, compared with it and `savingChance` |
| `src/target.js` `enemyTypeGroup`/`enemyTypeBonusRange`/`enemyTypeBonusValue`/`enemyTypeBonusValues` | `combat/pcaao.js:491-522`, `combat/formulas.js:176-197` (`GROUP_BITS`, `careerAttackModifier`), `combat/enemyGroups.js` (`enemyEntityGroup`) | differential stage `enemy-type bonus and phobia` (13,824 exact values); the target group is the career's, not the affinity's |
| `src/target.js` `silverApplies`/`isSkeletalTarget`/`skeletalSilverDamage` | `combat/pcaao.js:549-590` (`SILVER_DOUBLED_CAREERS`, Skeletal Warrior), `combat/formulas.js:462-470` (`silverDoubles`) | differential stages `silver, skeletal and the enemy-type bonus in the weapon blow` (1,200 multisets) and `the Skeletal Warrior 0x10 weapon-flag exception`; `test/enemyType.test.js` |
| `src/model.js` `martialBlowPct` (Ranger/Crusader) | `systems/martialPowers.js:194-225` via `systems/loot/lootPowers.js:142-157` (`foeGroup`) | the animal/undead-daedra group is upstream's affinity-first `foeGroup`, not the career group; `test/enemyType.test.js` |
| `src/model.js` `damageModel` (the silver/skeletal and enemy-type slots) | `combat/pcaao.js:555-600` (weapon and fist arms), `:1740-1843` (crit/material/condition after) | the weapon-blow multiset stage compares the whole stage exactly; the sampled end-to-end stages compare the blow with armour, traits and caps |
| `src/gearProfile.js` (a thin adapter, imported at runtime) | `systems/loot/lootRarity.js` (`AFFIX_RANGES`, `AFFIX_COUNTS`, `kindLines`/`kindParams`, `skillKin`, `legendariesFor`, `exaltLegendary`, `honeableLines`, `affixBand`), `systems/loot/lootLevelGate.js` | the slot options, the legal frontier and the validator; `test/gearProfile.test.js` checks the bands, the records and a 3,000-draw Exalted oracle |
| `src/maxprofile.js` `legalGear`/`legalFrontier` | the game's own `skillKin`/`legendariesFor` (through `gearProfile`), and `src/model.js` for the DPS search | the frontier point that maximises uncapped, per-hit-capped or allowance DPS; tied points kept |
| `src/model.js` `classicStrength` / `damageModel` classic arm | `combat/formulas.js:88-92` (`damageModifier` + the override), `combat/pcaao.js:224-227` (`pcaaoDamageModifier`), `:1873-1875` (the install), `systems/modSettings.js:1269-1276` (`fixedStrengthDamageModifier` default), `combat/formulas.js:470-495`/`:420-440` (the stock arms) | differential `Strength damage modifier` (live `/10`, stock `/5`, overhaul) and `classic Strength end-to-end` (2 modes × 7 strengths × 9 builds); `test/classicStrength.test.js` |
| `src/model.js` `overhaulRacial`/`classicRacial`/`racialModifiers` | `combat/pcaao.js:281-361` (`pcaaoRacialModifiers`), `combat/formulas.js:292-306` (`racialModifiers`), `systems/races.js:34-43` | differential `racial modifiers (overhaul and classic)` (144 + 48 exact), end-to-end, the backstab/condition/armour/traits/cap sample and the off-hand sample; `test/racial.test.js` |
| `src/model.js` `weaponOf` `conditionPercent` / `conditionMultiplier` / `damageModel` condition band | `systems/item/itemTemplates.js:277-279` (`conditionPercentage`), `combat/pcaao.js:607-637` (`pcaaoAlterDamageBasedOnWepCondition`), applied at `:1800-1804` | differential stage `weapon condition bands` (every integer threshold, blade/blunt, sharpEdge on/off), end-to-end, off-hand/ranged and armour/traits/cap stages; `test/condition.test.js` |
| `src/model.js` `backstabDamage` / `damageModel` backstab arrays / `hitModel` backstabBonus / `analyze` mixture | `combat/pcaao.js:469-479` (`pcaaoBackstabDamage`), `:1706` (`chanceToHitMod += backstab`), `:1724/1768`, `:1777`; `combat/formulas.js:507`; `scenes/hostCombat.js:327-332` (`backstabChanceOf`, the facing test and the Watchful revenant) | differential stages `backstab damage roll` (exact), `backstab hit bonus and x3 mixture` (6 skills × 4 caps), `backstab off-hand`, `backstab ranged`; `test/backstab.test.js` |
| `src/model.js` `weaponResistFactor` | `systems/bossTraits.js` `bluntBlow`/`bladeBlow` | the weapon-kind classifier behind the factor |
| `src/target.js` `targetPartDamage` / `targetExpectedDamage` | `combat/pcaao.js:1349-1590` (`pcaaoArmorDamageReductionWithWeapon/Unarmed`, the shield row, `pcaaoShieldBlockChanceCalculation`, `pcaaoCompareShieldToUnderArmor`), `combat/pcaao.js:1815-1843` (the branch order) | the per-body-part defence and its expected value; the differential stages compare the rows exactly and the whole blow with a seeded sample |
| `src/target.js` `UPSTREAM_BOOT` / `mintRow` / `enemyTarget` (Stage 2.8) | `characters/enemy/enemyEntity.js:160-233` `makeEnemyEntity` (level `:202/:207/:212`, armour `:210/:215/:232`, skills `:233`, metal `:257`, affinity `:277`), the row edit `:178` composed as the boot leaves it: `systems/enemyExpansion/dexInstall.js` `dexClassicRow` (Enemy Expansion with MUDEX) over `characters/enemy/enemyBasics.js:1960` `VANILLA_ENEMY_BASICS`, else `combat/pcaaoMeanerMonsters.js:138` over `characters/meanerMonsters.js:194`; the switches' shipped defaults from `systems/modSettings.js` `MOD_SETTINGS` | every body (43 monsters, 19 classes) compared field by field with upstream's own mint in a booted realm (`test/targetBody.test.js`); vendor parity checks the rows and the booted mint against the full client |
| `src/target.js` `standInTarget`; `src/model.js` `bossTarget` / `gateTarget`; `src/encounters.js` `encounterTarget` | `world/gate/gateBoss.js:151-170` `bossStandIn` (vendored), `BOSS_ARMOR :106`; the looks: Breach 31, Sky-ketch Warden 36 (full checkout `scenes/ketch/ketchFight.js:57,348`), Abyss Remnant 36 (`scenes/superDungeon/sdRemnant.js:97,529`) | one construction path for every relay boss; compared with the booted realm's own `bossStandIn` at four content levels |
| `src/target.js` `targetPartOutcomes` / `src/model.js` `resolveBlow`, `blowDistribution` (Stage 2.9) | `combat/pcaao.js:1784-1796` (strong spot, `pcaaoShieldBlockChanceCalculation`, `pcaaoCompareShieldToUnderArmor`), `:1815-1850` (the reduction by branch, then `shared`), `systems/bossTraits.js` `bossStrike`, `net/gate/gateBrain.js` `applyHit` (the cap) | the block is one `dice100` per blow; each outcome is run through the off hand, the trait and the cap; compared value by value with upstream's blows (`test/shieldOutcomes.test.js`) |
| `src/model.js` `bowOf` / `bowBlow` | `combat/arrowFlight.js:501-510` (full checkout; `shaftOnRelayBody`, `playerArrowHitFoe`), `combat/bowBloom.js:73-79` `bowFastDamage` (vendored, called as is) | the pull acts on the finished blow, after the share, before the trait and the cap (`test/longBow.test.js`) |
| `src/model.js` `stat` / `combatStat` | `systems/martialPowers.js:364-375` `martialFold`, `systems/entityMods.js:160-185` `computeEntityMods`, `systems/statMods.js:121-141` `liveStat` | the path's bonus is summed into `_mods.stats` before the clamp (`test/statCap.test.js`) |
| `src/model.js` `martialBlowPct` / `martialPace` (Frenzy) | `systems/martialPowers.js:216-218`, `:274-276`, `systems/martialPaths.js:71` `N.frenzy`, `combat/healthShare.js:36-48` `healthShare` | the attacker's `health/maxHealth`, strictly below 0.5 (`test/berserker.test.js`) |
| `src/model.js` `SWING_DIRECTIONS` / `mixCards` / `analyzeCard` (Stage 2.13) | `characters/weaponStates.js:278` `CLICK_ATTACK_DIRECTIONS`; `characters/anims.js:33` `DIRECTION_TO_STRIKE`; `combat/playerWeapon.js:1032` `_rollClickStrike`, `:1108` `clickAttack`, `:1113` the bow forced to `StrikeDown`; `FormulaHelper.CalculateSwingModifiers` -> `playerWeapon.js:83-90` `SWING_MODS`, `playerAttackOptions` :1344 | the six-way draw is a per-attack mixture enumerated exactly; each direction verified against `pcaaoAttackDamage` with its own `damageMod`/`toHitMod`, and the mixture against seeded draws (`test/swingDirection.test.js`) |
| `src/fight.js` `fightRelay` / `src/allowance.js` `simulateAllowance` `perClaimAt` / `src/objectives.js` (Stage 2.12b) | `net/gate/gateBrain.js` `joinFight` :1213, `applyHit` :1298 (`got = min(claim, HIT_CAP_X x ref, bucket, hp)`), `spendBlow` :3411; the claim read at the health that stands (`combat/healthShare.js:24-40`) | one law with a health-dependent claim, verified claim for claim against `applyHit`; the objectives name the metric and the target (`test/relayFight.test.js`, `test/objectives.test.js`) |
| `src/fight.js` (Stage 2.12a) | `combat/healthShare.js:24-40` (the share), `systems/weaponMastery.js:114-126` (axe below / blunt at-or-above 0.5), `systems/loot/lootPowers.js:320` (venom), `:329` (execute), `systems/martialPowers.js:217`, `:276` (the wielder's share: rage, Frenzy) | the fight evaluates the same blow at each share the pool passes through; mastery is compared exactly with `weaponPastPct`, venom and execute with the worn-item blow at each share, and a whole fight with a seeded blow-by-blow (`test/fight.test.js`) |
| `src/gearLines.js` (Stage 2.11b) | `systems/loot/lootRarity.js:2085-2088` `layGemLines`, `:2151-2165` `gemPieceCap`/`readLines`, `:839-847` `validAffix`, `:2373-2406` `affixFold`, `:2475-2479` `affixWeaponDamage`, `:2004-2011` `socketMax`, `:2040` `gemLine`; `systems/loot/lootPowers.js:129-132` `linesOf`, `:286-347` `lootBlow` | the adapter calls those functions; a differential over 400 seeded items checks stats, skills, damage %, slayer and elemental against them, and four whole builds against the worn-item blow (`test/gearLines.test.js`) |
| `src/model.js` `echoChances` / `afterShare` echo branch (Stage 2.11b) | `systems/loot/lootPowers.js:374-376` (the roll), `:444-454` `again` (`n = max(1, round(damage))`, `door.hurtFoe` or `oweFoe`), `systems/playerDoor.js:47-56` `oweFoe`/`takeOwed`, `scenes/dungeonContext.js:4528-4531` `landOnBoss` (the owed number resisted as melee, added to the resisted blow, one claim) | the echo rides the claim on a relay body and is its own hit on an ordinary foe; compared value by value with the host's composition (`test/manyEndings.test.js`) |
| `src/model.js` `lootPowerTerms` / `strikesNet` / `weaponOf` `powers` (Stage 2.11a) | `systems/loot/lootRarity.js:1196-1271` `LEGENDARY_POWERS`, `powerOf`, `powerIdsOf`; `systems/loot/lootPowers.js:244-258` `wornPowers`, `:265-268` `blowPowers`, `:286-347` `lootBlow` (conditions `:304-336`, `shareOf` `:176-181`, `out + flat` `:346`); `systems/enchantments.js:415-423` `mobileAffinityMatches`, `:622-631` / `:886-892` Potent Vs / Low Damage Vs, `:1031-1075` `doItemEnchantmentPayloads`; `combat/formulas.js:826-840` | an item's powers and rows are read by the code the what-if uses; verified against the oracle holding the item worn (`test/equippedBuild.test.js`) |
| `src/model.js` `analyze(...).with` / `weaponBlow` `opts.loot` / `afterShare` `potentVs` (pricing) | `systems/loot/lootPowers.js:176-181` `shareOf`, `:286-347` `lootBlow`; `systems/enchantments.js:622-631`, `:1031-1075` `doItemEnchantmentPayloads`; `combat/formulas.js:826-840` (`whole`, the Strikes payloads); `combat/twoHands/handsLaw.js` `OFF_HAND_BLOW` | one calculation; a what-if enters the blow where the game puts it (`test/pricing.test.js`, `test/crossSystem.test.js`) |
| `src/target.js` `armourPiece` / `equipArmour` / `gearEnemy` | `combat/enemyEquipment.js` `armorOfMaterial`, `enemyArmorValues`, `equipmentVariantFor`, `assignEnemyStartingEquipment` (the fallback arm); the client's boot installs `systems/enemyExpansion/dexEquipment.js` `createDexEquipmentAssigner`, which `combat/enemyEquipment.js:346` calls before ItemHelper, and its class arm is `combat/rriEnemyEquipment.js:240-425`; `src/target.js` reads the mod's tables per roll with `systems/enemyExpansion/dexInstall.js` `dexRead` (nothing is installed globally); `systems/equip.js` `armorBodyParts`/`slotForBodyPart`; `scenes/hostCombat.js` `equipEnemy` (the placement) | the booted delegate's own item minter and ArmorValues pass; the stock `assignEnemyStartingEquipment` arm is only the fallback. `scenes/hostCombat.js` is not vendored, so the seven-slot placement is reproduced and pinned by the armour tests |
| `src/spells.js` `savingChanceOutcome` | `systems/spellcast.js` `savingChance` (`:130-190`), `savingLands` (`:194-199`), `careerTolerance` (`:61-68`), `spellHasFlags` (`:70-86`) | differential stages `spell career tolerance`, `spell player-race tolerance`, `saving lands and career tolerance`; `elementalResistanceChance`/the dice are not modelled |
| `src/theory.js`, `src/firmament.js` | `systems/firmamentPowers.js`, `net/firmament/*` | law/tree vendored byte-identical earlier; application not yet a stage |
