# crates/senpi-pty

`senpi-pty` is the Rust/N-API native PTY implementation consumed by `packages/pty` and bundled into Senpi binaries.

## STRUCTURE

```text
src/lib.rs              N-API exports and ABI marker
src/session.rs          PTY process/session lifecycle
src/session_threads.rs  Reader/waiter thread coordination
src/signals.rs          Platform signal/process-tree handling
src/session_tests.rs    In-crate lifecycle tests
tests/manual_qa.rs      Manual native QA harness
build.rs                N-API build setup
index.js, index.d.ts     Node package loader/types
```

## ABI CONTRACT

- `NATIVE_PTY_ABI_VERSION = "1"` in the TypeScript loader and the exported `__senpiPtyAbi1` marker must agree.
- ABI versioning is intentionally separate from CalVer. Change it only for an incompatible native contract and update both crate and loader tests.
- Keep the six targets declared in `package.json` aligned when changing exports or build paths. Checked-in/runtime prebuild coverage may be partial; missing native bindings intentionally use the TypeScript pipe fallback.

## LIFECYCLE INVARIANTS

- Session exit is reported exactly once despite reader EOF, waiter completion, kill, drop, or startup-error races.
- Kill and cleanup terminate the process tree, not only the immediate shell child.
- Reader/waiter threads cannot outlive released session ownership or call into freed N-API state.
- Signal behavior remains platform-aware; preserve paired Unix/Windows semantics when changing process control.
- Do not expose secret-bearing environment data through diagnostics or errors.

## WHERE TO LOOK

| Task | Path |
|---|---|
| N-API/ABI export | `src/lib.rs` |
| Spawn, resize, write, kill | `src/session.rs` |
| Thread coordination | `src/session_threads.rs` |
| Signals/process tree | `src/signals.rs` |
| TypeScript loader contract | `packages/pty/src/native-loader.ts` |
| Prebuilt packaging | `packages/pty/native/` and root copy scripts |

## VALIDATION

- Run `cargo test -p senpi-pty` from the repository root.
- Run package loader/ABI tests in `packages/pty` and `npm run check:prebuild` after native changes.
- Native lifecycle changes require manual PTY QA on affected platforms plus root `npm run check`.
