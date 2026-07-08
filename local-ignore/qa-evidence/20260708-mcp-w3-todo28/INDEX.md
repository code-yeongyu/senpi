# TODO28 W3 Auth E2E Evidence Index

Generated: 2026-07-07T22:54:23.000Z
Verdict summary: 11/11 PASS.

| Step | Verdict | Artifact |
| --- | --- | --- |
| 1 | PASS | local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-01.json |
| 2 | PASS | local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-02.json |
| 3 | PASS | local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-03.json |
| 4 | PASS | local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-04.json |
| 5 | PASS | local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-05.json |
| 6 | PASS | local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-06.json |
| 7 | PASS | local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-07.json |
| 8 | PASS | local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-08.json |
| 9 | PASS | local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-09.json |
| 10 | PASS | local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-10.json |
| 11 | PASS | local-ignore/qa-evidence/20260708-mcp-w3-todo28/step-11.json |

Auth isolation: see auth-isolation-receipt.json.
Token safety: raw fixture credentials are redacted to fingerprints; step 9 records the driver runtime scan; `final-raw-token-scan.log` records the final runtime/tracked evidence scan including `.omo/evidence/task-28-fix-senpi-mcp-plugin.log`.
Build/test note: full `npm test` requires built workspace `dist` entrypoints; the failed pre-build run is preserved as `npm-test-prebuild-failed.log`, and the passing post-build run is `npm-test-after-build.log`.
