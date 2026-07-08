# Code Quality Review: auto-compact-context-too-large

## Verdict

- codeQualityStatus: WATCH
- recommendation: APPROVE
- verdict: PASS
- blockers: none

## Scope Reviewed

Requested files only:

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/model-registry.ts`
- `packages/coding-agent/test/model-registry.test.ts`
- `packages/coding-agent/test/suite/harness.ts`
- `packages/coding-agent/test/suite/regressions/context-overflow-model-alias.test.ts`
- `packages/coding-agent/test/suite/regressions/pre-prompt-compaction-no-continue.test.ts`
- `packages/coding-agent/CHANGELOG.md`

Note: the worktree also has unlisted changes in `packages/coding-agent/src/core/changes.md` and `.omo/evidence/task-5-context-overflow-upstream-model-compaction.txt`. I inspected them only as scope/evidence context; this verdict does not approve those paths.

## Skill-Perspective Check

Ran/consulted:

- `omo:remove-ai-slops` via `/Users/yeongyu/.codex/plugins/cache/sisyphuslabs/omo/4.16.0/skills/remove-ai-slops/SKILL.md`
- `omo:programming` via `/Users/yeongyu/.codex/plugins/cache/sisyphuslabs/omo/4.16.0/skills/programming/SKILL.md`
- TypeScript reference via `/Users/yeongyu/.codex/plugins/cache/sisyphuslabs/omo/4.16.0/skills/programming/references/typescript/README.md`

Result: no blocking violation in the requested diff. The new regression file uses private-method reflection, which is implementation-coupled, but that style already exists in nearby compaction tests and this diff also adds a public `prompt()`-path regression. Existing touched files are oversized by the programming skill's 250 pure-LOC lens; the diff itself is narrow and does not add a new responsibility.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

None.

### LOW

- Existing file-size risk: `packages/coding-agent/src/core/agent-session.ts` is about 3370 pure LOC and `packages/coding-agent/src/core/model-registry.ts` is about 1086 pure LOC. This change adds a small, localized alias comparison/accessor and does not materially worsen architecture, but future edits in these files should prefer extraction when touching larger behavior.
- Test coupling note: `packages/coding-agent/test/suite/regressions/context-overflow-model-alias.test.ts:9` reaches private methods with `Reflect`. This is not a blocker because `packages/coding-agent/test/suite/regressions/pre-prompt-compaction-no-continue.test.ts:76` covers the same alias overflow behavior through the public `prompt()` path.

## Review Notes

- `packages/coding-agent/src/core/agent-session.ts:340` adds a small source-match helper that keeps the existing provider guard and extends model equality to the configured upstream model id.
- `packages/coding-agent/src/core/agent-session.ts:2499` uses the helper only for the overflow source check; unrelated model overflows still require current context pressure before compaction.
- `packages/coding-agent/src/core/model-registry.ts:795` exposes the same upstream-id map already used by `getApiKeyAndHeaders()`, avoiding credential resolution in the compaction gate.
- `packages/coding-agent/test/suite/harness.ts:76` and `:144` extend the faux harness just enough to register upstream alias metadata through `ModelRegistry.registerProvider()`.
- `packages/coding-agent/test/suite/regressions/pre-prompt-compaction-no-continue.test.ts:76` verifies the user-facing dot retry path compacts before sending the prompt and does not call `agent.continue()`.
- `packages/coding-agent/test/suite/regressions/context-overflow-model-alias.test.ts:87` verifies the negative same-provider/unrelated-model case below threshold does not compact.

## Verification

Commands run from `/Users/yeongyu/local-workspaces/senpi-wt/fix/auto-compact-context-too-large` unless noted:

- `git diff --check` - passed.
- From `packages/coding-agent`: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/model-registry.test.ts test/suite/regressions/context-overflow-model-alias.test.ts test/suite/regressions/pre-prompt-compaction-no-continue.test.ts` - 3 files passed, 87 tests passed.
- `npm run check` - passed, including Biome, pinned deps, TS import checks, shrinkwrap/install-lock checks, `tsgo --noEmit`, web UI checks, and neo build/vet/test.

I also spot-checked executor evidence under `local-ignore/qa-evidence/20260708-auto-compact-context-too-large/`, including red failure, focused green runs, QA self-tests, and final check output.
