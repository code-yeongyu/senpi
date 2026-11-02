use super::corpus::{Corpus, PREFIX};
use crate::GrepMode;

#[test]
fn prefix_boundary_and_binary_all_modes() {
    let c = Corpus::new();
    c.put("bin.dat", b"needle\n\0needle\n");
    let mut late = b"needle\n".to_vec();
    late.extend(vec![b'a'; 70_000]);
    late.extend(b"\n\0\nneedle\n");
    c.put("late-nul.bin", late);
    let mut large = vec![b'x'; 5 * 1024 * 1024];
    large[100..107].copy_from_slice(b"needle\n");
    large[4_500_000] = 0;
    large[PREFIX + 100..PREFIX + 107].copy_from_slice(b"needle\n");
    c.put("big-late-nul.txt", &large);
    // A NUL in the dropped, incomplete line is still in the inspected window.
    large[1000] = 0;
    c.put("prefix-nul.txt", &large);
    c.put("unsearchable.txt", vec![b'x'; PREFIX + 1]);
    let mut boundary = vec![b'x'; PREFIX + 100];
    boundary[..2].copy_from_slice(b"x\n");
    boundary[PREFIX - 6..PREFIX].copy_from_slice(b"needle");
    c.put("boundary.txt", boundary);
    for mode in [GrepMode::Content, GrepMode::Count, GrepMode::Files] {
        let mut o = c.options();
        o.mode = Some(mode);
        o.paths = vec![c.path("bin.dat"), c.path("late-nul.bin")];
        let r = c.search(&o);
        assert_eq!(
            r.skipped_binary, 2,
            "both early and late NULs skip entire files in {mode:?}"
        );
        assert!(r.matches.is_empty());
        assert!(r.file_counts.is_empty());
        assert_eq!(r.counts.files, 0);
        o.paths = vec![c.path("big-late-nul.txt")];
        let r = c.search(&o);
        assert_eq!(r.counts.files, 1);
        assert_eq!(r.prefix_searched, 1);
        assert_eq!(r.skipped_binary, 0);
        assert_eq!(
            r.counts.matches,
            if mode == GrepMode::Files { None } else { Some(1) }
        );
        o.paths = vec![
            c.path("prefix-nul.txt"),
            c.path("unsearchable.txt"),
            c.path("boundary.txt"),
        ];
        let r = c.search(&o);
        assert_eq!(
            r.skipped_binary, 1,
            "binary scan must precede dropping incomplete tail"
        );
        assert_eq!(r.skipped_oversized, 1);
        assert_eq!(r.prefix_searched, 1);
        assert_eq!(r.counts.files, 0, "incomplete boundary line must not match");
    }
}

#[test]
fn lossy_utf8_text() {
    let c = Corpus::new();
    c.put("latin1.txt", b"\xe9 needle  \n");
    let r = c.search(&c.options());
    assert_eq!(r.matches.len(), 1, "non-UTF-8 is text, not binary");
    assert_eq!(r.matches[0].text, "\u{fffd} needle  ");
    assert_eq!(r.matches[0].column, Some(3));
    assert_eq!(r.skipped_binary, 0);
}
