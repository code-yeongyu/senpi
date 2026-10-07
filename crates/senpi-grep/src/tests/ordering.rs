use super::corpus::{Corpus, PREFIX};
use crate::walk::{order_candidates, Candidate};
use crate::GrepMode;

#[test]
fn ordered_limit_ignores_walk_completion_order() {
    let c = Corpus::new();
    c.put("z.ts", "needle\n");
    c.put("nested/a.ts", "needle\n");
    c.put("a.ts", "needle\n");
    // Exercise the actual ordering seam with a deliberately reversed visitor
    // completion sequence, not an assumption about OS/thread scheduling.
    let mut candidates: Vec<_> = ["z.ts", "nested/a.ts", "a.ts"]
        .into_iter()
        .map(|name| Candidate {
            path: c.0.join(name),
            display: name.into(),
        })
        .collect();
    order_candidates(&mut candidates);
    assert_eq!(
        candidates[0].display, "a.ts",
        "completion order must not admit z.ts first"
    );
    let mut o = c.options();
    o.paths = vec![c.path("z.ts"), c.path("nested"), c.path("")];
    o.max_count = Some(1);
    let r = c.search(&o);
    assert_eq!(r.matches.len(), 1);
    assert_eq!(r.matches[0].path, "a.ts");
    assert!(r.limit_reached);
    o.max_count = None;
    let r = c.search(&o);
    assert_eq!(r.counts.files, 3, "overlapping roots must be deduplicated");
}

#[test]
fn overlapping_roots_dedupe_by_canonical_identity() {
    // Refs #1678: aliases must not inflate results or the searched-file count.
    let c = Corpus::new();
    c.put("src/z.ts", "needle\n");
    c.put("src/nested/a.ts", "needle\n");
    c.put("src/b.ts", "needle\n");
    #[cfg(unix)]
    std::os::unix::fs::symlink("src", c.0.join("alias")).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(c.0.join("src"), c.0.join("alias")).unwrap();
    let mut o = c.options();
    for roots in [["src/nested", "src", "alias"], ["alias", "src", "src/nested"]] {
        o.paths = roots.into_iter().map(|root| c.path(root)).collect();
        let r = c.search(&o);
        assert_eq!(
            r.matches.iter().map(|row| row.path.as_str()).collect::<Vec<_>>(),
            ["alias/b.ts", "alias/nested/a.ts", "alias/z.ts"]
        );
        assert_eq!(r.files_searched, 3);
        assert_eq!(r.counts.files, 3);
        assert!(r.warnings.is_empty());
    }
    o.paths = vec![c.path("src/nested/a.ts"), c.path("alias/nested/a.ts")];
    let r = c.search(&o);
    assert_eq!(r.matches.len(), 1);
    assert_eq!(r.matches[0].path, "alias/nested/a.ts");
    assert_eq!(r.files_searched, 1);
}

#[test]
fn oversized_lexical_first_wins() {
    let c = Corpus::new();
    let mut large = vec![b'x'; PREFIX + 100];
    large[..7].copy_from_slice(b"needle\n");
    c.put("a-large.txt", large);
    c.put("z-small.txt", "needle\n");
    let mut o = c.options();
    o.max_count = Some(1);
    let r = c.search(&o);
    assert_eq!(r.matches[0].path, "a-large.txt", "large files cannot be deferred");
    assert_eq!(r.prefix_searched, 1);
    assert!(r.limit_reached);
}

#[test]
fn exact_cap_is_not_overflow() {
    let c = Corpus::new();
    c.put("a.ts", "needle\nneedle\n");
    let mut o = c.options();
    o.max_count = Some(2);
    o.max_count_per_file = Some(2);
    let r = c.search(&o);
    assert!(!r.limit_reached, "exact global cap is not overflow");
    assert!(!r.per_file_limit_reached, "exact per-file cap is not overflow");
    assert!(r.counts.exact);
    c.put("a.ts", "needle\nneedle\nneedle\n");
    let r = c.search(&o);
    assert_eq!(r.counts.matches, Some(2));
    assert!(r.per_file_limit_reached);
    assert!(!r.counts.exact);
    o.max_count_per_file = None;
    assert!(c.search(&o).limit_reached);
    o.mode = Some(GrepMode::Files);
    o.max_count = Some(1);
    assert!(!c.search(&o).limit_reached);
    c.put("z.ts", "needle\n");
    assert!(c.search(&o).limit_reached);
    o.max_count = Some(0);
    let r = c.search(&o);
    assert_eq!(r.counts.files, 0);
    assert!(r.limit_reached);
}

#[test]
fn chunk_boundary_count_files_and_regex_options() {
    let c = Corpus::new();
    for i in (0..260).rev() {
        c.put(&format!("{i:03}.ts"), "Needle\nneedle\n");
    }
    let mut o = c.options();
    o.ignore_case = Some(true);
    o.mode = Some(GrepMode::Count);
    o.max_count = Some(257);
    let r = c.search(&o);
    assert_eq!(r.file_counts.len(), 257, "count-mode cap is matching files");
    assert_eq!(r.file_counts.last().unwrap().path, "256.ts");
    assert_eq!(r.counts.matches, Some(514));
    assert!(r.limit_reached);
    o.mode = Some(GrepMode::Files);
    let r = c.search(&o);
    assert_eq!(r.file_counts.len(), 257);
    assert_eq!(r.counts.matches, None);
    assert!(r
        .file_counts
        .iter()
        .all(|f| f.count.is_none() && !f.limit_reached));
    o.mode = Some(GrepMode::Content);
    o.max_count = Some(513);
    let r = c.search(&o);
    assert_eq!(r.matches.len(), 513);
    assert_eq!(r.matches.last().unwrap().path, "256.ts");
    assert!(r.limit_reached);
    o.max_count = None;
    o.pattern = "^needle$".into();
    assert_eq!(c.search(&o).counts.matches, Some(520));
}

#[test]
fn files_searched_counts_sorted_prefix_up_to_cap() {
    let c = Corpus::new();
    c.put("a.ts", "needle\n");
    c.put("b.ts", "no\n");
    c.put("c.ts", "needle\n");
    c.put("d.ts", "no\n");
    c.put("e.ts", "needle\n");
    c.put("f.ts", "no\n");
    c.put("nul.bin", b"needle\n\0");
    let mut o = c.options();
    o.max_count = Some(2);
    o.max_count_per_file = Some(1);
    let r = c.search(&o);
    assert_eq!(
        r.files_searched, 3,
        "cap is satisfied at c.ts, the third sorted candidate"
    );
    o.max_count = None;
    o.max_count_per_file = None;
    let r = c.search(&o);
    assert_eq!(
        r.files_searched, 7,
        "completed search counts binary-skipped candidates"
    );
    assert_eq!(r.skipped_binary, 1);
}
