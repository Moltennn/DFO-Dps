//! The token form of the golden vectors' expected values (milestone R3b). Not a mechanic: it writes the same tokens
//! `canonOf` writes in `tools/rust-data.mjs`, so a generated row (`generated::canon_rows`) and a target can be compared
//! as strings with the JS.
//!
//! f64 is 16 lowercase hex digits of its IEEE bits, NaN always `7ff8000000000000` (as `F` in `tools/rust-vectors.mjs`);
//! a bool is `1`/`0`; a string is `n:` and four hex digits per UTF-16 unit; a list is its length, then its numbers.
//! A row's tokens are joined with `;`, a target's with `,` (the vector files then hold one token per value).

/// An f64 token.
pub fn f(x: f64) -> String {
    if x.is_nan() {
        "7ff8000000000000".to_owned()
    } else {
        format!("{:016x}", x.to_bits())
    }
}

/// A bool token.
pub fn b(x: bool) -> String {
    (if x { "1" } else { "0" }).to_owned()
}

/// A string token: `n:` then four hex digits per UTF-16 unit (a lone surrogate is written as itself).
pub fn s(x: &str) -> String {
    let mut out = String::from("n:");
    for u in x.encode_utf16() {
        out.push_str(&format!("{u:04x}"));
    }
    out
}

/// A list of numbers: its length, then each number.
pub fn list(xs: &[f64], out: &mut Vec<String>) {
    out.push(xs.len().to_string());
    for x in xs {
        out.push(f(*x));
    }
}

/// A list of tokens joined with `sep` (one token per value, see the module doc).
pub fn join(tokens: &[String], sep: char) -> String {
    let mut out = String::new();
    for (i, t) in tokens.iter().enumerate() {
        if i > 0 {
            out.push(sep);
        }
        out.push_str(t);
    }
    out
}

/// An optional value's token: `-` when absent.
pub fn opt<T>(x: Option<T>, g: impl Fn(T) -> String) -> String {
    match x {
        Some(v) => g(v),
        None => "-".to_owned(),
    }
}
