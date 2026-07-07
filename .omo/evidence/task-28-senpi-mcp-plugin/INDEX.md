# W3 AUTH e2e QA GATE — INDEX

PR#4 gate: MCP OAuth 2.1 + token store + bearer/header auth. Sandbox HOME
(SENPI_CODING_AGENT_DIR), fixture IdP, real shipped modules end-to-end.
Real remote OAuth servers (Linear/Notion) are explicitly NON-GATING.

## Verdicts (11 steps)

| Step | Scenario | Verdict | Artifact |
|------|----------|---------|----------|
| 1 | add OAuth HTTP server -> first call -> needs_auth | PASS | step-01.txt |
| 2 | auth browser-less loop -> connected -> tool call OK | PASS | step-02.txt |
| 3 | restart -> stored token reused, NO re-auth | PASS | step-03.txt |
| 4 | expire access token -> transparent refresh | PASS | step-04.txt |
| 5 | headless paste flow end-to-end | PASS | step-05.txt |
| 6 | logout -> needs_auth | PASS | step-06.txt |
| 7 | invalid_grant injection -> drop + clean re-auth | PASS | step-07.txt |
| 8 | bearer ${VAR} happy + unset-var failure | PASS | step-08.txt |
| 9 | secret audit: grep logs+evidence for SENTINEL_AT_ tokens | PASS | step-09.txt |
| 11 | print-mode fail-fast isError, no browser | PASS | step-11.txt |
| 10 | npm run check + full npm test green | PASS | step-10.txt |

Happy path: steps 1-6, 10. Designed-failure / audit drills: 7 (invalid_grant),
8 (unset bearer var), 9 (secret grep), 11 (print-mode fail-fast).

## Isolation receipt
See isolation-receipt.txt — real ~/.senpi/agent/mcp-auth remained ABSENT
(byte-unchanged); all credentials landed in the sandbox agentDir.

## Secret audit (step 9)
grep of sandbox logs + evidence for SENTINEL_AT_* access tokens => ZERO hits
outside the 0600 tokens.json credential store; logs carry only
<redacted:xxxxxxxx> 8-char sha256 fingerprints.

## Reproduce
cd packages/coding-agent && node ../../.omo/evidence/task-28-senpi-mcp-plugin/gate-driver.mjs
