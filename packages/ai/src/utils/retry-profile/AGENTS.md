# packages/ai/src/utils/retry-profile

Generated: 2026-09-10. Commit `2d0fa41c5`.

## OVERVIEW

Typed retry profiles separate provider-request and whole-turn policy without owning execution. Score 8: exported module boundary with its own failure, classifier, and planner contracts.

## WHERE TO LOOK

| Task | File |
|---|---|
| Public profile types and stage policies | `types.ts`, re-exported by `index.ts` |
| Builtin budgets, hint ceilings, jitter modes | `profiles.ts` |
| Normalize Anthropic SDK/SSE failures | `failure.ts` |
| Classify normalized Kimi or default failures | `classifiers.ts` |
| Compute exponential delay with supplied randomness | `backoff.ts` |
| Combine backoff with server hints | `planner.ts` |

## CONVENTIONS

- `SENPI_DEFAULT_RETRY_PROFILE` declares separate request and turn stages; changes to one stage must not implicitly widen the other.
- `KIMI_CODE_RETRY_PROFILE` disables the request stage so callers cannot stack a second hidden retry budget on its turn retries.
- The planner consumes a supplied random number; execution, timers, and retry loops belong to callers.
- Positive override hints replace computed delay even when shorter. Zero is accepted only by stages with `acceptZero`.
- A hint strictly above a finite ceiling returns `over-ceiling`; it is not clamped. A null ceiling permits any positive hint.
- Tiered planning returns the `delegated` sentinel. Actual tier decisions remain in coding-agent's `core/retry-fallback/hint-policy.ts`; the default strategy requires caller injection.
- Anthropic normalization retains declared facts, not raw response bodies/headers; messages are capped at 500 characters.
- SDK timeout/connection errors are identified by constructor name, timeout first, rather than eager imports of SDK error classes.

## ANTI-PATTERNS

- Importing coding-agent to implement the tier strategy here; that reverses the package dependency.
- Turning `over-ceiling` into a shorter sleep and silently ignoring a server-requested wait.
- Retaining credentials or raw headers/body objects on `RetryFailure`.
- Replacing additive Kimi jitter with the default request-stage subtractive policy.

## VALIDATION

- `packages/ai/test/retry-profile-{backoff,classifiers,failure,planner,profiles}.test.ts` covers this domain.
- Use explicit random inputs and assert planner result kinds, hint semantics, and separate stage budgets.
