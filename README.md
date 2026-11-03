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

## Live snapshots

A save is a snapshot; a live character can differ (gear changed, gems, set powers). The tool accepts a live snapshot JSON from `window.__playerEntity` with `equipSlots` and `_enchantMods`. When `equipSlots` is present it uses the game's real equip table and its item affixes, not the saved `items[].equipSlot` or the stale `_mods` cache. That is what matches the live Combat Stats card.

```bash
# from the debug game, with CDP on 9222
dfo eval '(() => { const e = window.__playerEntity; const equipSlots = {}; for (const [k, v] of Object.entries(e.equip?.slots ?? {})) if (v) equipSlots[k] = v; return { name: e.name, level: e.level, raceId: e.raceId, race: e.race, gender: e.gender, career: e.career, reflexes: e.reflexes, health: e.health, maxHealth: e.maxHealth, stats: e.stats, skills: e.skills, skillOverrides: e.skillOverrides, activeEffects: e.activeEffects, items: e.items, equipSlots, martialPath: e.martialPath, masterSkills: e.masterSkills, masteredSkills: e.masteredSkills, _mods: e._mods, _enchantMods: e._enchantMods, _online: e._online }; })()' > /tmp/live.json

./dfo-dps build --save /tmp/live.json --first-blow
```

The live card's **Damage** and **Per swing** tiles show the **opening** blow when a First Blood item is worn. Pass `--first-blow` to compare exactly; without it the tool shows the sustained swing.

## Backstab and the 600s

A normal front crit on the live card is 189–290; **Backstab is 99% ×3**, so a critical backstab is **567–870**. That is the 600s you see. The tool was showing front swings only; `--behind` (100% behind) or `--backstab 0.5` (uptime) now adds it. The card's **Damage** and **Per swing** are front/opening values; the Backstab tile is separate.

The gate's server per-hit cap is **420** at level 30 (12 × `dpsRef` 35). A displayed 600 backstab is therefore **raw**; the health bar may only lose 420. If the bar really loses 600, the fight has a `relayBlowX` above 1.43 (Elite/Vestiges/might) or a different pool. `--players n` scales the gate's health per player; the cap is per player.

## Theorycraft numbers

`--target gate` uses the real solo gate boss: **240 seconds of reference damage** at your level, i.e. **8,400 HP at level 30** (`dpsRef(level) = 5 + level`), plate armour 60, a **420 per-blow server cap** (12 x reference), and **two 3s phase shields**. It has no Curbing; Curbing is a separate trait on elite/world bosses and is 5% of max HP.

`tradeoff` prints the speed/damage crossover:

- headroom = cap / expected landed hit
- at or below 1x, speed is already better than damage
- above 1x, damage can grow that many times before the cap makes speed strictly better
- plus the best weapon at each Curbing boss health, so the fast/slow crossover is visible

`scale` walks one channel from current to its cap (`--stat`, `--skill`, `--gear-skill`), or `--all` summarizes every channel. `--bare`, `--no-effects` and `--base-stats 50` give a naked theorycraft baseline.

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
- no loot set powers, sigils or legendary proc damage; **First Blood** (Duelist's Vambrace) is modelled because it changes the opening blow
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
