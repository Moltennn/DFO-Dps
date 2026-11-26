// Focused 14631 differential for the planner forwarding sites (`git show 311c991`), against the REAL `src/*.js`.
//
// Run by `rust/dfo-core/tests/planner_mutants.rs`. The stock SPELLS.STD is a required input (the Rust side parses the same
// records), and each case is one value-codec token of input and one of expected output; the Rust side compares token for
// token. `frontier` and `rank` are projected down to the numbers the gear law can move (their whole rows carry a 14 KB
// item plan each); every other family compares the whole value the JS returns.
//
// Line schema: `<kind> <input> => <expected>`
//   book      (none)                             => readSpellsStd(SPELLS.STD)
//   legal     {weapon, opts}                     => legalGear
//   frontier  {weapon, opts}                     => [lb, cs, dmg, dps, cappedDps, allowanceDps] per row
//   max       {weapon, opts}                     => maxCharacter
//   run       {ch, opts}                         => maxRun (whole card + totals)
//   rank      {family, opts}                     => the host and every row's measured gains
//   plan      opts                               => planEnchants (reads skillGain and applyPlanDps)
//   matrix    opts                               => planMatrix (reads bestWeaponForFamily)
//   best      {family, target, build}            => bestWeaponForFamily
//   template  {template, family, opts}           => realTemplate
//   stage     {template, family, opts}           => the built characters, the blow percent and both stage runs
//   loadouts  {modes, vampire, encounter, build} => the whole universe
//
// Sizing: the JS costs ~2.4 s per `maxCharacter`, ~1.3 s per plan, ~25 s for a matrix and ~55 s for a whole universe, so
// each family is one arm per forwarding site, not a sweep. `shortlistLoadouts` samples 1,000 fights per row and lives in
// `tests/planner_shortlist.rs`. `rankAll` is `families.map(rankFamily)` and adds no forwarding coverage, so the six
// `rank` cases carry it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as M from '../../../src/maxprofile.js';
import * as I from '../../../src/imprints.js';
import * as E from '../../../src/enchantPlan.js';
import * as FB from '../../../src/realBuild.js';
import { gateTarget, referenceFoe } from '../../../src/model.js';
import { arena2Dir } from '../../../src/save.js';
import { readSpellsStd } from '../../../src/spells.js';
import { encodeValue as V } from '../../../tools/rust-codec.mjs';

const dir = arena2Dir();
if (!dir) throw new Error('planner_oracle: no ARENA2 in the launcher config; SPELLS.STD is required');
const book = readSpellsStd(readFileSync(resolve(dir, 'SPELLS.STD')));
if (!book.length) throw new Error('planner_oracle: empty SPELLS.STD');

const lines = [];
const put = (kind, input, expected) => lines.push(`${kind} ${V(input)} => ${V(expected)}`);
const gate = () => gateTarget(45);
const tough = () => referenceFoe(45, 'tough');
const familyOf = (key) => I.IMPRINT_FAMILIES.find((f) => f.key === key);

/** The frontier's numbers, without the 14 KB item plan each legal point carries. */
const frontierOf = (rows) => rows.map((p) => [p.lb, p.cs, p.dmg, p.dps, p.cappedDps, p.allowanceDps]);
/** `rankFamily`: the host it picked, both its prices, and every power's measured gain. */
const rankOf = (r) => ({
  key: r.key, template: r.template,
  base: r.base.carriedCappedDps, uncapped: r.uncapped.carriedDps,
  rows: r.rows.map((x) => [x.id, x.template, x.baseDps, x.conditionalDps, x.uncappedDps, x.delta, x.triggerDelta, x.uncappedDelta]),
});

// The fixture the Rust side parses into its `Spellbook`.
put('book', undefined, book);

// ── maxprofile: the evaluated frontier, the legal budget, the max character and the card ──────────────────────────────
for (const weapon of [118, 560, 562, 123, 124, 130]) {
  for (const opts of [
    { gameBuild: '14631' },
    { gameBuild: '14631', shield: 112 },
    { gameBuild: '14631', metric: 'capped' },
    { gameBuild: '14631', metric: 'allowance' },
    { gameBuild: '14512', metric: 'capped' },
  ]) put('legal', { weapon, opts }, M.legalGear(weapon, opts));
  for (const opts of [
    { gameBuild: '14631' },
    { gameBuild: '14631', metric: 'capped' },
    { gameBuild: '14512' },
  ]) put('frontier', { weapon, opts }, frontierOf(M.legalFrontier(weapon, opts)));
  for (const opts of [
    { gameBuild: '14631' },
    { gameBuild: '14631', firmament: true },
    { gameBuild: '14631', vampire: true },
    { gameBuild: '14512', firmament: true },
  ]) put('max', { weapon, opts }, M.maxCharacter(weapon, opts));
  const ch = M.maxCharacter(weapon, { gameBuild: '14631' });
  for (const opts of [
    { gameBuild: '14631' },
    { gameBuild: '14631', gate: true },
    { gameBuild: '14631', target: tough() },
    { gameBuild: '14512' },
  ]) put('run', { ch, opts }, M.maxRun(ch, opts));
}

// ── imprints: every family the ranking reads, at each sort/firmament arm ──────────────────────────────────────────────
for (const key of ['LongBlade', 'ShortBlade', 'Axe', 'BluntWeapon', 'Archery', 'HandToHand']) {
  const family = familyOf(key);
  for (const opts of [
    { gameBuild: '14631' },
    { gameBuild: '14631', sort: 'uncapped' },
    { gameBuild: '14631', sort: 'conditional', firmament: true, vampire: true },
    { gameBuild: '14512' },
  ]) put('rank', { family, opts }, rankOf(I.rankFamily(family, opts)));
}

// ── enchantPlan: the plan (skillGain + applyPlanDps), the matrix (bestWeaponForFamily) and the best weapon ────────────
for (const weapon of [118, 124, 560]) {
  for (const opts of [
    { weapon, gameBuild: '14631' },
    { weapon, gameBuild: '14631', forceSkills: true, target: tough() },
    { weapon, gameBuild: '14631', soulGem: true, group: 'undead', repairs: 3, regen: 2 },
    { weapon, gameBuild: '14512', forceSkills: true },
  ]) put('plan', opts, E.planEnchants(opts));
}
put('matrix', { gameBuild: '14631' }, E.planMatrix({ gameBuild: '14631' }));
for (const key of ['LongBlade', 'ShortBlade', 'Axe', 'BluntWeapon', 'Archery', 'HandToHand']) {
  for (const target of [gate(), tough()]) {
    for (const build of ['14631', '14512']) {
      put('best', { family: familyOf(key), target, build }, E.bestWeaponForFamily(familyOf(key), target, build));
    }
  }
}

// ── realBuild: the chain per family at each mode/vampire arm, and the two universes that read it ──────────────────────
const strip = (ch) => {
  const copy = JSON.parse(JSON.stringify(ch));
  return {
    mods: copy._mods,
    firmamentDamagePct: copy.firmamentDamagePct ?? null,
    enchantments: copy.weapon?.enchantments ?? copy.wraps?.enchantments ?? null,
    condition: copy.weapon?.currentCondition ?? copy.wraps?.currentCondition ?? null,
    offEnchantments: copy.offWeapon?.enchantments ?? null,
    offCondition: copy.offWeapon?.currentCondition ?? null,
    dual: copy._dual ?? false,
  };
};
const stageOf = (st) => ({
  capped: st.capped,
  target: { maxHealth: st.target.maxHealth, allowance: st.target.allowance ? true : null },
  treeStars: st.tree.stars,
  treeFreeStars: st.tree.freeStars,
  treeBlow: st.treeCh.firmamentDamagePct,
  treeDps: st.treeRun.carriedCappedDps + st.treeRun.enchantDps,
  enchDps: st.enchRun.carriedCappedDps + st.enchRun.enchantDps,
  gearCh: strip(st.gearCh),
  treeCh: strip(st.treeCh),
  enchCh: strip(st.enchCh),
  imprint: st.imprint,
});
for (const [template, familyKey] of [[118, 'LongBlade'], [124, 'BluntWeapon'], [563, 'HandToHand']]) {
  const family = familyOf(familyKey);
  for (const opts of [
    { gameBuild: '14631' },
    { gameBuild: '14631', mode: 'cap' },
    { gameBuild: '14631', vampire: true },
    { gameBuild: '14512' },
  ]) {
    put('template', { template, family, opts }, FB.realTemplate(template, family, opts));
    put('stage', { template, family, opts }, stageOf(FB.realBuildStages(template, family, opts)));
  }
}
for (const [mode, build] of [['uncapped', '14631'], ['cap', '14512']]) {
  put('loadouts', { modes: [mode], vampire: false, encounter: 'breach', build },
    FB.realWeaponLoadouts({ modes: [mode], vampire: false, encounter: 'breach', gameBuild: build }));
}
console.log(lines.join('\n'));
