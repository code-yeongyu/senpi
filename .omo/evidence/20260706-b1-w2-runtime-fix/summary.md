# PR-B1 W2 Runtime Fix Evidence

Date: 2026-07-06
Worktree: `/Users/yeongyu/local-workspaces/senpi-wt/persistent-terminal-b1`

## Fixed blockers

- Public loader path now resolves shipped `native/prebuilds/<host>/senpi_pty.<host>.node`; `loadPtyNative()` loads the local darwin-arm64 prebuild from the built root export.
- `SessionRegistry` is exported from package root and `@earendil-works/pi-pty/registry`.
- `SessionRegistry.stop()` no longer marks a live session `exited`; when no wait/exit signal has completed it records `stopping` with `exitedAt: null`, and later refresh marks `exited`.
- `session.ts` and `registry.ts` were split by responsibility; every `packages/pty/src/*.ts` and `packages/pty/test/*.ts` file is under 250 pure LOC.
- Audit-listed assertion escape hatches were removed from loader, TerminalSession normalization, registry runtime process handling, and tests.

## Scenarios and artifacts

- Package regression tests: `npm test --workspace @earendil-works/pi-pty`
  - Observable: Vitest reported 5 files passed, 31 tests passed.
  - Artifact: `01-npm-test-pi-pty.log`; final rerun after formatting: `09-final-npm-test-pi-pty.log`.

- Package build: `npm run build --workspace @earendil-works/pi-pty`
  - Observable: `tsgo -p tsconfig.build.json` exited 0.
  - Artifact: `02-npm-build-pi-pty.log`; final rerun after formatting: `10-final-npm-build-pi-pty.log`.

- Repository check: `npm run check`
  - Observable: Biome/check/type/import/shrinkwrap/web-ui/neo gates exited 0.
  - Artifact: `03-npm-run-check.log`.

- Root export and loader probe: `node --input-type=module ... ./packages/pty/dist/index.js`
  - Observable: `rootSessionRegistry: "function"` and `nativeLoaded: true`.
  - Artifact: `04-root-loader-registry-probe.log`.

- Registry subpath probe: from `packages/pty`, `import("@earendil-works/pi-pty/registry")`
  - Observable: `registrySubpath: "function"`.
  - Artifact: `05-registry-subpath-probe.log`.

- Direct stop-state probe: built `dist/registry.js` with a slow stop session.
  - Observable: after `stop()`, state was `stopping`, `exitedAt` was null, and `sessionExited` was false; after exit refresh, state was `exited`.
  - Artifact: `06-stop-state-probe.log`.

- LOC scan: pure nonblank/noncomment LOC for `packages/pty/src/*.ts` and `packages/pty/test/*.ts`.
  - Observable: all scanned files are <=250 pure LOC.
  - Artifact: `07-loc-scan.log`.

- Assertion scan: banned suppression markers plus audit-listed `as ...` escape hatches.
  - Observable: no banned suppression markers; no audit-listed assertion escape hatches.
  - Artifact: `08-assertion-scan.log`.

## remove-ai-slops / programming coverage

- Loader: behavior locked by loader tests and root probe; cleanup removed runtime-specific path overfit and assertion-based sentinel calls. No deletion-only test remains; tests assert packaged path selection and native load behavior.
- TerminalSession: split into type/options/native/exit modules under the 250 LOC ceiling; native handle and exit normalization now use typed guards and narrowed locals instead of assertions. Existing session tests cover fallback lifecycle, raw tail, idempotent kill, native wrapping, data flow, and exit normalization.
- Registry: split into type/session/detached-child modules under the 250 LOC ceiling; `stopping` makes lifecycle state truthful instead of over-defensive `exited`. Regression test and direct probe cover the stopped-but-live state.

Secret safety: no tokens, auth headers, cookies, launchd environments, or raw secret-bearing logs were captured.
