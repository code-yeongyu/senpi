# core/tools changes

## grep is temporarily withheld from the model-facing tool surface (2026-08-29)

### What changed

- `index.ts`: added `temporarilyDisabledToolNames`, currently holding `grep`. Tools named here are
  still constructed by `createAllToolDefinitions` and stay resolvable through
  `AgentSession.getRegisteredTool`, but are dropped from the prompt-bearing tool definitions and
  from the active tool names, so the model can neither see nor call them.

### Why

- Search routing is being re-evaluated and the model should not reach for `grep` in the meantime.
  This is a withholding, not a removal: every grep code path stays intact, and restoring the tool
  is deleting its entry from the set.

### Why an extension could not handle it

- The withheld set has to be applied where the session materializes its tool surface; an extension
  cannot remove a builtin from the prompt-bearing definitions or the active tool names.

### Expected merge conflict zones

- `index.ts`: the `temporarilyDisabledToolNames` export sits directly below `allToolNames`, so an
  upstream change that adds or removes a builtin tool name will conflict there. Resolve by keeping
  both the upstream tool-name edit and this set; the set is intended to be emptied, not carried.

## Output spill streams capture early storage failures (2026-08-26)

### What changed

- `output-accumulator.ts`: attaches an `error` listener when its full-output `WriteStream` is
  created, records the first failure, and rejects `closeTempFile()` through the terminal `close`
  boundary, including when a filesystem close failure follows `finish`.
- `closeTempFile()` preserves the first storage failure and removes its error and close listeners
  after settlement, preventing a premature success or post-completion listener leak.

### Why

- Bash output can cross the in-memory limit while `/tmp` is quota-exhausted. The stream previously
  had no listener until `closeTempFile()`, so an early `EDQUOT`/`ENOSPC` event reached
  `uncaughtException` and killed the TUI. A late filesystem close failure could also arrive after
  `finish`; waiting for `close` ensures the normal tool promise owns either failure.

### Why an extension could not handle it

- The built-in shell tool writes the spill stream before extension result hooks run.

### Expected merge conflict zones

- LOW: `output-accumulator.ts` stream creation and close lifecycle.

## Tooling layer re-diverges from upstream dcd4619 (2026-08-25)

### What changed

- `packages/coding-agent/src/core/tools/bash.ts` keeps syntax-highlighted output, display-text
  normalization, and the process-tree kill abort controller that stops preserved output tails.
- `packages/coding-agent/src/core/tools/edit-diff.ts` keeps the extracted `unified-diff.ts` patch
  builder in place of upstream's direct `diff` usage.
- `packages/coding-agent/src/core/tools/edit.ts` keeps filesystem-policy checks and themed
  `renderToolDiff` rendering.
- `packages/coding-agent/src/core/tools/index.ts` keeps the single tool-factory path (upstream
  re-adds a parallel `createToolDefinition` switch).

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- Tool render/import blocks in `packages/coding-agent/src/core/tools/bash.ts` and
  `packages/coding-agent/src/core/tools/edit.ts`.

## Read tool rejects local:// URIs with actionable guidance (2026-08-24)

### What changed

- `packages/coding-agent/src/core/tools/read.ts`: the execute path now guards the `local://` URI scheme
  (`/^local:\/\//i`) before any path resolution and throws guidance naming the eval kernel `read()`/`write()`
  helpers and the plain-absolute-path alternative, instead of resolving the URI as a relative path and failing
  with `ENOENT <cwd>/local:/...`. Single-slash `local:/x` stays an ordinary relative path because a colon is legal
  in macOS filenames.

### Why

- A 2026-08-24 session replayed a detached-eval spill notice pointing at `local://detached-eval-eval_5.log`
  through the read tool; the scheme collapsed to a relative path and the tool returned a bare ENOENT with no
  recovery hint. Deployed bundles still emit `local://` spill URIs and the eval prompt documents the scheme for
  kernel helpers, so the read tool is a repeatable trap; the error itself now teaches the two working paths.

### Why an extension could not handle it

- The guard must run inside the built-in read tool's own execute path before `resolveReadPathAsync`; extension
  filesystem-policy hooks only see already-canonicalized paths, so the raw scheme string never reaches them.

### Expected merge conflict zones

- `packages/coding-agent/src/core/tools/read.ts` execute prologue and the module constants block.

## Edit tool keeps filesystem policy and themed diff rendering after the 59a71b23 pin (2026-08-19)

### What changed

- `packages/coding-agent/src/core/tools/edit.ts` stays divergent from upstream pin
  `59a71b235dadb4ad0d67557a8abb0aaa093e68b4`: `EditToolOptions` keeps `filesystemPolicy`, and the executor still
  consults the extension-registered checker (`operation: "write"`, canonical target from
  `canonicalizeFilesystemPath()`, `toolName: "edit"`) after path resolution and before any file access, throwing
  the policy reason as the tool error and re-checking abort afterwards.
- `edit.ts` keeps rendering through the fork's `renderToolDiff()` from `./diff-render.ts` (theme-aware, and passed
  the edited `file_path` in both the preview and result paths) instead of upstream's direct
  `renderDiff()` import from the interactive diff component, and keeps `component.detachAll()` in place of
  `component.clear()` for the call and result containers.

### Why

- Filesystem policy is a fork capability enforced inside each built-in executor so it cannot be bypassed by
  Unicode/symlink path variants or by permission approval, and the fork's tool diff renderer is theme-driven and
  lives in `core/tools` to keep the tool layer independent of interactive-mode components.

### Why an extension could not handle it

- `tool_call` observes user arguments before this executor canonicalizes the target, and it runs inside permission
  handling where unrestricted approval can allow the call; the enforcement point must stay in the executor. The
  render path is the built-in tool's own component construction.

### Expected merge conflict zones

- LOW-MEDIUM: the imports at the top of `edit.ts` (upstream pulls `renderDiff` from the interactive component) and
  the policy check block at the start of the execute function.

## Repository audit baseline for the core/tools tracker (2026-08-17)

### What changed

- This entry is the canonical inventory for the repository-wide changes.md audit (`scripts/audit-changes-md.mjs`, pin
  `914cf1472e715297caa30db4b9535d534a9eb718`). The audited production paths whose exact nearest tracker is this file:
  `packages/coding-agent/src/core/tools/bash.ts`, `packages/coding-agent/src/core/tools/edit.ts`,
  `packages/coding-agent/src/core/tools/edit-diff.ts`, `packages/coding-agent/src/core/tools/write.ts`,
  `packages/coding-agent/src/core/tools/read.ts`, `packages/coding-agent/src/core/tools/grep.ts`,
  `packages/coding-agent/src/core/tools/find.ts`, `packages/coding-agent/src/core/tools/ls.ts`,
  `packages/coding-agent/src/core/tools/index.ts`, `packages/coding-agent/src/core/tools/output-accumulator.ts`, and
  `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`.
- Per-file divergence history for the bash tool (prompt tuning, timeout validation, abort/timeout kill, elapsed and
  syntax-highlight rendering), the shared diff renderer, source-backed write results, Node 26 path typing, and the
  extension filesystem policy is preserved in the dated entries below.

### Why

- The audit requires every upstream-owned production divergence to be covered by one entry with all four canonical
  sections in its exact nearest tracker. Earlier entries in this file use a non-canonical conflict-zone heading and
  bare tool names, so paths they describe were reported uncovered; this inventory closes that gap without rewriting
  accurate history.

### Why an extension could not handle it

- Tracker coverage is repository policy enforced by repository scripts before any extension loader exists.

### Expected merge conflict zones

- NONE: this tracker merges to `ours`; the inventory names pin-relative paths so it survives edits below.

## Pruned tool factory surface and freeform passthrough (2026-08-17)

### What changed

- `index.ts`: removed the per-name factory helpers `createToolDefinition()`, `createTool()`,
  `createCodingToolDefinitions()`, `createReadOnlyToolDefinitions()`, and `createAllTools()`; callers use
  `createAllToolDefinitions()`, `createReadOnlyTools()`, or the per-tool `create*ToolDefinition()` factories
  directly.
- `tool-definition-wrapper.ts`: `wrapToolDefinition()` and `createToolDefinitionFromAgentTool()` forward the
  `freeform` flag from the underlying definition/tool, so wrapped tools keep their freeform-input contract.

### Why

- The switch-based helpers duplicated the explicit factory lists and drifted from them as tools were added; every
  consumer in the fork already resolved tools through the map or the per-tool factories. The `freeform` flag existed
  on tool definitions and agent tools but was silently dropped by wrapping, breaking freeform tools (patch-style
  text input) registered through the wrapper.

### Why an extension could not handle it

- These are the module's own export surface and the wrapper every built-in tool definition passes through; both sit
  beneath the extension registration API.

### Expected merge conflict zones

- MEDIUM: `index.ts` export list — upstream may add helpers back; keep the fork's explicit-list style.
- LOW: the `freeform` line in each wrapper spread.

## Bounded decoded tail window for streaming tool output (2026-08-17)

### What changed

- `output-accumulator.ts`: rolling-tail maintenance moved into fork-owned `tail-window.ts` (`TailWindow` with the
  same `maxBytes * 2` rolling bound, UTF-8 continuation-byte-safe trimming, and line-boundary tracking); snapshots
  read `tail.text()` and trim to the first newline when the window starts mid-line.
- `output-accumulator.ts`: new `appendText()` accepts already-decoded strings (text producers skip the TextDecoder);
  `append(Buffer)` decodes once and both paths feed one `appendDecodedText(text, bytes)` accounting point;
  `closeTempFile()` takes ownership of the temp-file stream before awaiting finish so a second close is a no-op.

### Why

- The inline tail trim kept a decoded string, a byte count, and a line-boundary flag in three places that could
  disagree after multi-byte splits; string producers (steered/exec bridges) had to round-trip through Buffer to
  accumulate output; and closing the temp file twice could double-settle the write promise.

### Why an extension could not handle it

- The accumulator is the output path of the built-in bash/exec tools; extensions receive already-truncated results
  and cannot bound the buffering that precedes them.

### Expected merge conflict zones

- LOW: `output-accumulator.ts` tail/snapshot methods; NONE: `tail-window.ts` is fork-owned.

## Node 26 path-type compatibility (2026-08-13)

### What changed

- `find.ts` types its injected path implementation as `typeof path.posix`, which remains compatible with the
  module, POSIX, and Win32 path implementations after `node:path.PlatformPath` was removed.

### Why extension hooks alone could not handle this

- The dependency-injection type is part of the built-in find tool's compile-time test seam.

### Expected merge conflict zones on next upstream sync

- LOW: `find.ts` injected dependency shape.

## extension filesystem policy enforcement (2026-08-09)

### What changed

- Added shared canonicalization and deny-wins composition helpers in `filesystem-policy.ts`.
- Built-in `read`, `write`, `edit`, `ls`, `find`, and `grep` consult an optional extension policy after canonical path
  resolution and immediately before target I/O. Read, enumerate, and write operations remain distinct.
- Existing targets resolve through `realpath`; missing targets resolve through the nearest existing real parent,
  including dangling symlink targets. A denial throws the policy reason as the normal tool error.
- With no registered policy, each executor retains its prior path and performs only one checker null test.

### Why extension hooks alone could not handle this

- `tool_call` sees user arguments before the built-in executor resolves Unicode/path variants, symlinks, and missing
  write parents. It also runs inside permission handling, where unrestricted approval can allow the call.
- The enforcement point must stay inside each built-in executor to precede actual filesystem operations.

### Expected merge conflict zones on next upstream sync

- MEDIUM: the execute paths in all six built-in file tools.
- LOW: additive `filesystem-policy.ts` and the optional policy fields on tool options.

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
