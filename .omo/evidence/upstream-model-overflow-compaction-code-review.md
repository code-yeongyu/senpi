# Upstream Model Overflow Compaction Security Review

Verdict: PASS

## Scope Reviewed

- Worktree: `/Users/yeongyu/local-workspaces/senpi-wt/fix/auto-compact-context-too-large`
- Diff basis: local working-tree patch; `origin/main...HEAD` is empty.
- Changed production/docs/evidence reviewed:
  - `packages/coding-agent/src/core/agent-session.ts`
  - `packages/coding-agent/src/core/model-registry.ts`
  - `packages/coding-agent/src/core/changes.md`
  - `packages/coding-agent/CHANGELOG.md`
  - `packages/coding-agent/test/model-registry.test.ts`
  - `packages/coding-agent/test/suite/harness.ts`
  - `packages/coding-agent/test/suite/regressions/pre-prompt-compaction-no-continue.test.ts`
  - `packages/coding-agent/test/suite/regressions/context-overflow-model-alias.test.ts`
  - `.omo/evidence/task-5-context-overflow-upstream-model-compaction.txt`
  - `local-ignore/qa-evidence/20260708-auto-compact-context-too-large/*`

## Skill-Perspective Check

- Consulted `omo:remove-ai-slops`: no deletion-only tests, tautological removal tests, unnecessary parsing/normalization, speculative extraction, or production slop found in the reviewed delta.
- Consulted `omo:programming` and TypeScript reference: no new `any`, dynamic import, type-escape, needless abstraction, brittle prompt test, or production boundary validation violation found.
- Consulted `codex-security:security-diff-scan` and shared hard rules: review stayed diff-scoped and checked secret exposure, credential/auth access, metadata trust, retry/DoS, provider-call behavior, and evidence leakage.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

None.

### LOW

None.

## Security Notes

- Secret/auth exposure: no new credential source is introduced. `ModelRegistry.getUpstreamModelId()` reads the existing in-memory `modelRequestUpstreamIds` map only; it does not call `getApiKeyAndHeaders()` or resolve provider env/secrets. Existing secret-bearing code paths remain in `getApiKeyAndHeaders()` at `packages/coding-agent/src/core/model-registry.ts:901`.
- Unsafe metadata trust: the new overflow match still requires same provider and either current model id or configured upstream model id in `packages/coding-agent/src/core/agent-session.ts:340` and `packages/coding-agent/src/core/agent-session.ts:2499`. This aligns inbound overflow attribution with existing outbound request rewriting in `packages/coding-agent/src/core/sdk.ts:324`.
- Retry/DoS: context-overflow messages remain excluded from generic retry at `packages/coding-agent/src/core/agent-session.ts:3221`, and overflow recovery remains latched to one compact-and-retry attempt at `packages/coding-agent/src/core/agent-session.ts:2529`.
- Real-provider calls: reviewed QA evidence reports localhost-only mock-loop coverage and unchanged real auth. I also reran the focused regression scope locally.
- Evidence/PR leakage: no PR exists for the branch (`gh pr list --head fix/auto-compact-context-too-large` returned `[]`). Current evidence/body-like files contain artifact paths and synthetic fixture text only. The broad secret scan of current fix evidence matched only synthetic `read /tmp/h2.jpg` fixture text in diff snapshots.

## Verification

- Reran focused scope directly:
  - `npx tsx ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/context-overflow-model-alias.test.ts test/suite/regressions/pre-prompt-compaction-no-continue.test.ts test/model-registry.test.ts`
  - Result: 3 files passed, 87 tests passed.
- Reviewed executor evidence:
  - `local-ignore/qa-evidence/20260708-auto-compact-context-too-large/review-qa/01-focused-vitest.txt`: 3 files passed, 87 tests passed.
  - `local-ignore/qa-evidence/20260708-auto-compact-context-too-large/npm-run-check-final.txt`: recorded full `npm run check` pass.
  - `local-ignore/qa-evidence/20260708-auto-compact-context-too-large/senpi-qa-mock-loop-openai-responses.txt`: localhost-only mock loop, zero real provider calls, real auth unchanged.
  - `local-ignore/qa-evidence/20260708-auto-compact-context-too-large/senpi-qa-rpc-self-test.txt`: offline RPC self-test, real auth unchanged.
  - `local-ignore/qa-evidence/20260708-auto-compact-context-too-large/senpi-qa-cli-smoke.txt`: CLI smoke, offline model listing, real auth unchanged.
- Did not rerun `npm run check` directly because its configured command invokes `biome check --write`, which can modify source files and conflicts with this read-only review assignment. The recorded artifact was inspected instead.

## Residual Risks

- The security decision trusts the existing models.json/provider registration boundary for `upstreamModelId`. A malicious local config can already redirect requests through `upstreamModelId`; this patch only mirrors that configured value for overflow attribution.
- Overflow classification still depends on provider error strings and usage metadata in `packages/ai/src/utils/overflow.ts`; this patch does not broaden or harden that classifier.

## Result

- codeQualityStatus: CLEAR
- recommendation: APPROVE
- blockers: none
