/*
 * test/rustVectorsDriver.test.js - tools/rust-vectors.mjs runs one family per child process, so every run of that
 * driver must write the same bytes as a serial run of the same family (the LCG is seeded per family, never shared).
 *
 * Why: the pool is an I/O and scheduling change only; a family that read another family's output, or a shared draw,
 * would show as a byte difference here. DFO_VECTORS_DIR keeps the run out of rust/tests/vectors (the gate's files).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = path.join(root, 'tools', 'rust-vectors.mjs');
// One non-streaming family and one streaming (buffered + flushed on write), both seconds to run.
const FAMILIES = ['round', 'rng', 'forge_gear'];

/** Run the driver in a fresh output directory; returns that directory. */
function generate(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfo-vgen-'));
  const r = spawnSync(process.execPath, [generator, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, DFO_VECTORS_DIR: dir },
  });
  assert.equal(r.status, 0, `generator exited ${r.status}: ${r.stderr}`);
  return dir;
}

const read = (dir, name) => fs.readFileSync(path.join(dir, `${name}.txt`), 'utf8');

test('one family per process writes the same bytes as a serial run', () => {
  const serial = generate([`--only=${FAMILIES.join(',')}`, '--jobs=1']);
  const parallel = generate([`--only=${FAMILIES.join(',')}`, '--jobs=2']);
  const alone = FAMILIES.map((f) => generate([`--only=${f}`]));
  try {
    for (const [i, name] of FAMILIES.entries()) {
      const want = read(serial, name);
      assert.equal(read(parallel, name), want, `${name}.txt differs under --jobs=2`);
      assert.equal(read(alone[i], name), want, `${name}.txt differs when run alone`);
      // Also the file the tree owns, when the Rust gate has written it (it is not tracked).
      const shipped = path.join(root, 'rust', 'tests', 'vectors', `${name}.txt`);
      if (fs.existsSync(shipped)) assert.equal(fs.readFileSync(shipped, 'utf8'), want, `${name}.txt differs from rust/tests/vectors`);
    }
  } finally {
    for (const d of [serial, parallel, ...alone]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('an unknown family name is refused, not silently skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfo-vgen-'));
  try {
    const r = spawnSync(process.execPath, [generator, '--only=round,nope'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, DFO_VECTORS_DIR: dir },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown families nope/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
