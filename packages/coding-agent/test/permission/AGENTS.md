# test/permission

Permission-system coverage: parsers, evaluation, presets, config merge/expand, service lifecycle, persistence, CLI, and non-interactive handling. 15 files / ~6,000 LOC. Score 11 — distinct domain, dense end-to-end scenarios that no parent file can summarize.

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Full pipeline scenarios | `integration.test.ts` (1,513 LOC, 15 numbered scenarios + evaluate/expand/merge/parser/non-interactive cases) |
| Cross-mode UI vs no-UI cascade | `multi-mode.test.ts` (841 LOC) |
| Request lifecycle + events | `service.test.ts` (515 LOC) — `ask`/`reply`/`list`/`getApproved`, event emission, defensive copies, insertion order |
| Arity/pattern matching | `arity.test.ts` (566 LOC) |
| Rule parsing | `parsers.test.ts` — `createBuiltinParserRegistry` |
| Config shape | `config.test.ts` — `fromConfig`, `merge`, `expand`, `disabled` |
| Presets | `presets.test.ts` — `rulesForPreset` |
| Persistence | `storage.test.ts`, `settings.test.ts` — JSONL load/save |
| Headless behavior | `non-interactive.test.ts` — `handleNoUI` |
| CLI surface | `cli.test.ts` |
| External path handling | `external-path.test.ts` |

## CONVENTIONS

- Permission behavior is expressed as **ordered** rules `{permission, pattern, action}` plus a separate `always` pattern list. Tests assert precedence, wildcard/glob matching, session scoping, and JSONL persistence — order is the contract, not a detail.
- Services are constructed with injected fakes (`createLocalEventEmitter`, fake models/contexts) and isolated `mkdtemp` roots cleaned in `afterEach`; no ambient global state.
- Both `describe`+`it` and `describe`+`test` appear; hooks and `vi` are imported per file rather than relying on globals.
- Shared session/auth/resource fixtures come from the parent `../utilities.ts` (`createTestSession`, `createTestResourceLoader`, `createTestExtensionsResult`, `loadAuthStorage`).

## ANTI-PATTERNS

- The fixture action string `"always"` and settings values `revertPolicy: "never"` / `defaultProjectTrust: "never"` are product data — do not read them as coding directives.
- Do not assert permission outcomes by timing; the pipeline is synchronous evaluation plus event-driven reply, so subscribe before asking and await the reply.
- Do not bypass the parser registry when adding a rule form; new syntax is registered, then evaluated, then persisted, and all three layers have tests.
- Do not weaken defensive-copy or insertion-order guarantees in `service.test.ts` to accommodate an implementation change.

## COMMANDS

```bash
bun run --cwd packages/coding-agent test --run test/permission/<file>.test.ts
bun run --cwd packages/coding-agent test --run test/permission
```
