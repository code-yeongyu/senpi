# packages/session-backends/sqlite-node

`@earendil-works/pi-storage-sqlite-node` (private). Node `node:sqlite` backend for
`@earendil-works/pi-agent-core` sessions; vendored from upstream pi. Node `>=22.19.0`.
Score 16: 50 files, 6 subdirs, dense typed SQL layer with its own migration pipeline.

## STRUCTURE

```text
src/index.ts              wrapNodeSqliteDatabase / createNodeSqliteFactory + re-exports sqlite/
src/sqlite/repo.ts        SqliteSessionRepository — repository/storage orchestration (953 LOC hotspot)
src/sqlite/sql.ts         Tagged-template `sql` helper
src/sqlite/migrations.ts  Migration runner; SQL files in src/sqlite/migrations/
src/sqlite/storage/       Per-table modules: sessions, entries, records, lanes, facts,
                          branch-entries, branch-tips, branch-cache, session-sequences,
                          session-stats, writer-leases
src/sqlite/search-backend.ts   FTS/search over stored entries
scripts/prepare-dist.mjs  `copy-sqlite-migrations` build step
test/                     11 Vitest files (repository, adapter, branch-query, writer-leases...) + test-utils
```

Package exports only `.` (dist/index.js). Migrations are plain `.sql` files copied into
`dist/` by the build script — never inline SQL changes without adding a migration.

## WHERE TO LOOK

| Task | Path |
|---|---|
| New stored field / table | `src/sqlite/storage/` + new `NNN_*.sql` migration |
| Session lifecycle, decoding, writer leases | `src/sqlite/repo.ts` |
| Branch resolution / caching | `src/sqlite/branch-cache.ts`, `storage/branch-*.ts` |
| Search | `src/sqlite/search-backend.ts`, `test/search.test.ts` |
| node:sqlite adapter quirks | `src/index.ts` |

## CONVENTIONS

- ESM with `.ts`-suffixed relative imports; `tsc -p tsconfig.build.json` build.
- `npm run build` runs `prepare-dist.mjs copy-sqlite-migrations` after `tsc`.
- Tests are Vitest (`npm test` -> `vitest --run`), not the Node test runner.
- Storage functions are named `read/insert/delete/create*` per table module.

## ANTI-PATTERNS

- Transaction callbacks must be synchronous and must not return a promise —
  `NodeSqliteDatabase.transaction` throws `TypeError` on async results (`BEGIN IMMEDIATE`).
- Rollback errors are intentionally ignored so the original transaction error is rethrown;
  don't add rollback error propagation.
- Writer leases guard serialized writes; don't bypass `repo.ts` orchestration by calling
  storage modules directly from outside the package.

---
Generated: 2026-08-24 | Commit `baf15a54d`
