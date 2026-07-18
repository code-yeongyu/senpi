# neo (Go TUI) — coding-agent integration notes

> Minimal scaffold. Expanded by plan task 22 (docs + infra-sync). This file
> currently covers only the pieces landed by task 15 (the TypeScript daemon).

## Overview

`senpi --neo` launches a Go-native terminal UI that drives the existing agent
runtime over the JSONL RPC protocol. Multiple neo windows in the SAME cwd share
one backend via a small TypeScript **daemon**, instead of each spawning its own
runtime. `--neo-isolated` opts out of sharing (per-instance stdio backend).

## Daemon architecture (task 15)

### Process model

- `senpi --listen <socket>` runs the daemon **supervisor**. It binds the socket,
  self-registers, and serves connections. It does NOT construct an
  `AgentSessionRuntime` in the supervisor process.
- Each accepted connection is served by its own child `senpi --mode rpc`
  **worker** process, spawned with the connection's cwd and its own
  `SENPI_CODING_AGENT_DIR`. The worker is a standard single-connection rpc
  runtime with its own module state and its own `AuthStorage`.

### Why one worker process per connection (isolation)

Running N `createAgentSessionRuntime` instances concurrently in ONE node process
is not safe: pi-ai keeps a **process-global provider registry** that
`ModelRegistry.refresh()` / `AgentSession.reload()` reset
(`resetApiProviders()` / `resetOAuthProviders()`), and pi-agent-core mints entry
IDs from a **module-level UUIDv7 counter**. Two concurrent in-process runtimes
would cross-talk through both. Both live in shared libraries that are out of
scope to change, so the daemon uses child-process workers instead — real
concurrency, full isolation, and `--api-key` that can never leak across
connections. See `.omo/evidence/task-15-neo-go-tui.md` §1 for the full spike.

### Handshake

A connection's first line is a `hello`:

```json
{"type":"hello","token":"<registry token>","version":1,"capabilities":[],"runtimeOptions":{...}}
```

The daemon replies `{"type":"welcome","version":1}` or
`{"type":"refuse","code":"bad_token|version_mismatch|unsupported_options|malformed_hello","reason":"..."}`.
`runtimeOptions` is the typed `NeoRuntimeOptions` payload (every classic runtime
flag: provider/model/models/thinking/api-key, session selection, approval, tool
scoping, resource loading, system prompt overrides, extension flags, and raw
initial inputs). Its field
set is generated from the classic runtime-construction path by an extraction
test — a new consumer of a `parsed.*` field fails the test until it is threaded
through the payload or documented as a carve-out.

**Carve-out:** piped-stdin input never reaches the daemon — a TTY-less
`senpi --neo` falls back to classic print-mode in the launcher.

### Registry / race protocol

- The daemon binds the socket FIRST — the bind is the mutex. The race loser gets
  `EADDRINUSE` and its client attaches to the winner.
- After a successful `listen`, and only with `--register`, the daemon atomically
  writes `~/.senpi/agent/neo-daemon/<cwd-key>.json` (temp file + `rename`, mode
  `0600`) as the LAST listen step. `<cwd-key>` uses the same safe-path scheme as
  the session manager. Clients NEVER write the registry.
- On spawn, a stale record (dead pid) and its leftover socket file are cleaned up
  before binding.

### Connection lifecycle

There is no live-reattach lease. A socket disconnect aborts that connection's
in-flight turn and disposes its worker. Sessions persist incrementally to disk,
so recovery is resume-from-file (the Go client reloads via `get_state` +
`get_entries{since}`). The daemon shuts down after a configurable no-connection
idle period (`neoDaemon.idleShutdownMs` setting, default 30 minutes; `0`
disables). The last client does NOT kill the daemon — the idle timer owns
lifecycle.

## Project-trust semantics in the daemon

Each worker runs `--mode rpc`, which is **non-interactive**. In rpc mode the
project-trust context has `hasUI: false`, so `resolveProjectTrusted` returns
`false` for project-local resources unless:

- the global `defaultProjectTrust` setting is `"always"`, or
- the connection passes `--approve` (`projectTrustOverride: true`) in its
  `runtimeOptions`.

This is the same behavior as classic `senpi --mode rpc` today (the daemon adds no
new trust surface). The classic **interactive** TUI prompts for trust; the neo
client is responsible for surfacing an equivalent confirm through the
extension-UI bridge and forwarding the user's choice as `--approve`/`--no-approve`
(wired in plan task 13). No project-local code is trusted implicitly by the
daemon.

## cwd-threading audit (per-user-daemon safety)

Verdict: **per-cwd, child-per-connection is safe** with respect to cwd.

- There are **zero** `process.chdir()` calls in `packages/coding-agent/src`.
- Tool execution is closure-captured: each tool is created with an explicit
  `cwd` (from `AgentSession.config.cwd`) and threads it to every spawn/path call.
  The bash tool passes `cwd` explicitly to `spawn(...)`; it never inherits
  `process.cwd()`.
- `resolvePath()` / `SessionManager` fall back to `process.cwd()` only as a
  default when no explicit base/cwd is given; the runtime path always passes one.
- Because each connection is its own child process spawned with an explicit
  `cwd`, the child's `process.cwd()` is already the client's directory, so even
  the fallback paths resolve correctly. No cross-connection cwd hazard remains.

Per-cwd remains the default regardless (one daemon serves one cwd).
