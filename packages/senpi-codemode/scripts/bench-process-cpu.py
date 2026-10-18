"""Node's native/proc CPU reader, run with the benchmark's already-required Python."""

from __future__ import annotations

import ctypes
import os
import struct
import sys
from pathlib import Path


def cpu_us(pid: int) -> float:
    """Return cumulative user+system CPU for this live process, not its group."""
    if pid <= 0:
        raise ValueError("invalid interpreter PID")
    if sys.platform == "darwin":
        library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        library.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        library.proc_pid_rusage.restype = ctypes.c_int
        library.mach_timebase_info.argtypes = [ctypes.c_void_p]
        library.mach_timebase_info.restype = ctypes.c_int
        timebase = (ctypes.c_uint32 * 2)()
        if library.mach_timebase_info(timebase) != 0 or not all(timebase):
            raise OSError("native CPU timebase unavailable")
        usage = ctypes.create_string_buffer(256)
        if library.proc_pid_rusage(pid, 2, usage) != 0:
            raise OSError(ctypes.get_errno(), "live process CPU unavailable")
        user, system = struct.unpack_from("=QQ", usage.raw, 16)
        return (user + system) * timebase[0] / timebase[1] / 1_000
    if sys.platform == "linux":
        text = Path(f"/proc/{pid}/stat").read_text()
        fields = text[text.rindex(")") + 2:].split()
        return (int(fields[11]) + int(fields[12])) * 1_000_000 / os.sysconf("SC_CLK_TCK")
    raise OSError("live process CPU accounting requires POSIX")


if __name__ == "__main__":
    print(cpu_us(int(sys.argv[1])))
