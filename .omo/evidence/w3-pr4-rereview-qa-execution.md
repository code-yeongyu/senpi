# W3 PR#4 Rereview QA Execution

worktree: `/Users/yeongyu/local-workspaces/senpi-wt/senpi-mcp-plugin-w3`
branch/head: `code-yeongyu/senpi-mcp-plugin-w3` at `e1ab175f957815ab2cdcf357b9f8127a0f80f578`
scope: `.omo/plans/senpi-mcp-plugin.md` TODO 22-28 / W3 auth PR#4 gate
evidenceRoot: `local-ignore/qa-evidence/20260708-w3-pr4-rereview-qa/`

## Summary

Verdict: PASS.

I re-ran the W3 auth-focused suite and real senpi-qa mock-loop/MCP surfaces from the requested worktree, with provider env vars stripped for live CLI runs. No real provider APIs or paid tokens were used. `npm run check` passed. The final secret scan over fresh QA evidence passed with zero matches for sentinel tokens, auth headers, or token fields. Cleanup is complete; one leftover OAuth fixture process from the auth suite was found and terminated, then the final process/zero-byte audit was clean.

The prior `.omo/evidence/task-28-senpi-mcp-plugin/gate-driver.mjs` was inspected but not trusted as evidence. It is stale/hardcoded to `/tmp/train-c-w3-auth` and older reports were treated as historical context only.

## manualQa

### surfaceEvidence

| scenario id | criterion reference | surface | exact invocation | verdict | artifactRefs |
|---|---|---|---|---|---|
| S1 | TODO 22-28 focused W3 auth behavior | `packages/coding-agent` vitest suite | `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/config.test.ts test/mcp/oauth-provider.test.ts test/mcp/oauth-callback.test.ts test/mcp/oauth-headless.test.ts test/mcp/auth-modes.test.ts test/mcp/oauth-race.test.ts test/mcp/token-store.test.ts` | PASS, 7 files / 56 tests passed | A1 |
| S2 | senpi-qa isolation guard | senpi-qa harness | `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check` | PASS, 9/9 checks; real auth unchanged | A2 |
| S3 | real CLI deterministic no-token loop | senpi CLI from source via senpi-qa | `env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GOOGLE_API_KEY -u XAI_API_KEY -u GROQ_API_KEY -u TOGETHER_API_KEY -u MISTRAL_API_KEY -u DEEPSEEK_API_KEY -u OPENROUTER_API_KEY node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test` | PASS, 5/5; localhost fake model only | A3 |
| S4 | MCP tool mock-loop surface | senpi CLI from source via senpi-qa MCP fixture | `env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GOOGLE_API_KEY -u XAI_API_KEY -u GROQ_API_KEY -u TOGETHER_API_KEY -u MISTRAL_API_KEY -u DEEPSEEK_API_KEY -u OPENROUTER_API_KEY node .agents/skills/senpi-qa/scripts/mock-loop.mjs --with-mcp-tool mcp_fx_tool_1 --tool-args '{"value":"w3-pr4-rereview"}' --evidence w3-pr4-rereview-mcp` | PASS, tool existed, executed, and result was fed back to the model | A4, A5 |
| S5 | repo static/type/build gate | root repo | `npm run check` | PASS | A6 |
| S6 | evidence secret hygiene | fresh evidence directory | `rg` scan for sentinel token strings, auth headers, bearer-like values, `x-api-key`, `access_token`, `refresh_token` over `local-ignore/qa-evidence/20260708-w3-pr4-rereview-qa`, excluding scan receipts | PASS, match_count=0 | A7 |
| S7 | cleanup and non-empty artifact gate | OS process table + evidence tree | filled generated empty stderr receipt, terminated leftover OAuth fixture pid `90097`, then scanned for W3/mock/MCP/OAuth fixture processes and zero-byte files | PASS, no matching leftover processes and no zero-byte files | A8 |

### adversarialCases

| scenario id | criterion reference | adversarial class | expected behavior | verdict | artifactRefs |
|---|---|---|---|---|---|
| P0-1 | TODO 24 callback server | wrong/replayed callback state, fixed port busy, concurrent auth | callback rejects bad/replayed state, fails fast on port conflict, avoids duplicate browser flow | PASS via focused suite | A1 |
| P0-2 | TODO 25 headless auth | malformed/expired pasted redirect, non-UI auth-required call | actionable retry/headless guidance, no partial credential write, no browser attempt in non-UI mode | PASS via focused suite | A1 |
| P0-3 | TODO 23/27 token refresh race | near-expiry token, invalid_grant, cross-process refresh race, lock-off control | single refresh under lock, invalid_grant drops credentials, lock-off control trips family invalidation | PASS via focused suite | A1 |
| P1-1 | TODO 22 token store | path traversal server name, concurrent writers, held lock | hash-confined path, valid JSON/no torn writes, clear lock-timeout error naming lock path | PASS via focused suite | A1 |
| P1-2 | TODO 26 bearer/header auth | headers must suppress OAuth autodetect, unset bearer env, literal token warning | zero discovery calls for header auth, actionable unset-var error, raw token redacted/fingerprinted | PASS via focused suite | A1 |
| P1-3 | TODO 28 config validation | invalid `oauth.callbackPort` | reject outside integer TCP port range | PASS via focused suite | A1 |
| P1-4 | TODO 28 runtime refresh path | near-expiry OAuth token through real catalog/tool runtime | refresh before catalog/tool use and coalesce concurrent calls | PASS via focused suite | A1 |
| P1-5 | TODO 28 MCP real-surface loop | model calls registered MCP fixture tool | fixture tool executes and result appears in second model request | PASS via senpi-qa mock-loop MCP | A4, A5 |
| P1-6 | TODO 28 secret hygiene | sentinel/raw token/header leakage in fresh artifacts | no raw token strings, auth headers, or token field names in reportable evidence | PASS | A7 |
| P1-7 | TODO 28 cleanup | lingering QA child processes / empty PASS artifacts | no leftover processes and no zero-byte referenced artifacts | PASS after terminating leftover fixture pid `90097` | A8 |

### artifactRefs

| id | kind | description | path |
|---|---|---|---|
| A1 | command transcript | Focused W3 auth/config suite rerun; 7 files and 56 tests passed with exit code 0 | `local-ignore/qa-evidence/20260708-w3-pr4-rereview-qa/01b-focused-auth-suite-rerun.log` |
| A2 | command transcript | senpi-qa common harness self-check; sandbox isolation and real auth unchanged | `local-ignore/qa-evidence/20260708-w3-pr4-rereview-qa/02-senpi-qa-common-self-check.log` |
| A3 | command transcript | senpi-qa mock-loop self-test with provider env vars stripped; localhost fake model only | `local-ignore/qa-evidence/20260708-w3-pr4-rereview-qa/03-senpi-qa-mock-loop-self-test.log` |
| A4 | command transcript | senpi-qa MCP fixture mock-loop run with provider env vars stripped | `local-ignore/qa-evidence/20260708-w3-pr4-rereview-qa/04-senpi-qa-mock-loop-mcp-tool.log` |
| A5 | generated QA artifacts | MCP fixture call log, model requests, stdout/stderr receipt, and summary JSON generated by senpi-qa | `local-ignore/qa-evidence/20260708-w3-pr4-rereview-qa/generated-mcp-evidence/` |
| A6 | command transcript | Root `npm run check` full output; exited 0 | `local-ignore/qa-evidence/20260708-w3-pr4-rereview-qa/06-npm-run-check.log` |
| A7 | scan receipt | Final secret hygiene scan, excluding scan receipts; match_count=0 | `local-ignore/qa-evidence/20260708-w3-pr4-rereview-qa/07b-secret-scan.log` |
| A8 | cleanup receipt | Final process cleanup and non-empty artifact audit; no leftover matched processes, no zero-byte files | `local-ignore/qa-evidence/20260708-w3-pr4-rereview-qa/11-final-cleanup-and-nonempty.log` |
| A9 | setup receipt | Worktree and HEAD setup receipt | `local-ignore/qa-evidence/20260708-w3-pr4-rereview-qa/00-setup.log` |
| A10 | status receipt | Git status after QA execution, showing no product/test edits by this rerun | `local-ignore/qa-evidence/20260708-w3-pr4-rereview-qa/10-git-status-after-qa.log` |

## Notes

- `01-focused-auth-suite.log` is superseded by `01b-focused-auth-suite-rerun.log`; the first wrapper used zsh's readonly `status` variable after the tests had passed, so it exited 1 for wrapper reasons.
- `07-secret-scan.log` is superseded by `07b-secret-scan.log`; the first scan matched its own printed invocation, not evidence content.
- `08b-cleanup-process-receipt.log` found a leftover OAuth fixture process from the focused auth suite. It was terminated and the final cleanup/non-empty audit passed in `11-final-cleanup-and-nonempty.log`.

<verdict>PASS</verdict>
