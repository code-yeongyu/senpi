# core/tools changes

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
