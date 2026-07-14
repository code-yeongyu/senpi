# packages/neo/internal/bridge

Go bridge between the Neo TUI and Senpi's TypeScript RPC/daemon surfaces. This directory owns framing, correlation, protocol mirrors, spawn/attach, and recovery.

## STRUCTURE

```text
types.go              TypeScript RPC contract mirror
codec.go, demux.go    JSONL encode/decode and response/event routing
transport.go          Request correlation and connection lifecycle
connect.go            Connection establishment and handshake
daemonclient.go       Neo daemon control client
spawn*.go             Cross-platform child process startup
socket*.go            Unix socket / Windows pipe selection
recovery.go           Reconnect and self-heal behavior
runtimeopts.go        CLI option projection
testdata/              Generated real-protocol JSONL fixtures
attachqa/              Real attach/recovery QA harness
```

## INVARIANTS

- Preserve newline-delimited JSON framing and request/response correlation; events and responses may arrive interleaved.
- Disconnect, shutdown, and child exit must settle pending requests and background readers exactly once.
- `types.go` mirrors the TypeScript RPC contract. Update exhaustive tests and real fixtures whenever either side changes.
- Keep Unix and Windows socket, signal, process-liveness, and spawn implementations paired.
- Recovery must not create duplicate daemons or clients; registry repair and spawn races converge on one live endpoint.
- Child processes currently inherit the environment and raw stderr may enter errors. Treat diagnostics as secret-bearing, avoid widening their exposure, and do not claim redaction without implementing it.

## FIXTURES AND VALIDATION

- Generate protocol fixtures through `testdata/gen-fixtures.mjs`; do not hand-author replacements for real wire captures.
- Run focused bridge tests, then `go test ./internal/bridge/...` from `packages/neo`.
- Transport or daemon changes also run `go build ./...`, `go vet ./...`, `go test ./...`, and the relevant `attachqa` scenario.
- RPC contract changes require the matching TypeScript coding-agent RPC tests; add app-server coverage only when shared daemon or transport behavior changes.
