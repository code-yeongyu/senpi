# TTSR Fork Tracker

## 2026-10-09 - A failed engine pause write preserves the TTSR stop announcement (senpi#3014)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/ttsr/index.ts`: retain the existing loop-stop entry, event and notice before attempting the new engine pause entry; catch and warn on that additive publication failure using a session logger captured before publication.

### Why

The new second append could throw between the existing loop-stop entry and its event/notice, hiding the stop announcement.

### Why an extension could not handle it

This builtin owns the repeated-rule stop branch and must complete its existing announcement.

### Expected merge conflict zones

`ttsr/index.ts` logger import and repeated-rule `agent_settled` branch. Keep the existing announcement ahead of the best-effort engine pause write.

## 2026-10-09 - Publish the common engine pause entry (senpi#3007)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/ttsr/index.ts`: the consumed repeated-rule nudge appends `engine-paused` with reason `repetition`, its rule, and `ttsr-injection`, alongside the unchanged `ttsr-loop-stopped` entry, event, and notice.

### Why

Clients need one durable self-stop signal rather than interpreting TTSR notices.

### Why an extension could not handle it

This builtin owns the repeated-rule stop decision and consumes the nudge exactly once.

### Expected merge conflict zones

The `agent_settled` repeated-rule branch. The final idle case for a one-shot repetitive-turns correction is recorded in the engine after all deferred turn claims settle.

## 2026-10-08 - One corrective follow-up per rule per user message (senpi#2967)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/ttsr/follow-up-limit.ts` (new): `ruleAlreadyCorrected(entries, rule)` reports whether a `ttsr-injection` for that rule was already sent since the user's last message, read from the session entries.
- `packages/coding-agent/src/core/extensions/builtin/ttsr/index.ts`: `agent_settled` sends a rule's corrective nudge (with `triggerTurn`) at most once per user message; a repeat appends `ttsr-loop-stopped`, emits `ttsr:loop-stopped` and tells the user the rule flagged the reply again after its correction.

### Why

- One user message drove 66 turns in about 66 s through the `repetitive-turns` nudge until Stop (senpi#2967). The desktop's server-hosted session fires `session_start` around every turn, so this extension started each automatic turn with fresh in-memory state and re-armed. The limit is read from the session, so a rebuild cannot reset it; the engine-wide turn bound (`src/core/engine-turn-limit.ts`) covers every other source.

### Why an extension could not handle it

- The follow-up turn is started by this builtin's own `agent_settled` handler.

### Expected merge conflict zones

- LOW: `ttsr/index.ts` `agent_settled` handler and imports.

## 2026-10-07 - Code-shaped lines are left out of near-duplicate scoring (senpi#2865)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/ttsr/detectors/collapse-near-duplicates.ts`: `foldLine` leaves out an unfenced line shaped like code (indented and not a nested list item, or ending in `{ } [ ] ( ; , >`, the set oh-my-pi uses; `)` is left out because prose often ends in a parenthesis), so a paragraph made only of such lines is never scored. Fenced paragraphs keep their existing exemption.

### Why

Same-shaped code or markup (SVG elements, JSON objects) repeats one skeleton with different literals and scored as near-duplicate paragraphs. TTSR then aborted the stream and retried, discarding the model's valid output. oh-my-pi v18.8.0 drops the same line shapes before its loop heuristics. Trade-off, accepted on review: oh-my-pi applies its rule only to Gemini, DeepSeek and Grok streams, while TTSR applies it to every model, so a narration loop in which EVERY paragraph ends in `,` or `>` or is indented is no longer counted by this detector. Real narration (the incident fixture) carries no such lines and is still caught.

### Why an extension could not handle it

The paragraph scoring is inside the TTSR detector itself.

### Expected merge conflict zones

- `foldLine` and the line state in `collapse-near-duplicates.ts`.

## 2026-09-25 - The handoff Ask exemption needs a closing status label (senpi#2143)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/ttsr/detectors/repetitive-turns.ts`: `HANDOFF_ASK_CLAUSE` drops its end-of-text branch, so an `Ask:` clause is removed only when `For you:`, `You need:` or `Now:` closes it. `test/ttsr/repetitive-turns.test.ts` adds an unlabeled `Ask:` loop that must still fire on its third turn (RED with the old branch).

### Why

The end-of-text branch removed everything after any `Ask:`, so a stuck turn that merely contained the word normalized to nothing and scored 0 against itself, which hid it from `repetitive-turns` and from `collapse-near-duplicates` (same normalizer). #2136 meant to exempt only the restated request inside a handoff block.

### Why an extension could not handle it

This is the detector's own normalizer.

### Expected merge conflict zones

- `HANDOFF_ASK_CLAUSE` in `detectors/repetitive-turns.ts`.

## 2026-09-25 - repetitive-turns ignores the restated Ask of a handoff block (senpi#2135)

### What changed

- `detectors/repetitive-turns.ts` `normalizeTurnText` drops a handoff block's `Ask: ...` clause (up to `For you:` / `You need:` / `Now:`) before comparison. Both the mid-stream lane (`repetitive-turns-lane.ts`) and the cross-turn detector normalize through it, so both stop counting the restated request.
- `prompts.ts` `REPETITIVE_TURNS_RULE_CONTENT`: `Stop restating the situation. Do not emit another progress recap.` -> `Stop repeating the same status; a report is useful only when something has changed.`
- `test/ttsr/repetitive-turns.test.ts`: the recorded final-block prefix scores under the threshold against the previous block (0.69 before, RED), and a block that repeats the same For you / Now / Next still scores as a near-duplicate.

### Why

- The handoff contract (senpi#2121) makes every block open by restating the user's request, so block N+1's opening is a near-copy of block N by design. On the released 2026.9.24-3 the lane armed on the final block's prefix, aborted it, and injected "Do not emit another progress recap", after which grok-4.7 closed without the block. The status the model reports (For you / Now / Next) still participates, so a model that re-emits the same status turn after turn is still caught.

### Why an extension could not handle it

- This is the ttsr builtin's own detector and remediation text.

### Expected merge conflict zones

- `normalizeTurnText` in `detectors/repetitive-turns.ts`; `REPETITIVE_TURNS_RULE_CONTENT` in `prompts.ts`. Fork-only files.

## 2026-09-16 - Near-duplicate paragraph frequency

### What changed and why

- Added `detectors/collapse-near-duplicates.ts` (`near-duplicate-paragraphs`), wired last in the collapse chain for text and thinking streams. `paragraph-repeat` compares paragraphs byte for byte, so a model that restates the same step in different words every time never reaches three identical hashes; a captured incident streamed such a loop for 12 minutes with zero tool calls until the user killed the session.
- The mechanism is a frequency rule, not a pair rule: a paragraph is an echo when its normalized word set reaches 0.5 Jaccard against any of the last 32 eligible paragraphs, and the detector only fires when at least 8 of the last 12 eligible paragraphs are echoes. A couple of similar paragraphs, a callback to an earlier point, or a summary that repeats a sentence never reaches that density.
- The exact-repeat ring (64 paragraphs) also cannot see a cycle longer than itself. The incident's cycle was 114 paragraphs, so the same loop stayed invisible even where it repeated verbatim; the frequency rule is independent of cycle length.
- Paragraphs inside fenced code blocks are skipped and never enter the history: repeated code blocks in one message are legitimate.
- Remediation reuses the existing collapse path: abort, truncate from the first echoed paragraph in the firing window (its anchor is kept), then the collapse nudge.
- Calibration is measured, not assumed. Replaying the shipped detector over 12,499 real assistant text and thinking parts (28.9 MB) from the local session store fires twice, and both firings are known runaway generations from one 2026-09-03 session; there are no other matches.

### Why an extension-local change is required

- The stream watcher already owns per-message detector state and collapse remediation, so paragraph tracking belongs in the extension-local collapse chain without changing provider or core stream contracts.

### Coverage and expected conflict zones

- `test/ttsr/detector-collapse-near-duplicates.test.ts` replays the sanitized incident fixture (`fixtures/incident-near-duplicate-narration.txt`), pins chunk-boundary independence, and pins the negatives: distinct multi-sentence prose, a minority of echoes in the window, the long healthy prefix, fenced code, and tool-stream exclusion.
- `test/ttsr/collapse-test-inputs.ts` `buildHealthyPrefix` now composes varied vocabulary. Its previous sentences differed only by a counter, so every paragraph normalized to the same token set - healthy prose for a byte-exact rule, a narration loop for a normalized one.
- `test/ttsr/detector-collapse-paragraphs.test.ts` `narration()` now emits seven lexically distinct steps instead of one template plus a counter, so the exact-repeat assertions still test exact repetition. The assertions themselves are unchanged.
- Real-CLI QA ships as `senpi-qa` mock-loop scenario `ttsr-near-duplicate-loop`: fifteen paraphrases of one action, none byte-identical, streamed from the local fake model server. It asserts the abort, the truncated persisted message, the `collapse-repetition` interrupt in the recovery request, and the recovered answer.
- LOW: `detectors/collapse.ts` (one chain entry) and the two test-input fixtures; no existing detector thresholds are changed.

## 2026-09-03 - Within-message paragraph repetition

### What changed and why

- Added `detectors/collapse-paragraphs.ts` (`paragraph-repeat`) for byte-exact paragraph repetition within one streamed message. The existing four mechanisms could not see a 7-paragraph, ~2,100-character, 14-line cycle: scalar and short-period bounds are too small, line cycles are bounded and reset at blank lines, repetitive turns compare across turns, and loop-guard requires tool calls.
- Tool-argument streams are excluded on purpose because fixtures can legitimately repeat blocks.
- Thresholds are 64 characters, 24 word characters, 3 occurrences, and a 64-entry recent-paragraph ring.
- Remediation reuses the existing collapse path: abort, truncate from the second occurrence, and send the collapse nudge.
- Known limit: a paragraph ends only at a blank (whitespace-only) line, so narration that separates steps with single newlines is one paragraph to this mechanism; line cycles up to period 4 remain the line-cycle detector's job.

### Why an extension-local change is required

- The stream watcher already owns per-message detector state and collapse remediation, so paragraph tracking belongs in the extension-local collapse chain without changing provider or core stream contracts.

### Coverage and expected conflict zones

- `test/ttsr/detector-collapse-paragraphs.test.ts` covers chunking, eligibility, byte equality, multiline paragraphs, separators, and tool exclusion.
- `test/ttsr/extension-wiring.test.ts` covers abort, truncation, activation, nudge, retry, and recovery.
- Real-CLI QA ships as `senpi-qa` mock-loop scenario `ttsr-paragraph-loop` (text stream from the local fake model server; asserts the recovery request keeps one copy of the first paragraph and carries the `collapse-repetition` interrupt).
- LOW: `detectors/collapse.ts` and the wiring test; no existing detector thresholds or unrelated routing are changed.

## 2026-08-25 - Cover streamed tool-call arguments

### What changed and why

- TTSR now feeds `toolcall_delta` events into the same collapse, control-leak, and manager-rule watcher used by text and thinking streams, keyed by `tool:<contentIndex>`.
- Tool-scoped rules resolve the tool name from the partial assistant content block, while text-only rules remain excluded from tool streams.
- A mid-tool-call collapse aborts system-owned remediation, removes all tool-call blocks from the aborted generation before persistence because the generation's remaining calls are suspect, keeps the assistant message coherent, and sends the shared activation record plus hidden corrective nudge.
- Control-token-leak detection intentionally runs on tool arguments as part of detector parity; the existing kill switches therefore cover the tool lane without special cases.

### Why an extension-local change is required

- `agent-session.ts` already forwards `toolcall_delta` through the public `message_update` event and already applies `message_end` replacements before persistence. The fix belongs in the TTSR extension watcher and remediation policy; no core or provider change is required.

### Coverage and expected conflict zones

- `test/ttsr/extension-wiring.test.ts` replays the incident payload through the faux provider, proves bounded abort and clean persistence, and preserves nudge/activation ownership.
- `test/ttsr/detector-collapse.test.ts` covers tool-stream false-positive exemptions; `test/ttsr/manager.test.ts` covers tool-name matching and text-only exclusion.
- LOW: `index.ts` message-update routing; LOW: `message-update.ts` stream projection; LOW: `watch.ts`, `types.ts`, and tool-call remediation in `remediation.ts`.

### Deviation ledger correction

| Tool-arg snapshot matching (`matcherDigest`) | Raw `toolcall_delta` JSON only | **Resolved for stream detection:** tool-call argument deltas now receive collapse/control-leak detection and `toolScopes` matching. Structured matcher digests and AST-adjacent path-aware argument snapshots remain deferred. |

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
