# Issue 589: stabilize Codex prompt-cache affinity

## Objective

Diagnose GitHub issue #589 from the attached 25-hour session, align Senpi's
OpenAI Codex request affinity metadata with the official Codex client, prove the
old SSE and WebSocket request shapes fail the official contract, verify the
cache-disabled boundary, ship through a reviewed PR, merge it, and remove the
task worktree.

## Evidence-backed diagnosis

- The reported 08:38:04Z-08:46:59Z window contains 28 assistant responses:
  18 cache misses with `cacheRead=22,016` and roughly 175k-180k uncached input,
  plus 10 hits with roughly 196k-199k cache reads and under 5k uncached input.
- No model, thinking-level, compaction, custom-message, or branch transition
  occurred inside that burst.
- Four earlier assistant diagnostics recorded WebSocket transport failures.
  Each was followed by a full-context HTTP/SSE request and later cache recovery.
  The final transport failure preceded the issue burst, so the expensive burst
  happened while the session used SSE fallback.
- Senpi currently sends `session-id` and `x-client-request-id`, but omits the
  official `thread-id` affinity header on both SSE and WebSocket.
- Official Codex sends:
  - body `prompt_cache_key = session_id`
  - header `session-id = session_id`
  - header `thread-id = thread_id`
  - header `x-client-request-id = thread_id`
  on both transports.
- Senpi has one durable conversation identifier at this layer, so the minimal
  compatible mapping is to use the stable Senpi session ID for all three
  headers and `prompt_cache_key`.
- Open upstream reports show residual server-side intermittent misses even with
  stable bodies and keys. This patch therefore fixes Senpi's client-controlled
  protocol divergence without claiming to make a best-effort upstream cache
  deterministic.
- Explicit GPT-5.6 cache breakpoints are not the incident fix: this transcript
  already preserved the approximately 22k startup prefix, while the expensive
  losses were the append-only conversation history.

## Tier and topology

Tier: **HEAVY** because this changes an external provider integration.

Topology:

- Completed independent read-only lanes:
  - full transcript forensics;
  - Senpi cache-path and test-seam trace;
  - official Codex protocol and upstream-issue research.
- Lead session owns the cohesive test/source/changelog/QA lane because every
  edit shares one request-affinity contract.
- One independent reviewer runs after evidence is complete.
- No team: concurrent writers would collide in the same provider contract and
  add coordination without independent deliverables.

## Success criteria

### Criterion 1: diagnosis is reproducible

The PR must record the 18-miss/10-hit burst, lack of local context transitions,
prior WebSocket failure and SSE fallback, Senpi's missing `thread-id`, and the
upstream residual.

### Criterion 2: SSE carries complete affinity

Invocation:

```text
streamOpenAICodexResponses(model, context, {
  apiKey: token,
  sessionId: "issue-589-session",
  transport: "sse"
})
```

PASS iff the fake endpoint captures:

```text
session-id = issue-589-session
thread-id = issue-589-session
x-client-request-id = issue-589-session
prompt_cache_key = issue-589-session
```

RED must fail before production edits because `thread-id` is missing.

### Criterion 3: WebSocket carries the same affinity

Invocation:

```text
streamOpenAICodexResponses(model, context, {
  apiKey: token,
  sessionId: "issue-589-session",
  transport: "auto"
})
```

PASS iff the WebSocket handshake contains the same three headers and the sent
request body keeps the same `prompt_cache_key`.

RED must fail before production edits because `thread-id` is missing.

### Criterion 4: disabled caching remains isolated

Invocation:

```text
streamOpenAICodexResponses(model, context, {
  apiKey: token,
  cacheRetention: "none",
  sessionId: "one-off-summary",
  transport: "sse"
})
```

PASS iff all three affinity headers and `prompt_cache_key` are absent. A
temporary mutation that forces affinity headers must make the test fail; the
mutation is then reverted and GREEN restored.

## Implementation

1. Add a focused regression test file smaller than the repository's file-size
   ceiling; do not grow the already oversized broad stream test.
2. Capture RED for SSE and WebSocket missing `thread-id`.
3. Add a small shared affinity-header helper beside the existing prompt-cache
   key clamp.
4. Replace the duplicate SSE/WebSocket header assignments with the helper,
   reducing the oversized adapter rather than growing it.
5. Capture GREEN.
6. Add a `packages/ai/src/changes.md` entry describing evidence, mitigation,
   tests, conflict zones, and the upstream residual.

## Verification and QA

1. LSP diagnostics on all changed TypeScript files.
2. Focused AI test file.
3. Affected package validation and root `npm run check`.
4. Library-surface QA driver under
   `local-ignore/qa-evidence/20260731-issue-589-cache-affinity/`:
   start a local fake Codex Responses endpoint, invoke the real source adapter,
   capture exact headers/body, close the endpoint, and record the cleanup.
5. Required real CLI QA:

```text
node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test
```

6. Re-read the diff and verify no unrelated change.
7. Independent evidence reviewer, then GitHub CI and Cubic gates.

## Delivery

Commit the plan first, open a draft PR, register the binding goal, implement
test-first, make atomic verified commits, mark the PR ready, resolve every
criterion-cited review or gate failure, merge with a merge commit, and remove
the worktree.

## Stop condition

Stop immediately when GitHub reports the PR `MERGED`, every criterion has
current evidence and cleanup receipts, and
`/Users/yeongyu/local-workspaces/senpi-wt/issue-589-cache-affinity` is absent.
