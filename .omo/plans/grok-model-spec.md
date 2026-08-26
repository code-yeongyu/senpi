# Grok Model Specification Correction

## Goal

Correct Senpi's xAI Grok catalog and reasoning-effort behavior against the current official xAI documentation, prove the regression RED→GREEN, exercise the real source CLI against deterministic mock endpoints, and deliver the change through a merged PR.

## Tier

HEAVY. The change affects an external provider's model metadata and outbound request contract, and the user explicitly requested careful documentation-grounded work.

## Ground truth

- Official xAI reasoning guide: Grok 4.6 supports `low`, `medium`, `high`, and `xhigh`; default is `high`; reasoning cannot be disabled.
- Official xAI model pages: `grok-4.20-0309-reasoning` is reasoning-only without a published effort knob; `grok-4.20-0309-non-reasoning` is reasoning-free.
- Live models.dev: Grok 4.6 advertises the four effort values; Grok 4.20 non-reasoning is `reasoning:false`; Grok 4.20 reasoning has no effort options.
- Existing Senpi behavior: generated xAI metadata disables reasoning effort for every Chat Completions Grok model and explicitly excludes both Grok 4.20 variants.
- Scope boundary: leave Grok 4.5 unchanged. The directly fetched reasoning guide and models.dev expose only low/medium/high as native tiers for that model; the bug report concerns Grok 4.6 and non-reasoning Grok.

## Delegation topology

- `grok-docs-audit` librarian: completed independent authoritative-document research because external model specifications are separable from code inspection.
- `grok-code-audit` explore: completed independent repository-flow audit because generated-data ownership and request serialization are separable from web research.
- Lead session: owns plan synthesis, all writes, RED/GREEN decisions, diagnostics, QA, commits, PR review responses, merge, and cleanup because those steps share state and require judgment.
- No Momus reviewer: explicitly prohibited by the user. The plan-gated review requirement will be satisfied with self-review plus the repository's required review-work/CI gates before merge.

## Ordered implementation waves

### Foundation

1. Create branch `fix/grok-model-spec` in a dedicated worktree under `/Volumes/mengmotaStorage/local-workspaces/senpi-wt/`.
2. Read all touched files in full inside the worktree, including nearest `AGENTS.md` and `changes.md`.
3. Install/build only if the fresh worktree lacks required artifacts.
4. Create `local-ignore/qa-evidence/20260818-grok-model-spec/` and record source URLs, exact Discord message, baseline commit, and cleanup ledger.

### RED

5. Add catalog assertions proving:
   - xai/grok-4.6 exposes exactly low/medium/high/xhigh;
   - xai/grok-4.20-0309-reasoning is present, reasoning=true, and exposes no configurable effort tier;
   - xai/grok-4.20-0309-non-reasoning is present, reasoning=false, and exposes exactly off.
6. Add xAI Chat Completions request assertions proving:
   - Grok 4.6 xhigh emits top-level `reasoning_effort:"xhigh"`;
   - Grok 4.20 reasoning emits no `reasoning_effort`;
   - Grok 4.20 non-reasoning emits no `reasoning_effort`.
7. Run only the focused tests and capture RED output caused by the missing metadata/catalog entries, not syntax or import failures.

### GREEN

8. Edit `packages/ai/scripts/generate-models.ts` only:
   - retain retired Grok 3/Grok Code exclusions;
   - restore both currently documented Grok 4.20 variants;
   - add model-specific xAI Chat Completions maps/compatibility;
   - map Grok 4.6 to low/medium/high/xhigh with off/minimal/max vetoed;
   - do not enable effort for Grok 4.20 reasoning or non-reasoning;
   - do not blanket-enable all xAI models.
9. Regenerate model data through the repository generator; never hand-edit `xai.json`, `.manifest.json`, shards, or `models.generated.ts`.
10. Inspect the generated diff and revert unrelated live-catalog churn by correcting generator inputs or restoring unrelated generated output without destructive git commands.
11. Update `packages/ai/src/changes.md` in the same verified increment with rationale and conflict zones.
12. Run focused tests to GREEN and record outputs.
13. Run LSP diagnostics on changed TypeScript/test files and fix all introduced diagnostics.
14. Commit the verified RED→GREEN increment atomically using repository history conventions.

### Real surface QA

15. Add or extend a committed Senpi QA scenario that starts a hermetic local mock xAI server and drives the real source CLI:
   - Grok 4.6 with `--thinking xhigh` must reach the server with `reasoning_effort:"xhigh"`;
   - Grok 4.20 non-reasoning must reach the server without any reasoning field;
   - CLI model listing must include both restored Grok 4.20 variants with correct reasoning behavior.
16. Run the scenario against the broken baseline or mutation to capture RED if the unit RED does not already faithfully cover its wiring.
17. Run the fixed scenario, save request bodies/stdout/summary under the evidence directory, and record cleanup for server PID, ports, sandboxes, and temp files.
18. Run the required `senpi-qa` self-test/helper checks and visual/PTY surface only if the scenario changes interactive rendering; model/request changes use CLI/mock-loop evidence.
19. Commit the QA scenario atomically after it passes.

### Broad verification and PR

20. Run direct affected tests, package tests, model-data validation, model generation checks, build, `npm run check`, and required prompt-preset regressions.
21. Re-read the final diff, confirm every criterion against evidence, and record HEAVY self-review in the notepad.
22. Push the branch and open a reviewer-readable draft PR with the evidence summary.
23. Add package changelog entries referencing the actual PR number, run the changelog gate, commit, and push.
24. Mark the PR ready and monitor required checks asynchronously; never poll or sleep.
25. For each failing check or review concern, inspect authoritative annotations/logs, reproduce locally, fix minimally with RED/GREEN evidence where behavioral, rerun affected QA, commit, and push.
26. Run the repository's required `review-work` workflow before handoff; do not invoke Momus.
27. Merge with a merge commit only after required checks are green and review gates pass.

### Cleanup

28. Verify GitHub reports `MERGED`.
29. Delete the remote feature branch if GitHub did not.
30. Copy/retain final evidence in the main repository's ignored evidence directory.
31. Remove and prune the dedicated worktree.
32. Verify no QA processes, ports, tmux sessions, browser contexts, or temp sandboxes remain.
33. Complete todos and goal only after all cleanup receipts are recorded.

## Success criteria and exact scenarios

1. **Grok 4.6 effort**
   - RED/GREEN: focused Vitest assertion for exact supported levels.
   - Surface: source CLI with xai/grok-4.6 and xhigh against a local capture server.
   - PASS: selector/listing accepts xhigh and captured JSON equals `"reasoning_effort":"xhigh"`.
2. **Grok 4.20 reasoning**
   - RED/GREEN: catalog assertion for presence/reasoning=true/no effort tier.
   - Surface: source CLI request against capture server.
   - PASS: request contains no `reasoning_effort`.
3. **Grok 4.20 non-reasoning**
   - RED/GREEN: catalog assertion for presence/reasoning=false/off-only.
   - Surface: model listing plus source CLI request.
   - PASS: model is listed and request contains no reasoning field.
4. **Regression and delivery**
   - PASS: diagnostics, affected tests, model-data checks, build, root check, required QA, GitHub checks, merge state, and cleanup are all green/complete.

## Stop condition

Stop immediately when all scenarios pass with captured evidence, GitHub reports the PR merged, every QA resource is cleaned up, and the dedicated worktree is removed.
