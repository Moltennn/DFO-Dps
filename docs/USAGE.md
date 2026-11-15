# Usage

This is the long-form workflow guide. The README is the quick start; `--help`
is the complete flag list.

## 1. Saves and character input

```bash
./dfo-dps saves
./dfo-dps doctor
./dfo-dps doctor --save SAVE4
```

`--save` takes a slot (`SAVE4`, `4`), a save folder, or a `SaveData.txt` path.
Without it the newest save is used. Save discovery uses `DAGGER_USER_DATA` when
set; otherwise it uses the client's platform user-data folder.

`doctor` prints the pinned model, the save it selected, the character and the
active rules (online/offline, path, mastered skills). Use it before reporting a
missing or surprising number.

A save is a snapshot. If the character's gear or gems changed in game, export a
live snapshot from the debug client and pass it as a JSON file:

```bash
./dfo-dps build --save /tmp/live.json --first-blow
```

The live shape the importer understands uses `equipSlots` and `_enchantMods`.
The capture helper is part of a debug client, not this repository. The live
Combat Stats card can include opening effects such as Duelist's Vambrace First
Blood; the simulation excludes that effect (the `--first-blow` flag is the
separate Assassin/Opening Strike scenario).

## 2. Rules and targets

```bash
./dfo-dps build --save SAVE4
./dfo-dps build --save SAVE4 --target tough
./dfo-dps build --save SAVE4 --target breach
./dfo-dps build --save SAVE4 --target boss --health 20000 --armor 60 --traits curbing,warded
```

- `soft`, `tough`, `armoured`, `human` are reference foes.
- `boss` is a generic boss: pass `--health`, `--armor`, `--traits`, `--level`.
- `breach` and `gate` are the real relay body and its per-player allowance.
  Their default traits come from the game's relay selector.
- `--players` and `--blow-x` apply to the relay targets.

Common combat switches:

```bash
./dfo-dps build --save SAVE4 --core classic
./dfo-dps build --save SAVE4 --offline
./dfo-dps build --save SAVE4 --no-rri
./dfo-dps build --save SAVE4 --swing StrikeUp
./dfo-dps build --save SAVE4 --behind
./dfo-dps build --save SAVE4 --backstab 0.5
./dfo-dps build --save SAVE4 --health-share 0.4
./dfo-dps build --save SAVE4 --self-health-share 0.4
```

`--swing` defaults to the game's six-way click/hold draw; a single direction
can still be pinned for an experiment. `--behind` is 100% back-facing uptime;
`--backstab <0..1>` is a fractional uptime. `--health-share` is the foe's
share for Axe/Blunt mastery and venom/execute; `--self-health-share` is the
wielder's share for Berserker/Orc Rage.

## 3. Build, rank, report, compare

```bash
./dfo-dps build --save SAVE4 --target breach
./dfo-dps build --save SAVE4 --target breach --json
./dfo-dps rank weapons --save SAVE4 --target breach --top 10
./dfo-dps report --save SAVE4 --target breach --out breach.html
./dfo-dps compare --save SAVE4 --stat strength=110
./dfo-dps compare --save SAVE4 --weapon 121:9
```

`build` prints the per-hit card, hit/crit, damage range, per-swing, DPS,
capped DPS, cap loss and TTK (where the target carries a pool). `rank weapons`
compares the melee templates and materials. `report` writes a standalone HTML
file (default `dfo-dps-report.html`). `compare` re-runs one stat/skill/weapon
change against the same scenario.

## 4. Scale and tradeoff

```bash
./dfo-dps scale --save SAVE4 --stat strength
./dfo-dps scale --save SAVE4 --skill 29 --from 100 --to 200 --step 10
./dfo-dps scale --save SAVE4 --all
./dfo-dps tradeoff --save SAVE4
```

`scale` walks one channel from its current value to its cap, or summarizes
every relevant channel with `--all`. `tradeoff` prints the speed-versus-damage
crossover and the best weapon at several Curbing boss health pools. These are
target-dependent; keep the same target when comparing runs.

## 5. Theory and the legal gear frontier

```bash
./dfo-dps theory
./dfo-dps theory --blade 121 --race redguard
./dfo-dps theory --vampire
./dfo-dps theory --firmament
./dfo-dps theory --gear-lb 250 --gear-cs 370 --blade 123
./dfo-dps theory --json
```

`theory` is a level-45 long-blade ceiling: attributes 100, raw weapon skill and
Critical Strike 200 mastered, online rules and RRI weapon balance. It prints
the stages, cap sheet, stat/skill curves, the long-blade ranking and the best
split of the **legal gear frontier**.

The maximised gear plan is not “30 points on every line”. It is constrained by
the game's line counts, skill kin, bands, Exalted law and the item slots; the
current default profile is shown by `theory --json` (`character.legal`,
`maxLb`, `maxCs`, `damage`). `--gear-lb` and `--gear-cs` take points, not line
counts. `--gear-lines` and `--line-points` are obsolete and only warn.

The current `theory` example at the default Dai-katana is roughly 1066.6
uncapped DPS, 815.4 capped DPS and a 76.0 s relay TTK; the exact figure changes
with the blade, race, stars and target flags.

`--firmament`, `--star-stat name=n`, `--star-skill id=n`, `--star-damage n`
price the Firmament channels. The star page is a channel-coverage plan, not a
proof of the global optimum.

## 6. Weapon ceiling page

```bash
./dfo-dps weapons
./dfo-dps weapons --categories
./dfo-dps weapons --vampire --firmament
./dfo-dps weapons --out /tmp/weapons.html
./dfo-dps skills                     # alias for the same page
```

The page compares every weapon template at the legal max profile, then shows
the family skill curves. It includes dual-wield pairs and the Hand Wraps fist
row. The default output is `weapons.html` (`skills.html` for `skills`).

The page is a ceiling model: the cap, the legal gear frontier and the planner
assumptions are visible in the columns and in `METHOD.md`.

## 7. Imprints and enchant planning

```bash
./dfo-dps imprints
./dfo-dps imprints --family LongBlade
./dfo-dps imprints --sort uncapped
./dfo-dps imprints --out /tmp/imprints.html

./dfo-dps enchant-plan --weapon 123
./dfo-dps enchant-plan --weapon 121 --soul-gem --out /tmp/enchant.html
./dfo-dps enchant-plan --all --cap-aware --soul-gem
./dfo-dps enchant-plan --all --uncapped --soul-gem
```

`imprints` ranks the Reforge's Rare imprint powers per weapon family. An
imprint is a Legendary power of the piece's group; the record's drop-template
list does not restrict which weapon can carry it. The table marks whether a
power is the same hit, an extra hit, another target, or utility.

`enchant-plan` reads the game's enchantment points and fills each piece inside
that budget. A single plan is cap-aware by default; `--uncapped` selects the
theory setup; `--all` prints the per-weapon-type matrix. `--soul-gem` adds the
5,000-point soul-gem channel to every piece. The weapon's condition also limits
how many Cast When Strikes rows it can pay for; `procsBeforeBreak` is reported.

## 8. Firmament and real loadouts

```bash
./dfo-dps firmament
./dfo-dps firmament --build longblade
./dfo-dps firmament --build bow,destruction --stars 60 --out /tmp/plans.html
./dfo-dps firmament --refresh

./dfo-dps loadout --uncapped
./dfo-dps loadout --cap-aware
./dfo-dps loadout --cap-aware --encounter skyketch
./dfo-dps loadout --cap-aware --all-encounters
```

`firmament` plans the real star tree for `longblade`, `shortblade`, `axe`,
`blunt`, `bow`, `fists`, `destruction` and `tank`. Plans are cached in
`.cache/firmament-plans.json` keyed by a source fingerprint; `--refresh`
recomputes.

`loadout` chains the real tree, the enchant plan and the best eligible
imprint. The capped side applies the encounter purse: depth `15 × ref`, refill
`3 × ref` per second, a `12 × ref` per-blow cap and a four-claims-a-second
hand. `ref = 5 + level`. The content names are **Breach**, **Sky-ketch** and
**Abyss**; the Abyss is marked uncalibrated.

## 9. Spells and weapon enchantments

```bash
./dfo-dps spell --save SAVE4 --spell Fireball
./dfo-dps spell --save SAVE4 --spell Wildfire --seconds 60
./dfo-dps spell --save SAVE4 --list
./dfo-dps spell --save SAVE4 --all-spells
./dfo-dps spells --save SAVE4 --out /tmp/spells.html
./dfo-dps spells --theory --potency 30 --pierce 10 --cast-speed 15
./dfo-dps enchant --save SAVE4
```

Spell records come from `ARENA2/SPELLS.STD` through the launcher's
`arena2Path` or `--data <dir>`. The page prices magnitude, saving throws,
school potency, cost, cast recovery and per-tick DoT damage. Mana is treated
as solved unless `--mana-limit` is passed.

`enchant` shows the equipped weapon's Cast When Strikes, Potent Vs and related
rows. CWS is an expected-value model, not a full proc scheduler; see the
limitations in the README and the `W-PROC-BUDGET` waiver.

## 10. Graphs and the Combat Probe

```bash
./dfo-dps graph --save SAVE4 --target breach \
  --series stat:strength,stat:speed --from 50 --to 100 --step 5 \
  --out /tmp/stats.html

./dfo-dps graph --theory --series star:strength --from 0 --to 15 --step 1

./dfo-dps probe
./dfo-dps probe some-capture.json
./dfo-dps probe --old
```

`graph` writes a standalone SVG chart (default `graph.html`). Series syntax is
`stat:name`, `skill:id`, `gear:id` or `star:name`. The Y axis is capped DPS
unless `--uncapped` is passed.

`probe` reads a capture produced by the separate Combat Probe mod under
`~/.local/share/dfo-tools/probe-mod`. It is not shipped in this repository.
`--old` reads `captures/old/`; the default reads only the live capture folder.
See `METHOD.md` for the capture fields and the estimate rules.

## 11. Outputs and JSON

HTML pages default to the current directory:

| Command | Default file |
|---|---|
| `report` | `dfo-dps-report.html` |
| `weapons` | `weapons.html` |
| `skills` | `skills.html` |
| `imprints` | `imprints.html` |
| `enchant-plan` | `enchant-plan.html`; `--all` → `enchant-plans.html` |
| `loadout` | `loadouts.html` |
| `firmament` | `firmament.html` |
| `spells` | `spells.html` |
| `graph` | `graph.html` |
| `probe` | `probe.html` |

Use `--out <file>` to override. Many table commands accept `--json`; use
`--help` for the exact command.

## 12. First-run troubleshooting

- **No saves found**: set `DAGGER_USER_DATA` or pass `--save` explicitly;
  `doctor` prints the path it used.
- **Spell page is empty**: `ARENA2/SPELLS.STD` is not configured; set
  `arena2Path` in the launcher config or pass `--data`.
- **The live card and the tool differ**: the live card can include opening
  effects and a different gear state; use a fresh snapshot and compare the
  same target/uptime.
- **A planner or spell number is unverified**: check
  the verification notes before relying on it for a decision.
