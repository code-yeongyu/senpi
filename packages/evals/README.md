# senpi evals

Behavioral, model-backed evals for the senpi coding agent, built with `vitest-evals`. They run a real `AgentSession`
in isolated project and agent directories, attach native session artifacts, and spend tokens by design.

## File conventions

Eval definitions are flat under `evals/`:

- `*.docs.eval.ts` is a documentation-lift eval. `eval:docs` runs each case in isolated `without_docs` and `with_docs`
  containers and reports lift.
- Other `*.eval.ts` files are host evals, including the fork's smoke and extension suites. They run with Vitest on this
  machine as ordinary vitest-evals suites; suites declared with `evalHarnessTable(...)` also produce a
  baseline-versus-candidate comparison report.

Runner code lives in `src/`:

- `cli.ts` orchestrates a documentation comparison
- `docker.ts` builds the two images, discovers cases, and runs one isolated arm
- `plan.ts` expands cases into `(case, variant, repetition)` tasks
- `report.ts` reads Vitest JSON, pairs arms, and computes lift
- `harness.ts` is the vitest-evals adapter
- `vitest-evals/` holds the fork's host-eval harness table, reporter, artifact setup, and summary

Eval suites and their fixtures live under `evals/`. Image build files live in `docker/`.

## Run host evals

Run from the repository root with a default provider and model:

```bash
bun run eval:host --provider chatgpt-subscription --model gpt-6.1-sol
```

The equivalent environment variables are:

```bash
PI_PROVIDER=chatgpt-subscription PI_MODEL=gpt-6.1-sol bun run eval:host
```

`bun run eval` runs the host evals and then the documentation comparison.

CLI values take precedence and become defaults for harnesses that do not select a model explicitly. Provider and model
must be supplied together. Authentication comes from senpi's normal `ModelRuntime`, including subscription credentials
and provider API-key environment variables.

Additional arguments are forwarded to Vitest:

```bash
bun run eval:host evals/extensions.eval.ts
bun run eval:host -t "creates and uses the extension"
```

`--repetitions` applies to suites declared with `evalHarnessTable(...)`; an explicit `repetitions` value in a suite
overrides it, and `PI_EVAL_REPETITIONS=5` is equivalent. Use one repetition while developing an eval and five when
reporting lift.

## Run documentation comparisons

```bash
bun run eval:docs \
  --provider chatgpt-subscription \
  --model gpt-6.1-sol
```

`PI_PROVIDER` and `PI_MODEL` provide the same defaults. Both values are required. The default is one run per variant;
pass `--runs-per-variant 5` (or `PI_EVAL_RUNS_PER_VARIANT=5`) when measuring stability.

The runner:

1. Packs the current workspace packages and creates separate `without_docs` and `with_docs` images from the staged
   runtime.
2. Discovers the selected cases in both images and requires identical cohorts.
3. Plans every `(case, variant, model, runNumber)` arm before execution.
4. Runs each arm in a fresh container. A failed or missing arm is recorded and the planned cohort continues.
5. Pairs exact arms and writes the comparison report. Blocked pairs withhold headline lift; the process exits nonzero.

`without_docs` omits the coding-agent `README.md`, `CHANGELOG.md`, `docs/`, and `examples/`, and removes the
documentation-routing section from the default system prompt. `with_docs` keeps them. Documentation evals allow only
`read`, `write`, `edit`, `grep`, `find`, and `ls` by default.

## Reports and artifacts

Each invocation writes an ignored `.eval/` directory. Host evals record `report.txt`, `report.json`, `runs.jsonl`,
`sessions/` (native session JSONL) and `sources/`. Documentation comparisons record `protocol.json`,
`expected-runs.json`, `observations.jsonl`, per-arm `tasks/*/vitest.json`, per-variant sessions, and the paired
`report.json` and `report.txt`.

A pair contributes to pass-rate lift only when both arms produce exactly one score; missing telemetry stays unavailable
rather than being treated as zero. Artifacts may contain prompts, responses, generated code, and tool output, so treat
them as sensitive.

## Write an eval

Use one ordinary `describeEval(...)` suite and one explicit `run(...)` call per case. Comparative suites record
correctness with deterministic or model-backed judges and set `judgeThreshold: null`, so a low score is data rather than
an infrastructure failure. Reserve Vitest assertions for broken suite invariants; `expect.soft(...)` still fails the test
and is not a scoring mechanism.

Use `evalHarnessTable(...)` from `src/vitest-evals/harness-table.ts` with Vitest's `describe.for(...)` to run the same
inputs against a baseline and one or more candidate harnesses. Harness names must be stable and unique within an eval
set; each candidate is compared only with the declared baseline.

See the [`vitest-evals`](https://github.com/getsentry/vitest-evals) guidance for suites, judges and traces, and
[`skill-eval-harness`](https://github.com/adewale/skill-eval-harness/) for comparative-eval methodology.
