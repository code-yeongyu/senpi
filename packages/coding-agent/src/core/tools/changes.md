# core/tools changes

## source-backed write result patches (2026-07-21)

### What changed

- `unified-diff.ts`: added the shared old-path/new-path unified patch generator used by file-mutation result contracts.
- `write.ts` and `write-result.ts`: local writes snapshot the prior file content and return an add/update unified patch;
  custom operation backends keep their existing behavior when no trustworthy baseline is available.
- `edit-diff.ts`: retains its public `generateUnifiedPatch()` API while delegating patch formatting to the shared seam.

### Why

- App-server `turn/diff/updated` notifications need the real write result to describe the source mutation. Successful
  writes previously returned no details, so clients could not display or accumulate them.

### Why extension system couldn't handle this

- The baseline must be captured inside the core write tool's serialized mutation window before the file is overwritten.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `write.ts` execution result details.
- LOW: `edit-diff.ts` unified-patch wrapper and the fork-only result modules.

## bash timeout validation sync (2026-07-02)

### What changed

- `bash.ts`: accepted upstream validation that rejects non-positive and oversized bash tool timeouts with clear errors
  instead of silently clamping to surprising runtime behavior.

### Why

- Invalid timeout values should fail before command execution so agent/tool callers receive a deterministic validation
  error.

### Why extension system couldn't handle this

- Timeout parsing and validation are part of the built-in bash tool definition before extensions can observe a running
  command result.

### Expected merge conflict zones on next upstream sync

- LOW: timeout schema/parsing and validation branches in `bash.ts`.

## shared diff renderer for file mutation tools (2026-05-17)

### What changed

- `diff-render.ts` (fork-only): one rich diff renderer — row backgrounds, line numbers, syntax highlighting, inline
  change emphasis — shared by file-mutation tool previews.
- `edit.ts` / `write.ts`: `renderResult` previews route through the shared renderer; the gpt-apply-patch builtin
  consumes the same renderer (see `extensions/builtin/gpt-apply-patch/changes.md` 2026-05-17).

### Why

- edit, write, and apply_patch each rendered diffs differently, so identical changes looked different per tool.

### Why extension system couldn't handle this

- Built-in tool renderers live in `core/tools/`; a shared renderer for them must too.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `edit.ts` / `write.ts` `renderResult` bodies.
- LOW: `diff-render.ts` (fork-only file).

## bash tool elapsed display (2026-05-15)

### What changed

- `bash.ts`: Bash tool result timing now renders as stable whole-second text (`<1s`, `1s`, `1m 8s`)
  instead of fractional seconds like `0.0s` or `68.1s`.

### Why

- The TUI invalidates running bash timing on a one-second cadence, so a decimal suffix implied precision the display
  does not maintain and made short or long-running commands look inconsistent.

### Why extension system couldn't handle this

- The elapsed/took line is produced by the built-in bash tool's `renderResult()` implementation. Extensions can wrap or
  replace the tool, but fixing the default bash widget for every session requires changing the core renderer.

### Expected merge conflict zones on next upstream sync

- LOW: `formatDuration()` and the elapsed/took line in `bash.ts`.

### Files modified

- `bash.ts`

## bash tool command syntax highlighting (2026-05-12)

### What changed

- `bash.ts`: The bash tool call header now renders the command body through the existing TUI `highlightCode(..., "bash")` path while keeping the `$ ` prompt in the tool title style.

### Why

- Codex highlights shell syntax in exec cells, which makes quoted strings, builtins, literals, and operators easier to scan during command-heavy turns. senpi already had syntax highlighting for read/write previews, but bash tool call headers were rendered as a single title-colored string.

### Why extension system couldn't handle this

- The bash tool call renderer is defined directly on `createBashToolDefinition`. Extensions can replace or wrap tools, but changing the built-in bash renderer for every default TUI session requires updating the core tool definition.

### Expected merge conflict zones on next upstream sync

- LOW: `formatBashCall()` and the bash tool renderer helpers near `createBashToolDefinition`. Re-apply the `highlightCode(..., "bash")` command rendering if upstream rewrites the bash render path.

### Files modified

- `bash.ts`

## bash promptSnippet codex-style command examples (2026-05-07)

### What changed

- `bash.ts`: Replaced the example command list inside `promptSnippet` from `"Execute bash commands (ls, grep, find, etc.)"` to `"Execute bash commands (ls, rg, find, etc.)"`.

### Why

- senpi already exposes a dedicated ripgrep-backed `grep` tool. Listing `grep` as an example command inside the bash tool's `promptSnippet` taught the model that bash-invoked `grep` was an idiomatic search path, contradicting the dedicated tool. Replacing it with `rg` matches codex's GPT-5.x system prompt convention (`codex-rs/core/gpt_5_2_prompt.md`: "When searching for text or files, prefer using `rg` ... because `rg` is much faster than alternatives like `grep`") and also stops nudging the model toward bypassing the `grep` tool.
- `find` remains in the example list because senpi exposes a `find` tool whose underlying mechanism mirrors the binary; the conflict only existed for `grep`/`rg`.

### Why extension system couldn't handle this

- `promptSnippet` is a baked-in field on the upstream `bash` tool definition produced by `createBashToolDefinition`. The extension API has no override for tool prompt snippets; rewriting one byte of `promptSnippet` in the upstream source is the smallest possible intervention.
- The codex-style File operations tuning block in the GPT-5.x prompt presets reinforces the same routing without touching upstream, but a stale `(ls, grep, find, etc.)` example inside the tool snippet would still leak into every prompt for every model (Claude, Kimi, etc.), so the source string itself has to be corrected.

### Expected merge conflict zones on next upstream sync

- LOW: a single string literal change inside `createBashToolDefinition`. Upstream `pi-mono` may keep `grep` in its example list; on resync, re-apply `grep` -> `rg` if the upstream change reverts it.

### Files modified

- `bash.ts`

## Bash abort releases the wait despite surviving descendants (2026-07-18)

### What changed

- `bash.ts` (`createLocalBashOperations`): abort and timeout kills now also abort an internal `killedController`
  whose signal is passed to `waitForChildProcess`. Once the tree has been killed, the wait stops preserving output
  tails and resolves within a bounded grace even when an escaped descendant keeps the inherited stdout/stderr pipe
  open (see `utils/changes.md` same date).

### Why

- ESC-abort (and timeout) killed the detached process group, but the tool only returns when
  `waitForChildProcess` resolves. Descendants in their own process group that survived `kill(-pid)` and kept
  chattering re-armed the idle grace forever: "Running bash" counted up for hours and repeated ESC was a no-op.

- When the grace releases the wait while the child is still alive (kill pending), the pid stays in the
  detached-children shutdown cleanup set until the child actually exits, and the child is `unref()`ed so an
  abandoned handle cannot pin the event loop.

### Why extension system couldn't handle this

- The hang is inside the core tool's own exec/wait loop; extensions cannot interpose on it.

### Expected merge conflict zones on next upstream sync

- LOW: the abort/timeout handler block inside `createLocalBashOperations`.
