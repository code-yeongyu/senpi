# todotools Fork Tracker

## 2026-07-19 - Port oh-my-pi's phased todo tool

### Source

- Upstream repository: [oh-my-pi](https://github.com/can1357/oh-my-pi)
- Source files: `packages/coding-agent/src/tools/todo.ts` and
  `packages/coding-agent/src/prompts/tools/todo.md`
- Port source commit: `9fd6e97113f5ed3a847e66d346970efdf8afcad9`
- Upstream version: `v17.0.5`
- License: MIT; attribution is recorded in the source headers and the
  repository `NOTICE.md`.

### What was ported

- Phased task state with content-keyed operations: `init`, `start`, `done`,
  `drop`, `rm`, `append`, and `view`.
- Earliest-open-task auto-promotion, worked-ahead summary text, duplicate and
  missing-target validation, and atomic mutation failure semantics.
- The operation-oriented prompt anatomy and critical enumerate-every-item
  contract.

### Senpi adaptations

- Translated the upstream schema to TypeBox and registered it through senpi's
  extension API.
- Preserved the historical `todowrite` builtin id and `todo-sidebar` widget
  key while registering only the new `todo` model-facing tool.
- Replaced frame/live-subagent rendering with senpi's static `ToolDefinition`
  renderer: roman phase headers, collapsed untouched closed phases,
  strikethrough completed rows, and the phase-aware sidebar widget.
- Kept `senpi.todo-state` and added v2 phased persistence plus migration from
  legacy flat `todos` payloads and `cancelled` status.
- Extended the compaction bridge to recognize the new state entry and
  content-keyed phase tasks.

### Expected merge conflict zones

- HIGH: `state.ts`, `tools/todo.ts`, and the prompt when syncing a newer
  oh-my-pi todo implementation.
- MEDIUM: `index.ts`, compaction bridge, and todo tests because senpi owns
  extension lifecycle and session compatibility.

## 2026-07-20 - Port oh-my-pi's /todo command suite

### Source

- `packages/coding-agent/src/modes/controllers/todo-command-controller.ts` and the
  Markdown round-trip half of `src/tools/todo.ts` from the same oh-my-pi commit
  (`9fd6e97113f5ed3a847e66d346970efdf8afcad9`, v17.0.5, MIT).

### What was ported

- `markdown.ts`: `phasesToMarkdown`/`markdownToPhases` (`[ ]`/`[x]`/`[/]`/`[-]`
  markers) and `resolveTodoMarkdownPath` (default `TODO.md`).
- `commands.ts`: `/todo` verbs — show, `edit`, `copy`, `export`, `import`,
  `append`, `start`, `done`, `drop`, `rm` — with quote-aware tokenizing and
  phase/task fuzzy matching, plus the user-edit system reminder (including the
  explicit removal-intent wording).

### senpi adaptations

- Registered via `pi.registerCommand` on the extension API instead of an
  interactive-mode controller class.
- `edit` uses the built-in `ctx.ui.editor` overlay instead of suspending the
  TUI for an external `$EDITOR`.
- User edits persist as `senpi.todo-state` v2 entries with `source: "user"`
  (no new custom type), so the branch scanner and compaction bridge read them
  unchanged; the agent notification is a hidden `todotools.user-edit` custom
  message delivered next turn.

## 2026-07-21 - Port oh-my-pi's todo completion strike reveal

### Source

- Upstream repository: [oh-my-pi](https://github.com/can1357/oh-my-pi)
- Source files: `packages/coding-agent/src/tools/todo.ts` (reveal math at
  `:817-824`, renderer integration at `:826-849`, per-phase completion keying
  at `:966-972`, call site at `:1014-1036`).
- Port source commit: `9fd6e97113f5ed3a847e66d346970efdf8afcad9`
- Upstream version: `v17.0.5`
- License: MIT; attribution is recorded in the source headers and the
  repository `NOTICE.md`.

### What was ported

- The frame-aware progressive strikethrough reveal: a hold phase (2 frames
  with no strike), then a left-to-right strike sweep over 12 frames at
  65ms/frame, then settle to the static full-strikethrough rendering.
- The reveal-count math (`Math.ceil(chars.length * min(frame - HOLD, REVEAL) /
  REVEAL)` over code points) and per-phase completion keying (only tasks listed
  in `details.completedTasks` for the SAME phase animate; previously-completed
  tasks in other phases stay statically struck).

### Senpi adaptations

- The reveal module lives in `modes/interactive/components/todo-strike.ts` and
  is imported by this renderer (extension -> core dependency direction
  preserved); the module is pure (zero imports), so non-interactive load paths
  (print/RPC/app-server) gain no interactive-runtime dependency.
- Reveal runs over the FULL sanitized display line (`marker + space +
  sanitizeTodoText(content)`) — the exact string being rendered — so the final
  frame is byte-identical to senpi's existing `theme.fg("dim",
  theme.strikethrough(line))` settled rendering. Oh-my-pi's content-only /
  success-color style is NOT copied; senpi's dim+strikethrough settled style
  wins.
- Strike styling flows through the injected `theme.strikethrough` callback via
  `partialStrikethrough(line, reveal, (t) => theme.strikethrough(t))`; no raw
  ANSI `\x1b[9m` literals live in the renderer.
- The frame is sourced from `context.spinnerFrame` (provided by
  `tool-execution-renderer.ts`), so a `spinnerFrame: undefined` render path
  (settled, error, partial, non-interactive) renders byte-identically to
  pre-change output.

### Pre-existing pi-tui behavior pinned, not fixed

- pi-tui's `AnsiCodeTracker.getLineEndReset` closes only underline/hyperlink
  SGR spans at a wrap boundary, NOT SGR 9 (strikethrough). An active strike may
  therefore legally style trailing wrap-padding cells at a wrap boundary. This
  carryover is pre-existing — today's settled full-line strike wraps identically
  — and stays out of scope. The renderer test pins the display-line glyph count
  inside SGR-9 spans (measured over the same full display line the reveal count
  is computed over) and explicitly makes NO assertion about padding cells.

### Expected merge conflict zones

- HIGH: `tools/todo.ts` around `formatTaskLine` (new `completionKeys` + `frame`
  parameters and the completed-branch reveal logic) and `renderTodoPhases` (new
  `frame` parameter, the per-phase `completionKeysByPhase` map, and the
  `renderResult` call site).
- LOW: the shared `modes/interactive/components/todo-strike.ts` module
  (fork-only).
