# bash-timeout builtin extension — fork surface

Injects the default `timeout` into every `bash` call and appends the "Bash Tool Timeout Policy"
section to the system prompt.

## 2026-09-04 - Timeout policy stops restating the terminal waiting doctrine

### What changed

- `timeout.ts`: the wait-routing bullet (`monitor({command, filter})` vs foreground sleep/poll) and the `run_in_background`/`kill_bash` bullet are removed; the detach bullet keeps the window, `bash_id`, and kill-deadline facts and hands steering to the terminal session tools. `BashTimeoutPromptOptions.evalOnly` is gone with the only text that read it.
- `index.ts`: stops resolving and passing `evalOnly`.
- `test/suite/bash-timeout-extension.test.ts`: the byte-identical golden policy is re-pinned to the shortened text and the six pins for sentences that moved out are dropped.

### Why

- `TERMINAL_PROMPT_SECTION` already owns the monitor/notification model and the session tools, and both sections ship together whenever the PTY bash tool is live. The policy drops from 243 to 92 tokens while keeping every timeout fact it alone states.

### Expected merge conflict zones

- LOW: the template literal tail and the golden constant in the test.

## Timeout policy renders the reachable bash/monitor call form (2026-09-03)

### What changed

- `timeout.ts`: `buildBashTimeoutPrompt`'s second positional `foregroundWindowSeconds` parameter becomes a `BashTimeoutPromptOptions` object (`foregroundWindowSeconds?`, `evalOnly?`). Under `evalOnly` the wait-routing bullet names `tool.monitor({ command, filter })` and the background-session bullet names `tool.bash({ command, run_in_background: true })`; otherwise both keep their direct forms. The kill-deadline contract, the detach bullets, and their omission when no PTY bash is live are unchanged.
- `index.ts`: the `before_agent_start` handler passes the resolved window and `evalOnly: isEvalOnlyRouting(pi)` through the new options object.

### Why

- The policy is appended to every system prompt and hardcoded `monitor({command, filter})`, so in any eval-routed session it pointed the model at a tool that is not on its direct tool list. The bullet that exists to stop sleep/poll waits was the one bullet naming an uncallable form.

### Why an extension could not handle it

- The policy text is built and appended by this builtin; only it can choose the call form for the session it is rendering into.

### Expected merge conflict zones

- LOW: both files are fork-only; the signature change is contained to this extension and its tests.

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
