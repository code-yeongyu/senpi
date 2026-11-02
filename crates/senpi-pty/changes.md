## 2026-09-30 - Drop self-comparing unit tests from lib.rs (senpi#2447)

### What changed

- `crates/senpi-pty/src/lib.rs` loses its `#[cfg(test)] mod tests` block: `version_matches_crate_version`, `abi_sentinel_matches_abi_version` and `portable_pty_backend_is_linked`.

### Why

- Each one compared a function with the constant or macro it returns, or only called `native_pty_system()`, which every session test already calls.
- The ABI sentinel is proven through the real prebuild by `packages/pty/test/native-lifecycle.test.ts`.

### Why an extension could not handle it

- Repository scripts, CI and native crate test code.

### Expected merge conflict zones

- LOW: the tail of `lib.rs` above `mod session_tests;`.

# changes

## 2026-09-27 - A draining session no longer injects a newline into a terminal another fork can still see (senpi#2161)

### What changed

- `crates/senpi-pty/src/session.rs`: `drain_output` clears the terminal's VEOF character before dropping the writer, so portable-pty's writer drop, which writes `\n` + VEOF to hand a live child an EOF, writes nothing once the child has exited.
- `crates/senpi-pty/src/session_tests.rs`: `concurrent_session_spawns_never_leak_bytes_into_another_session` runs 200 sessions while four threads keep spawning others, and fails if any session sees a byte its child did not print.
- `packages/pty/native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node`: rebuilt from the fixed source.

### Why

- While another thread's freshly forked child still held this terminal's slave between its fork and exec, the line discipline echoed that `\n` back as `\r\n` into the session's output: 10 of 20 parallel runs on ubuntu-22.04, and about 100 of 200 sessions in the new test.

### Why an extension could not handle it

- Native session lifecycle in the PTY crate.

### Expected merge conflict zones

- LOW: `drain_output` in `session.rs`.

## 2026-09-21 - Update the native build CLI (senpi#1895)

### What changed

- `crates/senpi-pty/package.json`: Updated the native build CLI to @napi-rs/cli 3.10.4.

### Why

- Keep the native addon build tooling on the reviewed 3.10.4 release.

### Why an extension could not handle it

- The package manager resolves development tools before extensions load.

### Expected merge conflict zones

- The development dependency pins in `crates/senpi-pty/package.json`.
