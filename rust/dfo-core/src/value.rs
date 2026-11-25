//! The generic JS value (milestone R4a): the dynamic objects the model reads (a character, an item and its affixes,
//! a scenario) as one enum, with the JS reads the ported code makes, and a canonical text codec the golden vectors use.
//!
//! The enum mirrors JSON-like JS values. `Obj` keeps the JS key order (an own property's order: array-index keys
//! ascending, then the rest in creation order, see [`Value::set`]). A key that is missing is `Undefined` when read, but
//! `has` tells it from a key present with `undefined`. `Str` holds valid Unicode only: a lone surrogate is refused
//! (the codec and the generator both refuse it, as `tools/rust-data.mjs` does).
//!
//! Reads mirror the JS they port (see each function's doc): [`Value::get`] is `obj[key]` for a string key, [`Value::prop`]
//! is `o[k]` for any key, [`Value::finite_or`] is `Number.isFinite(v) ? v : d` (no coercion), [`Value::num_or`] is
//! `v ?? d` for a number, [`Value::to_number`] is `Number(v)`, [`Value::to_js_string`] is `String(v)` and a template
//! literal. A JS value the port reads as a number, but that is not one, reads as `NaN` in [`Value::num_or`]: the JS
//! would concatenate or coerce it, which no port reads (the vectors never pass one; see `rust/README.md`, R4a).
//!
//! Codec (one token per value, no spaces; the grammar is in `rust/README.md`, R4a): `u` undefined, `n` null, `b1`/`b0`
//! bool, `d` + 16 lowercase hex digits = the f64 bits (NaN is written `7ff8000000000000`), `s` + 4 lowercase hex digits
//! per UTF-16 unit + `;` = a string, `[` items separated by `,` `]` an array, `{` `s`-key `:` value, `,`-separated `}`
//! an object. `parse(write(v))` is `v` except that a NaN's payload is not kept.

use crate::generated::js_prototypes::{
    ARRAY_PROTOTYPE_KEYS, BOOLEAN_PROTOTYPE_KEYS, NUMBER_PROTOTYPE_KEYS, OBJECT_PROTOTYPE_KEYS,
    STRING_PROTOTYPE_KEYS,
};
use std::fmt;

/// A JS value. See the module doc for the reads each accessor mirrors.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    /// Own properties in JS key order (see [`Value::set`]). Keys are unique.
    Obj(Vec<(String, Value)>),
}

/// The `undefined` a read of a missing key gives (`get` returns a reference to it).
pub static UNDEFINED: Value = Value::Undefined;

/// The bits every NaN is written as (the JS engine's canonical NaN; the payload is not meaningful in JS).
pub const NAN_BITS: u64 = 0x7ff8_0000_0000_0000;

/// A codec failure: what was read wrong, and the byte it was read at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodecError {
    pub at: usize,
    pub msg: &'static str,
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "value codec: {} at byte {}", self.msg, self.at)
    }
}

impl std::error::Error for CodecError {}

/// A canonical array index property key (`"0"` ..= `"4294967294"`, no sign, no leading zero), as JS treats it.
pub fn index_key(k: &str) -> Option<u32> {
    let n: u32 = k.parse().ok()?;
    if n == u32::MAX || n.to_string() != k {
        return None;
    }
    Some(n)
}

/// JS whitespace for `StringToNumber`: WhiteSpace and LineTerminator (not U+0085, which Rust counts; U+FEFF, which it does
/// not).
fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `Number(string)` (ECMAScript StringToNumber): the empty string is 0; `0x`/`0o`/`0b` integers (no sign); `Infinity`
/// with an optional sign; otherwise a StrDecimalLiteral, parsed with the correctly rounded `f64` parser. Anything else
/// is NaN. Hex, octal and binary integers are rounded to nearest-even at any length (see `parse_radix`).
pub fn string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(is_js_space);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return parse_radix(digits, radix);
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if is_decimal_literal(t) {
        t.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// The value of a radix-2/8/16 digit string, rounded to nearest-even as JS rounds it, at any length. The bits of the digits
/// are taken most significant first. The top 64 significant bits form the mantissa; every bit below them is folded into
/// its lowest bit as a sticky bit. That bit sits far below the 53-bit rounding position, so `as f64` rounds the 64-bit
/// value exactly as the full integer would round. The scale is an exact power of two (overflow gives infinity, as JS does).
fn parse_radix(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return f64::NAN;
    }
    let per_digit = radix.trailing_zeros();
    let mut bits: Vec<bool> = Vec::with_capacity(digits.len() * per_digit as usize);
    for d in digits.chars().filter_map(|c| c.to_digit(radix)) {
        for k in (0..per_digit).rev() {
            bits.push(((d >> k) & 1) == 1);
        }
    }
    let Some(first) = bits.iter().position(|b| *b) else {
        return 0.0;
    };
    let sig = &bits[first..];
    let top: u64 = sig
        .iter()
        .take(64)
        .fold(0, |acc, b| (acc << 1) | u64::from(*b));
    // mutation: equivalent - at exactly 64 significant bits sig[64..] is empty, so the sticky is false, mantissa = top and the scale is 2^0, which is `top as f64` exactly.
    if sig.len() <= 64 {
        return top as f64;
    }
    let sticky = sig[64..].iter().any(|b| *b);
    let mantissa = top | u64::from(sticky);
    (mantissa as f64) * 2f64.powi((sig.len() - 64) as i32)
}

/// `[+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?`, at least one digit before or after the point.
fn is_decimal_literal(t: &str) -> bool {
    let b = match t.as_bytes().first() {
        Some(b'+') | Some(b'-') => &t.as_bytes()[1..],
        _ => t.as_bytes(),
    };
    // mutation: equivalent - with i = 1 every grammar-valid string still scans to its end (its b[0] is a digit or '.', the rest scans identically, and int_digits >= 1 only skips the zero check), and each string the start-at-1 scan admits that the grammar rejects has no mantissa digit or is one of inf/nan/infinity, which never reaches the end of the scan; from_str rejects the former and the latter is rejected here, so both sides give NaN.
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i;
    // mutation: equivalent - frac is overwritten whenever a '.' is scanned, so the init matters only with no '.', and then the zero check admits only a span with no integer digit and no '.', i.e. a lone e-part, which from_str rejects.
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        // mutation: equivalent - `i + start` differs from `i - start` only when the frac count is zero, which matters only with no integer digit (the zero check), i.e. a '.' with no digit at all, which from_str rejects.
        frac_digits = i - start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == b.len()
}

/// `Number.prototype.toString()` for a double (ECMAScript Number::toString, radix 10): the shortest digits that round-trip
/// (Rust's `{:e}` gives them), laid out with JS's thresholds (exponent form from 1e21 and below 1e-6).
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    if x.is_infinite() {
        // mutation: equivalent - this arm runs only when x.is_infinite(), so x is +inf or -inf, and `x > 0.0`, `x >= 0.0` and `x > 1.0` each hold exactly for +inf.
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    // An integer below 2^53 prints as its own decimal digits. Property reads by skill or template id come through here,
    // and the float formatter below cost a quarter of a planner run.
    // mutation: equivalent - 2^53 itself prints the same digits on either path, so `<` and `<=` agree; the literal one
    // higher is no double and rounds back to 2^53; and `fract() == 1.0` is never true, which only sends integers down
    // the formatter below, whose output is the same (the test `integer_fast_path_prints_what_the_float_formatter_prints`
    // compares the two forms).
    if x.fract() == 0.0 && x.abs() < 9007199254740992.0 {
        return (x as i64).to_string();
    }
    // mutation: equivalent - NaN, zero and the infinities returned above, so x is finite and nonzero here, and for such x `x < 0.0` and `x <= 0.0` are the same test.
    let sign = if x < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", x.abs());
    let (mant, exp) = sci.split_once('e').expect("{:e} always has an exponent");
    let exp: i32 = exp.parse().expect("{:e} exponent is an integer");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp + 1;
    let body = if (k..=21).contains(&n) {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if (1..=21).contains(&n) {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    // mutation: equivalent - n == 1 always matches the (1..=21) arm above (or the (k..=21) arm before it, since k >= 1), so the (-5..=1) window never tests n == 1.
    } else if (-5..=0).contains(&n) {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        // mutation: equivalent - this arm is reached only with n <= -6 or n >= 22 (the arms above cover [k..=21], [1..=21] and [-5..=0], and k >= 1), so e = n - 1 is <= -7 or >= 21: never 0, and `e < 0`, `e <= 0`, `e < 1` agree.
        let es = if e < 0 { "-" } else { "+" };
        if k == 1 {
            format!("{digits}e{es}{}", e.abs())
        } else {
            format!("{}.{}e{es}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    format!("{sign}{body}")
}

impl Value {
    /// `obj[key]` for a string key on an object: the value, or [`UNDEFINED`] when the key is absent (and for any
    /// value that is not an object, as JS reads an undefined property of a primitive). Use [`Value::has`] to tell a
    /// missing key from one present with `undefined`.
    pub fn get(&self, key: &str) -> &Value {
        if let Value::Obj(entries) = self {
            if let Some((_, v)) = entries.iter().find(|(k, _)| k.as_str() == key) {
                return v;
            }
        }
        &UNDEFINED
    }

    /// `arr[i]` on an array: the element, or [`UNDEFINED`] past the end (and for a non-array).
    pub fn at(&self, i: usize) -> &Value {
        if let Value::Arr(items) = self {
            if let Some(v) = items.get(i) {
                return v;
            }
        }
        &UNDEFINED
    }

    /// `key in obj` for an own property (an object only).
    pub fn has(&self, key: &str) -> bool {
        matches!(self, Value::Obj(entries) if entries.iter().any(|(k, _)| k.as_str() == key))
    }

    /// `obj[key] = val` for an object, in JS order: an existing key keeps its place, an array-index key goes among the
    /// index keys in ascending order, and any other new key is appended. Panics on a non-object (the port builds
    /// objects only through this, so a non-object is a bug in the port).
    pub fn set(&mut self, key: &str, val: Value) {
        let Value::Obj(entries) = self else {
            panic!("Value::set on a non-object: the port builds objects only");
        };
        if let Some(slot) = entries.iter_mut().find(|(k, _)| k.as_str() == key) {
            slot.1 = val;
            return;
        }
        let pos = match index_key(key) {
            Some(n) => entries
                .iter()
                .position(|(k, _)| match index_key(k) {
                    None => true,
                    // mutation: equivalent - the existing-key search above returned for any entry whose canonical index is n, so no entry here has index m == n and `m > n` is `m >= n`.
                    Some(m) => m > n,
                })
                .unwrap_or(entries.len()),
            None => entries.len(),
        };
        entries.insert(pos, (key.to_owned(), val));
    }

    /// `o[k]` for any key value (`ToPropertyKey` first, see [`Value::to_js_string`]). An array reads its elements and
    /// `length`; a string reads its UTF-16 units and `length`; any other primitive, and `undefined`/`null`, read
    /// `undefined` (JS optional chaining's `?.[k]` on a primitive). Returned owned: the read is a copy. One half of an
    /// astral character is a lone surrogate, which a `Value` cannot hold: that read is `undefined` here, and the
    /// generator skips such a case (rust/README.md, R4a).
    pub fn prop(&self, key: &Value) -> Value {
        let k = key.to_js_string();
        match self {
            Value::Undefined | Value::Null => Value::Undefined,
            Value::Obj(_) => {
                if self.has(&k) {
                    return self.get(&k).clone();
                }
                refuse_inherited(&k, "an object", &[OBJECT_PROTOTYPE_KEYS]);
                Value::Undefined
            }
            Value::Arr(items) => match index_key(&k) {
                Some(i) => items.get(i as usize).cloned().unwrap_or(Value::Undefined),
                None if k == "length" => Value::Num(items.len() as f64),
                None => {
                    let names = [OBJECT_PROTOTYPE_KEYS, ARRAY_PROTOTYPE_KEYS];
                    refuse_inherited(&k, "an array", &names);
                    Value::Undefined
                }
            },
            Value::Str(s) => {
                let units: Vec<u16> = s.encode_utf16().collect();
                match index_key(&k) {
                    Some(i) => match units.get(i as usize) {
                        Some(u) => String::from_utf16(&[*u])
                            .map(Value::Str)
                            .unwrap_or(Value::Undefined),
                        None => Value::Undefined,
                    },
                    None if k == "length" => Value::Num(units.len() as f64),
                    None => {
                        let names = [OBJECT_PROTOTYPE_KEYS, STRING_PROTOTYPE_KEYS];
                        refuse_inherited(&k, "a string", &names);
                        Value::Undefined
                    }
                }
            }
            Value::Num(_) => {
                let names = [OBJECT_PROTOTYPE_KEYS, NUMBER_PROTOTYPE_KEYS];
                refuse_inherited(&k, "a number", &names);
                Value::Undefined
            }
            Value::Bool(_) => {
                let names = [OBJECT_PROTOTYPE_KEYS, BOOLEAN_PROTOTYPE_KEYS];
                refuse_inherited(&k, "a boolean", &names);
                Value::Undefined
            }
        }
    }

    /// `v == null` (undefined or null).
    pub fn is_nullish(&self) -> bool {
        matches!(self, Value::Undefined | Value::Null)
    }

    /// `!!v` (JS truthiness): `undefined`, `null`, `false`, `+0`, `-0`, `NaN` and `""` are false; everything else is true.
    pub fn truthy(&self) -> bool {
        match self {
            Value::Undefined | Value::Null => false,
            Value::Bool(b) => *b,
            Value::Num(n) => !(*n == 0.0 || n.is_nan()),
            Value::Str(s) => !s.is_empty(),
            Value::Arr(_) | Value::Obj(_) => true,
        }
    }

    /// `v === w` (strict equality). Two objects are equal only by identity, which the port never asks of two values.
    pub fn strict_eq(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Undefined, Value::Undefined) | (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Num(a), Value::Num(b)) => a == b,
            (Value::Str(a), Value::Str(b)) => a == b,
            _ => false,
        }
    }

    /// `SameValueZero` (`Array.prototype.includes`, `Map` and `Set` keys): NaN equals NaN and `+0` equals `-0`.
    pub fn same_value_zero(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Num(a), Value::Num(b)) => (a.is_nan() && b.is_nan()) || a == b,
            _ => self.strict_eq(other),
        }
    }

    /// `Number.isFinite(v) ? v : d` (no coercion: a non-number is not finite). `save.js` `NUM` is this with `d = 0`.
    pub fn finite_or(&self, d: f64) -> f64 {
        match self {
            Value::Num(n) if n.is_finite() => *n,
            _ => d,
        }
    }

    /// `v ?? d` for a value the port reads as a number: `undefined` and `null` give `d`, a number is itself, and any
    /// other value is NaN (out of the port's domain; see the module doc).
    pub fn num_or(&self, d: f64) -> f64 {
        match self {
            Value::Undefined | Value::Null => d,
            Value::Num(n) => *n,
            _ => f64::NAN,
        }
    }

    /// `Number(v) || d`: the default replaces NaN and both zeros (see [`crate::round::or_default`]).
    pub fn num_or_default(&self, d: f64) -> f64 {
        crate::round::or_default(self.to_number(), d)
    }

    /// `Number(v)` (ToNumber). An array or object is converted through its string (`[]` is 0, `[5]` is 5, an object NaN).
    pub fn to_number(&self) -> f64 {
        match self {
            Value::Undefined => f64::NAN,
            Value::Null => 0.0,
            Value::Bool(b) => f64::from(u8::from(*b)),
            Value::Num(n) => *n,
            Value::Str(s) => string_to_number(s),
            Value::Arr(_) | Value::Obj(_) => string_to_number(&self.to_js_string()),
        }
    }

    /// `String(v)`, the template literal's `${v}`, and a property key (`ToPropertyKey`). An array joins its items with
    /// `,` (an `undefined` or `null` item is empty); an object is `[object Object]`.
    pub fn to_js_string(&self) -> String {
        match self {
            Value::Undefined => "undefined".to_owned(),
            Value::Null => "null".to_owned(),
            Value::Bool(b) => b.to_string(),
            Value::Num(n) => number_to_string(*n),
            Value::Str(s) => s.clone(),
            Value::Arr(items) => items
                .iter()
                .map(|v| {
                    if v.is_nullish() {
                        String::new()
                    } else {
                        v.to_js_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
            Value::Obj(_) => "[object Object]".to_owned(),
        }
    }

    /// The string a value is, when it is one.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    /// `v === s` for a string `s`.
    pub fn is_str(&self, s: &str) -> bool {
        self.as_str() == Some(s)
    }

    /// The own entries of an object in JS key order, or none (for a value that is not an object).
    pub fn entries(&self) -> &[(String, Value)] {
        match self {
            Value::Obj(entries) => entries.as_slice(),
            _ => &[],
        }
    }

    /// The items of an array, or none (`Array.isArray(v) ? v : []`, the `?? []` of a `for...of`).
    pub fn items(&self) -> &[Value] {
        match self {
            Value::Arr(items) => items.as_slice(),
            _ => &[],
        }
    }

    /// The array index a value reads as (`arr[v]` finds an element), if it names one: an integer number from 0 to
    /// 2^32 - 2, or a canonical index string. `-0` is index 0 (ToPropertyKey gives `"0"`).
    pub fn array_index(&self) -> Option<usize> {
        match self {
            Value::Num(n)
                // mutation: equivalent - the only consumer (save.rs skill_name) does SKILL_NAMES.get(i), which is None for every i >= 35, and at n = 2^32 - 1 the mutant's Some(n) also misses, so skill_name falls through to the same String either way.
                if n.is_finite() && n.trunc() == *n && *n >= 0.0 && *n < 4_294_967_295.0 =>
            {
                Some(*n as usize)
            }
            Value::Str(s) => index_key(s).map(|i| i as usize),
            _ => None,
        }
    }
}

/// `TABLE[key]` for a table written as a JS object with integer keys (`save.js` `WEAPON_SKILL`, `RACE_NAMES`, and
/// the equip-rule rows). A property key compares as its string, so `"113"` and `113` both find template 113.
pub fn obj_table_get<T: Copy>(table: &[(i64, T)], key: &Value) -> Option<T> {
    let k = key.to_js_string();
    if let Some((_, v)) = table.iter().find(|(i, _)| i.to_string() == k) {
        return Some(*v);
    }
    refuse_inherited(&k, "an object table", &[OBJECT_PROTOTYPE_KEYS]);
    None
}

/// `TABLE[key] !== undefined` for an object table (the truthiness some call sites test, e.g. `WEAPONS[t] ? ...`). An
/// inherited name is refused, as in [`obj_table_get`].
pub fn obj_table_has<T>(table: &[(i64, T)], key: &Value) -> bool {
    let k = key.to_js_string();
    if table.iter().any(|(i, _)| i.to_string() == k) {
        return true;
    }
    refuse_inherited(&k, "an object table", &[OBJECT_PROTOTYPE_KEYS]);
    false
}

/// The refusal of a read that JS answers with an inherited member (a function, or an object such as `Object.prototype`
/// for `__proto__`): a `Value` cannot hold one, so the port panics rather than answer. `names` are the prototype's own
/// names (the generated `*_PROTOTYPE_KEYS`). Only a name in the list is refused; every other name reads `undefined`.
pub fn refuse_inherited(k: &str, owner: &str, names: &[&[&str]]) {
    if names.iter().any(|list| list.contains(&k)) {
        panic!(
            "not representable: JS reads the inherited `{k}` of {owner} (a function or an object); a Value cannot hold it"
        );
    }
}

/// `MAP.get(key)` for a `Map` with integer keys (`weapons.js` `WEAPON_SKILL_USED`). A `Map` compares keys by
/// SameValueZero, so only a number equal to a key finds it (`"113"` does not).
pub fn map_table_get<T: Copy>(table: &[(i64, T)], key: &Value) -> Option<T> {
    table
        .iter()
        .find(|(i, _)| key.same_value_zero(&Value::Num(*i as f64)))
        .map(|(_, v)| *v)
}

/// `Value` to its canonical token (see the module doc). Strings are UTF-16 units, so the output has no spaces.
pub fn write(v: &Value) -> String {
    let mut out = String::new();
    write_into(v, &mut out);
    out
}

fn write_into(v: &Value, out: &mut String) {
    match v {
        Value::Undefined => out.push('u'),
        Value::Null => out.push('n'),
        Value::Bool(true) => out.push_str("b1"),
        Value::Bool(false) => out.push_str("b0"),
        Value::Num(x) => {
            let bits = if x.is_nan() { NAN_BITS } else { x.to_bits() };
            out.push_str(&format!("d{bits:016x}"));
        }
        Value::Str(s) => write_str(s, out),
        Value::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_into(item, out);
            }
            out.push(']');
        }
        Value::Obj(entries) => {
            out.push('{');
            for (i, (k, val)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_str(k, out);
                out.push(':');
                write_into(val, out);
            }
            out.push('}');
        }
    }
}

fn write_str(s: &str, out: &mut String) {
    out.push('s');
    for u in s.encode_utf16() {
        out.push_str(&format!("{u:04x}"));
    }
    out.push(';');
}

/// Parse one token (the whole text must be one value). Strict: lowercase hex only, no spaces, no trailing text.
pub fn parse(text: &str) -> Result<Value, CodecError> {
    let mut p = Parser {
        b: text.as_bytes(),
        i: 0,
    };
    let v = p.value()?;
    if p.i != p.b.len() {
        return Err(p.err("trailing text after the value"));
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn err(&self, msg: &'static str) -> CodecError {
        CodecError { at: self.i, msg }
    }

    fn bump(&mut self) -> Result<u8, CodecError> {
        let c = match self.b.get(self.i) {
            Some(c) => *c,
            None => return Err(self.err("unexpected end of text")),
        };
        self.i += 1;
        Ok(c)
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn expect(&mut self, c: u8, msg: &'static str) -> Result<(), CodecError> {
        if self.bump()? == c {
            Ok(())
        } else {
            Err(self.err(msg))
        }
    }

    /// Exactly `n` lowercase hex digits.
    fn hex(&mut self, n: usize) -> Result<u64, CodecError> {
        // mutation: equivalent - hex(4) gives (1 << 16) | x, which `as u16` reduces to x, and hex(16) gives (1 << 64) | x where the 1 is shifted out of the u64 by the sixteen `<< 4`, so both return x.
        let mut acc: u64 = 0;
        for _ in 0..n {
            let c = self.bump()?;
            let d = match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                _ => return Err(self.err("expected a lowercase hex digit")),
            };
            acc = (acc << 4) | u64::from(d);
        }
        Ok(acc)
    }

    /// The body of a string, after its `s`: 4 hex digits per unit, ended by `;`.
    fn string(&mut self) -> Result<String, CodecError> {
        let mut units: Vec<u16> = Vec::new();
        loop {
            if self.peek() == Some(b';') {
                self.i += 1;
                break;
            }
            units.push(self.hex(4)? as u16);
        }
        match String::from_utf16(&units) {
            Ok(s) => Ok(s),
            Err(_) => Err(self.err("a lone surrogate is not a Rust string")),
        }
    }

    fn value(&mut self) -> Result<Value, CodecError> {
        match self.bump()? {
            b'u' => Ok(Value::Undefined),
            b'n' => Ok(Value::Null),
            b'b' => match self.bump()? {
                b'1' => Ok(Value::Bool(true)),
                b'0' => Ok(Value::Bool(false)),
                _ => Err(self.err("expected 1 or 0 after b")),
            },
            b'd' => Ok(Value::Num(f64::from_bits(self.hex(16)?))),
            b's' => Ok(Value::Str(self.string()?)),
            b'[' => {
                let mut items = Vec::new();
                if self.peek() == Some(b']') {
                    self.i += 1;
                    return Ok(Value::Arr(items));
                }
                loop {
                    items.push(self.value()?);
                    match self.bump()? {
                        b',' => {}
                        b']' => break,
                        _ => return Err(self.err("expected , or ] in an array")),
                    }
                }
                Ok(Value::Arr(items))
            }
            b'{' => {
                let mut entries: Vec<(String, Value)> = Vec::new();
                if self.peek() == Some(b'}') {
                    self.i += 1;
                    return Ok(Value::Obj(entries));
                }
                loop {
                    if self.bump()? != b's' {
                        return Err(self.err("expected a key"));
                    }
                    let k = self.string()?;
                    self.expect(b':', "expected : after a key")?;
                    if entries.iter().any(|(e, _)| *e == k) {
                        return Err(self.err("duplicate key"));
                    }
                    let v = self.value()?;
                    entries.push((k, v));
                    match self.bump()? {
                        b',' => {}
                        b'}' => break,
                        _ => return Err(self.err("expected , or } in an object")),
                    }
                }
                Ok(Value::Obj(entries))
            }
            _ => Err(self.err("unknown token")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The token of a number's bits, built from `to_bits` so the test never counts digits by hand.
    fn num_tok(x: f64) -> String {
        format!("d{:016x}", x.to_bits())
    }

    #[test]
    fn codec_round_trips_awkward_numbers() {
        for x in [
            0.0,
            -0.0,
            1.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            5e-324,
            0.1,
        ] {
            let text = write(&Value::Num(x));
            let back = parse(&text).unwrap();
            let Value::Num(y) = back else {
                panic!("not a number")
            };
            assert_eq!(write(&Value::Num(y)), text);
        }
        assert_eq!(write(&Value::Num(1.0)), num_tok(1.0));
        assert_eq!(write(&Value::Num(-0.0)), num_tok(-0.0));
        assert_eq!(write(&Value::Num(f64::NAN)), format!("d{:016x}", NAN_BITS));
        assert_eq!(write(&Value::Num(f64::NAN)).len(), 17);
    }

    #[test]
    fn codec_keeps_key_order_and_missing_is_not_null() {
        let text = format!("{{s0061;:{},s0063;:n}}", num_tok(0.0));
        let v = parse(&text).unwrap();
        assert_eq!(write(&v), text);
        assert!(v.has("a"));
        assert!(!v.has("b"));
        assert_eq!(v.get("b"), &Value::Undefined);
        assert_eq!(v.get("c"), &Value::Null);
    }

    #[test]
    fn codec_refuses_a_lone_surrogate_and_trailing_text() {
        assert!(parse("sd800;").is_err());
        assert!(parse("u u").is_err());
        assert!(parse("d3FF0000000000000").is_err());
    }

    #[test]
    fn set_orders_index_keys_first() {
        let mut o = Value::Obj(Vec::new());
        o.set("b", Value::Num(1.0));
        o.set("10", Value::Num(2.0));
        o.set("2", Value::Num(3.0));
        o.set("a", Value::Num(4.0));
        let keys: Vec<&str> = match &o {
            Value::Obj(e) => e.iter().map(|(k, _)| k.as_str()).collect(),
            _ => unreachable!(),
        };
        assert_eq!(keys, ["2", "10", "b", "a"]);
    }

    #[test]
    fn js_number_strings() {
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(
            number_to_string(123456789012345680000.0),
            "123456789012345680000"
        );
        assert_eq!(number_to_string(1e-7), "1e-7");
        assert_eq!(number_to_string(0.000001), "0.000001");
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(1.5), "1.5");
        assert_eq!(number_to_string(5e-324), "5e-324");
    }

    // Local invariant: the integer fast path against std's float `Display`, which writes an integral double below
    // 1e21 as plain digits, as JS does (std keeps the sign of -0, checked above).
    #[test]
    fn integer_fast_path_prints_what_the_float_formatter_prints() {
        let edges = (0..63).flat_map(|p| {
            let x = 2f64.powi(p);
            [x - 1.0, x, x + 1.0, x + 2.0, x - 0.5, x + 0.5]
        });
        for x in (1..=100_000).map(f64::from).chain(edges) {
            if x != 0.0 {
                assert_eq!(number_to_string(x), format!("{x}"));
                assert_eq!(number_to_string(-x), format!("{}", -x));
            }
        }
    }

    #[test]
    fn hex_past_2_53_rounds_to_nearest() {
        assert_eq!(
            string_to_number(&format!("0x{}", "f".repeat(30))),
            2f64.powi(120)
        );
        assert_eq!(string_to_number("0x20000000000001"), 9007199254740992.0);
        assert_eq!(string_to_number("0x20000000000003"), 9007199254740996.0);
    }

    #[test]
    #[should_panic(expected = "not representable")]
    fn an_inherited_read_is_refused_not_answered() {
        // JS: ({})['constructor'] is the Object function, which a Value cannot hold.
        let _ = Value::Obj(Vec::new()).prop(&Value::Str("constructor".into()));
    }

    #[test]
    fn uppercase_forms_and_string_identity() {
        // Number('0O17') is 15, Number('0B101') is 5, Number('0X1F') is 31, Number('1E3') is 1000 (JS).
        assert_eq!(string_to_number("0O17"), 15.0);
        assert_eq!(string_to_number("0B101"), 5.0);
        assert_eq!(string_to_number("0X1F"), 31.0);
        assert_eq!(string_to_number("1E3"), 1000.0);
        assert_eq!(string_to_number("1e3"), 1000.0);
        assert_eq!(string_to_number("5E-1"), 0.5);
        assert!(Value::Str(String::new()).strict_eq(&Value::Str(String::new())));
        assert!(Value::Str("é😀".into()).strict_eq(&Value::Str("é😀".into())));
        assert!(!Value::Str("a".into()).strict_eq(&Value::Str("b".into())));
        assert_eq!(number_to_string(-1e21), "-1e+21");
        assert_eq!(number_to_string(-1e-7), "-1e-7");
    }

    #[test]
    fn js_string_to_number_forms() {
        assert_eq!(string_to_number(""), 0.0);
        assert_eq!(string_to_number("  12 "), 12.0);
        assert_eq!(string_to_number("0x1f"), 31.0);
        assert!(string_to_number("-0x1f").is_nan());
        assert!(string_to_number("1_000").is_nan());
        assert_eq!(string_to_number("1.e2"), 100.0);
        assert_eq!(string_to_number(".5"), 0.5);
        assert!(string_to_number("e5").is_nan());
        assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
        assert!(string_to_number("\u{85}7").is_nan());
        assert_eq!(string_to_number("\u{feff}7"), 7.0);
    }

    #[test]
    fn reads_mirror_js() {
        let v = parse(&format!("[{},u]", num_tok(0.0))).unwrap();
        assert_eq!(v.prop(&Value::Num(1.0)), Value::Undefined);
        assert_eq!(v.prop(&Value::Str("length".into())), Value::Num(2.0));
        assert!(!Value::Num(f64::NAN).truthy());
        assert!(!Value::Str(String::new()).truthy());
        assert!(Value::Str("0".into()).truthy());
        let items = Value::Arr(vec![Value::Undefined, Value::Null, Value::Num(5.0)]);
        assert_eq!(items.to_js_string(), ",,5");
        assert_eq!(Value::Num(f64::NAN).finite_or(7.0), 7.0);
        assert_eq!(Value::Str("5".into()).finite_or(7.0), 7.0);
        assert_eq!(Value::Num(-0.0).num_or_default(3.0), 3.0);
    }
}
