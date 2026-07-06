from __future__ import annotations

import ast
import asyncio
import base64
import contextlib
import io
import inspect
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

SESSION_ID = ""
CONNECTION: dict[str, Any] = {}
USER_NS: dict[str, Any] = {"__name__": "__main__", "__doc__": None, "__builtins__": __builtins__}
LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(LOOP)


def emit(frame: dict[str, Any]) -> None:
    sys.__stdout__.write(json.dumps(frame, ensure_ascii=False, default=repr) + "\n")
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


def display(value: Any) -> None:
    if isinstance(value, (dict, list, tuple)):
        payload = json.dumps(value, ensure_ascii=False, default=repr)
        emit({"type": "display", "mimeType": "application/json", "dataBase64": b64(payload)})
        return
    if isinstance(value, (bytes, bytearray)):
        emit({"type": "display", "mimeType": "application/octet-stream", "dataBase64": base64.b64encode(value).decode("ascii")})
        return
    emit({"type": "display", "mimeType": "text/plain", "dataBase64": b64(str(value))})


def b64(value: str) -> str:
    return base64.b64encode(value.encode("utf-8")).decode("ascii")


def log(message: Any) -> None:
    emit({"type": "log", "message": str(message)})


def phase(title: Any) -> None:
    emit({"type": "phase", "title": str(title)})


def env(key: str | None = None, value: str | None = None) -> Any:
    if key is None:
        return dict(sorted(os.environ.items()))
    if value is not None:
        os.environ[key] = value
        return value
    return os.environ.get(key)


def read(path: str | Path, offset: int = 1, limit: int | None = None) -> str:
    data = Path(path).read_text(encoding="utf-8")
    if offset > 1 or limit is not None:
        lines = data.splitlines(keepends=True)
        start = max(0, offset - 1)
        end = start + limit if limit is not None else len(lines)
        return "".join(lines[start:end])
    return data


def write(path: str | Path, content: str) -> str:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return str(target)


def parallel(callables: list[Any], width: int = 4) -> list[Any]:
    with ThreadPoolExecutor(max_workers=max(1, width)) as pool:
        return list(pool.map(lambda fn: fn(), callables))


def pipeline(items: list[Any], *stages: Any) -> list[Any]:
    values = items
    for stage in stages:
        values = parallel([lambda item=item: stage(item) for item in values])
    return values


class ToolProxy:
    def __getattr__(self, name: str) -> Any:
        def call(args: Any = None) -> Any:
            return bridge_post({"kind": "tool", "toolName": name, "args": {} if args is None else args})
        return call


def completion(prompt: str, **options: Any) -> Any:
    return bridge_post({"kind": "completion", "prompt": prompt, "options": options})


def bridge_post(payload: dict[str, Any]) -> Any:
    port = CONNECTION.get("port")
    token = CONNECTION.get("token")
    if not isinstance(port, int) or not isinstance(token, str):
        raise RuntimeError("Python tool bridge is not initialized")
    data = json.dumps(payload, ensure_ascii=False, default=repr).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/call",
        data=data,
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = json.loads(exc.read().decode("utf-8"))
    if isinstance(body, dict) and body.get("ok") is True:
        return body.get("value")
    error = body.get("error") if isinstance(body, dict) else body
    if isinstance(error, dict):
        raise RuntimeError(str(error.get("message", error)))
    raise RuntimeError(str(error))


tool = ToolProxy()
USER_NS.update({
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
})

TLA_FLAG = getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0x2000)


def compile_cell(source: str) -> tuple[Any | None, Any | None]:
    module = ast.parse(source, mode="exec")
    if not module.body:
        return None, None
    last = module.body[-1]
    if isinstance(last, ast.Expr):
        body = ast.Module(body=module.body[:-1], type_ignores=[])
        expr = ast.Expression(body=last.value)
        ast.copy_location(expr, last)
        return compile(body, "<cell>", "exec", flags=TLA_FLAG), compile(expr, "<cell>", "eval", flags=TLA_FLAG)
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
            body, expr = compile_cell(code)
            LOOP.run_until_complete(run_code(body, False))
            value = LOOP.run_until_complete(run_code(expr, True))
        text("stdout", stdout.getvalue())
        text("stderr", stderr.getvalue())
        result: dict[str, Any] = {"type": "result", "cellId": cell_id, "ok": True, "durationMs": elapsed(start)}
        if value is not None:
            result["valueRepr"] = repr(value)
        emit(result)
    except BaseException as exc:
        text("stdout", stdout.getvalue())
        text("stderr", stderr.getvalue())
        emit({"type": "result", "cellId": cell_id, "ok": False, "error": bridge_error(exc), "durationMs": elapsed(start)})


def elapsed(start: float) -> int:
    return max(0, int((time.monotonic() - start) * 1000))


def handle(message: dict[str, Any]) -> bool:
    global SESSION_ID, CONNECTION
    typ = message.get("type")
    if typ == "init":
        SESSION_ID = str(message.get("sessionId", ""))
        connection = message.get("connection")
        if not isinstance(connection, dict):
            emit({"type": "init-failed", "error": {"message": "missing bridge connection"}})
            return True
        CONNECTION = connection
        emit({"type": "ready"})
        return True
    if typ == "run":
        run_cell(str(message.get("cellId", "")), str(message.get("code", "")))
        return True
    if typ == "close":
        emit({"type": "closed"})
        return False
    return True


def main() -> None:
    for raw in sys.stdin:
        try:
            if not handle(json.loads(raw)):
                break
        except BaseException as exc:
            emit({"type": "init-failed", "error": bridge_error(exc)})


if __name__ == "__main__":
    main()
