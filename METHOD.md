# Method

This is the short version of what the numbers mean and where they come from.
The source is the open-source DFO Online client at
`Lattymoy/daggerfall-js-source` (MIT), snapshot `a3eb1605…` (2026-11-02),
plus Daggerfall Unity's `FormulaHelper.cs` (MIT, Daggerfall Workshop).

## Per hit

The model follows the game's own **Combat Stats** card:

- `combat/combatStats.js` — `computeCombatStats`, the per-swing reference foe
  model (damage, hit, crit, per-swing expectation)
- `combat/formulas.js` — the classic DFU FormulaHelper
- `combat/pcaao.js` — Physical Combat And Armor Overhaul v1.44
- `systems/loot/lootRarity.js` — `damage`/`stat`/`skill`/`slayer` affixes
- `systems/martialPowers.js` — Flowing Steel, War Rhythm, Hunter's Instinct,
  Cheap Shot, Opening Strike, Frenzy, Purge, Light Step, Windborne
- `systems/weaponMastery.js` — online weapon skill past 100
- `systems/bossTraits.js` — Curbing, Warded, Bladeturning, Stoneskin, Thorned,
  Wrathful

The two cores differ in ways that change the answer:

| | classic | overhaul (default) |
|---|---|---|
| Strength damage | `floor((STR-50)/5)` | `floor((STR-50)/10)`, two-handed x2 |
| Armour | lowers hit chance | lowers damage after the hit |
| Weapon skill | hit chance | hit chance; online, damage/pace past 100 |
| Critical Strike | adds hit | can add a damage multiplier |

The card's damage is **before the foe's worn/natural armour reduction** in the
overhaul. This tool shows the same number and labels it; the actual damage
against a mailed human is lower.

## Cadence

`characters/weaponStates.js`:

```
tick = clamp(0.199 * tempo(Speed) * heft(weight, Strength) * handling, 0.09, 0.4)
swing = (5 + hold) * tick
```

- `tempo(50)=1`, `tempo(100)=0.6`, `tempo(0)=1.4`
- `heft` grows with the weapon's template weight against Strength
- `handling` is 1.0 for a long blade, 0.9 for a dagger/short blade, slower for
  mace/flail/axe/warhammer, x1.06 for a two-handed weapon
- martial/Short Blade pace divides the tick by `1 + pct/100`
- a fresh main-hand swing is five frames; the 0.45s floor makes the maximum
  about 2.2 swings/s

## Boss cap

`systems/bossTraits.js`:

- **Curbing** — `min(blow, max(1, round(maxHealth * 0.05)))`
- **Warded** — a 30% max-HP pool absorbs blows first, refilling after 10s
  without a hit
- **Bladeturning / Stoneskin** — weapon-class damage x0.5
- **Thorned** — 20% of weapon damage back at the striker
- **Wrathful** — boss damage x1.6 after 75s

Relay bosses (the Warden, the Remnant, the gate court, the sea serpent) only
carry bladeturning/stoneskin/thorned; they have no ward, curb or wrath.

Curbing only binds when the blow would take more than 5% of **maximum** health.
If your per-hit is 40 and the boss has 5,000 HP, the cap is 250 and does
nothing. The report's "Boss cap sensitivity" table shows where it starts to
matter.

## Save import

`SaveData.txt` stores base stats/skills plus items, affixes, enchantments and
active effects. The game rebuilds `_mods`, `_enchantMods` and the equip table
on load; this project rebuilds the channels the combat model reads:

- worn items by `equipSlot`
- `stat`/`skill` affixes onto the live channels
- `damage`/`slayer` affixes onto the weapon
- active effects' `statMods`/`skillMods`
- Master Skills: online is always active; offline `masterSkills` decides
- `masteredSkills` gates which skills may read past 100

The in-game Combat Stats card is the final oracle. If this tool and the card
disagree for the same character and foe, the import or the model is wrong —
check that first.
