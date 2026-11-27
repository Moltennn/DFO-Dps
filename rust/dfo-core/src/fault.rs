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
//!   `std::process::exit`. A GUI must not: it would exit the GUI process. `guard` needs no hook; it is additive and
//!   installs none.
//!
//! This is the one place the crate catches a panic, and it is the caller's choice to use it: the CLI and the vector tests
//! still call the plain functions.

use crate::model_blow::JsRangeError;

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

/// Run `f`, answering its value or the fault a panic stands for. See the module docs for the three rules.
pub fn guard<T>(f: impl FnOnce() -> T) -> Result<T, CoreFault> {
    let prev = std::panic::take_hook();
    // The default hook would print a backtrace to a GUI's stderr; keep the process quiet for the length of the call and
    // put the caller's hook back afterwards. This is a hook swap, never the CLI's exiting hook.
    std::panic::set_hook(Box::new(|_| {}));
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    std::panic::set_hook(prev);
    match out {
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
