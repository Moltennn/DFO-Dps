//! `fault::guard`'s process-wide hook: ONE delegating layer, quiet only on the guarding thread.
//!
//! A separate test binary on purpose: the panic hook is process-global, so this must not share a process with another
//! test that installs one (`tests/gui_faults.rs` calls `guard` too, and the harness itself prints panics).

use dfo_core::fault::{chain_hook_for_test, guard, CoreFault};
use std::panic;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

static REPORTED: AtomicUsize = AtomicUsize::new(0);

fn reported() -> usize {
    REPORTED.load(Ordering::SeqCst)
}

#[test]
fn the_hook_is_shared_quiet_only_on_the_guarding_thread_and_never_lost() {
    // A host hook that counts reports. The crate may wrap it, but must never remove it or put a no-op in its place.
    panic::set_hook(Box::new(|_| {
        REPORTED.fetch_add(1, Ordering::SeqCst);
    }));
    chain_hook_for_test();

    // 1. An unguarded panic reaches the host hook.
    let base = reported();
    assert!(panic::catch_unwind(|| panic!("unguarded")).is_err());
    assert_eq!(
        reported(),
        base + 1,
        "an unguarded panic reaches the host hook"
    );

    // 2. A guarded panic is quiet and still answers with its typed fault.
    let base = reported();
    assert_eq!(
        guard(|| panic!("guarded")),
        Err(CoreFault::Message("guarded".to_owned()))
    );
    assert_eq!(reported(), base, "a guarded panic is quiet");

    // 3. Eight threads guard at once. Each guarded panic is quiet; each thread's UNGUARDED panic, which runs while other
    //    threads are inside a guard, must still reach the host hook. The old per-call `take_hook`/`set_hook` swap lost
    //    these (another thread's guard had a no-op installed, or the interleaved restores dropped the host hook).
    let base = reported();
    let threads: Vec<_> = (0..8)
        .map(|_| {
            thread::spawn(|| {
                for _ in 0..50 {
                    assert!(
                        guard(|| panic!("guarded on a worker")).is_err(),
                        "every guarded panic answers"
                    );
                    let _ = panic::catch_unwind(|| panic!("unguarded on a worker"));
                }
            })
        })
        .collect();
    for t in threads {
        t.join()
            .expect("no worker may lose its guard to a hook swap");
    }
    assert_eq!(
        reported(),
        base + 8 * 50,
        "every unguarded panic reached the host hook"
    );

    // 4. After the storm the host hook is still the one reporting (it was never taken away for good).
    let base = reported();
    let _ = panic::catch_unwind(|| panic!("after the storm"));
    assert_eq!(reported(), base + 1, "the host hook survived every guard");

    // 5. `guard` from a `Drop` that runs during unwinding: the inner panic is caught, not an abort, and the outer panic
    //    goes on to the outer `guard`. The depth is restored on both panic paths.
    struct GuardInDrop;
    impl Drop for GuardInDrop {
        fn drop(&mut self) {
            assert_eq!(
                guard(|| panic!("from a drop")),
                Err(CoreFault::Message("from a drop".to_owned()))
            );
        }
    }
    let base = reported();
    let outer = guard(|| {
        let _keep = GuardInDrop;
        panic!("outer");
    });
    assert_eq!(
        outer,
        Err(CoreFault::Message("outer".to_owned())),
        "a guard from a Drop during unwinding catches"
    );
    assert_eq!(reported(), base, "both panics were guarded and quiet");
    let base = reported();
    let _ = panic::catch_unwind(|| panic!("depth restored"));
    assert_eq!(
        reported(),
        base + 1,
        "the depth is restored on the panic path"
    );
    drop(panic::take_hook());
}
