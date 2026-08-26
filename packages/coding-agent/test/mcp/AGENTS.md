# test/mcp

MCP transport, lifecycle, OAuth, exposure, and configuration coverage plus the fixture servers/workers that back it. 48 top-level files + `fixtures/` (15 modules, 2 schema JSON). Score 16 — the only test subtree that ships its own runnable MCP servers and fault-injection harness.

## STRUCTURE

```text
*.test.ts              config, transport/connection, lifecycle (startup-race, reconnect,
                       idle, expiry), oauth-{headless,callback,provider,race,token-store},
                       exposure-tierb / tool-search activation, resources/prompts/
                       elicitation, logging/security, recovery
fixtures/              runnable servers + shared attach/lifecycle helpers
fixtures/schema/       nasty-input.schema.json + nasty-input.typebox.golden.json
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Attach a capturing extension to the MCP service | `fixtures/register-call.ts` — `attach`, `mcpExtensionFor`, `capturingPi`, `awaitMcpToolRegistration`, `awaitMcpPromptRegistration`, `withoutMcpUtilityTools` |
| Roots/config/process lifecycle | `fixtures/service-lifecycle.ts` — `makeRoot`, `setConfig`, `stdioServer`, `waitForCondition`, `assertAlive`, `cleanupRoots` |
| Spin up a fixture MCP server | `fixtures/sdk-server.ts` (`createFixtureServer`), `fixtures/stdio-server.ts`, `fixtures/http-server.ts` |
| Fault injection flags | `fixtures/options.ts` — `parseFixtureOptions`, `maybeWedge`, `delaySlowStart` |
| OAuth IDP | `fixtures/oauth-idp.ts`, `fixtures/oauth-idp-core.ts` (`pkceS256`, `parseIdpOptions`), `fixtures/spawn-idp.ts` |
| Cross-process workers | `fixtures/token-store-worker.ts`, `fixtures/oauth-race-worker.ts` |
| Provider-native search mocks | `fixtures/native-search-mocks.ts` (`buildAnthropicSse`, `buildOpenAiResponseEvents`) |

## CONVENTIONS

- Every test creates an isolated temporary root/config and resets the singleton MCP service between cases (`getMcpService` / `resetMcpServiceForTests`). Skipping the reset leaks connections into the next file.
- Fixture servers expose capabilities deliberately (tools, resources, prompts, logging, list-changed, subscriptions) and take argv flags for crashes, wedges, delays, expiry, counters, bearer tokens, huge output/schema, and list changes. Add new failure modes as flags in `fixtures/options.ts`, not as new servers.
- Async waits go through named helpers (`waitForCondition`, `awaitMcpToolRegistration`, service/session attach helpers) — never inline timers.
- The harness does **not** emit `session_start` automatically; attach and await the lifecycle signal before asserting.
- Test names/comments carry numbered TODO tracks (todo 27, 29-42); coverage is split one file per concern.
- JSON schema fixtures live beside their golden typebox output; regenerate both together.

## ANTI-PATTERNS

- Never log raw OAuth tokens — fingerprints only.
- Never combine Anthropic `defer_loading` with `cache_control`.
- Proxy exposure must never be auto-selected; the `tool_search` tool must not re-enter requests; unknown/unregistered tools are never eligible.
- Do not contact OAuth discovery when headers are configured.
- `fixtures/native-search-mocks.ts` fabricates API responses and never touches a real API — preserve that isolation.
- `never` casts at mocked SDK/extension boundaries are a harness accommodation here; do not copy them into production code.

## COMMANDS

```bash
npm --prefix packages/coding-agent test -- --run test/mcp/<file>.test.ts
CI=1 npm --prefix packages/coding-agent test -- --run test/mcp   # subprocess-heavy: one fork
```
