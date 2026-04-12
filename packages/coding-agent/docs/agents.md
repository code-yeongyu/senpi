> pi can create custom agents. Ask it to build one for your use case.

# Agents

Agents are typed subagent profiles that control which tools a spawned task can use and what system prompt it receives. Use agents to enforce read-only exploration, restrict dangerous operations, or create specialized task runners.

## Table of Contents

- [Built-in Agents](#built-in-agents)
- [Using Agents](#using-agents)
- [Custom Agents](#custom-agents)
  - [Locations](#locations)
  - [Frontmatter](#frontmatter)
  - [Example](#example)
- [Permissions](#permissions)
  - [Permission Actions](#permission-actions)
  - [Permission Config](#permission-config)
  - [Evaluation Order](#evaluation-order)
  - [Ask Mode](#ask-mode)
- [Configuration](#configuration)
  - [Directory Setup](#directory-setup)
  - [Writing an Agent File](#writing-an-agent-file)
  - [Settings](#settings)
  - [Priority Order](#priority-order)
  - [Quick Start Recipes](#quick-start-recipes)
- [How It Works](#how-it-works)
- [Known Limitations](#known-limitations)

## Built-in Agents

| Agent | Tools | System Prompt | Description |
|-------|-------|---------------|-------------|
| `general` | All except `task`, `todowrite` | Default pi prompt | General-purpose agent for parallel work |
| `explore` | `read`, `grep`, `find`, `ls`, `bash` | File search specialist | Read-only codebase exploration |

### general

The default agent for complex multi-step tasks. It can use all tools except `task` and `todowrite` (to prevent nested subagent spawning and todo list conflicts).

Permission config:

```json
{
   "*": "allow",
   "task": "deny",
   "todowrite": "deny"
}
```

### explore

A read-only agent optimized for fast codebase exploration. It can search, read, and list files but cannot modify anything.

Permission config:

```json
{
   "read": "allow",
   "grep": "allow",
   "find": "allow",
   "ls": "allow",
   "bash": "allow"
}
```

System prompt appended:

```
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Guidelines:
- Search file contents by regex or literal pattern when you need to locate usages or definitions
- Read files directly when you already know the path
- List directory contents to build a map of unfamiliar areas
- Return file paths as absolute paths
- Do not create any files or modify the system state
Complete the search request efficiently and report findings clearly.
```

## Using Agents

Pass `agent_type` when spawning a task:

```typescript
task(agent_type="explore", prompt="Find all files importing React", run_in_background=true)
task(agent_type="general", prompt="Refactor the auth module", run_in_background=false)
```

Without `agent_type`, the task tool works exactly as before (no restrictions, full backward compat).

## Custom Agents

### Locations

Pi loads custom agents from Markdown files in:

- Global: `~/.senpi/agent/**/*.md` and `~/.senpi/agents/**/*.md`
- Project: `.senpi/agent/**/*.md` and `.senpi/agents/**/*.md` (in current working directory)

Both `agent/` and `agents/` directories are scanned recursively. The agent name is derived from the filename: `my-agent.md` becomes `my-agent`.

**Name collision resolution:** Project-local agents override global agents with the same name.

### Frontmatter

Custom agents use YAML frontmatter (same format as skills):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | No | What this agent does and when to use it |
| `mode` | string | No | `"subagent"`, `"primary"`, or `"all"` (default: `"all"`) |
| `model` | string | No | Model ID for this agent (e.g., `"anthropic/claude-haiku-4-5"`) |
| `temperature` | number | No | Sampling temperature 0-2 |
| `tools` | object | No | Permission config (see below) |
| `disable` | boolean | No | When `true`, agent is not loaded |

**Mode values:**
- `"subagent"` - Only runs as a task subagent (spawned via `task()`)
- `"primary"` - Only runs in the main session (not as a subagent)
- `"all"` - Can run in both contexts

### Example

Create `.senpi/agents/readonly.md`:

```markdown
---
description: Read-only agent for safe codebase exploration
mode: subagent
tools:
   read: allow
   grep: allow
   find: allow
   ls: allow
   bash: deny
   write: deny
   edit: deny
---

You are a read-only exploration agent. You can search and read files but cannot modify anything.

Guidelines:
- Use grep to search for code patterns
- Use read to examine file contents
- Use find and ls to navigate the filesystem
- Never suggest file modifications
- Report findings clearly and concisely
```

Use it:

```typescript
task(agent_type="readonly", prompt="Find all TODO comments in the codebase", run_in_background=true)
```

## Permissions

### Permission Actions

Three actions control tool access:

- `allow` - Tool executes normally
- `deny` - Tool blocked, LLM receives error message explaining the restriction
- `ask` - In interactive mode, user is prompted to allow/deny. In non-interactive mode (json/print), auto-denied.

### Permission Config

The `tools` frontmatter field accepts two formats.

**Simple format** - single action for all patterns:

```yaml
tools:
   read: allow
   bash: deny
   edit: ask
```

**Nested format** - pattern-specific rules (for future extensibility):

```yaml
tools:
   read:
      "*": allow
      "*.env": ask
   bash: deny
```

Currently, pattern matching is not implemented for specific paths. The `"*"` pattern applies to all uses of that tool.

### Evaluation Order

Permissions are evaluated using `findLast` semantics: **later rules override earlier ones**.

Merge order (later wins):

1. Global defaults from `settings.json` (`agentDefaults.permission`)
2. Built-in agent permissions (for built-in agents)
3. Custom agent permissions (from frontmatter `tools`)

Example: If global defaults set `"bash": "ask"` but a custom agent sets `"bash": "allow"`, the agent's explicit permission wins.

### Ask Mode

In **interactive mode**, when a tool with `"ask"` permission is called:

1. TUI displays a select prompt: "Allow once / Allow always / Deny"
2. "Allow once" permits this single call
3. "Allow always" persists a matching approval rule to `.senpi/permissions-approved.jsonl`, so matching calls are auto-allowed after reload too
4. "Deny" blocks with an error message

In **non-interactive mode** (json or print output), `ask` permissions are auto-denied with an explanatory message.

## Configuration

### Directory Setup

Create your agent directory structure:

```
# Project-local agents (recommended)
.senpi/
   agents/
      my-agent.md
      code-reviewer.md

# Global agents (shared across projects)
~/.senpi/
   agents/
      my-global-agent.md
```

Both `agent/` and `agents/` subdirectories are scanned recursively.

### Writing an Agent File

Agent files are Markdown with YAML frontmatter. The body (after `---`) becomes the agent's system prompt.

```markdown
---
description: Strict code reviewer that only reads and analyzes
mode: subagent
model: anthropic/claude-sonnet-4-20250514
temperature: 0.3
tools:
   read: allow
   grep: allow
   find: allow
   ls: allow
   bash: allow
   edit: deny
   write: deny
   task: deny
---

You are a code review specialist. Analyze code for bugs, security issues, and style violations.

Rules:
- Never suggest modifying files directly
- Always reference specific line numbers
- Categorize issues as: critical, warning, or suggestion
```

### Settings

Configure default permissions and model for all agents in `settings.json`.

| Location | Scope |
|----------|-------|
| `~/.senpi/agent/settings.json` | Global (all projects) |
| `.senpi/settings.json` | Project (overrides global) |

Add the `agentDefaults` key:

```json
{
   "agentDefaults": {
      "permission": {
         "write": "ask",
         "edit": "ask",
         "bash": "allow",
         "read": "allow"
      },
      "model": "anthropic/claude-haiku-4-5"
   }
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `agentDefaults.permission` | object | `{}` | Default tool permissions for all agents (see [Permission Actions](#permission-actions)) |
| `agentDefaults.model` | string | - | Default model ID for spawned agents |

These defaults are the **lowest priority** layer. Agent-specific permissions (from frontmatter `tools`) override them.

### Priority Order

Permissions are resolved in this order (later wins):

1. `settings.json` -> `agentDefaults.permission` (lowest priority)
2. Built-in agent permissions (`general`, `explore` configs)
3. Custom agent frontmatter `tools` (highest priority)

Example: Global settings set `bash: ask`, but your custom agent sets `bash: allow` -> bash is allowed for that agent.

### Quick Start Recipes

**Read-only explorer:**
```typescript
task(agent_type="explore", prompt="Find all error handling patterns", run_in_background=true)
```

**Custom strict reviewer:**
1. Create `.senpi/agents/reviewer.md` (see [Writing an Agent File](#writing-an-agent-file))
2. Use: `task(agent_type="reviewer", prompt="Review changes in src/auth/", run_in_background=false)`

**Restrict all agents by default:**
Add to `~/.senpi/agent/settings.json`:
```json
{
   "agentDefaults": {
      "permission": {
         "write": "ask",
         "edit": "ask"
      }
   }
}
```
Now every agent must get user confirmation before writing or editing files.

## How It Works

The agent system is implemented as a builtin extension that intercepts the task tool:

1. **Environment variable** - When `task(agent_type="...")` is called, the agent type is passed via `SANEPI_AGENT_TYPE` environment variable to the subprocess
2. **Registry lookup** - On session start, the extension scans `~/.senpi/` and `.senpi/` for agent definitions, merges with built-in agents, and resolves by name
3. **Tool filtering** - `setActiveTools()` removes denied tools from the LLM's tool list entirely (they don't appear in the API call)
4. **Defense in depth** - A `tool_call` event handler acts as backup, catching any tools that slip through (e.g., added dynamically after session start)
5. **System prompt** - The `before_agent_start` event appends the agent's custom prompt to the existing system prompt (doesn't replace it)
6. **Permission evaluation** - Each tool call is checked against the merged permission rules (global defaults + agent config)

## Known Limitations

- `disable: true` in custom agents does not currently remove built-in agents (v1 limitation)
- Bash permission bypass: denying `edit` but allowing `bash` still permits `echo > file` via bash redirection
- No sub-pattern matching for bash commands (entire bash tool allow/deny only, no per-command filtering)
- `ask` mode in non-interactive (json/print) mode auto-denies without user input
- No dynamic permission changes at runtime (permissions are immutable after agent start)
- No agent permission inheritance chains (flat configs only, no "extends" mechanism)
