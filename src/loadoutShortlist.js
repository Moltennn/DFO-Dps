import { IMPRINT_FAMILIES } from './imprints.js';
import { MIN_STOCHASTIC_TRIALS, rankBuilds } from './objectives.js';
import { isSampledLoadout, realBuildStages, realWeaponLoadouts } from './realBuild.js';
import { pairedFightSeeds } from './simulateFight.js';

const universeCache = new Map();

// The scenario `maxRun` (src/maxprofile.js) prices the deterministic row under. The sampled fight must use the same
// swing law (RRI cadence and weapon damage), core, passive and Flow stacks, or the two columns describe different builds.
const MAX_RUN_SCENARIO = Object.freeze({ core: 'overhaul', rri: true, passiveOn: true, stacks: 5 });

/** Rerank the top k eligible deterministic loadouts on one target; keep their chosen imprints. */
export function shortlistLoadouts({
  k, mode = 'uncapped', encounter = 'breach', vampire = false,
  objective = mode === 'cap' ? 'stochastic-relay' : 'stochastic-ttk',
  trials = MIN_STOCHASTIC_TRIALS, seed = 0, maxSeconds = 900, maxBlows = 6000, health = null,
} = {}) {
  if (mode !== 'uncapped' && mode !== 'cap') throw new Error(`unknown shortlist mode: ${mode}`);
  if (mode === 'cap' && health != null) throw new RangeError('--health does not apply to --cap-aware shortlists: the relay encounter sets the pool');
  const allowed = mode === 'cap' ? ['stochastic-relay'] : ['stochastic-ttk', 'kill-probability'];
  if (!allowed.includes(objective)) throw new Error(`${mode} shortlist: choose ${allowed.join(' or ')}, not ${objective}`);
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError('--shortlist must be a positive integer (0 disables it in the CLI)');
  if (!Number.isSafeInteger(trials) || trials < MIN_STOCHASTIC_TRIALS) {
    throw new RangeError(`--trials: at least ${MIN_STOCHASTIC_TRIALS} trials are required`);
  }

  const cacheKey = JSON.stringify([mode, vampire, encounter]);
  if (!universeCache.has(cacheKey)) {
    universeCache.set(cacheKey, realWeaponLoadouts({ modes: [mode], vampire, encounter })
      .filter(isSampledLoadout).sort((a, b) => b.totalDps - a.totalDps));
  }
  const universe = universeCache.get(cacheKey);
  if (k > universe.length) throw new RangeError(`--shortlist: ${k} exceeds the ${universe.length} eligible loadouts`);

  const candidates = universe.slice(0, k);
  const stages = candidates.map(({ template, key, dual }) => realBuildStages(
    template, IMPRINT_FAMILIES.find((f) => f.key === key), { mode, dual, encounter, vampire },
  ));
  const seeds = pairedFightSeeds(trials, seed);
  const ranking = rankBuilds(stages.map(({ enchCh, imprint }, id) => ({
    id, ch: enchCh, scenario: { imprint: imprint?.power },
  })), { ...MAX_RUN_SCENARIO, objective, target: stages[0].target, health, seeds, maxSeconds, maxBlows });
  const damageNote = mode === 'cap'
    ? 'Sampled melee and Cast When Strikes (direct and supported Continuous Damage) go through the relay allowance; live Flow, no wear; phase-ward timing is not modelled. Deterministic DPS is a ceiling plus modeled proc DPS, before the allowance.'
    : 'Sampled melee and Cast When Strikes (direct and supported Continuous Damage) damage the ordinary foe; no wear, and Flow held at its steady-state maximum stacks. Deterministic DPS includes modeled proc DPS.';

  return { ...ranking, mode, encounter: mode === 'cap' ? encounter : null, seed, maxBlows, rows: ranking.rows.map((row) => {
    const { key, family, weapon, template, category, dual, imprint, totalDps } = candidates[row.id];
    return {
      ...row, key, family, weapon, template, category, dual, imprint,
      deterministicRank: row.id + 1, deterministicTotalDps: totalDps,
      deterministicProcDps: stages[row.id].enchRun.enchantDps,
      damageMode: row.damageMode ?? (mode === 'cap' ? 'relay' : 'uncapped'), damageNote,
      ttkSeparated: row.ttkSeparated ?? null, censoringDiffers: row.censoringDiffers ?? null,
    };
  }) };
}
