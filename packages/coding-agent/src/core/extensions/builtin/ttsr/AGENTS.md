# builtin/ttsr

## OVERVIEW
Stream-remediation domain (score 11): detect degeneration/control-token leaks, arbitrate one abort owner, and settle a retry or nudge.

## WHERE TO LOOK

| Task | File |
|---|---|
| Host lifecycle, abort provenance, settlement | `index.ts` |
| Rule state, matching, and injection history | `manager.ts` |
| Per-stream delta extraction and watching | `message-update.ts`, `watch.ts` |
| Generation-level arbitration | `coordinator.ts` |
| Builtin/user rules and conditions | `builtin-rules.ts`, `discovery.ts`, `rule-parser.ts`, `rule-condition.ts`, `scope.ts` |
| Collapse detectors | `detectors/collapse*.ts` |
| Transcript/control-token leaks | `detectors/control-leak.ts`, `detectors/leak-context.ts`, `detectors/token-grammar.ts` |
| Repeated completed turns | `repetitive-turns-lane.ts`, `detectors/repetitive-turns.ts` |
| Stream replacement and nudges | `stream-remediation.ts`, `remediation.ts`, `prompts.ts` |
| Commands and public settings | `commands.ts`, `types.ts` |

## CONVENTIONS

- Stream identity includes source, stream key, and generation; text, thinking, and tool deltas are distinct lanes.
- `claimAbort` and generation state prevent competing detectors from independently interrupting one generation.
- User input or user abort cancels pending remediation and disarms repeated-turn recovery.
- `message_end` clears buffered stream tails so later messages cannot match earlier deltas.
- Message replacement is prepared at message end; a pending nudge is sent only after `agent_settled`.
- Accepted injection history uses shared `rule-activation` entries; legacy TTSR entries are also restored.
- Rule interrupt modes are explicit `always`/`never` values, not inferred from detector names.
- Repetitive-turn history is restored separately from current-generation stream state.

## ANTI-PATTERNS

- Emitting a recovery nudge after a user cancellation.
- Keeping stream tails until the next turn and thereby matching across completed messages.
- Reusing generation-local abort ownership for a provider retry without resetting it.
- Conflating advisory rule matches, stream-error replacement, and model-facing nudge delivery.
