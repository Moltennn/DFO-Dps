# DFO DPS Lab

A standalone melee DPS and build lab for **DFO Online**. It reads a normal
`SaveData.txt`, models the game's own combat core, and answers:

- what my current build does against a monster, a human, or a boss
- which stats and skills still matter (and which are already capped)
- which weapon and material is best for *this* character
- what enchants and martial passives are worth
- how a boss's **Curbing** cap changes the answer
- how long a boss fight takes, with a ward and the 75s wrath clock

It is not a mod. It does not write to the game, the save, or the store.

## Quick start

```bash
cd ~/DFO-DPS
node bin/dfo-dps.js build --save SAVE4
node bin/dfo-dps.js rank weapons --save SAVE4 --target boss --traits curbing --health 5000
node bin/dfo-dps.js report --save SAVE4 --target boss --traits curbing,warded --health 5000 --out build.html
```

Or run it directly:

```bash
./bin/dfo-dps.js build --save SAVE4
```

`--save` takes `SAVE4`, `4`, a save folder, or a path to `SaveData.txt`.
Without it, the newest save under `Daggerfall JavaScript/Saves` is used
(`DAGGER_USER_DATA` is honoured, as in the game).

## Ruleset

The defaults describe the live game:

| switch | default | why |
|---|---|---|
| combat core | `overhaul` | DFO ships the Physical Combat And Armor Overhaul v1.44 and enables it by default |
| online rules | on | DFO Online: weapon mastery past 100 and gear skill affixes |
| mentor | off | solo build planning; the mentor overlay only engages beside much lower-level players |

Change them with `--core classic`, `--offline`, or `--no-passive`. They are
independent: classic/overhaul is the combat formula; online/offline is the
past-100 rule set.

## What the save gives us

`SaveData.txt` is the game's own JSON. The tool reads:

- base attributes, skills, level, career, race, reflexes, health
- every item, with `equipSlot` marking what is worn
- the weapon's template, material, condition, affixes and enchantments
- active effects (vampirism, fortify/drain, racial mods)
- martial/arcane path, spells, mastered skills

The game stores base stats and rebuilds `_mods`, `_enchantMods` and the equip
table on load; this tool does the same rebuild. The in-game **Combat Stats**
card is the oracle for the per-hit model: if the two disagree, the import or
the model is wrong, not the build.

## What is modelled

- classic `FormulaHelper` and the PCAAO v1.44 overhaul
- hit chance, criticals, body-part armour
- weapon damage: template range, material, strength, proficiency, race,
  two-handed, swing direction
- cadence: Speed, weapon weight vs Strength, handling, two-handed, short-blade
  and martial pace, 0.45s floor
- online past-100 weapon mastery and gear skill affixes
- martial passives (Flowing Steel, War Rhythm, Hunter's Instinct, Cheap Shot,
  Opening Strike, Frenzy, Purge, Light Step, Windborne)
- loot-rarity affixes that affect damage: `damage`, `stat`, `skill`, `slayer`
- boss traits: Curbing, Warded, Bladeturning, Stoneskin, Thorned, Wrathful
- time-to-kill and cap loss

## Deliberate limits in v1

- melee only; bows, spells and cast-when-strikes procs are not scored yet
- damage is shown **before the foe's worn/natural armor reduction**, exactly
  like the game's Combat Stats card; a human in mail will take less
- the overhaul's condition-based effectiveness is assumed at 100% condition
- no loot set powers, sigils or legendary proc damage
- no mentor overlay
- no PvP/peer model

These are visible in the report's ruleset section rather than hidden.

## Source

The model follows the open-source DFO Online client,
[`Lattymoy/daggerfall-js-source`](https://github.com/Lattymoy/daggerfall-js-source),
MIT, snapshot `a3eb1605…` (2026-11-02), and Daggerfall Unity's
`FormulaHelper.cs` (MIT, Daggerfall Workshop). See `NOTICE`.

The live game continues in a private repository, so a future release may move
the formulas. When it does, update the pinned source reference and run the
tests; the report prints the version it modelled.

## Tests

```bash
npm test
```

The tests cover the strength terms, the classic/overhaul split, the weapon
damage range, the cadence curve, the reference foes, and the Curbing cap.
