# modes/app-server/protocol

## OVERVIEW
Protocol-facade domain (score 9, excluding generated output): handwritten wire contracts plus pinned Codex type evidence and local lint configuration.

## WHERE TO LOOK

| Task | File |
|---|---|
| Public facade exports | `index.ts` |
| Request/notification catalogs | `requests.ts`, `notifications.ts`, `methods.ts`, `methods.js` |
| Common envelopes | `base.ts` |
| Thread/turn contracts | `thread.ts`, `thread-parity.ts`, `turn.ts` |
| Models, account, and config | `models.ts`, `account.ts`, `config.ts` |
| Collaboration projection | `collaboration-mode.ts` |
| Fuzzy-file and terminal contracts | `fuzzy-search.ts`, `terminal.ts` |
| Compatibility type checks | `typecheck.ts` |
| Pin and regeneration policy | `PROTOCOL_VERSION.txt`, `README.md` |

## CONVENTIONS

- The facade is the app-facing contract; generated exporter coverage is not a complete runtime-method inventory.
- Experimental request families can be supplied from the pinned Codex `common.rs` method evidence even when absent from generated request roots.
- `SENPI_COLLABORATION_MODE` projects the supported collaboration shape; nested `reasoning_effort` remains snake_case.
- Fuzzy-file results preserve Codex's `match_type` and `file_name`, unlike most camelCase v2 fields.
- Account usage/rate-limit values normalize bigint-like source counters to JSON-safe numbers.
- `generated/package.json` is a local compilation shim and is not part of upstream payload identity.
- Package builds exclude raw generated TypeScript; extensionless upstream imports are not rewritten to match app ESM conventions.
- The protocol-pin suite checks recorded artifacts without an ambient checkout; `SENPI_CODEX_CHECKOUT` opts into live byte comparison.

## ANTI-PATTERNS

- Interpreting exporter omission of an experimental root as evidence that Codex removed the runtime method.
- Converting mixed-case wire fields to a uniform naming convention.
- Sending JavaScript `bigint` through JSON frames.
- Counting the local compilation shim as upstream protocol evidence or relying on an unpinned ambient checkout in default tests.
