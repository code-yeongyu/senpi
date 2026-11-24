<!-- changes-log: packages/coding-agent/src/modes/interactive/changes.md -->
## 2026-11-24 - The shared fallback TUI socket directory is removed with its last terminal (senpi#7423)

### What changed

- `packages/coding-agent/src/modes/interactive/session-control-registry.ts`: `resolveTuiSocket` writes the socket's secret into the fallback `senpi-rpc-<8hex>/` directory before it returns and checks the directory's privacy again afterwards. `unregisterTuiEndpoint` and `unregisterTuiEndpointSync` then remove that directory when it is empty; a directory still holding another terminal's socket or secret stays. The primary `<agentDir>/rpc/tui/` directory is never removed.

### Why

- Every terminal of a deep agent directory shares one `senpi-rpc-<8hex>/` directory in the temp root, and nothing removed it, so one was left behind for every such agent directory. Writing the secret before the path is returned means the directory is never empty while a terminal that resolved it is still starting, so a sibling's exit cannot remove it under that terminal.

### Why an extension could not handle it

- The socket directory is chosen and cleaned up in core while the terminal's control endpoint registers and exits; no extension hook owns it.

### Expected merge conflict zones

- LOW: `session-control-registry.ts` is fork-only.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Fixed
- A terminal's fallback control-socket directory (`senpi-rpc-<8hex>/` in the temp directory) is removed when the last terminal using it exits, instead of staying behind ([#7423](https://github.com/code-yeongyu/senpi/issues/7423))
