# todotools Fork Tracker

## 2026-07-31 - Animate same-phase completions in the todo sidebar

### What changed

- The `todo-sidebar` now uses the extension widget factory form and a
  disposable `TodoWidgetComponent` instead of static string rows.
- Visible task rows share the inline todo result's status styling: completed
  rows are dimmed and struck, the active row is accent/bold, abandoned rows are
  dimmed, and pending rows remain plain.
- Live `todo` tool mutations pass their exact `TodoCompletionTransition[]` into
  widget sync. A newly completed row animates only when its transition belongs
  to the still-active phase and the row remains inside the existing 10-line
  window.
- The component reuses the shipped two-frame hold, twelve-frame left-to-right
  reveal, 65ms cadence, code-point-safe splitting, and themed strikethrough
  callback. Its interval is unref'd, self-terminates, and is cleared when the
  host replaces or disposes the widget.
- Session start/tree rebuilds and `/todo` command updates pass no live
  transitions, so restored and user-edited completed rows render fully settled
  without replaying animation.
- The existing active-phase selection, line budget, omission counts, and
  all-completed widget hiding remain unchanged.

### Expected merge conflict zones

- MEDIUM: `todo-widget.ts` around the new row model that preserves the existing
  window algorithm.
- MEDIUM: `index.ts` and `tools/todo.ts` around widget sync and live completion
  transition plumbing.
- LOW: `todo-widget-component.ts` and its focused fake-timer tests (fork-only).

## 2026-07-30 - Bulk-clear rm when both targets arrive blank

### What changed

- `{"op":"rm","task":"","phase":""}` now normalizes to a bulk clear with one
  `[auto-corrected]` correction instead of the `Blank "task"` dead-end
  error. GPT-5.x-style function calling serializes every schema property
  and pads omitted strings with `""`, so telling the model to "omit the
  field entirely" pointed at an option its serializer cannot express;
  session 019fabf3 (2026-07-29, apitopia) showed the same failing call
  retried verbatim. Both targets blank together is unambiguous — the only
  documented no-target rm form is a bulk clear (the prompt table already
  documents "rm: omit both to clear").
- Guard scope is unchanged for everything else: rm with exactly one target
  blank, and `start`/`done`/`drop` with blank targets, still return the
  `Blank "target"` error. Widening the single-blank or bulk form of those
  ops from padding could silently complete or abandon every task, so the
  defensive error is kept there.
- Regression coverage pins the two layers: unit normalization cases in
  `test/suite/todo-normalize.test.ts` (`rm both-blank padding`, including
  the verbatim padded payload and non-mutation), plus registered-execute
  assertions in `test/suite/todo-rm-blank-bulk-clear.test.ts` that the
  padded payload bulk-clears through the real tool (correction surfaced,
  state emptied, one state entry appended) and that `done` with both
  targets blank still throws.

### Expected merge conflict zones

- HIGH: `normalize.ts` — the blank-target guard block and the hoisted
  `corrections` declaration if upstream ships similar correction logic.
- LOW: `test/suite/todo-normalize.test.ts` and the new
  `test/suite/todo-rm-blank-bulk-clear.test.ts` (fork-only).

## 2026-07-29 - Keep active work visible in long todo widgets

### What changed

- Bounded the phase-aware `todo-sidebar` output to the interactive widget's
  10-line budget before the generic widget renderer truncates it.
- Long active phases now keep the two tasks immediately before the active
  item, the active item itself, and as much pending upcoming work as fits.
- Completed and abandoned tasks after the active item no longer consume the
  upcoming-work window or inflate the later omission count.
- Explicit earlier/later omission rows report how much relevant work is
  outside the window. Short phases preserve their existing complete output.
- Split the former monolithic `state.ts` implementation into focused state,
  query, resolution, operation, formatting, storage, and widget modules, each
  below the 250-pure-line ceiling. Widget regressions now live in a dedicated
  deterministic test file.

### Expected merge conflict zones

- MEDIUM: `todo-widget.ts` if upstream changes todo sidebar layout or the
  interactive widget line budget.
- MEDIUM: `state.ts` and the focused `todo-*.ts` modules if upstream changes
  the todotools state API or persistence behavior.

## 2026-07-28 - Preserve open todo work across new instructions

### What changed

- Rewrote the existing completion and mid-task instruction guidance so agents
  immediately reconcile the current list with the newest user message after
  completion, preserve non-conflicting open work, amend contradictions, and
  append additions. Full reinitialization remains reserved for an explicit
  replacement or redirect.

### Expected merge conflict zones

- LOW: `prompt.ts` and the task-management fixture when reconciling fork-local
  prompt guidance with upstream todotools changes.


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

## Sync provenance: pi-todotools 0.2.0 (2026-07-26)

### Source

- Canonical source: `code-yeongyu/pi-todotools` 0.2.0, merged by
  [pi-todotools PR #13](https://github.com/code-yeongyu/pi-todotools/pull/13).
- Version metadata was regenerated through `sync-builtin-extensions.mjs`.

### Diff result

The functional state and operation logic matches the canonical phased port. The
remaining differences are intentional senpi adaptations: the `senpi.todo-state`
persistence key, TypeBox/internal imports, the `todowrite` builtin identity,
`todo-sidebar` widget renderer and completion animation, and the `/todo`
command suite. No behavior delta surfaced during the resync comparison.

## 2026-07-26 - Auto-correct malformed todo calls and surface real errors

### Source

- Fork-local change set (no upstream port). Motivated by session mining:
  17 failures across 2,435 recorded todo calls, concentrated in kimi/glm
  models; the replay contract lives in
  `packages/coding-agent/test/fixtures/todo-arg-correction.fixtures.json`.

### What changed

- `TODO_PARAMS_SCHEMA.op` is now `Type.Optional(...)` so calls that omit the
  operation reach `execute` and can be rescued; the advertised description
  still states the operation is required ("Operation to perform. Required —
  always pass it explicitly.") and auto-correction is never advertised.
- `normalize.ts` (new): argument normalization runs before any state
  application, in strict rule order — R0 blank-target guard (a
  provided-but-blank `task`/`phase` on start/done/drop/rm errors instead of
  silently widening into a bulk operation; a blank sibling of a non-blank
  target is dropped quietly), R1 explicit-init preservation
  (`{"op":"init","list":[]}` keeps its clear-the-list semantics), R-VIEW
  short-circuit (`op:"view"` ignores every other field), R2 alias
  canonicalization (`init`/`append` keys folded into effective `items`
  BEFORE conflict detection so an alias can never bypass it), R3 conflict
  detection + op inference (non-empty `list` plus non-empty effective
  `items` errors as conflicting shapes; a missing `op` is inferred from the
  payload shape or rejected with both canonical forms), R4 per-op
  field-compatibility matrix (non-empty unrelated fields error as
  conflicting shapes instead of passing through silently).
- `fuzzy-match.ts` (new): task/phase resolution ladder with a conservatism
  rule — auto-apply ONLY on unique exact or unique `sanitizeTodoText`
  normalized (casefold) equality; containment and char-bigram Dice
  (score >= 0.5) matches are suggestion-only (`Did you mean ...?`), because
  containment can select a negated sibling ("Do not deploy X" contains
  "Deploy X"). Uniqueness is enforced only on the corrections-present
  model-tool path (`resolveTaskOrError`/`resolvePhaseOrError` invoked with a
  `corrections` array); the omitted-corrections legacy path keeps
  first-match semantics for `commands.ts` and `index.ts` consumers.
- Throw-on-error: `execute` now THROWS on unrecoverable errors instead of
  returning a result carrying `isError: true`, because
  `packages/agent/src/agent-loop.ts` `executeToolCall`
  (`executePreparedToolCall`) returns `{ result, isError: false }` for ANY
  non-throwing execute — a tool-returned `isError` field is silently
  dropped, so state-level errors reached providers flagged as success.
  Throwing routes through the loop's error path and records
  `isError: true`; the thrown message keeps the full remaining-items echo
  models rely on for recovery. The dead `TodoToolResult.isError` field and
  `isTodoToolError` helper were removed; `renderResult` now depends solely
  on `context.isError`.
- Init duplicate merging: duplicate phase names in an init list merge into
  the first occurrence (items concatenated in order) and duplicate task
  contents keep the first occurrence, each with an `[auto-corrected]`
  correction; the empty-phase init error is preserved.
- Append `phase` is now optional with the default chain active-task phase
  -> last existing phase -> `DEFAULT_INIT_PHASE`, emitting
  `[auto-corrected] append had no phase; used "<name>"`.
- Prompt/schema guidance: a canonical init example line directly under the
  Operations table, `phase?` in the append row, a verbatim-copy rule
  ("done/start/drop take the task's EXACT text — copy it verbatim from the
  latest todo result, never re-type from memory."), and sharpened schema
  field descriptions on `op`, `task`, `phase`, and `items`.
- Correction notices ride in plain tool-result `content` text (prepended to
  the summary) and in `details.corrections`, so they need NO RPC/app-server
  or web-ui rendering seam — every surface renders them generically.

### Expected merge conflict zones

- HIGH: `tools/todo.ts` — the schema (optional `op`, field descriptions) and
  `execute` (normalization call, corrections threading, throw-on-error);
  `state.ts` — `resolveTaskOrError`/`resolvePhaseOrError` signatures and
  ladder integration, `initPhases` merge, `appendItems` default chain.
- MEDIUM: `prompt.ts` (guidance text) and the fork-only `normalize.ts` /
  `fuzzy-match.ts` modules if upstream ships similar correction logic.
