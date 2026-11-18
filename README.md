# DFO DPS Lab

A standalone, read-only combat DPS and build lab for **DFO Online**. It reads a
normal save or a live character snapshot, models the game's combat core against
the pinned upstream client, and helps answer:

- what a build does against a monster, a human, a boss, or the Breach;
- which stats, skills, weapons and materials still matter;
- what an enchant, imprint or Firmament plan is worth;
- how a whole fight and the relay's allowance change the answer.

It is **not a mod**. It does not write to the game, the save, or the store.
It prints tables and writes standalone HTML/JSON files.

> Current source of truth: `Lattymoy/daggerfall-js-source` at
> `a3eb1605ea1dc391b691fe314377458a7e63e483` (2026-11-02). See
> [`docs/SOURCES.md`](docs/SOURCES.md).

## Requirements and installation

- **Node.js 18 or newer**. There are no runtime dependencies.
- A DFO save is optional for demoing: without `--save`, the newest save under
  the client's user-data folder is used.
- Spell commands need the client's `ARENA2/SPELLS.STD`, found through the
  launcher's `arena2Path` or `--data <dir>`. Without it the spellbook is empty.
- `probe` reads captures from the separate Combat Probe mod; the mod is not in
  this repository.

From a checkout:

```bash
git clone https://github.com/Moltennn/DFO-Dps.git
cd DFO-Dps
node --version                 # 18+
./dfo-dps --help
```

There is no build or `npm install` step. `./dfo-dps` is a small wrapper around
`node bin/dfo-dps.js`; both forms work:

```bash
./dfo-dps doctor
node bin/dfo-dps.js doctor
```

`--save` accepts a slot (`SAVE4`), a save folder, or a path to `SaveData.txt`.
Save discovery honours `DAGGER_USER_DATA`; otherwise it uses the client's
platform user-data location.

## Quick start

```bash
./dfo-dps saves
./dfo-dps doctor --save SAVE4
./dfo-dps build --save SAVE4
./dfo-dps rank weapons --save SAVE4 --target boss --traits curbing --health 5000
./dfo-dps report --save SAVE4 --target breach --out build.html
```

- `saves` lists the saves the client can see.
- `doctor` prints the pinned model, save path, character and active rules.
- `build` is the one-build, one-target card. Its default target is `armoured`.
- `rank weapons` compares weapon templates/materials for this character.
- `report` writes a single-file HTML report.

`--target` accepts the reference foes `soft`, `tough`, `armoured` and `human`,
the synthetic `boss`, or the real relay targets `breach` and `gate`. `--target
breach` uses the Breach body at the selected level (the character's level by
default; `--level` overrides it) and its per-player allowance. `boss` is a
generic boss with the health, armour and traits you pass.

## Commands at a glance

| Command | Purpose |
|---|---|
| `build` | One build against one target; the default command. |
| `rank weapons` | Rank melee templates and materials. |
| `report` | HTML report for one build and target. |
| `compare` | Baseline versus one stat, skill or weapon change. |
| `scale` | Stat/skill curve to the caps, or `--all` channels. |
| `tradeoff` | Speed versus damage, and Curbing-boss crossovers. |
| `theory` | Level-45 long-blade ceiling and gear frontier. |
| `weapons`, `skills` | HTML weapon ceiling page; `skills` is an alias. |
| `imprints` | Rank Rare imprints by weapon family. |
| `enchant-plan` | Per-piece enchant budget and priority plan. |
| `loadout` | Tree + enchants + best imprint, per weapon/hold. |
| `firmament` | Star-tree plans for the supported builds. |
| `spell`, `spells` | One spell, or an HTML page of damaging spells. |
| `graph` | Standalone SVG line chart of stats, skills or stars. |
| `probe` | Read a Combat Probe capture. |
| `saves` | List saves under the client's user-data folder. |
| `doctor` | Show save, build, ruleset and model information. |

Use `./dfo-dps --help` for every flag, or see
[`docs/USAGE.md`](docs/USAGE.md) for complete workflows and output defaults.

## What is supported

**Supported and exercised by the test suite**

- Save import, live-snapshot import, and the game's combat card model.
- Classic `FormulaHelper` and the PCAAO overhaul, including hit/crit,
  body-part armour, weapon damage, Strength, proficiency, race, two-handed,
  condition, backstab, bows, guns and dual wield.
- Online past-100 weapon mastery, gear skill lines, `damage`/`skill`/`stat`/
  `slayer`/`elemental` lines, and weapon Legendary powers/imprints.
- The six-way swing-direction draw is the default, enumerated exactly.
- Boss traits Curbing, Warded, Bladeturning, Stoneskin, Thorned and the
  elemental proofs, where the target carries them. Wrathful is reported but
  does not terminate the modelled fight.
- Snapshot, whole-fight, relay and relay-ceiling metrics, with explicitly
  named targets.
- The Stage 3.1 seeded RNG and exact per-blow distribution library
  (`src/rng.js`, `src/blowOutcomes.js`); these are library APIs, not CLI pages.
- The Stage 3.2 seeded blow-by-blow fight simulation (`src/simulateFight.js`):
  single and dual melee schedules, health-dependent distribution rebuilds,
  TTK/damage/overkill distributions, censoring and paired seeds. It is a
  library API, not a CLI page.
- The Stage 3.5.1/3.5.2 ordinary-foe additions (`src/cws.js`,
  `src/durability.js`, `src/simulateFight.js`): Cast When Strikes direct
  damage, and opt-in `durability: true` with ordinary weapon wear, the CWS
  condition bill, breaks/unequipping and survivor promotion. Durability is off
  by default, so the Stage 3.1-3.5.1 no-wear fight is unchanged. Relay
  durability is not implemented: `simulateRelayFight` rejects
  `durability: true` (Stage 3.5.3g).
- The Stage 3.3 streaming relay claim engine (`src/relayClaim.js`,
  `src/relayFight.js`): the four-token hand, the damage purse, the per-claim
  cap, clipped/refused claims, saturation, remaining bucket state and seeded
  relay fights. Also a library API.
- The Stage 3.4 relay mechanics (`src/flowState.js`, `src/relayFight.js`):
  Flow's global strict clock and whole-blow charges, and one Many Endings
  echo included in the original claim. A synthetic two-echo build is refused.

**Supported with important approximations**

- **Cast When Strikes and DoTs.** A CWS row's direct damage is resolved per blow
  in the ordinary fight (Stage 3.5.1), with its condition bill when
  `durability: true` (Stage 3.5.2); in the relay fight every proc and every DoT
  round is its own claim, compared claim for claim against the vendored
  compositor (Stage 3.7d-3.7f). The CARD and CEILING figures still price
  CWS/DoTs as expected damage added to the capped weapon figure, so a ceiling can
  promise a kill the allowance refuses; see `W-PROC-BUDGET`.
- **Spells** use the live `SPELLS.STD` records, saving throws and school
  potency. Reflection/absorption and some effect families are not modelled.
- **Firmament, enchant-plan, imprint and loadout** are supported planner
  heuristics based on the game's trees/budgets. They are not global-optimum
  proofs and do not all have differential stages.
- **Breach, Sky-ketch and Abyss TTK**: the Breach is calibrated; the Sky-ketch
  comes from one solo capture; the Abyss is marked uncalibrated. The 3-second
  phase shield is a declared model parameter (`A8`), and the 75-second Wrath is
  reported but does not terminate the fight in the model.
- **Live snapshot import** depends on the debug-game shape and is not a
  guarantee against every live-client change.

**Not supported**

- Loot set powers and sigils, armour/jewellery powers, Gilded records.
- Techniques and spells/effects outside the supported spell and CWS paths.
- Duelist's Vambrace **First Blood** (the `--first-blow` flag is the separate
  Assassin/Opening Strike scenario).
- PvP/peer fights, incoming damage and player death.
- The default (no-durability) Stage 3.2 fight simulation does not model ordinary
  wear or the CWS condition bill; `durability: true` adds both (Stage 3.5.2).
  CWS direct damage is modelled since Stage 3.5.1. It does not model DoTs,
  dynamic Flow stack increments, the relay bucket/ward or incoming damage, and
  it refuses a Pistolet pair rather than approximating it. Ranged builds are
  refused by the fight APIs (the schedule helper still resolves their first
  frame). Censored runs report a kill probability and a conditional TTK; no
  Kaplan-Meier estimate is made.
- The Stage 3.3/3.4 relay engine does not model geometry, Sundered halves,
  stun/profile hit multipliers, Wrath, host/crystal claims, phase-ward
  lifecycle, CWS, DoTs or relay durability; `durability: true` is refused
  (Stage 3.5.3g). A static Warded trait/ward pool is not modelled. A synthetic two-echo
  build, an unarmed build, and bow/gun builds (whose release/landing timing is
  not modelled) are refused rather than approximated. Flow and one Many
  Endings power are supported; an echo build requires `target.relayBody === true` up front.
- Per-blow ward suppression and the full proc/DoT budget.
- Elite Breach, and non-English boss-trait seeding.
- Exact reproduction of a live client's frame timing or RNG sequence.

## Data, outputs and rules

- `build`, `rank`, `compare`, `scale` and `tradeoff` print tables; many also
  accept `--json`.
- HTML pages default to the current directory (`dfo-dps-report.html`,
  `weapons.html`, `skills.html`, `imprints.html`, `enchant-plan.html`,
  `loadouts.html`, `firmament.html`, `spells.html`, `graph.html`,
  `probe.html`). Use `--out <file>` to choose another path.
- The online rule set is on by default; `--offline` uses the offline rules.
  `--core classic` selects the classic combat core.
- A save is a snapshot; live gear and gems can differ. `--save /tmp/live.json`
  accepts a live character snapshot with `equipSlots` and `_enchantMods`.
- No command modifies a game file. Output files are the only writes.

## How it works and how it is checked

The model follows the pinned client's combat code, not a reimplementation from
memory. The per-hit model mirrors the game's Combat Stats card; verification
uses the vendored source's own functions as the oracle, with differential and
golden fixtures. The live card is a useful comparison, not the oracle.

The project names its metrics rather than treating every “DPS” as one number:
**snapshot** (full-health card), **fight** (whole-fight kill rate),
**relay** (allowance applied), and **relay-ceiling** (capped offered rate).
See [`METHOD.md`](METHOD.md) for formulas and the limitations below for what is
not verified.

## Limitations and known gaps

These are recorded as waivers or assumptions, not hidden:

- `W-PROC-BUDGET`: the relay fight bills every proc and DoT round as its own
  claim (Stage 3.7d-3.7f); the ceiling figures still add that damage to the capped
  weapon figure.
- `W-WARD`: ward suppression of the per-blow powers fires on `target.warded`, which only a caller sets; the boss
  `warded` TRAIT's own pool does not suppress them, and DoT rounds are not ward-gated.
- `W-LOOT-CARRY`: percentage lines floor each blow instead of carrying the
  fraction.
- Phase-ward duration, Wrath termination and some encounter windows are model
  parameters or uncalibrated.
- Spells, procs, the Firmament application and the planners do not all have
  differential stages yet.

Treat a number as a game measurement only where the differential and golden
suites cover it.

## Development

```bash
npm test
node tools/test-fast.mjs   # quick iteration pass: the suite minus the heavy files
npm run benchmark
npm run test:differential
npm run test:golden
npm run test:invariants
npm run test:vendor
npm run vendor:verify
npm run vendor:parity -- --from <upstream-checkout>
```

The suite covers the combat model, the per-blow distribution, the seeded RNG,
the differential/golden/vendor checks, and the Stage 3 distribution and fight
oracles. The vendored tree is hash-checked; vendor parity compares the vendored
subset with the full pinned checkout.

`node tools/test-fast.mjs` is a quick iteration pass only: it runs every test
file except the heavy ones listed in `tools/test-fast.mjs`. `npm test` is the
gate and runs everything.

## Documentation map

- [`docs/USAGE.md`](docs/USAGE.md) — complete command workflows and examples.
- [`METHOD.md`](METHOD.md) — combat formulas, cadence, planners and theory.
- [`docs/SOURCES.md`](docs/SOURCES.md) — the upstream pin and provenance.
- [`docs/LOADOUT-BENCHMARK.md`](docs/LOADOUT-BENCHMARK.md) — the reproducible
  loadout benchmark, with charts in `docs/charts/` and machine-readable results
  in `docs/benchmark/` (`npm run benchmark`).

## License and credits

MIT. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). The combat model follows
the open-source DFO Online client by Lattymoy and Daggerfall Unity's
`FormulaHelper` (MIT, Daggerfall Workshop).
