#!/usr/bin/env node
/*
 * tools/capture-default-build.mjs - freeze a CLI's output for `test/defaultBuild.test.js`.
 *
 *   node tools/capture-default-build.mjs --write            capture the CURRENT default (post-flip: 0.1.14631 is the
 *                                                          live default) into test/fixtures/defaultFlip14512.json
 *   node tools/capture-default-build.mjs --from-dir <dir> --write
 *                                                          freeze a capture made BEFORE the flip (the file list
 *                                                          tools/flip-capture style: <case>.<cli>.json records)
 *
 * The fixture stores, per case, the sha256 of stdout+page and the byte count, so the test compares digests and stays
 * readable. `--from-dir` exists because the pre-flip tree is gone once the flip lands: the evidence is a recorded
 * capture of the old commit's default output.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

/** The cases the flip test pins, with the command each runs. Kept in step with test/defaultBuild.test.js by hand: the
 *  test asserts the fixture's case list equals its own, so a drift fails loudly instead of skipping a command. */
const CASES = [
  ['build', ['build', '--theory', '--json']],
  ['build-text', ['build', '--theory']],
  ['objective', ['objective', '--theory', '--json', '--target', 'tough']],
  ['rank', ['rank', '--theory', '--json']],
  ['compare', ['compare', '--theory', '--stat', 'strength=10']],
  ['scale', ['scale', '--theory', '--json', '--stat', 'strength']],
  ['tradeoff', ['tradeoff', '--theory', '--json']],
  ['theory', ['theory', '--json']],
  ['theory-text', ['theory']],
  ['imprints', ['imprints', '--json']],
  ['enchant-plan', ['enchant-plan', '--json']],
  ['weapons', ['weapons', '--json']],
  ['skills', ['skills', '--json']],
  ['report', ['report', '--theory']],
  ['graph', ['graph', '--theory', '--series', 'stat:strength', '--from', '0', '--to', '20', '--step', '10']],
  ['loadout', ['loadout', '--json', '--uncapped']],
  ['real-dps', ['real-dps', '--json', '--uncapped']],
];
const PAGE_COMMANDS = new Set(['report', 'graph', 'weapons', 'skills', 'imprints', 'enchant-plan', 'loadout', 'real-dps']);

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? null : argv[i + 1];
};

/** Run one case with no --game-build (the default under test) and return its digest payload. */
function captureCurrent(name, args) {
  const root = mkdtempSync(join(tmpdir(), 'dfo-flip-'));
  const page = PAGE_COMMANDS.has(name) ? join(root, `${name}.html`) : null;
  const full = [...args, ...(page ? ['--out', page] : [])];
  const r = spawnSync(process.execPath, [join(repo, 'bin', 'dfo-dps.js'), ...full], {
    encoding: 'utf8',
    env: { ...process.env, DAGGER_USER_DATA: root, HOME: root },
    timeout: 1200000,
  });
  if (r.status !== 0) throw new Error(`${name}: ${r.stderr}`);
  const bytes = page ? readFileSync(page, 'utf8') : '';
  rmSync(root, { recursive: true, force: true });
  // A page-writing command echoes its `--out`; the path is per-run, so it is normalised away (the test does the same).
  const stdout = page ? r.stdout.split(page).join('<OUT>') : r.stdout;
  return {
    name,
    sha256: createHash('sha256').update(stdout).update('\0').update(bytes).digest('hex'),
    bytes: stdout.length + bytes.length,
  };
}

const fromDir = flagValue('from-dir');
const cases = fromDir
  ? JSON.parse(readFileSync(join(fromDir, 'summary-cases.json'), 'utf8'))
  : CASES.map(([name, args]) => captureCurrent(name, args));

const record = {
  version: fromDir ? 'pre-flip default (0.1.14512)' : 'pre-flip default (0.1.14512)',
  note: fromDir
    ? `frozen from a capture of the pre-flip commit's default output (${fromDir})`
    : 'captured from this tree; run it on the pre-flip commit to refresh',
  cases,
};
if (argv.includes('--write')) {
  const out = join(repo, 'test', 'fixtures', 'defaultFlip14512.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote ${out} (${cases.length} cases)`);
} else {
  console.log(JSON.stringify(record, null, 2));
}
