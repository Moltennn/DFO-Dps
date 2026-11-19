import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encounterTarget } from '../src/encounters.js';

const bin = fileURLToPath(new URL('../bin/dfo-dps.js', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

function usageError(args, message) {
  const result = cli(...args);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stderr, /\n\s+at /, 'a usage error prints no stack');
  return result;
}

test('an unknown target exits 2 and lists the valid names', () => {
  const result = usageError(['build', '--theory', '--target', 'toguh'], /unknown target "toguh"/);
  assert.match(result.stderr, /soft, tough, armoured, human, boss, gate, breach, ruhn, skyketch, abyss/);
});

test('an encounter target maps to its real relay body, not the tough reference foe', () => {
  const result = cli('build', '--theory', '--target', 'skyketch', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).target.health, encounterTarget('skyketch', 45).maxHealth);
});

test('validation errors exit 2 without a stack', () => {
  usageError(['compare', '--theory'], /compare needs --stat name=value/);
  usageError(['scale', '--theory', '--stat', 'strength', '--stat', 'agility'], /one --stat per run/);
  usageError(['scale', '--theory'], /scale needs --stat/);
  usageError(['graph', '--theory', '--series', 'skill:abc'], /bad skill id/);
  usageError(['graph', '--theory', '--series', 'foo'], /graph series must be/);
  usageError(['graph', '--theory', '--series', 'stat'], /needs an attribute name/);
  usageError(['build', '--theory', '--weapon', '999:9'], /unknown weapon template 999/);
  usageError(['report', '--theory', '--out', '/no/such/dir/x.html'], /cannot write report/);
});

test('an unknown core exits 2', () => {
  usageError(['build', '--theory', '--core', 'clasic'], /unknown core "clasic"/);
});

test('--trials above 1,000,000 exits 2 in objective and loadout --shortlist', () => {
  usageError(['objective', '--theory', '--target', 'soft', '--objective', 'stochastic-ttk', '--trials', '1000001'], /at most 1,000,000 trials/);
  usageError(['loadout', '--theory', '--shortlist', '1', '--trials', '1000001'], /at most 1,000,000 trials/);
});
