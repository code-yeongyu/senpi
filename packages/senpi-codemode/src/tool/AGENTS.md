# src/tool

Eval tool core: input schema, cell execution lifecycle, detached-cell state
machine, status events, and all call/result rendering. Earned by score 12 —
highest reference density in the package (`createEvalTool` and `EvalToolDetails`
anchor most suites).

## WHERE TO LOOK

| Task | Path |
| --- | --- |
| Tool registration, options | `eval-tool.ts`, `eval-tool-options.ts`, `eval-request.ts` |
| Wire contract, TypeBox schemas | `types.ts` (`createEvalInputSchema`, `fullEvalInputSchema`) |
| Cell execution, settlement | `cell-handler.ts`, `cell-execution.ts`, `cell-runtime.ts` |
| Detached cells | `detached-cell-manager.ts` + `detached-cell-{state,snapshot,notification}.ts`, `detached-notification-queue.ts`, `detached-eval-result.ts` |
| Call/result rendering | `render.ts`, `runtime-label.ts`, `json-tree.ts`, `image.ts`, `tool-widgets.ts` |
| Status events, execution events | `status-events.ts`, `eval-execution-event.ts` |
| Interrupt, capture | `interrupt-note.ts`, `call-capture.ts` |

## CONVENTIONS

- Wire/schema fields are snake_case (`cell_id`, `on_timeout`); internal TS
  fields are camelCase. Schemas and shared eval types live only in `types.ts`.
- Rendering is bounded by explicit line/code-point budgets with an injectable
  render clock; nothing here depends on wall-clock luck.
- Detached execution is a first-class state machine — snapshot, notification
  queue, spill-file notice, result conversion — never folded into ordinary
  cell execution.
- Unicode tree glyphs and status icons are intentional UI conventions.

## ANTI-PATTERNS

- Never add unbounded output: previews, JSON tree depth/lines/scalar length,
  widget lines, and collapsed errors all cap.
- Never bypass the kernel bridge message contract with ad-hoc return values;
  kernels import `KernelInterruptHandle` from `types.ts`, so discriminants and
  lifecycle state are cross-runtime contracts — change them only with all four
  runtimes and the detached path in mind.
- `render.ts` (1,030 LOC) is the package's largest file and the highest-risk
  hotspot for regressions; changes there need render contracts first.
