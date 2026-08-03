# MCP Session Expiry Full Reconnect

## Goal

Make MCP tool calls recover automatically when a server reports session expiry
and the renewed session requires the same catalog/list handshake performed by
`/mcp reconnect`. The retry must reuse the existing service-aware reconnect
path, remain bounded to one retry, preserve actionable failure behavior, and
ship with deterministic RED-to-GREEN evidence plus real-source CLI QA.

## Recovered Failure

- Senpi session: `019fc0e8-634f-7745-aecc-068d31cc8e5d`
- Exact result:
  `SessionExpiredError: MCP server aside_browser session expired; reinitialize retry also expired; run /mcp reconnect aside_browser`
- Re-running `tool_search` only reactivated the same tool and repeated the
  failure.
- Local versions at reproduction:
  - Senpi/source: `2026.8.1`
  - Aside CLI: `1.26.709.1533`
- The timestamped local MCP backup configured `aside_browser` as
  `/Users/yeongyu/.local/bin/aside mcp` with search exposure.

## Root Cause

`withMcpSessionExpiryRetry()` calls bare `ServerConnection.renew()`. That renews
the transport, but it does not reset reconnect state or run the service callback
that:

1. refreshes auth;
2. invalidates `cacheRefreshedAfterConnect`;
3. renews the transport;
4. recollects tools/resources/prompts/instructions;
5. rewrites the catalog cache;
6. restores resource subscriptions.

The explicit `/mcp reconnect` command already uses `reconnectMcpNow()`, which
performs that full sequence. `tool_search` only changes the active tool set and
cannot repair connection state.

## Decision

In `health.ts`, replace the session-expiry retry's direct
`connection.renew()` with `reconnectMcpNow(connection)`.

This is the smallest correct change because:

- it reuses the exact proven manual reconnect implementation;
- it adds no new state, tool, command, or policy;
- connections without configured reconnect state retain the existing fallback
  because `reconnectMcpNow()` delegates to `connection.renew()`;
- the retry remains bounded: a second session-expiry error still marks the
  connection suspended and returns actionable guidance.

## Tier and Delegation

Tier: **HEAVY** because MCP session-handling/reconnect semantics change.

Completed independent read-only lanes:

- `mcp-reconnect-audit` traced thin renew versus service-aware reconnect.
- `mcp-expiry-repro` identified deterministic fixtures and QA seams.

The lead owns implementation, RED/GREEN ordering, QA, delivery, merge, and
cleanup because those steps share one mutable worktree and one evidence ledger.

## Implementation Waves

### Setup

1. Create branch/worktree `fix/mcp-session-expiry-full-reconnect`.
2. Commit this plan and open a draft PR.
3. Register the binding goal.

### RED

1. Add fixture flag `--expire-first-tool-call`.
2. Add fixture flag `--require-list-before-tool-call`.
3. Track whether `tools/list` ran for each HTTP fixture session.
4. Add `test/mcp/session-expiry-full-reconnect.test.ts` with:
   - catalog-handshake recovery;
   - permanent-expiry bounded failure;
   - ordinary one-shot expiry recovery.
5. Run each test selector against unchanged production code and capture RED.

### GREEN

1. Import `reconnectMcpNow` in `health.ts`.
2. Use it for `withMcpSessionExpiryRetry()` recovery.
3. Add the fork change entry to `mcp/changes.md`.
4. Re-run each selector and capture GREEN.

### Verification

1. Run LSP diagnostics on changed TypeScript files.
2. Run:
   `npx vitest run test/mcp/diagnose.test.ts test/mcp/reconnect.test.ts test/mcp/ping-on-call.test.ts test/mcp/session-expiry-full-reconnect.test.ts`
3. Run root `npm run check`.
4. Run a temporary isolated real-source CLI driver with:
   - localhost fake model;
   - HTTP MCP fixture using both new flags;
   - one scripted `mcp_fx_tool_1` call;
   - assertion that the recovered tool result reaches the next model request.
5. Run standard Senpi QA:
   `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --with-mcp-tool mcp_fx_tool_1 --tool-args '{"value":"ok"}' --evidence mcp-session-expiry-full-reconnect`
6. Record teardown for every process, port, and sandbox.

### Delivery

1. Self-review the diff and evidence.
2. Commit the verified runtime/test/ledger increment.
3. Push and mark the PR ready.
4. Drive checks to green.
5. Merge with a merge commit.
6. Remove and prune the worktree.

## Success Criteria

### Criterion 1: catalog-handshake recovery

Command:

```bash
cd packages/coding-agent
npx vitest run test/mcp/session-expiry-full-reconnect.test.ts \
  -t "refreshes the catalog before retrying an expired tool call"
```

Fixture:
`--tools 1 --expire-first-tool-call --require-list-before-tool-call`

PASS:

- result is `fixture tool_1 value=after-expiry mode=alpha`;
- state is `connected`;
- generation increments once;
- reconnect counter is `1`.

RED before production change:

- thin renew skips `tools/list`;
- retry expires;
- state becomes `suspended`;
- manual reconnect guidance is returned.

### Criterion 2: permanent-expiry bounded failure

Command:

```bash
cd packages/coding-agent
npx vitest run test/mcp/session-expiry-full-reconnect.test.ts \
  -t "suspends after one full reconnect when the renewed session also expires"
```

Fixture: `--tools 1 --always-expire-tool-calls`

PASS:

- call rejects with `/mcp reconnect fx` guidance;
- state is `suspended`;
- reconnect counter is exactly `1`;
- no third attempt occurs.

RED before production change:

- reconnect counter is `0`, proving only thin renewal ran.

### Criterion 3: ordinary expiry remains green

Command:

```bash
cd packages/coding-agent
npx vitest run test/mcp/session-expiry-full-reconnect.test.ts \
  -t "keeps ordinary one-shot session expiry recovery green"
```

Fixture: `--tools 1 --expire-first-tool-call`

PASS:

- result is `fixture tool_1 value=ordinary mode=alpha`;
- state is `connected`;
- reconnect counter is `1`.

RED before production change:

- result may succeed, but reconnect counter remains `0`.

### Real-source CLI proof

Command:

```bash
node local-ignore/qa-evidence/20260803-mcp-session-expiry-full-reconnect/full-reconnect-cli.mjs
```

PASS:

- exit `0`;
- verdict JSON contains `"pass": true`;
- next fake-model request contains the recovered fixture result;
- final output contains `MCP-SESSION-RECOVERY-PASS`;
- cleanup receipt confirms no fixture/model/CLI processes or temp sandbox
  remain.

## Stop Condition

Stop immediately when GitHub reports the PR as `MERGED`, the task worktree is
removed, all three criteria and both real CLI QA surfaces pass with captured
evidence and cleanup receipts, and the registered goal is completed.
