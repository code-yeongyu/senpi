# PROJECT KNOWLEDGE BASE

**Generated:** 2025-04-05
**Commit:** 907846ed
**Branch:** main

## OVERVIEW

Fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono). TypeScript monorepo for AI agent tooling: multi-provider LLM API, agent runtime, coding agent CLI, TUI library, web UI components, Slack bot, GPU pod manager. Built with npm workspaces, tsgo (native TS compiler), Vitest.

## FORK STRATEGY (CRITICAL)

This repo is a **fork** of `upstream` ([badlogic/pi-mono](https://github.com/badlogic/pi-mono)). All work must minimize merge conflict surface with upstream.

### Rules

1. **Builtin extension-first**: All changes and feature additions MUST use pi-mono's [extension system](packages/coding-agent/docs/extensions.md). Add **builtin extensions** at `packages/coding-agent/src/core/extensions/builtin/` and register them in `builtin/index.ts`. These load automatically via `resource-loader.ts` without requiring `.pi/extensions/` or `~/.pi/agent/extensions/`.
2. **If extension is impossible**: Only then modify upstream source. When you do, create/update a `changes.md` in the affected subdirectory documenting:
   - What was changed and why
   - Which files were modified
   - Why the extension system couldn't handle this
   - Expected merge conflict zones on next upstream sync
3. **Remotes**: `origin` = `code-yeongyu/sanepi-mono`, `upstream` = `badlogic/pi-mono`
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
sanepi-mono/                        # Fork of badlogic/pi-mono
├── packages/
│   ├── coding-agent/               # Main CLI app (primary focus) - SEE packages/coding-agent/AGENTS.md
│   ├── ai/                         # Multi-provider LLM API - SEE packages/ai/AGENTS.md
│   ├── agent/                      # Agent runtime (tool calling, state)
│   ├── tui/                        # Terminal UI library (differential rendering)
│   ├── web-ui/                     # Lit-based web components for AI chat
│   ├── mom/                        # Slack bot delegating to coding agent
│   └── pods/                       # vLLM deployment on GPU pods
├── scripts/                        # Release, version sync, browser smoke check
├── .github/                        # CI, PR gate, OSS weekend, contributor approval
└── local-ignore/                   # Local workspace (gitignored)
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
npm run release:patch          # Release (fixes + features)
npm run release:minor          # Release (breaking changes)

# Tests (from PACKAGE ROOT, not repo root)
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts

# coding-agent test suite: use faux provider, never real APIs
# Regression tests: packages/coding-agent/test/suite/regressions/<issue>-<slug>.test.ts
```

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
- Binary builds use Bun (v1.2.20) for cross-platform compilation
- Pi philosophy: no built-in MCP, sub-agents, permission popups, plan mode, or todos. All implementable via extensions.
- `web-ui` excluded from root tsconfig (handled separately)
- Pre-commit hook runs `npm run check` + conditional browser smoke test
