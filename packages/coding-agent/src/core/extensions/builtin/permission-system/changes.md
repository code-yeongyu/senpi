# Permission System Builtin Extension

## Overview
Full port of opencode's permission system to senpi-mono as a builtin extension.

## Files
- `types.ts` - Core type definitions (Action, Rule, Request, Reply, etc.)
- `evaluate.ts` - Rule evaluation engine with wildcard matching
- `arity.ts` - Bash command arity parser
- `config.ts` - Config transforms (fromConfig, merge, disabled)
- `storage.ts` - JSONL persistence layer
- `external-dir.ts` - External directory detection
- `service.ts` - Permission service core (ask/reply/list)
- `events.ts` - Event system (permission_asked/replied)
- `parsers.ts` - Tool input parser registry
- `prompt.ts` - TUI permission prompt
- `non-interactive.ts` - No-UI fallback handler
- `settings.ts` - settings.json integration
- `cli.ts` - CLI flag parsing
- `index.ts` - Extension entry point

## Why Builtin Extension?
Following pi-mono's extension-first philosophy. All permission logic is in the extension, zero core tool modifications.

## Relationship to external agent-profile extensions
- Agent definition and agent-level tool filtering moved out of this monorepo into the sibling `pi-agent-system` repository.
- permission-system handles user permission prompts and per-tool access control.
- Clean separation of concerns remains: external agent-profile filtering and permission prompts do not share approval state.

## 2026-05-11 - Local wildcard matcher after agent-system extraction

### What changed and why
- Moved the wildcard matcher into `permission-system/wildcard.ts` so permission evaluation no longer imports from the removed builtin `agent-system` extension.
- Added focused wildcard regression coverage under `test/suite/permission-system-wildcard.test.ts`.

### Files modified
- `evaluate.ts`
- `wildcard.ts`

### Expected merge conflict zones
- `evaluate.ts` imports if upstream also changes rule matching.

## 2026-04-13 - apply_patch path extraction

### What changed and why
- Extended `apply_patch` permission parsing and request metadata extraction to read file paths from patch bodies (`input` / `patchText`) instead of falling back to wildcard edit permissions.
- This change was required once GPT sessions started using `apply_patch` instead of `write` / `edit`; otherwise permission prompts and approvals would lose per-file scope.

### Files modified
- `parsers.ts`
- `index.ts`

### Expected merge conflict zones
- `parsers.ts` edit-tool parsing logic
- `index.ts` request metadata extraction
