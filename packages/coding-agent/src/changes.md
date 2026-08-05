## Joined user aborts override system provenance (2026-08-05)

### What changed

- `AgentSession` now promotes an in-flight system-owned abort to user-owned when
  an explicit user abort joins the same operation.
- Joining an existing abort awaits the shared promise without issuing a second
  `agent.abort()` call, and a later system abort cannot downgrade user provenance.
- A later recovery generation with no active provenance issues its own
  `agent.abort()` and records a fresh source instead of incorrectly joining the
  prior generation's completed abort.
- User intent that arrives while `agent_end` handlers are dispatching promotes
  the shared event in place. A late join that occurs after an earlier handler
  already observed system provenance emits one `session_abort` before
  `agent_settled`, so TTSR corrective follow-ups and provider retries admitted
  before dispatch cannot outrun the user cancellation.
- The same cancellation boundary remains open through the public `agent_end`
  notification, covering Escape handlers that run after extension dispatch but
  before retry and settlement processing.
- The boundary now remains mutable through `agent_settled` dispatch as well.
  Extension messages requested from that event are held by
  `agent-settled-delivery.ts` until every handler and public listener completes;
  a user abort drops the held actions before one can become a corrective
  provider turn, without disturbing user-owned steering or follow-up queues.
- System-owned aborts no longer set the user-only queued-continuation suppression
  latch; a user join still sets it before awaiting the shared abort.

### Why

- TTSR can begin a corrective system abort immediately before the user presses
  Escape. The old early-return path kept `"system"` provenance and invoked the
  underlying abort twice, so Goal could ignore the user's durable stop intent.

### Why this cannot be expressed externally

- Abort provenance, shared-promise ownership, and queued-continuation suppression
  are private `AgentSession` lifecycle state.

### Expected merge conflict zones

- `core/agent-abort-provenance.ts`, `core/agent-settled-delivery.ts`, and
  `core/agent-session.ts` around `_emitExtensionEvent`, `_emitAgentSettled`,
  `abort`, and `_abortActiveAgentAndRetry`.

## Required-recovery admission supersession and bounded fallback sizing (2026-08-03)

### What changed

- An accepted required-compaction recovery now clears the stored admission rejection when its queued
  continuation is scheduled, so the originating `prompt()` resolves after the queued steer/follow-up
  completes instead of throwing the superseded `RequiredCompactionError`.
- Deterministic recovery sizing no longer materializes `JSON.stringify` for every retained message
  without a bound: the estimator fails closed on accessor-bearing, non-plain, cyclic, or callable
  values and exits early once the remaining `contextWindow - reserveTokens` budget is exceeded.
- Regression coverage pins the turn-end soft-cap reset across degradation-recovery early returns,
  accepted-recovery queued-steer supersession, accessor-safe fallback rejection, and the three-call
  continuation flow (previously ending in an unasserted faux queue-exhaustion error).

### Why

- Review of #679 reproduced a contradiction: queued continuation completed and both queues drained,
  yet the originating prompt still rejected with the stale required-compaction error.
- The same review measured ~207 MiB peak amplification from a 32 MiB retained message and observed
  property getters executing on persisted tool-call arguments during recovery sizing.

### Why this cannot be expressed externally

- Supersession lives in `AgentSession`'s internal compaction admission/continuation ownership; the
  sizing guard is a fail-closed property of the builtin deterministic-fallback estimator.

### Expected merge conflict zones

- `core/agent-session.ts` retry/continuation scheduling around `_checkCompaction` and `agent_end`.
- `core/extensions/builtin/compaction/deterministic-fallback.ts` estimator and projection call site.

## Keep long-running compaction recovery progressing (2026-08-03)

### What changed

- The automatic-compaction soft cap now resets after each provider turn instead of lasting for the
  whole multi-tool agent run. The completed turn's zero-yield recovery still observes its original cap
  before the reset, while the absolute session cap remains authoritative for every route.
- Required-compaction failures now resume queued work after an accepted recovery compaction without a
  synthetic `continue`, while rejected recovery remains terminal.
- Provenance-confirmed required recovery uses the persisted byte-derived estimate when no valid
  provider usage sample exists.
- Deterministic recovery measures the reconstructed suffix instead of stale cumulative assistant usage.
  It keeps the prepared boundary when safe and otherwise advances to the latest complete persisted user
  turn, including expanded skill text and its chronological suffix, with strict retained-message schemas.

### Why

- Long `ulw` runs could complete three valid compactions and then reject every later threshold
  compaction as if the whole agent run were one provider turn.
- When summarization then failed, a fitting skill-bearing suffix could be rejected because provider
  usage still described the discarded pre-compaction prefix. Repeated continuations surfaced the same
  threshold error instead of recovering.

### Why this cannot be expressed externally

- The fix depends on internal provider-turn lifecycle state, exact session entry boundaries, compaction
  admission, and continuation ownership.

### Expected merge conflict zones

- `src/core/agent-session.ts` compaction retry/continuation ownership and upstream telemetry lifecycle.
- `src/core/extensions/builtin/compaction/` admission, fallback, and provider-turn accounting.

## Compact completed apply_patch result details (2026-08-02)

### What changed

- Completed `apply_patch` previews retain the TUI's bounded diff and retain a complete unified patch only when it is at most 16 KiB per file; larger patch bodies are omitted rather than persisted or emitted as malformed truncated diffs.
- Nested applied-operation previews are rebuilt as lightweight metadata without full diff or patch bodies, including the fail-fast `ApplyPatchError` recovery result.
- App-server file-change projection keeps its complete unified-diff contract for retained patches within the 16 KiB budget; oversized patches do not produce a file-change diff from persisted result details.

### Why

- Full old/new file contents in unified patches dominated completed tool-result details after diff compaction, so large add, delete, and update operations still scaled with source size in session files and resident memory.
- App-server projection and session persistence consume the same completed result object with no extension-scoped post-projection persistence seam. A fixed budget is therefore required to bound retention without storing a second live-only copy; omitting oversized patches avoids sending invalid partial unified diffs.

### Why this cannot be expressed externally

- The payload and its source-backed unified patches are constructed inside the builtin `apply_patch` tool before app-server projection and session persistence.

### Expected merge conflict zones

- LOW: `core/extensions/builtin/gpt-apply-patch/apply.ts` and `tool.ts` completed-result construction.

## Backfill: injected app-server turns (2026-08-01)

### What changed

- App-server clients can inject turns through the runtime and thread handlers while preserving the normal turn lifecycle.

### Why

- Remote session controllers need a first-class path that behaves like an ordinary user turn.

### Why this cannot be expressed externally

- Injection crosses app-server runtime, thread state, turn scheduling, and session event emission.

### Expected merge conflict zones

- `modes/app-server/runtime.ts`, `threads/handlers.ts`, and `threads/turn-runtime.ts`.

## Supersede level-scoped high-reasoning warning deduplication (2026-07-31)

### What changed

- High-reasoning warnings are now deduplicated once per provider/model identity
  for the lifetime of an `AgentSession`, rather than once per
  provider/model/reasoning-level tuple.
- Moving between `xhigh`, `max`, lower reasoning levels, or another model and
  back does not append the same warning again.
- A different sensitive provider/model identity still receives its own first
  warning.

### Why

- The released provider/model/level behavior caused the large warning box to
  reappear while the user was only changing reasoning effort. This follow-up
  intentionally supersedes that earlier contract.

### Why extension system couldn't handle this

- Warning deduplication is session-owned state inside `AgentSession` and must
  apply consistently before TUI and RPC consumers receive the event.

### Expected merge conflict zones

- LOW: `core/agent-session.ts` high-reasoning warning state and emission.

## Required-compaction recovery and queue chronology (2026-07-31)

- Targeted required-compaction summarization failures can recover from a deterministic, suffix-safe local checkpoint without a second provider request; unfit recovery remains fail-closed and preserves the latest request.
- Truncation recovery requires structured transient `SummaryRequestError` provenance; generic error text cannot authorize fallback.
- Recovery retains task intent and UTF-8-safe bounded text while todo/checkpoint snapshots remain only in their separately persisted canonical entries, not duplicated in compaction details.
- Terminal queue restoration now follows global submission chronology across native and compaction-owned input through a non-enumerable compatibility side channel, without changing native steer priority or abort-state semantics.

## Refusal fallback exhaustion resets retry state (2026-07-31)

### What changed

- `core/agent-session.ts`: terminal classifier-refusal fallback exits now emit the matching failed `auto_retry_end` event and reset the retry attempt counter when a retry actually started.
- The zero-attempt refusal path remains event-free, so `auto_retry_end` still pairs only with a prior `auto_retry_start`.
- Regression coverage drives every configured fallback to refusal, then proves the session is idle and the interactive double-Escape history action works again.

### Why

- Refusal exhaustion previously resolved the retry promise without clearing `_retryAttempt`. The TUI therefore kept treating an idle session as retrying, so every Escape re-entered abort cleanup instead of arming the double-Escape session-history shortcut.

### Expected merge conflict zones

- LOW: `agent-session.ts` in `_handleRetryableError()`'s classifier-refusal terminal branches.

## Claude SDK OAuth provider identity (2026-07-31)

### What changed

- Renamed the SDK-backed Claude Pro/Max builtin provider, extension directory, runtime/model ID, OAuth storage sentinels, settings key, account directory, imports, tests, QA scenarios, and public commands from `claude-agent-sdk` to `claude-sdk-oauth`.
- Renamed the provider-local TypeScript symbols to the same identity while preserving the upstream npm dependency and executable packages under `@anthropic-ai/claude-agent-sdk`.
- Split the oversized stream test into prompt-bridge and stream-event suites without changing its five pinned behaviors.

### Why

- `claude-agent-sdk` conflated Senpi's provider identity with Anthropic's upstream package name and obscured that this lane is specifically the subscription OAuth surface.
- There was no separate `claude-oauth` implementation to retain; the renamed provider is the sole SDK-backed OAuth implementation.

### Why extension system couldn't handle this alone

- The extension owns the provider implementation, but host registration order, RPC/app-server account imports, persisted auth keys, settings, and QA surfaces all reference its identity outside the extension directory.

### Expected merge conflict zones

- HIGH: the renamed builtin extension directory and provider-focused tests.
- MEDIUM: builtin registration, RPC/app-server account imports, provider docs, and QA scenario names.

## Breaker-cancelled opportunistic compaction no longer blocks admission (2026-07-31)

### What changed

- `core/agent-session.ts`: prompt, final-payload, scheduled-continuation, and retry admission now proceed without opportunistic compaction when the latest compaction rejection is `circuit-breaker`.
- Final-payload admission still fails closed when the provider payload is actually oversized, and overflow-triggered compaction remains fail-closed.
- Regression and real-CLI coverage prove breaker cooldown does not permanently reject prompts while non-breaker cancellation remains blocking.

### Why

- The circuit breaker stops repeated summarization spend during provider outages. Converting its cooldown rejection into `RequiredCompactionError` permanently bricked sessions above the soft threshold instead of allowing the provider or existing overflow recovery to make the real admission decision.

### Why extension system couldn't handle this alone

- Extensions report the rejection cause, but core owns every provider-admission site and decides whether a failed opportunistic compaction blocks the turn.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` compaction admission and retry-continuation paths.

## Failed pre-prompt compaction reports terminal recovery (2026-07-30)

### What changed

- `core/agent-session.ts`: `_runPrePromptCompaction()` now emits failed `compaction_end` events with `willRetry: false`. Its caller throws `RequiredCompactionError` when compaction fails, so no retry can follow that terminal event.
- Coverage drives a real pre-prompt overflow compaction through a failing faux provider and pins both the truthful event and restoration of queued TUI input through the real interactive helper.

### Why

- Emitting `willRetry: true` deferred queued input to native session queues even though failed compaction blocks provider admission, leaving that input parked indefinitely.

### Why extension system couldn't handle this alone

- `willRetry` is authored inside the core pre-prompt compaction lifecycle before extensions consume the event; only the session can truthfully report whether its caller will retry.

### Expected merge conflict zones

- LOW: `agent-session.ts` in `_runPrePromptCompaction()`'s terminal catch emission.

## high_reasoning_warning narrowed to gpt-5.6-sol only (2026-07-30)

### What changed

- `high-reasoning-warning.ts`: `isSensitiveHighReasoningModel` now matches ONLY gpt-5.x "sol" variants via a dedicated regex (`/gpt-5(?:\.\d+)?-sol(?![a-z])/i`), fully decoupled from `supportsXhigh`/`supportsMax`. The prior implementation reused those capability gates, so the scary warning wrongly fired for every frontier model that merely supports xhigh/max (claude-fable-5, opus, sonnet-5, deepseek-v4).

### Why

- The warning is about a specific risky model family (gpt-5.6-sol-like), not about xhigh/max capability. Conflating the two surfaced the warning on anthropic/claude-fable-5 @ xhigh, which was not intended. The negative lookahead keeps unrelated ids such as `upstage/solar-pro-3` from matching.

### Why extension system couldn't handle this alone

- The detection is consumed by the in-session emit path (`agent-session.ts`); it is core risk logic, not an extension concern.

### Expected merge conflict zones

- LOW: `high-reasoning-warning.ts` `isSensitiveHighReasoningModel`. `thinking-levels.ts` is deliberately unchanged so capability gating (fable-5 still supports xhigh/max) is preserved.

## Kimi XTML thinking recovery runs without tools (2026-07-30)

- `ModelRuntime.stream()` and `streamSimple()` now compose model recovery through the AI package's shared
  `wrapStreamWithModelRecovery()` boundary.
- Kimi structural response-channel recovery therefore runs on final-answer requests with an empty tool list, while
  Claude/Kimi leaked tool-call recovery still activates only when tools are available.
- Real CLI QA adds `--scenario kimi-xtml-thinking-recover`, proving a malformed thinking-only first response is
  discarded, the second response is visible exactly once, XTML markers never leak, real auth is unchanged, and
  the sandbox is cleaned.

## Runtime API keys propagate to session titles (2026-07-30)

- Background session-title generation now reuses the active agent request API key before resolving provider
  headers and compatibility options.
- This prevents a turn launched with `--api-key` from succeeding under one credential and then sending its
  `x-apitopia-session` title request with a different configured credential, which Apitopia rejects with 401.
- Coverage: `test/agent-session-auto-title-routing.test.ts`.

## high_reasoning_warning for sensitive frontier models at xhigh/max (2026-07-30)

### What changed

- New `core/high-reasoning-warning.ts`: provider-agnostic, model-name-based detection (`isSensitiveHighReasoningModel`, reusing `supportsXhigh`/`supportsMax`) plus `shouldWarnHighReasoning` and `buildHighReasoningWarning`.
- `agent-session.ts`: emits a new `high_reasoning_warning` `AgentSessionEvent` when a sensitive model is driven at xhigh/max, deduped by provider/model/level, wired into `_switchActiveModel` and `_setThinkingLevel`.

### Why

- Frontier reasoning models (gpt-5.x, deepseek-v4-pro/flash, opus-4-6..5, sonnet-5, fable-5) at xhigh/max are acutely prompt-sensitive: human-prompted runs risk non-stopping, unrequested actions, or risky behavior. The warning urges use via the ultrabrain subagent and states direct-use responsibility.

### Why extension system couldn't handle this alone

- The event must fire from session model/thinking-level transitions inside `AgentSession`, which extensions can only observe after the fact; the dedupe + emit belongs in the session lifecycle.

### Expected merge conflict zones

- LOW: `agent-session.ts` `_switchActiveModel`/`_setThinkingLevel` and the `AgentSessionEvent` union.

## Ollama Cloud keeps its provider-owned dynamic catalog (2026-07-30)

### What changed

- `ModelRuntime` leaves builtins that already implement `refreshModels` unwrapped instead of replacing their
  refresh path with the static `pi.dev` catalog overlay. This preserves both Radius and the new Ollama Cloud
  `/api/tags` + `/api/show` discovery path.
- An `ollama` provider with an explicit models.json catalog does not run the Cloud builtin refresh first and replaces
  rather than augments any in-memory Cloud catalog. Hot reload therefore removes stale Cloud tags instead of rebinding
  them to the local base URL, without affecting dynamic discovery for Radius or other providers.
- The CLI recognizes `ollama` as `Ollama Cloud`, documents `OLLAMA_API_KEY`, and uses
  `qwen3.5:397b` as the current default when it is present in the refreshed catalog.
- `test/ollama-provider.test.ts` drives `ModelRuntime.create()` with a mocked Ollama host and proves the
  provider-owned catalog reaches the runtime and persisted model store.

### Why this belongs in core

- Builtin catalog wrapping happens before extensions and models.json overlays are composed. A provider factory
  cannot preserve its own refresh implementation after the runtime has replaced it.

### Expected merge conflict zones

- LOW: builtin wrapping predicates in the async and sync `ModelRuntime` constructors.
- LOW: additive provider display/default/help entries.

## Bun self-updates preserve the Bun launcher (2026-07-30)

- Bun-managed global self-updates now replace Bun's generated Node-shebang symlink with a small launcher that
  executes the updated `dist/cli.js` through the Bun runtime that performed the repair.
- The repair uses the Bun runtime's own `process.execPath`, supports Bun binaries installed outside the global bin
  directory, and is skipped on Windows where Bun uses platform-specific shims.
- If `bun pm bin -g` does not return a global bin directory, self-update is now rejected instead of installing
  without a launcher repair.
- Coverage: `test/suite/regressions/496-bun-launcher-self-update.test.ts`.

## Shell-command credential resolution retries before giving up (2026-07-29)

### What changed

- `core/resolve-config-value.ts`: `executeCommandUncached` now runs up to 3 attempts (250ms then 1000ms backoff
  via a blocking `Atomics.wait` sleep — the call sites are synchronous `execSync`/`spawnSync` already) before
  returning `undefined`. Previously a single failed spawn, non-zero exit, or timeout of a credential helper
  propagated through `resolveConfigValueOrThrow` as `Failed to resolve API key … from shell command`, which
  `agent-session` classifies as hard-error eligible and ejects the active model without a single retry.
- Coverage: `test/resolve-config-value.test.ts` — new: transient-fail-then-success resolves on attempt 3;
  persistent failure bounded at exactly 3 attempts. Updated: cache-failure arithmetic (one failing resolve now
  costs 3 executions before the `undefined` is cached).

### Why

- Incident session `019faccb-3e7c-7307-8b19-2c7fb9e77b5c` (2026-07-29), five fallback cascades in one day:
  every cascade opened with `API key auth failed for provider kimi-code: Failed to resolve API key … from shell
  command: omp token kimi-code`, hard-error ejecting `kimi-code/k3`; the same flake hit `omp token anthropic`
  mid-chain. Measured `omp token` cold-start latency is 1.5–4.0s per invocation (bun startup + SQLite auth
  store); under load the subprocess intermittently fails while the credential itself is healthy — re-running it
  seconds later succeeds. A hard-error ejection on a transient resolver blip converts a one-second hiccup into
  a full provider-switch cascade (primary → exhausted fallbacks → last-resort model).

### Expected merge conflict zones on next upstream sync

- MEDIUM: `core/resolve-config-value.ts` also exists upstream in badlogic/pi-mono (same
  `executeCommandUncached`), so the retry wrapper (`executeCommandOnce` keeps the original body) can collide
  with upstream edits to that function; constants and `sleepBlocking` are additive. The same fix belongs
  upstream as well.

## Kimi XTML recovery preserves protocol identity (2026-07-29)

### What changed

- `core/model-runtime.ts` passes both `createXtmlRecoveryStreamParser` and `protocol: "kimi-xtml"` to the shared
  invoke-recovery wrapper for Kimi models.
- Successful recovered tool calls and terminal recovery failures now expose Kimi-specific diagnostics and
  `recovered-kimi-xtml-*` IDs instead of misleading ANTML metadata.
- `test/kimi-xtml-recovery-runtime-boundary.test.ts` pins the user-visible runtime result while the default ANTML
  path remains covered in the AI package.

### Expected merge conflict zones

- LOW: the two invoke-recovery call sites in `core/model-runtime.ts`.

## Static credential headers participate in real provider auth resolution (2026-07-29)

### What changed

- `core/provider-header-auth.ts` classifies only credential-like provider headers, preserves case-insensitive
  override semantics, and derives distinct models.json versus extension status sources.
- `core/provider-api-key-auth.ts` resolves credential-bearing provider headers into a genuine header-only
  `AuthResult`, exposes the same result through `checkAuth()`, and leaves metadata-only or empty header maps
  unconfigured. Header-only auth does not fabricate an API-key login method, and OAuth providers remain logged out
  when their only configured headers are request metadata.
- `configuredRequestAuthStatus()` uses the same credential-header contract, keeping synchronous registry reads,
  asynchronous availability snapshots, TUI/RPC status, and request execution aligned.

### Why this belongs in core

- Auth resolution, registry availability, and status projection are package-owned provider-composition seams. An
  extension can supply headers but cannot make the shared model runtime interpret them consistently.

### Coverage

- `test/provider-composer-headers-auth.test.ts` exercises models.json and extension header auth through registry
  availability, `checkAuth()`, `getAuth()`, and runtime streaming, while locking metadata, empty-header, OAuth, API
  key, and `authHeader` behavior.
- `packages/ai/test/auth-headers.test.ts` and `packages/ai/test/openai-header-auth.test.ts` cover the shared
  classification and OpenAI-compatible request path.

### Expected merge conflict zones

- LOW: additive `core/provider-header-auth.ts`, `core/provider-api-key-auth.ts`, and focused regression coverage.
- MEDIUM: `core/provider-composer.ts` auth composition and status projection.

## Anthropic credits_required 429 pins the billing fallback (2026-07-29)

### What changed

- `core/retry-fallback/billing.ts`: `BILLING_ERROR_PATTERN` now matches Anthropic Console credit exhaustion —
  the 429 `rate_limit_error` whose details carry `error_code: credits_required` ("Usage credits are required
  for this model."). The hard-error fallback branch classifies the shape as `billing` instead of `hard-error`.
- `core/retry-fallback/cooldown.ts`: the 30-minute billing suppression bucket covers the same wording instead
  of the 30-second rate-limit bucket that let cooldown-expiry resurrect the dead model.
- Coverage: `test/suite/retry-fallback-billing-swap.test.ts` (pinned swap + classifier rows),
  `test/suite/retry-fallback-cooldown.test.ts` (duration rows); channel-3 real-CLI proof
  `.agents/skills/senpi-qa/scripts/mock-loop-credits-fallback.mjs` (one primary request, `reason: "billing"`
  in fallback.log, final marker streamed by the fallback model).

### Why

- Incident session `019fac55-3531-7d35-92f1-2d740b659c3c` (2026-07-29): `anthropic/claude-fable-5` answered
  429 credits_required. The switch to `apitopia/kimi-k3-unlocked` fired as `transient`, the 30-second cooldown
  expired, and cooldown-expiry reverted the session into the billing-dead fable-5; the chain then thrashed
  fable-5 → kimi-k3 → opus-5 → opus-4-8 → fable-5 until the session was abandoned. Billing-class failures
  never recover on the same account, so the fallback for one must pin from the first failure.

### Expected merge conflict zones on next upstream sync

- LOW: one regex each in `core/retry-fallback/billing.ts` and `core/retry-fallback/cooldown.ts`; both modules
  are fork-local.

## From-source real-config warning (2026-07-29)

### What changed

- New `from-source-config-guard.ts`: pure predicates detecting a run from TypeScript sources (module URL extension, never a bun binary) whose resolved agent dir is the real `~/.senpi/agent` with no `SENPI_CODING_AGENT_DIR` override.
- `main.ts` prints one yellow stderr warning right after agent-dir resolution when that combination holds, advising an isolated agent dir for dev/QA runs. No change to `resolveAgentDir` precedence or any default.

### Why

- Ad-hoc from-source runs inside the repo (which has `.senpi/` without `agent/`) silently target the real user config; that exact setup has previously leaked writes into the user's `settings.json`. Detection is separated from policy: the warning makes the footgun visible without breaking legitimate real-config runs.

## Interactive startup loading indicator (2026-07-29)

### What changed

- New `cli/startup-loading-indicator.ts`: single-line dim ANSI spinner (`⠋ Loading senpi… <phase>`) with a
  120ms grace delay (fast startups stay flash-free), phase updates, pause/resume, and an idempotent `stop()`
  that clears the line and restores the cursor (also via a `process` exit hook). It engages only when
  `appMode === "interactive"`, stdout is a TTY, and `--help` was not requested.
- `main.ts` starts the indicator before `createAgentSessionRuntime` — the extensions/models/trust window that
  previously rendered nothing — switches the phase to `opening session` before the initial session is created,
  and stops it in a `.finally` before any other stdout writer (TUI, help, diagnostics) takes over.
- Mid-load project-trust prompts (`createProjectTrustContext` `ui.select`/`confirm`/`input`) are wrapped by
  `pauseIndicatorDuringPrompts`, so the trust selector TUI never fights the spinner for the terminal.
- Coverage: `test/startup-loading-indicator.test.ts` (grace delay, frame animation, phase updates,
  pause/resume, stop idempotency, TTY/help gating, prompt-pause wrapping).

### Why

- Interactive startup completed the entire heavy runtime creation before the TUI existed, leaving the terminal
  blank and apparently stuck (QA repro: ~23s of empty screen with a slow-loading extension). Codex's TUI
  addresses the same window by rendering a dim placeholder header until the session is configured
  (`codex-rs/tui` chatwidget); this is the minimal-conflict equivalent for senpi's pre-TUI bootstrap window.

### Expected merge conflict zones on next upstream sync

- LOW: the import block and indicator wiring around `createAgentSessionRuntime` in `main.ts`; the module itself
  has no upstream counterpart.
- LOW: the `projectTrustContext` fallback wrap inside `createRuntime`.

## Repeated provider-stream stalls escalate to the fallback chain (2026-07-29)

### What changed

- `core/agent-session.ts`: the transient retry branch tracks consecutive provider-stream stalls
  (`isProviderStreamStallError` from pi-ai, covering both the idle-timeout and stream-start-timeout wordings). The second consecutive stall escalates to the fallback chain
  immediately (same `tryFallback("transient")` path as budget exhaustion); without a chain the retry loop ends
  instead of replaying the identical payload for the remaining same-model budget. Non-stall failures reset the
  streak, fallback switches and fresh retry loops start at zero.
- Coverage: `test/suite/retry-fallback-stall-escalation.test.ts` (escalation with chain, surrender without chain,
  streak reset for non-consecutive stalls).

### Why

- A stall means the provider accepted the request and delivered zero events for the entire idle budget
  (`httpIdleTimeoutMs`, default 300s). Each retry replays an identical payload, so a hung provider/gateway
  previously cost (1 + maxRetries) * 300s (~20 minutes) of opaque dead air per turn before the chain was
  consulted - experienced as a permanently wedged session (Discord report 2026-07-29, donated session
  019fa8da-43ad-70b7-b01b-8f34f4d907f2 records 1906/1919: reopening a 5h session hit the 300s idle timeout on
  every goal-continuation while new sessions worked).

### Expected merge conflict zones on next upstream sync

- MEDIUM: `_handleRetryableError` transient branch and the `switchedFallback` reset in `core/agent-session.ts`.

## Availability-aware default Fable fallback chain (2026-07-29)

### What changed

- `core/retry-fallback/settings.ts` now owns retry setting types and normalization, including the shipped default
  `anthropic/claude-fable-5` chain:
  `apitopia/kimi-k3-unlocked:max` -> `anthropic/claude-opus-5:xhigh` ->
  `anthropic/claude-opus-4-8:xhigh`.
- The default applies only when `retry.fallbackChains` is absent or malformed. Explicit chain maps, including
  an explicitly empty map, remain authoritative.
- `core/retry-fallback/chains.ts` and the model-fallback builtin omit unavailable models and remove chains with
  no usable candidates, so runtime selection and `/fallback` display agree.
- Existing defaults remain enabled: model fallback on, server-side fallback abort on, and cooldown-expiry revert.
- Coverage: `test/settings-manager-retry-fallback.test.ts`,
  `test/suite/model-fallback-command.test.ts`, and `test/suite/model-fallback-host-wiring.test.ts`.

### Why

- A fresh Senpi install previously aborted provider-side fallback by default but had no client chain, producing a
  dead-end warning. Shipping the preferred chain makes that default policy actionable while keeping optional model
  providers safe: missing models are skipped rather than warned about or selected.

### Expected merge conflict zones on next upstream sync

- LOW: retry settings imports and delegation in `core/settings-manager.ts`; the new retry settings module has no
  upstream counterpart.
- LOW: canonical chain construction in `core/retry-fallback/chains.ts`.
- LOW: registry-aware loading in `core/extensions/builtin/model-fallback/`.

## Stream-start timeout wiring and unregistered-api error context (2026-07-29)

### What changed

- `core/settings-manager.ts`: new `retry.provider.streamStartTimeoutMs` setting and
  `getAgentStreamStartTimeoutMs()` (default 90000ms; 0 disables; the default is clamped to a
  shorter idle timeout and disabled together with a disabled idle guard). `core/sdk.ts` and the
  interactive settings handler wire it into `Agent.streamStartTimeoutMs`.
- `core/provider-composer.ts`: the stream-time `No API provider registered for api: <api>` error
  now names the model (`provider/id`) and points at the models.json provider entry or the missing
  provider extension.
- Coverage: `test/settings-manager.test.ts` (retry describe), `test/provider-composer-unknown-api.test.ts`,
  `packages/ai/test/retry.test.ts` (stream timeout wordings stay retryable).

### Why

- Incident (donated session log): a dead upstream accepted requests but never sent a first byte.
  With only the 300s idle bound, each turn attempt froze the session for 5 minutes with `usage: 0`
  and nothing persisted; retries repeated the same 300s wait, making the session practically
  unrecoverable while new sessions worked. A 90s first-event bound with the retryable wording lets
  the retry/fallback ladder engage quickly. Related incident error `No API provider registered for
  api: kiro-api` carried no context about which model or config produced it.

### Expected merge conflict zones on next upstream sync

- LOW: one settings getter + one field in `ProviderRetrySettings`; one error message in
  `composeModelProvider`; one option in the `Agent` construction in `core/sdk.ts`.

## Provider idle retries preserve user input and use a bounded retry budget (2026-07-29)

### What changed

- `core/agent-session.ts`: retries triggered by the shared anchored provider-timeout classifier defer queued steering
  and follow-up input from the retry's first provider request. This covers the two agent-loop stream watchdog messages
  and exact transport-level `Request timed out` variants without matching incidental command, MCP, or extension text.
- `core/settings-manager.ts`: `retry.provider.streamRetryTimeoutMs` configures the first-request retry liveness cap
  (default 30 seconds; `0` disables). The retry clamps only enabled idle/start guards, so it never re-enables an
  explicitly disabled guard. Both timeout bounds return to their configured values for later provider requests.
- The retry start bound is capped as well as the provider request option, while the configured idle timeout resumes
  after the first event so healthy reasoning gaps are not limited to 30 seconds.
- Consecutive transport timeouts reported with `stopReason: "aborted"` keep consuming the same retry counter. Only a
  genuinely successful assistant response resets the budget or emits `auto_retry_end { success: true }`.
- Retry continuations use the session-work barrier and revalidate atomically with the scheduled-continuation path.
  Accepted recompaction stays queue-first while retaining timeout options; reconstructed failed assistant tails are
  retired before continuation. A concurrent low-level `Agent.prompt()` is treated as a benign takeover, and session
  settlement is never emitted while Agent core is still streaming.
- Coverage: `test/suite/regressions/provider-idle-recovery.test.ts` pins exact request text/order, configurable timeout
  sequences, disabled guards, negative classifier shapes, and a real no-first-event stream expiry at the cap;
  `test/settings-manager.test.ts` pins setting defaults and `0` semantics.

### Why

- A silent provider stream previously consumed user steering into another full-length retry. Repeated 300-second
  retries made the session look stuck and could leave the user's `continue` adjacent to an error instead of a real
  answer.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `core/agent-session.ts` retry-controller continuation options and scheduled-continuation admission.
- LOW: `core/settings-manager.ts` provider retry settings and timeout getters.

## Absent fallback chains no longer produce a startup warning (2026-07-28)

### What changed

- `core/retry-fallback/validate.ts`: `validateFallbackChains(undefined, registry)` now returns no warnings. Explicit malformed values such as `null` and arrays still produce `Fallback chains must be a plain object.`
- Coverage: `test/suite/retry-fallback-validate.test.ts` pins the absent-setting case.

### Why

- `retry.fallbackChains` is optional. A fresh configuration without the setting previously emitted a misleading startup warning even though the user had not configured a malformed chain.

### Expected merge conflict zones on next upstream sync

- LOW: one early return in `validateFallbackChains`.

## Footer shows (OmO Native) when the local omo-senpi + senpi-task stack is installed (2026-07-28)

### What changed

- `core/omo-native-detect.ts` (new): `detectOmoNativeInstall(packages, agentDir)` — sync, dependency-free detection of the "OMO Native" local install. A settings `packages` entry that is a local path resolving to a dir whose package.json name is `@code-yeongyu/omo-senpi`, whose derived repo root (`pluginPath/../../..`) contains both workspace packages `@oh-my-opencode/omo-senpi` and `@oh-my-opencode/senpi-task`. Mirrors gates 1 and 2 of the beta `detectOmoLocalInstall` (beta/omo-local-update.ts), dropping gate 3 (the `git rev-parse --show-toplevel` integrity check) so it stays sync and cheap for footer rendering; the beta module's export policy forbids importing its helpers into production core.
- `core/footer-data-provider.ts`: `FooterDataProvider` gains `setOmoNative(boolean)` / `isOmoNative()` (field-backed, matching the existing `availableProviderCount` injection pattern) and `isOmoNative` is exposed on `ReadonlyFooterDataProvider`.
- `modes/interactive/interactive-mode.ts`: after constructing the provider, calls `setOmoNative(detectOmoNativeInstall(this.settingsManager.getPackages(), getAgentDir()))`.
- Coverage: `test/omo-native-detect.test.ts` pins happy + edge cases; `test/omo-native-footer.test.ts` pins the rendered segment; `test/footer-width.test.ts`, `test/grok/footer.test.ts`, `test/grok/classic-chrome-characterization.test.ts` updated for the new `isOmoNative` Pick member.

### Why

- A senpi session backed by the local OMO source checkout (omo-senpi + senpi-task workspace packages installed as a local-path package) is the "OMO Native" configuration; surfacing it in the footer makes the active stack visible at a glance, mirroring the detection already used by the beta `senpi update` local-update flow.

### Expected merge conflict zones on next upstream sync

- LOW: `core/footer-data-provider.ts` around the `availableProviderCount` field and the `ReadonlyFooterDataProvider` Pick (additive).
- LOW: `modes/interactive/interactive-mode.ts` around the `FooterDataProvider` construction site.
- NEW file `core/omo-native-detect.ts` — no upstream counterpart, no conflict.

## Provider-qualified fallback selectors resolve inside their own provider (2026-07-28)

### What changed

- `core/retry-fallback/chains.ts`: `parseFallbackSelector` now filters the lookup list to the explicitly requested provider before calling `parseModelPattern`. Previously the id pattern was resolved globally, so a foreign id containing the pattern won over the requested provider's exact id: `anthropic/claude-opus-5:xhigh` fuzzy-matched Bedrock's `us.anthropic.claude-opus-5`, failed the provider check, and produced the spurious startup warning `Fallback chain entry ... is not a valid or known model selector.` (The ambiguity arises whenever two configured providers carry the same bare id, e.g. `anthropic` + `anthropic-api`, which makes the bare-id exact match ambiguous and drops resolution into partial matching.)
- Coverage: `test/suite/retry-fallback-chains.test.ts` pins in-provider resolution when `anthropic`, `anthropic-api`, and `amazon-bedrock` all carry colliding `claude-opus-5` ids, with and without a thinking-level suffix.

### Why

- A selector with an explicit provider can only ever resolve inside that provider (the post-check rejected cross-provider results), so global resolution could only turn valid selectors into spurious warnings; scoping converts those failures into the correct in-provider match.

### Expected merge conflict zones on next upstream sync

- LOW: one scoped-lookup block inside `parseFallbackSelector` in `chains.ts`; upstream edits to selector parsing will conflict trivially.


## Paste markers survive editor hand-off and setText round-trips (2026-07-28)

- `modes/interactive/interactive-mode.ts` `setCustomEditorComponent()` now transfers editor content safely when switching between the default and a custom editor: if both editors support the paste-state API (`getPasteState`/`setPasteState` from pi-tui), the raw text plus the registry snapshot are transferred so `[paste #N ...]` markers stay collapsed; otherwise it falls back to the expanded text — `getExpandedText?.()`, or expansion from the paste snapshot via the exported `expandPasteMarkers()` when the source implements `getPasteState` without `getExpandedText`, or the raw text when neither capability exists. Previously the raw text alone was copied into a fresh editor with no registry, turning live markers into dead literals and silently dropping the pasted body from the submitted prompt.
- The companion tui change (`packages/tui/src/changes.md`, same date) makes `Editor.setText()` prune (exact canonical-marker match) instead of clear the paste registry, which fixes the remaining same-instance round-trips: `showExtensionCustom()` save/restore and `restoreQueuedMessagesToEditor()` / `abortAndFireQueuedMessages()` draft restoration. Those call sites are unchanged.
- Symptom fixed: transcript/session showed only the `[paste #1 +18 lines]` placeholder as the user message after pasting, opening a dialog (or aborting with queued messages), and submitting.
- `setCustomEditorComponent(undefined)` is now a draft no-op when the default editor is already active (e.g. `resetExtensionUI()` calls it unconditionally during extension resets): no hand-off happens, so no setText round-trip touches the user's draft.
- Details for the interactive hand-off live in `src/modes/interactive/changes.md` (same date).
- Coverage: `test/suite/regressions/0000-editor-paste-marker-transfer.test.ts` drives the real `setCustomEditorComponent` (prototype + fakeThis pattern) with real tui editors: registry transfer to a paste-aware editor, expanded-text fallback for a plain `EditorComponent`, restore to the default editor, full plain-editor round-trip, and the same-instance no-op.

## Prompt-cache-aware foreground tool budgets (2026-07-28)

### What changed

- `core/settings-manager.ts`: new `PromptCacheSettings` (`cacheAwareTimeouts?: boolean` default true,
  `safetyBufferSeconds?: number` default 30) exposed as `Settings.promptCache`.
- `core/prompt-cache-budget.ts` (new): `resolvePromptCacheSafeWaitSeconds(model, settings, env)` =
  pi-ai's resolved cache TTL minus the safety buffer, or `undefined` when the feature is disabled, no model
  is active, the TTL is unknown, or the buffer swallows the whole TTL. Also exports
  `PROMPT_CACHE_SAFE_WAIT_ENV` and `DEFAULT_PROMPT_CACHE_SAFETY_BUFFER_SECONDS`.
- `core/agent-session.ts`: `resolvePromptCacheSafeWaitSeconds()` recomputes from the LIVE current model, and
  `syncPromptCacheSafeWaitEnv()` mirrors it into the advisory `PI_PROMPT_CACHE_SAFE_WAIT_SECONDS` env var
  (deleted when no budget applies) on session start, reload, and every model select — so out-of-process
  readers such as the omo `task` tool can size their own foreground waits.
- The typed `ExtensionContext.getPromptCacheSafeWaitSeconds()` getter is documented in
  `core/extensions/changes.md`.

### Why

- Blocking a foreground tool past the model's prompt-cache lifetime expires the cache and forces a full
  re-read on the next request. Sizing the ceiling by the cache TTL keeps the cache warm, and the still-running
  work is handed to a background session alive instead of being killed.

### Behavior when no budget applies

- Byte-identical to previous behavior: the injected bash default and recommended maximum keep their existing
  values, the policy prompt is unchanged under strict string equality, and the env var is absent.

## Catalog `-fast` variants resolve serviceTier/upstreamModelId without models.json entries (2026-07-28)

### What changed

- `core/provider-composer.ts` `resolveCompatibilityRequestConfig()`: `upstreamModelId` and
  `serviceTier` now fall back to the catalog `Model`'s own optional fields
  (`extensionModel ?? modelDefinition ?? model`), so generated catalog variants such as
  `openai/gpt-5.5-fast` (upstreamModelId `gpt-5.5`, serviceTier `priority`) request the priority
  tier and the upstream wire id with zero models.json configuration. Config and extension model
  definitions keep precedence over catalog defaults.
- Coverage: `test/model-runtime-catalog-service-tier.test.ts` pins the catalog fallback, the
  models.json override path, and end-to-end resolution through `ModelRuntime` (offline).

### Why

- `-fast` pseudo-models previously worked only when hand-declared in models.json; the generated
  OpenAI priority-tier variants (pi-ai `Model.upstreamModelId`/`serviceTier`) were inert without
  this fallback, since the main request path reads both values exclusively through
  `resolveCompatibilityRequestConfig()`.

### Expected merge conflict zones on next upstream sync

- LOW: two-line `??` fallback change in `resolveCompatibilityRequestConfig()`.

## Cancellable `session_before_reload` veto blocks reload while extensions protect live work (2026-07-28)
## Nearest-parent configuration discovery (2026-07-28)

### What changed

- `config.ts`: `getAgentDir()` now honors `SENPI_CODING_AGENT_DIR` first, otherwise finds the nearest ancestor with a real `.senpi/agent` directory before falling back to `~/.senpi/agent`. The exported `resolveAgentDir(cwd, homeDir, envDir)` makes the precedence contract deterministic for callers and tests.
- `nearest-parent-config.ts`: centralizes the bounded upward walk for config directories. It excludes `$HOME` so global configuration remains the fallback layer and refuses symlinked `.senpi` directories.

### Why

- Starting senpi from a nested project directory previously ignored that project's config and always selected the home agent directory.

### Expected merge conflict zones on next upstream sync

- LOW: `config.ts` around `getAgentDir()`; the discovery helper is a focused fork-owned module.


### What changed

- New cancellable extension event `session_before_reload` (`core/extensions/types.ts`, routed through the
  existing session-before machinery in `core/extensions/runner.ts`). `AgentSession.reload()`
  (`core/agent-session.ts`) now returns `{ cancelled: boolean; reason?: string }` and consults the new
  `checkReloadVeto()` BEFORE emitting `session_shutdown`, so a cancelling extension prevents the entire
  teardown on every reload path (`/reload`, `ctx.reload()`, config hot-reload, direct SDK/rpc/print calls).
- Interactive `/reload` pre-checks the veto and surfaces the extension's `reason` as a warning
  (`modes/interactive/interactive-mode.ts`). Docs: `docs/extensions.md` event flow + `#session_before_reload`.
- Coverage: `test/suite/session-before-reload.test.ts` pins veto-aborts-before-shutdown, normal reload
  passthrough, and the side-effect-free `checkReloadVeto()` probe.

### Why

- A reload tears down the extension runtime; extensions running background subagents (omo-senpi task
  runtime) had their children killed mid-flight by `/reload` or a config hot-reload. Only the session owns
  the teardown ordering, so the veto checkpoint must live in core, mirroring `session_before_switch`.

### Expected merge conflict zones on next upstream sync

- LOW: additive event plumbing in `extensions/types.ts` / `extensions/runner.ts`; MEDIUM: head of
  `reload()` in `agent-session.ts` (early-return veto + return-type change).

## Multi-session RPC host initializes the theme before serving sessions (2026-07-28)

### What changed

- `main.ts`: the `--mode rpc --multi-session` branch now calls `initTheme(startupSettingsManager.getTheme(), false)` immediately before `runMultiSessionHost(...)`. The host returns `Promise<never>`, so the pre-existing `initTheme()` call further down `main()` is unreachable on this path and the theme proxy stayed uninitialized for the whole host lifetime.
- Regression: `test/suite/regressions/0000-multi-session-theme-init.test.ts` spawns the real CLI in multi-session mode with a global extension that touches `theme` at load time and opens a session; pre-fix the extension load crashes with "Theme not initialized. Call initTheme() first." (surfaced by embedders such as T3 Code as transcript errors), post-fix the probe loads and the transcript stays clean.

### Why

- Extensions load per `open_session` inside the multi-session host, and any extension (or render helper) that reads the `theme` proxy crashed the session with "Theme not initialized". An extension cannot fix this ordering itself: the theme must be initialized by the host bootstrap before extension code runs, so this is a core `main.ts` fix.

### Expected merge conflict zones on next upstream sync

- LOW: one additive call (plus comment) inside the multi-session dispatch branch in `main.ts`; upstream edits to that branch will conflict trivially.

## Experimental `--grok-neo` mode: env-gated grok chrome for the interactive loop (2026-07-26)

### What changed

- New opt-in flag `--grok-neo` (`src/cli/args.ts`, gate `src/cli/grok-neo-gate.ts`): `SENPI_ENABLE_GROK_NEO` accepts `1`/`true`/`yes`, default OFF. When the gate is off the flag is absent from `--help` and parses as an unknown extension flag, exactly as if the feature did not exist. When on, it runs the ordinary interactive mode with the grok chrome (`chrome: "grok"` dispatch in `main.ts`) — same senpi process, no separate binary or daemon.
- New built-in themes `grok-night` and `grok-day` (`src/modes/interactive/theme/grok-night.json` / `grok-day.json`, registered in `getBuiltinThemes()` in `src/modes/interactive/theme/theme.ts`). Precedence: an existing settings theme always wins; `grok-night` is only an in-memory fallback when no theme was ever chosen (`applyGrokNeoThemeFallback` in `main.ts`) and is never written to `settings.json`. `--theme` registers theme resources; it does not select one.
- Chrome components under `src/modes/interactive/grok/`: rounded input card, compact footer (model + cwd only), welcome card, single-line tool rows with a `┃`/`◆` guide column, braille working indicator, and a palette/chrome-token layer that resolves colour through the active theme.
- User docs: `docs/grok-neo.md` (mode, gate, themes, in-process architecture, experimental status, independent-reimplementation and non-affiliation statement) plus a `docs/docs.json` navigation entry.

### Why

- Replaces the removed out-of-process Go TUI with an in-process presentation layer: one process and one deployable directory for the Bun binary (native addons ship as sidecars), with the classic TUI unchanged as the default.

### Expected merge conflict zones on next upstream sync

- LOW: additive seams only — the gate module, one conditional branch each in `args.ts` parse/help, the theme-fallback and `chrome` dispatch lines in `main.ts`, and the `grok-night`/`grok-day` registration in `theme.ts`.

## Extension user-message injections are retained when the prompt path rejects (2026-07-26)

- `core/agent-session.ts`: `sendUserMessage()` now tracks the prompt disposition. When `prompt()` rejects before the message reaches a queue or a turn (e.g. a required compaction that cannot complete, auth/model validation, or provider admission), the message is queued for later delivery (`deliverAs: "steer"` goes to the steering queue, otherwise the followUp queue) instead of being silently dropped. The rejection still propagates, so fire-and-forget extension bindings keep emitting their `send_user_message` error event.
- Root cause of the omo `team_wait` starvation forensics: member self-poller injections via `pi.sendUserMessage(..., { deliverAs: "followUp" })` vanished without a trace when the fresh-prompt path threw, leaving no record in the session JSONL while RPC-path `steer`/`follow_up` commands (which bypass `prompt()`) landed normally.
- Interactive `prompt()` behavior is unchanged: a rejected interactive prompt still drops the input and surfaces the error to the user (pinned by `test/suite/regressions/pre-prompt-compaction-no-continue.test.ts`).
- Coverage: `test/suite/agent-session-extension-injection.test.ts` pins retention for followUp and steer injections, exact-once delivery after recovery through the post-run drain, and no double-queueing on the streaming accept path.

## Reload-safe MCP preservation and extension-removal lifecycle event (2026-07-26)

- `session_extensions_removed` is emitted on the old extension runner when a `/reload` or a session replacement (`/new`, `/resume`, `/fork`, import) rebuilds the extension set. Its payload is `{ type: "session_extensions_removed", reason: SessionShutdownEvent["reason"], removed: Array<{ path, resolvedPath }> }`, allowing an extension that did not survive the rebuild to release resources after the new settings and active builtin set are known.
- Unchanged MCP servers now survive a classic `/reload`: the shared service reattaches and reconciles by config hash, preserving live connections while replacing changed servers and disposing removed ones. Provider-scoped MCP services still dispose on reload because their factory creates a replacement instance.
- If the MCP builtin itself is disabled during a reload or replacement, its removal event disposes the preserved classic service so stdio children cannot leak. For an otherwise wedged server, use `/mcp reconnect <name>` to force a fresh connection.

## Same-model-first transient retries and capped server waits (2026-07-26)

### What changed

- Supersedes the 2026-07-20 entry's sentence "retryable transient failures now switch to a configured fallback ...": transient retryable failures (timeouts, overload, 429, 5xx, transport drops) now retry the same model on the existing exponential backoff until `retry.maxRetries` is spent; only then does the configured `retry.fallbackChains` chain engage, and each fallback candidate starts with a fresh retry budget.
- `core/agent-session.ts`: `retry.provider.maxRetryDelayMs` (default 60000) now bounds the server-requested wait honored on the same model. Beyond the cap the fallback chain engages and the primary is suppressed for the requested duration; the turn fails with an informative error only when no chain candidate is available. Waits at or below the cap are honored as before.
- `core/retry-fallback/cooldown.ts`: timeout and connection/transport errors now carry a 60-second selector cooldown instead of the five-minute unmatched default, so revert-to-primary is no longer blocked for five minutes after one network blip. Existing tiers keep precedence: quota/billing 30 minutes, rate-limit 30 seconds, capacity 45 seconds plus jitter, 5xx 20 seconds, and a provider retry-after hint always wins.
- Unchanged: classifier-refusal fallback (immediate, pinned), hard-error fallback (quota/auth/model-not-found, immediate), and `retry.abortServerSideFallback` (default true) routing provider-side model substitution onto the configured chain.
- Cost/latency: with `retry.maxRetries >= 1` a fully failing chain now costs up to `1 + (chainLength + 1) * maxRetries` provider calls plus per-rung backoff before the turn fails; with `maxRetries: 0` every failure switches immediately, costing `1 + chainLength` calls.
## OMO local plugin remote-diff updater beta on bare `senpi update` (2026-07-26)

- A bare `senpi update` now triggers the beta OMO local-update hook (`src/beta/omo-local-update.ts`, reachable only through the two BETA-marked touch points in `package-manager-cli.ts`) before any self-update work. The hook compares the state of the two packages (`omo-senpi` + `senpi-task`) on `origin/dev` of the OMO source checkout against the locally installed modules, and updates the local install ONLY when they differ.
- The user's checkout receives ZERO git mutations: the hook performs one read-only `git fetch origin dev`, builds in a feature-owned persistent worktree under the agent directory, and atomically swaps the installed plugin directory by rename. No checkout/branch/commit/merge/reset/clean/stash/push ever touches the user's tree.
- `SENPI_OMO_LOCAL_UPDATE=0` is a kill-switch that disables the hook entirely. All failures are non-fatal: the hook never throws and never sets `process.exitCode`; any error downgrades to a warning plus a manual-update hint so the `senpi` self-update proceeds untouched.
- Fast path (2026-07-29): the skip decision now compares a build-input fingerprint of `origin/dev` (`src/beta/omo-local-update-fingerprint.ts`: sha256 over root tree entries minus documentation/agent-config paths) instead of the bare commit sha, so docs/CI-only churn in the omo monorepo no longer triggers the ~30s rebuild. When a rebuild IS needed, the bare-update foreground now only fetches and compares (~1s) and hands the build to a detached worker (`src/beta/omo-local-update-worker.ts`, hidden `senpi update --omo-local-update-worker` flag, output to `<agentDir>/omo-local-update/worker.log`); the worker serializes through the existing pid lock and swaps/stamps exactly like the former inline path. `SENPI_OMO_LOCAL_UPDATE_SYNC=1` restores the old blocking foreground behavior.
- The fast skip also checks the updater's current required-artifact contract independently of the historical stamp inventory. A legacy, stale, or externally damaged stamp can no longer hide a missing packaged LSP daemon CLI; the next update rebuilds and atomically repairs the plugin.
- Removal is exactly three steps: delete all `src/beta/omo-local-update*.ts` files; delete all `test/omo-local-update*` files; delete the BETA-marked touch points (the import, the hook calls, and the `--omo-local-update-worker` flag) in `package-manager-cli.ts`.

## App-server daemon launch diagnostics and hermetic lifecycle coverage (2026-07-24)

- The daemon launcher now classifies websocket listener occupancy before spawn: a compatible app-server answers `initialize` and attaches, while any other TCP listener fails immediately with an `EADDRINUSE` diagnostic instead of consuming the child readiness budget. Child-process startup stderr still accompanies actual post-spawn failures, and each launch replaces stale diagnostics.
- The real-CLI daemon lifecycle test isolates home/XDG state, verifies the pre-spawn occupied-port diagnostic and that it does not create a child stderr log, retries the bounded QA port pool, and awaits lock/process events rather than polling sleeps.

## Manual compaction keeps agent lifecycle subscription through abort (2026-07-24)

- `core/agent-session.ts`: manual or extension-initiated compaction claims its synchronous admission/barrier first,
  then aborts and waits for the active agent run while still subscribed. The abort's `agent_end` now clears the
  active-run and retry state before compaction disconnects for summary generation; all disconnected exits reconnect.
- Regression: `test/suite/compaction-race.test.ts` covers compaction during a live provider stream and asserts the
  aborted `agent_end` precedes compaction startup without deadlocking future prompts.

# changes

## Removed the legacy `--neo` Go TUI surface (2026-07-26)

### What changed

- Removed the Go TUI launcher, daemon dispatch, CLI flags, settings, documentation, build gate, and the retired Go package. The classic interactive and `--mode rpc` paths remain unchanged.
- Migrated generic RPC authentication and connection-handler framing coverage into `test/suite/rpc-auth-and-connection-handler.test.ts` before deleting the legacy-specific suites.

### Why

- The legacy out-of-process TUI and its daemon are no longer part of the supported CLI surface.

### Expected merge conflict zones on next upstream sync

- LOW: removal-only changes across fork-owned legacy surfaces.

## Inspector handoff and VM-import crash isolation (2026-07-24)

### What changed

- The launcher closes an inherited startup Inspector endpoint immediately before spawning `cli-main`, allowing the
  child process to bind the same configured endpoint instead of failing with `address already in use`.
- With `SENPI_RECOVER_INSPECTOR_VM_IMPORT=1` set at process start, interactive mode recovers only the exact unhandled
  Inspector-eval rejection produced when `import()` runs without a VM dynamic-import callback. Recovery is fail-closed
  by default; application-owned VM failures and unrelated uncaught exceptions remain fatal.

### Why

- The launcher and child previously inherited one fixed Inspector port, so developers attached to the wrapper rather
  than the TUI process. Running asynchronous `import()` in Node's Inspector VM then terminated the attached process.
  Node exposes no non-spoofable Inspector provenance on the global exception, so continuing requires an explicit
  developer opt-in rather than weakening the default fatal boundary.

### Why extension system couldn't handle this

- Inspector ownership is decided before extensions load, and process-wide uncaught-exception handling belongs to the
  host's terminal-restoration boundary.

### Expected merge conflict zones

- LOW: `cli.ts` immediately before the `cli-main` spawn.
- LOW: `modes/interactive/interactive-mode.ts` uncaught-exception handler.

## Reload measurement and redundant-work removal (2026-07-26)

- `/reload` records a `reload` timing namespace with one marker per phase
  (`shutdown`, `settings`, `models`, `resources`, `runtime`, `chatRebuild`,
  `lifecycle`). With `PI_TIMING=1` the breakdown is appended to the reload
  status line; with it unset nothing is recorded.
- Settings are read once per reload instead of twice.
  `ResourceLoaderReloadOptions.settingsAlreadyReloadedFor` takes the
  `SettingsManager` the caller just reloaded, and the loader skips its own
  reload only when that is the very manager it owns AND project trust is not
  being resolved, so trust-scoped values can never go stale.
- `ModelRuntime.reloadConfig()` delegates to `refresh()` instead of repeating
  the config load and provider rebuild that `refresh()` performs immediately
  afterwards.
- Both model-scope resolutions read the snapshot the reload refresh just
  produced rather than each triggering another availability scan (3 scans -> 1).
  The snapshot is trusted only via `hasFreshAvailabilitySnapshot()`; a failed
  refresh falls back to the runtime so scan errors still surface.
- `scripts/bench-reload.mjs` measures `DefaultResourceLoader.reload()` from
  source through a subprocess probe (real jiti path), reporting cold-first and
  warm p50/p95 across fresh processes.
## Multi-session RPC mode, session-owned MCP/config-reload state, and back-compat guarantee (2026-07-23)

### What changed

- `src/modes/rpc/`: new `--multi-session` startup flag. `senpi --mode rpc --multi-session`
  constructs NO default session (no default `AgentSessionRuntime`, no default extension/watcher load).
  Mode is fixed at process start; there is no runtime transition. New modules: `session-registry.ts`,
  `session-command-router.ts`, `session-binding.ts`, `multi-session-host.ts` (each ≤250 pure LOC).
- Multi-session wire protocol per the D1 normative table (see `docs/rpc.md` → Multi-session mode, and
  the `rpc-mode.ts` header doc block for the verbatim table): `get_protocol_info` (answered in BOTH
  modes; side-effect-free; THE capability probe), `open_session` / `close_session` / `list_sessions`,
  mandatory `sessionId` routing on session-scoped commands, `sessionId` tagging on all session-owned
  output, stable error codes (`unknown_session`, `session_closing`, `session_path_in_use`,
  `missing_session_id`, `multi_session_disabled`, `invalid_path`, `open_failed: <detail>`), identities
  (D6: response-level `sessionId` = opaque routing handle, ephemeral per process epoch;
  `state.sessionId` = durable JSONL identity), and the D9 ordering guarantee (strict FIFO per session,
  one total stdout order, fair round-robin between sessions' queued complete records, NO cross-session
  batch coalescing, starvation freedom NOT promised).
- `src/core/extensions/builtin/mcp/` and `src/core/extensions/builtin/config-reload/`: in multi-session
  mode each session OWNS its MCP service instance (extension factory closes over it; helpers take the
  instance, never call the `getMcpService()` global getter), its elicitation/instructions/prompts state,
  and its `reloadHandoff` keyed by the session handle. Classic single-session mode keeps the globals
  (no behavior change).
- Session-owned config-reload state: the fs-watcher reload chain
  (`config-reload/index.ts` → `agent-session.ts:3807` `resetApiProviders()`) is scoped per session via
  the pi-ai provider scope, so reloading session A cannot reset session B's providers.

### Why

- A single shared `senpi --mode rpc --multi-session` process serves all of a provider instance's
  threads concurrently. Cross-session turns run concurrently; per-session turn serialization comes
  from `AgentSession`. Session-scoped state (provider registry, MCP, config-reload) must be owned by
  the session so one conversation can never corrupt another.

### Back-compat guarantee

- Classic single-session mode (`senpi --mode rpc`, no flag) is byte-identical to today. The ONLY
  additive classic-mode behavior is that `get_protocol_info` is answered (side-effect-free). Existing
  RPC tests, the classic-compat characterization pin suite, and the neo-daemon suites stay green
  unchanged.

### Explicit non-goal

- Per-session AuthStorage / multi-tenant key isolation is NOT added inside the shared process. The
  process is single-tenant; tenancy isolation remains the neo daemon's job (per-connection worker
  model). The neo daemon's behavior and its header distrust rationale are unchanged.

### Why extension system couldn't handle this

- Session lifecycle, the multi-session host/router/registry, MCP service ownership, and config-reload
  handoff are protocol and core-runtime infrastructure below the extension boundary.

### Expected merge conflict zones on next upstream sync

- HIGH: `src/modes/rpc/` (new multi-session modules + `rpc-mode.ts`/`connection-handler.ts` seams).
- MEDIUM: `src/core/extensions/builtin/mcp/service.ts` global getter removal on the multi-session path.
- LOW: `src/core/extensions/builtin/config-reload/index.ts` reloadHandoff keying.

## App-server web-search projection and cumulative turn diffs (2026-07-21)

### What changed

- `modes/app-server/threads/`: projects only OpenAI `web_search_call` metadata into the structured Codex `webSearch`
  shape, preserves readable generic provider-native items for other subtypes, and emits subscriber-only
  `turn/diff/updated` notifications rebuilt from per-tool patches in file-change source order.
- `core/tools/` and `core/extensions/builtin/gpt-apply-patch/`: preserve source-backed unified patches for real edit,
  write, multi-file, partial-success, repeated same-path, dependent sequential, and move-only results.
- Non-empty app-server `fileChange` changes use the generated v2 tagged kind shape; moves retain the source path,
  expose the destination in `move_path`, and carry an applicable delete/add-or-update representation.
- `test/suite/` and `test/qa/app-server/`: cover final web-search payload fidelity, concurrent completion ordering, real
  mutation result shapes, per-turn reset, notification envelopes, subscriber routing, and a zero-token source-CLI run.

### Why

- Codex app-server clients render native web-search activity and live file-change previews from these item and
  notification contracts; synthesized fields and missing diffs break that client experience.

### Why extension system couldn't handle this

- Provider-native item projection, turn-scoped diff state, and subscriber notification routing are app-server protocol
  infrastructure below the extension boundary; source patches must be captured by each mutation tool before apply.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/threads/projection*.ts` implementation and its app-server QA fixtures.
- MEDIUM: write/apply_patch result details where source baselines are captured.

## Fuzzy file search one-shot and sessions (2026-07-21)

### What changed

- `modes/app-server/search/`: added bounded deterministic file traversal, subsequence scoring, same-token one-shot
  cancellation, and replaceable query sessions with latest-query update and completion notifications.
- `modes/app-server/runtime.ts` and `server/notifications.ts`: registered the stable one-shot method plus the three
  experimental session methods, routed the two stable session notifications globally, and cancelled outstanding work on
  runtime teardown.
- `test/suite/` and `test/qa/app-server/`: pinned traversal/scoring limits, cancellation and session races, request
  gates, ungated notification fanout, manifest status, and a zero-token source-CLI fixture-tree scenario.

### Why

- Codex clients use fuzzy file search for path completion and rely on cancellation tokens and long-lived sessions to
  avoid stale results while a query changes rapidly.

### Why extension system couldn't handle this

- File-search requests and global app-server notifications are transport-level JSON-RPC behavior below the extension
  boundary.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/search/` implementation and app-server registration/router allowlists.

## Wave 2 app-server parity verifier corrections (2026-07-20)

### What changed

- `modes/app-server/protocol/`: corrected fuzzy-search result keys to Codex's snake-case wire names and completed the
  handwritten thread-item/history facade so runtime modules no longer import generated protocol files directly.
- `modes/app-server/threads/`: made source-kind parsing strict, applied Codex's interactive-session default when search
  source filters are omitted or empty, rejected malformed search `u32`/boolean fields, separated user-activity recency
  from general updates, persisted unarchive timestamp bumps, rejected non-`u32` history limits, preserved every
  projected history-item variant plus completed-turn lifecycle data, read cold history without loading the thread,
  deferred compact work and `item/started` until after the RPC acknowledgement, and recorded rejected compactions as
  failed without fabricating a completed item.
- `modes/app-server/server/models.ts`: validates `remoteControl/client/list` parameters before returning the honest
  no-remote-control internal error.
- `test/qa/app-server/`: extended the Todo 8–12 drivers for the rejected edge cases and made the compaction fixture
  exercise explicit manual compaction without being preempted by automatic compaction.

### Why

- Independent parity verification found boundary-validation, persistence, timestamp, import-layer, and failure-path
  mismatches that the first wave's happy-path tests did not distinguish from Codex HEAD behavior.

### Why extension system couldn't handle this

- These contracts are JSON-RPC parsing, thread persistence/projection, and app-server lifecycle behavior below the
  extension boundary.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/` and app-server QA surfaces. Preserve Codex wire names and re-run the focused
  verifier drivers if upstream session timestamp or compaction behavior changes.

## Codex HEAD app-server catalogs, facade, and terminal envelopes (2026-07-20)

### What changed

- `modes/app-server/protocol/`: aligned method catalogs with the pinned Codex HEAD source, added complete experimental
  notification metadata, and added handwritten facade types for the catalog, config, account, collaboration-mode,
  fuzzy-search, thread-parity, terminal-error, and notification-envelope surfaces selected by the parity plan.
- `modes/app-server/server/connection.ts`, `server/notifications.ts`, `rpc/envelope.ts`, `rpc/ndjson.ts`: gate
  experimental notifications from the shared catalog and populate one `emittedAtMs` timestamp per notification before
  fanout, preserving it through final transport serialization while leaving server requests untouched.
- `modes/app-server/server/server-core.ts`: added post-response deferred actions so later thread handlers can guarantee
  response-before-notification ordering.
- `modes/app-server/threads/turns.ts`, `turn-adapter.ts`, `threads/projection.ts`: replaced the fork-only terminal
  `turn/failed` wire event with Codex HEAD's ordered `error` plus failed `turn/completed` pair, sharing one `TurnError`.
- `modes/app-server/server/models.ts`: moved model catalog runtime typing onto the handwritten facade while retaining the
  existing remote-control behavior for its dedicated follow-up task.

### Why

- Codex's generated TypeScript exporter omits experimental request roots and cannot by itself describe the live HEAD
  catalog. Senpi needs a stable, Node-compatible facade derived from both the pinned source inventory and generated
  evidence.
- Current Codex clients expect populated notification timestamps, capability-aware experimental delivery, and terminal
  failures expressed through the canonical error/completion pair.

### Why extension system couldn't handle this

- Method catalogs, transport envelopes, response-frame ordering, and terminal event projection are app-server protocol
  infrastructure that runs outside the coding-agent extension surface.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/` tree. Re-derive catalogs and facade shapes from the new Codex source before
  resolving conflicts; never hand-edit `protocol/generated/**`.

## Parallel side questions via `/btw` (2026-07-21)

### What changed

- New builtin extension `core/extensions/builtin/btw/` adds `/btw <question>`: a read-only side LLM query against a synchronously captured snapshot of the current conversation, running in parallel with any in-flight main turn without writing to session history. Details in `core/extensions/builtin/btw/changes.md`.
- TUI: the answer streams into a dismissable widget above the editor; Escape dismisses the side panel without touching main-turn Escape behavior. Non-TUI modes deliver the answer via `ctx.ui.notify`.
- `core/extensions/builtin/index.ts` registers the extension between `goal` and `mcp`.

### Why

- Asking a question about the ongoing session previously required waiting for the main turn and polluting its context. `/btw` answers immediately, in parallel, and leaves the main session untouched.

## Claude text tool-call recovery (2026-07-20)

### What changed

- `core/model-runtime.ts`: both streaming entry points conditionally wrap prepared provider streams through the side-effect-free AI recovery API, using the original selected model and non-empty tools while keeping provider retries/auth/request preparation underneath a single wrapper.
- `core/model-config.ts` and `core/provider-composer.ts`: custom definitions, built-in overrides, and extension models accept the top-level tri-state `recoverTextToolCalls` boolean without using `compat`.
- Session and agent-loop integration tests prove complete and truncated raw Anthropic/OpenAI SSE recovery, safe non-execution, persisted native history, provider-native next-turn replay, original historical XML preservation, and retry-attempt isolation.
- The isolated senpi-qa mock loop now exposes complete/truncated leak modes for both supported APIs, hashes real auth before/after, and captures cleanup/evidence receipts.

### Why

- Provider-specific middleware cannot enforce the cross-provider persistence, retry, abort, ordering, and execution boundaries required after a model leaks XML as assistant text.

- `core/agent-session.ts` and `core/retry-fallback/controller.ts`: non-retryable provider errors now advance immediately through an eligible fallback chain without replaying the failed model or waiting for backoff. Hard-failing selectors receive the normal session-local cooldown; overflows, aborted responses, refusals, and error responses containing tool calls continue to settle through their existing paths.

- `core/agent-session.ts`: typed classifier refusals now bypass same-model retries and immediately advance through a pinned fallback chain without cooldowns. Switched refusal messages are removed from active context while retained in session history; exhausted chains leave only the final refusal visible.

- `ExtensionContext.sessionSettings` now gives the model-fallback builtin the live session-owned retry settings and retry status; `/fallback` writes are immediately visible to the retry controller, while `--no-model-fallback` and `SENPI_NO_FALLBACK=1` apply a non-persistent session override.

- `core/agent-session.ts` now centralizes active-model switching, preserving manual selection behavior while supporting non-persistent, non-notifying ephemeral fallback switches.
- `core/session-manager.ts` records optional fallback model-change metadata and restores the primary model rather than a fallback-period assistant model after restart.

- `core/retry-fallback/validate.ts`: validate fallback-chain configuration with deterministic warnings.

- `core/retry-fallback/log.ts`: add a bounded, sanitized 0600 NDJSON fallback debug logger.

## Retry fallback settings (2026-07-20)

### What changed

- `core/settings-manager.ts` now persists global per-model retry fallback chains, fallback enablement, and the
  fallback revert policy. Reads provide safe defaults when those optional settings are unset or malformed.
- Project `retry` settings retain the established one-level merge behavior: a project `fallbackChains` map replaces
  the global map rather than merging individual chain keys.

### Why

- Model fallback behavior needs a durable, user-configurable chain without adding another settings file or allowing
  fallback controls to write project settings.


- `core/retry-fallback/chains.ts`: adds pure, canonical selector parsing and fallback-chain resolution.

- `core/retry-fallback/cooldown.ts`: adds per-session, lazy-expiry selector cooldowns with provider retry-after and error-derived durations.

## Accepted compaction resumes the waiting prompt (2026-07-20)

### What changed

- `agent-session.ts`: the pre-prompt fail-closed check now recognizes an assistant response retained behind the latest accepted compaction boundary as historical usage. A prompt waiting on compaction therefore dispatches with compacted history, while cancelled or would-overflow compaction remains blocked before any provider request.
- `agent-session-compaction.test.ts`: added a provider-dispatch regression for irreducibly oversized pre-prompt compaction results.

### Why extension system couldn't handle this

- `AgentSession` owns the compaction boundary, stale usage classification, prompt settlement barrier, and the provider-dispatch decision. Extensions can propose or reject summaries but cannot serialize this state transition.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent-session.ts` around `prompt()`, `_checkCompaction()`, and compaction-boundary stale-message checks.

## Model-runtime upstream model id and model-config service tier (2026-07-19)

### What changed

- `core/model-runtime.ts`: `prepareRequest()` now swaps the wire model id to the models.json/extension
  `upstreamModelId`. Previously only the compaction and websearch extensions honored it, so main-loop requests sent
  the configured alias id (e.g. `gpt-5.6-terra-fast`) verbatim and upstreams rejected the unknown model.
- `core/agent-session.ts`: `_currentServiceTier` now falls back to the model's configured `serviceTier` from the
  compatibility request config (models.json / extension model definition) when no scoped/favorite tier is set
  (`_resolveServiceTier`). The builtin service-tier extension then injects `service_tier` into OpenAI Responses
  payloads through `before_provider_request`, so client-configured priority tiers reach the wire.

### Why

- models.json `-fast` pseudo-models declare `upstreamModelId` + `serviceTier: priority` so priority-tier requests are
  client-controlled instead of proxy-side per-model overrides; the main request path must honor them.
  (`extraBody.service_tier` is not a viable channel: it is an OpenAI Responses reserved body key.)

### Why extension system couldn't handle this

- `prepareRequest()` is the core chokepoint every stream/complete call funnels through; extensions cannot rewrite the
  wire model id for the main loop, and the builtin service-tier extension only sees the session tier, which never
  reflected model-level configuration.

### Expected merge conflict zones on next upstream sync

- LOW: `model-runtime.ts` `prepareRequest()` body; `agent-session.ts` service-tier assignment sites.

## Accepted compaction resumes the waiting prompt (2026-07-20)

### What changed

- `agent-session.ts`: the pre-prompt fail-closed check now recognizes an assistant response retained behind the latest accepted compaction boundary as historical usage. A prompt waiting on compaction therefore dispatches with compacted history, while cancelled or would-overflow compaction remains blocked before any provider request.
- `agent-session-compaction.test.ts`: added a provider-dispatch regression for irreducibly oversized pre-prompt compaction results.

### Why extension system couldn't handle this

- `AgentSession` owns the compaction boundary, stale usage classification, prompt settlement barrier, and the provider-dispatch decision. Extensions can propose or reject summaries but cannot serialize this state transition.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent-session.ts` around `prompt()`, `_checkCompaction()`, and compaction-boundary stale-message checks.

## Paced streaming tool argument previews (2026-07-20)

### What changed

- `modes/interactive/tool-args-reveal.ts` paces append-only partial JSON independently per tool call, reusing the smooth
  streaming FPS and catch-up policy while batching parser work and preserving UTF-16 surrogate boundaries.
- `modes/interactive/interactive-mode.ts` flushes exact arguments before completion or execution and tears down reveal
  state anywhere pending tool components are cleared.

### Why

- Provider bursts should not make large tool-call previews jump or force a full partial-JSON parse for every timer tick.

### Why extension system couldn't handle this

- Pending tool components and their streaming/execution transition state are private to the built-in interactive mode.

### Expected merge conflict zones on next upstream sync

- MEDIUM: interactive tool-call event handling and smooth-streaming settings callbacks.
- LOW: the fork-only reveal controller.

- MEDIUM: interactive tool-call event handling and smooth-streaming settings callbacks.
- LOW: the fork-only reveal controller.

## Smooth streaming reveal (2026-07-20)

### What changed

- `modes/interactive/streaming-reveal.ts`: adds a grapheme-safe, time-based controller that reveals streamed assistant
  text at a stable perceived rate from 30–120fps, catches up bounded backlogs, and flushes immediately at tool-call and
  lifecycle boundaries.
- `core/settings-manager.ts` and the interactive settings selector persist smooth-streaming enablement and FPS.
- `modes/interactive/interactive-mode.ts` routes assistant deltas through the controller and tears it down on final,
  abort, session-switch, and shutdown paths.

### Why

- Provider chunks often arrive in bursts; rendering each burst verbatim makes otherwise fast responses visually jumpy.

### Why extension system couldn't handle this

- The controller owns private in-flight assistant component updates, TUI render scheduling, and session lifecycle state.

### Expected merge conflict zones on next upstream sync

- MEDIUM: interactive assistant event handling and settings-selector plumbing.
- LOW: the fork-only reveal controller and settings accessors.

## Incremental assistant message re-render (2026-07-19)

### What changed

- `modes/interactive/components/assistant-message.ts`: assistant content is now planned as flat render descriptors
  and reconciled against the previous child list. Unchanged children stay mounted, growing text/thinking Markdown
  updates through `Markdown.setText()`, and structural changes rebuild only the divergent suffix.
- `../test/assistant-message-incremental-render.test.ts`: exact raw-render parity covers text, thinking,
  provider-native blocks, error tails, hidden thinking, expansion, and output padding; identity assertions pin the
  incremental reuse contract.

### Why

- Streaming updates previously cleared the entire content container, so every delta recreated all Markdown children
  and discarded their instance render caches even when only the final block grew.

### Why extension system couldn't handle this

- The built-in assistant component owns transcript child identity, disposal, render caching, and OSC marker behavior;
  extensions cannot reconcile its private render tree.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `modes/interactive/components/assistant-message.ts` around content construction and streaming cache reuse.

## Neo launch handoff and daemon dispatch (2026-07-06)

### What changed

- `main.ts`: `--neo` / `--neo-isolated` (+ hidden `--neo-bin`) dispatch to the neo Go TUI launcher (`cli/neo/`),
  spawning the per-platform binary with inherited stdio, forwarded signals, and propagated exit code/signal. Dispatch
  sits after the version/export fast-paths and first-time setup, before any `AgentSessionRuntime` construction or
  extension loading, so the launcher stays thin.
- `main.ts`: `--listen <path>` dispatches to the neo daemon supervisor (see `modes/rpc/changes.md` 2026-07-06). The
  `NeoRuntimeOptions` field list is gated by a generated extraction test over `main.ts` `parsed.*` reads, so new
  runtime-relevant flags fail the test until threaded through.

### Why

- The neo TUI is a separate Go binary; senpi remains the single user-facing entrypoint and must hand off cleanly.

### Why extension system couldn't handle this

- Mode dispatch happens in `main()` before extensions load.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `main.ts` mode-dispatch ordering around startup fast-paths.

## App-server mode dispatch (2026-07-02)

### What changed

- `main.ts`: added dispatch for the fork's `senpi app-server` subcommand into `modes/app-server/` (transports,
  daemon supervision, thread lifecycle), hardened on 2026-07-03 with review fixes (entrypoint split, archive-state
  handling). Arg plumbing is in `cli/changes.md`; the mode directory itself does not exist upstream.

### Why

- Codex-compatible app-server clients need a first-class mode entrypoint next to interactive/print/rpc.

### Why extension system couldn't handle this

- Modes are dispatched from `main()` before extension loading; a wire-protocol server cannot be an extension.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `main.ts` around mode selection and subcommand routing.

## Public model resolution SDK exports (2026-07-02)

### What changed

- `index.ts`: accepted upstream exports for CLI-equivalent model and scoped-model resolution helpers.
- Documentation and examples were updated to describe extension entry renderers and the public SDK surface.

### Why

- External integrations need the same model-resolution behavior the CLI uses without duplicating internal resolver logic.

### Why extension system couldn't handle this

- Public package exports and SDK documentation are package API surfaces. Extensions can consume the exported helpers after
  load, but they cannot publish or document the root module exports themselves.

### Expected merge conflict zones on next upstream sync

- LOW: `index.ts` export list if upstream changes public SDK exports.
- LOW: docs/examples around extension entry renderer examples and model-resolution helper documentation.

## Nested legacy config migration (2026-07-01)

### What changed

- `migrations.ts`: split legacy directory and extension-system migrations into focused modules.
- `legacy-senpi-dir-migration.ts`: migrates missing files from nested legacy `~/.senpi/.pi/agent` and `~/.senpi/.pi/mom` directories into the current senpi config layout without overwriting existing files.

### Why

- Some pre-rename local configs ended up under nested `~/.senpi/.pi/agent`, so a fresh `~/.senpi/agent` could strand custom `models.json` entries such as ccapi-routed Anthropic models.

### Expected merge conflict zones on next upstream sync

- LOW: startup migration orchestration in `migrations.ts`.

## shared provider-native rendering in text output (2026-05-14)

### What changed

- `modes/provider-native-rendering.ts`: added shared provider-native formatting for Anthropic, OpenAI, and Google native web-search metadata, with a generic JSON fallback for unknown provider-native blocks.
- `modes/print-mode.ts`: text print mode now emits provider-native summaries and bodies through the shared formatter instead of silently skipping provider-native content.

### Why

- Native web-search metadata should be readable outside the interactive TUI as well, and the compact rendering rules should stay consistent between interactive and print surfaces.

### Why extension system couldn't handle this

- Print mode emits assistant content directly after the session finishes; extension tool renderers do not own provider-native assistant content.

### Expected merge conflict zones on next upstream sync

- LOW: `modes/print-mode.ts` final assistant-content emission and `modes/provider-native-rendering.ts` if upstream adds its own provider-native formatter.

## CLI export tilde expansion (2026-05-13)

### What changed

- `main.ts`: `senpi --export ~/session.jsonl ~/out.html` expands leading `~` for both the input session path and optional output path before exporting.

### Why

- The interactive `/export` bug also affected the non-interactive export path because Node's path resolution treats `~` as a literal directory name.

### Why extension system couldn't handle this

- `--export` exits before interactive mode and extension command handlers run, so CLI path normalization must happen in `main.ts`.

### Expected merge conflict zones on next upstream sync

- LOW: `main.ts` around the early `parsed.export` branch.

## Senpi self-update release source (2026-05-02)

### What changed

- `config.ts`: Bun-binary self-update fallback now points to `code-yeongyu/senpi` releases.
- `package-manager-cli.ts`: `senpi update senpi` is accepted as the branded self-update target and help text uses senpi wording.
- `package.json`: Repository metadata now points to the senpi fork.

### Why

- Self-update messaging and release metadata should direct users to senpi, not upstream pi-mono.

### Why extension system couldn't handle this

- These are core package metadata and built-in package-command parsing paths that run before extensions participate.

### Expected merge conflict zones on next upstream sync

- LOW: self-update command parsing/help and package metadata.

## Per-model transient retry fallback engine (2026-07-20)

### What changed

- `core/retry-fallback/controller.ts`: added the session-local fallback-chain controller. It canonicalizes configured selectors, suppresses transiently failing models, skips unavailable candidates with scoped logging, applies ephemeral thinking levels, and emits fallback lifecycle events.
- `core/agent-session.ts`: retryable transient failures now switch to a configured fallback without persisting the selected model, emitting a zero-delay retry and retaining the existing failed-assistant removal behavior. A fallback success event is emitted after the next successful response.

### Why extension system couldn't handle this

The retry budget, abortable retry sleep, provider continuation, and active model state all belong to `AgentSession`; an extension cannot safely replace a model inside that lifecycle without persisting it or rebuilding context.
- Retry fallback revert-to-primary at turn boundaries: unpinned fallback state under the `cooldown-expiry` policy restores the original model once its selector cooldown lapses (checked at prompt entry and between the retry sleep and continuation), emits `retry_fallback_reverted`, preserves user thinking-level overrides, and is abandoned on manual `setModel`/`cycleModel` (which also abort a pending fallback retry sleep).
- Server-side fallback aborts (2026-07-25): `retry.abortServerSideFallback` (default true) forwards `abortServerSideFallback` into provider stream options via a new `Agent` field and `createLoopConfig`. `AgentSession` translates the provider's `server_fallback_aborted` diagnostic into a session event of the same name carrying `from`/`to`/`chainConfigured`, emitted synchronously from `message_end` so it precedes refusal retry handling, and the existing refusal path then routes the turn onto the configured chain. `RetryFallbackController.hasConfiguredChain()` distinguishes "no chain configured" from "chain spent", because the no-chain refusal path emits no `retry_fallback_exhausted`. Interactive mode renders the abort and names `/fallback` when no chain exists.

## Session lifecycle stuck-route logging (2026-07-30)

### What changed

- `core/session-log.ts`: new rotating content-free JSONL logger writing `<agentDir>/logs/session.log` (5MB rotate, allow-listed scalar fields, secret redaction, `SENPI_SESSION_DEBUG=1` stderr mirror), following the existing `retry-fallback/log.ts` pattern.
- `core/agent-session.ts`: mirrors stuck-prone lifecycle transitions into `session.log`: `compaction_decision` on every terminal `compaction_end` (reason/accepted/aborted/willRetry/rejectionCause/error), `provider_error` on assistant `message_end` errors classified as stall/timeout/error, `queue_enqueue` on native steer/followUp queueing, and `prompt_rejected` when a `RequiredCompactionError` rejects prompt admission.
- Compaction lifecycle records now correlate start/terminal events with propagated UUID request IDs; classify committed/rejected/failed/skipped/aborted/superseded outcomes; record content-free before/after token estimates; preserve retry exhaustion as a skipped no-attempt action; and ignore stale ends from superseded same-reason attempts instead of attributing them to a newer compaction.
- `test/session-log-routes.test.ts` and the compaction lifecycle suites cover unmatched accepted ends, retry exhaustion, rollback snapshots, extension feedback failures, supersession, same-reason stale ends, consecutive compactions, and start/end request-ID parity without real provider calls.
- `modes/interactive/interactive-mode.ts`: logs `compaction_queue_enqueue` when input is parked during compaction, `compaction_queue_deferred` when a failed compaction defers queued input to the native queues, and `clipboard_error` on clipboard paste failures.

### Why extension system couldn't handle this

The instrumented transitions (`_emit`, queue internals, `RequiredCompactionError` admission, the TUI compaction queue, clipboard catch) are private `AgentSession`/`InteractiveMode` state with no extension-visible hook carrying the needed fields; field debugging of "stuck forever" sessions (Discord report 2026-07-30) requires a single post-hoc timeline in the logs directory.
