# Issue 1410 follow-up QA receipt

Date: 2026-09-06
Commit under test: `cef5ee939`

## RED

On the pre-fix `d66350b34` tree, the exact command below failed for the
refusal, rate-limit, and hard-error cases. Refusal and rate-limit leaked
`ModelUsabilityBudgetError`; hard-error persisted a `model_change` for the
rejected model.

```sh
bun test packages/coding-agent/test/suite/retry-fallback-admission.test.ts
```

Result: `0 pass, 3 fail`, with the failure at the fallback admission boundary.

## GREEN

On the final tree, the ASCII Box command was:

```sh
bun test \
  packages/coding-agent/test/suite/retry-fallback-admission.test.ts \
  packages/coding-agent/test/suite/retry-fallback-engine.test.ts \
  packages/coding-agent/test/suite/model-usability-review.test.ts
```

The result was:

```text
3 pass
0 fail
27 expect() calls
Ran 3 tests across 1 file.
```

The admission suite specifically
covered refusal, rate-limit, and hard-error fallback candidates that cannot
hold the live context, and verified the original model/session identity,
absence of rejected model-change and fallback-applied events, and settlement.

The same isolated ASCII Box run used a temporary extracted worktree and
installed dependencies there. The worktree was removed and the Box was stopped
after the run; no real credentials or desktop release were used.
