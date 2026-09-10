# crates/senpi-pty

`senpi-pty` is the Rust/N-API native PTY implementation consumed by `packages/pty` and bundled into Senpi binaries. Score 9: code-heavy native ABI boundary, Cargo/NAPI configuration, dense symbols and public methods.

## STRUCTURE

```text
src/lib.rs              N-API exports, ABI marker, JS callback delivery, waitExit reaper
src/session.rs          PTY lifecycle, background waiting, output drain, ConPTY handshake
src/session_threads.rs  Reader and timeout threads
src/signals.rs          Platform signal/process-tree handling
src/session_tests.rs    In-crate lifecycle tests
tests/manual_qa.rs      Manual native QA harness
build.rs                N-API build setup
index.js, index.d.ts     Node package loader/types
```

## ABI CONTRACT

- `NATIVE_PTY_ABI_VERSION = "1"` in `packages/pty/src/loader.ts` and the exported `__senpiPtyAbi1` marker must agree; the Rust constant lives in `src/lib.rs`. `native-loader.ts` is only a compatibility re-export.
- ABI versioning is intentionally separate from CalVer. Change it only for an incompatible native contract and update both crate and loader tests.
- `index.js` and `index.d.ts` are NAPI-RS-generated loader output; never hand-edit them. With the crate's NAPI CLI installed, regenerate from the repo root with `bun run --cwd crates/senpi-pty build` (`napi build --platform`). This crate is a Cargo member, not a root JavaScript workspace.
- Keep the six targets declared in `package.json` aligned with `.github/workflows/native-prebuilds.yml`. The crate-root checked-in `.node` is darwin-arm64 only; runtime candidates live under `native/prebuilds/<host>/`, staged through `packages/pty/native/`.
- A crate rebuild alone does not refresh vendored prebuilds. Missing or quarantined bindings permit the TypeScript pipe fallback; ABI sentinel mismatches throw instead of silently falling back.

## LIFECYCLE INVARIANTS

- Session exit is reported exactly once despite reader EOF, waiter completion, kill, drop, or startup-error races.
- Kill and cleanup terminate the process tree, not only the immediate shell child.
- Keep N-API callback state alive until output delivery finishes; `start_pty_session` waits for each JS callback before reading onward.
- Close the PTY writer/master before joining the reader in `drain_output`; ConPTY does not produce EOF merely because its child exits.
- Answer the first ConPTY startup cursor-position query even if the consumer already wrote; later queries pass through after the first consumer write.
- Signal behavior remains platform-aware; preserve paired Unix/Windows semantics when changing process control.

## ANTI-PATTERNS

- Do not expose secret-bearing environment data through diagnostics or errors.
- Do not route native compilation through root JavaScript workspace flags or assume a local `.node` is the shipped prebuild.

## WHERE TO LOOK

| Task | Path |
|---|---|
| N-API/ABI export | `src/lib.rs` |
| Spawn, resize, write, kill | `src/session.rs` |
| Reader/timeout threads | `src/session_threads.rs`; waiting/draining in `src/session.rs` |
| Signals/process tree | `src/signals.rs` |
| TypeScript loader contract | `packages/pty/src/loader.ts` |
| Prebuilt packaging | `packages/pty/native/` and root copy scripts |

## VALIDATION

- Run `cargo test -p senpi-pty` from the repository root.
- From the repo root: `bun run --cwd packages/pty test` and `bun run --cwd packages/pty check:prebuild` after native changes. The latter rebuilds and compares the host's vendored binary.
- Native lifecycle QA: `cargo test -p senpi-pty --test manual_qa -- --nocapture`; `.github/workflows/native-prebuilds.yml` also runs `scripts/probe-native-pty-lifecycle.mjs` against built artifacts on native runner targets.
- Native lifecycle changes require manual PTY QA on affected platforms plus root `bun run check`.
