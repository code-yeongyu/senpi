use super::corpus::Corpus;
use crate::{search, CancelToken, GrepError, GrepMode};

#[test]
fn gitignore_hidden_type_glob_parity() {
    for git in [true, false] {
        let c = Corpus::new();
        c.put("src/a.ts", "needle\r\nneedle\r\nneedle\r\n");
        c.put("src/z.ts", "needle\n");
        c.put("src/nested/deep/b.ts", "needle\n");
        c.put(".hidden/h.ts", "needle\n");
        c.put("ignored/i.ts", "needle\n");
        c.put("scratch/s.ts", "needle\n");
        c.put("notes.txt", "needle\n");
        c.put(".gitignore", "ignored/\n");
        c.put(".ignore", "scratch/\n");
        if git {
            assert!(std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(&c.0)
                .status()
                .unwrap()
                .success());
        }
        c.put(".git/private.ts", "needle\n");
        #[cfg(unix)]
        std::os::unix::fs::symlink(".", c.0.join("loop")).unwrap();
        let mut o = c.options();
        o.r#type = Some("ts".into());
        o.mode = Some(GrepMode::Files);
        let r = c.search(&o);
        assert_eq!(
            r.file_counts.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec![".hidden/h.ts", "src/a.ts", "src/nested/deep/b.ts", "src/z.ts"],
            "git={git}"
        );
        o.hidden = Some(false);
        assert_eq!(c.search(&o).counts.files, 3);
        o.gitignore = Some(false);
        assert_eq!(c.search(&o).counts.files, 5);
        o.hidden = Some(true);
        o.glob = Some(vec!["!src/z.ts".into(), "*.ts".into(), "src/z.ts".into()]);
        let r = c.search(&o);
        assert_eq!(r.counts.files, 5, "negations win even over later positive globs");
        assert!(r
            .file_counts
            .iter()
            .all(|f| f.path != "src/z.ts" && !f.path.starts_with(".git/")));
        o.gitignore = Some(true);
        o.paths = vec![c.path("ignored/i.ts")];
        assert_eq!(c.search(&o).counts.files, 1, "explicit files bypass ignores");
    }
}

#[test]
fn unsupported_regex_is_typed_error() {
    let c = Corpus::new();
    c.put("a.ts", "ab a{ (?<=a)b\n");
    let mut o = c.options();
    for pattern in ["(?<=a)b", "a(?=b)", r"(a)\1", r"\Gabc"] {
        o.pattern = pattern.into();
        assert!(
            matches!(
                search(&o, &CancelToken::new(None)),
                Err(GrepError::UnsupportedRegex(_))
            ),
            "unsupported pattern: {pattern}"
        );
    }
    for pattern in ["a{", "[", r"\q", "(abc"] {
        o.pattern = pattern.into();
        assert!(
            matches!(
                search(&o, &CancelToken::new(None)),
                Err(GrepError::InvalidPattern(_))
            ),
            "invalid pattern: {pattern}"
        );
    }
    o.pattern = "(?<=a)b".into();
    o.literal = Some(true);
    let r = c.search(&o);
    assert_eq!(r.counts.matches, Some(1));
    assert_eq!(r.effective_pattern, o.pattern);
    assert_eq!(r.pattern_kind, "literal");
    assert_eq!(r.regex_engine, "rust");
    o.pcre2 = Some(true);
    assert!(matches!(
        search(&o, &CancelToken::new(None)),
        Err(GrepError::UnsupportedRegex(_))
    ));
}

#[test]
fn missing_roots_and_invalid_filters_are_typed() {
    let c = Corpus::new();
    c.put("a.ts", "needle\n");
    let mut o = c.options();
    o.paths = vec![c.path("missing"), c.path("a.ts")];
    assert_eq!(c.search(&o).missing_paths, vec![c.path("missing")]);
    o.paths = vec![c.path("missing")];
    assert!(matches!(
        search(&o, &CancelToken::new(None)),
        Err(GrepError::PathNotFound(_))
    ));
    o.paths = vec![c.path("a.ts")];
    o.glob = Some(vec!["[".into()]);
    assert!(matches!(
        search(&o, &CancelToken::new(None)),
        Err(GrepError::InvalidGlob(_))
    ));
    o.glob = None;
    o.r#type = Some("not-a-real-type".into());
    assert!(matches!(
        search(&o, &CancelToken::new(None)),
        Err(GrepError::UnknownType(_))
    ));
}

#[test]
fn directory_globs_apply_to_descendants() {
    let c = Corpus::new();
    c.put("src/a.ts", "needle\n");
    c.put("src/nested/b.ts", "needle\n");
    let mut o = c.options();
    for exclude in ["!nested", "!src/nested", "!src/nested/"] {
        o.glob = Some(vec!["*.ts".into(), exclude.into()]);
        let r = c.search(&o);
        assert_eq!(r.counts.files, 1, "excluded directory: {exclude}");
        assert_eq!(r.matches[0].path, "src/a.ts");
    }
}
