# builtin/permission-system

Builtin extension #3. Full port of opencode's permission flow. Loads preset/rule policy from CLI (`--permission-preset`, `--permission tool=action`), settings (`permissionPreset`, `permission`), and per-session approvals. Defaults to the `full-access` preset, persists "always allow" decisions, blocks denied calls with a structured error, and supports parser-aware patterns (bash command prefixes, file path globs for read/write/edit/apply_patch). **JSONL storage shape is a contract — migration required to change it.**

## FILES

```
permission-system/
├── index.ts            # Extension entry — wires session_start / tool_call / session_shutdown + UI prompt
├── internal-tools.ts   # Engine-owned bookkeeping tool classification
├── service.ts          # Permission service core (ask/reply/list)
├── evaluate.ts         # Rule evaluator with wildcard matching
├── wildcard.ts         # Wildcard matcher
├── types.ts            # Action ("ask"|"allow"|"deny"), preset names, Rule, Request, Reply
├── settings.ts         # Loads presets/rules from global/project settings.json + approved JSONL
├── cli.ts              # `--permission-preset` and `--permission tool=action` flag parsers
├── config.ts           # preset rules / fromConfig / merge / disabled state transforms
├── storage.ts          # JSONL persistence (CONTRACT — don't change line shape)
├── arity.ts            # Bash command prefix parser
├── bash-command-segments.ts # Every simple command a bash call runs (fail closed: `unparsed`)
├── parsers.ts          # Tool input parser registry (paths, globs, apply_patch bodies)
├── prompt.ts           # TUI permission prompt
├── non-interactive.ts  # No-UI fallback (print/json/rpc modes)
├── events.ts           # permission_asked / permission_replied events
├── external-dir.ts     # Detects writes outside repo root → forces ask
└── changes.md          # Fork tracker (apply_patch path extraction 2026-04-13)
```

## EVAL CELLS (senpi#3210)

- An `eval` call is decided like any tool without a parser of its own: one `eval` request with pattern `*`, evaluated against the active preset. Approving it approves running the cell's code with this process's rights. Plain Node/Bun side effects inside the cell (`fs`, `child_process`, `Bun.*`, network) do not reach the permission system.
- Calls a cell makes through `tool.*` (bash, write, edit, …) go through the dispatch authorizer (`dispatch-policy.ts`) and get their own decision, as if the model had called them directly.
- An "always" answer on `eval` therefore allows arbitrary code for the rest of the session.
- An `eval` tool's own `permissionParser` never downgrades the class: the shared resolver (`permissionRequestsFor` in `parsers.ts`, used by both the `tool_call` handler and `dispatch-policy.ts`) adds the `eval` request to any call whose tool-owned requests don't include it, so a `read`-class answer can never approve a cell (`fallbackEvalPermissionRequest`). It matches the exact name `eval`; a differently named tool whose execution is arbitrary code would need the same guard.
- Invariant, pinned by `test/permission/eval-preset-floor.test.ts`: under every preset the `eval` call is at least as strict as the strictest of `bash`, `edit` and `write`, and it is `allow` only when every permission is allowed. `decideAuto` never approves `eval`, and any reviewer or judge layered on `auto` must decline it (or review only the nested `tool.*` calls), never approve a cell wholesale.

## BASH COMMANDS

- A `bash` call (and `bash_input`, command `monitor`) is decided on EVERY simple command it runs: `analyzeBashCommand` splits operators, subshells, substitutions and here-document bodies and unwraps wrappers (`env`, `sudo`, `xargs`, `sh -c`, `find -exec`, ...). The request has one arity-prefix pattern per command; all must be allowed and any deny refuses the call. Never decide a bash call on its first word alone.
- An `unparsed` command is the target `(unparsed) <command>`: only a `*` rule decides it, so no single-command grant can allow it, and its plain words are still matched against deny rules by a deny-only request.
- Pinned by `test/permission/bash-command-segments.test.ts` (shape x preset table).

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

`evaluate.ts` is **last-match-wins** over the concatenated ruleset; later sources override earlier ones:

1. **Default preset** — `full-access`.
2. **Global preset** (`~/.senpi/agent/settings.json` `permissionPreset`).
3. **Global settings** (`~/.senpi/agent/settings.json` `permission`).
4. **Project preset** (`.senpi/settings.json` `permissionPreset`).
5. **Project settings** (`.senpi/settings.json` `permission`).
6. **CLI preset** (`--permission-preset`).
7. **CLI flags** (`--permission`).
8. **Session approvals** — in-memory "always allow" rules; new ones are persisted to the agent-dir store at `<agentDir>/permissions/approved/<project-hash>.jsonl` (validated, allow-only, symlink-safe), appended at answer time and at session shutdown. The legacy `<projectDir>/.senpi/permissions-approved.jsonl` is imported once, validated, then removed.
9. **No match** — interactive → ask; non-interactive → block (`non-interactive.ts`).

Presets other than `full-access` start with `*=ask` so they mask lower-precedence wildcard allows before adding their own allows.

Pattern syntax: tool name + optional arg pattern, e.g. `bash:rm *`, `write:/etc/**`. Wildcard matching in `wildcard.ts`, rule lookup in `evaluate.ts`.

## CONVENTIONS

- **JSONL storage is the contract**: `storage.ts` writes append-only newline-delimited JSON. Schema changes require a migration. Other tools (audit, replay) parse this format.
- **Parsers are tool-aware**: `parsers.ts` extracts the *meaningful* arg per tool — file path for read/write/edit, command prefix for bash, file paths for `apply_patch` body (2026-04-13).
- **`external-dir.ts` emits an extra permission** when target path is outside repo root. `workspace` and `read-only` ask for that permission unless a later explicit rule allows it.

## ANTI-PATTERNS

- Changing the JSONL line shape without a migration script — breaks existing approval files.
- Adding a new tool that mutates files without registering a parser in `parsers.ts` — falls back to wildcard, loses per-path granularity.
- Bypassing the parser registry from a builtin tool's render path — render and approval must agree on the displayed action.
- Adding a preset without a reset rule when it needs to override a lower-precedence wildcard allow.

## NOTES

- `apply_patch` permission scope (per-file) was added 2026-04-13 once GPT models routed file edits through `apply_patch`. Without it, every patch would fall back to wildcard edit approval.
- Print / JSON / RPC modes use `non-interactive.ts` — denies any `ask` result, returning a structured error to the model.
- `events.ts` emits `permission_asked` / `permission_replied` for telemetry; downstream extensions can subscribe.
