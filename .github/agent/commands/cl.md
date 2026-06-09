---
description: Audit changelog entries before release
---
Audit changelog entries for all commits since the last release.

## Process

1. **Find the last release tag:**
   ```bash
   git tag --sort=-version:refname | head -1
   ```

2. **List all commits since that tag:**
   ```bash
   git log <tag>..HEAD --oneline
   ```

3. **Read each package's [Unreleased] section:**
   - packages/ai/CHANGELOG.md
   - packages/agent/CHANGELOG.md
   - packages/tui/CHANGELOG.md
   - packages/web-ui/CHANGELOG.md
   - packages/coding-agent/CHANGELOG.md

4. **For each commit, check:**
   - Skip: changelog updates, doc-only changes, release housekeeping, upstream-sync merge commits themselves.
   - Skip: changes to generated model catalogs (for example `packages/ai/src/models.generated.ts`, `packages/ai/src/image-models.generated.ts`) unless accompanied by an intentional product-facing change in non-generated source/docs.
   - Determine which package(s) the commit affects (use `git show <hash> --stat`).
   - Verify a changelog entry exists in the affected package(s).
   - For external contributions (PRs), verify format: `Description ([#N](url) by [@user](url))`.

5. **Cross-package duplication rule:**
   Changes in `ai`, `agent` or `tui` that affect end users should be duplicated to the `coding-agent` changelog, since coding-agent is the user-facing package that depends on them.

6. **Report:**
   - List commits with missing entries.
   - List entries that need cross-package duplication.
   - Add any missing entries directly under `## [Unreleased]`.

## Changelog Format Reference

Sections (in order):
- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

Attribution:
- Internal: `Fixed foo ([#123](https://github.com/code-yeongyu/senpi/issues/123))`
- External: `Added bar ([#456](https://github.com/code-yeongyu/senpi/pull/456) by [@user](https://github.com/user))`

## Rules

- Before adding entries, read the full `[Unreleased]` section to see which subsections already exist.
- New entries ALWAYS go under `## [Unreleased]`.
- Append to existing subsections (e.g. `### Fixed`); do not create duplicates.
- NEVER modify already-released version sections. Each version section is immutable once released.
