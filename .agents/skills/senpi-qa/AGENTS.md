# .agents/skills/senpi-qa

Manual QA harness for the senpi coding agent, driven from source in isolated sandboxes. `SKILL.md` is the operating manual (channels, golden rules, evidence contract); root `AGENTS.md` owns when QA is mandatory. This file maps 121 script files behind them. Retained at score 13: a distinct QA domain with its own dependency configuration.

## STRUCTURE

```text
SKILL.md                                 Channel manual; start here to run QA
scripts/*.mjs (38)                       Top-level drivers (rpc-drive, tui-smoke,
                                         mock-loop, cli-smoke, pty-drive) + focused QA
scripts/lib/ (43, including tests)       Shared harness; common.mjs is the foundation
scripts/lib/*.test.mjs (4)               node:test units for lib helpers
scripts/scenarios/ (31 + 6 helpers)      One-off runners; -qa checks, -repro bugs
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
| Run a channel / self-test suite | `SKILL.md`; driver-specific map in `scripts/AGENTS.md` |
| Sandbox, CLI spawn, auth guard, evidence | `scripts/lib/common.mjs` |
| Provider presets, mock `models.json`, MCP fixtures | `scripts/lib/mock-loop-support.mjs` |
| Fake model server (three wire formats) | `scripts/lib/fake-model-server.mjs` |
| RPC clients for QA | `scripts/lib/rpc-client.mjs`, `scripts/lib/rpc-qa-client.mjs`, `scripts/lib/target-rpc-client.mjs` |
| New regression scenario | `scripts/scenarios/AGENTS.md`; runners have individual argument/evidence contracts |
| Cursor CLI behavior | `scripts/probes/cursor-cli/`, `scripts/scenarios/cursor-*` |
| Env/credential rules | `references/env-vars.md`, `references/credential-injection.md` |

## CONVENTIONS

- ESM `.mjs` with explicit `node:` imports; relative imports carry extensions.
- Channel drivers expose `--self-test`/`--self-check`; many focused scenarios execute their assertions directly instead.
- Isolation via `scripts/lib/common.mjs`: `makeSandbox`, `scrubSandboxEnv`, `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `guardRealAuth`; provider-key scrubbing is separate (`scripts/lib/AGENTS.md`).
- Drive the CLI from source, normally through `tsxEntry()`; never assume built `dist`. The GPT-6 Astra driver uses Bun directly.
- Suffix taxonomy: `-qa` check, `-repro` bug reproduction, `-spike`/`-probe` exploration; suffixes do not establish whether a run is hermetic.
- Evidence to `local-ignore/qa-evidence/<YYYYMMDD>-<slug>/` via `--evidence`/`evidenceDir()`.
- Lib units use `node:test` + `node:assert/strict`, not Vitest.

## ANTI-PATTERNS

- Never mutate real `~/.senpi` or use its credentials for default QA. `guardRealAuth()` reads the original auth file only to hash it; call `assertUnchanged()` after the run.
- Never inherit provider keys into mock runs or log auth headers: scrub before spawn and redact request evidence; sanitizers are local helpers, not a shared exported API.
- No `src/` edits from this skill — it verifies and reports; fixes are follow-up changes.
- Subscribe to the exact completion signal before triggering it, with a bounded watchdog; do not copy fixed-delay polling from legacy scenarios.
- Live external runs require explicit intent. Gates such as `SENPI_CURSOR_CLI_LIVE=1` and `SENPI_LIVE_CLAUDE_SDK_OAUTH=1` cover specific runners, not every probe; inspect its argument/auth path first.
- Never treat generated Cursor protobuf TypeScript as hand-authored wire logic.

## VALIDATION

- Setup once: `bun scripts/devenv-setup.mjs`; harness check: `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`.
- Lib units: `node --test .agents/skills/senpi-qa/scripts/lib/*.test.mjs` (four files; independent of root workspace tests).
- A new script is not done until its actual regression entry point passes with evidence captured; do not append an unsupported `--self-test` flag.
