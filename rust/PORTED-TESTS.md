# Ported tests ledger (stage 5)

Every `test/*.test.js` file and every `test/harness/*` helper, with each `test()` title and where its proof goes.
The class is per file (some files mix a local assertion set with an oracle comparison; those say so).

## Summary

- **93 test files, 878 `test()` calls** (the plan estimated 92 files and ≥867 calls).

| Class | Files | Titles | After stage 5 |
|---|---:|---:|---|
| upstream-oracle (whole file) | 40 | 314 | live proof lost |
| upstream-oracle, numbers frozen in Rust vectors | 10 | 172 | live proof lost, the recorded answers survive |
| local unit/invariant, ported | 28 | 271 | hand-written Rust assertions |
| local unit/invariant, not ported | 3 | 25 | only the seeded vectors remain (gap) |
| tooling | 7 | 48 | deleted |
| CLI differential (snapshot + local pins) | 5 | 48 | stage 3 snapshots + the ported local pins |

New Rust targets (this branch): `rust/dfo-core/tests/ported_common/mod.rs` and
`ported_{backstab,condition,cws,dist_pins,dot_fight,enchants,gear_profile,imprints,invariants,model,objectives,probe,racial,relay,rng,stochastic,theory,tiers,waivers}.rs`,
plus `rust/dfo-cli/tests/ported_cli_usage.rs`. They hold 188 `#[test]`s and run in about 35 s.

One more target, `rust/dfo-core/tests/zz_dbg.rs`, carries the default-build card pins (`build14631.test.js`'s
"the default is the live build" and "an unknown gameBuild prices as the live build"). It has a scratch name
because this session cannot rename or delete a repository file; rename it `ported_build_default.rs`.

## What is lost for good (no Rust-reachable form)

- Comparing any **new** input with the upstream game, for every oracle file above.
- The vendored hash/tamper/parity checks (`vendor-manifest.test.js`) once the vendor is deleted.
- The differential harness's own negative controls (`harness.test.js`, `blowDifferential.test.js`'s last
  case): they prove the comparator detects a drift; the comparator itself is deleted.
- `invariants.test.js`'s two oracle cases: "skill boundaries read as the game reads them" (ported as the pinned
  values 100/108/140) and "the simulator never claims a value the oracle contradicts" (its job is the frozen
  per-blow vectors, generated from that oracle).
- `rng.test.js`'s two source scans (no `Math.random`, `Date.now`, `crypto.` in `src/`): the source is deleted.

## What a ported test proves

A ported test is a **local invariant**: a known value or an inequality the engine must satisfy, checked against
the Rust computation. It proves the port still computes what the JS asserted, not that the JS matched the game.
AGENTS.md rule 10: every ported file says so in its header. Seventeen were shown red under a hand perturbation
of the Rust computation they name, then green again after the exact restore (every source file is byte-identical,
checked by `sha256sum`):

| File | Perturbation | Red test |
|---|---|---|
| `damage.rs` | `damage_modifier` /5 -> /4 | `ported_model` strength terms |
| `damage.rs` | blade 6% band 0.45 -> 0.50 | `ported_condition` every blade band |
| `relay_claim.rs` | token gate `>= 1` -> `> 1` | `ported_relay` exact boundaries |
| `allowance.rs` | `HIT_HZ` 4 -> 5 | `ported_relay` the relay constants |
| `model_blow.rs` | `backstab_damage` x3 -> x2 | `ported_backstab` the x3 gate |
| `model_blow.rs` | racial damage + 1 | `ported_racial` every weapon arm |
| `swing.rs` | `swing_frame_seconds` x 2 | `ported_model` swing cadence |
| `save.rs` | 200 milestone 15 -> 14 | `ported_invariants` skill boundaries |
| `sockets.rs` | `socket_count` + 1 | `ported_theory` socket counts |
| `cws.rs` | `is_damage_health` subType 0 -> 1 | `ported_cws` the direct family |
| `probe.rs` | estimated `maxHp` + 1 | `ported_probe` the clean capture |
| `objectives.rs` | relay guard inverted | `ported_objectives` every objective |
| `blow_outcomes.rs` | merge key drops `formula_positive` | `ported_tiers` the merge key |
| `analyze.rs` | `carried_per_swing` = the card's figure | `ported_waivers` W-LOOT-CARRY |
| `analyze.rs` | ceiling drops the proc component | `ported_waivers` W-PROC-BUDGET |
| `generated/gear_profile.rs` | Exalted band top 30 -> 31 | `ported_gear_profile` the bands |
| `dfo-cli/src/main.rs` | encounter ids dropped from the target list | `ported_cli_usage` unknown target |

The W-PROC-BUDGET pin was strengthened after the first perturbation survived: it now asserts the ceiling is the
capped rate plus the proc component, not merely shorter than the allowance.

## `test/allowance.test.js`

**Class:** upstream-oracle — the numbers are frozen in Rust vectors, the live proof is lost
**Rust:** tests/allowance.rs, tests/relay_claim.rs (law/vectors); the relay constants and purse pins: ported_relay.rs

- law: the constants are the relay's own (read from the vendored gateBrain) — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- law: a joining player starts with a full bucket and four tokens (joinFight) — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: a build below the refill is never clipped and is killed at its own pace — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: a build far above the refill is limited to opening bucket + refill — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: a blow over the per-hit cap is clipped to it, the excess discarded not deferred — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: opening burst, then the refill rate - the late fight accepts exactly the refill — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: the same offered damage lands differently at different intervals — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: several claims inside a short interval - four tokens, then refusals — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: depletion, idle refill and the next claim — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: a refill never banks past the depth (a long idle is not a bigger bucket) — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: a boss shield refuses the blow before a token is spent, and the bucket keeps refilling — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: a phase shield ending exactly on a claim time accepts that claim (gateBrain is strict <) — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: joining a wounded boss starts with an empty bucket — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: procs and DoT rounds are claims of their own - each spends a token and a bucket — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: the per-claim cap applies to a proc and a DoT round on their own — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: levels 1, 30, 45 and 60 all agree with the game — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- relay: seeded random swings (misses, random damage) agree with the expected-value schedule — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- headline: the geared long blade no longer reports a 20 s Breach kill — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- headline: the metrics are named for what they are — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- headline: a build below the refill rate is NOT reduced to it — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- headline: Cast When Strikes procs raise the offered claims, not past the allowance — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- headline: the allowance is per player - a group scales the pool, not the allowance — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- headline: non-relay targets are untouched — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- headline: the encounter targets carry the allowance and the purse agrees with analyze() — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)
- headline: the spec is the law, not a hard-coded answer — frozen in tests/allowance.rs, tests/relay_claim.rs (law/vectors)

## `test/armour.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- armour: a piece lands on its own body part, a shield in the left hand — lost (oracle)
- armour: a weapon in the left hand is not a shield — lost (oracle)
- armour: armorValues stays a separate, fixed hit-chance field — lost (oracle)
- armour: a class foe wears the game's own rolled loadout — lost (oracle)
- armour: the reduction row is the piece's material value / 2 — lost (oracle)
- armour: condition moves the band (the port has no sharp-edge bonus) — lost (oracle)
- armour: only the struck part's piece replaces the hide — lost (oracle)
- armour: a class target has no hide; bare parts take natural resistance — lost (oracle)
- armour: unarmed, blunt and edged blows read different rows — lost (oracle)
- armour: the reduction rounds half to even and never goes below zero — lost (oracle)
- shield: strong and weak spots block at their own chance — lost (oracle)
- shield: the incoming kind and the shield's own material and condition — lost (oracle)
- shield: it blocks only when its average reduction beats the piece under it — lost (oracle)
- shield: it can never or always block at the ends of the chance — lost (oracle)
- shield: a shield also lowers the hit-chance ArmorValues on its covered parts — lost (oracle)
- armour: an arrow uses the same target defence path as a melee blow — lost (oracle)
- shield: a pair of stats moves the chance, and the block stays an expected value — lost (oracle)
- boss armour: the gate keeps its fixed 60 and a gearless hide — lost (oracle)
- boss armour: worn gear is separate from the fixed field — lost (oracle)
- integration: armour resolves before the boss traits and the per-hit cap — lost (oracle)
- integration: armour plus the Breach allowance — lost (oracle)
- integration: single and dual wield both resolve the target armour once — lost (oracle)
- integration: a gearless reference foe and the gate are untouched — lost (oracle)
- armour: hit chance and worn armour share the same body-part roll — lost (oracle)
- armour: the body-part expectation keeps the table, not an average piece — lost (oracle)

## `test/backstab.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_backstab.rs

- backstab: the chance is the live Backstabbing skill — ported → ported_backstab.rs
- backstab: no back-facing, no chance and no hit term — ported → ported_backstab.rs
- backstab: a Watchful revenant never gives one — ported → ported_backstab.rs
- backstab: the chance is added flat to the hit roll, not as a percentage — ported → ported_backstab.rs
- backstab: the ×3 gate and the dice threshold — ported → ported_backstab.rs
- backstab: the ×3 is before the critical, the material requirement and the condition — ported → ported_backstab.rs
- backstab: the material requirement and condition follow the ×3 — ported → ported_backstab.rs
- backstab: the outcome is a ×1/×3 mixture, not a scaled average — ported → ported_backstab.rs
- backstab: a skill of 1 gains the hit term but never the ×3 — ported → ported_backstab.rs
- backstab: the per-hit cap sees the bigger ×3 claims — ported → ported_backstab.rs
- backstab: the off hand carries its own chance, hit term and share — ported → ported_backstab.rs
- backstab: a bow can backstab — ported → ported_backstab.rs
- backstab: armour, traits and the cap compose with the ×3 outcome — ported → ported_backstab.rs
- backstab: the Breach allowance still claims the mixed blows — ported → ported_backstab.rs

## `test/benchmark.test.js`

**Class:** tooling — delete

- the benchmark uses the optimizer chain, with a carried imprint step and a separate card ceiling — delete
- capped loadout baselines stay on the pre-allowance card ceiling — delete
- every melee optimizer row is benchmarked, and the refused archetypes are named — delete
- an unknown option or a non-boolean durability is refused, not ignored (audit D4) — delete
- a declared condition is points OF the game's minted pool, not a small maximum — delete
- the same seeds reproduce the same cell and never mutate the build — delete
- spearman is +1 on a shared order and -1 on its reverse — delete

## `test/berserker.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- Frenzy: the premise - upstream reads the attacker's share, strictly below one half — lost (oracle)
- Frenzy: blow and pace over the attacker-share x foe-share grid equal upstream's own functions — lost (oracle)
- Frenzy: changing the FOE's health alone never moves the Berserker's component; changing the attacker's does — lost (oracle)
- Frenzy end to end: sampled blows with the four health combinations — lost (oracle)

## `test/blowDifferential.test.js`

**Class:** upstream-oracle — the numbers are frozen in Rust vectors, the live proof is lost
**Rust:** tests/blow_outcomes.rs, tests/fight.rs (vectors); the negative controls test the differential harness itself

- ${cfg.id}: the joint blow distribution, upstream ${cfg.draws} draws — frozen in tests/blow_outcomes.rs, tests/fight.rs (vectors)
- exact upstream probabilities: the critical roll and the direction/body-part branches — frozen in tests/blow_outcomes.rs, tests/fight.rs (vectors)
- exact shield-block probability: upstream's 100-face block roll against the local part outcome — frozen in tests/blow_outcomes.rs, tests/fight.rs (vectors)
- negative controls: the comparison rejects the pre-Stage-2.13 neutral direction and a missing Strikes payload — frozen in tests/blow_outcomes.rs, tests/fight.rs (vectors)
- ${cfg.id}: body part x critical x hit x blow against upstream's core (the part is not in the fight tier) — frozen in tests/blow_outcomes.rs, tests/fight.rs (vectors)

## `test/blowOutcomes.test.js`

**Class:** upstream-oracle — the numbers are frozen in Rust vectors, the live proof is lost
**Rust:** tests/blow_outcomes.rs; the tier merge-key pins: ported_tiers.rs

- 1. both tiers are normalised, and merging conserves probability — frozen in tests/blow_outcomes.rs
- 2. the distribution is the same pipeline as analyze(): its means equal the card, capped and uncapped — frozen in tests/blow_outcomes.rs
- 3a. exact independent branch probabilities: direction, body part, whole, backstab and echo — frozen in tests/blow_outcomes.rs
- 3b. every fight-tier field is either preserved or derivable from the merge key — frozen in tests/blow_outcomes.rs
- 3c. full outcomes keep the finish() shape: the same keys in the same order, all primitive values — frozen in tests/blow_outcomes.rs
- 3. the merge keeps every distinction the fight needs: nothing is merged only because damage matches — frozen in tests/blow_outcomes.rs
- 4. shape: a bow releases StrikeDown, a gun is neutral, caps clip the claim and never the damage — frozen in tests/blow_outcomes.rs
- 5. the sampler: a documented CDF mapping with safe boundaries — frozen in tests/blow_outcomes.rs
- 6. sampling is deterministic, counts its draws, and reproduces the enumerated joint distribution — frozen in tests/blow_outcomes.rs
- 7. the cost of enumeration is bounded and the same inputs give the same distribution — frozen in tests/blow_outcomes.rs
- 8. existing evaluators are untouched by the new module — frozen in tests/blow_outcomes.rs

## `test/bossTraits.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- selection: each boss's traits are the client's relayBossTraits(name, mobile) — lost (oracle)
- selection: the gate and every encounter target carry them — lost (oracle)
- localization: the Warden's traits follow the client's language (an upstream quirk) — lost (oracle)
- resolution: every kind, weapon and trait matches the game's bossStrike — lost (oracle)
- resolution: a resisted blow is max(1, round(d)) and is never reduced twice — lost (oracle)
- resolution: analyze() applies it once, before the per-hit cap — lost (oracle)
- stoneskin: blunt weapons and fists are halved at the Breach, a blade is not — lost (oracle)
- bladeturning: a blade and an arrow are halved, a hammer is not — lost (oracle)
- spellproof: a magic spell is quartered at the Breach; fire is not resisted — lost (oracle)
- frostproof: frost is quartered at the Sky-ketch; magic and fire are full — lost (oracle)
- all three bosses: blunt is halved by stoneskin and magic is quartered where spellproof stands — lost (oracle)
- procs and DoTs are resolved like the spells they are — lost (oracle)
- a weapon's elemental affix is not a spell: no element proof touches it — lost (oracle)
- allowance: resistance is applied before the claim, so the offered rate is the resisted one — lost (oracle)
- ordinary foes and curbing bosses are unchanged — lost (oracle)
- the traits a target carries are the ones analyze uses, with or without an override — lost (oracle)
- imprint pricing: a same-hit multiplier is resolved through the traits, in the game's order — lost (oracle)

## `test/build14631.test.js`

**Class:** local unit/invariant — ported
**Rust:** tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)

- 14631 gear: the flat add range and mean at gear 0 / 250 / 700, no mastery percent — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- 14631 gear: the flat add does NOT scale with the blow (unlike a percent) — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- 14631 gear: the guards - player target, warded, offline, fists — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- 14631 gear: Axe and Blunt share the sword's single climb (the half line is gone) — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- 14631 gear: the theory card at gear 0 / 250 / 700, mean add and exact support — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- 14631 gear: an exhaustive joint card, so a cap inside the spread is clipped per blow — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- 14631 gear: a hit cap inside the spread clips per blow, identical on the card and the tier — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- 14631 gear: sharing the work of equal roll values changes no blow — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- 14631 gear: the fight tier's support IS the add's support (700 gear) — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- 14631 gear: a bow and the off hand keep the widened band — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- 14512 regression: the cut's card numbers still hold (roll 100, NPC target) — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- the default is the live build; only an explicit 14512 selects the cut — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- the brand power prices only on the live build, and an unknown string normalises to it — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- the 14631 cap sheet drops the gear percent, the 14512 sheet is byte-identical — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- an unknown gameBuild prices as the live build (one normalisation point) — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)
- the dist: citations in this file are pinned (rule 1, pin first) — ported → tests/gear_14631.rs (the law) + ported_dist_pins.rs (the citation pin, widened) + zz_dbg.rs (the default-build card pins)

## `test/classicStrength.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_model.rs

- classic: the live /10 and the uninstalled stock /5 — ported → ported_model.rs
- classic: the overhaul Strength path is unchanged — ported → ported_model.rs
- classic: Strength across the range, clamped by the live stat — ported → ported_model.rs
- classic: a two-handed weapon and a bow do NOT double Strength — ported → ported_model.rs
- classic: a low-Strength fist can be negative; a weapon clamps below 1 — ported → ported_model.rs
- classic: the level-based racial adds to the same blow — ported → ported_model.rs
- classic: the cap, traits and allowance still apply around the Strength term — ported → ported_model.rs
- classic: backstab still triples the classic blow and adds its hit term — ported → ported_model.rs
- classic: the stock card has no overhaul condition band or material requirement — ported → ported_model.rs

## `test/cliUsage.test.js`

**Class:** CLI differential — stage 3 snapshots, plus the local pins ported here
**Rust:** ported_cli_usage.rs (exit codes, messages, refusals); the exact stderr bytes: stage 3 snapshots

- an unknown target exits 2 and lists the valid names — stage 3 snapshot + local pins
- an encounter target maps to its real relay body, not the tough reference foe — stage 3 snapshot + local pins
- validation errors exit 2 without a stack — stage 3 snapshot + local pins
- an unknown core exits 2 — stage 3 snapshot + local pins
- --game-build validates and selects the shipped build — stage 3 snapshot + local pins
- --game-build is rejected by every command that does not read it — stage 3 snapshot + local pins
- report threads --game-build into the page — stage 3 snapshot + local pins
- --trials above 1,000,000 exits 2 in objective and loadout --shortlist — stage 3 snapshot + local pins
- numeric flags reject junk instead of silently using the default — stage 3 snapshot + local pins
- enum and name flags reject unknown values with the valid list — stage 3 snapshot + local pins
- help names every accepted target — stage 3 snapshot + local pins
- theory --gear-cs 300 leaves the weapon-skill line at its legal default — stage 3 snapshot + local pins
- an unwritable --out is a usage error on every page command — stage 3 snapshot + local pins
- --out is rejected where the command writes no file — stage 3 snapshot + local pins
- --json is rejected where the command prints no JSON — stage 3 snapshot + local pins
- --json is rejected in the modes that ignore it — stage 3 snapshot + local pins
- compare rejects --all and points at scale --all — stage 3 snapshot + local pins
- help describes --all, --data and compare accurately — stage 3 snapshot + local pins
- commands that read no save run with an empty save folder — stage 3 snapshot + local pins
- probe without a capture fails as a usage error, not a save lookup — stage 3 snapshot + local pins
- an unknown command is reported before any save lookup — stage 3 snapshot + local pins
- a missing or named-away save is a usage error — stage 3 snapshot + local pins
- star channels and a missing spell are usage errors — stage 3 snapshot + local pins
- isUsageFailure keeps internal bugs as crashes — stage 3 snapshot + local pins
- --json writes JSON and nothing else to stdout for every command that supports it — stage 3 snapshot + local pins
- spell --json writes JSON and nothing else to stdout — stage 3 snapshot + local pins

## `test/condition.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_condition.rs

- condition: the percentage is truncated, not floated — ported → ported_condition.rs
- condition: every blade band — ported → ported_condition.rs
- condition: every blunt band — ported → ported_condition.rs
- condition: sharpEdge restores the >75% bands — ported → ported_condition.rs
- condition: the blow is rounded half to even inside the band — ported → ported_condition.rs
- condition: the material does not change the band, only the maximum — ported → ported_condition.rs
- condition: each hand wears its own value — ported → ported_condition.rs
- condition: a bow wears its own condition — ported → ported_condition.rs
- condition: fists do not take a weapon-condition band — ported → ported_condition.rs
- condition: after the critical and the material requirement — ported → ported_condition.rs
- condition: the ×3 backstab is taken before the band — ported → ported_condition.rs
- condition: the Breach allowance claims the worn blow — ported → ported_condition.rs
- condition: wear over time is not simulated — ported → ported_condition.rs

## `test/crossSystem.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- A: shield x long bow x bladeturning arrows x a binding cap — lost (oracle)
- B: injured Berserker (attacker 40%, foe 100%) x loot line x Potent Vs x stoneskin x cap — lost (oracle)
- C: Shadowdancer at Agility 95 (+10 clamps to 100) x off hand x shield x bladeturning x cap — lost (oracle)
- D: the Pistolet pair, each hand: loot % + flat + Potent Vs (off hand whole 80%); the pair is their mean — lost (oracle)
- E: dual wield - the imprint rides the main hand; Potent Vs priced under a backstab — lost (oracle)

## `test/cws.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_cws.rs

- CWS rows keep the item order and resolve a missing record to null — ported → ported_cws.rs
- the Strikes gate: target, damage, ward, whole, item, CWS row — ported → ported_cws.rs
- direct damage is the actual isDamageHealth family (4,0), not the broad local set — ported → ported_cws.rs
- resistance and immunity gates — ported → ported_cws.rs
- reflection: only the first effect reflects, later effects still land — ported → ported_cws.rs
- absorption: career Always and the AbsorbsSpells enchantment — ported → ported_cws.rs
- the fight applies CWS before the melee blow and a CWS kill drops the blow — ported → ported_cws.rs
- the fight gate: a miss, a ward and an off-hand non-whole blow cast nothing — ported → ported_cws.rs
- missing records, zero-damage spells and multiple rows keep their order — ported → ported_cws.rs
- CWS RNG is isolated and deterministic, with or without an injected stream — ported → ported_cws.rs

## `test/cwsCorrections.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors

- F1: the guard reads pre-payload damage, not the post-Potent-Vs formulaPositive — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- payload traversal stops at an unregistered type, including Potent Vs rows after it — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- online school potency, spell power and pierce are applied in the resolver — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- gear potency, Arcane Surge and Magnus's Gaze feed the resolver inputs — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- F4: a multi-effect cast stops counting after the target dies — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- F5: an echo kill suppresses the melee blow and its accounting — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- D1: the equipped list is read once, by slot/content, not by object identity — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- C1: a live snapshot clone and the caller's scenario weapon are ONE equipped piece — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- C2: a what-if main-hand weapon REPLACES the worn main hand — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- C2b: main and off hand are overlaid independently, one piece per hand — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- C5: a Legendary record counts once, as its power does (countedPieces) — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- C6: distinct pieces are never collapsed by their content — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- C7: a scenario weapon replaces ITS hand, never a content-identical piece in the other hand — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- C7b: the off hand overrides its own piece; both hands can be overridden — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- C7c: a duplicated Legendary across the hands counts at the LOWEST slot, as upstream orders the table — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- C7d: a clone of a slotless worn piece is still one piece — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- C8: the equip table reads in SLOT order, so a duplicated Legendary keeps its lowest slot — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- D2: a build without `worn` is rejected instead of reading the whole inventory — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- S1: the ordinary-target contract refuses relay/boss/cap shapes and accepts the ordinary constructors — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- Arcane Surge reads the LIVE maximum magicka; a declared base adds the ExtraSpellPts fold once — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- C4: ExtraSpellPts gear alone does not refuse an ordinary fight — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- C4b: a declared-base Surge build without the fold is refused; a save-derived live value is not — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- the potency cap and the rounding are the upstream floors — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- the caster level reaches the CWS magnitude — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- a killing CWS row stops later rows — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors
- a CWS kill suppresses the echo as well as the melee — ported → ported_cws.rs (the gates and family checks); the equipped-piece identity cases: tests/cws.rs vectors

## `test/cwsDifferential.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- CWS direct damage: local resolver and upstream applySpell agree on damage and draws — lost (oracle)
- CWS resistance: career tolerance, immunity, spell resistance and elemental resistance — lost (oracle)
- CWS absorption: the career and the AbsorbsSpells enchantment — lost (oracle)
- CWS reflection: only the first effect reflects, later effects still land — lost (oracle)
- CWS family boundary: only isDamageHealth (4,0) is direct damage — lost (oracle)
- CWS trigger matrix: upstream call/no-call and the local gates agree — lost (oracle)
- CWS multiple rows: upstream walks them in item order — lost (oracle)
- CWS kill: upstream order is CWS then blow, and the host gate drops the blow — lost (oracle)
- F1: upstream guard, blowFightTier and simulateFight agree on Potent Vs misses and Low Damage Vs zeroing — lost (oracle)
- payload walk: cwsRows/payloadRows/strikesNet match the vendored abort — lost (oracle)
- spell power, pierce and online school potency match upstream applySpell — lost (oracle)
- gear potency, Arcane Surge and pierce inputs match the vendored loot law — lost (oracle)
- multi-effect death: local applied damage equals upstream hurt, not out.damage — lost (oracle)
- echo kill: upstream hurtFoe and the local fight both drop the melee blow — lost (oracle)
- fight-level CWS: TTK agrees with the upstream host fight (main hand, gear potency) — lost (oracle)
- fight-level CWS: the fixed-horizon damage and CWS share agree with the upstream host fight — lost (oracle)
- fight-level CWS: the kill-source split (CWS / Many Endings / melee) agrees with the upstream host fight — lost (oracle)
- fight-level CWS on the OFF hand agrees with the upstream host fight — lost (oracle)
- online school potency matches the upstream schoolPotency branch on the `_online` entity — lost (oracle)

## `test/defaultBuild.test.js`

**Class:** CLI differential — stage 3 snapshots, plus the local pins ported here
**Rust:** tests/gear_14631.rs (the default build) + ported_cli_usage.rs (--game-build); the page digests: stage 3 snapshots

- no --game-build is an explicit 14631 run, for every command that reads the flag — stage 3 snapshot + local pins
- an explicit 14512 reproduces the pre-flip output byte for byte — stage 3 snapshot + local pins
- the two builds really differ on a weapon card and on the theory sheet, so the checks are not vacuous — stage 3 snapshot + local pins
- a direct library call with no key is the live build; only an explicit 14512 is the cut — stage 3 snapshot + local pins

## `test/differential.test.js`

**Class:** upstream-oracle — the numbers are frozen in Rust vectors, the live proof is lost
**Rust:** tests/model_blow.rs, tests/target.rs (vectors)

- stage: critical model (chance, to-hit bonus, damage multiplier) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: hit chance, exact expectation over the body-part table — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: weapon damage roll, range and mean (overhaul) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: a weapon elemental affix lands once, at the loot step (C5) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: Strength damage modifier (overhaul /10; classic live /10 and stock /5) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: classic Strength end-to-end (damage range) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: weapon type, handedness and swing handling — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: proficiency and racial modifiers on every arm — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: target intrinsic hide and natural resistance — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: target natural resistance from a career stat block — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: weapon material to-hit term — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: swing law (frame seconds) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: real hit resolution, sampled through the game's own roll code — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: material requirement and target hide end-to-end (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: worn armour material and condition — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: worn armour and blocking-shield reduction rows — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: shield block chance and the under-armour comparison — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: enemy armour values from the worn pieces — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: the game's own enemy loadout is worn by the target — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: worn armour and shield end-to-end (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: enemy-type bonus and phobia by the target career group — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: foe group classification (affinity vs career) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: silver, skeletal and the enemy-type bonus in the weapon blow — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: the Skeletal Warrior 0x10 weapon-flag exception — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: silver and enemy-type end-to-end against real foes (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: the gate boss uses its body level for the enemy-type bonus — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: backstab damage roll (x3 gate and threshold) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: backstab hit bonus and x3 mixture (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: backstab off-hand (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: backstab ranged (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: backstab with worn armour, traits and the cap (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: weapon condition bands (integer percentage) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: weapon condition end-to-end (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: weapon condition off-hand and ranged (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: weapon condition with armour, traits and the cap (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: racial modifiers (overhaul and classic) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: racial end-to-end (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: racial with backstab, condition, armour, traits and the cap (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: racial off-hand (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: spell career tolerance and saving chance — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: saving lands and career tolerance are the game's own — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: material ordering with critical and condition (sampled) — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: boss trait resistance factors — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: the boss stand-in is the game's body — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: curbing is the game's 5% share — frozen in tests/model_blow.rs, tests/target.rs (vectors)
- stage: the per-hit cap constant is the relay's HIT_CAP_X x dpsRef — frozen in tests/model_blow.rs, tests/target.rs (vectors)

## `test/dotDifferential.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- DoT: the first tick lands inside the cast and the entry is left at rounds - 1 — lost (oracle)
- DoT: the draws one tick consumes match the oracle — lost (oracle)
- DoT: durationBase 3 bills three rounds over the cast and two passes, and the pass after removes silently — lost (oracle)
- DoT: every tick re-rolls its own magnitude and save — lost (oracle)
- DoT: a re-cast of a live incumbent renews its rounds and adds no tick (never a stack) — lost (oracle)
- DoT: a re-cast over a lapsed incumbent runs the round the cast would have run — lost (oracle)
- DoT: two different DoT spells merge into the incumbent, which keeps its own settings — lost (oracle)
- DoT: the expiry pass bills nothing — lost (oracle)
- DoT: a round under spell power and pierce matches the oracle, round by round — lost (oracle)

## `test/dotFight.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_dot_fight.rs

- DoT fight: a round after the spell has already killed bills nothing — ported → ported_dot_fight.rs
- DoT fight: rounds that fall after the last blow are billed — ported → ported_dot_fight.rs
- DoT fight: the health segments carry the round damage too — ported → ported_dot_fight.rs
- DoT fight: a second trial with the same seed fights the same fight (no effects carried over) — ported → ported_dot_fight.rs
- DoT fight: every round is accounted in cwsDamage and the traces reconcile with the health drops — ported → ported_dot_fight.rs
- DoT fight: rounds fall on the 5 s fight clock, and the cast bills its own round at its own time — ported → ported_dot_fight.rs
- DoT fight: a round that kills ends the cast, applies no later effect, and names the DoT — ported → ported_dot_fight.rs
- DoT fight: at an equal timestamp the blow resolves before the round — ported → ported_dot_fight.rs

## `test/dualWield.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- law: the constants and per-hand terms are the game's own — lost (oracle)
- schedule: a pair makes two blows per eight ticks, one weapon one per five — lost (oracle)
- schedule: matches the game's machine, blows a second, for four weapons and three frame rates — lost (oracle)
- model: a matched pair at low accuracy lands the pinned ~9% edge, not 80% — lost (oracle)
- model: with no accuracy penalty the pair is exactly (1 + 0.8) / (8/5) — lost (oracle)
- model: each hand is its own blow - damage, accuracy, crit and traits — lost (oracle)
- model: a heavy off weapon slows the exchange through its burden, not its stats — lost (oracle)
- elemental affixes: each hand's own, once, and the off hand's at its share — lost (oracle)
- procs: the main hand fires every landed blow, the off hand at 0.8 weight — lost (oracle)
- C1: each hand is its own time-ordered claim at the Breach — lost (oracle)
- C2: a boss trait resolves each hand's own blow — lost (oracle)
- single weapon and two-handed weapons are untouched — lost (oracle)

## `test/durability.test.js`

**Class:** upstream-oracle — the numbers are frozen in Rust vectors, the live proof is lost
**Rust:** tests/durability.rs (vectors); the named wear assertions are not ported

- wear: the exact DFU amount, the 20% floor roll and its draw count match damageEquipment — frozen in tests/durability.rs (vectors)
- break: lowerCondition clamps, unequips by identity and clears owner.weapon; no condition cannot break — frozen in tests/durability.rs (vectors)
- CWS bill: 10 per row after the cast, paid for a missing record, zeroed by spareGear, and a break between rows — frozen in tests/durability.rs (vectors)
- the fight wears the striking weapon, breaks it at the same point, and the current blow still lands — frozen in tests/durability.rs (vectors)
- an ordinary-wear break unequips the hand and is not the CWS bill's doing — frozen in tests/durability.rs (vectors)
- the survivor's own powers and health thresholds replace the broken weapon's — frozen in tests/durability.rs (vectors)
- a main-hand break promotes the surviving off hand; an off-hand break leaves the main hand — frozen in tests/durability.rs (vectors)
- a surviving higher-slot Legendary copy counts after the hand copy breaks — frozen in tests/durability.rs (vectors)
- a slot-21 shield keeps its potency after the main hand breaks — frozen in tests/durability.rs (vectors)
- repeated breaks refresh every row from the current table — frozen in tests/durability.rs (vectors)
- both weapon hands breaking ends the fight after the current blow — frozen in tests/durability.rs (vectors)
- a break on the build's own worn weapon leaves the caller's items unchanged — frozen in tests/durability.rs (vectors)
- repeated same-seed trials share no durability state — frozen in tests/durability.rs (vectors)
- a wear-break before the CWS payload refreshes potency for that same cast — frozen in tests/durability.rs (vectors)
- a CWS bill break refreshes the next row's spell power; the payload still continues — frozen in tests/durability.rs (vectors)
- a broken weapon's pierce is gone from the next cast — frozen in tests/durability.rs (vectors)
- a broken weapon's Arcane Surge is gone from the next cast — frozen in tests/durability.rs (vectors)
- an off-hand wear-break refreshes the off-hand cast's power — frozen in tests/durability.rs (vectors)
- a break on the first of three rows still walks and bills the later rows — frozen in tests/durability.rs (vectors)
- the broken item leaves the spell-power table; the survivor's potency is the only one counted — frozen in tests/durability.rs (vectors)
- multiple CWS rows: a break between rows does not skip the later row; both cast and both pay — frozen in tests/durability.rs (vectors)
- a resisted, absorbed or Continuous Damage cast still pays its 10 — frozen in tests/durability.rs (vectors)
- absorbed and zero-magnitude casts still pay; a zero-damage blow pays and wears nothing — frozen in tests/durability.rs (vectors)
- the fight draws the 20% floor roll from the injectable condition stream — frozen in tests/durability.rs (vectors)
- a condition band crossing rebuilds the next blow's tier; a frozen piece cannot wear or break — frozen in tests/durability.rs (vectors)
- a content-identical hand item is not removed by the other hand's break — frozen in tests/durability.rs (vectors)
- ordinary wear uses the PRE-payload damage (Potent Vs adds to the blow, not to the wear) — frozen in tests/durability.rs (vectors)
- durability changes only the fight's clones, and the same seed replays exactly — frozen in tests/durability.rs (vectors)
- the fight's wear/bill/break state matches upstream replayed on its own damage sequence — frozen in tests/durability.rs (vectors)
- a lone broken weapon has no Many Endings echo (no surviving same-ID piece); the current blow's damage (and Flow) survives — frozen in tests/durability.rs (vectors)

## `test/durabilityAccounting.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- G3: every row of a blow is billed after a killing cast; the cast itself is not repeated — lost (oracle)
- G3: bills after the kill can break the weapon; the kill still wins and nothing else lands — lost (oracle)
- G3: a kill with no later row is the control; a kill on the last row bills exactly what it did before — lost (oracle)
- G3: bills are paid only for the rows the Strikes gate walks (not for a miss, a zero blow or an off-hand non-whole blow) — lost (oracle)
- G3: durability off keeps the original walk - the later rows after a kill leave no trace and no bill — lost (oracle)
- G3: spareGear zeroes every bill, killing row or not; the ordinary-foe fight refuses such a target — lost (oracle)
- G2: the aggregates have the stated denominators, censoring and counting (hand-built rows) — lost (oracle)
- G2: killed, no-weapon-left and horizon-censored fights are separate counts that partition the trials — lost (oracle)
- G2: break probability, time to first break and end condition through simulateFights — lost (oracle)
- G2: durability off reports no durability block and an all-zero no-weapon count; `outcomes` still partitions — lost (oracle)
- G2: paired seeds and dual wield aggregate per build, hand by hand — lost (oracle)
- G2: each fight has exactly one end reason, in the loop's own priority — lost (oracle)
- G6: procsBeforeBreak is the bill-only capacity, same value, labelled as such — lost (oracle)
- G6: the bound is not a cast count (upstream, no wear): the exhausting cast is real and not in floor(cond / 10) — lost (oracle)
- G6: ordinary wear makes the bound overstate the casts a real weapon gets before it breaks — lost (oracle)
- G6-1: both public JSON emitters carry procsBeforeBreak and its basis, and they agree — lost (oracle)
- G3: an unregistered row after the killing row aborts the walk exactly where upstream does — lost (oracle)
- G3: a missing CWS record is processed and billed after a kill, and before one, but never cast — lost (oracle)
- G2: when every trial breaks there is no unbroken fight at risk: timeAtRiskWithoutBreak is null — lost (oracle)
- G2: the blow budget and the horizon reached together are reported as the blow budget; each alone as itself — lost (oracle)
- G2: paired builds with different weapons each fight with their own equipment — lost (oracle)
- G2: breaks by bills after a kill count in the break probability, the first-break time and the distinct events — lost (oracle)
- G2-1: a weapon supplied at zero condition is not a weapon lost; its break reports are repeats — lost (oracle)
- G2-1: weaponsBroken equals the distinct break reports of every fight (the reconciliation law) — lost (oracle)

## `test/echoDuplicate.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- G5: main striker breaks; the off hand with the same echo ID keeps the echo — lost (oracle)
- G5: off-hand striker breaks; the main hand with the same echo ID keeps the echo — lost (oracle)
- G5: a broken striker with no echo on the survivor suppresses the echo; trace shows no event — lost (oracle)
- G5: a what-if-only echo on the striker is not resurrected by an item on the survivor — lost (oracle)
- G5: no-break duplicate-ID control keeps the echo — lost (oracle)
- G5: a no-break blow keeps the striking weapon's echo even when the other hand has none — lost (oracle)
- G5: with two echo powers, only the surviving same-ID echo remains eligible — lost (oracle)
- G5: upstream and local agree on which breaking blows still echo (event presence only) — lost (oracle)

## `test/elemental.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- once: +3/+6/+10 add exactly their value to every roll, not twice it — lost (oracle)
- once: the flat is inside the blow, so a critical multiplies it (once) — lost (oracle)
- scaling: mastery does not scale the flat, the martial path and the Firmament do (once) — lost (oracle)
- upstream: the increment equals lootBlow's own addition for every element and value — lost (oracle)
- a bow and a blunt weapon add it once too (a long bow's pull scales it once) — lost (oracle)
- an off-hand blow takes its share of the (single) flat — lost (oracle)
- Hand Wraps carry one addition onto the fist blow — lost (oracle)
- C2: a boss trait resolves the whole blow once - the affix is not quartered as a spell — lost (oracle)
- a spell, a proc and a DoT are separate from the affix — lost (oracle)
- C1: the allowance receives the corrected claim, once — lost (oracle)
- a weapon with no affix is unchanged by any of this — lost (oracle)

## `test/enchantPlan.test.js`

**Class:** local unit/invariant — NOT ported (gap)
**Rust:** tests/enchant_plan.rs vectors only

- a two-handed weapon has no shield, a one-handed one does — not ported (gap)
- base budgets are the template points, and the soul gem adds 5,000 to each — not ported (gap)
- no piece spends past its budget, its item cap, or repeats one setting — not ported (gap)
- the one-piece effects are placed on one piece, and skills stack across pieces — not ported (gap)
- strike procs respect the weapon condition over the gate fight — not ported (gap)
- strike enchantments only sit on the weapon — not ported (gap)
- the plan names the carried baseline beside the card plan figures — not ported (gap)
- the weapon-type matrix prices every family on its best weapon — not ported (gap)

## `test/enchants.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_enchants.rs

- EnhancesSkill is +15 per row, on top of the softcap — ported → ported_enchants.rs
- Cast When Strikes prices the spell and adds its DPS to the weapon — ported → ported_enchants.rs
- Potent Vs is a flat +5 on the matching affinity only — ported → ported_enchants.rs
- a weapon with no enchantments adds nothing — ported → ported_enchants.rs
- a Cast When Strikes DoT is priced per tick, not as its whole duration every hit — ported → ported_enchants.rs

## `test/enemyType.test.js`

**Class:** upstream-oracle — the numbers are frozen in Rust vectors, the live proof is lost
**Rust:** tests/target.rs (the enemy-type vectors)

- enemy-type: the bonus reads the career group, not the affinity — frozen in tests/target.rs (the enemy-type vectors)
- enemy-type: a bonus or phobia only decodes for its own group — frozen in tests/target.rs (the enemy-type vectors)
- enemy-type: the Undead bonus is a per-blow range at 100 Willpower — frozen in tests/target.rs (the enemy-type vectors)
- enemy-type: Willpower and the target level set the range — frozen in tests/target.rs (the enemy-type vectors)
- enemy-type: a phobia is the fixed target-level penalty, never a roll — frozen in tests/target.rs (the enemy-type vectors)
- silver: the six doubled careers and material 2 only — frozen in tests/target.rs (the enemy-type vectors)
- silver: the Skeletal Warrior halves every weapon, then doubles silver — frozen in tests/target.rs (the enemy-type vectors)
- silver: it doubles the roll and the damage modifiers, not Strength/material — frozen in tests/target.rs (the enemy-type vectors)
- silver: an elemental affix is added after the double, once — frozen in tests/target.rs (the enemy-type vectors)
- silver: critical, material requirement and the target defence follow it — frozen in tests/target.rs (the enemy-type vectors)
- silver: ranged and off-hand weapons use the same stage — frozen in tests/target.rs (the enemy-type vectors)
- Ranger: Hunter’s Instinct reads foeGroup, not the career group — frozen in tests/target.rs (the enemy-type vectors)
- Ranger: the 20% lands on the blow, after the enemy-type bonus — frozen in tests/target.rs (the enemy-type vectors)
- integration: the bonus and silver are in the blow before armour, traits and the cap — frozen in tests/target.rs (the enemy-type vectors)
- integration: the gate’s body level is used for a Daedra bonus — frozen in tests/target.rs (the enemy-type vectors)
- integration: a flagless reference foe is unchanged and exposes a zero bonus — frozen in tests/target.rs (the enemy-type vectors)

## `test/equippedBuild.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. the local power table is the game's: every imprint record agrees with powerOf(id) on the fields it states — lost (oracle)
- 2. equipped == with(edit): every power kind, every configuration, exactly — lost (oracle)
- 2b. equipped == with(edit) across the supported hold configurations — lost (oracle)
- 2c. Potent Vs / Low Damage Vs: equipped rows == with({ potentVs }), matched by the foe's AFFINITY — lost (oracle)
- 2d. modifiers compose: an imprint + Potent Vs + a slayer line + a loot what-if on one item equal the chained edits — lost (oracle)
- 3. equipped Legendary powers and imprints match upstream's worn-item blow — lost (oracle)
- 4. equipped Potent Vs / Low Damage Vs match upstream, a miss included, with trait and cap — lost (oracle)
- 5. several modifiers on one worn item: flow + Potent Vs + a slayer and an elemental line, with a trait and a cap — lost (oracle)
- 6. the pre-2.11a behaviour is rejected: an equipped power was ignored, a Potent Vs was priced outside the blow — lost (oracle)
- 7. there is no second damage formula for an imprint: the allowance reads the imprinted card — lost (oracle)

## `test/fight.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. axe and blunt mastery across the half line equal upstream's own weaponPastPct, exactly — lost (oracle)
- 2. venom is doubled below the half line - each share against the worn-item blow — lost (oracle)
- 3. execute around its threshold (Sweet Mother's Kiss: below 25%) — lost (oracle)
- 4. the attacker-health effects do not move with the foe's health (rage and Berserker) — lost (oracle)
- 5. the thresholds compose with critical hits, the trait and the cap — lost (oracle)
- 6. a whole fight where the health really falls: the walk against a seeded blow-by-blow — lost (oracle)
- 7. a fight what-if is the equipped item: an execute priced equals the item carrying it — lost (oracle)

## `test/fightDifferential.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. single-melee fight distribution matches upstream — lost (oracle)
- 2. dual-wield fight distribution and hand schedule match upstream — lost (oracle)
- 3. a venom half-health fight rebuilds at half and matches upstream — lost (oracle)
- 4. an ordinary-foe echo fight matches upstream — lost (oracle)
- 5. health thresholds: the venom 0.5 and execute 0.25 boundaries match upstream at the exact share — lost (oracle)

## `test/firmament.test.js`

**Class:** upstream-oracle — the numbers are frozen in Rust vectors, the live proof is lost
**Rust:** tests/firmament.rs, tests/firmament_prices.rs

- a firmament plan is a valid path, and stops before spending free points — frozen in tests/firmament.rs, tests/firmament_prices.rs
- the long-blade plan fills the weapon blow group cap — frozen in tests/firmament.rs, tests/firmament_prices.rs
- the destruction plan fills the spell-cost group cap — frozen in tests/firmament.rs, tests/firmament_prices.rs
- a star budget is respected and every build returns a plan — frozen in tests/firmament.rs, tests/firmament_prices.rs
- the same build and budget give the same tree — frozen in tests/firmament.rs, tests/firmament_prices.rs
- a persisted plan rehydrates to the same tree and totals — frozen in tests/firmament.rs, tests/firmament_prices.rs
- the damage plan does not buy unaware, rage or backstabbing channels — frozen in tests/firmament.rs, tests/firmament_prices.rs
- flat and percent points share one +15 channel — frozen in tests/firmament.rs, tests/firmament_prices.rs

## `test/firmamentBlow.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)
**Rust:** the live firmamentPowers blow hook needs the vendored tree

- ORACLE: live Firmament blows on a held weapon carry; a warded blow does not spend the carry — lost (oracle)

## `test/flowDifferential.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- Flow: stacks, strict expiry, refresh and cap agree with lootStrike — lost (oracle)

## `test/flowState.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_relay.rs

- Flow clock: strict expiry, cap, whole and eligibility gates — ported → ported_relay.rs
- Flow stacks are applied through the existing blowFightTier option — ported → ported_relay.rs

## `test/gearLines.test.js`

**Class:** upstream-oracle — the numbers are frozen in Rust vectors, the live proof is lost
**Rust:** tests/gear.rs (vectors)

- 1. socket counts are upstream's for every weapon template — frozen in tests/gear.rs (vectors)
- 2. differential: 400 seeded items - stats and skills (affixFold), weapon damage (affixWeaponDamage) — frozen in tests/gear.rs (vectors)
- 3. differential: slayer and elemental through lootBlow - per line, repeats summed, invalid ignored, gem cap — frozen in tests/gear.rs (vectors)
- 4. the +25% cap: three perfect diamonds read 25, not 36; the piece's own damage line reads whole — frozen in tests/gear.rs (vectors)
- 5. invalid and unsupported lines are handled as upstream handles them — frozen in tests/gear.rs (vectors)
- 6. representative builds through the whole blow match upstream's worn-item blow (1H, 2H, dual hands) — frozen in tests/gear.rs (vectors)
- 7. the max profile reads its three diamonds through the cap — frozen in tests/gear.rs (vectors)

## `test/gearProfile.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_gear_profile.rs

- the model reads the game's bands, counts and Exalted floor (upstream law) — ported → ported_gear_profile.rs
- a rolled line follows skillKin; the Exalted skill line does not (pre-fix: the old model kin-filtered it) — ported → ported_gear_profile.rs
- a piece can carry both skills at 20, never both at 30 (one Exalted line, one kind) — ported → ported_gear_profile.rs
- every record's Exalted skill capacity matches the game's "kind not carried" law — ported → ported_gear_profile.rs
- the old 240 / 540 / 780 profile is not reachable (pre-fix: the max profile assumed it) — ported → ported_gear_profile.rs
- the per-skill and point budgets are level-independent; only the loot gate is level-dependent — ported → ported_gear_profile.rs
- validatePlan rejects illegal allocations clearly — ported → ported_gear_profile.rs
- a generated max profile is legal, complete and the best uncapped point (pre-fix: it used 240/540/40) — ported → ported_gear_profile.rs
- scenario maxima remain legal; the allowance split is distinct — ported → ported_gear_profile.rs
- a shield is a distinct legal scenario: one more armour slot — ported → ported_gear_profile.rs
- single-weapon, dual-wield and fist builds keep the legal budget (C3/C1 unchanged) — ported → ported_gear_profile.rs
- the damage mechanics are untouched: only the budget changed — ported → ported_gear_profile.rs
- the gate still sits on the relay allowance, not the uncapped profile (C1) — ported → ported_gear_profile.rs

## `test/golden-upstream.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- golden (combatStats.test.js:67-80): strength term, longsword range, swing table, four foes — lost (oracle)
- golden (combatStats.test.js:82-98): fists, bows and the classic critical model — lost (oracle)
- golden (pcaao.test.js:80): unityRound is half-to-even — lost (oracle)
- golden (pcaao.test.js:86-87): damage modifiers and the material to-hit term — lost (oracle)
- golden (pcaao.test.js:134): the struck body-part table — lost (oracle)
- golden (pcaao.test.js:157-160): the critical-strike thresholds — lost (oracle)
- golden (pcaao.test.js:184-192): weapon blow arithmetic, two-handed and bows — lost (oracle)
- golden (pcaao.test.js:207-210): condition bands — lost (oracle)
- golden (twohands.test.js:145-183): dual-wield constants, the exchange and the pinned ratios — lost (oracle)
- golden (bowbloom.test.js:12-14, 61-63, 90-99): the bow laws — lost (oracle)
- golden (powerceiling.test.js:86-95): the blow and guard ceilings — lost (oracle)
- golden: the Breach constants the relay publishes — lost (oracle)
- golden: expectedCapped is the mean of a clamped uniform roll — lost (oracle)
- golden (enemyExpansion/mudex1.test.js:61-73): the MUDEX rows a foe is minted from — lost (oracle)

## `test/harness.test.js`

**Class:** tooling — delete

- prng: same seed, same stream; different seeds differ — delete
- prng: uniform enough - mean, deciles and low-bit balance — delete
- summary: mean and a 95% interval that narrows with n — delete
- compare: exact equality is bit-for-bit; tolerance is explicit and scaled — delete
- compare: the first divergence is reported with a path — delete
- runStage: discrepancy report names the input, both answers and the divergence point — delete
- runStage: a stale waiver fails instead of passing silently — delete
- an intentionally introduced discrepancy is detected end to end — delete
- sampled comparison: an expectation inside the confidence interval passes, outside fails — delete

## `test/imprintLifetime.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- G4: upstream - an imprint is read from the worn item and leaves with it — lost (oracle)
- G4: a priced imprint rides the breaking blow and dies with the main-hand carrier — lost (oracle)
- G4: a priced potentVs rides the breaking blow and dies with the main-hand carrier — lost (oracle)
- G4: a priced loot flat rides the breaking blow and dies with the main-hand carrier — lost (oracle)
- G4: an off-hand break leaves the priced edits on the surviving main hand — lost (oracle)
- G4: a priced execute imprint is in the thresholds before the carrier breaks and gone after — lost (oracle)
- G4: an equipped imprint on the surviving hand is its own item and stays — lost (oracle)
- G4: character-level scenario inputs survive the carrier break (potency/pierce are not carrier-bound) — lost (oracle)
- G4: character-level flowStacks survives the carrier break (guards against stripping adjacent fields) — lost (oracle)
- G4 limitation: priced CWS spell-power edits remain unsupported (separate from the carrier fix) — lost (oracle)

## `test/imprints.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_imprints.rs

- imprint eligibility is the Weapons group, then the power's own fit — ported → ported_imprints.rs
- a power is priced both unconditionally and under its trigger — ported → ported_imprints.rs
- the long-blade ranking keeps every weapon power, read on a long blade — ported → ported_imprints.rs
- Silent Death is a double only away from the gate, where its trigger can occur — ported → ported_imprints.rs
- the boss ranking reflects the gate cap, not the uncapped ceiling — ported → ported_imprints.rs
- the carried metric keeps the card's imprint order on every family fixture — ported → ported_imprints.rs
- every family returns rows and a base weapon — ported → ported_imprints.rs
- the gate boss is a daedra, and Serpent's Kiss is flat poison before the cap — ported → ported_imprints.rs
- the per-hit cap is per player; the health pool scales with the group — ported → ported_imprints.rs
- Many Endings rides the blow's claim on a relay body, and is its own hit on an ordinary foe — ported → ported_imprints.rs
- moon adds both night and animal shares, and chain/quake are other-target only — ported → ported_imprints.rs
- every weapon imprint has a live power and a readable effect — ported → ported_imprints.rs

## `test/integration.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. one blow carrying every 2.11a/2.11b change at once matches upstream, value by value — lost (oracle)
- 2. equipped == priced, exactly, across configurations and edits; an edit never moves the base — lost (oracle)
- 3. the ordinary-foe arm of Many Endings: with a foe record the echo is its own hit, nothing is owed — lost (oracle)
- 4. no regression in the Stage 2.9 corrections the composition touches — lost (oracle)

## `test/invariants.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_invariants.rs (11 of 13; the two oracle cases lost)

- invariant: a hit is never certain and never hopeless (3..97) — ported → ported_invariants.rs (11 of 13; the two oracle cases lost)
- invariant: damage ranges are ordered and non-negative — ported → ported_invariants.rs (11 of 13; the two oracle cases lost)
- invariant: the per-hit cap never increases DPS and binds only above it — ported → ported_invariants.rs (11 of 13; the two oracle cases lost)
- invariant: skill boundaries 100 / 125 / 200 read as the game reads them — ported → ported_invariants.rs (11 of 13; the two oracle cases lost)
- invariant: an attribute stops at 100 unless a stat-max channel lifts it (115) — ported → ported_invariants.rs (11 of 13; the two oracle cases lost)
- invariant: the Breach pool, cap and phase shields are the relay's numbers — ported → ported_invariants.rs (11 of 13; the two oracle cases lost)
- invariant: no build beats the Breach refill rate for long (C1) — ported → ported_invariants.rs (11 of 13; the two oracle cases lost)
- invariant: a blow over the cap is clipped, and the clip is reported — ported → ported_invariants.rs (11 of 13; the two oracle cases lost)
- invariant: condition thresholds (the bands that change the blow) — ported → ported_invariants.rs (11 of 13; the two oracle cases lost)
- invariant: PvE spells never crit and the cast recovery is the throughput floor — ported → ported_invariants.rs (11 of 13; the two oracle cases lost)
- invariant: every damage path reports finite numbers (no stub or NaN leak) — ported → ported_invariants.rs (11 of 13; the two oracle cases lost)
- invariant: the Strength term is /10 (overhaul) everywhere it is used — ported → ported_invariants.rs (11 of 13; the two oracle cases lost)
- invariant: the simulator never claims a value the vendored oracle contradicts on the per-hit core — ported → ported_invariants.rs (11 of 13; the two oracle cases lost)

## `test/loadoutShortlist.test.js`

**Class:** CLI differential — stage 3 snapshots, plus the local pins ported here
**Rust:** ported_cli_usage.rs (its nine usage refusals); the sampled rows: stage 3 snapshots + tests/planner_shortlist.rs

- invalid shortlist options exit 2 — stage 3 snapshot + local pins
- shortlist off leaves the default table and HTML bytes alone — stage 3 snapshot + local pins
- shortlist preserves the build and imprint, and samples candidates on common seeds — stage 3 snapshot + local pins
- a sampled row runs under the same swing law as its deterministic row (rri, overhaul core) — stage 3 snapshot + local pins
- capped CLI shortlist uses the relay target and keeps its sampling metadata — stage 3 snapshot + local pins
- --health sets the sampled pool; the default 100-point foe kills in one blow and ties — stage 3 snapshot + local pins
- uncapped CLI prints the sampled and deterministic rankings side by side — stage 3 snapshot + local pins

## `test/longBow.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- long bow: the pull sits after the finished blow - outcome by outcome against upstream — lost (oracle)
- long bow: per-swing means (crits included) against upstream, and the controls are untouched — lost (oracle)
- long bow: the card shows the pulled blow, the rolls stay the card's own — lost (oracle)

## `test/lootCarry.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. a held item carries the loot share: 25% slayer, one remainder, misses do not advance it — lost (oracle)
- 2. slayer + bane are ONE carried share; mastery then loot are TWO independent remainders — lost (oracle)
- 3. the martial path carries its own remainder — lost (oracle)
- 3b. LOCAL: the long-run carried Firmament mean converges to the exact share — lost (oracle)
- 4. the estimate path is untouched: `carried` never consumes a fight remainder — lost (oracle)
- 5. default seeded fights match the held-item oracle; carry:false still floors — lost (oracle)
- 6. explicit carry:false preserves the original seeded floor stream — lost (oracle)
- 7. default sampled relay matches the vendored held-item damage per scheduled attack — lost (oracle)
- 8. a base of 0 stays 0 under carry:true: the elemental flat is not added on a damage <= 0 blow — lost (oracle)

## `test/lootCarryCombos.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. dual wield: each hand keeps its OWN remainder (per item), checked blow for blow against the vendored lootBlow — lost (oracle)
- 2. backstab: x3 follows the percentage channels; carried and floor tiers match mean damage and backstab share with no percentage line — lost (oracle)
- 3. durability break: the broken hand is unequipped, the survivor leads with its own remainder, no throw (LOCAL only) — lost (oracle)
- 4. CWS beside carried percentage lines: casts do not touch the carry; the melee stream is the same with and without the row (LOCAL) — lost (oracle)

## `test/manyEndings.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. the echo rides the blow's claim on a relay body, value by value (chance 100) — lost (oracle)
- 2. the same with the natural 10% (the oracle's dice seeded), and the old independent hit rejected where the cap binds — lost (oracle)
- 3. the cap clips the blow and its echo together; a build without the power is untouched — lost (oracle)

## `test/memCap.test.js`

**Class:** tooling — delete

- parseSize reads G, M, K and bare MiB numbers, and refuses anything else — delete
- default split: 32 GiB and 16 cores give 8 workers of 2 GiB, inside half of RAM — delete
- default drops workers until each share is at least MIN_CAP — delete
- workers times cap never exceeds half of RAM, across a grid of machines — delete
- an explicit --max-mem sets the cap and fits the workers into the budget — delete
- an explicit --jobs and --max-mem that break the budget are refused, not changed — delete
- an explicit --jobs whose share is under MIN_CAP is refused unless --max-mem is given — delete
- --no-mem-cap plans no cap — delete
- wrap: systemd sets MemoryMax, no swap, and the OOM score; prlimit sets RLIMIT_DATA; none is a no-op — delete

## `test/model.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_model.rs

- strength terms: classic /5, overhaul /10 — ported → ported_model.rs
- classic longsword, STR 80: /10 live, /5 when the overhaul is uninstalled — ported → ported_model.rs
- overhaul longsword: strength is /10; two-handed doubles it — ported → ported_model.rs
- the source stats-card fixture: STR 66 steel longsword in the overhaul — ported → ported_model.rs
- swing cadence: Speed 50 is one second, Speed 100 ~0.6s — ported → ported_model.rs
- cadence reads weapon weight and handling — ported → ported_model.rs
- reference foes: armour is 5x, class foes flat 60 — ported → ported_model.rs
- curbing is the uniform mean of min/max clipped at the cap — ported → ported_model.rs
- effectiveSkill: 100 -> 100, 125 -> 107, 200 -> 140 — ported → ported_model.rs
- online mastery: a mastered Long Blade at 107 plus 20 gear skill — ported → ported_model.rs
- the curbing cap only binds below 20x the per-hit — ported → ported_model.rs
- a live equip table is the authority over the saved items and the _mods cache — ported → ported_model.rs
- the real gate boss: 8,400 HP, plate 60, 420 hit cap, two 3s shields at level 30 — ported → ported_model.rs
- backstab: 99% x3, and the gate group health — ported → ported_model.rs
- DPS carries a min/avg/max range, and the average sits inside it — ported → ported_model.rs

## `test/objectiveCli.test.js`

**Class:** CLI differential — stage 3 snapshots, plus the local pins ported here
**Rust:** ported_cli_usage.rs (its six usage refusals and the name list); the text and JSON rows: stage 3 snapshots

- objective CLI defaults to the library snapshot — stage 3 snapshot + local pins
- objective CLI rejects invalid objective, trials, target, pool and seed with exit 2 — stage 3 snapshot + local pins
- objective CLI treats relay --health as the total pool, independent of players — stage 3 snapshot + local pins
- relay text labels the simulated pool as the per-player share, and the kill count beside the TTK interval — stage 3 snapshot + local pins
- deterministic text prints Carry n/a; sampled text keeps on/off — stage 3 snapshot + local pins
- sampled objective CLI is reproducible, with opt-in samples and carry — stage 3 snapshot + local pins
- objective CLI refuses a boss, gate or trait target for sampled non-relay objectives — stage 3 snapshot + local pins
- existing build text is unchanged — stage 3 snapshot + local pins

## `test/objectives.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_objectives.rs

- 1. metric semantics: kill rate, output rate and the expected blow are distinct and consistent — ported → ported_objectives.rs
- 2. every objective is named, and every result says which target it was computed against — ported → ported_objectives.rs
- 3. no implicit switching: snapshot and whole-fight orderings can differ, and the ranking names the objective — ported → ported_objectives.rs
- 4. relay-aware and uncapped orderings differ: the cap reorders, and the ceiling separates what the relay ties — ported → ported_objectives.rs
- 5. a ranking is deterministic and refuses mixed target conditions — ported → ported_objectives.rs
- 6. a row that cannot be evaluated is kept and marked, never silently dropped — ported → ported_objectives.rs

## `test/planners14631.test.js`

**Class:** CLI differential — stage 3 snapshots, plus the local pins ported here
**Rust:** tests/planners.rs, tests/planner_mutants.rs (the build law) + ported_cli_usage.rs (--game-build acceptance); the page bytes: stage 3 snapshots

- the planner modules price the shipped build a caller names — stage 3 snapshot + local pins
- every planner command accepts --game-build and the default is the live build — stage 3 snapshot + local pins
- a refused command still refuses, and a command that is not a planner is unchanged — stage 3 snapshot + local pins

## `test/postBreakSchedule.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. the machine: with both weapons up the hands are a Dual pair, so a surviving off hand is always a pair's — lost (oracle)
- 2. the machine, recorded: the in-flight swing finishes, at the survivor's tick, then a fresh swing — lost (oracle)
- 3. dual main-hand break, equal weapons: the next hit is the in-flight swing's end + 2 ticks, exactly — lost (oracle)
- 4. dual off-hand break, equal weapons: the next hit is the in-flight flurry blow's end + 2 ticks, exactly — lost (oracle)
- 5. a build that carries an off weapon but is scheduled as one weapon: the lead swing in flight, then the survivor — lost (oracle)
- 6. different ticks (${name}): the remaining ticks of the in-flight swing run at the survivor's tick — lost (oracle)
- 7. the off hand's held burden is part of the swing in flight — lost (oracle)
- 8. controls: no break - durability on = off, the first two pair blows equal the machine, and the pre-break pair timeline drifts by exactly the averaged held burden — lost (oracle)
- 9. the survivor's own cadence, hit frame, powers and thresholds govern every later blow — lost (oracle)

## `test/pricing.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. no change: pricing evaluates to the canonical analysis, for every supported configuration — lost (oracle)
- 1b. the audit's discrepancies are gone: pair, dual and backstab at no change are exactly the analysis — lost (oracle)
- 2. a what-if is the same line on the item: pct = a slayer line, flat = an elemental line (local invariant) — lost (oracle)
- 2b. in a dual build the what-if rides the main-hand item; a pair is one item for both guns — lost (oracle)
- 3. Potent Vs on a landed blow matches upstream: main hand, off hand (weight 0.8), trait, cap, bow, backstab — lost (oracle)
- 4. a loot line (percentage + flat) on the blow matches upstream, in the game's order, with trait and cap — lost (oracle)
- 5. W-LOOT-CARRY: the carried metric is the held item's stream; the card still floors each blow — lost (oracle)

## `test/probe.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_probe.rs

- a clean 60 s capture reads 200 DPS, 1,000 burst and no immunity — ported → ported_probe.rs
- a five-second no-damage gap is read as immunity — ported → ported_probe.rs
- two pulls split into two fights — ported → ported_probe.rs
- the split halves are carried through — ported → ported_probe.rs
- a non-probe JSON is refused — ported → ported_probe.rs
- a slow weapon cadence is not mistaken for immunity — ported → ported_probe.rs
- per-player levels from the chart add their own share — ported → ported_probe.rs
- a top-10 chart fills the remaining players at the median level — ported → ported_probe.rs
- the gate state makes the boss HP exact — ported → ported_probe.rs
- the gate state also gives the exact landed total — ported → ported_probe.rs
- a chart that says fallen overrides stale gate hp and makes the damage the whole pool — ported → ported_probe.rs
- the flat chart rows give best and blows — ported → ported_probe.rs
- a mid-fight join reports since-join damage and keeps the whole kill total — ported → ported_probe.rs
- the player snapshot names the weapon and imprint — ported → ported_probe.rs
- a phase bar jump or boss heal does not split one gate fight — ported → ported_probe.rs
- a boss heal is added to the landed total — ported → ported_probe.rs

## `test/procBudget.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle

- 3.7b: one DoT round is one claim - the card and the allowance cap the same summed round — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- 3.7a: the DoT round is 5 s in the allowance and in the spell library alike (two homes, one value) — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- 3.7c: a dual pair claims ONE DoT round, from one merged entry — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- pin: a single-hand DoT card and a no-DoT pair price the round once (unchanged by 3.7c) — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- 3.7 band: the dual DoT pair has bracketing enchant and ceiling total DPS bands, but no sustained band — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- 3.7 band: a Pistolet pair claims one merged DoT round and has enchant and ceiling total DPS bands, but no sustained band — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- Phase 2: raw card totals follow the vendored relay on a saturated proc schedule — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- Phase 2: ordinary foes keep the old raw totals and bands — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- Phase 2: declared allowance without a run still has no total kill time — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- waiver pin (W-PROC-BUDGET): the ceiling still prices CWS procs on top of the capped weapon figure — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- M44: the ceiling aliases are the same numbers as the fields they name — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- M44: the ceiling can promise a kill the allowance refuses - named, and printed beside it — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- Phase 2: a censored kill stays null in the raw card and CLI JSON — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- M44: the gap note names its direction - the ceiling is not always the shorter figure — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle
- M44: without an allowance the kill time is labelled as the per-hit-capped ceiling — ported → ported_waivers.rs (the W-PROC-BUDGET pin); the rest needs the oracle

## `test/purse.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_relay.rs

- the level-45 purse is 750 deep, 150/s, 600 a blow, 4 blows/s — ported → ported_relay.rs
- the breach target is 12,000 HP with two 3 s shields — ported → ported_relay.rs
- the Sky-ketch target is 30,000 HP and still uses the 600 cap — ported → ported_relay.rs
- a build above the purse refill drains it, then settles at the refill rate — ported → ported_relay.rs
- a build below the refill never empties the purse — ported → ported_relay.rs
- the 4 blows/s token bucket drops blows above it — ported → ported_relay.rs
- the per-blow cap binds above 600 — ported → ported_relay.rs
- phase shields add their seconds to the kill — ported → ported_relay.rs
- the Sky-ketch capture turns its immunity into an opening and a share — ported → ported_relay.rs
- the split penalty is added only when asked for — ported → ported_relay.rs

## `test/racial.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_racial.rs

- racial: every weapon arm — ported → ported_racial.rs
- racial: the Wood Elf archery luck term is /25, not /20 — ported → ported_racial.rs
- racial: the two unarmed arms — ported → ported_racial.rs
- racial: races without an arm stay at zero — ported → ported_racial.rs
- racial (classic): the else-if ladder, including the Redguard archer quirk — ported → ported_racial.rs
- racial: the damage is in the weapon blow and the hit in the to-hit base — ported → ported_racial.rs
- racial: the off hand carries the same racial arms — ported → ported_racial.rs
- racial: a bow uses the Wood Elf/Redguard archery arm — ported → ported_racial.rs
- racial: Nord and Khajiit fists — ported → ported_racial.rs
- racial: backstab, condition, armour, traits and the cap compose — ported → ported_racial.rs
- racial: the Breach allowance is still a claimed stream — ported → ported_racial.rs

## `test/ranged.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_racial.rs

- a bow paces at its BOW_FAST window and spamming is slower — ported → ported_racial.rs
- the Long Bow is slower but hits harder than the Short Bow — ported → ported_racial.rs
- a Pistolet pair is two machines and the off hand is weaker — ported → ported_racial.rs
- the Thunderlock uses Archery and the two-handed Strength term — ported → ported_racial.rs

## `test/realBuild.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_enchants.rs

- real loadouts cover every family in both modes — ported → ported_enchants.rs
- the tree is real, and the chain is ordered — ported → ported_enchants.rs
- the capped loadouts do not beat the uncapped ones — ported → ported_enchants.rs
- all weapon loadouts list every template and exclude monster-type damage imprints — ported → ported_enchants.rs
- the capped loadout carries the purse metrics per content — ported → ported_enchants.rs

## `test/relayClaim.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_relay.rs

- 1. the relay constants are the game's and a fresh join starts full — ported → ported_relay.rs
- 2. tokens and bucket at exact boundaries: four at t=0, the fifth refused, the next at 0.25 s — ported → ported_relay.rs
- 3. zero, negative and non-finite claims are refused before any clock is touched — ported → ported_relay.rs
- 4. the cap, the bucket and the health clip in that order; the excess is discarded — ported → ported_relay.rs
- 5. an exact bucket can be emptied, then refills at 3 x ref a second — ported → ported_relay.rs
- 6. a fixed shield refuses before the token, and a claim at exactly its end is accepted — ported → ported_relay.rs
- 7. a wounded-boss join starts with an empty bucket but four tokens; recovery is the refill — ported → ported_relay.rs
- 8. ordering, ties and deterministic replay — ported → ported_relay.rs
- 9. a long stream is streaming: counters only, identical on replay — ported → ported_relay.rs
- 10. the engine clock is the claim timestamp; refused claims do not move the purse — ported → ported_relay.rs

## `test/relayClaimDifferential.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. tokens and the damage purse at their exact boundaries — lost (oracle)
- 2. cap, bucket and health clipping in the game order — lost (oracle)
- 3. a fixed shield: before it is refused without a token, at it is accepted — lost (oracle)
- 4. a wounded-boss join starts with an empty bucket and four tokens — lost (oracle)
- 5. zero, negative and non-finite claims touch no clock in the game either — lost (oracle)
- 6. a long seeded stream agrees claim for claim — lost (oracle)

## `test/relayClaimFight.test.js`

**Class:** local unit/invariant — NOT ported (gap)
**Rust:** tests/relay_fight.rs vectors only

- 1. a seeded relay fight: every traced claim matches the vendored relay — not ported (gap)
- 2. saturation: a build over the refill is limited by the bucket, and the excess is clipped — not ported (gap)
- 3. deterministic replay, fixed seeds and the trial distribution — not ported (gap)
- 4. guards: fists are refused, one Many Endings is supported, a synthetic two-echo is not — not ported (gap)
- 5. a fixed shield and a wounded-boss join change the claim state, not the law — not ported (gap)
- 6. a group fight uses one player's share as the relay pool — not ported (gap)
- 7. a dual-wield relay fight claims both hands through the same engine — not ported (gap)
- 8. elapsed time: a kill, the horizon and the blow budget are different clocks — not ported (gap)
- 9. trial aggregation: output DPS over every trial, conditional TTK over kills — not ported (gap)
- 10. Flow: read before the blow, charge on whole blows, cap and refresh — not ported (gap)
- 11. a Potent Vs miss is a positive-damage claim, not skipped — not ported (gap)
- 12. Many Endings and Flow coexist across the two hands — not ported (gap)
- 13. the ward suppresses Flow and the claim; the exact shield boundary does not — not ported (gap)
- 14. the Flow charge is independent of the relay claim verdict — not ported (gap)
- 15. with carry:false a build with neither mechanic remains bit-identical to Stage 3.3 — not ported (gap)
- durability is refused on a relay fight; omitted and false are unchanged — not ported (gap)

## `test/relayDotDifferential.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 7. a late first cast: the round clock does not bill rounds retroactively — lost (oracle)
- 0. NEGATIVE CONTROL: a one-draw shift in the cast script makes the claims diverge — lost (oracle)
- 0b. NEGATIVE CONTROL: the comparison detects an ordering swap and a split merged claim — lost (oracle)
- 1. CWS direct damage only: one cast claim, before the blow claim at the same time — lost (oracle)
- 2. CWS + DoT: the cast's first round rides the cast claim, later rounds one claim per 5 s — lost (oracle)
- 3. CWS + Many Endings: the echo stays in the blow claim, the cast claim is its own — lost (oracle)
- 4. a cast inside a shield: the oracle refuses it at the CastWhenStrikes gate, the local refuses it too — lost (oracle)
- 5. a shielded DoT round ticks but does not send; the round at shield end sends — lost (oracle)
- 6. a CWS kill: the cast claim kills and no blow claim follows — lost (oracle)

## `test/relayDotFight.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 3.7d: a CWS cast is its own claim, submitted before the blow claim at the same time — lost (oracle)
- relay tier cache: CWS and DoT claim state stays local to each seed — lost (oracle)
- 3.7d: a cast inside a shield is refused - the ward is the relay clock, not target.warded — lost (oracle)
- 3.7d: a shielded DoT round does not count as a claim or reach the engine — lost (oracle)
- 3.7d: a cast kill suppresses the blow claim and names the cast — lost (oracle)
- 3.7d: a renewal re-cast bills nothing (one entry, one first round) — lost (oracle)
- 3.7d: a DoT round can kill, and the kill names the DoT — lost (oracle)
- 3.7d: a (1,0) with durationBase 0 stands for nothing - no entry, no dot claim — lost (oracle)
- 3.7e: the per-kind accounting adds up, and a kill names its source — lost (oracle)
- 3.7d: the cast's claim equals the vendored applySpell for the same scripted rolls — lost (oracle)
- pin: a body cannot hold two (1,0) entries, and cws.js has no second continuous kind — lost (oracle)
- 3.7d: the cast uses the STRIKING hand's item - a CWS row on the OFF hand only — lost (oracle)
- 3.7 fix: outputDps uses the last BILLED claim, not the last blow — lost (oracle)
- 3.7e: the batch summary carries the per-kind totals and the kill tally — lost (oracle)
- 3.7d: no CWS rows ignores spell records and preserves the historical floor result — lost (oracle)
- 3.7d/M38(4): caller-set target.warded blocks relay casts, blow powers and DoT submissions — lost (oracle)

## `test/relayEchoDifferential.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. one Many Endings power on a relay body matches the sampled joint blow — lost (oracle)
- 2. the echo is resisted separately from the original blow (bladeturning) — lost (oracle)
- 3. a Potent Vs miss is a positive-damage blow in the sampled distribution — lost (oracle)

## `test/relayEligibility.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_tiers.rs

- formulaPositive is set independently of echo eligibility — ported → ported_tiers.rs
- a Potent Vs miss is positive pre-trait and not a hit — ported → ported_tiers.rs
- the fight merge key cannot collapse outcomes with different formulaPositive — ported → ported_tiers.rs

## `test/relayFight.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. the law with a health-dependent claim is the relay's own — lost (oracle)
- 2. saturation across damage levels: below the refill the build sets the pace, above it the relay does — lost (oracle)
- 3. two builds with identical capped damage and different uncapped damage collapse at the relay — lost (oracle)
- 4. the relay fight: exact against the relay on the expected claims, and within the walk's bias of seeded fights — lost (oracle)

## `test/relayFightDifferential.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. Flow expiry, refresh and cap across both hands — lost (oracle)
- 2. Many Endings and Flow on different hands, with separate resistance — lost (oracle)
- 3. warded attacks and the exact shield boundary — lost (oracle)
- 4. positive-damage Potent Vs misses — lost (oracle)
- 5. Flow progresses when the relay later refuses a claim — lost (oracle)

## `test/relayFlowDamageDifferential.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- Flow damage at stacks 1..4 matches upstream draw for draw — lost (oracle)

## `test/relayProcTtk.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 3.7g: the proc build's mean TTK is within 1% of the upstream compositor's seeded fights — lost (oracle)
- 3.7g: a proc build kills faster than the same build without its procs, on a body that does not cap it — lost (oracle)

## `test/relayRealSampler.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- real sampler: dynamic Flow stack inputs and upstream Flow state (single hand) — lost (oracle)
- real sampler: Flow on one hand and Many Endings on the other — lost (oracle)
- relay tier cache: carried and stateless single-weapon batches match standalone rows — lost (oracle)
- relay tier cache: ${name} batch matches standalone rows — lost (oracle)
- relay tier cache: dual-wield Flow and Many Endings match standalone rows — lost (oracle)
- relay tier cache: batches reuse and release tiers; both .with() forms start fresh — lost (oracle)
- relay tier cache: caller-owned carry state advances as in sequential standalone fights — lost (oracle)
- relay tier cache: caller-owned spell hooks keep tiers fight-local — lost (oracle)

## `test/rng.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_rng.rs (8 of 8 behavioural cases; the two source scans have no Rust form)

- 1. the same seed and the same use give the same sequence; a different seed does not — ported → ported_rng.rs (8 of 8 behavioural cases; the two source scans have no Rust form)
- 2. streams are independent: extra draws in one never move another, nor does creation order — ported → ported_rng.rs (8 of 8 behavioural cases; the two source scans have no Rust form)
- 3. a stream matches an independent xoshiro128** step function from the same state — ported → ported_rng.rs (8 of 8 behavioural cases; the two source scans have no Rust form)
- 4. float() is in [0, 1), int(n) is in [0, n), and the sequence is roughly uniform — ported → ported_rng.rs (8 of 8 behavioural cases; the two source scans have no Rust form)
- 5. draw accounting: every draw counts, per stream, and nothing else does — ported → ported_rng.rs (8 of 8 behavioural cases; the two source scans have no Rust form)
- 6. snapshot and restore: a generator continues exactly as the original did — ported → ported_rng.rs (8 of 8 behavioural cases; the two source scans have no Rust form)
- 7. invalid input is rejected predictably — ported → ported_rng.rs (8 of 8 behavioural cases; the two source scans have no Rust form)
- 8. no global state and no ambient randomness — ported → ported_rng.rs (8 of 8 behavioural cases; the two source scans have no Rust form)

## `test/rustVectorsDriver.test.js`

**Class:** tooling — delete

- one family per process writes the same bytes as a serial run — delete
- an unknown family name is refused, not silently skipped — delete

## `test/shieldOutcomes.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- F1: per-outcome shield block against upstream, value by value and part by part — lost (oracle)
- F1: the per-swing means agree too, capped and uncapped, with the sampled blows (all outcomes, crits included) — lost (oracle)
- F1: a deterministic block - a chance of 0 or 100 is one outcome, and both sides agree — lost (oracle)

## `test/simulateFight.test.js`

**Class:** upstream-oracle — the numbers are frozen in Rust vectors, the live proof is lost
**Rust:** tests/simulate_fight.rs (vectors)

- 1. single-hand scheduling: the upstream machine clock, then the cadence — frozen in tests/simulate_fight.rs (vectors)
- 2. dual scheduling: machine-derived fresh lead, off blow and flurry order — frozen in tests/simulate_fight.rs (vectors)
- 2b. ranged first hit: the bow loose and the gun frame 1, from the machine clock — frozen in tests/simulate_fight.rs (vectors)
- 3. a seed reproduces one fight exactly; a different seed differs; trials use the given list — frozen in tests/simulate_fight.rs (vectors)
- 4. health-dependent distributions rebuild after a threshold, and the fight reports state separately — frozen in tests/simulate_fight.rs (vectors)
- 5. aggregate metrics and paired seeds: sample count, quantiles, uncertainty and common seeds — frozen in tests/simulate_fight.rs (vectors)
- 5b. censoring is reported as kill probability, not folded into the conditional TTK — frozen in tests/simulate_fight.rs (vectors)
- 6. health segments: a share exactly on a threshold takes the not-below side — frozen in tests/simulate_fight.rs (vectors)
- 7. capped mode samples the capped blow and the two metrics stay separate — frozen in tests/simulate_fight.rs (vectors)
- 8. exclusions and explicit assumptions: a Pistolet pair is refused, and the schedule is named — frozen in tests/simulate_fight.rs (vectors)

## `test/sockets.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_theory.rs

- socket counts follow the weapon size — ported → ported_theory.rs
- perfect diamond sockets are +12% damage each — ported → ported_theory.rs
- Hand Wraps carry damage and sockets onto the fist blow — ported → ported_theory.rs
- dual wield strikes with the off hand at x0.8 and the Agility to-hit term — ported → ported_theory.rs
- Hand Wraps are one-handed, and two-handed weapons never enter a dual pair — ported → ported_theory.rs

## `test/spells.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_theory.rs

- a damage spell prices and lands with the live school and saving throw — ported → ported_theory.rs
- a continuous damage spell adds its rounds — ported → ported_theory.rs
- the spell card exposes cost, cast time, DPS and pool sustain — ported → ported_theory.rs
- a spell rotation carries min/avg/max DPS — ported → ported_theory.rs

## `test/spellsCache.test.js`

**Class:** tooling — delete

- S-1: a missing directory still yields a fresh empty map, and a later explicit dir still loads — delete
- S-2: repeated cached calls do not read the filesystem — delete

## `test/standInSpellCatchUp.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- ORACLE: a three-round frame gap lands one claim; known local divergence: three separate claims — lost (oracle)
- ORACLE: a backwards frame resets the clock without ticking a live DoT — lost (oracle)
- ORACLE: idle frames do not tick and a new DoT does not inherit the idle gap — lost (oracle)

## `test/standInSpellDifferential.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- ORACLE: the round is COURT_ROUND_MS = 5000 ms, one game minute online - the project's 5 s, from the source — lost (oracle)
- ORACLE: the court rounds before dropping a sub-point hit, and sends at the shield end — lost (oracle)
- ORACLE: the cast claim and the round claims equal the game's - ${name} (${why}) — lost (oracle)
- ORACLE (control): a matching element-proof trait really changes the claims, so the cases above are not vacuous — lost (oracle)
- ORACLE: turned DoT ticks send no claim (${entityWarded ? 'caller-set entity ward' : 'timed shield'}) — lost (oracle)

## `test/statCap.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- upstream really folds the path into _mods.stats and clamps after it (the premise) — lost (oracle)
- the combat stat equals upstream liveStat: every base x path, with and without a raised ceiling — lost (oracle)
- hit chance with the path, sampled through upstream pcaaoAttackDamage, below the 97% ceiling — lost (oracle)
- the other post-clamp stat adds the audit asked about: none shares the order — lost (oracle)

## `test/stochasticObjectives.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_stochastic.rs (the sampled row metadata, Wilson interval, minimum-trials refusal); the paired-difference quantile case needs the raw sample rows

- 3.8: sampled rows name metric and damage mode; censoring cannot be rewarded — ported → ported_stochastic.rs (the sampled row metadata, Wilson interval, minimum-trials refusal); the paired-difference quantile case needs the raw sample rows
- 3.8: pairedDifference refuses to separate fewer than 8 pairs and uses Student t — ported → ported_stochastic.rs (the sampled row metadata, Wilson interval, minimum-trials refusal); the paired-difference quantile case needs the raw sample rows
- 3.8: kill-probability names its metric, damage mode and Wilson interval — ported → ported_stochastic.rs (the sampled row metadata, Wilson interval, minimum-trials refusal); the paired-difference quantile case needs the raw sample rows

## `test/stochasticOrdering.test.js`

**Class:** local unit/invariant — NOT ported (gap)
**Rust:** a 1,000-seed relay reversal: the sampled ordering is not pinned (the sampled rows are, in ported_stochastic.rs)

- 3.8 ordering guard: the relay walk ranks 127 over 126, the sampled relay reverses them — not ported (gap)

## `test/swingDirection.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- 1. the six directions are upstream's own table, equally likely, and the default is the draw — lost (oracle)
- 2. each of the six directions, for several weapon types, against the game's own blow — lost (oracle)
- 3. the full draw: the default is the equal mixture, and the neutral default is rejected — lost (oracle)
- 4. criticals and the per-hit cap: the draw composes with both, and a bow's release is forced — lost (oracle)
- 5. a whole fight under the draw, against seeded upstream fights that draw per blow — lost (oracle)
- 6. a ranking whose order the draw changes, with the objective and target named — lost (oracle)

## `test/target.test.js`

**Class:** upstream-oracle — the numbers are frozen in Rust vectors, the live proof is lost
**Rust:** tests/target.rs (vectors)

- reference foe keeps its previous shape and adds the target fields — frozen in tests/target.rs (vectors)
- reference-foe resolution still matches the game for a plain target — frozen in tests/target.rs (vectors)
- the gate stand-in is the upstream bossStandIn identity: career index, no career object, Normal tolerance — frozen in tests/target.rs (vectors)
- enemy rows resolve identity: mobile, career, affinity, group, metal and armour, as upstream mints them — frozen in tests/target.rs (vectors)
- gate, encounter and boss targets carry the same fields without touching player data — frozen in tests/target.rs (vectors)
- monster hide and natural resistance use the career and stats, not armour — frozen in tests/target.rs (vectors)
- career tolerances: precedence, elemental share and the saving throw — frozen in tests/target.rs (vectors)
- material requirement is a damage multiplier, not a to-hit term — frozen in tests/target.rs (vectors)
- material hard refusal matches the game — frozen in tests/target.rs (vectors)
- material rounding: half-to-even after the multiplier, before condition — frozen in tests/target.rs (vectors)
- material and hide end-to-end against the game — frozen in tests/target.rs (vectors)
- target defense is applied exactly once, before the boss traits and the cap — frozen in tests/target.rs (vectors)
- the per-hit cap and the relay allowance sit after target mitigation — frozen in tests/target.rs (vectors)
- single and dual builds apply the same target defense to each hand — frozen in tests/target.rs (vectors)

## `test/targetBody.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- the oracle realm boots as the client boots: Enemy Expansion with MUDEX, the shipped switches — lost (oracle)
- every classic monster body (all 43 rows) is the one upstream mints - or refused where upstream mints none — lost (oracle)
- every class foe body is minted at the player level it is handed (and the watchman's roll) — lost (oracle)
- the 43 monster rows: what the boot changes, and what it never touches — lost (oracle)
- F6: a missing, null or invalid level never becomes level 0 — lost (oracle)
- F8: the Breach, Sky-ketch and Abyss bodies are one upstream stand-in, at every content level — lost (oracle)
- a mid-level attacker against the three bosses: the body is the game's, and the old one is far outside — lost (oracle)
- a weaker attacker below the 97% clamp: the hit chance itself reads the body's armour — lost (oracle)
- the oracle is independent of local target construction — lost (oracle)

## `test/theory.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_theory.rs

- the theory character is level 45, at the live stat and skill ceilings — ported → ported_theory.rs
- at raw 200 and no gear: /10 Strength doubled for two hands, 70% crit x2.4 — ported → ported_theory.rs
- the rolled-line slot counts are not a point budget; the legal single-skill max is 535 — ported → ported_theory.rs
- a different long blade keeps the damage affix and changes the template — ported → ported_theory.rs
- the Firmament lifts the live attribute ceiling and adds to the formula skill — ported → ported_theory.rs
- a gear stat affix fills headroom but does not lift the 100 ceiling — ported → ported_theory.rs
- the Firmament blow channel raises uncapped DPS and is priced apart from gear skill — ported → ported_theory.rs
- the Hand-to-Hand reference lands in the reported ~450 band — ported → ported_theory.rs

## `test/tierCache.test.js`

**Class:** local unit/invariant — ported
**Rust:** ported_tiers.rs

- T1-1: a single-weapon batch is bit-identical to standalone fights — ported → ported_tiers.rs
- T1-2: a dual-weapon batch is bit-identical to standalone fights — ported → ported_tiers.rs
- T1-3: a durability batch with breaks is bit-identical (wear and CWS bills) — ported → ported_tiers.rs
- T1-4: a durability dual batch with a break is bit-identical — ported → ported_tiers.rs
- T1-5: a batch cache is reused across seeds, and `.with()` never inherits it — ported → ported_tiers.rs
- T1-6: a second batch rebuilds tiers for the changed target and matches standalone fights — ported → ported_tiers.rs
- T1-7: a batch releases its cached tiers before returning — ported → ported_tiers.rs

## `test/vectorCache.test.js`

**Class:** tooling — delete

- V-1: identical content in two different directories and mtimes gives the same key — delete
- V-1b: the same root by another path (trailing slash, .., a symlink) is the same key — delete
- V-2: only content moves the key - vendor, sources, generators; the mutation tool is not an input — delete
- V-3: SPELLS.STD enters the key by content, resolved as the generators resolve it — delete
- V-3b: no readable SPELLS.STD means no key, so nothing is reused or stamped — delete
- V-4: a relative arena2Path resolves against the repository root, not the caller cwd — delete
- V-5: a current stamp is reused; a foreign or stale stamp is not; --fresh never caches — delete
- V-6: vectors linked into another tree are reused when current, and regeneration fails closed when stale — delete
- V-7: a symlinked ancestor, and a dangling link, both count as a link — delete

## `test/vendor-manifest.test.js`

**Class:** tooling — delete

- vendor: the manifest pins the audited commit and comes from the vendor tool — delete
- vendor: every file matches its recorded hash, and nothing extra exists — delete
- vendor: every recorded file is present and hashed, with no duplicates — delete
- vendor: a modified vendored file is detected (tamper check is live) — delete
- vendor: no module the harness measures is a stub — delete
- vendor: every stub is documented with its reason and bindings — delete
- vendor: the upstream licence and README are preserved — delete
- vendor: the subset loads and the overhaul installs — delete
- vendor: the subset is a small fraction of the client it is cut from — delete
- vendor: the source maps back to the documented upstream paths — delete

## `test/wardSuppression.test.js`

**Class:** upstream-oracle — lost (live differential against the vendored game)

- A: target.warded gates slayer percent and elemental flat in lootBlow — lost (oracle)
- B: target.warded gates weaponMasteryBlow — lost (oracle)
- C: target.warded gates the martial blow channel — lost (oracle)
- D: target.warded gates lootStrike - no echo, no leech, no chain — lost (oracle)
- GREEN GUARD: target.warded does not gate Potent Vs - the Strikes payload is not a blow power — lost (oracle)
- GREEN GUARD: target.warded gates Cast When Strikes - no cast, no bill — lost (oracle)
- the boss `warded` TRAIT is a health pool the owner takes first, not `target.warded`: pool and drain match bossTake — lost (oracle)
- blowDistribution: target.warded suppresses echo draws — lost (oracle)
- Q6: the ordinary fight keys the ward on target.warded, not the relay shield clock — lost (oracle)

## `test/harness/` (16 helpers)

| Helper | Disposition |
|---|---|
| `blowConfigs.mjs` | tooling — fixture for the blow differential; delete |
| `blowOracle.mjs` | tooling — driver for the vendored blow oracle; delete |
| `differential.mjs` | tooling — the differential comparator; delete (the Rust vectors replace it) |
| `fightOracle.mjs` | tooling — driver for the vendored fight oracle; delete |
| `fixtures.mjs` | tooling — fixture builders; ported as `rust/dfo-core/tests/ported_common/mod.rs` for the local tests |
| `outcomes.mjs` | tooling — oracle outcome helpers; delete |
| `prng.mjs` | tooling — mulberry32/xoshiro for the differential sweeps; the ported sweeps use a local LCG (rule 9 bans Math.random, not a test PRNG) |
| `relay.mjs` | tooling — relay claim helpers; the engine ports as `dfo-core/src/relay_claim.rs` |
| `relayEventSeam.mjs` | tooling — the relay oracle seam; delete |
| `relayFightOracle.mjs` | tooling — driver for the vendored relay oracle; delete |
| `spellbook.mjs` | tooling — real SPELLS.STD discovery; the synthetic book replaces it (stage 2) |
| `swingMachine.mjs` | tooling — swing differential helper; delete |
| `upstream.mjs` | tooling — the vendored oracle loader; delete |
| `upstreamBodies.mjs` | tooling — vendored body fixtures; delete |
| `upstreamBodyWorker.mjs` | tooling — vendored body worker; delete |
| `waivers.mjs` | local — the two waiver records; `ported_waivers.rs` keeps the pins alive |

