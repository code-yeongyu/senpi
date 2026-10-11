"""Count real reader/main dispatch work with a deterministic prefilled FIFO."""
import collections
import io
import json
import queue
import runpy
import sys
import threading

namespace = runpy.run_path(sys.argv[1])
runtime = namespace["main"].__globals__
original_thread = threading.Thread


class PrefilledReader(original_thread):
    def start(self):
        super().start()
        # Finish admission before get(): count bookkeeping, not scheduler-dependent
        # condition waits. The real control reader still runs on its own thread.
        self.join(timeout=10)
        if self.is_alive():
            raise RuntimeError("control reader did not finish")


def measure(codes):
    counts = collections.Counter(
        fifo=0, queueLocks=0, queueNotifications=0, captureScopes=0, acquires=0, releases=0
    )
    frames = []

    def profile(frame, event, arg):
        if event == "c_call" and isinstance(getattr(arg, "__self__", None), queue.SimpleQueue):
            if arg.__name__ in ("put", "get"):
                counts["fifo"] += 1
        if event != "call":
            return
        name = frame.f_code.co_name
        if frame.f_globals.get("__name__") == "queue" and name in ("put", "get"):
            counts["fifo"] += 1
        caller = frame.f_back
        if caller is not None and caller.f_globals.get("__name__") == "queue":
            if name == "__enter__" and caller.f_code.co_name in ("put", "get"):
                counts["queueLocks"] += 1
            if name == "notify":
                counts["queueNotifications"] += 1
        if name == "__init__" and frame.f_globals.get("__name__") == "contextlib":
            fn = frame.f_locals.get("func")
            if getattr(fn, "__name__", None) in ("capture", "capture_streams"):
                counts["captureScopes"] += 1
        if frame.f_locals.get("self") is runtime["KERNEL_TOOL_TOKEN"]:
            if name == "acquire":
                counts["acquires"] += 1
            if name == "release":
                counts["releases"] += 1

    messages = [
        {"type": "run", "cellId": str(index), "code": code}
        for index, code in enumerate(codes)
    ] + [{"type": "close"}]
    runtime["emit"] = frames.append
    runtime["_start_parent_watch"] = lambda: None
    sys.stdin = io.StringIO("".join(json.dumps(message) + "\n" for message in messages))
    previous_stdout, previous_stderr = sys.stdout, sys.stderr
    threading.Thread = PrefilledReader
    sys.setprofile(profile)
    threading.setprofile(profile)
    try:
        runtime["main"]()
    finally:
        sys.setprofile(None)
        threading.setprofile(None)
        threading.Thread = original_thread
        sys.stdout, sys.stderr = previous_stdout, previous_stderr
    return counts, frames


overhead, _ = measure([])
codes = ["1 + 1", "raise ValueError('cell-error')", "3 + 4"]
measured, frames = measure(codes)
per_cell = {key: (value - overhead[key]) / len(codes) for key, value in measured.items()}
results = [frame for frame in frames if frame["type"] == "result"]
assert [frame["ok"] for frame in results] == [True, False, True], results
assert results[0]["valueRepr"] == "2" and results[2]["valueRepr"] == "7", results
assert runtime["KERNEL_TOOL_TOKEN"]._owner is None
assert all(stream.cell_target is None and not stream._targets for stream in runtime["KERNEL_TOOL_STREAMS"])
assert runtime["CURRENT_CELL_TOKEN"].get() is None
sys.__stdout__.write("WORK_COUNT " + json.dumps(per_cell) + "\n")
