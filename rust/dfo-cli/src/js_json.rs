//! The `JSON.parse(fs.readFileSync(path, 'utf8'))` half shared by the save and capture readers.
//!
//! V8 decodes the bytes as UTF-8 with replacement (an invalid byte becomes U+FFFD), and `JSON.parse` accepts a
//! `\uXXXX` escape for an unpaired surrogate, keeping that lone UTF-16 unit in the string. A [`Value::Str`] is a Rust
//! `String` and cannot hold a lone surrogate, so this reader performs the same decode and substitutes U+FFFD for an
//! unpaired surrogate escape before parsing. A valid pair and an escaped backslash (`"\\ud800"`, which is the literal
//! text) are left untouched.
//!
//! RESIDUAL DIFFERENCE: a save, `SaveInfo.txt`, `config.json` or capture whose string carries an unpaired surrogate
//! escape loads on both sides, but the JS keeps the lone unit where this port prints U+FFFD. Every other byte of the
//! document (including a valid pair) reads identically, so no number moves. Documented in `rust/README.md`.

use dfo_core::value::Value;
use serde_json::Value as JsonValue;

/// Decode UTF-8 the way Node's `readFileSync(path, 'utf8')` does, repair unpaired surrogate escapes, then parse.
pub fn parse_bytes(bytes: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(bytes);
    let doc: JsonValue =
        serde_json::from_str(&repair_lone_surrogates(&text)).map_err(|e| e.to_string())?;
    Ok(json_to_value(&doc))
}

/// Replace every unpaired surrogate `\uXXXX` escape with `\u{FFFD}`. A valid high/low pair stays as written, safe
/// escapes (`\\`, `\"`, ...) are copied verbatim, and anything else is left for `serde_json` to reject.
pub fn repair_lone_surrogates(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(backslash) = rest.find('\\') {
        out.push_str(&rest[..backslash]);
        rest = &rest[backslash..];
        let Some(unit) = escape_unit(rest) else {
            // Not a `\uXXXX` escape: copy the backslash (and its escaped char) and move on.
            let taken = rest.chars().take(2).map(char::len_utf8).sum();
            out.push_str(&rest[..taken]);
            rest = &rest[taken..];
            continue;
        };
        let width = 6; // `\uXXXX`
        if (0xD800..=0xDBFF).contains(&unit) && is_low_surrogate(&rest[width..]) {
            out.push_str(&rest[..width * 2]);
            rest = &rest[width * 2..];
        } else if (0xD800..=0xDFFF).contains(&unit) {
            out.push('\u{FFFD}');
            rest = &rest[width..];
        } else {
            out.push_str(&rest[..width]);
            rest = &rest[width..];
        }
    }
    out.push_str(rest);
    out
}

/// The code unit of a `\uXXXX` escape at the start of `s`, when the four digits are hex.
fn escape_unit(s: &str) -> Option<u32> {
    let body = s.strip_prefix("\\u")?;
    let digits = body.get(..4)?;
    if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(digits, 16).ok()
}

fn is_low_surrogate(s: &str) -> bool {
    matches!(escape_unit(s), Some(unit) if (0xDC00..=0xDFFF).contains(&unit))
}

/// `JsonValue` to the core's [`Value`]; `Value::set` puts an integer-like key in JS order.
pub fn json_to_value(v: &JsonValue) -> Value {
    match v {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(b) => Value::Bool(*b),
        JsonValue::Number(n) => Value::Num(n.as_f64().unwrap_or(f64::NAN)),
        JsonValue::String(s) => Value::Str(s.clone()),
        JsonValue::Array(items) => Value::Arr(items.iter().map(json_to_value).collect()),
        JsonValue::Object(map) => {
            let mut out = Value::Obj(Vec::new());
            for (k, v) in map {
                out.set(k, json_to_value(v));
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// JSON.parse keeps a lone surrogate unit, which a `String` cannot; both sides must still parse the document.
    #[test]
    fn an_unpaired_surrogate_escape_parses() {
        let v = parse_bytes(br#"{"name":"Bob\ud83d","n":1}"#).unwrap();
        assert_eq!(v.get("name"), &Value::Str("Bob\u{FFFD}".into()));
        assert_eq!(v.get("n"), &Value::Num(1.0));
    }

    /// A pair is one astral character on both sides, and `\\u` is literal text, not an escape.
    #[test]
    fn a_valid_pair_and_an_escaped_backslash_are_untouched() {
        assert_eq!(
            repair_lone_surrogates(r#""\ud83d\ude00""#),
            r#""\ud83d\ude00""#
        );
        assert_eq!(repair_lone_surrogates(r#""\\ud800""#), r#""\\ud800""#);
        assert_eq!(
            repair_lone_surrogates(r#""a\\\ud800b""#),
            "\"a\\\\\u{FFFD}b\""
        );
        let v = parse_bytes(br#"{"name":"\ud83d\ude00"}"#).unwrap();
        assert_eq!(v.get("name"), &Value::Str("\u{1f600}".into()));
        let v = parse_bytes(br#"{"name":"\\ud800"}"#).unwrap();
        assert_eq!(v.get("name"), &Value::Str("\\ud800".into()));
    }

    /// Node replaces an invalid UTF-8 byte with U+FFFD rather than refusing the file.
    #[test]
    fn an_invalid_utf8_byte_decodes_lossily() {
        let mut bytes = br#"{"name":"Bob"#.to_vec();
        bytes.push(0xff);
        bytes.extend_from_slice(br#"","n":2}"#);
        let v = parse_bytes(&bytes).unwrap();
        assert_eq!(v.get("name"), &Value::Str("Bob\u{FFFD}".into()));
        assert_eq!(v.get("n"), &Value::Num(2.0));
    }
}
