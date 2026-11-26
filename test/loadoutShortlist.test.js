import test from 'node:test';
import { NEEDS_SPELLBOOK } from './harness/spellbook.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WEAPONS } from '../src/data.js';
import { IMPRINT_FAMILIES } from '../src/imprints.js';
import { shortlistLoadouts } from '../src/loadoutShortlist.js';
import { isSampledLoadout, realBuildStages, realTemplate, realWeaponLoadouts } from '../src/realBuild.js';
import { pairedFightSeeds, simulateFights } from '../src/simulateFight.js';

const cli = (...args) => spawnSync(process.execPath, ['bin/dfo-dps.js', 'loadout', ...args], { encoding: 'utf8' });

test('invalid shortlist options exit 2', () => {
  for (const [args, message] of [
    [['--shortlist=-1'], /shortlist/],
    [['--shortlist', '1.5'], /shortlist/],
    [['--shortlist', '9999'], /eligible|universe/],
    [['--shortlist', '1', '--objective', 'stochastic-relay'], /uncapped/],
    [['--shortlist', '1', '--cap-aware', '--objective', 'kill-probability'], /stochastic-relay/],
    [['--shortlist', '1', '--trials', '999'], /1000/],
    [['--shortlist', '1', '--cap-aware', '--health', '100'], /--health does not apply/],
    [['--shortlist', '1', '--health', '0'], /--health must be a positive/],
    [['--shortlist', '1', '--no-carry'], /--no-carry does not apply to --shortlist/],
  ]) {
    const result = cli(...args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, message);
  }
});

test('shortlist off leaves the default table and HTML bytes alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loadout-shortlist-'));
  try {
    const out = join(dir, 'loadouts.html');
    const baseline = cli('--uncapped', '--out', out);
    assert.equal(baseline.status, 0, baseline.stderr);
    const html = readFileSync(out);
    const off = cli('--uncapped', '--out', out, '--shortlist', '0');
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.stdout, baseline.stdout);
    assert.deepEqual(readFileSync(out), html);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shortlist preserves the build and imprint, and samples candidates on common seeds', () => {
  const all = realWeaponLoadouts({ modes: ['uncapped'] });
  const [top] = all.filter((r) => r.family !== 'Archery' && r.category !== 'Fists')
    .sort((a, b) => b.totalDps - a.totalDps);
  const family = IMPRINT_FAMILIES.find((f) => f.key === top.key);
  const { category, ...rest } = top;
  const template = realTemplate(top.template, family, { dual: top.dual });
  assert.deepEqual(rest, template);
  assert.equal(category, top.dual ? 'DW' : WEAPONS[top.template].twoHanded ? '2H' : '1H');
  assert.deepEqual(Object.keys(template).sort(), [
    'averageDps', 'burst5', 'calibrated', 'cardEnchDps', 'cardTotalDps', 'cardTreeDps', 'ceilingDps', 'dual',
    'enchDps', 'enchPlan', 'encounter', 'family', 'freeStars', 'imprint', 'imprintPower', 'key', 'landedShare', 'metric',
    'mode', 'sustainedDps', 'template', 'totalDps', 'treeBlow', 'treeDps', 'treeStars', 'ttk', 'weapon',
  ]);
  const opts = { mode: 'uncapped', seed: 71, maxBlows: 20 };
  const one = shortlistLoadouts({ ...opts, k: 1 });
  assert.equal(one.rows.length, 1);
  for (const field of ['template', 'category', 'imprint', 'dual']) assert.equal(one.rows[0][field], top[field]);
  assert.equal(one.rows[0].deterministicTotalDps, top.totalDps);

  const many = shortlistLoadouts({ ...opts, k: 2 });
  assert.deepEqual(many, shortlistLoadouts({ ...opts, k: 2 }));
  assert.equal(many.rows.length, 2);
  for (const row of many.rows) {
    assert.ok(!row.error, row.error);
    assert.equal(row.n, 1000);
    assert.equal(row.damageMode, 'uncapped');
    assert.deepEqual(row.detail.seeds, pairedFightSeeds(1000, 71));
    assert.deepEqual(row.detail.samples.map(({ seed }) => seed), row.detail.seeds);
  }
});

test('a sampled row runs under the same swing law as its deterministic row (rri, overhaul core)', () => {
  const opts = { mode: 'uncapped', seed: 71, maxBlows: 20, trials: 1000, k: 1, health: 5000 };
  const { rows: [row] } = shortlistLoadouts(opts);
  const [top] = realWeaponLoadouts({ modes: ['uncapped'] }).filter(isSampledLoadout).sort((a, b) => b.totalDps - a.totalDps);
  const { enchCh, imprint, target } = realBuildStages(top.template, IMPRINT_FAMILIES.find((f) => f.key === top.key), { mode: 'uncapped', dual: top.dual });
  const direct = (rri) => simulateFights(enchCh, {
    target, health: 5000, seeds: pairedFightSeeds(1000, 71), maxBlows: 20, imprint: imprint?.power,
    core: 'overhaul', rri, passiveOn: true, stacks: 5,
  });
  const rate = (r) => 5000 / r.ttk.mean;
  assert.equal(row.value, rate(direct(true)), 'the sampled score is the RRI fight, draw for draw');
  // The vanilla swing law is a different fight, so the fixture can tell the two apart.
  assert.notEqual(rate(direct(true)), rate(direct(false)), 'fixture must distinguish RRI from vanilla');
});

test('capped CLI shortlist uses the relay target and keeps its sampling metadata', () => {
  const result = cli('--shortlist', '1', '--cap-aware', '--encounter', 'skyketch', '--max-seconds', '1', '--json');
  assert.equal(result.status, 0, result.stderr);
  const [ranking] = JSON.parse(result.stdout);
  assert.equal(ranking.objective, 'stochastic-relay');
  assert.equal(ranking.target.kind, 'relay');
  assert.equal(ranking.encounter, 'skyketch');
  const [row] = ranking.rows;
  assert.ok(!row.error, row.error);
  assert.equal(row.damageMode, 'relay');
  assert.equal(row.horizonSeconds, 1);
  assert.equal(row.n, 1000);
  assert.equal(row.killProbability.p, 0);
  assert.equal(row.detail, undefined);
});

test('--health sets the sampled pool; the default 100-point foe kills in one blow and ties', NEEDS_SPELLBOOK, () => {
  // The recorded pairing (both dual short swords tie at 100 points, separate at 40000) is a3eb1605's price order: the
  // live build re-prices the universe and this top-5 list no longer contains those two rows, so the cut is named.
  const tied = cli('--uncapped', '--shortlist', '5', '--trials', '1000', '--seed', '0', '--game-build', '14512');
  assert.equal(tied.status, 0, tied.stderr);
  assert.match(tied.stdout, /pool 100\b/);
  const pooled = cli('--uncapped', '--shortlist', '5', '--trials', '1000', '--seed', '0', '--health', '40000', '--game-build', '14512');
  assert.equal(pooled.status, 0, pooled.stderr);
  assert.match(pooled.stdout, /pool 40000/);
  // Kill rate is the third number in a row (Det. DPS, Proc DPS, Kill rate). At 100 points both dual-wield rows are the
  // same one-blow kill; at 40000 they separate.
  const killRate = (text, weapon) => text.split('\n').find((line) => line.includes(weapon)).match(/\d+\.\d{2}/g)[2];
  assert.equal(killRate(tied.stdout, 'Wakizashi'), killRate(tied.stdout, 'Shortsword'));
  assert.notEqual(killRate(pooled.stdout, 'Wakizashi'), killRate(pooled.stdout, 'Shortsword'));
});

test('uncapped CLI prints the sampled and deterministic rankings side by side', (t) => {
  const start = performance.now();
  const result = cli('--uncapped', '--shortlist', '5', '--trials', '1000');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stochastic-ttk \| pool 100/);
  assert.match(result.stdout, /Cast When Strikes/);
  assert.equal(result.stdout.trimEnd().split('\n').slice(-5).filter((line) => /^\d+\s+\d+/.test(line)).length, 5);
  t.diagnostic(`${result.stdout}\nWall time: ${((performance.now() - start) / 1000).toFixed(2)} s`);
});
