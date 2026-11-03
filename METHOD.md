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

## The level-45 theory character

`theory` is the live ceiling. Attributes are 100 (the `liveStat` clamp), Long Blade, Critical Strike and Backstabbing are mastered at raw 200 (`effectiveSkill` = 140), the weapon is a Daedric Dai-katana, online rules are on, and RRI weapon balance is on. It uses no community assumptions and no legacy strength model.

A gear skill line is modelled at the legendary maximum of 30 points (`AFFIX_RANGES.skill.legendary`). The practical line ceiling comes from `lootRarity.js`: Long Blade's own skill is only in the weapon and the body-skill pool, so the weapon plus seven armour pieces give **8 lines (240 points, +105.6% mastery)**; jewellery's `JEWEL_KIN` has Critical Strike but not Long Blade, so Critical Strike reaches **18 lines (540 points)** across the weapon, armour and ten jewellery slots. The mastery formula caps at +320% (728 points), but 8 Long Blade lines cannot reach it; Critical Strike has no formula cap and is the channel that keeps paying after chance reaches 100%. The weapon's damage affix is capped at 40% (`AFFIX_RANGES.damage.legendary`). The command searches every feasible split of the line budget and prices each stage from naked to fully geared against the level-45 gate boss.

The level-45 gate is `240 x 50 = 12,000 HP` with a `12 x 50 = 600` per-hit cap and two 3s shields. The fully geared long blade is about **1,198 uncapped DPS**, but the cap binds almost every blow: **~821 capped DPS** and **~20.6 s TTK**. The marginal value of another skill line is therefore near zero at the gate, which is the practical answer to "how far can it be pushed".

### The Firmament's channels

`statMods.js` caps a base attribute at `MAX_STAT_VALUE = 100` plus `statMaxMods`; `firmamentPowers.js` sets `statMax` equal to the star gain, so a +15 channel reads 115. A gear stat affix is only `_mods.stats`, so it fills that headroom but cannot create it. `skillSoftcap.js` hard-caps raw skill at 200 and `effectiveSkill(200) = 140`; `firmamentPowers.js` adds its +15 to the post-softcap value, and gear skill adds on the same channel. The sheet prints `permanentSkillValue + skillModOf`, which is why a 200 raw skill can show 215 with stars or 455 with gear, while the formula reads 155 or 395. In the damage model, the Long Blade post-cap channel is converted at 0.44% per point, capped at +320% (`weaponGearPct`); Critical Strike's post-cap points add 0.01 to the critical multiplier each. The sky's separate weapon-blow channels (`firmamentLaw.js blowPct`) add up to +30% general, or +50% with the unaware/rage conditions, and are modelled as another blow multiplier.

The `theory` command prices each star channel from +0 to +15. At the ceiling, Strength is the only attribute that still pays (damage plus RRI swing speed); Speed is clamped to 98/100; Agility moves only on integer thresholds; Luck's critical divisor steps at 125, so +15 from 100 does nothing.

## Weapon-ceiling page

`weapons` renders the same model as a standalone HTML page. DPS values are averages with a min-max roll range; the bar chart draws that range as an error bar. It ranks every weapon template (melee, bows and the port's firearms) at a max profile (attributes 100/115, raw weapon skill and Critical Strike 200 mastered, weapon skill gear 240, Critical Strike gear 540, 40% damage affix, the weapon's career expertise, Dunmer (the default; `--race` overrides), and the best martial path for the family) and shows raw 100 -> 200 and gear 0 -> 240 curves per family. Axe and H2H use Berserker and are measured below half health; Blunt uses Blademaster at or above half. The Hand-to-Hand row is the Hand Wraps ceiling (damage/sockets/procs); bare fists without wrap lines are the ~450 band the community tests saw. The practical H2H gear cap is 17 lines (510 points: seven armour pieces and ten jewellery slots, never a weapon).

## Ranged, spells and enchantments

Gear sockets are modelled: a rare/legendary weapon has 1/2/3 sockets (short/one/two hands) and a perfect diamond is +12% damage; armour and jewellery take one stat/resist socket. Hand Wraps (template 563) carry damage/sockets/procs onto the fist blow. Dual wield averages the main and off-hand cards, the off hand at x0.8 damage and -5 hit. The skill chart is one line per weapon: raw 100 -> 200 is effective 100 -> 140, gear continues to 140 + cap.

The model's other lanes follow the same source snapshot. Bows use the port's BOW-LAW cycle (the five-frame swing law's frame, the drawn-idle release and the reload) and the BOW_FAST pacing window; guns use `frames/fps + reload` (Thunderlock's reload scales with Speed to a 1 s floor, the Pistolet's is fixed at 1.4 s). A Pistolet pair is two machines, the off hand at x0.8 damage and -5 to hit. Ammunition carries no damage.

Spells read `ARENA2/SPELLS.STD` from the launcher's `arena2Path` (or `--data`), price every effect through FormulaHelper's component table and the school's live skill, roll `GetMagnitude`, apply the saving throw and the school's past-100 potency, and use a 0.7 s cast recovery divided by the cast rate (Speed + castSpeed). PvE spells do not crit; armour does not reduce them; a magic round is 5 real seconds. Mana is assumed solved unless `--mana-limit` is passed; DoT DPS is reported separately.

Enchantments read `items[].enchantments`: Cast When Strikes (type 2) fires its spell on every landed blow, Potent Vs (type 4) is +5 flat against its affinity, Low Damage Vs (type 20) is -5, and EnhancesSkill (type 10) is +15. The weapon's `elemental` affix is flat per blow; `slayer` is group-specific. `analyze` returns weapon DPS, enchant DPS and total DPS, plus `procsBeforeBreak` from the 10-condition cost of a strike proc.

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
