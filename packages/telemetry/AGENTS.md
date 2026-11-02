# packages/telemetry

`@earendil-works/pi-telemetry` (private). Vendor-neutral telemetry contracts and typed
schema utilities: explicit context/span types, a NOOP context, an in-memory reference
adapter, and compile-time schema inference. No exporter, backend, or global state.
Score 11: distinct domain — dense type-level API with strict lifecycle invariants.

## STRUCTURE

```text
src/index.ts        TelemetryContext/Span types, schema definitions, defineTelemetrySchema,
                    createTypedSpanStarter; re-exports noop + memory
src/noop.ts         NOOP_TELEMETRY_CONTEXT
src/memory.ts       InMemoryTelemetryContext, RecordedTelemetrySpan/Event
src/testing/        createTelemetryAdapterConformance — adapter conformance suite (subpath ./testing)
test/               telemetry + conformance Vitest files
```

## INVARIANTS

- Contexts propagate explicitly through function arguments. NO ambient current-span, no
  `AsyncLocalStorage`, no global registry, no backend dependency.
- Span lifecycle is callback-owned: the callback runs synchronously exactly once; the
  returned promise controls settlement; recording methods are synchronous and passive;
  calls after settlement are inert.
- Schemas are compile-time only: `defineTelemetrySchema` values drive type inference and
  duplicate-name rejection; there is no runtime schema validation.
- Attributes are primitive scalars or readonly arrays; `undefined` is ignored; later values
  overwrite earlier ones; end attributes are always optional enrichment; exact mapped
  types reject undeclared keys.
- The in-memory adapter returns detached snapshots in span-start order with deterministic
  numeric IDs and no timestamps; storage is process-local and intentionally unbounded.

## WHERE TO LOOK

| Task | Path |
|---|---|
| Add/extend a schema | `src/index.ts` (schema + inference types), patterns in `test/telemetry.test.ts` |
| Write an adapter (OTel, Sentry, logs) | implement `TelemetryContext`, then run `src/testing/conformance.ts` suite against it |
| Assert spans in tests | `InMemoryTelemetryContext` snapshots |

## ANTI-PATTERNS

- Don't persist telemetry contexts/spans in records, messages, snapshots, or deferred
  handles; keep prompts, completions, tool payloads, file contents, credentials, and
  free-form error details OUT of attributes unless the schema explicitly allows them.
- Don't turn recording failures into application failures — implementations swallow
  unreadable payloads and fall back without changing callback behavior.
- Don't add runtime validation or ambient span state; both are deliberate exclusions.

## COMMANDS

- `bun run test` (vitest --run), `bun run build` (`tsgo -p tsconfig.build.json`), `bun run clean`.
- Repository-wide `bun run check` from root after changes.

---
Generated: 2026-08-24 | Commit `baf15a54d`
