# @code-yeongyu/senpi-codemode

Source-only senpi extension package for codemode: an in-progress port of
oh-my-pi feature 01, "Code execution w/ tool-calling".

The current package ships the codemode building blocks: settings loading,
interpreter detection, bridge protocol/server helpers, prompt text, persistent
language kernels, and prelude helpers. The exported extension factory is still a
no-op in this Wave 3 source, so installing this package does not yet register an
`eval` tool.

## Kernels

JavaScript is implemented with a Node.js worker and is always available when the
package runs on the supported Node version. Python, Ruby, and Julia are optional
runtime interpreters:

| Language | Default | Interpreter |
|----------|---------|-------------|
| `js` | enabled | Node.js worker |
| `py` | enabled | `python3` or `python` on POSIX; `python`, `py -3`, or `python3` on Windows |
| `rb` | disabled | `ruby` |
| `jl` | disabled | `julia` |

Missing optional interpreters should be treated as runtime capability gaps, not
install failures.

## Settings

Codemode reads standalone JSON config files. Project config wins over global
config:

1. `.senpi/codemode.json`
2. `~/.senpi/agent/codemode.json`
3. built-in defaults

```json
{
  "languages": {
    "py": true,
    "js": true,
    "rb": false,
    "jl": false
  },
  "cellTimeoutSeconds": 30,
  "parallelPoolWidth": 4
}
```

Invalid JSON or invalid schema falls back to defaults with a warning. These are
package-local settings; senpi's main `settings.json` has no `codemode` key in the
current source.

## Prelude API

The prompt and kernels expose a shared prelude contract for cells. Availability
depends on the language implementation and on whether the future `eval` tool is
wired into the host.

| Helper | Purpose |
|--------|---------|
| `display(value)` | Emit a cell result or rich display payload. |
| `print(value, ...)` | Emit text output. |
| `read(path, offset?, limit?)` | Read a text file with optional 1-indexed line slicing. |
| `write(path, content)` | Write a file, creating parent directories. |
| `env(key?, value?)` | Read or set environment values inside the kernel. |
| `tool.<name>(args)` | Call an active senpi tool through the host bridge. |
| `completion(prompt, ...)` | Request a one-shot host completion. |
| `parallel(thunks)` | Run thunks through a bounded pool while preserving result order. |
| `pipeline(items, ...stages)` | Map items through sequential pipeline stages. |
| `log(message)` | Emit a progress line. |
| `phase(title)` | Start a progress phase. |

Cells are intended to be incremental: one call is one logical step, and
top-level state persists per language until reset or kernel restart.

## Security

Kernels run locally with the same user permissions as senpi. The loopback bridge
binds to `127.0.0.1` and authenticates each request with a per-session bearer
token. Tool calls routed through `tool.<name>` are designed to pass through
senpi's normal permission system and extension hook pipeline via
`pi.executeTool`; that host integration is not yet wired in this package's
factory in the current source.

## Disable

Because the current factory registers no tools, there is nothing to disable yet.
After the planned `eval` tool and bundled loader land, the intended disable
surfaces are:

- `--exclude-tools eval`
- `disabledBuiltinExtensions: ["codemode"]` in senpi settings

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Python, Ruby, or Julia cells are unavailable | Confirm the interpreter is installed and visible on `PATH`; optional interpreters are not npm dependencies. |
| A cell times out | Increase `cellTimeoutSeconds` or the future per-call timeout only for genuinely long work. |
| State disappeared | The language kernel was reset, restarted, or crashed; rerun only the setup needed for that language. |
| `tool.<name>` or `completion()` is unavailable | The host `eval` tool integration is deferred in the current Wave 3 source. |
