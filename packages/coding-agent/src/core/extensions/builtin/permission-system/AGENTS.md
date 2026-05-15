# builtin/permission-system

Builtin extension #2. Full port of opencode's permission flow. Loads rules from CLI (`--permission tool=action`), settings (`permissions.always_allow`, `permissions.deny`), and per-session approvals. Prompts the user for unknown tool calls, persists "always allow" decisions, blocks denied calls with a structured error, and supports parser-aware patterns (bash command prefixes, file path globs for read/write/edit/apply_patch). **JSONL storage shape is a contract — migration required to change it.**

## FILES

```
permission-system/
├── index.ts            # Extension entry — wires beforeToolCall + UI prompt
├── service.ts          # Permission service core (ask/reply/list)
├── evaluate.ts         # Rule evaluator with wildcard matching
├── wildcard.ts         # Wildcard matcher
├── types.ts            # Action ("ask"|"allow"|"deny"), Rule, Request, Reply
├── settings.ts         # settings.json integration (always_allow, deny)
├── cli.ts              # `--permission tool=action` flag parser
├── config.ts           # fromConfig / merge / disabled state transforms
├── storage.ts          # JSONL persistence (CONTRACT — don't change line shape)
├── arity.ts            # Bash command prefix parser
├── parsers.ts          # Tool input parser registry (paths, globs, apply_patch bodies)
├── prompt.ts           # TUI permission prompt
├── non-interactive.ts  # No-UI fallback (print/json/rpc modes)
├── events.ts           # permission_asked / permission_replied events
├── external-dir.ts     # Detects writes outside repo root → forces ask
└── changes.md          # Fork tracker (apply_patch path extraction 2026-04-13)
```

## WHERE TO LOOK

| Task | File |
|------|------|
| Add a new tool-input parser (e.g. for a new edit tool) | `parsers.ts` |
| Change wildcard rule matching | `evaluate.ts` |
| Modify the TUI prompt | `prompt.ts` |
| Migrate JSONL approval shape | `storage.ts` — and write a one-shot migrator |
| Change "external write requires ask" policy | `external-dir.ts` |
| Add a no-UI mode | `non-interactive.ts` (used by `--mode print/json/rpc`) |

## RULE EVALUATION (order)

1. **CLI flags** (`--permission`) — highest precedence.
2. **Project settings** (`.senpi/settings.json` `permissions.*`).
3. **Global settings** (`~/.senpi/agent/settings.json`).
4. **Session approvals** (in-memory + persisted to `~/.senpi/agent/permissions/<project>.jsonl`).
5. **Default** — interactive → ask; non-interactive → block.

Pattern syntax: tool name + optional arg pattern, e.g. `bash:rm *`, `write:/etc/**`. Wildcards in `evaluate.ts`.

## CONVENTIONS

- **JSONL storage is the contract**: `storage.ts` writes append-only newline-delimited JSON. Schema changes require a migration. Other tools (audit, replay) parse this format.
- **Parsers are tool-aware**: `parsers.ts` extracts the *meaningful* arg per tool — file path for read/write/edit, command prefix for bash, file paths for `apply_patch` body (2026-04-13).
- **`external-dir.ts` forces ask** when target path is outside repo root, regardless of allow-rules — explicit user consent required.

## ANTI-PATTERNS

- Changing the JSONL line shape without a migration script — breaks existing approval files.
- Adding a new tool that mutates files without registering a parser in `parsers.ts` — falls back to wildcard, loses per-path granularity.
- Bypassing the parser registry from a builtin tool's render path — render and approval must agree on the displayed action.
- Hardcoding deny-list defaults in `config.ts` — leave defaults empty; ship policy via settings or examples.

## NOTES

- `apply_patch` permission scope (per-file) was added 2026-04-13 once GPT models routed file edits through `apply_patch`. Without it, every patch would fall back to wildcard edit approval.
- Print / JSON / RPC modes use `non-interactive.ts` — denies any rule not pre-approved, returning a structured error to the model.
- `events.ts` emits `permission_asked` / `permission_replied` for telemetry; downstream extensions can subscribe.
