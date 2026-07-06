use crate::session_threads::{spawn_reader, spawn_timeout};
use crate::signals::{kill_signal, process_group, send_signal, signal_signal};
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::fmt::{Display, Formatter};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

pub type PtyResult<T> = Result<T, PtyError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyError {
    message: String,
}

impl PtyError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for PtyError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(formatter)
    }
}

impl std::error::Error for PtyError {}

impl From<std::io::Error> for PtyError {
    fn from(error: std::io::Error) -> Self {
        Self::new(error.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct PtySessionOptions {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
    pub timeout: Option<Duration>,
}

impl PtySessionOptions {
    pub fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            cols: 80,
            rows: 24,
            timeout: None,
        }
    }

    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    pub fn size(mut self, cols: u16, rows: u16) -> Self {
        self.cols = cols;
        self.rows = rows;
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyExit {
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    pub timed_out: bool,
}

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Option<Box<dyn Write + Send>>,
    child: Option<Box<dyn Child + Send + Sync>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    reader_thread: Option<JoinHandle<()>>,
    finished: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    timed_out: Arc<AtomicBool>,
    process_group: Option<i32>,
    exit: Option<PtyExit>,
}

impl PtySession {
    pub fn start(
        opts: PtySessionOptions,
        mut on_chunk: impl FnMut(&[u8]) + Send + 'static,
    ) -> PtyResult<Self> {
        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: opts.rows,
                cols: opts.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| PtyError::new(error.to_string()))?;

        let mut command = CommandBuilder::new(&opts.command);
        command.args(&opts.args);
        if let Some(cwd) = &opts.cwd {
            command.cwd(cwd);
        }
        for (key, value) in &opts.env {
            command.env(key, value);
        }

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| PtyError::new(error.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| PtyError::new(error.to_string()))?;
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| PtyError::new(error.to_string()))?;
        let killer = child.clone_killer();
        let timeout_killer = child.clone_killer();
        let process_group = process_group(&*pair.master).or_else(|| child.process_id().map(|pid| pid as i32));
        let finished = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(AtomicBool::new(false));
        let timed_out = Arc::new(AtomicBool::new(false));
        let reader_thread = spawn_reader(reader, move |chunk| on_chunk(chunk));

        if let Some(timeout) = opts.timeout {
            spawn_timeout(
                timeout,
                Arc::clone(&finished),
                Arc::clone(&cancelled),
                Arc::clone(&timed_out),
                process_group,
                timeout_killer,
            );
        }

        Ok(Self {
            master: pair.master,
            writer: Some(writer),
            child: Some(child),
            killer,
            reader_thread: Some(reader_thread),
            finished,
            cancelled,
            timed_out,
            process_group,
            exit: None,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) -> PtyResult<()> {
        if self.finished.load(Ordering::SeqCst) {
            return Err(PtyError::new("pty session is closed"));
        }
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| PtyError::new("pty session is closed"))?;
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> PtyResult<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| PtyError::new(error.to_string()))
    }

    pub fn signal(&mut self, signal: &str) -> PtyResult<()> {
        self.signal_number(signal_signal(signal)?)
    }

    pub fn kill(&mut self) -> PtyResult<()> {
        self.cancelled.store(true, Ordering::SeqCst);
        match self.signal_number(kill_signal()) {
            Ok(()) => Ok(()),
            Err(error) if error.to_string().contains("No such process") => Ok(()),
            Err(_) => self.killer.kill().map_err(PtyError::from),
        }
    }

    pub fn wait(&mut self) -> PtyResult<PtyExit> {
        if let Some(exit) = &self.exit {
            return Ok(exit.clone());
        }
        let mut child = self
            .child
            .take()
            .ok_or_else(|| PtyError::new("pty session is closed"))?;
        let status = child.wait()?;
        self.finished.store(true, Ordering::SeqCst);
        self.writer.take();
        if let Some(reader_thread) = self.reader_thread.take() {
            let _ = reader_thread.join();
        }
        let exit = PtyExit {
            exit_code: Some(status.exit_code() as i32),
            cancelled: self.cancelled.load(Ordering::SeqCst) || self.timed_out.load(Ordering::SeqCst),
            timed_out: self.timed_out.load(Ordering::SeqCst),
        };
        self.exit = Some(exit.clone());
        Ok(exit)
    }

    pub fn wait_in_background(&mut self) -> PtyResult<JoinHandle<PtyResult<PtyExit>>> {
        if let Some(exit) = &self.exit {
            let exit = exit.clone();
            return Ok(std::thread::spawn(move || Ok(exit)));
        }
        let mut child = self
            .child
            .take()
            .ok_or_else(|| PtyError::new("pty session is closed"))?;
        let finished = Arc::clone(&self.finished);
        let cancelled = Arc::clone(&self.cancelled);
        let timed_out = Arc::clone(&self.timed_out);

        Ok(std::thread::spawn(move || {
            let status = child.wait()?;
            finished.store(true, Ordering::SeqCst);
            Ok(PtyExit {
                exit_code: Some(status.exit_code() as i32),
                cancelled: cancelled.load(Ordering::SeqCst) || timed_out.load(Ordering::SeqCst),
                timed_out: timed_out.load(Ordering::SeqCst),
            })
        }))
    }

    fn signal_number(&mut self, signal: i32) -> PtyResult<()> {
        if self.finished.load(Ordering::SeqCst) {
            return Err(PtyError::new("pty session is closed"));
        }
        send_signal(self.process_group, signal, &mut *self.killer)
    }
}
