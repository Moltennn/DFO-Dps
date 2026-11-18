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

## Metrics

The project names a metric instead of reporting one bare "DPS". The card
(`analyze`) is an **expectation** over the foe's state; the seeded fights sample
whole fights and report distributions.

| metric | field | what it is for |
|---|---|---|
| uncapped | `dps`, `perSwing` | the blow at full foe health, before the per-hit cap: the Combat Stats card's rate |
| per-hit-capped | `cappedDps`, `cappedPerSwing` | the same blow after the cap; a **ceiling**, not what a relay accepts |
| ceiling (card total) | `ceilingTotalDps`, `ceilingTotalTtk` | capped weapon rate plus the proc estimate before the shared budget; the ceiling TTK is also `totalTtkCapOnly` |
| allowance-sustained | `claimSustainedDps` | `allowance.sustainedDps`: the existing steady-state estimate, refill-limited when saturated; null without a run |
| allowance-sustained TTK | `claimTotalTtk` | `allowance.ttk`: time to kill on the expected claim schedule; null without a run or kill inside the horizon |
| opening burst | `allowance.burst5Dps` | the first 5 s while the relay purse is full |
| carried sustained mean | `carriedDps`, `carriedCappedDps` | a held item's long-run mean of a percentage line (the exact share, not the card's per-blow floor); pricing reads this |
| sampled fight | `stochastic-ttk`, `kill-probability` | seeded `simulateFight` trials: kill rate with a mean-TTK interval, or the share that kills inside the horizon (Wilson) |
| sampled relay | `stochastic-relay` | the same over `simulateRelayFight` claims |

The ceiling and the allowance-sustained run are different questions, so the CLI
and the HTML report print both when the target has an allowance, each labelled
(`ceiling` vs `allowance-sustained`), and add a one-line note when they differ by
more than 1% - the note says the ceiling can promise a kill the allowance
refuses only when the claim figure is null or longer; otherwise it states the
percentage. Without an allowance the kill time is labelled as the per-hit-capped
ceiling. On an allowance target `totalTtk` is `claimTotalTtk`, even when null.
`totalDps` uses `claimSustainedDps` when the run exists and the ceiling otherwise.
When sustained, the default has no band (`totalDpsMin`/`totalDpsMax` are null);
the pre-budget band is always available as `ceilingTotalDpsMin`/`ceilingTotalDpsMax`.

Below the refill the claim TTK can be ~0.5% SHORTER than the ceiling, and that
is the claim schedule's discretisation, not a proc effect:

- claims land on a grid of `interval = 1 / (aps x hit)` (the first at one
  interval), so the run ends on the first claim whose cumulative damage covers
  the pool - up to one `perClaim` of overkill (6.25 HP = 0.096 s on the weak
  level-45 fixture);
- a phase shield is charged by the card as its full `shieldS`; the claim run
  only loses the claims that fall strictly inside it, so a 3 s shield costs
  `floor((3 - eps) / interval) x interval` (4 x 0.615 s = 2.462 s on that
  fixture, 8 refused claims over two shields) rather than 3 s.

Difference = 6 - 8 x 0.6154 - 6.25 / 65.032 = 0.9807 s, exactly the
190.5241 -> 189.5434 s measured there (refused-claim damage / offered DPS is
the same quantity on a multi-stream build). `W-PROC-BUDGET` records what
remains: the explicit ceiling applies the per-hit cap to procs and the merged
round, but sums their rates without the shared blow tokens or purse.

`fight` and `fightRelay` are deterministic walks of the same health-dependent
model; `snapshot`, `fight`, `relay` and `relay-ceiling` are the four
deterministic ranking objectives; these keep their own metrics. In particular
`fightRelay` and the `relay`/`relay-ceiling` objectives use weapon-only claims,
not the card's proc-inclusive totals. Pricing/loadout card baselines and the
benchmark's `cardDps` selector keep the pre-budget ceiling. The separate
loadout purse summary (including its weapon-TTK fallback) is unchanged.
The sampled objectives start at 1,000 trials
(the audit's first pass; 10,000 for a reported mean) and rank on the same seeds;
a censored trial is reported as kill probability, never folded into the mean.
See the [README](README.md) and [docs/USAGE.md](docs/USAGE.md) for the
commands and target flags.

## The level-45 theory character

`theory` is the live ceiling. Attributes are 100 (the `liveStat` clamp), Long Blade, Critical Strike and Backstabbing are mastered at raw 200 (`effectiveSkill` = 140), the weapon is a Daedric Dai-katana, online rules are on, and RRI weapon balance is on. It uses no community assumptions and no legacy strength model.

A gear skill line is modelled at the legendary maximum of 30 points (`AFFIX_RANGES.skill.legendary`). The practical ceiling is the **legal gear frontier** (`src/gearProfile.js`): Long Blade and Critical Strike line counts, skill kin, bands, the one-Exalted-line law and the item slots bound it. The long-blade ceiling is **535 points per skill / 620 together**, not 780; reaching it needs perfect rolls on 18 pieces. The weapon damage line is part of the legal frontier too; the current default Dai-katana profile uses **25%**, not a blanket 40% band top. `theory --json` prints the profile it used (`character.legal`, `maxLb`, `maxCs`, `damage`). `--gear-lb` and `--gear-cs` take points; `--gear-lines` and `--line-points` are obsolete.

The level-45 Breach is `240 x 50 = 12,000 HP` with a `12 x 50 = 600` per-hit cap. The current default `theory` run reports roughly **1066.6 uncapped DPS**, **815.4 capped DPS** and a **76.0 s relay TTK**; the exact figures move with the blade, race, stars and target flags. The cap still binds most blows, which is why another skill line buys little at the Breach.

### The Firmament's channels

`statMods.js` caps a base attribute at `MAX_STAT_VALUE = 100` plus `statMaxMods`; `firmamentPowers.js` sets `statMax` equal to the star gain, so a +15 channel reads 115. A gear stat affix is only `_mods.stats`, so it fills that headroom but cannot create it. `skillSoftcap.js` hard-caps raw skill at 200 and `effectiveSkill(200) = 140`; `firmamentPowers.js` adds its +15 to the post-softcap value, and gear skill adds on the same channel. The sheet prints `permanentSkillValue + skillModOf`, which is why a 200 raw skill can show 215 with stars or 455 with gear, while the formula reads 155 or 395. In the damage model, the Long Blade post-cap channel is converted at 0.44% per point, capped at +320% (`weaponGearPct`); Critical Strike's post-cap points add 0.01 to the critical multiplier each. The sky's separate weapon-blow channels (`firmamentLaw.js blowPct`) add up to +30% general, or +50% with the unaware/rage conditions, and are modelled as another blow multiplier.

The `theory` command prices each star channel from +0 to +15. At the ceiling, Strength is the only attribute that still pays (damage plus RRI swing speed); Speed is clamped to 98/100; Agility moves only on integer thresholds; Luck's critical divisor steps at 125, so +15 from 100 does nothing.

## Weapon-ceiling page

`weapons` renders the same model as a standalone HTML page. The first chart is boss (level-45 Breach) DPS; the second is uncapped DPS. DPS values are averages. `--categories` condenses the table to the best of each weapon type (Long Blade, Short Blade, Axe, Blunt Weapon, Archery, Hand-to-Hand) in the 1H, 2H and dual slots, sorted by DPS. The table uses the real Firmament tree (`applyTree`), not a flat `+Firmament` ceiling; the loadout page adds enchants and imprints. It ranks every weapon template (melee, bows and the port's firearms) at the legal max profile: attributes 100, raw weapon skill and Critical Strike 200 mastered, the legal frontier's gear points and damage line, the weapon's career expertise, Dunmer (the default; `--race` overrides), and the best martial path for the family. It shows raw 100 -> 200 and the legal gear curves per family. Every family uses Blademaster at full health; Berserker's below-half upkeep is not assumed. Blunt keeps its own at-or-above-half mastery. The Hand-to-Hand row is the Hand Wraps ceiling (damage/sockets/procs); bare fists without wrap lines are the lower band the community tests saw. The legal H2H gear cap is 17 lines (seven armour pieces and ten jewellery slots, never a weapon). The damage line is a weapon roll, separate from Firmament and enchant channels.

## Imprints and the item maker

`imprints` reads the weapon Legendaries' powers from the game
(`lootRarity.js`). A Rare's imprint is the power of a Legendary of its own
group, so **any Weapon Legendary fits any weapon**; a record's template list
only says which base a Legendary drops as. Only the power's own fit narrows
it: Chain Lightning fits a shot, Earthshaker a melee blow (the game's
`validImprint` -> `recordFitsGroup` + `powerFits`). Each power is priced on
the best weapon of the family, at the max profile. **Boss** is the level-45
Breach (Valkynaz Ruhn is a Daedra; 600 per-hit cap); **uncapped** is the same
weapon with no cap. The **trigger** column applies the condition only where
it can occur at the Breach; conditions that cannot (undeath, dragons,
unawareness, night, a second foe) are marked. Utility powers (spell cost,
magicka on a kill, spell damage) show 0 melee DPS. **Many Endings** is
special: on a relay body the echo is owed into the **same** claim and shares
the blow's cap, while on an ordinary foe it is its own hit. The imprint
ranking still prices it as a separate capped hit; treat that column as a
pricing convention, not the relay law (the assumptions register M23). Cast When
Strikes spells are separate claims on a relay body; chain/quake hit other
targets separately. Flow, Serpent's Kiss, Potent Vs, bane, sanctified, moon,
rage and the other same-hit modifiers share the main hit's cap. The imprint
table prints each power's `Hit` class.

`enchant-plan` imports the game's enchantment cost table
(`enchantmentCatalogue.js`) and item `enchantmentPoints`
(`ItemTemplates.json`, vendored). The budget is the template's points plus
5,000 per piece when `--soul-gem` is used. Powers are positive and side
effects negative. The plan is a boss-first priority fill: the level-45 Breach and its 600
per-hit cap price the skills and strike procs; Backstabbing is excluded
(the ×3 is capped after the roll). One-piece effects (Strengthens Armor,
Absorbs Spells, Increased Weight Allowance) are placed once; Repairs Objects
is a player-chosen count and Regens Health is optional (off by default, since
a heal spell is stronger). Both stack per piece when chosen. The item cap is ten settings. Cast When Strikes rows are limited by the
weapon's hitPoints and the Breach fight's swing count (10 condition a proc),
so a 100-condition test blade does not get six procs. The game's stacking rules are
respected: Strengthens Armor is a min-set, Absorbs Spells is a boolean, and
Increased Weight Allowance takes the maximum. The page also rates the
weapon procs, +15 skills and utility effects it considered, with the chosen
count, so an empty piece is visible as a choice. `--all` builds the matrix
per weapon family; `--uncapped` prices the same plans without the Breach cap.
`--all` prints two setups: uncapped theory (no cap, weapon skill and
Critical Strike on every piece) and cap-aware (the Breach, marginal skill
buying). A single plan defaults to cap-aware; `--uncapped` selects theory.
The weapon package is solved as an exact knapsack (budget, 10 settings, proc
limit). Armour/jewellery skill lines are forced in theory mode and taken by
their next marginal DPS in cap-aware mode.

## Firmament planner

`firmament` imports the game's own `firmamentTree.js` and `firmamentLaw.js`
(vendored under `vendor/firmament/`), so the nodes, signs, adjacency, channel
caps and `treeStats`/`blowPct` reads are the live ones. A build is a weighted
set of channels; the planner walks the sky one connected path at a time,
taking the path with the best channel gain per star, and stops when no
remaining star adds to the build. The unused points are shown as free stars.
It excludes `unawareDmg`, `rageDmg` and Backstabbing for boss builds, and
rejects off-family notables and off-sector targets; small/road connectors may
still carry unrelated stats but are not scored. A key star's flat points and
a small star's percent are folded into **one** channel and capped at +15
(`firmamentPowers.js`), including Critical Strike; the tree cannot take
Critical Strike past +15.
Keystones are reachable but never walked through, and life stars on the route
are paid from the same Star purse because no Craft points are assumed.

`--build` selects one or more of `longblade`, `shortblade`, `axe`, `blunt`,
`bow`, `fists`, `destruction`, `tank`; `--stars` caps the purse; the HTML page
draws the lit tree against the sky and lists the channels and the
notables/keystones taken. It is a channel-coverage plan, not a proof of the
global optimum, and it does not replace the flat `+ Firmament` ceiling used by
the weapon page.

## Real loadout

`loadout` applies the real tree to the max character first. Firmament powers
fold a key star's flat points and a small star's percent into **one**
channel capped at +15 (`firmamentPowers.js`); the loader does the same, then
sets the blow group, then applies the enchant plan's +15 skill lines and
strike rows, then the best eligible imprint. The page lists every weapon
template in every hold configuration per mode, and shows Family, weapon,
imprint, Total DPS, Burst 5s, Avg DPS, TTK and Purse kept. Monster-type
damage imprints are excluded from loadout selection. It also carries the
shared enchant template, imprint ratings and Firmament plans.

The capped side applies the boss purse (`net/gate/gateBrain.js`,
`bossBody`): depth `15 * ref`, refill `3 * ref` a second, per-blow cap
`12 * ref`, and a four-blow token bucket (`ref = 5 + level`). The share is
`240 * ref` per player for Breach and Abyss and `600 * ref` for Sky-ketch.
Content names only: **Breach**, **Sky-ketch**, **Abyss** (`--encounter`,
`--all-encounters`). Elite Breach is bugged and not offered. The Sky-ketch is calibrated from one solo capture (6.6 s opening immunity
and a 35.2 s The Discord window). The Abyss is still marked uncalibrated
until a capture is available. The breach capture shows warded Ruhn's
Blade/Flame windows beyond the source's 3 s shields; those are not in the
TTK model.

## Combat probe

`probe` reads the newest live capture, or `--old` for `captures/old/`. The gate
hook is only read for a Breach fight; a Sky-ketch or Abyss capture never
inherits the previous breach's gate or chart.

`probe` reads a local Combat Probe capture (the mod is not in the mods repo;
its source is in `~/.local/share/dfo-tools/probe-mod`). The probe starts on
load, records each boss bar automatically, and writes the fight at the fall
to `~/.local/share/dfo-tools/probe-mod/captures/<user>-<level>-<activity>-<yyyy-mm-dd-hh-mm>.json`
through a local sink, with no save dialog. It samples the boss bar every
100 ms and records the content, the main fill, the `.wb-boss-half` split
fills, the no-damage gaps, the callout/move/marks/ward state, the full
fight-end chart (HTML plus every cell) and the player's entity at start and
end, including the main/off-hand items and their imprint id, so two runs with
different weapons can be told apart. A local patch to the client gate-state builder records the absolute
`hp`, `max` and `fighters`; that makes the HP and DPS exact instead of the
top-10 level estimate. If the anchor is missing the probe still runs on the
bar. The level is
`window.__playerEntity.level` (kept set by the Skill Tracker's skyhook) or
the bar's level text; the group size is the bar's "n in the court" / "n on
the bridge" count, not the damage chart (the chart is a top-10 list). The
chart's levels fill the known players; the rest are filled at their median
level, and the report marks the estimate with a tilde. Both are in the
capture; the CLI `--level` and `--players` only override them.
`src/probe.js` splits the samples into pulls, derives landed damage from the
health bar and the content's share, and reports DPS, the first-five-second
burst, the largest single sample step (a cap probe), the no-damage share (an
immunity probe) and the split halves. A slow weapon's normal between-blow gap
is estimated from the median time between damage samples and excluded from
the immunity count. The fight-end chart is captured for audit only: `dealt`
includes phase-shield and add damage, so it is not used for the fit.

## Ranged, spells and enchantments

Gear sockets are modelled: a rare/legendary weapon has 1/2/3 sockets (short/one/two hands) and a perfect diamond is +12% damage; armour and jewellery take one stat/resist socket. Hand Wraps (template 563) carry damage/sockets/procs onto the fist blow. Dual wield averages the main and off-hand cards, the off hand at x0.8 damage and -5 hit. The skill chart is one line per weapon: raw 100 -> 200 is effective 100 -> 140, gear continues to 140 + cap.

The model's other lanes follow the same source snapshot. Bows use the port's BOW-LAW cycle (the five-frame swing law's frame, the drawn-idle release and the reload) and the BOW_FAST pacing window; guns use `frames/fps + reload` (Thunderlock's reload scales with Speed to a 1 s floor, the Pistolet's is fixed at 1.4 s). A Pistolet pair is two machines, the off hand at x0.8 damage and -5 to hit. Ammunition carries no damage.

Spells read `ARENA2/SPELLS.STD` from the launcher's `arena2Path` (or `--data`), price every effect through FormulaHelper's component table and the school's live skill, roll `GetMagnitude`, apply the saving throw and the school's past-100 potency, and use a 0.7 s cast recovery divided by the cast rate (Speed + castSpeed). PvE spells do not crit; armour does not reduce them; a magic round is 5 real seconds. Mana is assumed solved unless `--mana-limit` is passed; DoT DPS is reported separately.

Enchantments read `items[].enchantments`: Cast When Strikes (type 2) fires its spell on every landed blow, Potent Vs (type 4) is +5 flat against its affinity, Low Damage Vs (type 20) is -5, and EnhancesSkill (type 10) is +15. The weapon's `elemental` affix is flat per blow; `slayer` is group-specific. `analyze` returns weapon DPS, enchant DPS and total DPS, plus `procsBeforeBreak` from the 10-condition cost of a strike proc.

## Backstab and the cap

`combatStats` carries `Backstab: skillValue(Backstabbing)% ×3`. A back-facing swing is a ×1/×3 mixture, and the ×3 is rolled only on a landed hit. The live card's opening First Blood (Duelist's Vambrace) is separate and is deliberately excluded. `--behind` sets 100% uptime; `--backstab 0.5` uses the expected multiplier `1 + 2 × uptime × chance`.

The Breach's per-blow cap is `HIT_CAP_X × dpsRef(level)` = 420 at level 30 (unless an Elite/Vestiges `relayBlowX` raises it). The tool reports raw backstab damage and **capped** DPS separately: a 600 display can be raw while only the cap reaches the health.

## The real Breach boss pool

`net/gate/gateBrain.js`: a player's share of the Breach boss is `BOSS_TTK_S = 240` seconds of reference damage, `dpsRef(level) = 5 + level` (level 1..60). Solo at level 30 that is **8,400 HP**. He has plate armour 60 and a **per-blow server cap of `HIT_CAP_X = 12` x reference (420 at level 30)**. The model applies phase shields at 66% and 33% for **3 seconds each**; that is a declared parameter, not a measured duration (A8: the source can hold the ward longer). The Breach's default relay traits at this pin are **spellproof + stoneskin** (the relay selector picks one element proof and one blow trait); it does not use Curbing or Wrath. The tool adds the model's shield seconds to TTK, and the 75 s Wrath is reported but does not terminate the fight in the simulation.

## Boss cap

`systems/bossTraits.js`:

- **Curbing** — `min(blow, max(1, round(maxHealth * 0.05)))`
- **Warded** — a 30% max-HP pool absorbs blows first, refilling after 10s
  without a hit
- **Bladeturning / Stoneskin** — weapon-class damage x0.5
- **Thorned** — 20% of weapon damage back at the striker
- **Wrathful** — boss damage x1.6 after 75s

Relay bosses draw **one element proof and one blow trait** from the game's
`RELAY_BOSS_TRAITS`; the Breach's default at this pin is **spellproof +
stoneskin**. They have no Curbing or Wrath by default. The three-second phase
shield is the model's A8 parameter; the source can hold the ward longer.

The cap is applied **after** backstab's ×3 and after any flat addition to the blow; backstab and poison are not exemptions. It is **per player**: `HIT_CAP_X * dpsRef(level)` for that fighter (times the relay bucket's `blowX`), while the health pool adds a `BOSS_TTK_S * dpsRef(level)` share for each player, so a group's cap does not grow with the group. Curbing only binds when the final blow would take more than 5% of **maximum** health. `analyze` stops at the per-blow cap. The loadout page's purse simulation adds the per-account bucket (`BUCKET_RATE_X` reference damage a second, `BUCKET_DEPTH_X` deep) and the `GATE_HIT_HZ_MAX` blows/s token limit.
If your per-hit is 40 and the boss has 5,000 HP, the cap is 250 and does
nothing. The report's "Boss cap sensitivity" table shows where it starts to
matter.

## Live snapshot

When a JSON with `equipSlots` is imported, the actual equip table wins over the saved `items[].equipSlot` and the live `_mods` cache. Its item `affixes` are folded into `_mods.skills`/`_mods.stats`; `_enchantMods.skillMods` is added separately. That reproduces the live Combat Stats card's skill line for the same character and snapshot; compare the card's current values rather than a fixed example.

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

The verification oracle is the pinned upstream source, checked by the
differential and golden suites (the verification notes). The in-game Combat
Stats card is a useful reference, not the oracle: it can include opening
effects (First Blood) and a different live gear state, so a disagreement is a
reason to check the import and the scenario, not proof that the model is
wrong.
