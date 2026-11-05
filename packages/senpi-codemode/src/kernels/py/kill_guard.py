"""The kill guard for Python cells (senpi#5349, code-yeongyu/oh-my-openagent#12096).

Installed for every kernel the host starts with the guard on, independent of permission enforcement: a subprocess
call, a shell string or a signal that could reach a kill-family command is sent to the host's judge over the bridge
(`/kill_guard_check`, no permission token) before it runs, and a refusal raises PermissionError. A cheap prefilter
keeps every other call local. The host decides from this kernel's vantage (its own process group, its own pid).
"""
import builtins
import contextvars
import functools
import importlib
import json
import os
import socket
import subprocess
import time

__builtins__ = vars(builtins).copy()

KILL_FAMILY = frozenset(("kill", "pkill", "killall"))
SHELLS = frozenset(("sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "yash", "posh", "fish", "csh", "tcsh",
                    "busybox"))
REACHES_KILL = KILL_FAMILY | SHELLS
# The host bounds its table read and its dry run at 2 s each; this covers both plus the round trip.
DEADLINE_SECONDS = 6.0


def install(port, protected):
    """Wraps the cell-visible process and signal APIs; `protected` is the host's protected pid list."""
    if getattr(subprocess.Popen.__init__, "__senpi_kill_guard__", False):
        return
    getpid, fsdecode, fspath, basename = os.getpid, os.fsdecode, os.fspath, os.path.basename
    dumps, loads, monotonic = json.dumps, json.loads, time.monotonic
    create_connection = socket.create_connection
    inside = contextvars.ContextVar("senpi_kill_guard_inside", default=False)
    protected = frozenset(protected)

    def ask(request):
        payload = dumps({**request, "vantagePid": getpid()}).encode()
        deadline = monotonic() + DEADLINE_SECONDS
        with create_connection(("127.0.0.1", port), timeout=DEADLINE_SECONDS) as sock:
            sock.sendall(b"POST /kill_guard_check HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n"
                         b"Content-Type: application/json\r\nContent-Length: " + str(len(payload)).encode() +
                         b"\r\n\r\n" + payload)
            response = bytearray()
            while True:
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise TimeoutError("kill guard deadline")
                sock.settimeout(remaining)
                chunk = sock.recv(16384)
                if not chunk:
                    break
                response.extend(chunk)
        header, _, body = bytes(response).partition(b"\r\n\r\n")
        if not header.startswith(b"HTTP/1.1 200 "):
            raise ValueError("kill guard HTTP failure")
        reply = loads(body.decode())
        if reply.get("ok") is not True or not isinstance(reply.get("value"), dict):
            raise ValueError("kill guard reply failure")
        return reply["value"]

    def enforce(request):
        try:
            verdict = ask(request)
        except Exception as exc:  # noqa: BROAD_EXCEPT_OK — a judge that cannot answer fails closed (amendment A8).
            raise PermissionError(
                f"[senpi:kill-guard] refused (R5 UNKNOWN): the kill guard's judge did not answer ({type(exc).__name__}). "
                'To allow broad kills, set "terminal.killGuard": "off" in your user settings.') from None
        if verdict.get("action") == "refuse":
            raise PermissionError(str(verdict.get("message")))

    def words(argv):
        return [fsdecode(fspath(arg)) for arg in argv]

    def argv_reaches_kill(argv):
        # Any element, not only argv[0]: sudo, env, timeout, nice, nohup and xargs put the kill-family command, or the
        # shell that runs one, later in argv (amendment A4). A word holding a whole command line (`env -S
        # "kill -9 -1"`, `--split-string=...`) is split by the program that reads it, so it counts too.
        return any(basename(word) in REACHES_KILL or ("kill" in word and len(word.split()) > 1) for word in argv)

    def check_shell(text):
        if "kill" in text:
            enforce({"kind": "command", "command": text})

    def check_argv(argv):
        argv = words(argv)
        if argv_reaches_kill(argv):
            enforce({"kind": "argv", "argv": argv})

    def guarded(original, check):
        @functools.wraps(original)
        def wrapped(*args, **kwargs):
            if inside.get():
                return original(*args, **kwargs)
            check(*args, **kwargs)
            scope = inside.set(True)
            try:
                return original(*args, **kwargs)
            finally:
                inside.reset(scope)
        wrapped.__senpi_kill_guard__ = True
        return wrapped

    original_popen_init = subprocess.Popen.__init__

    # Popen's documented leading parameters; the live __init__ may already be a (self, *args, **kwargs) wrapper.
    def popen_parts(_self, args, _bufsize=-1, executable=None, _stdin=None, _stdout=None, _stderr=None,
                    _preexec_fn=None, _close_fds=True, shell=False, *_rest, **_options):
        return args, executable, shell

    def check_popen(*args, **kwargs):
        command, executable, shell = popen_parts(*args, **kwargs)
        if shell:
            check_shell(fsdecode(command if isinstance(command, (str, bytes)) else command[0]))
            return
        argv = [command] if isinstance(command, (str, bytes, os.PathLike)) else list(command)
        if executable is not None:
            argv[0] = executable
        check_argv(argv)

    subprocess.Popen.__init__ = guarded(original_popen_init, check_popen)
    for name in ("system", "popen"):
        setattr(os, name, guarded(getattr(os, name), lambda command, *_args, **_kwargs: check_shell(fsdecode(command))))

    def spawning(name):
        offset = 1 if name.startswith("spawn") else 0

        def check(*args, **_kwargs):
            rest = args[offset + 1:]
            if name.startswith("posix_spawn"):
                argv = rest[0]
            else:
                letter = name[4] if name.startswith("exec") else name[5]
                argv = rest[0] if letter == "v" else rest[:-1] if name.endswith("e") else rest
            check_argv(list(argv))
        return check

    for name in dir(os):
        if name.startswith(("exec", "spawn", "posix_spawn")) and callable(getattr(os, name)):
            setattr(os, name, guarded(getattr(os, name), spawning(name)))

    def check_kill(pid, sig):
        if sig != 0 and (pid <= 0 or pid in protected):
            enforce({"kind": "signal", "target": pid, "group": False, "signal": int(sig)})

    def check_killpg(pgid, sig):
        enforce({"kind": "signal", "target": pgid, "group": True, "signal": int(sig)})

    native = importlib.import_module(os.name)
    for name, check in (("kill", check_kill), ("killpg", check_killpg)):
        if not hasattr(os, name):
            continue
        original = getattr(os, name)
        wrapped = guarded(original, check)
        setattr(os, name, wrapped)
        if getattr(native, name, None) is original:
            setattr(native, name, wrapped)
