//! The GUI's boundary: turn a panic into an answer.
//!
//! `dfo_core` is written for a CLI that lets a panic end the process, but a GUI hosts it in a long-lived process where a
//! panic must not take the window down. [`guard`] runs a closure behind `std::panic::catch_unwind` and reports the fault
//! as a typed [`CoreFault`] instead. The panics it is meant for are the two the port deliberately keeps: the JS
//! `RangeError` crash class ([`crate::model_blow::JsRangeError`]), and the "not representable" panic a JS `TypeError`
//! would raise.
//!
//! Rules a GUI must follow:
//! - **`panic = "unwind"`.** `catch_unwind` cannot catch an abort; a build with `panic = "abort"` in any profile turns
//!   every fault into a crash. Do not set it.
//! - **Discard state after a fault.** A panic may leave the value it was working on half-written (a partially filled
//!   `Value`, a `Carry` remainder, a cache entry). After a [`CoreFault`], drop the affected build, fight, [`crate::model_blow::Carry`] and
//!   `TierCache`; re-import or rebuild rather than reuse. `guard` cannot roll that back.
//! - **Never copy the CLI's hook.** `dfo_cli` installs a process-wide panic hook that prints one line and calls
//!   `std::process::exit`. A GUI must not: it would exit the GUI process.
//!
//! How the quieting works: the first [`guard`] installs ONE process-wide hook that delegates to the hook it found in
//! place, and skips that call only while the *current thread* is inside a guard. So a host's hook is never taken away
//! or put back, another thread's panics are still reported while this one guards, and `guard` may be called from a
//! `Drop` during unwinding. Install your own hook before the first `guard` if you want it under the chain; a hook
//! installed later replaces the chain (a panic is then reported normally, and `guard` still catches it).
//!
//! This is the one place the crate catches a panic, and it is the caller's choice to use it: the CLI and the vector tests
//! still call the plain functions.

use crate::model_blow::JsRangeError;
use std::cell::Cell;
use std::sync::Once;

/// What went wrong at a boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreFault {
    /// A JS `RangeError`: the JS would throw here too (a spread past V8's limit, an array length past 2^32-1), or a port
    /// guard fired far above any legitimate input (see the caps in `rust/FORGE-API.md`).
    Range(String),
    /// A panic that carried a message string.
    Panic(String),
    /// A panic that carried a `&'static str`, which is what a plain `panic!("...")` payload is.
    Message(String),
    /// A panic with a payload none of the above name (an `assert_eq!` over a plain struct, an opaque value).
    Unknown,
}

impl CoreFault {
    /// A sentence a GUI may show.
    pub fn message(&self) -> String {
        match self {
            CoreFault::Range(m) | CoreFault::Panic(m) | CoreFault::Message(m) => m.clone(),
            CoreFault::Unknown => "the core failed on this input".to_owned(),
        }
    }
}

thread_local! {
    /// How many `guard` calls this thread is inside. A panic is quiet only where this is non-zero, so the flag is per
    /// thread and needs no lock.
    static DEPTH: Cell<u32> = const { Cell::new(0) };
}

static HOOK: Once = Once::new();

/// Put a hook in place that delegates to the hook it found, quieting only this thread's guarded panics. It never
/// restores anything, so a later thread's guard sees a chain, not a swap.
fn chain_hook() {
    let host = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if DEPTH.with(Cell::get) == 0 {
            host(info);
        }
    }));
}

/// Put a fresh hook layer in place now. `guard` does this once per process; a test calls it to put a recorder under the
/// chain, and that is the only reason it is public.
#[doc(hidden)]
pub fn chain_hook_for_test() {
    chain_hook();
}

/// Run `f`, answering its value or the fault a panic stands for. See the module docs for the rules.
pub fn guard<T>(f: impl FnOnce() -> T) -> Result<T, CoreFault> {
    HOOK.call_once(chain_hook);
    /// Restores the depth on the way out, including when `f` panics (its drop runs during the unwind `catch_unwind`
    /// catches). `Drop` can be called during an unwind, and it must not panic: it cannot.
    struct Depth;
    impl Drop for Depth {
        fn drop(&mut self) {
            DEPTH.with(|d| d.set(d.get() - 1));
        }
    }
    DEPTH.with(|d| d.set(d.get() + 1));
    let _depth = Depth;
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(value) => Ok(value),
        Err(payload) => Err(fault_of(payload)),
    }
}

fn fault_of(payload: Box<dyn std::any::Any + Send>) -> CoreFault {
    if let Some(e) = payload.downcast_ref::<JsRangeError>() {
        return CoreFault::Range(e.0.clone());
    }
    if let Some(m) = payload.downcast_ref::<String>() {
        return CoreFault::Panic(m.clone());
    }
    if let Some(m) = payload.downcast_ref::<&'static str>() {
        return CoreFault::Message((*m).to_owned());
    }
    CoreFault::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_panic_is_a_typed_fault() {
        assert_eq!(
            guard(|| panic!("no sign chosen")),
            Err(CoreFault::Message("no sign chosen".to_owned()))
        );
        assert_eq!(
            guard(|| panic!("{}", "built".to_owned())),
            Err(CoreFault::Panic("built".to_owned()))
        );
        assert_eq!(guard(|| 3 + 4), Ok(7));
    }

    #[test]
    fn a_js_range_error_keeps_its_class() {
        let fault = guard(|| crate::model_blow::js_range_error_for_test("RangeError: too big"));
        assert_eq!(
            fault,
            Err(CoreFault::Range("RangeError: too big".to_owned()))
        );
    }
}
