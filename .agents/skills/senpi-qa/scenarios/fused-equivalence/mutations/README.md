# EQ mutations (plan P0-05d)

Each patch here changes the product's behavior in a way the fused-equivalence EQ must catch. `manifest.mjs` names, for
every row of the plan's mutation table (§6.4 "Mutation evidence"), the patch, the EQ cases it runs and the diff row each
case must show. `scripts/scenarios/fused-equivalence-mutations-qa.mjs` runs them:

```
node .agents/skills/senpi-qa/scripts/scenarios/fused-equivalence-mutations-qa.mjs --evidence <slug>
node .agents/skills/senpi-qa/scripts/scenarios/fused-equivalence-mutations-qa.mjs --self-test
```

The driver never patches the working tree. It copies the clean, committed tree to a scratch directory (a shared clone at
HEAD plus the ignored dependencies, build output and generated sources, symlinks kept as they are), runs the unmutated
compare there first, and then per row applies the patch, runs `fused-equivalence-qa.mjs --compare --pipeline legacy
--placement fused` on the row's cases, reverts, and checks that the scratch is clean and the patch still applies.

| Patch | Plan row | Observation | Cases | What it changes |
|---|---|---|---|---|
| `o1-dropped-prompt-segment.patch` | dropped prompt segment | O1 | E01 | removes the "Judgment asks" line from the intent-gate system prompt segment |
| `o2-swapped-model.patch` | swapped model | O2 | E01 | OpenAI-completions requests name `mock-model-b` instead of `mock-model` |
| `o3-dropped-declaration.patch` | dropped declaration | O3 | E01 | the last tool declaration is dropped from each request |
| `o4-dropped-custom-header.patch` | dropped custom header | O4 | E01 | senpi's own `User-Agent` header is no longer sent (the SDK default goes out) |
| `o4-swapped-synthetic-credentials.patch` | swapped synthetic credentials | O4 | E01 | the request carries a different credential than the one resolved for the provider |
| `o5-wrong-target-other-dir.patch` | wrong effect target in another dir | O5 | E02 | a write lands in the directory above the session cwd |
| `o5-wrong-target-same-sandbox.patch` | wrong effect target in the same sandbox | O5 | E02 | a write lands on `<path>.moved` in the same work dir; the event still shows the asked path |
| `o5-reordered-effects.patch` | reordered effects | O5 | E03 | a sequential tool no longer waits for the parallel wave before it |
| `o6o7-merged-ids.patch` | merged IDs | O6/O7 | E01 | every tool result carries one merged tool-call id (the end events keep theirs, so the run still completes) |
| `o8-tui-removed-dialog-option.patch` | removed widget/dialog | O8 TUI | E17 (`--surface tui`) | the permission dialog loses "Allow always" |
| (P0-07b) | broken desktop render | O8 desktop | EQ.desktop | DEFERRED: the desktop PR (P0-07b) ships the patch and runs it with EQ.desktop |
| `e25-rerun-interrupted-call.patch` | interrupted call re-run on resume (E25) | O5 | E25 | a reopened interrupted session re-runs every tool call that has no result |
| `e30-tool-result-to-other-session.patch` | tool result delivered to the other session (E30) | O6/O7 | E30 | `tool_execution_end` is broadcast to every RPC connection, the other session's included |

Origins: the O1, O2, O3 and reordered-effects patches are P0-05b's (senpi#4639), the dialog patch is P0-05c's
(senpi#4661), and the E25 and E30 patches are P0-05e's (senpi#4751); each was regenerated with `git diff` at this
branch's base. The other five are new here.

Row verdicts: KILLED is the proof. DEFERRED (the case's golden cell is listed in `../deferred-goldens.mjs`, or the row
belongs to another PR) and NO_B0 (no goldens for that surface on this platform, e.g. EQ.tui has none on linux-x64) are
reported and never count as proof. SURVIVED (the EQ passed with the mutation applied), WRONG_FAILURE (it failed, but
without the expected diff row), INCONCLUSIVE (the unmutated compare did not pass), STALE (the patch no longer applies),
DIRTY (the revert did not leave a clean tree) and ERROR fail the run.

Lifecycle (plan §1.3 chain `mutations/`: P0-05d -> S18b -> S36): S18b adds `witness.patch` (prepared -> legacy routing
must fail the `witness.pipeline` assertion), and S36 retires it for `bypass-executor.patch`. A PR that removes the code a
patch targets retires that patch and registers its replacement in the same PR.
