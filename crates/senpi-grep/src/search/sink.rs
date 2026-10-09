use super::read::FileResult;
use crate::cancel::{CancelToken, Checkpoint};
use crate::matcher::CheckedMatcher;
use crate::walk::Candidate;
use crate::{GrepMatch, GrepMode, GrepOptions};
use grep_matcher::Matcher;
use grep_regex::RegexMatcher;
use grep_searcher::{BinaryDetection, MmapChoice, Searcher, SearcherBuilder, Sink, SinkContext, SinkMatch};
use std::collections::BTreeMap;
use std::io;

fn display_text(bytes: &[u8], max_columns: Option<u32>) -> (String, bool) {
    let bytes = match bytes.strip_suffix(b"\n") {
        Some(line) => line.strip_suffix(b"\r").unwrap_or(line),
        None => bytes,
    };
    let text = String::from_utf8_lossy(bytes);
    if let Some(max) = max_columns {
        if let Some((boundary, _)) = text.char_indices().nth(max as usize) {
            return (format!("{}...", &text[..boundary]), true);
        }
    }
    (text.into_owned(), false)
}

pub(super) fn in_context(line: u32, matched: &[u32], before: u32, after: u32) -> bool {
    let index = matched.partition_point(|&m| m <= line);
    (index > 0 && line - matched[index - 1] <= after)
        || (index < matched.len() && matched[index] - line <= before)
}

struct Collector<'a> {
    options: &'a GrepOptions,
    candidate: &'a Candidate,
    matcher: CheckedMatcher<'a>,
    rows: BTreeMap<u32, GrepMatch>,
    matched_lines: Vec<u32>,
    matching: u32,
    budget: u32,
    overflow: bool,
}

impl Collector<'_> {
    fn row(&self, line: u32, column: Option<u32>, bytes: &[u8], is_context: bool) -> GrepMatch {
        let (text, truncated) = display_text(bytes, self.options.max_columns);
        GrepMatch {
            path: self.candidate.display.clone(),
            line,
            column,
            text,
            is_context,
            truncated,
        }
    }

    fn context_end(&self) -> u32 {
        self.matched_lines
            .last()
            .copied()
            .unwrap_or(0)
            .saturating_add(self.options.context_after.unwrap_or(0))
    }
}

impl Sink for Collector<'_> {
    type Error = io::Error;

    fn matched(&mut self, searcher: &Searcher, mat: &SinkMatch<'_>) -> io::Result<bool> {
        self.matcher.cancel.check(Checkpoint::Sink)?;
        let lines: Vec<_> = mat.lines().collect();
        let mut starts = Vec::with_capacity(lines.len());
        let mut offset = mat.bytes_range_in_buffer().start;
        for bytes in &lines {
            starts.push(offset);
            offset += bytes.len();
        }
        let mut columns = vec![None; lines.len()];
        if self.options.mode() == GrepMode::Content {
            if searcher.multi_line_with_matcher(&self.matcher) {
                // Preserve the original buffer for multiline \A/\z anchors.
                self.matcher.find_iter_at(mat.buffer(), starts[0], |found| {
                    if found.start() >= offset {
                        return false;
                    }
                    let index = starts.partition_point(|&start| start <= found.start()) - 1;
                    columns[index].get_or_insert((found.start() - starts[index] + 1) as u32);
                    true
                })?;
            } else {
                // Line-oriented search removes its terminator before matching.
                // Reproduce that scope, including for ^/$ and \A/\z.
                let line = mat.bytes().strip_suffix(b"\n").unwrap_or(mat.bytes());
                columns[0] = self.matcher.find(line)?.map(|found| (found.start() + 1) as u32);
            }
        }
        for (index, bytes) in lines.into_iter().enumerate() {
            self.matcher.cancel.check(Checkpoint::Sink)?;
            let line = mat.line_number().unwrap() as u32 + index as u32;
            if !self.options.includes_line(line) {
                continue;
            }
            if self.matching == self.budget {
                self.overflow = true;
                // Finish the last admitted match's context window, classifying
                // later matches as omitted matches, never as context rows.
                if line > self.context_end() {
                    return Ok(false);
                }
                continue;
            }
            self.matching += 1;
            self.matched_lines.push(line);
            if self.options.mode() == GrepMode::Content {
                self.rows
                    .insert(line, self.row(line, columns[index], bytes, false));
            }
            if self.options.mode() == GrepMode::Files {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn context(&mut self, _: &Searcher, context: &SinkContext<'_>) -> io::Result<bool> {
        self.matcher.cancel.check(Checkpoint::Sink)?;
        let line = context.line_number().unwrap() as u32;
        if self.overflow && line > self.context_end() {
            return Ok(false);
        }
        if self.options.mode() == GrepMode::Content
            && self.options.includes_line(line)
            && (self.matching < self.budget || line <= self.context_end())
        {
            let row = self.row(line, None, context.bytes(), true);
            self.rows.entry(line).or_insert(row);
        }
        Ok(true)
    }
}

pub(super) fn search_slice(
    candidate: &Candidate,
    options: &GrepOptions,
    regex: &RegexMatcher,
    cancel: &CancelToken,
    bytes: Vec<u8>,
    oversized: bool,
) -> io::Result<FileResult> {
    let budget = if options.mode() == GrepMode::Files {
        1
    } else {
        let per_file = options.max_count_per_file.unwrap_or(u32::MAX);
        if options.mode() == GrepMode::Content {
            per_file.min(options.max_count.map_or(u32::MAX, |max| max.saturating_add(1)))
        } else {
            per_file
        }
    };
    let mut collector = Collector {
        options,
        candidate,
        matcher: CheckedMatcher { inner: regex, cancel },
        rows: BTreeMap::new(),
        matched_lines: Vec::new(),
        matching: 0,
        budget,
        overflow: false,
    };
    let content = options.mode() == GrepMode::Content;
    SearcherBuilder::new()
        .line_number(true)
        .before_context(if content {
            options.context_before.unwrap_or(0) as usize
        } else {
            0
        })
        .after_context(if content {
            options.context_after.unwrap_or(0) as usize
        } else {
            0
        })
        .multi_line(options.multiline.unwrap_or(false))
        .binary_detection(BinaryDetection::none())
        .memory_map(MmapChoice::never())
        .bom_sniffing(false)
        .build()
        .search_slice(CheckedMatcher { inner: regex, cancel }, &bytes, &mut collector)?;
    cancel.check(Checkpoint::Finish)?;
    collector.rows.retain(|&line, row| {
        !row.is_context
            || in_context(
                line,
                &collector.matched_lines,
                options.context_before.unwrap_or(0),
                options.context_after.unwrap_or(0),
            )
    });
    Ok(FileResult {
        rows: collector.rows.into_values().collect(),
        matching: collector.matching,
        per_file_limit: collector.overflow && options.max_count_per_file == Some(budget),
        prefix: oversized,
        ..FileResult::default()
    })
}
