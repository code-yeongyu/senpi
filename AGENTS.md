# Senpi Repository Guide

Generated: 2026-07-17
Commit: `92fc96389`
Branch: `main`

Metadata above records the source state used for this generation pass.

Senpi is an extension-first coding-agent monorepo. Keep changes scoped, preserve upstream mergeability, and read the nearest `AGENTS.md` plus every applicable `changes.md` before editing.

## MANDATORY EXECUTION PROTOCOLS — NON-NEGOTIABLE

### PROTOCOL 1 — EXPLICITLY REQUESTED MODIFICATIONS

**WHEN A PATCH MUST BE MADE TO THIS REPOSITORY AND THE USER HAS EXPLICITLY INSTRUCTED THE MODIFICATION, THE FOLLOWING SEQUENCE IS ABSOLUTE AND BINDING. EXECUTE EVERY STEP, IN THIS EXACT ORDER. SKIPPING, REORDERING, OR ABBREVIATING ANY STEP IS A DEFECT:**

1. **EXPLORE** — SURVEY THE CODEBASE FIRST. READ EVERY FILE, SYMBOL, AND TEST THE CHANGE TOUCHES BEFORE WRITING A SINGLE LINE.
2. **MAKE A PLAN** — WRITE A DECISION-COMPLETE PLAN BEFORE ANY IMPLEMENTATION. NO CODE BEFORE THE PLAN EXISTS.
3. **ADD TODOS IN ULTRA-DETAIL** — MIRROR EVERY ATOMIC STEP OF THE PLAN INTO THE TODO LIST. NO STEP IS TOO SMALL TO TRACK.
4. **MAKE A NEW WORKTREE** — NEVER IMPLEMENT IN THE SHARED WORKTREE. ALL IMPLEMENTATION HAPPENS IN A DEDICATED GIT WORKTREE.
5. **MAKE A PR AND WORK UNTIL IT GETS MERGED** — SHIP THROUGH A REVIEWER-READABLE PR AND DRIVE IT RELENTLESSLY UNTIL IT IS MERGED. AN UNMERGED PR IS UNFINISHED WORK.
6. **SET A GOAL AND RUN THE ULW LOOP** — REGISTER A BINDING GOAL AND EXECUTE UNDER THE ULW LOOP UNTIL EVERY SUCCESS CRITERION PASSES WITH CAPTURED EVIDENCE.
7. **MANAGE TODOS OBSESSIVELY** — UPDATE THE TODO LIST ON EVERY STATE TRANSITION, THE INSTANT IT HAPPENS. A STALE TODO LIST IS A DEFECT.

**DELIVERY STOP INVARIANT:** UNDER PROTOCOL 1, “PR OPENED” IS NEVER A VALID STOP CONDITION, GOAL SUCCESS CRITERION, OR FINAL TODO. DELIVERY ENDS ONLY WHEN GITHUB REPORTS `MERGED` AND THE TASK WORKTREE IS REMOVED. WHILE GATES ARE PENDING, KEEP MERGE/CLEANUP TODOS OPEN, MONITOR TO COMPLETION, THEN MERGE-COMMIT AND CLEAN UP BEFORE THE FINAL RESPONSE.

### PROTOCOL 2 — USER-REQUESTED PR REVIEWS

**WHEN THE USER REQUESTS A PR REVIEW, YOU MUST:**

1. **MAKE A NEW WORKTREE** — CREATE A DEDICATED GIT WORKTREE AND PULL THE PR BRANCH INTO IT. NEVER CHECK THE PR OUT IN THE SHARED WORKTREE.
2. **REVIEW INSIDE THAT WORKTREE** — RUN THE FULL REVIEW (READ, BUILD, TEST, QA) THERE.
3. **CLEAN UP WHEN THE REVIEW IS DONE** — THE MOMENT THE REVIEW IS FINISHED, REMOVE THE WORKTREE (`git worktree remove` THEN `git worktree prune`). A LEFTOVER REVIEW WORKTREE IS A DEFECT.

## STRUCTURE

| Area | Purpose |
|---|---|
| `packages/ai/` | Provider-neutral streaming, models, auth, API implementations |
| `packages/agent/` | Browser-safe agent loop plus optional Node harness |
| `packages/coding-agent/` | `senpi` CLI, sessions, extensions, RPC, interactive mode |
| `packages/tui/` | Differential terminal renderer and editor primitives |
| `packages/web-ui/` | Lit browser components, storage, sandboxed artifacts |
| `packages/server/` | Experimental daemon, IPC, RPC-process supervision |
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
| Add or change coding-agent tests | `packages/coding-agent/test/` |
| Add or change extension examples | `packages/coding-agent/examples/` |
| Change PTY behavior | `packages/pty/` and, for native behavior, `crates/senpi-pty/` |
| Add provider setup docs | `packages/ai/README.md` and `packages/coding-agent/docs/providers.md` |
| Change model/provider runtime | `packages/ai/src/models.ts`, `packages/ai/src/auth/`, `packages/ai/src/providers/` |
| Change eval prompt/rendering | `packages/senpi-codemode/src/prompt/` and `src/tool/` |
| Audit changelogs | `.github/agent/commands/cl.md` |
| Prepare a release | `scripts/release.mjs` and `scripts/release-packages.mjs` |

## CODE MAP

```text
Models/auth runtime -> packages/ai/src/models.ts + src/auth/ -> providers -> api
                                         |
Agent state -> packages/agent/src/agent-loop.ts
                                         |
CLI/session -> packages/coding-agent/src/core -> interactive | print | RPC
                                         |
Terminal UI -> packages/tui     Browser UI -> packages/web-ui
Persistent terminals -> packages/pty -> crates/senpi-pty
```

## COMMANDS

- Install or refresh dependencies: `npm install --ignore-scripts`.
- Full static validation after code changes: `npm run check`; it does not run tests.
- Full workspace tests when broad validation is justified: `npm test`.
- Narrow tests run from the package root using that package's test command.
- Never run `npm run dev` in this repository.

## CONVENTIONS

- Read files in full before broad edits. Prefer existing patterns and public extension APIs over new core behavior.
- TypeScript under `packages/*/src`, `packages/*/test`, and `packages/coding-agent/examples` must use erasable syntax. Avoid `any` and verify external types in `node_modules`.
- Imports are top-level by default. Inline or dynamic imports are forbidden except existing documented lazy/browser-safe boundaries such as `packages/ai/src/api/*.lazy.ts` and credential probes.
- Do not hardcode TUI keys. Add defaults to `packages/tui/src/keybindings.ts` or `packages/coding-agent/src/core/keybindings.ts`.
- Do not hand-edit `packages/ai/src/models.generated.ts`; update `packages/ai/scripts/generate-models.ts` and regenerate.
- Ask before removing intentional functionality. Backward compatibility is opt-in, not automatic.
- Changing fork-specific source behavior means reading the nearest `changes.md` first and updating it in the same verified increment, not in a follow-up.
- Each entry records what changed, why, why an extension couldn't do it, and the expected merge-conflict zones. Merges resolve these files to `ours`, so a stale entry misleads the next upstream sync.
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
- Review incoming PRs without switching this shared worktree; when the user requests a PR review, follow PROTOCOL 2 above (dedicated worktree, removed after the review).
- Commit format: `{feat,fix,docs}[(scope)]: concise message`; include `fixes #N` or `closes #N` when applicable.
- Normal work ships through a feature branch and reviewer-readable PR with evidence. Merge PRs with a merge commit, never squash or rebase merge.
- Resolve rebase conflicts only in files owned by the current session; otherwise abort and ask.

## RELEASE NOTES

- Releases use CalVer and lockstep-version ten packages listed in `scripts/release-packages.mjs`.
- Release only from clean `main` after changelog audit and local release smoke tests. `scripts/release.mjs` owns versioning, generated artifacts, checks, commits, tag, and push.
- Never rerun the release script after its tag is pushed; failed publishing is retried from the existing tag workflow.
