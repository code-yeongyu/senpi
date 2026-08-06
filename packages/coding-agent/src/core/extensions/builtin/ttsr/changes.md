# TTSR Fork Tracker

## 2026-08-05 - One activation, one visible record

### What changed and why

- TTSR now persists only the shared `rule-activation` entry for each remediation.
- The old private `ttsr-injection` custom entry is no longer written, and the
  transient `ctx.ui.notify("Stream rule triggered…")` warning is removed.
- The hidden `ttsr-injection` custom message remains because it is the
  model-facing corrective nudge, not a user-facing duplicate.
- Session rehydration reads typed TTSR `rule-activation` entries while retaining
  read compatibility with legacy private entries already stored in old sessions.

### Ownership contract

- One logical stream-rule activation has one persisted display owner:
  `rule-activation`.
- The renderer owns the single TUI notice box. Presentation must not also flow
  through a transient notify or a second display-only custom entry.

### Coverage and expected conflict zones

- `test/ttsr/extension-wiring.test.ts` pins one activation entry, zero private
  entries, zero transient notices, and a preserved hidden nudge.
- Persistence, coordinator-race, and cross-turn tests now assert against the
  shared activation record while retaining legacy rehydration coverage.
- MEDIUM in `index.ts` around `recordInjection` and session rehydration.

## 2026-08-05 - System-owned remediation aborts

### What changed and why

- All TTSR remediation aborts now call `ctx.abort("system")`.
- The host reports those turns as `agent_end.abortSource === "system"` instead
  of `"user"`, so an active Goal remains active while the hidden corrective
  nudge and any live monitor/background completion channel resume the run.
- Explicit user interrupts still use the default user source and keep the
  existing intentional Goal block.
- If a user interrupt joins an in-flight TTSR system abort, the resulting
  user-owned settlement mutates the retained `agent_end` through the end of
  `agent_settled`. TTSR checks that shared event before requesting its nudge,
  while the host defers earlier settlement requests until every handler
  completes, so neither handler order can run a corrective turn after Escape.
- An automatic provider retry starts a fresh TTSR detection generation even
  though agent-core does not emit a new `turn_start`, so consecutive leaking
  generations each receive their own system abort and provenance.

### Coverage and expected conflict zones

- `test/suite/goal-abort-extension.test.ts` combines Goal + TTSR + an active
  monitor and pins system attribution, active Goal state, and user-abort
  regression behavior.
- `test/suite/goal-ttsr-user-abort-race.test.ts` pins the joined-abort ordering,
  one underlying abort, user provenance, durable Goal block, and no corrective
  follow-up turn.
- `test/suite/goal-ttsr-settlement-race.test.ts` pins both `agent_settled`
  handler orders, Goal recovery launch after a terminal system error, and stale
  recovery removal on public-boundary cancellation.
- `test/suite/goal-system-abort-monitor.test.ts` pins the Goal-side system-abort
  policy independently of the detector.
- LOW in `index.ts` at the three `ctx.abort("system")` call sites.

## 2026-08-04 - Cross-turn repetitive-turns detection

### What changed and why

- TTSR gained a third builtin detection lane, `repetitive-turns`, that watches assistant output ACROSS turns instead of within a single generation. The existing collapse and control-token-leak detectors only see one streamed message, so a model that emits a fresh but near-identical status message every turn (an "I read this as continue waiting; N green, M remain" supervision loop) never trips them and can burn an unbounded number of turns making no progress.
- Detection is generic, not phrase-specific: each completed assistant text is normalized (lowercased, digit runs and hex-like ids folded to `#`, whitespace collapsed) and compared to the previous turn with word-trigram Jaccard similarity. Three consecutive turns at or above 0.55 similarity trip the lane, so numeric-only deltas between otherwise identical templates still match while genuinely progressing work does not.
- Remediation reuses the shipped rule-nudge path: the next near-duplicate generation is aborted mid-stream via `ctx.abort()`, the injection is recorded through `recordInjection` (so both the `ttsr-injection` entry and the shared rule-activation record are emitted), and a `<system-interrupt rule="repetitive-turns">` nudge tells the model to stop restating status and take a different concrete action or declare what it is blocked on.
- The lane latches after firing and only re-arms once a sufficiently dissimilar turn resets the streak, so a single loop yields exactly one interruption rather than one per repeated turn.
- `--ttsr-rules-disabled=repetitive-turns` disables the lane end to end, matching the existing builtin-disable contract.

### Why an extension-local change is required

- Cross-turn state cannot live in `StreamWatcher`, which is reset at every `turn_start` by design; the detector is therefore held by the extension across turns and fed from `message_end`, using only the public `pi.*` surface. No `packages/ai`, `packages/agent`, or `agent-session.ts` change is involved.

### Session-resume rehydration

- Cross-turn state is rebuilt at init from persisted history (`ctx.sessionManager.getEntries()`, last 8 assistant texts) because each `--print` / `--continue` invocation is a fresh process. Without this, any resumed session — the long-running supervision sessions this lane targets — had no cross-turn protection at all; real-CLI QA caught it while the unit suite was green.

### Coverage

- `test/ttsr/repetitive-turns.test.ts` pins normalization, trigram similarity, the streak threshold, the minimum-length floor, and latch/reset behavior.
- `test/suite/ttsr-extension.test.ts` proves through the faux provider that a near-duplicate streak aborts and injects exactly one `repetitive-turns` nudge with a persisted injection entry, that an unrelated repeated template also trips (genericity), that genuinely progressing turns are untouched, and that the disable flag silences the lane.

- Real-CLI QA ships as `senpi-qa` mock-loop scenario `ttsr-repetitive-turns` (chained `--continue` runs against the local fake model server), alongside the existing `ttsr-collapse` and `ttsr-leak` scenarios.

### Expected merge conflict zones

- LOW: additive detector module and prompt constant.
- MEDIUM: `index.ts` `message_update` / `message_end` handlers now carry the cross-turn arm/record steps alongside the existing collapse, leak, and manager-rule branches.

## 2026-08-04 - Shared visible activation records

### What changed and why

- TTSR now registers Senpi's shared `rule-activation` entry renderer and appends a typed visible activation record whenever remediation is committed.
- The new record reports the detector owner, observed rule ids, and whether the remediation used a hidden nudge or bounded provider-error retry.
- The existing `ttsr-injection` persistence entry, hidden corrective `custom_message`, abort/truncation flow, provider retry, repeat gating, and session restoration are unchanged.

### Why an extension-local change is required

- TTSR remains the sole owner of the point where a detection becomes committed remediation. A generic TUI layer cannot infer that state safely from stream deltas or from the hidden nudge without coupling itself to the coordinator.
- The shared module owns only typed presentation; TTSR still owns detection, interruption, transcript mutation, and retry policy.

### Coverage and expected conflict zones

- Coverage: `test/ttsr/extension-wiring.test.ts` verifies both remediation modes retain their existing records/messages and add the typed activation entry; `test/suite/rule-activation-renderer.test.ts` verifies standalone renderer registration and expanded TTSR details.
- Expected conflicts: `index.ts` around extension registration and `recordInjection(...)`. Preserve both the original persistence append and the additional shared activation append.

## 2026-07-31 - Interrupt fabricated unavailable-tool calls

### What changed and why

- TTSR now registers a manager-backed builtin stream rule before discovered global/project rules. It aborts assistant text that imitates either the new `<unavailable-tool-call ...>` transcript record or the persisted legacy `[Called tool "..." (no longer available in this session)` envelope, then injects an action-oriented nudge telling the model to call its real tools and redo the step.
- Both conditions are deliberately case-insensitive because model-authored imitations are not trustworthy XML. The rule is explicitly text-only (`allowThinking: false`, no tool scopes), uses `interruptMode: "always"`, and does not match raw `*** Begin Patch` prose.
- Accepted tradeoff: legitimate model prose discussing the senpi-specific `<unavailable-tool-call` envelope also triggers once per session. The default `repeatMode: "once"` caps the interruption, and remediation is a corrective nudge rather than a hard failure.
- Builtin names are registered first and therefore reserved under the manager's existing first-registration-wins duplicate policy; project/global files cannot weaken a shipped safety rule by reusing its name.
- `TtsrManager.addRule()` now rejects names in `settings.disabledRules`. This makes `--ttsr-rules-disabled` effective for manager-held builtin, project, and global rules instead of only the two detector-only builtins.
- `/ttsr` partitions manager rules by source: builtin stream rules appear under a distinct `STREAM RULES` subsection beside the detector list, while `USER RULES` contains only project/global files and remains `(none)` when none are configured.
- Removed two committed `TTSRDBG` stdout logs from the streaming path; they corrupted interactive TUI rendering.

### Coverage

- The faux-provider extension suite proves both envelope formats abort, inject `<system-interrupt>`, and retry; thinking streams remain untouched; and the same text is inert when the builtin name is disabled.
- Manager and command tests pin disabled-rule registration and truthful builtin/user status partitioning. The full `test/ttsr/` directory remains a required regression gate.

### Expected merge conflict zones

- LOW: builtin registration order and streaming debug cleanup in `index.ts`.
- LOW: additive builtin rule module, manager registration gate, and `/ttsr` source partition.

## 2026-07-29 - Port from oh-my-pi (commit cc00ab161, v17.1.8)

### Source

Ported and adapted from oh-my-pi's TTSR (time-traveling stream rules) system:

- `packages/coding-agent/src/export/ttsr.ts` — TtsrManager (per-stream buffers, regex conditions, scope tokens, repeat gating, injected-state persistence)
- `packages/coding-agent/src/session/ttsr-coordinator.ts` — TtsrCoordinator (abort/inject/resume flow)
- `packages/coding-agent/src/capability/rule.ts` — Rule frontmatter + compileRuleCondition
- `packages/coding-agent/src/prompts/system/ttsr-interrupt.md` — interrupt template
- `docs/ttsr-injection-lifecycle.md` — lifecycle documentation

Source repo: [`oh-my-pi`](https://github.com/can1357/oh-my-pi) (MIT-licensed)

### Senpi adaptations

- **Extension-only architecture**: the entire lifecycle (detection -> abort -> remediation -> retry/continue) rides senpi's existing extension API (`message_update` deltas, `ctx.abort()`, `message_end` replacement hook, `sendMessage` with `triggerTurn`). Zero changes to `packages/ai`, `packages/agent`, or `core/agent-session.ts`.
- **Durable truncation via message_end replacement**: oh-my-pi's `contextMode: "discard"` (agent.replaceMessages) is replaced by senpi's `_replaceMessageInPlace` hook (agent-session.ts:1655-1668), which mutates the finalized message in-place before persistence — strictly stronger (durable across history/resume/compaction) with zero core API changes.
- **Provider-error-equivalent retry for leakage**: control-token leakage replaces the aborted message with an empty error-shell (`stopReason: "error"`, retryable-pattern-matching `errorMessage`) so senpi's existing bounded auto-retry/backoff/model-fallback machinery resamples — no custom retry loop.
- **Synchronous streaming-path handlers**: `message_update` handlers must be synchronous (the agent-loop event pump does not await async extension handlers for streaming events); initialization (flags, manager, discovery, restore) is synchronous via `discoverTtsrRulesSync`.
- **Builtin-disable gating**: `ttsr-rules-disabled` flag gates builtin detectors by name (StreamWatcher checks the disabled set before feeding each detector).

### Deviation ledger (oh-my-pi defaults vs senpi choices)

| oh-my-pi default | senpi choice | Rationale |
|---|---|---|
| `repeatMode: "once"`, `repeatGap: 10` | Same defaults; collapse rule overrides to `after-gap: 1` | Faithful port; per-rule override for collapse |
| `contextMode: "discard"` | Truncation via `message_end` replacement | Extension-only; no core replaceMessages API |
| `interruptMode: "always"` | Same (v1 supports interrupt only; non-interrupt deferred) | Faithful port |
| `astCondition` (ast-grep structural matching) | Dropped (v1) | Needs `@ast-grep/napi` external dep senpi lacks |
| Tool-arg snapshot matching (`matcherDigest`) | Raw `toolcall_delta` JSON only | Known semantic limitation; ast-adjacent complexity cut |
| `ttsr` CLI subcommands (`test`, `scan`) | Not ported | Out of scope for v1 |
| Trigram-Jaccard + progress-lexicon channels | Deferred (phase 2) | Needs calibration data; gate on telemetry |

### Known limitations (v1)

- **Input-event cancellation seam (non-TUI)**: in non-TUI mode, `pi.on("input")` cannot preempt an armed nudge because `ctx.abort()` sets `_userAbortPromise` and `prompt()` parks on it; the input event fires only after `agent_settled`. The `session_abort` seam and TUI `onTerminalInput` seam work as designed. Documented in coordinator-races.test.ts.
- **Builtin detector repeat-gating**: builtin detectors (collapse/leak) use per-generation latch + fresh state per turn (≈ after-gap:1 behavior); they do not consult `TtsrManager` injection records for once-mode suppression across turns.
