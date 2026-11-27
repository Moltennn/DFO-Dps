#!/usr/bin/env node
/*
 * tools/gate.mjs - the project gates as single commands, with compact output.
 *
 *   node tools/gate.mjs js [--no-game]          npm test, then vendor:verify
 *   node tools/gate.mjs rust                    rust-data --check, rust-vectors, cargo fmt --check, clippy, cargo test
 *   node tools/gate.mjs all                     js, then rust (when rust/ exists on this branch)
 *   node tools/gate.mjs mutate <file> --tests a,b [--count N] [--seed S] [--max-mem SIZE] [--no-mem-cap]
 *                                               tools/rust-mutate.mjs: lists the mutants the tests do NOT kill; every
 *                                               mutant build and test run is memory-capped (tools/mem-cap.mjs)
 *   node tools/gate.mjs --help
 *
 * Why this exists: an agent whose shell allowlist is per command cannot run `cd rust && cargo test 2>&1 | grep ...`
 * (every piece of a chain must be allowed, and the denial does not say which piece). One allowed command,
 * `node tools/gate.mjs *`, runs the whole chain here, without a shell, and prints one line per step plus the first
 * failures. Exit code: 0 all steps passed, 1 a step failed, 2 usage.
 *
 *   --fresh        rust: regenerate the golden vectors even when their inputs are unchanged (cached by input hash)
 *                  the cache key is content-only and portable between copies of one revision (worktree, `git archive`);
 *                  a vectors directory that is a symlink into another tree is reused but never regenerated through it
 *                  also sets DFO_ORACLE=fresh (skip JS-oracle cache reads, still write entries)
 *   --test-jobs N  rust: how many tests run at once (default about 1.2 x the core count, since a test mostly blocks
 *                  on the child CLI it spawns). The unit is the TEST, not the test binary: one process per test, and
 *                  workers take the next test as each finishes, so the longest suite cannot become the tail.
 *                  Use 1 on memory-constrained hosts
 *   --quick        rust: skip the heavy suites by full path (listed below), print each skipped path; the rest runs in
 *                  full, so this is a fast tier, never a subset of cases within a suite
 *   --no-oracle    rust: DFO_ORACLE=off (no JS-oracle cache; every JS call runs live)
 *   --spot F       rust: fraction of cache hits re-run against real JS and compared (default 0.05; 0.25 before a push, 1.0 nightly;
 *                  a mismatch fails the gate and deletes the entry). Ignored with --no-oracle
 *   --tests a,b    rust: run only these test targets (e.g. `--tests rank,doctor`); the build still compiles all
 *   --oracle-dir D rust: the JS-oracle cache directory (default the primary checkout's `.cache/oracle`, shared by every
 *                  worktree: the key is content-only, so each worktree starts warm instead of paying the cold JS cost)
 *   --keep-oracle-stats  rust: keep the per-call stats file the line above is summed from (deleted by default)
 *   --record-timings  rust: write each test binary's measured seconds to tools/gate-timings.json, which orders
 *                  later queues longest-first (unknown timings run first; without the file the build order is kept)
 *   --keep-going   do not stop at the first failing step
 *   --full         rust: also run the opt-in slow tier (PLANNERS_SLOW=1: the sampled loadout/real-dps planner cases,
 *                  minutes each); the pre-push hook passes it, the default gate does not
 *   --real-spells  the opt-in local tier: generators and tests read the launcher's real SPELLS.STD instead of the
 *                  synthetic one (same as DFO_REAL_SPELLS=1; nothing it writes may be committed)
 *   --no-game      run as a machine without the game's SPELLS.STD (js: an empty HOME; rust, Linux: an empty
 *                  XDG_CONFIG_HOME). Spell tests use the synthetic book; see test/harness/spellbook.mjs
 *   --lines N      how many lines of a failure to show (default 25)
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { vectorPlan } from './vector-cache.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rustDir = join(root, 'rust');
const argv = process.argv.slice(2);

/** Parallel work this run may use. `availableParallelism()` counts ALLOWED cpus; a cgroup quota can be lower, and
 *  starting more work than the quota just adds contention (this host under a game: 8 allowed, quota 6). The quota can be
 *  set on any ancestor scope, so walk up from this process's own cgroup. */
function usableCores() {
  const cpus = availableParallelism();
  let group = '';
  try {
    group = (/^0::(.*)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8')) ?? [])[1] ?? '';
  } catch {}
  const parts = group.split('/').filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    let quota, period;
    try {
      [quota, period] = readFileSync(join('/sys/fs/cgroup', ...parts.slice(0, i), 'cpu.max'), 'utf8').trim().split(/\s+/);
    } catch {
      continue;
    }
    if (quota === 'max') return cpus;
    const limit = Math.floor(Number(quota) / Number(period));
    return limit > 0 ? Math.min(cpus, limit) : cpus;
  }
  return cpus;
}
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? def : argv[i + 1];
};
const maxLines = Number(opt('lines', 25));
const keepGoing = flag('keep-going');
// Every child inherits the tier (tools/rust-synth-book.mjs).
if (flag('real-spells')) process.env.DFO_REAL_SPELLS = '1';

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

/** The suites `--quick` skips, by the same full path `cargo test --message-format=json` reports (both crates have a
 *  `planners.rs`, so a bare name would skip the wrong one). Chosen from `--record-timings` on a warm cache: together they
 *  are most of the gate's wall time, and each one's cases are still covered by the full gate. */
const QUICK_SKIP = [
  'dfo-cli/tests/cli_loadout.rs', // the sampled loadout report + shortlist (42 JS calls)
  'dfo-cli/tests/loadout.rs', // the shortlist card/document, 1,000-trial sampler per row
  'dfo-core/tests/real_build.rs', // 7 sampled shortlist vectors, ~17 s each
  'dfo-core/tests/planner_shortlist.rs', // the eligible-pool boundary at the live build
  'dfo-cli/tests/planner_shortlist.rs', // loadout --shortlist at both builds
  'dfo-cli/tests/weapons.rs', // every weapon family priced, page + json
  'dfo-cli/tests/cli_flag_matrix.rs', // every plan template x mode
  'dfo-cli/tests/cli_tradeoff.rs', // the whole tradeoff pool per flag case
  'dfo-cli/tests/cli_imprints.rs', // the full imprint ranking, page + json
  'dfo-cli/tests/cli_enchant_plan.rs', // the plan matrices, page + json
];

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

// ---- fast paths ---------------------------------------------------------------------------------------------------
/** rust-vectors, unless its inputs are unchanged since the vectors on disk were written (--fresh forces it). The key
 *  and the shared-tree guard live in tools/vector-cache.mjs. */
function stepVectors() {
  const vectors = join(rustDir, 'tests', 'vectors');
  const plan = vectorPlan(root, vectors, flag('fresh'));
  if (plan.cached) {
    return report('rust-vectors', true, `cached (inputs unchanged, ${plan.want.slice(0, 10)}); --fresh regenerates`);
  }
  if (plan.want === null) {
    // The generators that read the spell file fail on their own; say so here rather than after a long run.
    return report('rust-vectors', false, "real tier: no readable SPELLS.STD (the launcher config's ARENA2), so nothing can be reused or stamped");
  }
  if (plan.link) {
    // Writing through the link would regenerate the owning tree's vectors: fail closed, regenerate there instead.
    return report('rust-vectors', false, `refusing to regenerate through ${plan.link}`);
  }
  const ok = stepNode('rust-vectors', ['tools/rust-vectors.mjs'], 'vectors written');
  if (ok) writeFileSync(plan.stamp, `${plan.want}\n`);
  return ok;
}

/** Measured seconds per test binary from an earlier `--record-timings` run; missing entries keep the build order. */
function recordedTimings() {
  try {
    return JSON.parse(readFileSync(join(root, 'tools', 'gate-timings.json'), 'utf8'));
  } catch {
    return {};
  }
}

// ---- JS-oracle cache ----------------------------------------------------------------------------------------------
/** The one cache directory every worktree of this repository shares, under the PRIMARY checkout's `.cache/`, so each
 *  worktree starts warm instead of paying the cold JS cost again. The key is content-only (the fixture bytes are
 *  canonicalised; `tests/oracle_key.rs` proves a fixture root at another path keys the same), so sharing is safe.
 *  A worktree knows its primary through its git common dir. */
function sharedOracleDir() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    if (common) return join(dirname(common), '.cache', 'oracle');
  } catch {}
  return join(root, '.cache', 'oracle');
}

/** The cache settings the rust gate hands to every test binary (see rust/dfo-cli/tests/common/oracle.rs). `--no-oracle`
 *  runs every JS call live; otherwise `--fresh` writes entries without reading, and the default reuses them at
 *  `--spot` (default 0.05, the push gate 0.25, 1.0 re-runs every hit). */
function oraclePlan() {
  const off = flag('no-oracle');
  const dir = opt('oracle-dir', sharedOracleDir());
  const stats = join(dir, `stats-${process.pid}.txt`);
  rmSync(stats, { force: true });
  mkdirSync(dir, { recursive: true });
  // `off` is set explicitly, so an inherited DFO_ORACLE=use cannot turn the cache back on.
  const env = off ? { DFO_ORACLE: 'off' } : { DFO_ORACLE: flag('fresh') ? 'fresh' : 'use', DFO_ORACLE_DIR: dir,
    DFO_ORACLE_SPOT: opt('spot', '0.05'), DFO_ORACLE_STATS: stats, DFO_ORACLE_SALT: randomUUID() };
  return { off, dir, stats, env };
}

/** Read the stats file the test binaries wrote: `hit/miss/uncacheable/corrupt/spot` lines, one per JS call. */
function oracleSummary(path) {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  let hit = 0, miss = 0, uncacheable = 0, corrupt = 0, spot = 0, mismatch = 0, saved = 0;
  const reasons = new Map();
  for (const line of text.split('\n')) {
    if (line.startsWith('hit ')) { hit++; saved += Number(line.slice(4)) || 0; }
    else if (line.startsWith('miss ')) miss++;
    else if (line.startsWith('uncacheable ')) {
      uncacheable++;
      // `uncacheable <reason> (<secs>)`: the reason is what a slow gate needs to see, so tally it without the timing.
      const reason = line.slice('uncacheable '.length).replace(/ \([\d.]+s\)$/, '');
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    else if (line === 'corrupt') corrupt++;
    else if (line.startsWith('spot ')) {
      spot++;
      if (line === 'spot mismatch') mismatch++;
      // `spot ok <stored_secs> <live_secs>`: the hit above saved nothing.
      const stored = line.startsWith('spot ok ') ? Number(line.split(' ')[2]) : 0;
      if (Number.isFinite(stored)) saved -= stored;
    }
  }
  return { hit, miss, uncacheable, corrupt, spot, mismatch, saved: Math.max(saved, 0), reasons };
}

/** cargo test, with the test binaries run as separate processes in parallel (cargo runs them one after another). */
async function stepCargoTestParallel(oracleEnv = {}) {
  const t0 = Date.now();
  const build = run('cargo', ['test', '--no-run', '--message-format=json'], { cwd: rustDir });
  const exes = [];
  const diagnostics = [];
  for (const line of build.out.split('\n')) {
    if (!line.startsWith('{')) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    // Keyed by test file: five names exist in both crates (`enchant_plan`, `theory`, ...), so a bare target name
    // would let one binary's timing overwrite the other's and order the queue by the wrong number.
    if (m.reason === 'compiler-artifact' && m.profile?.test && m.executable) {
      const src = m.target?.src_path;
      const name = src ? relative(rustDir, src).split('\\').join('/') : m.target?.name ?? m.executable;
      exes.push({ exe: m.executable, name });
    }
    if (m.reason === 'compiler-message' && m.message?.level === 'error') diagnostics.push(m.message.rendered.split('\n')[0]);
  }
  if (build.status !== 0 || exes.length === 0) {
    return report('cargo test', false, 'build failed', [...diagnostics.slice(0, 6), first(build.out.replace(/^\{.*$/gm, ''), 12)].join('\n'));
  }
  const cores = usableCores();
  // Measured on 16 free cores, warm cache, same workload: a per-BINARY queue at 6 jobs x 3 threads = 224 s, while a
  // per-TEST queue with ~cores workers = 202 s. The binary queue loses because the queue is longest-first and the
  // longest suite stays on one worker for its whole run; its shortest tests then sit behind its longest one. A test is
  // the real unit of work: one process per test, so every worker keeps taking the next test until the queue is empty.
  const workers = Math.max(1, Number(opt('test-jobs', Math.round(cores * 1.2))));
  // `--quick` drops whole heavy suites by full path and says which, so a fast tier is never silently narrower.
  if (flag('quick')) {
    const before = exes.length;
    exes.splice(0, exes.length, ...exes.filter((e) => !QUICK_SKIP.includes(e.name)));
    for (const name of QUICK_SKIP) console.log(`       --quick skips ${name}`);
    console.log(`       --quick: ${exes.length} of ${before} suites run`);
  }
  // `--tests` narrows the run to named targets (a cold/warm proof without the whole suite); the build still
  // compiles every test binary, so this only changes what runs.
  const only = opt('tests', undefined)?.split(',').filter(Boolean);
  if (only && only.length) {
    exes.splice(0, exes.length, ...exes.filter((e) => only.some((name) => e.name.endsWith(`/tests/${name}.rs`))));
  }
  if (exes.length === 0) return report('cargo test', false, 'no test target matched --tests');
  const timings = recordedTimings();
  // One `--list` per binary, then one queue of tests. Every binary's own tests are independent, so this loses nothing.
  const work = [];
  for (const e of exes) {
    const listed = run(e.exe, ['--list'], { env: { ...process.env, ...oracleEnv } });
    const tests = strip(listed.out).split('\n').filter((l) => l.endsWith(': test')).map((l) => l.slice(0, -': test'.length));
    if (listed.status !== 0 || tests.length === 0) return report('cargo test', false, `no tests listed by ${e.name}`, first(listed.out));
    // A binary with no record sorts first: it may be the longest. Otherwise split its recorded seconds evenly (that is
    // the only per-binary number there is); the first recorded run replaces this estimate with real per-test seconds.
    const known = timings[e.name] !== undefined;
    const each = known ? timings[e.name] / tests.length : Infinity;
    for (const test of tests) work.push({ exe: e.exe, name: e.name, test, est: each });
  }
  // Longest first: the last test to start must not be the longest one. Equal estimates keep the build order.
  work.sort((a, b) => b.est - a.est);
  const outputs = [];
  const queue = [...work];
  let done = 0;
  await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, async () => {
    while (queue.length) {
      const w = queue.shift();
      const started = Date.now();
      const r = await new Promise((res) => {
        const c = spawn(w.exe, ['-q', '--exact', w.test], { cwd: join(rustDir, 'dfo-core'), stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...oracleEnv } });
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { out += d; });
        c.on('close', (status) => res({ name: w.name, test: w.test, status, out }));
        c.on('error', () => res({ name: w.name, test: w.test, status: 127, out }));
      });
      outputs.push({ ...r, secs: (Date.now() - started) / 1000 });
      done += 1;
    }
  }));
  const slowest = [...outputs].sort((a, b) => b.secs - a.secs);
  if (flag('record-timings')) {
    // Per BINARY seconds (sum of its tests), the unit `recordedTimings()` reads. Only binaries that ran are written, so
    // a `--tests` or `--quick` run never erases the rest; a re-run replaces its own number instead of adding to it.
    const fresh = new Map();
    for (const o of outputs) fresh.set(o.name, (fresh.get(o.name) ?? 0) + o.secs);
    const map = { ...timings };
    for (const [name, secs] of fresh) map[name] = Number(secs.toFixed(1));
    const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(join(root, 'tools', 'gate-timings.json'), `${JSON.stringify(sorted, null, 2)}\n`);
  }
  let passed = 0;
  let failed = 0;
  const details = [];
  for (const o of outputs) {
    const s = cargoTestSummary(o.out);
    passed += s.passed;
    failed += s.failed;
    if (o.status !== 0 || s.failed > 0) details.push(`[${o.name} ${o.test}] ${[...s.panics.slice(0, 3), s.panics.length ? '' : first(o.out, 6)].filter(Boolean).join(' | ')}`);
  }
  const ok = details.length === 0;
  console.log(`       slowest: ${slowest.slice(0, 8).map((o) => `${o.test} ${o.secs.toFixed(1)}s`).join(', ')}`);
  return report('cargo test', ok, `${passed} passed, ${failed} failed in ${done} tests over ${exes.length} suites, ${Math.min(workers, work.length)} workers (${((Date.now() - t0) / 1000).toFixed(1)}s)`, details.slice(0, 8).join('\n'));
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

async function gateRust() {
  if (!existsSync(rustDir)) {
    console.log('no rust/ directory on this branch (the port lives on rust-rewrite)');
    results.push({ name: 'rust', ok: false });
    return;
  }
  if (flag('no-game')) {
    // Linux user-data base (`src/save.js` userDataDir): an empty one, so no child finds a launcher config. HOME stays,
    // cargo and rustup live under it.
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'gate-noconfig-'));
    delete process.env.DAGGER_USER_DATA;
    console.log('(rust gate without game data: XDG_CONFIG_HOME is empty, DAGGER_USER_DATA unset)');
  }
  stepNode('rust-data --check', ['tools/rust-data.mjs', '--check']);
  if (!stop()) stepVectors();
  if (!stop()) stepCargo('cargo fmt --check', ['fmt', '--check']);
  if (!stop()) stepCargo('cargo clippy', ['clippy', '--all-targets', '--', '-D', 'warnings']);
  const oracle = oraclePlan();
  if (!stop()) await stepCargoTestParallel(flag('full') ? { ...oracle.env, PLANNERS_SLOW: '1' } : oracle.env);
  // The line comes after the cargo test step even when it did not run, so a floor of `0` is visible too.
  const s = oracleSummary(oracle.stats);
  if (s) {
    console.log(`       oracle: ${s.hit} hit, ${s.miss} miss, ${s.uncacheable} uncacheable, ${s.corrupt} corrupt; ` +
      `spot ${s.spot} checked, ${s.mismatch} mismatch; est. saved ${s.saved.toFixed(1)} s`);
    // Why a call can never be cached, so a dirty fixture root or an outside path is visible instead of an unexplained
    // miss count. Sorted by count; the reason text already names the file or the flag.
    const top = [...s.reasons].sort((a, b) => b[1] - a[1]).slice(0, 6);
    for (const [reason, n] of top) console.log(`       uncacheable x${n}: ${reason}`);
    if (s.mismatch > 0) report('oracle spot', false, `${s.mismatch} spot mismatch(es); the cache cannot hide JS drift`);
  }
  if (flag('keep-oracle-stats')) console.log(`       oracle stats: ${oracle.stats}`);
  else rmSync(oracle.stats, { force: true });
}

function gateMutate() {
  const file = argv[1];
  if (!file || file.startsWith('--')) {
    console.error('usage: node tools/gate.mjs mutate <file under rust/dfo-core/src> --tests a,b [--count N] [--seed S]');
    process.exit(2);
  }
  const passthrough = ['--tests', 'count', 'seed', 'timeout', 'jobs', 'max-mem'].flatMap((k) => {
    const name = k.replace(/^--/, '');
    const v = opt(name, undefined);
    return v === undefined ? [] : [`--${name}`, v];
  });
  if (flag('no-mem-cap')) passthrough.push('--no-mem-cap');
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
else if (cmd === 'rust') await gateRust();
else if (cmd === 'all') {
  gateJs();
  if (!stop() && existsSync(rustDir)) await gateRust();
} else if (cmd === 'mutate') gateMutate();
else {
  console.error(`unknown gate "${cmd}"\n${HELP}`);
  process.exit(2);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nGATE FAILED: ${failed.map((r) => r.name).join(', ')}` : '\nGATE PASSED');
process.exit(failed.length ? 1 : 0);
