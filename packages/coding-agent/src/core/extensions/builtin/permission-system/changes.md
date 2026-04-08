# Permission System Builtin Extension

## Overview
Full port of opencode's permission system to sanepi-mono as a builtin extension.

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

## Relationship to agent-system
- agent-system handles agent definitions and agent-level tool filtering
- permission-system handles user permission prompts and per-tool access control
- Clean separation of concerns
