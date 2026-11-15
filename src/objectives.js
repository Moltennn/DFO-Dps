/*
 * dfo-dps - explicit ranking objectives.
 *
 * Every DPS-like number this project reports means something different, and ranking builds by the wrong one is a
 * correctness error, not a preference:
 *
 *   snapshot       the blow at FULL foe health, uncapped (`analyze(...).dps`): the card's rate, before any fight.
 *   fight          the whole-fight kill rate over the declared pool (`fight`), health-dependent terms walked.
 *   relay          the kill rate with the relay's allowance applied to every claim (`fightRelay`): the boss's pace,
 *                  not the build's once the build saturates.
 *   relay-ceiling  the per-hit-capped offered rate before the relay (`fightRelay().ceilingDps`): NOT an outcome - the
 *                  ceiling a saturated build would reach if the relay lifted its refill - the number that tells two
 *                  builds apart when `relay` ties them.
 *
 * Nothing here switches objective implicitly: a caller names one, and every row says which one produced it and against
 * what target. `rankBuilds` refuses to mix target conditions.
 */
import { analyze } from './model.js';
import { fight, fightRelay } from './fight.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export const OBJECTIVES = Object.freeze({
  snapshot: Object.freeze({
    id: 'snapshot',
    label: 'full-health snapshot DPS (uncapped)',
    unit: 'dps',
    needsHealth: false,
    needsRelay: false,
    basis: 'the blow at full foe health, uncapped - the card, not a fight',
  }),
  fight: Object.freeze({
    id: 'fight',
    label: 'whole-fight kill rate (health-dependent terms walked)',
    unit: 'dps',
    needsHealth: true,
    needsRelay: false,
    basis: 'pool / ttk of the walk over the foe\'s health (src/fight.js fight)',
  }),
  relay: Object.freeze({
    id: 'relay',
    label: 'relay kill rate (the allowance applied to every claim)',
    unit: 'dps',
    needsHealth: true,
    needsRelay: true,
    basis: 'pool / allowance ttk (src/fight.js fightRelay) - saturates at the relay\'s refill',
  }),
  'relay-ceiling': Object.freeze({
    id: 'relay-ceiling',
    label: 'per-hit-capped offered DPS before the relay',
    unit: 'dps',
    needsHealth: true,
    needsRelay: true,
    basis: 'capped claims / fight seconds - a ceiling, not an outcome; the discriminator when relay ties',
  }),
});
export const OBJECTIVE_IDS = Object.freeze(Object.keys(OBJECTIVES));

/** What a ranking was computed against: the target's identity, defences and, for a relay body, its allowance. */
export function targetAssumptions(target) {
  if (!target) return null;
  return {
    kind: target.allowance ? 'relay' : (target.isBoss ? 'boss' : 'foe'),
    mobileType: target.mobileType ?? null,
    careerIndex: target.careerIndex ?? null,
    group: target.group ?? null,
    level: target.level ?? null,
    combatLevel: target.combatLevel ?? null,
    maxHealth: target.maxHealth ?? null,
    hitCap: num(target.hitCap, 0),
    traits: [...(target.bossTraits ?? [])],
    minMetalToHit: target.minMetalToHit ?? null,
    allowance: target.allowance
      ? { level: target.allowance.level, players: target.allowance.players, phases: target.allowance.phases?.length ?? 0 }
      : null,
  };
}

/**
 * One build on one objective, with the objective and the target it was computed against.
 *
 * @param {object} ch  the build, as `analyze` reads it
 * @param {object} opts  `objective` (one of OBJECTIVE_IDS), `target` (required), `health` (the pool), and any `analyze`
 *   scenario option (`weapon`, `core`, `backstabUptime`, ...) - the same options the plain calculation takes
 */
export function evaluateObjective(ch, { objective = 'snapshot', target = null, health = null, ...scenario } = {}) {
  const def = OBJECTIVES[objective];
  if (!def) throw new Error(`evaluateObjective: unknown objective "${objective}" (one of ${OBJECTIVE_IDS.join(', ')})`);
  if (!target) throw new Error(`evaluateObjective("${objective}"): a declared target is required`);
  if (def.needsRelay && !target.allowance) throw new Error(`evaluateObjective("${objective}"): the target is not a relay body (no allowance)`);
  const pool = health == null ? num(target.maxHealth, 0) : num(health, 0);
  if (def.needsHealth && !(pool > 0)) throw new Error(`evaluateObjective("${objective}"): a positive target health is required`);
  const assumptions = { objective, target: targetAssumptions(target), health: def.needsHealth ? pool : null, basis: def.basis };
  const base = { objective, unit: def.unit, direction: 'max', assumptions };

  if (objective === 'snapshot') {
    const r = analyze(ch, { ...scenario, target, health: pool || undefined, healthShare: scenario.healthShare ?? 1 });
    return { ...base, value: r.dps, detail: { dps: r.dps, cappedDps: r.cappedDps, perSwing: r.perSwing, hit: r.hit.hit, aps: r.cadence.aps } };
  }
  if (objective === 'fight') {
    const f = fight(ch, { ...scenario, target, health: pool });
    if (!f) throw new Error('evaluateObjective("fight"): the build cannot empty the pool');
    return { ...base, value: f.killDps, detail: { killDps: f.killDps, outputDps: f.outputDps, ttk: f.ttk, blows: f.blows, overkill: f.overkill, segments: f.segments.length } };
  }
  const fr = fightRelay(ch, { ...scenario, target, health: pool });
  if (!fr) throw new Error(`evaluateObjective("${objective}"): the relay fight does not terminate`);
  if (objective === 'relay') {
    return {
      ...base,
      value: fr.killDps,
      detail: {
        killDps: fr.killDps, ttk: fr.ttk, saturated: fr.saturated, ceilingDps: fr.ceilingDps,
        acceptedDps: fr.acceptedDps, uncappedDps: fr.uncappedDps, marginDps: fr.marginDps, cap: fr.cap, refillDps: fr.refillDps,
      },
    };
  }
  return {
    ...base,
    value: fr.ceilingDps,
    detail: { ceilingDps: fr.ceilingDps, saturated: fr.saturated, marginDps: fr.marginDps, ttk: fr.ttk, acceptedDps: fr.acceptedDps, uncappedDps: fr.uncappedDps },
  };
}

/**
 * Rank builds on ONE objective and ONE target. `entries` is `[{ id, ch }]` (a bare `ch` takes the id `i`).
 * Rows are highest-first; every row carries its value, the objective and the target assumptions. A row that cannot be
 * evaluated (a build that cannot kill the pool, a relay objective on a foe) is kept with `error` and sorts last -
 * never silently dropped.
 */
export function rankBuilds(entries, { objective = 'snapshot', target = null, health = null, ...scenario } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('rankBuilds: at least one entry is required');
  const rows = entries.map((e, i) => {
    const ch = e?.ch ?? e?.build ?? e;
    const id = e?.id ?? i;
    try {
      const r = evaluateObjective(ch, { ...scenario, objective, target, health, ...(e?.scenario ?? {}) });
      return { id, value: r.value, ...r };
    } catch (err) {
      return { id, objective, value: null, error: String(err?.message ?? err) };
    }
  });
  // one target, one objective: refuse to compare rows computed against different conditions
  const seen = rows.filter((r) => r.assumptions).map((r) => JSON.stringify(r.assumptions));
  if (new Set(seen).size > 1) throw new Error('rankBuilds: rows were evaluated against different target assumptions');
  const ok = rows.filter((r) => Number.isFinite(r.value)).sort((a, b) => b.value - a.value);
  const failed = rows.filter((r) => !Number.isFinite(r.value));
  ok.forEach((r, i) => { r.rank = i + 1; });
  failed.forEach((r) => { r.rank = null; });
  return {
    objective,
    label: OBJECTIVES[objective]?.label ?? objective,
    target: targetAssumptions(target),
    health: health == null ? num(target?.maxHealth, 0) : num(health, 0),
    rows: [...ok, ...failed],
  };
}
