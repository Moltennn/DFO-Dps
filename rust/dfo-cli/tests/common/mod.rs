//! Shared CLI-test plumbing. A module under `tests/`, not a test target of its own, so `cargo test` compiles it into
//! each CLI test binary that says `mod common;`.
//!
//! `oracle.rs` holds the JS spawns and the JS-oracle output cache: `DFO_ORACLE=use` replays a stored JS answer (with a
//! spot check against real JS), `fresh` writes entries without reading, and `off` (the default) is the plain spawn. The
//! Rust binary always runs live; only the JS side is cached.
#![allow(dead_code)]

mod oracle;

pub use oracle::*;
