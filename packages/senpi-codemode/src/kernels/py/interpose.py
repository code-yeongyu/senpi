"""Install Python API interposition before the first user statement.

Originals and grants live in this initializer's closure, never in an importable
registry. This enforces ordinary APIs, not adversarial Python introspection.
"""
import builtins
import _imp
from collections.abc import MutableMapping, MutableSequence
import contextvars
import contextlib
import glob
import importlib
import importlib.machinery
import importlib.resources
import importlib.util
import io
import _io
import os
import pathlib
import pkgutil
import shlex
import shutil
import sqlite3
import subprocess
import sys
import types
import urllib.parse
import weakref
import zipfile
from typing import Callable

__builtins__ = vars(builtins).copy()

pty = importlib.import_module("pty") if os.name == "posix" else None

_identity_path = os.path.join(os.path.dirname(__file__), "path_identity.py")
_identity_namespace = {"__builtins__": __builtins__, "__file__": _identity_path}
with open(_identity_path, "rb") as _identity_source:
    exec(compile(_identity_source.read(), _identity_path, "exec"), _identity_namespace)
create_identity = _identity_namespace["create_identity"]


def install(check, enforcing, refuse, runtime):
    identity = create_identity(runtime)
    # Private dependency references are captured before cell code can rebind modules.
    fsdecode, fspath, PathLike, getcwd = os.fsdecode, os.fspath, os.PathLike, os.getcwd
    join_path, dirname, basename, isabs = os.path.join, os.path.dirname, os.path.basename, os.path.isabs
    encode_utf8 = str.encode
    O_WRONLY, O_RDWR, O_CREAT, O_TRUNC = os.O_WRONLY, os.O_RDWR, os.O_CREAT, os.O_TRUNC
    platform_name, environment_get = os.name, os.environ.get
    quote = shlex.quote
    def join_command(args):
        return " ".join(quote(arg) for arg in args)
    getframe = sys._getframe
    resolve_name = importlib.util.resolve_name
    reference, UnsupportedOperation = weakref.ref, io.UnsupportedOperation
    urlsplit, parse_qs, unquote = urllib.parse.urlsplit, urllib.parse.parse_qs, urllib.parse.unquote
    DatabaseError = sqlite3.DatabaseError
    SQLITE_ATTACH, SQLITE_DENY, SQLITE_OK = sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DENY, sqlite3.SQLITE_OK
    native = importlib.import_module(os.name)
    os_originals = dict(vars(os))
    module_getattribute = types.ModuleType.__getattribute__
    mapping_proxy = types.MappingProxyType
    # Python helpers also resolve globals in their defining module. Freeze those
    # dictionaries, including os.path's fspath dependency, not just their names.
    function_type = types.FunctionType
    path_os = types.SimpleNamespace(fspath=fspath)
    def capture(function, **dependencies):
        function = getattr(function, "__wrapped__", function)
        captured = function_type(function.__code__, {**function.__globals__, "__builtins__": __builtins__, **dependencies},
                                 function.__name__, function.__defaults__, function.__closure__)
        captured.__kwdefaults__ = function.__kwdefaults__
        return captured
    fsdecode = capture(fsdecode, fspath=fspath)
    join_path = capture(join_path, os=path_os)
    dirname = capture(dirname, os=path_os)
    basename = capture(basename, os=path_os)
    isabs = capture(isabs, os=path_os)
    quote = capture(quote)
    resolve_name = capture(resolve_name)
    urlsplit, parse_qs, unquote = capture(urlsplit), capture(parse_qs), capture(unquote)
    grants = {}
    modules = sys.modules
    # The interpreter's own registries, never replaced: CPython's C-level import
    # (PyImport_Import) reads the interpreter's module dict rather than the
    # sys.modules attribute, so any substitute silently diverges from it and
    # modules first imported afterwards become invisible to C importers.
    # Captured here, before anything can reach a decision point, so every
    # enforced decision can re-verify them.
    meta_path, path_hooks = sys.meta_path, sys.path_hooks
    registry_entries = tuple(modules.items())
    meta_entries, path_entries = tuple(meta_path), tuple(path_hooks)
    internal = contextvars.ContextVar("senpi_operation_internal", default=False)
    engine_modules = frozenset(id(module) for module in sys.modules.values())
    import_codes = frozenset(
        function.__code__
        for module in (sys.modules["importlib._bootstrap"], sys.modules["importlib._bootstrap_external"])
        for function in vars(module).values() if isinstance(function, types.FunctionType)
    )
    original_import = builtins.__import__
    original_import_module = importlib.import_module
    original_close = os.close
    original_open = builtins.open

    def shielding():
        return False if internal.get() else enforcing()

    def intact(registry, entries):
        return len(registry) == len(entries) and all(item is entry for item, entry in zip(registry, entries))

    def active():
        # Each enforced decision re-verifies the registries: they must still be
        # the interpreter's own objects holding their captured entries. Cells
        # reach them only through the views below, which refuse; this also
        # refuses the decision when a reference obtained past those views (a
        # base descriptor such as types.ModuleType.__getattribute__) was used to
        # tamper with one, so no checked operation proceeds on a changed registry.
        if not shielding():
            return False
        if (module_getattribute(sys, "modules") is not modules
                or module_getattribute(sys, "meta_path") is not meta_path
                or module_getattribute(sys, "path_hooks") is not path_hooks
                or not all(modules.get(name) is module for name, module in registry_entries)
                or not intact(meta_path, meta_entries) or not intact(path_hooks, path_entries)):
            refuse("import registry mutation")
        return True

    def path_input(requested):
        # The written spelling travels byte-for-byte and the executed spelling is the string the OS
        # receives: the cwd-joined form of a relative path, never lexically collapsed.
        # The captured native canonicalizer supplies the same versioned identity as JS.
        try:
            encode_utf8(requested, "utf-8")
        except UnicodeEncodeError:
            refuse("operation cannot be checked")
        executed = requested if isabs(requested) else join_path(getcwd(), requested)
        return {"path": requested, "executedPath": executed, **identity(executed)}

    def path_call(tool, path, *, dir_fd=None):
        if isinstance(path, int):
            if tool == "ls":
                resource(path, "read")
                check("ls", path_input(grants[path][0]))
            else:
                resource(path, tool)
            return
        requested = fsdecode(fspath(path))
        if dir_fd is not None:
            # Relative dir-fd resolution cannot be attributed without a recorded directory.
            resource(dir_fd, "read")
            requested = join_path(grants[dir_fd][0], requested)
        check(tool, path_input(requested))

    def resource(fd, mode):
        if not active():
            return
        grant = grants.get(fd)
        handle = grant[2]() if grant is not None and len(grant) > 2 else None
        live = grant is not None and (len(grant) == 2 or (handle is not None and not handle.closed))
        if grant is None or not live or mode not in grant[1]:
            refuse(f"ungranted descriptor {fd} for {mode}")

    def modes(mode):
        if isinstance(mode, int):
            access = mode & (O_WRONLY | O_RDWR)
            return ("read", "write") if access == O_RDWR else (("write",) if access == O_WRONLY else ("read",))
        return ("read", "write") if "+" in mode else (("read",) if mode.startswith("r") else ("write",))

    def opening(path, mode, kwargs):
        allowed = modes(mode)
        if active():
            required = allowed
            if isinstance(mode, int) and mode & (O_CREAT | O_TRUNC) and "write" not in required:
                required = (*required, "write")
            for operation in required:
                path_call(operation, path, dir_fd=kwargs.get("dir_fd"))
        return allowed

    class File:
        """Retains the file interface while checking retained handles after revocation."""
        def __init__(self, value, allowed):
            self._value = value
            self._allowed = allowed
            try:
                self._fd = value.fileno()
            except UnsupportedOperation:
                self._fd = None
        def _grant(self, mode):
            if active():
                if mode not in self._allowed:
                    refuse(f"ungranted stream mode {mode}")
                if self._fd is not None:
                    resource(self._fd, mode)
        def __getattr__(self, name):
            value = getattr(self._value, name)
            if name in ("read", "read1", "readall", "readinto", "readinto1", "readline", "readlines", "peek",
                        "write", "writelines", "truncate"):
                def operation(*args, **kwargs):
                    mode = "read" if name.startswith("read") or name == "peek" else "write"
                    self._grant(mode)
                    return value(*args, **kwargs)
                return operation
            return value
        def __enter__(self):
            self._value.__enter__()
            return self
        def __exit__(self, *args):
            was_open = not self._value.closed
            try:
                return self._value.__exit__(*args)
            finally:
                if was_open:
                    grants.pop(self._fd, None)
        def __iter__(self):
            return self
        def __next__(self):
            self._grant("read")
            return next(self._value)
        def close(self):
            if not self._value.closed:
                grants.pop(self._fd, None)
            return self._value.close()

    def wrap_open(original):
        def opened(file, mode="r", *args, **kwargs):
            if not active() and not internal.get():
                return original(file, mode, *args, **kwargs)
            allowed = opening(file, mode, kwargs)
            value = original(file, mode, *args, **kwargs)
            fd = value.fileno()
            grants[fd] = (fsdecode(fspath(file)) if not isinstance(file, int) else grants.get(file, ("", ()))[0],
                          allowed, reference(value))
            # Zero-deny sessions receive the exact original object.
            if not active():
                return value
            wrapped = File(value, allowed)
            return wrapped
        return opened

    builtins.open = wrap_open(original_open)
    io.open = wrap_open(io.open)
    # Remain subclassable without putting the unguarded constructor in our MRO.
    original_fileio = io.FileIO
    class FileIO(File, io.RawIOBase):
        def __init__(self, file, mode="r", closefd=True, opener=None):
            allowed = opening(file, mode, {"opener": opener})
            value = original_fileio(file, mode, closefd, opener)
            File.__init__(self, value, allowed)
            grants[value.fileno()] = (fsdecode(fspath(file)) if not isinstance(file, int) else "", allowed,
                                      reference(value))
        @property
        def closed(self):
            return self._value.closed
    for name in ("read", "readall", "readinto", "readline", "readlines", "write", "writelines", "truncate",
                 "seek", "tell", "fileno", "flush", "isatty", "readable", "writable", "seekable"):
        def fileio_method(name):
            def wrapped(self, *args, **kwargs):
                return File.__getattr__(self, name)(*args, **kwargs)
            return wrapped
        setattr(FileIO, name, fileio_method(name))
    io.FileIO = _io.FileIO = FileIO
    _io.open = builtins.open

    original_os_open = os.open
    def os_open(path, flags, mode=0o777, *, dir_fd=None):
        if not active() and not internal.get():
            return original_os_open(path, flags, mode, dir_fd=dir_fd)
        allowed = opening(path, flags, {"dir_fd": dir_fd})
        fd = original_os_open(path, flags, mode, dir_fd=dir_fd)
        grants[fd] = (fsdecode(fspath(path)), allowed)
        return fd
    os.open = os_open
    def close(fd):
        grants.pop(fd, None)
        return original_close(fd)
    os.close = close
    for name, grant in (("read", "read"), ("write", "write"), ("readv", "read"), ("writev", "write"),
                        ("pread", "read"), ("pwrite", "write"), ("ftruncate", "write")):
        if not hasattr(os, name):
            continue
        def fd_method(original, grant):
            def wrapped(fd, *args, **kwargs):
                resource(fd, grant)
                return original(fd, *args, **kwargs)
            return wrapped
        setattr(os, name, fd_method(getattr(os, name), grant))
    original_fdopen = os.fdopen
    def fdopen(fd, *args, **kwargs):
        mode = args[0] if args else kwargs.get("mode", "r")
        for grant in modes(mode):
            resource(fd, grant)
        return original_fdopen(fd, *args, **kwargs)
    os.fdopen = fdopen

    def wrap_paths(owner, name, operations):
        original = getattr(owner, name)
        def wrapped(*args, **kwargs):
            if active():
                for index, key, tool in operations:
                    path = args[index] if len(args) > index else kwargs[key]
                    path_call(tool, path, dir_fd=kwargs.get("src_dir_fd" if index == 0 and len(operations) > 1
                                                           else "dst_dir_fd" if index == 1 else "dir_fd"))
            return original(*args, **kwargs)
        setattr(owner, name, wrapped)

    for name in ("remove", "unlink", "rmdir", "mkdir", "makedirs", "chmod", "truncate",
                 "mkfifo", "mknod", "utime", "chown", "lchown", "lchmod", "chflags", "lchflags",
                 "setxattr", "removexattr"):
        if hasattr(os, name):
            wrap_paths(os, name, [(0, "path", "write")])
    for name in ("rename", "replace", "link"):
        wrap_paths(os, name, [(0, "src", "write"), (1, "dst", "write")])
    wrap_paths(os, "symlink", [(1, "dst", "write")])
    for name in ("listdir", "scandir", "walk"):
        original = getattr(os, name)
        def listing(original):
            def wrapped(path=".", *args, **kwargs):
                if active():
                    path_call("ls", path)
                return original(path, *args, **kwargs)
            return wrapped
        setattr(os, name, listing(original))
    for name in ("copyfile", "copy", "copy2", "copymode", "copystat", "copytree"):
        wrap_paths(shutil, name, [(0, "src", "read"), (1, "dst", "write")])
    wrap_paths(shutil, "move", [(0, "src", "write"), (1, "dst", "write")])
    wrap_paths(shutil, "rmtree", [(0, "path", "write")])
    for name in ("glob", "iglob"):
        original = getattr(glob, name)
        def globbing(original):
            def wrapped(pathname, *args, **kwargs):
                if active():
                    prefix = pathname
                    for wildcard in ("*", "?", "["):
                        prefix = prefix.split(wildcard, 1)[0]
                    root = dirname(prefix) or "."
                    if kwargs.get("root_dir"):
                        root = join_path(fspath(kwargs["root_dir"]), root)
                    path_call("ls", root, dir_fd=kwargs.get("dir_fd"))
                return original(pathname, *args, **kwargs)
            return wrapped
        setattr(glob, name, globbing(original))
    for name in ("iterdir", "glob", "rglob"):
        wrap_paths(pathlib.Path, name, [(0, "self", "ls")])
    wrap_paths(pathlib.Path, "touch", [(0, "self", "write")])
    # pathlib delegates its remaining APIs to the patched io/os functions.

    def shell_command(args, shell=False, executable=None):
        if shell:
            selected_shell = executable or (environment_get("COMSPEC", "cmd.exe") if platform_name == "nt" else "/bin/sh")
            if basename(fsdecode(selected_shell)) not in ("sh", "bash", "zsh", "dash"):
                refuse("unsupported shell")
            # POSIX Popen passes sequence[0] as the -c program, the rest as shell arguments.
            return fsdecode(args if isinstance(args, (str, bytes)) else args[0])
        argv = [args] if isinstance(args, (str, bytes, PathLike)) else list(args)
        if executable is not None:
            argv[0] = executable
        return join_command([fsdecode(fspath(arg)) for arg in argv])

    def perform(original, args, kwargs):
        # Trusted implementation internals (fork/exec in os.spawn, pty, Popen) have already
        # been authorized. No user callback may run inside this region.
        scope = internal.set(True)
        try:
            return original(*args, **kwargs)
        finally:
            internal.reset(scope)

    def user_callback(callback, pipe_reader=False):
        def wrapped(*args, **kwargs):
            scope = internal.set(False)
            fd = args[0] if pipe_reader else None
            prior = grants.get(fd)
            if pipe_reader:
                grants[fd] = ("<pty>", ("read",))
            try:
                return callback(*args, **kwargs)
            finally:
                if pipe_reader:
                    if prior is None:
                        grants.pop(fd, None)
                    else:
                        grants[fd] = prior
                internal.reset(scope)
        return wrapped

    original_popen_init = subprocess.Popen.__init__
    popen_signature = __import__("inspect").signature(original_popen_init)
    def popen_init(self, *args, **kwargs):
        if not active():
            return original_popen_init(self, *args, **kwargs)
        binding = popen_signature.bind(self, *args, **kwargs)
        bound = binding.arguments
        if bound.get("preexec_fn") is not None:
            bound["preexec_fn"] = user_callback(bound["preexec_fn"])
        check("bash", {"command": shell_command(bound["args"], bound.get("shell", False), bound.get("executable"))},
              fsdecode(bound["cwd"]) if bound.get("cwd") is not None else None)
        return perform(original_popen_init, binding.args, binding.kwargs)
    subprocess.Popen.__init__ = popen_init
    for name in ("system", "popen"):
        original = getattr(os, name)
        def shell(original):
            def wrapped(command, *args, **kwargs):
                if not active():
                    return original(command, *args, **kwargs)
                if platform_name == "nt":
                    refuse("unsupported shell")
                check("bash", {"command": fsdecode(command)})
                return perform(original, (command, *args), kwargs)
            return wrapped
        setattr(os, name, shell(original))
    for name in dir(os):
        if not (name.startswith("exec") or name.startswith("spawn") or name.startswith("posix_spawn")):
            continue
        original = getattr(os, name)
        if not callable(original):
            continue
        def spawning(original, name):
            def wrapped(*args, **kwargs):
                if not active():
                    return original(*args, **kwargs)
                offset = 1 if name.startswith("spawn") else 0
                executable = args[offset]
                rest = args[offset + 1:]
                argv = rest[0] if name.startswith("posix_spawn") or name[offset + 4:offset + 5] == "v" else None
                if name.startswith("exec"):
                    argv = rest[0] if name[4] == "v" else rest[:-1] if name.endswith("e") else rest
                elif name.startswith("spawn"):
                    argv = rest[0] if name[5] == "v" else rest[:-1] if name.endswith("e") else rest
                check("bash", {"command": shell_command(argv, executable=executable)})
                return perform(original, args, kwargs)
            return wrapped
        setattr(os, name, spawning(original, name))
    if pty is not None:
        original_pty_spawn = pty.spawn
        def pty_spawn(argv, *args, **kwargs):
            if not active():
                return original_pty_spawn(argv, *args, **kwargs)
            args = tuple(user_callback(callback, True) for callback in args)
            kwargs = {name: user_callback(callback, True) for name, callback in kwargs.items()}
            check("bash", {"command": shell_command(argv)})
            return perform(original_pty_spawn, (argv, *args), kwargs)
        setattr(pty, "spawn", pty_spawn)

    def forbidden(original, capability):
        def wrapped(*args, **kwargs):
            if active():
                refuse(capability)
            return original(*args, **kwargs)
        return wrapped
    for name in ("fork", "forkpty"):
        if hasattr(os, name):
            setattr(os, name, forbidden(getattr(os, name), f"os.{name}"))
    importlib.reload = forbidden(importlib.reload, "importlib.reload")
    importlib.machinery.ExtensionFileLoader.create_module = forbidden(
        importlib.machinery.ExtensionFileLoader.create_module, "extension-module loading")
    importlib.machinery.ExtensionFileLoader.exec_module = forbidden(
        importlib.machinery.ExtensionFileLoader.exec_module, "extension-module loading")
    for name in ("create_dynamic", "exec_dynamic", "create_builtin", "exec_builtin"):
        setattr(_imp, name, forbidden(getattr(_imp, name), "extension-module loading"))
    for name in ("create_module", "exec_module"):
        setattr(importlib.machinery.BuiltinImporter, name, staticmethod(forbidden(
            getattr(importlib.machinery.BuiltinImporter, name), "extension-module loading")))
    # os re-exports native builtins; rebinding only os leaves public posix/nt aliases.
    for name, original in os_originals.items():
        wrapped = getattr(os, name)
        if wrapped is not original and getattr(native, name, None) is original:
            setattr(native, name, wrapped)

    for owner in (io, _io):
        original = owner.open_code
        def open_code(original):
            def wrapped(path):
                if active():
                    path_call("read", path)
                value = original(path)
                grants[value.fileno()] = (fsdecode(fspath(path)), ("read",), reference(value))
                return File(value, ("read",)) if active() else value
            return wrapped
        setattr(owner, "open_code", open_code(original))
    for loader in (importlib.machinery.SourceFileLoader, importlib.machinery.SourcelessFileLoader):
        wrap_paths(loader, "get_data", [(1, "path", "read")])
        original = loader.get_source
        def get_source(original):
            def wrapped(self, fullname):
                if active():
                    path_call("read", self.path)
                return original(self, fullname)
            return wrapped
        setattr(loader, "get_source", get_source(original))
    source_loader = importlib.machinery.SourceFileLoader
    original_set_data = source_loader.set_data
    cache_code = getattr(source_loader, "_cache_bytecode").__code__
    get_code = source_loader.get_code.__code__
    def set_data(self, path, data, *args, **kwargs):
        if getframe(1).f_code is cache_code and getframe(2).f_code is get_code:
            # The engine's optional bytecode cache is not a cell-requested write.
            # A direct call to set_data still crosses the ordinary write gate.
            return perform(original_set_data, (self, path, data, *args), kwargs)
        if active():
            path_call("write", path)
        return original_set_data(self, path, data, *args, **kwargs)
    source_loader.set_data = set_data

    forbidden_modules = frozenset(("ctypes", "_ctypes", "cffi", "_cffi_backend", "_posixsubprocess", "multiprocessing"))
    def inspect_import(name):
        module = modules.get(name)
        forbidden_module = name.split(".", 1)[0] in forbidden_modules
        if not forbidden_module and module is not None and id(module) in engine_modules:
            return
        if not active():
            return
        if forbidden_module:
            refuse(f"import {name}")
        if module is not None:
            path = getattr(module, "__file__", None)
            if path:
                path_call("read", path)
    def importing(name, globals=None, locals=None, fromlist=(), level=0):
        absolute = resolve_name("." * level + name, (globals or {}).get("__package__")) if level else name
        inspect_import(absolute)
        result = original_import(name, globals, locals, fromlist, level)
        # Loader checks protect uncached modules; cache hits need this import-time check.
        inspect_import(absolute)
        for child in fromlist or ():
            if child != "*" and absolute + "." + child in modules:
                inspect_import(absolute + "." + child)
        return result
    builtins.__import__ = importing
    def import_module(name, package=None):
        absolute = resolve_name(name, package) if name.startswith(".") else name
        inspect_import(absolute)
        return original_import_module(name, package)
    importlib.import_module = import_module
    original_pkg_data = pkgutil.get_data
    def pkg_data(package, resource):
        if active():
            module = original_import_module(package)
            if module.__file__ is not None:
                path_call("read", join_path(dirname(module.__file__), resource))
        return original_pkg_data(package, resource)
    pkgutil.get_data = pkg_data
    original_files = importlib.resources.files
    original_as_file = importlib.resources.as_file
    files_parameters = __import__("inspect").signature(original_files).parameters
    class Resource:
        def __init__(self, value):
            self._value = value
        def __getattr__(self, name):
            return getattr(self._value, name)
        def __fspath__(self):
            return fspath(self._value)
        def __truediv__(self, child):
            return self.joinpath(child)
        def joinpath(self, *children):
            return Resource(self._value.joinpath(*children))
        def iterdir(self):
            if active():
                path_call("ls", str(self._value))
            for child in self._value.iterdir():
                yield Resource(child)
        def read_text(self, *args, **kwargs):
            if active():
                path_call("read", str(self._value))
            return self._value.read_text(*args, **kwargs)
        def read_bytes(self):
            if active():
                path_call("read", str(self._value))
            return self._value.read_bytes()
        def open(self, mode="r", *args, **kwargs):
            if not active():
                return self._value.open(mode, *args, **kwargs)
            allowed = opening(str(self._value), mode, {})
            result = self._value.open(mode, *args, **kwargs)
            wrapped = File(result, allowed)
            if wrapped._fd is not None:
                grants[wrapped._fd] = (str(self._value), allowed, reference(result))
            return wrapped
    def files(*args, **kwargs):
        if "anchor" in files_parameters and (args[0] if args else kwargs.get("anchor", kwargs.get("package"))) is None:
            caller = getframe(1).f_globals.get("__name__")
            if args:
                args = (caller, *args[1:])
            else:
                kwargs = {**kwargs, "anchor": caller}
        value = original_files(*args, **kwargs)
        return Resource(value) if active() else value
    @contextlib.contextmanager
    def as_file(path):
        if isinstance(path, Resource):
            if active():
                path_call("read", str(path._value))
            path = path._value
        with original_as_file(path) as result:
            yield result
    importlib.resources.files = files
    importlib.resources.as_file = as_file
    for module_name in ("importlib.resources._common", "importlib.resources._functional", "importlib.resources._legacy"):
        module = sys.modules.get(module_name)
        if module is not None and hasattr(module, "files"):
            setattr(module, "files", files)

    original_connect: Callable[..., sqlite3.Connection] = sqlite3.connect
    original_connection = sqlite3.Connection
    databases = weakref.WeakKeyDictionary()
    sqlite_denied = contextvars.ContextVar("senpi_sqlite_denied", default=False)
    def database_path(database, uri):
        path = fsdecode(fspath(database))
        if path in ("", ":memory:"):
            return None, ()
        mode = None
        if uri and path.startswith("file:"):
            parsed = urlsplit(path)
            mode = parse_qs(parsed.query).get("mode", [None])[0]
            if mode == "memory":
                return None, ()
            path = unquote(parsed.path)
            if path == ":memory:":
                return None, ()
        return path, ("read",) if mode == "ro" else ("read", "write")
    class Cursor(sqlite3.Cursor):
        pass
    for name in ("execute", "executemany", "executescript", "fetchone", "fetchmany", "fetchall", "__next__"):
        def cursor_method(original):
            def wrapped(self, *args, **kwargs):
                active()
                sqlite_denied.set(False)
                try:
                    return original(self, *args, **kwargs)
                except DatabaseError:
                    if sqlite_denied.get():
                        refuse("SQLite ATTACH")
                    raise
            return wrapped
        setattr(Cursor, name, cursor_method(getattr(sqlite3.Cursor, name)))
    class Connection(original_connection):
        def __init__(self, database, *args, **kwargs):
            uri = kwargs.get("uri", args[6] if len(args) > 6 else False)
            path, allowed = database_path(database, uri)
            if active() and path is not None:
                for mode in allowed:
                    path_call(mode, path)
            super().__init__(database, *args, **kwargs)
            databases[self] = path
            self.set_authorizer(None)
        def set_authorizer(self, callback):
            def authorizer(action, *args):
                if active() and action == SQLITE_ATTACH:
                    sqlite_denied.set(True)
                    return SQLITE_DENY
                return SQLITE_OK if callback is None else callback(action, *args)
            return super().set_authorizer(authorizer)
        def cursor(self, factory=None):
            active()
            return super().cursor(factory or Cursor)
        def execute(self, *args, **kwargs):
            return self.cursor().execute(*args, **kwargs)
        def executemany(self, *args, **kwargs):
            return self.cursor().executemany(*args, **kwargs)
        def executescript(self, *args, **kwargs):
            return self.cursor().executescript(*args, **kwargs)
        def enable_load_extension(self, enabled):
            if active() and enabled:
                refuse("SQLite extension loading")
            return super().enable_load_extension(enabled)
        def load_extension(self, *args, **kwargs):
            if active():
                refuse("SQLite extension loading")
            return super().load_extension(*args, **kwargs)
        def backup(self, target, *args, **kwargs):
            if active():
                if target not in databases:
                    refuse("unattributed SQLite target")
                for database, mode in ((self, "read"), (target, "write")):
                    path = databases.get(database)
                    if path is not None:
                        path_call(mode, path)
            return super().backup(target, *args, **kwargs)
        def close(self):
            databases.pop(self, None)
            return super().close()
    def connect(database, *args, **kwargs):
        if not active():
            return original_connect(database, *args, **kwargs)
        factory = kwargs.get("factory", args[4] if len(args) > 4 else original_connection)
        if factory not in (original_connection, Connection):
            if isinstance(factory, type) and issubclass(factory, Connection):
                pass
            elif isinstance(factory, type) and issubclass(factory, original_connection):
                factory = type("PermissionConnection", (Connection, factory), {})
            else:
                # Preserve SQLite's validation/exception for an invalid factory.
                # Callable factories receive the checked constructor via their usual module binding.
                path, allowed = database_path(database, kwargs.get("uri", args[6] if len(args) > 6 else False))
                if path is not None:
                    for mode in allowed:
                        path_call(mode, path)
                return original_connect(database, *args, **kwargs)
        else:
            factory = Connection
        if len(args) > 4:
            args = (*args[:4], factory, *args[5:])
        else:
            kwargs["factory"] = factory
        return original_connect(database, *args, **kwargs)
    for namespace in (sqlite3, sys.modules["sqlite3.dbapi2"], sys.modules["_sqlite3"]):
        setattr(namespace, "connect", connect)
        setattr(namespace, "Connection", Connection)
        setattr(namespace, "Cursor", Cursor)

    def registry_mutation():
        # Import machinery writes the real registries directly, through the
        # references it reads from an import frame. A cell only ever holds one of
        # the views below, so reaching here means cell code is the writer.
        if active():
            refuse("import registry mutation")
    class Sys(types.ModuleType):
        def __getattribute__(self, name):
            value = module_getattribute(self, name)
            if self is not sys or name not in ("modules", "meta_path", "path_hooks", "__dict__") or not shielding():
                return value
            # Import machinery owns the real registries. Cells get live views
            # which have no dict/list base descriptor capable of mutating them.
            if getframe(1).f_code in import_codes:
                return value
            if name == "__dict__":
                return mapping_proxy({**value, "modules": module_view,
                                      "meta_path": meta_view, "path_hooks": path_view})
            return {"modules": module_view, "meta_path": meta_view, "path_hooks": path_view}[name]
        def __setattr__(self, name, value):
            if self is sys and name in ("modules", "meta_path", "path_hooks") and shielding():
                refuse(f"sys.{name} replacement")
            return super().__setattr__(name, value)
    class ModuleView(MutableMapping[str, object]):
        def __getitem__(self, key):
            return modules[key]
        def __iter__(self):
            return iter(modules)
        def __len__(self):
            return len(modules)
        def __setitem__(self, key, value):
            registry_mutation()
            modules[key] = value
        def __delitem__(self, key):
            registry_mutation()
            del modules[key]
        def copy(self):
            return dict(modules)
    def hook_view(hooks):
        class HookView(MutableSequence[object]):
            def __getitem__(self, key):
                return hooks[key]
            def __len__(self):
                return len(hooks)
            def __setitem__(self, key, value):
                registry_mutation()
                hooks[key] = value
            def __delitem__(self, key):
                registry_mutation()
                del hooks[key]
            def insert(self, index, value):
                registry_mutation()
                hooks.insert(index, value)
        return HookView()
    module_view, meta_view, path_view = ModuleView(), hook_view(meta_path), hook_view(path_hooks)
    setattr(sys, "__class__", Sys)
