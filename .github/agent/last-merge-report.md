# Upstream Merge Report

## Upstream

- Upstream repo: `badlogic/pi-mono`
- Latest upstream release tag: `v0.80.7`
- Release tag SHA: `818d67457cdd6b60bce6b121d16b23141c252dd8`
- Merged `upstream/main` SHA: `c6d8371521fc8357958bb21fd43552c15f46c7f4`
- Fork base SHA: `81c77f94d21449c28f87a7483ed36ba0b7650838`
- Merge commit: `1b32d5b76066af5eb5dd789ba7d31f0429b50c62`
- Pin commit: `dd8123f92`
- Changelog audit commits: `7b76f7fa7`, `cf0c28473`

## Preserved Fork Work

- Preserved the fork's CalVer release history, package identity, bundled workspace layout, and existing post-`v2026.7.14-3` GPT-5.6 prompt refinements.
- Retained `AuthStorage`, `ModelRegistry`, and their SDK options as compatibility facades while adopting upstream `ModelRuntime` as the canonical model/auth implementation.
- Retained extension OAuth callback types, provider display names, faux-provider registration, synchronous model configuration for legacy consumers, and configurable provider/model metadata used by the fork.
- Preserved fork compaction/session behavior and fixed automatic compaction to retain user, OMO steer, and goal follow-up messages appended while context is rebuilt.

## Conflicts Resolved

- Merged upstream provider-owned auth, OAuth, dynamic model catalogs, Cloudflare streams, Radius support, and lazy provider changes while retaining fork compatibility exports and adapters.
- Reconciled the new `ModelRuntime` architecture with fork SDK, extension, model-selector, auth-storage, and test-harness consumers.
- Preserved fork `models.json` capabilities for disabled providers, whitelists/blacklists, prompt presets, cache retention, service tiers, upstream model IDs, configured headers, and command-backed values.
- Kept fork documentation and released changelog history while restoring all applicable upstream `[Unreleased]` entries.
- Regenerated the tracked `packages/ai/dist/cli.js` output from the merged CLI source.

## Focused Fixes

- Added legacy model/auth compatibility facades and credential propagation across SDK-created sessions.
- Propagated configured SDK stream idle timeouts into agent construction.
- Preserved messages appended during automatic compaction when the original message prefix remains unchanged.
- Applied Biome's static-property-access cleanups required for a zero-diagnostic repository check.

## Changelog Audit

- Added `packages/ai` notes for provider-scoped auth, `Models`, `CredentialStore`, `ModelsStore`, Radius, Cloudflare endpoint resolution, lazy stream completion, compatibility exports, and OpenAI Codex session-ID limits.
- Added `packages/coding-agent` notes for `ModelRuntime`, retained compatibility APIs, async refresh/list migration, dynamic catalogs, `/model` refresh, compaction message preservation, SDK timeouts, inherited AI fixes, and Windows terminal-title restoration.
- Audited every non-merge commit since fork release tag `v2026.7.14-3`; no other package required a new `[Unreleased]` entry.

## QA

- `npm run build` passed.
- `npm run check` passed with zero errors, warnings, or infos.
- Hermetic `npm test` passed across the workspace: coding-agent 416 files / 3,611 tests; AI 111 files / 865 tests; all other package suites passed.
- Focused model-runtime, auth, SDK, middleware, and compaction regression tests passed.
- Final `test/auth-storage.test.ts` run passed 12/12.
- Senpi QA passed:
  - common isolation self-check: 9/9
  - RPC self-test: 4/4
  - deterministic mock loop: 5/5
  - CLI smoke: 7/7
  - tmux TUI smoke: 5/5
- Every QA channel verified the real `~/.senpi/agent/auth.json` remained unchanged.
- GitHub PR #212 passed the main check/test job, terminal-tool jobs on Ubuntu, macOS, and Windows, and GitGuardian before the documentation audit update; final CI was retriggered by the audit commits.
- Evidence: `local-ignore/qa-evidence/20260716-upstream-sync-release/`.

## Result

The branch is PR-ready after final CI and review gates complete.

MERGE_RESULT: CLEAN_PR_READY
