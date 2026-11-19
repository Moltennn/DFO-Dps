/*
 * The JS side of the generic value codec (milestone R4a). The Rust reader and writer are `rust/dfo-core/src/value.rs`;
 * the grammar is in `rust/README.md` (R4a). Shared by `tools/rust-data.mjs` (the generated power-table tokens) and
 * `tools/rust-vectors.mjs`, which re-exports `encodeValue`. It is a leaf: no imports, no side effects.
 *
 * Token grammar (one token per value, no spaces):
 *   u undefined | n null | b1 / b0 bool | d<16 lowercase hex> the f64 bits (every NaN is the canonical NaN)
 *   s<4 lowercase hex per UTF-16 unit>; a string (a lone surrogate is refused)
 *   [v,v,...] an array (an undefined item is u) | {s<key>;:v,...} an object, own enumerable keys in JS key order
 * A Map is its [key, value] pairs (an array). A function as an object key is skipped (as rust-data's normalize skips it);
 * a function anywhere else, a symbol, a bigint, or a circular reference throws.
 */

const dv = new DataView(new ArrayBuffer(8));
const NAN_HEX = (0x7ff8000000000000n).toString(16);

/** An f64 token: `d` and the 16 hex digits of its IEEE bits (NaN is written canonically). */
export function numToken(x) {
  if (Number.isNaN(x)) return `d${NAN_HEX}`;
  dv.setFloat64(0, x);
  return `d${dv.getBigUint64(0).toString(16).padStart(16, '0')}`;
}

/** A string token: `s`, four hex digits per UTF-16 unit, `;`. Throws on a lone surrogate. */
export function strToken(s) {
  let out = 's';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw new Error(`encodeValue: a lone high surrogate at unit ${i}`);
      out += c.toString(16).padStart(4, '0') + d.toString(16).padStart(4, '0');
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new Error(`encodeValue: a lone low surrogate at unit ${i}`);
    } else {
      out += c.toString(16).padStart(4, '0');
    }
  }
  return `${out};`;
}

/** Encode a JS value as one token (see the grammar above). */
export function encodeValue(x) {
  return enc(x, []);
}

function enc(x, stack) {
  if (x === undefined) return 'u';
  if (x === null) return 'n';
  switch (typeof x) {
    case 'boolean':
      return x ? 'b1' : 'b0';
    case 'number':
      return numToken(x);
    case 'string':
      return strToken(x);
    case 'object':
      break;
    default:
      throw new Error(`encodeValue: a ${typeof x} is not a value`);
  }
  if (stack.includes(x)) throw new Error('encodeValue: a circular reference');
  stack.push(x);
  try {
    if (x instanceof Map) return enc([...x.entries()], stack);
    if (Array.isArray(x)) {
      const parts = [];
      for (let i = 0; i < x.length; i++) {
        if (typeof x[i] === 'function') throw new Error(`encodeValue: a function at index ${i}`);
        parts.push(enc(x[i], stack));
      }
      return `[${parts.join(',')}]`;
    }
    const parts = [];
    for (const k of Object.keys(x)) {
      if (typeof x[k] === 'function') continue;
      parts.push(`${strToken(k)}:${enc(x[k], stack)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    stack.pop();
  }
}
