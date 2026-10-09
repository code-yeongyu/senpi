# packages/coding-agent/src/core/retry-fallback

Model fallback chains and hint-aware 429 retry policy for `agent-session.ts`. Pure/injectable modules only — every clock, timer, and registry probe is injected; `core/agent-session.ts` owns the single impure wiring. No local `changes.md`: fork changes track in `src/changes.md` / `core/changes.md`.

## FILES

| File | Role |
|---|---|
| `controller.ts` | `RetryFallbackController`: turn-scoped tried-selector set, `ActiveFallbackState`, `tryFallback` / `maybeRestorePrimary(revertPolicy)` / `notifyCompactionApplied` / `clearForManualModelChange`, content-keyed memo of canonicalized chains |
| `candidates.ts` | `firstUsableCandidate`: the chain scan after the current entry (unknown/self/tried/suppressed/unauthenticated/circuit-open skips; an all-open chain returns its first open entry as the probe) |
| `circuit-probes.ts` | `CircuitProbes`: a session's single probe token (admit / accept / noteFailure / release) and `isHealthExhaustionFailure` (billing + quota exhaustion) |
| `controller-types.ts` | Controller type declarations (`ActiveFallbackState`, deps, reasons) |
| `circuit.ts` | `FallbackCircuitBreaker` shared per resolved agent dir (`fallbackCircuitsFor`): doubling cooldown, Retry-After bounded by the cooldown ceiling (senpi#2446), single half-open probe lease; `createFallbackCircuitAccess` binds a session's owner id, clock (monotonic by default), and `fallback.*` settings; `admit()` is the only way to route to a half-open entry; admission is per request lane (`turn` / `probe-back:<n>`) and each acquisition gets a fresh generation; `acquireFallbackCircuits` holds a dir's breaker per session |
| `chains.ts` | Selector parse/format, chain-key resolution, `canonicalizeFallbackChains` (bare-selector expansion + registry eligibility) |
| `expansion.ts` | Bare-selector family expansion; OpenRouter denylist; OAuth-first auth tiers; `PROVIDER_PRECEDENCE` tie-break |
| `hint-policy.ts` | Pure 429 hint tiers (`no-hint-fast-fallback` / `tier1-in-turn` / `tier2-fallback-probe-back` / `tier3-fallback-only`) + probe schedule math |
| `probe-scheduler.ts` | ONE armed probe plan per session, max two probes (half-hint, then deadline), injected `setTimeout`/`clearTimeout` |
| `cooldown.ts` | `SelectorCooldowns`: runtime-only selector suppression, injected `now`/`random`, honors `retryAfterMs` |
| `billing.ts` | Billing-class failure detection — billing fallbacks are PINNED (never revert on cooldown expiry) when the billing hit the chain's original model or its account |
| `pin.ts` | `pinAfterSwitch`: pin provenance after one switch (refusal pins; billing pins only when it hit the original or its account) |
| `unusable.ts` | `UnusableEntries`: providers (account limit/billing) and entries (model-scoped exhaustion) this session saw refuse to serve, on the session cooldowns; the chain tries spent providers last and never rests on an unusable fallback |
| `settings.ts` | `RetrySettings` shape (chains, `fallbackRevertPolicy`, provider retry timeouts) resolved via `settings-manager.ts` |
| `validate.ts` | Chain validation with per-selector warnings (unknown models, unsupported thinking levels) |
| `log.ts` | `fallback.log` writer: 5 MiB cap, key allow/blocklists, secret scrubbing |

## WHERE TO LOOK

| Task | File |
|---|---|
| Change when fallback fires or reverts | `controller.ts` |
| Change selector syntax / chain canonicalization | `chains.ts` |
| Change which providers a bare selector expands to | `expansion.ts` |
| Tune 429 wait/probe behavior | `hint-policy.ts`, `probe-scheduler.ts` |
| Add a non-recoverable failure class | `billing.ts` pattern |
| Change resolved settings shape | `settings.ts` + `core/settings-manager.ts` |

## CONVENTIONS

- Everything time- or randomness-dependent is injected (`now`, `random`, `setTimeout`/`clearTimeout`) — tests drive it deterministically with fake timers; never read `Date.now()` directly here.
- Cooldowns and circuits are runtime-only and deliberately never persisted to settings or session files. Cooldowns are per session; circuits are shared by every session in the process on one agent dir (`/new`, `/resume`, `/fork` and in-process subagents included), open only on `transient`/`billing` fall-out, and never make a chain refuse a turn.
- Billing-class errors on the chain's original model (or its account) pin the fallback candidate as the session model and NEVER release; billing on a fallback target from another account never pins, and a session parked on an unusable fallback returns to the original at the next turn boundary regardless of cooldown or revert policy (senpi#2376); refusal pins release when a senpi-owned compaction successfully applies (context changed => one fresh primary attempt); `transient`/`hard-error` fallbacks revert per `fallbackRevertPolicy` (`cooldown-expiry` | `never`).
- `canonicalizeFallbackChains` is memoized on chains content — provider-error handling calls it several times per error.
- `fallback.log` scrubs by construction: blocked keys (`headers`, `env`, `authorization`, …), allowlisted data keys only, bearer/api-key text patterns truncated.
- Consumers: `agent-session.ts` (controller wiring), `settings-manager.ts` (resolution), `builtin/model-fallback/` (validate + canonicalize for `/model-fallback`), `builtin/cursor-cli-oauth/settings.ts` (`isFallbackEligible` probe).

## ANTI-PATTERNS

- Expanding a bare selector onto OpenRouter — it re-publishes other vendors' catalogs under namespaced ids; only an explicit `openrouter/...` selector may route there.
- Persisting cooldown or tried-selector state across sessions.
- Two in-flight probes, or arming a second plan without superseding — `probe-scheduler.ts` owns exactly one plan per session.
- Writing raw provider errors/headers to `fallback.log` — always go through `log.ts` scrubbing.
- Treating a billing error as transient — retrying the same account never recovers it.

## NOTES

- Tests: `test/suite/retry-fallback-*.test.ts` (20 files) — engine, chains, expansion eligibility, cooldown, hint tiers, probe scheduler, billing swap, revert, validate, log.
- `streamRetryTimeoutMs` reconciles to `max(cap, streamStartTimeoutMs)` so a granted stream-start budget is never cut short; `0` disables.
