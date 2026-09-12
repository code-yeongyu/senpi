# reasoning Extension Changes

## Capability-aware /reasoning and /efforts commands (2026-08-16)

### What changed

- New builtin extension registering `/reasoning [on|off]` and `/efforts [minimal|low|medium|high|xhigh|max]`.
- Every invocation classifies the active model through `classifyReasoningCapability(model)` from `core/thinking-levels.ts`. Four capability kinds are handled:
  - `none`: both commands report the model does not support reasoning.
  - `always-on`: `/reasoning off` is rejected; `/efforts` works normally.
  - `on-off`: `/efforts` directs the user to `/reasoning on` or `/reasoning off`.
  - `graded`: the full effort ladder is available, gated by the model's catalog levels.
- `/reasoning on` resolves the preferred restore level from `modelLastOnThinkingLevels`, then `modelThinkingLevels`, then `defaultThinkingLevel`, then `"medium"`, always clamped to a supported non-off level. `/reasoning off` saves the current level to the companion map before setting off.
- No-arg forms show status only and never open a selector, so both work headless and over RPC.
- Completions are dynamic: the effort ladder is drawn from the live model (tracked via `session_start`/`model_select`) and suppressed for non-graded models.

### Why a builtin extension

- The commands read per-model settings memory and call `pi.setThinkingLevel()` / `pi.setSessionThinkingLevel()` with model-specific persistence. An external extension could call these APIs, but the commands are core product surface that should ship by default and load before user extensions.

### Expected merge conflict zones

- LOW: `builtin/index.ts` at the import and the registration array entry.
