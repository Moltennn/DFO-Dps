#!/usr/bin/env node
/*
 * tools/vector-freeze.mjs - turn the generated golden vectors into the committed frozen sample.
 *
 *   node tools/vector-freeze.mjs             write rust/tests/frozen/ (sample + MANIFEST) from rust/tests/vectors/
 *   node tools/vector-freeze.mjs --verify    check the committed sample against its own MANIFEST (each .txt.gz's
 *                                            sha256, its decoded raw sha256, size and case count)
 *   node tools/vector-freeze.mjs --check     prove the committed sample is what the generators' output would produce now
 *   node tools/vector-freeze.mjs --archive   write the FULL set, gzipped, to the archive outside the repository
 *
 * Why: the full set is 3.6 GB of text (144 MB gzipped) and cannot be committed. The sample keeps
 *
 *   - every hand-written case. `tools/rust-vectors.mjs` marks the lines it writes outside a seeded sweep (`hand()`), and
 *     records their indices in `<module>.hand`; the whole of such a case is kept, never a stride over it.
 *   - a stable-hash selection over everything else: a seeded case is kept when `sha256(kind \0 n) < threshold`, where
 *     `n` is the case's index within its kind. A stride (`n % stride`) would keep exactly the indices whose options
 *     repeat with the period (the generators set options with `i & 1`, `i % 4`, ...), so whole branches always fell on
 *     dropped indices; a content-free hash has no such period. The threshold is chosen per kind to hit the budget.
 *
 * Determinism: the input order is the generator's order, the hash is SHA-256 of a fixed string, and gzip is written with
 * mtime 0 and a fixed OS byte. No Math.random, no Date of the run, no environment.
 *
 * What a selection may not break:
 *   - `@<id>` references: `def`, `answer`, `book`, `tgt`, `atk` and every other definition kind are hand-written (or
 *     whole), so every reference resolves.
 *   - stateful records: `blow_outcomes` emits one record per build (`build full fight sample_fight [carry sample_carry
 *     trace]`); a record is kept or dropped as a unit, so `sample_fight`/`trace` cannot outlive the tier they index.
 *   - per-case index tests: `real_build`'s `shortlist` cases are addressed by index, so that file is kept whole.
 *
 * The files are large (blow_outcomes is 1.5 GB), so both passes stream: pass 1 counts, pass 2 writes.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, createReadStream, createWriteStream } from 'node:fs';
import { createGzip, gunzipSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const srcDir = join(root, 'rust', 'tests', 'vectors');
// `DFO_FROZEN_OUT` lets the gate regenerate the sample into a scratch directory (or check a candidate sample before it
// is committed); the default is the committed sample itself.
const outDir = process.env.DFO_FROZEN_OUT ?? join(root, 'rust', 'tests', 'frozen');
// The sample may not leave the committed size band (20-30 MiB): the owner fixed it, so the tool refuses rather than
// quietly publishing a sample a reviewer would have to notice by hand.
const SIZE_MIN = 20 * 1024 * 1024;
const SIZE_MAX = 30 * 1024 * 1024;
// The full-set archive lives outside the repository, under the user's data directory; `DFO_ARCHIVE_DIR` moves it (a
// machine with a different home layout, or a test). No personal path is written into a committed file.
const ARCHIVE_DIR = process.env.DFO_ARCHIVE_DIR ?? join(homedir(), '.local', 'share', 'dfo-tools', 'vectors-archive');

/**
 * Per module, the kinds that are a seeded sweep and the target number of cases to keep of each. Everything not listed
 * is kept whole (hand-written blocks, constants, the definitions a case refers to). `share` is the fraction of a kind's
 * cases to keep; the tool turns it into the hash threshold `round(share x 2^32)`. `kindShares` overrides `share` for one
 * kind: a thin family (a handful of branches a bug could hide in) is sampled harder than the wide sweeps beside it.
 */
const PLAN = {
  fight: { share: 1 / 320, kinds: ['cast', 'relay', 'fight', 'thresholds', 'magnitude', 'save', 'equip', 'power', 'rows', 'bills'],
    kindShares: { cast: 1 / 320, thresholds: 1 / 32, magnitude: 1 / 32, save: 1 / 24, equip: 1 / 24, power: 1 / 24, rows: 1 / 24, bills: 1 / 24, fight: 1 / 48, relay: 1 / 48 } },
  blow_outcomes: { share: 1 / 400, kinds: ['build'], records: true },
  analysis: { share: 1 / 160, kinds: ['ref', 'boss', 'gate', 'relay'], kindShares: { ref: 1 / 32, boss: 1 / 32, gate: 1 / 32, relay: 1 / 32 } },
  maxprofile: { share: 1 / 2400, kinds: ['build', 'run', 'frontier', 'legal'], kindShares: { build: 1 / 400, run: 1 / 400 } },
  spells: { share: 1 / 16, kinds: ['record', 'card', 'saving', 'climb', 'effect', 'effect_grid', 'enchant', 'resolve', 'catalogue', 'boss'] },
  maketarget: { share: 1 / 20, kinds: ['mint', 'make', 'enemy', 'stand', 'gear', 'classic', 'rri', 'bclassic', 'brri', 'borcish', 'bgear', 'benemy', 'bpoison'] },
  model_blow: { share: 1 / 16, kinds: ['weapon', 'scalar', 'cadence', 'hit', 'damage', 'live', 'loot', 'outcomes', 'misc', 'resist'] },
  gear_profile: { share: 1 / 200, kinds: ['slot', 'budget', 'validate'] },
  imprints: { share: 1 / 8, kinds: ['power'] },
  theory: { share: 1 / 8, kinds: ['character', 'fists', 'blade'] },
  relay_fight: { share: 1 / 40, kinds: ['batch', 'reuse', 'single', 'paired', 'purse', 'objective', 'rank', 'script'],
    kindShares: { batch: 1 / 12, reuse: 1 / 12 } },
  firmament: { share: 1 / 8, kinds: ['summary', 'plan', 'fromtree', 'blow', 'castcost', 'isprice', 'offstat', 'nodehasoff'] },
  // Large modules kept whole until now: sampling them frees the budget the thin families above need. Their hand cases
  // (definitions, error rows, the boundary probes) are kept whole; only the wide sweeps are sampled.
  target: { share: 1 / 6, kinds: ['natural', 'live_stat', 'bonus_range', 'bonus_value', 'bonus_values', 'career_tolerance', 'element_share',
    'enemy_type_group', 'silver_applies', 'skeletal_damage', 'is_skeletal', 'monster_hide', 'intrinsic_damage', 'armour_material_id',
    'armour_condition', 'armour_reduction', 'shield_reduction', 'shield_block', 'shield_beats', 'struck_slot', 'left_hand', 'has_worn',
    'part_outcomes', 'part_damage', 'expected_damage', 'equip_armour', 'material_armor_value', 'item_armor_value', 'enemy_group',
    'career_attack_modifier', 'enemy_entity_type', 'enemy_career_index', 'slot_for_body_part', 'armor_body_parts', 'condition_percentage',
    'armour_piece', 'silver_doubles', 'is_shield_template', 'enemy_armor_values'] },
  save: { share: 1 / 2, kinds: ['cfs'] },
};

/** A path in the archive, shown as `~/…` in docs and messages, so no committed file names a home directory. */
const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The selection key of a seeded case: a stable hash of its kind and its index within that kind, in [0, 2^32). */
function key32(kind, n) {
  const h = createHash('sha256').update(`${kind}\0${n}`).digest();
  return h.readUInt32BE(0);
}

/** The threshold a share implies: a case is kept when its key is below it. */
const threshold = (share) => Math.round(share * 2 ** 32);

/** The threshold for one kind: its `kindShares` entry if it has one, else the module's `share`. */
const kindThreshold = (plan, kind) =>
  threshold(plan.kindShares?.[kind] ?? plan.share);

/** Stream one vector file line by line: `onLine(kind, line, index)` and `onHeader(line)`. */
async function eachLine(name, { onHeader, onLine }) {
  const rl = createInterface({ input: createReadStream(join(srcDir, `${name}.txt`)), crlfDelay: Infinity });
  let i = 0;
  let head = true;
  await new Promise((res, rej) => {
    rl.on('line', (l) => {
      if (!l) return;
      if (head && l.startsWith('#')) { onHeader(l); return; }
      head = false;
      onLine(l.slice(0, l.indexOf(' ')), l, i++);
    });
    rl.on('close', res);
    rl.on('error', rej);
  });
}

/** Walk any text file (plain or gzip) line by line, `consume(line)`. */
async function eachTextLine(path, consume) {
  if (path.endsWith('.gz')) {
    for (const line of gunzipSync(readFileSync(path)).toString('utf8').split('\n')) consume(line);
    return;
  }
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  await new Promise((res, rej) => {
    rl.on('line', consume);
    rl.on('close', res);
    rl.on('error', rej);
  });
}

/** The most distinct values one witnessed field may take before it is treated as data rather than a branch. */
const BRANCH_CAP = 64;

/** The option fields the generators set by branch and the tests branch on: the game build and the flags whose values
 *  select whole code paths. A case carries them inside its encoded option record, so the witness is read from the
 *  generator's own field name, never guessed from a token position. */
const BRANCH_FIELDS = new Set([
  'gameBuild', 'core', 'dual', 'durability', 'rri', 'pair', 'relay', 'warded', 'carry', 'trace', 'passiveOn',
  'critDamage', 'damageMode', 'swing', 'online', 'vampire', 'firmament', 'metric', 'kind', 'hand', 'offHand',
]);

/** A compact option record is scanned for the witnessed fields; a larger token is a character, an item or a tier (data,
 *  and scanning it would cost the audit more than it proves). */
const RECORD_CAP = 4096;

/** Parse one value token (the codec grammar) at `i`; returns [value, next] or null. Only what the witness needs: an
 *  object's own keys and their raw value text, and array elements. */
function valueAt(s, i) {
  const c = s[i];
  if (c === 'b' || c === 'u' || c === 'n' || c === 'd') {
    if (c === 'd') return [s.slice(i, i + 17), i + 17];
    if (c === 'b') return [s.slice(i, i + 2), i + 2];
    return [c, i + 1];
  }
  if (c === 's') {
    const end = s.indexOf(';', i);
    if (end < 0) return null;
    return [s.slice(i, end + 1), end + 1];
  }
  if (c === '[') {
    const items = [];
    let j = i + 1;
    while (j < s.length && s[j] !== ']') {
      const v = valueAt(s, j);
      if (!v) return null;
      items.push(v[0]);
      j = v[1];
      if (s[j] === ',') j++;
    }
    return [items, j + 1];
  }
  if (c === '{') {
    const entries = new Map();
    let j = i + 1;
    while (j < s.length && s[j] !== '}') {
      const k = valueAt(s, j);
      if (!k || !k[0].startsWith('s')) return null;
      j = k[1];
      if (s[j] !== ':') return null;
      const v = valueAt(s, j + 1);
      if (!v) return null;
      entries.set(decodeName(k[0]), v[0]);
      j = v[1];
      if (s[j] === ',') j++;
    }
    return [entries, j + 1];
  }
  return null;
}

/** The text of an `s…;` token. */
function decodeName(t) {
  const body = t.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 4) out += String.fromCharCode(parseInt(body.slice(i, i + 4), 16));
  return out;
}

/** This line's witnessed branch values: `field -> value` from every compact option record on it, and the named flags it
 *  sets together (`dual+durability=on/off`), so a branch is pinned by the combination the tests read. */
function witnessed(line) {
  const out = new Map(); // label -> Set(value)
  const toks = line.split(' ');
  const flags = [];
  for (let p = 1; p < toks.length; p++) {
    const t = toks[p];
    if (t.length > RECORD_CAP || (t[0] !== '{' && t[0] !== '[')) continue;
    const parsed = valueAt(t, 0);
    if (!parsed) continue;
    const walk = (v) => {
      if (v instanceof Map) {
        for (const [k, child] of v) {
          if (BRANCH_FIELDS.has(k) && !(child instanceof Map) && !Array.isArray(child)) {
            add(out, k, child);
            if (child === 'b1') flags.push(k);
          }
          if (child instanceof Map || Array.isArray(child)) walk(child);
        }
      } else if (Array.isArray(v)) {
        for (const child of v) if (child instanceof Map || Array.isArray(child)) walk(child);
      }
    };
    walk(parsed[0]);
  }
  if (flags.length) add(out, flags.sort().join('+'), 'set');
  return out;
}

function add(map, label, value) {
  let s = map.get(label);
  if (!s) map.set(label, (s = new Set()));
  s.add(value);
}

/** Per kind, the witnessed branch values across a file: kind -> label -> Set(value). */
async function branchValues(path) {
  const out = new Map(); // kind -> Map(label -> Set(value))
  await eachTextLine(path, (line) => {
    if (!line || line.startsWith('#')) return;
    const kind = line.slice(0, line.indexOf(' '));
    const found = witnessed(line);
    if (!found.size) return;
    let sets = out.get(kind);
    if (!sets) out.set(kind, (sets = new Map()));
    for (const [label, values] of found) {
      for (const v of values) {
        let s = sets.get(label);
        if (!s) sets.set(label, (s = new Set()));
        s.add(v);
        if (s.size > BRANCH_CAP) sets.delete(label); // data, not a branch
      }
    }
  });
  return out;
}

/** Requirement: for every kind, every witnessed branch value the full set has appears in the sample, and a kind that
 *  carries a witnessed field in the full set carries it in the sample too. Returns the missing ones (capped). */
async function branchAudit() {
  const missing = [];
  const modules = readdirSync(srcDir).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, '')).sort();
  for (const name of modules) {
    const full = await branchValues(join(srcDir, `${name}.txt`));
    const sampleFile = join(outDir, `${name}.txt.gz`);
    if (!existsSync(sampleFile)) { missing.push(`${name}: not in the sample`); continue; }
    const sample = await branchValues(sampleFile);
    for (const [kind, labels] of full) {
      const got = sample.get(kind);
      for (const [label, values] of labels) {
        if (!got?.has(label)) {
          missing.push(`${name}/${kind}: \`${label}\` is branched in the full set, never in the sample`);
          continue;
        }
        const have = got.get(label);
        const gone = [...values].filter((v) => !have.has(v));
        if (gone.length) {
          const shown = gone.slice(0, 4).map((v) => `\`${v}\``).join(', ');
          missing.push(`${name}/${kind} ${label}: ${gone.length} branch value(s) in the full set but not in the sample (${shown}${gone.length > 4 ? ', ...' : ''})`);
        }
      }
    }
  }
  return missing;
}

/** The hand-written case indices the generator recorded (`<module>.hand`, written by `tools/rust-vectors.mjs`). A missing
 *  file is a hard failure: treating it as "no hand cases" would silently let the sampler drop every boundary probe of a
 *  module whose generator forgot to write it. */
function handSet(name) {
  const file = join(srcDir, `${name}.hand`);
  if (!existsSync(file)) {
    throw new Error(`missing ${file}: regenerate the vectors with tools/rust-vectors.mjs (it records every hand case)`);
  }
  return new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number));
}

/** Which case indices are kept: every hand-written case, a witness for every branch value, plus the seeded ones the hash
 *  selects. `null` = every case. */
async function keepSet(name) {
  const plan = PLAN[name];
  if (!plan) return null; // no sweep worth trimming: the module is kept whole
  const hand = handSet(name);
  const kinds = new Set(plan.kinds);
  const keep = new Set(hand);
  if (plan.records) {
    // `blow_outcomes`: one build record runs from `build` up to the next `build`. The per-build kinds belong to the
    // record, so a record is kept or dropped whole (`sample_fight`/`trace` index the tier beside them). A hand-written
    // record or standalone case is kept whole.
    const perBuild = new Set(['build', 'full', 'fight', 'sample_fight', 'carry', 'sample_carry', 'trace']);
    const starts = [];
    const standalone = [];
    const handStarts = [];
    let total = 0;
    let n = 0;
    const limit = kindThreshold(plan, 'build');
    await eachLine(name, {
      onHeader() {},
      onLine(k, _l, i) {
        total = i + 1;
        if (k === 'build') starts.push({ at: i, key: key32(k, n++) });
        else if (!perBuild.has(k)) standalone.push(i);
        if (hand.has(i)) handStarts.push(i);
      },
    });
    for (const { at, key } of starts) {
      // A hand-written case inside the record (the generator marks every line it wrote by hand) keeps it.
      const idx = starts.findIndex((s) => s.at === at);
      const next = starts[idx + 1]?.at ?? total;
      const isHand = handStarts.some((i) => i >= at && i < next);
      if (!isHand && key >= limit) continue;
      for (let i = at; i < next; i++) keep.add(i);
    }
    // `merge_raw` names the last build's template, so the last `build` row stays even when its record is dropped.
    if (starts.length) keep.add(starts[starts.length - 1].at);
    for (const i of standalone) keep.add(i);
    // A witness for a branch value must keep its WHOLE record: a witness line alone would leave a `build` without the
    // `full`/`fight`/`sample_fight` rows the test reads its answers from. Any record with a kept line keeps it all.
    await addWitnesses(name, keep);
    for (const [idx, { at }] of starts.entries()) {
      const end = starts[idx + 1]?.at ?? total;
      let touched = false;
      for (let k = at; k < end && !touched; k++) touched = keep.has(k);
      if (touched) for (let k = at; k < end; k++) keep.add(k);
    }
    return keep;
  }
  // Pass 1: the per-kind sequence number of every case, so pass 2 can decide without holding the file. A kind the plan
  // does not name is kept WHOLE (`seq[i] = -1`): the plan lists the seeded sweeps, everything else is hand-written or a
  // small family.
  const seq = [];
  await eachLine(name, {
    onHeader() {},
    onLine(k, _l, i) {
      if (!kinds.has(k) || hand.has(i)) { seq[i] = -1; keep.add(i); return; }
      seq[i] = 0;
    },
  });
  const seen = new Map();
  await eachLine(name, {
    onHeader() {},
    onLine(k, _l, i) {
      if (seq[i] !== 0) return;
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      if (key32(k, n) < kindThreshold(plan, k)) keep.add(i);
    },
  });
  await addWitnesses(name, keep);
  return keep;
}

/** Add the first case that carries each witnessed branch value the kept set is missing, so a whole branch (a game
 *  build, a core, a flag and its combinations) cannot fall out of the sample whatever the hash keeps. */
async function addWitnesses(name, keep) {
  const full = new Map(); // kind -> Map(label -> Set(value)) over the whole file
  const firstSeen = new Map(); // `kind\0label\0value` -> first line index
  const data = new Map(); // kind -> Set(label): labels that proved to be data
  await eachLine(name, {
    onHeader() {},
    onLine(k, line, i) {
      const found = witnessed(line);
      if (!found.size) return;
      let sets = full.get(k);
      if (!sets) { full.set(k, (sets = new Map())); data.set(k, new Set()); }
      const dropped = data.get(k);
      for (const [label, values] of found) {
        if (dropped.has(label)) continue;
        for (const v of values) {
          let s = sets.get(label);
          if (!s) sets.set(label, (s = new Set()));
          s.add(v);
          if (s.size > BRANCH_CAP) { sets.delete(label); dropped.add(label); break; }
          const key = `${k}\0${label}\0${v}`;
          if (!firstSeen.has(key)) firstSeen.set(key, i);
        }
      }
    },
  });
  const have = new Map(); // same shape, over the kept lines
  await eachLine(name, {
    onHeader() {},
    onLine(k, line, i) {
      if (!keep.has(i)) return;
      const found = witnessed(line);
      let sets = have.get(k);
      if (!sets) have.set(k, (sets = new Map()));
      for (const [label, values] of found) {
        let s = sets.get(label);
        if (!s) sets.set(label, (s = new Set()));
        for (const v of values) s.add(v);
      }
    },
  });
  for (const [k, labels] of full) {
    for (const [label, values] of labels) {
      const got = have.get(k)?.get(label) ?? new Set();
      for (const v of values) {
        if (!got.has(v)) keep.add(firstSeen.get(`${k}\0${label}\0${v}`));
      }
    }
  }
}

/** Write the sample of one module: header, the kept lines, gzip -9 with a fixed header. Returns its sizes and counts. */
async function writeSample(name, keep) {
  const gz = createGzip({ level: 9 });
  const out = createWriteStream(join(outDir, `${name}.txt.gz`));
  gz.pipe(out);
  const raw = createHash('sha256');
  const packed = [];
  gz.on('data', (d) => packed.push(d));
  const totals = new Map();
  const kept = new Map();
  const branches = new Map(); // kind -> Map(label -> Set(value)) over the kept lines
  const header = [];
  let rawBytes = 0;
  let cases = 0;
  const put = (text) => {
    const buf = Buffer.from(`${text}\n`);
    raw.write(buf);
    rawBytes += buf.length;
    gz.write(buf);
  };
  // Pass 1 again for the totals (cheap next to the write), then the kept lines in file order.
  await eachLine(name, {
    onHeader(l) { header.push(l); },
    onLine(k) { totals.set(k, (totals.get(k) ?? 0) + 1); },
  });
  for (const l of header) put(l);
  await eachLine(name, {
    onHeader() {},
    onLine(k, l, i) {
      if (keep && !keep.has(i)) return;
      kept.set(k, (kept.get(k) ?? 0) + 1);
      cases++;
      put(l);
      // The witnessed branch values this line contributes, for the MANIFEST's record.
      const found = witnessed(l);
      if (!found.size) return;
      let sets = branches.get(k);
      if (!sets) branches.set(k, (sets = new Map()));
      for (const [label, values] of found) {
        let s = sets.get(label);
        if (!s) sets.set(label, (s = new Set()));
        for (const v of values) s.add(v);
      }
    },
  });
  gz.end();
  await new Promise((res, rej) => { out.on('close', res); out.on('error', rej); });
  const bytes = Buffer.concat(packed);
  return { bytes, rawSha: raw.digest('hex'), rawBytes, cases, totals, kept, branches };
}

function manifestFile(entries) {
  const lines = [
    '# dfo-core frozen golden vectors | written by tools/vector-freeze.mjs | format: v2',
    '# A deterministic sample of rust/tests/vectors/ (generated from the JS by tools/rust-vectors.mjs). Expected',
    '# outputs are the JS answers, copied byte for byte. The full set is archived outside the repository: see',
    '# rust/tests/frozen/README.md.',
    '#',
    '# module <name> gzip-sha256 raw-sha256 raw-bytes cases',
    '# kind <name> <kind> kept/total <hand-picked|sampled>',
    '# branch <name> <kind> <field> <values, comma-joined>',
    '#   the witnessed branch values the sample keeps: the game build, the core, the flags the tests branch on, and the',
    '#   combinations set together. --audit fails if the full set has a witnessed value the sample lacks.',
  ];
  const names = [...entries.keys()].sort();
  for (const name of names) {
    const e = entries.get(name);
    lines.push(`module ${name} ${sha256(e.bytes)} ${e.rawSha} ${e.rawBytes} ${e.cases}`);
    for (const [k, total] of [...e.totals].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const kept = e.kept.get(k) ?? 0;
      lines.push(`kind ${name} ${k} ${kept}/${total} ${kept === total ? 'hand-picked' : 'sampled'}`);
    }
    for (const [k, labels] of [...(e.branches ?? new Map())].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      for (const [label, set] of [...labels].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        lines.push(`branch ${name} ${k} ${label} ${[...set].sort().join(',')}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---- main --------------------------------------------------------------------------------------------------------
const arg = process.argv[2];
if (arg === '--archive') {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  // A fresh file each run: an earlier archive of the same day is never overwritten.
  const file = join(ARCHIVE_DIR, `dfo-vectors-full-${stamp}.tar.gz`);
  const out = createWriteStream(file);
  const z = createGzip({ level: 1 });
  z.pipe(out);
  const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
  const header = (name, size) => {
    const b = Buffer.alloc(512);
    b.write(name, 0, 100, 'utf8');
    b.write('0000644', 100, 8, 'ascii');
    b.write('0000000', 108, 8, 'ascii');
    b.write('0000000', 116, 8, 'ascii');
    b.write(`${size.toString(8).padStart(11, '0')} `, 124, 12, 'ascii');
    b.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')} `, 136, 12, 'ascii');
    b.write('        ', 148, 8, 'ascii');
    b.write('0', 156, 1, 'ascii');
    b.write('ustar\0', 257, 6, 'ascii');
    b.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const byte of b) sum += byte;
    b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    return b;
  };
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.txt') || f.endsWith('.hand') || f === '.spellbook').sort();
  let total = 0;
  for (const f of files) {
    const data = readFileSync(join(srcDir, f));
    z.write(header(`vectors/${f}`, data.length));
    z.write(data);
    z.write(pad(data.length));
    total += data.length;
    process.stdout.write(`archived ${f} (${data.length} bytes)\n`);
  }
  z.write(Buffer.alloc(1024));
  z.end();
  await new Promise((res) => out.on('close', res));
  const digest = sha256(readFileSync(file));
  writeFileSync(`${file}.sha256`, `${digest}  ${file.split('/').pop()}\n`);
  console.log(`archive: ${tilde(file)}\n  raw ${total} bytes\n  sha256 ${digest}`);
  process.exit(0);
}

// `--verify`: the committed sample must equal its own MANIFEST, byte for byte (each `.txt.gz`'s sha256, its decoded
// raw sha256, its raw size and its case count), and MANIFEST must name every module on disk. This is the gate's
// integrity check: the tests trust the sample, so a truncated, stale or foreign file must fail before them. It reads
// only the sample, so it runs before the generated vectors are (or need to be) present.
if (arg === '--verify') {
  const mods = readFileSync(join(outDir, 'MANIFEST'), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('module '))
    .map((l) => l.split(' '));
  let bad = 0;
  let totalCases = 0;
  for (const [, name, gz, raw, bytes, cases] of mods) {
    const file = join(outDir, `${name}.txt.gz`);
    if (!existsSync(file)) {
      console.log(`MISSING ${name}: ${file}`);
      bad++;
      continue;
    }
    let text;
    try {
      text = gunzipSync(readFileSync(file));
    } catch (e) {
      console.log(`CORRUPT ${name}: ${e.message}`);
      bad++;
      continue;
    }
    const got = { gz: sha256(readFileSync(file)), raw: sha256(text), bytes: text.length, cases: 0 };
    for (const line of text.toString('utf8').split('\n')) if (line && !line.startsWith('#')) got.cases++;
    totalCases += got.cases;
    if (got.gz !== gz) { console.log(`SHA ${name}: gzip ${got.gz.slice(0, 12)}, MANIFEST ${gz.slice(0, 12)}`); bad++; }
    if (got.raw !== raw) { console.log(`SHA ${name}: raw ${got.raw.slice(0, 12)}, MANIFEST ${raw.slice(0, 12)}`); bad++; }
    if (String(got.bytes) !== bytes) { console.log(`BYTES ${name}: ${got.bytes}, MANIFEST ${bytes}`); bad++; }
    if (String(got.cases) !== cases) { console.log(`CASES ${name}: ${got.cases}, MANIFEST ${cases}`); bad++; }
  }
  const onDisk = readdirSync(outDir).filter((f) => f.endsWith('.txt.gz')).length;
  if (onDisk !== mods.length) {
    console.log(`MODULES: ${onDisk} .txt.gz on disk, ${mods.length} in MANIFEST`);
    bad++;
  }
  console.log(bad
    ? `${bad} mismatch(es) in the frozen sample`
    : `frozen sample: ${mods.length} modules, ${totalCases} cases, every sha256 and count matches MANIFEST`);
  process.exit(bad ? 1 : 0);
}

if (!existsSync(srcDir)) throw new Error(`no generated vectors at ${srcDir}: run node tools/rust-vectors.mjs first`);

/** The sample may only carry the synthetic book: the game's `SPELLS.STD` cannot be committed. A set stamped `real`, or
 *  one written before the stamp existed, is refused rather than folded in. */
function requireSyntheticBook() {
  const stamp = join(srcDir, '.spellbook');
  if (!existsSync(stamp)) {
    throw new Error(`no ${stamp}: regenerate the vectors with tools/rust-vectors.mjs under the synthetic book`);
  }
  const which = readFileSync(stamp, 'utf8').trim();
  if (which !== 'synthetic') {
    throw new Error(`the vectors at ${srcDir} were made with ${which === 'real' ? 'DFO_REAL_SPELLS=1 (the game book)' : `an unknown book (${which})`}; the frozen sample ships the synthetic book only — regenerate without DFO_REAL_SPELLS`);
  }
}

// `--check`: the committed sample must equal what the generators' output would produce now (a stale sample would keep
// passing the Rust tests against answers the JS no longer gives). Same selection, compared by the raw-text digest the
// manifest records; nothing is written.
if (arg === '--check') {
  requireSyntheticBook();
  let bad = 0;
  let checked = 0;
  const manifest = new Map(
    readFileSync(join(outDir, 'MANIFEST'), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('module '))
      .map((l) => {
        const [, name, , raw] = l.split(' ');
        return [name, raw];
      }),
  );
  for (const name of readdirSync(srcDir).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, '')).sort()) {
    const keep = await keepSet(name);
    // The gzip bytes are not stable across zlib builds; the raw selected text is what the manifest also pins.
    const hash = createHash('sha256');
    await eachLine(name, {
      onHeader(l) { hash.update(`${l}\n`); },
      onLine(_k, l, i) {
        if (keep && !keep.has(i)) return;
        hash.update(`${l}\n`);
      },
    });
    const got = hash.digest('hex');
    const want = manifest.get(name);
    checked++;
    if (!want) {
      console.log(`MISSING ${name}: no manifest entry`);
      bad++;
    } else if (want !== got) {
      console.log(`STALE ${name}: manifest ${want.slice(0, 12)}, current ${got.slice(0, 12)}`);
      bad++;
    }
  }
  console.log(bad ? `${bad} module(s) differ` : `${checked} modules match the generators' output`);
  process.exit(bad ? 1 : 0);
}

// A sample that leaves the size band, drops a hand-written case, or misses a witnessed branch value the full set has is
// a failure, not a note: the first is the owner's budget, the other two are what make the sample a fair substitute.
if (arg === '--audit') {
  const auditFailures = await audit();
  console.log(auditFailures.length ? `--- ${auditFailures.length} audit failure(s):` : `audit: every hand case kept, every witnessed branch value covered, ${(gzSum() / 1048576).toFixed(1)} MiB inside the band`);
  // Branch failures first: they are the ones a shrunken sample hides among many hand-case failures.
  const ordered = [...auditFailures].sort((a, b) => Number(!/branch/.test(a)) - Number(!/branch/.test(b)));
  for (const f of ordered.slice(0, 40)) console.log(`  ${f}`);
  if (ordered.length > 40) console.log(`  ... and ${ordered.length - 40} more`);
  process.exit(auditFailures.length ? 1 : 0);
}
/** The sample's gzipped size on disk. */
function gzSum() {
  let n = 0;
  for (const f of readdirSync(outDir).filter((f) => f.endsWith('.txt.gz'))) n += readFileSync(join(outDir, f)).length;
  return n;
}

/** Every audit the freeze runs after writing: the hand cases are all kept, the witnessed branch values are all covered,
 *  the size is inside the band. Returns the failures (empty is a pass). */
async function audit() {
  const failures = [];
  const modules = readdirSync(srcDir).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, '')).sort();
  for (const name of modules) {
    const sampleFile = join(outDir, `${name}.txt.gz`);
    if (!existsSync(sampleFile)) { failures.push(`${name}: not in the sample`); continue; }
    const hand = handSet(name);
    if (!hand.size) continue;
    // Every hand-written case must be in the sample, counting duplicates: a case the generator wrote twice must appear
    // twice. Compare the multiset of the hand lines with the kept lines' multiset.
    const keptCount = new Map();
    for (const line of gunzipSync(readFileSync(sampleFile)).toString('utf8').split('\n')) {
      if (line && !line.startsWith('#')) keptCount.set(line, (keptCount.get(line) ?? 0) + 1);
    }
    const wantCount = new Map();
    await eachLine(name, {
      onHeader() {},
      onLine(_k, line, i) {
        if (hand.has(i)) wantCount.set(line, (wantCount.get(line) ?? 0) + 1);
      },
    });
    for (const [line, want] of wantCount) {
      const got = keptCount.get(line) ?? 0;
      if (got < want) {
        failures.push(`${name}: hand-written case (\`${line.slice(0, 80)}\`) kept ${got} of ${want} time(s)`);
      }
    }
  }
  failures.push(...(await branchAudit()));
  const gzTotal = gzSum();
  if (gzTotal < SIZE_MIN || gzTotal > SIZE_MAX) {
    failures.push(`the sample is ${(gzTotal / 1048576).toFixed(1)} MiB, outside the ${SIZE_MIN / 1048576}-${SIZE_MAX / 1048576} MiB band`);
  }
  return failures;
}

mkdirSync(outDir, { recursive: true });
requireSyntheticBook();
const entries = new Map();
let gzTotal = 0;
let rawTotal = 0;
for (const name of readdirSync(srcDir).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, '')).sort()) {
  const keep = await keepSet(name);
  const e = await writeSample(name, keep);
  entries.set(name, e);
  gzTotal += e.bytes.length;
  rawTotal += e.rawBytes;
  console.log(`${name}: ${e.cases} cases kept, ${e.rawBytes} bytes raw, ${e.bytes.length} bytes gz`);
}
writeFileSync(join(outDir, 'MANIFEST'), manifestFile(entries));
console.log(`frozen: ${entries.size} modules, ${rawTotal} bytes raw, ${gzTotal} bytes gz (${(gzTotal / 1048576).toFixed(1)} MiB)`);
const writeFailures = await audit();
if (writeFailures.length) {
  console.log(`FAIL: ${writeFailures.length} audit failure(s):`);
  for (const f of writeFailures.slice(0, 40)) console.log(`  ${f}`);
  if (writeFailures.length > 40) console.log(`  ... and ${writeFailures.length - 40} more`);
  process.exit(1);
}
console.log(`audit: every hand case kept, every witnessed branch value covered, ${(gzTotal / 1048576).toFixed(1)} MiB inside the band`);
