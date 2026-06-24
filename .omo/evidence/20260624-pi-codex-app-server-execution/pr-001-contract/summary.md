# PR-001 Contract And Inventory Lock

Status: ready for PR.

Scope:
- External JSON-RPC-compatible method names are locked.
- Opaque app-server envelope fields are locked.
- Every string-named current app-server protocol surface from `codex-rs/app-server-protocol/src/protocol/common.rs` is classified as semantic, opaque lossless, opaque best-effort, or snapshot-authoritative.
- The full required catalog currently covers 219 app-server request, server-request, notification, event, thread-item, and future opaque surfaces.
- Fixture folders and reviewer evidence packet templates were added.

Out of scope:
- Runtime routing, sockets, process startup, backpressure execution, callback execution, reconnect, and QA harness behavior.

Failing-first evidence:
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-001-contract/red-failing-first.txt`

Green verification:
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-001-contract/targeted-test-green.txt`
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-001-contract/npm-run-check.txt`
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-001-contract/senpi-qa-common-self-check.txt`
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-001-contract/senpi-qa-mock-loop-self-test.txt`
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-001-contract/senpi-qa-cli-smoke-self-test.txt`

Observed results:
- Targeted contract test: 1 file passed, 3 tests passed.
- `npm run check`: passed.
- senpi QA common self-check: 9/9 passed, real auth unchanged.
- senpi QA mock loop: 5/5 passed, zero real provider calls, real auth unchanged.
- senpi QA CLI smoke: 5/5 passed, real auth unchanged.

Auxiliary/manual evidence:
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-001-contract/commands-and-exit-codes.txt`
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-001-contract/inventory-diff.json`
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-001-contract/cleanup-receipt.txt`
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-001-contract/secret-safety.txt`
- `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-001-contract/project-tracking.txt`

Project tracking:
- `BLOCKED:missing-gh-project-scope`

Secret safety:
- Fixtures are synthetic.
- No raw secret-bearing logs, auth headers, tokens, cookies, launchd environments, or private credentials are captured.

Changed TypeScript file size audit:
- `packages/coding-agent/src/core/extensions/builtin/pi-codex-app-server/protocol-core.ts`: 244 pure lines.
- `packages/coding-agent/src/core/extensions/builtin/pi-codex-app-server/protocol-inventory.ts`: 89 pure lines.
- `packages/coding-agent/src/core/extensions/builtin/pi-codex-app-server/protocol-required-surfaces.ts`: 233 pure lines.
- `packages/coding-agent/test/suite/pi-codex-app-server-contract.test.ts`: 107 pure lines.
