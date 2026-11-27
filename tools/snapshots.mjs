#!/usr/bin/env node
/*
 * tools/snapshots.mjs - the committed JS answers of the CLI differential tests (rust/dfo-cli/tests/snapshots/).
 *
 *   node tools/snapshots.mjs check  [--only a,b]
 *   node tools/snapshots.mjs record [--only a,b] [--moved a,b::test --reason ID]
 *
 * Both run the dfo-cli test binaries live against the real JS (DFO_ORACLE=record), one binary at a time, and need every
 * test green: that is what certifies a stored answer. `check` writes nothing and fails if any stored answer would
 * change. `record` writes. New tests are added freely; a CHANGED or REMOVED one is an intended behaviour change and is
 * written only when `--moved` names it (a target, or target::test) and `--reason` says why (a CHANGELOG-MECHANICS.md
 * id). It also refuses a `--moved` name under which nothing moved. A refused run writes nothing.
 *
 * Files are written gzip -9; the MANIFEST digest is over the bytes on disk and the replay gunzips them. Two recordings
 * of one tree are byte identical: a test whose JS call writes a page passes `--out` inside its own fixture root, never
 * the shared checkout cwd, whose new files every concurrently recording call would capture.
 *
 * Replay, without Node in the tests' PATH: `node tools/gate.mjs rust --snapshots`.
 * shortcut: outputs can only be re-recorded while the JS exists; rewriting them from the Rust side is plan stage 7.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const crate = join(root, 'rust', 'dfo-cli');
const dir = join(crate, 'tests', 'snapshots');
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? undefined : argv[i + 1];
};
const list = (name) => opt(name)?.split(',').filter(Boolean) ?? [];
const die = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

const command = argv[0];
if (command !== 'record' && command !== 'check') {
  die('usage: node tools/snapshots.mjs <check|record> [--only a,b] [--moved a,b::test --reason ID]', 2);
}
const only = list('only');
const declared = list('moved');
const reason = opt('reason');
if (declared.length && (!reason || reason.startsWith('--'))) die('--moved needs --reason <changelog id>', 2);

/** A snapshot file as test name -> the bytes of its calls (see tests/common/snapshot.rs for the format). */
function byTest(bytes) {
  const out = new Map();
  let at = 0;
  const line = () => {
    const end = bytes.indexOf(10, at);
    if (end < 0) die('malformed snapshot file');
    const text = bytes.toString('utf8', at, end);
    at = end + 1;
    return text;
  };
  while (at < bytes.length) {
    const start = at;
    const test = /^#call (.*) \d+$/.exec(line())?.[1];
    if (!test) die('malformed snapshot file');
    for (let head = line(); head !== '#end'; head = line()) {
      if (/^(stdout|stderr|file) /.test(head)) at += Number(head.slice(head.lastIndexOf(' ') + 1)) + 1;
    }
    const parts = out.get(test) ?? [];
    parts.push(bytes.subarray(start, at));
    out.set(test, parts);
  }
  return new Map([...out].map(([test, parts]) => [test, Buffer.concat(parts)]));
}

/** The stored bytes are gzip -9; the digest in the MANIFEST is taken over them, as they sit on disk. */
const packed = (bytes) => gzipSync(bytes, { level: 9 });
const unpacked = (bytes) => (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);

const calls = (bytes) => bytes.toString('latin1').match(/^#call /gm)?.length ?? 0;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---- build and run ------------------------------------------------------------------------------------------------
const build = spawnSync('cargo', ['test', '-p', 'dfo-cli', '--no-run', '--message-format=json'],
  { cwd: join(root, 'rust'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
if (build.status !== 0) die(`build failed\n${build.stderr}`);
const targets = build.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
  .filter((m) => m.reason === 'compiler-artifact' && m.profile?.test && m.executable && m.target?.kind?.includes('test'))
  .map((m) => ({ name: m.target.name, exe: m.executable }))
  .sort((a, b) => a.name.localeCompare(b.name));
for (const name of only) if (!targets.some((t) => t.name === name)) die(`--only: no dfo-cli test target "${name}"`, 2);

const work = mkdtempSync(join(tmpdir(), 'dfo-snapshots-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
mkdirSync(join(work, 'config'));
// No game data can reach a snapshot: no launcher config, no user data, the synthetic spellbook.
const env = { ...process.env, DFO_ORACLE: 'record', DFO_SNAPSHOT_STAGE: join(work, 'stage'), PLANNERS_SLOW: '1',
  XDG_CONFIG_HOME: join(work, 'config') };
for (const name of ['DAGGER_USER_DATA', 'DFO_REAL_SPELLS', 'DFO_ORACLE_STATS', 'DFO_SNAPSHOT_DIR']) delete env[name];

const fresh = new Map(); // file name -> bytes (absent: the target made no JS call)
const ran = targets.filter((t) => !only.length || only.includes(t.name));
for (const target of ran) {
  const started = Date.now();
  const r = spawnSync(target.exe, [], { cwd: crate, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status !== 0) {
    die(`${target.name}: not green (${secs}s), nothing written\n${`${r.stdout}\n${r.stderr}`.split('\n').slice(-60).join('\n')}`);
  }
  const stage = join(work, 'stage', target.name);
  if (existsSync(stage)) {
    const bytes = Buffer.concat(readdirSync(stage).sort().map((f) => readFileSync(join(stage, f))));
    if (bytes.includes(homedir())) die(`${target.name}: a recorded answer names the home directory, nothing written`);
    fresh.set(`${target.name}.snap`, bytes);
  }
  console.log(`green ${target.name}: ${calls(fresh.get(`${target.name}.snap`) ?? Buffer.alloc(0))} calls (${secs}s)`);
}

// ---- compare ------------------------------------------------------------------------------------------------------
const committed = new Map((existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith('.snap'))
  .map((f) => [f, unpacked(readFileSync(join(dir, f)))]));
const inScope = (file) => !only.length || only.includes(basename(file, '.snap'));
const moved = [];
const added = [];
for (const file of new Set([...committed.keys(), ...fresh.keys()])) {
  if (!inScope(file)) continue;
  const was = committed.has(file) ? byTest(committed.get(file)) : new Map();
  const now = fresh.has(file) ? byTest(fresh.get(file)) : new Map();
  const target = basename(file, '.snap');
  for (const [test, bytes] of was) {
    if (!now.has(test)) moved.push({ target, test, how: 'removed' });
    else if (!now.get(test).equals(bytes)) moved.push({ target, test, how: 'changed' });
  }
  for (const test of now.keys()) if (!was.has(test)) added.push(`${target}::${test}`);
}
const names = (m, d) => d === m.target || d === `${m.target}::${m.test}`;
console.log(`${added.length} tests added, ${moved.length} moved`);
for (const m of moved.slice(0, 40)) console.log(`  ${m.how} ${m.target}::${m.test}`);

if (command === 'check') process.exit(moved.length || added.length ? 1 : 0);

const undeclared = moved.filter((m) => !declared.some((d) => names(m, d)));
const idle = declared.filter((d) => !moved.some((m) => names(m, d)));
if (undeclared.length) {
  die(`refused, nothing written: ${undeclared.length} stored answers would move without being declared. If the change is intended, `
    + `--moved ${[...new Set(undeclared.map((m) => m.target))].join(',')} --reason <changelog id>`);
}
if (idle.length) die(`refused, nothing written: declared to move but did not: ${idle.join(', ')}`);

// ---- write --------------------------------------------------------------------------------------------------------
mkdirSync(dir, { recursive: true });
const manifestPath = join(dir, 'MANIFEST');
const history = existsSync(manifestPath)
  ? readFileSync(manifestPath, 'utf8').split('\n').filter((l) => l.startsWith('# moved '))
  : [];
if (moved.length) history.push(`# moved ${reason}: ${declared.join(',')}`);
for (const file of committed.keys()) if (inScope(file) && !fresh.has(file)) rmSync(join(dir, file));
for (const [file, bytes] of fresh) writeFileSync(join(dir, file), packed(bytes));
const files = readdirSync(dir).filter((f) => f.endsWith('.snap')).sort();
let raw = 0;
let onDisk = 0;
let total = 0;
const rows = files.map((file) => {
  const bytes = readFileSync(join(dir, file));
  raw += unpacked(bytes).length;
  onDisk += bytes.length;
  total += calls(unpacked(bytes));
  return `${file} ${sha(bytes)} ${calls(unpacked(bytes))}`;
});
writeFileSync(manifestPath, [
  '# Written by `node tools/snapshots.mjs record`: file, SHA-256 (over the gzip bytes on disk), calls. Source: js-parity (the real JS, green run).',
  ...history, ...rows, ''].join('\n'));
console.log(`wrote ${files.length} files, ${total} calls, ${raw} bytes raw, ${onDisk} bytes on disk`);
