//! The frozen sample and the loader that reads it: the committed `rust/tests/frozen/*.txt.gz` must match `MANIFEST`
//! (every module's case count and every kind's kept count), and the loader must fail **loudly** — never skip — on a
//! missing module, a corrupt gzip or a count that differs from the record. The sample is the default tier, so a quiet
//! fallback here would silently turn every Rust vector test into a no-op.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;

/// SHA-256 of `data` (FIPS 180-4). The frozen-sample digests are pinned in MANIFEST, so this test must be able to check
/// them without a Node script and without a new crate dependency.
fn sha256(data: &[u8]) -> [u8; 32] {
    const H0: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state = H0;
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&(data.len() as u64).wrapping_mul(8).to_be_bytes());
    for chunk in message.chunks(64) {
        let mut words = [0u32; 64];
        for (i, word) in words.iter_mut().take(16).enumerate() {
            let at = 4 * i;
            *word = u32::from_be_bytes([chunk[at], chunk[at + 1], chunk[at + 2], chunk[at + 3]]);
        }
        for i in 16..64 {
            let s0 = words[i - 15].rotate_right(7)
                ^ words[i - 15].rotate_right(18)
                ^ (words[i - 15] >> 3);
            let s1 = words[i - 2].rotate_right(17)
                ^ words[i - 2].rotate_right(19)
                ^ (words[i - 2] >> 10);
            words[i] = words[i - 16]
                .wrapping_add(s0)
                .wrapping_add(words[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(words[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (s, v) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *s = s.wrapping_add(v);
        }
    }
    let mut out = [0u8; 32];
    for (i, word) in state.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn frozen_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("frozen")
}

/// A static per-module, per-kind floor for what the FULL generator produced. `MANIFEST` records the totals, but a
/// truncated generator would lower them and the manifest would agree with itself; this table is the independent witness,
/// so a shrunken generator fails even when it regenerates its own manifest. Each entry is the **exact** full count at the
/// revision this sample was frozen from, and the table covers **every kind of every module the sample ships** (the
/// `kind` lines of MANIFEST). A new kind, or a kind that lost cases, fails until the table is updated deliberately.
const FULL_FLOOR: &[(&str, &str, usize)] = &[
    ("allowance", "law", 96),
    ("allowance", "ref_of", 96),
    ("allowance", "run", 127),
    ("allowance", "simulate", 205),
    ("allowance", "simulate_shield_end", 8),
    ("allowance", "spec", 240),
    ("allowance", "steady", 167),
    ("allowance", "streams", 158),
    ("analysis", "body_level", 1),
    ("analysis", "book", 1),
    ("analysis", "boss", 2048),
    ("analysis", "boss_defaults", 4),
    ("analysis", "gate", 2048),
    ("analysis", "probe", 562),
    ("analysis", "ranks", 28),
    ("analysis", "ref", 2048),
    ("analysis", "refusal", 4),
    ("analysis", "relay", 2048),
    ("blow_outcomes", "bad_hand", 5),
    ("blow_outcomes", "bad_kind", 1),
    ("blow_outcomes", "build", 2320),
    ("blow_outcomes", "carry", 2110),
    ("blow_outcomes", "fight", 2320),
    ("blow_outcomes", "full", 2320),
    ("blow_outcomes", "merge_raw", 2048),
    ("blow_outcomes", "sample_carry", 2110),
    ("blow_outcomes", "sample_fight", 2320),
    ("blow_outcomes", "sample_raw", 2048),
    ("blow_outcomes", "tolerance", 1),
    ("blow_outcomes", "trace", 2110),
    ("damage", "apply_pct", 1927),
    ("damage", "carried_firmament", 1927),
    ("damage", "carried_pct", 1927),
    ("damage", "condition_multiplier", 1140),
    ("damage", "damage_modifier", 486),
    ("damage", "pcaao_damage_modifier", 486),
    ("dual_wield", "hands", 2058),
    ("durability", "break", 2049),
    ("durability", "wear", 2069),
    ("enchant_plan", "apply", 15),
    ("enchant_plan", "best", 12),
    ("enchant_plan", "book", 1),
    ("enchant_plan", "consts", 1),
    ("enchant_plan", "cost", 16),
    ("enchant_plan", "count", 28),
    ("enchant_plan", "gear", 239),
    ("enchant_plan", "grouped", 33),
    ("enchant_plan", "hitpoints", 9),
    ("enchant_plan", "line", 1772),
    ("enchant_plan", "matrix", 5),
    ("enchant_plan", "maxprocs", 117),
    ("enchant_plan", "plan", 149),
    ("enchant_plan", "rate", 35),
    ("enchant_plan", "select", 538),
    ("enchant_plan", "skillpts", 16),
    ("enchant_plan", "sortdps", 10),
    ("enchant_plan", "sortrate", 10),
    ("enchant_plan", "strike", 1),
    ("fight", "answer", 2296),
    ("fight", "bills", 2048),
    ("fight", "book", 1),
    ("fight", "cast", 87460),
    ("fight", "def", 120),
    ("fight", "equip", 2049),
    ("fight", "fight", 2099),
    ("fight", "fight_with", 14),
    ("fight", "magnitude", 2108),
    ("fight", "power", 2052),
    ("fight", "relay", 2169),
    ("fight", "relay_with", 12),
    ("fight", "rows", 2048),
    ("fight", "save", 2048),
    ("fight", "thresholds", 2048),
    ("firmament", "adj", 1),
    ("firmament", "apply", 42),
    ("firmament", "blow", 211),
    ("firmament", "blowtree", 41),
    ("firmament", "buildbyid", 35),
    ("firmament", "builds", 1),
    ("firmament", "castcost", 164),
    ("firmament", "castcosttree", 20),
    ("firmament", "constants", 1),
    ("firmament", "effective", 55),
    ("firmament", "fromtree", 87),
    ("firmament", "isprice", 678),
    ("firmament", "isstart", 133),
    ("firmament", "key", 15),
    ("firmament", "nodehasoff", 3109),
    ("firmament", "nodes", 1),
    ("firmament", "offstat", 1419),
    ("firmament", "plan", 582),
    ("firmament", "signs", 1),
    ("firmament", "skillnames", 5),
    ("firmament", "smallstats", 399),
    ("firmament", "statKeys", 1),
    ("firmament", "statdef", 122),
    ("firmament", "statdefs", 1),
    ("firmament", "statsparts", 20),
    ("firmament", "summary", 987),
    ("firmament", "treeprices", 14),
    ("firmament", "treestats", 14),
    ("firmament", "words", 4622),
    ("forge", "alloc", 6786),
    ("forge", "allocate", 13668),
    ("forge", "apply", 22),
    ("forge", "budget", 32),
    ("forge", "clean", 4),
    ("forge", "cost", 16),
    ("forge", "craft", 19),
    ("forge", "decode", 13),
    ("forge", "def", 61),
    ("forge", "diff", 12),
    ("forge", "faultvalue", 8),
    ("forge", "path", 6786),
    ("forge", "refund", 6830),
    ("forge", "respec", 13),
    ("forge", "silver", 28),
    ("forge", "stars", 14),
    ("forge", "takes", 6786),
    ("forge", "totals", 13),
    ("forge", "treefault", 24),
    ("forge_gear", "def", 206),
    ("forge_gear", "gearbuild", 90),
    ("forge_gear", "gearequip", 35),
    ("forge_gear", "gearwear", 51),
    ("gear", "bl", 3030),
    ("gear", "def", 2540),
    ("gear", "fl", 3030),
    ("gear", "laid", 3030),
    ("gear", "ril", 3030),
    ("gear", "sf", 2000),
    ("gear", "vil", 3030),
    ("gear", "wdp", 3030),
    ("gear_profile", "all", 1),
    ("gear_profile", "budget", 4025),
    ("gear_profile", "constants", 1),
    ("gear_profile", "exalt", 40),
    ("gear_profile", "slot", 3080),
    ("gear_profile", "totals", 116),
    ("gear_profile", "validate", 3752),
    ("imprints", "book", 1),
    ("imprints", "fit", 23),
    ("imprints", "lookup", 7),
    ("imprints", "power", 2048),
    ("imprints", "rank", 96),
    ("imprints", "rank_all", 12),
    ("loot", "cp", 2000),
    ("loot", "def", 1510),
    ("loot", "fg", 2000),
    ("loot", "gl", 2400),
    ("loot", "pio", 3030),
    ("loot", "po", 2051),
    ("loot", "rl", 3030),
    ("loot", "sg", 3030),
    ("loot", "sm", 3030),
    ("loot", "so", 3030),
    ("loot", "va", 3310),
    ("maketarget", "bclassic", 4380),
    ("maketarget", "benemy", 1768),
    ("maketarget", "bgear", 9021),
    ("maketarget", "borcish", 7876),
    ("maketarget", "bpoison", 7210),
    ("maketarget", "brri", 8800),
    ("maketarget", "cidx", 200),
    ("maketarget", "classic", 2400),
    ("maketarget", "enemy", 5952),
    ("maketarget", "erow", 200),
    ("maketarget", "gear", 3968),
    ("maketarget", "iscl", 200),
    ("maketarget", "make", 2400),
    ("maketarget", "mint", 2488),
    ("maketarget", "mrm", 1203),
    ("maketarget", "rri", 2400),
    ("maketarget", "stand", 496),
    ("maketarget", "tgo", 400),
    ("maxprofile", "book", 1),
    ("maxprofile", "build", 3129),
    ("maxprofile", "frontier", 115),
    ("maxprofile", "legal", 346),
    ("maxprofile", "max", 92),
    ("maxprofile", "plan", 1),
    ("maxprofile", "refusal", 2),
    ("maxprofile", "run", 3129),
    ("model_blow", "cadence", 2093),
    ("model_blow", "damage", 2398),
    ("model_blow", "def", 11711),
    ("model_blow", "hit", 3395),
    ("model_blow", "live", 2086),
    ("model_blow", "loot", 2306),
    ("model_blow", "misc", 3084),
    ("model_blow", "outcomes", 2076),
    ("model_blow", "resist", 2352),
    ("model_blow", "scalar", 5276),
    ("model_blow", "weapon", 2048),
    ("real_build", "apply", 12),
    ("real_build", "book", 1),
    ("real_build", "loadouts", 4),
    ("real_build", "sampled", 124),
    ("real_build", "shortlist", 11),
    ("real_build", "shortlist-err", 17),
    ("real_build", "stage", 132),
    ("relay_claim", "relay", 242),
    ("relay_claim", "relay_ctor", 16),
    ("relay_fight", "batch", 216),
    ("relay_fight", "book", 1),
    ("relay_fight", "extraBatch", 6),
    ("relay_fight", "flow", 5),
    ("relay_fight", "law", 8),
    ("relay_fight", "objective", 19),
    ("relay_fight", "paired", 112),
    ("relay_fight", "purse", 21),
    ("relay_fight", "rank", 13),
    ("relay_fight", "reuse", 36),
    ("relay_fight", "script", 968),
    ("relay_fight", "single", 33),
    ("relay_fight", "target", 73),
    ("rng", "floats", 7),
    ("rng", "init", 842),
    ("rng", "int_bad", 11),
    ("rng", "ints", 48),
    ("rng", "name_check", 22),
    ("rng", "restore_draws", 12),
    ("rng", "seed_check", 19),
    ("rng", "seq", 207),
    ("rng", "state", 24),
    ("rng", "trace", 120),
    ("round", "clamp", 672),
    ("round", "finite_or", 60),
    ("round", "floor", 1564),
    ("round", "fround", 1564),
    ("round", "imul", 569),
    ("round", "int32", 1564),
    ("round", "is_integer", 1564),
    ("round", "is_safe_integer", 1564),
    ("round", "math_round", 1564),
    ("round", "max", 444),
    ("round", "min", 444),
    ("round", "or_default", 60),
    ("round", "rem", 960),
    ("round", "trunc", 1564),
    ("round", "uint32", 1564),
    ("round", "unity_round", 1564),
    ("save", "cfs", 2426),
    ("save", "cfsa", 5),
    ("save", "cl", 2000),
    ("save", "def", 2913),
    ("save", "eff", 2075),
    ("save", "ls", 4464),
    ("save", "mcs", 2000),
    ("save", "msa", 2000),
    ("save", "pf", 2000),
    ("save", "rem", 2000),
    ("save", "rm", 3030),
    ("save", "smo", 2000),
    ("save", "sn", 2000),
    ("save", "sv", 2000),
    ("save", "wsk", 2000),
    ("simulate_fight", "batch", 216),
    ("simulate_fight", "batchWith", 1),
    ("simulate_fight", "book", 1),
    ("simulate_fight", "durability", 2),
    ("simulate_fight", "extraBatch", 13),
    ("simulate_fight", "paired", 4),
    ("simulate_fight", "reuse", 36),
    ("simulate_fight", "schedule", 17),
    ("simulate_fight", "script", 1),
    ("simulate_fight", "seeds", 13),
    ("simulate_fight", "segment", 5),
    ("simulate_fight", "single", 54),
    ("simulate_fight", "summary", 36),
    ("simulate_fight", "wilson", 97),
    ("simulate_fight", "with", 36),
    ("sockets", "def", 1430),
    ("sockets", "pgem", 2000),
    ("sockets", "psock", 3030),
    ("sockets", "saff", 3030),
    ("sockets", "scount", 3030),
    ("spells", "boss", 2688),
    ("spells", "card", 2865),
    ("spells", "catalogue", 2688),
    ("spells", "climb", 2712),
    ("spells", "custom_book", 1),
    ("spells", "effect", 2689),
    ("spells", "effect_grid", 4656),
    ("spells", "enchant", 3146),
    ("spells", "parse_book", 1),
    ("spells", "record", 2784),
    ("spells", "resolve", 2688),
    ("spells", "saving", 2689),
    ("spells", "stock", 1),
    ("spells", "target_cost_table", 1),
    ("swing", "classic_strength", 405),
    ("swing", "swing_frame", 14220),
    ("swing", "swing_handling", 65),
    ("swing", "swing_heft", 555),
    ("target", "armor_body_parts", 2400),
    ("target", "armour_condition", 2404),
    ("target", "armour_material_id", 2404),
    ("target", "armour_piece", 2405),
    ("target", "armour_reduction", 2408),
    ("target", "atk", 62),
    ("target", "body_part_weights", 3),
    ("target", "bonus_range", 2406),
    ("target", "bonus_value", 2417),
    ("target", "bonus_values", 2402),
    ("target", "career_attack_modifier", 2400),
    ("target", "career_tolerance", 2400),
    ("target", "condition_percentage", 2400),
    ("target", "element_share", 2400),
    ("target", "enemy_armor_values", 2400),
    ("target", "enemy_career_index", 2400),
    ("target", "enemy_entity_type", 2400),
    ("target", "enemy_group", 2400),
    ("target", "enemy_type_group", 2402),
    ("target", "equip_armour", 2000),
    ("target", "expected_damage", 2400),
    ("target", "has_worn", 2400),
    ("target", "intrinsic_damage", 2400),
    ("target", "is_shield_template", 2400),
    ("target", "is_skeletal", 2400),
    ("target", "item_armor_value", 2400),
    ("target", "left_hand", 2402),
    ("target", "live_stat", 2406),
    ("target", "material_armor_value", 2400),
    ("target", "monster_hide", 2400),
    ("target", "natural", 2400),
    ("target", "part_damage", 2403),
    ("target", "part_outcomes", 2403),
    ("target", "rri_class", 176),
    ("target", "shield_beats", 2430),
    ("target", "shield_block", 2403),
    ("target", "shield_reduction", 2408),
    ("target", "silver_applies", 2400),
    ("target", "silver_doubles", 2400),
    ("target", "skeletal_damage", 2402),
    ("target", "slot_for_body_part", 2400),
    ("target", "struck_slot", 2400),
    ("target", "tgt", 473),
    ("theory", "blade", 3128),
    ("theory", "character", 3136),
    ("theory", "constants", 1),
    ("theory", "fists", 3129),
    ("theory", "refusal", 7),
    ("value", "prop", 2500),
    ("value", "seq", 2540),
    ("value", "svz", 1340),
    ("value", "tonum", 2674),
    ("value", "tostr", 2674),
    ("value", "truthy", 2174),
    ("value", "value", 3174),
];

/// The full generator's counts may not fall below [`FULL_FLOOR`], and every kind is checked (so a new kind missing from
/// the table fails too). The sample's kept count must be at least 1 case per kind: every hand case plus the witnesses
/// keeps far more, but a kind that shrank to zero is a sampler bug.
#[test]
fn every_kind_stays_above_its_static_floor() {
    let manifest = common::manifest();
    // Every kind the sample ships must be in the table: a new family cannot ride along unchecked.
    for (module, kind) in manifest.total.keys() {
        assert!(
            FULL_FLOOR.iter().any(|(m, k, _)| m == module && k == kind),
            "kind `{kind}` in `{module}` is not in FULL_FLOOR: add its exact full count"
        );
    }
    for (module, kind, floor) in FULL_FLOOR {
        let key = ((*module).to_owned(), (*kind).to_owned());
        let total = *manifest
            .total
            .get(&key)
            .unwrap_or_else(|| panic!("MANIFEST has no kind `{kind}` in module `{module}`"));
        assert!(
            total >= *floor,
            "{module}/{kind}: the full generator wrote {total} cases, below the static floor {floor}"
        );
        let kept = *manifest
            .kept
            .get(&key)
            .unwrap_or_else(|| panic!("MANIFEST keeps no kind `{kind}` in module `{module}`"));
        let kept_floor = 1.min(*floor);
        assert!(
            kept >= kept_floor,
            "{module}/{kind}: the sample keeps {kept} cases, expected at least {kept_floor}"
        );
    }
}

/// Every module the sample commits: one `.txt.gz` each, no more and no fewer than `MANIFEST` names. This is about the
/// committed sample, so it does not run when the opt-in full set is in force.
#[test]
fn the_sample_has_one_module_per_manifest_entry() {
    if !common::frozen() {
        return;
    }
    let manifest = common::manifest();
    let on_disk: BTreeSet<String> = fs::read_dir(frozen_dir())
        .expect("the frozen sample directory")
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.strip_suffix(".txt.gz").map(str::to_owned)
        })
        .collect();
    let recorded: BTreeSet<String> = manifest.cases.keys().cloned().collect();
    assert_eq!(
        on_disk, recorded,
        "frozen/*.txt.gz and MANIFEST must name the same modules"
    );
}

/// A full read of each module yields exactly the cases `MANIFEST` records, per kind too: that is what makes a truncated
/// or regenerated sample fail here rather than pass every vector test with fewer cases. Under `DFO_VECTORS_DIR` the read
/// is the full generated set, so the counts it must match are the MANIFEST's `total`, not the sample's `kept`.
#[test]
fn every_module_reads_exactly_what_manifest_records() {
    let manifest = common::manifest();
    let full = !common::frozen();
    for (module, sample_cases) in &manifest.cases {
        let mut seen: BTreeMap<String, usize> = BTreeMap::new();
        let mut n = 0;
        for c in common::stream(module) {
            *seen.entry(c.kind.clone()).or_default() += 1;
            n += 1;
        }
        if full {
            assert_eq!(
                n,
                manifest.full_cases(module),
                "{module}: cases read vs the MANIFEST's full total"
            );
            for (kind, got) in &seen {
                let want = *manifest
                    .total
                    .get(&(module.clone(), kind.clone()))
                    .unwrap_or_else(|| panic!("{module}: kind `{kind}` absent from MANIFEST"));
                assert_eq!(got, &want, "{module}/{kind}: cases read vs the total");
            }
            for (_, kind) in manifest.total.keys().filter(|(m, _)| m == module) {
                assert!(
                    seen.contains_key(kind),
                    "{module}/{kind}: MANIFEST records a total the read did not find"
                );
            }
        } else {
            assert_eq!(n, *sample_cases, "{module}: cases read vs MANIFEST");
            for (kind, got) in &seen {
                let want = *manifest
                    .kept
                    .get(&(module.clone(), kind.clone()))
                    .unwrap_or_else(|| panic!("{module}: kind `{kind}` absent from MANIFEST"));
                assert_eq!(got, &want, "{module}/{kind}: cases read vs MANIFEST");
            }
            for (_, kind) in manifest.kept.keys().filter(|(m, _)| m == module) {
                assert!(
                    seen.contains_key(kind),
                    "{module}/{kind}: MANIFEST records cases the read did not find"
                );
            }
        }
    }
}

/// Every `.txt.gz` in the sample matches its MANIFEST `module` record byte for byte: the gzip sha256, the decoded raw
/// sha256, the decoded size and the case count. This is the check that survives deleting `tools/vector-freeze.mjs`.
#[test]
fn every_module_matches_its_manifest_digest() {
    if !common::frozen() {
        return;
    }
    let text = fs::read_to_string(frozen_dir().join("MANIFEST")).expect("MANIFEST");
    let modules: Vec<Vec<&str>> = text
        .lines()
        .filter(|l| l.starts_with("module "))
        .map(|l| l.split(' ').collect())
        .collect();
    assert!(!modules.is_empty(), "MANIFEST names no module");
    for f in &modules {
        let [_, name, gzip_sha, raw_sha, raw_bytes, cases] = f.as_slice() else {
            panic!("bad module line: {f:?}");
        };
        let packed = fs::read(frozen_dir().join(format!("{name}.txt.gz")))
            .unwrap_or_else(|e| panic!("{name}.txt.gz: {e}"));
        assert_eq!(
            hex(&sha256(&packed)),
            *gzip_sha,
            "{name}.txt.gz: gzip sha256 differs from MANIFEST"
        );
        let mut gz = flate2::read::GzDecoder::new(&packed[..]);
        let mut raw = Vec::new();
        std::io::Read::read_to_end(&mut gz, &mut raw)
            .unwrap_or_else(|e| panic!("{name}.txt.gz does not decompress: {e}"));
        assert_eq!(
            hex(&sha256(&raw)),
            *raw_sha,
            "{name}: decoded sha256 differs from MANIFEST"
        );
        assert_eq!(
            raw.len().to_string(),
            *raw_bytes,
            "{name}: decoded size differs from MANIFEST"
        );
        let n = raw
            .split(|b| *b == b'\n')
            .filter(|l| !l.is_empty() && l[0] != b'#')
            .count();
        assert_eq!(
            n.to_string(),
            *cases,
            "{name}: case count differs from MANIFEST"
        );
    }
}

/// A module whose file is absent is a hard failure, not an empty pass.
#[test]
fn a_missing_module_fails_loudly() {
    if !common::frozen() {
        return;
    }
    let dir = temp_dir("missing");
    let path = dir.join("absent.txt.gz");
    let failure = catch_unwind(AssertUnwindSafe(|| {
        let _ = common::CaseStream::open(&path, "absent", None).count();
    }));
    assert!(failure.is_err(), "a missing module must panic, got a pass");
    fs::remove_dir_all(&dir).ok();
}

/// A truncated gzip is a hard failure: the decoder error must not read as "no cases left". `expect` is `None` on
/// purpose, so a count mismatch cannot be what makes the test pass — the only failure left is the decode.
#[test]
fn a_corrupt_module_fails_loudly() {
    if !common::frozen() {
        return;
    }
    let dir = temp_dir("corrupt");
    let path = dir.join("broken.txt.gz");
    let mut bytes = fs::read(frozen_dir().join("value.txt.gz")).expect("value.txt.gz");
    let cut = bytes.len() / 2;
    bytes.truncate(cut);
    fs::write(&path, &bytes).expect("write the truncated module");
    let failure = catch_unwind(AssertUnwindSafe(|| {
        let _ = common::CaseStream::open(&path, "broken", None).count();
    }));
    assert!(failure.is_err(), "a corrupt module must panic, got a pass");
    fs::remove_dir_all(&dir).ok();
}

/// A read that ends on a different case count than `MANIFEST` records is a hard failure: this is the check that makes a
/// stale sample fail rather than assert fewer answers.
#[test]
fn a_case_count_mismatch_fails_loudly() {
    if !common::frozen() {
        return;
    }
    let dir = temp_dir("count");
    let path = dir.join("value.txt.gz");
    fs::copy(frozen_dir().join("value.txt.gz"), &path).expect("copy value.txt.gz");
    let failure = catch_unwind(AssertUnwindSafe(|| {
        let _ = common::CaseStream::open(&path, "value", Some(usize::MAX)).count();
    }));
    assert!(
        failure.is_err(),
        "a case count that differs from MANIFEST must panic, got a pass"
    );
    // The same file passes when the count is the recorded one: the failure above is the count, not the file.
    let manifest = common::manifest();
    let want = manifest.cases["value"];
    let n = common::CaseStream::open(&path, "value", Some(want)).count();
    assert_eq!(n, want);
    fs::remove_dir_all(&dir).ok();
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dfo-frozen-{tag}-{}", std::process::id()));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}
