# Mock loop (Channel 3)

Run a REAL agent turn with a scripted model — deterministic, zero tokens. Two
flavors:

## A. End-to-end via the real CLI (default — `mock-loop.mjs`)

1. `scripts/lib/fake-model-server.mjs` starts a local OpenAI-compatible server.
   senpi's `openai-completions` provider uses the official `openai` SDK with
   `baseURL: model.baseUrl`, so it POSTs to `<baseUrl>/chat/completions` with
   `Authorization: Bearer <apiKey>`. The server scripts assistant turns (text
   and/or tool calls) as SSE and records every request.
2. An isolated `models.json` (written into the sandbox `SENPI_CODING_AGENT_DIR`)
   registers the server as a custom provider:

```json
{
  "providers": {
    "mock": {
      "baseUrl": "http://127.0.0.1:<port>/v1",
      "apiKey": "sk-mock-qa-7f3a",
      "api": "openai-completions",
      "models": [
        { "id": "mock-model", "baseUrl": "http://127.0.0.1:<port>/v1",
          "api": "openai-completions", "contextWindow": 128000, "maxTokens": 4096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
      ]
    }
  }
}
```

   Schema: `ProviderConfigSchema` / `ModelDefinitionSchema` in
   `packages/coding-agent/src/core/model-registry.ts`.
3. The CLI runs `--print --provider <p> --model <m>` (or via RPC). The reply
   contains a marker only the fake server emits, and the request carries the
   mock key against localhost — so a pass proves the live binary talked to OUR
   server and never a real provider.

### baseUrl override for OpenAI and Anthropic (`--api`)

The fake server speaks all three wire formats senpi uses, selected by request
path, so `baseUrl` override is exercised for both vendors:

| `--api` | provider overridden | model `api` | request path · auth |
|---|---|---|---|
| `openai-completions` (default) | `mock` | `openai-completions` | `<baseUrl>/v1/chat/completions` · `Authorization: Bearer` |
| `anthropic-messages` | `anthropic` | `anthropic-messages` | `<baseUrl>/v1/messages` · `x-api-key` |
| `openai-responses` | `openai` | `openai-responses` | `<baseUrl>/responses` · `Authorization: Bearer` |

For `anthropic`/`openai`, the override sets `providers.<name>.baseUrl` on the
built-in provider plus a custom model, so it literally proves "point the real
anthropic/openai provider at another host." The Anthropic SDK appends
`/v1/messages` (so baseUrl is the origin, no `/v1`); the OpenAI SDKs append
`/chat/completions` or `/responses` to a `/v1` baseUrl.

The loop is **hermetic**: `mock-loop.mjs` strips provider-key env vars
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) from the sandbox so the inline
`models.json` key is the only credential — otherwise a real ambient key would
take precedence for built-in providers and reach even the localhost fake.

`--with-tool` scripts two turns (model → `bash` tool call → final text) to prove
the full loop iterates. It passes `--approve` for project trust.

`--with-mcp-tool <tool> --tool-args '<json object>'` uses the same two-turn
loop but requires a fixture MCP-style tool name such as `mcp_fx_tool_1`. The
script generates a sandbox extension that registers the requested
`mcp_fx_tool_<n>` as a proxy to the local MCP stdio fixture's `tool_<n>`, then
asserts both that the proxy wrote its fixture call log and that the model's
second request contains the fixture result text.

```bash
node .agents/skills/senpi-qa/scripts/mock-loop.mjs \
  --with-mcp-tool mcp_fx_tool_1 \
  --tool-args '{"value":"ok","mode":"alpha"}'
```

This proves the model can request a registered MCP fixture tool through the
live agent-loop surface. Non-`mcp_*` names and names outside the
`mcp_fx_tool_<n>` fixture family fail before the CLI run; missing registration
or a tool-not-found fallback fails because no fixture call log/result appears.
With `--evidence <slug>`, the script writes sanitized model requests and
`mcp-fixture-calls.jsonl` under `local-ignore/qa-evidence/<date>-<slug>/`.

## B. In-process faux provider (for vitest-style assertions)

For unit/integration assertions without spawning the CLI, use the faux provider
directly (`packages/ai/src/providers/faux.ts` +
`packages/coding-agent/test/suite/harness.ts`):

```ts
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
const harness = await createHarness({ api: "faux", provider: "faux", models: [{ id: "small", contextWindow: 32000 }] });
harness.setResponses([fauxAssistantMessage("Hello!")]);
await harness.session.prompt("hi");
// assert on harness events / getAssistantTexts(harness)
harness.cleanup();
```

Use flavor A to QA the real binary end to end; flavor B for fast, in-process
contract tests in the coding-agent suite.

## Why this matters

`npm test` proves unit contracts; it does not prove the agent still completes a
turn against a provider. The mock loop is that proof, at zero cost, and is the
recommended default check for any agent-loop / tool / provider change.
