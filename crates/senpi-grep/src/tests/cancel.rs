use super::corpus::Corpus;
use crate::cancel::Checkpoint;
use crate::{search, CancelToken, GrepError};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[test]
fn timeout_no_match_scan_and_abort() {
    let c = Corpus::new();
    c.put("a.ts", "no match here\n".repeat(20_000));
    let o = c.options();
    for phase in [
        Checkpoint::Walk,
        Checkpoint::BeforeRead,
        Checkpoint::Read,
        Checkpoint::Scan,
    ] {
        let start = Instant::now();
        let seen = Arc::new(AtomicBool::new(false));
        let mark = seen.clone();
        let cancel = CancelToken::with_clock(start + Duration::from_secs(1), move |point| {
            if point == phase {
                mark.store(true, Ordering::Relaxed);
            }
            if mark.load(Ordering::Relaxed) {
                start + Duration::from_secs(2)
            } else {
                start
            }
        });
        let r = search(&o, &cancel).unwrap();
        assert!(
            seen.load(Ordering::Relaxed),
            "missing {phase:?} checkpoint on no-match scan"
        );
        assert!(r.timed_out, "timeout must be partial at {phase:?}");
        assert!(!r.counts.exact);
        assert!(r.matches.is_empty());
        assert!(r.warnings.iter().any(|w| w.code == "TIMEOUT"));
    }
    c.put("a.ts", "needle\nneedle\n");
    let start = Instant::now();
    let cancel = CancelToken::with_clock(start + Duration::from_secs(1), move |point| {
        if point == Checkpoint::Sink {
            start + Duration::from_secs(2)
        } else {
            start
        }
    });
    assert!(search(&o, &cancel).unwrap().timed_out);
    let cancel = CancelToken::new(None);
    cancel.aborted.store(true, Ordering::Release);
    assert!(matches!(search(&o, &cancel), Err(GrepError::Aborted)));
    // Abort while scanning, not just before entry; no event-loop or sleeps.
    let aborted = Arc::new(AtomicBool::new(false));
    let mark = aborted.clone();
    let mut cancel = CancelToken::with_clock(start + Duration::from_secs(1), move |point| {
        if point == Checkpoint::Scan {
            mark.store(true, Ordering::Release);
        }
        start
    });
    cancel.aborted = aborted;
    assert!(matches!(search(&o, &cancel), Err(GrepError::Aborted)));
}

#[test]
fn timeout_keeps_only_completed_ordered_prefix() {
    let c = Corpus::new();
    c.put("a.ts", "needle\n");
    c.put("b.ts", "no match\n");
    c.put("z.ts", "needle\n");
    let start = Instant::now();
    let reads = AtomicUsize::new(0);
    let cancel = CancelToken::with_clock(start + Duration::from_secs(1), move |point| {
        if point == Checkpoint::BeforeRead && reads.fetch_add(1, Ordering::Relaxed) == 1 {
            start + Duration::from_secs(2)
        } else {
            start
        }
    });
    // Rayon itself owns this worker. Single-worker scheduling makes the second
    // read's injected deadline exact without sleeps or completion-order luck.
    let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
    let r = pool.install(|| search(&c.options(), &cancel)).unwrap();
    assert!(r.timed_out);
    assert_eq!(r.counts.files, 1);
    assert_eq!(r.matches[0].path, "a.ts");
    assert_eq!(r.files_searched, 0, "timeout counts only fully committed chunks");
}
