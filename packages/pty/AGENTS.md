# packages/pty

`@earendil-works/pi-pty` is the TypeScript PTY facade: native loader, sessions, detached registry, headless screen, and non-PTY pipe fallback.

## STRUCTURE

```text
src/loader.ts, native-loader.ts  Native prebuild discovery and ABI checks
src/session.ts                   Public session lifecycle
src/session-native.ts            Native backend adapter
src/pipe-fallback.ts             child_process fallback when native is absent
src/session-exit.ts              Exit settlement helpers
src/registry*.ts                 Session registry and detached ownership
src/screen.ts                    Headless terminal screen state
native/prebuilds/                Shipped platform binaries
native/check-prebuild-fresh.mjs  Prebuild freshness gate
```

## INVARIANTS

- The native ABI constant is intentionally independent of package CalVer. Keep it aligned with `crates/senpi-pty` exports.
- Unsupported or missing native bindings select the pipe fallback with a diagnostic; fallback behavior must never be presented as a real PTY.
- Exit notification settles exactly once across native exit, child exit, startup failure, kill, and disposal races.
- `kill()` is idempotent and detached-child cleanup owns the full process tree.
- Bound retained raw output/tails; persistent sessions must not grow memory without limit.
- Registry IDs, detached process metadata, stop, and removal remain explicit. The current registry has no caller-authorization model; do not claim owner isolation without adding one.

## WHERE TO LOOK

| Task | Path |
|---|---|
| Native loading/ABI | `src/loader.ts`, `src/native-loader.ts` |
| Session lifecycle | `src/session.ts`, `src/session-exit.ts` |
| Fallback process behavior | `src/pipe-fallback.ts` |
| Detached sessions | `src/registry.ts`, `src/registry-detached.ts` |
| Screen parsing | `src/screen.ts` |
| Native implementation | `crates/senpi-pty/` |

## VALIDATION

- Run `npm test` from this package.
- Run `npm run check:prebuild` when native artifacts or ABI loading changes.
- Lifecycle changes need focused race tests for exactly-once exit, idempotent kill, and process-tree cleanup.
- Run root `npm run check` for repository integration.
