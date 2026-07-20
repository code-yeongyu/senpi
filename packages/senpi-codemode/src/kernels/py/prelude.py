from __future__ import annotations

# noqa: SIZE_OK — this dependency-free subprocess prelude must ship as one file.
import ast
import asyncio  # noqa: ANYIO_OK — stdlib-only embedded kernel runner.
import base64
import codecs
import contextlib
import inspect
import io
import json
import locale
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
import uuid
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock
from typing import Any, Callable
from urllib.parse import unquote

SESSION_ID = ""
CONNECTION: dict[str, Any] = {}
USER_NS: dict[str, Any] = {"__name__": "__main__", "__doc__": None, "__builtins__": __builtins__}
LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(LOOP)
EMIT_LOCK = Lock()

# Mirrors src/bridge/reserved.ts; this standalone subprocess asset cannot import TypeScript.
RESERVED_AGENT_TOOL = "__agent__"
RESERVED_OUTPUT_TOOL = "__output__"
TIMEOUT_PAUSE_OP = "timeout-pause"
TIMEOUT_RESUME_OP = "timeout-resume"


class PreludeRuntimeError(RuntimeError):
    """Host bridge or magic execution failed."""


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
    if isinstance(value, (dict, list, tuple)):
        _emit_display("application/json", value)
        return
    if isinstance(value, (bytes, bytearray)):
        _emit_display("application/octet-stream", bytes(value))
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


def bridge_post(path: str, payload: dict[str, Any]) -> Any:
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
    emit_status(TIMEOUT_PAUSE_OP, force=True)
    try:
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                response_data = response.read()
        except urllib.error.HTTPError as exc:
            response_data = exc.read()
    finally:
        emit_status(TIMEOUT_RESUME_OP, force=True)

    try:
        body = json.loads(response_data.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise PreludeRuntimeError(f"Bridge returned invalid JSON: {response_data[:200]!r}") from exc
    if isinstance(body, dict) and body.get("ok") is True:
        return body.get("value")
    error = body.get("error") if isinstance(body, dict) else body
    if isinstance(error, dict):
        raise PreludeRuntimeError(str(error.get("message", error)))
    raise PreludeRuntimeError(str(error))


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

    def __getattr__(self, name: str) -> ToolCallable:
        if name.startswith("_"):
            raise AttributeError(name)
        return ToolCallable(name)

    def __getitem__(self, name: str) -> ToolCallable:
        return ToolCallable(name)

    def __repr__(self) -> str:
        return "<tool proxy>"


tool = ToolProxy()


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
    if not isinstance(response, dict):
        return response
    if "value" in response:
        return response["value"]
    return response.get("text", response)


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
    merge: bool | None = None,
    handle: bool = False,
) -> Any:
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
        args["merge"] = bool(merge)
    if handle:
        args["handle"] = True

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
        "agent": response_record.get("agent", agent),
    }
    if schema is not None:
        node["data"] = parsed
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
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(function, value): index for index, value in enumerate(values)}
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


def _magic(name: str, args: str) -> Any:
    handler = _LINE_MAGICS.get(name)
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
        "output": output,
        "__senpi_magic": _magic,
        "__senpi_magic_cell": _magic_cell,
        "__senpi_shell": _shell,
    }
)

TLA_FLAG = getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0x2000)


def compile_cell(source: str) -> tuple[Any | None, Any | None]:
    module = ast.parse(transform_cell(source), mode="exec")
    if not module.body:
        return None, None
    last = module.body[-1]
    if isinstance(last, ast.Expr):
        body = ast.Module(body=module.body[:-1], type_ignores=[])
        expression = ast.Expression(body=last.value)
        ast.copy_location(expression, last)
        return compile(body, "<cell>", "exec", flags=TLA_FLAG), compile(
            expression,
            "<cell>",
            "eval",
            flags=TLA_FLAG,
        )
    return compile(module, "<cell>", "exec", flags=TLA_FLAG), None


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


def run_cell(cell_id: str, code: str) -> None:
    start = time.monotonic()
    stdout = io.StringIO()
    stderr = io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            body, expression = compile_cell(code)
            LOOP.run_until_complete(run_code(body, False))
            value = LOOP.run_until_complete(run_code(expression, True))
        text("stdout", stdout.getvalue())
        text("stderr", stderr.getvalue())
        result: dict[str, Any] = {
            "type": "result",
            "cellId": cell_id,
            "ok": True,
            "durationMs": elapsed(start),
        }
        if value is not None:
            result["valueRepr"] = repr(value)
        emit(result)
    except BaseException as exc:  # noqa: BROAD_EXCEPT_OK — cell boundary serializes user errors and interrupts.
        text("stdout", stdout.getvalue())
        text("stderr", stderr.getvalue())
        emit(
            {
                "type": "result",
                "cellId": cell_id,
                "ok": False,
                "error": bridge_error(exc),
                "durationMs": elapsed(start),
            }
        )


def elapsed(start: float) -> int:
    return max(0, int((time.monotonic() - start) * 1000))


def handle(message: dict[str, Any]) -> bool:
    global SESSION_ID, CONNECTION
    message_type = message.get("type")
    if message_type == "init":
        SESSION_ID = str(message.get("sessionId", ""))
        connection = message.get("connection")
        if not isinstance(connection, dict):
            emit({"type": "init-failed", "error": {"message": "missing bridge connection"}})
            return True
        CONNECTION = connection
        emit({"type": "ready"})
        return True
    if message_type == "run":
        run_cell(str(message.get("cellId", "")), str(message.get("code", "")))
        return True
    if message_type == "close":
        emit({"type": "closed"})
        return False
    return True


def main() -> None:
    for raw in sys.stdin:
        try:
            if not handle(json.loads(raw)):
                break
        except BaseException as exc:  # noqa: BROAD_EXCEPT_OK — process boundary serializes malformed input and interrupts.
            emit({"type": "init-failed", "error": bridge_error(exc)})


if __name__ == "__main__":
    main()
