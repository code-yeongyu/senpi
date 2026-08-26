# loop-guard changes

## loop-guard: give polling blocks a terminal recovery action (2026-08-25)

- Block reasons for `bash_output` and `task_output` now tell the agent to stop
  polling, arm a monitor or rely on a supported completion notification when
  waiting is appropriate, and otherwise re-plan.
- Other blocked tools keep generic reuse, stop, re-plan, or alternate-tool
  guidance without implying that a monitor exists.
- Why: the previous generic instruction to change an argument deliberately
  allowed same-target polling to evade identical-loop escalation.
- Tests cover the polling and non-polling recovery branches.
- Expected merge conflict zones: LOW in `notice.ts` and this tracker entry;
  NONE in public extension APIs.

## loop-guard: block ignored identical loops and interrupt persistent hard stops (2026-08-17)

- Exact identical loops now hard-escalate after two admitted reminders. The
  second reminder arms a block that activates only after its `turn_end`, so
  calls through count 6 still execute; the next same-signature model call is
  vetoed by the public `tool_call` hook with a non-terminal error result.
  Similar and cyclic detections remain advisory.
- A private `IdenticalLoopEscalation` correlates model attempts by
  `toolCallId`, canonical signature, and turn boundary. Calls that bypass
  `tool_execution_start` (including extension bridge subcalls) are never
  blocked; a changed tool or changed arguments reset the hard-escalation
  episode immediately.
- The third loop-guard-owned block claims the shared `wake_source_state`
  liveness lease, emits a one-shot transcript/UI warning, and calls
  `ctx.abort("system")`. After `agent_settled`, a hidden recovery
  `CustomMessage` with `triggerTurn: true` starts a fresh provider user-role
  turn; the lease releases at that turn's `agent_start`. Later same-signature
  calls remain blocked and system-aborted without repeating the warning or
  recovery. Later hard stops reclaim wake-source ownership and publish a
  continuation hold, preventing timer-driven Goal recovery until real input.
  Loop-guard now occupies the first builtin slot so its veto runs before
  repeated PreToolUse hooks and permission prompts.
- The escalation transcript box uses the shared notice kit with semantic
  `error` tone and a width-stable ASCII marker. This keeps severity
  theme-driven and avoids the one-cell underfill produced when terminals
  disagree about U+26D4 emoji width.
- Why: session `01a00f43` showed the model correctly restating every reminder
  ("No more todo", "use apply_patch") while sampling the same `todo view`
  action 197 times. More advisory prose could not alter the action-level
  attractor; a failed tool observation and a user-attributed fresh turn can.
- Goal isolation: hard stops use only system aborts; the wake-source lease
  makes Goal treat the interrupted interval as externally owned instead of
  scheduling a competing system recovery; blocked todo errors bypass Goal's
  stale-goal reminder. Goal production code and public extension APIs are
  unchanged.
- Pattern replacement now clears the state-machine episode, pending recovery,
  and wake-source lease atomically, so external lifecycle calls cannot revive a
  stale hard-stop recovery after the model changes tools or arguments.
- Cursor server-driven exec calls now traverse the same vetoable `tool_call`
  preflight before `tool.execute`. The session preflight first awaits the
  AgentSession event queue, so `tool_execution_start` correlation is committed
  before loop-guard consumes the call. Block reasons return in-band with
  matched lifecycle events.
- Coverage: `loop-guard-hard-escalation.test.ts` pins delayed activation,
  first-veto order, changed-argument reset, uncorrelated bridge/multi-tool
  controls, one-shot warning/recovery, wake-source lease transitions, repeated
  system abort, and `terminate:false`. `loop-guard-goal-isolation.test.ts` plus
  existing Goal system-abort/reminder suites prove active-goal preservation,
  wake-source-owned recovery, and error-result reminder isolation. Mutation
  proof covers user-owned abort, pending-wake omission, and todo-error leakage.
- Expected merge conflict zones: HIGH in `loop-guard/index.ts` around event
  wiring; MEDIUM in `builtin/index.ts` registration order; LOW in new
  `escalation.ts`, notice/renderer/policy support, and focused tests; NONE in
  Goal or public extension API files.

## loop-guard: emit one final notice at the bounded tracker ceiling (2026-08-17)

- `NoticeGate` now admits one final notice when a detection reaches the
  maximum count observable inside the 64-record tracker window: 64 calls for
  identical/similar runs and `floor(64 / period)` repetitions for cycles. A
  per-fingerprint saturation flag keeps subsequent capped detections silent,
  while the existing geometric 2x escalation remains unchanged below the
  ceiling.
- Why: real session `01a00f43` emitted identical notices at 3/6/12/24/48,
  then the detector count saturated at 64 while the gate demanded 96. The
  guard remained permanently silent through the final 5m45s of a 197-call
  `todo view` loop. The escalation policy assumed an unbounded count even
  though the tracker intentionally bounds it.
- Extension boundary: the fix stays inside the private detector/gate policy.
  Tool signatures, renderer details, extension API events, and Goal behavior
  are unchanged.
- Coverage: `loop-guard-detectors.test.ts` drives real bounded identical and
  similar streams and a stable period-2 gate sequence, pinning
  `3/6/12/24/48/64`, `5/10/20/40/64`, and `3/6/12/24/32` respectively with
  no repeated capped notice.
- Expected merge conflict zones: LOW in `detectors.ts` around `NoticeGate`;
  LOW in the focused detector suite; NONE in public extension APIs.

## loop-guard: notice renderer delegates to the shared notice kit (2026-08-04)

- `renderer.ts` now builds its box through `noticeMessageRenderer` from `src/core/extensions/notice/`. The exported `renderLoopGuardNotice` symbol, registration, title/why/expanded text, accent tone, and expand behavior are unchanged; existing suites pass unmodified.
- Why: one visual contract (`NoticeSpec`) is now shared with ttsr injections, goal cache-warm entries, and fallback transitions, so notice styling drifts in one place instead of four.
- Expected merge conflict zones: LOW in `renderer.ts` (imports and the spec mapping); NONE in detectors, tracker, policy, or the steered reminder text.

## loop-guard: suppress distinct-target similarity false positives (2026-08-03)

- `similar` detection now recognizes stable target fields for `read`,
  `bash_output`, `task_output`, `task_update`, `task_send`, and
  `lsp_diagnostics`. When every call in the trailing same-tool run exposes a
  target and all targets are distinct, the run is productive fan-out and the
  similar warning stays silent. Missing or malformed target data falls through
  to the existing bigram-Dice detector.
- Same-target behavior is unchanged: pagination of one `read.path`, polling one
  task or terminal session, byte-identical calls, and repeating cycles continue
  to warn at the existing thresholds.
- Why: a scan of local senpi sessions found the false positives concentrated in
  the `similar` detector, especially long-common-prefix paths and IDs. The
  `identical` and `cycle` detectors were precise, so broad threshold tuning would
  weaken useful protections instead of fixing target identity.
- This cannot be implemented as a separate public extension: the builtin owns
  the private tracker/detector state and steers its reminder during
  `tool_execution_start`; another extension cannot override that policy or
  retract an already-steered custom message.
- Tests: distinct-target RED→GREEN coverage moved into the focused
  `loop-guard-similar-detector.test.ts` suite to keep test modules below the
  250-pure-LOC ceiling. Extension wiring coverage proves distinct reads produce
  no message while existing same-target, identical, and cycle cases stay green.
- Expected merge conflict zones: LOW in `detectors.ts` (one target-identity
  predicate in the similar detector); LOW in the loop-guard test suites; NONE in
  public extension APIs, tracker signatures, policy thresholds, or renderer.

## loop-guard: tool-call loop detection with steered reminders (2026-07-31)

- New builtin extension `loop-guard` that observes the pure tool-call stream
  (`tool_execution_start`, tool-call only — no adjacency assumption) and steers a
  `<system-reminder>` CustomMessage into the running turn when the agent loops.
- Three detectors over a 64-entry ring of `(toolName, canonicalArgsJson)` signatures
  (key-order-insensitive canonicalization), evaluated per call with priority
  identical > cycle > similar, one notice max per call:
  - `identical`: trailing run of byte-identical signature ≥ 3 → firm reminder
    ("same call ×N, the result will not change, snap out of it").
  - `similar`: trailing same-tool run ≥ 5 with mean adjacent bigram-Dice ≥ 0.85 and
    not all identical → softer attention-check reminder.
  - `cycle`: trailing period-k (k=2..6) repetition ≥ 3 full cycles with ≥ 2 distinct
    signatures → rotation-break reminder.
- Threshold evidence base: gemini-cli `LoopDetectionService` (sha256 name+args
  signatures, cycle periods 1..5, threshold 5 — but it HALTS the turn; loop-guard
  only nudges, so it fires earlier) and OpenHands stuck detector (4+ identical
  action-observation pairs, 6+ ping-pong cycles). Similarity calibrated on 400 real
  senpi sessions: productive same-tool runs (bash/eval/edit/todo) sit at mean
  adjacent bigram-Dice ~0.52–0.55 (p90 ≤ 0.72), while repetitive classes (read
  pagination, bash_output/task_output polling) sit at 0.84–0.93 — 0.85 separates them.
- Escalation gating (`NoticeGate`): fires once at threshold per pattern fingerprint,
  re-fires only when the count reaches 2× the last notified count; a fingerprint
  break clears the entry. State resets on `session_start` and on user `input`
  (interactive/rpc sources; extension-sourced input does not reset, so goal
  continuations cannot accidentally clear a tracked loop).
- Delivery: `pi.sendMessage({ customType: "loop-guard:notice", display: true,
  details }, { triggerTurn: false, deliverAs: "steer" })` — steers into the active
  turn without synthesizing a new one. TUI rendering via `pi.registerMessageRenderer`
  in the goal cache-warm Box style (bold accent title `⚠ Loop guard · …`, dim
  why-line, expanded detail line).
- Registration: appended in `builtin/index.ts` before `config-reload` (pure observer,
  never mutates payloads; MCP stays last). `builtin/AGENTS.md` inventory updated to
  27 extensions.
- Tests: `test/suite/loop-guard-detectors.test.ts` (units for canonicalization,
  similarity, all three detectors, gate escalation, tracker window) and
  `test/suite/loop-guard-extension.test.ts` (fake-pi harness: renderer registration,
  silent-on-varied-work, per-kind prompt text, escalation, input/session resets,
  rendered box content). Faux provider only; zero tokens.
- Expected merge conflict zones: LOW in `builtin/index.ts` (one import + one array
  entry); NONE in `types.ts` (no public API change); NONE elsewhere (new directory).
