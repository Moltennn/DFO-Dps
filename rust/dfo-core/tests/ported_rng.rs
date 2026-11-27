//! Ported from `test/rng.test.js`: the seeded stream RNG, as known values and invariants.
//!
//! LOCAL INVARIANTS. `tests/rng.rs` holds the JS parity vectors; this keeps the published xoshiro128** step, the
//! stream independence, the accounting and the invalid-input behaviour alive without Node. The two source-scan
//! assertions (no `Math.random`) have no Rust-reachable form and are listed as lost in `rust/PORTED-TESTS.md`.

mod ported_common;

use dfo_core::rng::{check_seed, Rng, RngError};
fn take(rng: &mut dfo_core::rng::Stream, n: usize) -> Vec<u32> {
    (0..n).map(|_| rng.next_u32()).collect()
}

#[test]
fn the_same_seed_and_use_give_the_same_sequence_and_a_different_seed_does_not() {
    let mut a = Rng::new(42.0).expect("a seed");
    let mut b = Rng::new(42.0).expect("a seed");
    assert_eq!(
        take(a.stream_str("blow").unwrap(), 50),
        take(b.stream_str("blow").unwrap(), 50)
    );
    let mut a = Rng::new(42.0).expect("a seed");
    let mut b = Rng::new(43.0).expect("a seed");
    assert_ne!(
        take(a.stream_str("blow").unwrap(), 8),
        take(b.stream_str("blow").unwrap(), 8)
    );
    // Zero and negative seeds are distinct.
    let mut a = Rng::new(0.0).expect("a seed");
    let mut b = Rng::new(-1.0).expect("a seed");
    assert_ne!(
        take(a.stream_str("blow").unwrap(), 8),
        take(b.stream_str("blow").unwrap(), 8)
    );
    // Large safe integers keep their high bits.
    let mut a = Rng::new(2f64.powi(40)).expect("a seed");
    let mut b = Rng::new(2f64.powi(40) + 1.0).expect("a seed");
    assert_ne!(
        take(a.stream_str("x").unwrap(), 8),
        take(b.stream_str("x").unwrap(), 8)
    );
    let mut a = Rng::new(1.0).expect("a seed");
    let mut b = Rng::new(1.0 + 2f64.powi(32)).expect("a seed");
    assert_ne!(
        take(a.stream_str("x").unwrap(), 8),
        take(b.stream_str("x").unwrap(), 8),
        "the high half of the seed matters"
    );
    assert_eq!(Rng::new(7.0).expect("a seed").seed(), 7.0);
}

#[test]
fn streams_are_independent_and_neither_draws_nor_creation_order_move_another() {
    let mut quiet = Rng::new(99.0).expect("a seed");
    let expect_blow = take(quiet.stream_str("blow").unwrap(), 20);
    let expect_echo = take(quiet.stream_str("echo").unwrap(), 20);

    let mut busy = Rng::new(99.0).expect("a seed");
    {
        let echo = busy.stream_str("echo").unwrap();
        take(echo, 1000);
    }
    assert_eq!(
        take(busy.stream_str("blow").unwrap(), 20),
        expect_blow,
        "blow is untouched by 1000 echo draws"
    );
    let mut fresh = Rng::new(99.0).expect("a seed");
    take(fresh.stream_str("blow").unwrap(), 500);
    assert_eq!(
        take(fresh.stream_str("echo").unwrap(), 20),
        expect_echo,
        "and the other way round"
    );

    assert_ne!(expect_blow, expect_echo, "two names, two sequences");
    let mut a = Rng::new(5.0).expect("a seed");
    let mut b = Rng::new(5.0).expect("a seed");
    assert_ne!(
        take(a.stream_str("spell").unwrap(), 6),
        take(b.stream_str("spelm").unwrap(), 6)
    );
    // No initial state is the all-zero fixed point.
    for name in ["a", "blow"] {
        let units: Vec<u16> = name.encode_utf16().collect();
        assert!(dfo_core::rng::initial_state(0, &units)
            .iter()
            .any(|w| *w != 0));
    }
}

#[test]
fn a_stream_matches_an_independent_xoshiro128_step_function() {
    let mut rng = Rng::new(2024.0).expect("a seed");
    let snap = rng.stream_str("blow").unwrap().snapshot();
    let mut state = snap.state;
    let rotl = |x: u32, k: u32| x.rotate_left(k);
    let step = |state: &mut [u32; 4]| -> u32 {
        let result = rotl(state[1].wrapping_mul(5), 7).wrapping_mul(9);
        let t = state[1] << 9;
        state[2] ^= state[0];
        state[3] ^= state[1];
        state[1] ^= state[2];
        state[0] ^= state[3];
        state[2] ^= t;
        state[3] = rotl(state[3], 11);
        result
    };
    let mut rng = Rng::new(2024.0).expect("a seed");
    let stream = rng.stream_str("blow").unwrap();
    for i in 0..1000 {
        let want = step(&mut state);
        assert_eq!(stream.next_u32(), want, "draw {i}");
    }
}

#[test]
fn float_is_in_range_int_is_in_range_and_the_sequence_is_roughly_uniform() {
    let mut rng = Rng::new(31337.0).expect("a seed");
    let stream = rng.stream_str("blow").unwrap();
    let mut bins = [0u32; 10];
    let n = 100_000;
    for _ in 0..n {
        let f = stream.float();
        assert!((0.0..1.0).contains(&f));
        bins[(f * 10.0) as usize] += 1;
    }
    // Pearson chi-square, 9 degrees of freedom: the 0.999 quantile is 27.88 (fixed in advance).
    let expected = n as f64 / 10.0;
    let chi: f64 = bins
        .iter()
        .map(|o| {
            let d = *o as f64 - expected;
            d * d / expected
        })
        .sum();
    assert!(chi < 27.88, "chi-square {chi:.2} for {bins:?}");
    let mut ints = [0u32; 7];
    for _ in 0..70_000 {
        let k = stream.int(7.0).expect("a legal n");
        assert!(k < 7);
        ints[k as usize] += 1;
    }
    for c in ints {
        assert!((c as f64 - 10_000.0).abs() < 400.0, "int(7): {ints:?}");
    }
    assert_eq!(stream.int(1.0).expect("n = 1"), 0);
}

#[test]
fn draw_accounting_counts_every_draw_per_stream_and_nothing_else() {
    let mut rng = Rng::new(1.0).expect("a seed");
    assert!(rng.draws().is_empty(), "no stream, no draws");
    {
        let blow = rng.stream_str("blow").unwrap();
        blow.next_u32();
        blow.float();
        blow.int(6.0).expect("a legal n");
    }
    rng.stream_str("echo").unwrap().next_u32();
    let draws = rng.draws();
    let count = |name: &str| {
        draws
            .iter()
            .find(|(k, _)| String::from_utf16(&k[..]).unwrap_or_default() == name)
            .map_or(0, |(_, n)| *n)
    };
    assert_eq!(count("blow"), 3);
    assert_eq!(count("echo"), 1);
    assert_eq!(rng.stream_str("blow").unwrap().draws(), 3);
    // Fetching a stream is not a draw.
    rng.snapshot();
    assert_eq!(rng.draws().len(), 2);
    assert_eq!(
        rng.stream_str("spell").unwrap().draws(),
        0,
        "a new stream starts at zero"
    );
}

#[test]
fn a_snapshot_and_restore_continue_exactly_as_the_original_did() {
    let mut rng = Rng::new(777.0).expect("a seed");
    let expect_blow = {
        let blow = rng.stream_str("blow").unwrap();
        take(blow, 10)
    };
    {
        let echo = rng.stream_str("echo").unwrap();
        take(echo, 3);
    }
    let snap = rng.snapshot();
    let expect_blow_next = take(rng.stream_str("blow").unwrap(), 25);
    let expect_echo_next = take(rng.stream_str("echo").unwrap(), 25);
    let draws_after = rng.draws();
    assert_eq!(expect_blow.len(), 10);

    take(rng.stream_str("late").unwrap(), 5); // a stream created after the snapshot
    rng.restore(&snap).expect("a matching snapshot");
    let names: Vec<String> = rng
        .draws()
        .iter()
        .map(|(k, _)| String::from_utf16(&k[..]).unwrap_or_default())
        .collect();
    assert_eq!(names, ["blow", "echo"], "the late stream is gone");
    assert_eq!(take(rng.stream_str("blow").unwrap(), 25), expect_blow_next);
    assert_eq!(take(rng.stream_str("echo").unwrap(), 25), expect_echo_next);
    assert_eq!(rng.draws(), draws_after);
    // A discarded stream starts fresh when used again.
    let mut fresh = Rng::new(777.0).expect("a seed");
    assert_eq!(
        take(rng.stream_str("late").unwrap(), 5),
        take(fresh.stream_str("late").unwrap(), 5)
    );

    // Per-stream: restore one stream only, and the draw count keeps counting.
    let mut rng = Rng::new(5.0).expect("a seed");
    take(rng.stream_str("blow").unwrap(), 4);
    let one = rng.stream_str("blow").unwrap().snapshot();
    let next = take(rng.stream_str("blow").unwrap(), 6);
    rng.stream_str("blow")
        .unwrap()
        .restore(&one)
        .expect("a stream snapshot");
    assert_eq!(take(rng.stream_str("blow").unwrap(), 6), next);
    assert_eq!(rng.stream_str("blow").unwrap().draws(), 10);
}

#[test]
fn invalid_input_is_rejected_predictably_and_a_rejected_call_draws_nothing() {
    for bad in [
        f64::NAN,
        f64::INFINITY,
        1.5,
        2f64.powi(53),
        -2f64.powi(53) - 1.0,
    ] {
        assert!(check_seed(bad).is_err(), "seed {bad}");
    }
    assert!(check_seed(0.0).is_ok());
    assert!(check_seed(9_007_199_254_740_991.0).is_ok());
    assert!(check_seed(-9_007_199_254_740_991.0).is_ok());

    let mut rng = Rng::new(1.0).expect("a seed");
    assert!(rng.stream_str("").is_err(), "an empty name");
    assert!(
        rng.stream_str(&"x".repeat(65)).is_err(),
        "a name over 64 units"
    );
    assert!(rng.stream_str(&"x".repeat(64)).is_ok(), "exactly 64 units");
    let stream = rng.stream_str("blow").unwrap();
    for bad in [0.0, -1.0, 1.5, f64::NAN, 4_294_967_297.0] {
        assert!(stream.int(bad).is_err(), "int({bad})");
    }
    assert_eq!(stream.draws(), 0, "a rejected call draws nothing");

    // Snapshots: another seed, another stream, a malformed one, the all-zero state.
    let mut other = Rng::new(2.0).expect("a seed");
    other.stream_str("blow").unwrap().next_u32();
    let mut rng = Rng::new(1.0).expect("a seed");
    rng.stream_str("blow").unwrap().next_u32();
    assert!(
        rng.restore(&other.snapshot()).is_err(),
        "a snapshot of another seed"
    );
    let snap = rng.snapshot();
    let mut third = Rng::new(1.0).expect("a seed");
    assert!(
        third
            .stream_str("other")
            .unwrap()
            .restore(&snap.streams[0])
            .is_err(),
        "a snapshot of another stream"
    );
    let mut zero = Rng::new(1.0).expect("a seed");
    let mut bad = zero.stream_str("blow").unwrap().snapshot();
    bad.state = [0, 0, 0, 0];
    assert!(zero.stream_str("blow").unwrap().restore(&bad).is_err());
    let mut negative = zero.stream_str("blow").unwrap().snapshot();
    negative.state = [1, 2, 3, 4];
    negative.draws = 0;
    assert!(zero.stream_str("blow").unwrap().restore(&negative).is_ok());
}

#[test]
fn a_generator_is_its_own_and_shares_nothing() {
    let mut a = Rng::new(8.0).expect("a seed");
    let mut b = Rng::new(8.0).expect("a seed");
    take(a.stream_str("blow").unwrap(), 100);
    assert!(b.draws().is_empty());
    let mut fresh = Rng::new(8.0).expect("a seed");
    assert_eq!(
        take(b.stream_str("blow").unwrap(), 3),
        take(fresh.stream_str("blow").unwrap(), 3)
    );
}

#[test]
fn a_malformed_stream_snapshot_is_a_type_error() {
    let mut rng = Rng::new(1.0).expect("a seed");
    let mut bad = rng.stream_str("blow").unwrap().snapshot();
    bad.name = "other".encode_utf16().collect();
    let got = rng.stream_str("blow").unwrap().restore(&bad);
    match got {
        Err(RngError::Type(message)) => assert!(!message.is_empty()),
        other => panic!("expected a TypeError, got {other:?}"),
    }
}
