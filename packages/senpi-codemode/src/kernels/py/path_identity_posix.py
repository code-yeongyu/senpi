"""Native primitives used by Node/libuv and Bun's POSIX realpath."""
import ctypes
import errno
import os
import sys


def native_realpath(runtime, failure):
    library = ctypes.CDLL(None, use_errno=True)
    native = library.realpath
    native.argtypes = [ctypes.c_char_p, ctypes.c_void_p]
    native.restype = ctypes.c_void_p
    free = library.free
    free.argtypes = [ctypes.c_void_p]
    free.restype = None
    string_at, get_errno = ctypes.string_at, ctypes.get_errno
    codes = dict(errno.errorcode)

    def realpath(value):
        if "\0" in value:
            raise failure("ERR_INVALID_ARG_VALUE")
        pointer = native(value.encode("utf-8"), None)
        if not pointer:
            raise failure(codes.get(get_errno(), "EUNKNOWN"))
        try:
            return string_at(pointer).decode("utf-8", "strict")
        finally:
            free(pointer)

    if runtime != "bun":
        return realpath
    native_open, native_close, fstat, readlink = os.open, os.close, os.fstat, os.readlink
    if sys.platform == "darwin":
        # bun-v1.4.4/src/runtime/node/node_fs.rs: open + F_GETPATH.
        fcntl = library.fcntl
        # Variadic: Darwin arm64 passes the third argument on the stack.
        fcntl.argtypes = [ctypes.c_int, ctypes.c_int]
        fcntl.restype = ctypes.c_int
        buffer = ctypes.create_string_buffer
        open_flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOCTTY

        def realpath(value):
            if "\0" in value:
                raise failure("ERR_INVALID_ARG_VALUE")
            fd = native_open(value, open_flags)
            try:
                result = buffer(1024)
                if fcntl(fd, 50, result) == -1:  # Darwin F_GETPATH
                    code = codes.get(get_errno(), "EUNKNOWN")
                    raise failure("ENAMETOOLONG" if code == "ENOSPC" else code)
                return result.value.decode("utf-8", "strict")
            finally:
                native_close(fd)
        return realpath
    if sys.platform == "linux":
        path_only = os.O_PATH

        def realpath(value):
            if "\0" in value:
                raise failure("ERR_INVALID_ARG_VALUE")
            fd = native_open(value, path_only)
            try:
                result = readlink(f"/proc/self/fd/{fd}")
                if result.endswith(" (deleted)") and fstat(fd).st_nlink == 0:
                    raise failure("ENOENT")
                result.encode("utf-8", "strict")
                return result
            finally:
                native_close(fd)
        return realpath

    def unsupported(value):
        raise failure("EIDENTITY_UNSUPPORTED")
    return unsupported
