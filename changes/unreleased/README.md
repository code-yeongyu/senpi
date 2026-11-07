# Change fragments

Every pull request writes its change-log entries into ONE file here, named for the PR:
`changes/unreleased/<pr-number>.md` (senpi#3610). Pull requests never edit an existing `changes.md` or a
package `CHANGELOG.md` `[Unreleased]` section: when every PR wrote to the same top lines, each merge into
`main` made the other open PRs conflict there.

One block per log, each starting with the log's path:

```md
<!-- changes-log: packages/ai/src/api/changes.md -->
## 2026-10-20 - Anthropic bodies are gzip-compressed (senpi#3643)

### What changed

- `packages/ai/src/api/anthropic-messages.ts`: ...

### Why

- ...

### Why an extension could not handle it

- ...

### Expected merge conflict zones

- LOW: ...

<!-- changes-log: packages/ai/CHANGELOG.md -->
### Fixed
- Anthropic request bodies are gzip-compressed where the endpoint accepts it ([#3643](https://github.com/code-yeongyu/senpi/pull/3643))
```

- A tracker block names an existing `changes.md` and holds a dated `## ` entry; the gate counts it as that
  tracker's coverage, with the same four canonical sections.
- A changelog block names a package `CHANGELOG.md` from `scripts/release-changelog.mjs` and holds
  `### Breaking Changes|Added|Changed|Fixed|Removed` plus bullets; the gate counts it as that package's entry.
- Fragments are immutable once merged. Only `scripts/release.mjs` compiles them at the release cut,
  on the pinned tree when `--sha` is set. Before stamping, it prepends
  tracker entries newest PR first, appends changelog bullets to their `[Unreleased]` section, and deletes the
  fragments. Do not commit standalone compilation to `main`: it would leave shipped bullets in
  `[Unreleased]` when a pinned release merges back. Preview with
  `node scripts/sync-changes-fragments.mjs compile --dry-run`.
- Convert a branch that still edits the logs directly: `node scripts/sync-changes-fragments.mjs from-diff --base origin/main --pr <n>`, then commit.
