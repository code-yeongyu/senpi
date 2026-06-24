# PR-003 protocol/capability evidence

This work is using code-yeongyu/lazycodex teammode.

## Summary

PR-003 adds protocol-only capability negotiation for the pi-codex-app-server extension. It parses external initialize capability payloads, requires opaque notification and opaque callback support, maps app-server notification opt-outs, and creates adapter-originated JSON-RPC errors under `data.source = "pi-codex-app-server"`.

No runtime transport, child process, websocket, unix socket, session routing, stream projection, callback execution, reconnect, or final redaction QA is implemented in this PR.

## Commands and evidence

- Failing-first proof: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-003-protocol-capability/failing-first.txt`
- Targeted capability test: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-003-protocol-capability/targeted-capability-green.txt`
- Contract/skeleton/capability test rerun: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-003-protocol-capability/targeted-suite-rerun.txt`
- Full check: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-003-protocol-capability/npm-run-check-rerun.txt`
- senpi QA common self-check: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-003-protocol-capability/senpi-qa-common-self-check.txt`
- senpi QA CLI smoke: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-003-protocol-capability/senpi-qa-cli-smoke.txt`
- senpi QA mock loop: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-003-protocol-capability/senpi-qa-mock-loop.txt`
- Adapter harness help smoke: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-003-protocol-capability/drive-adapter-help.txt`
- Cleanup receipt: `local-ignore/qa-evidence/20260624-pi-codex-app-server/pr-003-protocol-capability/cleanup-receipt.txt`

## Project tracking

BLOCKED:missing-gh-project-scope - `gh project list --owner code-yeongyu --format json --limit 20` failed because the token lacks `read:project`.

## Residual risks

- Negotiation is pure protocol state only; runtime connection handoff remains PR-004.
- Session/request routing remains PR-005.
- Item streaming, backpressure, and callbacks remain PR-006 through PR-009.
- Realtime/filesystem/plugin/config pass-through remains PR-011 and is not unblocked by this PR alone.
