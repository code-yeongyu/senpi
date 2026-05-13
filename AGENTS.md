# senpi

**Generated:** 2026-05-11 · **Commit:** 4b3f407d · **Branch:** main

## OVERVIEW

Opinionated fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono). TypeScript monorepo (npm workspaces, also bun + pnpm verified). Coding agent CLI is rebranded **senpi**. Extension-first philosophy: prefer extension over core source change; when core change is unavoidable, document it in a `changes.md` next to the modified files.

## STRUCTURE

```
senpi/
├── packages/
│   ├── ai/             # Multi-provider LLM API (@earendil-works/pi-ai)
│   ├── agent/          # Agent runtime + harness (@earendil-works/pi-agent-core)
│   ├── coding-agent/   # senpi CLI (senpi) — primary fork target
│   ├── tui/            # Differential renderer (@earendil-works/pi-tui)
│   ├── web-ui/         # Lit chat components (@earendil-works/pi-web-ui)
│   ├── mom/            # Empty stub (only dist/, tsconfig.json) — do not touch
│   └── pods/           # Empty stub (only dist/) — do not touch
├── scripts/            # build-all.mjs, release.mjs, verify-package-managers.mjs, etc.
├── .github/workflows/  # ci.yml, build-binaries.yml, pr-gate.yml, openclaw-gate.yml, issue-gate.yml, approve-contributor.yml
├── .husky/pre-commit   # npm run check (Biome+tsgo) + conditional verify:pms + browser-smoke
├── biome.json          # TAB indent (width 3), 120 line width
├── tsconfig.json       # noEmit root config + workspace path aliases
├── tsconfig.base.json  # ES2022/Node16, strict, decorators on
├── pi-test.sh          # Live-API integration runner (env-gated)
└── local-ignore/       # gitignored — DO NOT regenerate AGENTS.md inside
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add LLM provider | [`packages/ai/src/providers/`](packages/ai/src/providers/AGENTS.md) — 7-step checklist |
| Add text-format tool-call protocol (Hermes/XML/YAML) | [`packages/ai/src/tool-call-middleware/`](packages/ai/src/tool-call-middleware/AGENTS.md) |
| Add senpi tool/command/flag | builtin extension in [`packages/coding-agent/src/core/extensions/builtin/`](packages/coding-agent/src/core/extensions/AGENTS.md) |
| Add core senpi tool | [`packages/coding-agent/src/core/tools/`](packages/coding-agent/src/core/tools/AGENTS.md) — only if upstream parity required |
| Change senpi system prompt | [`packages/coding-agent/src/core/dynamic-prompt/`](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) (or extensions/builtin/prompt-preset/ for per-model) |
| Modify built-in extensions | [`packages/coding-agent/src/core/extensions/builtin/`](packages/coding-agent/src/core/extensions/builtin/AGENTS.md) — see per-extension AGENTS.md |
| Sub-agent / background-task work | [`packages/coding-agent/src/core/extensions/builtin/background-task/`](packages/coding-agent/src/core/extensions/builtin/background-task/AGENTS.md) |
| Permission system / external agent profiles | [`permission-system/`](packages/coding-agent/src/core/extensions/builtin/permission-system/AGENTS.md); agent profiles live in sibling repo `../pi-extensions/pi-agent-system` |
| Compaction policy | [`compaction/`](packages/coding-agent/src/core/extensions/builtin/compaction/AGENTS.md) (builtin extension; `core/compaction/` only holds constants) |
| Per-model prompt presets | [`prompt-preset/`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/AGENTS.md) |
| GPT `apply_patch` tool | [`gpt-apply-patch/`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/AGENTS.md) |
| Add TUI component | [`packages/coding-agent/src/modes/interactive/`](packages/coding-agent/src/modes/interactive/AGENTS.md) |
| Cross-cutting utility (git, shell, paths, image) | [`packages/coding-agent/src/utils/`](packages/coding-agent/src/utils/AGENTS.md) |
| Modify agent loop semantics | `packages/agent/src/agent-loop.ts` — see [`packages/agent/AGENTS.md`](packages/agent/AGENTS.md) |
| Modify renderer | `packages/tui/src/tui.ts` `doRender()` — see [`packages/tui/AGENTS.md`](packages/tui/AGENTS.md) |
| Document fork mod | new section in nearest existing `changes.md` (or create one alongside the modified file) |
| Run live-API tests | `./pi-test.sh` (gated by env vars; default `npm test` skips them) |

## FORK STRATEGY (CRITICAL)

Three-layer decision hierarchy before touching any upstream file:

1. **Can a builtin extension do it?** → add under `packages/coding-agent/src/core/extensions/builtin/<name>/` and register in `builtin/index.ts`.
2. **Can an external/user extension do it?** → ship under `packages/coding-agent/examples/extensions/` instead.
3. **Must modify upstream source?** → modify, then add a section to the nearest `changes.md` with: *what changed*, *why*, *why extension system couldn't handle it*, *expected merge-conflict zones*.

**`changes.md` is the merge-rebase contract.** Every fork-modified subdirectory has one. Tracked locations (do NOT remove):

- `packages/ai/{,src/,src/tool-call-middleware/}changes.md`
- `packages/agent/src/changes.md`
- `packages/coding-agent/{,src/,src/cli/,src/utils/}changes.md`
- `packages/coding-agent/src/core/{,compaction/,dynamic-prompt/,tools/}changes.md`
- `packages/coding-agent/src/core/extensions/{,builtin/{agent-system,compaction,permission-system,prompt-preset}/}changes.md`
- `packages/coding-agent/src/modes/interactive/changes.md`
- `packages/tui/src/changes.md`

## CONVENTIONS

- **Indent**: TAB character displayed at width 3 (Biome `indentStyle: "tab"`, `indentWidth: 3`). TS only — markdown is flexible.
- **Line width**: 120 (Biome).
- **Compiler**: `tsgo` (Microsoft's Go-based TS compiler) for ai/agent/coding-agent/tui builds and root `npm run check`. `tsc` is used only by web-ui (Lit decorator metadata that tsgo doesn't yet emit).
- **Workspaces**: `npm` is the source of truth (`package-lock.json` committed). `pnpm-workspace.yaml` and bun lockfiles also exist; `npm run verify:pms` exercises all three on PRs and on pre-commit when packaging files are staged.
- **Versioning**: CalVer lockstep across all 5 workspace packages — see `## VERSIONING & UPSTREAM SYNC` for the full policy.
- **Path aliases**: workspace internals use `@earendil-works/pi-*` (and `@code-yeongyu/senpi*` for the coding-agent). Defined in root `tsconfig.json`.
- **Tests**: Vitest across packages (TUI uses `node --test --import tsx`). Live-provider tests use `describe.skipIf(!process.env.<KEY>)` + `{ retry: 3 }`. `npm test` MUST pass with zero credentials.
- **Regression tests**: `packages/coding-agent/test/suite/regressions/<issue-number>-<slug>.test.ts`.
- **Husky pre-commit**: runs `npm run check`. Set `SENPI_SKIP_PM_VERIFY=1` to skip the multi-PM verify locally; CI still enforces it.
- **Biome excludes**: `models.generated.ts`, `test-sessions.ts`, `packages/web-ui/src/app.css`, `packages/mom/data/**`, `local-ignore/**`, `.worktrees/**` are NOT linted.

## VERSIONING & UPSTREAM SYNC

This fork uses **CalVer** (Calendar Versioning) with an explicit upstream sync pointer, distinct from the upstream `badlogic/pi-mono` semver line.

### Version format

- **First release of the day**: `YYYY.MM.DD` (e.g. `2026.05.13`).
- **Same-day re-release**: `YYYY.MM.DD-N` where N ≥ 2 (e.g. `2026.05.13-2`, `2026.05.13-3`). Note: there is no `-1`; the bare date IS the first release.
- All 5 workspace packages (`ai`, `agent`, `coding-agent`, `tui`, `web-ui`) are version-locked.
- Root `package.json` is `"private": true` and has NO `version` field.

### Version computation

`scripts/calver.mjs` computes the next version by:
1. Taking today's UTC date as `YYYY.MM.DD`.
2. Querying npm registry for existing versions of each workspace package.
3. Querying `git tag --list "v<today>*"`.
4. Returning `today` if no match, else `today-(maxN+1)`.

### Git tag and npm publish

- Git tag format: `v<version>` (e.g. `v2026.05.13`, `v2026.05.13-2`).
- `.github/workflows/build-binaries.yml` already triggers on `v*` — CalVer tags match.
- `npm publish` uses `--tag latest` explicitly because the `-N` suffix looks like a prerelease tag to npm and would otherwise NOT be picked up by `@latest`.

### Upstream pin

`.github/upstream.json` records the upstream commit currently merged into senpi:

```json
{
	"repo": "badlogic/pi-mono",
	"tag": "v0.74.0",
	"sha": "<full 40-char SHA>",
	"synced_at": "<ISO 8601 UTC>"
}
```

The `tag` is the most recent upstream `v*` tag reachable from `sha`. The pin is updated by both `scripts/sync-upstream.mjs` and the GitHub Action.

### Sync workflow

`.github/workflows/sync-upstream.yml`:
- Triggers: `schedule: cron '0 */6 * * *'` and `workflow_dispatch`.
- Compares `upstream/main` HEAD against `.github/upstream.json.sha`. Exits if equal.
- Else creates branch `sync/upstream-<short-sha>` and runs `git merge upstream/main --no-ff --no-commit`.

**Auto-resolution rules** (applied to conflicted files):

| Path pattern | Resolution |
|---|---|
| `bun.lock` | regenerate via `bun install` (or `git checkout --theirs` if bun unavailable) |
| `package-lock.json` | `git checkout --theirs` + `npm install` |
| `*.md` NOT named `changes.md` | `git checkout --theirs` |
| `changes.md` (any subdirectory) | `git checkout --ours` (preserve fork docs) |
| anything else with markers | LEFT UNRESOLVED |

**On clean merge**: commits `sync: merge upstream <short-sha> into main` + `sync: record upstream pin <short-sha>`, pushes directly to `main`.

**On unresolved conflicts**: closes any existing open PR labeled `sync-conflict` with comment `Superseded by upcoming sync from <new short-sha>`, then opens a NEW PR labeled `sync-conflict` from the branch with markers intact. The PR body lists each conflicting file with a recommended resolution.

### `changes.md` contract

Every fork-modified subdirectory MUST have a `changes.md` documenting what changed, why, and the expected merge-conflict zones. The sync workflow ALWAYS preserves `changes.md` files (resolves against `ours`), so fork-strategy docs survive upstream merges.

### Commit message conventions

| Subject | Meaning |
|---|---|
| `release: v<version>` | New senpi release (CalVer bump) |
| `sync: merge upstream <short-sha> into main` | Upstream merge (clean) |
| `sync: record upstream pin <short-sha>` | `.github/upstream.json` pointer update |
| `sync: WIP merge of upstream <short-sha> (conflicts)` | Branch commit before PR (conflict path) |

### Known limitation: `verify:pms` pnpm step

`npm run verify:pms` runs `pnpm install` in an isolated snapshot (lockfile-free) against the working tree. Until the current CalVer workspace version (e.g. `2026.05.13`) is **published to the npm registry**, pnpm fails with `ERR_PNPM_NO_MATCHING_VERSION` for the inter-workspace deps (`@earendil-works/pi-*@^<version>`).

Root cause: pnpm hits the npm registry first for caret ranges. The `workspace:` protocol does not help — pnpm's strict SemVer 2.0.0 parser rejects `2026.05.13` because `05` is a leading-zero numeric component (§ 2). `workspace:^`, `workspace:*`, and even `workspace:<exact-version>` all fail with `ERR_PNPM_NO_MATCHING_VERSION_INSIDE_WORKSPACE`. npm 11 itself does NOT support the `workspace:` protocol in install resolution (`EUNSUPPORTEDPROTOCOL` from `npm-package-arg`).

**Workaround during the pre-first-publish window:**
- Local commits: `SENPI_SKIP_PM_VERIFY=1 git commit ...` (already supported by the husky pre-commit hook).
- CI: keep `verify:pms` skipped (or `continue-on-error: true` for the pnpm matrix entry) until after the first CalVer release.

After the first CalVer release is published to npm via `npm run release`, pnpm fetches `^<version>` directly from the registry and the issue resolves itself. No code fix is needed at that point.

## ANTI-PATTERNS (THIS FORK)

- Modifying core source when an extension hook exists. Always check `packages/coding-agent/docs/extensions.md` capabilities first.
- Modifying core source without updating the relevant `changes.md`.
- Top-level imports in `packages/ai/src/env-api-keys.ts` or `src/utils/oauth/*` — breaks browser/Vite builds. The "NEVER convert to top-level imports" comment is load-bearing.
- Static imports in `packages/ai/src/providers/register-builtins.ts` — defeats lazy loading.
- Deleting failing tests to make CI green. Fix the code or, if upstream test is genuinely wrong for the fork, document the change in `changes.md`.
- Removing `models.generated.ts` from Biome excludes — it is regenerated by `scripts/generate-models.ts` on `prebuild`.
- Editing `local-ignore/` — gitignored, contains throwaway worktrees.
- Re-adding `uuid` to `packages/coding-agent/dependencies` — explicitly removed; UUIDv7 inlined in `src/core/session-manager.ts`. See `packages/coding-agent/changes.md` 2026-04-17.
- Touching `packages/{mom,pods}/dist/` stubs — committed solely to satisfy workspace bin-symlinking.
- Editing `CHANGELOG.md` (per `CONTRIBUTING.md` — maintainers only).

## COMMANDS

```bash
npm run dev              # Watch all packages concurrently
npm run build            # node scripts/build-all.mjs (npm by default)
npm run build:bun        # Force bun
npm run build:pnpm       # Force pnpm
npm run check            # Biome + tsgo + browser-smoke + web-ui check (pre-commit equivalent)
npm test                 # Vitest across workspaces (skips live-API)
./pi-test.sh             # Live-API integration suite (env-gated)
npm run verify:pms       # Validate npm/bun/pnpm install + build in isolated dirs
npm run profile:tui      # Profile TUI startup
npm run release:patch    # node scripts/release.mjs patch
```

## NOTES

- **CLI binaries**: build emits `senpi` and `pi` from `packages/coding-agent/dist/`. `scripts/create-root-senpi-wrapper.mjs` plants a callable `senpi` shim in npm's global `bin/` after a root build so `which senpi` resolves.
- **Self-update**: `senpi update senpi` queries `code-yeongyu/senpi` releases (NOT upstream). See `packages/coding-agent/src/changes.md`.
- **Empty packages**: `packages/mom/` and `packages/pods/` have no source — placeholders. The `.gitignore` keeps stub `dist/main.js` / `dist/cli.js` files committed so `npm install` does not warn about missing bin targets.
- **Live test gating**: many `packages/ai/test/*.test.ts` are gated by env (`PI_ENABLE_*`, `OPENROUTER_API_KEY`, AWS creds, etc.). The default `npm test` MUST pass without any of them set; failures there are real bugs.
- **TUI flicker budget**: `packages/tui/test/tui-render.test.ts` enforces "no full-clear after init" + "DECSET 2026 balanced" — see `packages/tui/AGENTS.md` before touching `doRender()`.
