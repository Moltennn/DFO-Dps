# Mechanics changelog

Every change to a calculation goes here: what the game does (with a source
reference), what changed, which test proves it, and which outputs moved.

Format: newest first. A change that only refactors code without moving a number
does not belong here (use the commit message).

## Rust parity: a string `element` or `rangeType` on a spell record (2026-11-25)

**Source.** `src/spells.js` reads `TARGET_COST_MULT[spell.rangeType]` (`spellCost`) and
`ELEMENT_FLAG_BY_INDEX[element]` (`savingChanceOutcome`) as property keys, so `"2"` names the same row as `2`; its
strict compares (`elementTraitOf`, `spellHasFlags`) do not match a string. **Changed:** the Rust port only
(`rust/dfo-core/src/spells.rs`), which read both strings as no row. No JS number moves. **Test:** the `card` vectors of
`tools/rust-spell-vectors.mjs` replayed by `cargo test -p dfo-core --test spells` against the live JS. Red: a card
with `element: "0"`, magnitude 400, expected damage 201 (saving 0.5025), got 67 (saving 0.1675). Green after.

## Stage JS-1: the 0.1.14631 weapon-gear law and `brand`, opt-in (2026-11-23)

**Source.** These facts are readable only in the shipped 0.1.14631 build, so they are cited `dist:` (the weaker
class, pinned by `vendor/dist-pins/0.1.14631.json`) and are a **drift finding**, not the vendored cut: `AGENTS.md`
rule 1 makes them valid for local-invariant tests only and they never close an assumption. Three laws:

- **GEAR-14631** (`dist:weaponMastery-AR4ipaqT.js:9f201d8ae37fa0b8:835@0.1.14631` `g()`/`:1384` `b()` and
  `dist:spellcast-EF3EGbYP.js:03aaae5902c8daf4:229764@0.1.14631` `Sy()`). The weapon gear is a **flat add on the
  damage roll**, not a mastery percent: one blow adds an integer uniform on `[floor(s/10), floor(s/5)]`, `s` =
  `skillModOf(attacker, weaponSkill)`. `masteryPct` keeps only the past-100 climb (no `min(320, gear x 0.44)`), the
  axe/blunt half-line branch is gone (all four families take one climb term), and nothing is capped at 320. The
  guard is the **target** (`!isPlayer && !warded`), with the attacker online and not on fists/`_mentor`/beast. The
  `duelGearAdd` peer copy is unmodelled.
- **BRAND-14631** (`dist:lootPowers-Dm823tWJ.js:f7eb7a0c6af4da01:3482@0.1.14631`). `case\`brand\`` adds
  `floor(flat x elementShare(target, power.element))` to the flat accumulator, after venom, no doubling. Only the
  loot power is modelled; the Gilded item `retributions-call` itself is not. This is a **future-facing** path: the
  vendored cut has no `brand` kind at all, so it is reachable only through a hand-built power record, and only
  under `gameBuild: '14631'` (the `'14512'` switch's default arm adds nothing). No existing build carries a brand
  power, so `'14512'` output cannot move.
- **D4 defender set** (ids/values in `dist:lootRarity-B3D_-YTh.js:153d9b8d3930c25d:14456@0.1.14631`,
  application in `dist:sigilSetPowers-CI5Iqvjk.js:282964303089c9c3:7021@0.1.14631`). **Not modelled** - known
  unmodelled 14631 drift: +20 magic/fire/shock resist; +5 magic damage and +3 magicka a hit; +5% max HP healed,
  +5 fire damage and +20% max health. All three laws are opt-in behind `gameBuild: '14631'` (CLI `--game-build`);
  the default `'14512'` is byte-identical to before.

**Placement.** The flat add enters the ROLL inside the weapon damage formula (`Ob`: `wy(r, Sy(min + floor(rand x
(max+1-min)), ...)) + n`), so it sits before Strength, the material, the enemy-type term, the blow modifiers
(mastery/loot/martial/Firmament) and the crit - a critical multiplies it and no percent scales it. Because the add
is a uniform INTEGER, the card enumerates every `(roll, add)` pair: `plainRolls`/`critRolls` carry the whole joint
support, so a per-hit cap, a fight tier, a bow pull and the off hand's share each see the true distribution (a
mean-add card read `cappedPerSwing` up to 6.7% high, narrowed the tier's support and lost the bow/off-hand band).
`ASSUMPTION:` the carried-chain ratio `e/(1+e+a)` a later blow of a chain reads is not traced; this model applies no
chain ratio, so only the flat add is used, and `duelGearAdd` is unmodelled. `Sy` has the only call site (`Ob`), so
the add is per blow; each dual-wield hand is its own card and so gets its own add.

**Red → green.** `node --test test/build14631.test.js` first failed 11 of 15 with `buildOf` stubbed to `'14512'`
(the changelog's red check), and passes 15/15 with the switch live. The mean-add card this replaces fails the
cases that need the joint support: its fight-tier support came out as a narrow band where exhaustive enumeration
gives the full add range, it lost the widened band on the bow and off-hand cards, and on a 115 hit-cap fixture
inside the spread it read `cappedPerSwing` high (109.22 against the enumerated 102.32). The card now enumerates
every integer add, so `plainRolls`/`critRolls` carry the whole distribution and a cap, a tier, a pull or the off
hand's share each see it; the carry and carried passes are untouched (the remainder rides the pre-percentage
channels, not the roll). The pin check in the same file refuses a `dist:` citation whose chunk is not in
`vendor/dist-pins/0.1.14631.json`. `test/cliUsage.test.js` pins that no `--game-build` and an explicit `14512`
print identical JSON, that `14631` moves it, that `14513` exits 2, that `report` threads it into the page, and
that every command which does not read the flag rejects it.

**Outputs moved: none by default.** On the 100-roll longsword fixture (gear 250 / 700): `14512` 210 / 408,
`14631` mean 137.5 (125-150) / 205 (170-240). The level-45 theory blade (legal gear 250/370/25%): the card's
`mastery` is 150% on `14512` and 40% on `14631`; the blow's mean moves 111 -> 127.5 and capped DPS 788.2 -> 817.9.
`14512` output is unchanged; its `damage.parts` carries no `gearAdd` key at all.

**Known unmodelled 14631 drift.** `defender` sigil set (D4, above); the `brand` Gilded item; `duelGearAdd`;
`deepWaterRuntime`'s `gp`/`gf` serialisation; the carried-chain ratio reader.

## Stage 3.8: sampled loadout shortlist (2026-11-19)

**Source.** `src/realBuild.js` supplies the deterministic candidates, enchant
plans and imprints. `src/loadoutShortlist.js` keeps those builds and reranks a
melee shortlist on common seeds through `src/objectives.js`, separately for
the ordinary foe and each relay body. The sampled damage note names the
existing Cast When Strikes direct-damage and Continuous Damage paths rather
than describing the fights as blow-only.

**Evidence.** `test/loadoutShortlist.test.js` covers opt-out output bytes,
mode and trial validation, unchanged build shape, the retained imprint,
seed pairing and both sampler modes. No damage formulas changed.

## Stage 3.8: expose sampled objectives in the CLI (2026-11-19)

**Source.** `src/objectives.js` supplies the scores and intervals. `dfo-dps
objective` applies it to a single CLI build. The command uses an explicit
`--health` as the total pool and samples with carry on unless `--no-carry`
is passed.

**Red → green.** `test/objectiveCli.test.js` first failed on the missing
command and flags, then verified library parity, repeatability, carry and
sample reporting, total relay health, and input errors.

**Outputs moved: none.** Compared complete before/after stdout for `build
--theory --target soft` and `loadout --theory` (`loadout` has no `--top`). The benchmark file
(`tools/benchmark-loadouts.mjs`) had only a refactor: the Archery/Fists filter
moved into `isSampledLoadout` in `src/realBuild.js`, with identical rows. No
scoring code changed; sampled objective assumptions now record carry.

## Sampled fights carry held-item fractions by default (2026-11-18)

**Source.** `systems/loot/lootPowers.js:169-181@a3eb1605` keeps a fractional
share on the held item except during the estimate. Separate remainders are
kept by `systems/weaponMastery.js:132,148-150`, `systems/martialPowers.js:106,232-235`
and `systems/firmamentPowers.js:104,111-115` at the same pin. M43's local reset
to zero for each fight is unchanged.

**Red → green.** `node --test test/lootCarry.test.js` with the existing held-item
differentials changed to omit `carry` failed before the default flip and passed
after. At 240 seeds the 25% slayer's mean TTK went from 282.258 s to 277.094 s
(vendored 277.204 s); damage/blow went from 16.2478 to 16.5499 (vendored 16.5406).
At 64 relay seeds and 400 attacks per fight, damage/attack went from 20.59914 to
20.97586 (vendored 21.04320, z from −6.90 to −1.09). Explicit floor is still
outside the held-item bounds and the original seeded floor trace is unchanged.

**Outputs moved.** `src/simulateFight.js` and `src/relayFight.js` enable the
existing carried sampler when `carry` is omitted. The sampled objectives and
benchmark CLI inherit it; ordinary CLI builds and deterministic objectives
still use the card or its deterministic estimate. `carry: false` retains the
old sampled floor stream. `W-LOOT-CARRY` remains for the stateless estimates
and explicit floor, not the default sampled fights. Pricing, `ceilingTotalDps` /
`ceilingTotalTtk`, the optimizer and benchmark artifacts are unchanged.

## Phase 2 (M44) - allowance totals use the existing claim estimate (2026-11-18)

**Source.** `net/gate/gateBrain.js:1298-1335@a3eb1605` spends a shared blow
token and damage purse for every accepted submission. The card's ceiling
(`src/enchants.js:137-172`) applies per-claim caps but sums the proc rates
before that shared budget. No claim, carry, or fight rules change here.

**Red → green.** `node --test --test-name-pattern='Phase 2' test/procBudget.test.js`
first failed on both changed defaults. Replaying the card's fixed proc schedule
through the vendored `applyHit` measured 150 DPS after the bucket drained;
raw `totalDps` was 710.08698005698 and is now 150. The finite kill agrees before
and after (75.69429833789175 s vs vendored 75.69429833789185 s; the ceiling is
22.90 s). With a 100,000,000 HP pool, raw `totalTtk` was 1283880.52643776 s and
is now null; the finite estimate remains available as `ceilingTotalTtk`.
Ordinary totals and bands still match the pre-budget formula.

**Outputs moved.** `src/model.js:1128-1139` selects the existing claim fields
for allowance totals; no TTK fallback, and DPS keeps its ceiling fallback when
there is no run. The legacy DPS band is null only for a sustained default; the
unchanged ceiling band is explicitly named and exported by `build --json`.
The CLI and HTML distinguish censored and missing runs. Enchant-plan,
real-build and benchmark ceiling baselines and the explicit fight objectives
retain their metrics. `W-PROC-BUDGET` remains for the pre-budget proc estimate;
the vendored replay verifies the fixed schedule's billing, not sampled proc
lifecycle parity for the card.

## Turned relay DoT rounds tick without sending a claim (2026-11-18)

**Source.** At `a3eb1605`, `scenes/gate/standInSpell.js:137-150` runs the tick and
updates the carried entry before landing; `:219-236` suppresses the host callback
for a turned body or entity. `scenes/gate/gateCourt.js:1159-1168` sends nothing
while `t < shieldUntil`. This supersedes the round-submission behavior in M38.

**Change and evidence.** `src/relayFight.js` still spends the tick's duration
and draws, but does not submit it under the shield or an explicit `target.warded`.
Before the fix, `test/standInSpellDifferential.test.js` found an extra claim of
200 at 5 s. Afterward the claims are 10, 160 and 160 at 10, 15 and 20 s,
matching the vendored bridge, including the round exactly at shield end. A
persistent entity ward went from four claims to zero, also matching upstream.
The tick draw counts still match. The separate relay-claim differential still
checks engine refusal when a shielded claim actually reaches it.

**Outputs moved.** A turned tick adds no claim or claim-log row, offer,
refusal, or shielded-claim count, and does not advance either the claim clock
or the last billed time. If it was the last billed event after the last attack,
schedule- or blow-budget elapsed time can shrink and output DPS can change;
horizon and kill time rules are unchanged. An explicit ward now also prevents
the turned tick's damage from landing. Stun and court geometry are not modelled.

## Relay spell claims respect the boss's element-proof trait (2026-11-18)

**Source.** At `a3eb1605`, `scenes/gate/standInSpell.js:198-217` sums the cast's
direct damage and first tick, then applies `bossStrike` once. Later rounds
resist each tick before summing (`:51-58`, `:137-150`). The shared clock's
period is 5,000 ms (`gateCourt.js:159`, `net/wire.js:240`); its phase relative
to the fight start is not established by this comparison.

**Change and evidence.** `src/relayFight.js` applies the existing `resistSpell`
helper at those two points. `test/standInSpellDifferential.test.js` drives the
vendored `createStandInSpell` with scripted rolls: on a flameproof boss the
local fire claims were `[210, 200, 10, 160, 160]` (red) and are now
`[53, 50, 3, 40, 40]` (green), matching the game. The no-trait and mismatched
element controls agree without scaling. This changes seeded relay-fight spell
claims, damage and potentially TTK; it does not change the card or ordinary fights.

## Ward correction - `W-WARD` was recorded as a divergence that the source does not show (2026-11-18)

**What the game does.** The boss `warded` trait is a health pool: "a ward of WARD_SHARE of its health takes every blow
first" (`vendor:systems/bossTraits.js:8`, `WARD_SHARE = 0.3` at `:64`), taken on the OWNER's side after the blow has
landed (`bossTake`, `:234-255`: the ward absorbs `min(pool, blow)` first, then health), regrowing whole `WARD_REGROW_S`
(10 s) after the last blow (`:65`, `:180-181`); relay bosses carry no ward at all (`:390-391`). `target.warded` is a
different thing: the REFEREE's turned blow - "a stand-in `warded` - the Warden's ward, the Remnant shut, the Spire's
turned blows" (`vendor:systems/enchantments.js:594`, `:670`). No vendored code sets it from the trait.

**What changed.** Nothing in `src/`. The waiver `W-WARD` said the trait "does not suppress per-blow powers" and listed
that as a known divergence; by the source the trait is not meant to, so the waiver is removed
(`test/harness/waivers.mjs`; `test/harness.test.js` now uses `W-PROC-BUDGET` as its stale-waiver sample id, the same
assertions). The test that used to pin the "gap" (`test/wardSuppression.test.js`, formerly "OPEN GAP (W-WARD)") is now a
differential: for seven health values from 1 to 250,000 the card's ward equals the vendored `bossWardNow` maximum
(`Math.max(1, Math.round(health * WARD_SHARE))`), the number of blows to kill through the ward equals the vendored
`bossTake` drain (`ceil((health + ward) / blow)`), and the blow powers still pay under the trait while only a
caller-set `target.warded` turns them. The local ward is therefore the same quantity as the vendored one for a
sustained fight; what it does not model is the regrowth after a 10 s pause in blows. Order with `curbing`: upstream curbs
the blow first and the ward then absorbs the curbed blow (`bossTake` `:238`, `:247-253`); the card applies the cap to the
blow and divides `(health + ward)` by the capped rate, which spends the same total at a steady rate (blow granularity
aside). The card's own TTK is asserted to spend `health + ward` in the same test.

**Open, not waived.** Whether the cut host ever copies the trait ward onto `target.warded` (ASSUMPTION U8; no vendored
code does it, so the model follows the source); the Firmament's gate, which only the vendored stub of its sky law
covers (`STUBS.md:47`); and the relay phase-ward length, a model parameter (A8).

**Outputs moved.** None.

## Stage 4a (M44) - the ceiling and the claim-based run are named and printed apart (W-PROC-BUDGET) (2026-11-18)

**What the game does.** Nothing new is modelled. The relay bills every Cast When Strikes proc and every Continuous
Damage round as its own claim against the per-hit cap and the allowance (`vendor:scenes/gate/standInSpell.js:131-151`,
`:198-217`; the local claim list is `src/allowance.js:97-115` `claimStreams`), and the local allowance has run that law
since Stage 3.7 (`src/allowance.js:134-297` `simulateAllowance`/`runAllowance`). The card's default figures do NOT do
that: `totalDps = cappedDps + enchantDps` and `totalTtkCapOnly = (health + ward) / that + shields` add the procs
(direct plus DoT) to the per-hit-capped weapon figure, so they are an upper bound, not a relay verdict.

**What changed.** Naming only; no arithmetic. `analyze` (`src/model.js:1119-1132`) also exposes
`ceilingTotalDps` (= `totalDps`), `ceilingTotalTtk` (= `totalTtkCapOnly` - the pure ceiling; `ttkCapOnly` is the
weapon-only one), and the allowance run's own figures `claimTotalTtk` (= `allowance.ttk`) and `claimSustainedDps`
(= `allowance.sustainedDps`). `claimSustainedDps` is `null` only without an allowance spec; `claimTotalTtk` is also
`null` when the run cannot kill inside the horizon. Every existing key keeps its value, with one caveat: the
pre-existing `totalTtk` carries the claim figure only when the run KILLS - when it cannot, `gate?.totalTtk ?? totalTtk`
(`src/model.js:1246`, `:1295`, `:1583`) falls back to the ceiling, so read `claimTotalTtk` (null then). `src/cli.js`
labels the allowance row `Allowance-sustained DPS`, prints the allowance-sustained kill time with `ceiling: X s` beside
it (`no kill` when there is none), labels the no-allowance row `Time to kill (per-hit-capped ceiling)`, adds a
`Ceiling vs allowance` line when the two differ by more than 1% - the fixed "the ceiling can promise a kill the
allowance refuses" sentence only when the claim is null or longer, otherwise `ceiling and allowance-sustained differ by
X%` - and adds the four fields to `build --json` and `enchant --json`. `src/report.js` does the same on the cards and
prints the same note. `W-PROC-BUDGET` is narrowed, not closed: the default figures are still the ceiling by definition;
the pin stays live.

**Measured before/after** (2026-11-18, the shipped/test fixtures; TTK in seconds). "before" is the same card read
through its old names:

| build | ceilingTotalDps | allowance-sustained DPS | ceilingTotalTtk | claimTotalTtk | claim / ceiling |
|---|---|---|---|---|---|
| waiver pin: 3 instant procs, level-45 gate | 710.09 | 150 | 22.90 | 75.69 | 3.31x |
| geared blade + 1 CWS row, level-45 gate | 935.57 | 150 | 18.83 | 75.98 | 4.04x |
| the same geared blade, no enchants | 821.24 | 150 | 20.61 | 75.98 | 3.69x |
| weak blade, no enchants (below the refill) | 65.03 | 65.03 | 190.52 | 189.54 | 0.995x |
| dual pair + CWS DoT, level-30 gate (below the refill) | 19.31 | 19.31 | 441.00 | 438.77 | 0.995x |

A no-proc build can still differ: the allowance clips the weapon blows themselves (row 3). A build under the refill
has a slightly SHORTER claim figure (rows 4-5, 0.5%); that is the claim schedule's discretisation, traced and exact,
not a proc or clipping effect:

- Claims land on `interval = 1/(aps x hit)` (the first at one interval), so the run ends on the first claim whose
  cumulative damage covers the pool: 300 claims deliver 12,006.25 against 12,000 HP on the weak fixture, 6.25 HP of
  overkill = 0.096 s.
- A phase shield is charged in full by the card (3 s each, 6 s), but the claim run only loses the claims that fall
  strictly inside it: `floor((3 - eps)/interval)` claims. On the weak fixture `interval` = 0.6154 s, so 4 claims per
  shield (2.462 s), 8 refusals over two shields (`claimsRefused: 8`).
- Difference = 6 - 8 x 0.6154 - 6.25/65.032 = 6 - 4.9232 - 0.0961 = **0.9807 s**, exactly the measured
  190.5241 - 189.5434. The multi-stream dual pair is the same quantity: refused damage 8,467.56 - 8,400.98 = 66.58 at
  the 19.31 offered DPS = 3.448 s against the card's 6 s, plus 0.32 s of kill-claim slack (435.00 + 3.45 + 0.32 =
  438.77). The purse (65 DPS < 150/s) and token bucket (1.62 claims/s < 4/s) do not bind, so neither is the cause. The
  1% note tolerance is why rows 4-5 print no note. The pin's 22.90 vs 75.69 s is the disagreement the waiver records.

**Red, before the change** (`test/procBudget.test.js`, the two new M44 cases, pre-change code):

```
✖ M44: the ceiling aliases are the same numbers as the fields they name
  AssertionError [ERR_ASSERTION]: single-hand DoT: ceilingTotalDps is totalDps
  + actual - expected
    undefined
    18.45575042735043
✖ M44: the ceiling can promise a kill the allowance refuses - named, and printed beside it
  TypeError: Cannot read properties of undefined (reading 'toFixed')
```

**Red, before the follow-up fixes** (the null-claim, note-direction and no-allowance-label cases, on the first cut):

```
✖ M44: the ceiling can promise a kill the allowance refuses - named, and printed beside it
  AssertionError [ERR_ASSERTION]: and it names the direction
✖ M44: an allowance that cannot kill leaves the claim figure null, and totalTtk falls back to the ceiling
  AssertionError [ERR_ASSERTION]: the CLI says the claim run never kills, not "-"
✖ M44: the gap note names its direction - the ceiling is not always the shorter figure
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /ceiling and allowance-sustained differ by \d+%/
✖ M44: without an allowance the kill time is labelled as the per-hit-capped ceiling
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /Time to kill \(per-hit-capped ceiling\)/
```

**Green, after** (`npm test`): 0 failures. The alias cases assert `ceilingTotalDps === totalDps`,
`ceilingTotalTtk === totalTtkCapOnly`, `claimTotalTtk === allowance.ttk` and `claimSustainedDps === allowance.sustainedDps`
on the single-hand DoT, dual-pair and pin fixtures, and both aliases `null` on a plain reference foe; the label cases
assert the pin's `ceilingTotalTtk < claimTotalTtk`, the report's `Total (per-hit-capped ceiling)` /
`Allowance-sustained DPS` / `ceiling: X s` strings and `Ceiling vs allowance` note with its direction, the CLI's same
rows, and the new JSON fields on both `build --json` and `enchant --json`. The follow-up cases add a level-45 gate at
1e8 HP (the run never kills: `claimTotalTtk` null, `ceilingTotalTtk` finite, `totalTtk` === the ceiling, the report/CLI
say `no kill`/`never kills`), the neutral note branch (a 1,000 HP gate, claim shorter: `ceiling and allowance-sustained
differ by X%`, never the "promises a kill" sentence), and the no-allowance label (`Time to kill (per-hit-capped
ceiling)`, with no `null`/`NaN` when there is no health at all).

**Outputs moved: none.** No existing key's value changes and no printed number changes (the CLI/report add rows and
labels; a `-` becomes `no kill` only where an allowance exists and never kills). The waiver entry was reworded, the pin
assertion is unchanged.

**Evidence.** `test/procBudget.test.js` M44 cases (see above); `test/harness/waivers.mjs` `W-PROC-BUDGET` (narrowed).
Limits: the ceiling is still an uncapped-proc upper bound until procs are priced as capped claims (Stage 4); a target
without an allowance spec has no claim figure (`null`), nor does a run that cannot kill (`claimTotalTtk` null, and the
pre-existing `totalTtk` falls back to the ceiling).

## Stage 3.7i - the seeded fight streams carry the percentage fraction (W-LOOT-CARRY step 3) (2026-11-18)

**What the game does.** Every percentage blow channel floors the blow and keeps the remainder on the held item:
`shareOf` at `vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js:176-181@a3eb1605`
(`exact = damage * pct / 100 + carry`, `more = floor(exact + 1e-9)`, `carry = max(0, exact - more)`, written only
when `!info.estimate`; every `pct` source of the loot step is summed into ONE share, `:344-345` and `:305-345`),
the same shape in `systems/weaponMastery.js:148-150`, the martial path `systems/martialPowers.js:232-235`, and the
Firmament `systems/firmamentPowers.js:111-115` (`whole = pct >= 0 ? floor : ceil`, remainder unclamped, the blow never
below 1 at `:181`). The key is the held item (a module `WeakMap`), one remainder per channel. A miss never reaches
`shareOf` (guarded by `damage > 0` at `lootPowers.js:287`, `weaponMastery.js:135`, `martialPowers.js:229`,
`firmamentPowers.js:173`), so it neither consumes nor advances one.

**What changed.** The seeded fight streams gain the opt-in scenario flag `carry: true` on
`simulateFight`/`simulateFights`/`simulateRelayFight(s)`. A per-fight carry state (`Map` per channel and held item,
reset at the fight's start - ASSUMPTION M43) is consulted per DRAWN blow. The tier keeps each landed atom's
pre-percentage base (`src/model.js` `damageModel` `blowBaseRolls`, `{ carryBases: true }`) and the `resolve` branch it
took (`src/blowOutcomes.js` atoms `blowBase`/`branch`); `mergeToCarryTier` keys on them and `carryResolve` re-runs the
percentage channels in upstream order (mastery, the loot step's one summed share, the elemental flat, the martial path,
the theory `damagePct` floor, the Firmament) with the live remainder, then the unchanged integer stages (crit, material,
condition, defence, off-hand share, payload, pull, trait, cap). `weaponBlow` reads `opts.carryState`; the `carried`
pricing pass deliberately ignores it (`src/model.js`). `finishBlow` is the extracted integer-stage sequence (same
`unityRound` order), used by `damageModel` and the re-resolution. The default path is untouched: `blowFightTier`
returns the ordinary tier, no atom gains a field, and the model arithmetic is unchanged.

**Phase 1 measurement (before/after).** (a) On the vendored functions with ONE reused item over 120,000 blows
(`test/harness/upstream.mjs`/`upstreamBodies.mjs`, standIn mobile 31, level 30 katana material 9), the held stream vs the
fresh-item (floor) stream, per ATTACK and per landed blow:

- 25% slayer line: **16.31768 vs 15.97885** (+0.33883, +2.12%); per landed blow +0.39843
- mastery line (skill 150 online, the vendored 17% climb): **17.34781 vs 16.88877** (+0.45904, +2.72%); per landed +0.47325
- martial path (Cutthroat Cheap Shot 25%, unaware): **16.31768 vs 15.97885** (+2.12%) - the same 25% share on the same
  build, as expected
- Firmament 30%: the vendored `blowPct` is an inert stub (`STUBS.md:47`), so the local law is measured instead:
  carried mean **115.3425** = the exact mean 115.3425, floor 114.8950 (+0.4475, +0.39%)

(b) Seeded `simulateFights` (2,000 trials, pool 5,000, reference foe tough, `carry` off -> on), mean conditional TTK and
mean per-swing damage:

- slayer 25%: **282.986 -> 278.055 s (-1.74%)**, per swing 16.2052 -> 16.4931 (+1.78%)
- mastery 17%: **279.034 -> 271.990 s (-2.52%)**, per swing 17.8332 -> 18.2956 (+2.59%)
- martial 25%: **1041.426 -> 1020.048 s (-2.05%)**, per swing 4.7992 -> 4.8999 (+2.10%)
- Firmament 30%: **1003.481 -> 980.640 s (-2.28%)**, per swing 4.9815 -> 5.0979 (+2.34%)

Those TTK moves are 1.7-2.5x the 1% TTK tolerance used elsewhere, which is why the default stays off. `simulateFights`
wall time on the same fixture: **1.26-1.37x** the floor path (2,000 trials, 943-1,171 ms -> 1,241-1,588 ms).

Against the held-item oracle (`upstreamFight(..., reuseItem: true)`, 300 seeds, pool 5,000): `carry: true` matches to
**TTK z -0.07 / 0.06 / -0.02** and per-blow gap **0.01% / 0.00% / 0.03%** for the slayer, mastery and martial builds;
`carry: false` is **+1.53% / +2.74% / +2.25%** low on per-blow damage (z 4.82 / 14.75 / 4.75), exactly the waiver's floor.
`test/lootCarry.test.js` runs the same comparison at 240 seeds and pins the floor with `expectKnownDiscrepancy`.

**Red, before the change** (the new sequence differential on the pre-change path, where `carryState` did not exist; the
same hold is now test 1):

```
✖ 1. a held item carries the loot share: 25% slayer, one remainder, misses do not advance it
  AssertionError [ERR_ASSERTION]: the local carried stream is the vendored held-item stream, blow for blow
  + actual - expected
    [ 0, 81, 146, 128, 76, 137, 128, 132, ... ]
    (expected) [ 0, 81, 146, 129, 76, 138, 128, 133, ... ]
```

**Green, after** (`test/lootCarry.test.js`, 7 sections; `npm test`):
1: the 400-blow stream equals `lootBlow` blow for blow, and differs from the floor. 2: 25% slayer + 50% bane
(Dragonsbane on career 16) is ONE 75% remainder; a two-carry control differs; mastery then loot equal
`lootBlow(weaponMasteryBlow(...))`; a merged one-share control differs. 3: the martial stream equals `martialBlow`;
the Firmament mean is its exact share (within 1/n). 4: the `carried` estimate pass ignores a carry state and writes
nothing. 5: seeded fights, three builds, oracle bounds above. 6: the default path is bit-identical to the recorded
pre-change fight literal (`seed` 119, 295 blows, `ttk` 269.4661224489796, `damageDealt` 5017, the full 295-value blow
array), while `carry: true` differs. 7: relay fights accept the flag and the carried stream is the higher one.

**Outputs moved: none by default.** Every shipped caller keeps `carry` off and reproduces the recorded literal;
`carry: true` is a new opt-in metric whose effect is the numbers above. The relay stream is wired and smoke-tested, not
differentially sampled. Limits: the per-fight zero remainder (M43), and the `damage > 0` gate boundary noted there.

**Evidence.** `test/lootCarry.test.js` (new, in the HEAVY list), `test/harness/fightOracle.mjs` (`reuseItem` keeps one
item for the whole fight and restores its condition, since the oracle still excludes wear; `attacker` and `unaware` let
the online/mastery and martial builds be driven), `test/pricing.test.js` section 5 (unchanged card pin),
`test/harness/waivers.mjs` `W-LOOT-CARRY` (narrowed: default + card remain, fight `carry: true` proved).

## Stage 3.3 correction - the allowance accepts a claim at exactly the shield's end (2026-11-18)

**What the game does.** `applyHit` refuses a shielded blow only while the clock is strictly inside the ward:
`if (now < B.shieldUntil) return 0;` (`vendor/upstream/a3eb1605/src/net/gate/gateBrain.js:1308@a3eb1605`). A claim at exactly
`shieldUntil` is therefore accepted. The relay claim engine already reads it that way (`src/relayClaim.js:149`, strict
`<`, pinned by `test/relayClaim.test.js` "6." and `test/relayClaimDifferential.test.js` "3.").

**What changed.** The card allowance used the opposite boundary: `src/allowance.js:180` was `if (t <= shieldUntil)` and
is now `if (t < shieldUntil)`. The `shielded` accumulator (`src/allowance.js:202`) is unchanged: it measures the ward's
duration (`until - max(t, shieldUntil)`), not a claim, and the ward still lasts its full span. No ASSUMPTION was added;
the strict law is the vendored one.

**Red, before the fix** (new test `test/allowance.test.js` "relay: a phase shield ending exactly on a claim time
accepts that claim (gateBrain is strict <)"): claims at 1, 2, 3, 4 s, a phase raised on the t=1 claim with `shieldS: 1`
so its end is exactly t=2, compared claim by claim through `test/harness/relay.mjs` `relayStream` (which now takes an
optional `phases` list, setting the ward after the phase-crossing claim exactly as `relayRun` does):

```
✖ relay: a phase shield ending exactly on a claim time accepts that claim (gateBrain is strict <)
  AssertionError [ERR_ASSERTION]: accepted through t=2
  1 !== 2
```

The local allowance refused the boundary claim; the vendored `applyHit` accepted it (local 1 accepted vs oracle 2).

**Green, after** (same test): all four prefixes agree claim for claim; at the boundary the local row is accepted
(`claimsAccepted = 2`, `landed = 200`), and `shieldedSeconds = 1` is unchanged. Before/after on the fixture:
`accepted through t=2` 1 -> 2, `landed through t=2` 100 -> 200.

**Outputs moved.** Only a figure fed by a claim whose time lands exactly on `shieldUntil`: the card allowance's `ttk`
(and anything derived from it) can shorten when a phase shield ends on a claim time. The shipped purse fixture moved:
`test/purse.test.js` "phase shields add their seconds to the kill" had a coarse `>= 5.5 s` bound calibrated on the old
boundary; the two 3 s Breach wards now cost exactly 4 s at its 100 damage / 100 s pace because each exact-end claim
buys 1 s back (`breach 124` vs `plain 120`). The test is now an exact assertion of that law rather than a lower bound.
The random-stream allowance comparisons (1/aps = 1.4 and 0.7) did not hit an exact end and are unchanged; the geared
headline figures in `test/allowance.test.js` are unchanged. The benchmark was not run here; its allowance/ceiling TTK
could move only on the same exact-boundary coincidence.

**Evidence.** `test/allowance.test.js` boundary test (prefix-by-prefix against the vendored `applyHit`), the existing
shield tests (`test/allowance.test.js:178`, `test/relayClaim.test.js` 6, `test/relayClaimDifferential.test.js` 3,
`test/relayClaimFight.test.js` 13), and `test/purse.test.js`'s corrected shield-cost assertion. Limits: the strict
boundary is exact double equality, as upstream's; a phase end that is not exactly representable will not hit it.

## Stage 3.8 - Sampled objectives with paired seeds and censoring-first ranking (2026-11-18)

**What changed.** `evaluateObjective` gains the additive `stochastic-ttk`, `kill-probability` and
`stochastic-relay` objectives over the existing seeded fights. Every sampled row names its objective, metric,
`damageMode`, trial count, horizon and the 95% interval on the **mean TTK** (kill probability carries a Wilson
interval). `MIN_STOCHASTIC_TRIALS` is 1,000, the audit's first pass; fewer is refused. `pairedDifference` compares
the same seeds, uses Student t for small samples and returns `separated: null` below 8 both-kill pairs. `rankBuilds`
refuses rows whose declared trials, seeds or horizon differ, flags adjacent rows with `ttkSeparated`, and - when any
two kill-probability Wilson intervals do not overlap - carries `censoringDiffers` and ranks by kill probability first,
then kill rate, so a build that only kills its luckiest seeds cannot win on a short conditional TTK.

**Ordering fixture.** Gate 45, pool 2,000: the expected-value `relay` walk ranks 127 (217.36) over 126 (200.86);
`stochastic-relay` reverses them (126 = 216.87 over 127 = 215.96), with a paired TTK difference of -0.0365 s and a
95% CI of +/-0.0121 s over 996 both-kill seeds (kill probabilities 0.996 / 0.999). The first candidate was the
ordinary fight at pool 500; investigation showed that a one-blow fight makes the sampler's fresh t=0 lead dominate
(walk/sampler ratio 0.481 at 500, 0.913 at 5,000, 0.999 at 50,000 for build 121), so it is not used as evidence.

**Outputs moved: none.** The four deterministic objectives and every seeded-fight number are unchanged. Evidence:
`test/stochasticObjectives.test.js` and `test/stochasticOrdering.test.js` (row fields and damage mode; identical
inputs and the [0, 0] paired interval; the sub-resolution pair; the censoring pair and ordering; Student t and the
8-pair floor; the pre-simulation refusal; the relay reversal). Limits: no optimizer/CLI integration, no bootstrap
quantiles, the paired TTK is conditional on both builds killing, and `ttkSeparated` is a TTK flag, not the score.

## Stage 3.7h - Pricing reads the carried percentage mean (W-LOOT-CARRY step 2) (2026-11-18)

**What the game does.** A percentage blow channel floors each blow and keeps the fraction on the held item:
`systems/loot/lootPowers.js:176-181` `shareOf` (`exact = damage * pct / 100 + carry`, `more = floor(exact + 1e-9)`,
`carry = max(0, exact - more)`), the same shape in `systems/weaponMastery.js:148-150` and
`systems/martialPowers.js:232-235`, and the Firmament's own in `systems/firmamentPowers.js:111-115`
(`whole = pct >= 0 ? floor : ceil`, remainder unclamped; the blow never below 1, `:181`). Because
`floor(x_i + c) = x_i + c - c_next`, `sum f_i = sum x_i + c_0 - c_n`: a held item's long-run mean of the line is its
EXACT share. The card is upstream's own estimate path (`info.estimate` reads the carry and never writes it), so a
fresh-item card floors.

**What changed.** Pricing no longer inherits the card's floor. `analyze` runs the one card a second time with
`carried: true` and exposes `carriedPerSwing` / `carriedCappedPerSwing` / `carriedDps` / `carriedCappedDps`
(`src/model.js:1063-1069`). In that pass the four carried channels take the exact share - mastery
(`src/model.js:702`), the loot step's one slayer + what-if + power percentage (`:711`), the martial path (`:723`) and
the Firmament (`:727`, with its `max(1, ...)` clamp) - through `carriedPct`/`carriedFirmament` (`:642`, `:646`) in
place of `applyPct`'s floor. The non-carried floors stay as the game's: the weapon damage affix and the theory
`damagePct` (lootRarity.js:2474-2478 trunc; `src/model.js:725`) and the elemental/venom flat (`Math.floor`,
lootPowers.js:294,:320). The target's hide/natural stage takes the mean without rounding it again
(`src/target.js:200`, `:238`, `exact`), and the card's crit/material/condition stages pass it through
(`src/model.js:953`) - upstream rounds each integer blow, whose mean is this. Pricing reads the new metric:
`powerDps` and the rankings (`src/imprints.js:87`, `:127-145`), the enchant plan's imprint pool and its base
(`src/enchantPlan.js:301-316`), and `bestImprint` (`src/realBuild.js:91`). Each real-build row is one metric:
`treeDps`/`enchDps`/`totalDps` are the carried capped blow plus the proc layer, `metric: 'carried'`, and
`cardEnchDps` keeps the plain card baseline under its own name; the enchant plan names `carriedBaseDps` /
`carriedUncappedDps` beside the card `cardPlanDps` / `cardUncappedPlanDps`. The benchmark's recorded
`cardDps`/`cardTreeDps`/`cardEnchDps` keep the pure card figures (`cardTotalDps`/`cardTreeDps`/`cardEnchDps` on the
row; the winning imprint's card figure is priced once), so that tracked selector keeps its name.
`carriedPerSwing`, `carriedDps` and `carriedCappedDps` are in the CLI JSON. The card's own `perSwing`/`dps`/`cappedDps`
and the seeded fight streams are untouched (ASSUMPTION M41; `W-LOOT-CARRY` narrowed, not deleted).

**Before/after, a 25% slayer line on the level-30 katana** (fixture of `test/pricing.test.js` section 5; 250,000
blows of one held item, vendored `calculateAttackDamage`):

- held-item stream: **19.4536** per swing (se 0.0125)
- card figure (unchanged): **19.0259** - the +2.2% the waiver still pins
- new carried metric: **19.4051** (0.25% below the stream: a bias, see Limits)
- the same line's share is exact: the carried figure is 1.25 x the no-affix blow, where the sample's integer-stage
  overshoot makes it 1.2589.

**Imprint deltas** (level-45 Breach, max-profile long blade): base 853.490 -> 855.520 carried; Way of the Sword
+36.243 -> +34.513, Serpent's Kiss +21.876 -> +21.101, Many Endings +3.826 -> +3.623 (the base carries its own
percentage lines, so a delta shrinks while both figures rise). Archery: base 775.702 -> 775.978.

**Ranking order: unchanged on the six max-profile fixtures.** `test/imprints.test.js` 'the carried metric keeps the
card's imprint order on every family fixture' asserts, for every family `rankAll()` reaches, that the order by the
carried delta equals the order by the plain card delta, with a distinct-delta guard so the comparison is not
vacuous. The host weapon was the same template under both metrics.

**Red, before the change** (`carriedPerSwing` did not exist; the card figure was the only one the test could read):

```
✖ 5. W-LOOT-CARRY: the carried metric is the held item's stream; the card still floors each blow
  TypeError: Cannot read properties of undefined (reading 'toFixed')   <- carriedPerSwing undefined
  probe: carried undefined, card 19.025857142857145, upstream 19.453648, se 0.012510859841289234
```

**Green, after** (`test/pricing.test.js` section 5 prints the same fixture):

```
✔ 5. W-LOOT-CARRY: the carried metric is the held item's stream; the card still floors each blow
  carried 19.4051 vs held 19.4536 (0.25%, z -3.88 at this seed) - the 0.5% bound passes; the card gap (+2.25%) is pinned
```

The test asserts the carried figure within 0.5% of the held stream AND that the card still fails the same
comparison by more than 0.5% (the narrowed waiver's pin, which covers the **card** half only).

**The row-metric fix in the same change.** `realTemplate` mixed the carried imprint figure with a card baseline, so
an imprint step reported the ~2% metric jump as the imprint's worth, and `planEnchants` put a carried `baseDps`
beside card `dps`/`uncappedPlanDps`. Red, before:

```
✖ the imprint step is one metric: carried minus carried, and the row names it
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: + undefined - 'carried'
✖ the plan names the carried baseline beside the card plan figures      (fields absent)
```

Green, after: both pass, the row's `treeDps`/`enchDps`/`totalDps` are carried with `metric: 'carried'` and
`cardEnchDps`/`cardTreeDps`/`cardTotalDps` named separately, the plan names `carriedBaseDps`/`carriedUncappedDps`
beside `cardPlanDps`/`cardUncappedPlanDps`, the CLI's tables and JSON say "carried" where the figure is carried, and
the order guard `test/imprints.test.js` 'the carried metric keeps the card's imprint order on every family fixture'
passes for all six families.

**Limits (recorded, not fixed).**

- The local blow has no `blowRoom`/`BLOW_MOST` clamp (`systems/powerCeiling.js:9-13`, `:52-64`; loot tops at 240%,
  mastery 400%, martial 40%, firmament 50%), so a percentage above its registry's top carries a larger share than the
  game. Existing separate divergence (M41).
- A geared target's worn-armour stage keeps its integer rows on the mean; the bare hide/natural stage is exact.
- **The carried figure is BIASED ~0.25% low on this fixture, not just sampling noise.** The mean-based pass skips the
  integer stages' per-blow `unityRound` (the crit's and the hide's), so `carriedDps` differs from `dps` even for an
  item with no percentage line at all; imprint/enchant deltas largely cancel the bias because both sides drop the same
  rounding, while an absolute carried figure carries it.
- **A second, separate residual:** the theory `damagePct` channel stays floored on the MEAN (`applyPct` at
  `src/model.js:725`), a floor-of-mean where the game floors each blow's share - up to one point of damage per blow
  when that scenario channel is used. It is a what-if channel, not a loot rarity line; not carried here.
- **The waiver pin covers the CARD half only.** No test compares a seeded fight-stream mean to the held-item stream;
  the fight half is unpinned by a test (the tiers pass the blow without `carried`; `test/blowOutcomes.test.js` pins
  the tiers equal the card).
- **Possible refinement, not done:** a per-channel floor/ceil mixture that tracks the carried remainder's phase would
  recover the integer-stage bias; a mean-based passage was chosen instead for the pricing metric.
- The seeded fight streams and the plain card still floor each blow (`W-LOOT-CARRY`).
- **Generated artefacts:** `docs/benchmark/**` and `docs/charts/**` are tracked and were NOT regenerated. Their DPS
  numbers come from `simulateFights` (fight streams, unchanged); the only path from this change into them is
  `realBuildStages`'s `bestImprint` (now ranked by the carried figure) and the recorded `cardDps` selector, which now
  prices the winning imprint's CARD figure where the old value mixed the carried imprint into a card base. A
  regeneration could therefore move an imprinted row's `cardDps` by a few points and, if a close pair swaps, its
  ranking; the shipped benchmark's chosen imprint is a flow power and flow's rank did not move. The untracked root
  pages (`imprints*.html`, `enchant-plans*.html`, `loadouts*.html`) do change and need regenerating.

## Stage 3.7h - Equipment delegate - a class foe's kit is Enemy Expansion's (W-DEX-LOADOUT closed) (2026-11-18)

**What the game does.** The client boots Daggerfall Enemy Expansion at every load (`scenes/shared.js:1518`), and its
install takes EnemyEntity's equipment delegate: `systems/enemyExpansion/dexInstall.js:246-247`
`setEnemyEquipmentAssigner(createDexEquipmentAssigner(dexProperties))`, which `combat/enemyEquipment.js:346` consults
before ItemHelper's arm. The delegate is Roleplay & Realism's class arm (`combat/rriEnemyEquipment.js:240-425`) behind
its own live gate `realisticEnemyEquipment` (`:246`; shipped default true, `systems/modSettings.js:1470-1477`), reading
the class through the mod's property table (`systems/enemyExpansion/dexEquipment.js:39-45`, `:104-108`) - so a class
foe's worn pieces, its seven ArmorValues and its shield come from that roll.

**What changed.** `src/target.js` `gearEnemy` (`:547-559`) now rolls through that delegate instead of
`assignEnemyStartingEquipment` with an empty registry: new `bootedEquipmentAssigner` (`src/target.js:530-535`) reads the
mod's tables with `dexRead` (`dexInstall.js:89-99`) with the mod-loaded props (`dexInstall.js:121-126`) and calls
`createDexEquipmentAssigner` per roll, falling back to `assignEnemyEquipment` exactly as the seam does
(`enemyEquipment.js:346-347`). Nothing is installed: `installEnemyExpansion` rewrites `ENEMY_BASICS` in place
(`dexInstall.js:211-220`) and this module's rows are already pristine-table `dexClassicRow`s, so a global install would
make a later test's mint order-dependent. Posture (ASSUMPTION M40): `UPSTREAM_BOOT` and RRI's shipped
`realisticEnemyEquipment`; the target carries no boot field.

**Before/after, mobile 128 at player level 45** (differential cases m128-s1..s3, `CLASS_CAREER` of 50s):
- m128-s1 (seed 0x52): ArmorValues `[60,55,60,45,60,60,60]` -> `[60,60,60,60,60,60,60]`: the RightArm and Chest
  deductions the stock kit's pieces left are gone (a class foe's values clamp at 60, so anything at or above 60 reads 60).
- m128-s2 (seed 0x53): the stock kit's first worn piece 104 (greaves) -> 102 (cuirass).
- m128-s3 (seed 0x54): the stock kit wore a chain right pauldron `[106,256]` -> the booted kit wears nothing.
- shield: `test/armour.test.js`'s fixture (mobile 128, player level 45, seed 0xb3c) was pinned to the stock roll's round
  shield **110**; the booted kit wears a leather cuirass (102) and greaves (104) and **no shield** (null).
- hit chance: a class foe's overhaul hit law reads a flat 60 (`src/model.js:563`), so the displayed hit chance does not
  move on these fixtures (a level-45 LongBlade-60 attacker: 0.5225 plain per part before and after on m128-s1's body);
  what moved is the ArmorValues field (the hit-chance term upstream reads per part) and the worn kit. A class foe's
  seven values also clamp at 60 (`enemyEquipment.js:318-319`), which is why several seeds read all-60 both ways and the
  piece list is compared too.

**Red, before the fix** (waiver tag removed from the three class-foe cases, stock delegate still in place):

```
✗ stage: the game's own enemy loadout is worn by the target (4.6ms)
  AssertionError [ERR_ASSERTION]:
  ✗ enemy loadout: m128-s1
      input:     {"mobile":128,"seed":1}
      upstream:  60   <- expected
      simulator: 55   <- actual
      diverged at: armorValues[1]  (delta -5)
  ✗ enemy loadout: m128-s2
      input:     {"mobile":128,"seed":2}
      upstream:  102   <- expected
      simulator: 104   <- actual
      diverged at: worn[0][0]  (delta 2)
  ✗ enemy loadout: m128-s3
      input:     {"mobile":128,"seed":3}
      upstream:  undefined   <- expected
      simulator: [106,256]   <- actual
      diverged at: worn[0]

  3 failing, 0 stale waiver(s) of 9 case(s).
```

**Green, after** (no waiver tag):

```
✔ stage: the game's own enemy loadout is worn by the target (4.8ms)
all nine differential cases pass (the runner's count moves; it is not repeated here)
```

and `npm test` is green; `npm run vendor:verify` OK.

**Outputs moved: class foes only.** A `gearEnemy`-dressed class target now wears the booted kit; monsters keep theirs -
the same file's m7 (an Orc, career 7, variant 0) and m22 cases pass with unchanged answers, because both sides already
rolled `rollEnemyEquipment` and now both take the delegate's monster path (`rriEnemyEquipment.js:248-256`, whose poison
draw and `ConvertOrcish` roll consume the same seeded stream). No report, CLI or allowance path calls `gearEnemy`, so
the card, fight and relay numbers are unchanged.

**Evidence.** `test/differential.test.js` "the game's own enemy loadout is worn by the target" (9 seeded rolls against
the booted realm, `test/harness/upstreamBodyWorker.mjs:61-72`), with the `W-DEX-LOADOUT` tag removed; `test/armour.test.js`
"a class foe wears the game's own rolled loadout" now takes its expected ArmorValues, its every-piece list (template and
material) and its shield from the booted realm (`upstreamBody({ kind: 'loadout' })`), asserts that seed's kit is not empty,
and no longer pins the stock kit's shield 110 (expected now null); the monster case's bare body is compared as before.
`W-DEX-LOADOUT` was deleted from `test/harness/waivers.mjs` after those three cases passed without it.

**Limits.** The shipped posture only (M40): RRI's `realisticEnemyEquipment` off, or DEX off, gives the stock arm and is
not modelled by `gearEnemy`; `enemyTarget(m, { boot })` does not carry `boot` to the delegate. Classic class ids are
exercised through mobile 128 (`isClassicEnemyId` true, `enemyBasics.js:103`; class at `:111`, and the oracle realm latches
`dexLoaded()` true at `dexInstall.js:209`, pinned in `test/targetBody.test.js:65` and `test/differential.test.js:1624`);
a non-booted posture (mod not loaded) is not modelled (the local delegate is gated by `UPSTREAM_BOOT.enemyExpansion`).
The local props read skips `dexProperties`' own `dexLoaded()` test (`dexInstall.js:124`) because that gate already answers
the same switch. The delegate's answer is used for worn armour and the shield only (right-hand weapon, poison and corpse
items are ignored, as before). A class foe's displayed hit chance reads the overhaul's flat 60 (`src/model.js:563`), so
this change is proven on the ArmorValues field and the kit list, not on a hit percentage.

## Stage 3.7f/3.7g - The relay compositor's CWS/DoT claims, differential and distributed (2026-11-18)

**What the game does.** In a relay fight a Cast When Strikes row is resolved INSIDE the blow's formula: the vendored
`systems/enchantments.js` doItemEnchantmentPayloads calls the host's `applySpellToTarget`
(`full:scenes/gate/standInSpell.js:198-217`, `vendor:combat/formulas.js:826-836`), so the cast's damage lands BEFORE the
host's blow claim and a cast kill suppresses it (`full:scenes/hostEnchant.js:198-209`); a proc is its own relay claim. A
DoT round's ticks arrive as ONE claim per round (`standInSpell.js:131-151`), one round = 5 s (`src/spells.js:21`), and the
body carries one like-kind entry (`vendor:systems/effects.js:1091-1103`). A shielded foe refuses a cast at the
CastWhenStrikes gate itself (`vendor:systems/enchantments.js:597`) and refuses a claim at the engine
(`vendor:net/gate/gateBrain.js:1308`; `src/relayClaim.js:149`).

**What changed - test harness only.** `test/harness/relayFightOracle.mjs` now composes the CWS + Continuous Damage path
the way the host does: a per-event claim log (`:73-79`), the vendored `tickActiveEffects` round clock with its own
`flushRounds` at `k x 5 s` (`:81-100`) - its clock advances with the FIGHT's clock and an anchor that passed with no live
entry bills nothing, so a late first cast cannot burst the anchors it missed, and the final drain stops once no entry
lives - the `enchantCtx` that runs the vendored `effects.applySpell` and submits the cast's direct damage + first round as
ONE claim before the blow's (`:102-111`), the host's live-foe gate on the blow claim (`:146`), and `strikesPositive` on the
outcome object (`:154`, `:161`) so the local event seam's CWS gate can read it. Every claim still goes through the one
vendored `applyHit`. No local result is an expected value. Two new test files: `test/relayDotDifferential.test.js` (the
claim-log differential) and `test/relayProcTtk.test.js` (the distribution). `src/relayFight.js:385-394`: the drain also
stops once no live entry remains - proved to move no output by the whole pre-existing relay suite
(`test/relayClaimFight.test.js`, `test/relayClaimDifferential.test.js`, `test/relayRealSampler.test.js`,
`test/relayFightDifferential.test.js`, `test/allowance.test.js`) and by the seeded no-CWS literal pin in
`test/relayDotFight.test.js` ("a build with no CWS rows is bit-identical …", `ttk null`, `damageDealt 524`, `claims 32`,
`time 30`), which is unchanged.

**Outputs moved: none.** No src defect was exposed: the differential agrees claim for claim on every fixture, so the card,
the fight, the allowance and the relay numbers are unchanged. **No divergence was found** - had one appeared, it would be
reported here with its numbers rather than patched.

**Evidence.** `test/relayDotDifferential.test.js`: the local `claimLog` equals the oracle's claim log claim for claim
(kind, time, `claim`, `got`, `bucket`, `tokens`, `hp`, cumulative `clipped`) for - CWS direct only (the cast claim before
the blow claim at one timestamp); CWS + DoT (rounds claim once each, on the 5 s anchors); CWS + Many Endings (the echo
stays inside the blow claim); a cast inside a shield (no cast before `shieldUntil`, the fight casts after); a DoT round
inside a shield (the primed entry ticks, the 5 s claim is refused by the engine, the 10 s claim is paid); and a CWS kill
(the cast claim kills, no blow claim follows); and a LATE FIRST CAST (the first attack at 13 s, after the 5 s and 10 s
anchors passed with no entry: no round is billed retroactively). Two NEGATIVE CONTROLS prove the comparison bites: the
local cast stream shifted by one draw diverges (with the aligned run asserted to carry both a `proc` and a `dot` claim, so
empty-vs-empty cannot pass), and a swapped cast/blow order or a split merged cast claim is caught on order and length
alone (both perturbations are made in the expectation, never the repository).
`test/relayProcTtk.test.js`: n = 24 seeded fights of a CWS+DoT build against the upstream compositor's own seeded fights
over the same schedule - mean TTK **297.95 s vs 298.94 s, bias -0.33%**; the LOCAL mean's 95% CI is **+/-3.20 s** and the
oracle mean's **+/-1.37 s**, inside the 1% bound of the `test/relayFight.test.js` precedent; and the proc build kills at
**197.24 s vs 439.60 s** (122.9% faster) than the same blade without its CWS row on a body whose 600-a-claim cap binds
nothing. The two new files add about 2.5 s to the suite (each well under the heavy-file budget), so no file was added to
`tools/test-fast.mjs`'s HEAVY list. `npm test` reports 0 failures; vendor verify OK. `W-PROC-BUDGET` is narrowed (not
closed) to the ceiling's summed procs, with the exact replacement text in `test/harness/waivers.mjs`; `W-WARD`,
`W-LOOT-CARRY` and `W-DEX-LOADOUT` are untouched.

**Limits.** The oracle composes the cast and the rounds from the same helpers the local fight uses, so this is a
composition differential, not a second derivation of `applySpell` (that is `test/cwsDifferential.test.js` and
`test/dotDifferential.test.js`). Two honest gaps in the oracle (M39): it imports `MAGIC_ROUND_SECONDS` from the project's
`src/spells.js:21` - the same constant on both sides, not a vendored value - and it aliases the seam's `strikesPositive`
to `raw > 0` (the POST-payload answer), where the local gate reads the PRE-payload damage (`src/cws.js:12`, `:334`); the
two differ only when the Strikes payload moves a blow across zero (Potent Vs / Low Damage Vs), no such CWS fixture exists,
and a case is not feasible because the vendored formula exposes only the post-payload `damage`
(`vendor:combat/formulas.js:632`) and a second payload-free run would draw again and desync the streams. The TTK
comparison is a MEAN test with independent streams on the two sides: n = 24, fixed seeds, so it is deterministic; the
bound is 1% (about 2.2x the oracle CI and 0.6x the local CI) and catches only a gross composition error of roughly 1.5%
or more. The oracle reuses one `roundDraws` script across the seeds (a fixture, not a sampling claim); per-fight equality
is the differential's job. The relay's phase-ward LIFECYCLE is still a fixed `shieldUntil` (M38), so a shield that starts
mid-fight is not exercised.

## Stage 3.7d/3.7e - CWS and DoT claims inside a relay fight, and the per-kind accounting (2026-11-18)

**What the game does.** A Cast When Strikes proc is its own relay claim (`full:scenes/gate/standInSpell.js:198-217`
`land(..., HIT_KINDS.Spell)`), and the cast is resolved INSIDE the blow's formula, before the host applies the blow
(`vendor:combat/formulas.js:826-836`) - so a cast that kills suppresses the blow claim. A DoT's ticks are different:
every round's ticks arrive as ONE claim per round (`full:scenes/gate/standInSpell.js:131-151`), a round is 5 s
(`src/spells.js:21` `MAGIC_ROUND_SECONDS`), and the body carries ONE like-kind Continuous Damage entry, a re-cast
renewing it (`vendor:systems/effects.js:1091-1103`). A claim made while the boss is shielded is refused by the engine
before any token (`vendor:net/gate/gateBrain.js:1308`; `src/relayClaim.js:149`).

**What changed.** `src/relayFight.js` only (the ordinary fight's loop is not merged in): the same CWS helpers the
ordinary fight uses (`cwsEligible`, `cwsRows`, `resolveCwsCast`, `tickActiveEffects`, `spellPowerInputs`,
`equippedForFight`, `:129-146`), a per-fight target clone of `activeEffects` (`:135-137`), the cast's claim at `:299-319`
(submitted before the blow claim, rounded at the host boundary `:200-215`), the round clock and its one-claim-per-round
send (`:216-241`), the drain after the schedule (`:385-388`), and the claim order at one timestamp: cast, blow, then the
round (M35; `:280`, `:358`, `:380`). The ward for a cast is the relay's own clock `t < shieldUntil` (nothing sets
`target.warded` on a relay body - ASSUMPTION M38), while a round always ticks and lets the engine refuse its claim, so a
warded round loses its damage and not its countdown (M36). The round clock and the drain run only when the fight can hold
an entry - it casts, or the caller's target arrived with a live `continuousDamage` entry (`:219-224`) - so a fight with no
CWS row and no primed entry does no round work at all. A caller-primed entry IS billed: it is the target's own state,
cloned per fight as in the ordinary fight. A non-kill fight ended by the blow budget or the schedule now lasts to the last
claim it BILLED (`:391-396`), not to the last blow, so a drained round is in `time`/`outputDps`. 3.7e:
`claimsByKind` / `dealtByKind` / `clippedByKind` (`blow` | `proc` | `dot`), `killSource` (`'blow' | 'cws' | 'dot'`), and
the whole claim log (`claimLog`, with `trace`, each row carrying its `hand`), around `:194-241`, `:414-424`; the batch
summary `simulateRelayFights` sums the kinds and tallies the kill source (`:501-517`). A kill made by the cast's own
FIRST round reads `'cws'` here - the relay merges the cast's direct damage and that round into one claim - where the
ordinary fight's cast bills the round through its own sink and reads `'dot'` when the round delivered it.

**Before and after.** Before, a relay fight made BLOW claims only: a CWS row was never walked and no DoT entry existed
(the module header listed both as excluded), so a CWS/DoT build's procs and rounds dealt nothing. After (a level-45 gate
body, 4000 health, seed 3, 30 s; one Cast When Strikes row holding a magnitude-200 DoT with ten rounds and a
magnitude-150 instant): **claims 51 = 26 blow + 22 proc + 3 dot**; `damageDealt` 4000 = **520 + 2920 + 560**;
`clipped` 98 = **0 + 98 + 0**; `offered` 4098; the kill came from a cast (`killSource: 'cws'`) at 25.99 s. The censored
drain fixture (`maxBlows` 1, a long DoT): `time` **0.37 -> 35 s** (the last round billed) and `outputDps` the dealt
figure over that time instead of over one blow.

**Outputs moved.** Only relay fights whose build carries a CWS row (and the (1,0) spells among them), or whose target
arrives with a live entry: their claims, `damageDealt`/`offered`/`clipped`, the claim/kind counters, the kill source and
time, and the trace. A relay fight with NO CWS row and NO primed entry is bit-identical: the cast stream draws nothing,
the round clock never runs, and the whole existing relay suite (claim differential, seeded fights, saturation, Flow/echo,
the real sampler) passes unchanged; its seeded figures are pinned as literals in the test (see the note there on where
they were recorded). The card is untouched by this batch.

**Evidence.** New `test/relayDotFight.test.js`: every fight's whole claim log is replayed through the vendored `applyHit`
(`test/harness/relay.mjs` `relayStream`) and compared per claim on `got`/`bucket`/`tokens`/`hp`/cumulative `clipped`.
Red first (no claim log or kind counters existed: `Cannot read properties of undefined (reading 'proc')`,
`undefined !== 'cws'`, `0.366 !== 35` for the time fix, and `claimsByKind` absent on the batch summary); green after. The
fixtures: the cast before the blow at one timestamp; a cast inside a shield (no proc before it); a primed live entry whose
5 s round is claimed and refused while the entry keeps counting down and the 10 s round is paid (a tick VALUE asserted);
a casting kill suppressing the blow claim (`claimsByKind.blow` 0); a renewal (one proc claim for the whole fight); a DoT
kill (`killSource: 'dot'`, `ttk` = the round's); a `durationBase` 0 (1,0) (no entry, no dot claim); the cast's claim
against the vendored `applySpell` for scripted `cwsRolls`; the one-entry-per-body rule (a second (1,0) renews, and no
other continuous kind exists in `src/cws.js`); a dual pair with the CWS row on the OFF hand only (every proc claim's
`hand` is `'off'`); the drain time; the batch kinds/tally; and the 3.7e identities (`claims`/`damageDealt`/`clipped` =
the sum of their kinds). `npm test` reports 0 failures; vendor verify OK.

**Limits.** Batch 2 is the card/ceiling side's other half only: the relay's phase-ward LIFECYCLE is still not scheduled
(a fixed `shieldUntil` is the caller's), wear stays refused (3.5.3g), and the `events` test seam carries no
`strikesPositive`, so it casts nothing. `simulateRelayFights` does not aggregate the new per-kind counters (each row
carries them). `W-PROC-BUDGET` and `W-WARD` are untouched (3.7h).

## Stage 3.7 - The proc budget: one DoT round is one claim, capped once, and a dual pair claims it once (2026-11-18)

**What the game does.** A Cast When Strikes proc is its own relay claim (`vendor:scenes/gate/standInSpell.js:198-217`
`land(..., HIT_KINDS.Spell)`), capped by the relay's `HIT_CAP_X x ref` per hit (`vendor:net/gate/gateBrain.js:1298-1336`,
`ref = 5 + level`, `:302`). A DoT's ticks are different: every round's ticks arrive as ONE summed claim (`standInSpell.js:131-151`),
so the cap applies ONCE to the round's sum. A round is 5 s (`src/allowance.js:40` `DOT_ROUND_S`, `src/spells.js:21`
`MAGIC_ROUND_SECONDS`). And a body carries ONE like-kind Continuous Damage entry: any ContinuousDamageHealth is the
incumbent, a re-cast renews it and keeps the incumbent's own magnitude (`vendor:systems/effects.js:1091-1103`).

**What changed.** (3.7b) `src/enchants.js:148-155`: the card summed `min(each tick, cap)` - capping every proc's tick apart
- while `src/allowance.js:108-114` claims `min(sum of ticks, cap)`. The central value now sums the round and caps it once;
the min/max lines already did. Each proc's INSTANT damage is still capped per proc (`:145-147`), because each proc is its
own claim. (3.7c) `src/model.js:1110-1117`: a dual build added `em.dot + eo.dot * 0.8` every round - the two hands' DoT
figures, one of them 0.8-weighted - although upstream merges them into one entry. The pair now claims ONE round from the
merged entry: the main hand's when it has one, else the off's, unweighted (an off-hand share belongs to a blow, not a
magic round). `streamsOf` (`:1134-1148`) emits that one dot stream from the dot-holding hand's proc set, with the other
hand's `dotTick` zeroed, so the allowance and the card agree. The band (`:1118-1127`) prices the SAME merged entry too: it
used to halve both hands' DoT and weight the off hand 0.8, so the central value could fall outside
`[enchantDpsMin, enchantDpsMax]`; it now takes the merged host's own `dotDpsMin`/`dotDpsMax`, and the hand cards expose
them (`:1492`). The Pistolet pair branch (`:1179-1187`) had the mirror-image bug: the central figure dropped the DoT
entirely while the band added BOTH single-hand rounds (`(min_m+min_o)/2 x 2`); both now come from the one merged host.
`allowancePatch` (`:997-1027`) keeps the claim list it offered as `allowance.streams`. The merge rule and its host choice
are M37.

**Before and after.** (3.7b) a level-45 item with two CWS rows, each a magnitude-1000 DoT (an average 55.5% save -> 555 a
tick), per-hit cap `12 x ref(45)` = 600: card `procDot` **1110 -> 600**, `dotDps` **222 -> 120**; the allowance's dot
`perClaim` was already 600, so the two now agree. (3.7c) a level-30 dual pair with the same CWS DoT row on both hands,
against `gateTarget(30)` (12000 health): `dotPart` **9.99 -> 5.55** (one hand's round), `enchantDps` **9.99 -> 5.55**,
`totalDps` **23.75 -> 19.31**, `totalTtk` **361.00 -> 438.77 s**, allowance `ttk` **361.00 -> 438.77 s**; the band, which
sat outside the central value at **[6.0729, 6.0729]** against 5.55, is now **[5.55, 5.55]** and `totalDps` 19.31 sits in
[13.65, 25.30]. (Pistolet pair, the same DoT row on the pistol, `gateTarget(30)`): the central `enchantDps` was **0** - the
pair branch dropped the round while its band carried both hands' rounds (2 x 5.55) - and is now **5.55**, with `totalDps`
**13.63** inside **[10.01, 17.49]**, `totalTtkCapOnly` **622.21 s** and the allowance's `totalTtk` **621.23 s**.

**Outputs moved.** (3.7b) only a CWS/DoT build whose summed round exceeds the per-hit cap; the sweep of the shipped
spellbook found none - the five standard spells with a `(1,0)` effect top out at **58.83** a round at level 30 and
**87.97** at level 45 (against caps of 420 and 600; `!Pyrrhic Acid`, index 76), Wildfire (33) at 54.39/79.37, and index 20
(the allowance fixture's row) has no DoT at all; the benchmark carries no enchantment rows. So no shipped card's number
moves from 3.7b. (3.7c) a dual build whose hands carry DoT enchants: its `enchantDps`, the min/max band, `totalDps`,
`totalTtk` and allowance figures move as above; a Pistolet pair with a DoT row moves too (its central figure gains the
round it used to drop). A single-hand build and a dual build with no DoT are unchanged: the one-hand card still prices
`tick / 5`, and a no-DoT pair's enchant figure is exactly its per-blow run (asserted in the procBudget pins; the rest of
the suite is unchanged).

**Evidence.** `test/procBudget.test.js`: 3.7a pinned the disagreement first: `enchantDps(... { cap: 600 })` returned
`procDot` 1110 against `claimStreams`' dot `perClaim` 600, asserted through `expectKnownDiscrepancy(assert, 'W-PROC-BUDGET', ...)`
like `test/pricing.test.js:250`; after 3.7b the same pin went red (`600 !== 1110`) - the forcing function - and now asserts
equality (`e.procDot === dot.perClaim === 600`, `e.dotDpsMax === 120`). 3.7c's red was the pair's dot part 9.99 against the
one-hand 5.55 (`+ 9.99 - 5.55`), green at 5.55 with `enchantDps === oneHand.enchantDps`; the added cases pin the off-only
host (unweighted), the differing-magnitude host (swapping the rows changes the answer) and the allowance's ONE dot stream
(`dual.allowance.streams`, `perClaim` = the round). The band red was `enchantDps 5.55 inside [6.0729, 6.0729]` (dual) and
the pair red `enchantDps 0 !== 5.55`; both green after. The 5 s pin asserts `DOT_ROUND_S === MAGIC_ROUND_SECONDS === 5`
(two homes, one value, `src/allowance.js:40`, `src/spells.js:21`). The waiver's remaining half is pinned:
`W-PROC-BUDGET` holds a `expectKnownDiscrepancy` case where three capped instant procs saturate the allowance
(`sustainedDps` 150, `enchantDps` 676.39) and the ceiling's `totalTtkCapOnly` **22.90 s** promises a kill the allowance's
`totalTtk` **75.69 s** refuses (`src/model.js:1479` `totalDps = cappedDps + enchantDpsValue`). `npm test` reports 0
failures; vendor verify OK.

**Limits.** The relay FIGHT (batch 2) is untouched: the allowance path is the card/ceiling side. `enchantDps`'s exported
`procDotMin`/`procDotMax` remain the uncapped sums (a pre-existing shape; `dotDpsMin`/`dotDpsMax` use the capped values).
`W-PROC-BUDGET` is narrowed, not closed: the ceiling still sums procs on top of the weapon figure (its DoT clause was
removed). A pair with two different DoT spells prices the main hand's alone (M37).

## Stage 3.6c - A ward turns every per-blow power, and only those

**What the game does.** A `warded` foe - the Warden's/court's word the host copies onto the body - refuses every per-blow
channel: `lootBlow` returns the damage untouched, so the slayer percentage, the elemental flat and every riding power
(bane, unaware, sanctified, flow, venom, moon, rage, execute, ...) are skipped (`vendor:systems/loot/lootPowers.js:287`);
`lootStrike` returns before leech, chain, quake, echo and fists (`:354`); `weaponMasteryBlow` returns the damage
(`vendor:systems/weaponMastery.js:141`); the martial path's blow and strike read `foeOf` = `!target.warded`
(`vendor:systems/martialPowers.js:136`, `:229`, `:241`); `firmamentBlow` returns the damage (`vendor:systems/firmamentPowers.js:173`);
Cast When Strikes returns null and bills nothing (`vendor:systems/enchantments.js:597`), and so do the two Vampiric
WhenStrikes arms (`vendor:systems/artifactEffects.js:247`, `vendor:systems/enchantments.js:674`). NOT gated: the Strikes
payload - Potent Vs / Low Damage Vs (`vendor:systems/enchantments.js:623-631`) - so a warded blow still carries its +-5.

**What changed.** `src/model.js` `weaponBlow` (:675-687) gained ONE ward gate at the top - the local home of all four blow
channels (mastery, the loot slayer/elemental/power walk, the martial path, the Firmament) - so no module carries its own
ward test. `afterShare` (:817-829) skips the echo for a warded foe, the strike listener's only answer the card carries,
with the `warded` flag passed by its three callers (`model.js:1295`, `:1336`; `src/blowOutcomes.js:169`) and by
`blowDistribution` (:872-883, the flag at :879), which otherwise priced the echo on a warded target (red: the distribution
200 with a 100% echo against 100 without). `strikesNet` (Potent Vs) is untouched, `cwsEligible` already
refused a warded target (`src/cws.js:342`) and the relay keeps its own `shieldUntil` suppression
(`src/relayFight.js:196-209`).

**What is still open - `W-WARD` is narrowed, not removed.** The gate fires only when a caller SETS `target.warded`. The
card's own `warded` TRAIT is a different thing: it adds the boss ward's health pool to the kill time
(`src/model.js:1451`, `WARD_SHARE`) and never sets `target.warded`, so a trait-warded target still carries every per-blow
power. Continuous Damage rounds are not ward-gated on either side (the vendored `runEffectRound` has no ward test,
`vendor:systems/effects.js:720-731`; assumptions M36), and the Firmament gate is checked only against the vendored stub of
the sky law (`vendor/upstream/a3eb1605/STUBS.md:47`), never a live oracle call. `test/wardSuppression.test.js`'s "OPEN GAP
(W-WARD)" test pins the trait path (130 through `weaponBlow` with `traits: ['warded']`, 100 with `target.warded`), so the
waiver is backed by a case that asserts the divergence still stands.

**Before and after** (lvl-30 build: Long Blade 150 online+mastered, Cutthroat (Cheap Shot, an unaware foe), a weapon with a
+20% humanoid slayer line and a +10 fire line, Firmament +20%; `analyze(..., { health: 1000, unaware: true,
firmamentDamagePct: 20 })`, target `referenceFoe(30,'tough')` + `group/affinity` humanoid):

| | before (a ward ignored) | after |
|---|---|---|
| `perSwing` | 8.2214 | **5.8495** |
| `dps` | 9.9801 | **7.1008** |
| blow at 100 through `weaponBlow` | 130 (slayer 20 + elemental 10) | **100** |
| mastery channel | +17 | **0** |
| martial channel | +25 | **0** |
| Firmament channel | +20 | **0** |
| echo `perSwing` delta (Many Endings) | +1.4086 | **0** |
| `blowDistribution` mean, 100% echo, `target.warded` | 200 | **100** |

An unwarded target, and a target whose ward is only the TRAIT, are unchanged: every existing fight, card, relay, allowance
and pricing number holds (`npm test` reports 0 failures).

**Evidence.** New `test/wardSuppression.test.js` (9): A (red: the warded blow 130 !== 100), B (red: the mastery channel paid
17 on a warded target) and C (red: the martial channel paid 25), whose final cases assert the BLOW through the one gate and
also pin that the channel helpers still report those percentages, D (red: the warded card carried the echo, +1.409),
`blowDistribution` (red: the mean 200 with a 100% echo against 100 without), the Potent Vs guard (green: a warded miss still
answers 5), the Cast When Strikes guard (green: no cast, and the warded blow pays wear only,
`drop === unwarded drop - 10`), Q6 (the ordinary path reads `target.warded`, not `shieldUntil`) and the OPEN GAP case
(green: the trait path still pays). `npm test` reports 0 failures; vendor verify OK.

**Limits.** The Firmament gate is asserted from the source line and locally, not by a live oracle call: the vendored
`net/firmament/firmamentLaw.js` is a stub (`STUBS.md:47`), so `blowPct` cannot fire; the oracle assertion is that a warded
body returns the damage, and the local control (unwarded +20) is the card's number. A live DoT entry keeps ticking through
a ward (M36); no per-round ward test exists on either side. The TRAIT path (the boss `warded` trait and its ward pool) is
NOT covered: its powers still pay, which is the narrowed `W-WARD`.

## Stage 3.6 - Continuous Damage (1,0): the cast's first round, the round clock, accounting, renewal and merge

**What the game does.** Continuous Damage Health is classic key `(1,0)` (`vendor:systems/effects.js:441`). Its rolled
duration is `durationBase + durationMod x max(1, floor(level / durationPerLevel))` (`:611-616`), the cast pushes the entry
and runs its FIRST round immediately, consuming one round (`pushActive`, `:767-772`), and every later round re-rolls the
magnitude and the saving throw (`runEffectRound`, `:720-731`; `GetMagnitude`, `:646-650`). An entry found at 0 rounds is
removed WITHOUT acting (`tickActiveEffects`, `:1986-2026`); a like-kind re-cast renews the incumbent - never stacking,
never shortening, and running the round a fresh cast would have run when the incumbent has lapsed (`renewActing`,
`:762-765`; `renewRounds`, `:628-630`); IsLikeKind is settings-blind, so any ContinuousDamageHealth claims any other
(`:1091-1103`).

**What changed.** `src/cws.js` gained the family: `isContinuousDamage` (:48), the cast arm (:417-453), `runDotRound`
(:486-503) and `tickActiveEffects` (:513-524). The cast's own round is billed through the host's hurt sink and reported as
`dotDamage`/`dotKill` (:383-384, :476); a round on a foe the spell has already killed still rolls its draws (the direct
arm rolls every effect, `applied = !dead && n > 0`) but bills nothing and claims no kill (:490). `src/simulateFight.js`
clones the target per fight so a trial cannot inherit an entry (:309-316), ticks every live entry at the 5 s clock anchors
(:443-481, :690) with the blow first at an equal timestamp, drains the rounds still due inside `maxSeconds` after the
loop whatever ended it (:728-731), and counts rounds in `cwsDamage`, `dotDamage`, `dealt`/`outputDps`, the health segments
and `cwsTrace` (:448-476, :552, :593, :651, :659, :756). A segment round rides the segment it lands in and the
hand of the last blow, so `sum(segments[].damage) === damageDealt`; `objectives.js:103` reads only their count, unchanged.

**Before and after** (lvl-30 BASIC, long blade 121/material 9 with one CWS row -> `(1,0)` magnitude 10, `durationBase` 3,
reference foe `tough`, pool 1e6, 12 s horizon, `cwsRolls` 0.5, seed 3; 13 blows, 10 casts):

| | before | after |
|---|---|---|
| `cwsDamage` | 0 (the 8-point cast round was billed to the sink but counted nowhere; the later rounds never ran) | **24** |
| `dotDamage` | field absent | **24** (8 at the cast, 8 at 5 s, 8 at 10 s) |
| `damageDealt` | 206 | **230** |
| `remainingHealth` | 999786 (206 counted + 8 hidden: the trace did not reconcile) | **999770 = 1e6 - 230** |
| `cwsTrace` rounds | none | `[5, 10]` |
| a second identical trial | 8 hp higher at every blow (the entry leaked) | identical |

Dead round (spell `(4,0)` 1000 then `(1,0)` 1000, pool 10): before, the dead round added a phantom 800 to `dotDamage` and
so to `dealt`/`overkill` (measured `dotDamage` 800; `dealt` 1600, `overkill` 1590 by construction); after, `dotDamage` 0,
`dealt` 800 = the direct effect's kill, `overkill` 790, with the same 6 draws. Drain (same fixture, `maxBlows` 1): before,
no round after the last blow (`dotDamage` 8); after, rounds `[5, 10]`, `dotDamage` 24, `remainingHealth = health -
damageDealt`. Segments (rounds-3 fixture, seed 5): before, the segments summed to 241 against `damageDealt` 257; after,
257 = 257 (`cwsDamage` likewise).

**Outputs moved.** A fight whose spell has a `(1,0)` effect with rounds > 0 changes: hp, `cwsDamage`, the new `dotDamage`,
`damageDealt`/`outputDps`, `overkill` (a round can kill), `killSource: 'dot'`, `ttk`/`time` when a round is the last or the
killing event, `segments`, and `cwsTrace` (cast rows now carry `dotDamage` - and `damage` = direct + own rounds - and each
boundary round is a row with `round: true`, `spell`, `index`, `remaining`, `kill`; `dotKill` on a cast row whose round
killed). A `(1,0)` effect with `durationBase === 0` moves too, in shape rather than in damage: the cast is no longer
deferred (`deferred` 1 -> 0, `continuous` 0), its effects record changes from `{ deferred: true, applied: false }` to
`{ rounds: 0, continuous: true }`, and its `cwsTrace` row gains `dotDamage: 0` - no round, no entry, no draws. Every `(4,0)`
fight is unchanged: all existing fight, gate, durability and relay numbers hold (`npm test` reports 0 failures). The cast
object gains `dotDamage`, `dotKill` and `continuous` (`resolveCwsCast`), and `simulateFight`'s result gains `dotDamage`.

**One fight-level change is not DoT-specific.** `src/simulateFight.js:313-315` clones the target per fight (its
`activeEffects` entries copied), for EVERY fight: the batch hands all trials one scenario object, so a target mutation made
by one trial (a mark, a DoT entry) no longer leaks into the next, and the caller's own target object is left as it was
handed in. `simulateFight`'s `target` result is that per-fight clone.

**Card numbers: unchanged.** `src/spells.js`/`src/enchants.js` are untouched: the CWS-DoT card still prices per tick from
the spell card (`src/enchants.js:145-160`), and `test/enchants.test.js`'s "a Cast When Strikes DoT is priced per tick" and
`test/spells.test.js`'s "a continuous damage spell adds its rounds" pass before and after.

**Evidence.** New `test/dotDifferential.test.js` (8, against the vendored `applySpell` + `tickActiveEffects`): first tick
at the cast with `roundsRemaining` = rounds - 1 (red: local billed nothing and left no entry; green: `[{n: 8, round: true}]`,
one entry); the 3 draws a round takes; `durationBase` 3 = three rounds with the removal pass silent; per-tick magnitude and
throw re-rolls; a live renewal (0 ticks, 0 draws) and a lapsed one (one tick); a settings-blind merge; the expiry pass. New
`test/dotFight.test.js` (8): no cross-trial leak (red: the second trial 8 hp higher at every blow), the trace/health
reconciliation (red: "a DoT round landed" false), the 5 s anchors + the cast's own round (red: `dotDamage` undefined), a
round kill (`killSource:'dot'`, the later `(4,0)` skipped; red: `dotDamage` undefined), the tie (red: 0 rounds at 5 s), the
dead round (red: `dotDamage` 800 !== 0), the drain (red: no rounds after the last blow) and the segments (red: 241 !== 257).
The RED captures are in the stage report; `npm test` reports 0 failures and vendor verify OK.
`test/durability.test.js` keeps the standing-DoT bill at
10 and restores the deferred `(11,8)` case (both pay 10). Waiver `W-PROC-BUDGET` (procs and DoT rounds summed on the
ceiling, per-tick capping, no relay summing) still holds: no relay or allowance summing is modelled here.

**Limits.** No round summing across relay and allowance; no ward suppression of a round; a round keeps the cast's spell
power and pierce (M34); enemy-cast DoTs are not modelled; the round phase is an assumption (M35).

## Stage 3.5.3g - relay durability option guard (2026-11-17)

**What was wrong.** `simulateRelayFight` ignored `durability: true`: relay durability is not implemented, but the option
silently produced an ordinary relay fight with no wear/bill/break state. The module's established convention for an
unsupported option on a supported target is an explicit `Error` (`simulateRelayFight: ... not supported`), not `null` or a
no-op.

**What changed.** `src/relayFight.js` refuses the flag after the relay target and positive pool are established:

```text
simulateRelayFight: relay durability is not supported; omit durability or pass durability: false
```

`simulateRelayFights` runs the single fight and propagates the error. Omitted and `durability: false` are byte-for-byte the
same result (deep-equal minus the `with` closure; same claims/engine trace). A non-relay target keeps the `null` contract.
Only `=== true` is refused, matching `simulateFight`'s own durability switch; `durability: 1`/`'true'` are not enabled
states there either. No relay claim, Flow, echo, ward, target or result semantics change.

**Evidence.** `test/relayClaimFight.test.js` new guard test: omitted vs `false` deep equality and claims; `trace`
orthogonal; the exact error on the single entry, on repeat, and through `simulateRelayFights`; a non-relay target stays
`null`. Focused relay suite **40/40**. Full suite **690 tests, 690 pass**; vendor **289 vendored + 122 stubbed**; parity
**1855/1855**. `vendor/` and `src/relayClaim.js` untouched.

**Limits.** Relay durability itself is not implemented; the guard only makes the unsupported request fail clearly. The
guard is on the relay path (a non-relay target still returns `null`). Ordinary fight durability is unchanged.

## Stage 3.5.3f - Many Endings after a weapon break (same-ID survivor)

**What the game does.** `blowPowers` keeps a worn weapon's power when it is the striking weapon **or when the striking weapon
carries the same power ID** (`vendor:systems/loot/lootPowers.js:262-268`). `wornPowers` is read fresh (`:244-258`), and the
strike listener runs after the core's wear (`vendor:combat/formulas.js:769`, `:869-877`; `lootStrike` `:351-387`, registered at
`:860`). A breaking blow therefore still rolls the echo from a surviving weapon carrying the same ID; no survivor, a different
power, or a what-if-only striker does not. Main/off are symmetric; the echo repeats the blow's final damage
(`again`, `:444-454`).

**What changed.** `src/blowOutcomes.js` carries `meta.echoPowers` aligned with `echoMask`: each echo is the equipped item's own
ID (`powerIdsOf`/`powerOf`) or a what-if source. `src/simulateFight.js` masks a `brokeNow` blow's sampled echo bits to the
surviving hand's own same IDs, keeps only eligible hits, and reports `echoSuppressed` true only when nothing eligible remains;
a what-if-only echo is never resurrected. `brokeAfterKill` keeps its previous suppression (the kill ends the fight). The
trace's `echoHits`/`echoDamage` are the eligible hits on a break, 0 when none (the local sample is not presented as an
upstream event); on a no-break they remain the local sample (item echoes upstream, what-if additions pricing). The lone-weapon
test now asserts `echoHits: 0`.

**Before and after (production, main breaks on blow 1, seed 0, `warp-edge` both hands).** Before: `echoHits: 1`,
`echoSuppressed: true`, `echoDamage: 0`, `echoApplied: 0`. After: `echoHits: 1`, `echoSuppressed: false`, `echoDamage: 4`,
`echoApplied: 4`; upstream echo event 1. Controls: off plain / off `eye-of-magnus` / striker plain with an off-hand duplicate
all no echo (upstream 0); no break applies; the mirrored off-hand break applies.

**Evidence.** `test/echoDuplicate.test.js` (8): the seven-case upstream differential and production table; what-if-only;
two echo powers where only the matching item echo remains; no-break duplicate/single controls. Mutations caught (12): broad
suppression (6 fail), unconditional retention (6), whole aggregate retained (1), suppress on any match (6), the striking hand
instead of the survivor (4), a what-if source as eligible (2), the trace local sample on a no-eligible break (4), per-hit
using the aggregate (1), the item ID dropped (4), after-kill suppression removed (1), echo order reversed (1), no-break
suppression (2). Parity: durability-off and no-break behaviour unchanged; the earlier durability/imprint/CWS/scheduling
suites pass. Full suite **689 tests, 689 pass**; vendor **289 vendored + 122 stubbed**; parity **1855/1855**.

**Not changed / limits.** The pinned data has one echo item (`warp-edge`), so the multiple case uses an item echo plus a
what-if echo; the mask logic is generic for multiple item IDs. A what-if echo on a no-break fight remains a local pricing
sample. `brokeAfterKill` keeps its prior trace. The same-ID exception for other power kinds (Flow charge, leech, chain, ...)
is outside this ordinary fight's echo listener. `vendor/` and `src/relayClaim.js` are untouched.

## Stage 3.5.3e - what-if edits ride their carrier (2026-11-16)

**What the game does.** An imprint is a field on the item (`systems/loot/lootRarity.js:1271`), and every reader takes the
powers from the equip table on the call: `wornPowers` (`vendor:systems/loot/lootPowers.js:134`, `:244-258`), `blowPowers`
(`:262-268`), `lootBlow` (`:286-347`), `lootStrike` (`:351-387`), `lootSpellPower`/`lootSpellPierce` (`:747-763`). The Strikes
payload reads the `charged` weapon's own rows (`vendor:combat/formulas.js:826-833`). There is no cache; `lowerCondition`
unequips by identity (`vendor:systems/equip.js:570-608`), so a break removes the item and every imprint with it. The breaking
blow keeps them (payload and `lootBlow` run before `damageEquipment`, `formulas.js:769`). Main and off hand behave the same.

**What changed.** `analyze(...).with(edit)` prices `imprint`/`loot`/`potentVs` on the MAIN-hand item (`src/model.js:1010-1022`,
`:1055`; `src/blowOutcomes.js:96-99` nulls them for the off hand). `src/simulateFight.js` now treats those three keys as
carrier-bound: `CARRIER_EDIT_KEYS`/`withoutCarrierEdits` strip them **only when the main hand breaks**, before the survivor's
schedule, tier and `refresh()` thresholds are rebuilt. An off-hand break keeps them (the main carrier is alive). Equipped item
powers are untouched; `potencyPct`, `pierce`, `flowStacks` and every other scenario field are kept.

**Before and after** (production `simulateFight`, main breaks on blow 1, same seed). Venom what-if (+8):

| | breaking blow | post-break blows |
|---|---|---|
| equipped Rare imprint on the main | 7* | 21 0 20 15 22 |
| priced what-if before | 7* | 29 0 28 23 30 |
| priced what-if after | 7* | 21 0 20 15 22 |
| control | 5* | 21 0 20 15 22 |

`potentVs: 5`: +5 on the breaking blow; +5 on every later blow before, 0 after. `loot: { flat: 6 }`: +1 on the breaking blow;
+6 on landed later blows before, 0 after. An execute imprint's `bounds` `[1,0.5,0.25,0]` becomes `[1,0.5,0]`. An off-hand break
keeps the main's edits (+8 post-break). A survivor's own equipped Rare imprint remains (+8).

**Evidence.** `test/imprintLifetime.test.js` (10): the vendored lifecycle (`wornPowers`/`lootBlow`/`lowerCondition`/full blow),
then production fights for the priced imprint, Potent Vs and loot flat (breaking blow keeps them; post-break equals the no-edit
control and the equipped item), an off-hand break, the execute threshold, a survivor's own equipped imprint, scenario
`potencyPct`/`pierce`, and `flowStacks`. Mutations caught in a throwaway copy (10): no strip (4 fail), strip on every break (1),
strip before the breaking blow (4), strip only `imprints` (2), only `loot`+`potentVs` (2), only `potentVs` (3), `flowStacks`
(1), the wrong hand (5), strip after `refresh()` (1, stale thresholds), and strip the real character-level inputs from `scenario`
(1). Stripping `potencyPct`/`pierce` from `fightScenario` alone is equivalent - `refreshCwsPower` reads the original `scenario`.
Parity with `b6ee533`: 250 pair/single fights (durability off and on, no break), 120 CWS no-kill fights (40 with breaks), the
3.5.3a scheduling table and 160 kill/echo/post-kill-break fights byte-identical. Full suite **681 tests, 681 pass**; vendor
**289 vendored + 122 stubbed**; parity **1855/1855**.

**Not changed / limits.** Priced spell-power imprints remain unsupported (`spellPowerInputs` reads worn items and explicit
`potencyPct`/`pierce`, `src/cws.js:250-291`) - the pre-existing priced spell-power gap, pinned by the test. Flow stack dynamics
are out of scope (the fight takes `flowStacks` as a scenario constant). No event-level RNG equivalence is claimed. `vendor/` and
`src/relayClaim.js` untouched; G5, G7, G8, relay durability, target gear wear, fist scheduling, DoT, ranged combat and the
optimizer are untouched.

## Stage 3.5.3c - closing the independent audit of Stage 3.5.3b (2026-11-16)

The audit of `2c2ece8` found three proven defects (G3-1, G2-1, G6-1) and coverage gaps; none moved a damage, kill or TTK number.
Full record: the stage record section 6. Implementation fixes vs documentation/test-only items:

**Implementation fixes.**
- **G3-1 (trace).** A bill after a killing cast can break and unequip the striking weapon before the strike listener reads
  `wornPowers` (`vendor:systems/loot/lootPowers.js:244-258`, `:351-386`; `systems/equip.js:570-608`). `echoSuppressed` now reports
  that case (`src/simulateFight.js`: `brokeNow || brokeAfterKill`). Applied echo, melee, kill, TTK are unchanged - the CWS kill
  already stopped the echo. Before: cond 25 / 15 with an echo weapon, `echoSuppressed false`, `echoDamage 5`; after: `true`, `0`.
  A kill with the weapon intact is still `false` (the echo is lost to the kill alone).
- **G2-1 (aggregate).** `weaponsBroken` counted a weapon supplied at 0. It now counts transitions: the fight snapshots which hand
  items start at 0; a wear break on such an item carries `again` (as a CWS bill already did), and `fightsWithBreak`,
  `timeToFirstBreak`, `timeAtRiskWithoutBreak` use DISTINCT breaks. Before (5 fights, main supplied at 0): `weaponsBroken` counts
  `[0,5,0]`, `breakProbability` 0.4 with `breakEvents.distinct` 2 - three numbers that disagreed; after: `[5,0,0]`, 0, distinct 0,
  repeats 2. A weapon that starts above 0 is unchanged, so every other fight reconciles as before (law: `weaponsBroken` = distinct
  break reports, tested on every row of three sets).
- **G6-1 (CLI JSON).** `build --json` now carries `procsBeforeBreakBasis` like `enchant --json`; the source-string test is replaced
  by tests that run `dfo-dps build|enchant --theory --json` and parse both documents.

**Documentation / test only.** `timeAtRiskWithoutBreak` is `null` when every trial broke (documented, tested); after-kill breaks
count in the break probability at the kill time (documented, tested); an unregistered row after a kill stops the walk and the bills,
and a missing record after (or before) a kill is billed, never cast (production fights against the vendored walk, 18 cases); the
budget/horizon tie is `blowBudget` (tested alone and tied); paired builds with different weapons fight with their own items; Stage
3.5.3a test 8 is renamed and pins the documented pre-break drift as exactly `offHandHoldTicks` x tick per earlier off blow
(scheduling unchanged).

**Verification.** Parity with `2c2ece8`: 250 pair/single fights (durability off and on, no break), 120 CWS no-kill fights (40 with
breaks) and the 3.5.3a scheduling table are byte-identical; 160 kill/echo/post-kill-break fights are identical in every field
except the trace's `echoSuppressed`/`echoDamage` entries (suppressed entries 40 -> 120). Mutations caught in a throwaway copy
(14): `echoSuppressed` ignoring the after-kill break (1 fail); `weaponsBroken` counting the supplied-at-0 weapon (1), the wear repeat
not flagged (1), `fightsWithBreak` / the first-break time / the at-risk set from any report (3); the basis dropped from `build`
(1) or `enchant` JSON (1); the walk passing an unregistered row (1), a missing record after a kill unbilled (1), an empty at-risk
summary object (1), horizon winning the tie (1), paired builds sharing the first entry (2), and the pair timeline losing its
averaged hold (1, test 8). Full suite **671 tests, 671 pass**; vendor **289 vendored + 122 stubbed**; parity **1855/1855**.

**Not changed.** The combat formula, CWS order, post-break scheduling, the RNG model, `vendor/`, `src/relayClaim.js`; G4, G5, G7, G8.

## Stage 3.5.3b - durability accounting and aggregate metrics (2026-11-16)

Closes G2, G3 and G6 of the Stage 3.5.3 audit. Full record: the stage record.

**What the game does (G3).** `doItemEnchantmentPayloads` walks every row of the item with no death test
(`vendor:systems/enchantments.js:1040-1085`); a Cast When Strikes row returns its 10-point bill whether or not its cast landed
(`:585-602`) and `applyResults` bills it at once (`:1124-1133`, `:401-409`). The host's `applySpellToTarget` finds the foe with
`!x.dead` and casts nothing when it is dead (`full:scenes/hostEnchant.js:198-209`). So after a killing cast the later rows are
processed and billed but not cast; the melee blow and echo are not run.

**What changed.** `src/simulateFight.js` (durability on): the row loop no longer stops at a kill; a later row skips the cast (no
draw, no damage), pays its bill and is traced `afterKill: true, cast: false`; a break by such a bill carries `afterKill: true`,
and a bill on an item already at 0 carries `again: true`. Durability off keeps the stop (nothing to bill). Each fight result gains
`endReason` (`kill` / `noWeaponLeft` / `blowBudget` / `horizon`, exclusive) and `weaponsBroken`. `simulateFights` gains `outcomes`
(killed / noWeaponLeft / horizonCensored / blowBudgetCensored, partitioning the trials; `censored` is unchanged and equals the
last three) and, with `durability: true`, `durability` (break probability, time to first break, weapons broken, break events by
reason, no-weapon-left, end condition per hand - denominators and censoring in the stage record). `src/enchants.js` adds
`cwsBillCapacity`, `PROCS_BEFORE_BREAK_BASIS` and `billCapacityNote`; `procsBeforeBreak` keeps its name and value (G6) and
`analyze()` / the CLI JSON carry `procsBeforeBreakBasis: "cws-bill-only"`; the CLI text now says bill-only.

**Before and after (G3).** A three-row item whose first cast kills, ordinary wear 1: condition 45 -> final 34 (one bill) became 14
(three bills); 25 -> 14 became 0 (breaks on the third row's bill); 15 -> 4 became 0 (breaks on the second row's bill, a repeat on the
third); 5 -> 0 stays 0 but now reports three bills and two after-kill repeats. Kill, melee, echo and TTK are unchanged.

**Outputs moved.** Only fights with `durability: true` in which a CWS cast kills while later CWS rows remain: the final
`condition`, `breaks` and the new trace rows. Durability off, durability on with no kill-with-later-
rows, and the post-break schedule are unchanged: 250 seeded pair/single fights (durability off and on, no break) and 120 CWS
no-kill fights (40 with breaks) are byte-identical to `971e245`, and the 3.5.3a scheduling table is identical.

**G6.** `procsBeforeBreak` is `floor(condition / 10)`: bills only. It is not a cast count (cond 25, one row: the vendored walk casts
3 times, the figure says 2) and it ignores ordinary wear (a 400-point weapon, bound 40, casts 31-33 times before breaking in 24
production fights, none reaching 40). No wear-aware estimate is offered.

**Evidence.** `test/durabilityAccounting.test.js` (15): 16 production fights (4 conditions x 4 kill rows) equal the vendored walk
with the host's live-foe gate; after-kill breaks, no melee/echo, controls, durability off, `spareGear`; the gate conservation law;
hand-built aggregate rows; a 60-trial mixed set (11 killed / 28 no weapon / 21 horizon); a pair on paired seeds; the end-reason
priority; the label and the two misleading readings. Mutations caught in a throwaway copy (15): skipping post-kill bills (2 fail),
post-kill rows casting (1), a double bill on the killing row (3), bills on blows the gate would not walk (1; found as a gap and
closed by the conservation test), break termination reported as horizon (4), no-weapon fights absorbed into the horizon count
(1), a wrong break-probability denominator (2), the last instead of the first break time (1), the basis label dropped (1), the CLI
saying "procs before break" again (1), repeat reports counted as weapons (1), the `afterKill` flag dropped (1), an after-kill break
suppressing the echo (1), `weaponsBroken` counting events (1), and the durability aggregate dropped (2). Full suite
**662 tests, 662 pass**; vendor **289 vendored + 122 stubbed**; parity **1855/1855**.

**Not changed.** Post-break scheduling, Flow and Many Endings, relay CWS and durability, target gear wear, the fist fallback,
event-level RNG, DoT and ward lifecycles, ranged support and the optimizer. G4, G5, G7 and G8 remain open. `src/relayClaim.js` and
`vendor/` are untouched.

## Stage 3.5.3a - the swing schedule after a weapon breaks (2026-11-16)

**What the game does.** A break does not cut the swing in flight. The vendored `PlayerWeapon` keeps stepping the strike to its
last frame (`machineStep`, `characters/weaponStates.js:472-`) and, for an off-hand blow, through the whole ticks of its held
burden (`_swing` sets `machine.hold`, `combat/playerWeapon.js:812-826`; `offHandHold`, `combat/twoHands/handsLaw.js:273-278`,
the fraction carried between blows). Every one of those remaining steps reads the tick of the hand now in use - the survivor's
(`swingCtx`/`getMeleeWeaponAnimTime`, `playerWeapon.js:838-840`, `:1123-1140`; `combat/swingLaw.js:26-47`). The hand change itself
is only `followHeldHand` (`:443-452`). With one weapon left the hands mode is Single (`handsModeOf`, `handsLaw.js:63-70`), so
the next strike is a fresh five-tick swing (`strikeHandOf`, `:144-150`), hit on frame 2. Recorded trace, equal weapons, in
ticks: a main-hand break at hit 2 ends its swing at 5 and the lone hand hits at 7; an off-hand flurry blow breaking at hit 6
ends at 9 and the lone hand hits at 11. Different ticks: 121 broken / 113 surviving, hit 0.398 s, swing done 0.9357 s = 0.398 +
3 x 0.1792 (the survivor's tick).

**What changed.** `src/simulateFight.js`: the schedule's events carry `tail` (`MELEE_NUM_FRAMES.StrikeDown - HIT_FRAME_MELEE`
ticks left after the hit) and `holdTicks` (the off blow's integer hold, `offHandHold` replayed with its carry). The survivor
promotion starts the new single-weapon schedule at `t + (tail + holdTicks) x survivor tick` instead of at the break hit's time
(`t`), so the in-flight swing finishes first, at the survivor's tick, and the survivor's fresh swing hits two of its ticks later.
Nothing else moved: the survivor's cadence, powers, health thresholds and the current blow's completed effects are as before.
No hand-fitted offset: the tail and hold come from the vendored frame table and `offHandHold`.

**Before and after** (next survivor hit; seconds). Single/dual main/off breaks, equal weapons: error -0.5492 -> 0.0000 (exact,
`< 1e-9`). Mixed ticks (121/113, 113/121, 124/113, main and off breaks): -0.4943..-0.5938 -> -0.0001..-0.0002, the machine's
whole-frame rounding at a 1/50000 s frame. Examples: dual main break at 0.3661: next hit 0.7322 -> 1.2814 (machine 1.2814); dual
off break at 1.0984: 1.4645 -> 2.0137 (machine 2.0137). The full table is in the stage record, "Post-break
schedule".

**Outputs moved.** Only fights with `durability: true` in which a hand breaks and the other survives: every blow after the break
lands 0.49-0.59 s (three of the survivor's ticks) later, so TTK and output DPS after a break move accordingly. Durability off, and
durability on with no break, are unchanged: 250 seeded fights (single and dual, four weapon pairs, 25 seeds, both switches)
are byte-identical to `634effb`.

**Evidence.** `test/postBreakSchedule.test.js` (11): the machine's hands mode and recorded tick trace; main and off breaks with
equal weapons exact; three mixed-tick pairs; a held off-hand burden (hold sequence 0, 0, 1 against the machine's own
`machine.hold`); survivor powers/thresholds/cadence; the breaking blow still landing; durability on = off and equal to the
machine with no break. The test fails before the change (every break case errs by the three survivor ticks above). Mutations
caught in a throwaway copy: restart at the break hit (8 fail), one tick too many (8), one too few (8), survivor not switched to
the lead hand (5), the broken weapon's tick (4), the survivor schedule built from the broken weapon (5), the held burden dropped
(1), an averaged instead of integer hold (3), the burden carry dropped (1), the fresh swing's hit frame skipped (8). Full suite
**647 tests, 647 pass**; vendor **289 vendored + 122 stubbed**; parity **1855/1855**.

**Not changed / limits.** The pre-break pair timeline keeps the exchange's averaged held burden, so absolute pair times drift from
the machine by the fraction of a tick not yet carried; only the swing in flight at the break uses the integer hold. A build
carrying an off weapon but scheduled as a single weapon is not a state the game can be in (two one-handed weapons are the pair);
it takes the pair's lead-swing-in-flight rule. No fist swing follows the last weapon (the fight stops and reports
`endedByBreak`). G2-G8 of the Stage 3.5.3 audit (durability aggregates, kill-row bills, imprint semantics, the duplicate-id echo,
the `procsBeforeBreak` label, the relay guard, the stale header) are not part of this change. `src/relayClaim.js` and `vendor/`
are untouched.

## Stage 3.5.2 - ordinary weapon durability, the CWS condition bill and breakage (2026-11-16)

**What the game does.** `damageEquipment` runs at the attack core's tail (`vendor:combat/formulas.js:569-597`,
`:769`; the live overhaul's call `vendor:combat/pcaao.js:1847-1860`) and wears the attacker's striking weapon by
`trunc((10 * damage + 50) / 100)`, where `damage` is what went through the core; a 0 amount draws one `dice100(20)`
roll that can make it 1 (`:585`), and the port's wear scale/multiple of 1 draw no further roll (`systems/equip.js:555-568`).
A `spareGear` target wears nothing (`:574`). `lowerCondition` (`systems/equip.js:570-608`) clamps at 0, unequips by
IDENTITY, clears `owner.weapon`, and a piece with no `maxCondition` cannot break. A Cast When Strikes row casts and then
bills 10 condition (`systems/enchantments.js:585-602`, `:115`), immediately through `applyResults`
(`:1124-1133`), even for a resisted, absorbed, deferred, zero-damage or missing-record cast; `spareGear` zeroes the bill
(`:1066-1072`). The row walk continues after a break. The current blow's damage was computed before the wear and lands;
the broken hand is unequipped and the other hand becomes the lead (`combat/playerWeapon.js:443-452`, `:505-508`).
Many Endings' echo and Flow's per-blow charge read `wornPowers` after the break and are lost; Flow's current-blow damage
survives.

**What changed.** `src/durability.js` holds the wear amount, the floor roll, the bill and the vendored break leaf over
a fight-owned synthetic equip table. `src/simulateFight.js` takes `durability: true`: it clones the items (caller
objects untouched), carries a named `condition` stream (`conditionRolls` injectable), wears the striking weapon from the
PRE-payload `strikesDamage` before the CWS rows, bills every row after its cast, clamps/unequips/clears on a break,
suppresses the Many Endings echo when the item broke, keeps the current blow, promotes the surviving hand as a single
weapon with a fresh schedule and powers/bounds, and stops with `endedByBreak` when no weapon remains (the local model
has no fist schedule). A condition-band crossing rebuilds the next blow's tier. The result adds `durability`,
`condition` (raw), `conditionPct`, `breaks`, `wear` and `endedByBreak`; the traces add the wear/bill/band fields.

**Outputs moved.** None by default: `durability` is off, so every Stage 3.1-3.5.1 number is unchanged. With
`durability: true`, a fight's damage/TTK move as the weapon's condition crosses a band and stops (or continues on the
other hand) when it breaks; the `condition`/`breaks`/`endedByBreak` fields are new.

**Live spell power after a break (correction).** Upstream's `spellPowerMult` reads the wearer's current worn powers when
the spell resolves (`systems/loot/lootPowers.js:747-763`), so a break by ordinary wear or by an earlier CWS row's bill
must reach the very next cast. The fight now rebuilds its effective hand table and refreshes potency, pierce and Arcane
Surge immediately after such a break - before the first row of the same blow, and before the next row after a bill
break. The CWS row trace records the `potencyPct`/`pierce` used. Before: a wear-broken potency weapon cast at 1.15/9
instead of 1/8; a first-row bill break left the second row at 1.15/9 instead of 1/8; a broken `eye-of-magnus` kept its
15 pierce (10 instead of 8); a broken `shalidors-brand` kept 25% Surge (10 instead of 8). After: each reads the surviving
table. Stale-table mutations after the wear and after the bill both fail.

**Full-equipment reconstruction (closure-audit correction).** The closure audit found that `rebuildEffective` rebuilt
from the already-`countedPieces` effective list and excluded every slot-19/21 entry. That lost a surviving higher-slot
copy of a duplicated Legendary record when the lower-slot hand copy broke (cast potency/pierce 0 instead of the surviving
copy's 5/15), and dropped a shield in the other hand (potency 0/damage 8 instead of the shield's 10/damage 9). The fight
now keeps the FULL pre-dedup equip table (`equipTableForFight`), removes exactly the broken item by identity, and lets
`spellPowerInputs` apply `countedPieces` to the current table on every read. A surviving higher-slot Legendary copy, a
hand-slot shield and all non-hand pieces stay; potency, pierce and Arcane Surge refresh from the rebuilt current
equipment before the next cast. No-break numbers are unchanged. The stage record is
the stage record.

**Closure.** Stage 3.5.2 is **CLOSED — PASS WITH DOCUMENTED LIMITATIONS**. The independent closure audit at `c8eb31b`
against pinned upstream `a3eb1605` made no code or test changes and confirmed **636/636 tests**, vendor
**289 vendored + 122 stubbed**, and parity **1855/1855 identical**; `src/relayClaim.js` and `vendor/` are untouched, and
no Stage 3.5.3 work exists. The audit independently reproduced both reconstruction regressions above as fixed. The
remaining test gaps (lower-slot duplicate survival, a what-if main break with the worn original present, two breaks in
one blow, a direct `equipTableForFight` unit, a no-break side-by-side against `6199a07`, and a `simulateFights`
own-worn break) are coverage gaps, not runtime defects; the limitations in the stage record stand.

**Evidence.** `test/durability.test.js` (30). The wear, bill and break laws are compared directly with the vendored
`damageEquipment`, `doItemEnchantmentPayloads` and `lowerCondition`; a production fight's whole wear/bill/break state is
replayed through upstream on the fight's own `strikesDamage` sequence. Mutation checks in a throwaway copy caught wear
rounding, the floor roll omitted/always drawn/at 19%, the bill at 9 or only on a damaging cast, echo suppression off, a
break without unequip, no survivor promotion, content-based item removal, the current blow dropped on break, later rows
skipped after a break, survivor powers not refreshed, the off slot left occupied, the schedule not swapped, the broken
item kept in the spell-power table, `conditionRolls` ignored, the band missing from the tier key, post-payload wear and
an extra condition draw, no refresh after a wear break, no refresh after a CWS bill break, taking the table from the
post-`countedPieces` list, dropping a surviving hand-slot non-weapon, refreshing only the first break, and skipping the
worn-list clone. Full suite
**636 tests, 636 pass**; vendor **289 vendored + 122 stubbed**; parity
**1855/1855**.

**Not changed.** `src/relayClaim.js` is untouched. Relay-boss durability, the target's shield/armour wear, the fist
fallback (the fight stops and reports `endedByBreak`), CWS bills for rows after a kill, pack removal/repair and other
condition sources (Cast When Held/Used, item deterioration, target blows) remain out of scope. DoTs, the ward
lifecycle, ranged support and the optimizer are unchanged.

## Stage 3.5.1 - ordinary-enemy Cast When Strikes direct damage (2026-11-16)

**What the game does.** A Cast When Strikes row is a `Strikes` payload at the tail of
`calculateAttackDamage` (`vendor:combat/formulas.js:826-836`, `vendor:systems/enchantments.js:590-602`). It casts
when a target exists, the final formula damage is not 0, the target is not `warded`, the item is enchanted, the blow
counts `whole`, and the attacker is the player or the damage is positive. The guard reads the damage BEFORE the
payload (`enchantments.js:1060-1072`); Potent Vs / Low Damage Vs only change the separate `damageOut`. Each row is
cast in the item's order; the payload walk returns at the first unregistered enchantment type (`:1052-1060`), so no
later row runs. A missing spell record casts nothing. The cast lands before the strike listener's echo and the host's
melee blow; a CWS kill or an echo kill makes `damageFoe` drop the melee blow
(`full:scenes/dungeonContext.js:6781`). Direct damage is the actual `isDamageHealth` family, classic (4,0)
(`vendor:systems/effects.js:440`, `:1080-1088`); the spell's per-effect absorption, reflection, resistance and
saving throw follow `vendor:systems/effects.js:991-1038` and `vendor:systems/spellcast.js:203-236`. Damage Health's
save takes `spellPierce`; the landed amount takes `spellPowerMult` (online school past 100 and registered spell-power
modifiers, `spellPower.js:56-101`, `lootPowers.js:747-763`).

**What changed.** `src/enchants.js` adds `REGISTERED_ENCHANTMENT_TYPES` and `payloadRows`; `src/model.js` carries
`strikesDamage`/`strikesPositive` (the PRE-payload damage); `src/blowOutcomes.js` keeps them in the fight tier and
merge key. `src/cws.js` uses `strikesPositive` for `cwsEligible` (not `formulaPositive`, which stays Flow/echo),
stops `cwsRows` at the payload abort, and applies pierce, online school potency and spell power in `resolveCwsCast`.
`src/simulateFight.js` resolves the CWS event before the echo and the melee blow, applies the echo as its own hit,
suppresses the melee on a CWS or echo kill, and counts only effects that land. The local result exposes `cwsDamage`,
`cwsCasts`, `cwsKills`, `cwsTrace`, plus `strikesPositive`/`echoDamage`/`echoApplied`/`echoKill`/`meleeApplied` on the
swing trace. `src/target.js` defaults `activeEffects: []`.

**Outputs moved.** Builds with a CWS row and a resolvable Damage Health spell now include CWS direct damage in
`simulateFight`'s `damageDealt`, `outputDps`, `expectedPerSwing`, `ttk`/`kill`, `overkill` and `segments`; the
`cws*` fields are new. A Potent Vs miss no longer casts; a Low Damage Vs blow taken to zero still casts. An echo kill
no longer carries the melee blow in `damageDealt`/`overkill`. Builds without CWS are unchanged. The analytical
`analyze`/`enchantDps` card is unchanged.

**Final-audit corrections.** The gear spell-power list is the effective equipped list (`equippedForFight`), and `spellPowerInputs` requires `worn` rather than falling back to the inventory. Arcane Surge uses `liveMaxMagicka` (base + the ExtraSpellPts `_enchantMods.maxMagicka`), and an ExtraSpellPts row without that fold is rejected. `simulateFight` refuses relay/`spareGear` targets and the unsupported boss/shield/revenant/bout/companion contract; `makeTarget`/`enemyTarget` default `spareGear: false`, with `standInTarget` keeping true. The fake firmament field guard was removed.

**Closure-audit corrections** (the stage record). The equipped list is now upstream's equip table: `equippedForFight` places the scenario main/off weapons as the occupants of the HAND SLOTS (the worn hand piece is replaced, never joined), recognises a live snapshot's clone and the caller's original as one piece by slot or content, and applies `countedPieces` (a Legendary record counts once, `lootRarity.js:2348-2357`); `spellPowerInputs` holds one piece per slot under the same law. `schoolPotencyFor` passes `_online: true` on the entity handed to `fightingClimb`, as the game sets `playerEntity._online = isOnlinePage()` (`full:scenes/world.js:25813`), so an online character's master skills are in force regardless of the offline switch - an online default save with a mastered school reads 1.17, not 1. ExtraSpellPts without the live fold is rejected only where an Arcane Surge power reads it, and `simulateFight` resolves the spell-power path only when a striking item carries a CWS row, so unrelated ExtraSpellPts gear no longer refuses a plain fight. The target guard reads relay/`spareGear`/boss/phase-shield flags by truthiness, and refuses a per-hit cap or scenario boss traits when the fight can cast (the direct-damage path knows neither). The fight-level evidence is replaced: a TTK z-test, a fixed-horizon damage/CWS share, the CWS/Many Endings/melee kill-source split, and an off-hand CWS case. `simulateFight` also reports `cwsCapable` and the new `echoDamage`, `meleeDamage` and `killSource` (`cwsDamage`/`cwsCasts`/`cwsKills` were already there).

**Second closure-audit correction** (equip-table identity and the Surge contract). A scenario weapon now replaces ITS hand's piece: `equippedForFight` matches the build's `weapon`/`offWeapon` object first, then the slot it is worn in, then the hand slot; content equality is used only for a hand-built list with no slots and never across hands. Before this, two content-identical weapons in worn order `[off, main]` with a main-hand what-if of potency 5 read 20% and cast 17 instead of 15% and 16. `equipList` now orders the effective list by slot - the equip table's own order - before `countedPieces`, so a duplicated Legendary record keeps its lowest slot: a direct list `[slot5:10, slot4:15]` reads 15 (was 10), and a duplicated Legendary across the hands with an off-hand override reads 10 (was 5). Arcane Surge's maximum magicka now has one contract: `maxMagicka` is the LIVE value a save stores (`full:systems/save/save.js:341`; the accessor already contains the ExtraSpellPts channel), so it is never folded again; a hand-built BASE declares `maxMagickaBase` and gets `_enchantMods.maxMagicka` once. A live getter is accepted without the fold, and the ExtraSpellPts check fires only where a Surge power reads a declared base.

**Evidence.** `test/cws.test.js` (10), `test/cwsCorrections.test.js` (26) and `test/cwsDifferential.test.js` (19).
The differential drives the pinned `calculateAttackDamage` with an enchantCtx whose `applySpellToTarget` calls the
vendored `applySpell`, then compares the local resolver on the same seeded draws: direct damage and draw counts;
career tolerance, immunity, spell resistance and elemental resistance; absorption; reflection; the 4,0/1,0/11,8
boundary; the call/no-call matrix; row order; and the CWS-kill host gate. The rebuilt cases start from
`blowFightTier`/`simulateFight` for the Potent Vs/Low Damage Vs trigger, compare `cwsRows`/`payloadRows`/`strikesNet`
with the vendored payload walk, compare registered spell power/pierce and online school with `applySpell`, compare the
gear inputs with `lootSpellPower`/`lootSpellPierce`, compare multi-effect death with the host hurt sink, and compare
the echo-kill gate with the host `lootStrike`/`hurtFoe` path. Absorption reuses the vendored `tryAbsorption` law, so
the differential verifies its integration rather than a second absorption implementation. The fight level has four
independent comparisons on the same event list and per-trial seeds: TTK (480 trials, |z| <= 4 and a 1% mean; a 5%
spell-power error gives z ~ 11.6), fixed-horizon damage and CWS share (240 trials, 600 s), the kill-source split
(CWS/Many Endings/melee, 480 trials, two-proportion |z| <= 3.5) and an off-hand CWS case (480 trials). Full suite
**601 tests, 601 pass**; vendor **289 vendored + 122 stubbed**; parity **1855/1855**.

**Mutation checks.** In a throwaway copy of this tree (55 CWS/fight tests) the eleven audited mutations fail for the
right reasons: A zero spell-power/pierce wiring **51/4**, B the scenario weapon dropped from the equip input **54/1**,
C rows after a kill **54/1**, D echo after a CWS kill **54/1**, E one-piece-per-slot dedupe off **53/2**, F school
without `isPlayer` **54/1**, G off hand reading the main item **54/1**, H caster level 1 **54/1**, I potency cap removed
**54/1**, J Surge threshold `>=` **54/1**, K floor instead of `max(1, round)` **51/4**. The closure audit's survivors
now fail too: L append instead of replace **52/3**, M content dedupe in the equip list **51/4**, O/P/Q each
target-guard clause **54/1** each, T1 strict truthiness on `relayBody` **54/1**, C3 `_online` dropped **54/1**, C4 the
ExtraSpellPts gate made unconditional **54/1**, C4b the gate removed **53/2**, T2 the per-hit cap and the scenario
traits each accepted **54/1**. In the second correction's 60-test set, the content-across-hands mutation fails
C7/C7b/C7c **57/3**, insertion-order and reversed-order `equipList` each fail C8 **59/1**, the live double count and the
ignored base fold each fail the Arcane Surge case **59/1**, the check on any maximum fails **58/2**, and removing the
slotless content match fails C7d **59/1**. Y (echo `round` -> `floor`) is an EQUIVALENT mutant: every tier
`blow`/`echoDamage` is an integer. (The earlier five mutations - `formulaPositive` gate, no payload abort, no pierce/power, counting after
death, melee after an echo kill - remain detected.)

**Not changed.** `src/relayClaim.js` is untouched. Relay-boss CWS, condition costs, ordinary wear, condition bands and
break, Continuous Damage and the other spell families, the reflected bundle's caster-side landing, absorption's
magicka refund, the ward lifecycle, ranged support and the optimizer are not modelled. A static `target.warded` gates
CWS only; the melee blow is not refused. Firmament spell power/pierce is not a `simulateFight` build field; a caller
that has one must pass `potencyPct`/`pierce`. There is no producer field, so there is no refusal guard. `simulateFight`
accepts only a plain ordinary foe: relay/`spareGear` (by truthiness), boss traits/phase shields/shield pool and the
revenant/bout/companion contract are refused; a per-hit cap and scenario boss traits are supported for a melee-only
fight and refused when the fight can cast CWS. No event-level RNG equivalence with the game's default `Math.random`
path is claimed.

---

## Stage 3.4.3 - tier-input evidence and echo verification (2026-11-16)

**No supported melee numbers moved.** `relayClaim.js` is untouched and plain-build identity is unchanged.

**What changed.**
- `blowFightTier` metadata now carries `hand` and the `flowStacks` value the tier's loot percentage actually read
  (`src/blowOutcomes.js` meta; `null` when no Flow power rides that hand). `relayFight` exposes `tierStacks`/`tierHand`
  from `d.tier.meta`, not from the compositor's cached arguments. The real-sampler test now asserts the tier metadata;
  forcing `flowStacks: 5` or `hand: 'main'` into the `blowFightTier` call makes it fail (mutation runs below).
- The event-seam oracle now supplies the **pre-echo** host blow and the **resisted echo** separately. The local seam
  composes them into the claim and derives the echo count by popcount of the upstream echo mask; the test asserts the
  upstream host equals blow + echo, the claim is the rounded sum, and the local echo count equals the popcount of the
  upstream mask. The production tier still carries the echo inside `outcome.blow`.
- Echo distribution remains independently covered by `test/relayEchoDifferential.test.js` (200,000 actual upstream
  draws). No event-by-event RNG equivalence between the production sampler and upstream is claimed.
- **Mutation checks:** in a throwaway copy of this tree, forcing `flowStacks: 5` into the production
  `blowFightTier` call made the real-sampler test **0 pass / 2 fail**; forcing `hand: 'main'` made it **1 pass / 1
  fail**. Both are detected by the new metadata assertions.

Full suite **551 tests, 551 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 3.4.2 - ranged refusal, merge-key and compositor evidence (2026-11-16)

**No supported melee numbers moved.** `src/relayClaim.js` is untouched and the plain-build path is unchanged where no
shield window is set.

**What changed.**
- **Ranged/gun is refused on either hand in `simulateFight` and `simulateRelayFight`**, including a mixed melee +
  Pistolet pair. The old guard checked only the main-hand analysis weapon; `analyze`'s dual arm (`src/model.js:1046`) does
  not reject an off-hand gun, so a katana + Pistolet fell through to a melee exchange. The new checks use both hand
  weapons and throw explicitly; `createAttackSchedule` remains the schedule-level helper the machine-clock test uses.
- **Many Endings requires `target.relayBody === true`**, not a truthy value. Echo builds on an ordinary or hand-built
  target are refused before the first attack.
- **`formulaPositive` is part of the fight-tier merge key** (`src/blowOutcomes.js` `keyOf`), so a pre-pull/pre-trait
  eligible miss cannot merge with an ineligible miss. A synthetic collision test holds this.
- **Flow damage at stacks 1, 2, 3 and 4** is now compared with real upstream draws, by actual damage outcome counts,
  in `test/relayFlowDamageDifferential.test.js` (the earlier local test compared `blowFightTier` with `analyze`).
- **A real-sampler whole-compositor test** (`test/relayRealSampler.test.js`) runs the production sampler/tier, asserts
  the stack count and hand actually passed to `blowFightTier`, replays the local trace's Flow state through upstream
  `lootStrike` at the same item/time, and replays the claims through `relayStream`.
- **The pre-sampled event list is branded** (`test/harness/relayEventSeam.mjs`); `simulateRelayFight` refuses a plain
  `events` argument, so ordinary callers cannot bypass sampling by accident.
- **Identity note:** Stage 3.3 plain-build identity holds **without a shield window**. A `shieldUntil` fight intentionally
  differs: a warded attack now sends no claim (matching `gateCourt.hit`), so `claims`/`refused` change and the engine's
  `shielded` counter is 0; `wardedAttacks` records the turned attacks.

Full suite **551 tests, 551 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 3.4.1 - relay hardening and whole-compositor evidence (2026-11-16)

**No melee numbers moved.** The existing Stage 3.4 melee path and the no-mechanic Stage 3.3 metrics are unchanged
(the plain-build bit-identity test still passes).

**What changed.**
- **Bow and gun builds are refused** by `simulateRelayFight` until their release/landing timing and ward/Flow behaviour
  are modelled. The arrow formula runs at landing (`scenes/dungeonContext.js:4853-4857`; `combat/arrowFlight.js:483-533`),
  not at the release frame the local schedule uses; refusing is the only faithful behaviour here, not a silent
  approximation.
- **Many Endings requires `target.relayBody` up front**, whenever the build carries an echo power. The old mid-loop
  `outcome.echoDamage` throw was RNG-dependent; it is gone. A non-relay target with an echo is refused before the first
  attack.
- **The Flow listener gate is named `formulaPositive`**: the pre-pull, pre-trait formula damage, not the post-trait
  `blow > 0`. On melee the two agree because `bossStrike` never takes a positive damage below 1; the predicate is now
  the source's semantics. The claim itself remains the host-rounded post-trait damage.
- **Whole-compositor differential** `test/relayFightDifferential.test.js` (5): an upstream oracle drives
  `calculateAttackDamage`/`lootStrike` with a seeded Flow clock, `takeOwed`, `bossStrikeAt`, host rounding and
  `applyHit`, then feeds the same upstream outcomes to the local event seam. It compares per-event Flow before/after,
  claim, got, bucket, tokens and health for both-hand expiry/refresh, Echo+Flow on different hands with
  bladeturning, the exact shield boundary, Potent Vs misses and Flow on a relay-refused claim. The local tier's own
  many-endings distribution is separately compared with 200,000 upstream draws in `test/relayEchoDifferential.test.js`.
- `test/relayClaimFight.test.js` test 4 now covers the bow/gun and missing-relay-body refusals and one supported echo.

Full suite **545 tests, 545 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 3.4 - Many Endings and Flow in relay fights (2026-11-16)

**What the game does.** Many Endings (`warp-edge`, `systems/loot/lootRarity.js:1219`) rolls one `_rand()*100 < 10` per
blow whose final formula damage is positive (`systems/loot/lootPowers.js:374`) and repeats it as
`max(1, round(damage))` (`:444-454`), resisted separately as a melee swing and, on a relay body, summed into the SAME
claim (`scenes/dungeonContext.js:4528-4532`). Flow (`anseis-edge`, `lootRarity.js:1205`) is global state: `flowStacks`
is strict (`now < flowUntil`, `lootPowers.js:274`), a whole positive-damage blow sets `flow = min(5, stacks+1)` and refreshes
6 s (`:383-387`), and the percentage is applied inside `lootBlow`'s shared percentage (`:316-318`). The host sends a
claim on positive formula damage, not on the hit flag (a Potent Vs miss is 5), rounds it (`Math.round`) and drops
anything under 1 (`scenes/gate/gateCourt.js:1159-1171`). A warded attack (`t < shieldUntil`) sends nothing and builds
neither Flow nor echo (`gateCourt.js:1152`, `lootPowers.js:354`); a relay token/purse refusal happens after the listener,
so Flow still charges.

**What changed.** `src/flowState.js` is the global Flow clock; `src/relayFight.js` reads it before each attack, passes
it through the existing `blowFightTier` `flowStacks` option (no second formula), charges only on a whole, positive,
non-warded blow, and keeps the strict expiry/cap. One Many Endings power is now supported; the existing fight-tier echo
branch supplies the mask and the echo is already inside `outcome.blow` for a relay body, so it goes out in one claim.
A synthetic two-echo build is still refused. The claim gate is now `damage > 0` and `Math.round >= 1`, not `outcome.hit`;
zero damage still sends nothing. The ward gate is the client's phase shield (`t < shieldUntil`), not the `target.warded`
trait or a ward lifecycle.

**Outputs that moved.**
- A Flow build previously used the tier default (`flowStacks = max = 5`) on every blow. It now starts at 0. At a
  200-point pool, level 45, seed 1: 9 claims / 8.604 s before; 10 claims / 9.519 s after. At a 2,000-point pool the
  first claims fall from 23 to 18 but the kill still takes 91 claims / 87.32 s.
- A Many Endings build was refused in Stage 3.3. It is supported now. At a 2,000-point pool, seed 1: 104 claims,
  TTK 99.219 s, 2,000 damage.
- A Potent Vs miss was skipped. With 20 attacks at level 45, seed 1: 19 claims / 439 damage before; 20 claims / 444
  after.
- A build with neither mechanic is byte-identical to Stage 3.3 (test 15, recorded from `9f23c47`).

Tests: `test/flowDifferential.test.js` (1) exact stack state vs `lootStrike`; `test/relayEchoDifferential.test.js` (3)
joint echo cells, separate resistance and the Potent Vs miss; `test/flowState.test.js` (2); the Stage 3.4 integration
cases in `test/relayClaimFight.test.js` (15). Full suite **540 tests, 540 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 3.3 closure audit - elapsed time and DPS (2026-11-16)

**One semantic fix: fight elapsed time is no longer the claim engine's clock.** `simulateRelayFight` had reported
`time` (and `outputDps = damageDealt / time`) from `createRelayClaimEngine().summary().time`, which is the timestamp of
the last **positive landed claim**. A missed attack after it never advanced that clock, so a censored fight could
report a shorter time and a higher DPS than it simulated. The engine is unchanged: its clock remains the claim
timestamp, and the differential still checks every refused claim's bucket/token/health/clipped state against upstream.

The fight clock is now independent:
- a kill: the killing claim's time (`ttk`);
- the horizon: `maxSeconds` (the fight really was observed to the horizon);
- a `maxBlows` stop: the last simulated attack's time, checked before the horizon so a budget stop is not reported as
  the horizon;
- schedule exhaustion: the last attack.
No-attack horizon fights still have elapsed `maxSeconds`; no-attack budget/schedule fights have 0.

Concrete 2,000-pool, level-45, one-hand example, seed 13:
- a trailing-miss horizon fight (`maxSeconds: 2`): before `time` 0.3661 s, `outputDps` 43.70; after `time` 2 s,
  `outputDps` 8.00 (16 damage);
- the same first two attacks stopped by `maxBlows: 2` with a 3,600 s horizon: before `time` 0.3661 s, `outputDps`
  43.70; after `time` 1.2814 s (the second attack), `outputDps` 12.49.
- a first-attack miss with `maxBlows: 1`: before `time` 0 and `outputDps` null; after `time` 0.3661 s, `outputDps` 0.
- a kill is unchanged: `time = ttk`, and because the relay never deals past the pool, `outputDps = killDps`; the
  killing claim's excess is `overkill` (`healthClip`), not dealt.

`simulateRelayFights` now reports `time`, `claimTime`, `lastAttackAt` and `terminations`; `outputDps` covers every trial
(including censored ones) at the elapsed clock, while `ttk`/`killDps` remain conditional on a kill. `censoredAt` and
`termination` say why a fight stopped.

Proof: the claim engine's 10 local tests now include its claim-timestamp clock and refused-claim purse state; the
Stage 3.3 integration file adds a no-positive-claim blow-budget stop, a trailing-miss horizon, an early `maxBlows` stop
and the killed/censored aggregation. The six-schedule upstream differential is unchanged and still matches `applyHit`.

Full suite **528 tests, 528 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 3.3 - streaming relay claim engine (2026-11-16)

**No existing number moved.** `analyze`, `fight`, `fightRelay`, the objectives, `simulateAllowance` and the Stage 3.2
fight path are unchanged. The stage adds `src/relayClaim.js`, `src/relayFight.js`, the upstream claim oracle and three
test files. The one behavioural addition is a **guard**: `createAttackSchedule` now refuses an unarmed build (the
`StrikeLeft` eight-tick list is not in the analytical cadence) instead of silently scheduling the five-frame interval.

**What the game does.** `gateBrain.applyHit` (`:1298-1336`) refuses a dead fight and a non-finite/non-positive claim
before any clock; refuses while `now < shieldUntil`; spends one token from a four-token bucket refilled at four a
second (`spendBlow`, `:3411`); then refills the damage purse at `3 x ref` a second to `15 x ref` and pays
`got = max(0, min(claim, 12 x ref, bucket, boss health))`. The excess is clipped and discarded, never deferred. A fresh
join starts with a full purse and four tokens; a wounded-boss join starts empty (`:1231-1240`). `ref = 5 + level`
(`:302`). The kill line is `hp <= 1e-6`; there is no rounding.

**What changed.** `createRelayClaimEngine` is a streaming state machine: `claim({t, damage})` returns the per-claim
accepted/refused reason, `want`, cap/bucket/health clips, `got`, and the bucket/token/health state after it, while the
engine keeps only counters and current state. It preserves the game's stale-clock behaviour on refused claims (a
no-token claim advances the token clock, not the purse clock; a shielded or invalid claim advances neither) and the
exact boundaries (token at `>= 1`, shield at equality, cap at equality, exact-health kill). `simulateRelayFight` feeds
it the Stage 3.2 schedule and Stage 3.1 fight tier: a miss is not a claim (no token), the claim is the uncapped sampled
blow, the tier is rebuilt on the player's remaining share, and a build carrying an echo power is refused. The engine
does not model geometry, Sundered halves, stun/profile `hitX`, the Wrath clock, host/crystal claims, phase-ward
lifecycle, CWS/DoTs/Flow, wear or the optimizer; a fixed `shieldUntil` may be supplied.

**What proves it.** `test/relayClaimDifferential.test.js` reads `bucket`, `rate`, `hp`, `dealt` and `clipped` from the
vendored relay after every one of six schedules - four tokens at one instant, the 0.25 s boundary, cap/bucket/health
clipping, an exact-health kill, the shield's strict boundary, a wounded join, invalid claims and a 1,000-claim seeded
stream. `test/relayClaim.test.js` pins the boundaries and a 50,000-claim stream (no history). `test/relayClaimFight.test.js`
replays every traced claim of a seeded relay fight against the upstream oracle, and covers saturation, deterministic
replay, the trial distribution and the guards.

Full suite **525 tests, 525 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 3.2 closure audit - timing, thresholds and censoring (2026-11-16)

**One output moved: a bow fight's first hit.** The Stage 3.2 schedule had used `cadence.tick`, the bow's *swing* frame
(0.194 s for the test bow), as the first hit. The machine looses on `HIT_FRAME_BOW` of the classic 16 Hz draw clock:
frame 5 with BowDrawback (0.3125 s) and frame 2 from the drawn idle (0.125 s) (`characters/weaponStates.js:242-250`,
`machineStep` :551-580). Every later event is unchanged, so a fight's TTK shifts by exactly that first-hit offset. A
200-fight, 2,000-pool bow example: mean TTK 2,068.000 s before; 2,067.931 s drawn / 2,068.119 s with BowDrawback after
(-0.069 s / +0.119 s, +-0.003%); blows and damage dealt are unchanged. The gun's frame 1 of its 14 fps clock was
already right (`characters/weaponStates.js:568-570`).

**Timing is now proven independently.** The oracle is handed the schedule's event times, so it never proved timing -
only damage and blow counts. `test/simulateFight.test.js` now derives every expected offset by stepping the upstream
machine: a melee strike hits on frame 2 and ends on frame 5; a flurry starts on frame 1, hits one tick in and ends
after four; a drawn bow hits on 2, a full draw on 5; a gun on 1. The dual exchange is the same machine clock plus the
off hand's held burden. The offsets come from the machine and the tick is checked against upstream
`swingFrameSeconds`; the expected event times are not read back from `dualSchedule`.

**The 0.5/execute boundaries are tested at the exact share.** The fight oracle updates the body's health per blow, but
an aggregate TTK can hide a one-blow boundary error. A new differential case compares the per-blow mean at shares
0.51 / 0.50 / 0.49 (venom, doubled below half) and 0.26 / 0.25 / 0.24 (Sweet Mother's Kiss, below 25%) against
upstream blows at that exact share, and asserts the below-threshold blow is larger.

**Censoring is named.** `ttk` keeps its value but gains the explicit alias `ttkConditional`; `simulateFights` now also
reports `killProbability` (Wilson interval), `horizonSeconds` and `damageMode`. `ttk`/`killDps` are conditional on a
kill; with censored fights they are biased low relative to an unconditional TTK, and no Kaplan-Meier estimate is made.
`outputDps`, damage dealt, remaining health and overkill cover every trial.

**Two smaller fixes.** `oracleItem` now carries a Legendary power id (`legendary`), not only an imprint, so the
execute threshold can be sampled upstream. `simulateFight` refuses a non-integer seed instead of silently using 0; the
dual schedule's reported held burden now comes from the analysed live Strength (`probe.schedule.hold`) instead of the
raw `ch.stats.strength` (timing was already correct).

Tests: 10 local + 5 differential. Full suite **503 tests, 503 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 3.2 - blow-only stochastic fight simulation (2026-11-16)

**No existing number moved.** `analyze`, `fight`, `fightRelay`, the objectives and every table are unchanged. The
stage adds `src/simulateFight.js` beside them, plus `test/simulateFight.test.js`, `test/fightDifferential.test.js` and
the oracle `test/harness/fightOracle.mjs`.

**What the game does.** A melee strike lands on `HIT_FRAME_MELEE` (2) and the machine advances the swing in whole
ticks (`characters/weaponStates.js:226-250,409-470`). A fresh strike is a five-tick lead; once it is running, a strike
within `FLURRY_WINDOW` is the other hand's, four ticks a blow, and the off hand holds its burden in whole ticks at its
end (`combat/twoHands/handsLaw.js:127-151,253-283`, `combat/playerWeapon.js:775-830`). Axe/blunt mastery, venom and
execute read the foe's trade at each blow as a threshold step at 0.5 (or the power's `below`)
(`systems/weaponMastery.js:118-126`, `systems/loot/lootPowers.js:320,329`).

**What changed.** `simulateFight` draws one blow at a time from the Stage 3.1 **fight tier** - there is no second damage
formula. A single melee starts at t=0 and lands at 2 ticks, then every `cadence.seconds`; a dual build opens with the
fresh lead and then the `dualSchedule` lead/off exchange; a single ranged first hit is a declared one-frame assumption.
The foe's remaining share selects the tier segment and a new table is built at 0.5 or an execute threshold. The fight
ends on the blow that empties the pool: `ttk` is that time, `overkill = damageDealt - pool`, and a horizon that ends
first is censored. `simulateFights` reports sample count, mean, sd, se, 95% CI, median, p10/p90, kills/censored, damage,
overkill, blows and per-swing damage; `simulatePairedFights` reuses one `pairedFightSeeds` list across builds. Damage
mode defaults to `uncapped` (matching `fight`); `capped` is available. A Pistolet pair is refused. Excluded: wear,
CWS, DoTs, Flow, relay bucket/token/ward, incoming damage, attacker health/death.

**What proves it.** `test/simulateFight.test.js` (8 tests) pins the schedules against `HIT_FRAME_MELEE`/`dualSchedule`,
seed reproducibility, the threshold rebuild, censoring, every summary field, paired seeds and the pair refusal.
`test/fightDifferential.test.js` runs an independent event-by-event oracle: the schedule's events enter upstream
`calculateAttackDamage` with a body the realm mints and a fresh item per hit (no wear), never a local damage or
distribution. Single (1,000 fights), dual (700), axe half-health (800) and ordinary-foe echo (700) were compared.
Blow counts: two-sample Pearson chi-square over fixed 10-blow bins z -1.70 / -0.32 / -1.83 / -0.16 (bound 3.5), and
two-sample KS 0.023 / 0.034 / 0.023 / 0.037 (0.1% critical 0.087 / 0.104 / 0.098 / 0.104). TTK mean |z| <= 0.30,
damage mean |z| <= 3.3, median/p10/p90 within 5%. Timing is proven separately, against the upstream hit-frame and
flurry constants, because the oracle is handed the event list.

**Test correction (not a threshold change).** The first blow-count comparison used the local sample's observed counts
as the expected counts for the independent oracle sample. That adds the local sample's variance to every cell and
roughly doubles the statistic; it reported z 4.4-5.1 on distributions whose means agreed to 0.02%. The test now uses
the correct two-sample expectation, `(local + oracle) / 2`, in fixed bins, plus the bin-free KS check. The 3.5 bound
is unchanged.

Full suite **500 tests, 500 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 3.1 audit follow-up - independent distribution checks (2026-11-16)

Added a gun scenario, a fists scenario, exact upstream probability checks for the critical roll, direction/body-part
tables and shield block, exact local branch checks for direction, body part, off-hand `whole`, backstab and one/two
echo powers, and a derivation test for `damage` / `claim` / `cappedDamage` / `echoHits`. The full tier now records
`echoEligible`; the fight tier still derives the resolved fields from its merge key. The two-echo case is a what-if:
the game has one echo power, so the oracle drives two `lootStrike` calls and this is not a real item.

Full suite **488 tests, 488 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 3.1 - seeded RNG and the exact per-blow outcome distribution (2026-11-16)

**No number moved.** `analyze`, `fight`, `fightRelay`, the objectives and every table are unchanged; this stage adds `src/rng.js` and
`src/blowOutcomes.js` beside them. Three additive edits in `src/model.js`: `skill` and `afterShare` are exported, and `afterShare`'s
outcomes carry `echoMask` / `echoHits` (new fields; no existing reader uses them).

What it adds: the full, fight and sampling tiers of one blow (the assumptions register M28), a seeded named-stream RNG, and the oracle
harness `test/harness/blowOracle.mjs`. Verified: the distribution's means equal `analyze` to 1e-12 for all scenarios; the joint
distribution matches 200,000-500,000 upstream draws per scenario (chi-square z within +-1.3, max cell z 4.3 over up to 1,347 cells);
three negative controls are rejected (chi-square z 216-304). The first enumeration labelled a miss in the x3 branch `backstab`; a
local test caught it (the x3 is rolled on a hit only) and it was fixed before the differential ran.

Full suite **482 tests, 482 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 2.13 - swing-direction fidelity (2026-11-16)

**What the game does.** A melee attack draws one direction before the blow's own rolls: `WeaponManager.cs:343`
`Random.Range((int)UpRight, (int)DownRight + 1)` over `CLICK_ATTACK_DIRECTIONS` (`characters/weaponStates.js:278`),
mapped by `FPSWeapon.OnAttackDirection` (`characters/anims.js:33`) to `StrikeUp`, `StrikeLeft`, `StrikeRight`,
`StrikeDownLeft`, `StrikeDown`, `StrikeDownRight`. The draw is `Math.floor(rolls() * 6)` in
`combat/playerWeapon.js:1032` (`clickAttack` :1108 and the swing-mode gesture arm :992), once per attack; a bow bypasses
it and releases `StrikeDown` (:1113), and a gun's shot has no swing state. The direction adds its flat damage and to-hit
(`SWING_MODS` :83-90, `playerAttackOptions` :1344) INSIDE the one blow, before the crit, the material/condition, the
defence, the trait and the per-hit cap. The port's default control mode is 2, click or hold (`settings.js`
`PORT_DEFAULTS`), so this draw is the default attack.

**What changed.** `src/model.js` now enumerates the six directions with equal probability for every melee swing, each
through the unchanged pipeline, and mixes the results (hit chance, uncapped and capped per-swing damage, echoes and
backstab included). No direction is sampled; `swing: 'StrikeLeft'` (or any single key) still pins one, and
`analyze(...).swingMix` exposes the six per-swing figures. `SWING_DIRECTIONS` is the product of the upstream tables, not
a copy. A4's "the six directions average to 0 / 0, so use `StrikeLeft`" is **disproved**: the per-part hit clamp (3..97)
and the damage floor/rounding are nonlinear.

| build | neutral `StrikeLeft` | six-way draw | change |
|---|---|---|---|
| max katana, gate 45 (capped DPS) | 857.19 | 853.49 | -0.43% |
| max dai-katana, gate 45 (capped DPS) | 818.12 | 815.45 | -0.33% |
| max long bow, reference foe (DPS) | 867.83 | 949.31 | +9.39% (its release is `StrikeDown`, not a side swing) |
| L10 katana vs reference foe (DPS) | 0.991 | 0.914 | -7.75% |
| L10 short blade vs reference foe (DPS) | 0.145 | 0.152 | +4.80% |

A ranking moves too: at the level-45 reference foe the neutral card puts the short blade (117) 988.75 above the long
blade (120) 988.54; the draw puts 120 (988.56) above 117 (987.53).

**Proof.** `test/swingDirection.test.js` (6 tests): the six directions x four weapon types (katana, warhammer, short
blade, fists) against upstream `pcaaoAttackDamage` with each direction's own `damageMod`/`toHitMod`; the full draw
against 20,000 seeded upstream draws for a strong and a weak build; crit 100% + a binding cap, capped and uncapped; the
long bow's forced `StrikeDown`; a whole fight against 160 seeded fights that draw per blow (inside 1%); a ranking whose
order the draw reverses. Test 1 also pins the distribution to the upstream tables and every modifier to upstream
`SWING_MODS`. Existing stages that compare a single direction now state `swing: 'StrikeLeft'` explicitly (they are not
changed in meaning); consumer pins that legitimately moved use the new default (the gate katana 857.19 -> 853.49 in
`test/integration.test.js`).

Full suite **451 tests, 451 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 2.12b - fight metrics, relay saturation and ranking objectives (2026-11-16)

**Part A - what the numbers mean.** The fight walk uses the expected damage per blow, so its `health / ttk` is a KILL RATE, not the damage
dealt. `fight()` now returns `killDps` (the old `dps`), `outputDps` (damage actually dealt / ttk), `expectedPerSwing` (dealt / blows) and
`overkill`, the last blow's excess. Against seeded upstream fights the walk is within 0.6% at a 600-point pool and within 0.3% from 2,600 up;
the damage and kill rates differ by the overkill share (1.5% at 600, 0.1% at 12,000).

**Part B - the relay on a health-dependent claim.** `simulateAllowance` takes `perClaimAt` - the claim read at the health that stands when it is
made - and keeps the law (`joinFight :1213` / `applyHit :1298`: `got = min(claim, 12 x ref, bucket, hp)`, the token hand, the phase shields).
`fightRelay` composes it with the health-dependent blow and reports `uncappedDps` (neither cap nor relay), `ceilingDps` (after the per-hit cap,
before the relay), `acceptedDps` (what the relay took), `saturated` (the bucket ran dry) and `marginDps` (`ceiling - refill`).

| gate 45, max profile | uncapped | ceiling | margin | relay kill rate |
|---|---|---|---|---|
| 117 (short blade) | 939 | 939 | 789 | 158.7 |
| 121 (katana) | 985 | 857 | 707 | 157.8 |
| 123 (dai-katana) | 1066 | 818 | 668 | 157.9 |
| 126 (warhammer) | 478 | 405 | 255 | 157.2 |

**Part C - objectives.** `src/objectives.js`: `snapshot`, `fight`, `relay`, `relay-ceiling`; `evaluateObjective` and `rankBuilds` return the
objective, the target's identity, health and allowance on every row, refuse an unknown objective and mixed targets, and keep a row that cannot
be evaluated (marked, not dropped). Existing consumers are untouched: the tables still print the full-health snapshot.

| check | result |
|---|---|
| snapshot vs fight, reference foe at 12,000 | warhammer 1005.3 > short blade 988.8 -> short blade 987.7 > warhammer 828.3 |
| relay vs uncapped at the gate | the dai-katana leads uncapped; the short blade leads the relay ceiling |
| the relay ties | top four within 0.34% (158.7 / 158.7 / 158.7 / 158.1) |
| the ceiling separates | 939 / 917 / 873 / 857 (8.8%); margins 789 / 767 / 723 / 707 |
| two builds past the cap on every blow | identical capped per swing, identical relay kill time; only `uncappedDps` differs |

**Proof.** `test/relayFight.test.js` (4): the law with a health-dependent claim against `applyHit`; below/at/above the refill; identical-capped
builds; the relay fight exact against `applyHit` on the expected claims and within 1% of 120 seeded upstream relay fights (0.23% bias).
`test/objectives.test.js` (6): metric semantics, objective identity and assumptions, the two reorderings, determinism, mixed-target refusal,
marked failures.

Full suite **445 tests, 445 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 2.12a - whole-fight health-dependent damage (2026-11-16)

**The game.** Three effects in the blow read the FOE's share of its health at the moment of the blow, and pay on one side of a
threshold: axe mastery below 0.5 and blunt at or above it (`systems/weaponMastery.js:114-126`, `WEAPON_HALF_LINE`), venom's flat
doubled below 0.5 (`systems/loot/lootPowers.js:320`), an execute power's pct below its own `below` (`:329`). `share` is
`health / maxHealth` (`combat/healthShare.js:24-40`; the relay's word for a relay body). The wielder's own health controls Orc Rage
(`:328-330`) and Berserker's Frenzy (`systems/martialPowers.js:217`, `:276`) - a different entity, and the one the model does not
simulate (no damage taken).

**Changed.** `src/fight.js`: a walk over the foe's pool. The shares where the blow changes are 0.5 and each execute's `below`;
between them the expected damage per swing is constant, so each segment's blows are `ceil(health above the segment's floor / perSwing)`
at `1/aps`, and a blow that crosses a threshold carries its excess into the next. `dps = health / ttk` (the kill rate; the last blow
overshoots), `segments`, and the fixed-health figure as `snapshot`. The wielder's `attackerHealthShare` is the caller's declaration in
every segment. `analyze` and `with` are untouched - the fight only supplies the share - and `fight(...).with(edit)` prices a what-if
exactly as the item that carries it. `src/model.js` exports `additionsTo`/`weaponPowers` so the walk sees the same power list the blow does.

| max profile vs a tough reference foe, 12,000 health | full-health snapshot | whole fight | segments (share: per swing) |
|---|---|---|---|
| battle axe 127 | 607.0 | **672.2 (+10.7%)** | 0.75: 451, 0.25: 604 |
| warhammer 126 | 1005.3 | **828.3 (-17.6%)** | 0.75: 809, 0.25: 572 |
| katana 121 (no health effect) | 1036.4 | 1021.5 (-1.4%, the kill blow) | 676 / 676 |
| katana at the Breach 45 | 984.5 | 967.7 | - |
| venom build (fixture, 2,600 health) | 33.0 | 37.2 | 24.96 / 32.34 |
| execute what-if (Sweet Mother's Kiss) | 22.9 | 25.0 | 17 / 17 / 26 |

The weapon-family comparison moves: the warhammer is 1.66x the axe on the snapshot and **1.23x** over the fight.

**Proof.** `test/fight.test.js` (7 tests): mastery exactly equal to upstream `weaponPastPct` at 0.9..0.2 for axe and blunt (the boundary
at 0.5 included); venom at seven shares and execute at five against the worn-item blow; crit 100 + stoneskin + cap on both sides of the
threshold; Orc Rage and Berserker at four attacker/foe combinations (the foe's health does not move them); a whole fight where health
really falls - the walk's TTK against 300 seeded upstream blow-by-blow fights - and a what-if equal to the item.

Full suite **435 tests, 435 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 2.11c - independent integration audit of 2.11a/2.11b (2026-11-16)

**Fixed: one pricing double-count.** `with({ imprint })` added a power the item already carried a second time (two Echo rolls, or a doubled
percentage), where upstream's `wornPowers` counts a power once (`lootPowers.js:247-253`). `analyze` now filters a what-if power already among the
weapon's own (`src/model.js`); pricing the power a build has is no change. Regression: `test/integration.test.js` test 2 (fails on the pre-fix code:
`carried anseis-edge, priced again: perSwing`).

**Verified, no change needed.** One blow carrying every 2.11a/2.11b change - three perfect diamonds (past the +25 cap), a damage line, own fire 4 +
two rubies (past the +6 cap), a slayer line, Potent Vs and an Echo - matches upstream value by value (z < 4.5), with and without stoneskin and at a
binding cap. Equipped equals priced exactly over one-handed, two-handed, pair, dual, bow and backstab x flow, venom, echo, Potent Vs, a 25% line,
a +6 fire line and both at once. The ordinary-foe Echo arm now has its differential: with a `playerDoor` record the oracle's echo takes `hurtFoe`
(nothing owed), and `blow + echo` matches the model's independent hit (z < 4). The Stage 2.9 reproductions are unchanged (shield z -1.8..1.2, long-bow
pull z -0.4..-0.1, pricing identity exact, saturated gate build 857.19).

Two channels checked and found to be different by design, documented rather than changed: the `damagePct` option is a blow-size scenario (+2.2..+8.8%
larger than the same `damage` line, which is a card change); a wraps `damage` line rides a fist blow exactly as upstream's `weaponDamageMods(info.wraps, ...)`
does (+17.45% vs +17.46%).

Full suite **428 tests, 428 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 2.11b - gear-line fidelity and Many Endings (2026-11-16)

**A. A piece's lines are read as the game reads them.** *Game:* `systems/loot/lootRarity.js` - `layGemLines` (:2085-2088) lays a piece's own
lines then its gems' (`gemLine`, graded: a perfect diamond +12, a plain one +6); `readLines` (:2155-2165) reads a piece's own lines whole but
holds its GEM lines to law 6's cap - the top of the kind-and-param's Rare band, in the sockets' order (damage 25, fire/frost 6, stat 10);
`validAffix` (:839-847) drops an unknown kind, a param the kind does not allow, or a value outside 1..the Legendary top; `affixWeaponDamage`
(:2475-2479) sums the 'damage' lines; `lootBlow` (`lootPowers.js:286-347`) sums the slayer lines per param and floors EACH elemental line after
its own career tolerance.

*Changed:* `src/gearLines.js` is a thin adapter over those functions; `weaponOf`, `rebuildMods` and the blow read through it; `sockets.js`
takes `gemLine`/`socketMax` from upstream instead of a table of its own; a repeated element accumulates instead of overwriting.

*Impact:* three perfect diamonds read 25, not 36. The nine three-socket weapons lose 1.5-2.2% uncapped DPS (two-socket weapons unchanged):

| max profile | damage % before -> after | uncapped DPS | gate capped DPS |
|---|---|---|---|
| 123 Dai-katana | 61 -> 50 | 1139.16 -> 1122.59 (-1.5%) | 818 unchanged |
| 126 Warhammer | 61 -> 50 | 1027.53 -> 1005.27 (-2.2%) | 488.26 -> 477.65 (-2.2%) |
| 128 War Axe | 72 -> 50 | 738.29 -> 722.04 (-2.2%) | 654.13 -> 650.97 (-0.5%) |
| 130 Long Bow | 61 -> 50 | 887.69 -> 867.83 (-2.2%) | 465.58 unchanged |
| 121 Katana (2 sockets) | 49 unchanged | 1139.16 -> 1139.16 | 857.19 unchanged |

A pre-existing bug the differential found: a `skill` line whose param was `0` was dropped by the fold's `!key` guard; skill 0 is a skill.

**B. Many Endings rides the blow's own claim.** *Game:* `lootStrike` (`lootPowers.js:374-376`) rolls `chance` per landed blow and `again()`
(:444-454) repeats the blow's FINAL formula damage as `n = max(1, round(damage))` - a foe with a room record takes it as its own hit
(`door.hurtFoe`: no trait, no cap); a body the relay runs is owed it (`oweFoe`, `playerDoor.js:47-49`) and its host takes it into the SAME
claim (`dungeonContext.js:4528-4531` landOnBoss): `damage += bossStrikeAt(takeOwed, 'melee', weapon)` - resisted on its own as a melee swing,
added to the resisted blow, ONE relay cap on the sum.

*Changed:* `src/model.js` `echoChances` + the echo branches in `afterShare` (an outcome now carries `v` - the claim - and `x` - an ordinary
foe's independent hit); `powerDps`/`with({ imprint })` price it through the same path; `realBuild` credits it by running the purse on the
imprinted card. No multiplier stands in for it.

*Impact:* the priced echo collapses where the claim is near the cap, and is unchanged where it is far below:

| check (gate, level 45) | before | after |
|---|---|---|
| Warp-Edge on the long blade, delta | +85.72 DPS | +3.46 |
| long-blade #1 imprint | Warp-Edge +85.72 | Ansei's Edge +34.56 |
| Warp-Edge, short blade | +93.94 | +35.39 |
| Warp-Edge, blunt | +48.83 | +24.46 |
| real build 121 / 117 / 126 totalDps | 1128.31 / 1616.48 / 934.94 | 1030.77 / 1476.74 / 854.03 |
| the same build on an ordinary foe, echo ratio | 1.1000 | 1.1000 (its own hit there) |

**Proof.** `test/gearLines.test.js` (7 tests): 400 seeded items against `affixFold`/`affixWeaponDamage`/`lootBlow`, the +25% cap,
socket counts for every template, invalid lines, four whole builds against the worn-item blow. `test/manyEndings.test.js` (3 tests): seven
configurations at chance 100 compared value by value with the host's composition (binding, partial and no cap; stoneskin; off hand at 0.8
with bladeturning; a shaft), the seeded 10% at two caps, and the independent-hit pricing rejected. The old readings fail each check.

Full suite **424 tests, 424 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 2.11a - equipped state on the hit path (an item and its price are one calculation) (2026-11-15)

**What the game does.** A worn piece carries its power as `rarity: 'legendary'` + `legendary` or `rarity: 'rare'` + `imprint`
(`systems/loot/lootRarity.js:1271` `powerIdsOf`, record by `powerOf`); `lootBlow` (`systems/loot/lootPowers.js:286-347`) adds every
carried power's percentage to the slayer lines' in ONE `shareOf` of the blow and its flat after, each condition read from the foe
and the scenario (`:304-336`). A weapon's Potent Vs / Low Damage Vs rows are Strikes payloads (`systems/enchantments.js:622-631`,
`:886-892`, matched by the foe's affinity) that `doItemEnchantmentPayloads` (`:1031-1075`) sums into the blow after the defence and
the off hand's share, in `combat/formulas.js:826-840`, for a player whatever the blow did - a miss returns the five.

**Changed.**
- `src/model.js`: `weaponOf` reads the item's powers; `lootPowerTerms` turns powers into the loot step's `pct`/`flat` (bane,
  unaware, sanctified, flow, venom, moon, rage, execute, firstblood); `strikesNet` reads the item's Potent Vs / Low Damage Vs rows into
  the blow's Strikes channel (summed, clamped at 0, `mobileAffinityMatches`); `with({ imprint })` puts a power on the main-hand item.
  Equipped and priced are the same code.
- `src/imprints.js` `powerDps`: `base.with({ imprint, assumeTriggers })` for every kind but Many Endings (own stage).
- `src/enchants.js` `enchantDps`: Potent Vs / Low Damage Vs are no longer added as `hit x flat` outside the blow.
- `src/realBuild.js` / `src/purse.js` / `src/allowance.js`: `imprintEffect` and the `mult`/`flat` of `simulatePurse` and `claimStreams`
  are deleted; the purse runs on the imprinted card.
- Vendor (same pin): `systems/sigil/sigilSets.js` (+ `setReach.js`) vendored. Its stub made `setsDueling()` truthy, so `wornPowers`
  was empty and **no worn power ever fired in the oracle**. 289 files + 122 stubs; parity 1855/1855 (adds a worn-power check).

**Proof.** `test/equippedBuild.test.js` (10 tests): equipped == `with(edit)` exactly; the oracle holding the item worn matches
within z 3.5 for 11 power cases, 7 enchantment cases and a five-modifier item; the old behaviour is rejected.

| Output | Before | After |
|---|---|---|
| equipped Potent Vs, max katana at the gate (totalDps gain) | +7.43 | +2.83 (= the priced `with` gain) |
| equipped Potent Vs, Pistolet pair | +5.11 | +3.80 |
| equipped Potent Vs, max warhammer | +6.03 | +3.49 |
| equipped Potent Vs, mid warhammer vs stoneskin | +4.53 | +2.41 |
| equipped Potent Vs, mid katana (low hit) | +5.80 | +5.98 (the five rides the miss) |
| equipped Ansei's Edge (flow), max katana, capped DPS | +0.00 (ignored) | +34.56 |
| equipped Serpent's Kiss, max katana, capped DPS | +0.00 (ignored) | +22.11 |
| realTemplate totalDps, 121 / 117 / 126 (cap mode) | 1128.31 / 1616.48 / 934.94 | 1121.05 / 1606.07 / 928.83 |

realTemplate moves by -0.6..-1.0% because Potent Vs is now inside the capped blow (before, `enchantDps` added it uncapped); TTK and
sustained are unchanged (saturated). The imprint ranking is unchanged, including Many Endings, whose pricing is a separate stage.

**Limits.** Many Endings, chain/quake/conduit/siphon/surge, armour and jewellery powers, Gilded records and Cast When Strikes are not on
the equipped path. Moon's night and Flow's build-up are scenario inputs (the oracle's sky clock is a stub). `W-LOOT-CARRY` applies to
an equipped percentage power exactly as to a slayer line.

Full suite **414 tests, 414 pass**; vendor 289/122; parity **1855/1855**.

---

## Stage 2.9 - combat resolution fidelity and one damage calculation (2026-11-15)

**F1 - the shield block is a per-blow outcome.** *Game:* `combat/pcaao.js:1784-1796` rolls one `dice100` block per blow;
`:1815-1849` returns a whole number by branch; `:1850` (the off hand's share), `bossStrike` (`max(1, round)`) and the relay
cap then act on it. *Changed:* `targetPartOutcomes` returns `[{ p, damage }]`; `analyze` runs share, trait and cap on each
outcome (`resolveBlow`). *Proof:* `test/shieldOutcomes.test.js` (every value of every struck part vs upstream). *Moved:*
per swing -2.55%/+1.09%/+2.60% -> -0.09%/+0.01%/+0.05%; a no-shield target is unchanged.

**Long-bow pull.** *Game:* `combat/arrowFlight.js:501-510` `bowFastDamage(m, calculateAttackDamage(...))`, then the trait and the cap.
*Changed:* the pull left `weaponBlow`; it is `bowFastDamage` (vendored) after the share. The displayed card is the pulled blow; the
rolls stay the card's own (`damage.bow`). *Proof:* `test/longBow.test.js`. *Moved:* long bow, 5.9% condition -0.93% -> -0.01%; vs daedric
-0.59% -> -0.02%; crit 100 +0.29% -> -0.03%. Short bow and melee: unchanged.

**Martial stat bonus before the ceiling.** *Game:* `martialPowers.js:364-375` -> `_mods.stats`; `statMods.js:121-141` clamps after the
sum. *Changed:* `stat()` feeds the bonus through `liveStat`; `combatStat` exported. *Proof:* `test/statCap.test.js`. *Moved:* a Shadowdancer
at Agility 95 reads 100 (was 105), hit 0.8400 -> 0.8295 (upstream 0.8295); base <= 89 unchanged; base 100 +10 reads 100 (was 110).

**Berserker's Frenzy reads the Berserker.** *Game:* `martialPowers.js:216-218`, `:274-276`; `healthShare = health/maxHealth`; strictly below 0.5.
*Changed:* `attackerHealthShare` (default 1, `--self-health-share`); `healthShare` is the foe's. `test/theory.test.js` described a Berserker
capture with the foe's `healthShare: 0.49`; its input is now `attackerHealthShare: 0.49`, its ~450 band assertions untouched. *Proof:* `test/berserker.test.js`.

**F2 - pricing is the analysis.** *Game:* `lootPowers.js:286-347` (one `pct`, then `flat`, before the martial path, crit, defence), `enchantments.js:622-631`
+ `formulas.js:826-840` (+5 after the defence and share, whole 80% for the off hand, on a miss too). *Changed:* `analyze(...).with(edit)`;
`cappedDpsWith` deleted; `powerDps` and the Potent Vs valuations call it. *Proof:* `test/pricing.test.js`, `test/crossSystem.test.js`.

| Price (gate, level 45) | Before | After |
|---|---|---|
| Pistolet pair at no change | 547.37 (+9.5% vs analysis 499.89) | 499.89 |
| Dual wield at no change | 1071.49 (+5.4% vs 1016.39) | 1016.39 |
| Backstab (uptime 1) at no change | 857.19 (-3.9% vs 891.74) | 891.74 |
| Potent Vs, Pistolet pair | +50.6 DPS | +3.8 |
| Potent Vs, dual main hand | +58.2 | +1.8 |
| Potent Vs, katana under a backstab | -32.1 | +0.2 |
| Potent Vs, katana | +2.5 | +2.8 |
| Serpent's Kiss (+8 flat), Short Blade 117 | +16.2 | +103.9 (the flat is in the blow: the crit multiplies it) |

The max-profile headline (857.19 at the Breach, TTK 76.0) and the Stage 2.8 reference builds are unchanged. Imprint-percentage prices move by the per-blow
floor (<1%): the tests that asserted `base.dps x (1 + pct)` to 1e-9 now assert the canonical relation and a 1% bound.

**Vendor (same pin).** `systems/sigil/sigil.js` and `formats/magicDef.js` (+ `formats/save/saveTreeFile.js`) are vendored: their stubs had switched every
martial path and every Strikes payload off in the oracle. 288 files + 122 stubs; parity 1852/1852.

**Found, not fixed.** Potent Vs on a miss: the equipped-item enchant layer still adds `hit x 5` (`W-PROC-BUDGET`). `W-LOOT-CARRY`: percentage lines floor each blow, the game carries the fraction (+2.0% at 25%, level 30).
Hand-built items accept elemental params upstream ignores (poison).

Full suite **404 tests, 404 pass**; differential **46/46**; golden **14/14**; invariants **13/13**; vendor **10/10** (288/122); parity **1852/1852**.

---

## Stage 2.8 - target body fidelity and an independent oracle (2026-11-15)

**What the game does.** A foe is minted by `characters/enemy/enemyEntity.js:160-233` `makeEnemyEntity` from
`editAtMint(pcaaoMeanerMonstersRow(applyMeanerMonsters(row)))` (`:178`): a monster's level is its row's whatever
the player's (`:212`), its armour the row's `armorValue x 5` on all seven parts (`:215`, `:232`), every skill
`skillsLevel(level)` (`:111-114`, `:233`), its metal and affinity the row's (`:257`, `:277`); a class foe takes the
player's level (`:202`, the City Watch knight Range(3, 7) more, `:207`) and starts at armour 100. Which row it is
depends on the boot: the client runs `installEnemyExpansion()` at every load (full checkout `scenes/shared.js:1518`),
Enemy Expansion, Meaner Monsters and PCAAO ship enabled (`systems/modSettings.js`) and are forced on online
(`systems/online/onlineLane.js:367,457-461`). With DEX loaded, Meaner Monsters' row and the overhaul's edit stand
aside (`systems/enemyExpansion/dexSwitches.js:28`) and DEX's classic lines, with MUDEX's after them, are the row
(`systems/enemyExpansion/dexInstall.js:183-224`; `dexClassicRow`). Every relay boss is `world/gate/gateBoss.js:151-170`
`bossStandIn(look)`: that mint at player level 1 with no career, then `minMetalToHit` 0, `BOSS_ARMOR` 60 on all
parts, no wear - the Breach's mobile 31, the Sky-ketch Warden's and the Abyss Remnant's mobile 36 (full checkout
`scenes/ketch/ketchFight.js:57,348`; `scenes/superDungeon/sdRemnant.js:97,529`).

**Changed.**
- Vendored `systems/enemyExpansion/dexInstall.js` and `world/gate/gateBoss.js` as roots (same pin; 286 files + 123
  stubs; parity 1836/1836).
- `src/target.js`: `UPSTREAM_BOOT` (the three switches' shipped defaults, read from the vendored `MOD_SETTINGS`);
  `mintRow(m, { boot })` (the boot's row over `VANILLA_ENEMY_BASICS`); `enemyTarget` mints that body - a missing or
  `null` level is the minted one, an invalid level (0, negative, fractional, NaN, text) is refused, a class foe
  requires the player level, mobile 39 (no row level) is refused, a monster level other than the minted one is a
  labelled override (`levelSource`); `standInTarget(mobile)`, the one relay body. The class foe's `minMetalToHit`
  is now the row's 0 (was -1; no damage effect).
- `src/model.js` `bossTarget({ mobileType })` is `standInTarget` plus the encounter's health, traits, cap and
  shields; body fields beside a mobile are refused. `gateTarget` no longer states armour 12 / career / affinity /
  metal / combat level; `GATE_BODY_LEVEL` is derived (21).
- `src/encounters.js`: the Breach, Sky-ketch and Abyss rows carry only their look (`mobileType`); `armorValue` and
  `minMetalToHit` are gone.
- Tests: the oracle mints its own bodies in a worker-thread realm booted as the client boots
  (`test/harness/upstreamBodies.mjs`); the harness's `bossStandIn` mirror and its hard-coded 60 are removed; ten
  differential stages no longer copy the local target's level/skills/stats/armour/equipment/metal into the
  upstream entity; `test/target.test.js:101-133` compares with upstream's mint instead of the raw row;
  `W-DEX-LOADOUT` records the class-loadout gap the booted oracle exposed.

| Check | Result |
|---|---|
| bodies | `test/targetBody.test.js`: 43 monster rows (42 bodies + the refused empty slot) bare and with a career, 19 class foes × 3 levels, the watchman's roll, all field for field against upstream's mint; the three bosses at 4 content levels against the booted `bossStandIn` |
| mid-level | L20/skill 60/AGI 55 and L10/skill 40/AGI 45 (below the clamp: hit 0.78-0.80) × 3 bosses, 40,000 draws each, inside the 95% CI; a body 5 armour points off is outside it |
| fails before | on the pre-2.8 constructors (a scratch copy) every new body test fails, as do four rewritten sampled stages (silver E2E career 18: 29.87 vs 27.50; condition/armour/traits: 3.37 vs 2.38; worn armour mobile 7: 13.91 vs 13.81 +/- 0.08; loadout mobile 7) |
| golden | `mudex1.test.js:61-73` (bear, rat): vendored row, booted mint and `mintRow` agree |

Representative outputs (katana, daedric; the build named; `analyze` per swing, capped DPS and allowance TTK):

| Target | Build | Body before -> after | Hit | Capped DPS | TTK (s) |
|---|---|---|---|---|---|
| Sky-ketch, content 10 | L10, skill 40, AGI 45 | L10 AV0 skills 80 -> L16 AV60 skills 100 | 0.295 -> 0.795 | 4.73 -> 12.71 | 2323 -> 869 |
| Sky-ketch, content 20 | L20, skill 60, AGI 55 | L20 AV0 -> L16 AV60 | 0.515 -> 0.970 | 8.24 -> 15.49 | 2222 -> 1186 |
| Sky-ketch, content 45 | L45, skill 80, AGI 60 | L45 AV0 -> L16 AV60 | 0.825 -> 0.970 | 13.19 -> 15.49 | 2775 -> 2364 |
| Abyss, content 20 | L20, skill 60, AGI 55 | L20 AV0 -> L16 AV60 | 0.515 -> 0.970 | 8.24 -> 15.49 | 729 -> 388 |
| Breach, content 10 | L10, skill 40, AGI 45 | L10 skills 80 -> L21 skills 100 | 0.895 -> 0.795 | 15.02 -> 13.35 | 246 -> 274 |
| Breach, content 20 / 45 | L20 / L45 builds | combat level 20 / 21 -> 21 | unchanged | unchanged | unchanged |
| max profile, every boss and level | `maxCharacter(121)` | - | 0.970 | unchanged (857.19 at the Breach 45) | unchanged (76.0) |
| `enemyTarget(31)` (no level) | L20, skill 60, AGI 55 | L0 skills 35 AV-50 -> L21 skills 100 AV-50 | 0.332 -> 0.031 | per swing 4.30 -> 0.40 | - |

Full suite **378 tests, 378 pass**; differential **46/46**; golden **14/14**; vendor **286/123**; parity **1836/1836**.

Remaining limits: the Iron Atronach's body level is MUDEX's 16, not the 21 the audit stated (the audit's
"edited row" was Meaner Monsters', which stands aside beside Enemy Expansion). `gearEnemy` still rolls the stock
equipment delegate (`W-DEX-LOADOUT`). Partial careers fill missing stats with 50 (upstream reads `undefined`).
`MONSTER.BSA`/`CLASS*.CFG` careers are still supplied by the caller. The scene hosts that place a stand-in
(`ketchFight.js`, `sdRemnant.js`) are not vendored; which look each content uses is read from them at the pin.

## Stage 2.7 - classic Strength scaling fidelity (2026-11-14)

**What the game does.** `combat/formulas.js:88-92` `damageModifier(strength)` is the stock
`floor((strength - 50) / 5)`, but the live client installs PCAAO at boot
(full-checkout `systems/worldTick.js:100`), and `installPcaao()` registers
`formulaOverride('damageModifier')` returning `pcaaoDamageModifier` = `floor((STR - 50) / 10)`
when `fixedStrengthDamageModifier` is on (`combat/pcaao.js:1873-1875`; the setting defaults true,
`systems/modSettings.js:1269-1276`). The stock **weapon** arm (`formulas.js:470-495`) adds that one
Strength term (no two-handed or bow double), then the material modifier, and clamps below 1; the stock
**fist** arm (`:420-440`) adds the same one term and does **not** clamp before it returns, so a STR-0
punch can be negative on the card. The overhaul's own core keeps `pcaaoDamageModifier` and doubles it
for a two-handed weapon or bow; that path is untouched.

**Changed.** `src/model.js` `damageModel`'s classic arm now calls `classicStrength(str, opts)`: the live
`pcaaoDamageModifier` (/10) by default, or the raw `damageModifier` (/5) when
`fixedStrengthDamageModifier:false`. The classic weapon path clamps below 1; the classic fist path does
not (the stock quirk). The overhaul arm is unchanged. The classic racial term joins the swing/proficiency
`damageModifier` in the same blow, as before. `W-CLASSIC-STRENGTH` is removed.

| Check | Result |
|---|---|
| Strength terms | 27 exact cases (9 values × overhaul, classic-live, classic-stock) |
| classic damage range | 2 modes × 7 strengths × 9 builds (long/blunt/bow/fists, Dark Elf/Wood Elf/Redguard/Nord races), exact `min`/`max` |
| unit | `test/classicStrength.test.js`, 9 tests |

Representative classic long blade, STR 80:

| Case | Before | After |
|---|---|---|
| live classic (PCAAO installed) | 8-22 (`/5`) | 5-19 (`/10`) |
| uninstalled stock (`fixedStrengthDamageModifier:false`) | 8-22 | 8-22 |
| classic fists, STR 0, stock | 0-1 (clamped) | -4-1 (the stock fist arm does not clamp) |
| classic two-handed/bow | +6 | +3 (no double; the overhaul still doubles) |

Full suite **368 tests, 368 pass**; differential **46/46**; golden **13/13**; vendor **257/111**;
parity **1567/1567**.

Remaining limits: the vendored `systems/worldTick.js` is a stub, so the boot install is established from
the full checkout at the pin plus the vendored `installPcaao` and the default setting, not from a vendored
boot module. The classic core remains a legacy card: the overhaul's condition band, material requirement
and crit-damage path are not part of the stock classic arm. The overhaul Strength path is unchanged.

## Stage 2.6 - racial combat-modifier fidelity (2026-11-14)

**What the game does.** `combat/pcaao.js:281-361` `pcaaoRacialModifiers(attacker, weapon, player)` switches
on the DFU race id and the weapon's **skill**; every term is stat-driven, with integer division per term:

| Race | Weapon skill | damageMod | toHitMod |
|---|---|---|---|
| Argonian | Short Blade | AGI/33 + SPD/33 | AGI/16 + SPD/33 + LUK/33 |
| Dark Elf | Long Blade | AGI/25 + STR/25 | AGI/25 + SPD/33 + LUK/33 |
| Dark Elf | Short Blade | AGI/50 + SPD/50 | AGI/33 + SPD/33 + LUK/33 |
| Wood Elf | Short Blade | AGI/33 + SPD/50 | AGI/20 + SPD/33 + LUK/50 |
| Wood Elf | Archery | STR/25 + AGI/25 | AGI/10 + SPD/25 + LUK/25 |
| Khajiit | Short Blade | AGI/33 + SPD/50 | AGI/20 + SPD/33 + LUK/50 |
| Nord | Axe | STR/16 + AGI/33 | STR/33 + AGI/33 + LUK/33 |
| Nord | Blunt Weapon | STR/25 + END/25 | STR/25 + AGI/33 + LUK/33 |
| Redguard | Long Blade | AGI/33 + STR/50 | AGI/10 + SPD/25 + LUK/25 |
| Redguard | Blunt Weapon | STR/33 + END/33 | STR/20 + AGI/25 + LUK/33 |
| Redguard | Axe | STR/16 + AGI/33 | STR/33 + AGI/33 + LUK/33 |
| Redguard | Archery | STR/50 + AGI/50 | AGI/25 + SPD/33 + LUK/33 |
| Khajiit | fists | STR/33 + END/33 + AGI/50 + SPD/50 | AGI/25 + SPD/50 + STR/50 + END/50 + LUK/50 |
| Nord | fists | STR/33 + END/50 | 0 |

Breton and High Elf have no arm. The damage term is added to the swing/proficiency term inside the weapon
blow's `damageModifier` (before silver, Strength and the material modifier); the hit term joins the to-hit
base. Both are per hand and per weapon. The classic stock `FormulaHelper.CalculateRacialModifiers`
(`combat/formulas.js:292-306`) is a level-based else-if ladder: Dark Elf level/4 whatever the weapon; an
archer is Wood Elf level/3, and a non-Wood-Elf archer (including a Redguard) gets **nothing**; a Redguard
non-archer level/3. It applies only with a weapon, never to fists.

**Changed.** `src/model.js` `overhaulRacial` now has every weapon arm, the Wood Elf archery luck divisor
`/25` (was `/20`), and the Khajiit/Nord unarmed arms; `classicRacial` mirrors the stock else-if ladder
(a Redguard archer now gets 0). `racialModifiers(ch, w, core)` is exported as a stage. The terms flow
through `dmgMods`/`toHit` into backstab, critical, condition, target mitigation, traits, cap and allowance
exactly as before. `W-RACIAL` is removed.

| Check | Result |
|---|---|
| all arms | 144 exact overhaul cases (8 races × 3 stat blocks × 5 weapon skills + unarmed) against `pcaaoRacialModifiers` |
| classic ladder | 48 exact cases against `formulas.racialModifiers` |
| end-to-end | 5 builds (Wood Elf short/bow, Nord/Khajiit fists, Breton short) × 20,000 draws |
| integration | Wood Elf short blade with backstab + 50% condition + armour/shield + stoneskin + cap 60, 20,000 draws |
| off hand | 30,000 draws |

Representative per swing (level 30, sample stats), no target cap:

| Build | Before | After |
|---|---|---|
| Wood Elf short blade | 12.38 | 15.63 (+3 damage/+6 hit at the sample) |
| Wood Elf bow | 22.79 | 28.25 (+5 damage/+12 hit) |
| Nord fists | 4.47 | 5.63 (+3 damage) |
| Khajiit fists | 4.47 | 7.89 (+6 damage/+6 hit) |
| Breton short blade | 12.38 | 12.38 (unchanged) |
| Classic Redguard archer | level/3 | 0 (the stock ladder's quirk) |

Full suite **358 tests, 358 pass**; differential **45/45**; golden **13/13**; vendor **257/111**;
parity **1567/1567**.

Remaining limits: the local stat helper also carries the martial path passives, as it does throughout the
model; race-specific weapon restrictions beyond the arms above are not modelled; classic Strength remains
the separate `W-CLASSIC-STRENGTH` gap. `W-RACIAL` is removed.

## Stage 2.5 - weapon-condition fidelity (2026-11-14)

**What the game does.** `systems/item/itemTemplates.js:277-279` `conditionPercentage(item)` is
`maxCondition > 0 ? Math.trunc(100 * currentCondition / maxCondition) : 100` - the **integer**
percentage, not a float. `combat/pcaao.js:607-637` `pcaaoAlterDamageBasedOnWepCondition(damage,
bluntWep, weapon, sharpEdge)` reads that integer and applies discrete bands (Mathf.Round half to even
inside `r(m) = unityRound(F(damage * F(m)))`):

| pct | blade | blunt |
|---|---|---|
| >= 92 | x1.3 (sharpEdge) / 1 | x1.1 (sharpEdge) / 1 |
| >= 76 | x1.1 (sharpEdge) / 1 | 1 |
| >= 61 | 1 | 1 |
| >= 41 | x0.85 | x0.9 |
| >= 16 | x0.7 | x0.8 |
| >= 6 | x0.45 | x0.65 |
| > 5 | 1 (unreachable for an integer) | 1 (unreachable) |
| <= 5 | x0.25 | x0.5 |

`sharpEdge` is `modules.equipmentDamageEnhanced`; the port's default is **off**, so 76%+ returns the
damage unchanged and the edge bands are not used. The band is applied only to a player's **weapon**
(`modules.conditionBasedEffectiveness && isPlayer(attacker) && weapon`), after the critical and the
material requirement and before the target's hide/armour/shield, traits, cap and allowance
(`:1800-1804`). Unarmed blows take none. Each hand's item carries its own condition; a bow is a weapon.
`DamageEquipment` wears gear after the blow; that is a separate durability loop.

**Changed.** `src/model.js` `weaponOf` now stores `conditionPercent` from the vendored
`conditionPercentage` (and `conditionPct` as that integer / 100). `conditionMultiplier` reads the
integer (a manually supplied float `conditionPct` falls back to `trunc`), applies the exact bands, and
takes `sharpEdge` from `opts.equipmentDamageEnhanced`. `damageModel`'s condition stage already sat after
crit/material in `finish`; it now uses the integer. The old float could land a 5.9% weapon in the
unreachable `pct > 5` arm and return full damage.

| Check | Result |
|---|---|
| every band and boundary | 608 exact cases (2 templates x 19 percentages x 2 sharpEdge x 8 damages) against `pcaaoAlterDamageBasedOnWepCondition` |
| end-to-end | 5 weapons/materials x 200,000 draws |
| off hand + bow | 2 x 30,000 draws |
| armour/traits/cap | 20,000 draws through a cuirass/helm/tower shield, stoneskin and cap 60 |

Representative 100-point blow at current 59/1000 (5.9%):

| Case | Old | New |
|---|---|---|
| blade | 100 (full) | 25 (x0.25) |
| blunt | 100 (full) | 50 (x0.5) |
| blade at 60/1000 (6%) | 45 | 45 (unchanged) |
| blade at 500/1000 (50%) | 85 | 85 (was already right) |
| blade at 920/1000, sharpEdge off | 100 | 100 (no edge) |
| blade at 920/1000, sharpEdge on | 100 (module not wired) | 130 |

Full suite **343 tests, 343 pass**; differential **41/41**; golden **13/13**; vendor **257/111**;
parity **1567/1567**.

Remaining limits: **combat-time condition wear is not simulated** - `currentCondition` is the item's
static input, so a long fight's later blows do not degrade; a proc's durability cost and the break/stop
at 0 are likewise outside this stage. The `sharpEdge` on-state is supported and tested, but the port's
default is off. `W-CONDITION` is removed.

## Stage 2.4 - backstab hit-path fidelity (2026-11-14)

**What the game does.** `scenes/hostCombat.js:327-332` `backstabChanceOf(player, isEnemyFacingAwayFromPlayer,
foe)` returns **0** unless the foe's back is to the player (and `foe.revenant.edge.watchful` is not true);
otherwise it tallies the Backstabbing use and returns `skillValue(player, Backstabbing)` - the live skill.
`combat/pcaao.js:1706` adds that chance **flat** to `chanceToHitMod` (`pcaaoSuccessfulHit` then clamps
3..97). On a landed weapon or fist blow, `pcaaoBackstabDamage` (`:469-479`) rolls once:
`chance > 1 && dice100(chance, roll)` -> `damage * 3`, else `damage`; `dice100` is
`floor(roll * 100) < chance`. The ×3 is taken at `:1724`/`:1768`, **after** the weapon/fist blow and its
blow modifiers, and **before** `damage = Math.max(0, damage)` (`:1777`), the critical multiplier, the
material requirement, the condition band, the target's hide/armour/shield, the host's traits, the per-hit
cap and the relay allowance. Arrow flight (`combat/arrowFlight.js:501-510`) passes the same
`backstabChanceOf(..., isBackFacing(...))`, so a bow can backstab. Both hands of a pair pass the same
`backstabOf(foe)`; the off-hand share is laid after the target reduction (`blowShare`).

**Changed.** `src/model.js` adds `backstabDamage` (the exact gate/roll), `damageModel`'s
`backstabPlainRolls`/`backstabCritRolls` (the ×3 of every pre-finish blow, taken before crit/material/
condition), `preFinishRolls` (the stage value), `hitModel`'s `backstabBonus` (the flat to-hit term) and an
`analyze` outcome mixture. `backstabUptime` is now the **share of swings whose foe is back-facing**;
`backstabChance` may supply the raw chance directly. The mixture is
`(1-u) ordinary + u [(1-p) ordinary-behind + p x3-behind]`, with `p = min(1, skill/100)` and the
behind branch's hit chance boosted by the raw skill; the hit card, DPS, capped DPS and the allowance's
claim size all use the mixed result. A Watchful target (`target.watchful` or
`target.revenant.edge.watchful`) is ordinary. The old `1 + 2 x uptime x chance` damage scale is gone, and
**`W-BACKSTAB` is removed**.

| Check | Result |
|---|---|
| ×3 gate and dice threshold | 288 exact values against `pcaaoBackstabDamage` |
| chance, hit term and mixture | 6 skills (0, 1, 25, 50, 75, 100) × 4 caps (0, 40, 60, 80), 20,000 draws each |
| off hand | 30,000 draws with the agility to-hit term and the off-hand share |
| ranged | 30,000 draws with a short bow |
| armour/traits/cap integration | 20,000 sampled blows through worn armour, a shield, stoneskin and the cap; `test/backstab.test.js` |

Representative (skill 50, full behind uptime, level-30 long blade):

| Case | Old (audit) | Upstream | New local |
|---|---|---|---|
| cap 60 | 58.05 capped/swing | 52.85 | 33.61 vs 33.69 sampled (our build) |
| cap 80 | 73.62 | 65.56 | 35.09 vs 35.04 |
| cap 40 | 38.80 | 37.98 | 27.85 vs 27.77 |
| no cap, hit-clamped | 2× ordinary | 2× ordinary | 2× ordinary |
| hit bonus, unclamped (skill 50 vs 0) | not modelled | 0.63 vs 0.13 | 0.63 vs 0.13 |

Full suite **326 tests, 326 pass**; differential **37/37**; golden **13/13**; vendor **257/111**;
parity **1567/1567**.

Remaining limits: the simulator has no geometry, so `backstabUptime`/`backstabChance` are the caller's
facing share/chance (the Watchful check is a target property); the ×1/×3 variance of a single blow is an
expected mixture; the allowance uses the mixed capped per-swing claim, as its expected-value schedule
already does. A monster attacking a player is outside this model; the classic core's other stock terms
(its Strength/5 and its own crit/condition order) remain the separate `W-CLASSIC-STRENGTH`/legacy gap.

## Stage 2.3 - enemy-type bonuses, phobias and silver (2026-11-14)

**What the game does.** `combat/pcaao.js:491-522` `pcaaoBonusOrPenaltyByEnemyType` reads the career byte
(`attackModifierFlags ?? career.attackModifierFlags`); the player's Willpower sets
`will = int((WIL - 50) / 5)` and the target's level sets the two arms:
`bonus = max(10 + will - int(targetLevel / 2), 0)` and `penalty = max(int(targetLevel / 2) - will, 0)`.
The bonus is rolled by `rangeExclusive(bonus)` (0..n-1); a phobia subtracts the fixed penalty. The group is
`enemyEntityGroup(target.careerIndex)` - not the affinity, and not the class flag - and
`careerAttackModifier` (`combat/formulas.js:176-197`) decodes bonus-first. It is added once per blow after the
`if (damage < 1) damage = 0` floor and **before** `weaponBlowMods` (weapon `:594-600`, fists `:552-556`).

`combat/pcaao.js:549-590` then applies, on the weapon roll plus the swing/proficiency/racial modifiers and
**before** Strength and the material modifier: a **Skeletal Warrior** (career 15) halves every weapon whose
flags lack 0x10 and then doubles a silver one; a **silver** weapon (material 2) doubles careers
9/18/19/23/28/14 (Werewolf, Ghost, Wraith, Vampire, Mummy, Wereboar). `silverDoubles`
(`combat/formulas.js:462-470`) is the named-veto seam; no default veto is registered. Unarmed blows and a
player target take neither.

The Ranger's animal test is `systems/martialPowers.js:206-207` via `systems/loot/lootPowers.js:142-157`
`foeGroup`: `affinity === 'Human'` first (a class foe is a man), then the career group. The previous local
test (`target.group === 'animals' || target.affinity === 'animal'`) never matched the singular `'animal'`
or the capitalised affinity, so the 20% never landed; `cutthroat`/`crusader` now use the same `foeGroup`.

**Changed.** `src/target.js` adds `enemyTypeGroup`, `enemyTypeBonusRange`, `enemyTypeBonusValue`,
`enemyTypeBonusValues`, `silverApplies`, `isSkeletalTarget`, `skeletalSilverDamage` and a `combatLevel`
field (normally `level`; the gate's is the `bossStandIn` body level 21). `src/model.js` `damageModel` now
applies the weapon-roll stage as `roll + damageModifiers`, then silver/skeletal, then Strength/material,
the floor, then the enemy-type bonus distribution, then `weaponBlow` (mastery/slayer/elemental/martial/
Firmament), then the existing crit/material-requirement/condition band. The bonus and silver are reflected
in `damage.parts.enemyType` and `damage.parts.silver`, and the blow card now spans the bonus distribution.
The classic core is unchanged. The gate's `level` stays the content level; `combatLevel` is 21.

| Check | Result |
|---|---|
| enemy-type bonus/phobia | 13,824 exact values against `pcaaoBonusOrPenaltyByEnemyType` |
| foe-group classification | every `ENEMY_BASICS` row against `foeGroup` |
| silver/skeletal weapon blow | 1,200 exact roll×bonus multisets against `pcaaoWeaponAttackDamage` |
| 0x10 weapon flag | exact multiset with and without the flag |
| end-to-end, real foes + gate | 7 + 1 seeded samples (40,000/20,000 draws), all inside the 95% CI |

Representative per swing (level 20, long blade, 100 Willpower), no target armour/cap:

| Target | Local before 2.3 | Local after 2.3 |
|---|---|---|
| Undead 18, steel, no flags | 9.29 | 9.29 (unchanged) |
| Undead 18, steel, Undead bonus | 9.29 | 12.91 (mean +3.62) |
| Undead 18, silver, no flags | 9.29 | 21.19 |
| Undead 18, silver, Undead bonus | 9.29 | 25.72 |
| Skeletal 15, steel | 8.87 | 5.20 (halved) |
| Skeletal 15, silver | 8.87 | 8.87 (halve, then double restores the roll) |
| Humanoid 22, silver, Undead bonus | 3.25 | 3.25 (no match, no double) |
| Gate (Daedra 31), steel, Daedra bonus | 11.02 | 15.29 (body level 21; 45 would give 0) |

Full suite **307 tests, 307 pass**; differential **32/32**; golden **13/13**; vendor **257/111**;
parity **1567/1567**.

Remaining limits: the enemy-type term is the player arm only (a monster attacking a player, and a player
target's Humanoid group, are outside the simulator); the bonus is enumerated as an expected distribution,
so a single blow's variance is not reported; the classic core's own level-based enemy-type arm is not
modelled; the silver rule is overhaul-only; the 0x10 flag exception is honoured but no port weapon mints it.
No waiver was removed or added in this phase.

## Stage 2.2 - worn armour and shield mitigation (2026-11-14)

**What the game does.** A blow rolls the struck body part first (`combat/pcaao.js:1709`,
`pcaaoStruckBodyPart`), then resolves the target's defence there:

- the shield in the **left hand** (a shield template, not whatever the hand holds - the port's
  sixth departure) rolls `pcaaoShieldBlockChanceCalculation` (`:1520-1570`) at a *strong* spot
  (a part `SHIELD_PARTS` covers) or a *weak* one. If it succeeds,
  `pcaaoCompareShieldToUnderArmor` (`:1574-1590`) keeps the block only when the shield's
  average reduction over 100 is at least as good as the piece under it (bare skin reduces by
  the natural resistance alone);
- a blocking shield reads `SHIELD_UNARMED/BLUNT/EDGED_ROWS`; else the struck part's worn piece
  reads `UNARMED/BLUNT/EDGED_ROWS` (`:1261-1335`, `:1349-1425`); else a **monster** takes its
  career hide (`:1447-1471`) and any other target natural resistance alone;
- every row is `unityRound(F(damage * F(F(min(F(base * cond), F(cap))) - natural)))`, with the
  material id `itemArmorValue / 2` for a piece (a shield by its native material) and
  `pcaaoAlterArmorReducBasedOnItemCondition` for the condition band. The mod's
  `Mathf.Clamp(7,95)` and `(0,50)` on the block chance are computed and discarded, as upstream does.
- the order is: strike → critical → material requirement → weapon condition → **natural
  resistance and the shield roll → worn armour** → boss traits → per-hit cap → Breach allowance
  (`:1740-1843`). Damage below 1 returns before the reduction (`:1806`).

**Equipment construction.** `combat/enemyEquipment.js` is now vendored actual (previously a
stub): `armorOfMaterial` is the game's ItemBuilder minter, `rollEnemyEquipment`/`enemyArmorValues`
the loadout and its ArmorValues pass (each piece subtracts `materialValue x 5` on its part, a
shield `shieldValue x 5` on its protected parts, the class 60 clamp, and the monster's
`min(equipment, row armour x 5)` rule; the Feet bound is DFU's). `scenes/hostCombat.js`
`equipEnemy` places the pieces in the equip table; that scene is not vendored, so the same
seven-slot placement is reproduced in `equipArmour` and pinned by tests.

**Changed.** `src/target.js` gains the target's equipment (`equip.slots`, built by `equipArmour`
from `armorPiece`; `gearEnemy` rolls the game's own `equipmentVariantFor` + `assignEnemyStartingEquipment` loadout), `struckSlotItem`, `leftHandShield`, `armourMaterialId`,
`armourConditionMultiplier`, `armourReduction`, `shieldReduction`, `shieldBlockChance`,
`shieldBeatsUnderArmour`, `targetPartDamage` and `targetExpectedDamage`. `src/model.js`
`analyze()` now resolves a geared overhaul target **per struck body part**, keeping the 20-entry
body-part distribution through the target layer, the boss's traits and the per-hit cap; a
gearless target keeps the previous path bit for bit. `src/maxprofile.js` `cappedDpsWith` uses the
same expected target defence. Worn equipment is kept separate from the fixed hit-chance
`armorValues` (the gate's 60 is untouched by worn gear). `notes.preWornArmor` is now false only
when a worn piece is present.

| Check | Result |
|---|---|
| armour material id / condition | exact against `pcaaoArmorMaterialIdentifier` / `pcaaoAlterArmorReducBasedOnItemCondition` (2,002 cases) |
| armour + shield rows | exact against `pcaaoPercentageReductionCalculationWithWeapon/Unarmed` (49,280 cases × 2) |
| block chance + under-armour compare | exact (240 + 3,024 cases) |
| enemy ArmorValues from worn pieces | 20 seeded loadouts identical to `assignEnemyEquipment` |
| end-to-end, class and monster with cuirass/helm/buckler | 2 × 20,000 draws; local means inside the 95% CI |
| gate / reference gearless | unchanged (`wornArmour:false`; gate hide 95, fixed armour 60) |

Representative per-swing (level 45, long blade, the same build): reference 'tough' 18.67 (unchanged);
class 128 bare 18.67 -> 6.04 in a full daedric set + tower shield; monster 22 bare 13.27 -> 6.04;
the gate bare 17.67 -> 6.04 when a caller equips it (its fixed 60 ArmorValues still governs the hit
chance). The full suite is **285 tests, 285 pass**; differential **26/26**; golden **13/13**; vendor
**257/111**; parity **1567/1567**.

Remaining limits: a **player** target's own armour channels are not modelled (`entityEnchantArmorMod`/
`entityArmorPoints`); spells, procs and DoTs never enter the physical block; armour/weapon wear over
time is not simulated (condition is caller-supplied); the shield's per-blow block is an expected value,
so a single blow's variance is not reported. Silver, enemy-type/phobia, backstab, condition corrections,
powers, procs, wards, techniques and encounter calibration remain out of scope.

## Stage 2.1.1 - target-model validation: gate identity, material order, spell tolerance (2026-11-14)

**What the game does.** `world/gate/gateBoss.js:151-157` builds the gate stand-in with
`makeEnemyEntity(look.mobile, ENEMY_BASICS[look.mobile], null, 1)`: mobile 31, career index 31,
**career `null`**, then `minMetalToHit = 0`, `armor = armorValues = 60`, `spareGear = true`. The index
selects the hide and enemy group; it does not load `ENEMY031.CFG`, so the target's career is null and its
elemental tolerance is Normal. `combat/pcaao.js:1640-1700` evaluates the material requirement
before the weapon roll's use: it sets `matReqDamMulti`, and after the critical it applies
`unityRound(F(damage * F(matReqDamMulti)))` before the weapon-condition band, then the hide/natural stage
and the host's traits/cap/allowance. `systems/spellcast.js` (now actually vendored) selects career
tolerance by every effect flag the spell carries, folds the four tolerance bytes with precedence
Resistant > Immune > LowTolerance > CriticalWeakness, adds the player's racial flags/biography/entity resist,
checks `saving >= 100` for immunity, then adds `floor(live willpower / 10)`, subtracts pierce and clamps 5..95.

**Gate identity.** The local `gateTarget` already had career index 31 and `career: null`; this phase confirms
that is faithful to upstream and adds a direct comparison against `bossStandIn`. The gate's elemental
tolerance stays **Normal**; it is not given a career from its index. No gate/identity correction was needed.

**Material ordering.** The local `damageModel` already applies the material multiplier after the critical and
before condition, then `analyze` applies the intrinsic hide/natural stage before traits/cap. This phase adds
boundary tests (below/at/above the requirement, 0.4/0.6/0.8/0.9-cap values, soft vs hard, a half-to-even
rounding case) and a 6,000-draw crit+condition comparison. No ordering correction was needed.

**Spell tolerance.** `systems/spellcast.js` was a generated stub. It was added to the vendored subset via
`tools/vendor-upstream.mjs` (now **256 vendored, 112 stubbed**); its only still-stubbed edge is `player/motor.js`
for capsule/missile geometry, which `savingChance` does not read. `savingChanceOutcome` now carries the full
effect-flag fold (Fire/Frost/Shock/Poison/Magic/Disease/Paralysis), player racial immunity/resistance and
biography terms, entity resist, modifier, pierce, the 100 immunity gate and the 5..95 clamp. The differential
suite compares it, `savingLands`, `careerTolerance` and `spellHasFlags` against the vendored module.

| Check | Result |
|---|---|
| gate target vs `bossStandIn` | career index 31, mobile 31, career `null`, affinity Daedra, `minMetalToHit 0`, armour 60, Normal fire tolerance |
| material 5 / material 2 | x0.4; exact/above requirement x1; hard refusal 0 |
| material 9 / material 0 | x0.1 (the 0.9 penalty cap) |
| material sample with critical + 50% condition | local 6,000-draw expectation inside upstream's 95% CI |
| spell saving/career tolerance | 840 + 15 + 101 + 42 + 4 exact cases against vendored `spellcast.js` |

Full suite **254 tests, 254 pass**; differential **20/20**; golden **13/13**; vendor **256/112**;
parity **1477/1477**. No gate or material outputs changed; no waiver was removed or added in this phase.
Remaining spell limits: `savingThrow`'s dice and `elementalResistanceChance` effects are not modelled, and
non-element `effectFlags` are not derived from arbitrary spell effect records. These are outside Stage 2.1.1.
The gate target's `level` remains the content level (45), not the fixed body level (21); no Stage 2.1 stage reads it.

## Stage 2.1 - target model fidelity: hide, natural resistance, tolerance and metal (2026-11-14)

**What the game does** (`vendor/upstream/a3eb1605/src/combat/pcaao.js`): after the blow's critical, material
requirement and condition, a gearless monster takes its **career hide** through
`pcaaoPercentageReductionCalculationForMonsters` (:1447-1471, called at :1815-1817), with the target's
**natural damage resistance** from Endurance/Strength/Willpower (`pcaaoNaturalDamageResistance`, :1594-1605)
subtracted inside that hide. A gearless class target takes the natural resistance alone through
`pcaaoArmorDamageReductionWithWeapon` (:1349-1392). A weapon below the target's `minMetalToHit` takes
`min(0.2 x (need - material), 0.9)` off (`pcaaoAttackDamage`, :1640-1700); the soft module is on by default,
and the hard module refuses the blow whole. A weapon's `elemental` lines are floored after the target
career's tolerance (`systems/loot/lootPowers.js:164-167, 286-294`); a spell/proc's career tolerance folds
into its saving throw (`systems/spellcast.js:61-68, 130-190`; now vendored actual in Stage 2.1.1). The order is: blow → critical → material requirement → condition → target hide/natural →
host boss traits → per-hit cap → relay allowance.

**Changed:** new `src/target.js` (the target shape; `ENEMY_BASICS` identity; `careerTolerance`,
`elementShare`; `naturalDamageResistance`; the ported hide table; `materialRequirementMultiplier`). `src/model.js`
builds reference/boss/gate/encounter targets through explicit identity fields, applies the material multiplier
in `damageModel`, applies the intrinsic hide/natural stage once after backstab and before boss traits/cap, and
resolves each elemental affix line through the target's tolerance. `src/encounters.js` carries mobile types for
the three contents. `src/spells.js` adds the career tolerance to `savingChanceOutcome` (and the 100 immunity
gate). `src/maxprofile.js cappedDpsWith` re-resolves the target defence for imprint/enchant pricing. Waiver
`W-BOSS-HIDE` removed.

| Representative build (level 45, Breach) | per swing before | after | capped DPS before | after | TTK before | after |
|---|---|---|---|---|---|---|
| legal max Dai-katana | 807.3 | 766.9 (-5.0%) | 820.6 | 818.1 (-0.3%) | 76.0 s | 76.0 s |
| raw 200, no gear, Dai-katana | 113.5 | 107.9 (-5.0%) | 160.2 | 152.2 (-5.0%) | 81.1 s | 84.8 s |
| Warhammer 240/540 | 117.5 | 111.6 (-5.0%) | 146.0 | 138.7 (-5.0%) | 88.0 s | 92.1 s |
| low fixture (level 30, raw 60) | 15.35 | 14.55 (-5.2%) | 14.8 | 14.1 (-5.0%) | 813.9 s | 857.6 s |
| fire +10 affix on a level-45 blade | 27.233 | 25.882 | - | - | - | - |

The 5% is the Daedra Lord's x0.95 hide. A saturated Breach build's capped DPS barely moves because its
per-hit blows are still above the cap after the hide; a sub-allowance build's TTK moves by the same 5%.
The reference foe (`careerIndex -1`, stats 50) has no hide and no natural resistance, so its outputs are
unchanged. A material-2 weapon against a `minMetalToHit: 5` target now reads x0.4; a 6,000-draw comparison
gave 7.63 local vs 7.62 upstream per swing (inside the 95% CI). A career with a fire resistance flag reads
x0.5 on a fire affix and a raised saving throw; the gate stand-in has `career: null` (as `bossStandIn`), so
its elemental tolerance stays Normal until a career is supplied.

**Tests:** `test/target.test.js` (11 tests: reference baseline, enemy identity/mobile/class, hide/natural,
career tolerance and saving, material requirement, exact-once ordering, cap/allowance, single/dual);
`test/differential.test.js` adds `target intrinsic hide and natural resistance` (192 exact cases) and
`target natural resistance from a career stat block` (4 exact cases). Existing C2/C5 tests now compose the
target hide with the boss trait and prove one application. Full suite **248 tests, 248 pass**; differential
**17/17**; golden **13/13**. C1–C5 remain intact.

**Not in this stage:** worn armour/shield mitigation, shield blocking, silver, enemy-type bonus/phobia,
backstab, condition wear, racial/classic, Legendary powers, proc/DoT budget, phase wards, spell-system
reconstruction, techniques and encounter calibration. `spareGear:false` is only partially supported
(natural resistance, not worn armour). The target's career data is not loaded from `MONSTER.BSA`; a caller
supplies a career object when it has one. See the assumptions register M11/A12.

## Stage 1.5 - C4: the reachable gear-profile ceiling (2026-11-14)

**What the game does** (`vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js` unless stated):
`AFFIX_RANGES` gives a skill line's bands Magic [5,10], Rare [10,20], Legendary [20,30] (:486), and a weapon
damage line Magic [5,12], Rare [10,25], Legendary [20,40] (:487). `AFFIX_COUNTS` gives Magic 1-2 lines and
Rare 3-4 (:507). `kindLines` allows one line per kind's param on a piece, so a skill appears once per param
(:679-682). `skillKin` names what a ROLLED line may carry: a weapon its own skill plus Critical
Strike/Backstabbing/Dodging; armour the body's twelve; jewellery the mind's thirteen plus Hand-to-Hand and
Critical Strike (:703-716, :784-788). `legendariesFor` picks the records a slot may be minted from
(:1310-1314). A Legendary's record lines are fixed; `honeableLines` takes only a Magic/Rare line or an
Exalted Legendary's extra, up to its band's top (:2243-2250). `exaltLegendary` adds ONE line of a kind the
record does not carry, at the top half of the Legendary band (:1770-1790); its skill PARAM is drawn with
`pick(kindParams(id, item))`, which is **not** kin-filtered (unlike `rollAffixes`' `pickSkill`, :818-826),
so an Exalted armour or jewellery piece can gain +30 of any skill. `lootLevelGate.js` scales the CHANCE of
Rare/Legendary drops by character level (Rare x0.15 to level 7, x1 at 12; Legendary x0.05 to level 9, x1 at
15); it is not a point budget, and every rarity is fully available from level 15.

**The illegal assumptions.** The old max profile put 30 points on all 8 own-skill lines and all 18 Critical
Strike lines (240 + 540 = **780**) and a 40% damage line on the weapon. A piece cannot do that: a Legendary
record's skill line is fixed (20-25), only the single Exalted extra reaches 30, and one piece cannot carry
both 30s. A weapon's every record carries a skill line, so a weapon can never Exalt a skill and tops at 25;
a Rare contributes 20 + 20 and a Magic at most two lines. The 40% damage line is a band top no record
carries: a Rare rolls at most 25%, and the best Legendary record is warp-edge's fixed 38%.

**Changed:** new `src/gearProfile.js` (slot options, the Pareto frontier, the point budget, `validatePlan`,
the oracle-backed slot/record queries). `src/maxprofile.js` gains `buildMax` (explicit budget),
`legalGear` (the frontier point that maximises uncapped/capped/allowance DPS, with the tied alternatives
kept) and `legalFrontier`; `maxCharacter` uses it. The weapons page and the `theory` command default to the
legal split, mark explicit `--gear-lb/--gear-cs` builds as hypothetical when they are off the frontier, and
present the attainable frontier instead of a `lines x 30` table. `src/theory.js`'s cap notes now state the
legal maxima. The `--gear-lines/--line-points` flags are obsolete and say so. Waiver `W-GEARCAP` removed.

| Build (level 45, theory character, no Firmament) | old 240/540/40 uncapped | legal uncapped | gap | old capped | legal capped | TTK |
|---|---|---|---|---|---|---|
| Dagger 113 | 1135 | 901 (310/310/25) | -20.6% | 1135 | 901 | 75.6 s |
| Wakizashi 117 | 1258 | 989 (310/310/25) | -21.4% | 1198 | 989 | 75.6 s |
| Katana 121 | 1345 | 1036 (250/370/25) | -23.0% | 892 | 869 | 76.0 s |
| Dai-katana 123 | 1472 | 1139 (250/370/25) | -22.6% | 821 | 821 | 76.0 s |
| Warhammer 126 | 1343 | 1028 (220/400/25) | -23.5% | 644 | 514 | 76.3 s |
| Battle Axe 127 | 775 | 607 (315/290/36) | -21.7% | 723 | 607 | 75.9 s |
| Long Bow 129 | 1239 | 951 (250/370/25) | -23.3% | 776 | 773 | 75.8 s |
| Hand Wraps 563 | 2990 | 1841 (360/360/25) | -38.4% | 1083 | 911 | 75.9 s |

The blades reproduce the audit's ~22-28% gap (the audit's own estimate was not taken on faith: it falls out
of the frontier). The Breach capped figure is nearly unchanged for the long blade (821) because the fight is
allowance-bound (sustained 150/s, kill average 157.9, TTK 76.0 s - C1 intact); the lighter weapons lose more
capped DPS. The legal single-skill maxima are 535 for both Long Blade and Critical Strike (a 25-point weapon
record + 17 Exalted slots x 30), the highest combined total is 620 for a long blade, and 720 for fists
(JEWEL_KIN lets a Rare jewellery carry both Hand-to-Hand and Critical Strike). A one-handed build with a
shield is a distinct 19-slot scenario (`legalGear(t, { shield })`), kept separate from the 18-slot profile.

**Tests:** `test/gearProfile.test.js` (13 tests: bands/counts/Exalted floor against the vendored constants;
rolled vs Exalted kin; one line per kind; the 240/540/780 impossibility; per-skill and total budgets; the
level gate; rejection of illegal plans; generated-profile completeness and optimality; uncapped/capped/
allowance splits; the shield scenario; single/dual/fist builds; damage-model identity; C1). The new tests
were run against the pre-fix profile (a copy with `evaluatedFrontier` returning the old 240/540/40): **4 of
13 fail** - "a generated max profile is legal..." (first failure: `113: CS 540 is above the legal 530`),
"scenario maxima are kept apart", "a shield is a distinct legal scenario", and "single-weapon, dual-wield
and fist builds keep the legal budget". The other nine (the upstream-law and validator tests) pass because
they test the new constraint model, not the old builder; they are the law the fix rests on.

**Remaining assumptions:** the max profile is a theoretical ceiling requiring perfect rolls on all 18 pieces
(rolled lines honed to their band top; a 1-in-10 Exalted roll wherever the chosen split uses a no-skill
Legendary). Hones cost gold and shards but no point budget and have no level gate. The off-hand weapon's
affixes are not folded into the dual-wield budget (the simulator's dual rows are a lower bound; C3's
damage/tempo law is unchanged). The one-handed + shield max is exposed but not used by the weapons table;
those rows remain a one-slot lower bound. No live capture was taken: this is the pinned snapshot's law.

## Stage 1.4 - C3: dual wield, tempo not twice the damage (2026-11-14)

**What the game does** (vendored `combat/twoHands/handsLaw.js`, `combat/playerWeapon.js`): a held pair alternates
hands inside `FLURRY_WINDOW` (0.75 s); a flurry's blow starts `DUAL.FLURRY_FROM_FRAME` (1) frame into its five-frame
swing - FOUR ticks at any frame rate - and an off-hand blow then holds `offHandHold` whole ticks at its end (its
weapon's weight against Strength, `offHandBurden`). The lead blow is the ordinary blow; only the off hand takes
`offHandToHit(agility)` on the to-hit channel and `OFF_HAND_BLOW` (x0.8 of the rolled damage; x0.8 weight for what a
blow sets off, so its Cast When Strikes payloads fire on 0.8 of its blows). Upstream's own test measures a matched
pair at 1.22-1.28x the swings and 1.06-1.11x the damage of one weapon.

**Cause of the 1.799x:** the simulator doubled the attack rate (`aps = main.aps * 2`) and averaged the two hands'
damage, which counts an off-hand blow as a full-speed main-hand blow. It also used a flat -5 to hit, a x0.8 share
hard-coded in the loop, a x1.5 heft on the off weapon instead of the burden, and gave the off hand 100% of its procs.

**Changed:** new `src/dualWield.js` (an adapter over the vendored law: `dualSchedule`, `swingsRatio`,
`damageRatio`, and the off hand's terms) and the dual branch of `analyze()` rewritten around one exchange: `aps =
2 / (4*mainTick + 4*offTick + hold*offTick)`, each hand's own tick, the off hand's Agility to-hit and x0.8 share, its
procs at x0.8, and two time-ordered claim streams (one per hand) for the C1 allowance. Single-weapon and two-handed
paths are untouched.

| Build (level 45, geared) | single DPS | old pair | new pair | ratio before | ratio after |
|---|---|---|---|---|---|
| dagger pair | 271 | 487 | 305 | 1.799 | **1.124** |
| longsword pair | 1119 | 2014 | 1234 | 1.800 | **1.103** |
| katana pair | 1174 | 2113 | 1321 | 1.800 | **1.125** |

At the Breach every blow is over the per-hit cap, so the pair's extra blows are worth their whole cap and its capped
DPS sits near the swings ratio - 305/1016/1078 against 271/850/887 for one weapon - while the allowance still holds
all of them to 150/s sustained (kill average 156.8-157.9, TTK 76.0-76.5 s; the opening burst is 254-263 against the
single weapon's 250-277, the off hand's first blow arriving half an exchange later). At Agility 50 with a modest skill
the pair/single ratio is 1.083, inside upstream's pinned 1.06-1.11 band.

Waiver `W-DUAL` removed. `test/golden-upstream.test.js`'s dual case now asserts the schedule against the pinned ratios
and the model against the exchange, and `test/sockets.test.js`'s dual case is titled for the Agility term.

## Stage 1.3 - C5: the elemental affix counted once (2026-11-14)

**What the game does** (`vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js:286-347`): a weapon's
`elemental` lines are summed as FLAT damage inside `lootBlow`, one of the registered weapon-blow modifiers:
`flat += Math.floor(value x elementShare(target, element)); ... return out + flat`. It is added once, after
loot's own slayer percentage and before whatever registries follow it; the blow then takes the martial/Firmament
channels, backstab, the critical multiplier, weapon condition, the boss's traits (`bossStrikeAt`), the per-hit
cap and the relay's allowance. `elementShare` reads the target's career tolerance, never a boss trait, and it is
not a spell.

**Cause of the double count:** the simulator added the affix in `weaponBlow` (correct) and again in
`damageModel().one()` (`if (d > 0 && w?.elemental) d += w.elemental`). +10 read as +20 on every weapon blow;
a hand-wrap fist blow was unaffected (it has no `w`), which hid the inconsistency.

**Changed:** the second addition is gone; the remaining one is placed at the loot step in the gate host's
registry order (mastery -> slayer -> flat -> martial -> theory -> Firmament). The harness oracle's module order
was aligned to that host so an affixed blow is compared where the fight resolves it. One differential stage was
replaced by a positive one (3 weapons x 3 affix levels x 2 swings against the card) and `test/elemental.test.js`
added. `W-ELEMENTAL` removed.

| Case (level 45 unless stated) | before | after |
|---|---|---|
| plain katana, `damage.avg` delta for a +10 fire affix | +20.0 | +10.0 |
| critical blow, delta for +10 (crit x2.0) | +40.0 | +20.0 |
| +3 / +6 / +10 affix levels, per-roll delta | +6 / +12 / +20 | +3 / +6 / +10 |
| long bow +10 (pull x1.5) | +30 | +15 |
| Breach per-swing delta for a blade +10 (no martial path) | +20 | +10 |
| Breach per-swing delta for a blade +10 (Blademaster, +15% path) | +23 | +11.5 |
| Breach per-swing delta for a blunt +10 (stoneskin) | +20 x0.5 = +10 | +10 x0.5 = +5 |
| SAVE4 (level 30) +3 / +6 / +10 elemental affix marginal, Breach | +18.8 / +37.9 / +63.2 capped DPS | +9.4 / +18.8 / +31.4 capped DPS |

the assumptions register A11 records the registry-order choice and A12 the `elementShare` bound.

## Stage 1.2 - C2: relay-boss traits and resistance (2026-11-14)

**What the game does** (vendored `systems/bossTraits.js`, driven by `test/bossTraits.test.js`):
`relayBossTraits(name, mobile)` hashes the stand-in's name and mobile (`eliteHash` -> `eliteRng`) and picks
one element proof out of `['flameproof','frostproof','venomproof','stormproof','spellproof']` and one weapon
answer out of `['bladeturning','stoneskin','thorned']` (`:393-409`). `dungeonContext.js:4410` gives them to
the stand-in. At `a3eb1605`: Ruhn = `spellproof + stoneskin`, Tonal Warden = `frostproof + stoneskin`, Brass
Remnant = `spellproof + stoneskin`. The striker's machine then resolves each blow before its claim leaves:
`bossStrike(entity, d, {kind, weapon, element})` (`:210-224`) multiplies a blade/arrow by 1/2 under
bladeturning, a blunt blow, fist or Hand Wraps by 1/2 under stoneskin, a spell of the proved element by 1/4,
then `Math.max(1, Math.round(d))` - ahead of the per-hit cap and the relay's allowance.

**Changed:** new `src/bossTraits.js` (a thin adapter over the vendored law: `relayTraitsFor`,
`resistBlow`). `gateTarget` and `encounterTarget` derive their traits from it instead of defaulting to none;
`analyze()` resolves every blow through `bossStrike` per integer roll, before the cap and before the C1
claim (so `perSwing`, `dps`, `cappedDps` and the allowance's `ceilingDps` are all resisted - the uncapped
figure used to escape the traits entirely). Spells/procs/DoTs already read `bossTraits`; they now receive
the real ones, through the client's `ELEMENT_TRAITS`/`RESIST_SHARE`. `cappedDpsWith` (imprint pricing)
re-resolves through the same function. A weapon's `elemental` affix is untouched: upstream scales it by the
target's career tolerance, not by a boss trait.

| Build (level 45) | before | after | ratio |
|---|---|---|---|
| Breach, Dai-katana per swing | 1043.3 | 1043.3 | 1.000 |
| Breach, Warhammer per swing | 1080.9 | 540.7 | 0.500 |
| Breach, fists per swing | 851.2 | 425.8 | 0.500 |
| Breach, long bow per swing | 473.6 | 473.6 | 1.000 |
| Breach, Warhammer per-hit-capped DPS | 723.1 | 644.1 | 0.891 |
| Breach, fists per-hit-capped DPS | 1083.3 | 792.6 | 0.732 |
| Sky-ketch, Warhammer per swing | 1080.9 | 540.7 | 0.500 |
| Breach, magic spell | 27.8 | 6.9 | 0.250 |
| Breach, fire spell | 27.8 | 27.8 | 1.000 |
| Sky-ketch, frost spell | 27.8 | 6.9 | 0.250 |
| ordinary tough monster, per swing | 1138.2 | 1138.2 | 1.000 |

Waiver `W-BOSS-TRAITS` removed (fixed). `test/theory.test.js`'s H2H band now asserts the band against a
neutral body and the halved figure against the real Warden.

## Stage 1.1 - C1: the Breach damage allowance (2026-11-14)

**What the game does** (`vendor/upstream/a3eb1605/src/net/gate/gateBrain.js`, driven directly by
`test/allowance.test.js`): a player's blow is a *claim*; `applyHit` (:1298) refuses it while the boss is
shielded (no token spent), `spendBlow` (:3411) takes one of 4 tokens (refilling 4/s), and the relay accepts
`min(claim, 12 x ref, bucket, health left)`. The bucket is 15 x ref deep (full on a fresh join, empty on a
wounded one, `joinFight` :1213) and refills 3 x ref a second (`ref = 5 + level`). The excess is discarded.
Each proc and DoT round is its own claim (`gateCourt.js:412` `blowQ`, `standInSpell.js:131-217`).

**Changed:** `src/allowance.js` (new, the one implementation) is run by `analyze()` for any target that
declares an allowance (`gateTarget`, `encounterTarget`) and by `simulatePurse` (now a thin wrapper).
`analyze()` keeps `cappedDps` as the per-hit ceiling and reports `allowance` (`sustainedDps`, `burst5Dps`,
`averageDps`, `ceilingDps`, ...); `ttk`/`totalTtk` now go through the relay, with the old figure kept as
`ttkCapOnly`/`totalTtkCapOnly`. CLI/report/weapons/loadout pages label each metric. The relay's
`gateBrain.js`/`gateMods.js` were added to the vendored subset (parity 1477/1477).

| Build (level) | per-hit-capped DPS (old headline) | old TTK | sustained | burst 5 s | kill-avg | new TTK |
|---|---|---|---|---|---|---|
| geared Dai-katana (45) | 821 | 20.6 s | 150 | 260 | 157.9 | 76.0 s |
| geared Katana 1H (45) | 892 | 19.5 s | 150 | 271 | 157.8 | 76.0 s |
| mid-gear Dai-katana (45) | 358 | 39.5 s | 150 | 260 | 157.9 | 76.0 s |
| weak katana (45) | 61 | 202.6 s | 61 | 57 | 59.3 | 202.5 s |
| SAVE4 character (30) | 125 | 73.1 s | 105 | 118 | 110.5 | 76.0 s |

The audit's "~80 s fastest kill" is `BOSS_TTK_S / BUCKET_RATE_X` without the opening bucket; the true floor is
`(share - depth) / refill` = 75 s at level 45. Waiver `W-ALLOWANCE` removed (fixed); `W-PROC-BUDGET`
narrowed to the ceiling figures. Not changed: C2-C5 and every per-hit calculation.

## Stage 0 - verification foundation (2026-11-14)

**No mechanics or calculation outputs were changed.** This stage adds the
verification layer, the vendored oracle and the documentation; the existing
engine is untouched.

Added:

- `vendor/upstream/a3eb1605/` - 253 upstream files (≈6 MB) + 113 documented
  stubs, with `MANIFEST.json` hashes. Generated by `tools/vendor-upstream.mjs`.
- `tools/vendor-parity.mjs` - proves the vendored subset answers exactly as the
  full checkout: **1473/1473 checks identical** at `a3eb1605`.
- `test/harness/*` - seeded PRNG, oracle loader, stage comparator, waiver table.
- `test/differential.test.js` - 13 stage comparisons against the game.
- `test/golden-upstream.test.js` - fixtures pivoted from upstream's own tests
  (`combatStats`, `pcaao`, `twohands`, `bowbloom`, `powerceiling`).
- `test/invariants.test.js` - bounds, boundaries and the audit's critical gaps.
- `test/vendor-manifest.test.js` - hash/manifest integrity and load checks.
- `test/harness.test.js` - the harness's own correctness, including an injected
  2% drift that the comparator catches.
- `docs/SOURCES.md`, this file.

Recorded as known and **not fixed** (each asserted as still broken):

| Waiver | Effect today |
|---|---|
| ~~`W-BOSS-TRAITS`~~ | Relay-boss traits not applied - **fixed in Stage 1.2** (this waiver was removed). |
| ~~`W-DUAL`~~ | Dual wield 1.80× one weapon - **fixed in Stage 1.4** (this waiver was removed). |
| ~~`W-GEARCAP`~~ | Max profile assumed 30 points on 26 lines - **fixed in Stage 1.5** (the legal max is 535 per skill, 620 together). |
| ~~`W-ELEMENTAL`~~ | `elemental` affix added twice - **fixed in Stage 1.3** (this waiver was removed). |
| ~~`W-BOSS-HIDE`~~ | Target hide/natural resistance - **fixed in Stage 2.1** (this waiver was removed). |
| ~~`W-BACKSTAB`~~ | Backstab was a scaled roll - **fixed in Stage 2.4** (this waiver was removed). |
| ~~`W-CONDITION`~~ | Weapon condition bands read a float percentage - **fixed in Stage 2.5** (this waiver was removed). |
| ~~`W-RACIAL`~~ | Racial weapon/fist arms missing - **fixed in Stage 2.6** (this waiver was removed). |
| ~~`W-CLASSIC-STRENGTH`~~ | Classic Strength used /5; the live install uses /10 - **fixed in Stage 2.7** (this waiver was removed). |
| `W-WARD` (removed 2026-11-18), `W-PROC-BUDGET` | Smaller per-hit discrepancies, detailed in `test/harness/waivers.mjs`. |

Next stages (not started): fix the critical set (Stage 1), the hit-path fidelity
items (Stage 2), the encounter layer (Stage 3).
