use crate::cancel::{CancelToken, Checkpoint};
use crate::{GrepError, GrepOptions, GrepWarning};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::types::TypesBuilder;
use ignore::{WalkBuilder, WalkState};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug)]
pub(crate) struct Candidate {
    // Canonical identity used for both deduplication and reading.
    pub path: PathBuf,
    pub display: String,
}

#[derive(Default)]
pub(crate) struct Candidates {
    pub files: Vec<Candidate>,
    pub missing: Vec<String>,
    pub warnings: Vec<GrepWarning>,
}

struct Globs {
    include: GlobSet,
    exclude: GlobSet,
}

impl Globs {
    fn new(patterns: &[String]) -> Result<Self, GrepError> {
        let mut include = GlobSetBuilder::new();
        let mut exclude = GlobSetBuilder::new();
        for pattern in patterns {
            let (negative, pattern) = match pattern.strip_prefix('!') {
                Some(pattern) => (true, pattern),
                None => (false, pattern.as_str()),
            };
            // Slashless globs match basenames at any depth. literal_separator
            // keeps '*' from crossing '/' in path-specific globs.
            let pattern = if pattern.contains('/') {
                pattern.to_owned()
            } else {
                format!("**/{pattern}")
            };
            let pattern = if pattern.ends_with('/') {
                format!("{pattern}**")
            } else {
                pattern
            };
            let glob = GlobBuilder::new(&pattern)
                .literal_separator(true)
                .build()
                .map_err(|e| GrepError::InvalidGlob(e.to_string()))?;
            if negative {
                exclude.add(glob);
            } else {
                include.add(glob);
            }
        }
        Ok(Self {
            include: include
                .build()
                .map_err(|e| GrepError::InvalidGlob(e.to_string()))?,
            exclude: exclude
                .build()
                .map_err(|e| GrepError::InvalidGlob(e.to_string()))?,
        })
    }

    fn accepts(&self, path: &Path) -> bool {
        // Negations always win, regardless of their position in the request.
        !path.ancestors().any(|ancestor| self.exclude.is_match(ancestor))
            && (self.include.is_empty() || self.include.is_match(path))
    }
}

fn in_git(path: &Path) -> bool {
    path.components()
        .any(|part| part == Component::Normal(".git".as_ref()))
}

pub(crate) fn display_path(path: &Path, cwd: &Path) -> String {
    let path_parts: Vec<_> = path.components().collect();
    let cwd_parts: Vec<_> = cwd.components().collect();
    let common = path_parts
        .iter()
        .zip(&cwd_parts)
        .take_while(|(a, b)| a == b)
        .count();
    if common == 0 {
        return path.to_string_lossy().replace('\\', "/");
    }
    let mut relative = PathBuf::new();
    for _ in common..cwd_parts.len() {
        relative.push("..");
    }
    for part in &path_parts[common..] {
        relative.push(part);
    }
    relative.to_string_lossy().replace('\\', "/")
}

pub(crate) fn order_candidates(files: &mut Vec<Candidate>) {
    files.sort_by(|a, b| a.display.as_bytes().cmp(b.display.as_bytes()));
    // Sort by display first so each canonical identity keeps its smallest
    // alias, regardless of root order or visitor completion order.
    let mut seen = HashSet::new();
    files.retain(|file| seen.insert(file.path.clone()));
}

pub(crate) fn collect(options: &GrepOptions, cancel: &CancelToken) -> Result<Candidates, GrepError> {
    if options.paths.is_empty() || options.paths.iter().any(|path| !Path::new(path).is_absolute()) {
        return Err(GrepError::PathNotFound(
            "paths must contain at least one absolute path".into(),
        ));
    }
    if !Path::new(&options.cwd).is_absolute() {
        return Err(GrepError::PathNotFound("cwd must be absolute".into()));
    }
    let globs = Globs::new(options.glob.as_deref().unwrap_or_default())?;
    let mut types = TypesBuilder::new();
    types.add_defaults();
    if let Some(name) = &options.r#type {
        types.select(name);
    }
    let types = types.build().map_err(|e| GrepError::UnknownType(e.to_string()))?;
    let cwd = Path::new(&options.cwd);
    let mut result = Candidates::default();
    let mut roots = HashMap::new();
    let mut existing = 0;
    let mut single_file = false;
    for root in &options.paths {
        match fs::metadata(root)
            .and_then(|metadata| fs::canonicalize(root).map(|canonical| (metadata, canonical)))
        {
            Ok((metadata, canonical)) => {
                existing += 1;
                single_file = metadata.is_file();
                roots.insert(Path::new(root), canonical);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => result.missing.push(root.clone()),
            Err(error) => {
                existing += 1;
                result.warnings.push(GrepWarning {
                    path: Some(root.clone()),
                    code: "IO_ERROR".into(),
                    message: error.to_string(),
                });
            }
        }
    }
    if existing == 0 {
        return Err(GrepError::PathNotFound(options.paths.join(", ")));
    }
    if (options.line_start.is_some() || options.line_end.is_some())
        && (options.paths.len() != 1
            || !single_file
            || options.line_start == Some(0)
            || options.line_end == Some(0)
            || options.line_start.unwrap_or(1) > options.line_end.unwrap_or(u32::MAX))
    {
        return Err(GrepError::InvalidPattern(
            "line selectors require one file and an inclusive 1-based range".into(),
        ));
    }
    let files = Mutex::new(Vec::new());
    let warnings = Mutex::new(Vec::new());
    let gitignore = options.gitignore.unwrap_or(true);
    let mut builder = WalkBuilder::from_iter(roots.keys());
    builder
        .threads(std::thread::available_parallelism().map_or(1, |n| n.get()))
        .hidden(!options.hidden.unwrap_or(true))
        .git_ignore(gitignore)
        .ignore(gitignore)
        .git_global(gitignore)
        .git_exclude(gitignore)
        .require_git(false)
        .follow_links(false)
        .types(types.clone())
        .filter_entry(|entry| !in_git(entry.path()));
    builder.build_parallel().run(|| {
        Box::new(|entry| {
            if cancel.check(Checkpoint::Walk).is_err() {
                return WalkState::Quit;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    warnings.lock().unwrap().push(GrepWarning {
                        path: None,
                        code: "WALK_ERROR".into(),
                        message: error.to_string(),
                    });
                    return WalkState::Continue;
                }
            };
            // Explicit files bypass ignore/hidden rules in ignore's depth-0
            // handling, but .git, glob and type selectors still apply.
            let path = entry.path();
            if in_git(path) || !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return WalkState::Continue;
            }
            let display = display_path(path, cwd);
            if !globs.accepts(Path::new(&display)) || types.matched(path, false).is_ignore() {
                return WalkState::Continue;
            }
            // Walk depth identifies the exact root even when roots overlap.
            // With links disabled below roots, appending relative components
            // gives canonical identity without a filesystem call per file.
            let root = path.ancestors().nth(entry.depth()).unwrap();
            let mut canonical = roots[root].clone();
            canonical.extend(path.strip_prefix(root).unwrap().components());
            files.lock().unwrap().push(Candidate {
                path: canonical,
                display,
            });
            if let Some(error) = entry.error() {
                warnings.lock().unwrap().push(GrepWarning {
                    path: Some(display_path(entry.path(), cwd)),
                    code: "WALK_ERROR".into(),
                    message: error.to_string(),
                });
            }
            WalkState::Continue
        })
    });
    if cancel.is_aborted() {
        return Err(GrepError::Aborted);
    }
    result.warnings.extend(warnings.into_inner().unwrap());
    // An incomplete walk cannot establish the global lexical prefix. Return
    // no candidates on timeout rather than search an arbitrary discovered set.
    if !cancel.timed_out() {
        result.files = files.into_inner().unwrap();
        order_candidates(&mut result.files);
    }
    result.missing.sort();
    result.missing.dedup();
    result
        .warnings
        .sort_by(|a, b| (&a.path, &a.code, &a.message).cmp(&(&b.path, &b.code, &b.message)));
    Ok(result)
}
