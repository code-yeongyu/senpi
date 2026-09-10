# test

Vitest contracts for the codemode package plus the port-coverage parity ledger.
Earned by score 14 — contract layer and fixture hub (106 direct TypeScript files).

## WHERE TO LOOK

| Task | Path |
| --- | --- |
| Shared fakes, fixtures | `eval/AGENTS.md`, `eval/fakes.ts`, `eval-render-fixtures.ts` |
| Render contracts | `eval-render*.test.ts` family, `json-tree.test.ts`, `tool-widgets.test.ts` |
| Kernel contracts | `js-kernel*.test.ts`, `py-kernel*.test.ts`, `rb-kernel.test.ts`, `kernels/rb/`, `jl-kernel.test.ts` |
| Detach, interrupt, timeouts | `eval-detach*.test.ts`, `eval-tool-interrupt.test.ts`, `timeouts.test.ts`, `eval-hard-limit.test.ts`, `eval-foreground-window.test.ts` |
| Bridge protocol, servers | `bridge-protocol.test.ts`, `bridge-server*.test.ts`, `agent-bridge.test.ts`, `schema-bridge.test.ts` |
| Extension/session lifecycle | `extension.test.ts`, `session-manager*.test.ts`, `factory.test.ts` |
| Wake-source/status contracts | `eval-wake-source.test.ts`, `eval-status-wiring.test.ts`, `eval-status-ticker.test.ts` |
| Bun skill and sidecar assets | `bun-skill-contribution.test.ts`, `kernels/shared/runtime-asset.test.ts` |
| Output sink | `output/` |
| Existing prompt regression suite | `prompt.test.ts`, `__snapshots__/` (legacy prose snapshots; do not extend for prose-only changes) |
| Port coverage mapping | `PARITY.md` |

## CONVENTIONS

- Import `describe`/`it`/`expect`/`vi` explicitly; no ambient globals.
- Source imports are direct relative `.ts` paths; test-only fixtures live in
  `test/eval/` and `eval-render-fixtures.ts`.
- Use the fixture signals in `eval/` to control kernel acquisition, run start,
  interrupt, and reset. Subscribe before triggering and await with bounded deadlines.
- Fake timers cover deadline behavior. Existing `vi.waitFor` in wake/status suites
  and fixed sleeps in `py-prelude-idle-sigint.test.ts` are legacy nondeterminism,
  not examples to copy; replace with exact state/frame signals when touching them.
- Titles are behavior-oriented, often Given/When; parity suites compare
  JS/Python/Julia/runtime output and error behavior.
- `SIZE_OK` allowances mark intentionally large parity suites.
- Test parsed fields, sentinel tokens, and shipped-copy equality, not prompt prose.

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
bun run test                                                              # whole suite, from package root
bunx tsx ../../node_modules/vitest/dist/cli.js --run test/eval-render.test.ts  # one file
```
