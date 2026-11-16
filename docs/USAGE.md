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
how many Cast When Strikes bills it can pay in full; `procsBeforeBreak` reports `floor(condition / 10)` and is labelled
`procsBeforeBreakBasis: "cws-bill-only"` in the JSON of both `build --json` and `enchant --json`. It ignores ordinary weapon wear (paid first, every blow) and is not a count of casts
before the weapon breaks; take break odds and lifetimes from `simulateFights({ durability: true })`.

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

## 11. Stochastic fight simulation (library)

Stage 3.2 adds a seeded, blow-by-blow simulation over the Stage 3.1 per-blow
distribution. It is a library API, not a CLI command.

```js
import { simulateFight, simulateFights, simulatePairedFights, pairedFightSeeds } from './src/simulateFight.js';

// ch, target and item are your build, foe and weapon (weaponOf comes from src/model.js)
const scenario = { target, health: 12000, weapon: weaponOf(item), seed: 1 };

// one fight (add trace: true to inspect every blow)
const one = simulateFight(ch, scenario);
one.ttk; one.damageDealt; one.overkill; one.remainingHealth; one.blows;

// a distribution: 2,000 independent fights from one seed stream
const many = simulateFights(ch, { ...scenario, trials: 2000 });
many.ttk.mean; many.ttk.median; many.ttk.p10; many.ttk.p90; many.ttk.ci95;
many.kills; many.censored; many.killProbability; many.damageDealt.mean; many.overkill.mean;

// two builds on the SAME seed list
const seeds = pairedFightSeeds(2000, 7);
const paired = simulatePairedFights([{ id: 'a', ch: a }, { id: 'b', ch: b }], { ...scenario, seeds });
```

- `damageMode: 'capped'` samples the per-hit-capped blow; the default is
  `uncapped`, matching `fight()`.
- `simulateFight` reports `killDps = health / ttk` and
  `outputDps = damageDealt / time`; a run that reaches `maxSeconds` (or
  `maxBlows`) with the pool alive is **censored** (`ttk: null`).
- `simulateFights` returns `ttk`/`ttkConditional` and `killDps` **conditional
  on a kill**, plus `killProbability` (a Wilson interval) and
  `horizonSeconds`. With censoring, do not read the conditional TTK as an
  unconditional one; the per-trial `rows` keep `kill`, `ttk` and `time`, so a
  Kaplan-Meier fit can be made by the caller if needed.
- A ranged first hit is the upstream machine's: a gun on frame 1 of its 14 fps
  clock, a bow on frame 5 of the classic draw clock (2 when it starts drawn,
  5 with BowDrawback). Stage 3.4.2 refuses bow and gun builds in
  `simulateFight` and `simulateRelayFight`; only the schedule helper still
  resolves the frame for the machine-clock test.
- Axe/blunt mastery, venom and execute rebuild the blow table when the foe's
  health crosses 0.5 or an execute threshold.
- Dual builds follow `dualSchedule`; a Pistolet pair throws instead of being
  approximated. Wear, CWS, DoTs, Flow, the relay bucket/ward and incoming
  damage are outside this stage (the assumptions register M29).
- 1,000 fights at a 12,000 pool take about 3 seconds in Node 22.

## 12. Relay claim engine (library)

Stage 3.3 adds a streaming implementation of the relay's per-player claim law. It consumes one claim at a time; it
does not precompute a DPS approximation and keeps no claim history.

```js
import { createRelayClaimEngine } from './src/relayClaim.js';
import { simulateRelayFight, simulateRelayFights } from './src/relayFight.js';

const engine = createRelayClaimEngine({ level: 45, share: 12000 });
const r = engine.claim({ t: 0.5, damage: 700 });
r.accepted; r.got; r.reason; r.capClip; r.bucketClip; r.healthClip;
r.bucketAfter; r.tokensAfter; r.hpAfter;
engine.summary(); // counters + remaining bucket/token state, no history

// a seeded relay fight: Stage 3.2's schedule and Stage 3.1's tier, with the relay's cap/bucket
const fight = simulateRelayFight(ch, {
  target: gateTarget(45, { health: 2000 }), health: 2000, weapon, seed: 7, trace: true,
});
fight.claims; fight.accepted; fight.refused; fight.damageDealt; fight.overkill;
fight.offered; fight.clipped; fight.refusedDamage;
fight.saturated; fight.dryAt; fight.bucket; fight.ttk; fight.killDps;
fight.time; fight.claimTime; fight.lastAttackAt; fight.termination; fight.censored; fight.censoredAt;
```

- `claim({t, damage})` takes `t` in seconds (the source uses milliseconds). A claim is a positive formula blow; a
  zero-damage miss is not a claim and spends no token. The claim is the uncapped sampled blow: the relay's
  `12 x ref` cap is the first cap it meets. Stage 3.4 adds the Potent Vs-miss, Flow and Many Endings cases in §13.
- `fresh: false` models a join to a wounded boss (empty damage bucket). `shieldUntil` is a fixed window in seconds;
  a claim at exactly its end is accepted. Phase-ward lifecycle is not scheduled.
- The engine refuses an unarmed build (the Stage 3.2 schedule guard). Flow and one Many Endings power are added in
  §13; a synthetic two-echo build is refused. Geometry, Sundered halves, Wrath, host/crystal claims, CWS/DoTs, ward
  lifecycle and wear are outside this stage.
- `time` is the fight's elapsed time, independent of the claim clock: the killing claim on a kill, `maxSeconds` when
  the horizon censors the fight, and the last simulated attack when `maxBlows` stops it earlier (a blow-budget stop is
  not reported as the horizon). `claimTime` is the engine's last claim timestamp. `outputDps = damageDealt / time`
  covers every trial (0 when no damage landed, null at zero elapsed); `killDps` remains conditional on a kill. On a
  kill the relay deals exactly the pool, so `outputDps = killDps`; `overkill` is the killing claim's health clip.
- `simulateRelayFights` reports the conditional TTK, `killProbability`, accepted/refused claims, damage, clipping,
  saturation, elapsed time and termination counts across seeded trials. `offered = dealt + clipped + refusedDamage`; a refused
  claim's damage is not in `clipped` because the game never reached the purse.

## 13. Flow and Many Endings in relay fights (library)

Stage 3.4 adds the two loot mechanics to `simulateRelayFight`; the claim engine is unchanged.

- **Flow** is global across hands. Stacks expire strictly at `flowUntil`, a whole blow with pre-pull, pre-trait positive formula damage refreshes them for 6 s,
  and the cap is the power's `max` (5). The stack count is read before the blow and passed through
  `blowFightTier`'s `flowStacks` option, which applies it inside `lootBlow`'s percentage. A non-whole off-hand blow
  does not charge Flow; a warded attack neither charges nor claims. A Flow power only rides the hand whose weapon
  carries it.
- **Many Endings** is one echo roll per power on a blow whose final formula damage is positive, at the power's chance
  (10%). The echo is `max(1, round(damage))`, resisted separately from the original blow, and on a relay body it is
  included in the **same** claim (`outcome.blow`), not sent as a second claim. A synthetic two-echo build is refused.
- Claims are sent when the host damage is positive and `Math.round(blow) >= 1`; a Potent Vs miss is a 5-point
  claim, while zero damage sends nothing. The Flow/echo listener gate is the earlier pre-pull, pre-trait formula
  damage (`formulaPositive`), not the rounded/post-trait blow. A warded attack (`t < shieldUntil`) is sampled and discarded; at exactly
  `shieldUntil` it is accepted.
- `simulateRelayFight` returns `flow` (`stacks`, `held`, `until`, `max`, `seconds`), `flowBuilds`, `wardedAttacks`,
  `zeroDamage` and `roundedZero`; each trace claim carries `hit`, `whole`, `echoMask`, `echoHits`, `stacksBefore`,
  `stacksAfter`, `flowUntil` and `flowBuilt`.
- The flow is deterministic (no RNG stream); the echo is part of the existing single `blow` sampler draw, so a build
  with neither mechanic keeps its Stage 3.3 draw sequence.
- Bows and guns are refused until their release/landing timing and ward/Flow behaviour are modelled. A build with
  Many Endings requires `target.relayBody` before the first attack; the check is not deferred to an RNG-dependent
  event.

```js
const r = simulateRelayFight(ch, {
  target: gateTarget(45, { health: 2000 }), health: 2000, weapon, seed: 7, trace: true,
});
r.flow; r.flowBuilds; r.trace[0].stacksBefore; r.trace[0].echoHits;
```

## 14. Outputs and JSON

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

## 15. First-run troubleshooting

- **No saves found**: set `DAGGER_USER_DATA` or pass `--save` explicitly;
  `doctor` prints the path it used.
- **Spell page is empty**: `ARENA2/SPELLS.STD` is not configured; set
  `arena2Path` in the launcher config or pass `--data`.
- **The live card and the tool differ**: the live card can include opening
  effects and a different gear state; use a fresh snapshot and compare the
  same target/uptime.
- **A planner or spell number is unverified**: check
  the verification notes before relying on it for a decision.
