# Plan: restore Cursor exec bridge dispatch by checking run liveness, not signal identity

## Problem

Since v2026.8.18-3 (commit `31a71f0c5`), every Cursor exec frame is refused with
`Tool execution has no active run`, making any Cursor-routed model (e.g. the
`cursor/kimi-k3` fallback lane) a no-tools model.

`createSessionCursorExecBridge` compares the per-request signal against the
agent's run signal by object identity:

```ts
getAbortSignal: () => {
    if (runSignal === undefined) return getAgent().signal;
    return runSignal === getAgent().signal ? runSignal : undefined;
},
```

In production these are two different controllers by construction:

- `runSignal` is `requestAbortController.signal`, created fresh per provider
  request (`packages/agent/src/agent-loop.ts:480`) and supplied to the bridge
  factory (`packages/coding-agent/src/core/sdk.ts:450-451`).
- `getAgent().signal` is the owning run's `abortController.signal`
  (`packages/agent/src/agent.ts:647`).

The identity therefore never holds, so the guard returns `undefined` for every
live frame and `executeTool` refuses with `Tool execution has no active run`.
The unit tests inject the same signal object into both positions, so the
divergence was invisible to them.

Verified by comparing the published packages side by side with a seam test
that reproduces the production wiring (two distinct controllers): `2026.8.18-2`
executes the tool; `2026.8.18-3`/`2026.8.19` refuse it.

## Fix design

Ownership is a liveness property, not an identity property. The loop's request
controller mirrors the owning run's aborts (`agent-loop.ts:480-490`: the run
signal's `abort` event aborts the request controller; the idle-timeout path
aborts it directly), so:

```ts
getAbortSignal: () => {
    if (runSignal === undefined) return getAgent().signal;
    if (runSignal.aborted) return undefined;
    return getAgent().signal === undefined ? undefined : runSignal;
},
```

- Live request + active run → execute with the request's own signal (fixes the
  regression).
- Aborted request (user cancel, idle timeout, run aborted before a fallback
  restart) → refuse. This is the straggler case `31a71f0c5` targeted.
- No active run at all → refuse, matching the pre-regression behavior of
  returning `getAgent().signal` when it is `undefined`.

A straggler whose run ended normally (request not aborted) while a replacement
run is live executes with its own request signal; `Agent.emitExternalEvent`
(`agent.ts:807-809`) already drops events carrying a non-current signal, so its
lifecycle events cannot leak into the replacement run. This is strictly safer
than the pre-`31a71f0c5` behavior, which adopted the new run's signal and
leaked events into it.

## Tests

New `packages/coding-agent/test/cursor-exec-bridge-request-signal.test.ts`
reproducing the production wiring with two distinct controllers:

1. Live request + live run → tool executes (RED on current main).
2. Aborted request → refused with `Tool execution has no active run`.
3. Live request + no active run (`getAgent().signal === undefined`) → refused.
4. No run signal supplied → returns the agent signal (legacy path).

The existing `cursor-exec-bridge-run-ownership.test.ts` straggler simulation is
re-checked against the new semantics: if it models "run ended" by swapping the
agent signal without aborting the request signal, it is updated to abort the
request signal instead — the honest model of how the loop tears a request
down.

## Verification

- Targeted vitest run of every `cursor-exec-bridge*` test file in
  `packages/coding-agent` (RED first for the new file, GREEN after the fix).
- `tsc` build of `packages/coding-agent` green.
- End-to-end: patch the installed engine dist with the built file, force the
  `writing` route to `cursor/kimi-k3`, and confirm read/shell/write tool calls
  complete (previously 0/3 with `Tool execution has no active run`).

## Repository constraints (CONTRIBUTING.md + AGENTS.md — binding)

- Issue: one screen, bug-template sections, AI-labeled follow-up comment (LLM draft), state fix PR follows.
- Add a `packages/coding-agent/src/core/changes.md` entry in the same increment (four canonical headings), matching the `31a71f0c5` precedent even though the bridge file is fork-only versus the upstream pin.
- New regression test lives in `packages/coding-agent/test/suite/regressions/<issue-number>-<slug>.test.ts`; the issue number must exist before the test file is named, so the issue is posted first.
- Gates before PR: `npm install --ignore-scripts`, `npm run check`, `npm test` — both green.
- Real CLI QA through `.agents/skills/senpi-qa/` (setup: `node scripts/devenv-setup.mjs`, then `common.mjs --self-check`; agent-loop change → Channel 1 RPC + Channel 3 mock loop); receipts under `local-ignore/qa-evidence/20260820-cursor-bridge-liveness/` (gitignored).
- Style: TAB indent, width 3; 120-col lines; match surrounding file.
- Never edit `CHANGELOG.md`.
- All work happens in the dedicated clone/worktree `/Volumes/storage/workspace/senpi-src`, agents run from its root.
