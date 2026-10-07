from __future__ import annotations

# noqa: SIZE_OK — this dependency-free subprocess prelude must ship as one file.
import sys

# Emit before importing the stdlib graph: a cold interpreter can still be making
# progress after the former five-second total startup deadline.
sys.__stdout__.write('{"type":"status","event":{"op":"kernel-startup","stage":"stdlib-imports"}}\n')
sys.__stdout__.flush()

import ast
import asyncio  # noqa: ANYIO_OK — stdlib-only embedded kernel runner.
import base64
import codecs
import contextlib
import importlib
import gc
import inspect
import io
import json
import locale
import math
import os
import re
import signal
import subprocess
import time
import traceback
import types
import typing
import urllib.error
import urllib.request
import uuid
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import contextvars
import queue
import threading
from dataclasses import dataclass, field
from typing import Iterator
from threading import Lock, Thread
from typing import Any, Callable, Union
from urllib.parse import unquote

sys.__stdout__.write('{"type":"status","event":{"op":"kernel-startup","stage":"runtime-init"}}\n')
sys.__stdout__.flush()

CONNECTION: dict[str, Any] = {}
USER_NS: dict[str, Any] = {"__name__": "__main__", "__doc__": None, "__builtins__": __builtins__}
LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(LOOP)
EMIT_LOCK = Lock()

# Mirrors src/bridge/reserved.ts; this standalone subprocess asset cannot import TypeScript.
RESERVED_AGENT_TOOL = "__agent__"
RESERVED_OUTPUT_TOOL = "__output__"
RESERVED_SCHEMA_TOOL = "__schema__"
RESERVED_WAIT_TOOL = "__wait__"
RESERVED_HANDLE_STATUS_TOOL = "__handle_status__"
RESERVED_HANDLE_OUTPUT_TOOL = "__handle_output__"
RESERVED_HANDLE_SEND_TOOL = "__handle_send__"
RESERVED_HANDLE_CANCEL_TOOL = "__handle_cancel__"
RESERVED_PACKAGES_INSTALL_TOOL = "__packages_install__"
TIMEOUT_PAUSE_OP = "timeout-pause"
TIMEOUT_RESUME_OP = "timeout-resume"


class PreludeRuntimeError(RuntimeError):
    """Host bridge or magic execution failed, retaining its machine code."""

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class PreludeValueError(ValueError):
    """A helper received an invalid value."""


class PreludeTypeError(TypeError):
    """A helper received an invalid value type."""

_INTERNAL_URL_RE = re.compile(r"^([a-z][a-z0-9+.-]*)://(.*)$", re.IGNORECASE)
_ASSIGN_LINE_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<lhs>[A-Za-z_][A-Za-z_0-9.\[\], ]*?)\s*=\s*(?P<rhs>.+)$"
)
_SHELL_READ_CHUNK_BYTES = 8192
_SHELL_CAPTURE_MAX_BYTES = 1024 * 1024
_SHELL_CAPTURE_MAX_LINES = 3000
_SHELL_TRUNCATION_NOTICE = (
    f"[output truncated: shell helper exceeded {_SHELL_CAPTURE_MAX_BYTES} bytes "
    f"or {_SHELL_CAPTURE_MAX_LINES} lines; remaining output discarded]\n"
)
os.environ.setdefault("MPLBACKEND", "Agg")


def emit(frame: dict[str, Any]) -> None:
    encoded = json.dumps(frame, ensure_ascii=False, default=repr) + "\n"
    with EMIT_LOCK:
        sys.__stdout__.write(encoded)
        sys.__stdout__.flush()


def bridge_error(exc: BaseException) -> dict[str, str]:
    return {
        "name": type(exc).__name__,
        "message": str(exc),
        "stack": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
    }


def text(stream: str, data: str) -> None:
    if data:
        emit({"type": "text", "stream": stream, "data": data})


def b64_text(value: str) -> str:
    return base64.b64encode(value.encode("utf-8")).decode("ascii")


_IMAGE_SIGNATURES: tuple[tuple[str, int, bytes], ...] = (
    ("image/png", 0, b"\x89PNG\r\n\x1a\n"),
    ("image/jpeg", 0, b"\xff\xd8\xff"),
    ("image/gif", 0, b"GIF8"),
    ("image/webp", 8, b"WEBP"),
    ("image/bmp", 0, b"BM"),
)
_DATA_URL_RE = re.compile(r"^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$", re.DOTALL)


def _sniff_image_mime_type(data: bytes) -> str | None:
    for mime_type, offset, magic in _IMAGE_SIGNATURES:
        if data[offset : offset + len(magic)] == magic:
            return mime_type
    return None


def _image_base64(data: Any) -> tuple[str, str | None] | None:
    if isinstance(data, (bytes, bytearray)):
        raw = bytes(data)
        return base64.b64encode(raw).decode("ascii"), _sniff_image_mime_type(raw)
    if not isinstance(data, str):
        return None
    declared: str | None = None
    match = _DATA_URL_RE.match(data)
    if match:
        declared, data = match.group(1), match.group(2)
    compact = re.sub(r"\s+", "", data).replace("-", "+").replace("_", "/")
    compact += "=" * (-len(compact) % 4)
    try:
        base64.b64decode(compact, validate=True)
    except (ValueError, TypeError):
        return None
    return (compact, declared) if compact else None


def _display_image_dict(value: dict[str, Any]) -> bool:
    mime_type = value.get("mimeType")
    payload = value.get("dataBase64") if "dataBase64" in value else value.get("data")
    if not isinstance(mime_type, str) or not mime_type.startswith("image/") or payload is None:
        return False
    encoded = _image_base64(payload)
    if encoded is None:
        print(f"[display: image dropped \u2014 `data` must be base64, a data: URL, or bytes; got {type(payload).__name__}]")
        return True
    emit({"type": "display", "mimeType": mime_type, "dataBase64": encoded[0]})
    return True


def _display_tool_result(value: dict[str, Any]) -> bool:
    text, images = value.get("text"), value.get("images")
    if not isinstance(text, str) or not isinstance(images, list):
        return False
    if not all(isinstance(image, dict) and isinstance(image.get("mimeType"), str) and isinstance(image.get("dataBase64"), str) for image in images):
        return False
    if text:
        print(text)
    for image in images:
        emit({"type": "display", "mimeType": image["mimeType"], "dataBase64": image["dataBase64"]})
    return True


def _emit_display(mime_type: str, data: Any) -> None:
    if isinstance(data, (bytes, bytearray)):
        encoded = base64.b64encode(bytes(data)).decode("ascii")
    elif mime_type.startswith("image/"):
        if isinstance(data, str):
            encoded = data
        else:
            encoded = base64.b64encode(repr(data).encode("utf-8")).decode("ascii")
    elif mime_type == "application/json":
        encoded = b64_text(json.dumps(data, ensure_ascii=False, default=repr))
    else:
        encoded = b64_text(str(data))
    emit({"type": "display", "mimeType": mime_type, "dataBase64": encoded})


def _display_bundle(bundle: dict[str, Any]) -> bool:
    for mime_type in (
        "image/png",
        "image/jpeg",
        "application/json",
        "text/markdown",
        "text/html",
        "image/svg+xml",
        "text/latex",
        "text/plain",
    ):
        if mime_type in bundle:
            _emit_display(mime_type, bundle[mime_type])
            return True
    return False


def _is_matplotlib_figure(value: Any) -> bool:
    figure_module = sys.modules.get("matplotlib.figure")
    figure_class = getattr(figure_module, "Figure", None)
    if isinstance(figure_class, type) and isinstance(value, figure_class):
        return True
    value_type = type(value)
    return value_type.__module__ == "matplotlib.figure" and value_type.__name__ == "Figure"


def _matplotlib_png(value: Any) -> bytes | None:
    if not _is_matplotlib_figure(value):
        return None
    savefig = getattr(value, "savefig", None)
    if not callable(savefig):
        return None
    try:
        buffer = io.BytesIO()
        savefig(buffer, format="png", bbox_inches="tight")
        return buffer.getvalue()
    except Exception:  # noqa: BROAD_EXCEPT_OK — user-defined rendering hooks are isolated fallbacks.
        return None


def _rich_bundle(value: Any) -> dict[str, Any]:
    bundle: dict[str, Any] = {}
    mime_bundle = getattr(value, "_repr_mimebundle_", None)
    if callable(mime_bundle):
        try:
            data = mime_bundle()
            if isinstance(data, tuple):
                data = data[0]
            if isinstance(data, dict):
                bundle.update({str(key): item for key, item in data.items()})
        except Exception:  # noqa: BROAD_EXCEPT_OK — a broken repr must fall through to the next representation.
            bundle.clear()

    for attribute, mime_type in (
        ("_repr_markdown_", "text/markdown"),
        ("_repr_png_", "image/png"),
        ("_repr_jpeg_", "image/jpeg"),
        ("_repr_html_", "text/html"),
        ("_repr_json_", "application/json"),
        ("_repr_svg_", "image/svg+xml"),
        ("_repr_latex_", "text/latex"),
    ):
        if mime_type in bundle:
            continue
        representation = getattr(value, attribute, None)
        if not callable(representation):
            continue
        try:
            data = representation()
        except Exception:  # noqa: BROAD_EXCEPT_OK — a broken repr must fall through to the next representation.
            continue
        if data is not None:
            bundle[mime_type] = data

    if "image/png" not in bundle:
        figure_png = _matplotlib_png(value)
        if figure_png is not None:
            bundle["image/png"] = figure_png
    return bundle


def display(value: Any) -> None:
    if isinstance(value, dict) and (_display_tool_result(value) or _display_image_dict(value)):
        return
    if isinstance(value, (dict, list, tuple)):
        _emit_display("application/json", value)
        return
    if isinstance(value, (bytes, bytearray)):
        raw = bytes(value)
        _emit_display(_sniff_image_mime_type(raw) or "application/octet-stream", raw)
        return
    bundle = _rich_bundle(value)
    if bundle and _display_bundle(bundle):
        return
    _emit_display("text/plain", str(value))


def _status_events_enabled() -> bool:
    return CONNECTION.get("statusEvents", True) is not False


def emit_status(op: str, *, force: bool = False, **data: Any) -> None:
    if force or _status_events_enabled():
        emit({"type": "status", "event": {"op": op, **data}})


def log(message: Any) -> None:
    emit({"type": "log", "message": str(message)})


def phase(title: Any) -> None:
    emit({"type": "phase", "title": str(title)})


def env(key: str | None = None, value: str | None = None) -> Any:
    if key is None:
        items = dict(sorted(os.environ.items()))
        emit_status("env", count=len(items), keys=list(items.keys())[:20])
        return items
    if value is not None:
        os.environ[key] = value
        emit_status("env", key=key, value=value, action="set")
        return value
    resolved = os.environ.get(key)
    emit_status("env", key=key, value=resolved, action="get")
    return resolved


def _resolve_helper_path(path: str | Path) -> Path:
    if not isinstance(path, str):
        return Path(path)
    match = _INTERNAL_URL_RE.match(path)
    if not match:
        return Path(path)
    scheme = match.group(1).lower()
    roots = CONNECTION.get("localRoots")
    root = roots.get(scheme) if isinstance(roots, dict) else None
    if not isinstance(root, str) or not root:
        raise PreludeValueError(f"Protocol paths are not supported by this helper: {path}")
    relative = unquote(match.group(2).replace("\\", "/"))
    root_path = os.path.abspath(root)
    if relative == "":
        return Path(root_path)
    relative_path = Path(relative)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise PreludeValueError(f"Unsafe {scheme}:// path (absolute or traversal): {path}")
    resolved = os.path.abspath(os.path.join(root_path, relative))
    if resolved != root_path and not resolved.startswith(root_path + os.sep):
        raise PreludeValueError(f"{scheme}:// path escapes its root: {path}")
    return Path(resolved)


def read(path: str | Path, offset: int = 1, limit: int | None = None) -> str:
    target = _resolve_helper_path(path)
    data = target.read_text(encoding="utf-8")
    if offset > 1 or limit is not None:
        lines = data.splitlines(keepends=True)
        start = max(0, offset - 1)
        end = start + limit if limit is not None else len(lines)
        data = "".join(lines[start:end])
    emit_status("read", path=str(target), chars=len(data), preview=data[:500])
    return data


def write(path: str | Path, content: str) -> Path:
    target = _resolve_helper_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    emit_status("write", path=str(target), chars=len(content))
    return target


# The bridge is a loopback call: urllib's default opener would route it through a configured proxy
# (the environment everywhere, the registry on Windows), which a 127.0.0.1 request must never use.
_BRIDGE_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
# Ordinary bridge calls keep this socket timeout; only `__wait__` passes its own bound (see `_bridge_wait_post`).
_BRIDGE_SOCKET_TIMEOUT_SECONDS = 60
_WAIT_SOCKET_GRACE_SECONDS = 30


# The host's secret for the run in this context. Every host call carries it, so the host gives the call that run's
# kernel tools; copied contexts (parallel workers) keep it, plain threads do not, and the host forgets it at settle.
CURRENT_CELL_TOKEN: contextvars.ContextVar[str | None] = contextvars.ContextVar("senpi_cell_token", default=None)


def bridge_post(path: str, payload: dict[str, Any], *, socket_timeout: float | None = _BRIDGE_SOCKET_TIMEOUT_SECONDS) -> Any:
    cell_token = CURRENT_CELL_TOKEN.get()
    if path == "/call" and cell_token is not None and "cellToken" not in payload:
        payload = {**payload, "cellToken": cell_token}
    port = CONNECTION.get("port")
    token = CONNECTION.get("token")
    if not isinstance(port, int) or not isinstance(token, str):
        raise PreludeRuntimeError("Python tool bridge is not initialized")
    request_data = json.dumps(payload, ensure_ascii=False, default=repr).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=request_data,
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
        method="POST",
    )
    _guard_host_call(payload)
    emit_status(TIMEOUT_PAUSE_OP, force=True)
    try:
        with KERNEL_TOOL_TOKEN.parked():
            try:
                with _BRIDGE_OPENER.open(request, timeout=socket_timeout) as response:
                    response_data = response.read()
            except urllib.error.HTTPError as exc:
                response_data = exc.read()
    finally:
        emit_status(TIMEOUT_RESUME_OP, force=True)
    invocation = CURRENT.get()
    if invocation is not None and invocation.cancelled.is_set():
        raise Cancelled(CANCELLED_AT_PARK_POINT)

    try:
        body = json.loads(response_data.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise PreludeRuntimeError(f"Bridge returned invalid JSON: {response_data[:200]!r}") from exc
    if isinstance(body, dict) and body.get("ok") is True:
        return body.get("value")
    error = body.get("error") if isinstance(body, dict) else body
    if isinstance(error, dict):
        raise PreludeRuntimeError(str(error.get("message", error)), error.get("code"))
    raise PreludeRuntimeError(str(error))


# --- Kernel tools (`@tool`): inference, admission token, output routing, registry and serving threads. ---
# Admission is one interpreter-owner token: the main thread holds it while a cell runs and releases it only inside a
# host bridge call or while idle; a callback runs only while holding it, so a cell busy in pure computation never yields.

MCP_TOOL_NAME_MAX_LENGTH = 64
_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")
RESERVED_TOOL_NAMES = frozenset({"__agent__", "__output__", "__schema__", "defined", "undefine"})
_NONE_TYPE = type(None)


class KernelToolError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


def tool_key(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", name).replace("-", "_")


def validate_tool_name(name: Any) -> str:
    if not isinstance(name, str) or not name:
        raise KernelToolError("invalid_tool_definition", "@tool name must be a non-empty string")
    if not _NAME_RE.match(name) or len(name) > MCP_TOOL_NAME_MAX_LENGTH:
        raise KernelToolError("invalid_tool_definition", f"Kernel tool name must match MCP name grammar: {name}")
    if tool_key(name) in {tool_key(reserved) for reserved in RESERVED_TOOL_NAMES}:
        raise KernelToolError("reserved_tool_name", f"Kernel tool name is reserved: {name}")
    return name


def _resolved_hints(fn: Callable[..., Any], params: list[inspect.Parameter]) -> dict[str, Any]:
    # Only parameters shape the input schema; the return annotation may name a class defined later.
    def parameters_only() -> None: ...

    parameters_only.__annotations__ = {
        param.name: param.annotation for param in params if param.annotation is not inspect.Parameter.empty
    }
    try:
        return typing.get_type_hints(parameters_only, globalns=getattr(fn, "__globals__", None), include_extras=True)
    except Exception as exc:  # noqa: BROAD_EXCEPT_OK — any resolution failure is reported with the annotation that caused it.
        globalns = getattr(fn, "__globals__", {})
        for param in params:
            annotation = getattr(param.annotation, "__forward_arg__", param.annotation)
            if not isinstance(annotation, str):
                continue
            try:
                eval(annotation, globalns)  # noqa: S307 — the same evaluation get_type_hints performs, one annotation at a time.
            except Exception as inner:  # noqa: BROAD_EXCEPT_OK — names the annotation that failed.
                raise KernelToolError(
                    "invalid_tool_definition",
                    f"can't resolve the annotation {annotation!r} on parameter {param.name!r} ({inner}); pass schema=",
                ) from inner
        raise KernelToolError("invalid_tool_definition", f"can't resolve the type hints ({exc}); pass schema=") from exc


def _schema_for(annotation: Any, where: str) -> dict[str, Any]:
    if annotation is inspect.Parameter.empty or annotation is typing.Any:
        return {}
    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)
    if origin is typing.Annotated:
        schema = _schema_for(args[0], where)
        description = next((item for item in args[1:] if isinstance(item, str)), None)
        return {**schema, "description": description} if description is not None else schema
    if annotation is _NONE_TYPE or annotation is None:
        return {"type": "null"}
    if annotation is bool:
        return {"type": "boolean"}
    if annotation is int:
        return {"type": "integer"}
    if annotation is float:
        return {"type": "number"}
    if annotation is str:
        return {"type": "string"}
    if annotation is list or annotation is typing.List:
        return {"type": "array"}
    if annotation is dict or annotation is typing.Dict:
        return {"type": "object"}
    if origin is list:
        return {"type": "array", "items": _schema_for(args[0], where)} if args else {"type": "array"}
    if origin is dict:
        if args and args[0] is not str:
            raise KernelToolError("invalid_tool_definition", f"{where}: dict keys must be str")
        return {"type": "object", "additionalProperties": _schema_for(args[1], where)} if args else {"type": "object"}
    if origin is typing.Literal:
        if not all(isinstance(value, (str, int, float, bool)) or value is None for value in args):
            raise KernelToolError("invalid_tool_definition", f"{where}: Literal values must be JSON scalars")
        return {"enum": list(args)}
    if origin is typing.Union or origin is getattr(types, "UnionType", None):
        return {"anyOf": [_schema_for(item, where) for item in args]}
    raise KernelToolError("invalid_tool_definition", f"{where}: unsupported annotation {annotation!r}; pass schema=")


def _json_default(value: Any, where: str) -> Any:
    if callable(value):
        raise KernelToolError("invalid_tool_definition", f"{where}: default must be a JSON value, not a callable")
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise KernelToolError("invalid_tool_definition", f"{where}: default must be a JSON value ({exc})") from exc
    return value


def _description(fn: Callable[..., Any], explicit: Any) -> str:
    if explicit is not None:
        if not isinstance(explicit, str):
            raise KernelToolError("invalid_tool_definition", "@tool description must be a string")
        return explicit
    doc = inspect.getdoc(fn) or ""
    return doc.split("\n\n", 1)[0].strip()


def _signature(fn: Callable[..., Any]) -> inspect.Signature:
    # Python 3.14 evaluates annotations lazily; asking for forward references keeps a return type that names
    # a class defined later from failing here.
    try:
        import annotationlib

        return inspect.signature(fn, annotation_format=annotationlib.Format.FORWARDREF)
    except ImportError:
        return inspect.signature(fn)


def infer_tool(fn: Any, *, name: Any = None, description: Any = None, schema: Any = None) -> dict[str, Any]:
    if not callable(fn) or not hasattr(fn, "__name__"):
        raise KernelToolError("invalid_tool_definition", "@tool requires a named function")
    tool_name = validate_tool_name(fn.__name__ if name is None else name)
    params = list(_signature(fn).parameters.values())
    for param in params:
        if param.kind is inspect.Parameter.POSITIONAL_ONLY:
            raise KernelToolError("invalid_tool_definition", "positional-only parameters are not supported")
        if param.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            raise KernelToolError("invalid_tool_definition", f"*args and **kwargs are not supported ({param.name})")
    names = [param.name for param in params]
    text = _description(fn, description)
    if schema is not None:
        if not isinstance(schema, dict) or schema.get("type") != "object" or not isinstance(schema.get("properties"), dict):
            raise KernelToolError("invalid_tool_definition", "@tool schema must be a JSON object schema")
        if sorted(schema["properties"]) != sorted(names):
            raise KernelToolError("invalid_tool_definition", "@tool schema properties must match parameters")
        return {"name": tool_name, "description": text, "input_schema": schema, "params": names}
    hints = _resolved_hints(fn, params)
    properties: dict[str, Any] = {}
    required: list[str] = []
    for param in params:
        where = f"parameter {param.name!r}"
        prop = _schema_for(hints.get(param.name, param.annotation), where)
        if param.default is inspect.Parameter.empty:
            required.append(param.name)
        else:
            prop = {**prop, "default": _json_default(param.default, where)}
        properties[param.name] = prop
    input_schema: dict[str, Any] = {"type": "object", "properties": properties, "additionalProperties": False}
    if required:
        input_schema["required"] = required
    return {"name": tool_name, "description": text, "input_schema": input_schema, "params": names}


TOKEN_GROUP: contextvars.ContextVar[int | None] = contextvars.ContextVar("senpi_kernel_token_group", default=None)


def _token_key() -> int:
    group = TOKEN_GROUP.get()
    return group if group is not None else threading.get_ident()


class OwnerToken:
    """
    The right to run user code, held by the cell or one kernel tool call at a time. Its key is the thread
    that acquired it, inherited by that thread's parallel()/pipeline() workers, so a host call from any of
    them parks the token for the whole group; the group takes it back once its last host call returns.
    """

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._owner: int | None = None
        self._depth = 0
        self._parked: dict[int, list[int]] = {}

    def acquire(self) -> None:
        me = _token_key()
        with self._cond:
            while self._owner not in (None, me):
                self._cond.wait()
            self._owner = me
            self._depth += 1

    def release(self) -> None:
        with self._cond:
            if self._owner != _token_key():
                return
            self._depth -= 1
            if self._depth == 0:
                self._owner = None
                self._cond.notify_all()

    @contextlib.contextmanager
    def parked(self) -> Iterator[None]:
        me = _token_key()
        with self._cond:
            record = self._parked.get(me)
            if self._owner == me:
                self._parked[me] = [1, self._depth]
                self._owner, self._depth = None, 0
                self._cond.notify_all()
                mine = True
            elif record is not None:
                record[0] += 1
                mine = True
            else:
                mine = False
        try:
            yield
        finally:
            if mine:
                with self._cond:
                    record = self._parked[me]
                    record[0] -= 1
                    if record[0] == 0:
                        while self._owner is not None:
                            self._cond.wait()
                        del self._parked[me]
                        self._owner, self._depth = me, record[1]


class ThreadRoutedStream(io.TextIOBase):
    """sys.stdout / sys.stderr: each writer thread's text goes to the buffer it registered, else the cell's."""

    def __init__(self, stderr: bool) -> None:
        self._stderr = stderr
        self._targets: dict[int, io.StringIO] = {}
        # Followed by the parallel()/pipeline() workers a capturing thread starts (they run in a copy of its context).
        self._inherited: contextvars.ContextVar[io.StringIO | None] = contextvars.ContextVar(
            f"senpi_output_{'stderr' if stderr else 'stdout'}", default=None
        )
        self.cell_target: io.StringIO | None = None

    @contextlib.contextmanager
    def capture(self, buffer: io.StringIO, *, cell: bool) -> Iterator[None]:
        me = threading.get_ident()
        previous = self._targets.get(me)
        self._targets[me] = buffer
        inherited = self._inherited.set(buffer)
        if cell:
            self.cell_target = buffer
        try:
            yield
        finally:
            self._inherited.reset(inherited)
            if previous is None:
                self._targets.pop(me, None)
            else:
                self._targets[me] = previous
            if cell:
                self.cell_target = None

    def write(self, text: str) -> int:
        target = self._targets.get(threading.get_ident()) or self._inherited.get() or self.cell_target
        if target is None:
            return sys.__stderr__.write(text)
        return target.write(text)

    def writable(self) -> bool:
        return True

    @property
    def encoding(self) -> None:
        return None


@dataclass
class _Entry:
    name: str
    fn: Callable[..., Any]
    description: str
    input_schema: dict[str, Any]
    params: list[str]
    revision: int


class Registry:
    def __init__(self, on_change: Callable[[list[str]], None], *, disabled: bool = False) -> None:
        self._disabled = disabled
        self._lock = threading.Lock()
        self._entries: dict[str, _Entry] = {}
        # Revisions outlive undefine: a redefined name never reuses a revision an old descriptor carries.
        self._revisions: dict[str, int] = {}
        self._on_change = on_change
        self.generation = 1

    def define(self, fn: Any, *, name: Any = None, description: Any = None, schema: Any = None) -> Any:
        if self._disabled:
            raise KernelToolError("tools_unavailable", "kernel tools are turned off for this project (kernelTools.enabled is false)")
        inferred = infer_tool(fn, name=name, description=description, schema=schema)
        key = tool_key(inferred["name"])
        with self._lock:
            existing = self._entries.get(key)
            if existing is not None and existing.name != inferred["name"]:
                raise KernelToolError("tool_name_collision", f"Kernel tool name collides: {inferred['name']}")
            revision = self._revisions.get(key, 0) + 1
            self._revisions[key] = revision
            self._entries[key] = _Entry(fn=fn, revision=revision, **inferred)
            names = sorted(entry.name for entry in self._entries.values())
        self._on_change(names)
        return fn

    def undefine(self, name: Any) -> bool:
        if not isinstance(name, str):
            return False
        with self._lock:
            removed = self._entries.pop(tool_key(name), None) is not None
            names = sorted(entry.name for entry in self._entries.values())
        if removed:
            self._on_change(names)
        return removed

    def defined(self) -> list[str]:
        with self._lock:
            return sorted(entry.name for entry in self._entries.values())

    def describe(self, names: list[str]) -> list[dict[str, Any]]:
        results = []
        with self._lock:
            for name in names:
                entry = self._entries.get(tool_key(name))
                if entry is None:
                    error = {"code": "kernel_tool_missing", "message": f"Kernel tool is not defined: {name}"}
                    results.append({"name": name, "ok": False, "error": error})
                    continue
                descriptor = {"name": entry.name, "description": entry.description, "input_schema": entry.input_schema,
                              "language": "py", "kernel_generation": self.generation, "definition_revision": entry.revision}
                results.append({"name": name, "ok": True, "descriptor": descriptor})
        return results

    def resolve(self, request: dict[str, Any]) -> _Entry:
        if request.get("kernel_generation") != self.generation:
            raise KernelToolError("kernel_tool_stale", "Kernel tool descriptor generation is stale")
        with self._lock:
            entry = self._entries.get(tool_key(str(request.get("name", ""))))
        if entry is None:
            raise KernelToolError("kernel_tool_missing", f"Kernel tool is not defined: {request.get('name')}")
        if entry.revision != request.get("definition_revision"):
            raise KernelToolError("kernel_tool_stale", "Kernel tool descriptor revision is stale")
        return entry

    def is_live(self, entry: _Entry) -> bool:
        with self._lock:
            return self._entries.get(tool_key(entry.name)) is entry


class Cancelled(BaseException):
    pass


@dataclass
class Invocation:
    request_id: str
    call_id: str
    scope: Any
    cancelled: threading.Event = field(default_factory=threading.Event)
    task: tuple[asyncio.AbstractEventLoop, asyncio.Task[Any]] | None = None


CURRENT: contextvars.ContextVar[Invocation | None] = contextvars.ContextVar("senpi_kernel_tool_call", default=None)


def host_call_refusal(scope: Any, tool_name: str) -> str | None:
    tools = scope.get("tools") if isinstance(scope, dict) else None
    if not isinstance(tools, dict):
        return None
    deny, allow = tools.get("deny"), tools.get("allow")
    if deny is not None and (not isinstance(deny, list) or tool_name in deny):
        return "deny"
    if allow is not None and (not isinstance(allow, list) or tool_name not in allow):
        return "allow"
    return None


def jsonable(value: Any) -> Any:
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError):
        return repr(value)
    return value


def validate_args(schema: dict[str, Any], args: Any) -> dict[str, Any]:
    if not isinstance(args, dict):
        raise KernelToolError("invalid_tool_definition", "kernel tool args must be a JSON object")
    missing = [key for key in schema.get("required", []) if key not in args]
    if missing:
        raise KernelToolError("invalid_tool_definition", f"kernel tool args are missing: {', '.join(missing)}")
    properties = schema.get("properties", {})
    unknown = [key for key in args if key not in properties]
    if unknown:
        raise KernelToolError("invalid_tool_definition", f"kernel tool args are not parameters: {', '.join(unknown)}")
    return args


def is_coroutine_function(fn: Callable[..., Any]) -> bool:
    return inspect.iscoroutinefunction(fn)


CANCELLED_AT_PARK_POINT = "cancelled: took effect at a host park point"
CANCELLED_AT_AWAIT = "cancelled: took effect at an await point"
CANCELLED_BEFORE_START = "cancelled: the call never started"
CANCELLED_RESULT_DROPPED = "cancelled: the call finished after cancellation; its result was dropped"


class KernelToolRunner:
    """Answers describe from the reader thread and runs each invocation on its own thread under the token."""

    def __init__(
        self,
        emit: Callable[[dict[str, Any]], None],
        token: OwnerToken,
        registry: Registry,
        streams: tuple[ThreadRoutedStream, ThreadRoutedStream],
    ) -> None:
        self._emit = emit
        self._token = token
        self._registry = registry
        self._streams = streams
        self._lock = threading.Lock()
        self._invocations: dict[str, Invocation] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._closed = False

    def handle(self, message: dict[str, Any]) -> bool:
        kind = message.get("type")
        if kind == "kernel-tool-describe":
            names = [str(name) for name in message.get("names", [])]
            self._emit({"type": "kernel-tool-describe-reply", "requestId": message.get("requestId"), "ok": True,
                        "results": self._registry.describe(names)})
            return True
        if kind == "kernel-tool-invoke":
            self._start(message)
            return True
        if kind == "kernel-tool-cancel":
            self._cancel(str(message.get("requestId", "")))
            return True
        return False

    def close(self) -> None:
        with self._lock:
            self._closed = True
            pending = list(self._invocations.values())
        for invocation in pending:
            invocation.cancelled.set()

    def _start(self, message: dict[str, Any]) -> None:
        invocation = Invocation(request_id=str(message.get("requestId", "")), call_id=str(message.get("call_id", "")),
                                scope=message.get("scope"))
        with self._lock:
            if self._closed:
                self._reply_error(invocation, "tools_unavailable", "Python kernel is closing")
                return
            self._invocations[invocation.request_id] = invocation
        thread = threading.Thread(target=self._run, args=(invocation, message), name="senpi-kernel-tool", daemon=True)
        thread.start()

    def _cancel(self, request_id: str) -> None:
        with self._lock:
            invocation = self._invocations.get(request_id)
        if invocation is None:
            return
        invocation.cancelled.set()
        if invocation.task is not None:
            loop, task = invocation.task
            loop.call_soon_threadsafe(task.cancel)

    def _run(self, invocation: Invocation, message: dict[str, Any]) -> None:
        output = io.StringIO()
        try:
            entry = self._registry.resolve(message)
            args = validate_args(entry.input_schema, message.get("args"))
            self._token.acquire()
            try:
                if invocation.cancelled.is_set():
                    raise Cancelled(CANCELLED_BEFORE_START)
                CURRENT.set(invocation)
                stdout, stderr = self._streams
                with stdout.capture(output, cell=False), stderr.capture(output, cell=False):
                    value = self._call(invocation, entry.fn, args)
            finally:
                CURRENT.set(None)
                self._token.release()
            if invocation.cancelled.is_set():
                raise Cancelled(CANCELLED_RESULT_DROPPED)
            if not self._registry.is_live(entry):
                raise KernelToolError("kernel_tool_stale", "Kernel tool descriptor is stale")
            self._emit({"type": "kernel-tool-invoke-reply", "requestId": invocation.request_id, "ok": True,
                        "value": jsonable(value), **self._output_field(output)})
        except Cancelled as exc:
            self._reply_error(invocation, "kernel_tool_cancelled", str(exc), output)
        except KernelToolError as exc:
            self._reply_error(invocation, exc.code, str(exc), output, exc.details)
        except BaseException as exc:  # noqa: BROAD_EXCEPT_OK — the invocation boundary serializes the tool's own failure.
            self._reply_error(invocation, "kernel_tool_failed", f"{type(exc).__name__}: {exc}", output,
                              stack="".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
        finally:
            with self._lock:
                self._invocations.pop(invocation.request_id, None)

    def _call(self, invocation: Invocation, fn: Callable[..., Any], args: dict[str, Any]) -> Any:
        result = fn(**args)
        if not asyncio.iscoroutine(result) and not isinstance(result, asyncio.Future):
            return result
        loop = self._callback_loop()
        temporary = loop.is_running()
        if temporary:
            loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        task = loop.create_task(_awaited(result))
        invocation.task = (loop, task)
        try:
            return loop.run_until_complete(task)
        except asyncio.CancelledError as exc:
            raise Cancelled(CANCELLED_AT_AWAIT) from exc
        except RuntimeError as exc:
            if "attached to a different loop" in str(exc) or "different event loop" in str(exc):
                raise KernelToolError(
                    "kernel_tool_loop_mismatch",
                    "an awaited object belongs to another event loop (for example the parent cell's); "
                    "create it inside the tool",
                ) from exc
            raise
        finally:
            invocation.task = None
            asyncio.set_event_loop(None)
            if temporary:
                loop.close()

    def _callback_loop(self) -> asyncio.AbstractEventLoop:
        with self._lock:
            if self._loop is None or self._loop.is_closed():
                self._loop = asyncio.new_event_loop()
            return self._loop

    def _output_field(self, output: io.StringIO) -> dict[str, Any]:
        text = output.getvalue()
        return {"output": text} if text else {}

    def _reply_error(self, invocation: Invocation, code: str, message: str, output: io.StringIO | None = None,
                     details: Any = None, stack: str | None = None) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if details is not None:
            error["details"] = details
        if stack is not None:
            error["stack"] = stack
        frame: dict[str, Any] = {"type": "kernel-tool-invoke-reply", "requestId": invocation.request_id, "ok": False,
                                 "error": error}
        if output is not None:
            frame.update(self._output_field(output))
        self._emit(frame)


async def _awaited(awaitable: Any) -> Any:
    return await awaitable


KERNEL_TOOL_TOKEN = OwnerToken()
KERNEL_TOOL_STREAMS = (ThreadRoutedStream(stderr=False), ThreadRoutedStream(stderr=True))
# kernelTools.enabled is read once, while the prelude loads and before any cell runs, then removed from the
# environment: rewriting os.environ cannot turn kernel tools back on, and cell subprocesses never see the switch.
KERNEL_TOOL_REGISTRY = Registry(
    lambda names: emit({"type": "kernel-tools-defined", "names": names}),
    disabled=os.environ.pop("SENPI_CODEMODE_KERNEL_TOOLS", None) == "0",
)
KERNEL_TOOL_RUNNER = KernelToolRunner(emit, KERNEL_TOOL_TOKEN, KERNEL_TOOL_REGISTRY, KERNEL_TOOL_STREAMS)


def _prelude_tool_error(exc: KernelToolError) -> PreludeRuntimeError:
    return PreludeRuntimeError(f"{exc.code}: {exc}", exc.code)


def _guard_host_call(payload: dict[str, Any]) -> None:
    invocation = CURRENT.get()
    if invocation is None:
        return
    if invocation.cancelled.is_set():
        raise Cancelled(CANCELLED_AT_PARK_POINT)
    tool_name = payload.get("toolName")
    refusal = host_call_refusal(invocation.scope, tool_name) if isinstance(tool_name, str) else None
    if refusal is not None:
        raise KernelToolError(
            "kernel_tool_host_denied",
            f"Host tool is outside this kernel tool call's scope: {tool_name} ({refusal})",
            {"tool": tool_name, "call_id": invocation.call_id, "reason": refusal},
        )


class ToolCallable:
    __slots__ = ("_name",)

    def __init__(self, name: str) -> None:
        self._name = name

    def __repr__(self) -> str:
        return f"<tool.{self._name}>"

    def __call__(self, args: Any = None, /, **kwargs: Any) -> Any:
        if args is None:
            merged: dict[str, Any] = {}
        elif isinstance(args, dict):
            merged = dict(args)
        else:
            raise PreludeTypeError(
                f"tool.{self._name}(...) expects a dict of arguments (got {type(args).__name__})"
            )
        merged.update(kwargs)
        return bridge_post(
            "/call",
            {"callId": f"py-{uuid.uuid4()}", "toolName": self._name, "args": merged},
        )


class ToolProxy:
    __slots__ = ()

    def __call__(self, fn: Any = None, /, *, name: Any = None, description: Any = None, schema: Any = None) -> Any:
        def register(target: Any) -> Any:
            try:
                return KERNEL_TOOL_REGISTRY.define(target, name=name, description=description, schema=schema)
            except KernelToolError as exc:
                raise _prelude_tool_error(exc) from None

        return register if fn is None else register(fn)

    def defined(self) -> list[str]:
        return KERNEL_TOOL_REGISTRY.defined()

    def undefine(self, name: Any) -> bool:
        return KERNEL_TOOL_REGISTRY.undefine(name)

    def __getattr__(self, name: str) -> ToolCallable:
        if name.startswith("_"):
            raise AttributeError(name)
        return ToolCallable(name)

    def __getitem__(self, name: str) -> ToolCallable:
        return ToolCallable(name)

    def __repr__(self) -> str:
        return "<tool proxy>"


tool = ToolProxy()

JsonValue = Union[str, int, float, bool, None, list["JsonValue"], dict[str, "JsonValue"]]


def _workpool_call(args: dict[str, JsonValue]) -> dict[str, JsonValue]:
    try:
        return tool.workpool(args)
    except PreludeRuntimeError as error:
        if error.code in ("unknown_tool", "inactive_tool"):
            raise PreludeRuntimeError("No active host workpool tool", "workpool_unavailable") from error
        raise


class Workpool:
    """An opaque host identity, not a worker queue."""

    __slots__ = ("pool_id",)

    def __init__(self, pool_id: str) -> None:
        self.pool_id = pool_id

    def push(self, items: list[JsonValue]) -> dict[str, JsonValue]:
        return _workpool_call({"op": "push", "pool_id": self.pool_id, "items": items})

    def close(self) -> dict[str, JsonValue]:
        return _workpool_call({"op": "close", "pool_id": self.pool_id})

    def inspect(self) -> dict[str, JsonValue]:
        return _workpool_call({"op": "inspect", "pool_id": self.pool_id})

    def cancel(self) -> dict[str, JsonValue]:
        return _workpool_call({"op": "cancel", "pool_id": self.pool_id})


def workpool(
    agent: dict[str, JsonValue], name: str, *, mode: str | None = None, tools: list[str] | None = None
) -> Workpool:
    args: dict[str, JsonValue] = {"op": "create", "agent": agent, "name": name}
    if mode is not None:
        args["mode"] = mode
    if tools is not None:
        if not isinstance(tools, (list, tuple)) or not all(isinstance(name, str) for name in tools):
            raise PreludeRuntimeError(
                f"workpool(tools=...) takes a list of tool names; got {type(tools).__name__}", "invalid_tools"
            )
        args["tools"] = list(tools)
    result = _workpool_call(args)
    details = result.get("details")
    if isinstance(details, dict):
        error = details.get("error")
        if isinstance(error, dict):
            raise PreludeRuntimeError(str(error["message"]), str(error["code"]))
        pool_id = details.get("pool_id")
        if not result.get("hasError") and isinstance(pool_id, str) and re.fullmatch(r"wp_[0-9a-f]{32}", pool_id):
            return Workpool(pool_id)
    raise PreludeRuntimeError("Host did not return a workpool identity", "workpool_unavailable")


def completion(
    prompt: str,
    model: str = "default",
    system: str | None = None,
    schema: dict[str, Any] | None = None,
    **kwargs: Any,
) -> Any:
    options: dict[str, Any] = {}
    if model != "default":
        options["model"] = model
    options.update(kwargs)
    if system is not None:
        options["system"] = system
    if schema is not None:
        options["schema"] = schema
    response = bridge_post("/completion", {"prompt": prompt, "opts": options})
    if options.get("handle") is True:
        return handle(response)
    if not isinstance(response, dict):
        return response
    if "value" in response:
        return response["value"]
    return response.get("text", response)


def tool_schema(name: str | None = None) -> Any:
    args: dict[str, Any] = {} if name is None else {"name": name}
    return bridge_post(
        "/call",
        {"callId": f"py-{uuid.uuid4()}", "toolName": RESERVED_SCHEMA_TOOL, "args": args},
    )


class _Packages:
    """packages.install(manager, requirements, *, timeout=600): the %pip installer as a call; returns its receipt."""

    __slots__ = ()

    def install(self, manager: str, requirements: Any, *, timeout: float | None = None) -> Any:
        args: dict[str, Any] = {"manager": manager, "requirements": requirements}
        if timeout is not None:
            args["timeout"] = timeout
        # A long install must not hit the 60 s socket cap; the host bounds it by the timeout (600 s by default).
        socket_timeout = (600 if timeout is None else float(timeout)) + _WAIT_SOCKET_GRACE_SECONDS
        return bridge_post(
            "/call",
            {"callId": f"py-{uuid.uuid4()}", "toolName": RESERVED_PACKAGES_INSTALL_TOOL, "args": args},
            socket_timeout=socket_timeout,
        )


packages = _Packages()


def output(
    *ids: str,
    format: str = "raw",
    offset: int | None = None,
    limit: int | None = None,
) -> Any:
    if not ids:
        raise PreludeValueError("At least one output ID is required")
    if format not in ("raw", "tail"):
        raise PreludeValueError("output() format must be 'raw' or 'tail'")
    args: dict[str, Any] = {"ids": list(ids), "format": format}
    if offset is not None:
        args["offset"] = offset
    if limit is not None:
        args["limit"] = limit
    return bridge_post(
        "/call",
        {"callId": f"py-{uuid.uuid4()}", "toolName": RESERVED_OUTPUT_TOOL, "args": args},
    )


def agent(
    prompt: str,
    *,
    agent: str | None = "task",
    model: str | None = None,
    label: str | None = None,
    schema: dict[str, Any] | None = None,
    isolated: bool | None = None,
    apply: bool | None = None,
    merge: bool | str | None = None,
    handle: bool = False,
    tools: list[str] | None = None,
) -> Any:
    """Delegate work; isolated/apply/merge need a host that supports isolation, otherwise a warning.

    tools grants the child this kernel's @tool functions by name, as JavaScript's agent(prompt, { tools }) does.

    merge accepts "patch"/"branch" or False/True respectively. Unapplied foreground
    changes raise an error with recovery instructions. A handle returns immediately;
    await the completion notification or read task_output for the isolation result.
    """
    args: dict[str, Any] = {"prompt": prompt}
    if agent is not None:
        args["agent"] = agent
    if model is not None:
        args["model"] = model
    if label is not None:
        args["label"] = label
    if schema is not None:
        args["schema"] = schema
    if isolated is not None:
        args["isolated"] = bool(isolated)
    if apply is not None:
        args["apply"] = bool(apply)
    if merge is not None:
        args["merge"] = merge
    if handle:
        args["handle"] = True
    if tools is not None:
        if not isinstance(tools, (list, tuple)) or not all(isinstance(name, str) for name in tools):
            raise PreludeRuntimeError(f"agent(tools=...) takes a list of tool names; got {type(tools).__name__}", "invalid_tools")
        args["tools"] = list(tools)

    response = bridge_post(
        "/call",
        {"callId": f"py-{uuid.uuid4()}", "toolName": RESERVED_AGENT_TOOL, "args": args},
    )
    response_record = response if isinstance(response, dict) else {}
    text_value = response_record.get("text", response)
    parsed = response_record.get("data")
    if schema is not None and "data" not in response_record:
        parsed = json.loads(str(text_value))
    elif schema is None:
        parsed = text_value
    if not handle:
        return parsed

    agent_id = response_record.get("id")
    handle_value = response_record.get("handle")
    if handle_value is None and agent_id is not None:
        handle_value = f"agent://{agent_id}"
    node: dict[str, Any] = {
        "text": text_value,
        "output": text_value,
        "handle": handle_value,
        "id": agent_id,
        "run_epoch": response_record.get("run_epoch"),
        "agent": response_record.get("agent", agent),
    }
    if schema is not None:
        node["data"] = parsed
    details = response_record.get("details")
    if isinstance(details, dict) and "isolation" in details:
        node["details"] = {"isolation": details["isolation"]}
    for key in (
        "isolated",
        "patch_path",
        "branch_name",
        "nested_patches",
        "changes_applied",
        "isolation_summary",
    ):
        if key in response_record:
            node[key] = response_record[key]
    return node


_HANDLE_KINDS = ("agent", "completion", "workpool")
_WAIT_MODES = ("all", "any", "settled")
_HANDLE_USAGE = (
    "handle() expects an agent(..., handle=True) record, a workpool, a completion handle, "
    "or a saved {kind, id, run_epoch} reference"
)


def _handle_ref(value: Any) -> dict[str, Any]:
    if isinstance(value, HandleView):
        return dict(value.ref)
    if isinstance(value, Workpool):
        return {"kind": "workpool", "id": value.pool_id, "run_epoch": 0}
    if not isinstance(value, dict):
        raise PreludeTypeError(_HANDLE_USAGE)
    if isinstance(value.get("pool_id"), str):
        return {"kind": "workpool", "id": value["pool_id"], "run_epoch": 0}
    kind = value.get("kind")
    if kind not in _HANDLE_KINDS:
        handle_uri = value.get("handle")
        scheme = handle_uri.split("://", 1)[0] if isinstance(handle_uri, str) else None
        kind = scheme if scheme in _HANDLE_KINDS else None
    identity = value.get("id", value.get("task_id"))
    if kind is None or not isinstance(identity, str) or not identity:
        raise PreludeTypeError(_HANDLE_USAGE)
    run_epoch = value.get("run_epoch", 0 if kind == "workpool" else None)
    if isinstance(run_epoch, bool) or not isinstance(run_epoch, int) or run_epoch < 0:
        raise PreludeTypeError(f"{_HANDLE_USAGE}; run_epoch must be a non-negative integer")
    return {"kind": kind, "id": identity, "run_epoch": run_epoch}


def _handle_call(tool_name: str, args: dict[str, Any]) -> Any:
    return bridge_post("/call", {"callId": f"py-{uuid.uuid4()}", "toolName": tool_name, "args": args})


def _bridge_wait_post(args: dict[str, Any], timeout: float | None) -> Any:
    # A long-lived request: no 60 s socket cap. An explicit timeout bounds it (plus grace for the host's
    # reply); without one only the cell's own end does: SIGINT from the host (cancel, the cell's hard limit,
    # which the eval timeout can raise) interrupts the blocking read, which closes the socket and so the
    # host-side subscription.
    socket_timeout = None if timeout is None else float(timeout) + _WAIT_SOCKET_GRACE_SECONDS
    return bridge_post(
        "/call",
        {"callId": f"py-{uuid.uuid4()}", "toolName": RESERVED_WAIT_TOOL, "args": args},
        socket_timeout=socket_timeout,
    )


def wait(handles: Any, *, timeout: float | None = None, mode: str = "all") -> Any:
    """Block until the handles settle; never cancels work. See tool_schema("eval:wait")."""
    if handles is None:
        items: list[Any] = []
    elif isinstance(handles, (list, tuple)):
        items = list(handles)
    else:
        items = [handles]
    if timeout is not None and (
        isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout < 0
    ):
        raise PreludeValueError("wait() timeout must be a finite number of seconds >= 0")
    if mode not in _WAIT_MODES:
        raise PreludeValueError("wait() mode must be 'all', 'any' or 'settled'")
    args: dict[str, Any] = {"refs": [_handle_ref(item) for item in items], "mode": mode}
    if timeout is not None:
        args["timeout"] = timeout
    return _bridge_wait_post(args, timeout)


class HandleControl:
    """Epoch-fenced control over one handle; every call goes through the host capability."""

    __slots__ = ("_ref",)

    def __init__(self, ref: dict[str, Any]) -> None:
        self._ref = dict(ref)

    def __repr__(self) -> str:
        return f"<handle.control {self._ref['kind']}://{self._ref['id']}@{self._ref['run_epoch']}>"

    def status(self) -> Any:
        return _handle_call(RESERVED_HANDLE_STATUS_TOOL, {"ref": self._ref})

    def output(self, format: str = "raw", offset: int | None = None, limit: int | None = None) -> Any:
        args: dict[str, Any] = {"ref": self._ref, "format": format}
        if offset is not None:
            args["offset"] = offset
        if limit is not None:
            args["limit"] = limit
        return _handle_call(RESERVED_HANDLE_OUTPUT_TOOL, args)

    def send(self, message: str) -> Any:
        return _handle_call(RESERVED_HANDLE_SEND_TOOL, {"ref": self._ref, "message": str(message)})

    def cancel(self) -> Any:
        return _handle_call(RESERVED_HANDLE_CANCEL_TOOL, {"ref": self._ref})

    def wait(self, timeout: float | None = None) -> Any:
        return wait([self._ref], timeout=timeout, mode="all")[0]


class HandleView(dict):
    """The legacy record's fields as a dict, plus `control` and `ref` as attributes (never keys)."""

    __slots__ = ("control", "ref")

    def __init__(self, fields: dict[str, Any], ref: dict[str, Any]) -> None:
        super().__init__(fields)
        self.ref = dict(ref)
        self.control = HandleControl(ref)


def handle(value: Any) -> HandleView:
    """Rich view of an agent record, workpool, completion handle or saved reference; see tool_schema("eval:helpers")."""
    ref = _handle_ref(value)
    fields: dict[str, Any] = {}
    if isinstance(value, dict):
        fields.update({key: item for key, item in value.items() if not callable(item)})
    fields.setdefault("id", ref["id"])
    fields.setdefault("run_epoch", ref["run_epoch"])
    fields.setdefault("handle", f"{ref['kind']}://{ref['id']}")
    return HandleView(fields, ref)


def _pool_map(items: Iterable[Any], function: Callable[[Any], Any]) -> list[Any]:
    values = list(items)
    if not values:
        return []
    configured_width = CONNECTION.get("parallelPoolWidth", 4)
    width = (
        int(configured_width)
        if isinstance(configured_width, (int, float)) and not isinstance(configured_width, bool)
        else 4
    )
    workers = min(max(1, width), len(values))
    results: list[Any] = [None] * len(values)
    errors: dict[int, BaseException] = {}
    group = _token_key()

    def submit(pool: ThreadPoolExecutor, value: Any) -> Any:
        # Each worker runs in a copy of this thread's context: the kernel tool call it serves (scope),
        # its output buffer, and its token group, so its host calls park this thread's token.
        context = contextvars.copy_context()
        context.run(TOKEN_GROUP.set, group)
        return pool.submit(context.run, function, value)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {submit(pool, value): index for index, value in enumerate(values)}
        for future in as_completed(futures):
            index = futures[future]
            try:
                results[index] = future.result()
            except BaseException as exc:  # noqa: BROAD_EXCEPT_OK — preserve user thunk failures for deterministic re-raise.
                errors[index] = exc
    if errors:
        raise errors[min(errors)]
    return results


def parallel(callables: Iterable[Callable[[], Any]]) -> list[Any]:
    thunks = list(callables)
    for thunk in thunks:
        if not callable(thunk):
            raise PreludeTypeError("parallel() expects an iterable of zero-arg callables")
    return _pool_map(thunks, lambda thunk: thunk())


def pipeline(items: Iterable[Any], *stages: Callable[[Any], Any]) -> list[Any]:
    values = list(items)
    for stage in stages:
        if not callable(stage):
            raise PreludeTypeError("pipeline() stages must be callables")
        values = _pool_map(values, stage)
    return values


def _fold_continuations(lines: list[str], start: int) -> tuple[str, int]:
    parts: list[str] = []
    index = start
    while index < len(lines):
        line = lines[index]
        if line.endswith("\\"):
            parts.append(line[:-1])
            index += 1
            continue
        parts.append(line)
        index += 1
        break
    return "".join(parts), index - start


def _quote_arg(text_value: str) -> str:
    return json.dumps(text_value, ensure_ascii=False)


def _split_magic_head(text_value: str) -> tuple[str, str]:
    stripped = text_value.lstrip()
    if not stripped:
        return "", ""
    match = re.match(r"([A-Za-z_][A-Za-z_0-9]*)(?:\s+(.*))?$", stripped)
    if not match:
        return "", stripped
    return match.group(1), (match.group(2) or "").rstrip()


def _is_escaped(text_value: str, index: int) -> bool:
    backslashes = 0
    cursor = index - 1
    while cursor >= 0 and text_value[cursor] == "\\":
        backslashes += 1
        cursor -= 1
    return backslashes % 2 == 1


def _advance_triple_quote_state(line: str, active_quote: str | None) -> str | None:
    index = 0
    quote = active_quote
    while index < len(line):
        if quote is not None:
            closing = line.find(quote, index)
            if closing < 0:
                return quote
            if _is_escaped(line, closing):
                index = closing + 1
                continue
            quote = None
            index = closing + 3
            continue

        character = line[index]
        if character == "#":
            return None
        if character not in ("'", '"'):
            index += 1
            continue
        triple = character * 3
        if line.startswith(triple, index):
            quote = triple
            index += 3
            continue
        index += 1
        while index < len(line):
            if line[index] == character and not _is_escaped(line, index):
                index += 1
                break
            index += 1
    return quote


def transform_cell(source: str) -> str:
    if "%" not in source and "!" not in source:
        return source

    lines = source.splitlines()
    transformed: list[str] = []
    index = 0
    triple_quote: str | None = None
    while index < len(lines):
        line = lines[index]
        protected = triple_quote is not None
        stripped = line.lstrip()
        indent = line[: len(line) - len(stripped)]

        if not protected and stripped.startswith("%%"):
            name, args = _split_magic_head(stripped[2:])
            body = "\n".join(lines[index + 1 :])
            transformed.append(
                f"{indent}__senpi_magic_cell({_quote_arg(name)}, {_quote_arg(args)}, {_quote_arg(body)})"
            )
            return "\n".join(transformed)

        if not protected and stripped.startswith("%"):
            folded, consumed = _fold_continuations(lines, index)
            folded_stripped = folded.lstrip()
            folded_indent = folded[: len(folded) - len(folded_stripped)]
            name, args = _split_magic_head(folded_stripped[1:])
            transformed.append(f"{folded_indent}__senpi_magic({_quote_arg(name)}, {_quote_arg(args)})")
            index += consumed
            continue

        if not protected and stripped.startswith("!"):
            folded, consumed = _fold_continuations(lines, index)
            folded_stripped = folded.lstrip()
            folded_indent = folded[: len(folded) - len(folded_stripped)]
            command = folded_stripped[1:].strip()
            transformed.append(f"{folded_indent}__senpi_shell({_quote_arg(command)})")
            index += consumed
            continue

        if not protected:
            assignment = _ASSIGN_LINE_RE.match(line)
            if assignment:
                right_hand_side = assignment.group("rhs").strip()
                if right_hand_side.startswith("!"):
                    command = right_hand_side[1:].strip()
                    transformed.append(
                        f"{assignment.group('indent')}{assignment.group('lhs').rstrip()} = "
                        f"__senpi_shell({_quote_arg(command)})"
                    )
                    index += 1
                    continue
                if right_hand_side.startswith("%") and not right_hand_side.startswith("%%"):
                    name, args = _split_magic_head(right_hand_side[1:])
                    transformed.append(
                        f"{assignment.group('indent')}{assignment.group('lhs').rstrip()} = "
                        f"__senpi_magic({_quote_arg(name)}, {_quote_arg(args)})"
                    )
                    index += 1
                    continue

        transformed.append(line)
        triple_quote = _advance_triple_quote_state(line, triple_quote)
        index += 1
    return "\n".join(transformed)


def _magic_cd(args: str) -> str:
    path = os.path.expanduser(args.strip()) or os.path.expanduser("~")
    os.chdir(path)
    cwd = os.getcwd()
    emit_status("cd", path=cwd)
    return cwd


def _magic_env(args: str) -> Any:
    stripped = args.strip()
    if not stripped:
        return env()
    if "=" in stripped:
        key, value = stripped.split("=", 1)
        return env(key.strip(), value.strip())
    return env(stripped)


_LINE_MAGICS: dict[str, Callable[[str], Any]] = {
    "cd": _magic_cd,
    "env": _magic_env,
}


_HOST_MAGICS = frozenset({"pip", "environment"})


def _magic(name: str, args: str) -> Any:
    handler = _LINE_MAGICS.get(name)
    if handler is None and name in _HOST_MAGICS:
        # The host runs these only as a cell's first code line; anywhere else they reach here.
        raise PreludeRuntimeError(f"put %{name} on its own cell, then run the code that uses it in the next cell")
    if handler is None:
        raise PreludeRuntimeError(f"Unsupported line magic: %{name}")
    return handler(args)


def _magic_cell(name: str, args: str, body: str) -> Any:
    if name in ("bash", "sh"):
        command = "\n".join(part for part in (args, body) if part)
        return _shell(command)
    raise PreludeRuntimeError(f"Unsupported cell magic: %%{name}")


def _take_prefix_by_lines(value: str, max_lines: int) -> str:
    if max_lines <= 0:
        return ""
    cursor = 0
    for _ in range(max_lines):
        newline = value.find("\n", cursor)
        if newline < 0:
            return value
        cursor = newline + 1
    return value[:cursor]


def _take_prefix_by_encoded_bytes(value: str, max_bytes: int, encoding: str) -> str:
    if max_bytes <= 0:
        return ""
    if len(value.encode(encoding, errors="replace")) <= max_bytes:
        return value
    low = 0
    high = len(value)
    while low < high:
        middle = (low + high + 1) // 2
        if len(value[:middle].encode(encoding, errors="replace")) <= max_bytes:
            low = middle
        else:
            high = middle - 1
    return value[:low]


class _ShellOutputLimiter:
    def __init__(self, *, max_bytes: int, max_lines: int, encoding: str) -> None:
        self._remaining_bytes = max_bytes
        self._remaining_lines = max_lines
        self._encoding = encoding
        self._truncated = False
        self._at_line_start = True

    def write(self, value: str) -> None:
        if not value or self._truncated:
            return
        line_limited = _take_prefix_by_lines(value, self._remaining_lines)
        truncated = line_limited != value
        byte_limited = _take_prefix_by_encoded_bytes(
            line_limited,
            self._remaining_bytes,
            self._encoding,
        )
        truncated = truncated or byte_limited != line_limited
        if byte_limited:
            text("stdout", byte_limited)
            self._remaining_bytes -= len(
                byte_limited.encode(self._encoding, errors="replace")
            )
            self._remaining_lines -= byte_limited.count("\n")
            self._at_line_start = byte_limited.endswith("\n")
        if truncated:
            self._emit_truncation_notice()

    def _emit_truncation_notice(self) -> None:
        if self._truncated:
            return
        prefix = "" if self._at_line_start else "\n"
        text("stdout", prefix + _SHELL_TRUNCATION_NOTICE)
        self._truncated = True


class _BoundedTextCapture:
    def __init__(self, max_bytes: int, max_lines: int, encoding: str) -> None:
        self._remaining_bytes = max_bytes
        self._remaining_lines = max_lines
        self._encoding = encoding
        self._parts: list[str] = []

    def add(self, value: str) -> None:
        if self._remaining_bytes <= 0 or self._remaining_lines <= 0:
            return
        line_limited = _take_prefix_by_lines(value, self._remaining_lines)
        part = _take_prefix_by_encoded_bytes(
            line_limited,
            self._remaining_bytes,
            self._encoding,
        )
        if not part:
            return
        self._parts.append(part)
        self._remaining_bytes -= len(part.encode(self._encoding, errors="replace"))
        self._remaining_lines -= part.count("\n")

    def value(self) -> str:
        return "".join(self._parts)


class ShellResult(list[str]):
    def __init__(self, lines: list[str], returncode: int) -> None:
        super().__init__(lines)
        self.returncode = returncode

    @property
    def n(self) -> str:
        return "\n".join(self)

    @property
    def s(self) -> str:
        return " ".join(self)


def _shell(command: str) -> ShellResult:
    process = subprocess.Popen(
        command,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if process.stdout is None:
        return ShellResult([], process.wait())

    encoding = locale.getpreferredencoding(False) or "utf-8"
    decoder = codecs.getincrementaldecoder(encoding)(errors="replace")
    limiter = _ShellOutputLimiter(
        max_bytes=_SHELL_CAPTURE_MAX_BYTES,
        max_lines=_SHELL_CAPTURE_MAX_LINES,
        encoding=encoding,
    )
    capture = _BoundedTextCapture(
        _SHELL_CAPTURE_MAX_BYTES,
        _SHELL_CAPTURE_MAX_LINES,
        encoding,
    )

    def consume(chunk_text: str) -> None:
        if not chunk_text:
            return
        limiter.write(chunk_text)
        capture.add(chunk_text)

    while True:
        raw_chunk = os.read(process.stdout.fileno(), _SHELL_READ_CHUNK_BYTES)
        if not raw_chunk:
            break
        consume(decoder.decode(raw_chunk))
    consume(decoder.decode(b"", final=True))
    return ShellResult(capture.value().splitlines(), process.wait())


USER_NS.update(
    {
        "display": display,
        "print": print,
        "log": log,
        "phase": phase,
        "env": env,
        "read": read,
        "write": write,
        "parallel": parallel,
        "pipeline": pipeline,
        "tool": tool,
        "completion": completion,
        "agent": agent,
        "workpool": workpool,
        "output": output,
        "tool_schema": tool_schema,
        "packages": packages,
        "wait": wait,
        "handle": handle,
        "__senpi_magic": _magic,
        "__senpi_magic_cell": _magic_cell,
        "__senpi_shell": _shell,
    }
)

# Kernel memory (mirrors src/kernels/js/worker-memory.js; thresholds arrive on `init`, the host applies the
# notice/ceiling policy in src/kernels/shared/kernel-memory.ts). Names present right after prelude install
# are never reported as user globals.
_MEMORY_BASELINE = frozenset(USER_NS)
_MIB = 1024 * 1024
_MEMORY_MIN_GROWTH = 64 * _MIB
_MEMORY_GROWTH_RATIO = 0.25
_MEMORY_NOTICE_GROWTH_RATIO = 1.25
# A collection costs at most 1/20 of the time since the previous one.
_MEMORY_COLLECT_RATE_FLOOR = 20
_MEMORY_REPORTED_GLOBALS = 5
_MEMORY_MIN_REPORTED_BYTES = _MIB
_SIZER_SAMPLED = 1_000
_SIZER_NODE_BUDGET = 200_000
_SIZER_MAX_DEPTH = 64
_SIZER_POINTER = 8
_SIZER_LEAF_TYPES = (str, bytes, bytearray, int, float, complex, bool, type(None), range, memoryview)
_SIZER_OPAQUE_TYPES = (types.ModuleType, type, types.FunctionType, types.BuiltinFunctionType, types.MethodType)


class _KernelMemory:
    """Post-cell footprint measurement, collection, and largest-globals attribution for this process."""

    def __init__(self) -> None:
        self.thresholds: dict[str, int] | None = None
        self.last_live = 0
        self.notice_ref = 0
        self.collect_end = float("-inf")
        self.collect_seconds = 0.0
        self._reader: Callable[[], tuple[int, bool] | None] | None = None
        self._trim: Callable[[], None] | None = None
        self._resolved = False

    def configure(self, thresholds: Any) -> None:
        if not isinstance(thresholds, dict):
            return
        keys = ("gcWatermarkBytes", "noticeBytes", "ceilingBytes")
        if all(isinstance(thresholds.get(key), int) for key in keys):
            self.thresholds = {key: int(thresholds[key]) for key in keys}

    def after_cell(self) -> dict[str, Any] | None:
        if self.thresholds is None:
            return None
        reading = self._footprint()
        if reading is None:
            return None
        live, approximate = reading
        gc_ran = self._needs_collection(live)
        if gc_ran:
            live = self._collect(live)
        notice = self.thresholds["noticeBytes"]
        if gc_ran and notice > 0 and live >= notice:
            if self.notice_ref == 0 or live >= self.notice_ref * _MEMORY_NOTICE_GROWTH_RATIO:
                self.notice_ref = live
        self.last_live = live
        report: dict[str, Any] = {"liveBytes": live, "measure": "footprint"}
        if gc_ran:
            report["gcRan"] = True
        if approximate:
            report["approximate"] = True
        if gc_ran and self._worth_naming(live):
            named = _largest_globals(_MEMORY_REPORTED_GLOBALS)
            if named:
                report["globals"] = named
        return report

    def _needs_collection(self, estimate: int) -> bool:
        assert self.thresholds is not None
        watermark = self.thresholds["gcWatermarkBytes"]
        notice = self.thresholds["noticeBytes"]
        ceiling = self.thresholds["ceilingBytes"]
        if ceiling > 0 and estimate >= ceiling:
            return True
        if watermark > 0 and estimate >= watermark:
            if estimate > self.last_live + max(_MEMORY_MIN_GROWTH, self.last_live * _MEMORY_GROWTH_RATIO):
                return True
        if notice > 0 and estimate >= notice:
            if self.last_live < notice or self.notice_ref == 0 or estimate >= self.notice_ref * _MEMORY_NOTICE_GROWTH_RATIO:
                return True
        # The JS worker's idle collection, run synchronously: a cell that only drops a global allocates
        # nothing, so cyclic garbage and malloc's free lists would otherwise stay until the next growth.
        if watermark == 0 or self.last_live < watermark:
            return False
        return time.monotonic() - self.collect_end >= _MEMORY_COLLECT_RATE_FLOOR * self.collect_seconds

    def _worth_naming(self, live: int) -> bool:
        assert self.thresholds is not None
        notice = self.thresholds["noticeBytes"]
        ceiling = self.thresholds["ceilingBytes"]
        return (notice > 0 and live >= notice) or (ceiling > 0 and live >= ceiling)

    def _collect(self, before: int) -> int:
        started = time.monotonic()
        gc.collect()
        if self._trim is not None:
            self._trim()
        self.collect_end = time.monotonic()
        self.collect_seconds = self.collect_end - started
        reading = self._footprint()
        live = before if reading is None else reading[0]
        if self.thresholds is not None and live < self.thresholds["noticeBytes"] / 2:
            self.notice_ref = 0
        return live

    def _footprint(self) -> tuple[int, bool] | None:
        if not self._resolved:
            self._resolved = True
            self._reader = _footprint_reader()
            self._trim = _malloc_trim()
        return None if self._reader is None else self._reader()


def _footprint_reader() -> Callable[[], tuple[int, bool]] | None:
    """This process's footprint as src/core/process-footprint.ts reads it, or peak RSS (approximate)."""
    import ctypes

    if sys.platform == "darwin":
        with contextlib.suppress(OSError, AttributeError):
            libsystem = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
            rusage = libsystem.proc_pid_rusage
            rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
            rusage.restype = ctypes.c_int
            buffer = (ctypes.c_uint64 * 32)()
            pid = os.getpid()

            def darwin() -> tuple[int, bool] | None:
                # RUSAGE_INFO_V2; ri_phys_footprint is the u64 at index 9 (byte offset 72).
                return (int(buffer[9]), False) if rusage(pid, 2, ctypes.byref(buffer)) == 0 else None

            if darwin() is not None:
                return darwin
    if sys.platform.startswith("linux") and os.path.exists("/proc/self/status"):

        def linux() -> tuple[int, bool] | None:
            with open("/proc/self/status", encoding="ascii", errors="replace") as status:
                for line in status:
                    if line.startswith("RssAnon:"):
                        return int(line.split()[1]) * 1024, False
            return None

        if linux() is not None:
            return linux
    if sys.platform == "win32":
        with contextlib.suppress(OSError, AttributeError):
            return _windows_private_usage_reader(ctypes)
    with contextlib.suppress(ImportError):
        import resource

        # ru_maxrss is a peak (kilobytes on Linux, bytes on macOS): flagged approximate.
        scale = 1 if sys.platform == "darwin" else 1024
        return lambda: (int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * scale, True)
    return None


def _windows_private_usage_reader(ctypes: Any) -> Callable[[], tuple[int, bool]] | None:
    size_t = ctypes.c_size_t

    class Counters(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_uint32),
            ("PageFaultCount", ctypes.c_uint32),
            *((name, size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage")),
            *((name, size_t) for name in ("QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage")),
            *((name, size_t) for name in ("QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")),
            ("PrivateUsage", size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32")
    current = kernel32.GetCurrentProcess
    current.restype = ctypes.c_void_p
    query = kernel32.K32GetProcessMemoryInfo
    query.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32]
    query.restype = ctypes.c_int
    counters = Counters()
    counters.cb = ctypes.sizeof(Counters)

    def windows() -> tuple[int, bool] | None:
        if query(current(), ctypes.byref(counters), counters.cb) == 0:
            return None
        return int(counters.PrivateUsage), False

    return windows if windows() is not None else None


def _malloc_trim() -> Callable[[], None] | None:
    """glibc's malloc_trim(0) returns freed heap pages to the OS; other C libraries have no equivalent."""
    if not sys.platform.startswith("linux"):
        return None
    import ctypes

    with contextlib.suppress(OSError, AttributeError):
        trim = ctypes.CDLL("libc.so.6").malloc_trim
        trim.argtypes = [ctypes.c_size_t]
        trim.restype = ctypes.c_int

        def trim_heap() -> None:
            trim(0)

        return trim_heap
    return None


def _largest_globals(limit: int) -> list[dict[str, Any]]:
    sizer = _GlobalSizer()
    sized: list[dict[str, Any]] = []
    for name, value in list(USER_NS.items()):
        if name in _MEMORY_BASELINE or name.startswith("__") or isinstance(value, _SIZER_OPAQUE_TYPES):
            continue
        measured = sizer.measure(value)
        if measured is None or measured[0] < _MEMORY_MIN_REPORTED_BYTES:
            continue
        entry: dict[str, Any] = {"name": name, "bytes": measured[0]}
        if measured[1]:
            entry["approximate"] = True
        sized.append(entry)
    sized.sort(key=lambda entry: entry["bytes"], reverse=True)
    return sized[:limit]


class _GlobalSizer:
    """Estimated retained size of user globals: array/frame buffers from numpy and pandas, containers from
    their length and up to 1,000 sampled elements, one shared visited set and node budget for the walk."""

    def __init__(self) -> None:
        self.seen: set[int] = set()
        self.nodes = 0
        self.approximate = False

    def measure(self, value: Any) -> tuple[int, bool] | None:
        self.approximate = False
        try:
            return int(self.size(value, 0)), self.approximate
        except Exception:  # noqa: BROAD_EXCEPT_OK — an exotic user value (a raising __len__/__iter__) stays unsized.
            return None

    def size(self, value: Any, depth: int) -> float:
        if id(value) in self.seen:
            return 0
        if depth >= _SIZER_MAX_DEPTH or self.nodes >= _SIZER_NODE_BUDGET:
            self.approximate = True
            return 0
        self.seen.add(id(value))
        self.nodes += 1
        buffer = _buffer_bytes(value)
        if buffer is not None:
            return buffer
        own = sys.getsizeof(value)
        if isinstance(value, _SIZER_LEAF_TYPES) or isinstance(value, _SIZER_OPAQUE_TYPES):
            return own
        if isinstance(value, dict):
            return own + self.sampled(len(value), iter(value.items()), depth, pairs=True)
        if isinstance(value, (list, tuple)):
            return own + self.spaced(value, depth)
        if isinstance(value, (set, frozenset)) or type(value).__module__ == "collections":
            return own + self.sampled(len(value), iter(value), depth, pairs=False)
        attributes = _instance_dict(value)
        return own if attributes is None else own + self.size(attributes, depth + 1)

    def spaced(self, items: Any, depth: int) -> float:
        count = len(items)
        if count <= _SIZER_SAMPLED:
            return sum(self.size(item, depth + 1) for item in items)
        self.approximate = True
        step = count / _SIZER_SAMPLED
        total = sum(self.size(items[int(index * step)], depth + 1) for index in range(_SIZER_SAMPLED))
        return total / _SIZER_SAMPLED * count

    def sampled(self, count: int, entries: Any, depth: int, *, pairs: bool) -> float:
        taken = []
        for entry in entries:
            taken.append(entry)
            if len(taken) >= _SIZER_SAMPLED:
                break
        if not taken:
            return 0
        if len(taken) < count:
            self.approximate = True
        total = 0.0
        for entry in taken:
            if pairs:
                total += self.size(entry[0], depth + 1) + self.size(entry[1], depth + 1)
            else:
                total += self.size(entry, depth + 1)
        return total * count / len(taken)


def _buffer_bytes(value: Any) -> int | None:
    root = type(value).__module__.split(".", 1)[0]
    if root == "numpy" and isinstance(getattr(value, "nbytes", None), int):
        return int(value.nbytes)
    if root == "pandas" and callable(getattr(value, "memory_usage", None)):
        usage = value.memory_usage(deep=True)
        return int(usage.sum()) if hasattr(usage, "sum") else int(usage)
    return None


def _instance_dict(value: Any) -> dict[str, Any] | None:
    # object.__getattribute__ never falls back to a user __getattr__.
    try:
        attributes = object.__getattribute__(value, "__dict__")
    except AttributeError:
        return None
    return attributes if isinstance(attributes, dict) else None


KERNEL_MEMORY = _KernelMemory()

TLA_FLAG = getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0x2000)


def compile_cell(source: str, filename: str = "<cell>") -> tuple[Any | None, Any | None]:
    module = ast.parse(transform_cell(source), filename=filename, mode="exec")
    if not module.body:
        return None, None
    last = module.body[-1]
    if isinstance(last, ast.Expr):
        body = ast.Module(body=module.body[:-1], type_ignores=[])
        expression = ast.Expression(body=last.value)
        ast.copy_location(expression, last)
        return compile(body, filename, "exec", flags=TLA_FLAG), compile(
            expression,
            filename,
            "eval",
            flags=TLA_FLAG,
        )
    return compile(module, filename, "exec", flags=TLA_FLAG), None


async def run_code(code: Any, want_value: bool) -> Any:
    if code is None:
        return None
    if code.co_flags & inspect.CO_COROUTINE:
        result = await eval(code, USER_NS)
        return result if want_value else None
    if want_value:
        return eval(code, USER_NS)
    exec(code, USER_NS)
    return None


def apply_preludes(preludes: Any) -> None:
    # Host-computed per cell: globals of tools deactivated since the last cell are dropped,
    # and an active tool's snippet runs only while one of its exports is missing.
    if not isinstance(preludes, dict):
        return
    for name in preludes.get("remove", []):
        USER_NS.pop(name, None)
    for contribution in preludes.get("install", []):
        if any(name not in USER_NS for name in contribution.get("exports", [])):
            exec(compile(contribution.get("python", ""), "<kernel-prelude>", "exec"), USER_NS)


def _enter_source_file(source_file: str | None) -> Callable[[], None]:
    # A %load cell runs as its file: __file__ names it and its directory comes first on the import path,
    # so `from sibling import x` resolves next to the file the way it does when the file runs as a script.
    # The returned step undoes both when the cell ends, so a later cell never imports from that directory
    # ahead of the session environment; the file's own sys.path edits stay.
    if source_file is None:
        return lambda: None
    missing = object()
    previous_file = USER_NS.get("__file__", missing)
    directory = os.path.dirname(source_file)
    previous_index = sys.path.index(directory) if directory in sys.path else None
    with contextlib.suppress(ValueError):
        sys.path.remove(directory)
    sys.path.insert(0, directory)
    importlib.invalidate_caches()
    USER_NS["__file__"] = source_file

    def restore() -> None:
        with contextlib.suppress(ValueError):
            sys.path.remove(directory)
        if previous_index is not None:
            sys.path.insert(min(previous_index, len(sys.path)), directory)
        if previous_file is missing:
            USER_NS.pop("__file__", None)
        else:
            USER_NS["__file__"] = previous_file
        # Last: it calls every sys.meta_path finder, and user code may have installed one that raises.
        importlib.invalidate_caches()

    return restore


def run_cell(
    cell_id: str, code: str, preludes: Any = None, source_file: str | None = None, cell_token: str | None = None
) -> None:
    start = time.monotonic()
    stdout = io.StringIO()
    stderr = io.StringIO()
    # SIGINT must interrupt user code here; the idle baseline (set between
    # cells) ignores it so a late signal cannot kill the stdin-read loop.
    signal.signal(signal.SIGINT, signal.default_int_handler)
    result: dict[str, Any]
    leave_source_file: Callable[[], None] = lambda: None
    cell_scope = CURRENT_CELL_TOKEN.set(cell_token)
    try:
        KERNEL_TOOL_TOKEN.acquire()
        cell_stdout, cell_stderr = KERNEL_TOOL_STREAMS
        with cell_stdout.capture(stdout, cell=True), cell_stderr.capture(stderr, cell=True):
            apply_preludes(preludes)
            leave_source_file = _enter_source_file(source_file)
            body, expression = compile_cell(code, source_file or "<cell>")
            LOOP.run_until_complete(run_code(body, False))
            value = LOOP.run_until_complete(run_code(expression, True))
        text("stdout", stdout.getvalue())
        text("stderr", stderr.getvalue())
        result = {
            "type": "result",
            "cellId": cell_id,
            "ok": True,
            "durationMs": elapsed(start),
        }
        if value is not None:
            result["valueRepr"] = repr(value)
    except BaseException as exc:  # noqa: BROAD_EXCEPT_OK — cell boundary serializes user errors and interrupts.
        text("stdout", stdout.getvalue())
        text("stderr", stderr.getvalue())
        result = {
            "type": "result",
            "cellId": cell_id,
            "ok": False,
            "error": bridge_error(exc),
            "durationMs": elapsed(start),
        }
    finally:
        # Liveness and revocation first: nothing the cell installed (an import finder, a path hook) can skip them.
        KERNEL_TOOL_TOKEN.release()
        CURRENT_CELL_TOKEN.reset(cell_scope)
        try:
            leave_source_file()
        except BaseException as exc:  # noqa: BROAD_EXCEPT_OK — user code can break the restore; it must not wedge the kernel.
            text("stderr", f"[senpi] %load could not fully restore the import path: {exc}\n")
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        memory = KERNEL_MEMORY.after_cell()
    except Exception as exc:  # noqa: BROAD_EXCEPT_OK — a measurement failure must not cost the cell its result.
        memory = None
        text("stderr", f"[senpi] kernel memory measurement failed: {exc}\n")
    if memory is not None:
        result["memory"] = memory
    emit(result)


def elapsed(start: float) -> int:
    return max(0, int((time.monotonic() - start) * 1000))


def _handle_message(message: dict[str, Any]) -> bool:
    global CONNECTION
    message_type = message.get("type")
    if message_type == "init":
        connection = message.get("connection")
        if not isinstance(connection, dict):
            emit({"type": "init-failed", "error": {"message": "missing bridge connection"}})
            return True
        CONNECTION = connection
        generation = message.get("kernelGeneration")
        if isinstance(generation, int) and not isinstance(generation, bool):
            KERNEL_TOOL_REGISTRY.generation = generation
        KERNEL_MEMORY.configure(message.get("memory"))
        emit({"type": "ready"})
        return True
    if message_type == "run":
        env_root = message.get("envRoot")
        if isinstance(env_root, str):
            _activate_env_root(env_root)
        source_file = message.get("sourceFile")
        token = message.get("bridgeCellToken")
        run_cell(
            str(message.get("cellId", "")),
            str(message.get("code", "")),
            message.get("preludes"),
            source_file if isinstance(source_file, str) and source_file else None,
            token if isinstance(token, str) else None,
        )
        return True
    if message_type == "close":
        KERNEL_TOOL_RUNNER.close()
        emit({"type": "closed"})
        return False
    return True


_ACTIVE_ENV_ROOT: list[str] = []


def _activate_env_root(root: str) -> None:
    # One environment revision is on the import path at a time: a newer revision already holds every
    # package of the previous one, so it replaces that entry instead of stacking another.
    # An empty root means the session's current mode has nothing installed: the previous revision leaves too.
    wanted = [root] if root else []
    if _ACTIVE_ENV_ROOT == wanted:
        return
    for previous in _ACTIVE_ENV_ROOT:
        with contextlib.suppress(ValueError):
            sys.path.remove(previous)
    _ACTIVE_ENV_ROOT[:] = wanted
    if root:
        sys.path.insert(0, root)
    importlib.invalidate_caches()


def _terminate_process_group() -> None:
    # The kernel is spawned into its own session (setsid), so its pid is its process
    # group id and a cell's subprocesses inherit that group. Killing the group takes
    # those children down with the kernel instead of orphaning them to init.
    if os.name != "posix":
        return
    with contextlib.suppress(OSError):
        os.killpg(os.getpgrp(), signal.SIGKILL)


def _watch_parent(initial_ppid: int) -> None:
    # A cell blocked in the main thread (for example a multiprocessing pool) never
    # returns to the stdin loop, so it cannot notice the host closing its pipe. This
    # daemon thread notices the reparenting instead and takes the whole group down.
    while True:
        time.sleep(1.0)
        if os.getppid() != initial_ppid:
            _terminate_process_group()
            return


def _watch_named_parent(parent_pid: int) -> None:
    # The ppid watch above can only observe a change from the ppid captured at boot. A
    # host that died before the interpreter reached that capture is already replaced in
    # getppid() by the posthumous value, so no transition ever fires. The host passes its
    # own pid at spawn (SENPI_PY_KERNEL_PARENT_PID) precisely so this loss is detectable:
    # poll the named pid instead of the ppid and take the whole group down once it is gone.
    while True:
        time.sleep(0.5)
        try:
            os.kill(parent_pid, 0)
        except ProcessLookupError:
            _terminate_process_group()
            return


def _start_parent_watch() -> None:
    if os.name != "posix":
        return
    Thread(target=_watch_parent, args=(os.getppid(),), name="senpi-parent-watch", daemon=True).start()
    named_parent = os.environ.get("SENPI_PY_KERNEL_PARENT_PID")
    if named_parent and named_parent.isdigit():
        Thread(
            target=_watch_named_parent,
            args=(int(named_parent),),
            name="senpi-named-parent-watch",
            daemon=True,
        ).start()


def _read_control(commands: queue.Queue[tuple[str, Any]]) -> None:
    # Kernel-tool frames are served here, so a callback can be admitted while the main thread is inside a cell.
    for raw in sys.stdin:
        try:
            message = json.loads(raw)
        except BaseException as exc:  # noqa: BROAD_EXCEPT_OK — malformed input is reported by the main loop, in order.
            commands.put(("malformed", exc))
            continue
        if isinstance(message, dict) and KERNEL_TOOL_RUNNER.handle(message):
            continue
        commands.put(("message", message))
    commands.put(("eof", None))


def main() -> None:
    emit_status("kernel-startup", force=True, stage="host-init")
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    _start_parent_watch()
    sys.stdout, sys.stderr = KERNEL_TOOL_STREAMS
    commands: queue.Queue[tuple[str, Any]] = queue.Queue()
    threading.Thread(target=_read_control, args=(commands,), name="senpi-control-reader", daemon=True).start()
    host_closed = False
    while True:
        kind, payload = commands.get()
        if kind == "eof":
            break
        if kind == "malformed":
            emit({"type": "init-failed", "error": bridge_error(payload)})
            continue
        try:
            if not _handle_message(payload):
                host_closed = True
                break
        except BaseException as exc:  # noqa: BROAD_EXCEPT_OK — process boundary serializes malformed input and interrupts.
            emit({"type": "init-failed", "error": bridge_error(exc)})
    # Reaching here without a close frame means the host's pipe hit EOF: it is gone,
    # so retire any subprocess the last cell left running before the interpreter exits.
    if not host_closed:
        _terminate_process_group()


if __name__ == "__main__":
    main()
