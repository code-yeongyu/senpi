# packages/ai/test/tool-call-middleware

Generated: 2026-08-24. Commit `baf15a54d`.

58 files / ~12.5k LOC covering `src/tool-call-middleware`: text-tool protocol parsers, the stream wrapper, and the leaked-invoke recovery state machine. Distinct domain — the only suite in this package built on registration-module fixtures rather than self-contained `.test.ts` files.

## FIXTURE / CASE SPLIT

16 non-`.test.ts` modules. A thin `*.test.ts` aggregator calls `register*Cases(...)` from `.ts` case modules; the cases import shared fixtures. Look for the behavior in the case module, not the test file.

| Module | Role |
|---|---|
| `invoke-recovery-stream-fixtures.ts` | `TextStreamHarness`, `NativeStreamHarness`, `collectEvents`, `collectIterator`, `nextEvent`, `textFrom`, `createAssistantMessage`, `cloneToolCall` |
| `invoke-recovery-scenario-fixtures.ts` | `bashTool`, `ambiguousTools`, `invoke`, `namespacedInvoke`, `terminal`, `toolEvents`, `nativeCall`, `runChunks` |
| `invoke-recovery-*-cases.ts` | `registerInvokeRecovery{ContentExclusion,ContentOrder,Native,NativeLifecycle,SnapshotCancel,TerminalEdge,Termination}Cases` |
| `stream-wrapper-fixtures.ts` | `weatherTool`, `createScriptedProtocol`, `create{TextOnly,Hermes,ErroredMorphXml,Thinking,Scripted}InnerStream` |
| `stream-wrapper-*-cases.ts` | `registerStreamWrapper{Basic,Error,Finalization,StopReason,TransportError}Cases`, `registerLegacyProjectionDifferentialCase` |
| `truncation-fixtures.ts` | `FIXTURE_TOOLS`, `TRUNCATION_FIXTURES` — one truncation matrix reused by Hermes, Anthropic XML, Morph XML, Gemma4, YAML XML |

## CONVENTIONS

- Per-protocol coverage is split by concern, not bundled: `<proto>-format`, `-parser`, `-stream`, edge/resource, recovery, then `e2e.test.ts` against the faux provider.
- Stream tests feed input at exhaustive and randomized chunk boundaries and assert the full event sequence, terminal flush, metadata identity, and content indices — never just the final text.
- Recovery tests drive synthetic `AssistantMessageEventStream` harnesses for both native and text event paths; source ordering and content index preservation are part of the contract.
- Tool schemas use `typebox` `Type`; one export-purity check runs `spawnSync(process.execPath, ["--input-type=module", "--eval", ...])` to prove imports are side-effect free.
- Adding a protocol means adding `<name>*.test.ts` here (step 5 of ADD A PROTOCOL in `src/tool-call-middleware/AGENTS.md`).

## ANTI-PATTERNS

- Never let protocol markup leak into visible text: XTML channel/close markers, function-call wrappers, and prompt-like markup inside parameter values must stay literal unless recognized.
- Recovery fails closed. Unknown/ambiguous tool names, missing closes, schema-coercion failures, fenced code examples, thinking/redacted/provider-native content, invalid content indices, ID collisions, aborts, and transport errors must never become executable calls.
- Terminal lifecycle is exactly-once — no duplicated text finalization, cancellation, upstream cleanup, or native start/delta/end transitions.
- Scan work and retained buffers must stay bounded/linear; nested candidate-close handling and UTF-16 split boundaries are asserted. Do not introduce unbounded rescans.
- `xml` is a deprecated alias for `morph-xml`; keep the compatibility test, write new coverage against the canonical name.

## COMMANDS

```bash
bun run --cwd packages/ai test test/tool-call-middleware
bun run --cwd packages/ai test test/tool-call-middleware/stream-integration.test.ts
bun run --cwd packages/ai test test/tool-call-middleware/truncation-e2e.test.ts
```

## HOTSPOTS

`e2e.test.ts` (719), `morph-xml-parser.test.ts` (709), `yaml-xml-parser.test.ts` (627), `hermes-parser.test.ts` (477), `context-transformer.test.ts` (475), `stream-integration.test.ts` (454). Highest blast radius on edit: `invoke-recovery-stream-fixtures.ts`, `stream-wrapper-fixtures.ts`, `truncation-fixtures.ts` — each feeds many suites.
