use super::sink::search_slice;
use crate::cancel::{CancelToken, Checkpoint};
use crate::walk::Candidate;
use crate::{GrepMatch, GrepOptions, GrepWarning};
use grep_regex::RegexMatcher;
use std::fs::File;
use std::io::{self, Read};

const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const READ_CHUNK: usize = 64 * 1024;

#[derive(Default)]
pub(super) struct FileResult {
    pub(super) rows: Vec<GrepMatch>,
    pub(super) matching: u32,
    pub(super) per_file_limit: bool,
    pub(super) prefix: bool,
    pub(super) skipped_oversized: bool,
    pub(super) binary: bool,
    pub(super) warning: Option<GrepWarning>,
}

fn read_prefix(file: &mut File, cancel: &CancelToken) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; READ_CHUNK];
    while bytes.len() < MAX_FILE_BYTES {
        cancel.check(Checkpoint::Read)?;
        let capacity = buffer.len().min(MAX_FILE_BYTES - bytes.len());
        let n = file.read(&mut buffer[..capacity])?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..n]);
    }
    cancel.check(Checkpoint::Read)?;
    Ok(bytes)
}

fn search_file(
    candidate: &Candidate,
    options: &GrepOptions,
    regex: &RegexMatcher,
    cancel: &CancelToken,
) -> io::Result<FileResult> {
    cancel.check(Checkpoint::BeforeRead)?;
    let mut file = File::open(&candidate.path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::other("candidate is no longer a regular file"));
    }
    let oversized = metadata.len() > MAX_FILE_BYTES as u64;
    let mut bytes = read_prefix(&mut file, cancel)?;
    // Classify the ENTIRE inspected window, including any incomplete tail.
    // A late NUL must discard earlier matches in every output mode.
    if memchr::memchr(0, &bytes).is_some() {
        return Ok(FileResult {
            binary: true,
            ..FileResult::default()
        });
    }
    if oversized {
        match memchr::memrchr(b'\n', &bytes) {
            Some(last) => bytes.truncate(last + 1),
            None => {
                return Ok(FileResult {
                    skipped_oversized: true,
                    ..FileResult::default()
                })
            }
        }
    }
    search_slice(candidate, options, regex, cancel, bytes, oversized)
}

pub(super) fn search_one(
    candidate: &Candidate,
    options: &GrepOptions,
    regex: &RegexMatcher,
    cancel: &CancelToken,
) -> io::Result<FileResult> {
    match search_file(candidate, options, regex, cancel) {
        Ok(result) => Ok(result),
        Err(error) if cancel.is_aborted() || cancel.timed_out() => Err(error),
        Err(error) => Ok(FileResult {
            skipped_oversized: candidate
                .path
                .metadata()
                .is_ok_and(|m| m.len() > MAX_FILE_BYTES as u64),
            warning: Some(GrepWarning {
                path: Some(candidate.display.clone()),
                code: "IO_ERROR".into(),
                message: error.to_string(),
            }),
            ..FileResult::default()
        }),
    }
}
