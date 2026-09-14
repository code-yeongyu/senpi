use crate::cancel::{CancelToken, Checkpoint};
use crate::{GrepError, GrepOptions};
use grep_matcher::{ByteSet, LineMatchKind, LineTerminator, Match, Matcher, NoCaptures};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use std::io;

pub(crate) fn compile(options: &GrepOptions) -> Result<RegexMatcher, GrepError> {
    if options.pcre2.unwrap_or(false) {
        return Err(GrepError::UnsupportedRegex(
            "PCRE2 is not available in the native engine".into(),
        ));
    }
    if options.pattern.is_empty() {
        return Err(GrepError::InvalidPattern("pattern must not be empty".into()));
    }
    let multiline = options.multiline.unwrap_or(false);
    RegexMatcherBuilder::new()
        .case_insensitive(options.ignore_case.unwrap_or(false))
        .multi_line(multiline)
        .fixed_strings(options.literal.unwrap_or(false))
        .line_terminator(if multiline { None } else { Some(b'\n') })
        .build(&options.pattern)
        .map_err(|error| {
            // grep-regex erases the syntax error to text. Reparse only failures
            // to inspect the precise error kind/span, never to recover a pattern.
            let unsupported = match regex_syntax::ast::parse::Parser::new().parse(&options.pattern) {
                Err(syntax) => {
                    use regex_syntax::ast::ErrorKind::*;
                    match syntax.kind() {
                        UnsupportedLookAround | UnsupportedBackreference => true,
                        EscapeUnrecognized => {
                            let span = syntax.span();
                            let escape = &options.pattern[span.start.offset..span.end.offset];
                            // PCRE-only escapes, rather than typos such as \q.
                            matches!(
                                escape,
                                r"\G" | r"\K" | r"\R" | r"\X" | r"\Z" | r"\h" | r"\H" | r"\V" | r"\g" | r"\k"
                            )
                        }
                        _ => syntax.kind().to_string().contains("not supported"),
                    }
                }
                Ok(_) => error.to_string().contains("not supported"),
            };
            if unsupported {
                GrepError::UnsupportedRegex(error.to_string())
            } else {
                GrepError::InvalidPattern(error.to_string())
            }
        })
}

/// Sink callbacks alone cannot cancel a no-match scan. Check both sides of
/// every scanner operation too. One indivisible regex operation sees at most
/// the bounded 4 MiB buffer; no custom matcher or regex semantics are needed.
pub(crate) struct CheckedMatcher<'a> {
    pub inner: &'a RegexMatcher,
    pub cancel: &'a CancelToken,
}

impl Matcher for CheckedMatcher<'_> {
    type Captures = NoCaptures;
    type Error = io::Error;

    fn find_at(&self, haystack: &[u8], at: usize) -> io::Result<Option<Match>> {
        self.cancel.check(Checkpoint::Scan)?;
        let found = self.inner.find_at(haystack, at).unwrap();
        self.cancel.check(Checkpoint::Scan)?;
        Ok(found)
    }

    fn new_captures(&self) -> io::Result<NoCaptures> {
        Ok(NoCaptures::new())
    }

    fn non_matching_bytes(&self) -> Option<&ByteSet> {
        self.inner.non_matching_bytes()
    }

    fn line_terminator(&self) -> Option<LineTerminator> {
        self.inner.line_terminator()
    }

    fn find_candidate_line(&self, haystack: &[u8]) -> io::Result<Option<LineMatchKind>> {
        self.cancel.check(Checkpoint::Scan)?;
        let found = self.inner.find_candidate_line(haystack).unwrap();
        self.cancel.check(Checkpoint::Scan)?;
        Ok(found)
    }
}
