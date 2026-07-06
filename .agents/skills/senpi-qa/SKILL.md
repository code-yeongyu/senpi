---
name: senpi-qa
description: "Manual QA harness for the senpi coding agent itself. MUST USE after changing packages/ai, packages/agent, packages/coding-agent, or packages/tui — a green typecheck and `npm test` are NOT QA. Drives the real CLI from source in an isolated sandbox (never touches ~/.senpi or real credentials) across four channels: remote RPC (--mode rpc JSONL stdio), TUI smoke (node-pty on Windows, tmux on POSIX), mock loop (a local fake model server for deterministic, zero-token agent-loop runs), and CLI smoke (--help/--print/--list-models). Every helper ships a --self-test. Use whenever someone says qa senpi, test the agent, verify my change, rpc qa, tui qa, mock-loop qa, smoke the cli, or needs evidence that an agent-loop, tool, keybinding, or provider change works end to end. Capture evidence to local-ignore/qa-evidence/."
---

# senpi QA

QA the senpi coding agent (`packages/{ai,agent,coding-agent,tui}`) by driving the
REAL CLI — not by reading code or trusting unit tests. Each channel runs the
agent from source via `tsx` in an isolated sandbox and asserts observable
behavior, so a passing run is evidence the user-facing surface actually works.

Every helper script ships a `--self-test` (or `--self-check`) that asserts its
scenario against this machine. The scripts are therefore both the QA tools and
their own regression checks.

## Golden rules (read before running anything)

- **Isolation is mandatory.** Everything spawns the CLI with
  `SENPI_CODING_AGENT_DIR` / `SENPI_CODING_AGENT_SESSION_DIR` pointed at a temp
  sandbox and `PI_OFFLINE=1`. QA must never write into the real `~/.senpi`.
  `scripts/lib/common.mjs` does this for you — use it.
- **Never read or modify the real credentials.** `~/.senpi/agent/auth.json` is
  the user's real key store. Every script snapshots its sha256 and asserts it is
  unchanged at the end. If you script a run by hand, do the same
  (`guardRealAuth()` in `common.mjs`).
- **Deterministic loop = mock loop.** To exercise the agent loop without real
  tokens, use Channel 3 (a local fake model server). Real-provider runs are for
  final smoke only and must use the user's existing auth, never a new key.
- **No `src/` edits from this skill.** It verifies; it does not fix. If QA finds
  a bug, report it with the captured evidence and let a follow-up change fix it.
- **The captured artifact IS the evidence.** Write it under
  `local-ignore/qa-evidence/<YYYYMMDD>-<slug>/`. No artifact == the QA did not
  happen. `local-ignore/` is gitignored — never commit evidence.

## Setup (once)

```bash
node scripts/devenv-setup.mjs        # installs skill deps (node-pty), wires .env.local + .claude/skills
node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check   # confirm the harness
```

`common.mjs --self-check` confirms the repo resolves, a sandbox is created and
auto-removed, a free port is allocatable, and the real auth file is untouched.

## Router: match QA to your change

| You changed… | Run this channel | Reference |
|---|---|---|
| Agent loop, tools, sessions, provider/model resolution, RPC | Channel 1 (RPC) — and Channel 3 for a deterministic loop | `references/rpc-protocol.md` |
| Interactive TUI, keybindings, rendering, composer | Channel 2 (TUI smoke) | `references/tui-driving.md` |
| Anything where you want a full agent turn with ZERO tokens | Channel 3 (mock loop) | `references/mock-loop.md` |
| CLI flags, `--help`, `--print`, model listing | Channel 4 (CLI smoke) | — |
| Added a provider / auth path | Channel 3 + 4, and update `references/env-vars.md` | `references/credential-injection.md` |

When in doubt, run the channel closest to your change AND Channel 3 (mock loop):
the mock loop is the cheapest end-to-end proof that the agent still completes a
turn.

## Channels

All commands are run from the repo root.

### Channel 1 — Remote RPC (`scripts/rpc-drive.mjs`)

Drives `--mode rpc` (JSON lines over stdio). `get_state` round-trips with no API
call; `--prompt` drives a real turn and captures the event stream.

```bash
node .agents/skills/senpi-qa/scripts/rpc-drive.mjs --self-test
node .agents/skills/senpi-qa/scripts/rpc-drive.mjs --state
node .agents/skills/senpi-qa/scripts/rpc-drive.mjs --prompt "say PONG" --provider mock --model mock-model --evidence rpc-pong
```

### Channel 2 — TUI smoke (`scripts/tui-smoke.mjs`)

Boots the interactive TUI in a real pseudo-terminal, confirms it renders and a
keystroke reaches the composer, then tears it down. Uses node-pty (ConPTY on
Windows — no WSL) and falls back to tmux on POSIX.

```bash
node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test
node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence tui
```

TUI smoke proves boot/render/input, not fine-grained output. For behavioral
assertions use Channel 1 or 3.

### Channel 3 — Mock loop (`scripts/mock-loop.mjs`)

Starts a local fake model server, registers it via a `baseUrl` override in an
isolated `models.json`, and drives a REAL turn — deterministic, zero tokens.
Covers all three wire formats senpi uses, so baseUrl override is QA'd for both
OpenAI and Anthropic (pick with `--api`; default `openai-completions`):

| `--api` | provider overridden | path / auth |
|---|---|---|
| `openai-completions` | `mock` | `/v1/chat/completions` · Bearer |
| `anthropic-messages` | `anthropic` | `/v1/messages` · x-api-key |
| `openai-responses` | `openai` | `/v1/responses` · Bearer |

`--self-test` (no `--api`) round-trips all three. `--with-tool` proves the full
loop (model → bash tool → final text). `--with-mcp-tool` registers a sandbox
extension that proxies `mcp_fx_tool_<n>` to the local MCP stdio fixture, then
asserts the fixture call log exists and the model's second request contains the
fixture result. The loop is hermetic: provider key env vars are stripped so only
the inline mock key is ever used.

```bash
node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test
node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --api anthropic-messages
node .agents/skills/senpi-qa/scripts/mock-loop.mjs --with-tool --api openai-responses
node .agents/skills/senpi-qa/scripts/mock-loop.mjs --with-mcp-tool mcp_fx_tool_1 --tool-args '{"value":"ok"}'
node .agents/skills/senpi-qa/scripts/mock-loop.mjs --run "summarize this repo" --evidence mock-summary
```

### Channel 4 — CLI smoke (`scripts/cli-smoke.mjs`)

Fast, no model: `--help`, `--version`, offline `--list-models`, unknown-flag
handling.

```bash
node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test
```

## Scripts index (each is its own regression test)

| Script | `--self-test` / `--self-check` asserts |
|---|---|
| `scripts/lib/common.mjs --self-check` | repo + tsx resolve; sandbox created and auto-removed; free port; real auth.json unchanged |
| `scripts/lib/fake-model-server.mjs --self-test` | OpenAI SSE contract: scripted text streams back, `[DONE]` sent, request recorded |
| `scripts/rpc-drive.mjs --self-test` | `get_state` returns the documented `RpcSessionState`, no API call, auth unchanged |
| `scripts/mock-loop.mjs --self-test` | scripted marker returns through the real loop via the mock provider; request used the mock model + key; zero real calls; auth unchanged |
| `scripts/mock-loop.mjs --with-tool` | full loop: two model turns served, bash tool ran, final text returned |
| `scripts/mock-loop.mjs --with-mcp-tool <tool>` | full loop with a registered sandbox MCP stdio fixture proxy; fails if the requested `mcp_fx_tool_<n>` is not registered, invoked, and fed back to the model |
| `scripts/tui-smoke.mjs --self-test` | TUI boots, renders, accepts a keystroke, tears down; auth unchanged |
| `scripts/cli-smoke.mjs --self-test` | `--help`/`--version`/`--list-models` work offline; unknown flag reported; auth unchanged |

Run the whole suite:

```bash
for s in lib/common.mjs:--self-check lib/fake-model-server.mjs:--self-test \
         rpc-drive.mjs:--self-test mock-loop.mjs:--self-test \
         tui-smoke.mjs:--self-test cli-smoke.mjs:--self-test; do
  node ".agents/skills/senpi-qa/scripts/${s%%:*}" "${s##*:}" || echo "FAILED: $s"
done
```

## Capturing evidence

```bash
ev="local-ignore/qa-evidence/$(date +%Y%m%d)-senpi-qa-<slug>"; mkdir -p "$ev"
node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test | tee "$ev/mock-loop.txt"
node .agents/skills/senpi-qa/scripts/rpc-drive.mjs --prompt "say PONG" \
  --provider mock --model mock-model --evidence senpi-qa-<slug>
```

Most channels accept `--evidence <slug>` and write artifacts to
`local-ignore/qa-evidence/<date>-<slug>/` themselves.

## References

- `references/rpc-protocol.md` — RPC command/response catalog, turn completion, examples
- `references/tui-driving.md` — node-pty vs tmux, keybindings files, fragility, isolation
- `references/mock-loop.md` — fake server, custom-provider `models.json` shape, in-process faux alternative
- `references/credential-injection.md` — per-harness credential injection + masking
- `references/env-vars.md` — provider keys + isolation env vars
