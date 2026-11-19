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

const numericCases = [
  [['--level', '0'], /--level.*integer.*1.*45/],
  [['--level', '99999'], /--level.*integer.*1.*45/],
  [['--level', ''], /--level/],
  [['--level', 'abc'], /--level/],
  [['--stacks', '9'], /--stacks.*0.*5/],
  [['--stacks', 'x'], /--stacks/],
  [['--players', '0'], /--players.*at least 1/],
  [['--players', '1.5'], /--players.*integer/],
  [['--players', 'abc'], /--players/],
  [['--health', '0'], /--health.*positive/],
  [['--health', 'abc'], /--health/],
  [['--health', '1e400'], /--health/],
  [['--armor', 'abc'], /--armor/],
  [['--backstab', '2'], /--backstab.*0.*1/],
  [['--backstab', 'abc'], /--backstab/],
  [['--blow-x', '0'], /--blow-x.*positive/],
  [['--blow-x', 'abc'], /--blow-x/],
  [['--trials', '1.5'], /--trials.*integer/],
  [['--trials', 'abc'], /--trials/],
  [['--top', 'abc'], /--top/],
  [['--potency', 'abc'], /--potency/],
  [['--pierce', 'abc'], /--pierce/],
  [['--repairs', 'abc'], /--repairs/],
  [['--regen', 'abc'], /--regen/],
  [['--seconds', 'abc'], /--seconds/],
  [['--health-share', '2'], /--health-share.*0.*1/],
  [['--self-health-share', 'abc'], /--self-health-share/],
  [['--base-stats', 'abc'], /--base-stats/],
  [['--star-damage', 'abc'], /--star-damage/],
  [['--from', 'abc'], /--from/],
  [['--to', 'abc'], /--to/],
  [['--step', 'abc'], /--step/],
];

test('numeric flags reject junk instead of silently using the default', () => {
  for (const [args, message] of numericCases) usageError(['build', '--theory', ...args], message);
});

test('enum and name flags reject unknown values with the valid list', () => {
  usageError(['build', '--theory', '--swing', 'nope'], /--swing.*random.*StrikeLeft/);
  usageError(['build', '--theory', '--traits', 'nope'], /--traits.*warded/);
  usageError(['build', '--theory', '--passive', 'nope'], /--passive.*none.*blademaster/i);
  usageError(['build', '--theory', '--race', 'nope'], /--race.*darkelf/);
  usageError(['imprints', '--theory', '--sort', 'nope'], /--sort.*boss.*uncapped.*conditional/);
  usageError(['enchant-plan', '--theory', '--shield', 'nope'], /--shield.*none.*auto/);
  usageError(['loadout', '--theory', '--encounter', 'nope'], /--encounter.*breach.*skyketch.*abyss/);
  usageError(['build', '--theory', '--weapon', '121:abc'], /--weapon.*material.*0.*9/);
  usageError(['build', '--theory', '--weapon', '121:99'], /--weapon.*material.*0.*9/);
  usageError(['build', '--theory', '--weapon', '121.5:9'], /unknown weapon template/);
});

test('help names every accepted target', () => {
  const result = cli('--help');
  assert.equal(result.status, 0, result.stderr);
  for (const id of ['ruhn', 'skyketch', 'abyss']) assert.match(result.stdout, new RegExp(`\\b${id}\\b`));
});

test('theory --gear-cs 300 leaves the weapon-skill line at its legal default', () => {
  const result = cli('theory', '--gear-cs', '300', '--json');
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.character.maxCs, 300);
  assert.equal(doc.character.maxLb, doc.character.legal.lb);
});
