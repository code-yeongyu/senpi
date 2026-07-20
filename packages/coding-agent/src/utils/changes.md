# changes

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

## Shared path shortening for the /sessions HUD (2026-05-24)

### What changed

- `paths.ts`: `shortenPath()` (`~/…` shortening) is shared by the fork's `/sessions` session-observer HUD picker
  (builtin `session-observer`).

### Why

- The picker lists sessions across `~/.senpi/agent/sessions/` cwd-subdirs and needs consistent short display paths.

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
