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

At the level-45 Breach the **600 per-hit cap**, not the character sheet, is the wall: the fully geared build is **~1,198 uncapped DPS**, but only **~821 capped DPS** and **~20.6 s TTK**. Past about 24 skill lines the extra damage is almost entirely eaten by the cap.

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
./dfo-dps weapons --firmament       # flat channel ceiling on the scaling charts
./dfo-dps weapons --out ~/dfo-weapons.html
```

The max profile is: attributes 100, raw weapon skill and Critical Strike 200 mastered, weapon skill gear 240 (8 lines), Critical Strike gear 540 (18 lines), a **Legendary damage affix** (20–40%; the max profile assumes the perfect 40 roll), **perfect diamond sockets** (short blade 1, one-handed 2, two-handed 3, +12% damage each), the weapon's own career expertise, **Dunmer** (the default race; `--race` overrides), and **Blademaster** for every family; Berserker's below-half upkeep is not assumed. Hand-to-Hand uses a pair of **Hand Wraps** (damage/sockets/procs carry the fist blow). The table also includes dual-wield pairs, both hands of the same one-handed weapon at the off-hand x0.8 / -5 hit terms. **Firmament DPS** is the real tree plan; **Boss DPS** is the same against the level-45 Breach's 600 per-hit cap. The 40% affix is the weapon's own Legendary `damage` affix (`AFFIX_RANGES.damage.legendary = [20,40]`), not a Firmament or enchant channel.
The cap is per player: a group scales the boss's health pool (each player
brings a share), not the cap. The first chart ranks the boss (Breach) DPS; the second ranks the uncapped DPS. Every DPS cell is the average.

`--categories` writes the condensed table to the same page: one row per weapon type in each slot, including the Hand Wraps fist row, sorted by DPS. The full page has a max-DPS bar chart and table, then one combined chart per family: raw training 100 -> 200 is effective 100 -> 140, and gear lines continue from effective 140 to 140 + the gear cap. One Critical Strike chart covers the best weapon of each family. The Hand-to-Hand row is the wrapped ceiling. Bare fists without Hand Wrap lines are the ~450 band the community tests saw.

`skills` is kept as an alias for the same page.

## Imprints and enchant planning

`imprints` ranks the Reforge's Rare imprints per weapon family. An
imprint is a Legendary power of the piece's own group, so **any weapon
Legendary may sit on any weapon**; only the power's own fit narrows it
(Chain Lightning needs a shot, Earthshaker a melee blow). A record's
template list is only which base a Legendary drops as. Each power is priced
on the best weapon of that family. **Boss** is the level-45 Breach (Daedra,
600 per-hit cap); **Uncapped** is the same weapon without the cap;
**Trigger** applies the power's condition where it can occur at the Breach
(low health, below half). Triggers that cannot happen there (undead,
dragons, unaware, night, a second foe) are marked and do not inflate the
boss column. Gains are against the row's **On** weapon. `--uncapped` sorts
by the uncapped gain; `--cap-aware` sorts by boss gain. Chain and quake are
one extra target and not single-target DPS; poison is before resistance.
**Many Endings** is an extra strike and therefore its own hit: it gets its
own cap, which is why it still gains at the Breach when Flow or Serpent's
Kiss do not. **Cast When Strikes** spells are separate hits too; Flow,
Serpent's Kiss, Potent Vs and the conditional damage powers ride the same
hit and share its cap. The table says which powers are `same hit`,
`extra hit`, `other target` or `utility`.

```bash
./dfo-dps imprints
./dfo-dps imprints --family LongBlade
./dfo-dps imprints --sort uncapped --firmament --out imprints.html
```

`enchant-plan` reads the game's own `enchantmentPoints` for every piece,
adds the stated **5,000** soul-gem channel when `--soul-gem` is used, and
fills each item inside that budget. It values everything on the **level-45
Breach** and its 600 per-hit cap, so a +skill or +damage effect that the cap
eats is not bought. Backstabbing is never planned: its ×3 is capped after
the roll, so +15 Backstabbing adds no capped boss DPS on the capped
weapons. The non-stacking effects are placed once (Strengthens Armor,
Absorbs Spells, Increased Weight Allowance). Repairs Objects is a count
(`--repairs`, default 1); Regens Health is off by default (`--regen 0`)
because heal spells are stronger. Both stack per piece when chosen. The page
also rates every candidate it considered (weapon proc DPS, +15 skill DPS,
and utility), so an empty piece is an explicit "nothing else added capped
DPS" result, not an omission. Strike payloads (Cast When Strikes, Potent Vs, Low
Damage Vs) are weapon-only; the weapon's own condition limits how many
Cast When Strikes rows the Breach fight can pay (10 condition a proc).
`--all` prints both setups per weapon type: **uncapped theory** (no
per-hit cap, weapon skill and Critical Strike on every piece) and
**cap-aware** (the level-45 Breach and its 600 cap, skill lines only where
their marginal DPS is positive). The weapon package is an exact knapsack
under the budget, 10-setting cap and proc limit. A single `enchant-plan`
defaults to cap-aware; add `--uncapped` for the theory setup or
`--cap-aware` explicitly. `--all --uncapped` or `--all --cap-aware` prints
only that setup. For melee, the uncapped layout is one template — only the
weapon-skill name changes.

```bash
./dfo-dps enchant-plan --weapon 123
./dfo-dps enchant-plan --weapon 121 --soul-gem --out enchant-plan.html
./dfo-dps enchant-plan --weapon 123 --soul-gem --group undead --repairs 2 --regen 0 --json
./dfo-dps enchant-plan --all --soul-gem                 # every weapon type
./dfo-dps enchant-plan --all --uncapped --soul-gem      # no boss cap
./dfo-dps enchant-plan --all --cap-aware --soul-gem     # current-cap skill buying
```

The base set is the weapon, the seven armour pieces, a shield when the
weapon is one-handed, and the jewellery pairs (amulet/torc, two rings,
two bracers, two bracelets, two marks). The soul gem is applied to every
piece in this plan; without it, the template points alone are used.

## Firmament trees

`firmament` plans the real 518-star sky for a build, using the game's own
tree, adjacency and channel caps. It walks connected paths, never through a
keystone, and spends at most the 98-Star purse. It does not assume Craft
points, and it stops as soon as no remaining star adds to the build; the
free points are the player's.

```bash
./dfo-dps firmament                              # all eight builds, writes firmament.html
./dfo-dps firmament --build longblade            # one build
./dfo-dps firmament --build bow,destruction --stars 60 --out plans.html
./dfo-dps firmament --build tank --json
```

Builds: `longblade`, `shortblade`, `axe`, `blunt`, `bow`, `fists`,
`destruction`, `tank`. Plans are cached in `.cache/firmament-plans.json`
keyed by a source fingerprint; the first run computes, later runs reuse.
`--refresh` recomputes. The page shows the lit tree, every channel the build
cares about, and the notables/keystones on the path. It is a deterministic
channel-coverage plan, not a solver proof: the weapons page `+ Firmament`
column is the flat channel ceiling (+15 STR/AGI/SPEED/LUCK, +15 weapon /
Critical Strike, +30% blow), and a real path may leave some of those short.
The planner excludes `unawareDmg`, `rageDmg` and Backstabbing for boss
builds. It also rejects off-family notables and keeps each build in its own
sign sectors; a small or road star on the path can still act as a connector,
but it is not scored for its unrelated stat. Flat and percent points are
**one channel**: `firmamentPowers.js` adds a key star's flat points to a
small star's percent and caps the sum at +15. That applies to attributes and
to combat skills, including Critical Strike — the tree cannot take Critical
Strike past +15.

## Real loadouts

`loadout` is the actual DPS chain: the real Firmament tree, then the enchant
plan, then the best eligible imprint. It applies the tree's flat + percent
channels together at the live cap (so +15 flat and +15% are **one** +15
attribute/skill channel, not +30), then the +15 weapon skill / Critical
Strike enchant lines, then the imprint.

The capped side also applies the boss **purse**, which is the boss body's own
law and is always on:

- depth **15 x reference**, refill **3 x reference a second**
- per-blow cap **12 x reference**, and **4 blows a second** (four in hand,
  four a second back)

The reference is `5 + level`, so at level 45 the purse is 750 deep, refills
150/s, caps a blow at 600 and allows four blows a second. The purse starts
full only when you join at 100% boss HP. Above the refill rate every build
converges; the differences become burst and time-to-kill, not raw DPS.

The page lists **every weapon template** in every hold configuration --
1H, 2H, DW, or Fists -- for both modes, and uses the columns: **Family,
weapon, imprint, Total DPS, Burst 5s, Avg DPS, TTK, Purse kept**. Total DPS
is the per-hit-cap ceiling; the other four apply the purse. Monster-type
damage imprints (dragons/giants, undead, animals) are not used in the
loadout; an empty imprint means no positive-unconditional imprint fits. The
page also carries the shared enchant template, the imprint ratings and the
Firmament plans used.

```bash
./dfo-dps loadout --uncapped                    # theory: no per-hit cap
./dfo-dps loadout --cap-aware                   # Breach purse
./dfo-dps loadout --cap-aware --encounter skyketch
./dfo-dps loadout --cap-aware --all-encounters  # Breach, Sky-ketch, Abyss
```

The content names are **Breach**, **Sky-ketch** and **Abyss**. Elite Breach
is currently bugged and is not offered. The Sky-ketch's immune windows and the
Abyss's phase split are not calibrated yet; those sections are marked
"uncalibrated mechanics" and their TTK is the purse-only baseline.

The table is tree + enchants + imprint, assumes a soul gem on every piece,
and lists every weapon template separately in each hold it supports.

## Combat probe

The purse numbers above are the source's law; the Sky-ketch's immune windows
and the Abyss's gold/silver split are not. A local, read-only probe records
the boss bar at 10 Hz so those can be fitted rather than guessed. It is not
part of the mods repo: its source lives in
`~/.local/share/dfo-tools/probe-mod`, with an ignored symlink at
`DFO-Mods/probe-mod`. The loader still discovers it like any other mod.

It records automatically. The mod starts on load, opens a fight when the boss
bar appears, and writes the capture at the fall to
`~/.local/share/dfo-tools/logs/probes/` through a local sink: **no save
dialog**. The filename is
`<user>-<level>-<activity>-<yyyy-mm-dd-hh-mm>.json` (for example
`moltenn-45-breach-2026-11-04-02-35.json`). The pane (ESC -> Mods -> Combat
Probe) has **Pause/Resume**, optional **Download last / Download saved**, an
optional download-copy toggle and a content-label override. It reads
`.wb-boss-fill` and `.wb-boss-half`, records the fight-end chart as a
cross-check, and never changes a game value or sends anything off the
machine.

**Level** comes from `window.__playerEntity` (the Skill Tracker's skyhook
keeps it set) or the boss bar's level text. **Group size** comes from the
fight-end damage-chart rows, or the bar's "n on the deck" count. No manual
level or player count is needed; the capture carries both.

```bash
./dfo-dps probe                         # the latest saved capture
./dfo-dps probe moltenn-45-breach-....json
# --level / --players only override an old capture's auto values
```

The reader uses the health bar, not the chart, for landed damage, burst and
no-damage gaps. The chart is compared afterwards; it counts phase-shield and
add damage, so it is not the ground truth.

## Bows, firearms, spells and enchantments

The same model now covers the other damage lanes:

```bash
# bows (Short Bow 129, Long Bow 130) and the port's guns (560 Thunderlock, 562 Pistolet)
./dfo-dps build --save /tmp/live.json --weapon 129:9 --target breach
./dfo-dps build --save /tmp/live.json --weapon 562:4 --pair --target breach
./dfo-dps build --save /tmp/live.json --weapon 129:9 --spam --target breach
./dfo-dps build --save /tmp/live.json --dual --target breach

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

Enchantments: a `Cast When Strikes` row fires its `SPELLS.STD` spell on every landed blow (no proc chance), with the target's save and the caster's spell power. A DoT proc refreshes on the target and is priced at its per-tick DPS (`dotTick / 5`), not its whole duration per blow — otherwise Wildfire would read as thousands of DPS. `Potent Vs` is a flat +5 against its affinity; `Enhances Skill` is +15; `elemental` is flat per blow and `slayer` is group-specific. `build` and `report` show weapon DPS, enchant DPS and total DPS; the condition budget is reported as procs before break.

## Graphs

`graph` emits a standalone SVG chart. The live lines can be flat because gear stat affixes already hit the 100 cap; `--theory` lowers one channel at a time from that ceiling, so it shows what each point was buying.

```bash
# live character
./dfo-dps graph --save /tmp/live.json --target breach \
  --series stat:strength,stat:agility --from 50 --to 100 --step 5 --out stats.html

# theory character: what each attribute buys at the ceiling
./dfo-dps graph --theory --target breach \
  --series stat:strength,stat:speed,stat:agility \
  --from 50 --to 100 --step 5 --out theory-stats.html

# theory character: gear skill against the practical line budget
./dfo-dps graph --theory --target breach --series gear:29,gear:34 \
  --from 0 --to 540 --step 30 --out theory-gear.html
```

Series syntax is `stat:strength`, `stat:agility`, `skill:29`, `gear:29`, `star:strength`, etc. A `star:` series varies the Firmament channel from 0 to +15 while the base stays 100. The Y axis is capped DPS against the selected target, so the Breach's per-hit cap is in the line, not hidden. Add `--uncapped` to plot raw DPS and see the full stat slope before the cap flattens it.

## Backstab and the 600s

A normal front crit on the live card is 189–290; **Backstab is 99% ×3**, so a critical backstab is **567–870**. That is the 600s you see. The tool was showing front swings only; `--behind` (100% behind) or `--backstab 0.5` (uptime) now adds it. The card's **Damage** and **Per swing** are front/opening values; the Backstab tile is separate.

The Breach's server per-hit cap is **420** at level 30 (12 × `dpsRef` 35). A displayed 600 backstab is therefore **raw**; the health bar may only lose 420. If the bar really loses 600, the fight has a `relayBlowX` above 1.43 (Elite/Vestiges/might) or a different pool; model it with `--blow-x 1.5` (or the fight's factor). `--players n` scales the Breach's health per player; the cap is per player.

## Theorycraft numbers

`--target breach` uses the real solo Breach boss: **240 seconds of reference damage** at your level, i.e. **8,400 HP at level 30** (`dpsRef(level) = 5 + level`), plate armour 60, a **420 per-blow server cap** (12 x reference), and **two 3s phase shields**. It has no Curbing; Curbing is a separate trait on elite/world bosses and is 5% of max HP.

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
- weapon enchantment rows: `Cast When Strikes` procs (DoTs priced per tick), `Potent Vs`, `Enhances Skill`
- the Reforge's 13 Weapon Legendary powers as imprints, priced on the capped and uncapped blow
- boss traits: Curbing, Warded, Bladeturning, Stoneskin, Thorned, Wrathful
- time-to-kill and cap loss

## Deliberate limits in v1

- damage is shown **before the foe's worn/natural armor reduction**, exactly
  like the game's Combat Stats card; a human in mail will take less
- the overhaul's condition-based effectiveness is assumed at 100% condition
- no loot set powers, sigils or First Blood; the simulation is for sustained boss DPS
- the breach, Sky-ketch and Abyss purse is modelled (15x deep, 3x a second, 12x a blow, 4 blows/s); the Sky-ketch's immune windows and the Abyss's gold/silver split timing are not calibrated yet
- a Legendary record's own affixes and enchantment are not folded into an imprint; the Rare keeps its own lines and gains the power alone
- Elite Breach is currently bugged and is not modelled or offered
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
