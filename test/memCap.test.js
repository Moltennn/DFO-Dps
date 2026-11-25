/*
 * test/memCap.test.js - the memory-cap arithmetic of tools/mem-cap.mjs (used by tools/rust-mutate.mjs).
 *
 * Why: a mutant once made a test binary allocate 22 GB and the OOM killer took the desktop down. The invariant that
 * prevents a repeat is arithmetic: the workers together stay within half of RAM, no default worker gets less than
 * MIN_CAP, and an explicit --jobs/--max-mem that breaks the budget is refused rather than silently changed.
 * These are local invariants of the tool, not checks against the vendored oracle. The probe that reads the cap back
 * from a real systemd scope needs a user manager and is not run here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GiB, MIN_CAP, MiB, parseSize, planMemory, wrap } from '../tools/mem-cap.mjs';

test('parseSize reads G, M, K and bare MiB numbers, and refuses anything else', () => {
  assert.equal(parseSize('2G'), 2 * GiB);
  assert.equal(parseSize('512M'), 512 * MiB);
  assert.equal(parseSize('1.5GiB'), 1.5 * GiB);
  assert.equal(parseSize('300'), 300 * MiB);
  assert.equal(parseSize('64K'), 64 * 1024);
  assert.throws(() => parseSize('lots'), /--max-mem/);
  assert.throws(() => parseSize('2 X'), /--max-mem/);
});

test('default split: 32 GiB and 16 cores give 8 workers of 2 GiB, inside half of RAM', () => {
  const m = planMemory({ totalBytes: 32 * GiB, cores: 16 });
  assert.equal(m.budget, 16 * GiB);
  assert.equal(m.jobs, 8);
  assert.equal(m.capBytes, 2 * GiB);
  assert.ok(m.jobs * m.capBytes <= m.budget);
});

test('default drops workers until each share is at least MIN_CAP', () => {
  // budget 4 GiB: 8 workers would get 512 MiB each, under MIN_CAP, so 4 workers of 1 GiB
  const m = planMemory({ totalBytes: 8 * GiB, cores: 16 });
  assert.equal(m.jobs, 4);
  assert.equal(m.capBytes, MIN_CAP);
});

test('workers times cap never exceeds half of RAM, across a grid of machines', () => {
  for (const gib of [2, 4, 8, 16, 32, 64, 128]) {
    for (const cores of [1, 2, 4, 8, 16, 32]) {
      const m = planMemory({ totalBytes: gib * GiB, cores });
      assert.ok(m.jobs >= 1, `jobs >= 1 at ${gib} GiB / ${cores} cores`);
      assert.ok(m.jobs * m.capBytes <= m.budget, `within budget at ${gib} GiB / ${cores} cores`);
      if (m.jobs > 1) assert.ok(m.capBytes >= MIN_CAP, `cap >= MIN_CAP at ${gib} GiB / ${cores} cores`);
    }
  }
});

test('an explicit --max-mem sets the cap and fits the workers into the budget', () => {
  const m = planMemory({ totalBytes: 32 * GiB, cores: 16, maxMemOpt: 4 * GiB });
  assert.equal(m.capBytes, 4 * GiB);
  assert.equal(m.jobs, 4);
});

test('an explicit --jobs and --max-mem that break the budget are refused, not changed', () => {
  assert.throws(() => planMemory({ totalBytes: 32 * GiB, cores: 16, jobsOpt: 8, maxMemOpt: 4 * GiB }), /exceeds half of RAM/);
});

test('an explicit --jobs whose share is under MIN_CAP is refused unless --max-mem is given', () => {
  assert.throws(() => planMemory({ totalBytes: 8 * GiB, cores: 16, jobsOpt: 8 }), /lower --jobs/);
  const m = planMemory({ totalBytes: 8 * GiB, cores: 16, jobsOpt: 2 });
  assert.equal(m.capBytes, 2 * GiB);
});

test('--no-mem-cap plans no cap', () => {
  const m = planMemory({ totalBytes: 32 * GiB, cores: 16, noCap: true });
  assert.equal(m.capBytes, null);
  assert.equal(m.jobs, 8);
});

test('wrap: systemd sets MemoryMax, no swap, and the OOM score; prlimit sets RLIMIT_DATA; none is a no-op', () => {
  const s = wrap('systemd', 2 * GiB, 'cargo', ['test', '-q']);
  assert.equal(s.cmd, 'systemd-run');
  assert.ok(s.args.includes(`MemoryMax=${2 * GiB}`));
  assert.ok(s.args.includes('MemorySwapMax=0'));
  assert.ok(!s.args.some((a) => a.startsWith('OOMScoreAdjust')), 'scope units reject OOMScoreAdjust');
  assert.ok(s.args.includes('--expand-environment=no'), 'wrapped arguments are passed through unchanged');
  assert.ok(s.args.includes('OOMPolicy=continue'), 'the runner survives its killed child and sees the signal');
  assert.deepEqual(s.args.slice(-3), ['cargo', 'test', '-q']);

  const p = wrap('prlimit', 300 * MiB, 'cargo', ['test']);
  assert.equal(p.cmd, 'prlimit');
  assert.deepEqual(p.args, [`--data=${300 * MiB}`, 'cargo', 'test']);

  assert.deepEqual(wrap('none', null, 'cargo', ['test']), { cmd: 'cargo', args: ['test'] });
});
