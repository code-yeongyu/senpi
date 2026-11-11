"""SQLite URI filename parsing for the permission guard.

The guard must not read anything cell code can rebind, so this module uses no
imports: only str/bytes methods and the frozen builtins interpose.py executes it
with. It follows SQLite's own URI rules (sqlite3ParseUri) instead of urllib's:
'+' is not a space, the authority is dropped, and the fragment is ignored.
"""

_HEX = "0123456789abcdefABCDEF"


def _percent_decode(text):
    if "%" not in text:
        return text
    raw = text.encode("utf-8", "surrogateescape")
    decoded = bytearray()
    index, size = 0, len(raw)
    while index < size:
        byte = raw[index]
        if byte == 37 and index + 2 < size and chr(raw[index + 1]) in _HEX and chr(raw[index + 2]) in _HEX:
            decoded.append(int(raw[index + 1:index + 3].decode("ascii"), 16))
            index += 3
            continue
        decoded.append(byte)
        index += 1
    return bytes(decoded).decode("utf-8", "surrogateescape")


def parse_sqlite_uri(uri):
    rest = uri[5:]
    rest = rest.partition("#")[0]
    rest, _, query = rest.partition("?")
    if rest.startswith("//"):
        slash = rest.find("/", 2)
        rest = "" if slash < 0 else rest[slash:]
    modes = []
    for pair in query.split("&"):
        key, _, value = pair.partition("=")
        if _percent_decode(key) == "mode":
            modes.append(_percent_decode(value))
    return _percent_decode(rest), tuple(modes)
