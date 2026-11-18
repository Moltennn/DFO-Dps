//! Seeded, named, independent random streams. Port of `src/rng.js` (all of it).
//!
//! xoshiro128** seeded per stream by SplitMix32 over an FNV-1a hash of the name; `float()` is
//! `next() / 2^32`. A stream is a function of `(seed, name)` only.
//!
//! JS boundaries:
//! * A stream name is a JS string, i.e. a sequence of UTF-16 code units that may contain lone
//!   surrogates, which a Rust `&str` cannot hold. Names are therefore `&[u16]`; [`Rng::stream_str`]
//!   encodes a `&str`. The 64-unit limit counts UTF-16 code units, as `name.length` does.
//! * The seed is a JS number. [`Rng::new`] takes an `f64` and applies `Number.isSafeInteger`.
//!   `typeof seed !== 'number'` and non-string names cannot be expressed in Rust types and so are
//!   not representable here (the JS `TypeError` for them has no counterpart).
//! * `Rng::draws` returns streams in creation (Map insertion) order. The JS `draws()` returns an
//!   object, whose key order puts integer-like names ("10", "2") first in ascending order; that
//!   quirk is not reproduced (see README).
//!
//! Citations are `src/rng.js:LINE`.

use crate::round::{imul, is_safe_integer};
use std::fmt;

/// `MAX_NAME` (`src/rng.js:21`): the longest legal name in UTF-16 code units.
pub const MAX_NAME: usize = 64;

/// JS `TypeError` / `RangeError` as a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RngError {
    /// A JS `TypeError` (bad seed, bad name, not a snapshot of this stream/generator).
    Type(String),
    /// A JS `RangeError` (bad `int(n)`, all-zero state).
    Range(String),
}

impl fmt::Display for RngError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RngError::Type(m) => write!(f, "TypeError: {m}"),
            RngError::Range(m) => write!(f, "RangeError: {m}"),
        }
    }
}

impl std::error::Error for RngError {}

fn rotl(x: u32, k: u32) -> u32 {
    x.rotate_left(k)
}

/// FNV-1a over the UTF-16 code units (`src/rng.js:27-34`).
pub fn fnv1a(name: &[u16]) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for &c in name {
        h ^= u32::from(c);
        h = imul(h as i32, 0x01000193) as u32;
    }
    h
}

/// SplitMix32 (`src/rng.js:37-43`): advances `s` and returns the next output.
pub fn splitmix32(s: &mut u32) -> u32 {
    *s = s.wrapping_add(0x9e3779b9);
    let mut z = *s;
    z = imul((z ^ (z >> 16)) as i32, 0x85ebca6bu32 as i32) as u32;
    z = imul((z ^ (z >> 13)) as i32, 0xc2b2ae35u32 as i32) as u32;
    z ^ (z >> 16)
}

/// The seed check of `src/rng.js:45-50` (`Number.isSafeInteger`). Returns the seed as `i64`
/// (`-0` becomes 0, which the JS folding also treats as 0).
pub fn check_seed(seed: f64) -> Result<i64, RngError> {
    if !is_safe_integer(seed) {
        return Err(RngError::Type(format!(
            "rng: the seed must be a safe integer (got {seed})"
        )));
    }
    Ok(seed as i64)
}

/// The name check of `src/rng.js:52-57`: non-empty, at most [`MAX_NAME`] UTF-16 code units.
pub fn check_name(name: &[u16]) -> Result<(), RngError> {
    if name.is_empty() || name.len() > MAX_NAME {
        return Err(RngError::Type(format!(
            "rng: a stream name must be a non-empty string of at most {MAX_NAME} characters"
        )));
    }
    Ok(())
}

/// The initial xoshiro128** state of stream `name` under `seed` (`src/rng.js:60-68`).
///
/// The 53-bit seed folds into halves exactly as JS does: `lo = seed % 2^32` (truncated, so a
/// negative seed gives a negative remainder, wrapped by `>>> 0`) and `hi = floor(seed / 2^32)`
/// (`seed / 2^32` is exact for a power-of-two divisor, so this is `div_euclid`).
pub fn initial_state(seed: i64, name: &[u16]) -> [u32; 4] {
    let lo = (seed % 4294967296) as u32;
    let hi = seed.div_euclid(4294967296) as u32;
    let mut s = lo ^ (imul(hi as i32, 0x27d4eb2f) as u32) ^ fnv1a(name);
    let mut state = [
        splitmix32(&mut s),
        splitmix32(&mut s),
        splitmix32(&mut s),
        splitmix32(&mut s),
    ];
    if state == [0, 0, 0, 0] {
        state[0] = 1; // the all-zero state is the generator's one fixed point (:66)
    }
    state
}

/// A plain-data copy of one stream (`src/rng.js:114-116`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamSnapshot {
    pub name: Vec<u16>,
    pub state: [u32; 4],
    pub draws: u64,
}

/// A plain-data copy of a generator (`src/rng.js:163-165`).
#[derive(Debug, Clone, PartialEq)]
pub struct RngSnapshot {
    pub seed: f64,
    pub streams: Vec<StreamSnapshot>,
}

/// One named stream (`src/rng.js:70-129`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stream {
    name: Vec<u16>,
    s: [u32; 4],
    draws: u64,
}

impl Stream {
    fn new(name: &[u16], state: [u32; 4]) -> Self {
        Stream {
            name: name.to_vec(),
            s: state,
            draws: 0,
        }
    }

    /// The stream's name in UTF-16 code units.
    pub fn name(&self) -> &[u16] {
        &self.name
    }

    /// The next 32-bit unsigned integer, one draw (`src/rng.js:79-95`).
    pub fn next_u32(&mut self) -> u32 {
        let s = &mut self.s;
        let result = rotl(s[1].wrapping_mul(5), 7).wrapping_mul(9);
        let t = s[1] << 9;
        s[2] ^= s[0];
        s[3] ^= s[1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = rotl(s[3], 11);
        self.draws += 1;
        result
    }

    /// A float in `[0, 1)`: `next() / 2^32`, one draw (`src/rng.js:98-100`).
    pub fn float(&mut self) -> f64 {
        f64::from(self.next_u32()) / 4294967296.0
    }

    /// An integer in `[0, n)`: `floor(float() * n)`, one draw; `n` an integer in `1..=2^32`
    /// (`src/rng.js:103-106`). The range check happens before any draw.
    pub fn int(&mut self, n: f64) -> Result<u64, RngError> {
        if !crate::round::is_integer(n) || !(1.0..=4294967296.0).contains(&n) {
            return Err(RngError::Range(format!(
                "rng: int(n) needs an integer 1..2^32 (got {n})"
            )));
        }
        Ok((self.float() * n).floor() as u64)
    }

    /// Draws made so far (`src/rng.js:109-111`).
    pub fn draws(&self) -> u64 {
        self.draws
    }

    /// A plain-data copy (`src/rng.js:114-116`).
    pub fn snapshot(&self) -> StreamSnapshot {
        StreamSnapshot {
            name: self.name.clone(),
            state: self.s,
            draws: self.draws,
        }
    }

    /// Put the stream back to a snapshot of the SAME name (`src/rng.js:119-128`). The JS also
    /// checks that each state word is an integer in `0..=0xffffffff` (a `u32` here, so true by
    /// construction) and that `draws` is a safe integer `>= 0` (checked below).
    pub fn restore(&mut self, snap: &StreamSnapshot) -> Result<(), RngError> {
        if snap.name != self.name || snap.draws > 9007199254740991 {
            return Err(RngError::Type(format!(
                "rng: not a snapshot of stream \"{}\"",
                String::from_utf16_lossy(&self.name)
            )));
        }
        if snap.state == [0, 0, 0, 0] {
            return Err(RngError::Range("rng: the all-zero state is invalid".into()));
        }
        self.s = snap.state;
        self.draws = snap.draws;
        Ok(())
    }
}

/// A set of independent named streams under one seed (`createRng`, `src/rng.js:140-179`).
#[derive(Debug, Clone)]
pub struct Rng {
    seed_number: f64,
    seed: i64,
    /// Creation order, as a JS `Map` iterates.
    streams: Vec<Stream>,
}

impl Rng {
    /// `createRng(seed)`: the seed must be a safe integer.
    pub fn new(seed: f64) -> Result<Rng, RngError> {
        let s = check_seed(seed)?;
        Ok(Rng {
            seed_number: seed,
            seed: s,
            streams: Vec::new(),
        })
    }

    /// The seed as given.
    pub fn seed(&self) -> f64 {
        self.seed_number
    }

    /// The named stream, created on first use (`src/rng.js:149-157`).
    pub fn stream(&mut self, name: &[u16]) -> Result<&mut Stream, RngError> {
        check_name(name)?;
        let at = match self.streams.iter().position(|s| s.name == name) {
            Some(i) => i,
            None => {
                self.streams
                    .push(Stream::new(name, initial_state(self.seed, name)));
                self.streams.len() - 1
            }
        };
        Ok(&mut self.streams[at])
    }

    /// [`Rng::stream`] for a Rust string (encoded as UTF-16).
    pub fn stream_str(&mut self, name: &str) -> Result<&mut Stream, RngError> {
        let units: Vec<u16> = name.encode_utf16().collect();
        self.stream(&units)
    }

    /// Draws made so far per existing stream, in creation order (`src/rng.js:159-161`).
    pub fn draws(&self) -> Vec<(Vec<u16>, u64)> {
        self.streams
            .iter()
            .map(|s| (s.name.clone(), s.draws))
            .collect()
    }

    /// A plain-data copy of every stream (`src/rng.js:163-165`).
    pub fn snapshot(&self) -> RngSnapshot {
        RngSnapshot {
            seed: self.seed_number,
            streams: self.streams.iter().map(Stream::snapshot).collect(),
        }
    }

    /// Replace every stream with the snapshot's (`src/rng.js:167-177`). All-or-nothing: on an
    /// error the generator is unchanged. A duplicated name keeps its first position and the
    /// last value, as a JS `Map.set` does.
    pub fn restore(&mut self, snap: &RngSnapshot) -> Result<(), RngError> {
        if snap.seed != self.seed_number {
            return Err(RngError::Type(
                "rng: not a snapshot of this generator (seed mismatch)".into(),
            ));
        }
        let mut next: Vec<Stream> = Vec::new();
        for part in &snap.streams {
            check_name(&part.name)?;
            let mut s = Stream::new(&part.name, initial_state(self.seed, &part.name));
            s.restore(part)?;
            match next.iter().position(|x| x.name == part.name) {
                Some(i) => next[i] = s,
                None => next.push(s),
            }
        }
        self.streams = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn fnv1a_published_vectors() {
        // Public FNV-1a 32-bit test vectors (not produced by this project's JS).
        assert_eq!(fnv1a(&u("")), 0x811c9dc5);
        assert_eq!(fnv1a(&u("a")), 0xe40c292c);
        assert_eq!(fnv1a(&u("foobar")), 0xbf9cf968);
    }

    #[test]
    fn seed_and_name_limits() {
        assert!(Rng::new(9007199254740991.0).is_ok());
        assert!(Rng::new(-9007199254740991.0).is_ok());
        assert!(Rng::new(9007199254740992.0).is_err());
        assert!(Rng::new(1.5).is_err());
        assert!(Rng::new(f64::NAN).is_err());
        let mut r = Rng::new(1.0).unwrap();
        assert!(r.stream(&[]).is_err());
        assert!(r.stream(&[97; 64]).is_ok());
        assert!(r.stream(&[97; 65]).is_err());
        assert!(r.stream_str(&"😀".repeat(32)).is_ok()); // 64 code units
        assert!(r.stream_str(&"😀".repeat(33)).is_err()); // 66 code units
    }

    #[test]
    fn int_range_checked_before_draw() {
        let mut r = Rng::new(7.0).unwrap();
        let s = r.stream_str("q").unwrap();
        assert!(s.int(0.0).is_err());
        assert!(s.int(1.5).is_err());
        assert!(s.int(4294967297.0).is_err());
        assert_eq!(s.draws(), 0);
        assert_eq!(s.int(1.0).unwrap(), 0);
        assert_eq!(s.draws(), 1);
    }

    #[test]
    fn snapshot_restore_round_trip_and_errors() {
        let mut r = Rng::new(-5.0).unwrap();
        r.stream_str("a").unwrap().next_u32();
        let snap = r.snapshot();
        let first = r.stream_str("a").unwrap().next_u32();
        r.stream_str("b").unwrap().next_u32();
        r.restore(&snap).unwrap();
        assert_eq!(r.draws(), vec![(u("a"), 1)]); // "b" discarded
        assert_eq!(r.stream_str("a").unwrap().next_u32(), first);

        let mut other = Rng::new(6.0).unwrap();
        assert!(other.restore(&snap).is_err()); // seed mismatch

        let mut bad = snap.clone();
        bad.streams[0].state = [0; 4];
        assert!(matches!(r.restore(&bad), Err(RngError::Range(_))));
        let mut bad = snap.clone();
        bad.streams[0].name = Vec::new();
        assert!(matches!(r.restore(&bad), Err(RngError::Type(_))));
        let mut bad = snap;
        bad.streams[0].draws = 9007199254740992;
        assert!(matches!(r.restore(&bad), Err(RngError::Type(_))));
        // failed restores left the generator alone
        assert_eq!(r.draws(), vec![(u("a"), 2)]);
    }

    #[test]
    fn negative_seed_folds_like_js() {
        // -1: lo = (-1 % 2^32) >>> 0 = 0xffffffff, hi = floor(-1 / 2^32) = -1 -> 0xffffffff
        let a = initial_state(-1, &u("x"));
        let mut s = 0xffffffffu32 ^ (imul(-1, 0x27d4eb2f) as u32) ^ fnv1a(&u("x"));
        assert_eq!(a[0], splitmix32(&mut s));
    }
}
