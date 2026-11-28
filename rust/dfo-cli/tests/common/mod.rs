//! Shared CLI-test plumbing. A module under `tests/`, not a test target of its own, so `cargo test` compiles it into
//! each CLI test binary that says `mod common;`.
//!
//! `oracle.rs` holds the JS calls and the JS-oracle output cache. With `DFO_ORACLE` unset the committed snapshots answer
//! every call (no Node); `live` runs the plain spawn, `use`/`fresh` add the output cache, and the Rust binary always
//! runs live - only the JS side is ever stored.
//!
//! `snapshot.rs` holds the committed answers (`tests/snapshots/`), replayed without Node.
#![allow(dead_code)]

mod oracle;
mod snapshot;

pub use oracle::*;
