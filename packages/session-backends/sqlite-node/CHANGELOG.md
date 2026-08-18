# Changelog

## [Unreleased]

### Breaking Changes

- Renamed the backend from `@earendil-works/pi-storage-sqlite-node` to the session-backend identity and replaced
  the legacy schema with the lane-based `SessionRepo` contract; work-in-progress databases are not migrated.

### Added

- Added bounded active-branch queries, durable operation records, global facts, shared sequence allocation,
  session statistics, fenced writer leases, and the parameterized `sql` template tag.

### Fixed

- Applied filters, cursors, and limits in SQL; bounded log reads; added covering indexes; and made session
  inventory reads avoid writer claims while including current names.
- Adopted optional-chain narrowing for invalid fork targets so the new SQLite session backend passes the
  repository warning-as-error gate without changing its validation behavior.
- Kept the backend private and independently versioned while linking AI and agent as local test-only workspaces,
  preventing the root lock from downloading upstream runtime packages that Senpi does not ship through this backend.
