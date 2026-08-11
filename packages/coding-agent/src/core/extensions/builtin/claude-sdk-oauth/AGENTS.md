# claude-sdk-oauth

Claude SDK OAuth provider extension. Registers a builtin provider that runs turns through the `@anthropic-ai/claude-agent-sdk` subprocess with native multi-account OAuth, HRW session affinity, stream-safe account failover, and resume-first session continuity. Renamed from `claude-agent-sdk` on 2026-07-31; old persisted identities are intentionally not aliased.

Generated: 2026-08-07 | Commit: `4f26b8282`

## FILE ROLES (verified subset)

| File | Role |
|---|---|
| `index.ts` | Extension entry: registers the `claude-sdk-oauth` provider, `/claude-account` command, session registry wiring, OAuth config |
| `accounts.ts` | `AccountSlot` / credential types, slot block state (`blockedUntil`, `blockReason`) |
| `auth-lane.ts` | Lane selection and credential plumbing (`oauth-slots`, `config-dir`, `ambient`); `queryWithAuthLane`, token-file permissions |
| `failover.ts` | Failover events, rate-limit block windows (default 60s, max 48h), turn-retry suppression prefix |
| `affinity.ts` | HRW account affinity + expired-block clearing |
| `stream.ts` | Non-resident streaming path: builds query options, bridges SDK messages to `AssistantMessageEventStream` |
| `session-stream.ts` | Resident-lane attempts (`createResidentAttempt`), flatten serialization + directive dedupe |
| `session-continuity.ts` | `decideNativeContinuity` decision table: `delta` / `reattach` / `fork` / `flatten` / `bootstrap` |
| `session-registry.ts` | Resident SDK query registry: idle reaping, eviction, state transitions (with `session-registry-state/pump/wiring.ts`) |
| `session-binding.ts` | Branch-local binding checkpoint for restart-time resume verification |
| `session-commit-boundary.ts` | `message_end` commit boundary; divergence decided against the SDK ledger, not in-flight staging |
| `session-observability.ts` | `ContinuityObservation` (kind, reason, delta count, `payloadBytes`, `collapsedDirectives`), `session.log` events |
| `system-prompt.ts` | `systemPromptMode` handling (`full` default, `preset-append` deprecated, `override` from file); no array-splitting, the CLI joins arrays |
| `prompt-directive-dedupe.ts` | `dedupeUltraworkBlocks`: collapses repeated `<ultrawork-mode>` spans in flatten output; never mutates `context.messages` |
| `custom-tools.ts` | Senpi tools exposed as an SDK MCP server; execution denied SDK-side (`denyCustomToolExecution`), executed by senpi |
| `sdk-boundary.ts` | Single import boundary over `@anthropic-ai/claude-agent-sdk` (`query`, `createSdkMcpServer`, types) |
| `options.ts` | `buildClaudeSdkOauthQueryOptions`: settings + `SENPI_CLAUDE_SDK_OAUTH_*` env resolution, append assembly |
| `executable.ts` | Claude Code executable resolution |
| `changes.md` | Fork-change record; read before touching anything here |

## INVARIANTS (from changes.md)

- Resume-first: every query replacement re-attaches with `resume`; flatten is a last resort for a missing transcript or unusable binding. A live session is never abandoned for a flattened re-send.
- The SDK ledger is authoritative for divergence; decide at the `message_end` commit boundary. Result-only turns are a supported shape, not divergence.
- Fork point is the last assistant boundary strictly before the divergence.
- Non-fork reattach passes `resume` and must omit `sessionId` (the SDK rejects the pair). Fork adds `resumeSessionAt` + `forkSession`.
- Abort never taints and never flattens; `interrupt()` receipts gate keep-vs-close.
- Fingerprint normalizes the `Current date:` line (no midnight retirement); cwd and other regions stay fail-closed. `config-dir` lane failover is the one declared residual that still flattens.
- Every main turn emits exactly one continuity observation; TUI notices only for degradations.
- `resumeMode: "off"` / `SENPI_CLAUDE_SDK_OAUTH_RESUME=off` restores legacy per-turn behavior.
- `full`/`override` prompt modes default `settingSources` to `[]` (no CLAUDE.md double-injection). The CLI still prepends its own agent preamble; `full` means senpi's prompt arrives intact, not alone.
- Env precedence: env > project settings > global settings > default. All `SENPI_*` vars are stripped from the subprocess env on every lane.
- Subscription-limit responses classify as account-failover conditions, not terminal errors.
- Idle resident sessions retire after 30 minutes; at most 32 stay resident; in-flight sessions are never evicted.

## TESTS

Flat cluster at `test/claude-sdk-oauth-*.test.ts` (35 files at this commit): accounts, affinity, auth-lane, binding, continuity decisions, failover, custom-tools schema, guidance, login, model switch, observability, and more. Keep edited test files below the 250-pure-LOC ceiling (see 2026-07-31 rename entry).

## MERGE RISK

High across this directory (2026-08-01 continuity rework touched most session-* modules). Every behavior change must add a `changes.md` section with expected conflict zones.
