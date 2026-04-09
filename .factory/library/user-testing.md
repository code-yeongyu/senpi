# User Testing Surface

Runtime findings, isolation strategy, required tooling, and cost classification for user-testing validation in this mission.

**What belongs here:** Testing surface discovered during planning, resource-cost classification per surface, fixtures/infrastructure created by the user-testing validator, gotchas encountered when driving tests.

---

## Testing surfaces

This mission has three distinct testing surfaces:

### 1. Vitest automated surface (primary)

**Where:** `packages/coding-agent/test/suite/` via `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run`.

**Coverage:** the vast majority of validation contract assertions — unit tests for the config resolver, prompt builder, state helpers; integration tests against the faux provider for the agent loop; golden-file snapshots for the task management section and continuation prompt.

**Cost:** cheap. Runs in seconds on a typical dev machine. Can be parallelized.

**Isolation:** the existing harness uses `SessionManager.inMemory()`, `SettingsManager.inMemory()`, and `AuthStorage.inMemory()`, plus a per-harness temp directory. Each test's harness is independently cleaned up via `harness.cleanup()`. No shared mutable state between tests as long as extensions don't use module-level globals (which is exactly why the architecture uses closure-scoped state).

**Tool:** `vitest` via the `test-coding-agent` command in `.factory/services.yaml`.

### 2. Manual CLI surface (--help, --print)

**Where:** `./pi-test.sh` (dev-mode CLI wrapper) and the built `dist/cli.js` after `npm run build`.

**Coverage:** CLI flag surface (`--disable-todo-continuation` visible in help), non-interactive mode bypass (`--print` does not inject continuation), dev-wrapper pass-through.

**Cost:** low. A single `./pi-test.sh --help` runs in ~1 second.

**Isolation:** runs against whatever the current working directory is. Manual CLI features should run from a scratch directory inside `local-ignore/` when they might pollute settings.

**Tool:** `manual-cli`.

### 3. Manual tmux TUI surface

**Where:** interactive TUI mode via `./pi-test.sh` inside a tmux session.

**Coverage:** the last four `VAL-CROSS-*` assertions — end-to-end visual confirmation of continuation injection in a real interactive session with a real provider.

**Cost:** high. Requires a real provider (user's auth.json), a tmux session, and a human (or automated tmux driver) to confirm visual behavior. Uses real model tokens. Expect 1-3 minutes per scenario.

**Isolation:** each manual-tmux feature starts a fresh tmux session and captures scrollback to `local-ignore/qa-*.log`. Settings file fixtures created during the test must be cleaned up after capture so the next test starts fresh.

**Tool:** `manual-tmux`.

## Isolation strategy

### Per-session state isolation (in-process tests)
The continuation runtime must scope all mutable state to a closure-owned Map. Integration test VAL-CONTINUATION-025 explicitly verifies that two concurrent harness sessions do not leak state across each other. If a worker accidentally introduces module-level `let currentSessionState = ...`, both VAL-CONTINUATION-025 and all the integration tests that share the same process will flake unpredictably.

### Settings isolation
- Unit tests pass settings objects as plain literals to the pure resolver.
- Integration tests use `SettingsManager.inMemory({ todotools: { continuation: { enabled: ... } } })` via the harness.
- Manual tmux QA uses real `.pi/settings.json` files — always clean up after capture.

### Todo state isolation
The existing todowrite extension already handles branch-scoped todo state via `SessionManager.getBranch()`. The refactor preserves this. No changes needed.

## Required testing tools

- **Vitest** (unit + integration) — already installed.
- **tsgo** — already installed as `@typescript/native-preview`.
- **Biome** — already installed at 2.3.5.
- **ripgrep** — needed for grep-check assertions. Install if missing (`brew install ripgrep` or system package manager).
- **tmux** — needed for manual-tmux features only.

## Gotchas discovered during planning

1. The existing `test/suite/todowrite-extension.test.ts` is **already broken** before this mission starts — it references `.pi/extensions/todowrite.ts` which does not exist in the repo. The `refactor-todotools-folder` feature fixes this as part of the import-path update scope.

2. `SettingsManager.Settings` interface does NOT include `todotools`. The config resolver MUST use `Record<string, unknown>` casting and narrow explicitly — widening the upstream interface is forbidden per the fork strategy.

3. `harness.ts` in `test/suite/` does not currently instrument `ExtensionAPI.sendUserMessage`. The `continuation-harness-observability` feature adds the helper needed for integration test assertions. All subsequent continuation integration tests depend on this helper.

4. `agent_end` fires even for aborted agents (emitted unconditionally by `agent-session.ts`). The runtime must detect abort via `event.messages` last assistant's `stopReason`. This is why VAL-CONTINUATION-017 and VAL-CONTINUATION-020 exist.

5. Non-interactive modes (`--print`, `rpc`) exit after one cycle — if continuation fires there, the follow-up is never delivered and the design becomes confusing. VAL-CROSS-020 pins the bypass.

## Validation Concurrency

Use these ceilings unless current machine load is materially worse than what was observed during planning.

| Surface | Max concurrent validators | Why |
| --- | --- | --- |
| `manual-fs-check` / `grep-check` | 2 | Read-only filesystem checks are cheap and do not interfere with each other. |
| `vitest` automated surface | 1 | Vitest runs share the same repo, temp/build outputs, and test harness resources; serialize to avoid noisy contention. |
| `manual-cli` | 1 | Low cost, but these assertions are few and don't benefit meaningfully from parallel runs. |
| `manual-tmux` | 1 | Interactive and provider-backed; always serialize. |

For the `refactor` milestone specifically, run at most **2 validators total** at once: one static validator (`manual-fs-check` / `grep-check`) and one automated validator (`vitest`).

For the `continuation-core` milestone specifically, run at most **2 validators total** at once: one `vitest` validator plus one lightweight static or CLI validator. Do **not** run two Vitest validators concurrently.

## Flow Validator Guidance: manual-fs-check

- Stay read-only.
- Use `LS`, `Glob`, `Read`, and `Grep` style checks; do not edit repo files.
- Safe scope for `refactor`: verify the `todotools/` layout, builtin registration path/id, absence of legacy imports, and absence of forbidden type suppressions.
- Do not treat unrelated untracked files under `.pi/` or `.sisyphus/` as failures.

## Flow Validator Guidance: vitest

- Stay within the existing repo and test harness; do not modify source or test files.
- Use the faux-provider-based coding-agent tests only; no real network/provider calls.
- For `refactor`, prefer the focused suite files first:
  - `packages/coding-agent/test/suite/todowrite-extension.test.ts`
  - `packages/coding-agent/test/suite/task-management-section.test.ts`
- If broader verification is needed, run repo-level `npm run check` and/or the coding-agent Vitest suite, but account for the mission-documented pre-existing failures only.
- Treat the known pre-existing failures listed in mission `AGENTS.md` as non-blocking unless any new failure appears outside that allowlist.

## Flow Validator Guidance: grep-check

- Stay read-only and limit work to static repo/mission inspection.
- Use `rg`, `git status`, `git diff --name-only`, and file reads to verify source-level assertions such as flag registration, event wiring, allow-listed diff scope, and changelog/help text presence.
- For `continuation-core`, this surface owns the static assertions around `agent_end` registration, absence of `turn_end`, config purity, and fork/git-safety audit evidence.
- If current `main` has later non-mission commits, do not rely on a raw `git diff <base>..HEAD` alone for mission audit assertions; reconstruct the mission-scoped commit/path set from mission logs (for example `progress_log.jsonl` worker-completed commit IDs) before judging allow-list compliance.
- Do not edit repository files or mission files from this surface.

## Flow Validator Guidance: manual-cli

- Stay within non-interactive CLI surfaces only: `node packages/coding-agent/dist/cli.js --help`, `./pi-test.sh --help`, `./pi-test.sh --disable-todo-continuation --help`, and `./pi-test.sh --print ...`.
- Run from the repo root unless a scratch directory under `local-ignore/` is explicitly needed for isolation.
- For `continuation-core`, this surface verifies help output, dev-wrapper flag pass-through, and the non-interactive continuation bypass.
- Do not use real provider-backed interactive sessions here; manual tmux assertions belong to the separate `manual-qa` milestone.
