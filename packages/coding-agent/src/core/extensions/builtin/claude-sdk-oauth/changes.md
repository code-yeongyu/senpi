# claude-sdk-oauth extension changes

## 2026-08-11 - Account-aware auth availability for fallback

### What changed

`createOAuthConfig` (`oauth-login.ts`) now supplies an OAuth `check`, and `index.ts` passes a `readSettings` dep so that check can read the configured `tokenInjection` lane. `ExtensionOAuthConfig` (`provider-composer.ts`) gained an optional `check` that `adaptOAuth` forwards to the composed `OAuthAuth`. The provider still registers the `claude-sdk-oauth-managed` api-key sentinel, which keeps the ambient default configured (see below); only the stored-OAuth-credential path becomes account-aware.

### Why

The fallback engine never skipped this provider as `unauthenticated`. A stored `emptyCredential()` is `{ type: "oauth", ...SENTINEL_OAUTH_FIELDS, accounts: [] }`, and the upstream stored-OAuth branch in `ModelsImpl.checkProviderAuth` reported configured for any OAuth credential without inspecting `accounts`, so a zero-account sentinel still counted as logged in. The new `check` returns configured only when `listAccounts` finds at least one account (stored login/import or a `CLAUDE_CODE_OAUTH_TOKEN` env slot); on a managed lane (`oauth-slots`/`config-dir`) with zero accounts it returns unconfigured so the candidate is skipped. The ambient lane stays configured with zero accounts because the spawned Claude Code engine may hold its own login that senpi cannot see — that deferral is intentional (`auth-lane.ts`, `docs/providers.md`).

### Why an extension could not handle it

The stored-OAuth branch in `ModelsImpl.checkProviderAuth` is a structural short-circuit with no extension hook, and `OAuthAuth` had no `check` field (unlike `ApiKeyAuth`). `Provider.filterModels` filters the catalog in `getAvailable()` but cannot influence `configuredProviders` / `hasConfiguredAuth`, which the fallback controller reads. So the availability decision required the upstream `OAuthAuth.check` added in the companion `packages/ai` change; this extension only supplies the account-aware implementation.

### Expected merge-conflict zones

LOW in `oauth-login.ts` (added `check` to the returned shape + optional `readSettings` dep); LOW in `index.ts` (one added `readSettings` line); LOW in `provider-composer.ts` (`ExtensionOAuthConfig.check` + `adaptOAuth` forwarding, both additive).

## 2026-08-07 - Ignore volatile thinking timing in continuity hashes

- Removed `startedAt` and `endedAt` from thinking blocks before hashing the provider-final and committed assistant
  messages. Agent-core adds those display-only fields after the final `message_update`, so hashing them falsely marked
  otherwise identical turns as `assistant_rewritten` and forced full-history replay on the next turn.
- This cannot be implemented by an external extension: the comparison happens inside the builtin provider's private
  commit boundary before session-registry continuity is decided, and no extension hook can replace that digest.
- Kept thinking text, signatures, and every non-thinking block in the hash so real assistant rewrites still trigger
  continuity divergence handling.
- Added a deterministic issue #691 regression covering both the timing-only and semantic-change cases.
- Expected merge conflict zones: LOW in `session-commit-boundary.ts`; LOW in
  `test/suite/regressions/691-claude-sdk-oauth-thinking-timing.test.ts`.

## 2026-08-04 - Surface flatten payload size and collapsed directive count in continuity observations

- Extended `ContinuityObservation` (`session-observability.ts`) with optional `payloadBytes` and `collapsedDirectives` fields, surfaced only on `flatten` and `bootstrap` observations (not delta/fork/reattach).
- Threaded from `createResidentAttempt` (`session-stream.ts`): the dedupe result's `collapsedDirectives` and the serialized block byte total are passed to `observeSessionSyncDecision` when the lane flattens, so users can see the re-send cost and how many directive blocks were collapsed.
- Updated diagnostic-render and observability tests to use `expect.objectContaining` for flatten/bootstrap observations (the shape intentionally grew).
- Merge-conflict risk: low. Expected conflict zones are `session-observability.ts` (ContinuityObservation type + observeSessionSyncDecision) and `session-stream.ts` (createResidentAttempt observation call).

## 2026-08-04 - Collapse repeated ultrawork directive blocks in flatten serialization

- Added `dedupeUltraworkBlocks` (`prompt-directive-dedupe.ts`), a pure post-process over `buildPromptBlocks` output that collapses repeated `<ultrawork-mode>...</ultrawork-mode>` directive spans to the single most recent copy, replacing earlier copies with a one-line placeholder. Wired into both flatten call sites: the resident lane (`session-stream.ts` `createResidentAttempt`, the primary burner path) and the non-resident lane (`stream.ts`).
- Why: when continuity diverges (compaction, abort, model switch, restart, account failover) the lane flattens the full transcript into one prompt. The omo ultrawork hook re-injects the ~17KB directive on every trigger-matching input with only an input-scoped guard, so copies accumulated and were re-sent verbatim on every flatten — issue #494's 875KB prompt was 73% such duplicates.
- Hash safety: `dedupeUltraworkBlocks` operates only on the serialized output and never mutates `context.messages`, so continuity hashes (derived in `session-sync.ts`) are unaffected. Spans match within a single text block only; a lone open tag in one block and a close tag in another never form a span.
- Why an extension could not handle it: the dedupe must run inside the flatten serialization in `createResidentAttempt` / `stream.ts`, which no extension hook reaches.
- Merge-conflict risk: low. Expected conflict zones are the `buildPromptBlocks` call sites in `stream.ts` and `session-stream.ts` and the new `prompt-directive-dedupe.ts` import.

## 2026-08-01 - Resume-first session continuity (SDK ledger is authoritative)

- **One SDK session lineage per senpi conversation.** A new `query()` is no longer a new session: every query replacement re-attaches with `resume: <sdkSessionId>`, so normal turns, model switches, thinking-level switches, ESC aborts, idle expiry, and shared-root account failover all continue the same lineage. Flattening the transcript into a `<conversation_history>` envelope is demoted to a last resort, reachable only when the SDK transcript is genuinely unusable.
- **Why this mattered.** A full-stack probe against the previous code showed a plain 6-turn conversation already reused one session (`queries=1 lineages=1 flatten_turns=0`). The reported cache-hit decay therefore came from divergence boundaries — compaction, abort, model switch, restart, midnight fingerprint churn, failover — which a long conversation hits constantly, each one re-sending the entire history. Those boundaries are what this change removes.
- **Decision table.** `decideNativeContinuity` (session-continuity.ts) replaces the retired `decideSessionSync` and resolves every admission to `delta` | `reattach` | `fork` | `flatten` | `bootstrap`. `flatten` is reserved for a missing transcript or an unusable binding; a live session is never abandoned for a flattened re-send. The fork point is the last assistant boundary STRICTLY BEFORE the divergence, because forking at the diverged turn would carry the stale assistant into the new branch and leave nothing to re-send.
- **SDK ledger authority.** Assistant-provenance staging is deleted. Divergence is decided at a `message_end` commit boundary (session-commit-boundary.ts) comparing what the provider streamed against what the ledger committed. The previous in-flight staging reported false divergence on result-only turns — a supported SDK response shape — which tainted the session and cold-seeded the next turn.
- **Option intake.** Non-fork reattach passes `resume` and MUST omit `sessionId`; the SDK rejects that pair (sdk.d.ts:1805-1808) and would otherwise start an unrelated session. Fork adds `resumeSessionAt` + `forkSession`.
- **Abort.** `interrupt()` receipts gate the outcome: `still_queued: []` keeps the live session; a legacy or uncertain receipt closes the query but keeps the binding for reattach. Abort never taints and never flattens. Teardown during resume-initialization is synchronous, so an aborted initialization is torn down before the next assertion point.
- **Fingerprint.** The generated `Current date:` line is normalized before hashing, so a UTC midnight rollover no longer retires a live conversation; cwd and every other prompt region stay fail-closed. Host tool policy is fingerprinted by an explicit `HOST_TOOL_POLICY_FINGERPRINT` version instead of callback source text, and the executable path plus `includePartialMessages` now participate.
- **Account failover.** Shared-root lanes (`oauth-slots`, `ambient`) reattach, or fork at the last verified boundary when cross-account resume is denied. The `config-dir` lane keeps per-account credentials inside its own `CLAUDE_CONFIG_DIR` and no official SDK API moves a transcript across roots, so its failover is the one declared residual that still flattens.
- **Restart.** A branch-local binding checkpoint records `{sdkSessionId, sentCount, sentPrefixHash, lastAssistantUuid, accountName, claudeConfigDir, modelId}`; on the first turn after a restart it is verified against the SDK transcript before resuming, forks at the boundary when the local prefix advanced, and flattens only when the transcript or boundary is gone.
- **Observability.** Every main turn emits exactly one continuity observation (kind + sanitized reason + delta count) as an assistant diagnostic and a structured `claude_sdk_oauth_session_continuity` `session.log` event (paired with `claude_sdk_oauth_session_close`); the TUI shows a muted notice only for degradations. `closeSession` no longer discards its reason — the retained cause is attributed to the next admission.
- **Escape hatch.** `resumeMode: "off"` (or `SENPI_CLAUDE_SDK_OAUTH_RESUME=off`) still restores the legacy per-turn behaviour and reports `disabled` observations.
- Merge-conflict risk: high across this directory. New modules: session-continuity.ts, session-reattach.ts, session-binding.ts, session-commit-boundary.ts, session-observability.ts, session-reaper.ts, session-entry-annotations.ts.

## 2026-08-01 - Subscription-limit failover classification

### What changed

- Claude subscription-limit responses are classified as account-failover conditions rather than terminal provider errors.

### Why

- Multi-account OAuth sessions should move to an available account when one subscription lane is exhausted.

### Why this cannot be expressed externally

- Classification feeds the built-in auth lane, account affinity, and stream-safe retry state.

### Expected merge conflict zones

- `auth-lane.ts`, provider error classification, and account failover tests.

## 2026-07-31 - Native system prompt, session reuse, env overrides, and transcript hardening

- **System prompt modes (new default: `full`).** Added a `systemPromptMode` setting with three values. `full` (new default) sends senpi's own composed system prompt verbatim — previously the lane rebuilt a prompt from the SDK `claude_code` preset plus three extracted regions, so any region without a dedicated extractor was silently dropped (a persistent response-language instruction never reached the model). `preset-append` is the previous behaviour, now DEPRECATED and kept for one release; selecting it emits a one-time warning. `override` loads the system prompt verbatim from a file (`systemPromptFile`). The legacy `appendSystemPrompt` key still works and maps onto the modes: `false` → `preset-append`, `true`/unset → `full`. Setting both `appendSystemPrompt` and `systemPromptMode` makes `systemPromptMode` win and emits a warning.
- `full` and `override` default `settingSources` to `[]` on every lane, because senpi's prompt already carries project context and loading the SDK's own CLAUDE.md would double-inject it.
- Honest limitation: the CLI always prepends its own `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` block, which senpi cannot suppress. `full` means senpi's prompt is delivered intact, not that it is the only text in the system prompt.
- **No prompt-cache benefit from array splitting.** An earlier draft split the prompt into a `string[]` around a `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` sentinel to keep the stable prefix cacheable. A wire-level probe against the installed CLI (`cc_version=2.1.220.04c`) proved the CLI joins all array elements into a single system block and never honours the sentinel, so the marker reached the model as literal text. The marker has been removed. Per-element cache scoping is not supported by the current CLI.
- **Environment overrides.** Six variables, precedence `env > project settings > global settings > default`. No new CLI flags: `SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_MODE`, `SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_FILE`, `SENPI_CLAUDE_SDK_OAUTH_RESUME`, `SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION`, `SENPI_CLAUDE_SDK_OAUTH_SETTING_SOURCES`, `SENPI_CLAUDE_SDK_OAUTH_PINNED_ACCOUNT`. Every `SENPI_*` variable is now stripped from the Claude Code subprocess environment on all three lanes (oauth-slots, config-dir, ambient); other inherited variables are preserved.
- **Session reuse.** One long-lived SDK query per senpi session instead of a fresh one per turn, so a conversation continues instead of cold-starting each turn and only the new delta is sent. Always fails closed to a fresh session when the conversation diverges: compaction, branch/fork navigation, account failover, an aborted turn, or a configuration change. Idle sessions are retired after 30 minutes and at most 32 sessions stay resident; a session with a turn in flight is never evicted. After a senpi process restart the lane always starts a fresh SDK session rather than trying to re-attach. `resumeMode` accepts `"auto"` (default) and `"off"`; set `resumeMode: "off"` (or `SENPI_CLAUDE_SDK_OAUTH_RESUME=off`) to restore the old per-turn behaviour. Any other value is silently ignored (falls back to `"auto"`).
- **Fallback transcript hardening.** When a full re-send is unavoidable, the flattened history is wrapped in a `<conversation_history>` envelope with an explicit anchor instruction and the real user message placed last and unlabelled. Previously the flat `USER:`/`ASSISTANT:` transcript read as a continuable document and baited the model into fabricating its own turns.
- Merge-conflict risk: low. The only overlap surface is the settings/env-resolution block in `buildClaudeSdkOauthQueryOptions`, which the concurrent `stream.ts` / `auth-lane.ts` work also touches.

## 2026-07-31 - Rename the internal provider identity

- Renamed the builtin path, provider/model ID, storage sentinels, account directory, settings key, TypeScript symbols, commands, tests, and QA scenarios from `claude-agent-sdk` to `claude-sdk-oauth`.
- Kept the external dependency and executable packages named `@anthropic-ai/claude-agent-sdk`; only Senpi-owned identity changed.
- Split stream coverage into prompt-bridge and stream-event suites so every edited test file remains below the 250-pure-LOC ceiling.
- Existing persisted entries under the old provider/settings/account-directory names are intentionally not aliased; backward compatibility was not requested for this explicit identity replacement.
- Merge-conflict risk: high across this directory and its provider-focused tests; PRs touching the old path must be integrated before merge.

## 2026-07-30 - Forward the bounded project rules region into the SDK append

- Added `extractProjectRulesAppend()` and wired it as the third `append` entry, after AGENTS.md and skills.
- Why: this lane never sends senpi's composed system prompt. It rebuilds one from the `claude_code` preset plus `append`, so any region without a dedicated extractor is discarded. Every project rule source (`.omo/rules`, `.claude/rules`, `.cursor/rules`, `.github/instructions`) silently failed to reach the model, while AGENTS.md kept working only because `extractAgentsAppend` re-reads it from disk.
- The region is located by the rules builtin's opaque region sentinels, not by the model-facing `<project_rules>` tags: prompt content this lane does not own (context files before the block, extensions appending after it) may legitimately contain those tags and would otherwise be extracted as project rules. Rule content quoting either the sentinels or the tags is neutralized producer-side.
- The sentinels are a reserved wire literal, but nothing neutralizes them in content the rules builtin does not produce, so every sentinel candidate is structurally validated (it must open with the `<project_rules>` tag followed by the `## Project Instructions` heading and close with the tag) and rejected candidates are skipped. Without that, an `AGENTS.md` carrying a sentinel would either shadow the real block or cross-match its end sentinel and hand the model unrelated text as project rules. Replicating a complete, well-formed frame is out of scope — that is a trusted-extension boundary, not a parsing one.
- Extraction is fail-closed: a region missing its end sentinel is skipped rather than read to end-of-string, so sections appended by extensions registered after `rules` (`mcp`) are never relabelled as project rules. The forwarded append carries the `<project_rules>` envelope; the sentinels themselves are stripped.
- Why an extension could not handle it: the `append` list is assembled inside `buildClaudeSdkOauthQueryOptions`, which no extension hook can reach.
- Scope note: the other `before_agent_start` system-prompt mutations dropped by this lane (`hooks`, `compaction`, `mcp`, `terminal`, `todotools`, web search) and the project `CLAUDE.md` / parent context files are unchanged here and remain open.
- Merge-conflict risk: low. Expected conflict zones are the `append` array literal in `buildClaudeSdkOauthQueryOptions` and the extractor cluster next to `extractSkillsAppend`.

## 2026-07-30 - Terminal pre-execution denial for host-captured tools (#494)

- Added an SDK `PreToolUse` hook for the six native Claude Code tools and `mcp__custom-tools__*`.
- The hook denies before Claude Code permission handling or safe-command execution and terminates SDK processing via top-level `continue: false` alongside its terminal do-not-retry instruction.
- Senpi still captures the streamed tool call and executes it through its own validation, hook, and permission pipeline.
- Merge-conflict risk: low. Expected conflict zones are the query options and tool denial constants.

## 2026-07-27 - Initial builtin provider

- New builtin extension: Claude SDK OAuth provider with native multi-account OAuth, HRW session
  affinity, mandatory stream-safe failover, `/claude-account` + `--claude-account`, RPC/app-server
  account events, and auth guidance. See `packages/coding-agent/docs/providers.md` (Claude SDK OAuth)
  and `.omo/plans/claude-sdk-oauth-provider.md`.
