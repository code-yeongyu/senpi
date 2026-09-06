# packages/ai/test

Generated: 2026-08-24. Commit `baf15a54d`.

Flat Vitest suite for the whole `pi-ai` package: 228 top-level `.ts` files, ~53k LOC, plus `tool-call-middleware/` (own AGENTS.md), `fixtures/` (catalog JSON), `data/red-circle.png`. Earns its own file on size and on gating/harness conventions that exist nowhere in `src/`.

## LAYOUT

No mirroring of `src/` structure. Filenames encode provider + behavior: `anthropic-*`, `bedrock-*`, `openai-completions-*`, `openai-codex-*`, `azure-openai-*`, `mistral-*`, `cursor-agent*`. Cross-cutting suites are named by concern: `stream`, `models-runtime`, `retry`, `retry-hint`, `total-tokens`, `context-overflow`, `cache-retention`, `empty`, `unicode-surrogate`, `cross-provider-handoff`.

## SHARED HELPERS (non-`.test.ts` modules)

| File | Exports |
|---|---|
| `live-api-gates.ts` | `isLiveApiTestEnabled`, `isOAuthLiveApiTestEnabled`, `isOllamaLiveTestAvailable`, `getLiveEnvApiKey` + the `PI_ENABLE_*` flag constants |
| `oauth.ts` | `resolveApiKey(provider)` — reads/refreshes `~/.pi/agent/auth.json`; writes refreshed tokens back |
| `azure-utils.ts` | `hasAzureOpenAICredentials`, `resolveAzureDeploymentName` |
| `bedrock-utils.ts` / `cloudflare-utils.ts` | `hasBedrockCredentials`, `hasCloudflareWorkersAICredentials`, `hasCloudflareAiGatewayCredentials` |
| `cursor-agent-exec-lifecycle-harness.ts` + `.cases.ts` | HTTP/2 + protobuf frame harness; `registerCursorExecLifecycleTests()` |
| `model-switch-replay-fixtures.ts` | `HISTORY`, `APPLY_PATCH_TOOL`, `makePatchHistory`, `makeModel` — shared by both model-switch replay tests |
| `scratch.ts`, `codex-websocket-cached-probe.ts` | Manual probes, NOT Vitest entries; run via `node test/<file>.ts` |

## LIVE-TEST GATING

- Every network-touching case is opt-in. `PI_ENABLE_LIVE_API_TESTS=1` enables all; per-provider flags (`PI_ENABLE_LOCAL_LLM`, `PI_ENABLE_OPENROUTER_LIVE`, `PI_ENABLE_BASETEN_LIVE`, `PI_ENABLE_QWEN_TOKEN_PLAN_LIVE`, `PI_ENABLE_ANTHROPIC_OAUTH_LIVE`, `PI_ENABLE_GITHUB_COPILOT_LIVE`, `PI_ENABLE_OPENAI_CODEX_LIVE`) enable one.
- Gate through `live-api-gates.ts` (15 suites do), not raw `process.env` reads. Ollama availability is probed by `which ollama`, never assumed.
- Credential-only presence checks belong in the `*-utils.ts` helpers so setup is not duplicated per suite.

## CONVENTIONS

- Relative imports into source carry the explicit `.ts` extension (`from "../src/compat.ts"`), matching the package's NodeNext build.
- Offline default: fake `fetch`, local Node HTTP/HTTP2 servers, or `src/providers/faux.ts` (12 suites). Assertions target serialized wire payloads, headers, event order, stop reasons, and usage — not implementation names.
- `vitest.config.ts` sets `globals: true`, node env, 30s `testTimeout`, dot reporter, `silent: "passed-only"`, and aliases `@earendil-works/pi-telemetry` to `../telemetry/src/index.ts`. Suites still import `describe`/`it`/`expect` explicitly.
- Env mutation and temp credential stores are isolated per suite via `beforeEach`/`afterEach`; faux-provider registrations keep their unregister handle and are cleaned up.
- Large fixtures live in `fixtures/*.json` (dated catalog snapshots) — characterization tests, refresh them deliberately.

## ANTI-PATTERNS

- Never make a live provider call part of default success. Ungated network access breaks CI and every offline dev loop.
- Never assert on timing/sleep in stream or protocol tests — await the captured event or frame predicate. OAuth expiry tests use fake timers.
- Never let secret values reach assertions; credential tests assert metadata shape only.
- Do not mutate caller-owned tool/schema objects in normalization tests; the suite asserts source objects survive untouched.
- Do not leak faux-provider or model registrations across tests; superseded providers must not publish late.

## COMMANDS

```bash
bun run --cwd packages/ai test                          # vitest --run, whole package
bun run --cwd packages/ai test test/stream.test.ts   # one file
bun run --cwd packages/ai test test/anthropic-       # provider group by prefix
PI_ENABLE_LIVE_API_TESTS=1 bun run --cwd packages/ai test   # opt into live suites
```

## HOTSPOTS

`openai-codex-stream.test.ts` (2850), `openai-completions-tool-choice.test.ts` (1969), `stream.test.ts` (1802, multi-provider matrix + local Ollama process), `models-runtime.test.ts` (1193, provider/auth/refresh/cancel runtime), `total-tokens.test.ts` (912), `unicode-surrogate.test.ts` (866), `empty.test.ts` (861), `anthropic-provider-native-replay.test.ts` (832). Touch shared conventions here first.
