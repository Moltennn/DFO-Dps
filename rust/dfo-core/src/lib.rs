//! `dfo-core`: milestone R1 of the Rust port of the dfo-dps DPS core.
//!
//! Only pure rule modules live here (plain data in, numbers out; no I/O, no clock, no ambient
//! randomness). Every function cites the JS it ports; the JS in `src/` and the vendored upstream
//! (`vendor/upstream/a3eb1605`) remain the source of truth, and `tests/` proves each module
//! bit-exact against golden vectors written by `tools/rust-vectors.mjs`.

pub mod allowance;
pub mod damage;
pub mod generated;
pub mod relay_claim;
pub mod rng;
pub mod round;
pub mod swing;
pub mod target;
pub mod vendored;
