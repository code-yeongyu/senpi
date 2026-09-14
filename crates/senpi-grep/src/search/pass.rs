use super::read::{search_one, FileResult};
use super::sink::in_context;
use crate::cancel::CancelToken;
use crate::matcher;
use crate::walk::{self, Candidate};
use crate::{GrepError, GrepFileCount, GrepMode, GrepOptions, GrepResult, GrepWarning};
use rayon::prelude::*;
use std::time::Instant;

const SEARCH_CHUNK: usize = 256;

fn committed_units(result: &GrepResult, options: &GrepOptions) -> u32 {
    if options.mode() == GrepMode::Content {
        result.counts.matches.unwrap_or(0)
    } else {
        result.counts.files
    }
}

fn commit_file(result: &mut GrepResult, mut file: FileResult, candidate: &Candidate, options: &GrepOptions) {
    result.prefix_searched += u32::from(file.prefix);
    result.skipped_oversized += u32::from(file.skipped_oversized);
    result.skipped_binary += u32::from(file.binary);
    if let Some(warning) = file.warning {
        result.warnings.push(warning);
    }
    result.per_file_limit_reached |= file.per_file_limit;
    if file.matching == 0 {
        return;
    }
    let content = options.mode() == GrepMode::Content;
    let used = if content {
        result.counts.matches.unwrap()
    } else {
        result.counts.files
    };
    let remaining = options.max_count.map_or(u32::MAX, |cap| cap.saturating_sub(used));
    let units = if content { file.matching } else { 1 };
    // The extra row/file proves overflow. Equality alone proves nothing.
    result.limit_reached = units > remaining;
    if remaining == 0 {
        return;
    }
    if content {
        let admitted = file.matching.min(remaining);
        let lines: Vec<_> = file
            .rows
            .iter()
            .filter(|row| !row.is_context)
            .take(admitted as usize)
            .map(|row| row.line)
            .collect();
        file.rows.retain(|row| {
            if row.is_context {
                in_context(
                    row.line,
                    &lines,
                    options.context_before.unwrap_or(0),
                    options.context_after.unwrap_or(0),
                )
            } else {
                lines.binary_search(&row.line).is_ok()
            }
        });
        result.matches.extend(file.rows);
        *result.counts.matches.as_mut().unwrap() += admitted;
    } else {
        let count = (options.mode() == GrepMode::Count).then_some(file.matching);
        result.file_counts.push(GrepFileCount {
            path: candidate.display.clone(),
            count,
            limit_reached: file.per_file_limit,
        });
        if let Some(total) = &mut result.counts.matches {
            *total += file.matching;
        }
    }
    result.counts.files += 1;
}

/// Synchronous Rust core. The N-API task runs this on its libuv worker; only
/// ignore and rayon create search workers. Results cross the commit boundary
/// in path order, never in worker completion order.
pub fn search(options: &GrepOptions, cancel: &CancelToken) -> Result<GrepResult, GrepError> {
    let start = Instant::now();
    if cancel.is_aborted() {
        return Err(GrepError::Aborted);
    }
    let regex = matcher::compile(options)?;
    let candidates = walk::collect(options, cancel)?;
    let mut result = GrepResult::empty(options);
    result.missing_paths = candidates.missing;
    result.warnings = candidates.warnings;
    result.timed_out = cancel.timed_out();
    let chunk_size = match options.max_count {
        Some(cap) => (cap as usize).saturating_add(1).clamp(1, SEARCH_CHUNK),
        None => SEARCH_CHUNK,
    };
    let mut cap_prefix = None;
    let mut complete_chunk_files = 0u32;
    'chunks: for chunk in candidates.files.chunks(chunk_size) {
        let files: Vec<_> = chunk
            .par_iter()
            .map(|candidate| search_one(candidate, options, &regex, cancel))
            .collect();
        let mut committed = 0u32;
        for (candidate, file) in chunk.iter().zip(files) {
            match file {
                Ok(file) => {
                    commit_file(&mut result, file, candidate, options);
                    committed += 1;
                    if cap_prefix.is_none()
                        && options
                            .max_count
                            .is_some_and(|cap| committed_units(&result, options) >= cap)
                    {
                        cap_prefix = Some(complete_chunk_files + committed);
                    }
                }
                Err(_) if cancel.is_aborted() => return Err(GrepError::Aborted),
                Err(_) if cancel.timed_out() => {
                    result.timed_out = true;
                    break 'chunks;
                }
                Err(error) => return Err(GrepError::EngineUnavailable(error.to_string())),
            }
            if result.limit_reached {
                break 'chunks;
            }
        }
        complete_chunk_files += committed;
    }
    result.files_searched = if result.timed_out {
        complete_chunk_files
    } else if result.limit_reached {
        cap_prefix.unwrap_or(complete_chunk_files)
    } else {
        candidates.files.len() as u32
    };
    if cancel.is_aborted() {
        return Err(GrepError::Aborted);
    }
    if result.timed_out {
        result.warnings.push(GrepWarning {
            path: None,
            code: "TIMEOUT".into(),
            message: "Search timed out; returning the completed ordered prefix".into(),
        });
    }
    result.counts.exact = !(result.limit_reached || result.per_file_limit_reached || result.timed_out);
    result.elapsed_ms = start.elapsed().as_millis() as f64;
    Ok(result)
}
