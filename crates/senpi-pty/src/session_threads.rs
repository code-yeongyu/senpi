use crate::signals::{kill_signal, send_signal};
use portable_pty::ChildKiller;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

pub(crate) fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    mut on_chunk: impl FnMut(&[u8]) + Send + 'static,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            on_chunk(&buffer[..count]);
        }
    })
}

pub(crate) fn spawn_timeout(
    timeout: Duration,
    finished: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    timed_out: Arc<AtomicBool>,
    process_group: Option<i32>,
    mut killer: Box<dyn ChildKiller + Send + Sync>,
) {
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        if finished.load(Ordering::SeqCst) {
            return;
        }
        timed_out.store(true, Ordering::SeqCst);
        cancelled.store(true, Ordering::SeqCst);
        let _ = send_signal(process_group, kill_signal(), &mut *killer);
    });
}
