<!-- changes-log: packages/coding-agent/src/modes/interactive/changes.md -->
## 2026-11-24 - A terminal's fallback control socket stays in the temp directory 4 bytes longer (senpi#3758)

### What changed

- `packages/coding-agent/src/modes/interactive/session-control-registry.ts`: when `<agentDir>/rpc/tui/t-<16hex>.sock` is too long for `sun_path`, `resolveTuiSocket` now puts the socket directly in `<tmpdir>/senpi-rpc-<8hex>/` (no `tui/` level), falling back to `/tmp/senpi-rpc-<8hex>/` only when that is too long as well. A temp directory of up to 60 bytes (was 56) now holds the socket. The directory is still checked to be a private 0700 directory of this user.
- `scripts/run-tests.mjs`: the run-scoped temp root is sized against the same layout without the `tui/` level.

### Why

- The `tui/` level added 4 bytes and no isolation, because the per-agent directory holds only TUI sockets and their secrets. Leaving the owned temp directory for the shared `/tmp` is what #3064 set out to avoid. Under a long TMPDIR, the regression test's 58-byte temp root fell back to `/tmp` even though a 101-byte path inside it fits. The test now builds roots at exactly the boundary (60 and 61 bytes) under a short base, so it gives the same result on every host.

### Why an extension could not handle it

- The socket path is chosen in core while the terminal's control endpoint registers; no extension hook decides it.

### Expected merge conflict zones

- LOW: `session-control-registry.ts` is fork-only.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Fixed
- A terminal control socket that does not fit under a deep agent directory now stays inside a temp directory of up to 60 bytes instead of moving to `/tmp` beyond 56 bytes ([#3758](https://github.com/code-yeongyu/senpi/issues/3758))
