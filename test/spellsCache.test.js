/*
 * test/spellsCache.test.js - `standardSpells()` must not touch the filesystem once its result is cached.
 *
 * The default argument used to be `arena2Dir()`, which a default parameter evaluates on EVERY call, before the cache is
 * consulted - and `arena2Dir()` reads the launcher's config.json. `standardSpells()` runs per blow on the Cast When
 * Strikes path, so a cached call must resolve no default at all. The no-directory fallback (a fresh empty map, not a
 * cached one) and the "an explicit dir is ignored once cached" rule must stay exactly as they were.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SPELL_RECORD_SIZE, standardSpells } from '../src/spells.js';

/** One all-zero 89-byte record: a valid spell (effect type 0) at index 0. */
const record = () => Buffer.alloc(SPELL_RECORD_SIZE);
const tempArena = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfo-spells-'));
  fs.writeFileSync(path.join(dir, 'SPELLS.STD'), record());
  return dir;
};

test('S-1: a missing directory still yields a fresh empty map, and a later explicit dir still loads', () => {
  const none = standardSpells('');
  assert.ok(none instanceof Map);
  assert.equal(none.size, 0);
  assert.notEqual(standardSpells(''), none, 'the no-dir fallback is not cached, as before');
  const dir = tempArena();
  try {
    const loaded = standardSpells(dir);
    assert.equal(loaded.size, 1, 'the explicit dir is loaded while the cache is empty');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S-2: repeated cached calls do not read the filesystem', () => {
  // S-1 loaded a real directory, so the cache is populated. Any further call must short-circuit before
  // `arena2Dir()` (which would read config.json) and before `SPELLS.STD`.
  const cached = standardSpells();
  assert.ok(cached.size > 0, 'the cache is populated by S-1');
  let reads = 0;
  const original = fs.readFileSync;
  fs.readFileSync = (...args) => { reads += 1; return original.apply(fs, args); };
  try {
    const a = standardSpells();
    const b = standardSpells();
    const c = standardSpells(undefined);
    assert.equal(reads, 0, 'cached calls must not evaluate the default argument or re-read SPELLS.STD');
    assert.equal(a, cached, 'the default call returns the cached map');
    assert.equal(b, cached);
    assert.equal(c, cached);
    // An explicit dir is ignored once the cache exists (the pre-existing rule), still with no read.
    assert.equal(standardSpells('/tmp/does-not-matter'), cached);
    assert.equal(reads, 0);
  } finally {
    fs.readFileSync = original;
  }
});
