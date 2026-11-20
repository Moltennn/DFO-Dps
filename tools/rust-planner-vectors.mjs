/*
 * R5d, stages 2-5 (NOT DONE): the vector generator for src/enchantPlan.js, src/realBuild.js and
 * src/loadoutShortlist.js.
 *
 * Nothing imports this yet. When the port lands, `tools/rust-vectors.mjs` should call `genPlannerFamilies(Out)` and
 * generate these families (the cost notes are measured with the real JS on this machine, 2026-11-19):
 *
 *   enchant  planEnchants over every weapon template x soulGem x forceSkills x (target, group) x repairs/regen/shield
 *            variants. ~37-120 ms per call; the grid must stay near 2,000 cases (about 2-4 minutes).
 *   gear     gearPieces over every template x shield ('auto', 'none', 109..112, junk). < 1 ms.
 *   best     bestWeaponForFamily over all six families x both targets (gate, tough). ~5 ms each.
 *   matrix   planMatrix over soulGem x forceSkills x group x target. ~350 ms each: keep this to a handful of cases.
 *   stages   realBuildStages / realTemplate over mode {uncapped, cap} x vampire x dual x encounter {breach,
 *            skyketch, abyss} for each family's templates: ~60-110 ms per stage call.
 *   loadouts realWeaponLoadouts for modes {uncapped, cap} x vampire x encounter: ~2.3-2.4 s per run, 26 eligible
 *            loadouts per mode after isSampledLoadout.
 *   shortlist shortlistLoadouts for k in {1,3,5,all} x mode with fixed seeds: ~2.7-6 s per call (1,000 trials,
 *            maxSeconds 20); the full 1,000-trial/3,600 s default is not affordable in a fixture.
 *
 * Domains smaller than 2,000 and why: `gearPieces` is 23 templates x ~6 shields (~140); `planMatrix` is 2 x 2 x 3 x 2
 * (24); `shortlist` is 2 modes x 4 k values (8). Each test must state its own floor rather than claim 2,000.
 *
 * Hazards already settled by reading the JS (see rust/README.md, "R5d: what is left"):
 *   - `value / cost` sorts: a NaN difference is JS "equal" and keeps insertion order (stable sort).
 *   - firmament.js:397 `localeCompare`: the compared keys are the generated channel names, whose alphabet is ASCII;
 *     the generator asserts `localeCompare` equals byte order over that exact set.
 *   - firmament.js:294 `delete gains[k]` on shared objects: the port owns its pairs, so a rebuild is the same value.
 *   - enchantPlan.js:102/106/164 and realBuild.js:33 `JSON.parse(JSON.stringify())`: plain finite records only, so an
 *     owned clone (`analyze::json_clone`) is the same object.
 *   - effectLine's `toLocaleString()`: en-US grouping, pinned by the vectors ("1,830").
 */
export function genPlannerFamilies() {
  throw new Error('rust-planner-vectors: the R5d planner stages are not ported yet (see rust/README.md)');
}
