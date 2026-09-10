# packages/coding-agent/src/cli

## OVERVIEW

CLI parsing, auth commands, startup UI and experimental command composition (score 9: 23 TypeScript files with dense symbols/exports); session construction remains in `../main.ts`.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Flags, positional text, `@file`, help | `args.ts` | `parseArgs`, `Args`, thinking-level validation |
| Auth subcommand grammar | `auth-command.ts` | `check`, `print-api-key`, `print-bearer-token` |
| Auth checks / credential output | `auth-check.ts`, `credential-print.ts` | Keep checking separate from explicit credential emission |
| App-server command parsing | `app-server-command.ts` | Separate subcommand, not an `Args.mode` value |
| Initial attachments / user input | `file-processor.ts`, `initial-message.ts` | File conversion before session dispatch |
| Startup feedback and selection | `startup-ui.ts`, `startup-loading-indicator.ts`, `session-picker.ts`, `config-selector.ts` | TUI startup adapters |
| Trust / experimental UI gate | `project-trust.ts`, `grok-neo-gate.ts` | Resolve the gate before enabling its flags |
| Experimental fluent command parser | `experimental/command.ts`, `command-options.ts` | Typed parse and execution results |
| Experimental command tree | `experimental/cli.ts`, `experimental/commands/` | Composes pi, server and client commands |
| Transport address / auth options | `experimental/transport-address.ts`, `experimental/auth.ts` | Shared experimental option handling |

## CONVENTIONS

- `Args.mode` is `text | json | rpc`; interactive selection and app-server routing happen elsewhere.
- The main parser preserves unknown flags in `unknownFlags` for extension registration. Auth validation instead rejects unknown flags.
- `--` ends option parsing but still recognizes subsequent `@file` arguments as attachments.
- `--append-system-prompt` accumulates values rather than replacing the previous one.
- Auth `--json`, `--credentials`, and `--no-refresh` belong only to `auth check`; `--min-expiry` belongs only to bearer-token printing.
- Both checks and credential-printing require a provider or model selector; auth commands reject positional messages, files and `--api-key` overrides.

## ANTI-PATTERNS

- Collapsing the ordinary CLI parser and experimental fluent command tree into one presumed grammar.
- Rejecting extension flags in `parseArgs` before resource loading can register them.
- Printing credentials as incidental startup diagnostics; credential output is an explicit auth-command surface.
- Moving session policy into these presentation/parsing adapters.

## VALIDATION

From the repository root: `bun run --cwd packages/coding-agent test -- test/args.test.ts test/experimental-cli-command.test.ts test/experimental-cli-resolution.test.ts`.
These are existing parser targets, not substitutes for the affected auth/startup or real-CLI checks when behavior changes.
