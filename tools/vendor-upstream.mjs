#!/usr/bin/env node
/*
 * tools/vendor-upstream.mjs - keep a minimal, hash-pinned copy of the parts of
 * the DFO Online client (Lattymoy/daggerfall-js-source) that the verification
 * harness measures against.
 *
 * The harness compares this project's combat rules with the *game's own*
 * implementation, so it needs the upstream modules that compute those rules,
 * not the game. Vendoring the whole client would copy a 27 MB import graph
 * (render, ui, world, assets); instead this tool keeps the import closure of a
 * documented set of entry modules and replaces the few edges that leave the
 * combat graph with explicit, hash-pinned failing stubs (see
 * vendor/upstream/<commit>/STUBS.json). A stub throws if anything is ever
 * called through it, so a stubbed edge cannot silently change a number.
 *
 * Usage:
 *   node tools/vendor-upstream.mjs --from <path-to-upstream-checkout>
 *   node tools/vendor-upstream.mjs --verify
 *   node tools/vendor-upstream.mjs --list
 *
 * <path-to-upstream-checkout> is a clone of Lattymoy/daggerfall-js-source.
 * The commit is verified before anything is written; --verify only reads the
 * vendored tree and reports every file whose bytes differ from the manifest.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const UPSTREAM = Object.freeze({
  repo: 'Lattymoy/daggerfall-js-source',
  commit: 'a3eb1605ea1dc391b691fe314377458a7e63e483',
  short: 'a3eb1605',
  date: '2026-11-02',
  license: 'MIT (see LICENSE.upstream)',
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT = path.resolve(HERE, '..');
export const VENDOR_DIR = path.join(PROJECT, 'vendor', 'upstream', UPSTREAM.short);

/**
 * The modules the harness calls. Each is either something the simulator
 * reimplements (so its answers are the oracle) or a supporting module needed to
 * build the same inputs (items, foes, swings).
 */
export const ROOTS = Object.freeze([
  // the per-hit core and its card
  'combat/combatStats.js',
  'combat/pcaao.js',
  'combat/formulas.js',
  // cadence, swings and the off-hand law
  'characters/weaponStates.js',
  'combat/swingLaw.js',
  'combat/twoHands/handsLaw.js',
  'combat/bowBloom.js',
  // the blow-power ceilings
  'systems/powerCeiling.js',
  'systems/entityMods.js',
  'systems/weaponMastery.js',
  'systems/martialPowers.js',
  'systems/martialPaths.js',
  'systems/firmamentPowers.js',
  'systems/loot/lootPowers.js',
  'systems/loot/lootRarity.js',
  // stats, skills, foes, gear
  'systems/statMods.js',
  'systems/skills.js',
  'systems/skillSoftcap.js',
  'systems/masterSkills.js',
  'systems/bossTraits.js',
  'systems/equip.js',
  'systems/armorMaterials.js',
  'systems/item/itemTemplates.js',
  'systems/item/itemFields.js',
  'systems/powerBlows.js',
  'systems/spell/spellPower.js',
  'systems/spellcast.js',
  'systems/online/onlineLane.js',
  // the relay's boss law: the per-player allowance (joinFight/applyHit/spendBlow). Its graph is
  // three files (gateMods + the already-vendored textManager); the rest of net/ stays cut.
  'net/gate/gateBrain.js',
  'net/gate/gateMods.js',
  'characters/equipTable.js',
  'characters/weapons.js',
  'characters/handWrapsIds.js',
  'characters/enemy/enemyEntity.js',
  'characters/enemy/enemyBasics.js',
  'combat/enemyGroups.js',
  'combat/clawMetal.js',
  'combat/healthShare.js',
  // Stage 2.8, the body a foe is minted from. The client boots Daggerfall Enemy Expansion at every load
  // (scenes/shared.js:1518 installEnemyExpansion; on by default, and forced on online:
  // systems/online/onlineLane.js:457-461 ONLINE_ROOM_MOD_KEYS), and while it is loaded it - with MUDEX beside Meaner
  // Monsters - owns the classic rows, standing Meaner Monsters' and the overhaul's edits aside
  // (enemyExpansion/dexSwitches.js meanerMonstersAlone). `dexClassicRow` is that row; the install is the
  // boot the oracle runs. world/gate/gateBoss.js is the relay bodies' one constructor (`bossStandIn`,
  // BOSS_ARMOR) for the Breach, the Sky-ketch Warden and the Abyss Remnant.
  'systems/enemyExpansion/dexInstall.js',
  'world/gate/gateBoss.js',
  // Stage 2.9. systems/martialPowers.js asks `sigilDueling()` before any path acts (awakeMartialId, :124). With
  // the sigil directory cut, that call returned an inert stub object - truthy - so no martial path ever acted
  // in the vendored oracle (martialFold folded nothing). The full checkout's answer is `false` (sigil.js:212).
  'systems/sigil/sigil.js',
  // Stage 2.9. systems/enchantments.js (vendored for real) imports ENCHANTMENT_TYPES from formats/magicDef.js, which
  // the `formats/` cut stubbed: every key read `Proxy(stub)`, the payload registry was keyed by proxies, and a real
  // enchantment row hit the "unknown type" abort - so no Strikes payload (Potent Vs' +5, Cast When Strikes) ever
  // ran in the vendored oracle. magicDef.js is a constants table.
  'formats/magicDef.js',
  // Stage 2.11a. systems/loot/lootPowers.js wornPowers (:245) returns nothing while `setsDueling()` is true; with the
  // sigil directory cut that call answered an inert, truthy stub, so no worn Legendary power or imprint ever fired in
  // the vendored oracle. The full checkout's answer is false (a refereed set duel is the only true).
  'systems/sigil/sigilSets.js',
  // Wider cut (re-pin): the claim bridge and the host were stubbed, so these were ASSUMPTIONS, not source. A declared
  // root is never cut; its imports into the excluded directories (scenes/, render/, ui/, net/, world/) stay stubs, so
  // each of these is vendored as readable source and is never called by the harness unless a test says so.
  //  - the round summing, the `turned` gate and the first-round-in-the-cast rule of a stand-in's spell claims
  //    (docs/ASSUMPTIONS.md M35, M38, M39; docs/STAGE-3-AUDIT.md A3.0-6, A3.0-7)
  'scenes/gate/standInSpell.js',
  //  - the claim door `gateCourt.hit` (the host rounding and the sub-1 drop, Q3), claim ordering within one timestamp
  //    (Q1) and COURT_ROUND_MS (:159), the round anchor that M35 assumes
  'scenes/gate/gateCourt.js',
  //    (COURT_ROUND_MS = round(1 / ONLINE_MINUTES_PER_MS) reads net/wire.js:240 `12 / 60 / 1000`, so the wire constants
  //    are a root too: with it a stubbed binding cannot hide the value)
  'net/wire.js',
  //  - NOT vendored: scenes/dungeonContext.js and scenes/hostEnchant.js (the host, U8). A dry run showed dungeonContext
  //    alone pulls in 148 files / 3.7 MB of unrelated systems and it is a scene host the harness cannot call; U8 is
  //    answered by reading the pinned checkout and citing it as `full:` (docs/ASSUMPTIONS.md U8).
  //  - the Firmament's sky law, now a stub (STUBS.md), so its blow gate and percentage had no live oracle
  'net/firmament/firmamentLaw.js',
]);

/**
 * Directories and single files the combat graph reaches only through UI,
 * rendering, asset loading, network code or settings plumbing. Everything cut
 * here becomes a stub. The list is deliberately narrow: anything that can
 * change a combat number at import time must stay vendored.
 */
const EXCLUDE = Object.freeze([
  /^src\/assets\//,
  /^src\/render\//,
  /^src\/world\//,
  /^src\/ui\//,
  /^src\/scenes\//,
  /^src\/player\//,
  /^src\/formats\//,
  /^src\/net\//,
  /^src\/locales\//,
  /^src\/tools\//,
  /^src\/systems\/(?:guild|quest|starfall|weather|survival|arena|deco|sigil|online|court|season|card|delve|naval|serpent|dragon)\//,
  /^src\/systems\/uiPrefs\.js$/,
  /^src\/systems\/worldTick\.js$/,
  /^src\/systems\/enchanting\.js$/,
  /^src\/combat\/fpArm\.js$/,
  /^src\/combat\/weapon\//,
  /^src\/combat\/gun\//,
  /^src\/combat\/diverseWeapons\//,
  /^src\/characters\/playerEntity\.js$/,
  /^src\/characters\/bodyMotion\//,
  /^src\/ai\//,
]);

/** Files the trail runs to outside src/ (real upstream files, copied whole). */
const OUTSIDE_ROOTS = Object.freeze([]);

const IMPORT_RE = /^\s*(import|export)\s+(?:([^\n]*?)\s+from\s+)?['"]([^'"]+)['"]/gm;
const FROM_RE = /from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
const LITERAL_EXPORT_RE = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Object\.freeze\()?\s*(-?(?:[0-9][0-9.eE+\-*/%() ]*)|true|false|null|'[^'\\]*'|"[^"\\]*")\s*\)?\s*;/gm;
/** A numeric expression of literals only (`1 / 60`), never an identifier. */
const NUMERIC_EXPR = /^-?[0-9][0-9.eE+\-*/%() ]*$/;
const EXPORT_NAME_RE = /^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
const REEXPORT_RE = /^export\s*\{([\s\S]*?)\}\s*from\b/gm;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/*
 * Imports and exports are read from the raw source. Comments are NOT stripped:
 * upstream has `"/*"` inside its own comments (systems/loot/loot.js line 23),
 * and a block-comment stripper deletes the rest of such a file. Import clauses
 * can span several lines and carry trailing comments (systems/thunderlock.js),
 * so the clause is taken as the text between the last `import`/`export`
 * keyword and its `from '...'`, with `//` comments removed from that slice.
 */

function readSource(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Simple `export const NAME = <literal>` values, so a stub keeps constant reads faithful. */
function literalExports(src) {
  const out = new Map();
  let m;
  LITERAL_EXPORT_RE.lastIndex = 0;
  while ((m = LITERAL_EXPORT_RE.exec(src))) {
    const expr = m[2].trim();
    if (NUMERIC_EXPR.test(expr) && (expr.match(/[0-9]/g) ?? []).length && /[0-9]/.test(expr)) out.set(m[1], expr);
    else if (/^(true|false|null|'[^']*'|"[^"]*")$/.test(expr)) out.set(m[1], expr);
  }
  return out;
}

/** Every name the module exports (so a stub answers any importer, aliased or not). */
function exportedNames(src) {
  const names = new Set();
  let m;
  EXPORT_NAME_RE.lastIndex = 0;
  while ((m = EXPORT_NAME_RE.exec(src))) names.add(m[1]);
  REEXPORT_RE.lastIndex = 0;
  while ((m = REEXPORT_RE.exec(src))) {
    for (const part of m[1].split(',')) {
      const t = part.replace(/\/\/.*$/gm, '').trim();
      if (!t) continue;
      const alias = t.match(/\bas\s+([A-Za-z_$][\w$]*)/);
      names.add(alias ? alias[1] : t.split(/\s+/)[0]);
    }
  }
  return names;
}

function parseImports(file) {
  const src = readSource(file);
  if (!src) return [];
  const out = [];
  let m;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(src))) {
    const spec = m[1];
    // Only a relative module specifier: no spaces, no prose, a .js or a bare dir.
    if (!spec.startsWith('.')) continue;
    if (!/^\.{1,2}\/[\w@./-]*$/.test(spec) || spec.length > 120) continue;
    // The clause is the text between this `from` and the nearest preceding
    // `import`/`export` keyword at a line start, and it must be one statement.
    const before = src.slice(Math.max(0, m.index - 4000), m.index);
    const kw = [...before.matchAll(/(?:^|[;\n])[ \t]*(import|export)\b/g)].pop();
    if (!kw) continue;
    const cut = kw[0].startsWith(';') || kw[0].startsWith('\n') ? kw[0].length - kw[0].replace(/^[;\n]/, '').length : 0;
    const clauseText = before.slice(kw.index + cut);
    if (clauseText.includes(';')) continue; // a statement boundary: not an import clause
    const clause = clauseText.replace(/\/\/[^\n]*/g, '').replace(/^\s*(import|export)\b/, '').trim();
    let resolved = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.js`)) resolved += '.js';
    if (!fs.existsSync(resolved) && fs.existsSync(path.join(resolved, 'index.js'))) resolved = path.join(resolved, 'index.js');
    if (!fs.existsSync(resolved)) continue;
    out.push({ kind: kw[1], clause, spec, resolved });
  }
  // `import './x.js';` - a side-effect import registers handlers, so it is a
  // real edge: the module must be vendored, never stubbed away.
  SIDE_EFFECT_RE.lastIndex = 0;
  while ((m = SIDE_EFFECT_RE.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith('.') || !/^\.{1,2}\/[\w@./-]*$/.test(spec) || spec.length > 120) continue;
    let resolved = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.js`)) resolved += '.js';
    if (!fs.existsSync(resolved) && fs.existsSync(path.join(resolved, 'index.js'))) resolved = path.join(resolved, 'index.js');
    if (!fs.existsSync(resolved)) continue;
    out.push({ kind: 'import', clause: '', spec, resolved });
  }
  return out;
}

/** Every binding a module imports, for stubbing: ['a', 'b as c', '* as ns']. */
function importedBindings(clause) {
  if (!clause) return [];
  const out = [];
  const brace = clause.match(/\{([\s\S]*)\}/);
  if (brace) {
    for (const part of brace[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      out.push(t.replace(/\s+as\s+/, ' as '));
    }
  }
  const ns = clause.match(/\*\s+as\s+(\w+)/);
  if (ns) out.push(ns[1]);
  const def = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+\w+/, '').replace(/,/g, ' ').trim();
  if (def && /^[A-Za-z_$][\w$]*$/.test(def)) out.push(def);
  return out;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Verify the checkout is the pinned commit and has no local edits. */
export function verifyCheckout(srcDir) {
  const root = path.resolve(srcDir);
  const head = git(['rev-parse', 'HEAD'], root);
  if (head !== UPSTREAM.commit) {
    throw new Error(
      `upstream checkout is at ${head}, not the pinned ${UPSTREAM.commit}.\n` +
        `Check out the pinned commit (git -C ${root} checkout ${UPSTREAM.commit}) or re-pin deliberately.`,
    );
  }
  const dirty = git(['status', '--porcelain', '--', 'src', 'LICENSE'], root);
  if (dirty) throw new Error(`upstream checkout has local edits; refusing to vendor from it:\n${dirty}`);
  return root;
}

/** The import closure of ROOTS, minus EXCLUDE, plus the cut edges. */
export function plan(srcDir) {
  const root = verifyCheckout(srcDir);
  const srcRoot = path.join(root, 'src');
  const keep = new Map(); // abs path -> upstream path (repo-relative)
  const stubs = new Map(); // upstream path -> { reason, from: [upstream paths] }
  const queue = ROOTS.map((r) => path.join(srcRoot, r));
  // A declared root is never cut, even when it lives behind an exclude pattern
  // (systems/online/onlineLane.js is both a root and under systems/online/).
  const declared = new Set(queue);

  while (queue.length) {
    const file = queue.pop();
    if (keep.has(file)) continue;
    if (!fs.existsSync(file)) throw new Error(`upstream module missing: ${path.relative(root, file)}`);
    keep.set(file, path.relative(root, file));
    for (const imp of parseImports(file)) {
      const rel = path.relative(root, imp.resolved);
      const cutThis = !imp.resolved.startsWith(root + path.sep) || (EXCLUDE.some((rx) => rx.test(rel)) && !declared.has(imp.resolved));
      if (!cutThis) {
        queue.push(imp.resolved);
        continue;
      }
      const cut = path.relative(root, imp.resolved);
      if (cut.startsWith('..') || path.isAbsolute(cut)) {
        throw new Error(`an import of ${path.relative(root, file)} leaves the checkout: ${imp.spec}`);
      }
      const entry = stubs.get(cut) ?? { reason: reasonFor(cut), from: [], bindings: new Set() };
      entry.from.push(path.relative(root, file));
      for (const b of importedBindings(imp.clause)) entry.bindings.add(b);
      stubs.set(cut, entry);
    }
  }
  return { root, keep, stubs };
}

function reasonFor(rel) {
  if (/^assets\//.test(rel)) return 'baked art/mesh data';
  if (/^render\//.test(rel)) return 'renderer';
  if (/^world\//.test(rel)) return 'world geometry';
  if (/^ui\//.test(rel)) return 'user interface';
  if (/^scenes\//.test(rel)) return 'scene host';
  if (/^player\//.test(rel)) return 'player movement';
  if (/^formats\//.test(rel)) return 'file formats / dice';
  if (/^net\//.test(rel)) return 'multiplayer transport';
  if (/^systems\/modSettings/.test(rel) || /^systems\/settings\//.test(rel)) return 'mod settings (offline defaults apply)';
  if (/^systems\/uiPrefs/.test(rel)) return 'UI preferences';
  if (/^systems\/sigil\//.test(rel)) return 'sigil sets (offline: asleep)';
  if (/^systems\/online\//.test(rel)) return 'online lane (offline)';
  if (/^systems\/enchant/.test(rel)) return 'enchantment payloads (modelled by the simulator)';
  if (/^systems\/inventory/.test(rel)) return 'inventory helpers';
  if (/^combat\/(weapon|gun|diverseWeapons|fpArm|playerWeapon|enemyEquipment)/.test(rel)) return 'POV rig / gun art / player swing host';
  if (/^characters\/playerEntity/.test(rel)) return 'player entity host';
  return 'outside the combat graph';
}

const RESERVED = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static await implements interface package private protected public'.split(
    ' ',
  ),
);

/** A stub's export surface: every imported binding and every exported name. */
function stubNames(info, src) {
  const names = new Set();
  for (const raw of info.bindings) {
    const star = raw.match(/^\*\s+as\s+(\w+)/);
    if (star) {
      names.add(star[1]);
      continue;
    }
    // `X as Y` imports the SOURCE name X: the stub must export X.
    const source = raw.trim().split(/\s+as\s+/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(source)) names.add(source);
  }
  for (const n of exportedNames(src)) if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
  return [...names].filter((n) => !RESERVED.has(n)).sort();
}

const STUB_PROXY = (rel, bindings, literals) => `// GENERATED by tools/vendor-upstream.mjs - a cut edge of the vendored combat
// graph (upstream ${rel}).
//
// A stub keeps its upstream path so relative imports still resolve. Importing
// is safe and calls are inert, because upstream itself calls registration
// seams at import time. Anything read as a NUMBER or a STRING is poisoned
// (\`NaN\` / a marked string) so a stubbed edge cannot silently supply a value:
// the harness asserts every measured number is finite. Simple literal
// constants below keep their upstream value.
const MARK = '[vendored stub]';
const inert = (name) => {
  const target = function stub() {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.toPrimitive) return (hint) => (hint === 'number' ? NaN : MARK);
      if (prop === 'valueOf') return () => NaN;
      if (prop === 'toString') return () => MARK;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.asyncIterator) return function* () {};
      if (prop === 'length') return 0;
      return inert(name + '.' + String(prop));
    },
    has: () => false,
    apply: (_t, _this, args) => inert(name + '()'),
    construct: () => ({}),
  });
};
${bindings.map((n) => (literals.has(n) ? `export const ${n} = ${literals.get(n)};` : `export const ${n} = inert(${JSON.stringify(n)});`)).join('\n')}
export default inert('default');
`;

function write(relToVendor, body) {
  const file = path.join(VENDOR_DIR, relToVendor);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

export function vendor(srcDir) {
  const { root, keep, stubs } = plan(srcDir);
  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  const files = [];
  for (const [abs, rel] of [...keep.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
    const buf = fs.readFileSync(abs);
    const outRel = rel.replace(/^src\//, 'src/');
    write(outRel, buf);
    files.push({ path: outRel, upstream: rel, role: 'vendored', sha256: sha256(buf), bytes: buf.length });
  }

  // A stub keeps the upstream path so every relative import still resolves to
  // this file; importing it is safe, calling anything through it throws.
  const stubRows = [];
  for (const [rel, info] of [...stubs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const src = readSource(path.join(root, rel));
    const literals = literalExports(src);
    const names = stubNames(info, src);
    const body = STUB_PROXY(rel, names, literals);
    write(rel, body);
    stubRows.push({
      path: rel,
      upstream: rel,
      role: 'stub',
      reason: info.reason,
      bindings: names,
      constants: Object.fromEntries([...literals]),
      sha256: sha256(Buffer.from(body)),
      importedBy: [...new Set(info.from)].sort(),
    });
  }

  for (const name of ['LICENSE', 'README.md']) {
    const from = path.join(root, name);
    if (fs.existsSync(from)) write(name === 'LICENSE' ? 'LICENSE.upstream' : 'LICENSE.upstream.md', fs.readFileSync(from));
  }

  const manifest = {
    upstream: UPSTREAM,
    generatedBy: 'tools/vendor-upstream.mjs',
    roots: ROOTS,
    exclude: EXCLUDE.map(String),
    files,
    stubs: stubRows,
  };
  write('MANIFEST.json', `${JSON.stringify(manifest, null, 2)}\n`);
  write('STUBS.md', renderStubsDoc(stubRows));
  return manifest;
}

function renderStubsDoc(rows) {
  const lines = [
    '# Stubbed upstream edges',
    '',
    'Generated by `tools/vendor-upstream.mjs`. Each row is an upstream module that the combat graph',
    'reaches only through UI, rendering, asset loading, network code or settings plumbing. The file',
    'keeps its upstream path (so every relative import still resolves) but exports throwing proxies:',
    'importing is safe, **calling anything throws**, so a stubbed edge cannot silently change a number.',
    '',
    'The harness measures the rules against offline, un-modded clients, which is consistent with every',
    'stub below: mod settings, UI prefs, sigils and the online lane are all asleep or absent there.',
    '',
    '| upstream path | why it is cut | bindings |',
    '|---|---|---|',
    ...rows.map((r) => `| \`${r.upstream}\` | ${r.reason} | ${r.bindings.map((b) => `\`${b}\``).join(', ') || '-'} |`),
    '',
  ];
  return lines.join('\n');
}

/** Read the manifest and report every vendored file that does not match it. */
export function verify() {
  const manifestFile = path.join(VENDOR_DIR, 'MANIFEST.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`no manifest at ${path.relative(PROJECT, manifestFile)}; vendor the upstream subset first`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.upstream?.commit !== UPSTREAM.commit) {
    throw new Error(`manifest pins ${manifest.upstream?.commit}, tool pins ${UPSTREAM.commit}`);
  }
  const problems = [];
  for (const row of [...manifest.files, ...manifest.stubs]) {
    const file = path.join(VENDOR_DIR, row.path);
    if (!fs.existsSync(file)) {
      problems.push(`${row.path}: missing`);
      continue;
    }
    const got = sha256(fs.readFileSync(file));
    if (got !== row.sha256) problems.push(`${row.path}: modified (manifest ${row.sha256.slice(0, 12)}, disk ${got.slice(0, 12)})`);
  }
  const expected = new Set([...manifest.files, ...manifest.stubs].map((r) => r.path));
  for (const file of walk(VENDOR_DIR)) {
    const rel = path.relative(VENDOR_DIR, file);
    if (['MANIFEST.json', 'STUBS.md', 'LICENSE.upstream', 'LICENSE.upstream.md', 'README.vendor.md'].includes(rel)) continue;
    if (!expected.has(rel)) problems.push(`${rel}: not in the manifest`);
  }
  return { manifest, problems };
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────
function main(argv) {
  const args = argv.slice(2);
  const fromAt = args.indexOf('--from');
  if (args.includes('--list')) {
    const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'MANIFEST.json'), 'utf8'));
    for (const f of manifest.files) console.log(`${f.sha256.slice(0, 12)}  ${f.upstream} -> ${f.path}`);
    for (const s of manifest.stubs) console.log(`${s.sha256.slice(0, 12)}  ${s.upstream} -> ${s.path}  (stub: ${s.reason})`);
    console.log(`\n${manifest.files.length} vendored, ${manifest.stubs.length} stubbed @ ${manifest.upstream.commit}`);
    return;
  }
  if (args.includes('--verify')) {
    const { manifest, problems } = verify();
    if (problems.length) {
      console.error(`vendor verification FAILED (${problems.length}):`);
      for (const p of problems) console.error(`  ${p}`);
      process.exitCode = 1;
      return;
    }
    console.log(`vendor verification ok: ${manifest.files.length} vendored, ${manifest.stubs.length} stubbed @ ${manifest.upstream.commit}`);
    return;
  }
  if (fromAt < 0 || !args[fromAt + 1]) {
    console.error('usage: node tools/vendor-upstream.mjs --from <upstream-checkout> | --verify | --list');
    process.exitCode = 2;
    return;
  }
  const manifest = vendor(args[fromAt + 1]);
  console.log(`vendored ${manifest.files.length} files + ${manifest.stubs.length} stubs @ ${manifest.upstream.commit}`);
  console.log(`-> ${path.relative(PROJECT, VENDOR_DIR)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv);
