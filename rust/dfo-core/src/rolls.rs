//! The random rolls of the enemy builders and the equipment rolls (R3b). Every JS `rolls` argument (`Math.random` by
//! default in the JS) is an explicit input here: a value in `[0, 1)` per call, in the order the JS calls them. Nothing
//! in the port reads a clock or a global generator.
//!
//! The golden vectors drive the JS with a scripted sequence and write the values it consumed; the Rust replays those
//! values and must consume exactly as many (`tests/maketarget.rs`).

/// One roll: a number in `[0, 1)`, the JS `rolls()`.
pub trait Rolls {
    /// The next roll. Each call consumes one roll, as each JS call does.
    fn roll(&mut self) -> f64;
}

/// A closure is a roll source (the tests and the standing stand-in roll `() => 0.5`, target.js:804).
impl<F: FnMut() -> f64> Rolls for F {
    fn roll(&mut self) -> f64 {
        self()
    }
}
