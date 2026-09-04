# packages/coding-agent/src/core/retry-fallback

Model fallback chains and hint-aware 429 retry policy for `agent-session.ts`. Pure/injectable modules only — every clock, timer, and registry probe is injected; `core/agent-session.ts` owns the single impure wiring. No local `changes.md`: fork changes track in `src/changes.md` / `core/changes.md`.

## FILES

| File | Role |
|---|---|
| `controller.ts` | `RetryFallbackController`: turn-scoped tried-selector set and rejection ledger, `ActiveFallbackState`, `tryFallback` / `maybeRestorePrimary(revertPolicy)` / `notifyCompactionApplied` / `clearForManualModelChange`, injected `isCandidateUsable` capacity preflight + `classifySwitchFailure` seam, `exhaustion` summary, content-keyed memo of canonicalized chains |
| `chains.ts` | Selector parse/format, chain-key resolution, `canonicalizeFallbackChains` (bare-selector expansion + registry eligibility) |
| `expansion.ts` | Bare-selector family expansion; OpenRouter denylist; OAuth-first auth tiers; `PROVIDER_PRECEDENCE` tie-break |
| `hint-policy.ts` | Pure 429 hint tiers (`no-hint-fast-fallback` / `tier1-in-turn` / `tier2-fallback-probe-back` / `tier3-fallback-only`) + probe schedule math |
| `probe-scheduler.ts` | ONE armed probe plan per session, max two probes (half-hint, then deadline), injected `setTimeout`/`clearTimeout` |
| `cooldown.ts` | `SelectorCooldowns`: runtime-only selector suppression, injected `now`/`random`, honors `retryAfterMs` |
| `billing.ts` | Billing-class failure detection — billing fallbacks are PINNED (never revert on cooldown expiry) |
| `settings.ts` | `RetrySettings` shape (chains, `fallbackRevertPolicy`, provider retry timeouts) resolved via `settings-manager.ts` |
| `validate.ts` | Chain validation with per-selector warnings (unknown models, unsupported thinking levels) |
| `log.ts` | `fallback.log` writer: 5 MiB cap, key allow/blocklists, secret scrubbing |

## WHERE TO LOOK

| Task | File |
|---|---|
| Change when fallback fires or reverts | `controller.ts` |
| Change which candidates are context-compatible | `controller.ts` (`isCandidateUsable` wiring lives in `core/agent-session.ts`) |
| Change selector syntax / chain canonicalization | `chains.ts` |
| Change which providers a bare selector expands to | `expansion.ts` |
| Tune 429 wait/probe behavior | `hint-policy.ts`, `probe-scheduler.ts` |
| Add a non-recoverable failure class | `billing.ts` pattern |
| Change resolved settings shape | `settings.ts` + `core/settings-manager.ts` |

## CONVENTIONS

- Everything time- or randomness-dependent is injected (`now`, `random`, `setTimeout`/`clearTimeout`) — tests drive it deterministically with fake timers; never read `Date.now()` directly here.
- Injected probes are total. `isCandidateUsable` and `classifySwitchFailure` are optional, but when supplied a failure inside them propagates: a projection that cannot be computed is a defect, not a verdict about the candidate.
- A rung is skipped only on a verdict about that rung (`context-unusable`, cooldown, auth, …). Any other failure from `switchModel` is rethrown — swallowing it would spend the whole chain on one broken extension.
- Cooldowns are runtime-only and deliberately never persisted to settings or session files.
- Billing-class errors pin the fallback candidate as the session model and NEVER release; refusal pins release when a senpi-owned compaction successfully applies (context changed => one fresh primary attempt); `transient`/`hard-error` fallbacks revert per `fallbackRevertPolicy` (`cooldown-expiry` | `never`).
- `canonicalizeFallbackChains` is memoized on chains content — provider-error handling calls it several times per error.
- `fallback.log` scrubs by construction: blocked keys (`headers`, `env`, `authorization`, …), allowlisted data keys only, bearer/api-key text patterns truncated.
- Consumers: `agent-session.ts` (controller wiring), `settings-manager.ts` (resolution), `builtin/model-fallback/` (validate + canonicalize for `/model-fallback`), `builtin/cursor-cli-oauth/settings.ts` (`isFallbackEligible` probe).

## ANTI-PATTERNS

- Expanding a bare selector onto OpenRouter — it re-publishes other vendors' catalogs under namespaced ids; only an explicit `openrouter/...` selector may route there.
- Persisting cooldown or tried-selector state across sessions.
- Two in-flight probes, or arming a second plan without superseding — `probe-scheduler.ts` owns exactly one plan per session.
- Writing raw provider errors/headers to `fallback.log` — always go through `log.ts` scrubbing.
- Treating a billing error as transient — retrying the same account never recovers it.
- Falling back onto a model whose context window cannot hold the live conversation — that trades one dead lane for another; the capacity preflight skips it and the walk continues.
- Letting a rejected switch leave a committed `model_change` entry: `agent-session.ts` only persists and announces after the post-`model_select` budget assert clears.

## NOTES

- Tests: `test/suite/retry-fallback-*.test.ts` (21 files) — engine, chains, expansion eligibility, cooldown, hint tiers, probe scheduler, billing swap, revert, validate, log, context compatibility.
- Exhaustion is reported once by `agent-session.ts` `_emitRetryFallbackExhausted`: the unchanged `retry_fallback_exhausted` session event for TUI/RPC hosts, plus the typed extension event carrying `sessionId`, `from`, `exhaustionReason`, and `rejectedCandidates` so an extension can delegate.
- `streamRetryTimeoutMs` reconciles to `max(cap, streamStartTimeoutMs)` so a granted stream-start budget is never cut short; `0` disables.
