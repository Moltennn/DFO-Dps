//! `dfo-core`: milestone R1 of the Rust port of the dfo-dps DPS core.
//!
//! Only pure rule modules live here (plain data in, numbers out; no I/O, no clock, no ambient
//! randomness). Every function cites the JS it ports; the JS in `src/` and the vendored upstream
//! (`vendor/upstream/a3eb1605`) remain the source of truth, and `tests/` proves each module
//! bit-exact against golden vectors written by `tools/rust-vectors.mjs`.

pub mod allowance;
pub mod analyze;
pub mod blow_outcomes;
pub mod boot;
pub mod boss_traits;
pub mod cws;
pub mod damage;
pub mod dual_wield;
pub mod durability;
pub mod enchant_plan;
pub mod enchants;
pub mod encounters;
pub mod fault;
pub mod fight;
pub mod firmament;
pub mod firmament_law;
pub mod flow_state;
pub mod forge;
pub mod forge_gear;
pub mod gear;
pub mod gear_lines;
pub mod gear_profile;
pub mod generated;
pub mod imprints;
pub mod loadout_shortlist;
pub mod loot;
pub mod maxprofile;
pub mod mint;
pub mod model_blow;
pub mod objectives;
pub mod probe;
pub mod purse;
pub mod real_build;
pub mod relay_claim;
pub mod relay_fight;
pub mod rng;
pub mod rolls;
pub mod round;
pub mod save;
pub mod sidebar;
pub mod simulate_fight;
pub mod sockets;
pub mod spells;
pub mod swing;
pub mod target;
pub mod theory;
pub mod value;
pub mod vectors_canon;
pub mod vendored;
