use crate::{search, CancelToken, GrepOptions, GrepResult};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(super) const PREFIX: usize = 4 * 1024 * 1024;
static NEXT_CORPUS: AtomicUsize = AtomicUsize::new(0);

pub(super) struct Corpus(pub(super) PathBuf);

impl Corpus {
    pub(super) fn new() -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/grep-test-corpora")
            .join(format!(
                "{}-{}",
                std::process::id(),
                NEXT_CORPUS.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }

    pub(super) fn put(&self, path: &str, bytes: impl AsRef<[u8]>) {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    pub(super) fn path(&self, path: &str) -> String {
        self.0.join(path).to_str().unwrap().to_owned()
    }

    pub(super) fn options(&self) -> GrepOptions {
        GrepOptions {
            pattern: "needle".into(),
            paths: vec![self.path("")],
            cwd: self.path(""),
            ..GrepOptions::default()
        }
    }

    pub(super) fn search(&self, options: &GrepOptions) -> GrepResult {
        search(options, &CancelToken::new(options.timeout_ms)).unwrap()
    }
}

impl Drop for Corpus {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
