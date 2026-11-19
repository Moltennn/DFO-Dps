import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OBJECTIVE_IDS, STOCHASTIC_OBJECTIVE_IDS, evaluateObjective } from '../src/objectives.js';
import { referenceFoe } from '../src/model.js';
import { legalGear } from '../src/maxprofile.js';
import { DEFAULT_BLADE, theoryCharacter } from '../src/theory.js';

const bin = fileURLToPath(new URL('../bin/dfo-dps.js', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
function run(...args) {
  const result = cli('objective', '--theory', ...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('objective CLI defaults to the library snapshot', () => {
  const gear = legalGear(DEFAULT_BLADE);
  const ch = theoryCharacter({ gearLB: gear.lb, gearCS: gear.cs, damagePct: gear.dmg });
  const expected = evaluateObjective(ch, { target: referenceFoe(ch.level, 'soft'), rri: true });
  const row = JSON.parse(run('--target', 'soft', '--json'));
  assert.equal(row.objective, 'snapshot');
  assert.equal(row.value, expected.value);
  assert.equal(row.seed, 0);
});

test('objective CLI rejects invalid objective, trials, target, pool and seed with exit 2', () => {
  const cases = [
    [['--objective', 'toString'], /unknown objective/],
    [['--objective', 'stochastic-ttk', '--trials', '999'], /at least 1000 trials/],
    [['--trials', '1000.5'], /--trials.*integer/],
    [['--objective', 'stochastic-relay'], /not a relay body/],
    [['--objective', 'fight', '--health', '0'], /positive.*--health/],
    [['--seed', '1.25'], /--seed.*integer/],
  ];
  for (const [args, message] of cases) {
    const result = cli('objective', '--theory', '--target', 'soft', ...args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, message);
    if (args.includes('toString')) {
      assert.ok(result.stderr.includes([...OBJECTIVE_IDS, ...STOCHASTIC_OBJECTIVE_IDS].join(', ')));
    }
  }
});

test('objective CLI treats relay --health as the total pool, independent of players', () => {
  const row = JSON.parse(run('--objective', 'relay', '--target', 'gate', '--health', '500', '--players', '3', '--json'));
  assert.equal(row.assumptions.health, 500);
  assert.equal(row.assumptions.target.maxHealth, 500);
  assert.equal(row.assumptions.target.allowance.players, 3);
});

test('relay text labels the simulated pool as the per-player share, and the kill count beside the TTK interval', () => {
  const text = run('--objective', 'stochastic-relay', '--target', 'gate', '--health', '500', '--players', '3', '--trials', '1000', '--max-seconds', '10');
  assert.match(text, /Pool per player \(simulated share\): 166\.67 \(total 500 \/ 3 players\)/);
  assert.doesNotMatch(text, /Total pool/);
  assert.match(text, /Mean TTK \(95% CI, kills only\): .* from \d+ kills/);
});

test('deterministic text prints Carry n/a; sampled text keeps on/off', () => {
  assert.match(run('--target', 'soft'), /Carry: n\/a/);
  const sampled = run('--objective', 'stochastic-ttk', '--target', 'soft', '--health', '5000', '--max-seconds', '10');
  assert.match(sampled, /Carry: on/);
  assert.doesNotMatch(sampled, /Carry: n\/a/);
});

test('sampled objective CLI is reproducible, with opt-in samples and carry', () => {
  const args = ['--objective', 'stochastic-ttk', '--target', 'soft', '--health', '5000', '--seed', '7', '--max-seconds', '10', '--max-blows', '12', '--star-damage', '17'];
  const first = run(...args, '--json', '--samples');
  assert.equal(run(...args, '--json', '--samples'), first);
  const carried = JSON.parse(first);
  const floored = JSON.parse(run(...args, '--json', '--samples', '--no-carry'));
  assert.equal(carried.carry, true);
  assert.equal(carried.assumptions.carry, true);
  assert.equal(floored.carry, false);
  assert.equal(floored.assumptions.carry, false);
  assert.equal(carried.seed, 7);
  assert.equal(carried.n, 1000);
  assert.equal(carried.horizonSeconds, 10);
  assert.equal(carried.damageMode, 'uncapped');
  assert.equal(carried.detail.samples.length, 1000);
  assert.ok(carried.detail.samples.some((row, i) => row.ttk !== floored.detail.samples[i].ttk));
  const compact = JSON.parse(run(...args, '--json'));
  assert.equal(compact.value, carried.value);
  assert.equal(Object.hasOwn(compact.detail, 'samples'), false);
  assert.equal(Object.hasOwn(compact.detail, 'seeds'), false);
  const text = run(...args);
  assert.match(text, /Horizon: 10 s/);
  assert.match(text, /Damage mode: uncapped/);
  assert.match(text, /Wilson 95%/);
  assert.match(text, /Mean TTK.*95% CI/);
});

test('objective CLI refuses a boss, gate or trait target for sampled non-relay objectives', () => {
  const cases = [
    ['--target', 'boss', '--health', '12000', '--objective', 'stochastic-ttk'],
    ['--target', 'gate', '--objective', 'kill-probability'],
    ['--target', 'soft', '--traits', 'curbing', '--objective', 'stochastic-ttk'],
  ];
  for (const args of cases) {
    const result = cli('objective', '--theory', ...args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /plain ordinary foe/);
    assert.match(result.stderr, /supported targets: soft, tough, armoured, human/);
  }
});

test('existing build text is unchanged', () => {
  const result = cli('build', '--theory', '--target', 'soft');
  assert.equal(result.status, 0, result.stderr);
  // SHA-256 of the complete stdout captured before adding the objective command.
  assert.equal(createHash('sha256').update(result.stdout).digest('hex'), '271f99f448303a74ee9230743ca1684caa4a657598aa27f896e453359da8489c');
});
