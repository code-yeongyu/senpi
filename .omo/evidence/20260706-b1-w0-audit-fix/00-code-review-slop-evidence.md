# W0 audit fix code-review/slop evidence

Scope reviewed:

- `packages/pty/src/loader.ts`
- `packages/pty/test/loader.test.ts`
- `packages/pty/native/check-prebuild-fresh.mjs`
- `scripts/check-pty-prebuild-fresh.test.mjs`
- `crates/senpi-pty/src/lib.rs`
- `scripts/devenv-setup.mjs`
- `packages/pty/README.md`
- `.omo/plans/persistent-terminal-tool.md`
- `Cargo.lock`

## Blocker review

- Public loader/package layout mismatch: fixed. `getNativePtyCandidatePaths()` now searches `native/prebuilds/<host>/senpi_pty.<host>.node`, which matches `packages/pty/native/index.js`, `check-prebuild-fresh.mjs`, and the package `files` layout. Runtime remains in `NativePtyUnavailableDiagnostic.runtime` only.
- Overfit loader tests: fixed. `packages/pty/test/loader.test.ts` no longer hardcodes `native/<runtime>/prebuilds`; it asserts the shared shipped layout for Node and Bun and includes a real host-layout probe that loads the vendored prebuild when present.
- Locked Rust build: fixed by tracking root `Cargo.lock`; verification includes `cargo metadata --locked` from an archive of the final commit.
- Clippy: fixed by adding `Default` for `NativePtySession`.
- Missing plan reference: fixed by restoring `.omo/plans/persistent-terminal-tool.md` from the source plan copy; sha256 matches `/Users/yeongyu/local-workspaces/senpi/.omo/plans/persistent-terminal-tool.md`.
- Missing W0 review/slop coverage: this artifact records the explicit review, and `DONECLAIM.md` points to command logs.

## Slop/overfit pass

- Excessive/implementation-mirroring tests: the prior runtime-specific path assertions were replaced with package-layout assertions and a real vendored path probe.
- Test-only fake behavior masking production failure: the focused loader test now calls `loadNativePty()` against `packages/pty/native/prebuilds/<current-host>` when the host prebuild exists. The full evidence also drives built `dist/index.js` via Node and Bun when Bun is installed.
- Unused test options: removed `skipBuild` from `scripts/check-pty-prebuild-fresh.test.mjs`; `builtFile` is the actual bypass.
- Dead code/debug leftovers: no `as any`, `@ts-ignore`, `@ts-expect-error`, `native/node/prebuilds`, or `native/bun/prebuilds` remain in the changed loader/test scope.
- Oversized setup file: `scripts/devenv-setup.mjs` remains a single bootstrap entry point by design and now carries a first-five-line `// @allow SIZE_OK` marker with an explicit split trigger.

## Review conclusion

APPROVE for W0 audit blockers after the verification commands in `DONECLAIM.md` pass and their artifact files are non-empty.
