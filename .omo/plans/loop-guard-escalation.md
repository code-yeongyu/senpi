# Loop-Guard Hard Escalation Plan

## Objective

Ship loop-guard Tier 2 and Tier 3 escalation without changing Goal production
code or public extension APIs:

- Tier 1 keeps the existing steered reminders.
- Tier 2 blocks a repeated byte-identical tool call after the model ignored two
  admitted identical-loop reminders.
- Tier 3 interrupts the turn after three loop-guard-owned blocked calls, shows
  a human-visible warning, holds the shared Goal wake-source lease, uses a
  system abort, and starts a fresh provider user-role recovery turn.
- NoticeGate emits one final saturation notice instead of becoming permanently
  silent behind the 64-record tracker window.

Delivery ends only when the PR is merged with a merge commit and this worktree
is removed.

## Binding Decisions

### Scope and compatibility

- Change the loop-guard builtin, its registration order/documentation, and the
  internal Cursor exec bridge wiring required to make the existing `tool_call`
  veto non-bypassable across supported provider paths.
- Do not modify Goal production code.
- Do not modify `ExtensionAPI`, `ExtensionContext`, agent-loop, or runner
  public contracts. Senpi already exposes every required seam:
  - `tool_call` returns `{ block, reason, terminate }`.
  - `tool_execution_start` provides the model-dispatched tool-call ID and
    canonicalizable arguments before preflight.
  - `ctx.abort("system")` preserves Goal ownership.
  - `pi.sendMessage(..., { triggerTurn: true })` is the proven post-settlement
    recovery path used by TTSR.
  - `wake_source_state` prevents Goal from scheduling a competing recovery.
- Hard escalation applies only to exact `identical` detections. `similar` and
  `cycle` remain advisory because they may represent legitimate batch work.

### Thresholds and state transitions

1. Identical attempt 3: existing Tier-1 reminder.
2. Identical attempt 6: second Tier-1 reminder and arm Tier 2.
3. `turn_end` after attempt 6: Tier 2 becomes active. Attempt 6 itself is never
   blocked, so the model receives the second reminder and its tool result.
4. Attempts 7 and 8 with the same canonical signature: blocked with a typed
   loop-guard reason, `terminate: false`.
5. Attempt 9 with the same signature: third blocked call, so:
   - mark the hard stop announced before side effects;
   - claim `wake_source_state` source `loop-guard-hard-stop`;
   - render a one-shot escalation transcript notice;
   - call `ctx.ui.notify(..., "warning")` when UI exists;
   - call `ctx.abort("system")`;
   - return `{ block: true, reason, terminate: false }`.
   - after `agent_settled`, send a hidden recovery custom message with
     `triggerTurn: true`;
   - release the wake-source lease at the recovery `agent_start`.
6. Later attempts with the same signature remain blocked and system-aborted,
   reclaim the Goal wake-source lease, but do not repeat the human warning or
   automatic recovery turn. Real input releases the lease.

### Correlation and hook ordering

- `ToolCallTracker.record()` returns the exact `ToolCallRecord`.
- A new `IdenticalLoopEscalation` stores `toolCallId -> signature` for attempts
  observed by `tool_execution_start`.
- `tool_call` blocks only IDs correlated through that map. Direct
  `pi.executeTool()` bridge calls that do not emit `tool_execution_start` do
  not inherit stale hard-escalation state.
- Move loop-guard to the first builtin registration slot. First-block-wins in
  `ExtensionRunner.emitToolCall`; repeated calls must be stopped before
  permission prompts or PreToolUse commands repeat.
- Do not claim atomic cancellation of a parallel multi-tool batch. Siblings
  already prepared before the Tier-3 abort may finish; the system abort
  prevents the next model continuation.

### Reset rules

Full reset clears detector, gate, escalation phase, blocked count, one-shot
announcement state, and outstanding correlation IDs on:

- `session_start`;
- `input` from interactive or RPC sources.

Extension-sourced input does not reset. This preserves the existing invariant
that Goal continuation and the Tier-3 recovery cannot erase the loop state.

Pattern reset occurs immediately when a correlated attempt has a different
canonical `(toolName, argsJson)` signature. A changed tool or changed arguments
start a fresh episode. Object key order remains insignificant.

`turn_end` activates a pending Tier-2 block and clears unused correlation IDs.
A changed signature atomically clears the detector episode, pending recovery,
and any active loop-guard wake-source lease.

### Cursor server-exec parity

- Cursor's server-driven bridge emits `tool_execution_start` and then calls the
  session preflight, which awaits the AgentSession event queue before the same
  `ExtensionRunner.emitToolCall` veto runs.
- Blocked Cursor calls return the loop-guard reason as an in-band tool error,
  keep matched start/end lifecycle events, and never invoke the underlying tool.
- Late-bound session/Agent wiring lives in a focused helper; oversized
  `AgentSession` gains no new method and SDK wiring is net smaller.

### NoticeGate saturation

- Keep geometric escalation before saturation.
- Add a one-shot `saturationNotified` flag per detection kind/fingerprint.
- Maximum observable counts:
  - identical: `TRACK_WINDOW`;
  - similar: `TRACK_WINDOW`;
  - cycle: `floor(TRACK_WINDOW / period)`.
- Admit when the count doubles OR reaches its maximum observable count before a
  saturation notice has fired.
- Identical sequence becomes `3, 6, 12, 24, 48, 64`, then silence until reset.

### Goal isolation

- Tier 3 always uses `abort("system")`, never `abort("user")`.
- Goal marks an active goal blocked only for user-owned aborts.
- The loop-guard wake-source lease is active before abort, so Goal schedules
  monitor-owned waiting instead of its own immediate system recovery.
- The lease remains active through settlement and releases only when the
  loop-guard recovery turn starts.
- A post-recovery hard stop reclaims the lease without synthesizing another
  recovery turn and publishes a continuation hold, leaving the Goal active but
  idle until real input releases both states.
- A loop-guard blocked `todo` result is an error; Goal's todo-gate handler
  returns before inspecting error results.
- Tier-2 reasons must not contain `abort`/`aborted`, because Goal's clean-stop
  predicate recognizes aborted error text.
- Goal remains active and resumes normally after real user input.

## Implementation Waves

### Wave A — Saturation RED -> GREEN

1. Extend `loop-guard-detectors.test.ts` with failing coverage for
   `3/6/12/24/48/64`, no repeated capped notice, cycle saturation, and
   fingerprint-reset behavior.
2. Capture RED against origin/main.
3. Update `NoticeGate` with maximum-observable-count saturation admission.
4. Run the focused detector suite GREEN.
5. Commit the verified increment.

### Wave B — Tier 2 RED -> GREEN

1. Add `escalation.ts` pure state-machine tests:
   - second admitted identical notice arms but does not block before `turn_end`;
   - next correlated same-signature call blocks;
   - changed arguments reset;
   - uncorrelated tool calls pass.
2. Extend the extension harness to execute async handlers and capture
   `tool_call` results.
3. Capture RED.
4. Implement `IdenticalLoopEscalation`, make tracker record return its record,
   wire `tool_execution_start`, `turn_end`, and `tool_call`.
5. Move loop-guard to the first builtin slot and add order coverage.
6. Run Tier-2 focused suites GREEN.

### Wave C — Tier 3 and Goal Isolation RED -> GREEN

1. Add failing extension tests proving:
   - third owned block claims wake source, warns, and system-aborts;
   - settlement starts one hidden provider user-role recovery turn;
   - recovery `agent_start` releases the wake source;
   - the blocked result remains `terminate: false`;
   - later same-signature calls do not repeat warning/steer;
   - mixed/multi-tool correlation does not block unobserved sibling calls.
   - post-recovery call 10 reclaims wake-source ownership without another
     automatic recovery.
   - signature replacement clears pending recovery and wake-source state.
2. Add failing `loop-guard-goal-isolation.test.ts` coverage:
   - system abort leaves active Goal active;
   - loop-guard wake-source ownership prevents competing Goal recovery;
   - blocked todo error bypasses stale-goal reminder;
   - real user input resets loop-guard state.
3. Capture RED.
4. Add Tier-3 message builders and escalation notice renderer/details.
5. Wire UI warning, user steer, and system abort in the required order.
   Real-CLI QA may refine the delivery boundary while preserving the outcome.
6. Add Cursor bridge RED/GREEN coverage proving server-exec calls traverse the
   same first-block preflight and retain lifecycle pairing.
7. Add only loop-guard-side guards required by the tests; do not edit Goal.
8. Run Tier-3 and Goal suites GREEN.
9. Commit the verified increment.

### Wave D — Documentation and Static Verification

1. Update:
   - `loop-guard/changes.md`;
   - builtin `changes.md`;
   - builtin `AGENTS.md` registration order/role;
   - package `changes.md` if required by the fork boundary;
   - unreleased `CHANGELOG.md` following `.github/agent/commands/cl.md`.
2. Run direct changed tests.
3. Run changed-file LSP diagnostics where the worktree server supports it;
   otherwise use package TypeScript compilation and report the LSP limitation.
4. Run strict TypeScript no-excuse audit and pure-LOC measurement.
5. Run `npm run check`.

### Wave E — Real CLI and Visual QA

1. Extend the senpi-qa mock-loop harness with a deterministic loop-guard
   escalation scenario:
   - scripted model calls `todo view` repeatedly;
   - attempts 7-9 are not executed;
   - third blocked call causes system abort and a wake-source lease;
   - settlement starts the recovery request and reaches a non-looping action;
   - Goal production remains untouched and focused Goal contracts stay green;
   - Cursor server-exec attempts 7-9 return blocked in-band errors and do not
     execute the tool;
   - auth hash and sandbox isolation stay clean.
2. Run harness self-check and the new scenario; save evidence under
   `local-ignore/qa-evidence/20260818-loop-guard-escalation/`.
3. Drive the real TUI/web-terminal surface and capture the human-visible warning
   screenshot/transcript.
4. Tear down server/PTY/browser/temp resources and record cleanup receipts.
5. Run the affected scenarios again after any QA fix.

### Wave F — Review, PR, Merge, Cleanup

1. Self-review the complete diff against all criteria.
2. Run a non-Momus reviewer lane; verify and fix criterion-cited blockers.
3. Read commit history and create atomic conventional commits matching repo
   style; each commit must be green.
4. Push branch and open reviewer-readable PR with RED/GREEN/QA evidence.
5. Monitor CI and review gates without polling.
6. Fix failures, rerun affected evidence, push follow-up commits.
7. Merge with a merge commit after every gate is green.
8. Remove the task worktree and prune worktrees.
9. Verify GitHub reports `MERGED`, no worktree remains, and no live QA resources
   remain.

## Exact QA Contracts

### SC1 — Saturation

Command:

```bash
npx vitest run packages/coding-agent/test/suite/loop-guard-detectors.test.ts
```

PASS: identical notices occur at 3/6/12/24/48/64 exactly, remain silent while
capped, and restart after a fingerprint break.

### SC2 — Tier 2

Command:

```bash
npx vitest run packages/coding-agent/test/suite/loop-guard-extension.test.ts
```

PASS: attempts through 6 execute; after `turn_end`, attempt 7 returns
`block=true`, a non-abort reason, and `terminate=false`; changed args pass.

### SC3 — Tier 3

Same command as SC2.

PASS: the third correlated blocked call records side effects in exact order
`warning -> user steer -> system abort`; warning/steer are one-shot.

### SC4 — Goal isolation

Command:

```bash
npx vitest run packages/coding-agent/test/suite/loop-guard-goal-isolation.test.ts packages/coding-agent/test/suite/goal-system-abort-monitor.test.ts packages/coding-agent/test/suite/goal-todo-stale-reminder.test.ts
```

PASS: Goal stays active; wake-source ownership prevents competing Goal recovery;
blocked todo errors do not add stale-goal reminders.

### SC5 — Static gate

Command:

```bash
npm run check
```

PASS: exit 0, no suppressed diagnostics or skipped tests.

### SC6 — Real surface

Command finalized from the senpi-qa scenario implementation, using the real
source CLI and fake provider under an isolated sandbox.

PASS: transcript proves the execution/block/abort/wake/recovery sequence; TUI
evidence visibly shows the warning; cleanup receipt proves no resource remains.

## Delegation Topology

- Architecture: one read-only ultrabrain child supplied the final state-machine
  recommendation; the first architect lane was inconclusive due provider 429.
- Implementation/TDD: retained by the lead because tests and implementation
  share the same tightly coupled extension files and must remain RED -> GREEN.
- QA/review: later independent non-overlapping reviewer and real-surface lanes
  may fan out after the implementation is green.
