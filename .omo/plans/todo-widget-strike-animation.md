# Todo Widget Strike Animation

## Objective

Keep a task that has just completed visible in the input-bar `Todo` widget when
the active phase remains the same, and animate the completed row with the same
left-to-right strikethrough reveal already used by the inline `todo` tool
result. Preserve the existing active-phase selection, 10-line window, restored
session behavior, and all-completed widget hiding.

## Tier

HEAVY. The change adds an animated TUI widget component with timer,
render-request, replacement, and disposal lifecycle.

## Applicable Skills

- `programming`: strict TypeScript, deterministic TDD, no suppressed failures.
- `visual-qa`: browser-rendered xterm.js screenshots for TUI motion evidence.
- `senpi-qa`: isolated real-source CLI smoke and auth-safe evidence.
- `work-with-pr`: task-owned worktree, reviewer-readable PR, CI/Cubic loop,
  merge commit, and cleanup.
- `ulw-loop`: binding evidence ledger and RED -> GREEN -> surface execution.
- `commit` and `git-master`: repository-style atomic commits and explicit
  staging.

`frontend` is not used: this is a terminal widget extending an existing shipped
visual/motion contract, not a browser UI or a new design system.

## Confirmed Existing Flow

- `todotools/index.ts` syncs `todo-sidebar` with static lines from
  `getTodoWidgetLines(currentPhases)`.
- `tools/todo.ts` already computes exact `TodoCompletionTransition[]` on live
  mutations, but passes them only to the inline tool result.
- `todo-strike.ts` already owns the code-point-safe hold/reveal timing,
  partial-strike helper, and 65ms/14-frame contract.
- Extension widgets support a `(tui, theme) => Component` factory and dispose
  replaced components.
- `todo-widget.test.ts` pins the current active-phase window and all-completed
  hiding behavior.

## Design Decision

Use the extension widget factory form and a small todo-specific component.
The component receives current phases plus only the live completion transitions
from the mutation that triggered the sync. It derives the active phase using
the existing query, retains a just-completed row only when that transition
belongs to the still-active phase, renders the row with the existing theme and
strike helpers, advances a bounded unref'd timer, requests TUI renders, and
self-settles. Session start/tree rebuilds and command-driven syncs receive no
transition set and therefore render settled static content with no replay.

Do not change the general 10-line window policy. The temporary retained row
must fit inside the existing body budget by replacing the row that the active
task advance would otherwise displace; after the animation settles, the model
returns to the ordinary window.

## Delegation Topology

- Completed read-only `explore` child: traced widget flow, disappearance rules,
  animation primitives, and test seams.
- Lead owns tests, implementation, QA, and delivery because the model,
  component lifecycle, and extension wiring are one coupled contract.
- No team: parallel writers would collide on the same todotools module and
  animation lifecycle.

## Execution Waves

### Setup

1. Commit this plan alone, push the branch, and open a draft PR.
2. Register the binding goal and mirror this plan into the live todo list.
3. Re-read worktree source, tests, and nearest `changes.md` files.

### RED

4. Add a widget render/model test:
   - phase `Delivery`
   - `Monitor CI and resolve active review gates` transitions to completed
   - `Merge PR with merge commit` becomes/remains active
   - assert completed row is retained at frame 0, partially struck mid-frame,
     and fully struck at settle.
5. Add deterministic fake-timer lifecycle coverage:
   - interval starts only for same-active-phase completion
   - render is requested while frames advance
   - interval stops after total frames
   - replacement/dispose clears it immediately.
6. Add edge/regression coverage:
   - completion from a phase that is no longer active is not retained/animated
   - session restore starts settled and does not start a timer
   - existing line-budget matrix and all-completed hide tests remain unchanged.
7. Run the focused tests after each new case and save failure output proving
   each RED fails for the missing behavior, not syntax/import errors.

### GREEN

8. Add the smallest todo-widget view model needed for temporary same-phase
   retention and frame-aware themed formatting.
9. Add the disposable component that reuses `TODO_STRIKE_*`,
   `strikeRevealCount`, and `partialStrikethrough`.
10. Extend `syncWidget` so the live `todo` tool path can pass exact completion
    transitions; all other callers pass none.
11. Keep restored/static calls settled and preserve existing active-phase and
    line-budget semantics.
12. Update the nearest todotools `changes.md`.
13. Run focused tests, LSP diagnostics, and `npm run check`.

### Surface Verification

14. Run:

    ```bash
    node .agents/skills/senpi-qa/scripts/tui-smoke.mjs \
      --self-test --driver pty --evidence todo-widget-strike
    ```

15. Drive an isolated real source TUI with a deterministic local model scenario
    that performs `todo init` then completes the first `Delivery` task while the
    second task stays active. Capture rest, mid, and settled frames with:

    ```bash
    node /Users/yeongyu/local-workspaces/omo/script/qa/web-terminal-visual-qa.mjs \
      --title "Senpi todo widget strike" \
      --command "<isolated source-TUI todo scenario>" \
      --cwd "/Users/yeongyu/local-workspaces/senpi-wt/feat/todo-widget-strike-animation" \
      --cols 120 --rows 34 \
      --evidence-dir "local-ignore/qa-evidence/20260731-todo-widget-strike/<frame>"
    ```

16. PASS requires `Delivery`, completed
    `Monitor CI and resolve active review gates`, and active
    `Merge PR with merge commit` to be simultaneously visible, with strike
    progression on only the completed row.
17. Record cleanup receipts for PTY/browser, fake server, sandbox, ports, temp
    files, and timers.

### Delivery

18. Self-review the diff and map current-tree evidence to every criterion.
19. Commit implementation plus direct tests atomically, push, and update the PR
    body with sanitized evidence.
20. Monitor CI and Cubic; fix and re-QA any valid failure until every active
    gate passes.
21. Merge with a merge commit, verify GitHub reports `MERGED`, remove/prune the
    worktree, complete the goal, and report evidence.

## Success Criteria

1. Same-phase completion remains visible and visibly progresses from unstruck
   to partially struck to fully struck while the next task is active.
2. Prior-phase/restored completions do not replay; timer/render work stops on
   settle and dispose with no leak.
3. Existing widget windowing, all-completed hiding, static validation, and real
   TUI boot/input behavior remain green.

## Stop Condition

Stop immediately when GitHub reports the PR merged, all criteria have
current-tree RED -> GREEN and real-surface evidence plus cleanup receipts, and
the task worktree has been removed and pruned.
