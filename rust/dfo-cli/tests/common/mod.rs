//! Shared CLI-test plumbing. A module under `tests/`, not a test target of its own, so `cargo test` compiles it into
//! each CLI test binary that says `mod common;`.
//!
//! `oracle.rs` holds the JS spawns and the dry run of the JS-oracle cache: with `DFO_ORACLE_STATS` set it computes the
//! design's key for every JS call and appends `key argv-summary cacheable|reason` there. It reads and writes no entry and
//! changes no test output.
#![allow(dead_code)]

mod oracle;

pub use oracle::*;
