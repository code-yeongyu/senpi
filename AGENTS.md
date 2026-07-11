# Senpi Repository Guide

Generated: 2026-07-12
Commit: `0d776f916`
Branch: `main`

Metadata above records the source state used for this generation pass.

Senpi is an extension-first coding-agent monorepo. Keep changes scoped, preserve upstream mergeability, and read the nearest `AGENTS.md` plus every applicable `changes.md` before editing.

## STRUCTURE

| Area | Purpose |
|---|---|
| `packages/ai/` | Provider-neutral streaming, models, auth, API implementations |
| `packages/agent/` | Browser-safe agent loop plus optional Node harness |
| `packages/coding-agent/` | `senpi` CLI, sessions, extensions, RPC, interactive mode |
| `packages/tui/` | Differential terminal renderer and editor primitives |
| `packages/web-ui/` | Lit browser components, storage, sandboxed artifacts |
| `packages/neo/` | Independent Go TUI and TypeScript RPC bridge client |
| `packages/orchestrator/` | Experimental daemon, IPC, RPC-process supervision |
| `packages/pty/` | TypeScript PTY loader, sessions, registry, pipe fallback |
| `packages/senpi-codemode/` | Source-only persistent-kernel `eval` extension |
| `crates/senpi-pty/` | Rust/N-API native PTY implementation and ABI owner |
| `scripts/` | Build, validation, release, lock and environment tooling |
| `.agents/skills/senpi-qa/` | Required real-CLI QA harness and evidence contract |

## WHERE TO LOOK

| Task | Start here |
|---|---|
| Add a feature to the CLI | `packages/coding-agent/src/core/extensions/builtin/` |
| Change provider/API behavior | `packages/ai/src/api/` then `packages/ai/src/providers/` |
| Change agent-loop semantics | `packages/agent/src/agent-loop.ts` |
| Change interactive rendering | `packages/coding-agent/src/modes/interactive/` and `packages/tui/src/tui.ts` |
| Change app-server/RPC | `packages/coding-agent/src/modes/app-server/` or `packages/coding-agent/src/modes/rpc/` |
| Change PTY behavior | `packages/pty/` and, for native behavior, `crates/senpi-pty/` |
| Add provider setup docs | `packages/ai/README.md` and `packages/coding-agent/docs/providers.md` |
| Audit changelogs | `.github/agent/commands/cl.md` |
| Prepare a release | `scripts/release.mjs` and `scripts/release-packages.mjs` |

## CODE MAP

```text
Model/auth catalog -> packages/ai/src/providers -> packages/ai/src/api
                                         |
Agent state -> packages/agent/src/agent-loop.ts
                                         |
CLI/session -> packages/coding-agent/src/core -> interactive | print | RPC
                                         |
Terminal UI -> packages/tui     Browser UI -> packages/web-ui
Persistent terminals -> packages/pty -> crates/senpi-pty
Alternate TUI -> packages/neo -> coding-agent RPC protocol
```

## COMMANDS

- Install or refresh dependencies: `npm install --ignore-scripts`.
- Full static validation after code changes: `npm run check`; it does not run tests.
- Full workspace tests when broad validation is justified: `npm test`.
- Narrow tests run from the package root using that package's test command.
- Go validation: `go build ./...`, `go vet ./...`, `go test ./...` from `packages/neo/`; root coverage is `npm run check:neo`.
- Never run `npm run dev` in this repository.

## CONVENTIONS

- Read files in full before broad edits. Prefer existing patterns and public extension APIs over new core behavior.
- TypeScript under `packages/*/src`, `packages/*/test`, and `packages/coding-agent/examples` must use erasable syntax. Avoid `any` and verify external types in `node_modules`.
- Imports are top-level by default. Inline or dynamic imports are forbidden except existing documented lazy/browser-safe boundaries such as `packages/ai/src/api/*.lazy.ts` and credential probes.
- Do not hardcode TUI keys. Add defaults to `packages/tui/src/keybindings.ts` or `packages/coding-agent/src/core/keybindings.ts`.
- Do not hand-edit `packages/ai/src/models.generated.ts`; update `packages/ai/scripts/generate-models.ts` and regenerate.
- Ask before removing intentional functionality. Backward compatibility is opt-in, not automatic.
- Fork-specific source changes belong in the nearest `changes.md`; read it before rebasing or changing the same surface.
- Changelog edits are release/audit work only. Follow `.github/agent/commands/cl.md` and never edit released sections.

## QUALITY GATES

- Any runtime change under `packages/{ai,agent,coding-agent,tui}` requires scoped tests, `npm run check`, and real CLI QA through `.agents/skills/senpi-qa/`.
- Save QA receipts under `local-ignore/qa-evidence/<YYYYMMDD>-<slug>/`. No evidence means no commit or push.
- Evidence, logs, comments, and PR bodies must not contain tokens, credentials, auth headers, cookies, or raw environment dumps.
- Default/unit tests must not spend tokens or require real credentials. Coding-agent tests use the faux provider and `packages/coding-agent/test/suite/harness.ts`; AI live integration tests require explicit opt-in gating.
- Tests added or changed must be run directly until green. Issue regressions belong in `packages/coding-agent/test/suite/regressions/`.
- Documentation-only changes use focused document validators and `git diff --check`; they do not require runtime QA.

## DEPENDENCIES AND INFRA

- Treat dependency and lockfile diffs as code. Pin direct external dependencies exactly and use `--ignore-scripts` for install/lock refreshes.
- The lockfile hook allows workspace-metadata-only refreshes; other lockfile changes require explicit `PI_ALLOW_LOCKFILE_CHANGE=1` approval.
- Keep shared environment surfaces synchronized: dependency, Node, provider/env, QA-channel, build-command, and forwarded-port changes must update `scripts/devenv-setup.mjs`, `.devcontainer/devcontainer.json`, and related references together.
- Regenerate `packages/coding-agent/publish-deps.lock.json` with `node scripts/generate-coding-agent-shrinkwrap.mjs`; never replace it with `npm-shrinkwrap.json`.
- Dependencies with lifecycle scripts require package/version review and an explicit justified generator allowlist entry; never add one silently to pass the gate.

## GIT AND DELIVERY

- Multiple agents share this worktree. Stage only files changed in the current session with explicit `git add <path>` commands.
- Do not commit speculatively; commit only when the user asks or a delegated workflow already ends in commit/push.
- Never use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`, or force-push.
- Review incoming PRs without switching this shared worktree; inspect refs and diffs in place unless the user explicitly requests checkout.
- Commit format: `{feat,fix,docs}[(scope)]: concise message`; include `fixes #N` or `closes #N` when applicable.
- Normal work ships through a feature branch and reviewer-readable PR with evidence. Merge PRs with a merge commit, never squash or rebase merge.
- Resolve rebase conflicts only in files owned by the current session; otherwise abort and ask.

## RELEASE NOTES

- Releases use CalVer and lockstep-version eight packages listed in `scripts/release-packages.mjs`.
- Release only from clean `main` after changelog audit and local release smoke tests. `scripts/release.mjs` owns versioning, generated artifacts, checks, commits, tag, and push.
- Never rerun the release script after its tag is pushed; failed publishing is retried from the existing tag workflow.
