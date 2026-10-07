# packages/evals

`@code-yeongyu/senpi-evals`: behavioral, model-backed eval suites over a real
`AgentSession`, adapted to `vitest-evals`. Earned by distinct domain: the only
token-spending eval surface in the repo.

## WHERE TO LOOK

| Task | Path |
| --- | --- |
| Harness adapter | `src/harness.ts` (`createPiCodingAgentHarness`, `createPiDocumentationEvalHarness`) |
| Eval suites | `evals/*.eval.ts` (host), `evals/*.docs.eval.ts` (documentation lift) |
| Host comparative tables, reporting | `src/vitest-evals/harness-table.ts`, `summary.ts`, `reporter.ts` |
| Host artifact recording | `src/vitest-evals/artifacts.ts`, registered by `src/vitest-evals/setup.ts` |
| Documentation-lift runner | `src/cli.ts`, `src/docker.ts`, `src/plan.ts`, `src/report.ts`, `docker/` |
| Host runner | `scripts/run-evals.mjs` (Vitest project `host` of `vitest.evals.config.ts`) |
| Unit tests (no tokens) | `test/` via `bun run test` |

## CONVENTIONS

- One harness bound to each `describeEval(...)` suite; harness names stay
  stable and unique within an eval set (grouping combines repetition with
  `input.id` or a SHA-256 of canonical JSON input).
- Runs accept one prompt or prompt/reload step sequences; `output` transforms
  response + session into JSON-safe domain results; assert behavior on
  `result.output` and traces on `result.session`.
- Host comparative suites use `evalHarnessTable(...)` + `describe.for(...)` with
  deterministic or model-backed judges and `judgeThreshold: null`; low scores
  are observations, not failures. Hard assertions only for suite invariants;
  `expect.soft` is not a scoring mechanism.
- `*.docs.eval.ts` suites run only inside the `without_docs`/`with_docs`
  containers built by `eval:docs`; the runner owns variants and repetitions.
- The harness snapshots native session JSONL before deleting its temp
  workspace; on host runs an eval-only `afterEach` registers it against the
  test task.
- The harness isolates `HOME`, `SENPI_`/`PI_CODING_AGENT_DIR`, and hides
  `SENPI_`/`PI_` eval metadata plus host model and session routing for the
  duration of each run.
- Host evals run against workspace source via vitest alias config, not built
  artifacts.
- Each host invocation writes an ignored `.eval/<timestamp>_<uuid>/` dir:
  `runs.jsonl` indexing harness runs plus `sessions/` JSONL attachments. Artifacts
  may contain prompts, responses, source, and tool output, so treat them as sensitive.

## COMMANDS

```bash
bun run eval:host --provider chatgpt-subscription --model gpt-6.1-sol   # host evals; provider+model together, or none
PI_PROVIDER=chatgpt-subscription PI_MODEL=gpt-6.1-sol bun run eval:host  # env equivalent
bun run eval:host evals/extensions.eval.ts                # forwards file filters to Vitest
bun run eval:host -t "<pattern>"                          # forwards -t filters
PI_PROVIDER=chatgpt-subscription PI_MODEL=gpt-6.1-sol bun run eval       # host evals, then the documentation comparison
bun run eval:docs --provider chatgpt-subscription --model gpt-6.1-sol   # documentation comparison only (Docker)
bun run test                                               # unit tests, config vitest.test.config.ts
```

`PI_EVAL_ARTIFACT_DIR` overrides the host artifact directory.
