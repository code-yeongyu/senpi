# TODO28 QA Hygiene And Secret-Safety Review

Verdict: PASS.

Scope reviewed:
- Local QA driver only: `local-ignore/qa-evidence/20260708-mcp-w3-todo28/todo28-auth-e2e-driver.mts`.
- Local runtime artifacts: `local-ignore/qa-evidence/20260708-mcp-w3-todo28/`.
- Tracked TODO28 evidence: `.omo/evidence/task-28-senpi-mcp-plugin.log`, `.omo/evidence/task-28-fix-senpi-mcp-plugin.log`, `.omo/evidence/task-28-senpi-mcp-plugin/`, `.omo/evidence/task-28-w3-qa-verification/`, and this review.
- No product or test source files were edited for TODO28.

`remove-ai-slops` review:
- No fabricated transcripts: step 5 was rerun through real tmux and preserved an action log with `/mcp auth-start oauth`, authorize URL fingerprint/redacted URL, `/mcp auth-complete oauth <redirect>`, authorization marker, and final `/mcp test oauth` marker.
- No summary-only PASS: step 10 PASS is tied to `npm-run-check.log`, `npm-run-build-prereq.log`, and `npm-test-after-build.log`; step 11 PASS is tied to `step-11-model-requests.json` containing `is_error: true` and the auth hint.
- No stale failed artifacts represented as pass: the pre-build `npm test` failure remains preserved as `npm-test-prebuild-failed.log` and is documented as a build-precondition failure, not a passing run.
- No hollow assertions: every PASS in `INDEX.md` points to a non-empty artifact; step 5 and step 11 include direct observables, not only booleans.
- No overfit/deletion-only tests: TODO28 changed evidence only; it did not add product tests that merely assert removals or mirror implementation details.
- No unnecessary production extraction/parsing/normalization: product and test source were not edited; the only parsing/redaction logic lives in the ignored local QA driver.

`programming` review:
- No product/test source edits: no `.ts`, `.tsx`, `.mts`, `.cts`, `.py`, `.rs`, or `.go` product/test files were changed.
- Ignored local driver source is not committed and is used only to drive real QA surfaces; it is excluded from the final raw scan because it contains fixture setup and scan regex source, not runtime output.
- Tracked legacy TODO28 driver evidence was cleaned so literal sentinel prefixes are no longer present in committed evidence/source.
- No unscoped secret scan: final scan explicitly covers all tracked TODO28 `.omo` evidence plus the local runtime artifact bundle.

Secret safety:
- No raw secret leakage: final raw scan checks raw sentinel access/refresh tokens, bearer credentials, authorization header values, browser credential headers, and API key values.
- Real `~/.senpi/agent/auth.json` was snapshotted and verified unchanged.
- Real `~/.senpi/agent/mcp-auth` remained absent.
- Provider credential env vars were stripped for senpi-qa helpers, `npm run check`, build precondition, and full `npm test`.
- Cleanup/isolation proof is in `auth-isolation-receipt.json`; TODO28 tmux sessions were cleaned up by the driver.
