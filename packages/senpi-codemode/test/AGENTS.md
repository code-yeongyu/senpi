# test

Vitest contracts for the codemode package plus the port-coverage parity ledger.
Earned by score 15 — contract layer and fixture hub (95 code files, ~12k LOC).

## WHERE TO LOOK

| Task | Path |
| --- | --- |
| Shared fakes, fixtures | `eval/fakes.ts` (`FakeKernel`, `FakeManager`), `eval-render-fixtures.ts` |
| Render contracts | `eval-render*.test.ts` family, `json-tree.test.ts`, `tool-widgets.test.ts` |
| Kernel contracts | `js-kernel*.test.ts`, `py-kernel*.test.ts`, `rb-kernel.test.ts`, `kernels/rb/`, `jl-kernel.test.ts` |
| Detach, interrupt, timeouts | `eval-detach*.test.ts`, `eval-tool-interrupt.test.ts`, `timeouts.test.ts`, `eval-hard-limit.test.ts` |
| Bridge protocol, servers | `bridge-protocol.test.ts`, `bridge-server*.test.ts`, `agent-bridge.test.ts`, `schema-bridge.test.ts` |
| Extension/session lifecycle | `extension.test.ts`, `session-manager*.test.ts`, `factory.test.ts` |
| Output sink | `output/` |
| Prompt snapshots | `prompt.test.ts`, `__snapshots__/` |
| Port coverage mapping | `PARITY.md` |

## CONVENTIONS

- Import `describe`/`it`/`expect`/`vi` explicitly; no ambient globals.
- Source imports are direct relative `.ts` paths; test-only fixtures live in
  `test/eval/` and `eval-render-fixtures.ts`.
- Async behavior is asserted via promise resolution/rejection and fake timers
  (`vi.useFakeTimers`, `advanceTimersByTime`); `setTimeout` appears only in
  intentional crash/deadline fixtures; `vi.waitFor` stays event/state based.
- Titles are behavior-oriented, often Given/When; parity suites compare
  JS/Python/Julia/runtime output and error behavior.
- `SIZE_OK` allowance marks the intentionally large parity suite.

## ANTI-PATTERNS

- Reserved schema/agent/output tools must never execute or surface as ordinary
  agent tools; `tool_schema()` must not execute tools.
- Late bridge resumes must not revive detached/dead cells; no second interrupt
  after hard-limit settlement; detached cells are never re-run or replayed as
  synthetic user input.
- Legacy stored `title` without `summary` must not crash or emit a label line.
- Errors omit success previews; status histories and live previews stay bounded.

## COMMANDS

```bash
npm test                                                              # whole suite, from package root
npx tsx ../../node_modules/vitest/dist/cli.js --run test/eval-render.test.ts  # one file
```
