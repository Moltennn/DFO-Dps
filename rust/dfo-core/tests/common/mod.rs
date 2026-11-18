//! Shared reader for the golden vector files written by `tools/rust-vectors.mjs`.
//!
//! Format (documented in that generator): one case per line, `kind token token ...`; `#` lines are
//! comments; f64 tokens are 16 hex digits of IEEE bits; ints are decimal; u32 are 8 hex digits;
//! bool is 1/0; opt is `-` or an f64; names are `n:` + 4 hex digits per UTF-16 unit.
//!
//! A missing or empty vector file is a hard failure, never a silent pass.
#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;

/// `rust/tests/vectors/<module>.txt`.
pub fn vector_path(module: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("vectors")
        .join(format!("{module}.txt"))
}

/// Load every case of a vector file. Panics (failing the test) if the file is missing, has no
/// generator header, or has no cases.
pub fn load(module: &str) -> Vec<Case> {
    let path = vector_path(module);
    let text = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "golden vector file missing or unreadable: {} ({e}). Run `node tools/rust-vectors.mjs` \
             from the repository root to generate it; these tests do not pass without it.",
            path.display()
        )
    });
    assert!(
        text.starts_with("# dfo-core golden vectors | generator: tools/rust-vectors.mjs"),
        "{}: missing the generator header line",
        path.display()
    );
    let mut cases = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut toks = line.split(' ').map(str::to_owned);
        let kind = toks.next().unwrap();
        cases.push(Case {
            file: format!("{module}.txt"),
            line: i + 1,
            kind,
            toks: toks.collect(),
            pos: 0,
        });
    }
    assert!(!cases.is_empty(), "{}: no cases", path.display());
    cases
}

/// One line, read token by token.
pub struct Case {
    pub file: String,
    pub line: usize,
    pub kind: String,
    toks: Vec<String>,
    pos: usize,
}

impl Case {
    pub fn fail(&self, msg: &str) -> ! {
        panic!("{}:{} [{}]: {msg}", self.file, self.line, self.kind)
    }

    pub fn word(&mut self) -> String {
        let Some(t) = self.toks.get(self.pos) else {
            self.fail("ran out of tokens")
        };
        self.pos += 1;
        t.clone()
    }

    pub fn expect(&mut self, w: &str) {
        let t = self.word();
        if t != w {
            self.fail(&format!("expected token `{w}`, found `{t}`"));
        }
    }

    pub fn f64(&mut self) -> f64 {
        let t = self.word();
        parse_f64(&t).unwrap_or_else(|| self.fail(&format!("bad f64 token `{t}`")))
    }

    pub fn opt(&mut self) -> Option<f64> {
        let t = self.word();
        if t == "-" {
            None
        } else {
            Some(parse_f64(&t).unwrap_or_else(|| self.fail(&format!("bad opt token `{t}`"))))
        }
    }

    pub fn int(&mut self) -> i64 {
        let t = self.word();
        t.parse()
            .unwrap_or_else(|_| self.fail(&format!("bad int token `{t}`")))
    }

    pub fn u64(&mut self) -> u64 {
        let t = self.word();
        t.parse()
            .unwrap_or_else(|_| self.fail(&format!("bad count token `{t}`")))
    }

    pub fn u32(&mut self) -> u32 {
        let t = self.word();
        if t.len() != 8 {
            self.fail(&format!("bad u32 token `{t}`"));
        }
        u32::from_str_radix(&t, 16).unwrap_or_else(|_| self.fail(&format!("bad u32 token `{t}`")))
    }

    pub fn bool(&mut self) -> bool {
        match self.word().as_str() {
            "1" => true,
            "0" => false,
            t => self.fail(&format!("bad bool token `{t}`")),
        }
    }

    /// A `n:`-prefixed name as UTF-16 code units.
    pub fn name(&mut self) -> Vec<u16> {
        let t = self.word();
        let Some(h) = t.strip_prefix("n:") else {
            self.fail(&format!("bad name token `{t}`"))
        };
        self.units(h)
    }

    /// `-` or a name.
    pub fn opt_name(&mut self) -> Option<String> {
        let t = self.word();
        if t == "-" {
            return None;
        }
        let Some(h) = t.strip_prefix("n:") else {
            self.fail(&format!("bad name token `{t}`"))
        };
        let u = self.units(h);
        Some(String::from_utf16(&u).unwrap_or_else(|_| self.fail("name is not valid Unicode")))
    }

    /// Bare hex of UTF-16 units (no prefix), as used inside trace ops.
    pub fn units(&self, h: &str) -> Vec<u16> {
        if !h.len().is_multiple_of(4) {
            self.fail(&format!("bad name hex `{h}`"));
        }
        (0..h.len() / 4)
            .map(|i| {
                u16::from_str_radix(&h[i * 4..i * 4 + 4], 16)
                    .unwrap_or_else(|_| self.fail(&format!("bad name hex `{h}`")))
            })
            .collect()
    }

    pub fn peek(&self) -> Option<&str> {
        self.toks.get(self.pos).map(String::as_str)
    }

    pub fn remaining(&self) -> usize {
        self.toks.len() - self.pos
    }

    pub fn done(&self) {
        if self.pos != self.toks.len() {
            self.fail(&format!("{} unread tokens", self.toks.len() - self.pos));
        }
    }
}

pub fn parse_f64(t: &str) -> Option<f64> {
    if t.len() != 16 {
        return None;
    }
    u64::from_str_radix(t, 16).ok().map(f64::from_bits)
}

/// Equal as JS numbers' bits, except NaN: any NaN equals any NaN (the payload of a JS NaN is not
/// meaningful and the generator writes the canonical one).
pub fn same(exp: f64, got: f64) -> bool {
    if exp.is_nan() {
        got.is_nan()
    } else {
        exp.to_bits() == got.to_bits()
    }
}

impl Case {
    pub fn check_f64(&self, what: &str, exp: f64, got: f64) {
        if !same(exp, got) {
            self.fail(&format!(
                "{what}: expected {exp:?} (0x{:016x}), got {got:?} (0x{:016x})",
                exp.to_bits(),
                got.to_bits()
            ));
        }
    }

    pub fn check_opt(&self, what: &str, exp: Option<f64>, got: Option<f64>) {
        match (exp, got) {
            (None, None) => {}
            (Some(e), Some(g)) => self.check_f64(what, e, g),
            _ => self.fail(&format!("{what}: expected {exp:?}, got {got:?}")),
        }
    }

    pub fn check_eq<T: PartialEq + std::fmt::Debug>(&self, what: &str, exp: T, got: T) {
        if exp != got {
            self.fail(&format!("{what}: expected {exp:?}, got {got:?}"));
        }
    }
}
