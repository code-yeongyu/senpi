# .agents/skills/senpi-qa

Manual QA harness for the senpi coding agent, driven from source in isolated sandboxes. `SKILL.md` is the operating manual (channels, golden rules, evidence contract); root `AGENTS.md` owns when QA is mandatory. This file maps the ~107-script codebase behind them.

## STRUCTURE

```text
SKILL.md                                 Channel manual; start here to run QA
scripts/*.mjs (32)                       Top-level drivers (rpc-drive, tui-smoke,
                                         mock-loop, cli-smoke, pty-drive) + focused QA
scripts/lib/ (42)                        Shared harness; common.mjs is the foundation
scripts/lib/*.test.mjs (4)               node:test units for lib helpers
scripts/scenarios/ (30 + helpers)        One-off runners; -qa checks, -repro bugs
scripts/scenarios/cursor-exec-lifecycle/ HTTP/2 + protobuf Cursor wire helpers
scripts/scenarios/cursor-oauth-catalog-refresh/setup.ts  Only TypeScript here; runs via tsx
scripts/probes/cursor-cli/ (3)           Cursor CLI canaries/probes
references/                              rpc-protocol, tui-driving, mock-loop,
                                         credential-injection, env-vars
evals/evals.json                         Structured eval cases
package.json + package-lock.json         Private dep island (node-pty only); stays out
                                         of the root lockfile and coding-agent shrinkwrap
```

## WHERE TO LOOK

| Task | Path |
|---|---|
| Run a channel / self-test suite | `SKILL.md` scripts index |
| Sandbox, CLI spawn, auth guard, evidence | `scripts/lib/common.mjs` |
| Provider presets, mock `models.json`, MCP fixtures | `scripts/lib/mock-loop-support.mjs` |
| Fake model server (three wire formats) | `scripts/lib/fake-model-server.mjs` |
| RPC clients for QA | `scripts/lib/rpc-client.mjs`, `rpc-qa-client.mjs`, `target-rpc-client.mjs` |
| New regression scenario | `scripts/scenarios/<name>-qa.mjs` + `--evidence <slug>` |
| Cursor CLI behavior | `scripts/probes/cursor-cli/`, `scripts/scenarios/cursor-*` |
| Env/credential rules | `references/env-vars.md`, `references/credential-injection.md` |

## CONVENTIONS

- ESM `.mjs` with explicit `node:` imports; relative imports carry extensions.
- Every executable ships `--self-test`/`--self-check`; a script is both tool and regression check.
- Isolation via `lib/common.mjs`: `makeSandbox`, `scrubSandboxEnv`, `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `guardRealAuth`.
- Drive the CLI from source through `tsxEntry()`; never assume built `dist`.
- Suffix taxonomy: `-qa` check, `-repro` bug reproduction, `-spike`/`-probe` gated exploration.
- Evidence to `local-ignore/qa-evidence/<YYYYMMDD>-<slug>/` via `--evidence`/`evidenceDir()`.
- Lib units use `node:test` + `node:assert/strict`, not Vitest.

## ANTI-PATTERNS

- Never read or write the real `~/.senpi`; snapshot `auth.json` sha256 and assert unchanged.
- Never inherit or log provider env/auth headers: scrub before spawn, `sanitizeRequests` before evidence.
- No `src/` edits from this skill — it verifies and reports; fixes are follow-up changes.
- No unbounded sleeps as synchronization; bounded observable waits and watchdogs only.
- Live external paths are opt-in gates (`SENPI_CURSOR_CLI_LIVE=1`, `SENPI_LIVE_CLAUDE_SDK_OAUTH=1`), never defaults.
- Never treat generated Cursor protobuf TypeScript as hand-authored wire logic.

## VALIDATION

- Setup once: `node scripts/devenv-setup.mjs`; harness check: `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`.
- Lib units: `node --test .agents/skills/senpi-qa/scripts/lib/` (runs the four `*.test.mjs`).
- A new script is not done until its own `--self-test` passes with evidence captured.
