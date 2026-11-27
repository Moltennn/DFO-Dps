/*
 * tools/vector-cache.mjs - the golden-vector cache key and the shared-tree guard, split out so a test can drive them
 * without running the gate.
 *
 *   vectorInputsHash(root)         the key: content of every input the generators read, portable between copies of the
 *                                  same revision (a worktree, a `git archive` extraction, a symlink or a relative path
 *                                  to the root must all agree; no path outside `root` and no mtime may enter it), or
 *                                  null when the real tier's SPELLS.STD cannot be read
 *   vectorPlan(root, dir, fresh)   whether the vectors on disk can be kept, and whether writing them would go through
 *                                  a symlink into another tree (then the gate fails closed)
 *
 * Inputs, and why:
 *   src JS, test/harness, tools/rust-*.mjs, rust/dfo-core/src/generated   content: the generators import them
 *   vendor                                                               content: 8 MB, ~30 ms; mtime was
 *                                 the reason a fresh extraction rebuilt 155 s of vectors for identical bytes
 *   tools/rust-mutate.mjs                                                NOT an input: no generator imports it
 *   spellbook                                                            content: the synthetic builder's bytes, or
 *                                 with DFO_REAL_SPELLS=1 the real SPELLS.STD, resolved exactly as the
 *                                 generators resolve it (`arena2Dir()` from src/save.js, then `resolve(dir,
 *                                 'SPELLS.STD')` from the repository root). Missing or unreadable yields NO key at
 *                                 all: a key that omits the spell data would claim a provenance the vectors do not
 *                                 have, so nothing is ever reused or stamped without it.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { arena2Dir } from '../src/save.js';
import { realSpells, synthSpellsStd } from './rust-synth-book.mjs';

/** The spell bytes the generators read: the synthetic book, or (DFO_REAL_SPELLS=1) the launcher's file, null when its
 *  config names none or it cannot be read. */
export function spellFile(root) {
  if (!realSpells()) return synthSpellsStd();
  const dir = arena2Dir();
  if (!dir) return null;
  try { return readFileSync(resolve(root, dir, 'SPELLS.STD')); } catch { return null; }
}

/** Every generator input, keyed by path relative to `root` (portable) and hashed by content; null without a spell file. */
export function vectorInputsHash(root) {
  const spell = spellFile(root);
  if (spell === null) return null;
  const h = createHash('sha256');
  const base = resolve(root); // a trailing separator or `..` in the caller's root must not change the key
  const walk = (tag, dir, filter) => {
    if (!existsSync(dir)) { h.update(`${tag}:missing\0`); return; }
    const rec = (d) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) { if (name !== 'node_modules') rec(p); continue; }
        if (!filter(p)) continue;
        h.update(relative(base, p)).update('\0').update(readFileSync(p)).update('\0');
      }
    };
    rec(dir);
  };
  walk('src', join(base, 'src'), (p) => p.endsWith('.js'));
  walk('harness', join(base, 'test', 'harness'), () => true);
  walk('tools', join(base, 'tools'), (p) => /rust-.*\.mjs$/.test(p) && !p.endsWith('rust-mutate.mjs'));
  walk('vendor', join(base, 'vendor'), () => true);
  walk('generated', join(base, 'rust', 'dfo-core', 'src', 'generated'), () => true);
  h.update('spell\0').update(spell);
  return h.digest('hex');
}

/** The first symlinked step from `root` down to `dir`, as `step -> target`, or null. A dangling link counts: writing
 *  through it would still land outside this tree. Only steps at or below `root` are considered. */
export function linkedStep(root, dir) {
  const base = resolve(root);
  const rel = relative(base, resolve(dir));
  if (rel.startsWith('..') || rel === '') return null;
  let p = base;
  for (const name of rel.split(sep)) {
    p = join(p, name);
    try { if (lstatSync(p).isSymbolicLink()) return `${p} -> ${readlinkSync(p)}`; } catch { return null; } // absent
  }
  return null;
}

/**
 * `cached` keeps the vectors on disk. `link` is a symlinked step to the vectors directory: reuse is fine, regeneration
 * would overwrite the tree that owns them, so the gate refuses instead. `want` is null when there is no key: nothing
 * matches it, so nothing is reused and no stamp is written.
 */
export function vectorPlan(root, vectorsDir, fresh) {
  const stamp = join(vectorsDir, '.inputs-sha256');
  const want = vectorInputsHash(root);
  const have = want === null || !existsSync(stamp) ? '' : readFileSync(stamp, 'utf8').trim();
  const cached = want !== null && !fresh && have === want && existsSync(join(vectorsDir, 'value.txt'));
  return { want, have, cached, link: linkedStep(root, vectorsDir), stamp };
}
