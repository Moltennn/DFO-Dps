# DFO DPS Lab

A standalone combat DPS and build lab for **DFO Online**. It reads a normal
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
dfo eval '(() => { const e = window.__playerEntity; const equipSlots = {}; for (const [k, v] of Object.entries(e.equip?.slots ?? {})) if (v) equipSlots[k] = v; return { name: e.name, level: e.level, raceId: e.raceId, race: e.race, gender: e.gender, career: e.career, reflexes: e.reflexes, health: e.health, maxHealth: e.maxHealth, magicka: e.magicka, maxMagicka: e.maxMagicka, stats: e.stats, skills: e.skills, skillOverrides: e.skillOverrides, activeEffects: e.activeEffects, items: e.items, equipSlots, spells: e.spells, readiedSpellIndex: e.readiedSpellIndex, martialPath: e.martialPath, masterSkills: e.masterSkills, masteredSkills: e.masteredSkills, _mods: e._mods, _enchantMods: e._enchantMods, _online: e._online }; })()' > /tmp/live.json

./dfo-dps build --save /tmp/live.json --first-blow
```

The live card's **Damage** and **Per swing** tiles can include the Duelist's Vambrace **First Blood** opening effect. The simulation deliberately excludes it — it is one opening hit, not boss DPS — so compare the tool's sustained **38–58 / 120–183** front range and its **Backstab** range, not the card's opening tile.

## Theoretical level 45 long blade

`theory` is the live ceiling, not a community fixture: all attributes 100, mastered Long Blade / Critical Strike / Backstabbing at raw 200, a Daedric Dai-katana, online rules and RRI weapon balance. It prints the DPS at each stage, the cap sheet, stat and skill curves, the long-blade ranking, and the best split of the gear skill-line budget.

```bash
./dfo-dps theory
./dfo-dps theory --vampire
./dfo-dps theory --gear-lines 20 --json
./dfo-dps theory --blade 121 --race redguard
```

The practical skill-line ceiling comes from the item rules, not a made-up budget. Long Blade can only roll on the weapon and the seven armour pieces (**8 lines**); Critical Strike can also roll on all ten jewellery slots (**18 lines**). That is **26 lines x 30 points = 780 points**, and the command searches the feasible Long Blade / Critical Strike split at every lower budget too. The weapon damage affix is capped at 40%.

At the level-45 gate the **600 per-hit cap**, not the character sheet, is the wall: the fully geared build is **~1,198 uncapped DPS**, but only **~821 capped DPS** and **~20.6 s TTK**. Past about 24 skill lines the extra damage is almost entirely eaten by the cap.

### The Firmament (star tree) and values past the base caps

The base caps are not the whole story, but they are not gear's either:

| channel | base cap | what lifts it | formula past the cap |
|---|---|---|---|
| attributes | 100 | **Firmament only** (+15, `statMax`) | `liveStat` reads up to 115; the same `/10` Strength, proficiency and RRI terms apply |
| raw skills | 200 | nothing | `effectiveSkill(200)` = 140; the Firmament and gear add **on top** of that |
| displayed skill | 200 raw + mods | Firmament (+15) and gear | the sheet prints raw + mods, so 215 or 455; the formula reads 155 or 395 |
| weapon blow | gear affix 40% | Firmament (+30% general, +50% with conditions) | a separate multiplier from gear skill and the affix |

A gear **stat** affix is a mod, not a `statMax`: at 100 it is wasted, and it can only fill headroom the Firmament already opened. A gear **skill** affix is different: it joins the post-softcap mod channel and is not limited by the 200 raw cap.

Use `--firmament` for the +15 channel ceiling, or enter your own stars:

```bash
./dfo-dps theory --firmament
./dfo-dps theory --star-stat strength=15,speed=8 --star-skill 29=15,34=10
./dfo-dps graph --theory --firmament --series stat:strength,stat:speed   --from 100 --to 115 --step 5 --out stars.html
```

The `theory` output prices every star channel from +0 to +15 at the ceiling, and the blow channel from +0% to +30%. The short version: **Strength** is the only attribute that keeps paying past 100 (damage and RRI swing speed); **Speed** is clamped to 98/100 by the swing law; **Agility** only moves on integer thresholds; **Luck** needs 125 to move the critical divisor, so +15 is dead. Skill stars are small: Long Blade +15 is +6.6% mastery, Critical Strike +15 is +0.15 critical multiplier, and Backstabbing is already at 100% chance.

## Weapon ceiling page

`weapons` writes a self-contained HTML page you can open directly. It compares every weapon at the best build the model can justify, then shows how each weapon family's damage scales with its own skill.

```bash
./dfo-dps weapons                   # writes ./weapons.html
./dfo-dps weapons --vampire         # true ceiling: vampire +30 Critical Strike
./dfo-dps weapons --firmament       # charts use 115 attributes, +15 skill stars, +30% Firmament blow
./dfo-dps weapons --out ~/dfo-weapons.html
```

The max profile is: attributes 100 (115 with `--firmament`), raw weapon skill and Critical Strike 200 mastered, weapon skill gear 240 (8 lines), Critical Strike gear 540 (18 lines), 40% damage affix, **perfect diamond sockets** (short blade 1, one-handed 2, two-handed 3, +12% damage each), the weapon's own career expertise, **Dunmer** (the default race; `--race` overrides), and **Blademaster** for every family; Berserker's below-half upkeep is not assumed. Hand-to-Hand uses a pair of **Hand Wraps** (damage/sockets/procs carry the fist blow). The table also includes dual-wield pairs, both hands of the same one-handed weapon at the off-hand x0.8 / -5 hit terms. The `Max gear` column is that build; `+ Firmament` adds the star-tree channel ceiling (+15 attributes, +15 skill, +30% blow). The gate column is the same build against the level-45 gate's 600 per-hit cap. The first chart ranks the boss (gate) DPS; the second ranks the uncapped DPS. Every DPS cell is the average; the bar chart's bar is the average.

`weapons-max.html` with `--categories` is the condensed table: one row per weapon type in each slot, including the Hand Wraps fist row, sorted by DPS. The full page has a max-DPS bar chart and table, then one combined chart per family: raw training 100 -> 200 is effective 100 -> 140, and gear lines continue from effective 140 to 140 + the gear cap. One Critical Strike chart covers the best weapon of each family. The Hand-to-Hand row is the wrapped ceiling. Bare fists without Hand Wrap lines are the ~450 band the community tests saw.

`skills` is kept as an alias for the same page.

## Firmament trees

`firmament` plans the real 518-star sky for a build, using the game's own
tree, adjacency and channel caps. It walks connected paths, never through a
keystone, and spends the 98-Star purse. It does not assume Craft points.

```bash
./dfo-dps firmament                              # all eight builds, writes firmament.html
./dfo-dps firmament --build longblade            # one build
./dfo-dps firmament --build bow,destruction --stars 60 --out plans.html
./dfo-dps firmament --build tank --json
```

Builds: `longblade`, `shortblade`, `axe`, `blunt`, `bow`, `fists`,
`destruction`, `tank`. The page shows the lit tree, every channel the build
cares about, and the notables/keystones on the path. It is a deterministic
channel-coverage plan, not a solver proof: the weapons page `+ Firmament`
column is the flat channel ceiling (+15 STR/AGI/SPEED/LUCK, +15 weapon /
Critical Strike / Backstabbing, +30% blow), and a real 98-star path may leave
some of those short.

## Bows, firearms, spells and enchantments

The same model now covers the other damage lanes:

```bash
# bows (Short Bow 129, Long Bow 130) and the port's guns (560 Thunderlock, 562 Pistolet)
./dfo-dps build --save /tmp/live.json --weapon 129:9 --target gate
./dfo-dps build --save /tmp/live.json --weapon 562:4 --pair --target gate
./dfo-dps build --save /tmp/live.json --weapon 129:9 --spam --target gate
./dfo-dps build --save /tmp/live.json --dual --target gate

# spells: the live formula, standard SPELLS.STD records, cost, cast time and mana
./dfo-dps spell --save /tmp/live.json --spell Fireball
./dfo-dps spells --save /tmp/live.json --out spells.html
./dfo-dps spells --theory --potency 30 --pierce 10 --cast-speed 15 --out spells-max.html
./dfo-dps spell --save /tmp/live.json --spell Wildfire --seconds 60 --potency 30 --pierce 10

# the equipped weapon's Cast When Strikes / Potent Vs rows
./dfo-dps enchant --save /tmp/live.json
```

Ranged laws: a bow's cycle is the port's five-frame swing law with the BOW-LAW reload, and the BOW_FAST window (`--spam` stacks it to x0.2). A Pistolet pair is two shots per 1.9 s, the off hand at x0.8 damage and -5 to hit; the Thunderlock is one shot per `0.5 s + reload`. Arrows and pellets carry no damage and are spent one per shot.

Spells: magnitude is `Range(base) + Range(level) * floor(level/perLevel)`; the target's saving throw and the school's past-100 potency (x1.4 at 200) are applied; PvE spells do not crit and armour does not reduce them. One magic round is 5 real seconds, so a DoT is priced as per-tick DPS; the page shows that separately. A 0.7 s cast recovery is the throughput floor. **Mana is treated as solved by default**; `--mana-limit` prices the pool instead.

Enchantments: a `Cast When Strikes` row fires its `SPELLS.STD` spell on every landed blow (no proc chance), with the target's save and the caster's spell power. `Potent Vs` is a flat +5 against its affinity; `Enhances Skill` is +15; `elemental` is flat per blow and `slayer` is group-specific. `build` and `report` show weapon DPS, enchant DPS and total DPS; the condition budget is reported as procs before break.

## Graphs

`graph` emits a standalone SVG chart. The live lines can be flat because gear stat affixes already hit the 100 cap; `--theory` lowers one channel at a time from that ceiling, so it shows what each point was buying.

```bash
# live character
./dfo-dps graph --save /tmp/live.json --target gate \
  --series stat:strength,stat:agility --from 50 --to 100 --step 5 --out stats.html

# theory character: what each attribute buys at the ceiling
./dfo-dps graph --theory --target gate \
  --series stat:strength,stat:speed,stat:agility \
  --from 50 --to 100 --step 5 --out theory-stats.html

# theory character: gear skill against the practical line budget
./dfo-dps graph --theory --target gate --series gear:29,gear:34 \
  --from 0 --to 540 --step 30 --out theory-gear.html
```

Series syntax is `stat:strength`, `stat:agility`, `skill:29`, `gear:29`, `star:strength`, etc. A `star:` series varies the Firmament channel from 0 to +15 while the base stays 100. The Y axis is capped DPS against the selected target, so the gate's per-hit cap is in the line, not hidden. Add `--uncapped` to plot raw DPS and see the full stat slope before the cap flattens it.

## Backstab and the 600s

A normal front crit on the live card is 189–290; **Backstab is 99% ×3**, so a critical backstab is **567–870**. That is the 600s you see. The tool was showing front swings only; `--behind` (100% behind) or `--backstab 0.5` (uptime) now adds it. The card's **Damage** and **Per swing** are front/opening values; the Backstab tile is separate.

The gate's server per-hit cap is **420** at level 30 (12 × `dpsRef` 35). A displayed 600 backstab is therefore **raw**; the health bar may only lose 420. If the bar really loses 600, the fight has a `relayBlowX` above 1.43 (Elite/Vestiges/might) or a different pool; model it with `--blow-x 1.5` (or the fight's factor). `--players n` scales the gate's health per player; the cap is per player.

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
- no loot set powers, sigils, legendary proc damage or First Blood; the simulation is for sustained boss DPS
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
