#!/usr/bin/env node
/*
 * tools/gate.mjs - the project gates as single commands, with compact output.
 *
 *   node tools/gate.mjs js [--no-game]          npm test, then vendor:verify
 *   node tools/gate.mjs rust                    rust-data --check, rust-vectors, cargo fmt --check, clippy, cargo test
 *   node tools/gate.mjs all                     js, then rust (when rust/ exists on this branch)
 *   node tools/gate.mjs mutate <file> --tests a,b [--count N] [--seed S]
 *                                               tools/rust-mutate.mjs: lists the mutants the tests do NOT kill
 *   node tools/gate.mjs --help
 *
 * Why this exists: an agent whose shell allowlist is per command cannot run `cd rust && cargo test 2>&1 | grep ...`
 * (every piece of a chain must be allowed, and the denial does not say which piece). One allowed command,
 * `node tools/gate.mjs *`, runs the whole chain here, without a shell, and prints one line per step plus the first
 * failures. Exit code: 0 all steps passed, 1 a step failed, 2 usage.
 *
 *   --keep-going   do not stop at the first failing step
 *   --no-game      js only: run with a HOME that has no launcher config, i.e. as a machine without the game's
 *                  SPELLS.STD (tests that need it are reported as skipped; see test/harness/spellbook.mjs)
 *   --lines N      how many lines of a failure to show (default 25)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rustDir = join(root, 'rust');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? def : argv[i + 1];
};
const maxLines = Number(opt('lines', 25));
const keepGoing = flag('keep-going');

const HELP = `usage: node tools/gate.mjs <js|rust|all|mutate> [options]   (see the header of tools/gate.mjs)`;

const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
const first = (text, n = maxLines) => strip(text).split('\n').filter((l) => l.trim()).slice(0, n).join('\n');

/** Run one program (no shell). */
function run(cmd, args, { cwd = root, env = process.env, timeout = 3_600_000 } = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  return { status: r.error ? 127 : r.status, out, secs, error: r.error };
}

const results = [];
function report(name, ok, summary, detail) {
  results.push({ name, ok });
  console.log(`[${ok ? ' ok ' : 'FAIL'}] ${name}: ${summary}`);
  if (!ok && detail) console.log(detail.split('\n').map((l) => `       ${l}`).join('\n'));
  return ok;
}

// ---- parsers ----------------------------------------------------------------------------------------------------
/** node:test summary lines: "ℹ pass N" etc.; failing test names are lines starting with ✖ (deduplicated). */
function nodeTestSummary(out) {
  const text = strip(out);
  const n = (k) => Number((text.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')) ?? [])[1] ?? NaN);
  const fails = [...new Set(text.split('\n').filter((l) => l.startsWith('✖')).map((l) => l.replace(/\s*\([\d.]+ms\)\s*$/, '')))];
  return { pass: n('pass'), fail: n('fail'), skipped: n('skipped'), tests: n('tests'), fails };
}

/** cargo test: sum every "test result:" line; collect panic messages with the vector file and line. */
function cargoTestSummary(out) {
  const text = strip(out);
  let passed = 0;
  let failed = 0;
  let suites = 0;
  for (const m of text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g)) {
    passed += Number(m[1]);
    failed += Number(m[2]);
    suites += 1;
  }
  const lines = text.split('\n');
  const panics = [];
  for (let i = 0; i < lines.length; i++) {
    if (/panicked at/.test(lines[i])) panics.push([lines[i], lines[i + 1] ?? ''].map((l) => l.trim()).join(' | '));
    else if (/\.txt:\d+/.test(lines[i]) && !panics.includes(lines[i].trim())) panics.push(lines[i].trim());
  }
  const compile = lines.filter((l) => /^error(\[E\d+\])?:/.test(l));
  return { passed, failed, suites, panics, compile };
}

// ---- steps ------------------------------------------------------------------------------------------------------
function stepNpmTest(extraEnv = {}) {
  const r = run('npm', ['test'], { env: { ...process.env, ...extraEnv } });
  const s = nodeTestSummary(r.out);
  const ok = r.status === 0 && s.fail === 0;
  return report('npm test', ok, `${s.pass} pass, ${s.fail} fail, ${s.skipped} skipped (${r.secs}s)`,
    s.fails.slice(0, 15).join('\n') || first(r.out));
}

function stepVendorVerify() {
  const r = run('npm', ['run', '-s', 'vendor:verify']);
  const ok = r.status === 0;
  return report('vendor:verify', ok, ok ? `ok (${r.secs}s)` : `exit ${r.status}`, first(r.out));
}

function stepNode(name, args, okSummary) {
  const r = run(process.execPath, args);
  const ok = r.status === 0;
  const last = strip(r.out).split('\n').filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l)).pop() ?? '';
  return report(name, ok, ok ? `${okSummary ?? last} (${r.secs}s)` : `exit ${r.status}`, first(r.out));
}

function stepCargo(name, args, parse) {
  const r = run('cargo', args, { cwd: rustDir });
  if (parse) {
    const s = cargoTestSummary(r.out);
    const ok = r.status === 0 && s.failed === 0 && s.compile.length === 0;
    return report(name, ok, `${s.passed} passed, ${s.failed} failed in ${s.suites} suites (${r.secs}s)`,
      [...s.compile.slice(0, 6), ...s.panics.slice(0, 8)].join('\n') || first(r.out));
  }
  const ok = r.status === 0;
  return report(name, ok, ok ? `clean (${r.secs}s)` : `exit ${r.status}`, first(r.out));
}

const stop = () => !keepGoing && results.some((r) => !r.ok);

function gateJs() {
  const env = {};
  if (flag('no-game')) {
    env.HOME = mkdtempSync(join(tmpdir(), 'gate-nohome-'));
    console.log('(js gate without game data: HOME has no launcher config)');
  }
  stepNpmTest(env);
  if (!stop()) stepVendorVerify();
}

function gateRust() {
  if (!existsSync(rustDir)) {
    console.log('no rust/ directory on this branch (the port lives on rust-rewrite)');
    results.push({ name: 'rust', ok: false });
    return;
  }
  stepNode('rust-data --check', ['tools/rust-data.mjs', '--check']);
  if (!stop()) stepNode('rust-vectors', ['tools/rust-vectors.mjs'], 'vectors written');
  if (!stop()) stepCargo('cargo fmt --check', ['fmt', '--check']);
  if (!stop()) stepCargo('cargo clippy', ['clippy', '--all-targets', '--', '-D', 'warnings']);
  if (!stop()) stepCargo('cargo test', ['test'], true);
}

function gateMutate() {
  const file = argv[1];
  if (!file || file.startsWith('--')) {
    console.error('usage: node tools/gate.mjs mutate <file under rust/dfo-core/src> --tests a,b [--count N] [--seed S]');
    process.exit(2);
  }
  const passthrough = ['--tests', 'count', 'seed', 'timeout', 'jobs'].flatMap((k) => {
    const name = k.replace(/^--/, '');
    const v = opt(name, undefined);
    return v === undefined ? [] : [`--${name}`, v];
  });
  const r = run(process.execPath, ['tools/rust-mutate.mjs', file, ...passthrough]);
  const text = strip(r.out);
  const summary = text.split('\n').find((l) => new RegExp(`^${file.replace('.', '\\.')}:`).test(l)) ?? first(r.out, 6);
  const survivors = text.split('\n').filter((l) => /^\s+SURVIVOR /.test(l) || /^\s{6}\S/.test(l)).join('\n');
  const survived = Number((summary.match(/(\d+) survived/) ?? [])[1] ?? NaN);
  const ok = r.status === 0 && survived === 0;
  // A survivor is not an error by itself (it may be an equivalent mutant) but it must be looked at: report it as FAIL
  // so an agent cannot call a stage done with an unread list.
  report(`mutate ${file}`, ok, summary.trim(), survivors || first(r.out));
}

// ---- main -------------------------------------------------------------------------------------------------------
const cmd = argv[0];
if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(HELP);
  process.exit(cmd ? 0 : 2);
}
if (cmd === 'js') gateJs();
else if (cmd === 'rust') gateRust();
else if (cmd === 'all') {
  gateJs();
  if (!stop() && existsSync(rustDir)) gateRust();
} else if (cmd === 'mutate') gateMutate();
else {
  console.error(`unknown gate "${cmd}"\n${HELP}`);
  process.exit(2);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nGATE FAILED: ${failed.map((r) => r.name).join(', ')}` : '\nGATE PASSED');
process.exit(failed.length ? 1 : 0);
