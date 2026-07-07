# W3 AUTH — Independent QA Verification (senpi-qa)

Wave: TRAIN C W3-auth (PR#4 `feat(coding-agent): mcp oauth 2.1 + auth`), branch
`code-yeongyu/senpi-mcp-w3-auth`. This is the QA stage re-executing the wave's
scenarios independently (not trusting the implementer's committed artifacts) and
adding a real agent-loop proof of the MCP surface.

## Verdict: PASS — no product gaps found

All W3 auth acceptance criteria and the todo-28 e2e gate reproduce GREEN on a
clean run, and the MCP feature path is proven end-to-end through the REAL agent
loop via senpi-qa mock-loop.

## What was executed

| Check | Result | Artifact |
|-------|--------|----------|
| todo-28 gate driver (real shipped auth modules e2e vs fixture IdP, sandbox agentDir) | 10/10 PASS | `gate-reproduction.txt` |
| Auth acceptance suite: token-store, oauth-provider, oauth-callback, oauth-headless, auth-modes, oauth-race | 6 files / 34 tests PASS | `auth-vitest-suite.txt` |
| Redaction suite: log-redaction + auth-modes fingerprint scan | included above; 7 files / 44 tests PASS total | `auth-vitest-suite.txt` |
| senpi-qa mock-loop self-test (3 wire formats round-trip real loop, zero real calls) | 5/5 PASS | `mock-loop-self-test.txt` |
| senpi-qa mock-loop `--with-mcp-tool` (REAL agent loop drives CLI -> invokes MCP fixture tool -> result fed back to model) | 5/5 PASS | `mock-loop-mcp-agent-loop.txt` |

## Real-surface proof (doctrine: tests alone never prove done)

- `mock-loop --with-mcp-tool mcp_fx_tool_1`: the actual CLI completed a two-turn
  agent loop, invoked the MCP stdio fixture tool, and the model saw the fixture
  result on its second request (`callLog=yes modelSawFixtureResult=true`). This
  is the real agent-loop proof that the MCP tool path this wave builds on works
  end-to-end with zero tokens.
- `gate-driver.mjs`: drives the shipped `ServerConnection`, `McpTokenStore`,
  `McpOAuthProvider`, `McpRefreshManager`, `runAuth*/runLogout` commands, and the
  bearer transport against the fixture OAuth IdP through the full 11-step auth
  script (steps 1-9,11 in-driver; step 10 = repo `npm run check` + full vitest,
  captured by implementer in `task-28-senpi-mcp-plugin/step-10.txt`).

## Isolation receipt

Real `~/.senpi/agent/auth.json` sha256 (first 16 hex) unchanged across the whole
QA run: `7d769d1754a48b41`. Every senpi-qa helper snapshots and asserts this; the
gate driver confirms real `~/.senpi/agent/mcp-auth` stayed absent (all
credentials landed in the sandbox agentDir).

## RED->GREEN discipline (implementer, spot-checked)

Per-todo evidence logs `.omo/evidence/task-22..28-senpi-mcp-plugin.log` each
carry RED-first markers before GREEN (22:1R/3G, 23:2R/3G, 24:5R/3G, 25:8R/6G,
26:2R/3G, 27:1R/5G, 28:5R/12G).

## QA observation (non-blocking, no product defect)

The todo-28 gate `step 9` (secret audit) greps `getMcpLogDir()` for
`SENTINEL_AT_` tokens; in the isolated gate run that directory is not created
(the authed flows log to the ring buffer / per-agentDir dirs), so grep emits
`No such file or directory` and the step passes vacuously rather than by
scanning produced logs. This is a harness-strength nit, NOT a redaction defect:
fingerprint-only logging is independently and genuinely proven by
`auth-modes.test.ts` ("logs auth material as fingerprints only, never the raw
token" — asserts the ring buffer contains no raw token and matches
`<redacted:[0-9a-f]{8}>`) and `log-redaction.test.ts` (18 redaction tests GREEN).
Recommend tightening the gate grep to first assert the log dir exists / logs were
written, but the redaction guarantee itself is covered.

## Plan checkbox status

The MCP plan (`.omo/plans/senpi-mcp-plugin.md`) is not tracked in this branch
(off origin/main @466eee61d, which predates the plan being committed). In the
authoritative working copy on `main`, todos 22-28 are already `- [x]` and QA
here confirms each is legitimately complete.
