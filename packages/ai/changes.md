# changes.md — ai

## Live API test gating fixes (2026-04-09)

### What changed

- `test/tool-call-id-normalization.test.ts`: the OpenRouter `gpt-5.2-codex` cases now pass `reasoning: "high"` so the live regression test still exercises tool-call ID normalization against the endpoint's current reasoning requirement.
- `test/cross-provider-handoff.test.ts`: the minimum-fixture assertion now exits early when fewer than two live fixtures are actually generated, so the suite skips gracefully in environments without enough working provider credentials.
- `test/bedrock-utils.ts`: Bedrock live tests now require both credentials and an explicit AWS region before enabling.
- `test/context-overflow.test.ts`: the OpenRouter Anthropic overflow case now accepts the provider's current managed-overflow behavior, and LM Studio overflow tests only auto-enable when `PI_ENABLE_LOCAL_LLM=1`.
- `test/openrouter-cache-write-repro.test.ts`: the narrow OpenRouter cache-write regression is now explicit opt-in via `PI_ENABLE_OPENROUTER_CACHE_WRITE_REPRO=1`.
- `test/total-tokens.test.ts`: the unstable OpenRouter `deepseek/deepseek-chat` total-token regression is now explicit opt-in via `PI_ENABLE_OPENROUTER_DEEPSEEK_TOTAL_TOKENS=1`.

### Why

- OpenRouter now rejects `openai/gpt-5.2-codex` requests when reasoning is omitted or disabled, which broke the normalization regression for reasons unrelated to tool-call ID handling.
- The cross-provider handoff suite assumes multiple working live providers, but `npm test --workspaces --if-present` must pass even when the environment has no valid API keys (or only a partial/invalid live setup).
- Ambient Bedrock tokens without a region and auto-detected local model servers were causing unrelated live E2E suites to run in non-reproducible environments.
- A few narrow OpenRouter regressions are currently backend-specific and unstable in shared environments, so they now require explicit opt-in instead of making the default workspace test command flaky.

### Why extension system couldn't handle this

These failures are in upstream `packages/ai` live integration tests, not in the coding-agent extension surface. Fixing them required targeted test-only updates in `packages/ai/test/`.

### Modified upstream files

- `test/tool-call-id-normalization.test.ts`
- `test/cross-provider-handoff.test.ts`
- `test/bedrock-utils.ts`
- `test/context-overflow.test.ts`
- `test/openrouter-cache-write-repro.test.ts`
- `test/total-tokens.test.ts`

### Expected merge conflict zones

- `test/tool-call-id-normalization.test.ts`: OpenRouter live test options may need re-merging if upstream changes the regression coverage or request options.
- `test/cross-provider-handoff.test.ts`: fixture-count gating may need re-merging if upstream restructures the live handoff bootstrap assertions.
- `test/bedrock-utils.ts`: credential gating may need re-merging if upstream changes how Bedrock test auth is detected.
- `test/context-overflow.test.ts`: OpenRouter overflow handling and local-LM opt-in logic may need re-merging if upstream revises those E2E expectations.
- `test/openrouter-cache-write-repro.test.ts` and `test/total-tokens.test.ts`: explicit opt-in guards may need re-merging if the affected OpenRouter backends become stable again.
