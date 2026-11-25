import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encounterTarget } from '../src/encounters.js';
import { NEEDS_SPELLBOOK } from './harness/spellbook.mjs';
import { isUsageFailure, UsageError } from '../src/usageError.js';

const bin = fileURLToPath(new URL('../bin/dfo-dps.js', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
const cliWith = (args, env) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

// An empty DFO user-data folder (and home, so probe finds no captures): no save can be found there.
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dfo-dps-nosave-'));
const noSaveEnv = { DAGGER_USER_DATA: emptyHome, HOME: emptyHome };
const tmpOut = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dfo-dps-out-')), 'page.html');

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
  usageError(['report', '--theory', '--out', '/no/such/dir/x.html'], /cannot write \/no\/such\/dir\/x\.html/);
});

test('an unknown core exits 2', () => {
  usageError(['build', '--theory', '--core', 'clasic'], /unknown core "clasic"/);
});

test('--game-build validates and selects the shipped build', () => {
  usageError(['build', '--theory', '--game-build', '14513'], /--game-build must be one of 14512, 14631/);
  // The default and an explicit 14512 are the same card; 14631 is the opt-in drift finding.
  const plain = cli('build', '--theory', '--json');
  const cut = cli('build', '--theory', '--game-build', '14512', '--json');
  const drift = cli('build', '--theory', '--game-build', '14631', '--json');
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(cut.status, 0, cut.stderr);
  assert.equal(drift.status, 0, drift.stderr);
  assert.equal(plain.stdout, cut.stdout, 'no --game-build is 14512');
  assert.notEqual(plain.stdout, drift.stdout, '14631 moves the card');
  assert.ok(JSON.parse(plain.stdout).result.terms.gearAdd === undefined);
  assert.ok(JSON.parse(drift.stdout).result.terms.gearAdd.lo > 0);
});

test('--game-build is rejected by every command that does not read it', () => {
  for (const cmd of ['firmament', 'probe', 'saves', 'doctor', 'spells', 'spell']) {
    const result = cli(cmd, '--theory', '--game-build', '14631');
    assert.equal(result.status, 2, `${cmd}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`--game-build is not read by ${cmd}`));
  }
  // and the commands that do read it accept it (cards and planners alike)
  for (const cmd of ['build', 'rank', 'imprints', 'weapons', 'skills', 'enchant-plan', 'gear-plan']) {
    const result = cli(cmd, '--theory', '--game-build', '14631');
    assert.equal(result.status, 0, `${cmd}: ${result.stderr}`);
  }
});

test('report threads --game-build into the page', () => {
  const out = tmpOut();
  const cut = tmpOut();
  const drift = tmpOut();
  const a = cli('report', '--theory', '--out', cut);
  const b = cli('report', '--theory', '--out', drift, '--game-build', '14631');
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  const page = (f) => fs.readFileSync(f, 'utf8');
  assert.notEqual(page(cut), page(drift), 'the report page moves under 14631');
  assert.match(page(drift), /Gear add \(flat\)/, 'the page carries the gear add');
  // the default is the cut
  const plain = cli('report', '--theory', '--out', out);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(page(out), page(cut), 'no --game-build is 14512');
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

const pageCommands = [
  ['graph', '--theory', '--series', 'stat:strength,stat:agility'],
  ['enchant-plan', '--theory'],
  ['imprints', '--theory'],
  ['firmament', '--build', 'bow'],
];

test('an unwritable --out is a usage error on every page command', () => {
  for (const args of pageCommands) {
    usageError([...args, '--out', '/no/such/dir/x.html'], /cannot write \/no\/such\/dir\/x\.html/);
  }
});

const noFileCommands = [
  ['build', '--theory'],
  ['objective', '--theory', '--target', 'soft'],
  ['rank', '--theory'],
  ['compare', '--theory', '--stat', 'strength=110'],
  ['scale', '--theory', '--stat', 'strength'],
  ['tradeoff', '--theory'],
  ['theory'],
  ['spell', '--theory'],
  ['enchant', '--theory'],
  ['doctor'],
  ['saves'],
];

test('--out is rejected where the command writes no file', () => {
  for (const args of noFileCommands) {
    const result = usageError([...args, '--out', '/no/such/dir/x.html'], /--out is only for commands that write a file/);
    assert.match(result.stderr, new RegExp(`not "${args[0]}"`), result.stderr);
    assert.match(result.stderr, /report, spells, weapons, skills, firmament, imprints, probe/);
  }
});

const noJsonCommands = [
  ['compare', '--theory', '--stat', 'strength=110'],
  ['doctor'],
  ['report', '--theory'],
  ['saves'],
];

test('--json is rejected where the command prints no JSON', () => {
  for (const args of noJsonCommands) {
    const result = usageError([...args, '--json'], /--json is not supported by/);
    assert.match(result.stderr, new RegExp(`"${args[0]}"`), result.stderr);
    assert.match(result.stderr, /commands with JSON output: build, objective, rank/);
  }
});

test('--json is rejected in the modes that ignore it', () => {
  usageError(['spell', '--theory', '--list', '--json'], /--json is not supported by "spell --list"/);
  usageError(['scale', '--theory', '--all', '--json'], /--json is not supported by "scale --all"/);
});

test('compare rejects --all and points at scale --all', () => {
  usageError(['compare', '--theory', '--stat', 'strength=110', '--all'], /compare does not take --all.*scale --all/);
});

test('help describes --all, --data and compare accurately', () => {
  const result = cli('--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scale: every relevant channel/);
  assert.doesNotMatch(result.stdout, /scale\/compare every relevant channel/);
  assert.match(result.stdout, /probe: a capture file/);
  assert.match(result.stdout, /--uncapped or --cap-aware picks one instead/);
});

test('commands that read no save run with an empty save folder', () => {
  const out = tmpOut();
  for (const args of [
    ['imprints', '--out', out],
    ['enchant-plan', '--out', out],
    ['firmament', '--build', 'bow', '--out', out],
    ['loadout', '--uncapped', '--target', 'bogus', '--out', out],
    ['weapons', '--out', out],
    ['saves'],
    ['doctor'],
  ]) {
    const result = cliWith(args, noSaveEnv);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  }
});

test('probe without a capture fails as a usage error, not a save lookup', () => {
  const result = cliWith(['probe'], noSaveEnv);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /probe: no capture/);
  assert.doesNotMatch(result.stderr, /no saves found/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('an unknown command is reported before any save lookup', () => {
  const result = cliWith(['buidl'], noSaveEnv);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /unknown command "buidl"/);
  assert.doesNotMatch(result.stderr, /no saves found/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('a missing or named-away save is a usage error', () => {
  const missing = cliWith(['build', '--target', 'soft'], noSaveEnv);
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /no saves found under .*Saves/);
  assert.doesNotMatch(missing.stderr, /\n\s+at /);
  const named = cliWith(['rank', '--save', 'nope'], noSaveEnv);
  assert.equal(named.status, 2, named.stderr);
  assert.match(named.stderr, /save "nope" not found/);
  assert.doesNotMatch(named.stderr, /\n\s+at /);
});

test('star channels and a missing spell are usage errors', () => {
  usageError(['build', '--theory', '--star-stat', 'strength=99'], /Firmament attribute channel is capped/);
  usageError(['build', '--theory', '--star-skill', '99=1'], /bad skill id/);
  usageError(['spell', '--theory', '--spell', 'zzz-nope'], /not found in the resolved spellbook/);
});

test('isUsageFailure keeps internal bugs as crashes', () => {
  assert.equal(isUsageFailure(new UsageError('bad flag')), true);
  assert.equal(isUsageFailure(new RangeError('--shortlist must be positive')), true);
  assert.equal(isUsageFailure(new Error('evaluateObjective("relay"): the target is not a relay body (no allowance)')), true);
  assert.equal(isUsageFailure(new TypeError('Cannot read properties of undefined')), false);
  assert.equal(isUsageFailure(new Error('evaluateObjective("stochastic-ttk"): the sampled fight did not run')), false);
});

test('--json writes JSON and nothing else to stdout for every command that supports it', () => {
  for (const args of [
    ['enchant', '--theory', '--json'],
    ['scale', '--theory', '--stat', 'strength', '--json'],
    ['tradeoff', '--theory', '--json'],
    ['build', '--theory', '--json'],
    ['theory', '--json'],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `${args.join(' ')} must print only JSON`);
  }
});

test('spell --json writes JSON and nothing else to stdout', NEEDS_SPELLBOOK, () => {
  const r = cli('spell', '--theory', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotThrow(() => JSON.parse(r.stdout), 'spell --json must print only JSON');
});
