# test/ttsr

Coverage for the ttsr stream-rule extension (`src/core/extensions/builtin/ttsr/` — own `changes.md`): collapse and control-token-leak detectors, coordinator generation/abort races, rule parsing, repetitive-turns lane, remediation, persistence, and `/ttsr` settings. 18 files, ~3.4k LOC. Score 11 — distinct detector-grammar/evidence domain.

## WHERE TO LOOK

| Task | Location |
|---|---|
| Control-leak grammar accept/reject | `detector-control-leak-grammar.test.ts` + `control-leak-helpers.ts` (`ctrl`, `sgml`, `bracket`, `runSplitMatrix`, `expectLeakMatchEverywhere`) |
| Control-leak evidence / negatives | `detector-control-leak-evidence.test.ts`, `detector-control-leak-negatives.test.ts` |
| Collapse detection | `detector-collapse.test.ts` + `collapse-test-inputs.ts` |
| Coordinator races / abort semantics | `coordinator.test.ts`, `coordinator-races.test.ts` (`claimAbort`, `createGenerationState`, `markUserCancelled`, `resolveDetection`) |
| Rule parsing / builtin rules | `rule-parser.test.ts` |
| Repetitive-turns lane | `repetitive-turns.test.ts` |
| Retry integration / wiring | `integration-retry.test.ts`, `extension-wiring.test.ts` |
| Persistence / discovery / settings | `persistence.test.ts`, `discovery.test.ts`, `settings-command.test.ts` |
| Stream helpers | `stream-utils.test.ts` |

## CONVENTIONS

- Detector/grammar tests import production pure modules directly (`detectors/*`, `prompts.ts`, remediation builders) — no session harness needed for detector behavior.
- Split-matrix discipline: inputs replay split at multiple chunk boundaries (`runSplitMatrix`) so streaming partials behave like complete text.
- Grammar assertions pin structural facts — token ids, occurrence counts, offsets, contexts — never detector prose.
- Integration/wiring/persistence tests use `suite/harness.ts` faux-provider sessions.
- Negative coverage is first-class: `detector-control-leak-negatives.test.ts` and the `PLAIN_PROSE_PREFIX` guard keep ordinary prose from firing detectors.

## ANTI-PATTERNS

- Loosening a grammar rule to pass a model regression — add the failing token to the negatives suite instead.
- Asserting on remediation message text; assert remediation payloads and classifications.
- Driving detectors through full sessions when a pure import reaches the behavior.

## COMMANDS

```bash
npm --prefix packages/coding-agent test -- --run test/ttsr/<file>.test.ts
npm --prefix packages/coding-agent test -- --run test/ttsr
```
