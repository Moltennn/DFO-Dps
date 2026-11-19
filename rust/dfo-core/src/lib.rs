//! `dfo-core`: milestone R1 of the Rust port of the dfo-dps DPS core.
//!
//! Only pure rule modules live here (plain data in, numbers out; no I/O, no clock, no ambient
//! randomness). Every function cites the JS it ports; the JS in `src/` and the vendored upstream
//! (`vendor/upstream/a3eb1605`) remain the source of truth, and `tests/` proves each module
//! bit-exact against golden vectors written by `tools/rust-vectors.mjs`.

pub mod allowance;
pub mod blow_outcomes;
pub mod boot;
pub mod boss_traits;
pub mod damage;
pub mod dual_wield;
pub mod durability;
pub mod enchants;
pub mod gear;
pub mod gear_lines;
pub mod generated;
pub mod loot;
pub mod mint;
pub mod model_blow;
pub mod relay_claim;
pub mod rng;
pub mod rolls;
pub mod round;
pub mod save;
pub mod sockets;
pub mod spells;
pub mod swing;
pub mod target;
pub mod value;
pub mod vectors_canon;
pub mod vendored;
