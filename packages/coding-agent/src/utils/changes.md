# changes

## Repository audit baseline for the utils tracker (2026-08-17)

### What changed

- This entry is the canonical inventory for the repository-wide changes.md audit (`scripts/audit-changes-md.mjs`, pin
  `914cf1472e715297caa30db4b9535d534a9eb718`, tag v0.84.2). It assigns every audited production path whose exact
  nearest tracker is this file, summarizing each fork delta; the dated history below it remains authoritative for the
  feature narrative. `packages/coding-agent/src/utils/tools-manager.ts` is already covered by the 2026-08-13 entry
  below.
- `packages/coding-agent/src/utils/child-process.ts`: abort-aware `waitForChildProcess` and post-exit stdout drain
  (dated entries below).
- `packages/coding-agent/src/utils/shell.ts`: synchronous Windows process-tree kill, shell-kind resolution for
  persistent terminals, and the sanitize fast path (dated entries below).
- `packages/coding-agent/src/utils/fs-watch.ts`: optional recursive-watch options (2026-07-21 entry below).
- `packages/coding-agent/src/utils/paths.ts`: shared `shortenPath()` display helper (2026-05-24 entry below).
- `packages/coding-agent/src/utils/version-check.ts` and `packages/coding-agent/src/utils/pi-user-agent.ts`:
  brand-aware update channel and outbound identity (own entry below).
- `packages/coding-agent/src/utils/clipboard-image.ts`: equivalent optional-chaining guard on the native image check
  (own entry below).
- `packages/coding-agent/src/utils/highlight-js-lib-index.d.ts`: deleted ambient module declaration, with
  `packages/coding-agent/src/utils/syntax-highlight.ts` importing the typed package entry instead (own entry below).

### Why

- The pre-backfill audit reported these paths uncovered because the entries that describe them predate the canonical
  four-section format (their conflict-zone headings carried suffixes) or never named the exact path. This inventory
  closes that gap without rewriting accurate history below.

### Why an extension could not handle it

- Tracker coverage is repository policy enforced by repository scripts before any extension loader exists; the paths
  themselves are shared leaf utilities beneath the extension API.

### Expected merge conflict zones

- NONE for this inventory: the tracker merges to `ours` and the path list is pin-relative.

## Brand-aware update channel and outbound identity (2026-08-17)

### What changed

- `packages/coding-agent/src/utils/version-check.ts`: latest-version checks query the npm registry
  (`registry.npmjs.org` package documents, or a brand update channel's dist-tags endpoint) instead of the engine's
  release site; `readAvailableVersion()` reads whichever document shape was fetched. Version comparison gained a
  Senpi CalVer comparator (`YYYY.M.D` with an optional hotfix component) ahead of the semver fallback, release notes
  link to the senpi changelog tag or the brand's changelog template, and the offline/skip gates read brand-scoped
  environment values. A brand without an update channel skips the check entirely: the engine's own releases are not
  installable from inside a branded distribution.
- `packages/coding-agent/src/utils/pi-user-agent.ts`: the update-check user agent identifies as
  `BRAND?.userAgent ?? APP_NAME` and defaults its version argument to `DISPLAY_VERSION`.

### Why

- `senpi update` and startup update checks must compare against senpi or brand releases, never upstream engine
  releases, and CalVer hotfix segments do not order under plain semver comparison.

### Why an extension could not handle it

- Startup version checks run from core utilities before extensions load; an extension cannot redirect the fetch
  target or rewrite the user agent of a check that has already fired.

### Expected merge conflict zones

- MEDIUM: `packages/coding-agent/src/utils/version-check.ts` endpoint selection and version comparator.
- LOW: `packages/coding-agent/src/utils/pi-user-agent.ts` identity line.

## Clipboard native-read equivalent guard (2026-08-17)

### What changed

- `packages/coding-agent/src/utils/clipboard-image.ts`: the native backend's image check collapsed
  `!clipboard || !clipboard.hasImage()` into the equivalent `!clipboard?.hasImage()`.

### Why

- Optional-chaining parity with the fork's erasable-syntax tree; behavior is unchanged — a missing native backend
  and a backend reporting no image both still return no image.

### Why an extension could not handle it

- Clipboard image decoding is a shared leaf utility consumed by core input paths; extensions call into it rather than
  around it.

### Expected merge conflict zones

- LOW: the single guard line in the native clipboard read.

## Removed highlight.js ambient module declaration (2026-08-17)

### What changed

- Deleted `packages/coding-agent/src/utils/highlight-js-lib-index.d.ts`, the hand-written ambient declaration that
  typed a deep `lib/index.js` import.
- `packages/coding-agent/src/utils/syntax-highlight.ts` imports `hljs` from the package's typed entry point instead,
  so the highlight interface comes from upstream types rather than a fork copy.

### Why

- The declaration existed only to type an untyped deep import; the package entry is typed, and maintaining a fork
  declaration let it drift from the real highlight API.

### Why an extension could not handle it

- Module typing is compile-time; extensions cannot supply ambient declarations for the host package build.

### Expected merge conflict zones

- LOW: the import line in `packages/coding-agent/src/utils/syntax-highlight.ts`; the deletion is clean unless
  upstream edits the removed file.

## Brand-aware offline package management (2026-08-13)

### What changed

- Kept the package manager's offline gate routed through
  `envValue("OFFLINE")` instead of reading `PI_OFFLINE` directly.
- Kept `downloadFile` typed against Node's readable-stream interface rather
  than an untyped response body.

### Why

- Senpi supports branded environment prefixes while retaining upstream
  compatibility, and package downloads need a concrete stream contract.

### Why an extension could not handle it

- Package installation and self-update execute before extension loading and own
  the process environment and download pipeline.

### Expected merge conflict zones

- LOW: `tools-manager.ts`, at the offline environment gate and `downloadFile`
  response-body handling.

## Windows process-tree kill survives an unresolvable taskkill (2026-08-11)

### What changed

- `shell.ts`: the Windows branch of `killProcessTree` moved into `killWindowsProcessTree`, which walks the ordered
  launcher list from the new `windowsTaskkillCandidates` export (every existing absolute `System32` / `Sysnative`
  `taskkill.exe`, then the bare PATH-resolved name), runs each with `spawnSync` under a 5s timeout, and only degrades
  to `process.kill(pid)` when no launcher starts at all. Both new functions are exported for regression coverage.

### Why

- `spawn("taskkill", ...)` resolves the executable through PATH and reports a failed lookup asynchronously on the
  child's `error` event, so the surrounding `try`/`catch` never saw it. On a session whose PATH had lost
  `%SystemRoot%\System32`, `killTrackedDetachedChildren()` during shutdown raised
  `Error: spawn taskkill ENOENT` as an uncaught exception and took the CLI down instead of exiting, and no tracked
  child was killed.
- The kill is synchronous because `emergencyTerminalExit()` calls `killTrackedDetachedChildren()` and then
  `process.exit(129)` in the same tick. An asynchronous killer — or a fallback wired to the child's `error` event —
  never runs on that path, so the tracked child would survive. `spawnSync` reports a failed lookup on its returned
  `error` field instead of emitting it, so ENOENT can no longer become an uncaught exception either.
- The candidate list exists because the reported failure was PATH resolution, not a missing binary: a broken PATH must
  not downgrade a tree kill to a direct kill. `process.kill` maps to `TerminateProcess` and leaves descendants
  orphaned, the same limitation `packages/pty/src/pipe-fallback.ts` documents, so it stays a last resort.

### Why extension system couldn't handle this

- Detached-child bookkeeping and the shutdown signal handlers live in core modes; no extension hook runs inside the
  signal path that kills tracked children.

### Expected merge conflict zones on next upstream sync

- LOW: the Windows branch of `killProcessTree` and the `node:path` / `child_process` import lines in `shell.ts`.

## Config-reload recursive watch option (2026-07-21)

### What changed

- `fs-watch.ts`: `watchWithErrorHandler` now accepts an additive optional Node `WatchOptions` argument, allowing callers to request recursive directory watches while retaining its existing error handling.

### Why

- The config-reload watch engine watches directories rather than individual files so editor atomic-save rename-replaces remain observable.

### Why extension system couldn't handle this

- The watcher wrapper is a shared leaf utility used by core and mode code.

### Expected merge conflict zones on next upstream sync

- LOW: `watchWithErrorHandler` parameter list and `fs.watch` invocation.


## Shell resolution for persistent terminals (2026-07-07)

### What changed

- `shell.ts`: `getShellConfig` honors `SENPI_GIT_BASH_PATH` (checked before Windows Git-Bash
  probing) and resolves an explicit shell path by KIND — `cmd.exe` → `/c`, PowerShell/pwsh →
  `-NoProfile -Command`, bash/sh → `-c`/`-s`. New exports: `resolveShellKind`, `GIT_BASH_PATH_ENV`,
  `ShellKind`, and a `kind` field on `ShellConfig`.

### Why

- The persistent-terminal builtin (`terminal`) resolves the shell + args + transport via this
  helper and passes them into `@earendil-works/pi-pty`, so non-bash shells (cmd, PowerShell)
  and a user-pinned Git Bash spawn correctly on Windows.

### Why extension system couldn't handle this

- Shell resolution is a core utility shared by `core/tools/bash.ts` and the terminal extension.

### Expected merge conflict zones on next upstream sync

- LOW: `getShellConfig` resolution order and `ShellConfig` shape.

## Pinned update changelog links (2026-06-29)

### What changed

- `version-check.ts`: update notes link to the changelog anchored at the specific released version instead of a
  floating link that could drift after later releases.

### Why

- "What's new" links in the update notice must show the notes for the version being offered.

### Why extension system couldn't handle this

- Update-notice construction is a startup core utility.

### Expected merge conflict zones on next upstream sync

- LOW: `version-check.ts` release-notes URL formatting.

## Drain delayed child stdout (2026-06-28)

### What changed

- `child-process.ts`: output collection keeps reading delayed descendant stdout after the parent process exits,
  instead of resolving at parent exit and truncating late output (upstream issue #5303).

### Why

- Commands whose descendants hold the pipe past parent exit lost trailing output in tool results.

### Why extension system couldn't handle this

- Child process stream collection is shared core utility code under the bash tool.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `child-process.ts` stream-drain/exit-resolution ordering (upstream fixed the same class of bug in
  #5753; expect overlapping hunks).

## Output hot-path fast paths (2026-06-13)

### What changed

- `shell.ts`: `sanitizeBinaryOutput()` returns the input string immediately when it contains no unsafe display
  characters, skipping the per-code-point filter on the (dominant) clean case. RPC-side batching is in
  `../modes/rpc/changes.md` 2026-06-13.

### Why

- Output sanitization showed up on streaming hot paths for large tool outputs.

### Why extension system couldn't handle this

- Sanitization runs inside shared output utilities used by core tools.

### Expected merge conflict zones on next upstream sync

- LOW: `shell.ts` around `sanitizeBinaryOutput()`.

## Shared path shortening (2026-05-24)

### What changed

- `paths.ts`: `shortenPath()` (`~/…` shortening) is a shared utility used by core and builtins for consistent short display paths. It previously also backed the fork's `/sessions` session-observer HUD picker (builtin `session-observer`), which was removed on 2026-07-26; `shortenPath()` itself stays — other consumers remain.

### Why

- Callers that list paths across `~/.senpi/agent/sessions/` cwd-subdirs need consistent short display paths.

### Why extension system couldn't handle this

- The helper lives in shared utils so core and builtins format paths identically.

### Expected merge conflict zones on next upstream sync

- LOW: `paths.ts` helper exports.

## Senpi-branded outbound identity (2026-05-11)

### What changed

- `core/sdk.ts`: `getProviderHeaders()` no longer hardcodes `"pi"` / `"pi-coding-agent"`. The OpenRouter `X-OpenRouter-Title` and the Cloudflare `User-Agent` now interpolate the runtime `APP_NAME` from `config.ts` (`"senpi"` in this fork).

### Why

- Every outbound request should identify as senpi, not pi. Hardcoded `"pi"` strings broke that contract.

### Why extension system couldn't handle this

- These are core SDK internals; an extension cannot rewrite headers built by `core/sdk.ts`.

### Expected merge conflict zones on next upstream sync

- LOW: provider-header builder.

## Senpi version metadata lookup (2026-05-02)

### What changed

- `version-check.ts`: Latest-version checks now query the configured senpi package metadata from npm instead of pi.dev.
- `pi-user-agent.ts`: The update-check user agent now uses the runtime app name from package metadata.

### Why

- `senpi update` and startup update checks must compare against senpi releases, not upstream pi-mono releases.

### Why extension system couldn't handle this

- Startup version checks run from core utilities before extensions can intercept the fetch target.

### Expected merge conflict zones on next upstream sync

- LOW: version-check URL and user-agent formatting utilities.

## Bash abort/timeout wait release (2026-07-18)

### What changed

- `child-process.ts`: `waitForChildProcess` accepts `options?: { signal?: AbortSignal; abortExitGraceMs?: number }`.
  When the signal aborts (the caller has killed the process and abandoned its output), tail preservation ends: the
  stdio pipes are destroyed so descendants that survived the kill cannot re-arm the post-exit idle grace forever,
  and the wait resolves on `exit` — or after `abortExitGraceMs` (default 5s) when the kill never lands
  (uninterruptible IO, failed `taskkill`).

### Why

- Aborting (ESC) or timing out a bash command killed the process group but completion still waited on
  `waitForChildProcess`, whose pi#5303 idle grace re-arms on every chunk. A daemonized/`detached` descendant that
  escaped the group kill and kept writing into the inherited pipe pinned the tool — and the agent's abort — forever.

### Why extension system couldn't handle this

- The wait lives inside the core bash tool's local execution backend; no extension hook can release a promise the
  core tool is awaiting.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `waitForChildProcess` signature and the listener wiring around the pi#5303 idle-grace logic.

## OpenCode-parity duration formatting (2026-07-22)

### What changed

- `duration.ts`: added `formatDuration`, matching OpenCode's duration display boundaries and rounding behavior.

### Why

- Shared duration displays need the same compact output as OpenCode, including its sub-minute rounding behavior.

### Why extension system couldn't handle this

- `formatDuration` is a leaf utility intended for direct use by core display surfaces.

### Expected merge conflict zones on next upstream sync

- LOW: new `duration.ts` utility and its fork-tracker entry.
