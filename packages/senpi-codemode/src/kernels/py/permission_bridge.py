"""Synchronous, invocation-scoped permission checks over the existing loopback bridge."""
import contextvars
import builtins
import json
import mmap
import os
import socket
import _socket
import struct
import time
import importlib
import importlib.util
from typing import NoReturn

__builtins__ = vars(builtins).copy()

_interpose_path = os.path.join(os.path.dirname(__file__), "interpose.py")
_spec = importlib.util.spec_from_file_location("_senpi_interpose", _interpose_path)
if _spec is None or _spec.loader is None:
    raise RuntimeError("Python permission interposition asset is unavailable")
_module = importlib.util.module_from_spec(_spec)
# Engine assets are source-only; loading them must never populate the checkout.
with open(_interpose_path, "rb") as _source:
    exec(compile(_source.read(), _interpose_path, "exec"), _module.__dict__)
install = _module.install


class CellPermissionError(RuntimeError):
    code = "cell_permission_denied"

    def __init__(self, reason, rule=None):
        self.permissionRule = rule
        identity = (f"{rule['permission']} {rule['pattern']} ({rule['layer']})"
                    if rule else "permission authority unavailable")
        super().__init__(f"Cell operation refused: {identity}: {reason}")


def initialize(config, port):
    # The mapping and captured I/O never enter the user namespace.
    with open(config["path"], "rb") as file:
        words = mmap.mmap(file.fileno(), config["size"], access=mmap.ACCESS_READ)
    context = contextvars.ContextVar("senpi_permission", default=None)
    getcwd = os.getcwd
    unpack_from = struct.unpack_from
    random_bytes = os.urandom
    # The C scanner/encoder retain their dependencies too: merely capturing
    # json.loads/dumps still leaves mutable decoder/encoder method lookups.
    encode = getattr(json.encoder, "c_make_encoder")({}, None, json.encoder.encode_basestring_ascii,
                                                   None, ": ", ", ", False, False, True)
    decode = getattr(json.JSONDecoder(), "scan_once")
    monotonic = time.monotonic
    socket_type = _socket.socket
    family, stream = socket.AF_INET, socket.SOCK_STREAM
    connect, sendall, recv = socket_type.connect, socket_type.sendall, socket_type.recv
    settimeout, close = socket_type.settimeout, socket_type.close

    def rule():
        token = context.get()
        rules = token.get("rules", []) if token else config.get("rules", [])
        return rules[0] if rules else None

    def refuse(reason, deciding_rule=None) -> NoReturn:
        raise CellPermissionError(reason, deciding_rule or rule())

    def enforcing():
        token = context.get()
        offset = token["offset"] if token else 0
        word = unpack_from("<Q", words, offset)[0]
        if not word & 2:
            # Settled inactive contexts retain ordinary background I/O, but a
            # dead/enforcing kernel can never be revived by that expired token.
            kernel_word = unpack_from("<Q", words, 0)[0]
            if word & 1 or kernel_word & 3 != 2:
                refuse("authority revoked")
            return False
        if token is None and word & 1:
            refuse("operation has no invocation authority")
        return bool(word & 1)

    def check(tool, input, cwd=None):
        if not enforcing():
            return
        token = context.get()
        if token is None:
            refuse("operation has no invocation authority")
        nonce = random_bytes(16).hex()
        payload = "".join(encode({"token": token["id"], "nonce": nonce,
                                 "call": {"tool": tool, "input": input, "cwd": cwd or getcwd()}}, 0)).encode()
        deadline = monotonic() + 2.0
        sock = None
        try:
            sock = socket_type(family, stream)
            if sock is not None:
                def remaining():
                    seconds = deadline - monotonic()
                    if seconds <= 0:
                        raise TimeoutError("permission deadline")
                    settimeout(sock, seconds)
                remaining()
                connect(sock, ("127.0.0.1", port))
                remaining()
                sendall(sock, b"POST /permission_check HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                             b"Connection: close\r\nContent-Type: application/json\r\nContent-Length: " +
                             str(len(payload)).encode() + b"\r\n\r\n" + payload)
                response = bytearray()
                while True:
                    remaining()
                    chunk = recv(sock, 16384)
                    if not chunk:
                        break
                    response.extend(chunk)
                    if len(response) > 32768:
                        raise ValueError("oversized permission response")
                header, body = bytes(response).split(b"\r\n\r\n", 1)
                if not header.startswith(b"HTTP/1.1 200 "):
                    raise ValueError("permission HTTP failure")
                # Node sends chunked responses unless Content-Length is set by the bridge.
                text = body.decode().strip()
                reply, end = decode(text, 0)
                if end != len(text):
                    raise ValueError("trailing permission response")
                value = reply["value"]
                if reply.get("ok") is not True or value.get("nonce") != nonce:
                    raise ValueError("permission nonce mismatch")
                decision = value["decision"]
                enforcing()  # A late allow cannot cross revocation.
                if decision.get("action") == "pass":
                    return
                deciding_rule = decision.get("rule")
                if decision.get("action") == "deny" and isinstance(deciding_rule, dict) and all(
                    isinstance(deciding_rule.get(key), str) for key in ("permission", "pattern", "layer")
                ):
                    refuse(str(input), deciding_rule)
                raise ValueError("invalid permission decision")
        except CellPermissionError:
            raise
        except BaseException as exc:
            # KeyboardInterrupt must leave the parked check immediately, never wait for the host.
            refuse(f"permission check failed ({type(exc).__name__})")
        finally:
            if sock is not None:
                close(sock)

    install(check, enforcing, refuse, config["runtime"])
    return context
