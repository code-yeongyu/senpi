# bash-timeout builtin extension — fork surface

Injects the default `timeout` into every `bash` call and appends the "Bash Tool Timeout Policy"
section to the system prompt.

## Kill-deadline semantics (2026-08-07)

### What changed

- `timeout.ts`: the built-in default and recommended maximum are both 1800s (30 min). The
  prompt-cache safe-wait capping is removed: the terminal extension now bounds foreground
  blocking at the ~60s window and auto-detaches survivors alive to background sessions, so
  `timeout` is purely the process kill deadline. The prompt rider teaches the
  detach → notification → monitor model.
- `index.ts`: both handlers use the env-resolved defaults directly. The live-model budget
  lookup and the native-Anthropic-bash exception are gone.

### Why

A 60s foreground window sits far below every cache lifetime, so blocking can no longer breach a
cache-derived ceiling. The deadline that still applies after detach is enforced by
`scheduleDetachedSweep` in `terminal/tools/bash.ts`.

### Supersedes

This replaces the 2026-07-28 cache-aware-ceiling entry below. The ceiling math is gone, but its
native-Anthropic-bash exception survives in a narrower form: when `PI_ANTHROPIC_BASH` is active for
an `anthropic-messages` model the PTY `bash` tool steps aside, so `buildBashTimeoutPrompt` receives
an `undefined` window and omits the auto-detach bullets rather than promising behavior nothing
implements. The policy also names the *configured* window (`PI_BASH_FOREGROUND_SECONDS`) instead of
a hardcoded 60s.

## Cache-aware ceiling and native-Anthropic-bash exception (2026-07-28)

### What changed

- `timeout.ts`: `resolveEffectiveBashTimeouts(defaults, safeWaitSeconds)` lowers the recommended
  maximum to the prompt-cache safe-wait budget (`ExtensionContext.getPromptCacheSafeWaitSeconds()`),
  pulling the injected default down with it when the budget is smaller. `buildBashTimeoutPrompt`
  names the ceiling, the prompt-cache reason, and steers cleanup through `kill_bash`.
- `index.ts`: the policy prompt is rebuilt per `before_agent_start` from the LIVE model, and the
  budget is suppressed when native Anthropic bash is active for an `anthropic-messages` model.

### Why the native-Anthropic-bash exception exists

When `PI_ANTHROPIC_BASH` is enabled the provider replaces the PTY `bash` tool and the `terminal`
extension steps aside (`terminal/extension.ts` `shouldStepAside`). Nothing then implements the
cache-deadline auto-detach, so advertising a cache ceiling would promise behavior that cannot
happen. The budget therefore only applies while the PTY tool is live.

### Behavior when no budget applies

Byte-identical to the pre-change policy: the same injected default, the same recommended maximum,
and a prompt string that compares equal under strict `===`.
