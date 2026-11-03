"""Versioned twin of shared/path-identity.mjs, with captured native primitives."""
import builtins
import errno
import os
import sys
import unicodedata

__builtins__ = vars(builtins).copy()
PATH_IDENTITY_VERSION = 1


class IdentityError(OSError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def create_identity(runtime):
    # Python's realpath is a component walker, not the native canonicalizer used
    # by Node. In particular it retains requested case on case-insensitive disks.
    platform = sys.platform
    lstat, readlink = os.lstat, os.readlink
    normalize, lower, upper = unicodedata.normalize, str.lower, str.upper
    codes = dict(errno.errorcode)
    fold_default = platform in ("darwin", "win32")
    folds = {}

    def failure(code):
        return IdentityError(code)

    def code_of(error):
        number = getattr(error, "errno", None)
        return getattr(error, "code", codes.get(number, "EUNKNOWN") if isinstance(number, int) else "EUNKNOWN")

    def absolute(value):
        return value.startswith("/")

    def anchor(value):
        if not absolute(value):
            raise failure("ERELATIVE")
        return value

    def dirname(value):
        # node:path.posix.dirname retains the separator preceding the last name.
        end = len(value.rstrip("/"))
        index = value.rfind("/", 0, end)
        if index < 0:
            return "."
        return "/" if index == 0 else value[:index]

    def basename(value):
        return value.rstrip("/").rsplit("/", 1)[-1]

    def join(*parts):
        value = "/".join(part for part in parts if part)
        names = []
        for part in value.split("/"):
            if part in ("", "."):
                continue
            if part == ".." and names and names[-1] != "..":
                names.pop()
            elif part != ".." or not value.startswith("/"):
                names.append(part)
        result = ("/" if value.startswith("/") else "") + "/".join(names)
        return (result or ".") + ("/" if value.endswith("/") and result not in ("", "/") else "")

    asset = os.path.join(os.path.dirname(__file__),
                         "path_identity_windows.py" if platform == "win32" else "path_identity_posix.py")
    namespace = {"__builtins__": __builtins__}
    try:
        with open(asset, "rb") as source:
            exec(compile(source.read(), asset, "exec"), namespace)
        if platform == "win32":
            realpath, anchor, dirname, basename, join, absolute = namespace["windows_primitives"](failure)
        else:
            realpath = namespace["native_realpath"](runtime, failure)
    except (ImportError, OSError, AttributeError):
        # No native primitives (e.g. a Python built without ctypes): send no canonical, so the host
        # falls back exactly as it does for any request without one, and the kernel still starts.
        return lambda executed: {}

    def volume_fold(existing):
        try:
            device = lstat(existing).st_dev
        except OSError:
            return fold_default
        if device in folds:
            return folds[device]
        probe = existing
        while True:
            chars = list(basename(probe))
            index = next((i for i, char in enumerate(chars) if lower(char) != upper(char)), None)
            if index is not None:
                char = chars[index]
                chars[index] = upper(char) if char == lower(char) else lower(char)
                try:
                    original = lstat(probe)
                    variant = lstat(join(dirname(probe), "".join(chars)))
                    answer = (original.st_dev, original.st_ino) == (variant.st_dev, variant.st_ino)
                except OSError:
                    answer = False
                break
            parent = dirname(probe)
            if parent == probe:
                answer = fold_default
                break
            probe = parent
            try:
                same = lstat(probe).st_dev == device
            except OSError:
                same = False
            if not same:
                answer = fold_default
                break
        folds[device] = answer
        return answer

    def canonical(executed):
        existing, missing, hops, followed = anchor(executed), [], 0, False
        while True:
            try:
                real = realpath(existing)
            except OSError as error:
                code = code_of(error)
                if code not in ("ENOENT", "ENOTDIR"):
                    raise failure(code)
                try:
                    info = lstat(existing)
                except OSError as inner:
                    if code_of(inner) not in ("ENOENT", "ENOTDIR"):
                        raise failure(code_of(inner))
                    info = None
                if info is not None and info.st_mode & 0o170000 == 0o120000:
                    hops += 1
                    if hops > 40:
                        raise failure("ELOOP")
                    target = readlink(existing)
                    existing = target if absolute(target) else join(dirname(existing), target)
                    followed = True
                    continue
                if followed and missing:
                    raise failure("EDANGLING")
                missing.insert(0, basename(existing))
                parent = dirname(existing)
                if parent == existing:
                    raise failure(code)
                existing = parent
                continue
            path = join(real, *missing) if missing else real
            return {"v": PATH_IDENTITY_VERSION, "path": normalize("NFC", path) if platform == "darwin" else path,
                    "foldCase": volume_fold(real)}

    def identity(executed):
        try:
            return {"canonical": canonical(executed)}
        except UnicodeError:
            # A native filename that cannot travel as UTF-8 has no exact wire form.
            return {}
        except OSError as error:
            code = code_of(error)
            return {} if code == "EIDENTITY_UNSUPPORTED" else {"unresolvable": code}
    return identity
