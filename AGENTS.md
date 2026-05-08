# PROJECT KNOWLEDGE BASE

**Generated:** 2025-04-05
**Commit:** 907846ed
**Branch:** main

## OVERVIEW

Fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono). TypeScript monorepo for AI agent tooling: multi-provider LLM API, agent runtime, coding agent CLI, TUI library, web UI components, web UI components. Built with npm workspaces, tsgo (native TS compiler), Vitest.

## FORK STRATEGY (CRITICAL)

This repo is a **fork** of `upstream` ([badlogic/pi-mono](https://github.com/badlogic/pi-mono)). All work must minimize merge conflict surface with upstream.

- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- Do not preserve backward compatibility unless the user explicitly asks for it
- Never hardcode key checks with, eg. `matchesKey(keyData, "ctrl+x")`. All keybindings must be configurable. Add default to matching object (`DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`)
- NEVER modify `packages/ai/src/models.generated.ts` directly. Update `packages/ai/scripts/generate-models.ts` instead.

## Commands

- After code changes (not documentation changes): `npm run check` (get full output, no tail). Fix all errors, warnings, and infos before committing.
- Note: `npm run check` does not run tests.
- NEVER run: `npm run dev`, `npm run build`, `npm test`
- Only run specific tests if user instructs: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
- Run tests from the package root, not the repo root.
- If you create or modify a test file, you MUST run that test file and iterate until it passes.
- When writing tests, run them, identify issues in either the test or implementation, and iterate until fixed.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` plus the faux provider. Do not use real provider APIs, real API keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` and name them `<issue-number>-<short-slug>.test.ts`.
- NEVER commit unless user asks

## Contribution Gate

- New issues from new contributors are auto-closed by `.github/workflows/issue-gate.yml`
- New PRs from new contributors without PR rights are auto-closed by `.github/workflows/pr-gate.yml`
- Maintainer approval comments are handled by `.github/workflows/approve-contributor.yml`
- Maintainers review auto-closed issues daily
- Issues that do not meet the quality bar in `CONTRIBUTING.md` are not reopened and do not receive a reply
- `lgtmi` approves future issues
- `lgtm` approves future issues and rights to submit PRs

When creating issues:

- Add `pkg:*` labels to indicate which package(s) the issue affects
  - Available labels: `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`, `pkg:web-ui`
- If an issue spans multiple packages, add all relevant labels

When posting issue/PR comments:

- Write the full comment to a temp file and use `gh issue comment --body-file` or `gh pr comment --body-file`
- Never pass multi-line markdown directly via `--body` in shell commands
- Preview the exact comment text before posting
- Post exactly one final comment unless the user explicitly asks for multiple comments
- If a comment is malformed, delete it immediately, then post one corrected comment
- Keep comments concise, technical, and in the user's tone

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the commit message
- This automatically closes the issue when the commit is merged

## PR Workflow

- Analyze PRs without pulling locally first
- If the user approves: create a feature branch, pull PR, rebase on main, apply adjustments, commit, merge into main, push, close PR, and leave a comment in the user's tone
- You never open PRs yourself. We work in feature branches until everything is according to the user's requirements, then merge into main, and push.

## Testing pi Interactive Mode with tmux

To test pi's TUI in a controlled terminal environment:

```bash
# Create tmux session with specific dimensions
tmux new-session -d -s pi-test -x 80 -y 24

# Start pi from source
tmux send-keys -t pi-test "cd /Users/badlogic/workspaces/pi-mono && ./pi-test.sh" Enter

# Capture output
tmux capture-pane -t pi-test -p

# Send input
tmux send-keys -t pi-test "your prompt here" Enter

# Send special keys
tmux send-keys -t pi-test Escape
tmux send-keys -t pi-test C-o  # ctrl+o

# Cleanup
tmux kill-session -t pi-test
```

## Changelog

Location: `packages/*/CHANGELOG.md` (each package has its own)

### Format

Use these sections under `## [Unreleased]`:

- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

1. **Builtin extension-first**: All changes and feature additions MUST use pi-mono's [extension system](packages/coding-agent/docs/extensions.md). Add **builtin extensions** at `packages/coding-agent/src/core/extensions/builtin/` and register them in `builtin/index.ts`. These load automatically via `resource-loader.ts` without requiring `.pi/extensions/` or `~/.pi/agent/extensions/`.
2. **If extension is impossible**: Only then modify upstream source. When you do, create/update a `changes.md` in the affected subdirectory documenting:
   - What was changed and why
   - Which files were modified
   - Why the extension system couldn't handle this
   - Expected merge conflict zones on next upstream sync
3. **Remotes**: `origin` = `code-yeongyu/senpi-mono`, `upstream` = `badlogic/pi-mono`
4. **Sync**: Periodically rebase on upstream/main. Fewer core modifications = fewer conflicts.

### Extension Points Available

| Capability | Extension API | Example |
|------------|---------------|---------|
| Custom tools | `pi.registerTool()` | `examples/extensions/hello.ts` |
| Slash commands | `pi.registerCommand()` | `examples/extensions/commands.ts` |
| Keyboard shortcuts | `pi.registerShortcut()` | Extension docs |
| CLI flags | `pi.registerFlag()` | `examples/extensions/ssh.ts` |
| LLM providers | `pi.registerProvider()` | `examples/extensions/custom-provider-anthropic/` |
| Event interception | `pi.on("tool_call" \| "input" \| ...)` | `examples/extensions/permission-gate.ts` |
| UI customization | `pi.ui.setFooter()`, `setWidget()`, etc. | `examples/extensions/custom-footer.ts` |
| Custom renderers | `pi.registerMessageRenderer()` | Extension docs |

Extensions load from: builtin (`packages/coding-agent/src/core/extensions/builtin/`), `.pi/extensions/` (project-local), `~/.pi/agent/extensions/` (global), or `-e ./path.ts` (ad-hoc).

## STRUCTURE

```
senpi-mono/                         # Fork of badlogic/pi-mono
├── packages/
│   ├── coding-agent/               # Main CLI app (primary focus) - SEE packages/coding-agent/AGENTS.md
│   ├── ai/                         # Multi-provider LLM API - SEE packages/ai/AGENTS.md
│   ├── agent/                      # Agent runtime (tool calling, state)
│   ├── tui/                        # Terminal UI library (differential rendering)
│   ├── web-ui/                     # Lit-based web components for AI chat
├── scripts/                        # Release, version sync, browser smoke check
├── .github/                        # CI, PR gate, OSS weekend, contributor approval
└── local-ignore/                   # Local workspace (gitignored)
```

### 1. Core Types (`packages/ai/src/types.ts`)

- Add API identifier to `Api` type union (e.g., `"bedrock-converse-stream"`)
- Create options interface extending `StreamOptions`
- Add mapping to `ApiOptionsMap`
- Add provider name to `KnownProvider` type union

### 2. Provider Implementation (`packages/ai/src/providers/`)

Create provider file exporting:

- `stream<Provider>()` function returning `AssistantMessageEventStream`
- `streamSimple<Provider>()` for `SimpleStreamOptions` mapping
- Provider-specific options interface
- Message/tool conversion functions
- Response parsing emitting standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`)

### 3. Provider Exports and Lazy Registration

- Add a package subpath export in `packages/ai/package.json` pointing at `./dist/providers/<provider>.js`
- Add `export type` re-exports in `packages/ai/src/index.ts` for provider option types that should remain available from the root entry
- Register the provider in `packages/ai/src/providers/register-builtins.ts` via lazy loader wrappers, do not statically import provider implementation modules there
- Add credential detection in `packages/ai/src/env-api-keys.ts`

### 4. Model Generation (`packages/ai/scripts/generate-models.ts`)

- Add logic to fetch/parse models from provider source
- Map to standardized `Model` interface

### 5. Tests (`packages/ai/test/`)

- Always add the provider to `stream.test.ts` with at least one representative model, even if it reuses an existing API implementation such as `openai-completions`.
- Add the provider to the broader provider matrix where applicable: `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`, `context-overflow.test.ts`, `image-limits.test.ts`, `unicode-surrogate.test.ts`, `tool-call-without-result.test.ts`, `image-tool-result.test.ts`, `total-tokens.test.ts`, `cross-provider-handoff.test.ts`.
- For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (for example GPT and Claude), add at least one pair per family.
- For non-standard auth, create utility (e.g., `bedrock-utils.ts`) with credential detection.

### 6. Coding Agent (`packages/coding-agent/`)

- `src/core/model-resolver.ts`: Add default model ID to `defaultModelPerProvider`
- `src/core/provider-display-names.ts`: Add API-key login display name so `/login` and related UI show the provider for built-in API-key auth.
- `src/cli/args.ts`: Add env var documentation
- `README.md`: Add provider setup instructions
- `docs/providers.md`: Add setup instructions, env var, and `auth.json` key

### 7. Documentation

- `packages/ai/README.md`: Add to providers table, document options/auth, add env vars
- `packages/ai/CHANGELOG.md`: Add entry under `## [Unreleased]`

## Releasing

**Lockstep versioning**: All packages always share the same version number. Every release updates all packages together.

**Version semantics** (no major releases):

- `patch`: Bug fixes and new features
- `minor`: API breaking changes

### Steps

1. **Update CHANGELOGs**: Ensure all changes since last release are documented in the `[Unreleased]` section of each affected package's CHANGELOG.md

2. **Run release script**:
   ```bash
   npm run release:patch    # Fixes and additions
   npm run release:minor    # API breaking changes
   ```

The script handles: version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.

## **CRITICAL** Git Rules for Parallel Agents **CRITICAL**

Multiple agents may work on different files in the same worktree simultaneously. You MUST follow these rules:

### Committing

- **ONLY commit files YOU changed in THIS session**
- ALWAYS include `fixes #<number>` or `closes #<number>` in the commit message when there is a related issue or PR
- NEVER use `git add -A` or `git add .` - these sweep up changes from other agents
- ALWAYS use `git add <specific-file-paths>` listing only files you modified
- Before committing, run `git status` and verify you are only staging YOUR files
- Track which files you created/modified/deleted during the session
- It is always fine to include `packages/ai/src/models.generated.ts` in a commit alongside the actual files you want to commit

### Forbidden Git Operations

These commands can destroy other agents' work:

- `git reset --hard` - destroys uncommitted changes
- `git checkout .` - destroys uncommitted changes
- `git clean -fd` - deletes untracked files
- `git stash` - stashes ALL changes including other agents' work
- `git add -A` / `git add .` - stages other agents' uncommitted work
- `git commit --no-verify` - bypasses required checks and is never allowed

### Safe Workflow

```bash
# 1. Check status first
git status

# 2. Add ONLY your specific files
git add packages/ai/src/providers/transform-messages.ts
git add packages/ai/CHANGELOG.md

# 3. Commit
git commit -m "fix(ai): description"

# 4. Push (pull --rebase if needed, but NEVER reset/checkout)
git pull --rebase && git push
```

Build dependency order: `tui` -> `ai` -> `agent` -> `coding-agent` -> `mom` -> `web-ui` -> `pods`

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add LLM provider | `packages/ai/src/providers/` | 7-step checklist below |
| Add coding agent feature | Add builtin extension at `src/core/extensions/builtin/` | Register in `builtin/index.ts` |
| Modify core tools | `packages/coding-agent/src/core/tools/` | bash, read, write, edit, grep, find, ls |
| Extension system internals | `packages/coding-agent/src/core/extensions/` | types.ts (1450 lines), loader.ts, runner.ts |
| TUI components | `packages/coding-agent/src/modes/interactive/components/` | 35 files |
| Web UI components | `packages/web-ui/src/components/` | Lit web components |
| Session management | `packages/coding-agent/src/core/agent-session.ts` | Core session logic |
| Model resolution | `packages/coding-agent/src/core/model-registry.ts` | Built-in + custom models |
| Test harness (coding-agent) | `packages/coding-agent/test/suite/harness.ts` | Uses faux provider, no real APIs |
| Test harness (ai) | `packages/ai/src/providers/faux.ts` | Mock LLM provider |
| Release scripts | `scripts/release.mjs` | Lockstep versioning |
| Compaction core seams (v1) | `packages/coding-agent/src/core/changes.md` (Seam 3+4), `packages/coding-agent/src/core/compaction/changes.md` (Seam 2), `packages/coding-agent/src/core/extensions/changes.md` (Seam 1+3) | 4 surgical core modifications for unified compaction pipeline |

## CONVENTIONS

- **Indent**: 3 spaces (Biome enforced, `biome.json`)
- **Line width**: 120 chars
- **Compiler**: `tsgo` (`@typescript/native-preview`) for all packages except web-ui (uses `tsc`)
- **Lockstep versioning**: All packages share same version. `patch` = fixes + features, `minor` = breaking
- **No inline imports**: No `await import()`, no `import("pkg").Type`. Top-level imports only.
  - **Exception**: `packages/ai/src/env-api-keys.ts` and OAuth files MUST use inline imports (breaks browser/Vite builds otherwise)
- **Keybindings**: Never hardcode. Use `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`
- **No backward compat**: Unless user explicitly asks
- **Changelog**: Per-package `CHANGELOG.md`. Entries under `## [Unreleased]`. Never modify released sections.

## ANTI-PATTERNS (THIS PROJECT)

- `any` types (unless absolutely necessary)
- `git add -A` / `git add .` (multi-agent safety: only add YOUR files)
- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash` (destroys other agents' work)
- `git commit --no-verify` (never allowed)
- Running `npm run dev`, `npm run build`, `npm test` directly
- `sed`/`cat` to read files (use read tool with offset + limit)
- Committing without user request
- Emojis in commits, issues, PR comments, or code
- Modifying upstream code when extension system can handle it

## COMMANDS

```bash
npm install                    # Install all deps
npm run build                  # Build all packages (dependency order)
npm run check                  # Biome lint/format + tsgo type check + browser smoke + web-ui check
npm run verify:pms             # Fresh install + build under npm, bun, and pnpm in isolated temp dirs
npm run release:patch          # Release (fixes + features)
npm run release:minor          # Release (breaking changes)

# Tests (from PACKAGE ROOT, not repo root)
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts

# coding-agent test suite: use faux provider, never real APIs
# Regression tests: packages/coding-agent/test/suite/regressions/<issue>-<slug>.test.ts
```

This repo supports npm, bun, and pnpm as first-class package managers. Build output, install warnings, and bin linking must stay clean under all three. The `verify:pms` script snapshots the current working tree into isolated temp dirs and runs install + build for each PM without touching local `node_modules`/`dist`.

## ADDING A NEW LLM PROVIDER (packages/ai)

7-step checklist:

1. **Core types** (`packages/ai/src/types.ts`): Add API id to `Api` union, create options interface, add to `ApiOptionsMap`, add to `KnownProvider`
2. **Provider impl** (`packages/ai/src/providers/`): `stream<Provider>()`, message conversion, response parsing
3. **Exports + lazy registration**: Subpath in `package.json`, re-exports in `index.ts`, lazy loader in `register-builtins.ts`, credential detection in `env-api-keys.ts`
4. **Model generation** (`packages/ai/scripts/generate-models.ts`)
5. **Tests** (`packages/ai/test/`): Add to stream.test.ts, tokens.test.ts, abort.test.ts, empty.test.ts, context-overflow.test.ts, image-limits.test.ts, unicode-surrogate.test.ts, tool-call-without-result.test.ts, image-tool-result.test.ts, total-tokens.test.ts, cross-provider-handoff.test.ts
6. **Coding agent** (`packages/coding-agent/`): `model-resolver.ts` DEFAULT_MODELS, `args.ts` env var docs, README
7. **Documentation**: ai README, ai CHANGELOG

## GITHUB WORKFLOW

- **Issues**: Always read all comments. Use `gh issue view <n> --json title,body,comments,labels,state`
- **Labels**: `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:mom`, `pkg:pods`, `pkg:tui`, `pkg:web-ui`
- **PR gate**: Auto-closes PRs from non-approved contributors (`.github/APPROVED_CONTRIBUTORS`)
- **OSS weekend**: Script `scripts/oss-weekend.mjs` toggles auto-close for issues
- **Commits**: Include `fixes #<n>` or `closes #<n>`. Never use `-A` or `.` for staging.
- **Comments**: Write to temp file, use `--body-file`. No multi-line `--body` in shell.

## GIT SAFETY (PARALLEL AGENTS)

Multiple agents may work simultaneously. Rules:
- **ONLY** commit files YOU changed in THIS session
- `git add <specific-files>` only
- Forbidden: `reset --hard`, `checkout .`, `clean -fd`, `stash`, `add -A`, `commit --no-verify`, force push
- Rebase conflicts in files you didn't modify: abort and ask user

## NOTES

- `npm run check` requires `npm run build` first (web-ui needs compiled `.d.ts` from deps)
- CI installs system deps: libcairo2-dev, libpango1.0-dev, ripgrep, fd-find
- CI runs a matrix of npm/bun/pnpm for install + build; `check` and `test` still run on the npm entry only
- Binary builds use Bun (v1.2.20) for cross-platform compilation
- Pi philosophy: no built-in MCP, sub-agents, permission popups, plan mode, or todos. All implementable via extensions.
- `web-ui` excluded from root tsconfig (handled separately)
- Pre-commit hook runs `npm run check`, conditional browser smoke, and (when package-manager-affecting files are staged) `npm run verify:pms`. Set `SENPI_SKIP_PM_VERIFY=1` to skip the multi-PM check locally; CI still enforces it.
