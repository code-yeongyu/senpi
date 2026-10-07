# Provider error presentation fixture

Run from the repository root with Bun 1.4.2:

```sh
bun .agents/skills/senpi-qa/scripts/scenarios/provider-error-tui-qa.mjs retry-recovery
```

The driver launches the real source CLI in an isolated agent/session sandbox.
Its preload injects synthetic events into the CLI's actual `InteractiveMode`;
it does not instantiate a standalone renderer. The fixture consumes terminal
input, uses a dummy local-only model configuration, and never calls a provider.
It tests presentation, not HTTP retry policy.

Wait for `FIXTURE_READY`, then press `n` to advance. A phase remains visible
until the next input; there are no startup sleeps. Press `q` to exit and remove
the owned sandbox. The retry countdown is a synthetic 60-second event value,
not a scheduled provider request.

| Argument | First `n` | Second `n` | Third `n` | Fourth `n` |
| --- | --- | --- | --- | --- |
| `retry-recovery` | 17 failures, one status, partial answer | Recovery | Expand details | Expand details |
| `exhausted` | 17 failures | One final notice | Expand details | Expand details |
| `cancelled` | 17 failures | Cancellation, no final error | Expand details | Expand details |
| `replay` | 17 failures | Rebuild persisted-style history | Expand details | Expand details |
| `separate-turns` | First turn failures | First turn exhausted | Second turn exhausted | Expand details |

Run each scenario in a real PTY at 100 columns by 30 rows and at 50 by 24.
The lead captures those PTYs through xterm.js. Check that partial text remains,
retry attempt/delay is visible, successful recovery clears the status, exhaustion
shows one actionable notice per turn, and expanded details contain each distinct
provider payload once per incident. Replayed history must retain the same content.

The driver also has a bounded, event-driven CLI smoke check:

```sh
for scenario in retry-recovery exhausted cancelled replay separate-turns; do
  bun .agents/skills/senpi-qa/scripts/scenarios/provider-error-tui-qa.mjs --self-test "$scenario"
done
```

The smoke check reports readiness, phase count, exit code, and terminal output
bytes. It is not a screenshot acceptance test. `FIXTURE_CLEANUP` records teardown.
The unit regression seam is:

```sh
cd packages/coding-agent
bun x vitest run test/suite/provider-error-presentation.test.ts
```
