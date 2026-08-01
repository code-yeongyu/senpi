# claude-sdk-oauth extension changes

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
