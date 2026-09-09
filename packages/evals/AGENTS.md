# packages/evals

`@code-yeongyu/senpi-evals` — behavioral, model-backed eval suites over a real
`AgentSession`, adapted to `vitest-evals`. Earned by distinct domain: the only
token-spending eval surface in the repo.

## WHERE TO LOOK

| Task | Path |
| --- | --- |
| Pi harness adapter | `src/pi-harness.ts` (`createPiCodingAgentHarness`) |
| Eval suites | `src/smoke.eval.ts`, `src/extensions.eval.ts` |
| Comparative tables, reporting | `src/vitest-evals/harness-table.ts`, `summary.ts`, `reporter.ts` |
| Artifact recording | `src/vitest-evals/artifacts.ts` |
| Runner | `scripts/run-evals.mjs` |
| Unit tests (no tokens) | `test/` via `bun run test` |

## CONVENTIONS

- One harness bound to each `describeEval(...)` suite; harness names stay
  stable and unique within an eval set (grouping combines repetition with
  `input.id` or a SHA-256 of canonical JSON input).
- Runs accept one prompt or prompt/reload step sequences; `output` transforms
  response + session into JSON-safe domain results; assert behavior on
  `result.output` and traces on `result.session`.
- Comparative suites use `evalHarnessTable(...)` + `describe.for(...)` with
  deterministic or model-backed judges and `judgeThreshold: null` — low scores
  are observations, not failures. Hard assertions only for suite invariants;
  `expect.soft` is not a scoring mechanism.
- The harness snapshots native session JSONL before deleting its temp
  workspace; an eval-only `afterEach` registers it against the test task.
- Evals run against workspace source via vitest alias config, not built
  artifacts.
- Each invocation writes an ignored `.eval/<timestamp>_<uuid>/` dir: `runs.jsonl`
  indexing harness runs plus `sessions/` JSONL attachments. Artifacts may
  contain prompts, responses, source, and tool output — treat as sensitive.

## COMMANDS

```bash
bun run eval --provider openai --model gpt-5.6-sol   # provider+model together, or none
PI_PROVIDER=openai PI_MODEL=gpt-5.6-sol bun run eval    # env equivalent
bun run eval src/extensions.eval.ts                  # forwards file filters to Vitest
bun run eval -t "<pattern>"                          # forwards -t filters
bun run test                                                # unit tests, config vitest.test.config.ts
```

`PI_EVAL_ARTIFACT_DIR` overrides the artifact directory.
