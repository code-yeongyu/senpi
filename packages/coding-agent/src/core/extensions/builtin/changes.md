# Builtin extensions changes

## service-tier: mirror the Codex fast toggle into the session indicator (2026-07-31)

- The session toggle added on 2026-07-31 lived only inside this extension, so no host surface could
  tell that fast mode was on. It now calls `pi.setSessionFastMode()` on every toggle and clears the
  flag on `session_start`, which is what lights the TUI footer's lightning indicator.
- `test/suite/service-tier-extension.test.ts` asserts `session.isFastModeActive()` across the
  toggle and the `session_start` reset.
- Expected merge conflict zones: LOW in `service-tier.ts` around the no-variant toggle branch and
  the `session_start` handler.

## service-tier: `/fast` toggles a session priority tier on subscription Codex models (2026-07-31)

- Fixes issue #545 and reverses the conclusion of the 2026-07-30 entry below. `/fast`
  on an `openai-codex` model has no `-fast` catalog sibling to switch to, and the
  previous change turned that into a "priority tier is not available on a ChatGPT
  subscription" notice. That premise was wrong.
- Measured with a live ChatGPT Pro token:
  `chatgpt.com/backend-api/codex/models?client_version=0.145.0` (originator
  `codex_cli_rs`) advertises
  `service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }]`
  and `additional_speed_tiers: ["fast"]` for gpt-5.6-sol/terra/luna, gpt-5.5 and
  gpt-5.4 (empty for gpt-5.4-mini and gpt-5.3-codex-spark). The first-party Codex
  CLI 0.145.0, routed through a logging proxy on subscription OAuth, sends
  `service_tier: "priority"` in the `POST /backend-api/codex/responses` body.
- The earlier "served at normal tier" reading came from the SSE echo, which is not
  a confirmation channel: `response.created` reports `auto` and
  `response.completed` reports `default` whether `priority` was sent or nothing was.
- The no-variant branch now toggles a session-scoped priority tier that the
  existing `before_provider_request` handler injects, so `/fast` reports
  `Fast mode enabled: <model>` and the next Codex request carries
  `service_tier: "priority"`. The tier is session-only (never persisted) and
  resets on `session_start`; an explicit model/scoped tier still wins.
- `test/suite/service-tier-extension.test.ts` replaces the "clear no-op" case with
  the toggle assertion on the payload, and covers a mid-session switch to another
  Codex model keeping the tier, a hop to a non-OpenAI model dropping it,
  explicit-tier precedence, and the `session_start` reset.
- Expected merge conflict zones: LOW in `service-tier.ts` around the
  `sessionFastMode` flag, the no-variant branch, and the
  `before_provider_request` tier resolution.

## service-tier: explain why `/fast` is unavailable on a subscription (2026-07-30)

- Fixes the misleading notice reported in issue #499. `/fast` is registered only
  for `openai-codex`, but `generate-models.ts` emits `-fast` priority variants
  only for the direct `openai` provider, so no Codex model ever has a target and
  the command could only ever answer "Fast mode is not supported for
  openai-codex/<model>" — which reads as a per-model gap rather than a
  plan-level limitation.
- Generating the missing Codex variants would be wrong. Measured against
  `chatgpt.com/backend-api/codex/responses` with a live ChatGPT Pro
  subscription: `service_tier: "priority"` and `"default"` both return HTTP 200
  and the response echoes `"auto"`, while `"auto"`, `"flex"` and `"scale"` are
  rejected with HTTP 400 `Unsupported service_tier`. The backend allowlists
  `priority` but serves it at normal tier, and
  `getServiceTierCostMultiplier()` would still bill it at 2.5x for gpt-5.5
  (2x elsewhere) — so synthesising variants would inflate reported cost for
  unchanged service.
- The no-variant branch now states that priority tier is unavailable on a
  ChatGPT subscription and that it requires API-key billing on the `openai`
  provider, where `-fast` variants already exist and `/fast` works.
- `test/suite/service-tier-extension.test.ts` asserts the notice explains the
  subscription limitation and no longer blames the model.
- Expected merge conflict zones: LOW in `service-tier.ts` around the
  `FAST_UNAVAILABLE_ON_SUBSCRIPTION` constant and the no-variant branch.

## service-tier: add `/fast` for OpenAI Codex (2026-07-29)

- `service-tier.ts` registers `/fast` only for the `openai-codex` provider.
  Enabling resolves the active model's compatible `-fast` catalog sibling,
  switches the current session to it, and derives priority mode from that
  selected model's `upstreamModelId` plus `serviceTier` metadata.
- Disabling restores the compatible base catalog model. `session_start` also
  restores the base model when a session opens on a fast variant, so the command
  remains session-scoped and never rewrites persisted model defaults.
- Models without a compatible priority variant and non-Codex providers receive
  clear no-op notifications.
- The shared service-tier payload injector now covers
  `openai-codex-responses`; explicit payload tiers remain authoritative.
- `test/suite/service-tier-extension.test.ts` covers session reset, both model
  switches, upstream request model plus priority tier, provider/model gating,
  non-Codex payloads, and explicit-tier preservation.
- Expected merge conflict zones: MEDIUM in `service-tier.ts` around the command
  and `before_provider_request` handler.

## terminal + goal: monitor liveness event contract (2026-07-28)

- New `monitor-state-event.ts` defines the internal `terminal_monitor_state` pi-event
  payload (`activeCount`).
- The terminal extension publishes the live registry count on every existing
  `MonitorRegistry.onChange` transition (register, pause/rearm snapshot change,
  settle, dispose) while preserving the monitor footer update.
- The goal builtin consumes this internal event to select immediate versus delayed
  continuation policy; no public `ExtensionContext` or RPC protocol type changed.
- Expected merge conflict zones: LOW in `terminal/extension.ts` around the monitor
  registry `onChange` callback; NONE in `extensions/types.ts`.

## bash-timeout: beyond-max routing to run_in_background + monitor (2026-07-28)

- `bash-timeout/timeout.ts` `buildBashTimeoutPrompt()`: the beyond-max bullet no longer teaches
  "run them in the background via tmux or a similar mechanism" — it now routes to
  `run_in_background: true` with the decisive output watched via `monitor`. The old advice
  directly contradicted TERMINAL_PROMPT_SECTION ("do NOT use tmux"), which is appended to the
  same system prompt immediately after this section (builtin #11 → #12), and contradictions
  destabilize instruction following more than missing detail.
- `test/suite/bash-timeout-extension.test.ts`: the "references tmux as the escape hatch" pin is
  replaced by the new contract (run_in_background + monitor present, tmux absent).
- Expected merge conflict zones: LOW — fork-owned `timeout.ts` prompt string and its test.

## Remove the /sessions session-observer HUD (2026-07-26)

- Deleted the `session-observer/` builtin (11 files: `index`, `loader`, `overlay`, `overlay-format`, `scanner`, `text`, `transcript`, `transcript-entries`, `transcript-format`, `types`) and its three vitest suites (`session-observer-picker`, `session-observer-overlay`, `session-observer-scanner`).
- `builtin/index.ts`: dropped the `sessionObserverExtension` import and the `{ id: "session-observer", factory: sessionObserverExtension }` entry from `builtinExtensions`.
- `core/keybindings.ts`: removed the `app.sessions.observe` keybinding (interface entry, the `ctrl+s` default binding, and the `observeSessions` alias). `ctrl+s` is freed and intentionally not rebound.
- `modes/interactive/interactive-mode.ts`: removed the `app.sessions.observe` -> `/sessions` action handler and the `/hotkeys` row that advertised "Observe session transcripts".
- `AGENTS.md` and the root `README.md` extension table: dropped the `session-observer` row and renumbered the subsequent entries (26 -> 25 in-tree extensions).
- `docs/keybindings.md`: dropped the `app.sessions.observe` row.
- `utils/changes.md`: corrected the stale `shortenPath()` note that claimed it backed the `/sessions` HUD picker; `shortenPath()` itself stays (other consumers remain).
- Neo (the Go TUI) shipped a native port of the same HUD; it was removed in lockstep to satisfy the repo-wide "no /sessions HUD source" contract: `internal/ui/builtinext/{observer,observer_overlay,observer_viewer,observer_test,transcript,transcript_decode,transcript_render}.go`, the `ResolveSessionsCommandOutcome` resolver and its tests, the `app.sessions.observe` keybinding definition/scope/migration/registry-test entries, the qaharness `observer` scenario, the welcome-menu entry that advertised it, the `/sessions` command in the bridge `get_commands` testdata, and the `task-14-session-observer-tail` visual-claims manifest entry plus its triplet.
- Why: user-requested cleanup. The HUD duplicated `/resume`'s session-picking surface and the `ctrl+s` chord collided with the more useful `app.session.toggleSort` / `app.models.save` chords that already bind `ctrl+s` in other scopes.
