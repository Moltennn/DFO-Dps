mod common;

use common::Case;
use dfo_core::rng::{check_seed, initial_state, Rng, RngSnapshot};
use std::collections::BTreeMap;

fn rng_for(c: &Case, seed: f64) -> Rng {
    Rng::new(seed).unwrap_or_else(|e| c.fail(&format!("seed {seed:?} rejected: {e}")))
}

fn parse_hex_u32(c: &Case, s: &str) -> u32 {
    if s.len() != 8 {
        c.fail(&format!("bad u32 `{s}`"));
    }
    u32::from_str_radix(s, 16).unwrap_or_else(|_| c.fail(&format!("bad u32 `{s}`")))
}

#[test]
fn rng_matches_js_vectors() {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    let mut long_sequences = 0;
    for mut c in common::load("rng") {
        let kind = c.kind.clone();
        match kind.as_str() {
            "init" => {
                let seed = c.f64();
                let name = c.name();
                let exp = [c.u32(), c.u32(), c.u32(), c.u32()];
                let s = check_seed(seed).unwrap_or_else(|e| c.fail(&e.to_string()));
                c.check_eq("initial_state", exp, initial_state(s, &name));
            }
            "seed_check" => {
                let seed = c.f64();
                let ok = c.word() == "ok";
                c.check_eq(
                    &format!("Rng::new({seed:?}).is_ok()"),
                    ok,
                    Rng::new(seed).is_ok(),
                );
            }
            "name_check" => {
                let name = c.name();
                let ok = c.word() == "ok";
                let mut r = Rng::new(1.0).unwrap();
                c.check_eq(
                    &format!("stream({name:04x?}).is_ok()"),
                    ok,
                    r.stream(&name).is_ok(),
                );
            }
            "seq" => {
                let seed = c.f64();
                let name = c.name();
                let count = c.u64();
                let mut r = rng_for(&c, seed);
                let s = r.stream(&name).unwrap();
                for i in 0..count {
                    let exp = c.u32();
                    let got = s.next_u32();
                    if exp != got {
                        c.fail(&format!("draw {i}: expected {exp:08x}, got {got:08x}"));
                    }
                }
                c.check_eq("draws", count, s.draws());
                if count == 10_000 {
                    long_sequences += 1;
                }
            }
            "floats" => {
                let seed = c.f64();
                let name = c.name();
                let count = c.u64();
                let mut r = rng_for(&c, seed);
                let mut twin = rng_for(&c, seed);
                for i in 0..count {
                    let exp = c.f64();
                    let got = r.stream(&name).unwrap().float();
                    c.check_f64(&format!("float {i}"), exp, got);
                    // float() is next() / 2^32 by definition (src/rng.js:99)
                    let w = twin.stream(&name).unwrap().next_u32();
                    c.check_f64("float = next/2^32", got, f64::from(w) / 4294967296.0);
                }
            }
            "ints" => {
                let seed = c.f64();
                let name = c.name();
                let n = c.int() as f64;
                let count = c.u64();
                let mut r = rng_for(&c, seed);
                let s = r.stream(&name).unwrap();
                for i in 0..count {
                    let exp = c.int();
                    let got = s.int(n).unwrap_or_else(|e| c.fail(&e.to_string()));
                    c.check_eq(&format!("int({n}) draw {i}"), exp, got as i64);
                }
            }
            "int_bad" => {
                let n = c.f64();
                let mut r = Rng::new(7.0).unwrap();
                let s = r.stream_str("q").unwrap();
                c.check_eq(&format!("int({n:?}).is_err()"), true, s.int(n).is_err());
                c.check_eq("draws after a rejected int", 0, s.draws());
            }
            "state" => {
                let seed = c.f64();
                let name = c.name();
                let k = c.u64();
                let exp = [c.u32(), c.u32(), c.u32(), c.u32()];
                let draws = c.u64();
                let mut r = rng_for(&c, seed);
                let s = r.stream(&name).unwrap();
                for _ in 0..k {
                    s.next_u32();
                }
                let snap = s.snapshot();
                c.check_eq("state words", exp, snap.state);
                c.check_eq("draws", draws, snap.draws);
            }
            "restore_draws" => {
                let seed = c.f64();
                let name = c.name();
                let draws = c.u64();
                let ok = c.word() == "ok";
                let mut r = rng_for(&c, seed);
                let s = r.stream(&name).unwrap();
                let mut snap = s.snapshot();
                snap.draws = draws;
                c.check_eq(
                    &format!("restore with draws={draws}"),
                    ok,
                    s.restore(&snap).is_ok(),
                );
            }
            "trace" => {
                let seed = c.f64();
                let mut r = rng_for(&c, seed);
                let mut slots: Vec<RngSnapshot> = Vec::new();
                while c.remaining() > 0 {
                    let tok = c.word();
                    let (head, rest) = tok.split_at(1);
                    match head {
                        "n" => {
                            let (name, val) =
                                rest.split_once('=').unwrap_or_else(|| c.fail("bad op"));
                            let name = c.units(name);
                            let exp = parse_hex_u32(&c, val);
                            let got = r.stream(&name).unwrap().next_u32();
                            c.check_eq(&format!("op `{tok}`"), exp, got);
                        }
                        "f" => {
                            let (name, val) =
                                rest.split_once('=').unwrap_or_else(|| c.fail("bad op"));
                            let name = c.units(name);
                            let exp = common::parse_f64(val).unwrap_or_else(|| c.fail("bad f64"));
                            let got = r.stream(&name).unwrap().float();
                            c.check_f64(&format!("op `{tok}`"), exp, got);
                        }
                        "i" => {
                            let (lhs, val) =
                                rest.split_once('=').unwrap_or_else(|| c.fail("bad op"));
                            let (name, n) = lhs.split_once(':').unwrap_or_else(|| c.fail("bad op"));
                            let name = c.units(name);
                            let n: f64 = n.parse().unwrap_or_else(|_| c.fail("bad n"));
                            let exp: u64 = val.parse().unwrap_or_else(|_| c.fail("bad int"));
                            let got = r.stream(&name).unwrap().int(n).unwrap();
                            c.check_eq(&format!("op `{tok}`"), exp, got);
                        }
                        "S" => slots.push(r.snapshot()),
                        "R" => {
                            let k: usize = rest.parse().unwrap_or_else(|_| c.fail("bad slot"));
                            r.restore(&slots[k])
                                .unwrap_or_else(|e| c.fail(&e.to_string()));
                        }
                        "D" => {
                            let list = rest.strip_prefix('=').unwrap_or_else(|| c.fail("bad op"));
                            let exp: Vec<(Vec<u16>, u64)> = if list == "-" {
                                Vec::new()
                            } else {
                                list.split(',')
                                    .map(|e| {
                                        let (n, d) = e
                                            .split_once(':')
                                            .unwrap_or_else(|| c.fail("bad draws"));
                                        (
                                            c.units(n),
                                            d.parse().unwrap_or_else(|_| c.fail("bad draws")),
                                        )
                                    })
                                    .collect()
                            };
                            c.check_eq("draws()", exp, r.draws());
                        }
                        _ => c.fail(&format!("unknown trace op `{tok}`")),
                    }
                }
            }
            other => c.fail(&format!("unknown kind `{other}`")),
        }
        c.done();
        *seen.entry(kind).or_default() += 1;
    }
    assert!(
        long_sequences >= 6,
        "rng.txt: only {long_sequences} sequences of 10000 draws (expected >= 6)"
    );
    for kind in [
        "init",
        "seed_check",
        "name_check",
        "seq",
        "floats",
        "ints",
        "int_bad",
        "state",
        "restore_draws",
        "trace",
    ] {
        let min = common::floor("rng", kind);
        let n = seen.get(kind).copied().unwrap_or(0);
        assert!(
            n >= min,
            "rng.txt: only {n} `{kind}` cases (expected >= {min})"
        );
    }
}
