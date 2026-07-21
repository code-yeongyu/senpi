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

## 2026-07-21 - Progressive completion strikethrough reveal

### What changed

- `tools/todo.ts`: `renderTodoPhases` threads the renderer's `spinnerFrame` through to `formatTaskLine` and builds per-phase `completionKeys` (`Map<phaseName, Set<content>>`) from `completedTasks`, keyed by raw `transition.content`.
- `formatTaskLine` strikes a completed row with `partialStrikethrough` when its raw `task.content` is in the phase's completion set and a frame is supplied; the reveal count is computed against the sanitized line (`${marker} ${sanitizeTodoText(content)}`), and once the frame settles or stops (`undefined`) the row falls back to full `theme.strikethrough(line)` — byte-identical to the pre-animation render.
- Reuses `strikeRevealCount`/`partialStrikethrough` from the fork-only `modes/interactive/components/todo-strike.ts`.

### Why

- A completed todo row should sweep left-to-right rather than snap to struck. Keying the completion set on raw content (not the sanitized/marked line) keeps it stable across rendering details, and the settled state matches the original full strikethrough so the animation leaves no residual diff.

### Expected merge conflict zones

- MEDIUM: `tools/todo.ts` `renderTodoPhases`/`formatTaskLine` signatures and the cross-layer import of the fork-only `todo-strike.ts` module from `modes/interactive/components/`.
