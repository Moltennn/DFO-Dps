//! Shared reader for the golden vector files written by `tools/rust-vectors.mjs`.
//!
//! By default the tests read the committed **frozen sample**, `rust/tests/frozen/<module>.txt.gz` (gzip -9 text, the
//! format documented in that generator: one case per line, `kind token token ...`; `#` lines are comments; f64 tokens
//! are 16 hex digits of IEEE bits; ints are decimal; u32 are 8 hex digits; bool is 1/0; opt is `-` or an f64; names are
//! `n:` + 4 hex digits per UTF-16 unit).
//!
//! Set `DFO_VECTORS_DIR=<dir>` to read the full generated set (`rust/tests/vectors/*.txt`) instead: that is the opt-in
//! comparison tier, needed while the JavaScript that answers them still exists. The sample's `MANIFEST` is the one
//! record of every family's case count, and every floor below is taken from it.
//!
//! A missing or corrupt module, a file without the generator header, or a case count that differs from `MANIFEST` is a
//! hard failure, never a silent pass.
#![allow(dead_code)]

use dfo_core::value::{self, Value};
use flate2::read::GzDecoder;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// `rust/tests/frozen`, or the copy named by `DFO_FROZEN_DIR`; the opt-in full set is `DFO_VECTORS_DIR`.
pub fn vector_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        if let Some(dir) = std::env::var_os("DFO_VECTORS_DIR") {
            return PathBuf::from(dir);
        }
        if let Some(dir) = std::env::var_os("DFO_FROZEN_DIR") {
            return PathBuf::from(dir);
        }
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("frozen")
    })
}

/// True when the committed, gzipped sample is in force (the full set, `DFO_VECTORS_DIR`, is the only other tier).
pub fn frozen() -> bool {
    std::env::var_os("DFO_VECTORS_DIR").is_none()
}

/// The vector file the tests read for `module`: `<module>.txt.gz` in the sample, `<module>.txt` in the full set.
pub fn vector_path(module: &str) -> PathBuf {
    let name = if frozen() {
        format!("{module}.txt.gz")
    } else {
        format!("{module}.txt")
    };
    vector_dir().join(name)
}

/// One `#`-prefixed record of `MANIFEST`: every module's case count and gzip/raw digests, every kind's kept/total.
pub struct Manifest {
    /// `module <name> ... <cases>`: the cases a full read of the sample yields.
    pub cases: HashMap<String, usize>,
    /// `kind <module> <kind> <kept>/<total>`: the cases of one kind the sample keeps.
    pub kept: HashMap<(String, String), usize>,
    /// The same record's `total`: the cases of that kind in the full generated set.
    pub total: HashMap<(String, String), usize>,
}

impl Manifest {
    /// The cases of one module in the full generated set: the sum of its kinds' totals.
    pub fn full_cases(&self, module: &str) -> usize {
        self.total
            .iter()
            .filter(|((m, _), _)| m == module)
            .map(|(_, n)| n)
            .sum()
    }
}

/// The committed `MANIFEST`, parsed once per test process. Panics if it is missing or malformed: the sample and its
/// counts are one artifact, so a loader without the counts cannot say what it read.
pub fn manifest() -> &'static Manifest {
    static MANIFEST: OnceLock<Manifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("frozen")
            .join("MANIFEST");
        let text = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "frozen MANIFEST missing or unreadable: {} ({e})",
                path.display()
            )
        });
        parse_manifest(&text)
    })
}

/// [`manifest`] without the file: the format is `module <name> <gzip-sha256> <raw-sha256> <raw-bytes> <cases>` and
/// `kind <name> <kind> <kept>/<total> <hand-picked|sampled>`.
pub fn parse_manifest(text: &str) -> Manifest {
    let mut cases = HashMap::new();
    let mut kept = HashMap::new();
    let mut total = HashMap::new();
    for (i, line) in text.lines().enumerate() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = line.split(' ').collect();
        match f.as_slice() {
            ["module", name, _gzip, _raw, _bytes, n] => {
                let n: usize = n
                    .parse()
                    .unwrap_or_else(|_| panic!("MANIFEST:{}: bad case count `{n}`", i + 1));
                cases.insert((*name).to_owned(), n);
            }
            ["kind", name, kind, counts, _how] => {
                let (k, t) = counts
                    .split_once('/')
                    .unwrap_or_else(|| panic!("MANIFEST:{}: bad count `{counts}`", i + 1));
                let k: usize = k
                    .parse()
                    .unwrap_or_else(|_| panic!("MANIFEST:{}: bad count `{counts}`", i + 1));
                let t: usize = t
                    .parse()
                    .unwrap_or_else(|_| panic!("MANIFEST:{}: bad count `{counts}`", i + 1));
                kept.insert(((*name).to_owned(), (*kind).to_owned()), k);
                total.insert(((*name).to_owned(), (*kind).to_owned()), t);
            }
            // `branch <name> <kind> <position> <values>`: every branch value the full set has is in the sample.
            ["branch", _, _, _, _] => {}
            _ => panic!("MANIFEST:{}: unrecognised line `{line}`", i + 1),
        }
    }
    Manifest { cases, kept, total }
}

/// The cases of one kind the loader in force must yield, from `MANIFEST`: the floor a test asserts instead of a copied
/// number. In the sample that is its `kept` count; against the opt-in full set it is the `total`, which is the same
/// strictness the full file has. A kind the record does not name is a hard failure (a renamed or dropped kind must not
/// silently lose its floor).
pub fn floor(module: &str, kind: &str) -> usize {
    let map = if frozen() {
        &manifest().kept
    } else {
        &manifest().total
    };
    *map.get(&(module.to_owned(), kind.to_owned()))
        .unwrap_or_else(|| panic!("MANIFEST has no kind `{kind}` in module `{module}`"))
}

/// [`floor`] summed over a family of kinds (the tests group a few small kinds into one family).
pub fn floor_sum(module: &str, kinds: &[&str]) -> usize {
    kinds.iter().map(|k| floor(module, k)).sum()
}

/// Load every case of a vector file. Panics (failing the test) if the file is missing, has no generator header, or has
/// no cases.
pub fn load(module: &str) -> Vec<Case> {
    let cases: Vec<_> = stream(module).collect();
    assert!(!cases.is_empty(), "{module}: no cases");
    cases
}

/// Streaming equivalent for large files. For the sample the read must yield exactly the module's `MANIFEST` case count;
/// that check fires at the end of the iteration, so every caller must consume the whole stream.
pub fn stream(module: &str) -> CaseStream {
    let expect = frozen().then(|| {
        *manifest()
            .cases
            .get(module)
            .unwrap_or_else(|| panic!("MANIFEST has no module `{module}`"))
    });
    CaseStream::open(&vector_path(module), module, expect)
}

/// One vector file, read line by line. `expect` is the case count the read must end on (`None` for the full set, whose
/// size is not recorded).
pub struct CaseStream {
    module: String,
    path: PathBuf,
    lines: std::io::Lines<BufReader<Box<dyn Read>>>,
    line: usize,
    cases: usize,
    expect: Option<usize>,
    done: bool,
}

impl CaseStream {
    /// Open `path`; a missing file, a foreign header or an unreadable gzip panics here or on the first `next()`.
    pub fn open(path: &Path, module: &str, expect: Option<usize>) -> CaseStream {
        let file = fs::File::open(path).unwrap_or_else(|e| {
            panic!(
                "golden vector file missing or unreadable: {} ({e}). The committed sample is rust/tests/frozen; a \
                 sample is never skipped, so these tests need it.",
                path.display()
            )
        });
        let reader: Box<dyn Read> = if path.extension().is_some_and(|e| e == "gz") {
            Box::new(GzDecoder::new(file))
        } else {
            Box::new(file)
        };
        // The header is checked here, through the same decoder and the same buffer the cases are read from, so a corrupt
        // stream cannot look like an empty file and no buffered bytes are lost.
        let mut lines = BufReader::new(reader).lines();
        let Some(Ok(header)) = lines.next() else {
            panic!("{}: unreadable first line", path.display())
        };
        assert!(
            header.starts_with("# dfo-core golden vectors | generator: tools/rust-vectors.mjs"),
            "{}: missing the generator header line",
            path.display()
        );
        CaseStream {
            module: module.to_owned(),
            path: path.to_owned(),
            lines,
            line: 1,
            cases: 0,
            expect,
            done: false,
        }
    }
}

impl Iterator for CaseStream {
    type Item = Case;

    fn next(&mut self) -> Option<Case> {
        if self.done {
            return None;
        }
        for (i, line) in self.lines.by_ref().enumerate() {
            let at = self.line + 1 + i;
            let line = line.unwrap_or_else(|e| panic!("{}:{at}: {e}", self.path.display()));
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            self.line = at;
            self.cases += 1;
            let mut toks = line.split(' ').map(str::to_owned);
            let kind = toks.next().unwrap();
            return Some(Case {
                file: self
                    .path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                line: at,
                kind,
                toks: toks.collect(),
                pos: 0,
            });
        }
        self.done = true;
        if let Some(expect) = self.expect {
            assert_eq!(
                self.cases, expect,
                "{}: {} cases read, MANIFEST records {expect}",
                self.module, self.cases
            );
        }
        None
    }
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

/// The definitions of a vector file (R4a): `def <index> <value token>` lines, which a case refers to as `@<index>`.
pub type Defs = HashMap<usize, Value>;

/// [`load`], with the `def` lines taken out: returns the definitions and the other cases, in file order.
pub fn load_with_defs(module: &str) -> (Defs, Vec<Case>) {
    let mut defs = Defs::new();
    let mut cases = Vec::new();
    for mut c in load(module) {
        if c.kind == "def" {
            let idx = c.u64() as usize;
            let tok = c.word();
            let v = value::parse(&tok).unwrap_or_else(|e| c.fail(&format!("bad definition: {e}")));
            defs.insert(idx, v);
        } else {
            cases.push(c);
        }
    }
    (defs, cases)
}

impl Case {
    /// The next token as a value: `@<index>` is a definition, anything else is an inline value token.
    pub fn value(&mut self, defs: &Defs) -> Value {
        let t = self.word();
        if let Some(i) = t.strip_prefix('@') {
            let idx: usize = i
                .parse()
                .unwrap_or_else(|_| self.fail(&format!("bad definition reference `{t}`")));
            return defs
                .get(&idx)
                .cloned()
                .unwrap_or_else(|| self.fail(&format!("undefined definition {idx}")));
        }
        value::parse(&t).unwrap_or_else(|e| self.fail(&format!("bad value token `{t}`: {e}")))
    }

    /// `=>` then the expected output token, compared with the canonical write of `got` (bit for bit; NaN canonical).
    pub fn check_out(&mut self, what: &str, got: &Value) {
        self.expect("=>");
        let exp = self.word();
        let text = value::write(got);
        if exp != text {
            self.fail(&format!("{what}: expected {exp}, got {text}"));
        }
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
#[allow(dead_code)]
pub mod oracle;
pub mod planning;
