# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")
- When the user asks a question, answer it first before making edits or running implementation commands.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `TUI_KEYBINDINGS` (`packages/tui/src/keybindings.ts`) for editor/TUI bindings or `KEYBINDINGS` (`packages/coding-agent/src/core/keybindings.ts`) for app bindings so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not documentation changes): `npm run check` (get full output, no tail). Fix all errors, warnings, and infos before committing.
- Note: `npm run check` does not run tests.
- NEVER run: `npm run dev`
- `npm test` is allowed when the user asks for a full test run or when broad validation is needed.
- For narrow changes, prefer specific tests: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
- Run package-specific tests from the package root. Run `npm test` from the repo root when doing the full workspace test run.
- If you create or modify a test file, you MUST run that test file and iterate until it passes.
- When writing tests, run them, identify issues in either the test or implementation, and iterate until fixed.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` plus the faux provider. Do not use real provider APIs, real API keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` and name them `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, write the script to a temporary file (for example under `/tmp`) using `write`, run that file, edit it if needed, and remove it when it is no longer needed. Do not embed multi-line scripts directly in `bash` commands.
- Don't commit speculatively. Commit when the user asks, or when their task delegation continues a plan whose terminal step is commit/push (e.g. "마저진행해줘", "finish this", "계속해줘"). Treat such delegation as the ask — don't stall mid-plan to demand a literal "commit" keyword.

## QA is mandatory — ALWAYS, every time you touch `packages/{ai,agent,coding-agent,tui}`

> **If your change reaches the agent runtime, tools, sessions, providers, the TUI, or any user-facing surface, you MUST QA it. ALWAYS. EVERY TIME. NO EXCEPTIONS. There is no "too small to skip" and no "it obviously works".**

**A green `npm run check` is NOT QA. `npm test` green is NOT QA.** They prove unit contracts, not that the feature works. You MUST drive the real CLI and then **write the evidence to disk.** If there is no evidence file, the QA did not happen.

Run the `senpi-qa` skill (`.agents/skills/senpi-qa/`) and pick the channel by change scope (each script ships `--self-test`):
- Agent loop / tools / sessions / provider resolution / RPC → `scripts/rpc-drive.mjs`, plus `scripts/mock-loop.mjs` for a deterministic, zero-token full turn (covers baseUrl override for openai + anthropic).
- Interactive TUI / keybindings / rendering → `scripts/tui-smoke.mjs` (node-pty on Windows, tmux on POSIX).
- Any end-to-end agent turn without spending tokens → `scripts/mock-loop.mjs`.
- CLI flags / `--help` / `--print` / model listing → `scripts/cli-smoke.mjs`.

Every channel runs the CLI from source in an isolated sandbox and asserts the real `~/.senpi/agent/auth.json` is unchanged (QA needs no real key — the mock loop uses a local fake model). Capture artifacts to `local-ignore/qa-evidence/<YYYYMMDD>-<slug>/` (gitignored): the exact commands with their output, the proof every intended change landed on the real harness, and the isolation receipt. `SKILL.md` has the router and scripts index; the "Testing pi Interactive Mode with tmux" recipe below is the underlying tmux mechanism.

**NO EVIDENCE == NO QA == NO COMMIT == NO PUSH. Always. Every time. No exceptions.**

## Default workflow — work through a PR, with evidence, every time

Unless the user explicitly says otherwise (or it is an urgent must-fix-now hotfix), deliver every change as a pull request — never hand-commit normal work straight to `main`:

1. **Branch.** Cut a feature branch (or a git worktree) off `main`. Do not develop on `main`.
2. **Implement + QA with evidence.** Run the scoped `senpi-qa` channel(s) for what you touched and write the artifacts to `local-ignore/qa-evidence/<YYYYMMDD>-<slug>/`. That evidence is the gate, and it is what the PR must carry.
3. **Open an English, reviewer-readable PR** with `gh pr create`. The body must include:
   - **Summary**: user-facing change, reason, and before/after behavior.
   - **Changes**: reviewer-relevant groups, not a file dump.
   - **QA / Evidence**: for each command or manual action, the tested surface, observed result, saved artifact/log path, and why it is sufficient.
   - **Risks**: residual risks mapped to covering evidence and conclusion.
   - **Secret safety**: no raw secret-bearing logs, env dumps, tokens, auth headers, cookies, or private credentials; use sanitized excerpts or summaries.
   A PR without reviewer-readable QA/evidence is not ready to merge.
4. **Verify.** Wait for CI/checks, fix every finding, then re-run the scoped QA and refresh the evidence.
5. **Merge with a merge commit, ALWAYS.** Land it via `gh pr merge <number> --merge --delete-branch`, then push `main`. NEVER squash-merge or rebase-merge, even if a tool or GitHub default suggests it.
6. **Conflicts → the `smart-rebase` skill**, then re-run the scoped QA. Never force-push shared history.

## Dev environment (all harnesses)

- One idempotent setup for every harness (Claude Code, Codex, opencode, Cursor, VS Code Dev Containers, GitHub Codespaces): `node scripts/devenv-setup.mjs` (or `scripts/devenv-setup.sh` / `scripts/devenv-setup.ps1`). It installs deps, seeds `.env.local` from a provider key, and wires `.claude/skills -> ../.agents/skills`.
- Skill source of truth is `.agents/skills/`; harnesses are pointed at it via `.claude/skills` (local symlink), `opencode.json`, `.cursor/settings.json`, `.codex/setup.sh`, and `.devcontainer/devcontainer.json`. Credential injection per harness: `.agents/skills/senpi-qa/references/credential-injection.md`.

### Infra-sync obligation

Dev-environment infra is shared by every harness. Make the left-column change and its right-column updates in the SAME change, or other contributors' environments break:

| Change | Also update |
|---|---|
| Add/change an npm dep | `scripts/devenv-setup.mjs`, `.devcontainer/devcontainer.json`, `CONTRIBUTING.md` prerequisites |
| Change the Node version | `.devcontainer/devcontainer.json` image, package `engines`, `scripts/devenv-setup.mjs` check |
| Add a provider / env var | `packages/ai/src/env-api-keys.ts` (source of truth), `.agents/skills/senpi-qa/references/env-vars.md`, `.devcontainer/devcontainer.json` `secrets` |
| Add/change a QA channel or script | `.agents/skills/senpi-qa/SKILL.md` router + scripts index |
| Change a build command | `scripts/devenv-setup.mjs`, `.codex/setup.sh` / `.codex/cleanup.sh` |
| Change a forwarded port | `.devcontainer/devcontainer.json` `forwardPorts` |

## Contribution Triage

- Issues and PRs stay open for maintainer review.
- Issues and PRs that do not meet the quality bar in `CONTRIBUTING.md` may be closed without extended triage.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels to indicate which package(s) the issue affects
  - Available labels: `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`
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

- Your OWN changes always ship via a PR — see "Default workflow — work through a PR" above (branch → QA with evidence → `gh pr create` → merge commit). Do not hand-commit normal work straight to `main`.
- Reviewing an incoming contributor PR: analyze it without pulling locally first.
- If the user approves an incoming PR: create a feature branch, pull the PR, rebase on main, apply adjustments, commit, land it with a merge commit (`gh pr merge --merge`), push, close the PR, and leave a comment in the user's tone.

## Testing pi Interactive Mode with tmux

To test pi's TUI in a controlled terminal environment:

```bash
# Create tmux session with specific dimensions
tmux new-session -d -s pi-test -x 80 -y 24

# Start pi from source
tmux send-keys -t pi-test "cd <repo-root> && ./pi-test.sh" Enter

# Wait for startup, then capture output
sleep 3 && tmux capture-pane -t pi-test -p

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

- Before adding entries, read the full `[Unreleased]` section to see which subsections already exist
- New entries ALWAYS go under `## [Unreleased]` section
- Append to existing subsections (e.g., `### Fixed`), do not create duplicates
- NEVER modify already-released version sections (e.g., `## [0.12.2]`)
- Each version section is immutable once released

### Attribution

- **Internal changes (from issues)**: `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- **External contributions**: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Adding a New LLM Provider (packages/ai)

Adding a new provider requires changes across multiple files:

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
- Add the provider to the broader provider matrix where applicable: `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`, `context-overflow.test.ts`, `unicode-surrogate.test.ts`, `tool-call-without-result.test.ts`, `image-tool-result.test.ts`, `total-tokens.test.ts`, `cross-provider-handoff.test.ts`.
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

**CalVer versioning**: Versions are `YYYY.M.D` (e.g. `2026.6.10`), with a `-N` suffix for same-day re-releases (e.g. `2026.6.10-2`). `scripts/release.mjs` computes the next version via `scripts/calver.mjs`; pass `--version <v>` for an explicit override and `--dry-run` to preview every command and file write without modifying anything.

### Steps

1. **Update CHANGELOGs**: Run the `/cl` prompt yourself on the latest commit on `main` to audit and update each package's `[Unreleased]` section before releasing. If `/cl` is unavailable, run the changelog audit steps manually: compare commits since the latest release tag against the package changelogs, add missing entries, and record the audit evidence before continuing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo so it cannot resolve workspace files:
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/senpi --help
   /tmp/pi-local-release/node/senpi --version
   /tmp/pi-local-release/node/senpi --list-models
   /tmp/pi-local-release/node/senpi -p "Say exactly: ok"
   /tmp/pi-local-release/node/senpi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/senpi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script writes the new CalVer version into all workspace package versions, regenerates release artifacts (model registry, shrinkwrap), stamps changelogs, runs `npm run check`, commits `release: vYYYY.M.D`, tags `vYYYY.M.D`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI publishes npm packages**: pushing the `vYYYY.M.D` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required.

5. **If CI publish fails**: inspect the failed `publish-npm` job. The publish helper is idempotent and skips package versions already present on npm, so rerun the tag workflow after fixing CI or transient npm issues. Do not rerun `npm run release` for the same version.

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

### If Rebase Conflicts Occur

- Resolve conflicts in YOUR files only
- If conflict is in a file you didn't modify, abort and ask the user
- NEVER force push

### User override

If the user instructions conflict with rules set out here, ask for confirmation that they want to override the rules. Only then execute their instructions.
