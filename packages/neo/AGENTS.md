# packages/neo

`senpi-neo` is an independent Go module implementing an alternate Bubble Tea TUI over Senpi's TypeScript RPC protocol.

## STRUCTURE

```text
cmd/senpi-neo/        Binary entry
internal/app/         Bubble Tea model, session wiring, recovery
internal/bridge/      JSONL/RPC transport, daemon attach, protocol mirror
internal/store/       Auth, settings, sessions, themes, clipboard
internal/ui/          Editor, transcript, overlays, slash commands, shell
qa/                   ANSI/HTML/grid visual evidence and claims
neo-test.sh           Source test launcher
```

## INVARIANTS

- `internal/bridge/types.go` mirrors the TypeScript RPC contract. Update fixtures and exhaustive protocol tests when either side changes.
- Preserve newline-delimited JSON framing, request/response correlation, event demultiplexing, handshake, and reconnect/recovery behavior.
- Keep platform-specific socket, signal, process-liveness, and spawn files paired across Unix and Windows.
- Bubble Tea updates remain deterministic; long work returns commands/messages rather than blocking `Update`.
- Keybindings and themes load through store/registry layers; do not hardcode UI shortcuts or colors in feature code.
- Unicode width, wrapping, cursor position, image protocols, and terminal capability behavior require explicit tests.

## WHERE TO LOOK

| Task | Path |
|---|---|
| RPC schema or transport | `internal/bridge/` |
| Session/application state | `internal/app/` |
| Editor/key behavior | `internal/ui/editor/`, `internal/ui/keybindings/` |
| Transcript rendering | `internal/ui/transcript/` |
| Persisted config/auth | `internal/store/` |
| Visual contract | `qa/visual-claims*.json` and `qa/triplets/` |

## VALIDATION

- From this directory run `go build ./...`, `go vet ./...`, and `go test ./...`.
- Root `npm run check:neo` is the repository integration gate.
- UI changes run the matching `go run ./internal/<area>/qaharness` command and verify captured manifests with `node qa/xterm-render.mjs verify-manifest <manifest.json>` at representative widths.
- Protocol changes require bridge fixture, transport, handshake, and exhaustive compatibility tests.
- Read `internal/bridge/AGENTS.md` for protocol/daemon work and `internal/ui/AGENTS.md` for visual or interaction work.
