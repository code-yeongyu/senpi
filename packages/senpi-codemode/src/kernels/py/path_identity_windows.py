"""Captured Win32 primitives matching libuv's fs__realpath_handle."""
import ctypes
import ntpath
import os
import types


def windows_primitives(failure):
    library = ctypes.WinDLL("kernel32", use_last_error=True)
    create = library.CreateFileW
    create.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                       ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    create.restype = ctypes.c_void_p
    final = library.GetFinalPathNameByHandleW
    final.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32]
    final.restype = ctypes.c_uint32
    close = library.CloseHandle
    close.argtypes = [ctypes.c_void_p]
    close.restype = ctypes.c_int
    invalid = ctypes.c_void_p(-1).value
    get_error, buffer = ctypes.get_last_error, ctypes.create_unicode_buffer
    # These pure lexical helpers share a private globals dictionary, not mutable
    # ntpath/os module attributes a cell could replace.
    namespace = {**vars(ntpath), "__builtins__": __builtins__,
                 "os": types.SimpleNamespace(fspath=os.fspath, getcwd=os.getcwd)}
    for name, function in tuple(namespace.items()):
        if isinstance(function, types.FunctionType) and function.__globals__ is vars(ntpath):
            namespace[name] = types.FunctionType(function.__code__, namespace, name, function.__defaults__)
    dirname, basename, normpath, splitdrive = (
        types.FunctionType(getattr(ntpath, name).__code__, namespace, name)
        for name in ("dirname", "basename", "normpath", "splitdrive")
    )
    getcwd = os.getcwd

    def join(*parts):
        # node:path.join concatenates before normalizing; ntpath.join instead
        # discards earlier components when a later component contains a drive.
        value = "\\".join(part for part in parts if part)
        result = normpath(value)
        if value.endswith(("\\", "/")) and not result.endswith("\\"):
            result += "\\"
        return result

    def anchor(value):
        value = value.replace("/", "\\")
        # Drive-relative paths use per-drive process state in node:path.resolve;
        # device namespaces have different lexical rules. Neither is approximated.
        drive, tail = splitdrive(value)
        if drive.startswith(("\\\\?", "\\\\.")):
            raise failure("EIDENTITY_UNSUPPORTED")
        if not drive and tail.startswith("\\"):
            drive = splitdrive(getcwd())[0]
        if drive.startswith("\\\\") and not tail:
            tail = "\\"
        if not drive or not tail.startswith("\\"):
            raise failure("EIDENTITY_UNSUPPORTED")
        value = normpath(drive + tail)
        return "\\".join(part if i == 0 else part.rstrip(". ") for i, part in enumerate(value.split("\\")))

    def native_error():
        code = get_error()
        # Known libuv translations. Other Win32 failures carry no identity
        # instead of assuming Python's errno translation is the same.
        return failure({2: "ENOENT", 3: "ENOENT", 267: "ENOTDIR"}.get(code, "EIDENTITY_UNSUPPORTED"))

    def realpath(value):
        if "\0" in value:
            raise failure("ERR_INVALID_ARG_VALUE")
        handle = create(value, 0, 0, None, 3, 0x80 | 0x02000000, None)
        if handle == invalid:
            raise native_error()
        try:
            size = final(handle, None, 0, 0)
            if not size:
                raise native_error()
            result = buffer(size + 1)
            length = final(handle, result, size, 0)
            if not length or length >= size:
                raise failure("EIDENTITY_UNSUPPORTED")
            value = result.value
            if value.startswith("\\\\?\\UNC\\"):
                return "\\\\" + value[8:]
            if value.startswith("\\\\?\\"):
                return value[4:]
            raise failure("EIDENTITY_UNSUPPORTED")
        finally:
            close(handle)

    def absolute(value):
        drive, tail = splitdrive(value)
        return bool(tail.startswith(("\\", "/")) or drive.startswith("\\\\"))

    return realpath, anchor, dirname, basename, join, absolute
