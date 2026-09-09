# Issue 1410 recovery QA receipt

Date: 2026-09-06
Worktree commit under test: `c693f9cc8`
Issue: https://github.com/code-yeongyu/senpi/issues/1410
PR: https://github.com/code-yeongyu/senpi/pull/1411

## Focused regression surface

Execution host: disposable ASCII Box `bx_d3y5e2za` (`small`, 2 vCPU, 4 GB,
Bun 1.3.14). The local `mengmotaHost` was not used for tests.

Exact invocation:

```sh
cd /home/user/issue-1410
bun test \
  packages/coding-agent/test/suite/retry-fallback-engine.test.ts \
  packages/coding-agent/test/suite/model-usability-budget.test.ts \
  packages/coding-agent/test/compaction/required-compaction-deterministic-fallback.test.ts
```

Observed result:

```text
54 pass
0 fail
Ran 54 tests across 3 files.
```

The targeted mutation replaced the production guard
`if (error instanceof ModelUsabilityBudgetError)` with
`if (false && error instanceof ModelUsabilityBudgetError)`. The same focused
test then failed through the real `ModelUsabilityBudgetError` path while trying
to switch to `faux/faux-2`, proving the assertion is sensitive to the guard.
The guard was restored before the passing run.

## Real recovery surface

Exact invocation:

```sh
SENPI_CODING_AGENT_DIR=$(mktemp -d) \
  bun run packages/coding-agent/test/manual-qa/refusal-unpin-compaction-qa.mjs
```

Observed result:

```text
primary -> fallback (refusal, pinned) -> compaction -> primary
{
  "modelCalls": [
    "faux-1",
    "faux-2"
  ],
  "compaction": {
    "applied": true,
    "reason": "ok"
  },
  "logEvents": [
    "refusal_pin_released",
    "fallback_reverted"
  ]
}
EXIT=0
```

Binary pass condition: the original `faux-1` model is restored after
compaction, and the release event precedes the fallback-revert event.

## Cleanup receipt

The temporary `SENPI_CODING_AGENT_DIR`, focused test logs, and manual-QA log
were removed on the ASCII Box. The Box was stopped after verification; no
test process or QA server remained. No desktop application release was
performed.
