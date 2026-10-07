# Integration Tests

This directory contains API-key-gated integration tests that make real LLM calls.

## Running

```bash
# Run all integration tests
PI_RUN_INTEGRATION=1 bunx vitest run test/integration/

# Run a specific suite
PI_RUN_INTEGRATION=1 bunx vitest run test/integration/compaction-real-api.test.ts
```

## Gating

All suites use `describe.skipIf(!process.env.PI_RUN_INTEGRATION)` so they are skipped in CI and normal test runs. Set `PI_RUN_INTEGRATION=1` to enable them.

## Requirements

- `ANTHROPIC_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` for Anthropic tests
- Valid auth for `google-antigravity` provider for thinking-model tests

## Cost & Time

Each test makes 1-3 real LLM calls. Typical runtime: 60-180s per test.
