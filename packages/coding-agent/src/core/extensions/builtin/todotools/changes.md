# todotools Fork Tracker

## 2026-10-01 - The first-turn opener asks for the phases the request needs (senpi#2505)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/todotools/first-turn.ts` `FIRST_TURN_REMINDER`: "a phased list covering the whole request end to end, with only the phases this request needs - a question needs none past answering it" replaces the enumerated "investigation, implementation, verification (diagnostics, tests, build, manual check), and the final report". The gate, the forced `tool_choice` and the tests are unchanged.

### Why

- The enumeration made every first request, including a yes/no status question, plan a verification phase; GPT-6 Astra then had to reason the planned "run diagnostics, tests and build" item away ("no code change, so tests and build are not run") after spending the turn around it. The decomposition mandate itself stays in `TASK_MANAGEMENT_SECTION`.

### Why an extension could not handle it

- This is the todotools builtin's own reminder text.

### Expected merge conflict zones

- `first-turn.ts` `FIRST_TURN_REMINDER`.

## 2026-10-01 - The first gateway delivery gets the first-turn opener (senpi#2424)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/todotools/first-turn.ts`: `shouldArmFirstTurn` treats `trigger: "delivery"` like `"prompt"` and counts earlier `session_control_delivery` entries with full admission provenance as requests, using the same shared predicate as the host. Question/exclamation, print/json and ask-user-answer exclusions apply equally to both paths; answer-frame deliveries do not consume the opener.
- `test/suite/regressions/2424-delivery-first-turn.test.ts`: covers the delivery gate table, gateway-only first/later deliveries with forced `todo` choice, both prompt/delivery orders, hidden extension turns, and typed or delivered answer frames through the real `AgentSession`.

### Why

- A gateway-only session's admitted delivery is its work request. Skipping it gave that request no opener and incorrectly saved the opener for a later local prompt.

### Why an extension could not handle it

- This is the todotools builtin's first-request policy; it consumes the host's new delivery trigger and persisted delivery entries.

### Expected merge conflict zones

- Fork-only files. `first-turn.ts` gate and request-entry classifier.

## 2026-09-30 - The first-turn opener never arms on an ask-user answer frame (senpi#2419)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/todotools/first-turn.ts` `shouldArmFirstTurn`: returns `false` when the prompt parses as an ask-user answer frame (`parseAskUserAnswerFrame` from `../ask-user/format.ts`, the parser `todo-ask.ts` already uses), and the "no user request on the branch" check skips user messages that are answer frames.
- `packages/coding-agent/src/core/extensions/builtin/todotools/todo-ask.ts`: `firstTextBlock` is exported so the gate reads a user message's text the same way Ask capture does.
- `test/suite/regressions/2419-first-turn-answer-frame.test.ts`: gate rows for an answer frame (LF and CRLF), for a work request after an earlier answer, and for a text-less (image-only) user message still counting as a request; a faux-`pi` case where an answer frame gets no reminder and no forced `todo` tool_choice; a real-session case (an extension-triggered bootstrap, then an answer, then a work request) where only the work request arms. The faux `pi` scaffolding is shared with `test/suite/todo-first-turn.test.ts` through `test/suite/todo-first-turn-harness.ts`.

### Why

- When every earlier turn was an extension or custom message (an onboarding bootstrap, a control-endpoint delivery), the answer to an async question was the branch's first user message, so the opener armed on it. Under `force` the model got a named `todo` tool_choice instead of acting on the answer, and the user's real first request after it then got no opener.

### Why an extension could not handle it

- The gate is this builtin's own logic; no core file changed.

### Expected merge conflict zones

- Fork-only files. `shouldArmFirstTurn` and its doc comment; the `firstTextBlock` export in `todo-ask.ts`.

## 2026-09-30 - No handoff cue on the chat surface (senpi#2398)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/todotools/tools/todo.ts`: the handoff moment is skipped when the session's prompt surface (`ctx.getSystemPromptOptions().surface`, else `resolvePromptSurface(process.env)`) is `chat`, so no "Handoff due ... write the Ask / For you / Now / Next block" line is appended. Terminal and app keep the cue.
- `test/suite/todo-handoff-cue.test.ts`: the four-call harness run asserts the cues on `terminal` and `app` and no cue on `chat`.

### Why

- The chat surface's prompt has no handoff block; a cue asking for one would bring it back right before the reply.

### Why an extension could not handle it

- This is the todotools extension itself; no core file changed.

### Expected merge conflict zones

- Fork-only file. The cue call in `tools/todo.ts` `execute`.

## 2026-09-29 - The all-closed handoff cue stops handing the model an English `none` to copy (senpi#2366)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/todotools/todo-format.ts`: `HANDOFF_CUES["all-closed"]` says `the Ask / For you / Now / Next block, with Now and Next saying no task remains` instead of `the Ask / For you / Now: none / Next: none block`.

### Why

- The cue lands right before the final message, and a Korean-rule run on `claude-opus-5-5` copied its literal `Now: none. Next: none.` into an otherwise Korean handoff. The shared handoff rule (`dynamic-prompt/handoff.ts` `HANDOFF_LANGUAGE_RULE`) keeps the labels fixed and puts the slot contents in the user's language; the cue now describes the slot contents instead of dictating English ones. Same length.

### Why an extension could not handle it

- This is the todotools extension itself; no core file changed.

### Expected merge conflict zones

- None (fork-only file).

## 2026-09-28 - The first-turn opener stops forcing a model that refused a forced choice (senpi#2218)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/todotools/first-turn.ts`: `supportsNamedToolChoice` returns false for a model the provider adapters remembered as refusing a forced `tool_choice` (`hasRefusedForcedToolChoice` from `@earendil-works/pi-ai/utils/tool-choice-fallback`) and for `openai-completions` / `openai-responses` models whose compat sets `supportsForcedToolChoice: false`, so those first turns send only the reminder.

### Why

- Kiro behind an OpenAI-compatible proxy refuses every forced `tool_choice`, and the opener forced `todo` on every OpenAI-wire model unconditionally, so each session's first request failed (senpi#2218). The adapter now retries the refused request once; the opener must not keep forcing a model already known to refuse.

### Why an extension could not handle it

- This is the todotools extension itself; no core file changed.

### Expected merge conflict zones

- None (fork-only file).

## 2026-09-25 - The state barrel stops re-exporting unused Ask helpers (senpi#2143)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/todotools/state.ts` re-exports only `captureListAsk` from `todo-ask.ts`; `ASK_TEXT_LIMIT` and `truncateAskText` had no importer through the barrel.

### Why

Dead re-exports widen the barrel other builtins import.

### Why an extension could not handle it

This is the todotools barrel itself.

### Expected merge conflict zones

- The `./todo-ask.ts` re-export line in `state.ts`.

## 2026-09-25 - The first-turn opener arms on the user's first request, never on an extension-triggered turn (senpi#2137)

### What changed

- `first-turn.ts` `shouldArmFirstTurn`: `FirstTurnGateInput` gains `trigger` and loses `phases`; the gate refuses any `trigger !== "prompt"` and no longer refuses an existing list (before the first user message a list can only come from an extension-triggered turn). `index.ts` passes `event.trigger`.
- `test/suite/todo-first-turn.test.ts`: the gate table covers an extension-triggered turn; a real-session case triggers a hidden turn that inits its own list before the user speaks, and the user's first request still gets the reminder (RED with the trigger clause removed).

### Why

- On first launch omo's onboarding bootstrap triggers a turn before the user says anything. The opener armed on it (`Ask: (no user request captured)`), the model planned the onboarding, and the user's real multi-step request then failed the empty-list clause and got no opener.

### Why an extension could not handle it

- The gate is this builtin's own logic; it needed the host's `trigger` field (`extensions/changes.md`).

### Expected merge conflict zones

- `shouldArmFirstTurn` and its input type; the `before_agent_start` handler in `index.ts`.

## 2026-09-25 - The all-closed cue names where other reports go (senpi#2133)

### What changed

- `todo-format.ts` `HANDOFF_CUES["all-closed"]`: `... the final message is the Ask / For you / Now: none / Next: none block.` -> `... Your final message is the Ask / For you / Now: none / Next: none block; any other report an instruction asks for (a self-review, a checklist, a summary) goes inside For you.` The list-created and phase-closed cues are unchanged.

### Why

- On the released 2026.9.24-3, grok-4.7 closed a finished task with a project rule's self-review instead of the handoff block when that rule was active (a rule injected on `.ts` writes asks for an out-loud review "before declaring done"). Two instructions claimed the final message and the cue did not say where the other one goes (category B). Naming the slot keeps both: measured 3/3 grok-4.7 runs ending in the block with that rule active, one of them carrying the self-review inside For you (was 4 of 10 runs without the block).

### Why an extension could not handle it

- The cue is the todo builtin's own result text.

### Expected merge conflict zones

- `HANDOFF_CUES` in `todo-format.ts`. Fork-only file.

## 2026-09-25 - Todo results cue the handoff block at handoff moments (senpi#2121 real-surface QA)

### What changed

- `todo-format.ts`: `handoffMomentOf(before, after, createsList)` returns `"list-created"` (a list-creating call produced tasks), `"all-closed"` (the call closed the last open task of the list), `"phase-closed"` (the call closed the last open task of a phase), or `undefined`; `HANDOFF_CUES` holds one line per moment and `formatHandoffCue` appends it after a blank line. `state.ts` re-exports the three. `tools/todo.ts` appends the cue to every successful, non-`view` result; thrown errors and `view` carry none.
- `test/suite/todo-handoff-cue.test.ts`: the moment predicate over literal phase states, and one harness run (init, a mid-phase `done`, a phase-closing `done`, the list-closing `done`) asserting each result ends with its moment's shipped cue and the mid-phase result carries none. RED with the cue call disabled.

### Why

- Real runs on grok-4.7 and claude-fable-5-1 with the `## Handoff` contract in the system prompt wrote the block at the final message only about half the time and almost never at the plan or a phase change: the rule sat thousands of tokens away from the moment it governs. The todo result is the one text the model reads immediately after each of those transitions, so the cue lands where the decision is made (the gajae-code reporting mechanism, tool results that carry the reporting ask). Measured on 12 runs (6 per model) after the cue: the final message carried the block in 11/12 (5/8 before); after `phase-closed`, 7/16 with the "before your next tool call" wording (5/18 with the earlier "open your next text" wording, which the models satisfied by writing no text). Fable 5.1 remains weakest mid-task (its guide documents fewer between-tool updates; they arrive as progress-update thinking blocks this harness does not request) - tracked separately.

### Why an extension could not handle it

- This is the todo builtin's own result text; another extension cannot append to a tool result it does not own.

### Expected merge conflict zones

- `tools/todo.ts` result assembly and its `todo-format.ts` import list; `todo-format.ts` exports. Fork-only files.

## 2026-09-25 - First-turn plan opener and the single decomposition mandate (senpi#2121)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/todotools/first-turn.ts` (new): `shouldArmFirstTurn` (pure gate: not a preview; `todo.firstTurnPlan` is not `off`; the prompt is non-blank and, after trailing quotes/parens/whitespace are stripped, does not end in `?` or `!`; the branch holds no user message; no todo task exists; `todo` is an active tool; the mode is not `print`/`json`), `supportsNamedToolChoice` (Anthropic through the resolved `getAnthropicCompat`, so the Fable / Mythos / Opus 5.5 forced-choice default applies; OpenAI Responses and Chat Completions always), `namedToolChoicePayload` (per-wire shapes), `withForcedTodoChoice`, and `FIRST_TURN_REMINDER`.
- `packages/coding-agent/src/core/extensions/builtin/todotools/index.ts`: `before_agent_start` (still preview-safe) returns the hidden `senpi.todo-first-turn` custom message when armed and sets an in-memory `pendingForce`. `before_provider_request` injects the named `todo` tool_choice while `pendingForce` is set and the setting is `force`, only when the payload declares `todo`, carries no `tool_choice`, and (Anthropic) has no `enabled`/`adaptive` thinking; the model is re-resolved from the request. The first assistant `message_end`, `agent_end`, `session_abort`, `session_start`, `session_tree`, and `session_shutdown` clear it. The session log records `todo_first_turn` with `mode: "forced" | "reminder-only"`.
- `packages/coding-agent/src/core/extensions/builtin/todotools/prompt.ts`: `TASK_MANAGEMENT_SECTION` states the decomposition mandate ("A request with three or more distinct steps gets a phased todo before the first edit - ..."); `TODO_TOOL_DESCRIPTION` rewords the solo-call rule to "NEVER end a turn with a todo call as its only tool call - ..." and drops "Solo todo turns waste a round trip.", and its "Task requires 3+ distinct steps" bullet is deleted so the mandate has one home.
- `packages/coding-agent/src/core/extensions/builtin/todotools/tools/todo.ts`: the matching prompt guideline uses the same end-a-turn framing.
- `packages/coding-agent/test/suite/fixtures/task-management-section.txt` regenerated; `packages/coding-agent/test/suite/todo-first-turn.test.ts` (new).

Word counts (`wc -w` of the rendered string; category A delete/correct, B reframe, C new context):

| Surface | Before | After | Delta | Category |
|---|---|---|---|---|
| `TASK_MANAGEMENT_SECTION` | 70 | 90 | +20 | C: the mandated decomposition sentence replaces the when-to-use sentence (16 -> 36 words, two of them `-`) |
| `TODO_TOOL_DESCRIPTION` | 398 | 388 | -10 | B: solo-call rule reframed, "Solo todo turns waste a round trip." deleted; A: "Task requires 3+ distinct steps" deleted as the mandate's duplicate |
| Both (shipped together every turn) | 468 | 478 | +10 | |

The section alone exceeds the plan's +12 budget because the replacement sentence is fixed text and the rest of the section (the "Mark each item done" sentence and `## Evidence`) is kept verbatim; the file-level growth is offset in the tool description.

### Why

Models skipped the plan on the first request and reported progress without a list to anchor it. A hidden first-turn reminder plus a forced `todo` call on providers that accept one makes the opening call a phased init, and the decomposition rule now lives in exactly one place (`TASK_MANAGEMENT_SECTION`) instead of a when-to-create bullet in the tool description.

### Why an extension could not handle it

The prompt strings, the before-agent-start section, and the todo tool's state are owned by this builtin; a separate extension would add a second copy of the rule beside the one shipped here.

### Expected merge conflict zones

- MEDIUM: `index.ts` `before_agent_start` / `before_provider_request` / lifecycle handlers.
- LOW: `prompt.ts` string bodies and the golden fixture (regenerate rather than merge); `first-turn.ts` is fork-only.

## 2026-09-25 - Ask/Now/Next header on every todo result (senpi#2121)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/todotools/todo-ask.ts` (new): `captureListAsk` anchors a list-creating call (`init`, or `append` into an empty list) to the branch's first user message when no `senpi.todo-state` entry exists yet, else to the newest user message; ask-user answer frames are skipped, and a newer `compaction.todo-restore-request` re-emits its snapshot's ask. Text is `sanitizeTodoText` of the first text block, cut at 200 code points with `… (+N chars)`.
- `packages/coding-agent/src/core/extensions/builtin/todotools/todo-types.ts`: `TodoAsk`, `TodoState`, optional `ask` on `TodoStateEntry` (schema stays `v2`) and `TodoToolDetails`, `TODO_RESTORE_REQUEST_TYPE`.
- `packages/coding-agent/src/core/extensions/builtin/todotools/todo-storage.ts`: `getLatestTodoStateFromBranchEntries` returns `{ phases, ask }`; `getLatestPhasesFromBranchEntries` delegates to it; `isTodoAsk` guard.
- `packages/coding-agent/src/core/extensions/builtin/todotools/todo-format.ts`: `describeAskNowNext` and `formatAskNowNextHeader`; `formatSummary` prepends `Ask:` / `Now:` / `Next:` and a blank line to every summary, thrown errors included.
- `packages/coding-agent/src/core/extensions/builtin/todotools/tools/todo.ts`: `execute` captures or carries the ask into the state entry and `details.ask`; `renderResult` draws a dim `Ask:` line above the phases when an ask exists.
- `packages/coding-agent/src/core/extensions/builtin/todotools/index.ts`: in-memory `currentState = { phases, ask }` resynced on `session_start` / `session_tree`; the native mirror carries the ask.
- `packages/coding-agent/src/core/extensions/builtin/todotools/commands.ts`: `/todo` prints the same header; user edits carry the ask.
- `packages/coding-agent/src/core/extensions/builtin/todotools/state.ts`: re-exports the new helpers.
- `packages/coding-agent/src/core/extensions/builtin/todotools/AGENTS.md` (new): directory guide.
- Tests: `test/suite/todo-ask-now-next.test.ts`; accessor fakes in the existing todo tests gain `getCurrentAsk` / `setCurrentAsk`.

### Why

A todo result named the list but not what it was for, so a model reporting progress had to reconstruct the original request from memory. The header gives every result, and the later turn-end backstop, one mechanical source for the user's ask and the current and next task labels.

### Why an extension could not handle it

The state entry, the tool result text, and the renderer are owned by this builtin; an outside extension cannot add fields to its persisted state or its results.

### Expected merge conflict zones

- MEDIUM: `tools/todo.ts` `execute` and `renderResult`; `todo-format.ts` `formatSummary`.
- LOW: `todo-storage.ts` branch reader, `index.ts` state holder, `commands.ts` `commit` / `showCurrent`.

## 2026-09-24 - Sound todo type guards from pi-todotools 0.2.1 (senpi#2079)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/todotools/todo-storage.ts`: `isTodoItem` accepts only the four canonical statuses and `isTodoPhase` checks its tasks with `isTodoItem`, instead of both delegating to the migrating parsers. The legacy `cancelled` -> `abandoned` migration stays on the persisted-state parse path (`getLatestPhasesFromBranchEntries`).
- `packages/coding-agent/src/core/extensions/builtin/todotools/tools/todo.ts`: the read-only `view` path builds its empty error list without a type assertion (type-only).
- `packages/coding-agent/test/suite/todo-type-guards.test.ts` pins that a `cancelled` item fails the guards while the parse path still migrates it.
- The rest of pi-todotools 0.2.1 (Pi TUI `invalidate` peer compatibility, toolchain refresh) has no counterpart in this diverged port.

### Why

The guards delegated to `parseTodoItem`, which accepts `cancelled` and returns a migrated copy, but the guard then narrowed the original value. A `cancelled` item passed `isTodoItem` while its `status` was not a `TodoStatus`, so `isTodoPhaseArray` in the goal todo gate could accept unmigrated data.

### Why an extension could not handle it

The guards are exported by this builtin and used by the goal todo gate; a caller cannot fix a guard that lies about its narrowing.

### Expected merge conflict zones

- LOW in `todo-storage.ts` `isTodoItem` / `isTodoPhase`.

## 2026-09-04 - Task_Management stops re-sending the tool description

### What changed

- `prompt.ts`: `TASK_MANAGEMENT_SECTION` no longer interpolates `TODO_TOOL_DESCRIPTION`. The section keeps the when-to-use sentence and the Evidence bullets; the operations table, anatomy, and rules stay only in the tool description. The `(CRITICAL)` heading suffix is dropped with the duplicate.
- `prompt.ts`: the two "never guess the task text from memory" bullets merged into one.
- `test/suite/fixtures/task-management-section.txt` regenerated; `test/suite/prompt-single-home.test.ts` pins that the section never contains the description and that the ops table and anatomy render in exactly one surface.

### Why

- Both surfaces ship on every turn while the todo tool is active, so the description was billed twice: 684 tokens for the section plus 576 for the description. The section is now 95 tokens with no rule lost, since the model reads the same mechanics from the tool schema.

### Why extension system couldn't handle this differently

- Both strings are owned by this builtin; the split between tool schema and system section is internal to it.

### Expected merge conflict zones

- LOW: `prompt.ts` string bodies and the golden fixture; regenerate the fixture rather than merging it.

## Mirror Cursor native todos into senpi.todo-state (2026-08-19)

Cursor resolves `todo` on the server and never runs local `execute()`, so the widget stayed empty. `message_end` now persists `arguments.todos` as `senpi.todo-state` when there is no local `op`.

Conflict zone: `todotools/index.ts` `message_end`.

## 2026-08-27 - Apply explicit empty native todo lists

### What changed

- The native todo mirror now distinguishes an absent `todos` payload from an explicitly empty array.
- Empty native lists are persisted and synced, allowing the `todo-sidebar` widget to be removed.
- Fully terminal native lists remain hidden while lists with pending work remain visible.

### Why

The `message_end` mirror previously skipped every empty result, so a native `todos: []` call could not clear stale persisted state or remove the widget.

### Source

- Fork-local fix for issue #1146.
- Regression coverage is in `test/suite/regressions/991-cursor-native-todo-mirror.test.ts`.

### Expected merge conflict zones

- LOW: `todotools/index.ts` and `native-todo-mirror.ts` around native todo mirroring.

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
