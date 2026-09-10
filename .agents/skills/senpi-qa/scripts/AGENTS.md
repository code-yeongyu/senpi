# QA Drivers

## OVERVIEW

Channel entry points and focused probes; score 12, a distinct executable-driver domain above the shared library and regression scenarios.

## WHERE TO LOOK

| Task | Driver | Contract |
|---|---|---|
| Headless liveness / prompt events | `rpc-drive.mjs` | `--state`, `--prompt`, `--self-test` |
| Deterministic provider/tool loop | `mock-loop.mjs` | Three API presets; tool, MCP, retry and reasoning cases |
| Interactive boot and composer input | `tui-smoke.mjs` | node-pty; `--driver tmux` selects the POSIX alternative |
| Offline flags and model listing | `cli-smoke.mjs` | No model turn needed |
| Persistent terminal runtime | `pty-drive.mjs` | Native PTY or `--force-pipe` |
| First-byte steering and transport recovery | `mock-loop-stream-start-timeout-steering.mjs`, `mock-loop-transport-timeout-recovery.mjs` | RPC scenarios with `--evidence-dir` |
| SDK query/session continuity | `claude-sdk-oauth-fullstack-probe.mjs` | Real SDK subprocess against loopback; `--matrix` selects continuity phases |
| New prompt presets on the wire | `gpt-6-astra-preset-mock-loop.mjs`, `glm-5.3-preset-mock-loop.mjs` | Capture the real CLI's model request, not just a rendered prompt fixture |
| Cursor CLI transport limits | `probes/cursor-cli/prompt-ceiling-probe.mjs` | `--out` report; `--self-test` exercises its local classifier logic |
| Cursor permissions / resume model swaps | `probes/cursor-cli/permissions-config-probe.mjs`, `probes/cursor-cli/resume-model-swap-canary.mjs` | Separate external-CLI investigations, not channel smoke tests |

## CONVENTIONS

- Run channel commands from the repository root; `../SKILL.md` owns the complete channel recipe.
- Most drivers use Node plus the shared tsx launcher; the Astra preset driver intentionally spawns source with its current Bun runtime.
- Full-stack OAuth continuity is hermetic despite its name; live OAuth spikes are separate entry points.
- Full-stack gate mode returns 1 on behavioral failure and 2 on infrastructure rejection; `--baseline` is observational, not a passing gate.
- Evidence options differ: `--evidence` is usually a slug, the two timeout drivers use `--evidence-dir`, and Cursor probes use `--out`.
- Prompt-ceiling probe's normal `--out` path prepares a temporary Cursor HOME from Keychain credentials. Its `--self-test` returns before that setup.

## COMMANDS

```bash
node .agents/skills/senpi-qa/scripts/rpc-drive.mjs --self-test
node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test
node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-fullstack-probe.mjs --matrix
bun .agents/skills/senpi-qa/scripts/gpt-6-astra-preset-mock-loop.mjs
```

## ANTI-PATTERNS

- Do not sweep every `.mjs` as an offline suite: executable bodies, runtime requirements, live credentials and exit contracts differ.
- Do not import `rpc-drive.mjs` for a client; its module body dispatches on argv. Import `lib/rpc-client.mjs` instead.
- Do not count TUI boot/render/input as proof of provider or loop correctness; those assertions belong in RPC/mock-loop runs.
- Do not interpret a baseline exit code of 0 as continuity success; inspect the verdict or use gate mode.
