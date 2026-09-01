# Senpi Repository Guide

Generated: 2026-08-24
Commit: `baf15a54d`
Branch: `initdeep-refresh-20260824`

Senpi is an extension-first coding-agent monorepo. Keep changes scoped, preserve upstream mergeability, and read the nearest `AGENTS.md` plus every applicable `changes.md` before editing.

## MANDATORY EXECUTION PROTOCOLS — NON-NEGOTIABLE

### PROTOCOL 1 — EXPLICITLY REQUESTED MODIFICATIONS

**WHEN A PATCH MUST BE MADE TO THIS REPOSITORY AND THE USER HAS EXPLICITLY INSTRUCTED THE MODIFICATION, THE FOLLOWING SEQUENCE IS ABSOLUTE AND BINDING. EXECUTE EVERY STEP, IN THIS EXACT ORDER. SKIPPING, REORDERING, OR ABBREVIATING ANY STEP IS A DEFECT:**

1. **EXPLORE** — READ EVERY FILE, SYMBOL, AND TEST THE CHANGE TOUCHES BEFORE WRITING A SINGLE LINE.
2. **MAKE A PLAN** — A DECISION-COMPLETE PLAN EXISTS BEFORE ANY CODE.
3. **ADD TODOS IN ULTRA-DETAIL** — MIRROR EVERY ATOMIC PLAN STEP INTO THE TODO LIST.
4. **MAKE A NEW WORKTREE** — NEVER IMPLEMENT IN THE SHARED WORKTREE.
5. **MAKE A PR AND WORK UNTIL IT GETS MERGED** — AN UNMERGED PR IS UNFINISHED WORK.
6. **SET A GOAL AND RUN THE ULW LOOP** — EVERY SUCCESS CRITERION PASSES WITH CAPTURED EVIDENCE.
7. **MANAGE TODOS OBSESSIVELY** — UPDATE ON EVERY STATE TRANSITION. A STALE TODO LIST IS A DEFECT.

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
| `packages/protocol/`, `packages/server/`, `packages/client/` | Framed-CBOR wire protocol plus its server and client for remote sessions |
| `packages/telemetry/` | Vendor-neutral telemetry contracts and typed schema utilities |
| `packages/session-backends/` | Session backend adapters; `sqlite-node/` Node sqlite session store |
| `packages/evals/` | Model-backed eval suites over real `AgentSession`; spends tokens by design |
| `packages/pty/` | TypeScript PTY loader, sessions, registry, vendored prebuilds, pipe fallback |
| `packages/senpi-codemode/` | Source-only persistent-kernel `eval` extension (js/py/rb/jl kernels) |
| `crates/senpi-pty/` | Rust/N-API native PTY implementation and ABI owner |
| `scripts/` | Build, validation, release, lock and environment tooling |
| `bench/` | Benchmark baselines and improvement ledger (data only; run via `scripts/run-pr530-benchmarks.mjs`) |
| `.github/` | CI/release/issue automation plus committed merge and release agent drivers |
| `.agents/skills/senpi-qa/` | Required real-CLI QA harness; private dependency island outside the workspace |
| `local-ignore/` | QA evidence archive; gitignored except deliberately tracked historical receipts |

## WHERE TO LOOK

| Task | Start here |
|---|---|
| Add a feature to the CLI | `packages/coding-agent/src/core/extensions/builtin/` |
| Change provider/API behavior | `packages/ai/src/api/` then `packages/ai/src/providers/` |
| Change Cursor transport or exec bridging | `packages/ai/src/api/cursor-agent/`, `packages/coding-agent/src/core/cursor-exec-bridge.ts` |
| Change agent-loop semantics or the harness | `packages/agent/src/agent-loop.ts`, `packages/agent/src/harness/` |
| Change interactive rendering | `packages/coding-agent/src/modes/interactive/` and `packages/tui/src/` |
| Change app-server/RPC | `packages/coding-agent/src/modes/app-server/` or `.../modes/rpc/` |
| Add or change coding-agent tests or examples | `packages/coding-agent/test/`, `packages/coding-agent/examples/` |
| Change PTY behavior | `packages/pty/` and, for native behavior, `crates/senpi-pty/` |
| Change model/provider runtime or docs | `packages/ai/src/{models.ts,auth,providers}`, `packages/coding-agent/docs/providers.md` |
| Change compaction | mechanics in `packages/coding-agent/src/core/compaction/`; policy in `.../extensions/builtin/compaction/` |
| Change wire protocol or remote sessions | `packages/protocol/`, then consumers `packages/server/` and `packages/client/` |
| Change eval prompt/rendering | `packages/senpi-codemode/src/{prompt,tool,kernels}/` |
| Audit changelogs or prepare a release | `.github/agent/commands/cl.md`, `scripts/release.mjs`, `scripts/release-packages.mjs` |

## CODE MAP

Runtime flow: `ai` (models/auth -> providers -> api) feeds `agent/src/agent-loop.ts`, driven by `coding-agent/src/core` into interactive | print | RPC | app-server; `tui` renders, `pty` -> `crates/senpi-pty` runs terminals, `protocol` (framed CBOR) links `server` and `client`.

| Symbol / file | Role | Notes |
|---|---|---|
| `coding-agent/src/core/agent-session.ts` | Session runtime core | 8k LOC; highest-risk file in the repo |
| `coding-agent/src/modes/interactive/interactive-mode.ts` | Interactive loop | 8.5k LOC; components under `interactive/components/` |
| `agent/src/agent-loop.ts` | Browser-safe agent loop | Reached via `coding-agent/src/core/sdk.ts` |
| `coding-agent/src/core/extensions/builtin/index.ts` | `builtinExtensions` order | 39 entries, `mcp` last; the only authority on numbering |
| `ai/src/api/cursor-agent/gen/agent_pb.ts` | Generated protobuf-es | 19.6k LOC; regenerate, never hand-edit |
| `tui/src/index.ts` | Renderer barrel | Consumer coupling point for coding-agent and senpi-codemode |

## COMMANDS

- Install dependencies: `bun install --ignore-scripts`. After an approved dependency change, `bun run refresh-lock` (lockfile + registry metadata + shrinkwrap + install-lock).
- Full static validation after code changes: `bun run check` (biome, pinned-deps/ts-imports/shrinkwrap/install-lock checks, `check:claude-sdk-platform-lock`, `tsc --noEmit`, browser-smoke). It runs no tests; CI runs the same commands, so keep them in sync. Broad validation: `bun run test`.
- Narrow tests run from the package root using that package's test command. Runners differ: Vitest for `ai`, `coding-agent`, `senpi-codemode`, `server`, `session-backends`, `telemetry`; `node --test --import tsx` for `tui`; `node --test` for `scripts/` (`bun run test:scripts`) and `.agents/skills/senpi-qa/scripts/lib/`.
- App-server transport QA is its own channel: `bun run qa:app-server` (`packages/coding-agent/scripts/qa-app-server/`), not part of `bun run test`. Model catalog data: `bun run hydrate:model-data`, verified by `check:model-data`, from the repository root.
- Never run `bun run dev` in this repository.

## CONVENTIONS

- Read files in full before broad edits; prefer existing patterns and public extension APIs over new core behavior.
- TypeScript under `packages/*/src`, `packages/*/test`, and `packages/coding-agent/examples` must use erasable syntax. Avoid `any` and verify external types in `node_modules`.
- Imports are top-level by default. Inline or dynamic imports are forbidden except existing documented lazy/browser-safe boundaries such as `packages/ai/src/api/*.lazy.ts` and credential probes.
- Do not hardcode TUI keys; add defaults to `packages/tui/src/keybindings.ts` or `packages/coding-agent/src/core/keybindings.ts`.
- Never hand-edit generated sources: `packages/ai/src/{models,image-models}.generated.ts` and `src/providers/data/*.json` (regenerate via `packages/ai/scripts/generate-models.ts`), `packages/ai/src/api/cursor-agent/gen/agent_pb.ts` (`buf generate` + `scripts/transform-cursor-agent-proto.mjs`), `crates/senpi-pty/index.{js,d.ts}` (napi-rs), `packages/coding-agent/install-lock/*`, and `packages/coding-agent/src/modes/app-server/protocol/generated/`. Builtin extension registration order is authoritative only in `builtin/index.ts` — never quote a registration number from prose.
- Ask before removing intentional functionality; backward compatibility is opt-in, not automatic.
- Changing fork-specific source behavior means reading the nearest `changes.md` first and updating it in the same verified increment, not in a follow-up. Merges resolve tracker files to `ours`, so a stale entry misleads the next upstream sync.
- Changelog edits are release/audit work only: follow `.github/agent/commands/cl.md`, never edit released sections, and satisfy the changelog gate (`.github/workflows/changelog-gate.yml`) for both CHANGELOG.md and changes.md — see below.

## CHANGES.MD TRACKER POLICY

- Upstream ownership is pinned by `.github/upstream.json` (`badlogic/pi-mono` tag + sha): a production path in that pinned tree is upstream-owned; a path absent from it (and not a rename destination) is fork-only and exempt.
- Production scope is every changed path except: `changes.md` trackers and `.github/upstream.json`; lockfiles (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `Cargo.lock`, `*.lock`, `*.lock.json`); non-production metadata (`.gitignore`, `LICENSE`, `test.sh`); test/fixture/example/doc trees (`__tests__`, `tests`, `fixtures`, `examples`, `docs`) plus `*.test.*`/`*.spec.*`; `.md`/`.mdx`; and `*.generated.{ts,mts,cts,js}` sources.
- Every upstream-owned production path must be covered in its exact nearest ancestor `changes.md` — never a farther tracker — by an entry naming that exact repo-relative path under all four canonical headings: `What changed`, `Why`, `Why an extension could not handle it`, `Expected merge conflict zones`.
- Tracker coverage is independent of the release changelog: `no-changelog` waives only the CHANGELOG.md entry, never changes.md, and coverage never substitutes for a required CHANGELOG.md entry.
- A pin-sync PR — one that edits `.github/upstream.json` — exempts upstream-owned paths that exactly match the new pinned tree, but paths still divergent from the new pin are integration repairs and must gain coverage from tracker entries in the same PR.
- Enforcement: `scripts/check-pr-changelog.mjs` gates every PR through `.github/workflows/changelog-gate.yml` (counting only tracker entries the PR itself touches), and `scripts/audit-changes-md.mjs` audits the whole tree against the pin (`--format json|markdown`).

## QUALITY GATES

- Any runtime change under `packages/{ai,agent,coding-agent,tui,pty,senpi-codemode}` (the release-managed set) plus `crates/senpi-pty` requires scoped tests, `bun run check`, and real CLI QA through `.agents/skills/senpi-qa/`.
- Save QA receipts under `local-ignore/qa-evidence/<YYYYMMDD>-<slug>/`; no evidence means no commit or push. Evidence, logs, comments, and PR bodies must never contain tokens, credentials, auth headers, cookies, or raw environment dumps.
- Default/unit tests must not spend tokens or require real credentials; coding-agent tests use the faux provider and `packages/coding-agent/test/suite/harness.ts` (the legacy `test/test-harness.ts` must not be extended).
- Tests added or changed run directly until green. New coding-agent lifecycle tests go in `test/suite/`; issue regressions in `test/suite/regressions/<issue>-<slug>.test.ts`; the flat `test/*.test.ts` root cluster is legacy placement and must not grow.
- Test quarantine is a safety boundary: `test/setup.ts` forces `SENPI_CODING_AGENT_DIR` into a temp dir and always wins over an inherited value. Never reintroduce an `if (!process.env.SENPI_CODING_AGENT_DIR)` short-circuit — that once deleted a real user agent dir.
- Live/credentialed surfaces are opt-in only: `packages/ai/test/live-api-gates.ts` (`PI_ENABLE_*`), `packages/coding-agent/test/integration/` (`PI_RUN_INTEGRATION=1`), `packages/evals` (`bun run eval --provider X --model Y`). `packages/evals/.eval/` artifacts hold prompts and responses — treat as sensitive.
- Async tests subscribe before triggering, with bounded deadlines or fake timers; fixed sleeps survive only at genuine OS boundaries and must not be copied from legacy tests.
- Documentation-only changes use focused validators and `git diff --check`, not runtime QA — but `packages/coding-agent/docs/` ships in the tarball and is test-asserted, so doc edits there can fail CI.

## DEPENDENCIES AND INFRA

- Treat dependency and lockfile diffs as code: pin direct external dependencies exactly, use `--ignore-scripts` for install/lock refreshes. The pre-commit hook allows workspace-metadata-only refreshes; other lockfile changes require explicit `PI_ALLOW_LOCKFILE_CHANGE=1` approval.
- Keep shared environment surfaces synchronized: dependency, Node, provider/env, QA-channel, build-command, and forwarded-port changes must update `scripts/devenv-setup.mjs`, `.devcontainer/devcontainer.json`, and related references together, keeping root `package.json` workspaces and `pnpm-workspace.yaml` aligned with any workspace-package move or rename.
- Regenerate `packages/coding-agent/publish-deps.lock.json` with `bun scripts/generate-coding-agent-shrinkwrap.mjs`; never replace it with `npm-shrinkwrap.json`. Regenerate `packages/coding-agent/install-lock/` with `bun run install-lock:coding-agent`.
- External registry entries in root, publish, and installer locks must preserve both npm tarball `resolved` URLs and `integrity` hashes; incomplete merge results are invalid even when dependency topology still resolves.
- `@earendil-works/pi-telemetry` is a runtime dependency and must stay in Senpi's owned CalVer alias, publish, and bundle sets. `@earendil-works/pi-storage-sqlite-node` remains private and independently versioned because it is not reachable from the shipped coding-agent runtime.
- Dependencies with lifecycle scripts require package/version review and an explicit justified generator allowlist entry; never add one silently to pass the gate.

## GIT AND DELIVERY

- Multiple agents share this worktree. Stage only files changed in the current session with explicit `git add <path>`; do not commit speculatively — commit only when the user asks or a delegated workflow already ends in commit/push.
- Never use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`, or force-push. Review incoming PRs per PROTOCOL 2, never by switching this shared worktree.
- Commit format `{feat,fix,docs}[(scope)]: concise message` with `fixes #N` / `closes #N` when applicable. Normal work ships through a feature branch and reviewer-readable PR with evidence; merge with a merge commit, never squash or rebase merge.
- Resolve rebase conflicts only in files owned by the current session; otherwise abort and ask.

## RELEASE NOTES

- Releases use CalVer and lockstep-version the packages in `scripts/release-packages.mjs`; the pipeline runs `.github/agent/` drivers -> `scripts/release.mjs` -> `publish-npm.yml` -> `build-binaries.yml` / `native-prebuilds.yml`.
- Release only from clean `main` after changelog audit and release smoke tests; `scripts/release.mjs` owns versioning, generated artifacts, checks, commits, tag, and push.
- Never rerun the release script after its tag is pushed; failed publishing is retried from the existing tag workflow. Publishing is fork-scoped: `scripts/publish.mjs` rewrites private `@earendil-works/pi-*` packages into public `@code-yeongyu/senpi-*` manifests, and upstream names never appear on npm.

## NOTES

- Deep guidance lives in ~60 nested `AGENTS.md` files holding the file-level maps this root omits; read the nearest one before editing. `packages/coding-agent` is by far the largest package (~105k LOC with tests).
- `packages/ai` tests alias `@earendil-works/pi-telemetry` to telemetry source, so telemetry breakage fails AI tests. Node floors differ: packages require >=22.19.0, root and CI use Node 24.
- `packages/tui` uses tabs in source and its own `node --test` runner — do not apply coding-agent test habits there. `packages/coding-agent/bin/senpi` is only a symlink to built output; launcher logic lives in `src/cli.ts` / `src/bun-runtime.ts`.

## Review claim labels (merge-gating)

Three PR labels drive the review workflow; automation lives in `.github/workflows/review-claims.yml`:

- `will-review` — a reviewer claims the PR ("I will review this"). Applying it auto-requests the labeler as reviewer and BLOCKS merge via the required `Review claim gate` check.
- `in-review` — the claimer is actively reviewing. Same merge-blocking + auto-reviewer-request effects.
- `stale-review` — a claim sat 3+ days without the claimer's review; the sweep removes the claim labels and applies this one. A fresh claim clears it.

Rules:
- Apply `will-review` when you plan to review a PR; switch to `in-review` when you start.
- NEVER merge a PR carrying `will-review` or `in-review`; the gate check enforces this.
- Claim labels are removed automatically ONLY when the claimer (the person who applied the label) submits an approve or request-changes review. Do not remove someone else's claim label by hand.
- If a PR shows `stale-review`, it needs a (new) reviewer: claim it.
