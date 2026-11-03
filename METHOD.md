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

## Community fixture

`benchmark` uses the 2026-10-28 community fixture: level 45 Redguard Haarvenu vampire, STR/AGI/END/SPD/LUC 100, INT 99, WIL/PER 40, RRI weapon balance and swing law, Daedric, tough monster, raw 100/200, gear +0/+150/+300, no Expertise, no backstab, no procs. The doc's one-handed rows match **classic /5 Strength** and its two-handed rows a **~+15** term; `benchmark` uses those assumptions and is within ~1–6% of the published table. `--live` uses the live PCAAO `/10` model instead.

## Backstab and the cap

`combatStats` carries `Backstab: skillValue(Backstabbing)% ×3`. A front crit of 120–183 (sustained) becomes a **360–549** critical backstab; with the live card's opening First Blood it is 567–870, which the simulation deliberately excludes. `--behind` sets 100% uptime; `--backstab 0.5` uses the expected multiplier `1 + 2 × uptime × chance`.

The gate's per-blow cap is `HIT_CAP_X × dpsRef(level)` = 420 at level 30 (unless an Elite/Vestiges `relayBlowX` raises it). The tool reports raw backstab damage and **capped** DPS separately: a 600 display can be raw while only the cap reaches the health.

## The real gate boss pool

`net/gate/gateBrain.js`: a player's share of the gate boss is `BOSS_TTK_S = 240` seconds of reference damage, `dpsRef(level) = 5 + level` (level 1..60). Solo at level 30 that is **8,400 HP**. He has plate armour 60, a **per-blow server cap of `HIT_CAP_X = 12` x reference (420 at level 30)**, and phase shields at 66% and 33% for **3 seconds each**. Relay bosses (the gate, the Remnant, the gate court) only carry bladeturning/stoneskin/thorned; they do not carry ward, curb or wrath. The tool adds the six shield seconds to TTK.

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

## Live snapshot

When a JSON with `equipSlots` is imported, the actual equip table wins over the saved `items[].equipSlot` and the live `_mods` cache. Its item `affixes` are folded into `_mods.skills`/`_mods.stats`; `_enchantMods.skillMods` is added separately. That reproduces the live Combat Stats card's skill line: for Moltenn, Long Blade 168, Critical Strike 217, Dodging 112, and the hit term `298`.

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
