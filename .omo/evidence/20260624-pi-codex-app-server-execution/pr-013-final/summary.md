# PR-013 Final Compatibility Evidence Packet

This work is using code-yeongyu/lazycodex teammode.

## Scope

PR-013 is evidence-only. It captures the final compatibility/manual QA packet for the accepted pi-codex app-server adapter surfaces after PR-012 merge commit `d9d0956093d60844f2389097729ba17824548bff` and latest base `5ad3234baf4d60041d4ff4fddc9da68951f5aed3`.

No product code changed in this PR.

## Evidence Root

Local raw/sanitized artifacts are under:

`local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-013-final/`

Reviewer packet generated via the PR-012 packet writer:

`local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-013-final/reviewer-packet/`

## Commands And Results

- Full app-server suite: `commands/full-pi-codex-app-server-suite.txt` -> PASS, 17 files / 64 tests.
- Targeted extension/runtime/flow suite: `commands/targeted-extension-runtime-flow.txt` -> PASS, 9 files / 44 tests.
- Stdio runtime smoke: `commands/stdio-runtime-smoke.txt` -> PASS.
- Unix/proxy runtime smoke: `commands/unix-proxy-runtime-smoke.txt` -> PASS.
- Shared websocket runtime smoke: `commands/websocket-runtime-smoke.txt` -> PASS.
- Actual installed `codex --remote`: `commands/codex-remote-tmux-smoke.txt` -> PASS, tmux-backed run observed websocket handshake.
- `npm run check`: `commands/npm-run-check.txt` -> PASS.
- senpi QA CLI smoke: `commands/senpi-qa-cli-smoke.txt` -> PASS, real auth unchanged.
- senpi QA RPC drive: `commands/senpi-qa-rpc-drive.txt` -> PASS, real auth unchanged.
- senpi QA mock-loop: `commands/senpi-qa-mock-loop.txt` -> PASS, zero real provider calls and real auth unchanged.
- Scenario matrix redaction scan: `commands/scenario-matrix-redaction-scan.txt` -> PASS.
- Reviewer packet writer: `commands/reviewer-packet-writer.txt` -> PASS.
- Evidence root redaction scan: `commands/evidence-root-redaction-scan.txt` -> PASS.

## Manual QA Matrix

Each scenario directory under `scenario-matrix/` contains non-empty `sanitized-transcript.jsonl`, `assertions.json`, `redaction-report.txt`, and `cleanup-receipt.txt`.

| Scenario | Result | Coverage |
| --- | --- | --- |
| 00 initialize-negotiation | PASS | capability negotiation and opaque relay requirements |
| 01 thread-start | PASS | session/new to app-server thread binding |
| 02 thread-resume | PASS | session/resume with authoritative app-server ids |
| 03 thread-fork | PASS | session/fork routing and id preservation |
| 04 thread-list-read | PASS | session/list and session/read routing |
| 05 thread-archive-delete | PASS | archive/delete tombstone behavior |
| 06 turn-start-steer-interrupt | PASS | turn routing and expected app-server turn guard |
| 07 item-streaming | PASS | item started/delta/progress/completed projection |
| 08 command-approval | PASS | command approval server-request callback |
| 09 file-permission-approval | PASS | file and permissions callback rejection |
| 10 request-user-input | PASS | secret input callback redaction |
| 11 dynamic-tool | PASS | dynamic tool structured callback payload |
| 12 mcp-tool-elicitation | PASS | MCP tool progress and elicitation compatibility |
| 13 terminal-streaming | PASS | terminal/raw/progress stream projection |
| 14 transport-lifecycle | PASS | stdio, unix/proxy, websocket, and installed `codex --remote` handshake |
| 15 reconnect-resume | PASS | resume snapshot, replay cursor, pending callback durability |
| 16 backpressure-lag | PASS | lossless queue, best-effort lag, overload `-32001` |
| 17 realtime-fs-config | PASS | filesystem, realtime, plugin, config, remote-control pass-through |
| 18 negative-compatibility | PASS | unsupported protocol/capability/callback errors remain explicit |
| 19 secret-safety | PASS | PR-012 redaction packet and seeded fake-secret fail-closed scanner |

## Cleanup Receipt

`cleanup-receipt.txt` records zero owned child processes, websockets, sockets, tmux sessions, temp resources, browser contexts, containers, and QA-only env files left behind.

The temporary `node_modules` symlink used for local source verification was removed before staging. The external CodeGraph daemon socket was temporarily moved to `/tmp` during `npm run check` to avoid Biome's socket-file warning and restored afterward; see `commands/codegraph-check-workaround.txt`.

## Secret Safety

- Reviewer packet generation sanitizes commands, transcripts, assertion names/details, summary, and residual risks.
- A seeded fake secret was included in the temp packet input and is absent from packet output.
- `commands/evidence-root-redaction-scan.txt` reports `PASS no secret leaks found` over the PR-013 evidence root.
- No raw auth headers, bearer tokens, cookies, launchd environments, real auth files, or private credentials are committed.

## GitHub Project Status

`BLOCKED:missing-gh-project-scope`

`gh project list --owner code-yeongyu --format json --limit 20` failed because the token lacks `read:project`. See `commands/gh-project-list.err` and `commands/project-tracking-status.txt`.

## Residual Risks

- PR-013 proves compatibility through accepted adapter tests, local runtime transport smokes, installed `codex --remote` websocket handshake, senpi QA, and sanitized packet evidence. It does not change product behavior.
- The installed `codex --remote` smoke proves endpoint connection/handshake under a TTY; it does not run a full live upstream remote-control session against a production app-server daemon.
