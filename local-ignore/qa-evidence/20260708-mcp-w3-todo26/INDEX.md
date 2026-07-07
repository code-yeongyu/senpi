# TODO26 QA Evidence

Scenario: MCP bearer/header auth with OAuth autodetect disabled for header-auth servers.

Artifacts:
- `manual-qa-command.txt`: local fixture manual QA command and output.
- `manual-qa-summary.txt`: happy/failure/manual assertions.
- `idp-request-log.json`: OAuth fixture request log proving `discoveryHits=0` and `requests=[]`.
- `literal-warning-ring.log`: logger ring buffer proving fingerprint-only redaction.
- `header-happy.log`: provenance-restored artifact for the header-auth happy
  path, derived only from existing task evidence because the original separate
  runtime log bytes were absent.
- `literal-warning.log`: sanitized MCP log file.
- `senpi-qa-common.txt`: `common.mjs --self-check` isolation receipt.
- `senpi-qa-cli-smoke.txt`: CLI smoke self-test.
- `senpi-qa-mock-loop.txt`: deterministic real-loop smoke via local fake model.

Secret safety:
- Raw-token scan command found no matches for manual/test sentinel token strings in `.omo/evidence/task-26-senpi-mcp-plugin.log` or this bundle.
- Fingerprint scan found only `fp 93dedbe2` / `<redacted:...>`-style markers.

Cleanup:
- Temporary script `/tmp/todo26-manual-qa.mjs` was removed after the manual QA run.
