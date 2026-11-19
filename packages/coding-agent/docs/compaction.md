# Compaction & Branch Summarization

LLMs have limited context windows. When conversations grow too long, senpi uses compaction to summarize older content while preserving recent work. This page covers both auto-compaction and branch summarization.

**Source files** ([pi](https://github.com/earendil-works/pi)):
- [`packages/coding-agent/src/core/compaction/compaction.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) - Auto-compaction logic
- [`packages/coding-agent/src/core/compaction/branch-summarization.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) - Branch summarization
- [`packages/coding-agent/src/core/compaction/utils.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/utils.ts) - Shared utilities (file tracking, serialization)
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts) - Entry types (`CompactionEntry`, `BranchSummaryEntry`)
- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) - Extension event types

For TypeScript definitions in your project, inspect `node_modules/@code-yeongyu/senpi/dist/`.

## Overview

Senpi has two summarization mechanisms:

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Compaction | Context exceeds threshold, or `/compact` | Summarize old messages to free up context |
| Branch summarization | `/tree` navigation | Preserve context when switching branches |

Both use the same structured summary format and track file operations cumulatively. Compaction and branch-summary requests use fresh routing session IDs and, where supported by the provider, disable prompt-cache writes because these one-off prompts are unlikely to be reused.

## Compaction

### When It Triggers

Auto-compaction has two triggers.

**Threshold.** Before a prompt starts and when a run ends, senpi compares the context with a share of the model's context window:

| Context window | Threshold |
|----------------|-----------|
| up to 16,000 tokens | 45% |
| up to 32,000 tokens | 50% |
| up to 64,000 tokens | 55% |
| up to 128,000 tokens | 60% |
| up to 512,000 tokens | 70% |
| larger | 80% |

After a compaction that freed more than half of the context, the next threshold is 5 points lower, and never below 40%. The threshold itself has no setting. [Proactive compaction](#proactive-compaction) describes the work senpi does around it.

**Reserve.** Compaction also triggers when:

```
contextTokens > contextWindow - reserve
```

`reserve` is `reserveTokens`, 16384 by default (configurable in `~/.senpi/agent/settings.json` or `<project-dir>/.senpi/settings.json`), raised on large windows as described under [Reserve scaling](#reserve-scaling). This leaves room for the LLM's response.

During a multi-turn agent run, Pi checks this threshold after tools finish and their results are appended, before starting the next assistant response. If the threshold is crossed, Pi compacts inside the same agent run and resumes with the summary and retained messages. It skips this between-turn check when the completed tool batch terminates the run and no queued message requires another response. Pi also checks the threshold before a new user prompt and after a low-level agent run ends.

You can also trigger manually with `/compact [instructions]`, where optional instructions focus the summary.

### Proactive Compaction

The behaviours below are all on by default. Each has a switch, listed with its default in [settings.md](settings.md#compaction). The [compaction guide](compaction-guide.md#what-runs-by-default-and-what-it-costs) says what each one costs and when to turn it off.

#### Background summaries

When the context comes within the lead of the threshold, senpi starts writing the summary in the background while the turn goes on. Once the threshold is reached, the finished summary is applied, so the session does not stop to write one.

The lead is 12.5% of the threshold. `speculativeLeadTokens` replaces that figure. Either way the lead stays between 8192 and 32768 tokens.

No background summary starts on a model that compacts through OpenAI's remote compaction route, or while automatic compaction is paused after repeated failures. With `speculativeEnabled: false` none starts at all, and a prompt that reaches the threshold waits while the summary is written.

`enabled: false` does not stop background summaries. With threshold compaction off, such a summary is written and paid for but not applied at the threshold, so set `speculativeEnabled: false` together with `enabled: false`.

`speculativeFraction` is read from settings but does not change this: the lead always decides the starting point.

#### Idle compaction

This runs in the TUI and in RPC mode, when a run ends without being aborted or retried.

- Over the threshold, senpi writes the summary, or reuses a finished one that still fits, and applies it while the session is idle. If you send a prompt first, the apply is skipped.
- Below the threshold with at least half of the context window used, senpi only prepares the summary. A prepared summary that still fits is kept. One that no longer fits is rebuilt once `speculativeCooldownMs` has passed since it finished. Models on OpenAI's remote compaction route skip this step.

`idleCompactionEnabled: false` turns both off.

#### Grace band

If a prompt reaches the threshold while a background summary is still being written, the prompt starts anyway, as long as the context stays below the smaller of `threshold + lead` and `contextWindow - reserve`. Past that point, or with `graceBandEnabled: false`, the prompt waits for compaction.

#### Budget reminder

When the context is within twice the lead of the threshold, senpi adds one hidden note to the prompt:

```
[context budget] Approximately <n> tokens remain before automatic compaction. Wrap up verbose exploration, prefer concise summaries over full dumps, and front-load conclusions.
```

It is sent once between two compactions. `reminderEnabled: false` turns it off.

#### Tool-result admission

A tool result whose text is larger than the admission cap is sent to the model as its head and tail with a marker between them:

```
[tool result projected: kept <kept> of ~<total> tokens]
```

The cap is 5% of the context window, held between 8192 and 50000 tokens. Only the request is shortened: the session keeps the full result. `toolAdmissionEnabled: false` sends results whole.

#### Reserve scaling

The reserve used by the reserve trigger is the larger of `reserveTokens` and 4% of the context window, and the 4% share stops at 49152 tokens. A 200,000-token window keeps the default 16384. A 1,000,000-token window reserves 40000. `reserveScalingEnabled: false` uses `reserveTokens` as written.

Automatic compaction also adjusts `keepRecentTokens` to the window. Above 409,600 tokens, a setting of 10000 or more is raised to 5% of the window, up to 60000. On every window it is capped at `contextWindow × (1 - threshold - 0.05)`, and never below 1024.

#### Restoration

After a compaction, the next prompt carries a hidden note that lists the files the session read, wrote or edited, with the operations, and the skills it loaded. It holds paths and names, not file contents, so the model knows what to open again.

Entries still visible in the kept messages are left out, and an entry is listed only once. Written and edited files come first, then skills, then files that were only read. The note is limited by:

- `restorationMaxItems` entries;
- `restorationMaxTokensPerItem` tokens for one entry;
- a total of the smallest of `restorationMaxTotalTokens`, `restorationContextRatio` of the context window, and the room left after the reserve.

`restorationEnabled: false` turns the note off.

### How It Works

1. **Find cut point**: Walk backwards from newest message, accumulating token estimates until `keepRecentTokens` (default 20k, configurable in `~/.senpi/agent/settings.json` or `<project-dir>/.senpi/settings.json`) is reached
2. **Extract messages**: Collect messages from the previous kept boundary (or session start) up to the cut point
3. **Generate summary**: Call LLM to summarize with structured format, passing the previous summary as iterative context when present
4. **Append entry**: Save `CompactionEntry` with summary and `firstKeptEntryId`
5. **Rebuilds context**: Session rebuilds the context for the next request, using summary + messages from `firstKeptEntryId` onwards

```
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

A retain-none compaction (`appendCompaction(summary, null, tokensBefore)`) records its own ID as `firstKeptEntryId`, so a repeated compaction starts after that entry. On repeated compactions, the summarized span starts at the previous compaction's kept boundary (`firstKeptEntryId`), not at the compaction entry itself, falling back to the entry after the previous compaction if that kept entry cannot be found in the path. This preserves messages that survived the earlier compaction by including them in the next summarization pass as well. Senpi also recalculates `tokensBefore` from the rebuilt session context before writing the new `CompactionEntry`, so the token count reflects the actual pre-compaction context being replaced.

### Split Turns

A "turn" starts with a user message and includes all assistant responses and tool calls until the next user message. Normally, compaction cuts at turn boundaries.

When a single turn exceeds `keepRecentTokens`, the cut point lands mid-turn at an assistant message. This is a "split turn":

```
Split turn (one huge turn exceeds budget):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (no complete turns before)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

For split turns, senpi generates two summaries and merges them:
1. **History summary**: Previous context (if any)
2. **Turn prefix summary**: The early part of the split turn

### Cut Point Rules

Valid cut points are:
- User messages
- Assistant messages
- BashExecution messages
- Custom messages (custom_message, branch_summary)

Never cut at tool results (they must stay with their tool call).

### CompactionEntry Structure

Defined in [`session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts):

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default compaction uses this for details (from compaction.ts):
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Extensions can store any JSON-serializable data in `details`. The default compaction tracks file operations, but custom extension implementations can use their own structure. Generated and extension-provided summaries store their LLM `usage` when available so session totals include summarization work.

See [`prepareCompaction()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) and [`compact()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) for the implementation. For direct programmatic summarization, `generateSummary()` returns the summary text and `generateSummaryWithUsage()` returns `{ text, usage }`.

## Branch Summarization

### When It Triggers

When you use `/tree` to navigate to a different branch, senpi offers to summarize the work you're leaving. This injects context from the left branch into the new branch.

### How It Works

1. **Find common ancestor**: Deepest node shared by old and new positions
2. **Collect entries**: Walk from old leaf back to common ancestor
3. **Prepare with budget**: Include messages up to token budget (newest first)
4. **Generate summary**: Call LLM with structured format
5. **Append entry**: Save `BranchSummaryEntry` at navigation point

```
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### Cumulative File Tracking

Both compaction and branch summarization track files cumulatively. When generating a summary, senpi extracts file operations from:
- Tool calls in the messages being summarized
- Previous compaction or branch summary `details` (if any)

This means file tracking accumulates across multiple compactions or nested branch summaries, preserving the full history of read and modified files.

### BranchSummaryEntry Structure

Defined in [`session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts):

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  fromId: string;      // Entry we navigated from
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default branch summarization uses this for details (from branch-summarization.ts):
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Same as compaction, extensions can store custom data in `details`.

See [`collectEntriesForBranchSummary()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), [`prepareBranchEntries()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), and [`generateBranchSummary()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) for the implementation.

## Summary Format

Both compaction and branch summarization use the same structured format:

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### Message Serialization

Before summarization, messages are serialized to text via [`serializeConversation()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/utils.ts):

```
[User]: What they said
[Assistant thinking]: Internal reasoning
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

This prevents the model from treating it as a conversation to continue.

Tool results are truncated to 2000 characters during serialization. Content beyond that limit is replaced with a marker indicating how many characters were truncated. This keeps summarization requests within reasonable token budgets, since tool results (especially from `read` and `bash`) are typically the largest contributors to context size.

## Custom Summarization via Extensions

Extensions can intercept and customize both compaction and branch summarization. See [`extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) for event type definitions.

### session_before_compact

Fired before auto-compaction or `/compact`. Can cancel or provide custom summary. See `SessionBeforeCompactEvent` and `CompactionPreparation` in the types file.

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

  // preparation.messagesToSummarize - messages to summarize
  // preparation.turnPrefixMessages - split turn prefix (if isSplitTurn)
  // preparation.previousSummary - previous compaction summary
  // preparation.fileOps - extracted file operations
  // preparation.tokensBefore - context tokens before compaction
  // preparation.firstKeptEntryId - where kept messages start
  // preparation.settings - effective settings after applying model overrides

  // branchEntries - all entries on current branch (for custom state)
  // reason - "manual" (/compact), "threshold", or "overflow"
  // willRetry - whether the aborted turn is retried after compaction (overflow recovery)
  // signal - AbortSignal (pass to LLM calls)

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      // usage: summaryResponse.usage, // Optional; included in session totals
      details: { /* custom data */ },
    }
  };
});
```

#### Converting Messages to Text

To generate a summary with your own model, convert messages to text using `serializeConversation`:

```typescript
import { convertToLlm, serializeConversation } from "@code-yeongyu/senpi";

pi.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;
  
  // Convert AgentMessage[] to Message[], then serialize to text
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // Returns:
  // [User]: message text
  // [Assistant thinking]: thinking content
  // [Assistant]: response text
  // [Assistant tool calls]: read(path="..."); bash(command="...")
  // [Tool result]: output text

  // Now send to your model for summarization
  const { summary, usage } = await myModel.summarize(conversationText);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      usage,
    }
  };
});
```

See [custom-compaction.ts](../examples/extensions/custom-compaction.ts) for a complete example using a different model.

### session_compact_failed

Fired when manual or automatic compaction fails or is aborted. This is useful for telemetry extensions that need to pair `session_before_compact` attempts with terminal outcomes.

```typescript
pi.on("session_compact_failed", async (event, ctx) => {
  const { reason, errorMessage, aborted, willRetry, fromExtension } = event;
  // reason - "manual" (/compact), "threshold", or "overflow"
  // errorMessage - present for non-abort failures
  // aborted - true for cancelled/aborted compactions
  // willRetry - whether the aborted turn would have retried after compaction
  // fromExtension - whether extension-provided compaction content was being used
});
```

### session_before_tree

Fired before `/tree` navigation. Always fires regardless of whether user chose to summarize. Can cancel navigation or provide custom summary.

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - where we're navigating to
  // preparation.oldLeafId - current position (being abandoned)
  // preparation.commonAncestorId - shared ancestor
  // preparation.entriesToSummarize - entries that would be summarized
  // preparation.userWantsSummary - whether user chose to summarize

  // Cancel navigation entirely:
  return { cancel: true };

  // Provide custom summary (only used if userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        // usage: summaryResponse.usage, // Optional; included in session totals
        details: { /* custom data */ },
      }
    };
  }
});
```

See `SessionBeforeTreeEvent` and `TreePreparation` in the types file.

## Settings

Configure compaction in `~/.senpi/agent/settings.json` or `<project-dir>/.senpi/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

[settings.md](settings.md#compaction) lists every `compaction` key with its type and default, including the switches for the behaviours under [Proactive compaction](#proactive-compaction).

Disable proactive auto-compaction with `"enabled": false`. You can still compact manually with `/compact`. A prompt that reaches the reserve limit is still compacted before it starts, and a context the provider rejects as too large is still compacted once and retried automatically.

### Per-model overrides

Use `compaction.modelOverrides` to tune token budgets for different models:

```json
{
  "compaction": {
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "some-provider/big-model": {
        "reserveTokens": 400000
      }
    }
  }
}
```

For a model with a 1M context window, this override triggers compaction above 600K tokens and keeps the ordinary 20000 recent tokens. Other models retain the ordinary 16384-token reserve. `reserveTokens` also influences summarization output limits, capped by the model's maximum output tokens; it is not solely a trigger threshold.

Keys are exact, case-sensitive `provider/modelId` values, including any slashes within the model ID. Each `reserveTokens` and `keepRecentTokens` value falls back independently from the model override to the ordinary setting to the built-in default. Values must be non-negative safe integers. Invalid values in the matching model override produce an error when read; only omitted fields fall back to the ordinary setting. Model override entries must be objects. Invalid ordinary token settings produce an error when read, even if the active model has a valid override. Only omitted ordinary values use built-in defaults. `enabled` remains global, not model-specific.

These resolved values are used for manual compaction, all automatic threshold checks, overflow recovery, and extension-visible `preparation.settings`. Model switches affect subsequent checks and compactions without changing ordinary settings. Compaction already in progress uses the model and settings captured for that operation. Branch summarization settings are unaffected.

Overrides work in both global and project settings. The files merge recursively before lookup, so a global model-specific value beats a project-wide fallback; a project must override that model entry to change it. See [settings.md](settings.md#per-model-compaction-overrides) for details.
