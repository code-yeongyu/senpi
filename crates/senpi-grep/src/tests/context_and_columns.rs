use super::corpus::Corpus;
use crate::{GrepMode, GrepResult};

fn matching_lines(result: &GrepResult) -> Vec<u32> {
    result
        .matches
        .iter()
        .filter(|row| !row.is_context)
        .map(|row| row.line)
        .collect()
}

#[test]
fn context_union_preserves_match_rows() {
    let c = Corpus::new();
    c.put("a.ts", "before\nneedle\nbetween\nneedle\nafter\nfar\nneedle\n");
    let mut o = c.options();
    o.max_count_per_file = Some(2);
    o.context_before = Some(2);
    o.context_after = Some(2);
    let r = c.search(&o);
    assert_eq!(
        matching_lines(&r),
        vec![2, 4],
        "context cannot consume match budget"
    );
    assert_eq!(
        r.matches.iter().map(|r| r.line).collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5, 6]
    );
    assert_eq!(r.counts.matches, Some(2));
    assert!(r.per_file_limit_reached);
    assert!(r
        .matches
        .iter()
        .filter(|r| r.is_context)
        .all(|r| r.column.is_none()));
    // A match that would otherwise be context remains a match, never a duplicate.
    o.max_count_per_file = None;
    o.max_count = Some(2);
    let r = c.search(&o);
    assert_eq!(matching_lines(&r), vec![2, 4]);
    assert_eq!(
        r.matches.iter().map(|r| r.line).collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5, 6]
    );
}

#[test]
fn multiline_counts_physical_lines() {
    let c = Corpus::new();
    c.put("a.ts", "lead\nstart start\nend\nstart\nend\n");
    let mut o = c.options();
    o.pattern = "start[^\\n]*\\nend".into();
    o.multiline = Some(true);
    let r = c.search(&o);
    assert_eq!(
        r.counts.matches,
        Some(4),
        "match unit is physical lines, not regex occurrences"
    );
    assert_eq!(matching_lines(&r), vec![2, 3, 4, 5]);
    o.mode = Some(GrepMode::Count);
    assert_eq!(c.search(&o).file_counts[0].count, Some(4));
    o.max_count_per_file = Some(3);
    let r = c.search(&o);
    assert_eq!(r.file_counts[0].count, Some(3));
    assert!(r.file_counts[0].limit_reached);
}

#[test]
fn utf8_columns_whitespace_and_truncation() {
    let c = Corpus::new();
    c.put(
        "unicode.ts",
        format!("{}needle  \r\n\tneedle  \r\n", "界".repeat(600)),
    );
    let mut o = c.options();
    o.max_columns = Some(500);
    let r = c.search(&o);
    assert_eq!(r.matches[0].column, Some(1801), "columns are 1-based UTF-8 bytes");
    assert_eq!(r.matches[0].text, format!("{}...", "界".repeat(500)));
    assert!(r.matches[0].truncated);
    assert_eq!(
        r.matches[1].text, "\tneedle  ",
        "only line terminators may be stripped"
    );
    assert_eq!(r.matches[1].column, Some(2));
    assert!(!r.matches[1].truncated);
}

#[test]
fn selector_filters_before_cap() {
    let c = Corpus::new();
    c.put("a.ts", "needle\nneedle\nneedle\nneedle\nneedle\n");
    let mut o = c.options();
    o.paths = vec![c.path("a.ts")];
    o.line_start = Some(3);
    o.line_end = Some(4);
    o.max_count_per_file = Some(1);
    o.max_count = Some(1);
    o.context_before = Some(5);
    o.context_after = Some(5);
    let r = c.search(&o);
    assert_eq!(
        matching_lines(&r),
        vec![3],
        "range filtering must precede either cap"
    );
    assert!(r.matches.iter().all(|r| (3..=4).contains(&r.line)));
    assert!(r.per_file_limit_reached);
    o.max_count_per_file = Some(2);
    o.max_count = Some(2);
    let r = c.search(&o);
    assert_eq!(matching_lines(&r), vec![3, 4]);
    assert!(
        r.counts.exact,
        "matches outside the selector cannot cause overflow"
    );
}

#[test]
fn column_only_on_first_line_of_multiline_match() {
    let c = Corpus::new();
    c.put("a.ts", "before\nxx start\nend\nafter\nstart\nend\n");
    let mut o = c.options();
    o.pattern = "start\\nend".into();
    o.multiline = Some(true);
    o.context_before = Some(1);
    o.context_after = Some(1);
    let r = c.search(&o);
    assert_eq!(
        r.matches.iter().map(|r| (r.line, r.column)).collect::<Vec<_>>(),
        vec![
            (1, None),
            (2, Some(4)),
            (3, None),
            (4, None),
            (5, Some(1)),
            (6, None)
        ],
        "only the first physical line of each submatch has a column"
    );
}

#[test]
fn anchor_columns_use_the_searchers_line_scope() {
    let c = Corpus::new();
    c.put("a.ts", "other\nneedle\nneedle\n");
    let mut o = c.options();
    o.pattern = "^needle$".into();
    for multiline in [false, true] {
        o.multiline = Some(multiline);
        let r = c.search(&o);
        assert_eq!(
            r.matches.iter().map(|r| r.column).collect::<Vec<_>>(),
            vec![Some(1), Some(1)],
            "anchored columns must agree with the searcher's scope; multiline={multiline}"
        );
    }
    o.pattern = r"\Aother\nneedle".into();
    let r = c.search(&o);
    assert_eq!(
        r.matches.iter().map(|r| r.column).collect::<Vec<_>>(),
        vec![Some(1), None]
    );
}

#[test]
fn trailing_carriage_return_without_lf_is_text() {
    let c = Corpus::new();
    c.put("a.ts", b"needle\r");
    assert_eq!(c.search(&c.options()).matches[0].text, "needle\r");
}
