# Changelog

## [Unreleased]

### Breaking Changes

- Renamed the backend from `@earendil-works/pi-storage-sqlite-node` to the session-backend identity and replaced
  the legacy schema with the lane-based `SessionRepo` contract; work-in-progress databases are not migrated.
- Adopted upstream's simplified session schema (`sessions`, `entries`, scalar and list values, `usage_ledger`,
  `branch_entries`, `branch_meta`). The fork-only lane, durable operation record, and fenced writer-lease storage
  modules were dropped with it; databases written by the previous fork schema are not migrated.

### Added

- Added bounded active-branch queries, shared sequence allocation, session statistics, and the parameterized `sql`
  template tag.

### Fixed

- `src/sqlite/repo.ts`: decode durable GPT-6 Astra `configuration_update` session entries with reasoning-effort
  validation.
- Applied filters, cursors, and limits in SQL; bounded log reads; added covering indexes; and made session
  inventory reads avoid writer claims while including current names.
- Adopted optional-chain narrowing for invalid fork targets so the new SQLite session backend passes the
  repository warning-as-error gate without changing its validation behavior.
- Kept the backend private and independently versioned while linking AI and agent as local test-only workspaces,
  preventing the root lock from downloading upstream runtime packages that Senpi does not ship through this backend.

### Removed

- Removed the fork-only `storage/lanes.ts`, `storage/records.ts`, `storage/facts.ts`, and `storage/writer-leases.ts`
  modules (lane-scoped operation records, global facts, and fenced writer leases) in favor of upstream's session
  repository. Nothing in the shipped `senpi` CLI consumed them; the backend stays private.
