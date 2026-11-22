#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# How to run: uv run bench-interpreter.py RECEIPTS INTERPRETER FORWARD_SIGNALS [ARGS...]
# The benchmark invokes this dependency-free waiter with its detected Python.
"""Retain POSIX child CPU usage even when the interpreter exits mid-cell."""

from __future__ import annotations

import json
import os
import signal
import socket
import sys
from pathlib import Path
from types import FrameType


def main() -> int:
    """Forward inherited transport descriptors and record wait4 before exiting."""
    receipts, executable, forwarding, *arguments = sys.argv[1:]
    signals = {signal.SIGINT, signal.SIGTERM, signal.SIGHUP}
    prior_mask = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
    kernel_group = os.getpgrp()
    reader, writer = os.pipe()
    collector = os.fork()
    if collector == 0:
        os.close(reader)
        # The collector must survive the host's SIGKILL of the kernel group.
        os.setpgid(0, 0)
        child = os.fork()
        if child == 0:
            os.close(writer)
            os.setpgid(0, kernel_group)
            (Path(receipts) / f"started-{os.getpid()}").touch()
            _ = signal.pthread_sigmask(signal.SIG_SETMASK, prior_mask)
            os.execvp(executable, [executable, *arguments])
        with os.fdopen(writer, "w") as channel:
            _ = channel.write(f"{child}\n")
        pid, status, usage = os.wait4(child, 0)
        record = {"pid": pid, "cpuUs": round((usage.ru_utime + usage.ru_stime) * 1_000_000)}
        temporary = Path(receipts) / f"pending-{pid}.json"
        with temporary.open("w", encoding="utf-8") as output:
            json.dump(record, output)
        _ = temporary.replace(Path(receipts) / f"usage-{pid}.json")
        _announce(Path(receipts) / "receipts.sock")
        os._exit(os.waitstatus_to_exitcode(status) % 256)

    os.close(writer)
    with os.fdopen(reader) as channel:
        child = int(channel.readline())

    def forward(signum: int, _frame: FrameType | None) -> None:
        """Python signals one PID; Ruby/Julia already signal the whole group."""
        if not bool(int(forwarding)):
            return
        try:
            os.kill(child, signum)
        except ProcessLookupError:
            return

    for signum in signals:
        _ = signal.signal(signum, forward)
    _ = signal.pthread_sigmask(signal.SIG_SETMASK, prior_mask)
    _, status = os.waitpid(collector, 0)
    return os.waitstatus_to_exitcode(status) % 256


def _announce(signal_path: Path) -> None:
    """Wake the collector; it rescans every pending receipt on each connection."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as notifier:
        try:
            notifier.connect(str(signal_path))
        except (FileNotFoundError, ConnectionRefusedError):
            # The collector already closed: nobody waits, and the receipt file stays readable.
            return


if __name__ == "__main__":
    sys.exit(main())
