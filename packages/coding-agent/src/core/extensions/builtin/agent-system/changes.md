# agent-system Extension Changes

## Overview
Agent definition and management system. Defines which tools each agent can use via wildcard patterns.

## Files
- `types.ts` - Core type definitions (AgentDefinition, AgentConfig)
- `registry.ts` - Agent registry for looking up definitions
- `loader.ts` - Agent definition loader from settings.json and config
- `wildcard.ts` - Wildcard pattern matching utilities
- `permission.ts` - Agent-level permission checking (which tools an agent can use)
- `agent-types.ts` - Built-in agent type constants
- `builtin-agents.ts` - Default agent definitions (default, editor, architect)
- `index.ts` - Extension entry point

## What Changed (T15)
- Removed permission tool_call handler (delegated to permission-system extension)
- Removed sessionAllowed Set (permission-system handles approvals)
- Agent-level tool filtering remains (agents can only use their allowed tools)

## Why
- Separation of concerns: agent-system handles agent definitions, permission-system handles permission flow
- Part of opencode permission system port

## Relationship to permission-system
- agent-system: decides which tools an agent is allowed to use (static configuration)
- permission-system: decides whether user grants permission for a specific tool call (dynamic user approval)
- Both can deny: agent-system denies based on agent type, permission-system denies based on user rules

## Files Modified
- `packages/coding-agent/src/core/extensions/builtin/agent-system/index.ts`
  - Removed lines 48-96 (tool_call permission handler)
  - Removed sessionAllowed Set

## Expected Merge Conflict Zones
- Lines 48-96 of index.ts if upstream modifies tool_call handling
