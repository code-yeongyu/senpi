# packages/ai/src/utils

Generated: 2026-09-10. Commit `2d0fa41c5`.

Cross-provider behavior choke points: retry classification, prompt-cache compatibility, overflow detection, tool-schema normalization, stream primitives. 42 TS files, ~4.4k LOC including `retry-profile/`. No top-level barrel; `retry-profile/index.ts` is a deliberate nested barrel. Score 12: shared behavior with measured cross-module stream consumers.

## FILE MAP

```text
retry.ts                 Assistant/transient retry policy; NON_RETRYABLE_PROVIDER_ERROR_PATTERN is the allowlist-by-exclusion of permanent failures
provider-retry.ts        HTTP-status/header-driven provider backoff (Retry-After parsing)
retry-hint.ts            Retry-after marker encode/decode carried through error messages
retry-profile/           Typed two-stage retry policy, failure normalization, classifiers, planner; own AGENTS.md
prompt-cache-ttl.ts      Per-provider cache TTL + capability matrix (getAnthropicCompat, getOpenAICompletionsCompat)
overflow.ts              Context-overflow / recoverable-length error patterns per provider
tool-schema-compat.ts    JSON-schema normalization for OpenAI-compat and Moonshot
tool-pair-repair.ts      Orphaned tool_result repair
drop-failed-assistant-turns.ts Removes failed assistant turns before replay
tool-call-id.ts          Tool-call id shaping
tool-choice-fallback.ts  Tool-choice degradation when a provider rejects the requested mode
deferred-tools.ts        splitDeferredTools
event-stream.ts          EventStream<T,R> — the async-iteration primitive behind every provider stream
json-parse.ts            repairJson / parseJsonWithRepair / parseStreamingJson
provider-env.ts          getProviderEnvValue — the only sanctioned ProviderEnv read
node-http-proxy.ts       Proxy URL resolution from env (no Node imports; pure URL logic)
openai-codex-auth.ts     Codex auth helpers shared by api/ and auth/
error-body.ts, stop-details.ts, estimate.ts, diagnostics.ts, validation.ts,
sanitize-unicode.ts, visible-text.ts, text.ts, block-symbols.ts, headers.ts,
hash.ts, uuid.ts, abort.ts, abort-signals.ts, pi-user-agent.ts,
server-fallback-receipt.ts, typebox-helpers.ts, unavailable-tool-text.ts
```

## CONVENTIONS

- Browser-safe by default. `node-http-proxy.ts` resolves proxies from `ProviderEnv` values only; it does not import `node:*`. Anything needing Node goes through an injected boundary in `../auth/` instead.
- Provider quirks are encoded as explicit named patterns/constants with a comment naming the provider and the observed error text (see `retry.ts`, `overflow.ts`). Do not add a bare regex without the wire evidence that motivated it.
- Compatibility detection is layered: provider id / base URL / model id heuristic first, then explicit per-model `compat` overrides win.
- `tool-schema-compat.ts` deliberately strips JSON-schema `deprecated` annotations during normalization — providers reject the keyword.
- The legacy `retry.ts` message classifier is exclusion-based; permanent-failure patterns affect every caller. Typed profile classifiers in `retry-profile/` use a separate structured failure contract, not a blanket retry-everything rule.

## WHERE TO LOOK

| Task | File |
|---|---|
| A transient failure is being treated as permanent (or vice versa) | `retry.ts` message patterns or `retry-profile/classifiers.ts` typed failures |
| Provider-request versus turn retry budget | `retry-profile/profiles.ts`; stage planning in `retry-profile/planner.ts` |
| Provider returns 429 with a Retry-After we ignore | `provider-retry.ts`, `retry-hint.ts` |
| Cache TTL / cache-write accounting wrong for a model | `prompt-cache-ttl.ts` |
| "Context length exceeded" not detected for a new provider | `overflow.ts` |
| Provider rejects a tool schema | `tool-schema-compat.ts` |
| Stream backpressure / iteration semantics | `event-stream.ts` (also the `bench/event-stream.ts` fixture) |

## ANTI-PATTERNS

- Adding a top-level runtime `node:*` import here — these modules are reachable from the browser-safe package root.
- Duplicating a provider quirk in an adapter under `../api/` when it belongs in the shared matrix here.
- Widening a retry pattern to "fix" one provider without checking the other providers that share the classifier.
