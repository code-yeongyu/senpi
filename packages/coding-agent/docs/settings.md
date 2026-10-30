# Settings

Senpi uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.senpi/agent/settings.json` | Global (all projects) |
| `.senpi/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options. To save startup model defaults interactively, use `/model` and press Ctrl+S on the desired model. To save the startup thinking level, use `/thinking` and press Ctrl+S.

`/reasoning`, `/efforts`, and the thinking-level cycle key change the current session and its per-model memory, not the startup default. The `/settings` thinking option is an explicit default save. RPC thinking changes follow the same memory-only rule; turn-scoped changes remain ephemeral.

## state.json

Senpi keeps automatically written bookkeeping in `<agentDir>/state.json`, beside the other `*-state.json` files. It contains `tipsHistory`, `changelogSeen`, legacy `lastChangelogVersion`, `modelThinkingLevels`, `modelLastOnThinkingLevels`, and `modelServiceTiers`. Showing tips, acknowledging changelogs, and remembering per-model reasoning or fast mode no longer rewrite your global settings file.

Existing global state keys move silently on first load. Values already in `state.json` win; project settings are never migrated. Legacy settings values remain a read fallback for one release. Migration writes state first, then removes the keys from settings, so an interrupted migration can be repeated safely. JSONC comments are lost during that one-time rewrite. Downgrading to an older build can re-show tips once.

A corrupt or unreadable state file is debug-logged once and ignored without disabling your configuration. Truncated state can be replaced by the next bookkeeping save. A failed migration is retried on the next process launch, not by every manager in the current process.

During a mixed-version upgrade, an older session can re-add bookkeeping to settings. A new session preserves those keys until migration can safely copy them; old-session writes can still trigger config reloads. Restart older sessions to end that transition.

## Keeping your config in git

Commit `settings.json` (or `settings.jsonc`), `models.json`, and `mcp.json` after checking that your configuration contains no inline credentials. Ignore `auth.json`, `state.json`, `sessions/`, and caches. Credentials belong in `auth.json`, not settings or state. For a reasoning level that travels with your config, pin it in `favoriteModels`, such as `"provider/model:high"`, rather than copying per-model memory.

## Project Trust

On interactive startup, senpi asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.senpi/agent/trust.json`. Trusting a project allows senpi to load `.senpi/settings.json` and `.senpi` resources, install missing project packages, and execute project extensions.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.senpi/agent/settings.json`, or change it with `/settings`.

`senpi config` and package commands use the same project trust flow, except `senpi update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.senpi/agent/trust.json` only; the current session is not reloaded, so restart senpi for changes to take effect.

## Permissions

Senpi includes a built-in permission system for tool calls. It evaluates a preset first, then applies explicit rules from global settings, project settings, and CLI flags. The last matching rule wins.

For `external_directory`, this order applies separately to each path spelling: the absolute lexical path, the physical prefix plus unresolved components at each symlink followed, the final physical path, and their on-disk case spellings for existing components. The most restrictive result wins across spellings (`deny` > `ask` > `allow`). Thus a blanket deny followed by an allow for a shared directory still allows that directory, but an allow on a symlink's destination cannot override a deny on an intermediate path. Resolution uses metadata and link targets without opening path components; case recovery may list directories, but unavailable listings do not invalidate component identities proven by metadata. Missing path components retain their supplied case. More than 16 distinct spellings, 40 symlink hops, or a loop yields `ask`, even with a remembered approval.

"Allow always" scopes remain tied to the resolved directory and cannot override a deny. An explicit allow for only the resolved directory can still leave an unmatched alias at `ask`; a remembered "Always" approval covers that same resolved target across its aliases.

Resolution follows a kernel-style component queue. A name is inspected at the current physical directory; a symlink prepends its target components, and an absolute target resets the position to its filesystem root. `.` is skipped and `..` moves to the physical parent, after preceding symlinks have been followed. Neither the request nor a link target has dot segments collapsed before this walk. Relative targets are never joined to an unresolved lexical parent, so the walk cannot invent a route such as `a/d` when `a/L1` actually points to `b/c` and `L2` points to `../d`.

A genuine intermediate spelling can still match only a blanket deny even when specific rules allow both the original path and the final destination. For example, if `entry` links to `proj` and `proj/x/secret` links to `outside`, allowing `entry/*` and `outside/*` does not override a blanket deny on the intermediate `proj/x/secret/file.txt`. Allow that intermediate route explicitly if it should be accessible.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `permissionPreset` | string | `"full-access"` | Permission preset: `"full-access"`, `"workspace"`, `"accept-edits"`, `"auto"`, `"read-only"`, or `"ask"` |
| `permission` | object | - | Explicit permission rules that override the selected preset |

Presets:

| Preset | Behavior |
|--------|----------|
| `full-access` | Allow all permission checks without prompting |
| `workspace` | Allow `read`, `list`, `grep`, `edit`, and `bash`; ask for `external_directory` |
| `accept-edits` | Allow project `read`, `list`, `grep`, and `edit`; ask for `bash`, `external_directory`, and other tools |
| `auto` | Asks for everything except what it can prove stays inside the project, judged on the exact file the tool will open (the tool's own path resolution, symlinks followed): reads, listings and writes of project files through the file tools (`read`, `ls`, `find`, `write`, `edit`), `apply_patch` adding, changing or moving project files (a delete asks), a content search of one or more project files, and a small set of read-only shell commands (`ls cat head tail wc diff stat file cut grep rg echo pwd true which`, read-only git) with plain in-project arguments. Files count only when they land inside the project with no hidden component (except repository and formatter files such as `.gitignore`, `.github/`) and no credential-shaped name. Everything else asks: anything outside the project, `.env` and other dotfiles, `.git/`, `.vscode/`, keys, directory-wide content searches, any shell command with quotes, pipes, redirects, `cd` or a write (`cp`, `mv`, `rm`, `mkdir`), `git show`, text sent to a running process (`bash_input`), test runners, builds, installs and network tools. A session rooted at `/`, your home directory, any directory above it, or inside a hidden directory (such as `~/.config`) asks for everything. Each call is decided as the more restrictive of `auto`'s decision and your own rules' decision (deny over ask over allow), whatever order or layer (settings, CLI, RPC) your rules come from: your rules can narrow `auto`, never widen it. <br>`auto` prevents accidents; it is not a sandbox. Credential detection is by name, so a secret in a plainly named project file (for example `secrets.yml`, `terraform.tfvars`) can be read. A path the judge approved can be swapped for a symlink before the tool runs. An "Always" answer you gave (saved in `.senpi/permissions-approved.jsonl`, from this or an earlier session) still allows its pattern. |
| `read-only` | Allow `read`, `list`, and `grep`; ask for `edit`, `bash`, and `external_directory` |
| `ask` | Restore prompt-on-unknown behavior |

Example:

```json
{
  "permissionPreset": "workspace",
  "permission": {
    "bash": {
      "rm *": "deny"
    },
    "edit": {
      "secrets/*": "ask"
    }
  }
}
```

Flat rules apply to all patterns for that permission:

```json
{
  "permissionPreset": "read-only",
  "permission": {
    "bash": "deny"
  }
}
```

CLI overrides have the highest precedence:

```bash
senpi --permission-preset ask
senpi --permission-preset workspace --permission "bash:rm *=deny"
```

Permission rules are a confirmation policy, not a sandbox. Senpi, extensions, package installs, and child processes still run with the host process permissions.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Startup provider (e.g., `"anthropic"`, `"openai"`; saved with Ctrl+S in `/model`, or edited manually) |
| `defaultModel` | string | - | Startup model ID (saved with Ctrl+S in `/model`, or edited manually) |
| `recommendedModels` | string[] | `claude-opus-5-5`, `claude-fable-5-1`, `kimi-k3.1-pro`, `gpt-6-astra`, `gpt-6.1-sol`, `glm-5.3` | Preferred default model ids in priority order. Built-in thinking levels are claude-opus-5-5/`medium`, claude-fable-5-1/`xhigh`, kimi-k3.1-pro/`max`, gpt-6-astra/`xhigh`, gpt-6.1-sol/`medium`, glm-5.3/`max`. Override the list or disable auto-switch with `--no-recommended-models` / `warnings.offRecommendedModel`. |
| `defaultThinkingLevel` | string | - | Startup thinking level (saved with Ctrl+S in `/thinking`, or edited manually): `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `promptPreset` | string | `"auto"` | Force a system prompt preset: `"auto"`, `"kimi-k2-6"`, `"kimi-k2-7"`, `"kimi-k2-8"`, `"kimi-k3"`, `"kimi-k3-1"`, `"glm-5.2"`, `"glm-5.3"`, `"grok-4.5"`, `"grok-4.6"`, `"grok-4.7"`, `"claude-fable-5"`, `"claude-fable-5-1"`, `"claude-opus-5-5"`, `"claude-opus-5"`, `"claude-sonnet-5-5"`, `"claude-haiku-5-5"`, `"claude-opus-4-5"`, `"claude-opus-4-6"`, `"claude-opus-4-7"`, `"claude-opus-4-8"`, `"deepseek-v4-flash"`, `"deepseek-v4-flash-0731"`, `"deepseek-v4-1-flash"`, `"deepseek-v4-pro"`, `"gemini-4-argon"`, `"gpt-5"`, `"gpt-5.2"`, `"gpt-5.3-codex"`, `"gpt-5.4"`, `"gpt-5.5"`, `"gpt-5.6"`, or `"gpt-6-astra"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `showCacheMissNotices` | boolean | `false` | Show transcript notices for significant prompt-cache misses, compaction or branch-summary usage, and provider recovery diagnostics such as dropped Anthropic thinking blocks |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level. Anthropic, Google, and Bedrock use these natively. OpenAI-compatible models use them when `compat.thinkingTokenBudgetField` (or `supportsThinkingTokenBudget`) is set. |

#### promptPreset

Use `promptPreset` when a provider's model ID does not auto-detect to the preset you want, or when you want to force one preset for a project.

```json
{
  "promptPreset": "kimi-k2-6"
}
```

Project settings in `.senpi/settings.json` override global settings in `~/.senpi/agent/settings.json`.
When this value is anything other than `"auto"`, it overrides any model-level `promptPreset` configured in `models.json`.

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"system"` | Theme name (`"system"`, `"dark"`, `"light"`, a `light/dark` pair, or custom). `system` derives colors from the terminal's palette; see [Themes](themes.md#use-your-terminals-colors) |
| `externalEditor` | string | `$VISUAL`, then `$EDITOR`, then Notepad on Windows or `nano` elsewhere | Command for Ctrl+G external editor; takes precedence over environment variables |
| `quietStartup` | boolean \| `"header"` | `false` | `true` hides the startup header and loaded-resource listing. `"header"` keeps the header (version and key hints) but hides the model scope line and loaded-resource listing |
| `tips` | boolean | `true` | Show the rotating startup and working-status tip lines |
| `defaultProjectTrust` | string | `"ask"` | Fallback project trust behavior: `"ask"`, `"always"`, or `"never"`. Global setting only |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableInstallTelemetry` | boolean | `true` | Send the anonymous install/update ping and selected provider attribution headers. This does not control update checks |
| `enableAnalytics` | boolean | `false` | Opt-in analytics data sharing. Currently only asked for during the experimental first-time setup (`PI_EXPERIMENTAL=1`) |
| `trackingId` | string | - | Analytics tracking identifier, generated when `enableAnalytics` is turned on |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `outputPad` | number | `1` | Horizontal padding for user messages, assistant messages, and thinking (0 or 1) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |
| `tuiMode` | string | `"regular"` | Interactive TUI mode: `"regular"` or experimental `"fullscreen"`. Changes from `/settings` apply immediately; `--tui-mode` overrides this setting at startup |
| `fullscreenExitOutput` | string | `"transcript"` | Fullscreen exit output: `"transcript"` prints the final transcript and resume hint, while `"resume-hint"` restores the previous screen and prints only the resume hint. Has no effect in regular TUI mode |
| `fullscreenScrollbar` | string | `"auto"` | Fullscreen transcript scrollbar: `"auto"` shows it temporarily while scrolling or while the pointer is over its rightmost-column track, `"always"` reserves that column and keeps it visible, and `"hidden"` hides it. Has no effect in regular TUI mode |
| `fullscreenCopyOnSelect` | boolean | `true` | Automatically copy selected text in fullscreen mode. When disabled, selections stay highlighted and `Ctrl+X` copies the active selection |
| `fullscreenWheelScrollLines` | `"auto"` or number | `"auto"` | Lines per mouse-wheel event in fullscreen mode, from 1 to 100. `"auto"` moves one line per event in local macOS terminals, which already accelerate wheel and trackpad input; elsewhere, and over SSH, it speeds up fast wheel spins to at most 6 lines per event. Alt+wheel moves five times as far |

For VS Code, include `--wait` so senpi resumes after the editor exits:

```json
{
  "externalEditor": "code --wait"
}
```

### Telemetry and update checks

`enableInstallTelemetry` controls the anonymous install/update ping to `https://pi.dev/api/report-install` and senpi attribution headers for OpenRouter, NVIDIA NIM, and Cloudflare provider requests. Opting out disables both. It does not disable update checks; senpi can still fetch the latest published `@code-yeongyu/senpi` version from the npm registry (`registry.npmjs.org`).

Set `PI_SKIP_VERSION_CHECK=1` to disable the senpi version update check. Use `--offline` or `PI_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

### Network

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `httpProxy` | string | - | HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY`. Global setting only. |

```json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Context Files and Skills

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `contextFiles.maxBytesPerFile` | number | `65536` | Maximum UTF-8 bytes loaded from each AGENTS.md / CLAUDE.md, including the truncation note and any closing code fence |
| `contextFiles.maxTotalBytes` | number | `131072` | Maximum combined UTF-8 bytes of loaded context files, including truncation notes and closing code fences |

Files receive budget nearest-first: the current directory, its ancestors, then the global file. A cut prefers a newline in the last quarter of the available content budget; otherwise it uses a UTF-8 character boundary. An open backtick or tilde fence is closed with the same marker before the truncation note; the closing marker's bytes count against the budget. Files with less than 1024 bytes of budget left are skipped when they would need truncation, with a warning distinguishing an undersized per-file limit from budget used by nearer files. Both limits accept positive numbers (rounded down); invalid values use the defaults.

The skills section has a fixed 48 KiB rendered UTF-8 byte cap, including its roots table and markup. Above 100 visible skills or 16 KiB of descriptions, the catalog lists one line per skill, `- name [location]: description`, where the location is the shortest path that still resolves against the roots table and the description is cut to at most 160 characters. A cut keeps the description's when-to-use sentence ("Use when ...", "MUST USE for ...", "Triggers: ...") and fills the remaining room with the text around it. If needed to meet the section cap, smaller catalogs also use the one-line form, then all descriptions are dropped (`- name [location]`). If names and locations still exceed the cap, only the first skills that fit are listed, with the omitted count inside the section. Skills remain available for explicit invocation.

Context cuts, skipped files, and compacted or omitted skills share the "Context size limits" resource notice in interactive mode and appear once on stderr at startup in print, JSON, and RPC modes, with the affected path when present. Ordinary skill validation warnings keep their existing diagnostic behavior and are not printed to stderr by this size check.

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |
| `compaction.summarizationMaxDurationMs` | number | adaptive | Wall-clock budget for one summarization attempt: larger of 120s and 2ms per estimated input token, capped at 30min. Set a positive value to override |
| `compaction.modelOverrides` | object | - | Per-model `reserveTokens` and `keepRecentTokens` overrides keyed by exact `"provider/modelId"` |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

#### Per-model compaction overrides

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "some-provider/big-model": {
        "reserveTokens": 400000
      },
      "local/small-model": {
        "reserveTokens": 2048,
        "keepRecentTokens": 4096
      }
    }
  }
}
```

Keys match exact, case-sensitive `provider/modelId` values, not names or glob patterns. Model IDs may contain slashes (for example, `openrouter/anthropic/claude-sonnet-4`).

Each token setting resolves independently: matching model override → ordinary `compaction` setting → built-in default. In the example, `some-provider/big-model` keeps the ordinary 20000 recent tokens. Token values must be non-negative safe integers. Invalid values in the matching model override produce an error when read; only omitted fields fall back to the ordinary setting. Model override entries must be objects. Invalid ordinary token settings produce an error when read, even if the active model has a valid override. Only omitted ordinary values use built-in defaults. Zero is accepted, but `reserveTokens: 0` leaves no response margin and also sets the summarization output budget to zero.

Global and project settings merge recursively **before** model lookup. A project can override one field for a model without replacing its other fields or other models. A global model-specific value takes precedence over a project-wide fallback; override the same model entry in the project to change it.

`enabled` is not model-specific. The active model's token settings apply to manual compaction, automatic threshold checks (including between assistant turns), and overflow recovery. Switching models takes effect on the next check or compaction. Configure overrides in JSON; `/settings` retains the ordinary auto-compaction toggle.

See [compaction.md](compaction.md) for trigger and summarization behavior.

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved when selecting branch history; output is capped at 4096 tokens |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `5` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.modelFallback` | boolean | `true` | Let eligible retry failures advance through configured per-model fallback chains |
| `retry.fallbackChains` | `Record<string, string[]>` | `{}` | Ordered exact model-selector to fallback-selector chains |
| `retry.fallbackRevertPolicy` | `"cooldown-expiry"` \| `"never"` | `"cooldown-expiry"` | Automatic primary-model restoration policy |
| `retry.abortServerSideFallback` | boolean | `true` | Abort a turn when the provider substitutes a different model after a classifier decline |
| `fallback.circuitCooldownMs` | number | `60000` | First circuit-breaker cooldown for a chain entry that failed out of its chain; doubles on each consecutive failure; `0` disables the breaker |
| `fallback.circuitMaxCooldownMs` | number | `1800000` | Ceiling for the doubled circuit-breaker cooldown (30 minutes) |
| `retry.maxAgentDelayMs` | number | `60000` | Hard ceiling on agent-level retry delay (60s), applied after the retry profile and jitter |
| `retry.provider.timeoutMs` | number | `300000` | Provider/SDK request timeout and stream idle timeout in milliseconds |
| `retry.provider.streamStartTimeoutMs` | number | `300000` | Maximum wait for the first provider stream event; `0` disables |
| `retry.provider.streamRetryTimeoutMs` | number | `30000` | First-request liveness cap after a known provider stream/transport timeout; `0` disables the cap |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay honored on the same model before the fallback chain engages (60s) |

A server-requested retry delay at or below `retry.provider.maxRetryDelayMs` is honored on the same model. A longer delay means the model is unavailable rather than busy, so Senpi engages the configured fallback chain instead of waiting, suppressing the primary for the requested duration; the turn fails with an informative error only when no chain candidate can take over.

Agent-level retries use exponential backoff shaped by the retry profile and capped by `retry.maxAgentDelayMs`, so long retry runs stay responsive after prolonged outages.

After an exact provider stream/transport timeout, `retry.provider.streamRetryTimeoutMs` caps the retry's first
provider request and defers queued user input from that request. The cap applies only to stream guards that are
already enabled, never turns a disabled guard back on, and restores configured timeouts for later requests.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Setting it above `0` can make SDK/provider retries handle out-of-usage-limit errors before senpi sees them, which may block the agent until the provider quota resets in some circumstances.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 5,
    "baseDelayMs": 2000,
    "maxAgentDelayMs": 60000,
    "provider": {
      "timeoutMs": 3600000,
      "streamStartTimeoutMs": 300000,
      "streamRetryTimeoutMs": 30000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

#### Model fallback chains

`retry.fallbackChains` maps a primary-model selector to an ordered list of fallback selectors. A selector is `provider/model` with an optional `:thinking-level` suffix, or a bare `model` id that applies to every provider serving that model family. Bare selectors expand against the models you actually have: providers holding an OAuth credential are preferred, then a fixed precedence order, and OpenRouter is never chosen by expansion. Senpi ships bare default chains for `claude-fable-5-1` and `claude-fable-5` - `claude-opus-5-5:max`, then `claude-opus-5:max` - and for `claude-opus-5-5` - `claude-opus-5:max` - so Fable 5.1, Fable 5 and Opus 5.5 keep a fallback chain whichever provider serves them, and a fallback never leaves the Anthropic family; set a key to `[]` to opt out entirely, or set one `provider/claude-fable-5-1` key to override just that provider. For example, this switches Fable 5.1 to Kimi K3 at `max` thinking when an eligible failure occurs:

```json
{
  "retry": {
    "modelFallback": true,
    "fallbackChains": {
      "anthropic/claude-fable-5-1": ["ccapi/kimi-k3:max"]
    },
    "fallbackRevertPolicy": "cooldown-expiry"
  }
}
```

A chain is only for the exact primary model it names: selector lookup first considers an exact thinking-level selector, then the same `provider/model` without its thinking suffix. Wildcard selectors, role keys such as `default`, and other catch-all chains are not supported.

A fallback entry with `:thinking-level` requests that level on the target model; a bare entry inherits the current thinking level. Either value is clamped to the target model's supported levels. An entry may name the same model as its key at another thinking level: it is a rung of its own, so the chain retries that model at the other level before it moves to the next model. An entry without a suffix names the rung already in flight, so the chain skips it. A hard failure parks only the rung that failed, so the chain still tries that model at its other levels; a failure that applies to the whole model (an auth error, a model that does not exist) therefore costs one request per listed level before the chain moves on. A transient, rate-limit or billing failure parks every level of the model at once. When an unpinned fallback later returns to the primary, it restores the original thinking level unless you changed it while using the fallback.

`/fallback` writes these settings to the global settings file. Project settings are still merged when read; because `fallbackChains` is a nested map, a project `retry.fallbackChains` replaces the global map rather than merging individual chain keys.

#### Fallback behavior and diagnostics

With `retry.enabled` and `retry.modelFallback` enabled, Senpi can switch from a transient or eligible hard provider failure to the next configured candidate. Transient failures (timeouts, overload, 429, 5xx, transport drops) first retry the same model on the existing exponential backoff; the chain engages only after `retry.maxRetries` attempts are spent, and each fallback candidate starts with a fresh retry budget. Hard failures (quota, auth, model-not-found) and classifier refusals still switch immediately. The switch continues the current turn without changing the existing conversation prefix, preserving prompt-cache inputs; fallback lifecycle events are never added to model context. Returning to a primary model happens only at a turn boundary, never while a response is streaming. Selector cooldowns are error-derived, and a provider retry-after hint always wins: quota and billing failures park a model for 30 minutes, rate limits for 30 seconds, overload for 45 seconds plus jitter, 5xx for 20 seconds, and timeout or connection/transport failures for 60 seconds; unmatched failures default to five minutes. A fully failing chain costs up to `1 + (chainLength + 1) * maxRetries` provider calls plus per-rung backoff before the turn fails; with `maxRetries: 0` every failure switches immediately, costing `1 + chainLength` calls.

Billing-class failures — Anthropic's 400 *credit balance is too low*, OpenAI's 429 `insufficient_quota`, and other credit/quota exhaustion responses — never recover by retrying the same account, so a configured chain candidate receives a **pinned** fallback switch, exactly like a refusal-pinned fallback: it never auto-reverts and later turns keep running on the replacement model instead of returning to the exhausted account after the 30-minute billing cooldown.

Anthropic streaming refusals are identified from typed `stopDetails`. A configured candidate receives an immediate **pinned** fallback switch with a user-visible fallback notice: Senpi does not retry the refusing model and a pinned fallback never auto-reverts. Set `retry.fallbackRevertPolicy` to `"cooldown-expiry"` (the default) to return an unpinned fallback to its primary after the primary's cooldown expires, or `"never"` to keep the fallback until you change models.

#### Fallback circuit breaker

When a chain entry fails with a provider-health failure, Senpi opens a circuit for that entry: a transient failure (timeout, overload, 429, 5xx, transport drop) once its retry budget is spent, or a billing, credit, quota, or budget exhaustion at once, including on the last entry of the chain. Authentication (401/403) and request-shape rejections do not open a circuit. The circuit is shared by every session in the process that uses the same agent directory - sessions started with `/new`, `/resume`, or `/fork`, and in-process subagents - so they skip the entry without sending it a request or spending its retry budget:

- A session whose current model has an open circuit moves to the next chain entry with a closed circuit at the turn boundary (shown as a `transient` model fallback). Mid-turn fallbacks skip open entries the same way.
- The cooldown starts at `fallback.circuitCooldownMs` and doubles on each consecutive failure, up to `fallback.circuitMaxCooldownMs`. A provider `Retry-After` (seconds or HTTP-date, on 429 and 503 responses) keeps the circuit open until that time when it is longer, up to `fallback.circuitMaxCooldownMs`, and a later failure without a hint never shortens it. A hint longer than that ceiling (a weekly window, or a gateway replaying a stale wait) keeps the circuit open only until the ceiling; then one half-open probe checks the entry, and a probe that is rate limited again re-opens the circuit with the fresh hint. An accepted response from the entry closes the circuit and resets the escalation.
- After the cooldown the circuit is half-open: the first request to use the entry again - a session's turn or a background 429 probe-back - holds its only probe until the probe settles, and every other request keeps skipping it, including the other request lane of the same session. While the circuit tracks an entry, its clock (monotonic, like every cooldown) decides when a fallback returns to it. The probe closes the circuit as soon as the entry streams a response; its first provider-health failure re-opens the circuit with the doubled cooldown and falls back immediately, without same-model retries. A user abort, a request-shaped error, or disposal hands the probe back. A probe that never answers is aborted as a provider failure after the stream-start guard (5 minutes when `retry.provider.streamStartTimeoutMs` is 0).
- 429 probe-back probes of a demoted primary respect the circuit: none is sent before the circuit's open time (the provider's retry-after, bounded by `fallback.circuitMaxCooldownMs`, or the cooldown) elapses, or while another session holds the probe.
- The chain never refuses a turn: if every remaining entry is open, the request still goes to the current entry (or the first open candidate) as a probe.
- Refusals and request-shaped hard errors do not open circuits. Selecting a model yourself closes its circuit.

Circuits are process-local like the rest of the fallback state and are never persisted. Set `fallback.circuitCooldownMs` to `0` to turn the breaker off:

```json
{
  "fallback": {
    "circuitCooldownMs": 60000,
    "circuitMaxCooldownMs": 1800000
  }
}
```

#### Provider-substituted models

Anthropic's server-side fallback betas can retry a classifier-declined request on a substitute model *inside the same response*, marking the handoff with a `fallback` content block; a gateway may enable this on your behalf. Honoring that response means paying for a model you did not select, and after the first handoff Anthropic routes later turns of the conversation straight to the substitute with no marker at all — reported only as a `fallback_message` entry in `usage.iterations`.

With `retry.abortServerSideFallback` enabled (the default), Senpi treats either signal as a decline: it aborts the request as soon as the signal arrives, discards the substitute's partial output, and re-enters the turn as a classifier refusal so your own `retry.fallbackChains` chooses the replacement model. The transcript shows `Server fallback <from> -> <to> aborted`, naming `/fallback` when no chain is configured for the current model.

Two caveats. Aborting minimizes but cannot eliminate cost: output already streamed before the abort is billed, and because per-attempt usage never arrives on an aborted stream, the turn carries a `billing_incomplete_after_client_abort` diagnostic instead of a precise cost. A served-model string that merely differs from the requested one never triggers an abort, because gateways and Bedrock-style endpoints legitimately rewrite model ids.

Set it to `false` to keep the substituted response instead. If a gateway in front of Senpi injects the fallback itself, disabling the injection there avoids launching the substitute at all and is cheaper than aborting it client-side.

Fallback decisions are process-local. A `senpi-task` or subagent child process reads its own settings and maintains its own in-memory suppression state; it does not affect its parent process. Disable fallback for one run without changing settings with `--no-model-fallback` or `SENPI_NO_FALLBACK=1`.

For diagnostics, Senpi writes sanitized NDJSON records for candidate skips, cooldowns, circuit opens (`circuit_opened`) and turn-boundary circuit skips (`circuit_open_skip`), switches, reverts, manual clears, and validation warnings to `<agentDir>/logs/fallback.log`. `/session` reports what failed requests cost the session: failed-request counts and share, time spent in failed requests, and retries that succeeded after a failure in the same user turn but read nothing from the prompt cache, with their uncached input tokens. Prompts under 2,048 tokens are never counted as cache misses, because providers do not cache prompts that small; the token counts come from the provider's usage report, while tying the miss to the failure is the report's reading of the turn. The file is mode `0600` and rotates at 5 MB (`fallback.log.1`).

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body idle timeout in milliseconds, also used by providers with explicit stream idle timeouts. Set to `0` to disable. |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connect/open handshake timeout in milliseconds for providers that support WebSocket transports. Set to `0` to disable. |

### OpenAI

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `openai.serviceTier` | string | - | Injects OpenAI Responses `service_tier`: `"auto"`, `"flex"`, `"priority"`, or `"ultrafast"` |

```json
{
  "openai": {
    "serviceTier": "priority"
  }
}
```

When unset, senpi leaves provider payloads unchanged. This setting currently applies only to the built-in OpenAI Responses provider path.

### Providers

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `anthropicSubscriptionProvider.enabled` | boolean | `false` | Enable the ambient (host-CLI-derived) lane of `anthropic-subscription`. Env override: `SENPI_CLAUDE_SDK_OAUTH_ENABLED`. Explicit senpi-side logins (stored OAuth accounts in `auth.json`, `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN_<n>` env accounts) keep the provider available with this unset |
| `anthropicSubscriptionProvider.accountFallback` | boolean | `true` | Allow automatic switching between managed Claude accounts. `false` surfaces failure instead of using another account, including when the selected account is already blocked. Same-account retries and refresh remain enabled. Independent of `retry.modelFallback`. Env override: `SENPI_CLAUDE_SDK_OAUTH_ACCOUNT_FALLBACK` |
| `cursorCliOauthProvider.enabled` | boolean | `false` | Enable the `cursor-cli-oauth` fallback lane and automatic native credential bootstrap. Env override: `SENPI_CURSOR_CLI_OAUTH_ENABLED` |
| `providers.<id>.maxConcurrency` | number | unlimited | Cap the streaming requests senpi keeps in flight against one provider, keyed by registry provider id (`anthropic`, `openai`, ...). `0`, a negative value, a fraction, or an absent key all mean unlimited |

`providers.<id>.maxConcurrency` queues further requests to that provider in arrival order and starts each one as soon as an in-flight response finishes. The slot covers the provider request alone, never a whole agent turn, so a parent session releases it before its tools run and a spawn tree deeper than the cap cannot deadlock behind itself. Providers stay unlimited until you set a positive integer, and changing the cap takes effect immediately, including for requests already queued. A malformed value is reported as a startup warning and read as unlimited.

```json
{
  "providers": {
    "anthropic": {
      "maxConcurrency": 4
    }
  }
}
```

Both ambient-auth providers are explicit opt-in: a vendor CLI being logged in on the machine is not consent to spend that subscription. Before these gates existed, a logged-in Claude Code or `cursor-agent` CLI made the lane available with no senpi-side action, so subscription usage could flow through a provider you never configured. Env overrides follow the usual precedence (`env > project settings > global settings > default`). See [providers.md](providers.md) for the full lane documentation.

```json
{
  "anthropicSubscriptionProvider": {
    "enabled": true
  },
  "cursorCliOauthProvider": {
    "enabled": true
  }
}
```

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `terminal.mouse` | `"off"`, `"whilePending"`, `"always"` | `"whilePending"` | Capture regular-mode clicks while a question is pending; `always` keeps capture active in regular mode, and `off` disables mouse capture in both regular and fullscreen modes. Editable in `/settings`. |
| `terminal.hyperlinks` | boolean or `"auto"` | `"auto"` | Override OSC 8 hyperlink support (advanced, JSON-only) |
| `terminal.images` | string or boolean | `"auto"` | Override image protocol support with `"kitty"`, `"iterm2"`, `false`, or `"auto"` (advanced, JSON-only) |
| `terminal.trueColor` | boolean or `"auto"` | `"auto"` | Override truecolor support (advanced, JSON-only) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max. Applies to `@file` attachments, `read`, and images returned by tools |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

With `terminal.mouse: "whilePending"`, regular-mode native selection and scrollback are unchanged when no question is pending. During capture, use the terminal's selection bypass or set `"off"`; wheel reports are consumed. Unknown frame placement ignores clicks rather than guessing. See [Mouse Input](tui.md#mouse-input) for bypass modifiers, tmux calibration and the herdr short-frame limitation. This setting does not change `tuiMode`.

### Prompt Cache

Sizes how long foreground tools may block on the active model's prompt-cache lifetime, so a long
`bash` call never straddles cache expiry and forces a full re-read. When the model's cache TTL is
unknown (e.g. Google models) or caching is off, no budget applies and timeout behavior is unchanged.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `promptCache.cacheAwareTimeouts` | boolean | `true` | Cap foreground tool waits at the model's prompt-cache TTL minus the safety buffer; `false` restores the fixed legacy ceilings |
| `promptCache.safetyBufferSeconds` | number | `30` | Headroom subtracted from the cache TTL (a 5m TTL yields a 270s ceiling). If it consumes the whole TTL, no budget applies |
| `promptCache.goalBackstopMaxSeconds` | number | `270` | Longest a goal parked on live wake sources (terminal monitors, background sessions, detached `eval` cells, task children) waits before it re-checks with a full turn, clamped to 1..3600. The default lands inside the 5m cache TTL; raise it toward `3570` to trade re-check frequency for cost on a wait you trust |

A foreground `bash` command still running at the budget is handed to a live background session
instead of being killed; its explicit `timeout` remains the kill deadline. See
`terminal.timeoutAction` to switch that hand-off back to a kill.

### Handoff Hint

When a large session sits idle past its model's prompt-cache lifetime, the next reply has to resend the whole
context at the cache-write price. The handoff hint shows one line above the editor with that price and the price of
a fresh session's first reply, plus two choices: **Start fresh with a handoff** (`/handoff`) opens a new session,
linked to this one, whose first entry is a short brief built from the session's state (goal, open todos, last request
and answer, touched files, the old session's path); **Keep going** (`/handoff keep`) hides it for the rest of the
session. A reopened session (a resume or `--continue`) counts its cache age from its last reply, so reopening a large
session after its cache expired shows the hint before the first reply. The hint never interrupts a turn and never
switches on its own; if another extension cancels the switch, the hint stays. `/handoff` with any other argument
only explains the two choices. Prices come from the model's cost card; on a
subscription they are API-price equivalents. No hint is shown for models without a cache lifetime or a price, for task
children, in print/JSON mode, for turns an extension started, while a goal is active, or once compaction is about to
run.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `handoffHint.enabled` | boolean | `true` | Offer the hint at all |
| `handoffHint.minContextTokens` | number | `200000` | No hint below this context size |
| `handoffHint.minSavingUsd` | number | `1` | No hint unless a fresh session saves at least this much on the next reply |

### Job widgets

A background command that keeps printing numbers (a render, a benchmark, a test run) gets a small live chart:
once it has run for `authorAfterMs` and printed a few lines, a model reads the command and a redacted sample of
its output once and writes a chart spec, and every update after that is computed locally from new output. Jobs
whose output has nothing worth charting stay plain. It needs no setup; the views reach clients through the
`job_widget_state` event ([RPC](rpc.md#job-widgets)).

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `jobWidgets.enabled` | boolean | `true` | Build widgets at all; `false` taps no output and never calls a model |
| `jobWidgets.model` | string | - | `provider/model-id` that writes the specs; otherwise a model the host provides, else the session's model |
| `jobWidgets.authorAfterMs` | number | `15000` | Job age in milliseconds before its spec is written |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows); supports a leading `~` for the home directory |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `tools.bash.redactSecretsInOutput` | boolean | `false` | Redact credential-shaped bash stdout and stderr before streaming, retaining output, or writing output spill files |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

To opt in, set:

```json
{
  "tools": {
    "bash": {
      "redactSecretsInOutput": true
    }
  }
}
```

The default is off. When enabled, bash replaces GitHub, Slack, OpenAI/Anthropic,
AWS access-key, Google API-key and JWT-shaped tokens, PEM private-key blocks,
Bearer credentials, and secret-named `KEY=VALUE` values with `<redacted>`.
Assignment names are retained; `AUTH` and `AUTHORIZATION` match complete name
segments, not `AUTHOR`. Quoted assignment values end at their closing quote or
the next newline. Bearer values must be token-shaped (at least eight characters,
including a digit or token punctuation), so ordinary prose is retained when
its word delimiter arrives.
This applies to core bash, user `!cmd`/`!!cmd`, and persistent terminal
bash, including streamed updates, background completion notices, terminal screen
reads, structured results, output spill files and resulting transcript entries.
The tool-child runtime uses the same setting.
Credential prefixes are recognized after non-alphanumeric boundaries inside
URLs, paths and compound tokens. ANSI styling and charset designations do not
split credential detection; hidden OSC payloads (such as
terminal titles and hyperlink targets) are omitted while redaction is enabled.

An incomplete token is held until its delimiter or process exit. Persistent
terminals also flush after 50 ms without output so idle prompts and complete
cursor-control sequences reach screen reads. Once a token contains a full known
public credential prefix (including `AKIA`, `AIza`, or `eyJ`), or a Bearer value
has begun, idle flushes withhold it until a delimiter or process exit. Secret-named
assignment values remain masked from their first character. Mere prefix fragments
such as `I`, `e.g.`, `git`, `sk`, and `AI` are published verbatim at idle.
At a delimiter, withheld tokens are redacted if they match a complete credential
shape, otherwise released verbatim. At process exit, incomplete started shapes
are replaced by their public prefix plus `<redacted>`; already published prefix
characters are not repeated. Tokens longer than 8,192 characters are
conservatively redacted to bound memory. Enabling the setting affects newly
started commands; it does not rewrite existing terminal sessions, transcripts,
command arguments, or files created by commands. This is shape detection, not a
guarantee that arbitrary encoded or unrecognized credentials will be removed.

Windows paths in JSON must use forward slashes or escaped backslashes:

```json
{
  "shellPath": "C:/Program Files/Git/bin/bash.exe"
}
```

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.senpi/agent/npm/`; project-scoped npm packages install under `.senpi/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

### Tools

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultTools` | string[] | - | Built-in tools enabled initially. When omitted, Pi uses its standard defaults |

`defaultTools` selects the built-in tools enabled at startup. Extension and SDK custom tools remain enabled. Available built-ins are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`:

```json
{
  "defaultTools": ["bash", "edit", "write"]
}
```

On Windows, select `powershell` instead of `bash`, or include both:

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

A list of only `+name` and `-name` entries changes the inherited selection instead of replacing it. This replaces `bash` with `powershell` and enables `grep` on top of the defaults:

```json
{
  "defaultTools": ["-bash", "+powershell", "+grep"]
}
```

An empty array starts with no built-in tools while preserving extension and SDK custom tools. `--tools` replaces this behavior with a strict allowlist for all tools and does not accept `+name` or `-name`, `--no-tools` disables all tools, and `--no-builtin-tools` disables the built-in defaults. `--exclude-tools` filters the resulting list. A project `defaultTools` array of plain names replaces the global array; a project list of only `+name` and `-name` entries applies on top of the global selection.

`/reload` enables tools newly added to `defaultTools`. It does not disable tools removed from it or re-enable unchanged tools you turned off. `--tools`, `--no-tools`, and `--no-builtin-tools` override `defaultTools`, also on reload.

#### Eval-only tools

Whenever the `eval` tool is available (codemode loaded), `bash`, `powershell`, `grep`, `workflow` and `monitor` leave the model's direct tool list and run only inside eval cells:

```js
const { output } = await tool.bash({ command: "ls -la" });
const hits = await tool.grep({ pattern: "TODO", path: "src" });
const snapshot = await tool.workflow({ action: "snapshot", run_id });
await tool.monitor({ description: "build", command: "bun run build", filter: "^done" });
```

This is the default and has no setting. Tools may declare `exposure: "eval"` to join this policy; `bash`, `powershell` and `grep` use that declaration. They remain registered and discoverable through `tool_schema` inside eval. Hooks and permission checks apply unchanged to calls made this way, and the prompt surfaces that document these tools render the `tool.<name>(` form to match. If the model attempts a direct call anyway, the call returns a hint naming the eval form instead of executing the tool. When the `eval` tool is unavailable (codemode not loaded, or a child agent whose allowlist omits it), the policy stays inert and otherwise enabled tools remain directly callable, so shell, text search, workflow and monitor access is never lost.

### Automatic Turns

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `engineTurns.maxPerUserInput` | number | `0` | Turns the agent may start on its own (stream-rule nudges, goal continuations, other extension follow-ups) after one user message before it pauses; `0` (the default) turns the limit off |
| `engineTurns.maxToolFreePerMinute` | number | `12` | Turns started on its own within 60 s that called no tool before it pauses; `0` turns the limit off |
| `turn_inactivity_ms` | number | `3600000` | Milliseconds a turn may run with no tool progress before it is stopped as a deadline; renewed only by tool execution events and admitted user input, never by streamed text. Minimum `60000`; `0` disables |
| `turn_max_runtime_ms` | number | `21600000` | Hard cap on one turn's runtime from prompt accept; `0` disables |

When a limit is reached the session pauses with a notice instead of starting another turn; any message you send continues it, because only turns since your last message count.

### Ask User

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `askUser.enabled` | boolean | `true` | Enable the built-in question tool (`request_user_input` / `ask_user_question`) |
| `askUser.timeoutMinutes` | number | `30` | Idle minutes before an unanswered question times out, clamped to 1–120 |
| `askUser.bell` | boolean | `true` | Ring the terminal bell once for a newly displayed question; reconnect hydration does not ring |

Disable for one run without changing settings with `--no-ask-user` (wins over `askUser.enabled: true`). `disabledBuiltinExtensions: ["ask-user"]` remains the coarse switch that skips loading the extension.

```json
{
  "askUser": {
    "enabled": true,
    "timeoutMinutes": 30,
    "bell": true
  }
}
```

While a question is pending, the terminal title shows `? <header>` unless an active tool title takes precedence. Settlement restores the previous title layer. Set `askUser.bell: false` to keep the title and question display without a bell.

### Todo

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `todo.firstTurnPlan` | `"force"` \| `"remind"` \| `"off"` | `"force"` | First prompt of a session that is not a question (`?`/`!` ending): `"remind"` adds a hidden reminder to open the turn with a phased `todo` init; `"force"` also sends a named `tool_choice` for `todo` on that first request where the provider accepts one (Anthropic models whose compat allows forced tool choice with thinking off, OpenAI Responses, OpenAI Chat Completions unless `compat.supportsForcedToolChoice` is `false`), otherwise it falls back to the reminder. A provider that refuses the forced choice gets the request once more without it, and that model is not forced again for the rest of the process; `"off"` disables both. Print and JSON modes never arm |
| `todo.turnEndBackstop` | `boolean` | `true` | When a main-session turn (not print/json, no active goal or continuation) ends text-only while the todo list still has open tasks and the final paragraph does not ask the user a question, queue a hidden `senpi.todo-owed` followUp nudging the next open task. At most two per chain of unattended turns; the third notifies once and stays silent until the next accepted user message |

While open todo work has an active wake source (such as `senpi-task`), a running goal, a pending continuation, or pending messages, the backstop sends no nudge or warning. The footer shows `waiting: <sources>` until the next `agent_start`; session start and tree navigation also clear it. The `todo_owed_reminder` event reports `reason: "waiting"` and the source names, and the session log records suppression reasons at debug level.

A goal whose continuation already stopped does not count as waiting: it keeps its own stop notice and gets no footer or nudge. With nothing on duty, the two automatic continuations stay hidden and count only while they close no task; when both end with open work, one notice says why the agent stopped and how to resume it (reply, or `/todo done` / `/todo drop`). The chain also resets on accepted direct input, session start, or tree navigation.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |
| `sessionShutdownHandlerWarnMs` | number | `2000` | Warn when a single extension's `session_shutdown` handler has run this long. Set to `0` to disable the warning. |
| `sessionShutdownHandlerTimeoutMs` | number | `10000` | Hard cap for a single extension's `session_shutdown` handler. Set to `0` to disable the cap. |
| `sessionShutdownQuitBudgetMs` | number | `2000` | Total time a quit that exits senpi waits on all `session_shutdown` handlers together. Set to `0` to disable it. |

```json
{ "sessionDir": ".senpi/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `SENPI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

#### Shutdown handler budget

senpi bounds each extension's `session_shutdown` handler so one slow extension cannot hold quit, `/reload`, `/new`, `/resume` or a fork hostage. Past `sessionShutdownHandlerWarnMs` it logs one warning naming the extension; at `sessionShutdownHandlerTimeoutMs` it aborts the `signal` that handler received on the event, reports an extension error, and continues teardown with the next handler. The handler itself is not killed - it keeps running until the process exits - so extensions that persist durable state should observe `event.signal`.

```json
{ "sessionShutdownHandlerWarnMs": 2000, "sessionShutdownHandlerTimeoutMs": 10000, "sessionShutdownQuitBudgetMs": 2000 }
```

A quit that exits senpi (interactive quit, print mode, a single-connection RPC process) also has a total budget, counted from when senpi starts running the shutdown handlers (the steps before them, such as stopping the TUI, are not counted): every handler still starts, in order, but once `sessionShutdownQuitBudgetMs` has passed senpi stops waiting, logs one warning naming the extension that overran it and the elapsed time, and exits. Handlers that start after that point get 1 ms, so their synchronous cleanup still runs. `/reload`, `/new`, `/resume`, forks, and an RPC host closing one session while it keeps running keep only the per-handler limits.

Only `session_shutdown` is bounded; other extension events (including ask-user and approval dialogs, which may legitimately wait for minutes) are unaffected.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `favoriteModels` | string[] | - | Favorite model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |
| `enabledModels` | string[] | - | Legacy global model-catalog narrowing patterns (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["anthropic/*", "openai/*"],
  "favoriteModels": ["anthropic/claude-*", "openai/gpt-5.4"]
}
```

`enabledModels` changes which models appear in the catalog, startup selection, and `/model` narrowing. `favoriteModels` is separate and only controls Ctrl+P cycling.

#### Per-model memory

In `state.json`, `modelThinkingLevels`, `modelLastOnThinkingLevels`, and `modelServiceTiers` are maps from `"provider/id"` to a level or tier value. They're managed automatically: switching models, using `/reasoning`, `/efforts`, or `/fast` writes the appropriate key. You rarely need to edit them by hand, but the state file's shape looks like this:

```json
{
  "modelThinkingLevels": {
    "chatgpt-subscription/gpt-5.6-sol": "xhigh",
    "anthropic/claude-fable-5-1": "high"
  },
  "modelServiceTiers": {
    "chatgpt-subscription/gpt-5.6-sol": "priority"
  }
}
```

A `-fast` catalog variant (like `gpt-5.6-sol-fast`) and its base model share one entry, so you can't give them conflicting tiers.

#### Favorite model decorators

Favorite model patterns accept optional decorator suffixes for reasoning level and service tier:

```
provider/model-id                  # bare pattern
provider/model-id:high             # pin reasoning to high
provider/model-id:priority         # pin service tier to priority
provider/model-id:priority:high    # pin both tier and level
chatgpt-subscription/gpt-6-astra:xhigh:ultrafast # Astra Ultrafast
claude-*:xhigh                     # glob with level pin
```

Decorators survive favorite toggling. A `:level` pin takes precedence over the per-model memory for reasoning, and a `:priority` pin takes precedence for the service tier. Under a priority pin, `/fast off` notifies that fast mode is fixed by the active model selection. An `:ultrafast` pin takes precedence over remembered Fast mode; `/fast on` and `/fast off` leave that pin in place.

#### Thinking level precedence

When a model becomes active, its reasoning level is resolved in this order:

1. An explicit or ephemeral session-scoped level (e.g. turn-scope `set_thinking_level`)
2. A favorite pattern `:level` pin
3. The per-model `modelThinkingLevels` memory
4. `defaultThinkingLevel`
5. `"medium"` (the hardcoded fallback)

The resolved level is always clamped to what the model actually supports.

#### Service tier precedence

The service tier on outgoing requests is resolved as:

1. A scoped/favorite service-tier pin (such as `:priority` or `:ultrafast`)
2. The model catalog's `serviceTier`
3. `openai.serviceTier` (the global OpenAI setting)

The per-model `modelServiceTiers` memory is not part of that resolution: it applies to ChatGPT Subscription
models only, through fast mode. It acts as the session-start default for `/fast` (a remembered
`"priority"` starts the session fast) and as an explicit `"auto"` opt-out of a catalog-inherited
priority tier, which keeps `service_tier` off the wire. Under a `:priority` pin the memory has no
effect, because the pin outranks it. `ultrafast` is not a remembered value: a stored `ultrafast` is
ignored. Select Ultrafast with a decorator, a `models.json` `serviceTier`, or `openai.serviceTier`.

#### Ultrafast (GPT-6 Astra and GPT-6.1 Sol)

Select Ultrafast independently of reasoning effort on either first-party lane:

```bash
senpi --model chatgpt-subscription/gpt-6-astra:xhigh:ultrafast
senpi --model openai/gpt-6.1-sol:ultrafast:max
senpi --model chatgpt-subscription/gpt-6.1-sol-ultrafast
```

Both models support `low`, `medium`, `high`, `xhigh`, and `max` with Ultrafast. `chatgpt-subscription/gpt-6.1-sol-ultrafast` is a catalog model that always sends GPT-6.1 Sol at Ultrafast, with `xhigh` as its default effort; any other effort you select still applies. The two decorators can appear in either order and work in `favoriteModels` and `--models` patterns too. A custom model entry can instead set `serviceTier: "ultrafast"` in `models.json`; keep its cost at Standard rates, since the adapter applies the Ultrafast multiplier. Ultrafast costs 6x Standard for both models, including cached input and long-context rates.

This is an explicit request preference; availability is determined by the provider and account. Use it with GPT-6 Astra or GPT-6.1 Sol on OpenAI or ChatGPT Subscription. Senpi sends it only to the `openai` and `chatgpt-subscription` providers: selecting it on any other provider, including a gateway that serves one of these models, prints a warning and the request goes out at that provider's default tier. On OpenAI or ChatGPT Subscription, selecting it for any other model prints a warning and still sends it, because the provider may accept it; those models keep their Standard price. `/fast` remains the Priority toggle. Switching between Ultrafast and another tier starts a fresh WebSocket response chain while retaining the conversation.

See OpenAI's [Ultrafast guide](https://developers.openai.com/api/docs/guides/ultrafast-mode) and [pricing](https://developers.openai.com/api/docs/pricing).

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |
| `markdown.mermaid` | string | `"streaming"` | Mermaid rendering mode: `"off"`, `"final"`, or `"streaming"` |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.senpi/agent/settings.json` resolve relative to `~/.senpi/agent`. Paths in `.senpi/settings.json` resolve relative to `.senpi`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `enabledBuiltinExtensions` | string[] | all builtins | Optional allowlist of builtin extension ids to load |
| `disabledBuiltinExtensions` | string[] | `[]` | Builtin extension ids to skip; overrides `enabledBuiltinExtensions` |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |
| `maxSkillExpansionsPerPrompt` | number | `5` | Distinct skills one prompt may expand; later skill commands stay literal. Must be a positive integer, otherwise the default applies. The parser reads at most 64 invocation tokens per prompt |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "favoriteModels": ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.senpi/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.senpi/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .senpi/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
