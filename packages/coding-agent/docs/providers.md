# Providers

Senpi supports subscription-based providers via OAuth and API key providers via environment variables or auth file. Built-in catalogs ship with senpi; configured providers may refresh newer catalogs and cache them in `~/.senpi/agent/models-store.json` for offline use.

## Table of Contents

- [Subscriptions](#subscriptions)
- [API Keys](#api-keys)
- [Auth File](#auth-file)
- [Cloud Providers](#cloud-providers)
- [Ollama Cloud](#ollama-cloud)
- [llama.cpp](#llamacpp)
- [Custom Providers](#custom-providers)
- [Resolution Order](#resolution-order)

## Subscriptions

Use `/login` in interactive mode, then select a provider:

- ChatGPT Plus/Pro (Codex)
- Claude Pro/Max
- GitHub Copilot
- xAI (Grok/X subscription)
- OpenRouter (OAuth-minted API key billed from OpenRouter credits)
- Radius
- Cursor (Pro/Ultra/Teams) — authentication only for now, see below

Use `/logout` to clear credentials. Tokens are stored in `~/.senpi/agent/auth.json` and auto-refresh when expired. OpenRouter instead mints a user-controlled API key that does not expire automatically.

### OpenAI Codex

- Requires ChatGPT Plus or Pro subscription
- Officially endorsed by OpenAI: [Codex for OSS](https://developers.openai.com/community/codex-for-oss)

### Claude Pro/Max

Anthropic subscription auth is active for Claude Pro/Max accounts. Third-party harness usage draws from [extra usage](https://claude.ai/settings/usage) and is billed per token, not against Claude plan limits.

### Claude SDK OAuth

The `claude-sdk-oauth` provider routes LLM calls through the official [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) - it spawns the real Claude Code engine - while senpi executes every tool itself. Subscription usage flows through Anthropic's official Claude Code surface.

- Run `/login claude-sdk-oauth` to sign in with your Claude Pro/Max subscription (PKCE, same OAuth client as the Claude Code CLI). An existing Anthropic OAuth credential is offered as an import.
- Multiple accounts: each `/login claude-sdk-oauth` adds another named account. `CLAUDE_CODE_OAUTH_TOKEN` (and `_2`..`_N`) are honored as read-only env accounts. `/claude-account` lists, adds, removes, and pins accounts; `--claude-account <name>` pins one for the session; `claudeSdkOauthProvider.pinnedAccount` pins one in settings.
- Session affinity: one senpi session sticks to one account (rendezvous hashing), which keeps Anthropic's prompt cache warm - accounts never rotate mid-session except on automatic failover. Rate limits and auth errors block the account (with cooldown) and retry on the next account, before any visible output; once output has started, the error surfaces instead of replaying.
- Default lane: **ambient** - with no `tokenInjection` setting the provider inherits the environment like the upstream extension (Claude Code CLI login or `ANTHROPIC_API_KEY`). Managed lanes (`oauth-slots`, `config-dir`) are opt-in via one settings line until the live subscription spike proves a managed default.
- Ambient lane is explicit opt-in: a Claude Code CLI login on the host is not consent to spend that subscription, so the ambient lane is gated by `claudeSdkOauthProvider.enabled` (default `false`, env override `SENPI_CLAUDE_SDK_OAUTH_ENABLED`). Before this gate existed, a logged-in Claude Code CLI made the provider available with no senpi-side action. An explicit senpi-side login is itself an opt-in: stored OAuth accounts in `auth.json` and `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN_<n>` env accounts keep the provider available with the flag unset. Only the host-CLI-derived ambient lane requires the flag.
- Settings (`claudeSdkOauthProvider`):
  - `systemPromptMode` — controls how the system prompt is delivered. **`full`** (default) sends senpi's composed system prompt verbatim; the lane no longer rebuilds from the SDK `claude_code` preset, so all prompt regions (project rules, response-language instructions, etc.) reach the model. **`preset-append`** is the previous behaviour (deprecated, kept for one release; emits a one-time warning). **`override`** loads the system prompt from a file (`systemPromptFile`). The legacy `appendSystemPrompt` key still works: `false` → `preset-append`, `true`/unset → `full`; setting both keys makes `systemPromptMode` win and warns.
  - In `full` and `override` modes, `settingSources` defaults to `[]` on every lane because senpi's prompt already carries project context — loading the SDK's own CLAUDE.md would double-inject it. The CLI always prepends its own `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` block, which senpi cannot suppress; `full` means the prompt is delivered intact, not that it is the only system-prompt text.
  - `settingSources` (filesystem settings load only in the ambient lane, so they cannot override your selected account), `strictMcpConfig`, `pinnedAccount`, `tokenInjection` (`oauth-slots` | `config-dir` | `ambient`), `resumeMode` (`auto` default | `off` restores per-turn sessions), `systemPromptFile`, `enabled` (default `false`; gates the ambient lane only).
- **Environment overrides** (precedence: `env > project settings > global settings > default`; no new CLI flags):

  | Variable | Purpose |
  |----------|---------|
  | `SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_MODE` | `full` \| `preset-append` \| `override` |
  | `SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_FILE` | Path to the system prompt file (used with `override` mode) |
  | `SENPI_CLAUDE_SDK_OAUTH_RESUME` | `auto` (default) \| `off` — disables session reuse, restoring per-turn SDK queries |
  | `SENPI_CLAUDE_SDK_OAUTH_ENABLED` | Overrides `enabled`; gates the ambient (host-CLI-derived) lane |
  | `SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION` | `oauth-slots` \| `config-dir` \| `ambient` |
  | `SENPI_CLAUDE_SDK_OAUTH_SETTING_SOURCES` | Overrides `settingSources` |
  | `SENPI_CLAUDE_SDK_OAUTH_PINNED_ACCOUNT` | Overrides `pinnedAccount` |

  Every `SENPI_*` variable is stripped from the Claude Code subprocess environment on all three lanes; other inherited variables are preserved.
- **Native compaction.** This lane pins the SDK's session-scoped `autoCompactEnabled: true`, overriding the user's global Claude Code preference because native compaction is part of the lane contract. It does not set `autoCompactWindow`. With `resumeMode: "auto"`, the resident Claude Code session owns compaction; `resumeMode: "off"` restores per-turn sessions and returns compaction ownership to senpi.
- **Session reuse.** By default one long-lived SDK query spans the entire senpi session instead of a fresh one per turn, so conversations continue with only the new delta sent. An accepted senpi compaction rewrites the transcript and forks to a fresh resident session; a rejected compaction leaves continuity unchanged. Reuse also fails closed on branch/fork navigation, account failover, an aborted turn, or any configuration change. Idle sessions retire after 30 minutes (max 32 resident); a session with an in-flight turn is never evicted. After a senpi process restart the lane always starts fresh. Set `resumeMode: "off"` (or `SENPI_CLAUDE_SDK_OAUTH_RESUME=off`) to restore the old per-turn behaviour. Accepted values are `"auto"` (default) and `"off"`; any other value is silently ignored.
- Account state is exposed to desktop/automation clients: RPC `get_provider_accounts`, `account_pin`, `account_remove` and the `auth_accounts_changed` / `account_failover` events, mirrored through the app-server protocol. Token material is never included.

#### Session continuity self-check

Every main turn records one continuity decision. Healthy turns are silent in the transcript; degraded turns print a muted one-line notice. To watch the decisions directly, tail the session log and filter on the event prefix:

```bash
# Global agent dir (default):
tail -f "${SENPI_CODING_AGENT_DIR:-$HOME/.senpi/agent}/logs/session.log" | rg claude_sdk_oauth_session_
# Project-local agent dir (when the session uses one — getAgentDir prefers it):
# tail -f .senpi/agent/logs/session.log | rg claude_sdk_oauth_session_
```

Each line is JSON with `kind` (`bootstrap`, `delta`, `reattach`, `fork`, `flatten`, `disabled`), a sanitized `reason`, and `count` (messages submitted this turn). A healthy conversation shows one `bootstrap` followed by `delta` lines; repeated `flatten` lines mean the lane is resending the whole conversation and losing prompt-cache hits. `SENPI_SESSION_DEBUG=1` mirrors the same lines to stderr.

To confirm from the SDK side, list the transcript files Claude Code keeps per project - one long-lived session should keep appending to a single file rather than creating one per turn:

```bash
ls -lt ~/.claude/projects/*/ | head
```

### Diagnosing Claude OAuth token consumption

If your Claude Pro/Max subscription usage through `claude-sdk-oauth` feels unexpectedly high, check these in order:

1. **Upgrade to v2026.8.3 or later.** Resume-first session continuity (#634-637) landed on 2026-08-03. On older builds, every turn after a divergence (compaction, abort, model switch, restart, failover) re-sends the entire conversation, which is the dominant token-burn mechanism.
2. **Check which lane you are on.** The `ambient` lane (default) inherits the environment. `oauth-slots` and `config-dir` are managed lanes set via `SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION`. The `config-dir` lane keeps each account's credentials in its own `CLAUDE_CONFIG_DIR`; no official SDK API moves a transcript across roots, so account failover on that lane always flattens (re-sends the full history) — this is a declared residual, not a bug.
3. **Read the continuity observations.** Tail the session log and filter for `flatten` — each `flatten` line means the lane re-sent the whole conversation and lost prompt-cache hits. A healthy conversation shows one `bootstrap` followed by `delta` lines. Common flatten reasons: `transcript_missing`, `registry_miss`, `resume_initialization_failed`, `cross_root_unsupported` (config-dir only).
4. **Prompt-cache retention.** Effective cache TTL depends on which lane you are on:

   | Lane | Effective TTL | Who controls it | How to override |
   | --- | --- | --- | --- |
   | Claude SDK OAuth (subscription, `claude-sdk-oauth`) | 5 minutes | The Claude SDK owns `cache_control`; senpi cannot add breakpoints. senpi reports 300s for this lane so cache-aware budgets (tool waits, goal timing) size themselves correctly. | Not overridable |
   | Direct Anthropic API (`api.anthropic.com`, API key or OAuth token) | 5 minutes | senpi follows Anthropic's default cache retention. Opting into 1h retention makes cache writes cost 2x base input vs 1.25x for 5m ([Anthropic prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)). | Set `PI_CACHE_RETENTION=long` or `cacheRetention: "long"` |
   | Anthropic-compatible providers (kimi-coding, fireworks, gateways) | 5 minutes | The 1h TTL is gated on the native `api.anthropic.com` base URL, so these lanes stay short. | `cacheRetention` |

   Override precedence: `cacheRetention` in `models.json` / the model catalog wins over everything. `PI_CACHE_RETENTION=long` selects long; any other set value forces short; unset falls back to the lane default above.
5. **Goal-monitor timing.** The goal monitor's continuation backstop is derived from the model's cache-safe wait (TTL minus `promptCache.safetyBufferSeconds`, default 30), capped by `promptCache.goalBackstopMaxSeconds` (default 3570), instead of a fixed 4 minutes. The default 5m lanes wake every ~4m30s; a supported lane explicitly configured for 1h retention can wait up to 59m30s. Cache-warm notices show which warm iteration you are on.
6. **Wake sources that hold the goal backstop.** Anything that can wake a parked session publishes a `wake_source_state` event (`{source, activeCount}`): terminal monitors (`terminal-monitors`), background bash sessions including auto-detached and killed ones (`terminal-background-sessions`), detached `eval` cells (`senpi-codemode`), and omo-senpi background task children plus owned team members (`senpi-task`). The goal extension sums every source, so a goal waits inside the prompt-cache TTL while ANY of them is on duty instead of continuing immediately. The legacy `terminal_monitor_state` event is still emitted for external consumers and is folded onto the same `terminal-monitors` count.
7. **Directive-block deduplication.** As of v2026.8.4, the flatten serialization collapses repeated `<ultrawork-mode>` directive blocks to a single copy, preventing the issue-#494 scenario where duplicated ~17KB directive blocks consumed up to 73% of the re-sent prompt. The continuity observation reports how many were collapsed and the payload size.

### GitHub Copilot

- Press Enter for github.com, or enter your GitHub Enterprise Server domain
- If you get "model not supported", enable it in VS Code: Copilot Chat → model selector → select model → "Enable"

### xAI (Grok/X subscription)

- Run `/login xai`, then select **Use a subscription**
- `XAI_API_KEY` remains available through **Use an API key**

### OpenRouter

- Run `/login openrouter`, then select **Sign in with OpenRouter** to open the OpenRouter PKCE authorization flow
- The authorization creates a user-controlled OpenRouter API key billed from your OpenRouter credits
- On remote/headless machines (e.g. over SSH) the browser cannot reach the loopback callback; paste the final redirect URL (or the authorization code) into the login prompt instead
- `OPENROUTER_API_KEY` remains available through **Use an API key**

#### OpenRouter prompt caching and sticky routing

senpi pins every OpenRouter request to the same upstream from the first call by sending the session id both as the `x-session-id` header and as the request-body `session_id` field. OpenRouter's precedence is body > header > `prompt_cache_key`, with a 256-character limit on the value; specifying a manual `provider.order` disables sticky routing entirely ([OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)).

Upstreams that require explicit cache breakpoints get `cache_control` blocks through OpenRouter: model ids starting with `anthropic/`, `qwen/`, or `google/` (catalog ids carrying one leading `~` are matched after stripping it). Other upstreams (OpenAI, DeepSeek, Moonshot, Groq, Z.AI, Grok) cache automatically and need no markers.

#### Moonshot / Kimi prompt caching

senpi sends `prompt_cache_key` (set to the session id) on Moonshot requests. Kimi documents the field as required for the Kimi Code Plan and recommended for any multi-turn agent ([Kimi context caching](https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api)). Kimi reports cache hits as a flat `usage.cached_tokens` field, which senpi parses as cache-read tokens.

### Radius

Radius is a dynamic `pi-messages` gateway. `/login radius` stores OAuth tokens in `auth.json`; the gateway catalog is refreshed independently and cached in `models-store.json`. Custom Radius gateways can be declared in `models.json` with `"oauth": "radius"` and a gateway `baseUrl`.

### Cursor

- Run `/login cursor`, then approve the request in the browser (`cursor.com/loginDeepControl` deep link; the CLI polls until the browser approval releases the tokens)
- Tokens are stored in `auth.json` and auto-refresh via `api2.cursor.sh/auth/exchange_user_api_key`, keeping the previous refresh token when Cursor does not rotate it
- The model catalog is per account: after login it is discovered automatically through `GetUsableModels` (max-mode 1M-context variants included) and refreshed with `senpi update --models`
- Chat runs over Cursor's native agent protocol (HTTP/2 Connect, `agent.v1.AgentService/Run`). Tool calling is fully supported: Cursor's server drives tools over an in-band exec channel, and senpi bridges those calls onto its real tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, plus MCP/extension tools), so approvals, sandboxing, and output truncation behave exactly like model-issued calls
- Not supported (answered with typed refusals the model can route around): computer use, subagents, Cursor-managed background shells, canvas, smart-mode approval classification, and conversation search

### Cursor CLI (fallback lane)

Use the native `cursor` provider above by default - it is the first-party, primary path.

`cursor-cli-oauth` is an opt-in fallback (never a replacement) that drives the locally installed `cursor-agent` CLI instead of Cursor's network protocol. It becomes usable when `cursor-agent` is installed, Senpi has a native `cursor` OAuth credential, and the lane has been explicitly enabled. Fall back to this lane when:

- the native transport misbehaves on your setup - protocol drift after a Cursor update, Connect-RPC/HTTP2 failures the native provider cannot route around, or
- you explicitly want Cursor's own agent harness - the model running inside the Cursor CLI with its built-in tools - rather than senpi executing the tools.

#### Native Cursor vs the CLI lane

| | Native `cursor` provider | `cursor-cli-oauth` lane |
| --- | --- | --- |
| Transport | Protobuf Connect-RPC to `api2.cursor.sh` (HTTP/2, `agent.v1.AgentService/Run`) | Local `cursor-agent -p <prompt> --output-format stream-json` subprocess |
| Auth | senpi OAuth (`/login cursor`), tokens in `auth.json` | The same senpi OAuth flow; this lane stores multiple named accounts and injects each into a per-account file-store HOME immediately before every turn |
| Tool execution | Cursor's server-driven exec channel bridges onto senpi's real tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, MCP/extension tools), so approvals, sandboxing, and truncation behave like model-issued calls | Runs INSIDE the Cursor CLI with no senpi approval, no senpi sandboxing, and no tool-level audit - a one-time acknowledgement is required before unattended execution |
| Model catalog | Per-account `GetUsableModels` discovery, refreshed with `senpi update --models` | `cursor-agent models` listing (the full suffix-expanded effort x thinking x `-fast` ladder, 204 ids on the reference build), cached with a TTL; static fallback list when the CLI is missing or the probe fails |
| Requirements | None beyond `/login cursor` | The `cursor-agent` CLI installed plus a native or managed Cursor OAuth credential; native credentials bootstrap automatically |

#### Setup

1. Install the CLI and make sure `~/.local/bin` is on `PATH` (it installs under `~/.local/share/cursor-agent` and symlinks `~/.local/bin/cursor-agent`):

```bash
curl https://cursor.com/install -fsS | bash
```

2. Sign in to native Cursor with `/login cursor`. When the CLI lane has no managed accounts, it automatically copies that stored OAuth credential into one managed `native` slot. The primary credential is preserved unchanged; repeated/concurrent startup does not create duplicates.
3. `/login cursor-cli-oauth` remains available for separate or additional managed accounts. `/cursor-account import native` remains an explicit repair/manual-copy command, while bare `/cursor-account import` (or `import local`) copies the locally logged-in Cursor desktop/CLI credential.
4. Manage accounts with `/cursor-account`:

```
/cursor-account [list | add | remove <name> | pin <name> | unpin | import [local | native] | acknowledge | status]
```

- The lane is disabled by default. A `cursor-agent` CLI being logged in on the machine is not consent to spend that subscription, so set `cursorCliOauthProvider.enabled: true` (or `SENPI_CURSOR_CLI_OAUTH_ENABLED=1`) to enable it and allow automatic native credential bootstrap. Before this gate existed, an installed and logged-in `cursor-agent` made the lane available with no senpi-side action.
- `add`, `import local`, and `import native` explicitly persist enabled state and refresh model availability.
- `import local` copies the locally logged-in Cursor desktop credential into a new slot: the source is read once, on this explicit request only, and copied - never referenced live.
- `import native` copies the primary Senpi `cursor` provider's OAuth credential into a separate managed slot without moving, deleting, or refreshing the primary entry.
- `pin <name>` (or the `cursorCliOauthProvider.pinnedAccount` setting) fixes one account for the session.
- `status` reports the lane, the active account, and the context owner of a resumed CLI chat.

**Multi-account behavior.** Each account gets its own durable credential home under `<agent dir>/cursor-cli-oauth/accounts/<name>/home` (directory mode 0700, `.cursor/auth.json` mode 0600, file credential store), which also holds that account's CLI chat history and is never deleted between turns. One senpi session sticks to one account (rendezvous hashing), and a rate-limited or auth-failing account is blocked with a cooldown while the turn fails over to the next account before any visible output; once output has started, the error surfaces instead of replaying.

**Model switching on resume.** Each turn resumes the same CLI chat id (`--resume`). Switching the model mid-session keeps that chat, and the first post-switch turn carries a short recap block built from senpi's own recent exchanges so the new model re-orients (`contextRecapOnModelSwitch`, default on). A CLI-side context overflow restarts a fresh chat with the same recap instead of wedging the session.

**No-approval acknowledgement.** This lane is the one case where a senpi provider runs tools senpi cannot gate: with force execution, the Cursor CLI executes its own tools autonomously - there is no senpi approval, no senpi sandboxing, and no tool-level audit for what it runs. The first force execution therefore refuses with the exact acknowledgement step: `/cursor-account acknowledge` (or set `cursorCliOauthProvider.noApprovalAcknowledgedAt` to the current ISO-8601 timestamp in senpi settings, once). With force execution disabled instead, the lane still answers but the Cursor CLI auto-rejects every tool call (one warning per session).

**Plan alternative.** `cursorCliOauthProvider.executionMode: "plan"` sends `--mode plan`: the CLI only plans and never executes tools, so no acknowledgement is required - a way to use the lane before deciding to trust force execution. `cursorCliOauthProvider.denyCommands` additionally refuses exact full commands inside the per-account HOME's `cli-config.json` (globs are not supported).

## Ollama Cloud

Set `OLLAMA_API_KEY` or store an API key under the `ollama` auth key, then refresh the dynamic catalog:

```bash
export OLLAMA_API_KEY=...
senpi update --models
senpi --provider ollama --model qwen3.5:397b
```

Senpi lists tool-capable models from `https://ollama.com/api/tags`, enriches their context, thinking, and
vision capabilities through `/api/show`, and caches the result in `models-store.json` for offline startup.
The provider streams through Ollama's OpenAI-compatible `/v1/chat/completions` endpoint.

Existing local Ollama configurations remain supported. When an `ollama` provider in `models.json` includes
an explicit `models` catalog, that catalog takes precedence and Senpi does not run Ollama Cloud discovery.

## API Keys

### Environment Variables or Auth File

Use `/login` in interactive mode and select a provider to store an API key in `auth.json`, or set credentials via environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
senpi
```

| Provider | Environment Variable | `auth.json` key |
|----------|----------------------|------------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| Ant Ling | `ANT_LING_API_KEY` | `ant-ling` |
| Azure OpenAI Responses | `AZURE_OPENAI_API_KEY` | `azure-openai-responses` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Ollama Cloud | `OLLAMA_API_KEY` | `ollama` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| NVIDIA NIM | `NVIDIA_API_KEY` | `nvidia` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| Amazon Bedrock | `AWS_BEARER_TOKEN_BEDROCK` | `amazon-bedrock` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| Groq | `GROQ_API_KEY` | `groq` |
| Cerebras | `CEREBRAS_API_KEY` | `cerebras` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`) | `cloudflare-ai-gateway` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`) | `cloudflare-workers-ai` |
| xAI | `XAI_API_KEY` | `xai` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `vercel-ai-gateway` |
| OpenGateway | `OPENGATEWAY_API_KEY` | `opengateway` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` | `zai` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` | `zai-coding-cn` |
| OpenCode Zen | `OPENCODE_API_KEY` | `opencode` |
| OpenCode Go | `OPENCODE_API_KEY` | `opencode-go` |
| Radius | `RADIUS_API_KEY` | `radius` |
| Hugging Face | `HF_TOKEN` | `huggingface` |
| Fireworks | `FIREWORKS_API_KEY` | `fireworks` |
| Together AI | `TOGETHER_API_KEY` | `together` |
| Baseten | `BASETEN_API_KEY` | `baseten` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |
| MiniMax | `MINIMAX_API_KEY` | `minimax` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` | `minimax-cn` |
| Qwen Token Plan (existing catalog) | `QWEN_TOKEN_PLAN_API_KEY` | `qwen-token-plan` |
| Qwen Token Plan (Individual) | `QWEN_TOKEN_PLAN_API_KEY` | `qwen-token-plan-individual` |
| Qwen Token Plan (China) | `QWEN_TOKEN_PLAN_CN_API_KEY` | `qwen-token-plan-cn` |
| Xiaomi MiMo | `XIAOMI_API_KEY` | `xiaomi` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `xiaomi-token-plan-cn` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `xiaomi-token-plan-ams` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | `xiaomi-token-plan-sgp` |
| Alibaba Token Plan (ap-southeast-1) | `ALIBABA_TOKEN_PLAN_API_KEY` | `alibaba-token-plan` |

#### OpenGateway

OpenGateway is an OpenAI-compatible multi-provider gateway serving OpenAI, Anthropic, Google, xAI, Moonshot, DeepSeek, ZAI, MiniMax, and Qwen models through one API key. Issue a key at <https://opengateway.ai/api-keys>, then `/login` and select **OpenGateway**, or export `OPENGATEWAY_API_KEY`. The data plane is `https://apis.opengateway.ai`; model ids use the gateway's `owner/model` format (for example `moonshotai/kimi-k3`, `anthropic/claude-fable-5`).

Reference for environment variables and `auth.json` keys: [`const envMap`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/env-api-keys.ts) in [`packages/ai/src/env-api-keys.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/env-api-keys.ts).

#### Auth File

Store credentials in `~/.senpi/agent/auth.json`:

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "ant-ling": { "type": "api_key", "key": "..." },
  "openai": { "type": "api_key", "key": "sk-..." },
  "deepseek": { "type": "api_key", "key": "sk-..." },
  "nvidia": { "type": "api_key", "key": "nvapi-..." },
  "google": { "type": "api_key", "key": "..." },
  "opencode": { "type": "api_key", "key": "..." },
  "opencode-go": { "type": "api_key", "key": "..." },
  "together": { "type": "api_key", "key": "..." },
  "qwen-token-plan":  { "type": "api_key", "key": "sk-sp-..." },
  "qwen-token-plan-individual": { "type": "api_key", "key": "sk-sp-..." },
  "qwen-token-plan-cn": { "type": "api_key", "key": "sk-sp-..." },
  "xiaomi": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-cn":  { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-ams": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-sgp": { "type": "api_key", "key": "..." },
  "alibaba-token-plan": { "type": "api_key", "key": "..." }
}
```

`qwen-token-plan-individual` uses the same international endpoint and `QWEN_TOKEN_PLAN_API_KEY` as
`qwen-token-plan`, but limits the picker to the models documented for Individual subscriptions. The existing
provider keeps its broader catalog for backward compatibility. When using `auth.json`, store the
credential under the provider you select; an environment variable is shared by both international providers.

The file is created with `0600` permissions (user read/write only). Auth file credentials take priority over environment variables.

API key credentials can also include provider-scoped environment values. These values are used before process environment variables when resolving the credential key, provider/model headers, and provider configuration such as Cloudflare account IDs, Azure OpenAI settings, Vertex project/location, Bedrock settings, `PI_CACHE_RETENTION`, and `HTTP_PROXY`/`HTTPS_PROXY`.

```json
{
  "cloudflare-ai-gateway": {
    "type": "api_key",
    "key": "$CLOUDFLARE_API_KEY",
    "env": {
      "CLOUDFLARE_API_KEY": "...",
      "CLOUDFLARE_ACCOUNT_ID": "account-id",
      "CLOUDFLARE_GATEWAY_ID": "gateway-id"
    }
  }
}
```

Use this when senpi should use different provider settings than the project shell environment.

### Key Resolution

The `key` field supports command execution, environment interpolation, and literals:

- **Shell command:** `"!command"` at the start executes the whole value as a command and uses stdout (cached for process lifetime)
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'anthropic'" }
  { "type": "api_key", "key": "!op read 'op://vault/item/credential'" }
  ```
- **Environment interpolation:** `"$ENV_VAR"` or `"${ENV_VAR}"` uses the value of the named variable. Interpolation works inside larger literals.
  ```json
  { "type": "api_key", "key": "$MY_ANTHROPIC_KEY" }
  { "type": "api_key", "key": "${KEY_PREFIX}_${KEY_SUFFIX}" }
  ```
  `$FOO_BAR` is the variable `FOO_BAR`; use `${FOO}_BAR` when `BAR` is literal text. Missing environment variables make the value unresolved.
- **Escapes:** `"$$"` emits a literal `"$"`; `"$!"` emits a literal `"!"` without triggering command execution.
  ```json
  { "type": "api_key", "key": "$$literal-dollar-prefix" }
  { "type": "api_key", "key": "$!literal-bang-prefix" }
  ```
- **Literal value:** Used directly. Plain uppercase strings such as `MY_API_KEY` are literals; use `$MY_API_KEY` for environment variables.
  ```json
  { "type": "api_key", "key": "sk-ant-..." }
  { "type": "api_key", "key": "public" }
  ```

OAuth credentials are also stored here after `/login` and managed automatically.

## Cloud Providers

### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.ai.azure.com
# also supported: https://your-resource.cognitiveservices.azure.com
# also supported: https://your-resource.openai.azure.com
# root endpoints are auto-normalized to /openai/v1
# or use resource name instead of base URL
export AZURE_OPENAI_RESOURCE_NAME=your-resource

# Optional
export AZURE_OPENAI_API_VERSION=2024-02-01
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-4=my-gpt4,gpt-4o=my-gpt4o
```

### Amazon Bedrock

Use `/login amazon-bedrock` to store a Bedrock API key, or configure one of the ambient AWS credential sources below:

```bash
# Option 1: AWS Profile
export AWS_PROFILE=your-profile

# Option 2: IAM Keys
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...

# Option 3: Bearer Token
export AWS_BEARER_TOKEN_BEDROCK=...

# Optional region (defaults to us-east-1)
export AWS_REGION=us-west-2
```

Also supports ECS task roles (`AWS_CONTAINER_CREDENTIALS_*`) and IRSA (`AWS_WEB_IDENTITY_TOKEN_FILE`).

```bash
senpi --provider amazon-bedrock --model us.anthropic.claude-sonnet-4-20250514-v1:0
```

Prompt caching is enabled automatically for Claude models whose ID contains a recognizable model name (base models and system-defined inference profiles). With `PI_CACHE_RETENTION=long`, the 1-hour cache TTL is only requested for Claude Opus 4.5, Sonnet 4.5, and Haiku 4.5, the models AWS documents as supporting it ([Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)); every other cacheable Bedrock Claude model uses 5 minutes on both the wire and the TTL estimate. For application inference profiles (whose ARNs don't contain the model name), set `AWS_BEDROCK_FORCE_CACHE=1` to enable cache points:

```bash
export AWS_BEDROCK_FORCE_CACHE=1
senpi --provider amazon-bedrock --model arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123
```

If you are connecting to a Bedrock API proxy, the following environment variables can be used:

```bash
# Set the URL for the Bedrock proxy (standard AWS SDK env var)
export AWS_ENDPOINT_URL_BEDROCK_RUNTIME=https://my.corp.proxy/bedrock

# Set if your proxy does not require authentication
export AWS_BEDROCK_SKIP_AUTH=1

# Set if your proxy only supports HTTP/1.1
export AWS_BEDROCK_FORCE_HTTP1=1
```

### Cloudflare AI Gateway

`CLOUDFLARE_API_KEY` can be set via `/login`. The account ID and gateway slug can be set as environment variables or in the API key credential's `env` object in `auth.json`.

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...        # create at dash.cloudflare.com → AI → AI Gateway
senpi --provider cloudflare-ai-gateway --model "claude-sonnet-4-5"
```

Routes to OpenAI, Anthropic, and Workers AI through Cloudflare AI Gateway. Workers AI uses the Unified API (`/compat`) and prefixed model IDs (`workers-ai/@cf/...`). OpenAI uses the OpenAI passthrough route (`/openai`) with native OpenAI model IDs such as `gpt-5.1`. Anthropic uses the Anthropic passthrough route (`/anthropic`) with native Anthropic model IDs such as `claude-sonnet-4-5`.

AI Gateway authentication uses `CLOUDFLARE_API_KEY` as `cf-aig-authorization`. Upstream authentication can be one of:

| Mode | Request auth | Upstream auth |
|------|--------------|---------------|
| Workers AI | Cloudflare token only | Cloudflare-native |
| Unified billing | Cloudflare token only | Cloudflare handles upstream auth and deducts credits |
| Stored BYOK | Cloudflare token only | Cloudflare injects provider keys stored in the AI Gateway dashboard |
| Inline BYOK | Cloudflare token plus upstream `Authorization` header | The request supplies the upstream provider key |

For normal senpi usage, prefer unified billing or stored BYOK. Inline BYOK requires configuring an additional upstream `Authorization` header for the Cloudflare AI Gateway provider, for example via a `models.json` provider/model override.

### Cloudflare Workers AI

`CLOUDFLARE_API_KEY` can be set via `/login`. `CLOUDFLARE_ACCOUNT_ID` can be set as an environment variable or in the API key credential's `env` object in `auth.json`.

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
senpi --provider cloudflare-workers-ai --model "@cf/moonshotai/kimi-k2.6"
```

Senpi automatically sets `x-session-affinity` for [prefix caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/) discounts.

### Google Vertex AI

Uses Application Default Credentials:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project
export GOOGLE_CLOUD_LOCATION=us-central1
```

Or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key file.

## llama.cpp

Senpi supports the llama.cpp router server. Configure it with `/login llama.cpp`, manage loaded models with `/llama`, and select a loaded model with `/model`.

See [llama.cpp](llama-cpp.md) for server setup, model directory layout, environment variables, and command usage.

## Custom Providers

**Via models.json:** Add Ollama, LM Studio, vLLM, or any provider that speaks a supported API (OpenAI Completions, OpenAI Responses, Anthropic Messages, Google Generative AI). See [models.md](models.md).

**Via extensions:** For providers that need custom API implementations or OAuth flows, create an extension. See [custom-provider.md](custom-provider.md) and [examples/extensions/custom-provider-gitlab-duo](../examples/extensions/custom-provider-gitlab-duo/).

## Resolution Order

When resolving credentials for a provider:

1. CLI `--api-key` flag
2. `auth.json` entry (API key or OAuth token)
3. Environment variable
4. Custom provider keys from `models.json`
