/*
 * test/vectorCache.test.js - the golden-vector cache key (tools/vector-cache.mjs) must be portable and honest.
 *
 * Why: `node tools/gate.mjs rust` regenerated ~155 s of vectors in every `git archive` extraction because the vendor
 * tree entered the key as size:mtime, and the game's SPELLS.STD was looked up under a config path no launcher writes.
 * These cases are synthetic roots (no real vectors, no cargo): the key must follow content only, resolve the spell file
 * the way the generators do, never key without it, and refuse to regenerate through a symlink.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { linkedStep, spellFile, vectorInputsHash, vectorPlan } from '../tools/vector-cache.mjs';

/** A minimal generator-input tree: the directories the key walks, plus a launcher config naming ARENA2. A relative
 *  `arena2` is written inside the root (the generators resolve a relative arena2Path from the repository root). */
function fixture({ vendor = 'vendor-a', mutate = 'mutate-a', src = 'src-a', spell = 'spell-a', arena2 = 'ARENA2' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dfo-vcache-'));
  const root = path.join(base, 'root');
  const write = (rel, text) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  write('src/model.js', src);
  write('test/harness/fixtures.mjs', 'fixtures');
  write('tools/rust-vectors.mjs', 'generator');
  write('tools/rust-codec.mjs', 'codec');
  write('tools/rust-mutate.mjs', mutate);
  write('tools/test-fast.mjs', 'not part of the key');
  write('vendor/upstream/a3eb1605/src/combat/formulas.js', vendor);
  write('rust/dfo-core/src/generated/mod.rs', 'published');
  const arena = arena2 === null ? null : path.join(root, arena2);
  if (arena && spell !== null) {
    fs.mkdirSync(arena, { recursive: true });
    fs.writeFileSync(path.join(arena, 'SPELLS.STD'), spell);
  }
  const userData = path.join(base, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ arena2Path: arena }));
  return { base, root, arena, userData, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/** Run `fn` with the launcher config pointed at `userData` (src/save.js reads DAGGER_USER_DATA on every call). */
function inHome(userData, fn) {
  const saved = process.env.DAGGER_USER_DATA;
  process.env.DAGGER_USER_DATA = userData;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.DAGGER_USER_DATA; else process.env.DAGGER_USER_DATA = saved;
  }
}

const hashOf = (f) => inHome(f.userData, () => vectorInputsHash(f.root));
const sleepMtime = (f) => { const t = new Date(Date.now() - 3600_000); for (const rel of ['vendor/upstream/a3eb1605/src/combat/formulas.js', 'src/model.js']) fs.utimesSync(path.join(f.root, rel), t, t); };
/** A vectors directory with a stamp for `key` and the `value.txt` the gate checks. */
const stampVectors = (dir, key) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'value.txt'), 'v1');
  fs.writeFileSync(path.join(dir, '.inputs-sha256'), `${key}\n`);
};

test('V-1: identical content in two different directories and mtimes gives the same key', () => {
  const a = fixture();
  const b = fixture();
  try {
    sleepMtime(b); // an extraction stamps new mtimes on identical bytes
    assert.equal(hashOf(a), hashOf(b));
    assert.match(hashOf(a), /^[0-9a-f]{64}$/);
  } finally { a.cleanup(); b.cleanup(); }
});

test('V-1b: the same root by another path (trailing slash, .., a symlink) is the same key', () => {
  const a = fixture();
  try {
    const key = hashOf(a);
    const viaAlias = [a.root + '/', path.join(a.root, '..', path.basename(a.root)), path.join(a.base, 'alias')];
    fs.symlinkSync(a.root, viaAlias[2]);
    for (const alias of viaAlias) assert.equal(inHome(a.userData, () => vectorInputsHash(alias)), key, `alias ${alias}`);
  } finally { a.cleanup(); }
});

test('V-2: only content moves the key - vendor, sources, generators; the mutation tool is not an input', () => {
  const f = fixture();
  try {
    const key = hashOf(f);
    fs.writeFileSync(path.join(f.root, 'vendor/upstream/a3eb1605/src/combat/formulas.js'), 'vendor-b');
    assert.notEqual(hashOf(f), key, 'a vendored byte must invalidate');
    const afterVendor = hashOf(f);
    fs.writeFileSync(path.join(f.root, 'tools/rust-mutate.mjs'), 'mutate-b');
    assert.equal(hashOf(f), afterVendor, 'the mutation tool never feeds the generators');
    fs.writeFileSync(path.join(f.root, 'tools/rust-vectors.mjs'), 'generator-b');
    assert.notEqual(hashOf(f), afterVendor, 'a generator must invalidate');
    const afterGenerator = hashOf(f);
    sleepMtime(f);
    assert.equal(hashOf(f), afterGenerator, 'mtime alone must not invalidate');
  } finally { f.cleanup(); }
});

test('V-3: SPELLS.STD enters the key by content, resolved as the generators resolve it', () => {
  const a = fixture({ spell: 'spell-a' });
  const b = fixture({ spell: 'spell-b' });
  try {
    assert.notEqual(hashOf(a), hashOf(b), 'different spell bytes must invalidate');
    const before = hashOf(a);
    const t = new Date(Date.now() + 3600_000);
    fs.utimesSync(path.join(a.arena, 'SPELLS.STD'), t, t);
    assert.equal(hashOf(a), before, 'the spell file mtime alone must not invalidate');
  } finally { a.cleanup(); b.cleanup(); }
});

test('V-3b: no readable SPELLS.STD means no key, so nothing is reused or stamped', () => {
  const cases = {
    'file absent': fixture({ spell: null }),
    'config names no ARENA2': fixture({ spell: null, arena2: null }),
    'ARENA2 directory missing': fixture({ spell: null, arena2: 'NO-SUCH-ARENA' }),
  };
  try {
    for (const [what, f] of Object.entries(cases)) {
      assert.equal(inHome(f.userData, () => spellFile(f.root)), null, what);
      assert.equal(hashOf(f), null, `${what}: no key`);
      const vectors = path.join(f.root, 'rust', 'tests', 'vectors');
      fs.mkdirSync(vectors, { recursive: true });
      fs.writeFileSync(path.join(vectors, 'value.txt'), 'v1');
      fs.writeFileSync(path.join(vectors, '.inputs-sha256'), 'null\n'); // even a stamp claiming "no key"
      const plan = inHome(f.userData, () => vectorPlan(f.root, vectors, false));
      assert.equal(plan.want, null, what);
      assert.equal(plan.cached, false, `${what}: never reusable without the spell data`);
    }
  } finally { Object.values(cases).forEach((f) => f.cleanup()); }
});

test('V-4: a relative arena2Path resolves against the repository root, not the caller cwd', () => {
  const a = fixture({ arena2: 'ARENA2' });
  const b = fixture({ arena2: 'ARENA2', spell: 'spell-b' });
  try {
    const cwd = process.cwd();
    process.chdir(os.tmpdir());
    try { assert.equal(hashOf(a), hashOf(a), 'relative path still resolves'); } finally { process.chdir(cwd); }
    assert.ok(inHome(a.userData, () => spellFile(a.root)?.equals(Buffer.from('spell-a'))));
    assert.notEqual(hashOf(a), hashOf(b));
  } finally { a.cleanup(); b.cleanup(); }
});

test('V-5: a current stamp is reused; a foreign or stale stamp is not; --fresh never caches', () => {
  const f = fixture();
  try {
    const vectors = path.join(f.root, 'rust', 'tests', 'vectors');
    const key = hashOf(f);
    stampVectors(vectors, key);
    const current = inHome(f.userData, () => vectorPlan(f.root, vectors, false));
    assert.equal(current.cached, true);
    assert.equal(inHome(f.userData, () => vectorPlan(f.root, vectors, true)).cached, false, '--fresh regenerates');
    fs.writeFileSync(path.join(vectors, '.inputs-sha256'), 'deadbeef\n');
    assert.equal(inHome(f.userData, () => vectorPlan(f.root, vectors, false)).cached, false, 'a foreign stamp is stale');
    fs.rmSync(path.join(vectors, '.inputs-sha256'));
    assert.equal(inHome(f.userData, () => vectorPlan(f.root, vectors, false)).cached, false, 'no stamp, no reuse');
  } finally { f.cleanup(); }
});

test('V-6: vectors linked into another tree are reused when current, and regeneration fails closed when stale', () => {
  const owner = fixture();
  const user = fixture(); // identical content: the key is portable (V-1)
  try {
    const ownerVectors = path.join(owner.root, 'rust', 'tests', 'vectors');
    stampVectors(ownerVectors, inHome(owner.userData, () => vectorInputsHash(owner.root)));
    const linked = path.join(user.root, 'rust', 'tests', 'vectors');
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(ownerVectors, linked);
    assert.equal(inHome(owner.userData, () => vectorPlan(user.root, linked, false)).cached, true, 'same inputs: reuse');
    // This tree's inputs move: writing would land in the owner's tree, so refuse - also when --fresh asks.
    fs.writeFileSync(path.join(user.root, 'src/model.js'), 'src-moved');
    for (const fresh of [false, true]) {
      const plan = inHome(user.userData, () => vectorPlan(user.root, linked, fresh));
      assert.equal(plan.cached, false);
      assert.equal(plan.link, `${linked} -> ${ownerVectors}`, `fresh=${fresh}`);
    }
    // A plain directory that is merely out of date is regenerated, not refused.
    const plainDir = path.join(user.root, 'plain', 'vectors');
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(plainDir, 'value.txt'), 'v1');
    const plain = inHome(user.userData, () => vectorPlan(user.root, plainDir, false));
    assert.equal(plain.cached, false);
    assert.equal(plain.link, null);
  } finally { owner.cleanup(); user.cleanup(); }
});

test('V-7: a symlinked ancestor, and a dangling link, both count as a link', () => {
  const f = fixture();
  try {
    const ownerVectors = path.join(f.root, 'elsewhere', 'vectors');
    stampVectors(ownerVectors, inHome(f.userData, () => vectorInputsHash(f.root)));
    // Ordinary nesting: no link, even when the target does not exist yet.
    assert.equal(inHome(f.userData, () => vectorPlan(f.root, path.join(f.root, 'rust', 'tests', 'vectors'), false)).link, null);
    assert.equal(inHome(f.userData, () => vectorPlan(f.root, path.join(f.root, 'nowhere', 'vectors'), false)).cached, false);
    // Dangling link: its target is absent, but a write would still follow it.
    const dangling = path.join(f.root, 'dangling');
    fs.symlinkSync(path.join(f.base, 'gone'), dangling);
    assert.equal(inHome(f.userData, () => vectorPlan(f.root, dangling, false)).link, `${dangling} -> ${path.join(f.base, 'gone')}`);
    // A link higher up the path is reported, not only a link on the leaf.
    const upper = path.join(f.root, 'upper');
    fs.symlinkSync(ownerVectors, upper);
    const viaAncestor = path.join(upper, 'nested');
    assert.equal(inHome(f.userData, () => vectorPlan(f.root, viaAncestor, false)).link, `${upper} -> ${ownerVectors}`);
    assert.equal(inHome(f.userData, () => linkedStep(f.root, viaAncestor)), `${upper} -> ${ownerVectors}`);
    // A link outside the tree is not this tree's business.
    assert.equal(linkedStep(f.root, f.base), null);
  } finally { f.cleanup(); }
});
